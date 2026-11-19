// 후보 내용 묶음(candidates.ts)이 주장하는 보장: 조각을 모아 digest가 맞으면 통과, 한 조각이 바뀌면 대조 실패, 감독이 낸 묻기와
// 현관이 낸 답 거절, 줄 수 없음과 무응답이 다른 값. 내용 칸이 다른 동작으로 새지 않는 것과 조각 크기가 봉투 틀에 드는 것도 본다.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson, digestOf, limits as v1Limits } from "../../../src/contract/v1/index.ts";
import { type Envelope, SealError } from "../../../src/contract/v2/contract.ts";
import {
  type AssemblyFault,
  assembleCandidate,
  CANDIDATE_BUNDLE,
  CANDIDATE_CONTENT_FIELD,
  CANDIDATE_FIELD_NAMES,
  type CandidateAssembly,
  type CandidateChunkReply,
  type CandidateFetchOutcome,
  candidateDigestOf,
  candidatePieceOf,
  FORBIDDEN_FIELD_NAMES,
  FRONTDOOR_CONTRACT,
  limits,
  SUPERVISOR_FORBIDDEN_FIELD_NAMES,
} from "../../../src/contract/v2/index.ts";
import { variant } from "./case-kit.ts";
import { buildCases } from "./cases.ts";
import { baseContext, type CaseContext, contextOf, envelope, freshKeys, id, ISSUED, nonceOf, trustedRaw } from "./support.ts";

const keys = freshKeys();
type Receiver = "supervisor" | "front-door";

// 받는 쪽: 인사가 끝났고 접수가 열려 있다. 조회라 세대는 몰라도 된다.
function at(message: unknown, receiver: Receiver, over: Partial<CaseContext> = {}) {
  return FRONTDOOR_CONTRACT.verify(message, contextOf(trustedRaw(keys, receiver), baseContext(receiver, { handshake: "agreed", intake_open: true, ...over })));
}

let n = 0xf00;
const fromFront = (action: string, body: unknown) => envelope(keys, { sender: "front-door", recipient: "supervisor", action, request_id: id(++n), nonce: nonceOf(n) }, body);
const fromSupervisor = (action: string, body: unknown) => envelope(keys, { sender: "supervisor", recipient: "front-door", action, request_id: id(++n), nonce: nonceOf(n) }, body);
const awaitingFetch = (fetch: Envelope) => ({ [fetch.header.request_id]: { action: "candidate_fetch", job: null } });

// 꾸며 낸 시험 글. 한국어 글자는 UTF-8로 3바이트라 조각 경계가 글자 가운데에 떨어진다(바이트 그대로 해시해야 맞는다).
const encode = (text: string) => new TextEncoder().encode(text);
const SHORT = encode("시험용으로 꾸며 낸 답 글이에요. 실제 대화가 아닙니다.");
// 33바이트 × 1,500 = 49,500바이트: 조각 둘(32KiB + 나머지).
const LONG = encode("꾸며 낸 시험 문장 하나. ".repeat(1_500));
const FULL = new Uint8Array(limits.CANDIDATE_MAX_BYTES).fill(0x61);

// 현관이 묻고 감독이 답하는 한 번의 왕복. 두 봉투 모두 실제 검증기를 지난다.
async function exchange(content: Uint8Array, digest: string, offset: number): Promise<CandidateFetchOutcome> {
  const fetch = fromFront("candidate_fetch", { candidate_digest: digest, offset });
  expect((await at(fetch, "supervisor")).ok).toBe(true);
  const reply = fromSupervisor("candidate_chunk", { in_reply_to: fetch.header.request_id, candidate_digest: digest, offset, piece: candidatePieceOf(content, offset) });
  const back = await at(reply, "front-door", { awaiting: awaitingFetch(fetch) });
  if (!back.ok) throw new Error(`답이 거절됨: ${back.reason}`);
  return { answered: true, reply: back.body as CandidateChunkReply };
}

