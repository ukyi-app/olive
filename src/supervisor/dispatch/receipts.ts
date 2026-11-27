// 실행기가 보낸 영수증·보고(연결의 forward 출력)를 장부 연산으로 옮기고, 장부가 받은 것에만 ack 초안을 만드는 처리기.
// 순수 판단이다: 소켓·타이머·시계·난수를 직접 쓰지 않는다. 장부는 포트로, 난수는 ackDraft에 넘기는 포트로, 시각은 인자로 받는다.
// ack는 초안까지만 만든다. 봉하기(sealDraft)와 싣기는 부르는 순환의 몫이다.
//
// 지키는 것:
// 1. 장부에 넘기는 from(낸 쪽, 실행 세대)은 검증된 봉투의 머리에서만 만든다. 본문의 값으로 대신하지 않는다.
//    낸 쪽·세대의 대조는 장부가 한다(결과 보고만 본문을 맡기 전에 장부의 읽기로 먼저 본다). 일반 영수증·보고는 그 실행의 지정 실행기만,
//    세션 인수 영수증은 앞 세션 또는 대기 중인 세션 실행의 지정 실행기도 낼 수 있다(인수의 ack는 증거 저장의 확인일 뿐이다).
// 2. 장부가 ok를 돌려준 것에만, 장부가 돌려준 id로 ack 초안을 만든다. 거절·예외·꼴이 틀린 답이면 ack가 없어 실행기가 다시 보낸다.
//    장부가 duplicate를 돌려주면(이미 반영함) 정지 세대를 알고 초안 생성에 성공할 때 ack를 다시 만든다: 앞의 ack가 유실됐을 수 있다.
//    장부가 답에 실은 닫힌 실행의 경보(영수증의 alarm, 답의 alarms)는 결과에 옮기기만 한다. 경보 칸이 이상해도 ack·반영 결과는 그대로다.
// 3. status_report는 감독이 낸 조회의 답이고 그 조회를 받은 실행기가 그 조회를 실은 연결로 보냈을 때만 받는다. 대조된 답은
//    장부를 부를 때마다 그 직전에 그 답이 온 연결이 지금도 낸 쪽의 인정된 연결인지 보고, 맞을 때만 applyExecutorAnswer에
//    partial로 넘긴다. sender·runs·answeredAt은 검증된 봉투의 값이다.
//    그 실행기의 밀린 답(저장되지 않은 앞 답)이 있으면 받은 순서대로 먼저 넘기고, 앞 답이 저장되지 않으면 뒤 답은 넘기지 않는다.
//    인정이 끝난 연결의 "안다"는 답은 applyExecutorAnswer에 넘기지 않고, 부르기 직전에 연결을 다시 본 뒤 관측만 적는다(recordSighting).
//    적혔을 때만 그 사본을 놓는다.
// 4. 결과 보고(report_result)는 보관 → 장부 → ack 순서이고 세 걸음이 한 동기 흐름이다(await·이벤트 루프의 양보·지연 콜백의 예약이 없다. 넘긴 콜백은 그 자리에서 동기로 부른다).
//    보관소가 참조를 낸 뒤에만 장부에 적고, 장부가 받은 뒤에만 ack한다. 장부의 읽기로 먼저 걸러 보관소에 닿지 않는 것은 정해진
//    목록뿐이다(resultGate): 장부가 모르는 실행, 지정 실행기·세대가 다른 보고, 세션·queued·시작 지시가 없던 not_started 실행,
//    소유자가 없는 실행, 장부 읽기가 약속 밖의 값을 준 경우. 그 밖에 장부가 끝내 받지 않는 보고(판정이 끝난 실행의 맞지 않는 결과 등)는
//    본문부터 보관된다.
//    예외 하나: 관리자가 결과를 버린 실행(장부의 결과 포기 근거가 있는 실행, D-148)의 보고는 보관소에 넣지 않고 장부에 받은 기록만
//    적은 뒤(recordAbandonedReport) ack한다(D-169). 보관소 장애가 이어져도 그 보고는 ack로 끝난다.
import {
  type AnswerAlarm,
  type AnswerSightingsInput,
  type DeferredLoss,
  type Delivery,
  type EnvelopeFrom,
  LEDGER_RUN_STATES,
  REFUSALS as LEDGER_REFUSALS,
  type Ledger,
  type LedgerRunState,
  type LostRun,
  type ReceiptAlarm,
  type ReceiptInput,
  type Refusal as LedgerRefusal,
  type ReportInput,
  type RunKind,
  TRANSITIONS,
} from "../../ledger/index.ts";
import { ACTION_SPECS, isAction, parsePrincipal, type Result, resultDigest, type RunStatus, type Verified } from "../../contract/v1/index.ts";
import { type ResultBackend, resultBody, storeResult } from "../scheduler/result-store.ts";
import type { Output } from "../transport/connections.ts";
import { ackDraft, type Draft, type RefusalReason as DraftRefusalReason } from "./envelopes.ts";
import type { Random } from "./ports.ts";

// 장부 포트. 실제 장부(openLedger가 연 Ledger)가 그대로 맞는 꼴이다. 시험은 가짜로도 돌린다.
// recordAnswerSightings는 인정이 끝난 연결의 "안다"는 답에만 부른다(recordSighting). 임대·상태·자리를 바꾸지 않는 연산이다.
export type ReceiptLedger = Pick<Ledger, "applyReceipt" | "recordReport" | "applyExecutorAnswer" | "recordAnswerSightings">;

// 답이 온 연결이 지금도 그 실행기의 인정된 연결인가. 이 모듈은 연결 표를 들여다보지 않고 이 포트에만 묻는다.
// 조립은 부르는 순간에 쥔 연결 표와 지금의 복원기로 답한다(receipts.md "옛 연결의 답"). 동기여야 한다: 이 답과 장부 호출 사이에
// await가 없어야 그 사이에 연결이 바뀌지 않는다. 던지거나 true·false 밖의 답은 모름이고 장부를 부르지 않는다.
// 장부 호출마다 그 직전에 다시 묻는다: 앞선 장부 쓰기(저장 실패 등)가 같은 동기 구간에서 그 연결의 인정을 끝낼 수 있다.
export interface AnswerLinks {
  current(connection: number, executorId: string): boolean;
}

// connection 밖의 칸은 applyExecutorAnswer에 넘기는 값 그대로다. 다시 넘길 때 이 값을 바꾸지 않는다(now만 그때의 장부 시각이다).
// 상태 보고는 실행기가 다시 보내지 않으므로 저장되지 않은 답은 이 사본이 유일하다.
export interface ExecutorAnswerCopy {
  // 검증된 답 봉투의 낸 쪽.
  readonly sender: string;
  // 그 답이 온 연결(forward.connection). 장부에는 넘기지 않고, 넘기기 직전마다 이 연결이 아직 인정된 연결인지 links에 묻는다.
  readonly connection: number;
  // 조회의 답은 늘 partial이다. full(그 실행기가 쥔 전부)로 넘기는 길이 이 모듈에 없다.
  readonly coverage: "partial";
  // 검증된 본문의 runs(사본).
  readonly runs: readonly RunStatus[];
  // 답 봉투의 issued_at(실행기 시계). 꼴이 틀릴 때만 null이고 감독이 받은 시각으로 대신하지 않는다.
  readonly answeredAt: number | null;
}

// 관측만 적는 연산(recordAnswerSightings)에 넘기지 않은 까닭. no_positive: 안다는 항목이 없다(붙들 관측이 없다).
// now_malformed: 장부 시각이 꼴에 맞지 않는다. link_current: 부르기 직전에 본 연결이 지금 인정된 연결이다(그 답은 applyExecutorAnswer의 몫).
// link_unknown: 연결이 인정됐는지 모른다. backlog_first: 그 실행기의 앞 밀린 사본이 남아 있다(받은 차례로 적으려고 이 답은 목록 끝에 선다).
// output_mismatch: 인사 출력의 낸 쪽·서명 시각·목록이 그 연결의 인사와 다르다(연결 판단이 인정한 값이라고 믿을 수 없다).
export const SIGHTING_SKIPS = ["no_positive", "now_malformed", "link_current", "link_unknown", "backlog_first", "output_mismatch"] as const;
export type SightingSkip = (typeof SIGHTING_SKIPS)[number];

