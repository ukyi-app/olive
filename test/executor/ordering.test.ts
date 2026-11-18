// 검증과 효과 사이, 저장을 기다리는 사이, 재접속과 늦은 결과 사이의 순서 시험.
// 효과(자격 요청, spawn, 임대 연장, 폴더 지우기, 영수증)마다 그 직전에 다시 확인하는 것이 실제로 막는지를 본다.
// 역할 프로그램은 실제로 띄우고 신호는 자식 핸들로만 보낸다(support.ts). 남은 프로세스 판정은 가짜 정리가 정한다.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { limits, resultDigest } from "../../src/contract/v1/index.ts";
import type { StoreIo } from "../../src/executor/store.ts";
import { barrier, type Barrier, cancelReceiptWrite, fromSupervisor, gate, pause, reconnect, rig, type Rig, scriptedIo, start, syncReply, until } from "./support.ts";

const rigs: Rig[] = [];
async function make(options: Parameters<typeof rig>[0] = {}) {
  const r = await rig(options);
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.cleanup.terminate();
    await Promise.race([r.worker.idle(), pause(2_000)]);
  }
});

const stateOf = (r: Rig, runId: string) => r.store.run(runId)?.state;
const finalize = (r: Rig, runId: string, stop = 0, extra: { outcome?: "succeeded" | "failed"; result_digest?: string | null; request_id?: string } = {}) =>
  fromSupervisor(
    r.clock,
    r.worker.name,
    "result_finalize",
    { run_id: runId, outcome: extra.outcome ?? "failed", result_digest: extra.result_digest ?? null, stored_at: r.clock.now() },
    { stop_generation: stop, run_generation: 1, request_id: extra.request_id },
  );
const cancel = (r: Rig, runId: string, reason: "requested" | "emergency_stop" = "requested", stop = 0, requestId?: string) =>
  fromSupervisor(r.clock, r.worker.name, "task_cancel", { run_id: runId, reason }, { stop_generation: stop, run_generation: 1, request_id: requestId });
const renew = (r: Rig, runId: string, stop = 0) =>
  fromSupervisor(r.clock, r.worker.name, "run_renew", { run_id: runId, lease_until: r.clock.now() + limits.RUN_LEASE_MAX_MS }, { stop_generation: stop, run_generation: 1 });

// 정지 세대 파일 쓰기만 장벽에 세우는 저장 장치. entered가 풀리면 그 쓰기에 실제로 들어간 것이다.
function gatedStopWrites(): { io: Partial<StoreIo>; door: ReturnType<typeof gate>; entered: Barrier; armed: { on: boolean } } {
  const door = gate();
  const entered = barrier();
  const armed = { on: false };
  return {
    door,
    entered,
    armed,
    io: {
      writeDurable: async (path, data) => {
        if (armed.on && path.endsWith("stop-generation.json")) await Promise.race([door.wait, entered.pass()]);
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, data);
      },
    },
  };
}

test("시작: 같은 정지 세대로 다시 맞춘 새 연결이 앞 연결에서 기다리던 자격·준비로 띄우지 않는다", async () => {
  // 자격을 받는 사이에 같은 세대(0)로 다시 맞춘다.
  const late = await make();
  late.credentials.before = () => reconnect(late, 0);
  const first = await start(late);
  await late.worker.idle();
  expect(late.link.live()).toBe(true);
  expect(late.launcher.spawned).toBe(0);
  expect(stateOf(late, first.runId)).toBe("not_started");

  // 폴더를 준비하는 사이에 같은 세대로 다시 맞춘다: 새 연결에서 자격을 요청하지 않는다.
  const prep = await make();
  prep.space.before = () => reconnect(prep, 0);
  const second = await start(prep);
  await prep.worker.idle();
  expect(prep.credentials.calls).toHaveLength(0);
  expect(prep.launcher.spawned).toBe(0);
  expect(stateOf(prep, second.runId)).toBe("not_started");
});

