// 관리자 닫기(D-91) 뒤 실행기 저장소에 남는 기록(D-159). 감독 쪽을 닫아도 실행기는 자기 저장소로만 새 시작을 판단한다(worker.ts의 refusesStart).
// - C-1(D-171): 실행 기록은 접수한 파드의 UID(pod_uid)를 적는다. 기동 때 끝을 맺지 못한 기록(unknown_running 포함)의 pod_uid가 지금 파드와
//   다르면 다시 세어, 지금 대리·프로세스의 계수가 0일 때만 종료 영수증을 내고 failed_stopped(보고가 있으면 ready_result)로 맺는다.
//   칸이 없는 기록(칸을 쓰기 전의 판)과 같은 파드의 기록은 지금 동작 그대로다(unknown_running은 다시 세지 않는다).
//   다른 파드의 기록에서 새로 내는 종료 사유: 보고 없는 completed는 failed, 옛 파드가 정한 cancelled·deadline과 이미 적힌 종료 영수증은 그대로다.
// - 다른 실행이 시작 자리를 쥔 동안 온 버림 확정은 정리를 예약하지 않는다. 같은 요청의 재전송이 그 실행이 끝난 뒤 정리한다.
// - 확정되지 않은 기록이 STATUS_MAX_RUNS(8)개면 새 시작을 받지 않는다. 감독의 outcome failed 확정 하나가 그 기록을 정리해 finalized로 맺는다(C-2).
// 같은 폴더를 새 저장소·다른 파드 UID로 다시 여는 것으로 파드 교체를 흉내 낸다.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { limits } from "../../src/contract/v1/index.ts";
import { ExecutorStore, type RunRecord, type StoreError } from "../../src/executor/store.ts";
import { barrier, fromSupervisor, POD_UID, pause, type Rig, rig, start, sync, until } from "./support.ts";

// 교체 뒤 새 파드의 UID. rig의 기본(POD_UID)이 교체 전 파드다.
const POD_B = "3a9e6b1c-7d2f-4c8a-b5e0-9f1d2c3b4a56";

const ofRun = (r: Rig, action: string, runId: string) => r.transport.sent.filter((e) => e.header.action === action && (e.body as { run_id: string }).run_id === runId);
const failedFinalize = (r: Rig, runId: string) =>
  fromSupervisor(r.clock, r.worker.name, "result_finalize", { run_id: runId, outcome: "failed", result_digest: null, stored_at: r.clock.now() }, { stop_generation: 0, run_generation: 1 });
const onDisk = (dir: string, runId: string) => JSON.parse(readFileSync(join(dir, "runs", `${runId}.json`), "utf8")) as Record<string, unknown>;

// 남은 수를 모르는 채 끝난 실행(unknown_running)을 저장소에 남긴다.
async function unknownRun(): Promise<{ a: Rig; runId: string }> {
  const a = await rig();
  a.cleanup.remaining = null;
  const { runId } = await start(a);
  await a.worker.idle();
  expect(a.store.run(runId)?.state).toBe("unknown_running");
  return { a, runId };
}

// 같은 저장소로 다시 뜬 실행기. 감독에 붙기 전에 recover를 부른다(runtime.ts의 차례).
async function reboot(dir: string, podUid: string, before?: (r: Rig) => void): Promise<Rig> {
  const b = await rig({ dir, podUid, syncTo: null });
  before?.(b);
  await b.worker.recover();
  await sync(b, 0);
  return b;
}

