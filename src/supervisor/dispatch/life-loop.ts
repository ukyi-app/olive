// 수명 순환의 한 박자. 끝나지 않은 실행마다 수명 판단(nextIntent)의 의도 하나를 장부에 적고, 적은 뒤에만 지시를 내보낸다.
// 상태를 갖지 않는다: 장부·접수·시계·난수·서명·내보내기는 포트로, 정책과 앞 박자의 조회 시각은 인자로 받는다.
// 소켓·타이머·시계·난수를 직접 부르지 않는다.
//
// 지키는 것:
// 1. 실행마다 의도 하나만 옮긴다. 기다림이면 쓰지 않는다. 갱신·취소는 장부의 기록이 성공한 뒤에만 그 답의 값으로 초안을 만들어
//    봉하고 그 실행의 지정 실행기에 내보낸다. 판단의 읽기가 하나라도 모름이면 그 실행은 이번 박자에 쓰지 않는다.
// 2. 갱신은 시작 접수가 장부에 반영된 실행에만, 기록에 쓸 시각으로 여유를 다시 잰 뒤에만 적는다. 싣는 순간
//    min(앞 임대의 끝, 봉투 시한) - 지금 >= RENEW_MARGIN_MS일 때만 싣는다. 작업 기한이 여유 안에 오는 실행에는 내지 않는다.
// 3. 임대를 모르거나 판단이 조회를 내면 같은 실행 ID로 status_query를 내고, 내보낸 조회를 기다리는 조회로 결과에 싣는다.
// 4. 취소(requested)와 기한(deadline)은 사유를 장부에 함께 적고 내보낸다. 이미 종료 지시가 적힌 실행에는 새 종료 지시를 적지 않는다.
//    장부에 쓴 뒤의 실패는 그 항목의 결과가 되고, 그 밖의 예외는 halted로 그때까지의 목록을 돌려준다.
//
// 확정(result_finalize)은 내지 않는다: 결과 보관(S6)이 없어 판단에 넘기는 resultSettled는 늘 false다.
import type { Envelope } from "../../contract/v1/index.ts";
import {
  type InputEntry,
  type InstructionTimes,
  type Ledger,
  REFUSALS as LEDGER_REFUSALS,
  type Refusal as LedgerRefusal,
  type Restorer,
  type Run,
  type TaskCancelReason,
} from "../../ledger/index.ts";
import { type LifecycleIntent, type LifecyclePolicy, type LifecycleView, nextIntent, RENEW_MARGIN_MS } from "../scheduler/lifecycle.ts";
import { newUuid, type RefusalReason as DraftRefusalReason, renewDraft, sealDraft, statusQueryDraft, stopDraft } from "./envelopes.ts";
import type { Clock, InstructionSink, Random, Signer } from "./ports.ts";
import type { PendingQuery } from "./receipts.ts";

// 장부 포트. 실제 장부(openLedger가 연 Ledger)가 그대로 맞는 꼴이다. 확정 기록(recordFinalizeInstruction)은 받지 않는다.
export type LifeLoopLedger = Pick<Ledger, "listRuns" | "listInputs" | "instructionTimes" | "recordRenewInstruction" | "recordStopInstruction">;

// 접수와 정지 세대. 실제로는 재시작 복원기(Restorer)다. 접수는 갱신 직전에만 본다: 갱신은 장부에서 새 업무와 같은 전제를 거치고,
// 종료 지시는 정지 중에도 접수가 닫혀도 적힌다(장부의 쓰기 모드 continue).
export type LifeIntake = Pick<Restorer, "intakeOpen" | "stopGeneration">;

export interface LifeLoopPorts {
  readonly ledger: LifeLoopLedger;
  readonly intake: LifeIntake;
  // 장부에 주입한 시계와 같은 시계. 박자 처음, 그리고 각 기록·봉하기·싣기 직전에 다시 읽는다.
  readonly clock: Clock;
  // 요청 ID·nonce가 모두 여기서 온다.
  readonly random: Random;
  readonly signer: Signer;
  readonly sink: InstructionSink;
}

