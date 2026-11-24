// 운영 중 받은 실행기의 답에서 양성 관측만 적는 연산(recordAnswerSightings). 실제 장부 파일에 적고, 공개 읽기와 원 SQL로 본다.
// 상태·임대·영수증과 보고·자리가 그대로인지는 장부를 닫은 뒤 run_sightings 밖의 모든 표를 앞뒤로 떠서 대조한다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { limits, type RunState, type RunStatus } from "../../src/contract/v1/index.ts";
import { type AnswerSightingsInput, type Ledger, LedgerInputError } from "../../src/ledger/index.ts";
import { RESTORE_KEY } from "../../src/ledger/ledger.ts";
import { digest, id, must, NOW, open, ready, SESSION_EXECUTOR, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "./helpers.ts";

// ID·digest·시각은 이 시험이 고른 값이다. 운영값이 아니다.
const OTHER_WORKER_EXECUTOR = "executor/diagnosis/1/store-b";
const RENEWED_AT = NOW + limits.RENEW_INTERVAL_MS;
// 실행기 시계로 서명된 답의 시각과 장부 시계의 now를 다른 값으로 두어 두 칸이 섞이지 않는지 본다.
const ANSWERED_AT = NOW + 40_000;
const SEEN_AT = NOW + 41_234;
// D-90 닫기가 받는 답의 시각(시작 발행 + 30000ms 이후).
const SHUT = NOW + 30_000;
const SIGHTING_COLUMNS = "run_id, executor_id, run_generation, reported_state, last_receipt_id, answered_at, received_at, coverage";
const IO_ERROR = () => Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });

function status(runId: string, reported: RunState, generation = 1, lastReceiptId: string | null = null): RunStatus {
  return reported === "not_known"
    ? { run_id: runId, state: "not_known", run_generation: null, last_receipt_id: null }
    : { run_id: runId, state: reported, run_generation: generation, last_receipt_id: lastReceiptId };
}

function sightAnswer(ledger: Ledger, runs: RunStatus[], sender = WORKER_EXECUTOR, extra: Partial<AnswerSightingsInput> = {}) {
  return ledger.recordAnswerSightings({ coverage: "partial", runs, answeredAt: ANSWERED_AT, now: SEEN_AT, ...extra }, { sender });
}

function sighted(ledger: Ledger, runId: string) {
  const read = ledger.hasRunSighting(runId);
  if (!read.known) throw new Error(`읽지 못함: ${read.reason}`);
  return read.value;
}

function state(ledger: Ledger, runId: string) {
  const read = ledger.getRun(runId);
  if (!read.known || read.value === null) throw new Error("실행 없음");
  return read.value.state;
}

// 장부는 EXCLUSIVE 잠금이라 원 SQL은 장부 객체를 닫은 뒤에만 읽는다.
function rawRows(path: string, sql: string): unknown[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query(sql).all();
  } finally {
    raw.close();
  }
}

// run_sightings 밖의 모든 표의 줄. 표마다 줄을 JSON으로 바꿔 정렬해 줄의 차례에 기대지 않는다.
function everyTableBut(path: string, skip: string): Record<string, string[]> {
  const raw = new Database(path, { readonly: true });
  try {
    const tables = raw.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    const out: Record<string, string[]> = {};
    for (const { name } of tables) {
      if (name === skip) continue;
      out[name] = (raw.query(`SELECT * FROM "${name}"`).all() as unknown[]).map((row) => JSON.stringify(row)).sort();
    }
    return out;
  } finally {
    raw.close();
  }
}

// 작업자 하나를 NOW에 시작하고 시작 영수증으로 running에 둔 뒤 갱신 하나로 믿는 임대를 만든다(영수증이 deliveries에 한 줄 남는다).
function trustedRunning(ledger: Ledger) {
  const started = startedWorker(ledger);
  must(ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId: started.runId, instructionRequestId: started.requestId, bodyDigest: digest("started"), now: NOW }, started.from));
  must(ledger.recordRenewInstruction({ runId: started.runId, requestId: id(), stopGeneration: 0, now: RENEWED_AT }));
  return started;
}

