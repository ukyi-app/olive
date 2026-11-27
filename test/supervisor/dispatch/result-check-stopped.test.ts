// 결과 없음 판정(D-147)과 결과 기다림 경보(D-151). 실제 임시 장부에 checking 실행을 두고, 실행기의 failed_stopped 답은 답 자리
// (StoppedAnswerBook)에 바로 적거나(판정 사례) 실제 답 줄(answers.ts)·실제 처리기(receipts.ts)·실제 조회 등록부로 넣는다(끝까지 잇는 사례).
// 끝까지 잇는 사례는 실제 수명 박자가 조회(result_wait)를 내고, 판정 뒤 같은 장부에 실패 확정을 적고 내보내는 것까지 본다.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type Envelope, type RunStatus, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import { type LifeTickResult, lifeTick } from "../../../src/supervisor/dispatch/life-loop.ts";
import type { SentQuery } from "../../../src/supervisor/dispatch/receipts.ts";
import {
  createResultWaitAlarm,
  createStoppedAnswerBook,
  type ResultCheckPorts,
  type ResultCheckTickResult,
  resultCheckTick,
  type StoppedAnswer,
  type StoppedAnswerBook,
} from "../../../src/supervisor/dispatch/result-check.ts";
import { type AnswerNote, createAnswerLines } from "../../../src/supervisor/runtime/answers.ts";
import { createQueryBook } from "../../../src/supervisor/runtime/query-book.ts";
import type { Delivered } from "../../../src/supervisor/transport/server.ts";
import { digest, from, id, must, NOW, open, ready, tempPath, worker } from "../../ledger/helpers.ts";

const keys = generateKeyPairSync("ed25519");
const EXECUTOR = "executor/diagnosis/0/store-a";
const OTHER = "executor/diagnosis/1/store-b";
const AT = NOW + 5_000;
const LIFE = { renewEveryMs: 10_000, answerTimeoutMs: 20_000 };

type Checking = { runId: string; stopReceiptId: string; runGeneration: number; from: { sender: string; runGeneration: number } };

// 작업자 실행을 시작·접수하고 completed 종료 영수증으로 checking까지 옮긴다. 그 종료 영수증 ID와 장부의 실행 세대를 돌려준다.
function checking(ledger: Ledger): Checking {
  const run = must(ledger.admitRun(worker())).run;
  const requestId = id();
  must(ledger.startRun({ runId: run.runId, requestId, stopGeneration: 0, now: NOW }));
  const sender = from(run);
  must(ledger.applyReceipt({ action: "receipt_accepted", instruction: "task_start", receiptId: id(), runId: run.runId, instructionRequestId: requestId, bodyDigest: digest(`accepted:${run.runId}`), now: NOW }, sender));
  const stopReceiptId = id();
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: stopReceiptId, runId: run.runId, exit: "completed", bodyDigest: digest(`stopped:${run.runId}`), now: NOW + 1 }, sender));
  const read = ledger.getRun(run.runId);
  if (!read.known || read.value === null) throw new Error("실행을 읽지 못함");
  return { runId: run.runId, stopReceiptId, runGeneration: read.value.runGeneration, from: sender };
}

function report(ledger: Ledger, run: Checking, body: string, at = NOW + 2) {
  const reportId = id();
  const resultDigest = digest(body);
  must(ledger.recordReport({ reportId, action: "report_result", runId: run.runId, bodyDigest: digest(`report:${reportId}`), storedRef: `results/${id()}`, resultDigest, signal: null, now: at }, run.from));
  return { reportId, resultDigest };
}

function stateOf(ledger: Ledger, runId: string): string {
  const read = ledger.getRun(runId);
  return read.known && read.value !== null ? read.value.state : "unknown";
}

function ranOf(result: ResultCheckTickResult): Extract<ResultCheckTickResult, { kind: "ran" }> {
  if (result.kind !== "ran") throw new Error(`박자가 돌지 않음: ${JSON.stringify(result)}`);
  return result;
}

// 실행기가 그 실행의 종료를 그대로 failed_stopped라고 말한 답.
const said = (run: Checking, over: Partial<StoppedAnswer> = {}): StoppedAnswer => ({ runId: run.runId, executorId: EXECUTOR, runGeneration: run.runGeneration, lastReceiptId: run.stopReceiptId, ...over });

