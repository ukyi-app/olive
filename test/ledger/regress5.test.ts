// 사본·보류·파일 판정의 회귀: 대조와 복원 시도의 수명, 사본 표식과 사본 기록, WAL이 있는 본체의 길이, 다시 열 수 없는 판.
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Ledger, loadMigrations, openLedger, type OpenResult, type RestorePorts, Restorer, RestoreStepError, type SnapshotResult } from "../../src/ledger/index.ts";
import { SNAPSHOT_UNOPENED } from "../../src/ledger/snapshot.ts";
import { CHECKPOINT_ROWS } from "./checkpoint-child.ts";
import { clock, id, must, NOW, open, ready, tempDir, tempPath, worker } from "./helpers.ts";
import { WAL_PAIR_GENERATION, WAL_PAIR_NONCES, WAL_PAIR_SENDER, walPairNonce } from "./wal-pair-child.ts";

const MAX = 10_000_000;
const PEERS = ["front-door"];

const ports: RestorePorts = {
  stopAuthority: { latestStop: async () => null },
  peers: { contracts: async () => PEERS.map((peer) => ({ peer, contract: "olive-control/v1" })) },
  occupancy: { occupancy: async () => [] },
  publications: { lookup: async () => ({ kind: "pending" as const }) },
};

function taken(result: SnapshotResult): Extract<SnapshotResult, { ok: true }> {
  if (!result.ok) throw new Error(`사본 실패: ${result.reason} ${result.detail}`);
  return result;
}

function opened(result: OpenResult): Ledger {
  if (!result.ok) throw new Error(`열지 못함: ${result.reason} ${result.detail}`);
  return result.ledger;
}

// 한 번도 열지 않은 사본 파일을 만든다.
function unopenedCopy() {
  const dir = tempDir();
  const copy = join(dir, "copy.db");
  const ledger = ready(open(join(dir, "ledger.db")));
  const snapshot = taken(ledger.createSnapshot({ path: copy, maxBytes: MAX }));
  ledger.close();
  return { dir, copy, snapshot };
}

function fromSnapshot() {
  const { dir, copy, snapshot } = unopenedCopy();
  return { dir, copy, snapshot, ledger: opened(openLedger(copy, { clock, mode: "reopen" })) };
}

// 권위 응답을 시험이 쥔다. reached는 1단계가 응답을 기다리기 시작한 순간이다.
function heldAuthority() {
  let answer: (value: null) => void = () => {};
  let arrive: () => void = () => {};
  const waiting = new Promise<null>((resolve) => (answer = resolve));
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const held: RestorePorts = {
    ...ports,
    stopAuthority: {
      latestStop: () => {
        arrive();
        return waiting;
      },
    },
  };
  return { held, reached, answer: () => answer(null) };
}

async function restoreAll(ledger: Ledger) {
  const restorer = new Restorer(ledger, ports, clock, { requiredPeers: PEERS });
  await restorer.step1();
  await restorer.step2();
  await restorer.step3();
  await restorer.step4();
  return { restorer, s5: await restorer.step5() };
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
}

// 커밋이 WAL에만 있는 본체와 WAL의 쌍을 남긴다.
async function walPair(): Promise<string> {
  const path = tempPath();
  await crashChild([join(import.meta.dir, "wal-pair-child.ts"), path]);
  return path;
}

// 같은 쌍을 끝까지 체크포인트한 본체의 바이트. 복제본에서 체크포인트하므로 원래 쌍은 그대로다.
function checkpointed(path: string): Buffer {
  const control = join(tempDir(), "control.db");
  copyFileSync(path, control);
  copyFileSync(`${path}-wal`, `${control}-wal`);
  const raw = new Database(control);
  raw.query("PRAGMA wal_checkpoint(TRUNCATE)").all();
  raw.close();
  return readFileSync(control);
}

// 체크포인트가 새 페이지의 앞 512바이트만 본체에 쓰고 끊긴 모습을 만든다. 쓰인 바이트는 같은 쌍을 끝까지 체크포인트한 결과에서 가져온다.
function cutCheckpoint(path: string): void {
  const whole = checkpointed(path);
  const body = readFileSync(path);
  expect(whole.length).toBeGreaterThan(body.length);
  writeFileSync(path, Buffer.concat([body, whole.subarray(body.length, body.length + 512)]));
}

// ---- 대조와 복원 시도 ----

