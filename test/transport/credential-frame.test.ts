import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { REJECT_REASONS } from "../../src/contract/v1/index.ts";
import { SHA256, UUID } from "../../src/contract/v1/schema.ts";
import {
  CREDENTIAL_DIGEST_BYTES,
  CREDENTIAL_FRAME_REJECT_REASONS,
  CREDENTIAL_HEAD_BYTES,
  CREDENTIAL_MAX_BYTES,
  CREDENTIAL_RUN_ID_BYTES,
  createFrameDecoder,
  createMixedFrameDecoder,
  type DecodedFrame,
  type DecodeStep,
  encodeCredentialFrame,
  encodeFrame,
  FRAME_KIND_CREDENTIAL,
  FRAME_KIND_ENVELOPE,
  FRAME_MAX_BODY_BYTES,
  FRAME_PREFIX_BYTES,
  FRAME_REJECT_REASONS,
  type MixedDecodeStep,
  type MixedFrameDecoder,
  type MixedFrameRejectReason,
} from "../../src/transport/framing.ts";

// 표본 값은 모두 여기서 지어낸 바이트다. 단언이 실패해도 진단문에 값이 실리지 않게, 값은 길이와 SHA-256 요약이나 불리언으로만 단언한다.

const utf8 = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const RUN_ID = "0b6f2c1e-5a4d-4c3b-9e8f-7a6b5c4d3e2f";
const OTHER_RUN_ID = "f0e1d2c3-b4a5-4687-9879-6a5b4c3d2e1f";
// 앞 4바이트 "qZ7#"는 값이 새는지 찾는 표지다.
const MARK = [0x71, 0x5a, 0x37, 0x23];

function fake(length: number, salt = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i < MARK.length ? MARK[i]! : (i * 131 + salt * 17 + 7) & 0xff));
}

function envelopeFrame(body: Uint8Array): Uint8Array {
  const made = encodeFrame(body);
  if (!made.ok) throw new Error(made.reason);
  return made.frame;
}

function credentialFrame(value: Uint8Array, runId = RUN_ID): Uint8Array {
  const made = encodeCredentialFrame(runId, sha256(value), value);
  if (!made.ok) throw new Error(made.reason);
  return made.frame;
}

