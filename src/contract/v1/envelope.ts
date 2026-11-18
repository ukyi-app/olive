// 서명 봉투. 연결 위의 메시지는 모두 이 모양이다: { header, signature, body }.
// - 서명 대상: header 객체 전체의 정규 직렬화(canonical.ts)의 UTF-8 바이트. 서명은 Ed25519이고 base64url(패딩 없음, 86자)이다.
// - 본문은 header.body_digest(본문 정규 직렬화의 SHA-256)로 서명에 묶인다.
// - 모르는 칸은 봉투·머리·본문 어디서든 거절한다. 서명이 덮지 않는 칸이 뜻을 바꾸는 길을 없앤다.
// 이 모듈은 입출력이 없다. 시계, 키, 세대, nonce 저장소는 모두 인자로 받는다. 무작위 값(nonce, 요청 ID)도 부르는 쪽이 만든다.
import { createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { ACTION_SPECS, isAction } from "./actions.ts";
import { CanonicalError, canonicalJson, digestOf, utf8Bytes } from "./canonical.ts";
import type { RejectReason } from "./errors.ts";
import { type Action, type BodyContext, BodyReject, type Header, parseHeader } from "./header.ts";
import type { ResultFinalize, RunRenew, SessionStart, SessionStop, TaskCancel, TaskStart } from "./instruction.ts";
import { CLOCK_SKEW_MS, CONTRACT, MESSAGE_TTL_MS } from "./limits.ts";
import { type Principal, parsePrincipal } from "./principal.ts";
import type { ReceiptAccepted, ReceiptCleaned, ReceiptSessionTakeover, ReceiptStarted, ReceiptStopped } from "./receipt.ts";
import type { HookEvent, ResultReport, RuleCheck, SessionBroken } from "./report.ts";
import { findForbidden, SchemaError } from "./schema.ts";
import type { Ack, Hello, RunStatus, StatusQuery, StatusReport, StopSyncReply, StopSyncRequest } from "./transport.ts";

export interface Envelope {
  header: Header;
  signature: string;
  body: unknown;
}

export interface Bodies {
  session_start: SessionStart;
  session_stop: SessionStop;
  task_start: TaskStart;
  task_cancel: TaskCancel;
  run_renew: RunRenew;
  result_finalize: ResultFinalize;
  receipt_accepted: ReceiptAccepted;
  receipt_started: ReceiptStarted;
  receipt_stopped: ReceiptStopped;
  receipt_cleaned: ReceiptCleaned;
  receipt_session_takeover: ReceiptSessionTakeover;
  report_session_broken: SessionBroken;
  report_rule_check: RuleCheck;
  report_hook_event: HookEvent;
  report_result: ResultReport;
  hello: Hello;
  status_query: StatusQuery;
  status_report: StatusReport;
  ack: Ack;
  stop_sync_request: StopSyncRequest;
  stop_sync_reply: StopSyncReply;
}

// adoptedStopGeneration: 이 봉투가 받는 쪽의 정지 세대를 올렸으면(받는 쪽에 세대가 없었으면 처음 정했으면) 그 값, 아니면 null.
// 값을 주는 봉투는 비상 종료 지시 둘과 stop_sync_reply뿐이다.
// 이 함수는 값을 돌려줄 뿐 적용하지 않는다. 받는 쪽(실행기)은 이 봉투의 효과를 내기 전에, 새 세대를 지속 상태에 적고
// 그 세대보다 낮은 지시로 새 실행이 열리지 않게 막는 일을 한 번에(원자적으로) 해야 한다. v1.md "구현이 지킬 것" 참고.
export type Verified = {
  [A in Action]: {
    ok: true;
    action: A;
    header: Header;
    body: Bodies[A];
    sender: Principal;
    recipient: Principal;
    adoptedStopGeneration: number | null;
  };
}[Action];
export type Rejected = { ok: false; reason: RejectReason };

// nonce는 낸 쪽마다 한 번만 쓴다. consume은 처음 보는 (sender, nonce)면 기록하고 true, 이미 있으면 false를 돌려준다.
// expires_at은 기록을 언제 지워도 되는지 알려 준다(그 뒤로는 시한 검사가 먼저 거절한다).
export interface NonceStore {
  consume(sender: string, nonce: string, expiresAt: number): boolean | Promise<boolean>;
}

export interface VerifyContext {
  now: number;
  // 받는 쪽 자기 이름. 실행기면 저장소 ID까지 든 이름이다.
  expectedRecipient: string;
  publicKeyFor(sender: string): KeyObject | undefined;
  // 받는 쪽이 지금 적용한 정지 세대. 봉투의 값과 정확히 같아야 한다. 더 높은 값을 받아들이는 예외는 둘이다.
  // - 비상 종료 지시(task_cancel·session_stop의 reason emergency_stop): 받는 쪽이 아는 실행을 닫으며 새 세대를 옮긴다.
  // - stop_sync_reply: 연결의 첫 단계에서 감독이 서명한 지금의 세대. 같거나 높으면 받는다.
  // null은 "세대 없음"이다(저장소를 잃었거나 처음 뜬 실행기, 정지 기록을 아직 복원하지 못한 감독). 0과 다르다. 0은 "한 번도
  // 정지하지 않았다"는 알려진 세대이고, null은 모른다는 뜻이라 stop_sync_reply 밖의 모든 메시지를 거절한다(맞춤이 먼저다).
  stopGeneration: number | null;
  // 이 연결에서 보내고 아직 답을 기다리는 stop_sync_request의 challenge. 없으면 null(또는 생략)이고 그때 오는 답은 거절한다.
  stopSyncChallenge?: string | null;
  // 받는 쪽이 아는 실행의 세대. 모르는 실행이면 undefined.
  runGeneration(runId: string): number | undefined;
  nonces: NonceStore;
}

const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export function signingBytes(header: Header): Uint8Array {
  return utf8Bytes(canonicalJson(header));
}

const reject = (reason: RejectReason): Rejected => ({ ok: false, reason });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// 검증 순서와 이유:
// 1. 모양(봉투 칸 → 계약 판 → 동작 → 머리 칸). 값싼 확인으로 쓰레기에 서명 연산을 쓰지 않는다. 계약 판과 동작을 먼저 보는
//    이유는 다른 판의 봉투를 이 판의 칸 규칙으로 해석해 엉뚱한 사유(unknown_field)를 내지 않기 위해서다.
// 2. 서명. 이 뒤의 확인은 모두 머리의 내용을 믿고 하는 것이라, 서명이 맞기 전에는 내용으로 판정하지 않는다.
//    키는 낸 쪽 이름으로 고르므로, 다른 주체의 키로 서명한 봉투는 여기서 bad_signature다.
// 3. 방향(그 동작을 낼 수 있는 주체와 받을 수 있는 주체), 그다음 받는 쪽이 정말 나인지.
// 4. 시한. 수명이 30초를 넘거나 거꾸로면 lifetime_invalid, 발급이 미래면 not_yet_valid, 지났으면 expired.
//    본문을 해시하기 전에 보아 시한 지난 큰 본문에 일을 쓰지 않는다.
// 5. 본문: 정규화 → digest → 금지 칸 → 엄격한 모양 → 칸 사이·머리와의 관계(역할, 결과 크기 등).
//    digest를 모양보다 먼저 보는 이유: 서명한 쪽이 보낸 본문인지부터 확인해야 그 뒤의 거절 사유가 서명한 쪽의 잘못을 가리킨다.
//    받는 시각에만 보는 관계(이미 지난 작업 기한)도 여기서 본다(deadline_passed).
// 6. 세대: 정지 세대, 그다음 실행 세대. 서명이 맞아도 옛 세대면 거절한다.
//    정지 세대는 내려가지 않는다. 더 높은 값은 비상 종료 지시와 stop_sync_reply에서만 받아들인다(본문을 보므로 본문 뒤에 둔다).
//    stop_sync_reply는 challenge를 세대보다 먼저 본다. 이 연결의 답이 아니면 세대를 판단할 근거가 아니다.
//    stop_sync_request는 세대를 싣지 않는다(머리 0). 받는 쪽(감독)의 세대와 대조하지도, 올리지도 않는다. 다만 감독이 세대를
//    모르면(null, 정지 기록 복원 전) 요청부터 거절해 답을 만들 길을 닫는다.
//    hello·status_report는 실행마다 실린 세대를 받는 쪽이 아는 실행의 세대와 대조한다.
// 7. nonce를 마지막에 쓴다. 다른 이유로 거절될 봉투가 nonce를 태우지 않고, 받아들이는 봉투만 nonce를 쓴다.
export async function verifyEnvelope(raw: unknown, ctx: VerifyContext): Promise<Verified | Rejected> {
  // 1. 모양
  if (!isPlainObject(raw)) return reject("malformed");
  for (const key of Object.keys(raw)) if (!["header", "signature", "body"].includes(key)) return reject("unknown_field");
  if (!Object.hasOwn(raw, "header") || !Object.hasOwn(raw, "signature") || !Object.hasOwn(raw, "body")) return reject("malformed");
  const rawHeader = raw.header;
  if (!isPlainObject(rawHeader)) return reject("malformed");
  if (rawHeader.contract !== CONTRACT) return reject("contract_mismatch");
  if (!isAction(rawHeader.action)) return reject("unknown_action");
  let header: Header;
  try {
    header = parseHeader(rawHeader, "header");
  } catch (error) {
    return reject(error instanceof SchemaError && error.fault === "unknown" ? "unknown_field" : "malformed");
  }
  const sender = parsePrincipal(header.sender);
  const recipient = parsePrincipal(header.recipient);
  if (!sender || !recipient) return reject("malformed");
  const action = header.action;
  const spec = ACTION_SPECS[action];

  // 2. 서명
  const key = ctx.publicKeyFor(header.sender);
  if (!key) return reject("unknown_sender");
  const signature = raw.signature;
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) return reject("bad_signature");
  const signatureBytes = Buffer.from(signature, "base64url");
  // base64url 해석기는 남는 비트를 버려 한 서명에 여러 표기가 생긴다. 다시 써서 같은 표기만 받는다(옛 봇과 같은 규칙).
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64url") !== signature) return reject("bad_signature");
  if (!verify(null, signingBytes(header), key, signatureBytes)) return reject("bad_signature");

  // 3. 방향과 받는 쪽
  if (!spec.from.includes(sender.kind) || !spec.to.includes(recipient.kind)) return reject("wrong_direction");
  if (header.recipient !== ctx.expectedRecipient) return reject("wrong_recipient");

  // 4. 시한
  const lifetime = header.expires_at - header.issued_at;
  if (lifetime <= 0 || lifetime > (spec.lifetimeMs ?? MESSAGE_TTL_MS)) return reject("lifetime_invalid");
  if (header.issued_at > ctx.now + CLOCK_SKEW_MS) return reject("not_yet_valid");
  if (header.expires_at <= ctx.now) return reject("expired");

  // 5. 본문
  let bodyDigest: string;
  try {
    bodyDigest = digestOf(raw.body);
  } catch (error) {
    if (error instanceof CanonicalError) return reject("body_malformed");
    throw error;
  }
  if (bodyDigest !== header.body_digest) return reject("digest_mismatch");
  if (findForbidden(raw.body) !== undefined) return reject("forbidden_field");
  const bodyContext: BodyContext = { header, sender, recipient, receivedAt: ctx.now };
  let body: unknown;
  try {
    body = spec.parse(raw.body, bodyContext);
  } catch (error) {
    if (error instanceof BodyReject) return reject(error.reason);
    if (error instanceof SchemaError) return reject(error.fault === "unknown" ? "unknown_field" : error.fault === "forbidden" ? "forbidden_field" : "body_malformed");
    throw error;
  }

  // 6. 세대
  let adoptedStopGeneration: number | null = null;
  const current = ctx.stopGeneration;
  if (spec.stopSync === "reply") {
    const pending = ctx.stopSyncChallenge ?? null;
    if (pending === null || (body as StopSyncReply).challenge !== pending) return reject("challenge_mismatch");
    if (current !== null && header.stop_generation < current) return reject("stop_generation_mismatch");
    if (current === null || header.stop_generation > current) adoptedStopGeneration = header.stop_generation;
  } else if (spec.stopSync === "request") {
    if (current === null || header.stop_generation !== 0) return reject("stop_generation_mismatch");
  } else if (current === null) {
    return reject("stop_generation_mismatch");
  } else if (header.stop_generation !== current) {
    const advances = header.stop_generation > current && spec.advancesStop?.(body) === true;
    if (!advances) return reject("stop_generation_mismatch");
    adoptedStopGeneration = header.stop_generation;
  }
  if (spec.runList !== undefined) {
    for (const run of (body as Record<string, unknown>)[spec.runList] as RunStatus[]) {
      if (run.run_generation === null) continue;
      const known = ctx.runGeneration(run.run_id);
      if (known !== undefined && known !== run.run_generation) return reject("run_generation_mismatch");
    }
  }
  if (spec.runField === null) {
    if (header.run_generation !== 0) return reject("run_generation_mismatch");
  } else {
    const runId = (body as Record<string, unknown>)[spec.runField] as string;
    const known = ctx.runGeneration(runId);
    if (known === undefined) {
      if (!spec.opensRun) return reject("unknown_run");
      if (header.run_generation < 1) return reject("run_generation_mismatch");
    } else if (known !== header.run_generation) {
      return reject("run_generation_mismatch");
    }
  }

  // 7. nonce
  if (!(await ctx.nonces.consume(header.sender, header.nonce, header.expires_at))) return reject("replayed");

  return { ok: true, action, header, body, sender, recipient, adoptedStopGeneration } as Verified;
}

