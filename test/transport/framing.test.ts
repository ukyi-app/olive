import { expect, test } from "bun:test";
import { canonicalJson } from "../../src/contract/v1/canonical.ts";
import { limits, REJECT_REASONS, verifyEnvelope } from "../../src/contract/v1/index.ts";
import {
  createFrameDecoder,
  type DecodedEnvelope,
  encodeFrame,
  FRAME_MAX_BODY_BYTES,
  FRAME_PREFIX_BYTES,
  FRAME_REJECT_REASONS,
  type FrameRejectReason,
} from "../../src/transport/framing.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function framed(body: Uint8Array): Uint8Array {
  const encoded = encodeFrame(body);
  if (!encoded.ok) throw new Error(encoded.reason);
  return encoded.frame;
}

function prefix(length: number): Uint8Array {
  const out = new Uint8Array(FRAME_PREFIX_BYTES);
  new DataView(out.buffer).setUint32(0, length, false);
  return out;
}

// 조각을 차례로 넣고 끝을 알린다. 거절은 처음 하나만 기록한다.
function run(chunks: Uint8Array[]): { envelopes: DecodedEnvelope[]; rejected: FrameRejectReason | null } {
  const decoder = createFrameDecoder();
  const envelopes: DecodedEnvelope[] = [];
  let rejected: FrameRejectReason | null = null;
  for (const step of [...chunks.map((chunk) => decoder.push(chunk)), decoder.end()]) {
    envelopes.push(...step.envelopes);
    rejected ??= step.rejected;
  }
  return { envelopes, rejected };
}

// 길이가 정확히 n바이트인 JSON 객체 봉투 바이트.
function bodyOfSize(n: number): Uint8Array {
  const shell = '{"p":""}'.length;
  return utf8(`{"p":"${"x".repeat(n - shell)}"}`);
}

const SAMPLES = [{ a: 1 }, { header: { action: "ack" }, body: ["가", null, true] }, { s: "😀\n\"" }];

test("접두·본문 분할 및 연속 틀: 모든 분할 지점에서 경계를 그대로 복구한다", () => {
  const bodies = SAMPLES.map((value) => utf8(JSON.stringify(value)));
  const stream = concat(...bodies.map(framed));
  // 한 조각에 세 틀이 이어 붙어 온다.
  const whole = run([stream]);
  expect(whole.rejected).toBeNull();
  expect(whole.envelopes.map((e) => e.value)).toEqual(SAMPLES);
  expect(whole.envelopes.map((e) => [...e.bytes])).toEqual(bodies.map((b) => [...b]));
  // 한 곳에서 자른 두 조각: 접두의 중간, 접두와 본문 사이, 본문의 중간, 틀과 틀 사이를 모두 지난다.
  for (let i = 0; i <= stream.length; i++) {
    const split = run([stream.subarray(0, i), stream.subarray(i)]);
    expect(split.rejected, `split ${i}`).toBeNull();
    expect(split.envelopes.map((e) => e.value), `split ${i}`).toEqual(SAMPLES);
  }
  // 두 곳에서 자른 세 조각(첫 틀 안의 모든 짝).
  const first = framed(bodies[0]!).length;
  for (let i = 0; i <= first; i++) {
    for (let j = i; j <= first + 2; j++) {
      const split = run([stream.subarray(0, i), stream.subarray(i, j), stream.subarray(j)]);
      expect(split.envelopes.map((e) => e.value), `split ${i},${j}`).toEqual(SAMPLES);
    }
  }
  // 한 바이트씩.
  const bytewise = run([...stream].map((b) => Uint8Array.of(b)));
  expect(bytewise.envelopes.map((e) => e.value)).toEqual(SAMPLES);
  // 빈 조각은 아무 일도 하지 않는다.
  expect(run([new Uint8Array(0), stream, new Uint8Array(0)]).envelopes).toHaveLength(3);
});