// 현관의 묻기 순서: offset 0부터, 앞 조각의 끝을 다음 offset으로.
async function fetchAll(content: Uint8Array): Promise<CandidateFetchOutcome[]> {
  const digest = candidateDigestOf(content);
  const outcomes: CandidateFetchOutcome[] = [];
  for (let offset = 0; offset < content.length; ) {
    const outcome = await exchange(content, digest, offset);
    outcomes.push(outcome);
    if (!outcome.answered || outcome.reply.piece.state !== "chunk") break;
    offset += Buffer.from(outcome.reply.piece.chunk_b64url, "base64url").length;
  }
  return outcomes;
}

const chunkOf = (outcome: CandidateFetchOutcome) => {
  if (!outcome.answered || outcome.reply.piece.state !== "chunk") throw new Error("조각이 아니다");
  return { reply: outcome.reply, piece: outcome.reply.piece };
};
const withPiece = (outcome: CandidateFetchOutcome, piece: Record<string, unknown>, over: Record<string, unknown> = {}): CandidateFetchOutcome => {
  const { reply } = chunkOf(outcome);
  return { answered: true, reply: { ...reply, ...over, piece: { ...reply.piece, ...piece } } as CandidateChunkReply };
};
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

test("조각을 모아 digest가 맞으면 통과: 한 조각, 여러 조각, 상한 크기 모두 바이트 그대로 되돌아온다", async () => {
  for (const content of [SHORT, LONG, FULL]) {
    const outcomes = await fetchAll(content);
    expect(outcomes.length).toBe(Math.ceil(content.length / limits.CANDIDATE_CHUNK_MAX_BYTES));
    const got = assembleCandidate(candidateDigestOf(content), outcomes);
    expect(got.kind).toBe("complete");
    if (got.kind !== "complete") continue;
    expect(sameBytes(got.bytes, content)).toBe(true);
    expect(candidateDigestOf(got.bytes)).toBe(candidateDigestOf(content));
  }
  expect((await fetchAll(LONG)).length).toBe(2);
  // digest의 정의: 내용 바이트 그대로의 SHA-256. 본문 digest(정규 직렬화)와 다르다.
  expect(candidateDigestOf(SHORT)).toBe(createHash("sha256").update(SHORT).digest("hex"));
  expect(candidateDigestOf(SHORT)).not.toBe(digestOf(new TextDecoder().decode(SHORT)));
});

test("한 조각이 바뀌면 대조 실패: 감독이 서명한 답이라도 현관의 대조가 거절하고, 조각의 순서·겹침·빠짐·크기도 거절한다", async () => {
  const digest = candidateDigestOf(LONG);
  const outcomes = await fetchAll(LONG);
  expect(outcomes.length).toBe(2);
  const [first, second] = outcomes as [CandidateFetchOutcome, CandidateFetchOutcome];

  // 둘째 조각의 한 바이트를 바꾼다. 서명한 감독(또는 보관소)이 바꾼 것이라 계약 검증은 지난다.
  const flipped = Buffer.from(chunkOf(second).piece.chunk_b64url, "base64url");
  flipped[10] = flipped[10]! ^ 0x01;
  const tampered = withPiece(second, { chunk_b64url: flipped.toString("base64url") });
  const fetch = fromFront("candidate_fetch", { candidate_digest: digest, offset: chunkOf(second).reply.offset });
  const signed = fromSupervisor("candidate_chunk", { ...(tampered as { reply: CandidateChunkReply }).reply, in_reply_to: fetch.header.request_id });
  expect((await at(signed, "front-door", { awaiting: awaitingFetch(fetch) })).ok).toBe(true);
  expect(assembleCandidate(digest, [first, tampered])).toEqual({ kind: "rejected", fault: "digest_mismatch" });

  const rejected = (fault: AssemblyFault): CandidateAssembly => ({ kind: "rejected", fault });
  expect(assembleCandidate(digest, [second, first])).toEqual(rejected("order"));
  expect(assembleCandidate(digest, [first, first, second])).toEqual(rejected("overlap"));
  expect(assembleCandidate(digest, [second])).toEqual(rejected("gap"));
  expect(assembleCandidate(digest, [first])).toEqual(rejected("gap"));
  expect(assembleCandidate(digest, [])).toEqual(rejected("gap"));
  expect(assembleCandidate(digest, [first, withPiece(second, { total: LONG.length + 1 })])).toEqual(rejected("size_mismatch"));
  expect(assembleCandidate("e".repeat(64), [first, second])).toEqual(rejected("other_candidate"));
  expect(assembleCandidate(digest, [first, withPiece(second, {}, { candidate_digest: "e".repeat(64) })])).toEqual(rejected("other_candidate"));
  // 타입을 어긴 입력도 내용이 되지 않는다.
  expect(assembleCandidate(digest, [first, withPiece(second, { chunk_b64url: "a+b/" })])).toEqual(rejected("malformed"));
  expect(assembleCandidate(digest, [first, { answered: true } as never])).toEqual(rejected("malformed"));
  expect(assembleCandidate(digest, [first, { answered: false, cause: "gone" } as never])).toEqual(rejected("malformed"));
  expect(assembleCandidate("not-a-digest", [first, second])).toEqual(rejected("malformed"));
  expect(assembleCandidate(digest, [first, second]).kind).toBe("complete");
});

