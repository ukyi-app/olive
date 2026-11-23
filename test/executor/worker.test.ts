// 작업자 실행기의 지시 처리 시험. 역할 프로그램은 실제로 띄우고(test/executor/fake-role.ts), 남은 프로세스 판정은 가짜 정리가 정한다.
// 실제 PID 공간 정리(kill(-1))는 containment.test.ts가 bwrap 안에서만 본다.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { digestOf, executorName, limits, verifyEnvelope } from "../../src/contract/v1/index.ts";
import { signUnchecked } from "../../src/contract/v1/envelope.ts";
import { ExecutorStore } from "../../src/executor/store.ts";
import {
  credentialValue,
  FakeTransport,
  fromSupervisor,
  reconnect,
  rig,
  type Rig,
  sha256,
  start,
  supervisorKeys,
  syncReply,
  taskStartBody,
  until,
} from "./support.ts";

const rigs: Rig[] = [];
async function make(options: Parameters<typeof rig>[0] = {}) {
  const r = await rig(options);
  rigs.push(r);
  return r;
}
// 시험이 띄운 프로세스는 기록한 pid로만 끝낸다.
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.cleanup.terminate();
    await r.worker.idle();
  }
});

const receipts = (r: Rig) => r.transport.sent.filter((e) => e.header.action.startsWith("receipt_") || e.header.action === "report_result");
const stateOf = (r: Rig, runId: string) => r.store.run(runId)?.state;

test("시작: 정상 실행은 접수 → 시작 → 종료 확인(남은 0) → 결과 보고 순서로 영수증을 낸다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  expect(r.transport.actions()).toEqual(["stop_sync_request", "hello", "receipt_accepted", "receipt_started", "receipt_stopped", "report_result"]);
  const stopped = r.transport.of("receipt_stopped")[0]!;
  expect(stopped.body).toMatchObject({ run_id: runId, remaining_processes: 0, exit: "completed" });
  expect(r.transport.of("report_result")[0]!.body.result).toMatchObject({ role: "diagnosis", outcome: "completed" });
  expect(stateOf(r, runId)).toBe("ready_result");
  expect(r.cleanup.survivorChecks).toBeGreaterThan(0);
});

test("시작: 결과가 계약의 모양이 아니면 실패 결과로 보고하고, 0이 아닌 종료는 failed_stopped다", async () => {
  const garbage = await make({ mode: "garbage" });
  await start(garbage);
  await garbage.worker.idle();
  expect(garbage.transport.of("report_result")[0]!.body.result).toMatchObject({ outcome: "failed", items: [], refs: [] });
  const failed = await make({ mode: "fail" });
  const { runId } = await start(failed);
  await failed.worker.idle();
  expect(failed.transport.of("receipt_stopped")[0]!.body.exit).toBe("failed");
  expect(failed.transport.of("report_result")).toHaveLength(0);
  expect(stateOf(failed, runId)).toBe("failed_stopped");
});

test("지시: 서명이 맞아도 옛 정지 세대·옛 실행 세대면 실행 0", async () => {
  const r = await make({ syncTo: 3 });
  // 옛 정지 세대(2)의 시작. 서명이 맞는 세대 불일치라 그 연결도 닫는다(새 연결에서 다시 맞춘다).
  await start(r, { stop: 2 });
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(0);
  expect(receipts(r)).toHaveLength(0);
  expect(r.transport.closed).toBe(true);
  await reconnect(r, 3);
  // 실행 세대 2로 연 실행에 옛 실행 세대(1)의 시작·취소가 와도 아무 일도 없다.
  const runId = randomUUID();
  const value = credentialValue();
  r.credentials.values.set(runId, value);
  const body = taskStartBody(r, runId, sha256(value));
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "task_start", body, { stop_generation: 3, run_generation: 2 }));
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(1);
  const before = r.transport.sent.length;
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "task_start", body, { stop_generation: 3, run_generation: 1 }));
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "task_cancel", { run_id: runId, reason: "requested" }, { stop_generation: 3, run_generation: 1 }));
  await r.worker.idle();
  expect(r.transport.sent.length).toBe(before);
  expect(r.launcher.spawned).toBe(1);
  // 같은 봉투를 검증기에 넣으면 사유가 실행 세대다.
  const old = fromSupervisor(r.clock, r.worker.name, "task_start", body, { stop_generation: 3, run_generation: 1 });
  expect(await verifyEnvelope(old, r.worker.verifyContext(null))).toEqual({ ok: false, reason: "run_generation_mismatch" });
});

