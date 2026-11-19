// 후보 내용 묶음(후보): 현관이 감독에게 출력 효과의 candidate_digest로 내용을 묻고, 감독이 조각으로 답한다. 현관은 받은 바이트를
// 그 digest와 스스로 대조한다(관리자 결정 2026-11-19). 내용(모델이 쓴 답 글, PR 본문)이 선로를 지나는 자리는 candidate_chunk의
// chunk_b64url 하나뿐이다. 어느 digest에 답할지, 보관 기한, 내용을 로그에 남기지 않는 것은 감독 처리기의 일이다. 표는 v2.md
// "후보 내용 조회".
import { createHash } from "node:crypto";
import type { Bundle, ExchangeSpec, NoAnswerCause } from "./actions.ts";
import { CANDIDATE_CHUNK_MAX_BYTES, CANDIDATE_MAX_BYTES } from "./limits.ts";
import { int, isPlainObject, literal, object, type Parser, SchemaError, SHA256, sha256, uuid } from "./schema.ts";

// 내용을 싣는 유일한 칸. 금지 이름(원문·비밀·v1, 감독 쪽 승인·목적지)과 겹치지 않고, 다른 동작의 본문은 모두 닫혀 있어
// 이 이름이 오면 unknown_field다. 금지 목록에 넣으면 이 답에서도 막히므로 넣지 않는다.
export const CANDIDATE_CONTENT_FIELD = "chunk_b64url";

export interface CandidateFetch {
  candidate_digest: string;
  offset: number;
}

// unavailable: 감독이 이 digest의 내용을 주지 않는다. 모르는 digest와 지워짐·만료를 가르지 않는다: 가르면 "이 내용이 한때
// 보관소에 있었다"가 새어, 짧은 글을 추측해 해시를 묻는 쪽이 그 글의 존재를 확인할 수 있다.
export type CandidatePiece = { state: "chunk"; total: number; chunk_b64url: string } | { state: "unavailable" };

export interface CandidateChunkReply {
  in_reply_to: string;
  candidate_digest: string;
  offset: number;
  piece: CandidatePiece;
}

// 현관이 한 번 물어 얻은 것. 답을 받지 못했으면(시간 초과, 끊김, 받은 답이 거절됨) 내용이 없다는 뜻이 아니다. 그래서 unavailable과
// 다른 갈래로 둔다.
export type CandidateFetchOutcome = { answered: true; reply: CandidateChunkReply } | { answered: false; cause: NoAnswerCause };

export const ASSEMBLY_FAULTS = ["malformed", "other_candidate", "size_mismatch", "order", "overlap", "gap", "digest_mismatch"] as const;
export type AssemblyFault = (typeof ASSEMBLY_FAULTS)[number];

// complete만 내용으로 쓴다. unavailable은 감독의 확정된 "줄 수 없음", unknown은 답이 없어 모름(같은 묻기를 다시 낼 수 있다).
export type CandidateAssembly =
  | { kind: "complete"; bytes: Uint8Array }
  | { kind: "rejected"; fault: AssemblyFault }
  | { kind: "unavailable" }
  | { kind: "unknown"; cause: NoAnswerCause };

const NO_ANSWER_CAUSES: readonly unknown[] = ["timeout", "disconnected", "reply_rejected"] satisfies readonly NoAnswerCause[];

// 후보의 digest: 보관소에 고정된 내용 바이트 그대로의 SHA-256(소문자 16진). 본문 digest(정규 직렬화)와 달리 어떤 정규화도 하지 않는다.
export function candidateDigestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const offset = int(0, CANDIDATE_MAX_BYTES - 1);
const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_CHUNK_CHARS = Math.ceil((CANDIDATE_CHUNK_MAX_BYTES * 4) / 3);

