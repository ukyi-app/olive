// 출력 묶음(effects.ts)이 주장하는 보장: 게시 후보 벡터 재생, 모델이 정한 승인·목적지 거절, 임의 진행 문구 거절,
// 모름 조회가 확정 없음과 다름. 현관의 실행 세대 권위 값을 채우는 조회 쌍도 본다.
import { expect, test } from "bun:test";
import { type Envelope, SealError } from "../../../src/contract/v2/contract.ts";
import type { GenerationAuthorities, GenerationAuthority } from "../../../src/contract/v2/generations.ts";
import {
  adoptExecutionGeneration,
  EFFECTS_BUNDLE,
  EFFECTS_FIELD_NAMES,
  FORBIDDEN_FIELD_NAMES,
  FRONTDOOR_CONTRACT,
  type LookupOutcome,
  OUTBOUND_GENERATIONS,
  PROGRESS_STAGES,
  publicationLinkOf,
  publicationLookupOf,
  PublicationUnknown,
  SUPERVISOR_FORBIDDEN_FIELD_NAMES,
} from "../../../src/contract/v2/index.ts";
import { recoveryPorts } from "../../../src/supervisor/frontdoor/recovery.ts";
import { list, readText } from "../../files.ts";
import { FIXTURE_DIR } from "./cases.ts";
import { buildEffectsCases } from "./cases-effects.ts";
import { baseContext, type CaseContext, contextOf, envelope, freshKeys, id, ISSUED, nonceOf, trustedRaw } from "./support.ts";

const keys = freshKeys();
type Receiver = "supervisor" | "front-door";

const known = (current: number, prepared: number | null = null): GenerationAuthority => ({ known: true, current, prepared });
// 현관의 권위 값: 정지 세대 8(현관 원장), 실행 세대 4(마지막 풀기).
const FRONT_GENS: GenerationAuthorities = { stop: known(8), execution: known(4) };

// 받는 쪽: 인사가 끝났고 접수가 열려 있다. 현관은 세대를 안다.
function at(message: unknown, receiver: Receiver, over: Partial<CaseContext> = {}) {
  const base = receiver === "front-door" ? { generations: FRONT_GENS } : {};
  return FRONTDOOR_CONTRACT.verify(message, contextOf(trustedRaw(keys, receiver), baseContext(receiver, { handshake: "agreed", intake_open: true, ...base, ...over })));
}

let n = 0xe00;
const fromFront = (action: string, body: unknown) => envelope(keys, { sender: "front-door", recipient: "supervisor", action, request_id: id(++n), nonce: nonceOf(n) }, body);
const fromSupervisor = (action: string, body: unknown) => envelope(keys, { sender: "supervisor", recipient: "front-door", action, request_id: id(++n), nonce: nonceOf(n) }, body);
const jobOf = (message: Envelope) => ({ job_id: (message.body as { job_id: string }).job_id, action: message.header.action, request_digest: message.header.body_digest });
const status = (request: Envelope, inReplyTo: string, value: unknown) => fromFront("job_status", { in_reply_to: inReplyTo, ...jobOf(request), status: value });
const awaitingOf = (request: Envelope, action = request.header.action) => ({ [request.header.request_id]: { action, job: jobOf(request) } });
// 칸 하나를 뺀 본문(undefined 값은 정규화가 받지 않으므로 칸째 지운다).
const without = (body: Record<string, unknown>, field: string) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== field));

const INPUT = id(0xe7a);
const DIGEST = "d".repeat(64);
const RUN = id(0xe7b);
const GEN = { stop_generation: 8, execution_generation: 4 };
const bodies: Record<string, Record<string, unknown>> = {
  reply_candidate: { job_id: id(0xe01), input_job_id: INPUT, purpose: "answer", candidate_digest: DIGEST, ...GEN },
  approval_card_request: { job_id: id(0xe02), input_job_id: INPUT, candidate_digest: DIGEST, ...GEN },
  publication_candidate: { job_id: id(0xe03), kind: "pull_request", candidate_digest: DIGEST, run_id: RUN, input_job_id: INPUT, ...GEN },
  progress_update: { job_id: id(0xe04), input_job_id: INPUT, stage: "cause", seq: 1, ...GEN },
};