test("F01 대조: 권위 응답을 기다리던 1단계는 대조가 끝나면 이어지지 못하고 새 복원만 접수를 연다", async () => {
  const { ledger, snapshot } = fromSnapshot();
  const { held, reached, answer } = heldAuthority();
  const pending = new Restorer(ledger, held, clock, { requiredPeers: PEERS });
  const first = pending.step1();
  await reached;
  must(ledger.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW + 5 }));
  answer();
  await expect(first).rejects.toBeInstanceOf(RestoreStepError);
  expect(pending.stopGeneration()).toBeNull();
  expect(pending.intakeOpen()).toBe(false);
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "intake_closed" });

  const fresh = await restoreAll(ledger);
  expect(fresh.s5).toMatchObject({ intakeMayOpen: true, closedBecause: [] });
  expect(fresh.restorer.intakeOpen()).toBe(true);
  ledger.close();
});

test("F01 대조: 1단계를 이미 마친 복원도 대조가 끝나면 다음 단계로 가지 못한다", async () => {
  const { ledger, snapshot } = fromSnapshot();
  const earlier = new Restorer(ledger, ports, clock, { requiredPeers: PEERS });
  await earlier.step1();
  expect(earlier.stopGeneration()).toBe(0);
  must(ledger.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW + 5 }));
  await expect(earlier.step2()).rejects.toBeInstanceOf(RestoreStepError);
  expect(earlier.stopGeneration()).toBeNull();
  expect(earlier.intakeOpen()).toBe(false);
  ledger.close();
});

test("F01 대조: 다른 사본 식별로 실패한 대조는 기다리던 복원 시도를 건드리지 않는다", async () => {
  const { ledger } = fromSnapshot();
  const { held, reached, answer } = heldAuthority();
  const pending = new Restorer(ledger, held, clock, { requiredPeers: PEERS });
  const first = pending.step1();
  await reached;
  expect(ledger.confirmSnapshotReconciled({ snapshotId: id(), now: NOW + 5 })).toEqual({ ok: false, reason: "reference_mismatch" });
  answer();
  expect(await first).toMatchObject({ stopGeneration: 0, stopped: false });
  expect(pending.stopGeneration()).toBe(0);
  ledger.close();
});

// ---- 사본 표식과 사본 기록 ----

test("F02 사본 표식: 기록이 비었거나 대조 끝난 기록만 있거나 미대조가 최신이 아니면 열지 않고 표식을 소비하지 않는다", () => {
  const mark = (path: string) => {
    const raw = new Database(path);
    raw.run(`PRAGMA user_version = ${SNAPSHOT_UNOPENED}`);
    raw.close();
  };
  const files: Record<string, () => string> = {
    "빈 기록": () => {
      const path = tempPath();
      const ledger = ready(open(path));
      must(ledger.applyStop({ generation: 10, stopped: true, now: NOW }));
      ledger.close();
      mark(path);
      return path;
    },
    "대조 끝난 기록만": () => {
      const { copy, snapshot, ledger } = fromSnapshot();
      must(ledger.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW + 1 }));
      ledger.close();
      mark(copy);
      return copy;
    },
    "미대조가 최신이 아님": () => {
      const { copy, snapshot } = unopenedCopy();
      const raw = new Database(copy);
      const trigger = (raw.query("SELECT sql FROM sqlite_master WHERE name = 'ledger_snapshots_insert'").get() as { sql: string }).sql;
      raw.run("DROP TRIGGER ledger_snapshots_insert");
      const newer = id();
      raw.query("INSERT INTO ledger_snapshots (seq, snapshot_id, ledger_id, taken_at, reconciled_at, reconciled_snapshot_id) VALUES (2, ?, ?, ?, ?, ?)").run(newer, snapshot.ledgerId, NOW, NOW, newer);
      raw.run(trigger);
      raw.close();
      return copy;
    },
  };
  for (const [label, build] of Object.entries(files)) {
    const path = build();
    expect(openLedger(path, { clock, mode: "reopen" }), label).toMatchObject({ ok: false, reason: "corrupt" });
    const raw = new Database(path, { readonly: true });
    expect(raw.query("PRAGMA user_version").get(), label).toEqual({ user_version: SNAPSHOT_UNOPENED });
    raw.close();
  }
});

