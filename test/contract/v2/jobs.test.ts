// 작업 식별의 공통 규칙: 서명된 작업 ID·답 대상은 공통부가 원본에서 읽어 보관하고(R3), 조회가 가리키는 효과는 그 작업을 낸 쪽의
// 방향이어야 한다(R2). 효과 동작은 시험 전용 probe 묶음과 이 파일의 slim 묶음으로 본다.
import { expect, test } from "bun:test";
import { type Bundle, COMMON_BUNDLE } from "../../../src/contract/v2/actions.ts";
import { type Contract, defineContract, SealError } from "../../../src/contract/v2/contract.ts";
import type { Party } from "../../../src/contract/v2/header.ts";
import { effectBody, generation, literal, object, sha256 } from "../../../src/contract/v2/schema.ts";
import { baseContext, type CaseContext, contextOf, envelope, freshKeys, id, ISSUED, KNOWN_GENERATIONS, nonceOf, PROBE, PROBE_BUNDLE, probeBody, trustedRaw } from "./support.ts";

const keys = freshKeys();
let n = 0;
const next = () => ++n;

const at = (contract: Contract, message: unknown, receiver: Party, over: Partial<CaseContext> = {}) =>
  contract.verify(message, contextOf(trustedRaw(keys, receiver), baseContext(receiver, { handshake: "agreed", intake_open: true, generations: KNOWN_GENERATIONS, ...over })));

const send = (sender: Party, action: string, body: unknown) => {
  const k = next();
  return envelope(keys, { sender, recipient: sender === "supervisor" ? "front-door" : "supervisor", action, request_id: id(0xa00 + k), nonce: nonceOf(0xa00 + k) }, body);
};

const sealReason = (contract: Contract, sender: Party, action: string, body: unknown) => {
  try {
    contract.seal({ sender, recipient: sender === "supervisor" ? "front-door" : "supervisor", action, request_id: id(0xaff), issued_at: ISSUED, nonce: nonceOf(0xaff), body }, keys[sender].privateKey);
    return "sealed";
  } catch (error) {
    return error instanceof SealError ? error.reason : String(error);
  }
};

// ---- R3: 해석기가 공통 ID를 반환하지 않아도 서명된 값이 남는다 ----

const OTHER_JOB = id(0xbbb);
const SLIM: Bundle = {
  name: "slim",
  actions: {
    // 본문 전체를 엄격히 검사하고 업무 값만 돌려준다(job_id를 빼고, 일부러 다른 ID를 섞는다).
    slim_effect: {
      class: "effect",
      from: ["front-door"],
      duringClosedIntake: false,
      duringPolicyMismatch: false,
      // 두 세대 모두 not_applicable은 닫힌 목록의 넷만 선언할 수 있어 정지 세대를 싣는다(KNOWN_GENERATIONS의 7).
      generations: { stop: "current", execution: "not_applicable" },
      parse: (body) => ({ noteDigest: effectBody({ note_digest: sha256, stop_generation: generation })(body, "body").note_digest, job_id: OTHER_JOB }),
      parseResult: object({ done: literal(true) }),
    },
    // 답 동작인데 해석기가 in_reply_to를 보지도 돌려주지도 않는다.
    slim_ack: {
      class: "query",
      from: ["supervisor"],
      duringClosedIntake: true,
      duringPolicyMismatch: true,
      parse: () => ({}),
      answers: (awaitedAction) => awaitedAction === "slim_effect",
    },
  },
};
const SLIM_CONTRACT = defineContract([COMMON_BUNDLE, SLIM]);

test("작업 ID: 해석기가 job_id를 빼거나 바꿔도 Verified.job은 서명된 원본의 job_id다", async () => {
  const job = id(0xb01);
  const message = send("front-door", "slim_effect", { job_id: job, note_digest: "d".repeat(64), stop_generation: 7 });
  const got = await at(SLIM_CONTRACT, message, "supervisor");
  expect(got.ok).toBe(true);
  if (!got.ok) return;
  expect(got.body).toEqual({ noteDigest: "d".repeat(64), job_id: OTHER_JOB });
  expect(got.job).toEqual({ job_id: job, action: "slim_effect", request_digest: message.header.body_digest });
});

