// 연결 위의 바이트를 틀 단위로 자르고 잇는다. 서명·동작은 보지 않는다(받는 쪽 verifyEnvelope의 일이다). 선로 형식의 바이트 표는 framing.md.
// 틀은 두 종류다. 머리 4바이트의 첫 바이트가 종류이고, 종류는 JSON 해석 전에 이 바이트만으로 정한다.
// - 봉투 틀 = 길이 접두 4바이트(부호 없는 정수, big-endian) + 봉투 바이트(UTF-8 JSON). 접두는 봉투 바이트의 수만 센다(접두 자신은 빼고).
//   봉투 상한이 64KiB라 접두의 첫 바이트는 늘 0이다. 그 0이 봉투 종류(FRAME_KIND_ENVELOPE)라서 봉투 틀의 바이트는 종류가 없던 형식과 같다.
// - 자격 값 틀 = 종류 0x01 + 값 길이 3바이트(big-endian) + 실행 ID 36바이트 + 지문 64바이트(둘 다 ASCII) + 값 바이트.
//   값은 해석하지 않는다(JSON 해석기·TextDecoder를 지나지 않는다). 값 틀에는 서명이 없다: 누가 보냈는지는 연결(상호 TLS)이,
//   어느 값을 쓸지는 서명된 시작 지시의 지문 대조가 정한다. 이 모듈은 형식만 본다.
// 길이 0은 받지 않는다(빈 글은 JSON이 아니고, 0을 허용하면 상대가 접두만으로 연결을 붙잡을 수 있다).
// 이 자리가 인증 전 바이트를 처음 받는 곳이라 순서가 중요하다:
// 1. 길이가 그 종류의 상한(봉투 MAX_MESSAGE_BYTES, 값 CREDENTIAL_MAX_BYTES)을 넘으면 버퍼를 잡기 전에 거절한다.
// 2. 봉투 본문이 다 오면 UTF-8 → 문법·중복 키·깊이를 훑는다. 훑는 중에는 문자열 토큰(키와 문자열 값)만 하나씩 JSON.parse로 풀고,
//    봉투 전체를 값으로 만드는 JSON.parse(text)는 모든 검사를 마친 뒤 한 번 한다. JSON.parse는 같은 키를 뒤의 값으로 덮으므로,
//    덮인 뒤에는 무엇이 서명됐는지 가릴 수 없다(계약의 정규 직렬화는 해석한 값에서 바이트를 다시 만든다).
// 3. 값 틀은 실행 ID·지문의 꼴을 본 뒤에야 값 버퍼를 잡는다.
// 메모리: push 호출 사이에 디코더가 쥐고 있는 미완성 틀의 바이트(머리 칸과 조립 중인 버퍼)는 최대 65,540바이트다(봉투 틀 4 + 65,536).
// 값 틀은 최대 4 + 100 + CREDENTIAL_MAX_BYTES = 16,488바이트를 쥐므로 이 상한을 늘리지 않는다.
// 한 번의 push가 완성해 돌려주는 틀들의 바이트(봉투 바이트, 값 틀의 실행 ID·지문·값)는 이 상한에 들지 않고 넣은 조각의 크기에 비례한다
// (조각 + 직전에 쥐고 있던 미완성 틀 이하). 한 번의 반환량은 부르는 쪽이 조각의 크기로 묶는다.
// 거절하면 그 디코더는 끝난다. 다시 동기화하지 않는다: 틀이 어긋난 뒤의 바이트는 어디가 경계인지 믿을 근거가 없다.
// 거절 사유는 이름뿐이다. 거절 사유와 던진 오류, 그리고 거절된 틀 자체의 바이트는 반환값에 실리지 않는다.
// 거절과 함께 돌아온 step에는 그 앞에 완성된 정상 값 틀이 들어 있을 수 있다. 진단에는 rejected의 이름만 쓰고 step·완성된 값 틀·만든 틀을
// 통째로 기록하지 않는다. 앞선 정상 값의 소유는 받은 쪽에 있다(쓰거나 버릴 때 0으로 채운다).
import { limits } from "../contract/v1/index.ts";

