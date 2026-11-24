// 박자 순서기(src/supervisor/runtime/cycle.ts)와 공유 시계(shared-clock.ts). 박자 넷·서버 tick·장부 읽기·시계는 가짜이고, 부른 차례와
// 넘긴 인자를 기록한다. "실제 박자 넷과 장부"만 실제 박자 함수·임시 폴더의 실제 장부·실제 내보내기 포트를 쓴다(서버는 가짜).
// 박자가 기다리는 동안의 일은 시험이 직접 쥔 약속(deferred)으로 차례를 정한다. 실제 시간을 기다리지 않는다.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { sealEnvelope } from "../../../src/contract/v1/index.ts";
import { RESTORE_KEY } from "../../../src/ledger/ledger.ts";
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
import { createSharedClock } from "../../../src/supervisor/runtime/shared-clock.ts";
import { createWireSink, type WireServer } from "../../../src/supervisor/runtime/sink.ts";
import type { LifecyclePolicy } from "../../../src/supervisor/scheduler/lifecycle.ts";
import { readText } from "../../files.ts";
import { id, must, NOW, open, tempPath, worker } from "../../ledger/helpers.ts";

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
    // 다음 장부 시계 읽기 한 번에서 부를 일(포트 안에서 상태를 바꾸는 사례).
    onClock: null as (() => void) | null,
    // 장부 읽기의 답을 바꿔 끼운다.
    runsAnswer: null as (() => unknown) | null,
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
      if (state.runsAnswer !== null) return state.runsAnswer();
      return { known: true, value: state.runs.map((run) => ({ ...run })) };
    },
    listWaitingToolRequests() {
      calls.push("read:waiting");
      return { known: true, value: [] };
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
    ledgerClock: createSharedClock({
      now: () => {
        const hook = state.onClock;
        state.onClock = null;
        hook?.();
        return state.wall;
      },
    }),
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
    h.deps = { ...h.deps, ledgerClock: createSharedClock({ now: () => Number.NaN }) };
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

const skippedAll = (reason: "restore_not_done" | "issuance_closed" | "clock_untrusted", count: number) =>
  Array.from({ length: count }, () => ({ kind: "skipped" as const, reason }));
const renewNotSent = (runId: string) => ({
  runId,
  outcome: "renew_recorded_not_sent",
  requestId: REQ_1,
  stopGeneration: 0,
  issuedAt: 2_000_000,
  leaseUntil: 2_030_000,
  executorId: W1,
  reason: "no_connection",
  delivery: "not_sent",
});

describe("포트 안에서 바뀐 상태", () => {
  test("박자 안의 첫 포트(수명 박자의 동기 구간)에서 부른 closeIssuance()도 그 박자가 돌아온 뒤에 끝난다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    const order: string[] = [];
    const gate = deferred<LifeTickResult>();
    let closing: Promise<unknown> | null = null;
    h.next.life = () => {
      order.push("life:enter");
      closing = cycle.closeIssuance().then(() => order.push("close:done"));
      return gate.promise;
    };
    const beat = cycle.beat().then((report) => {
      order.push("beat:returned");
      return report;
    });
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(order).toEqual(["life:enter"]);
    order.push("life:release");
    gate.resolve(lifeRan());
    const report = ran(await beat);
    await closing;
    expect(order).toEqual(["life:enter", "life:release", "beat:returned", "close:done"]);
    expect([report.resend, ...report.assign]).toEqual(skippedAll("issuance_closed", 2));
  });

  test("복원 조회 안에서 닫기를 부르고 true를 돌려주면 끊김 박자를 부르지 않는다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    let closing: Promise<void> | null = null;
    h.state.restoreDone = () => {
      closing ??= cycle.closeIssuance();
      return true;
    };
    const report = ran(await cycle.beat());
    await closing;
    expect(h.calls).toEqual(["tick"]);
    expect([report.linkLoss, report.life, report.resend, ...report.assign]).toEqual(skippedAll("issuance_closed", 4));
  });

  test("수명 직전의 장부 읽기가 복원을 다시 시작하고 known:false를 돌려주면 수명 박자를 부르지 않는다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    h.next.life = () => lifeRan([renewNotSent(RUN_A)]);
    await cycle.beat();
    h.calls.length = 0;
    h.state.runsAnswer = () => {
      h.state.restoreDone = false;
      return { known: false };
    };
    const report = ran(await cycle.beat());
    expect(h.calls).toEqual(["tick", "linkLoss", "read:runs"]);
    expect([report.life, report.resend, ...report.assign]).toEqual(skippedAll("restore_not_done", 3));
  });

  test("배정 직전의 시계 읽기 안에서 닫기를 부르면 배정 박자를 부르지 않는다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    let closing: Promise<void> | null = null;
    h.next.resend = () => {
      h.state.onClock = () => {
        closing = cycle.closeIssuance();
      };
      return resendRan();
    };
    const report = ran(await cycle.beat());
    await closing;
    expect(h.calls).toEqual(["tick", "linkLoss", "life", "life:returned", "resend"]);
    expect(report.assign).toEqual(skippedAll("issuance_closed", 1));
  });
});