function sealReason(action: string, body: unknown): string {
  try {
    FRONTDOOR_CONTRACT.seal({ sender: "supervisor", recipient: "front-door", action, request_id: id(0xef0), issued_at: ISSUED, nonce: nonceOf(0xef0), body }, keys.supervisor.privateKey);
    return "sealed";
  } catch (error) {
    return error instanceof SealError ? error.reason : String(error);
  }
}

test("게시 후보 벡터 재생", async () => {
  // 표본 파일의 출력 묶음 사례가 그대로 재생된다(현관이 같은 파일을 독립 재생한다).
  const names = buildEffectsCases(keys).map((c) => c.name);
  for (const name of ["accept/publication-candidate", "accept/publication-candidate-posted", "accept/publication-lookup", "accept/publication-lookup-unknown"]) expect(names).toContain(name);
  const files = new Set(await list(`${FIXTURE_DIR}/**/*.json`));
  for (const name of names) {
    const file = `${FIXTURE_DIR}/${name}.json`;
    expect(files.has(file), file).toBe(true);
    const f = JSON.parse(await readText(file)) as { keys: Record<string, string>; context: CaseContext; message: Envelope; expect: { ok: boolean; reason?: string } };
    const got = await FRONTDOOR_CONTRACT.verify(f.message, contextOf(f.keys, f.context));
    expect(got.ok ? { ok: true } : got, name).toEqual(f.expect.ok ? { ok: true } : f.expect);
  }

  // 한 게시의 순서: 감독이 후보를 내고 현관이 받는다. 작업은 (감독, job_id)이고 장부의 게시 연결과 같은 식별이다.
  const candidate = fromSupervisor("publication_candidate", bodies.publication_candidate);
  const got = await at(candidate, "front-door");
  expect(got.ok && got.job).toEqual({ job_id: id(0xe03), action: "publication_candidate", request_digest: candidate.header.body_digest });
  expect(got.ok && publicationLinkOf(got.body as never)).toEqual({ frontJobId: id(0xe03), candidateDigest: DIGEST, runId: RUN });
  expect(publicationLinkOf({ ...bodies.publication_candidate, run_id: null } as never)).toEqual({ frontJobId: id(0xe03), candidateDigest: DIGEST, runId: null });
  // 같은 job_id에 다른 후보는 다른 request_digest다(충돌은 장부와 현관이 가른다).
  const other = fromSupervisor("publication_candidate", { ...bodies.publication_candidate, candidate_digest: "e".repeat(64) });
  const gotOther = await at(other, "front-door");
  expect(gotOther.ok && gotOther.job?.request_digest).not.toBe(candidate.header.body_digest);

  // 바로 답: posted·not_posted 둘 다 확정이다. 다른 작업·다른 본문의 답은 받지 않는다.
  for (const outcome of ["posted", "not_posted"]) {
    expect((await at(status(candidate, candidate.header.request_id, { state: "confirmed", result: { outcome } }), "supervisor", { awaiting: awaitingOf(candidate) })).ok, outcome).toBe(true);
  }
  expect(await at(status(other, candidate.header.request_id, { state: "confirmed", result: { outcome: "posted" } }), "supervisor", { awaiting: awaitingOf(candidate) })).toEqual({ ok: false, reason: "reply_mismatch" });

  // 세대: 현관의 지금 값(정지 8, 실행 4)과 같아야 한다. 정지를 풀기 전 실행 세대(3)의 늦은 후보, 새 정지(9)가 원장에 적힌 뒤의 옛 정지 세대 후보는 거절.
  const mismatch = { ok: false, reason: "generation_mismatch" } as const;
  expect(await at(fromSupervisor("publication_candidate", { ...bodies.publication_candidate, execution_generation: 3 }), "front-door")).toEqual(mismatch);
  expect(await at(fromSupervisor("publication_candidate", { ...bodies.publication_candidate, execution_generation: 5 }), "front-door")).toEqual(mismatch);
  expect(await at(candidate, "front-door", { generations: { stop: known(9), execution: known(4) } })).toEqual(mismatch);
  expect(await at(candidate, "front-door", { generations: { stop: known(8), execution: { known: false } } })).toEqual({ ok: false, reason: "generation_unknown" });
  // 정지 중(현관의 접수 닫힘)에는 받지 않는다. 인사가 안 됐거나 정책이 다르면 받지 않는다.
  expect(await at(candidate, "front-door", { intake_open: false })).toEqual({ ok: false, reason: "intake_closed" });
  expect(await at(candidate, "front-door", { handshake: "policy_mismatch" })).toEqual({ ok: false, reason: "policy_mismatch" });
  // 현관은 게시 후보를 낼 수 없고, 감독에게 받지도 않는다.
  expect(await at(fromFront("publication_candidate", bodies.publication_candidate), "supervisor")).toEqual({ ok: false, reason: "wrong_direction" });
  // 세대 칸이 없으면 만들 수도 없다.
  expect(sealReason("publication_candidate", without(bodies.publication_candidate, "execution_generation"))).toBe("generation_missing");
  expect(sealReason("publication_candidate", bodies.publication_candidate)).toBe("sealed");
});