test("지시: 받는 쪽 이름(역할·인스턴스·저장소 ID)이 다르면 실행 0", async () => {
  const r = await make();
  const storage = r.store.storageId;
  for (const recipient of [
    executorName("code_author", "worker-1", storage),
    executorName("diagnosis", "worker-2", storage),
    executorName("diagnosis", "worker-1", "other-storage"),
  ]) {
    const runId = randomUUID();
    const value = credentialValue();
    r.credentials.values.set(runId, value);
    // 다른 역할 앞의 시작은 그 역할을 싣는다(아니면 봉투를 만들 수 없다).
    const role = recipient.split("/")[1] as "diagnosis" | "code_author";
    const envelope = fromSupervisor(r.clock, recipient, "task_start", taskStartBody(r, runId, sha256(value), { role }), { stop_generation: 0, run_generation: 1 });
    expect(await verifyEnvelope(envelope, r.worker.verifyContext(null))).toEqual({ ok: false, reason: "wrong_recipient" });
    await r.connection.receive(envelope);
  }
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(0);
  expect(r.credentials.calls).toHaveLength(0);
  expect(receipts(r)).toHaveLength(0);
});

test("지시: nonce를 다시 쓰면 실행 0(재시작 뒤에도)", async () => {
  const r = await make();
  const { envelope } = await start(r);
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(1);
  // 같은 연결에서 다시.
  expect(await verifyEnvelope(envelope, r.worker.verifyContext(null))).toEqual({ ok: false, reason: "replayed" });
  // 같은 폴더로 다시 뜬 실행기. nonce 기록이 없었다면 아는 실행이라 접수 영수증을 다시 보냈을 것이다.
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.storageId).toBe(r.store.storageId);
  expect(await verifyEnvelope(envelope, again.worker.verifyContext(null))).toEqual({ ok: false, reason: "replayed" });
  // 맞춘 뒤 받음 확인이 없던 영수증은 이미 다시 보냈다. 그 뒤로 이 봉투가 낳는 것이 없어야 한다.
  const before = again.transport.sent.length;
  await again.connection.receive(envelope);
  await again.worker.idle();
  expect(again.transport.sent.length).toBe(before);
  expect(again.launcher.spawned).toBe(0);
});

test("지시: 시한 지난 지시는 실행 0", async () => {
  const r = await make();
  const runId = randomUUID();
  const value = credentialValue();
  r.credentials.values.set(runId, value);
  const envelope = fromSupervisor(r.clock, r.worker.name, "task_start", taskStartBody(r, runId, sha256(value)), { stop_generation: 0, run_generation: 1 });
  r.clock.advance(limits.MESSAGE_TTL_MS);
  expect(await verifyEnvelope(envelope, r.worker.verifyContext(null))).toEqual({ ok: false, reason: "expired" });
  await r.connection.receive(envelope);
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(0);
  expect(receipts(r)).toHaveLength(0);
});

test("지시: 명령·argv·환경 칸이 실린 시작은 계약이 forbidden_field로 거절하고 실행 0", async () => {
  const r = await make();
  for (const extra of [{ argv: ["/bin/sh"] }, { env: { X: "1" } }, { command: "/bin/sh" }, { image: "x" }]) {
    const runId = randomUUID();
    const body = { ...taskStartBody(r, runId, sha256("x")), ...extra };
    const header = {
      contract: "olive-control/v1",
      sender: "supervisor",
      recipient: r.worker.name,
      action: "task_start",
      request_id: randomUUID(),
      stop_generation: 0,
      run_generation: 1,
      body_digest: digestOf(body),
      issued_at: r.clock.now(),
      expires_at: r.clock.now() + 30_000,
      nonce: randomUUID().replaceAll("-", ""),
    } as const;
    const envelope = signUnchecked(header, body, supervisorKeys.privateKey);
    expect(await verifyEnvelope(envelope, r.worker.verifyContext(null))).toEqual({ ok: false, reason: "forbidden_field" });
    await r.connection.receive(envelope);
  }
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(0);
});