test("관측만 적는다: 상태·임대·영수증과 보고·자리·그 밖의 모든 표가 그대로이고 run_sightings에 한 줄이 는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = trustedRunning(ledger);
  const waiting = must(ledger.admitRun(worker())).run.runId;
  const leaseBefore = ledger.instructionTimes(live.runId);
  ledger.close();
  const before = everyTableBut(path, "run_sightings");
  expect(rawRows(path, "SELECT COUNT(*) AS n FROM deliveries")).toEqual([{ n: 1 }]);

  const reopened = open(path);
  const lastReceipt = id();
  // applyExecutorAnswer라면 running을 unknown_running으로 옮기는 답(끝났다)이다. 대기 실행의 not_known도 함께 싣는다.
  expect(sightAnswer(reopened, [status(live.runId, "finalized", 1, lastReceipt), status(waiting, "not_known")])).toEqual({ ok: true });
  expect(state(reopened, live.runId)).toBe("running");
  expect(state(reopened, waiting)).toBe("queued");
  expect(reopened.instructionTimes(live.runId)).toEqual(leaseBefore);
  expect(reopened.slotFree("worker")).toEqual({ known: true, value: false });
  expect(reopened.slotHolds()).toEqual({ known: true, value: [] });
  expect(sighted(reopened, live.runId)).toBe(true);
  expect(sighted(reopened, waiting)).toBe(false);
  reopened.close();

  expect(everyTableBut(path, "run_sightings")).toEqual(before);
  expect(rawRows(path, `SELECT ${SIGHTING_COLUMNS} FROM run_sightings`)).toEqual([
    { run_id: live.runId, executor_id: WORKER_EXECUTOR, run_generation: 1, reported_state: "finalized", last_receipt_id: lastReceipt, answered_at: ANSWERED_AT, received_at: SEEN_AT, coverage: "partial" },
  ]);

  // 대조군: 같은 꼴의 장부에 같은 답을 applyExecutorAnswer로 넘기면 상태가 옮겨진다(위 답이 상태를 바꿀 수 있는 답이었다).
  const control = ready(open(tempPath()));
  const other = trustedRunning(control);
  const moved = must(control.applyExecutorAnswer({ coverage: "partial", runs: [status(other.runId, "finalized", 1, id())], answeredAt: ANSWERED_AT, now: SEEN_AT }, { sender: WORKER_EXECUTOR })).moved;
  expect(moved).toEqual([{ runId: other.runId, runGeneration: 1, before: "running", after: "unknown_running" }]);
});

test("첫 줄만: 같은 (실행, 실행기, 세대)의 두 번째 답은 성공하고 첫 줄을 덮지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  expect(sightAnswer(ledger, [status(live.runId, "preparing")])).toEqual({ ok: true });
  expect(sightAnswer(ledger, [status(live.runId, "running", 1, id())], WORKER_EXECUTOR, { coverage: "full", answeredAt: ANSWERED_AT + 5, now: SEEN_AT + 5 })).toEqual({ ok: true });
  // applyExecutorAnswer가 뒤에 받은 같은 열쇠의 답도 첫 줄을 덮지 않는다.
  must(ledger.applyExecutorAnswer({ coverage: "full", runs: [status(live.runId, "running")], answeredAt: ANSWERED_AT + 9, now: SEEN_AT + 9 }, { sender: WORKER_EXECUTOR }));
  ledger.close();
  expect(rawRows(path, `SELECT ${SIGHTING_COLUMNS} FROM run_sightings`)).toEqual([
    { run_id: live.runId, executor_id: WORKER_EXECUTOR, run_generation: 1, reported_state: "preparing", last_receipt_id: null, answered_at: ANSWERED_AT, received_at: SEEN_AT, coverage: "partial" },
  ]);
});

test("지정 실행기·같은 세대만: 다른 실행기·다른 세대·not_known·장부 밖 항목은 건너뛰고, 섞인 답에서도 맞는 항목만 적는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  const skipped: [string, RunStatus][] = [
    [OTHER_WORKER_EXECUTOR, status(live.runId, "running")],
    [SESSION_EXECUTOR, status(live.runId, "running")],
    [WORKER_EXECUTOR, status(live.runId, "running", 2)],
    [WORKER_EXECUTOR, status(live.runId, "not_known")],
    [WORKER_EXECUTOR, status(id(), "running", 3)],
  ];
  for (const [sender, run] of skipped) {
    expect(sightAnswer(ledger, [run], sender), `${sender} ${run.state} ${run.run_generation}`).toEqual({ ok: true });
    expect(sighted(ledger, live.runId), `${sender} ${run.state} ${run.run_generation}`).toBe(false);
  }
  // 장부 밖 실행은 실행 줄로 올리지 않는다.
  const ghost = id();
  expect(sightAnswer(ledger, [status(ghost, "running", 4)], WORKER_EXECUTOR, { coverage: "full" })).toEqual({ ok: true });
  expect(ledger.getRun(ghost)).toEqual({ known: true, value: null });
  expect(ledger.hasRunSighting(ghost)).toEqual({ known: true, value: null });
  // 다른 세대·장부 밖 항목이 섞여도 답 전체가 거절되지 않는다.
  const mixed = [status(ghost, "running", 4), status(id(), "not_known"), status(live.runId, "running")];
  expect(sightAnswer(ledger, mixed, WORKER_EXECUTOR, { coverage: "full" })).toEqual({ ok: true });
  expect(sighted(ledger, live.runId)).toBe(true);
  ledger.close();
  expect(rawRows(path, "SELECT run_id, executor_id, run_generation, coverage FROM run_sightings")).toEqual([{ run_id: live.runId, executor_id: WORKER_EXECUTOR, run_generation: 1, coverage: "full" }]);
});

