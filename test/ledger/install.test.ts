// 장부 파일을 받는 경계: 예약한 파일의 동일성, 재개방의 설치 기록 검증, 끊긴 첫 설치의 사유.
import { constants, Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadMigrations, openLedger } from "../../src/ledger/index.ts";
import { clock, must, NOW, open, ready, tempDir, tempPath, worker } from "./helpers.ts";
import { SPILL_MIGRATIONS } from "./spill-migrations.ts";

const OLV1 = 0x4f4c5631;

function markedFile(path: string, build: (raw: Database) => void): void {
  const raw = new Database(path);
  raw.run(`PRAGMA application_id = ${OLV1}`);
  build(raw);
  raw.close();
}

function masterOf(path: string): unknown[] {
  const raw = new Database(path, { readonly: true });
  const rows = raw.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
  raw.close();
  return rows;
}

// 자식을 정해진 지점까지 돌리고 SIGKILL한다. 신호는 이 시험이 띄운 자식 하나에만 보낸다.
async function crashChild(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  if (!text.startsWith("READY")) {
    child.kill("SIGKILL");
    throw new Error(`자식이 멈춘 지점에 닿지 않음: ${text} ${await new Response(child.stderr).text()}`);
  }
  child.kill("SIGKILL");
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
}

test("create: 예약 직후 이름이 다른 파일로 바뀌면 그 파일을 바꾸지 않고 거절한다", () => {
  const dir = tempDir();
  const path = join(dir, "ledger.db");
  const foreign = join(dir, "foreign.db");
  const raw = new Database(foreign);
  raw.run("CREATE TABLE notes (x INTEGER)");
  raw.run("INSERT INTO notes VALUES (1)");
  raw.close();
  const before = readFileSync(foreign);
  const swap = (point: string) => {
    if (point === "open:reserved") renameSync(foreign, path);
  };
  expect(openLedger(path, { clock, mode: "create", faults: { at: swap } })).toMatchObject({ ok: false, reason: "foreign_data" });
  expect(readFileSync(path).equals(before)).toBe(true);
  for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(`${path}${suffix}`), suffix).toBe(false);
});

const IDENTITY_TABLE = `CREATE TABLE ledger_identity (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     ledger_id TEXT NOT NULL,
     created_at INTEGER NOT NULL CHECK (created_at BETWEEN 1 AND 9007199254740991)
   ) STRICT`;
const IDENTITY_TRIGGER = `CREATE TRIGGER ledger_identity_permanent BEFORE DELETE ON ledger_identity
   BEGIN SELECT RAISE(ABORT, 'ledger_identity_permanent'); END`;
const LEDGER_ID = "11111111-1111-4111-8111-111111111111";

test("reopen: 식별 행만 있고 필수 칸·판 기록이 없는 파일에는 표를 만들지 않는다", () => {
  const files: Record<string, (raw: Database) => void> = {
    "칸이 줄어든 식별 표": (raw) => {
      raw.run("CREATE TABLE ledger_identity (id INTEGER PRIMARY KEY)");
      raw.run("INSERT INTO ledger_identity VALUES (1)");
    },
    "같은 식별 표, 판 기록 표 없음": (raw) => {
      raw.run(IDENTITY_TABLE);
      raw.run(IDENTITY_TRIGGER);
      raw.query("INSERT INTO ledger_identity VALUES (1, ?, 1)").run(LEDGER_ID);
    },
    "같은 식별 표, 빈 판 기록": (raw) => {
      raw.run(IDENTITY_TABLE);
      raw.run(IDENTITY_TRIGGER);
      raw.query("INSERT INTO ledger_identity VALUES (1, ?, 1)").run(LEDGER_ID);
      raw.run("CREATE TABLE ledger_migrations (\n  version INTEGER PRIMARY KEY CHECK (version BETWEEN 1 AND 9007199254740991),\n  name TEXT NOT NULL,\n  applied_at INTEGER NOT NULL CHECK (applied_at BETWEEN 1 AND 9007199254740991)\n) STRICT");
    },
    "판 기록은 맞고 표가 없음": (raw) => {
      raw.run(IDENTITY_TABLE);
      raw.run(IDENTITY_TRIGGER);
      raw.query("INSERT INTO ledger_identity VALUES (1, ?, 1)").run(LEDGER_ID);
      raw.run("CREATE TABLE ledger_migrations (\n  version INTEGER PRIMARY KEY CHECK (version BETWEEN 1 AND 9007199254740991),\n  name TEXT NOT NULL,\n  applied_at INTEGER NOT NULL CHECK (applied_at BETWEEN 1 AND 9007199254740991)\n) STRICT");
      raw.run("INSERT INTO ledger_migrations VALUES (1, '0001-core.sql', 1)");
    },
  };
  for (const [label, build] of Object.entries(files)) {
    const path = tempPath();
    markedFile(path, build);
    const before = readFileSync(path);
    const master = masterOf(path);
    expect(openLedger(path, { clock, mode: "reopen" }), label).toMatchObject({ ok: false, reason: "not_initialized" });
    expect(readFileSync(path).equals(before), label).toBe(true);
    expect(masterOf(path), label).toEqual(master);
    for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(`${path}${suffix}`), `${label} ${suffix}`).toBe(false);
  }
});