function world() {
  const ledger = ready(open(tempPath()));
  const marks: unknown[] = [];
  const book = createStoppedAnswerBook();
  const gates = { intake: true, valid: true };
  let markResult: Ledger["markResult"] = (input) => ledger.markResult(input);
  let stopped: ResultCheckPorts["stopped"] = book;
  const ports: ResultCheckPorts = {
    ledger: {
      listRuns: () => ledger.listRuns(),
      pendingReports: () => ledger.pendingReports(),
      markResult: (input) => {
        marks.push(input);
        return markResult(input);
      },
    },
    intake: { intakeOpen: () => gates.intake && ledger.intakeOpen() },
    beatValid: () => gates.valid,
    get stopped() {
      return stopped;
    },
  };
  return {
    ledger,
    marks,
    book,
    gates,
    ports,
    setMark: (fn: Ledger["markResult"]) => {
      markResult = fn;
    },
    setStopped: (value: ResultCheckPorts["stopped"]) => {
      stopped = value;
    },
  };
}

describe("결과 없음 판정", () => {
  test("failed_stopped 답의 낸 쪽·세대·마지막 영수증 ID가 장부의 그 종료와 같으면 markResult(null) 한 번으로 failed_stopped에 옮기고, 다음 박자는 다시 부르지 않는다", () => {
    const w = world();
    const run = checking(w.ledger);
    w.book.note(said(run));
    expect(ranOf(resultCheckTick(w.ports, AT)).runs).toEqual([{ runId: run.runId, outcome: "judged_no_result", lastReceiptId: run.stopReceiptId }]);
    expect(w.marks).toEqual([{ runId: run.runId, resultDigest: null, now: AT }]);
    expect(stateOf(w.ledger, run.runId)).toBe("failed_stopped");
    expect(w.ledger.failedStop(run.runId)).toEqual({ known: true, value: { runId: run.runId, stoppedAt: AT, requestedCancel: false, exit: "completed" } });
    expect(resultCheckTick(w.ports, AT + 1)).toEqual({ kind: "ran", runs: [], halted: null, haltedAt: null });
    expect(w.marks).toHaveLength(1);
    // checking을 떠난 실행의 답은 버린다.
    expect(w.book.answers()).toEqual([]);
  });

  test("마지막 영수증 ID·낸 쪽·세대 가운데 하나라도 장부의 그 종료와 다르면 판정하지 않는다(장부 호출 0)", () => {
    const cases: [string, (run: Checking) => Partial<StoppedAnswer>][] = [
      ["영수증 ID", () => ({ lastReceiptId: id() })],
      ["낸 쪽", () => ({ executorId: OTHER })],
      ["세대", (run) => ({ runGeneration: run.runGeneration + 1 })],
    ];
    for (const [name, over] of cases) {
      const w = world();
      const run = checking(w.ledger);
      w.book.note(said(run, over(run)));
      for (const at of [AT, AT + 60_000, AT + 3_600_000]) expect(ranOf(resultCheckTick(w.ports, at)).runs, name).toEqual([{ runId: run.runId, outcome: "waiting" }]);
      expect([w.marks.length, stateOf(w.ledger, run.runId)], name).toEqual([0, "checking"]);
    }
  });

  test("답이 없으면(무응답) 기한 없이 기다린다. 다른 실행의 failed_stopped 답은 같은 종료 영수증 ID를 실어도 이 실행을 판정하지 않는다", () => {
    const w = world();
    const run = checking(w.ledger);
    expect(ranOf(resultCheckTick(w.ports, AT + 86_400_000)).runs).toEqual([{ runId: run.runId, outcome: "waiting" }]);
    w.book.note(said(run, { runId: id() }));
    expect(ranOf(resultCheckTick(w.ports, AT + 86_400_001)).runs).toEqual([{ runId: run.runId, outcome: "waiting" }]);
    expect([w.marks.length, stateOf(w.ledger, run.runId)]).toEqual([0, "checking"]);
  });

  test("반영 전 결과 보고가 있으면 보고로 판정하고(결과를 버리지 않는다), 서로 다른 digest면 결과 없음도 판정하지 않는다", () => {
    const one = world();
    const a = checking(one.ledger);
    const kept = report(one.ledger, a, "본문");
    one.book.note(said(a));
    expect(ranOf(resultCheckTick(one.ports, AT)).runs).toEqual([{ runId: a.runId, outcome: "judged", reportId: kept.reportId, resultDigest: kept.resultDigest, state: "ready_result" }]);
    expect(one.marks).toEqual([{ runId: a.runId, resultDigest: kept.resultDigest, reportId: kept.reportId, now: AT }]);

    const two = world();
    const b = checking(two.ledger);
    report(two.ledger, b, "본문 a");
    report(two.ledger, b, "본문 b", NOW + 3);
    two.book.note(said(b));
    expect(ranOf(resultCheckTick(two.ports, AT)).runs).toEqual([{ runId: b.runId, outcome: "digest_conflict", digests: 2, reports: 2 }]);
    expect([two.marks.length, stateOf(two.ledger, b.runId)]).toEqual([0, "checking"]);
  });

  test("접수 문이 닫혔거나 박자 유효 문이 닫혔으면 장부를 부르지 않는다", () => {
    const w = world();
    const run = checking(w.ledger);
    w.book.note(said(run));
    w.gates.intake = false;
    expect(resultCheckTick(w.ports, AT)).toEqual({ kind: "not_run", reason: "intake_closed" });
    w.gates.intake = true;
    w.gates.valid = false;
    expect(resultCheckTick(w.ports, AT)).toEqual({ kind: "ran", runs: [], halted: "beat_closed", haltedAt: run.runId });
    expect([w.marks.length, stateOf(w.ledger, run.runId), w.book.answers().length]).toEqual([0, "checking", 1]);
  });

  test("장부의 거절은 no_result_refused, 던짐·정의 밖의 답은 no_result_failed로 박자를 멈춘다", () => {
    const w = world();
    const run = checking(w.ledger);
    w.book.note(said(run));
    w.setMark(() => ({ ok: false, reason: "transition_denied" }));
    expect(ranOf(resultCheckTick(w.ports, AT)).runs).toEqual([{ runId: run.runId, outcome: "no_result_refused", reason: "transition_denied" }]);
    w.setMark(() => {
      throw new Error("disk");
    });
    expect(resultCheckTick(w.ports, AT)).toEqual({ kind: "ran", runs: [{ runId: run.runId, outcome: "no_result_failed", reason: "threw" }], halted: "threw", haltedAt: run.runId });
    w.setMark(() => ({ ok: true, run: { runId: run.runId, state: "ready_result", resultDigest: digest("x") } }) as never);
    expect(resultCheckTick(w.ports, AT)).toEqual({ kind: "ran", runs: [{ runId: run.runId, outcome: "no_result_failed", reason: "malformed_answer" }], halted: "threw", haltedAt: run.runId });
  });

  test("답 자리가 없거나 읽다 던지면 결과 없음 판정만 하지 않고 보고 판정은 그대로 한다", () => {
    for (const broken of [undefined, { answers: () => { throw new Error("x"); }, retain: () => {} }] as ResultCheckPorts["stopped"][]) {
      const w = world();
      const run = checking(w.ledger);
      w.book.note(said(run));
      w.setStopped(broken);
      expect(ranOf(resultCheckTick(w.ports, AT)).runs).toEqual([{ runId: run.runId, outcome: "waiting" }]);
      expect(w.marks).toEqual([]);
    }
  });
});