function header(kind: number, length: number): Uint8Array {
  return Uint8Array.of(kind, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
}

type Summary = { kind: "envelope"; value: unknown } | { kind: "credential"; runId: string; digest: string; length: number; sha256: string };

function summarize(frames: readonly DecodedFrame[]): Summary[] {
  return frames.map((frame) =>
    frame.kind === "envelope"
      ? { kind: "envelope", value: frame.envelope.value }
      : {
          kind: "credential",
          runId: frame.credential.runId,
          digest: frame.credential.digest,
          length: frame.credential.value.length,
          sha256: sha256(frame.credential.value),
        },
  );
}

// 단언에 넘기는 꼴. 값 바이트 대신 요약만 담는다.
const safe = (step: MixedDecodeStep) => ({ frames: summarize(step.frames), rejected: step.rejected });
const safeOld = (step: DecodeStep) => ({ count: step.envelopes.length, rejected: step.rejected });

const credentialSummary = (value: Uint8Array, runId = RUN_ID): Summary => ({
  kind: "credential",
  runId,
  digest: sha256(value),
  length: value.length,
  sha256: sha256(value),
});

// 조각을 차례로 넣고 끝을 알린다. 거절은 처음 하나만 기록한다. 던진 오류는 문구만 남긴다.
function run(chunks: Uint8Array[], decoder: MixedFrameDecoder = createMixedFrameDecoder()) {
  const steps: MixedDecodeStep[] = [];
  let thrown: string | null = null;
  try {
    for (const chunk of chunks) steps.push(decoder.push(chunk));
    steps.push(decoder.end());
  } catch (error) {
    thrown = `${String(error)} ${(error as Error)?.stack ?? ""}`;
  }
  const rejected = steps.find((step) => step.rejected !== null)?.rejected ?? null;
  return { frames: summarize(steps.flatMap((step) => step.frames)), rejected, steps, thrown };
}

// 표본의 앞 4바이트가 글, JSON 배열 칸, 16진, 쉼표로 이은 숫자 중 어느 꼴로든 들어 있는가.
function leaks(text: string, value: Uint8Array): boolean {
  const head = [...value.subarray(0, 4)];
  const forms = [String.fromCharCode(...head), head.map((b, i) => `"${i}":${b}`).join(","), Buffer.from(head).toString("hex"), head.join(",")];
  return forms.some((form) => text.includes(form));
}

test("보장 1 종류: 머리의 첫 바이트로 가르고, 모르는 종류는 그 한 바이트에서 거절한 뒤 디코더가 끝난다", () => {
  expect([FRAME_KIND_ENVELOPE, FRAME_KIND_CREDENTIAL]).toEqual([0x00, 0x01]);
  const value = fake(32);
  const envelope = envelopeFrame(utf8('{"a":1}'));
  for (let kind = 0x02; kind <= 0xff; kind++) {
    const decoder = createMixedFrameDecoder();
    const first = decoder.push(Uint8Array.of(kind));
    expect(safe(first), `kind ${kind}`).toEqual({ frames: [], rejected: "frame_unknown_kind" });
    expect(decoder.heldBytes(), `kind ${kind}`).toBe(FRAME_PREFIX_BYTES);
    // 거절 뒤에는 올바른 틀이 와도 받지 않는다(다시 동기화하지 않는다).
    expect(safe(decoder.push(envelope)), `kind ${kind}`).toEqual({ frames: [], rejected: "frame_unknown_kind" });
    expect(safe(decoder.push(credentialFrame(value))), `kind ${kind}`).toEqual({ frames: [], rejected: "frame_unknown_kind" });
    expect(safe(decoder.end()), `kind ${kind}`).toEqual({ frames: [], rejected: "frame_unknown_kind" });
  }
  // 길이 접두 없이 온 JSON('{' = 0x7b)은 해석하지 않고 첫 바이트에서 거절한다. 앞의 온전한 틀은 받은 순서대로 낸다.
  const bare = run([concat(envelope, credentialFrame(value), utf8('{"header":{}}'), envelope)]);
  expect(bare.frames).toEqual([{ kind: "envelope", value: { a: 1 } }, credentialSummary(value)]);
  expect(bare.rejected).toBe("frame_unknown_kind");

  // 같은 바이트라도 종류가 봉투면 봉투로 해석하고, 값이면 해석하지 않고 값으로 낸다.
  const text = utf8('{"header":{"action":"ack"},"signature":"x","body":{}}');
  const both = run([concat(envelopeFrame(text), credentialFrame(text))]);
  expect(both.rejected).toBeNull();
  expect(both.frames).toEqual([{ kind: "envelope", value: JSON.parse('{"header":{"action":"ack"},"signature":"x","body":{}}') }, credentialSummary(text)]);
});

test("보장 1 봉투만 받는 디코더: 값 틀은 머리 4바이트에서 frame_too_large로 거절하고 버퍼를 잡지 않는다", () => {
  for (const length of [1, 32, CREDENTIAL_MAX_BYTES]) {
    const frame = credentialFrame(fake(length));
    const decoder = createFrameDecoder();
    for (let i = 0; i < FRAME_PREFIX_BYTES - 1; i++) expect(safeOld(decoder.push(frame.subarray(i, i + 1))), `${length}`).toEqual({ count: 0, rejected: null });
    expect(safeOld(decoder.push(frame.subarray(FRAME_PREFIX_BYTES - 1))), `${length}`).toEqual({ count: 0, rejected: "frame_too_large" });
    expect(decoder.heldBytes(), `${length}`).toBe(FRAME_PREFIX_BYTES);
    expect(safeOld(decoder.push(envelopeFrame(utf8("{}")))), `${length}`).toEqual({ count: 0, rejected: "frame_too_large" });
    expect(safeOld(decoder.end()), `${length}`).toEqual({ count: 0, rejected: "frame_too_large" });
  }
  // 앞의 봉투는 내고 값 틀에서 멈춘다.
  const mixed = createFrameDecoder().push(concat(envelopeFrame(utf8("[]")), credentialFrame(fake(16)), envelopeFrame(utf8("{}"))));
  expect(safeOld(mixed)).toEqual({ count: 1, rejected: "frame_too_large" });
  expect(mixed.envelopes[0]!.value).toEqual([]);
});

test("보장 2 값 틀: 실행 ID·지문·값을 싣고 왕복하며, 바이트 배치는 종류 1 + 값 길이 3 + 실행 ID 36 + 지문 64 + 값이다", () => {
  expect(CREDENTIAL_MAX_BYTES).toBe(16_384);
  expect(CREDENTIAL_MAX_BYTES).toBeLessThanOrEqual(64 * 1024);
  expect([CREDENTIAL_RUN_ID_BYTES, CREDENTIAL_DIGEST_BYTES, CREDENTIAL_HEAD_BYTES]).toEqual([36, 64, 100]);
  for (const value of [fake(1), fake(37, 1), fake(CREDENTIAL_MAX_BYTES, 2)]) {
    const frame = credentialFrame(value);
    expect(frame.length).toBe(FRAME_PREFIX_BYTES + CREDENTIAL_HEAD_BYTES + value.length);
    expect([...frame.subarray(0, FRAME_PREFIX_BYTES)]).toEqual([...header(FRAME_KIND_CREDENTIAL, value.length)]);
    expect(String.fromCharCode(...frame.subarray(4, 40))).toBe(RUN_ID);
    expect(String.fromCharCode(...frame.subarray(40, 104))).toBe(sha256(value));
    expect(sameBytes(frame.subarray(104), value)).toBe(true);
    const decoded = run([frame]);
    expect(decoded.rejected).toBeNull();
    expect(decoded.frames).toEqual([credentialSummary(value)]);
  }
  // 실행 ID·지문은 시작 지시의 글과 같은 꼴이다(계약 v1 schema의 UUID·SHA256).
  expect(UUID.test(RUN_ID) && UUID.test(OTHER_RUN_ID) && SHA256.test(sha256(fake(3)))).toBe(true);
  // 인코더는 넘긴 값을 붙잡지 않는다(복사한다).
  const source = fake(20);
  const copied = credentialFrame(source);
  const before = sha256(source);
  source.fill(0);
  expect(run([copied]).frames).toEqual([{ kind: "credential", runId: RUN_ID, digest: before, length: 20, sha256: before }]);
});

test("보장 2 상한과 0바이트: 머리 4바이트에서, 실행 ID·지문 칸과 값 버퍼를 잡기 전에 거절한다", () => {
  const atMax = run([credentialFrame(fake(CREDENTIAL_MAX_BYTES))]);
  expect(atMax.rejected).toBeNull();
  expect(atMax.frames.map((f) => (f.kind === "credential" ? f.length : -1))).toEqual([CREDENTIAL_MAX_BYTES]);
  for (const [length, reason] of [
    [CREDENTIAL_MAX_BYTES + 1, "frame_credential_too_large"],
    [0xff_ffff, "frame_credential_too_large"],
    [0, "frame_credential_empty"],
  ] as const) {
    const decoder = createMixedFrameDecoder();
    const head = header(FRAME_KIND_CREDENTIAL, length);
    for (let i = 0; i < FRAME_PREFIX_BYTES - 1; i++) expect(decoder.push(head.subarray(i, i + 1)).rejected, `${length}`).toBeNull();
    expect(safe(decoder.push(head.subarray(FRAME_PREFIX_BYTES - 1))), `${length}`).toEqual({ frames: [], rejected: reason });
    expect(decoder.heldBytes(), `${length}`).toBe(FRAME_PREFIX_BYTES);
    expect(safe(decoder.push(credentialFrame(fake(8)))), `${length}`).toEqual({ frames: [], rejected: reason });
  }
  // 인코더도 같은 경계에서 틀을 만들지 않는다.
  const digest = sha256(fake(1));
  expect(encodeCredentialFrame(RUN_ID, digest, new Uint8Array(0))).toEqual({ ok: false, reason: "frame_credential_empty" });
  expect(encodeCredentialFrame(RUN_ID, digest, fake(CREDENTIAL_MAX_BYTES + 1))).toEqual({ ok: false, reason: "frame_credential_too_large" });
  expect(encodeCredentialFrame(RUN_ID, digest, fake(CREDENTIAL_MAX_BYTES)).ok).toBe(true);
});

test("보장 2 꼴: 실행 ID·지문의 꼴이 틀리면 값을 내지 않고, 머리를 다 받은 때 값 버퍼를 잡기 전에 거절한다", () => {
  const value = fake(48);
  const good = credentialFrame(value);
  const swap = (text: string, at: number, char: string) => text.slice(0, at) + char + text.slice(at + 1);
  const badRunIds = [
    RUN_ID.toUpperCase(),
    swap(RUN_ID, 0, "g"),
    swap(swap(RUN_ID, 8, "5"), 9, "-"),
    RUN_ID.replaceAll("-", "0"),
    swap(RUN_ID, 0, "\u0000"),
    swap(RUN_ID, 35, " "),
    swap(RUN_ID, 3, "Ã"),
  ];
  const digest = sha256(value);
  const badDigests = [digest.toUpperCase(), swap(digest, 0, "g"), swap(digest, 63, "\u0000"), swap(digest, 10, "\u0080"), swap(digest, 8, "-")];
  // 시험의 틀린 꼴은 계약 v1 schema도 받지 않는 글이다.
  expect(badRunIds.some((id) => UUID.test(id)) || badDigests.some((d) => SHA256.test(d))).toBe(false);
  const cases = [
    ...badRunIds.map((text) => ({ text, at: FRAME_PREFIX_BYTES, reason: "frame_credential_bad_run_id" as const })),
    ...badDigests.map((text) => ({ text, at: FRAME_PREFIX_BYTES + CREDENTIAL_RUN_ID_BYTES, reason: "frame_credential_bad_digest" as const })),
  ];
  for (const { text, at, reason } of cases) {
    const frame = good.slice();
    frame.set(Uint8Array.from(text, (c) => c.charCodeAt(0)), at);
    const decoder = createMixedFrameDecoder();
    const headEnd = FRAME_PREFIX_BYTES + CREDENTIAL_HEAD_BYTES;
    expect(safe(decoder.push(frame.subarray(0, headEnd - 1))), JSON.stringify(text)).toEqual({ frames: [], rejected: null });
    expect(decoder.heldBytes()).toBe(FRAME_PREFIX_BYTES + CREDENTIAL_HEAD_BYTES);
    expect(safe(decoder.push(frame.subarray(headEnd - 1, headEnd))), JSON.stringify(text)).toEqual({ frames: [], rejected: reason });
    expect(decoder.heldBytes()).toBe(FRAME_PREFIX_BYTES);
    expect(safe(decoder.push(frame.subarray(headEnd))), JSON.stringify(text)).toEqual({ frames: [], rejected: reason });
    // 인코더도 같은 꼴을 받지 않는다(0xFF를 넘는 글자 코드가 잘려 올바른 바이트가 되는 경우 포함).
    const encoded = at === FRAME_PREFIX_BYTES ? encodeCredentialFrame(text, digest, value) : encodeCredentialFrame(RUN_ID, text, value);
    expect(encoded, JSON.stringify(text)).toEqual({ ok: false, reason });
  }
  expect(encodeCredentialFrame(swap(RUN_ID, 0, "İ"), digest, value)).toEqual({ ok: false, reason: "frame_credential_bad_run_id" });
  expect(encodeCredentialFrame(RUN_ID.slice(1), digest, value)).toEqual({ ok: false, reason: "frame_credential_bad_run_id" });
  expect(encodeCredentialFrame(RUN_ID, `${digest}0`, value)).toEqual({ ok: false, reason: "frame_credential_bad_digest" });
});

test("보장 3 값: 봉투처럼 보이는 바이트·NUL·깨진 UTF-8도 해석하지 않고 받은 그대로, 버퍼를 나누지 않는 새 배열로 낸다", () => {
  const values = [
    utf8('{"header":{"action":"task_start"},"signature":"x","body":{"credential":1}}'),
    Uint8Array.of(0x71, 0x5a, 0x37, 0x23, 0x00, 0x00, 0x41, 0x00),
    Uint8Array.of(0x71, 0x5a, 0x37, 0x23, 0xff, 0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xe2, 0x82),
    Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d),
    Uint8Array.from({ length: 256 }, (_, i) => i),
  ];
  for (const value of values) {
    const chunk = concat(envelopeFrame(utf8('{"n":0}')), credentialFrame(value), credentialFrame(fake(9, 3), OTHER_RUN_ID));
    const step = createMixedFrameDecoder().push(chunk);
    expect(step.rejected).toBeNull();
    expect(step.frames.map((f) => f.kind)).toEqual(["envelope", "credential", "credential"]);
    const first = step.frames[1]!;
    const second = step.frames[2]!;
    if (first.kind !== "credential" || second.kind !== "credential") throw new Error("kind");
    const got = first.credential.value;
    expect(sameBytes(got, value)).toBe(true);
    expect(first.credential.digest).toBe(sha256(value));
    // 새 배열이고 다른 바이트와 버퍼를 나누지 않는다: 받은 조각, 실행 ID·지문 칸, 다음 값과 다른 버퍼다.
    expect(got.byteOffset === 0 && got.buffer.byteLength === value.length).toBe(true);
    expect(got.buffer === chunk.buffer || got.buffer === second.credential.value.buffer).toBe(false);
    chunk.fill(0);
    expect(sameBytes(got, value)).toBe(true);
  }
});

