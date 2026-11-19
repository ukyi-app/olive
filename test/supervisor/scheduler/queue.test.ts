import { describe, expect, test } from "bun:test";
import { LEDGER_RUN_STATES, type LedgerRunState, type RunKind, TRANSITIONS } from "../../../src/ledger/index.ts";
import { type LifecyclePolicy, type LifecycleView, nextIntent } from "../../../src/supervisor/scheduler/lifecycle.ts";
import { type HoldReason, type Origin, planNext, type SchedulerInput, type SchedulerPolicy, type SchedulerRun, type SchedulerView } from "../../../src/supervisor/scheduler/queue.ts";
import { id, must, NOW, open, ready, tempPath, worker } from "../../ledger/helpers.ts";

// 숫자는 이 시험이 고른 값이다. 운영값이 아니다(운영값은 배포가 넣는다).
const POLICY: SchedulerPolicy = { alertMaxWaitMs: 60_000 };
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

  test("같은 입력 ID의 재시도·새 세션 줄은 예산 보충 0", () => {
    // 같은 입력의 앞 실행이 남긴 예산보다 많이 받은 새 실행 줄은 시작 후보가 아니다.
    const prior = run({ state: "finalized", budgetLeft: 1_000 });
    const retry = run({ inputRequestId: prior.inputRequestId, budgetLeft: 50_000 });
    const inputs = [inputFor(prior, "admin")];
    expect(planNext(view([prior, retry], inputs), POLICY)).toEqual({ candidates: [], held: [{ runId: retry.runId, kind: "worker", reason: "budget_replenished" }] });

    // 앞 실행이 남긴 만큼 이하면 그 값 그대로 후보다(늘지 않는다).
    const fair = { ...retry, budgetLeft: 1_000 };
    expect(planNext(view([prior, fair], inputs), POLICY).candidates).toEqual([{ runId: retry.runId, kind: "worker", origin: "admin", budgetLeft: 1_000 }]);

    // 앞 실행이 예산을 다 썼으면 새 실행 줄의 값과 무관하게 보류다.
    const spent = { ...prior, budgetLeft: 0 };
    expect(planNext(view([spent, fair], inputs), POLICY).held).toEqual([{ runId: retry.runId, kind: "worker", reason: "budget_exhausted" }]);
    expect(planNext(view([run({ budgetLeft: 0, inputRequestId: "solo" })], [{ ...inputs[0]!, requestId: "solo" }]), POLICY).held[0]?.reason).toBe("budget_exhausted");

    // 입력이 만료됐거나 기한이 지났으면 보류다(지금 시각으로 다시 본다).
    const late = run();
    expect(planNext(view([late], [inputFor(late, "admin", { expiresAt: NOW })]), POLICY).held[0]?.reason).toBe("input_expired");
    expect(planNext(view([late], [inputFor(late, "admin")], { now: late.deadlineAt }), POLICY).held[0]?.reason).toBe("deadline_passed");
  });

  test("설정값이 없거나 틀리면 판단하지 않는다", () => {
    expect(() => planNext(view([], []), { alertMaxWaitMs: 0 })).toThrow(TypeError);
    expect(() => planNext(view([], []), {} as SchedulerPolicy)).toThrow(TypeError);
  });
});

// 장부 밖에서 조립한 값이 빠지거나 꼴이 틀린 경우. 모르면 시작 후보도 갱신도 내지 않는다.
// 시험이 일부러 틀린 꼴을 넣으므로 타입을 우회한다.
const broken = <T>(value: unknown) => value as T;

describe("모르거나 꼴이 틀린 입력", () => {
  test("F1: 같은 입력에서 소진된 실행이 있으면 대기 순번과 무관하게 후보 0", () => {
    const first = run({ inputRequestId: "same", budgetLeft: 10 });
    const later = run({ inputRequestId: "same", state: "finalized", budgetLeft: 0 });
    const inputs = [inputFor(first, "admin")];
    expect(planNext(view([first, later], inputs), POLICY)).toEqual({ candidates: [], held: [{ runId: first.runId, kind: "worker", reason: "budget_exhausted" }] });

    // 시작한 실행이 실제로 쓰고 남긴 잔액은 순번이 뒤여도 상한이다.
    const used = { ...later, budgetLeft: 3 };
    expect(planNext(view([first, used], inputs), POLICY).held).toEqual([{ runId: first.runId, kind: "worker", reason: "budget_replenished" }]);

    // 아직 시작하지 않은 뒤 순번 줄의 최초 배정액은 앞 줄의 상한이 아니다.
    const smaller = run({ inputRequestId: "same", budgetLeft: 5 });
    expect(planNext(view([first, smaller], inputs), POLICY).candidates.map((c) => c.runId)).toEqual([first.runId]);
  });

  test("시작 전에 닫힌 줄(not_started)의 배정액은 상한이 아니고, 소진과 시작한 줄의 잔액은 그대로 상한이다", () => {
    // not_started로 들어오는 길이 queued뿐인 동안만 성립한다. 표가 바뀌면 이 단언이 먼저 실패한다.
    for (const kind of ["worker", "session"] as const) {
      expect(Object.entries(TRANSITIONS[kind]).filter(([, to]) => to?.includes("not_started")).map(([from]) => from), kind).toEqual(["queued"]);
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
    // 시작한 적 있는 줄(시작 뒤에 끝난 상태)의 잔액은 순번과 무관하게 상한이다.
    for (const state of ["finalized", "failed_stopped", "cleanup_pending"] as const) {
      expect(planNext(view([current, { ...closedLater, state }], inputs), POLICY).held, state).toEqual([{ runId: current.runId, kind: "worker", reason: "budget_replenished" }]);
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
    expect(nextIntent({ ...base, run: running, lease: { issuedAt: NOW - 20_000, expiresAt: NOW + 1 } }, LIFE).intent).toBe("renew_lease");
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

  const leases = [null, { issuedAt: NOW - 1_000, expiresAt: NOW + 29_000 }, { issuedAt: NOW - 20_000, expiresAt: NOW + 10_000 }, { issuedAt: NOW - 40_000, expiresAt: NOW - 10_000 }];
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
