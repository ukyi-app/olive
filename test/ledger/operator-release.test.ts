// 판 9(0009-operator-release): 관리자 자리 풀기의 장부 쪽(D-148·D-157·D-158·D-161, D-159의 장부 쪽). 결과 포기, 저장소 비움 닫기,
// 점유 관측 풀기, 관리자가 닫은 실행의 확정 지시와 늦은 정리 영수증, 포기한 실행의 늦은 결과 보고. 실제 임시 장부 파일에 적고 공개
// 읽기와 원 SQL로 본다. 결과 포기 뒤의 확정은 지금 수명 박자(lifeTick)를 불러 본다.
// 파드 이름·ID·digest·시각·키는 이 시험이 지어낸 값이다. 운영값이 아니다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type Envelope, sealEnvelope } from "../../src/contract/v1/index.ts";
import { type Ledger, LedgerInputError, type LedgerRunState, loadMigrations, openLedger, type ReportInput } from "../../src/ledger/index.ts";
import { RESTORE_KEY } from "../../src/ledger/ledger.ts";
import { type LifeLoopPorts, lifeTick, type RunOutcome } from "../../src/supervisor/dispatch/life-loop.ts";
import { clock, digest, id, must, NOW, open, ready, session, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "./helpers.ts";

const FILE = "0009-operator-release.sql";
const VERSION = loadMigrations().findIndex((m) => m.name === FILE) + 1;
const BEFORE = () => loadMigrations().slice(0, VERSION - 1);
const POD = "worker-diagnosis-9a1b-z7qp";
// 시작 지시를 NOW에 낸 실행은 NOW + 31000부터 관리자가 닫을 수 있다. 저장소 비움 닫기의 기본 시각은 그 뒤다.
const LATER = NOW + 60_000;
const ABANDONED_AT = NOW + 5_000;
const keys = generateKeyPairSync("ed25519");
const INSERT_MODES = ["INSERT", "INSERT OR REPLACE", "INSERT OR IGNORE"] as const;

type Started = ReturnType<typeof startedWorker>;
type Checking = Started & { stopReceiptId: string };

function rows(path: string, sql: string, ...params: (string | number)[]): unknown[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query(sql).all(...params);
  } finally {
    raw.close();
  }
}

function rawWrite(path: string, sql: string, ...params: (string | number | null)[]): void {
  const raw = new Database(path);
  try {
    raw.run("PRAGMA foreign_keys = ON");
    raw.query(sql).run(...params);
  } finally {
    raw.close();
  }
}

function state(ledger: Ledger, runId: string) {
  const read = ledger.getRun(runId);
  if (!read.known || read.value === null) throw new Error("실행 없음");
  return read.value;
}

function slotFree(ledger: Ledger): boolean {
  const read = ledger.slotFree("worker");
  if (!read.known) throw new Error("읽지 못함");
  return read.value;
}

function failAt(point: string) {
  return {
    at(reached: string) {
      if (reached === point) throw new Error(`주입한 실패: ${point}`);
    },
  };
}

// 접수·시작 영수증을 받은 작업자 실행(running).
function runningRun(ledger: Ledger): Started {
  const s = startedWorker(ledger);
  must(ledger.applyReceipt({ action: "receipt_accepted", receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, instruction: "task_start", bodyDigest: digest("accepted"), now: NOW }, s.from));
  must(ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, bodyDigest: digest("started"), now: NOW }, s.from));
  return s;
}

function stop(ledger: Ledger, s: Started, exit: "completed" | "cancelled" | "deadline" | "failed", at: number): string {
  const receiptId = id();
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId, runId: s.runId, exit, bodyDigest: digest(`stopped:${exit}`), now: at }, s.from));
  return receiptId;
}

