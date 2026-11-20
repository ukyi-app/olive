import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { executorName, limits, type RunStatus, sealEnvelope, type Verified, verifyEnvelope } from "../../../src/contract/v1/index.ts";
import type { ExecutorAnswerInput, Ledger } from "../../../src/ledger/index.ts";
import type { Random } from "../../../src/supervisor/dispatch/ports.ts";
import {
  type AnswerLinks,
  type ExecutorAnswerCopy,
  type ForwardInput,
  handleForward,
  type PendingQuery,
  type ReceiptLedger,
  type ReceiptOutcome,
  replayBacklog,
  type StatusUnmatchedReason,
} from "../../../src/supervisor/dispatch/receipts.ts";
import { id, NOW, open, startedWorker, tempPath, WORKER_EXECUTOR } from "../../ledger/helpers.ts";

// 조회의 답을 장부의 applyExecutorAnswer로 넘기는 길(receipts.md "운영 중 상태 보고의 장부 반영")의 시험.
// 실행기 이름·키·실행 줄은 이 시험이 지어 넣는 자료다.
const OTHER = executorName("diagnosis", "1", "store-b");
const keys = new Map<string, { privateKey: KeyObject; publicKey: KeyObject }>([WORKER_EXECUTOR, OTHER].map((name) => [name, generateKeyPairSync("ed25519")] as const));
const MAX = limits.RUN_LEASE_MAX_MS;
const random: Random = { bytes: (length) => new Uint8Array(length) };

let nonceSeq = 0;
const nonce = () => (++nonceSeq).toString(16).padStart(32, "0");

// 실행기의 키로 봉하고 감독의 맥락으로 검증한 status_report. issuedAt은 실행기 시계의 서명 시각이다.
async function report(sender: string, inReplyTo: string, runs: RunStatus[], issuedAt: number, generation: (runId: string) => number | undefined = () => undefined): Promise<Verified> {
  const envelope = sealEnvelope(
    { sender, recipient: "supervisor", action: "status_report", request_id: id(), stop_generation: 0, run_generation: 0, issued_at: issuedAt, nonce: nonce(), body: { in_reply_to: inReplyTo, runs } },
    keys.get(sender)!.privateKey,
  );
  const result = await verifyEnvelope(envelope, {
    now: issuedAt + 1,
    expectedRecipient: "supervisor",
    publicKeyFor: (name) => keys.get(name)?.publicKey,
    stopGeneration: 0,
    runGeneration: generation,
    nonces: { consume: () => true },
  });
  if (!result.ok) throw new Error(`검증 실패: ${result.reason}`);
  return result;
}

const status = (runId: string, state: RunStatus["state"], generation: number | null = 1): RunStatus => ({
  run_id: runId,
  state,
  run_generation: state === "not_known" ? null : generation,
  last_receipt_id: null,
});
const query = (runIds: string[], recipient = WORKER_EXECUTOR): PendingQuery => ({ requestId: id(), recipient, runIds });
const current: AnswerLinks = { current: () => true };

function input(v: Verified, pending: PendingQuery[], extra: Partial<ForwardInput> = {}): ForwardInput {
  // now는 답의 서명 시각과 일부러 다르게 둔다(answeredAt을 받은 시각으로 대신하면 드러난다).
  return { forward: { verified: v, connection: 7 }, now: NOW + 500_000, stopGeneration: 0, pendingQueries: pending, links: current, backlog: [], ...extra };
}

// applyExecutorAnswer만 받는 장부. 넘긴 값을 적고 정한 답을 돌려준다. 영수증·보고 연산은 부르면 실패한다.
function answerSpy(answers: unknown[] = []) {
  const calls: { input: ExecutorAnswerInput; from: { sender: string } }[] = [];
  const ledger: ReceiptLedger = {
    applyReceipt: () => {
      throw new Error("applyReceipt를 부르면 안 된다");
    },
    recordReport: () => {
      throw new Error("recordReport를 부르면 안 된다");
    },
    applyExecutorAnswer(input, from) {
      calls.push({ input: structuredClone(input), from: { ...from } });
      const next = answers.length > 0 ? answers.shift() : { ok: true, moved: [], deferred: [], outsideLedger: [] };
      if (next instanceof Error) throw next;
      return next as ReturnType<Ledger["applyExecutorAnswer"]>;
    },
  };
  return { ledger, calls };
}