export interface LifeTickInput {
  // 앞 박자들이 실행마다 낸 상태 조회의 시각(결과의 query_sent와 delivery가 unknown인 query_not_sent의 at).
  // 장부는 조회를 적지 않으므로 부르는 쪽이 메모리에 쥐고 넘긴다. 같은 실행의 조회는 마지막 조회부터 answerTimeoutMs가 지나야 다시 낸다.
  // 감독이 다시 뜨면 비어 있고, 그 박자는 조회가 필요한 실행을 곧바로 묻는다.
  readonly lastQueries: readonly { readonly runId: string; readonly at: number }[];
}

export type LifeRead = "runs" | "inputs" | "instruction_times";

// 내보내지 못한 이유. 앞의 넷과 봉하기 거절은 봉투를 만들지 못한 것이고, renew_margin_lost는 싣기 직전에 잰 송신 규칙(갱신)이다.
// no_connection·too_late_to_send는 내보내기 포트의 거절, send_threw·send_answer_malformed는 포트가 연결에 실었는지 모른다.
export type NotSentReason =
  | "ledger_answer_malformed"
  | "draft_threw"
  | "seal_threw"
  | "clock_unavailable"
  | DraftRefusalReason
  | "renew_margin_lost"
  | "no_connection"
  | "too_late_to_send"
  | "send_threw"
  | "send_answer_malformed";

type Delivery = "not_sent" | "unknown";
type WriteFailure = "random_unavailable" | "clock_unavailable" | "threw" | "malformed_answer";

// 갱신을 적지 않은 이유. 모두 장부를 부르기 전이다.
export type RenewWithheld = "start_not_accepted" | "deadline_within_margin" | "intake_closed" | "margin_lost" | "clock_unavailable";

export type RunOutcome =
  | { readonly runId: string; readonly outcome: "wait" }
  // 세션 실행. 세션의 수명은 세션 계약 작업이 연다(장부가 세션 시작을 닫아 두었다).
  | { readonly runId: string; readonly outcome: "not_worker" }
  | { readonly runId: string; readonly outcome: "read_unknown"; readonly read: LifeRead }
  // 판단이 확정을 냈지만 옮기지 않았다(결과 보관이 없다).
  | { readonly runId: string; readonly outcome: "finalize_withheld" }
  | { readonly runId: string; readonly outcome: "renew_withheld"; readonly reason: RenewWithheld }
  | { readonly runId: string; readonly outcome: "renew_sent"; readonly requestId: string; readonly issuedAt: number; readonly leaseUntil: number; readonly executorId: string }
  | { readonly runId: string; readonly outcome: "renew_refused"; readonly reason: LedgerRefusal }
  | { readonly runId: string; readonly outcome: "renew_failed"; readonly failure: WriteFailure }
  // 장부에는 갱신이 적혔고(장부는 그 끝을 임대로 믿을 수 있다) 전송 성공은 확인하지 못했다. 새 요청 ID로 다시 만들지 않는다.
  | {
      readonly runId: string;
      readonly outcome: "renew_recorded_not_sent";
      readonly requestId: string;
      readonly stopGeneration: number;
      readonly issuedAt: number;
      readonly leaseUntil: number | null;
      readonly executorId: string;
      readonly reason: NotSentReason;
      readonly delivery: Delivery;
      readonly field?: string;
      readonly sealReason?: string;
    }
  | { readonly runId: string; readonly outcome: "stop_sent"; readonly requestId: string; readonly cancelReason: TaskCancelReason; readonly issuedAt: number; readonly executorId: string }
  // 대기 실행을 지시 없이 not_started로 닫았다(장부가 지시 줄을 적지 않는다).
  | { readonly runId: string; readonly outcome: "closed_not_started" }
  | { readonly runId: string; readonly outcome: "stop_refused"; readonly reason: LedgerRefusal }
  | { readonly runId: string; readonly outcome: "stop_failed"; readonly failure: WriteFailure }
  | {
      readonly runId: string;
      readonly outcome: "stop_recorded_not_sent";
      readonly requestId: string;
      readonly stopGeneration: number;
      readonly issuedAt: number;
      readonly executorId: string | null;
      readonly cancelReason: TaskCancelReason;
      readonly reason: NotSentReason;
      readonly delivery: Delivery;
      readonly field?: string;
      readonly sealReason?: string;
    }
  // 같은 실행 ID의 상태 조회. cause가 stop_already_recorded이면 판단은 종료를 냈지만 이미 종료 지시가 적힌 실행이라 묻기만 했다.
  | { readonly runId: string; readonly outcome: "query_sent"; readonly requestId: string; readonly executorId: string; readonly at: number; readonly cause: QueryCause }
  | { readonly runId: string; readonly outcome: "query_held"; readonly lastQueryAt: number; readonly cause: QueryCause }
  | {
      readonly runId: string;
      readonly outcome: "query_not_sent";
      readonly at: number | null;
      readonly cause: QueryCause;
      readonly reason: NotSentReason;
      readonly delivery: Delivery;
      readonly field?: string;
      readonly sealReason?: string;
    };

