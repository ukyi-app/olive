// 감독의 박자 순서기. 한 박자에 연결 서버의 tick과 박자 넷(끊김 → 수명 → 재전송 → 배정·시작)을 정해진 차례로 한 번씩 부르고,
// 박자 사이의 기억(watch, lastQueries, lastResends, unsentRenews)을 쥐었다가 다음 박자에 넘긴다. 박자의 결과를 바꾸거나 다시 해석하지
// 않는다: 결과의 정해진 칸을 기억으로 옮기고, 멈췄거나 적혔는지 모르는 결과 뒤에 장부를 다시 읽는 것만 한다.
// 박자 함수·서버 tick·장부 읽기·시계 둘·복원 끝 여부는 포트로 받는다. 시계·난수·타이머를 직접 부르지 않고 박자의 주기는 부르는 쪽이 정한다.
// 기억은 이 객체의 메모리에만 있다. 감독이 다시 뜨면 새 객체가 빈 기억으로 시작한다(저장하지 않는다).
//
// 지키는 것:
// 1. 박자를 겹쳐 부르지 않는다. 박자가 진행 중이면 beat()는 기다리지 않고 거절한다(박자 안의 포트에서 다시 부른 것도 같다).
// 2. 복원이 끝나기 전에는 서버 tick만 부르고 박자 넷은 부르지 않는다. 박자를 부르기 직전마다 다시 보고, 한 번 막히면 그 박자의
//    남은 박자도 부르지 않는다(끊김 박자 없이 수명 박자만 도는 박자를 만들지 않는다).
// 3. 장부 시계가 이 프로세스에서 읽은 가장 늦은 값보다 이르면 박자에는 읽지 못한 시계로 보인다. 박자 처음의 읽기가 그러면 그 박자의
//    재전송·배정을 부르지 않는다. 끊김 박자의 단조 시계도 같은 하한을 둔다.
// 4. closeIssuance() 뒤에는 새 박자를 시작하지 않고, 진행 중인 박자는 남은 박자를 부르지 않고 돌아온다. closeIssuance()는 그 박자가
//    돌아온 뒤에 돌아온다.
import { limits, parsePrincipal } from "../../contract/v1/index.ts";
import type { Ledger } from "../../ledger/index.ts";
import type { TickResult as AssignTickResult } from "../dispatch/assign-loop.ts";
import type { LifeTickInput, LifeTickResult } from "../dispatch/life-loop.ts";
import type { LinkLossPolicy, LinkLossTickInput, LinkLossTickResult, MonotonicClock, WatchEntry } from "../dispatch/link-loss.ts";
import type { Clock } from "../dispatch/ports.ts";
import { type ResendPolicy, type ResendTickInput, type ResendTickResult, START_LAST_SEAL_MS } from "../dispatch/resend.ts";

// 박자 넷. 조립은 실제 박자 함수에 그 포트·정책을 묶어 넘긴다(예: linkLoss = (c, p, i) => linkLossTick({ ...포트, ...c }, p, i)).
// 시계와 끊김·재전송의 정책은 이 순서기가 넘기는 것을 그대로 포트에 넣어야 한다: 시계 하한과 정책 검사가 그 값에 걸려 있다.
export interface CycleBeats {
  linkLoss(clocks: { readonly clock: Clock; readonly monotonic: MonotonicClock }, policy: LinkLossPolicy, input: LinkLossTickInput): LinkLossTickResult;
  life(clock: Clock, input: LifeTickInput): Promise<LifeTickResult>;
  resend(clock: Clock, policy: ResendPolicy, input: ResendTickInput): Promise<ResendTickResult>;
  assign(now: number): Promise<AssignTickResult>;
}

// 멈춘 박자 뒤와 싣지 못한 갱신을 뺄지 정할 때 읽는 장부. 박자들이 쓰는 그 장부 객체여야 한다.
export type CycleLedger = Pick<Ledger, "listRuns" | "instructionTimes" | "unansweredInstructions">;

export interface CyclePolicy {
  // 끊김 판정 시간. RUN_LEASE_MAX_MS 이상이어야 한다(판정할 때 실행기는 갱신 없이 임대가 끝나 이미 닫혀 있다).
  readonly judgeMs: number;
  // 재전송 간격. START_LAST_SEAL_MS(19000) 이하여야 시작을 한 번이라도 다시 낸다.
  readonly resendEveryMs: number;
  // 한 박자에서 배정 박자를 부르는 최대 횟수(처음 포함, 1 이상 ASSIGN_CALLS_MAX 이하). 결과에 assigned가 있으면 같은 박자에서 다시 부른다.
  readonly assignCallsPerBeat: number;
}

