// 입력 묶음(inputs.ts·events.ts)이 주장하는 보장: 현관 접수 벡터 재생, 원문 없는 참조만 허용, 감독이 낸 승인 변화 거절,
// 이벤트 종류 밖 거절.
import { expect, test } from "bun:test";
import { type Envelope, SealError } from "../../../src/contract/v2/contract.ts";
import type { GenerationAuthorities } from "../../../src/contract/v2/generations.ts";
import {
  EFFECTS_WITHOUT_GENERATIONS,
  EVENT_ACTIONS,
  EVENT_BUNDLE,
  FRONTDOOR_CONTRACT,
  INPUT_BUNDLE,
  INPUT_SOURCES,
  type RejectReason,
  SOURCE_REF,
  SUPERVISOR_FORBIDDEN_FIELD_NAMES,
} from "../../../src/contract/v2/index.ts";
import { REF as LEDGER_REF, SOURCE_REF as LEDGER_SOURCE_REF, sourceRef as ledgerSourceRef } from "../../../src/ledger/input.ts";
import { list, readText } from "../../files.ts";
import { FIXTURE_DIR } from "./cases.ts";
import { buildInputCases, INPUT_JOB, MERGED_AT, SOURCE_REF_EXAMPLE, SUPERVISOR_GENERATIONS } from "./cases-inputs.ts";
import { baseContext, type CaseContext, contextOf, envelope, freshKeys, id, ISSUED, nonceOf, trustedRaw, UNKNOWN_GENERATIONS } from "./support.ts";

const keys = freshKeys();
type Receiver = "supervisor" | "front-door";

// 받는 쪽 기본: 인사가 끝났고 접수가 열렸으며 감독은 정지 세대 7·실행 세대 3을 안다.
function at(message: unknown, receiver: Receiver, over: Partial<CaseContext> = {}) {
  return FRONTDOOR_CONTRACT.verify(
    message,
    contextOf(trustedRaw(keys, receiver), baseContext(receiver, { handshake: "agreed", intake_open: true, generations: SUPERVISOR_GENERATIONS, ...over })),
  );
}

let n = 0xb00;
const fromFront = (action: string, body: unknown, signer?: "supervisor") =>
  envelope(keys, { sender: "front-door", recipient: "supervisor", action, request_id: id(++n), nonce: nonceOf(n) }, body, signer);
const fromSupervisor = (action: string, body: unknown) => envelope(keys, { sender: "supervisor", recipient: "front-door", action, request_id: id(++n), nonce: nonceOf(n) }, body);
const jobOf = (message: Envelope) => ({ job_id: (message.body as { job_id: string }).job_id, action: message.header.action, request_digest: message.header.body_digest });
const confirmed = (request: Envelope, inReplyTo: string, result: unknown) =>
  fromSupervisor("job_status", { in_reply_to: inReplyTo, ...jobOf(request), status: { state: "confirmed", result } });
const awaitingOf = (request: Envelope, action = request.header.action) => ({ [request.header.request_id]: { action, job: jobOf(request) } });

const sealReason = (sender: Receiver, action: string, body: unknown) => {
  try {
    FRONTDOOR_CONTRACT.seal(
      { sender, recipient: sender === "supervisor" ? "front-door" : "supervisor", action, request_id: id(0xbff), issued_at: ISSUED, nonce: nonceOf(0xbff), body },
      keys[sender].privateKey,
    );
    return "sealed";
  } catch (error) {
    return error instanceof SealError ? error.reason : String(error);
  }
};

const inputBody = (over: Record<string, unknown> = {}) => ({ job_id: INPUT_JOB, stop_generation: 7, source: "admin", source_ref: SOURCE_REF_EXAMPLE, ...over });
const CARD = id(0xc01);
const PUBLICATION = id(0xc02);
const DIGEST = "d".repeat(64);
// 이벤트마다 통과하는 본문. 승인 변화만 정지 세대를 싣는다.
const EVENT_BODIES: Record<(typeof EVENT_ACTIONS)[number], Record<string, unknown>> = {
  approval_changed: { job_id: id(0xc10), stop_generation: 7, card_job_id: CARD, candidate_digest: DIGEST, seq: 1, state: "approved" },
  publication_changed: { job_id: id(0xc11), publication_job_id: PUBLICATION, candidate_digest: DIGEST, seq: 1, state: "posted" },
  merge_observed: { job_id: id(0xc12), publication_job_id: PUBLICATION, merge_commit: "e".repeat(40), merged_at: MERGED_AT },
  source_forgotten: { job_id: id(0xc13), source_ref: SOURCE_REF_EXAMPLE.ref },
};