test("지시: 세션 지시(session_start·session_stop)는 작업자 실행기에서 계약이 wrong_direction으로 거절하고 아무 일도 없다", async () => {
  const r = await make();
  const runId = randomUUID();
  const bodies = {
    session_start: {
      run_id: runId,
      generation_marker_digest: sha256("marker"),
      takeover_receipt_id: null,
      rule_check_id: randomUUID(),
      profile_revision: "diagnosis-r1",
      policy_revision: "policy-r1",
      handoff_digest: null,
      credential: { account: "main", method: "subscription", revision: "cred-1", digest: sha256("x") },
    },
    session_stop: { run_id: runId, reason: "emergency_stop" },
  } as const;
  for (const [action, body] of Object.entries(bodies)) {
    const header = {
      contract: "olive-control/v1",
      sender: "supervisor",
      recipient: r.worker.name,
      action: action as "session_start" | "session_stop",
      request_id: randomUUID(),
      stop_generation: action === "session_stop" ? 5 : 0,
      run_generation: 1,
      body_digest: digestOf(body),
      issued_at: r.clock.now(),
      expires_at: r.clock.now() + 30_000,
      nonce: randomUUID().replaceAll("-", ""),
    } as const;
    const envelope = signUnchecked(header, body, supervisorKeys.privateKey);
    expect(await verifyEnvelope(envelope, r.worker.verifyContext(null)), action).toEqual({ ok: false, reason: "wrong_direction" });
    await r.connection.receive(envelope);
  }
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(0);
  expect(r.store.stopGeneration()).toBe(0);
  expect(r.store.runs()).toHaveLength(0);
});

test("시작: 띄우기 직전에 기한이 지났거나 정지 세대가 올랐으면 띄우지 않는다", async () => {
  // 준비(자격 받기) 사이에 기한이 지난다.
  const late = await make();
  late.credentials.before = () => late.clock.advance(2_000);
  const { runId } = await start(late, { body: { deadline_at: late.clock.now() + 1_000 } });
  await late.worker.idle();
  expect(late.launcher.spawned).toBe(0);
  expect(stateOf(late, runId)).toBe("not_started");
  expect(late.transport.of("receipt_stopped")[0]!.body.exit).toBe("deadline");
  expect(late.transport.of("receipt_started")).toHaveLength(0);

  // 준비 사이에 새 연결이 더 높은 정지 세대로 맞춘다.
  const raised = await make();
  raised.credentials.before = () => reconnect(raised, 1);
  const second = await start(raised);
  await raised.worker.idle();
  expect(raised.launcher.spawned).toBe(0);
  expect(stateOf(raised, second.runId)).toBe("not_started");
  expect(raised.store.durableStopGeneration()).toBe(1);
});

test("시작: 자격 digest가 값과 다르면 띄우지 않는다(정확한 바이트로 대조)", async () => {
  const r = await make();
  const value = credentialValue();
  // 줄바꿈 하나가 더 붙은 값의 digest.
  const { runId } = await start(r, { value, digest: sha256(Buffer.concat([value, Buffer.from("\n")])) });
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(0);
  expect(stateOf(r, runId)).toBe("not_started");
  // 자격 값이 영수증 어디에도 없다.
  const text = new TextDecoder().decode(value);
  expect(JSON.stringify(r.transport.sent)).not.toContain(text);
});

test("자격: 받은 값의 배열은 대조·변환 뒤 띄우든 띄우지 않든 0으로 채우고, 실행이 끝나면 자격의 출처에 그 실행을 잊게 한다", async () => {
  const zeroed = (value: Uint8Array) => value.every((byte) => byte === 0);
  // 띄운 실행.
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(1);
  expect(r.credentials.handed.map(zeroed)).toEqual([true]);
  expect(r.credentials.forgotten).toEqual([runId]);

  // 지문이 달라 띄우지 않은 실행.
  const mismatch = await make();
  const value = credentialValue();
  const bad = await start(mismatch, { value, digest: sha256("다른 값") });
  await mismatch.worker.idle();
  expect(mismatch.launcher.spawned).toBe(0);
  expect(mismatch.credentials.handed.map(zeroed)).toEqual([true]);
  expect(mismatch.credentials.forgotten).toEqual([bad.runId]);

  // 받은 직후 연결이 끊겨 대조 전에 멈춘 실행.
  const lost = await make();
  lost.credentials.before = () => lost.connection.close();
  const dropped = await start(lost);
  await lost.worker.idle();
  expect(lost.launcher.spawned).toBe(0);
  expect(lost.credentials.handed.map(zeroed)).toEqual([true]);
  expect(lost.credentials.forgotten).toEqual([dropped.runId]);
});