test("보장 3 해석기: 값 틀은 JSON.parse와 TextDecoder를 한 번도 부르지 않는다(봉투 틀은 부른다)", () => {
  const value = utf8('{"header":{},"signature":"x","body":{}}');
  const credentials = concat(credentialFrame(value), credentialFrame(Uint8Array.of(0xff, 0x00, 0xfe)));
  const envelope = envelopeFrame(utf8('{"a":"가"}'));
  const originalParse = JSON.parse;
  const originalDecode = TextDecoder.prototype.decode;
  let parses = 0;
  let decodes = 0;
  JSON.parse = function (this: unknown, ...args: Parameters<typeof JSON.parse>) {
    parses++;
    return originalParse.apply(this, args);
  } as typeof JSON.parse;
  TextDecoder.prototype.decode = function (this: TextDecoder, ...args: Parameters<TextDecoder["decode"]>) {
    decodes++;
    return originalDecode.apply(this, args);
  };
  let credentialCalls = -1;
  let envelopeCalls = -1;
  let step: MixedDecodeStep | null = null;
  try {
    const decoder = createMixedFrameDecoder();
    step = decoder.push(credentials);
    credentialCalls = parses + decodes;
    decoder.push(envelope);
    envelopeCalls = parses + decodes - credentialCalls;
  } finally {
    JSON.parse = originalParse;
    TextDecoder.prototype.decode = originalDecode;
  }
  expect(step === null ? null : safe(step).frames.map((f) => f.kind)).toEqual(["credential", "credential"]);
  expect(step?.rejected).toBeNull();
  expect(credentialCalls).toBe(0);
  // 대조군: 같은 감시 아래 봉투 틀은 두 해석기를 지난다(감시가 실제로 걸렸다는 증거).
  expect(envelopeCalls).toBeGreaterThan(1);
});

