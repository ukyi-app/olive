// 박자 순서기(src/supervisor/runtime/cycle.ts). 박자 넷·서버 tick·장부 읽기·시계는 모두 가짜이고, 부른 차례와 넘긴 인자를 기록한다.
// 박자가 기다리는 동안의 일은 시험이 직접 쥔 약속(deferred)으로 차례를 정한다. 실제 시간을 기다리지 않는다.
import { describe, expect, test } from "bun:test";
import type { TickResult as AssignTickResult, AssignLoopPolicy, AssignLoopPorts } from "../../../src/supervisor/dispatch/assign-loop.ts";
import { assignAndStartTick } from "../../../src/supervisor/dispatch/assign-loop.ts";
import { type LifeLoopPorts, type LifeTickResult, lifeTick } from "../../../src/supervisor/dispatch/life-loop.ts";
import { type LinkLossPorts, type LinkLossTickResult, linkLossTick, type WatchEntry } from "../../../src/supervisor/dispatch/link-loss.ts";
import type { Clock } from "../../../src/supervisor/dispatch/ports.ts";
import { type ResendPorts, type ResendTickResult, resendTick, START_LAST_SEAL_MS } from "../../../src/supervisor/dispatch/resend.ts";
import {
  ASSIGN_CALLS_MAX,
  type BeatReport,
  type CycleBeats,
  type CycleDeps,
  type CycleLedger,
  CyclePolicyError,
  createCycle,
} from "../../../src/supervisor/runtime/cycle.ts";
import type { LifecyclePolicy } from "../../../src/supervisor/scheduler/lifecycle.ts";
import { readText } from "../../files.ts";

const W1 = "executor/diagnosis/0/store-b";
const W2 = "executor/diagnosis/1/store-c";
const RUN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQ_1 = "11111111-1111-4111-8111-111111111111";
const REQ_2 = "22222222-2222-4222-8222-222222222222";
const REQ_3 = "33333333-3333-4333-8333-333333333333";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const linkLossRan = (watch: readonly WatchEntry[] = [], extra: Partial<Extract<LinkLossTickResult, { kind: "ran" }>> = {}): LinkLossTickResult => ({
  kind: "ran",
  executors: [],
  watch,
  halted: null,
  haltedAt: null,
  ...extra,
});
const lifeRan = (runs: readonly unknown[] = [], halted: "threw" | null = null): LifeTickResult =>
  ({ kind: "ran", runs, pendingQueries: [], halted, haltedAt: halted === null ? null : RUN_A }) as LifeTickResult;
const resendRan = (instructions: readonly unknown[] = [], halted: "threw" | null = null): ResendTickResult =>
  ({ kind: "ran", instructions, halted, haltedAt: halted === null ? null : REQ_1 }) as ResendTickResult;
const assignRan = (requests: readonly unknown[] = [], halted: "threw" | "intake_closed" | null = null): AssignTickResult =>
  ({ kind: "ran", starts: [], requests, halted, haltedAt: null }) as AssignTickResult;
const assigned = (runId: string) => ({ ref: `ref-${runId}`, outcome: "assigned", runId, executorId: W1 });

type Ran = Extract<BeatReport, { kind: "ran" }>;
const ran = (report: BeatReport): Ran => {
  if (report.kind !== "ran") throw new Error(`ran이 아니다: ${JSON.stringify(report)}`);
  return report;
};