test("시작: 연결이 없거나 맞춤 전이면 새 실행 0·새 자격 0", async () => {
  // 맞춤 전: 시작 지시를 검증하지도 처리하지도 않는다.
  const unsynced = await make({ syncTo: null });
  await start(unsynced);
  await unsynced.worker.idle();
  expect(unsynced.credentials.calls).toHaveLength(0);
  expect(unsynced.launcher.spawned).toBe(0);
  expect(unsynced.store.runs()).toHaveLength(0);

  // 준비 중 연결이 끊긴다: 자격을 받지 않는다.
  const dropped = await make();
  dropped.space.before = () => dropped.connection.close();
  const first = await start(dropped);
  await dropped.worker.idle();
  expect(dropped.credentials.calls).toHaveLength(0);
  expect(dropped.launcher.spawned).toBe(0);
  expect(stateOf(dropped, first.runId)).toBe("not_started");

  // 자격을 받는 사이에 끊긴다: 띄우지 않는다.
  const lost = await make();
  lost.credentials.before = () => lost.connection.close();
  const second = await start(lost);
  await lost.worker.idle();
  expect(lost.launcher.spawned).toBe(0);
  expect(stateOf(lost, second.runId)).toBe("not_started");
});

test("환경: 띄운 프로그램이 받는 환경은 허용 목록뿐이고 자격은 그 이름 하나에만 있다", async () => {
  process.env.OLIVE_PARENT_ONLY = "parent-value";
  try {
    const r = await make({ mode: "print-env" });
    const { value } = await start(r);
    await r.worker.idle();
    expect(r.launcher.spawned).toBe(1);
    const received = JSON.parse(readFileSync(join(r.cwd, "received-env.json"), "utf8")) as Record<string, string>;
    const credential = new TextDecoder().decode(value);
    expect(Object.keys(received).sort()).toEqual(["LANG", "OLIVE_CREDENTIAL", "OLIVE_ROLE"]);
    expect(received.OLIVE_CREDENTIAL).toBe(credential);
    expect(Object.entries(received).filter(([, v]) => v.includes(credential)).map(([k]) => k)).toEqual(["OLIVE_CREDENTIAL"]);
    expect(JSON.stringify(r.transport.sent)).not.toContain(credential);
  } finally {
    delete process.env.OLIVE_PARENT_ONLY;
  }
});

test("종료: 종료 확인 영수증은 남은 프로세스 0개 뒤에만 낸다(남은 수가 1이거나 모르면 unknown_running)", async () => {
  for (const remaining of [1, null]) {
    const r = await make();
    r.cleanup.remaining = remaining;
    const { runId } = await start(r);
    await r.worker.idle();
    expect(r.transport.of("receipt_stopped"), String(remaining)).toHaveLength(0);
    expect(r.transport.of("report_result")).toHaveLength(0);
    expect(stateOf(r, runId)).toBe("unknown_running");
    // 정리(result_finalize)를 받아도 지우지 않고, 새 시작도 받지 않는다.
    await r.connection.receive(
      fromSupervisor(r.clock, r.worker.name, "result_finalize", { run_id: runId, outcome: "failed", result_digest: null, stored_at: r.clock.now() }, { stop_generation: 0, run_generation: 1 }),
    );
    expect(r.space.cleaned).toHaveLength(0);
    await start(r);
    await r.worker.idle();
    expect(r.launcher.spawned).toBe(1);
    // 다시 끝내고 세어 0이면 그때 낸다.
    r.cleanup.remaining = 0;
    await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "task_cancel", { run_id: runId, reason: "requested" }, { stop_generation: 0, run_generation: 1 }));
    expect(r.transport.of("receipt_stopped")).toHaveLength(1);
    expect(r.transport.of("receipt_stopped")[0]!.body.remaining_processes).toBe(0);
  }
});