test("모델이 정한 승인·목적지 거절", async () => {
  // 이 묶음의 칸 이름은 어느 금지 목록과도 부딪히지 않는다(통과 사례가 forbidden_field로 새지 않게).
  const normalize = (name: string) => name.toLowerCase().replace(/[-_\s]/g, "");
  const forbidden = new Set([...FORBIDDEN_FIELD_NAMES, ...SUPERVISOR_FORBIDDEN_FIELD_NAMES].map(normalize));
  expect(EFFECTS_FIELD_NAMES.length).toBeGreaterThan(0);
  for (const name of EFFECTS_FIELD_NAMES) expect(forbidden.has(normalize(name)), name).toBe(false);
  // 통과 본문의 맨 위 칸은 이 목록 안에 있다(목록이 본문과 따로 놀지 않게).
  for (const body of Object.values(bodies)) for (const key of Object.keys(body)) expect(EFFECTS_FIELD_NAMES, key).toContain(key);

  // 효과 넷 모두: 승인·목적지·권한을 주장하는 칸은 어느 깊이에서든 forbidden_field이고, 만들 수도 없다.
  const claims: Record<string, unknown>[] = [
    { approved: true },
    { approval: { by: "model" } },
    { destination: "https://discord.example/channels/1/2" },
    { channel_id: "1234" },
    { webhook_url: "https://discord.example/api/webhooks/1/x" },
    { permission: "post" },
    { Approved_By: "model" },
    { input_job_id: { channelId: "1234" } },
  ];
  for (const [action, body] of Object.entries(bodies)) {
    expect((await at(fromSupervisor(action, body), "front-door")).ok, action).toBe(true);
    for (const claim of claims) {
      const claimed = { ...body, ...claim };
      expect(await at(fromSupervisor(action, claimed), "front-door"), `${action} ${JSON.stringify(claim)}`).toEqual({ ok: false, reason: "forbidden_field" });
      expect(sealReason(action, claimed), `${action} ${JSON.stringify(claim)}`).toBe("forbidden_field");
    }
    // 금지 이름이 아닌 목적지·대상 칸도 없다(닫힌 객체): 모델이 저장소·스레드·사람을 고를 수 없다.
    for (const extra of [{ repository: "ukyi-app/homelab" }, { thread: "1" }, { target: "pr" }, { mention: "<@1>" }]) {
      expect(await at(fromSupervisor(action, { ...body, ...extra }), "front-door"), `${action} ${JSON.stringify(extra)}`).toEqual({ ok: false, reason: "unknown_field" });
    }
  }
  // 게시의 종류는 닫힌 목록이다.
  expect(await at(fromSupervisor("publication_candidate", { ...bodies.publication_candidate, kind: "direct_push" }), "front-door")).toEqual({ ok: false, reason: "body_malformed" });

  // 카드 요청의 확정 결과는 승인이 아니다: shown·refused뿐이고 approved는 결과의 꼴이 아니다.
  const card = fromSupervisor("approval_card_request", bodies.approval_card_request);
  const cardStatus = (result: unknown) => at(status(card, card.header.request_id, { state: "confirmed", result }), "supervisor", { awaiting: awaitingOf(card) });
  for (const outcome of ["shown", "refused"]) expect((await cardStatus({ outcome })).ok, outcome).toBe(true);
  for (const result of [{ outcome: "approved" }, { outcome: "shown", approved: true }, { outcome: "올려" }]) {
    expect((await cardStatus(result)).ok, JSON.stringify(result)).toBe(false);
  }
});

