// olive-control/v1의 한도와 시간 상수는 모두 이 파일에 있다.
// "기본값(관리자 미확정)"이라고 적은 숫자는 supervisor.md §11의 기본값이거나 이 계약이 고른 출발점이고, 재 본 값이 아니다.
// 그 숫자를 바꾸는 것은 판을 올리지 않는다. 받는 쪽이 거절하는 경계(지시 시한, 크기 상한)를 바꾸면 판을 올린다.

export const CONTRACT = "olive-control/v1";

// 지시 시한(§9.2의 30초). 영수증·보고·전송 메시지도 같은 수명을 쓴다. 재전송은 같은 본문을 새 봉투에 담는다.
export const MESSAGE_TTL_MS = 30_000;
// 발급 시각이 받는 쪽 시계보다 이만큼까지 앞서도 받는다(옛 봇 capabilitySkewMs와 같은 값).
export const CLOCK_SKEW_MS = 1_000;
// nonce 기록을 지워도 되는 시간: 이보다 오래된 봉투는 시한으로 이미 거절된다(옛 봇 NONCE_RETENTION_MS와 같은 식).
export const NONCE_RETENTION_MS = 2 * (MESSAGE_TTL_MS + CLOCK_SKEW_MS);
// 정지 세대 맞춤(stop_sync_request·stop_sync_reply)의 수명. 기본값(관리자 미확정). 다른 메시지보다 짧게 두어, 감독이 서명한
// "지금의 세대"가 그 뒤 새 정지로 낡을 수 있는 시간을 줄인다. DELIVERY_MAX_MS보다 커야 보내는 쪽이 실을 수 있다(시험이 지킨다).
export const STOP_SYNC_TTL_MS = 15_000;

// 전달 지연의 상한. 기본값(관리자 미확정). 보내는 쪽은 남은 시한이 이보다 짧은 봉투를 연결에 싣지 않는다.
// 이 값과 CLOCK_SKEW_MS의 합은 MESSAGE_TTL_MS보다 작아야 한다(시험이 지킨다).
export const DELIVERY_MAX_MS = 10_000;

// 실행 감시(S-10). 모두 기본값(관리자 미확정).
export const RENEW_INTERVAL_MS = 10_000;
export const DISCONNECT_JUDGE_MS = 30_000;
export const PREPARE_MAX_MS = 60_000;
export const STOP_GRACE_MS = 5_000;
// run_renew가 줄 수 있는 임대의 최대 길이. 끊김 판정과 같게 둔다: 갱신이 끊기면 실행기는 이 안에 닫는다.
export const RUN_LEASE_MAX_MS = DISCONNECT_JUDGE_MS;

// 크기. 본문의 크기는 스키마(글자 수·개수 상한)와 결과 상한이 묶는다. 계약에 맞는 본문은 모두 이 틀 안에 든다.
// 봉투 하나(머리·서명·본문)의 바이트 틀 상한. 바이트 틀을 만드는 뒤 작업이 해석 전에 이것으로 자른다.
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_DEPTH = 16;

// 결과(O09 할 일 3의 "1~2천 토큰 목표"에서 고른 출발점, 기본값(관리자 미확정)).
export const RESULT_MAX_BYTES = 16 * 1024;
export const RESULT_SUMMARY_MAX_CHARS = 2_000;
export const RESULT_ITEM_MAX_CHARS = 500;
export const RESULT_MAX_ITEMS = 20;
export const RESULT_MAX_REFS = 32;

// 전송 메시지 한 번에 담는 개수.
export const STATUS_MAX_RUNS = 8;
export const ACK_MAX_IDS = 32;

// 정하지 않은 것(값을 두지 않는다): 세션 파드의 기동 실패 한도와 멈춘 모양(hold), 올리브 자신에 대한 경보 목록,
// 제어 컨테이너의 건강 확인·지표 포트. 모두 spec.md §5.3의 미정이다.
