// 봉투의 머리. 서명은 이 객체(모든 칸)의 정규 직렬화에 건다. 서명 칸은 머리 밖에 있다.
import type { RejectReason } from "./errors.ts";
import type { Principal } from "./principal.ts";
import { int, literal, object, pattern, sha256, time, uuid } from "./schema.ts";
import { CONTRACT } from "./limits.ts";

export const ACTIONS = [
  // 지시(감독 → 실행기). 이 여섯뿐이다(supervisor.md §9.2).
  "session_start",
  "session_stop",
  "task_start",
  "task_cancel",
  "run_renew",
  "result_finalize",
  // 영수증(실행기 → 감독)
  "receipt_accepted",
  "receipt_started",
  "receipt_stopped",
  "receipt_cleaned",
  "receipt_session_takeover",
  // 보고(실행기 → 감독)
  "report_session_broken",
  "report_rule_check",
  "report_hook_event",
  "report_result",
  // 전송(효과 없음): 연결 인사, 상태 조회와 답, 받음 확인
  "hello",
  "status_query",
  "status_report",
  "ack",
  // 정지 세대 맞춤(효과 없음): 실행기가 연결의 첫 단계에서 감독이 서명한 지금의 정지 세대를 받는다(transport.ts).
  "stop_sync_request",
  "stop_sync_reply",
] as const;
export type Action = (typeof ACTIONS)[number];

// 이름 칸은 ASCII만 받는다. 그래야 다른 언어의 구현도 같은 바이트를 만든다.
const PRINCIPAL = /^(supervisor|front-door|executor\/[a-z_]+\/[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62})$/;
// nonce는 128비트 이상의 무작위 값을 소문자 16진 32자로 쓴다.
export const NONCE = /^[0-9a-f]{32}$/;

export const parseHeader = object({
  contract: literal(CONTRACT),
  sender: pattern(PRINCIPAL),
  recipient: pattern(PRINCIPAL),
  action: (value: unknown, path: string) => pattern(/^[a-z_]{1,40}$/)(value, path) as Action,
  request_id: uuid,
  stop_generation: int(0),
  run_generation: int(0),
  body_digest: sha256,
  issued_at: time,
  expires_at: time,
  nonce: pattern(NONCE),
});
export type Header = ReturnType<typeof parseHeader>;

// 본문 해석기가 받는 맥락. 머리는 서명을 확인한 뒤의 값이다.
export interface BodyContext {
  header: Header;
  sender: Principal;
  recipient: Principal;
  // 받는 쪽의 지금 시각. 봉투를 만들 때(sealEnvelope)는 null이고, 그때는 발급 시각 기준의 관계만 본다.
  // 받을 때만 보는 관계(이미 지난 작업 기한 등)는 이 값이 있을 때만 검사한다.
  receivedAt: number | null;
}

// 본문의 칸끼리, 또는 머리와 본문 사이가 맞지 않을 때 던진다.
export class BodyReject extends Error {
  constructor(readonly reason: RejectReason) {
    super(reason);
  }
}
