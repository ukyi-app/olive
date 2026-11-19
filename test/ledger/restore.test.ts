import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { RunStatus } from "../../src/contract/v1/index.ts";
import { type Ledger, LedgerInputError, type RestorePorts, RestoreOrderError, Restorer, RestoreStepError } from "../../src/ledger/index.ts";
import { clock, digest, id, must, NOW, open, ready, session, startedWorker, tempPath, worker } from "./helpers.ts";

const OPTS = { requiredPeers: ["front-door"] };

// 시험용 가짜 포트. 기본은 "기록 없음, 모두 v1, 점유 없음, 게시는 대기".
function ports(overrides: Partial<{ [K in keyof RestorePorts]: Partial<RestorePorts[K]> }> = {}): RestorePorts {
  return {
    stopAuthority: { latestStop: async () => null, ...overrides.stopAuthority },
    peers: { contracts: async () => [{ peer: "front-door", contract: "olive-control/v1" }], ...overrides.peers },
    occupancy: { occupancy: async () => [], ...overrides.occupancy },
    publications: { lookup: async () => ({ kind: "pending" as const }), ...overrides.publications },
  };
}

async function all(restorer: Restorer) {
  return { s1: await restorer.step1(), s2: await restorer.step2(), s3: await restorer.step3(), s4: await restorer.step4(), s5: await restorer.step5() };
}

function stateOf(ledger: Ledger, runId: string) {
  const read = ledger.getRun(runId);
  return read.known ? read.value?.state : "모름";
}

test("복원: 1단계 전에는 정지 세대가 null이다", async () => {
  const ledger = open(tempPath());
  must(ledger.applyStop({ generation: 4, stopped: false, now: NOW }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const restorer = new Restorer(ledger, ports({ stopAuthority: { latestStop: async () => (await gate, null) } }), clock, OPTS);
  expect(restorer.stopGeneration()).toBeNull();
  const pending = restorer.step1();
  expect(restorer.stopGeneration()).toBeNull();
  expect(restorer.intakeOpen()).toBe(false);
  release();
  expect(await pending).toEqual({ stopGeneration: 4, stopped: false, source: "ledger" });
  expect(restorer.stopGeneration()).toBe(4);
});

test("복원: 권위 기록이 더 새로우면 먼저 적용하고, 모르면 null을 유지한다", async () => {
  const ledger = open(tempPath());
  must(ledger.applyStop({ generation: 2, stopped: false, now: NOW }));
  const unknown = new Restorer(ledger, ports({ stopAuthority: { latestStop: async () => Promise.reject(new Error("timeout")) } }), clock, OPTS);
  await expect(unknown.step1()).rejects.toBeInstanceOf(RestoreStepError);
  expect(unknown.stopGeneration()).toBeNull();
  await expect(unknown.step2()).rejects.toBeInstanceOf(RestoreOrderError);
  const newer = new Restorer(ledger, ports({ stopAuthority: { latestStop: async () => ({ generation: 7, stopped: true }) } }), clock, OPTS);
  expect(await newer.step1()).toEqual({ stopGeneration: 7, stopped: true, source: "authority" });
  expect(ledger.readStop()).toMatchObject({ value: { generation: 7, stopped: true } });
});

test("복원: 장부와 권위 기록이 모두 없으면 0을 적는다", async () => {
  const ledger = open(tempPath());
  const restorer = new Restorer(ledger, ports(), clock, OPTS);
  expect(await restorer.step1()).toEqual({ stopGeneration: 0, stopped: false, source: "initialized" });
  expect(ledger.readStop()).toMatchObject({ value: { generation: 0, stopped: false } });
});

test("복원: 앞 단계 없이 뒤 단계를 부르면 실패한다", async () => {
  const restorer = new Restorer(open(tempPath()), ports(), clock, OPTS);
  await expect(restorer.step2()).rejects.toBeInstanceOf(RestoreOrderError);
  await expect(restorer.step5()).rejects.toBeInstanceOf(RestoreOrderError);
  await restorer.step1();
  await expect(restorer.step3()).rejects.toBeInstanceOf(RestoreOrderError);
  await expect(restorer.step1()).rejects.toBeInstanceOf(RestoreOrderError);
  // 같은 단계를 겹쳐 부르는 것도 실패한다.
  const second = new Restorer(open(tempPath()), ports(), clock, OPTS);
  const first = second.step1();
  await expect(second.step1()).rejects.toBeInstanceOf(RestoreOrderError);
  await first;
});

test("복원: 장부에 없는 실행은 종료 대상이고 장부에 올리지 않는다", async () => {
  const ledger = open(tempPath());
  const known = startedWorker(ledger);
  const knownGeneration = ledger.runGeneration(known.runId) as number;
  const ghost = id();
  const runs: RunStatus[] = [
    { run_id: known.runId, state: "running", run_generation: knownGeneration, last_receipt_id: null },
    { run_id: ghost, state: "running", run_generation: 9, last_receipt_id: id() },
    { run_id: id(), state: "not_known", run_generation: null, last_receipt_id: null },
  ];
  const restorer = new Restorer(ledger, ports({ occupancy: { occupancy: async () => [{ executorId: "executor/diagnosis/0/store-a", coverage: "full", runs }] } }), clock, OPTS);
  await restorer.step1();
  const s2 = await restorer.step2();
  expect(s2.terminate).toEqual([{ executorId: "executor/diagnosis/0/store-a", runId: ghost, runGeneration: 9, why: "outside_ledger" }]);
  expect(ledger.getRun(ghost)).toEqual({ known: true, value: null });
  expect((ledger.listRuns() as { value: unknown[] }).value).toHaveLength(1);
});

test("복원: 시작 영수증만 있고 결과가 없으면 다시 실행하지 않고, 증명되지 않으면 unknown_running으로 슬롯을 막는다", async () => {
  const ledger = open(tempPath());
  const { runId, requestId, from } = startedWorker(ledger);
  must(ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId, instructionRequestId: requestId, bodyDigest: digest("st"), now: NOW }, from));
  const before = (ledger.listRuns() as { value: unknown[] }).value.length;
  const restorer = new Restorer(ledger, ports(), clock, OPTS);
  const { s3, s5 } = await all(restorer);
  expect(s3.markedUnknown).toEqual([runId]);
  expect(s3.statusQueries).toEqual([{ executorId: "executor/diagnosis/0/store-a", runIds: [runId] }]);
  expect(stateOf(ledger, runId)).toBe("unknown_running");
  expect((ledger.listRuns() as { value: unknown[] }).value.length).toBe(before);
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  // 접수는 열려도 작업자 자리는 막혀 있다.
  expect(s5.intakeMayOpen).toBe(true);
});

