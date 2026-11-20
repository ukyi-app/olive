// 운영 중 실행기의 답(applyExecutorAnswer)과 양성 관측(판 0005-run-sightings). 실제 장부 파일에 적고, 옮긴 뒤의 수명은 공개 읽기로
// 조립한 입력으로 실제 판단(nextIntent)을 불러 본다. 재시작 복원 2단계의 관측은 Restorer를 실제로 돌려 본다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { limits, RUN_STATES, type RunState, type RunStatus, runsOutsideLedger } from "../../src/contract/v1/index.ts";
import { type ExecutorAnswerInput, type Ledger, LedgerInputError, type LedgerRunState, loadMigrations, MIGRATIONS_DIR, openLedger, type RestorePorts, Restorer } from "../../src/ledger/index.ts";
import { type LifecyclePolicy, type LifecycleView, nextIntent } from "../../src/supervisor/scheduler/lifecycle.ts";
import { clock, digest, id, must, NOW, open, ready, SESSION_EXECUTOR, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "./helpers.ts";

// ID·digest·시각은 이 시험이 고른 값이다. 운영값이 아니다.
const MAX = limits.RUN_LEASE_MAX_MS;
const LIFE: LifecyclePolicy = { renewEveryMs: limits.RENEW_INTERVAL_MS, answerTimeoutMs: 30_000 };
const RENEWED_AT = NOW + LIFE.renewEveryMs;
const CHECK_AT = RENEWED_AT + LIFE.renewEveryMs;
// 실행기 시계로 서명된 답의 시각. 장부 시계(now)와 다른 값으로 두어 두 칸이 섞이지 않는지 본다.
const ANSWERED_AT = CHECK_AT - 1_234;
const OTHER_WORKER_EXECUTOR = "executor/diagnosis/1/store-b";
const SIGHTINGS_FILE = "0005-run-sightings.sql";
const SIGHTINGS_VERSION = loadMigrations().findIndex((m) => m.name === SIGHTINGS_FILE) + 1;
// 실행기가 갱신을 아직 적용하는 답(worker.ts의 onRenew). 이 밖의 답은 장부가 preparing·running이면 믿던 임대를 거둔다.
const RENEWABLE: readonly RunState[] = ["preparing", "running"];

function state(ledger: Ledger, runId: string) {
  const read = ledger.getRun(runId);
  if (!read.known || read.value === null) throw new Error("실행 없음");
  return read.value.state;
}

function times(ledger: Ledger, runId: string) {
  const read = ledger.instructionTimes(runId);
  if (!read.known || read.value === null) throw new Error("지시를 읽지 못함");
  return read.value;
}

function sighted(ledger: Ledger, runId: string) {
  const read = ledger.hasRunSighting(runId);
  if (!read.known) throw new Error(`읽지 못함: ${read.reason}`);
  return read.value;
}

// executor-loss.test.ts·lease-trust.test.ts의 조립과 같은 규칙이다. 장부가 임대 끝을 모르면 lease=null이다.
function lifecycle(ledger: Ledger, runId: string, now: number): LifecycleView {
  const got = ledger.getRun(runId);
  if (!got.known || got.value === null) throw new Error("실행을 읽지 못함");
  const run = got.value;
  const t = times(ledger, runId);
  const lease = t.lease;
  return {
    run: { runId, kind: run.kind, state: run.state, deadlineAt: run.deadlineAt },
    lease: lease !== null && lease.expiresAt !== "unknown" ? { issuedAt: lease.issuedAt, expiresAt: lease.expiresAt } : null,
    cancelRequested: false,
    lastInstructionAt: run.state === "stopping" ? t.lastStopAt : t.lastFinalizeAt,
    resultSettled: false,
    now,
  };
}

// 작업자 하나를 NOW에 시작하고 시작 영수증으로 running에 둔 뒤, 제때 낸 갱신 하나로 믿는 임대를 만든다.
function trustedRunning(ledger: Ledger, overrides: Parameters<typeof startedWorker>[1] = {}) {
  const started = startedWorker(ledger, overrides);
  const startedReceipt = id();
  must(ledger.applyReceipt({ action: "receipt_started", receiptId: startedReceipt, runId: started.runId, instructionRequestId: started.requestId, bodyDigest: digest("started"), now: NOW }, started.from));
  must(ledger.recordRenewInstruction({ runId: started.runId, requestId: id(), stopGeneration: 0, now: RENEWED_AT }));
  expect(times(ledger, started.runId).lease).toEqual({ issuedAt: RENEWED_AT, expiresAt: RENEWED_AT + MAX });
  return { ...started, startedReceipt };
}

function status(runId: string, reported: RunState, generation = 1, lastReceiptId: string | null = null): RunStatus {
  return reported === "not_known"
    ? { run_id: runId, state: "not_known", run_generation: null, last_receipt_id: null }
    : { run_id: runId, state: reported, run_generation: generation, last_receipt_id: lastReceiptId };
}

function answer(ledger: Ledger, runs: RunStatus[], sender = WORKER_EXECUTOR, extra: Partial<ExecutorAnswerInput> = {}) {
  return ledger.applyExecutorAnswer({ coverage: "partial", runs, answeredAt: ANSWERED_AT, now: CHECK_AT, ...extra }, { sender });
}

function rawRows(path: string, sql: string): unknown[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query(sql).all();
  } finally {
    raw.close();
  }
}

const SIGHTING_COLUMNS = "run_id, executor_id, run_generation, reported_state, last_receipt_id, answered_at, received_at, coverage";

// ---- 보장 1: 지정 실행기가 같은 세대로 답한 것만 본다 ----

