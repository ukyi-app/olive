// 계약 v1의 failed_stopped 뜻(D-150)을 실행기 쪽에서 지킨다: 결과 보고가 있는 실행은 ready_result, 종료 확인 뒤 결과 보고가 없는 실행은
// failed_stopped로 답하고, 그 답의 last_receipt_id는 그 종료 영수증 ID다. 재기동 대조도 같고, failed_stopped 뒤에는 ready_result도 결과
// 보고도 만들지 않는다. 감독은 이 답 하나로 결과 없음을 판정한다(src/supervisor/dispatch/result-check.md "결과 없음 판정").
import { afterEach, expect, test } from "bun:test";
import type { RunStatus } from "../../src/contract/v1/index.ts";
import { fromSupervisor, onDiskEvents, outboxWrite, reconnect, rig, type Rig, scriptedIo, start, until } from "./support.ts";

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

// 같은 실행 ID의 상태 조회 하나를 받고 그 답의 항목을 돌려준다.
async function ask(r: Rig, runId: string): Promise<RunStatus> {
  const query = fromSupervisor(r.clock, r.worker.name, "status_query", { run_ids: [runId] }, { stop_generation: 0 });
  await r.connection.receive(query);
  const report = r.transport.of("status_report").find((envelope) => envelope.body.in_reply_to === query.header.request_id);
  if (report === undefined) throw new Error("상태 보고가 없다");
  expect(report.body.runs).toHaveLength(1);
  return report.body.runs[0]!;
}

const stoppedId = (r: Rig, runId: string): string => {
  const ids = r.store.outboxFor(runId).filter((entry) => entry.action === "receipt_stopped").map((entry) => entry.id);
  expect(ids).toHaveLength(1);
  return ids[0]!;
};
const reports = (r: Rig, runId: string) => [...r.store.outboxFor(runId).filter((entry) => entry.action === "report_result"), ...r.transport.of("report_result")];

test("보고 없는 종료(0이 아닌 종료, 요청 취소)는 failed_stopped로 답하고 last_receipt_id는 그 종료 영수증 ID다. 보고가 있는 종료는 ready_result이고 보고 ID는 그 칸에 들지 않는다", async () => {
  const failed = await make({ mode: "fail" });
  const a = await start(failed);
  await failed.worker.idle();
  expect(await ask(failed, a.runId)).toEqual({ run_id: a.runId, state: "failed_stopped", run_generation: 1, last_receipt_id: stoppedId(failed, a.runId) });
  expect(failed.transport.of("receipt_stopped").map((envelope) => envelope.body.receipt_id)).toEqual([stoppedId(failed, a.runId)]);
  expect(reports(failed, a.runId)).toEqual([]);

  const cancelled = await make({ mode: "hang" });
  const b = await start(cancelled);
  await until(() => cancelled.store.run(b.runId)?.state === "running");
  await cancelled.connection.receive(fromSupervisor(cancelled.clock, cancelled.worker.name, "task_cancel", { run_id: b.runId, reason: "requested" }, { stop_generation: 0, run_generation: 1 }));
  await cancelled.worker.idle();
  expect(await ask(cancelled, b.runId)).toEqual({ run_id: b.runId, state: "failed_stopped", run_generation: 1, last_receipt_id: stoppedId(cancelled, b.runId) });
  expect(reports(cancelled, b.runId)).toEqual([]);

  const completed = await make();
  const c = await start(completed);
  await completed.worker.idle();
  expect(await ask(completed, c.runId)).toEqual({ run_id: c.runId, state: "ready_result", run_generation: 1, last_receipt_id: stoppedId(completed, c.runId) });
  expect(completed.store.outboxFor(c.runId).filter((entry) => entry.action === "report_result")).toHaveLength(1);
});

test("재기동 대조: 결과 보고를 적지 못한 채 다시 뜬 실행도 failed_stopped로 답하고 last_receipt_id는 디스크의 같은 종료 영수증 ID다", async () => {
  const disk = scriptedIo();
  disk.fail(outboxWrite("report_result"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  const onDisk = onDiskEvents(r.dir, runId).filter((event) => event.action === "receipt_stopped").map((event) => event.id);
  expect(onDisk).toHaveLength(1);
  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  await again.worker.idle();
  expect(await ask(again, runId)).toEqual({ run_id: runId, state: "failed_stopped", run_generation: 1, last_receipt_id: onDisk[0]! });
  expect(onDiskEvents(again.dir, runId).map((event) => event.action)).not.toContain("report_result");
});

test("띄우기 전에 끝난 실행(작업 폴더 준비 실패)은 종료 영수증 뒤 결과 보고가 없어도 failed_stopped가 아니라 not_started로 답한다", async () => {
  const r = await make();
  r.space.before = async () => {
    throw new Error("작업 폴더를 준비하지 못함");
  };
  const { runId } = await start(r);
  await r.worker.idle();
  expect(await ask(r, runId)).toEqual({ run_id: runId, state: "not_started", run_generation: 1, last_receipt_id: stoppedId(r, runId) });
  expect(reports(r, runId)).toEqual([]);
});

test("failed_stopped 뒤에는 조회·재전송·재연결·재기동·늦은 취소를 거쳐도 ready_result가 되지 않고 결과 보고를 만들지 않는다", async () => {
  const r = await make({ mode: "fail" });
  const { runId } = await start(r);
  await r.worker.idle();
  const expected: RunStatus = { run_id: runId, state: "failed_stopped", run_generation: 1, last_receipt_id: stoppedId(r, runId) };
  expect(await ask(r, runId)).toEqual(expected);
  expect(await ask(r, runId)).toEqual(expected);
  r.clock.advance(60_000);
  r.worker.tick();
  await r.worker.idle();
  await reconnect(r, 0);
  await r.worker.idle();
  expect(await ask(r, runId)).toEqual(expected);
  expect(reports(r, runId)).toEqual([]);

  const again = await make({ dir: r.dir, clock: r.clock });
  await again.worker.recover();
  await again.worker.idle();
  expect(await ask(again, runId)).toEqual(expected);

  // 종료 뒤에 닿은 취소도 상태를 바꾸지 않는다. 다만 그 접수 영수증이 마지막 영수증이 되어 last_receipt_id가 종료 영수증 ID와 달라진다:
  // 감독은 이 답으로 결과 없음을 판정하지 않고 자리를 쥔다(종료 영수증 ID 대조, D-147).
  await again.connection.receive(fromSupervisor(again.clock, again.worker.name, "task_cancel", { run_id: runId, reason: "requested" }, { stop_generation: 0, run_generation: 1 }));
  await again.worker.idle();
  const accepted = again.store.outboxFor(runId).filter((entry) => entry.action === "receipt_accepted").at(-1)?.id;
  expect(accepted).not.toBe(expected.last_receipt_id);
  expect(await ask(again, runId)).toEqual({ ...expected, last_receipt_id: accepted! });
  expect(reports(again, runId)).toEqual([]);
  expect(onDiskEvents(again.dir, runId).map((event) => event.action)).not.toContain("report_result");
});