test("다른 파드에서 물려받은 unknown_running: 다시 세어 종료 영수증(failed)을 내고 failed_stopped로 맺고, 새 시작과 버림 확정을 받는다", async () => {
  const { a, runId } = await unknownRun();
  expect(onDisk(a.dir, runId).pod_uid).toBe(POD_UID);
  const b = await reboot(a.dir, POD_B);
  expect(b.cleanup.survivorChecks).toBe(1);
  expect(b.store.run(runId)).toMatchObject({ state: "failed_stopped", exit: "failed", pod_uid: POD_UID });
  const [stopped] = ofRun(b, "receipt_stopped", runId);
  expect(stopped?.body).toMatchObject({ run_id: runId, remaining_processes: 0, exit: "failed" });
  expect(ofRun(b, "report_result", runId)).toEqual([]);
  // 자리를 쥔 기록이 없어 새 시작을 받고, 감독의 버림 확정으로 정리해 finalized로 맺는다.
  const fresh = await start(b, { runId: randomUUID() });
  expect(ofRun(b, "receipt_accepted", fresh.runId)).toHaveLength(1);
  await b.worker.idle();
  expect(b.store.run(fresh.runId)?.pod_uid).toBe(POD_B);
  await b.connection.receive(failedFinalize(b, runId));
  await b.worker.idle();
  expect(b.store.run(runId)?.state).toBe("finalized");
  expect(ofRun(b, "receipt_cleaned", runId)).toHaveLength(1);
});

test("같은 파드로 다시 뜨거나 칸이 없는 옛 기록이면 지금 동작 그대로: unknown_running을 다시 세지 않고 새 시작·버림 확정을 받지 않는다", async () => {
  const same = await unknownRun();
  // 칸을 쓰기 전의 판이 접수한 기록: 같은 꼴에서 pod_uid만 없다.
  const old = await unknownRun();
  const legacy = onDisk(old.a.dir, old.runId);
  delete legacy.pod_uid;
  writeFileSync(join(old.a.dir, "runs", `${old.runId}.json`), JSON.stringify(legacy));
  for (const [dir, runId, podUid] of [
    [same.a.dir, same.runId, POD_UID],
    [old.a.dir, old.runId, POD_B],
  ] as const) {
    const b = await reboot(dir, podUid);
    expect(b.cleanup.survivorChecks, podUid).toBe(0);
    expect(b.store.run(runId)?.state, podUid).toBe("unknown_running");
    expect(b.store.run(runId)?.pod_uid, podUid).toBe(podUid === POD_UID ? POD_UID : undefined);
    const fresh = await start(b, { runId: randomUUID() });
    expect(ofRun(b, "receipt_accepted", fresh.runId), podUid).toEqual([]);
    await b.connection.receive(failedFinalize(b, runId));
    await b.worker.idle();
    expect(ofRun(b, "receipt_cleaned", runId), podUid).toEqual([]);
    expect(b.store.run(runId)?.state, podUid).toBe("unknown_running");
  }
});

test("다른 파드의 기록이어도 지금의 계수가 0이 아니면(모름) 맺지 않고 unknown_running으로 자리를 쥔다", async () => {
  const { a, runId } = await unknownRun();
  const b = await reboot(a.dir, POD_B, (r) => {
    r.cleanup.remaining = null;
  });
  expect(b.cleanup.survivorChecks).toBe(1);
  expect(b.store.run(runId)?.state).toBe("unknown_running");
  expect(ofRun(b, "receipt_stopped", runId)).toEqual([]);
  const fresh = await start(b, { runId: randomUUID() });
  expect(ofRun(b, "receipt_accepted", fresh.runId)).toEqual([]);
});

test("다른 파드에서 물려받은 실행에 저장된 결과 보고가 있으면 ready_result로 맺는다(D-150)", async () => {
  // 결과 보고가 적혔는데 남은 수를 모른 채 남은 기록. 저장소의 낮은 입구(beginRun·commit)로 만든다.
  const dir = (await rig()).dir;
  const seeded = await ExecutorStore.open(dir, { now: () => 1_800_000_000_000 });
  const runId = randomUUID();
  const record: RunRecord = {
    run_id: runId,
    run_generation: 1,
    state: "preparing",
    start_stop_generation: 0,
    instruction_request_id: randomUUID(),
    deadline_at: 1_800_000_600_000,
    lease_until: 1_800_000_030_000,
    credential_digest: "0".repeat(64),
    exit: null,
    last_receipt_id: null,
    pod_uid: POD_UID,
  };
  expect(await seeded.beginRun(record)).toBe(true);
  const reportId = randomUUID();
  const result = { role: "diagnosis", outcome: "completed", summary: "끝", items: [], refs: [] };
  const report = { entry: { id: reportId, action: "report_result" as const, run_id: runId, run_generation: 1, body: { report_id: reportId, run_id: runId, result }, acked: false }, digest: null };
  expect((await seeded.commit(runId, { state: "unknown_running", exit: "completed" }, [report])).saved).toBe(true);
  const b = await reboot(dir, POD_B);
  expect(b.store.run(runId)).toMatchObject({ state: "ready_result", exit: "completed" });
  expect(ofRun(b, "receipt_stopped", runId)[0]?.body).toMatchObject({ remaining_processes: 0, exit: "completed" });
});

