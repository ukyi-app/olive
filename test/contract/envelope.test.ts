import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { digestOf } from "../../src/contract/v1/canonical.ts";
import { rawPublicKey, sealEnvelope, SealError, signUnchecked, verifyEnvelope } from "../../src/contract/v1/envelope.ts";
import type { Header } from "../../src/contract/v1/header.ts";
import { CLOCK_SKEW_MS, MESSAGE_TTL_MAX_MS, MESSAGE_TTL_MS } from "../../src/contract/v1/limits.ts";
import {
  buildCases,
  DIAGNOSIS,
  freshKeys,
  id,
  ISSUED,
  NOW,
  RUN_GENERATIONS,
  RUN_TASK,
  SESSION,
  STOP_GENERATION,
  SUPERVISOR,
} from "./cases.ts";
import { contextOf, MemoryNonces } from "./support.ts";

const keys = freshKeys();
const trusted = Object.fromEntries(Object.entries(keys).map(([name, pair]) => [name, rawPublicKey(pair.publicKey)]));
const context = (patch: Partial<Parameters<typeof contextOf>[1]> = {}) => ({
  now: NOW,
  expected_recipient: DIAGNOSIS,
  stop_generation: STOP_GENERATION,
  stop_sync_challenge: null,
  run_generations: { ...RUN_GENERATIONS },
  spent_nonces: [],
  ...patch,
});
let nonceCounter = 0;
const cancel = (issued = ISSUED, extra: Partial<{ run_generation: number; stop_generation: number }> = {}) =>
  sealEnvelope(
    {
      sender: SUPERVISOR,
      recipient: DIAGNOSIS,
      action: "task_cancel",
      request_id: id(0xa000 + ++nonceCounter),
      stop_generation: STOP_GENERATION,
      run_generation: 2,
      issued_at: issued,
      nonce: (0xabc000 + nonceCounter).toString(16).padStart(32, "0"),
      body: { run_id: RUN_TASK, reason: "requested" },
      ...extra,
    },
    keys[SUPERVISOR]!.privateKey,
  );
const verify = (message: unknown, patch = {}, nonces = new MemoryNonces()) => verifyEnvelope(message, contextOf(trusted, context(patch), nonces));

test("envelope: 만든 봉투는 통과하고 한 번만 쓸 수 있다(nonce)", async () => {
  const message = cancel();
  const nonces = new MemoryNonces();
  expect((await verify(message, {}, nonces)).ok).toBe(true);
  expect(await verify(message, {}, nonces)).toEqual({ ok: false, reason: "replayed" });
});

test("envelope: 받는 쪽이 다르면 거절", async () => {
  expect(await verify(cancel(), { expected_recipient: SESSION })).toEqual({ ok: false, reason: "wrong_recipient" });
});

test("envelope: digest가 다르면 거절", async () => {
  const message = cancel();
  expect(await verify({ ...message, body: { run_id: RUN_TASK, reason: "deadline" } })).toEqual({ ok: false, reason: "digest_mismatch" });
});

test("envelope: 시한 30초를 넘으면 거절(연결이 살아 있어도)", async () => {
  expect(await verify(cancel(NOW - MESSAGE_TTL_MS))).toEqual({ ok: false, reason: "expired" });
  expect((await verify(cancel(NOW - MESSAGE_TTL_MS + 1))).ok).toBe(true);
  expect(await verify(cancel(NOW + CLOCK_SKEW_MS + 1))).toEqual({ ok: false, reason: "not_yet_valid" });
  expect((await verify(cancel(NOW + CLOCK_SKEW_MS))).ok).toBe(true);
  // 수명 경계는 받는 쪽 상한으로 잰다. 발급 기본값(MESSAGE_TTL_MS)을 낮춰도 상한 정각은 받고 상한 + 1ms는 거절한다.
  const atMax = signUnchecked({ ...cancel().header, expires_at: ISSUED + MESSAGE_TTL_MAX_MS }, cancel().body, keys[SUPERVISOR]!.privateKey);
  expect((await verify(atMax)).ok).toBe(true);
  const long = signUnchecked({ ...cancel().header, expires_at: ISSUED + MESSAGE_TTL_MAX_MS + 1 }, cancel().body, keys[SUPERVISOR]!.privateKey);
  expect(await verify(long)).toEqual({ ok: false, reason: "lifetime_invalid" });
  const backwards = signUnchecked({ ...cancel().header, expires_at: ISSUED }, cancel().body, keys[SUPERVISOR]!.privateKey);
  expect(await verify(backwards)).toEqual({ ok: false, reason: "lifetime_invalid" });
});

