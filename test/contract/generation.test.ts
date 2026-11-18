// 세대와 받는 시각의 순서 시험: 비상 정지의 새 정지 세대, 재접속 상태의 실행 세대, 받을 때 이미 지난 작업 기한.
import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { ACTION_SPECS } from "../../src/contract/v1/actions.ts";
import { digestOf } from "../../src/contract/v1/canonical.ts";
import type { RejectReason } from "../../src/contract/v1/errors.ts";
import { INSTRUCTIONS } from "../../src/contract/v1/instruction.ts";
import { type Envelope, rawPublicKey, sealEnvelope, type SealInput, signUnchecked, verifyEnvelope } from "../../src/contract/v1/envelope.ts";
import type { Action, Header } from "../../src/contract/v1/header.ts";
import {
  CLOCK_SKEW_MS,
  DELIVERY_MAX_MS,
  MESSAGE_TTL_MAX_MS,
  MESSAGE_TTL_MS,
  STOP_SYNC_ANSWER_MAX_MS,
  STOP_SYNC_TTL_MAX_MS,
  STOP_SYNC_TTL_MS,
  STOP_SYNC_WAIT_MS,
} from "../../src/contract/v1/limits.ts";
import { maySend, runsOutsideLedger, type RunStatus, STARTS_RUN } from "../../src/contract/v1/transport.ts";
import {
  CHALLENGE,
  DIAGNOSIS,
  DIAGNOSIS_NEW_STORAGE,
  freshKeys,
  hash,
  id,
  ISSUED,
  NOW,
  OTHER_CHALLENGE,
  RUN_NEW_TASK,
  RUN_TASK,
  SESSION,
  SUPERVISOR,
} from "./cases.ts";
import { contextOf, MemoryNonces } from "./support.ts";

const FRONT_DOOR = "front-door";
const keys = freshKeys();
// 저장소를 잃고 새 저장소 ID로 뜬 실행기와 현관도 각자의 키가 있다.
keys[DIAGNOSIS_NEW_STORAGE] = generateKeyPairSync("ed25519");
keys[FRONT_DOOR] = generateKeyPairSync("ed25519");
const trusted =Object.fromEntries(Object.entries(keys).map(([name, pair]) => [name, rawPublicKey(pair.publicKey)]));
const credential = { account: "main", method: "subscription", revision: "cred-7", digest: hash("credential value") } as const;

let counter = 0;
function seal<A extends Action>(input: Omit<SealInput<A>, "request_id" | "nonce" | "issued_at"> & { issued_at?: number }) {
  counter++;
  return sealEnvelope(
    { issued_at: ISSUED, request_id: id(0xb000 + counter), nonce: (0xdef000 + counter).toString(16).padStart(32, "0"), ...input } as SealInput<A>,
    keys[input.sender]!.privateKey,
  );
}

// 실행기 하나의 상태를 흉내 낸다. 검증 함수는 순수하므로, 받아들인 새 정지 세대를 적용하는 것은 이 쪽(실행기)의 일이다.
// challenge는 연결마다 하나다. requestSync가 새 연결의 맞춤 요청을 만들고, 답을 받아들이면 그 challenge를 버린다.
function executor(recipient: string, stopGeneration: number | null, runs: Record<string, number>) {
  const state = { stopGeneration, runs: { ...runs }, challenge: null as { challenge: string; sent_at: number } | null };
  const nonces = new MemoryNonces();
  return {
    state,
    // sentAt: 요청을 연결에 실은 시각(기본은 요청의 발급 시각). 기다리는 기한은 여기서부터 잰다.
    requestSync(challenge: string, sentAt = ISSUED) {
      state.challenge = { challenge, sent_at: sentAt };
      return seal({ sender: recipient, recipient: SUPERVISOR, action: "stop_sync_request", stop_generation: 0, run_generation: 0, issued_at: sentAt, body: { challenge } });
    },
    // 연결이 끝나면 기다리던 challenge를 버린다.
    disconnect() {
      state.challenge = null;
    },
    async receive(message: unknown, now = NOW) {
      const ctx = contextOf(
        trusted,
        { now, expected_recipient: recipient, stop_generation: state.stopGeneration, stop_sync_challenge: state.challenge, run_generations: state.runs, spent_nonces: [] },
        nonces,
      );
      const result = await verifyEnvelope(message, ctx);
      if (result.ok && result.action === "stop_sync_reply") state.challenge = null;
      if (result.ok && result.adoptedStopGeneration !== null) state.stopGeneration = result.adoptedStopGeneration;
      return result.ok ? { ok: true as const, adopted: result.adoptedStopGeneration } : { ok: false as const, reason: result.reason };
    },
  };
}

// 감독 쪽. 세대는 감독 자신의 정지 기록에서만 온다. 받은 메시지는 이 값을 바꾸지 않는다(시험이 확인한다).
function supervisor(stopGeneration: number | null) {
  const state = { stopGeneration };
  const nonces = new MemoryNonces();
  return {
    state,
    async receive(message: unknown, now = NOW) {
      const ctx = contextOf(
        trusted,
        { now, expected_recipient: SUPERVISOR, stop_generation: state.stopGeneration, stop_sync_challenge: null, run_generations: {}, spent_nonces: [] },
        nonces,
      );
      const result = await verifyEnvelope(message, ctx);
      return result.ok ? { ok: true as const, adopted: result.adoptedStopGeneration, body: result.body } : { ok: false as const, reason: result.reason };
    },
  };
}

