// 결과 보고와 종료 영수증의 쓰기 순서(D-167). 종료 영수증이 디스크에 있으면 그 종료에서 만든 결과 보고도 디스크에 있고,
// 유효한 결과 보고가 있는 실행은 failed_stopped로 답하지 않는다. 볼륨 사본은 쓰기마다 폴더 전체를 복사해 만들고, 되살리기는 그 사본을 새 저장소로 연다.
// 감독 쪽은 실제 장부와 영수증 처리기(handleForward)·결과 검사(resultCheckTick)로 보낸 순서 그대로 받아 본다.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Envelope, verifyEnvelope } from "../../src/contract/v1/index.ts";
import type { StoreIo } from "../../src/executor/store.ts";
import type { Ledger } from "../../src/ledger/index.ts";
import { handleForward } from "../../src/supervisor/dispatch/receipts.ts";
import { resultCheckTick } from "../../src/supervisor/dispatch/result-check.ts";
import { createFileResultBackend } from "../../src/supervisor/scheduler/result-store-file.ts";
import { id, must, NOW, open, ready, tempPath, worker } from "../ledger/helpers.ts";
import {
  credentialValue,
  executorKeys,
  fromSupervisor,
  onDiskEvents,
  onDiskRun,
  outboxWrite,
  pause,
  rig,
  type Rig,
  runWrite,
  scratch,
  scriptedIo,
  sha256,
  start,
  taskStartBody,
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

// 디스크의 사건 종류(폴더 목록의 차례는 정해져 있지 않아 이름 차례로 늘어놓는다).
const actionsOf = (dir: string, runId: string) => onDiskEvents(dir, runId).map((e) => e.action).sort();
const eventOf = (r: Rig, runId: string, action: string) => r.store.validEvents(runId).find((e) => e.action === action);

async function statusOf(r: Rig, runId: string) {
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "status_query", { run_ids: [runId] }, { stop_generation: 0 }));
  return r.transport.of("status_report").at(-1)!.body.runs[0]!;
}
const helloOf = (r: Rig, runId: string) => r.transport.of("hello").at(-1)!.body.runs.find((run) => run.run_id === runId);

// 쓰기마다(앞의 쓰기가 끝난 직후) 볼륨 전체를 떠 둔다. 저장소의 쓰기는 한 줄로 돌므로 사본 하나는 한 순간의 디스크다.
// 사본이 하나도 없는 시점(첫 쓰기 전)은 실행이 없는 저장소라 따로 보지 않는다.
function snapshotIo(dir: string, fail: (path: string, data: string) => boolean = () => false) {
  const snaps: { label: string; dir: string }[] = [];
  const state = { armed: false };
  const io: Partial<StoreIo> = {
    writeDurable: async (path, data) => {
      if (fail(path, data)) throw Object.assign(new Error("disk"), { code: "EIO" });
      await writeFile(path, data);
      if (!state.armed || !(path.includes("/outbox/") || path.includes("/runs/"))) return;
      const parsed = JSON.parse(data) as { action?: string; state?: string };
      const copy = scratch("olive-snapshot-");
      await cp(dir, copy, { recursive: true });
      snaps.push({ label: parsed.action ?? `run:${parsed.state}`, dir: copy });
    },
  };
  return { io, snaps, state };
}

// 감독 쪽 한 벌: 실제 장부(작업자 실행 하나, 소유자 입력 있음)와 파일 보관소. 시작 지시의 요청 ID를 장부와 실행기가 함께 쓴다.
function supervisorSide(runId: string, executorId: string, requestId: string) {
  const ledger: Ledger = ready(open(tempPath()));
  const owner = id();
  must(ledger.enqueueInput({ requestId: owner, source: "test", sourceRef: { ref: "inputs/" + id(), expiresAt: NOW + 600_000 }, receivedAt: NOW }));
  must(ledger.admitRun(worker({ runId, inputRequestId: owner, executorId })));
  must(ledger.startRun({ runId, requestId, stopGeneration: 0, now: NOW }));
  const files = createFileResultBackend({ dir: scratch("olive-results-"), maxRecordBytes: 18_000 });
  if (files.status !== "ok") throw new Error("보관소를 열지 못함");
  const nonces = new Set<string>();
  const random = { bytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) };
  let tick = 0;
  const receive = async (r: Rig, envelope: Envelope) => {
    const verified = await verifyEnvelope(envelope, {
      now: r.clock.now(),
      expectedRecipient: "supervisor",
      publicKeyFor: (sender) => (sender === executorId ? executorKeys.publicKey : undefined),
      stopGeneration: 0,
      runGeneration: (rid) => ledger.runGeneration(rid),
      nonces: { consume: (sender, nonce) => !nonces.has(`${sender}\n${nonce}`) && nonces.add(`${sender}\n${nonce}`).size > 0 },
    });
    if (!verified.ok) throw new Error(`검증 실패: ${verified.reason}`);
    tick += 1;
    return handleForward(
      { forward: { verified, connection: 1 }, now: NOW + tick, stopGeneration: 0, pendingQueries: [], links: { current: () => true }, backlog: [] },
      { ledger, random, results: { ledger, backend: files.backend } },
    );
  };
  const stateNow = () => (ledger.getRun(runId) as { value: { state: string } }).value.state;
  const check = () => resultCheckTick({ ledger, intake: { intakeOpen: () => true } }, NOW + 1_000 + ++tick);
  return { ledger, receive, stateNow, check };
}

