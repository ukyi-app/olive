// 세대와 받는 시각의 순서 시험: 비상 정지의 새 정지 세대, 재접속 상태의 실행 세대, 받을 때 이미 지난 작업 기한.
import { expect, test } from "bun:test";
import { rawPublicKey, sealEnvelope, type SealInput, verifyEnvelope } from "../../src/contract/v1/envelope.ts";
import type { Action } from "../../src/contract/v1/header.ts";
import { runsOutsideLedger, type RunStatus } from "../../src/contract/v1/transport.ts";
import { DIAGNOSIS, freshKeys, hash, id, ISSUED, NOW, RUN_NEW_TASK, RUN_TASK, SESSION, SUPERVISOR } from "./cases.ts";
import { contextOf, MemoryNonces } from "./support.ts";

const keys = freshKeys();
const trusted = Object.fromEntries(Object.entries(keys).map(([name, pair]) => [name, rawPublicKey(pair.publicKey)]));
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
function executor(recipient: string, stopGeneration: number, runs: Record<string, number>) {
  const state = { stopGeneration, runs: { ...runs } };
  const nonces = new MemoryNonces();
  return {
    state,
    async receive(message: unknown, now = NOW) {
      const ctx = contextOf(trusted, { now, expected_recipient: recipient, stop_generation: state.stopGeneration, run_generations: state.runs, spent_nonces: [] }, nonces);
      const result = await verifyEnvelope(message, ctx);
      if (result.ok && result.adoptedStopGeneration !== null) state.stopGeneration = result.adoptedStopGeneration;
      return result.ok ? { ok: true as const, adopted: result.adoptedStopGeneration } : { ok: false as const, reason: result.reason };
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
  const ctx = contextOf(trusted, { now: NOW, expected_recipient: SUPERVISOR, stop_generation: 3, run_generations: { [RUN_TASK]: 2 }, spent_nonces: [] });
  expect(await verifyEnvelope(report, ctx)).toEqual({ ok: false, reason: "stop_generation_mismatch" });
});

const status = (runs: RunStatus[], action: "status_report" | "hello" = "status_report") =>
  action === "status_report"
    ? seal({ sender: DIAGNOSIS, recipient: SUPERVISOR, action, stop_generation: 3, run_generation: 0, body: { in_reply_to: id(1), runs } })
    : seal({ sender: DIAGNOSIS, recipient: SUPERVISOR, action, stop_generation: 3, run_generation: 0, body: { profile_revision: "p", policy_revision: "q", runs, unacked_ids: [] } });
const atSupervisor = (runs: Record<string, number>) =>
  contextOf(trusted, { now: NOW, expected_recipient: SUPERVISOR, stop_generation: 3, run_generations: runs, spent_nonces: [] });

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