test("보장 3 거절에 값이 실리지 않는다: 거절의 사유·반환값·오류와 인코더의 실패에 값의 조각이 없다", () => {
  const value = fake(96, 5);
  const frame = credentialFrame(value);
  const headEnd = FRAME_PREFIX_BYTES + CREDENTIAL_HEAD_BYTES;
  const badRunId = frame.slice();
  badRunId[FRAME_PREFIX_BYTES] = 0x47;
  const badDigest = frame.slice();
  badDigest[FRAME_PREFIX_BYTES + CREDENTIAL_RUN_ID_BYTES] = 0x47;
  const afterEnd = createMixedFrameDecoder();
  afterEnd.end();
  const runs = [
    { name: "bad_run_id", result: run([badRunId]), reason: "frame_credential_bad_run_id" },
    { name: "bad_digest", result: run([badDigest]), reason: "frame_credential_bad_digest" },
    { name: "bytewise bad_digest", result: run([...badDigest].map((b) => Uint8Array.of(b))), reason: "frame_credential_bad_digest" },
    { name: "truncated value", result: run([frame.subarray(0, headEnd + 50)]), reason: "frame_truncated" },
    { name: "truncated bytewise", result: run([...frame.subarray(0, frame.length - 1)].map((b) => Uint8Array.of(b))), reason: "frame_truncated" },
    { name: "after end", result: run([frame], afterEnd), reason: "frame_after_end" },
    { name: "too large", result: run([concat(header(FRAME_KIND_CREDENTIAL, CREDENTIAL_MAX_BYTES + 1), frame.subarray(4))]), reason: "frame_credential_too_large" },
    { name: "unknown kind", result: run([concat(Uint8Array.of(0x02), frame.subarray(1))]), reason: "frame_unknown_kind" },
  ];
  for (const { name, result, reason } of runs) {
    expect(result.thrown === null, name).toBe(true);
    expect(result.rejected, name).toBe(reason as MixedFrameRejectReason);
    expect(result.frames.length, name).toBe(0);
    expect(leaks(JSON.stringify(result.steps), value), name).toBe(false);
  }
  // 봉투만 받는 디코더의 거절도 같다.
  const old = createFrameDecoder();
  const oldSteps = [old.push(frame), old.end()];
  expect(leaks(JSON.stringify(oldSteps), value)).toBe(false);
  // 인코더의 실패도 사유 이름뿐이다.
  const failures = [
    encodeCredentialFrame("x", sha256(value), value),
    encodeCredentialFrame(RUN_ID, "y", value),
    encodeCredentialFrame(RUN_ID, sha256(value), concat(value, new Uint8Array(CREDENTIAL_MAX_BYTES))),
  ];
  expect(failures.every((f) => !f.ok && Object.keys(f).join() === "ok,reason")).toBe(true);
  expect(leaks(JSON.stringify(failures), value)).toBe(false);
  // 검사 자체가 표지를 찾는지 대조한다(성공한 값 틀은 값을 싣는다).
  expect(leaks(JSON.stringify(run([frame]).steps), value)).toBe(true);
});