const taskStart = (stop: number, runId = RUN_NEW_TASK) =>
  seal({
    sender: SUPERVISOR,
    recipient: DIAGNOSIS,
    action: "task_start",
    stop_generation: stop,
    run_generation: 1,
    body: {
      run_id: runId,
      role: "diagnosis",
      profile_revision: "diagnosis-r1",
      policy_revision: "policy-r1",
      snapshot_digest: hash("snapshot"),
      input_digest: hash("input"),
      deadline_at: NOW + 600_000,
      budget_tokens: 1_000,
      credential,
    },
  });
const renew = (stop: number) =>
  seal({ sender: SUPERVISOR, recipient: DIAGNOSIS, action: "run_renew", stop_generation: stop, run_generation: 2, body: { run_id: RUN_TASK, lease_until: ISSUED + 20_000 } });
const cancel = (stop: number, reason: "emergency_stop" | "requested" = "emergency_stop") =>
  seal({ sender: SUPERVISOR, recipient: DIAGNOSIS, action: "task_cancel", stop_generation: stop, run_generation: 2, body: { run_id: RUN_TASK, reason } });

test("정지 세대: 3에서 4의 비상 종료를 받아들여 4를 돌려주고, 그 뒤 옛 세대·임의의 미래 세대·옛 종료는 거절한다", async () => {
  const worker = executor(DIAGNOSIS, 3, { [RUN_TASK]: 2 });
  // 서명·시한이 모두 맞는 세대 3의 시작·갱신을 미리 만들어 둔다(비상 정지 전에 발급돼 아직 날아오는 중인 지시).
  const oldStart = taskStart(3);
  const oldRenew = renew(3);

  expect(await worker.receive(cancel(4))).toEqual({ ok: true, adopted: 4 });
  expect(worker.state.stopGeneration).toBe(4);

  expect(await worker.receive(oldStart)).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(await worker.receive(oldRenew)).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(await worker.receive(taskStart(5, id(0x103)))).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(await worker.receive(cancel(3))).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(worker.state.stopGeneration).toBe(4);

  // 같은 세대가 된 뒤의 지시는 평소대로 받고 세대는 그대로다.
  expect(await worker.receive(renew(4))).toEqual({ ok: true, adopted: null });
});

test("정지 세대: 더 높은 값은 비상 종료에서만 받는다(시작·갱신·확정·평범한 취소, 세션 쪽도 같다)", async () => {
  const worker = executor(DIAGNOSIS, 3, { [RUN_TASK]: 2 });
  expect(await worker.receive(taskStart(4))).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(await worker.receive(renew(4))).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(await worker.receive(cancel(4, "requested"))).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  const finalize = seal({
    sender: SUPERVISOR,
    recipient: DIAGNOSIS,
    action: "result_finalize",
    stop_generation: 4,
    run_generation: 2,
    body: { run_id: RUN_TASK, outcome: "failed", result_digest: null, stored_at: NOW - 1 },
  });
  expect(await worker.receive(finalize)).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(worker.state.stopGeneration).toBe(3);

  const session = executor(SESSION, 3, { [id(0x201)]: 5 });
  const stop = (reason: "emergency_stop" | "daily_rotation") =>
    seal({ sender: SUPERVISOR, recipient: SESSION, action: "session_stop", stop_generation: 4, run_generation: 5, body: { run_id: id(0x201), reason } });
  expect(await session.receive(stop("daily_rotation"))).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(await session.receive(stop("emergency_stop"))).toEqual({ ok: true, adopted: 4 });
});

test("정지 세대: 감독 쪽에서는 실행기가 보낸 더 높은 세대를 어떤 동작으로도 받아들이지 않는다", async () => {
  const report = seal({
    sender: DIAGNOSIS,
    recipient: SUPERVISOR,
    action: "status_report",
    stop_generation: 4,
    run_generation: 0,
    body: { in_reply_to: id(1), runs: [{ run_id: RUN_TASK, state: "running", run_generation: 2, last_receipt_id: null }] },
  });
  const ctx = contextOf(trusted, { now: NOW, expected_recipient: SUPERVISOR, stop_generation: 3, stop_sync_challenge: null, run_generations: { [RUN_TASK]: 2 }, spent_nonces: [] });
  expect(await verifyEnvelope(report, ctx)).toEqual({ ok: false, reason: "stop_generation_mismatch" });
});

const status = (runs: RunStatus[], action: "status_report" | "hello" = "status_report") =>
  action === "status_report"
    ? seal({ sender: DIAGNOSIS, recipient: SUPERVISOR, action, stop_generation: 3, run_generation: 0, body: { in_reply_to: id(1), runs } })
    : seal({ sender: DIAGNOSIS, recipient: SUPERVISOR, action, stop_generation: 3, run_generation: 0, body: { profile_revision: "p", policy_revision: "q", runs, unacked_ids: [] } });
const atSupervisor = (runs: Record<string, number>) =>
  contextOf(trusted, { now: NOW, expected_recipient: SUPERVISOR, stop_generation: 3, stop_sync_challenge: null, run_generations: runs, spent_nonces: [] });