// 종료는 확인됐고(exit completed, NOW + 1) 결과 판정 전인 실행. requested면 그 앞에 사유 requested의 취소 지시를 적는다.
function checkingRun(ledger: Ledger, requested = false): Checking {
  const s = runningRun(ledger);
  if (requested) must(ledger.recordStopInstruction({ runId: s.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  const stopReceiptId = stop(ledger, s, "completed", NOW + 1);
  expect(state(ledger, s.runId).state).toBe("checking");
  return { ...s, stopReceiptId };
}

function resultReport(s: Started, at: number, value = "result"): ReportInput {
  return { reportId: id(), action: "report_result", runId: s.runId, bodyDigest: digest(`report:${value}`), storedRef: `results/${id()}`, resultDigest: digest(value), signal: null, now: at };
}

function readyRun(ledger: Ledger): Checking {
  const c = checkingRun(ledger);
  const report = resultReport(c, NOW + 2);
  must(ledger.recordReport(report, c.from));
  must(ledger.markResult({ runId: c.runId, resultDigest: report.resultDigest, reportId: report.reportId, now: NOW + 3 }));
  expect(state(ledger, c.runId).state).toBe("ready_result");
  return c;
}

function failedRun(ledger: Ledger): Checking {
  const s = runningRun(ledger);
  const stopReceiptId = stop(ledger, s, "failed", NOW + 1);
  expect(state(ledger, s.runId).state).toBe("failed_stopped");
  return { ...s, stopReceiptId };
}

const abandon = (ledger: Ledger, c: Checking, extra: Record<string, unknown> = {}) =>
  ledger.abandonResult({ runId: c.runId, reason: "no_answer", stopReceiptId: c.stopReceiptId, now: ABANDONED_AT, ...extra } as never);

const storeReset = (ledger: Ledger, runId: string, extra: Record<string, unknown> = {}) =>
  ledger.closeRunByOperator({ runId, checkedBy: "store_reset", podName: POD, podStartedAt: LATER, now: LATER, ...extra } as never);

// 확정 지시 하나를 적고 그 요청 ID를 돌려준다.
function finalize(ledger: Ledger, runId: string, at: number, outcome: "failed" | "cancelled" = "failed"): string {
  const requestId = id();
  must(ledger.recordFinalizeInstruction({ runId, requestId, stopGeneration: 0, now: at, outcome, resultDigest: null, storedAt: at }));
  return requestId;
}

const cleaned = (s: Started, requestId: string, at: number) =>
  ({ action: "receipt_cleaned" as const, receiptId: id(), runId: s.runId, instructionRequestId: requestId, bodyDigest: digest(`cleaned:${requestId}`), now: at });

function holdOutside(ledger: Ledger, runId: string = id(), runGeneration = 1, at = NOW + 100) {
  const held = must(ledger.holdSlots(RESTORE_KEY, [{ executorId: WORKER_EXECUTOR, runId, kind: "worker", runGeneration, holdsSlot: true, why: "outside_ledger" }], at));
  return held.holds[0] as { runId: string; runGeneration: number; observation: number; executorId: string };
}

const release = (ledger: Ledger, hold: { runId: string; runGeneration: number; observation: number; executorId: string }, extra: Record<string, unknown> = {}) =>
  ledger.releaseSlotHold({
    executorId: hold.executorId,
    runId: hold.runId,
    runGeneration: hold.runGeneration,
    observation: hold.observation,
    checkedBy: "pod_replaced",
    podName: POD,
    podStartedAt: NOW + 1_000,
    now: NOW + 2_000,
    ...extra,
  } as never);

// ---- 이관 ----

test("이관: 빈 장부는 판 9까지 적용하고 새 근거 표 둘과 버린 실행의 받은 기록 표는 비어 있으며 not_started로 가는 저장소 비움 전이 셋이 있다", () => {
  expect(VERSION).toBe(9);
  const path = tempPath();
  open(path).close();
  expect(rows(path, "SELECT version, name FROM ledger_migrations WHERE version >= ? ORDER BY version", VERSION - 1)).toEqual([
    { version: VERSION - 1, name: "0008-stop-exit.sql" },
    { version: VERSION, name: FILE },
  ]);
  expect(rows(path, "SELECT (SELECT count(*) FROM result_abandons) AS a, (SELECT count(*) FROM slot_hold_releases) AS s, (SELECT count(*) FROM abandoned_result_reports) AS r")).toEqual([{ a: 0, s: 0, r: 0 }]);
  expect(rows(path, "SELECT from_state FROM run_transitions WHERE kind = 'worker' AND to_state = 'not_started' ORDER BY from_state")).toEqual(
    ["checking", "failed_stopped", "preparing", "queued", "ready_result", "stopping", "unknown_running"].map((from_state) => ({ from_state })),
  );
});

test("이관: 판 8 장부를 판 9로 올리면 기존 줄은 그대로이고, 정의가 바뀐 것은 operator_closures_proven 하나다. 판 9 장부는 판 8 코드로 열지 않는다", () => {
  const path = tempPath();
  const old = ready(open(path, { migrations: BEFORE() }));
  // 판 8에서 관리자가 닫은 실행 하나, 결과 판정을 기다리는 실행 하나, 점유 관측 하나.
  const lost = runningRun(old);
  must(old.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  must(old.closeRunByOperator({ runId: lost.runId, checkedBy: "pod_replaced", podName: POD, podStartedAt: LATER, now: LATER }));
  const c = checkingRun(old);
  const hold = holdOutside(old);
  // 판 8 코드는 store_reset을 목록에 두지만 판 8 장부의 트리거가 없어 받지 않는다.
  expect(storeReset(old, c.runId)).toEqual({ ok: false, reason: "transition_denied" });
  expect(abandon(old, c)).toEqual({ ok: false, reason: "transition_denied" });
  expect(release(old, hold)).toEqual({ ok: false, reason: "transition_denied" });
  old.close();
  const tables = ["runs", "instructions", "deliveries", "slot_holds", "stop_state", "run_epoch", "operator_closures", "unreceived_closures"];
  const kept = () => tables.map((table) => rows(path, `SELECT * FROM ${table} ORDER BY 1`));
  const objects = () => new Map((rows(path, "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL") as { name: string; sql: string }[]).map((o) => [o.name, o.sql]));
  const transitions = () => rows(path, "SELECT kind, from_state, to_state FROM run_transitions ORDER BY kind, from_state, to_state");
  const before = kept();
  const eight = objects();
  const transitionsBefore = transitions();

  const upgraded = openLedger(path, { clock, mode: "reopen" });
  expect(upgraded).toMatchObject({ ok: true, migrated: { from: VERSION - 1, to: VERSION } });
  if (upgraded.ok) upgraded.ledger.close();
  expect(kept()).toEqual(before);
  const nine = objects();
  expect([...eight].filter(([name, sql]) => nine.get(name) !== sql).map(([name]) => name)).toEqual(["operator_closures_proven"]);
  expect([...nine.keys()].filter((name) => !eight.has(name)).sort()).toEqual(
    [
      "result_abandons",
      "result_abandons_proven",
      "result_abandons_report_pending",
      "result_abandons_outcome_known",
      "result_abandons_fail_run",
      "result_abandons_fixed",
      "result_abandons_permanent",
      "slot_hold_releases",
      "slot_hold_releases_proven",
      "slot_hold_releases_release",
      "slot_hold_releases_fixed",
      "slot_hold_releases_permanent",
      "abandoned_result_reports",
      "abandoned_result_reports_proven",
      "abandoned_result_reports_fixed",
      "abandoned_result_reports_permanent",
    ].sort(),
  );
  expect(transitions()).toEqual(
    [...transitionsBefore, ...["checking", "ready_result", "failed_stopped"].map((from_state) => ({ kind: "worker", from_state, to_state: "not_started" }))].sort((a, b) =>
      JSON.stringify(a) < JSON.stringify(b) ? -1 : 1,
    ),
  );
  expect(rows(path, "SELECT (SELECT count(*) FROM result_abandons) AS a, (SELECT count(*) FROM slot_hold_releases) AS s, (SELECT count(*) FROM abandoned_result_reports) AS r")).toEqual([{ a: 0, s: 0, r: 0 }]);
  expect(rows(path, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);

  // 올린 장부: 판 8의 관리자 근거는 그대로 읽히고, 새 연산이 기존 줄에 쓰인다.
  const ledger = ready(open(path));
  expect(ledger.operatorClosure(lost.runId)).toMatchObject({ known: true, value: { checkedBy: "pod_replaced", fromState: "unknown_running" } });
  expect(must(abandon(ledger, c)).run.state).toBe("failed_stopped");
  expect(must(release(ledger, hold)).release.observation).toBe(hold.observation);
  ledger.close();
  expect(openLedger(path, { clock, mode: "reopen", migrations: BEFORE() })).toMatchObject({ ok: false, reason: "too_new" });
});

test("이관(D-168): 판 8에서 받아 둔 미반영 결과 보고는 판 9로 올려도 그대로이고, 그 실행은 버리지 않는다", () => {
  const path = tempPath();
  const old = ready(open(path, { migrations: BEFORE() }));
  const c = checkingRun(old);
  const report = resultReport(c, NOW + 2);
  must(old.recordReport(report, c.from));
  old.close();
  const ledger = ready(open(path));
  expect(ledger.pendingReports()).toMatchObject({ known: true, value: [{ reportId: report.reportId }] });
  expect(abandon(ledger, c)).toEqual({ ok: false, reason: "report_pending" });
  expect(state(ledger, c.runId).state).toBe("checking");
  ledger.close();
  expect(rows(path, "SELECT applied_at FROM deliveries WHERE id = ?", report.reportId)).toEqual([{ applied_at: null }]);
});

test("이관: 판 9 이관이 커밋 전에 끊기면 판 8 장부 그대로이고(판 8까지 아는 코드로 열린다), 다시 열면 판 9를 한 번 적용한다", () => {
  const path = tempPath();
  const old = ready(open(path, { migrations: BEFORE() }));
  const c = checkingRun(old);
  old.close();
  const schema = () => rows(path, "SELECT type, name, sql FROM sqlite_master ORDER BY type, name");
  const runs = () => rows(path, "SELECT * FROM runs ORDER BY run_id");
  const versions = () => rows(path, "SELECT version FROM ledger_migrations ORDER BY version");
  const schemaBefore = schema();
  const runsBefore = runs();
  const versionsBefore = versions();
  expect(versionsBefore.at(-1)).toEqual({ version: VERSION - 1 });

  expect(openLedger(path, { clock, mode: "reopen", faults: failAt(`migration:${VERSION}`) })).toMatchObject({ ok: false, reason: "migration_failed" });
  expect(versions()).toEqual(versionsBefore);
  expect(schema()).toEqual(schemaBefore);
  expect(runs()).toEqual(runsBefore);
  const eight = openLedger(path, { clock, mode: "reopen", migrations: BEFORE() });
  expect(eight).toMatchObject({ ok: true, migrated: { from: VERSION - 1, to: VERSION - 1 } });
  if (eight.ok) eight.ledger.close();

  const resumed = openLedger(path, { clock, mode: "reopen" });
  expect(resumed).toMatchObject({ ok: true, migrated: { from: VERSION - 1, to: VERSION } });
  if (resumed.ok) resumed.ledger.close();
  expect(versions()).toEqual([...versionsBefore, { version: VERSION }]);
  expect(runs()).toEqual(runsBefore);
  expect(rows(path, "SELECT state FROM runs WHERE run_id = ?", c.runId)).toEqual([{ state: "checking" }]);
});

// ---- 결과 포기(D-148·D-157) ----

test("결과 포기: checking 실행은 근거와 함께 failed_stopped가 되고 실패 시각은 포기 시각이다. 자리는 정리 전까지 쥔다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const c = checkingRun(ledger);

  const done = must(abandon(ledger, c, { reason: "unstorable" }));
  expect(done.run).toMatchObject({ state: "failed_stopped", resultDigest: null, stopReceiptId: c.stopReceiptId, updatedAt: ABANDONED_AT });
  const expected = { runId: c.runId, reason: "unstorable" as const, stopReceiptId: c.stopReceiptId, stopGeneration: 0, abandonedAt: ABANDONED_AT };
  expect(done.abandon).toEqual(expected);
  expect(ledger.resultAbandon(c.runId)).toEqual({ known: true, value: expected });
  expect(ledger.failedStop(c.runId)).toEqual({ known: true, value: { runId: c.runId, stoppedAt: ABANDONED_AT, requestedCancel: false, exit: "completed" } });
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  expect(slotFree(ledger)).toBe(false);
  // 같은 포기를 다시 부르면 이미 판정된 실행이다.
  expect(abandon(ledger, c)).toEqual({ ok: false, reason: "not_checking" });
  ledger.close();
  expect(rows(path, "SELECT state, stop_exit, failed_stopped_at FROM runs WHERE run_id = ?", c.runId)).toEqual([{ state: "failed_stopped", stop_exit: "completed", failed_stopped_at: ABANDONED_AT }]);
});

test("결과 포기의 거절: 조건마다 이름 하나이고 상태와 근거는 그대로다", () => {
  const fresh = () => ready(open(tempPath()));
  expect(abandon(fresh(), { runId: id(), stopReceiptId: id() } as Checking)).toEqual({ ok: false, reason: "unknown_run" });

  const withSession = fresh();
  const sessionRun = must(withSession.admitRun(session())).run.runId;
  expect(abandon(withSession, { runId: sessionRun, stopReceiptId: id() } as Checking)).toEqual({ ok: false, reason: "run_not_worker" });

  const withCancelled = fresh();
  const cancelled = must(withCancelled.admitRun(worker())).run.runId;
  must(withCancelled.recordStopInstruction({ runId: cancelled, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  expect(abandon(withCancelled, { runId: cancelled, stopReceiptId: id() } as Checking)).toEqual({ ok: false, reason: "run_ended" });

  // checking 밖: 진행 중(종료 확인 전), 결과가 있다고 판정됨, 곧바로 실패로 끝남.
  const running = fresh();
  const live = runningRun(running);
  expect(abandon(running, { ...live, stopReceiptId: id() })).toEqual({ ok: false, reason: "not_checking" });
  const judged = fresh();
  const r = readyRun(judged);
  expect(abandon(judged, r)).toEqual({ ok: false, reason: "not_checking" });
  const failed = fresh();
  const f = failedRun(failed);
  expect(abandon(failed, f)).toEqual({ ok: false, reason: "not_checking" });

  const mismatch = fresh();
  const c = checkingRun(mismatch);
  expect(abandon(mismatch, { ...c, stopReceiptId: id() })).toEqual({ ok: false, reason: "reference_mismatch" });
  expect(state(mismatch, c.runId).state).toBe("checking");
  expect(mismatch.resultAbandon(c.runId)).toEqual({ known: true, value: null });

  // 판 9 전의 장부(판 목록을 끊어 연 시험용 길)에는 근거 표가 없다.
  const eight = ready(open(tempPath(), { migrations: BEFORE() }));
  const old = checkingRun(eight);
  expect(abandon(eight, old)).toEqual({ ok: false, reason: "transition_denied" });
  expect(eight.resultAbandon(old.runId)).toEqual({ known: true, value: null });

  const closed = fresh();
  const gone = checkingRun(closed);
  closed.close();
  expect(abandon(closed, gone)).toEqual({ ok: false, reason: "ledger_unwritable" });

  const inputs = fresh();
  const ci = checkingRun(inputs);
  expect(() => abandon(inputs, ci, { reason: "operator_said_so" })).toThrow(LedgerInputError);
  expect(() => abandon(inputs, ci, { stopReceiptId: "not-a-uuid" })).toThrow(LedgerInputError);
  expect(() => abandon(inputs, ci, { note: "free text" })).toThrow(LedgerInputError);
  expect(state(inputs, ci.runId).state).toBe("checking");
});

test("결과 포기: 원 SQL도 근거 대조를 지나야 하고(세 INSERT 방식 모두), 근거 없이 checking을 닫을 수 없으며, 근거 줄은 고치거나 지울 수 없다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const c = checkingRun(ledger);
  ledger.close();
  const raw = (mode: string) => `${mode} INTO result_abandons (run_id, reason, stop_receipt_id, stop_generation, abandoned_at) VALUES (?, ?, ?, ?, ?)`;
  const bad: [string, (string | number | null)[]][] = [
    ["다른 종료 영수증", [c.runId, "no_answer", id(), 0, ABANDONED_AT]],
    ["목록 밖 사유", [c.runId, "operator_said_so", c.stopReceiptId, 0, ABANDONED_AT]],
    ["다른 정지 세대", [c.runId, "no_answer", c.stopReceiptId, 1, ABANDONED_AT]],
    ["TEXT 시각", [c.runId, "no_answer", c.stopReceiptId, 0, String(ABANDONED_AT)]],
    ["NULL 시각", [c.runId, "no_answer", c.stopReceiptId, 0, null]],
    ["NULL 사유", [c.runId, null, c.stopReceiptId, 0, ABANDONED_AT]],
  ];
  for (const mode of INSERT_MODES) {
    for (const [name, params] of bad) expect(() => rawWrite(path, raw(mode), ...params), `${mode} ${name}`).toThrow("result_abandon_unproven");
  }
  expect(rows(path, "SELECT state, failed_stopped_at FROM runs WHERE run_id = ?", c.runId)).toEqual([{ state: "checking", failed_stopped_at: null }]);
  expect(rows(path, "SELECT count(*) AS n FROM result_abandons")).toEqual([{ n: 0 }]);
  expect(() => rawWrite(path, "UPDATE runs SET state = 'not_started', updated_at = ? WHERE run_id = ?", LATER, c.runId)).toThrow("run_closure_unproven");

  rawWrite(path, raw("INSERT"), c.runId, "not_known", c.stopReceiptId, 0, ABANDONED_AT);
  expect(rows(path, "SELECT state, failed_stopped_at, updated_at FROM runs WHERE run_id = ?", c.runId)).toEqual([{ state: "failed_stopped", failed_stopped_at: ABANDONED_AT, updated_at: ABANDONED_AT }]);
  expect(() => rawWrite(path, raw("INSERT OR REPLACE"), c.runId, "no_answer", c.stopReceiptId, 0, ABANDONED_AT + 1)).toThrow("result_abandon_unproven");
  expect(() => rawWrite(path, "UPDATE result_abandons SET reason = 'no_answer' WHERE run_id = ?", c.runId)).toThrow("result_abandon_unproven");
  expect(() => rawWrite(path, "DELETE FROM result_abandons WHERE run_id = ?", c.runId)).toThrow("result_abandon_unproven");
  expect(rows(path, "SELECT reason, abandoned_at FROM result_abandons WHERE run_id = ?", c.runId)).toEqual([{ reason: "not_known", abandoned_at: ABANDONED_AT }]);
});

// D-168: 받아 두고 판정에 반영하지 않은 결과 보고가 있는 실행은 버리지 않는다. 근거·실행 줄·보고는 그대로이고 결과 검사가 판정한다.
test("결과 포기의 거절(D-168): 미반영 결과 보고가 있는 checking은 report_pending이고 근거·실행·보고가 그대로이며, 뒤의 판정이 그 결과를 쓴다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const c = checkingRun(ledger);
  const report = resultReport(c, NOW + 2);
  must(ledger.recordReport(report, c.from));
  for (const reason of ["no_answer", "not_known", "unstorable"] as const) {
    expect(abandon(ledger, c, { reason }), reason).toEqual({ ok: false, reason: "report_pending" });
  }
  expect(state(ledger, c.runId)).toMatchObject({ state: "checking", resultDigest: null });
  expect(ledger.resultAbandon(c.runId)).toEqual({ known: true, value: null });
  expect(ledger.pendingReports()).toMatchObject({ known: true, value: [{ reportId: report.reportId }] });
  // 결과 검사 박자가 하는 판정(markResult)은 그 보고를 그대로 반영하고, 그 뒤의 포기는 이미 판정된 실행이다.
  must(ledger.markResult({ runId: c.runId, resultDigest: report.resultDigest, reportId: report.reportId, now: NOW + 3 }));
  expect(state(ledger, c.runId)).toMatchObject({ state: "ready_result", resultDigest: report.resultDigest });
  expect(ledger.settledResult(c.runId)).toMatchObject({ known: true, value: { storedRef: report.storedRef } });
  expect(abandon(ledger, c)).toEqual({ ok: false, reason: "not_checking" });
  // 결과 밖의 미반영 보고(훅 사건)는 막지 않는다.
  const hookLedger = ready(open(tempPath()));
  const other = checkingRun(hookLedger);
  const hook: ReportInput = {
    reportId: id(),
    action: "report_hook_event",
    runId: other.runId,
    bodyDigest: digest("hook"),
    storedRef: null,
    resultDigest: null,
    signal: { kind: "hook", event: "Stop", sessionId: id(), turnId: id(), stopFailure: null, observedAt: NOW + 2 },
    now: NOW + 2,
  };
  must(hookLedger.recordReport(hook, other.from));
  expect(must(abandon(hookLedger, other)).run.state).toBe("failed_stopped");
  expect(hookLedger.pendingReports()).toMatchObject({ known: true, value: [{ reportId: hook.reportId }] });
  ledger.close();
  expect(rows(path, "SELECT applied_at FROM deliveries WHERE id = ?", report.reportId)).toEqual([{ applied_at: NOW + 3 }]);
});

test("결과 포기의 거절(D-168): 원 SQL도 미반영 결과 보고가 있으면 세 INSERT 방식 모두 막고 상태·보고는 그대로다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const c = checkingRun(ledger);
  const report = resultReport(c, NOW + 2);
  must(ledger.recordReport(report, c.from));
  ledger.close();
  for (const mode of INSERT_MODES) {
    expect(
      () => rawWrite(path, `${mode} INTO result_abandons (run_id, reason, stop_receipt_id, stop_generation, abandoned_at) VALUES (?, ?, ?, ?, ?)`, c.runId, "no_answer", c.stopReceiptId, 0, ABANDONED_AT),
      mode,
    ).toThrow("result_abandon_report_pending");
  }
  expect(rows(path, "SELECT state, failed_stopped_at FROM runs WHERE run_id = ?", c.runId)).toEqual([{ state: "checking", failed_stopped_at: null }]);
  expect(rows(path, "SELECT applied_at FROM deliveries WHERE id = ?", report.reportId)).toEqual([{ applied_at: null }]);
  expect(rows(path, "SELECT count(*) AS n FROM result_abandons")).toEqual([{ n: 0 }]);
});

// D-148: 버린 뒤 D-114 확정 outcome을 정할 수 없는 실행(사유 없는 취소 지시만 있음)은 버리지 않는다.
function reasonlessCancelChecking(ledger: Ledger, alsoRequested = false): Checking {
  const s = runningRun(ledger);
  must(ledger.recordStopInstruction({ runId: s.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW }));
  if (alsoRequested) must(ledger.recordStopInstruction({ runId: s.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  const stopReceiptId = stop(ledger, s, "completed", NOW + 1);
  expect(state(ledger, s.runId).state).toBe("checking");
  return { ...s, stopReceiptId };
}

test("결과 포기의 거절(D-148): 사유 없는 취소 지시만 있는 checking은 outcome_unknown이고 그대로다. 사유 requested가 함께 있으면 cancelled로 확정할 수 있어 버린다", () => {
  const ledger = ready(open(tempPath()));
  const c = reasonlessCancelChecking(ledger);
  expect(abandon(ledger, c, { reason: "not_known" })).toEqual({ ok: false, reason: "outcome_unknown" });
  expect(state(ledger, c.runId).state).toBe("checking");
  expect(ledger.resultAbandon(c.runId)).toEqual({ known: true, value: null });
  expect(slotFree(ledger)).toBe(false);

  const other = ready(open(tempPath()));
  const both = reasonlessCancelChecking(other, true);
  must(abandon(other, both));
  expect(other.failedStop(both.runId)).toEqual({ known: true, value: { runId: both.runId, stoppedAt: ABANDONED_AT, requestedCancel: true, exit: "completed" } });
});

test("결과 포기의 거절(D-148): 원 SQL도 사유 없는 취소 지시만 있으면 세 INSERT 방식 모두 막는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const c = reasonlessCancelChecking(ledger);
  ledger.close();
  for (const mode of INSERT_MODES) {
    expect(
      () => rawWrite(path, `${mode} INTO result_abandons (run_id, reason, stop_receipt_id, stop_generation, abandoned_at) VALUES (?, ?, ?, ?, ?)`, c.runId, "not_known", c.stopReceiptId, 0, ABANDONED_AT),
      mode,
    ).toThrow("result_abandon_outcome_unknown");
  }
  expect(rows(path, "SELECT state, failed_stopped_at FROM runs WHERE run_id = ?", c.runId)).toEqual([{ state: "checking", failed_stopped_at: null }]);
  expect(rows(path, "SELECT count(*) AS n FROM result_abandons")).toEqual([{ n: 0 }]);
});

// 수명 박자의 포트. 장부는 실제 장부이고 서명·내보내기는 이 시험의 키와 목록이다.
function lifePorts(ledger: Ledger, at: number, sent: Envelope[]): LifeLoopPorts {
  return {
    ledger,
    intake: { intakeOpen: () => ledger.intakeOpen(), stopGeneration: () => 0 },
    links: { mayIssue: () => ({ ok: true }) as never },
    clock: { now: () => at },
    random: { bytes: (length: number) => getRandomValues(new Uint8Array(length)) },
    signer: { seal: (input: Parameters<typeof sealEnvelope>[0]) => sealEnvelope(input, keys.privateKey) },
    sink: {
      send: async (envelope: Envelope) => {
        sent.push(envelope);
        return "sent" as const;
      },
    },
  } as never;
}

async function lifeOutcome(ledger: Ledger, runId: string, at: number, sent: Envelope[]): Promise<RunOutcome> {
  const result = await lifeTick(lifePorts(ledger, at, sent), { renewEveryMs: 10_000, answerTimeoutMs: 20_000 }, { lastQueries: [], unsentRenews: [] });
  if (result.kind !== "ran") throw new Error(`박자가 돌지 않음: ${JSON.stringify(result)}`);
  const outcome = result.runs.find((r) => r.runId === runId);
  if (outcome === undefined) throw new Error(`결과 없음: ${JSON.stringify(result)}`);
  return outcome;
}

test("결과 포기 뒤 지금 수명 박자가 D-114대로 확정을 내고(stored_at = 포기 시각), 정리 영수증으로 finalized가 되어 작업자 자리가 풀린다", async () => {
  for (const [requested, outcome] of [
    [false, "failed"],
    [true, "cancelled"],
  ] as const) {
    const ledger = ready(open(tempPath()));
    const c = checkingRun(ledger, requested);
    const sent: Envelope[] = [];
    // 포기 전의 checking은 확정을 내지 않는다(결과 판정 전).
    expect((await lifeOutcome(ledger, c.runId, NOW + 4_000, sent)).outcome, String(requested)).not.toBe("finalize_sent");
    expect(sent).toEqual([]);
    must(abandon(ledger, c));
    const life = await lifeOutcome(ledger, c.runId, NOW + 10_000, sent);
    expect(life, String(requested)).toMatchObject({ outcome: "finalize_sent", issuedAt: NOW + 10_000, executorId: WORKER_EXECUTOR });
    expect(sent.map((e) => e.body), String(requested)).toEqual([{ run_id: c.runId, outcome, result_digest: null, stored_at: ABANDONED_AT }]);
    expect(slotFree(ledger)).toBe(false);
    const requestId = (life as { requestId: string }).requestId;
    expect(must(ledger.applyReceipt(cleaned(c, requestId, NOW + 10_001), c.from)).delivery).toBe("new");
    expect(state(ledger, c.runId)).toMatchObject({ state: "finalized" });
    expect(slotFree(ledger), String(requested)).toBe(true);
  }
});

test("포기한 실행에 늦게 온 결과 보고는 받은 기록만 남기고 ack로 마친다(실행 줄은 그대로, 재전송은 duplicate). 결과 없음 판정 실행은 그대로 거절한다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const c = checkingRun(ledger);
  must(abandon(ledger, c));
  const late = resultReport(c, NOW + 6_000, "late");
  expect(ledger.recordReport(late, c.from)).toEqual({ ok: true, delivery: "new", ack: late.reportId });
  expect(ledger.recordReport(late, c.from)).toEqual({ ok: true, delivery: "duplicate", ack: late.reportId });
  expect(state(ledger, c.runId)).toMatchObject({ state: "failed_stopped", resultDigest: null });
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  // 확정·정리 뒤(finalized)에 온 보고도 같다.
  const requestId = finalize(ledger, c.runId, NOW + 7_000);
  must(ledger.applyReceipt(cleaned(c, requestId, NOW + 7_001), c.from));
  const later = resultReport(c, NOW + 8_000, "later");
  expect(ledger.recordReport(later, c.from)).toEqual({ ok: true, delivery: "new", ack: later.reportId });
  expect(state(ledger, c.runId).state).toBe("finalized");
  ledger.close();
  expect(rows(path, "SELECT applied_at, result_digest FROM deliveries WHERE id = ?", late.reportId)).toEqual([{ applied_at: NOW + 6_000, result_digest: late.resultDigest }]);
  expect(rows(path, "SELECT count(*) AS n FROM receipt_conflicts")).toEqual([{ n: 0 }]);

  // 대조군: 실행기의 답으로 결과 없음 판정된 실행(markResult(null))의 늦은 결과는 지금처럼 적지 않고 거절한다.
  const judged = ready(open(tempPath()));
  const j = checkingRun(judged);
  must(judged.markResult({ runId: j.runId, resultDigest: null, now: NOW + 3 }));
  expect(judged.recordReport(resultReport(j, NOW + 6_000), j.from)).toEqual({ ok: false, reason: "transition_denied" });
});

// D-169: 결과를 버린 실행의 결과 보고를 본문 보관 없이 받은 기록. 감독 수신기의 길은 test/supervisor/dispatch/receipts-abandoned.test.ts가 본다.
const abandonedReport = (s: Started, at: number, value = "late") => ({ reportId: id(), runId: s.runId, bodyDigest: digest(`report:${value}`), now: at });

test("버린 실행의 받은 기록(D-169): 같은 ID·같은 digest는 duplicate, 다른 digest는 충돌이고, 실행 줄·보고·자리는 그대로다. 두 표의 ID는 하나로 가른다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const c = checkingRun(ledger);
  must(abandon(ledger, c, { reason: "unstorable" }));
  const late = abandonedReport(c, NOW + 6_000);
  expect(ledger.recordAbandonedReport(late, c.from)).toEqual({ ok: true, delivery: "new", ack: late.reportId });
  expect(ledger.recordAbandonedReport({ ...late, now: NOW + 7_000 }, c.from)).toEqual({ ok: true, delivery: "duplicate", ack: late.reportId });
  expect(ledger.recordAbandonedReport({ ...late, bodyDigest: digest("other body") }, c.from)).toEqual({ ok: false, reason: "receipt_conflict" });
  // recordReport도 같은 ID를 이 기록과 대조한다.
  const sameId = { ...resultReport(c, NOW + 8_000), reportId: late.reportId };
  expect(ledger.recordReport({ ...sameId, bodyDigest: late.bodyDigest }, c.from)).toEqual({ ok: true, delivery: "duplicate", ack: late.reportId });
  expect(ledger.recordReport(sameId, c.from)).toEqual({ ok: false, reason: "receipt_conflict" });
  // deliveries에 먼저 적힌 ID(저장 자리가 있는 늦은 보고)도 같다.
  const stored = resultReport(c, NOW + 9_000, "stored");
  must(ledger.recordReport(stored, c.from));
  expect(ledger.recordAbandonedReport({ reportId: stored.reportId, runId: c.runId, bodyDigest: stored.bodyDigest, now: NOW + 9_001 }, c.from)).toEqual({
    ok: true,
    delivery: "duplicate",
    ack: stored.reportId,
  });
  expect(state(ledger, c.runId)).toMatchObject({ state: "failed_stopped", resultDigest: null });
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  expect(slotFree(ledger)).toBe(false);
  // 확정·정리 뒤(finalized)에도 받는다.
  const requestId = finalize(ledger, c.runId, NOW + 10_000);
  must(ledger.applyReceipt(cleaned(c, requestId, NOW + 10_001), c.from));
  const later = abandonedReport(c, NOW + 11_000, "later");
  expect(ledger.recordAbandonedReport(later, c.from)).toEqual({ ok: true, delivery: "new", ack: later.reportId });
  ledger.close();
  expect(rows(path, "SELECT report_id, run_id, sender, run_generation, body_digest, received_at FROM abandoned_result_reports ORDER BY received_at")).toEqual([
    { report_id: late.reportId, run_id: c.runId, sender: WORKER_EXECUTOR, run_generation: 1, body_digest: late.bodyDigest, received_at: NOW + 6_000 },
    { report_id: later.reportId, run_id: c.runId, sender: WORKER_EXECUTOR, run_generation: 1, body_digest: later.bodyDigest, received_at: NOW + 11_000 },
  ]);
  expect(rows(path, "SELECT count(*) AS n FROM deliveries WHERE id = ?", late.reportId)).toEqual([{ n: 0 }]);
  expect(rows(path, "SELECT other_digest FROM receipt_conflicts WHERE id = ? ORDER BY other_digest", late.reportId)).toEqual(
    [digest("other body"), sameId.bodyDigest].sort().map((other_digest) => ({ other_digest })),
  );
});

test("버린 실행의 받은 기록의 거절(D-169): 버리지 않은 실행, 다른 실행기·세대, 모르는 실행, 판 9 전의 장부", () => {
  const ledger = ready(open(tempPath()));
  const c = checkingRun(ledger);
  expect(ledger.recordAbandonedReport(abandonedReport(c, NOW + 6_000), c.from)).toEqual({ ok: false, reason: "transition_denied" });
  const failedLedger = ready(open(tempPath()));
  const f = failedRun(failedLedger);
  expect(failedLedger.recordAbandonedReport(abandonedReport(f, NOW + 6_000), f.from)).toEqual({ ok: false, reason: "transition_denied" });
  must(abandon(ledger, c));
  expect(ledger.recordAbandonedReport(abandonedReport(c, NOW + 6_000), { sender: "executor/diagnosis/1/store-b", runGeneration: 1 })).toEqual({ ok: false, reason: "sender_mismatch" });
  expect(ledger.recordAbandonedReport(abandonedReport(c, NOW + 6_000), { ...c.from, runGeneration: 2 })).toEqual({ ok: false, reason: "run_generation_mismatch" });
  expect(ledger.recordAbandonedReport({ ...abandonedReport(c, NOW + 6_000), runId: id() }, c.from)).toEqual({ ok: false, reason: "unknown_run" });
  expect(() => ledger.recordAbandonedReport({ ...abandonedReport(c, NOW + 6_000), bodyDigest: "not-a-digest" }, c.from)).toThrow(LedgerInputError);
  expect(() => ledger.recordAbandonedReport({ ...abandonedReport(c, NOW + 6_000), storedRef: "results/x" } as never, c.from)).toThrow(LedgerInputError);
  const eight = ready(open(tempPath(), { migrations: BEFORE() }));
  const old = checkingRun(eight);
  expect(eight.recordAbandonedReport(abandonedReport(old, NOW + 6_000), old.from)).toEqual({ ok: false, reason: "transition_denied" });
});

test("버린 실행의 받은 기록(D-169): 원 SQL도 포기 근거·낸 쪽·세대·ID 겹침·꼴을 지나야 하고(세 INSERT 방식 모두), 줄은 고치거나 지울 수 없다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const c = checkingRun(ledger);
  // 버리지 않은 같은 실행기의 실행(대기, 자리를 쥐지 않는다).
  const kept = must(ledger.admitRun(worker())).run;
  must(abandon(ledger, c));
  const stored = resultReport(c, NOW + 6_000, "stored");
  must(ledger.recordReport(stored, c.from));
  ledger.close();
  const raw = (mode: string) => `${mode} INTO abandoned_result_reports (report_id, run_id, sender, run_generation, body_digest, received_at) VALUES (?, ?, ?, ?, ?, ?)`;
  const good: (string | number | null)[] = [id(), c.runId, WORKER_EXECUTOR, 1, digest("late"), NOW + 7_000];
  const bad: [string, number, string | number | null][] = [
    ["버리지 않은 실행", 1, kept.runId],
    ["다른 실행기", 2, "executor/diagnosis/1/store-b"],
    ["다른 세대", 3, 2],
    ["deliveries에 있는 ID", 0, stored.reportId],
    ["대문자 digest", 4, digest("late").toUpperCase()],
    ["짧은 digest", 4, "abc"],
    ["TEXT 시각", 5, String(NOW + 7_000)],
    ["NULL 세대", 3, null],
  ];
  for (const mode of INSERT_MODES) {
    for (const [name, at, value] of bad) {
      const params = [...good];
      params[at] = value;
      expect(() => rawWrite(path, raw(mode), ...params), `${mode} ${name}`).toThrow("abandoned_report_unproven");
    }
  }
  expect(rows(path, "SELECT count(*) AS n FROM abandoned_result_reports")).toEqual([{ n: 0 }]);
  rawWrite(path, raw("INSERT"), ...good);
  expect(() => rawWrite(path, raw("INSERT OR REPLACE"), ...good.slice(0, 4), digest("other"), NOW + 8_000)).toThrow("abandoned_report_unproven");
  expect(() => rawWrite(path, "UPDATE abandoned_result_reports SET body_digest = ? WHERE report_id = ?", digest("other"), good[0] as string)).toThrow("abandoned_report_unproven");
  expect(() => rawWrite(path, "DELETE FROM abandoned_result_reports WHERE report_id = ?", good[0] as string)).toThrow("abandoned_report_unproven");
  expect(rows(path, "SELECT body_digest FROM abandoned_result_reports")).toEqual([{ body_digest: digest("late") }]);
});

// ---- 저장소 비움 닫기(D-158) ----

test("저장소 비움 닫기: checking·ready_result·failed_stopped(확정을 낸 뒤 포함) 작업자 실행은 store_reset 근거로 not_started가 되고 자리가 풀린다", () => {
  const cases: [LedgerRunState, (ledger: Ledger) => Checking][] = [
    ["checking", (ledger) => checkingRun(ledger)],
    ["ready_result", (ledger) => readyRun(ledger)],
    ["failed_stopped", (ledger) => failedRun(ledger)],
    [
      "failed_stopped",
      (ledger) => {
        const f = failedRun(ledger);
        finalize(ledger, f.runId, NOW + 2);
        return f;
      },
    ],
  ];
  for (const [from, make] of cases) {
    const ledger = ready(open(tempPath()));
    const s = make(ledger);
    expect(slotFree(ledger), from).toBe(false);
    const closed = must(storeReset(ledger, s.runId));
    expect(closed.run, from).toMatchObject({ state: "not_started", stopReceiptId: s.stopReceiptId });
    const closure = { runId: s.runId, fromState: from, checkedBy: "store_reset" as const, podName: POD, podStartedAt: LATER, stopGeneration: 0, closedAt: LATER };
    expect(closed.closure, from).toEqual(closure);
    expect(ledger.operatorClosure(s.runId), from).toEqual({ known: true, value: closure });
    expect(slotFree(ledger), from).toBe(true);
    const listed = ledger.listRuns();
    expect(listed.known && listed.value.find((r) => r.runId === s.runId), from).toMatchObject({ state: "not_started", closedByOperator: true });
  }
});

test("저장소 비움 닫기의 거절: 방법과 앞 상태의 짝, 시각 조건, 판 9 전의 장부. 거절이면 상태와 자리는 그대로다", () => {
  const fresh = () => ready(open(tempPath()));
  // 종료가 확인되지 않은 실행은 store_reset으로 닫지 않는다(파드 교체로 닫는다).
  const lostLedger = fresh();
  const lost = runningRun(lostLedger);
  must(lostLedger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  expect(storeReset(lostLedger, lost.runId)).toEqual({ ok: false, reason: "stop_unconfirmed" });
  const stoppingLedger = fresh();
  const stopping = runningRun(stoppingLedger);
  must(stoppingLedger.recordStopInstruction({ runId: stopping.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  expect(storeReset(stoppingLedger, stopping.runId)).toEqual({ ok: false, reason: "stop_unconfirmed" });
  const preparingLedger = fresh();
  const preparing = startedWorker(preparingLedger);
  expect(storeReset(preparingLedger, preparing.runId)).toEqual({ ok: false, reason: "stop_unconfirmed" });
  // 종료가 확인된 실행은 파드 교체로 닫지 않는다(판 7 그대로).
  const checkingLedger = fresh();
  const c = checkingRun(checkingLedger);
  expect(checkingLedger.closeRunByOperator({ runId: c.runId, checkedBy: "pod_replaced", podName: POD, podStartedAt: LATER, now: LATER })).toEqual({ ok: false, reason: "stop_confirmed" });
  // 시각 조건은 파드 교체와 같다.
  expect(storeReset(checkingLedger, c.runId, { podStartedAt: NOW + 30_000, now: NOW + 30_999 })).toEqual({ ok: false, reason: "start_may_launch" });
  expect(storeReset(checkingLedger, c.runId, { podStartedAt: NOW + 30_999, now: LATER })).toEqual({ ok: false, reason: "pod_started_too_early" });
  expect(state(checkingLedger, c.runId).state).toBe("checking");
  expect(checkingLedger.operatorClosure(c.runId)).toEqual({ known: true, value: null });
  expect(must(storeReset(checkingLedger, c.runId, { podStartedAt: NOW + 31_000, now: NOW + 31_000 })).run.state).toBe("not_started");
  // cleanup_pending은 D-158의 목록 밖이다.
  const cleanupLedger = fresh();
  const f = failedRun(cleanupLedger);
  must(cleanupLedger.markCleanupPending({ runId: f.runId, now: NOW + 2 }));
  expect(storeReset(cleanupLedger, f.runId)).toEqual({ ok: false, reason: "transition_denied" });
  // 끝난 실행.
  expect(storeReset(checkingLedger, c.runId)).toEqual({ ok: false, reason: "run_ended" });
  // 판 9 전의 장부.
  const eight = ready(open(tempPath(), { migrations: BEFORE() }));
  const old = checkingRun(eight);
  expect(storeReset(eight, old.runId)).toEqual({ ok: false, reason: "transition_denied" });
  expect(state(eight, old.runId).state).toBe("checking");
  expect(() => checkingLedger.closeRunByOperator({ runId: c.runId, checkedBy: "volume_deleted", podName: POD, podStartedAt: LATER, now: LATER } as never)).toThrow(LedgerInputError);
});

test("저장소 비움 닫기: 원 SQL도 방법과 앞 상태의 짝(종료 확인 유무 포함)을 지나야 근거가 들어간다", () => {
  const RAW = "INSERT INTO operator_closures (run_id, from_state, checked_by, pod_name, pod_started_at, stop_generation, closed_at) VALUES (?, ?, ?, ?, ?, 0, ?)";
  const lostPath = tempPath();
  const lostLedger = ready(open(lostPath));
  const lost = runningRun(lostLedger);
  must(lostLedger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  lostLedger.close();
  for (const mode of INSERT_MODES) {
    expect(() => rawWrite(lostPath, RAW.replace("INSERT", mode), lost.runId, "unknown_running", "store_reset", POD, LATER, LATER), mode).toThrow("operator_closure_unproven");
  }
  expect(rows(lostPath, "SELECT state FROM runs WHERE run_id = ?", lost.runId)).toEqual([{ state: "unknown_running" }]);
  rawWrite(lostPath, RAW, lost.runId, "unknown_running", "pod_replaced", POD, LATER, LATER);
  expect(rows(lostPath, "SELECT state FROM runs WHERE run_id = ?", lost.runId)).toEqual([{ state: "not_started" }]);

  // 원 SQL로 종료 영수증을 먼저 붙인 unknown_running: 종료 확인은 있어도 store_reset이 받는 앞 상태가 아니다.
  const confirmedPath = tempPath();
  const confirmedLedger = ready(open(confirmedPath));
  const confirmed = runningRun(confirmedLedger);
  must(confirmedLedger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  confirmedLedger.close();
  const receiptId = id();
  rawWrite(confirmedPath, "INSERT INTO deliveries (id, action, run_id, body_digest, received_at) VALUES (?, 'receipt_stopped', ?, ?, ?)", receiptId, confirmed.runId, digest("raw stopped"), NOW + 2);
  rawWrite(confirmedPath, "UPDATE runs SET stop_receipt_id = ? WHERE run_id = ?", receiptId, confirmed.runId);
  for (const mode of INSERT_MODES) {
    expect(() => rawWrite(confirmedPath, RAW.replace("INSERT", mode), confirmed.runId, "unknown_running", "store_reset", POD, LATER, LATER), mode).toThrow("operator_closure_unproven");
    expect(() => rawWrite(confirmedPath, RAW.replace("INSERT", mode), confirmed.runId, "unknown_running", "pod_replaced", POD, LATER, LATER), mode).toThrow("operator_closure_unproven");
  }
  expect(rows(confirmedPath, "SELECT state, stop_receipt_id FROM runs WHERE run_id = ?", confirmed.runId)).toEqual([{ state: "unknown_running", stop_receipt_id: receiptId }]);

  const path = tempPath();
  const ledger = ready(open(path));
  const c = checkingRun(ledger);
  ledger.close();
  for (const mode of INSERT_MODES) {
    expect(() => rawWrite(path, RAW.replace("INSERT", mode), c.runId, "checking", "pod_replaced", POD, LATER, LATER), mode).toThrow("operator_closure_unproven");
    expect(() => rawWrite(path, RAW.replace("INSERT", mode), c.runId, "ready_result", "store_reset", POD, LATER, LATER), mode).toThrow("operator_closure_unproven");
    expect(() => rawWrite(path, RAW.replace("INSERT", mode), c.runId, "checking", "store_reset", POD, NOW + 30_999, LATER), mode).toThrow("operator_closure_unproven");
    expect(() => rawWrite(path, RAW.replace("INSERT", mode), c.runId, "checking", "store_reset", "Bad_Pod", LATER, LATER), mode).toThrow("operator_closure_unproven");
  }
  expect(rows(path, "SELECT state FROM runs WHERE run_id = ?", c.runId)).toEqual([{ state: "checking" }]);
  rawWrite(path, RAW, c.runId, "checking", "store_reset", POD, LATER, LATER);
  expect(rows(path, "SELECT state, updated_at FROM runs WHERE run_id = ?", c.runId)).toEqual([{ state: "not_started", updated_at: LATER }]);
});

// D-162: 판 8 전에 실패 상태가 된 줄(실패 시각 칸이 빈 줄)은 저장소 비움으로 닫지 않는다(장부 초기화로 넘긴다). 판 8 전에 checking이었다가
// 판 8 뒤에 결과 없음으로 실패 상태가 된 줄은 그 판정이 실패 시각을 적어 닫는다.
// 판 7 장부에 작업자 실행 하나를 종료 확인까지 올리고(exit failed면 failed_stopped, completed면 checking) 판 9로 연다. checking은 판 9에서
// 결과 없음으로 판정해 실패 시각을 받는다.
function seventhLedger(exit: "failed" | "completed"): { path: string; run: Checking } {
  const path = tempPath();
  const seven = ready(open(path, { migrations: loadMigrations().slice(0, 7) }));
  const s = startedWorker(seven);
  const run = { ...s, stopReceiptId: stop(seven, s, exit, NOW + 1) };
  expect(state(seven, run.runId).state).toBe(exit === "failed" ? "failed_stopped" : "checking");
  seven.close();
  const nine = ready(open(path));
  if (exit === "completed") must(nine.markResult({ runId: run.runId, resultDigest: null, now: NOW + 5 }));
  expect(nine.failedStop(run.runId)).toEqual({
    known: true,
    value: exit === "failed" ? { runId: run.runId, stoppedAt: null, requestedCancel: false, exit: null } : { runId: run.runId, stoppedAt: NOW + 5, requestedCancel: false, exit: "completed" },
  });
  nine.close();
  return { path, run };
}

test("저장소 비움 닫기의 거절(D-162): 판 7에서 실패한 failed_stopped는 failed_at_unknown이고, 판 7 checking이 판 8 뒤 실패 시각을 받은 줄은 닫힌다", () => {
  const t = NOW + 31_000;
  const failed = seventhLedger("failed");
  const ledger = ready(open(failed.path));
  expect(storeReset(ledger, failed.run.runId, { podStartedAt: t, now: t })).toEqual({ ok: false, reason: "failed_at_unknown" });
  expect(state(ledger, failed.run.runId).state).toBe("failed_stopped");
  expect(ledger.operatorClosure(failed.run.runId)).toEqual({ known: true, value: null });
  expect(slotFree(ledger)).toBe(false);
  const judged = seventhLedger("completed");
  const other = ready(open(judged.path));
  expect(must(storeReset(other, judged.run.runId, { podStartedAt: t, now: t })).run.state).toBe("not_started");
  expect(slotFree(other)).toBe(true);
});

test("저장소 비움 닫기의 거절(D-162): 원 SQL도 실패 시각이 없는 failed_stopped는 세 INSERT 방식 모두 막고, 실패 시각이 있는 줄은 받는다", () => {
  const t = NOW + 31_000;
  const RAW = "INSERT INTO operator_closures (run_id, from_state, checked_by, pod_name, pod_started_at, stop_generation, closed_at) VALUES (?, 'failed_stopped', 'store_reset', ?, ?, 0, ?)";
  const failed = seventhLedger("failed");
  for (const mode of INSERT_MODES) {
    expect(() => rawWrite(failed.path, RAW.replace("INSERT", mode), failed.run.runId, POD, t, t), mode).toThrow("operator_closure_unproven");
  }
  expect(rows(failed.path, "SELECT state FROM runs WHERE run_id = ?", failed.run.runId)).toEqual([{ state: "failed_stopped" }]);
  const judged = seventhLedger("completed");
  rawWrite(judged.path, RAW, judged.run.runId, POD, t, t);
  expect(rows(judged.path, "SELECT state FROM runs WHERE run_id = ?", judged.run.runId)).toEqual([{ state: "not_started" }]);
});

test("닫힌 실행의 늦은 정리 영수증: 닫기 전에 낸 확정을 가리키면 받은 기록과 ack로 마치고 실행 줄은 그대로다(재전송은 duplicate)", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const f = failedRun(ledger);
  const requestId = finalize(ledger, f.runId, NOW + 2);
  must(storeReset(ledger, f.runId));
  const late = cleaned(f, requestId, LATER + 1);
  expect(ledger.applyReceipt(late, f.from)).toEqual({ ok: true, delivery: "new", ack: late.receiptId });
  expect(ledger.applyReceipt(late, f.from)).toEqual({ ok: true, delivery: "duplicate", ack: late.receiptId });
  expect(state(ledger, f.runId)).toMatchObject({ state: "not_started", cleanedReceiptId: null });
  expect(slotFree(ledger)).toBe(true);
  // 그 실행의 확정이 아닌 요청 ID는 지금처럼 거절한다.
  expect(ledger.applyReceipt(cleaned(f, id(), LATER + 2), f.from)).toEqual({ ok: false, reason: "unknown_instruction" });
  ledger.close();
  expect(rows(path, "SELECT action, instruction_request_id FROM deliveries WHERE id = ?", late.receiptId)).toEqual([{ action: "receipt_cleaned", instruction_request_id: requestId }]);
});

// ---- C-2의 장부 쪽(D-159) ----

test("관리자가 닫은 실행에는 outcome failed의 확정만 적고 그 정리 영수증은 ack로 마친다. D-90으로 닫은 실행·대기 취소 실행·다른 outcome은 받지 않는다", () => {
  for (const how of ["pod_replaced", "store_reset"] as const) {
    const ledger = ready(open(tempPath()));
    let s: Started;
    if (how === "pod_replaced") {
      s = runningRun(ledger);
      must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
      must(ledger.closeRunByOperator({ runId: s.runId, checkedBy: "pod_replaced", podName: POD, podStartedAt: LATER, now: LATER }));
    } else {
      s = checkingRun(ledger);
      must(storeReset(ledger, s.runId));
    }
    for (const outcome of ["succeeded", "cancelled"] as const) {
      const body = outcome === "succeeded" ? { outcome, resultDigest: digest("r"), storedAt: LATER } : { outcome, resultDigest: null, storedAt: LATER };
      expect(ledger.recordFinalizeInstruction({ runId: s.runId, requestId: id(), stopGeneration: 0, now: LATER + 1, ...body }), `${how} ${outcome}`).toEqual({ ok: false, reason: "transition_denied" });
    }
    expect(ledger.recordFinalizeInstruction({ runId: s.runId, requestId: id(), stopGeneration: 0, now: LATER + 1 }), how).toEqual({ ok: false, reason: "transition_denied" });
    expect(ledger.recordFinalizeInstruction({ runId: s.runId, requestId: id(), stopGeneration: 1, now: LATER + 1, outcome: "failed", resultDigest: null, storedAt: LATER }), how).toEqual({ ok: false, reason: "stop_generation_mismatch" });
    const requestId = finalize(ledger, s.runId, LATER + 1);
    const times = ledger.instructionTimes(s.runId);
    expect(times.known && times.value?.lastFinalizeAt, how).toBe(LATER + 1);
    const receipt = cleaned(s, requestId, LATER + 2);
    expect(ledger.applyReceipt(receipt, s.from), how).toEqual({ ok: true, delivery: "new", ack: receipt.receiptId });
    expect(state(ledger, s.runId), how).toMatchObject({ state: "not_started", cleanedReceiptId: null });
    expect(slotFree(ledger), how).toBe(true);
  }

  // D-90으로 닫은 실행(실행기가 받은 적 없음)과 대기에서 취소한 실행.
  const ledger = ready(open(tempPath()));
  const unreceived = startedWorker(ledger);
  must(ledger.markStartDispatch({ runId: unreceived.runId, requestId: unreceived.requestId, now: NOW }));
  must(ledger.closeUnreceivedRun({ runId: unreceived.runId, runs: [], answeredAt: NOW + 30_000, receivedAt: NOW + 30_005, now: NOW + 30_010 }, { sender: WORKER_EXECUTOR }));
  expect(state(ledger, unreceived.runId).state).toBe("not_started");
  const queued = must(ledger.admitRun(worker())).run.runId;
  must(ledger.recordStopInstruction({ runId: queued, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW }));
  for (const runId of [unreceived.runId, queued]) {
    expect(ledger.recordFinalizeInstruction({ runId, requestId: id(), stopGeneration: 0, now: LATER, outcome: "failed", resultDigest: null, storedAt: LATER })).toEqual({ ok: false, reason: "transition_denied" });
  }
});

// ---- 점유 관측 풀기(D-161) ----

test("점유 관측 풀기: 파드 교체 근거로 관측 하나의 자리 막기를 내리고 slotFree가 열리며, 줄은 남아 그 실행 ID는 계속 막힌다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const hold = holdOutside(ledger);
  expect(slotFree(ledger)).toBe(false);
  const done = must(release(ledger, hold));
  const expected = {
    observation: hold.observation,
    executorId: WORKER_EXECUTOR,
    runId: hold.runId,
    runGeneration: 1,
    checkedBy: "pod_replaced" as const,
    podName: POD,
    podStartedAt: NOW + 1_000,
    releasedAt: NOW + 2_000,
  };
  expect(done.release).toEqual(expected);
  expect(ledger.slotHoldRelease(hold.observation)).toEqual({ known: true, value: expected });
  expect(slotFree(ledger)).toBe(true);
  expect(ledger.slotHolds()).toEqual({ known: true, value: [] });
  // 풀린 관측의 실행 ID로 만든 실행은 시작하지 않는다.
  const blocked = must(ledger.admitRun(worker({ runId: hold.runId }))).run.runId;
  expect(ledger.startRun({ runId: blocked, requestId: id(), stopGeneration: 0, now: NOW + 3_000 })).toEqual({ ok: false, reason: "run_blocked" });
  ledger.close();
  expect(rows(path, "SELECT holds_slot, why FROM slot_holds WHERE observation = ?", hold.observation)).toEqual([{ holds_slot: 0, why: "outside_ledger" }]);
  // 관리자 닫기 뒤 늦은 시작 영수증이 다시 막은 자리(ended_in_ledger)도 같은 길로 푼다.
  const other = ready(open(tempPath()));
  const s = runningRun(other);
  must(other.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  must(other.closeRunByOperator({ runId: s.runId, checkedBy: "pod_replaced", podName: POD, podStartedAt: LATER, now: LATER }));
  must(other.applyReceipt({ action: "receipt_started", receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, bodyDigest: digest("late start"), now: LATER + 1 }, s.from));
  const [reheld] = (other.slotHolds() as { known: true; value: { runId: string; runGeneration: number; observation: number; executorId: string }[] }).value;
  expect(reheld).toMatchObject({ runId: s.runId, why: "ended_in_ledger" });
  expect(slotFree(other)).toBe(false);
  must(release(other, reheld as never, { podStartedAt: LATER + 2, now: LATER + 3 }));
  expect(slotFree(other)).toBe(true);
});

test("점유 관측 풀기의 거절: 조건마다 이름 하나이고 자리는 그대로다", () => {
  const ledger = ready(open(tempPath()));
  const hold = holdOutside(ledger);
  expect(release(ledger, { ...hold, runId: id() })).toEqual({ ok: false, reason: "unknown_run" });
  expect(release(ledger, { ...hold, observation: hold.observation + 1 })).toEqual({ ok: false, reason: "reference_mismatch" });
  expect(release(ledger, { ...hold, runGeneration: 2 })).toEqual({ ok: false, reason: "reference_mismatch" });
  // 관측을 적은 시각(NOW + 100) 전에 뜬 파드는 교체의 근거가 아니다.
  expect(release(ledger, hold, { podStartedAt: NOW + 99 })).toEqual({ ok: false, reason: "pod_started_too_early" });
  expect(slotFree(ledger)).toBe(false);
  // 같은 관측을 다시 적으면 새 번호를 받아 앞 번호의 풀기는 맞지 않는다.
  const again = holdOutside(ledger, hold.runId, 1, NOW + 200);
  expect(again.observation).not.toBe(hold.observation);
  expect(release(ledger, hold)).toEqual({ ok: false, reason: "reference_mismatch" });
  expect(release(ledger, again, { podStartedAt: NOW + 150 })).toEqual({ ok: false, reason: "pod_started_too_early" });
  must(release(ledger, again, { podStartedAt: NOW + 200 }));
  expect(release(ledger, again)).toEqual({ ok: false, reason: "slot_not_held" });
  // 근거 없이 푼 관측(clearSlotHold)도 이미 자리를 막지 않는다.
  const cleared = holdOutside(ledger, id(), 1, NOW + 300);
  must(ledger.clearSlotHold({ executorId: cleared.executorId, runId: cleared.runId, runGeneration: 1, observation: cleared.observation }));
  expect(release(ledger, cleared, { podStartedAt: NOW + 300, now: NOW + 400 })).toEqual({ ok: false, reason: "slot_not_held" });
  expect(ledger.slotHoldRelease(cleared.observation)).toEqual({ known: true, value: null });

  expect(() => release(ledger, hold, { checkedBy: "store_reset" })).toThrow(LedgerInputError);
  expect(() => release(ledger, hold, { podName: "Bad_Pod" })).toThrow(LedgerInputError);
  expect(() => release(ledger, hold, { podStartedAt: NOW + 3_000, now: NOW + 2_000 })).toThrow(LedgerInputError);

  const eight = ready(open(tempPath(), { migrations: BEFORE() }));
  const old = holdOutside(eight);
  expect(release(eight, old)).toEqual({ ok: false, reason: "transition_denied" });
  expect(eight.slotHoldRelease(old.observation)).toEqual({ known: true, value: null });
});

test("점유 관측 풀기: 원 SQL도 관측 대조와 파드 시각을 지나야 하고(세 INSERT 방식 모두), 근거 줄은 고치거나 지울 수 없다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const hold = holdOutside(ledger);
  ledger.close();
  const raw = (mode: string) =>
    `${mode} INTO slot_hold_releases (observation, executor_id, run_id, run_generation, checked_by, pod_name, pod_started_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  const good: (string | number | null)[] = [hold.observation, WORKER_EXECUTOR, hold.runId, 1, "pod_replaced", POD, NOW + 1_000, NOW + 2_000];
  const bad: [string, number, string | number | null][] = [
    ["관측 전에 뜬 파드", 6, NOW + 99],
    ["다른 세대", 3, 2],
    ["다른 실행", 2, id()],
    ["다른 실행기", 1, "executor/diagnosis/1/store-b"],
    ["목록 밖 방법", 4, "store_reset"],
    ["규칙 밖 파드 이름", 5, "Bad_Pod"],
    ["푼 시각 뒤에 뜬 파드", 7, NOW + 1_000 - 1],
    ["TEXT 관측 번호", 0, String(hold.observation)],
    ["NULL 파드 시각", 6, null],
  ];
  for (const mode of INSERT_MODES) {
    for (const [name, at, value] of bad) {
      const params = [...good];
      params[at] = value;
      expect(() => rawWrite(path, raw(mode), ...params), `${mode} ${name}`).toThrow("slot_hold_release_unproven");
    }
  }
  expect(rows(path, "SELECT holds_slot FROM slot_holds WHERE observation = ?", hold.observation)).toEqual([{ holds_slot: 1 }]);
  rawWrite(path, raw("INSERT"), ...good);
  expect(rows(path, "SELECT holds_slot FROM slot_holds WHERE observation = ?", hold.observation)).toEqual([{ holds_slot: 0 }]);
  expect(() => rawWrite(path, raw("INSERT OR REPLACE"), ...good)).toThrow("slot_hold_release_unproven");
  expect(() => rawWrite(path, "UPDATE slot_hold_releases SET pod_name = 'other-pod' WHERE observation = ?", hold.observation)).toThrow("slot_hold_release_unproven");
  expect(() => rawWrite(path, "DELETE FROM slot_hold_releases WHERE observation = ?", hold.observation)).toThrow("slot_hold_release_unproven");
  expect(rows(path, "SELECT count(*) AS n FROM slot_hold_releases")).toEqual([{ n: 1 }]);
});
