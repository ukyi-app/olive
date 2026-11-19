// 효과 동작의 세대 규칙(등록 때 선언, 받을 때 강제)과 동작마다의 정책 불일치 선언. 효과 동작은 시험 전용 probe 묶음으로 본다.
import { expect, test } from "bun:test";
import { type ActionSpec, type Bundle, COMMON_BUNDLE, EFFECTS_DURING_POLICY_MISMATCH, type EffectSpec } from "../../../src/contract/v2/actions.ts";
import { defineContract, SealError } from "../../../src/contract/v2/contract.ts";
import { type GenerationAuthorities, generationMismatch, type GenerationRule } from "../../../src/contract/v2/generations.ts";
import { FRONTDOOR_CONTRACT } from "../../../src/contract/v2/index.ts";
import {
  baseContext,
  type CaseContext,
  contextOf,
  envelope,
  freshKeys,
  id,
  ISSUED,
  KNOWN_GENERATIONS,
  nonceOf,
  POLICY,
  PROBE,
  PROBE_BUNDLE,
  probeBody,
  trustedRaw,
  UNKNOWN_GENERATIONS,
} from "./support.ts";

const keys = freshKeys();
const JOB = id(0x801);
const agreed = { handshake: "agreed" as const, intake_open: true };
let n = 0;

const at = (message: unknown, receiver: "supervisor" | "front-door", over: Partial<CaseContext> = {}) =>
  PROBE.verify(message, contextOf(trustedRaw(keys, receiver), baseContext(receiver, { ...agreed, generations: KNOWN_GENERATIONS, ...over })));

// 현관이 감독에게 낸 probe 효과(probe_return만 감독이 현관에게).
function effect(action: string, over: Record<string, unknown> = {}) {
  const sender = action === "probe_return" ? "supervisor" : "front-door";
  const recipient = sender === "supervisor" ? "front-door" : "supervisor";
  n++;
  return { message: envelope(keys, { sender, recipient, action, request_id: id(0x900 + n), nonce: nonceOf(0x900 + n) }, probeBody(action, JOB, over)), recipient } as const;
}

const bundle = (actions: Record<string, unknown>): Bundle => ({ name: "x", actions: actions as Record<string, ActionSpec> });
const base = PROBE_BUNDLE.actions.probe_effect as EffectSpec;

test("등록: 효과 동작은 정지·실행 세대 규칙을 각각 선언해야 표에 오른다", () => {
  // 타입: generations 없는 효과 명세는 만들 수 없다.
  // @ts-expect-error 효과 동작은 generations를 선언해야 한다
  const noRules: EffectSpec = { class: "effect", from: ["front-door"], duringClosedIntake: false, duringPolicyMismatch: false, parse: base.parse, parseResult: base.parseResult };
  // 실행 시점: 선언이 없거나, 하나만 있거나, 닫힌 목록 밖의 규칙이면 던진다.
  expect(() => defineContract([COMMON_BUNDLE, bundle({ do_x: noRules })])).toThrow("세대 규칙");
  expect(() => defineContract([COMMON_BUNDLE, bundle({ do_x: { ...base, generations: { stop: "current" } } })])).toThrow("세대 규칙");
  expect(() => defineContract([COMMON_BUNDLE, bundle({ do_x: { ...base, generations: { stop: "current", execution: "later" } } })])).toThrow("세대 규칙");
  expect(() => defineContract([COMMON_BUNDLE, bundle({ do_x: { ...base, generations: { stop: "current", execution: "current", run: "current" } } })])).toThrow("세대 규칙");
  // 인사와 조회는 세대 규칙을 두지 않는다(공통 검증기가 세대를 보지 않는 분류다).
  const query = { ...base, class: "query", duringClosedIntake: true, duringPolicyMismatch: true, parseResult: undefined };
  expect(() => defineContract([COMMON_BUNDLE, bundle({ read_x: query })])).toThrow("세대 규칙");
  expect(() => defineContract([COMMON_BUNDLE, bundle({ read_x: { ...query, generations: undefined } })])).not.toThrow();
  // 해당 없음도 명시적 선언이다.
  expect(() => defineContract([COMMON_BUNDLE, bundle({ do_x: { ...base, generations: { stop: "not_applicable", execution: "not_applicable" } } })])).not.toThrow();
});

