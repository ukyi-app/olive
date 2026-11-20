// 실행기가 보낸 영수증·보고(연결의 forward 출력)를 장부 연산으로 옮기고, 장부가 받은 것에만 ack 초안을 만드는 처리기.
// 순수 판단이다: 소켓·타이머·시계·난수를 직접 쓰지 않는다. 장부는 포트로, 난수는 ackDraft에 넘기는 포트로, 시각은 인자로 받는다.
// ack는 초안까지만 만든다. 봉하기(sealDraft)와 싣기는 부르는 순환의 몫이다.
//
// 지키는 것:
// 1. 장부에 넘기는 from(낸 쪽, 실행 세대)은 검증된 봉투의 머리에서만 만든다. 본문의 값으로 대신하지 않는다.
//    지정 실행기·세대의 대조는 장부가 한다(이 모듈은 그 검사를 복사하지 않는다).
// 2. 장부가 ok를 돌려준 것에만, 장부가 돌려준 id로 ack 초안을 만든다. 거절·예외·꼴이 틀린 답이면 ack가 없어 실행기가 다시 보낸다.
//    장부가 duplicate를 돌려주면(이미 반영함) ack를 다시 만든다: 앞의 ack가 유실됐을 수 있다.
// 3. status_report는 감독이 낸 조회의 답이고 그 조회를 받은 실행기가 보냈을 때만 받는다. 운영 중에 그 답을 장부에 적는
//    공개 연산이 장부에 없어 대조까지만 하고 status_matched(장부 반영 없음)를 낸다.
// 4. 결과 보고(report_result)는 결과 보관(S6) 전에는 받지 않는다. 장부에 넘기지 않고 ack도 만들지 않는다.
import { REFUSALS as LEDGER_REFUSALS, type Delivery, type EnvelopeFrom, type Ledger, type ReceiptInput, type Refusal as LedgerRefusal, type ReportInput } from "../../ledger/index.ts";
import { ACTION_SPECS, isAction, type RunStatus, type Verified } from "../../contract/v1/index.ts";
import type { Output } from "../transport/connections.ts";
import { ackDraft, type Draft, type RefusalReason as DraftRefusalReason } from "./envelopes.ts";
import type { Random } from "./ports.ts";

// 장부 포트. 실제 장부(openLedger가 연 Ledger)가 그대로 맞는 꼴이다. 시험은 가짜로도 돌린다.
export type ReceiptLedger = Pick<Ledger, "applyReceipt" | "recordReport">;

