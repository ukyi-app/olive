// 운영 중 실행기 하나의 연결 상실(markLostFor). 실제 장부 파일에 적고, 옮긴 뒤의 수명은 공개 읽기로 조립한 입력으로 실제 판단(nextIntent)을 불러 본다.
// 작업자 슬롯은 하나뿐이고 세션 시작(startSession)은 닫혀 있어서, 다른 실행기의 진행 중 실행은 세션 줄을 장부 파일에서 직접 preparing으로 올려 만든다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { limits } from "../../src/contract/v1/index.ts";
import { type Ledger, LedgerInputError } from "../../src/ledger/index.ts";
import { type LifecyclePolicy, type LifecycleView, nextIntent, RENEW_MARGIN_MS } from "../../src/supervisor/scheduler/lifecycle.ts";
import { digest, from, id, must, NOW, open, ready, SESSION_EXECUTOR, session, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "./helpers.ts";

const MAX = limits.RUN_LEASE_MAX_MS;
const LIFE: LifecyclePolicy = { renewEveryMs: limits.RENEW_INTERVAL_MS, answerTimeoutMs: 30_000 };
// 믿은 임대(RENEWED_AT에 낸 갱신, 끝 RENEWED_AT + MAX)가 여유를 남기고 살아 있는 시각에 수명 판단이 돈다.
const RENEWED_AT = NOW + LIFE.renewEveryMs;
const CHECK_AT = RENEWED_AT + LIFE.renewEveryMs;
const OTHER_WORKER_EXECUTOR = "executor/diagnosis/1/store-b";

function stopped(runId: string, exit: "completed" | "failed", now = NOW) {
  return { action: "receipt_stopped" as const, receiptId: id(), runId, exit, bodyDigest: digest(`stopped:${runId}:${exit}`), now };
}

function state(ledger: Ledger, runId: string) {
  const read = ledger.getRun(runId);
  if (!read.known || read.value === null) throw new Error("실행 없음");
  return read.value.state;
}

function runs(ledger: Ledger) {
  const read = ledger.listRuns();
  if (!read.known) throw new Error("실행 목록을 읽지 못함");
  return read.value;
}

function times(ledger: Ledger, runId: string) {
  const read = ledger.instructionTimes(runId);
  if (!read.known || read.value === null) throw new Error("지시를 읽지 못함");
  return read.value;
}

// lease-trust.test.ts의 조립과 같은 규칙이다. 장부가 임대 끝을 모르면 lease=null이다.
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
  must(ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId: started.runId, instructionRequestId: started.requestId, bodyDigest: digest("started"), now: NOW }, started.from));
  must(ledger.recordRenewInstruction({ runId: started.runId, requestId: id(), stopGeneration: 0, now: RENEWED_AT }));
  expect(times(ledger, started.runId).lease).toEqual({ issuedAt: RENEWED_AT, expiresAt: RENEWED_AT + MAX });
  expect(CHECK_AT + RENEW_MARGIN_MS).toBeLessThanOrEqual(RENEWED_AT + MAX);
  return started;
}

// 작업자 실행 하나를 시작부터 정리 영수증까지 끝낸다(finalized, 자리를 놓는다).
function finishedWorker(ledger: Ledger, executorId: string) {
  const started = startedWorker(ledger, { executorId });
  must(ledger.applyReceipt(stopped(started.runId, "failed"), started.from));
  const finalize = id();
  must(ledger.recordFinalizeInstruction({ runId: started.runId, requestId: finalize, stopGeneration: 0, now: NOW }));
  must(
    ledger.applyReceipt({ action: "receipt_cleaned", receiptId: id(), runId: started.runId, instructionRequestId: finalize, bodyDigest: digest(`cleaned:${started.runId}`), now: NOW }, started.from),
  );
  expect(state(ledger, started.runId)).toBe("finalized");
  return started.runId;
}

// 실행기 A(작업자): 끝난 실행 하나, 진행 중(running) 하나, 대기(queued) 하나. 실행기 S(세션): 진행 중(preparing) 하나.
function mixed() {
  const path = tempPath();
  const first = open(path);
  const done = finishedWorker(first, WORKER_EXECUTOR);
  const live = trustedRunning(first);
  const waiting = must(first.admitRun(worker())).run.runId;
  const other = must(first.admitRun(session())).run.runId;
  first.close();
  const raw = new Database(path);
  raw.query("UPDATE runs SET state = 'preparing' WHERE run_id = ?").run(other);
  raw.close();
  const ledger = ready(open(path));
  expect([done, live.runId, waiting, other].map((runId) => state(ledger, runId))).toEqual(["finalized", "running", "queued", "preparing"]);
  return { ledger, path, done, live, waiting, other };
}