export type QueryCause = "intent" | "stop_already_recorded";

export type LifeTickResult =
  | { readonly kind: "not_run"; readonly reason: "clock_unavailable" | "input_malformed" | "stop_generation_unknown" | "policy_rejected" }
  | { readonly kind: "not_run"; readonly reason: "read_unknown"; readonly read: Exclude<LifeRead, "instruction_times"> }
  | {
      readonly kind: "ran";
      // 끝나지 않은 실행(finalized·not_started 밖)마다 한 항목. 멈췄으면 멈춘 실행부터는 없다.
      readonly runs: readonly RunOutcome[];
      // 이번 박자에 내보낸(또는 실렸는지 모르는) 조회. 부르는 쪽이 영수증 처리기의 pendingQueries에 더한다.
      readonly pendingQueries: readonly PendingQuery[];
      // 항목을 처리하다 예상하지 못한 예외가 났다. haltedAt의 실행에 장부 쓰기가 있었는지 이 값으로는 모르므로
      // 부르는 쪽은 결과 목록에 없는 실행을 장부에서 다시 읽는다.
      readonly halted: "threw" | null;
      readonly haltedAt: string | null;
    };

// 장부의 시각 꼴(양의 안전 정수 ms).
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isRefusal = (value: unknown): value is LedgerRefusal => (LEDGER_REFUSALS as readonly unknown[]).includes(value);
const DONE: readonly string[] = ["finalized", "not_started"];

function freshUuid(random: Random): string | null {
  try {
    return newUuid(random);
  } catch {
    return null;
  }
}

// 시계를 다시 읽는다. 앞서 읽은 값보다 이르거나 꼴이 틀리면 null이다(nextIntent와 장부는 후퇴하지 않는 시각을 요구한다).
function readClock(clock: Clock, floor: number): number | null {
  try {
    const at: unknown = clock.now();
    return isTime(at) && at >= floor ? at : null;
  } catch {
    return null;
  }
}

function readList<T>(read: () => unknown): readonly T[] | null {
  try {
    const answer = read();
    if (!isObject(answer) || answer.known !== true || !Array.isArray(answer.value)) return null;
    return answer.value.every(isObject) ? (answer.value as T[]) : null;
  } catch {
    return null;
  }
}

function intakeOpen(intake: LifeIntake): boolean {
  try {
    return intake.intakeOpen() === true;
  } catch {
    return false;
  }
}

function validLastQueries(input: unknown): Map<string, number> | null {
  if (!isObject(input) || !Array.isArray(input.lastQueries)) return null;
  const last = new Map<string, number>();
  for (const entry of input.lastQueries as unknown[]) {
    if (!isObject(entry) || typeof entry.runId !== "string" || !isTime(entry.at)) return null;
    last.set(entry.runId, Math.max(last.get(entry.runId) ?? 0, entry.at));
  }
  return last;
}

