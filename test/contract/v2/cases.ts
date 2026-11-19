// v2 표본(contracts/fixtures/v2/frontdoor/)의 사례 정의. 시험과 표본 생성(generate-fixtures.ts)이 같은 정의를 쓴다.
// 사례는 공개 면의 동작 표(FRONTDOOR_CONTRACT)만 쓴다. 거절 사례는 받아들이는 기준 사례 하나에서 적어 둔 곳만 바꿔 만든다.
// 키는 부를 때마다 새로 만든다. 개인 키는 이 프로세스 밖으로 나가지 않는다.
import { digestOf } from "../../../src/contract/v1/index.ts";
import type { HandshakeState } from "../../../src/contract/v2/actions.ts";
import { type Envelope, signUnchecked } from "../../../src/contract/v2/contract.ts";
import type { RejectReason } from "../../../src/contract/v2/errors.ts";
import type { Party } from "../../../src/contract/v2/header.ts";
import { baseContext, type CaseContext, envelope, id, type Keys, NOW, nonceOf, OTHER_POLICY, POLICY, trustedRaw } from "./support.ts";

// 표본 폴더. 생성기는 이 폴더 밖에 쓰지 않는다(acceptance.test.ts가 지킨다).
export const FIXTURE_DIR = "contracts/fixtures/v2/frontdoor";
export const FIXTURE_TAG = "olive-control/v2";

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

const HANDSHAKE_REQ = id(0x10);
const HANDSHAKE_REPLY_REQ = id(0x11);

function accept(keys: Keys, name: string, description: string, receiver: Party, context: CaseContext, message: Envelope, after: Expect & { ok: true }): V2Case {
  return { name: `accept/${name}`, description, status: "candidate", base: null, changed: [], expect: after, keys: trustedRaw(keys, receiver), context, message };
}

