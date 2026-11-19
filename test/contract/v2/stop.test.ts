// 정지 묶음(stop.ts)이 주장하는 보장: 정지 준비/확정 벡터 재생, 옛 세대의 풀기 거절, 잘못된 발신자 거절, 원장 조회 실패는 기록 없음과 다름.
// 실행 세대의 교환(풀기 확정의 결과로 현관이 실행에 속한 효과를 검증)도 본다.
import { expect, test } from "bun:test";
import { COMMON_BUNDLE } from "../../../src/contract/v2/actions.ts";
import { defineContract, type Envelope, SealError, signUnchecked } from "../../../src/contract/v2/contract.ts";
import type { GenerationAuthorities, GenerationAuthority } from "../../../src/contract/v2/generations.ts";
import { adoptExecutionGeneration, FRONTDOOR_CONTRACT, latestStopOf, type StopRecordOutcome, StopRecordUnknown } from "../../../src/contract/v2/index.ts";
import { list, readText } from "../../files.ts";
import { FIXTURE_DIR } from "./cases.ts";
import { buildStopCases } from "./cases-stop.ts";
import { baseContext, type CaseContext, contextOf, envelope, freshKeys, id, nonceOf, PROBE_BUNDLE, PROBE_NOTE, trustedRaw } from "./support.ts";

const keys = freshKeys();
type Receiver = "supervisor" | "front-door";

const known = (current: number, prepared: number | null = null): GenerationAuthority => ({ known: true, current, prepared });
// 감독의 실행 세대(run_epoch)는 3이다.
const gens = (stop: GenerationAuthority, execution: GenerationAuthority = known(3)): GenerationAuthorities => ({ stop, execution });

// 받는 쪽: 인사가 끝났고 접수는 닫혀 있다(정지·풀기는 닫힌 접수에서 받는다).
function at(message: unknown, receiver: Receiver, over: Partial<CaseContext> = {}, contract = FRONTDOOR_CONTRACT) {
  return contract.verify(message, contextOf(trustedRaw(keys, receiver), baseContext(receiver, { handshake: "agreed", intake_open: false, ...over })));
}

let n = 0x900;
const fromFront = (action: string, body: unknown) => envelope(keys, { sender: "front-door", recipient: "supervisor", action, request_id: id(++n), nonce: nonceOf(n) }, body);
const fromSupervisor = (action: string, body: unknown) => envelope(keys, { sender: "supervisor", recipient: "front-door", action, request_id: id(++n), nonce: nonceOf(n) }, body);
const jobOf = (message: Envelope) => ({ job_id: (message.body as { job_id: string }).job_id, action: message.header.action, request_digest: message.header.body_digest });
const confirmed = (request: Envelope, inReplyTo: string, result: unknown) =>
  fromSupervisor("job_status", { in_reply_to: inReplyTo, ...jobOf(request), status: { state: "confirmed", result } });
const awaitingOf = (request: Envelope, action = request.header.action) => ({ [request.header.request_id]: { action, job: jobOf(request) } });