// 인정이 끝난 연결의 "안다"는 답을 관측만 적는 연산에 넘긴 결과. saved만 장부에 적혔다는 뜻이고, 그때만 부르는 쪽이 그 답의 사본을 놓는다.
// unsaved는 장부의 거절(reason·unsavedSightings 그대로), ledger_failed는 던짐이나 꼴이 틀린 답(적었는지 모른다)이다.
export type SightingOutcome =
  | { readonly sighting: "saved" }
  | { readonly sighting: "unsaved"; readonly reason: LedgerRefusal; readonly unsavedSightings: readonly { readonly runId: string; readonly runGeneration: number }[] }
  | { readonly sighting: "ledger_failed"; readonly failure: "threw" | "malformed_answer" }
  | { readonly sighting: "skipped"; readonly why: SightingSkip };

// 관측만 적을 답. 상태 보고의 사본(partial)과 인사(full) 모두 검증된 봉투의 값 그대로다(coverage도 바꾸지 않는다).
export interface SightingAnswer {
  readonly sender: string;
  readonly connection: number;
  readonly coverage: "full" | "partial";
  readonly runs: readonly RunStatus[];
  readonly answeredAt: number | null;
}

// 장부 답에 실린 닫힌 실행의 경보(D-127 영수증의 closed_run_started, D-128 답의 closed_run_running). 기록할 값일 뿐이고 ack·반영 결과를
// 가르지 않는다(조립이 감독 로그 한 줄로 낸다). unreadable: 경보 칸이 있지만 약속한 꼴이 아니거나 읽다 던졌다. 경보가 있었을 수 있어
// 버리지 않고 이 값으로 낸다(경보가 빠지는 쪽보다 남는 쪽). 실행 ID를 모르면 null이다.
export type LedgerAlarm =
  | { readonly alarm: ReceiptAlarm | AnswerAlarm; readonly runId: string }
  | { readonly alarm: "unreadable"; readonly runId: string | null };

// 답 하나를 장부에 넘긴 결과. 장부의 답을 지우거나 합치지 않는다.
export type AnswerSettlement =
  // 장부가 반영했다. moved: 임대를 거두고 unknown_running으로 옮긴 실행, deferred: not_known을 받고도 옮기지 않은 실행(같은 ID를
  // 다시 조회한다), outsideLedger: 장부 밖 실행(닫는 지시에만 쓰는 세대와 함께). alarms: 장부가 실은 경보. 없으면 칸이 없다.
  | {
      readonly settled: "applied";
      readonly answer: ExecutorAnswerCopy;
      readonly moved: readonly LostRun[];
      readonly deferred: readonly DeferredLoss[];
      readonly outsideLedger: readonly { readonly runId: string; readonly runGeneration: number }[];
      readonly alarms?: readonly LedgerAlarm[];
    }
  // 장부가 아무것도 적지 못했다. 반영된 것이 아니다.
  | {
      readonly settled: "unsaved";
      readonly answer: ExecutorAnswerCopy;
      readonly reason: LedgerRefusal;
      readonly unsavedSightings: readonly { readonly runId: string; readonly runGeneration: number }[];
    }
  // 장부가 던졌거나 답이 꼴에 맞지 않는다. 적었는지 모른다.
  | { readonly settled: "ledger_failed"; readonly answer: ExecutorAnswerCopy; readonly failure: "threw" | "malformed_answer" }
  // 넘기기 직전에 본 그 답의 연결이 지금 인정된 연결이 아니거나(not_current) 그것을 모른다(unknown). applyExecutorAnswer를 부르지 않았다.
  // sighting은 관측만 적는 연산의 결과다(not_current일 때만 부른다). saved가 아니고 안다는 항목이 있으면 그 사본은 backlog에 남는다.
  | { readonly settled: "not_current"; readonly answer: ExecutorAnswerCopy; readonly link: "not_current" | "unknown"; readonly sighting: SightingOutcome }
  // 앞의 밀린 답이 저장되지 않아 넘기지 않았다(받은 순서를 지킨다).
  | { readonly settled: "held"; readonly answer: ExecutorAnswerCopy };

export interface ReceiptPorts {
  readonly ledger: ReceiptLedger;
  // ack 초안의 요청 ID를 만드는 암호학적 난수(ports.ts의 Random).
  readonly random: Random;
  // 결과 보고에만 쓴다. 없으면 결과 보고는 보관도 장부 기록도 하지 않고 ack 없는 result_unknown(ports)이다(실행기가 다시 보낸다).
  // 선택 칸인 이유: 결과 보고 밖의 처리만 쓰는 쪽(상태 보고 대조 등)이 이 포트 없이 그대로 맞는다. 조립은 늘 넘긴다.
  readonly results?: ResultPorts;
}

// 결과 보고의 포트. 읽기(getRun, not_started일 때만 instructionTimes)와 쓰기(recordReport)를 같은 객체에서 부른다: 거른 그 장부에
// 적어야 거른 판단이 그 기록에 맞는다.
// 백엔드는 동기다(result-store.ts 머리 주석): 보관과 장부 기록 사이에 지연 실행과 이벤트 루프의 양보가 없다.
// resultAbandon·recordAbandonedReport는 결과를 버린 실행의 보고에 쓴다(ABANDONED_STATES의 실행에만 부른다). 선택 칸인 이유: 그 상태의
// 결과 보고까지 가지 않는 가짜 장부가 그대로 맞는다. 조립은 실제 장부를 넘겨 늘 있다. 그 상태의 보고인데 둘 중 하나라도 없으면 버린
// 실행인지 모르므로 보관하지 않고 ack 없는 result_unknown(ports)이다.
export interface ResultPorts {
  readonly backend: ResultBackend;
  readonly ledger: Pick<Ledger, "getRun" | "instructionTimes" | "recordReport"> & Partial<Pick<Ledger, "resultAbandon" | "recordAbandonedReport">>;
}

// 지금 답을 기다리는 상태 조회 하나. 부르는 쪽이 statusQueryDraft의 초안에서 보존한 값이다.
export interface PendingQuery {
  // 조회 봉투의 요청 ID(초안의 requestId). status_report의 in_reply_to가 이 값이어야 한다.
  readonly requestId: string;
  // 조회를 보낸 실행기의 주체 이름(초안의 recipient). 답은 이 주체가 서명한 것이어야 한다.
  readonly recipient: string;
  // 물은 실행 ID(초안 본문의 run_ids).
  readonly runIds: readonly string[];
}

// 기다리는 조회를 그 조회를 실제로 실은 연결에 묶은 항목. 답은 이 연결에서 와야 한다. 연결 번호는 싣는 쪽(내보내기 포트)만
// 안다: 수명 박자가 돌려주는 PendingQuery에는 없으므로 조립이 더한다(receipts.md "뒤 조각이 지킬 것").
export interface SentQuery extends PendingQuery {
  readonly connection: number;
}

export interface ForwardInput {
  // 연결 판단(connections.ts)의 forward 출력. verified는 계약 v1의 verifyEnvelope를 통과한 봉투, connection은 그 봉투가 온 연결이다.
  readonly forward: Pick<Extract<Output, { kind: "forward" }>, "verified" | "connection">;
  // 장부 기록에 넘길 지금 시각. 장부 시계와 같은 시계의 안전 정수 밀리초.
  readonly now: number;
  // ack 머리에 실을 감독의 지금 정지 세대(복원기의 stopGeneration()). null이면 모름이라 ack를 만들지 않는다.
  readonly stopGeneration: number | null;
  readonly pendingQueries: readonly SentQuery[];
  // status_report에서만, 대조된 뒤에 묻는다(장부 호출마다 그 직전에 다시).
  readonly links: AnswerLinks;
  // 그 status_report를 낸 실행기의 밀린 답(앞 결과의 backlog 그대로, 받은 순서). 대조되고 연결이 맞은 status_report에서만 읽는다.
  readonly backlog: readonly ExecutorAnswerCopy[];
}