test("감독이 낸 묻기와 현관이 낸 답 거절: 받는 쪽은 wrong_direction이고 만들 수도 없다", async () => {
  const digest = candidateDigestOf(SHORT);
  const fetchBody = { candidate_digest: digest, offset: 0 };
  const fetch = fromFront("candidate_fetch", fetchBody);
  const replyBody = { in_reply_to: fetch.header.request_id, candidate_digest: digest, offset: 0, piece: candidatePieceOf(SHORT, 0) };

  // 바른 방향은 받는다.
  expect((await at(fetch, "supervisor")).ok).toBe(true);
  expect((await at(fromSupervisor("candidate_chunk", replyBody), "front-door", { awaiting: awaitingFetch(fetch) })).ok).toBe(true);
  // 감독이 자기 키로 낸 묻기, 현관이 자기 키로 낸 답.
  expect(await at(fromSupervisor("candidate_fetch", fetchBody), "front-door")).toEqual({ ok: false, reason: "wrong_direction" });
  const frontAnswer = fromFront("candidate_chunk", replyBody);
  expect(await at(frontAnswer, "supervisor", { awaiting: { [frontAnswer.header.request_id]: { action: "candidate_fetch", job: null } } })).toEqual({ ok: false, reason: "wrong_direction" });
  // 이름은 현관인데 감독의 키로 서명한 묻기는 서명부터 틀린다.
  const forged = envelope(keys, { sender: "front-door", recipient: "supervisor", action: "candidate_fetch", request_id: id(++n), nonce: nonceOf(n) }, fetchBody, "supervisor");
  expect(await at(forged, "supervisor")).toEqual({ ok: false, reason: "bad_signature" });

  const sealReason = (sender: Receiver, action: string, body: unknown) => {
    const recipient = sender === "supervisor" ? "front-door" : "supervisor";
    try {
      FRONTDOOR_CONTRACT.seal({ sender, recipient, action, request_id: id(0xfe0), issued_at: ISSUED, nonce: nonceOf(0xfe0), body }, keys[sender].privateKey);
      return "sealed";
    } catch (error) {
      return error instanceof SealError ? error.reason : String(error);
    }
  };
  expect(sealReason("supervisor", "candidate_fetch", fetchBody)).toBe("wrong_direction");
  expect(sealReason("front-door", "candidate_chunk", replyBody)).toBe("wrong_direction");
  expect(sealReason("front-door", "candidate_fetch", fetchBody)).toBe("sealed");
  expect(sealReason("supervisor", "candidate_chunk", replyBody)).toBe("sealed");
});

