// 배정·시작 순환의 한 박자. 대기 실행 하나에 시작을 장부에 적은 뒤에만 시작 지시를 내보내고, 대기 부탁을 골라 실행 줄에 잇는다.
// 상태를 갖지 않는다: 장부·접수·연결 후보·사실·자격·난수·서명·내보내기는 포트로, 정책과 지금 시각은 인자로 받는다.
// 소켓·타이머·시계·난수를 직접 부르지 않는다.
//
// 지키는 것:
// 1. 닫혔거나 모르면 쓰지 않는다. 접수, 정지 세대, 대기 부탁 목록, 후보 연결, 시작 판단의 읽기 넷을 쓰기 전에 모두 읽고,
//    하나라도 닫힘·모름·틀림이면 그 박자에는 잇기도 시작도 부르지 않는다. 쓰기 직전마다 접수를 다시 본다(포트가 비동기라 박자 중에 닫힐 수 있다).
// 2. 잇기는 pickAssignment가 assign을 낸 부탁만, 난수 포트에서 만든 새 실행 ID로 한다. 한 부탁의 보류·거절·실패는 그 부탁만 건너뛴다.
// 3. 시작은 planNext의 작업자 후보만 startRun에 넘기고, 장부의 성공 답(issuedAt)을 받은 뒤에만 초안 → 봉하기 → 내보내기를 한다.
// 4. 내보내지 못하면 그 실행을 장부에 적힌 그대로 두고, 새 실행 ID·새 요청 ID로 다시 만들지 않는다(다시 보내기는 뒤 조각).
//
// 시작 판단은 쓰기 전에 읽은 장부 하나로 한다. 그래서 이번 박자에 이은 실행은 다음 박자의 읽기에서 시작 후보가 된다.
// 잇기 뒤에 다시 읽으면 그 읽기가 모름일 때 이미 이은 박자에 "모르면 잇지 않는다"를 지킬 수 없다.
import type { Envelope } from "../../contract/v1/index.ts";
import {
  type CredentialRef,
  type InputEntry,
  type Ledger,
  REFUSALS as LEDGER_REFUSALS,
  type Refusal as LedgerRefusal,
  type Restorer,
  type Run,
  type StartBar,
  type WaitingToolRequest,
} from "../../ledger/index.ts";
import { type AccountRef, selectAccount } from "../accounts/fixed.ts";
import type { AssignmentContext } from "../roles/assign.ts";
import { type Origin, planNext, type SchedulerInput, type SchedulerPolicy, type SchedulerRun, type SchedulerView } from "../scheduler/queue.ts";
import type { Candidate } from "../transport/connections.ts";
import { newUuid, type RefusalReason as DraftRefusalReason, sealDraft, startDraft, type StartDraftInput } from "./envelopes.ts";
import { type Pick as PickResult, pickAssignment, type PreAssignFacts, type RunPlan } from "./pick.ts";
import type { CredentialPort, InstructionSink, Random, Signer } from "./ports.ts";

// 장부 포트. 실제 장부(openLedger가 연 Ledger)가 그대로 맞는 꼴이다.
export type AssignLoopLedger = Pick<Ledger, "listWaitingToolRequests" | "assignToolRequest" | "queueView" | "listRuns" | "slotHolds" | "listInputs" | "startRun">;

// 접수와 정지 세대. 실제로는 재시작 복원기(Restorer)다. 정지 세대는 startRun과 시작 지시의 머리에 싣는다.
export type IntakeSource = Pick<Restorer, "intakeOpen" | "stopGeneration">;

// 배정 후보 연결. 조립 코드가 Connections.candidates(복원기)를 감싼다. 그 함수는 세대를 모르면 빈 목록을 내므로
// "후보 없음"과 "모름"을 가르려면 감싸는 쪽이 복원기의 정지 세대를 보고 모름이면 known: false를 낸다.
export interface CandidateSource {
  candidates(): { known: true; value: readonly Candidate[] } | { known: false };
}

