// D-90: 실행기가 받은 적 없는 작업자 실행의 닫기(판 0006-unreceived-closure). 송신 표식, 한 트랜잭션의 닫기, 근거 없는 not_started의 차단,
// 닫힌 실행의 늦은 영수증·보고. 실제 장부 파일에 적고, 공개 읽기와 원 SQL로 본다. 닫은 뒤의 수명은 실제 판단(nextIntent)을 불러 본다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { limits, type RunStatus } from "../../src/contract/v1/index.ts";
import { type Ledger, LEDGER_RUN_STATES, loadMigrations, MIGRATIONS_DIR, openLedger, type Refusal, type UnreceivedClosureInput } from "../../src/ledger/index.ts";
import { RESTORE_KEY, type SlotHoldObservation } from "../../src/ledger/ledger.ts";
import { type LifecyclePolicy, nextIntent } from "../../src/supervisor/scheduler/lifecycle.ts";
import { clock, digest, id, must, NOW, open, ready, SESSION_EXECUTOR, session, startedWorker, tempDir, tempPath, WORKER_EXECUTOR, worker } from "./helpers.ts";

// ID·digest·시각은 이 시험이 고른 값이다. 운영값이 아니다. 시험의 장부 시계는 늘 NOW라 시작 지시의 발행 시각도 NOW다.
const FILE = "0006-unreceived-closure.sql";
const VERSION = loadMigrations().findIndex((m) => m.name === FILE) + 1;
const SHUT = NOW + 30_000;
const OTHER_EXECUTOR = "executor/diagnosis/1/store-b";
const LIFE: LifecyclePolicy = { renewEveryMs: limits.RENEW_INTERVAL_MS, answerTimeoutMs: 30_000 };

function close(ledger: Ledger, runId: string, extra: Partial<UnreceivedClosureInput> = {}, sender = WORKER_EXECUTOR) {
  return ledger.closeUnreceivedRun({ runId, runs: [], answeredAt: SHUT, receivedAt: SHUT + 5, now: SHUT + 10, ...extra }, { sender });
}

function run(ledger: Ledger, runId: string) {
  const read = ledger.getRun(runId);
  if (!read.known || read.value === null) throw new Error("실행 없음");
  return read.value;
}

function slotFree(ledger: Ledger) {
  const read = ledger.slotFree("worker");
  if (!read.known) throw new Error("읽지 못함");
  return read.value;
}

function rows(path: string, sql: string, ...params: (string | number)[]): unknown[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query(sql).all(...params);
  } finally {
    raw.close();
  }
}

// 장부 객체를 닫은 뒤 파일에 코드를 거치지 않고 직접 쓴다(트리거만으로 막히는지 보는 시험).
function rawWrite(path: string, sql: string, ...params: (string | number)[]): void {
  const raw = new Database(path);
  try {
    raw.run("PRAGMA foreign_keys = ON");
    raw.query(sql).run(...params);
  } finally {
    raw.close();
  }
}

function accepted(started: { runId: string; requestId: string }) {
  return { action: "receipt_accepted" as const, receiptId: id(), runId: started.runId, instructionRequestId: started.requestId, instruction: "task_start" as const, bodyDigest: digest("accepted"), now: SHUT + 20 };
}

function startedReceipt(started: { runId: string; requestId: string }, receiptId = id()) {
  return { action: "receipt_started" as const, receiptId, runId: started.runId, instructionRequestId: started.requestId, bodyDigest: digest("started"), now: SHUT + 20 };
}

function stoppedReceipt(runId: string) {
  return { action: "receipt_stopped" as const, receiptId: id(), runId, exit: "cancelled" as const, bodyDigest: digest("stopped"), now: SHUT + 20 };
}

function resultReport(runId: string) {
  return { reportId: id(), action: "report_result" as const, runId, bodyDigest: digest("result"), storedRef: `results/${id()}`, resultDigest: digest("r"), now: SHUT + 20 };
}

