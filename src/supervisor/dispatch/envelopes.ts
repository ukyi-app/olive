// 장부에 적힌 지시를 계약 v1 봉투로 만드는 순수 함수. 장부를 열거나 쓰지 않고, 시각은 인자로, 난수와 서명은 포트로만 받는다.
// 만들기는 두 단계다.
// 1. 초안(Draft): 지시 기록에서 정해지는 것(받는 쪽, 요청 ID, 세대, 본문, 장부가 정한 발행 시각). 같은 기록이면 같은 초안이다.
// 2. 봉하기(sealDraft): 초안에 이번 nonce와 시각을 붙여 서명한다. 같은 초안을 다시 봉하면 요청 ID와 본문 digest가 같은
//    새 봉투다(재전송). 계약 v1은 nonce를 한 번만 받으므로(replayed) 봉투를 그대로 다시 보내지 않는다.
// 입력이 모자라거나 받는 쪽이 거절할 값이면 봉투를 만들지 않고 구별된 거절을 낸다. 값을 지어내지 않는다.
import {
  ACTION_SPECS,
  type Bodies,
  CONTRACT,
  canonicalJson,
  digestOf,
  type Envelope,
  type Header,
  limits,
  parsePrincipal,
  type RejectReason,
  ROLES,
  SealError,
  type SealInput,
} from "../../contract/v1/index.ts";
import type { Run } from "../../ledger/index.ts";
import type { Random, Signer } from "./ports.ts";

export const SUPERVISOR = "supervisor";

// 이 모듈이 만드는 감독의 메시지. 감독이 내는 v1 동작 가운데 session_start(세션 계약, 장부가 닫아 둠)와
// stop_sync_reply(연결의 첫 단계, challenge를 받은 연결이 답함)는 여기서 만들지 않는다.
export const DRAFT_ACTIONS = ["task_start", "run_renew", "task_cancel", "session_stop", "result_finalize", "status_query", "ack"] as const;
export type DraftAction = (typeof DRAFT_ACTIONS)[number];

// 장부가 정한 발행 시각을 그대로 싣는 동작. 봉하는 때의 now로 채우지 않는다(sealDraft).
const PINNED_ACTIONS: readonly DraftAction[] = ["task_start", "run_renew"];
type PinnedAction = "task_start" | "run_renew";

interface DraftOf<A extends DraftAction> {
  action: A;
  // 받는 실행기의 주체 이름(장부의 executorId).
  recipient: string;
  requestId: string;
  // 계약 v1의 머리 꼴: 정지 세대는 0 이상의 안전 정수. 실행 세대는 실행에 묶인 지시(ACTION_SPECS의 runField)면 1 이상, 조회·ack는 0.
  stopGeneration: number;
  runGeneration: number;
  body: Bodies[A];
  // 장부가 정한 발행 시각. 시작·갱신은 꼭 있어야 하고(없으면 만들지도 봉하지도 않는다) 다시 봉해도 바뀌지 않는다.
  // 나머지 동작은 null이면 봉하는 때의 now를 쓴다.
  issuedAt: A extends PinnedAction ? number : number | null;
}
export type Draft<A extends DraftAction = DraftAction> = { [K in A]: DraftOf<K> }[A];

