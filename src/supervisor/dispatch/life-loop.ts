// 수명 순환의 한 박자. 끝나지 않은 실행마다 수명 판단(nextIntent)의 의도 하나를 옮긴다. 갱신·취소는 장부에 적은 뒤에만 내보내고,
// 조회는 장부에 적지 않고 내보낸 것을 기다리는 조회로 결과에 싣는다.
// 장부·접수·연결·시계·난수·서명·내보내기는 포트로, 정책과 앞 박자들의 기억(조회 시각, 싣지 못한 갱신)은 인자로 받는다.
// 소켓·타이머·시계·난수를 직접 부르지 않는다. 쥐는 것은 같은 장부 포트로 박자가 진행 중이라는 표시 하나다(돌아오면 지운다).
//
// 지키는 것:
// 1. 실행마다 의도 하나만 옮긴다. 기다림이면 쓰지 않는다. 갱신·취소는 쓰기 직전에 그 실행의 줄·입력 취소·지시 이력을 다시 읽어 판단을
//    다시 하고, 여전히 그 의도일 때만 적는다. 장부의 기록이 성공한 뒤에만 그 답의 값으로 초안을 만들어 봉하고 지정 실행기에 내보낸다.
//    판단에 쓰는 읽기가 모름이거나 칸의 꼴이 틀리거나 같은 실행의 줄이 둘이면 그 실행은 이번 박자에 쓰지 않는다. 쓰기 직전에 다시 읽은
//    줄의 실행 세대가 0이거나, 지정 실행기가 실행의 종류와 다른 종류의 실행기이거나, 처음 읽은 줄과 식별값이 다르면 그 줄도 모름이다.
// 2. 갱신은 유효한 시작 접수 영수증 ID가 있고, 지정 실행기의 연결이 지시를 낼 수 있고, 기록에 쓸 시각으로 여유와 작업 기한을 다시 잰
//    뒤에만 적는다. 싣는 순간 min(앞 임대의 끝, 봉투 시한, 작업 기한) - 지금 >= RENEW_MARGIN_MS일 때만 싣는다. 부르는 쪽이 싣지 못했다고
//    넘긴 갱신의 실행은 장부의 임대 끝을 판단에 넘기지 않는다(조회로 간다).
// 3. 임대를 모르거나 판단이 조회를 내면 같은 실행 ID로 status_query를 내고, 내보낸 조회를 기다리는 조회로 결과에 싣는다.
// 4. 취소(requested)와 기한(deadline)은 사유를 장부에 함께 적고 내보낸다(연결이 없어도 적는다). 이미 종료 지시가 적힌 실행에는 새 종료
//    지시를 적지 않는다. 쓰기를 부른 항목은 결과에서 빠지지 않는다: 포트의 실패는 그 항목의 결과이고, 쓰기를 부른 뒤 내보내기의 결과가
//    정해지기 전의 어느 줄에서 던져도 그 항목까지 싣고 halted로 멈춘다.
//
// 확정(result_finalize)은 내지 않는다: 결과 보관(S6)이 없어 판단에 넘기는 resultSettled는 늘 false다.
import { type Envelope, parsePrincipal } from "../../contract/v1/index.ts";
import {
  type InstructionTimes,
  LEDGER_RUN_STATES,
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

// 지정 실행기의 연결이 지금 지시를 낼 수 있는가(계약 v1의 mayIssue). 조립은 그 실행기의 Link와 부르는 순간의 시각(장부와 같은 시계)으로
// mayIssue(action, link, now)를 불러 그 답을 돌려준다. 동기여야 한다: 이 답과 장부 쓰기 사이에 await가 없어야 다른 박자가 끼지 않는다.
// 갱신 기록 직전에만 부른다. 종료는 연결이 없어도 적는다(전해야 할 것이 남았다는 기록이고, 내보내기의 no_connection으로 구별된다).
export interface LinkGate {
  mayIssue(executorId: string, action: "run_renew"): { ok: true } | { ok: false; reason: string };
}

export interface LifeLoopPorts {
  readonly ledger: LifeLoopLedger;
  readonly intake: LifeIntake;
  readonly links: LinkGate;
  // 장부에 주입한 시계와 같은 시계. 박자 처음, 그리고 각 기록·봉하기·싣기 직전과 조회를 실은 뒤에 다시 읽는다.
  readonly clock: Clock;
  // 요청 ID·nonce가 모두 여기서 온다.
  readonly random: Random;
  readonly signer: Signer;
  readonly sink: InstructionSink;
}

export interface LifeTickInput {
  // 앞 박자들이 실행마다 낸 상태 조회의 시각(결과의 query_sent와 delivery가 unknown인 query_not_sent의 at. 실은 뒤에 읽은 시각이거나,
  // 그 시계를 읽지 못했으면 봉투 시한이다).
  // 장부는 조회를 적지 않으므로 부르는 쪽이 메모리에 쥐고 넘긴다. 같은 실행의 조회는 마지막 조회부터 answerTimeoutMs가 지나야 다시 낸다.
  // 감독이 다시 뜨면 비어 있고, 그 박자는 조회가 필요한 실행을 곧바로 묻는다.
  readonly lastQueries: readonly { readonly runId: string; readonly at: number }[];
  // 앞 박자들이 적었지만 싣지 못했거나 실렸는지 모르는 갱신의 실행 ID(결과의 renew_recorded_not_sent·renew_record_unknown).
  // 장부는 그 갱신의 끝을 임대로 믿지만 실행기는 앞 임대의 끝에서 이미 닫았을 수 있다. 이 목록의 실행은 장부의 임대 끝을 판단에
  // 넘기지 않으므로 새 갱신을 적지 않고 조회로 간다. 언제 빼는지는 부르는 쪽이 정한다(life-loop.md "싣지 못한 갱신").
  readonly unsentRenews: readonly string[];
}

export type LifeRead = "runs" | "inputs" | "instruction_times";

// 내보내지 못한 이유. 앞의 넷과 봉하기 거절은 봉투를 만들지 못한 것이고, renew_margin_lost·deadline_within_margin은 싣기 직전에 잰
// 송신 규칙(갱신)이다. no_connection·too_late_to_send는 내보내기 포트의 거절, send_threw·send_answer_malformed는 포트가 연결에 실었는지 모른다.
export type NotSentReason =
  | "ledger_answer_malformed"
  | "draft_threw"
  | "seal_threw"
  | "clock_unavailable"
  | DraftRefusalReason
  | "renew_margin_lost"
  | "deadline_within_margin"
  | "no_connection"
  | "too_late_to_send"
  | "send_threw"
  | "send_answer_malformed";

type Delivery = "not_sent" | "unknown";
// 장부를 부르기 전의 실패.
type WriteFailure = "random_unavailable" | "clock_unavailable";
// 장부를 불렀지만 적혔는지 모른다: 쓰기 포트가 던졌거나(threw) 답이 정의 밖이다(malformed_answer).
type RecordUnknown = "threw" | "malformed_answer";

// 갱신을 적지 않은 이유. 모두 장부를 부르기 전이다. no_connection은 연결 포트의 거절, link_unknown은 그 답을 모른다.
export type RenewWithheld = "start_not_accepted" | "deadline_within_margin" | "intake_closed" | "no_connection" | "link_unknown" | "margin_lost" | "clock_unavailable";

export type RunOutcome =
  | { readonly runId: string; readonly outcome: "wait" }
  // 세션 실행. 세션의 수명은 세션 계약 작업이 연다(장부가 세션 시작을 닫아 두었다).
  | { readonly runId: string; readonly outcome: "not_worker" }
  | { readonly runId: string; readonly outcome: "read_unknown"; readonly read: LifeRead }
  // 판단이 확정을 냈지만 옮기지 않았다(결과 보관이 없다).
  | { readonly runId: string; readonly outcome: "finalize_withheld" }
  // 쓰기 직전에 다시 읽은 실행 줄·입력 취소·지시 이력으로 판단하니 계획한 의도가 아니었다(그 사이 다른 쓰기가 있었다). 쓰지 않았다.
  | { readonly runId: string; readonly outcome: "superseded"; readonly planned: "renew_lease" | "stop" }
  | { readonly runId: string; readonly outcome: "renew_withheld"; readonly reason: RenewWithheld }
  | { readonly runId: string; readonly outcome: "renew_sent"; readonly requestId: string; readonly issuedAt: number; readonly leaseUntil: number; readonly executorId: string }
  | { readonly runId: string; readonly outcome: "renew_refused"; readonly reason: LedgerRefusal }
  | { readonly runId: string; readonly outcome: "renew_failed"; readonly failure: WriteFailure }
  // 장부를 불렀지만 갱신이 적혔는지 모른다. 지시를 만들지 않았다. 적혔다면 이 요청 ID로 적혔다.
  | {
      readonly runId: string;
      readonly outcome: "renew_record_unknown";
      readonly requestId: string;
      readonly stopGeneration: number;
      readonly issuedAt: number;
      readonly executorId: string;
      readonly reason: RecordUnknown;
    }
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
      readonly outcome: "stop_record_unknown";
      readonly requestId: string;
      readonly stopGeneration: number;
      readonly issuedAt: number;
      readonly executorId: string;
      readonly cancelReason: TaskCancelReason;
      readonly reason: RecordUnknown;
    }
  | {
      readonly runId: string;
      readonly outcome: "stop_recorded_not_sent";
      readonly requestId: string;
      readonly stopGeneration: number;
      readonly issuedAt: number;
      readonly executorId: string;
      readonly cancelReason: TaskCancelReason;
      readonly reason: NotSentReason;
      readonly delivery: Delivery;
      readonly field?: string;
      readonly sealReason?: string;
    }
  // 같은 실행 ID의 상태 조회. cause가 stop_already_recorded이면 판단은 종료를 냈지만 이미 종료 지시가 적힌 실행이라 묻기만 했다.
  // at은 내보내기 포트가 돌아온 뒤에 읽은 시각이다(그 뒤에 실렸을 수는 없다). 그 시계를 읽지 못했으면 봉투 시한이다(포트는 시한 뒤에 싣지 않는다).
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
  | { readonly kind: "not_run"; readonly reason: "clock_unavailable" | "input_malformed" | "stop_generation_unknown" | "policy_rejected" | "tick_in_progress" }
  | { readonly kind: "not_run"; readonly reason: "read_unknown"; readonly read: Exclude<LifeRead, "instruction_times"> }
  | {
      readonly kind: "ran";
      // 끝나지 않은 실행(finalized·not_started 밖)마다 한 항목. 멈췄으면 멈춘 실행의 항목(쓰기를 불렀다면)까지 있고 그 뒤는 없다.
      readonly runs: readonly RunOutcome[];
      // 이번 박자에 내보낸(또는 실렸는지 모르는) 조회. 부르는 쪽이 영수증 처리기의 pendingQueries에 더한다.
      readonly pendingQueries: readonly PendingQuery[];
      // 장부 쓰기의 답을 해석하다 예상하지 못한 예외가 났다. haltedAt의 실행부터 뒤는 처리하지 않았다.
      readonly halted: "threw" | null;
      readonly haltedAt: string | null;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 장부의 시각 꼴(양의 안전 정수 ms).
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isRefusal = (value: unknown): value is LedgerRefusal => (LEDGER_REFUSALS as readonly unknown[]).includes(value);
const DONE: readonly string[] = ["finalized", "not_started"];

// 같은 장부 포트로 진행 중인 박자. 박자를 겹쳐 부르지 않는 것이 호출 계약이고(앞 박자가 돌아온 뒤에 다음을 부른다), 이 표시는 그 계약을
// 어긴 호출을 읽기·쓰기 없이 돌려보낸다. 다른 포트 객체로 같은 장부를 겹쳐 부르면 알아채지 못한다. 쓰기 직전의 다시 읽기는 앞 항목을
// 기다리는 동안 끼어든 쓰기만 막고, 다른 포트 객체로 겹친 박자·동기 포트 안의 재진입·마지막 시계 읽기 안의 외부 쓰기는 막지 못한다.
const IN_FLIGHT = new WeakSet<object>();

function freshUuid(random: Random): string | null {
  try {
    return newUuid(random);
  } catch {
    return null;
  }
}

// 시계를 다시 읽는다. 앞서 읽은 값보다 이르거나 꼴이 틀리면 null이다(nextIntent와 장부는 후퇴하지 않는 시각을 요구한다).
// 포트 묶음에서 시계 객체를 얻는 일도 예외 처리 안에 둔다: 쓰기 뒤에 그 접근자가 던지면 적은 항목이 결과에서 빠진다.
function readClock(ports: { readonly clock: Clock }, floor: number): number | null {
  try {
    const at: unknown = ports.clock.now();
    return isTime(at) && at >= floor ? at : null;
  } catch {
    return null;
  }
}

function readList(read: () => unknown): readonly Record<string, unknown>[] | null {
  try {
    const answer = read();
    if (!isObject(answer) || answer.known !== true || !Array.isArray(answer.value)) return null;
    return answer.value.every(isObject) ? (answer.value as Record<string, unknown>[]) : null;
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

function linkVerdict(links: LinkGate, executorId: string): "no_connection" | "link_unknown" | null {
  try {
    const answer: unknown = links.mayIssue(executorId, "run_renew");
    if (!isObject(answer)) return "link_unknown";
    if (answer.ok === true) return null;
    return answer.ok === false && typeof answer.reason === "string" ? "no_connection" : "link_unknown";
  } catch {
    return "link_unknown";
  }
}

interface Memory {
  lastQueries: Map<string, number>;
  unsentRenews: ReadonlySet<string>;
}

function validMemory(input: unknown): Memory | null {
  try {
    if (!isObject(input) || !Array.isArray(input.lastQueries) || !Array.isArray(input.unsentRenews)) return null;
    const lastQueries = new Map<string, number>();
    for (const entry of input.lastQueries as unknown[]) {
      if (!isObject(entry) || typeof entry.runId !== "string" || !isTime(entry.at)) return null;
      lastQueries.set(entry.runId, Math.max(lastQueries.get(entry.runId) ?? 0, entry.at));
    }
    const unsentRenews = new Set<string>();
    for (const runId of input.unsentRenews as unknown[]) {
      if (typeof runId !== "string") return null;
      unsentRenews.add(runId);
    }
    return { lastQueries, unsentRenews };
  } catch {
    return null;
  }
}

// 판단과 지시에 쓰는 실행 줄의 칸. 읽은 줄에서 칸마다 한 번만 읽어 옮겨 적는다(같은 칸을 두 번 읽어 다른 값을 보지 않는다).
type RunRow = Pick<Run, "runId" | "runGeneration" | "kind" | "state" | "deadlineAt" | "executorId" | "inputRequestId" | "acceptedReceiptId" | "startedReceiptId">;
type Times = Pick<InstructionTimes, "lease" | "lastStopAt" | "lastFinalizeAt">;

interface Facts {
  run: RunRow;
  times: Times | null;
  cancelRequested: boolean;
}

// 영수증 칸은 null(아직 없음)이거나 장부의 영수증 ID(UUID)다. 칸이 없거나 빈 문자열·다른 꼴이면 줄의 꼴이 틀린 것이다.
const receiptCell = (value: unknown): value is string | null => value === null || isUuid(value);

// 실행 줄 하나. 실행 ID를 읽지 못하면 null(어느 실행의 줄인지 모른다), 다른 칸의 꼴이 틀리면 row가 null.
function snapshotRun(raw: Record<string, unknown>): { runId: string; row: RunRow | null } | null {
  let runId: unknown;
  try {
    runId = raw.runId;
  } catch {
    return null;
  }
  if (!isUuid(runId)) return null;
  try {
    const { kind, state, runGeneration, deadlineAt, executorId, inputRequestId, acceptedReceiptId, startedReceiptId } = raw;
    if (kind !== "worker" && kind !== "session") return { runId, row: null };
    if (!(LEDGER_RUN_STATES as readonly unknown[]).includes(state)) return { runId, row: null };
    if (!Number.isSafeInteger(runGeneration) || (runGeneration as number) < 0 || !isTime(deadlineAt)) return { runId, row: null };
    if (typeof executorId !== "string" || executorId === "") return { runId, row: null };
    if (!(inputRequestId === null || typeof inputRequestId === "string")) return { runId, row: null };
    if (!receiptCell(acceptedReceiptId) || !receiptCell(startedReceiptId)) return { runId, row: null };
    return {
      runId,
      row: { runId, kind, state: state as Run["state"], runGeneration: runGeneration as number, deadlineAt, executorId, inputRequestId, acceptedReceiptId, startedReceiptId },
    };
  } catch {
    return { runId, row: null };
  }
}

// 실행 목록을 실행 ID로 묶는다(목록의 순서 그대로). 같은 ID의 줄이 둘 이상이면 그 실행은 null(어느 줄이 맞는지 모른다).
// 어느 실행의 것인지 모르는 줄이 하나라도 있으면 목록 전체가 모름이다.
function indexRuns(rows: readonly Record<string, unknown>[]): Map<string, RunRow | null> | null {
  const index = new Map<string, RunRow | null>();
  for (const raw of rows) {
    const snap = snapshotRun(raw);
    if (snap === null) return null;
    index.set(snap.runId, index.has(snap.runId) ? null : snap.row);
  }
  return index;
}

// 입력 요청 ID마다 취소 여부. 같은 ID의 줄이 둘 이상이거나 칸이 불리언이 아니거나 읽다 던지면 null(모름). 요청 ID를 읽은 줄은
// 버리지 않는다: 버리면 같은 ID의 다른 줄(cancelled: false)만 남아 취소가 갱신으로 바뀐다. 요청 ID를 읽지 못한 줄은 어느 실행에도
// 닿지 않으므로 그 입력에 이어진 실행은 줄이 없는 것으로 모름이 된다.
function cancelIndex(rows: readonly Record<string, unknown>[]): Map<string, boolean | null> {
  const index = new Map<string, boolean | null>();
  for (const raw of rows) {
    let requestId: unknown;
    try {
      requestId = raw.requestId;
    } catch {
      continue;
    }
    if (typeof requestId !== "string") continue;
    let cancelled: unknown;
    try {
      cancelled = raw.cancelled;
    } catch {
      cancelled = undefined;
    }
    index.set(requestId, index.has(requestId) || typeof cancelled !== "boolean" ? null : cancelled);
  }
  return index;
}

// 지시 이력 중 판단에 쓰는 칸. 다른 실행의 이력이거나 칸의 꼴이 틀리면 null(모름).
function readTimes(ledger: LifeLoopLedger, runId: string): Times | null {
  try {
    const answer: unknown = ledger.instructionTimes(runId);
    if (!isObject(answer) || answer.known !== true || !isObject(answer.value)) return null;
    const { runId: of, lease, lastStopAt, lastFinalizeAt } = answer.value;
    if (of !== runId) return null;
    if (!(lastStopAt === null || isTime(lastStopAt)) || !(lastFinalizeAt === null || isTime(lastFinalizeAt))) return null;
    if (lease === null) return { lease: null, lastStopAt, lastFinalizeAt };
    if (!isObject(lease)) return null;
    const { issuedAt, expiresAt } = lease;
    if (!isTime(issuedAt) || !(isTime(expiresAt) || expiresAt === "unknown")) return null;
    return { lease: { issuedAt, expiresAt }, lastStopAt, lastFinalizeAt };
  } catch {
    return null;
  }
}

// 한 실행의 판단 재료. 소유자 입력이 없는 실행은 취소 요청이 없다. 입력에 이어졌는데 그 줄이 없거나 모름이면 모름이다.
// 대기 실행의 판단은 취소 요청만 본다. 그 밖은 지시 이력이 있어야 판단한다.
function factsOf(ledger: LifeLoopLedger, run: RunRow, cancels: Map<string, boolean | null>): Facts | { read: LifeRead } {
  const cancelled = run.inputRequestId === null ? false : cancels.get(run.inputRequestId);
  if (typeof cancelled !== "boolean") return { read: "inputs" };
  if (run.state === "queued") return { run, times: null, cancelRequested: cancelled };
  const times = readTimes(ledger, run.runId);
  if (times === null) return { read: "instruction_times" };
  return { run, times, cancelRequested: cancelled };
}

// 지시를 적어도 되는 실행 줄인가. 실행 세대는 1 이상이고(장부는 0을 만들지 않고 받는 쪽은 0인 실행 지시를 받지 않는다), 지정 실행기는
// 실행의 종류와 같은 종류의 주체이며(계약 v1의 주체 이름), 박자 처음에 읽은 줄과 종류·지정 실행기·실행 세대가 같다. 아니면 잘못 읽은
// 줄이다: 다른 실행기의 연결로 판정해 그쪽에 보내면 지정 실행기에는 닿지 않고 장부만 연장된다.
function writable(planned: RunRow, fresh: RunRow): boolean {
  const party = parsePrincipal(fresh.executorId)?.kind;
  const fits = party === (fresh.kind === "worker" ? "worker_executor" : "session_executor");
  return fits && fresh.runGeneration >= 1 && fresh.kind === planned.kind && fresh.executorId === planned.executorId && fresh.runGeneration === planned.runGeneration;
}

// 쓰기 직전의 다시 읽기. 박자 처음의 읽기 뒤에 다른 박자나 다른 쓰기가 갱신·취소·종료를 적었을 수 있다.
function reread(ports: LifeLoopPorts, planned: RunRow): Facts | { read: LifeRead } {
  const rows = readList(() => ports.ledger.listRuns());
  const run = rows === null ? undefined : indexRuns(rows)?.get(planned.runId);
  if (run === undefined || run === null || !writable(planned, run)) return { read: "runs" };
  const inputs = readList(() => ports.ledger.listInputs());
  if (inputs === null) return { read: "inputs" };
  return factsOf(ports.ledger, run, cancelIndex(inputs));
}

// 시작 접수의 긍정 증거: 실행 줄의 접수·시작 영수증 칸에 장부의 영수증 ID가 있다. 이 칸은 그 실행의 지정 실행기가 같은 세대로 낸
// 영수증만 채운다. preparing·running에서는 종료 지시가 없으므로(종료를 적으면 stopping으로 가고 돌아오지 않는다) 접수 영수증은 시작
// 지시의 것이다. 실행기는 시작의 실행 기록을 쓴 뒤에야 그 실행을 알므로, 그 전에 닿은 갱신은 모르는 실행으로 거절되고 장부만 연장된다.
const startAccepted = (run: RunRow): boolean => isUuid(run.acceptedReceiptId) || isUuid(run.startedReceiptId);

// 판단의 입력. lease는 장부가 끝을 아는 임대만 넘긴다("unknown", 지시 없음, 싣지 못한 갱신이 있는 실행은 null이고 판단은 조회로 간다).
// lastInstructionAt은 지금 상태가 기다리는 지시의 시각이다: stopping은 종료, 결과 쪽 상태는 확정. 그 밖의 상태에서 판단은 이 값을 쓰지 않는다.
function viewOf(facts: Facts, now: number, unsentRenews: ReadonlySet<string>): LifecycleView {
  const { run, times } = facts;
  const lease = unsentRenews.has(run.runId) ? null : (times?.lease ?? null);
  const known = lease !== null && typeof lease.expiresAt === "number" ? { issuedAt: lease.issuedAt, expiresAt: lease.expiresAt } : null;
  const lastInstructionAt = run.state === "stopping" ? (times?.lastStopAt ?? null) : ["checking", "ready_result", "failed_stopped", "cleanup_pending"].includes(run.state) ? (times?.lastFinalizeAt ?? null) : null;
  return {
    run: { runId: run.runId, kind: run.kind, state: run.state, deadlineAt: run.deadlineAt },
    lease: known,
    cancelRequested: facts.cancelRequested,
    lastInstructionAt,
    resultSettled: false,
    now,
  };
}

// 두 판단 입력이 시각 밖에서 같은가. 같으면 판단이 바뀐 까닭은 흐른 시간뿐이다.
function sameFacts(a: LifecycleView, b: LifecycleView): boolean {
  return (
    a.run.state === b.run.state &&
    a.run.deadlineAt === b.run.deadlineAt &&
    a.cancelRequested === b.cancelRequested &&
    a.lastInstructionAt === b.lastInstructionAt &&
    a.lease?.issuedAt === b.lease?.issuedAt &&
    a.lease?.expiresAt === b.lease?.expiresAt
  );
}

// 판단에 넘긴 값과 그 값으로 낸 의도.
interface Planned {
  facts: Facts;
  view: LifecycleView;
  intent: LifecycleIntent;
}

interface Context {
  ports: LifeLoopPorts;
  policy: LifecyclePolicy;
  now: number;
  stopGeneration: number;
  lastQueries: Map<string, number>;
  unsentRenews: ReadonlySet<string>;
  pendingQueries: PendingQuery[];
}

// 쓰기를 부른 뒤 답을 해석하다 던지면 박자는 멈추지만, 그 항목은 이 값으로 결과에 남는다. 값은 쓰기 전에 확보한 식별값으로만 만든다.
interface Trace {
  fallback: (() => RunOutcome) | null;
}

export async function lifeTick(ports: LifeLoopPorts, policy: LifecyclePolicy, input: LifeTickInput): Promise<LifeTickResult> {
  const key = ports.ledger;
  if (IN_FLIGHT.has(key)) return { kind: "not_run", reason: "tick_in_progress" };
  IN_FLIGHT.add(key);
  try {
    return await tickOnce(ports, policy, input);
  } finally {
    IN_FLIGHT.delete(key);
  }
}

async function tickOnce(ports: LifeLoopPorts, policy: LifecyclePolicy, input: LifeTickInput): Promise<LifeTickResult> {
  const now = readClock(ports, 1);
  if (now === null) return { kind: "not_run", reason: "clock_unavailable" };
  const memory = validMemory(input);
  if (memory === null) return { kind: "not_run", reason: "input_malformed" };
  let stopGeneration: unknown;
  try {
    stopGeneration = ports.intake.stopGeneration();
  } catch {
    stopGeneration = null;
  }
  // 정지 세대는 모든 지시와 조회의 머리에 싣는다. 모르면 종료도 적지 않는다(장부도 정지 기록이 없으면 stop_unknown이다).
  if (!Number.isSafeInteger(stopGeneration) || (stopGeneration as number) < 0) return { kind: "not_run", reason: "stop_generation_unknown" };
  const rows = readList(() => ports.ledger.listRuns());
  const runs = rows === null ? null : indexRuns(rows);
  if (runs === null) return { kind: "not_run", reason: "read_unknown", read: "runs" };
  const inputs = readList(() => ports.ledger.listInputs());
  if (inputs === null) return { kind: "not_run", reason: "read_unknown", read: "inputs" };
  const cancels = cancelIndex(inputs);

  // 쓰기 전의 읽기와 판단을 모든 실행에 먼저 한다. 정책이 틀려 판단이 던지면 어느 실행에도 쓰지 않는다.
  const plans: (Planned | RunOutcome)[] = [];
  for (const [runId, run] of runs) {
    if (run === null) {
      plans.push({ runId, outcome: "read_unknown", read: "runs" });
      continue;
    }
    if (DONE.includes(run.state)) continue;
    if (run.kind !== "worker") {
      plans.push({ runId, outcome: "not_worker" });
      continue;
    }
    const facts = factsOf(ports.ledger, run, cancels);
    if ("read" in facts) {
      plans.push({ runId, outcome: "read_unknown", read: facts.read });
      continue;
    }
    const view = viewOf(facts, now, memory.unsentRenews);
    let intent: LifecycleIntent;
    try {
      intent = nextIntent(view, policy);
    } catch {
      return { kind: "not_run", reason: "policy_rejected" };
    }
    plans.push({ facts, view, intent });
  }

  const ctx: Context = { ports, policy, now, stopGeneration: stopGeneration as number, ...memory, pendingQueries: [] };
  const outcomes: RunOutcome[] = [];
  // 장부에 쓰기가 한 번이라도 성공한 뒤에는 예외를 박자 밖으로 내지 않는다. 내면 이미 적은 갱신·취소의 결과를 부르는 쪽이 잃는다.
  for (const plan of plans) {
    if ("outcome" in plan) {
      outcomes.push(plan);
      continue;
    }
    const trace: Trace = { fallback: null };
    try {
      outcomes.push(await act(ctx, plan, trace));
    } catch {
      if (trace.fallback !== null) outcomes.push(trace.fallback());
      return { kind: "ran", runs: outcomes, pendingQueries: ctx.pendingQueries, halted: "threw", haltedAt: plan.facts.run.runId };
    }
  }
  return { kind: "ran", runs: outcomes, pendingQueries: ctx.pendingQueries, halted: null, haltedAt: null };
}

async function act(ctx: Context, plan: Planned, trace: Trace): Promise<RunOutcome> {
  const { run, times } = plan.facts;
  switch (plan.intent.intent) {
    case "wait":
      return { runId: run.runId, outcome: "wait" };
    case "finalize":
      return { runId: run.runId, outcome: "finalize_withheld" };
    case "query":
      return queryOne(ctx, run, "intent");
    case "renew_lease":
      return renewOne(ctx, plan, trace);
    case "stop":
      // 이미 종료 지시가 적힌 실행(stopping에서 끊겨 unknown_running이 된 실행)에 새 요청 ID의 종료를 또 적지 않는다.
      // 장부는 새 요청 ID면 받아 주므로 여기서 막는다. 앞 지시를 다시 보내는 것은 재전송 조각의 일이고, 이 박자는 같은 ID로 묻기만 한다.
      if (times !== null && times.lastStopAt !== null) return queryOne(ctx, run, "stop_already_recorded");
      return stopOne(ctx, plan, trace);
  }
}

async function renewOne(ctx: Context, plan: Planned, trace: Trace): Promise<RunOutcome> {
  const runId = plan.facts.run.runId;
  const withheld = (reason: RenewWithheld): RunOutcome => ({ runId, outcome: "renew_withheld", reason });
  if (!startAccepted(plan.facts.run)) return withheld("start_not_accepted");
  if (ctx.now + RENEW_MARGIN_MS > plan.facts.run.deadlineAt) return withheld("deadline_within_margin");
  // 요청 ID를 먼저 만든다. 마지막 시계 읽기부터 장부 호출까지 다른 포트를 부르면 그 사이 흐른 시간만큼 기록 시각이 낡는다.
  const requestId = freshUuid(ctx.ports.random);
  if (requestId === null) return { runId, outcome: "renew_failed", failure: "random_unavailable" };
  const fresh = reread(ctx.ports, plan.facts.run);
  if ("read" in fresh) return { runId, outcome: "read_unknown", read: fresh.read };
  if (!intakeOpen(ctx.ports.intake)) return withheld("intake_closed");
  // 기록 전에 연결이 지시를 낼 수 있는지 본다(ledger.md "기록 전에 mayIssue"). 끊긴 실행기에 적은 갱신은 장부만 연장한다.
  const link = linkVerdict(ctx.ports.links, fresh.run.executorId);
  if (link !== null) return withheld(link);
  const recordAt = readClock(ctx.ports, ctx.now);
  if (recordAt === null) return withheld("clock_unavailable");
  // 여기부터 장부 호출까지 포트를 부르지 않고 await도 없다. 다시 읽기부터 여기까지의 동기 포트(접수·연결·시계) 안에서 일어난 쓰기는
  // 막지 못한다(박자의 직렬화와 다른 쓰기와의 순서는 부르는 쪽의 조건이다).
  const view = viewOf(fresh, recordAt, ctx.unsentRenews);
  if (!startAccepted(fresh.run)) return withheld("start_not_accepted");
  // 실행기는 임대보다 작업 기한을 먼저 보므로, 기한이 기록 시각 + RENEW_MARGIN_MS보다 이르면 갱신이 닿기 전에 기한으로 끝날 수 있다.
  if (recordAt + RENEW_MARGIN_MS > fresh.run.deadlineAt) return withheld("deadline_within_margin");
  if (nextIntent(view, ctx.policy).intent !== "renew_lease") return sameFacts(plan.view, view) ? withheld("margin_lost") : { runId, outcome: "superseded", planned: "renew_lease" };
  // 앞 임대의 끝: 이 갱신을 기록하기 전에 장부가 믿은 끝. 판단이 갱신을 냈으므로 숫자다.
  const priorEnd = view.lease?.expiresAt as number;
  const { executorId, runGeneration, deadlineAt } = fresh.run;
  const stopGeneration = ctx.stopGeneration;
  const recordUnknown = (reason: RecordUnknown): RunOutcome => ({ runId, outcome: "renew_record_unknown", requestId, stopGeneration, issuedAt: recordAt, executorId, reason });
  let answer: unknown;
  try {
    answer = ctx.ports.ledger.recordRenewInstruction({ runId, requestId, stopGeneration, now: recordAt });
  } catch {
    return recordUnknown("threw");
  }
  trace.fallback = () => recordUnknown("threw");
  if (!isObject(answer)) return recordUnknown("malformed_answer");
  const ok: unknown = answer.ok;
  if (ok === false) {
    const reason: unknown = answer.reason;
    return isRefusal(reason) ? { runId, outcome: "renew_refused", reason } : recordUnknown("malformed_answer");
  }
  if (ok !== true) return recordUnknown("malformed_answer");

  // 여기부터 장부에는 갱신이 적혔다. 실패는 이 갱신의 식별값을 낸다(새 요청 ID로 다시 만들지 않는다).
  const notSentWith =
    (leaseUntil: number | null) =>
    (reason: NotSentReason, extra: { field?: string; sealReason?: string; delivery?: Delivery } = {}): RunOutcome => ({
      runId,
      outcome: "renew_recorded_not_sent",
      requestId,
      stopGeneration,
      issuedAt: recordAt,
      leaseUntil,
      executorId,
      reason,
      delivery: extra.delivery ?? "not_sent",
      ...(extra.field === undefined ? {} : { field: extra.field }),
      ...(extra.sealReason === undefined ? {} : { sealReason: extra.sealReason }),
    });
  trace.fallback = () => notSentWith(null)("ledger_answer_malformed");
  const answered: unknown = answer.leaseUntil;
  const leaseUntil = isTime(answered) ? answered : null;
  const notSent = notSentWith(leaseUntil);
  // 내보내기의 결과가 정해질 때까지 이 항목을 붙든다. 싣기를 부르기 전에 던지면 싣지 않았고, 부른 뒤에는 실렸는지 모른다.
  trace.fallback = () => notSent("draft_threw");
  let envelope: Envelope;
  try {
    const drafted = renewDraft({ run: { runId, runGeneration, executorId }, requestId, stopGeneration, now: recordAt, leaseUntil });
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
  // RENEW_MARGIN_MS가 남아야 싣는다. 작업 기한도 같은 여유가 남아야 한다(기록 뒤 처리가 길면 싣는 때에는 기한이 가깝거나 지났다).
  // 잰 뒤 포트를 부르기까지 await가 없다. 포트 안에서 실제로 싣기까지의 시간은 이 박자가 재지 못한다.
  const sendAt = readClock(ctx.ports, recordAt);
  if (sendAt === null) return notSent("clock_unavailable");
  if (Math.min(priorEnd, envelope.header.expires_at) - sendAt < RENEW_MARGIN_MS) return notSent("renew_margin_lost");
  if (deadlineAt - sendAt < RENEW_MARGIN_MS) return notSent("deadline_within_margin");
  trace.fallback = () => notSent("send_threw", { delivery: "unknown" });
  let sent: unknown;
  try {
    sent = await ctx.ports.sink.send(envelope);
  } catch {
    return notSent("send_threw", { delivery: "unknown" });
  }
  if (sent === "sent" && leaseUntil !== null) return { runId, outcome: "renew_sent", requestId, issuedAt: recordAt, leaseUntil, executorId };
  if (sent === "no_connection" || sent === "too_late_to_send") return notSent(sent);
  return notSent("send_answer_malformed", { delivery: "unknown" });
}

async function stopOne(ctx: Context, plan: Planned, trace: Trace): Promise<RunOutcome> {
  const runId = plan.facts.run.runId;
  const requestId = freshUuid(ctx.ports.random);
  if (requestId === null) return { runId, outcome: "stop_failed", failure: "random_unavailable" };
  const fresh = reread(ctx.ports, plan.facts.run);
  if ("read" in fresh) return { runId, outcome: "read_unknown", read: fresh.read };
  const recordAt = readClock(ctx.ports, ctx.now);
  if (recordAt === null) return { runId, outcome: "stop_failed", failure: "clock_unavailable" };
  // 여기부터 장부 호출까지 포트를 부르지 않고 await도 없다. 다시 읽은 것으로도 판단이 종료이고 그 사이 다른 쓰기가 종료를 적지 않았을
  // 때만 적는다(장부는 새 요청 ID의 종료를 또 받아 준다). 마지막 시계 읽기 안에서 일어난 외부 쓰기는 보지 못한다.
  if (nextIntent(viewOf(fresh, recordAt, ctx.unsentRenews), ctx.policy).intent !== "stop" || (fresh.times !== null && fresh.times.lastStopAt !== null)) {
    return { runId, outcome: "superseded", planned: "stop" };
  }
  // 판단은 취소 요청이나 기한이 지났을 때만 종료를 낸다. 둘 다면 소유자의 요청을 사유로 싣는다.
  const cancelReason: TaskCancelReason = fresh.cancelRequested ? "requested" : "deadline";
  const { executorId } = fresh.run;
  const stopGeneration = ctx.stopGeneration;
  const recordUnknown = (reason: RecordUnknown): RunOutcome => ({ runId, outcome: "stop_record_unknown", requestId, stopGeneration, issuedAt: recordAt, executorId, cancelReason, reason });
  let answer: unknown;
  try {
    // 사유를 늘 넘긴다. 빼고 적은 종료 지시는 장부가 본문을 다시 만들 수 없음으로 남기고, 같은 요청 ID로 나중에 채울 수도 없다.
    answer = ctx.ports.ledger.recordStopInstruction({ runId, requestId, action: "task_cancel", stopGeneration, now: recordAt, reason: cancelReason });
  } catch {
    return recordUnknown("threw");
  }
  trace.fallback = () => recordUnknown("threw");
  if (!isObject(answer)) return recordUnknown("malformed_answer");
  const ok: unknown = answer.ok;
  if (ok === false) {
    const reason: unknown = answer.reason;
    return isRefusal(reason) ? { runId, outcome: "stop_refused", reason } : recordUnknown("malformed_answer");
  }
  if (ok !== true) return recordUnknown("malformed_answer");

  // 여기부터 장부에는 종료가 적혔다(대기 실행이면 지시 없이 not_started로 닫혔다).
  const notSent = (reason: NotSentReason, extra: { field?: string; sealReason?: string; delivery?: Delivery } = {}): RunOutcome => ({
    runId,
    outcome: "stop_recorded_not_sent",
    requestId,
    stopGeneration,
    issuedAt: recordAt,
    executorId,
    cancelReason,
    reason,
    delivery: extra.delivery ?? "not_sent",
    ...(extra.field === undefined ? {} : { field: extra.field }),
    ...(extra.sealReason === undefined ? {} : { sealReason: extra.sealReason }),
  });
  const queued = fresh.run.state === "queued";
  trace.fallback = (): RunOutcome => (queued ? { runId, outcome: "closed_not_started" } : notSent("ledger_answer_malformed"));
  const run: unknown = answer.run;
  if (!isObject(run)) return notSent("ledger_answer_malformed");
  const { runId: answeredId, state, runGeneration, executorId: recipient } = run;
  // 내보내기의 결과가 정해질 때까지 이 항목을 붙든다(갱신과 같다).
  trace.fallback = () => notSent("draft_threw");
  if (answeredId !== runId) return notSent("ledger_answer_malformed");
  if (state === "not_started") return { runId, outcome: "closed_not_started" };
  if (!Number.isSafeInteger(runGeneration) || typeof recipient !== "string") return notSent("ledger_answer_malformed");
  let envelope: Envelope;
  try {
    const drafted = stopDraft({ action: "task_cancel", run: { runId, runGeneration: runGeneration as number, executorId: recipient }, requestId, stopGeneration, reason: cancelReason });
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
  trace.fallback = () => notSent("send_threw", { delivery: "unknown" });
  let sent: unknown;
  try {
    sent = await ctx.ports.sink.send(envelope);
  } catch {
    return notSent("send_threw", { delivery: "unknown" });
  }
  // 받는 쪽은 내보내기 전에 확보한 값이다. 포트가 넘겨받은 봉투를 고쳐도 결과를 읽다 던지지 않는다.
  if (sent === "sent") return { runId, outcome: "stop_sent", requestId, cancelReason, issuedAt: recordAt, executorId: recipient };
  if (sent === "no_connection" || sent === "too_late_to_send") return notSent(sent);
  return notSent("send_answer_malformed", { delivery: "unknown" });
}

// 같은 실행 ID의 상태 조회. 장부에 적지 않는다(지시 줄이 생기지 않는다). 요청 ID는 초안이 새로 만든다.
async function queryOne(ctx: Context, run: RunRow, cause: QueryCause): Promise<RunOutcome> {
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
  const at = readClock(ctx.ports, ctx.now);
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
  // 기다리는 조회와 봉투 시한은 내보내기 전에 확보한다(포트가 넘겨받은 봉투를 고쳐도 바뀌지 않는다).
  const pending: PendingQuery = { requestId: envelope.header.request_id, recipient: envelope.header.recipient, runIds: [runId] };
  const expiresAt = envelope.header.expires_at;
  let sent: unknown;
  let threw = false;
  try {
    sent = await ctx.ports.sink.send(envelope);
  } catch {
    threw = true;
  }
  if (!threw && (sent === "no_connection" || sent === "too_late_to_send")) return notSent(at, sent);
  // 실었거나 실렸을 수 있다. 답을 대조할 수 있게 시계를 읽기 전에 기다리는 조회에 넣는다(시계의 고장과 무관하다).
  ctx.pendingQueries.push(pending);
  // 조회의 간격은 실제로 실은 시각부터 센다. 포트가 돌아온 뒤에 읽은 시각은 실은 시각보다 이르지 않다. 그 시계를 읽지 못하면
  // 봉투 시한을 쓴다: 포트는 시한 뒤에 싣지 않으므로 실은 시각의 확실한 상한이다(봉한 시각으로 되돌리면 간격이 짧아진다).
  const loadedBy = readClock(ctx.ports, at) ?? expiresAt;
  if (threw) return notSent(loadedBy, "send_threw", { delivery: "unknown" });
  if (sent === "sent") return { runId, outcome: "query_sent", requestId: pending.requestId, executorId: pending.recipient, at: loadedBy, cause };
  return notSent(loadedBy, "send_answer_malformed", { delivery: "unknown" });
}