// 판단에 넘긴 값과 그 값으로 낸 의도. 갱신은 기록 직전에 같은 view로 시각만 바꿔 판단을 다시 부른다.
interface Planned {
  run: Run;
  view: LifecycleView;
  intent: LifecycleIntent;
  times: InstructionTimes | null;
  cancelRequested: boolean;
}

interface Context {
  ports: LifeLoopPorts;
  policy: LifecyclePolicy;
  now: number;
  stopGeneration: number;
  lastQueries: Map<string, number>;
  pendingQueries: PendingQuery[];
}

// 판단의 입력. lease는 장부가 끝을 아는 임대만 넘긴다("unknown"이나 지시 없음은 null이고 판단은 같은 ID 조회로 간다).
// lastInstructionAt은 지금 상태가 기다리는 지시의 시각이다: stopping은 종료, 결과 쪽 상태는 확정. 그 밖의 상태에서 판단은 이 값을 쓰지 않는다.
function viewOf(run: Run, times: InstructionTimes | null, cancelRequested: boolean, now: number): LifecycleView {
  const lease = times?.lease ?? null;
  const known = lease !== null && typeof lease.expiresAt === "number" ? { issuedAt: lease.issuedAt, expiresAt: lease.expiresAt } : null;
  const lastInstructionAt = run.state === "stopping" ? (times?.lastStopAt ?? null) : ["checking", "ready_result", "failed_stopped", "cleanup_pending"].includes(run.state) ? (times?.lastFinalizeAt ?? null) : null;
  return {
    run: { runId: run.runId, kind: run.kind, state: run.state, deadlineAt: run.deadlineAt },
    lease: known,
    cancelRequested,
    lastInstructionAt,
    resultSettled: false,
    now,
  };
}

export async function lifeTick(ports: LifeLoopPorts, policy: LifecyclePolicy, input: LifeTickInput): Promise<LifeTickResult> {
  const now = readClock(ports.clock, 1);
  if (now === null) return { kind: "not_run", reason: "clock_unavailable" };
  const lastQueries = validLastQueries(input);
  if (lastQueries === null) return { kind: "not_run", reason: "input_malformed" };
  let stopGeneration: unknown;
  try {
    stopGeneration = ports.intake.stopGeneration();
  } catch {
    stopGeneration = null;
  }
  // 정지 세대는 모든 지시와 조회의 머리에 싣는다. 모르면 종료도 적지 않는다(장부도 정지 기록이 없으면 stop_unknown이다).
  if (!Number.isSafeInteger(stopGeneration) || (stopGeneration as number) < 0) return { kind: "not_run", reason: "stop_generation_unknown" };
  const runs = readList<Run>(() => ports.ledger.listRuns());
  if (runs === null) return { kind: "not_run", reason: "read_unknown", read: "runs" };
  const inputs = readList<InputEntry>(() => ports.ledger.listInputs());
  if (inputs === null) return { kind: "not_run", reason: "read_unknown", read: "inputs" };
  const cancelledOf = new Map(inputs.map((entry) => [entry.requestId, entry.cancelled]));

  // 쓰기 전의 읽기와 판단을 모든 실행에 먼저 한다. 정책이 틀려 판단이 던지면 어느 실행에도 쓰지 않는다.
  // 이 구간에서 읽기의 답을 해석하다 던지면(행의 칸 getter 등) 박자가 예외로 끝난다. 아직 쓰기 전이다.
  const plans: (Planned | RunOutcome)[] = [];
  for (const run of runs) {
    if (DONE.includes(run.state)) continue;
    if (run.kind !== "worker") {
      plans.push({ runId: run.runId, outcome: "not_worker" });
      continue;
    }
    // 소유자 입력이 없는 실행은 취소 요청이 없다. 입력에 이어졌는데 그 줄이 없거나 칸이 불리언이 아니면 모름이다.
    const cancelled = run.inputRequestId === null ? false : cancelledOf.get(run.inputRequestId);
    if (typeof cancelled !== "boolean") {
      plans.push({ runId: run.runId, outcome: "read_unknown", read: "inputs" });
      continue;
    }
    let times: InstructionTimes | null = null;
    // 대기 실행의 판단은 취소 요청만 본다. 그 밖은 지시 이력이 있어야 판단한다(없는 실행이면 두 읽기가 어긋난 것이라 모름).
    if (run.state !== "queued") {
      let answer: unknown;
      try {
        answer = ports.ledger.instructionTimes(run.runId);
      } catch {
        answer = null;
      }
      if (!isObject(answer) || answer.known !== true || !isObject(answer.value)) {
        plans.push({ runId: run.runId, outcome: "read_unknown", read: "instruction_times" });
        continue;
      }
      times = answer.value as unknown as InstructionTimes;
    }
    const view = viewOf(run, times, cancelled, now);
    let intent: LifecycleIntent;
    try {
      intent = nextIntent(view, policy);
    } catch {
      return { kind: "not_run", reason: "policy_rejected" };
    }
    plans.push({ run, view, intent, times, cancelRequested: cancelled });
  }

  const ctx: Context = { ports, policy, now, stopGeneration: stopGeneration as number, lastQueries, pendingQueries: [] };
  const outcomes: RunOutcome[] = [];
  let at: string | null = null;
  // 장부에 쓰기가 한 번이라도 성공한 뒤에는 예외를 박자 밖으로 내지 않는다. 내면 이미 적은 갱신·취소의 결과를 부르는 쪽이 잃는다.
  try {
    for (const plan of plans) {
      if ("outcome" in plan) {
        outcomes.push(plan);
        continue;
      }
      at = plan.run.runId;
      outcomes.push(await act(ctx, plan));
    }
  } catch {
    return { kind: "ran", runs: outcomes, pendingQueries: ctx.pendingQueries, halted: "threw", haltedAt: at };
  }
  return { kind: "ran", runs: outcomes, pendingQueries: ctx.pendingQueries, halted: null, haltedAt: null };
}

