// 경합 순서 시험: 사건 순번과 포인터, 정리 응답의 승인, 맞춤의 만료, 종료 시각 판정, 준비 전 확인, 장부 대조, 세대 쓰기 중 송신, 깊은 결과.
// 순서는 고정 장벽(쓰기에 실제로 들어갔다는 신호)으로 만든다.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { limits, resultDigest } from "../../src/contract/v1/index.ts";
import type { LaunchHooks } from "../../src/executor/launcher.ts";
import {
  barrier,
  cancelReceiptWrite,
  FakeTransport,
  fromSupervisor,
  gate,
  onDiskEvents,
  onDiskRun,
  outboxWrite,
  pause,
  reconnect,
  rig,
  type Rig,
  scriptedIo,
  start,
  stopWrite,
  syncReply,
  until,
} from "./support.ts";

const rigs: Rig[] = [];
async function make(options: Parameters<typeof rig>[0] = {}) {
  const r = await rig(options);
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.cleanup.terminate();
    await Promise.race([r.worker.idle(), pause(1_000)]);
  }
});

const cancel = (r: Rig, runId: string, requestId?: string, reason: "requested" | "deadline" | "emergency_stop" = "requested", stop = 0) =>
  fromSupervisor(r.clock, r.worker.name, "task_cancel", { run_id: runId, reason }, { stop_generation: stop, run_generation: 1, request_id: requestId });
const finalize = (r: Rig, runId: string, extra: { outcome?: "succeeded" | "failed"; digest?: string | null; requestId?: string } = {}) =>
  fromSupervisor(
    r.clock,
    r.worker.name,
    "result_finalize",
    { run_id: runId, outcome: extra.outcome ?? "failed", result_digest: extra.digest ?? null, stored_at: r.clock.now() },
    { stop_generation: 0, run_generation: 1, request_id: extra.requestId },
  );
const cancelReceipts = (r: Rig, runId: string) => r.store.outboxFor(runId).filter((e) => e.action === "receipt_accepted" && e.body.instruction === "task_cancel");
const cleanedReceipts = (r: Rig, runId: string) => r.store.outboxFor(runId).filter((e) => e.action === "receipt_cleaned");

// 프로세스를 띄우지 않고 종료·stdout을 시험이 정하는 launcher.
function fakeLauncher(r: Rig, script: (hooks: LaunchHooks) => Promise<Uint8Array>) {
  r.launcher.run = async (_plan, _signal, hooks) => {
    hooks.spawned({ pid: 0, exited: Promise.resolve(), signal: () => {} });
    const stdout = await script(hooks);
    return { exit: { code: 0, signal: null }, stdout, overflow: false };
  };
}
const goodResult = new TextEncoder().encode(JSON.stringify({ role: "diagnosis", outcome: "completed", summary: "끝", items: [], refs: [] }));

// 검증을 지난 봉투가 실행기의 처리에 들어가 첫 await까지 간 횟수를 센다. count번째 처리가 그 자리에 닿으면 풀린다.
function handled(r: Rig, count: number): Promise<void> {
  const reached = gate();
  const handle = r.worker.handle.bind(r.worker);
  let seen = 0;
  r.worker.handle = (verified, epoch) => {
    const work = handle(verified, epoch);
    if (++seen === count) reached.open();
    return work;
  };
  return reached.wait;
}

// ---- R07 ----