test("줄 수 없음과 무응답이 다른 값: unavailable은 감독의 답이고, 답이 없으면 unknown이다(없다는 뜻이 아니다)", async () => {
  const digest = candidateDigestOf(LONG);
  const fetch = fromFront("candidate_fetch", { candidate_digest: digest, offset: 0 });
  const unavailableBody = { in_reply_to: fetch.header.request_id, candidate_digest: digest, offset: 0, piece: { state: "unavailable" } };
  const verified = await at(fromSupervisor("candidate_chunk", unavailableBody), "front-door", { awaiting: awaitingFetch(fetch) });
  expect(verified.ok).toBe(true);
  if (!verified.ok) return;
  const unavailable: CandidateFetchOutcome = { answered: true, reply: verified.body as CandidateChunkReply };

  expect(assembleCandidate(digest, [unavailable])).toEqual({ kind: "unavailable" });
  for (const cause of ["timeout", "disconnected", "reply_rejected"] as const) {
    const silent: CandidateFetchOutcome = { answered: false, cause };
    expect(assembleCandidate(digest, [silent])).toEqual({ kind: "unknown", cause });
    expect(assembleCandidate(digest, [silent])).not.toEqual(assembleCandidate(digest, [unavailable]));
  }
  // 한 조각을 받고 다음 묻기의 답을 못 받으면 빠짐(gap)이 아니라 모름이다. 감독이 줄 수 없다고 했으면 시간 초과와 무관하게 unavailable이다.
  const [first] = await fetchAll(LONG);
  expect(assembleCandidate(digest, [first!, { answered: false, cause: "timeout" }])).toEqual({ kind: "unknown", cause: "timeout" });
  expect(assembleCandidate(digest, [first!, unavailable, { answered: false, cause: "timeout" }])).toEqual({ kind: "unavailable" });
  expect(assembleCandidate(digest, [{ answered: false, cause: "timeout" }, unavailable])).toEqual({ kind: "unavailable" });

  // 줄 수 없음은 한 값이다: 모르는 digest와 지워짐·만료를 가르는 상태나 사유 칸, 내용을 실을 수 없다.
  const reply = (piece: unknown) => at(fromSupervisor("candidate_chunk", { ...unavailableBody, piece }), "front-door", { awaiting: awaitingFetch(fetch) });
  for (const state of ["unknown_digest", "expired", "forgotten", "absent"]) expect(await reply({ state }), state).toEqual({ ok: false, reason: "body_malformed" });
  expect(await reply({ state: "unavailable", reason: "expired" })).toEqual({ ok: false, reason: "unknown_field" });
  expect(await reply({ state: "unavailable", [CANDIDATE_CONTENT_FIELD]: "YQ" })).toEqual({ ok: false, reason: "unknown_field" });
  for (const piece of [null, {}, "unavailable"]) expect(await reply(piece), JSON.stringify(piece)).toEqual({ ok: false, reason: "body_malformed" });

  // 타입: 답이 없는 결과는 답(reply)을 가질 수 없다.
  // @ts-expect-error 무응답에는 reply가 없다
  const noReply: CandidateFetchOutcome = { answered: false, cause: "timeout", reply: unavailable.reply };
  expect(noReply.answered).toBe(false);
});

