// 묶음을 모아 v2 계약(동작 표, 검증, 만들기)을 만든다. 이 모듈은 입출력이 없다. 시계, 키, 인사 상태, 접수 상태, 기다리는 요청,
// nonce 저장소는 모두 인자로 받는다. 무작위 값(nonce, request_id, job_id)도 부르는 쪽이 만든다.
// 서명·digest의 바이트는 v1 공개 면의 canonicalJson·digestOf 하나로 만든다(정규화를 두 벌 두지 않는다).
import { type KeyObject, sign, verify } from "node:crypto";
import { canonicalJson, digestOf } from "../v1/index.ts";
import {
  type ActionClass,
  type ActionSpec,
  type ActionTable,
  type Awaited,
  BodyReject,
  type BodyContext,
  type Bundle,
  COMMON_BUNDLE,
  EFFECTS_DURING_POLICY_MISMATCH,
  EFFECTS_WITHOUT_GENERATIONS,
  type HandshakeState,
  type JobRef,
} from "./actions.ts";
import type { RejectReason } from "./errors.ts";
import { GENERATION_KINDS, type GenerationAuthorities, generationFieldFault, generationMismatch, isGenerationRules } from "./generations.ts";
import { type Header, isParty, type Party, parseHeader } from "./header.ts";
import { CLOCK_SKEW_MS, CONTRACT, MESSAGE_TTL_MAX_MS, MESSAGE_TTL_MS } from "./limits.ts";
import { ACTION_NAME, FORBIDDEN_FIELD_NAMES, findForbidden, isPlainObject, SchemaError, SUPERVISOR_FORBIDDEN_FIELD_NAMES, UUID } from "./schema.ts";

export interface Envelope {
  header: Header;
  signature: string;
  body: unknown;
}

export interface NonceStore {
  consume(sender: string, nonce: string, expiresAt: number): boolean | Promise<boolean>;
}

export interface VerifyContext {
  now: number;
  // 받는 쪽 자기 이름.
  expectedRecipient: Party;
  // 받는 쪽이 믿는 상대의 효과 서명 공개 키. 자기 이름에는 키를 주지 않는다(되돌아온 자기 봉투는 unknown_sender).
  publicKeyFor(sender: Party): KeyObject | undefined;
  // 이 연결의 인사 상태. 새 연결은 none이다.
  handshake: HandshakeState;
  // 받는 쪽의 접수가 열렸는가. 닫혔으면 duringClosedIntake가 아닌 효과 동작을 거절한다.
  intakeOpen: boolean;
  // 받는 쪽이 아는 정지 세대·실행 세대의 권위 값(모르면 { known: false }). 효과 동작의 본문 세대를 이것과 대조한다.
  generations: GenerationAuthorities;
  // 이 연결에서 보내고 답을 기다리는 요청(request_id로 찾는다). 없으면 undefined.
  awaiting(requestId: string): Awaited | undefined;
  nonces: NonceStore;
}

export type Verified = {
  ok: true;
  action: string;
  class: ActionClass;
  header: Header;
  body: unknown;
  sender: Party;
  recipient: Party;
  // 효과 요청이면 그 작업, 아니면 null.
  job: JobRef | null;
};
export type Rejected = { ok: false; reason: RejectReason };

export interface SealInput {
  sender: Party;
  recipient: Party;
  action: string;
  request_id: string;
  issued_at: number;
  nonce: string;
  body: unknown;
}

export class SealError extends Error {
  constructor(readonly reason: RejectReason) {
    super(`봉투를 만들 수 없다: ${reason}`);
  }
}

export interface Contract {
  readonly actions: ActionTable;
  verify(raw: unknown, ctx: VerifyContext): Promise<Verified | Rejected>;
  seal(input: SealInput, privateKey: KeyObject): Envelope;
}

const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const COMMON_FORBIDDEN = new Set<string>(FORBIDDEN_FIELD_NAMES);
const SUPERVISOR_FORBIDDEN = new Set<string>([...FORBIDDEN_FIELD_NAMES, ...SUPERVISOR_FORBIDDEN_FIELD_NAMES]);

export function signingBytes(header: Header): Uint8Array {
  return new TextEncoder().encode(canonicalJson(header));
}

const reject = (reason: RejectReason): Rejected => ({ ok: false, reason });