test("등록: 동작마다 정책이 어긋난 연결에서 받는지 선언하고, 효과는 정지의 준비·확정만 받을 수 있다", () => {
  const { duringPolicyMismatch: _drop, ...undeclared } = base;
  expect(() => defineContract([COMMON_BUNDLE, bundle({ do_x: undeclared })])).toThrow("정책");
  const { duringPolicyMismatch: _q, ...queryUndeclared } = { ...base, class: "query", duringClosedIntake: true, parseResult: undefined, generations: undefined };
  expect(() => defineContract([COMMON_BUNDLE, bundle({ read_x: queryUndeclared })])).toThrow("정책");
  // 예외 목록은 정지의 준비·확정 둘뿐이다(관리자 결정 2026-11-19). 목록 밖의 효과가 true를 선언하면 표를 만들 때 던진다.
  expect(EFFECTS_DURING_POLICY_MISMATCH).toEqual(["stop_prepare", "stop_commit"]);
  expect(Object.isFrozen(EFFECTS_DURING_POLICY_MISMATCH)).toBe(true);
  for (const name of ["do_x", "release_prepare", "release_commit", "input_cancel", "stop_record_lookup", "probe_stop_prepare"]) {
    expect(() => defineContract([COMMON_BUNDLE, bundle({ [name]: { ...base, duringPolicyMismatch: true } })]), name).toThrow("정책");
    expect(() => defineContract([COMMON_BUNDLE, bundle({ [name]: { ...base, duringPolicyMismatch: false } })]), name).not.toThrow();
  }
  for (const name of EFFECTS_DURING_POLICY_MISMATCH) {
    expect(() => defineContract([COMMON_BUNDLE, bundle({ [name]: { ...base, duringPolicyMismatch: true } })]), name).not.toThrow();
  }
  // 공개 면: 인사와 조회(작업 조회, 정지 기록 조회, 실행 세대 조회)는 정책이 어긋나도 되고(관리자 결정 2026-11-19: 뜻이 고정된 사실),
  // 후보 내용 조회 둘은 뜻이 고정된 사실이 아니라 받지 않는다. 효과는 예외 목록의 정지 둘만 받고 나머지는 받지 않는다.
  const queriesClosedOnMismatch = ["candidate_fetch", "candidate_chunk"];
  const effects = Object.entries(FRONTDOOR_CONTRACT.actions).filter(([, spec]) => spec.class === "effect");
  expect(effects.length).toBeGreaterThan(0);
  for (const name of queriesClosedOnMismatch) expect(FRONTDOOR_CONTRACT.actions[name]?.class, name).toBe("query");
  for (const [name, spec] of Object.entries(FRONTDOOR_CONTRACT.actions)) {
    const expected = spec.class === "effect" ? EFFECTS_DURING_POLICY_MISMATCH.includes(name) : !queriesClosedOnMismatch.includes(name);
    expect(spec.duringPolicyMismatch, name).toBe(expected);
  }
  expect(FRONTDOOR_CONTRACT.actions.release_prepare?.duringPolicyMismatch).toBe(false);
  expect(FRONTDOOR_CONTRACT.actions.release_commit?.duringPolicyMismatch).toBe(false);
});