function harness(policy: Partial<CycleDeps["policy"]> = {}) {
  const calls: string[] = [];
  const state = {
    wall: 2_000_000,
    mono: 500,
    restoreDone: true as boolean | (() => boolean),
    runs: [] as { runId: string; state: string }[],
    renewIssuedAt: null as number | null,
    unanswered: [] as { requestId: string }[],
  };
  const seen = {
    linkLoss: [] as { clocks: { clock: Clock; monotonic: { now(): number } }; policy: unknown; input: { watch: readonly WatchEntry[] } }[],
    life: [] as { clock: Clock; input: { lastQueries: readonly { runId: string; at: number }[]; unsentRenews: readonly string[] } }[],
    resend: [] as { clock: Clock; policy: unknown; input: { lastResends: readonly { requestId: string; at: number }[] } }[],
    assign: [] as number[],
    instructionTimes: [] as string[],
  };
  // 박자마다 돌려줄 결과. 함수를 바꿔 끼워 사례를 만든다.
  const next = {
    linkLoss: (): LinkLossTickResult => linkLossRan(),
    life: (): Promise<LifeTickResult> | LifeTickResult => lifeRan(),
    resend: (): Promise<ResendTickResult> | ResendTickResult => resendRan(),
    assign: (): Promise<AssignTickResult> | AssignTickResult => assignRan(),
  };
  const beats: CycleBeats = {
    linkLoss(clocks, linkPolicy, input) {
      calls.push("linkLoss");
      seen.linkLoss.push({ clocks, policy: linkPolicy, input });
      return next.linkLoss();
    },
    async life(clock, input) {
      calls.push("life");
      seen.life.push({ clock, input });
      const result = await next.life();
      calls.push("life:returned");
      return result;
    },
    async resend(clock, resendPolicy, input) {
      calls.push("resend");
      seen.resend.push({ clock, policy: resendPolicy, input });
      return next.resend();
    },
    async assign(now) {
      calls.push("assign");
      seen.assign.push(now);
      return next.assign();
    },
  };
  const ledger = {
    listRuns() {
      calls.push("read:runs");
      return { known: true, value: state.runs.map((run) => ({ ...run })) };
    },
    instructionTimes(runId: string) {
      calls.push("read:instruction_times");
      seen.instructionTimes.push(runId);
      return { known: true, value: { runId, lease: null, renewIssued: state.renewIssuedAt === null ? null : { issuedAt: state.renewIssuedAt, leaseUntil: "unknown" }, lastStopAt: null, lastFinalizeAt: null } };
    },
    unansweredInstructions() {
      calls.push("read:unanswered");
      return { known: true, value: { stopGeneration: 0, instructions: state.unanswered } };
    },
  } as unknown as CycleLedger;
  const reports: BeatReport[] = [];
  const deps: CycleDeps = {
    beats,
    serverTick: () => {
      calls.push("tick");
    },
    ledgerClock: { now: () => state.wall },
    monotonic: { now: () => state.mono },
    restoreDone: () => (typeof state.restoreDone === "function" ? state.restoreDone() : state.restoreDone),
    ledger,
    policy: { judgeMs: 30_000, resendEveryMs: 5_000, assignCallsPerBeat: 3, ...policy },
    observe: (report) => {
      reports.push(report);
    },
  };
  return { calls, state, seen, next, deps, reports, ledger };
}

describe("차례", () => {
  test("한 박자는 서버 tick → 끊김 → 수명 → 재전송 → 배정이고, 끊김이 돌아온 뒤에 수명을 부른다", async () => {
    const h = harness();
    h.next.linkLoss = () => {
      // 끊김 박자 안에서는 수명 박자가 아직 불리지 않았다.
      expect(h.calls).toEqual(["tick", "linkLoss"]);
      return linkLossRan();
    };
    const report = ran(await createCycle(h.deps).beat());
    expect(h.calls).toEqual(["tick", "linkLoss", "life", "life:returned", "resend", "assign"]);
    expect([report.serverTick, report.clock, report.linkLoss.kind, report.life.kind, report.resend.kind, report.assign.map((step) => step.kind)]).toEqual([
      "ok",
      "ok",
      "returned",
      "returned",
      "returned",
      ["returned"],
    ]);
    expect(h.reports).toEqual([report]);
  });

  test("배정 결과에 assigned가 있으면 같은 박자에서 다시 부르고, 상한에서 멈춘다", async () => {
    const h = harness({ assignCallsPerBeat: 3 });
    const results = [assignRan([assigned(RUN_A)]), assignRan([assigned(RUN_B)]), assignRan()];
    h.next.assign = () => results.shift() ?? assignRan();
    const cycle = createCycle(h.deps);
    expect(ran(await cycle.beat()).assign).toHaveLength(3);
    expect(h.calls.filter((call) => call === "assign")).toHaveLength(3);

    h.calls.length = 0;
    h.next.assign = () => assignRan([assigned(RUN_C)]);
    expect(ran(await cycle.beat()).assign).toHaveLength(3);
    expect(h.calls.filter((call) => call === "assign")).toHaveLength(3);
  });

  test("assigned가 없거나 배정이 멈추면 다시 부르지 않는다", async () => {
    const h = harness({ assignCallsPerBeat: 3 });
    const cycle = createCycle(h.deps);
    h.next.assign = () => assignRan([{ ref: "r", outcome: "already_assigned", runId: RUN_A, executorId: W1 }]);
    expect(ran(await cycle.beat()).assign).toHaveLength(1);
    h.next.assign = () => assignRan([assigned(RUN_A)], "intake_closed");
    expect(ran(await cycle.beat()).assign).toHaveLength(1);
    h.next.assign = () => ({ kind: "not_run", reason: "intake_closed" }) as AssignTickResult;
    expect(ran(await cycle.beat()).assign).toHaveLength(1);
  });
});