// 배정 전 거절의 사실(pick.ts의 PRE_ASSIGN_FACTS)을 그 부탁과 대조해 채운다. 모르는 칸은 비운다(false로 채우지 않는다).
// 던지면 이 박자에서는 모든 칸을 모름으로 보고 고르기가 보류한다.
export interface FactSource {
  facts(request: WaitingToolRequest): PreAssignFacts | Promise<PreAssignFacts>;
}

export interface AssignLoopPorts {
  readonly ledger: AssignLoopLedger;
  readonly intake: IntakeSource;
  readonly connections: CandidateSource;
  readonly facts: FactSource;
  readonly credentials: CredentialPort;
  // 실행 ID·시작 지시의 요청 ID·nonce가 모두 여기서 온다.
  readonly random: Random;
  readonly signer: Signer;
  readonly sink: InstructionSink;
}

// 배포가 넣는 값. 코드에 기본값이 없다.
export interface AssignLoopPolicy {
  readonly assignment: AssignmentContext;
  readonly accounts: readonly AccountRef[];
  readonly plans: readonly RunPlan[];
  readonly queue: SchedulerPolicy;
  // 접수 출처 이름(listInputs의 source)을 관리자·경보로 나누는 접수 정책. 모르면 undefined이고 그 입력의 실행은 planNext가 보류한다.
  readonly originOf: (source: string) => Origin | undefined;
}

export const LOOP_READS = ["waiting_requests", "candidates", "queue_view", "runs", "slot_holds", "inputs"] as const;
export type LoopRead = (typeof LOOP_READS)[number];

// pickAssignment가 assign이 아닌 답을 낸 부탁. 그 답을 그대로 싣는다(원문·자격 값이 없는 이름과 목록뿐이다).
export type NotPicked = Exclude<PickResult, { kind: "assign" }>;

export type RequestOutcome =
  | { readonly ref: string; readonly outcome: "skipped"; readonly pick: NotPicked }
  | { readonly ref: string; readonly outcome: "assigned"; readonly runId: string; readonly executorId: string }
  // 이미 이어진 부탁. 넘긴 실행 ID는 쓰이지 않았고 장부가 돌려준 실행이 그 부탁의 실행이다.
  | { readonly ref: string; readonly outcome: "already_assigned"; readonly runId: string; readonly executorId: string }
  | { readonly ref: string; readonly outcome: "assign_refused"; readonly reason: LedgerRefusal }
  // 장부를 부르지 않았거나(random_unavailable) 장부가 던졌거나 답의 꼴이 틀렸다. 실제 장부가 던지는 것은 트랜잭션 전의 입력 검사뿐이다.
  | { readonly ref: string; readonly outcome: "assign_failed"; readonly failure: "random_unavailable" | "threw" | "malformed_answer" };

// 시작은 장부에 적혔지만 지시를 내보내지 못한 이유. 앞의 넷과 봉하기 거절은 봉투를 만들지 못한 것이고, no_connection·too_late_to_send는
// 내보내기 포트의 거절이다. send_threw·send_answer_malformed는 포트가 연결에 실었는지 모른다(delivery: "unknown").
export type NotSentReason =
  | "ledger_answer_malformed"
  | "draft_threw"
  | "seal_threw"
  | DraftRefusalReason
  | "no_connection"
  | "too_late_to_send"
  | "send_threw"
  | "send_answer_malformed";

export type StartOutcome =
  | { readonly runId: string; readonly outcome: "sent"; readonly requestId: string; readonly issuedAt: number; readonly executorId: string }
  // 장부에는 시작(preparing, task_start 지시)이 적혔고 지시는 나가지 않았다. 다시 보내는 쪽(뒤 조각)이 쓸 식별값을 싣는다.
  // issuedAt·executorId는 장부의 답에서 읽지 못했으면 null이다.
  | {
      readonly runId: string;
      readonly outcome: "recorded_not_sent";
      readonly requestId: string;
      readonly stopGeneration: number;
      readonly issuedAt: number | null;
      readonly executorId: string | null;
      readonly reason: NotSentReason;
      readonly delivery: "not_sent" | "unknown";
      readonly field?: string;
      readonly sealReason?: string;
    }
  | { readonly runId: string; readonly outcome: "start_refused"; readonly reason: LedgerRefusal }
  // 장부를 부르지 않았거나(random_unavailable) 장부가 던졌거나 답이 성공·거절의 꼴이 아니다. 적혔는지 모르므로 지시를 만들지 않는다.
  | { readonly runId: string; readonly outcome: "start_failed"; readonly failure: "random_unavailable" | "threw" | "malformed_answer" }
  // 세션 후보. 세션 시작은 장부가 닫아 두었고(session_start_closed) 이 조각이 내지 않는다.
  | { readonly runId: string; readonly outcome: "not_worker" };