export interface BacklogInput {
  // 한 실행기의 밀린 답(앞 결과의 backlog 그대로, 받은 순서).
  readonly backlog: readonly ExecutorAnswerCopy[];
  // 장부 기록에 넘길 지금 시각(장부 시계).
  readonly now: number;
  // 사본마다 그 답이 온 연결을 장부 호출 직전에 묻는다.
  readonly links: AnswerLinks;
}

export type BacklogOutcome =
  | { readonly outcome: "backlog_settled"; readonly settled: readonly AnswerSettlement[]; readonly backlog: readonly ExecutorAnswerCopy[] }
  | { readonly outcome: "rejected"; readonly reason: "input_malformed"; readonly field: string };

// 실행기 → 감독 동작마다 이 처리기가 하는 일. 계약 v1에서 받는 쪽이 감독인 동작 전부다(시험이 ACTION_SPECS와 대조한다).
export const EXECUTOR_ACTION_HANDLING = Object.freeze({
  receipt_accepted: "ledger_receipt",
  receipt_started: "ledger_receipt",
  receipt_stopped: "ledger_receipt",
  receipt_cleaned: "ledger_receipt",
  receipt_session_takeover: "ledger_receipt",
  report_session_broken: "ledger_report",
  report_hook_event: "ledger_report",
  // 결과 본문을 싣는 보고. 보관소가 낸 참조와 digest로만 장부의 storedRef·resultDigest를 채운다.
  report_result: "ledger_result",
  // 장부의 recordReport가 받는 꼴이 아니다(applyRuleCheck, 세션 계약의 증거). 이 처리기는 받지 않는다.
  report_rule_check: "rule_check_not_supported",
  status_report: "status_reply",
  // 연결 판단이 처리한다. forward로 오지 않는다.
  hello: "connection_layer",
  stop_sync_request: "connection_layer",
} as const);
export type ExecutorAction = keyof typeof EXECUTOR_ACTION_HANDLING;
export type Handling = (typeof EXECUTOR_ACTION_HANDLING)[ExecutorAction];