describe("직렬화와 재진입", () => {
  test("박자가 진행 중이면 둘째 beat()는 기다리지 않고 거절되고, 아무 박자도 부르지 않는다", async () => {
    const h = harness();
    const gate = deferred<LifeTickResult>();
    h.next.life = () => gate.promise;
    const cycle = createCycle(h.deps);
    const first = cycle.beat();
    await Promise.resolve();
    // 거절은 기다리지 않는다: 이미 정해진 약속이라 앞에 둔 쪽이 이긴다.
    expect(await Promise.race([cycle.beat(), Promise.resolve("pending")])).toEqual({ kind: "skipped", reason: "beat_in_progress" });
    expect(h.calls).toEqual(["tick", "linkLoss", "life"]);
    gate.resolve(lifeRan());
    expect((await first).kind).toBe("ran");
    // 앞 박자가 돌아온 뒤에는 다시 돈다.
    h.calls.length = 0;
    h.next.life = () => lifeRan();
    expect((await cycle.beat()).kind).toBe("ran");
    expect(h.calls[0]).toBe("tick");
  });

  test("박자 안의 동기 포트(서버 tick, 끊김 박자)에서 다시 부른 beat()는 재진입하지 않는다", async () => {
    const h = harness();
    // 다시 부르기는 자리마다 한 번만 한다. 재진입을 막지 못하는 구현에서도 무한히 들어가지 않고 시험이 실패하게 한다.
    const inner: Promise<BeatReport>[] = [];
    let fromTick = false;
    let fromLinkLoss = false;
    const cycle = createCycle({
      ...h.deps,
      serverTick: () => {
        h.calls.push("tick");
        if (fromTick) return;
        fromTick = true;
        inner.push(cycle.beat());
      },
    });
    h.next.linkLoss = () => {
      if (!fromLinkLoss) {
        fromLinkLoss = true;
        inner.push(cycle.beat());
      }
      return linkLossRan();
    };
    await cycle.beat();
    expect(await Promise.all(inner)).toEqual([
      { kind: "skipped", reason: "beat_in_progress" },
      { kind: "skipped", reason: "beat_in_progress" },
    ]);
    expect(h.calls.filter((call) => call === "tick")).toHaveLength(1);
    expect(h.calls.filter((call) => call === "linkLoss")).toHaveLength(1);
  });
});

describe("복원 전", () => {
  test("복원이 끝나기 전에는 서버 tick만 부르고 박자 넷은 부르지 않는다", async () => {
    const h = harness();
    h.state.restoreDone = false;
    const report = ran(await createCycle(h.deps).beat());
    expect(h.calls).toEqual(["tick"]);
    expect([report.linkLoss, report.life, report.resend, ...report.assign]).toEqual(Array(4).fill({ kind: "skipped", reason: "restore_not_done" }));
  });

  test("복원 끝 여부가 박자 중에 거짓이 되거나 던지면 남은 박자를 부르지 않는다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    h.next.linkLoss = () => {
      h.state.restoreDone = false;
      return linkLossRan();
    };
    const report = ran(await cycle.beat());
    expect(h.calls).toEqual(["tick", "linkLoss"]);
    expect(report.life).toEqual({ kind: "skipped", reason: "restore_not_done" });

    h.calls.length = 0;
    h.state.restoreDone = () => {
      throw new Error("복원기 읽기 실패");
    };
    await cycle.beat();
    expect(h.calls).toEqual(["tick"]);
  });
});