export const FRAME_PREFIX_BYTES = 4;
export const FRAME_MAX_BODY_BYTES = limits.MAX_MESSAGE_BYTES;

export const FRAME_KIND_ENVELOPE = 0x00;
export const FRAME_KIND_CREDENTIAL = 0x01;

// 값 바이트의 상한. 실제 토큰의 크기는 확인하지 않았다. 값은 환경 변수 하나로 넘겨져 HTTP 머리에 실린다고 보고, Node.js·Bun의
// 받는 HTTP 머리 전체의 기본 상한(http.maxHeaderSize 16,384)과 같게 잡았다(근거와 올릴 수 있는 범위는 framing.md).
// 4 + CREDENTIAL_HEAD_BYTES + 이 값이 4 + FRAME_MAX_BODY_BYTES를 넘으면 미완성 틀의 메모리 상한이 커진다.
export const CREDENTIAL_MAX_BYTES = 16 * 1024;
// 실행 ID는 계약 v1의 UUID 꼴(소문자 16진 8-4-4-4-12), 지문은 credential.digest의 꼴(소문자 16진 64자)의 ASCII 그대로다.
// 시작 지시에 서명된 글과 같은 꼴이라 받는 쪽이 변환 없이 같은 글로 대조한다.
export const CREDENTIAL_RUN_ID_BYTES = 36;
export const CREDENTIAL_DIGEST_BYTES = 64;
export const CREDENTIAL_HEAD_BYTES = CREDENTIAL_RUN_ID_BYTES + CREDENTIAL_DIGEST_BYTES;

export const FRAME_REJECT_REASONS = [
  // 접두가 0을 말한다.
  "frame_empty",
  // 접두가 FRAME_MAX_BODY_BYTES를 넘는다. 본문 버퍼를 잡기 전에 거절한다.
  "frame_too_large",
  // 끝 알림이 틀의 중간(접두의 중간이나 본문의 중간)에서 왔다.
  "frame_truncated",
  "frame_bad_utf8",
  "frame_not_json",
  // 한 객체에 같은 키가 두 번 있다(이스케이프를 풀어 같은 이름이면 같은 키다).
  "frame_duplicate_key",
  // 깊이가 MAX_DEPTH를 넘는다. 정규 직렬화(canonical.ts)와 같은 경계다: 뿌리 값이 0이고 MAX_DEPTH까지 받는다.
  "frame_too_deep",
  // 끝 알림 뒤에 조각이 왔다.
  "frame_after_end",
] as const;
export type FrameRejectReason = (typeof FRAME_REJECT_REASONS)[number];

export interface DecodedEnvelope {
  // 접두를 뺀 봉투 바이트. 디코더가 다시 쓰지 않는 새 배열이다.
  readonly bytes: Uint8Array;
  // 중복 키·깊이를 확인한 뒤 해석한 값. verifyEnvelope가 받는 꼴이다.
  readonly value: unknown;
}

// 한 번의 push·end가 낸 것. 거절이 있으면 그 앞의 온전한 틀은 envelopes에 들어 있고, 그 뒤의 바이트는 보지 않았다.
export interface DecodeStep {
  readonly envelopes: readonly DecodedEnvelope[];
  readonly rejected: FrameRejectReason | null;
}

export interface FrameDecoder {
  push(chunk: Uint8Array): DecodeStep;
  // 입력의 끝. 틀의 중간이면 frame_truncated다.
  end(): DecodeStep;
  // 미완성 틀을 담는 버퍼의 크기(접두 칸 + 조립 중인 본문 버퍼). push 호출 사이에는 FRAME_PREFIX_BYTES + FRAME_MAX_BODY_BYTES를 넘지 않는다.
  // push가 돌려준 봉투의 바이트는 세지 않는다.
  heldBytes(): number;
}

export type EncodeResult = { readonly ok: true; readonly frame: Uint8Array } | { readonly ok: false; readonly reason: "frame_empty" | "frame_too_large" };