test("보장 1: 다른 실행기·다른 세대의 답은 상태도 임대도 관측도 바꾸지 않는다", () => {
  const ledger = ready(open(tempPath()));
  const live = trustedRunning(ledger);
  const leaseBefore = times(ledger, live.runId);
  const ignored: [string, RunStatus][] = [
    [OTHER_WORKER_EXECUTOR, status(live.runId, "finalized", 1, id())],
    [OTHER_WORKER_EXECUTOR, status(live.runId, "not_known")],
    [OTHER_WORKER_EXECUTOR, status(live.runId, "running")],
    [SESSION_EXECUTOR, status(live.runId, "failed_stopped", 1, id())],
    [WORKER_EXECUTOR, status(live.runId, "finalized", 2, id())],
    [WORKER_EXECUTOR, status(live.runId, "running", 2)],
  ];
  for (const [sender, run] of ignored) {
    expect(answer(ledger, [run], sender), `${sender} ${run.state} ${run.run_generation}`).toEqual({ ok: true, moved: [], deferred: [], outsideLedger: [] });
    expect(state(ledger, live.runId)).toBe("running");
    expect(sighted(ledger, live.runId)).toBe(false);
  }
  expect(times(ledger, live.runId)).toEqual(leaseBefore);
  // 믿던 임대가 그대로라 판단은 여전히 갱신이다.
  expect(nextIntent(lifecycle(ledger, live.runId, CHECK_AT), LIFE).intent).toBe("renew_lease");
  // 대조군: 지정 실행기가 같은 세대로 답하면 관측이 남는다.
  expect(answer(ledger, [status(live.runId, "running")])).toEqual({ ok: true, moved: [], deferred: [], outsideLedger: [] });
  expect(sighted(ledger, live.runId)).toBe(true);
});

test("보장 1: 장부 밖 실행은 실행 줄로 올리지 않고 계약의 runsOutsideLedger와 같은 닫을 대상으로만 돌려준다", () => {
  const ledger = ready(open(tempPath()));
  const live = trustedRunning(ledger);
  const ghost = id();
  const ended = id();
  const runs = [status(ghost, "running", 9, id()), status(ended, "finalized", 3, id()), status(id(), "not_known"), status(live.runId, "running")];
  const before = (ledger.listRuns() as { value: unknown[] }).value.length;
  const result = must(answer(ledger, runs, OTHER_WORKER_EXECUTOR, { coverage: "full" }));
  const expected = runsOutsideLedger(runs, (runId) => ledger.runGeneration(runId)).map((run) => ({ runId: run.run_id, runGeneration: run.run_generation }));
  expect(result.outsideLedger).toEqual(expected);
  expect(result.outsideLedger).toEqual([
    { runId: ghost, runGeneration: 9 },
    { runId: ended, runGeneration: 3 },
  ]);
  expect(ledger.getRun(ghost)).toEqual({ known: true, value: null });
  expect(ledger.hasRunSighting(ghost)).toEqual({ known: true, value: null });
  expect((ledger.listRuns() as { value: unknown[] }).value).toHaveLength(before);
  // 장부 밖 항목은 지정 실행기의 답에서도 같은 목록이다.
  expect(must(answer(ledger, runs.slice(0, 3))).outsideLedger).toEqual(expected);
});

test("보장 1: 실행을 맡을 수 없는 낸 쪽과 계약 밖의 답은 장부를 바꾸지 않고 던진다", () => {
  const ledger = ready(open(tempPath()));
  const live = trustedRunning(ledger);
  const finished = status(live.runId, "finalized", 1, id());
  for (const sender of ["", "supervisor", "executor", "executor/wrong/0/store-a", WORKER_EXECUTOR.toUpperCase()]) {
    expect(() => answer(ledger, [finished], sender), sender).toThrow(LedgerInputError);
    // markLostFor와 같은 판정이다.
    if (sender !== "") expect(() => ledger.markLostFor({ executorId: sender, now: NOW }), sender).toThrow(LedgerInputError);
  }
  const good = { coverage: "partial", runs: [finished], answeredAt: ANSWERED_AT, now: CHECK_AT };
  const holed: unknown[] = [];
  holed[1] = finished;
  const bad: unknown[] = [
    { ...good, extra: 1 },
    { ...good, coverage: "some" },
    { ...good, runs: "x" },
    { ...good, runs: [] },
    { ...good, runs: holed },
    { ...good, runs: [finished, finished] },
    { ...good, runs: Array.from({ length: limits.STATUS_MAX_RUNS + 1 }, () => status(id(), "not_known")) },
    { ...good, runs: [{ ...finished, run_generation: null }] },
    { ...good, runs: [{ ...finished, run_generation: 0 }] },
    { ...good, runs: [{ ...finished, last_receipt_id: "x" }] },
    { ...good, runs: [{ ...finished, state: "queued" }] },
    { ...good, runs: [{ ...finished, extra: 1 }] },
    { ...good, runs: [{ run_id: live.runId, state: "not_known", run_generation: 1, last_receipt_id: null }] },
    { ...good, runs: [{ run_id: live.runId, state: "not_known", run_generation: null, last_receipt_id: id() }] },
    { ...good, answeredAt: 0 },
    { ...good, now: 1.5 },
  ];
  for (const input of bad) expect(() => ledger.applyExecutorAnswer(input as ExecutorAnswerInput, { sender: WORKER_EXECUTOR }), JSON.stringify(input)).toThrow(LedgerInputError);
  expect(() => ledger.applyExecutorAnswer(good as ExecutorAnswerInput, { sender: WORKER_EXECUTOR, extra: 1 } as { sender: string })).toThrow(LedgerInputError);
  expect(state(ledger, live.runId)).toBe("running");
  expect(sighted(ledger, live.runId)).toBe(false);
  // 전체 목록의 빈 답은 "쥔 것 없음"이라 받는다. 지금은 목록에 없는 실행을 닫지 않는다(뒤 조각의 몫).
  expect(answer(ledger, [], WORKER_EXECUTOR, { coverage: "full" })).toEqual({ ok: true, moved: [], deferred: [], outsideLedger: [] });
  expect(state(ledger, live.runId)).toBe("running");
});

