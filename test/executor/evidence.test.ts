// 유효한 상태의 한 자리, 판정의 지속, 닫는 동작의 독립, 장애 중의 송신, 요청 대조의 시험.
// 규칙: 불확실하면 슬롯을 쥔 채 권한을 주는 동작을 닫고, 이미 맡은 실행을 멈추는 일은 장부 쓰기와 독립적으로 시작한다.
// 순서는 고정 장벽(쓰기에 실제로 들어갔다는 신호)으로 만든다. 다시 열기는 같은 폴더를 새 저장소로 여는 것으로 재시작을 흉내 낸다.
import { afterEach, expect } from "bun:test";
import { type KeyObject, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Bodies, type Header, limits, resultDigest } from "../../src/contract/v1/index.ts";
import type { LaunchHooks } from "../../src/executor/launcher.ts";
import { ExecutorStore, type StoreError } from "../../src/executor/store.ts";
import { WorkerExecutor } from "../../src/executor/worker.ts";
import {
  barrier,
  cancelReceiptWrite,
  executorKeys,
  fakeProfile,
  fromSupervisor,
  gate,
  onDiskEvents,
  onDiskRun,
  outboxWrite,
  pause,
  POD_UID,
  reconnect,
  reservationFreed,
  rig,
  type Rig,
  runWrite,
  scriptedIo,
  sha256,
  start,
  stopWrite,
  supervisorKeys,
  syncReply,
  test,
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

const cancel = (r: Rig, runId: string, requestId?: string, reason: "requested" | "deadline" = "requested") =>
  fromSupervisor(r.clock, r.worker.name, "task_cancel", { run_id: runId, reason }, { stop_generation: 0, run_generation: 1, request_id: requestId });
const finalize = (r: Rig, runId: string, requestId?: string, extra: { outcome?: "succeeded" | "failed"; digest?: string | null } = {}) =>
  fromSupervisor(
    r.clock,
    r.worker.name,
    "result_finalize",
    { run_id: runId, outcome: extra.outcome ?? "failed", result_digest: extra.digest ?? null, stored_at: r.clock.now() },
    { stop_generation: 0, run_generation: 1, request_id: requestId },
  );
async function statusOf(r: Rig, runId: string) {
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "status_query", { run_ids: [runId] }, { stop_generation: 0 }));
  return r.transport.of("status_report").at(-1)!.body.runs[0]!;
}
const receiptsOf = (r: Rig, runId: string) =>
  r.transport.sent.filter((e) => (e.header.action.startsWith("receipt_") || e.header.action === "report_result") && (e.body as { run_id?: string }).run_id === runId);
const eventOf = (dir: string, runId: string, action: string) => onDiskEvents(dir, runId).find((e) => e.action === action)!;
const outboxPath = (dir: string, id: string) => join(dir, "outbox", `${id}.json`);

// 저장된 종료 영수증의 본문을 계약에 맞지 않게 만든다(남은 수 0이 아니다).
function breakStopped(dir: string, runId: string): string {
  const stopped = eventOf(dir, runId, "receipt_stopped");
  const path = outboxPath(dir, stopped.id);
  const raw = JSON.parse(readFileSync(path, "utf8")) as { body: Record<string, unknown> };
  raw.body.remaining_processes = 3;
  writeFileSync(path, JSON.stringify(raw));
  return stopped.id;
}

function rewriteRun(dir: string, runId: string, patch: Record<string, unknown>): void {
  const path = join(dir, "runs", `${runId}.json`);
  writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, "utf8")) as object), ...patch }));
}

function runRecord(r: Rig, state: "running" | "cleanup_pending" | "unknown_running") {
  return {
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
  };
}

// 프로세스를 띄우지 않고 종료·stdout을 시험이 정하는 launcher.
function fakeLauncher(r: Rig, script: (hooks: LaunchHooks) => Promise<Uint8Array>) {
  r.launcher.run = async (_plan, _signal, hooks) => {
    hooks.spawned({ pid: 0, exited: Promise.resolve(), signal: () => {} });
    const stdout = await script(hooks);
    return { exit: { code: 0, signal: null }, stdout, overflow: false };
  };
}
const goodResult = new TextEncoder().encode(JSON.stringify({ role: "diagnosis", outcome: "completed", summary: "끝", items: [], refs: [] }));

// ---- F02 판정의 지속 ----

test("F02 표식을 적지 못하면 정지 세대 파일을 만들지 않고, 다음 열기도 보류다", async () => {
  const seed = await make();
  await start(seed);
  await seed.worker.idle();
  rmSync(join(seed.dir, "stop-generation.json"));
  const disk = scriptedIo();
  disk.fail((path) => path.endsWith("ledger-hold"));
  const outcome = await ExecutorStore.open(seed.dir, { now: seed.clock.now, io: disk.io }).then(
    async (store) => {
      await store.adoptStopGeneration(0);
      return "opened";
    },
    (error: StoreError) => error.code,
  );
  expect(existsSync(join(seed.dir, "stop-generation.json"))).toBe(false);
  expect(outcome).toBe("store_unavailable");
  const again = await ExecutorStore.open(seed.dir, { now: seed.clock.now });
  expect(again.inconsistency()).toBe("stop_generation_missing");
  expect(JSON.parse(readFileSync(join(seed.dir, "ledger-hold"), "utf8"))).toEqual({ reason: "stop_generation_missing" });
});

async function overCapacity(r: Rig) {
  for (let i = 0; i < limits.STATUS_MAX_RUNS; i++) expect(await r.store.beginRun(runRecord(r, "cleanup_pending"))).toBe(true);
  expect(await r.store.beginRun(runRecord(r, "unknown_running"))).toBe(true);
  writeFileSync(join(r.dir, "ledger-hold"), JSON.stringify({ reason: "receipt_missing" }));
}

test("F02 승격: 기존 부분 표식이 전체 보류로 바뀌면 파일의 사유도 바뀐다", async () => {
  const r = await make();
  await overCapacity(r);
  const again = await ExecutorStore.open(r.dir, { now: r.clock.now });
  expect(again.inconsistency()).toBe("over_capacity");
  expect(JSON.parse(readFileSync(join(r.dir, "ledger-hold"), "utf8"))).toEqual({ reason: "over_capacity" });
});

test("F02 승격: 더 강한 사유를 적지 못하면 열지 않는다", async () => {
  const r = await make();
  await overCapacity(r);
  const disk = scriptedIo();
  disk.fail((path) => path.endsWith("ledger-hold"));
  const outcome = await ExecutorStore.open(r.dir, { now: r.clock.now, io: disk.io }).then(
    () => "opened",
    (error: StoreError) => error.code,
  );
  expect(outcome).toBe("store_unavailable");
  expect(JSON.parse(readFileSync(join(r.dir, "ledger-hold"), "utf8"))).toEqual({ reason: "receipt_missing" });
});