test("임의 진행 문구 거절", async () => {
  // 고정된 단계 여섯과 순번만 받는다.
  expect([...PROGRESS_STAGES]).toEqual(["cause", "patch", "verify", "pull_request", "done", "stopped"]);
  const progress = (over: Record<string, unknown>) => fromSupervisor("progress_update", { ...bodies.progress_update, ...over });
  for (const stage of PROGRESS_STAGES) expect((await at(progress({ stage }), "front-door")).ok, stage).toBe(true);
  for (const seq of [0, 1, 2 ** 31]) expect((await at(progress({ seq }), "front-door")).ok, `${seq}`).toBe(true);

  // 단계 밖의 값(표시 문구, 지어낸 단계, 대소문자 다름, 빈 글)과 꼴이 틀린 순번은 body_malformed.
  for (const stage of ["원인 확인", "끝났어요", "deploying", "Cause", "", "cause ", null, 1]) {
    expect(await at(progress({ stage }), "front-door"), JSON.stringify(stage)).toEqual({ ok: false, reason: "body_malformed" });
  }
  // 소수(1.5)는 정규화가 받지 않아 봉투를 만들 수 없다(받는 쪽에서도 digest 단계의 body_malformed).
  for (const seq of [-1, "1", null, true]) expect(await at(progress({ seq }), "front-door"), JSON.stringify(seq)).toEqual({ ok: false, reason: "body_malformed" });
  // 글을 싣는 칸은 없다(닫힌 객체). 멈춘 이유도 글로 싣지 않는다.
  for (const extra of [{ text: "원인 확인 중이에요" }, { status_line: "멈췄어요(시간 초과)" }, { reason: "시간 초과" }, { detail: { text: "…" } }]) {
    expect(await at(progress(extra), "front-door"), JSON.stringify(extra)).toEqual({ ok: false, reason: "unknown_field" });
    let sealed = "sealed";
    try {
      FRONTDOOR_CONTRACT.seal(
        { sender: "supervisor", recipient: "front-door", action: "progress_update", request_id: id(0xef1), issued_at: ISSUED, nonce: nonceOf(0xef1), body: { ...bodies.progress_update, ...extra } },
        keys.supervisor.privateKey,
      );
    } catch (error) {
      sealed = error instanceof SealError ? error.reason : String(error);
    }
    expect(sealed, JSON.stringify(extra)).toBe("unknown_field");
  }
  // 단계와 순번이 빠져도 거절이다.
  for (const field of ["stage", "seq", "input_job_id"]) {
    expect(await at(fromSupervisor("progress_update", without(bodies.progress_update, field)), "front-door"), field).toEqual({ ok: false, reason: "body_malformed" });
  }
  // 답 글 후보도 글을 싣지 않는다(digest만). 목적은 닫힌 목록이다.
  const reply = (over: Record<string, unknown>) => fromSupervisor("reply_candidate", { ...bodies.reply_candidate, ...over });
  expect((await at(reply({ purpose: "start" }), "front-door")).ok).toBe(true);
  expect(await at(reply({ text: "AdGuard가 죽었어요" }), "front-door")).toEqual({ ok: false, reason: "unknown_field" });
  expect(await at(reply({ purpose: "alert_start" }), "front-door")).toEqual({ ok: false, reason: "body_malformed" });
  expect(await at(reply({ candidate_digest: "AdGuard가 죽었어요" }), "front-door")).toEqual({ ok: false, reason: "body_malformed" });
  // 진행의 확정 결과: 보임, 늦은 순번이라 무시, 거절.
  const update = progress({});
  for (const outcome of ["shown", "superseded", "refused"]) {
    expect((await at(status(update, update.header.request_id, { state: "confirmed", result: { outcome } }), "supervisor", { awaiting: awaitingOf(update) })).ok, outcome).toBe(true);
  }
});