test("R07 같은 요청의 취소 둘이 겹쳐도 영수증 ID는 하나이고, 쓰는 동안에는 보내지 않는다", async () => {
  const disk = scriptedIo();
  const r = await make({ mode: "hang", io: disk.io });
  const { runId } = await start(r);
  await until(() => r.store.run(runId)?.state === "running");
  const writing = disk.hold(cancelReceiptWrite);
  // 둘째 봉투는 nonce 검증을 끝낸 뒤 조회 바로 앞에서 세운다. 쓰기가 멈춘 뒤에는 nonce도 저장 줄을 지나지 못한다.
  const secondVerified = barrier();
  const lookedUp = gate();
  const handle = r.worker.handle.bind(r.worker);
  let calls = 0;
  r.worker.handle = async (verified, epoch) => {
    if (++calls !== 2) return handle(verified, epoch);
    await secondVerified.pass();
    const work = handle(verified, epoch);
    lookedUp.open();
    return work;
  };
  const requestId = randomUUID();
  const first = r.connection.receive(cancel(r, runId, requestId));
  const second = r.connection.receive(cancel(r, runId, requestId));
  await secondVerified.entered;
  await writing.entered;
  // 둘째 요청의 조회는 첫 영수증의 파일 쓰기 안에서 일어난다.
  secondVerified.open();
  await lookedUp.wait;
  expect(cancelReceipts(r, runId)).toHaveLength(1);
  expect(r.transport.of("receipt_accepted").filter((e) => e.body.instruction === "task_cancel")).toHaveLength(0);
  writing.open();
  await Promise.all([first, second]);
  await r.worker.idle();
  expect(cancelReceipts(r, runId)).toHaveLength(1);
  expect(new Set(r.transport.of("receipt_accepted").filter((e) => e.body.instruction === "task_cancel").map((e) => e.body.receipt_id)).size).toBe(1);
});

test("R07 같은 요청 ID에 본문이 다른 취소는 같은 영수증으로 답하지 않는다(멈추는 효과는 그대로다)", async () => {
  const r = await make({ mode: "hang" });
  const { runId } = await start(r);
  await until(() => r.store.run(runId)?.state === "running");
  const requestId = randomUUID();
  await r.connection.receive(cancel(r, runId, requestId, "requested"));
  await r.worker.idle();
  const sent = r.transport.of("receipt_accepted").filter((e) => e.body.instruction === "task_cancel").length;
  await r.connection.receive(cancel(r, runId, requestId, "deadline"));
  expect(r.transport.of("receipt_accepted").filter((e) => e.body.instruction === "task_cancel")).toHaveLength(sent);
  expect(cancelReceipts(r, runId)).toHaveLength(1);
});

// ---- R08 ----

test("R08 시작 영수증만 한 번 실패해도 뒤 사건이 앞지르지 않고, 마지막 영수증은 종료 영수증에서 물러나지 않는다", async () => {
  const disk = scriptedIo();
  disk.failOnce(outboxWrite("receipt_started"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  await r.worker.flush();
  const order = r.transport.actions().filter((a) => a.startsWith("receipt_") || a === "report_result");
  expect(order).toEqual(["receipt_accepted", "receipt_started", "receipt_stopped", "report_result"]);
  const stopped = onDiskEvents(r.dir, runId).find((e) => e.action === "receipt_stopped")!;
  expect(onDiskRun(r.dir, runId).last_receipt_id).toBe(stopped.id);
  expect(r.store.run(runId)?.last_receipt_id).toBe(stopped.id);

  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBeNull();
  expect(again.store.run(runId)?.last_receipt_id).toBe(stopped.id);
  // 재연결의 재전송도 최초 순번 차례다.
  expect(again.transport.actions().slice(2)).toEqual(["receipt_accepted", "receipt_started", "receipt_stopped", "report_result"]);
});

test("R08 늦게 적힌 앞 사건도 재전송 뒤 상태 조회가 마지막 영수증을 그대로 답한다", async () => {
  const disk = scriptedIo();
  const heal = disk.fail(outboxWrite("receipt_started"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  heal();
  await r.worker.flush();
  const stopped = onDiskEvents(r.dir, runId).find((e) => e.action === "receipt_stopped")!;
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "status_query", { run_ids: [runId] }, { stop_generation: 0 }));
  expect(r.transport.of("status_report").at(-1)!.body.runs[0]!.last_receipt_id).toBe(stopped.id);
});

// ---- R09 ----

test("R09 다른 digest의 성공 확정은 첫 정리 전·중·후 모두 새 영수증을 받지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const wrong = { outcome: "succeeded" as const, digest: "0".repeat(64) };
  // 전
  await r.connection.receive(finalize(r, runId, wrong));
  expect(r.space.cleaned).toEqual([]);
  expect(cleanedReceipts(r, runId)).toHaveLength(0);
  // 중
  const deleting = barrier();
  r.space.clean = async (id) => {
    r.space.cleaned.push(id);
    await deleting.pass();
    return true;
  };
  const right = r.connection.receive(finalize(r, runId));
  await deleting.entered;
  const wrongHandled = handled(r, 1);
  const during = r.connection.receive(finalize(r, runId, wrong));
  // 틀린 확정이 지우는 중에 처리에 들어간 뒤에 지우기를 끝낸다.
  await wrongHandled;
  expect(r.store.run(runId)?.state).toBe("cleanup_pending");
  deleting.open();
  await Promise.all([right, during]);
  expect(cleanedReceipts(r, runId)).toHaveLength(1);
  // 후
  await r.connection.receive(finalize(r, runId, wrong));
  expect(cleanedReceipts(r, runId)).toHaveLength(1);
  expect(r.space.cleaned).toEqual([runId]);
});

test("R09 맞는 digest의 새 요청은 정리 뒤에도 그 요청의 영수증을 받는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const digest = resultDigest(r.transport.of("report_result")[0]!.body.result);
  await r.connection.receive(finalize(r, runId, { outcome: "succeeded", digest }));
  const other = randomUUID();
  await r.connection.receive(finalize(r, runId, { outcome: "succeeded", digest, requestId: other }));
  expect(cleanedReceipts(r, runId).map((e) => e.body.instruction_request_id)).toContain(other);
  expect(r.space.cleaned).toEqual([runId]);
});