test("현관 접수 벡터 재생", async () => {
  // 표본 파일의 입력 묶음 사례가 그대로 재생된다(현관이 같은 파일을 독립 재생한다).
  const cases = buildInputCases(keys);
  const files = new Set(await list(`${FIXTURE_DIR}/**/*.json`));
  for (const action of Object.keys({ ...INPUT_BUNDLE.actions, ...EVENT_BUNDLE.actions })) {
    expect(cases.some((c) => c.expect.ok && c.message.header.action === action), action).toBe(true);
  }
  for (const { name } of cases) {
    const file = `${FIXTURE_DIR}/${name}.json`;
    expect(files.has(file), file).toBe(true);
    const f = JSON.parse(await readText(file)) as { keys: Record<string, string>; context: CaseContext; message: Envelope; expect: { ok: boolean; reason?: string } };
    const got = await FRONTDOOR_CONTRACT.verify(f.message, contextOf(f.keys, f.context));
    expect(got.ok ? { ok: true } : got, name).toEqual(f.expect.ok ? { ok: true } : f.expect);
  }

  // 입력의 칸은 장부 enqueueInput이 받는 꼴로 그대로 옮겨진다(장부가 같은 값을 받아들인다).
  expect(SOURCE_REF.source).toBe(LEDGER_SOURCE_REF.source);
  for (const source of INPUT_SOURCES) expect(LEDGER_REF.test(source), source).toBe(true);
  expect(ledgerSourceRef({ ref: SOURCE_REF_EXAMPLE.ref, expiresAt: SOURCE_REF_EXAMPLE.expires_at }, "sourceRef")).toEqual({
    ref: SOURCE_REF_EXAMPLE.ref,
    expiresAt: SOURCE_REF_EXAMPLE.expires_at,
  });

  // 접수: 작업은 (현관, job_id)이고 요청 식별자 = job_id, request_digest = 그 본문의 digest.
  const first = fromFront("input_submit", inputBody());
  const got = await at(first, "supervisor");
  expect(got.ok && got.job).toEqual({ job_id: INPUT_JOB, action: "input_submit", request_digest: first.header.body_digest });
  expect(got.ok && got.body).toEqual(inputBody());
  // 같은 입력의 재전달(같은 본문, 새 봉투)은 같은 작업이다. 처리기가 작업 ID로 한 번만 적는다.
  const again = await at(fromFront("input_submit", inputBody()), "supervisor");
  expect(again.ok && again.job).toEqual(got.ok ? got.job : null);
  // 같은 ID에 다른 본문(출처, 참조, digest, 만료)은 받아들여지지만 request_digest가 달라 충돌이 보인다. 가르는 것은 장부다.
  const others = [
    inputBody({ source: "alert" }),
    inputBody({ source_ref: { ...SOURCE_REF_EXAMPLE, ref: `originals/${id(0xc20)}` } }),
    inputBody({ source_ref: { ...SOURCE_REF_EXAMPLE, digest: "f".repeat(64) } }),
    inputBody({ source_ref: { ...SOURCE_REF_EXAMPLE, expires_at: SOURCE_REF_EXAMPLE.expires_at - 1 } }),
  ];
  for (const body of others) {
    const other = await at(fromFront("input_submit", body), "supervisor");
    expect(other.ok && other.job?.job_id, JSON.stringify(body)).toBe(INPUT_JOB);
    expect(other.ok && other.job?.request_digest, JSON.stringify(body)).not.toBe(first.header.body_digest);
  }
  // 답은 그 본문의 작업에만 붙는다: 다른 본문의 digest를 실은 답은 reply_mismatch.
  expect((await at(confirmed(first, first.header.request_id, { outcome: "queued" }), "front-door", { awaiting: awaitingOf(first) })).ok).toBe(true);
  const conflicting = fromFront("input_submit", others[0]);
  expect(await at(confirmed(conflicting, first.header.request_id, { outcome: "queued" }), "front-door", { awaiting: awaitingOf(first) })).toEqual({
    ok: false,
    reason: "reply_mismatch",
  });
  expect(await at(confirmed(first, first.header.request_id, { outcome: "accepted" }), "front-door", { awaiting: awaitingOf(first) })).toEqual({ ok: false, reason: "body_malformed" });

  // 입력은 새 일: 닫힌 접수, 옛 세대, 모르는 세대, 정책 불일치에서 받지 않는다. 세대가 바뀐 뒤에는 조회로 확인한다.
  expect(await at(first, "supervisor", { intake_open: false })).toEqual({ ok: false, reason: "intake_closed" });
  expect(await at(first, "supervisor", { generations: { ...SUPERVISOR_GENERATIONS, stop: { known: true, current: 8, prepared: null } } })).toEqual({
    ok: false,
    reason: "generation_mismatch",
  });
  expect(await at(first, "supervisor", { generations: UNKNOWN_GENERATIONS })).toEqual({ ok: false, reason: "generation_unknown" });
  expect(await at(first, "supervisor", { handshake: "policy_mismatch" })).toEqual({ ok: false, reason: "policy_mismatch" });
  const { stop_generation: _stop, ...withoutGeneration } = inputBody();
  expect(await at(fromFront("input_submit", withoutGeneration), "supervisor")).toEqual({ ok: false, reason: "generation_missing" });
  const lookup = fromFront("job_lookup", jobOf(first));
  expect((await at(lookup, "supervisor", { generations: { ...SUPERVISOR_GENERATIONS, stop: { known: true, current: 8, prepared: null } }, handshake: "policy_mismatch" })).ok).toBe(true);
  // 실행 세대는 입력과 무관하다: 칸을 실으면 body_malformed.
  expect(await at(fromFront("input_submit", inputBody({ execution_generation: 3 })), "supervisor")).toEqual({ ok: false, reason: "body_malformed" });

  // 취소: 앞 입력의 job_id를 가리킨다. 정지 중(접수 닫힘)·세대 모름에서도 받고, 결과는 cancelled 또는 not_found뿐이다.
  const cancel = fromFront("input_cancel", { job_id: id(0xc30), input_job_id: INPUT_JOB });
  for (const over of [{}, { intake_open: false }, { intake_open: false, generations: UNKNOWN_GENERATIONS }]) {
    const c = await at(cancel, "supervisor", over);
    expect(c.ok && c.body, JSON.stringify(over)).toEqual({ job_id: id(0xc30), input_job_id: INPUT_JOB });
  }
  expect(await at(cancel, "supervisor", { handshake: "policy_mismatch" })).toEqual({ ok: false, reason: "policy_mismatch" });
  expect(await at(fromFront("input_cancel", { job_id: id(0xc31), input_job_id: "input-1" }), "supervisor")).toEqual({ ok: false, reason: "body_malformed" });
  for (const result of [{ outcome: "cancelled" }, { outcome: "not_found" }]) {
    expect((await at(confirmed(cancel, cancel.header.request_id, result), "front-door", { awaiting: awaitingOf(cancel) })).ok, result.outcome).toBe(true);
  }
  expect(await at(confirmed(cancel, cancel.header.request_id, { outcome: "stopped" }), "front-door", { awaiting: awaitingOf(cancel) })).toEqual({ ok: false, reason: "body_malformed" });

  // 이벤트 넷: 정지 중에도 받는다. 승인 변화만 지금 정지 세대를 요구한다.
  for (const action of EVENT_ACTIONS) {
    const msg = fromFront(action, EVENT_BODIES[action]);
    const closed = await at(msg, "supervisor", { intake_open: false });
    expect(closed.ok && closed.job, action).toEqual({ job_id: EVENT_BODIES[action].job_id as string, action, request_digest: msg.header.body_digest });
    const unknown = await at(msg, "supervisor", { intake_open: false, generations: UNKNOWN_GENERATIONS });
    expect(unknown.ok ? "ok" : unknown.reason, action).toBe(action === "approval_changed" ? "generation_unknown" : "ok");
    expect((await at(confirmed(msg, msg.header.request_id, { outcome: "recorded" }), "front-door", { awaiting: awaitingOf(msg) })).ok, action).toBe(true);
    expect(await at(confirmed(msg, msg.header.request_id, { outcome: "refused" }), "front-door", { awaiting: awaitingOf(msg) }), action).toEqual({ ok: false, reason: "body_malformed" });
  }
});