test("F02 사본 만들기: 사본 기록이 0행으로 끝나면 사본을 내지 않는다", () => {
  const swallow = [...loadMigrations(), { version: 2, name: "0002-swallow.sql", sql: "CREATE TRIGGER swallow_snapshot BEFORE INSERT ON ledger_snapshots BEGIN SELECT RAISE(IGNORE); END;" }];
  const dir = tempDir();
  const ledger = ready(open(join(dir, "ledger.db"), { migrations: swallow }));
  const target = join(dir, "copy.db");
  expect(ledger.createSnapshot({ path: target, maxBytes: MAX })).toMatchObject({ ok: false, reason: "snapshot_unsupported" });
  expect(existsSync(target)).toBe(false);
  expect(ledger.health()).toEqual({ writable: true });
  ledger.close();
});

// ---- WAL이 있는 본체의 길이 ----

test("F03 재개방: 체크포인트가 새 페이지 중간에서 끊긴 본체와 온전한 WAL은 커밋을 읽고 열린다", async () => {
  const path = await walPair();
  cutCheckpoint(path);
  expect(readFileSync(path).length % 4096).toBe(512);
  const result = openLedger(path, { clock, mode: "reopen" });
  expect(result).toMatchObject({ ok: true });
  const ledger = opened(result);
  expect(ledger.readStop()).toMatchObject({ known: true, value: { generation: WAL_PAIR_GENERATION, stopped: true } });
  const store = ledger.nonceStore();
  for (let index = 0; index < WAL_PAIR_NONCES; index++) expect(store.consume(WAL_PAIR_SENDER, walPairNonce(index), NOW + 30_000), String(index)).toBe(false);
  ledger.close();
});

test("F03 재개방: 커밋을 담을 수 없는 WAL 곁의 잘린 본체와 처음 여는 사본은 길이 검사를 비켜 가지 못한다", async () => {
  // 프레임 하나도 담지 못하는 WAL에는 복구할 커밋이 없다.
  const short = tempPath();
  open(short).close();
  const body = readFileSync(short);
  writeFileSync(short, body.subarray(0, body.length - 1));
  writeFileSync(`${short}-wal`, "short");
  expect(openLedger(short, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "corrupt" });

  // 처음 여는 사본은 커밋을 담을 만큼 큰 WAL이 곁에 있어도 그 WAL을 읽지 않고 거절한다.
  const { copy } = unopenedCopy();
  const whole = readFileSync(copy);
  writeFileSync(copy, whole.subarray(0, whole.length - 512));
  writeFileSync(`${copy}-wal`, Buffer.alloc(64 * 1024, 1));
  expect(openLedger(copy, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "not_initialized" });

  // 곁 파일 없는 독립 본체는 한 번 연 사본이어도 페이지 경계에서 끝나야 한다.
  const { copy: reopened, ledger } = fromSnapshot();
  ledger.close();
  const opened_ = readFileSync(reopened);
  writeFileSync(reopened, opened_.subarray(0, opened_.length - 1));
  expect(openLedger(reopened, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "corrupt" });
});

// ---- 다시 열 수 없는 판 ----

test("F04 판 올리기: 기존 데이터에 기대는 판은 적용하기 전에 거절하고 장부는 그대로 다시 열린다", () => {
  const seeded = [...loadMigrations(), { version: 2, name: "0002-seeded.sql", sql: "CREATE TABLE seeded (ledger_id TEXT NOT NULL) STRICT; INSERT INTO seeded SELECT ledger_id FROM ledger_identity;" }];
  const path = tempPath();
  const ledger = ready(open(path));
  must(ledger.applyStop({ generation: 4, stopped: true, now: NOW }));
  ledger.close();
  const before = readFileSync(path);

  expect(openLedger(path, { clock, mode: "reopen", migrations: seeded })).toMatchObject({ ok: false, reason: "migration_failed" });
  expect(readFileSync(path).equals(before)).toBe(true);

  const again = opened(openLedger(path, { clock, mode: "reopen" }));
  expect(again.readStop()).toMatchObject({ value: { generation: 4, stopped: true } });
  again.close();
  const raw = new Database(path, { readonly: true });
  expect(raw.query("SELECT version FROM ledger_migrations").all()).toEqual([{ version: 1 }]);
  expect(raw.query("SELECT name FROM sqlite_master WHERE name = 'seeded'").get()).toBeNull();
  raw.close();
});

