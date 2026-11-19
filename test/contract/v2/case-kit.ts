// v2 표본 사례를 만드는 도구: 사례의 꼴, 통과 사례, 통과 사례에서 한 곳만 바꾼 거절 사례. 묶음마다 자기 사례 파일(cases-<묶음>.ts)에서
// 이 도구로 사례를 만들고 cases.ts의 buildCases가 모은다.
import { digestOf } from "../../../src/contract/v1/index.ts";
import type { HandshakeState } from "../../../src/contract/v2/actions.ts";
import { type Envelope, signUnchecked } from "../../../src/contract/v2/contract.ts";
import type { RejectReason } from "../../../src/contract/v2/errors.ts";
import type { Party } from "../../../src/contract/v2/header.ts";
import { type CaseContext, type Keys, trustedRaw } from "./support.ts";

export type Expect = { ok: true; handshake_after: Exclude<HandshakeState, "none"> | null } | { ok: false; reason: RejectReason };

export interface V2Case {
  name: string;
  description: string;
  status: "candidate";
  base: string | null;
  changed: string[];
  expect: Expect;
  // 받는 쪽이 믿는 공개 키(상대의 것 하나). 32바이트 원시 값의 base64url.
  keys: Record<string, string>;
  context: CaseContext;
  message: Envelope;
}

export function accept(keys: Keys, name: string, description: string, receiver: Party, context: CaseContext, message: Envelope, after: Expect & { ok: true }): V2Case {
  return { name: `accept/${name}`, description, status: "candidate", base: null, changed: [], expect: after, keys: trustedRaw(keys, receiver), context, message };
}

export interface Variant {
  name: string;
  description: string;
  reason: RejectReason;
  changed: string[];
  edit(c: { message: { header: Record<string, unknown>; body: Record<string, unknown> }; context: CaseContext }): void;
  // recompute: 본문을 바꾼 뒤 body_digest를 다시 맞춘다. keep: 머리를 그대로 둔다(서명 뒤 본문을 바꾼 사례).
  digest?: "recompute" | "keep";
  // 이 쪽의 키로 다시 서명한다. 없으면 머리의 sender(당사자가 아니면 현관)의 키다. null이면 처음 서명을 그대로 둔다.
  signer?: Party | null;
}

export function variant(keys: Keys, base: V2Case, v: Variant): V2Case {
  const message = structuredClone(base.message) as unknown as { header: Record<string, unknown>; body: Record<string, unknown>; signature: string };
  const context = structuredClone(base.context);
  v.edit({ message, context });
  if ((v.digest ?? "recompute") === "recompute") message.header.body_digest = digestOf(message.body);
  let signed: Envelope;
  if (v.signer === null) signed = { header: message.header, signature: base.message.signature, body: message.body } as unknown as Envelope;
  else {
    const sender = message.header.sender;
    const by: Party = v.signer ?? (sender === "supervisor" || sender === "front-door" ? sender : "front-door");
    signed = signUnchecked(message.header as never, message.body, keys[by].privateKey);
  }
  return {
    name: `reject/${v.name}`,
    description: v.description,
    status: "candidate",
    base: base.name,
    changed: v.changed,
    expect: { ok: false, reason: v.reason },
    // 믿는 키는 늘 받는 쪽의 상대 키다. 받는 쪽을 바꾼 사례는 키도 바뀐다(changed에 keys를 적는다).
    keys: trustedRaw(keys, context.expected_recipient),
    context,
    message: signed,
  };
}
