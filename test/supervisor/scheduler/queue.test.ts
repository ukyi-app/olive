import { describe, expect, test } from "bun:test";
import { LEDGER_RUN_STATES, type LedgerRunState, type RunKind, TRANSITIONS } from "../../../src/ledger/index.ts";
import { type LifecyclePolicy, type LifecycleView, nextIntent, RENEW_MARGIN_MS } from "../../../src/supervisor/scheduler/lifecycle.ts";
import { type HoldReason, type Origin, planNext, type SchedulerInput, type SchedulerPolicy, type SchedulerRun, type SchedulerView } from "../../../src/supervisor/scheduler/queue.ts";
import { id, must, NOW, open, ready, tempPath, worker } from "../../ledger/helpers.ts";

// 숫자는 이 시험이 고른 값이다. 운영값이 아니다(운영값은 배포가 넣는다).
const POLICY: SchedulerPolicy = { alertMaxWaitMs: 60_000, requestBudget: { admin: 100_000, alert: 100_000 } };
const LIMIT = POLICY.requestBudget.admin;
const LIFE: LifecyclePolicy = { renewEveryMs: 10_000, answerTimeoutMs: 30_000 };

let seq = 0;
function run(over: Partial<SchedulerRun> = {}): SchedulerRun {
  seq += 1;
  return {
    runId: `run-${seq}`,
    kind: "worker",
    role: "diagnosis",
    state: "queued",
    queueSeq: seq,
    inputRequestId: `req-${seq}`,
    deadlineAt: NOW + 600_000,
    budgetLeft: 50_000,
    // 장부의 listRuns는 not_started 줄에만 싣는다. 가짜는 모든 줄에 "관리자가 닫지 않음"을 둔다(다른 상태에서는 읽지 않는다).
    closedByOperator: false,
    // 장부의 listRuns는 작업자 줄에 싣는다. 가짜의 기본은 시작하지 않은 줄의 0이고, 시작한 줄을 흉내 내는 시험이 값을 넣는다.
    reservedBudget: 0,
    startBar: null,
    ...over,
  };
}

function inputFor(r: SchedulerRun, origin: Origin, over: Partial<SchedulerInput> = {}): SchedulerInput {
  return { requestId: r.inputRequestId as string, origin, receivedAt: NOW, expiresAt: NOW + 3_600_000, cancelled: false, ...over };
}

function view(runs: SchedulerRun[], inputs: SchedulerInput[], over: Partial<SchedulerView> = {}): SchedulerView {
  return { runs, inputs, slotHolds: [], now: NOW, ...over };
}

