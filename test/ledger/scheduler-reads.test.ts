// 스케줄러의 판단(planNext·nextIntent)이 쓰는 장부 읽기. 실제 장부 파일에 적고, 닫았다 다시 연 뒤 공개 읽기만으로 판단의 입력을 조립한다.
// 조립은 이 시험 안의 도우미다. 출처 이름을 관리자·경보로 나누는 표(ORIGIN_OF)는 접수 정책의 대역이고 장부는 이름만 낸다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { limits } from "../../src/contract/v1/index.ts";
import { type Ledger, type LedgerRunState, TRANSITIONS } from "../../src/ledger/index.ts";
import { type LifecyclePolicy, type LifecycleView, nextIntent } from "../../src/supervisor/scheduler/lifecycle.ts";
import { type Origin, planNext, type SchedulerInput, type SchedulerPolicy, type SchedulerRun, type SchedulerView } from "../../src/supervisor/scheduler/queue.ts";
import { digest, id, must, NOW, open, ready, SESSION_EXECUTOR, session, tempPath, worker } from "./helpers.ts";

// 숫자는 이 시험이 고른 값이다. 운영값이 아니다.
const POLICY: SchedulerPolicy = { alertMaxWaitMs: 60_000 };
const LIFE: LifecyclePolicy = { renewEveryMs: 10_000, answerTimeoutMs: 30_000 };
const ORIGIN_OF: Record<string, Origin> = { "admin-dm": "admin", alertmanager: "alert" };

function enqueue(ledger: Ledger, source: string, receivedAt: number): string {
  const requestId = id();
  must(ledger.enqueueInput({ requestId, source, sourceRef: { ref: `inbox/${id()}`, expiresAt: NOW + 3_600_000 }, receivedAt }));
  return requestId;
}

// planNext의 입력을 공개 읽기 넷(queueView·listRuns·slotHolds·listInputs)으로만 만든다. 하나라도 읽지 못하면 판단을 부르지 않는다.
function assemble(ledger: Ledger, now: number): SchedulerView {
  const queue = ledger.queueView();
  const all = ledger.listRuns();
  const holds = ledger.slotHolds();
  const inputs = ledger.listInputs();
  if (!queue.known || !all.known || !holds.known || !inputs.known) throw new Error("장부를 읽지 못함");
  const bars = new Map(queue.value.runs.map((r) => [r.runId, r.startBar]));
  const runs: SchedulerRun[] = all.value.map((r) => {
    // 대기 실행의 시작 불가 사유는 queueView만 준다. 빠졌으면 null로 채우지 않는다.
    if (r.state === "queued" && !bars.has(r.runId)) throw new Error("대기 실행의 startBar가 없다");
    return { ...r, startBar: bars.get(r.runId) ?? null };
  });
  const known: SchedulerInput[] = inputs.value.flatMap((i) => {
    const origin = ORIGIN_OF[i.source];
    return origin === undefined ? [] : [{ requestId: i.requestId, origin, receivedAt: i.receivedAt, expiresAt: i.expiresAt, cancelled: i.cancelled }];
  });
  return { runs, inputs: known, slotHolds: holds.value, now };
}

// nextIntent의 입력. 임대 끝을 모르면 lease=null, 지시 이력을 읽지 못하면 lastInstructionAt="unknown"이다.
function lifecycle(ledger: Ledger, runId: string, now: number): LifecycleView {
  const got = ledger.getRun(runId);
  if (!got.known || got.value === null) throw new Error("실행을 읽지 못함");
  const run = got.value;
  const times = ledger.instructionTimes(runId);
  const inputs = ledger.listInputs();
  // 연결된 입력의 취소 여부를 모르면 판단을 조립하지 않는다. "취소 없음"으로 채우면 취소된 실행의 임대를 갱신하게 된다.
  if (!inputs.known) throw new Error("입력을 읽지 못함");
  const input = inputs.value.find((i) => i.requestId === run.inputRequestId);
  if (run.inputRequestId !== null && input === undefined) throw new Error("연결된 입력이 없다");
  const lease = times.known && times.value !== null ? times.value.lease : null;
  return {
    run: { runId, kind: run.kind, state: run.state, deadlineAt: run.deadlineAt },
    lease: lease !== null && lease.expiresAt !== "unknown" ? { issuedAt: lease.issuedAt, expiresAt: lease.expiresAt } : null,
    cancelRequested: input?.cancelled === true,
    lastInstructionAt: !times.known || times.value === null ? "unknown" : run.state === "stopping" ? times.value.lastStopAt : times.value.lastFinalizeAt,
    resultSettled: false,
    now,
  };
}