export const REJECT_REASONS = [
  // 계약 v1에 없는 동작 이름
  "unknown_action",
  // 감독이 내는 동작(지시 여섯, status_query, ack, stop_sync_reply). 실행기에서 올 수 없다
  "not_executor_action",
  // 연결 판단의 몫(hello, stop_sync_request)
  "connection_layer",
  // 장부의 recordReport가 받는 꼴이 아닌 보고(report_rule_check)
  "rule_check_not_supported",
  // forward·머리·now가 꼴에 맞지 않음
  "input_malformed",
  // 본문에서 읽는 칸이 꼴에 맞지 않음
  "body_malformed",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const STATUS_UNMATCHED_REASONS = [
  // in_reply_to가 기다리는 조회의 요청 ID가 아니다
  "unknown_query",
  // 그 조회를 받은 실행기가 아닌 주체가 서명했다
  "other_executor",
  // 답의 실행 ID 집합이 물은 실행 ID 집합과 다르다
  "runs_mismatch",
  // 그 조회를 실은 연결이 아닌 연결에서 왔다(조회 항목의 연결 번호가 없거나 꼴이 틀려도 이것이다)
  "other_connection",
] as const;
export type StatusUnmatchedReason = (typeof STATUS_UNMATCHED_REASONS)[number];

// 결과 보고를 장부에 넘기지 않은 확정된 이유. 어느 것도 ack가 없다.
export const RESULT_REFUSALS = [
  // 장부의 읽기로 먼저 본 것(보관소에 닿지 않았다)
  "unknown_run",
  "sender_mismatch",
  "run_generation_mismatch",
  // 세션 실행이거나 아직 대기(queued)인 실행. 장부가 결과 보고를 적은 적이 있을 수 없는 상태다
  "not_receivable",
  // 실행에 소유자(입력 요청 ID)가 없어 보관소가 받을 수 없다
  "no_owner",
  // 보관소의 판단이 거절한 것(본문을 남기지 않았다). conflict는 같은 실행에 다른 결과가 이미 보관돼 있다
  "conflict",
  "too_large",
  "digest_mismatch",
  "invalid_input",
] as const;
export type ResultRefusal = (typeof RESULT_REFUSALS)[number];

// ack 초안을 만들지 못한 이유. 장부는 이미 받았으므로 실행기가 다시 보내면 duplicate가 되고, 그때 정지 세대를 알고 초안 생성에 성공하면 ack한다.
export type AckUnavailable = DraftRefusalReason | "stop_generation_unknown" | "draft_threw";

export type ReceiptOutcome =
  // 장부가 받았다(new: 이번에 반영, duplicate: 이미 반영). ack는 봉해서 낸 쪽에 싣는다. alarm은 장부가 그 영수증의 답에 실은 경보이고
  // 없으면 칸이 없다(아래 둘 다).
  | { readonly outcome: "ack"; readonly action: string; readonly id: string; readonly delivery: Delivery; readonly ack: Draft<"ack">; readonly alarm?: LedgerAlarm }
  // 장부가 받았지만 ack 초안을 만들지 못했다.
  | { readonly outcome: "applied_without_ack"; readonly action: string; readonly id: string; readonly delivery: Delivery; readonly reason: AckUnavailable; readonly alarm?: LedgerAlarm }
  // 장부가 거절했다. ack가 없다.
  | { readonly outcome: "ledger_refused"; readonly action: string; readonly id: string; readonly reason: LedgerRefusal }
  // 장부가 던졌거나 답이 꼴에 맞지 않는다. 받았는지 모르므로 ack가 없다(다시 오면 장부가 다시 가른다).
  | { readonly outcome: "ledger_failed"; readonly action: string; readonly id: string; readonly failure: "threw" | "malformed_answer" }
  // 기다리는 조회의 답이고 지금 인정된 연결에서 왔다. 밀린 답과 이번 답을 받은 순서대로 장부에 넘긴 결과다(settled의 마지막이 이번 답).
  // backlog는 다음에 그 실행기의 어떤 답보다 먼저 넘길 답이다(비면 밀린 답이 없다). ack는 없다(상태 보고는 id가 없다).
  | {
      readonly outcome: "status_matched";
      readonly queryRequestId: string;
      readonly executor: string;
      readonly connection: number;
      readonly settled: readonly AnswerSettlement[];
      readonly backlog: readonly ExecutorAnswerCopy[];
    }
  // 기다리는 조회의 답이지만 그 연결이 지금 인정된 연결이 아니거나(not_current) 그것을 모른다(unknown). applyExecutorAnswer에 넘기지 않았다.
  // sighting은 관측만 적는 연산의 결과다. saved면 부르는 쪽은 이 답의 사본을 쥐지 않는다.
  | {
      readonly outcome: "status_not_current";
      readonly queryRequestId: string;
      readonly executor: string;
      readonly connection: number;
      readonly link: "not_current" | "unknown";
      readonly answer: ExecutorAnswerCopy;
      readonly sighting: SightingOutcome;
    }
  | { readonly outcome: "status_unmatched"; readonly reason: StatusUnmatchedReason }
  // 결과 보고를 장부에 넘기지 않았다(확정된 이유). ack가 없다.
  | { readonly outcome: "result_refused"; readonly id: string; readonly runId: string; readonly reason: ResultRefusal }
  // 결과 보고를 장부에 넘기지 않았다(모름: 포트가 없음, 장부를 읽지 못함, 보관이 unknown). ack가 없고 실행기가 다시 보낸다.
  | { readonly outcome: "result_unknown"; readonly id: string; readonly runId: string; readonly at: "ports" | "ledger_read" | "store" }
  | { readonly outcome: "rejected"; readonly reason: RejectReason; readonly field?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

const reject = (reason: RejectReason, field?: string): ReceiptOutcome => (field === undefined ? { outcome: "rejected", reason } : { outcome: "rejected", reason, field });

// 감독이 내는 동작(계약 v1의 방향 표). 실행기에서 온 forward에 있으면 안 된다.
const fromSupervisor = (action: string): boolean => isAction(action) && ACTION_SPECS[action].from.includes("supervisor");

// 검증된 머리의 값만으로 만든다. 본문의 칸은 읽지 않는다.
function envelopeFrom(header: Record<string, unknown>): EnvelopeFrom {
  return { sender: header.sender as string, runGeneration: header.run_generation as number };
}

// 본문 칸 읽기. 칸마다 타입만 보고(값의 꼴은 계약 검증과 장부가 다시 본다), 틀리면 그 칸 이름을 돌려준다.
type Reader = { text(name: string): string; time(name: string): number; nullableText(name: string): string | null };
class BodyFault {
  constructor(readonly field: string) {}
}
function reader(body: Record<string, unknown>): Reader {
  return {
    text(name) {
      const value = body[name];
      if (!isText(value)) throw new BodyFault(name);
      return value;
    },
    time(name) {
      const value = body[name];
      if (!isTime(value)) throw new BodyFault(name);
      return value;
    },
    nullableText(name) {
      const value = body[name];
      if (value === null) return null;
      if (!isText(value)) throw new BodyFault(name);
      return value;
    },
  };
}

// 영수증 본문 → 장부 입력. 장부 입력에 없는 본문 칸(started_at, stopped_at, remaining_processes, cleaned_at)은 넘기지 않는다.
function receiptInput(action: string, read: Reader, bodyDigest: string, now: number): ReceiptInput {
  switch (action) {
    case "receipt_accepted":
      return {
        action,
        receiptId: read.text("receipt_id"),
        runId: read.text("run_id"),
        instructionRequestId: read.text("instruction_request_id"),
        instruction: read.text("instruction") as Extract<ReceiptInput, { action: "receipt_accepted" }>["instruction"],
        bodyDigest,
        now,
      };
    case "receipt_started":
    case "receipt_cleaned":
      return { action, receiptId: read.text("receipt_id"), runId: read.text("run_id"), instructionRequestId: read.text("instruction_request_id"), bodyDigest, now };
    case "receipt_stopped":
      return {
        action,
        receiptId: read.text("receipt_id"),
        runId: read.text("run_id"),
        exit: read.text("exit") as Extract<ReceiptInput, { action: "receipt_stopped" }>["exit"],
        bodyDigest,
        now,
      };
    default:
      return {
        action: "receipt_session_takeover",
        receiptId: read.text("receipt_id"),
        previousRunId: read.text("previous_run_id"),
        newGenerationMarkerDigest: read.text("new_generation_marker_digest"),
        startPermitId: read.text("start_permit_id"),
        takenOverAt: read.time("taken_over_at"),
        bodyDigest,
        now,
      };
  }
}

// 훅·세션 깨짐 보고 → 장부 입력. 업무를 잇는 구조화 칸(signal)을 v1 본문에서 옮긴다(ledger.md "실제 연결"). 훅의 턴 ID는 prompt_id다.
function reportInput(action: "report_session_broken" | "report_hook_event", read: Reader, bodyDigest: string, now: number): ReportInput {
  const base = { reportId: read.text("report_id"), action, runId: read.text("run_id"), bodyDigest, storedRef: null, resultDigest: null, now };
  if (action === "report_session_broken") {
    return {
      ...base,
      signal: {
        kind: "session_broken",
        cause: read.text("cause") as Extract<NonNullable<ReportInput["signal"]>, { kind: "session_broken" }>["cause"],
        markerDigest: read.text("generation_marker_digest"),
        observedAt: read.time("observed_at"),
      },
    };
  }
  return {
    ...base,
    signal: {
      kind: "hook",
      event: read.text("event") as Extract<NonNullable<ReportInput["signal"]>, { kind: "hook" }>["event"],
      sessionId: read.text("session_id"),
      turnId: read.text("prompt_id"),
      stopFailure: read.nullableText("error") as Extract<NonNullable<ReportInput["signal"]>, { kind: "hook" }>["stopFailure"],
      observedAt: read.time("observed_at"),
    },
  };
}

// 결과 보고의 실행 줄에서 쓰는 칸. getRun의 답에서 칸마다 한 번만 읽어 옮긴다(getter가 두 번 다른 값을 내도 판단이 하나다).
// neverStarted는 not_started일 때만 instructionTimes로 읽는다(그 밖은 false).
interface ResultRunView {
  readonly executorId: string;
  readonly runGeneration: number;
  readonly kind: RunKind;
  readonly state: LedgerRunState;
  readonly inputRequestId: string | null;
  readonly neverStarted: boolean;
}

// 장부의 소유자(입력 요청 ID) 꼴. 장부·보관소와 같은 UUID 꼴이다.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isRunState = (value: unknown): value is LedgerRunState => (LEDGER_RUN_STATES as readonly unknown[]).includes(value);
// 실행 종류의 목록은 장부의 전이 표의 열쇠다.
const isRunKind = (value: unknown): value is RunKind => typeof value === "string" && Object.hasOwn(TRANSITIONS, value);

// 그 실행에 시작 지시가 한 번이라도 적혔는가. 읽지 못하거나 꼴이 틀리면 모름이다.
// 임대 묶음은 장부의 꼴(null, 또는 발행 시각과 시각이나 "unknown"인 끝)일 때만 시작 이력으로 친다. 배열·빈 객체·틀린 시각을
// 시작으로 치면 장부가 거절할 본문이 보관소에 남는다. 칸은 한 번씩만 읽는다(던지면 부르는 쪽이 모름으로 닫는다).
function readEverStarted(ledger: Pick<Ledger, "instructionTimes">, runId: string): boolean | "unknown" {
  const answer: unknown = ledger.instructionTimes(runId);
  if (!isRecord(answer) || answer.known !== true) return "unknown";
  const times: unknown = answer.value;
  if (!isRecord(times) || times.runId !== runId) return "unknown";
  const lease = times.lease;
  if (lease === null) return false;
  if (!isRecord(lease) || Array.isArray(lease)) return "unknown";
  const issuedAt = lease.issuedAt;
  const expiresAt = lease.expiresAt;
  return isTime(issuedAt) && (isTime(expiresAt) || expiresAt === "unknown") ? true : "unknown";
}

// 읽지 못함·꼴이 틀린 답·다른 실행의 줄·장부가 아는 목록과 꼴 밖의 값은 모름이다(보관소에 닿지 않는다).
// 판단에 쓰는 칸은 모두 여기서 도메인을 본다: 약속 밖의 값을 어느 갈래로도 읽지 않는다.
function readResultRun(ledger: Pick<Ledger, "getRun" | "instructionTimes">, runId: string): ResultRunView | null | "unknown" {
  try {
    const answer: unknown = ledger.getRun(runId);
    if (!isRecord(answer) || answer.known !== true) return "unknown";
    const run: unknown = answer.value;
    if (run === null) return null;
    if (!isRecord(run)) return "unknown";
    const view = { runId: run.runId, executorId: run.executorId, runGeneration: run.runGeneration, kind: run.kind, state: run.state, inputRequestId: run.inputRequestId };
    const owner = parsePrincipal(view.executorId)?.kind;
    if (view.runId !== runId || !isText(view.executorId) || (owner !== "worker_executor" && owner !== "session_executor")) return "unknown";
    if (!Number.isSafeInteger(view.runGeneration) || (view.runGeneration as number) < 0) return "unknown";
    if (!isRunKind(view.kind) || !isRunState(view.state)) return "unknown";
    if (view.inputRequestId !== null && !(typeof view.inputRequestId === "string" && UUID.test(view.inputRequestId))) return "unknown";
    let neverStarted = false;
    if (view.state === "not_started") {
      const started = readEverStarted(ledger, runId);
      if (started === "unknown") return "unknown";
      neverStarted = !started;
    }
    return { executorId: view.executorId, runGeneration: view.runGeneration as number, kind: view.kind, state: view.state, inputRequestId: view.inputRequestId, neverStarted };
  } catch {
    return "unknown";
  }
}

// 보관 전에 거른다. 장부가 이 보고를 받을 수 없고 앞서 받은 보고의 재전송일 수도 없음이 이 읽기만으로 확정되는 경우만 거절한다.
// - 실행·낸 쪽·세대: 장부의 recordReport가 이미 받은 id인지 보기 전에 보는 것과 같다(같은 보고의 재전송도 같은 답이다).
// - 세션 실행·queued: 장부는 그 실행의 결과 보고를 적은 적이 없으므로(재전송의 duplicate ack가 있을 수 없다) 새 보고도 적지 않는다.
// - 시작 지시가 한 번도 없던 not_started: queued에서 취소된 실행이다. queued 밖에서 not_started로 가려면 닫기 근거가 있어야 하고
//   닫기는 시작 지시가 정확히 하나인 실행만 닫는다(ledger.ts closeUnreceivedRun). 그래서 닫기 근거가 없고, queued와 근거 없는
//   not_started의 결과 보고는 장부가 늘 거절하므로 적힌 보고도 없다.
// 판정이 끝난 상태(ready_result·failed_stopped·cleanup_pending·finalized)와 시작 지시가 있던 not_started는 거르지 않는다: 그 실행에
// 앞서 적힌 보고가 있을 수 있어 같은 보고의 재전송은 장부가 duplicate로 ack해야 하고(그 id가 적혔는지 읽는 공개 읽기가 없다),
// not_started의 닫기 근거(늦은 첫 보고를 받는 조건)도 장부만 읽는다.
function resultGate(run: ResultRunView | null | "unknown", from: EnvelopeFrom): ResultRefusal | "unknown" | { readonly owner: string } {
  if (run === "unknown") return "unknown";
  if (run === null) return "unknown_run";
  if (run.executorId !== from.sender) return "sender_mismatch";
  if (run.runGeneration !== from.runGeneration) return "run_generation_mismatch";
  if (run.kind !== "worker" || run.state === "queued" || run.neverStarted) return "not_receivable";
  if (run.inputRequestId === null) return "no_owner";
  return { owner: run.inputRequestId };
}

// 결과를 버린 실행이 있을 수 있는 상태. 결과 포기는 checking을 failed_stopped로 옮기고(장부 판 9) 그 뒤로는 확정·정리(cleanup_pending·
// finalized)나 저장소 비움 닫기(not_started)로만 간다. 이 밖의 상태에는 포기 근거가 있을 수 없어 장부를 더 읽지 않는다.
const ABANDONED_STATES: readonly LedgerRunState[] = ["failed_stopped", "cleanup_pending", "finalized", "not_started"];

// 그 실행에 결과 포기 근거가 있는가. 포트가 없으면 ports, 읽지 못하거나 꼴이 틀리거나 다른 실행의 줄이면 모름이다(보관소에 닿지 않는다).
function readAbandoned(ledger: ResultPorts["ledger"], runId: string): boolean | "ports" | "unknown" {
  try {
    const read = ledger.resultAbandon;
    if (typeof read !== "function" || typeof ledger.recordAbandonedReport !== "function") return "ports";
    const answer: unknown = read.call(ledger, runId);
    if (!isRecord(answer) || answer.known !== true) return "unknown";
    const value: unknown = answer.value;
    if (value === null) return false;
    return isRecord(value) && value.runId === runId ? true : "unknown";
  } catch {
    return "unknown";
  }
}

// 결과 보고: 거르기 → 보관 → 장부 → ack. 셋 사이에 await·이벤트 루프의 양보·지연 콜백의 예약이 없다(이 함수와 storeResult·settle은
// 동기이고, settle은 넘겨받은 콜백을 그 자리에서 부른다).
// 장부가 보관 뒤에 거절하거나 모르면 ack가 없고 본문은 보관소에 남는다: 같은 보고가 다시 오면 storeResult가 같은 참조(created: false)를
// 내고 장부가 다시 가른다. 이 처리기는 지우지 않는다. 본문은 그 저장 참조를 가리키는 커밋된 보고가 장부에 하나도 없을 때만 고아다:
// 거절된 보고가 가리키는 자리도 앞서 받은 다른 보고가 이미 참조하고 있을 수 있다(같은 실행의 자리는 하나다).
function handleResult(action: string, header: Record<string, unknown>, read: Reader, body: Record<string, unknown>, input: ForwardInput, ports: ReceiptPorts): ReceiptOutcome {
  const reportId = read.text("report_id");
  const runId = read.text("run_id");
  const result: unknown = body.result;
  if (!isRecord(result)) throw new BodyFault("result");
  if (!isTime(input.now)) return reject("input_malformed", "now");
  const base = { id: reportId, runId };
  const results = ports.results;
  if (!isRecord(results) || !isRecord(results.backend) || !isRecord(results.ledger)) return { outcome: "result_unknown", ...base, at: "ports" };
  let bytes: Uint8Array;
  let digest: string;
  try {
    bytes = resultBody(result as Result);
    digest = resultDigest(result as Result);
  } catch {
    throw new BodyFault("result");
  }
  const from = envelopeFrom(header);
  const run = readResultRun(results.ledger, runId);
  const gate = resultGate(run, from);
  if (gate === "unknown") return { outcome: "result_unknown", ...base, at: "ledger_read" };
  if (typeof gate === "string" && gate !== "no_owner") return { outcome: "result_refused", ...base, reason: gate };
  // 결과를 버린 실행은 보관하지 않고 받은 기록만 적는다(D-169). 소유자보다 먼저 본다: 보관하지 않으니 소유자가 없어도 받는다.
  if (run !== null && run !== "unknown" && ABANDONED_STATES.includes(run.state)) {
    const abandoned = readAbandoned(results.ledger, runId);
    if (abandoned === "ports") return { outcome: "result_unknown", ...base, at: "ports" };
    if (abandoned === "unknown") return { outcome: "result_unknown", ...base, at: "ledger_read" };
    if (abandoned) {
      const record = results.ledger.recordAbandonedReport as Ledger["recordAbandonedReport"];
      const report = { reportId, runId, bodyDigest: header.body_digest as string, now: input.now };
      return settle(action, reportId, () => record.call(results.ledger, report, from), header.sender as string, input.stopGeneration, ports.random);
    }
  }
  if (typeof gate === "string") return { outcome: "result_refused", ...base, reason: gate };

  let stored: ReturnType<typeof storeResult>;
  try {
    stored = storeResult(results.backend, { runId, owner: gate.owner, digest, body: bytes, now: input.now });
  } catch {
    return { outcome: "result_unknown", ...base, at: "store" };
  }
  if (stored.status === "conflict") return { outcome: "result_refused", ...base, reason: "conflict" };
  if (stored.status === "rejected") return { outcome: "result_refused", ...base, reason: stored.reason };
  if (stored.status !== "stored") return { outcome: "result_unknown", ...base, at: "store" };

  const report: ReportInput = { reportId, action: "report_result", runId, bodyDigest: header.body_digest as string, storedRef: stored.ref, resultDigest: digest, signal: null, now: input.now };
  return settle(action, reportId, () => results.ledger.recordReport(report, from), header.sender as string, input.stopGeneration, ports.random);
}

type LedgerAnswer = { ok: true; delivery: Delivery; ack: string; alarm: LedgerAlarm | null } | { ok: false; reason: LedgerRefusal };

// 장부의 답이 약속한 꼴인가. ok면 delivery가 둘 중 하나이고 ack id가 넘긴 id와 같아야 한다(다른 id의 ack는 다른 영수증의 재전송을 멈춘다).
// 칸마다 한 번만 읽어 지역 값으로만 판단한다. 칸을 읽다 던지면 꼴이 틀린 답이고 그 예외의 문구는 버린다(본문이 실려 있을 수 있다).
// 경보 칸은 영수증의 답(alarmRunId가 그 실행)에서만 읽고, 그 칸 때문에 꼴이 틀린 답이 되지 않는다(receiptAlarm).
function readAnswer(answer: unknown, id: string, alarmRunId: string | null): LedgerAnswer | null {
  try {
    if (!isRecord(answer)) return null;
    const ok = answer.ok;
    if (ok === true) {
      const delivery = answer.delivery;
      const ack = answer.ack;
      if ((delivery !== "new" && delivery !== "duplicate") || ack !== id) return null;
      return { ok: true, delivery, ack, alarm: alarmRunId === null ? null : receiptAlarm(answer, alarmRunId) };
    }
    if (ok !== false) return null;
    const reason = answer.reason;
    return (LEDGER_REFUSALS as readonly unknown[]).includes(reason) ? { ok: false, reason: reason as LedgerRefusal } : null;
  } catch {
    return null;
  }
}

// applyReceipt 답의 경보 칸. 한 번만 읽고, 던지거나 약속 밖의 값이면 unreadable이다(ack는 그대로 만든다: 경보 때문에 ack를 막으면
// 실행기가 같은 영수증을 끝없이 다시 보낸다).
function receiptAlarm(answer: Record<string, unknown>, runId: string): LedgerAlarm | null {
  let value: unknown;
  try {
    value = answer.alarm;
  } catch {
    return { alarm: "unreadable", runId };
  }
  if (value === undefined) return null;
  return value === ("closed_run_started" satisfies ReceiptAlarm) ? { alarm: value, runId } : { alarm: "unreadable", runId };
}

// applyExecutorAnswer 답(ok)의 경보 칸을 결과에 옮길 꼴로 읽는다. 칸이 없거나 빈 배열이면 칸이 없다. 칸과 항목의 칸은 한 번씩만 읽고,
// 던지거나 항목 하나라도 약속한 꼴(closed_run_running, 비지 않은 runId, 1 이상의 세대)이 아니면 unreadable 하나로 낸다(어느 실행인지
// 모른다). 반영 결과는 가르지 않는다: 경보 때문에 반영을 실패로 세면 같은 답을 다시 넘기고 그 실행기의 뒤 답을 막는다.
export function readAnswerAlarms(answer: Record<string, unknown>): { readonly alarms?: readonly LedgerAlarm[] } {
  const unreadable = { alarms: [{ alarm: "unreadable", runId: null }] as const };
  try {
    const value = answer.alarms;
    if (value === undefined) return {};
    if (!Array.isArray(value)) return unreadable;
    const alarms: LedgerAlarm[] = [];
    for (const item of value as unknown[]) {
      if (!isRecord(item)) return unreadable;
      const alarm = item.alarm;
      const runId = item.runId;
      const runGeneration = item.runGeneration;
      if (alarm !== ("closed_run_running" satisfies AnswerAlarm) || !isText(runId) || !Number.isSafeInteger(runGeneration) || (runGeneration as number) < 1) return unreadable;
      alarms.push({ alarm, runId });
    }
    return alarms.length === 0 ? {} : { alarms };
  } catch {
    return unreadable;
  }
}

// 장부 반영 → ack 초안. 장부가 ok를 돌려준 뒤에만 ackDraft를 부른다(그 전에 초안이 만들어지는 길이 없다).
// alarmRunId는 영수증일 때 그 실행 ID이고(답의 경보 칸을 읽는다), 보고면 null이다(recordReport의 답에는 경보 칸이 없다).
function settle(action: string, id: string, call: () => unknown, recipient: string, stopGeneration: number | null, random: Random, alarmRunId: string | null = null): ReceiptOutcome {
  let raw: unknown;
  try {
    raw = call();
  } catch {
    return { outcome: "ledger_failed", action, id, failure: "threw" };
  }
  const answer = readAnswer(raw, id, alarmRunId);
  if (answer === null) return { outcome: "ledger_failed", action, id, failure: "malformed_answer" };
  if (!answer.ok) return { outcome: "ledger_refused", action, id, reason: answer.reason };
  const alarm = answer.alarm === null ? {} : { alarm: answer.alarm };
  if (stopGeneration === null) return { outcome: "applied_without_ack", action, id, delivery: answer.delivery, reason: "stop_generation_unknown", ...alarm };
  let drafted: ReturnType<typeof ackDraft>;
  try {
    drafted = ackDraft({ recipient, stopGeneration, ids: [answer.ack] }, random);
  } catch {
    return { outcome: "applied_without_ack", action, id, delivery: answer.delivery, reason: "draft_threw", ...alarm };
  }
  if (!drafted.ok) return { outcome: "applied_without_ack", action, id, delivery: answer.delivery, reason: drafted.reason, ...alarm };
  return { outcome: "ack", action, id, delivery: answer.delivery, ack: drafted.draft, ...alarm };
}

function copyRuns(runs: readonly RunStatus[]): RunStatus[] {
  return runs.map((run) => ({ run_id: run.run_id, state: run.state, run_generation: run.run_generation, last_receipt_id: run.last_receipt_id }));
}

// 상태 보고를 기다리는 조회와 대조한다. 장부를 부르지 않는다. 맞으면 조회의 요청 ID와 runs의 사본을 돌려준다.
function matchStatus(
  sender: string,
  body: Record<string, unknown>,
  pending: readonly SentQuery[],
  connection: unknown,
): ReceiptOutcome | { readonly queryRequestId: string; readonly runs: RunStatus[] } {
  const inReplyTo = body.in_reply_to;
  const runs = body.runs;
  if (!isText(inReplyTo)) return reject("body_malformed", "in_reply_to");
  if (!Array.isArray(runs) || runs.some((run) => !isRecord(run) || !isText(run.run_id))) return reject("body_malformed", "runs");
  if (!Array.isArray(pending)) return reject("input_malformed", "pendingQueries");
  // 같은 초안을 다른 연결로 다시 실으면 같은 요청 ID의 항목이 연결마다 있다. 답이 온 연결의 항목을 먼저 고른다.
  const asking = pending.filter((q) => isRecord(q) && q.requestId === inReplyTo);
  const query = asking.find((q) => q.connection === connection) ?? asking[0];
  if (query === undefined) return { outcome: "status_unmatched", reason: "unknown_query" };
  if (query.recipient !== sender) return { outcome: "status_unmatched", reason: "other_executor" };
  const asked = new Set(Array.isArray(query.runIds) ? query.runIds : []);
  const answered = new Set((runs as RunStatus[]).map((run) => run.run_id));
  if (asked.size !== answered.size || [...answered].some((runId) => !asked.has(runId))) return { outcome: "status_unmatched", reason: "runs_mismatch" };
  if (!Number.isSafeInteger(connection)) return reject("input_malformed", "forward.connection");
  // 답이 온 연결이 지금 인정된 연결이어도, 그 연결에 내지 않은 조회의 답은 받지 않는다: 같은 주체의 새 연결이 옛 연결에 낸
  // 조회에 답하면 지금 실행의 임대를 거둘 수 있다. 연결 번호가 없거나 꼴이 틀린 항목은 어느 연결과도 맞지 않는다.
  if (query.connection !== connection) return { outcome: "status_unmatched", reason: "other_connection" };
  return { queryRequestId: inReplyTo, runs: copyRuns(runs as RunStatus[]) };
}

function linkVerdict(links: AnswerLinks, connection: number, executorId: string): "current" | "not_current" | "unknown" {
  try {
    const answer: unknown = links.current(connection, executorId);
    if (answer === true) return "current";
    return answer === false ? "not_current" : "unknown";
  } catch {
    return "unknown";
  }
}

const isPositive = (run: RunStatus): boolean => run.state !== "not_known";

// 밀린 답 하나를 읽는다. 앞 결과의 사본이어야 하고 그 실행기(sender)의 것이어야 한다. 실행 항목의 꼴은 장부가 다시 본다.
// 연결 번호가 없는 사본은 넘기기 직전에 연결을 볼 수 없으므로 꼴이 틀린 것이다.
function readCopy(value: unknown, sender: string): ExecutorAnswerCopy | null {
  if (!isRecord(value) || value.sender !== sender || value.coverage !== "partial" || !Array.isArray(value.runs)) return null;
  if (!Number.isSafeInteger(value.connection)) return null;
  if (value.runs.some((run) => !isRecord(run) || !isText(run.run_id))) return null;
  if (value.answeredAt !== null && !isTime(value.answeredAt)) return null;
  return { sender, connection: value.connection as number, coverage: "partial", runs: copyRuns(value.runs as RunStatus[]), answeredAt: value.answeredAt as number | null };
}

function readBacklog(value: unknown, sender: string): ExecutorAnswerCopy[] | null {
  if (!Array.isArray(value)) return null;
  const copies = value.map((entry) => readCopy(entry, sender));
  return copies.some((copy) => copy === null) ? null : (copies as ExecutorAnswerCopy[]);
}

const isPair = (item: unknown): boolean => isRecord(item) && isText(item.runId) && Number.isSafeInteger(item.runGeneration);

const DEFERRED_WHY: readonly unknown[] = ["start_may_arrive", "answer_time_unknown"] as const satisfies readonly DeferredLoss["why"][];
// 보류는 "같은 실행 ID를 다시 조회하라"는 뜻이라 꼴이 틀린 보류를 성공으로 세면 양성 사본을 버리고도 반영된 것으로 보인다.
// 사유는 장부가 정한 두 값, 상태는 장부의 실행 상태, 세대는 1 이상만 받는다.
const isDeferred = (item: unknown): boolean =>
  isPair(item) &&
  isRecord(item) &&
  (item.runGeneration as number) >= 1 &&
  (LEDGER_RUN_STATES as readonly unknown[]).includes(item.state) &&
  DEFERRED_WHY.includes(item.why);

const skipped = (why: SightingSkip): SightingOutcome => ({ sighting: "skipped", why });

// recordAnswerSightings의 답이 약속한 꼴인가. 칸마다 한 번만 읽는다. 칸을 읽다 던지는 값도 꼴이 틀린 답이다(적었는지 모른다).
function readSightingAnswer(answer: unknown): SightingOutcome {
  const malformed: SightingOutcome = { sighting: "ledger_failed", failure: "malformed_answer" };
  try {
    if (!isRecord(answer)) return malformed;
    const ok = answer.ok;
    if (ok === true) return { sighting: "saved" };
    if (ok !== false) return malformed;
    const reason = answer.reason;
    if (!(LEDGER_REFUSALS as readonly unknown[]).includes(reason)) return malformed;
    const unsaved = answer.unsavedSightings;
    if (!Array.isArray(unsaved)) return malformed;
    const pairs: { runId: string; runGeneration: number }[] = [];
    for (const item of unsaved as unknown[]) {
      if (!isRecord(item)) return malformed;
      const runId = item.runId;
      const runGeneration = item.runGeneration;
      if (!isText(runId) || !Number.isSafeInteger(runGeneration)) return malformed;
      pairs.push({ runId, runGeneration: runGeneration as number });
    }
    return { sighting: "unsaved", reason: reason as LedgerRefusal, unsavedSightings: pairs };
  } catch {
    return malformed;
  }
}

// 인정이 끝난 연결의 "안다"는 답에서 양성 관측만 장부에 적는다(recordAnswerSightings). 임대·상태·자리는 바꾸지 않는다.
// 부르는 쪽은 그 답의 연결이 인정된 연결이 아니라고 본(not_current) 뒤에만 부른다. 장부는 연결을 보지 않고 sender를 믿으므로,
// 연산을 얻고 입력을 만든 뒤 부르기 직전에 연결을 한 번 더 보고 그 사이에 외부 코드를 두지 않는다. 연결이 지금 인정된 연결이면
// (그 답은 applyExecutorAnswer의 몫) 또는 모르면 부르지 않는다. 장부는 (실행, 실행기, 세대)의 첫 관측만 적으므로 다시 불러도 해가 없다.
// 함정: 이 연산의 성공을 닫기의 근거로 쓰지 않는다. 목록에 없는 실행을 보지 않는다(ledger.md "관측만 적는 연산을 부르는 쪽").
export function recordSighting(answer: SightingAnswer, ledger: Pick<ReceiptLedger, "recordAnswerSightings">, links: AnswerLinks, now: number): SightingOutcome {
  if (!answer.runs.some(isPositive)) return skipped("no_positive");
  if (!isTime(now)) return skipped("now_malformed");
  // 수신자를 문 앞에서 묶어 둔다: 문 뒤에는 묶은 함수 하나를 부를 뿐 속성을 읽지 않는다. 묶기도 함수의 bind를 읽어 부르므로 던질 수 있다.
  let call: (input: AnswerSightingsInput, from: { sender: string }) => unknown;
  try {
    const record: unknown = ledger.recordAnswerSightings;
    if (typeof record !== "function") return { sighting: "ledger_failed", failure: "threw" };
    call = (record as (input: AnswerSightingsInput, from: { sender: string }) => unknown).bind(ledger);
  } catch {
    return { sighting: "ledger_failed", failure: "threw" };
  }
  // 장부에는 사본의 사본을 넘긴다(장부가 받은 배열을 고쳐도 쥔 사본은 그대로다).
  const input: AnswerSightingsInput = { coverage: answer.coverage, runs: copyRuns(answer.runs), answeredAt: answer.answeredAt, now };
  const from = { sender: answer.sender };
  const link = linkVerdict(links, answer.connection, answer.sender);
  if (link !== "not_current") return skipped(link === "current" ? "link_current" : "link_unknown");
  let raw: unknown;
  try {
    raw = call(input, from);
  } catch {
    return { sighting: "ledger_failed", failure: "threw" };
  }
  return readSightingAnswer(raw);
}

// 장부의 applyExecutorAnswer 답이 약속한 꼴인가. 칸을 읽다 던지는 값도 꼴이 틀린 답이다.
function readExecutorAnswer(answer: unknown, copy: ExecutorAnswerCopy): AnswerSettlement | null {
  try {
    if (!isRecord(answer)) return null;
    if (answer.ok === true) {
      const { moved, deferred, outsideLedger } = answer;
      if (!Array.isArray(moved) || !moved.every((m) => isPair(m) && isText(m.before) && isText(m.after))) return null;
      if (!Array.isArray(deferred) || !deferred.every(isDeferred)) return null;
      if (!Array.isArray(outsideLedger) || !outsideLedger.every(isPair)) return null;
      return {
        settled: "applied",
        answer: copy,
        moved: moved.map((m) => ({ runId: m.runId, runGeneration: m.runGeneration, before: m.before, after: m.after })),
        deferred: deferred.map((d) => ({ runId: d.runId, runGeneration: d.runGeneration, state: d.state, why: d.why })),
        outsideLedger: outsideLedger.map((o) => ({ runId: o.runId, runGeneration: o.runGeneration })),
        ...readAnswerAlarms(answer),
      };
    }
    if (answer.ok !== false || !(LEDGER_REFUSALS as readonly unknown[]).includes(answer.reason)) return null;
    const unsaved = answer.unsavedSightings;
    if (!Array.isArray(unsaved) || !unsaved.every(isPair)) return null;
    return { settled: "unsaved", answer: copy, reason: answer.reason as LedgerRefusal, unsavedSightings: unsaved.map((u) => ({ runId: u.runId, runGeneration: u.runGeneration })) };
  } catch {
    return null;
  }
}

// 답 하나를 장부에 넘긴다. 장부에는 사본의 사본을 넘긴다(장부가 받은 배열을 고쳐도 다시 넘길 사본은 그대로다).
function passAnswer(copy: ExecutorAnswerCopy, ledger: Pick<ReceiptLedger, "applyExecutorAnswer">, now: number): AnswerSettlement {
  let raw: unknown;
  try {
    raw = ledger.applyExecutorAnswer({ coverage: copy.coverage, runs: copyRuns(copy.runs), answeredAt: copy.answeredAt, now }, { sender: copy.sender });
  } catch {
    return { settled: "ledger_failed", answer: copy, failure: "threw" };
  }
  return readExecutorAnswer(raw, copy) ?? { settled: "ledger_failed", answer: copy, failure: "malformed_answer" };
}

// 한 실행기의 답들을 받은 순서대로 넘긴다. 저장을 확인하지 못한 답에 not_known 밖 항목이 있으면 그 답부터 뒤의 답 전부를
// 넘기지 않고 backlog로 돌려준다: 다시 넘길 때 그 답이 뒤 답보다 먼저여야 "안다고 한 적이 있다"가 뒤 답에 묻히지 않는다.
// not_known만 실은 답의 실패는 붙들 관측이 없어 backlog에 넣지 않는다(부르는 쪽은 그 실행을 다시 조회한다).
// 다시 넘기는 것은 같은 값이라 겹쳐도 해가 없다: 장부는 첫 관측만 적고, 이미 옮긴 실행은 다시 옮기지 않는다.
function settleInOrder(queue: readonly ExecutorAnswerCopy[], ledger: Pick<ReceiptLedger, "applyExecutorAnswer" | "recordAnswerSightings">, links: AnswerLinks, now: number) {
  const settled: AnswerSettlement[] = [];
  const backlog: ExecutorAnswerCopy[] = [];
  for (const copy of queue) {
    if (backlog.length > 0) {
      settled.push({ settled: "held", answer: copy });
      backlog.push(copy);
      continue;
    }
    // 장부를 부를 때마다 그 직전에 본다. 밀린 사본의 연결은 받은 뒤 닫혔을 수 있고, 같은 루프의 앞선 장부 쓰기가 실패하며
    // 그 연결의 인정을 끝낼 수 있다(await가 없어도 바뀐다). 인정이 끝난 연결의 답은 임대를 바꾸지 못한다.
    const link = linkVerdict(links, copy.connection, copy.sender);
    if (link !== "current") {
      // 인정이 끝난 연결의 답은 임대를 바꾸지 못한다. 안다는 항목은 관측만 적는 연산으로 남기고, 적혔을 때만 사본을 놓아 뒤 답을 푼다.
      // 적지 못했거나 연결을 모르면 버리지 않는다: 그 사본 뒤에 뒤 답이 막힌다(막힌 동안 임대를 거두지 못한다: 닫는 쪽이다).
      const sighting = link === "not_current" ? recordSighting(copy, ledger, links, now) : skipped("link_unknown");
      settled.push({ settled: "not_current", answer: copy, link, sighting });
      if (copy.runs.some(isPositive) && sighting.sighting !== "saved") backlog.push(copy);
      continue;
    }
    const result = passAnswer(copy, ledger, now);
    settled.push(result);
    if (result.settled !== "applied" && copy.runs.some(isPositive)) backlog.push(copy);
  }
  return { settled, backlog };
}

// 인정이 끝난 연결의 조회 답(status_not_current)을 관측만 적는다. 그 실행기의 밀린 사본이 남아 있으면 부르지 않는다: 부르는 쪽이 이 답을
// 목록 끝에 두고 앞 사본 다음 차례에 적는다(받은 차례). 밀린 목록을 읽지 못하면 남은 것으로 본다.
function notCurrentSighting(input: ForwardInput, answer: ExecutorAnswerCopy, link: "not_current" | "unknown", ledger: ReceiptLedger): SightingOutcome {
  if (link !== "not_current") return skipped("link_unknown");
  if (!answer.runs.some(isPositive)) return skipped("no_positive");
  if (!Array.isArray(input.backlog) || input.backlog.length !== 0) return skipped("backlog_first");
  return recordSighting(answer, ledger, input.links, input.now);
}

function handleStatus(input: ForwardInput, sender: string, issuedAt: unknown, body: Record<string, unknown>, ledger: ReceiptLedger): ReceiptOutcome {
  const matched = matchStatus(sender, body, input.pendingQueries, input.forward.connection);
  if ("outcome" in matched) return matched;
  const connection = input.forward.connection;
  const answer: ExecutorAnswerCopy = { sender, connection, coverage: "partial", runs: matched.runs, answeredAt: isTime(issuedAt) ? issuedAt : null };
  const base = { queryRequestId: matched.queryRequestId, executor: sender, connection };
  // 연결 판단이 forward를 낸 뒤 그 연결이 밀려났거나 닫혔으면 그 답은 지금 실행의 임대를 바꾸지 못한다. 여기서 먼저 보고(밀린 답도
  // 넘기지 않는다), 넘기는 루프가 장부 호출마다 다시 본다.
  const link = linkVerdict(input.links, connection, sender);
  if (link !== "current") return { outcome: "status_not_current", ...base, link, answer, sighting: notCurrentSighting(input, answer, link, ledger) };
  if (!isTime(input.now)) return reject("input_malformed", "now");
  const backlog = readBacklog(input.backlog, sender);
  if (backlog === null) return reject("input_malformed", "backlog");
  const result = settleInOrder([...backlog, answer], ledger, input.links, input.now);
  return { outcome: "status_matched", ...base, settled: result.settled, backlog: result.backlog };
}

// 새 답 없이 한 실행기의 밀린 답을 받은 순서대로 다시 넘긴다. 처리는 handleForward의 status_report와 같다(사본마다 그 답이 온
// 연결을 장부 호출 직전에 links에 묻는다). 입력을 바꾸지 않는다.
export function replayBacklog(input: BacklogInput, ports: { readonly ledger: Pick<ReceiptLedger, "applyExecutorAnswer" | "recordAnswerSightings"> }): BacklogOutcome {
  if (!isRecord(input) || !Array.isArray(input.backlog)) return { outcome: "rejected", reason: "input_malformed", field: "backlog" };
  if (input.backlog.length === 0) return { outcome: "backlog_settled", settled: [], backlog: [] };
  const first: unknown = input.backlog[0];
  const backlog = isRecord(first) && isText(first.sender) ? readBacklog(input.backlog, first.sender) : null;
  if (backlog === null) return { outcome: "rejected", reason: "input_malformed", field: "backlog" };
  if (!isTime(input.now)) return { outcome: "rejected", reason: "input_malformed", field: "now" };
  return { outcome: "backlog_settled", ...settleInOrder(backlog, ports.ledger, input.links, input.now) };
}

// forward 하나를 처리한다. 입력을 바꾸지 않는다.
export function handleForward(input: ForwardInput, ports: ReceiptPorts): ReceiptOutcome {
  if (!isRecord(input) || !isRecord(input.forward)) return reject("input_malformed", "forward");
  const verified = input.forward.verified as Verified | undefined;
  if (!isRecord(verified) || verified.ok !== true) return reject("input_malformed", "verified");
  const header = verified.header as unknown;
  if (!isRecord(header) || header.action !== verified.action) return reject("input_malformed", "header");
  if (!isText(header.sender)) return reject("input_malformed", "header.sender");
  if (!Number.isSafeInteger(header.run_generation) || (header.run_generation as number) < 0) return reject("input_malformed", "header.run_generation");
  if (!isText(header.body_digest)) return reject("input_malformed", "header.body_digest");
  const action = verified.action as string;
  if (!Object.hasOwn(EXECUTOR_ACTION_HANDLING, action)) return reject(fromSupervisor(action) ? "not_executor_action" : "unknown_action");
  const handling = EXECUTOR_ACTION_HANDLING[action as ExecutorAction];
  if (handling === "connection_layer") return reject("connection_layer");
  if (handling === "rule_check_not_supported") return reject("rule_check_not_supported");
  const body = verified.body as unknown;
  if (!isRecord(body)) return reject("body_malformed", "body");
  if (handling === "status_reply") return handleStatus(input, header.sender, header.issued_at, body, ports.ledger);

  const read = reader(body);
  try {
    if (handling === "ledger_result") return handleResult(action, header, read, body, input, ports);
    if (!isTime(input.now)) return reject("input_malformed", "now");
    const from = envelopeFrom(header);
    const ledger = ports.ledger;
    if (handling === "ledger_receipt") {
      const receipt = receiptInput(action, read, header.body_digest, input.now);
      const runId = receipt.action === "receipt_session_takeover" ? receipt.previousRunId : receipt.runId;
      return settle(action, receipt.receiptId, () => ledger.applyReceipt(receipt, from), header.sender, input.stopGeneration, ports.random, runId);
    }
    const report = reportInput(action as "report_session_broken" | "report_hook_event", read, header.body_digest, input.now);
    return settle(action, report.reportId, () => ledger.recordReport(report, from), header.sender, input.stopGeneration, ports.random);
  } catch (error) {
    if (error instanceof BodyFault) return reject("body_malformed", error.field);
    throw error;
  }
}