// 배정을 되풀이하는 동안 수명 박자는 돌지 않는다. 박자 하나가 갱신 구간(기본 7000ms)을 다 쓰지 않게 묶는 상한이다.
export const ASSIGN_CALLS_MAX = 8;

export interface CycleDeps {
  readonly beats: CycleBeats;
  // 연결 서버의 tick(). 서버에는 타이머가 없어 이것이 hello 대기·복원기 교체·답 기한의 시간 판단을 일으킨다.
  readonly serverTick: () => void;
  // 장부에 주입한 그 시계. 박자에는 하한을 씌운 것을 넘긴다.
  readonly ledgerClock: Clock;
  // 끊긴 시간만 재는 단조 시계. 벽시계를 넘기지 않는다.
  readonly monotonic: MonotonicClock;
  // 지금 장부의 복원이 5단계까지 끝났는가. 장부가 실패해 다시 열고 복원하는 동안은 false여야 한다.
  readonly restoreDone: () => boolean;
  readonly ledger: CycleLedger;
  readonly policy: CyclePolicy;
  // beat()가 돌려주는 보고를 돌려주기 직전에 받는다. 동기 기록기여야 한다. 던져도 박자에는 영향이 없다.
  readonly observe?: (report: BeatReport) => void;
}

export interface Cycle {
  beat(): Promise<BeatReport>;
  // 발급 닫힘 깃발을 세우고 진행 중인 박자가 돌아오기를 기다린다. 박자 안의 포트에서 이것을 기다리면 그 박자가 끝나지 않는다.
  closeIssuance(): Promise<void>;
  // 깃발이 서기 전이면 true. 내보내기 포트의 마지막 확인이 볼 자리다.
  issuanceOpen(): boolean;
  // 연결 표가 낸 candidate의 주체 이름. 끊김 기억에 "연결을 봤다"(absentSince: null)로 더한다. 작업자 실행기 이름이 아니면 버린다.
  noteCandidate(executorId: string): void;
}

export class CyclePolicyError extends TypeError {
  constructor(readonly field: keyof CyclePolicy) {
    super(`순서기 정책의 ${field}가 범위 밖이다`);
  }
}

export type SkipReason = "restore_not_done" | "issuance_closed" | "clock_untrusted";

export type Step<R> =
  | { readonly kind: "returned"; readonly result: R }
  // 박자 함수가 결과 없이 던졌다. 쓰기가 없었다고 가정하지 않고 장부를 다시 읽었다.
  | { readonly kind: "threw" }
  | { readonly kind: "skipped"; readonly reason: SkipReason };

export type RereadBeat = "link_loss" | "life" | "resend" | "assign";

export type Reread =
  // 결과 밖의 실행을 대조할 실행 목록. known은 읽었는지다.
  | { readonly beat: RereadBeat; readonly cause: "threw" | "halted" | "ledger_failed"; readonly read: "runs"; readonly known: boolean }
  // 적혔는지 모르는 지시. found는 갱신이면 그 발행 시각의 갱신이 장부에 있는지, 종료면 그 요청 ID가 답을 기다리는 지시로 있는지다.
  // 읽지 못하면 null이다.
  | {
      readonly beat: "life";
      readonly cause: "renew_record_unknown" | "stop_record_unknown";
      readonly read: "instruction_times" | "unanswered";
      readonly runId: string;
      readonly requestId: string;
      readonly found: boolean | null;
    };

export type BeatReport =
  | { readonly kind: "skipped"; readonly reason: "beat_in_progress" | "issuance_closed" }
  | {
      readonly kind: "ran";
      readonly serverTick: "ok" | "threw";
      // 박자 처음에 읽은 장부 시계. ok가 아니면 재전송·배정을 부르지 않았다.
      readonly clock: "ok" | "regressed" | "unavailable";
      readonly linkLoss: Step<LinkLossTickResult>;
      readonly life: Step<LifeTickResult>;
      readonly resend: Step<ResendTickResult>;
      // 부른 차례대로. 하나 이상이고, 부르지 않았으면 skipped 하나다.
      readonly assign: readonly Step<AssignTickResult>[];
      readonly rereads: readonly Reread[];
    };

