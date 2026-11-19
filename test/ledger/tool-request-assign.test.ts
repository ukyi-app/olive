// 작업 부탁을 실행 줄에 잇는 배정(assignToolRequest)과 이은 뒤의 읽기·취소. 실제 장부 파일에 적고, 처리기
// (src/supervisor/scheduler/tools.ts)의 장부 포트는 이 시험 안의 얇은 어댑터로 채워 실제 처리기 + 실제 장부로 돌린다.
// 세션 증거·입력 고정·결과 보관 포트는 다른 조각의 일이라 대역을 둔다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  type AssignToolRequestInput,
  LEDGER_RUN_STATES,
  type Ledger,
  LedgerInputError,
  type LedgerRunState,
  TOOL_REQUEST_RUN_PHASES,
  type ToolRequest,
  type ToolRequestInput,
} from "../../src/ledger/index.ts";
import { RESTORE_KEY } from "../../src/ledger/ledger.ts";
import { type Answer, handleToolCall, PHASES, type ToolAnswer, type ToolCallContext, type ToolPorts, type WorkRecord } from "../../src/supervisor/scheduler/tools.ts";
import { digest, from, id, must, NOW, open, ready, tempPath, worker } from "./helpers.ts";

// ID와 digest는 이 시험이 고른 값이다. 운영값이 아니다.
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const SRC_A = "inbox/aaaaaaaa-1111-4000-8000-000000000001";
const SRC_B = "inbox/bbbbbbbb-1111-4000-8000-000000000002";
const D1 = digest("input one");
const SESSION = { id: "session-1", generation: 1 };
const MISSING = "eeeeeeee-0000-4000-8000-00000000000e";

// 처리기가 만드는 재시도 키와 같은 꼴(tools.ts의 retryKeyOf).
const keyOf = (owner: string, purpose = "diagnose") => `start_worker:${owner}:${purpose}`;

// ---- 어댑터: 처리기의 장부 포트를 장부 함수로 채운다(test/ledger/tool-requests.test.ts와 같은 옮김) ----

const work = (r: ToolRequest): WorkRecord => ({
  ref: r.ref,
  owner: r.owner,
  retryKey: r.dedupeKey,
  content: { role: r.role, purpose: r.purpose, sourceRef: r.sourceRef, inputDigest: r.inputDigest },
  phase: r.phase,
});

function ports(ledger: Ledger): ToolPorts {
  const read = (answer: ReturnType<Ledger["readToolRequest"]>): Answer<WorkRecord | null> =>
    answer.known ? { known: true, value: answer.value === null ? null : work(answer.value) } : { known: false };
  return {
    config: { purposeBriefMaxChars: 200 },
    policy: { judge: (role, purpose) => (role === "diagnosis" && purpose === "diagnose" ? "allowed" : "purpose_not_allowed") },
    ledger: {
      findByRetryKey: (q) => read(ledger.findToolRequest({ owner: q.owner, dedupeKey: q.retryKey })),
      readOwnedWork: (q) => read(ledger.readToolRequest({ owner: q.owner, ref: q.ref })),
      recordStart: (input) => {
        const c = input.content;
        const written = ledger.recordToolRequest({
          ref: id(),
          owner: input.owner,
          dedupeKey: input.retryKey,
          role: c.role,
          purpose: c.purpose,
          sourceRef: c.sourceRef,
          inputDigest: c.inputDigest,
          sessionId: input.sessionId,
          callId: input.callId,
          now: input.now,
        });
        if (written.ok) return { known: true, value: { ok: true, record: work(written.request) } };
        if (written.reason === "stopped") return { known: true, value: { ok: false, reason: "stopped" } };
        if (written.reason === "intake_closed" || written.reason === "snapshot_hold") return { known: true, value: { ok: false, reason: "intake_closed" } };
        return { known: false };
      },
      requestCancel: (input) => {
        const written = ledger.cancelToolRequest({ owner: input.owner, ref: input.ref, sessionId: input.sessionId, callId: input.callId, now: input.now });
        if (written.ok) return { known: true, value: { ok: true, phase: written.phase } };
        if (written.reason === "transition_denied") return { known: true, value: { ok: false, reason: "already_ended" } };
        return { known: false };
      },
      liveSession: () => ({ known: true, value: SESSION }),
      inputPinned: (q) => ({ known: true, value: (q.owner === A && q.sourceRef === SRC_A) || (q.owner === B && q.sourceRef === SRC_B) }),
      readResult: () => ({ known: true, value: { state: "none" } }),
    },
  };
}