test("정지 준비/확정 벡터 재생", async () => {
  // 표본 파일의 정지 묶음 사례가 그대로 재생된다(현관이 같은 파일을 독립 재생한다).
  const names = buildStopCases(keys).map((c) => c.name);
  expect(names).toContain("accept/stop-prepare");
  expect(names).toContain("accept/stop-commit");
  const files = new Set(await list(`${FIXTURE_DIR}/**/*.json`));
  for (const name of names) {
    const file = `${FIXTURE_DIR}/${name}.json`;
    expect(files.has(file), file).toBe(true);
    const f = JSON.parse(await readText(file)) as { keys: Record<string, string>; context: CaseContext; message: Envelope; expect: { ok: boolean; reason?: string } };
    const got = await FRONTDOOR_CONTRACT.verify(f.message, contextOf(f.keys, f.context));
    expect(got.ok ? { ok: true } : got, name).toEqual(f.expect.ok ? { ok: true } : f.expect);
  }

  // 한 정지의 순서: 감독의 정지 세대 7 → 준비 8 → 확정 8.
  const J = id(0xa01);
  const prepare = fromFront("stop_prepare", { job_id: J, stop_generation: 8 });
  const before = { generations: gens(known(7)) };
  const got = await at(prepare, "supervisor", before);
  expect(got.ok && got.job).toEqual({ job_id: J, action: "stop_prepare", request_digest: prepare.header.body_digest });
  // 건너뛴 세대도 받는다(newer). 같거나 옛 세대는 거절한다.
  expect((await at(fromFront("stop_prepare", { job_id: id(0xa02), stop_generation: 10 }), "supervisor", before)).ok).toBe(true);
  for (const old of [7, 6, 0]) expect(await at(fromFront("stop_prepare", { job_id: id(0xa03), stop_generation: old }), "supervisor", before), `${old}`).toEqual({ ok: false, reason: "generation_mismatch" });
  // 같은 단계의 재전달(같은 본문, 새 봉투)은 같은 작업이다. 처리기가 작업 ID로 한 번만 적용한다.
  const again = fromFront("stop_prepare", prepare.body);
  const gotAgain = await at(again, "supervisor", { generations: gens(known(7, 8)) });
  expect(gotAgain.ok && gotAgain.job).toEqual(got.ok ? got.job : null);
  // 준비의 바로 답(prepared)을 현관이 받는다.
  expect((await at(confirmed(prepare, prepare.header.request_id, { outcome: "prepared" }), "front-door", { awaiting: awaitingOf(prepare) })).ok).toBe(true);

  // 확정은 받아 둔 준비의 세대만 받는다.
  const commit = fromFront("stop_commit", { job_id: id(0xa04), stop_generation: 8 });
  expect((await at(commit, "supervisor", { generations: gens(known(7, 8)) })).ok).toBe(true);
  expect(await at(commit, "supervisor", { generations: gens(known(7, null)) })).toEqual({ ok: false, reason: "generation_mismatch" });
  expect(await at(commit, "supervisor", { generations: gens(known(7, 9)) })).toEqual({ ok: false, reason: "generation_mismatch" });
  expect(await at(commit, "supervisor", { generations: gens({ known: false }) })).toEqual({ ok: false, reason: "generation_unknown" });

  // 확정을 적용한 뒤(지금 8, 준비 없음): 준비·확정의 재전달은 옛 세대라 거절되고, 같은 작업 ID 조회로 확인한다(정책이 어긋나도).
  const after = { generations: gens(known(8)) };
  expect(await at(fromFront("stop_prepare", prepare.body), "supervisor", after)).toEqual({ ok: false, reason: "generation_mismatch" });
  expect(await at(fromFront("stop_commit", commit.body), "supervisor", after)).toEqual({ ok: false, reason: "generation_mismatch" });
  const lookup = fromFront("job_lookup", jobOf(commit));
  for (const handshake of ["agreed", "policy_mismatch"] as const) expect((await at(lookup, "supervisor", { ...after, handshake })).ok, handshake).toBe(true);
  const lookupAwaiting = awaitingOf(lookup, "job_lookup");
  lookupAwaiting[lookup.header.request_id]!.job = jobOf(commit);
  expect((await at(confirmed(commit, lookup.header.request_id, { outcome: "stopped" }), "front-door", { awaiting: lookupAwaiting })).ok).toBe(true);
  // 정지에는 거절 결과가 없다. 다른 작업의 답은 받지 않는다.
  expect(await at(confirmed(commit, lookup.header.request_id, { outcome: "refused" }), "front-door", { awaiting: lookupAwaiting })).toEqual({ ok: false, reason: "body_malformed" });
  expect(await at(confirmed(prepare, lookup.header.request_id, { outcome: "prepared" }), "front-door", { awaiting: lookupAwaiting })).toEqual({ ok: false, reason: "reply_mismatch" });
});