describe("기억 넷", () => {
  test("watch: ran이면 멈췄어도 결과의 것, not_run이면 앞 것을 넘긴다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    const first = [{ executorId: W1, absentSince: null }];
    const second = [{ executorId: W1, absentSince: 700 }];
    h.next.linkLoss = () => linkLossRan(first);
    await cycle.beat();
    h.next.linkLoss = () => linkLossRan(second, { halted: "threw", haltedAt: W1 });
    await cycle.beat();
    h.next.linkLoss = () => ({ kind: "not_run", reason: "links_unknown" });
    await cycle.beat();
    h.next.linkLoss = () => {
      throw new Error("묶은 박자가 던짐");
    };
    await cycle.beat();
    await cycle.beat();
    expect(h.seen.linkLoss.map((call) => call.input.watch)).toEqual([[], first, second, second, second]);
  });

  test("watch: candidate는 absentSince null로 더하고, 끊김 박자 안에서 더한 것도 결과가 덮지 않는다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    h.next.linkLoss = () => linkLossRan([{ executorId: W1, absentSince: 900 }]);
    await cycle.beat();
    cycle.noteCandidate(W1);
    cycle.noteCandidate("session/diagnosis/0");
    cycle.noteCandidate("not a principal");
    h.next.linkLoss = () => {
      cycle.noteCandidate(W2);
      return linkLossRan([{ executorId: W1, absentSince: 1200 }]);
    };
    await cycle.beat();
    await cycle.beat();
    expect(h.seen.linkLoss.map((call) => call.input.watch)).toEqual([
      [],
      [{ executorId: W1, absentSince: null }],
      [
        { executorId: W1, absentSince: 1200 },
        { executorId: W2, absentSince: null },
      ],
    ]);
  });

  test("lastQueries: query_sent와 delivery unknown인 query_not_sent의 at만 넘기고, 끝난 실행은 완결된 결과에서만 뺀다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    h.next.life = () =>
      lifeRan([
        { runId: RUN_A, outcome: "query_sent", requestId: REQ_1, executorId: W1, at: 2_000_111, cause: "intent" },
        { runId: RUN_B, outcome: "query_not_sent", at: 2_000_222, cause: "intent", reason: "send_threw", delivery: "unknown" },
        { runId: RUN_C, outcome: "query_not_sent", at: 2_000_333, cause: "intent", reason: "no_connection", delivery: "not_sent" },
      ]);
    await cycle.beat();
    // 멈춘 박자의 목록에 A가 없어도 A의 시각은 남는다.
    h.next.life = () => lifeRan([{ runId: RUN_B, outcome: "query_held", lastQueryAt: 2_000_222, cause: "intent" }], "threw");
    await cycle.beat();
    // 완결된 결과에 A가 없으면 뺀다(끝난 실행).
    h.next.life = () => lifeRan([{ runId: RUN_B, outcome: "wait" }]);
    await cycle.beat();
    await cycle.beat();
    expect(h.seen.life.map((call) => call.input.lastQueries)).toEqual([
      [],
      [
        { runId: RUN_A, at: 2_000_111 },
        { runId: RUN_B, at: 2_000_222 },
      ],
      [
        { runId: RUN_A, at: 2_000_111 },
        { runId: RUN_B, at: 2_000_222 },
      ],
      [{ runId: RUN_B, at: 2_000_222 }],
    ]);
  });

  test("lastResends: resent와 delivery unknown인 not_sent의 at을 넘기고 sealedAt은 넘기지 않는다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    const head = (requestId: string) => ({ requestId, runId: RUN_A, action: "task_cancel" });
    h.next.resend = () =>
      resendRan([
        { ...head(REQ_1), outcome: "resent", executorId: W1, sealedAt: 2_000_100, at: 2_005_100 },
        { ...head(REQ_2), outcome: "not_sent", reason: "send_threw", delivery: "unknown", executorId: W1, sealedAt: 2_000_200, at: 2_005_200 },
        { ...head(REQ_3), outcome: "not_sent", reason: "no_connection", delivery: "not_sent", executorId: W1, sealedAt: 2_000_300 },
      ]);
    await cycle.beat();
    h.next.resend = () => resendRan([{ ...head(REQ_2), outcome: "held", lastAt: 2_005_200 }]);
    await cycle.beat();
    await cycle.beat();
    expect(h.seen.resend.map((call) => call.input.lastResends)).toEqual([
      [],
      [
        { requestId: REQ_1, at: 2_005_100 },
        { requestId: REQ_2, at: 2_005_200 },
      ],
      [{ requestId: REQ_2, at: 2_005_200 }],
    ]);
  });

  test("unsentRenews: 결과에서 사라졌다고 빼지 않고, 장부에서 preparing·running을 떠난 것을 확인한 뒤에만 뺀다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    h.next.life = () =>
      lifeRan([
        { runId: RUN_A, outcome: "renew_recorded_not_sent", requestId: REQ_1, stopGeneration: 0, issuedAt: 2_000_000, leaseUntil: 2_030_000, executorId: W1, reason: "no_connection", delivery: "not_sent" },
        { runId: RUN_B, outcome: "renew_record_unknown", requestId: REQ_2, stopGeneration: 0, issuedAt: 2_000_000, executorId: W1, reason: "threw" },
      ]);
    await cycle.beat();
    h.next.life = () => lifeRan();
    h.state.runs = [
      { runId: RUN_A, state: "running" },
      { runId: RUN_B, state: "preparing" },
    ];
    // 결과 목록에 둘이 없어도(완결된 빈 결과) 장부가 여전히 preparing·running이면 남는다.
    await cycle.beat();
    await cycle.beat();
    h.state.runs = [
      { runId: RUN_A, state: "unknown_running" },
      { runId: RUN_B, state: "running" },
    ];
    await cycle.beat();
    h.state.runs = [{ runId: RUN_B, state: "finalized" }];
    await cycle.beat();
    expect(h.seen.life.map((call) => call.input.unsentRenews)).toEqual([[], [RUN_A, RUN_B], [RUN_A, RUN_B], [RUN_B], []]);
  });
});