test("정책이 어긋난 연결에서는 묻기도 답도 받지 않고, 접수가 닫혀도 받는다", async () => {
  const digest = candidateDigestOf(SHORT);
  const fetch = fromFront("candidate_fetch", { candidate_digest: digest, offset: 0 });
  const reply = fromSupervisor("candidate_chunk", { in_reply_to: fetch.header.request_id, candidate_digest: digest, offset: 0, piece: candidatePieceOf(SHORT, 0) });
  expect(await at(fetch, "supervisor", { handshake: "policy_mismatch" })).toEqual({ ok: false, reason: "policy_mismatch" });
  expect(await at(reply, "front-door", { handshake: "policy_mismatch", awaiting: awaitingFetch(fetch) })).toEqual({ ok: false, reason: "policy_mismatch" });
  expect(await at(fetch, "supervisor", { handshake: "none" })).toEqual({ ok: false, reason: "handshake_required" });
  expect((await at(fetch, "supervisor", { intake_open: false })).ok).toBe(true);
  expect((await at(reply, "front-door", { intake_open: false, awaiting: awaitingFetch(fetch) })).ok).toBe(true);
  // 묻지 않은 연결의 답, 다른 동작을 기다리는 자리에 온 답은 받지 않는다.
  expect(await at(reply, "front-door")).toEqual({ ok: false, reason: "reply_mismatch" });
  expect(await at(reply, "front-door", { awaiting: { [fetch.header.request_id]: { action: "execution_generation_lookup", job: null } } })).toEqual({ ok: false, reason: "reply_mismatch" });
});

test("내용 칸은 이 답 하나뿐이다: 금지 이름과 겹치지 않고, 다른 모든 동작의 본문(맨 위와 안쪽 객체)에 오면 unknown_field다", async () => {
  const normalize = (name: string) => name.toLowerCase().replace(/[-_\s]/g, "");
  const forbidden = new Set([...FORBIDDEN_FIELD_NAMES, ...SUPERVISOR_FORBIDDEN_FIELD_NAMES].map(normalize));
  expect(CANDIDATE_CONTENT_FIELD).toBe("chunk_b64url");
  for (const name of CANDIDATE_FIELD_NAMES) expect(forbidden.has(normalize(name)), name).toBe(false);

  // 공개 표본의 통과 사례마다 내용 칸을 맨 위와 안쪽 객체에 하나씩 넣어 다시 서명한다. 정당한 자리(조각 답의 piece) 하나만 뺀다.
  const cases = buildCases(keys).filter((c) => c.expect.ok);
  const objectPaths = (value: unknown, path: string[] = []): string[][] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    return [path, ...Object.entries(value).flatMap(([key, inner]) => objectPaths(inner, [...path, key]))];
  };
  const tried = new Set<string>();
  for (const base of cases) {
    for (const path of objectPaths(base.message.body)) {
      const holder = path.reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, base.message.body as Record<string, unknown>);
      if (Object.hasOwn(holder, CANDIDATE_CONTENT_FIELD)) continue;
      const leaked = variant(keys, base, {
        name: "leak",
        description: "",
        reason: "unknown_field",
        changed: [],
        edit: (c) => {
          const target = path.reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, c.message.body);
          target[CANDIDATE_CONTENT_FIELD] = "YQ";
        },
      });
      const got = await FRONTDOOR_CONTRACT.verify(leaked.message, contextOf(leaked.keys, leaked.context));
      expect(got, `${base.name} ${["body", ...path].join(".")}`).toEqual({ ok: false, reason: "unknown_field" });
      tried.add(base.message.header.action);
    }
  }
  expect([...tried].sort()).toEqual(Object.keys(FRONTDOOR_CONTRACT.actions).sort());
});