// 실행기 흉내의 상태 보고(처리기가 읽는 칸만 갖춘 검증된 봉투).
const statusForward = (connection: number, sender: string, inReplyTo: string, runs: RunStatus[]): Delivered => ({
  kind: "forward",
  connection,
  verified: { ok: true, action: "status_report", header: { sender, action: "status_report", run_generation: 0, body_digest: "d".repeat(64), issued_at: AT }, body: { in_reply_to: inReplyTo, runs } } as never,
});

// 실제 장부·실제 답 줄·실제 등록부·실제 결과 검사·실제 수명 박자. 연결 표와 내보내기 포트만 가짜다(실은 봉투를 모은다).
function chain() {
  const ledger = ready(open(tempPath()));
  const run = checking(ledger);
  const book = createStoppedAnswerBook();
  const queries = createQueryBook();
  const notes: AnswerNote[] = [];
  const sent: Envelope[] = [];
  const recognized = new Map<string, number>([[EXECUTOR, 1]]);
  const state = { pendingThrows: false };
  const registry = {
    ...queries,
    pending: () => {
      if (state.pendingThrows) {
        state.pendingThrows = false;
        throw new Error("등록부를 읽지 못함");
      }
      return queries.pending();
    },
  };
  const random = { bytes: (length: number) => getRandomValues(new Uint8Array(length)) };
  const lines = createAnswerLines({
    table: () => ({ get: () => undefined, candidates: () => [] }) as never,
    restorer: () => ({ stopGeneration: () => 0, intakeOpen: () => ledger.intakeOpen() }),
    ledger,
    results: { backend: {} as never, ledger },
    random,
    signer: { seal: (input) => sealEnvelope(input, keys.privateKey) },
    clock: { now: () => AT },
    wire: { answers: { current: (connection, executorId) => recognized.get(executorId) === connection }, writeAck: () => "sent" },
    queries: registry,
    cycle: { noteCandidate: () => {} },
    observationsSettled: () => true,
    observe: (note) => notes.push(note),
    stopped: book,
  });
  const marks: unknown[] = [];
  const check = (now: number) =>
    resultCheckTick(
      {
        ledger: {
          listRuns: () => ledger.listRuns(),
          pendingReports: () => ledger.pendingReports(),
          markResult: (input) => {
            marks.push(input);
            return ledger.markResult(input);
          },
        },
        intake: { intakeOpen: () => ledger.intakeOpen() },
        beatValid: () => true,
        stopped: book,
      },
      now,
    );
  let lastQueries: { runId: string; at: number }[] = [];
  const life = async (now: number): Promise<Extract<LifeTickResult, { kind: "ran" }>> => {
    const result = await lifeTick(
      {
        ledger,
        intake: { intakeOpen: () => ledger.intakeOpen(), stopGeneration: () => 0 },
        links: { mayIssue: () => ({ ok: true }) },
        clock: { now: () => now },
        random,
        signer: { seal: (draft) => sealEnvelope(draft, keys.privateKey) },
        sink: {
          send: async (envelope) => {
            sent.push(envelope);
            return "sent";
          },
        },
        beatValid: () => true,
      },
      LIFE,
      { lastQueries, unsentRenews: [] },
    );
    if (result.kind !== "ran") throw new Error(JSON.stringify(result));
    for (const item of result.runs) if (item.outcome === "query_sent") lastQueries = [...lastQueries.filter((q) => q.runId !== item.runId), { runId: item.runId, at: item.at }];
    // 내보내기 포트는 실은 조회를 그 연결과 함께 등록한다(sink.ts). 가짜 포트라 여기서 더한다.
    for (const pending of result.pendingQueries) queries.add({ ...pending, connection: 1 });
    return result;
  };
  const answer = (inReplyTo: string, runs: RunStatus[], connection = 1) => lines.deliver(statusForward(connection, EXECUTOR, inReplyTo, runs));
  const statuses = () => notes.flatMap((note) => (note.kind === "status" ? [note.outcome.outcome === "status_unmatched" ? `unmatched:${note.outcome.reason}` : note.outcome.outcome] : []));
  return { ledger, run, book, queries, sent, marks, check, life, answer, statuses, recognized, state };
}