test("R09 합류를 기다리는 사이 연결이 바뀌면 새 요청의 영수증을 새 연결로 내지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const deleting = barrier();
  r.space.clean = async (id) => {
    r.space.cleaned.push(id);
    await deleting.pass();
    return true;
  };
  const first = r.connection.receive(finalize(r, runId));
  await deleting.entered;
  const joiner = randomUUID();
  const joined = r.connection.receive(finalize(r, runId, { requestId: joiner }));
  // 저장소의 줄을 한 번 비워 합류한 요청의 nonce 처리가 끝난 뒤에 연결을 바꾼다.
  await r.worker.flush();
  await reconnect(r, 0);
  deleting.open();
  await Promise.all([first, joined]);
  expect(cleanedReceipts(r, runId).map((e) => e.body.instruction_request_id)).not.toContain(joiner);
});

test("R09 지우는 중에 같은 요청 ID로 본문이 다른 확정이 합류해도 그 요청에 답하지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const deleting = barrier();
  r.space.clean = async (id) => {
    r.space.cleaned.push(id);
    await deleting.pass();
    return true;
  };
  const requestId = randomUUID();
  const first = r.connection.receive(finalize(r, runId, { requestId }));
  await deleting.entered;
  const digest = resultDigest(r.transport.of("report_result")[0]!.body.result);
  const otherHandled = handled(r, 1);
  const other = r.connection.receive(finalize(r, runId, { requestId, outcome: "succeeded", digest }));
  // 다른 본문의 확정이 지우는 중에 처리에 들어간 뒤에 지우기를 끝낸다.
  await otherHandled;
  expect(r.store.run(runId)?.state).toBe("cleanup_pending");
  deleting.open();
  await Promise.all([first, other]);
  const cleaned = cleanedReceipts(r, runId);
  expect(cleaned).toHaveLength(1);
  // 다른 본문의 재전송에는 이미 낸 영수증도 다시 보내지 않는다.
  const sent = r.transport.of("receipt_cleaned").length;
  await r.connection.receive(finalize(r, runId, { requestId, outcome: "succeeded", digest }));
  expect(r.transport.of("receipt_cleaned")).toHaveLength(sent);
  expect(r.space.cleaned).toEqual([runId]);
});

test("R09 같은 요청 ID에 다른 본문의 확정이 재시작 뒤 와도 지우지 않고 답하지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  r.space.cleanResult = false;
  const requestId = randomUUID();
  await r.connection.receive(finalize(r, runId, { requestId }));
  expect(r.store.run(runId)?.state).toBe("cleanup_pending");
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.connection.receive(finalize(again, runId, { requestId, outcome: "succeeded", digest: resultDigest(r.transport.of("report_result")[0]!.body.result) }));
  expect(again.space.cleaned).toEqual([]);
  expect(cleanedReceipts(again, runId)).toHaveLength(0);
});