test("실행 세대: 감독이 아는 실행의 옛 세대 상태는 hello·status_report 모두 거절한다", async () => {
  for (const action of ["status_report", "hello"] as const) {
    const message = status([{ run_id: RUN_TASK, state: "ready_result", run_generation: 2, last_receipt_id: null }], action);
    expect((await verifyEnvelope(message, atSupervisor({ [RUN_TASK]: 2 }))).ok, action).toBe(true);
    expect(await verifyEnvelope(message, atSupervisor({ [RUN_TASK]: 3 })), action).toEqual({ ok: false, reason: "run_generation_mismatch" });
  }
});

test("실행 세대: 장부에 없는 실행을 발견하고, 보고된 세대로 만든 취소가 실행기에서 통과한다", async () => {
  const orphan = id(0x1f1);
  const ledger: Record<string, number> = { [RUN_TASK]: 2 };
  const hello = status(
    [
      { run_id: RUN_TASK, state: "running", run_generation: 2, last_receipt_id: null },
      { run_id: orphan, state: "running", run_generation: 9, last_receipt_id: null },
    ],
    "hello",
  );
  const verified = await verifyEnvelope(hello, atSupervisor(ledger));
  if (!verified.ok || verified.action !== "hello") throw new Error(`hello가 거절됐다: ${JSON.stringify(verified)}`);
  const found = runsOutsideLedger(verified.body.runs, (runId) => ledger[runId]);
  expect(found).toEqual([{ run_id: orphan, run_generation: 9 }]);
  // 발견은 장부에 실행을 올리지 않는다(재개의 권한이 아니다).
  expect(ledger[orphan]).toBeUndefined();

  const worker = executor(DIAGNOSIS, 3, { [RUN_TASK]: 2, [orphan]: 9 });
  const close = seal({
    sender: SUPERVISOR,
    recipient: DIAGNOSIS,
    action: "task_cancel",
    stop_generation: 3,
    run_generation: found[0]!.run_generation,
    body: { run_id: orphan, reason: "requested" },
  });
  expect(await worker.receive(close)).toEqual({ ok: true, adopted: null });
  // 다른 세대로 만든 취소는 실행기가 거절한다.
  const wrong = seal({ sender: SUPERVISOR, recipient: DIAGNOSIS, action: "task_cancel", stop_generation: 3, run_generation: 8, body: { run_id: orphan, reason: "requested" } });
  expect(await worker.receive(wrong)).toEqual({ ok: false, reason: "run_generation_mismatch" });
});

test("실행 세대: not_known은 세대·영수증이 없을 때만, 같은 실행 ID는 한 번만, 그 밖의 상태는 세대가 있어야 한다", async () => {
  const ledger = atSupervisor({ [RUN_TASK]: 2 });
  const ok = status([{ run_id: RUN_TASK, state: "not_known", run_generation: null, last_receipt_id: null }]);
  expect((await verifyEnvelope(ok, ledger)).ok).toBe(true);
  const bad: RunStatus[][] = [
    [{ run_id: RUN_TASK, state: "not_known", run_generation: 2, last_receipt_id: null }],
    [{ run_id: RUN_TASK, state: "not_known", run_generation: null, last_receipt_id: id(5) }],
    [{ run_id: RUN_TASK, state: "running", run_generation: null, last_receipt_id: null }],
    [
      { run_id: RUN_TASK, state: "running", run_generation: 2, last_receipt_id: null },
      { run_id: RUN_TASK, state: "running", run_generation: 3, last_receipt_id: null },
    ],
  ];
  for (const runs of bad) expect(() => status(runs), JSON.stringify(runs)).toThrow("body_malformed");
});

test("작업 기한: 받는 시각 기준 직전은 통과, 정각과 직후는 deadline_passed(봉투 시한은 남아 있음)", async () => {
  const at = (deadline: number) =>
    seal({
      sender: SUPERVISOR,
      recipient: DIAGNOSIS,
      action: "task_start",
      stop_generation: 3,
      run_generation: 1,
      body: {
        run_id: RUN_NEW_TASK,
        role: "diagnosis",
        profile_revision: "diagnosis-r1",
        policy_revision: "policy-r1",
        snapshot_digest: hash("snapshot"),
        input_digest: hash("input"),
        deadline_at: deadline,
        budget_tokens: 1_000,
        credential,
      },
    });
  // 발급할 때는 deadline_at > issued_at만 본다. 셋 다 봉투를 만들 수 있다.
  const before = at(NOW + 1);
  const exact = at(NOW);
  const after = at(NOW - 1);
  expect(before.header.expires_at).toBeGreaterThan(NOW);
  expect((await executor(DIAGNOSIS, 3, {}).receive(before)).ok).toBe(true);
  expect(await executor(DIAGNOSIS, 3, {}).receive(exact)).toEqual({ ok: false, reason: "deadline_passed" });
  expect(await executor(DIAGNOSIS, 3, {}).receive(after)).toEqual({ ok: false, reason: "deadline_passed" });
  // 발급 시각 이하의 기한은 받을 때도 처음부터 잘못 만든 본문이다.
  expect(() => at(ISSUED)).toThrow("body_malformed");
});

// ---- 정지 세대 맞춤 ----

const syncReply = (recipient: string, stop: number, challenge: string, issued_at = ISSUED) =>
  seal({ sender: SUPERVISOR, recipient, action: "stop_sync_reply", stop_generation: stop, run_generation: 0, issued_at, body: { challenge } });