function matched(outcome: ReceiptOutcome) {
  if (outcome.outcome !== "status_matched") throw new Error(`status_matched가 아니다: ${JSON.stringify(outcome)}`);
  return outcome;
}

// 실제 장부(임시 파일)에 작업자 실행 하나를 preparing까지 올린다. 시작 지시의 발행 시각은 NOW, 세대 1. commit을 실패시킬 수 있다.
function realLedger() {
  const fault = { failCommit: false };
  const ledger = open(tempPath(), {
    faults: {
      at(point) {
        if (fault.failCommit && point === "executor_answer:before_commit") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      },
    },
  });
  const started = startedWorker(ledger);
  const generation = (runId: string) => ledger.runGeneration(runId);
  const state = (runId: string) => {
    const run = ledger.getRun(runId);
    return run.known ? run.value?.state : "unreadable";
  };
  return { ledger, fault, generation, state, ...started };
}

describe("보장 1: 대조된 답만, 검증된 봉투의 값으로 넘긴다", () => {
  test("sender·runs·answeredAt은 검증된 봉투의 값이고 coverage는 partial이다(answeredAt은 issued_at, 받은 시각이 아니다)", async () => {
    const runId = id();
    const pending = query([runId]);
    const runs = [status(runId, "running")];
    const spy = answerSpy();
    const outcome = matched(handleForward(input(await report(WORKER_EXECUTOR, pending.requestId, runs, NOW + 40_000), [pending]), { ledger: spy.ledger, random }));
    expect(spy.calls).toEqual([{ input: { coverage: "partial", runs, answeredAt: NOW + 40_000, now: NOW + 500_000 }, from: { sender: WORKER_EXECUTOR } }]);
    expect(outcome.settled.map((s) => s.answer)).toEqual([{ sender: WORKER_EXECUTOR, coverage: "partial", runs, answeredAt: NOW + 40_000 }]);
    expect([outcome.queryRequestId, outcome.executor, outcome.connection]).toEqual([pending.requestId, WORKER_EXECUTOR, 7]);
  });

  test("issued_at의 꼴이 틀릴 때만 answeredAt이 null이다", async () => {
    const runId = id();
    const pending = query([runId]);
    const v = await report(WORKER_EXECUTOR, pending.requestId, [status(runId, "not_known")], NOW);
    const forged = { ...v, header: { ...v.header, issued_at: "어제" } } as unknown as Verified;
    const spy = answerSpy();
    handleForward(input(forged, [pending]), { ledger: spy.ledger, random });
    expect(spy.calls.map((c) => c.input.answeredAt)).toEqual([null]);
  });

  test("맞지 않은 답(모르는 조회, 다른 실행기, 다른 실행 집합)은 장부에 닿지 않는다", async () => {
    const runId = id();
    const pending = query([runId]);
    const runs = [status(runId, "finalized")];
    const spy = answerSpy();
    const cases: [Verified, StatusUnmatchedReason][] = [
      [await report(WORKER_EXECUTOR, id(), runs, NOW), "unknown_query"],
      [await report(OTHER, pending.requestId, runs, NOW), "other_executor"],
      [await report(WORKER_EXECUTOR, pending.requestId, [status(id(), "finalized")], NOW), "runs_mismatch"],
      [await report(WORKER_EXECUTOR, pending.requestId, [...runs, status(id(), "running")], NOW), "runs_mismatch"],
    ];
    for (const [v, reason] of cases) expect(handleForward(input(v, [pending]), { ledger: spy.ledger, random })).toEqual({ outcome: "status_unmatched", reason });
    expect(spy.calls).toEqual([]);
  });

  test("답이 온 연결이 지금 인정된 연결이 아니거나 그것을 모르면 장부에 넘기지 않는다(옛 연결의 답)", async () => {
    const runId = id();
    const pending = query([runId]);
    const runs = [status(runId, "finalized")];
    const v = await report(WORKER_EXECUTOR, pending.requestId, runs, NOW + 40_000);
    const asked: [number, string][] = [];
    const spy = answerSpy();
    const answer: ExecutorAnswerCopy = { sender: WORKER_EXECUTOR, coverage: "partial", runs, answeredAt: NOW + 40_000 };
    const base = { outcome: "status_not_current" as const, queryRequestId: pending.requestId, executor: WORKER_EXECUTOR, connection: 7, answer };
    const stale: AnswerLinks = {
      current(connection, executorId) {
        asked.push([connection, executorId]);
        return false;
      },
    };
    expect(handleForward(input(v, [pending], { links: stale }), { ledger: spy.ledger, random })).toEqual({ ...base, link: "not_current" });
    expect(asked).toEqual([[7, WORKER_EXECUTOR]]);
    const unknowns: unknown[] = [
      {
        current: () => {
          throw new Error("연결 표를 읽지 못함");
        },
      },
      { current: () => "yes" },
      undefined,
    ];
    for (const links of unknowns) expect(handleForward(input(v, [pending], { links: links as AnswerLinks }), { ledger: spy.ledger, random })).toEqual({ ...base, link: "unknown" });
    const noConnection = { ...input(v, [pending]), forward: { verified: v } } as unknown as ForwardInput;
    expect(handleForward(noConnection, { ledger: spy.ledger, random })).toEqual({ outcome: "rejected", reason: "input_malformed", field: "forward.connection" });
    expect(spy.calls).toEqual([]);
  });

  test("now나 밀린 답의 꼴이 틀리면 장부를 부르지 않는다(남의 밀린 답, full 사본 포함)", async () => {
    const runId = id();
    const pending = query([runId]);
    const v = await report(WORKER_EXECUTOR, pending.requestId, [status(runId, "running")], NOW);
    const spy = answerSpy();
    const own: ExecutorAnswerCopy = { sender: WORKER_EXECUTOR, coverage: "partial", runs: [status(runId, "running")], answeredAt: NOW };
    expect(handleForward(input(v, [pending], { now: 0 }), { ledger: spy.ledger, random })).toEqual({ outcome: "rejected", reason: "input_malformed", field: "now" });
    for (const backlog of [[{ ...own, sender: OTHER }], [{ ...own, coverage: "full" }], [{ ...own, answeredAt: -1 }], null]) {
      expect(handleForward(input(v, [pending], { backlog: backlog as unknown as ExecutorAnswerCopy[] }), { ledger: spy.ledger, random })).toEqual({
        outcome: "rejected",
        reason: "input_malformed",
        field: "backlog",
      });
    }
    expect(spy.calls).toEqual([]);
  });
});