test("받기: 필수 세대 칸이 빠진 효과는 서명이 맞아도 generation_missing이고, 만들 수도 없다", async () => {
  // 리뷰의 재현 입력: 인사를 마치고 접수를 연 문맥에서 probe_effect에 { job_id, note_digest }만.
  const bare = envelope(keys, { sender: "front-door", recipient: "supervisor", action: "probe_effect", request_id: id(0x880), nonce: nonceOf(0x880) }, { job_id: JOB, note_digest: "a".repeat(64) });
  expect(await at(bare, "supervisor")).toEqual({ ok: false, reason: "generation_missing" });
  // 실행 세대가 필요한 효과에서 실행 세대만 빠짐.
  const ret = effect("probe_return", { execution_generation: undefined });
  expect(await at(ret.message, ret.recipient)).toEqual({ ok: false, reason: "generation_missing" });
  // 꼴이 틀린 세대 값, 해당 없음인데 실린 세대 칸.
  // 소수는 정규화가 먼저 거절하므로 여기에 두지 않는다.
  for (const over of [{ stop_generation: "7" }, { stop_generation: -1 }, { stop_generation: null }, { execution_generation: 3 }]) {
    const e = effect("probe_effect", over);
    expect(await at(e.message, e.recipient), JSON.stringify(over)).toEqual({ ok: false, reason: "body_malformed" });
  }
  const seal = (body: unknown) => {
    try {
      PROBE.seal({ sender: "front-door", recipient: "supervisor", action: "probe_effect", request_id: id(0x881), issued_at: ISSUED, nonce: nonceOf(0x881), body }, keys["front-door"].privateKey);
      return "sealed";
    } catch (error) {
      return error instanceof SealError ? error.reason : String(error);
    }
  };
  expect(seal(bare.body)).toBe("generation_missing");
  expect(seal(probeBody("probe_effect", JOB, { execution_generation: 3 }))).toBe("body_malformed");
  expect(seal(probeBody("probe_effect", JOB))).toBe("sealed");
});

test("받기: 옛 세대는 서명이 맞아도 generation_mismatch이고, 규칙마다 맞는 값만 받는다", async () => {
  const cases: [string, Record<string, unknown>, boolean][] = [
    // current: 지금 세대(정지 7, 실행 3)와 같아야 한다.
    ["probe_effect", {}, true],
    ["probe_effect", { stop_generation: 6 }, false],
    ["probe_effect", { stop_generation: 8 }, false],
    ["probe_return", {}, true],
    ["probe_return", { execution_generation: 2 }, false],
    // next: 지금 + 1만.
    ["probe_stop_prepare", { stop_generation: 8 }, true],
    ["probe_stop_prepare", { stop_generation: 7 }, false],
    ["probe_stop_prepare", { stop_generation: 9 }, false],
    // prepared: 받아 둔 준비(8)와 같아야 한다.
    ["probe_stop_commit", { stop_generation: 8 }, true],
    ["probe_stop_commit", { stop_generation: 7 }, false],
  ];
  for (const [action, over, ok] of cases) {
    const e = effect(action, over);
    const got = await at(e.message, e.recipient);
    expect(got.ok ? "ok" : got.reason, `${action} ${JSON.stringify(over)}`).toBe(ok ? "ok" : "generation_mismatch");
  }
  // 받아 둔 준비가 없으면 확정은 무엇에도 묶이지 않는다.
  const commit = effect("probe_stop_commit");
  const noPrepare: GenerationAuthorities = { ...KNOWN_GENERATIONS, stop: { known: true, current: 7, prepared: null } };
  expect(await at(commit.message, commit.recipient, { generations: noPrepare })).toEqual({ ok: false, reason: "generation_mismatch" });
});

test("받기: 받는 쪽이 필요한 세대를 모르면 효과는 generation_unknown이고, 거절은 nonce를 쓰지 않는다", async () => {
  for (const action of Object.keys(PROBE_BUNDLE.actions)) {
    const e = effect(action);
    expect(await at(e.message, e.recipient, { generations: UNKNOWN_GENERATIONS }), action).toEqual({ ok: false, reason: "generation_unknown" });
  }
  // 세대마다 따로 본다: 정지만 알면 실행과 무관한 효과는 되고, 실행 세대가 필요한 효과는 닫힌다.
  const stopOnly: GenerationAuthorities = { stop: KNOWN_GENERATIONS.stop, execution: { known: false } };
  const plain = effect("probe_effect");
  expect((await at(plain.message, plain.recipient, { generations: stopOnly })).ok).toBe(true);
  const ret = effect("probe_return");
  expect(await at(ret.message, ret.recipient, { generations: stopOnly })).toEqual({ ok: false, reason: "generation_unknown" });
  // 같은 봉투를 세대를 안 뒤에 다시 받으면 통과한다(앞의 거절이 nonce를 태우지 않았다).
  const ctx = (generations: GenerationAuthorities) => contextOf(trustedRaw(keys, ret.recipient), baseContext(ret.recipient, { ...agreed, generations }));
  const nonces = ctx(KNOWN_GENERATIONS).nonces;
  expect(await PROBE.verify(ret.message, { ...ctx(UNKNOWN_GENERATIONS), nonces })).toEqual({ ok: false, reason: "generation_unknown" });
  expect((await PROBE.verify(ret.message, { ...ctx(KNOWN_GENERATIONS), nonces })).ok).toBe(true);
});