const helloAt = (stop: number) =>
  seal({ sender: DIAGNOSIS, recipient: SUPERVISOR, action: "hello", stop_generation: stop, run_generation: 0, body: { profile_revision: "p", policy_revision: "q", runs: [], unacked_ids: [] } });
// 서명된 봉투의 머리 일부나 본문을 바꾸고 digest를 맞춘 뒤 signer의 키로 다시 서명한다(계약 밖의 봉투를 만드는 시험 전용).
function forge(envelope: Envelope, change: { header?: Partial<Header>; body?: unknown }, signer: string): Envelope {
  const body = change.body ?? envelope.body;
  const header = { ...envelope.header, ...change.header, body_digest: digestOf(body) } as Header;
  return signUnchecked(header, body, keys[signer]!.privateKey);
}

test("정지 세대 맞춤: 쥔 실행이 없는 실행기가 정지 3→4 뒤 연결의 첫 단계에서 4를 받고, 그 뒤 세대 3의 효과는 거절한다", async () => {
  const worker = executor(DIAGNOSIS, 3, {});
  const sup = supervisor(3);
  // 정지 전에 서명돼 아직 날아오는 세대 3의 시작·갱신.
  const oldStart = taskStart(3);
  const oldRenew = renew(3);

  // 비상 정지: 감독이 4로 올라간다. 실행기는 닫을 실행이 없어 비상 종료로는 4를 받지 못한다.
  sup.state.stopGeneration = 4;
  expect(await worker.receive(cancel(4))).toEqual({ ok: false, reason: "unknown_run" });
  expect(worker.state.stopGeneration).toBe(3);

  // 풀기 뒤 다시 붙은 실행기: 옛 세대의 hello는 감독이, 감독의 세대 4 메시지는 실행기가 거절한다.
  expect(await sup.receive(helloAt(3))).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  const query = seal({ sender: SUPERVISOR, recipient: DIAGNOSIS, action: "status_query", stop_generation: 4, run_generation: 0, body: { run_ids: [RUN_TASK] } });
  expect(await worker.receive(query)).toEqual({ ok: false, reason: "stop_generation_mismatch" });

  // 맞춤: 실행기가 이 연결의 challenge로 묻고, 감독은 자기 세대 4로 답한다. 요청은 감독의 세대를 바꾸지 않는다.
  const request = await sup.receive(worker.requestSync(CHALLENGE));
  expect(request).toMatchObject({ ok: true, adopted: null, body: { challenge: CHALLENGE } });
  expect(sup.state.stopGeneration).toBe(4);
  expect(await worker.receive(syncReply(DIAGNOSIS, sup.state.stopGeneration!, CHALLENGE))).toEqual({ ok: true, adopted: 4 });
  expect(worker.state.stopGeneration).toBe(4);

  // 맞춘 세대로 hello가 통과한다.
  expect(await sup.receive(helloAt(4))).toMatchObject({ ok: true, adopted: null });

  // 세대 3의 시작·갱신은 서명과 시한이 맞아도 거절한다.
  expect(await worker.receive(oldStart)).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(await worker.receive(oldRenew)).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(worker.state.stopGeneration).toBe(4);
});

test("정지 세대 맞춤: 저장소를 잃은 실행기(세대 없음)는 맞춤 전에 모든 메시지를 거절하고, 답의 값을 0까지 그대로 받는다", async () => {
  const fresh = executor(DIAGNOSIS_NEW_STORAGE, null, {});
  const query = seal({ sender: SUPERVISOR, recipient: DIAGNOSIS_NEW_STORAGE, action: "status_query", stop_generation: 4, run_generation: 0, body: { run_ids: [RUN_TASK] } });
  expect(await fresh.receive(query)).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  fresh.requestSync(CHALLENGE);
  expect(await fresh.receive(syncReply(DIAGNOSIS_NEW_STORAGE, 4, CHALLENGE))).toEqual({ ok: true, adopted: 4 });
  expect(fresh.state.stopGeneration).toBe(4);

  // 한 번도 정지하지 않은 감독(0): 세대 없음과 0은 달라서, 0을 받아들였다는 값(0)이 나온다.
  const never = executor(DIAGNOSIS_NEW_STORAGE, null, {});
  never.requestSync(CHALLENGE);
  expect(await never.receive(syncReply(DIAGNOSIS_NEW_STORAGE, 0, CHALLENGE))).toEqual({ ok: true, adopted: 0 });
  expect(never.state.stopGeneration).toBe(0);
});

test("정지 세대 맞춤: 다른 연결의 답, 이미 쓴 답, 기다리지 않는 답은 challenge_mismatch다", async () => {
  const worker = executor(DIAGNOSIS, 3, {});
  worker.requestSync(CHALLENGE);
  const first = syncReply(DIAGNOSIS, 4, CHALLENGE);
  // 앞선 연결에서 OTHER_CHALLENGE로 받은 답이 이 연결에 다시 오면 거절한다.
  expect(await worker.receive(syncReply(DIAGNOSIS, 4, OTHER_CHALLENGE))).toEqual({ ok: false, reason: "challenge_mismatch" });
  expect(await worker.receive(first)).toEqual({ ok: true, adopted: 4 });
  // 받아들인 뒤 challenge를 버렸으므로 같은 답을 다시 보내도 거절한다.
  expect(await worker.receive(first)).toEqual({ ok: false, reason: "challenge_mismatch" });
  // 새 연결의 새 challenge 앞에서도 앞 연결의 답은 거절한다.
  worker.requestSync(OTHER_CHALLENGE.replace(/2$/, "3"));
  expect(await worker.receive(first)).toEqual({ ok: false, reason: "challenge_mismatch" });
  expect(worker.state.stopGeneration).toBe(4);
});

