// 거절 사유. 거절은 늘 이 가운데 하나만 돌려준다(먼저 걸린 것). 단계는 envelope.ts의 검증 순서와 같다.
export const REJECT_REASONS = [
  // 1. 봉투와 머리의 모양
  "malformed",
  "unknown_field",
  "contract_mismatch",
  "unknown_action",
  // 2. 서명
  "unknown_sender",
  "bad_signature",
  // 3. 방향과 받는 쪽
  "wrong_direction",
  "wrong_recipient",
  // 4. 시한
  "lifetime_invalid",
  "not_yet_valid",
  "expired",
  // 5. 본문
  "body_malformed",
  "digest_mismatch",
  "forbidden_field",
  "role_mismatch",
  "result_too_large",
  // 받는 시각에 이미 작업 종료 기한(task_start.deadline_at)이 지났다. 발급할 때는 맞던 본문이라 body_malformed와 가른다.
  "deadline_passed",
  // 6. 세대
  "stop_generation_mismatch",
  "unknown_run",
  "run_generation_mismatch",
  // 7. 재사용
  "replayed",
  // 전송 규칙(봉투 검증 밖, transport.ts)
  "no_connection",
  "too_late_to_send",
  "receipt_conflict",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const TRANSPORT_REASONS = ["no_connection", "too_late_to_send", "receipt_conflict"] as const satisfies readonly RejectReason[];