// 표를 한 번 만들고 얼린다. 묶음이 공통 규칙을 어기면 여기서 던진다(실행 중에 거절 사유로 새지 않게).
export function defineContract(bundles: readonly Bundle[]): Contract {
  if (bundles[0] !== COMMON_BUNDLE) throw new Error("첫 묶음은 공통부(COMMON_BUNDLE)다");
  const table: Record<string, ActionSpec> = {};
  for (const bundle of bundles) {
    for (const [name, spec] of Object.entries(bundle.actions)) {
      const where = `${bundle.name}.${name}`;
      if (!ACTION_NAME.test(name)) throw new Error(`${where}: 동작 이름의 꼴이 아니다`);
      if (Object.hasOwn(table, name)) throw new Error(`${where}: 이름이 겹친다`);
      if (spec.from.length === 0 || !spec.from.every(isParty)) throw new Error(`${where}: 보내는 쪽이 v2 당사자가 아니다`);
      if (spec.class === "handshake" && bundle !== COMMON_BUNDLE) throw new Error(`${where}: 인사 동작은 공통부만 둔다`);
      if (spec.class !== "effect" && !spec.duringClosedIntake) throw new Error(`${where}: 인사와 조회는 접수가 닫혀도 받는다`);
      if ((spec.class === "effect") !== (spec.parseResult !== undefined)) throw new Error(`${where}: 효과 동작만, 그리고 모두 parseResult를 둔다`);
      if (spec.class === "effect" && spec.answers !== undefined) throw new Error(`${where}: 효과 동작은 답이 아니다`);
      if (spec.matches !== undefined && spec.answers === undefined) throw new Error(`${where}: matches는 답 동작만 둔다`);
      if (typeof spec.duringPolicyMismatch !== "boolean") throw new Error(`${where}: 정책이 어긋난 연결에서 받는지(duringPolicyMismatch)를 선언한다`);
      if (spec.class === "effect" && spec.duringPolicyMismatch && !EFFECTS_DURING_POLICY_MISMATCH.includes(name)) {
        throw new Error(`${where}: 효과 동작은 정책이 어긋난 연결에서 받지 않는다(정지의 준비·확정만 예외)`);
      }
      if (spec.class === "effect" ? !isGenerationRules(spec.generations) : spec.generations !== undefined) {
        throw new Error(`${where}: 효과 동작만, 그리고 모두 정지·실행 세대 규칙(generations)을 닫힌 목록에서 하나씩 선언한다`);
      }
      if (spec.class === "effect" && GENERATION_KINDS.every((kind) => spec.generations[kind] === "not_applicable") && !EFFECTS_WITHOUT_GENERATIONS.includes(name)) {
        throw new Error(`${where}: 효과 동작은 세대 하나 이상을 싣는다(두 세대 모두 not_applicable은 EFFECTS_WITHOUT_GENERATIONS의 넷만 예외)`);
      }
      const from = Object.freeze([...spec.from]);
      table[name] = Object.freeze(spec.class === "effect" ? { ...spec, from, generations: Object.freeze({ ...spec.generations }) } : { ...spec, from });
    }
  }
  const actions: ActionTable = Object.freeze(table);
  return Object.freeze({
    actions,
    verify: (raw: unknown, ctx: VerifyContext) => verifyWith(actions, raw, ctx),
    seal: (input: SealInput, privateKey: KeyObject) => sealWith(actions, input, privateKey),
  });
}