test("정지 세대 맞춤: 답의 수명은 15초다(직전 통과, 정각 expired, 받는 쪽 상한 + 1ms 수명은 lifetime_invalid)", async () => {
  expect(STOP_SYNC_TTL_MS).toBeLessThan(MESSAGE_TTL_MS);
  // 보내는 쪽이 maySend로 실을 수 있어야 한다.
  expect(STOP_SYNC_TTL_MS).toBeGreaterThan(DELIVERY_MAX_MS + CLOCK_SKEW_MS);
  const reply = syncReply(DIAGNOSIS, 4, CHALLENGE);
  expect(reply.header.expires_at - reply.header.issued_at).toBe(STOP_SYNC_TTL_MS);
  const at = async (now: number) => {
    const worker = executor(DIAGNOSIS, 3, {});
    worker.requestSync(CHALLENGE);
    return worker.receive(reply, now);
  };
  expect(await at(ISSUED + STOP_SYNC_TTL_MS - 1)).toEqual({ ok: true, adopted: 4 });
  expect(await at(ISSUED + STOP_SYNC_TTL_MS)).toEqual({ ok: false, reason: "expired" });
  // 거절 사례는 받는 쪽 상한으로 만든다. 발급 기본값(STOP_SYNC_TTL_MS)을 낮춰도 이 봉투는 상한을 넘는다.
  const listen = () => {
    const worker = executor(DIAGNOSIS, 3, {});
    worker.requestSync(CHALLENGE);
    return worker;
  };
  const atMax = forge(reply, { header: { expires_at: ISSUED + STOP_SYNC_TTL_MAX_MS } }, SUPERVISOR);
  expect(await listen().receive(atMax)).toEqual({ ok: true, adopted: 4 });
  const long = forge(reply, { header: { expires_at: ISSUED + STOP_SYNC_TTL_MAX_MS + 1 } }, SUPERVISOR);
  expect(await listen().receive(long)).toEqual({ ok: false, reason: "lifetime_invalid" });
});

test("정지 세대 맞춤: 기다리는 기한은 요청 전달 + 감독 처리 + 답 전달을 덮고, 수명 상한은 내는 쪽 기본값보다 작지 않다", () => {
  // 시한은 모두 정각부터 거절하므로 전달 상한과 처리 상한은 "그 값 미만"이다. 그러면 왕복은 2 * 전달 + 처리 미만이다.
  // 받는 쪽은 실제 전달 지연을 재지 않는다. maySend는 싣는 순간 남은 수명만 보므로, 전달 상한은 운영의 가정이다.
  expect(STOP_SYNC_WAIT_MS).toBeGreaterThanOrEqual(2 * DELIVERY_MAX_MS + STOP_SYNC_ANSWER_MAX_MS);
  expect(STOP_SYNC_WAIT_MS).toBe(25_000);
  expect(STOP_SYNC_TTL_MAX_MS).toBe(15_000);
  expect(MESSAGE_TTL_MAX_MS).toBe(30_000);
  expect(STOP_SYNC_TTL_MS).toBeLessThanOrEqual(STOP_SYNC_TTL_MAX_MS);
  expect(MESSAGE_TTL_MS).toBeLessThanOrEqual(MESSAGE_TTL_MAX_MS);
  for (const [action, spec] of Object.entries(ACTION_SPECS)) {
    expect(spec.lifetimeMs ?? MESSAGE_TTL_MS, action).toBeLessThanOrEqual(spec.maxLifetimeMs ?? MESSAGE_TTL_MAX_MS);
  }
});

test("정지 세대 맞춤: 요청 8초, 답 8초가 걸린 왕복은 맞춘다(답의 신선도와 기다리는 기한을 따로 잰다)", async () => {
  const sent = ISSUED;
  const worker = executor(DIAGNOSIS, 3, {});
  const sup = supervisor(4);
  const request = worker.requestSync(CHALLENGE, sent);
  expect(maySend(request.header, sent)).toEqual({ ok: true });
  expect(await sup.receive(request, sent + 8_000)).toMatchObject({ ok: true, adopted: null });
  const reply = syncReply(DIAGNOSIS, 4, CHALLENGE, sent + 8_000);
  expect(maySend(reply.header, sent + 8_000)).toEqual({ ok: true });
  expect(await worker.receive(reply, sent + 16_000)).toEqual({ ok: true, adopted: 4 });
  expect(worker.state.challenge).toBeNull();
});