// 조각 바이트의 base64url(패딩 없음). 해석기는 남는 비트를 버려 한 바이트열에 여러 표기가 생기므로 다시 써서 같은 표기만 받는다.
// 길이를 먼저 보아 틀을 넘는 문자열은 풀지 않는다.
const chunkData: Parser<string> = (value, path) => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CHUNK_CHARS || !B64URL.test(value)) throw new SchemaError("malformed", path);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.length > CANDIDATE_CHUNK_MAX_BYTES || bytes.toString("base64url") !== value) throw new SchemaError("malformed", path);
  return value;
};

const parseFetch = object({ candidate_digest: sha256, offset });
const parseChunkPiece = object({ state: literal("chunk"), total: int(1, CANDIDATE_MAX_BYTES), chunk_b64url: chunkData });
const parseUnavailable = object({ state: literal("unavailable") });
const parseReplyShape = object({ in_reply_to: uuid, candidate_digest: sha256, offset, piece: (value: unknown) => value });

function parseCandidateChunk(body: unknown, path: string): CandidateChunkReply {
  const parsed = parseReplyShape(body, path);
  const raw = parsed.piece;
  if (!isPlainObject(raw)) throw new SchemaError("malformed", `${path}.piece`);
  let piece: CandidatePiece;
  if (raw.state === "chunk") {
    const chunk = parseChunkPiece(raw, `${path}.piece`);
    if (parsed.offset + Buffer.from(chunk.chunk_b64url, "base64url").length > chunk.total) throw new SchemaError("malformed", `${path}.piece.total`);
    piece = chunk;
  } else if (raw.state === "unavailable") {
    piece = parseUnavailable(raw, `${path}.piece`);
  } else {
    throw new SchemaError("malformed", `${path}.piece.state`);
  }
  return { ...parsed, piece };
}

// 감독 처리기가 답을 만들 때 쓰는 조각: offset부터 CANDIDATE_CHUNK_MAX_BYTES까지. 경계 밖이면 던진다(답하지 말고 처리기가 가른다).
export function candidatePieceOf(content: Uint8Array, at: number): CandidatePiece & { state: "chunk" } {
  if (content.length < 1 || content.length > CANDIDATE_MAX_BYTES) throw new RangeError("후보의 크기가 계약의 경계 밖이다");
  if (!Number.isSafeInteger(at) || at < 0 || at >= content.length) throw new RangeError("조각의 위치가 내용 밖이다");
  const end = Math.min(content.length, at + CANDIDATE_CHUNK_MAX_BYTES);
  return { state: "chunk", total: content.length, chunk_b64url: Buffer.from(content.subarray(at, end)).toString("base64url") };
}

const rejected = (fault: AssemblyFault): CandidateAssembly => ({ kind: "rejected", fault });