// 박자가 멈춘 자리: 결과를 내지 못한 첫 항목(시작 후보의 실행, 또는 대기 부탁).
export type HaltedAt = { readonly step: "start"; readonly runId: string } | { readonly step: "assign"; readonly ref: string };

export type TickResult =
  | { readonly kind: "not_run"; readonly reason: "malformed_now" | "intake_closed" | "stop_generation_unknown" | "policy_rejected" }
  | { readonly kind: "not_run"; readonly reason: "read_unknown"; readonly read: LoopRead }
  | {
      readonly kind: "ran";
      readonly starts: readonly StartOutcome[];
      readonly requests: readonly RequestOutcome[];
      // 남은 일을 하지 않고 멈춘 이유. intake_closed는 박자 중에 접수가 닫혀 남은 쓰기를 부르지 않은 것이고,
      // threw는 항목을 처리하다 예상하지 못한 예외가 난 것이다. 목록에는 그 전까지 한 것이 모두 있다.
      // 멈춘 자리의 항목은 목록에 없다. threw이면 그 항목에 장부 쓰기가 있었는지 이 값으로는 모른다.
      readonly halted: "intake_closed" | "threw" | null;
      readonly haltedAt: HaltedAt | null;
    };

// 장부의 시각 꼴(양의 안전 정수 ms). pickAssignment·장부와 같은 조건이다.
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isRefusal = (value: unknown): value is LedgerRefusal => (LEDGER_REFUSALS as readonly unknown[]).includes(value);
// 장부가 대기 실행에 붙이는 시작 불가 사유 전부. Record라 장부가 사유를 더하거나 빼면 타입 검사가 여기서 실패한다.
const START_BARS: Record<StartBar, true> = { run_generation_stale: true, run_blocked: true, input_cancelled: true, input_expired: true, deadline_passed: true };
const isStartBar = (value: unknown): value is StartBar => typeof value === "string" && Object.hasOwn(START_BARS, value);

// 난수 포트가 던지면 null(random_unavailable)이다. 예외를 박자 밖으로 내면 앞서 장부에 적은 시작·잇기의 결과까지 부르는 쪽이 잃는다.
function freshUuid(random: Random): string | null {
  try {
    return newUuid(random);
  } catch {
    return null;
  }
}

// 읽기 포트의 답. 던지거나 꼴이 틀리면 모름이다. 항목은 모두 객체여야 한다: 칸을 읽다가 던지면 구별된 답 대신 예외가 된다.
// 칸의 값은 여기서 보지 않는다(고르기·판단이 보고 보류한다).
function readList<T>(read: () => unknown): readonly T[] | null {
  try {
    const answer = read();
    if (!isObject(answer) || answer.known !== true || !Array.isArray(answer.value)) return null;
    return answer.value.every(isObject) ? (answer.value as T[]) : null;
  } catch {
    return null;
  }
}

function intakeOpen(intake: IntakeSource): boolean {
  try {
    return intake.intakeOpen() === true;
  } catch {
    return false;
  }
}

type Snapshot = { stopGeneration: number; waiting: readonly WaitingToolRequest[]; candidates: readonly Candidate[]; view: SchedulerView };