test("65536 통과·65537 해석 전 거절: 본문 바이트가 오기 전에, 본문 버퍼를 잡기 전에 거절한다", () => {
  expect(FRAME_MAX_BODY_BYTES).toBe(limits.MAX_MESSAGE_BYTES);
  expect(FRAME_MAX_BODY_BYTES).toBe(65_536);

  const max = bodyOfSize(65_536);
  expect(max.length).toBe(65_536);
  const passed = run([framed(max)]);
  expect(passed.rejected).toBeNull();
  expect(passed.envelopes).toHaveLength(1);
  expect(passed.envelopes[0]!.bytes.length).toBe(65_536);

  // 상한 접두만 받으면 본문을 기다린다(거절 없음).
  const waiting = createFrameDecoder();
  expect(waiting.push(prefix(65_536))).toEqual({ envelopes: [], rejected: null });

  // 65,537을 말하는 접두는 그 넷째 바이트에서 거절된다. 본문은 한 바이트도 오지 않았고 본문 버퍼는 0이다.
  for (const declared of [65_537, 0xffff_ffff]) {
    const decoder = createFrameDecoder();
    const head = prefix(declared);
    for (let i = 0; i < FRAME_PREFIX_BYTES - 1; i++) expect(decoder.push(head.subarray(i, i + 1)).rejected).toBeNull();
    expect(decoder.push(head.subarray(FRAME_PREFIX_BYTES - 1))).toEqual({ envelopes: [], rejected: "frame_too_large" });
    expect(decoder.heldBytes()).toBe(FRAME_PREFIX_BYTES);
    // 거절 뒤에는 올바른 틀이 와도 받지 않는다(다시 동기화하지 않는다).
    expect(decoder.push(framed(utf8("{}")))).toEqual({ envelopes: [], rejected: "frame_too_large" });
    expect(decoder.end()).toEqual({ envelopes: [], rejected: "frame_too_large" });
  }
  // 앞의 올바른 틀은 내고, 큰 접두에서 멈춘다(뒤의 바이트는 해석하지 않는다).
  const mixed = createFrameDecoder().push(concat(framed(utf8("{}")), prefix(65_537), utf8("{not json"), framed(utf8("[]"))));
  expect(mixed.envelopes.map((e) => e.value)).toEqual([{}]);
  expect(mixed.rejected).toBe("frame_too_large");

  // 인코더도 상한을 넘는 봉투에 틀을 씌우지 않는다.
  expect(encodeFrame(bodyOfSize(65_537))).toEqual({ ok: false, reason: "frame_too_large" });
  expect(encodeFrame(max).ok).toBe(true);
});

test("이스케이프로 같은 중복 키 거절: 중첩·배열 안·\\u 표기를 객체로 바꾸기 전에 거절한다", () => {
  const rejectedAs = (text: string) => run([framed(utf8(text))]);
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"\\u0061":1,"\\u0061":2}',
    '{"x":{"k":1,"\\u006B":2}}',
    '[1,{"y":[{"a":1,"\\u0061":2}]}]',
    '{"/":1,"\\/":2}',
    '{"😀":1,"\\ud83d\\ude00":2}',
    '{"\\ud800":1,"\\uD800":2}',
    '{"__proto__":1,"__proto__":2}',
  ]) {
    const result = rejectedAs(text);
    expect(result.rejected, text).toBe("frame_duplicate_key");
    expect(result.envelopes, text).toEqual([]);
  }
  // 같은 이름이 다른 객체에 있거나 대소문자가 다르면 중복이 아니다.
  for (const text of ['{"a":{"a":1},"b":[{"a":1},{"a":2}]}', '{"a":1,"A":2}', '{"a\\u0000":1,"a":2}']) {
    expect(rejectedAs(text).rejected, text).toBeNull();
  }
  // JSON.parse만 쓰면 뒤의 값으로 덮인다. 그래서 해석 전에 막아야 한다.
  expect(JSON.parse('{"a":1,"\\u0061":2}')).toEqual({ a: 2 });
});

