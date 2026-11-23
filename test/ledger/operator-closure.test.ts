// D-91·D-93: 관리자가 확인한 뒤 종료가 확인되지 않은 작업자 실행을 "실패로 끝남"으로 닫는다(판 0007-operator-closure).
// 실제 장부 파일에 적고, 공개 읽기와 원 SQL로 본다. 파드 이름·ID·digest·시각은 이 시험이 지어낸 값이다. 운영값이 아니다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { limits } from "../../src/contract/v1/index.ts";
import { type Ledger, LedgerInputError, loadMigrations, openLedger } from "../../src/ledger/index.ts";
import { type OperatorClosureInput, RESTORE_KEY } from "../../src/ledger/ledger.ts";
import { planNext, type SchedulerView } from "../../src/supervisor/scheduler/queue.ts";
import { clock, digest, id, must, NOW, open, ready, session, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "./helpers.ts";

const FILE = "0007-operator-closure.sql";
const VERSION = loadMigrations().findIndex((m) => m.name === FILE) + 1;
const POD = "worker-diagnosis-7f9c-x2kq";
const LATER = NOW + 60_000;

function closeOp(ledger: Ledger, runId: string, extra: Partial<OperatorClosureInput> = {}) {
  return ledger.closeRunByOperator({ runId, checkedBy: "pod_replaced", podName: POD, now: LATER, ...extra });
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

function rawWrite(path: string, sql: string, ...params: (string | number | null)[]): void {
  const raw = new Database(path);
  try {
    raw.run("PRAGMA foreign_keys = ON");
    raw.query(sql).run(...params);
  } finally {
    raw.close();
  }
}

const accepted = (s: { runId: string; requestId: string }) => ({ action: "receipt_accepted" as const, receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, instruction: "task_start" as const, bodyDigest: digest("accepted"), now: NOW });
const startedReceipt = (s: { runId: string; requestId: string }, receiptId = id()) => ({ action: "receipt_started" as const, receiptId, runId: s.runId, instructionRequestId: s.requestId, bodyDigest: digest("started"), now: NOW });
const stoppedReceipt = (runId: string) => ({ action: "receipt_stopped" as const, receiptId: id(), runId, exit: "cancelled" as const, bodyDigest: digest("stopped"), now: LATER + 1 });
const resultReport = (runId: string) => ({ reportId: id(), action: "report_result" as const, runId, bodyDigest: digest("result"), storedRef: `results/${id()}`, resultDigest: digest("r"), now: LATER + 1 });

// 접수·시작 영수증을 받은 뒤 끊겨 unknown_running이 된 실행(D-91의 본래 대상).
function lostAfterStart(ledger: Ledger) {
  const live = startedWorker(ledger);
  must(ledger.applyReceipt(accepted(live), live.from));
  must(ledger.applyReceipt(startedReceipt(live), live.from));
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  return live;
}

// 원 SQL의 근거 줄. 마지막 값은 closed_at이다(시작 발행 NOW부터 띄울 수 있는 마지막 시각이 지난 LATER를 기본으로 넘긴다).
const RAW_OPERATOR = "INSERT INTO operator_closures (run_id, from_state, checked_by, pod_name, stop_generation, closed_at) VALUES (?, ?, ?, ?, ?, ?)";
// 시작 지시를 NOW에 낸 실행을 관리자가 닫을 수 있게 되는 첫 시각(감독의 시계). 그 1ms 전이 실행기가 새로 띄울 수 있는 마지막 시각이다.
const CLOSABLE_AT = NOW + Math.max(limits.RUN_LEASE_MAX_MS, limits.MESSAGE_TTL_MAX_MS) + limits.CLOCK_SKEW_MS;

function stoppingAfterAccepted(ledger: Ledger, receipt: boolean) {
  const live = startedWorker(ledger);
  must(ledger.markStartDispatch({ runId: live.runId, requestId: live.requestId, now: NOW }));
  if (receipt) must(ledger.applyReceipt(accepted(live), live.from));
  must(ledger.recordStopInstruction({ runId: live.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW + 1, reason: "requested" }));
  return live;
}

// ---- 보장 1: 닫을 수 있는 실행 ----

test("보장 1: 영수증을 받은 unknown_running과 종료 확인 없는 stopping 작업자는 닫히고 자리가 풀린다", () => {
  const ledger = ready(open(tempPath()));
  const lost = lostAfterStart(ledger);
  expect(run(ledger, lost.runId).state).toBe("unknown_running");
  expect(slotFree(ledger)).toBe(false);
  const closed = must(closeOp(ledger, lost.runId));
  expect(closed.run).toMatchObject({ state: "not_started", stopReceiptId: null });
  expect(closed.closure).toEqual({ runId: lost.runId, fromState: "unknown_running", checkedBy: "pod_replaced", podName: POD, stopGeneration: 0, closedAt: LATER });
  expect(slotFree(ledger)).toBe(true);

  const stopping = startedWorker(ledger);
  must(ledger.recordStopInstruction({ runId: stopping.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  expect(run(ledger, stopping.runId).state).toBe("stopping");
  expect(must(closeOp(ledger, stopping.runId, { checkedBy: "process_absent" })).closure).toMatchObject({ fromState: "stopping", checkedBy: "process_absent" });
  expect(ledger.operatorClosure(stopping.runId)).toEqual({ known: true, value: { runId: stopping.runId, fromState: "stopping", checkedBy: "process_absent", podName: POD, stopGeneration: 0, closedAt: LATER } });
  expect(slotFree(ledger)).toBe(true);
});

test("보장 1: D-90이 좁혀 닫지 않는 실행(다른 열기의 표식, 예산 감액, 판 6 이전의 시작)도 unknown_running이면 닫힌다", () => {
  // 다른 열기의 표식(실은 뒤 감독이 다시 떴다), 예산 감액(시작 뒤 감액이 적혔다).
  for (const [kind, expected] of [["marked", "sent_by_other_open"], ["reduced", "budget_reduced"]] as const) {
    const path = tempPath();
    const first = ready(open(path));
    const live = startedWorker(first);
    if (kind === "marked") must(first.markStartDispatch({ runId: live.runId, requestId: live.requestId, now: NOW }));
    else must(first.recordBudget({ runId: live.runId, budgetLeft: 3, now: NOW }));
    first.close();
    const second = ready(open(path));
    must(second.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
    expect(second.closeUnreceivedRun({ runId: live.runId, runs: [], answeredAt: NOW + 30_000, receivedAt: NOW + 30_001, now: NOW + 30_002 }, { sender: WORKER_EXECUTOR })).toEqual({ ok: false, reason: expected });
    expect(must(closeOp(second, live.runId)).run.state).toBe("not_started");
    second.close();
  }
  // 판 6 이전의 시작(판 5의 장부에서 시작하고 판 7로 올린다).
  const old = tempPath();
  const before = ready(open(old, { migrations: loadMigrations().slice(0, 5) }));
  const early = startedWorker(before);
  before.close();
  const upgraded = ready(open(old));
  must(upgraded.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  expect(upgraded.closeUnreceivedRun({ runId: early.runId, runs: [], answeredAt: NOW + 30_000, receivedAt: NOW + 30_001, now: NOW + 30_002 }, { sender: WORKER_EXECUTOR })).toEqual({ ok: false, reason: "started_before_migration" });
  expect(must(closeOp(upgraded, early.runId)).run.state).toBe("not_started");
});

test("보장 1: 없는 실행, 세션, 끝 상태, 종료 확인, 그 밖의 앞 상태, 못 쓰는 장부는 구별된 거절이고 상태와 자리는 그대로다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  expect(closeOp(ledger, id())).toEqual({ ok: false, reason: "unknown_run" });
  const sessionRun = must(ledger.admitRun(session())).run.runId;
  expect(closeOp(ledger, sessionRun)).toEqual({ ok: false, reason: "run_not_worker" });
  const cancelled = must(ledger.admitRun(worker())).run.runId;
  must(ledger.recordStopInstruction({ runId: cancelled, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  expect(closeOp(ledger, cancelled)).toEqual({ ok: false, reason: "run_ended" });
  const preparing = startedWorker(ledger);
  expect(closeOp(ledger, preparing.runId)).toEqual({ ok: false, reason: "transition_denied" });
  must(ledger.applyReceipt(startedReceipt(preparing), preparing.from));
  expect(run(ledger, preparing.runId).state).toBe("running");
  expect(closeOp(ledger, preparing.runId)).toEqual({ ok: false, reason: "transition_denied" });
  must(ledger.applyReceipt(stoppedReceipt(preparing.runId), preparing.from));
  expect(run(ledger, preparing.runId).state).toBe("failed_stopped");
  expect(closeOp(ledger, preparing.runId)).toEqual({ ok: false, reason: "stop_confirmed" });
  const queued = must(ledger.admitRun(worker())).run.runId;
  expect(closeOp(ledger, queued)).toEqual({ ok: false, reason: "transition_denied" });
  expect(run(ledger, preparing.runId).state).toBe("failed_stopped");
  expect(slotFree(ledger)).toBe(false);
  ledger.close();
  expect(closeOp(ledger, preparing.runId)).toEqual({ ok: false, reason: "ledger_unwritable" });
  expect(rows(path, "SELECT count(*) AS n FROM operator_closures")).toEqual([{ n: 0 }]);
});

// ---- 보장 2: 근거와 상태는 한 커밋, 근거는 고정 ----

test("보장 2: 확인 칸이 하나라도 틀리면 아무것도 쓰지 않는다(목록 밖 방법, 빈 이름, Kubernetes 이름 규칙 밖)", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const lost = lostAfterStart(ledger);
  const bad: Partial<Record<keyof OperatorClosureInput, unknown>>[] = [
    { checkedBy: "looked" as never },
    { checkedBy: "" as never },
    { podName: "" },
    { podName: "Worker-A" },
    { podName: "-worker" },
    { podName: "worker-" },
    { podName: "worker..a" },
    { podName: "worker.-a" },
    { podName: "worker a" },
    { podName: "worker_a" },
    { podName: "a".repeat(254) },
    { podName: 7 as never },
    { podName: "a\u0000b" },
    { podName: "ab\u0000" },
  ];
  for (const extra of bad) expect(() => closeOp(ledger, lost.runId, extra as Partial<OperatorClosureInput>), JSON.stringify(extra).slice(0, 40)).toThrow(LedgerInputError);
  expect(() => ledger.closeRunByOperator({ runId: lost.runId, checkedBy: "pod_replaced", podName: POD, now: LATER, note: "x" } as never)).toThrow(LedgerInputError);
  expect(run(ledger, lost.runId).state).toBe("unknown_running");
  expect(ledger.operatorClosure(lost.runId)).toEqual({ known: true, value: null });
  // 경계 값: 253자와 한 글자, 점으로 이은 이름은 받는다.
  expect(must(closeOp(ledger, lost.runId, { podName: `${"a".repeat(125)}.${"b".repeat(127)}` })).closure.podName).toHaveLength(253);
});

test("보장 2: 근거 줄과 not_started는 한 커밋이고, 커밋 전에 끊기면 둘 다 없다", () => {
  const path = tempPath();
  let armed = false;
  const ledger = ready(open(path, { faults: { at: (point: string) => { if (armed && point === "operator_closure:before_commit") throw new Error("끊김"); } } } as never));
  const lost = lostAfterStart(ledger);
  armed = true;
  expect(closeOp(ledger, lost.runId)).toEqual({ ok: false, reason: "ledger_unwritable" });
  ledger.close();
  expect(rows(path, "SELECT state FROM runs WHERE run_id = ?", lost.runId)).toEqual([{ state: "unknown_running" }]);
  expect(rows(path, "SELECT count(*) AS n FROM operator_closures")).toEqual([{ n: 0 }]);
  const reopened = ready(open(path));
  must(closeOp(reopened, lost.runId));
  reopened.close();
  expect(rows(path, "SELECT r.state, o.from_state, o.checked_by, o.pod_name, o.stop_generation, o.closed_at FROM runs r JOIN operator_closures o ON o.run_id = r.run_id")).toEqual([
    { state: "not_started", from_state: "unknown_running", checked_by: "pod_replaced", pod_name: POD, stop_generation: 0, closed_at: LATER },
  ]);
});

test("보장 2: 트리거는 코드 없이도 근거 없는 not_started, 꼴 밖의 근거, 두 근거, 근거의 고침·지움을 막는다", () => {
  // 장부 셋: unknown_running(영수증 받음), stopping(취소 뒤), preparing. 작업 자리가 하나라 실행마다 장부를 따로 둔다.
  const one = (make: (ledger: Ledger) => { runId: string }) => {
    const p = tempPath();
    const l = ready(open(p));
    const made = make(l);
    l.close();
    return { path: p, runId: made.runId };
  };
  const lost = one(lostAfterStart);
  const stopping = one((l) => {
    const s = startedWorker(l);
    must(l.recordStopInstruction({ runId: s.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
    return s;
  });
  const preparing = one(startedWorker);
  // 근거 없는 갱신.
  for (const c of [lost, stopping, preparing]) expect(() => rawWrite(c.path, "UPDATE runs SET state = 'not_started' WHERE run_id = ?", c.runId)).toThrow("run_closure_unproven");
  const path = lost.path;
  // 꼴 밖의 근거: 방법, 파드 이름(가운데·끝의 U+0000 포함), 앞 상태, 정지 세대, 띄울 수 있는 마지막 시각 전, NULL.
  const refused: [string, string, string | null, string | null, number | null, number | null][] = [
    [lost.runId, "unknown_running", "looked", POD, 0, LATER],
    [lost.runId, "unknown_running", "", POD, 0, LATER],
    [lost.runId, "unknown_running", "pod_replaced", "", 0, LATER],
    [lost.runId, "unknown_running", "pod_replaced", "Pod", 0, LATER],
    [lost.runId, "unknown_running", "pod_replaced", "a..b", 0, LATER],
    [lost.runId, "unknown_running", "pod_replaced", "a-", 0, LATER],
    [lost.runId, "unknown_running", "pod_replaced", "a/b", 0, LATER],
    [lost.runId, "unknown_running", "pod_replaced", "a".repeat(254), 0, LATER],
    [lost.runId, "unknown_running", "pod_replaced", "a\u0000b", 0, LATER],
    [lost.runId, "unknown_running", "pod_replaced", "ab\u0000", 0, LATER],
    [lost.runId, "unknown_running", "pod_replaced", POD, 1, LATER],
    [lost.runId, "stopping", "pod_replaced", POD, 0, LATER],
    [lost.runId, "unknown_running", "pod_replaced", POD, 0, CLOSABLE_AT - 1],
    [lost.runId, "unknown_running", "pod_replaced", POD, 0, 1],
    [lost.runId, "unknown_running", null, POD, 0, LATER],
    [lost.runId, "unknown_running", "pod_replaced", null, 0, LATER],
    [lost.runId, "unknown_running", "pod_replaced", POD, null, LATER],
    [lost.runId, "unknown_running", "pod_replaced", POD, 0, null],
  ];
  for (const values of refused) expect(() => rawWrite(path, RAW_OPERATOR, ...values), JSON.stringify(values).slice(40, 120)).toThrow();
  // NUL과 시각은 NOT NULL·CHECK가 아니라 트리거가 막는다.
  for (const values of refused.slice(8, 10)) expect(() => rawWrite(path, RAW_OPERATOR, ...values)).toThrow("operator_closure_unproven");
  for (const values of refused.slice(12, 14)) expect(() => rawWrite(path, RAW_OPERATOR, ...values)).toThrow("operator_closure_unproven");
  expect(() => rawWrite(preparing.path, RAW_OPERATOR, preparing.runId, "preparing", "pod_replaced", POD, 0, LATER)).toThrow("operator_closure_unproven");
  expect(rows(path, "SELECT count(*) AS n FROM operator_closures")).toEqual([{ n: 0 }]);
  expect(rows(path, "SELECT state FROM runs WHERE run_id = ?", lost.runId)).toEqual([{ state: "unknown_running" }]);
  expect(rows(preparing.path, "SELECT count(*) AS n FROM operator_closures")).toEqual([{ n: 0 }]);
  // 맞는 근거 줄 하나를 넣는 문장이 실행 줄도 닫는다(따로 여는 연결에서 읽어도 근거만 있는 상태는 없다). 정각(CLOSABLE_AT)은 받는다.
  rawWrite(stopping.path, RAW_OPERATOR, stopping.runId, "stopping", "process_absent", POD, 0, CLOSABLE_AT);
  expect(rows(stopping.path, "SELECT r.state, r.updated_at, o.from_state FROM runs r JOIN operator_closures o ON o.run_id = r.run_id")).toEqual([
    { state: "not_started", updated_at: CLOSABLE_AT, from_state: "stopping" },
  ]);
  // 근거는 고치거나 지우거나 바꿔 넣지 못한다.
  expect(() => rawWrite(stopping.path, "UPDATE operator_closures SET pod_name = 'other'")).toThrow("operator_closure_unproven");
  expect(() => rawWrite(stopping.path, "DELETE FROM operator_closures")).toThrow("operator_closure_unproven");
  expect(() => rawWrite(stopping.path, RAW_OPERATOR.replace("INSERT", "INSERT OR REPLACE"), stopping.runId, "stopping", "pod_replaced", POD, 0, LATER)).toThrow("operator_closure_unproven");
  expect(rows(stopping.path, "SELECT run_id, checked_by FROM operator_closures")).toEqual([{ run_id: stopping.runId, checked_by: "process_absent" }]);
});

test("보장 2: 원 SQL에서도 근거와 닫기는 한 문장이다(전이가 막히면 근거도 없고, 종료 영수증이 연결된 실행에는 근거가 들어가지 않는다)", () => {
  const make = () => {
    const p = tempPath();
    const l = ready(open(p));
    const s = startedWorker(l);
    must(l.recordStopInstruction({ runId: s.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
    l.close();
    return { path: p, runId: s.runId };
  };
  // 닫는 갱신을 이 연결에서만 막으면 근거 줄을 넣은 문장째 되돌아간다.
  const blocked = make();
  const raw = new Database(blocked.path);
  try {
    raw.run("PRAGMA foreign_keys = ON");
    raw.run("CREATE TEMP TRIGGER block_close BEFORE UPDATE OF state ON main.runs BEGIN SELECT RAISE(ABORT, 'test_block_close'); END");
    expect(() => raw.query(RAW_OPERATOR).run(blocked.runId, "stopping", "process_absent", POD, 0, LATER)).toThrow("test_block_close");
  } finally {
    raw.close();
  }
  expect(rows(blocked.path, "SELECT count(*) AS n FROM operator_closures")).toEqual([{ n: 0 }]);
  expect(rows(blocked.path, "SELECT state FROM runs WHERE run_id = ?", blocked.runId)).toEqual([{ state: "stopping" }]);
  // 종료 영수증을 먼저 연결한 stopping(원 SQL)에는 근거가 들어가지 않고 상태도 그대로다.
  const confirmed = make();
  const receiptId = id();
  rawWrite(confirmed.path, "INSERT INTO deliveries (id, action, run_id, body_digest, received_at) VALUES (?, 'receipt_stopped', ?, ?, ?)", receiptId, confirmed.runId, digest("stopped"), NOW + 1);
  rawWrite(confirmed.path, "UPDATE runs SET stop_receipt_id = ? WHERE run_id = ?", receiptId, confirmed.runId);
  expect(() => rawWrite(confirmed.path, RAW_OPERATOR, confirmed.runId, "stopping", "process_absent", POD, 0, LATER)).toThrow("operator_closure_unproven");
  expect(rows(confirmed.path, "SELECT state, stop_receipt_id FROM runs WHERE run_id = ?", confirmed.runId)).toEqual([{ state: "stopping", stop_receipt_id: receiptId }]);
  expect(rows(confirmed.path, "SELECT count(*) AS n FROM operator_closures")).toEqual([{ n: 0 }]);
  // 이관의 시각 숫자는 계약의 두 시한의 큰 쪽 + 시계 오차와 같다(장부의 코드는 같은 식을 쓴다).
  const sql = (rows(confirmed.path, "SELECT sql FROM sqlite_master WHERE name = 'operator_closures_proven'") as { sql: string }[])[0]?.sql ?? "";
  expect([...sql.matchAll(/\+ (\d+)\)/g)].map((m) => Number(m[1]))).toEqual([CLOSABLE_AT - NOW]);
});

test("보장 2: 한 실행에 두 근거(D-90과 관리자)는 함께 생기지 않는다(코드와 트리거, 두 방향)", () => {
  // D-90 근거만 원 SQL로 넣은 unknown_running(받은 기록 0줄): 관리자 근거는 들어가지 않는다.
  const path = tempPath();
  const ledger = ready(open(path));
  const bare = startedWorker(ledger);
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  ledger.close();
  rawWrite(path, "INSERT INTO unreceived_closures (run_id, from_state, answer_executor_id, answer_issued_at, answer_received_at, open_id, closed_at) VALUES (?, 'unknown_running', ?, ?, 1, 'o', 1)", bare.runId, WORKER_EXECUTOR, NOW + 30_000);
  expect(() => rawWrite(path, RAW_OPERATOR, bare.runId, "unknown_running", "pod_replaced", POD, 0, LATER)).toThrow("operator_closure_unproven");

  // 관리자 근거를 원 SQL로 넣은 unknown_running(받은 기록 0줄, D-90의 다른 조건은 맞음): D-90 근거는 들어가지 않는다.
  const d90 = "INSERT INTO unreceived_closures (run_id, from_state, answer_executor_id, answer_issued_at, answer_received_at, open_id, closed_at) VALUES (?, 'unknown_running', ?, ?, 1, 'o', 1)";
  const lostBare = () => {
    const p = tempPath();
    const l = ready(open(p));
    const s = startedWorker(l);
    must(l.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
    l.close();
    return { path: p, runId: s.runId };
  };
  const second = lostBare();
  rawWrite(second.path, RAW_OPERATOR, second.runId, "unknown_running", "pod_replaced", POD, 0, LATER);
  expect(() => rawWrite(second.path, d90, second.runId, WORKER_EXECUTOR, NOW + 30_000)).toThrow("unreceived_closure_unproven");
  // 관리자 근거는 같은 문장에서 실행을 not_started로 닫아 판 6의 트리거(앞 상태)도 막는다. unreceived_closures_exclusive만으로 막는지
  // 보려고 이 장부에서 닫는 트리거를 지워 "관리자 근거가 있고 상태는 unknown_running"을 만든다.
  const isolated = lostBare();
  rawWrite(isolated.path, "DROP TRIGGER operator_closures_close_run");
  rawWrite(isolated.path, RAW_OPERATOR, isolated.runId, "unknown_running", "pod_replaced", POD, 0, LATER);
  expect(rows(isolated.path, "SELECT state FROM runs WHERE run_id = ?", isolated.runId)).toEqual([{ state: "unknown_running" }]);
  expect(() => rawWrite(isolated.path, d90, isolated.runId, WORKER_EXECUTOR, NOW + 30_000)).toThrow("unreceived_closure_unproven");
  rawWrite(isolated.path, "DROP TRIGGER unreceived_closures_exclusive");
  rawWrite(isolated.path, d90, isolated.runId, WORKER_EXECUTOR, NOW + 30_000);

  // 코드: D-90으로 닫은 실행은 관리자가 닫지 못하고(run_ended), 관리자가 닫은 실행은 D-90이 닫지 못한다.
  const ledger3 = ready(open(tempPath()));
  const a = startedWorker(ledger3);
  must(ledger3.closeUnreceivedRun({ runId: a.runId, runs: [], answeredAt: NOW + 30_000, receivedAt: NOW + 30_001, now: NOW + 30_002 }, { sender: WORKER_EXECUTOR }));
  expect(closeOp(ledger3, a.runId)).toEqual({ ok: false, reason: "run_ended" });
  const b = startedWorker(ledger3);
  must(ledger3.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  must(closeOp(ledger3, b.runId));
  expect(ledger3.closeUnreceivedRun({ runId: b.runId, runs: [], answeredAt: NOW + 30_000, receivedAt: NOW + 30_001, now: NOW + 30_002 }, { sender: WORKER_EXECUTOR })).toEqual({ ok: false, reason: "transition_denied" });
});

// ---- 보장 3: 보이는 단계는 실패, 다시 시작하지 않음 ----

test("보장 3: 관리자가 닫은 실행의 작업 부탁 단계는 실패(failed_stopped)이고, D-90으로 닫은 실행은 not_started 그대로이며, 닫은 실행은 다시 시작하지 않는다", () => {
  const ledger = ready(open(tempPath()));
  const owner = id();
  must(ledger.enqueueInput({ requestId: owner, source: "admin-dm", sourceRef: { ref: `inbox/${owner}`, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
  const assign = (runId: string) => {
    const ref = id();
    must(ledger.recordToolRequest({ ref, owner, dedupeKey: `start_worker:${owner}:${ref}`, role: "diagnosis", purpose: "diagnose", sourceRef: `inbox/${owner}`, inputDigest: digest("in"), sessionId: "session-1", callId: id(), now: NOW }));
    const w = worker();
    must(ledger.assignToolRequest({ ref, runId, snapshotDigest: w.snapshotDigest as string, profileRevision: w.profileRevision, policyRevision: w.policyRevision, executorId: w.executorId, credential: w.credential, deadlineAt: w.deadlineAt, budgetLeft: w.budgetLeft, now: NOW }));
    const requestId = id();
    must(ledger.startRun({ runId, requestId, stopGeneration: 0, now: NOW }));
    return { ref, runId, requestId };
  };
  const phase = (ref: string) => {
    const read = ledger.readToolRequest({ owner, ref });
    if (!read.known || read.value === null) throw new Error("부탁 없음");
    return read.value.phase;
  };
  const byOperator = assign(id());
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  expect(phase(byOperator.ref)).toBe("unknown_running");
  must(closeOp(ledger, byOperator.runId));
  const byD90 = assign(id());
  must(ledger.closeUnreceivedRun({ runId: byD90.runId, runs: [], answeredAt: NOW + 30_000, receivedAt: NOW + 30_001, now: NOW + 30_002 }, { sender: WORKER_EXECUTOR }));
  expect(phase(byOperator.ref)).toBe("failed_stopped");
  expect(phase(byD90.ref)).toBe("not_started");
  const found = ledger.findToolRequest({ owner, dedupeKey: `start_worker:${owner}:${byOperator.ref}` });
  expect(found).toMatchObject({ known: true, value: { phase: "failed_stopped" } });
  // 같은 실행 ID는 다시 시작하지 않는다.
  expect(ledger.startRun({ runId: byOperator.runId, requestId: id(), stopGeneration: 0, now: LATER }).ok).toBe(false);
  expect(run(ledger, byOperator.runId).state).toBe("not_started");
});

// ---- 보장 4: 닫은 뒤의 늦은 영수증·보고 ----

test("보장 4: 닫은 뒤 처음 온 시작 영수증은 경보를 싣고 자리를 다시 막으며 재전송에도 경보를 싣는다", () => {
  const ledger = ready(open(tempPath()));
  const live = startedWorker(ledger);
  must(ledger.applyReceipt(accepted(live), live.from));
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  must(closeOp(ledger, live.runId));
  const next = must(ledger.admitRun(worker())).run.runId;
  const late = startedReceipt(live);
  expect(ledger.applyReceipt(late, live.from)).toEqual({ ok: true, delivery: "new", ack: late.receiptId, alarm: "closed_run_started" });
  expect(ledger.applyReceipt(late, live.from)).toEqual({ ok: true, delivery: "duplicate", ack: late.receiptId, alarm: "closed_run_started" });
  expect(run(ledger, live.runId)).toMatchObject({ state: "not_started", startedReceiptId: null });
  expect(slotFree(ledger)).toBe(false);
  expect(ledger.slotHolds()).toEqual({ known: true, value: [expect.objectContaining({ runId: live.runId, holdsSlot: true, why: "ended_in_ledger" })] });
  expect(ledger.startRun({ runId: next, requestId: id(), stopGeneration: 0, now: LATER })).toEqual({ ok: false, reason: "slot_busy" });
});

test("보장 4: 닫기 전에 받은 시작 영수증의 재전송은 경보 없이 ack하고, 늦은 종료 영수증·결과 보고는 받은 기록만 남긴다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  const early = startedReceipt(live);
  must(ledger.applyReceipt(early, live.from));
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  must(closeOp(ledger, live.runId));
  expect(ledger.applyReceipt(early, live.from)).toEqual({ ok: true, delivery: "duplicate", ack: early.receiptId });
  const stop = stoppedReceipt(live.runId);
  expect(ledger.applyReceipt(stop, live.from)).toEqual({ ok: true, delivery: "new", ack: stop.receiptId });
  const report = resultReport(live.runId);
  expect(ledger.recordReport(report, live.from)).toEqual({ ok: true, delivery: "new", ack: report.reportId });
  expect(run(ledger, live.runId)).toMatchObject({ state: "not_started", startedReceiptId: early.receiptId, stopReceiptId: null, resultDigest: null });
  expect(ledger.slotHolds()).toEqual({ known: true, value: [] });
  expect(slotFree(ledger)).toBe(true);
  // 다른 ID의 시작 영수증은 닫은 뒤의 시작이다.
  const second = startedReceipt(live);
  expect(ledger.applyReceipt(second, live.from)).toMatchObject({ ok: true, delivery: "new", alarm: "closed_run_started" });
  expect(slotFree(ledger)).toBe(false);
});

// ---- 이관 ----

test("이관: 판 1~6의 장부가 판 7로 올라가고 기존 줄은 그대로이며, 판 7의 장부는 판 6까지만 아는 코드로 열지 않는다", () => {
  expect(VERSION).toBe(7);
  for (let version = 1; version < VERSION; version++) {
    const path = tempPath();
    const before = ready(open(path, { migrations: loadMigrations().slice(0, version) }));
    const live = startedWorker(before);
    must(before.applyReceipt(startedReceipt(live), live.from));
    before.close();
    const tables = ["runs", "instructions", "deliveries", "slot_holds", "stop_state", "run_epoch", "run_transitions"];
    const columns = tables.map((table) => (rows(path, `PRAGMA table_info(${table})`) as { name: string }[]).map((column) => column.name).join(", "));
    const kept = () => tables.map((table, index) => rows(path, `SELECT ${columns[index]} FROM ${table}`));
    const old = kept();
    const upgraded = openLedger(path, { clock, mode: "reopen" });
    expect(upgraded, `판 ${version}`).toMatchObject({ ok: true, migrated: { from: version, to: VERSION } });
    if (upgraded.ok) upgraded.ledger.close();
    const now = kept();
    expect(now.slice(0, -1), `판 ${version}`).toEqual(old.slice(0, -1));
    expect(now.at(-1), `판 ${version}`).toEqual(expect.arrayContaining(old.at(-1) as unknown[]));
    expect(rows(path, "SELECT count(*) AS n FROM operator_closures")).toEqual([{ n: 0 }]);
    expect(rows(path, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  }
  // 판 6 장부를 7로 올리면 판 6까지의 객체 가운데 정의가 바뀌는 것은 상태 트리거 하나다.
  const path = tempPath();
  open(path, { migrations: loadMigrations().slice(0, VERSION - 1) }).close();
  const objects = () => new Map((rows(path, "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL") as { name: string; sql: string }[]).map((o) => [o.name, o.sql]));
  const six = objects();
  open(path).close();
  const seven = objects();
  expect([...six].filter(([name, sql]) => seven.get(name) !== sql).map(([name]) => name)).toEqual(["runs_not_started_needs_closure"]);
  // 정의(sql)가 있는 새 객체 전부. WITHOUT ROWID 표의 기본 키는 따로 인덱스가 없어 여기 없다.
  expect([...seven.keys()].filter((name) => !six.has(name)).sort()).toEqual([
    "operator_closures",
    "operator_closures_close_run",
    "operator_closures_fixed",
    "operator_closures_permanent",
    "operator_closures_proven",
    "unreceived_closures_exclusive",
  ]);
  expect(rows(path, "SELECT kind, from_state, to_state FROM run_transitions WHERE to_state = 'not_started' ORDER BY kind, from_state")).toEqual([
    { kind: "session", from_state: "queued", to_state: "not_started" },
    { kind: "worker", from_state: "preparing", to_state: "not_started" },
    { kind: "worker", from_state: "queued", to_state: "not_started" },
    { kind: "worker", from_state: "stopping", to_state: "not_started" },
    { kind: "worker", from_state: "unknown_running", to_state: "not_started" },
  ]);
  expect(openLedger(path, { clock, mode: "reopen", migrations: loadMigrations().slice(0, VERSION - 1) })).toMatchObject({ ok: false, reason: "too_new" });
});

test("복원의 점유가 있는 실행도 관리자 닫기는 받고, 점유는 그대로 그 종류의 자리를 막는다", () => {
  const ledger = ready(open(tempPath()));
  const lost = lostAfterStart(ledger);
  must(ledger.holdSlots(RESTORE_KEY, [{ executorId: WORKER_EXECUTOR, runId: lost.runId, kind: "worker", runGeneration: 1, holdsSlot: true, why: "state" }], NOW));
  must(closeOp(ledger, lost.runId));
  expect(run(ledger, lost.runId).state).toBe("not_started");
  expect(slotFree(ledger)).toBe(false);
});

// ---- 받은 시작이 아직 뜰 수 있는 동안은 닫지 않는다 ----

test("마지막 시각: 받은 시작이 아직 뜰 수 있는 stopping은 두 방법 모두 거절이고 아무것도 쓰지 않으며 다음 실행은 시작하지 못한다(접수 영수증 있음·없음)", () => {
  for (const receipt of [true, false]) {
    for (const checkedBy of ["process_absent", "pod_replaced"] as const) {
      const path = tempPath();
      const ledger = ready(open(path));
      const live = stoppingAfterAccepted(ledger, receipt);
      const before = run(ledger, live.runId);
      expect(before.state, `${receipt} ${checkedBy}`).toBe("stopping");
      expect(closeOp(ledger, live.runId, { checkedBy, now: NOW + 2 })).toEqual({ ok: false, reason: "start_may_launch" });
      expect(run(ledger, live.runId)).toEqual(before);
      expect(slotFree(ledger)).toBe(false);
      expect(ledger.operatorClosure(live.runId)).toEqual({ known: true, value: null });
      const next = must(ledger.admitRun(worker())).run.runId;
      expect(ledger.startRun({ runId: next, requestId: id(), stopGeneration: 0, now: NOW + 3 })).toEqual({ ok: false, reason: "slot_busy" });
      ledger.close();
      expect(rows(path, "SELECT count(*) AS n FROM operator_closures")).toEqual([{ n: 0 }]);
    }
  }
});

test("마지막 시각: 정각(띄울 수 있는 마지막 시각)은 거절, 1ms 뒤는 닫히고 그 실행의 시작은 다시 나가지 않는다(stopping·unknown_running)", () => {
  const cases: ["stopping" | "unknown_running", (ledger: Ledger) => { runId: string }][] = [
    ["stopping", (ledger) => stoppingAfterAccepted(ledger, true)],
    ["unknown_running", lostAfterStart],
  ];
  for (const [state, make] of cases) {
    for (const checkedBy of ["process_absent", "pod_replaced"] as const) {
      const ledger = ready(open(tempPath()));
      const live = make(ledger);
      expect(run(ledger, live.runId).state).toBe(state);
      expect(closeOp(ledger, live.runId, { checkedBy, now: CLOSABLE_AT - 1 }), `${state} ${checkedBy}`).toEqual({ ok: false, reason: "start_may_launch" });
      expect(run(ledger, live.runId).state).toBe(state);
      expect(must(closeOp(ledger, live.runId, { checkedBy, now: CLOSABLE_AT })).run).toMatchObject({ state: "not_started", updatedAt: CLOSABLE_AT });
      expect(slotFree(ledger)).toBe(true);
      const unanswered = ledger.unansweredInstructions();
      expect(unanswered.known && unanswered.value.instructions.map((i) => i.runId)).toEqual([]);
    }
  }
});

test("마지막 시각: 띄우기 전에 낸 갱신은 그 갱신의 발행 + 시한까지 닫기를 미룬다", () => {
  const ledger = ready(open(tempPath()));
  const live = startedWorker(ledger);
  const renewAt = NOW + 10_000;
  must(ledger.recordRenewInstruction({ runId: live.runId, requestId: id(), stopGeneration: 0, now: renewAt }));
  must(ledger.recordStopInstruction({ runId: live.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: renewAt + 1, reason: "requested" }));
  expect(closeOp(ledger, live.runId, { now: CLOSABLE_AT })).toEqual({ ok: false, reason: "start_may_launch" });
  expect(closeOp(ledger, live.runId, { now: CLOSABLE_AT + 10_000 - 1 })).toEqual({ ok: false, reason: "start_may_launch" });
  expect(run(ledger, live.runId).state).toBe("stopping");
  expect(must(closeOp(ledger, live.runId, { now: CLOSABLE_AT + 10_000 })).run.state).toBe("not_started");
});

// ---- D-94: 받은 적 없는 실행도 관리자가 닫을 수 있고, 그 기록은 늘 실패다 ----

test("D-94: 자동 닫기 조건이 맞는 실행을 자동 닫기와 관리자 닫기로 닫으면 단계·관리자 표시·같은 입력의 더 큰 예산이 갈리고, 두 닫기는 서로를 막는다", () => {
  // 리뷰의 입력: 영수증·송신 표식·감액·사본이 없는 작업 부탁을 시작하고 끊김으로 unknown_running, 지정 실행기의 빈 전체 답.
  const make = () => {
    const ledger = ready(open(tempPath()));
    const owner = id();
    must(ledger.enqueueInput({ requestId: owner, source: "admin-dm", sourceRef: { ref: `inbox/${owner}`, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
    const ref = id();
    must(ledger.recordToolRequest({ ref, owner, dedupeKey: `start_worker:${owner}:${ref}`, role: "diagnosis", purpose: "diagnose", sourceRef: `inbox/${owner}`, inputDigest: digest("in"), sessionId: "session-1", callId: id(), now: NOW }));
    const w = worker();
    const runId = id();
    must(ledger.assignToolRequest({ ref, runId, snapshotDigest: w.snapshotDigest as string, profileRevision: w.profileRevision, policyRevision: w.policyRevision, executorId: w.executorId, credential: w.credential, deadlineAt: w.deadlineAt, budgetLeft: 10, now: NOW }));
    must(ledger.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
    must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
    return { ledger, owner, ref, runId };
  };
  const unreceivedInput = { runs: [], answeredAt: NOW + 30_000, receivedAt: NOW + 30_001, now: NOW + 30_002 };
  const auto = make();
  const byOperator = make();
  must(auto.ledger.closeUnreceivedRun({ runId: auto.runId, ...unreceivedInput }, { sender: WORKER_EXECUTOR }));
  must(closeOp(byOperator.ledger, byOperator.runId, { now: CLOSABLE_AT }));
  // 반대 순서의 닫기는 거절이다.
  expect(closeOp(auto.ledger, auto.runId)).toEqual({ ok: false, reason: "run_ended" });
  expect(byOperator.ledger.closeUnreceivedRun({ runId: byOperator.runId, ...unreceivedInput }, { sender: WORKER_EXECUTOR })).toEqual({ ok: false, reason: "transition_denied" });
  for (const [c, phase, closedByOperator, startsNext] of [
    [auto, "not_started", false, true],
    [byOperator, "failed_stopped", true, false],
  ] as const) {
    const label = phase;
    const read = c.ledger.readToolRequest({ owner: c.owner, ref: c.ref });
    expect(read.known && read.value?.phase, label).toBe(phase);
    const next = must(c.ledger.admitRun(worker({ inputRequestId: c.owner, budgetLeft: 12 }))).run.runId;
    const queue = c.ledger.queueView();
    const all = c.ledger.listRuns();
    const holds = c.ledger.slotHolds();
    if (!queue.known || !all.known || !holds.known) throw new Error("장부를 읽지 못함");
    expect(all.value.map((r) => [r.runId, r.state, r.closedByOperator]), label).toEqual([
      [c.runId, "not_started", closedByOperator],
      [next, "queued", undefined],
    ]);
    const bars = new Map(queue.value.runs.map((r) => [r.runId, r.startBar]));
    const view: SchedulerView = {
      runs: all.value.map((r) => ({ ...r, startBar: bars.get(r.runId) ?? null })),
      inputs: [{ requestId: c.owner, origin: "admin", receivedAt: NOW, expiresAt: NOW + 3_600_000, cancelled: false }],
      slotHolds: holds.value,
      now: NOW + 40_000,
    };
    const decision = planNext(view, { alertMaxWaitMs: 60_000 });
    if (startsNext) {
      expect(decision.candidates.map((x) => x.runId), label).toEqual([next]);
      expect(c.ledger.startRun({ runId: next, requestId: id(), stopGeneration: 0, now: NOW + 40_000 }), label).toMatchObject({ ok: true, run: { state: "preparing", budgetLeft: 12 } });
    } else {
      expect(decision, label).toEqual({ candidates: [], held: [{ runId: next, kind: "worker", reason: "budget_replenished" }] });
    }
  }
});

// ---- 닫기 전에 받은 미반영 보고 ----

test("닫기 전에 받은 결과 보고는 닫는 트랜잭션에서 반영하지 않고 마치고, 다시 연 장부에서 같은 보고의 재전송은 duplicate다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  must(ledger.applyReceipt(accepted(live), live.from));
  must(ledger.applyReceipt(startedReceipt(live), live.from));
  const report = resultReport(live.runId);
  expect(ledger.recordReport(report, live.from)).toEqual({ ok: true, delivery: "new", ack: report.reportId });
  expect(ledger.pendingReports()).toMatchObject({ known: true, value: [{ reportId: report.reportId }] });
  must(ledger.recordStopInstruction({ runId: live.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW + 1, reason: "requested" }));
  must(closeOp(ledger, live.runId, { now: LATER + 2 }));
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  ledger.close();
  expect(rows(path, "SELECT applied_at FROM deliveries WHERE id = ?", report.reportId)).toEqual([{ applied_at: LATER + 2 }]);
  const reopened = ready(open(path));
  expect(reopened.recordReport(report, live.from)).toEqual({ ok: true, delivery: "duplicate", ack: report.reportId });
  expect(reopened.pendingReports()).toEqual({ known: true, value: [] });
});
