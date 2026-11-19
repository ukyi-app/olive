// 새 업무를 열어도 되는 조건과 복원의 경계. 복원이 끝났다고 한 뒤의 판단이 옛 값에 고정되거나, 모르는 것을 맞은 것으로
// 세거나, 증명된 것을 다시 쓰지 못하는 순서를 하나씩 만든다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { RunStatus } from "../../src/contract/v1/index.ts";
import { type Ledger, openLedger, type RestorePorts, Restorer } from "../../src/ledger/index.ts";
import { clock, digest, id, must, NOW, open, ready, session, tempPath, worker } from "./helpers.ts";

const EXECUTOR = "executor/diagnosis/0/store-a";
const PEERS = ["front-door", "observer"];
// 맞는 응답: 현관은 v2와 맞은 정책, 그 밖의 이웃은 v1이다(복원기가 이웃마다 기대하는 판).
const answerOf = (peer: string) => (peer === "front-door" ? { peer, contract: "olive-control/v2", policy: "match" as const } : { peer, contract: "olive-control/v1" });

function ports(overrides: Partial<{ [K in keyof RestorePorts]: Partial<RestorePorts[K]> }> = {}): RestorePorts {
  return {
    stopAuthority: { latestStop: async () => null, ...overrides.stopAuthority },
    peers: { contracts: async () => PEERS.map(answerOf), ...overrides.peers },
    occupancy: { occupancy: async () => [], ...overrides.occupancy },
    publications: { lookup: async () => ({ kind: "pending" as const }), ...overrides.publications },
  };
}

function restorer(ledger: Ledger, p: RestorePorts = ports()) {
  return new Restorer(ledger, p, clock, { requiredPeers: PEERS });
}

async function restore(r: Restorer) {
  return { s1: await r.step1(), s2: await r.step2(), s3: await r.step3(), s4: await r.step4(), s5: await r.step5() };
}

function stateOf(ledger: Ledger, runId: string) {
  const read = ledger.getRun(runId);
  return read.known ? read.value?.state : "모름";
}

// 장부를 닫고 다시 연다(감독 재시작).
function reopen(ledger: Ledger, path: string): Ledger {
  ledger.close();
  return open(path);
}

test("F01 복원: 권위 기록을 기다리는 사이 커밋된 같은 세대의 정지를 풀지 않는다", async () => {
  const ledger = open(tempPath());
  must(ledger.applyStop({ generation: 3, stopped: false, now: NOW }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const r = restorer(ledger, ports({ stopAuthority: { latestStop: async () => (await gate, { generation: 4, stopped: false }) } }));
  const pending = r.step1();
  must(ledger.applyStop({ generation: 4, stopped: true, now: NOW }));
  release();
  expect(await pending).toMatchObject({ stopGeneration: 4, stopped: true });
  expect(ledger.readStop()).toMatchObject({ value: { generation: 4, stopped: true } });
  await r.step2();
  await r.step3();
  await r.step4();
  expect(await r.step5()).toMatchObject({ intakeMayOpen: false, closedBecause: ["stopped"] });
});

test("F01 복원: 권위 응답이 정수·불리언이 아니면 1단계가 실패한다", async () => {
  const ledger = open(tempPath());
  must(ledger.applyStop({ generation: 3, stopped: false, now: NOW }));
  for (const bad of [{ generation: Number.NaN, stopped: false }, { generation: 4, stopped: "yes" }, { generation: -1, stopped: true }, { generation: 2 ** 53, stopped: true }]) {
    const r = restorer(ledger, ports({ stopAuthority: { latestStop: async () => bad as never } }));
    await expect(r.step1()).rejects.toThrow("권위");
    expect(r.stopGeneration()).toBeNull();
  }
});

test("F02 복원: 끝난 뒤의 맞춤 세대·접수 판단은 지금의 장부에서 읽는다", async () => {
  const ledger = open(tempPath());
  must(ledger.applyStop({ generation: 3, stopped: false, now: NOW }));
  const r = restorer(ledger);
  const { s5 } = await restore(r);
  expect(s5.intakeMayOpen).toBe(true);
  expect(r.intakeOpen()).toBe(true);
  must(ledger.applyStop({ generation: 4, stopped: true, now: NOW }));
  expect(r.stopGeneration()).toBe(4);
  expect(r.intakeOpen()).toBe(false);
  ledger.close();
  expect(r.stopGeneration()).toBeNull();
  expect(r.intakeOpen()).toBe(false);
});

test("F02 복원: 돌려준 단계 결과를 호출자가 바꿔도 다음 단계의 판단은 그대로다", async () => {
  const ledger = open(tempPath());
  const r = restorer(ledger, ports({ peers: { contracts: async () => [...PEERS.map(answerOf), { peer: "relay", contract: "olive-control/v2" }] } }));
  await r.step1();
  const s2 = await r.step2();
  expect(s2.contractMismatches).toHaveLength(1);
  s2.contractMismatches.length = 0;
  await r.step3();
  await r.step4();
  expect(await r.step5()).toMatchObject({ intakeMayOpen: false, closedBecause: ["contract_mismatch"] });
});

test("F03 장부: 다시 연 장부는 복원이 끝나기 전 새 접수·시작을 주지 않는다", () => {
  const path = tempPath();
  let ledger = open(path);
  ready(ledger);
  const queued = must(ledger.admitRun(worker())).run;
  ledger = reopen(ledger, path);
  expect(ledger.startRun({ runId: queued.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "intake_closed" });
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "intake_closed" });
  expect(ledger.enqueueInput({ requestId: id(), source: "discord", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 1 }, receivedAt: NOW })).toEqual({ ok: false, reason: "intake_closed" });
  // 종료의 기록과 조회는 된다.
  expect(ledger.getRun(queued.runId)).toMatchObject({ known: true, value: { state: "queued" } });
  expect(ledger.recordStopInstruction({ runId: queued.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW })).toMatchObject({ ok: true, run: { state: "not_started" } });
});