test("복원: 게시 조회의 시간 초과는 모름으로 남는다", async () => {
  const ledger = ready(open(tempPath()));
  must(ledger.recordPublication({ frontJobId: "job-1", candidateDigest: digest("c1"), runId: null, now: NOW }));
  must(ledger.recordPublication({ frontJobId: "job-2", candidateDigest: digest("c2"), runId: null, now: NOW }));
  const restorer = new Restorer(
    ledger,
    ports({
      publications: {
        lookup: async (job) => {
          if (job === "job-1") throw new Error("timeout");
          return { kind: "confirmed", outcome: "posted" };
        },
      },
    }),
    clock,
    OPTS,
  );
  const { s4 } = await all(restorer);
  expect(s4).toEqual({ confirmed: ["job-2"], pending: [], unknown: ["job-1"] });
  expect(ledger.publications()).toMatchObject({
    value: [
      { frontJobId: "job-1", state: "unknown", outcome: null },
      { frontJobId: "job-2", state: "confirmed", outcome: "posted" },
    ],
  });
  // 확정은 모름으로 되돌아가지 않는다.
  expect(ledger.settlePublication("job-2", { kind: "unknown" }, NOW)).toEqual({ ok: false, reason: "publication_confirmed" });
});

test("복원: 정지 중이면 접수를 열지 않는다", async () => {
  const ledger = open(tempPath());
  must(ledger.applyStop({ generation: 3, stopped: true, now: NOW }));
  const restorer = new Restorer(ledger, ports(), clock, OPTS);
  const { s1, s5 } = await all(restorer);
  expect(s1.stopped).toBe(true);
  expect(s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["stopped"] });
  expect(restorer.intakeOpen()).toBe(false);
  expect(restorer.stopGeneration()).toBe(3);
});

test("복원: 이웃의 계약 판이 다르면 접수를 열지 않는다", async () => {
  const restorer = new Restorer(open(tempPath()), ports({ peers: { contracts: async () => [{ peer: "front-door", contract: "olive-control/v2" }] } }), clock, OPTS);
  const { s5 } = await all(restorer);
  expect(s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["contract_mismatch"] });
});

