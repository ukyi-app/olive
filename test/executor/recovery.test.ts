// 실행 상태와 그 사건을 하나의 복구 가능한 전이로 남기는지, 저장이 멈추거나 고장 나도 닫는 효과가 먼저 나는지, 설명할 수 없는 장부를 쓰지 않는지.
// 순서는 고정 장벽(쓰기·지우기에 실제로 들어갔다는 신호)으로 만든다. 다시 열기는 같은 폴더를 새 저장소로 여는 것으로 재시작을 흉내 낸다.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { limits } from "../../src/contract/v1/index.ts";
import { barrier, fromSupervisor, onDiskEvents, onDiskRun, outboxWrite, pause, rig, type Rig, runWrite, scriptedIo, start, until } from "./support.ts";

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

const finalize = (r: Rig, runId: string, requestId = randomUUID()) =>
  fromSupervisor(r.clock, r.worker.name, "result_finalize", { run_id: runId, outcome: "failed", result_digest: null, stored_at: r.clock.now() }, { stop_generation: 0, run_generation: 1, request_id: requestId });
const emergency = (r: Rig, runId: string, stop: number) =>
  fromSupervisor(r.clock, r.worker.name, "task_cancel", { run_id: runId, reason: "emergency_stop" }, { stop_generation: stop, run_generation: 1 });
const idsOf = (r: Rig, runId: string, action: string) => r.store.outboxFor(runId).filter((e) => e.action === action).map((e) => e.id);
const bodyOf = (dir: string, runId: string, action: string) => onDiskEvents(dir, runId).find((e) => e.action === action)?.body;

// ---- R01 ----