// ---- R10 ----

test("R10 nonce를 적는 사이 시계가 sentAt 앞으로 돌아가면 맞춤을 열지 않는다", async () => {
  const disk = scriptedIo();
  const r = await make({ syncTo: null, io: disk.io });
  const consuming = barrier();
  disk.markers.gate = consuming;
  const reply = r.connection.receive(syncReply(r, 1));
  await consuming.entered;
  r.clock.advance(-1_000);
  consuming.open();
  await reply;
  expect(r.link.live()).toBe(false);
  expect(r.transport.closed).toBe(true);
  expect(r.transport.of("hello")).toHaveLength(0);
});

test("R10 맞춤 세대 쓰기가 멈추면 상한에서 연결을 닫고 저장 장애를 드러내며, 늦은 완료가 연결을 열지 못한다", async () => {
  const disk = scriptedIo();
  const writing = disk.hold(stopWrite);
  const r = await make({ syncTo: null, io: disk.io });
  const reply = r.connection.receive(syncReply(r, 2));
  await writing.entered;
  expect(r.connection.state).toBe("adopting");
  r.clock.advance(limits.STOP_SYNC_WAIT_MS - 1);
  r.link.tick();
  expect(r.transport.closed).toBe(false);
  r.clock.advance(1);
  r.link.tick();
  expect(r.transport.closed).toBe(true);
  expect(r.worker.intakeClosed()).toBe("stop_generation_unsaved");
  writing.open();
  await reply;
  expect(r.link.live()).toBe(false);
  expect(r.transport.of("hello")).toHaveLength(0);
  // 새 연결에서 다시 맞추면 정상으로 돌아온다.
  await reconnect(r, 2);
  expect(r.link.live()).toBe(true);
  expect(r.worker.intakeClosed()).toBeNull();
});

// ---- R11 ----

test("R11 제때 끝난 프로그램은 stdout을 읽는 사이 임대 시각이 지나도 completed다(뒤의 정리·계수는 계속한다)", async () => {
  const r = await make();
  const draining = barrier();
  fakeLauncher(r, async (hooks) => {
    hooks.exited?.();
    await draining.pass();
    return goodResult;
  });
  const { runId } = await start(r);
  await draining.entered;
  r.clock.advance(limits.RUN_LEASE_MAX_MS);
  r.worker.tick();
  draining.open();
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("ready_result");
  expect(r.transport.of("receipt_stopped")[0]!.body.exit).toBe("completed");
  expect(r.cleanup.terminations).toBeGreaterThan(0);
  expect(r.cleanup.survivorChecks).toBeGreaterThan(0);
});

test("R11 끝난 프로그램의 임대는 늘지 않는다", async () => {
  const r = await make();
  const draining = barrier();
  fakeLauncher(r, async (hooks) => {
    hooks.exited?.();
    await draining.pass();
    return goodResult;
  });
  const { runId } = await start(r);
  await draining.entered;
  const lease = r.store.run(runId)!.lease_until;
  r.clock.advance(1_000);
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "run_renew", { run_id: runId, lease_until: r.clock.now() + limits.RUN_LEASE_MAX_MS }, { stop_generation: 0, run_generation: 1 }));
  expect(r.store.run(runId)?.lease_until).toBe(lease);
  draining.open();
  await r.worker.idle();
});

// ---- R12 ----