// 경계 트리거를 같은 정의로 지웠다 다시 만들며 그 사이에 그 사본 기록의 경계 줄(지금의 순번 최댓값)을 넣는다. 스키마는 그대로라
// 장부가 다시 열린다. 경계 트리거가 뚫린 장부에서도 코드와 근거 트리거가 따로 막는지 본다.
function bypassBound(path: string, snapshotId: string): void {
  const raw = new Database(path);
  try {
    raw.run("PRAGMA foreign_keys = ON");
    const sealed = (raw.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'snapshot_run_bounds_sealed'").get() as { sql: string }).sql;
    raw.transaction(() => {
      raw.run("DROP TRIGGER snapshot_run_bounds_sealed");
      raw.query("INSERT INTO snapshot_run_bounds (snapshot_id, queue_seq_bound) VALUES (?, (SELECT COALESCE(MAX(queue_seq), 0) FROM runs))").run(snapshotId);
      raw.run(sealed);
    })();
  } finally {
    raw.close();
  }
}

// 코드를 거치지 않고 넣는 닫기 근거 줄(답의 시각, 열기 'o'). 트리거만으로 막히는지 본다.
const RAW_CLOSURE = "INSERT INTO unreceived_closures (run_id, from_state, answer_executor_id, answer_issued_at, answer_received_at, open_id, closed_at) VALUES (?, 'preparing', ?, ?, 1, 'o', 1)";

// 시험의 고정 시계(NOW)와 다른 시각에 실행을 만들고 시작한다. 실행 생성·시작 발행 = at.
function startedAt(ledger: Ledger, at: number) {
  const runId = must(ledger.admitRun(worker({ now: at }))).run.runId;
  const requestId = id();
  must(ledger.startRun({ runId, requestId, stopGeneration: 0, now: at }));
  return { runId, requestId };
}

// ---- 보장 1: 송신 표식 ----

test("보장 1: 표식은 지금 열기 ID와 함께 커밋되고, 같은 열기의 같은 표식은 그대로이며, 다시 열면 열기 ID가 달라진다", () => {
  const path = tempPath();
  const first = ready(open(path));
  const live = startedWorker(first);
  expect(first.markStartDispatch({ runId: live.runId, requestId: live.requestId, now: NOW + 1 })).toEqual({ ok: true, created: true });
  expect(first.markStartDispatch({ runId: live.runId, requestId: live.requestId, now: NOW + 2 })).toEqual({ ok: true, created: false });
  first.close();
  const second = ready(open(path));
  expect(second.markStartDispatch({ runId: live.runId, requestId: live.requestId, now: NOW + 3 })).toEqual({ ok: true, created: true });
  second.close();
  const marks = rows(path, "SELECT request_id, open_id, marked_at FROM start_dispatches WHERE run_id = ? ORDER BY marked_at", live.runId) as { request_id: string; open_id: string; marked_at: number }[];
  expect(marks.map((mark) => [mark.request_id, mark.marked_at])).toEqual([
    [live.requestId, NOW + 1],
    [live.requestId, NOW + 3],
  ]);
  expect(marks[0]?.open_id).not.toBe(marks[1]?.open_id);
  for (const mark of marks) expect(mark.open_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("보장 1: 시작 지시가 아니거나 다른 요청 ID, 없는 실행, 끝난 실행, 새 일을 열 수 없는 장부에는 표식을 적지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  expect(ledger.markStartDispatch({ runId: live.runId, requestId: id(), now: NOW })).toEqual({ ok: false, reason: "unknown_instruction" });
  expect(ledger.markStartDispatch({ runId: id(), requestId: live.requestId, now: NOW })).toEqual({ ok: false, reason: "unknown_run" });
  const queued = must(ledger.admitRun(worker())).run.runId;
  expect(ledger.markStartDispatch({ runId: queued, requestId: live.requestId, now: NOW })).toEqual({ ok: false, reason: "unknown_instruction" });
  must(ledger.applyStop({ generation: 0, stopped: true, now: NOW }));
  expect(ledger.markStartDispatch({ runId: live.runId, requestId: live.requestId, now: NOW })).toEqual({ ok: false, reason: "stopped" });
  ledger.close();
  expect(rows(path, "SELECT count(*) AS n FROM start_dispatches")).toEqual([{ n: 0 }]);
  // 트리거: 시작 지시가 아닌 줄을 가리키는 표식, 고치기, 지우기, 같은 (실행, 열기)의 교체.
  expect(() => rawWrite(path, "INSERT INTO start_dispatches (run_id, request_id, open_id, marked_at) VALUES (?, ?, 'x', 1)", queued, live.requestId)).toThrow("start_dispatch_fixed");
  rawWrite(path, "INSERT INTO start_dispatches (run_id, request_id, open_id, marked_at) VALUES (?, ?, 'x', 1)", live.runId, live.requestId);
  expect(() => rawWrite(path, "INSERT OR REPLACE INTO start_dispatches (run_id, request_id, open_id, marked_at) VALUES (?, ?, 'x', 2)", live.runId, live.requestId)).toThrow("start_dispatch_fixed");
  expect(() => rawWrite(path, "UPDATE start_dispatches SET open_id = 'y'")).toThrow("start_dispatch_fixed");
  expect(() => rawWrite(path, "DELETE FROM start_dispatches")).toThrow("start_dispatch_fixed");
});

// ---- 보장 2·3: 닫기 ----

test("보장 2·3: 표식이 없는 preparing 실행은 시한 정각의 전체 답으로 닫히고, 근거 줄과 not_started가 한 커밋이며, 자리가 풀리고 같은 실행 ID는 다시 시작하지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  const other = { run_id: id(), state: "running", run_generation: 1, last_receipt_id: null } as RunStatus;
  expect(slotFree(ledger)).toBe(false);
  const closed = must(close(ledger, live.runId, { runs: [other] }));
  expect(closed.run).toMatchObject({ runId: live.runId, state: "not_started", acceptedReceiptId: null, startedReceiptId: null, stopReceiptId: null });
  expect(slotFree(ledger)).toBe(true);
  expect(ledger.startRun({ runId: live.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "transition_denied" });
  expect(ledger.markStartDispatch({ runId: live.runId, requestId: live.requestId, now: NOW })).toEqual({ ok: false, reason: "transition_denied" });
  const unanswered = ledger.unansweredInstructions();
  expect(unanswered.known && unanswered.value.instructions.map((i) => i.runId)).toEqual([]);
  // 같은 종류의 새 실행이 자리를 잡는다.
  const next = must(ledger.admitRun(worker())).run.runId;
  expect(ledger.startRun({ runId: next, requestId: id(), stopGeneration: 0, now: NOW })).toMatchObject({ ok: true, run: { state: "preparing" } });
  // 닫힌 실행에 수명 판단은 새 의도를 내지 않는다.
  const view = { run: { runId: live.runId, kind: "worker" as const, state: run(ledger, live.runId).state, deadlineAt: NOW + 600_000 }, lease: null, lastInstructionAt: null, resultSettled: false, now: SHUT };
  for (const cancelRequested of [false, true]) expect(nextIntent({ ...view, cancelRequested }, LIFE)).toEqual({ intent: "wait", runId: live.runId, toward: "not_started" });
  ledger.close();
  expect(rows(path, "SELECT run_id, from_state, answer_executor_id, answer_issued_at, answer_received_at, closed_at FROM unreceived_closures")).toEqual([
    { run_id: live.runId, from_state: "preparing", answer_executor_id: WORKER_EXECUTOR, answer_issued_at: SHUT, answer_received_at: SHUT + 5, closed_at: SHUT + 10 },
  ]);
  // 다시 연 장부에서도 그대로다(커밋됨).
  const again = open(path);
  expect(run(again, live.runId).state).toBe("not_started");
});

test("보장 2: unknown_running 실행과 지금 열기의 표식만 있는 실행은 닫힌다", () => {
  const ledger = ready(open(tempPath()));
  const lost = startedWorker(ledger);
  must(ledger.markStartDispatch({ runId: lost.runId, requestId: lost.requestId, now: NOW }));
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  expect(run(ledger, lost.runId).state).toBe("unknown_running");
  expect(must(close(ledger, lost.runId)).run.state).toBe("not_started");
});

test("보장 2: 조건마다 구별된 거절이고 상태와 자리는 그대로다", () => {
  let failRead = false;
  const path = tempPath();
  const ledger = ready(
    open(path, {
      faults: {
        at(point) {
          if (failRead && point === "read") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
        },
      },
    }),
  );
  const live = startedWorker(ledger);
  const refused = (expected: Refusal, extra: Partial<UnreceivedClosureInput> = {}, sender = WORKER_EXECUTOR, runId = live.runId) => {
    expect(close(ledger, runId, extra, sender), expected).toEqual({ ok: false, reason: expected });
    expect(run(ledger, live.runId).state, expected).toBe("preparing");
    expect(slotFree(ledger), expected).toBe(false);
  };
  refused("unknown_run", {}, WORKER_EXECUTOR, id());
  refused("sender_mismatch", {}, OTHER_EXECUTOR);
  refused("answer_time_unknown", { answeredAt: null });
  refused("answer_too_early", { answeredAt: SHUT - 1 });
  refused("run_in_answer", { runs: [{ run_id: live.runId, state: "not_known", run_generation: null, last_receipt_id: null }] });
  refused("run_in_answer", { runs: [{ run_id: live.runId, state: "preparing", run_generation: 1, last_receipt_id: null }] });
  // 대기 실행·세션 실행의 시작은 이 연산의 대상이 아니다.
  const queued = must(ledger.admitRun(worker())).run.runId;
  expect(close(ledger, queued)).toEqual({ ok: false, reason: "transition_denied" });
  // 새 일을 열 수 없는 장부: 접수가 닫힘, 정지.
  ledger.beginRestore(RESTORE_KEY);
  refused("intake_closed");
  ready(ledger);
  must(ledger.applyStop({ generation: 0, stopped: true, now: NOW }));
  refused("stopped");
  // 읽기가 한 번 실패한 장부는 다시 열 때까지 닫지 않는다.
  failRead = true;
  expect(ledger.getRun(live.runId)).toEqual({ known: false, reason: "io" });
  failRead = false;
  expect(close(ledger, live.runId)).toEqual({ ok: false, reason: "ledger_unwritable" });
  expect(run(ledger, live.runId).state).toBe("preparing");
});

test("보장 2: 받았다는 흔적(영수증·보고, 양성 관측, 점유 관측)이 하나라도 있으면 닫지 않는다", () => {
  const ledger = ready(open(tempPath()));
  const withReceipt = startedWorker(ledger);
  must(ledger.applyReceipt(accepted(withReceipt), withReceipt.from));
  expect(close(ledger, withReceipt.runId)).toEqual({ ok: false, reason: "receipt_seen" });
  expect(run(ledger, withReceipt.runId).state).toBe("preparing");

  const ledger2 = ready(open(tempPath()));
  const sighted = startedWorker(ledger2);
  must(ledger2.applyExecutorAnswer({ coverage: "partial", runs: [{ run_id: sighted.runId, state: "preparing", run_generation: 1, last_receipt_id: null }], answeredAt: NOW + 1, now: NOW + 1 }, { sender: WORKER_EXECUTOR }));
  expect(close(ledger2, sighted.runId)).toEqual({ ok: false, reason: "run_sighted" });
  expect(run(ledger2, sighted.runId).state).toBe("preparing");

  const ledger3 = ready(open(tempPath()));
  const held = startedWorker(ledger3);
  must(ledger3.holdSlots(RESTORE_KEY, [{ executorId: WORKER_EXECUTOR, runId: held.runId, kind: "worker", runGeneration: 1, holdsSlot: false, why: "state" }], NOW));
  expect(close(ledger3, held.runId)).toEqual({ ok: false, reason: "run_blocked" });
  expect(run(ledger3, held.runId).state).toBe("preparing");
});

test("보장 2: 다른 열기의 송신 표식이 있으면 닫지 않는다(실은 뒤 감독이 다시 뜬 실행)", () => {
  const path = tempPath();
  const first = ready(open(path));
  const live = startedWorker(first);
  must(first.markStartDispatch({ runId: live.runId, requestId: live.requestId, now: NOW }));
  first.close();
  const second = ready(open(path));
  expect(close(second, live.runId)).toEqual({ ok: false, reason: "sent_by_other_open" });
  // 지금 열기의 표식을 더해도 다른 열기의 표식이 남아 있으면 그대로다.
  must(second.markStartDispatch({ runId: live.runId, requestId: live.requestId, now: NOW }));
  expect(close(second, live.runId)).toEqual({ ok: false, reason: "sent_by_other_open" });
  expect(run(second, live.runId).state).toBe("preparing");
});

test("보장 2: 이 판을 적용하기 전에 시작한 실행은 닫지 않는다", () => {
  const path = tempPath();
  const before = ready(open(path, { migrations: loadMigrations().slice(0, VERSION - 1) }));
  const live = startedWorker(before);
  before.close();
  const after = ready(open(path, { clock: () => NOW + 1 }));
  expect(close(after, live.runId)).toEqual({ ok: false, reason: "started_before_migration" });
  expect(run(after, live.runId).state).toBe("preparing");
});

test("보장 2: 사본에서 되살린 장부는 보류 중에 닫지 않고, 대조 뒤에도 사본 시각 이전의 실행은 닫지 않는다", () => {
  const dir = tempDir();
  const original = ready(open(join(dir, "ledger.db")));
  const live = startedWorker(original);
  const snapshot = original.createSnapshot({ path: join(dir, "copy.db"), maxBytes: 10_000_000 });
  if (!snapshot.ok) throw new Error(`사본: ${snapshot.reason}`);
  original.close();
  const copy = open(join(dir, "copy.db"));
  expect(close(copy, live.runId)).toEqual({ ok: false, reason: "snapshot_hold" });
  must(copy.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW }));
  ready(copy);
  expect(close(copy, live.runId)).toEqual({ ok: false, reason: "created_before_snapshot" });
  expect(run(copy, live.runId).state).toBe("preparing");
});

test("사본의 경계: 사본을 만들 때 시계가 1ms 뒤로 가도, 원본에서 끝까지 간 사본 안의 실행은 되살린 장부에서 닫지 않는다(코드와 트리거)", () => {
  const dir = tempDir();
  const copyPath = join(dir, "copy.db");
  let now = NOW;
  const original = ready(open(join(dir, "ledger.db"), { clock: () => now }));
  const live = startedWorker(original);
  now = NOW - 1;
  const snapshot = original.createSnapshot({ path: copyPath, maxBytes: 10_000_000 });
  if (!snapshot.ok) throw new Error(`사본: ${snapshot.reason}`);
  expect(snapshot.takenAt).toBe(NOW - 1);
  now = NOW;
  // 원본에서는 표식을 적고 실었고, 실행기가 받아 띄우고 끝냈다. 사본에는 이 기록이 하나도 없다.
  must(original.markStartDispatch({ runId: live.runId, requestId: live.requestId, now: NOW }));
  must(original.applyReceipt(accepted(live), live.from));
  must(original.applyReceipt(startedReceipt(live), live.from));
  must(original.applyReceipt({ ...stoppedReceipt(live.runId), exit: "completed" }, live.from));
  original.close();
  expect(rows(copyPath, "SELECT snapshot_id, queue_seq_bound FROM snapshot_run_bounds")).toEqual([{ snapshot_id: snapshot.snapshotId, queue_seq_bound: 1 }]);
  expect(rows(copyPath, "SELECT (SELECT count(*) FROM deliveries) + (SELECT count(*) FROM start_dispatches) AS n")).toEqual([{ n: 0 }]);
  const copy = open(copyPath);
  must(copy.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW }));
  ready(copy);
  expect(close(copy, live.runId)).toEqual({ ok: false, reason: "created_before_snapshot" });
  expect(run(copy, live.runId).state).toBe("preparing");
  expect(slotFree(copy)).toBe(false);
  copy.close();
  expect(() => rawWrite(copyPath, RAW_CLOSURE, live.runId, WORKER_EXECUTOR, SHUT)).toThrow("unreceived_closure_unproven");
  // 경계는 고치거나 지우거나 대조가 끝난 사본 기록에 다시 붙이지 못한다.
  expect(() => rawWrite(copyPath, "UPDATE snapshot_run_bounds SET queue_seq_bound = 0")).toThrow("snapshot_bound_fixed");
  expect(() => rawWrite(copyPath, "DELETE FROM snapshot_run_bounds")).toThrow("snapshot_bound_fixed");
  expect(() => rawWrite(copyPath, "INSERT OR REPLACE INTO snapshot_run_bounds (snapshot_id, queue_seq_bound) VALUES (?, 0)", snapshot.snapshotId)).toThrow("snapshot_bound_fixed");
  expect(rows(copyPath, "SELECT queue_seq_bound FROM snapshot_run_bounds")).toEqual([{ queue_seq_bound: 1 }]);
});