export const REFUSAL_REASONS = [
  // 초안: 장부 기록이나 부르는 쪽의 입력이 모자라거나 꼴이 틀림
  "input_malformed",
  "missing_field",
  "issued_at_unknown",
  "stop_generation_invalid",
  "run_generation_invalid",
  "lease_unknown",
  "not_worker_run",
  "recipient_invalid",
  "role_mismatch",
  "budget_exhausted",
  "lease_out_of_range",
  "deadline_not_after_issue",
  "run_ids_invalid",
  "ids_invalid",
  "random_unavailable",
  // 봉하기: 이번 시각과 포트
  "bad_time",
  "issued_in_future",
  "deadline_passed",
  "deadline_too_close",
  "too_late_to_send",
  "seal_refused",
  "signer_mismatch",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

// field는 missing_field·input_malformed의 칸 이름, sealReason은 seal_refused의 계약 사유다.
export type Refusal = { ok: false; reason: RefusalReason; field?: string; sealReason?: RejectReason };
export type Drafted<A extends DraftAction> = { ok: true; draft: Draft<A> } | Refusal;
export type Sealed = { ok: true; envelope: Envelope } | Refusal;

const refuse = (reason: RefusalReason, extra: { field?: string; sealReason?: RejectReason } = {}): Refusal => ({ ok: false, reason, ...extra });

// ---- 난수 ----

function takeBytes(random: Random, length: number): Uint8Array | null {
  const bytes = random.bytes(length);
  return bytes instanceof Uint8Array && bytes.length === length ? bytes : null;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// 새 소문자 UUID(v4 표기). 요청 ID·실행 ID·호출 ID에 쓴다. 난수 포트가 길이가 다른 값을 주면 null(만들지 않는다).
export function newUuid(random: Random): string | null {
  const raw = takeBytes(random, 16);
  if (raw === null) return null;
  const b = Uint8Array.from(raw);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---- 초안 ----

function recipientFits(action: DraftAction, recipient: string): boolean {
  const principal = parsePrincipal(recipient);
  return principal !== undefined && ACTION_SPECS[action].to.includes(principal.kind);
}

const missing = (value: unknown): boolean => value === null || value === undefined;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isTime = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 1;

// 초안의 머리 칸이 계약 v1이 정한 꼴인가. 초안을 만들 때와 봉할 때 같은 검사를 한다(공개 초안을 직접 봉하는 길도 막는다).
// 실행 세대는 받는 쪽(verifyEnvelope 6단계)의 규칙이다: 실행에 묶인 지시는 아는 실행이면 그 세대와 같아야 하고 모르는 실행을
// 여는 시작은 1 이상이어야 한다. 장부의 실행 세대는 1 이상이므로 0은 어느 쪽으로도 받아들여지지 않는다. 묶이지 않은 메시지는 0이다.
function draftRefusal(draft: unknown): Refusal | null {
  if (!isRecord(draft)) return refuse("input_malformed", { field: "draft" });
  const action = DRAFT_ACTIONS.find((a) => a === draft.action);
  if (action === undefined) return refuse("input_malformed", { field: "action" });
  if (!Number.isSafeInteger(draft.stopGeneration) || (draft.stopGeneration as number) < 0) return refuse("stop_generation_invalid");
  const runGeneration = draft.runGeneration;
  const runFits = ACTION_SPECS[action].runField === null ? runGeneration === 0 : Number.isSafeInteger(runGeneration) && (runGeneration as number) >= 1;
  if (!runFits) return refuse("run_generation_invalid");
  if (missing(draft.issuedAt)) return PINNED_ACTIONS.includes(action) ? refuse("issued_at_unknown") : null;
  return isTime(draft.issuedAt) ? null : refuse("bad_time");
}

function finish<A extends DraftAction>(draft: Draft<A>): Drafted<A> {
  return draftRefusal(draft) ?? { ok: true, draft };
}

export interface StartDraftInput {
  // startRun이 돌려준 실행 줄.
  run: Pick<
    Run,
    | "runId"
    | "runGeneration"
    | "kind"
    | "role"
    | "profileRevision"
    | "policyRevision"
    | "snapshotDigest"
    | "inputDigest"
    | "deadlineAt"
    | "budgetLeft"
    | "executorId"
    | "credential"
  >;
  // startRun에 넘긴 요청 ID와 정지 세대.
  requestId: string;
  stopGeneration: number;
  // 장부가 시작 트랜잭션에서 정한 발행 시각(instructionTimes(runId).lease.issuedAt). 모르면 null.
  // 함정: 그 실행에 갱신이 적히면 lease.issuedAt은 갱신의 시각이 된다. 갱신 뒤에 시작 지시를 다시 만들려면 지시마다의 발행 시각을
  // 장부가 내줘야 한다(지금은 없다). 이 값과 다른 시각을 실으면 실행기가 정하는 임대 끝과 장부가 계산하는 임대 끝이 갈라진다.
  issuedAt: number | null | undefined;
}

export function startDraft(input: StartDraftInput): Drafted<"task_start"> {
  if (!isRecord(input)) return refuse("input_malformed", { field: "input" });
  const { run } = input;
  if (!isRecord(run)) return refuse("input_malformed", { field: "run" });
  if (missing(input.issuedAt)) return refuse("issued_at_unknown");
  if (run.kind !== "worker") return refuse("not_worker_run");
  for (const field of ["role", "snapshotDigest", "inputDigest"] as const) if (missing(run[field])) return refuse("missing_field", { field });
  if (!recipientFits("task_start", run.executorId)) return refuse("recipient_invalid");
  const principal = parsePrincipal(run.executorId);
  const role = ROLES.find((r) => r === run.role);
  if (role === undefined || principal?.kind !== "worker_executor" || principal.role !== role) return refuse("role_mismatch");
  if (run.budgetLeft < 1) return refuse("budget_exhausted");
  const issuedAt = input.issuedAt as number;
  if (run.deadlineAt <= issuedAt) return refuse("deadline_not_after_issue");
  return finish({
    action: "task_start",
    recipient: run.executorId,
    requestId: input.requestId,
    stopGeneration: input.stopGeneration,
    runGeneration: run.runGeneration,
    issuedAt,
    body: {
      run_id: run.runId,
      role,
      profile_revision: run.profileRevision,
      policy_revision: run.policyRevision,
      snapshot_digest: run.snapshotDigest as string,
      input_digest: run.inputDigest as string,
      deadline_at: run.deadlineAt,
      budget_tokens: run.budgetLeft,
      // method는 장부에서 문자열이다. 계약 밖의 값이면 봉할 때 계약이 body_malformed로 거절한다.
      credential: { ...run.credential } as Bodies["task_start"]["credential"],
    },
  });
}

type RunFacts = Pick<Run, "runId" | "runGeneration" | "executorId">;

export interface RenewDraftInput {
  run: RunFacts;
  // recordRenewInstruction에 넘긴 값 셋과 그 답의 leaseUntil. 답을 받지 못했으면(거절, 읽기 실패) 만들지 않는다.
  requestId: string;
  stopGeneration: number;
  now: number;
  leaseUntil: number | null | undefined;
}

export function renewDraft(input: RenewDraftInput): Drafted<"run_renew"> {
  if (!isRecord(input)) return refuse("input_malformed", { field: "input" });
  if (!isRecord(input.run)) return refuse("input_malformed", { field: "run" });
  if (missing(input.leaseUntil)) return refuse("lease_unknown");
  if (missing(input.now)) return refuse("issued_at_unknown");
  if (!Number.isSafeInteger(input.now)) return refuse("bad_time");
  const leaseUntil = input.leaseUntil as number;
  // 계약 v1의 받는 쪽 경계: 발급 시각보다 늦고 발급 + RUN_LEASE_MAX_MS 이하.
  if (!Number.isSafeInteger(leaseUntil) || leaseUntil <= input.now || leaseUntil > input.now + limits.RUN_LEASE_MAX_MS) return refuse("lease_out_of_range");
  if (!recipientFits("run_renew", input.run.executorId)) return refuse("recipient_invalid");
  return finish({
    action: "run_renew",
    recipient: input.run.executorId,
    requestId: input.requestId,
    stopGeneration: input.stopGeneration,
    runGeneration: input.run.runGeneration,
    issuedAt: input.now,
    body: { run_id: input.run.runId, lease_until: leaseUntil },
  });
}

export type StopDraftInput =
  | { action: "task_cancel"; run: RunFacts; requestId: string; stopGeneration: number; reason: Bodies["task_cancel"]["reason"] }
  | { action: "session_stop"; run: RunFacts; requestId: string; stopGeneration: number; reason: Bodies["session_stop"]["reason"] };

// recordStopInstruction(또는 이은 부탁의 cancelToolRequest가 돌려준 instruction)과 같은 요청 ID·정지 세대를 넘긴다.
// 발행 시각은 봉하는 때의 now다: 처음 봉할 때는 기록에 넘긴 now를 넣는다. 다시 봉하면 늦은 시각이 실리지만 종료는 닫기만 하므로
// 늦게 닿아도 새로 열리는 것이 없다.
export function stopDraft(input: StopDraftInput): Drafted<"task_cancel" | "session_stop"> {
  if (!isRecord(input)) return refuse("input_malformed", { field: "input" });
  if (input.action !== "task_cancel" && input.action !== "session_stop") return refuse("input_malformed", { field: "action" });
  if (!isRecord(input.run)) return refuse("input_malformed", { field: "run" });
  if (missing(input.reason)) return refuse("missing_field", { field: "reason" });
  if (!recipientFits(input.action, input.run.executorId)) return refuse("recipient_invalid");
  return finish({
    action: input.action,
    recipient: input.run.executorId,
    requestId: input.requestId,
    stopGeneration: input.stopGeneration,
    runGeneration: input.run.runGeneration,
    issuedAt: null,
    body: { run_id: input.run.runId, reason: input.reason } as Bodies["task_cancel"] | Bodies["session_stop"],
  } as Draft<"task_cancel" | "session_stop">);
}

export interface FinalizeDraftInput {
  run: RunFacts;
  // recordFinalizeInstruction에 넘긴 요청 ID와 정지 세대.
  requestId: string;
  stopGeneration: number;
  outcome: Bodies["result_finalize"]["outcome"];
  // succeeded일 때만 값이 있다. 어긋나면 봉할 때 계약이 body_malformed로 거절한다.
  resultDigest: string | null;
  storedAt: number;
}

export function finalizeDraft(input: FinalizeDraftInput): Drafted<"result_finalize"> {
  if (!isRecord(input)) return refuse("input_malformed", { field: "input" });
  if (!isRecord(input.run)) return refuse("input_malformed", { field: "run" });
  if (missing(input.outcome)) return refuse("missing_field", { field: "outcome" });
  if (missing(input.storedAt)) return refuse("missing_field", { field: "storedAt" });
  if (input.resultDigest === undefined) return refuse("missing_field", { field: "resultDigest" });
  if (!recipientFits("result_finalize", input.run.executorId)) return refuse("recipient_invalid");
  return finish({
    action: "result_finalize",
    recipient: input.run.executorId,
    requestId: input.requestId,
    stopGeneration: input.stopGeneration,
    runGeneration: input.run.runGeneration,
    issuedAt: null,
    body: { run_id: input.run.runId, outcome: input.outcome, result_digest: input.resultDigest, stored_at: input.storedAt },
  });
}

function distinctList(ids: readonly string[], max: number): boolean {
  return Array.isArray(ids) && ids.length >= 1 && ids.length <= max && new Set(ids).size === ids.length;
}

// 상태 조회. 장부에 적지 않으므로 요청 ID를 여기서 새로 만든다. 부르는 쪽은 그 초안(요청 ID)을 보존해 status_report의
// in_reply_to와 대조하고, 다시 보낼 때 같은 초안을 다시 봉한다.
export function statusQueryDraft(input: { recipient: string; stopGeneration: number; runIds: readonly string[] }, random: Random): Drafted<"status_query"> {
  if (!isRecord(input)) return refuse("input_malformed", { field: "input" });
  if (!distinctList(input.runIds, limits.STATUS_MAX_RUNS)) return refuse("run_ids_invalid");
  if (!recipientFits("status_query", input.recipient)) return refuse("recipient_invalid");
  const requestId = newUuid(random);
  if (requestId === null) return refuse("random_unavailable");
  return finish({ action: "status_query", recipient: input.recipient, requestId, stopGeneration: input.stopGeneration, runGeneration: 0, issuedAt: null, body: { run_ids: [...input.runIds] } });
}

// 받음 확인. 장부가 ok·duplicate를 돌려준 영수증·보고의 id만 넣는다(거절이면 ack하지 않아 실행기가 다시 보낸다).
export function ackDraft(input: { recipient: string; stopGeneration: number; ids: readonly string[] }, random: Random): Drafted<"ack"> {
  if (!isRecord(input)) return refuse("input_malformed", { field: "input" });
  if (!distinctList(input.ids, limits.ACK_MAX_IDS)) return refuse("ids_invalid");
  if (!recipientFits("ack", input.recipient)) return refuse("recipient_invalid");
  const requestId = newUuid(random);
  if (requestId === null) return refuse("random_unavailable");
  return finish({ action: "ack", recipient: input.recipient, requestId, stopGeneration: input.stopGeneration, runGeneration: 0, issuedAt: null, body: { ids: [...input.ids] } });
}

// ---- 봉하기 ----

// 봉할 때 봉투 시한과 시작의 작업 기한에 남아 있어야 하는 시간. 실행기는 자기 시계로 expires_at·deadline_at에 닿으면 거절하고,
// v1은 실행기 시계가 감독보다 CLOCK_SKEW_MS까지 앞서는 것을 막지 않는다(not_yet_valid는 반대 방향만 본다). 전달이 DELIVERY_MAX_MS
// 미만이면 실행기 시계의 받는 시각은 now + DELIVERY_MAX_MS + CLOCK_SKEW_MS보다 이르므로, 정확히 이만큼 남으면 충분하다.
// 계약의 maySend(DELIVERY_MAX_MS만 봄)보다 넓다. 발행 시각이 고정된 시작·갱신의 마지막 재전송은 issued_at + 19000ms다.
const SEND_MARGIN_MS = limits.DELIVERY_MAX_MS + limits.CLOCK_SKEW_MS;

export interface SealPorts {
  random: Random;
  signer: Signer;
}

// now는 봉하는 때의 지금 시각(장부와 같은 시계). 시한은 계약의 내는 쪽 기본 수명이라 expires_at = issued_at + 수명이다.
// 시작·갱신은 장부의 발행 시각을 그대로 실으므로 다시 봉해도 issued_at·expires_at이 같고 nonce만 바뀐다. 그 시한이 남은 동안만
// 다시 보낼 수 있다(그 뒤로는 too_late_to_send). 발행 시각을 앞으로 옮기면 실행기가 정하는 임대 끝이 장부의 계산보다 늦어지고,
// 시한이 지난 시작 지시가 다시 살아나므로 옮기지 않는다. 시작·갱신 초안에 발행 시각이 없으면 now로 채우지 않고 거절한다.
export function sealDraft(draft: Draft, now: number, ports: SealPorts): Sealed {
  const malformed = draftRefusal(draft);
  if (malformed !== null) return malformed;
  if (!Number.isSafeInteger(now)) return refuse("bad_time");
  const issuedAt = draft.issuedAt ?? now;
  if (issuedAt > now) return refuse("issued_in_future");
  const spec = ACTION_SPECS[draft.action];
  const expiresAt = issuedAt + (spec.lifetimeMs ?? limits.MESSAGE_TTL_MS);
  const deadline = draft.action === "task_start" && isRecord(draft.body) ? draft.body.deadline_at : undefined;
  if (Number.isSafeInteger(deadline)) {
    // 받는 쪽은 자기 시계로 받는 시각이 작업 기한 이후면(정각 포함) deadline_passed로 거절한다. 봉투 시한과 같은 여유를 기한에도 둔다.
    if ((deadline as number) <= now) return refuse("deadline_passed");
    if ((deadline as number) - now < SEND_MARGIN_MS) return refuse("deadline_too_close");
  }
  if (expiresAt - now < SEND_MARGIN_MS) return refuse("too_late_to_send");
  // 대조의 기준(본문의 정규 바이트)을 서명 포트에 넘기기 전에 따로 만든다. 포트에는 그 바이트에서 다시 만든 사본을 넘기므로
  // 포트가 받은 본문을 고쳐도 초안과 기준은 바뀌지 않고, 돌려준 봉투의 본문도 초안과 객체를 나누지 않는다.
  let bodyJson: string;
  let bodyDigest: string;
  try {
    bodyJson = canonicalJson(draft.body);
    bodyDigest = digestOf(draft.body);
  } catch {
    return refuse("seal_refused", { sealReason: "body_malformed" });
  }
  const nonceBytes = takeBytes(ports.random, 16);
  if (nonceBytes === null) return refuse("random_unavailable");
  const nonce = hex(nonceBytes);
  const expected: Header = {
    contract: CONTRACT,
    sender: SUPERVISOR,
    recipient: draft.recipient,
    action: draft.action,
    request_id: draft.requestId,
    stop_generation: draft.stopGeneration,
    run_generation: draft.runGeneration,
    body_digest: bodyDigest,
    issued_at: issuedAt,
    expires_at: expiresAt,
    nonce,
  };
  const input: SealInput<DraftAction> = {
    sender: SUPERVISOR,
    recipient: draft.recipient,
    action: draft.action,
    request_id: draft.requestId,
    stop_generation: draft.stopGeneration,
    run_generation: draft.runGeneration,
    issued_at: issuedAt,
    nonce,
    body: JSON.parse(bodyJson),
  };
  let envelope: Envelope;
  try {
    envelope = ports.signer.seal(input);
  } catch (error) {
    if (error instanceof SealError) return refuse("seal_refused", { sealReason: error.reason });
    throw error;
  }
  if (!sameAsSent(envelope, expected, bodyJson)) return refuse("signer_mismatch");
  // 대조한 객체를 그대로 내주지 않는다. 포트가 넘겨받은 입력이나 자기 반환값의 참조를 쥐고 있다가 나중에 고치면 전송할 봉투도 바뀐다.
  // 이 모듈만 쥔 기준 머리, 보관한 정규 바이트에서 새로 만든 본문, 서명 문자열(값)로 새 봉투를 만든다.
  return { ok: true, envelope: { header: expected, signature: envelope.signature, body: JSON.parse(bodyJson) } };
}

// 서명 포트가 돌려준 봉투가 넘긴 값 그대로인가. 봉투의 칸은 셋뿐이고, 서명은 문자열이며, 머리는 칸 전부(계약 판, 여분 칸 포함)가
// 기대한 머리와 같은 정규 바이트이고, 본문은 넘기기 전에 만든 정규 바이트와 같다(머리의 body_digest도 그 바이트의 digest다).
// 한계: 서명 바이트는 공개 키가 없어 대조하지 않는다. 서명이 감독의 키로 머리에 맞는지는 받는 쪽 verifyEnvelope만 안다.
function sameAsSent(envelope: unknown, expected: Header, bodyJson: string): envelope is Envelope {
  if (!isRecord(envelope) || Object.keys(envelope).sort().join() !== "body,header,signature") return false;
  if (typeof envelope.signature !== "string") return false;
  try {
    return canonicalJson(envelope.header) === canonicalJson(expected) && canonicalJson(envelope.body) === bodyJson;
  } catch {
    return false;
  }
}