describe("다음 시작 후보", () => {
  test("두 작업 중 하나 대기", () => {
    const a = run();
    const b = run();
    const decision = planNext(view([a, b], [inputFor(a, "admin"), inputFor(b, "admin")]), POLICY);
    expect(decision.candidates).toEqual([{ runId: a.runId, kind: "worker", origin: "admin", budgetLeft: 50_000 }]);
    expect(decision.held).toEqual([{ runId: b.runId, kind: "worker", reason: "waiting_turn" }]);

    // 하나가 자리를 잡으면 다른 하나는 시작 후보가 아니다.
    const busy = planNext(view([{ ...a, state: "running" }, b], [inputFor(a, "admin"), inputFor(b, "admin")]), POLICY);
    expect(busy.candidates).toEqual([]);
    expect(busy.held).toEqual([{ runId: b.runId, kind: "worker", reason: "slot_occupied" }]);

    // 세션 슬롯은 따로 센다: 세션이 돌고 있어도 작업자 후보는 나온다.
    const s = run({ kind: "session", role: null, state: "running", inputRequestId: null });
    const split = planNext(view([s, b], [inputFor(b, "admin")]), POLICY);
    expect(split.candidates.map((c) => c.runId)).toEqual([b.runId]);
  });

  test("관리자 우선이고 경보도 차례를 받음", () => {
    const alert = run();
    const admin1 = run();
    const inputs = [inputFor(alert, "alert", { receivedAt: NOW }), inputFor(admin1, "admin", { receivedAt: NOW + 1_000 })];
    // 경보가 먼저 들어왔어도 관리자 요청이 앞선다.
    const first = planNext(view([alert, admin1], inputs, { now: NOW + 2_000 }), POLICY);
    expect(first.candidates.map((c) => c.runId)).toEqual([admin1.runId]);
    expect(first.held).toEqual([{ runId: alert.runId, kind: "worker", reason: "waiting_turn" }]);

    // 관리자 요청이 계속 들어와도 alertMaxWaitMs만큼 기다린 경보가 다음 차례다.
    const admin2 = run();
    const later = NOW + POLICY.alertMaxWaitMs;
    const second = planNext(view([alert, admin2], [inputs[0] as SchedulerInput, inputFor(admin2, "admin", { receivedAt: later - 1 })], { now: later }), POLICY);
    expect(second.candidates.map((c) => c.runId)).toEqual([alert.runId]);
    expect(second.held).toEqual([{ runId: admin2.runId, kind: "worker", reason: "waiting_turn" }]);

    // 출처를 받지 못한 실행은 차례를 정할 수 없어 보류다.
    const unknown = planNext(view([alert], []), POLICY);
    expect(unknown).toEqual({ candidates: [], held: [{ runId: alert.runId, kind: "worker", reason: "input_unknown" }] });
  });

  test("종료 미확인·정리 대기면 다음 시작 0", () => {
    const next = run();
    const inputs = [inputFor(next, "admin")];
    const cases: [LedgerRunState, HoldReason][] = [
      ["unknown_running", "slot_end_unconfirmed"],
      ["stopping", "slot_end_unconfirmed"],
      ["cleanup_pending", "slot_cleanup_pending"],
    ];
    for (const [state, reason] of cases) {
      const stuck = run({ state });
      const decision = planNext(view([stuck, next], inputs), POLICY);
      expect(decision.candidates).toEqual([]);
      expect(decision.held).toEqual([{ runId: next.runId, kind: "worker", reason }]);
    }
    // 재시작 복원이 남긴 점유 관측도 슬롯을 막는다.
    const observed = planNext(view([next], inputs, { slotHolds: [{ kind: "worker", runId: "outside", holdsSlot: true }] }), POLICY);
    expect(observed.candidates).toEqual([]);
    expect(observed.held[0]?.reason).toBe("slot_hold_observed");

    // 그 실행에는 같은 ID 조회와 정리 재시도를 낼 수 있다.
    const base = { lease: null, cancelRequested: false, lastInstructionAt: null, resultSettled: false, now: NOW };
    expect(nextIntent({ ...base, run: { runId: "u", kind: "worker", state: "unknown_running", deadlineAt: NOW + 1 } }, LIFE).intent).toBe("query");
    expect(nextIntent({ ...base, run: { runId: "c", kind: "worker", state: "cleanup_pending", deadlineAt: NOW + 1 } }, LIFE).intent).toBe("finalize");
  });

  test("같은 요청의 다음 작업은 요청 한도에서 앞 작업들이 시작 때 잡은 예산을 뺀 만큼까지만 후보", () => {
    // 앞 작업이 시작 때 잡은 예산(예약)은 쓰고 남긴 잔액과 무관하게 전부 센다(D-77). 한도 100_000에서 60_000을 잡았으면 남은 몫은 40_000이다.
    const prior = run({ state: "finalized", budgetLeft: 1_000, reservedBudget: 60_000 });
    const next = run({ inputRequestId: prior.inputRequestId, budgetLeft: 50_000 });
    const inputs = [inputFor(prior, "admin")];
    expect(planNext(view([prior, next], inputs), POLICY)).toEqual({ candidates: [], held: [{ runId: next.runId, kind: "worker", reason: "request_budget_exceeded" }] });

    // 남은 몫 이하면 그 값 그대로 후보다(앞 작업의 잔액 1_000보다 커도 된다).
    const fair = { ...next, budgetLeft: 40_000 };
    expect(planNext(view([prior, fair], inputs), POLICY).candidates).toEqual([{ runId: next.runId, kind: "worker", origin: "admin", budgetLeft: 40_000 }]);

    // 앞 작업의 남은 예산이 0으로 적혔으면 새 실행 줄의 값과 무관하게 보류다.
    const spent = { ...prior, budgetLeft: 0 };
    expect(planNext(view([spent, fair], inputs), POLICY).held).toEqual([{ runId: next.runId, kind: "worker", reason: "budget_exhausted" }]);
    expect(planNext(view([run({ budgetLeft: 0, inputRequestId: "solo" })], [{ ...inputs[0]!, requestId: "solo" }]), POLICY).held[0]?.reason).toBe("budget_exhausted");

    // 입력이 만료됐거나 기한이 지났으면 보류다(지금 시각으로 다시 본다).
    const late = run();
    expect(planNext(view([late], [inputFor(late, "admin", { expiresAt: NOW })]), POLICY).held[0]?.reason).toBe("input_expired");
    expect(planNext(view([late], [inputFor(late, "admin")], { now: late.deadlineAt }), POLICY).held[0]?.reason).toBe("deadline_passed");
  });

  test("설정값이 없거나 틀리면 판단하지 않는다", () => {
    expect(() => planNext(view([], []), { ...POLICY, alertMaxWaitMs: 0 })).toThrow(TypeError);
    expect(() => planNext(view([], []), {} as SchedulerPolicy)).toThrow(TypeError);
  });
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

// 장부 밖에서 조립한 값이 빠지거나 꼴이 틀린 경우. 모르면 시작 후보도 갱신도 내지 않는다.
// 시험이 일부러 틀린 꼴을 넣으므로 타입을 우회한다.
const broken = <T>(value: unknown) => value as T;

describe("모르거나 꼴이 틀린 입력", () => {
  test("F1: 같은 요청의 남은 한도가 0이면 대기 순번과 무관하게 후보 0", () => {
    const first = run({ inputRequestId: "same", budgetLeft: 10 });
    const later = run({ inputRequestId: "same", state: "finalized", budgetLeft: 0 });
    const inputs = [inputFor(first, "admin")];
    expect(planNext(view([first, later], inputs), POLICY)).toEqual({ candidates: [], held: [{ runId: first.runId, kind: "worker", reason: "budget_exhausted" }] });

    // 뒤 순번 실행이 시작 때 잡은 예산이 한도에 닿았거나 넘으면 순번과 무관하게 남은 한도가 없다.
    for (const reservedBudget of [LIMIT, LIMIT + 1]) {
      const used = { ...later, budgetLeft: 3, reservedBudget };
      expect(planNext(view([first, used], inputs), POLICY).held, String(reservedBudget)).toEqual([{ runId: first.runId, kind: "worker", reason: "budget_exhausted" }]);
    }

    // 아직 시작하지 않은 뒤 순번 줄은 예약이 0이라 앞 줄을 막지 않는다.
    const smaller = run({ inputRequestId: "same", budgetLeft: 5 });
    expect(planNext(view([first, smaller], inputs), POLICY).candidates.map((c) => c.runId)).toEqual([first.runId]);
  });

  test("시작 전에 닫힌 줄(not_started)은 예약이 0이고, 소진과 시작한 줄의 예약은 그대로 요청 한도에서 빠진다", () => {
    // not_started로 들어오는 길이 queued에서, 또는 닫기 근거가 있을 때(D-90: 시작 지시의 예산에서 감액이 없을 때만, 관리자 닫기 D-91)뿐이고,
    // 닫기 줄을 빼면 시작한 줄이 여러 걸음으로도 not_started에 닿지 않는 동안만 성립한다. 표가 바뀌면 이 단언이 먼저 실패한다.
    // 장부는 D-90으로 닫힌 줄의 예약을 0으로, 관리자가 닫은 줄의 예약을 시작 예산 전부로 싣는다(closedByOperator와의 대조는 아래 시험).
    for (const kind of ["worker", "session"] as const) {
      // 예외는 작업자의 닫기 줄뿐이다. 장부 트리거가 근거 줄이 있을 때만 허락한다: D-90(preparing·unknown_running, 실행기가 받은 적
      // 없는 실행, 쓴 예산 없음)과 관리자 닫기(unknown_running·stopping, 이미 돌았을 수 있음).
      const unreceived: readonly LedgerRunState[] = kind === "worker" ? ["preparing", "unknown_running"] : [];
      const operator: readonly LedgerRunState[] = kind === "worker" ? ["unknown_running", "stopping"] : [];
      const closure = LEDGER_RUN_STATES.filter((state) => unreceived.includes(state) || operator.includes(state));
      expect(closure, kind).toEqual(kind === "worker" ? ["preparing", "stopping", "unknown_running"] : []);
      expect(Object.entries(TRANSITIONS[kind]).filter(([, to]) => to?.includes("not_started")).map(([from]) => from), kind).toEqual(["queued", ...closure]);
      const withoutClosure = Object.fromEntries(Object.entries(TRANSITIONS[kind]).map(([from, to]) => [from, closure.includes(from as LedgerRunState) ? to?.filter((s) => s !== "not_started") : to]));
      expect(startedReachesNotStarted(withoutClosure), kind).toBe(false);
      // 닫기 간선 셋(preparing·stopping·unknown_running → not_started)을 뺀 표에 시작한 줄이 대기로 돌아가는 간선(running → queued)을 더하면 이 검사가 잡는다.
      const requeue = { ...withoutClosure, running: [...(withoutClosure.running ?? []), "queued" as const] };
      expect(startedReachesNotStarted(requeue), kind).toBe(true);
    }
    const current = run({ inputRequestId: "ns", budgetLeft: 10 });
    const inputs = [inputFor(current, "admin")];
    // 리뷰의 재현 입력: 뒤 순번 not_started 3, 지금 10 → 후보.
    const closedLater = run({ inputRequestId: "ns", state: "not_started", budgetLeft: 3 });
    expect(planNext(view([current, closedLater], inputs), POLICY)).toEqual({ candidates: [{ runId: current.runId, kind: "worker", origin: "admin", budgetLeft: 10 }], held: [] });
    // 앞 순번이어도 not_started의 배정액은 상한이 아니다.
    const closedEarlier = { ...closedLater, queueSeq: 0 };
    expect(planNext(view([closedEarlier, current], inputs), POLICY).candidates.map((c) => c.runId)).toEqual([current.runId]);
    // 잔액 0으로 닫힌 줄은 여전히 소진이다.
    expect(planNext(view([current, { ...closedLater, budgetLeft: 0 }], inputs), POLICY).held).toEqual([{ runId: current.runId, kind: "worker", reason: "budget_exhausted" }]);
    // 시작한 적 있는 줄(시작 뒤에 끝난 상태)의 예약은 순번과 무관하게 한도에서 빠진다. 남은 몫 9 < 10이면 보류, 10이면 예산으로는
    // 막지 않는다(결과 정리 전의 두 상태는 자리를 쥐고 있어 그 사유로 보류된다).
    for (const [state, fits] of [
      ["finalized", null],
      ["failed_stopped", "slot_occupied"],
      ["cleanup_pending", "slot_cleanup_pending"],
    ] as const) {
      expect(planNext(view([current, { ...closedLater, state, reservedBudget: LIMIT - 9 }], inputs), POLICY).held, state).toEqual([
        { runId: current.runId, kind: "worker", reason: "request_budget_exceeded" },
      ]);
      const room = planNext(view([current, { ...closedLater, state, reservedBudget: LIMIT - 10 }], inputs), POLICY);
      if (fits === null) expect(room.candidates.map((c) => c.runId), state).toEqual([current.runId]);
      else expect(room.held, state).toEqual([{ runId: current.runId, kind: "worker", reason: fits }]);
    }
  });

  test("관리자가 닫았거나 닫았는지 모르는 not_started 줄은 예약 0을 믿지 않고, 그 예약은 순번과 무관하게 요청 한도에서 빠진다", () => {
    const current = run({ inputRequestId: "op", budgetLeft: 10 });
    const inputs = [inputFor(current, "admin")];
    for (const closedByOperator of [true, undefined, broken<boolean>("false")]) {
      const closed = run({ inputRequestId: "op", state: "not_started", budgetLeft: 3, closedByOperator, reservedBudget: LIMIT - 9 });
      const label = String(closedByOperator);
      expect(planNext(view([current, closed], inputs), POLICY).held, label).toEqual([{ runId: current.runId, kind: "worker", reason: "request_budget_exceeded" }]);
      expect(planNext(view([{ ...closed, queueSeq: 0 }, current], inputs), POLICY).held, label).toEqual([{ runId: current.runId, kind: "worker", reason: "request_budget_exceeded" }]);
      // 남은 몫이 같거나 크면 한도에 걸리지 않는다. 잔액 0은 소진이다.
      expect(planNext(view([current, { ...closed, reservedBudget: LIMIT - 10 }], inputs), POLICY).candidates.map((c) => c.runId), label).toEqual([current.runId]);
      expect(planNext(view([current, { ...closed, budgetLeft: 0 }], inputs), POLICY).held, label).toEqual([{ runId: current.runId, kind: "worker", reason: "budget_exhausted" }]);
      // 관리자 닫기는 시작 지시가 있어야만 되므로 예약 0은 장부와 어긋난 읽기다(D-94: 관리자가 닫은 실행의 예산을 돌려주지 않는다).
      expect(planNext(view([current, { ...closed, reservedBudget: 0 }], inputs), POLICY).held, label).toEqual([{ runId: current.runId, kind: "worker", reason: "budget_unknown" }]);
    }
  });

  test("F4: 읽지 못한 잔액은 모름이고, 자기 잔액을 읽었으면 다른 실행들 사이의 모름이 잔액 0을 가리지 않는다", () => {
    for (const unread of [undefined, Number.NaN]) {
      const a = run({ inputRequestId: "f4", state: "finalized", budgetLeft: broken<number>(unread) });
      const b = run({ inputRequestId: "f4", state: "finalized", budgetLeft: 0 });
      const c = run({ inputRequestId: "f4", budgetLeft: 10 });
      const decision = planNext(view([a, b, c], [inputFor(c, "admin")]), POLICY);
      expect(decision).toEqual({ candidates: [], held: [{ runId: c.runId, kind: "worker", reason: "budget_exhausted" }] });
    }
    // 앞 실행의 잔액만 모르면 상한을 정할 수 없어 보류다.
    const prior = run({ inputRequestId: "f4b", state: "finalized", budgetLeft: broken<number>(undefined) });
    const retry = run({ inputRequestId: "f4b", budgetLeft: 10 });
    expect(planNext(view([prior, retry], [inputFor(retry, "admin")]), POLICY).held).toEqual([{ runId: retry.runId, kind: "worker", reason: "budget_unknown" }]);
    // 자기 잔액이 0 이상의 안전 정수가 아니면 보류다.
    for (const left of [undefined, Number.NaN, -1, 1.5, "10", Number.MAX_SAFE_INTEGER + 1]) {
      const solo = run({ budgetLeft: broken<number>(left) });
      expect(planNext(view([solo], [inputFor(solo, "admin")]), POLICY)).toEqual({ candidates: [], held: [{ runId: solo.runId, kind: "worker", reason: "budget_unknown" }] });
    }
  });

  test("F2: 지금 시각이 유한한 수가 아니면 후보와 갱신 0, 만료 시각과 같은 순간은 만료", () => {
    const a = run({ deadlineAt: 999 });
    const s = run({ kind: "session", role: null, deadlineAt: 999 });
    const inputs = [inputFor(a, "admin", { expiresAt: 999 }), inputFor(s, "admin", { expiresAt: 999 })];
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const decision = planNext(view([a, s], inputs, { now: broken<number>(now) }), POLICY);
      expect(decision).toEqual({
        candidates: [],
        held: [
          { runId: a.runId, kind: "worker", reason: "now_unknown" },
          { runId: s.runId, kind: "session", reason: "now_unknown" },
        ],
      });
      const life: LifecycleView = {
        run: { runId: "r", kind: "worker", state: "running", deadlineAt: NOW + 600_000 },
        lease: { issuedAt: NOW - 20_000, expiresAt: NOW + 10_000 },
        cancelRequested: false,
        lastInstructionAt: null,
        resultSettled: false,
        now: broken<number>(now),
      };
      expect(nextIntent(life, LIFE).intent).toBe("wait");
    }
    // 경계: 만료·기한 시각과 같은 순간은 지난 것이다. 1 앞이면 아직 아니다.
    const edge = run();
    const exp = NOW + 100;
    expect(planNext(view([edge], [inputFor(edge, "admin", { expiresAt: exp })], { now: exp }), POLICY).held[0]?.reason).toBe("input_expired");
    expect(planNext(view([edge], [inputFor(edge, "admin", { expiresAt: exp })], { now: exp - 1 }), POLICY).candidates.map((c) => c.runId)).toEqual([edge.runId]);
    expect(planNext(view([edge], [inputFor(edge, "admin")], { now: edge.deadlineAt - 1 }), POLICY).candidates.map((c) => c.runId)).toEqual([edge.runId]);
  });

  test("F3: 출처가 없거나 등록되지 않은 입력, 접수·만료·취소 칸이 빠진 입력은 후보 0", () => {
    const alert = run();
    const odd = run();
    const alertInput = inputFor(alert, "alert");
    const bads: Partial<SchedulerInput>[] = [
      { origin: broken<Origin>(undefined) },
      { origin: broken<Origin>("root") },
      { receivedAt: broken<number>(undefined) },
      { receivedAt: Number.NaN },
      { expiresAt: broken<number>(undefined) },
      { expiresAt: Number.NaN },
      { cancelled: broken<boolean>(undefined) },
      { cancelled: broken<boolean>("false") },
    ];
    for (const bad of bads) {
      const decision = planNext(view([alert, odd], [alertInput, inputFor(odd, "admin", bad)]), POLICY);
      expect(decision.candidates.map((c) => c.runId)).toEqual([alert.runId]);
      expect(decision.held).toEqual([{ runId: odd.runId, kind: "worker", reason: "input_unknown" }]);
    }
  });

  test("F5: 임대의 발행·만료를 읽었고 지금이 만료 앞일 때만 갱신, 아니면 같은 ID 조회", () => {
    const base = { cancelRequested: false, lastInstructionAt: null, resultSettled: false, now: NOW };
    const running = { runId: "r", kind: "worker" as const, state: "running" as const, deadlineAt: NOW + 600_000 };
    const leases = [
      { issuedAt: NOW - 20_000, expiresAt: Number.NaN },
      { issuedAt: NOW - 20_000, expiresAt: broken<number>(undefined) },
      { issuedAt: Number.NaN, expiresAt: NOW + 10_000 },
      { issuedAt: broken<number>(undefined), expiresAt: NOW + 10_000 },
      { issuedAt: NOW + 1, expiresAt: NOW + 30_000 },
      { issuedAt: NOW - 20_000, expiresAt: NOW },
    ];
    for (const lease of leases) {
      expect(nextIntent({ ...base, run: running, lease }, LIFE)).toEqual({ intent: "query", runId: "r", toward: "unknown_running" });
    }
    // 살아 있어도 끝까지 전달 여유(RENEW_MARGIN_MS)가 남지 않으면 같은 ID 조회다. 여유가 정확히 남으면 갱신한다.
    expect(nextIntent({ ...base, run: running, lease: { issuedAt: NOW - 20_000, expiresAt: NOW + 1 } }, LIFE)).toEqual({ intent: "query", runId: "r", toward: "unknown_running" });
    expect(nextIntent({ ...base, run: running, lease: { issuedAt: NOW - 20_000, expiresAt: NOW + RENEW_MARGIN_MS } }, LIFE).intent).toBe("renew_lease");
  });

  test("F8: 마지막 지시 시각을 읽지 못하면 확정 재시도와 stopping 조회를 내지 않는다", () => {
    const base = { lease: null, cancelRequested: false, resultSettled: false, now: NOW };
    const cleanup = { runId: "c", kind: "worker" as const, state: "cleanup_pending" as const, deadlineAt: NOW + 600_000 };
    const stopping = { ...cleanup, state: "stopping" as const };
    for (const lastInstructionAt of ["unknown" as const, Number.NaN]) {
      expect(nextIntent({ ...base, lastInstructionAt, run: cleanup }, LIFE).intent).toBe("wait");
      expect(nextIntent({ ...base, lastInstructionAt, run: stopping }, LIFE).intent).toBe("wait");
    }
    // 아직 내지 않았음을 확인했으면(null) 첫 지시, 응답 대기 시간이 지났으면 다시 낸다.
    expect(nextIntent({ ...base, lastInstructionAt: null, run: cleanup }, LIFE).intent).toBe("finalize");
    expect(nextIntent({ ...base, lastInstructionAt: NOW - LIFE.answerTimeoutMs, run: stopping }, LIFE).intent).toBe("query");
    expect(nextIntent({ ...base, lastInstructionAt: NOW - LIFE.answerTimeoutMs + 1, run: stopping }, LIFE).intent).toBe("wait");
  });

  test("F6: 기한만 지난 대기 실행은 이 판단이 닫지 않고, 취소 요청이면 not_started로 닫는다", () => {
    const base = { lease: null, lastInstructionAt: null, resultSettled: false, now: NOW };
    const queued = { runId: "q", kind: "worker" as const, state: "queued" as const, deadlineAt: NOW };
    expect(nextIntent({ ...base, cancelRequested: false, run: queued }, LIFE)).toEqual({ intent: "wait", runId: "q", toward: "queued" });
    expect(nextIntent({ ...base, cancelRequested: true, run: queued }, LIFE)).toEqual({ intent: "stop", runId: "q", toward: "not_started" });
  });
});

describe("요청 한도(D-105: 요청 전체로 묶음, D-106: 모자라면 보류)", () => {
  const limitOf = (admin: number, alert = admin): SchedulerPolicy => ({ ...POLICY, requestBudget: { admin, alert } });

  test("재현 1: 역할이 다른 다음 작업은 앞 작업의 잔액보다 커도 요청 한도 안이면 후보", () => {
    // 앞 작업은 100_000으로 시작해 계측 없이 끝났다(잔액 그대로). 다음 작업의 역할 예산은 200_000이다.
    const prior = run({ inputRequestId: "r1", state: "finalized", budgetLeft: 100_000, reservedBudget: 100_000 });
    const next = run({ inputRequestId: "r1", role: "review", budgetLeft: 200_000 });
    const inputs = [inputFor(next, "admin")];
    expect(planNext(view([prior, next], inputs), limitOf(300_000))).toEqual({ candidates: [{ runId: next.runId, kind: "worker", origin: "admin", budgetLeft: 200_000 }], held: [] });
    // 한도가 1 모자라면 줄여 시작하지 않고 보류한다.
    expect(planNext(view([prior, next], inputs), limitOf(299_999))).toEqual({ candidates: [], held: [{ runId: next.runId, kind: "worker", reason: "request_budget_exceeded" }] });
  });

  test("재현 2: 앞 작업들이 잡은 예산의 합이 셋째를 막는다(작업마다 역할 예산을 새로 받지 않는다)", () => {
    const a = run({ inputRequestId: "r2", state: "finalized", budgetLeft: 100_000, reservedBudget: 100_000 });
    // 관리자가 닫은 실행도 시작 예산 전부를 잡은 채다(D-94).
    const b = run({ inputRequestId: "r2", state: "not_started", closedByOperator: true, budgetLeft: 100_000, reservedBudget: 100_000 });
    const c = run({ inputRequestId: "r2", budgetLeft: 100_000 });
    const inputs = [inputFor(c, "admin")];
    expect(planNext(view([a, b, c], inputs), limitOf(250_000)).held).toEqual([{ runId: c.runId, kind: "worker", reason: "request_budget_exceeded" }]);
    expect(planNext(view([a, b, c], inputs), limitOf(300_000)).candidates.map((x) => x.runId)).toEqual([c.runId]);
    // 합이 한도에 닿았거나 넘으면 남은 것이 없다.
    expect(planNext(view([a, b, c], inputs), limitOf(200_000)).held).toEqual([{ runId: c.runId, kind: "worker", reason: "budget_exhausted" }]);
    expect(planNext(view([a, b, c], inputs), limitOf(199_999)).held).toEqual([{ runId: c.runId, kind: "worker", reason: "budget_exhausted" }]);
  });

  test("경계: 남은 몫과 자기 예산이 같으면 후보, 1 넘으면 보류", () => {
    const prior = run({ inputRequestId: "edge", state: "finalized", reservedBudget: 60_000 });
    const inputs = [inputFor(prior, "admin")];
    const exact = run({ inputRequestId: "edge", budgetLeft: LIMIT - 60_000 });
    expect(planNext(view([prior, exact], inputs), POLICY).candidates).toEqual([{ runId: exact.runId, kind: "worker", origin: "admin", budgetLeft: LIMIT - 60_000 }]);
    const over = { ...exact, budgetLeft: LIMIT - 60_000 + 1 };
    expect(planNext(view([prior, over], inputs), POLICY).held).toEqual([{ runId: exact.runId, kind: "worker", reason: "request_budget_exceeded" }]);
    // 남은 몫이 1이면 예산 1의 작업은 후보다.
    const one = run({ inputRequestId: "edge", budgetLeft: 1 });
    expect(planNext(view([{ ...prior, reservedBudget: LIMIT - 1 }, one], inputs), POLICY).candidates.map((x) => x.runId)).toEqual([one.runId]);
  });

  test("대기 중인 같은 요청의 다른 작업은 예약이 0이라 한도를 나누지 않고, 다른 요청의 예약은 섞지 않는다", () => {
    // 같은 요청의 목적이 다른 부탁 둘이 아직 대기 중이다. 둘 다 시작 전이라 앞 작업은 한도 전부를 볼 수 있다.
    const first = run({ inputRequestId: "pair", budgetLeft: 60_000 });
    const second = run({ inputRequestId: "pair", budgetLeft: 60_000 });
    const inputs = [inputFor(first, "admin")];
    expect(planNext(view([first, second], inputs), POLICY)).toEqual({
      candidates: [{ runId: first.runId, kind: "worker", origin: "admin", budgetLeft: 60_000 }],
      held: [{ runId: second.runId, kind: "worker", reason: "waiting_turn" }],
    });
    // 첫째가 시작해 60_000을 잡으면 둘째의 남은 몫은 40_000이다.
    const started = { ...first, state: "running" as const, reservedBudget: 60_000 };
    expect(planNext(view([started, second], inputs), POLICY).held).toEqual([{ runId: second.runId, kind: "worker", reason: "request_budget_exceeded" }]);
    // 다른 요청이 한도를 다 잡았어도 이 요청과는 무관하다.
    const other = run({ inputRequestId: "elsewhere", state: "finalized", reservedBudget: LIMIT });
    expect(planNext(view([other, first], [...inputs, inputFor(other, "admin")]), POLICY).candidates.map((x) => x.runId)).toEqual([first.runId]);
  });

  test("예약을 모르면 보류하되 남은 예산 0을 가리지 않고, 세션 줄은 예약을 세지 않는다", () => {
    const current = run({ inputRequestId: "unk", budgetLeft: 10 });
    const inputs = [inputFor(current, "admin")];
    for (const reserved of [null, undefined, Number.NaN, -1, 1.5, "10", Number.MAX_SAFE_INTEGER + 1]) {
      const label = String(reserved);
      const prior = run({ inputRequestId: "unk", state: "finalized", reservedBudget: broken<number | null>(reserved) });
      expect(planNext(view([prior, current], inputs), POLICY), label).toEqual({ candidates: [], held: [{ runId: current.runId, kind: "worker", reason: "budget_unknown" }] });
      const spent = run({ inputRequestId: "unk", state: "finalized", budgetLeft: 0 });
      expect(planNext(view([prior, spent, current], inputs), POLICY).held, label).toEqual([{ runId: current.runId, kind: "worker", reason: "budget_exhausted" }]);
    }
    // 세션 줄에는 장부가 예약을 싣지 않는다. 같은 요청에 세션 줄이 있어도 모름이 아니고 합에도 넣지 않는다.
    const sessionRow = run({ inputRequestId: "unk", kind: "session", role: null, state: "finalized", reservedBudget: undefined });
    expect(planNext(view([sessionRow, current], inputs), POLICY).candidates.map((x) => x.runId)).toEqual([current.runId]);
    expect(planNext(view([{ ...sessionRow, reservedBudget: LIMIT }, current], inputs), POLICY).candidates.map((x) => x.runId)).toEqual([current.runId]);
  });

  test("시작 지시가 있는 작업자 줄의 예약 0은 장부와 어긋난 읽기라 모름으로 보류하고, 대기·대기에서 닫힌 줄의 0만 믿는다", () => {
    // 실제 장부에서는 시작 지시와 같은 트랜잭션에 1 이상의 예산이 고정되므로 이런 줄은 포트가 꼴이 틀린 답을 줄 때만 나온다.
    const current = run({ inputRequestId: "zero", budgetLeft: 10 });
    const inputs = [inputFor(current, "admin")];
    for (const state of ["preparing", "running", "stopping", "unknown_running", "checking", "ready_result", "failed_stopped", "cleanup_pending", "finalized"] as const) {
      const prior = run({ inputRequestId: "zero", state, reservedBudget: 0 });
      expect(planNext(view([prior, current], inputs), POLICY).held, state).toEqual([{ runId: current.runId, kind: "worker", reason: "budget_unknown" }]);
    }
    const waiting = run({ inputRequestId: "zero", reservedBudget: 0 });
    const closedWaiting = run({ inputRequestId: "zero", state: "not_started", closedByOperator: false, reservedBudget: 0 });
    expect(planNext(view([closedWaiting, current], inputs), POLICY).candidates.map((x) => x.runId)).toEqual([current.runId]);
    expect(planNext(view([current, waiting], inputs), POLICY).candidates.map((x) => x.runId)).toEqual([current.runId]);
  });

  test("한도는 입력의 출처마다 따로다", () => {
    const prior = run({ inputRequestId: "org", state: "finalized", reservedBudget: 20_000 });
    const next = run({ inputRequestId: "org", budgetLeft: 50_000 });
    const policy = limitOf(100_000, 60_000);
    expect(planNext(view([prior, next], [inputFor(next, "admin")]), policy).candidates.map((x) => x.runId)).toEqual([next.runId]);
    expect(planNext(view([prior, next], [inputFor(next, "alert")]), policy).held).toEqual([{ runId: next.runId, kind: "worker", reason: "request_budget_exceeded" }]);
  });

  test("요청 한도가 없거나 출처 하나라도 양의 안전 정수가 아니면 판단하지 않는다", () => {
    for (const requestBudget of [undefined, null, 100_000, "100000", {}, { admin: 100_000 }, { alert: 100_000 }]) {
      expect(() => planNext(view([], []), { alertMaxWaitMs: 60_000, requestBudget: broken<SchedulerPolicy["requestBudget"]>(requestBudget) }), String(requestBudget)).toThrow(TypeError);
    }
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "100000"]) {
      expect(() => planNext(view([], []), limitOf(broken<number>(bad), 100_000)), `admin ${String(bad)}`).toThrow(TypeError);
      expect(() => planNext(view([], []), limitOf(100_000, broken<number>(bad))), `alert ${String(bad)}`).toThrow(TypeError);
    }
    expect(() => planNext(view([], []), limitOf(1))).not.toThrow();
  });
});