test("재개방 후 관리자·경보 순서 복원", () => {
  const path = tempPath();
  const first = ready(open(path));
  const alertReq = enqueue(first, "alertmanager", NOW);
  const adminReq = enqueue(first, "admin-dm", NOW + 1_000);
  const alertRun = must(first.admitRun(worker({ inputRequestId: alertReq }))).run;
  const adminRun = must(first.admitRun(worker({ inputRequestId: adminReq }))).run;
  first.close();

  const ledger = ready(open(path));
  const inputs = ledger.listInputs();
  // 장부는 접수 때 받은 출처 이름과 시각을 그대로 낸다(분류하지 않는다).
  expect(inputs).toEqual({
    known: true,
    value: [
      { requestId: alertReq, seq: 1, source: "alertmanager", receivedAt: NOW, expiresAt: NOW + 3_600_000, cancelled: false },
      { requestId: adminReq, seq: 2, source: "admin-dm", receivedAt: NOW + 1_000, expiresAt: NOW + 3_600_000, cancelled: false },
    ],
  });

  // 경보가 먼저 들어왔어도 관리자 요청이 먼저다.
  const early = planNext(assemble(ledger, NOW + 2_000), POLICY);
  expect(early.candidates).toEqual([{ runId: adminRun.runId, kind: "worker", origin: "admin", budgetLeft: 50_000 }]);
  expect(early.held).toEqual([{ runId: alertRun.runId, kind: "worker", reason: "waiting_turn" }]);

  // 경보가 접수 시각부터 alertMaxWaitMs를 기다렸으면 경보가 앞선다(재개방 뒤에도 접수 시각이 남아 있어야 셀 수 있다).
  const aged = planNext(assemble(ledger, NOW + POLICY.alertMaxWaitMs), POLICY);
  expect(aged.candidates.map((c) => [c.runId, c.origin])).toEqual([[alertRun.runId, "alert"]]);
});