test("R12 접수를 적는 사이 연결이 바뀌면 폴더 준비를 시작하지 않고, 처리되지 않은 거절도 남지 않는다", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const disk = scriptedIo();
    const writing = disk.hold(outboxWrite("receipt_accepted"));
    const r = await make({ io: disk.io });
    r.space.prepare = async (runId, signal) => {
      r.space.prepared.push(runId);
      if (signal?.aborted) throw new Error("aborted");
    };
    const started = start(r);
    await writing.entered;
    // 새 연결의 맞춤은 멈춘 쓰기 뒤의 nonce를 기다리므로 여는 것까지만 한다. 앞 연결은 이미 지금 연결이 아니다.
    r.link.open(new FakeTransport());
    writing.open();
    const { runId } = await started;
    await r.worker.idle();
    // 처리되지 않은 거절은 다음 차례에 알려진다.
    await pause(0);
    expect(r.space.prepared).toEqual([]);
    expect(r.store.run(runId)?.state).toBe("not_started");
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("R12 접수를 적는 사이 기한이 지나도 폴더 준비를 시작하지 않는다", async () => {
  const disk = scriptedIo();
  const writing = disk.hold(outboxWrite("receipt_accepted"));
  const r = await make({ io: disk.io });
  const started = start(r, { body: { deadline_at: r.clock.now() + 1_000 } });
  await writing.entered;
  r.clock.advance(2_000);
  writing.open();
  const { runId } = await started;
  await r.worker.idle();
  expect(r.space.prepared).toEqual([]);
  expect(r.store.run(runId)?.state).toBe("not_started");
});

// ---- R13 ----

test("R13 마지막 영수증이 다른 실행의 영수증이나 자기 결과 보고를 가리키면 불일치로 열고 그 포인터를 쓰지 않는다", async () => {
  const r = await make();
  const a = await start(r);
  await r.worker.idle();
  await r.connection.receive(finalize(r, a.runId));
  const b = await start(r);
  await r.worker.idle();
  const other = onDiskEvents(r.dir, b.runId).find((e) => e.action === "receipt_stopped")!;
  const report = onDiskEvents(r.dir, b.runId).find((e) => e.action === "report_result")!;
  const path = join(r.dir, "runs", `${a.runId}.json`);
  const point = (id: string) => writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, "utf8")) as object), last_receipt_id: id }));

  point(other.id);
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBe("receipt_mismatch");
  expect(again.worker.intakeClosed()).toBe("store_inconsistent");
  await again.connection.receive(fromSupervisor(again.clock, again.worker.name, "status_query", { run_ids: [a.runId] }, { stop_generation: 0 }));
  expect(again.transport.of("status_report").at(-1)!.body.runs[0]!.last_receipt_id).toBeNull();

  // 같은 실행의 결과 보고를 가리켜도 영수증 포인터가 아니다.
  const selfReport = await make();
  const c = await start(selfReport);
  await selfReport.worker.idle();
  const own = onDiskEvents(selfReport.dir, c.runId).find((e) => e.action === "report_result")!;
  const ownPath = join(selfReport.dir, "runs", `${c.runId}.json`);
  writeFileSync(ownPath, JSON.stringify({ ...(JSON.parse(readFileSync(ownPath, "utf8")) as object), last_receipt_id: own.id }));
  const reopened = await make({ dir: selfReport.dir, clock: selfReport.clock });
  expect(reopened.store.inconsistency()).toBe("receipt_mismatch");
  expect(report.id).not.toBe(own.id);
});

// ---- R14 ----

test("R14 점유가 상한을 넘은 기존 장부는 표식을 남기고 접수를 닫으며 정상 인사를 하지 않는다", async () => {
  const r = await make();
  const seed = (state: "cleanup_pending" | "unknown_running") => ({
    run_id: randomUUID(),
    run_generation: 1,
    state,
    start_stop_generation: 0,
    instruction_request_id: randomUUID(),
    deadline_at: r.clock.now() + 600_000,
    lease_until: r.clock.now() + 30_000,
    credential_digest: "0".repeat(64),
    exit: null,
    last_receipt_id: null,
  });
  for (let i = 0; i < limits.STATUS_MAX_RUNS; i++) expect(await r.store.beginRun(seed("cleanup_pending"))).toBe(true);
  expect(await r.store.beginRun(seed("unknown_running"))).toBe(true);
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBe("over_capacity");
  expect(again.worker.intakeClosed()).toBe("store_inconsistent");
  expect(again.transport.of("hello")).toHaveLength(0);
  expect(again.transport.closed).toBe(true);
  // 판정은 다음 기동에도 남는다.
  const third = await make({ dir: r.dir, clock: r.clock });
  expect(third.store.inconsistency()).toBe("over_capacity");
});

