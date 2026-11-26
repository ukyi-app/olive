// D-128: 닫힌 실행(D-90·관리자 닫기)을 지정 실행기가 같은 세대의 running으로 답하면 applyExecutorAnswer의 답에 경보만 싣는다.
// 실제 장부 파일에 적고, 공개 읽기와 원 SQL로 본다. 실행 ID·digest·시각·파드 이름은 이 시험이 고른 값이다. 운영값이 아니다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { RunStatus } from "../../src/contract/v1/index.ts";
import type { Ledger } from "../../src/ledger/index.ts";
import { digest, id, must, NOW, open, ready, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "./helpers.ts";

const OTHER_EXECUTOR = "executor/diagnosis/1/store-b";
// D-90 닫기의 빈 전체 답 시각(시작 발행 NOW + 30000, 정각)과 관리자 닫기 시각(닫을 수 있게 되는 NOW + 31000 뒤).
const SHUT = NOW + 30_000;
const LATER = NOW + 60_000;

function closeD90(ledger: Ledger, runId: string) {
  return must(ledger.closeUnreceivedRun({ runId, runs: [], answeredAt: SHUT, receivedAt: SHUT + 5, now: SHUT + 10 }, { sender: WORKER_EXECUTOR }));
}

// 접수·시작 영수증을 받은 뒤 끊겨 unknown_running이 된 실행을 관리자가 닫는다(D-91).
function closeOperator(ledger: Ledger) {
  const live = startedWorker(ledger);
  must(ledger.applyReceipt({ action: "receipt_accepted", receiptId: id(), runId: live.runId, instructionRequestId: live.requestId, instruction: "task_start", bodyDigest: digest("accepted"), now: NOW }, live.from));
  must(ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId: live.runId, instructionRequestId: live.requestId, bodyDigest: digest("started"), now: NOW }, live.from));
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  must(ledger.closeRunByOperator({ runId: live.runId, checkedBy: "pod_replaced", podName: "worker-alarm-7f9c-x2kq", podStartedAt: LATER, now: LATER }));
  return live;
}

const status = (runId: string, state: RunStatus["state"], generation: number | null = 1): RunStatus => ({
  run_id: runId,
  state,
  run_generation: state === "not_known" ? null : generation,
  last_receipt_id: null,
});

function answer(ledger: Ledger, runs: RunStatus[], coverage: "full" | "partial" = "partial", sender = WORKER_EXECUTOR) {
  return ledger.applyExecutorAnswer({ coverage, runs, answeredAt: LATER + 5, now: LATER + 10 }, { sender });
}

// 실행 줄·점유 관측·받은 기록을 원 SQL로 읽는다. 경보가 이 셋을 바꾸지 않는지 본다(양성 관측 표는 따로 본다).
function durable(path: string): unknown {
  const raw = new Database(path, { readonly: true });
  try {
    return {
      runs: raw.query("SELECT * FROM runs ORDER BY queue_seq").all(),
      holds: raw.query("SELECT * FROM slot_holds ORDER BY observation").all(),
      deliveries: raw.query("SELECT * FROM deliveries ORDER BY id").all(),
    };
  } finally {
    raw.close();
  }
}

function sightings(path: string): unknown[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query("SELECT run_id, executor_id, run_generation, reported_state, coverage FROM run_sightings ORDER BY run_id").all();
  } finally {
    raw.close();
  }
}

function slotFree(ledger: Ledger): boolean {
  const read = ledger.slotFree("worker");
  if (!read.known) throw new Error("읽지 못함");
  return read.value;
}

function stateOf(ledger: Ledger, runId: string): string {
  const read = ledger.getRun(runId);
  if (!read.known || read.value === null) throw new Error("실행 없음");
  return read.value.state;
}

for (const coverage of ["partial", "full"] as const) {
  test(`D-90으로 닫은 실행의 같은 세대 running 답(${coverage})은 경보를 싣고, 상태·점유·받은 기록은 그대로이며 다음 시작은 된다`, () => {
    const path = tempPath();
    const ledger = ready(open(path));
    const live = startedWorker(ledger);
    closeD90(ledger, live.runId);
    const next = must(ledger.admitRun(worker())).run.runId;
    ledger.close();
    const before = durable(path);
    const again = open(path);
    expect(answer(again, [status(live.runId, "running")], coverage)).toEqual({
      ok: true,
      moved: [],
      deferred: [],
      outsideLedger: [],
      alarms: [{ runId: live.runId, runGeneration: 1, alarm: "closed_run_running" }],
    });
    // 같은 답을 다시 받아도 경보는 다시 실린다(관측은 첫 줄만 남는다).
    expect(answer(again, [status(live.runId, "running")], coverage)).toMatchObject({ ok: true, alarms: [{ runId: live.runId, alarm: "closed_run_running" }] });
    expect(stateOf(again, live.runId)).toBe("not_started");
    expect(again.slotHolds()).toEqual({ known: true, value: [] });
    expect(slotFree(again)).toBe(true);
    again.close();
    expect(durable(path)).toEqual(before);
    expect(sightings(path)).toEqual([{ run_id: live.runId, executor_id: WORKER_EXECUTOR, run_generation: 1, reported_state: "running", coverage }]);
    const last = ready(open(path));
    expect(last.startRun({ runId: next, requestId: id(), stopGeneration: 0, now: LATER + 20 }).ok).toBe(true);
  });

  test(`관리자가 닫은 실행의 같은 세대 running 답(${coverage})도 경보를 싣고, 상태·점유·받은 기록은 그대로다`, () => {
    const path = tempPath();
    const ledger = ready(open(path));
    const live = closeOperator(ledger);
    ledger.close();
    const before = durable(path);
    const again = open(path);
    expect(answer(again, [status(live.runId, "running")], coverage)).toEqual({
      ok: true,
      moved: [],
      deferred: [],
      outsideLedger: [],
      alarms: [{ runId: live.runId, runGeneration: 1, alarm: "closed_run_running" }],
    });
    expect(stateOf(again, live.runId)).toBe("not_started");
    expect(slotFree(again)).toBe(true);
    again.close();
    expect(durable(path)).toEqual(before);
  });
}

