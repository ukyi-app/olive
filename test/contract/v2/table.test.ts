// 동작 표의 규칙(defineContract), 공통부의 분류, 상한이 v1의 같은 뜻 값을 따르는지, 만들기(seal)가 거절할 봉투를 서명하지 않는지.
import { expect, test } from "bun:test";
import { limits as v1Limits } from "../../../src/contract/v1/index.ts";
import { type ActionSpec, type Bundle, COMMON_BUNDLE } from "../../../src/contract/v2/actions.ts";
import { defineContract, SealError } from "../../../src/contract/v2/contract.ts";
import { FRONTDOOR_CONTRACT, limits } from "../../../src/contract/v2/index.ts";
import { baseContext, contextOf, freshKeys, id, ISSUED, KNOWN_GENERATIONS, nonceOf, POLICY, PROBE, PROBE_BUNDLE, trustedRaw } from "./support.ts";

const effect: ActionSpec = { ...PROBE_BUNDLE.actions.probe_effect! };
// 일부러 규칙을 어긴 명세도 넣으므로 타입을 풀어 받는다(규칙은 defineContract가 실행 시점에 다시 본다).
const bundle = (actions: Record<string, unknown>): Bundle => ({ name: "x", actions: actions as Record<string, ActionSpec> });

test("표: 공개 면은 공통부 넷, 정지 묶음 여섯, 출력 묶음 여섯이다. 인사와 조회는 접수가 닫혀도·정책이 어긋나도 받고 세대 규칙이 없으며, 효과는 정책이 어긋나면 받지 않는다", () => {
  const rows = Object.entries(FRONTDOOR_CONTRACT.actions).map(([name, s]) => [name, s.class, [...s.from].sort().join(","), s.duringClosedIntake, s.duringPolicyMismatch, s.generations]);
  expect(rows).toEqual([
    ["handshake", "handshake", "front-door", true, true, undefined],
    ["handshake_reply", "handshake", "supervisor", true, true, undefined],
    ["job_lookup", "query", "front-door,supervisor", true, true, undefined],
    ["job_status", "query", "front-door,supervisor", true, true, undefined],
    ["stop_record_lookup", "query", "supervisor", true, true, undefined],
    ["stop_record", "query", "front-door", true, true, undefined],
    ["stop_prepare", "effect", "front-door", true, false, { stop: "newer", execution: "not_applicable" }],
    ["stop_commit", "effect", "front-door", true, false, { stop: "prepared", execution: "not_applicable" }],
    ["release_prepare", "effect", "front-door", true, false, { stop: "current", execution: "not_applicable" }],
    ["release_commit", "effect", "front-door", true, false, { stop: "prepared", execution: "next" }],
    ["reply_candidate", "effect", "supervisor", false, false, { stop: "current", execution: "current" }],
    ["approval_card_request", "effect", "supervisor", false, false, { stop: "current", execution: "current" }],
    ["publication_candidate", "effect", "supervisor", false, false, { stop: "current", execution: "current" }],
    ["progress_update", "effect", "supervisor", false, false, { stop: "current", execution: "current" }],
    ["execution_generation_lookup", "query", "front-door", true, true, undefined],
    ["execution_generation_reply", "query", "supervisor", true, true, undefined],
  ]);
  expect(Object.isFrozen(FRONTDOOR_CONTRACT.actions)).toBe(true);
});

test("표: 묶음이 공통 규칙을 어기면 표를 만들 때 던진다", () => {
  expect(() => defineContract([PROBE_BUNDLE])).toThrow("첫 묶음은 공통부");
  expect(() => defineContract([COMMON_BUNDLE, bundle({ handshake: effect })])).toThrow("이름이 겹친다");
  expect(() => defineContract([COMMON_BUNDLE, bundle({ hello_again: { ...effect, class: "handshake", parseResult: undefined } })])).toThrow("인사 동작은 공통부만");
  expect(() => defineContract([COMMON_BUNDLE, bundle({ read_x: { ...effect, class: "query", parseResult: undefined, duringClosedIntake: false } })])).toThrow("접수가 닫혀도");
  expect(() => defineContract([COMMON_BUNDLE, bundle({ do_x: { ...effect, parseResult: undefined } })])).toThrow("parseResult");
  expect(() => defineContract([COMMON_BUNDLE, bundle({ do_x: { ...effect, answers: () => true } })])).toThrow("답이 아니다");
  expect(() => defineContract([COMMON_BUNDLE, bundle({ do_x: { ...effect, from: ["executor" as never] } })])).toThrow("당사자");
  expect(() => defineContract([COMMON_BUNDLE, bundle({ "Do-X": effect })])).toThrow("꼴");
});