test("꼴이 틀린 입력은 LedgerInputError이고 장부는 그대로다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  const good = status(live.runId, "running");
  const base = { coverage: "partial", runs: [good], answeredAt: ANSWERED_AT, now: SEEN_AT };
  const bad: [string, unknown, unknown][] = [
    ["칸 더함", { ...base, extra: 1 }, { sender: WORKER_EXECUTOR }],
    ["칸 빠짐", { coverage: "partial", runs: [good], now: SEEN_AT }, { sender: WORKER_EXECUTOR }],
    ["범위 목록 밖", { ...base, coverage: "all" }, { sender: WORKER_EXECUTOR }],
    ["runs 배열 아님", { ...base, runs: good }, { sender: WORKER_EXECUTOR }],
    ["조회의 답이 비었다", { ...base, runs: [] }, { sender: WORKER_EXECUTOR }],
    ["항목 수 상한 넘음", { ...base, coverage: "full", runs: Array.from({ length: limits.STATUS_MAX_RUNS + 1 }, () => status(id(), "not_known")) }, { sender: WORKER_EXECUTOR }],
    ["같은 실행 ID 두 번", { ...base, runs: [good, good] }, { sender: WORKER_EXECUTOR }],
    ["실행 ID 꼴", { ...base, runs: [{ ...good, run_id: "not-a-uuid" }] }, { sender: WORKER_EXECUTOR }],
    ["상태 목록 밖", { ...base, runs: [{ ...good, state: "alive" }] }, { sender: WORKER_EXECUTOR }],
    ["세대 0", { ...base, runs: [{ ...good, run_generation: 0 }] }, { sender: WORKER_EXECUTOR }],
    ["세대 소수", { ...base, runs: [{ ...good, run_generation: 1.5 }] }, { sender: WORKER_EXECUTOR }],
    ["not_known에 세대", { ...base, runs: [{ ...status(live.runId, "not_known"), run_generation: 1 }] }, { sender: WORKER_EXECUTOR }],
    ["영수증 ID 꼴", { ...base, runs: [{ ...good, last_receipt_id: "r1" }] }, { sender: WORKER_EXECUTOR }],
    ["답의 시각 0", { ...base, answeredAt: 0 }, { sender: WORKER_EXECUTOR }],
    ["답의 시각 문자열", { ...base, answeredAt: String(ANSWERED_AT) }, { sender: WORKER_EXECUTOR }],
    ["now NaN", { ...base, now: Number.NaN }, { sender: WORKER_EXECUTOR }],
    ["now 빠짐", { ...base, now: undefined }, { sender: WORKER_EXECUTOR }],
    ["낸 쪽이 실행기 아님", base, { sender: "supervisor" }],
    ["낸 쪽 빈 이름", base, { sender: "" }],
    ["from 칸 더함", base, { sender: WORKER_EXECUTOR, connection: 1 }],
  ];
  for (const [why, input, from] of bad) {
    expect(() => ledger.recordAnswerSightings(input as AnswerSightingsInput, from as { sender: string }), why).toThrow(LedgerInputError);
  }
  expect(ledger.health()).toEqual({ writable: true });
  expect(sighted(ledger, live.runId)).toBe(false);
  // 대조군: 같은 base는 받는다. 답의 시각을 모르면(null) 그 칸을 비워 적는다.
  expect(ledger.recordAnswerSightings({ ...base, answeredAt: null } as AnswerSightingsInput, { sender: WORKER_EXECUTOR })).toEqual({ ok: true });
  ledger.close();
  expect(rawRows(path, "SELECT answered_at, received_at FROM run_sightings")).toEqual([{ answered_at: null, received_at: SEEN_AT }]);
});

