// 판 8(0008-stop-exit): 종료 확인 영수증의 exit를 실행 줄에 남기고 failedStop이 그 값을 낸다(D-124). 판 7 장부를 올리면 기존 줄은
// 그대로이고 새 칸은 NULL(모름)이다. 실제 임시 장부 파일에 적고 공개 읽기와 원 SQL로 본다. ID·digest·시각은 이 시험이 지어낸 값이다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Ledger, loadMigrations, openLedger, STOP_EXITS, type StopExit } from "../../src/ledger/index.ts";
import { initLedger, LEDGER_INIT_EXIT } from "../../src/main/ledger-init.ts";
import { LEDGER_DIR_ENV, LEDGER_FILE } from "../../src/main/ledger-path.ts";
import { failedOutcome } from "../../src/supervisor/dispatch/life-loop.ts";
import { clock, digest, id, must, NOW, open, ready, startedWorker, tempDir, tempPath, worker } from "./helpers.ts";

const FILE = "0008-stop-exit.sql";
const VERSION = loadMigrations().findIndex((m) => m.name === FILE) + 1;
const BEFORE = () => loadMigrations().slice(0, VERSION - 1);

type Started = ReturnType<typeof startedWorker>;

function stop(ledger: Ledger, s: Started, exit: StopExit, at: number, receiptId = id()): void {
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId, runId: s.runId, exit, bodyDigest: digest(`stopped:${s.runId}:${exit}`), now: at }, s.from));
}

function rows(path: string, sql: string, ...params: (string | number)[]): unknown[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query(sql).all(...params);
  } finally {
    raw.close();
  }
}

function rawWrite(path: string, sql: string, ...params: (string | number | null)[]): void {
  const raw = new Database(path);
  try {
    raw.run("PRAGMA foreign_keys = ON");
    raw.query(sql).run(...params);
  } finally {
    raw.close();
  }
}

function failAt(point: string) {
  return {
    at(reached: string) {
      if (reached === point) throw new Error(`주입한 실패: ${point}`);
    },
  };
}

function facts(ledger: Ledger, runId: string) {
  const read = ledger.failedStop(runId);
  if (!read.known) throw new Error(`읽지 못함: ${read.reason}`);
  return read.value;
}

const withoutStopColumns = (list: unknown[]): unknown[] => list.map((row) => {
  const { stop_exit: _, failed_stopped_at: __, ...rest } = row as Record<string, unknown>;
  return rest;
});

test("판 7 장부를 열어 판 8로 올리면 실행·영수증·지시 줄은 그대로이고 새 칸은 모두 NULL이다", () => {
  expect(VERSION).toBe(8);
  const path = tempPath();
  const old = ready(open(path, { migrations: BEFORE() }));
  const direct = startedWorker(old);
  stop(old, direct, "cancelled", NOW + 7);
  const queued = must(old.admitRun(worker())).run.runId;
  old.close();
  const runsBefore = rows(path, "SELECT * FROM runs ORDER BY run_id");
  const deliveriesBefore = rows(path, "SELECT * FROM deliveries ORDER BY id");
  const instructionsBefore = rows(path, "SELECT * FROM instructions ORDER BY request_id");
  expect(rows(path, "SELECT name FROM pragma_table_info('runs') WHERE name = 'stop_exit'")).toEqual([]);

  const upgraded = open(path);
  upgraded.close();
  expect(rows(path, "SELECT version, name FROM ledger_migrations WHERE version >= ? ORDER BY version", VERSION - 1)).toEqual([
    { version: VERSION - 1, name: "0007-operator-closure.sql" },
    { version: VERSION, name: FILE },
  ]);
  const runsAfter = rows(path, "SELECT * FROM runs ORDER BY run_id");
  expect(runsAfter.map((row) => (row as { stop_exit: unknown }).stop_exit)).toEqual([null, null]);
  expect(runsAfter.map((row) => (row as { failed_stopped_at: unknown }).failed_stopped_at)).toEqual([null, null]);
  expect(withoutStopColumns(runsAfter)).toEqual(runsBefore);
  expect(rows(path, "SELECT * FROM deliveries ORDER BY id")).toEqual(deliveriesBefore);
  expect(rows(path, "SELECT * FROM instructions ORDER BY request_id")).toEqual(instructionsBefore);
  expect(rows(path, "SELECT run_id, state FROM runs WHERE run_id IN (?, ?) ORDER BY state", direct.runId, queued)).toEqual([
    { run_id: direct.runId, state: "failed_stopped" },
    { run_id: queued, state: "queued" },
  ]);
});