// ---- 보장 2: "안다"는 답은 지울 수 없는 관측으로 남는다 ----

test("보장 2: 지정 실행기가 같은 세대로 안다고 한 첫 답을 남기고 다시 받아도 덮지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = trustedRunning(ledger);
  const silent = must(ledger.admitRun(worker())).run.runId;
  expect(sighted(ledger, live.runId)).toBe(false);
  expect(must(answer(ledger, [status(live.runId, "running", 1, live.startedReceipt), status(silent, "not_known")])).moved).toEqual([]);
  // 같은 열쇠의 다른 답(끝났다, 전체 목록, 다른 시각)은 상태를 옮기지만 첫 관측은 그대로다.
  const later = must(answer(ledger, [status(live.runId, "failed_stopped", 1, id())], WORKER_EXECUTOR, { coverage: "full", answeredAt: ANSWERED_AT + 5_000, now: CHECK_AT + 5_000 }));
  expect(later.moved).toEqual([{ runId: live.runId, runGeneration: 1, before: "running", after: "unknown_running" }]);
  expect(sighted(ledger, live.runId)).toBe(true);
  // not_known은 "안다"가 아니다. 없는 실행은 null이다.
  expect(sighted(ledger, silent)).toBe(false);
  expect(ledger.hasRunSighting(id())).toEqual({ known: true, value: null });
  ledger.close();
  expect(rawRows(path, `SELECT ${SIGHTING_COLUMNS} FROM run_sightings`)).toEqual([
    {
      run_id: live.runId,
      executor_id: WORKER_EXECUTOR,
      run_generation: 1,
      reported_state: "running",
      last_receipt_id: live.startedReceipt,
      answered_at: ANSWERED_AT,
      received_at: CHECK_AT,
      coverage: "partial",
    },
  ]);
  // 다시 연 장부에서도 같다.
  expect(open(path).hasRunSighting(live.runId)).toEqual({ known: true, value: true });
});