test("상한: 설계에 값이 없는 v2 숫자는 v1의 같은 뜻 값을 따른다(후보)", () => {
  expect(limits.CONTRACT).toBe("olive-control/v2");
  expect(limits.MESSAGE_TTL_MAX_MS).toBe(v1Limits.MESSAGE_TTL_MAX_MS);
  expect(limits.MESSAGE_TTL_MS).toBe(v1Limits.MESSAGE_TTL_MS);
  expect(limits.CLOCK_SKEW_MS).toBe(v1Limits.CLOCK_SKEW_MS);
  expect(limits.NONCE_RETENTION_MS).toBe(v1Limits.NONCE_RETENTION_MS);
  expect(limits.MAX_MESSAGE_BYTES).toBe(v1Limits.MAX_MESSAGE_BYTES);
});

test("만들기: 받는 쪽이 거절할 봉투는 서명하지 않고, 만든 봉투는 받는 쪽이 받는다", async () => {
  const keys = freshKeys();
  const input = { sender: "front-door", recipient: "supervisor", action: "handshake", request_id: id(1), issued_at: ISSUED, nonce: nonceOf(1), body: { policy_revision: POLICY } } as const;
  const sealed = FRONTDOOR_CONTRACT.seal(input, keys["front-door"].privateKey);
  expect((await FRONTDOOR_CONTRACT.verify(sealed, contextOf(trustedRaw(keys, "supervisor"), baseContext("supervisor")))).ok).toBe(true);
  const reason = (over: Record<string, unknown>) => {
    try {
      PROBE.seal({ ...input, ...over } as never, keys["front-door"].privateKey);
      return "sealed";
    } catch (error) {
      return error instanceof SealError ? error.reason : String(error);
    }
  };
  expect(reason({ action: "task_start" })).toBe("unknown_action");
  expect(reason({ sender: "supervisor", recipient: "front-door" })).toBe("wrong_direction");
  expect(reason({ recipient: "front-door" })).toBe("wrong_direction");
  expect(reason({ body: { policy_revision: POLICY, extra: 1 } })).toBe("unknown_field");
  expect(reason({ sender: "supervisor", recipient: "front-door", action: "handshake_reply", body: { in_reply_to: id(2), policy_revision: POLICY, approval: "yes" } })).toBe("forbidden_field");
  expect(reason({ action: "probe_effect", body: { note_digest: "a".repeat(64), stop_generation: 7 } })).toBe("body_malformed");
  expect(reason({ action: "probe_effect", body: { job_id: id(3), note_digest: "a".repeat(64), stop_generation: 7 } })).toBe("sealed");
  expect(reason({ body: { policy_revision: 1.5 } })).toBe("body_malformed");
});

test("받는 쪽: wrong_recipient는 두 키를 다 믿는 인위적 문맥에서만 닿는다(실제 상대 키 문맥은 unknown_sender)", async () => {
  const keys = freshKeys();
  const hello = FRONTDOOR_CONTRACT.seal(
    { sender: "front-door", recipient: "supervisor", action: "handshake", request_id: id(20), issued_at: ISSUED, nonce: nonceOf(20), body: { policy_revision: POLICY } },
    keys["front-door"].privateKey,
  );
  const both = { ...trustedRaw(keys, "supervisor"), ...trustedRaw(keys, "front-door") };
  expect(Object.keys(both).sort()).toEqual(["front-door", "supervisor"]);
  expect(await FRONTDOOR_CONTRACT.verify(hello, contextOf(both, baseContext("front-door")))).toEqual({ ok: false, reason: "wrong_recipient" });
  expect(await FRONTDOOR_CONTRACT.verify(hello, contextOf(trustedRaw(keys, "front-door"), baseContext("front-door")))).toEqual({ ok: false, reason: "unknown_sender" });
});

test("본문: 효과 요청의 작업은 본문 맨 위의 job_id와 그 봉투의 body_digest다", async () => {
  const keys = freshKeys();
  const ctx = contextOf(trustedRaw(keys, "supervisor"), baseContext("supervisor", { handshake: "agreed", intake_open: true, generations: KNOWN_GENERATIONS }));
  const sealed = PROBE.seal(
    { sender: "front-door", recipient: "supervisor", action: "probe_effect", request_id: id(10), issued_at: ISSUED, nonce: nonceOf(10), body: { job_id: id(9), note_digest: "c".repeat(64), stop_generation: 7 } },
    keys["front-door"].privateKey,
  );
  const got = await PROBE.verify(sealed, ctx);
  expect(got.ok && got.job).toEqual({ job_id: id(9), action: "probe_effect", request_digest: sealed.header.body_digest });
});
