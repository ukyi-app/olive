// D-90: 실행기가 받은 적 없는 작업자 실행의 닫기(판 0006-unreceived-closure). 송신 표식, 한 트랜잭션의 닫기, 근거 없는 not_started의 차단,
// 닫힌 실행의 늦은 영수증·보고. 실제 장부 파일에 적고, 공개 읽기와 원 SQL로 본다. 닫은 뒤의 수명은 실제 판단(nextIntent)을 불러 본다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { limits, type RunStatus } from "../../src/contract/v1/index.ts";
import { type Ledger, LEDGER_RUN_STATES, loadMigrations, MIGRATIONS_DIR, openLedger, type Refusal, type UnreceivedClosureInput } from "../../src/ledger/index.ts";
import { RESTORE_KEY } from "../../src/ledger/ledger.ts";
import { type LifecyclePolicy, nextIntent } from "../../src/supervisor/scheduler/lifecycle.ts";
import { clock, digest, id, must, NOW, open, ready, startedWorker, tempDir, tempPath, WORKER_EXECUTOR, worker } from "./helpers.ts";

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
    expect(rows(path, "SELECT (SELECT count(*) FROM start_dispatches) + (SELECT count(*) FROM unreceived_closures) AS n")).toEqual([{ n: 0 }]);
    expect(rows(path, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  }
  const path = tempPath();
  open(path).close();
  expect(openLedger(path, { clock, mode: "reopen", migrations: loadMigrations().slice(0, VERSION - 1) })).toMatchObject({ ok: false, reason: "too_new" });
});