test("envelope: nonce를 다시 쓰면 거절하고, 거절된 봉투는 nonce를 쓰지 않는다", async () => {
  const message = cancel();
  const nonces = new MemoryNonces();
  expect(await verify(message, { expected_recipient: SESSION }, nonces)).toEqual({ ok: false, reason: "wrong_recipient" });
  expect(await verify(message, { stop_generation: 9 }, nonces)).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(nonces.spent.size).toBe(0);
  expect((await verify(message, {}, nonces)).ok).toBe(true);
  expect(await verify(message, {}, nonces)).toEqual({ ok: false, reason: "replayed" });
});

test("envelope: 서명이 맞아도 옛 세대(정지 세대·실행 세대)면 거절", async () => {
  expect(await verify(cancel(), { stop_generation: STOP_GENERATION + 1 })).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(await verify(cancel(), { run_generations: { [RUN_TASK]: 3 } })).toEqual({ ok: false, reason: "run_generation_mismatch" });
  // 앞선 세대도 받지 않는다(정확히 같아야 한다).
  expect(await verify(cancel(), { run_generations: { [RUN_TASK]: 1 } })).toEqual({ ok: false, reason: "run_generation_mismatch" });
  expect(await verify(cancel(), { run_generations: {} })).toEqual({ ok: false, reason: "unknown_run" });
});

test("envelope: 다른 키·다른 표기의 서명, 서명 뒤 머리를 바꾼 봉투를 거절한다(옛 봇 사례)", async () => {
  const message = cancel();
  const other = generateKeyPairSync("ed25519");
  expect(await verify(signUnchecked(message.header, message.body, other.privateKey))).toEqual({ ok: false, reason: "bad_signature" });
  expect(await verify({ ...message, signature: `${message.signature}=` })).toEqual({ ok: false, reason: "bad_signature" });
  expect(await verify({ ...message, signature: 7 })).toEqual({ ok: false, reason: "bad_signature" });
  expect(await verify({ ...message, header: { ...message.header, run_generation: 3 } }, { run_generations: { [RUN_TASK]: 3 } })).toEqual({
    ok: false,
    reason: "bad_signature",
  });
});

test("envelope: 받은 JSON의 칸 순서가 달라도 같은 봉투다(옛 봇 사례)", async () => {
  const message = cancel();
  const reverse = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reverse)
      : typeof value === "object" && value !== null
        ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverse(v)]))
        : value;
  expect((await verify(JSON.parse(JSON.stringify(reverse(message))))).ok).toBe(true);
});

test("envelope: 다른 동작의 봉투로 쓸 수 없다(동작과 본문이 서명에 묶인다)", async () => {
  const message = cancel();
  const asRenew = { ...message, header: { ...message.header, action: "run_renew" } };
  expect(await verify(asRenew)).toEqual({ ok: false, reason: "bad_signature" });
});

test("envelope: 모양이 틀린 봉투는 서명 전에 거절한다", async () => {
  const message = cancel();
  expect(await verify(null)).toEqual({ ok: false, reason: "malformed" });
  expect(await verify([message])).toEqual({ ok: false, reason: "malformed" });
  expect(await verify({ header: message.header, signature: message.signature })).toEqual({ ok: false, reason: "malformed" });
  expect(await verify({ ...message, extra: 1 })).toEqual({ ok: false, reason: "unknown_field" });
  for (const patch of [{ stop_generation: -1 }, { stop_generation: 1.5 }, { nonce: "ABC" }, { issued_at: "1" }, { sender: "executor/unknown/a/b" }]) {
    expect(await verify({ ...message, header: { ...message.header, ...patch } }), JSON.stringify(patch)).toEqual({ ok: false, reason: "malformed" });
  }
  const noNonce: Record<string, unknown> = { ...message.header };
  delete noNonce.nonce;
  expect(await verify({ ...message, header: noNonce })).toEqual({ ok: false, reason: "malformed" });
});