test("보장 1: 지정 실행기가 그 실행기이고 종료 확인이 없는 진행 중 실행만 옮긴다", () => {
  const { ledger, done, live, waiting, other } = mixed();
  const generation = ledger.runGeneration(live.runId) as number;
  expect(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: CHECK_AT })).toEqual({
    ok: true,
    runs: [{ runId: live.runId, runGeneration: generation, before: "running", after: "unknown_running" }],
  });
  // 끝난 실행, 보낸 적 없는 대기 실행, 다른 실행기의 진행 중 실행은 그대로다.
  expect([done, live.runId, waiting, other].map((runId) => state(ledger, runId))).toEqual(["finalized", "unknown_running", "queued", "preparing"]);

  // 다른 실행기의 끊김은 그 실행기의 실행만 옮긴다.
  expect(ledger.markLostFor({ executorId: SESSION_EXECUTOR, now: CHECK_AT })).toEqual({
    ok: true,
    runs: [{ runId: other, runGeneration: generation, before: "preparing", after: "unknown_running" }],
  });
  expect([done, live.runId, waiting, other].map((runId) => state(ledger, runId))).toEqual(["finalized", "unknown_running", "queued", "unknown_running"]);
});

test("보장 1: preparing·stopping도 옮기고, 종료 확인이 있는 checking은 그대로다", () => {
  const preparing = ready(open(tempPath()));
  const p = startedWorker(preparing);
  expect(preparing.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW })).toMatchObject({ ok: true, runs: [{ runId: p.runId, before: "preparing", after: "unknown_running" }] });

  const stopping = ready(open(tempPath()));
  const s = startedWorker(stopping);
  must(stopping.recordStopInstruction({ runId: s.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW }));
  expect(state(stopping, s.runId)).toBe("stopping");
  expect(stopping.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW })).toMatchObject({ ok: true, runs: [{ runId: s.runId, before: "stopping", after: "unknown_running" }] });

  const checking = ready(open(tempPath()));
  const c = startedWorker(checking);
  must(checking.applyReceipt(stopped(c.runId, "completed"), c.from));
  expect(state(checking, c.runId)).toBe("checking");
  const before = runs(checking);
  expect(checking.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW })).toEqual({ ok: true, runs: [] });
  expect(runs(checking)).toEqual(before);
});

test("보장 1: 없는 실행기, 진행 중 실행이 없는 실행기는 아무것도 바꾸지 않고 빈 목록이다", () => {
  const { ledger } = mixed();
  const before = runs(ledger);
  // 장부에 한 번도 나오지 않은 실행기.
  expect(ledger.markLostFor({ executorId: OTHER_WORKER_EXECUTOR, now: CHECK_AT })).toEqual({ ok: true, runs: [] });
  expect(runs(ledger)).toEqual(before);

  // 끝난 실행과 대기 실행만 있는 실행기.
  const idle = ready(open(tempPath()));
  finishedWorker(idle, OTHER_WORKER_EXECUTOR);
  must(idle.admitRun(worker({ executorId: OTHER_WORKER_EXECUTOR })));
  const idleBefore = runs(idle);
  expect(idle.markLostFor({ executorId: OTHER_WORKER_EXECUTOR, now: NOW })).toEqual({ ok: true, runs: [] });
  expect(runs(idle)).toEqual(idleBefore);
});

test("보장 1: 같은 종류의 다른 실행기(대기만 있는 작업자 B)의 끊김은 진행 중인 작업자 A의 실행·임대를 건드리지 않는다", () => {
  // 공개 연산만으로 만든다: A는 시작 영수증과 갱신까지 받은 running, B는 접수만 된 queued.
  const ledger = ready(open(tempPath()));
  const a = trustedRunning(ledger);
  const b = must(ledger.admitRun(worker({ executorId: OTHER_WORKER_EXECUTOR }))).run.runId;
  const before = runs(ledger);
  const aTimes = times(ledger, a.runId);
  expect(ledger.markLostFor({ executorId: OTHER_WORKER_EXECUTOR, now: CHECK_AT })).toEqual({ ok: true, runs: [] });
  expect(runs(ledger)).toEqual(before);
  expect([a.runId, b].map((runId) => state(ledger, runId))).toEqual(["running", "queued"]);
  expect(times(ledger, a.runId)).toEqual(aTimes);
  expect(times(ledger, a.runId).lease).toEqual({ issuedAt: RENEWED_AT, expiresAt: RENEWED_AT + MAX });
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
});

