// olive-control/v1의 한도와 시간 상수는 모두 이 파일에 있다. 숫자는 두 종류이고, 종류는 상수마다 붙은 표시로 가른다(이름으로 가르지 않는다).
// - 받는 쪽 경계("v1에 고정"이라고 적은 것): 받는 쪽 검증(verifyEnvelope와 본문 해석기)이 이 값으로 봉투·본문을 거절한다.
//   판에 고정이다. 바꾸면 이미 배포된 v1 수신기가 새 값으로 낸 메시지를 거절하므로 판을 올린다(v2).
// - 내는 쪽 기본값과 운영 숫자("기본값(관리자 미확정)"이라고 적은 것): 보내는 쪽이 고르는 값, 전달·처리·준비의 상한,
//   연결·실행 감시의 시간. 이름에 MAX가 들어도(DELIVERY_MAX_MS, STOP_SYNC_ANSWER_MAX_MS, PREPARE_MAX_MS) 받는 쪽 검증이
//   강제하지 않으므로 이 종류다. 받는 쪽 경계 안에서만 같은 판에서 바꾼다(경계와의 관계는 시험이 지킨다).
//   supervisor.md §11의 기본값이거나 이 계약이 고른 출발점이고, 재 본 값이 아니다.
// 시한은 모두 정각부터 거절한다: 봉투는 expires_at 정각에 expired, 맞춤 대기는 sentAt + STOP_SYNC_WAIT_MS 정각에
// challenge_mismatch. 그래서 전달·처리의 상한은 "그 값 미만"이다(정각까지 걸리면 상한을 넘은 것이다).

export const CONTRACT = "olive-control/v1";

// 봉투 수명(expires_at - issued_at)의 받는 쪽 상한(§9.2의 지시 시한 30초). v1에 고정. 정지 세대 맞춤 둘 밖의 모든 동작에 쓴다.
export const MESSAGE_TTL_MAX_MS = 30_000;
// 내는 쪽 기본 수명. sealEnvelope가 쓴다. MESSAGE_TTL_MAX_MS 이하에서만 바꾼다. 재전송은 같은 본문을 새 봉투에 담는다.
export const MESSAGE_TTL_MS = 30_000;
// 발급 시각이 받는 쪽 시계보다 이만큼까지 앞서도 받는다(옛 봇 capabilitySkewMs와 같은 값). v1에 고정.
export const CLOCK_SKEW_MS = 1_000;
// nonce 기록을 지워도 되는 시간: 이보다 오래된 봉투는 시한으로 이미 거절된다(옛 봇 NONCE_RETENTION_MS와 같은 식).
export const NONCE_RETENTION_MS = 2 * (MESSAGE_TTL_MAX_MS + CLOCK_SKEW_MS);

// 정지 세대 맞춤(stop_sync_request·stop_sync_reply) 봉투 수명의 받는 쪽 상한. v1에 고정. 다른 메시지보다 짧게 두어,
// 감독이 서명한 "지금의 세대"가 그 뒤 새 정지로 낡을 수 있는 시간을 줄인다.
export const STOP_SYNC_TTL_MAX_MS = 15_000;
// 맞춤 봉투의 내는 쪽 기본 수명. 기본값(관리자 미확정). STOP_SYNC_TTL_MAX_MS 이하이고, DELIVERY_MAX_MS + CLOCK_SKEW_MS보다
// 커야 보내는 쪽이 실을 수 있다(시험이 지킨다).
export const STOP_SYNC_TTL_MS = 15_000;
// 실행기가 stop_sync_request를 연결에 실은 때부터 그 challenge의 답을 받아들이는 기한. v1에 고정(실행기가 거절하는 경계).
// 답 봉투의 신선도(발급부터 STOP_SYNC_TTL_MAX_MS)와 따로 잰다. 경과 시간이 0 이상 이 값 미만일 때만 받는다(정각부터 거절).
// 요청의 전달 < DELIVERY_MAX_MS, 감독의 처리 < STOP_SYNC_ANSWER_MAX_MS, 답의 전달 < DELIVERY_MAX_MS이면 왕복은
// 2 * DELIVERY_MAX_MS + STOP_SYNC_ANSWER_MAX_MS 미만이므로 STOP_SYNC_WAIT_MS >= 2 * DELIVERY_MAX_MS + STOP_SYNC_ANSWER_MAX_MS이면
// 덮는다(시험이 지킨다). 지금 값은 등호(2 * 10초 + 5초)라, 세 상한에 정각으로 걸린 왕복(25초)은 상한을 넘은 것이고 거절된다.
// 기한을 늘려도 받아들이는 답은 이 연결에서 기다리는 challenge를 담은 답뿐이다.
export const STOP_SYNC_WAIT_MS = 25_000;
// 감독이 맞춤 요청을 받은 때부터 답을 연결에 싣기까지의 상한. 기본값(관리자 미확정). 이 값 미만에 실어야 한다.
// 받은 때부터 이 값이 되면(정각 포함) 답하지 않는다. 그 답은 실행기의 기한 안에 닿는다고 보장할 수 없다.
export const STOP_SYNC_ANSWER_MAX_MS = 5_000;