describe("멈춘 박자와 던진 박자", () => {
  test("halted threw와 박자의 예외 모두 장부를 다시 읽고, 다음 박자는 정상으로 돈다", async () => {
    for (const [name, arrange] of [
      ["수명 halted", (h: ReturnType<typeof harness>) => (h.next.life = () => lifeRan([], "threw"))],
      [
        "수명 던짐",
        (h: ReturnType<typeof harness>) =>
          (h.next.life = () => {
            throw new Error("묶은 박자가 던짐");
          }),
      ],
      ["재전송 halted", (h: ReturnType<typeof harness>) => (h.next.resend = () => resendRan([], "threw"))],
      ["배정 halted", (h: ReturnType<typeof harness>) => (h.next.assign = () => assignRan([assigned(RUN_A)], "threw"))],
      [
        "끊김 ledger_failed(threw)",
        (h: ReturnType<typeof harness>) =>
          (h.next.linkLoss = () => linkLossRan([], { executors: [{ executorId: W1, outcome: "ledger_failed", absentSince: 1, reason: "threw" }] })),
      ],
    ] as const) {
      const h = harness();
      const cycle = createCycle(h.deps);
      arrange(h);
      const report = ran(await cycle.beat());
      expect([name, report.rereads.filter((item) => item.read === "runs").length]).toEqual([name, 1]);
      expect([name, h.calls.includes("read:runs")]).toEqual([name, true]);
      // 배정이 멈추면 assigned가 있어도 다시 부르지 않는다.
      expect([name, report.assign.length]).toEqual([name, 1]);
      h.next.linkLoss = () => linkLossRan();
      h.next.life = () => lifeRan();
      h.next.resend = () => resendRan();
      h.next.assign = () => assignRan();
      h.calls.length = 0;
      const after = ran(await cycle.beat());
      expect([name, h.calls]).toEqual([name, ["tick", "linkLoss", "life", "life:returned", "resend", "assign"]]);
      expect([name, after.rereads]).toEqual([name, []]);
    }
  });

  test("수명 박자가 던지면 그 박자의 남은 박자는 그대로 돈다", async () => {
    const h = harness();
    h.next.life = () => {
      throw new Error("묶은 박자가 던짐");
    };
    const report = ran(await createCycle(h.deps).beat());
    expect(report.life).toEqual({ kind: "threw" });
    expect(h.calls).toEqual(["tick", "linkLoss", "life", "read:runs", "resend", "assign"]);
  });

  test("*_record_unknown이면 그 지시의 장부 읽기를 부른다", async () => {
    const h = harness();
    h.state.renewIssuedAt = 2_000_000;
    h.state.unanswered = [{ requestId: REQ_2 }];
    h.next.life = () =>
      lifeRan([
        { runId: RUN_A, outcome: "renew_record_unknown", requestId: REQ_1, stopGeneration: 0, issuedAt: 2_000_000, executorId: W1, reason: "threw" },
        { runId: RUN_B, outcome: "stop_record_unknown", requestId: REQ_2, stopGeneration: 0, issuedAt: 2_000_000, executorId: W1, cancelReason: "requested", reason: "malformed_answer" },
        { runId: RUN_C, outcome: "stop_record_unknown", requestId: REQ_3, stopGeneration: 0, issuedAt: 2_000_000, executorId: W1, cancelReason: "deadline", reason: "threw" },
      ]);
    const report = ran(await createCycle(h.deps).beat());
    expect(h.seen.instructionTimes).toEqual([RUN_A]);
    expect(report.rereads).toEqual([
      { beat: "life", cause: "renew_record_unknown", read: "instruction_times", runId: RUN_A, requestId: REQ_1, found: true },
      { beat: "life", cause: "stop_record_unknown", read: "unanswered", runId: RUN_B, requestId: REQ_2, found: true },
      { beat: "life", cause: "stop_record_unknown", read: "unanswered", runId: RUN_C, requestId: REQ_3, found: false },
    ]);
  });
});