test("보장 1: 실행 세대로 좁히지 않는다(실행 세대가 오른 뒤의 옛 세대 진행 중 실행도 옮긴다)", () => {
  const path = tempPath();
  const first = open(path);
  const live = trustedRunning(first);
  first.close();
  // 실행 세대를 올리는 공개 연산은 아직 없어 장부 파일에서 직접 올린다(트리거가 허락하는 오름).
  const raw = new Database(path);
  raw.run("UPDATE run_epoch SET generation = 2 WHERE id = 1");
  raw.close();
  const ledger = ready(open(path));
  expect(ledger.runEpoch()).toEqual({ known: true, value: 2 });
  expect(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: CHECK_AT })).toEqual({
    ok: true,
    runs: [{ runId: live.runId, runGeneration: 1, before: "running", after: "unknown_running" }],
  });
});

test("보장 2: 같은 실행기로 다시 부르면 빈 목록이고 장부는 그대로다", () => {
  const { ledger, live } = mixed();
  expect(must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: CHECK_AT })).runs.map((r) => r.runId)).toEqual([live.runId]);
  const after = runs(ledger);
  const afterTimes = times(ledger, live.runId);
  expect(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: CHECK_AT + 1 })).toEqual({ ok: true, runs: [] });
  expect(runs(ledger)).toEqual(after);
  expect(times(ledger, live.runId)).toEqual(afterTimes);
});

test("보장 3: 옮긴 실행은 자리를 쥐고, 믿은 임대가 남아 있어도 판단은 조회이고, 갱신 기록은 거절된다", () => {
  const ledger = ready(open(tempPath()));
  const live = trustedRunning(ledger);
  // 대조군: 옮기기 전에는 같은 시각에 갱신이다.
  expect(nextIntent(lifecycle(ledger, live.runId, CHECK_AT), LIFE).intent).toBe("renew_lease");
  const issuedBefore = times(ledger, live.runId).renewIssued;

  expect(must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: CHECK_AT })).runs.map((r) => r.runId)).toEqual([live.runId]);
  // 자리: 같은 종류의 새 시작은 slot_busy.
  const next = must(ledger.admitRun(worker({ executorId: OTHER_WORKER_EXECUTOR, now: CHECK_AT }))).run;
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  expect(ledger.startRun({ runId: next.runId, requestId: id(), stopGeneration: 0, now: CHECK_AT })).toEqual({ ok: false, reason: "slot_busy" });
  // 판단: 믿은 임대는 장부에 그대로 남아 있지만(발급 기록은 지우지 않는다) 판단은 같은 ID 조회다.
  expect(times(ledger, live.runId).lease).toEqual({ issuedAt: RENEWED_AT, expiresAt: RENEWED_AT + MAX });
  expect(times(ledger, live.runId).renewIssued).toEqual(issuedBefore);
  expect(nextIntent(lifecycle(ledger, live.runId, CHECK_AT), LIFE)).toEqual({ intent: "query", runId: live.runId, toward: "unknown_running" });
  // 취소가 걸려 있으면 같은 시각에도 조회보다 종료가 먼저다.
  expect(nextIntent({ ...lifecycle(ledger, live.runId, CHECK_AT), cancelRequested: true }, LIFE)).toEqual({ intent: "stop", runId: live.runId, toward: "stopping" });
  // 갱신 기록: 지금 규칙 그대로 preparing·running 밖이라 transition_denied.
  expect(ledger.recordRenewInstruction({ runId: live.runId, requestId: id(), stopGeneration: 0, now: CHECK_AT })).toEqual({ ok: false, reason: "transition_denied" });
});