test("정지 세대: 높은 세대를 적는 동안 앞서 검증된 옛 세대의 갱신·확정은 임대를 늘리거나 폴더를 지우지 않는다", async () => {
  // 확정: 결과가 나온 실행에 비상 종료(4)와 옛 세대(0)의 확정이 겹친다.
  const done = gatedStopWrites();
  const r = await make({ io: done.io });
  const { runId } = await start(r);
  await r.worker.idle();
  expect(stateOf(r, runId)).toBe("ready_result");
  done.armed.on = true;
  const stop = r.connection.receive(cancel(r, runId, "emergency_stop", 4));
  const old = r.connection.receive(finalize(r, runId, 0));
  await done.entered.entered;
  expect(r.store.stopGeneration()).toBe(4);
  done.entered.open();
  await Promise.all([stop, old]);
  expect(r.space.cleaned).toEqual([]);
  expect(r.transport.of("receipt_cleaned")).toHaveLength(0);

  // 갱신: 실행 중에 비상 종료(4)와 옛 세대(0)의 갱신이 겹친다.
  const live = gatedStopWrites();
  const s = await make({ mode: "hang", io: live.io });
  const running = await start(s);
  await until(() => stateOf(s, running.runId) === "running");
  const lease = s.store.run(running.runId)!.lease_until;
  s.clock.advance(1_000);
  live.armed.on = true;
  const stop2 = s.connection.receive(cancel(s, running.runId, "emergency_stop", 4));
  const old2 = s.connection.receive(renew(s, running.runId, 0));
  await live.entered.entered;
  expect(s.store.run(running.runId)!.lease_until).toBe(lease);
  live.entered.open();
  await Promise.all([stop2, old2]);
  expect(s.store.run(running.runId)!.lease_until).toBe(lease);
});

test("맞춤: 한 challenge의 유효한 답 둘이 겹쳐도 맞춤은 한 번이고 hello도 하나다", async () => {
  const w = gatedStopWrites();
  w.armed.on = true;
  const r = await make({ syncTo: null, io: w.io });
  const a = r.connection.receive(syncReply(r, 3));
  const b = r.connection.receive(syncReply(r, 3));
  await pause();
  // 저장을 기다리는 동안은 열리지 않는다.
  expect(r.link.live()).toBe(false);
  expect(r.transport.of("hello")).toHaveLength(0);
  w.door.open();
  await Promise.all([a, b]);
  expect(r.transport.of("hello")).toHaveLength(1);
  expect(r.link.live()).toBe(true);
});

test("맞춤: 검증(nonce I/O)이 기다리는 사이 25초 기한이 지나면 tick이 없어도 열지 않는다", async () => {
  const w = gatedStopWrites();
  w.armed.on = true;
  const r = await make({ syncTo: null, io: w.io });
  // 같은 직렬 줄에서 앞의 쓰기가 막혀 nonce 기록이 늦어진다. 답은 기한 5초 전에 와서 검증되고, 기다리는 동안 기한이 된다.
  // 답 봉투 자체는 그때도 신선하다(nonce 소비 시각의 만료와 구별한다).
  r.clock.advance(limits.STOP_SYNC_WAIT_MS - 5_000);
  const blocker = r.store.adoptStopGeneration(1);
  const reply = r.connection.receive(syncReply(r, 1));
  await pause();
  r.clock.advance(5_000);
  w.door.open();
  await Promise.all([blocker, reply]);
  expect(r.link.live()).toBe(false);
  expect(r.transport.of("hello")).toHaveLength(0);
});

test("임대: 만료 정각 뒤 tick보다 먼저 온 갱신은 실행을 되살리지 않는다", async () => {
  const r = await make({ mode: "hang" });
  const { runId } = await start(r);
  await until(() => stateOf(r, runId) === "running");
  r.clock.advance(limits.RUN_LEASE_MAX_MS);
  await r.connection.receive(renew(r, runId));
  r.worker.tick();
  await Promise.race([r.worker.idle(), pause(1_500)]);
  expect(stateOf(r, runId)).toBe("failed_stopped");
  expect(r.transport.of("receipt_stopped")[0]?.body).toMatchObject({ exit: "failed", remaining_processes: 0 });
});