test("R01 stopped만 실패: 종료 영수증이 디스크에 없으면 ready_result도 결과도 남지 않고, 회복하면 같은 ID·같은 본문으로 잇는다", async () => {
  const disk = scriptedIo();
  const heal = disk.fail(outboxWrite("receipt_stopped"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  expect(onDiskRun(r.dir, runId).state).not.toBe("ready_result");
  expect(onDiskEvents(r.dir, runId).map((e) => e.action)).not.toContain("report_result");
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  const [stopped] = idsOf(r, runId, "receipt_stopped");
  const [report] = idsOf(r, runId, "report_result");
  heal();
  expect(await r.worker.flush()).toBe(true);
  expect(r.transport.actions().slice(-2)).toEqual(["receipt_stopped", "report_result"]);
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("ready_result");
  expect(idsOf(again, runId, "receipt_stopped")).toEqual([stopped!]);
  expect(idsOf(again, runId, "report_result")).toEqual([report!]);
});

test("R01 stopped만 실패한 채 재시작: 없는 영수증을 전제로 성공 상태를 만들지 않고 남은 수를 다시 센다", async () => {
  const disk = scriptedIo();
  disk.fail(outboxWrite("receipt_stopped"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  expect(again.cleanup.survivorChecks).toBeGreaterThan(0);
  expect(again.store.run(runId)?.state).toBe("failed_stopped");
  expect(idsOf(again, runId, "receipt_stopped")).toHaveLength(1);
  expect(idsOf(again, runId, "report_result")).toHaveLength(0);
});

test("R01 result만 실패: 종료 영수증은 남아도 결과가 없으면 ready_result가 디스크에 없고, 재시작하면 같은 종료 영수증으로 실패로 맺는다", async () => {
  const disk = scriptedIo();
  disk.fail(outboxWrite("report_result"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  expect(onDiskRun(r.dir, runId).state).not.toBe("ready_result");
  const stopped = bodyOf(r.dir, runId, "receipt_stopped");
  expect(stopped).toBeDefined();
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("failed_stopped");
  expect(bodyOf(again.dir, runId, "receipt_stopped")).toEqual(stopped!);
  expect(idsOf(again, runId, "receipt_stopped")).toHaveLength(1);
});

test("R01 복구 대조: 끝을 모른다고 적힌 실행도 같은 실행·세대의 종료 영수증이 지속돼 있으면 같은 ID로 최종 상태를 맺는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const stopped = idsOf(r, runId, "receipt_stopped");
  await r.store.noteRun({ ...r.store.run(runId)!, state: "unknown_running" });
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("ready_result");
  expect(idsOf(again, runId, "receipt_stopped")).toEqual(stopped);
  expect(again.cleanup.survivorChecks).toBe(0);
});

test("R01 runs만 실패: 사건이 다 있고 실행 기록만 stopping에 남아도 재시작이 같은 ID·본문으로 ready_result를 잇는다", async () => {
  const disk = scriptedIo();
  disk.fail(runWrite("checking", "ready_result"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  expect(onDiskRun(r.dir, runId).state).toBe("stopping");
  const stopped = bodyOf(r.dir, runId, "receipt_stopped");
  const report = bodyOf(r.dir, runId, "report_result");
  expect(stopped).toBeDefined();
  expect(report).toBeDefined();
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("ready_result");
  expect(bodyOf(again.dir, runId, "receipt_stopped")).toEqual(stopped!);
  expect(bodyOf(again.dir, runId, "report_result")).toEqual(report!);
  expect(idsOf(again, runId, "receipt_stopped")).toHaveLength(1);
  expect(idsOf(again, runId, "report_result")).toHaveLength(1);
});

// ---- R02 ----

test("R02 재시작: 지우는 중에 꺼져도 디스크가 슬롯을 쥐어 새 시작을 받지 않고, 같은 확정이 같은 영수증 ID로 잇는다", async () => {
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
  const envelope = finalize(r, runId, requestId);
  void r.connection.receive(envelope);
  await deleting.entered;
  expect(onDiskRun(r.dir, runId).state).toBe("cleanup_pending");

  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("cleanup_pending");
  await start(again);
  await again.worker.idle();
  expect(again.launcher.spawned).toBe(0);

  await again.connection.receive(finalize(again, runId, requestId));
  expect(again.space.cleaned).toEqual([runId]);
  expect(again.store.run(runId)?.state).toBe("finalized");
  const intent = (onDiskRun(again.dir, runId) as unknown as { cleanup: { receipt_id: string } }).cleanup;
  expect(idsOf(again, runId, "receipt_cleaned")).toEqual([intent.receipt_id]);
});

test("R02 재시작: 정리 영수증을 적은 뒤 finalized를 적기 전에 꺼지면 다시 지우지 않고 같은 ID로 맺는다", async () => {
  const disk = scriptedIo();
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  disk.fail(runWrite("finalized"));
  const requestId = randomUUID();
  await r.connection.receive(finalize(r, runId, requestId));
  expect(r.space.cleaned).toEqual([runId]);
  const ids = onDiskEvents(r.dir, runId).filter((e) => e.action === "receipt_cleaned").map((e) => e.id);
  expect(ids).toHaveLength(1);
  expect(onDiskRun(r.dir, runId).state).not.toBe("finalized");

  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("finalized");
  await again.connection.receive(finalize(again, runId, requestId));
  expect(again.space.cleaned).toEqual([]);
  expect(idsOf(again, runId, "receipt_cleaned")).toEqual(ids);
  expect(again.transport.of("receipt_cleaned").map((e) => e.body.receipt_id)).toContain(ids[0]!);
});

test("R02 의도 뒤 재확인: 정리 의도를 적는 사이 연결이 바뀌면 지우지 않고 슬롯을 쥔 채로 둔다", async () => {
  const disk = scriptedIo();
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  const writing = disk.hold(runWrite("cleanup_pending"));
  const pending = r.connection.receive(finalize(r, runId));
  await writing.entered;
  r.link.open(new (r.transport.constructor as new () => typeof r.transport)());
  writing.open();
  await pending;
  expect(r.space.cleaned).toEqual([]);
  expect(onDiskRun(r.dir, runId).state).toBe("cleanup_pending");
});

test("R02 멈춘 정리: 지우기가 끝나지 않아도 슬롯을 놓지 않고 상태 조회에 cleanup_pending으로 보인다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const deleting = barrier();
  r.space.clean = async () => {
    await deleting.pass();
    return true;
  };
  void r.connection.receive(finalize(r, runId));
  await deleting.entered;
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "status_query", { run_ids: [runId] }, { stop_generation: 0 }));
  expect(r.transport.of("status_report").at(-1)!.body.runs[0]!.state).toBe("cleanup_pending");
  await start(r);
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(1);
  deleting.open();
});

// ---- R03 ----

test("R03 nonce 장애: 루트만 써지는 저장 장치에서 비상 종료의 nonce를 못 적으면 접수된 준비가 spawn으로 이어지지 않고 장애가 풀리지 않는다", async () => {
  const disk = scriptedIo();
  const r = await make({ io: disk.io });
  const waiting = barrier();
  r.credentials.before = () => waiting.pass();
  const { runId } = await start(r);
  await waiting.entered;
  // nonce 배타 생성만 고장 난다. 일반 파일 쓰기는 계속 성공한다.
  disk.markers.failing = true;
  await r.connection.receive(emergency(r, runId, 4));
  expect(r.store.healthy()).toBe(false);
  await r.worker.flush();
  r.worker.tick();
  await r.worker.flush();
  expect(r.store.healthy()).toBe(false);
  expect(r.worker.intakeClosed()).toBe("store_unavailable");
  waiting.open();
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(0);
  expect(r.store.run(runId)?.state).toBe("not_started");
  // 거절된 봉투의 세대는 적용하지 않는다.
  expect(r.store.stopGeneration()).toBe(0);
  // 그 연결은 닫혀 재개하지 않는다. 실제 배타 생성이 돌아오고 새 연결에서 맞춘 뒤에야 다시 받는다.
  expect(r.transport.closed).toBe(true);
  disk.markers.failing = false;
  expect(await r.worker.flush()).toBe(true);
  expect(r.worker.intakeClosed()).toBeNull();
});

test("R03 nonce 장애: 실행 중인 작업은 안전한 종료를 시작한다(임대를 기다리지 않는다)", async () => {
  const disk = scriptedIo();
  const r = await make({ mode: "hang", io: disk.io });
  const { runId } = await start(r);
  await until(() => r.store.run(runId)?.state === "running");
  disk.markers.failing = true;
  await r.connection.receive(emergency(r, runId, 4));
  await r.worker.idle();
  expect(r.cleanup.terminations).toBeGreaterThan(0);
  expect(r.store.run(runId)?.state).toBe("failed_stopped");
  expect(r.store.outboxFor(runId).find((e) => e.action === "receipt_stopped")?.body.exit).toBe("failed");
});

// ---- R04 ----

test("R04 시작 영수증 쓰기가 멈춰도 자식이 끝나면 저장을 기다리지 않고 남은 후손 정리를 시작한다", async () => {
  const disk = scriptedIo();
  const writing = disk.hold(outboxWrite("receipt_started"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await writing.entered;
  await until(() => r.cleanup.terminations > 0);
  // 저장은 아직 멈춰 있다. 거짓 0 영수증도 없다.
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  writing.open();
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("ready_result");
  expect(r.transport.actions().filter((a) => a.startsWith("receipt_"))).toEqual(["receipt_accepted", "receipt_started", "receipt_stopped"]);
});

test("R04 정상 종료 뒤 stopping 쓰기가 멈춰도 남은 후손 정리는 저장보다 먼저 시작한다", async () => {
  const disk = scriptedIo();
  const writing = disk.hold(runWrite("stopping"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await writing.entered;
  await until(() => r.cleanup.terminations > 0);
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  writing.open();
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("ready_result");
});

test("R04 상태 쓰기가 멈춰도 임대가 끝난 실행의 정리는 저장보다 먼저 시작한다", async () => {
  const disk = scriptedIo();
  const r = await make({ mode: "hang", io: disk.io });
  const { runId } = await start(r);
  await until(() => r.store.run(runId)?.state === "running");
  const writing = disk.hold(runWrite("stopping"));
  r.clock.advance(limits.RUN_LEASE_MAX_MS);
  r.worker.tick();
  await writing.entered;
  await until(() => r.cleanup.terminations > 0);
  writing.open();
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("failed_stopped");
});

test("R04 마지막 계수가 끝나지 않으면 상한에서 슬롯을 쥔 unknown_running으로 두고 0을 만들어 내지 않는다", async () => {
  const r = await make({ exitWaitMs: 50 });
  const counting = barrier();
  r.cleanup.survivors = async () => {
    await counting.pass();
    return 0;
  };
  const { runId } = await start(r);
  await counting.entered;
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("unknown_running");
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  // 늦게 돌아온 계수도 영수증을 만들지 못한다.
  counting.open();
  await r.worker.flush();
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  expect(r.store.run(runId)?.state).toBe("unknown_running");
});

// ---- R05 ----

test("R05 ID 유실: 같은 폴더를 두 번 열어도 접수가 닫혀 있고, 첫 연결은 예전 사건을 새 이름으로 보내지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  rmSync(join(r.dir, "storage-id"));
  const first = await make({ dir: r.dir, clock: r.clock });
  expect(first.store.inconsistency()).toBe("storage_id_lost");
  expect(first.worker.intakeClosed()).toBe("store_inconsistent");
  expect(first.transport.sent.filter((e) => e.header.action.startsWith("receipt_") || e.header.action === "report_result")).toEqual([]);
  expect(first.transport.of("hello")).toHaveLength(0);

  const second = await make({ dir: r.dir, clock: r.clock });
  expect(second.store.storageId).toBe(first.store.storageId);
  expect(second.store.inconsistency()).toBe("storage_id_lost");
  expect(second.worker.intakeClosed()).toBe("store_inconsistent");
  expect(second.transport.actions()).toEqual(["stop_sync_request"]);
  await second.worker.recover();
  expect(second.store.outboxFor(runId).filter((e) => e.action === "receipt_stopped")).toHaveLength(1);
  await start(second);
  await second.worker.idle();
  expect(second.launcher.spawned).toBe(0);
});

test("R05 서명 불가 항목: 다시 서명할 수 없는 사건 하나를 빼고 뒤의 정상 사건은 첫 연결에서 다시 보낸다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const stopped = onDiskEvents(r.dir, runId).find((e) => e.action === "receipt_stopped")!;
  const path = join(r.dir, "outbox", `${stopped.id}.json`);
  const raw = JSON.parse(await Bun.file(path).text()) as { body: Record<string, unknown> };
  raw.body.remaining_processes = 3;
  await Bun.write(path, JSON.stringify(raw));
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBe("outbox_body");
  expect(again.worker.intakeClosed()).toBe("store_inconsistent");
  const sent = again.transport.sent.filter((e) => e.header.action.startsWith("receipt_") || e.header.action === "report_result");
  const sentIds = sent.map((e) => (e.body as { receipt_id?: string; report_id?: string }).receipt_id ?? (e.body as { report_id: string }).report_id);
  expect(sentIds).not.toContain(stopped.id);
  expect(sent.map((e) => e.header.action)).toEqual(["receipt_accepted", "receipt_started", "report_result"]);
  expect(again.transport.of("hello")[0]!.body.unacked_ids).not.toContain(stopped.id);
});

test("R05 불일치 증거: 다시 서명할 수 없는 종료 영수증은 복구 증거로 쓰지 않아 최종 상태를 맺지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  await r.store.noteRun({ ...r.store.run(runId)!, state: "stopping" });
  const stopped = onDiskEvents(r.dir, runId).find((e) => e.action === "receipt_stopped")!;
  const path = join(r.dir, "outbox", `${stopped.id}.json`);
  const raw = JSON.parse(await Bun.file(path).text()) as { body: Record<string, unknown> };
  raw.body.remaining_processes = 3;
  await Bun.write(path, JSON.stringify(raw));
  const again = await make({ dir: r.dir, clock: r.clock });
  again.cleanup.remaining = null;
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("unknown_running");
});