test("옛 세대의 풀기 거절", async () => {
  // 감독은 정지 세대 8에서 정지 중, 실행 세대 3.
  const stopped = { generations: gens(known(8)) };
  expect((await at(fromFront("release_prepare", { job_id: id(0xb01), stop_generation: 8 }), "supervisor", stopped)).ok).toBe(true);
  for (const old of [7, 0]) {
    expect(await at(fromFront("release_prepare", { job_id: id(0xb02), stop_generation: old }), "supervisor", stopped), `${old}`).toEqual({ ok: false, reason: "generation_mismatch" });
  }
  // 앞으로의 정지 세대를 풀 수도 없다.
  expect(await at(fromFront("release_prepare", { job_id: id(0xb03), stop_generation: 9 }), "supervisor", stopped)).toEqual({ ok: false, reason: "generation_mismatch" });

  // 확정: 정지 세대는 받아 둔 풀기 준비(8), 실행 세대는 지금 + 1(4).
  const prepared = { generations: gens(known(8, 8)) };
  const commit = (stop: number, execution: number) => fromFront("release_commit", { job_id: id(0xb10), stop_generation: stop, execution_generation: execution });
  expect((await at(commit(8, 4), "supervisor", prepared)).ok).toBe(true);
  const mismatch = { ok: false, reason: "generation_mismatch" } as const;
  // 옛 정지 세대, 옛·같은·건너뛴 실행 세대.
  expect(await at(commit(7, 4), "supervisor", prepared)).toEqual(mismatch);
  expect(await at(commit(8, 3), "supervisor", prepared)).toEqual(mismatch);
  expect(await at(commit(8, 2), "supervisor", prepared)).toEqual(mismatch);
  expect(await at(commit(8, 5), "supervisor", prepared)).toEqual(mismatch);
  // 준비 없는 확정, 새 정지 준비(9)가 준비 칸을 덮은 뒤의 늦은 확정.
  expect(await at(commit(8, 4), "supervisor", { generations: gens(known(8)) })).toEqual(mismatch);
  expect(await at(commit(8, 4), "supervisor", { generations: gens(known(8, 9)) })).toEqual(mismatch);
  // 실행 세대를 이미 4로 올린 뒤의 재전달, 그 뒤 새 정지(9)가 확정된 뒤의 재전달.
  expect(await at(commit(8, 4), "supervisor", { generations: gens(known(8), known(4)) })).toEqual(mismatch);
  expect(await at(commit(8, 4), "supervisor", { generations: gens(known(9), known(4)) })).toEqual(mismatch);
  // 모르면 닫는다. 실행 세대 칸이 없으면 generation_missing.
  expect(await at(commit(8, 4), "supervisor", { generations: gens(known(8, 8), { known: false }) })).toEqual({ ok: false, reason: "generation_unknown" });
  expect(await at(commit(8, 4), "supervisor", { generations: gens({ known: false }) })).toEqual({ ok: false, reason: "generation_unknown" });
  expect(await at(fromFront("release_commit", { job_id: id(0xb11), stop_generation: 8 }), "supervisor", prepared)).toEqual({ ok: false, reason: "generation_missing" });
  // 풀기 준비는 실행 세대를 싣지 않는다.
  expect(await at(fromFront("release_prepare", { job_id: id(0xb12), stop_generation: 8, execution_generation: 4 }), "supervisor", stopped)).toEqual({ ok: false, reason: "body_malformed" });
});