test("원문 없는 참조만 허용", async () => {
  expect((await at(fromFront("input_submit", inputBody()), "supervisor")).ok).toBe(true);
  const TEXT = "배포가 왜 죽었는지 봐 줘";
  const ref = (over: Record<string, unknown>) => inputBody({ source_ref: { ...SOURCE_REF_EXAMPLE, ...over } });
  const cases: [string, Record<string, unknown>, RejectReason][] = [
    // 참조 자리에 글·URL·다른 꼴: 저장소가 발행한 `<저장소>/<UUID>`만 받는다.
    ["글을 참조로", ref({ ref: TEXT }), "body_malformed"],
    ["참조 꼴 뒤에 글", ref({ ref: `${SOURCE_REF_EXAMPLE.ref} ${TEXT}` }), "body_malformed"],
    ["Discord 링크", ref({ ref: "https://discord.com/channels/1/2/3" }), "body_malformed"],
    ["대문자 UUID", ref({ ref: `originals/${id(0x7e).toUpperCase()}` }), "body_malformed"],
    ["digest 자리에 글", ref({ digest: TEXT }), "body_malformed"],
    ["참조 객체 대신 글", inputBody({ source_ref: TEXT }), "body_malformed"],
    // 칸이 빠짐.
    ["digest 없음", inputBody({ source_ref: { ref: SOURCE_REF_EXAMPLE.ref, expires_at: SOURCE_REF_EXAMPLE.expires_at } }), "body_malformed"],
    ["만료 없음", inputBody({ source_ref: { ref: SOURCE_REF_EXAMPLE.ref, digest: SOURCE_REF_EXAMPLE.digest } }), "body_malformed"],
    ["참조 없음", inputBody({ source_ref: undefined }), "body_malformed"],
    // 원문을 싣는 칸: 흔한 원문 이름은 어느 깊이에서든 forbidden_field, 그 밖의 칸은 닫힌 객체라 unknown_field.
    ["맨 위 raw_message", inputBody({ raw_message: TEXT }), "forbidden_field"],
    ["참조 안 messageContent", ref({ messageContent: TEXT }), "forbidden_field"],
    ["맨 위 original-text", inputBody({ "original-text": TEXT }), "forbidden_field"],
    ["맨 위 text", inputBody({ text: TEXT }), "unknown_field"],
    ["참조 안 content", ref({ content: TEXT }), "unknown_field"],
    ["맨 위 message", inputBody({ message: { content: TEXT } }), "unknown_field"],
  ];
  for (const [what, body, reason] of cases) {
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    expect(await at(fromFront("input_submit", clean), "supervisor"), what).toEqual({ ok: false, reason });
    // 만들기도 같은 이유로 서명하지 않는다.
    expect(sealReason("front-door", "input_submit", clean), what).toBe(reason);
  }

  // 잊기도 참조 하나만 가리킨다.
  const forget = (over: Record<string, unknown>) => ({ ...EVENT_BODIES.source_forgotten, ...over });
  expect((await at(fromFront("source_forgotten", forget({})), "supervisor")).ok).toBe(true);
  for (const [what, body, reason] of [
    ["글을 참조로", forget({ source_ref: TEXT }), "body_malformed"],
    ["참조 객체", forget({ source_ref: SOURCE_REF_EXAMPLE }), "body_malformed"],
    ["raw_text", forget({ raw_text: TEXT }), "forbidden_field"],
    ["text", forget({ text: TEXT }), "unknown_field"],
  ] as const) {
    expect(await at(fromFront("source_forgotten", body), "supervisor"), what).toEqual({ ok: false, reason });
  }

  // 현관이 내는 여섯 동작의 본문 어디에도 글을 받는 칸이 없다: 모든 문자열 잎은 정해진 꼴(UUID, digest, 참조, 닫힌 목록, 커밋)이다.
  // 통과 본문의 문자열 잎을 하나씩 글로 바꾸면 모두 거절된다.
  const accepted = [inputBody(), { job_id: id(0xc32), input_job_id: INPUT_JOB }, ...Object.values(EVENT_BODIES)];
  const actions = ["input_submit", "input_cancel", ...EVENT_ACTIONS];
  const leaves = (value: unknown, path: string[] = []): string[][] =>
    typeof value === "string" ? [path] : value !== null && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k])) : [];
  for (const [i, body] of accepted.entries()) {
    expect((await at(fromFront(actions[i]!, body), "supervisor")).ok, actions[i]).toBe(true);
    for (const path of leaves(body)) {
      const changed = structuredClone(body) as Record<string, unknown>;
      let cursor = changed;
      for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
      cursor[path.at(-1)!] = TEXT;
      const got = await at(fromFront(actions[i]!, changed), "supervisor");
      expect(got.ok, `${actions[i]} ${path.join(".")}`).toBe(false);
    }
  }
});