function ctx(owner: string, over: Partial<ToolCallContext> = {}): ToolCallContext {
  return { session: SESSION, requestId: owner, callId: id(), now: NOW, stop: { known: true, stopped: false }, ...over };
}

const startArgs = (owner: string) => ({
  role: "diagnosis",
  task: { purpose: "diagnose", brief: "파드가 재시작을 반복하는 원인을 찾는다", source_ref: owner === A ? SRC_A : SRC_B, input_digest: D1 },
});

const status = (ref: string, phase: string): ToolAnswer => ({ outcome: "ok", tool: "worker_status", ref, phase: phase as never });
const refused = (tool: string, reason: string): ToolAnswer => ({ outcome: "refused", tool, reason: reason as never, field: null });

// ---- 장부 도우미 ----

function owners(ledger: Ledger): void {
  must(ledger.enqueueInput({ requestId: A, source: "admin-dm", sourceRef: { ref: SRC_A, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
  must(ledger.enqueueInput({ requestId: B, source: "admin-dm", sourceRef: { ref: SRC_B, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
}

function request(owner: string, dedupeKey = keyOf(owner), purpose = "diagnose"): ToolRequestInput {
  return {
    ref: id(),
    owner,
    dedupeKey,
    role: "diagnosis",
    purpose,
    sourceRef: owner === A ? SRC_A : SRC_B,
    inputDigest: D1,
    sessionId: SESSION.id,
    callId: id(),
    now: NOW,
  };
}

// 배정기가 고른 실제 실행기·자격·기한·예산(admitRun의 입력과 같은 값). 역할·입력 digest·소유자는 부탁에서 온다.
function assignment(ref: string, over: Partial<AssignToolRequestInput> = {}): AssignToolRequestInput {
  const w = worker();
  return {
    ref,
    runId: id(),
    snapshotDigest: w.snapshotDigest as string,
    profileRevision: w.profileRevision,
    policyRevision: w.policyRevision,
    executorId: w.executorId,
    credential: w.credential,
    deadlineAt: w.deadlineAt,
    budgetLeft: w.budgetLeft,
    now: NOW,
    ...over,
  };
}

function rows(path: string, sql: string): unknown[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query(sql).all();
  } finally {
    raw.close();
  }
}

const runCount = (ledger: Ledger) => {
  const runs = ledger.listRuns();
  if (!runs.known) throw new Error("실행 목록을 읽지 못함");
  return runs.value.length;
};

// 영수증. 낸 쪽은 그 실행의 지정 실행기와 세대다.
const started = (runId: string, instructionRequestId: string) => ({ action: "receipt_started" as const, receiptId: id(), runId, instructionRequestId, bodyDigest: digest(`started:${runId}`), now: NOW });
const stoppedReceipt = (runId: string, exit: "completed" | "failed") => ({ action: "receipt_stopped" as const, receiptId: id(), runId, exit, bodyDigest: digest(`stopped:${runId}`), now: NOW });
const cleaned = (runId: string, instructionRequestId: string) => ({ action: "receipt_cleaned" as const, receiptId: id(), runId, instructionRequestId, bodyDigest: digest(`cleaned:${runId}`), now: NOW });

// ---- 인수 시험 ----

test("잇기는 한 번이고 취소된 부탁은 이어지지 않음", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  owners(ledger);
  const mine = must(ledger.recordToolRequest(request(A))).request;
  const cancelled = must(ledger.recordToolRequest(request(B))).request;
  must(ledger.cancelToolRequest({ owner: B, ref: cancelled.ref, sessionId: SESSION.id, callId: id(), now: NOW }));

  const first = must(ledger.assignToolRequest(assignment(mine.ref)));
  expect(first.outcome).toBe("assigned");
  // 역할·입력 digest·소유자(입력)는 부탁의 값이고, 실행의 중복 키는 부탁의 참조에서 만든다.
  expect(first.run).toMatchObject({ kind: "worker", state: "queued", role: "diagnosis", inputDigest: D1, inputRequestId: A, dedupeKey: `tool_request:${mine.ref}` });

  // 두 번째 잇기는 새 실행 줄 없이 이미 이어진 그 실행을 돌려준다.
  const again = assignment(mine.ref);
  expect(ledger.assignToolRequest(again)).toEqual({ ok: true, outcome: "already_assigned", run: first.run });
  expect(ledger.getRun(again.runId)).toEqual({ known: true, value: null });

  // 취소된 부탁과 없는 부탁은 실행 줄을 만들지 않는다.
  const late = assignment(cancelled.ref);
  expect(ledger.assignToolRequest(late)).toEqual({ ok: false, reason: "transition_denied" });
  expect(ledger.getRun(late.runId)).toEqual({ known: true, value: null });
  expect(ledger.assignToolRequest(assignment(MISSING))).toEqual({ ok: false, reason: "unknown_run" });
  expect(runCount(ledger)).toBe(1);
  // 이은 부탁은 대기에서 취소(not_started)로 가지 않는다. 취소는 실행 쪽으로 간다(아래 취소 시험).
  expect(ledger.readToolRequest({ owner: A, ref: mine.ref })).toMatchObject({ known: true, value: { phase: "queued" } });
  ledger.close();

  expect(rows(path, "SELECT owner, phase, run_id FROM tool_requests ORDER BY owner")).toEqual([
    { owner: A, phase: "waiting_assignment", run_id: first.run.runId },
    { owner: B, phase: "not_started", run_id: null },
  ]);

  // 재개방 뒤에도 같은 답이다.
  const reopened = ready(open(path));
  expect(reopened.assignToolRequest(assignment(mine.ref))).toEqual({ ok: true, outcome: "already_assigned", run: first.run });
  expect(reopened.assignToolRequest(assignment(cancelled.ref))).toEqual({ ok: false, reason: "transition_denied" });
  expect(reopened.readToolRequest({ owner: A, ref: mine.ref })).toMatchObject({ known: true, value: { phase: "queued" } });
  expect(reopened.readToolRequest({ owner: B, ref: cancelled.ref })).toMatchObject({ known: true, value: { phase: "not_started" } });
  expect(runCount(reopened)).toBe(1);
});

test("다른 소유자의 같은 재시도 키가 각자 실행 줄로", () => {
  const ledger = ready(open(tempPath()));
  owners(ledger);
  const SHARED = "start_worker:shared:diagnose";
  const a = must(ledger.recordToolRequest(request(A, SHARED))).request;
  const b = must(ledger.recordToolRequest(request(B, SHARED))).request;

  const runA = must(ledger.assignToolRequest(assignment(a.ref))).run;
  const runB = must(ledger.assignToolRequest(assignment(b.ref)));
  expect(runB.outcome).toBe("assigned");
  expect(runB.run.runId).not.toBe(runA.runId);
  expect([runA.inputRequestId, runB.run.inputRequestId]).toEqual([A, B]);
  expect([runA.dedupeKey, runB.run.dedupeKey]).toEqual([`tool_request:${a.ref}`, `tool_request:${b.ref}`]);
  expect(runCount(ledger)).toBe(2);

  // 각자 자기 부탁의 단계만 보고, 남의 참조는 이어졌든 아니든 없는 것과 같은 답이다.
  const p = ports(ledger);
  expect(handleToolCall("worker_status", { ref: a.ref }, ctx(A), p)).toEqual(status(a.ref, "queued"));
  expect(handleToolCall("worker_status", { ref: b.ref }, ctx(B), p)).toEqual(status(b.ref, "queued"));
  expect(handleToolCall("worker_status", { ref: b.ref }, ctx(A), p)).toEqual(refused("worker_status", "not_found"));
  expect(handleToolCall("worker_status", { ref: MISSING }, ctx(A), p)).toEqual(refused("worker_status", "not_found"));
  expect(ledger.readToolRequest({ owner: A, ref: b.ref })).toEqual({ known: true, value: null });
  expect(ledger.findToolRequest({ owner: A, dedupeKey: SHARED })).toMatchObject({ known: true, value: { ref: a.ref, phase: "queued" } });
});

test("이은 뒤의 단계는 실행 상태를 따름", () => {
  // 옮기는 표는 장부의 실행 상태 전부를 처리기의 단계 이름으로 옮긴다. 상태가 더해지면 여기서 실패한다.
  expect(Object.keys(TOOL_REQUEST_RUN_PHASES).sort()).toEqual([...LEDGER_RUN_STATES].sort());
  for (const state of LEDGER_RUN_STATES) expect(PHASES as readonly string[], state).toContain(TOOL_REQUEST_RUN_PHASES[state]);

  const path = tempPath();
  const ledger = ready(open(path));
  owners(ledger);
  const p = ports(ledger);
  const seen = new Set<string>();
  // 실행이 그 상태에 있을 때 처리기가 내는 단계. 처리기의 단계 이름은 장부의 상태 이름과 같으므로 기대값을 이름으로 적는다
  // (표에서 기대값을 만들면 표가 틀려도 시험이 따라 틀린다).
  const expectPhase = (owner: string, ref: string, runId: string, state: LedgerRunState) => {
    expect(ledger.getRun(runId)).toMatchObject({ known: true, value: { state } });
    expect(handleToolCall("worker_status", { ref }, ctx(owner), p)).toEqual(status(ref, state));
    seen.add(state);
  };

  // A: 대기 → 준비 → 실행 → 모름 → 종료 중 → 실패 → 정리 대기 → 끝.
  const refA = (handleToolCall("start_worker", startArgs(A), ctx(A), p) as { ref: string }).ref;
  expect(handleToolCall("worker_status", { ref: refA }, ctx(A), p)).toEqual(status(refA, "waiting_assignment"));
  const runA = must(ledger.assignToolRequest(assignment(refA))).run;
  expectPhase(A, refA, runA.runId, "queued");
  // 같은 부탁을 다시 내도 같은 참조이고 단계는 실행 줄의 것이다.
  expect(handleToolCall("start_worker", startArgs(A), ctx(A), p)).toEqual({ outcome: "ok", tool: "start_worker", ref: refA, phase: "queued" });
  const startA = id();
  must(ledger.startRun({ runId: runA.runId, requestId: startA, stopGeneration: 0, now: NOW }));
  expectPhase(A, refA, runA.runId, "preparing");
  must(ledger.applyReceipt(started(runA.runId, startA), from(runA)));
  expectPhase(A, refA, runA.runId, "running");
  must(ledger.markLost(NOW));
  expectPhase(A, refA, runA.runId, "unknown_running");
  must(ledger.recordStopInstruction({ runId: runA.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW }));
  expectPhase(A, refA, runA.runId, "stopping");
  must(ledger.applyReceipt(stoppedReceipt(runA.runId, "failed"), from(runA)));
  expectPhase(A, refA, runA.runId, "failed_stopped");
  must(ledger.markCleanupPending({ runId: runA.runId, now: NOW }));
  expectPhase(A, refA, runA.runId, "cleanup_pending");
  const finalizeA = id();
  must(ledger.recordFinalizeInstruction({ runId: runA.runId, requestId: finalizeA, stopGeneration: 0, now: NOW }));
  must(ledger.applyReceipt(cleaned(runA.runId, finalizeA), from(runA)));
  expectPhase(A, refA, runA.runId, "finalized");

  // B: 대기 → 준비 → 검사 → 결과 준비.
  const refB = (handleToolCall("start_worker", startArgs(B), ctx(B), p) as { ref: string }).ref;
  const runB = must(ledger.assignToolRequest(assignment(refB))).run;
  const startB = id();
  must(ledger.startRun({ runId: runB.runId, requestId: startB, stopGeneration: 0, now: NOW }));
  must(ledger.applyReceipt(stoppedReceipt(runB.runId, "completed"), from(runB)));
  expectPhase(B, refB, runB.runId, "checking");
  must(ledger.markResult({ runId: runB.runId, resultDigest: digest("result"), now: NOW }));
  expectPhase(B, refB, runB.runId, "ready_result");

  // A의 다른 목적: 대기에서 취소된 실행(not_started).
  const other = must(ledger.recordToolRequest(request(A, keyOf(A, "inspect"), "inspect"))).request;
  const runC = must(ledger.assignToolRequest(assignment(other.ref))).run;
  must(ledger.recordStopInstruction({ runId: runC.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW }));
  expectPhase(A, other.ref, runC.runId, "not_started");

  // 실제로 지난 상태가 장부의 상태 전부다.
  expect([...seen].sort()).toEqual([...LEDGER_RUN_STATES].sort());

  // 소유자 격리는 이어진 뒤에도 같다.
  expect(handleToolCall("worker_status", { ref: refB }, ctx(A), p)).toEqual(handleToolCall("worker_status", { ref: MISSING }, ctx(A), p));
  ledger.close();

  // 재개방 뒤에도 같은 단계다.
  const reopened = ready(open(path));
  expect(handleToolCall("worker_status", { ref: refB }, ctx(B), ports(reopened))).toEqual(status(refB, "ready_result"));
  expect(handleToolCall("worker_status", { ref: refA }, ctx(A), ports(reopened))).toEqual(status(refA, "finalized"));
  reopened.close();

  // 실행 줄을 읽지 못하면 단계를 지어내지 않고 모름이다.
  let fail = false;
  const faulty = open(path, {
    faults: {
      at(point) {
        if (fail && point === "read") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      },
    },
  });
  fail = true;
  expect(faulty.readToolRequest({ owner: A, ref: refA })).toEqual({ known: false, reason: "io" });
  expect(handleToolCall("worker_status", { ref: refA }, ctx(A), ports(faulty))).toEqual({ outcome: "unknown", tool: "worker_status" });
});

test("이은 부탁의 취소는 접수이고 슬롯은 그대로", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  owners(ledger);
  const p = ports(ledger);
  const ref = (handleToolCall("start_worker", startArgs(A), ctx(A), p) as { ref: string }).ref;
  const run = must(ledger.assignToolRequest(assignment(ref))).run;
  must(ledger.startRun({ runId: run.runId, requestId: id(), stopGeneration: 0, now: NOW }));

  // 남의 취소는 없는 부탁과 같은 거절이고 아무것도 적지 않는다.
  const foreign = ledger.cancelToolRequest({ owner: B, ref, sessionId: SESSION.id, callId: id(), now: NOW });
  expect(foreign).toEqual(ledger.cancelToolRequest({ owner: B, ref: MISSING, sessionId: SESSION.id, callId: id(), now: NOW }));
  expect(foreign).toEqual({ ok: false, reason: "unknown_run" });
  expect(handleToolCall("cancel_worker", { ref }, ctx(B), p)).toEqual(refused("cancel_worker", "not_found"));
  expect(ledger.getRun(run.runId)).toMatchObject({ known: true, value: { state: "preparing" } });

  // 자기 취소는 그 실행의 종료 지시(task_cancel)로 남는다. 접수는 종료가 아니다: 실행은 stopping에서 자리를 쥔 채다.
  const callId = id();
  expect(handleToolCall("cancel_worker", { ref }, ctx(A, { callId }), p)).toEqual({ outcome: "ok", tool: "cancel_worker", ref, cancel: "accepted", phase: "stopping" });
  expect(ledger.getRun(run.runId)).toMatchObject({ known: true, value: { state: "stopping" } });
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  expect(ledger.instructionTimes(run.runId)).toMatchObject({ known: true, value: { lastStopAt: NOW } });
  const next = must(ledger.admitRun(worker())).run;
  expect(ledger.startRun({ runId: next.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "slot_busy" });
  // 지시의 요청 ID가 호출 ID라, 같은 호출 ID의 취소를 다시 부르면 지시가 겹쳐 거절된다(응답 재생은 이 장부에 없다).
  expect(ledger.cancelToolRequest({ owner: A, ref, sessionId: SESSION.id, callId, now: NOW })).toEqual({ ok: false, reason: "invariant_violation" });
  expect(ledger.health()).toEqual({ writable: true });

  // 정지 중의 취소도 받는다(닫는 기록). 지시는 장부의 지금 정지 세대로 적히고, 보낼 쪽이 쓸 지시의 식별을 돌려준다.
  must(ledger.applyStop({ generation: 1, stopped: true, now: NOW }));
  const duringStop = id();
  expect(ledger.cancelToolRequest({ owner: A, ref, sessionId: SESSION.id, callId: duringStop, now: NOW + 1 })).toEqual({
    ok: true,
    phase: "stopping",
    instruction: { runId: run.runId, requestId: duringStop, stopGeneration: 1 },
  });
  expect(ledger.instructionTimes(run.runId)).toMatchObject({ known: true, value: { lastStopAt: NOW + 1 } });

  // 종료가 확인된 실행의 부탁은 이미 끝났다는 구별된 답이다.
  must(ledger.applyReceipt(stoppedReceipt(run.runId, "failed"), from(run)));
  expect(ledger.cancelToolRequest({ owner: A, ref, sessionId: SESSION.id, callId: id(), now: NOW + 2 })).toEqual({ ok: false, reason: "transition_denied" });
  ledger.close();

  // 부탁 줄은 대기·이어진 그대로이고 취소 칸을 채우지 않는다. 지시는 취소 호출의 ID로 적힌다.
  expect(rows(path, `SELECT phase, run_id, cancelled_at FROM tool_requests WHERE ref = '${ref}'`)).toEqual([{ phase: "waiting_assignment", run_id: run.runId, cancelled_at: null }]);
  expect(rows(path, `SELECT request_id, action, stop_generation FROM instructions WHERE run_id = '${run.runId}' AND action = 'task_cancel' ORDER BY issued_at`)).toEqual([
    { request_id: callId, action: "task_cancel", stop_generation: 0 },
    { request_id: duringStop, action: "task_cancel", stop_generation: 1 },
  ]);

  // 대기 중에 이은 부탁의 취소는 시작 전의 취소(not_started)이고, 다시 취소하면 이미 끝났다는 답이다.
  const reopened = ready(open(path));
  must(reopened.releaseStop({ generation: 1, now: NOW + 3 }));
  ready(reopened);
  const queued = must(reopened.recordToolRequest(request(B))).request;
  const queuedRun = must(reopened.assignToolRequest(assignment(queued.ref))).run;
  const q = ports(reopened);
  expect(handleToolCall("cancel_worker", { ref: queued.ref }, ctx(B), q)).toEqual({ outcome: "ok", tool: "cancel_worker", ref: queued.ref, cancel: "accepted", phase: "not_started" });
  expect(reopened.getRun(queuedRun.runId)).toMatchObject({ known: true, value: { state: "not_started" } });
  expect(handleToolCall("cancel_worker", { ref: queued.ref }, ctx(B), q)).toEqual(refused("cancel_worker", "already_ended"));
  expect(handleToolCall("worker_status", { ref: queued.ref }, ctx(B), q)).toEqual(status(queued.ref, "not_started"));
});

// ---- 그 밖 ----

test("실행의 접수가 거절되면 부탁은 그대로 대기이고 실행 줄이 없다", () => {
  const path = tempPath();
  let fail: string | null = null;
  const ledger = ready(
    open(path, {
      faults: {
        at(point) {
          if (point === fail) throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
        },
      },
    }),
  );
  owners(ledger);
  const mine = must(ledger.recordToolRequest(request(A))).request;
  const existing = must(ledger.admitRun(worker())).run;
  const waiting = { known: true as const, value: expect.objectContaining({ ref: mine.ref, phase: "waiting_assignment" }) };

  // 이미 쓰인 실행 ID(장부의 기존 거절), 부탁의 역할을 맡을 수 없는 실행기(입력 오류).
  expect(ledger.assignToolRequest(assignment(mine.ref, { runId: existing.runId }))).toEqual({ ok: false, reason: "invariant_violation" });
  expect(() => ledger.assignToolRequest(assignment(mine.ref, { executorId: "executor/research/0/store-a" }))).toThrow(LedgerInputError);
  expect(() => ledger.assignToolRequest({ ...assignment(mine.ref), role: "diagnosis" } as AssignToolRequestInput)).toThrow(LedgerInputError);
  expect(ledger.readToolRequest({ owner: A, ref: mine.ref })).toEqual(waiting);
  expect(runCount(ledger)).toBe(1);

  // 새 업무의 전제: 접수 허가가 없거나 정지면 거절한다.
  ledger.beginRestore(RESTORE_KEY);
  expect(ledger.assignToolRequest(assignment(mine.ref))).toEqual({ ok: false, reason: "intake_closed" });
  ready(ledger);
  must(ledger.applyStop({ generation: 1, stopped: true, now: NOW }));
  expect(ledger.assignToolRequest(assignment(mine.ref))).toEqual({ ok: false, reason: "stopped" });
  must(ledger.releaseStop({ generation: 1, now: NOW }));
  ready(ledger);
  expect(ledger.readToolRequest({ owner: A, ref: mine.ref })).toEqual(waiting);

  // 실행 줄을 적은 뒤 커밋 전에 끊기면 실행 줄과 잇기가 함께 되돌려진다.
  fail = "tool_request_assign:before_commit";
  const cut = assignment(mine.ref);
  expect(ledger.assignToolRequest(cut)).toEqual({ ok: false, reason: "ledger_unwritable" });
  fail = null;
  ledger.close();
  expect(rows(path, `SELECT run_id FROM runs WHERE run_id = '${cut.runId}'`)).toEqual([]);
  expect(rows(path, `SELECT phase, run_id FROM tool_requests WHERE ref = '${mine.ref}'`)).toEqual([{ phase: "waiting_assignment", run_id: null }]);

  const reopened = ready(open(path));
  expect(reopened.readToolRequest({ owner: A, ref: mine.ref })).toEqual(waiting);
  expect(must(reopened.assignToolRequest(assignment(mine.ref))).outcome).toBe("assigned");
});
