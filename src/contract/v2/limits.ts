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

// 후보 내용 조회(candidate_fetch·candidate_chunk)의 크기. 설계에 값이 없다. 둘 다 받는 쪽이 본문 해석에서 강제한다.
// 전체 상한은 관리자가 정했고, 조각 크기는 봉투 틀에서 끌어낸 후보다.
// 조각 하나의 바이트 상한. base64url로 4/3배가 된 뒤 머리·서명·다른 칸을 더해도 MAX_MESSAGE_BYTES 안에 드는 2의 거듭제곱 가운데
// 가장 큰 값이다(48KiB는 base64url만으로 64KiB). 틀이 바뀌면 이 값도 다시 고른다(시험이 가장 큰 조각의 봉투를 잰다). 후보.
export const CANDIDATE_CHUNK_MAX_BYTES = 32 * 1024;
// 후보 하나의 전체 바이트 상한 1MiB(조각 32개). 관리자 결정(2026-11-19). 이보다 큰 후보는 이 판으로 옮기지 않는다: 감독은 그런
// 후보를 내지 않고, 현관은 total·offset이 이 값을 넘는 묻기·답을 본문 해석에서 거절한다. 바꾸면 offset·total의 경계가 바뀌어 새 판이다.
export const CANDIDATE_MAX_BYTES = 1024 * 1024;
// 후보 하나를 이루는 내용 조각의 최대 개수(관리자 결정 2026-11-19: 1MiB, 최대 32조각). 현관은 한 후보에 위치 32곳까지만 묻고,
// 조립은 조각이 이보다 많으면 거절한다. 같은 위치의 재시도는 그 위치의 결과를 바꿀 뿐 새 조각이 아니다. 감독이 마지막 조각 밖에서
// 조각을 꽉 채워야(candidatePieceOf) 1MiB가 32조각에 든다.
export const CANDIDATE_MAX_CHUNKS = CANDIDATE_MAX_BYTES / CANDIDATE_CHUNK_MAX_BYTES;
