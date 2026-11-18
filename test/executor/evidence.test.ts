// 유효한 상태의 한 자리, 판정의 지속, 닫는 동작의 독립, 장애 중의 송신, 요청 대조의 시험.
// 규칙: 불확실하면 슬롯을 쥔 채 권한을 주는 동작을 닫고, 이미 맡은 실행을 멈추는 일은 장부 쓰기와 독립적으로 시작한다.
// 순서는 고정 장벽(쓰기에 실제로 들어갔다는 신호)으로 만든다. 다시 열기는 같은 폴더를 새 저장소로 여는 것으로 재시작을 흉내 낸다.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Bodies, limits, resultDigest } from "../../src/contract/v1/index.ts";
import type { LaunchHooks } from "../../src/executor/launcher.ts";
import { ExecutorStore, type StoreError } from "../../src/executor/store.ts";
import {
  barrier,
  cancelReceiptWrite,
  fromSupervisor,
  onDiskEvents,
  onDiskRun,
  outboxWrite,
  pause,
  rig,
  type Rig,
  runWrite,
  scriptedIo,
  sha256,
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
  r.cleanup.inert = true;
  r.cleanup.hold = new Promise(() => {});
  r.cleanup.remaining = 1;
  await r.connection.receive(cancel(r, runId));
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("unknown_running");
  const before = r.cleanup.terminations;
  r.cleanup.inert = false;
  r.cleanup.hold = undefined;
  r.cleanup.remaining = 0;
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

test("F07 저장 장애 중에는 이미 적은 종료 영수증도 보내지 않고, 회복한 뒤 보낸다", async () => {
  const disk = scriptedIo();
  const heal = disk.fail(outboxWrite("report_result"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  expect(onDiskEvents(r.dir, runId).map((e) => e.action)).toContain("receipt_stopped");
  expect(r.store.healthy()).toBe(false);
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  r.clock.advance(limits.RENEW_INTERVAL_MS);
  r.worker.tick();
  await r.worker.flush();
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