test("받기: 세대를 몰라도 인사와 조회는 통과한다(정책이 어긋난 연결의 조회도)", async () => {
  const unknown = { generations: UNKNOWN_GENERATIONS };
  const hello = envelope(keys, { sender: "front-door", recipient: "supervisor", action: "handshake", request_id: id(0x890), nonce: nonceOf(0x890) }, { policy_revision: POLICY });
  expect((await at(hello, "supervisor", { ...unknown, handshake: "none", intake_open: false })).ok).toBe(true);
  const e = effect("probe_effect");
  const job = { job_id: JOB, action: "probe_effect", request_digest: e.message.header.body_digest };
  const lookup = envelope(keys, { sender: "front-door", recipient: "supervisor", action: "job_lookup", request_id: id(0x891), nonce: nonceOf(0x891) }, job);
  for (const handshake of ["agreed", "policy_mismatch"] as const) {
    expect((await at(lookup, "supervisor", { ...unknown, handshake, intake_open: false })).ok, handshake).toBe(true);
  }
  const status = envelope(
    keys,
    { sender: "supervisor", recipient: "front-door", action: "job_status", request_id: id(0x892), nonce: nonceOf(0x892) },
    { in_reply_to: id(0x891), ...job, status: { state: "pending" } },
  );
  const awaiting = { [id(0x891)]: { action: "job_lookup", job } };
  expect((await at(status, "front-door", { ...unknown, handshake: "policy_mismatch", intake_open: false, awaiting })).ok).toBe(true);
  // 정책이 어긋난 연결의 효과는 세대를 알아도 policy_mismatch다(세대보다 연결을 먼저 본다).
  expect(await at(e.message, e.recipient, { handshake: "policy_mismatch" })).toEqual({ ok: false, reason: "policy_mismatch" });
});

test("받기: 세대는 서명과 digest를 확인한 뒤에 본다", async () => {
  // 서명이 틀리면 세대가 옛것이어도 bad_signature.
  const stale = effect("probe_effect", { stop_generation: 6 });
  const forged = { ...stale.message, signature: envelope(keys, { ...stale.message.header }, stale.message.body, "supervisor").signature };
  expect(await at(forged, "supervisor")).toEqual({ ok: false, reason: "bad_signature" });
  // 서명 뒤 본문의 세대를 바꾸면 digest_mismatch(서명한 쪽이 낸 세대만 대조한다).
  const fresh = effect("probe_effect");
  expect(await at({ ...fresh.message, body: { ...(fresh.message.body as object), stop_generation: 6 } }, "supervisor")).toEqual({ ok: false, reason: "digest_mismatch" });
});

test("판정: 닫힌 목록의 규칙마다 권위 값과의 관계", () => {
  const known = (current: number, prepared: number | null): GenerationAuthorities => ({ stop: { known: true, current, prepared }, execution: { known: false } });
  const judge = (rule: GenerationRule, value: number, authority: GenerationAuthorities) =>
    generationMismatch({ stop: rule, execution: "not_applicable" }, { stop_generation: value }, authority) ?? "ok";
  expect(judge("current", 5, known(5, null))).toBe("ok");
  expect(judge("current", 4, known(5, null))).toBe("generation_mismatch");
  expect(judge("next", 6, known(5, null))).toBe("ok");
  expect(judge("next", 7, known(5, null))).toBe("generation_mismatch");
  expect(judge("newer", 6, known(5, null))).toBe("ok");
  expect(judge("newer", 9, known(5, null))).toBe("ok");
  expect(judge("newer", 5, known(5, null))).toBe("generation_mismatch");
  expect(judge("prepared", 6, known(5, 6))).toBe("ok");
  expect(judge("prepared", 6, known(5, null))).toBe("generation_mismatch");
  expect(judge("current", 5, UNKNOWN_GENERATIONS)).toBe("generation_unknown");
  expect(judge("not_applicable", 5, UNKNOWN_GENERATIONS)).toBe("ok");
});