const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isMonotonic = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isCount = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
// 싣지 못한 갱신을 판단에 넘기지 않아야 하는 상태. 이 둘을 떠난 것을 장부에서 확인하면 기억에서 뺀다(life-loop.md "싣지 못한 갱신").
const RENEWABLE: readonly unknown[] = ["preparing", "running"];

function readPolicy(policy: CyclePolicy): CyclePolicy {
  const { judgeMs, resendEveryMs, assignCallsPerBeat } = policy;
  if (!isCount(judgeMs, limits.RUN_LEASE_MAX_MS, Number.MAX_SAFE_INTEGER)) throw new CyclePolicyError("judgeMs");
  if (!isCount(resendEveryMs, 1, START_LAST_SEAL_MS)) throw new CyclePolicyError("resendEveryMs");
  if (!isCount(assignCallsPerBeat, 1, ASSIGN_CALLS_MAX)) throw new CyclePolicyError("assignCallsPerBeat");
  return Object.freeze({ judgeMs, resendEveryMs, assignCallsPerBeat });
}

function isWorkerName(value: unknown): value is string {
  try {
    return typeof value === "string" && parsePrincipal(value)?.kind === "worker_executor";
  } catch {
    return false;
  }
}

// 같은 키의 시각은 늦은 쪽을 남긴다: 다음 조회·재전송을 앞당기지 않는 쪽이다.
function bump(memory: Map<string, number>, key: string, at: number): void {
  const before = memory.get(key);
  memory.set(key, before === undefined ? at : Math.max(before, at));
}