test("상한: 가장 큰 조각의 봉투가 봉투 하나의 틀 안에 들고, 경계 밖의 조각·위치·크기는 body_malformed다", async () => {
  // 전체 상한은 관리자 결정(2026-11-19)의 1MiB, 조각 32개다.
  expect(limits.CANDIDATE_MAX_BYTES).toBe(1_048_576);
  expect(limits.CANDIDATE_MAX_BYTES / limits.CANDIDATE_CHUNK_MAX_BYTES).toBe(32);
  expect(limits.MAX_MESSAGE_BYTES).toBe(v1Limits.MAX_MESSAGE_BYTES);
  expect(limits.CANDIDATE_CHUNK_MAX_BYTES).toBe(32 * 1024);

  const digest = candidateDigestOf(FULL);
  const fetch = fromFront("candidate_fetch", { candidate_digest: digest, offset: 0 });
  const biggest = fromSupervisor("candidate_chunk", { in_reply_to: fetch.header.request_id, candidate_digest: digest, offset: 0, piece: candidatePieceOf(FULL, 0) });
  expect((await at(biggest, "front-door", { awaiting: awaitingFetch(fetch) })).ok).toBe(true);
  // 선로의 바이트는 바이트 틀이 정한다(아직 없음). 정규 직렬화와 일반 직렬화 중 큰 쪽으로 잰다.
  const wire = Math.max(encode(canonicalJson(biggest as never)).length, encode(JSON.stringify(biggest)).length);
  expect(wire).toBeLessThanOrEqual(limits.MAX_MESSAGE_BYTES);
  // 한 단계 큰 2의 거듭제곱(48KiB는 2의 거듭제곱이 아니지만 그 사이 값)도 base64url만으로 틀을 채운다.
  expect(Math.ceil((48 * 1024 * 4) / 3)).toBeGreaterThanOrEqual(limits.MAX_MESSAGE_BYTES);

  const send = (body: Record<string, unknown>) => at(fromSupervisor("candidate_chunk", { in_reply_to: fetch.header.request_id, candidate_digest: digest, ...body }), "front-door", { awaiting: awaitingFetch(fetch) });
  const b64 = (size: number) => Buffer.alloc(size, 0x61).toString("base64url");
  const malformed = { ok: false, reason: "body_malformed" } as const;
  expect(await send({ offset: 0, piece: { state: "chunk", total: limits.CANDIDATE_MAX_BYTES, chunk_b64url: b64(limits.CANDIDATE_CHUNK_MAX_BYTES + 1) } })).toEqual(malformed);
  expect(await send({ offset: 0, piece: { state: "chunk", total: 1, chunk_b64url: "" } })).toEqual(malformed);
  expect(await send({ offset: 10, piece: { state: "chunk", total: 12, chunk_b64url: b64(3) } })).toEqual(malformed);
  expect(await send({ offset: 0, piece: { state: "chunk", total: limits.CANDIDATE_MAX_BYTES + 1, chunk_b64url: b64(3) } })).toEqual(malformed);
  expect(await send({ offset: limits.CANDIDATE_MAX_BYTES, piece: { state: "unavailable" } })).toEqual(malformed);
  // base64url이 아니거나(표준 문자, 패딩) 같은 바이트의 다른 표기(남는 비트)면 받지 않는다.
  for (const chunk of ["YWE=", "a+b/", "YR", "Y Q"]) expect(await send({ offset: 0, piece: { state: "chunk", total: 2, chunk_b64url: chunk } }), chunk).toEqual(malformed);
  expect((await send({ offset: 0, piece: { state: "chunk", total: 1, chunk_b64url: "YQ" } })).ok).toBe(true);

  const ask = (body: Record<string, unknown>) => at(fromFront("candidate_fetch", body), "supervisor");
  expect(await ask({ candidate_digest: digest, offset: limits.CANDIDATE_MAX_BYTES })).toEqual(malformed);
  expect(await ask({ candidate_digest: digest, offset: -1 })).toEqual(malformed);
  expect(await ask({ candidate_digest: digest.toUpperCase(), offset: 0 })).toEqual(malformed);
  expect(await ask({ candidate_digest: digest, offset: 0, length: 10 })).toEqual({ ok: false, reason: "unknown_field" });

  expect(() => candidatePieceOf(new Uint8Array(0), 0)).toThrow(RangeError);
  expect(() => candidatePieceOf(SHORT, SHORT.length)).toThrow(RangeError);
  expect(() => candidatePieceOf(new Uint8Array(limits.CANDIDATE_MAX_BYTES + 1), 0)).toThrow(RangeError);
});