test("모름 조회가 확정 없음과 다름", async () => {
  // 묻는 쪽의 결론: 확정만 posted·not_posted, 대기는 대기, 현관의 unknown과 답 없음은 던진다(포트의 모름).
  const confirmed = (outcome: string): LookupOutcome => ({ answered: true, status: { state: "confirmed", result: { outcome } } });
  expect(publicationLookupOf(confirmed("posted"))).toEqual({ kind: "confirmed", outcome: "posted" });
  expect(publicationLookupOf(confirmed("not_posted"))).toEqual({ kind: "confirmed", outcome: "not_posted" });
  expect(publicationLookupOf({ answered: true, status: { state: "pending" } })).toEqual({ kind: "pending" });
  const unknownOf = (outcome: LookupOutcome) => {
    try {
      return publicationLookupOf(outcome);
    } catch (error) {
      return error instanceof PublicationUnknown ? `unknown:${error.reason}` : `other:${String(error)}`;
    }
  };
  expect(unknownOf({ answered: true, status: { state: "unknown" } })).toBe("unknown:unknown");
  for (const cause of ["timeout", "disconnected", "reply_rejected"] as const) expect(unknownOf({ answered: false, cause })).toBe(`unknown:${cause}`);
  // 타입을 어긴 입력도 not_posted로 새지 않는다.
  for (const value of [null, undefined, {}, { state: "confirmed" }, { state: "confirmed", result: null }, { state: "confirmed", result: {} }, { state: "confirmed", result: { outcome: "unknown" } }, { state: "not_posted" }]) {
    expect(unknownOf({ answered: true, status: value } as unknown as LookupOutcome), JSON.stringify(value)).toBe("unknown:reply_rejected");
  }

  // main의 복원 포트에 이어 붙이면: 확정·대기는 그대로, 모름은 포트가 던진다(복원기가 unknown으로 적는다). 같은 작업 ID로만 묻는다.
  const asked: string[] = [];
  const portFor = (outcome: LookupOutcome) =>
    recoveryPorts({
      readStopLedger: async () => ({ kind: "no_response" }),
      lookupPublication: async (frontJobId) => {
        asked.push(frontJobId);
        return publicationLookupOf(outcome);
      },
    }).publications;
  const JOB = id(0xe03);
  expect(await portFor(confirmed("not_posted")).lookup(JOB)).toEqual({ kind: "confirmed", outcome: "not_posted" });
  expect(await portFor({ answered: true, status: { state: "pending" } }).lookup(JOB)).toEqual({ kind: "pending" });
  for (const outcome of [{ answered: true, status: { state: "unknown" } }, { answered: false, cause: "timeout" }] as LookupOutcome[]) {
    await expect(portFor(outcome).lookup(JOB), JSON.stringify(outcome)).rejects.toThrow("모름");
  }
  expect(new Set(asked)).toEqual(new Set([JOB]));

  // 선로: 감독이 같은 작업 ID로 묻고(정책이 어긋나도), 현관이 unknown으로 답한 것은 받아들여지는 답이지만 확정이 아니다.
  const candidate = fromSupervisor("publication_candidate", bodies.publication_candidate);
  const lookup = fromSupervisor("job_lookup", jobOf(candidate));
  expect((await at(lookup, "front-door", { handshake: "policy_mismatch", intake_open: false })).ok).toBe(true);
  const lookupAwaiting = { [lookup.header.request_id]: { action: "job_lookup", job: jobOf(candidate) } };
  const answer = (value: unknown) => at(status(candidate, lookup.header.request_id, value), "supervisor", { handshake: "policy_mismatch", awaiting: lookupAwaiting });
  const unknownAnswer = await answer({ state: "unknown" });
  expect(unknownAnswer.ok).toBe(true);
  const settled = unknownAnswer.ok ? unknownOf({ answered: true, status: (unknownAnswer.body as { status: never }).status }) : "rejected";
  expect(settled).toBe("unknown:unknown");
  // 모름을 확정에 숨겨 보낼 수 없다: 확정 결과의 꼴은 posted·not_posted뿐이고, 모름에는 결과 칸이 없다.
  expect(await answer({ state: "confirmed", result: { outcome: "unknown" } })).toEqual({ ok: false, reason: "body_malformed" });
  expect(await answer({ state: "confirmed", result: {} })).toEqual({ ok: false, reason: "body_malformed" });
  expect(await answer({ state: "confirmed", result: null })).toEqual({ ok: false, reason: "body_malformed" });
  expect(await answer({ state: "unknown", result: { outcome: "not_posted" } })).toEqual({ ok: false, reason: "unknown_field" });
  expect(await answer({ state: "not_posted" })).toEqual({ ok: false, reason: "body_malformed" });
  // 현관은 감독의 게시 작업을 묻지 못한다(그 작업은 감독이 낸 것).
  expect(await at(fromFront("job_lookup", jobOf(candidate)), "supervisor")).toEqual({ ok: false, reason: "body_malformed" });
});