test("경보 0: 열린 실행, 다른 세대, 다른 실행 ID, 다른 실행기, running 밖의 상태, 대기에서 취소된 not_started에는 경보 칸이 없다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const closed = startedWorker(ledger);
  closeD90(ledger, closed.runId);
  const live = startedWorker(ledger);
  const cancelled = must(ledger.admitRun(worker())).run;
  must(ledger.recordStopInstruction({ runId: cancelled.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  expect(stateOf(ledger, cancelled.runId)).toBe("not_started");
  const quiet = { ok: true as const, moved: [], deferred: [], outsideLedger: [] };
  // 열린 실행(preparing)의 running 답.
  expect(answer(ledger, [status(live.runId, "running")])).toEqual(quiet);
  // 닫힌 실행이어도 세대가 다르면 보지 않는다.
  expect(answer(ledger, [status(closed.runId, "running", 2)])).toEqual(quiet);
  // 다른 실행 ID(장부 밖)는 장부 밖 실행으로만 나온다.
  const ghost = id();
  expect(answer(ledger, [status(ghost, "running")], "full")).toEqual({ ...quiet, outsideLedger: [{ runId: ghost, runGeneration: 1 }] });
  // 지정 실행기가 아닌 실행기의 답.
  expect(answer(ledger, [status(closed.runId, "running")], "partial", OTHER_EXECUTOR)).toEqual(quiet);
  // running 밖의 상태(경보는 "아직 돈다"는 답만이다).
  for (const state of ["preparing", "stopping", "finalized", "not_known"] as const) expect(answer(ledger, [status(closed.runId, state)])).toEqual(quiet);
  // 닫기 근거가 없는 not_started(대기에서 취소됨).
  expect(answer(ledger, [status(cancelled.runId, "running")])).toEqual(quiet);
  expect(stateOf(ledger, closed.runId)).toBe("not_started");
});

test("한 답에 닫힌 실행 둘과 열린 실행이 섞이면 닫힌 실행만 접수 순번 순서로 싣는다", () => {
  const ledger = ready(open(tempPath()));
  // 작업자 자리는 하나라 닫은 뒤에 다음 실행을 시작한다(접수 순번은 first < second < live).
  const first = startedWorker(ledger);
  closeD90(ledger, first.runId);
  const second = startedWorker(ledger);
  closeD90(ledger, second.runId);
  const live = startedWorker(ledger);
  expect(answer(ledger, [status(second.runId, "running"), status(live.runId, "running"), status(first.runId, "running")], "full")).toEqual({
    ok: true,
    moved: [],
    deferred: [],
    outsideLedger: [],
    alarms: [
      { runId: first.runId, runGeneration: 1, alarm: "closed_run_running" },
      { runId: second.runId, runGeneration: 1, alarm: "closed_run_running" },
    ],
  });
});

test("쓰기가 실패한 답에는 경보가 없고(아무것도 적지 않음) 같은 답을 다시 넘기면 경보가 실린다", () => {
  const fault = { fail: false };
  const path = tempPath();
  const ledger = ready(
    open(path, {
      faults: {
        at(point) {
          if (fault.fail && point === "executor_answer:before_commit") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
        },
      },
    }),
  );
  const closed = startedWorker(ledger);
  closeD90(ledger, closed.runId);
  fault.fail = true;
  const failed = answer(ledger, [status(closed.runId, "running")]);
  expect(failed).toMatchObject({ ok: false, unsavedSightings: [{ runId: closed.runId, runGeneration: 1 }] });
  expect("alarms" in failed).toBe(false);
  ledger.close();
  expect(sightings(path)).toEqual([]);
  const again = open(path);
  expect(answer(again, [status(closed.runId, "running")])).toMatchObject({ ok: true, alarms: [{ runId: closed.runId, alarm: "closed_run_running" }] });
});
