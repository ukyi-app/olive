// 장부 초기화 진입점(D-110). 실제 진입점을 임시 폴더에 띄워 만들기·거절·바이트 무변화를 보고, 감독의 reopen이 그 장부를 받는지 본다.
// 진입점 함수(initLedger)는 가짜 포트로 효과의 수와 인자, 실패 갈래를 본다. 정적 규칙: src/에서 장부를 create로 여는 곳은 이 진입점 하나다.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OpenOptions, type OpenResult, openLedger } from "../src/ledger/index.ts";
import { initLedger, LEDGER_INIT_EXIT, type LedgerInitDeps } from "../src/main/ledger-init.ts";
import { LEDGER_DIR_ENV, LEDGER_FILE } from "../src/main/ledger-path.ts";
import { SUPERVISOR_ENV, settingsFromEnv } from "../src/main/supervisor.ts";
import { list, readText, root } from "./files.ts";

const pkg = JSON.parse(await readText("package.json"));
const PREFIX = `olive ledger-init ${pkg.version}: `;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 장부는 폴더 경로에 링크가 있으면 열지 않는다. 임시 폴더가 링크인 환경에서도 실제 경로를 쓴다.
function tempDir(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "olive-ledger-init-"));
  dirs.push(dir);
  return dir;
}

function runInit(env: Record<string, string>, args: string[] = []) {
  const result = Bun.spawnSync([process.execPath, "src/main/ledger-init.ts", ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", ...env }, timeout: 30_000 });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

// 폴더 안 모든 파일의 이름과 sha256. 바이트 무변화의 비교 대상이다.
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) out[name] = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  return out;
}

// 감독 진입점이 받는 환경(값은 test/supervisor/runtime/entry.test.ts의 꼴). 장부 폴더만 바꿔 감독이 볼 장부 경로를 얻는다.
function supervisorLedgerPath(dir: string): string {
  const env: Record<string, string> = {
    OLIVE_SUPERVISOR_PORT: "8443",
    OLIVE_LEDGER_DIR: dir,
    OLIVE_SIGNING_KEY_DIR: "/etc/olive/signing",
    OLIVE_ACCOUNTS_DIR: "/etc/olive/accounts",
    OLIVE_TLS_DIR: "/etc/olive/tls",
    OLIVE_TRUST_DIR: "/etc/olive/trust",
    OLIVE_REGISTRY_FILE: "/etc/olive/registry/registry.json",
    OLIVE_ENVIRONMENT: "home",
    OLIVE_TARGETS: JSON.stringify([{ target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] }]),
    OLIVE_POLICY_REVISION: "policy-1",
    OLIVE_RESULT_DIR: "/var/lib/olive/results",
  };
  const parsed = settingsFromEnv(env);
  if (!parsed.ok) throw new Error(`감독 환경이 틀렸다: ${parsed.name}`);
  return parsed.settings.ledgerPath;
}

test("빈 폴더면 장부를 만들고 0, 감독의 reopen이 같은 경로에서 그 장부를 받는다", () => {
  const dir = tempDir();
  const result = runInit({ OLIVE_LEDGER_DIR: dir });
  expect(result).toEqual({ code: 0, stdout: "", stderr: `${PREFIX}장부를 만들었다\n` });
  expect(Object.keys(snapshot(dir))).toContain(LEDGER_FILE);
  const reopened = openLedger(supervisorLedgerPath(dir), { clock: Date.now, mode: "reopen" });
  if (!reopened.ok) throw new Error(`감독 reopen 실패: ${reopened.reason}`);
  reopened.ledger.close();
});

test("장부가 이미 있으면 90이고 폴더의 바이트가 그대로다", () => {
  const dir = tempDir();
  expect(runInit({ OLIVE_LEDGER_DIR: dir }).code).toBe(0);
  const before = snapshot(dir);
  const again = runInit({ OLIVE_LEDGER_DIR: dir });
  expect(again).toEqual({ code: LEDGER_INIT_EXIT.exists, stdout: "", stderr: `${PREFIX}장부가 이미 있다. 아무것도 바꾸지 않았다\n` });
  expect(snapshot(dir)).toEqual(before);
});