// 쓰기 전의 읽기 전부. 하나라도 닫힘·모름이면 그 이유를 낸다.
function readAll(ports: AssignLoopPorts, policy: AssignLoopPolicy, now: number): Snapshot | Extract<TickResult, { kind: "not_run" }> {
  if (!intakeOpen(ports.intake)) return { kind: "not_run", reason: "intake_closed" };
  let stopGeneration: unknown;
  try {
    stopGeneration = ports.intake.stopGeneration();
  } catch {
    stopGeneration = null;
  }
  if (!Number.isSafeInteger(stopGeneration) || (stopGeneration as number) < 0) return { kind: "not_run", reason: "stop_generation_unknown" };
  const { ledger } = ports;
  const waiting = readList<WaitingToolRequest>(() => ledger.listWaitingToolRequests());
  if (waiting === null) return { kind: "not_run", reason: "read_unknown", read: "waiting_requests" };
  const candidates = readList<Candidate>(() => ports.connections.candidates());
  if (candidates === null) return { kind: "not_run", reason: "read_unknown", read: "candidates" };

  let queue: unknown;
  try {
    // 다른 읽기와 같이 불리언 true일 때만 안 것으로 친다("false" 같은 값은 참으로 읽히지 않게).
    const answer: unknown = ledger.queueView();
    queue = isObject(answer) && answer.known === true ? answer.value : null;
  } catch {
    queue = null;
  }
  if (!isObject(queue) || !Array.isArray(queue.runs) || !queue.runs.every(isObject)) return { kind: "not_run", reason: "read_unknown", read: "queue_view" };
  const runs = readList<Run>(() => ledger.listRuns());
  if (runs === null) return { kind: "not_run", reason: "read_unknown", read: "runs" };
  const holds = readList<SchedulerView["slotHolds"][number]>(() => ledger.slotHolds());
  if (holds === null) return { kind: "not_run", reason: "read_unknown", read: "slot_holds" };
  const inputs = readList<InputEntry>(() => ledger.listInputs());
  if (inputs === null) return { kind: "not_run", reason: "read_unknown", read: "inputs" };

  // 대기 실행의 시작 불가 사유는 queueView만 준다. 대기 실행의 사유는 명시적 null이거나 장부가 정한 이름이어야 한다.
  // 두 읽기가 어긋나 줄이 없거나, 칸이 빠졌거나(undefined) 다른 값이면 null(막지 않음)로 읽지 않고 모름이다.
  const bars = new Map((queue.runs as Record<string, unknown>[]).map((r) => [r.runId, r.startBar]));
  const view: SchedulerRun[] = [];
  for (const run of runs) {
    const bar = bars.get(run.runId);
    if (run.state === "queued" && bar !== null && !isStartBar(bar)) return { kind: "not_run", reason: "read_unknown", read: "queue_view" };
    view.push({
      runId: run.runId,
      kind: run.kind,
      role: run.role,
      state: run.state,
      queueSeq: run.queueSeq,
      inputRequestId: run.inputRequestId,
      deadlineAt: run.deadlineAt,
      budgetLeft: run.budgetLeft,
      startBar: isStartBar(bar) ? bar : null,
    });
  }
  // 출처를 나누지 못한 입력은 넣지 않는다. 그 입력의 실행은 planNext가 input_unknown으로 보류한다.
  const known: SchedulerInput[] = [];
  for (const input of inputs) {
    let origin: Origin | undefined;
    try {
      origin = policy.originOf(input.source);
    } catch {
      origin = undefined;
    }
    if (origin !== undefined) known.push({ requestId: input.requestId, origin, receivedAt: input.receivedAt, expiresAt: input.expiresAt, cancelled: input.cancelled });
  }
  return { stopGeneration: stopGeneration as number, waiting, candidates, view: { runs: view, inputs: known, slotHolds: holds, now } };
}