test("임대: 갱신이 끊겨 임대가 끝나면 스스로 닫는다(갱신이 오면 그 시각까지 산다)", async () => {
  const r = await make({ mode: "hang" });
  const { runId } = await start(r);
  await until(() => stateOf(r, runId) === "running");
  // 갱신으로 임대를 늘린다.
  r.clock.advance(20_000);
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "run_renew", { run_id: runId, lease_until: r.clock.now() + 30_000 }, { stop_generation: 0, run_generation: 1 }));
  r.clock.advance(15_000);
  r.worker.tick();
  expect(stateOf(r, runId)).toBe("running");
  // 갱신이 끊겼다.
  r.clock.advance(15_000);
  r.worker.tick();
  await r.worker.idle();
  expect(r.transport.of("receipt_stopped")[0]!.body).toMatchObject({ exit: "failed", remaining_processes: 0 });
  expect(stateOf(r, runId)).toBe("failed_stopped");
});

test("임대: 임대 만료만으로 종료 확인 영수증을 내지 않는다(남은 수를 모르면 unknown_running)", async () => {
  const r = await make({ mode: "hang" });
  r.cleanup.remaining = null;
  const { runId } = await start(r);
  await until(() => stateOf(r, runId) === "running");
  r.clock.advance(limits.RUN_LEASE_MAX_MS);
  r.worker.tick();
  await r.worker.idle();
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  expect(stateOf(r, runId)).toBe("unknown_running");
});

test("취소: 실행 중 취소는 접수 영수증(task_cancel) 뒤 끝내고, 0개를 확인하면 cancelled로 종료 확인을 낸다", async () => {
  const r = await make({ mode: "hang" });
  const { runId } = await start(r);
  await until(() => stateOf(r, runId) === "running");
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "task_cancel", { run_id: runId, reason: "requested" }, { stop_generation: 0, run_generation: 1 }));
  await r.worker.idle();
  expect(r.transport.of("receipt_accepted").map((e) => e.body.instruction)).toEqual(["task_start", "task_cancel"]);
  expect(r.transport.of("receipt_stopped")[0]!.body.exit).toBe("cancelled");
  expect(stateOf(r, runId)).toBe("failed_stopped");
});

test("정지 세대: 비상 종료의 더 높은 세대는 효과(종료)보다 먼저 저장된다", async () => {
  const events: string[] = [];
  const r = await make({
    mode: "hang",
    io: {
      writeDurable: async (path, data) => {
        if (path.endsWith("stop-generation.json")) events.push(`save ${data}`);
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, data);
      },
    },
  });
  const terminate = r.cleanup.terminate.bind(r.cleanup);
  r.cleanup.terminate = async () => {
    events.push("terminate");
    await terminate();
  };
  const { runId } = await start(r);
  await until(() => stateOf(r, runId) === "running");
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "task_cancel", { run_id: runId, reason: "emergency_stop" }, { stop_generation: 4, run_generation: 1 }));
  await r.worker.idle();
  expect(events[0]).toBe("save {\"stop_generation\":0}");
  expect(events.indexOf('save {"stop_generation":4}')).toBeLessThan(events.indexOf("terminate"));
  expect(r.store.durableStopGeneration()).toBe(4);
  expect(r.transport.of("receipt_stopped")[0]!.header.stop_generation).toBe(4);
});

test("정지 세대: 저장에 실패하면 종료는 계속하되 새 지시를 받지 않는다", async () => {
  let fail = false;
  const r = await make({
    mode: "hang",
    io: {
      writeDurable: async (path, data) => {
        if (fail && path.endsWith("stop-generation.json")) throw new Error("disk");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, data);
      },
    },
  });
  const { runId } = await start(r);
  await until(() => stateOf(r, runId) === "running");
  fail = true;
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "task_cancel", { run_id: runId, reason: "emergency_stop" }, { stop_generation: 4, run_generation: 1 }));
  await r.worker.idle();
  expect(r.worker.intakeClosed()).toBe("stop_generation_unsaved");
  expect(r.store.durableStopGeneration()).toBe(0);
  // 그 연결은 닫는다(다시 맞추는 것은 새 연결에서).
  expect(r.transport.closed).toBe(true);
  // 종료는 끝까지 갔다. 영수증은 적어 두었다가 다시 맞춘 연결에서 보낸다.
  expect(r.store.outboxFor(runId).find((e) => e.action === "receipt_stopped")?.body.exit).toBe("cancelled");
  // 새 세대(4)로 온 시작도 받지 않는다.
  await reconnect(r, 4);
  expect(r.link.live()).toBe(false);
  await start(r, { stop: 4 });
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(1);
  expect(r.store.runs()).toHaveLength(1);
  // 저장이 돌아온 뒤 같은 세대로 다시 맞추면 그 세대를 파일에 적고서야 연결을 열고 접수를 회복한다.
  fail = false;
  await reconnect(r, 4);
  expect(r.store.durableStopGeneration()).toBe(4);
  expect(r.worker.intakeClosed()).toBeNull();
  expect(r.transport.of("receipt_stopped")[0]!.body.exit).toBe("cancelled");
  await start(r, { stop: 4 });
  await until(() => r.launcher.spawned === 2);
});

