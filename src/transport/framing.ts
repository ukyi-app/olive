// 연결 위의 바이트를 봉투 단위로 자르고 잇는 틀. 서명·동작은 보지 않는다(받는 쪽 verifyEnvelope의 일이다).
// 틀 하나 = 길이 접두 4바이트(부호 없는 정수, big-endian) + 봉투 바이트(UTF-8 JSON). 접두는 봉투 바이트의 수만 센다(접두 자신은 빼고).
// 길이 0은 받지 않는다(빈 글은 JSON이 아니고, 0을 허용하면 상대가 접두만으로 연결을 붙잡을 수 있다).
// 이 자리가 인증 전 바이트를 처음 받는 곳이라 순서가 중요하다:
// 1. 접두가 상한(MAX_MESSAGE_BYTES)을 넘으면 본문 버퍼를 잡기 전에 거절한다.
// 2. 본문이 다 오면 UTF-8 → 문법·중복 키·깊이 → 그 뒤에만 JSON.parse. JSON.parse는 같은 키를 뒤의 값으로 덮으므로,
//    덮인 뒤에는 무엇이 서명됐는지 가릴 수 없다(계약의 정규 직렬화는 해석한 값에서 바이트를 다시 만든다).
// 거절하면 그 디코더는 끝난다. 다시 동기화하지 않는다: 틀이 어긋난 뒤의 바이트는 어디가 경계인지 믿을 근거가 없다.
import { limits } from "../contract/v1/index.ts";

export const FRAME_PREFIX_BYTES = 4;
export const FRAME_MAX_BODY_BYTES = limits.MAX_MESSAGE_BYTES;

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
  // 지금 쥐고 있는 버퍼의 크기(접두 칸 + 본문 버퍼). FRAME_PREFIX_BYTES + FRAME_MAX_BODY_BYTES를 넘지 않는다.
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

export function createFrameDecoder(): FrameDecoder {
  return new Decoder();
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
    // 조각을 붙잡지 않고 접두 칸이나 본문 버퍼로 옮긴다. 그래서 쥐는 양은 조각의 크기와 상관없다.
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

// RFC 8259 문법을 값을 만들지 않고 훑으며 객체마다 키를 모은다. 키는 JSON.parse로 이스케이프를 푼 값으로 비교한다.
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