test("사본의 경계: 적고 보내기 전에 죽은 실행은 사본이 없으면, 또는 되살린 장부가 사본 뒤에 만든 실행이면 닫힌다", () => {
  // 사본 없음: 시작을 적고(표식 없음) 장부 객체를 닫아 감독이 죽은 것을 대신한다. 다시 연 장부가 닫는다.
  const plainPath = tempPath();
  const first = ready(open(plainPath));
  const plain = startedWorker(first);
  first.close();
  const reopened = ready(open(plainPath));
  expect(close(reopened, plain.runId)).toMatchObject({ ok: true, run: { state: "not_started" } });

  // 사본 뒤에 만든 실행: 사본에는 대기 실행 하나(순번 1)만 있다. 되살린 장부의 새 실행은 순번 2라 경계 밖이다.
  const dir = tempDir();
  const copyPath = join(dir, "copy.db");
  const original = ready(open(join(dir, "ledger.db")));
  const inCopy = must(original.admitRun(worker())).run.runId;
  const snapshot = original.createSnapshot({ path: copyPath, maxBytes: 10_000_000 });
  if (!snapshot.ok) throw new Error(`사본: ${snapshot.reason}`);
  original.close();
  // 되살린 장부의 시계는 사본 시각 뒤다(시작 지시의 발행 시각은 장부 시계에서 온다).
  const later = { clock: () => NOW + 1 };
  const restored = open(copyPath, later);
  must(restored.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW + 1 }));
  ready(restored);
  const fresh = startedAt(restored, NOW + 1);
  restored.close();
  // 판 6에서 봉한 사본은 경계가 함께 적히고, 판 6 전의 사본 기록은 없다.
  expect(rows(copyPath, "SELECT snapshot_id, queue_seq_bound FROM snapshot_run_bounds")).toEqual([{ snapshot_id: snapshot.snapshotId, queue_seq_bound: 1 }]);
  expect(rows(copyPath, "SELECT count(*) AS n FROM snapshots_before_closure")).toEqual([{ n: 0 }]);
  const again = ready(open(copyPath, later));
  expect(close(again, fresh.runId, { answeredAt: SHUT + 1 })).toMatchObject({ ok: true, run: { state: "not_started" } });
  // 사본에 대기로 들어 있던 실행은 되살린 장부에서 시작해도 경계 안이라 닫지 않는다.
  must(again.startRun({ runId: inCopy, requestId: id(), stopGeneration: 0, now: NOW + 1 }));
  expect(close(again, inCopy, { answeredAt: SHUT + 1 })).toEqual({ ok: false, reason: "created_before_snapshot" });
});