test("F02 실행 중 표식: 적지 못하면 세대·상태 쓰기를 멈추고, 표식이 적힌 뒤에 다시 쓴다", async () => {
  const disk = scriptedIo();
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  const heal = disk.fail((path) => path.endsWith("ledger-hold"));
  r.store.markInconsistent("outbox_body");
  expect((await r.store.adoptStopGeneration(1)).saved).toBe(false);
  expect(JSON.parse(readFileSync(join(r.dir, "stop-generation.json"), "utf8"))).toEqual({ stop_generation: 0 });
  const before = onDiskRun(r.dir, runId).state;
  expect((await r.store.commit(runId, { state: "failed_stopped" })).saved).toBe(false);
  expect(onDiskRun(r.dir, runId).state).toBe(before);
  expect(r.store.healthy()).toBe(false);
  heal();
  expect(await r.worker.flush()).toBe(true);
  expect(JSON.parse(readFileSync(join(r.dir, "ledger-hold"), "utf8"))).toEqual({ reason: "outbox_body" });
  expect(onDiskRun(r.dir, runId).state).toBe("failed_stopped");
  expect((await r.store.adoptStopGeneration(1)).saved).toBe(true);
});

// ---- F03 유효한 상태의 한 자리 ----

test("F03 유효한 종료 영수증이 없는 stopping은 실제 계수 0으로 돌아와도 완료로 맺지 않고 새 영수증도 내지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  await r.store.noteRun({ ...r.store.run(runId)!, state: "stopping" });
  const stopped = breakStopped(r.dir, runId);
  const again = await make({ dir: r.dir, clock: r.clock });
  again.cleanup.remaining = 0;
  await again.worker.recover();
  expect(again.cleanup.survivorChecks).toBeGreaterThan(0);
  expect(again.store.run(runId)?.state).toBe("unknown_running");
  expect(onDiskEvents(again.dir, runId).filter((e) => e.action === "receipt_stopped").map((e) => e.id)).toEqual([stopped]);
  expect(receiptsOf(again, runId)).toEqual([]);
  expect(await statusOf(again, runId)).toMatchObject({ state: "unknown_running", last_receipt_id: null });
});

test("F03 결과 파일만 잃은 ready_result는 완료로 답하지 않고 폴더를 지우지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  rmSync(outboxPath(r.dir, eventOf(r.dir, runId, "report_result").id));
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBe("receipt_missing");
  expect(again.worker.intakeClosed()).toBe("store_inconsistent");
  expect(receiptsOf(again, runId)).toEqual([]);
  expect(await statusOf(again, runId)).toMatchObject({ state: "unknown_running", last_receipt_id: null });
  await again.worker.recover();
  await again.connection.receive(finalize(again, runId));
  expect(again.space.cleaned).toEqual([]);
  expect(again.transport.of("receipt_cleaned")).toHaveLength(0);
  expect(onDiskRun(again.dir, runId).state).toBe("ready_result");
});

test("F03 정리 영수증만 잃은 finalized는 뒤의 취소 영수증이 포인터여도 알아채고 보류한다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  await r.connection.receive(finalize(r, runId));
  expect(r.store.run(runId)?.state).toBe("finalized");
  await r.connection.receive(cancel(r, runId));
  const pointer = onDiskRun(r.dir, runId).last_receipt_id!;
  expect(onDiskEvents(r.dir, runId).find((e) => e.id === pointer)?.body.instruction).toBe("task_cancel");
  rmSync(outboxPath(r.dir, eventOf(r.dir, runId, "receipt_cleaned").id));
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBe("receipt_missing");
  expect(await statusOf(again, runId)).toMatchObject({ state: "unknown_running", last_receipt_id: null });
  expect(again.transport.of("hello")[0]!.body.runs).toContainEqual({ run_id: runId, state: "unknown_running", run_generation: 1, last_receipt_id: null });
});

test("F03 포인터가 가리키는 사건의 본문이 어긋나면 조회에 그 ID를 내지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  expect(onDiskRun(r.dir, runId).last_receipt_id).toBe(eventOf(r.dir, runId, "receipt_stopped").id);
  breakStopped(r.dir, runId);
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(await statusOf(again, runId)).toMatchObject({ state: "unknown_running", last_receipt_id: null });
});

test("F03 보류한 실행의 취소: 프로세스는 끝내고 세되 영수증은 내지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  rmSync(outboxPath(r.dir, eventOf(r.dir, runId, "report_result").id));
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.connection.receive(cancel(again, runId));
  expect(again.cleanup.terminations).toBe(1);
  expect(receiptsOf(again, runId)).toEqual([]);
  expect(onDiskRun(again.dir, runId).state).toBe("ready_result");
});

// ---- F04 닫는 동작의 독립 ----

test("F04 미확인 실행의 취소: 접수 영수증의 저장을 기다리지 않고 정리를 시작한다", async () => {
  const disk = scriptedIo();
  const r = await make({ mode: "hang", io: disk.io, exitWaitMs: 200 });
  const { runId } = await start(r);
  await until(() => r.store.run(runId)?.state === "running");
  const stuck = gate();
  r.cleanup.inert = true;
  r.cleanup.hold = stuck.wait;
  r.cleanup.remaining = 1;
  await r.connection.receive(cancel(r, runId));
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("unknown_running");
  const before = r.cleanup.terminations;
  r.cleanup.inert = false;
  r.cleanup.hold = undefined;
  r.cleanup.remaining = 0;
  // 앞선 정리의 백엔드가 끝나야 다음 정리가 시작된다(같은 공간에 신호가 겹치지 않는다).
  const freed = reservationFreed(r.worker, runId);
  stuck.open();
  await freed;
  const writing = disk.hold(cancelReceiptWrite);
  const pending = r.connection.receive(cancel(r, runId));
  await writing.entered;
  expect(r.cleanup.terminations).toBe(before + 1);
  writing.open();
  await pending;
  expect(r.store.run(runId)?.state).toBe("failed_stopped");
  expect(r.transport.of("receipt_stopped")).toHaveLength(1);
});

test("F04 복원: 앞 실행의 보정 쓰기가 멈춰도 다음 실행의 정리를 시작한다", async () => {
  const seedDisk = scriptedIo();
  const r = await make({ io: seedDisk.io });
  const a = await start(r);
  await r.worker.idle();
  // A는 정리 영수증까지 적혔고 finalized 기록만 빠졌다. B는 실행 중에 꺼졌다.
  seedDisk.fail(runWrite("finalized"));
  await r.connection.receive(finalize(r, a.runId));
  const b = runRecord(r, "running");
  expect(await r.store.beginRun(b)).toBe(true);

  const disk = scriptedIo();
  const writing = disk.hold(runWrite("finalized"));
  const again = await make({ dir: r.dir, clock: r.clock, io: disk.io });
  // 읽는 순서는 파일 시스템이 정한다. A를 먼저 순회하도록 고정한다.
  const ordered = again.store.runs().sort((x, y) => (x.run_id === a.runId ? -1 : y.run_id === a.runId ? 1 : 0));
  again.store.runs = () => ordered;
  const recovering = again.worker.recover();
  await writing.entered;
  expect(again.cleanup.terminations).toBe(1);
  writing.open();
  await recovering;
  expect(again.store.run(a.runId)?.state).toBe("finalized");
  expect(again.store.run(b.run_id)?.state).toBe("failed_stopped");
});

// ---- F05 재시작 대조 ----

