// D-91·D-93·D-96·D-97: 새 작업자 파드가 닫을 수 있게 되는 시각 뒤에 떴고 그 시각을 근거에 남긴 뒤에만, 종료가 확인되지 않은 작업자
// 실행을 "실패로 끝남"으로 닫는다(판 0007-operator-closure).
// 실제 장부 파일에 적고, 공개 읽기와 원 SQL로 본다. 파드 이름·ID·digest·시각은 이 시험이 지어낸 값이다. 운영값이 아니다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type Envelope, limits, sealEnvelope } from "../../src/contract/v1/index.ts";
import { type Ledger, LedgerInputError, loadMigrations, openLedger } from "../../src/ledger/index.ts";
import { type OperatorClosureInput, RESTORE_KEY } from "../../src/ledger/ledger.ts";
import { type AssignLoopPolicy, type AssignLoopPorts, assignAndStartTick } from "../../src/supervisor/dispatch/assign-loop.ts";
import { type ResendPorts, resendTick } from "../../src/supervisor/dispatch/resend.ts";
import { planNext, type SchedulerView } from "../../src/supervisor/scheduler/queue.ts";
import { clock, digest, id, must, NOW, open, ready, session, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "./helpers.ts";

const FILE = "0007-operator-closure.sql";
const VERSION = loadMigrations().findIndex((m) => m.name === FILE) + 1;
const POD = "worker-diagnosis-7f9c-x2kq";
const LATER = NOW + 60_000;

// 새 파드가 뜬 시각(podStartedAt)은 따로 주지 않으면 닫는 시각과 같다(닫는 그 시각에 뜬 파드: 두 시각 조건을 함께 지난다).
// 파드의 시각만 따로 보는 시험은 그 값을 준다.
function closeOp(ledger: Ledger, runId: string, extra: Partial<OperatorClosureInput> = {}) {
  const now = extra.now ?? LATER;
  return ledger.closeRunByOperator({ runId, checkedBy: "pod_replaced", podName: POD, podStartedAt: now, now, ...extra });
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

// 원 SQL의 근거 줄. 마지막 값은 closed_at이다(시작 발행 NOW부터 닫을 수 있게 되는 시각이 지난 LATER를 기본으로 넘긴다).
// pod_started_at에는 closed_at과 같은 값이 들어간다(?6). 파드의 시각을 따로 주는 시험은 RAW_OPERATOR_POD를 쓴다.
const RAW_OPERATOR = "INSERT INTO operator_closures (run_id, from_state, checked_by, pod_name, stop_generation, closed_at, pod_started_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)";
// 마지막 값이 pod_started_at이다.
const RAW_OPERATOR_POD = "INSERT INTO operator_closures (run_id, from_state, checked_by, pod_name, stop_generation, closed_at, pod_started_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
// 원 SQL의 세 INSERT 방식. OR IGNORE는 NOT NULL·CHECK 위반을 예외 없이 0줄로 끝내므로, 트리거가 스스로 거절하는지는 셋 모두로 본다.
const INSERT_MODES = ["INSERT", "INSERT OR REPLACE", "INSERT OR IGNORE"] as const;
// 시작 지시를 NOW에 낸 실행을 관리자가 닫을 수 있게 되는 첫 시각(감독의 시계): 발행 + 두 시한의 큰 쪽 + 시계 오차.
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
  expect(closed.closure).toEqual({ runId: lost.runId, fromState: "unknown_running", checkedBy: "pod_replaced", podName: POD, podStartedAt: LATER, stopGeneration: 0, closedAt: LATER });
  expect(slotFree(ledger)).toBe(true);

  const stopping = startedWorker(ledger);
  must(ledger.recordStopInstruction({ runId: stopping.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  expect(run(ledger, stopping.runId).state).toBe("stopping");
  expect(must(closeOp(ledger, stopping.runId)).closure).toMatchObject({ fromState: "stopping", checkedBy: "pod_replaced" });
  expect(ledger.operatorClosure(stopping.runId)).toEqual({ known: true, value: { runId: stopping.runId, fromState: "stopping", checkedBy: "pod_replaced", podName: POD, podStartedAt: LATER, stopGeneration: 0, closedAt: LATER } });
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
    { checkedBy: "process_absent" as never },
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
  expect(() => ledger.closeRunByOperator({ runId: lost.runId, checkedBy: "pod_replaced", podName: POD, podStartedAt: LATER, now: LATER, note: "x" } as never)).toThrow(LedgerInputError);
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
  // 꼴 밖의 근거: 방법, 파드 이름(가운데·끝의 U+0000 포함), 앞 상태, 정지 세대, 닫을 수 있게 되는 시각 전, NULL.
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
  rawWrite(stopping.path, RAW_OPERATOR, stopping.runId, "stopping", "pod_replaced", POD, 0, CLOSABLE_AT);
  expect(rows(stopping.path, "SELECT r.state, r.updated_at, o.from_state FROM runs r JOIN operator_closures o ON o.run_id = r.run_id")).toEqual([
    { state: "not_started", updated_at: CLOSABLE_AT, from_state: "stopping" },
  ]);
  // 근거는 고치거나 지우거나 바꿔 넣지 못한다.
  expect(() => rawWrite(stopping.path, "UPDATE operator_closures SET pod_name = 'other'")).toThrow("operator_closure_unproven");
  expect(() => rawWrite(stopping.path, "DELETE FROM operator_closures")).toThrow("operator_closure_unproven");
  expect(() => rawWrite(stopping.path, RAW_OPERATOR.replace("INSERT", "INSERT OR REPLACE"), stopping.runId, "stopping", "pod_replaced", "worker-other-0", 0, LATER)).toThrow("operator_closure_unproven");
  expect(rows(stopping.path, "SELECT run_id, checked_by, pod_name, closed_at FROM operator_closures")).toEqual([{ run_id: stopping.runId, checked_by: "pod_replaced", pod_name: POD, closed_at: CLOSABLE_AT }]);
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
    expect(() => raw.query(RAW_OPERATOR).run(blocked.runId, "stopping", "pod_replaced", POD, 0, LATER)).toThrow("test_block_close");
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
  expect(() => rawWrite(confirmed.path, RAW_OPERATOR, confirmed.runId, "stopping", "pod_replaced", POD, 0, LATER)).toThrow("operator_closure_unproven");
  expect(rows(confirmed.path, "SELECT state, stop_receipt_id FROM runs WHERE run_id = ?", confirmed.runId)).toEqual([{ state: "stopping", stop_receipt_id: receiptId }]);
  expect(rows(confirmed.path, "SELECT count(*) AS n FROM operator_closures")).toEqual([{ n: 0 }]);
  // 이관의 시각 숫자는 계약의 두 시한의 큰 쪽 + 시계 오차와 같다(장부의 코드는 같은 식을 쓴다).
  const sql = (rows(confirmed.path, "SELECT sql FROM sqlite_master WHERE name = 'operator_closures_proven'") as { sql: string }[])[0]?.sql ?? "";
  expect([...sql.matchAll(/\+ (\d+)\)/g)].map((m) => Number(m[1]))).toEqual([CLOSABLE_AT - NOW, CLOSABLE_AT - NOW]);
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

test("마지막 시각: 받은 시작이 아직 뜰 수 있는 stopping은 거절이고 아무것도 쓰지 않으며 다음 실행은 시작하지 못한다(접수 영수증 있음·없음, 뺀 확인 방법은 꼴 밖)", () => {
  for (const receipt of [true, false]) {
    const path = tempPath();
    const ledger = ready(open(path));
    const live = stoppingAfterAccepted(ledger, receipt);
    const before = run(ledger, live.runId);
    expect(before.state, `${receipt}`).toBe("stopping");
    expect(closeOp(ledger, live.runId, { now: NOW + 2 })).toEqual({ ok: false, reason: "start_may_launch" });
    expect(() => closeOp(ledger, live.runId, { checkedBy: "process_absent" as never, now: NOW + 2 })).toThrow(LedgerInputError);
    expect(run(ledger, live.runId)).toEqual(before);
    expect(slotFree(ledger)).toBe(false);
    expect(ledger.operatorClosure(live.runId)).toEqual({ known: true, value: null });
    const next = must(ledger.admitRun(worker())).run.runId;
    expect(ledger.startRun({ runId: next, requestId: id(), stopGeneration: 0, now: NOW + 3 })).toEqual({ ok: false, reason: "slot_busy" });
    ledger.close();
    expect(rows(path, "SELECT count(*) AS n FROM operator_closures")).toEqual([{ n: 0 }]);
  }
});

test("마지막 시각: 닫을 수 있게 되는 시각의 1ms 전은 거절, 정각은 닫히고 그 실행의 시작은 다시 나가지 않는다(stopping·unknown_running, 뺀 확인 방법은 정각 뒤에도 꼴 밖)", () => {
  const cases: ["stopping" | "unknown_running", (ledger: Ledger) => { runId: string }][] = [
    ["stopping", (ledger) => stoppingAfterAccepted(ledger, true)],
    ["unknown_running", lostAfterStart],
  ];
  for (const [state, make] of cases) {
    const ledger = ready(open(tempPath()));
    const live = make(ledger);
    expect(run(ledger, live.runId).state).toBe(state);
    expect(closeOp(ledger, live.runId, { now: CLOSABLE_AT - 1 }), state).toEqual({ ok: false, reason: "start_may_launch" });
    expect(() => closeOp(ledger, live.runId, { checkedBy: "process_absent" as never, now: CLOSABLE_AT })).toThrow(LedgerInputError);
    expect(run(ledger, live.runId).state).toBe(state);
    expect(must(closeOp(ledger, live.runId, { now: CLOSABLE_AT })).run).toMatchObject({ state: "not_started", updatedAt: CLOSABLE_AT });
    expect(slotFree(ledger)).toBe(true);
    const unanswered = ledger.unansweredInstructions();
    expect(unanswered.known && unanswered.value.instructions.map((i) => i.runId)).toEqual([]);
  }
});

test("D-96: 확인 방법은 pod_replaced 하나이고, process_absent는 목록 밖의 값과 같이 연산과 원 SQL(세 INSERT 방식) 모두 거절이며 아무것도 쓰지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const lost = lostAfterStart(ledger);
  for (const checkedBy of ["process_absent", "looked"]) expect(() => closeOp(ledger, lost.runId, { checkedBy: checkedBy as never }), checkedBy).toThrow(LedgerInputError);
  ledger.close();
  for (const mode of INSERT_MODES) {
    for (const checkedBy of ["process_absent", "looked"]) {
      expect(() => rawWrite(path, RAW_OPERATOR.replace("INSERT", mode), lost.runId, "unknown_running", checkedBy, POD, 0, LATER), `${mode} ${checkedBy}`).toThrow("operator_closure_unproven");
    }
  }
  expect(rows(path, "SELECT count(*) AS n FROM operator_closures")).toEqual([{ n: 0 }]);
  expect(rows(path, "SELECT state FROM runs WHERE run_id = ?", lost.runId)).toEqual([{ state: "unknown_running" }]);
  rawWrite(path, RAW_OPERATOR, lost.runId, "unknown_running", "pod_replaced", POD, 0, LATER);
  expect(rows(path, "SELECT r.state, o.checked_by FROM runs r JOIN operator_closures o ON o.run_id = r.run_id")).toEqual([{ state: "not_started", checked_by: "pod_replaced" }]);
});

// 원 SQL로 만든 작업자 stopping: 공개 시작(startRun)을 거치지 않아 task_start 지시가 없고, 전이표의 간선만 지난다.
// instruction이 null이 아니면 그 동작의 지시 한 줄을 시작 발행 자리(NOW)에 넣는다.
function stoppingWithoutStart(instruction: "run_renew" | "session_start" | null) {
  const path = tempPath();
  const ledger = ready(open(path));
  const runId = must(ledger.admitRun(worker())).run.runId;
  ledger.close();
  rawWrite(path, "UPDATE runs SET state = 'preparing' WHERE run_id = ?", runId);
  rawWrite(path, "UPDATE runs SET state = 'stopping' WHERE run_id = ?", runId);
  if (instruction !== null) rawWrite(path, "INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, ?, 0, ?)", id(), runId, instruction, NOW);
  return { path, runId };
}

test("마지막 시각: 그 실행의 task_start 지시가 없으면 갱신 한 줄이나 세션 시작 한 줄이 있어도 닫지 않는다(원 SQL 세 INSERT 방식과 연산)", () => {
  for (const instruction of [null, "run_renew", "session_start"] as const) {
    const made = stoppingWithoutStart(instruction);
    expect(rows(made.path, "SELECT count(*) AS n FROM instructions WHERE run_id = ? AND action = 'task_start'", made.runId)).toEqual([{ n: 0 }]);
    for (const mode of INSERT_MODES) {
      expect(() => rawWrite(made.path, RAW_OPERATOR.replace("INSERT", mode), made.runId, "stopping", "pod_replaced", POD, 0, LATER), `${instruction} ${mode}`).toThrow("operator_closure_unproven");
    }
    expect(rows(made.path, "SELECT state, (SELECT count(*) FROM operator_closures) AS n FROM runs WHERE run_id = ?", made.runId)).toEqual([{ state: "stopping", n: 0 }]);
    const reopened = ready(open(made.path));
    expect(closeOp(reopened, made.runId), `${instruction}`).toEqual({ ok: false, reason: "start_may_launch" });
    expect(run(reopened, made.runId).state).toBe("stopping");
    expect(slotFree(reopened)).toBe(false);
    reopened.close();
    expect(rows(made.path, "SELECT count(*) AS n FROM operator_closures")).toEqual([{ n: 0 }]);
  }
});

test("원 SQL: 정지 기록이 없거나 입력의 정지 세대가 NULL이면 세 INSERT 방식 모두 트리거가 거절한다(예외 없이 0줄로 끝나지 않는다)", () => {
  // 정지 기록이 있는 장부: 시작 뒤 취소를 적은 stopping(영수증 없음: 실행 줄을 새 장부에 queued로 옮길 수 있다).
  const source = tempPath();
  const ledger = ready(open(source));
  const live = stoppingAfterAccepted(ledger, false);
  ledger.close();
  // 정지 기록이 없는 장부: 새 장부에 같은 실행 줄(queued로)과 지시를 옮기고 전이표의 간선으로 stopping까지 간다.
  const bare = tempPath();
  open(bare).close();
  const raw = new Database(bare);
  try {
    raw.run("PRAGMA foreign_keys = ON");
    raw.query("ATTACH DATABASE ? AS fixture").run(source);
    const row = raw.query("SELECT * FROM fixture.runs WHERE run_id = ?").get(live.runId) as Record<string, string | number | null>;
    row.state = "queued";
    const names = Object.keys(row);
    raw.query(`INSERT INTO main.runs (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
    raw.query("INSERT INTO main.instructions SELECT * FROM fixture.instructions WHERE run_id = ?").run(live.runId);
    raw.query("UPDATE main.runs SET state = 'preparing' WHERE run_id = ?").run(live.runId);
    raw.query("UPDATE main.runs SET state = 'stopping' WHERE run_id = ?").run(live.runId);
    raw.run("DETACH DATABASE fixture");
  } finally {
    raw.close();
  }
  expect(rows(bare, "SELECT count(*) AS n FROM stop_state")).toEqual([{ n: 0 }]);
  const cases: [string, number | null][] = [
    [bare, 0],
    [bare, null],
    [source, null],
  ];
  for (const [path, generation] of cases) {
    for (const mode of INSERT_MODES) {
      const label = `${path === bare ? "정지 기록 없음" : "정지 기록 있음"} ${generation} ${mode}`;
      expect(() => rawWrite(path, RAW_OPERATOR.replace("INSERT", mode), live.runId, "stopping", "pod_replaced", POD, generation, LATER), label).toThrow("operator_closure_unproven");
      expect(rows(path, "SELECT state, (SELECT count(*) FROM operator_closures) AS n FROM runs WHERE run_id = ?", live.runId), label).toEqual([{ state: "stopping", n: 0 }]);
    }
  }
  // 대조: 정지 기록이 있고 세대가 맞으면 같은 줄이 들어가 닫힌다.
  rawWrite(source, RAW_OPERATOR, live.runId, "stopping", "pod_replaced", POD, 0, LATER);
  expect(rows(source, "SELECT state FROM runs WHERE run_id = ?", live.runId)).toEqual([{ state: "not_started" }]);
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

// 배정 박자의 포트. 연결 후보가 없어 시작 봉투를 봉하거나 보내지 않는다(장부의 시작 기록까지만 본다). 배정할 부탁도 없어 사실·자격은 읽지 않는다.
function tickPorts(ledger: Ledger): AssignLoopPorts {
  return {
    ledger,
    intake: { intakeOpen: () => true, stopGeneration: () => 0 },
    connections: { candidates: () => ({ known: true, value: [] }) },
    withheld: { executors: () => ({ known: true, value: [] }) },
    facts: {
      facts: () => {
        throw new Error("배정할 부탁이 없다");
      },
    },
    credentials: { reference: async () => ({ known: false }) },
    random: { bytes: (length) => getRandomValues(new Uint8Array(length)) },
    signer: {
      seal: () => {
        throw new Error("봉하지 않는다");
      },
    },
    sink: { send: async () => "no_connection" },
  };
}
const TICK_POLICY: AssignLoopPolicy = {
  assignment: { allowed: [], registrations: [], expected: { profile_revision: "profile-1", policy_revision: "policy-1" } },
  accounts: [],
  plans: [],
  queue: { alertMaxWaitMs: 60_000 },
  originOf: (source) => (source === "admin-dm" ? "admin" : undefined),
};

test("D-94: 자동 닫기 조건이 맞는 실행을 자동 닫기와 관리자 닫기로 닫으면 단계·관리자 표시·같은 입력의 더 큰 예산이 갈리고, 두 닫기는 서로를 막는다", async () => {
  // 리뷰의 입력: 영수증·송신 표식·감액·사본이 없는 작업 부탁을 시작하고 끊김으로 unknown_running, 지정 실행기의 빈 전체 답을 두 장부에 적용.
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
    must(ledger.applyExecutorAnswer({ coverage: "full", runs: [], answeredAt: NOW + 30_000, now: NOW + 30_001 }, { sender: WORKER_EXECUTOR }));
    expect(run(ledger, runId).state).toBe("unknown_running");
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
    } else {
      expect(decision, label).toEqual({ candidates: [], held: [{ runId: next, kind: "worker", reason: "budget_replenished" }] });
    }
    // 실제 배정 박자: 자동 쪽은 새 시작 하나(preparing, 예산 12), 관리자 쪽은 새 시작 0(queued 그대로).
    const tick = await assignAndStartTick(tickPorts(c.ledger), TICK_POLICY, NOW + 40_000);
    if (tick.kind !== "ran") throw new Error(`박자가 돌지 않음: ${JSON.stringify(tick)}`);
    expect(tick.starts.map((s) => s.runId), label).toEqual(startsNext ? [next] : []);
    expect(run(c.ledger, next), label).toMatchObject(startsNext ? { state: "preparing", budgetLeft: 12 } : { state: "queued", budgetLeft: 12 });
    const after = c.ledger.readToolRequest({ owner: c.owner, ref: c.ref });
    expect(after.known && after.value?.phase, label).toBe(phase);
  }
});

test("원 SQL 근거 한 문장으로 닫아도 그 실행의 미반영 보고는 마쳐지고(다시 연 장부의 처리 목록에 없음), 다른 실행의 보고는 그대로다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  const report = resultReport(live.runId);
  must(ledger.recordReport(report, live.from));
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  const other = must(ledger.admitRun(worker())).run.runId;
  ledger.close();
  // 다른 실행의 미반영 결과 보고(원 SQL).
  const otherReport = id();
  rawWrite(path, "INSERT INTO deliveries (id, action, run_id, body_digest, stored_ref, result_digest, received_at) VALUES (?, 'report_result', ?, ?, ?, ?, ?)", otherReport, other, digest("other"), `results/${id()}`, digest("o"), LATER);
  rawWrite(path, RAW_OPERATOR, live.runId, "unknown_running", "pod_replaced", POD, 0, LATER + 2);
  expect(rows(path, "SELECT id, applied_at FROM deliveries WHERE action = 'report_result' ORDER BY applied_at IS NULL")).toEqual([
    { id: report.reportId, applied_at: LATER + 2 },
    { id: otherReport, applied_at: null },
  ]);
  const reopened = ready(open(path));
  expect(run(reopened, live.runId).state).toBe("not_started");
  expect(reopened.pendingReports()).toMatchObject({ known: true, value: [{ reportId: otherReport, runId: other }] });
  expect(reopened.recordReport(report, live.from)).toEqual({ ok: true, delivery: "duplicate", ack: report.reportId });
  const pending = reopened.pendingReports();
  expect(pending.known && pending.value.map((p) => p.reportId)).toEqual([otherReport]);
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

// ---- D-97: 새 작업자 파드가 한도 뒤에 떴고 그 시각을 근거에 남긴 뒤에만 닫는다 ----

const keys = generateKeyPairSync("ed25519");

// 실제 재전송 박자 한 번(감독의 시각 at). 미응답 시작은 장부의 원래 발행 시각으로 봉해 내보낸다.
async function resendOnce(ledger: Ledger, at: number): Promise<Envelope[]> {
  const sent: Envelope[] = [];
  const ports: ResendPorts = {
    ledger,
    intake: { intakeOpen: () => true },
    links: { mayIssue: () => ({ ok: true }) },
    clock: { now: () => at },
    random: { bytes: (n) => getRandomValues(new Uint8Array(n)) },
    signer: { seal: (input) => sealEnvelope(input, keys.privateKey) },
    sink: {
      send: async (envelope) => {
        sent.push(envelope);
        return "sent";
      },
    },
  };
  await resendTick(ports, { resendEveryMs: 5_000 }, { lastResends: [] });
  return sent;
}

function rawChanges(path: string, sql: string, ...params: (string | number | bigint | null)[]): number {
  const raw = new Database(path);
  try {
    raw.run("PRAGMA foreign_keys = ON");
    return raw.query(sql).run(...params).changes;
  } finally {
    raw.close();
  }
}

const stateAndClosures = (path: string, runId: string) => rows(path, "SELECT state, (SELECT count(*) FROM operator_closures) AS n FROM runs WHERE run_id = ?", runId);

test("D-97: 닫기 전에 새 파드로 시작을 다시 실어 접수·시작 영수증을 받은 이력은 그 파드가 한도 전에 떴으면 닫지 않고(연산과 원 SQL 세 INSERT 방식), 한도 정각 이후에 뜬 파드면 닫힌다", async () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  // +5000에 뜬 새 파드의 실행기에 +6000의 재전송이 원래 발행 시각(NOW)을 실은 시작을 내고, 접수·시작 영수증이 온다.
  const sent = await resendOnce(ledger, NOW + 6_000);
  expect(sent.map((e) => [e.header.action, e.header.request_id, e.header.issued_at])).toEqual([["task_start", live.requestId, NOW]]);
  must(ledger.applyReceipt({ ...accepted(live), now: NOW + 6_001 }, live.from));
  const started = { ...startedReceipt(live), now: NOW + 7_000 };
  must(ledger.applyReceipt(started, live.from));
  const before = run(ledger, live.runId);
  expect(before).toMatchObject({ state: "unknown_running", startedReceiptId: started.receiptId });
  const at = CLOSABLE_AT + 1;
  const earlyPod = NOW + 5_000;
  for (const pod of [earlyPod, CLOSABLE_AT - 1]) expect(closeOp(ledger, live.runId, { podStartedAt: pod, now: at }), `${pod - NOW}`).toEqual({ ok: false, reason: "pod_started_too_early" });
  // 닫는 시각보다 늦은 파드의 시각, 시각이 아닌 값은 입력 오류다.
  for (const pod of [at + 1, 0, -1, 1.5, null, "1800000031000"]) expect(() => closeOp(ledger, live.runId, { podStartedAt: pod as never, now: at }), `${pod}`).toThrow(LedgerInputError);
  expect(() => ledger.closeRunByOperator({ runId: live.runId, checkedBy: "pod_replaced", podName: POD, now: at } as never)).toThrow(LedgerInputError);
  expect(run(ledger, live.runId)).toEqual(before);
  expect(ledger.operatorClosure(live.runId)).toEqual({ known: true, value: null });
  expect(slotFree(ledger)).toBe(false);
  ledger.close();
  for (const mode of INSERT_MODES) {
    for (const pod of [earlyPod, CLOSABLE_AT - 1, at + 1]) {
      expect(() => rawWrite(path, RAW_OPERATOR_POD.replace("INSERT", mode), live.runId, "unknown_running", "pod_replaced", POD, 0, at, pod), `${mode} ${pod - NOW}`).toThrow("operator_closure_unproven");
    }
  }
  expect(stateAndClosures(path, live.runId)).toEqual([{ state: "unknown_running", n: 0 }]);
  // 관리자가 파드를 한 번 더 바꿔 한도 정각에 뜬 파드면 닫힌다.
  const reopened = ready(open(path));
  const closed = must(closeOp(reopened, live.runId, { podStartedAt: CLOSABLE_AT, now: at }));
  expect(closed.closure).toEqual({ runId: live.runId, fromState: "unknown_running", checkedBy: "pod_replaced", podName: POD, podStartedAt: CLOSABLE_AT, stopGeneration: 0, closedAt: at });
  expect(reopened.operatorClosure(live.runId)).toEqual({ known: true, value: closed.closure });
  expect(slotFree(reopened)).toBe(true);
});

test("D-97: 사본에서 되살린 장부도 새 파드가 한도 전에 떴으면 닫지 않고, 한도 뒤에 뜬 파드면 원본이 낸 갱신을 몰라도 닫힌다(그 파드는 그 시작을 받을 수 없다)", async () => {
  let now = NOW;
  const source = tempPath();
  const ledger = ready(open(source, { clock: () => now }));
  const live = startedWorker(ledger);
  now = NOW + 1_000;
  const copy = tempPath();
  must(ledger.createSnapshot({ path: copy, maxBytes: 10_000_000 }));
  // 사본 뒤 원본에서: +6000에 새 파드(+5000에 뜸)로 시작을 다시 싣고 접수, +10000에 갱신.
  now = NOW + 6_000;
  expect((await resendOnce(ledger, now)).map((e) => e.header.issued_at)).toEqual([NOW]);
  must(ledger.applyReceipt({ ...accepted(live), now: now + 1 }, live.from));
  now = NOW + 10_000;
  must(ledger.recordRenewInstruction({ runId: live.runId, requestId: id(), stopGeneration: 0, now }));
  now = CLOSABLE_AT + 1;
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now }));
  expect(closeOp(ledger, live.runId, { podStartedAt: NOW + 5_000, now })).toEqual({ ok: false, reason: "start_may_launch" });
  ledger.close();
  const restored = open(copy, { clock: () => now });
  must(restored.markLostFor({ executorId: WORKER_EXECUTOR, now }));
  expect(run(restored, live.runId).state).toBe("unknown_running");
  expect(closeOp(restored, live.runId, { podStartedAt: NOW + 5_000, now })).toEqual({ ok: false, reason: "pod_started_too_early" });
  expect(run(restored, live.runId).state).toBe("unknown_running");
  expect(restored.operatorClosure(live.runId)).toEqual({ known: true, value: null });
  expect(slotFree(restored)).toBe(false);
  expect(must(closeOp(restored, live.runId, { podStartedAt: CLOSABLE_AT, now })).closure).toMatchObject({ podStartedAt: CLOSABLE_AT, closedAt: now });
});

test("D-97 원 SQL: 파드가 뜬 시각의 NULL·빈 값·소수·범위·한도 경계·닫은 시각과의 순서를 세 INSERT 방식으로 넣으면 한도 정각부터 닫은 시각까지만 한 줄로 닫힌다", () => {
  const fresh = () => {
    const p = tempPath();
    const l = ready(open(p));
    const s = lostAfterStart(l);
    l.close();
    return { path: p, runId: s.runId };
  };
  const MAX = 9007199254740991;
  // [이름, closed_at, pod_started_at]: 트리거가 거절한다.
  const refused: [string, number | null, number | string | null][] = [
    ["파드 NULL", LATER, null],
    ["파드 0", LATER, 0],
    ["파드 -1", LATER, -1],
    ["파드 한도 1ms 전", LATER, CLOSABLE_AT - 1],
    ["파드가 닫은 시각 1ms 뒤", LATER, LATER + 1],
    ["파드가 범위 끝, 닫은 시각보다 뒤", LATER, MAX],
    ["닫은 시각 NULL", null, LATER],
    ["닫은 시각 한도 1ms 전, 파드 한도 1ms 전", CLOSABLE_AT - 1, CLOSABLE_AT - 1],
  ];
  for (const mode of INSERT_MODES) {
    const made = fresh();
    for (const [label, closedAt, pod] of refused) {
      expect(() => rawChanges(made.path, RAW_OPERATOR_POD.replace("INSERT", mode), made.runId, "unknown_running", "pod_replaced", POD, 0, closedAt, pod), `${mode} ${label}`).toThrow("operator_closure_unproven");
    }
    // 정수가 아닌 값(빈 문자열, 소수)은 ANY 칸이 형을 그대로 넘겨 트리거가 OR IGNORE에서도 예외로 막는다.
    for (const [pod, kind] of [
      ["", "TEXT"],
      [CLOSABLE_AT + 0.5, "REAL"],
    ] as const) {
      expect(() => rawChanges(made.path, RAW_OPERATOR_POD.replace("INSERT", mode), made.runId, "unknown_running", "pod_replaced", POD, 0, LATER, pod), `${mode} ${kind}`).toThrow("operator_closure_unproven");
    }
    // 범위 위(안전 정수 + 1): 트리거를 지나 칸의 CHECK가 막고, OR IGNORE는 예외 없이 0줄이다(닫힌 것은 없다).
    for (const pod of [LATER, MAX + 1]) {
      const write = () => rawChanges(made.path, RAW_OPERATOR_POD.replace("INSERT", mode), made.runId, "unknown_running", "pod_replaced", POD, 0, BigInt(MAX) + 1n, BigInt(pod));
      if (mode === "INSERT OR IGNORE") expect(write(), `${mode} ${pod}`).toBe(0);
      else expect(write, `${mode} ${pod}`).toThrow("CHECK constraint failed");
    }
    expect(stateAndClosures(made.path, made.runId), mode).toEqual([{ state: "unknown_running", n: 0 }]);
  }
  // [closed_at, pod_started_at]: 한도 정각의 파드, 닫은 시각과 같은 파드는 한 줄로 닫힌다.
  for (const [closedAt, pod] of [
    [CLOSABLE_AT, CLOSABLE_AT],
    [LATER, CLOSABLE_AT],
    [LATER, LATER],
  ]) {
    for (const mode of INSERT_MODES) {
      const made = fresh();
      expect(rawChanges(made.path, RAW_OPERATOR_POD.replace("INSERT", mode), made.runId, "unknown_running", "pod_replaced", POD, 0, closedAt, pod), `${mode} ${closedAt - NOW} ${pod - NOW}`).toBe(1);
      expect(rows(made.path, "SELECT r.state, o.pod_started_at, o.closed_at FROM runs r JOIN operator_closures o ON o.run_id = r.run_id")).toEqual([{ state: "not_started", pod_started_at: pod, closed_at: closedAt }]);
    }
  }
});

test("원 SQL: 근거의 정수 칸 셋(pod_started_at·stop_generation·closed_at)은 들어온 형을 바꾸지 않아, 소수·정수 꼴·지수·공백의 TEXT와 REAL은 세 INSERT 방식 모두 트리거가 거절하고 정수만 정수로 남는다", () => {
  const MAX = 9007199254740991;
  const valid = { pod_started_at: CLOSABLE_AT, stop_generation: 0, closed_at: LATER };
  type Column = keyof typeof valid;
  type Value = number | string | { real: number };
  // 정수가 아닌 형의 값. INTEGER 칸이었다면 두 갈래로 나뉜다: 소수 REAL(v + 0.5)은 BEFORE 트리거까지 오지 않고 STRICT 형 오류가
  // 나고, 정수 값 REAL과 정수로 바뀌는 TEXT(소수점·정수 꼴·지수·앞뒤 공백)는 칸의 형 변환(소수 부분이 있는 TEXT는 반올림) 뒤의
  // 정수로 트리거가 비교했다.
  // { real }은 정수와 같은 값의 REAL이다(JS 숫자로 넘기면 정수로 묶이므로 SQL에서 CAST로 만든다).
  const shapes = (v: number): [string, Value][] => [
    ["소수점 TEXT", `${v}.0`],
    ["정수 꼴 TEXT", String(v)],
    ["지수 TEXT", v.toExponential()],
    ["앞뒤 공백 TEXT", ` ${v} `],
    ["소수 REAL", v + 0.5],
    ["정수 값 REAL", { real: v }],
  ];
  const cases: [string, Partial<Record<Column, Value>>][] = [
    // 한도보다 0.0001ms 이른 파드: INTEGER 칸이면 한도 정각으로 반올림되어 닫힌다.
    ["파드 한도 0.0001ms 전 TEXT", { pod_started_at: `${CLOSABLE_AT - 1}.9999` }],
    // 범위 끝과 닫은 시각을 넘는 파드: INTEGER 칸이면 범위 끝 정수로 바뀌어 닫힌다.
    ["파드 범위 위 TEXT, 닫은 시각 범위 끝", { pod_started_at: "9007199254740991.1", closed_at: MAX }],
    ...(Object.keys(valid) as Column[]).flatMap((column) => shapes(valid[column]).map(([label, value]): [string, Partial<Record<Column, Value>>] => [`${column} ${label}`, { [column]: value }])),
  ];
  const fresh = () => {
    const p = tempPath();
    const l = ready(open(p));
    const s = lostAfterStart(l);
    l.close();
    return { path: p, runId: s.runId };
  };
  const insert = (mode: string, path: string, runId: string, values: Partial<Record<Column, Value>>) => {
    const row = { ...valid, ...values };
    const columns = Object.keys(valid) as Column[];
    const slots = columns.map((column) => (typeof row[column] === "object" ? "CAST(? AS REAL)" : "?"));
    const params = columns.map((column) => {
      const value = row[column];
      return typeof value === "object" ? value.real : value;
    });
    return rawChanges(path, `${mode} INTO operator_closures (run_id, from_state, checked_by, pod_name, ${columns.join(", ")}) VALUES (?, 'unknown_running', 'pod_replaced', ?, ${slots.join(", ")})`, runId, POD, ...params);
  };
  for (const mode of INSERT_MODES) {
    const made = fresh();
    for (const [label, values] of cases) {
      expect(() => insert(mode, made.path, made.runId, values), `${mode} ${label}`).toThrow("operator_closure_unproven");
      expect(stateAndClosures(made.path, made.runId), `${mode} ${label}`).toEqual([{ state: "unknown_running", n: 0 }]);
    }
    const reopened = ready(open(made.path));
    expect(run(reopened, made.runId).state, mode).toBe("unknown_running");
    expect(reopened.operatorClosure(made.runId), mode).toEqual({ known: true, value: null });
    expect(slotFree(reopened), mode).toBe(false);
    reopened.close();
  }
  // 정수는 그대로 받아 정수로 남는다.
  for (const mode of INSERT_MODES) {
    const made = fresh();
    expect(insert(mode, made.path, made.runId, {}), mode).toBe(1);
    expect(rows(made.path, "SELECT r.state, typeof(o.pod_started_at) AS p, typeof(o.stop_generation) AS g, typeof(o.closed_at) AS c, o.pod_started_at, o.stop_generation, o.closed_at FROM runs r JOIN operator_closures o ON o.run_id = r.run_id"), mode).toEqual([
      { state: "not_started", p: "integer", g: "integer", c: "integer", ...valid },
    ]);
  }
  // 칸의 선언만으로도 정수만 받는다: 이 장부 사본에서 BEFORE 트리거를 지우면 정수 꼴 TEXT와 정수 값 REAL은 칸의 CHECK가 막는다
  // (정수 값 REAL은 범위 비교만으로는 지난다).
  const bare = fresh();
  rawWrite(bare.path, "DROP TRIGGER operator_closures_proven");
  for (const column of Object.keys(valid) as Column[]) {
    for (const value of [{ real: valid[column] }, String(valid[column])]) {
      expect(() => insert("INSERT", bare.path, bare.runId, { [column]: value }), `${column} ${JSON.stringify(value)}`).toThrow(`CHECK constraint failed: typeof(${column}) = 'integer'`);
    }
  }
  expect(stateAndClosures(bare.path, bare.runId)).toEqual([{ state: "unknown_running", n: 0 }]);
});

test("작업자 실행에 session_start 지시가 섞인 이력은 시각과 상관없이 닫지 않는다(원 SQL 세 INSERT 방식과 연산)", () => {
  // 리뷰의 입력: startRun으로 NOW에 task_start, 취소로 stopping, 같은 실행의 session_start를 NOW + 10000에 원 SQL로 한 줄.
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  must(ledger.recordStopInstruction({ runId: live.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  ledger.close();
  rawWrite(path, "INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, 'session_start', 0, ?)", id(), live.runId, NOW + 10_000);
  const times = [CLOSABLE_AT, CLOSABLE_AT + 10_000, LATER + 60_000];
  for (const at of times) {
    for (const mode of INSERT_MODES) {
      expect(() => rawWrite(path, RAW_OPERATOR.replace("INSERT", mode), live.runId, "stopping", "pod_replaced", POD, 0, at), `${at - NOW} ${mode}`).toThrow("operator_closure_unproven");
    }
  }
  expect(stateAndClosures(path, live.runId)).toEqual([{ state: "stopping", n: 0 }]);
  const reopened = ready(open(path));
  for (const at of times) expect(closeOp(reopened, live.runId, { now: at }), `${at - NOW}`).toEqual({ ok: false, reason: "start_may_launch" });
  expect(run(reopened, live.runId).state).toBe("stopping");
  expect(slotFree(reopened)).toBe(false);
  reopened.close();
  expect(stateAndClosures(path, live.runId)).toEqual([{ state: "stopping", n: 0 }]);
});

// 정지 세대 7의 장부에서 시작 뒤 취소를 적은 작업자 stopping(영수증 없음). record가 false면 같은 실행 줄(queued로)과 지시를 정지 기록이
// 없는 새 장부로 옮겨 전이표의 간선으로 stopping까지 간다.
function stoppingAtGeneration7(record: boolean) {
  const source = tempPath();
  const ledger = open(source);
  must(ledger.applyStop({ generation: 7, stopped: false, now: NOW }));
  ready(ledger);
  const runId = must(ledger.admitRun(worker())).run.runId;
  must(ledger.startRun({ runId, requestId: id(), stopGeneration: 7, now: NOW }));
  must(ledger.recordStopInstruction({ runId, requestId: id(), action: "task_cancel", stopGeneration: 7, now: NOW + 1, reason: "requested" }));
  ledger.close();
  if (record) return { path: source, runId };
  const bare = tempPath();
  open(bare).close();
  const raw = new Database(bare);
  try {
    raw.run("PRAGMA foreign_keys = ON");
    raw.query("ATTACH DATABASE ? AS fixture").run(source);
    const row = raw.query("SELECT * FROM fixture.runs WHERE run_id = ?").get(runId) as Record<string, string | number | null>;
    row.state = "queued";
    const names = Object.keys(row);
    raw.query(`INSERT INTO main.runs (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
    raw.query("INSERT INTO main.instructions SELECT * FROM fixture.instructions WHERE run_id = ?").run(runId);
    raw.query("UPDATE main.runs SET state = 'preparing' WHERE run_id = ?").run(runId);
    raw.query("UPDATE main.runs SET state = 'stopping' WHERE run_id = ?").run(runId);
    raw.run("DETACH DATABASE fixture");
  } finally {
    raw.close();
  }
  return { path: bare, runId };
}

test("원 SQL: 정지 세대 7의 장부에서 정지 기록 없음·있음 × 입력 세대 NULL·7·0의 여섯 조합을 세 INSERT 방식으로 넣으면 기록 있음·7만 한 줄로 닫히고 나머지는 트리거가 거절한다", () => {
  const cases: [boolean, number | null][] = [
    [false, null],
    [false, 7],
    [false, 0],
    [true, null],
    [true, 7],
    [true, 0],
  ];
  for (const [record, generation] of cases) {
    for (const mode of INSERT_MODES) {
      const made = stoppingAtGeneration7(record);
      const label = `${record ? "정지 기록 7" : "정지 기록 없음"} / ${generation} / ${mode}`;
      expect(rows(made.path, "SELECT generation FROM stop_state"), label).toEqual(record ? [{ generation: 7 }] : []);
      const write = () => rawChanges(made.path, RAW_OPERATOR.replace("INSERT", mode), made.runId, "stopping", "pod_replaced", POD, generation, LATER);
      if (record && generation === 7) {
        expect(write(), label).toBe(1);
        expect(rows(made.path, "SELECT r.state, o.stop_generation FROM runs r JOIN operator_closures o ON o.run_id = r.run_id"), label).toEqual([{ state: "not_started", stop_generation: 7 }]);
      } else {
        expect(write, label).toThrow("operator_closure_unproven");
        expect(stateAndClosures(made.path, made.runId), label).toEqual([{ state: "stopping", n: 0 }]);
      }
    }
  }
});