test("사본 시각의 같은 밀리초: 시계가 뒤로 가지 않아도 사본과 같은 밀리초에 만들거나 발행한 새 실행은 경계 밖이어도 닫지 않고, 기다려도 그대로다(코드와 트리거)", () => {
  // 대기 실행 하나(순번 1)가 든 사본을 NOW에 만들고, 되살린 장부를 대조까지 마쳐 연다. 되살린 장부의 새 실행은 순번 2라 경계 밖이다.
  function restored(clock: () => number) {
    const dir = tempDir();
    const copyPath = join(dir, "copy.db");
    const original = ready(open(join(dir, "ledger.db")));
    must(original.admitRun(worker()));
    const snapshot = original.createSnapshot({ path: copyPath, maxBytes: 10_000_000 });
    if (!snapshot.ok) throw new Error(`사본: ${snapshot.reason}`);
    expect(snapshot.takenAt).toBe(NOW);
    original.close();
    const copy = open(copyPath, { clock });
    must(copy.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW }));
    return { copy: ready(copy), copyPath };
  }

  // 생성(접수 때 넘긴 시각)과 발행(장부 시계)이 모두 사본 시각과 같다.
  const same = restored(clock);
  const tied = startedAt(same.copy, NOW);
  expect(run(same.copy, tied.runId).queueSeq).toBe(2);
  expect(close(same.copy, tied.runId)).toEqual({ ok: false, reason: "created_before_snapshot" });
  expect(close(same.copy, tied.runId, { answeredAt: SHUT + 3_600_000, receivedAt: SHUT + 3_600_000, now: SHUT + 3_600_000 })).toEqual({ ok: false, reason: "created_before_snapshot" });
  expect(run(same.copy, tied.runId).state).toBe("preparing");
  expect(slotFree(same.copy)).toBe(false);
  same.copy.close();
  expect(() => rawWrite(same.copyPath, RAW_CLOSURE, tied.runId, WORKER_EXECUTOR, SHUT)).toThrow("unreceived_closure_unproven");

  // 생성만 사본 시각과 같고 발행은 2ms 뒤다.
  const later = restored(() => NOW + 2);
  const createdTied = must(later.copy.admitRun(worker({ now: NOW }))).run.runId;
  must(later.copy.startRun({ runId: createdTied, requestId: id(), stopGeneration: 0, now: NOW + 2 }));
  expect(close(later.copy, createdTied, { answeredAt: SHUT + 2 })).toEqual({ ok: false, reason: "created_before_snapshot" });
  expect(run(later.copy, createdTied).state).toBe("preparing");
  later.copy.close();
  expect(() => rawWrite(later.copyPath, RAW_CLOSURE, createdTied, WORKER_EXECUTOR, SHUT + 2)).toThrow("unreceived_closure_unproven");

  // 발행만 사본 시각과 같다: 부르는 쪽이 넘긴 생성 시각은 2ms 뒤이고, 장부 시계(NOW)가 적은 발행 시각만 사본 시각과 같다.
  const issued = restored(clock);
  const issuedTied = must(issued.copy.admitRun(worker({ now: NOW + 2 }))).run.runId;
  must(issued.copy.startRun({ runId: issuedTied, requestId: id(), stopGeneration: 0, now: NOW + 2 }));
  expect(close(issued.copy, issuedTied, { answeredAt: SHUT + 2 })).toEqual({ ok: false, reason: "created_before_snapshot" });
  expect(run(issued.copy, issuedTied).state).toBe("preparing");
  expect(slotFree(issued.copy)).toBe(false);
  issued.copy.close();
  expect(rows(issued.copyPath, "SELECT r.queue_seq, r.created_at, i.issued_at FROM runs r JOIN instructions i ON i.run_id = r.run_id AND i.action = 'task_start' WHERE r.run_id = ?", issuedTied)).toEqual([
    { queue_seq: 2, created_at: NOW + 2, issued_at: NOW },
  ]);
  expect(() => rawWrite(issued.copyPath, RAW_CLOSURE, issuedTied, WORKER_EXECUTOR, SHUT + 2)).toThrow("unreceived_closure_unproven");
});