test("장부 자리에 다른 파일(빈 파일, SQLite가 아닌 파일)이 있으면 94이고 바이트가 그대로다", () => {
  for (const content of ["", "not a ledger, just text that is long enough to pass the header size check ".repeat(3)]) {
    const dir = tempDir();
    writeFileSync(join(dir, LEDGER_FILE), content);
    const before = snapshot(dir);
    const result = runInit({ OLIVE_LEDGER_DIR: dir });
    expect(result.code, JSON.stringify(content.slice(0, 8))).toBe(LEDGER_INIT_EXIT.ledger);
    expect(result.stderr).toMatch(new RegExp(`^${PREFIX}장부를 만들지 못했다\\(open:(foreign_data|corrupt)\\)\\n$`));
    expect(snapshot(dir)).toEqual(before);
  }
});

test("감독처럼 장부를 쥔 프로세스가 있으면 90이고 바이트가 그대로다", async () => {
  const dir = tempDir();
  expect(runInit({ OLIVE_LEDGER_DIR: dir }).code).toBe(0);
  const holder = Bun.spawn([process.execPath, "test/ledger-init-holder.ts", join(dir, LEDGER_FILE)], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = holder.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toBe("held\n");
  const before = snapshot(dir);
  // 쥔 쪽이 reopen에서 WAL로 바꿨다: 감독이 도는 동안의 모양이다.
  expect(Object.keys(before)).toContain(`${LEDGER_FILE}-wal`);
  const result = runInit({ OLIVE_LEDGER_DIR: dir });
  expect(result.code).toBe(LEDGER_INIT_EXIT.exists);
  expect(snapshot(dir)).toEqual(before);
  // 신호 없이 끝낸다: 표준 입력을 닫으면 자식이 장부를 닫고 0으로 끝난다.
  holder.stdin.end();
  expect(await holder.exited).toBe(0);
});

test("환경이 없거나 빈 값이면 없다로, 상대 경로면 틀렸다로 91이고 아무 파일도 만들지 않는다. 인자가 있으면 64다", () => {
  expect(runInit({})).toEqual({ code: 91, stdout: "", stderr: `${PREFIX}환경 OLIVE_LEDGER_DIR이(가) 없다\n` });
  expect(runInit({ OLIVE_LEDGER_DIR: "" })).toEqual({ code: 91, stdout: "", stderr: `${PREFIX}환경 OLIVE_LEDGER_DIR이(가) 없다\n` });
  expect(runInit({ OLIVE_LEDGER_DIR: "var/lib/olive" })).toEqual({ code: 91, stdout: "", stderr: `${PREFIX}환경 OLIVE_LEDGER_DIR이(가) 틀렸다\n` });
  const dir = tempDir();
  expect(runInit({ OLIVE_LEDGER_DIR: dir }, ["--force"])).toEqual({ code: 64, stdout: "", stderr: `${PREFIX}사용법: bun src/main/ledger-init.ts (인자 없음)\n` });
  expect(snapshot(dir)).toEqual({});
});

test("장부 폴더가 없으면 94이고 폴더를 만들지 않는다", () => {
  const parent = tempDir();
  const missing = join(parent, "absent");
  const result = runInit({ OLIVE_LEDGER_DIR: missing });
  expect(result.code).toBe(LEDGER_INIT_EXIT.ledger);
  expect(result.stderr.startsWith(`${PREFIX}장부를 만들지 못했다(open:`)).toBe(true);
  expect(readdirSync(parent)).toEqual([]);
});

test("감독과 같은 환경 이름·같은 장부 경로를 쓴다", () => {
  expect((SUPERVISOR_ENV as readonly string[]).includes(LEDGER_DIR_ENV)).toBe(true);
  const calls: [string, OpenOptions][] = [];
  const deps: LedgerInitDeps = {
    openLedger: (path, options) => {
      calls.push([path, options]);
      return { ok: false, reason: "already_initialized", detail: "" };
    },
    wallNow: () => 1,
  };
  initLedger([], { OLIVE_LEDGER_DIR: "/var/lib/olive" }, deps);
  expect(calls).toEqual([[supervisorLedgerPath("/var/lib/olive"), { clock: deps.wallNow, mode: "create" }]]);
});

test("initLedger: 효과는 create 열기 한 번이고, 사용법·환경이 틀리면 0번이다. 던짐·닫기 실패·거절 사유는 94로 가른다", () => {
  const fake = (answer: () => OpenResult) => {
    const calls: string[] = [];
    const deps: LedgerInitDeps = {
      openLedger: (_path, options) => {
        calls.push(options.mode);
        return answer();
      },
      wallNow: () => 1_800_000_000_000,
    };
    return { calls, deps };
  };
  const ledgerClosing = (close: () => void) => ({ ok: true, ledger: { close } as never, migrated: { from: 0, to: 1 } }) as OpenResult;
  const env = { OLIVE_LEDGER_DIR: "/data" };
  let closed = 0;
  const cases: [string[], Record<string, string>, () => OpenResult, number, string, number][] = [
    [[], env, () => ledgerClosing(() => closed++), 0, "장부를 만들었다", 1],
    [[], env, () => ({ ok: false, reason: "already_initialized", detail: "x" }), 90, "장부가 이미 있다. 아무것도 바꾸지 않았다", 1],
    [[], env, () => ({ ok: false, reason: "locked", detail: "x" }), 94, "장부를 만들지 못했다(open:locked)", 1],
    [[], env, () => ({ ok: false, reason: "foreign_data", detail: "/secret/path" }), 94, "장부를 만들지 못했다(open:foreign_data)", 1],
    [[], env, () => { throw new Error("boom"); }, 94, "장부를 만들지 못했다(open:threw)", 1],
    [[], env, () => ledgerClosing(() => { throw new Error("close"); }), 94, "장부를 만들지 못했다(close:threw)", 1],
    [["x"], env, () => { throw new Error("부르면 안 된다"); }, 64, "사용법: bun src/main/ledger-init.ts (인자 없음)", 0],
    [[], {}, () => { throw new Error("부르면 안 된다"); }, 91, "환경 OLIVE_LEDGER_DIR이(가) 없다", 0],
    [[], { OLIVE_LEDGER_DIR: "rel" }, () => { throw new Error("부르면 안 된다"); }, 91, "환경 OLIVE_LEDGER_DIR이(가) 틀렸다", 0],
  ];
  for (const [argv, caseEnv, answer, code, text, opens] of cases) {
    const { calls, deps } = fake(answer);
    expect([text, initLedger(argv, caseEnv, deps)]).toEqual([text, { code: code as never, line: `${PREFIX}${text}\n` }]);
    expect([text, calls]).toEqual([text, Array(opens).fill("create")]);
  }
  expect(closed).toBe(1);
});

// 감독은 reopen만 한다(boot.md S20, boot.test.ts의 정적 "create" 0). 장부를 create로 여는 곳은 src/에서 이 진입점 하나이고,
// 장부 모듈(src/ledger/)은 mode 값을 정의하는 곳이라 뺀다.
test("정적: src/에서 \"create\" 글자를 쓰는 곳은 src/ledger/ 밖에서 src/main/ledger-init.ts 하나이고, 그 파일의 create 열기는 한 자리다", async () => {
  const createLiteral = /["'`]create["'`]/;
  // 대조군: 세 따옴표를 모두 잡고 이름의 일부는 잡지 않는다.
  expect(['"create"', "'create'", "`create`"].every((sample) => createLiteral.test(sample))).toBe(true);
  expect(createLiteral.test('"created"')).toBe(false);
  const code = (source: string) =>
    source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
  const found: string[] = [];
  for (const file of await list("src/**/*.ts")) {
    if (file.startsWith("src/ledger/")) continue;
    if (createLiteral.test(code(await readText(file)))) found.push(file);
  }
  expect(found).toEqual(["src/main/ledger-init.ts"]);
  const init = code(await readText("src/main/ledger-init.ts"));
  expect([...init.matchAll(/["'`]create["'`]/g)].length).toBe(1);
  expect([...init.matchAll(/\bmode: "create"/g)].length).toBe(1);
  expect(init.includes("reopen")).toBe(false);
});
