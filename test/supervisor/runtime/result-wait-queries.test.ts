// 결과 기다림 조회(result_wait)의 등록부 정리(query-book.ts의 createResultWaitQueries, answers.ts의 releaseQueries)와 그 감시 목록
// (result-check.ts의 checkingRunIds). 답하지 않는 실행기에 낸 조회의 항목을 실행마다 몇 개로 줄이고 checking을 떠나면 모두 끝내되,
// 받은 답이 쥔 항목은 끝내지 않아 그 답이 그대로 대조되는지 본다. 실제 장부·실제 답 줄·실제 등록부이고 연결 표만 가짜다.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type RunStatus, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import { checkingRunIds } from "../../../src/supervisor/dispatch/result-check.ts";
import { type AnswerNote, createAnswerLines } from "../../../src/supervisor/runtime/answers.ts";
import { createQueryBook, createResultWaitQueries, RESULT_WAIT_QUERIES_KEPT } from "../../../src/supervisor/runtime/query-book.ts";
import type { Delivered } from "../../../src/supervisor/transport/server.ts";
import { digest, from, id, must, NOW, open, ready, tempPath, worker } from "../../ledger/helpers.ts";

const keys = generateKeyPairSync("ed25519");
const EXECUTOR = "executor/diagnosis/0/store-a";
const AT = NOW + 5_000;

// 작업자 실행을 시작·접수하고 completed 종료 영수증으로 checking까지 옮긴다.
function checking(ledger: Ledger) {
  const run = must(ledger.admitRun(worker())).run;
  const requestId = id();
  must(ledger.startRun({ runId: run.runId, requestId, stopGeneration: 0, now: NOW }));
  const sender = from(run);
  must(ledger.applyReceipt({ action: "receipt_accepted", instruction: "task_start", receiptId: id(), runId: run.runId, instructionRequestId: requestId, bodyDigest: digest(`accepted:${run.runId}`), now: NOW }, sender));
  const stopReceiptId = id();
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: stopReceiptId, runId: run.runId, exit: "completed", bodyDigest: digest(`stopped:${run.runId}`), now: NOW + 1 }, sender));
  const read = ledger.getRun(run.runId);
  if (!read.known || read.value === null) throw new Error("실행을 읽지 못함");
  return { runId: run.runId, stopReceiptId, runGeneration: read.value.runGeneration };
}

const statusForward = (connection: number, inReplyTo: string, runs: RunStatus[]): Delivered => ({
  kind: "forward",
  connection,
  verified: { ok: true, action: "status_report", header: { sender: EXECUTOR, action: "status_report", run_generation: 0, body_digest: "d".repeat(64), issued_at: AT }, body: { in_reply_to: inReplyTo, runs } } as never,
});

describe("결과 기다림 조회의 고르기", () => {
  test("실행마다 최근 세 개 밖의 요청 ID를 내고, checking을 떠난 실행은 모두 낸다. 목록을 모르면 수만 줄이고, 끝내지 못한 것은 다음에 다시 낸다", () => {
    const queries = createResultWaitQueries();
    const a = id();
    const b = id();
    const sent = (runId: string, count: number) => Array.from({ length: count }, () => ({ runId, requestId: id() }));
    const as = sent(a, 5);
    const bs = sent(b, 1);
    expect(queries.due(as.slice(0, 3), new Set([a]))).toEqual(new Set());
    expect(queries.due(as.slice(3), new Set([a, b]))).toEqual(new Set([as[0]!.requestId, as[1]!.requestId]));
    expect(queries.due(bs, null)).toEqual(new Set());
    queries.unreleased(new Set([as[0]!.requestId]));
    expect(queries.due([], new Set([a, b]))).toEqual(new Set([as[0]!.requestId]));
    expect(queries.due([], new Set([b]))).toEqual(new Set(as.slice(2).map((query) => query.requestId)));
    expect(queries.due([], new Set())).toEqual(new Set([bs[0]!.requestId]));
    expect(queries.due([], new Set())).toEqual(new Set());
    expect(RESULT_WAIT_QUERIES_KEPT).toBe(3);
    expect(() => createResultWaitQueries(0)).toThrow(RangeError);
  });

  test("checking 목록은 장부의 읽기 하나로 낸다. 한 줄이라도 읽지 못하면 모름(null)이다", () => {
    const ledger = ready(open(tempPath()));
    const run = checking(ledger);
    expect(checkingRunIds(ledger)).toEqual(new Set([run.runId]));
    expect(checkingRunIds({ listRuns: () => ({ known: false }) as never })).toBeNull();
    expect(checkingRunIds({ listRuns: () => ({ known: true, value: [{ runId: "x" }] }) as never })).toBeNull();
  });
});

describe("답 줄의 항목 끝내기(releaseQueries)", () => {
  test("받아 줄에 선 답이 쥔 항목은 남기고 나머지만 끝낸다. 남긴 항목은 그 답이 그대로 대조해 끝낸다", () => {
    const ledger = ready(open(tempPath()));
    const run = checking(ledger);
    const queries = createQueryBook();
    const notes: AnswerNote[] = [];
    const clock = { ok: true };
    const lines = createAnswerLines({
      table: () => ({ get: () => undefined, candidates: () => [] }) as never,
      restorer: () => ({ stopGeneration: () => 0, intakeOpen: () => ledger.intakeOpen() }),
      ledger,
      results: { backend: {} as never, ledger },
      random: { bytes: (length: number) => getRandomValues(new Uint8Array(length)) },
      signer: { seal: (input) => sealEnvelope(input, keys.privateKey) },
      // 시계를 읽지 못하면 답 줄은 받은 답을 넘기지 않고 쥔다(answers.ts의 readNow).
      clock: { now: () => (clock.ok ? AT : Number.NaN) },
      wire: { answers: { current: (connection, executorId) => connection === 1 && executorId === EXECUTOR }, writeAck: () => "sent" },
      queries,
      cycle: { noteCandidate: () => {} },
      observationsSettled: () => true,
      observe: (note) => notes.push(note),
    });
    const [first, second, third] = [id(), id(), id()];
    for (const requestId of [first, second, third]) queries.add({ requestId, recipient: EXECUTOR, runIds: [run.runId], connection: 1 });
    clock.ok = false;
    lines.deliver(statusForward(1, first, [{ run_id: run.runId, state: "checking", run_generation: run.runGeneration, last_receipt_id: run.stopReceiptId }]));
    expect(notes.filter((note) => note.kind === "status")).toEqual([]);
    const held = queries.pending()[0];
    expect(lines.releaseQueries(new Set([first, second]))).toEqual(new Set([first]));
    expect(queries.pending().map((query) => query.requestId)).toEqual([first, third]);
    expect(queries.pending()[0]).toBe(held);
    clock.ok = true;
    lines.pump();
    expect(notes.flatMap((note) => (note.kind === "status" ? [note.outcome.outcome] : []))).toEqual(["status_matched"]);
    expect(queries.pending().map((query) => query.requestId)).toEqual([third]);
    expect(lines.releaseQueries(new Set([third]))).toEqual(new Set());
    expect(queries.pending()).toEqual([]);
  });
});