test("F03 장부: 복원 뒤라도 정지 중이면 새 접수·실행 줄을 남기지 않는다", async () => {
  const ledger = open(tempPath());
  await restore(restorer(ledger));
  must(ledger.admitRun(worker()));
  must(ledger.applyStop({ generation: 1, stopped: true, now: NOW }));
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "stopped" });
  expect(ledger.enqueueInput({ requestId: id(), source: "discord", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 1 }, receivedAt: NOW })).toEqual({ ok: false, reason: "stopped" });
  expect((ledger.listRuns() as { value: unknown[] }).value).toHaveLength(1);
});

test("F04 열기: 재개방인데 파일이 없거나 빈 대체 파일이면 열지 않는다", () => {
  const path = tempPath();
  const created = openLedger(path, { clock, mode: "create" });
  expect(created.ok).toBe(true);
  if (created.ok) {
    must(created.ledger.applyStop({ generation: 3, stopped: true, now: NOW }));
    created.ledger.close();
  }
  const missing = `${tempPath()}.gone`;
  expect(openLedger(missing, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "not_initialized" });
  const empty = tempPath();
  writeFileSync(empty, "");
  expect(openLedger(empty, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "not_initialized" });
  // 이미 있는 장부를 첫 설치로 다시 만들지 않는다.
  expect(openLedger(path, { clock, mode: "create" })).toMatchObject({ ok: false, reason: "already_initialized" });
  const again = openLedger(path, { clock, mode: "reopen" });
  expect(again).toMatchObject({ ok: true });
  if (again.ok) again.ledger.close();
});

test("F05 복원: 필수 이웃의 응답이 빠지거나 겹치면 접수를 열지 않는다", async () => {
  for (const answer of [[], [answerOf("front-door")], [answerOf("front-door"), answerOf("front-door")]]) {
    const r = restorer(open(tempPath()), ports({ peers: { contracts: async () => answer } }));
    const { s5 } = await restore(r);
    expect(s5.intakeMayOpen, JSON.stringify(answer)).toBe(false);
    expect(s5.closedBecause).toContain("peer_unconfirmed");
    expect(r.intakeOpen()).toBe(false);
  }
});

test("F05 복원: 필수 이웃이 모두 한 번씩 답한 뒤 하나가 더 겹쳐도 접수를 열지 않는다", async () => {
  const answer = [...PEERS, "front-door"].map(answerOf);
  const r = restorer(open(tempPath()), ports({ peers: { contracts: async () => answer } }));
  const { s2, s5 } = await restore(r);
  expect(s2.missingPeers).toEqual([]);
  expect(s2.duplicatePeers).toEqual(["front-door"]);
  expect(s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["peer_unconfirmed"] });
  expect(r.intakeOpen()).toBe(false);
});

