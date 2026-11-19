// olive-control/v2(후보)의 한도와 시간 상수. 설계(supervisor.md §9.1)에 값이 있는 v2 숫자는 아직 없어, 모두 v1의 같은 뜻 상한을
// 그대로 가져온 후보다. v1 값을 import하지 않고 숫자로 두는 이유: v2의 경계는 v2 판에 고정되므로 v1 쪽의 표기와 따로 읽혀야 한다.
// 같은 값인지는 시험이 지킨다(test/contract/v2/acceptance.test.ts).

export const CONTRACT = "olive-control/v2";

// 봉투 수명(expires_at - issued_at)의 받는 쪽 상한. 후보(v1 MESSAGE_TTL_MAX_MS와 같음).
export const MESSAGE_TTL_MAX_MS = 30_000;
// 내는 쪽 기본 수명. MESSAGE_TTL_MAX_MS 이하에서만 바꾼다. 후보.
export const MESSAGE_TTL_MS = 30_000;
// 발급 시각이 받는 쪽 시계보다 이만큼까지 앞서도 받는다. 후보(v1과 같음).
export const CLOCK_SKEW_MS = 1_000;
// nonce 기록을 지워도 되는 시간. 이보다 오래된 봉투는 시한으로 이미 거절된다(v1과 같은 식).
export const NONCE_RETENTION_MS = 2 * (MESSAGE_TTL_MAX_MS + CLOCK_SKEW_MS);
// 봉투 하나의 바이트 틀 상한. 이 모듈은 집행하지 않는다(바이트 틀이 해석 전에 자른다). 후보(v1과 같음).
export const MAX_MESSAGE_BYTES = 64 * 1024;