// ---- 만들기 ----

export interface SealInput<A extends Action> {
  sender: string;
  recipient: string;
  action: A;
  request_id: string;
  stop_generation: number;
  run_generation: number;
  issued_at: number;
  nonce: string;
  body: Bodies[A];
}

export class SealError extends Error {
  constructor(readonly reason: RejectReason) {
    super(`봉투를 만들 수 없다: ${reason}`);
  }
}

// 계약에 맞는 봉투만 만든다. 받는 쪽이 모양·방향·본문 때문에 거절할 봉투는 서명하기 전에 막는다.
// 수명은 동작의 상한(정지 세대 맞춤은 STOP_SYNC_TTL_MS, 나머지는 MESSAGE_TTL_MS)을 꽉 채운다.
// 세대와 받는 쪽이 맞는지는 서명하는 쪽 장부의 일이라 여기서 보지 않는다.
export function sealEnvelope<A extends Action>(input: SealInput<A>, privateKey: KeyObject): Envelope {
  const spec = ACTION_SPECS[input.action];
  const header = buildHeader(input, input.issued_at + (spec.lifetimeMs ?? MESSAGE_TTL_MS));
  const sender = parsePrincipal(header.sender);
  const recipient = parsePrincipal(header.recipient);
  if (!sender || !recipient) throw new SealError("malformed");
  if (!spec.from.includes(sender.kind) || !spec.to.includes(recipient.kind)) throw new SealError("wrong_direction");
  if (findForbidden(input.body) !== undefined) throw new SealError("forbidden_field");
  try {
    spec.parse(input.body, { header, sender, recipient, receivedAt: null });
  } catch (error) {
    if (error instanceof SealError) throw error;
    if (error instanceof BodyReject) throw new SealError(error.reason);
    if (error instanceof SchemaError || error instanceof CanonicalError) throw new SealError("body_malformed");
    throw error;
  }
  return signUnchecked(header, input.body, privateKey);
}