// 실행기에 시작 지시를 넣는다. 요청 ID는 장부의 시작 지시와 같은 값이다(감독이 접수·시작 영수증을 그 지시에 잇는다).
async function startWith(r: Rig, runId: string, requestId: string) {
  const value = credentialValue();
  r.credentials.values.set(runId, value);
  await r.connection.receive(
    fromSupervisor(r.clock, r.worker.name, "task_start", taskStartBody(r, runId, sha256(value)), { stop_generation: 0, run_generation: 1, request_id: requestId }),
  );
}

const outcomes = async (side: ReturnType<typeof supervisorSide>, r: Rig, sent: Envelope[]) => {
  const seen: { action: string; outcome: string; state: string }[] = [];
  for (const envelope of sent) {
    const answer = await side.receive(r, envelope);
    seen.push({ action: envelope.header.action, outcome: answer.outcome, state: side.stateNow() });
  }
  return seen;
};
const effects = (r: Rig) => r.transport.sent.filter((e) => e.header.action.startsWith("receipt_") || e.header.action === "report_result");

// ---- (가) 쓰기 순서 ----

test("D-167 쓰기 순서: 결과 보고를 적지 못하면 종료 영수증도 디스크에 남지 않고 보내지도 않는다", async () => {
  const disk = scriptedIo();
  const heal = disk.fail(outboxWrite("report_result"));
  const r = await make({ io: disk.io });
  const { runId } = await start(r);
  await r.worker.idle();
  expect(actionsOf(r.dir, runId)).toEqual(["receipt_accepted", "receipt_started"]);
  expect(onDiskRun(r.dir, runId).state).not.toBe("failed_stopped");
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  expect(r.transport.of("report_result")).toHaveLength(0);
  heal();
  expect(await r.worker.flush()).toBe(true);
  expect(actionsOf(r.dir, runId)).toEqual(["receipt_accepted", "receipt_started", "receipt_stopped", "report_result"]);
  expect(onDiskRun(r.dir, runId).state).toBe("ready_result");
});

test("D-167 쓰기 순서: 어느 쓰기가 실패해도 디스크에 종료 영수증만 있고 그 종료의 결과 보고가 없는 순간이 없다", async () => {
  for (const failing of [outboxWrite("report_result"), outboxWrite("receipt_stopped"), runWrite("stopping"), runWrite("ready_result")]) {
    const dir = scratch();
    const { io, snaps, state } = snapshotIo(dir, failing);
    const r = await make({ dir, io });
    state.armed = true;
    const { runId } = await start(r);
    await r.worker.idle();
    state.armed = false;
    for (const snap of snaps) {
      const actions = actionsOf(snap.dir, runId);
      if (actions.includes("receipt_stopped")) expect({ after: snap.label, actions }).toEqual({ after: snap.label, actions: expect.arrayContaining(["report_result"]) });
    }
  }
});

// ---- (나) 리뷰 F1: 옛 볼륨 사본으로 되살리기 ----