test("답 대상: in_reply_to는 원본에서 소문자 UUID로 검사하고 그 값으로 기다리는 요청을 찾는다", async () => {
  const request = id(0xb10);
  const awaiting = { [request]: { action: "slim_effect", job: null } };
  expect((await at(SLIM_CONTRACT, send("supervisor", "slim_ack", { in_reply_to: request }), "front-door", { awaiting })).ok).toBe(true);
  expect(await at(SLIM_CONTRACT, send("supervisor", "slim_ack", { in_reply_to: id(0xb11) }), "front-door", { awaiting })).toEqual({ ok: false, reason: "reply_mismatch" });
  // 해석기는 아무것도 보지 않지만 공통부가 꼴을 거절한다.
  for (const bad of ["x", request.toUpperCase(), 7]) {
    expect(await at(SLIM_CONTRACT, send("supervisor", "slim_ack", { in_reply_to: bad }), "front-door", { awaiting }), String(bad)).toEqual({ ok: false, reason: "body_malformed" });
    expect(sealReason(SLIM_CONTRACT, "supervisor", "slim_ack", { in_reply_to: bad }), String(bad)).toBe("body_malformed");
  }
  expect(sealReason(SLIM_CONTRACT, "supervisor", "slim_ack", { in_reply_to: request })).toBe("sealed");
});

// ---- R2: 조회가 가리키는 효과의 방향 ----

// probe_effect는 현관만, probe_return은 감독만 낸다.
const ORIGIN: Record<string, Party> = { probe_effect: "front-door", probe_return: "supervisor" };

test("조회 방향: job_lookup은 묻는 쪽이 낼 수 있는 효과만 가리킨다", async () => {
  expect(PROBE_BUNDLE.actions.probe_effect!.from).toEqual(["front-door"]);
  expect(PROBE_BUNDLE.actions.probe_return!.from).toEqual(["supervisor"]);
  for (const [action, origin] of Object.entries(ORIGIN)) {
    const effect = send(origin, action, probeBody(action, id(0xc01)));
    const job = { job_id: id(0xc01), action, request_digest: effect.header.body_digest };
    for (const asker of ["front-door", "supervisor"] as const) {
      const lookup = send(asker, "job_lookup", job);
      const got = await at(PROBE, lookup, asker === "supervisor" ? "front-door" : "supervisor");
      const legal = asker === origin;
      expect(got.ok ? "ok" : got.reason, `${asker}가 ${action}을 물음`).toBe(legal ? "ok" : "body_malformed");
      expect(sealReason(PROBE, asker, "job_lookup", job), `${asker}가 ${action}을 물음(만들기)`).toBe(legal ? "sealed" : "body_malformed");
    }
  }
});

test("조회 방향: job_status는 답을 받는 쪽이 낼 수 있는 효과만 가리킨다", async () => {
  for (const [action, origin] of Object.entries(ORIGIN)) {
    const effect = send(origin, action, probeBody(action, id(0xc02)));
    const job = { job_id: id(0xc02), action, request_digest: effect.header.body_digest };
    for (const answerer of ["front-door", "supervisor"] as const) {
      const recipient: Party = answerer === "supervisor" ? "front-door" : "supervisor";
      // 받는 쪽은 그 효과 요청을 보내고 답을 기다린다(바로 답).
      const awaiting = { [effect.header.request_id]: { action, job } };
      const body = { in_reply_to: effect.header.request_id, ...job, status: { state: "pending" } };
      const got = await at(PROBE, send(answerer, "job_status", body), recipient, { awaiting });
      const legal = recipient === origin;
      expect(got.ok ? "ok" : got.reason, `${answerer}가 ${action}의 결과를 ${recipient}에게`).toBe(legal ? "ok" : "body_malformed");
      expect(sealReason(PROBE, answerer, "job_status", body)).toBe(legal ? "sealed" : "body_malformed");
    }
  }
});