test("저장소 꼴: 실행 기록의 pod_uid는 선택 칸이다. 칸이 없는 기록도 열고, 꼴이 틀린 값은 store_corrupt로 열지 않는다", async () => {
  const { a, runId } = await unknownRun();
  const written = onDisk(a.dir, runId);
  // 칸을 쓰기 전의 판은 정리 의도가 없는 기록의 칸이 정확히 10개여야 연다. 이 기록은 11개라 그 판은 store_corrupt(83)로 거절한다.
  expect("cleanup" in written).toBe(false);
  expect(Object.keys(written)).toHaveLength(11);
  expect((await ExecutorStore.open(a.dir)).run(runId)?.pod_uid).toBe(POD_UID);
  for (const bad of ["pod-a", 7, null]) {
    writeFileSync(join(a.dir, "runs", `${runId}.json`), JSON.stringify({ ...written, pod_uid: bad }));
    const opened = await ExecutorStore.open(a.dir).then(
      () => null,
      (error: StoreError) => error.code,
    );
    expect(opened, String(bad)).toBe("store_corrupt");
  }
});

test(`확정되지 않은 기록이 ${limits.STATUS_MAX_RUNS}개면 새 시작을 받지 않고, outcome failed 확정 하나로 정리하면 다시 받는다`, async () => {
  const r = await rig({ mode: "fail" });
  const ids: string[] = [];
  for (let i = 0; i < limits.STATUS_MAX_RUNS; i++) {
    const { runId } = await start(r, { runId: randomUUID() });
    await r.worker.idle();
    expect(r.store.run(runId)?.state).toBe("failed_stopped");
    ids.push(runId);
  }
  const refused = await start(r, { runId: randomUUID() });
  expect(ofRun(r, "receipt_accepted", refused.runId)).toEqual([]);

  const target = ids[0] as string;
  await r.connection.receive(failedFinalize(r, target));
  await r.worker.idle();
  expect(r.store.run(target)?.state).toBe("finalized");
  expect(ofRun(r, "receipt_cleaned", target)).toHaveLength(1);
  const next = await start(r, { runId: randomUUID() });
  expect(ofRun(r, "receipt_accepted", next.runId)).toHaveLength(1);
  await r.worker.idle();
});

// 끝을 맺지 못한 채 남은 기록. 시작 영수증까지 적혔고 결과 보고는 없다(stopped면 종료 영수증도 적혔지만 실행 기록이 따라오지 못했다).
// 저장소의 낮은 입구(beginRun·commit)로 만든다. podUid가 null이면 칸을 쓰기 전의 판이 접수한 기록이다.
async function seededRun(state: RunRecord["state"], exit: RunRecord["exit"], options: { podUid?: string | null; stopped?: boolean } = {}) {
  const dir = (await rig()).dir;
  const at = 1_800_000_000_000;
  const seeded = await ExecutorStore.open(dir, { now: () => at });
  const runId = randomUUID();
  const record: RunRecord = {
    run_id: runId,
    run_generation: 1,
    state: "preparing",
    start_stop_generation: 0,
    instruction_request_id: randomUUID(),
    deadline_at: at + 600_000,
    lease_until: at + 30_000,
    credential_digest: "0".repeat(64),
    exit: null,
    last_receipt_id: null,
  };
  const podUid = options.podUid === undefined ? POD_UID : options.podUid;
  if (podUid !== null) record.pod_uid = podUid;
  expect(await seeded.beginRun(record)).toBe(true);
  const startedId = randomUUID();
  const event = (id: string, action: "receipt_started" | "receipt_stopped", body: Record<string, unknown>) => ({
    entry: { id, action, run_id: runId, run_generation: 1, body: { receipt_id: id, run_id: runId, ...body }, acked: false },
    digest: null,
  });
  const events = [event(startedId, "receipt_started", { instruction_request_id: record.instruction_request_id, started_at: at })];
  const stoppedId = randomUUID();
  if (options.stopped === true) events.push(event(stoppedId, "receipt_stopped", { remaining_processes: 0, exit, stopped_at: at }));
  const last = options.stopped === true ? stoppedId : startedId;
  expect((await seeded.commit(runId, { state, exit, last_receipt_id: last }, events)).saved).toBe(true);
  return { dir, runId, stoppedId };
}