export async function assignAndStartTick(ports: AssignLoopPorts, policy: AssignLoopPolicy, now: number): Promise<TickResult> {
  if (!isTime(now)) return { kind: "not_run", reason: "malformed_now" };
  const snapshot = readAll(ports, policy, now);
  if ("kind" in snapshot) return snapshot;
  let plan: ReturnType<typeof planNext>;
  try {
    plan = planNext(snapshot.view, policy.queue);
  } catch {
    return { kind: "not_run", reason: "policy_rejected" };
  }

  const starts: StartOutcome[] = [];
  const requests: RequestOutcome[] = [];
  let at: HaltedAt | null = null;
  const halt = (halted: "intake_closed" | "threw"): TickResult => ({ kind: "ran", starts, requests, halted, haltedAt: at });
  // 쓰기가 시작된 뒤에는 예외를 박자 밖으로 내지 않는다. 내면 이미 장부에 적은 시작(recorded_not_sent·sent)과 이은 부탁의 결과를
  // 부르는 쪽이 잃고, 그 실행은 아무도 모르는 채 자리를 쥔다. 포트의 예외는 항목 안에서 구별된 결과가 되고, 이 catch는 그 밖의 예외를 받는다.
  try {
    // 시작을 먼저 한다: 판단은 박자 처음의 읽기로 했으므로, 잇기의 비동기 포트를 기다리는 동안 그 판단과 봉투의 시각이 낡지 않게 한다.
    for (const candidate of plan.candidates) {
      at = { step: "start", runId: candidate.runId };
      if (candidate.kind !== "worker") {
        starts.push({ runId: candidate.runId, outcome: "not_worker" });
        continue;
      }
      if (!intakeOpen(ports.intake)) return halt("intake_closed");
      starts.push(await startOne(ports, candidate.runId, snapshot.stopGeneration, now));
    }
    for (const request of snapshot.waiting) {
      at = { step: "assign", ref: request.ref };
      const outcome = await assignOne(ports, policy, snapshot.candidates, request, now);
      if (outcome === "intake_closed") return halt("intake_closed");
      requests.push(outcome);
    }
  } catch {
    return halt("threw");
  }
  return { kind: "ran", starts, requests, halted: null, haltedAt: null };
}

async function assignOne(
  ports: AssignLoopPorts,
  policy: AssignLoopPolicy,
  connections: readonly Candidate[],
  request: WaitingToolRequest,
  now: number,
): Promise<RequestOutcome | "intake_closed"> {
  const ref = request.ref;
  let facts: PreAssignFacts;
  try {
    facts = await ports.facts.facts(request);
  } catch {
    facts = {};
  }
  // 고르기가 대조할 자격 참조. 계정은 고르기와 같은 selectAccount로 정하고, 고르기가 다시 골라 대조한다(다르면 credential_mismatch).
  // 모르면 null이고 고르기가 credential_unknown으로 보류한다.
  let credential: CredentialRef | null = null;
  const account = selectAccount(request.role, policy.accounts);
  if (account.kind === "fixed") {
    try {
      const answer: unknown = await ports.credentials.reference({ account: account.account.account, method: account.account.method });
      // 꼴은 고르기가 본다(틀리면 malformed_credential).
      if (isObject(answer) && answer.known === true) credential = (answer.credential ?? null) as CredentialRef | null;
    } catch {
      credential = null;
    }
  }
  const picked = pickAssignment({
    request: { ref, role: request.role, inputDigest: request.inputDigest, input: request.input },
    connections,
    assignment: policy.assignment,
    accounts: policy.accounts,
    credential,
    plans: policy.plans,
    facts,
    // 비동기 포트를 기다린 뒤라 지금의 접수를 다시 읽어 넘긴다.
    intakeOpen: intakeOpen(ports.intake),
    now,
  });
  if (picked.kind === "intake_closed") return "intake_closed";
  if (picked.kind !== "assign") return { ref, outcome: "skipped", pick: picked };

  const runId = freshUuid(ports.random);
  if (runId === null) return { ref, outcome: "assign_failed", failure: "random_unavailable" };
  let answer: unknown;
  try {
    answer = ports.ledger.assignToolRequest({ ...picked.input, runId });
  } catch {
    return { ref, outcome: "assign_failed", failure: "threw" };
  }
  if (!isObject(answer)) return { ref, outcome: "assign_failed", failure: "malformed_answer" };
  if (answer.ok === false) return isRefusal(answer.reason) ? { ref, outcome: "assign_refused", reason: answer.reason } : { ref, outcome: "assign_failed", failure: "malformed_answer" };
  const run = answer.run;
  if (answer.ok !== true || !isObject(run) || typeof run.runId !== "string" || typeof run.executorId !== "string") {
    return { ref, outcome: "assign_failed", failure: "malformed_answer" };
  }
  if (answer.outcome === "assigned") {
    // 새로 이었다면 그 실행은 이번에 만든 실행 ID여야 한다. 다르면 장부의 답을 믿지 않는다.
    return run.runId === runId ? { ref, outcome: "assigned", runId, executorId: run.executorId } : { ref, outcome: "assign_failed", failure: "malformed_answer" };
  }
  if (answer.outcome === "already_assigned") return { ref, outcome: "already_assigned", runId: run.runId, executorId: run.executorId };
  return { ref, outcome: "assign_failed", failure: "malformed_answer" };
}