test("사본의 경계: 경계가 없는 사본 기록(판 6 전에 만든 사본)이 있는 장부에서는 사본 뒤에 만든 실행도 닫지 않는다(코드와 트리거)", () => {
  const dir = tempDir();
  const copyPath = join(dir, "copy.db");
  const before = ready(open(join(dir, "ledger.db"), { migrations: loadMigrations().slice(0, VERSION - 1) }));
  const snapshot = before.createSnapshot({ path: copyPath, maxBytes: 10_000_000 });
  if (!snapshot.ok) throw new Error(`사본: ${snapshot.reason}`);
  before.close();
  // 시계는 사본 시각 뒤다: 시각의 비교로는 이 실행을 사본 뒤의 것으로 읽는다.
  const copy = open(copyPath, { clock: () => NOW + 1 });
  must(copy.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW + 1 }));
  ready(copy);
  const fresh = startedAt(copy, NOW + 1);
  expect(close(copy, fresh.runId, { answeredAt: SHUT + 1 })).toEqual({ ok: false, reason: "snapshot_bound_unknown" });
  expect(run(copy, fresh.runId).state).toBe("preparing");
  copy.close();
  expect(rows(copyPath, "SELECT count(*) AS n FROM snapshot_run_bounds")).toEqual([{ n: 0 }]);
  expect(() => rawWrite(copyPath, RAW_CLOSURE, fresh.runId, WORKER_EXECUTOR, SHUT + 1)).toThrow("unreceived_closure_unproven");
  // 대조가 끝난 옛 사본 기록에 경계를 뒤에 붙여 "모름"을 값으로 바꾸지 못한다.
  expect(() => rawWrite(copyPath, "INSERT INTO snapshot_run_bounds (snapshot_id, queue_seq_bound) VALUES (?, 1)", snapshot.snapshotId)).toThrow("snapshot_bound_fixed");
});

test("사본의 경계: 판 6 전의 사본 기록은 대조 전에도 경계를 받지 않고, 그 기록이 있는 장부는 경계가 붙어도 자동으로 닫지 않는다(코드와 트리거)", () => {
  const dir = tempDir();
  const copyPath = join(dir, "copy.db");
  const before = ready(open(join(dir, "ledger.db"), { migrations: loadMigrations().slice(0, VERSION - 1) }));
  const snapshot = before.createSnapshot({ path: copyPath, maxBytes: 10_000_000 });
  if (!snapshot.ok) throw new Error(`사본: ${snapshot.reason}`);
  before.close();
  // 판 6으로 올리기만 하고 대조 전에 닫는다. 그 사본 기록은 가장 최근의 대조 안 된 기록이라 새 사본을 봉하는 순간과 행이 같다.
  open(copyPath).close();
  expect(rows(copyPath, "SELECT reconciled_at FROM ledger_snapshots")).toEqual([{ reconciled_at: null }]);
  expect(rows(copyPath, "SELECT snapshot_id FROM snapshots_before_closure")).toEqual([{ snapshot_id: snapshot.snapshotId }]);
  expect(() => rawWrite(copyPath, "INSERT INTO snapshot_run_bounds (snapshot_id, queue_seq_bound) VALUES (?, (SELECT COALESCE(MAX(queue_seq), 0) FROM runs))", snapshot.snapshotId)).toThrow(
    "snapshot_bound_fixed",
  );
  expect(rows(copyPath, "SELECT count(*) AS n FROM snapshot_run_bounds")).toEqual([{ n: 0 }]);
  // 그 집합은 판의 트랜잭션 뒤로는 늘거나 바뀌거나 줄지 않는다.
  expect(() => rawWrite(copyPath, "INSERT INTO snapshots_before_closure (snapshot_id) VALUES (?)", snapshot.snapshotId)).toThrow("snapshots_before_closure_fixed");
  expect(() => rawWrite(copyPath, "UPDATE snapshots_before_closure SET snapshot_id = snapshot_id")).toThrow("snapshots_before_closure_fixed");
  expect(() => rawWrite(copyPath, "DELETE FROM snapshots_before_closure")).toThrow("snapshots_before_closure_fixed");

  // 경계 트리거가 뚫려 그 기록에 경계가 붙어도, 집합에 줄이 있으면 코드와 근거 트리거가 따로 막는다.
  bypassBound(copyPath, snapshot.snapshotId);
  expect(rows(copyPath, "SELECT queue_seq_bound FROM snapshot_run_bounds")).toEqual([{ queue_seq_bound: 0 }]);
  const copy = open(copyPath, { clock: () => NOW + 1 });
  must(copy.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW + 1 }));
  ready(copy);
  const fresh = startedAt(copy, NOW + 1);
  expect(close(copy, fresh.runId, { answeredAt: SHUT + 1 })).toEqual({ ok: false, reason: "snapshot_bound_unknown" });
  expect(run(copy, fresh.runId).state).toBe("preparing");
  expect(slotFree(copy)).toBe(false);
  copy.close();
  expect(() => rawWrite(copyPath, RAW_CLOSURE, fresh.runId, WORKER_EXECUTOR, SHUT + 1)).toThrow("unreceived_closure_unproven");
  expect(rows(copyPath, "SELECT count(*) AS n FROM unreceived_closures")).toEqual([{ n: 0 }]);
});