// 검증 순서와 이유:
// 1. 모양(봉투 칸 → 계약 판 → 동작 → 머리 칸). 판과 동작을 먼저 보아 다른 판의 봉투를 이 판의 칸 규칙으로 해석하지 않는다.
// 2. 서명. 이 뒤의 확인은 머리를 믿고 하는 것이라 서명이 맞기 전에는 내용으로 판정하지 않는다. 키는 낸 쪽 이름으로 고른다.
// 3. 방향(그 동작을 낼 수 있는 쪽, 받는 쪽은 그 상대), 그다음 받는 쪽이 정말 나인지.
// 4. 시한.
// 5. 연결: 인사 상태(정책이 어긋난 연결은 duringPolicyMismatch인 동작만), 그다음 접수. 인사가 안 된 연결의 요청과 정책이 다른 연결에서
//    받지 않는 동작은 본문이 맞든 틀리든 받지 않으므로 본문보다 먼저 본다.
// 6. 본문: 정규화 → digest → 금지 칸 → 공통 칸(효과면 job_id, 답이면 in_reply_to) → (효과면 세대: 칸 → 권위 값과 대조) → 엄격한 모양.
//    digest를 먼저 보아 서명한 쪽이 보낸 본문인지부터 확인한다. 세대는 그 뒤라 서명한 쪽이 실은 값만 대조한다.
//    공통 칸은 여기서 원본에서 읽어 둔다. 묶음의 해석기가 반환값에서 빼거나 바꿔도 작업 참조와 답 대조는 서명된 값을 쓴다.
// 7. 답의 대조: 답이면 in_reply_to가 이 연결에서 기다리는 요청을 가리키고 같은 작업인지. 본문을 해석한 뒤라야 볼 수 있다.
// 8. nonce를 마지막에 쓴다. 다른 이유로 거절될 봉투가 nonce를 태우지 않는다.
async function verifyWith(table: ActionTable, raw: unknown, ctx: VerifyContext): Promise<Verified | Rejected> {
  // 1. 모양
  if (!isPlainObject(raw)) return reject("malformed");
  for (const key of Object.keys(raw)) if (!["header", "signature", "body"].includes(key)) return reject("unknown_field");
  if (!Object.hasOwn(raw, "header") || !Object.hasOwn(raw, "signature") || !Object.hasOwn(raw, "body")) return reject("malformed");
  const rawHeader = raw.header;
  if (!isPlainObject(rawHeader)) return reject("malformed");
  if (rawHeader.contract !== CONTRACT) return reject("contract_mismatch");
  if (typeof rawHeader.action !== "string" || !Object.hasOwn(table, rawHeader.action)) return reject("unknown_action");
  let header: Header;
  try {
    header = parseHeader(rawHeader, "header");
  } catch (error) {
    return reject(error instanceof SchemaError && error.fault === "unknown" ? "unknown_field" : "malformed");
  }
  const spec = table[header.action]!;

  // 2. 서명
  const key = ctx.publicKeyFor(header.sender);
  if (!key) return reject("unknown_sender");
  const signature = raw.signature;
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) return reject("bad_signature");
  const signatureBytes = Buffer.from(signature, "base64url");
  // base64url 해석기는 남는 비트를 버려 한 서명에 여러 표기가 생긴다. 다시 써서 같은 표기만 받는다(v1과 같은 규칙).
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64url") !== signature) return reject("bad_signature");
  if (!verify(null, signingBytes(header), key, signatureBytes)) return reject("bad_signature");

  // 3. 방향과 받는 쪽
  if (!spec.from.includes(header.sender) || header.recipient === header.sender) return reject("wrong_direction");
  if (header.recipient !== ctx.expectedRecipient) return reject("wrong_recipient");

  // 4. 시한
  const lifetime = header.expires_at - header.issued_at;
  if (lifetime <= 0 || lifetime > MESSAGE_TTL_MAX_MS) return reject("lifetime_invalid");
  if (header.issued_at > ctx.now + CLOCK_SKEW_MS) return reject("not_yet_valid");
  if (header.expires_at <= ctx.now) return reject("expired");

  // 5. 연결
  if (spec.class === "handshake") {
    if (ctx.handshake !== "none") return reject("handshake_repeated");
  } else if (ctx.handshake === "none") {
    return reject("handshake_required");
  } else if (ctx.handshake !== "agreed" && !spec.duringPolicyMismatch) {
    return reject("policy_mismatch");
  }
  if (!ctx.intakeOpen && !spec.duringClosedIntake) return reject("intake_closed");

  // 6. 본문
  let bodyDigest: string;
  try {
    bodyDigest = digestOf(raw.body);
  } catch {
    // v1 공개 면에 정규화 오류의 종류(CanonicalError)가 없어 종류로 가르지 않는다. 해석한 JSON 값에서 digestOf가 던지는 것은
    // 정규화 거절(소수, 짝 없는 서로게이트, 깊이 초과 등)뿐이다.
    return reject("body_malformed");
  }
  if (bodyDigest !== header.body_digest) return reject("digest_mismatch");
  if (findForbidden(raw.body, header.sender === "supervisor" ? SUPERVISOR_FORBIDDEN : COMMON_FORBIDDEN) !== undefined) return reject("forbidden_field");
  const jobId = spec.class === "effect" ? topUuid(raw.body, "job_id") : null;
  if (spec.class === "effect" && jobId === null) return reject("body_malformed");
  const inReplyTo = spec.answers !== undefined ? topUuid(raw.body, "in_reply_to") : null;
  if (spec.answers !== undefined && inReplyTo === null) return reject("body_malformed");
  if (spec.class === "effect") {
    // topUuid가 null이 아니면 본문은 평범한 객체다.
    const body = raw.body as Record<string, unknown>;
    const generationFault = generationFieldFault(spec.generations, body) ?? generationMismatch(spec.generations, body, ctx.generations);
    if (generationFault !== null) return reject(generationFault);
  }
  const bodyContext: BodyContext = { header, receivedAt: ctx.now, table };
  let body: unknown;
  try {
    body = spec.parse(raw.body, bodyContext);
  } catch (error) {
    if (error instanceof BodyReject) return reject(error.reason);
    if (error instanceof SchemaError) return reject(error.fault === "unknown" ? "unknown_field" : "body_malformed");
    throw error;
  }

  // 7. 답의 대조
  if (spec.answers !== undefined && inReplyTo !== null) {
    const awaited = ctx.awaiting(inReplyTo);
    if (awaited === undefined || !spec.answers(awaited.action, table)) return reject("reply_mismatch");
    if (spec.matches !== undefined && !spec.matches(body, awaited)) return reject("reply_mismatch");
  }

  // 8. nonce
  if (!(await ctx.nonces.consume(header.sender, header.nonce, header.expires_at))) return reject("replayed");

  const job = jobId !== null ? { job_id: jobId, action: header.action, request_digest: header.body_digest } : null;
  return { ok: true, action: header.action, class: spec.class, header, body, sender: header.sender, recipient: header.recipient, job };
}