describe("장부에서 읽은 상태를 입력으로", () => {
  test("queueView·listRuns·slotHolds의 반환이 입력 타입에 맞고, 출처를 받기 전에는 시작 후보가 없다", () => {
    const ledger = ready(open(tempPath()));
    const sources: Record<string, Origin> = {};
    const enqueue = (source: string, origin: Origin) => {
      const requestId = id();
      must(ledger.enqueueInput({ requestId, source, sourceRef: { ref: `inbox/${id()}`, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
      sources[requestId] = origin;
      return requestId;
    };
    const alertReq = enqueue("alertmanager", "alert");
    const adminReq = enqueue("admin-dm", "admin");
    const alertRun = must(ledger.admitRun(worker({ inputRequestId: alertReq }))).run;
    const adminRun = must(ledger.admitRun(worker({ inputRequestId: adminReq }))).run;

    const read = () => {
      const queue = ledger.queueView();
      const all = ledger.listRuns();
      const holds = ledger.slotHolds();
      if (!queue.known || !all.known || !holds.known) throw new Error("장부를 읽지 못함");
      const bars = new Map(queue.value.runs.map((r) => [r.runId, r.startBar]));
      const runs: SchedulerRun[] = all.value.map((r) => ({ ...r, startBar: bars.get(r.runId) ?? null }));
      return { runs, pending: queue.value.inputs.pending, slotHolds: holds.value };
    };

    // 지금의 queueView는 입력의 출처와 접수 시각을 내주지 않는다. 그 칸이 없으면 둘 다 보류다.
    const bare = read();
    expect(planNext({ runs: bare.runs, inputs: [], slotHolds: bare.slotHolds, now: NOW }, POLICY).candidates).toEqual([]);

    // 장부가 가진 출처를 부르는 쪽이 채운 경우(장부가 더 내줘야 하는 읽기)에는 관리자 요청이 후보다.
    const withOrigin = (pending: typeof bare.pending): SchedulerInput[] =>
      pending.map((p) => ({ requestId: p.requestId, origin: sources[p.requestId] as Origin, receivedAt: NOW, expiresAt: p.sourceRef.expiresAt, cancelled: false }));
    const decision = planNext({ runs: bare.runs, inputs: withOrigin(bare.pending), slotHolds: bare.slotHolds, now: NOW + 1 }, POLICY);
    expect(decision.candidates.map((c) => c.runId)).toEqual([adminRun.runId]);

    // 후보는 허가가 아니다: 장부의 startRun이 자리를 잡은 뒤 다시 읽으면 다른 하나는 슬롯 때문에 보류다.
    must(ledger.startRun({ runId: adminRun.runId, requestId: id(), stopGeneration: 0, now: NOW }));
    const after = read();
    const next = planNext({ runs: after.runs, inputs: withOrigin(after.pending), slotHolds: after.slotHolds, now: NOW + 2 }, POLICY);
    expect(next).toEqual({ candidates: [], held: [{ runId: alertRun.runId, kind: "worker", reason: "slot_occupied" }] });
  });

  // 배정기처럼 후보마다 startRun을 부른다. 판단이 후보를 내지 않으면 부를 것이 없어 대기 실행이 그대로 남는다.
  const startEach = (ledger: ReturnType<typeof open>, candidates: { runId: string }[]) => {
    for (const c of candidates) ledger.startRun({ runId: c.runId, requestId: id(), stopGeneration: 0, now: NOW });
  };
  const stateOf = (ledger: ReturnType<typeof open>, runId: string) => {
    const got = ledger.getRun(runId);
    if (!got.known || got.value === null) throw new Error("실행을 읽지 못함");
    return got.value.state;
  };

  // 같은 입력에 실행 둘을 잔액 10으로 등록한다. spend면 뒤 순번 실행에 잔액 0과 대기 종료를 장부 API로 적는다.
  const twoRuns = (spend: boolean) => {
    const ledger = ready(open(tempPath()));
    const requestId = id();
    must(ledger.enqueueInput({ requestId, source: "admin-dm", sourceRef: { ref: `inbox/${id()}`, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
    const first = must(ledger.admitRun(worker({ inputRequestId: requestId, budgetLeft: 10 }))).run;
    const later = must(ledger.admitRun(worker({ inputRequestId: requestId, budgetLeft: 10 }))).run;
    if (spend) {
      must(ledger.recordBudget({ runId: later.runId, budgetLeft: 0, now: NOW }));
      must(ledger.recordStopInstruction({ runId: later.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW }));
    }
    const queue = ledger.queueView();
    const all = ledger.listRuns();
    const holds = ledger.slotHolds();
    if (!queue.known || !all.known || !holds.known) throw new Error("장부를 읽지 못함");
    const bars = new Map(queue.value.runs.map((r) => [r.runId, r.startBar]));
    const runs: SchedulerRun[] = all.value.map((r) => ({ ...r, startBar: bars.get(r.runId) ?? null }));
    const inputs: SchedulerInput[] = queue.value.inputs.pending.map((p) => ({ requestId: p.requestId, origin: "admin", receivedAt: NOW, expiresAt: p.sourceRef.expiresAt, cancelled: false }));
    return { ledger, first, later, runs, inputs, slotHolds: holds.value };
  };

  test("F1: 뒤 순번 실행이 소진된 장부에서는 startRun까지 가지 않는다", () => {
    const { ledger, first, later, runs, inputs, slotHolds } = twoRuns(true);
    expect(runs.map((r) => [r.runId, r.state, r.budgetLeft])).toEqual([
      [first.runId, "queued", 10],
      [later.runId, "not_started", 0],
    ]);
    const decision = planNext({ runs, inputs, slotHolds, now: NOW + 1 }, POLICY);
    startEach(ledger, decision.candidates);
    expect(stateOf(ledger, first.runId)).toBe("queued");
    expect(decision.candidates).toEqual([]);
  });

  test("F2: 지금 시각이 NaN이면 startRun까지 가지 않는다", () => {
    const { ledger, first, later, runs, inputs, slotHolds } = twoRuns(false);
    const decision = planNext({ runs, inputs, slotHolds, now: Number.NaN }, POLICY);
    startEach(ledger, decision.candidates);
    expect(stateOf(ledger, first.runId)).toBe("queued");
    expect(stateOf(ledger, later.runId)).toBe("queued");
    expect(decision.candidates).toEqual([]);
  });
});

describe("수명 전이의 의도", () => {
  // 시험이 장부의 표를 직접 읽어 판정한다(구현의 도우미를 쓰지 않는다).
  const allowed = (kind: RunKind, from: LedgerRunState, to: LedgerRunState) => from === to || (TRANSITIONS[kind][from]?.includes(to) ?? false);

  // 넷째는 갱신 주기가 돌았고 끝까지 전달 여유가 남은 임대다. 셋째는 주기가 돌았지만 여유가 남지 않은 임대다.
  const leases = [
    null,
    { issuedAt: NOW - 1_000, expiresAt: NOW + 29_000 },
    { issuedAt: NOW - 20_000, expiresAt: NOW + 10_000 },
    { issuedAt: NOW - 10_000, expiresAt: NOW + 20_000 },
    { issuedAt: NOW - 40_000, expiresAt: NOW - 10_000 },
  ];
  const lasts = [null, "unknown" as const, NOW - 1_000, NOW - 60_000];

  test("모든 상태와 입력 조합에서 표가 허락하지 않는 의도를 내지 않는다", () => {
    const seen = new Set<string>();
    for (const kind of ["worker", "session"] as const) {
      for (const state of LEDGER_RUN_STATES) {
        for (const lease of leases) {
          for (const lastInstructionAt of lasts) {
            for (const cancelRequested of [false, true]) {
              for (const resultSettled of [false, true]) {
                for (const deadlineAt of [NOW + 600_000, NOW]) {
                  const v: LifecycleView = { run: { runId: "r", kind, state, deadlineAt }, lease, cancelRequested, lastInstructionAt, resultSettled, now: NOW };
                  const out = nextIntent(v, LIFE);
                  seen.add(`${kind}:${state}:${out.intent}`);
                  if (out.intent === "wait") {
                    expect(out.toward).toBe(state);
                    continue;
                  }
                  expect({ kind, state, out: out.intent, ok: allowed(kind, state, out.toward) }).toEqual({ kind, state, out: out.intent, ok: true });
                  // 확정·종료는 실제로 상태를 옮기는 의도다.
                  if (out.intent === "finalize" || out.intent === "stop") expect(out.toward).not.toBe(state);
                }
              }
            }
          }
        }
      }
    }
    // 끝난 실행과 종료 확인 뒤의 결과 검사(checking)에는 조회·갱신·종료를 내지 않는다.
    for (const state of ["finalized", "not_started", "checking"] as const) {
      for (const intent of ["query", "renew_lease", "stop", "finalize"]) expect(seen.has(`worker:${state}:${intent}`)).toBe(false);
    }
    // 각 의도가 실제로 나오는 상태가 있다(시험이 빈 판단을 통과시키지 않는다).
    for (const key of ["worker:running:renew_lease", "worker:running:stop", "worker:unknown_running:query", "worker:stopping:query", "worker:failed_stopped:finalize", "worker:queued:stop", "session:running:renew_lease"]) {
      expect(seen.has(key)).toBe(true);
    }
  });

  test("지난 임대를 갱신으로 되살리지 않고, 결과 보관 전에는 확정하지 않는다", () => {
    const base = { cancelRequested: false, lastInstructionAt: null, resultSettled: false, now: NOW };
    const running = { runId: "r", kind: "worker" as const, state: "running" as const, deadlineAt: NOW + 600_000 };
    expect(nextIntent({ ...base, run: running, lease: { issuedAt: NOW - 40_000, expiresAt: NOW } }, LIFE).intent).toBe("query");
    expect(nextIntent({ ...base, run: running, lease: { issuedAt: NOW - 10_000, expiresAt: NOW + 20_000 } }, LIFE).intent).toBe("renew_lease");
    expect(nextIntent({ ...base, run: running, lease: { issuedAt: NOW - 9_999, expiresAt: NOW + 20_001 } }, LIFE).intent).toBe("wait");
    const ready = { ...running, state: "ready_result" as const };
    expect(nextIntent({ ...base, run: ready, lease: null }, LIFE).intent).toBe("wait");
    expect(nextIntent({ ...base, resultSettled: true, run: ready, lease: null }, LIFE).intent).toBe("finalize");
    expect(nextIntent({ ...base, resultSettled: true, lastInstructionAt: NOW - 1, run: ready, lease: null }, LIFE).intent).toBe("wait");
  });
});