describe("시계", () => {
  test("박자 사이에 장부 시계가 뒤로 가면 그 박자의 재전송·배정을 부르지 않고, 박자에 넘긴 시계도 그 값을 내지 않는다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    h.state.wall = 2_000_000;
    await cycle.beat();
    expect(h.seen.assign).toEqual([2_000_000]);

    h.calls.length = 0;
    h.state.wall = 1_999_000;
    const report = ran(await cycle.beat());
    expect(report.clock).toBe("regressed");
    expect(h.calls).toEqual(["tick", "linkLoss", "life", "life:returned"]);
    expect([report.resend, ...report.assign]).toEqual([
      { kind: "skipped", reason: "clock_untrusted" },
      { kind: "skipped", reason: "clock_untrusted" },
    ]);
    const lifeClock = h.seen.life[1]?.clock as Clock;
    expect(() => lifeClock.now()).toThrow();

    // 하한 이상으로 돌아오면 다시 돈다. 같은 값(정각)은 후퇴가 아니다.
    h.calls.length = 0;
    h.state.wall = 2_000_000;
    expect(ran(await cycle.beat()).clock).toBe("ok");
    expect(h.calls).toContain("resend");
    expect(h.seen.assign).toEqual([2_000_000, 2_000_000]);
  });

  test("장부 시계를 읽지 못하면 재전송·배정을 부르지 않는다", async () => {
    const h = harness();
    h.deps = { ...h.deps, ledgerClock: { now: () => Number.NaN } } as CycleDeps;
    const report = ran(await createCycle(h.deps).beat());
    expect(report.clock).toBe("unavailable");
    expect(h.calls).not.toContain("resend");
    expect(h.calls).not.toContain("assign");
  });

  test("배정 박자의 now는 부르기 직전에 읽은 장부 시계이고, 박자 중에 뒤로 가면 배정을 부르지 않는다", async () => {
    const h = harness();
    h.next.resend = () => {
      h.state.wall = 2_000_500;
      return resendRan();
    };
    await createCycle(h.deps).beat();
    expect(h.seen.assign).toEqual([2_000_500]);

    const back = harness();
    back.next.resend = () => {
      back.state.wall = 1_000;
      return resendRan();
    };
    const report = ran(await createCycle(back.deps).beat());
    expect(report.assign).toEqual([{ kind: "skipped", reason: "clock_untrusted" }]);
    expect(back.seen.assign).toEqual([]);
  });
});