function buildHeader(input: Omit<SealInput<Action>, "body"> & { body: unknown }, expiresAt: number): Header {
  let digest: string;
  try {
    digest = digestOf(input.body);
  } catch {
    throw new SealError("body_malformed");
  }
  const draft = {
    contract: CONTRACT,
    sender: input.sender,
    recipient: input.recipient,
    action: input.action,
    request_id: input.request_id,
    stop_generation: input.stop_generation,
    run_generation: input.run_generation,
    body_digest: digest,
    issued_at: input.issued_at,
    expires_at: expiresAt,
    nonce: input.nonce,
  };
  try {
    return parseHeader(draft, "header");
  } catch {
    throw new SealError("malformed");
  }
}

// 검사 없이 서명한다. 거절 사례를 만드는 시험과 fixture 생성에만 쓴다(index.ts가 내보내지 않는다).
export function signUnchecked(header: Header, body: unknown, privateKey: KeyObject): Envelope {
  const signature = sign(null, signingBytes(header), privateKey).toString("base64url");
  return { header, signature, body };
}

// ---- 공개 키 ----

// fixture와 다른 구현은 공개 키를 32바이트 원시 값의 base64url(43자)로 주고받는다.
export function publicKeyFromRaw(raw: string): KeyObject {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw) || Buffer.from(raw, "base64url").toString("base64url") !== raw) {
    throw new Error("Ed25519 공개 키는 32바이트의 base64url(43자)이다");
  }
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw }, format: "jwk" });
}

export function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("Ed25519 공개 키가 아니다");
  return jwk.x;
}