async function act(ctx: Context, plan: Planned): Promise<RunOutcome> {
  const runId = plan.run.runId;
  switch (plan.intent.intent) {
    case "wait":
      return { runId, outcome: "wait" };
    case "finalize":
      return { runId, outcome: "finalize_withheld" };
    case "query":
      return queryOne(ctx, plan.run, "intent");
    case "renew_lease":
      return renewOne(ctx, plan);
    case "stop":
      // 이미 종료 지시가 적힌 실행(stopping에서 끊겨 unknown_running이 된 실행)에 새 요청 ID의 종료를 또 적지 않는다.
      // 장부는 새 요청 ID면 받아 주므로 여기서 막는다. 앞 지시를 다시 보내는 것은 재전송 조각의 일이고, 이 박자는 같은 ID로 묻기만 한다.
      if (plan.times !== null && plan.times.lastStopAt !== null) return queryOne(ctx, plan.run, "stop_already_recorded");
      return stopOne(ctx, plan);
  }
}

// 갱신의 여유: 기록에 쓸 시각 at에서 판단이 여전히 갱신을 내고, 작업 기한까지도 같은 여유가 남는가.
// 실행기는 임대보다 작업 기한을 먼저 보므로, 기한이 at + RENEW_MARGIN_MS보다 이르면 갱신이 닿기 전에 기한으로 끝날 수 있다.
// 그런 실행은 지금의 임대가 이미 기한 너머까지 덮으므로(판단이 갱신을 낸 임대는 at + 여유 이후에 끝난다) 갱신 없이 기한의 길로 간다.
function renewFits(ctx: Context, plan: Planned, at: number): RenewWithheld | null {
  if (at + RENEW_MARGIN_MS > plan.run.deadlineAt) return "deadline_within_margin";
  if (nextIntent({ ...plan.view, now: at }, ctx.policy).intent !== "renew_lease") return "margin_lost";
  return null;
}