test("임대: 감시 주기 사이에 임대를 넘기고 0으로 끝난 프로그램은 completed가 아니다", async () => {
  const r = await make();
  r.launcher.onSpawned = () => r.clock.advance(limits.RUN_LEASE_MAX_MS + 1_000);
  const { runId } = await start(r);
  await r.worker.idle();
  expect(r.transport.of("receipt_stopped")[0]!.body.exit).toBe("failed");
  expect(r.transport.of("report_result")).toHaveLength(0);
  expect(stateOf(r, runId)).toBe("failed_stopped");
});

test("자격: 역할 프로그램이 결과에 되쓴 자격은 보내는 봉투와 다시 연 outbox 어디에도 없다", async () => {
  const r = await make({ mode: "echo-credential" });
  const { runId, value } = await start(r);
  await r.worker.idle();
  const marker = new TextDecoder().decode(value);
  const report = r.transport.of("report_result")[0]!;
  expect(report.body.result).toMatchObject({ outcome: "failed", items: [], refs: [] });
  expect(JSON.stringify(r.transport.sent)).not.toContain(marker);
  const files = readdirSync(join(r.dir, "outbox")).map((name) => readFileSync(join(r.dir, "outbox", name), "utf8"));
  expect(files.length).toBeGreaterThan(0);
  for (const text of files) expect(text).not.toContain(marker);
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(JSON.stringify(again.store.outboxFor(runId))).not.toContain(marker);
});

test("저장: 접수 영수증을 적지 못하면 보내지 않고 자격도 받지 않고 띄우지 않으며 접수를 닫는다", async () => {
  let failOutbox = false;
  const r = await make({
    io: {
      writeDurable: async (path, data) => {
        if (failOutbox && path.includes("/outbox/")) throw new Error("disk");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, data);
      },
    },
  });
  failOutbox = true;
  const { runId } = await start(r);
  await r.worker.idle();
  expect(r.transport.of("receipt_accepted")).toHaveLength(0);
  expect(r.credentials.calls).toHaveLength(0);
  expect(r.launcher.spawned).toBe(0);
  expect(r.worker.intakeClosed()).not.toBeNull();
  expect(r.store.unacked()).toEqual([]);
  // 저장이 돌아오면 남겨 둔 사실을 다시 적고 그때 보낸다.
  failOutbox = false;
  expect(await r.worker.flush()).toBe(true);
  expect(r.worker.intakeClosed()).toBeNull();
  expect(r.transport.of("receipt_accepted").map((e) => e.body.run_id)).toEqual([runId]);
});

test("복원: 종료 영수증과 결과를 적은 뒤 ready_result를 적기 전에 꺼졌으면 같은 영수증으로 이어 가고 성공을 실패로 바꾸지 않는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const stopped = r.store.outboxFor(runId).filter((e) => e.action === "receipt_stopped");
  expect(stopped).toHaveLength(1);
  await r.store.noteRun({ ...r.store.run(runId)!, state: "checking" });
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  const after = again.store.outboxFor(runId).filter((e) => e.action === "receipt_stopped");
  expect(after.map((e) => e.id)).toEqual(stopped.map((e) => e.id));
  expect(again.store.run(runId)?.state).toBe("ready_result");
});

test("저장소: 실행 기록만 잃은 저장소는 빈 장부로 열지 않고 접수를 닫는다. 같은 실행의 시작이 다시 와도 띄우지 않는다", async () => {
  const r = await make();
  const { runId, value } = await start(r);
  await r.worker.idle();
  rmSync(join(r.dir, "runs", `${runId}.json`));
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.worker.intakeClosed()).toBe("store_inconsistent");
  await start(again, { runId, value });
  await again.worker.idle();
  expect(again.launcher.spawned).toBe(0);
  expect(again.credentials.calls).toHaveLength(0);
});