test("정지 세대 맞춤: 세 상한 미만의 가장 느린 왕복은 맞추고, 세 상한에 정각으로 걸린 왕복(10초 + 5초 + 10초)은 계약상 거절이다", async () => {
  const sent = ISSUED;
  // 요청 전달 d1, 감독 처리 a, 답 전달 d2를 거친 왕복. 감독이 받는 것과 maySend가 싣게 하는 것도 함께 확인한다.
  const roundTrip = async (d1: number, a: number, d2: number) => {
    const worker = executor(DIAGNOSIS, 3, {});
    const request = worker.requestSync(CHALLENGE, sent);
    expect(maySend(request.header, sent)).toEqual({ ok: true });
    expect(await supervisor(4).receive(request, sent + d1)).toMatchObject({ ok: true, adopted: null });
    const answered = sent + d1 + a;
    const reply = syncReply(DIAGNOSIS, 4, CHALLENGE, answered);
    expect(maySend(reply.header, answered)).toEqual({ ok: true });
    const arrived = answered + d2;
    // 거절이 답의 신선도 때문이 아니라 기다리는 기한 때문임을 보이려고, 답 봉투의 수명이 남아 있음을 확인한다.
    expect(reply.header.expires_at).toBeGreaterThan(arrived);
    return worker.receive(reply, arrived);
  };
  expect(await roundTrip(DELIVERY_MAX_MS - 1, STOP_SYNC_ANSWER_MAX_MS - 1, DELIVERY_MAX_MS - 1)).toEqual({ ok: true, adopted: 4 });
  // 두 전달과 처리가 모두 상한 정각이면 왕복은 STOP_SYNC_WAIT_MS 정각이고, 상한("미만")을 넘은 것이라 거절한다.
  expect(DELIVERY_MAX_MS + STOP_SYNC_ANSWER_MAX_MS + DELIVERY_MAX_MS).toBe(STOP_SYNC_WAIT_MS);
  expect(await roundTrip(DELIVERY_MAX_MS, STOP_SYNC_ANSWER_MAX_MS, DELIVERY_MAX_MS)).toEqual({ ok: false, reason: "challenge_mismatch" });
  // 셋 중 하나만 정각이어도 왕복은 기한 안이다(남은 둘이 상한 미만이므로).
  expect(await roundTrip(DELIVERY_MAX_MS, STOP_SYNC_ANSWER_MAX_MS - 1, DELIVERY_MAX_MS - 1)).toEqual({ ok: true, adopted: 4 });

  // 같은 규칙이 일반 봉투에도 있다: maySend가 싣게 하는 마지막 순간(남은 수명 = 전달 상한)에 실은 봉투는
  // 전달이 상한 미만이면 받고, 상한 정각이면 expires_at 정각이라 expired다.
  const request = executor(DIAGNOSIS, 3, {}).requestSync(CHALLENGE, sent);
  const lastSend = request.header.expires_at - DELIVERY_MAX_MS;
  expect(maySend(request.header, lastSend)).toEqual({ ok: true });
  expect(await supervisor(4).receive(request, lastSend + DELIVERY_MAX_MS - 1)).toMatchObject({ ok: true });
  expect(await supervisor(4).receive(request, lastSend + DELIVERY_MAX_MS)).toEqual({ ok: false, reason: "expired" });
});

test("정지 세대 맞춤: 기다리는 요청의 sentAt이 없거나 정수가 아니거나 미래이거나 아주 옛 시각이면 challenge_mismatch이고 세대는 그대로다", async () => {
  // 나머지(감독 서명, 받는 쪽, 답의 신선도, challenge, nonce)는 모두 맞는 답이다. sentAt만 바꾼다.
  const now = NOW;
  const reply = syncReply(DIAGNOSIS, 4, CHALLENGE, now - 1_000);
  const withPending = async (pending: unknown) => {
    const worker = executor(DIAGNOSIS, 3, {});
    worker.requestSync(CHALLENGE, now - 1_000);
    worker.state.challenge = pending as typeof worker.state.challenge;
    const result = await worker.receive(reply, now);
    return { result, stopGeneration: worker.state.stopGeneration };
  };
  const rejected = { result: { ok: false, reason: "challenge_mismatch" }, stopGeneration: 3 } as const;
  // 대조군: 같은 답이 올바른 sentAt이면 받는다(경과 0도 받는다).
  expect(await withPending({ challenge: CHALLENGE, sent_at: now - 1_000 })).toEqual({ result: { ok: true, adopted: 4 }, stopGeneration: 4 });
  expect(await withPending({ challenge: CHALLENGE, sent_at: now })).toEqual({ result: { ok: true, adopted: 4 }, stopGeneration: 4 });
  // 대기 객체 전체 없음.
  expect(await withPending(null)).toEqual(rejected);
  // sentAt 없음(덧셈이면 NaN이 되어 기한 비교가 거짓이 되는 자리).
  expect(await withPending({ challenge: CHALLENGE })).toEqual(rejected);
  // 미래 시각(로컬 시계가 뒤로 감), 1ms 앞.
  expect(await withPending({ challenge: CHALLENGE, sent_at: now + 1 })).toEqual(rejected);
  // 아주 옛 시각.
  expect(await withPending({ challenge: CHALLENGE, sent_at: 0 })).toEqual(rejected);
  expect(await withPending({ challenge: CHALLENGE, sent_at: Number.MIN_SAFE_INTEGER })).toEqual(rejected);
  // 정수가 아닌 값: 소수, NaN, 무한, 안전 정수 밖, 숫자가 아닌 값.
  for (const sentAt of [now - 1_000.5, Number.NaN, Number.NEGATIVE_INFINITY, -(2 ** 53), String(now - 1_000), null]) {
    expect(await withPending({ challenge: CHALLENGE, sent_at: sentAt }), String(sentAt)).toEqual(rejected);
  }
});