test("잘못된 발신자 거절", async () => {
  const agreedAt = (generations: GenerationAuthorities) => ({ generations });
  const bodies: Record<string, Record<string, unknown>> = {
    stop_prepare: { job_id: id(0xc01), stop_generation: 8 },
    stop_commit: { job_id: id(0xc02), stop_generation: 8 },
    release_prepare: { job_id: id(0xc03), stop_generation: 8 },
    release_commit: { job_id: id(0xc04), stop_generation: 8, execution_generation: 4 },
  };
  for (const [action, body] of Object.entries(bodies)) {
    // 감독이 낸 정지·풀기: 받는 현관에서 wrong_direction(현관이 감독의 세대를 알아도).
    const bySupervisor = fromSupervisor(action, body);
    expect(await at(bySupervisor, "front-door", agreedAt(gens(known(8, 8)))), action).toEqual({ ok: false, reason: "wrong_direction" });
    // 현관 이름에 감독의 키: bad_signature.
    const real = fromFront(action, body);
    expect(await at(signUnchecked(real.header, real.body, keys.supervisor.privateKey), "supervisor", agreedAt(gens(known(7, 8)))), action).toEqual({ ok: false, reason: "bad_signature" });
    // 감독은 만들 수도 없다.
    let sealed = "sealed";
    try {
      FRONTDOOR_CONTRACT.seal({ sender: "supervisor", recipient: "front-door", action, request_id: id(0xc10), issued_at: real.header.issued_at, nonce: nonceOf(0xc10), body }, keys.supervisor.privateKey);
    } catch (error) {
      sealed = error instanceof SealError ? error.reason : String(error);
    }
    expect(sealed, action).toBe("wrong_direction");
  }

  // 권위 조회는 감독만 묻고 현관만 답한다.
  expect(await at(fromFront("stop_record_lookup", {}), "supervisor")).toEqual({ ok: false, reason: "wrong_direction" });
  const lookup = fromSupervisor("stop_record_lookup", {});
  const answer = { in_reply_to: lookup.header.request_id, record: { state: "recorded", generation: 7, stopped: true } };
  expect(await at(fromSupervisor("stop_record", answer), "front-door", { awaiting: { [lookup.header.request_id]: { action: "stop_record_lookup", job: null } } })).toEqual({
    ok: false,
    reason: "wrong_direction",
  });

  // 현관이 낸 "감독만 내는 답": 현관의 정지 작업에 대한 결과를 현관이 감독에게 답할 수 없다. 감독은 현관의 정지 작업을 묻지 못한다.
  const prepare = fromFront("stop_prepare", bodies.stop_prepare);
  const statusByFront = fromFront("job_status", { in_reply_to: id(0xc20), ...jobOf(prepare), status: { state: "confirmed", result: { outcome: "prepared" } } });
  expect(await at(statusByFront, "supervisor", { awaiting: { [id(0xc20)]: { action: "job_lookup", job: jobOf(prepare) } } })).toEqual({ ok: false, reason: "body_malformed" });
  expect(await at(fromSupervisor("job_lookup", jobOf(prepare)), "front-door")).toEqual({ ok: false, reason: "body_malformed" });
});

test("원장 조회 실패는 기록 없음과 다름", async () => {
  // 묻는 쪽의 결론: 확인된 부재만 null, 답이 없으면 던진다.
  for (const cause of ["timeout", "disconnected", "reply_rejected"] as const) {
    expect(() => latestStopOf({ answered: false, cause })).toThrow(StopRecordUnknown);
  }
  expect(latestStopOf({ answered: true, record: { state: "absent" } })).toBeNull();
  expect(latestStopOf({ answered: true, record: { state: "recorded", generation: 0, stopped: false } })).toEqual({ generation: 0, stopped: false });
  // 타입을 어긴 입력도 없음으로 새지 않는다.
  for (const record of [null, undefined, {}, { state: "none" }]) {
    expect(() => latestStopOf({ answered: true, record } as unknown as StopRecordOutcome), JSON.stringify(record)).toThrow(StopRecordUnknown);
  }

  // 선로: 감독이 정지 세대를 모르는 복원 1단계, 정책이 어긋난 연결, 닫힌 접수에서도 조회와 답이 오간다.
  const lookup = fromSupervisor("stop_record_lookup", {});
  expect((await at(lookup, "front-door", { handshake: "policy_mismatch" })).ok).toBe(true);
  const restoring = { handshake: "policy_mismatch" as const, awaiting: { [lookup.header.request_id]: { action: "stop_record_lookup", job: null } } };
  const reply = (record: unknown, inReplyTo = lookup.header.request_id) => fromFront("stop_record", { in_reply_to: inReplyTo, record });
  const absent = await at(reply({ state: "absent" }), "supervisor", restoring);
  expect(absent.ok && absent.body).toEqual({ in_reply_to: lookup.header.request_id, record: { state: "absent" } });
  const recorded = await at(reply({ state: "recorded", generation: 7, stopped: true }), "supervisor", restoring);
  expect(recorded.ok && latestStopOf({ answered: true, record: (recorded.body as { record: never }).record })).toEqual({ generation: 7, stopped: true });

  // 비었거나 덜 찬 기록은 "기록 없음"이 아니라 거절이다(검증된 absent만 부재다).
  const malformed = [null, {}, [], "absent", { state: "absent", generation: 0 }, { state: "recorded", generation: 7 }, { state: "recorded", generation: 7, stopped: "true" }, { state: "recorded", generation: -1, stopped: true }, { state: "none" }];
  for (const record of malformed) {
    const got = await at(reply(record), "supervisor", restoring);
    expect(got.ok, JSON.stringify(record)).toBe(false);
    expect(["body_malformed", "unknown_field"], JSON.stringify(record)).toContain(got.ok ? "accepted" : got.reason);
  }
  const noRecord = fromFront("stop_record", { in_reply_to: lookup.header.request_id });
  expect(await at(noRecord, "supervisor", restoring)).toEqual({ ok: false, reason: "body_malformed" });
  // 기다리지 않는 답, 다른 물음(작업 조회)에 대한 답은 reply_mismatch다.
  expect(await at(reply({ state: "absent" }), "supervisor", { ...restoring, awaiting: {} })).toEqual({ ok: false, reason: "reply_mismatch" });
  expect(await at(reply({ state: "absent" }), "supervisor", { ...restoring, awaiting: { [lookup.header.request_id]: { action: "job_lookup", job: null } } })).toEqual({
    ok: false,
    reason: "reply_mismatch",
  });
  // 인사 없는 연결에서는 조회도 받지 않는다.
  expect(await at(reply({ state: "absent" }), "supervisor", { ...restoring, handshake: "none" })).toEqual({ ok: false, reason: "handshake_required" });
});

