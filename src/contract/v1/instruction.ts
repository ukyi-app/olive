// 감독 → 실행기 지시 여섯 가지의 본문. 실행기는 명령·이미지·볼륨·argv·환경을 지시에서 받지 않으므로 그런 칸이 없다.
// 계정·모델·도구·이미지·경로는 역할 프로필에 고정돼 있고, 지시는 프로필·정책 revision으로 그 판을 가리키기만 한다.
import { type BodyContext, BodyReject } from "./header.ts";
import { RUN_LEASE_MAX_MS } from "./limits.ts";
import { ROLES } from "./role.ts";
import { int, nullable, object, oneOf, pattern, revision, sha256, time, uuid } from "./schema.ts";

export const INSTRUCTIONS = ["session_start", "session_stop", "task_start", "task_cancel", "run_renew", "result_finalize"] as const;
export type InstructionAction = (typeof INSTRUCTIONS)[number];

// 그 실행에 쓸 자격 하나를 가리킨다. 값은 담지 않는다. 값은 같은 연결로 따로 오고(전달 통로는 뒤 작업),
// 실행기는 받은 값의 SHA-256이 여기 digest와 같을 때만 쓴다. 그래서 서명된 지시 밖의 자격은 쓰이지 않는다.
const credential = object({
  account: pattern(/^[a-z0-9][a-z0-9-]{0,31}$/),
  method: oneOf(["subscription", "api_key"]),
  revision,
  digest: sha256,
});

// 세션 시작은 새 세대의 인수 영수증(D-50)과 규칙 확인 기록(D-51)을 감독 장부와 대조한 뒤에만 낸다.
// 실행기는 generation_marker_digest가 자기 세대의 표식과 같을 때만 본체에게 자격을 준다.
// takeover_receipt_id가 null이면 앞 세대가 없는 첫 세션이다(장부가 판단한다).
export const parseSessionStart = object({
  run_id: uuid,
  generation_marker_digest: sha256,
  takeover_receipt_id: nullable(uuid),
  rule_check_id: uuid,
  profile_revision: revision,
  policy_revision: revision,
  handoff_digest: nullable(sha256),
  credential,
});

export const SESSION_STOP_REASONS = ["daily_rotation", "session_broken", "emergency_stop", "account_switch"] as const;
export const parseSessionStop = object({
  run_id: uuid,
  reason: oneOf(SESSION_STOP_REASONS),
});

const taskStartShape = object({
  run_id: uuid,
  role: oneOf(ROLES),
  profile_revision: revision,
  policy_revision: revision,
  snapshot_digest: sha256,
  input_digest: sha256,
  deadline_at: time,
  budget_tokens: int(1),
  credential,
});
export function parseTaskStart(value: unknown, path: string, ctx: BodyContext) {
  const body = taskStartShape(value, path);
  // 역할은 실행기 이름에 고정돼 있다. 다른 역할의 작업을 이 실행기에서 띄우지 않는다.
  if (ctx.recipient.kind !== "worker_executor" || ctx.recipient.role !== body.role) throw new BodyReject("role_mismatch");
  if (body.deadline_at <= ctx.header.issued_at) throw new BodyReject("body_malformed");
  // 시작 허가(봉투 30초)와 작업 기한은 따로다. 전송이 늦어 받을 때 이미 기한이 지났으면 봉투가 살아 있어도 띄우지 않는다.
  // 정각도 거절한다: 기한 정각에 시작한 작업은 일할 시간이 0이다.
  if (ctx.receivedAt !== null && body.deadline_at <= ctx.receivedAt) throw new BodyReject("deadline_passed");
  return body;
}

export const TASK_CANCEL_REASONS = ["requested", "deadline", "budget", "emergency_stop"] as const;

// 받는 쪽보다 높은 정지 세대를 실어 와도 받아들이는 지시: reason이 emergency_stop인 task_cancel과 session_stop뿐이다.
// 비상 정지(supervisor.md §7.3)는 감독이 새 정지 세대를 적용한 뒤 실행기에 종료를 지시하므로, 그 종료가 새 세대를 실행기에
// 옮기는 길이다. 실행을 닫기만 하므로 미래 세대를 받아도 새로 열리는 것이 없다. 시작·갱신·확정은 늘 정확히 같아야 한다.
export function advancesStopGeneration(action: InstructionAction, body: unknown): boolean {
  if (action !== "task_cancel" && action !== "session_stop") return false;
  return (body as { reason?: unknown }).reason === "emergency_stop";
}
export const parseTaskCancel = object({
  run_id: uuid,
  reason: oneOf(TASK_CANCEL_REASONS),
});

const runRenewShape = object({
  run_id: uuid,
  lease_until: time,
});
// 갱신은 임대를 RUN_LEASE_MAX_MS보다 길게 주지 못한다. 감독이 사라지면 실행기는 그 안에 입력과 도구를 닫는다.
export function parseRunRenew(value: unknown, path: string, ctx: BodyContext) {
  const body = runRenewShape(value, path);
  const issued = ctx.header.issued_at;
  if (body.lease_until <= issued || body.lease_until > issued + RUN_LEASE_MAX_MS) throw new BodyReject("body_malformed");
  return body;
}

// 감독이 결과 저장을 마친 뒤에만 낸다. 실행기는 이것을 받아야 자격·tmp·작업 폴더를 지운다(§3의 6).
const resultFinalizeShape = object({
  run_id: uuid,
  outcome: oneOf(["succeeded", "failed", "cancelled"]),
  result_digest: nullable(sha256),
  stored_at: time,
});
export function parseResultFinalize(value: unknown, path: string) {
  const body = resultFinalizeShape(value, path);
  if ((body.outcome === "succeeded") !== (body.result_digest !== null)) throw new BodyReject("body_malformed");
  return body;
}

export type SessionStart = ReturnType<typeof parseSessionStart>;
export type SessionStop = ReturnType<typeof parseSessionStop>;
export type TaskStart = ReturnType<typeof parseTaskStart>;
export type TaskCancel = ReturnType<typeof parseTaskCancel>;
export type RunRenew = ReturnType<typeof parseRunRenew>;
export type ResultFinalize = ReturnType<typeof parseResultFinalize>;