test("envelope: 정규화할 수 없는 본문(소수, 짝 없는 서로게이트)은 body_malformed", async () => {
  const header = cancel().header;
  for (const body of [{ run_id: RUN_TASK, reason: "requested", n: 1.5 }, { run_id: RUN_TASK, reason: "\ud800" }]) {
    const message = signUnchecked({ ...header, body_digest: digestOf({}) }, body, keys[SUPERVISOR]!.privateKey);
    expect(await verify(message)).toEqual({ ok: false, reason: "body_malformed" });
  }
});

test("envelope: 실행에 묶이지 않는 메시지는 실행 세대가 0이어야 한다", async () => {
  const ack = (runGeneration: number) =>
    sealEnvelope(
      {
        sender: SUPERVISOR,
        recipient: DIAGNOSIS,
        action: "ack",
        request_id: id(0xb001 + runGeneration),
        stop_generation: STOP_GENERATION,
        run_generation: runGeneration,
        issued_at: ISSUED,
        nonce: (0xb001 + runGeneration).toString(16).padStart(32, "0"),
        body: { ids: [id(1)] },
      },
      keys[SUPERVISOR]!.privateKey,
    );
  expect((await verify(ack(0))).ok).toBe(true);
  expect(await verify(ack(1))).toEqual({ ok: false, reason: "run_generation_mismatch" });
});

test("envelope: 새 실행을 여는 지시만 모르는 실행 ID를 받고, 그때 세대는 1 이상이다", async () => {
  const cases = buildCases(keys);
  const start = cases.find((c) => c.name === "accept/task-start")!;
  const zero = signUnchecked({ ...start.message.header, run_generation: 0 } as Header, start.message.body, keys[SUPERVISOR]!.privateKey);
  expect(await verifyEnvelope(zero, contextOf(start.keys, start.context))).toEqual({ ok: false, reason: "run_generation_mismatch" });
});

test("envelope: sealEnvelope는 계약 밖의 봉투를 만들지 않는다", () => {
  const input = {
    sender: SUPERVISOR,
    recipient: DIAGNOSIS,
    action: "task_cancel" as const,
    request_id: id(0xc001),
    stop_generation: STOP_GENERATION,
    run_generation: 2,
    issued_at: ISSUED,
    nonce: "c001".padStart(32, "0"),
    body: { run_id: RUN_TASK, reason: "requested" as const },
  };
  const reason = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof SealError ? error.reason : String(error);
    }
    return "sealed";
  };
  const key = keys[SUPERVISOR]!.privateKey;
  expect(reason(() => sealEnvelope(input, key))).toBe("sealed");
  expect(sealEnvelope(input, key).header.expires_at - ISSUED).toBe(MESSAGE_TTL_MS);
  expect(reason(() => sealEnvelope({ ...input, recipient: SESSION }, key))).toBe("wrong_direction");
  expect(reason(() => sealEnvelope({ ...input, sender: DIAGNOSIS }, key))).toBe("wrong_direction");
  expect(reason(() => sealEnvelope({ ...input, nonce: "short" }, key))).toBe("malformed");
  expect(reason(() => sealEnvelope({ ...input, body: { ...input.body, image: "x" } as typeof input.body }, key))).toBe("forbidden_field");
  expect(reason(() => sealEnvelope({ ...input, body: { ...input.body, note: "x" } as typeof input.body }, key))).toBe("body_malformed");
  expect(reason(() => sealEnvelope({ ...input, body: { ...input.body, reason: "because" } as unknown as typeof input.body }, key))).toBe(
    "body_malformed",
  );
});