test("실행 세대의 교환: 풀기 확정이 확정한 값으로 현관이 실행에 속한 효과를 검증한다", async () => {
  // 감독(실행 세대 3)이 풀기 준비의 결과로 올릴 값 4를 알리고, 현관이 그 값을 풀기 확정에 실어 서명한다.
  const prepare = fromFront("release_prepare", { job_id: id(0xd01), stop_generation: 8 });
  const announced = await at(confirmed(prepare, prepare.header.request_id, { outcome: "prepared", execution_generation: 4 }), "front-door", { awaiting: awaitingOf(prepare) });
  expect(announced.ok && (announced.body as { status: unknown }).status).toEqual({ state: "confirmed", result: { outcome: "prepared", execution_generation: 4 } });
  expect(await at(confirmed(prepare, prepare.header.request_id, { outcome: "prepared" }), "front-door", { awaiting: awaitingOf(prepare) })).toEqual({ ok: false, reason: "body_malformed" });
  expect((await at(confirmed(prepare, prepare.header.request_id, { outcome: "refused" }), "front-door", { awaiting: awaitingOf(prepare) })).ok).toBe(true);

  const commit = fromFront("release_commit", { job_id: id(0xd02), stop_generation: 8, execution_generation: 4 });
  expect((await at(commit, "supervisor", { generations: gens(known(8, 8), known(3)) })).ok).toBe(true);
  // released의 답은 실행 세대 4를 실은 본문(request_digest)에 묶인다. 다른 본문의 digest로 온 답은 받지 않는다.
  expect((await at(confirmed(commit, commit.header.request_id, { outcome: "released" }), "front-door", { awaiting: awaitingOf(commit) })).ok).toBe(true);
  const otherBody = fromFront("release_commit", { job_id: id(0xd02), stop_generation: 8, execution_generation: 5 });
  expect(await at(confirmed(otherBody, commit.header.request_id, { outcome: "released" }), "front-door", { awaiting: awaitingOf(commit) })).toEqual({ ok: false, reason: "reply_mismatch" });

  // released로 확정된 본문의 실행 세대(4)를 현관은 실행 세대 조회의 답과 같은 함수로 받는다: 올리기만 하고 낮추지 않는다.
  const releasedValue = { answered: true as const, generation: (commit.body as { execution_generation: number }).execution_generation };
  expect(adoptExecutionGeneration({ known: false }, releasedValue)).toEqual({ authority: known(4), regressed: false });
  expect(adoptExecutionGeneration(known(3), releasedValue)).toEqual({ authority: known(4), regressed: false });
  // 조회의 답으로 이미 5를 안 현관에 늦게 닿은 풀기 확정(4)은 값을 낮추지 않고 regressed로 알린다.
  expect(adoptExecutionGeneration(known(5), releasedValue)).toEqual({ authority: known(5), regressed: true });

  // 그 뒤 현관의 권위 값: 정지 8, 실행 4. 실행에 속한 감독의 효과(probe_return: 두 세대 모두 current)를 이 값으로 검증한다.
  const withProbe = defineContract([COMMON_BUNDLE, PROBE_BUNDLE]);
  const post = (execution: number) =>
    envelope(
      keys,
      { sender: "supervisor", recipient: "front-door", action: "probe_return", request_id: id(++n), nonce: nonceOf(n) },
      { job_id: id(0xd10), note_digest: PROBE_NOTE, stop_generation: 8, execution_generation: execution },
    );
  const front = (execution: GenerationAuthority) => ({ intake_open: true, generations: gens(known(8), execution) });
  expect((await at(post(4), "front-door", front(known(4)), withProbe)).ok).toBe(true);
  // 풀기 전 실행 세대의 늦은 효과는 거절된다. 교환을 거치지 않아 값을 모르면 닫는다.
  expect(await at(post(3), "front-door", front(known(4)), withProbe)).toEqual({ ok: false, reason: "generation_mismatch" });
  expect(await at(post(4), "front-door", front({ known: false }), withProbe)).toEqual({ ok: false, reason: "generation_unknown" });
});