describe("단조 시계", () => {
  test("끊김 박자의 monotonic은 단조 시계이고 clock은 장부 시계다", async () => {
    const h = harness();
    h.state.wall = 2_000_000;
    h.state.mono = 777;
    await createCycle(h.deps).beat();
    const clocks = h.seen.linkLoss[0]?.clocks;
    expect(clocks?.monotonic.now()).toBe(777);
    expect(clocks?.clock.now()).toBe(2_000_000);
  });

  test("단조 시계가 이 프로세스에서 읽은 값보다 뒤로 가면 끊김 박자에는 읽지 못한 시계로 보인다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    h.state.mono = 900;
    h.next.linkLoss = () => {
      h.seen.linkLoss.at(-1)?.clocks.monotonic.now();
      return linkLossRan();
    };
    await cycle.beat();
    h.state.mono = 800;
    let threw = false;
    h.next.linkLoss = () => {
      try {
        h.seen.linkLoss.at(-1)?.clocks.monotonic.now();
      } catch {
        threw = true;
      }
      return linkLossRan();
    };
    await cycle.beat();
    expect(threw).toBe(true);
  });
});

describe("정책 검사", () => {
  test("resendEveryMs > 19000, judgeMs < RUN_LEASE_MAX_MS, 배정 횟수 범위 밖이면 순서기를 만들지 않는다", () => {
    expect(START_LAST_SEAL_MS).toBe(19_000);
    const cases: [Partial<CycleDeps["policy"]>, string | null][] = [
      [{ resendEveryMs: 19_000 }, null],
      [{ resendEveryMs: 19_001 }, "resendEveryMs"],
      [{ resendEveryMs: 0 }, "resendEveryMs"],
      [{ resendEveryMs: 1.5 }, "resendEveryMs"],
      [{ judgeMs: 30_000 }, null],
      [{ judgeMs: 29_999 }, "judgeMs"],
      [{ judgeMs: Number.NaN }, "judgeMs"],
      [{ assignCallsPerBeat: 1 }, null],
      [{ assignCallsPerBeat: ASSIGN_CALLS_MAX }, null],
      [{ assignCallsPerBeat: 0 }, "assignCallsPerBeat"],
      [{ assignCallsPerBeat: ASSIGN_CALLS_MAX + 1 }, "assignCallsPerBeat"],
    ];
    for (const [policy, field] of cases) {
      const h = harness(policy);
      let caught: unknown = null;
      try {
        createCycle(h.deps);
      } catch (error) {
        caught = error;
      }
      expect([policy, caught instanceof CyclePolicyError ? caught.field : caught]).toEqual([policy, field]);
    }
  });

  test("검사한 정책을 박자에 넘기고, 만든 뒤 정책 객체를 바꿔도 따르지 않는다", async () => {
    const h = harness({ judgeMs: 45_000, resendEveryMs: 7_000 });
    const policy = { ...h.deps.policy };
    const cycle = createCycle({ ...h.deps, policy });
    (policy as { resendEveryMs: number }).resendEveryMs = 60_000;
    (policy as { judgeMs: number }).judgeMs = 1;
    await cycle.beat();
    expect(h.seen.linkLoss[0]?.policy).toEqual({ judgeMs: 45_000 });
    expect(h.seen.resend[0]?.policy).toEqual({ resendEveryMs: 7_000 });
  });
});