// 본문 맨 위 칸의 소문자 UUID. 본문이 평범한 객체가 아니거나 칸이 없거나 꼴이 틀리면 null.
function topUuid(body: unknown, field: string): string | null {
  if (!isPlainObject(body)) return null;
  const value = body[field];
  return typeof value === "string" && UUID.test(value) ? value : null;
}

// 계약에 맞는 봉투만 만든다. 받는 쪽이 모양·방향·본문 때문에 거절할 봉투는 서명하기 전에 막는다.
// 인사 상태·접수·기다리는 요청은 받는 쪽의 상태라 여기서 보지 않는다.
function sealWith(table: ActionTable, input: SealInput, privateKey: KeyObject): Envelope {
  if (!Object.hasOwn(table, input.action)) throw new SealError("unknown_action");
  const spec = table[input.action]!;
  let digest: string;
  try {
    digest = digestOf(input.body);
  } catch {
    throw new SealError("body_malformed");
  }
  let header: Header;
  try {
    header = parseHeader(
      {
        contract: CONTRACT,
        sender: input.sender,
        recipient: input.recipient,
        action: input.action,
        request_id: input.request_id,
        body_digest: digest,
        issued_at: input.issued_at,
        expires_at: input.issued_at + MESSAGE_TTL_MS,
        nonce: input.nonce,
      },
      "header",
    );
  } catch {
    throw new SealError("malformed");
  }
  if (!spec.from.includes(header.sender) || header.recipient === header.sender) throw new SealError("wrong_direction");
  if (findForbidden(input.body, header.sender === "supervisor" ? SUPERVISOR_FORBIDDEN : COMMON_FORBIDDEN) !== undefined) throw new SealError("forbidden_field");
  if (spec.class === "effect" && topUuid(input.body, "job_id") === null) throw new SealError("body_malformed");
  if (spec.answers !== undefined && topUuid(input.body, "in_reply_to") === null) throw new SealError("body_malformed");
  if (spec.class === "effect") {
    const fault = generationFieldFault(spec.generations, input.body as Record<string, unknown>);
    if (fault !== null) throw new SealError(fault);
  }
  try {
    spec.parse(input.body, { header, receivedAt: null, table });
  } catch (error) {
    if (error instanceof BodyReject) throw new SealError(error.reason);
    if (error instanceof SchemaError) throw new SealError(error.fault === "unknown" ? "unknown_field" : "body_malformed");
    throw error;
  }
  return signUnchecked(header, input.body, privateKey);
}

// 검사 없이 서명한다. 거절 사례를 만드는 시험과 표본 생성에만 쓴다(index.ts가 내보내지 않는다).
export function signUnchecked(header: Header, body: unknown, privateKey: KeyObject): Envelope {
  const signature = sign(null, signingBytes(header), privateKey).toString("base64url");
  return { header, signature, body };
}

// 받아들인 인사 봉투(handshake, handshake_reply)에서 이 연결의 다음 인사 상태를 고른다. 판은 봉투가 이미 대조했다(contract_mismatch).
// 정책 revision은 문자 그대로 같아야 agreed다. 받는 쪽은 이 값을 연결 상태로 들고 다음 검증의 handshake로 준다.
export function afterHandshake(verified: Verified, ownPolicyRevision: string): Exclude<HandshakeState, "none"> {
  if (verified.class !== "handshake") throw new Error("인사 봉투가 아니다");
  const theirs = (verified.body as { policy_revision: string }).policy_revision;
  return theirs === ownPolicyRevision ? "agreed" : "policy_mismatch";
}