test("복원: 모두 맞으면 접수를 열어도 된다고 내고 예산·일시 중지를 돌려준다", async () => {
  const ledger = open(tempPath());
  must(ledger.setPause(NOW + 3_600_000));
  const restorer = new Restorer(ledger, ports(), clock, OPTS);
  const { s5 } = await all(restorer);
  expect(s5).toEqual({
    intakeMayOpen: true,
    closedBecause: [],
    snapshotOrigin: null,
    diagnosisPausedUntil: NOW + 3_600_000,
    queued: [],
    staleQueued: [],
    cancelledQueued: [],
    expiredQueued: [],
    blockedQueued: [],
    inputs: { processedSeq: 0, pending: [], cancelled: [], expired: [] },
    budgets: [],
  });
  expect(restorer.intakeOpen()).toBe(true);
});

test("복원: 실행 줄이 생기기 전 접수한 입력과 취소된 입력의 대기 실행을 구분해 돌려준다", async () => {
  const ledger = ready(open(tempPath()));
  const kept = id();
  const cancelled = id();
  const expired = id();
  must(ledger.enqueueInput({ requestId: kept, source: "discord", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 60_000 }, receivedAt: NOW }));
  must(ledger.enqueueInput({ requestId: cancelled, source: "discord", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 60_000 }, receivedAt: NOW }));
  must(ledger.enqueueInput({ requestId: expired, source: "discord", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW }, receivedAt: NOW }));
  const run = must(ledger.admitRun(worker({ inputRequestId: cancelled }))).run;
  must(ledger.cancelInput(cancelled, NOW));
  const { s5 } = await all(new Restorer(ledger, ports(), clock, OPTS));
  expect(s5.inputs).toMatchObject({ processedSeq: 0, pending: [{ requestId: kept, seq: 1 }], cancelled: [cancelled], expired: [expired] });
  expect(s5.queued).toEqual([]);
  expect(s5.cancelledQueued).toEqual([run.runId]);
});

test("복원: 결과 보고는 저장 자리와 함께 커밋된 뒤에만 ack가 나가고, 반영 전에 끊기면 다시 꺼낸다", async () => {
  const path = tempPath();
  let ledger = open(path);
  const { runId, from } = startedWorker(ledger);
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId, exit: "completed", bodyDigest: digest("stop"), now: NOW }, from));
  const reportId = id();
  const report = { reportId, action: "report_result" as const, runId, bodyDigest: digest("body"), storedRef: `results/${id()}`, resultDigest: digest("result"), now: NOW };
  expect(() => ledger.recordReport({ ...report, storedRef: null }, from)).toThrow("저장 자리");
  expect(ledger.recordReport(report, from)).toEqual({ ok: true, delivery: "new", ack: reportId });
  ledger.close();
  ledger = open(path);
  const { s3 } = await all(new Restorer(ledger, ports(), clock, OPTS));
  expect(s3.pendingReports).toEqual([{ reportId, action: "report_result", runId, storedRef: report.storedRef, resultDigest: report.resultDigest }]);
  expect(s3.resumeChecks).toEqual([runId]);
  expect(ledger.markResult({ runId, resultDigest: digest("다른 결과"), reportId, now: NOW })).toEqual({ ok: false, reason: "reference_mismatch" });
  must(ledger.markResult({ runId, resultDigest: report.resultDigest, reportId, now: NOW }));
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  // 다시 받은 같은 보고는 중복이고 다시 반영할 일을 만들지 않는다.
  expect(ledger.recordReport(report, from)).toEqual({ ok: true, delivery: "duplicate", ack: reportId });
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
});

test("복원: 확정된 게시와 같은 작업 ID에 다른 후보를 연결하면 충돌이고 확정은 그대로다", async () => {
  const path = tempPath();
  const ledger = ready(open(path));
  must(ledger.recordPublication({ frontJobId: "job-a", candidateDigest: digest("A"), runId: null, now: NOW }));
  expect(ledger.recordPublication({ frontJobId: "job-a", candidateDigest: digest("A"), runId: null, now: NOW })).toEqual({ ok: true, created: false });
  must(ledger.settlePublication("job-a", { kind: "confirmed", outcome: "posted" }, NOW));
  expect(ledger.recordPublication({ frontJobId: "job-a", candidateDigest: digest("B"), runId: null, now: NOW })).toEqual({ ok: false, reason: "publication_conflict" });
  expect(ledger.publications()).toMatchObject({ value: [{ frontJobId: "job-a", candidateDigest: digest("A"), state: "confirmed", outcome: "posted" }] });
  ledger.close();
  // 장부에 바로 써도 확정은 교체·삭제되지 않는다.
  const raw = new Database(path);
  expect(() => raw.query("INSERT OR REPLACE INTO publications (front_job_id, candidate_digest, run_id, state, outcome, updated_at) VALUES ('job-a', ?, NULL, 'pending', NULL, 1)").run(digest("B"))).toThrow(
    "publication_confirmed",
  );
  expect(() => raw.run("DELETE FROM publications WHERE front_job_id = 'job-a'")).toThrow("publication_confirmed");
  raw.close();
});