test("판 이전의 시작: 판 5에서 낸 시작은 판 6의 적용과 같은 밀리초여도 닫지 않는다(코드와 트리거)", () => {
  const path = tempPath();
  const before = ready(open(path, { migrations: loadMigrations().slice(0, VERSION - 1) }));
  const old = startedWorker(before);
  before.close();
  const after = ready(open(path));
  expect(close(after, old.runId)).toEqual({ ok: false, reason: "started_before_migration" });
  expect(run(after, old.runId).state).toBe("preparing");
  after.close();
  expect(rows(path, "SELECT applied_at FROM ledger_migrations WHERE version = ?", VERSION)).toEqual([{ applied_at: NOW }]);
  expect(rows(path, "SELECT issued_at FROM instructions WHERE request_id = ?", old.requestId)).toEqual([{ issued_at: NOW }]);
  expect(rows(path, "SELECT run_id, request_id FROM starts_before_closure")).toEqual([{ run_id: old.runId, request_id: old.requestId }]);
  expect(() => rawWrite(path, RAW_CLOSURE, old.runId, WORKER_EXECUTOR, SHUT)).toThrow("unreceived_closure_unproven");
  // 그 집합은 판의 트랜잭션 뒤로는 늘거나 바뀌거나 줄지 않는다.
  expect(() => rawWrite(path, "INSERT INTO starts_before_closure (run_id, request_id) VALUES (?, ?)", old.runId, old.requestId)).toThrow("starts_before_closure_fixed");
  expect(() => rawWrite(path, "UPDATE starts_before_closure SET request_id = request_id")).toThrow("starts_before_closure_fixed");
  expect(() => rawWrite(path, "DELETE FROM starts_before_closure")).toThrow("starts_before_closure_fixed");
});

test("판 이전의 시작: 판 6을 적용한 뒤 새로 낸 시작은 적용과 같은 밀리초여도 닫히고, 처음부터 판 6인 장부의 집합은 비어 있다", () => {
  const path = tempPath();
  const before = ready(open(path, { migrations: loadMigrations().slice(0, VERSION - 1) }));
  const waiting = must(before.admitRun(worker())).run.runId;
  before.close();
  const after = ready(open(path));
  const requestId = id();
  must(after.startRun({ runId: waiting, requestId, stopGeneration: 0, now: NOW }));
  expect(close(after, waiting)).toMatchObject({ ok: true, run: { state: "not_started" } });
  after.close();
  // 적용 시각 쪽은 같은 밀리초를 받는다: 발행 = 적용 = NOW.
  expect(rows(path, "SELECT issued_at FROM instructions WHERE request_id = ?", requestId)).toEqual([{ issued_at: NOW }]);
  expect(rows(path, "SELECT applied_at FROM ledger_migrations WHERE version = ?", VERSION)).toEqual([{ applied_at: NOW }]);
  expect(rows(path, "SELECT count(*) AS n FROM starts_before_closure")).toEqual([{ n: 0 }]);
  const fresh = tempPath();
  const created = ready(open(fresh));
  startedWorker(created);
  created.close();
  expect(rows(fresh, "SELECT count(*) AS n FROM starts_before_closure")).toEqual([{ n: 0 }]);
});

test("예산: 시작 뒤 감액이 적힌 실행은 닫지 않고(코드와 트리거), 시작 전에 줄인 예산은 막지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  must(ledger.recordBudget({ runId: live.runId, budgetLeft: 3, now: NOW }));
  expect(close(ledger, live.runId)).toEqual({ ok: false, reason: "budget_reduced" });
  expect(run(ledger, live.runId)).toMatchObject({ state: "preparing", budgetLeft: 3 });
  expect(slotFree(ledger)).toBe(false);
  ledger.close();
  expect(() => rawWrite(path, RAW_CLOSURE, live.runId, WORKER_EXECUTOR, SHUT)).toThrow("unreceived_closure_unproven");

  // 대기 중에 줄인 예산은 시작 지시에 그대로 고정되므로 감액이 아니다.
  const second = ready(open(tempPath()));
  const queued = must(second.admitRun(worker())).run.runId;
  must(second.recordBudget({ runId: queued, budgetLeft: 7, now: NOW }));
  must(second.startRun({ runId: queued, requestId: id(), stopGeneration: 0, now: NOW }));
  expect(close(second, queued)).toMatchObject({ ok: true, run: { state: "not_started", budgetLeft: 7 } });
});