test("부분 EOF·깨진 UTF-8 거절: 틀 중간의 끝과 올바르지 않은 UTF-8은 봉투로 내지 않는다", () => {
  const one = framed(utf8('{"a":"가"}'));
  const two = concat(one, one);
  for (let i = 1; i < one.length; i++) {
    // 첫 틀의 접두 중간(1~3), 본문 중간(4~). 반쪽 틀은 내지 않는다.
    const cut = run([one.subarray(0, i)]);
    expect(cut, `cut ${i}`).toEqual({ envelopes: [], rejected: "frame_truncated" });
    // 앞의 온전한 틀은 내고, 둘째 틀의 중간에서 끝나면 거절한다.
    const after = run([two.subarray(0, one.length + i)]);
    expect(after.envelopes, `cut ${one.length + i}`).toHaveLength(1);
    expect(after.rejected, `cut ${one.length + i}`).toBe("frame_truncated");
  }
  // 틀의 경계에서 끝나면 거절하지 않는다(아무것도 받지 않은 연결 포함).
  expect(run([]).rejected).toBeNull();
  expect(run([two]).rejected).toBeNull();

  const quote = utf8('{"a":"');
  const close = utf8('"}');
  for (const bad of [
    [0xff],
    [0xc0, 0xaf], // 과잉 길이 '/'
    [0xed, 0xa0, 0x80], // UTF-8로 쓴 서로게이트
    [0xf4, 0x90, 0x80, 0x80], // U+10FFFF 초과
    [0xe2, 0x82], // 끝이 잘린 3바이트 글자
    [0x80],
  ]) {
    const body = concat(quote, Uint8Array.from(bad), close);
    expect(run([framed(body)]), String(bad)).toEqual({ envelopes: [], rejected: "frame_bad_utf8" });
  }
  // 본문 끝에서 잘린 여러 바이트 글자도 거절한다.
  expect(run([framed(utf8('{"a":"가"}').subarray(0, 8))]).rejected).toBe("frame_bad_utf8");
  // BOM은 벗기지 않는다(JSON이 아니다).
  expect(run([framed(concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8("{}")))]).rejected).toBe("frame_not_json");
});

test("깊이: MAX_DEPTH까지는 받고 넘으면 객체로 바꾸기 전에 거절한다(정규 직렬화와 같은 경계)", () => {
  const nest = (n: number, inner: string) => "[".repeat(n) + inner + "]".repeat(n);
  const ok = nest(limits.MAX_DEPTH, "1");
  const deep = nest(limits.MAX_DEPTH + 1, "1");
  const emptyAtEdge = nest(limits.MAX_DEPTH, "[]");
  expect(run([framed(utf8(ok))]).rejected).toBeNull();
  expect(run([framed(utf8(emptyAtEdge))]).rejected).toBeNull();
  expect(run([framed(utf8(deep))])).toEqual({ envelopes: [], rejected: "frame_too_deep" });
  expect(run([framed(utf8(`{"a":${nest(limits.MAX_DEPTH, "1")}}`))]).rejected).toBe("frame_too_deep");
  // 정규 직렬화(canonicalJson)도 같은 값에서 갈린다.
  expect(() => canonicalJson(JSON.parse(ok))).not.toThrow();
  expect(() => canonicalJson(JSON.parse(emptyAtEdge))).not.toThrow();
  expect(() => canonicalJson(JSON.parse(deep))).toThrow("too_deep");
});

test("모양: 빈 틀과 JSON이 아닌 본문은 거절하고, 끝 알림 뒤의 조각도 받지 않는다", () => {
  expect(run([prefix(0)])).toEqual({ envelopes: [], rejected: "frame_empty" });
  expect(encodeFrame(new Uint8Array(0))).toEqual({ ok: false, reason: "frame_empty" });
  for (const text of ["{", "{}x", "{'a':1}", '{"a":01}', '{"a":1,}', "[1,]", '"\t"', "NaN", '{"a" 1}', '"\\x"', '"\\u12"', " ", "{} {}"]) {
    expect(run([framed(utf8(text))]).rejected, text).toBe("frame_not_json");
  }
  // 앞뒤 공백과 객체가 아닌 값은 틀의 일이 아니다(봉투 모양은 verifyEnvelope가 본다).
  expect(run([framed(utf8(' \n{"a":-1.5e3,"b":"\\u00e9"}\r\t'))]).envelopes[0]!.value).toEqual({ a: -1500, b: "é" });
  expect(run([framed(utf8("[]"))]).envelopes[0]!.value).toEqual([]);

  const decoder = createFrameDecoder();
  expect(decoder.end()).toEqual({ envelopes: [], rejected: null });
  expect(decoder.push(framed(utf8("{}")))).toEqual({ envelopes: [], rejected: "frame_after_end" });
});