test("F06 복원: 장부 밖 점유는 그 종류의 슬롯을 막는다", async () => {
  const ledger = open(tempPath());
  const ghost = id();
  const runs: RunStatus[] = [{ run_id: ghost, state: "running", run_generation: 1, last_receipt_id: null }];
  const r = restorer(ledger, ports({ occupancy: { occupancy: async () => [{ executorId: EXECUTOR, coverage: "full", runs }] } }));
  const { s2, s5 } = await restore(r);
  expect(s2.terminate).toMatchObject([{ runId: ghost, why: "outside_ledger" }]);
  expect(s5.intakeMayOpen).toBe(true);
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  expect(ledger.slotFree("session")).toEqual({ known: true, value: true });
  const queued = must(ledger.admitRun(worker())).run;
  expect(ledger.startRun({ runId: queued.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "slot_busy" });
});

test("F06 복원: 장부의 대기 실행을 실행기가 돌리고 있다고 하면 시작 대기 목록에서 빼고 슬롯을 막는다", async () => {
  const path = tempPath();
  let ledger = open(path);
  ready(ledger);
  const queued = must(ledger.admitRun(worker())).run;
  ledger = reopen(ledger, path);
  const runs: RunStatus[] = [{ run_id: queued.runId, state: "running", run_generation: queued.runGeneration, last_receipt_id: null }];
  const { s2, s5 } = await restore(restorer(ledger, ports({ occupancy: { occupancy: async () => [{ executorId: EXECUTOR, coverage: "full", runs }] } })));
  expect(s2.occupancyMismatches).toMatchObject([{ runId: queued.runId, why: "state" }]);
  expect(s5.queued).toEqual([]);
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  expect(ledger.startRun({ runId: queued.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "slot_busy" });
});

test("F06 복원: 지정 실행기가 아닌 실행기나 다른 세대의 보고는 일치로 세지 않는다", async () => {
  const path = tempPath();
  let ledger = open(path);
  ready(ledger);
  const a = must(ledger.admitRun(worker())).run;
  must(ledger.startRun({ runId: a.runId, requestId: id(), stopGeneration: 0, now: NOW }));
  ledger = reopen(ledger, path);
  const other = "executor/diagnosis/1/store-b";
  const occupancy = async () => [
    { executorId: other, coverage: "full" as const, runs: [{ run_id: a.runId, state: "running" as const, run_generation: a.runGeneration, last_receipt_id: null }] },
    { executorId: EXECUTOR, coverage: "full" as const, runs: [{ run_id: a.runId, state: "running" as const, run_generation: a.runGeneration + 1, last_receipt_id: null }] },
  ];
  const { s2 } = await restore(restorer(ledger, ports({ occupancy: { occupancy } })));
  expect(s2.occupancyMismatches.map((m) => m.why).sort()).toEqual(["executor", "generation"]);
});

test("F06 복원: 실행기 이름으로 슬롯 종류를 알 수 없으면 접수를 보류한다", async () => {
  const runs: RunStatus[] = [{ run_id: id(), state: "running", run_generation: 1, last_receipt_id: null }];
  const { s5 } = await restore(restorer(open(tempPath()), ports({ occupancy: { occupancy: async () => [{ executorId: "someone", coverage: "full", runs }] } })));
  expect(s5).toMatchObject({ intakeMayOpen: false });
  expect(s5.closedBecause).toContain("occupancy_unresolved");
});

test("F07 복원: 종료 확인이 장부에 있는 checking은 재시작 뒤에도 결과 검사를 이어 정리까지 간다", async () => {
  const path = tempPath();
  let ledger = open(path);
  ready(ledger);
  const run = must(ledger.admitRun(worker())).run;
  const start = id();
  must(ledger.startRun({ runId: run.runId, requestId: start, stopGeneration: 0, now: NOW }));
  const sender = { sender: EXECUTOR, runGeneration: run.runGeneration };
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: run.runId, exit: "completed", bodyDigest: digest("stop"), now: NOW }, sender));
  expect(stateOf(ledger, run.runId)).toBe("checking");
  ledger = reopen(ledger, path);
  const { s3 } = await restore(restorer(ledger));
  expect(s3.markedUnknown).toEqual([]);
  expect(s3.resumeChecks).toEqual([run.runId]);
  expect(stateOf(ledger, run.runId)).toBe("checking");
  must(ledger.markResult({ runId: run.runId, resultDigest: digest("result"), now: NOW }));
  const finalize = id();
  must(ledger.recordFinalizeInstruction({ runId: run.runId, requestId: finalize, stopGeneration: 0, now: NOW }));
  must(ledger.applyReceipt({ action: "receipt_cleaned", receiptId: id(), runId: run.runId, instructionRequestId: finalize, bodyDigest: digest("clean"), now: NOW }, sender));
  expect(stateOf(ledger, run.runId)).toBe("finalized");
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: true });
});

