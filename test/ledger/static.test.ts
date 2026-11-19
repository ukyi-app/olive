import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { HOOK_EVENTS, SESSION_BROKEN_CAUSES, STOP_FAILURE_ERRORS } from "../../src/contract/v1/index.ts";
import * as contractSchema from "../../src/contract/v1/schema.ts";
import { ACCOUNT, AUTH_METHODS, REVISION, SHA256, UUID } from "../../src/ledger/input.ts";
import { list, readText } from "../files.ts";
import { open, tempPath } from "./helpers.ts";

// 원문(요청 글, 모델 출력, 로그)과 자격 값으로 보이는 이름의 조각. 칸 이름을 _ 또는 대문자 경계로 쪼개 하나라도 걸리면 실패한다.
const BANNED_PARTS = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwd",
  "apikey",
  "cookie",
  "bearer",
  "private",
  "prompt",
  "transcript",
  "output",
  "log",
  "logs",
  "text",
  "body",
  "content",
  "message",
  "summary",
  "raw",
  "value",
]);

function parts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
}

// 자격은 계정·방식·revision·digest만 둔다. credential이 든 이름은 revision·digest로 끝나야 한다.
// digest로 끝나는 이름은 내용의 SHA-256이라 원문이 아니다(예: body_digest).
function allowed(name: string): boolean {
  const p = parts(name);
  if (p[p.length - 1] === "digest") return true;
  if (p.some((part) => BANNED_PARTS.has(part))) return false;
  if (p.includes("credential") || p.includes("credentials")) return ["revision", "digest"].includes(p[p.length - 1]) || name === "credential";
  if (p[p.length - 1] === "key") return name === "dedupe_key" || name === "dedupeKey";
  return true;
}