test("F04 첫 설치: 빈 목록과 빈 DB에서 재생할 수 없는 판은 파일을 만들지 않고 거절한다", () => {
  const empty = tempPath();
  expect(openLedger(empty, { clock, mode: "create", migrations: [] })).toMatchObject({ ok: false, reason: "migration_mismatch" });
  expect(existsSync(empty)).toBe(false);

  const seeded = [...loadMigrations(), { version: 2, name: "0002-seeded.sql", sql: "INSERT INTO seeded SELECT 1;" }];
  const broken = tempPath();
  expect(openLedger(broken, { clock, mode: "create", migrations: seeded })).toMatchObject({ ok: false, reason: "migration_failed" });
  expect(existsSync(broken)).toBe(false);
});

test("F04 판 올리기: 빈 DB에서 재생할 수 있는 판은 그대로 올라가고 다음 재개방도 열린다", () => {
  const added = [...loadMigrations(), { version: 2, name: "0002-added.sql", sql: "CREATE TABLE added (x INTEGER) STRICT;" }];
  const path = tempPath();
  open(path).close();
  const upgraded = openLedger(path, { clock, mode: "reopen", migrations: added });
  expect(upgraded).toMatchObject({ ok: true, migrated: { from: 1, to: 2 } });
  opened(upgraded).close();
  const next = openLedger(path, { clock, mode: "reopen", migrations: added });
  expect(next).toMatchObject({ ok: true, migrated: { from: 2, to: 2 } });
  opened(next).close();
});

// ---- 거절하는 길과 파일 ----

function writeFromChild(path: string): string {
  const script = `
    import { Database } from "bun:sqlite";
    try {
      const db = new Database(${JSON.stringify(path)});
      db.run("PRAGMA busy_timeout = 0");
      db.run("BEGIN IMMEDIATE");
      db.run("COMMIT");
      console.log("WROTE");
    } catch (error) {
      console.log(error.code);
    }
  `;
  return Bun.spawnSync([process.execPath, "-e", script]).stdout.toString().trim();
}

test("F05 재개방: 스키마가 다른 목록으로 거절해도 본체와 WAL의 바이트가 그대로이고 곁 파일이 늘지 않는다", async () => {
  const path = await walPair();
  const body = readFileSync(path);
  const wal = readFileSync(`${path}-wal`);
  const other = [{ version: 1, name: "0001-core.sql", sql: "CREATE TABLE other (x INTEGER) STRICT;" }];
  expect(openLedger(path, { clock, mode: "reopen", migrations: other })).toMatchObject({ ok: false, reason: "not_initialized" });
  expect(readFileSync(path).equals(body)).toBe(true);
  expect(readFileSync(`${path}-wal`).equals(wal)).toBe(true);
  expect(existsSync(`${path}-shm`)).toBe(false);

  const ledger = opened(openLedger(path, { clock, mode: "reopen" }));
  expect(ledger.readStop()).toMatchObject({ value: { generation: WAL_PAIR_GENERATION, stopped: true } });
  ledger.close();
});

test("F05 재개방: 커밋이 든 WAL을 쥔 장부를 다시 열면 locked이고 쥔 쪽의 잠금은 풀리지 않는다", () => {
  const path = tempPath();
  const ledger = open(path);
  must(ledger.applyStop({ generation: 1, stopped: false, now: NOW }));
  expect(statSync(`${path}-wal`).size).toBeGreaterThanOrEqual(56 + 4096);
  expect(openLedger(path, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "locked" });
  expect(writeFromChild(path)).toBe("SQLITE_BUSY");
  must(ledger.applyStop({ generation: 2, stopped: false, now: NOW }));
  ledger.close();
});

test("F06 첫 열기: 처음 여는 사본 곁에 저널만 있으면 사유를 가르고 파일을 바꾸지 않으며, 저널을 격리하면 열린다", () => {
  const { dir, copy } = unopenedCopy();
  const before = readFileSync(copy);
  writeFileSync(`${copy}-journal`, "left");
  expect(openLedger(copy, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "interrupted_install" });
  expect(readFileSync(copy).equals(before)).toBe(true);
  expect(readFileSync(`${copy}-journal`, "utf8")).toBe("left");

  renameSync(`${copy}-journal`, join(dir, "quarantined-journal"));
  const ledger = opened(openLedger(copy, { clock, mode: "reopen" }));
  expect(ledger.snapshotOrigin()).toMatchObject({ known: true, value: { held: true } });
  ledger.close();
});

// ---- 사본 만들기의 경계 ----