test("조각: 값 틀을 머리·실행 ID·지문·값의 어느 자리에서 잘라도, 봉투 틀과 섞여도 받은 순서 그대로 낸다", () => {
  const x = fake(40, 7);
  const y = fake(25, 8);
  const stream = concat(envelopeFrame(utf8('{"a":1}')), credentialFrame(x), envelopeFrame(utf8('["b"]')), credentialFrame(y, OTHER_RUN_ID));
  const expected: Summary[] = [{ kind: "envelope", value: { a: 1 } }, credentialSummary(x), { kind: "envelope", value: ["b"] }, credentialSummary(y, OTHER_RUN_ID)];
  const whole = run([stream]);
  expect(whole.rejected).toBeNull();
  expect(whole.frames).toEqual(expected);
  for (let i = 0; i <= stream.length; i++) {
    const split = run([stream.subarray(0, i), stream.subarray(i)]);
    expect(split.rejected, `split ${i}`).toBeNull();
    expect(split.frames, `split ${i}`).toEqual(expected);
  }
  const one = credentialFrame(x);
  for (let i = 0; i <= one.length; i++) {
    for (let j = i; j <= one.length; j++) {
      const split = run([one.subarray(0, i), one.subarray(i, j), one.subarray(j)]);
      expect(split.frames, `split ${i},${j}`).toEqual([credentialSummary(x)]);
    }
  }
  expect(run([...stream].map((b) => Uint8Array.of(b))).frames).toEqual(expected);
  expect(run([new Uint8Array(0), stream, new Uint8Array(0)]).frames).toEqual(expected);
});