test("F05 재시작: 사건은 있고 실행 기록의 포인터만 뒤처졌으면 복원이 마지막 영수증을 함께 맞춘다", async () => {
  const disk = scriptedIo();
  disk.fail(runWrite("checking", "ready_result"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  const stopped = eventOf(r.dir, runId, "receipt_stopped");
  expect(onDiskRun(r.dir, runId).last_receipt_id).not.toBe(stopped.id);
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("ready_result");
  expect(onDiskRun(again.dir, runId).last_receipt_id).toBe(stopped.id);
  expect(await statusOf(again, runId)).toMatchObject({ state: "ready_result", last_receipt_id: stopped.id });
});

test("F05 재시작: 터미널 상태에서 뒤의 영수증만 적힌 채 꺼져도 포인터를 맞춘다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const stopped = eventOf(r.dir, runId, "receipt_stopped");
  await r.connection.receive(cancel(r, runId));
  const accepted = onDiskEvents(r.dir, runId).filter((e) => e.action === "receipt_accepted" && e.body.instruction === "task_cancel")[0]!;
  rewriteRun(r.dir, runId, { last_receipt_id: stopped.id });
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  expect(onDiskRun(again.dir, runId).last_receipt_id).toBe(accepted.id);
});

test("F05 재시작: 시작 영수증이 없고 종료 영수증만 남아도 띄우지 않았다고 확정하지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const accepted = eventOf(r.dir, runId, "receipt_accepted");
  const stopped = eventOf(r.dir, runId, "receipt_stopped");
  rmSync(outboxPath(r.dir, eventOf(r.dir, runId, "receipt_started").id));
  rmSync(outboxPath(r.dir, eventOf(r.dir, runId, "report_result").id));
  rewriteRun(r.dir, runId, { state: "stopping", last_receipt_id: accepted.id });
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("failed_stopped");
  expect(onDiskRun(again.dir, runId).last_receipt_id).toBe(stopped.id);
});

// ---- F06 요청 대조 ----

test("F06 아는 실행의 시작 지시: 처음 접수한 지시와 본문이 다르면 답하지 않고, 같으면 같은 영수증으로 답한다", async () => {
  const r = await make();
  const { runId, envelope } = await start(r);
  await r.worker.idle();
  const before = r.transport.sent.length;
  const body = envelope.body as Bodies["task_start"];
  const header = { stop_generation: 0, run_generation: 1, request_id: envelope.header.request_id };
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "task_start", { ...body, budget_tokens: body.budget_tokens + 1 }, header));
  await r.worker.idle();
  expect(r.transport.sent.length).toBe(before);
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "task_start", body, header));
  await r.worker.idle();
  expect(r.transport.of("receipt_accepted").filter((e) => e.body.run_id === runId)).toHaveLength(2);
  expect(r.launcher.spawned).toBe(1);
});

test("F06 끝난 실행의 취소: 같은 요청 ID에 본문이 다르면 마지막 영수증도 다시 보내지 않는다", async () => {
  const r = await make({ mode: "hang" });
  const { runId } = await start(r);
  await until(() => r.store.run(runId)?.state === "running");
  const requestId = randomUUID();
  await r.connection.receive(cancel(r, runId, requestId, "requested"));
  await r.worker.idle();
  expect(onDiskRun(r.dir, runId).last_receipt_id).toBe(eventOf(r.dir, runId, "receipt_stopped").id);
  const before = r.transport.sent.length;
  await r.connection.receive(cancel(r, runId, requestId, "deadline"));
  expect(r.transport.sent.length).toBe(before);
});

test("F06 정리 의도: 끝나지 않은 의도를 다른 요청이 덮지 않고, 처음 요청은 같은 영수증을 받으며 본문이 다르면 답하지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const digest = resultDigest(r.transport.of("report_result")[0]!.body.result);
  r.space.cleanResult = false;
  const first = randomUUID();
  await r.connection.receive(finalize(r, runId, first));
  const intent = (onDiskRun(r.dir, runId) as unknown as { cleanup: { request_id: string; receipt_id: string } }).cleanup;
  expect(intent.request_id).toBe(first);
  r.space.cleanResult = true;
  const second = randomUUID();
  await r.connection.receive(finalize(r, runId, second));
  expect(r.store.run(runId)?.state).toBe("finalized");
  const cleaned = () => r.store.outboxFor(runId).filter((e) => e.action === "receipt_cleaned");
  expect(cleaned().map((e) => e.body.instruction_request_id)).toEqual([first, second]);
  expect(cleaned()[0]!.id).toBe(intent.receipt_id);
  expect(r.space.cleaned).toEqual([runId, runId]);
  // 처음 요청이 돌아오면 같은 영수증이다. 같은 요청 ID에 본문이 다르면 답하지 않는다.
  const sent = r.transport.of("receipt_cleaned").length;
  await r.connection.receive(finalize(r, runId, first, { outcome: "succeeded", digest }));
  expect(r.transport.of("receipt_cleaned")).toHaveLength(sent);
  await r.connection.receive(finalize(r, runId, first));
  expect(r.transport.of("receipt_cleaned").at(-1)!.body.receipt_id).toBe(intent.receipt_id);
  expect(cleaned()).toHaveLength(2);
});

// ---- F07 장애 중의 송신 ----