test("감독이 낸 승인 변화 거절", async () => {
  const body = EVENT_BODIES.approval_changed;
  // 현관이 낸 승인 변화는 받는다.
  expect((await at(fromFront("approval_changed", body), "supervisor")).ok).toBe(true);
  // 감독 이름·감독 키로 서명해 현관에 보낸 승인 변화: 그 동작은 현관만 낸다.
  const bySupervisor = fromSupervisor("approval_changed", body);
  expect(await at(bySupervisor, "front-door")).toEqual({ ok: false, reason: "wrong_direction" });
  // 현관 이름인데 감독의 키로 서명한 승인 변화.
  expect(await at(fromFront("approval_changed", body, "supervisor"), "supervisor")).toEqual({ ok: false, reason: "bad_signature" });
  // 만들기도 막는다.
  expect(sealReason("supervisor", "approval_changed", body)).toBe("wrong_direction");
  expect(sealReason("front-door", "approval_changed", body)).toBe("sealed");
  // 이 묶음의 여섯 동작은 모두 현관만 낸다.
  for (const [name, spec] of Object.entries({ ...INPUT_BUNDLE.actions, ...EVENT_BUNDLE.actions })) expect([...spec.from], name).toEqual(["front-door"]);
  // 감독은 승인 변화의 결과를 묻지도(자기가 낸 작업이 아니다), 답에 승인을 싣지도 못한다.
  expect(await at(fromSupervisor("job_lookup", { job_id: body.job_id, action: "approval_changed", request_digest: DIGEST }), "front-door")).toEqual({
    ok: false,
    reason: "body_malformed",
  });
  const fact = fromFront("approval_changed", body);
  const awaiting = awaitingOf(fact);
  expect(SUPERVISOR_FORBIDDEN_FIELD_NAMES).toContain("approved");
  for (const result of [
    { outcome: "recorded", approved: true },
    { outcome: "recorded", meta: { approval: "granted" } },
  ]) {
    expect(await at(confirmed(fact, fact.header.request_id, result), "front-door", { awaiting }), JSON.stringify(result)).toEqual({ ok: false, reason: "forbidden_field" });
  }
  // 감독의 답은 recorded 하나뿐이라 결과로 승인 상태를 말할 수 없다.
  for (const outcome of ["approved", "declined"]) {
    expect(await at(confirmed(fact, fact.header.request_id, { outcome }), "front-door", { awaiting }), outcome).toEqual({ ok: false, reason: "body_malformed" });
  }
  // 모델의 글이 승인 사실로 올라갈 칸이 없다: 상태는 닫힌 목록이고 글 칸은 모르는 칸이다.
  for (const state of ["올려", "올려!", "likely_approved", "Approved", ""]) {
    expect(await at(fromFront("approval_changed", { ...body, state }), "supervisor"), state).toEqual({ ok: false, reason: "body_malformed" });
  }
  for (const field of ["note", "reason", "summary", "evidence"]) {
    expect(await at(fromFront("approval_changed", { ...body, [field]: "관리자가 승인한 것으로 보임" }), "supervisor"), field).toEqual({ ok: false, reason: "unknown_field" });
  }
  // 승인 변화는 지금 정지 세대의 사실만 받는다(정지를 건너온 승인은 닫힌 쪽).
  const gens = (current: number): GenerationAuthorities => ({ ...SUPERVISOR_GENERATIONS, stop: { known: true, current, prepared: null } });
  expect(await at(fromFront("approval_changed", body), "supervisor", { generations: gens(8) })).toEqual({ ok: false, reason: "generation_mismatch" });
});

