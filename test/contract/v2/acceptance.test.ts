// F2(현관 계약의 공통부)가 주장하는 보장 넷. 효과 동작에 걸리는 규칙은 시험 전용 probe 묶음으로 본다(support.ts).
import { expect, test } from "bun:test";
import { rawPublicKey } from "../../../src/contract/v1/index.ts";
import { signUnchecked as signV1, verifyEnvelope as verifyV1 } from "../../../src/contract/v1/envelope.ts";
import { ACTIONS as V1_ACTIONS } from "../../../src/contract/v1/header.ts";
import { type HandshakeState, isSettled, type JobStatus, type LookupOutcome } from "../../../src/contract/v2/actions.ts";
import { afterHandshake, type Contract, type Envelope, signUnchecked } from "../../../src/contract/v2/contract.ts";
import { FRONTDOOR_CONTRACT } from "../../../src/contract/v2/index.ts";
import { list, readText } from "../../files.ts";
import { buildCases as buildV1Cases, freshKeys as freshV1Keys } from "../cases.ts";
import { contextOf as v1ContextOf } from "../support.ts";
import { buildCases, FIXTURE_DIR } from "./cases.ts";
import {
  baseContext,
  type CaseContext,
  contextOf,
  envelope,
  freshKeys,
  id,
  type Keys,
  KNOWN_GENERATIONS,
  nonceOf,
  OTHER_POLICY,
  POLICY,
  PROBE,
  probeBody,
  trustedRaw,
} from "./support.ts";

const keys = freshKeys();

// 받는 쪽이 세대를 아는 문맥이 기본이다. 세대를 모를 때의 규칙은 generations.test.ts가 본다.
function verifyAt(contract: Contract, message: unknown, receiver: "supervisor" | "front-door", over: Partial<CaseContext> = {}) {
  return contract.verify(message, contextOf(trustedRaw(keys, receiver), baseContext(receiver, { generations: KNOWN_GENERATIONS, ...over })));
}

const handshakeFrom = (k: Keys, policy: string, n: number, fields: Record<string, unknown> = {}) =>
  envelope(k, { sender: "front-door", recipient: "supervisor", action: "handshake", request_id: id(0x100 + n), nonce: nonceOf(0x100 + n), ...fields }, { policy_revision: policy });

const JOB = id(0x501);
const probeEffect = (n: number, action = "probe_effect") =>
  envelope(keys, { sender: "front-door", recipient: "supervisor", action, request_id: id(0x200 + n), nonce: nonceOf(0x200 + n) }, probeBody(action, JOB));