test("F07 사본: 임시 이름을 확보하지 못한 호출은 그 자리의 파일을 지우지 않는다", () => {
  const dir = tempDir();
  const ledger = ready(open(join(dir, "ledger.db")));
  const target = join(dir, "copy.db");
  const fixed = "33333333-3333-4333-8333-333333333333" as const;
  const temp = `${target}.partial-${fixed}`;
  writeFileSync(temp, "keep");
  const uuid = spyOn(crypto, "randomUUID").mockReturnValue(fixed);
  try {
    expect(ledger.createSnapshot({ path: target, maxBytes: MAX })).toMatchObject({ ok: false, reason: "io" });
  } finally {
    uuid.mockRestore();
  }
  expect(readFileSync(temp, "utf8")).toBe("keep");
  expect(existsSync(target)).toBe(false);
  expect(ledger.health()).toEqual({ writable: true });
  ledger.close();
});

test("F08 사본: 판이 user_version을 쓰는 장부는 사본을 내지 않고 그 값을 그대로 둔다", () => {
  const versioned = [...loadMigrations(), { version: 2, name: "0002-versioned.sql", sql: "PRAGMA user_version = 17;" }];
  const dir = tempDir();
  const path = join(dir, "ledger.db");
  const ledger = ready(open(path, { migrations: versioned }));
  const target = join(dir, "copy.db");
  expect(ledger.createSnapshot({ path: target, maxBytes: MAX })).toMatchObject({ ok: false, reason: "snapshot_unsupported" });
  expect(existsSync(target)).toBe(false);
  ledger.close();
  const raw = new Database(path, { readonly: true });
  expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
  raw.close();
});

test("F12 사본: 시계가 던지면 사본 결과로 거절하고 장부는 계속 쓴다", () => {
  let broken = false;
  const dir = tempDir();
  const ticking = () => {
    if (broken) throw new Error("시계 고장");
    return NOW;
  };
  const ledger = ready(open(join(dir, "ledger.db"), { clock: ticking }));
  const target = join(dir, "copy.db");
  broken = true;
  expect(ledger.createSnapshot({ path: target, maxBytes: MAX })).toMatchObject({ ok: false, reason: "ledger_unwritable" });
  broken = false;
  expect(existsSync(target)).toBe(false);
  expect(ledger.health()).toEqual({ writable: true });
  taken(ledger.createSnapshot({ path: target, maxBytes: MAX }));
  ledger.close();
});

// ---- 머리가 본체보다 앞선 본체(끊긴 체크포인트 뒤의 재기동) ----
// 체크포인트는 페이지를 번호 순으로 옮기므로, 파일을 늘리다 끊기면 새 1번 페이지(늘어난 페이지 수)가 본체 끝보다 먼저 남는다.
// 본체만 읽는 SQLite 연결은 이 머리를 읽지 못해(SQLITE_CORRUPT) 판정이 본체 머리 100바이트를 FD로 읽는다.
// 그 FD는 이 프로세스가 그 파일의 잠금을 쥐지 않았을 때만 연다. 다른 FD를 닫으면 쥔 쪽의 POSIX 잠금이 풀리기 때문이다.

const PAGE = 4096;
const UNOPENED_SIDECAR = "한 번도 열지 않은 사본 곁에 다른 시점의 파일이 있다: -wal";
const NOT_OURS = "이 설치가 만든 장부가 아니다";
const HEADER_CORRUPT = "SQLITE_CORRUPT: database disk image is malformed";
const HELD_HERE = "이 프로세스가 이미 쥔 장부다";

// 머리의 페이지 수가 본체 길이(페이지 단위로 올림)보다 크다. 본체만 읽는 SQLite 연결은 이 머리를 SQLITE_CORRUPT로 거절한다.
function headerAhead(body: Buffer): boolean {
  return body.readUInt32BE(28) > Math.ceil(body.length / body.readUInt16BE(16));
}

// 체크포인트가 새 1번 페이지를 본체 끝보다 먼저 반영하고 끊긴 본체들. 모두 원래 쌍의 WAL과 짝을 이룬다.
function aheadBodies(path: string): Record<"firstPage" | "prefix" | "prefixAligned", Buffer> {
  const body = readFileSync(path);
  const whole = checkpointed(path);
  expect(body.length % PAGE).toBe(0);
  expect(whole.length).toBeGreaterThan(body.length + PAGE);
  return {
    firstPage: Buffer.concat([whole.subarray(0, PAGE), body.subarray(PAGE)]),
    prefix: whole.subarray(0, body.length + 512),
    prefixAligned: whole.subarray(0, body.length + PAGE),
  };
}