interface Variant {
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

function variant(keys: Keys, base: V2Case, v: Variant): V2Case {
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

export function buildCases(keys: Keys): V2Case[] {
  const handshakeMsg = (policy: string) =>
    envelope(keys, { sender: "front-door", recipient: "supervisor", action: "handshake", request_id: HANDSHAKE_REQ, nonce: nonceOf(1) }, { policy_revision: policy });
  const replyMsg = (policy: string) =>
    envelope(
      keys,
      { sender: "supervisor", recipient: "front-door", action: "handshake_reply", request_id: HANDSHAKE_REPLY_REQ, nonce: nonceOf(2) },
      { in_reply_to: HANDSHAKE_REQ, policy_revision: policy },
    );
  const supervisorSide = baseContext("supervisor");
  const frontSide = baseContext("front-door", { awaiting: { [HANDSHAKE_REQ]: { action: "handshake", job: null } } });

  const handshake = accept(keys, "handshake", "현관의 인사. 감독의 접수가 닫혀 있어도 받는다. 정책이 같아 agreed", "supervisor", supervisorSide, handshakeMsg(POLICY), {
    ok: true,
    handshake_after: "agreed",
  });
  const handshakePolicy = accept(
    keys,
    "handshake-policy-mismatch",
    "정책 revision이 다른 인사. 봉투는 받지만 이 연결은 policy_mismatch(효과 동작을 받지 않음)",
    "supervisor",
    supervisorSide,
    handshakeMsg(OTHER_POLICY),
    { ok: true, handshake_after: "policy_mismatch" },
  );
  const reply = accept(keys, "handshake-reply", "감독의 인사 답. 현관이 보내고 기다리는 인사를 가리킨다", "front-door", frontSide, replyMsg(POLICY), {
    ok: true,
    handshake_after: "agreed",
  });
  const replyPolicy = accept(
    keys,
    "handshake-reply-policy-mismatch",
    "감독의 정책 revision이 현관과 다름. 현관 쪽 연결도 policy_mismatch",
    "front-door",
    frontSide,
    replyMsg(OTHER_POLICY),
    { ok: true, handshake_after: "policy_mismatch" },
  );

  const H = (v: Variant) => variant(keys, handshake, v);
  const R = (v: Variant) => variant(keys, reply, v);
  return [
    handshake,
    handshakePolicy,
    reply,
    replyPolicy,
    H({
      name: "executor-sender",
      description: "실행기 이름의 낸 쪽. v2의 당사자는 현관과 감독뿐이다",
      reason: "malformed",
      changed: ["message.header.sender"],
      edit: (c) => void (c.message.header.sender = "executor/diagnosis/olive-diagnosis-0/st-d1a9"),
      signer: "front-door",
    }),
    H({
      name: "header-stop-generation",
      description: "머리에 정지 세대 칸. v2의 머리에는 세대 칸이 없다",
      reason: "unknown_field",
      changed: ["message.header.stop_generation"],
      edit: (c) => void (c.message.header.stop_generation = 3),
    }),
    H({
      name: "contract-v1",
      description: "실행기 계약의 판으로 온 인사. 판이 다르면 인사가 성립하지 않는다",
      reason: "contract_mismatch",
      changed: ["message.header.contract"],
      edit: (c) => void (c.message.header.contract = "olive-control/v1"),
    }),
    H({
      name: "contract-v3",
      description: "더 높은 판으로 온 인사",
      reason: "contract_mismatch",
      changed: ["message.header.contract"],
      edit: (c) => void (c.message.header.contract = "olive-control/v3"),
    }),
    H({
      name: "executor-instruction",
      description: "v1의 실행기 지시 이름(task_start)을 v2 판으로 현관의 키로 서명. v2의 동작이 아니다",
      reason: "unknown_action",
      changed: ["message.header.action"],
      edit: (c) => void (c.message.header.action = "task_start"),
    }),
    H({
      name: "reflected-own-message",
      description: "감독 이름으로 감독의 키로 서명해 감독에게 되돌린 봉투. 받는 쪽은 자기 키를 믿지 않는다",
      reason: "unknown_sender",
      changed: ["message.header.sender"],
      edit: (c) => void (c.message.header.sender = "supervisor"),
      signer: "supervisor",
    }),
    H({
      name: "signed-by-supervisor-key",
      description: "현관 이름인데 감독의 키로 서명한 인사",
      reason: "bad_signature",
      changed: ["message.signature"],
      edit: () => {},
      signer: "supervisor",
    }),
    R({
      name: "handshake-from-supervisor",
      description: "감독의 키로 서명한 현관 전용 동작(handshake)",
      reason: "wrong_direction",
      changed: ["message.header.action"],
      edit: (c) => void (c.message.header.action = "handshake"),
    }),
    H({
      name: "delivered-to-front-door",
      description: "감독 앞으로 낸 현관의 봉투가 현관에 닿음. 현관은 감독의 키만 믿으므로 현관 이름의 봉투는 서명 단계에서 거절된다",
      reason: "unknown_sender",
      changed: ["context.expected_recipient", "keys"],
      edit: (c) => void (c.context.expected_recipient = "front-door"),
      signer: null,
    }),
    H({
      name: "lifetime-over-30s",
      description: "수명이 30초를 1밀리초 넘음",
      reason: "lifetime_invalid",
      changed: ["message.header.expires_at"],
      edit: (c) => void (c.message.header.expires_at = (c.message.header.expires_at as number) + 1),
    }),
    H({
      name: "issued-in-future",
      description: "발급 시각이 받는 쪽 시계보다 1초 넘게 앞섬",
      reason: "not_yet_valid",
      changed: ["message.header.issued_at", "message.header.expires_at"],
      edit: (c) => {
        c.message.header.issued_at = NOW + 1_001;
        c.message.header.expires_at = NOW + 1_001 + 30_000;
      },
    }),
    H({
      name: "expired",
      description: "만료 시각 정각",
      reason: "expired",
      changed: ["message.header.issued_at", "message.header.expires_at"],
      edit: (c) => {
        c.message.header.issued_at = NOW - 30_000;
        c.message.header.expires_at = NOW;
      },
    }),
    H({
      name: "handshake-repeated",
      description: "인사가 끝난 연결에 다시 온 인사. 정책을 바꾸려면 연결을 새로 연다",
      reason: "handshake_repeated",
      changed: ["context.handshake"],
      edit: (c) => void (c.context.handshake = "agreed"),
      signer: null,
    }),
    H({
      name: "empty-policy-revision",
      description: "정책 revision이 빈 글",
      reason: "body_malformed",
      changed: ["message.body.policy_revision"],
      edit: (c) => void (c.message.body.policy_revision = ""),
    }),
    H({
      name: "body-changed-after-signing",
      description: "서명 뒤 본문의 정책 revision을 바꿈(머리의 digest는 그대로)",
      reason: "digest_mismatch",
      changed: ["message.body.policy_revision"],
      edit: (c) => void (c.message.body.policy_revision = OTHER_POLICY),
      digest: "keep",
      signer: null,
    }),
    H({
      name: "body-unknown-field",
      description: "인사 본문에 모르는 칸",
      reason: "unknown_field",
      changed: ["message.body.profile_revision"],
      edit: (c) => void (c.message.body.profile_revision = "profile-1"),
    }),
    H({
      name: "body-with-transcript",
      description: "본문에 금지 칸(원문 기록)",
      reason: "forbidden_field",
      changed: ["message.body.transcript"],
      edit: (c) => void (c.message.body.transcript = "…"),
    }),
    R({
      name: "supervisor-claims-approval",
      description: "감독이 낸 본문에 승인 주장 칸",
      reason: "forbidden_field",
      changed: ["message.body.approved"],
      edit: (c) => void (c.message.body.approved = true),
    }),
    R({
      name: "reply-to-other-request",
      description: "인사 답이 기다리지 않는 요청을 가리킴",
      reason: "reply_mismatch",
      changed: ["message.body.in_reply_to"],
      edit: (c) => void (c.message.body.in_reply_to = id(0x99)),
    }),
    R({
      name: "reply-not-awaited",
      description: "인사를 보내지 않은 연결에 온 인사 답",
      reason: "reply_mismatch",
      changed: ["context.awaiting"],
      edit: (c) => void (c.context.awaiting = {}),
      signer: null,
    }),
    H({
      name: "replayed-nonce",
      description: "이미 쓴 nonce",
      reason: "replayed",
      changed: ["context.spent_nonces"],
      edit: (c) => void (c.context.spent_nonces = [{ sender: "front-door", nonce: nonceOf(1) }]),
      signer: null,
    }),
  ];
}