test("정적: 장부 스키마에 원문·자격 값 칸이 없다", () => {
  const path = tempPath();
  open(path).close();
  const raw = new Database(path);
  const tables = (raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  const columns = tables.flatMap((table) => (raw.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => `${table}.${c.name}`));
  raw.close();
  expect(columns.length).toBeGreaterThan(50);
  const bad = columns.filter((column) => !allowed(column.split(".")[1]) || column.split(".")[1] === "credential");
  expect(bad).toEqual([]);
});

// 쓰기 함수가 받는 칸을 모은다. 세 곳을 본다:
// 1. exact(값, [칸들], …)의 칸 목록: 쓰기 함수는 모두 이것으로 입력을 거르므로 런타임에 실제로 받는 칸이다.
// 2. 메서드 인자 자리의 인라인 객체 타입(예: markResult(input: { … })).
// 3. 이름 있는 입력 타입(…Input, EnvelopeFrom, InputRecord)과 그 안의 한 줄짜리 공용체 갈래.
async function writeInputFields(): Promise<Set<string>> {
  const names = new Set<string>();
  const add = (body: string) => {
    for (const field of body.matchAll(/(?:^|[\s{;,(])(?:readonly\s+)?(\w+)\??:/g)) names.add(field[1]);
  };
  for (const file of await list("src/ledger/*.ts")) {
    const source = await readText(file);
    for (const call of source.matchAll(/\bexact\(\s*[^,]+,\s*\[([^\]]*)\]/g)) for (const key of call[1].matchAll(/"(\w+)"/g)) names.add(key[1]);
    for (const param of source.matchAll(/^ {2}\w+\(\s*\w+\??:\s*\{([^}]*)\}/gm)) add(param[1]);
    for (const block of source.matchAll(/(?:interface\s+(\w*Input|EnvelopeFrom|InputRecord)\b[^{]*|type\s+(\w*Input)\s*=)([\s\S]*?)\n(?:\}|\s*;)/g)) add(block[3]);
  }
  return names;
}

test("정적: 쓰기 함수의 입력 타입에 원문·자격 값 칸이 없다", async () => {
  const names = await writeInputFields();
  // 훑기가 인라인 타입, 한 줄 공용체 갈래, exact 목록, 선택 칸까지 닿는지 확인한다.
  for (const reached of ["reportId", "instruction", "storedRef", "previousRunId", "sender", "runGeneration", "phase", "executorId"]) {
    expect(names.has(reached), reached).toBe(true);
  }
  expect(names.size).toBeGreaterThan(40);
  expect([...names].filter((name) => !allowed(name))).toEqual([]);
  // 자격 묶음은 네 칸뿐이다.
  const input = await readText("src/ledger/input.ts");
  expect(/interface CredentialRef \{\s*account: string;\s*method: string;\s*revision: string;\s*digest: string;\s*\}/.test(input)).toBe(true);
});

test("정적: 장부 입력 확인의 UUID·SHA256·REVISION·계정·방식은 계약과 같은 꼴이다", async () => {
  expect([UUID.source, SHA256.source, REVISION.source]).toEqual([contractSchema.UUID.source, contractSchema.SHA256.source, contractSchema.REVISION.source]);
  expect([UUID.flags, SHA256.flags, REVISION.flags]).toEqual([contractSchema.UUID.flags, contractSchema.SHA256.flags, contractSchema.REVISION.flags]);
  const instruction = await readText("src/contract/v1/instruction.ts");
  expect(instruction).toContain(`account: pattern(/${ACCOUNT.source}/)`);
  expect(instruction).toContain(`method: oneOf(${JSON.stringify(AUTH_METHODS).replaceAll(",", ", ")})`);
});

test("정적: 보고의 구조화 칸이 받는 값은 계약의 목록과 같다", async () => {
  const sql = await readText("src/ledger/migrations/0001-core.sql");
  const allowedIn = (column: string) => {
    const match = new RegExp(`${column} IS NULL OR ${column} IN \\(([^)]*)\\)`).exec(sql);
    if (match === null) throw new Error(`${column}의 허용 값 목록이 없다`);
    return [...(match[1] as string).matchAll(/'([^']+)'/g)].map((value) => value[1] as string).sort();
  };
  expect(allowedIn("hook_event")).toEqual([...HOOK_EVENTS].sort());
  expect(allowedIn("stop_failure")).toEqual([...STOP_FAILURE_ERRORS].sort());
  expect(allowedIn("broken_cause")).toEqual([...SESSION_BROKEN_CAUSES].sort());
});

test("정적: 이름 검사가 원문·자격 이름을 실제로 잡는다", () => {
  for (const name of ["credential_value", "api_token", "prompt", "request_text", "model_output", "log_ref", "raw_body", "session_key", "apiKey"]) expect(allowed(name), name).toBe(false);
  for (const name of ["credential_digest", "credential_revision", "source_ref", "dedupe_key", "budget_left", "body_digest"]) expect(allowed(name), name).toBe(true);
});

// 같은 프로세스가 장부 파일의 다른 FD를 닫으면 작성자의 POSIX 잠금이 풀린다. 그래서 모듈마다 쓸 수 있는 node:fs 이름을 좁힌다.
// migrate.ts의 읽기는 이미지 안의 SQL 마이그레이션 폴더만 본다. 파일을 여는 곳은 이 호출이 O_EXCL로 만든 새 파일뿐이다.
const FS_ALLOWED: Record<string, readonly string[]> = {
  "src/ledger/ledger.ts": ["closeSync", "constants", "fstatSync", "lstatSync", "openSync", "realpathSync"],
  "src/ledger/migrate.ts": ["readdirSync", "readFileSync"],
  "src/ledger/snapshot.ts": ["closeSync", "constants", "fsyncSync", "linkSync", "lstatSync", "openSync", "realpathSync", "unlinkSync", "writeSync"],
};
const FS_OPENERS: Record<string, number> = { "src/ledger/ledger.ts": 1, "src/ledger/snapshot.ts": 1 };

function fsViolations(file: string, text: string): string[] {
  const source = text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  const allowed = FS_ALLOWED[file] ?? [];
  const out: string[] = [];
  for (const banned of source.matchAll(/\b(Bun\.file|Bun\.write|Bun\.mmap|process\.binding|require)\s*\(|\bfs\.promises\b|\bimport\s*\(/g)) out.push(banned[0]);
  for (const statement of source.matchAll(/\bimport\s+([^;]*?)\s+from\s+["']((?:node:)?fs(?:\/promises)?)["']/g)) {
    const [, clause, module] = statement as unknown as [string, string, string];
    if (module !== "node:fs") out.push(`모듈 ${module}`);
    const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
    if (named === null) {
      out.push(`이름을 고르지 않은 import: ${clause.trim()}`);
      continue;
    }
    for (const part of (named[1] as string).split(",").map((name) => name.trim()).filter(Boolean)) {
      if (part.startsWith("type ")) continue;
      const [name, alias] = part.split(/\s+as\s+/) as [string, string | undefined];
      if (!allowed.includes(name)) out.push(`허용하지 않는 이름: ${name}`);
      // 별칭은 호출 자리의 검사를 비켜 간다. 상수 묶음만 별칭을 받는다.
      if (alias !== undefined && name !== "constants") out.push(`별칭: ${part}`);
    }
  }
  const opens = [...source.matchAll(/\bopenSync\s*\(([^\n]*)/g)].map((call) => call[1] as string);
  if (opens.length !== (FS_OPENERS[file] ?? 0)) out.push(`openSync ${opens.length}곳`);
  for (const call of opens) if (!call.includes("O_EXCL") || !call.includes("O_NOFOLLOW")) out.push(`새 파일이 아닌 열기: ${call}`);
  return out;
}

test("정적: 장부 모듈의 파일 API는 모듈별 허용 목록뿐이고 FD를 여는 곳은 O_EXCL 새 파일 두 곳뿐이다", async () => {
  const files = await list("src/ledger/**/*.ts");
  for (const file of Object.keys(FS_ALLOWED)) expect(files).toContain(file);
  for (const file of files) expect(fsViolations(file, await readText(file)), file).toEqual([]);
});

test("정적: 파일 API 검사가 전체 읽기·쓰기, promises, 별칭, 이름을 고르지 않은 import를 실제로 잡는다", () => {
  const ledger = "src/ledger/ledger.ts";
  const base = `openSync(path, fileOpen.O_CREAT | fileOpen.O_EXCL | fileOpen.O_NOFOLLOW, 0o600);\n`;
  const violations = (source: string) => fsViolations(ledger, base + source);
  expect(violations(`import { openSync, constants as fileOpen } from "node:fs";`)).toEqual([]);
  for (const [source, caught] of [
    [`import { readFileSync } from "node:fs";`, "허용하지 않는 이름: readFileSync"],
    [`import { writeFileSync } from "node:fs";`, "허용하지 않는 이름: writeFileSync"],
    [`import { readFileSync } from 'node:fs';`, "허용하지 않는 이름: readFileSync"],
    [`import { readSync as read } from 'fs';`, "모듈 fs"],
    [`import { open } from 'node:fs/promises';`, "모듈 node:fs/promises"],
    [`import * as fs from 'node:fs';`, "이름을 고르지 않은 import: * as fs"],
    [`import { open } from "node:fs/promises";`, "모듈 node:fs/promises"],
    [`import { readFileSync as read } from "fs";`, "모듈 fs"],
    [`import { lstatSync as look } from "node:fs";`, "별칭: lstatSync as look"],
    [`import * as fs from "node:fs";`, "이름을 고르지 않은 import: * as fs"],
    [`import fs from "node:fs";`, "이름을 고르지 않은 import: fs"],
    [`await fs.promises.open(path);`, "fs.promises"],
    [`const fs = require("node:fs");`, "require("],
    [`await import("node:fs");`, "import("],
    [`await Bun.file(path).text();`, "Bun.file("],
    [`openSync(path, 0);`, "openSync 2곳"],
  ] as const) {
    expect(violations(source), source).toContain(caught);
  }
  expect(fsViolations(ledger, `openSync(path, fileOpen.O_RDWR);`)).toContain("새 파일이 아닌 열기: path, fileOpen.O_RDWR);");
  expect(fsViolations("src/ledger/migrate.ts", base)).toContain("openSync 1곳");
});

const transpiler = new Bun.Transpiler({ loader: "ts" });

test("정적: src/contract/가 src/ledger/를 import하지 않는다", async () => {
  for (const file of await list("src/contract/**/*.ts")) {
    for (const { path } of transpiler.scanImports(await readText(file))) expect(path.includes("ledger"), `${file} → ${path}`).toBe(false);
  }
});

test("정적: src/ledger/는 계약의 index.ts와 자기 폴더, bun:sqlite·node:fs·node:path만 import한다", async () => {
  const files = await list("src/ledger/**/*.ts");
  expect(files.length).toBeGreaterThan(5);
  for (const file of files) {
    for (const { path } of transpiler.scanImports(await readText(file))) {
      const ok = path === "../contract/v1/index.ts" || (path.startsWith("./") && !path.includes("..")) || ["bun:sqlite", "node:fs", "node:path"].includes(path);
      expect(ok, `${file} → ${path}`).toBe(true);
      expect(/executor|main\//.test(path), `${file} → ${path}`).toBe(false);
    }
  }
});