test("D-167 F1 사본: 쓰기마다 뜬 볼륨 사본으로 되살린 실행기는 처음 종료 영수증 ID의 failed_stopped를 답하지 않는다", async () => {
  const dir = scratch();
  const { io, snaps, state } = snapshotIo(dir);
  const original = await make({ dir, io });
  state.armed = true;
  const { runId } = await start(original);
  await original.worker.idle();
  state.armed = false;
  const stop = eventOf(original, runId, "receipt_stopped")!;
  const report = eventOf(original, runId, "report_result")!;
  expect(stop.body.exit).toBe("completed");
  const seen: { after: string; report: boolean; stop: boolean; state: string; sameStop: boolean; hello: string | undefined }[] = [];
  for (const snap of snaps) {
    const hasReport = existsSync(join(snap.dir, "outbox", `${report.id}.json`));
    const hasStop = existsSync(join(snap.dir, "outbox", `${stop.id}.json`));
    const restored = await make({ dir: snap.dir, clock: original.clock });
    const hello = helloOf(restored, runId)?.state;
    await restored.worker.recover();
    await restored.worker.idle();
    const answer = await statusOf(restored, runId);
    seen.push({ after: snap.label, report: hasReport, stop: hasStop, state: answer.state, sameStop: answer.last_receipt_id === stop.id, hello });
  }
  // 사본마다: 처음 영수증 ID의 failed_stopped가 없고, 보고가 남은 사본은 ready_result로 답한다(인사도 failed_stopped가 아니다).
  for (const s of seen) {
    expect({ ...s, negative: s.state === "failed_stopped" && s.sameStop }).toMatchObject({ negative: false });
    if (s.report) expect({ after: s.after, state: s.state, hello: s.hello === "failed_stopped" }).toEqual({ after: s.after, state: "ready_result", hello: false });
  }
  // 새 순서에서만 생기는 사본(보고는 있고 처음 영수증은 없음)을 실제로 지났다.
  expect(seen.some((s) => s.report && !s.stop)).toBe(true);
});

// ---- (다) 같은 저장소 안의 모순 ----

test("D-167 모순: 유효한 결과 보고가 있는데 실행 기록이 failed_stopped면 상태 답·인사·재기동 대조 모두 failed_stopped가 아니다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const stop = eventOf(r, runId, "receipt_stopped")!;
  expect(eventOf(r, runId, "report_result")).toBeDefined();
  // 옛 사본의 실행 기록을 되살린 것과 같은 디스크: 사건은 둘 다 있고 기록만 failed_stopped다.
  const path = join(r.dir, "runs", `${runId}.json`);
  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...record, state: "failed_stopped" }));
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBeNull();
  expect(helloOf(again, runId)).toMatchObject({ state: "ready_result", last_receipt_id: stop.id });
  expect(await statusOf(again, runId)).toMatchObject({ state: "ready_result", last_receipt_id: stop.id });
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("ready_result");
  expect(onDiskRun(again.dir, runId).state).toBe("ready_result");
  expect(await statusOf(again, runId)).toMatchObject({ state: "ready_result", last_receipt_id: stop.id });
});

// ---- (라) 보고 없는 정상 실패 ----

test("D-167 보고 없는 실패: 실패한 실행은 그대로 failed_stopped이고 그 뒤 재기동·조회에도 결과 보고를 만들지 않는다", async () => {
  const r = await make({ mode: "fail" });
  const { runId } = await start(r);
  await r.worker.idle();
  const stop = eventOf(r, runId, "receipt_stopped")!;
  expect(stop.body.exit).toBe("failed");
  expect(await statusOf(r, runId)).toMatchObject({ state: "failed_stopped", last_receipt_id: stop.id });
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(helloOf(again, runId)).toMatchObject({ state: "failed_stopped", last_receipt_id: stop.id });
  await again.worker.recover();
  await again.worker.idle();
  expect(await statusOf(again, runId)).toMatchObject({ state: "failed_stopped", last_receipt_id: stop.id });
  expect(actionsOf(again.dir, runId)).not.toContain("report_result");
  expect([...r.transport.sent, ...again.transport.sent].filter((e) => e.header.action === "report_result")).toEqual([]);
});

// ---- 옛 저장소 ----

test("D-167 옛 저장소: 이전 판의 쓰기 순서가 남긴 자리(종료 영수증만 있고 보고는 없음)는 다시 세지 않고 같은 영수증의 failed_stopped로 맺는다", async () => {
  const r = await make();
  const { runId } = await start(r);
  await r.worker.idle();
  const started = eventOf(r, runId, "receipt_started")!;
  const stop = eventOf(r, runId, "receipt_stopped")!;
  const report = eventOf(r, runId, "report_result")!;
  // 이전 판은 종료 영수증을 먼저 적었다. 그 뒤 결과 보고 전에 멈춘 디스크: 보고 파일이 없고 실행 기록은 stopping이다.
  rmSync(join(r.dir, "outbox", `${report.id}.json`));
  const path = join(r.dir, "runs", `${runId}.json`);
  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...record, state: "stopping", last_receipt_id: started.id }));
  const before = onDiskEvents(r.dir, runId).find((e) => e.action === "receipt_stopped")!.body;
  const again = await make({ dir: r.dir, clock: r.clock });
  expect(again.store.inconsistency()).toBeNull();
  await again.worker.recover();
  await again.worker.idle();
  expect(again.cleanup.survivorChecks).toBe(0);
  expect(again.store.run(runId)?.state).toBe("failed_stopped");
  expect(await statusOf(again, runId)).toMatchObject({ state: "failed_stopped", last_receipt_id: stop.id });
  expect(onDiskEvents(again.dir, runId).find((e) => e.action === "receipt_stopped")!.body).toEqual(before);
  expect(actionsOf(again.dir, runId)).not.toContain("report_result");
});