test("보장 3: 근거 줄 없이는 queued 밖에서 not_started로 가지 못하고, 근거 표의 트리거는 코드 없이도 받은 흔적이 있는 실행을 막는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const plain = startedWorker(ledger);
  must(ledger.recordStopInstruction({ runId: plain.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  const queued = must(ledger.admitRun(worker())).run.runId;
  ledger.close();
  // 근거 없는 갱신: stopping(취소 뒤)·preparing 모두 막힌다. 대기 실행의 취소 길은 그대로다.
  expect(() => rawWrite(path, "UPDATE runs SET state = 'not_started' WHERE run_id = ?", plain.runId)).toThrow();
  rawWrite(path, "UPDATE runs SET state = 'not_started' WHERE run_id = ?", queued);
  expect(rows(path, "SELECT run_id, state FROM runs ORDER BY queue_seq")).toEqual([
    { run_id: plain.runId, state: "stopping" },
    { run_id: queued, state: "not_started" },
  ]);

  const second = tempPath();
  const ledger2 = ready(open(second));
  const live = { run: { runId: startedWorker(ledger2).runId } };
  ledger2.close();
  expect(() => rawWrite(second, "UPDATE runs SET state = 'not_started' WHERE run_id = ?", live.run.runId)).toThrow("run_closure_unproven");
  const insert = "INSERT INTO unreceived_closures (run_id, from_state, answer_executor_id, answer_issued_at, answer_received_at, open_id, closed_at) VALUES (?, ?, ?, ?, 1, 'o', 1)";
  // 너무 이른 답, 다른 실행기, 맞지 않는 앞 상태.
  expect(() => rawWrite(second, insert, live.run.runId, "preparing", WORKER_EXECUTOR, SHUT - 1)).toThrow("unreceived_closure_unproven");
  expect(() => rawWrite(second, insert, live.run.runId, "preparing", OTHER_EXECUTOR, SHUT)).toThrow("unreceived_closure_unproven");
  expect(() => rawWrite(second, insert, live.run.runId, "unknown_running", WORKER_EXECUTOR, SHUT)).toThrow("unreceived_closure_unproven");
  // 다른 열기의 표식.
  const requestId = (rows(second, "SELECT request_id FROM instructions WHERE run_id = ? AND action = 'task_start'", live.run.runId)[0] as { request_id: string }).request_id;
  rawWrite(second, "INSERT INTO start_dispatches (run_id, request_id, open_id, marked_at) VALUES (?, ?, 'other', 1)", live.run.runId, requestId);
  expect(() => rawWrite(second, insert, live.run.runId, "preparing", WORKER_EXECUTOR, SHUT)).toThrow("unreceived_closure_unproven");
  // 같은 열기의 표식이면 근거가 들어가고 not_started로 갈 수 있으며, 근거는 고치거나 지우거나 바꿔 넣지 못한다.
  const okInsert = "INSERT INTO unreceived_closures (run_id, from_state, answer_executor_id, answer_issued_at, answer_received_at, open_id, closed_at) VALUES (?, 'preparing', ?, ?, 1, 'other', 1)";
  rawWrite(second, okInsert, live.run.runId, WORKER_EXECUTOR, SHUT);
  rawWrite(second, "UPDATE runs SET state = 'not_started' WHERE run_id = ?", live.run.runId);
  expect(() => rawWrite(second, "UPDATE unreceived_closures SET closed_at = 2")).toThrow("unreceived_closure_unproven");
  expect(() => rawWrite(second, "DELETE FROM unreceived_closures")).toThrow("unreceived_closure_unproven");
  expect(() => rawWrite(second, okInsert.replace("INSERT", "INSERT OR REPLACE"), live.run.runId, WORKER_EXECUTOR, SHUT)).toThrow("unreceived_closure_unproven");

  // 영수증·관측·점유가 있는 실행은 코드 없이 바로 넣어도 막힌다.
  for (const evidence of ["receipt", "sighting", "hold"] as const) {
    const p = tempPath();
    const l = ready(open(p));
    const s = startedWorker(l);
    if (evidence === "receipt") must(l.applyReceipt(accepted(s), s.from));
    if (evidence === "sighting") must(l.applyExecutorAnswer({ coverage: "full", runs: [{ run_id: s.runId, state: "preparing", run_generation: 1, last_receipt_id: null }], answeredAt: NOW, now: NOW }, { sender: WORKER_EXECUTOR }));
    if (evidence === "hold") must(l.holdSlots(RESTORE_KEY, [{ executorId: WORKER_EXECUTOR, runId: s.runId, kind: "worker", runGeneration: 1, holdsSlot: false, why: "state" }], NOW));
    l.close();
    expect(() => rawWrite(p, insert, s.runId, "preparing", WORKER_EXECUTOR, SHUT), evidence).toThrow("unreceived_closure_unproven");
    expect(rows(p, "SELECT state FROM runs WHERE run_id = ?", s.runId), evidence).toEqual([{ state: "preparing" }]);
  }
});

test("보장 3: 전이표의 새 줄은 작업자의 preparing·unknown_running → not_started 둘뿐이고, 수명 판단은 queued 밖에서 not_started로 가는 의도를 내지 않는다", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, FILE), "utf8");
  expect([...sql.matchAll(/\('(worker|session)', '(\w+)', '(\w+)'\)/g)].map((m) => m.slice(1).join(" "))).toEqual(["worker preparing not_started", "worker unknown_running not_started"]);
  for (const kind of ["worker", "session"] as const) {
    for (const state of LEDGER_RUN_STATES) {
      if (state === "queued") continue;
      for (const cancelRequested of [false, true]) {
        for (const now of [NOW, NOW + 700_000]) {
          const intent = nextIntent({ run: { runId: "r", kind, state, deadlineAt: NOW + 600_000 }, lease: null, cancelRequested, lastInstructionAt: null, resultSettled: true, now }, LIFE);
          expect(intent.toward === "not_started" && intent.intent !== "wait", `${kind} ${state}`).toBe(false);
        }
      }
    }
  }
  // 이관의 시한 숫자는 계약의 두 시한과 같다(장부의 코드는 큰 쪽을 쓴다).
  expect([...sql.matchAll(/\+ (\d+)\)/g)].map((m) => Number(m[1]))).toEqual([Math.max(limits.RUN_LEASE_MAX_MS, limits.MESSAGE_TTL_MAX_MS)]);
  expect(limits.RUN_LEASE_MAX_MS).toBe(limits.MESSAGE_TTL_MAX_MS);
});

// ---- 보장 4: 닫힌 실행에 늦게 온 것 ----

test("보장 4: 닫힌 실행의 늦은 접수·종료 영수증은 받은 기록만 남기고 ack하며 상태는 그대로다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  must(close(ledger, live.runId));
  const accept = accepted(live);
  expect(ledger.applyReceipt(accept, live.from)).toEqual({ ok: true, delivery: "new", ack: accept.receiptId });
  const stop = stoppedReceipt(live.runId);
  expect(ledger.applyReceipt(stop, live.from)).toEqual({ ok: true, delivery: "new", ack: stop.receiptId });
  expect(ledger.applyReceipt(stop, live.from)).toEqual({ ok: true, delivery: "duplicate", ack: stop.receiptId });
  const report = resultReport(live.runId);
  expect(ledger.recordReport(report, live.from)).toEqual({ ok: true, delivery: "new", ack: report.reportId });
  expect(run(ledger, live.runId)).toMatchObject({ state: "not_started", acceptedReceiptId: null, stopReceiptId: null, resultDigest: null });
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  expect(slotFree(ledger)).toBe(true);
  ledger.close();
  expect(rows(path, "SELECT action, applied_at FROM deliveries WHERE run_id = ? ORDER BY action", live.runId)).toEqual([
    { action: "receipt_accepted", applied_at: null },
    { action: "receipt_stopped", applied_at: null },
    { action: "report_result", applied_at: SHUT + 20 },
  ]);
});