test("끝 알림: 값 틀의 중간(머리·실행 ID·지문·값)에서 끝나면 frame_truncated, 끝 알림 뒤의 조각은 frame_after_end다", () => {
  const value = fake(30, 9);
  const frame = credentialFrame(value);
  const lead = envelopeFrame(utf8("{}"));
  for (let i = 1; i < frame.length; i++) {
    const cut = run([frame.subarray(0, i)]);
    expect({ frames: cut.frames, rejected: cut.rejected }, `cut ${i}`).toEqual({ frames: [], rejected: "frame_truncated" });
    const after = run([concat(lead, frame.subarray(0, i))]);
    expect(after.frames, `cut ${i}`).toEqual([{ kind: "envelope", value: {} }]);
    expect(after.rejected, `cut ${i}`).toBe("frame_truncated");
  }
  expect(run([frame]).rejected).toBeNull();
  expect(run([]).rejected).toBeNull();
  const decoder = createMixedFrameDecoder();
  expect(safe(decoder.push(frame))).toEqual({ frames: [credentialSummary(value)], rejected: null });
  expect(safe(decoder.end())).toEqual({ frames: [], rejected: null });
  expect(safe(decoder.push(frame))).toEqual({ frames: [], rejected: "frame_after_end" });
  expect(safe(decoder.end())).toEqual({ frames: [], rejected: "frame_after_end" });
});