test("R14 게시: 확정된 게시의 키·후보·실행은 바뀌지 않고 다른 줄의 키 충돌이나 rowid로도 교체되지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const run = must(ledger.admitRun(worker())).run;
  must(ledger.recordPublication({ frontJobId: "job-a", candidateDigest: digest("A"), runId: run.runId, now: NOW }));
  must(ledger.settlePublication("job-a", { kind: "confirmed", outcome: "posted" }, NOW));
  must(ledger.recordPublication({ frontJobId: "job-b", candidateDigest: digest("B"), runId: null, now: NOW }));
  ledger.close();
  const raw = new Database(path);
  raw.run("PRAGMA foreign_keys = ON");
  for (const change of ["candidate_digest = 'x'", "front_job_id = 'job-z'", "run_id = NULL", "state = 'unknown', outcome = NULL", "outcome = 'not_posted'"]) {
    expect(() => raw.run(`UPDATE publications SET ${change} WHERE front_job_id = 'job-a'`), change).toThrow("publication_confirmed");
  }
  // 갱신 시각만은 바꿀 수 있다.
  expect(() => raw.run("UPDATE publications SET updated_at = 5 WHERE front_job_id = 'job-a'")).not.toThrow();
  // 같은 값의 교체와 다른 줄의 키를 확정된 키로 바꾸는 교체.
  expect(() => raw.query("INSERT OR REPLACE INTO publications (front_job_id, candidate_digest, run_id, state, outcome, updated_at) VALUES ('job-a', ?, ?, 'confirmed', 'posted', 1)").run(digest("A"), run.runId)).toThrow("publication_confirmed");
  expect(() => raw.run("UPDATE OR REPLACE publications SET front_job_id = 'job-a' WHERE front_job_id = 'job-b'")).toThrow("publication_confirmed");
  expect(() => raw.query("SELECT rowid FROM publications").all()).toThrow("rowid");
  expect(raw.query("SELECT front_job_id, candidate_digest, run_id FROM publications WHERE state = 'confirmed'").all()).toEqual([{ front_job_id: "job-a", candidate_digest: digest("A"), run_id: run.runId }]);
  raw.close();
});

function checkingRun(ledger: Ledger) {
  const { runId, from } = startedWorker(ledger);
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId, exit: "completed", bodyDigest: digest("stop"), now: NOW }, from));
  return { runId, from };
}

function resultReport(runId: string, result: string) {
  return { reportId: id(), action: "report_result" as const, runId, bodyDigest: digest(`body:${result}`), storedRef: `results/${id()}`, resultDigest: digest(result), now: NOW };
}

test("R11 보고: 보고 ID 없이 판정해도 저장된 결과 보고가 미반영으로 남지 않고, 다른 결과는 충돌로 닫는다", () => {
  const ledger = open(tempPath());
  const { runId, from } = checkingRun(ledger);
  const same = resultReport(runId, "result");
  const other = resultReport(runId, "다른 결과");
  must(ledger.recordReport(same, from));
  must(ledger.recordReport(other, from));
  must(ledger.markResult({ runId, resultDigest: same.resultDigest, now: NOW }));
  expect(stateOf(ledger, runId)).toBe("ready_result");
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  expect(ledger.conflicts()).toEqual({ known: true, value: [{ id: other.reportId, firstDigest: same.resultDigest, otherDigest: other.resultDigest }] });
});