describe("발급 닫기", () => {
  test("closeIssuance()는 깃발을 곧 세우고, 진행 중 박자의 남은 박자를 막고, 그 박자가 돌아온 뒤에 돌아온다", async () => {
    const h = harness();
    const gate = deferred<LifeTickResult>();
    h.next.life = () => gate.promise;
    const cycle = createCycle(h.deps);
    const beat = cycle.beat();
    await Promise.resolve();
    expect(cycle.issuanceOpen()).toBe(true);
    let closed = false;
    const closing = cycle.closeIssuance().then(() => {
      closed = true;
    });
    expect(cycle.issuanceOpen()).toBe(false);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(closed).toBe(false);
    gate.resolve(lifeRan());
    const report = ran(await beat);
    await closing;
    expect(closed).toBe(true);
    expect([report.resend, ...report.assign]).toEqual([
      { kind: "skipped", reason: "issuance_closed" },
      { kind: "skipped", reason: "issuance_closed" },
    ]);
    expect(h.calls).toEqual(["tick", "linkLoss", "life", "life:returned"]);

    // 그 뒤의 박자는 서버 tick도 부르지 않는다.
    h.calls.length = 0;
    expect(await cycle.beat()).toEqual({ kind: "skipped", reason: "issuance_closed" });
    expect(h.calls).toEqual([]);
  });

  test("진행 중 박자가 없으면 곧 돌아오고, 배정 되풀이도 깃발에서 멈춘다", async () => {
    const h = harness({ assignCallsPerBeat: 3 });
    const cycle = createCycle(h.deps);
    await cycle.closeIssuance();
    expect(cycle.issuanceOpen()).toBe(false);

    const again = harness({ assignCallsPerBeat: 3 });
    const repeat = createCycle(again.deps);
    let closing: Promise<void> | null = null;
    again.next.assign = () => {
      closing ??= repeat.closeIssuance();
      return assignRan([assigned(RUN_A)]);
    };
    const report = ran(await repeat.beat());
    await closing;
    expect(report.assign).toEqual([{ kind: "returned", result: assignRan([assigned(RUN_A)]) }, { kind: "skipped", reason: "issuance_closed" }]);
  });
});

describe("정적", () => {
  const SOURCE = "src/supervisor/runtime/cycle.ts";
  const code = async () =>
    (await readText(SOURCE))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

  test("cycle.ts에는 틀 쓰기·시작 봉투·환경 읽기·시계·난수·타이머의 직접 호출이 없다", async () => {
    const source = await code();
    for (const banned of [
      /(?<![\w$])writeFrame\s*\(/,
      /\bstartDraft\b/,
      /task_start/,
      /process\.env/,
      /\bprocess\b/,
      /\bDate\b/,
      /\bperformance\b/,
      /\bMath\.random\b/,
      /\bsetTimeout\b/,
      /\bsetInterval\b/,
      /\bsetImmediate\b/,
      /\bqueueMicrotask\b/,
      /\bBun\b/,
      /["']node:/,
      /["']bun:/,
    ]) {
      expect([String(banned), banned.test(source)]).toEqual([String(banned), false]);
    }
  });

  test("실제 박자 함수에 포트를 묶으면 CycleBeats의 꼴에 맞는다(형 검사)", () => {
    // 부르지 않는다. tsc가 이 묶음의 꼴을 확인한다.
    const bind = (ports: {
      linkLoss: Omit<LinkLossPorts, "clock" | "monotonic">;
      life: Omit<LifeLoopPorts, "clock">;
      lifePolicy: LifecyclePolicy;
      resend: Omit<ResendPorts, "clock">;
      assign: AssignLoopPorts;
      assignPolicy: AssignLoopPolicy;
    }): CycleBeats => ({
      linkLoss: (clocks, policy, input) => linkLossTick({ ...ports.linkLoss, ...clocks }, policy, input),
      life: (clock, input) => lifeTick({ ...ports.life, clock }, ports.lifePolicy, input),
      resend: (clock, policy, input) => resendTick({ ...ports.resend, clock }, policy, input),
      assign: (now) => assignAndStartTick(ports.assign, ports.assignPolicy, now),
    });
    expect(typeof bind).toBe("function");
  });
});
