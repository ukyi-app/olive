// 실행기 → 감독 보고. 지시 여섯(감독 → 실행기)을 늘리지 않는다. 영수증처럼 report_id로 같은 보고를 가른다.
// 모두 보낸 실행기의 키로 서명된다(봉투). 세션 쪽 보고는 세션 실행기만 낼 수 있다(actions.ts의 방향 표).
import { BodyReject } from "./header.ts";
import { parseResult } from "./result.ts";
import { nullable, object, oneOf, sha256, time, uuid } from "./schema.ts";

export const REPORTS = ["report_session_broken", "report_rule_check", "report_hook_event", "report_result"] as const;
export type ReportAction = (typeof REPORTS)[number];

// 세션 깨짐(D-52): 사유는 셋뿐이다. 머리의 run_generation과 본문의 세대 표식 digest로 그 세대에 묶는다.
// 감독은 이 보고를 받으면 세션 종료 지시로 교체 절차(§6)를 밟는다. 옛 세대의 보고는 세대 대조에서 거절된다.
export const SESSION_BROKEN_CAUSES = ["main_exited", "main_restarted_alone", "relay_lost"] as const;
export const parseSessionBroken = object({
  report_id: uuid,
  run_id: uuid,
  cause: oneOf(SESSION_BROKEN_CAUSES),
  generation_marker_digest: sha256,
  observed_at: time,
});

// 규칙 확인 기록(D-51): 새 세션 파드가 첫 자격 전에 일부러 전체 재시작을 한 번 시킨 결과다.
// rule_present면 재시작 전 표식과 재시작 뒤 표식이 달라야 하고 시작 허가가 있어야 한다. rule_missing이면 둘 다 null이다.
// 감독은 session_start의 rule_check_id로 이 기록을 가리키고, 장부에 rule_present로 남은 기록만 받는다.
const ruleCheckShape = object({
  report_id: uuid,
  outcome: oneOf(["rule_present", "rule_missing"]),
  first_marker_digest: sha256,
  restarted_marker_digest: nullable(sha256),
  start_permit_id: nullable(uuid),
  checked_at: time,
});
export function parseRuleCheck(value: unknown, path: string) {
  const body = ruleCheckShape(value, path);
  const present = body.outcome === "rule_present";
  const ok = present
    ? body.restarted_marker_digest !== null && body.restarted_marker_digest !== body.first_marker_digest && body.start_permit_id !== null
    : body.restarted_marker_digest === null && body.start_permit_id === null;
  if (!ok) throw new BodyReject("body_malformed");
  return body;
}

// 훅 이벤트: 턴은 session_id·prompt_id로 잇는다(accounts.md §2.1). 둘 다 필수다.
// 모델이 쓴 글(last_assistant_message, 화면, prompt 원문)은 신호가 아니므로 칸이 없다.
export const HOOK_EVENTS = ["UserPromptSubmit", "Stop", "StopFailure"] as const;
// StopFailure의 error 12종(accounts.md §2.2).
export const STOP_FAILURE_ERRORS = [
  "rate_limit",
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
  "overloaded",
  "server_error",
  "invalid_request",
  "model_not_found",
  "max_output_tokens",
  "cloud_credential_error",
  "unknown",
] as const;
const hookShape = object({
  report_id: uuid,
  run_id: uuid,
  session_id: uuid,
  prompt_id: uuid,
  event: oneOf(HOOK_EVENTS),
  error: nullable(oneOf(STOP_FAILURE_ERRORS)),
  observed_at: time,
});
export function parseHookEvent(value: unknown, path: string) {
  const body = hookShape(value, path);
  if ((body.event === "StopFailure") !== (body.error !== null)) throw new BodyReject("body_malformed");
  return body;
}

// 작업 결과(작업자 실행기만): 실행기가 모양·크기를 검사한 결과를 감독에 넘긴다. 감독은 저장한 뒤 result_finalize를 낸다.
export const parseResultReport = (value: unknown, path: string) =>
  object({ report_id: uuid, run_id: uuid, result: parseResult })(value, path);

export type SessionBroken = ReturnType<typeof parseSessionBroken>;
export type RuleCheck = ReturnType<typeof parseRuleCheck>;
export type HookEvent = ReturnType<typeof parseHookEvent>;
export type ResultReport = ReturnType<typeof parseResultReport>;
