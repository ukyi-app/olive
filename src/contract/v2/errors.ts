// v2의 거절 사유. 거절은 늘 이 가운데 하나만 돌려준다(먼저 걸린 것). 순서는 contract.ts의 검증 순서와 같다.
// v1과 같은 이름은 같은 뜻이다. v1의 세대·실행·결과 사유는 공통부에 없다. 묶음이 필요하면 여기에 더한다.
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
  // 5. 연결: 인사 상태와 받는 쪽의 접수
  // 인사가 끝나지 않은 연결에 인사 밖의 동작이 왔다.
  "handshake_required",
  // 인사가 끝난 연결에 인사가 다시 왔다.
  "handshake_repeated",
  // 인사에서 정책 revision이 달랐던 연결에 효과 동작이 왔다.
  "policy_mismatch",
  // 받는 쪽의 접수가 닫혔는데, 닫힌 접수에서 받지 않는 효과 동작이 왔다.
  "intake_closed",
  // 6. 본문
  "body_malformed",
  "digest_mismatch",
  "forbidden_field",
  // 7. 답의 대조: 답이 이 연결에서 기다리는 요청을 가리키지 않거나, 가리킨 요청과 작업(job_id·action·request_digest)이 다르다.
  "reply_mismatch",
  // 8. 재사용
  "replayed",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