test("F08 세션: 이미 적힌 허가를 실은 다른 인수는 거절되고 앞 세션이 끝나지 않는다", async () => {
  const ledger = open(tempPath());
  await restore(restorer(ledger));
  const permit = id();
  const sender = "executor/session/0/store-s";
  const s1 = must(ledger.admitRun(session())).run;
  const from = { sender, runGeneration: s1.runGeneration };
  const takeover = { action: "receipt_session_takeover" as const, previousRunId: s1.runId, takenOverAt: NOW, now: NOW };
  must(ledger.applyReceipt({ ...takeover, receiptId: id(), newGenerationMarkerDigest: digest("marker-1"), startPermitId: permit, bodyDigest: digest("tk-first") }, from));
  // 허가만 겹친다: 표식과 영수증 ID는 처음 보는 것이다.
  expect(ledger.applyReceipt({ ...takeover, receiptId: id(), newGenerationMarkerDigest: digest("marker-2"), startPermitId: permit, bodyDigest: digest("tk-permit") }, from)).toEqual({ ok: false, reason: "permit_used" });
  expect(stateOf(ledger, s1.runId)).toBe("queued");
  expect(ledger.getRun(s1.runId)).toMatchObject({ value: { stopReceiptId: null } });
});

test("F09 장부: 실행 세대가 오른 뒤에는 옛 세대의 대기 실행을 시작하지 않는다", async () => {
  const path = tempPath();
  let ledger = open(path);
  ready(ledger);
  const old = must(ledger.admitRun(worker())).run;
  ledger.close();
  const raw = new Database(path);
  raw.run("UPDATE run_epoch SET generation = 2");
  raw.close();
  ledger = open(path);
  const { s5 } = await restore(restorer(ledger));
  expect(s5.queued).toEqual([]);
  expect(s5.staleQueued).toEqual([old.runId]);
  expect(ledger.startRun({ runId: old.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "run_generation_stale" });
  // 옛 실행의 종료 기록은 된다.
  expect(ledger.recordStopInstruction({ runId: old.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW })).toMatchObject({ ok: true, run: { state: "not_started" } });
});

test("F10 영수증: 지정 실행기가 아닌 인스턴스의 영수증은 상태·ack·슬롯을 바꾸지 않는다", async () => {
  const ledger = open(tempPath());
  await restore(restorer(ledger));
  const run = must(ledger.admitRun(worker())).run;
  must(ledger.startRun({ runId: run.runId, requestId: id(), stopGeneration: 0, now: NOW }));
  const receipt = { action: "receipt_stopped" as const, receiptId: id(), runId: run.runId, exit: "completed" as const, bodyDigest: digest("stop"), now: NOW };
  expect(ledger.applyReceipt(receipt, { sender: "executor/diagnosis/1/store-b", runGeneration: run.runGeneration })).toEqual({ ok: false, reason: "sender_mismatch" });
  expect(ledger.applyReceipt(receipt, { sender: EXECUTOR, runGeneration: run.runGeneration + 1 })).toEqual({ ok: false, reason: "run_generation_mismatch" });
  expect(stateOf(ledger, run.runId)).toBe("preparing");
  const signal = { kind: "hook" as const, event: "Stop" as const, sessionId: id(), turnId: id(), stopFailure: null, observedAt: NOW };
  const report = { reportId: id(), action: "report_hook_event" as const, runId: run.runId, bodyDigest: digest("hook"), storedRef: null, resultDigest: null, signal, now: NOW };
  expect(ledger.recordReport(report, { sender: "executor/diagnosis/1/store-b", runGeneration: run.runGeneration })).toEqual({ ok: false, reason: "sender_mismatch" });
  // 거절된 영수증은 적히지 않아 지정 실행기의 같은 영수증이 새것으로 반영된다.
  expect(ledger.applyReceipt(receipt, { sender: EXECUTOR, runGeneration: run.runGeneration })).toMatchObject({ ok: true, delivery: "new" });
  expect(stateOf(ledger, run.runId)).toBe("checking");
});