test("정책이 어긋난 연결: 정지의 준비·확정은 받고, 풀기의 준비·확정은 받지 않는다", async () => {
  const mismatch = { handshake: "policy_mismatch" as const };
  // 정지 세대 7 → 준비 8 → 확정 8이 정책이 어긋난 연결에서도 끝난다. 세대 규칙은 그대로 강제된다.
  const prepare = fromFront("stop_prepare", { job_id: id(0xb01), stop_generation: 8 });
  expect((await at(prepare, "supervisor", { ...mismatch, generations: gens(known(7)) })).ok).toBe(true);
  expect(await at(fromFront("stop_prepare", { job_id: id(0xb02), stop_generation: 7 }), "supervisor", { ...mismatch, generations: gens(known(7)) })).toEqual({
    ok: false,
    reason: "generation_mismatch",
  });
  const commit = fromFront("stop_commit", { job_id: id(0xb03), stop_generation: 8 });
  expect((await at(commit, "supervisor", { ...mismatch, generations: gens(known(7, 8)) })).ok).toBe(true);
  expect(await at(commit, "supervisor", { ...mismatch, generations: gens(known(7, null)) })).toEqual({ ok: false, reason: "generation_mismatch" });
  // 인사가 없는 연결은 정지도 받지 않는다(예외는 정책 불일치 하나뿐이다).
  expect(await at(prepare, "supervisor", { handshake: "none", generations: gens(known(7)) })).toEqual({ ok: false, reason: "handshake_required" });

  // 풀기는 세대가 맞아도 policy_mismatch다. 같은 봉투가 정책이 맞는 연결에서는 받아진다.
  const releasePrepare = fromFront("release_prepare", { job_id: id(0xb04), stop_generation: 8 });
  const releaseCommit = fromFront("release_commit", { job_id: id(0xb05), stop_generation: 8, execution_generation: 4 });
  const cases = [
    [releasePrepare, gens(known(8))],
    [releaseCommit, gens(known(8, 8), known(3))],
  ] as const;
  for (const [message, generations] of cases) {
    expect(await at(message, "supervisor", { ...mismatch, generations }), message.header.action).toEqual({ ok: false, reason: "policy_mismatch" });
    expect((await at(message, "supervisor", { handshake: "agreed", generations })).ok, message.header.action).toBe(true);
  }
});

test("준비의 종류: 풀기 확정은 풀기 준비에만, 정지 확정은 정지 준비에만 묶인다", async () => {
  const mismatch = { ok: false, reason: "generation_mismatch" } as const;
  const releaseCommit = fromFront("release_commit", { job_id: id(0xe01), stop_generation: 8, execution_generation: 4 });
  const stopCommit = fromFront("stop_commit", { job_id: id(0xe02), stop_generation: 8 });
  // 감독이 지금 7에서 정지 준비 8만 받아 둠: 같은 번호(8)의 풀기 확정을 받지 않는다. 정지 확정은 받는다.
  const stopPrepared = { generations: gens(known(7, 8), known(3)) };
  expect(await at(releaseCommit, "supervisor", stopPrepared)).toEqual(mismatch);
  expect((await at(stopCommit, "supervisor", stopPrepared)).ok).toBe(true);
  // 감독이 지금 8에서 풀기 준비 8만 받아 둠: 같은 번호(8)의 정지 확정을 받지 않는다. 풀기 확정은 받는다.
  const releasePrepared = { generations: gens(known(8, 8), known(3)) };
  expect(await at(stopCommit, "supervisor", releasePrepared)).toEqual(mismatch);
  expect((await at(releaseCommit, "supervisor", releasePrepared)).ok).toBe(true);
});