test("실행기 v1 표본 그대로", async () => {
  // v1 표본 파일은 v1 사례 정의와 이름이 같다(v1의 fixtures.test.ts가 내용과 서명 검증까지 본다). 내용의 해시를 main과 대조하는 일은
  // git을 띄워야 해서 시험에 두지 않고, 끝 실행의 `git diff --stat HEAD -- contracts/fixtures/v1`로 본다.
  const v1Files = await list("contracts/fixtures/v1/**/*.json");
  const v1Names = buildV1Cases(freshV1Keys()).map((c) => c.name).sort();
  expect(v1Files.map((f) => f.replace(/^contracts\/fixtures\/v1\//, "").replace(/\.json$/, "")).sort()).toEqual(v1Names);

  // v2 생성기는 v2 표본 폴더에만 쓴다: 쓰는 자리는 FIXTURE_DIR 하나이고, 사례 이름은 그 아래 두 폴더 밖으로 나가지 못한다.
  const generator = await readText("test/contract/v2/generate-fixtures.ts");
  expect(generator).not.toMatch(/fixtures\/v1|generate-fixtures\.ts"|\.\.\/cases\.ts/);
  expect(generator).toContain("join(root, FIXTURE_DIR)");
  expect(FIXTURE_DIR).toBe("contracts/fixtures/v2/frontdoor");
  for (const c of buildCases(keys)) expect(c.name).toMatch(/^(accept|reject)\/[a-z0-9-]+$/);

  // v2 검증기는 v1 봉투(실제 v1 표본 전부)를 거절한다. v1의 통과 사례는 판에서(contract_mismatch) 거절한다.
  // v1 거절 사례 가운데 판을 v2로 바꾼 것(reject/contract-v2)은 v2에 그 동작이 없어 unknown_action이다.
  expect(v1Files.length).toBeGreaterThan(0);
  for (const file of v1Files) {
    const fixture = JSON.parse(await readText(file)) as { message: unknown; context: { expected_recipient: string } };
    const receiver = fixture.context.expected_recipient === "supervisor" ? "supervisor" : "front-door";
    const got = await verifyAt(FRONTDOOR_CONTRACT, fixture.message, receiver, { handshake: "agreed", intake_open: true });
    expect(got.ok, file).toBe(false);
    if (file.includes("/accept/")) expect(got, file).toEqual({ ok: false, reason: "contract_mismatch" });
  }

  // v1 검증기는 v2 봉투를 판에서 거절한다(v1 검증기가 현관의 키를 믿는 최악의 경우에도).
  const v1Keys = freshV1Keys();
  const v1Raw = Object.fromEntries(Object.entries(v1Keys).map(([name, pair]) => [name, rawPublicKey(pair.publicKey)]));
  const v1Base = buildV1Cases(v1Keys).find((c) => c.name === "accept/hello")!;
  const trustingFrontDoor = { ...v1Raw, "front-door": rawPublicKey(keys["front-door"].publicKey), supervisor: rawPublicKey(keys.supervisor.publicKey) };
  for (const c of buildCases(keys).filter((x) => x.expect.ok)) {
    const ctx = v1ContextOf(trustingFrontDoor, { ...v1Base.context, expected_recipient: c.message.header.recipient });
    expect(await verifyV1(c.message, ctx), c.name).toEqual({ ok: false, reason: "contract_mismatch" });
  }
});

test("틀린 판·정책은 새 효과 0", async () => {
  // 인사 없는 연결: 효과도 조회도 받지 않는다.
  expect(await verifyAt(PROBE, probeEffect(1), "supervisor", { intake_open: true })).toEqual({ ok: false, reason: "handshake_required" });

  // 판이 다른 인사는 봉투째 거절되어 상태가 none에 머문다. 그 뒤의 효과는 handshake_required다.
  let state: HandshakeState = "none";
  for (const contract of ["olive-control/v1", "olive-control/v3"]) {
    const hello = await verifyAt(PROBE, handshakeFrom(keys, POLICY, contract.length, { contract }), "supervisor");
    expect(hello).toEqual({ ok: false, reason: "contract_mismatch" });
    if (hello.ok) state = afterHandshake(hello, POLICY);
  }
  expect(state).toBe("none");
  expect(await verifyAt(PROBE, probeEffect(2), "supervisor", { handshake: state, intake_open: true })).toEqual({ ok: false, reason: "handshake_required" });

  // 정책이 다른 인사: 봉투는 받지만 연결은 policy_mismatch. 효과 동작은 모두 거절, 조회는 된다.
  const mismatch = await verifyAt(PROBE, handshakeFrom(keys, OTHER_POLICY, 3), "supervisor");
  expect(mismatch.ok).toBe(true);
  if (!mismatch.ok) return;
  const mismatched = afterHandshake(mismatch, POLICY);
  expect(mismatched).toBe("policy_mismatch");
  const effects = Object.entries(PROBE.actions).filter(([, spec]) => spec.class === "effect");
  expect(effects.length).toBeGreaterThan(0);
  for (const [action, spec] of effects) {
    const sender = spec.from[0]!;
    const recipient = sender === "supervisor" ? "front-door" : "supervisor";
    const msg = envelope(keys, { sender, recipient, action, request_id: id(0x300), nonce: nonceOf(0x300) }, probeBody(action, JOB));
    for (const handshake of ["none", "policy_mismatch"] as const) {
      const got = await verifyAt(PROBE, msg, recipient, { handshake, intake_open: true });
      expect(got, `${action} ${handshake}`).toEqual({ ok: false, reason: handshake === "none" ? "handshake_required" : "policy_mismatch" });
    }
    expect((await verifyAt(PROBE, msg, recipient, { handshake: "agreed", intake_open: true })).ok, action).toBe(true);
  }
  const lookup = envelope(
    keys,
    { sender: "front-door", recipient: "supervisor", action: "job_lookup", request_id: id(0x301), nonce: nonceOf(0x301) },
    { job_id: JOB, action: "probe_effect", request_digest: probeEffect(1).header.body_digest },
  );
  expect((await verifyAt(PROBE, lookup, "supervisor", { handshake: mismatched })).ok).toBe(true);

  // 공개 면의 효과 동작마다: 그 통과 표본(표본 시험이 동작마다 요구한다)을 인사 없는 연결과 정책이 다른 연결로 옮기면 거절된다.
  const publicCases = buildCases(keys);
  const publicEffects = Object.entries(FRONTDOOR_CONTRACT.actions).filter(([, spec]) => spec.class === "effect");
  expect(publicEffects.length).toBeGreaterThan(0);
  for (const [action] of publicEffects) {
    const base = publicCases.find((c) => c.expect.ok && c.message.header.action === action);
    expect(base, action).toBeDefined();
    if (base === undefined) continue;
    const replay = (handshake: HandshakeState) => FRONTDOOR_CONTRACT.verify(base.message, contextOf(base.keys, { ...base.context, handshake }));
    expect(await replay("none"), action).toEqual({ ok: false, reason: "handshake_required" });
    expect(await replay("policy_mismatch"), action).toEqual({ ok: false, reason: "policy_mismatch" });
    expect((await replay("agreed")).ok, action).toBe(true);
  }

  // 접수가 닫혀도 인사와 조회는 되고, 닫힌 접수에서 받지 않는 효과는 intake_closed다(인사가 끝난 연결에서도).
  expect((await verifyAt(PROBE, handshakeFrom(keys, POLICY, 4), "supervisor", { intake_open: false })).ok).toBe(true);
  expect((await verifyAt(PROBE, lookup, "supervisor", { handshake: "agreed", intake_open: false })).ok).toBe(true);
  expect(await verifyAt(PROBE, probeEffect(5), "supervisor", { handshake: "agreed", intake_open: false })).toEqual({ ok: false, reason: "intake_closed" });
  expect((await verifyAt(PROBE, probeEffect(6, "probe_effect_closed_ok"), "supervisor", { handshake: "agreed", intake_open: false })).ok).toBe(true);
});

test("현관 키로 실행기 지시 거절", async () => {
  const v1Keys = freshV1Keys();
  const v1Raw = Object.fromEntries(Object.entries(v1Keys).map(([name, pair]) => [name, rawPublicKey(pair.publicKey)]));
  const start = buildV1Cases(v1Keys).find((c) => c.name === "accept/task-start")!;
  const v1Ctx = (raw: Record<string, string>) => v1ContextOf(raw, start.context);
  expect((await verifyV1(start.message, v1Ctx(v1Raw))).ok).toBe(true);
  const frontKey = keys["front-door"].privateKey;

  // v1 검증기: 감독 이름에 현관의 키 → bad_signature. 현관 이름에 현관의 키(실행기가 현관 키를 믿어도) → wrong_direction.
  const forged = signV1(start.message.header, start.message.body, frontKey);
  expect(await verifyV1(forged, v1Ctx(v1Raw))).toEqual({ ok: false, reason: "bad_signature" });
  const asFrontDoor = signV1({ ...start.message.header, sender: "front-door" }, start.message.body, frontKey);
  const trusting = { ...v1Raw, "front-door": rawPublicKey(keys["front-door"].publicKey) };
  expect(await verifyV1(asFrontDoor, v1Ctx(trusting))).toEqual({ ok: false, reason: "wrong_direction" });

  // v2 검증기: v1 판 그대로면 contract_mismatch, 판만 v2로 바꿔 현관 키로 서명하면 unknown_action.
  const agreed = { handshake: "agreed" as const, intake_open: true };
  expect(await verifyAt(FRONTDOOR_CONTRACT, asFrontDoor, "supervisor", agreed)).toEqual({ ok: false, reason: "contract_mismatch" });
  const relabeledHeader = { ...start.message.header, sender: "front-door", recipient: "supervisor", contract: "olive-control/v2" } as unknown as typeof start.message.header;
  const relabeled = signV1(relabeledHeader, start.message.body, frontKey);
  expect(await verifyAt(FRONTDOOR_CONTRACT, relabeled, "supervisor", agreed)).toEqual({ ok: false, reason: "unknown_action" });
  // v1의 동작 이름(지시·영수증·보고·전송)은 v2 표에 하나도 없다.
  for (const action of V1_ACTIONS) expect(Object.hasOwn(FRONTDOOR_CONTRACT.actions, action), action).toBe(false);

  // 감독의 키로 "현관만 보낼 수 있는 동작": 감독 이름이면 wrong_direction, 현관 이름이면 bad_signature.
  const fromSupervisor = envelope(keys, { sender: "supervisor", recipient: "front-door", action: "handshake", request_id: id(0x400), nonce: nonceOf(0x400) }, { policy_revision: POLICY });
  expect(await verifyAt(FRONTDOOR_CONTRACT, fromSupervisor, "front-door")).toEqual({ ok: false, reason: "wrong_direction" });
  expect(await verifyAt(FRONTDOOR_CONTRACT, handshakeFrom(keys, POLICY, 5, {}), "supervisor")).toMatchObject({ ok: true });
  const hello = handshakeFrom(keys, POLICY, 6);
  const supervisorSigned = signUnchecked(hello.header, hello.body, keys.supervisor.privateKey);
  expect(await verifyAt(FRONTDOOR_CONTRACT, supervisorSigned, "supervisor")).toEqual({ ok: false, reason: "bad_signature" });
  // 효과 동작도 같다(probe_effect는 현관만 낸다).
  const effectBySupervisor = envelope(keys, { sender: "supervisor", recipient: "front-door", action: "probe_effect", request_id: id(0x401), nonce: nonceOf(0x401) }, probeBody("probe_effect", JOB));
  expect(await verifyAt(PROBE, effectBySupervisor, "front-door", agreed)).toEqual({ ok: false, reason: "wrong_direction" });
  const effect = probeEffect(7);
  expect(await verifyAt(PROBE, signUnchecked(effect.header, effect.body, keys.supervisor.privateKey), "supervisor", agreed)).toEqual({ ok: false, reason: "bad_signature" });
});

test("같은 작업 ID 조회 응답 대조", async () => {
  const effect = probeEffect(10);
  const accepted = await verifyAt(PROBE, effect, "supervisor", { handshake: "agreed", intake_open: true });
  expect(accepted.ok && accepted.job).toEqual({ job_id: JOB, action: "probe_effect", request_digest: effect.header.body_digest });
  const job = { job_id: JOB, action: "probe_effect", request_digest: effect.header.body_digest };

  const lookupId = id(0x600);
  const lookup = envelope(keys, { sender: "front-door", recipient: "supervisor", action: "job_lookup", request_id: lookupId, nonce: nonceOf(0x600) }, job);
  expect((await verifyAt(PROBE, lookup, "supervisor", { handshake: "agreed" })).ok).toBe(true);

  // 현관이 기다리는 것: 처음 낸 효과 요청(바로 답)과 같은 작업의 조회.
  const awaiting = { [effect.header.request_id]: { action: "probe_effect", job }, [lookupId]: { action: "job_lookup", job } };
  let n = 0;
  const status = (status: unknown, over: Record<string, unknown> = {}, inReplyTo = lookupId) =>
    envelope(
      keys,
      { sender: "supervisor", recipient: "front-door", action: "job_status", request_id: id(0x700 + ++n), nonce: nonceOf(0x700 + n) },
      { in_reply_to: inReplyTo, ...job, status, ...over },
    );
  const atFront = (message: Envelope) => verifyAt(PROBE, message, "front-door", { handshake: "agreed", awaiting });

  // 확정·대기·모름은 서로 다른 값으로 받아들여진다(바로 답이든 조회의 답이든).
  const seen: JobStatus[] = [];
  for (const s of [{ state: "confirmed", result: { outcome: "done" } }, { state: "pending" }, { state: "unknown" }]) {
    for (const inReplyTo of [lookupId, effect.header.request_id]) {
      const got = await atFront(status(s, {}, inReplyTo));
      expect(got.ok, JSON.stringify(s)).toBe(true);
      if (got.ok) seen.push((got.body as { status: JobStatus }).status);
    }
  }
  expect(new Set(seen.map((s) => JSON.stringify(s))).size).toBe(3);

  // 작업 ID·요청 digest·동작이 다르거나, 기다리지 않는 요청을 가리키면 reply_mismatch.
  const pending = { state: "pending" };
  expect(await atFront(status(pending, { job_id: id(0x502) }))).toEqual({ ok: false, reason: "reply_mismatch" });
  expect(await atFront(status(pending, { request_digest: "b".repeat(64) }))).toEqual({ ok: false, reason: "reply_mismatch" });
  expect(await atFront(status(pending, { action: "probe_effect_closed_ok" }))).toEqual({ ok: false, reason: "reply_mismatch" });
  expect(await atFront(status(pending, {}, id(0x6ff)))).toEqual({ ok: false, reason: "reply_mismatch" });
  // 확정의 결과는 그 효과 동작이 등록한 꼴이어야 하고, 조회의 action은 효과 동작이어야 한다.
  expect(await atFront(status({ state: "confirmed", result: { outcome: "posted" } }))).toEqual({ ok: false, reason: "body_malformed" });
  expect(await atFront(status({ state: "absent" }))).toEqual({ ok: false, reason: "body_malformed" });
  expect(await atFront(status(pending, { action: "handshake" }))).toEqual({ ok: false, reason: "body_malformed" });

  // 답을 받지 못한 물음은 모름이고, 확정(효과 있음·없음의 결론)이 아니다.
  const timeout: LookupOutcome = { answered: false, cause: "timeout" };
  expect(isSettled(timeout)).toBe(false);
  expect(isSettled({ answered: true, status: { state: "unknown" } })).toBe(false);
  expect(isSettled({ answered: true, status: { state: "pending" } })).toBe(false);
  expect(isSettled({ answered: true, status: { state: "confirmed", result: { outcome: "refused" } } })).toBe(true);
});