export function createCycle(deps: CycleDeps): Cycle {
  const policy = readPolicy(deps.policy);
  const { beats, ledger } = deps;

  let watch: readonly WatchEntry[] = [];
  const lastQueries = new Map<string, number>();
  const lastResends = new Map<string, number>();
  const unsentRenews = new Set<string>();
  // 끊김 박자를 부르는 동안 더해진 candidate. 그 박자의 결과 watch로 바꾼 뒤 다시 더한다(결과가 덮어 지우지 않게).
  let notedDuringLinkLoss: string[] | null = null;

  // 이 프로세스에서 박자에 넘긴 시각의 하한. 그보다 이른 값은 던져서 박자가 시계를 읽지 못한 것으로 다루게 한다.
  let clockFloor = 0;
  let monotonicFloor = 0;
  const clock: Clock = {
    now() {
      const at: unknown = deps.ledgerClock.now();
      if (!isTime(at)) throw new RangeError("clock_unavailable");
      if (at < clockFloor) throw new RangeError("clock_regressed");
      clockFloor = at;
      return at;
    },
  };
  const monotonic: MonotonicClock = {
    now() {
      const at: unknown = deps.monotonic.now();
      if (!isMonotonic(at)) throw new RangeError("clock_unavailable");
      if (at < monotonicFloor) throw new RangeError("clock_regressed");
      monotonicFloor = at;
      return at;
    },
  };
  const readNow = (): { readonly state: "ok"; readonly at: number } | { readonly state: "regressed" | "unavailable" } => {
    try {
      return { state: "ok", at: clock.now() };
    } catch (error) {
      return { state: error instanceof RangeError && error.message === "clock_regressed" ? "regressed" : "unavailable" };
    }
  };

  let busy = false;
  let closed = false;
  let inFlight: Promise<BeatReport> | null = null;

  const setWatch = (entry: string): void => {
    const next = new Map(watch.map((item) => [item.executorId, item.absentSince] as const));
    next.set(entry, null);
    watch = [...next.keys()].sort().map((executorId) => ({ executorId, absentSince: next.get(executorId) ?? null }));
  };

  const pruneUnsent = (runs: readonly unknown[]): void => {
    for (const runId of [...unsentRenews]) {
      try {
        const row = runs.find((item) => (item as { runId?: unknown }).runId === runId) as { state?: unknown } | undefined;
        if (row !== undefined && !RENEWABLE.includes(row.state)) unsentRenews.delete(runId);
      } catch {
        // 그 줄을 읽지 못하면 그대로 둔다(빼는 것만 장부 확인이 필요하다).
      }
    }
  };

  const readRuns = (): boolean => {
    try {
      const answer = ledger.listRuns();
      if (answer.known !== true || !Array.isArray(answer.value)) return false;
      pruneUnsent(answer.value);
      return true;
    } catch {
      return false;
    }
  };

  const rereadRenew = (runId: string, requestId: string, issuedAt: number): Reread => {
    let found: boolean | null = null;
    try {
      const answer = ledger.instructionTimes(runId);
      if (answer.known === true && answer.value !== null) found = answer.value.renewIssued?.issuedAt === issuedAt;
    } catch {
      found = null;
    }
    return { beat: "life", cause: "renew_record_unknown", read: "instruction_times", runId, requestId, found };
  };

  const rereadStop = (runId: string, requestId: string): Reread => {
    let found: boolean | null = null;
    try {
      const answer = ledger.unansweredInstructions();
      if (answer.known === true) found = answer.value.instructions.some((item) => item.requestId === requestId);
    } catch {
      found = null;
    }
    return { beat: "life", cause: "stop_record_unknown", read: "unanswered", runId, requestId, found };
  };

  const takeLinkLoss = (result: LinkLossTickResult): void => {
    // ran이면 멈췄어도 결과의 watch가 온전하다. not_run이면 앞 기억을 그대로 쥔다.
    if (result.kind === "ran") watch = result.watch;
  };

  const takeLife = (result: LifeTickResult, rereads: Reread[]): void => {
    if (result.kind !== "ran") return;
    for (const run of result.runs) {
      if (run.outcome === "query_sent") bump(lastQueries, run.runId, run.at);
      else if (run.outcome === "query_not_sent" && run.delivery === "unknown" && run.at !== null) bump(lastQueries, run.runId, run.at);
      else if (run.outcome === "renew_recorded_not_sent") unsentRenews.add(run.runId);
      else if (run.outcome === "renew_record_unknown") {
        unsentRenews.add(run.runId);
        rereads.push(rereadRenew(run.runId, run.requestId, run.issuedAt));
      } else if (run.outcome === "stop_record_unknown") rereads.push(rereadStop(run.runId, run.requestId));
    }
    // 끝난 실행은 결과 목록에 없다. 멈춘 박자의 목록에는 멈춘 뒤의 실행이 없으므로 그때는 줄이지 않는다.
    if (result.halted === null) {
      const listed = new Set(result.runs.map((run) => run.runId));
      for (const runId of [...lastQueries.keys()]) if (!listed.has(runId)) lastQueries.delete(runId);
    }
  };

  const takeResend = (result: ResendTickResult): void => {
    if (result.kind !== "ran") return;
    for (const item of result.instructions) {
      if (item.outcome === "resent") bump(lastResends, item.requestId, item.at);
      else if (item.outcome === "not_sent" && item.delivery === "unknown") bump(lastResends, item.requestId, item.at);
    }
    // 읽기에서 사라진 요청 ID는 버린다(resend.md "뒤 조각이 지킬 것"). 멈춘 박자의 목록으로는 줄이지 않는다.
    if (result.halted === null) {
      const listed = new Set(result.instructions.map((item) => item.requestId));
      for (const requestId of [...lastResends.keys()]) if (!listed.has(requestId)) lastResends.delete(requestId);
    }
  };

  const runBeat = async (): Promise<BeatReport> => {
    const rereads: Reread[] = [];
    let serverTick: "ok" | "threw" = "ok";
    try {
      deps.serverTick();
    } catch {
      serverTick = "threw";
    }
    const start = readNow();

    // 한 번 막히면 그 박자의 남은 박자도 막힌다.
    let stopped: SkipReason | null = null;
    const gate = (): SkipReason | null => {
      if (stopped !== null) return stopped;
      if (closed) stopped = "issuance_closed";
      else {
        let done = false;
        try {
          done = deps.restoreDone() === true;
        } catch {
          done = false;
        }
        if (!done) stopped = "restore_not_done";
      }
      return stopped;
    };
    const rereadRuns = (beat: RereadBeat, cause: "threw" | "halted" | "ledger_failed"): void => {
      rereads.push({ beat, cause, read: "runs", known: readRuns() });
    };

    let linkLoss: Step<LinkLossTickResult>;
    const linkLossGate = gate();
    if (linkLossGate !== null) linkLoss = { kind: "skipped", reason: linkLossGate };
    else {
      const noted: string[] = [];
      notedDuringLinkLoss = noted;
      try {
        const result = beats.linkLoss({ clock, monotonic }, { judgeMs: policy.judgeMs }, { watch: [...watch] });
        takeLinkLoss(result);
        linkLoss = { kind: "returned", result };
      } catch {
        linkLoss = { kind: "threw" };
      } finally {
        notedDuringLinkLoss = null;
      }
      for (const executorId of noted) setWatch(executorId);
      if (linkLoss.kind === "threw") rereadRuns("link_loss", "threw");
      else if (linkLoss.result.kind === "ran") {
        if (linkLoss.result.halted !== null) rereadRuns("link_loss", "halted");
        else if (linkLoss.result.executors.some((item) => item.outcome === "ledger_failed" && (item.reason === "threw" || item.reason === "malformed_answer"))) {
          rereadRuns("link_loss", "ledger_failed");
        }
      }
    }

    let life: Step<LifeTickResult>;
    const lifeGate = gate();
    if (lifeGate !== null) life = { kind: "skipped", reason: lifeGate };
    else {
      if (unsentRenews.size > 0) readRuns();
      try {
        const result = await beats.life(clock, { lastQueries: [...lastQueries].map(([runId, at]) => ({ runId, at })), unsentRenews: [...unsentRenews] });
        takeLife(result, rereads);
        life = { kind: "returned", result };
      } catch {
        life = { kind: "threw" };
      }
      if (life.kind === "threw") rereadRuns("life", "threw");
      else if (life.result.kind === "ran" && life.result.halted !== null) rereadRuns("life", "halted");
    }

    const trusted = (): SkipReason | null => gate() ?? (start.state === "ok" ? null : "clock_untrusted");

    let resend: Step<ResendTickResult>;
    const resendGate = trusted();
    if (resendGate !== null) resend = { kind: "skipped", reason: resendGate };
    else {
      try {
        const result = await beats.resend(clock, { resendEveryMs: policy.resendEveryMs }, { lastResends: [...lastResends].map(([requestId, at]) => ({ requestId, at })) });
        takeResend(result);
        resend = { kind: "returned", result };
      } catch {
        resend = { kind: "threw" };
      }
      if (resend.kind === "threw") rereadRuns("resend", "threw");
      else if (resend.result.kind === "ran" && resend.result.halted !== null) rereadRuns("resend", "halted");
    }

    const assign: Step<AssignTickResult>[] = [];
    for (let call = 0; call < policy.assignCallsPerBeat; call += 1) {
      const assignGate = trusted();
      if (assignGate !== null) {
        assign.push({ kind: "skipped", reason: assignGate });
        break;
      }
      // 배정 박자의 now는 부르기 직전에 읽는다. 앞 박자들의 기다림만큼 흐른 시각을 쓴다.
      const now = readNow();
      if (now.state !== "ok") {
        assign.push({ kind: "skipped", reason: "clock_untrusted" });
        break;
      }
      let step: Step<AssignTickResult>;
      try {
        step = { kind: "returned", result: await beats.assign(now.at) };
      } catch {
        step = { kind: "threw" };
      }
      assign.push(step);
      if (step.kind === "threw") {
        rereadRuns("assign", "threw");
        break;
      }
      const result = step.result;
      if (result.kind !== "ran") break;
      if (result.halted === "threw") rereadRuns("assign", "halted");
      if (result.halted !== null || !result.requests.some((item) => item.outcome === "assigned")) break;
    }

    return { kind: "ran", serverTick, clock: start.state, linkLoss, life, resend, assign, rereads };
  };

  const report = (value: BeatReport): BeatReport => {
    try {
      deps.observe?.(value);
    } catch {
      // 기록기의 실패는 박자의 결과가 아니다.
    }
    return value;
  };

  return {
    beat(): Promise<BeatReport> {
      if (closed) return Promise.resolve(report({ kind: "skipped", reason: "issuance_closed" }));
      // 박자 안의 동기 구간(서버 tick, 끊김 박자)에서 다시 불려도 잡도록 약속을 만들기 전에 세운다.
      if (busy) return Promise.resolve(report({ kind: "skipped", reason: "beat_in_progress" }));
      busy = true;
      const current = (async () => {
        try {
          return report(await runBeat());
        } finally {
          busy = false;
        }
      })();
      inFlight = current;
      return current;
    },
    async closeIssuance(): Promise<void> {
      closed = true;
      const pending = inFlight;
      if (pending !== null) await pending.then(
        () => undefined,
        () => undefined,
      );
    },
    issuanceOpen(): boolean {
      return !closed;
    },
    noteCandidate(executorId: string): void {
      if (!isWorkerName(executorId)) return;
      setWatch(executorId);
      notedDuringLinkLoss?.push(executorId);
    },
  };
}