test("R11 보고: 판정이 끝난 실행의 늦은 보고는 같은 결과면 바로 마치고, 반영할 수 없으면 ack 없이 거절한다", () => {
  const ledger = open(tempPath());
  const { runId, from } = checkingRun(ledger);
  const result = resultReport(runId, "result");
  must(ledger.markResult({ runId, resultDigest: result.resultDigest, now: NOW }));
  expect(ledger.recordReport(result, from)).toEqual({ ok: true, delivery: "new", ack: result.reportId });
  expect(stateOf(ledger, runId)).toBe("ready_result");
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  expect(ledger.recordReport(result, from)).toEqual({ ok: true, delivery: "duplicate", ack: result.reportId });
  const other = resultReport(runId, "다른 결과");
  expect(ledger.recordReport(other, from)).toEqual({ ok: false, reason: "receipt_conflict" });
  expect(ledger.conflicts()).toMatchObject({ value: [{ id: other.reportId, firstDigest: result.resultDigest, otherDigest: other.resultDigest }] });
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  // 결과가 없다고 판정한 실행의 결과는 적지 않는다.
  const failed = open(tempPath());
  const second = checkingRun(failed);
  must(failed.markResult({ runId: second.runId, resultDigest: null, now: NOW }));
  expect(failed.recordReport(resultReport(second.runId, "result"), second.from)).toEqual({ ok: false, reason: "transition_denied" });
  expect(failed.pendingReports()).toEqual({ known: true, value: [] });
});

test("R11 보고: 판정 전에 받은 보고가 남은 실행은 상태를 되돌리지 않고 그 보고만 마친다", () => {
  const ledger = open(tempPath());
  const { runId, from } = startedWorker(ledger);
  const report = resultReport(runId, "result");
  must(ledger.recordReport(report, from));
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId, exit: "failed", bodyDigest: digest("stop"), now: NOW }, from));
  expect(stateOf(ledger, runId)).toBe("failed_stopped");
  expect(ledger.markResult({ runId, resultDigest: report.resultDigest, reportId: report.reportId, now: NOW })).toEqual({ ok: false, reason: "transition_denied" });
  must(ledger.markResult({ runId, resultDigest: null, reportId: report.reportId, now: NOW }));
  expect(stateOf(ledger, runId)).toBe("failed_stopped");
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
});

test("R12 보고: 훅과 세션 깨짐 보고는 ack 뒤 재시작해도 어떤 사건이었는지 복원한다", async () => {
  const path = tempPath();
  let ledger = ready(open(path));
  const run = must(ledger.admitRun(session())).run;
  const marker = digest("marker");
  const sender = run.executorId;
  const from = { sender, runGeneration: run.runGeneration };
  const hookSignal = { kind: "hook" as const, event: "StopFailure" as const, sessionId: id(), turnId: id(), stopFailure: "rate_limit" as const, observedAt: NOW };
  const brokenSignal = { kind: "session_broken" as const, cause: "relay_lost" as const, markerDigest: marker, observedAt: NOW };
  const hook = { reportId: id(), action: "report_hook_event" as const, runId: run.runId, bodyDigest: digest("hook"), storedRef: null, resultDigest: null, signal: hookSignal, now: NOW };
  const broken = { reportId: id(), action: "report_session_broken" as const, runId: run.runId, bodyDigest: digest("broken"), storedRef: null, resultDigest: null, signal: brokenSignal, now: NOW };
  must(ledger.recordReport(hook, from));
  must(ledger.recordReport(broken, from));
  ledger.close();
  ledger = open(path);
  const { s3 } = await all(new Restorer(ledger, ports(), clock, OPTS));
  const byId = new Map(s3.pendingReports.map((report) => [report.reportId, report.signal]));
  expect(byId.get(hook.reportId)).toEqual(hookSignal);
  expect(byId.get(broken.reportId)).toEqual(brokenSignal);
  must(ledger.settleReport({ reportId: hook.reportId, now: NOW }));
  expect((ledger.pendingReports() as { value: unknown[] }).value).toHaveLength(1);
});

test("R12 보고: 사건 칸이 없거나 v1이 허용하지 않는 값이면 적지 않는다", () => {
  const ledger = open(tempPath());
  const { runId, from } = startedWorker(ledger);
  const report = { reportId: id(), action: "report_hook_event" as const, runId, bodyDigest: digest("hook"), storedRef: null, resultDigest: null, now: NOW };
  const good = { kind: "hook" as const, event: "Stop" as const, sessionId: id(), turnId: id(), stopFailure: null, observedAt: NOW };
  expect(() => ledger.recordReport(report, from)).toThrow(LedgerInputError);
  for (const signal of [{ ...good, event: "Notification" }, { ...good, event: "StopFailure" }, { ...good, stopFailure: "rate_limit" }, { ...good, sessionId: "not-a-uuid" }, { ...good, text: "모델 출력" }]) {
    expect(() => ledger.recordReport({ ...report, signal } as never, from), JSON.stringify(signal)).toThrow(LedgerInputError);
  }
  expect(() => ledger.recordReport({ ...resultReport(runId, "r"), signal: good }, from)).toThrow(LedgerInputError);
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
});