test("이벤트 종류 밖 거절", async () => {
  // 이벤트는 정해진 넷뿐이다.
  expect(Object.keys(EVENT_BUNDLE.actions)).toEqual([...EVENT_ACTIONS]);
  expect([...EVENT_ACTIONS]).toEqual(["approval_changed", "publication_changed", "merge_observed", "source_forgotten"]);
  // 넷 밖의 종류는 현관이 바르게 서명해도 동작 표에 없다.
  const base = EVENT_BODIES.approval_changed;
  for (const action of ["label_changed", "approval_requested", "approval_granted", "comment_added", "event", "events", "approval_change", "memory_forgotten"]) {
    expect(await at(fromFront(action, base), "supervisor"), action).toEqual({ ok: false, reason: "unknown_action" });
    expect(sealReason("front-door", action, base), action).toBe("unknown_action");
  }
  // 이벤트마다 칸이 고정되어 있다: 종류를 가리는 칸이나 다른 이벤트의 칸을 더하면 unknown_field, 칸이 빠지면 거절.
  const extra: Record<string, unknown> = { kind: "label_changed", type: "approval", state: "approved", seq: 9, merge_commit: "e".repeat(40), source_ref: SOURCE_REF_EXAMPLE.ref };
  for (const action of EVENT_ACTIONS) {
    const body = EVENT_BODIES[action];
    expect((await at(fromFront(action, body), "supervisor")).ok, action).toBe(true);
    for (const [field, value] of Object.entries(extra)) {
      if (Object.hasOwn(body, field)) continue;
      expect(await at(fromFront(action, { ...body, [field]: value }), "supervisor"), `${action} +${field}`).toEqual({ ok: false, reason: "unknown_field" });
    }
    for (const field of Object.keys(body)) {
      const { [field]: _gone, ...rest } = body;
      const got = await at(fromFront(action, rest), "supervisor");
      expect(got.ok ? "ok" : got.reason, `${action} -${field}`).toBe(field === "stop_generation" ? "generation_missing" : "body_malformed");
    }
  }
  // 다른 이벤트의 상태 값은 그 이벤트의 목록 밖이다.
  expect(await at(fromFront("publication_changed", { ...EVENT_BODIES.publication_changed, state: "approved" }), "supervisor")).toEqual({ ok: false, reason: "body_malformed" });
  expect(await at(fromFront("approval_changed", { ...base, state: "posted" }), "supervisor")).toEqual({ ok: false, reason: "body_malformed" });
  // 순번은 1 이상의 정수다(소수는 정규화가 먼저 거절해 봉투를 만들 수 없으므로 여기 두지 않는다).
  for (const seq of [0, -1, "1", null]) {
    expect(await at(fromFront("publication_changed", { ...EVENT_BODIES.publication_changed, seq }), "supervisor"), String(seq)).toEqual({ ok: false, reason: "body_malformed" });
  }
  // 병합 시각은 1 이상의 밀리초 정수다. 재전달(같은 본문, 새 봉투)은 같은 병합 시각과 같은 request_digest를 준다.
  for (const merged_at of [0, -1, "2026-11-19", null]) {
    expect(await at(fromFront("merge_observed", { ...EVENT_BODIES.merge_observed, merged_at }), "supervisor"), String(merged_at)).toEqual({ ok: false, reason: "body_malformed" });
  }
  const merge = await at(fromFront("merge_observed", EVENT_BODIES.merge_observed), "supervisor");
  const mergeAgain = await at(fromFront("merge_observed", EVENT_BODIES.merge_observed), "supervisor");
  expect(merge.ok && (merge.body as { merged_at: number }).merged_at).toBe(MERGED_AT);
  expect(mergeAgain.ok && mergeAgain.job).toEqual(merge.ok ? merge.job : null);
});