test("인코더: 접두는 4바이트 big-endian 본문 길이이고 디코더와 왕복한다", () => {
  const body = utf8('{"a":"가"}');
  const frame = framed(body);
  expect([...frame.subarray(0, FRAME_PREFIX_BYTES)]).toEqual([0, 0, 0, body.length]);
  expect([...frame.subarray(FRAME_PREFIX_BYTES)]).toEqual([...body]);
  expect([...framed(bodyOfSize(65_536)).subarray(0, 4)]).toEqual([0, 1, 0, 0]);
  // 인코더는 넘긴 바이트를 붙잡지 않는다(복사한다).
  const source = utf8("{}");
  const copy = framed(source);
  source[0] = 0x5b;
  expect(run([copy]).envelopes[0]!.value).toEqual({});
});

test("메모리: 디코더가 쥐는 바이트는 접두 폭 + 상한을 넘지 않는다", () => {
  const bound = FRAME_PREFIX_BYTES + FRAME_MAX_BODY_BYTES;
  const max = framed(bodyOfSize(65_536));
  // 상한 틀 여덟 개를 한 조각으로 받아도, 고르지 않은 크기로 쪼개 받아도 쥐는 양은 한 틀의 몫이다.
  const stream = concat(...Array.from({ length: 8 }, () => max));
  for (const sizes of [[stream.length], [1, 3, 7, 4096, 65_539, 65_541, 100_000]]) {
    const decoder = createFrameDecoder();
    let peak = decoder.heldBytes();
    let count = 0;
    for (let at = 0, k = 0; at < stream.length; k++) {
      const size = sizes[k % sizes.length]!;
      const step = decoder.push(stream.subarray(at, at + size));
      at += size;
      count += step.envelopes.length;
      expect(step.rejected).toBeNull();
      peak = Math.max(peak, decoder.heldBytes());
    }
    expect(count).toBe(8);
    expect(peak).toBeLessThanOrEqual(bound);
    // 경계에서 멈추면 접두 칸만 남는다.
    expect(decoder.heldBytes()).toBe(FRAME_PREFIX_BYTES);
  }
  // 낸 봉투 바이트는 디코더의 버퍼가 아니다(다음 틀이 덮어쓰지 않는다).
  const pair = run([concat(framed(utf8('{"a":1}')), framed(utf8('{"b":2}')))]);
  expect(new TextDecoder().decode(pair.envelopes[0]!.bytes)).toBe('{"a":1}');
  // 거절하면 본문 버퍼를 놓는다.
  const dropped = createFrameDecoder();
  dropped.push(concat(prefix(10), utf8('{"a":')));
  expect(dropped.heldBytes()).toBe(FRAME_PREFIX_BYTES + 10);
  expect(dropped.end().rejected).toBe("frame_truncated");
  expect(dropped.heldBytes()).toBe(FRAME_PREFIX_BYTES);
});

test("거절 사유: 유한한 목록이고 계약 v1의 사유와 겹치지 않는다", () => {
  expect([...FRAME_REJECT_REASONS]).toEqual([
    "frame_empty",
    "frame_too_large",
    "frame_truncated",
    "frame_bad_utf8",
    "frame_not_json",
    "frame_duplicate_key",
    "frame_too_deep",
    "frame_after_end",
  ]);
  for (const reason of FRAME_REJECT_REASONS) expect((REJECT_REASONS as readonly string[]).includes(reason), reason).toBe(false);
});

test("경계: 디코더는 봉투를 검증하지 않는다(해석한 값은 verifyEnvelope가 그대로 받는 꼴이다)", async () => {
  const [decoded] = run([framed(utf8('{"header":{},"signature":"x","body":{}}'))]).envelopes;
  const verdict = await verifyEnvelope(decoded!.value, {
    publicKeyFor: () => null,
    expectedRecipient: "supervisor",
    now: 0,
    stopGeneration: 0,
    nonces: { consume: () => true },
  } as unknown as Parameters<typeof verifyEnvelope>[1]);
  expect(verdict).toEqual({ ok: false, reason: "contract_mismatch" });
});