describe("보장 2: 장부의 답을 그대로 구별해 돌려준다", () => {
  test("옮긴 실행·보류·장부 밖을 실제 장부의 답 그대로 싣는다", async () => {
    const { ledger, generation, state, runId } = realLedger();
    const outside = id();
    const first = query([runId, outside]);
    // 먼저 runId를 시작이 아직 닿을 수 있는 동안 모른다고, outside는 장부 밖에서 돈다고 답한다.
    const early = [status(runId, "not_known"), status(outside, "running", 2)];
    const deferred = matched(handleForward(input(await report(WORKER_EXECUTOR, first.requestId, early, NOW + 1_000, generation), [first]), { ledger, random }));
    expect(deferred.settled).toEqual([
      {
        settled: "applied",
        answer: { sender: WORKER_EXECUTOR, coverage: "partial", runs: early, answeredAt: NOW + 1_000 },
        moved: [],
        deferred: [{ runId, runGeneration: 1, state: "preparing", why: "start_may_arrive" }],
        outsideLedger: [{ runId: outside, runGeneration: 2 }],
      },
    ]);
    expect(state(runId)).toBe("preparing");
    // 다시 물은 답이 끝났다고 하면 믿던 임대를 거둔다.
    const second = query([runId]);
    const ended = [status(runId, "failed_stopped")];
    const moved = matched(handleForward(input(await report(WORKER_EXECUTOR, second.requestId, ended, NOW + 2_000, generation), [second]), { ledger, random }));
    expect(moved.settled).toEqual([
      {
        settled: "applied",
        answer: { sender: WORKER_EXECUTOR, coverage: "partial", runs: ended, answeredAt: NOW + 2_000 },
        moved: [{ runId, runGeneration: 1, before: "preparing", after: "unknown_running" }],
        deferred: [],
        outsideLedger: [],
      },
    ]);
    expect([deferred.backlog, moved.backlog]).toEqual([[], []]);
    expect(state(runId)).toBe("unknown_running");
  });

  test("실패는 반영으로 세지 않고 reason·unsavedSightings를 그대로 싣는다(실제 장부)", async () => {
    const { ledger, fault, generation, state, runId } = realLedger();
    const pending = query([runId]);
    const runs = [status(runId, "finalized")];
    fault.failCommit = true;
    const outcome = matched(handleForward(input(await report(WORKER_EXECUTOR, pending.requestId, runs, NOW + MAX, generation), [pending]), { ledger, random }));
    const answer: ExecutorAnswerCopy = { sender: WORKER_EXECUTOR, coverage: "partial", runs, answeredAt: NOW + MAX };
    expect(outcome.settled).toEqual([{ settled: "unsaved", answer, reason: "ledger_unwritable", unsavedSightings: [{ runId, runGeneration: 1 }] }]);
    expect(outcome.backlog).toEqual([answer]);
    expect(state(runId)).toBe("preparing");
    expect(ledger.hasRunSighting(runId)).toEqual({ known: true, value: false });
  });

  test("장부가 던지거나 답의 꼴이 틀리면 예외 없이 ledger_failed이고, 양성 항목이 있으면 밀린 답으로 남는다", async () => {
    const runId = id();
    const pending = query([runId]);
    const v = await report(WORKER_EXECUTOR, pending.requestId, [status(runId, "running")], NOW);
    const malformed: unknown[] = [
      null,
      { ok: true },
      { ok: true, moved: [{ runId }], deferred: [], outsideLedger: [] },
      { ok: false, reason: "no_such_reason", unsavedSightings: [] },
      { ok: false, reason: "ledger_unwritable" },
      {
        get ok(): boolean {
          throw new Error("getter");
        },
      },
    ];
    for (const answer of [new Error("장부가 던짐"), ...malformed]) {
      const outcome = matched(handleForward(input(v, [pending]), { ledger: answerSpy([answer]).ledger, random }));
      expect(outcome.settled.map((s) => (s.settled === "ledger_failed" ? s.failure : s.settled))).toEqual([answer instanceof Error ? "threw" : "malformed_answer"]);
      expect(outcome.backlog.map((b) => b.runs)).toEqual([[status(runId, "running")]]);
    }
  });

  test("양성 항목이 없는 답의 실패는 밀린 답으로 남기지 않는다(붙들 관측이 없다)", async () => {
    const runId = id();
    const pending = query([runId]);
    const v = await report(WORKER_EXECUTOR, pending.requestId, [status(runId, "not_known")], NOW + MAX);
    const outcome = matched(handleForward(input(v, [pending]), { ledger: answerSpy([{ ok: false, reason: "ledger_unwritable", unsavedSightings: [] }]).ledger, random }));
    expect(outcome.settled.map((s) => s.settled)).toEqual(["unsaved"]);
    expect(outcome.backlog).toEqual([]);
  });
});