// 실제 박자 넷·임시 폴더의 실제 장부·실제 내보내기 포트(createWireSink). 서버는 실제 서버의 차례(lastCheck → finalCheck → 쓰기)를
// 따르는 가짜다. 원천 시계를 공유 시계로 감싸 장부·내보내기 포트·순서기에 같은 객체를 넘긴다(진입점이 할 조립).
function realWorld() {
  const source = { wall: NOW, onRead: null as (() => void) | null };
  const shared = createSharedClock({
    now: () => {
      const hook = source.onRead;
      source.onRead = null;
      hook?.();
      return source.wall;
    },
  });
  const ledger = open(tempPath(), { clock: () => shared.now() });
  must(ledger.applyStop({ generation: 0, stopped: false, now: NOW }));
  const attempt = ledger.beginRestore(RESTORE_KEY);
  ledger.pinRestore(RESTORE_KEY, attempt);
  expect(ledger.grantIntake(RESTORE_KEY, attempt)).toBe(true);
  const intake = { stopGeneration: () => ledger.syncStopGeneration(attempt), intakeOpen: () => ledger.intakeOpen(attempt) };
  const inputId = id();
  must(ledger.enqueueInput({ requestId: inputId, source: "fixture", sourceRef: { ref: `inbox/${id()}`, expiresAt: NOW + 600_000 }, receivedAt: NOW }));
  const runId = must(ledger.admitRun(worker({ inputRequestId: inputId }))).run.runId;
  const executorId = worker().executorId as string;

  // 다음 시작 지시의 finalCheck 직전에 원천 시계를 옮길 값.
  const world = { lateStartAt: null as number | null, sending: null as { action: string; requestId: string } | null };
  const sent: { action: string; requestId: string }[] = [];
  const written: { action: string; requestId: string }[] = [];
  const server: WireServer = {
    recognized: (principal) => (principal === executorId ? 1 : null),
    writeFrame(connection, principal, _frame, options) {
      if (connection !== 1 || principal !== executorId) return { kind: "not_written", reason: "not_recognized" };
      const verdict = options.lastCheck();
      if (verdict !== null) return { kind: "not_written", reason: "refused", refusal: verdict };
      if (world.lateStartAt !== null && world.sending?.action === "task_start") {
        source.wall = world.lateStartAt;
        world.lateStartAt = null;
      }
      const timing = options.finalCheck === undefined ? null : options.finalCheck();
      if (timing !== null) return { kind: "not_written", reason: "refused", refusal: timing };
      if (world.sending !== null) written.push(world.sending);
      options.settled("flushed");
      return { kind: "written" };
    },
  };
  const wire = createWireSink({
    server,
    restorer: () => intake,
    withheld: { executors: () => ({ known: true, value: [] }) },
    clock: shared,
    queries: { add() {}, remove() {} },
  });
  const { privateKey } = generateKeyPairSync("ed25519");
  const base = {
    ledger,
    intake,
    links: wire.links,
    random: { bytes: (length: number) => getRandomValues(new Uint8Array(length)) },
    signer: { seal: (draft: Parameters<typeof sealEnvelope>[0]) => sealEnvelope(draft, privateKey) },
    sink: {
      send(envelope: Parameters<typeof wire.sink.send>[0]) {
        world.sending = { action: envelope.header.action, requestId: envelope.header.request_id };
        sent.push(world.sending);
        return wire.sink.send(envelope);
      },
    },
  };
  const hooks = { afterResend: null as (() => void) | null };
  const assignPorts = {
    ...base,
    connections: { candidates: () => ({ known: true, value: [] }) },
    withheld: { executors: () => ({ known: true, value: [] }) },
    facts: { facts: () => ({}) },
    credentials: { reference: async () => ({ known: false }) },
  } as unknown as AssignLoopPorts;
  const assignPolicy = {
    assignment: { allowed: [], registrations: [], expected: { profile_revision: "profile-1", policy_revision: "policy-1" } },
    accounts: [],
    plans: [],
    queue: { alertMaxWaitMs: 60_000, requestBudget: { admin: 1_000_000, alert: 1_000_000 } },
    originOf: () => "admin",
  } as unknown as AssignLoopPolicy;
  const beats: CycleBeats = {
    linkLoss: (clocks, policy, input) => linkLossTick({ ledger, restorer: intake, connections: { occupancy: () => [] }, ...clocks }, policy, input),
    life: (clock, input) => lifeTick({ ...base, clock }, { renewEveryMs: 10_000, answerTimeoutMs: 20_000 }, input),
    resend: async (clock, policy, input) => {
      const result = await resendTick({ ...base, clock }, policy, input);
      const hook = hooks.afterResend;
      hooks.afterResend = null;
      hook?.();
      return result;
    },
    assign: (now) => assignAndStartTick(assignPorts, assignPolicy, now),
  };
  const cycle = createCycle({
    beats,
    serverTick: () => {},
    ledgerClock: shared,
    monotonic: { now: () => 10 },
    restoreDone: () => true,
    ledger,
    policy: { judgeMs: 30_000, resendEveryMs: 5_000, assignCallsPerBeat: 1 },
  });
  return { source, shared, ledger, runId, cycle, hooks, world, sent, written };
}