test("늦은 낮은 정지 준비: 더 높은 정지 준비를 받아 둔 뒤의 낮은 준비는 거절하고, 같은 번호의 새 봉투와 더 큰 번호는 받는다", async () => {
  const higher = { generations: gens(known(7, 10)) };
  expect(await at(fromFront("stop_prepare", { job_id: id(0xe11), stop_generation: 8 }), "supervisor", higher)).toEqual({ ok: false, reason: "generation_mismatch" });
  expect(await at(fromFront("stop_prepare", { job_id: id(0xe12), stop_generation: 9 }), "supervisor", higher)).toEqual({ ok: false, reason: "generation_mismatch" });
  expect((await at(fromFront("stop_prepare", { job_id: id(0xe13), stop_generation: 10 }), "supervisor", higher)).ok).toBe(true);
  expect((await at(fromFront("stop_prepare", { job_id: id(0xe14), stop_generation: 11 }), "supervisor", higher)).ok).toBe(true);
  // 풀기 준비(지금과 같은 번호)를 받아 둔 동안의 새 정지 준비는 그대로 받는다(정지가 이긴다).
  expect((await at(fromFront("stop_prepare", { job_id: id(0xe15), stop_generation: 9 }), "supervisor", { generations: gens(known(8, 8)) })).ok).toBe(true);
});

test("있을 수 없는 실행 세대: 조회 답은 1 이상, 풀기 준비가 약속하는 다음 값은 2 이상, 0은 권위 값이 되지 않는다", async () => {
  const prepare = fromFront("release_prepare", { job_id: id(0xe21), stop_generation: 8 });
  const prepared = (execution_generation: number) =>
    at(confirmed(prepare, prepare.header.request_id, { outcome: "prepared", execution_generation }), "front-door", { awaiting: awaitingOf(prepare) });
  for (const value of [0, 1]) expect(await prepared(value), `${value}`).toEqual({ ok: false, reason: "body_malformed" });
  expect((await prepared(2)).ok).toBe(true);

  const lookup = fromFront("execution_generation_lookup", {});
  const reply = (generation: number) =>
    at(fromSupervisor("execution_generation_reply", { in_reply_to: lookup.header.request_id, generation }), "front-door", {
      awaiting: { [lookup.header.request_id]: { action: "execution_generation_lookup", job: null } },
    });
  expect(await reply(0)).toEqual({ ok: false, reason: "body_malformed" });
  expect((await reply(1)).ok).toBe(true);

  expect(adoptExecutionGeneration({ known: false }, { answered: true, generation: 0 })).toEqual({ authority: { known: false }, regressed: false });
  expect(adoptExecutionGeneration(known(3), { answered: true, generation: 0 })).toEqual({ authority: known(3), regressed: false });
  expect(adoptExecutionGeneration({ known: false }, { answered: true, generation: 1 })).toEqual({ authority: known(1), regressed: false });
  // 정지 세대 0은 첫 설치의 유효값이다(권위 기록으로 받는다).
  expect(latestStopOf({ answered: true, record: { state: "recorded", generation: 0, stopped: false } })).toEqual({ generation: 0, stopped: false });
});

test("정지 기록 변환의 재검사: 칸이 빠지거나 남은 기록, 범위 밖 값, -0은 모름이다", () => {
  const bad: unknown[] = [
    { state: "recorded", generation: 7 },
    { state: "recorded", stopped: true },
    { state: "recorded", generation: 7, stopped: true, extra: 1 },
    { state: "absent", generation: 0 },
    { state: "recorded", generation: -0, stopped: true },
    { state: "recorded", generation: -1, stopped: true },
    { state: "recorded", generation: 1.5, stopped: true },
    { state: "recorded", generation: "7", stopped: true },
    { state: "recorded", generation: 7, stopped: "true" },
    [],
  ];
  for (const record of bad) {
    let reason = "returned";
    try {
      latestStopOf({ answered: true, record } as unknown as StopRecordOutcome);
    } catch (error) {
      reason = error instanceof StopRecordUnknown ? error.reason : String(error);
    }
    expect(reason, JSON.stringify(record)).toBe("reply_rejected");
  }
});