test("보장 3: 옮긴 실행의 종료 영수증이 나중에 오면 지금 규칙대로 반영되고, 자리는 종료 확인 뒤에도 정리까지 쥔다", () => {
  for (const [exit, after] of [
    ["failed", "failed_stopped"],
    ["completed", "checking"],
  ] as const) {
    const ledger = ready(open(tempPath()));
    const live = trustedRunning(ledger);
    must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: CHECK_AT }));
    // 연결이 돌아온 뒤 실행기가 "멈췄다"를 보냈다.
    expect(ledger.applyReceipt(stopped(live.runId, exit, CHECK_AT + 1), live.from)).toMatchObject({ ok: true });
    expect(state(ledger, live.runId)).toBe(after);
    expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
    // 종료가 확인된 실행은 다시 끊겨도 옮기지 않는다.
    expect(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: CHECK_AT + 2 })).toEqual({ ok: true, runs: [] });
    expect(state(ledger, live.runId)).toBe(after);
  }
});

test("보장 4: markLost는 지금처럼 실행기를 가리지 않고 진행 중 실행 전부를 옮기고 답의 꼴도 같다", () => {
  const { ledger, done, live, waiting, other } = mixed();
  const result = ledger.markLost(CHECK_AT);
  expect(result.ok).toBe(true);
  expect(Object.keys(result).sort()).toEqual(["ok", "runIds"]);
  expect([...(result as { runIds: string[] }).runIds].sort()).toEqual([live.runId, other].sort());
  expect([done, live.runId, waiting, other].map((runId) => state(ledger, runId))).toEqual(["finalized", "unknown_running", "queued", "unknown_running"]);
  // 이미 옮긴 실행은 markLostFor의 집합 밖이다.
  expect(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: CHECK_AT })).toEqual({ ok: true, runs: [] });
});

test("보장 4: 쓰기 모드는 markLost와 같다(장부가 못 씀이 된 뒤에도 시도하고, 닫힌 장부는 거절)", () => {
  let fail = false;
  const ledger = open(tempPath(), {
    faults: {
      at(point) {
        if (fail && point === "read") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      },
    },
  });
  const live = startedWorker(ledger);
  fail = true;
  expect(ledger.getRun(live.runId)).toEqual({ known: false, reason: "io" });
  fail = false;
  expect(ledger.health()).toEqual({ writable: false, reason: "io" });
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "ledger_unwritable" });
  expect(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW })).toMatchObject({ ok: true, runs: [{ runId: live.runId, after: "unknown_running" }] });
  ledger.close();
  expect(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW })).toEqual({ ok: false, reason: "ledger_unwritable" });
  expect(ledger.markLost(NOW)).toEqual({ ok: false, reason: "ledger_unwritable" });
});

test("입력: 정해진 두 칸만 받고 꼴이 틀리면 장부를 바꾸지 않고 던진다", () => {
  const ledger = ready(open(tempPath()));
  const live = startedWorker(ledger);
  const bad: unknown[] = [
    { executorId: WORKER_EXECUTOR },
    { executorId: WORKER_EXECUTOR, now: NOW, runGeneration: 1 },
    { executorId: "", now: NOW },
    { executorId: " executor", now: NOW },
    { executorId: WORKER_EXECUTOR, now: -1 },
    { executorId: WORKER_EXECUTOR, now: 1.5 },
  ];
  for (const input of bad) expect(() => ledger.markLostFor(input as { executorId: string; now: number }), JSON.stringify(input)).toThrow(LedgerInputError);
  expect(state(ledger, live.runId)).toBe("preparing");
  // 꼴은 참조 문자열이지만 실행을 맡을 수 없는 이름: admitRun이 지정 실행기로 받지 않는 값과 같다.
  for (const executorId of ["supervisor", "executor", "executor/wrong/0/store-a", WORKER_EXECUTOR.toUpperCase()]) {
    expect(() => ledger.admitRun(worker({ executorId })), executorId).toThrow(LedgerInputError);
    expect(() => ledger.markLostFor({ executorId, now: NOW }), executorId).toThrow(LedgerInputError);
  }
  expect(state(ledger, live.runId)).toBe("preparing");
  // 문법상 유효하지만 실행이 없는 이름은 거부가 아니라 빈 목록이다.
  expect(ledger.markLostFor({ executorId: OTHER_WORKER_EXECUTOR, now: NOW })).toEqual({ ok: true, runs: [] });
  expect(state(ledger, live.runId)).toBe("preparing");
  // from 도우미가 쓰는 낸 쪽 이름이 지정 실행기와 같은지(위 시험들이 같은 이름으로 부른다).
  expect(live.from).toEqual(from({ executorId: WORKER_EXECUTOR, runGeneration: 1 }));
});