test("F07 저장 장애 중에는 이미 적은 결과 보고도 보내지 않고, 회복한 뒤 보낸다", async () => {
  const disk = scriptedIo();
  // 결과 보고가 종료 영수증보다 앞 순번이라(D-167) 먼저 적힌다. 뒤의 종료 영수증 쓰기를 실패시킨다.
  const heal = disk.fail(outboxWrite("receipt_stopped"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  expect(onDiskEvents(r.dir, runId).map((e) => e.action)).toContain("report_result");
  expect(r.store.healthy()).toBe(false);
  expect(r.transport.of("report_result")).toHaveLength(0);
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  r.clock.advance(limits.RENEW_INTERVAL_MS);
  r.worker.tick();
  await r.worker.flush();
  expect(r.transport.of("report_result")).toHaveLength(0);
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  heal();
  expect(await r.worker.flush()).toBe(true);
  expect(r.transport.of("receipt_stopped")).toHaveLength(1);
  expect(r.transport.of("report_result")).toHaveLength(1);
});

test("F07 저장 장애 중의 새 취소에는 새 접수 영수증을 만들지 않는다", async () => {
  const disk = scriptedIo();
  disk.fail(outboxWrite("report_result"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  expect(r.store.healthy()).toBe(false);
  await r.connection.receive(cancel(r, runId));
  expect(r.store.outboxFor(runId).filter((e) => e.action === "receipt_accepted" && e.body.instruction === "task_cancel")).toEqual([]);
});

// ---- F08 장애는 실패한 그 연산으로만 풀린다 ----

const preparingWrite = (path: string, data: string) => path.includes("/runs/") && data.includes('"state":"preparing"');

test("F08 실제 실행 기록 쓰기가 계속 실패하면 다른 파일이 써져도 장애가 풀리지 않는다", async () => {
  const disk = scriptedIo();
  const heal = disk.fail(preparingWrite);
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  expect(r.store.run(runId)).toBeUndefined();
  expect(await r.worker.flush()).toBe(false);
  expect(r.worker.intakeClosed()).toBe("store_unavailable");
  heal();
  expect(await r.worker.flush()).toBe(true);
  expect(r.worker.intakeClosed()).toBeNull();
  // 다시 써 본 기록은 접수가 아니다. 실행 기록으로 남지 않는다.
  expect(existsSync(join(r.dir, "runs", `${runId}.json`))).toBe(false);
  expect(r.launcher.spawned).toBe(0);
});

test("F08 검사 파일 경로만 실패해도 실제 쓰기가 돌아오면 장애가 풀린다", async () => {
  const disk = scriptedIo();
  const heal = disk.fail(preparingWrite);
  disk.fail((path) => path.endsWith("/runs/probe"));
  const r = await make({ io: disk.io });
  await start(r);
  await r.worker.idle();
  heal();
  expect(await r.worker.flush()).toBe(true);
});

// ---- F09 채택 저장의 상한 ----

test("F09 세대 저장이 상한을 넘겨 끝나면 다음 tick 전이어도 연결을 열지 않는다", async () => {
  const disk = scriptedIo();
  const writing = disk.hold(stopWrite);
  const r = await make({ syncTo: null, io: disk.io });
  const reply = r.connection.receive(syncReply(r, 2));
  await writing.entered;
  r.clock.advance(limits.STOP_SYNC_WAIT_MS);
  writing.open();
  await reply;
  expect(r.transport.of("hello")).toHaveLength(0);
  expect(r.link.live()).toBe(false);
  expect(r.transport.closed).toBe(true);
  expect(r.worker.intakeClosed()).toBe("stop_generation_unsaved");
});

// ---- F10 관측한 종료의 보존 ----

test("F10 nonce 장애가 이미 정상 종료한 프로그램의 결과를 실패로 바꾸지 않는다", async () => {
  const disk = scriptedIo();
  const r = await make({ io: disk.io });
  const draining = barrier();
  fakeLauncher(r, async (hooks) => {
    hooks.exited?.();
    await draining.pass();
    return goodResult;
  });
  const { runId } = await start(r);
  await draining.entered;
  // 검증을 다 지난 봉투의 nonce 기록이 실패한다(그 봉투의 효과는 나지 않는다).
  disk.markers.failing = true;
  await r.connection.receive(cancel(r, runId));
  expect(r.transport.closed).toBe(true);
  disk.markers.failing = false;
  draining.open();
  await r.worker.idle();
  expect(r.store.outboxFor(runId).find((e) => e.action === "receipt_stopped")?.body.exit).toBe("completed");
  expect(r.store.run(runId)?.state).toBe("ready_result");
  expect(sha256(JSON.stringify(r.store.outboxFor(runId).find((e) => e.action === "report_result")?.body.result))).toBe(
    sha256(JSON.stringify(JSON.parse(new TextDecoder().decode(goodResult)))),
  );
});

// ---- G02 후보 상태의 전제 ----

test("G02 복원: 정리 영수증만 있고 종료 영수증이 없는 stopping은 finalized로 맺지 않고 슬롯을 쥔 채 보류한다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  await r.connection.receive(finalize(r, runId));
  const cleaned = eventOf(r.dir, runId, "receipt_cleaned");
  rmSync(outboxPath(r.dir, eventOf(r.dir, runId, "receipt_stopped").id));
  rewriteRun(r.dir, runId, { state: "stopping", last_receipt_id: cleaned.id });
  const again = await make({ dir: r.dir, clock: r.clock });
  // 현재 상태(stopping)에는 전제가 없어 기동 감사는 통과한다. 후보 상태에서 걸러야 한다.
  expect(again.store.inconsistency()).toBeNull();
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("unknown_running");
  expect(onDiskRun(again.dir, runId).state).toBe("unknown_running");
  expect(again.store.inconsistency()).toBe("receipt_missing");
  expect(again.cleanup.terminations).toBe(1);
  expect(await statusOf(again, runId)).toMatchObject({ state: "unknown_running", last_receipt_id: null });
  await start(again);
  await again.worker.idle();
  expect(again.launcher.spawned).toBe(0);
});

test("G02 정리 예약의 영수증 ID가 자기 종료 영수증의 것이면 지우지도 덮어쓰지도 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  r.space.cleanResult = false;
  await r.connection.receive(finalize(r, runId));
  const stopped = eventOf(r.dir, runId, "receipt_stopped");
  const path = join(r.dir, "runs", `${runId}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as { cleanup: { receipt_id: string } };
  raw.cleanup.receipt_id = stopped.id;
  writeFileSync(path, JSON.stringify(raw));
  const before = readFileSync(outboxPath(r.dir, stopped.id), "utf8");
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  await again.connection.receive(finalize(again, runId));
  expect(again.space.cleaned).toEqual([]);
  expect(readFileSync(outboxPath(again.dir, stopped.id), "utf8")).toBe(before);
  expect(onDiskRun(again.dir, runId).state).toBe("cleanup_pending");
  expect(again.store.inconsistency()).toBe("receipt_mismatch");
  expect(again.transport.of("receipt_cleaned")).toHaveLength(0);
});

test("G02 전이의 한 자리: 전제가 없는 터미널 상태와 다른 사건의 ID는 commit이 쓰지 않고 그 실행을 보류한다", async () => {
  const r = await make();
  const record = runRecord(r, "running");
  expect(await r.store.beginRun(record)).toBe(true);
  expect((await r.store.commit(record.run_id, { state: "finalized" })).saved).toBe(false);
  expect(r.store.run(record.run_id)?.state).toBe("running");
  expect(onDiskRun(r.dir, record.run_id).state).toBe("running");
  expect(r.store.suspectRun(record.run_id)).toBe(true);

  const other = await make();
  const { runId } = await start(other);
  await other.worker.idle();
  const stopped = other.store.validEvents(runId).find((e) => e.action === "receipt_stopped")!;
  const before = readFileSync(outboxPath(other.dir, stopped.id), "utf8");
  const forged = { ...stopped, action: "receipt_cleaned" as const, body: { ...stopped.body, cleaned_at: other.clock.now() } };
  expect((await other.store.commit(runId, {}, [{ entry: forged }])).saved).toBe(false);
  expect(readFileSync(outboxPath(other.dir, stopped.id), "utf8")).toBe(before);
  expect(other.store.inconsistency()).toBe("receipt_mismatch");
});

// ---- G03 정리 예약의 수명 ----

test("G03 정리 결과의 기록이 멈춰도 다음 비상 취소가 물리적 종료를 다시 시작한다", async () => {
  const disk = scriptedIo();
  const r = await make({ io: disk.io, stopWriteWaitMs: 1 });
  r.cleanup.remaining = 1;
  const { runId } = await start(r);
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("unknown_running");

  // 비상 취소는 nonce 검증을 끝낸 뒤 처리 바로 앞에서 세운다. 저장 줄이 멈춘 뒤에는 nonce도 줄을 지나지 못한다.
  const emergency = randomUUID();
  const verified = barrier();
  const handle = r.worker.handle.bind(r.worker);
  r.worker.handle = async (envelope, epoch) => {
    if (envelope.header.request_id === emergency) await verified.pass();
    return handle(envelope, epoch);
  };
  const reached = gate();
  const worker = r.worker as unknown as { onCancel(header: Header, body: unknown, epoch: number): Promise<void> };
  const onCancel = worker.onCancel.bind(r.worker);
  worker.onCancel = (header, body, epoch) => {
    const work = onCancel(header, body, epoch);
    if (header.request_id === emergency) reached.open();
    return work;
  };
  const second = r.connection.receive(
    fromSupervisor(r.clock, r.worker.name, "task_cancel", { run_id: runId, reason: "emergency_stop" }, { stop_generation: 1, run_generation: 1, request_id: emergency }),
  );
  await verified.entered;

  // 일반 취소의 정리는 양수로 끝나고, 그 상태 쓰기가 멈춘다.
  const writing = disk.hold(runWrite("unknown_running"));
  const first = r.connection.receive(cancel(r, runId));
  await writing.entered;
  const before = r.cleanup.terminations;
  verified.open();
  await reached.wait;
  expect(r.cleanup.terminations).toBe(before + 1);

  writing.open();
  await Promise.all([first, second]);
  expect(r.store.run(runId)?.state).toBe("unknown_running");
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
});

test("G03 백엔드의 정리가 끝나지 않은 동안은 다음 취소가 합류하고, 끝난 뒤에야 다시 시도한다", async () => {
  const r = await make({ exitWaitMs: 20 });
  r.cleanup.remaining = 1;
  const { runId } = await start(r);
  await r.worker.idle();
  const stuck = gate();
  r.cleanup.hold = stuck.wait;
  try {
    const base = r.cleanup.terminations;
    // 첫 정리는 상한으로 먼저 돌아오지만 백엔드의 작업은 아직 끝나지 않았다.
    await r.connection.receive(cancel(r, runId));
    expect(r.store.run(runId)?.state).toBe("unknown_running");
    expect(r.cleanup.terminations).toBe(base + 1);
    await r.connection.receive(cancel(r, runId));
    expect(r.cleanup.terminations).toBe(base + 1);
    r.cleanup.hold = undefined;
    const freed = reservationFreed(r.worker, runId);
    stuck.open();
    await freed;
    await r.connection.receive(cancel(r, runId));
    expect(r.cleanup.terminations).toBe(base + 2);
  } finally {
    // 단언이 실패해도 afterEach의 정리가 닫힌 문에 걸리지 않는다.
    r.cleanup.hold = undefined;
    stuck.open();
  }
});

// ---- G04 미확인 결과의 마지막 영수증 ----

// 사건은 started까지 적혔고 실행 기록은 preparing·accepted 포인터에 머문 채 꺼진 장부.
async function behindPointer() {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const accepted = eventOf(r.dir, runId, "receipt_accepted");
  const started = eventOf(r.dir, runId, "receipt_started");
  rmSync(outboxPath(r.dir, eventOf(r.dir, runId, "receipt_stopped").id));
  rmSync(outboxPath(r.dir, eventOf(r.dir, runId, "report_result").id));
  rewriteRun(r.dir, runId, { state: "preparing", exit: null, last_receipt_id: accepted.id });
  return { r, runId, started };
}

for (const remaining of [1, null]) {
  test(`G04 복원: 다시 센 결과가 ${remaining}이어도 마지막 영수증은 지속된 최신 영수증을 가리킨다`, async () => {
    const { r, runId, started } = await behindPointer();
    const again = await make({ dir: r.dir, clock: r.clock });
    again.cleanup.remaining = remaining;
    await again.worker.recover();
    expect(onDiskRun(again.dir, runId)).toMatchObject({ state: "unknown_running", last_receipt_id: started.id });
    const third = await make({ dir: r.dir, clock: r.clock });
    expect(third.store.inconsistency()).toBeNull();
    expect(await statusOf(third, runId)).toMatchObject({ state: "unknown_running", last_receipt_id: started.id });
  });
}

test("G04 복원: 다시 세어 0이면 그 사이 낸 종료 영수증이 포인터로 남는다", async () => {
  const { r, runId } = await behindPointer();
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  expect(onDiskRun(again.dir, runId)).toMatchObject({ state: "failed_stopped", last_receipt_id: eventOf(again.dir, runId, "receipt_stopped").id });
});

// ---- G05 최초 쓰기의 재확인 ----

test("G05 최초 쓰기를 다시 써 보다 꺼져 파일이 남아도 접수하지 않은 실행을 복구하지 않는다", async () => {
  const disk = scriptedIo();
  let left = "";
  const heal = disk.fail((path, data) => {
    if (!preparingWrite(path, data)) return false;
    left = data;
    return true;
  });
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  heal();
  expect(await r.worker.flush()).toBe(true);
  // 다시 써 본 파일을 지우기 전에 꺼진 디스크: 같은 경로에 같은 내용이 남아 있다.
  writeFileSync(join(r.dir, "runs", `${runId}.json`), left);
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  expect(again.store.run(runId)).toBeUndefined();
  expect(onDiskEvents(again.dir, runId)).toEqual([]);
  expect(await statusOf(again, runId)).toMatchObject({ state: "not_known" });
  await start(again, { runId });
  await again.worker.idle();
  expect(again.launcher.spawned).toBe(1);
});

// ---- G06 인사로 다 말할 수 없는 장부 ----

test("G06 감사 뒤 보류한 실행이 인사의 상한을 넘으면 hello를 보내지 않고 전체를 보류한다", async () => {
  const r = await make();
  for (let i = 0; i <= limits.STATUS_MAX_RUNS; i++) expect(await r.store.beginRun({ ...runRecord(r, "unknown_running"), state: "finalized" })).toBe(true);
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBe("over_capacity");
  expect(again.transport.of("hello")).toHaveLength(0);
  expect(again.transport.closed).toBe(true);
  await again.worker.flush();
  expect(JSON.parse(readFileSync(join(r.dir, "ledger-hold"), "utf8"))).toEqual({ reason: "over_capacity" });
});

test("G06 실행 기록을 잃은 사건이 있으면 점유를 다 말할 수 없으므로 hello를 보내지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  rmSync(join(r.dir, "runs", `${runId}.json`));
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBe("run_missing");
  expect(again.worker.helloWithheld()).toBe(true);
  expect(again.transport.of("hello")).toHaveLength(0);
  expect(again.transport.closed).toBe(true);
});

// ---- G07 쓰는 도중의 보류 ----

test("G07 쓰는 도중 세운 보류 판정은 그 뒤의 파일보다 먼저 지속한다", async () => {
  const disk = scriptedIo();
  // 한 전이의 첫 파일은 결과 보고다(D-167). 그 쓰기에 들어간 뒤 보류 판정을 세운다.
  const writing = disk.hold(outboxWrite("report_result"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await writing.entered;
  const heal = disk.fail((path) => path.endsWith("ledger-hold"));
  r.store.markInconsistent("outbox_body");
  writing.open();
  await r.worker.idle();
  // 이미 넘긴 쓰기 뒤의 종료 영수증과 실행 기록은 표식이 지속되기 전에 쓰지 않는다.
  expect(onDiskEvents(r.dir, runId).map((e) => e.action)).not.toContain("receipt_stopped");
  expect(onDiskRun(r.dir, runId).state).not.toBe("ready_result");
  heal();
  await r.worker.flush();
  expect(JSON.parse(readFileSync(join(r.dir, "ledger-hold"), "utf8"))).toEqual({ reason: "outbox_body" });
  expect(onDiskEvents(r.dir, runId).map((e) => e.action)).toContain("receipt_stopped");
});

// ---- G08 서명 실패와 장부 손상 ----

test("G08 서명에 쓸 수 없는 키로 떠도 정상 장부에 손상 표식을 남기지 않는다", async () => {
  const r = await make();
  await start(r);
  await r.worker.idle();
  const store = await ExecutorStore.open(r.dir, { now: r.clock.now });
  new WorkerExecutor({
    instance: "worker-1",
    profile: fakeProfile("complete", r.cwd),
    policyRevision: "policy-r1",
    store,
    signingKey: supervisorKeys.publicKey,
    supervisorKey: supervisorKeys.publicKey,
    credentials: r.credentials,
    cleanup: r.cleanup,
    space: r.space,
    podUid: POD_UID,
    now: r.clock.now,
  });
  expect(store.inconsistency()).toBeNull();
  await store.flush();
  expect(existsSync(join(r.dir, "ledger-hold"))).toBe(false);
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.worker.intakeClosed()).toBeNull();
});

test("G08 송신 때의 서명 실패는 그 송신만 미루고 표식을 세우지 않는다", async () => {
  const r = await make();
  await start(r);
  await r.worker.idle();
  const options = (r.worker as unknown as { options: { signingKey: KeyObject } }).options;
  const key = options.signingKey;
  options.signingKey = supervisorKeys.publicKey;
  const sent = r.transport.sent.length;
  r.worker.resendUnacked();
  expect(r.store.inconsistency()).toBeNull();
  expect(r.transport.sent.length).toBe(sent);
  options.signingKey = key;
  r.worker.resendUnacked();
  expect(r.transport.sent.length).toBeGreaterThan(sent);
});

// ---- G09 시작 접수의 권한 ----

test("G09 시작 기록을 적는 사이 연결이 닫히면 새 접수 영수증을 내지 않는다", async () => {
  const disk = scriptedIo();
  const writing = disk.hold(preparingWrite);
  const r = await make({ io: disk.io });
  const receiving = start(r);
  await writing.entered;
  r.connection.close();
  writing.open();
  const { runId } = await receiving;
  await r.worker.idle();
  expect(r.store.outboxFor(runId).filter((e) => e.action === "receipt_accepted")).toEqual([]);
  expect(r.launcher.spawned).toBe(0);
});

// ---- H01 첫 종료와 재정리의 같은 예약 ----

// 시험이 끝을 정하는 실행을 띄운다. entered는 프로그램이 뜬 뒤, open은 프로그램의 끝이다.
function heldRun(r: Rig) {
  const running = barrier();
  fakeLauncher(r, async (hooks) => {
    await running.pass();
    hooks.exited?.();
    return goodResult;
  });
  return running;
}

test("H01 첫 종료의 계수가 메모리에 반영된 바로 뒤에 처리되는 검증된 비상 취소도 기록을 기다리지 않고 물리적 종료를 다시 시작한다", async () => {
  const disk = scriptedIo();
  const r = await make({ io: disk.io, stopWriteWaitMs: 1 });
  r.cleanup.remaining = 1;
  const running = heldRun(r);
  const { runId } = await start(r);
  await running.entered;

  // 비상 취소는 세대 쓰기가 저장 줄을 막은 채 상한을 지나 onCancel 바로 앞에 선다. 처리는 시험이 정한 자리에서 시작한다.
  const emergency = randomUUID();
  const arrived = gate();
  let dispatch: (() => void) | undefined;
  const worker = r.worker as unknown as { onCancel(header: Header, body: unknown, epoch: number): Promise<void> };
  const onCancel = worker.onCancel.bind(r.worker);
  worker.onCancel = (header, body, epoch) => {
    if (header.request_id !== emergency) return onCancel(header, body, epoch);
    return new Promise<void>((resolve, reject) => {
      dispatch = () => void onCancel(header, body, epoch).then(resolve, reject);
      arrived.open();
    });
  };
  const handOver = () => {
    const run = dispatch;
    dispatch = undefined;
    run?.();
  };
  // 첫 정리의 계수 1이 메모리에 반영되는 바로 그때, 기다리던 취소를 처리한다. 계수 뒤 처리가 그 동기 구간에서 등록하는
  // 어떤 콜백보다도 앞선 자리다(계수 뒤 처리 바로 다음에 마이크로태스크로 이미 줄 서 있던 취소와 같다).
  const reflected = gate();
  let restarted: number | undefined;
  const commit = r.store.commit.bind(r.store);
  r.store.commit = (id, patch, events) => {
    const done = commit(id, patch, events);
    if (id === runId && patch.state === "unknown_running" && dispatch !== undefined) {
      const before = r.cleanup.terminations;
      handOver();
      restarted = r.cleanup.terminations - before;
      reflected.open();
    }
    return done;
  };
  const stopWriting = disk.hold(stopWrite);
  const receiving = r.connection.receive(
    fromSupervisor(r.clock, r.worker.name, "task_cancel", { run_id: runId, reason: "emergency_stop" }, { stop_generation: 1, run_generation: 1, request_id: emergency }),
  );
  await stopWriting.entered;
  await arrived.wait;

  try {
    // 프로그램이 끝나고 첫 정리의 계수 1이 메모리에 반영된다. 그 상태 쓰기는 세대 쓰기 뒤에 멈춰 있다.
    running.open();
    await reflected.wait;
    expect(onDiskRun(r.dir, runId).state).not.toBe("unknown_running");
    expect(restarted).toBe(1);
  } finally {
    running.open();
    handOver();
    stopWriting.open();
  }
  await receiving;
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("unknown_running");
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
});

test("H01 첫 종료의 백엔드가 도는 동안 다음 취소는 합류하고, 끝난 뒤에는 기록이 멈춰 있어도 다시 시작한다", async () => {
  const disk = scriptedIo();
  const r = await make({ io: disk.io, exitWaitMs: 20 });
  r.cleanup.remaining = 1;
  const stuck = gate();
  r.cleanup.hold = stuck.wait;
  const running = heldRun(r);
  const { runId } = await start(r);
  await running.entered;

  // 저장 줄이 멈춘 뒤에는 nonce도 줄을 지나지 못하므로 취소 둘은 검증까지 끝낸 뒤 처리 바로 앞에서 세운다.
  const ids: readonly [string, string] = [randomUUID(), randomUUID()];
  const verified = new Map(ids.map((id) => [id, barrier()]));
  const reached = new Map(ids.map((id) => [id, gate()]));
  const handle = r.worker.handle.bind(r.worker);
  r.worker.handle = async (envelope, epoch) => {
    await verified.get(envelope.header.request_id)?.pass();
    const work = handle(envelope, epoch);
    reached.get(envelope.header.request_id)?.open();
    return work;
  };
  const writing = disk.hold(runWrite("unknown_running"));
  const receiving = ids.map((id) => r.connection.receive(cancel(r, runId, id)));
  await Promise.all(ids.map((id) => verified.get(id)!.entered));
  try {
    running.open();
    await writing.entered;
    const base = r.cleanup.terminations;
    verified.get(ids[0])!.open();
    await reached.get(ids[0])!.wait;
    expect(r.cleanup.terminations).toBe(base);

    r.cleanup.hold = undefined;
    const freed = reservationFreed(r.worker, runId);
    stuck.open();
    await freed;
    verified.get(ids[1])!.open();
    await reached.get(ids[1])!.wait;
    expect(r.cleanup.terminations).toBe(base + 1);
  } finally {
    r.cleanup.hold = undefined;
    stuck.open();
    for (const id of ids) verified.get(id)!.open();
    writing.open();
  }
  await Promise.all(receiving);
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("unknown_running");
});

test("H01 첫 종료가 예외로 끝나도 백엔드가 끝나기 전에는 새 정리를 시작하지 않는다", async () => {
  const r = await make({ exitWaitMs: 20 });
  const stuck = gate();
  r.cleanup.hold = stuck.wait;
  const running = heldRun(r);
  const { runId } = await start(r);
  await running.entered;
  // 종료 영수증을 만들 때 서명이 실패한다. 백엔드의 terminate는 아직 돌아오지 않았다.
  const options = (r.worker as unknown as { options: { signingKey: KeyObject } }).options;
  const key = options.signingKey;
  options.signingKey = supervisorKeys.publicKey;
  try {
    running.open();
    await r.worker.idle();
    options.signingKey = key;
    expect(r.store.run(runId)?.state).toBe("unknown_running");
    const base = r.cleanup.terminations;
    await r.connection.receive(cancel(r, runId));
    expect(r.cleanup.terminations).toBe(base);

    r.cleanup.hold = undefined;
    const freed = reservationFreed(r.worker, runId);
    stuck.open();
    await freed;
    await r.connection.receive(cancel(r, runId));
    expect(r.cleanup.terminations).toBe(base + 1);
    expect(r.store.run(runId)?.state).toBe("failed_stopped");
  } finally {
    options.signingKey = key;
    r.cleanup.hold = undefined;
    stuck.open();
  }
});

test("H01 대조군: 다른 실행이 도는 동안에는 옛 실행의 취소가 공간을 정리하지 않는다", async () => {
  const r = await make();
  const { runId: earlier } = await start(r);
  await r.worker.idle();
  const running = heldRun(r);
  const { runId: current } = await start(r);
  await running.entered;
  try {
    await r.store.noteRun({ ...r.store.run(earlier)!, state: "unknown_running" });
    const before = r.cleanup.terminations;
    await r.connection.receive(cancel(r, earlier));
    expect(r.cleanup.terminations).toBe(before);
    expect(r.store.run(current)?.state).toBe("running");
  } finally {
    // 단언이 실패해도 역할 프로그램의 끝을 열어 afterEach가 닫힌 문에 걸리지 않는다.
    running.open();
    await r.worker.idle();
  }
});

// ---- H02 실제 점유로 세는 상한 ----

const leftover = (r: Rig) => ({ ...runRecord(r, "running"), state: "preparing" as const });

test("H02 사건 없는 preparing 기록이 아홉이어도 보류하지 않고 새 시작을 받으며, 그 파일을 지우지 않는다", async () => {
  const r = await make();
  const records = Array.from({ length: limits.STATUS_MAX_RUNS + 1 }, () => leftover(r));
  for (const record of records) expect(await r.store.beginRun(record)).toBe(true);
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBeNull();
  expect(existsSync(join(r.dir, "ledger-hold"))).toBe(false);
  expect(again.worker.intakeClosed()).toBeNull();
  expect(again.transport.of("hello")).toHaveLength(1);
  const { runId } = await start(again);
  await again.worker.idle();
  expect(again.launcher.spawned).toBe(1);
  expect(again.store.run(runId)?.state).toBe("ready_result");
  for (const record of records) expect(existsSync(join(r.dir, "runs", `${record.run_id}.json`))).toBe(true);
});

test("H02 경계: 진짜 점유 여덟에 사건 없는 기록이 더해져도 보류하지 않는다", async () => {
  const r = await make();
  for (let i = 0; i < limits.STATUS_MAX_RUNS; i++) expect(await r.store.beginRun(runRecord(r, "unknown_running"))).toBe(true);
  expect(await r.store.beginRun(leftover(r))).toBe(true);
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBeNull();
  expect(again.transport.of("hello")[0]!.body.runs).toHaveLength(limits.STATUS_MAX_RUNS);
});

test("H02 진짜 점유 아홉은 표식을 먼저 남기고 보류하며, 표식을 적지 못하면 열지 않는다", async () => {
  const r = await make();
  for (let i = 0; i <= limits.STATUS_MAX_RUNS; i++) expect(await r.store.beginRun(runRecord(r, "unknown_running"))).toBe(true);
  const disk = scriptedIo();
  disk.fail((path) => path.endsWith("ledger-hold"));
  const outcome = await ExecutorStore.open(r.dir, { now: r.clock.now, io: disk.io }).then(
    () => "opened",
    (error: StoreError) => error.code,
  );
  expect(outcome).toBe("store_unavailable");
  expect(existsSync(join(r.dir, "ledger-hold"))).toBe(false);
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBe("over_capacity");
  expect(JSON.parse(readFileSync(join(r.dir, "ledger-hold"), "utf8"))).toEqual({ reason: "over_capacity" });
  expect(again.transport.of("hello")).toHaveLength(0);
  expect(again.transport.closed).toBe(true);
});

test("H02 이미 적힌 over_capacity 표식은 실제 점유가 없어도 저절로 지우지 않는다", async () => {
  const r = await make();
  for (let i = 0; i <= limits.STATUS_MAX_RUNS; i++) expect(await r.store.beginRun(leftover(r))).toBe(true);
  writeFileSync(join(r.dir, "ledger-hold"), JSON.stringify({ reason: "over_capacity" }));
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBe("over_capacity");
  expect(JSON.parse(readFileSync(join(r.dir, "ledger-hold"), "utf8"))).toEqual({ reason: "over_capacity" });
  expect(again.transport.of("hello")).toHaveLength(0);
});

test("H02 기동 뒤 점유가 아홉이 되면 일부만 담은 hello를 보내지 않고, 여덟로 줄면 다시 인사한다", async () => {
  const r = await make();
  const records = Array.from({ length: limits.STATUS_MAX_RUNS }, () => runRecord(r, "unknown_running"));
  for (const record of records) expect(await r.store.beginRun(record)).toBe(true);
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.transport.of("hello")).toHaveLength(1);

  const ninth = runRecord(again, "unknown_running");
  expect(await again.store.beginRun(ninth)).toBe(true);
  await reconnect(again, 0);
  expect(again.transport.of("hello")).toHaveLength(0);
  expect(again.transport.closed).toBe(true);
  expect(again.store.inconsistency()).toBeNull();

  const id = randomUUID();
  const body = { receipt_id: id, run_id: ninth.run_id, remaining_processes: 0, exit: "failed", stopped_at: again.clock.now() };
  await again.store.commit(ninth.run_id, { state: "failed_stopped" }, [{ entry: { id, action: "receipt_stopped", run_id: ninth.run_id, run_generation: 1, body, acked: false } }]);
  await reconnect(again, 0);
  const listed = again.transport.of("hello")[0]!.body.runs.map((run) => run.run_id);
  expect(listed).toEqual(expect.arrayContaining(records.map((record) => record.run_id)));
});

// 같은 실행·세대의 종료 영수증과 맞는 마지막 포인터를 가진 failed_stopped 실행. 슬롯을 쥐지 않으므로 몇 개든 기동을 막지 않는다.
async function stoppedRuns(r: Rig, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const record = runRecord(r, "unknown_running");
    expect(await r.store.beginRun(record)).toBe(true);
    const id = randomUUID();
    const body = { receipt_id: id, run_id: record.run_id, remaining_processes: 0, exit: "failed", stopped_at: r.clock.now() };
    const { saved } = await r.store.commit(record.run_id, { state: "failed_stopped" }, [
      { entry: { id, action: "receipt_stopped", run_id: record.run_id, run_generation: 1, body, acked: false } },
    ]);
    expect(saved).toBe(true);
    ids.push(record.run_id);
  }
  return ids;
}

test("H02 점유가 여덟이면 점유하지 않던 실행에 새 정리를 예약하지 않고, 점유 중인 실행의 재시도는 받으며, 자리가 나면 아홉째도 정리한다", async () => {
  const seed = await make();
  const ids = await stoppedRuns(seed, limits.STATUS_MAX_RUNS + 1);
  const r = await make({ dir: seed.dir, clock: seed.clock });
  await r.worker.recover();
  expect(r.store.inconsistency()).toBeNull();
  expect(r.transport.of("hello")).toHaveLength(1);
  const ninth = ids.at(-1)!;

  // 폴더 지우기가 실패해 서명된 확정마다 cleanup_pending이 남는다. 여덟에 이르면 아홉째는 예약하지 않는다.
  r.space.cleanResult = false;
  for (const id of ids) await r.connection.receive(finalize(r, id));
  expect(r.space.cleaned).toEqual(ids.slice(0, limits.STATUS_MAX_RUNS));
  expect(r.store.run(ninth)?.state).toBe("failed_stopped");
  expect(onDiskRun(r.dir, ninth).state).toBe("failed_stopped");
  // 이미 점유 중인 실행의 정리 재시도는 상한에서도 받는다.
  await r.connection.receive(finalize(r, ids[0]!));
  expect(r.space.cleaned).toHaveLength(limits.STATUS_MAX_RUNS + 1);
  expect(r.store.run(ids[0]!)?.state).toBe("cleanup_pending");

  // 지우기가 회복된 뒤 재연결하면 인사하고, 정리 재시도로 자리가 나면 아홉째도 정리한다.
  r.space.cleanResult = true;
  await reconnect(r, 0);
  expect(r.transport.closed).toBe(false);
  expect(r.transport.of("hello")).toHaveLength(1);
  await r.connection.receive(finalize(r, ids[0]!));
  expect(r.store.run(ids[0]!)?.state).toBe("finalized");
  await r.connection.receive(finalize(r, ninth));
  expect(r.store.run(ninth)?.state).toBe("finalized");
  expect(r.transport.of("receipt_cleaned").map((receipt) => receipt.body.run_id)).toEqual(expect.arrayContaining([ids[0], ninth]));

  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBeNull();
  expect(again.transport.of("hello")).toHaveLength(1);
});

// ---- H03 본문 대조를 끝내지 못한 기동 ----

function workerOver(r: Rig, store: ExecutorStore, now: () => number) {
  return new WorkerExecutor({
    instance: "worker-1",
    profile: fakeProfile("complete", r.cwd),
    policyRevision: "policy-r1",
    store,
    signingKey: executorKeys.privateKey,
    supervisorKey: supervisorKeys.publicKey,
    credentials: r.credentials,
    cleanup: r.cleanup,
    space: r.space,
    podUid: POD_UID,
    now,
  });
}

function refusesToBuild(build: () => unknown): boolean {
  try {
    build();
    return false;
  } catch {
    return true;
  }
}

test("H03 본문 검사 전에 실패한 기동은 실행기를 만들지 않고 표식도 남기지 않으며, 회복하면 계약에 맞지 않는 종료 영수증으로 슬롯을 열지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  await r.store.noteRun({ ...r.store.run(runId)!, state: "stopping" });
  breakStopped(r.dir, runId);
  const failures: (() => number)[] = [
    () => 0,
    () => {
      throw new Error("clock");
    },
  ];
  for (const now of failures) {
    const store = await ExecutorStore.open(r.dir, { now: r.clock.now });
    expect(refusesToBuild(() => workerOver(r, store, now))).toBe(true);
    expect(store.inconsistency()).toBeNull();
    await store.flush();
    expect(existsSync(join(r.dir, "ledger-hold"))).toBe(false);
  }
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBe("outbox_body");
  again.cleanup.remaining = null;
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("unknown_running");
  await start(again);
  await again.worker.idle();
  expect(again.launcher.spawned).toBe(0);
});

test("H03 정상 장부는 로컬 실패가 사라진 뒤 표식 없이 다시 열려 정상 대조가 돈다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const store = await ExecutorStore.open(r.dir, { now: r.clock.now });
  expect(refusesToBuild(() => workerOver(r, store, () => 0))).toBe(true);
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBeNull();
  expect(again.worker.intakeClosed()).toBeNull();
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("ready_result");
});

// ---- H05 표식 확인 뒤의 파일 작업 ----

// 표식 확인이 돌아온 뒤, 부르는 쪽의 파일 작업이 시작되기 전에 판정을 한 번 세운다.
function verdictAfterCheck(store: ExecutorStore) {
  const target = store as unknown as { persistHold(): Promise<boolean> };
  const persist = target.persistHold.bind(store);
  let armed = true;
  target.persistHold = async () => {
    const saved = await persist();
    if (armed) {
      armed = false;
      store.markInconsistent("outbox_body");
    }
    return saved;
  };
}

const holdSites: Record<string, (r: Rig, runId: string) => { file: string; act: () => Promise<unknown> }> = {
  "실행 기록": (r, runId) => ({ file: `${runId}.json`, act: () => r.store.commit(runId, {}) }),
  "정지 세대": (r) => ({ file: "stop-generation.json", act: () => r.store.adoptStopGeneration(9) }),
  "최초 기록": (r) => {
    const record = runRecord(r, "running");
    return { file: `${record.run_id}.json`, act: () => r.store.beginRun(record) };
  },
  "받음 표시": (r, runId) => {
    const event = r.store.outboxFor(runId)[0]!;
    return { file: `${event.id}.json`, act: () => r.store.ack([event.id]) };
  },
};

for (const [site, plan] of Object.entries(holdSites)) {
  test(`H05 확인이 돌아온 뒤 선 판정은 ${site} 파일보다 먼저 지속한다`, async () => {
    const disk = scriptedIo();
    const order: string[] = [];
    const write = disk.io.writeDurable!;
    disk.io.writeDurable = async (path, data) => {
      order.push(path.split("/").at(-1)!);
      await write(path, data);
    };
    const r = await make({ io: disk.io });
    const { runId } = await start(r);
    await r.worker.idle();
    const { file, act } = plan(r, runId);
    order.length = 0;
    verdictAfterCheck(r.store);
    await act();
    await r.store.flush();
    expect(order).toContain("ledger-hold");
    expect(order).toContain(file);
    expect(order.indexOf("ledger-hold")).toBeLessThan(order.indexOf(file));
  });
}

test("H05 재확인 파일은 다시 쓰는 사이 선 판정이 지속되기 전에 지우지 않는다", async () => {
  const disk = scriptedIo();
  const heal = disk.fail(preparingWrite);
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  expect(r.worker.intakeClosed()).toBe("store_unavailable");
  heal();
  const path = join(r.dir, "runs", `${runId}.json`);
  const writing = disk.hold(preparingWrite);
  const flushing = r.worker.flush();
  await writing.entered;
  const healHold = disk.fail((file) => file.endsWith("ledger-hold"));
  r.store.markInconsistent("outbox_body");
  writing.open();
  await flushing;
  expect(existsSync(path)).toBe(true);
  expect(r.store.healthy()).toBe(false);
  healHold();
  await r.worker.flush();
  expect(JSON.parse(readFileSync(join(r.dir, "ledger-hold"), "utf8"))).toEqual({ reason: "outbox_body" });
  expect(existsSync(path)).toBe(false);
});