async function startOne(ports: AssignLoopPorts, runId: string, stopGeneration: number, now: number): Promise<StartOutcome> {
  const requestId = freshUuid(ports.random);
  if (requestId === null) return { runId, outcome: "start_failed", failure: "random_unavailable" };
  let answer: unknown;
  try {
    answer = ports.ledger.startRun({ runId, requestId, stopGeneration, now });
  } catch {
    return { runId, outcome: "start_failed", failure: "threw" };
  }
  if (!isObject(answer) || (answer.ok !== true && answer.ok !== false)) return { runId, outcome: "start_failed", failure: "malformed_answer" };
  if (answer.ok === false) return isRefusal(answer.reason) ? { runId, outcome: "start_refused", reason: answer.reason } : { runId, outcome: "start_failed", failure: "malformed_answer" };

  // 여기부터 장부에는 시작이 적혔다. 어느 실패든 그 실행을 그대로 두고 식별값을 낸다(새 실행 ID·요청 ID로 다시 만들지 않는다).
  const run = answer.run;
  const issuedAt = isTime(answer.issuedAt) ? answer.issuedAt : null;
  const executorId = isObject(run) && typeof run.executorId === "string" ? run.executorId : null;
  const notSent = (reason: NotSentReason, extra: { field?: string; sealReason?: string; delivery?: "unknown" } = {}): StartOutcome => ({
    runId,
    outcome: "recorded_not_sent",
    requestId,
    stopGeneration,
    issuedAt,
    executorId,
    reason,
    delivery: extra.delivery ?? "not_sent",
    ...(extra.field === undefined ? {} : { field: extra.field }),
    ...(extra.sealReason === undefined ? {} : { sealReason: extra.sealReason }),
  });
  if (!isObject(run) || run.runId !== runId) return notSent("ledger_answer_malformed");

  let drafted: ReturnType<typeof startDraft>;
  try {
    drafted = startDraft({ run: run as unknown as StartDraftInput["run"], requestId, stopGeneration, issuedAt: answer.issuedAt as number | null | undefined });
  } catch {
    return notSent("draft_threw");
  }
  if (!drafted.ok) return notSent(drafted.reason, { field: drafted.field });
  // 봉하는 시각은 박자의 now와 장부의 발행 시각 가운데 늦은 값이다. 장부는 박자의 now를 읽은 뒤 같은 시계로 발행 시각을 정하므로
  // now로만 봉하면 issued_in_future로 막힌다. 늦은 쪽도 같은 시계에서 읽은 값이고, 실제로 싣는 시각의 여유는 내보내기 포트가 다시 본다.
  const sealAt = issuedAt !== null && issuedAt > now ? issuedAt : now;
  let envelope: Envelope;
  try {
    const sealed = sealDraft(drafted.draft, sealAt, { random: ports.random, signer: ports.signer });
    if (!sealed.ok) return notSent(sealed.reason, { field: sealed.field, sealReason: sealed.sealReason });
    envelope = sealed.envelope;
  } catch {
    return notSent("seal_threw");
  }

  let sent: unknown;
  try {
    sent = await ports.sink.send(envelope);
  } catch {
    return notSent("send_threw", { delivery: "unknown" });
  }
  if (sent === "sent") return { runId, outcome: "sent", requestId, issuedAt: envelope.header.issued_at, executorId: envelope.header.recipient };
  if (sent === "no_connection" || sent === "too_late_to_send") return notSent(sent);
  return notSent("send_answer_malformed", { delivery: "unknown" });
}