const entry = (runId: string, state: RunStatus["state"], lastReceiptId: string | null, generation = 1): RunStatus => ({
  run_id: runId,
  state,
  run_generation: state === "not_known" ? null : generation,
  last_receipt_id: state === "not_known" ? null : lastReceiptId,
});

describe("답 줄에서 실패 확정까지", () => {
  test("수명 박자가 checking 실행에 result_wait 조회를 내고, 그 조회의 대조된 failed_stopped 답(종료 영수증 ID 그대로)으로 결과 검사가 판정하고, 수명 박자가 실패 확정을 적고 내보낸다", async () => {
    const c = chain();
    const asked = await c.life(AT);
    expect(asked.runs).toEqual([expect.objectContaining({ runId: c.run.runId, outcome: "query_sent", cause: "result_wait" })]);
    const query = c.sent.at(-1)!;
    expect([query.header.action, query.body]).toEqual(["status_query", { run_ids: [c.run.runId] }]);
    expect(ranOf(c.check(AT)).runs).toEqual([{ runId: c.run.runId, outcome: "waiting" }]);

    c.answer(query.header.request_id, [entry(c.run.runId, "failed_stopped", c.run.stopReceiptId, c.run.runGeneration)]);
    expect(c.statuses()).toEqual(["status_matched"]);
    expect(c.book.answers()).toEqual([{ runId: c.run.runId, executorId: EXECUTOR, runGeneration: c.run.runGeneration, lastReceiptId: c.run.stopReceiptId }]);
    expect(ranOf(c.check(AT + 1)).runs).toEqual([{ runId: c.run.runId, outcome: "judged_no_result", lastReceiptId: c.run.stopReceiptId }]);
    expect(c.marks).toEqual([{ runId: c.run.runId, resultDigest: null, now: AT + 1 }]);

    const finalized = await c.life(AT + 2);
    expect(finalized.runs).toEqual([expect.objectContaining({ runId: c.run.runId, outcome: "finalize_sent" })]);
    expect([c.sent.at(-1)!.header.action, c.sent.at(-1)!.body]).toEqual(["result_finalize", { run_id: c.run.runId, outcome: "failed", result_digest: null, stored_at: AT + 1 }]);
    const unanswered = c.ledger.unansweredInstructions();
    expect(unanswered.known ? unanswered.value.instructions.filter((item) => item.action === "result_finalize").map((item) => item.runId) : unanswered).toEqual([c.run.runId]);
  });

  test("ready_result·not_known·unknown_running·checking 답, 다른 종료 영수증 ID의 failed_stopped 답은 장부에 아무것도 적지 않는다", async () => {
    const c = chain();
    const states: [RunStatus["state"], string | null][] = [
      ["ready_result", c.run.stopReceiptId],
      ["not_known", null],
      ["unknown_running", c.run.stopReceiptId],
      ["checking", c.run.stopReceiptId],
      ["failed_stopped", id()],
    ];
    for (const [index, [state, receipt]] of states.entries()) {
      const asked = await c.life(AT + index * LIFE.answerTimeoutMs);
      expect(asked.runs.map((item) => item.outcome), state).toEqual(["query_sent"]);
      c.answer(c.sent.at(-1)!.header.request_id, [entry(c.run.runId, state, receipt, c.run.runGeneration)]);
      expect(ranOf(c.check(AT + index * LIFE.answerTimeoutMs + 1)).runs, state).toEqual([{ runId: c.run.runId, outcome: "waiting" }]);
    }
    expect(c.statuses()).toEqual(states.map(() => "status_matched"));
    expect([c.marks.length, stateOf(c.ledger, c.run.runId)]).toEqual([0, "checking"]);
    expect(c.sent.filter((envelope) => envelope.header.action !== "status_query")).toEqual([]);
  });

  test("다른 실행을 물은 조회의 답(F9), 끝난 조회의 늦은 답, 인정이 끝난 연결의 답, 받은 때 등록부를 읽지 못한 답(F14·F10)은 적지 않는다", async () => {
    const c = chain();
    // 다른 실행을 물은 조회: 그 답의 항목이 이 실행의 종료 영수증 ID를 실어도 이 실행의 답이 아니다.
    const other = id();
    const otherQuery: SentQuery = { requestId: id(), recipient: EXECUTOR, runIds: [other], connection: 1 };
    c.queries.add(otherQuery);
    c.answer(otherQuery.requestId, [entry(other, "failed_stopped", c.run.stopReceiptId, c.run.runGeneration)]);
    expect(ranOf(c.check(AT)).runs).toEqual([{ runId: c.run.runId, outcome: "waiting" }]);

    // 이 실행의 조회 하나에 먼저 온 답(ready_result)이 항목을 끝냈다. 같은 조회에 늦게 온 답은 대조되지 않는다.
    await c.life(AT);
    const late = c.sent.at(-1)!.header.request_id;
    c.answer(late, [entry(c.run.runId, "ready_result", c.run.stopReceiptId, c.run.runGeneration)]);
    c.answer(late, [entry(c.run.runId, "failed_stopped", c.run.stopReceiptId, c.run.runGeneration)]);

    // 인정이 끝난 연결에서 온 답.
    await c.life(AT + LIFE.answerTimeoutMs);
    const stale = c.sent.at(-1)!.header.request_id;
    c.recognized.set(EXECUTOR, 2);
    c.answer(stale, [entry(c.run.runId, "failed_stopped", c.run.stopReceiptId, c.run.runGeneration)]);
    c.recognized.set(EXECUTOR, 1);

    // 받은 때 등록부를 읽지 못한 답은 어느 조회와도 대조하지 않는다.
    await c.life(AT + 2 * LIFE.answerTimeoutMs);
    c.state.pendingThrows = true;
    c.answer(c.sent.at(-1)!.header.request_id, [entry(c.run.runId, "failed_stopped", c.run.stopReceiptId, c.run.runGeneration)]);

    expect(c.statuses()).toEqual(["status_matched", "status_matched", "unmatched:unknown_query", "status_not_current", "unmatched:unknown_query"]);
    expect(c.book.answers()).toEqual([]);
    expect(ranOf(c.check(AT + 3 * LIFE.answerTimeoutMs)).runs).toEqual([{ runId: c.run.runId, outcome: "waiting" }]);
    expect([c.marks.length, stateOf(c.ledger, c.run.runId)]).toEqual([0, "checking"]);
  });

  test("먼저 낸 조회의 늦은 답도 아직 대조되면 failed_stopped는 되돌아가지 않는 말이라 같은 종료를 가리킬 때 판정한다", async () => {
    const c = chain();
    await c.life(AT);
    const first = c.sent.at(-1)!.header.request_id;
    await c.life(AT + LIFE.answerTimeoutMs);
    const second = c.sent.at(-1)!.header.request_id;
    expect(first).not.toBe(second);
    c.answer(first, [entry(c.run.runId, "failed_stopped", c.run.stopReceiptId, c.run.runGeneration)]);
    expect(ranOf(c.check(AT + LIFE.answerTimeoutMs + 1)).runs).toEqual([{ runId: c.run.runId, outcome: "judged_no_result", lastReceiptId: c.run.stopReceiptId }]);
    expect(c.queries.pending().map((query) => query.requestId)).toEqual([second]);
  });
});