export interface ReceiptPorts {
  readonly ledger: ReceiptLedger;
  // ack 초안의 요청 ID를 만드는 암호학적 난수(ports.ts의 Random).
  readonly random: Random;
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

export interface ForwardInput {
  // 연결 판단(connections.ts)의 forward 출력. verified는 계약 v1의 verifyEnvelope를 통과한 봉투다.
  readonly forward: Pick<Extract<Output, { kind: "forward" }>, "verified">;
  // 장부 기록에 넘길 지금 시각. 장부 시계와 같은 시계의 안전 정수 밀리초.
  readonly now: number;
  // ack 머리에 실을 감독의 지금 정지 세대(복원기의 stopGeneration()). null이면 모름이라 ack를 만들지 않는다.
  readonly stopGeneration: number | null;
  readonly pendingQueries: readonly PendingQuery[];
}

// 실행기 → 감독 동작마다 이 처리기가 하는 일. 계약 v1에서 받는 쪽이 감독인 동작 전부다(시험이 ACTION_SPECS와 대조한다).
export const EXECUTOR_ACTION_HANDLING = Object.freeze({
  receipt_accepted: "ledger_receipt",
  receipt_started: "ledger_receipt",
  receipt_stopped: "ledger_receipt",
  receipt_cleaned: "ledger_receipt",
  receipt_session_takeover: "ledger_receipt",
  report_session_broken: "ledger_report",
  report_hook_event: "ledger_report",
  // 결과 본문을 싣는 보고. 결과 보관(S6)을 거쳐야 장부의 storedRef를 채울 수 있다.
  report_result: "result_not_supported_yet",
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
] as const;
export type StatusUnmatchedReason = (typeof STATUS_UNMATCHED_REASONS)[number];

// ack 초안을 만들지 못한 이유. 장부는 이미 받았으므로 실행기가 다시 보내면 duplicate로 ack를 다시 만든다.
export type AckUnavailable = DraftRefusalReason | "stop_generation_unknown" | "draft_threw";

export type ReceiptOutcome =
  // 장부가 받았다(new: 이번에 반영, duplicate: 이미 반영). ack는 봉해서 낸 쪽에 싣는다.
  | { readonly outcome: "ack"; readonly action: string; readonly id: string; readonly delivery: Delivery; readonly ack: Draft<"ack"> }
  // 장부가 받았지만 ack 초안을 만들지 못했다.
  | { readonly outcome: "applied_without_ack"; readonly action: string; readonly id: string; readonly delivery: Delivery; readonly reason: AckUnavailable }
  // 장부가 거절했다. ack가 없다.
  | { readonly outcome: "ledger_refused"; readonly action: string; readonly id: string; readonly reason: LedgerRefusal }
  // 장부가 던졌거나 답이 꼴에 맞지 않는다. 받았는지 모르므로 ack가 없다(다시 오면 장부가 다시 가른다).
  | { readonly outcome: "ledger_failed"; readonly action: string; readonly id: string; readonly failure: "threw" | "malformed_answer" }
  // 기다리는 조회의 답이다. 장부에 반영하지 않았다(운영 중 상태 보고를 적는 장부 연산이 없다). ack는 없다(상태 보고는 id가 없다).
  | {
      readonly outcome: "status_matched";
      readonly queryRequestId: string;
      readonly executor: string;
      readonly runs: readonly RunStatus[];
      readonly ledger: "not_reflected";
    }
  | { readonly outcome: "status_unmatched"; readonly reason: StatusUnmatchedReason }
  // 결과 보고. 장부에 넘기지 않았고 ack가 없다.
  | { readonly outcome: "result_not_supported_yet"; readonly id: string; readonly runId: string }
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

type LedgerAnswer = { ok: true; delivery: Delivery; ack: string } | { ok: false; reason: LedgerRefusal };

// 장부의 답이 약속한 꼴인가. ok면 delivery가 둘 중 하나이고 ack id가 넘긴 id와 같아야 한다(다른 id의 ack는 다른 영수증의 재전송을 멈춘다).
function readAnswer(answer: unknown, id: string): LedgerAnswer | null {
  if (!isRecord(answer)) return null;
  if (answer.ok === true) {
    if ((answer.delivery !== "new" && answer.delivery !== "duplicate") || answer.ack !== id) return null;
    return { ok: true, delivery: answer.delivery, ack: answer.ack };
  }
  if (answer.ok === false && (LEDGER_REFUSALS as readonly unknown[]).includes(answer.reason)) return { ok: false, reason: answer.reason as LedgerRefusal };
  return null;
}

// 장부 반영 → ack 초안. 장부가 ok를 돌려준 뒤에만 ackDraft를 부른다(그 전에 초안이 만들어지는 길이 없다).
function settle(action: string, id: string, call: () => unknown, recipient: string, stopGeneration: number | null, random: Random): ReceiptOutcome {
  let raw: unknown;
  try {
    raw = call();
  } catch {
    return { outcome: "ledger_failed", action, id, failure: "threw" };
  }
  const answer = readAnswer(raw, id);
  if (answer === null) return { outcome: "ledger_failed", action, id, failure: "malformed_answer" };
  if (!answer.ok) return { outcome: "ledger_refused", action, id, reason: answer.reason };
  if (stopGeneration === null) return { outcome: "applied_without_ack", action, id, delivery: answer.delivery, reason: "stop_generation_unknown" };
  let drafted: ReturnType<typeof ackDraft>;
  try {
    drafted = ackDraft({ recipient, stopGeneration, ids: [answer.ack] }, random);
  } catch {
    return { outcome: "applied_without_ack", action, id, delivery: answer.delivery, reason: "draft_threw" };
  }
  if (!drafted.ok) return { outcome: "applied_without_ack", action, id, delivery: answer.delivery, reason: drafted.reason };
  return { outcome: "ack", action, id, delivery: answer.delivery, ack: drafted.draft };
}

function copyRuns(runs: readonly RunStatus[]): RunStatus[] {
  return runs.map((run) => ({ run_id: run.run_id, state: run.state, run_generation: run.run_generation, last_receipt_id: run.last_receipt_id }));
}

// 상태 보고를 기다리는 조회와 대조한다. 장부를 부르지 않는다.
function matchStatus(sender: string, body: Record<string, unknown>, pending: readonly PendingQuery[]): ReceiptOutcome {
  const inReplyTo = body.in_reply_to;
  const runs = body.runs;
  if (!isText(inReplyTo)) return reject("body_malformed", "in_reply_to");
  if (!Array.isArray(runs) || runs.some((run) => !isRecord(run) || !isText(run.run_id))) return reject("body_malformed", "runs");
  if (!Array.isArray(pending)) return reject("input_malformed", "pendingQueries");
  const query = pending.find((q) => isRecord(q) && q.requestId === inReplyTo);
  if (query === undefined) return { outcome: "status_unmatched", reason: "unknown_query" };
  if (query.recipient !== sender) return { outcome: "status_unmatched", reason: "other_executor" };
  const asked = new Set(Array.isArray(query.runIds) ? query.runIds : []);
  const answered = new Set((runs as RunStatus[]).map((run) => run.run_id));
  if (asked.size !== answered.size || [...answered].some((runId) => !asked.has(runId))) return { outcome: "status_unmatched", reason: "runs_mismatch" };
  return { outcome: "status_matched", queryRequestId: inReplyTo, executor: sender, runs: copyRuns(runs as RunStatus[]), ledger: "not_reflected" };
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
  if (handling === "status_reply") return matchStatus(header.sender, body, input.pendingQueries);

  const read = reader(body);
  try {
    if (handling === "result_not_supported_yet") return { outcome: "result_not_supported_yet", id: read.text("report_id"), runId: read.text("run_id") };
    if (!isTime(input.now)) return reject("input_malformed", "now");
    const from = envelopeFrom(header);
    const ledger = ports.ledger;
    if (handling === "ledger_receipt") {
      const receipt = receiptInput(action, read, header.body_digest, input.now);
      return settle(action, receipt.receiptId, () => ledger.applyReceipt(receipt, from), header.sender, input.stopGeneration, ports.random);
    }
    const report = reportInput(action as "report_session_broken" | "report_hook_event", read, header.body_digest, input.now);
    return settle(action, report.reportId, () => ledger.recordReport(report, from), header.sender, input.stopGeneration, ports.random);
  } catch (error) {
    if (error instanceof BodyFault) return reject("body_malformed", error.field);
    throw error;
  }
}
