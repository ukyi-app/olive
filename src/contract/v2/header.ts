// v2 봉투의 머리. 서명은 이 객체(모든 칸)의 정규 직렬화에 건다.
// 정지 세대·실행 세대는 머리 칸이 아니다. 그 값이 뜻을 갖는 동작의 본문에 두면 body_digest로 서명에 묶인다(v2.md "봉투").
// 승인·최종 목적지·권한을 주장하는 칸은 머리에 두지 않는다.
import { CONTRACT } from "./limits.ts";
import { ACTION_NAME, literal, NONCE, object, oneOf, pattern, sha256, time, uuid } from "./schema.ts";

// v2의 당사자는 둘뿐이다. 실행기 이름은 머리의 꼴부터 틀린다(malformed).
export const PARTIES = ["front-door", "supervisor"] as const;
export type Party = (typeof PARTIES)[number];

export function isParty(value: unknown): value is Party {
  return typeof value === "string" && (PARTIES as readonly string[]).includes(value);
}

export const parseHeader = object({
  contract: literal(CONTRACT),
  sender: oneOf(PARTIES),
  recipient: oneOf(PARTIES),
  action: pattern(ACTION_NAME),
  request_id: uuid,
  body_digest: sha256,
  issued_at: time,
  expires_at: time,
  nonce: pattern(NONCE),
});
export type Header = ReturnType<typeof parseHeader>;