export function encodeFrame(envelope: Uint8Array): EncodeResult {
  if (envelope.length === 0) return { ok: false, reason: "frame_empty" };
  if (envelope.length > FRAME_MAX_BODY_BYTES) return { ok: false, reason: "frame_too_large" };
  const frame = new Uint8Array(FRAME_PREFIX_BYTES + envelope.length);
  new DataView(frame.buffer).setUint32(0, envelope.length, false);
  frame.set(envelope, FRAME_PREFIX_BYTES);
  return { ok: true, frame };
}

// 봉투만 받는 디코더(감독처럼 값을 받지 않는 쪽). 머리 4바이트를 한 정수로 읽으므로 값 틀(첫 바이트 0x01)은 길이 16,777,216 이상으로
// 읽혀 frame_too_large로 버퍼를 잡기 전에 거절되고 디코더가 끝난다. 값 틀을 봉투로 해석하는 일은 없다.
export function createFrameDecoder(): FrameDecoder {
  return new Decoder();
}

// 봉투만 받는 디코더는 내지 않는 사유. frame_unknown_kind만 섞어 받는 디코더 전용이고, 나머지 넷은 encodeCredentialFrame도 낸다.
export const CREDENTIAL_FRAME_REJECT_REASONS = [
  // 머리의 첫 바이트가 봉투(0x00)도 값(0x01)도 아니다. 그 한 바이트를 받은 때 거절한다.
  "frame_unknown_kind",
  // 값 틀의 길이가 0이다.
  "frame_credential_empty",
  // 값 틀의 길이가 CREDENTIAL_MAX_BYTES를 넘는다. 머리 4바이트에서, 실행 ID·지문 칸도 잡기 전에 거절한다.
  "frame_credential_too_large",
  // 실행 ID 칸이 계약 v1의 UUID 꼴이 아니다. 값 버퍼를 잡기 전에 거절한다.
  "frame_credential_bad_run_id",
  // 지문 칸이 소문자 16진 64자가 아니다. 값 버퍼를 잡기 전에 거절한다.
  "frame_credential_bad_digest",
] as const;
export type CredentialFrameRejectReason = (typeof CREDENTIAL_FRAME_REJECT_REASONS)[number];
export type MixedFrameRejectReason = FrameRejectReason | CredentialFrameRejectReason;

export interface DecodedCredential {
  readonly runId: string;
  readonly digest: string;
  // 받은 값 바이트 그대로. 이 값만 담는 새 배열이고(버퍼를 다른 바이트와 나누지 않는다) 디코더가 다시 쓰지 않는다.
  // 쓰거나 버린 뒤 0으로 채우는 것은 받은 쪽의 일이다.
  readonly value: Uint8Array;
}

export type DecodedFrame =
  | { readonly kind: "envelope"; readonly envelope: DecodedEnvelope }
  | { readonly kind: "credential"; readonly credential: DecodedCredential };

// 한 번의 push·end가 낸 틀들. 받은 순서 그대로다. 거절이 있으면 그 앞의 온전한 틀(값 틀 포함)은 frames에 들어 있고,
// 그 뒤의 바이트는 보지 않았다. 그래서 거절된 step을 통째로 기록하면 앞선 정상 값이 따라간다(진단에는 rejected만 쓴다).
// 부르는 쪽이 거절과 함께 온 값을 쓰지 않으면 그 값도 0으로 채워 버린다.
export interface MixedDecodeStep {
  readonly frames: readonly DecodedFrame[];
  readonly rejected: MixedFrameRejectReason | null;
}

export interface MixedFrameDecoder {
  push(chunk: Uint8Array): MixedDecodeStep;
  // 입력의 끝. 틀의 중간(머리, 실행 ID·지문, 값의 중간)이면 frame_truncated다.
  end(): MixedDecodeStep;
  // 미완성 틀을 담는 버퍼의 크기(머리 칸 + 조립 중인 봉투 본문, 또는 값 틀의 실행 ID·지문 칸과 값 버퍼).
  // push 호출 사이에는 FRAME_PREFIX_BYTES + FRAME_MAX_BODY_BYTES를 넘지 않는다. push가 돌려준 틀의 바이트는 세지 않는다.
  heldBytes(): number;
}