test("판 8 이관이 커밋 전에 끊기면 판 7 장부 그대로이고(판 7까지 아는 코드로 열린다), 다시 열면 판 8을 한 번 적용한다", () => {
  const path = tempPath();
  const old = ready(open(path, { migrations: BEFORE() }));
  const s = startedWorker(old);
  stop(old, s, "failed", NOW + 7);
  old.close();
  const schema = () => rows(path, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
  const runs = () => rows(path, "SELECT * FROM runs ORDER BY run_id");
  const versions = () => rows(path, "SELECT version FROM ledger_migrations ORDER BY version");
  const schemaBefore = schema();
  const runsBefore = runs();
  const versionsBefore = versions();
  expect(versionsBefore.at(-1)).toEqual({ version: VERSION - 1 });

  // 판 하나는 트랜잭션 하나다. 판 8의 적용 기록까지 넣은 뒤 커밋 전에 끊기면 칸·트리거·적용 기록이 모두 남지 않는다.
  expect(openLedger(path, { clock, mode: "reopen", faults: failAt(`migration:${VERSION}`) })).toMatchObject({ ok: false, reason: "migration_failed" });
  expect(versions()).toEqual(versionsBefore);
  expect(schema()).toEqual(schemaBefore);
  expect(runs()).toEqual(runsBefore);
  const seven = openLedger(path, { clock, mode: "reopen", migrations: BEFORE() });
  expect(seven).toMatchObject({ ok: true, migrated: { from: VERSION - 1, to: VERSION - 1 } });
  if (seven.ok) seven.ledger.close();

  const resumed = openLedger(path, { clock, mode: "reopen" });
  expect(resumed).toMatchObject({ ok: true, migrated: { from: VERSION - 1, to: VERSION } });
  if (resumed.ok) resumed.ledger.close();
  expect(versions()).toEqual([...versionsBefore, { version: VERSION }]);
  expect(withoutStopColumns(runs())).toEqual(runsBefore);
  expect(rows(path, "SELECT state, stop_exit FROM runs WHERE run_id = ?", s.runId)).toEqual([{ state: "failed_stopped", stop_exit: null }]);
});

test("판 8 뒤 원 SQL로 exit 없이 적은 종료 확인도 모름(NULL)으로 읽히고, 취소 우선과 뒤 판정의 실패 시각으로 확정 outcome이 정해진다", () => {
  // 장부 코드는 종료 확인과 exit를 늘 함께 적는다. 원 SQL은 exit를 비운 채 종료 확인만 적을 수 있다(트리거가 막지 않는다).
  const confirmRaw = (path: string, runId: string, state: "checking" | "failed_stopped", at: number) => {
    const receiptId = id();
    rawWrite(path, "INSERT INTO deliveries (id, action, run_id, body_digest, received_at) VALUES (?, 'receipt_stopped', ?, ?, ?)", receiptId, runId, digest(`raw:${runId}`), at);
    rawWrite(path, "UPDATE runs SET state = ?, stop_receipt_id = ?, updated_at = ? WHERE run_id = ?", state, receiptId, at, runId);
  };
  const made = (setup: (ledger: Ledger, s: Started) => void, state: "checking" | "failed_stopped") => {
    const path = tempPath();
    const ledger = ready(open(path));
    const s = startedWorker(ledger);
    setup(ledger, s);
    ledger.close();
    confirmRaw(path, s.runId, state, NOW + 2);
    expect(rows(path, "SELECT state, stop_exit FROM runs WHERE run_id = ?", s.runId)).toEqual([{ state, stop_exit: null }]);
    return { ledger: ready(open(path)), s };
  };

  // 사유 requested의 취소 지시가 있으면 exit를 몰라도 cancelled다.
  const requested = made((ledger, s) => must(ledger.recordStopInstruction({ runId: s.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW + 1, reason: "requested" })), "failed_stopped");
  const requestedFacts = facts(requested.ledger, requested.s.runId);
  expect(requestedFacts).toEqual({ runId: requested.s.runId, stoppedAt: null, requestedCancel: true, exit: null });
  expect(failedOutcome(requestedFacts as NonNullable<typeof requestedFacts>)).toBe("cancelled");

  // checking에서 결과 없음으로 판정되면 그 판정이 실패 시각을 적어 exit를 completed로 읽고 failed다.
  const judged = made(() => {}, "checking");
  must(judged.ledger.markResult({ runId: judged.s.runId, resultDigest: null, now: NOW + 60_002 }));
  const judgedFacts = facts(judged.ledger, judged.s.runId);
  expect(judgedFacts).toEqual({ runId: judged.s.runId, stoppedAt: NOW + 60_002, requestedCancel: false, exit: "completed" });
  expect(failedOutcome(judgedFacts as NonNullable<typeof judgedFacts>)).toBe("failed");

  // 곧바로 failed_stopped이고 취소 지시가 없으면 cancelled였을 수 있어 정하지 않는다.
  const direct = made(() => {}, "failed_stopped");
  const directFacts = facts(direct.ledger, direct.s.runId);
  expect(directFacts).toEqual({ runId: direct.s.runId, stoppedAt: null, requestedCancel: false, exit: null });
  expect(failedOutcome(directFacts as NonNullable<typeof directFacts>)).toBeNull();
});

test("옛 줄(판 8 전에 종료 확인)의 시각·exit는 모름이다: 곧바로 failed_stopped여도, 판정 시각이 늦어도 확정 outcome을 정하지 않는다", () => {
  const directPath = tempPath();
  const a = ready(open(directPath, { migrations: BEFORE() }));
  const direct = startedWorker(a);
  stop(a, direct, "cancelled", NOW + 7);
  a.close();
  const upgradedA = ready(open(directPath));
  const directFacts = facts(upgradedA, direct.runId);
  expect(directFacts).toEqual({ runId: direct.runId, stoppedAt: null, requestedCancel: false, exit: null });
  expect(failedOutcome(directFacts as NonNullable<typeof directFacts>)).toBeNull();

  const judgedPath = tempPath();
  const b = ready(open(judgedPath, { migrations: BEFORE() }));
  const judged = startedWorker(b);
  stop(b, judged, "completed", NOW + 1);
  must(b.markResult({ runId: judged.runId, resultDigest: null, now: NOW + 60_001 }));
  b.close();
  const upgradedB = ready(open(judgedPath));
  const judgedFacts = facts(upgradedB, judged.runId);
  expect(judgedFacts).toEqual({ runId: judged.runId, stoppedAt: null, requestedCancel: false, exit: null });
  expect(failedOutcome(judgedFacts as NonNullable<typeof judgedFacts>)).toBeNull();
});

test("판 8로 올린 뒤에 받은 종료 확인은 exit를 적는다(올리기 전에 시작한 실행 포함)", () => {
  const path = tempPath();
  const old = ready(open(path, { migrations: BEFORE() }));
  const live = startedWorker(old);
  old.close();
  const upgraded = ready(open(path));
  stop(upgraded, live, "deadline", NOW + 9);
  expect(facts(upgraded, live.runId)).toEqual({ runId: live.runId, stoppedAt: NOW + 9, requestedCancel: false, exit: "deadline" });
  upgraded.close();
  expect(rows(path, "SELECT state, stop_exit FROM runs WHERE run_id = ?", live.runId)).toEqual([{ state: "failed_stopped", stop_exit: "deadline" }]);
});

test("exit 넷: 종료 확인과 같은 쓰기에서 실행 줄에 적히고 failedStop이 그대로 낸다(completed는 결과 없음 판정 뒤, 같은 밀리초 포함)", () => {
  expect([...STOP_EXITS]).toEqual(["completed", "cancelled", "deadline", "failed"]);
  for (const exit of STOP_EXITS) {
    const path = tempPath();
    const ledger = ready(open(path));
    const s = startedWorker(ledger);
    stop(ledger, s, exit, NOW + 7);
    if (exit === "completed") {
      expect(facts(ledger, s.runId)).toBeNull();
      must(ledger.markResult({ runId: s.runId, resultDigest: null, now: NOW + 7 }));
    }
    expect([exit, facts(ledger, s.runId)]).toEqual([exit, { runId: s.runId, stoppedAt: NOW + 7, requestedCancel: false, exit }]);
    ledger.close();
    expect([exit, rows(path, "SELECT state, stop_exit FROM runs WHERE run_id = ?", s.runId)]).toEqual([exit, [{ state: "failed_stopped", stop_exit: exit }]]);
  }
});

test("같은 실행의 늦은 종료 영수증(다른 ID, 다른 exit)은 적힌 exit를 바꾸지 않는다", () => {
  const ledger = ready(open(tempPath()));
  const s = startedWorker(ledger);
  const first = id();
  stop(ledger, s, "failed", NOW + 7, first);
  stop(ledger, s, "failed", NOW + 8, first);
  stop(ledger, s, "cancelled", NOW + 9);
  expect(facts(ledger, s.runId)).toEqual({ runId: s.runId, stoppedAt: NOW + 7, requestedCancel: false, exit: "failed" });
});

test("SQL이 막는 것: 적힌 exit 바꾸기·비우기, 옛 줄 채우기, 종료 확인 없는 exit, 목록 밖 값, 상태와 맞지 않는 exit", () => {
  // 판 8 전에 종료 확인을 받은 줄은 나중에 채우지 않는다: 그 줄의 상태(failed_stopped)와 맞는 값이어도 막는다.
  const legacyPath = tempPath();
  const old = ready(open(legacyPath, { migrations: BEFORE() }));
  const legacy = startedWorker(old);
  stop(old, legacy, "failed", NOW + 3);
  old.close();
  open(legacyPath).close();
  expect(() => rawWrite(legacyPath, "UPDATE runs SET stop_exit = 'failed' WHERE run_id = ?", legacy.runId)).toThrow("run_evidence_mismatch");
  expect(rows(legacyPath, "SELECT state, stop_exit FROM runs WHERE run_id = ?", legacy.runId)).toEqual([{ state: "failed_stopped", stop_exit: null }]);

  const path = tempPath();
  const ledger = ready(open(path));
  const fresh = startedWorker(ledger);
  stop(ledger, fresh, "failed", NOW + 7);
  const queued = must(ledger.admitRun(worker())).run.runId;
  ledger.close();
  // 적힌 값은 바꾸거나 비우지 못한다.
  expect(() => rawWrite(path, "UPDATE runs SET stop_exit = 'cancelled' WHERE run_id = ?", fresh.runId)).toThrow("run_evidence_mismatch");
  expect(() => rawWrite(path, "UPDATE runs SET stop_exit = NULL WHERE run_id = ?", fresh.runId)).toThrow("run_evidence_mismatch");
  // 종료 확인이 없는 줄에는 넣지 못한다.
  expect(() => rawWrite(path, "UPDATE runs SET stop_exit = 'failed' WHERE run_id = ?", queued)).toThrow("run_evidence_mismatch");
  expect(rows(path, "SELECT stop_exit FROM runs WHERE run_id = ?", fresh.runId)).toEqual([{ stop_exit: "failed" }]);
  expect(rows(path, "SELECT stop_exit FROM runs WHERE run_id = ?", queued)).toEqual([{ stop_exit: null }]);

  // 첫 종료 확인과 함께 넣을 때: 목록 밖 값, 영수증이 옮기는 상태와 맞지 않는 값은 막고, 맞는 값은 들어간다.
  const second = tempPath();
  const other = ready(open(second));
  const live = startedWorker(other);
  other.close();
  const receiptId = id();
  rawWrite(second, "INSERT INTO deliveries (id, action, run_id, body_digest, received_at) VALUES (?, 'receipt_stopped', ?, ?, ?)", receiptId, live.runId, digest("stopped"), NOW + 1);
  const confirm = "UPDATE runs SET state = ?, stop_receipt_id = ?, stop_exit = ?, updated_at = ? WHERE run_id = ?";
  expect(() => rawWrite(second, confirm, "failed_stopped", receiptId, "aborted", NOW + 1, live.runId)).toThrow("run_evidence_mismatch");
  expect(() => rawWrite(second, confirm, "failed_stopped", receiptId, "completed", NOW + 1, live.runId)).toThrow("run_evidence_mismatch");
  expect(() => rawWrite(second, confirm, "checking", receiptId, "failed", NOW + 1, live.runId)).toThrow("run_evidence_mismatch");
  expect(rows(second, "SELECT state, stop_receipt_id, stop_exit FROM runs WHERE run_id = ?", live.runId)).toEqual([{ state: "preparing", stop_receipt_id: null, stop_exit: null }]);
  rawWrite(second, confirm, "checking", receiptId, "completed", NOW + 1, live.runId);
  expect(rows(second, "SELECT state, stop_exit FROM runs WHERE run_id = ?", live.runId)).toEqual([{ state: "checking", stop_exit: "completed" }]);
});

test("SQL이 막는 것: 실패 시각 칸의 옛 줄 채우기·바꾸기·비우기, failed_stopped 밖의 값, updated_at과 다른 값, exit 없이 checking 밖에서 옮기며 적기", () => {
  // 판 8 전에 failed_stopped가 된 줄은 나중에 채우지 않는다(값이 그 줄의 updated_at이어도).
  const legacyPath = tempPath();
  const old = ready(open(legacyPath, { migrations: BEFORE() }));
  const legacy = startedWorker(old);
  stop(old, legacy, "failed", NOW + 3);
  old.close();
  open(legacyPath).close();
  expect(() => rawWrite(legacyPath, "UPDATE runs SET failed_stopped_at = updated_at WHERE run_id = ?", legacy.runId)).toThrow("run_evidence_mismatch");

  // 적힌 값은 바꾸거나 비우지 못하고, failed_stopped가 아닌 줄에는 넣지 못한다.
  const path = tempPath();
  const ledger = ready(open(path));
  const fresh = startedWorker(ledger);
  stop(ledger, fresh, "failed", NOW + 7);
  ledger.close();
  // 작업자 자리가 하나라 checking 쪽은 다른 장부에 적는다.
  const checkingPath = tempPath();
  const third = ready(open(checkingPath));
  const checking = startedWorker(third);
  stop(third, checking, "completed", NOW + 7);
  third.close();
  expect(rows(path, "SELECT failed_stopped_at FROM runs WHERE run_id = ?", fresh.runId)).toEqual([{ failed_stopped_at: NOW + 7 }]);
  expect(rows(checkingPath, "SELECT failed_stopped_at FROM runs WHERE run_id = ?", checking.runId)).toEqual([{ failed_stopped_at: null }]);
  expect(() => rawWrite(path, "UPDATE runs SET failed_stopped_at = ? WHERE run_id = ?", NOW + 8, fresh.runId)).toThrow("run_evidence_mismatch");
  expect(() => rawWrite(path, "UPDATE runs SET failed_stopped_at = NULL WHERE run_id = ?", fresh.runId)).toThrow("run_evidence_mismatch");
  expect(() => rawWrite(checkingPath, "UPDATE runs SET failed_stopped_at = updated_at WHERE run_id = ?", checking.runId)).toThrow("run_evidence_mismatch");
  // checking에서 옮길 때는 그 UPDATE의 updated_at만 들어간다.
  expect(() => rawWrite(checkingPath, "UPDATE runs SET state = 'failed_stopped', failed_stopped_at = ?, updated_at = ? WHERE run_id = ?", NOW + 8, NOW + 9, checking.runId)).toThrow("run_evidence_mismatch");
  rawWrite(checkingPath, "UPDATE runs SET state = 'failed_stopped', failed_stopped_at = ?, updated_at = ? WHERE run_id = ?", NOW + 9, NOW + 9, checking.runId);
  expect(rows(checkingPath, "SELECT state, stop_exit, failed_stopped_at FROM runs WHERE run_id = ?", checking.runId)).toEqual([{ state: "failed_stopped", stop_exit: "completed", failed_stopped_at: NOW + 9 }]);

  // 첫 종료 확인으로 곧바로 옮길 때는 exit와 함께일 때만 들어간다(그래서 exit가 빈 줄의 실패 시각은 checking에서 온 것이다).
  const second = tempPath();
  const other = ready(open(second));
  const live = startedWorker(other);
  other.close();
  const receiptId = id();
  rawWrite(second, "INSERT INTO deliveries (id, action, run_id, body_digest, received_at) VALUES (?, 'receipt_stopped', ?, ?, ?)", receiptId, live.runId, digest("stopped"), NOW + 1);
  expect(() => rawWrite(second, "UPDATE runs SET state = 'failed_stopped', stop_receipt_id = ?, failed_stopped_at = ?, updated_at = ? WHERE run_id = ?", receiptId, NOW + 1, NOW + 1, live.runId)).toThrow("run_evidence_mismatch");
  rawWrite(second, "UPDATE runs SET state = 'failed_stopped', stop_receipt_id = ?, stop_exit = 'cancelled', failed_stopped_at = ?, updated_at = ? WHERE run_id = ?", receiptId, NOW + 1, NOW + 1, live.runId);
  expect(rows(second, "SELECT state, stop_exit, failed_stopped_at FROM runs WHERE run_id = ?", live.runId)).toEqual([{ state: "failed_stopped", stop_exit: "cancelled", failed_stopped_at: NOW + 1 }]);
});

test("판 7 장부를 8로 올리면 정의가 바뀌는 것은 runs 하나, 새 객체는 트리거 둘이다. 판 8 장부는 판 7까지 아는 코드로 열지 않는다(too_new)", () => {
  const path = tempPath();
  open(path, { migrations: BEFORE() }).close();
  const objects = () => new Map((rows(path, "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL") as { name: string; sql: string }[]).map((o) => [o.name, o.sql]));
  const seven = objects();
  open(path).close();
  const eight = objects();
  expect([...seven].filter(([name, sql]) => eight.get(name) !== sql).map(([name]) => name)).toEqual(["runs"]);
  expect([...eight.keys()].filter((name) => !seven.has(name))).toEqual(["runs_stop_exit_fixed", "runs_failed_stopped_at_fixed"]);
  expect(rows(path, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  expect(openLedger(path, { clock, mode: "reopen", migrations: BEFORE() })).toMatchObject({ ok: false, reason: "too_new" });
});

test("장부 초기화 진입점이 만든 장부는 판 8까지 적용했고 exit 칸이 있다", () => {
  const dir = tempDir();
  const result = initLedger([], { [LEDGER_DIR_ENV]: dir }, { openLedger, wallNow: () => NOW });
  expect(result.code).toBe(LEDGER_INIT_EXIT.created);
  const path = `${dir}/${LEDGER_FILE}`;
  expect(rows(path, "SELECT max(version) AS version FROM ledger_migrations")).toEqual([{ version: loadMigrations().length }]);
  expect(rows(path, "SELECT name FROM ledger_migrations WHERE version = ?", VERSION)).toEqual([{ name: FILE }]);
  expect(rows(path, "SELECT name, type FROM pragma_table_info('runs') WHERE name IN ('stop_exit', 'failed_stopped_at') ORDER BY name")).toEqual([
    { name: "failed_stopped_at", type: "INTEGER" },
    { name: "stop_exit", type: "TEXT" },
  ]);
  const reopened = ready(open(path));
  const s = startedWorker(reopened);
  stop(reopened, s, "cancelled", NOW + 2);
  expect(facts(reopened, s.runId)).toEqual({ runId: s.runId, stoppedAt: NOW + 2, requestedCancel: false, exit: "cancelled" });
});