test("현관의 실행 세대: 조회의 답으로 채우고, 풀기 확정 값과 어긋나면 낮추지 않는다", async () => {
  // 첫 설치(풀기 교환 없음): 현관은 실행 세대를 몰라 감독의 후보가 모두 닫힌다.
  const candidate = fromSupervisor("publication_candidate", bodies.publication_candidate);
  const unknownExecution: GenerationAuthority = { known: false };
  expect(await at(candidate, "front-door", { generations: { stop: known(8), execution: unknownExecution } })).toEqual({ ok: false, reason: "generation_unknown" });

  // 현관이 묻는다(세대 없이, 감독의 접수가 닫혀도, 정책이 어긋나도). 감독이 지금 값 4로 답한다.
  const lookup = fromFront("execution_generation_lookup", {});
  for (const handshake of ["agreed", "policy_mismatch"] as const) {
    expect((await at(lookup, "supervisor", { handshake, intake_open: false })).ok, handshake).toBe(true);
  }
  expect(await at(lookup, "supervisor", { handshake: "none" })).toEqual({ ok: false, reason: "handshake_required" });
  const awaiting = { [lookup.header.request_id]: { action: "execution_generation_lookup", job: null } };
  const reply = (generation: unknown, inReplyTo = lookup.header.request_id) => fromSupervisor("execution_generation_reply", { in_reply_to: inReplyTo, generation });
  const answered = await at(reply(4), "front-door", { generations: { stop: known(8), execution: unknownExecution }, awaiting });
  expect(answered.ok).toBe(true);
  const generation = answered.ok ? (answered.body as { generation: number }).generation : -1;
  const adopted = adoptExecutionGeneration(unknownExecution, { answered: true, generation });
  expect(adopted).toEqual({ authority: known(4), regressed: false });
  // 채운 값으로 감독의 후보를 검증한다. 풀기 전 실행 세대의 늦은 후보는 거절.
  expect((await at(candidate, "front-door", { generations: { stop: known(8), execution: adopted.authority } })).ok).toBe(true);
  expect(await at(fromSupervisor("publication_candidate", { ...bodies.publication_candidate, execution_generation: 3 }), "front-door", { generations: { stop: known(8), execution: adopted.authority } })).toEqual({
    ok: false,
    reason: "generation_mismatch",
  });

  // 답은 기다리는 그 조회에만 묶인다. 꼴이 틀린 값은 받지 않는다. 현관은 이 답을 낼 수 없다.
  expect(await at(reply(4, id(0xe99)), "front-door", { awaiting })).toEqual({ ok: false, reason: "reply_mismatch" });
  expect(await at(reply(4), "front-door", { awaiting: { [lookup.header.request_id]: { action: "stop_record_lookup", job: null } } })).toEqual({ ok: false, reason: "reply_mismatch" });
  for (const bad of [-1, "4", null, true]) expect(await at(reply(bad), "front-door", { awaiting }), JSON.stringify(bad)).toEqual({ ok: false, reason: "body_malformed" });
  expect(await at(fromFront("execution_generation_reply", { in_reply_to: lookup.header.request_id, generation: 4 }), "supervisor", { awaiting })).toEqual({ ok: false, reason: "wrong_direction" });
  expect(await at(fromSupervisor("execution_generation_lookup", {}), "front-door")).toEqual({ ok: false, reason: "wrong_direction" });
  expect(await at(fromFront("execution_generation_lookup", { generation: 4 }), "supervisor")).toEqual({ ok: false, reason: "unknown_field" });

  // 풀기 확정 값(5)과 늦게 온 옛 답(4)이 어긋나면 큰 값(5)을 지킨다. 순서가 바뀌어도 같다. 작은 답은 regressed로 알린다.
  expect(adoptExecutionGeneration(known(4), { answered: true, generation: 5 })).toEqual({ authority: known(5), regressed: false });
  expect(adoptExecutionGeneration(known(5), { answered: true, generation: 4 })).toEqual({ authority: known(5), regressed: true });
  expect(adoptExecutionGeneration(known(5), { answered: true, generation: 5 })).toEqual({ authority: known(5), regressed: false });
  expect(adoptExecutionGeneration(known(5, 6), { answered: true, generation: 7 })).toEqual({ authority: known(7, 6), regressed: false });
  // 답이 없으면 아는 값을 두고, 모르던 값은 모르는 채다(지어내지 않는다).
  for (const cause of ["timeout", "disconnected", "reply_rejected"] as const) {
    expect(adoptExecutionGeneration(known(5), { answered: false, cause })).toEqual({ authority: known(5), regressed: false });
    expect(adoptExecutionGeneration(unknownExecution, { answered: false, cause })).toEqual({ authority: unknownExecution, regressed: false });
  }
  // 타입을 어긴 답도 값이 되지 않는다.
  for (const bad of [-1, 1.5, Number.NaN, "4", null, undefined]) {
    expect(adoptExecutionGeneration(unknownExecution, { answered: true, generation: bad } as never), JSON.stringify(bad)).toEqual({ authority: unknownExecution, regressed: false });
  }
});

test("표: 출력 묶음은 효과 넷(감독 → 현관, 정지·실행 세대 current, 닫힌 접수에서 받지 않음)과 조회 둘이다", () => {
  expect(OUTBOUND_GENERATIONS).toEqual({ stop: "current", execution: "current" });
  const rows = Object.entries(EFFECTS_BUNDLE.actions).map(([name, s]) => [name, s.class, [...s.from].join(","), s.duringClosedIntake, s.duringPolicyMismatch, s.generations]);
  expect(rows).toEqual([
    ["reply_candidate", "effect", "supervisor", false, false, OUTBOUND_GENERATIONS],
    ["approval_card_request", "effect", "supervisor", false, false, OUTBOUND_GENERATIONS],
    ["publication_candidate", "effect", "supervisor", false, false, OUTBOUND_GENERATIONS],
    ["progress_update", "effect", "supervisor", false, false, OUTBOUND_GENERATIONS],
    ["execution_generation_lookup", "query", "front-door", true, true, undefined],
    ["execution_generation_reply", "query", "supervisor", true, true, undefined],
  ]);
  for (const name of Object.keys(EFFECTS_BUNDLE.actions)) expect(Object.hasOwn(FRONTDOOR_CONTRACT.actions, name), name).toBe(true);
});