export function createMixedFrameDecoder(): MixedFrameDecoder {
  return new MixedDecoder();
}

export type CredentialEncodeResult =
  | { readonly ok: true; readonly frame: Uint8Array }
  | { readonly ok: false; readonly reason: Exclude<CredentialFrameRejectReason, "frame_unknown_kind"> };

// 값을 틀에 복사한다. 돌려준 틀에도 값이 들어 있으므로, 보낸 쪽은 쓰기가 끝난 뒤(소켓이 그 버퍼를 놓은 뒤) 값과 틀을 함께 0으로 채운다.
// 검사의 순서는 디코더와 같다(길이 → 실행 ID → 지문).
export function encodeCredentialFrame(runId: string, digest: string, value: Uint8Array): CredentialEncodeResult {
  if (value.length === 0) return { ok: false, reason: "frame_credential_empty" };
  if (value.length > CREDENTIAL_MAX_BYTES) return { ok: false, reason: "frame_credential_too_large" };
  if (!textFits(runId, CREDENTIAL_RUN_ID_BYTES, runIdByteOk)) return { ok: false, reason: "frame_credential_bad_run_id" };
  if (!textFits(digest, CREDENTIAL_DIGEST_BYTES, digestByteOk)) return { ok: false, reason: "frame_credential_bad_digest" };
  const frame = new Uint8Array(FRAME_PREFIX_BYTES + CREDENTIAL_HEAD_BYTES + value.length);
  new DataView(frame.buffer).setUint32(0, value.length, false);
  frame[0] = FRAME_KIND_CREDENTIAL;
  const head = FRAME_PREFIX_BYTES;
  for (let i = 0; i < CREDENTIAL_RUN_ID_BYTES; i++) frame[head + i] = runId.charCodeAt(i);
  for (let i = 0; i < CREDENTIAL_DIGEST_BYTES; i++) frame[head + CREDENTIAL_RUN_ID_BYTES + i] = digest.charCodeAt(i);
  frame.set(value, head + CREDENTIAL_HEAD_BYTES);
  return { ok: true, frame };
}

const isLowerHex = (byte: number) => (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66);
// 계약 v1의 UUID(schema.ts)와 같은 꼴: 8·13·18·23번째가 '-', 나머지는 소문자 16진.
const runIdByteOk = (byte: number, at: number) => (at === 8 || at === 13 || at === 18 || at === 23 ? byte === 0x2d : isLowerHex(byte));
const digestByteOk = (byte: number) => isLowerHex(byte);

// 글자 코드를 그대로 바이트로 쓰므로 먼저 모든 글자가 ASCII 꼴을 지나는지 본다(0xFF를 넘는 코드가 잘려 다른 바이트가 되지 않게).
function textFits(text: string, length: number, ok: (byte: number, at: number) => boolean): boolean {
  if (text.length !== length) return false;
  for (let i = 0; i < length; i++) if (!ok(text.charCodeAt(i), i)) return false;
  return true;
}

function bytesFit(bytes: Uint8Array, ok: (byte: number, at: number) => boolean): boolean {
  for (let i = 0; i < bytes.length; i++) if (!ok(bytes[i]!, i)) return false;
  return true;
}

class Decoder implements FrameDecoder {
  private readonly prefix = new Uint8Array(FRAME_PREFIX_BYTES);
  private prefixFilled = 0;
  private body: Uint8Array | null = null;
  private bodyFilled = 0;
  private rejected: FrameRejectReason | null = null;
  private ended = false;