test("정리: 지우는 중인 실행이 슬롯을 쥐어 새 시작이 들어오지 않고, 겹친 확정은 하나의 정리 영수증으로 모인다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const deleting = barrier();
  r.space.clean = async (id) => {
    r.space.cleaned.push(id);
    await deleting.pass();
    return true;
  };
  // 같은 확정의 재전송(같은 request_id, 새 nonce)이 겹친다.
  const requestId = randomUUID();
  const one = r.connection.receive(finalize(r, runId, 0, { request_id: requestId }));
  const two = r.connection.receive(finalize(r, runId, 0, { request_id: requestId }));
  await deleting.entered;
  await start(r);
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(1);
  deleting.open();
  await Promise.all([one, two]);
  expect(r.space.cleaned).toEqual([runId]);
  const cleaned = r.store.outboxFor(runId).filter((e) => e.action === "receipt_cleaned");
  expect(cleaned).toHaveLength(1);
  expect(stateOf(r, runId)).toBe("finalized");
});

test("취소: 준비 중 취소의 접수 영수증을 쓰는 사이 자격이 와도 띄우지 않는다", async () => {
  const disk = scriptedIo();
  const writing = disk.hold(cancelReceiptWrite);
  const r = await make({ io: disk.io });
  const runId = randomUUID();
  // 자격을 돌려주기 전에 취소 영수증의 쓰기에 실제로 들어간다.
  r.credentials.before = async () => {
    void r.connection.receive(cancel(r, runId));
    await writing.entered;
  };
  const started = start(r, { runId });
  await writing.entered;
  await until(() => r.credentials.calls.length > 0);
  expect(r.launcher.spawned).toBe(0);
  writing.open();
  await started;
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(0);
  expect(stateOf(r, runId)).toBe("not_started");
});

test("정리: 성공 확정의 digest가 실행기가 보낸 결과와 다르면 지우지 않고, 같으면 지운다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const result = r.transport.of("report_result")[0]!.body.result;
  await r.connection.receive(finalize(r, runId, 0, { outcome: "succeeded", result_digest: "0".repeat(64) }));
  expect(r.space.cleaned).toEqual([]);
  expect(stateOf(r, runId)).toBe("ready_result");
  await r.connection.receive(finalize(r, runId, 0, { outcome: "succeeded", result_digest: resultDigest(result) }));
  expect(r.space.cleaned).toEqual([runId]);
  expect(stateOf(r, runId)).toBe("finalized");
});

test("종료: 세는 쪽이 던지면(공간 확인 실패) 시작 전 정지와 복원 모두 종료 확인 영수증을 내지 않는다", async () => {
  const r = await make();
  r.cleanup.survivorsError = new Error("namespace");
  r.credentials.before = () => r.connection.close();
  const { runId } = await start(r);
  await r.worker.idle();
  expect(stateOf(r, runId)).toBe("unknown_running");
  expect(r.store.outboxFor(runId).filter((e) => e.action === "receipt_stopped")).toHaveLength(0);
  await r.store.noteRun({ ...r.store.run(runId)!, state: "running" });
  const again = await make({ dir: r.dir, clock: r.clock });
  again.cleanup.survivorsError = new Error("namespace");
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("unknown_running");
  expect(again.store.outboxFor(runId).filter((e) => e.action === "receipt_stopped")).toHaveLength(0);
});

test("취소: 돌아오지 않는 준비·자격 요청도 취소하면 기다리기를 그만두고 신호로 거둔다", async () => {
  const r = await make();
  r.credentials.before = () => new Promise(() => {});
  const { runId } = await start(r);
  await until(() => r.credentials.calls.length > 0);
  await r.connection.receive(cancel(r, runId));
  await r.worker.idle();
  expect(r.space.signals[0]!.aborted).toBe(true);
  expect(r.credentials.signals[0]!.aborted).toBe(true);
  expect(r.launcher.spawned).toBe(0);
  expect(stateOf(r, runId)).toBe("not_started");
});

