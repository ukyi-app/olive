import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
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

test("정적: 쓰기 함수의 입력 타입에 원문·자격 값 칸이 없다", async () => {
  // src/ledger의 타입·인터페이스 선언 안의 칸 이름(이름?: 또는 이름:)을 모은다.
  const names = new Set<string>();
  for (const file of await list("src/ledger/*.ts")) {
    const source = await readText(file);
    for (const block of source.matchAll(/(?:interface\s+\w+[^{]*|type\s+\w+\s*=[^{;]*)\{([\s\S]*?)\n\}/g)) {
      for (const field of block[1].matchAll(/^\s*(?:readonly\s+)?(\w+)\??:/gm)) names.add(field[1]);
    }
  }
  expect(names.size).toBeGreaterThan(30);
  expect([...names].filter((name) => !allowed(name))).toEqual([]);
  // 자격 묶음은 네 칸뿐이다.
  const input = await readText("src/ledger/input.ts");
  expect(/interface CredentialRef \{\s*account: string;\s*method: string;\s*revision: string;\s*digest: string;\s*\}/.test(input)).toBe(true);
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