describe("실제 박자 넷과 장부", () => {
  test("배정 직전 시계 읽기 안에서 닫기를 부르면 배정을 부르지 않고 장부에 새 시작 기록이 없다", async () => {
    const w = realWorld();
    let closing: Promise<void> | null = null;
    w.hooks.afterResend = () => {
      w.source.onRead = () => {
        closing = w.cycle.closeIssuance();
      };
    };
    const report = ran(await w.cycle.beat());
    await closing;
    expect(report.assign).toEqual(skippedAll("issuance_closed", 1));
    const runs = w.ledger.listRuns();
    expect(runs.known ? runs.value.map((run) => [run.runId, run.state]) : runs).toEqual([[w.runId, "queued"]]);
    const unanswered = w.ledger.unansweredInstructions();
    expect(unanswered.known ? unanswered.value.instructions : unanswered).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  test("송신 직전 확인이 +19,001ms로 거절한 시작은 다음 박자의 원천 시계가 +19,000ms여도 같은 요청 ID로 다시 쓰이지 않는다", async () => {
    const w = realWorld();
    w.world.lateStartAt = NOW + 19_001;
    const first = ran(await w.cycle.beat());
    const step = first.assign[0];
    expect(step?.kind === "returned" && step.result.kind === "ran" ? step.result.starts.map((start) => [start.outcome, "reason" in start ? start.reason : null]) : step).toEqual([
      ["recorded_not_sent", "too_late_to_send"],
    ]);
    const startIds = w.sent.filter((item) => item.action === "task_start").map((item) => item.requestId);
    expect([startIds.length, w.written]).toEqual([1, []]);

    // 원천 시계가 송신 확인이 읽은 값보다 1ms 이르다. 하한은 그 읽기까지 들어 있어 후퇴로 보이고 재전송·배정을 부르지 않는다.
    w.source.wall = NOW + 19_000;
    const second = ran(await w.cycle.beat());
    expect([w.sent.filter((item) => item.action === "task_start").map((item) => item.requestId), w.written]).toEqual([startIds, []]);
    expect(second.clock).toBe("regressed");
    expect([second.resend, ...second.assign]).toEqual(skippedAll("clock_untrusted", 2));
    // 장부·내보내기 포트가 읽는 값도 하한 아래로 내려가지 않는다.
    expect(w.shared.now()).toBe(NOW + 19_001);

    // 원천이 하한을 넘은 뒤에도 같은 시작은 다시 쓰이지 않는다(송신 시한이 지났다).
    w.source.wall = NOW + 19_002;
    expect(ran(await w.cycle.beat()).clock).toBe("ok");
    expect(w.sent.filter((item) => item.action === "task_start").map((item) => item.requestId)).toEqual(startIds);
    expect(w.written.filter((item) => item.action === "task_start")).toEqual([]);
  });
});

describe("공유 시계", () => {
  test("원천이 하한보다 이르면 now()는 하한을 내고 read()는 regressed다. 무효 값은 하한을 바꾸지 않고 now()가 그대로 내며, 원천이 던지면 now()도 던진다", () => {
    let wall = 1_000;
    const shared = createSharedClock({ now: () => wall });
    expect([shared.now(), shared.read()]).toEqual([1_000, { state: "ok", at: 1_000 }]);
    wall = 2_000;
    expect(shared.now()).toBe(2_000);
    wall = 1_999;
    expect([shared.now(), shared.read()]).toEqual([2_000, { state: "regressed" }]);
    wall = 2_000;
    expect(shared.read()).toEqual({ state: "ok", at: 2_000 });
    for (const bad of [Number.NaN, 0, -1, 1.5]) {
      wall = bad;
      expect([bad, shared.read()]).toEqual([bad, { state: "unavailable" }]);
      expect(shared.now()).toBe(bad);
    }
    wall = 1_999;
    expect([shared.now(), shared.read()]).toEqual([2_000, { state: "regressed" }]);
    const throwing = createSharedClock({
      now: () => {
        throw new Error("시계 없음");
      },
    });
    expect(throwing.read()).toEqual({ state: "unavailable" });
    expect(() => throwing.now()).toThrow(RangeError);
  });

  test("순서기는 createSharedClock이 만든 시계만 받는다", () => {
    const h = harness();
    expect(() => createCycle({ ...h.deps, ledgerClock: { now: () => 1, read: () => ({ state: "ok", at: 1 }) } })).toThrow(TypeError);
  });
});

describe("멈춘 배정과 꼴이 틀린 답", () => {
  test("배정이 멈추거나 던지면 대기 부탁과 실행 목록을 모두 다시 읽고 각 읽기의 성공 여부를 남긴다", async () => {
    for (const [cause, arrange] of [
      ["halted", (h: ReturnType<typeof harness>) => (h.next.assign = () => assignRan([], "threw"))],
      [
        "threw",
        (h: ReturnType<typeof harness>) =>
          (h.next.assign = () => {
            throw new Error("묶은 박자가 던짐");
          }),
      ],
    ] as const) {
      const h = harness();
      arrange(h);
      const report = ran(await createCycle(h.deps).beat());
      expect([cause, report.rereads]).toEqual([
        cause,
        [
          { beat: "assign", cause, read: "waiting_requests", known: true },
          { beat: "assign", cause, read: "runs", known: true },
        ],
      ]);
      expect([cause, h.calls.slice(-2)]).toEqual([cause, ["read:waiting", "read:runs"]]);
    }

    const failed = harness();
    (failed.ledger as unknown as { listWaitingToolRequests: () => unknown }).listWaitingToolRequests = () => {
      throw new Error("읽지 못함");
    };
    failed.next.assign = () => assignRan([], "threw");
    expect(ran(await createCycle(failed.deps).beat()).rereads).toEqual([
      { beat: "assign", cause: "halted", read: "waiting_requests", known: false },
      { beat: "assign", cause: "halted", read: "runs", known: true },
    ]);
  });

  test("unsentRenews: 장부 행의 state가 없거나 유효한 상태 값이 아니면 빼지 않는다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    h.next.life = () => lifeRan([renewNotSent(RUN_A)]);
    await cycle.beat();
    h.next.life = () => lifeRan();
    for (const row of [{ runId: RUN_A }, { runId: RUN_A, state: "gone" }, { runId: RUN_A, state: null }, { runId: RUN_A, state: ["finalized"] }]) {
      h.state.runsAnswer = () => ({ known: true, value: [row] });
      await cycle.beat();
      expect([row, h.seen.life.at(-1)?.input.unsentRenews]).toEqual([row, [RUN_A]]);
    }
    h.state.runsAnswer = () => ({ known: true, value: [{ runId: RUN_A, state: "finalized" }] });
    await cycle.beat();
    expect(h.seen.life.at(-1)?.input.unsentRenews).toEqual([]);
  });

  test("watch: 박자가 돌려준 배열이나 넘겨받은 원소를 나중에 고쳐도 기억은 바뀌지 않는다", async () => {
    const h = harness();
    const cycle = createCycle(h.deps);
    const returned: WatchEntry[] = [{ executorId: W1, absentSince: 5 }];
    h.next.linkLoss = () => linkLossRan(returned);
    await cycle.beat();
    returned.length = 0;
    h.next.linkLoss = () => {
      const input = h.seen.linkLoss.at(-1)?.input.watch as unknown as { absentSince: number | null }[];
      for (const item of input) item.absentSince = 99;
      return { kind: "not_run", reason: "clock_unavailable" };
    };
    await cycle.beat();
    h.next.linkLoss = () => linkLossRan();
    await cycle.beat();
    expect(h.seen.linkLoss.at(-1)?.input.watch).toEqual([{ executorId: W1, absentSince: 5 }]);
  });
});

describe("박자 함수와 완료 신호", () => {
  test("박자 함수는 만들 때 한 번 꺼내 쥐고, 박자마다 마지막 확인 뒤에 외부 객체에서 다시 읽지 않는다(수신자는 그 객체)", async () => {
    const h = harness();
    const trace: string[] = [];
    const methods: Record<string, unknown> = { target: h.deps.beats };
    for (const name of ["linkLoss", "life", "resend", "assign"] as const) {
      Object.defineProperty(methods, name, {
        get() {
          trace.push(`get.${name}`);
          return function (this: { target: CycleBeats }, ...args: unknown[]) {
            trace.push(`enter.${name}`);
            return (this.target[name] as (...input: unknown[]) => unknown)(...args);
          };
        },
      });
    }
    const restoreDone = () => {
      trace.push("gate");
      return true;
    };
    const cycle = createCycle({ ...h.deps, beats: methods as unknown as CycleBeats, restoreDone });
    expect(trace.splice(0)).toEqual(["get.linkLoss", "get.life", "get.resend", "get.assign"]);
    for (let pass = 0; pass < 2; pass += 1) {
      const report = ran(await cycle.beat());
      expect(trace.splice(0)).toEqual(["gate", "enter.linkLoss", "gate", "enter.life", "gate", "enter.resend", "gate", "enter.assign"]);
      expect([report.linkLoss.kind, report.life.kind, report.resend.kind, report.assign.map((step) => step.kind)]).toEqual(["returned", "returned", "returned", ["returned"]]);
    }
  });

  test("박자의 인자는 마지막 확인 전에 만든다: 끊김 박자가 배열 하위 타입을 돌려줘도 확인 뒤 곧바로 박자 함수에 들어간다", async () => {
    const h = harness();
    // 생성자(species)가 불리면 그 차례를 남기는 배열. 원소는 올바르다.
    class Logged<T> extends Array<T> {
      constructor(...items: T[]) {
        super(...items);
        h.calls.push("array.constructor");
      }
    }
    const returned = new Logged<WatchEntry>();
    returned.push({ executorId: W1, absentSince: null });
    h.calls.length = 0;
    h.state.restoreDone = () => {
      h.calls.push("gate");
      return true;
    };
    const cycle = createCycle(h.deps);
    h.next.linkLoss = () => linkLossRan(returned);
    await cycle.beat();
    h.next.linkLoss = () => linkLossRan();
    h.calls.length = 0;
    await cycle.beat();
    expect(h.calls).toEqual(["tick", "gate", "linkLoss", "gate", "life", "life:returned", "gate", "resend", "gate", "assign"]);
    const input = h.seen.linkLoss.at(-1)?.input.watch;
    expect([Object.getPrototypeOf(input), input]).toEqual([Array.prototype, [{ executorId: W1, absentSince: null }]]);
  });

  test("박자 함수의 name·length를 읽을 수 없어도 순서기를 만들고 박자를 부른다(함수 메타데이터를 읽지 않는다)", async () => {
    for (const field of ["name", "length"]) {
      const h = harness();
      const audit: string[] = [];
      const linkLoss = function (this: unknown, ...args: unknown[]) {
        audit.push(this === methods ? "enter.receiver" : "enter.other");
        return (h.deps.beats.linkLoss as (...input: unknown[]) => LinkLossTickResult)(...args);
      };
      Object.defineProperty(linkLoss, field, {
        get() {
          audit.push(`read.${field}`);
          throw new Error("메타데이터 없음");
        },
      });
      const methods = { ...h.deps.beats, linkLoss };
      const report = ran(await createCycle({ ...h.deps, beats: methods as unknown as CycleBeats }).beat());
      expect([field, audit, report.linkLoss.kind, report.life.kind, h.calls.filter((call) => call === "linkLoss").length]).toEqual([field, ["enter.receiver"], "returned", "returned", 1]);
    }
  });

  test("끊김 함수를 얻지 못하면 순서기를 만들지 않아 수명 박자도 돌지 않고, 얻은 끊김 함수가 던지면 수명 박자는 돈다", async () => {
    const h = harness();
    const unavailable = {
      ...h.deps.beats,
      get linkLoss(): never {
        throw new Error("어댑터 없음");
      },
    };
    expect(() => createCycle({ ...h.deps, beats: unavailable as unknown as CycleBeats })).toThrow("어댑터 없음");
    expect(() => createCycle({ ...h.deps, beats: { ...h.deps.beats, linkLoss: undefined } as unknown as CycleBeats })).toThrow(TypeError);
    expect(h.calls).toEqual([]);

    h.next.linkLoss = () => {
      throw new Error("끊김 실패");
    };
    const report = ran(await createCycle(h.deps).beat());
    expect([report.linkLoss.kind, report.life.kind, h.calls.filter((call) => call === "life").length]).toEqual(["threw", "returned", 1]);
  });

  test("호출자가 잡은 박자의 거부는 미처리 거부로 다시 나오지 않고, 그 박자 안에서 부른 닫기는 박자가 돌아온 뒤에 정상으로 끝난다", async () => {
    const unhandled: unknown[] = [];
    const listen = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listen);
    try {
      const broken = () =>
        ({
          ...linkLossRan(),
          get executors(): never {
            throw new Error("결과 칸 없음");
          },
        }) as LinkLossTickResult;
      const h = harness();
      h.next.linkLoss = broken;
      const caught = await createCycle(h.deps)
        .beat()
        .then(
          () => "fulfilled",
          (error: Error) => error.message,
        );

      const trace: string[] = [];
      const other = harness();
      const cycle = createCycle(other.deps);
      let closing: Promise<unknown> | null = null;
      other.next.linkLoss = () => {
        closing = cycle.closeIssuance().then(() => trace.push("close.done"));
        return broken();
      };
      await cycle.beat().then(
        () => trace.push("beat.fulfilled"),
        () => trace.push("beat.rejected"),
      );
      await closing;
      await new Promise((resolve) => setImmediate(resolve));
      expect([caught, trace, unhandled]).toEqual(["결과 칸 없음", ["beat.rejected", "close.done"], []]);
    } finally {
      process.off("unhandledRejection", listen);
    }
  });

  test("ledgerClock은 만들 때 한 번만 읽고 검사한 그 값을 쓴다", async () => {
    const h = harness();
    const checked = h.deps.ledgerClock;
    const lookalike = { now: () => 1, read: () => ({ state: "ok", at: 1 }) };
    let reads = 0;
    const deps = {
      ...h.deps,
      get ledgerClock() {
        reads += 1;
        return reads === 1 ? checked : lookalike;
      },
    } as unknown as CycleDeps;
    const cycle = createCycle(deps);
    await cycle.beat();
    expect([reads, h.seen.assign]).toEqual([1, [h.state.wall]]);
  });

  test("장부 조회 중 원천이 무효 값을 한 번 내도 장부는 계속 쓸 수 있다(공유 시계는 무효 값을 장부의 무효 시각 처리로 넘긴다)", () => {
    let wall: number = NOW;
    const shared = createSharedClock({ now: () => wall });
    const ledger = open(tempPath(), { clock: () => shared.now() });
    wall = Number.NaN;
    const read = ledger.queueView();
    const during = ledger.health();
    wall = NOW + 1;
    expect([read.known, during, ledger.health(), shared.now()]).toEqual([true, { writable: true }, { writable: true }, NOW + 1]);
  });
});

describe("정적", () => {
  const SOURCES = ["src/supervisor/runtime/cycle.ts", "src/supervisor/runtime/shared-clock.ts"];
  const code = async (path: string) =>
    (await readText(path))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

  test("cycle.ts·shared-clock.ts에는 틀 쓰기·시작 봉투·환경 읽기·시계·난수·타이머의 직접 호출이 없다", async () => {
    for (const path of SOURCES) {
      const source = await code(path);
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
        expect([path, String(banned), banned.test(source)]).toEqual([path, String(banned), false]);
      }
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