  push(chunk: Uint8Array): DecodeStep {
    if (this.rejected) return { envelopes: [], rejected: this.rejected };
    if (this.ended) return this.fail([], "frame_after_end");
    const envelopes: DecodedEnvelope[] = [];
    let at = 0;
    // 조각을 붙잡지 않고 접두 칸이나 본문 버퍼로 옮긴다. 그래서 호출 사이에 쥐는 미완성 틀은 조각의 크기와 상관없다.
    // 완성된 봉투는 envelopes에 모아 한꺼번에 돌려주므로, 그 양은 조각의 크기를 따라 커진다.
    while (at < chunk.length) {
      if (this.body === null) {
        const n = Math.min(FRAME_PREFIX_BYTES - this.prefixFilled, chunk.length - at);
        this.prefix.set(chunk.subarray(at, at + n), this.prefixFilled);
        this.prefixFilled += n;
        at += n;
        if (this.prefixFilled < FRAME_PREFIX_BYTES) break;
        const declared = new DataView(this.prefix.buffer).getUint32(0, false);
        if (declared === 0) return this.fail(envelopes, "frame_empty");
        if (declared > FRAME_MAX_BODY_BYTES) return this.fail(envelopes, "frame_too_large");
        this.body = new Uint8Array(declared);
        this.bodyFilled = 0;
        continue;
      }
      const n = Math.min(this.body.length - this.bodyFilled, chunk.length - at);
      this.body.set(chunk.subarray(at, at + n), this.bodyFilled);
      this.bodyFilled += n;
      at += n;
      if (this.bodyFilled < this.body.length) break;
      const bytes = this.body;
      this.body = null;
      this.prefixFilled = 0;
      const parsed = parseEnvelope(bytes);
      if (!parsed.ok) return this.fail(envelopes, parsed.reason);
      envelopes.push({ bytes, value: parsed.value });
    }
    return { envelopes, rejected: null };
  }

  end(): DecodeStep {
    if (this.rejected) return { envelopes: [], rejected: this.rejected };
    this.ended = true;
    if (this.prefixFilled > 0 || this.body !== null) return this.fail([], "frame_truncated");
    return { envelopes: [], rejected: null };
  }

  heldBytes(): number {
    return this.prefix.length + (this.body?.length ?? 0);
  }

  private fail(envelopes: DecodedEnvelope[], reason: FrameRejectReason): DecodeStep {
    this.rejected = reason;
    this.body = null;
    this.prefixFilled = 0;
    return { envelopes, rejected: reason };
  }
}

// 봉투 틀은 Decoder와 같은 순서·검사로 다룬다(시험이 두 디코더의 결과를 대조한다).
// 상태는 모두 # 필드에 둔다. TypeScript의 private은 런타임에서 보통 속성이라, 조립 중인 값과 실행 ID·지문이 디코더 객체의
// JSON.stringify·Object.keys에 그대로 나온다. # 필드는 런타임에서도 클래스 밖에서 읽거나 열거할 수 없다.
class MixedDecoder implements MixedFrameDecoder {
  readonly #prefix = new Uint8Array(FRAME_PREFIX_BYTES);
  #prefixFilled = 0;
  // 지금 채우는 칸은 셋 중 하나다: 봉투 본문, 값 틀의 실행 ID·지문 칸, 값. 값 틀은 실행 ID·지문 칸을 다 채워 꼴을 본 뒤에 값 버퍼를 잡고,
  // 값을 채우는 동안 실행 ID·지문 칸을 쥔다.
  #body: Uint8Array | null = null;
  #head: Uint8Array | null = null;
  #value: Uint8Array | null = null;
  #valueLength = 0;
  #filled = 0;
  #rejected: MixedFrameRejectReason | null = null;
  #ended = false;