// 봉투만 오는 흐름을 두 디코더에 같은 조각으로 넣고, push·end마다 결과와 heldBytes를 대조한다.
function sameAsEnvelopeDecoder(chunks: Uint8Array[], label: string): void {
  const old = createFrameDecoder();
  const mixed = createMixedFrameDecoder();
  const asEnvelopeStep = (step: MixedDecodeStep) => ({
    envelopes: step.frames.map((f) => (f.kind === "envelope" ? f.envelope : "credential")),
    rejected: step.rejected,
  });
  const compare = (a: DecodeStep, b: MixedDecodeStep, at: string) => {
    expect(asEnvelopeStep(b), `${label} ${at}`).toEqual(a as unknown as ReturnType<typeof asEnvelopeStep>);
    expect(mixed.heldBytes(), `${label} ${at}`).toBe(old.heldBytes());
  };
  chunks.forEach((chunk, i) => compare(old.push(chunk), mixed.push(chunk), `push ${i}`));
  compare(old.end(), mixed.end(), "end");
  compare(old.push(envelopeFrame(utf8("{}"))), mixed.push(envelopeFrame(utf8("{}"))), "after end");
}

test("보장 4 봉투 틀: 섞어 받는 디코더도 봉투만 오는 흐름에서는 기존 디코더와 같은 결과·같은 heldBytes를 낸다", () => {
  const framed = (text: string) => envelopeFrame(utf8(text));
  const bodyOfSize = (n: number) => utf8(`{"p":"${"x".repeat(n - '{"p":""}'.length)}"}`);
  const max = envelopeFrame(bodyOfSize(FRAME_MAX_BODY_BYTES));
  const prefix = (length: number) => header(0, length);
  const small = [
    concat(framed('{"a":1}'), framed('{"header":{"action":"ack"},"body":["가",null,true]}'), framed('{"s":"😀\\n\\""}')),
    framed('{"a":1,"\\u0061":2}'),
    framed('[1,{"y":[{"a":1,"\\u0061":2}]}]'),
    framed('{"a":{"a":1},"b":[{"a":1},{"a":2}]}'),
    envelopeFrame(concat(utf8('{"a":"'), Uint8Array.of(0xed, 0xa0, 0x80), utf8('"}'))),
    envelopeFrame(concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8("{}"))),
    framed(`${"[".repeat(17)}1${"]".repeat(17)}`),
    framed(`${"[".repeat(16)}1${"]".repeat(16)}`),
    framed("{} {}"),
    framed('{"a":01}'),
    prefix(0),
    concat(framed("{}"), prefix(FRAME_MAX_BODY_BYTES + 1), utf8("{not json")),
    concat(framed("{}"), prefix(0xff_ffff)),
    framed('{"a":"가"}').subarray(0, 9),
    concat(framed("[]"), framed('{"a":"가"}').subarray(0, 2)),
  ];
  for (const [k, stream] of small.entries()) {
    sameAsEnvelopeDecoder([stream], `case ${k} whole`);
    for (let i = 0; i <= stream.length; i++) sameAsEnvelopeDecoder([stream.subarray(0, i), stream.subarray(i)], `case ${k} split ${i}`);
    sameAsEnvelopeDecoder([...stream].map((b) => Uint8Array.of(b)), `case ${k} bytewise`);
  }
  // 상한 정각의 봉투 틀 여럿을 고르지 않은 크기로.
  const big = concat(max, max, max);
  for (const sizes of [[big.length], [1, 3, 7, 4096, 65_539, 65_541]]) {
    const chunks: Uint8Array[] = [];
    for (let at = 0, k = 0; at < big.length; at += sizes[k++ % sizes.length]!) chunks.push(big.subarray(at, at + sizes[k % sizes.length]!));
    sameAsEnvelopeDecoder(chunks, `max ${sizes.length}`);
  }
  sameAsEnvelopeDecoder([max.subarray(0, max.length - 1), concat(max.subarray(max.length - 1), prefix(FRAME_MAX_BODY_BYTES))], "max edge");
  // 봉투 틀의 바이트는 종류가 없던 형식과 같다: 첫 바이트가 늘 0이고 나머지 셋이 길이다.
  for (const n of [1, 255, 256, 65_535, FRAME_MAX_BODY_BYTES]) {
    const frame = envelopeFrame(bodyOfSize(Math.max(n, 8)).subarray(0, n));
    expect([...frame.subarray(0, 4)], `${n}`).toEqual([...header(FRAME_KIND_ENVELOPE, n)]);
    expect(new DataView(frame.buffer).getUint32(0, false), `${n}`).toBe(n);
  }
});