test("세대 없는 효과는 닫힌 목록의 넷뿐이고, 넷은 감독이 두 세대를 모두 몰라도 받는다", async () => {
  expect(EFFECTS_WITHOUT_GENERATIONS).toEqual(["input_cancel", "publication_changed", "merge_observed", "source_forgotten"]);
  expect(Object.isFrozen(EFFECTS_WITHOUT_GENERATIONS)).toBe(true);
  // 표에서 두 세대가 모두 not_applicable인 효과는 정확히 이 넷이다.
  const without = Object.entries(FRONTDOOR_CONTRACT.actions)
    .filter(([, spec]) => spec.class === "effect" && spec.generations.stop === "not_applicable" && spec.generations.execution === "not_applicable")
    .map(([name]) => name);
  expect(without).toEqual([...EFFECTS_WITHOUT_GENERATIONS]);
  const bodies: Record<string, Record<string, unknown>> = {
    input_cancel: { job_id: id(0xc20), input_job_id: INPUT_JOB },
    publication_changed: EVENT_BODIES.publication_changed,
    merge_observed: EVENT_BODIES.merge_observed,
    source_forgotten: EVENT_BODIES.source_forgotten,
  };
  for (const name of EFFECTS_WITHOUT_GENERATIONS) {
    expect((await at(fromFront(name, bodies[name]), "supervisor", { intake_open: false, generations: UNKNOWN_GENERATIONS })).ok, name).toBe(true);
  }
});
