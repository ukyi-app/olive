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

  test("재시도·새 세션은 예산 보충 0", () => {
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
});

describe("수명 전이의 의도", () => {
  // 시험이 장부의 표를 직접 읽어 판정한다(구현의 도우미를 쓰지 않는다).
  const allowed = (kind: RunKind, from: LedgerRunState, to: LedgerRunState) => from === to || (TRANSITIONS[kind][from]?.includes(to) ?? false);

  const leases = [null, { issuedAt: NOW - 1_000, expiresAt: NOW + 29_000 }, { issuedAt: NOW - 20_000, expiresAt: NOW + 10_000 }, { issuedAt: NOW - 40_000, expiresAt: NOW - 10_000 }];
  const lasts = [null, NOW - 1_000, NOW - 60_000];

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