  push(chunk: Uint8Array): MixedDecodeStep {
    if (this.#rejected) return { frames: [], rejected: this.#rejected };
    if (this.#ended) return this.#fail([], "frame_after_end");
    const frames: DecodedFrame[] = [];
    let at = 0;
    // 조각을 붙잡지 않고 머리 칸이나 지금 채우는 칸으로 옮긴다(Decoder와 같은 까닭).
    while (at < chunk.length) {
      const target = this.#value ?? this.#head ?? this.#body;
      if (target === null) {
        const n = Math.min(FRAME_PREFIX_BYTES - this.#prefixFilled, chunk.length - at);
        this.#prefix.set(chunk.subarray(at, at + n), this.#prefixFilled);
        this.#prefixFilled += n;
        at += n;
        const kind = this.#prefix[0];
        if (kind !== FRAME_KIND_ENVELOPE && kind !== FRAME_KIND_CREDENTIAL) return this.#fail(frames, "frame_unknown_kind");
        if (this.#prefixFilled < FRAME_PREFIX_BYTES) break;
        const declared = (this.#prefix[1]! << 16) | (this.#prefix[2]! << 8) | this.#prefix[3]!;
        if (kind === FRAME_KIND_ENVELOPE) {
          if (declared === 0) return this.#fail(frames, "frame_empty");
          if (declared > FRAME_MAX_BODY_BYTES) return this.#fail(frames, "frame_too_large");
          this.#body = new Uint8Array(declared);
        } else {
          if (declared === 0) return this.#fail(frames, "frame_credential_empty");
          if (declared > CREDENTIAL_MAX_BYTES) return this.#fail(frames, "frame_credential_too_large");
          this.#head = new Uint8Array(CREDENTIAL_HEAD_BYTES);
          this.#valueLength = declared;
        }
        this.#filled = 0;
        continue;
      }
      const n = Math.min(target.length - this.#filled, chunk.length - at);
      target.set(chunk.subarray(at, at + n), this.#filled);
      this.#filled += n;
      at += n;
      if (this.#filled < target.length) break;
      this.#filled = 0;
      if (target === this.#body) {
        this.#body = null;
        this.#prefixFilled = 0;
        const parsed = parseEnvelope(target);
        if (!parsed.ok) return this.#fail(frames, parsed.reason);
        frames.push({ kind: "envelope", envelope: { bytes: target, value: parsed.value } });
      } else if (target === this.#head) {
        if (!bytesFit(target.subarray(0, CREDENTIAL_RUN_ID_BYTES), runIdByteOk)) return this.#fail(frames, "frame_credential_bad_run_id");
        if (!bytesFit(target.subarray(CREDENTIAL_RUN_ID_BYTES), digestByteOk)) return this.#fail(frames, "frame_credential_bad_digest");
        this.#value = new Uint8Array(this.#valueLength);
      } else {
        const head = this.#head!;
        this.#head = null;
        this.#value = null;
        this.#prefixFilled = 0;
        // 꼴을 본 ASCII라 글자 코드로 그대로 옮긴다.
        const runId = String.fromCharCode(...head.subarray(0, CREDENTIAL_RUN_ID_BYTES));
        const digest = String.fromCharCode(...head.subarray(CREDENTIAL_RUN_ID_BYTES));
        frames.push({ kind: "credential", credential: { runId, digest, value: target } });
      }
    }
    return { frames, rejected: null };
  }

  end(): MixedDecodeStep {
    if (this.#rejected) return { frames: [], rejected: this.#rejected };
    this.#ended = true;
    if (this.#prefixFilled > 0 || this.#body !== null || this.#head !== null) return this.#fail([], "frame_truncated");
    return { frames: [], rejected: null };
  }

  heldBytes(): number {
    return this.#prefix.length + (this.#body?.length ?? 0) + (this.#head?.length ?? 0) + (this.#value?.length ?? 0);
  }

  #fail(frames: DecodedFrame[], reason: MixedFrameRejectReason): MixedDecodeStep {
    this.#rejected = reason;
    // 덜 온 값은 밖으로 나간 적이 없으니 여기서 지운다.
    this.#value?.fill(0);
    this.#body = null;
    this.#head = null;
    this.#value = null;
    this.#prefixFilled = 0;
    return { frames, rejected: reason };
  }
}

// fatal: 깨진 바이트를 U+FFFD로 바꾸지 않고 던진다. ignoreBOM: BOM을 조용히 벗기지 않는다(그러면 JSON 문법에서 걸린다).
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Parsed = { ok: true; value: unknown } | { ok: false; reason: FrameRejectReason };

function parseEnvelope(bytes: Uint8Array): Parsed {
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { ok: false, reason: "frame_bad_utf8" };
  }
  try {
    new Scan(text).document();
  } catch (error) {
    if (error instanceof ScanFail) return { ok: false, reason: error.reason };
    throw error;
  }
  // Scan이 RFC 8259 문법 전체를 확인했으므로 여기서 실패하면 두 해석기가 어긋난 것이다. 그래도 받지 않는다.
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "frame_not_json" };
  }
}

class ScanFail extends Error {
  constructor(readonly reason: FrameRejectReason) {
    super(reason);
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

// RFC 8259 문법을 봉투 전체의 값을 만들지 않고 훑으며 객체마다 키를 모은다. 문자열 토큰은 하나씩 JSON.parse로 이스케이프를 풀고,
// 키는 그 푼 값으로 비교한다.
// 재귀 깊이는 MAX_DEPTH + 1에서 멈춘다.
class Scan {
  private pos = 0;
  constructor(private readonly text: string) {}

  document(): void {
    this.space();
    this.value(0);
    this.space();
    if (this.pos !== this.text.length) throw new ScanFail("frame_not_json");
  }

  private value(depth: number): void {
    if (depth > limits.MAX_DEPTH) throw new ScanFail("frame_too_deep");
    const c = this.text[this.pos];
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (c === '"') {
      this.string();
      return;
    }
    for (const word of ["true", "false", "null"]) {
      if (this.text.startsWith(word, this.pos)) {
        this.pos += word.length;
        return;
      }
    }
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (!match) throw new ScanFail("frame_not_json");
    this.pos += match[0].length;
  }

  private object(depth: number): void {
    this.pos++;
    const keys = new Set<string>();
    this.space();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return;
    }
    for (;;) {
      this.space();
      if (this.text[this.pos] !== '"') throw new ScanFail("frame_not_json");
      const key = this.string();
      if (keys.has(key)) throw new ScanFail("frame_duplicate_key");
      keys.add(key);
      this.space();
      this.expect(":");
      this.space();
      this.value(depth + 1);
      this.space();
      const next = this.text[this.pos++];
      if (next === ",") continue;
      if (next === "}") return;
      throw new ScanFail("frame_not_json");
    }
  }

  private array(depth: number): void {
    this.pos++;
    this.space();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return;
    }
    for (;;) {
      this.space();
      this.value(depth + 1);
      this.space();
      const next = this.text[this.pos++];
      if (next === ",") continue;
      if (next === "]") return;
      throw new ScanFail("frame_not_json");
    }
  }

  // 여는 따옴표에서 시작해 닫는 따옴표 뒤로 간다. 이스케이프를 푼 문자열을 돌려준다.
  private string(): string {
    const start = this.pos++;
    for (;;) {
      if (this.pos >= this.text.length) throw new ScanFail("frame_not_json");
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x22) break;
      if (c < 0x20) throw new ScanFail("frame_not_json");
      if (c !== 0x5c) {
        this.pos++;
        continue;
      }
      const escape = this.text[this.pos + 1];
      if (escape === "u") {
        if (!HEX4.test(this.text.slice(this.pos + 2, this.pos + 6))) throw new ScanFail("frame_not_json");
        this.pos += 6;
      } else if (escape !== undefined && SIMPLE_ESCAPES.has(escape)) {
        this.pos += 2;
      } else {
        throw new ScanFail("frame_not_json");
      }
    }
    this.pos++;
    return JSON.parse(this.text.slice(start, this.pos)) as string;
  }

  private space(): void {
    for (;;) {
      const c = this.text[this.pos];
      if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return;
      this.pos++;
    }
  }

  private expect(c: string): void {
    if (this.text[this.pos] !== c) throw new ScanFail("frame_not_json");
    this.pos++;
  }
}