function place(body: Uint8Array, wal: Uint8Array | null): string {
  const path = tempPath();
  writeFileSync(path, body);
  if (wal !== null) writeFileSync(`${path}-wal`, wal);
  return path;
}

function cutPages(body: Buffer, pages: number): Buffer {
  return body.subarray(0, body.length - pages * PAGE);
}

// 이 설치가 만들지 않은 여러 페이지의 SQLite 파일(application_id 7).
function foreignBody(): Buffer {
  const path = tempPath();
  const raw = new Database(path);
  raw.run("PRAGMA application_id = 7");
  raw.run("CREATE TABLE t (x BLOB)");
  raw.run("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12) INSERT INTO t SELECT randomblob(3000) FROM n");
  raw.close();
  return readFileSync(path);
}

// SQLite가 WAL까지 읽은 같은 쌍의 값. 복제본을 읽기 전용으로 열어 원래 쌍을 바꾸지 않는다.
function throughWal(path: string) {
  const control = join(tempDir(), "control.db");
  copyFileSync(path, control);
  copyFileSync(`${path}-wal`, `${control}-wal`);
  const raw = new Database(control, { readonly: true });
  try {
    const check = raw.query("PRAGMA quick_check").all() as { quick_check: string }[];
    const stop = raw.query("SELECT generation, stopped FROM stop_state").get() as { generation: number; stopped: number };
    const { n } = raw.query("SELECT count(*) AS n FROM nonces").get() as { n: number };
    return { check: check.map((row) => row.quick_check), generation: stop.generation, stopped: stop.stopped, nonces: n };
  } finally {
    raw.close();
  }
}

// 공개 API로 다시 열어 정지 기록을 읽는다. 닫으면 장부가 WAL을 체크포인트하므로 그 뒤의 본체에서 nonce를 센다.
function reopened(path: string) {
  const result = openLedger(path, { clock, mode: "reopen" });
  if (!result.ok) return { ok: false, reason: result.reason, detail: stripped(result.detail) };
  const stop = result.ledger.readStop();
  result.ledger.close();
  const raw = new Database(path, { readonly: true });
  const { n } = raw.query("SELECT count(*) AS n FROM nonces").get() as { n: number };
  raw.close();
  return { ok: true, stop: stop.known && stop.value !== null ? { generation: stop.value.generation, stopped: stop.value.stopped } : stop, nonces: n };
}

function stripped(detail: string): string {
  return detail.replace(/^LedgerUnavailableError: ledger unavailable \(\w+\): /, "");
}

function listing(path: string): string[] {
  return readdirSync(dirname(path)).sort();
}

// 거절의 사유와 상세, 그리고 판정이 본체·WAL의 바이트와 폴더의 이름 목록(곁 파일)을 바꾸지 않았는지.
function refused(path: string) {
  const body = readFileSync(path);
  const wal = existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : null;
  const names = listing(path);
  const result = openLedger(path, { clock, mode: "reopen" });
  if (result.ok) {
    result.ledger.close();
    return { ok: true };
  }
  const walSame = wal === null ? !existsSync(`${path}-wal`) : readFileSync(`${path}-wal`).equals(wal);
  return {
    ok: false,
    reason: result.reason,
    detail: stripped(result.detail),
    unchanged: readFileSync(path).equals(body) && walSame && JSON.stringify(listing(path)) === JSON.stringify(names),
  };
}

// 시험이 지켜본 openSync 가운데 장부 경로를 연 호출의 플래그. SQLite의 열기는 node:fs를 거치지 않는다.
function fdOpens(spy: { mock: { calls: unknown[][] } }, path: string): unknown[] {
  return spy.mock.calls.filter((call) => call[0] === path).map((call) => call[1]);
}