test("다른 파드의 끝을 맺지 못한 기록에서 보고 없이 종료를 처음 확인하면 기록의 completed도 failed로 낸다(D-171)", async () => {
  for (const state of ["stopping", "checking", "unknown_running"] as const) {
    const { dir, runId } = await seededRun(state, "completed");
    const b = await reboot(dir, POD_B);
    expect(b.cleanup.survivorChecks, state).toBe(1);
    const stopped = ofRun(b, "receipt_stopped", runId);
    expect(stopped, state).toHaveLength(1);
    expect(stopped[0]?.body, state).toMatchObject({ remaining_processes: 0, exit: "failed" });
    expect(b.store.run(runId), state).toMatchObject({ state: "failed_stopped", exit: "failed" });
    expect(ofRun(b, "report_result", runId), state).toEqual([]);
  }
});

test("다른 파드의 기록이어도 옛 파드가 정한 cancelled·deadline은 그대로 낸다(감독의 확정 outcome이 그 값을 읽는다, D-114)", async () => {
  for (const exit of ["cancelled", "deadline"] as const) {
    const { dir, runId } = await seededRun("unknown_running", exit);
    const b = await reboot(dir, POD_B);
    expect(ofRun(b, "receipt_stopped", runId)[0]?.body, exit).toMatchObject({ remaining_processes: 0, exit });
    expect(b.store.run(runId), exit).toMatchObject({ state: "failed_stopped", exit });
  }
});

test("다른 파드의 기록에 이미 적힌 종료 영수증이 있으면 다시 세지 않고 같은 ID·같은 본문으로 맺는다", async () => {
  const { dir, runId, stoppedId } = await seededRun("stopping", "completed", { stopped: true });
  const b = await reboot(dir, POD_B);
  expect(b.cleanup.survivorChecks).toBe(0);
  const stopped = b.store.validEvents(runId).filter((entry) => entry.action === "receipt_stopped");
  expect(stopped.map((entry) => [entry.id, entry.body.exit])).toEqual([[stoppedId, "completed"]]);
  expect(b.store.run(runId)).toMatchObject({ state: "failed_stopped", exit: "completed", last_receipt_id: stoppedId });
});

test("같은 파드의 기록과 칸이 없는 옛 기록은 지금 규칙 그대로: 기동 대조는 기록의 exit로, 회복 요청(D-104)은 보고 없는 completed를 failed로 낸다", async () => {
  for (const [podUid, reopenAs] of [
    [POD_UID, POD_UID],
    [null, POD_B],
  ] as const) {
    const { dir, runId } = await seededRun("stopping", "completed", { podUid });
    const b = await reboot(dir, reopenAs);
    expect(ofRun(b, "receipt_stopped", runId)[0]?.body, String(podUid)).toMatchObject({ remaining_processes: 0, exit: "completed" });
    expect(b.store.run(runId), String(podUid)).toMatchObject({ state: "failed_stopped", exit: "completed" });
  }
  const { dir, runId } = await seededRun("stopping", "completed");
  const restarted = await rig({ dir, podUid: POD_UID, syncTo: null });
  await restarted.worker.reclaimRestarted([runId]);
  await restarted.worker.recover();
  await sync(restarted, 0);
  expect(ofRun(restarted, "receipt_stopped", runId)[0]?.body).toMatchObject({ remaining_processes: 0, exit: "failed" });
  expect(restarted.store.run(runId)).toMatchObject({ state: "failed_stopped", exit: "failed" });
});