test("메모리: 값 틀을 섞어도 push 사이에 쥔 미완성 틀은 접두 폭 + 봉투 상한 이하이고, 값 틀만이면 4 + 100 + CREDENTIAL_MAX_BYTES 이하다", () => {
  const envelopeBound = FRAME_PREFIX_BYTES + FRAME_MAX_BODY_BYTES;
  const credentialBound = FRAME_PREFIX_BYTES + CREDENTIAL_HEAD_BYTES + CREDENTIAL_MAX_BYTES;
  expect(credentialBound).toBe(16_488);
  expect(credentialBound).toBeLessThanOrEqual(envelopeBound);
  const maxCredential = credentialFrame(fake(CREDENTIAL_MAX_BYTES, 11));
  const maxEnvelope = envelopeFrame(utf8(`{"p":"${"x".repeat(FRAME_MAX_BODY_BYTES - 8)}"}`));
  const returned = (frames: readonly DecodedFrame[]) =>
    frames.reduce((n, f) => n + (f.kind === "envelope" ? f.envelope.bytes.length : CREDENTIAL_HEAD_BYTES + f.credential.value.length), 0);
  for (const [stream, bound, count] of [
    [concat(...Array.from({ length: 6 }, () => maxCredential)), credentialBound, 6],
    [concat(maxCredential, maxEnvelope, maxCredential, maxEnvelope, maxCredential), envelopeBound, 5],
  ] as const) {
    for (const sizes of [[stream.length], [1, 3, 7, 101, 4096, 16_489, 65_541]]) {
      const decoder = createMixedFrameDecoder();
      let peak = decoder.heldBytes();
      let seen = 0;
      for (let at = 0, k = 0; at < stream.length; k++) {
        const size = sizes[k % sizes.length]!;
        const chunk = stream.subarray(at, at + size);
        const before = decoder.heldBytes();
        const step = decoder.push(chunk);
        at += size;
        seen += step.frames.length;
        expect(step.rejected).toBeNull();
        expect(returned(step.frames)).toBeLessThanOrEqual(chunk.length + before);
        peak = Math.max(peak, decoder.heldBytes());
      }
      expect(seen).toBe(count);
      expect(peak).toBeLessThanOrEqual(bound);
      expect(decoder.heldBytes()).toBe(FRAME_PREFIX_BYTES);
    }
  }
  // 값의 마지막 한 바이트만 남은 때 쥐는 양이 값 틀의 최대다. 거절하면 버퍼를 놓는다.
  const edge = createMixedFrameDecoder();
  expect(safe(edge.push(maxCredential.subarray(0, maxCredential.length - 1)))).toEqual({ frames: [], rejected: null });
  expect(edge.heldBytes()).toBe(credentialBound);
  expect(edge.end().rejected).toBe("frame_truncated");
  expect(edge.heldBytes()).toBe(FRAME_PREFIX_BYTES);
});

test("거절 사유: 값 틀의 사유는 유한한 목록이고 봉투 틀의 사유·계약 v1의 사유와 겹치지 않는다", () => {
  expect([...CREDENTIAL_FRAME_REJECT_REASONS]).toEqual([
    "frame_unknown_kind",
    "frame_credential_empty",
    "frame_credential_too_large",
    "frame_credential_bad_run_id",
    "frame_credential_bad_digest",
  ]);
  for (const reason of CREDENTIAL_FRAME_REJECT_REASONS) {
    expect((FRAME_REJECT_REASONS as readonly string[]).includes(reason), reason).toBe(false);
    expect((REJECT_REASONS as readonly string[]).includes(reason), reason).toBe(false);
  }
});