describe("보장 3: 저장에 실패한 답은 같은 값으로 먼저 다시 넘긴다", () => {
  test("밀린 답을 같은 값으로 먼저 넘기고 이번 답을 그 뒤에 넘긴다", async () => {
    const runId = id();
    const first = query([runId]);
    const firstRuns = [status(runId, "running")];
    const spy = answerSpy([{ ok: false, reason: "ledger_unwritable", unsavedSightings: [{ runId, runGeneration: 1 }] }]);
    const failed = matched(handleForward(input(await report(WORKER_EXECUTOR, first.requestId, firstRuns, NOW + 10), [first]), { ledger: spy.ledger, random }));
    expect(failed.backlog).toEqual([{ sender: WORKER_EXECUTOR, coverage: "partial", runs: firstRuns, answeredAt: NOW + 10 }]);
    const second = query([runId]);
    const after = matched(
      handleForward(input(await report(WORKER_EXECUTOR, second.requestId, [status(runId, "not_known")], NOW + MAX), [second], { backlog: failed.backlog, now: NOW + 600_000 }), {
        ledger: spy.ledger,
        random,
      }),
    );
    expect(spy.calls.map((c) => [c.input.coverage, c.input.runs, c.input.answeredAt, c.from.sender])).toEqual([
      ["partial", firstRuns, NOW + 10, WORKER_EXECUTOR],
      ["partial", firstRuns, NOW + 10, WORKER_EXECUTOR],
      ["partial", [status(runId, "not_known")], NOW + MAX, WORKER_EXECUTOR],
    ]);
    expect(after.settled.map((s) => s.settled)).toEqual(["applied", "applied"]);
    expect(after.backlog).toEqual([]);
  });

  test("밀린 답이 또 저장되지 않으면 이번 답은 넘기지 않고 그 뒤에 줄 세운다", async () => {
    const runId = id();
    const backlog: ExecutorAnswerCopy[] = [{ sender: WORKER_EXECUTOR, coverage: "partial", runs: [status(runId, "running")], answeredAt: NOW + 10 }];
    const pending = query([runId]);
    const spy = answerSpy([{ ok: false, reason: "ledger_unwritable", unsavedSightings: [{ runId, runGeneration: 1 }] }]);
    const newer = [status(runId, "finalized")];
    const outcome = matched(handleForward(input(await report(WORKER_EXECUTOR, pending.requestId, newer, NOW + MAX), [pending], { backlog }), { ledger: spy.ledger, random }));
    expect(spy.calls).toHaveLength(1);
    expect(outcome.settled.map((s) => s.settled)).toEqual(["unsaved", "held"]);
    expect(outcome.backlog).toEqual([...backlog, { sender: WORKER_EXECUTOR, coverage: "partial", runs: newer, answeredAt: NOW + MAX }]);
  });

  test("replayBacklog는 새 답 없이 밀린 답을 같은 값으로 순서대로 넘기고, 꼴이 틀린 목록은 장부를 부르지 않는다", () => {
    const runId = id();
    const a: ExecutorAnswerCopy = { sender: WORKER_EXECUTOR, coverage: "partial", runs: [status(runId, "running")], answeredAt: NOW + 10 };
    const b: ExecutorAnswerCopy = { sender: WORKER_EXECUTOR, coverage: "partial", runs: [status(runId, "stopping")], answeredAt: null };
    const spy = answerSpy();
    const outcome = replayBacklog({ backlog: [a, b], now: NOW + 700_000 }, { ledger: spy.ledger });
    expect(outcome.outcome === "backlog_settled" && [outcome.settled.map((s) => s.settled), outcome.backlog]).toEqual([["applied", "applied"], []]);
    expect(spy.calls.map((c) => [c.input, c.from])).toEqual([
      [{ coverage: "partial", runs: a.runs, answeredAt: NOW + 10, now: NOW + 700_000 }, { sender: WORKER_EXECUTOR }],
      [{ coverage: "partial", runs: b.runs, answeredAt: null, now: NOW + 700_000 }, { sender: WORKER_EXECUTOR }],
    ]);
    expect(replayBacklog({ backlog: [], now: NOW }, { ledger: spy.ledger })).toEqual({ outcome: "backlog_settled", settled: [], backlog: [] });
    expect(replayBacklog({ backlog: [a, { ...b, sender: OTHER }], now: NOW }, { ledger: spy.ledger })).toEqual({ outcome: "rejected", reason: "input_malformed", field: "backlog" });
    expect(replayBacklog({ backlog: [a], now: Number.NaN }, { ledger: spy.ledger })).toEqual({ outcome: "rejected", reason: "input_malformed", field: "now" });
    expect(spy.calls).toHaveLength(2);
  });

  test("밀린 '안다'는 답 → 새 '모른다'는 답의 순서로 실제 장부에 닿고, 관측이 남는다", async () => {
    const { ledger, fault, generation, state, runId } = realLedger();
    const order: string[] = [];
    // 실제 장부를 감싸 넘긴 순서만 적는다.
    const recording: ReceiptLedger = {
      applyReceipt: (i, f) => ledger.applyReceipt(i, f),
      recordReport: (i, f) => ledger.recordReport(i, f),
      applyExecutorAnswer(i, f) {
        order.push(i.runs.map((r) => r.state).join(","));
        return ledger.applyExecutorAnswer(i, f);
      },
    };
    const first = query([runId]);
    fault.failCommit = true;
    const failed = matched(handleForward(input(await report(WORKER_EXECUTOR, first.requestId, [status(runId, "running")], NOW + 10, generation), [first]), { ledger: recording, random }));
    fault.failCommit = false;
    expect(failed.settled.map((s) => s.settled)).toEqual(["unsaved"]);
    expect(ledger.hasRunSighting(runId)).toEqual({ known: true, value: false });

    const second = query([runId]);
    const later = matched(
      handleForward(input(await report(WORKER_EXECUTOR, second.requestId, [status(runId, "not_known")], NOW + MAX, generation), [second], { backlog: failed.backlog }), {
        ledger: recording,
        random,
      }),
    );
    expect(order).toEqual(["running", "running", "not_known"]);
    expect(later.settled).toEqual([
      { settled: "applied", answer: failed.backlog[0], moved: [], deferred: [], outsideLedger: [] },
      {
        settled: "applied",
        answer: { sender: WORKER_EXECUTOR, coverage: "partial", runs: [status(runId, "not_known")], answeredAt: NOW + MAX },
        moved: [{ runId, runGeneration: 1, before: "preparing", after: "unknown_running" }],
        deferred: [],
        outsideLedger: [],
      },
    ]);
    expect(later.backlog).toEqual([]);
    expect(ledger.hasRunSighting(runId)).toEqual({ known: true, value: true });
    expect(state(runId)).toBe("unknown_running");
  });
});

describe("보장 4: 결과에 원문·서명 재료가 없다", () => {
  test("status_matched와 status_not_current의 결과 JSON에 nonce·서명·body_digest가 없다", async () => {
    const runId = id();
    const pending = query([runId]);
    const v = await report(WORKER_EXECUTOR, pending.requestId, [status(runId, "running")], NOW);
    if (!v.ok) throw new Error("검증 실패");
    const header = v.header as unknown as Record<string, unknown>;
    const secrets = [header.nonce, header.body_digest, header.request_id].filter((x): x is string => typeof x === "string");
    expect(secrets.length).toBe(3);
    const outcomes = [
      handleForward(input(v, [pending]), { ledger: answerSpy().ledger, random }),
      handleForward(input(v, [pending], { links: { current: () => false } }), { ledger: answerSpy().ledger, random }),
    ];
    for (const outcome of outcomes) {
      const json = JSON.stringify(outcome);
      for (const secret of secrets) expect(json).not.toContain(secret);
      expect(json).not.toContain("signature");
    }
  });
});