test("보장 4: 닫힌 실행의 늦은 시작 영수증은 경보를 싣고 그 종류의 자리를 다시 막으며, 재전송에도 경보를 싣는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  must(close(ledger, live.runId));
  const next = must(ledger.admitRun(worker())).run.runId;
  const late = startedReceipt(live);
  expect(ledger.applyReceipt(late, live.from)).toEqual({ ok: true, delivery: "new", ack: late.receiptId, alarm: "closed_run_started" });
  expect(ledger.applyReceipt(late, live.from)).toEqual({ ok: true, delivery: "duplicate", ack: late.receiptId, alarm: "closed_run_started" });
  expect(run(ledger, live.runId)).toMatchObject({ state: "not_started", startedReceiptId: null });
  expect(slotFree(ledger)).toBe(false);
  expect(ledger.slotHolds()).toEqual({ known: true, value: [expect.objectContaining({ executorId: WORKER_EXECUTOR, runId: live.runId, kind: "worker", runGeneration: 1, holdsSlot: true, why: "ended_in_ledger" })] });
  expect(ledger.startRun({ runId: next, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "slot_busy" });
});

test("보장 4: 대기에서 취소돼 not_started가 된 실행의 지금 동작은 그대로다(경보 없음, 종료 영수증·결과 보고는 거절)", () => {
  const ledger = ready(open(tempPath()));
  const cancelled = must(ledger.admitRun(worker())).run;
  must(ledger.recordStopInstruction({ runId: cancelled.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  const cancelId = id();
  must(ledger.recordStopInstruction({ runId: cancelled.runId, requestId: cancelId, action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  const from = { sender: WORKER_EXECUTOR, runGeneration: 1 };
  expect(run(ledger, cancelled.runId).state).toBe("not_started");
  expect(ledger.applyReceipt(stoppedReceipt(cancelled.runId), from)).toEqual({ ok: false, reason: "transition_denied" });
  expect(ledger.recordReport(resultReport(cancelled.runId), from)).toEqual({ ok: false, reason: "transition_denied" });
  const accept = { action: "receipt_accepted" as const, receiptId: id(), runId: cancelled.runId, instructionRequestId: cancelId, instruction: "task_cancel" as const, bodyDigest: digest("a"), now: NOW };
  expect(ledger.applyReceipt(accept, from)).toEqual({ ok: true, delivery: "new", ack: accept.receiptId });
  expect(run(ledger, cancelled.runId)).toMatchObject({ state: "not_started", acceptedReceiptId: accept.receiptId });
  expect(slotFree(ledger)).toBe(true);
});

test("보장 4: 닫힌 작업자를 앞 실행으로 가리키는 세션 인수 영수증은 닫히지 않은 작업자처럼 종류 검사에서 거절되고 아무것도 적지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const closed = startedWorker(ledger);
  must(close(ledger, closed.runId));
  const cancelled = must(ledger.admitRun(worker())).run.runId;
  must(ledger.recordStopInstruction({ runId: cancelled, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  // 인수 영수증을 낼 수 있는 쪽: 대기 중인 세션 실행의 지정 실행기.
  must(ledger.admitRun(session()));
  const receipts = [closed.runId, cancelled].map((previousRunId) => ({
    action: "receipt_session_takeover" as const,
    receiptId: id(),
    previousRunId,
    newGenerationMarkerDigest: digest("marker"),
    startPermitId: id(),
    takenOverAt: SHUT + 20,
    bodyDigest: digest("takeover"),
    now: SHUT + 20,
  }));
  for (const receipt of receipts) expect(ledger.applyReceipt(receipt, { sender: SESSION_EXECUTOR, runGeneration: 1 }), receipt.previousRunId).toEqual({ ok: false, reason: "invariant_violation" });
  ledger.close();
  expect(rows(path, "SELECT (SELECT count(*) FROM deliveries WHERE action = 'receipt_session_takeover') + (SELECT count(*) FROM session_takeovers) AS n")).toEqual([{ n: 0 }]);
});

test("복원의 점유 기록: 관측 배열에 빈 자리가 있으면 거래 전체가 되돌아가고 성공을 내지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  const observations: SlotHoldObservation[] = new Array(2);
  observations[0] = { executorId: WORKER_EXECUTOR, runId: live.runId, kind: "worker", runGeneration: 1, holdsSlot: true, why: "state" };
  expect(ledger.holdSlots(RESTORE_KEY, observations, NOW)).toEqual({ ok: false, reason: "ledger_unwritable" });
  ledger.close();
  expect(rows(path, "SELECT count(*) AS n FROM slot_holds")).toEqual([{ n: 0 }]);
});

// ---- 기존 장부 ----

test("이관: 판 1~5의 장부가 판 6으로 올라가고 기존 줄은 그대로이며, 판 6의 장부는 옛 코드로 열지 않는다", () => {
  expect(VERSION).toBe(6);
  for (let version = 1; version < VERSION; version++) {
    const path = tempPath();
    const before = ready(open(path, { migrations: loadMigrations().slice(0, version) }));
    const live = startedWorker(before);
    must(before.applyReceipt(startedReceipt(live), live.from));
    before.close();
    const tables = ["runs", "instructions", "deliveries", "slot_holds", "stop_state", "run_epoch", "run_transitions"];
    // 그 판에 있던 칸만 비교한다(판 2·4가 더하는 칸은 그 이관의 시험이 본다).
    const columns = tables.map((table) => (rows(path, `PRAGMA table_info(${table})`) as { name: string }[]).map((column) => column.name).join(", "));
    const kept = () => tables.map((table, index) => rows(path, `SELECT ${columns[index]} FROM ${table}`));
    const old = kept();
    const upgraded = openLedger(path, { clock, mode: "reopen" });
    expect(upgraded, `판 ${version}`).toMatchObject({ ok: true, migrated: { from: version, to: VERSION } });
    if (upgraded.ok) upgraded.ledger.close();
    const now = kept();
    expect(now.slice(0, -1), `판 ${version}`).toEqual(old.slice(0, -1));
    expect((now.at(-1) as unknown[]).length, `판 ${version}`).toBe((old.at(-1) as unknown[]).length + 2);
    expect(rows(path, "SELECT (SELECT count(*) FROM start_dispatches) + (SELECT count(*) FROM unreceived_closures) + (SELECT count(*) FROM snapshot_run_bounds) AS n")).toEqual([{ n: 0 }]);
    // 적용 때 있던 시작 지시는 모두 판 이전의 시작으로 남는다.
    expect(rows(path, "SELECT run_id, request_id FROM starts_before_closure"), `판 ${version}`).toEqual([{ run_id: live.runId, request_id: live.requestId }]);
    expect(rows(path, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  }
  const path = tempPath();
  open(path).close();
  expect(openLedger(path, { clock, mode: "reopen", migrations: loadMigrations().slice(0, VERSION - 1) })).toMatchObject({ ok: false, reason: "too_new" });
});