test("쓰기 모드 continue: 적지 못하면 양성 항목을 실은 실패로 돌려주고, 장부가 실패한 뒤에도·접수가 닫혀도·정지 중에도 적는다", () => {
  let failCommit = false;
  const ledger = ready(
    open(tempPath(), {
      faults: {
        at(point) {
          if (failCommit && point === "answer_sighting:before_commit") throw IO_ERROR();
        },
      },
    }),
  );
  const live = startedWorker(ledger);
  const otherGen = id();
  const runs = [status(live.runId, "preparing"), status(id(), "not_known"), status(otherGen, "running", 7)];
  failCommit = true;
  // 장부와 대조하기 전의 not_known 밖 항목 전부다(applyExecutorAnswer의 unsavedSightings와 같은 규칙).
  expect(sightAnswer(ledger, runs)).toEqual({
    ok: false,
    reason: "ledger_unwritable",
    unsavedSightings: [
      { runId: live.runId, runGeneration: 1 },
      { runId: otherGen, runGeneration: 7 },
    ],
  });
  failCommit = false;
  expect(sighted(ledger, live.runId)).toBe(false);
  expect(ledger.health()).toEqual({ writable: false, reason: "io" });
  // 새 일은 막히지만 관측은 같은 답으로 다시 넘기면 남는다.
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "ledger_unwritable" });
  expect(sightAnswer(ledger, runs)).toEqual({ ok: true });
  expect(sighted(ledger, live.runId)).toBe(true);

  // 접수가 닫힌 장부(복원 중)와 정지 중인 장부에서도 적는다.
  const stopped = ready(open(tempPath()));
  const run1 = startedWorker(stopped);
  stopped.beginRestore(RESTORE_KEY);
  expect(sightAnswer(stopped, [status(run1.runId, "running")])).toEqual({ ok: true });
  expect(sighted(stopped, run1.runId)).toBe(true);
  const halted = ready(open(tempPath()));
  const run2 = startedWorker(halted);
  must(halted.applyStop({ generation: 0, stopped: true, now: NOW }));
  expect(sightAnswer(halted, [status(run2.runId, "running")])).toEqual({ ok: true });
  expect(sighted(halted, run2.runId)).toBe(true);

  // 닫힌 장부는 거절하고 양성 항목을 돌려준다.
  ledger.close();
  expect(sightAnswer(ledger, runs)).toEqual({
    ok: false,
    reason: "ledger_unwritable",
    unsavedSightings: [
      { runId: live.runId, runGeneration: 1 },
      { runId: otherGen, runGeneration: 7 },
    ],
  });
});

test("D-90 연결: 이 연산이 적은 관측 뒤에는 closeUnreceivedRun이 run_sighted로 거절하고 상태와 자리가 그대로다", () => {
  const ledger = ready(open(tempPath()));
  const live = startedWorker(ledger);
  must(ledger.markStartDispatch({ runId: live.runId, requestId: live.requestId, now: NOW }));
  expect(sightAnswer(ledger, [status(live.runId, "preparing")], WORKER_EXECUTOR, { answeredAt: NOW + 1, now: NOW + 1 })).toEqual({ ok: true });
  expect(ledger.closeUnreceivedRun({ runId: live.runId, runs: [], answeredAt: SHUT, receivedAt: SHUT + 5, now: SHUT + 10 }, { sender: WORKER_EXECUTOR })).toEqual({ ok: false, reason: "run_sighted" });
  expect(state(ledger, live.runId)).toBe("preparing");
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });

  // 대조군: 같은 준비에서 관측이 없으면(다른 실행기의 답만 받았으면) 닫힌다.
  const control = ready(open(tempPath()));
  const quiet = startedWorker(control);
  must(control.markStartDispatch({ runId: quiet.runId, requestId: quiet.requestId, now: NOW }));
  expect(sightAnswer(control, [status(quiet.runId, "preparing")], OTHER_WORKER_EXECUTOR, { answeredAt: NOW + 1, now: NOW + 1 })).toEqual({ ok: true });
  expect(must(control.closeUnreceivedRun({ runId: quiet.runId, runs: [], answeredAt: SHUT, receivedAt: SHUT + 5, now: SHUT + 10 }, { sender: WORKER_EXECUTOR })).run.state).toBe("not_started");
});

test("복원 열쇠의 recordRunSightings는 그대로다: 열쇠로만 열리고 answered_at을 비워 적는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const live = startedWorker(ledger);
  expect(() => ledger.recordRunSightings(Symbol("not-restore"), [])).toThrow(TypeError);
  expect(ledger.recordRunSightings(RESTORE_KEY, [{ executorId: WORKER_EXECUTOR, coverage: "full", status: status(live.runId, "running"), receivedAt: SEEN_AT }])).toEqual({ ok: true });
  // 같은 열쇠를 운영 중 연산으로 다시 적어도 복원이 적은 첫 줄이 남는다.
  expect(sightAnswer(ledger, [status(live.runId, "preparing")])).toEqual({ ok: true });
  ledger.close();
  expect(rawRows(path, "SELECT reported_state, answered_at, received_at, coverage FROM run_sightings")).toEqual([{ reported_state: "running", answered_at: null, received_at: SEEN_AT, coverage: "full" }]);
});
