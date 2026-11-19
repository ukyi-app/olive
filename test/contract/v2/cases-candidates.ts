// 후보 내용 묶음(src/contract/v2/candidates.ts)의 표본 사례. cases.ts의 buildCases가 앞 묶음 사례 뒤에 붙인다.
// 표본의 내용은 꾸며 낸 짧은 글이다(실제 대화나 비밀처럼 보이는 것을 넣지 않는다). 요청 ID·nonce는 0x80~0x8f를 쓴다.
import { candidateDigestOf, candidatePieceOf } from "../../../src/contract/v2/candidates.ts";
import { CANDIDATE_MAX_BYTES } from "../../../src/contract/v2/limits.ts";
import { accept, type Expect, type V2Case, type Variant, variant } from "./case-kit.ts";
import { baseContext, type CaseContext, envelope, id, type Keys, nonceOf } from "./support.ts";

const OK: Expect & { ok: true } = { ok: true, handshake_after: null };
const CONTENT = new TextEncoder().encode("시험용으로 꾸며 낸 답 글이에요.");
const DIGEST = candidateDigestOf(CONTENT);
// 상한 크기(1MiB) 후보. 메모리에서만 만들고 표본에는 마지막 1바이트 조각과 그 digest만 실린다.
const FULL = new Uint8Array(CANDIDATE_MAX_BYTES).fill(0x61);
const FULL_DIGEST = candidateDigestOf(FULL);