test("상한의 경계: 1MiB 정확히는 받고 +1은 거절, 마지막 조각의 위치(1MiB - 32KiB, 1MiB - 1)까지만 묻고 답한다", async () => {
  const MAX = limits.CANDIDATE_MAX_BYTES;
  const CHUNK = limits.CANDIDATE_CHUNK_MAX_BYTES;
  const digest = candidateDigestOf(FULL);
  expect(FULL.length).toBe(MAX);
  const malformed = { ok: false, reason: "body_malformed" } as const;

  // 묻기: 마지막 바이트의 위치까지는 받고, 상한 위치(전체 크기를 넘는 위치)는 거절한다.
  const ask = (offset: number) => at(fromFront("candidate_fetch", { candidate_digest: digest, offset }), "supervisor");
  for (const offset of [MAX - CHUNK, MAX - 1]) expect((await ask(offset)).ok, `${offset}`).toBe(true);
  for (const offset of [MAX, MAX + 1]) expect(await ask(offset), `${offset}`).toEqual(malformed);

  // 답: 감독이 만든 마지막 조각 둘(꽉 찬 32KiB, 1바이트)을 받는다. 같은 자리의 total이 상한 +1이거나 조각이 total을 넘으면 거절한다.
  const fetch = fromFront("candidate_fetch", { candidate_digest: digest, offset: 0 });
  const send = (offset: number, piece: unknown) =>
    at(fromSupervisor("candidate_chunk", { in_reply_to: fetch.header.request_id, candidate_digest: digest, offset, piece }), "front-door", { awaiting: awaitingFetch(fetch) });
  const last = candidatePieceOf(FULL, MAX - CHUNK);
  expect(Buffer.from(last.chunk_b64url, "base64url").length).toBe(CHUNK);
  expect(last.total).toBe(MAX);
  expect((await send(MAX - CHUNK, last)).ok).toBe(true);
  const tail = candidatePieceOf(FULL, MAX - 1);
  expect(Buffer.from(tail.chunk_b64url, "base64url").length).toBe(1);
  expect((await send(MAX - 1, tail)).ok).toBe(true);
  expect(await send(MAX - 1, { ...tail, total: MAX + 1 })).toEqual(malformed);
  expect(await send(MAX - 1, { ...tail, chunk_b64url: Buffer.alloc(2, 0x61).toString("base64url") })).toEqual(malformed);
  expect(() => candidatePieceOf(FULL, MAX)).toThrow(RangeError);

  // 대조: 조각을 모은 합이 상한을 넘는 답(total이 상한 +1)은 꼴에서 막혀 내용이 되지 않는다.
  const outcomes = await fetchAll(FULL);
  expect(outcomes.length).toBe(32);
  const lastOutcome = outcomes[31]!;
  expect(chunkOf(lastOutcome).reply.offset).toBe(MAX - CHUNK);
  const overflow = [...outcomes.slice(0, 31).map((o) => withPiece(o, { total: MAX + 1 })), withPiece(lastOutcome, { total: MAX + 1 })];
  expect(assembleCandidate(digest, overflow)).toEqual({ kind: "rejected", fault: "malformed" });
  expect(assembleCandidate(digest, outcomes).kind).toBe("complete");
});

test("표: 후보 내용 묶음은 조회 둘(현관이 묻고 감독이 답함, 접수가 닫혀도 받고 정책이 어긋나면 받지 않음)이다", () => {
  const rows = Object.entries(CANDIDATE_BUNDLE.actions).map(([name, s]) => [name, s.class, [...s.from].join(","), s.duringClosedIntake, s.duringPolicyMismatch, s.generations]);
  expect(rows).toEqual([
    ["candidate_fetch", "query", "front-door", true, false, undefined],
    ["candidate_chunk", "query", "supervisor", true, false, undefined],
  ]);
  for (const name of Object.keys(CANDIDATE_BUNDLE.actions)) expect(FRONTDOOR_CONTRACT.actions[name], name).toBeDefined();
});