test("정지 세대 맞춤: 기다리는 기한 직전은 받고 정각은 challenge_mismatch, 답의 15초 신선도는 따로 expired다", async () => {
  const sent = ISSUED;
  // 기한 근처에서도 신선한 답(발급 10초 뒤에 받음).
  const fresh = syncReply(DIAGNOSIS, 4, CHALLENGE, sent + STOP_SYNC_WAIT_MS - 10_000);
  const at = (now: number) => {
    const worker = executor(DIAGNOSIS, 3, {});
    worker.requestSync(CHALLENGE, sent);
    return worker.receive(fresh, now);
  };
  expect(await at(sent + STOP_SYNC_WAIT_MS - 1)).toEqual({ ok: true, adopted: 4 });
  expect(await at(sent + STOP_SYNC_WAIT_MS)).toEqual({ ok: false, reason: "challenge_mismatch" });
  expect(await at(sent + STOP_SYNC_WAIT_MS + 1)).toEqual({ ok: false, reason: "challenge_mismatch" });

  // 기한 안이어도 발급부터 15초가 지난 답은 expired다.
  const early = syncReply(DIAGNOSIS, 4, CHALLENGE, sent + 1_000);
  const worker = executor(DIAGNOSIS, 3, {});
  worker.requestSync(CHALLENGE, sent);
  expect(sent + 1_000 + STOP_SYNC_TTL_MS).toBeLessThan(sent + STOP_SYNC_WAIT_MS);
  expect(await worker.receive(early, sent + 1_000 + STOP_SYNC_TTL_MS)).toEqual({ ok: false, reason: "expired" });
  expect(worker.state.stopGeneration).toBe(3);
});

test("정지 세대 맞춤: 기다리는 기한 안에서도 다른 연결·앞선 challenge의 답과 연결이 끝난 뒤의 답은 받지 않는다", async () => {
  const sent = ISSUED;
  const inWindow = sent + STOP_SYNC_WAIT_MS - 5_000;
  const reply = (challenge: string) => syncReply(DIAGNOSIS, 4, challenge, inWindow - 1_000);
  // 다른 연결의 challenge.
  const worker = executor(DIAGNOSIS, 3, {});
  worker.requestSync(CHALLENGE, sent);
  expect(await worker.receive(reply(OTHER_CHALLENGE), inWindow)).toEqual({ ok: false, reason: "challenge_mismatch" });
  // 연결이 끝나 challenge를 버렸으면 맞는 challenge의 답도 받지 않는다.
  worker.disconnect();
  expect(await worker.receive(reply(CHALLENGE), inWindow)).toEqual({ ok: false, reason: "challenge_mismatch" });
  // 새 연결의 새 challenge 앞에서, 앞선 연결의 challenge 답은 앞선 요청의 기한 안이어도 받지 않는다.
  worker.requestSync(OTHER_CHALLENGE, sent + 1_000);
  expect(await worker.receive(reply(CHALLENGE), inWindow)).toEqual({ ok: false, reason: "challenge_mismatch" });
  expect(worker.state.stopGeneration).toBe(3);
  expect(await worker.receive(reply(OTHER_CHALLENGE), inWindow)).toEqual({ ok: true, adopted: 4 });
});

test("정지 세대 맞춤: 발급 함수는 요청의 머리 정지 세대 0과 두 메시지의 실행 세대 0을 고정하고, 받는 쪽도 따로 거절한다", async () => {
  const request = (stop: number, run: number) =>
    seal({ sender: DIAGNOSIS, recipient: SUPERVISOR, action: "stop_sync_request", stop_generation: stop, run_generation: run, body: { challenge: CHALLENGE } });
  const reply = (stop: number, run: number) =>
    seal({ sender: SUPERVISOR, recipient: DIAGNOSIS, action: "stop_sync_reply", stop_generation: stop, run_generation: run, body: { challenge: CHALLENGE } });
  // 정상 생성: 요청은 0/0, 답의 정지 세대는 감독의 지금 세대(0이 아니어도 된다).
  expect(request(0, 0).header).toMatchObject({ stop_generation: 0, run_generation: 0 });
  expect(reply(4, 0).header).toMatchObject({ stop_generation: 4, run_generation: 0 });
  // 잘못된 생성: 보관한 세대(3)를 요청 머리에 채우거나 실행 세대를 실으면 서명 전에 거절한다.
  expect(() => request(3, 0)).toThrow("stop_generation_mismatch");
  expect(() => request(0, 1)).toThrow("run_generation_mismatch");
  expect(() => reply(4, 1)).toThrow("run_generation_mismatch");
  // 받는 쪽: 같은 봉투를 검사 없이 서명해 보내도 감독·실행기가 같은 사유로 거절한다.
  const valid = request(0, 0);
  expect(await supervisor(4).receive(forge(valid, { header: { stop_generation: 3 } }, DIAGNOSIS))).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(await supervisor(4).receive(forge(valid, { header: { run_generation: 1 } }, DIAGNOSIS))).toEqual({ ok: false, reason: "run_generation_mismatch" });
  const worker = executor(DIAGNOSIS, 3, {});
  worker.requestSync(CHALLENGE);
  expect(await worker.receive(forge(reply(4, 0), { header: { run_generation: 1 } }, SUPERVISOR))).toEqual({ ok: false, reason: "run_generation_mismatch" });
  expect(worker.state.stopGeneration).toBe(3);
});