async function renewOne(ctx: Context, plan: Planned): Promise<RunOutcome> {
  const { run } = plan;
  const runId = run.runId;
  // 시작 접수의 반영: 실행 줄의 접수·시작 영수증 칸. 이 칸은 그 실행의 지정 실행기가 같은 세대로 낸 영수증만 채운다.
  // preparing·running에서는 종료 지시가 없으므로(종료를 적으면 stopping으로 가고 돌아오지 않는다) 접수 영수증은 시작 지시의 것이다.
  // 실행기는 시작의 실행 기록을 쓴 뒤에야 그 실행을 알므로, 그 전에 닿은 갱신은 모르는 실행으로 거절되고 장부만 연장된다.
  if (run.acceptedReceiptId === null && run.startedReceiptId === null) return { runId, outcome: "renew_withheld", reason: "start_not_accepted" };
  const early = renewFits(ctx, plan, ctx.now);
  if (early !== null) return { runId, outcome: "renew_withheld", reason: early };
  if (!intakeOpen(ctx.ports.intake)) return { runId, outcome: "renew_withheld", reason: "intake_closed" };
  // 기록에 쓸 시각으로 여유를 다시 잰다. 박자 처음의 now로 기록하면 그 사이 흐른 시간만큼 발행 시각이 실제보다 이르다.
  const recordAt = readClock(ctx.ports.clock, ctx.now);
  if (recordAt === null) return { runId, outcome: "renew_withheld", reason: "clock_unavailable" };
  const late = renewFits(ctx, plan, recordAt);
  if (late !== null) return { runId, outcome: "renew_withheld", reason: late };
  // 앞 임대의 끝: 이 갱신을 기록하기 전에 장부가 믿은 끝. renewFits가 판단을 거쳤으므로 숫자다.
  const priorEnd = plan.view.lease?.expiresAt as number;
  const requestId = freshUuid(ctx.ports.random);
  if (requestId === null) return { runId, outcome: "renew_failed", failure: "random_unavailable" };
  let answer: unknown;
  try {
    answer = ctx.ports.ledger.recordRenewInstruction({ runId, requestId, stopGeneration: ctx.stopGeneration, now: recordAt });
  } catch {
    return { runId, outcome: "renew_failed", failure: "threw" };
  }
  if (!isObject(answer) || (answer.ok !== true && answer.ok !== false)) return { runId, outcome: "renew_failed", failure: "malformed_answer" };
  if (answer.ok === false) return isRefusal(answer.reason) ? { runId, outcome: "renew_refused", reason: answer.reason } : { runId, outcome: "renew_failed", failure: "malformed_answer" };

  // 여기부터 장부에는 갱신이 적혔다. 실패는 이 갱신의 식별값을 낸다(새 요청 ID로 다시 만들지 않는다).
  const leaseUntil = isTime(answer.leaseUntil) ? answer.leaseUntil : null;
  const notSent = (reason: NotSentReason, extra: { field?: string; sealReason?: string; delivery?: Delivery } = {}): RunOutcome => ({
    runId,
    outcome: "renew_recorded_not_sent",
    requestId,
    stopGeneration: ctx.stopGeneration,
    issuedAt: recordAt,
    leaseUntil,
    executorId: run.executorId,
    reason,
    delivery: extra.delivery ?? "not_sent",
    ...(extra.field === undefined ? {} : { field: extra.field }),
    ...(extra.sealReason === undefined ? {} : { sealReason: extra.sealReason }),
  });
  let envelope: Envelope;
  try {
    const drafted = renewDraft({ run: { runId, runGeneration: run.runGeneration, executorId: run.executorId }, requestId, stopGeneration: ctx.stopGeneration, now: recordAt, leaseUntil });
    if (!drafted.ok) return notSent(drafted.reason, { field: drafted.field });
    let sealed: ReturnType<typeof sealDraft>;
    try {
      sealed = sealDraft(drafted.draft, recordAt, { random: ctx.ports.random, signer: ctx.ports.signer });
    } catch {
      return notSent("seal_threw");
    }
    if (!sealed.ok) return notSent(sealed.reason, { field: sealed.field, sealReason: sealed.sealReason });
    envelope = sealed.envelope;
  } catch {
    return notSent("draft_threw");
  }
  // 송신 규칙(ledger.md "봉투는 기본 수명 전체로 봉하고, 싣는 순간 남은 시간을 잰다"): 앞 임대의 끝과 봉투 시한 가운데 이른 것까지
  // RENEW_MARGIN_MS가 남아야 싣는다. 잰 뒤 포트를 부르기까지 await가 없다. 포트 안에서 실제로 싣기까지의 시간은 이 박자가 재지 못한다.
  const sendAt = readClock(ctx.ports.clock, recordAt);
  if (sendAt === null) return notSent("clock_unavailable");
  if (Math.min(priorEnd, envelope.header.expires_at) - sendAt < RENEW_MARGIN_MS) return notSent("renew_margin_lost");
  let sent: unknown;
  try {
    sent = await ctx.ports.sink.send(envelope);
  } catch {
    return notSent("send_threw", { delivery: "unknown" });
  }
  if (sent === "sent") return { runId, outcome: "renew_sent", requestId, issuedAt: recordAt, leaseUntil: leaseUntil as number, executorId: run.executorId };
  if (sent === "no_connection" || sent === "too_late_to_send") return notSent(sent);
  return notSent("send_answer_malformed", { delivery: "unknown" });
}