test("R01 재기동: 1번 페이지만 새것·앞부분(페이지 중간·경계)인 본체와 온전한 WAL은 WAL까지 읽은 SQLite의 정지 세대와 기록 수로 열린다", async () => {
  const pair = await walPair();
  const wal = readFileSync(`${pair}-wal`);
  const bodies = aheadBodies(pair);
  expect(Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, { ahead: headerAhead(body), aligned: body.length % PAGE === 0 }]))).toEqual({
    firstPage: { ahead: true, aligned: true },
    prefix: { ahead: true, aligned: false },
    prefixAligned: { ahead: true, aligned: true },
  });

  const expected: Record<string, unknown> = {};
  const actual: Record<string, unknown> = {};
  for (const [name, body] of Object.entries(bodies)) {
    const path = place(body, wal);
    const reference = throughWal(path);
    expect(reference, name).toEqual({ check: ["ok"], generation: WAL_PAIR_GENERATION, stopped: 1, nonces: WAL_PAIR_NONCES });
    expected[name] = { ok: true, stop: { generation: reference.generation, stopped: reference.stopped === 1 }, nonces: reference.nonces };
    actual[name] = reopened(path);
  }
  expect(actual).toEqual(expected);
});

test("R01 거절: 페이지 경계에서 잘린 미개봉 사본과 옛·다른 장부의 WAL, 이 설치가 만들지 않은 잘린 본체와 이 장부의 WAL은 본체 머리의 표식으로 거절하고 파일을 바꾸지 않는다", async () => {
  // 장부 A의 옛 운용 WAL을 떼어 두고, A를 다시 열어 처음 여는 사본을 만든다.
  const a = await walPair();
  const oldWal = readFileSync(`${a}-wal`);
  const ledger = opened(openLedger(a, { clock, mode: "reopen" }));
  const copy = join(tempDir(), "copy.db");
  taken(ledger.createSnapshot({ path: copy, maxBytes: MAX }));
  ledger.close();
  const truncatedCopy = cutPages(readFileSync(copy), 1);
  const otherWal = readFileSync(`${await walPair()}-wal`);
  const inputs = {
    unopenedOldWal: place(truncatedCopy, oldWal),
    unopenedOtherWal: place(truncatedCopy, otherWal),
    foreignThisWal: place(cutPages(foreignBody(), 1), oldWal),
  };
  // 셋 다 본체만 읽는 연결이 머리를 읽지 못하는 모양이고, 커밋을 담을 수 있는 WAL이 곁에 있어 머리 읽기까지 간다.
  for (const [name, path] of Object.entries(inputs)) {
    expect(readFileSync(path).length % PAGE, name).toBe(0);
    expect(headerAhead(readFileSync(path)), name).toBe(true);
    expect(statSync(`${path}-wal`).size, name).toBeGreaterThanOrEqual(56 + PAGE);
  }
  expect(Object.fromEntries(Object.entries(inputs).map(([name, path]) => [name, refused(path)]))).toEqual({
    unopenedOldWal: { ok: false, reason: "not_initialized", detail: UNOPENED_SIDECAR, unchanged: true },
    unopenedOtherWal: { ok: false, reason: "not_initialized", detail: UNOPENED_SIDECAR, unchanged: true },
    foreignThisWal: { ok: false, reason: "not_initialized", detail: NOT_OURS, unchanged: true },
  });
});

test("R01 잠금: 같은 프로세스가 쥔 장부를 다시 열면 머리 FD를 열지 않고 locked이며 쥔 쪽의 잠금이 풀리지 않는다(WAL이 있을 때와 없을 때)", async () => {
  const pair = await walPair();
  const { firstPage } = aheadBodies(pair);
  const ahead = place(firstPage, readFileSync(`${pair}-wal`));
  const plain = tempPath();
  const holders = { withWal: opened(openLedger(ahead, { clock, mode: "reopen" })), withoutWal: open(plain) };
  expect(statSync(`${ahead}-wal`).size).toBeGreaterThanOrEqual(56 + PAGE);
  expect(existsSync(`${plain}-wal`) ? statSync(`${plain}-wal`).size : 0).toBeLessThan(56 + PAGE);

  const opens = spyOn(fs, "openSync");
  try {
    const second = { withWal: openLedger(ahead, { clock, mode: "reopen" }), withoutWal: openLedger(plain, { clock, mode: "reopen" }) };
    expect(second.withWal).toMatchObject({ ok: false, reason: "locked" });
    expect(second.withoutWal).toMatchObject({ ok: false, reason: "locked" });
    // WAL이 있는 쪽은 본체만 읽는 연결이 머리를 읽지 못해 머리 읽기 직전의 잠금 확인에서 멈췄다.
    expect(second.withWal.ok ? null : stripped(second.withWal.detail)).toBe(HELD_HERE);
    expect({ withWal: fdOpens(opens, ahead), withoutWal: fdOpens(opens, plain) }).toEqual({ withWal: [], withoutWal: [] });
  } finally {
    opens.mockRestore();
  }
  expect({ withWal: writeFromChild(ahead), withoutWal: writeFromChild(plain) }).toEqual({ withWal: "SQLITE_BUSY", withoutWal: "SQLITE_BUSY" });
  must(holders.withWal.applyStop({ generation: WAL_PAIR_GENERATION + 1, stopped: true, now: NOW }));
  must(holders.withoutWal.applyStop({ generation: 1, stopped: false, now: NOW }));
  holders.withWal.close();
  holders.withoutWal.close();
});