test("멱등: 같은 지시를 다시 받으면 같은 영수증(같은 id, 같은 본문)이고 새로 띄우지 않는다", async () => {
  const r = await make();
  const { runId, envelope } = await start(r);
  await r.worker.idle();
  const first = r.transport.of("receipt_accepted")[0]!;
  // 감독이 같은 지시를 새 봉투로 다시 보냈다.
  const again = fromSupervisor(r.clock, r.worker.name, "task_start", envelope.body as never, { stop_generation: 0, run_generation: 1, request_id: envelope.header.request_id });
  await r.connection.receive(again);
  await r.worker.idle();
  const accepted = r.transport.of("receipt_accepted");
  expect(accepted).toHaveLength(2);
  expect(accepted[1]!.body).toEqual(first.body);
  expect(accepted[1]!.header.body_digest).toBe(first.header.body_digest);
  expect(accepted[1]!.header.nonce).not.toBe(first.header.nonce);
  expect(r.launcher.spawned).toBe(1);
  expect(stateOf(r, runId)).toBe("ready_result");
});

test("멱등: 결과가 없다는 이유로 새 실행을 열지 않는다(다시 온 시작, 재시작 뒤 복원)", async () => {
  const r = await make({ mode: "hang" });
  r.cleanup.remaining = null;
  const { runId, envelope } = await start(r);
  await until(() => stateOf(r, runId) === "running");
  await r.cleanup.terminate();
  await r.worker.idle();
  expect(stateOf(r, runId)).toBe("unknown_running");
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "task_start", envelope.body as never, { stop_generation: 0, run_generation: 1 }));
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(1);

  // 실행 중에 꺼진 실행기를 흉내 낸다: 기록이 running인 채로 다시 뜬다.
  const record = r.store.run(runId)!;
  await r.store.noteRun({ ...record, state: "running", exit: null });
  const again = await make({ dir: r.dir, clock: r.clock, mode: "hang" });
  await again.worker.recover();
  await again.worker.idle();
  expect(again.launcher.spawned).toBe(0);
  expect(again.store.run(runId)?.state).toBe("failed_stopped");
  expect(again.store.outboxFor(runId).filter((e) => e.action === "receipt_stopped")).toHaveLength(1);
});

test("멱등: 재접속 뒤 받음 확인 못 받은 영수증을 같은 id·같은 본문으로 다시 보내고, ack한 것은 다시 보내지 않는다", async () => {
  const r = await make();
  await start(r);
  await r.worker.idle();
  const firstSent = r.transport.sent.filter((e) => e.header.action.startsWith("receipt_") || e.header.action === "report_result");
  expect(firstSent).toHaveLength(4);
  await reconnect(r, 0);
  expect(r.transport.actions().slice(0, 2)).toEqual(["stop_sync_request", "hello"]);
  const hello = r.transport.of("hello")[0]!;
  const ids = firstSent.map((e) => (e.body as { receipt_id?: string; report_id?: string }).receipt_id ?? (e.body as { report_id: string }).report_id);
  expect([...hello.body.unacked_ids].sort()).toEqual([...ids].sort());
  const resent = r.transport.sent.slice(2);
  expect(resent.map((e) => e.header.body_digest).sort()).toEqual(firstSent.map((e) => e.header.body_digest).sort());
  // ack는 다시 보내기만 멈춘다.
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "ack", { ids: ids.slice(0, 2) }, { stop_generation: 0 }));
  await reconnect(r, 0);
  expect(r.transport.sent.slice(2).map((e) => e.header.body_digest).sort()).toEqual(firstSent.slice(2).map((e) => e.header.body_digest).sort());
});