test("처리된 입력의 취소가 실행에서 보임", () => {
  const path = tempPath();
  const first = ready(open(path));
  const requestId = enqueue(first, "admin-dm", NOW);
  const runId = must(first.admitRun(worker({ inputRequestId: requestId }))).run.runId;
  must(first.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  // 세션 줄은 지금의 공개 쓰기로 만들 수 없다(startSession이 닫혀 있다). 처리 위치를 올리려고 규칙 확인과 세션 실행을 API로 적고
  // 세션 줄 하나만 파일에 직접 넣는다.
  const check = id();
  must(
    first.applyRuleCheck(
      { reportId: check, outcome: "rule_present", firstMarkerDigest: digest("m0"), restartedMarkerDigest: null, startPermitId: null, checkedAt: NOW, bodyDigest: digest("rc"), now: NOW },
      { sender: SESSION_EXECUTOR },
    ),
  );
  const sessionRun = must(first.admitRun(session())).run.runId;
  first.close();
  const sessionId = id();
  const raw = new Database(path);
  raw.run("PRAGMA foreign_keys = ON");
  raw.query("INSERT INTO sessions (session_id, run_id, start_seq, generation_marker_digest, rule_check_id) VALUES (?, ?, 1, ?, ?)").run(sessionId, sessionRun, digest("m0"), check);
  raw.close();

  const ledger = ready(open(path));
  must(ledger.setProcessedSeq({ sessionId, processedSeq: 1 }));
  must(ledger.cancelInput(requestId, NOW + 5));
  // 대기열에서는 이미 처리한 입력이라 나오지 않는다.
  const queue = ledger.queueView();
  if (!queue.known) throw new Error("장부를 읽지 못함");
  expect(queue.value.inputs).toEqual({ processedSeq: 1, pending: [], cancelled: [], expired: [] });
  // 실행이 가리키는 입력의 만료와 취소는 처리 위치와 무관하게 읽힌다.
  expect(ledger.listInputs()).toEqual({
    known: true,
    value: [{ requestId, seq: 1, source: "admin-dm", receivedAt: NOW, expiresAt: NOW + 3_600_000, cancelled: true }],
  });
  // 시작 뒤의 취소 요청이 판단에 닿아 종료 의도가 된다.
  expect(nextIntent(lifecycle(ledger, runId, NOW + 10), LIFE)).toEqual({ intent: "stop", runId, toward: "stopping" });
});

test("미발행과 모름이 다른 값", () => {
  const ledger = ready(open(tempPath()));
  const requestId = enqueue(ledger, "admin-dm", NOW);
  const runId = must(ledger.admitRun(worker({ inputRequestId: requestId }))).run.runId;
  // 지시를 낸 적이 없다는 것을 장부에서 확인했다: 값이 null이다(읽지 못한 것과 다르다).
  expect(ledger.instructionTimes(runId)).toEqual({ known: true, value: { runId, lease: null, lastStopAt: null, lastFinalizeAt: null } });
  expect(ledger.instructionTimes(id())).toEqual({ known: true, value: null });

  // 시작 지시의 임대 끝은 계약이 정한다: 발행 시각 + RUN_LEASE_MAX_MS(실행기가 같은 식으로 정한다).
  must(ledger.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  expect(ledger.instructionTimes(runId)).toMatchObject({ value: { lease: { issuedAt: NOW, expiresAt: NOW + limits.RUN_LEASE_MAX_MS }, lastStopAt: null } });
  expect(nextIntent(lifecycle(ledger, runId, NOW + 10_000), LIFE).intent).toBe("renew_lease");

  // 갱신 지시의 임대 끝은 장부가 적지 않는다: 발행 시각은 알고 끝은 모른다. 모르는 임대는 갱신하지 않고 같은 ID로 조회한다.
  must(ledger.recordRenewInstruction({ runId, requestId: id(), stopGeneration: 0, now: NOW + 10_000 }));
  expect(ledger.instructionTimes(runId)).toMatchObject({ value: { lease: { issuedAt: NOW + 10_000, expiresAt: "unknown" } } });
  expect(nextIntent(lifecycle(ledger, runId, NOW + 20_000), LIFE).intent).toBe("query");

  // 종료 지시를 냈으면 그 시각이 마지막 종료 지시다. 답을 기다릴 시간이 지나면 같은 ID로 조회한다.
  must(ledger.recordStopInstruction({ runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW + 20_000 }));
  expect(ledger.instructionTimes(runId)).toMatchObject({ value: { lastStopAt: NOW + 20_000, lastFinalizeAt: null } });
  expect(nextIntent(lifecycle(ledger, runId, NOW + 20_000 + LIFE.answerTimeoutMs), LIFE).intent).toBe("query");

  // 읽지 못하면 값이 아니라 known: false다. 판단에는 "unknown"으로 넘어가 같은 시각에도 기다린다.
  const view = lifecycle(ledger, runId, NOW + 20_000 + LIFE.answerTimeoutMs);
  ledger.close();
  expect(ledger.instructionTimes(runId)).toEqual({ known: false, reason: "closed" });
  expect(ledger.listInputs()).toEqual({ known: false, reason: "closed" });
  expect(nextIntent({ ...view, lastInstructionAt: "unknown" }, LIFE).intent).toBe("wait");
});

test("갱신을 시작보다 이른 시각으로 기록해도 재개방 뒤 임대 끝은 모름이고 조회한다", () => {
  const path = tempPath();
  const first = ready(open(path));
  const requestId = enqueue(first, "admin-dm", NOW);
  const runId = must(first.admitRun(worker({ inputRequestId: requestId }))).run.runId;
  must(first.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  must(first.recordRenewInstruction({ runId, requestId: id(), stopGeneration: 0, now: NOW - 1 }));
  first.close();

  const ledger = ready(open(path));
  expect(ledger.instructionTimes(runId)).toMatchObject({ known: true, value: { lease: { issuedAt: NOW - 1, expiresAt: "unknown" } } });
  expect(nextIntent(lifecycle(ledger, runId, NOW + 10_000), LIFE).intent).toBe("query");
});

test("입력을 읽지 못하면 수명 판단을 조립하지 않는다", () => {
  const ledger = ready(open(tempPath()));
  const requestId = enqueue(ledger, "admin-dm", NOW);
  const runId = must(ledger.admitRun(worker({ inputRequestId: requestId }))).run.runId;
  must(ledger.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  must(ledger.cancelInput(requestId, NOW + 5));
  expect(nextIntent(lifecycle(ledger, runId, NOW + 10_000), LIFE).intent).toBe("stop");
  // 실행·지시 읽기는 성공하고 입력 읽기만 실패하는 장부.
  const inputsFail = new Proxy(ledger, {
    get(target, key) {
      if (key === "listInputs") return () => ({ known: false, reason: "io" });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(() => lifecycle(inputsFail, runId, NOW + 10_000)).toThrow("입력을 읽지 못함");
});

// 시작 지시 뒤의 상태(preparing에서 닿는 모든 상태)에서 여러 걸음을 거쳐서라도 not_started에 닿는지.
function startedReachesNotStarted(table: Partial<Record<LedgerRunState, readonly LedgerRunState[]>>): boolean {
  const seen = new Set<LedgerRunState>(["preparing"]);
  const stack: LedgerRunState[] = ["preparing"];
  while (stack.length > 0) {
    for (const to of table[stack.pop() as LedgerRunState] ?? []) {
      if (!seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return seen.has("not_started");
}

test("시작 전에 닫힌 줄은 상한이 아님", () => {
  // 장부에서 not_started로 들어오는 길은 queued에서뿐이고, 시작한 줄은 대기로 돌아가지 않는다. 그 줄은 시작한 적이 없어
  // 숫자가 쓰고 남긴 잔액이 아니다.
  for (const kind of ["worker", "session"] as const) {
    const into = Object.entries(TRANSITIONS[kind])
      .filter(([, to]) => to?.includes("not_started"))
      .map(([from]) => from);
    expect(into, kind).toEqual(["queued"]);
    expect(startedReachesNotStarted(TRANSITIONS[kind]), kind).toBe(false);
    // 시작한 줄이 대기로 돌아가는 간선(running → queued)을 표의 사본에 더하면 이 검사가 잡는다.
    const requeue = { ...TRANSITIONS[kind], running: [...(TRANSITIONS[kind].running ?? []), "queued" as const] };
    expect(startedReachesNotStarted(requeue), kind).toBe(true);
  }

  const path = tempPath();
  const first = ready(open(path));
  const requestId = enqueue(first, "admin-dm", NOW);
  const current = must(first.admitRun(worker({ inputRequestId: requestId, budgetLeft: 10 }))).run;
  const later = must(first.admitRun(worker({ inputRequestId: requestId, budgetLeft: 3 }))).run;
  // 뒤 순번 실행을 시작 전에 닫는다(배정기가 기한이 지난 대기 실행을 닫는 길).
  must(first.recordStopInstruction({ runId: later.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW }));
  first.close();

  const ledger = ready(open(path));
  const view = assemble(ledger, NOW + 1);
  expect(view.runs.map((r) => [r.runId, r.state, r.budgetLeft])).toEqual([
    [current.runId, "queued", 10],
    [later.runId, "not_started", 3],
  ]);
  const decision = planNext(view, POLICY);
  expect(decision).toEqual({ candidates: [{ runId: current.runId, kind: "worker", origin: "admin", budgetLeft: 10 }], held: [] });
  // 후보를 따라 부른 시작이 실제로 커밋된다.
  expect(ledger.startRun({ runId: current.runId, requestId: id(), stopGeneration: 0, now: NOW + 1 })).toMatchObject({ ok: true, run: { state: "preparing", budgetLeft: 10 } });
});