async function stopOne(ctx: Context, plan: Planned): Promise<RunOutcome> {
  const runId = plan.run.runId;
  // 판단은 취소 요청이나 기한이 지났을 때만 종료를 낸다. 둘 다면 소유자의 요청을 사유로 싣는다.
  const cancelReason: TaskCancelReason = plan.cancelRequested ? "requested" : "deadline";
  const recordAt = readClock(ctx.ports.clock, ctx.now);
  if (recordAt === null) return { runId, outcome: "stop_failed", failure: "clock_unavailable" };
  const requestId = freshUuid(ctx.ports.random);
  if (requestId === null) return { runId, outcome: "stop_failed", failure: "random_unavailable" };
  let answer: unknown;
  try {
    // 사유를 늘 넘긴다. 빼고 적은 종료 지시는 장부가 본문을 다시 만들 수 없음으로 남기고, 같은 요청 ID로 나중에 채울 수도 없다.
    answer = ctx.ports.ledger.recordStopInstruction({ runId, requestId, action: "task_cancel", stopGeneration: ctx.stopGeneration, now: recordAt, reason: cancelReason });
  } catch {
    return { runId, outcome: "stop_failed", failure: "threw" };
  }
  if (!isObject(answer) || (answer.ok !== true && answer.ok !== false)) return { runId, outcome: "stop_failed", failure: "malformed_answer" };
  if (answer.ok === false) return isRefusal(answer.reason) ? { runId, outcome: "stop_refused", reason: answer.reason } : { runId, outcome: "stop_failed", failure: "malformed_answer" };

  // 여기부터 장부에는 종료가 적혔다(대기 실행이면 지시 없이 not_started로 닫혔다).
  const run = answer.run;
  const executorId = isObject(run) && typeof run.executorId === "string" ? run.executorId : null;
  const notSent = (reason: NotSentReason, extra: { field?: string; sealReason?: string; delivery?: Delivery } = {}): RunOutcome => ({
    runId,
    outcome: "stop_recorded_not_sent",
    requestId,
    stopGeneration: ctx.stopGeneration,
    issuedAt: recordAt,
    executorId,
    cancelReason,
    reason,
    delivery: extra.delivery ?? "not_sent",
    ...(extra.field === undefined ? {} : { field: extra.field }),
    ...(extra.sealReason === undefined ? {} : { sealReason: extra.sealReason }),
  });
  if (!isObject(run) || run.runId !== runId) return notSent("ledger_answer_malformed");
  if (run.state === "not_started") return { runId, outcome: "closed_not_started" };
  let envelope: Envelope;
  try {
    const drafted = stopDraft({
      action: "task_cancel",
      run: { runId, runGeneration: run.runGeneration as number, executorId: run.executorId as string },
      requestId,
      stopGeneration: ctx.stopGeneration,
      reason: cancelReason,
    });
    if (!drafted.ok) return notSent(drafted.reason, { field: drafted.field });
    let sealed: ReturnType<typeof sealDraft>;
    try {
      // 종료의 머리 issued_at은 봉하는 때의 시각이다. 처음 봉할 때는 장부 기록에 넘긴 시각을 쓴다(envelopes.md "시각 규칙").
      sealed = sealDraft(drafted.draft, recordAt, { random: ctx.ports.random, signer: ctx.ports.signer });
    } catch {
      return notSent("seal_threw");
    }
    if (!sealed.ok) return notSent(sealed.reason, { field: sealed.field, sealReason: sealed.sealReason });
    envelope = sealed.envelope;
  } catch {
    return notSent("draft_threw");
  }
  let sent: unknown;
  try {
    sent = await ctx.ports.sink.send(envelope);
  } catch {
    return notSent("send_threw", { delivery: "unknown" });
  }
  if (sent === "sent") return { runId, outcome: "stop_sent", requestId, cancelReason, issuedAt: recordAt, executorId: envelope.header.recipient };
  if (sent === "no_connection" || sent === "too_late_to_send") return notSent(sent);
  return notSent("send_answer_malformed", { delivery: "unknown" });
}

