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