test("R01 잠금: /proc/locks를 읽지 못하거나 해석하지 못하면 머리 FD를 열지 않고 corrupt로 닫는다", async () => {
  const pair = await walPair();
  const { firstPage } = aheadBodies(pair);
  const wal = readFileSync(`${pair}-wal`);
  const realRead = fs.readFileSync;
  const locks: Record<string, () => string> = {
    unreadable: () => {
      throw Object.assign(new Error("EACCES: permission denied, open '/proc/locks'"), { code: "EACCES" });
    },
    unparsable: () => "locks are not listed here\n",
  };
  const results: Record<string, unknown> = {};
  for (const [name, answer] of Object.entries(locks)) {
    const path = place(firstPage, wal);
    const reads = spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...rest: unknown[]) =>
      file === "/proc/locks" ? answer() : (realRead as (...args: unknown[]) => unknown)(file, ...rest)) as typeof fs.readFileSync);
    const opens = spyOn(fs, "openSync");
    try {
      results[name] = { ...refused(path), fd: fdOpens(opens, path), asked: reads.mock.calls.filter((call) => call[0] === "/proc/locks").length };
    } finally {
      reads.mockRestore();
      opens.mockRestore();
    }
  }
  expect(results).toEqual({
    unreadable: { ok: false, reason: "corrupt", detail: HEADER_CORRUPT, unchanged: true, fd: [], asked: 1 },
    unparsable: { ok: false, reason: "corrupt", detail: HEADER_CORRUPT, unchanged: true, fd: [], asked: 1 },
  });
  // 같은 쌍도 잠금 목록을 읽을 수 있으면 열린다.
  expect(reopened(place(firstPage, wal))).toMatchObject({ ok: true, nonces: WAL_PAIR_NONCES });
});

test("R01 예방: chunk size를 건 장부는 체크포인트 도중 강제 종료돼도 머리의 페이지 수가 본체 파일보다 앞서지 않고 다시 열린다", async () => {
  const samples: { delayMicros: number; killed: boolean; walLeft: boolean; ahead: boolean; aligned: boolean; rows: unknown }[] = [];
  for (const delayMicros of [0, 50, 200, 1000]) {
    const path = tempPath();
    // 자식은 체크포인트가 본체를 늘리기 시작한 뒤 delayMicros만큼 더 돌고 자기 자신에게 SIGKILL을 보낸다. 이 시험은 신호를 보내지 않는다.
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "checkpoint-child.ts"), path, String(delayMicros)], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    await child.exited;
    const killed = child.signalCode === "SIGKILL";
    if (!killed && out.trim() !== "CLOSED") throw new Error(`자식이 체크포인트까지 가지 못함: ${out} ${await new Response(child.stderr).text()}`);
    const body = readFileSync(path);
    const walLeft = existsSync(`${path}-wal`) && statSync(`${path}-wal`).size >= 56 + PAGE;
    const result = openLedger(path, { clock, mode: "reopen" });
    let rows: unknown = result.ok ? null : result.reason;
    if (result.ok) {
      result.ledger.close();
      const raw = new Database(path, { readonly: true });
      rows = (raw.query("SELECT count(*) AS n FROM nonces").get() as { n: number }).n;
      raw.close();
    }
    samples.push({ delayMicros, killed, walLeft, ahead: headerAhead(body), aligned: body.length % PAGE === 0, rows });
  }
  expect(samples.filter((sample) => sample.ahead || !sample.aligned || sample.rows !== CHECKPOINT_ROWS)).toEqual([]);
  // 적어도 한 번은 체크포인트가 끝나기 전(WAL이 남은 채)에 끊겼다. 아니면 이 시험은 아무것도 보지 않은 것이다.
  expect(samples.some((sample) => sample.killed && sample.walLeft)).toBe(true);
}, 60_000);
