// 사본·보류·파일 판정의 회귀: 대조와 복원 시도의 수명, 사본 표식과 사본 기록, WAL이 있는 본체의 길이, 다시 열 수 없는 판.
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, loadMigrations, openLedger, type OpenResult, type RestorePorts, Restorer, RestoreStepError, type SnapshotResult } from "../../src/ledger/index.ts";
import { SNAPSHOT_UNOPENED } from "../../src/ledger/snapshot.ts";
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

// 체크포인트가 새 페이지의 앞 512바이트만 본체에 쓰고 끊긴 모습을 만든다. 쓰인 바이트는 같은 쌍을 끝까지 체크포인트한 결과에서 가져온다.
function cutCheckpoint(path: string): void {
  const control = join(tempDir(), "control.db");
  copyFileSync(path, control);
  copyFileSync(`${path}-wal`, `${control}-wal`);
  const raw = new Database(control);
  raw.query("PRAGMA wal_checkpoint(TRUNCATE)").all();
  raw.close();
  const whole = readFileSync(control);
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