export function buildCandidateCases(keys: Keys): V2Case[] {
  const fetchMsg = envelope(keys, { sender: "front-door", recipient: "supervisor", action: "candidate_fetch", request_id: id(0x80), nonce: nonceOf(0x80) }, { candidate_digest: DIGEST, offset: 0 });
  const answer = (n: number, piece: unknown) =>
    envelope(
      keys,
      { sender: "supervisor", recipient: "front-door", action: "candidate_chunk", request_id: id(n), nonce: nonceOf(n) },
      { in_reply_to: fetchMsg.header.request_id, candidate_digest: DIGEST, offset: 0, piece },
    );
  // 현관: 인사가 끝났고 candidate_fetch 하나를 보내 기다린다. 조회라 세대는 몰라도 된다.
  const atFront = (over: Partial<CaseContext> = {}) =>
    baseContext("front-door", { handshake: "agreed", intake_open: true, awaiting: { [fetchMsg.header.request_id]: { action: "candidate_fetch", job: null } }, ...over });

  const fetch = accept(
    keys,
    "candidate-fetch",
    "현관이 출력 효과의 candidate_digest로 그 내용의 첫 조각(offset 0)을 묻는다. 감독의 접수가 닫혀 있어도 받는다(조회)",
    "supervisor",
    baseContext("supervisor", { handshake: "agreed", intake_open: false }),
    fetchMsg,
    OK,
  );
  const chunk = accept(
    keys,
    "candidate-chunk",
    "감독이 내용 바이트의 조각으로 답한다(꾸며 낸 짧은 글 하나라 조각 하나가 전체). 현관은 조각을 모아 그 SHA-256을 candidate_digest와 대조한다(assembleCandidate)",
    "front-door",
    atFront(),
    answer(0x81, candidatePieceOf(CONTENT, 0)),
    OK,
  );
  const unavailable = accept(
    keys,
    "candidate-chunk-unavailable",
    "감독이 이 digest의 내용을 주지 않는다. 모르는 digest와 지워짐·만료를 가르지 않는 한 값이다. 답이 없는 것(시간 초과)과는 다른 값이다",
    "front-door",
    atFront(),
    answer(0x82, { state: "unavailable" }),
    OK,
  );

  // 상한의 경계: 1MiB 후보의 마지막 바이트(offset 1MiB - 1)를 묻고 1바이트 조각으로 답한다.
  const lastFetchMsg = envelope(
    keys,
    { sender: "front-door", recipient: "supervisor", action: "candidate_fetch", request_id: id(0x83), nonce: nonceOf(0x83) },
    { candidate_digest: FULL_DIGEST, offset: CANDIDATE_MAX_BYTES - 1 },
  );
  const lastFetch = accept(
    keys,
    "candidate-fetch-last-byte",
    "전체 상한(1MiB = 1,048,576바이트, 관리자 결정 2026-11-19) 크기 후보의 마지막 바이트 위치(1,048,575)를 묻는다. 받는 위치의 끝이다",
    "supervisor",
    baseContext("supervisor", { handshake: "agreed", intake_open: true }),
    lastFetchMsg,
    OK,
  );
  const lastChunk = accept(
    keys,
    "candidate-chunk-last-byte",
    "1MiB 후보의 마지막 1바이트 조각(total = 1,048,576, offset + 길이 = total). 32번째 조각의 끝이다",
    "front-door",
    baseContext("front-door", { handshake: "agreed", intake_open: true, awaiting: { [lastFetchMsg.header.request_id]: { action: "candidate_fetch", job: null } } }),
    envelope(
      keys,
      { sender: "supervisor", recipient: "front-door", action: "candidate_chunk", request_id: id(0x84), nonce: nonceOf(0x84) },
      { in_reply_to: lastFetchMsg.header.request_id, candidate_digest: FULL_DIGEST, offset: CANDIDATE_MAX_BYTES - 1, piece: candidatePieceOf(FULL, CANDIDATE_MAX_BYTES - 1) },
    ),
    OK,
  );

  const on = (base: V2Case) => (v: Variant) => variant(keys, base, v);
  return [
    fetch,
    chunk,
    unavailable,
    lastFetch,
    lastChunk,
    on(lastFetch)({
      name: "candidate-fetch-offset-at-limit",
      description: "전체 상한(1,048,576)과 같은 위치를 묻는다. 위치는 상한 미만이어야 한다",
      reason: "body_malformed",
      changed: ["message.body.offset"],
      edit: (c) => void (c.message.body.offset = CANDIDATE_MAX_BYTES),
    }),
    on(lastChunk)({
      name: "candidate-chunk-total-over-limit",
      description: "전체 크기가 상한 +1(1,048,577). 상한을 넘는 후보는 옮기지 않는다",
      reason: "body_malformed",
      changed: ["message.body.piece.total"],
      edit: (c) => void ((c.message.body.piece as { total: number }).total = CANDIDATE_MAX_BYTES + 1),
    }),
    on(fetch)({
      name: "candidate-fetch-policy-mismatch",
      description: "정책 revision이 어긋난 연결의 내용 묻기. 후보의 내용은 뜻이 고정된 사실이 아니라 받지 않는다",
      reason: "policy_mismatch",
      changed: ["context.handshake"],
      edit: (c) => void (c.context.handshake = "policy_mismatch"),
      signer: null,
    }),
    on(fetch)({
      name: "candidate-fetch-from-supervisor",
      description: "감독이 자기 키로 서명해 현관에게 낸 내용 묻기. 묻는 쪽은 현관뿐이다",
      reason: "wrong_direction",
      changed: ["message.header.sender", "message.header.recipient", "context.expected_recipient", "keys"],
      edit: (c) => {
        c.message.header.sender = "supervisor";
        c.message.header.recipient = "front-door";
        c.context.expected_recipient = "front-door";
      },
    }),
    on(fetch)({
      name: "candidate-fetch-with-content",
      description: "묻기에 내용 칸을 실음. 내용은 감독의 조각 답(piece) 한 자리로만 오간다",
      reason: "unknown_field",
      changed: ["message.body.chunk_b64url"],
      edit: (c) => void (c.message.body.chunk_b64url = "YQ"),
    }),
    on(chunk)({
      name: "candidate-chunk-policy-mismatch",
      description: "정책 revision이 어긋난 연결에 온 조각 답",
      reason: "policy_mismatch",
      changed: ["context.handshake"],
      edit: (c) => void (c.context.handshake = "policy_mismatch"),
      signer: null,
    }),
    on(chunk)({
      name: "candidate-chunk-from-front-door",
      description: "현관이 자기 키로 서명해 감독에게 낸 조각 답. 답하는 쪽은 감독뿐이다",
      reason: "wrong_direction",
      changed: ["message.header.sender", "message.header.recipient", "context.expected_recipient", "keys"],
      edit: (c) => {
        c.message.header.sender = "front-door";
        c.message.header.recipient = "supervisor";
        c.context.expected_recipient = "supervisor";
      },
    }),
    on(chunk)({
      name: "candidate-chunk-not-awaited",
      description: "묻지 않은 연결에 온 조각 답. 현관은 이 내용을 쓰지 않는다",
      reason: "reply_mismatch",
      changed: ["context.awaiting"],
      edit: (c) => void (c.context.awaiting = {}),
      signer: null,
    }),
    on(chunk)({
      name: "candidate-chunk-past-total",
      description: "조각이 전체 크기를 넘는다(offset + 조각 길이 > total)",
      reason: "body_malformed",
      changed: ["message.body.piece.total"],
      edit: (c) => void ((c.message.body.piece as { total: number }).total = 3),
    }),
    on(chunk)({
      name: "candidate-chunk-padded",
      description: "조각이 패딩이 붙은 base64. 같은 바이트의 표기를 하나로 고정하려고 패딩 없는 base64url만 받는다",
      reason: "body_malformed",
      changed: ["message.body.piece.chunk_b64url"],
      edit: (c) => void ((c.message.body.piece as { chunk_b64url: string }).chunk_b64url = "YQ=="),
    }),
    on(unavailable)({
      name: "candidate-chunk-unavailable-reason",
      description: "줄 수 없음에 사유 칸(expired). 모르는 digest와 지워짐·만료를 가르면 내용이 한때 있었는지가 샌다",
      reason: "unknown_field",
      changed: ["message.body.piece.reason"],
      edit: (c) => void ((c.message.body.piece as Record<string, unknown>).reason = "expired"),
    }),
    on(unavailable)({
      name: "candidate-chunk-unavailable-expired-state",
      description: "줄 수 없음을 따로 나눈 상태(expired). 상태는 chunk·unavailable 둘뿐이다",
      reason: "body_malformed",
      changed: ["message.body.piece.state"],
      edit: (c) => void ((c.message.body.piece as { state: string }).state = "expired"),
    }),
  ];
}