test("다른 실행이 시작 자리를 쥔 동안 온 버림 확정은 정리를 예약하지 않는다: 그 실행이 결과를 내고, 같은 요청의 재전송으로 한 번만 정리한다", async () => {
  const r = await rig();
  const first = await start(r);
  await r.worker.idle();
  expect(r.store.run(first.runId)?.state).toBe("ready_result");
  const take = barrier();
  const sweep = barrier();
  r.credentials.before = take.pass;
  r.space.cleanGate = sweep.pass();
  const next = await start(r);
  await take.entered;
  const discard = failedFinalize(r, first.runId);
  const cleaning = r.connection.receive(discard);
  // 정리를 예약했다면 지우기가 cleanGate에서 멈춰 있다. 예약하지 않았으면 곧바로 돌아온다.
  await Promise.race([cleaning, pause(50)]);
  take.open();
  await r.worker.idle();
  const nextEvents = r.store.validEvents(next.runId).map((entry) => [entry.action, (entry.body as { exit?: string }).exit ?? null]);
  const cleanedMeanwhile = r.space.cleaned.filter((runId) => runId === first.runId).length;
  sweep.open();
  await cleaning;
  expect(cleanedMeanwhile).toBe(0);
  expect(r.store.run(next.runId)?.state).toBe("ready_result");
  expect(nextEvents).toEqual([
    ["receipt_accepted", null],
    ["receipt_started", null],
    ["receipt_stopped", "completed"],
    ["report_result", null],
  ]);
  // 미룬 확정은 의도도 남기지 않는다. 같은 요청 ID·같은 본문의 재전송이 처음부터 정리한다.
  expect(r.store.run(first.runId)).toMatchObject({ state: "ready_result" });
  expect(r.store.run(first.runId)?.cleanup ?? null).toBeNull();
  const resend = () =>
    fromSupervisor(r.clock, r.worker.name, "result_finalize", discard.body as never, { stop_generation: 0, run_generation: 1, request_id: discard.header.request_id });
  await r.connection.receive(resend());
  await r.worker.idle();
  await r.connection.receive(resend());
  expect(r.store.run(first.runId)?.state).toBe("finalized");
  expect(r.space.cleaned.filter((runId) => runId === first.runId)).toHaveLength(1);
  const receipts = ofRun(r, "receipt_cleaned", first.runId);
  expect(new Set(receipts.map((e) => (e.body as { receipt_id: string }).receipt_id)).size).toBe(1);
  expect((receipts[0]?.body as { instruction_request_id: string }).instruction_request_id).toBe(discard.header.request_id);
});

test("버림 확정의 정리가 도는 동안 온 시작은 기록·영수증 없이 버리고, 정리가 끝난 뒤 같은 시작 지시의 재전송을 받는다", async () => {
  const r = await rig();
  const first = await start(r);
  await r.worker.idle();
  const sweep = barrier();
  r.space.cleanGate = sweep.pass();
  const cleaning = r.connection.receive(failedFinalize(r, first.runId));
  await until(() => r.space.cleaned.includes(first.runId));
  const next = await start(r);
  expect(r.store.run(next.runId)).toBeUndefined();
  expect(ofRun(r, "receipt_accepted", next.runId)).toEqual([]);
  expect(r.credentials.calls.filter((call) => call.runId === next.runId)).toEqual([]);
  sweep.open();
  await cleaning;
  expect(r.store.run(first.runId)?.state).toBe("finalized");
  await r.connection.receive(
    fromSupervisor(r.clock, r.worker.name, "task_start", next.envelope.body as never, { stop_generation: 0, run_generation: 1, request_id: next.envelope.header.request_id }),
  );
  await r.worker.idle();
  expect(ofRun(r, "receipt_accepted", next.runId)).toHaveLength(1);
  expect(r.store.run(next.runId)?.state).toBe("ready_result");
});