test("정지 세대 맞춤: 다른 실행기에게 준 답과 감독이 아닌 키로 서명한 답은 거절한다", async () => {
  const listen = () => {
    const worker = executor(DIAGNOSIS, 3, {});
    worker.requestSync(CHALLENGE);
    return worker;
  };
  // 같은 인스턴스의 옛(다른) 저장소 앞으로 낸 답, 다른 역할의 실행기 앞으로 낸 답.
  expect(await listen().receive(syncReply(DIAGNOSIS_NEW_STORAGE, 4, CHALLENGE))).toEqual({ ok: false, reason: "wrong_recipient" });
  const reply = syncReply(DIAGNOSIS, 4, CHALLENGE);
  const toSession = forge(reply, { header: { recipient: SESSION } }, SUPERVISOR);
  expect(await listen().receive(toSession)).toEqual({ ok: false, reason: "wrong_recipient" });
  // 감독 이름에 실행기 키, 실행기·현관 이름에 그 주체의 키.
  expect(await listen().receive(forge(reply, {}, DIAGNOSIS))).toEqual({ ok: false, reason: "bad_signature" });
  expect(await listen().receive(forge(reply, { header: { sender: SESSION } }, SESSION))).toEqual({ ok: false, reason: "wrong_direction" });
  expect(await listen().receive(forge(reply, { header: { sender: FRONT_DOOR } }, FRONT_DOOR))).toEqual({ ok: false, reason: "wrong_direction" });
});

test("정지 세대 맞춤: 받는 쪽보다 낮은 답은 거절하고(세대는 내려가지 않음), 같은 답은 그대로 둔다", async () => {
  const worker = executor(DIAGNOSIS, 5, {});
  worker.requestSync(CHALLENGE);
  expect(await worker.receive(syncReply(DIAGNOSIS, 4, CHALLENGE))).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(worker.state.stopGeneration).toBe(5);
  expect(await worker.receive(syncReply(DIAGNOSIS, 5, CHALLENGE))).toEqual({ ok: true, adopted: null });
  expect(worker.state.stopGeneration).toBe(5);
});

test("정지 세대 맞춤: 실행기의 요청은 감독의 세대를 바꾸지 않고, 세대를 실은 요청과 복원 전 감독은 거절한다", async () => {
  const sup = supervisor(4);
  const worker = executor(DIAGNOSIS, 3, {});
  const request = worker.requestSync(CHALLENGE);
  expect(request.header.stop_generation).toBe(0);
  expect(await sup.receive(request)).toMatchObject({ ok: true, adopted: null });
  // 머리에 감독보다 높은 세대를 실은 요청, 본문에 세대를 실은 요청.
  expect(await sup.receive(forge(request, { header: { stop_generation: 99, nonce: "f".repeat(32) } }, DIAGNOSIS))).toEqual({
    ok: false,
    reason: "stop_generation_mismatch",
  });
  expect(await sup.receive(forge(request, { header: { nonce: "e".repeat(32) }, body: { challenge: CHALLENGE, stop_generation: 99 } }, DIAGNOSIS))).toEqual({
    ok: false,
    reason: "unknown_field",
  });
  // 어떤 동작도 실행기에서 감독으로 더 높은 세대를 옮기지 않는다(hello에 99).
  expect(await sup.receive(helloAt(99))).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(sup.state.stopGeneration).toBe(4);
  // 정지 기록을 복원하기 전(세대 없음)의 감독은 요청부터 받지 않아 답을 만들 길이 없다.
  expect(await supervisor(null).receive(worker.requestSync(OTHER_CHALLENGE))).toEqual({ ok: false, reason: "stop_generation_mismatch" });
});

test("정지 세대 맞춤: 실행을 지목하거나 자격·명령을 싣는 맞춤 메시지는 거절하고, 맞춤은 지시가 아니다", async () => {
  const reply = syncReply(DIAGNOSIS, 4, CHALLENGE);
  const cases: [Record<string, unknown>, RejectReason][] = [
    [{ challenge: CHALLENGE, run_id: RUN_TASK }, "unknown_field"],
    [{ challenge: CHALLENGE, credential }, "unknown_field"],
    [{ challenge: CHALLENGE, command: "x" }, "forbidden_field"],
  ];
  for (const [body, reason] of cases) {
    const worker = executor(DIAGNOSIS, 3, { [RUN_TASK]: 2 });
    worker.requestSync(CHALLENGE);
    expect(await worker.receive(forge(reply, { body }, SUPERVISOR)), JSON.stringify(body)).toEqual({ ok: false, reason });
    expect(worker.state.stopGeneration).toBe(3);
  }
  // 실행에 묶이지 않는다: 머리의 run_generation은 0이어야 한다.
  const worker = executor(DIAGNOSIS, 3, { [RUN_TASK]: 2 });
  worker.requestSync(CHALLENGE);
  expect(await worker.receive(forge(reply, { header: { run_generation: 2 } }, SUPERVISOR))).toEqual({ ok: false, reason: "run_generation_mismatch" });
  for (const action of ["stop_sync_request", "stop_sync_reply"] as const) {
    expect(ACTION_SPECS[action].class).toBe("transport");
    expect((INSTRUCTIONS as readonly string[]).includes(action)).toBe(false);
    expect(STARTS_RUN.includes(action)).toBe(false);
  }
});