// 같은 실행 ID의 상태 조회. 장부에 적지 않는다(지시 줄이 생기지 않는다). 요청 ID는 초안이 새로 만든다.
async function queryOne(ctx: Context, run: Run, cause: QueryCause): Promise<RunOutcome> {
  const runId = run.runId;
  const last = ctx.lastQueries.get(runId);
  // 마지막 조회부터 answerTimeoutMs 안이면 다시 묻지 않는다(박자마다 새 조회로 같은 실행을 두드리지 않는다).
  if (last !== undefined && ctx.now - last < ctx.policy.answerTimeoutMs) return { runId, outcome: "query_held", lastQueryAt: last, cause };
  const notSent = (at: number | null, reason: NotSentReason, extra: { field?: string; sealReason?: string; delivery?: Delivery } = {}): RunOutcome => ({
    runId,
    outcome: "query_not_sent",
    at,
    cause,
    reason,
    delivery: extra.delivery ?? "not_sent",
    ...(extra.field === undefined ? {} : { field: extra.field }),
    ...(extra.sealReason === undefined ? {} : { sealReason: extra.sealReason }),
  });
  const at = readClock(ctx.ports.clock, ctx.now);
  if (at === null) return notSent(null, "clock_unavailable");
  let envelope: Envelope;
  try {
    const drafted = statusQueryDraft({ recipient: run.executorId, stopGeneration: ctx.stopGeneration, runIds: [runId] }, ctx.ports.random);
    if (!drafted.ok) return notSent(at, drafted.reason, { field: drafted.field });
    let sealed: ReturnType<typeof sealDraft>;
    try {
      sealed = sealDraft(drafted.draft, at, { random: ctx.ports.random, signer: ctx.ports.signer });
    } catch {
      return notSent(at, "seal_threw");
    }
    if (!sealed.ok) return notSent(at, sealed.reason, { field: sealed.field, sealReason: sealed.sealReason });
    envelope = sealed.envelope;
  } catch {
    return notSent(at, "draft_threw");
  }
  const pending: PendingQuery = { requestId: envelope.header.request_id, recipient: envelope.header.recipient, runIds: [runId] };
  let sent: unknown;
  try {
    sent = await ctx.ports.sink.send(envelope);
  } catch {
    // 실렸을 수 있으므로 답을 대조할 수 있게 기다리는 조회에 넣는다.
    ctx.pendingQueries.push(pending);
    return notSent(at, "send_threw", { delivery: "unknown" });
  }
  if (sent === "sent") {
    ctx.pendingQueries.push(pending);
    return { runId, outcome: "query_sent", requestId: pending.requestId, executorId: pending.recipient, at, cause };
  }
  if (sent === "no_connection" || sent === "too_late_to_send") return notSent(at, sent);
  ctx.pendingQueries.push(pending);
  return notSent(at, "send_answer_malformed", { delivery: "unknown" });
}