describe("결과 기다림 경보", () => {
  // 감시 목록은 박자 뒤에 장부에서 읽은 checking 실행 ID다(checkingRunIds). 결과 검사 박자의 결과가 아니다: 접수가 닫혀 그 박자가 돌지 않아도 센다.
  test("checking에 한도만큼 머문 실행마다 한 번만 낸다. 목록에서 빠지면 잊고, 목록을 읽지 못한 박자는 줄이지 않는다", () => {
    const alarm = createResultWaitAlarm(90_000);
    const a = id();
    const b = id();
    expect(alarm.observe(new Set([a]), AT)).toEqual([]);
    expect(alarm.observe(new Set([a, b]), AT + 89_999)).toEqual([]);
    expect(alarm.observe(new Set([a, b]), AT + 90_000)).toEqual([{ runId: a, waitedMs: 90_000 }]);
    const both = new Set([a, b]);
    expect(alarm.observe(both, AT + 90_001)).toEqual([]);
    expect(alarm.observe(both, AT + 179_999)).toEqual([{ runId: b, waitedMs: 90_000 }]);
    expect(alarm.observe(both, AT + 3_600_000)).toEqual([]);
    // 목록을 읽지 못한 박자(null)는 세지도 잊지도 않는다.
    expect(alarm.observe(null, AT + 3_600_001)).toEqual([]);
    expect(alarm.observe(new Set([a, b]), AT + 3_600_002)).toEqual([]);
    // 목록에서 빠진 실행(판정으로 떠남)은 셈에서 빠진다. 다시 보이면 처음부터 센다.
    expect(alarm.observe(new Set([b]), AT + 3_600_003)).toEqual([]);
    expect(alarm.observe(new Set([a, b]), AT + 3_600_004)).toEqual([]);
    expect(alarm.observe(new Set([a, b]), AT + 3_690_004)).toEqual([{ runId: a, waitedMs: 90_000 }]);
    expect(() => createResultWaitAlarm(0)).toThrow(RangeError);
  });

});

// 답 자리의 값은 동결한 사본이다: 적은 쪽이 객체를 고쳐도 판정의 근거가 바뀌지 않는다.
test("답 자리: 실행마다 마지막 답 하나를 사본으로 쥔다", () => {
  const book: StoppedAnswerBook = createStoppedAnswerBook();
  const runId = id();
  const first = { runId, executorId: EXECUTOR, runGeneration: 1, lastReceiptId: id() };
  const told = first.lastReceiptId;
  book.note(first);
  first.lastReceiptId = id();
  expect(book.answers()).toEqual([{ ...first, lastReceiptId: told }]);
  const second = { runId, executorId: EXECUTOR, runGeneration: 1, lastReceiptId: id() };
  book.note(second);
  expect(book.answers()).toEqual([second]);
  book.retain(new Set());
  expect(book.answers()).toEqual([]);
});