test("R14 인사는 끝을 모르는 실행을 슬롯을 쥔 다른 실행보다 앞에 싣는다", async () => {
  const r = await make();
  const seed = (state: "cleanup_pending" | "unknown_running") => ({
    run_id: randomUUID(),
    run_generation: 1,
    state,
    start_stop_generation: 0,
    instruction_request_id: randomUUID(),
    deadline_at: r.clock.now() + 600_000,
    lease_until: r.clock.now() + 30_000,
    credential_digest: "0".repeat(64),
    exit: null,
    last_receipt_id: null,
  });
  for (let i = 0; i < limits.STATUS_MAX_RUNS; i++) await r.store.beginRun(seed("cleanup_pending"));
  const uncertain = seed("unknown_running");
  await r.store.beginRun(uncertain);
  await reconnect(r, 0);
  expect(r.transport.of("hello")[0]!.body.runs[0]).toMatchObject({ run_id: uncertain.run_id, state: "unknown_running" });
});

// ---- R15 ----

test("R15 세대를 디스크에 쓰는 동안에는 새 세대로 서명한 재전송을 내보내지 않고, 일치한 뒤 같은 본문을 보낸다", async () => {
  const disk = scriptedIo();
  const r = await make({ mode: "hang", io: disk.io });
  const { runId } = await start(r);
  await until(() => r.store.run(runId)?.state === "running");
  const accepted = r.transport.of("receipt_accepted")[0]!;
  const writing = disk.hold(stopWrite);
  const stop = r.connection.receive(cancel(r, runId, undefined, "emergency_stop", 4));
  await writing.entered;
  expect(r.store.stopGeneration()).toBe(4);
  r.clock.advance(limits.RENEW_INTERVAL_MS);
  r.worker.tick();
  expect(r.transport.sent.filter((e) => e.header.stop_generation === 4)).toEqual([]);
  writing.open();
  await stop;
  await r.worker.idle();
  const resent = r.transport.of("receipt_accepted").filter((e) => e.header.stop_generation === 4 && e.body.instruction === "task_start");
  expect(resent.length).toBeGreaterThan(0);
  expect(resent[0]!.header.body_digest).toBe(accepted.header.body_digest);
});

// ---- R16 ----

test("R16 깊이 상한을 넘는 결과는 고정 실패 결과가 되고 이미 확인한 종료 증거·상태를 뒤집지 않는다", async () => {
  const r = await make();
  const deep = "[".repeat(200_000) + "]".repeat(200_000);
  fakeLauncher(r, async (hooks) => {
    hooks.exited?.();
    return new TextEncoder().encode(deep);
  });
  const { runId } = await start(r);
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("ready_result");
  expect(r.transport.of("receipt_stopped")).toHaveLength(1);
  expect(r.transport.of("report_result")[0]!.body.result).toMatchObject({ outcome: "failed", items: [], refs: [] });
});

test("R16 깊이 상한 안에서 자격이 깊이 숨어 있어도 찾아 원문 없이 버린다", async () => {
  const r = await make();
  let secret = "";
  fakeLauncher(r, async (hooks) => {
    hooks.exited?.();
    let value: unknown = { summary: secret };
    for (let i = 0; i < limits.MAX_DEPTH - 2; i++) value = [value];
    return new TextEncoder().encode(JSON.stringify({ role: "diagnosis", outcome: "completed", summary: "요약", items: value, refs: [] }));
  });
  const runId = randomUUID();
  const value = new TextEncoder().encode(`deep-secret-${randomUUID()}`);
  secret = new TextDecoder().decode(value);
  await start(r, { runId, value });
  await r.worker.idle();
  expect(JSON.stringify(r.transport.sent)).not.toContain(secret);
  expect(r.transport.of("report_result")[0]!.body.result).toMatchObject({ outcome: "failed", items: [], refs: [] });
  expect(new FakeTransport().sent).toEqual([]);
});