// 현관의 대조. 한 후보를 위해 낸 묻기마다의 결과를 offset 오름차순(현관이 묻는 순서: 0부터, 앞 조각의 끝을 다음 offset으로)으로 받는다.
// 판정 순서와 이유:
// 1. 꼴(타입을 어긴 입력도 런타임에 다시 본다)과 물은 digest의 되풀이. 서명이 맞아도 틀린 답은 무엇보다 먼저 거절한다.
// 2. 감독이 줄 수 없다고 한 답이 있으면 unavailable. 다른 묻기의 시간 초과가 있어도 결론은 같다(그 후보를 쓸 수 없다).
// 3. 답을 못 받은 묻기가 있으면 unknown. 빠진 조각을 gap으로 읽지 않는다(없다는 증거가 아니다).
// 4. 조각의 이어짐: 전체 크기가 하나인지, offset이 줄지 않는지, 0부터 total까지 겹침·빈틈이 없는지.
// 5. 이은 바이트의 digest. 앞의 검사를 다 지나도 내용이 하나라도 다르면 여기서 거절된다.
export function assembleCandidate(candidateDigest: string, outcomes: readonly CandidateFetchOutcome[]): CandidateAssembly {
  if (typeof candidateDigest !== "string" || !SHA256.test(candidateDigest) || !Array.isArray(outcomes)) return rejected("malformed");
  const chunks: { offset: number; total: number; bytes: Buffer }[] = [];
  let unavailable = false;
  let unanswered: NoAnswerCause | null = null;
  for (const outcome of outcomes as readonly unknown[]) {
    if (!isPlainObject(outcome)) return rejected("malformed");
    if (outcome.answered === false) {
      if (!NO_ANSWER_CAUSES.includes(outcome.cause)) return rejected("malformed");
      unanswered ??= outcome.cause as NoAnswerCause;
      continue;
    }
    if (outcome.answered !== true) return rejected("malformed");
    let reply: CandidateChunkReply;
    try {
      reply = parseCandidateChunk(outcome.reply, "reply");
    } catch {
      return rejected("malformed");
    }
    if (reply.candidate_digest !== candidateDigest) return rejected("other_candidate");
    if (reply.piece.state === "unavailable") unavailable = true;
    else chunks.push({ offset: reply.offset, total: reply.piece.total, bytes: Buffer.from(reply.piece.chunk_b64url, "base64url") });
  }
  if (unavailable) return { kind: "unavailable" };
  if (unanswered !== null) return { kind: "unknown", cause: unanswered };

  if (chunks.length === 0) return rejected("gap");
  const total = chunks[0]!.total;
  if (chunks.some((chunk) => chunk.total !== total)) return rejected("size_mismatch");
  for (let i = 1; i < chunks.length; i++) if (chunks[i]!.offset < chunks[i - 1]!.offset) return rejected("order");
  let end = 0;
  for (const chunk of chunks) {
    if (chunk.offset < end) return rejected("overlap");
    if (chunk.offset > end) return rejected("gap");
    end += chunk.bytes.length;
  }
  if (end !== total) return rejected("gap");
  const joined = Buffer.concat(chunks.map((chunk) => chunk.bytes));
  if (candidateDigestOf(joined) !== candidateDigest) return rejected("digest_mismatch");
  return { kind: "complete", bytes: new Uint8Array(joined) };
}

// 현관만 묻는다. 효과가 없고 세대를 싣지 않으므로 접수가 닫혀도 받는다(조회의 공통 규칙). 정책이 어긋난 연결에서는 받지 않는다:
// 후보의 내용은 계약 판이 뜻을 고정한 사실이 아니고, 그 연결에서는 내용이 쓰일 출력 효과도 막힌다.
const candidateFetch: ExchangeSpec = {
  class: "query",
  from: ["front-door"],
  duringClosedIntake: true,
  duringPolicyMismatch: false,
  parse: (body) => parseFetch(body, "body"),
};
// 감독만 답한다. in_reply_to가 이 연결에서 기다리는 candidate_fetch를 가리켜야 한다. 기다리는 요청(Awaited)에 묻기의 본문이 없어
// 물은 digest·offset과의 대조는 현관이 한다(assembleCandidate가 digest를, 최종 digest가 내용 전체를 본다).
const candidateChunk: ExchangeSpec = {
  class: "query",
  from: ["supervisor"],
  duringClosedIntake: true,
  duringPolicyMismatch: false,
  parse: (body) => parseCandidateChunk(body, "body"),
  answers: (awaitedAction) => awaitedAction === "candidate_fetch",
};

// 이 묶음의 본문이 가질 수 있는 칸 이름 전부. 금지 이름과 부딪히지 않는다는 것을 시험이 본다.
export const CANDIDATE_FIELD_NAMES: readonly string[] = Object.freeze(["candidate_digest", "offset", "in_reply_to", "piece", "state", "total", CANDIDATE_CONTENT_FIELD]);

export const CANDIDATE_BUNDLE: Bundle = {
  name: "candidates",
  actions: {
    candidate_fetch: candidateFetch,
    candidate_chunk: candidateChunk,
  },
};
