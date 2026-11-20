// 배정기가 바깥과 닿는 자리(포트)의 꼴. 타입만 둔다. 실제 구현(소켓, 시계, 난수, 서명 키)은 진입점 조각이 만든다.
// 순수 판단과 봉투 만들기(envelopes.ts)는 이 포트로만 시각·난수·서명·전송을 받으므로, 시험은 가짜 포트로 돌린다.
import type { Action, Envelope, SealInput } from "../../contract/v1/index.ts";
import type { CredentialRef } from "../../ledger/index.ts";

// 지금 시각. Unix epoch 밀리초의 안전 정수.
// 장부에 주입한 시계와 같은 시계여야 한다: 시작 지시의 발행 시각은 장부 시계가 정하고, 갱신 기록에 넘기는 now가 그보다 늦지 않으면
// 장부가 갱신의 끝을 적지 않는다. 후퇴하지 않아야 한다(nextIntent가 후퇴를 알 수 없다).
export interface Clock {
  now(): number;
}

// 암호학적 난수. 요청 ID·nonce·실행 ID가 모두 여기서 온다(계약 v1: nonce는 128비트 이상의 무작위 값, 요청 ID는 새 UUID).
// 실제 구현은 crypto.getRandomValues 같은 CSPRNG여야 한다. Math.random이나 시각에서 만든 값은 nonce 재생 방지와
// 요청 ID의 유일성을 깨므로 쓰지 않는다. 정확히 length 바이트를 돌려준다(길이가 다르면 envelopes.ts가 만들지 않는다).
export interface Random {
  bytes(length: number): Uint8Array;
}

// 감독의 서명 키로 봉투를 봉한다. 키 재료는 이 포트의 구현만 쥔다(배정기 모듈은 키를 보지 않는다).
// 구현은 계약 v1의 sealEnvelope(input, 감독 개인 키) 그대로여야 한다: 모양·방향·본문 검사와 수명(expires_at)을 계약이 정한다.
// 계약에 맞지 않으면 SealError를 던진다. envelopes.ts는 본문의 사본을 넘기고, 돌려받은 봉투의 머리 전부와 본문을 넘기기 전에
// 만든 기준과 대조한다. 서명 바이트는 공개 키가 없어 대조하지 못하므로 감독의 키로 머리에 서명하는 것은 이 구현의 책임이다.
export interface Signer {
  seal<A extends Action>(input: SealInput<A>): Envelope;
}

// 지시 내보내기의 결과. no_connection·too_late_to_send는 계약 v1의 전송 규칙 이름 그대로다(v1.md "전송").
// sent는 연결에 실었다는 뜻일 뿐 실행기가 받았다는 뜻이 아니다. 받았는지는 영수증으로만 안다.
export type SendOutcome = "sent" | "no_connection" | "too_late_to_send";

// 봉투 하나를 그 머리의 recipient가 가리키는 실행기의 연결 하나에 싣는다.
// - 연결이 살아 있지 않으면(mayIssue) 싣지 않고 no_connection. 쌓아 두었다가 다시 붙은 뒤 보내지 않는다.
// - 실제로 싣는 시각에 봉투 시한과 (시작이면) 본문의 작업 기한의 여유를 다시 본다. 봉할 때와 같은 여유(DELIVERY_MAX_MS + CLOCK_SKEW_MS)가
//   남지 않았으면 싣지 않고 too_late_to_send. 봉한 뒤 지난 시간만큼 줄었으므로 만들 때 본 것으로 대신하지 않는다.
// - 어느 거절이든 봉투를 고치거나 새 요청 ID로 다시 만들지 않는다. 그 실행은 장부에 그대로 두고 상태를 묻는다.
export interface InstructionSink {
  send(envelope: Envelope): Promise<SendOutcome>;
}

// 고른 계정(selectAccount의 account·method)에 지금 쓸 자격의 revision과 digest를 붙인다. 값은 싣지 않는다.
// 모르면 known: false이고 배정기는 그 실행을 시작하지 않는다(값을 지어내지 않는다).
// 아직 쓰는 곳이 없다. 배정·시작 순환이 붙일 때 꼴을 다시 본다.
export interface CredentialPort {
  reference(choice: { account: string; method: string }): Promise<{ known: true; credential: CredentialRef } | { known: false }>;
}