// ---- 감독이 보는 순서 ----

test("D-167 감독: 종료 영수증보다 먼저 온 결과 보고를 장부가 받아 두고(ack), 종료 영수증 뒤 결과 검사가 ready_result로 판정한다", async () => {
  const runId = randomUUID();
  const requestId = randomUUID();
  const r = await make();
  const side = supervisorSide(runId, r.worker.name, requestId);
  await startWith(r, runId, requestId);
  await r.worker.idle();
  const sent = effects(r);
  expect(sent.map((e) => e.header.action)).toEqual(["receipt_accepted", "receipt_started", "report_result", "receipt_stopped"]);
  const seen = await outcomes(side, r, sent);
  expect(seen).toEqual([
    { action: "receipt_accepted", outcome: "ack", state: "preparing" },
    { action: "receipt_started", outcome: "ack", state: "running" },
    { action: "report_result", outcome: "ack", state: "running" },
    { action: "receipt_stopped", outcome: "ack", state: "checking" },
  ]);
  const tick = side.check();
  expect(tick).toMatchObject({ kind: "ran", runs: [{ runId, outcome: "judged", state: "ready_result" }] });
});

test("D-167 재기동 길: 보고만 남은 사본에서 다시 센 새 종료 영수증은 completed이고, 처음 영수증을 받은 장부도 못 받은 장부도 ready_result로 맺는다", async () => {
  const runId = randomUUID();
  const requestId = randomUUID();
  const dir = scratch();
  // stopping 기록을 적지 못해 파일의 실행 기록은 running(exit 없음)에 머문다. 재기동 대조는 그 기록의 exit를 모른다.
  const { io, snaps, state } = snapshotIo(dir, runWrite("stopping"));
  const original = await make({ dir, io });
  const withFirst = supervisorSide(runId, original.worker.name, requestId);
  const withoutFirst = supervisorSide(runId, original.worker.name, requestId);
  state.armed = true;
  await startWith(original, runId, requestId);
  await original.worker.idle();
  state.armed = false;
  await original.worker.flush();
  const first = eventOf(original, runId, "receipt_stopped")!;
  const report = eventOf(original, runId, "report_result")!;
  const snap = snaps.find((s) => existsSync(join(s.dir, "outbox", `${report.id}.json`)) && !existsSync(join(s.dir, "outbox", `${first.id}.json`)));
  expect(snap).toBeDefined();
  expect(onDiskRun(snap!.dir, runId).state).toBe("running");

  const restored = await make({ dir: snap!.dir, clock: original.clock });
  await restored.worker.recover();
  await restored.worker.idle();
  const second = eventOf(restored, runId, "receipt_stopped")!;
  expect(second.id).not.toBe(first.id);
  expect(second.body.exit).toBe("completed");
  expect(restored.store.run(runId)?.state).toBe("ready_result");
  expect(await statusOf(restored, runId)).toMatchObject({ state: "ready_result", last_receipt_id: second.id });

  // 처음 영수증까지 받은 장부: 새 영수증 ID는 ack만 받고 상태와 종료 증거는 처음 것 그대로다.
  await outcomes(withFirst, original, effects(original));
  expect(withFirst.check()).toMatchObject({ runs: [{ runId, outcome: "judged", state: "ready_result" }] });
  const late = await outcomes(withFirst, restored, effects(restored));
  expect(late.filter((s) => s.action === "receipt_stopped")).toEqual([{ action: "receipt_stopped", outcome: "ack", state: "ready_result" }]);
  expect((withFirst.ledger.getRun(runId) as { value: { stopReceiptId: string } }).value.stopReceiptId).toBe(first.id);

  // 처음 영수증을 못 받은 장부: 사본의 보고와 새 영수증만으로 checking을 지나 ready_result로 판정한다.
  const only = await outcomes(withoutFirst, restored, effects(restored));
  expect(only.filter((s) => s.action !== "receipt_accepted" && s.action !== "receipt_started").map((s) => [s.action, s.outcome])).toEqual(
    expect.arrayContaining([
      ["report_result", "ack"],
      ["receipt_stopped", "ack"],
    ]),
  );
  expect(withoutFirst.stateNow()).toBe("checking");
  expect(withoutFirst.check()).toMatchObject({ runs: [{ runId, outcome: "judged", state: "ready_result" }] });
  expect((withoutFirst.ledger.getRun(runId) as { value: { stopReceiptId: string } }).value.stopReceiptId).toBe(second.id);
});