// 전달 지연의 상한. 기본값(관리자 미확정). 연결 위 한 번의 전달은 이 값 미만이라고 본다(받는 쪽이 재지 않는다).
// 보내는 쪽은 남은 시한이 이보다 짧은 봉투를 연결에 싣지 않는다(maySend, 싣는 순간에만 본다). 남은 시한이 정확히 이 값일 때 실은
// 봉투는 전달이 이 값 미만이어야 expires_at 전에 닿는다.
// 이 값과 CLOCK_SKEW_MS의 합은 MESSAGE_TTL_MS·STOP_SYNC_TTL_MS보다 작아야 하고, 맞춤 왕복이 STOP_SYNC_WAIT_MS 안에 들어야 한다(시험이 지킨다).
export const DELIVERY_MAX_MS = 10_000;

// 실행 감시(S-10). RUN_LEASE_MAX_MS 밖은 모두 기본값(관리자 미확정)이다(PREPARE_MAX_MS도 받는 쪽이 검사하지 않는다).
export const RENEW_INTERVAL_MS = 10_000;
// RUN_LEASE_MAX_MS 이상이어야 한다: 감독이 끊김을 판정할 때 실행기는 임대가 끝나 이미 닫혀 있다(시험이 지킨다).
export const DISCONNECT_JUDGE_MS = 30_000;
export const PREPARE_MAX_MS = 60_000;
export const STOP_GRACE_MS = 5_000;
// run_renew가 줄 수 있는 임대의 최대 길이. v1에 고정(받는 쪽이 넘는 lease_until을 거절한다). 감독이 사라지면 실행기는 이 안에 닫는다.
export const RUN_LEASE_MAX_MS = 30_000;

// 크기. 모두 v1에 고정. 본문의 크기는 스키마(글자 수·개수 상한)와 결과 상한이 묶는다. 계약에 맞는 본문은 모두 이 틀 안에 든다.
// 봉투 하나(머리·서명·본문)의 바이트 틀 상한. 바이트 틀을 만드는 뒤 작업이 해석 전에 이것으로 자른다.
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_DEPTH = 16;

// 결과. v1에 고정(받는 쪽이 result_too_large·body_malformed로 거절한다). 값은 O09 할 일 3의 "1~2천 토큰 목표"에서 고른 출발점이라
// 바꾸려면 판을 올린다.
export const RESULT_MAX_BYTES = 16 * 1024;
export const RESULT_SUMMARY_MAX_CHARS = 2_000;
export const RESULT_ITEM_MAX_CHARS = 500;
export const RESULT_MAX_ITEMS = 20;
export const RESULT_MAX_REFS = 32;

// 전송 메시지 한 번에 담는 개수. v1에 고정.
export const STATUS_MAX_RUNS = 8;
export const ACK_MAX_IDS = 32;

// 정하지 않은 것(값을 두지 않는다): 세션 파드의 기동 실패 한도와 멈춘 모양(hold), 올리브 자신에 대한 경보 목록,
// 제어 컨테이너의 건강 확인·지표 포트. 모두 spec.md §5.3의 미정이다.