test("보장 2: 관측 줄은 지우거나 고치거나 바꿔 넣을 수 없고 지정 실행기·같은 세대·안다는 답만 들어간다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = trustedRunning(ledger);
  const other = must(ledger.admitRun(worker())).run.runId;
  must(answer(ledger, [status(live.runId, "running")]));
  ledger.close();
  const before = rawRows(path, `SELECT ${SIGHTING_COLUMNS} FROM run_sightings`);
  const raw = new Database(path);
  type Cell = string | number | null;
  const insert = (verb: string, values: Cell[]) => () => raw.query(`${verb} INTO run_sightings (${SIGHTING_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...values);
  const row = (overrides: Record<number, Cell> = {}) => {
    const values: Cell[] = [other, WORKER_EXECUTOR, 1, "running", null, ANSWERED_AT, CHECK_AT, "partial"];
    for (const [index, value] of Object.entries(overrides)) values[Number(index)] = value;
    return values;
  };
  try {
    expect(() => raw.run(`UPDATE run_sightings SET reported_state = 'finalized' WHERE run_id = '${live.runId}'`)).toThrow("run_sighting_fixed");
    expect(() => raw.run(`UPDATE run_sightings SET answered_at = NULL WHERE run_id = '${live.runId}'`)).toThrow("run_sighting_fixed");
    expect(() => raw.run(`DELETE FROM run_sightings WHERE run_id = '${live.runId}'`)).toThrow("run_sighting_fixed");
    // 같은 열쇠: REPLACE로 첫 줄을 밀어내지 못하고, 그냥 넣으면 거절된다.
    expect(insert("INSERT OR REPLACE", row({ 0: live.runId, 3: "finalized" }))).toThrow("run_sighting_fixed");
    expect(insert("INSERT", row({ 0: live.runId, 3: "finalized" }))).toThrow("run_sighting_fixed");
    // 지정 실행기가 아니거나 세대가 다르거나 장부 밖이면 들이지 않는다. NULL이 섞여도 맞는 실행이 없는 것으로 읽혀 거절된다.
    expect(insert("INSERT", row({ 1: OTHER_WORKER_EXECUTOR }))).toThrow("run_sighting_fixed");
    expect(insert("INSERT", row({ 2: 2 }))).toThrow("run_sighting_fixed");
    expect(insert("INSERT", row({ 0: id() }))).toThrow("run_sighting_fixed");
    expect(insert("INSERT", row({ 1: null }))).toThrow("run_sighting_fixed");
    // CHECK: not_known은 관측이 아니고, 목록 밖의 값·범위 밖의 시각은 받지 않는다. 함정인 NULL 답 시각은 범위를 통과한 것으로 읽히지 않는다.
    const checked: Record<number, Cell>[] = [{ 3: "not_known" }, { 3: "queued" }, { 7: "some" }, { 5: 0 }, { 6: 0 }];
    for (const overrides of checked) expect(insert("INSERT", row(overrides)), JSON.stringify(overrides)).toThrow("CHECK constraint failed");
    const required: Record<number, Cell>[] = [{ 6: null }, { 7: null }, { 3: null }];
    for (const overrides of required) expect(insert("INSERT", row(overrides)), JSON.stringify(overrides)).toThrow("NOT NULL constraint failed");
    // 복원 경로의 꼴(답의 시각 없음)은 받는다. 같은 열쇠의 다음 줄은 다시 거절이다.
    insert("INSERT", row({ 5: null }))();
    expect(insert("INSERT", row())).toThrow("run_sighting_fixed");
  } finally {
    raw.close();
  }
  expect(rawRows(path, `SELECT ${SIGHTING_COLUMNS} FROM run_sightings WHERE run_id = '${live.runId}'`)).toEqual(before);
  expect(rawRows(path, "SELECT count(*) AS n FROM run_sightings")).toEqual([{ n: 2 }]);
});

// 재시작 복원의 가짜 포트. restore.test.ts와 같은 기본값(기록 없음, 현관은 v2와 맞은 정책, 게시는 대기)이다.
function ports(occupancy: RestorePorts["occupancy"]["occupancy"]): RestorePorts {
  return {
    stopAuthority: { latestStop: async () => null },
    peers: { contracts: async () => [{ peer: "front-door", contract: "olive-control/v2", policy: "match" }] },
    occupancy: { occupancy },
    publications: { lookup: async () => ({ kind: "pending" as const }) },
  };
}

test("보장 2: 재시작 복원 2단계가 받은 답도 같은 표에 적고 복원의 판정과 답은 그대로다", async () => {
  const path = tempPath();
  const ledger = open(path);
  const live = startedWorker(ledger);
  const waiting = must(ledger.admitRun(worker())).run.runId;
  const ghost = id();
  const restorer = new Restorer(
    ledger,
    ports(async () => [
      {
        executorId: WORKER_EXECUTOR,
        coverage: "full",
        runs: [status(live.runId, "running"), status(waiting, "running"), status(ghost, "running", 9), status(id(), "not_known")],
      },
      { executorId: OTHER_WORKER_EXECUTOR, coverage: "partial", runs: [status(live.runId, "running")] },
    ]),
    clock,
    { requiredPeers: ["front-door"] },
  );
  await restorer.step1();
  const s2 = await restorer.step2();
  expect(s2.terminate).toEqual([{ executorId: WORKER_EXECUTOR, runId: ghost, runGeneration: 9, why: "outside_ledger" }]);
  expect(s2.occupancyMismatches).toEqual([
    { executorId: WORKER_EXECUTOR, runId: waiting, why: "state" },
    { executorId: OTHER_WORKER_EXECUTOR, runId: live.runId, why: "executor" },
  ]);
  expect(s2.holds.map((hold) => [hold.executorId, hold.runId, hold.why, hold.holdsSlot])).toEqual([
    [WORKER_EXECUTOR, waiting, "state", true],
    [WORKER_EXECUTOR, ghost, "outside_ledger", true],
    [OTHER_WORKER_EXECUTOR, live.runId, "executor", true],
  ]);
  expect(s2.recheck).toEqual([]);
  // 3단계는 지금처럼 답과 무관하게 진행 중 실행을 unknown_running으로 옮긴다.
  expect((await restorer.step3()).markedUnknown).toEqual([live.runId]);
  expect([sighted(ledger, live.runId), sighted(ledger, waiting)]).toEqual([true, true]);
  ledger.close();
  expect(rawRows(path, `SELECT ${SIGHTING_COLUMNS} FROM run_sightings ORDER BY run_id`)).toEqual(
    [live.runId, waiting].sort().map((runId) => ({
      run_id: runId,
      executor_id: WORKER_EXECUTOR,
      run_generation: 1,
      reported_state: "running",
      last_receipt_id: null,
      answered_at: null,
      received_at: NOW,
      coverage: "full",
    })),
  );
});

test("보장 2: 복원 2단계가 관측을 적지 못하면 그 단계는 실패하고, 다시 부르면 적는다", async () => {
  let fail = false;
  const ledger = open(tempPath(), {
    faults: {
      at(point) {
        if (fail && point === "run_sighting:before_commit") throw new Error("주입한 실패");
      },
    },
  });
  const live = startedWorker(ledger);
  const restorer = new Restorer(ledger, ports(async () => [{ executorId: WORKER_EXECUTOR, coverage: "full", runs: [status(live.runId, "running")] }]), clock, { requiredPeers: ["front-door"] });
  await restorer.step1();
  fail = true;
  await expect(restorer.step2()).rejects.toThrow("양성 관측을 적지 못함");
  fail = false;
  expect(sighted(ledger, live.runId)).toBe(false);
  await restorer.step2();
  expect(sighted(ledger, live.runId)).toBe(true);
});

// ---- 보장 3: 끝났다·모른다는 답은 믿던 임대를 거둔다. 자리는 어떤 답으로도 풀지 않는다 ----

// 장부 preparing은 시작 지시의 임대(NOW부터)를, running은 RENEWED_AT의 갱신을 믿는다. 각각 갱신을 낼 수 있는 시각에 판단한다.
const LEDGER_CASES = [
  { ledgerState: "preparing", at: NOW + LIFE.renewEveryMs, make: (ledger: Ledger) => startedWorker(ledger) },
  { ledgerState: "running", at: CHECK_AT, make: (ledger: Ledger) => trustedRunning(ledger) },
] as const;

test("보장 3: 장부가 preparing·running이면 갱신을 받는 답만 그대로 두고 그 밖의 답은 unknown_running으로 옮긴다(자리는 쥔 채, 갱신 없음)", () => {
  for (const { ledgerState, at, make } of LEDGER_CASES) {
    for (const reported of RUN_STATES) {
      const label = `장부 ${ledgerState} × 답 ${reported}`;
      const ledger = ready(open(tempPath()));
      const live = make(ledger);
      expect(state(ledger, live.runId), label).toBe(ledgerState);
      expect(nextIntent(lifecycle(ledger, live.runId, at), LIFE).intent, label).toBe("renew_lease");
      const timesBefore = times(ledger, live.runId);
      // ANSWERED_AT은 시작 발행 + MAX 전이라 not_known은 보류된다. 늦은 not_known의 이동은 "F1" 시험들이 본다.
      const defers = reported === "not_known";
      const moves = !RENEWABLE.includes(reported) && !defers;
      const result = must(ledger.applyExecutorAnswer({ coverage: "partial", runs: [status(live.runId, reported, 1, reported === "not_known" ? null : id())], answeredAt: ANSWERED_AT, now: at }, { sender: WORKER_EXECUTOR }));
      expect(result, label).toEqual({
        ok: true,
        moved: moves ? [{ runId: live.runId, runGeneration: 1, before: ledgerState, after: "unknown_running" }] : [],
        deferred: defers ? [{ runId: live.runId, runGeneration: 1, state: ledgerState, why: "start_may_arrive" }] : [],
        outsideLedger: [],
      });
      expect(state(ledger, live.runId), label).toBe(moves ? "unknown_running" : ledgerState);
      // 답은 지시를 만들지 않는다: 임대·발급 기록이 그대로다(돈다는 답도 임대를 늘리지 않는다).
      expect(times(ledger, live.runId), label).toEqual(timesBefore);
      // 자리는 어떤 답에도 쥔 채다.
      expect(ledger.slotFree("worker"), label).toEqual({ known: true, value: false });
      expect(ledger.startRun({ runId: must(ledger.admitRun(worker())).run.runId, requestId: id(), stopGeneration: 0, now: at }), label).toEqual({ ok: false, reason: "slot_busy" });
      if (moves) {
        // 거둔 뒤의 실제 수명 판단은 갱신 대신 같은 ID의 조회이고, 갱신 기록도 거절된다.
        expect(nextIntent(lifecycle(ledger, live.runId, at), LIFE), label).toEqual({ intent: "query", runId: live.runId, toward: "unknown_running" });
        expect(ledger.recordRenewInstruction({ runId: live.runId, requestId: id(), stopGeneration: 0, now: at }), label).toEqual({ ok: false, reason: "transition_denied" });
      } else {
        expect(nextIntent(lifecycle(ledger, live.runId, at), LIFE).intent, label).toBe("renew_lease");
      }
      expect(sighted(ledger, live.runId), label).toBe(reported !== "not_known");
      ledger.close();
    }
  }
});

test("보장 3: 장부가 stopping·unknown_running·대기·끝난 쪽이면 어떤 답에도 상태가 그대로다", () => {
  const ledger = ready(open(tempPath()));
  const answers = (runId: string) => RUN_STATES.map((reported) => status(runId, reported, 1, reported === "not_known" ? null : id()));
  const unchanged = (runId: string, expected: LedgerRunState) => {
    for (const run of answers(runId)) {
      expect(answer(ledger, [run]), `${expected} × ${run.state}`).toEqual({ ok: true, moved: [], deferred: [], outsideLedger: [] });
      expect(state(ledger, runId), `${expected} × ${run.state}`).toBe(expected);
    }
  };
  // unknown_running: 돈다는 답으로도 되살리지 않고 갱신 기록도 거절된다.
  const lost = trustedRunning(ledger);
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: CHECK_AT }));
  unchanged(lost.runId, "unknown_running");
  expect(ledger.recordRenewInstruction({ runId: lost.runId, requestId: id(), stopGeneration: 0, now: CHECK_AT })).toEqual({ ok: false, reason: "transition_denied" });
  // stopping: 이미 갱신하지 않는다.
  must(ledger.recordStopInstruction({ runId: lost.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: CHECK_AT, reason: "requested" }));
  unchanged(lost.runId, "stopping");
  // 끝난 쪽(종료 확인 영수증 뒤): 상태 보고는 결과 쪽 상태를 바꾸지 않는다.
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: lost.runId, exit: "failed", bodyDigest: digest("stopped"), now: CHECK_AT }, lost.from));
  unchanged(lost.runId, "failed_stopped");
  // 대기: 지시를 낸 적 없는 실행을 안다고 답해도 상태는 그대로다(관측은 남는다).
  const waiting = must(ledger.admitRun(worker())).run.runId;
  unchanged(waiting, "queued");
  expect(sighted(ledger, waiting)).toBe(true);
});

test("보장 3: 끝났다는 답은 실행을 끝난 상태로 옮기지 않고, 자리는 종료 영수증과 정리 영수증으로만 풀린다", () => {
  const ledger = ready(open(tempPath()));
  const live = trustedRunning(ledger);
  const lastReceipt = id();
  expect(must(answer(ledger, [status(live.runId, "finalized", 1, lastReceipt)])).moved).toEqual([{ runId: live.runId, runGeneration: 1, before: "running", after: "unknown_running" }]);
  const run = ledger.getRun(live.runId) as { value: { state: string; stopReceiptId: string | null; cleanedReceiptId: string | null } };
  expect([run.value.state, run.value.stopReceiptId, run.value.cleanedReceiptId]).toEqual(["unknown_running", null, null]);
  // 답이 말한 영수증 ID는 받은 영수증이 아니다: 장부의 받은 기록·보고·충돌에 아무것도 생기지 않는다.
  expect(ledger.conflicts()).toEqual({ known: true, value: [] });
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  // 실행기가 다시 보내는 종료 영수증이 와야 결과 쪽 상태가 되고, 정리 영수증 뒤에야 자리가 풀린다.
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: live.runId, exit: "failed", bodyDigest: digest("stopped"), now: CHECK_AT }, live.from));
  expect(state(ledger, live.runId)).toBe("failed_stopped");
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  const finalize = id();
  must(ledger.recordFinalizeInstruction({ runId: live.runId, requestId: finalize, stopGeneration: 0, now: CHECK_AT }));
  must(ledger.applyReceipt({ action: "receipt_cleaned", receiptId: id(), runId: live.runId, instructionRequestId: finalize, bodyDigest: digest("cleaned"), now: CHECK_AT }, live.from));
  expect(state(ledger, live.runId)).toBe("finalized");
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: true });
});

test("보장 3: 한 답에 여러 실행이 있으면 지정 실행기·같은 세대의 것만 옮기고 접수 순번 순서로 돌려준다", () => {
  const ledger = ready(open(tempPath()));
  const live = trustedRunning(ledger);
  const waiting = must(ledger.admitRun(worker())).run.runId;
  // 다른 실행기(세션)에 지정된 대기 실행. 작업자 실행기의 답은 이 실행을 보지 않는다.
  const sessionRun = must(ledger.admitRun({ ...worker(), kind: "session", role: null, snapshotDigest: null, executorId: SESSION_EXECUTOR })).run.runId;
  // live의 not_known은 시작 봉투의 시한(실행기 시계) 뒤에 만든 답이다.
  const result = must(answer(ledger, [status(waiting, "finalized", 1, id()), status(sessionRun, "running"), status(live.runId, "not_known")], WORKER_EXECUTOR, { answeredAt: NOW + MAX, now: NOW + MAX }));
  expect(result).toEqual({ ok: true, moved: [{ runId: live.runId, runGeneration: 1, before: "running", after: "unknown_running" }], deferred: [], outsideLedger: [] });
  expect([state(ledger, waiting), state(ledger, sessionRun)]).toEqual(["queued", "queued"]);
  expect([sighted(ledger, waiting), sighted(ledger, sessionRun), sighted(ledger, live.runId)]).toEqual([true, false, false]);
});

// ---- F1: 시작 봉투가 아직 닿을 수 있는 동안 만든 not_known은 임대를 거두지 않는다 ----

test("F1: preparing에 온 not_known은 실행기 시계로 시작 발행 + MAX 전이면 보류하고 정각부터 옮긴다(답의 시각을 모르면 보류)", () => {
  const cases: { answeredAt: number | null; why: "start_may_arrive" | "answer_time_unknown" | null }[] = [
    { answeredAt: NOW - 1, why: "start_may_arrive" },
    { answeredAt: NOW + 1, why: "start_may_arrive" },
    { answeredAt: NOW + MAX - 1, why: "start_may_arrive" },
    { answeredAt: null, why: "answer_time_unknown" },
    { answeredAt: NOW + MAX, why: null },
  ];
  const at = NOW + LIFE.renewEveryMs;
  for (const { answeredAt, why } of cases) {
    const label = `answeredAt ${answeredAt === null ? "null" : `발행 ${answeredAt - NOW}`}`;
    const ledger = ready(open(tempPath()));
    const live = startedWorker(ledger);
    const timesBefore = times(ledger, live.runId);
    // 장부 시계(now)는 모두 같다: 판정은 실행기 시계의 답 시각으로 한다.
    const result = must(answer(ledger, [status(live.runId, "not_known")], WORKER_EXECUTOR, { answeredAt, now: NOW + 1 }));
    if (why !== null) {
      expect(result, label).toEqual({ ok: true, moved: [], deferred: [{ runId: live.runId, runGeneration: 1, state: "preparing", why }], outsideLedger: [] });
      expect(state(ledger, live.runId), label).toBe("preparing");
      expect(nextIntent(lifecycle(ledger, live.runId, at), LIFE).intent, label).toBe("renew_lease");
    } else {
      expect(result, label).toEqual({ ok: true, moved: [{ runId: live.runId, runGeneration: 1, before: "preparing", after: "unknown_running" }], deferred: [], outsideLedger: [] });
      expect(nextIntent(lifecycle(ledger, live.runId, at), LIFE), label).toEqual({ intent: "query", runId: live.runId, toward: "unknown_running" });
      expect(ledger.recordRenewInstruction({ runId: live.runId, requestId: id(), stopGeneration: 0, now: at }), label).toEqual({ ok: false, reason: "transition_denied" });
    }
    expect(times(ledger, live.runId), label).toEqual(timesBefore);
    expect(ledger.slotFree("worker"), label).toEqual({ known: true, value: false });
    expect(sighted(ledger, live.runId), label).toBe(false);
    ledger.close();
  }
  // 끝났다는 답은 답의 시각을 몰라도 지금처럼 옮긴다(보류는 not_known에만).
  const ledger = ready(open(tempPath()));
  const live = startedWorker(ledger);
  expect(must(answer(ledger, [status(live.runId, "failed_stopped", 1, id())], WORKER_EXECUTOR, { answeredAt: null, now: NOW + 1 }))).toEqual({
    ok: true,
    moved: [{ runId: live.runId, runGeneration: 1, before: "preparing", after: "unknown_running" }],
    deferred: [],
    outsideLedger: [],
  });
});

test("F1: 보류한 뒤 도착한 시작 영수증으로 실행은 정상으로 이어지고 실제 수명 판단이 갱신을 낸다(늦은 답이 없는 대조군과 같다)", () => {
  const run = (earlyAnswer: boolean) => {
    const ledger = ready(open(tempPath()));
    const live = startedWorker(ledger);
    if (earlyAnswer) {
      // 시작을 받기 전에 조회를 먼저 받은 실행기의 답: 박자 시각(발행 − 1)에 서명됐다.
      const held = must(answer(ledger, [status(live.runId, "not_known")], WORKER_EXECUTOR, { answeredAt: NOW - 1, now: NOW + 1 }));
      expect(held.deferred).toEqual([{ runId: live.runId, runGeneration: 1, state: "preparing", why: "start_may_arrive" }]);
    }
    must(ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId: live.runId, instructionRequestId: live.requestId, bodyDigest: digest("started"), now: NOW + 2 }, live.from));
    const at = NOW + LIFE.renewEveryMs;
    const intent = nextIntent(lifecycle(ledger, live.runId, at), LIFE).intent;
    const renewed = ledger.recordRenewInstruction({ runId: live.runId, requestId: id(), stopGeneration: 0, now: at });
    const out = { state: state(ledger, live.runId), intent, renewed: renewed.ok, lease: times(ledger, live.runId).lease };
    ledger.close();
    return out;
  };
  const expected = { state: "running", intent: "renew_lease", renewed: true, lease: { issuedAt: NOW + LIFE.renewEveryMs, expiresAt: NOW + LIFE.renewEveryMs + MAX } } as const;
  expect(run(false)).toEqual(expected);
  expect(run(true)).toEqual(expected);
});

test("F1: 갱신이 적힌 실행도 시작 지시 줄의 발행 시각으로 잰다(갱신의 시각으로 재지 않는다)", () => {
  // trustedRunning: 시작 NOW, 갱신 RENEWED_AT. instructionTimes의 lease.issuedAt은 RENEWED_AT이다.
  for (const [answeredAt, moves] of [
    [NOW + MAX - 1, false],
    [NOW + MAX, true],
  ] as const) {
    const label = `발행 + ${answeredAt - NOW}`;
    const ledger = ready(open(tempPath()));
    const live = trustedRunning(ledger);
    expect(answeredAt < RENEWED_AT + MAX, label).toBe(true);
    const result = must(answer(ledger, [status(live.runId, "not_known")], WORKER_EXECUTOR, { answeredAt, now: answeredAt }));
    expect(result, label).toEqual({
      ok: true,
      moved: moves ? [{ runId: live.runId, runGeneration: 1, before: "running", after: "unknown_running" }] : [],
      deferred: moves ? [] : [{ runId: live.runId, runGeneration: 1, state: "running", why: "start_may_arrive" }],
      outsideLedger: [],
    });
    expect(state(ledger, live.runId), label).toBe(moves ? "unknown_running" : "running");
    ledger.close();
  }
});

// ---- F2: 저장에 실패한 "안다"는 관측을 같은 프로세스 안에서 잊지 않는다 ----

test("F2: 복원 2단계는 적지 못한 양성 관측을 붙들고, 다시 물은 답이 그 실행을 빼먹어도 앞의 관측을 적어야 통과한다", async () => {
  let fail = false;
  const path = tempPath();
  const ledger = open(path, {
    faults: {
      at(point) {
        if (fail && point === "run_sighting:before_commit") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      },
    },
  });
  const live = startedWorker(ledger);
  let reported: RunStatus[] = [status(live.runId, "preparing")];
  const restorer = new Restorer(ledger, ports(async () => [{ executorId: WORKER_EXECUTOR, coverage: "full", runs: reported }]), clock, { requiredPeers: ["front-door"] });
  await restorer.step1();
  fail = true;
  await expect(restorer.step2()).rejects.toThrow("양성 관측을 적지 못함");
  // 다시 물은 답은 빈 전체 목록이다. 앞의 관측을 적지 못하는 동안 단계는 통과하지 않는다.
  reported = [];
  await expect(restorer.step2()).rejects.toThrow("양성 관측을 적지 못함");
  expect(sighted(ledger, live.runId)).toBe(false);
  fail = false;
  await restorer.step2();
  expect(sighted(ledger, live.runId)).toBe(true);
  ledger.close();
  expect(rawRows(path, `SELECT ${SIGHTING_COLUMNS} FROM run_sightings`)).toEqual([
    { run_id: live.runId, executor_id: WORKER_EXECUTOR, run_generation: 1, reported_state: "preparing", last_receipt_id: null, answered_at: null, received_at: NOW, coverage: "full" },
  ]);
});

test("F2: 운영 중 관측을 적지 못한 답은 양성 항목을 실은 실패로 구별되고, 같은 답으로 다시 넘기면 남는다", () => {
  let failCommit = false;
  const ledger = open(tempPath(), {
    faults: {
      at(point) {
        if (failCommit && point === "executor_answer:before_commit") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      },
    },
  });
  const live = startedWorker(ledger);
  const first: RunStatus[] = [status(live.runId, "preparing"), status(id(), "not_known")];
  failCommit = true;
  expect(answer(ledger, first)).toEqual({ ok: false, reason: "ledger_unwritable", unsavedSightings: [{ runId: live.runId, runGeneration: 1 }] });
  // 양성 항목이 없는 답의 실패는 붙들 것이 없다.
  expect(answer(ledger, [status(live.runId, "not_known")], WORKER_EXECUTOR, { answeredAt: NOW + MAX })).toEqual({ ok: false, reason: "ledger_unwritable", unsavedSightings: [] });
  failCommit = false;
  expect([state(ledger, live.runId), sighted(ledger, live.runId)]).toEqual(["preparing", false]);
  expect(answer(ledger, first)).toEqual({ ok: true, moved: [], deferred: [], outsideLedger: [] });
  expect(sighted(ledger, live.runId)).toBe(true);
});

test("보장 3: 쓰기 모드는 markLostFor와 같다(못 씀이 된 뒤에도 시도하고, 커밋 전에 끊기면 아무것도 남지 않고, 닫힌 장부는 거절)", () => {
  let failRead = false;
  let failCommit = false;
  const ledger = open(tempPath(), {
    faults: {
      at(point) {
        if (failRead && point === "read") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
        if (failCommit && point === "executor_answer:before_commit") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      },
    },
  });
  const live = trustedRunning(ledger);
  failCommit = true;
  expect(answer(ledger, [status(live.runId, "finalized", 1, id())])).toEqual({ ok: false, reason: "ledger_unwritable", unsavedSightings: [{ runId: live.runId, runGeneration: 1 }] });
  failCommit = false;
  expect(state(ledger, live.runId)).toBe("running");
  expect(sighted(ledger, live.runId)).toBe(false);
  failRead = true;
  expect(ledger.getRun(live.runId)).toEqual({ known: false, reason: "io" });
  failRead = false;
  expect(ledger.health()).toEqual({ writable: false, reason: "io" });
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "ledger_unwritable" });
  expect(must(answer(ledger, [status(live.runId, "finalized", 1, id())])).moved).toEqual([{ runId: live.runId, runGeneration: 1, before: "running", after: "unknown_running" }]);
  expect(sighted(ledger, live.runId)).toBe(true);
  ledger.close();
  expect(answer(ledger, [status(live.runId, "finalized", 1, id())])).toEqual({ ok: false, reason: "ledger_unwritable", unsavedSightings: [{ runId: live.runId, runGeneration: 1 }] });
});

// ---- 보장 4: 기존 장부는 그대로 열리고 기존 동작은 그대로다 ----

const KEPT_TABLES = ["runs", "instructions", "deliveries", "slot_holds", "stop_state", "run_epoch"];

test("이관: 판 1~4의 장부가 판 5로 올라가고 기존 줄은 그대로이며 올라간 뒤 답을 받는다", () => {
  expect(SIGHTINGS_VERSION).toBe(5);
  for (let version = 1; version < SIGHTINGS_VERSION; version++) {
    const path = tempPath();
    const before = ready(open(path, { migrations: loadMigrations().slice(0, version) }));
    const live = startedWorker(before);
    must(before.applyReceipt({ action: "receipt_started", receiptId: id(), runId: live.runId, instructionRequestId: live.requestId, bodyDigest: digest("started"), now: NOW }, live.from));
    // 판 5 전의 장부에서는 이 쓰기가 틀린 값을 내지 않고 닫힌다(표가 없다). 상태는 그대로다.
    expect(answer(before, [status(live.runId, "finalized", 1, id())]), `판 ${version}`).toEqual({ ok: false, reason: "ledger_unwritable", unsavedSightings: [{ runId: live.runId, runGeneration: 1 }] });
    expect(state(before, live.runId)).toBe("running");
    before.close();
    // 그 판에 있던 칸만 비교한다(판 2·4가 더하는 칸은 그 이관의 시험이 본다).
    const columns = KEPT_TABLES.map((table) => (rawRows(path, `PRAGMA table_info(${table})`) as { name: string }[]).map((column) => column.name).join(", "));
    const kept = () => KEPT_TABLES.map((table, index) => rawRows(path, `SELECT ${columns[index]} FROM ${table}`));
    const rows = kept();

    const upgraded = openLedger(path, { clock, mode: "reopen" });
    expect(upgraded, `판 ${version}`).toMatchObject({ ok: true, migrated: { from: version, to: loadMigrations().length } });
    if (!upgraded.ok) continue;
    expect(upgraded.ledger.hasRunSighting(live.runId)).toEqual({ known: true, value: false });
    upgraded.ledger.close();
    expect(kept(), `판 ${version}`).toEqual(rows);
    expect(rawRows(path, "SELECT count(*) AS n FROM run_sightings")).toEqual([{ n: 0 }]);
    expect(rawRows(path, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);

    // 올라간 장부의 옛 실행도 같은 규칙으로 답을 받는다.
    const after = open(path);
    expect(must(answer(after, [status(live.runId, "finalized", 1, id())])).moved).toEqual([{ runId: live.runId, runGeneration: 1, before: "running", after: "unknown_running" }]);
    expect(sighted(after, live.runId)).toBe(true);
    after.close();
  }
});

test("이관: 판 5의 장부는 그 앞의 판 목록(옛 코드)으로 열지 않는다", () => {
  const path = tempPath();
  open(path).close();
  expect(openLedger(path, { clock, mode: "reopen", migrations: loadMigrations().slice(0, SIGHTINGS_VERSION - 1) })).toMatchObject({ ok: false, reason: "too_new" });
});

test("정적: 판 5의 관측 상태 목록은 계약 v1의 실행 상태에서 not_known을 뺀 것과 같다", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, SIGHTINGS_FILE), "utf8");
  const match = /reported_state IN \(([^)]*)\)/.exec(sql);
  if (match === null) throw new Error("상태 목록이 없다");
  const listed = [...(match[1] as string).matchAll(/'([^']+)'/g)].map((value) => value[1] as string).sort();
  expect(listed).toEqual(RUN_STATES.filter((s) => s !== "not_known").sort());
});