test("조회: status_query에 아는 실행은 기록의 상태·세대로, 모르는 실행은 not_known으로 답한다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const unknown = randomUUID();
  const query = fromSupervisor(r.clock, r.worker.name, "status_query", { run_ids: [runId, unknown] }, { stop_generation: 0 });
  await r.connection.receive(query);
  const report = r.transport.of("status_report")[0]!;
  expect(report.body.in_reply_to).toBe(query.header.request_id);
  expect(report.body.runs).toEqual([
    { run_id: runId, state: "ready_result", run_generation: 1, last_receipt_id: r.store.run(runId)!.last_receipt_id },
    { run_id: unknown, state: "not_known", run_generation: null, last_receipt_id: null },
  ]);
});

test("정리: result_finalize는 프로세스 0개를 확인한 실행만 지우고 정리 영수증을 낸다. 지우지 못하면 cleanup_pending이고 새 시작을 받지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  r.space.cleanResult = false;
  const finalize = (id: string, requestId?: string) =>
    fromSupervisor(r.clock, r.worker.name, "result_finalize", { run_id: id, outcome: "failed", result_digest: null, stored_at: r.clock.now() }, { stop_generation: 0, run_generation: 1, request_id: requestId });
  const owner = randomUUID();
  await r.connection.receive(finalize(runId, owner));
  expect(stateOf(r, runId)).toBe("cleanup_pending");
  expect(r.transport.of("receipt_cleaned")).toHaveLength(0);
  await start(r);
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(1);
  r.space.cleanResult = true;
  const requestId = randomUUID();
  await r.connection.receive(finalize(runId, requestId));
  expect(stateOf(r, runId)).toBe("finalized");
  // 끝나지 않은 정리 의도의 주인은 처음 요청이다. 이어서 지우게 한 요청은 그 사실로 자기 영수증을 따로 받는다.
  const cleaned = r.transport.of("receipt_cleaned");
  expect(cleaned.map((e) => e.body.instruction_request_id)).toEqual([owner, requestId]);
  // 같은 확정(같은 request_id)이 새 봉투로 다시 오면 같은 정리 영수증이다.
  await r.connection.receive(finalize(runId, requestId));
  expect(r.transport.of("receipt_cleaned").map((e) => e.body)).toEqual([cleaned[0]!.body, cleaned[1]!.body, cleaned[1]!.body]);
  // 다른 요청의 확정은 그 요청의 영수증을 받되, 지우기는 반복하지 않고 정리 시각은 처음의 사실이다.
  const other = randomUUID();
  await r.connection.receive(finalize(runId, other));
  const last = r.transport.of("receipt_cleaned").at(-1)!.body;
  expect(last.instruction_request_id).toBe(other);
  expect(last.receipt_id).not.toBe(cleaned[0]!.body.receipt_id);
  expect(last.cleaned_at).toBe(cleaned[0]!.body.cleaned_at);
  expect(r.space.cleaned).toEqual([runId, runId]);
});

test("저장소: 초기화되면 저장소 ID가 바뀌어 옛 지시가 거절된다", async () => {
  const r = await make();
  const runId = randomUUID();
  const value = credentialValue();
  const envelope = fromSupervisor(r.clock, r.worker.name, "task_start", taskStartBody(r, runId, sha256(value)), { stop_generation: 0, run_generation: 1 });
  // 새 볼륨(빈 폴더)으로 다시 뜬 실행기.
  const fresh = await make({ clock: r.clock });
  expect(fresh.store.storageId).not.toBe(r.store.storageId);
  fresh.credentials.values.set(runId, value);
  expect(await verifyEnvelope(envelope, fresh.worker.verifyContext(null))).toEqual({ ok: false, reason: "wrong_recipient" });
  await fresh.connection.receive(envelope);
  await fresh.worker.idle();
  expect(fresh.launcher.spawned).toBe(0);
  // 같은 폴더면 같은 ID다.
  expect((await ExecutorStore.open(r.dir)).storageId).toBe(r.store.storageId);
});

test("맞춤: 맞춤 답(새 세대)도 hello도 시작·자격의 근거가 아니다", async () => {
  const r = await make({ syncTo: 7 });
  expect(r.transport.actions()).toEqual(["stop_sync_request", "hello"]);
  expect(r.credentials.calls).toHaveLength(0);
  expect(r.launcher.spawned).toBe(0);
  expect(r.store.runs()).toHaveLength(0);
  expect(new FakeTransport().sent).toHaveLength(0);
  // 맞춘 뒤 다른 challenge의 답, 같은 답의 재생은 처리하지 않는다.
  await r.connection.receive(syncReply(r, 9, "f".repeat(32)));
  expect(r.store.stopGeneration()).toBe(7);
});