test("reopen: 적용된 판의 스키마나 식별 값이 코드와 다른 장부는 열지 않는다", () => {
  const tamper: Record<string, (raw: Database) => void> = {
    "표가 더 있음": (raw) => raw.run("CREATE TABLE intruder (x INTEGER)"),
    "트리거가 빠짐": (raw) => raw.run("DROP TRIGGER stop_generation_monotonic"),
    "식별 값이 꼴이 아님": (raw) => raw.run("UPDATE ledger_identity SET ledger_id = 'not-a-uuid'"),
  };
  for (const [label, change] of Object.entries(tamper)) {
    const path = tempPath();
    open(path).close();
    const raw = new Database(path);
    change(raw);
    raw.close();
    expect(openLedger(path, { clock, mode: "reopen" }), label).toMatchObject({ ok: false, reason: "not_initialized" });
  }
});

test("reopen: 판 목록을 넘겨도 같은 규칙이고, 적용 기록이 없으면 빈 목록이어도 거절한다", () => {
  const custom = [{ version: 1, name: "0001-a.sql", sql: "CREATE TABLE a (x INTEGER) STRICT;" }];
  const path = tempPath();
  open(path, { migrations: custom }).close();
  const again = openLedger(path, { clock, mode: "reopen", migrations: custom });
  expect(again).toMatchObject({ ok: true, migrated: { from: 1, to: 1 } });
  if (again.ok) again.ledger.close();
  // 같은 이름의 판이어도 내용이 다르면 적용된 스키마와 맞지 않는다.
  const changed = [{ version: 1, name: "0001-a.sql", sql: "CREATE TABLE a (y INTEGER) STRICT;" }];
  expect(openLedger(path, { clock, mode: "reopen", migrations: changed })).toMatchObject({ ok: false, reason: "not_initialized" });
  const bare = tempPath();
  open(bare, { migrations: [] }).close();
  expect(openLedger(bare, { clock, mode: "reopen", migrations: [] })).toMatchObject({ ok: false, reason: "not_initialized" });
});

test("reopen: 업무 행이 있는 정상 장부와 WAL에만 커밋이 있는 장부는 열린다", async () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const run = must(ledger.admitRun(worker())).run;
  must(ledger.applyStop({ generation: 2, stopped: true, now: NOW }));
  ledger.close();
  const again = openLedger(path, { clock, mode: "reopen" });
  if (!again.ok) throw new Error(again.detail);
  expect(again.migrated).toEqual({ from: loadMigrations().length, to: loadMigrations().length });
  expect(again.ledger.getRun(run.runId)).toMatchObject({ known: true, value: { state: "queued" } });
  expect(again.ledger.readStop()).toMatchObject({ value: { generation: 2, stopped: true } });
  again.ledger.close();

  // 자식이 커밋한 뒤 체크포인트 전에 죽으면 그 커밋은 WAL에만 있다.
  const walOnly = tempPath();
  await crashChild([join(import.meta.dir, "crash-child.ts"), walOnly, "stop"]);
  expect(statSync(`${walOnly}-wal`).size).toBeGreaterThan(0);
  const body = new Database(`file:${walOnly}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
  expect(body.query("SELECT COUNT(*) AS n FROM stop_state").get()).toEqual({ n: 0 });
  body.close();
  const reopened = openLedger(walOnly, { clock, mode: "reopen" });
  if (!reopened.ok) throw new Error(reopened.detail);
  expect(reopened.ledger.readStop()).toMatchObject({ known: true, value: { generation: 3, stopped: true } });
  reopened.ledger.close();
});

test("끊긴 설치: 본체와 hot journal이 남으면 create는 끊긴 설치로 가르고, reopen이 되돌린 뒤 create가 이어 받는다", async () => {
  const path = tempPath();
  await crashChild([join(import.meta.dir, "install-child.ts"), path]);
  expect(statSync(`${path}-journal`).size).toBeGreaterThan(0);
  const before = readFileSync(path);
  const first = openLedger(path, { clock, mode: "create", migrations: SPILL_MIGRATIONS });
  expect(first).toMatchObject({ ok: false, reason: "interrupted_install" });
  // 판정은 파일을 바꾸지 않는다. 저널도 그대로 남아 사람이 절차를 밟을 수 있다.
  expect(readFileSync(path).equals(before)).toBe(true);
  expect(existsSync(`${path}-journal`)).toBe(true);
  // reopen은 받지 않지만 연결이 저널을 되돌린다. 첫 설치 기록이 없으니 사유는 not_initialized다.
  expect(openLedger(path, { clock, mode: "reopen", migrations: SPILL_MIGRATIONS })).toMatchObject({ ok: false, reason: "not_initialized" });
  const resumed = openLedger(path, { clock, mode: "create", migrations: SPILL_MIGRATIONS });
  expect(resumed).toMatchObject({ ok: true, migrated: { from: 1, to: 2 } });
  if (resumed.ok) resumed.ledger.close();
});

test("끊긴 설치: 저널이 없는 낯선 내용은 그대로 foreign_data이고 끊긴 설치로 받지 않는다", () => {
  const path = tempPath();
  markedFile(path, (raw) => raw.run("CREATE TABLE notes (x INTEGER)"));
  const before = readFileSync(path);
  expect(openLedger(path, { clock, mode: "create" })).toMatchObject({ ok: false, reason: "foreign_data" });
  expect(readFileSync(path).equals(before)).toBe(true);
});
