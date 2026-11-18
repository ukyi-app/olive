// 실행기 → 감독 영수증. receipt_id는 실행기가 영수증마다 한 번 만든다.
// 같은 영수증을 다시 보낼 때는 같은 본문(같은 receipt_id)을 새 봉투에 담는다. 감독은 receipt_id와 본문 digest로
// 같은 것인지 판정한다(transport.ts의 classifyDelivery). 같은 id에 다른 본문이 오면 receipt_conflict다.
import { INSTRUCTIONS } from "./instruction.ts";
import { literal, object, oneOf, sha256, time, uuid } from "./schema.ts";

export const RECEIPTS = [
  "receipt_accepted",
  "receipt_started",
  "receipt_stopped",
  "receipt_cleaned",
  "receipt_session_takeover",
] as const;
export type ReceiptAction = (typeof RECEIPTS)[number];

// 접수: 지시를 검증하고 장부(실행기 쪽)에 남겼다. 모델을 띄우기 전이다(§3의 4).
export const parseReceiptAccepted = object({
  receipt_id: uuid,
  run_id: uuid,
  instruction_request_id: uuid,
  instruction: oneOf(INSTRUCTIONS),
});

export const parseReceiptStarted = object({
  receipt_id: uuid,
  run_id: uuid,
  instruction_request_id: uuid,
  started_at: time,
});

// 종료 확인(작업자 실행기만): 남은 프로세스 0개를 확인했다. 0이 아니면 이 영수증을 낼 수 없고 상태는 unknown_running이다.
// 세션 실행기는 본체의 후손을 볼 수 없어 이 영수증을 내지 않는다(D-50). 그 자리는 receipt_session_takeover다.
export const parseReceiptStopped = object({
  receipt_id: uuid,
  run_id: uuid,
  remaining_processes: literal(0),
  exit: oneOf(["completed", "cancelled", "deadline", "failed"]),
  stopped_at: time,
});

// 정리(작업자 실행기만): result_finalize를 받은 뒤 자격·tmp·작업 폴더를 지웠다. 실패하면 영수증 없이 cleanup_pending이다.
export const parseReceiptCleaned = object({
  receipt_id: uuid,
  run_id: uuid,
  instruction_request_id: uuid,
  cleaned_at: time,
});

// 세션 인수(D-50): 다음 세대의 실행기가 init이 만든 새 세대 표식과 한 번 쓰는 시작 허가로 앞 교체를 대조해 인수했다.
// 세 칸(앞 세대의 실행 ID, 새 세대 표식의 digest, 시작 허가 ID) 가운데 하나라도 없으면 무효다.
// 머리의 run_generation은 앞 세대 실행의 세대다(감독 장부의 값과 같아야 한다).
export const parseReceiptSessionTakeover = object({
  receipt_id: uuid,
  previous_run_id: uuid,
  new_generation_marker_digest: sha256,
  start_permit_id: uuid,
  taken_over_at: time,
});

export type ReceiptAccepted = ReturnType<typeof parseReceiptAccepted>;
export type ReceiptStarted = ReturnType<typeof parseReceiptStarted>;
export type ReceiptStopped = ReturnType<typeof parseReceiptStopped>;
export type ReceiptCleaned = ReturnType<typeof parseReceiptCleaned>;
export type ReceiptSessionTakeover = ReturnType<typeof parseReceiptSessionTakeover>;