test("취소: 정리 신호가 닿지 않아 자식이 끝나지 않으면 상한 뒤 슬롯을 쥔 unknown_running으로 두고, 다시 온 취소가 재검사한다", async () => {
  const r = await make({ mode: "hang", exitWaitMs: 200 });
  const { runId } = await start(r);
  await until(() => stateOf(r, runId) === "running");
  r.cleanup.inert = true;
  r.cleanup.hold = new Promise(() => {});
  r.cleanup.remaining = 1;
  await r.connection.receive(cancel(r, runId));
  await r.worker.idle();
  expect(stateOf(r, runId)).toBe("unknown_running");
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  // 새 시작은 받지 않는다.
  await start(r);
  expect(r.launcher.spawned).toBe(1);
  // 정리가 돌아오면 다시 온 취소가 끝내고 세어 0이면 그때 낸다.
  r.cleanup.inert = false;
  r.cleanup.hold = undefined;
  r.cleanup.remaining = 0;
  await r.connection.receive(cancel(r, runId));
  expect(stateOf(r, runId)).toBe("failed_stopped");
  expect(r.transport.of("receipt_stopped")).toHaveLength(1);
});

test("hello: 확정되지 않은 실행이 STATUS_MAX_RUNS에 이르면 새 시작을 받지 않고, 슬롯을 쥐었거나 끝을 모르는 실행을 앞에 싣는다", async () => {
  const r = await make();
  const record = (state: "ready_result" | "unknown_running") => ({
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
  for (let i = 0; i < limits.STATUS_MAX_RUNS; i++) expect(await r.store.beginRun(record("ready_result"))).toBe(true);
  await start(r);
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(0);
  expect(r.store.runs()).toHaveLength(limits.STATUS_MAX_RUNS);
  // 상한을 이미 넘긴 저장소(옛 기록)에서도 끝을 모르는 실행은 인사의 앞에 있다.
  const uncertain = record("unknown_running");
  await r.store.beginRun(uncertain);
  await reconnect(r, 0);
  const runs = r.transport.of("hello")[0]!.body.runs;
  expect(runs).toHaveLength(limits.STATUS_MAX_RUNS);
  expect(runs[0]).toMatchObject({ run_id: uncertain.run_id, state: "unknown_running" });
});

test("취소: 같은 request_id의 재전송은 같은 접수 영수증, 다른 request_id의 후속 취소는 그 요청의 영수증이다", async () => {
  const r = await make({ mode: "hang" });
  const { runId } = await start(r);
  await until(() => stateOf(r, runId) === "running");
  const first = randomUUID();
  await r.connection.receive(cancel(r, runId, "requested", 0, first));
  await r.worker.idle();
  await r.connection.receive(cancel(r, runId, "requested", 0, first));
  const second = randomUUID();
  await r.connection.receive(cancel(r, runId, "requested", 0, second));
  const accepted = r.transport.of("receipt_accepted").filter((e) => e.body.instruction === "task_cancel");
  expect(accepted.map((e) => e.body.instruction_request_id)).toEqual([first, first, second]);
  expect(accepted[1]!.body).toEqual(accepted[0]!.body);
  expect(accepted[2]!.body.receipt_id).not.toBe(accepted[0]!.body.receipt_id);
  // 종료 확인 영수증은 하나다(다시 보낼 때도 같은 id).
  expect(new Set(r.transport.of("receipt_stopped").map((e) => e.body.receipt_id)).size).toBe(1);
});

test("시험 도구: 끝난 자식은 등록에서 빠지고, 그 뒤의 정리는 그 자식에 신호를 보내지 않는다", async () => {
  const r = await make();
  await start(r);
  await r.worker.idle();
  expect(r.launcher.spawned).toBe(1);
  expect(r.cleanup.children.size).toBe(0);
  expect(r.cleanup.exitedChildren.size).toBe(1);
  // 실행 뒤 정리(confirmStopped)와 시험 끝의 정리 모두 끝난 자식에 보내지 않았다.
  await r.cleanup.terminate();
  expect(r.cleanup.signalled).toEqual([]);
});
