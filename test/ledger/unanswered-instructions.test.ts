// 지시 본문의 보존(판 0004-instruction-rebuild)과 답을 받지 못한 지시의 읽기(unansweredInstructions). 실제 장부 파일에 적고, 다시 연
// 장부의 읽기만으로 초안을 다시 만든다. 다시 만든 봉투가 처음 봉투와 같은 요청인지는 감독의 봉투 모듈(envelopes.ts)의 공개 함수로 본다.
// 장부 코드는 그 모듈을 import하지 않는다. 시험만 둘을 잇는다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Envelope, type InstructionAction, sealEnvelope, SESSION_STOP_REASONS, TASK_CANCEL_REASONS } from "../../src/contract/v1/index.ts";
import {
  FINALIZE_OUTCOMES,
  type Ledger,
  LedgerInputError,
  loadMigrations,
  MIGRATIONS_DIR,
  openLedger,
  type UnansweredInstruction,
  type UnansweredInstructions,
} from "../../src/ledger/index.ts";
import { type Drafted, type DraftAction, finalizeDraft, sealDraft, startDraft, stopDraft } from "../../src/supervisor/dispatch/envelopes.ts";
import type { Random, Signer } from "../../src/supervisor/dispatch/ports.ts";
import { digest, from, id, must, NOW, open, ready, tempPath, worker } from "./helpers.ts";

// ID·digest·키는 이 시험이 고른 값이다. 운영값이 아니다.
const REBUILD_FILE = "0004-instruction-rebuild.sql";
const REBUILD_VERSION = loadMigrations().findIndex((m) => m.name === REBUILD_FILE) + 1;
const RESULT = digest("result bytes");
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";

// 장부 시계. 시험마다 처음 값으로 되돌린다.
let ledgerNow = NOW;
const clock = () => ledgerNow;

function openAt(path: string, options: Parameters<typeof open>[1] = {}): Ledger {
  ledgerNow = NOW;
  return ready(open(path, { clock, ...options }));
}

function unanswered(ledger: Ledger): UnansweredInstructions {
  const read = ledger.unansweredInstructions();
  if (!read.known) throw new Error(`읽지 못함: ${read.reason}`);
  return read.value;
}

const listed = (ledger: Ledger) => unanswered(ledger).instructions.map((i) => [i.action, i.requestId]);

function rawRows(path: string, sql: string): unknown[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query(sql).all();
  } finally {
    raw.close();
  }
}

function startWorker(ledger: Ledger) {
  const admitted = must(ledger.admitRun(worker()));
  const requestId = id();
  const answer = must(ledger.startRun({ runId: admitted.run.runId, requestId, stopGeneration: 0, now: ledgerNow }));
  return { ...answer, requestId, runId: answer.run.runId, from: from(answer.run) };
}

const accepted = (runId: string, instructionRequestId: string, instruction: InstructionAction) => ({
  action: "receipt_accepted" as const,
  receiptId: id(),
  runId,
  instructionRequestId,
  instruction,
  bodyDigest: digest(`accepted:${instructionRequestId}`),
  now: NOW,
});
const started = (runId: string, instructionRequestId: string) => ({ action: "receipt_started" as const, receiptId: id(), runId, instructionRequestId, bodyDigest: digest(`started:${runId}`), now: NOW });
const stopped = (runId: string, exit: "completed" | "cancelled") => ({ action: "receipt_stopped" as const, receiptId: id(), runId, exit, bodyDigest: digest(`stopped:${runId}`), now: NOW });
const cleaned = (runId: string, instructionRequestId: string) => ({ action: "receipt_cleaned" as const, receiptId: id(), runId, instructionRequestId, bodyDigest: digest(`cleaned:${runId}`), now: NOW });

// ---- 봉투 ----

const keys = generateKeyPairSync("ed25519");
const signer: Signer = { seal: (input) => sealEnvelope(input, keys.privateKey) };

function random(seed: number): Random {
  let next = seed;
  return { bytes: (length: number) => Uint8Array.from({ length }, () => next++ & 0xff) };
}

function sealed(drafted: Drafted<DraftAction>, now: number, seed: number): Envelope {
  if (!drafted.ok) throw new Error(`초안 거절: ${JSON.stringify(drafted)}`);
  const result = sealDraft(drafted.draft, now, { random: random(seed), signer });
  if (!result.ok) throw new Error(`봉하기 거절: ${JSON.stringify(result)}`);
  return result.envelope;
}

// 장부 읽기의 항목 하나만으로 envelopes.ts의 초안 입력을 채운다. 실행 줄을 따로 읽지 않는다.
function redraft(item: UnansweredInstruction): Drafted<DraftAction> {
  const rebuild = item.rebuild;
  if (rebuild === null) throw new Error("다시 만들 수 없는 지시");
  const run = { runId: item.runId, runGeneration: item.runGeneration, executorId: item.executorId };
  const head = { requestId: item.requestId, stopGeneration: item.stopGeneration };
  switch (rebuild.action) {
    case "task_start": {
      const { action: _, ...fields } = rebuild;
      return startDraft({ run: { ...run, kind: "worker", ...fields }, ...head, issuedAt: item.issuedAt });
    }
    case "task_cancel":
      return stopDraft({ action: "task_cancel", run, ...head, reason: rebuild.reason });
    case "session_stop":
      return stopDraft({ action: "session_stop", run, ...head, reason: rebuild.reason });
    case "result_finalize":
      return finalizeDraft({ run, ...head, outcome: rebuild.outcome, resultDigest: rebuild.resultDigest, storedAt: rebuild.storedAt });
  }
}

// 같은 요청의 재전송: 모든 동작에서 받는 쪽·요청 ID·두 세대·본문 digest·본문이 같고 nonce는 새것이다.
// 머리의 두 시각은 동작마다 다르므로(envelopes.md "시각 규칙") 시험마다 따로 단언한다.
function expectSameRequest(first: Envelope, again: Envelope): void {
  for (const field of ["recipient", "action", "request_id", "stop_generation", "run_generation", "body_digest"] as const) {
    expect(again.header[field], field).toBe(first.header[field]);
  }
  expect(again.body).toEqual(first.body);
  expect(again.header.nonce).not.toBe(first.header.nonce);
}

// 취소·세션 정지·확정은 봉하는 때의 시각을 머리에 싣는다. 같은 요청이지만 issued_at·expires_at은 각자 봉한 때의 값이다
// (시한은 계약의 기본 수명 30000ms). 실행기는 같은 요청 ID를 본문 digest로 대조하므로 새 시각의 봉투도 같은 요청이다.
function expectResealed(first: Envelope, again: Envelope, firstAt: number, againAt: number): void {
  expectSameRequest(first, again);
  expect([first.header.issued_at, first.header.expires_at]).toEqual([firstAt, firstAt + 30_000]);
  expect([again.header.issued_at, again.header.expires_at]).toEqual([againAt, againAt + 30_000]);
}

// ---- 보장 3·1: 지시마다의 발행 시각과 본문 칸 ----

test("시작 지시: 갱신과 예산 감소 뒤에도 지시 줄의 발행 시각·예산으로 처음과 같은 봉투를 다시 만든다", () => {
  const path = tempPath();
  const ledger = openAt(path);
  ledgerNow = NOW + 1_000;
  const start = startWorker(ledger);
  expect(start.issuedAt).toBe(NOW + 1_000);
  const first = sealed(startDraft({ run: start.run, requestId: start.requestId, stopGeneration: 0, issuedAt: start.issuedAt }), NOW + 1_001, 1);

  // 갱신이 적히면 instructionTimes의 임대 발행 시각은 갱신의 시각이 되고, 실행 줄의 예산은 줄 수 있다.
  must(ledger.recordRenewInstruction({ runId: start.runId, requestId: id(), stopGeneration: 0, now: NOW + 6_000 }));
  must(ledger.recordBudget({ runId: start.runId, budgetLeft: 10_000, now: NOW + 6_000 }));
  expect(ledger.instructionTimes(start.runId)).toMatchObject({ known: true, value: { lease: { issuedAt: NOW + 6_000 } } });
  ledger.close();

  const again = open(path, { clock });
  const value = unanswered(again);
  expect(value.stopGeneration).toBe(0);
  expect(value.instructions).toEqual([
    {
      requestId: start.requestId,
      action: "task_start",
      runId: start.runId,
      runGeneration: start.run.runGeneration,
      executorId: start.run.executorId,
      runState: "preparing",
      stopGeneration: 0,
      issuedAt: NOW + 1_000,
      rebuild: {
        action: "task_start",
        role: "diagnosis",
        profileRevision: start.run.profileRevision,
        policyRevision: start.run.policyRevision,
        snapshotDigest: start.run.snapshotDigest as string,
        inputDigest: start.run.inputDigest as string,
        deadlineAt: start.run.deadlineAt,
        budgetLeft: 50_000,
        credential: start.run.credential,
      },
    },
  ]);
  const rebuilt = sealed(redraft(value.instructions[0] as UnansweredInstruction), NOW + 1_002, 99);
  expectSameRequest(first, rebuilt);
  // 시작은 장부의 발행 시각을 그대로 실어 시한도 같다.
  expect([rebuilt.header.issued_at, rebuilt.header.expires_at]).toEqual([first.header.issued_at, first.header.expires_at]);
});

test("종료·확정 지시: 다시 연 뒤 같은 요청 ID·본문 digest·세대로 다시 봉하고, 두 시각은 다시 봉한 때의 값이다", () => {
  const path = tempPath();
  const ledger = openAt(path);
  const start = startWorker(ledger);
  must(ledger.applyReceipt(accepted(start.runId, start.requestId, "task_start"), start.from));

  // 처음 +3000에 적고 봉한 취소를 다시 연 뒤 +60000에 다시 봉하면 시한은 +33000에서 +90000으로 옮는다.
  const cancel = id();
  must(ledger.recordStopInstruction({ runId: start.runId, requestId: cancel, action: "task_cancel", stopGeneration: 0, now: NOW + 3_000, reason: "deadline" }));
  const firstCancel = sealed(stopDraft({ action: "task_cancel", run: start.run, requestId: cancel, stopGeneration: 0, reason: "deadline" }), NOW + 3_000, 1);
  ledger.close();

  const reopened = ready(open(path, { clock }));
  const cancelItem = unanswered(reopened).instructions.find((i) => i.requestId === cancel) as UnansweredInstruction;
  expect(cancelItem).toMatchObject({ action: "task_cancel", issuedAt: NOW + 3_000, runState: "stopping", rebuild: { action: "task_cancel", reason: "deadline" } });
  expectResealed(firstCancel, sealed(redraft(cancelItem), NOW + 60_000, 99), NOW + 3_000, NOW + 60_000);

  // 종료가 확인되면(이 시험은 completed) 결과 쪽으로 가고, 확정 지시의 본문은 넘긴 세 칸이다.
  must(reopened.applyReceipt(stopped(start.runId, "completed"), start.from));
  must(reopened.markResult({ runId: start.runId, resultDigest: RESULT, now: NOW + 61_000 }));
  const finalize = id();
  const body = { outcome: "succeeded" as const, resultDigest: RESULT, storedAt: NOW + 60_900 };
  must(reopened.recordFinalizeInstruction({ runId: start.runId, requestId: finalize, stopGeneration: 0, now: NOW + 61_000, ...body }));
  const firstFinalize = sealed(finalizeDraft({ run: start.run, requestId: finalize, stopGeneration: 0, ...body }), NOW + 61_000, 2);
  reopened.close();

  const value = unanswered(open(path, { clock }));
  expect(value.instructions.map((i) => i.requestId)).toEqual([finalize]);
  const finalizeItem = value.instructions[0] as UnansweredInstruction;
  expect(finalizeItem).toMatchObject({ action: "result_finalize", issuedAt: NOW + 61_000, runState: "ready_result", rebuild: { action: "result_finalize", ...body } });
  expectResealed(firstFinalize, sealed(redraft(finalizeItem), NOW + 120_000, 98), NOW + 61_000, NOW + 120_000);
});

test("이은 부탁의 취소: 지시 줄의 본문 reason은 requested이고 답의 모양은 그대로다", () => {
  const ledger = openAt(tempPath());
  must(ledger.enqueueInput({ requestId: OWNER, source: "admin-dm", sourceRef: { ref: `inbox/${OWNER}`, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
  const ref = id();
  must(
    ledger.recordToolRequest({
      ref,
      owner: OWNER,
      dedupeKey: `start_worker:${OWNER}:diagnose`,
      role: "diagnosis",
      purpose: "diagnose",
      sourceRef: `inbox/${OWNER}`,
      inputDigest: digest("input"),
      sessionId: "session-1",
      callId: id(),
      now: NOW,
    }),
  );
  const w = worker();
  const run = must(
    ledger.assignToolRequest({
      ref,
      runId: id(),
      snapshotDigest: w.snapshotDigest as string,
      profileRevision: w.profileRevision,
      policyRevision: w.policyRevision,
      executorId: w.executorId,
      credential: w.credential,
      deadlineAt: w.deadlineAt,
      budgetLeft: w.budgetLeft,
      now: NOW,
    }),
  ).run;
  must(ledger.startRun({ runId: run.runId, requestId: id(), stopGeneration: 0, now: NOW }));
  const callId = id();
  expect(ledger.cancelToolRequest({ owner: OWNER, ref, sessionId: "session-1", callId, now: NOW + 1 })).toEqual({
    ok: true,
    phase: "stopping",
    instruction: { runId: run.runId, requestId: callId, stopGeneration: 0 },
  });
  const item = unanswered(ledger).instructions.find((i) => i.requestId === callId) as UnansweredInstruction;
  expect(item).toMatchObject({ action: "task_cancel", issuedAt: NOW + 1, rebuild: { action: "task_cancel", reason: "requested" } });
  const first = sealed(stopDraft({ action: "task_cancel", run, requestId: callId, stopGeneration: 0, reason: "requested" }), NOW + 1, 1);
  expectResealed(first, sealed(redraft(item), NOW + 60_000, 99), NOW + 1, NOW + 60_000);
});

test("본문 칸: 빼고 적은 지시는 다시 만들 수 없음이고, 계약이 받지 않는 칸은 적지 않고 던진다", () => {
  const path = tempPath();
  const ledger = openAt(path);
  const start = startWorker(ledger);
  must(ledger.applyReceipt(accepted(start.runId, start.requestId, "task_start"), start.from));
  const cancel = id();
  must(ledger.recordStopInstruction({ runId: start.runId, requestId: cancel, action: "task_cancel", stopGeneration: 0, now: NOW }));
  expect(unanswered(ledger).instructions).toMatchObject([{ requestId: cancel, action: "task_cancel", rebuild: null }]);

  // 던진 호출은 지시를 남기지 않는다: 남았다면 답을 받지 못한 지시로 읽힌다.
  const stop = { runId: start.runId, stopGeneration: 0, now: NOW };
  for (const reason of ["daily_rotation", "budget_left", ""] as const) {
    expect(() => ledger.recordStopInstruction({ ...stop, requestId: id(), action: "task_cancel", reason } as never), reason).toThrow(LedgerInputError);
  }
  expect(() => ledger.recordStopInstruction({ ...stop, requestId: id(), action: "session_stop", reason: "requested" } as never)).toThrow(LedgerInputError);
  expect(listed(ledger)).toEqual([["task_cancel", cancel]]);

  must(ledger.applyReceipt(stopped(start.runId, "cancelled"), start.from));
  const finalize = { runId: start.runId, stopGeneration: 0, now: NOW };
  const bad = [
    { outcome: "failed" },
    { outcome: "failed", resultDigest: null },
    { resultDigest: null, storedAt: NOW },
    { outcome: "succeeded", resultDigest: null, storedAt: NOW },
    { outcome: "failed", resultDigest: RESULT, storedAt: NOW },
    { outcome: "failed", resultDigest: null, storedAt: 0 },
    { outcome: "unknown", resultDigest: null, storedAt: NOW },
  ];
  for (const fields of bad) expect(() => ledger.recordFinalizeInstruction({ ...finalize, requestId: id(), ...fields } as never), JSON.stringify(fields)).toThrow(LedgerInputError);
  expect(listed(ledger)).toEqual([]);

  const plain = id();
  must(ledger.recordFinalizeInstruction({ ...finalize, requestId: plain }));
  expect(unanswered(ledger).instructions).toMatchObject([{ requestId: plain, action: "result_finalize", runState: "failed_stopped", rebuild: null }]);
});

// ---- 보장 2: 답을 받지 못한 지시의 판정 ----

test("판정: 시작은 그 실행의 영수증·보고가 없을 때, 종료는 그 요청의 접수도 종료 확인도 없을 때, 확정은 그 요청의 정리가 없을 때만 낸다", () => {
  const ledger = openAt(tempPath());
  const start = startWorker(ledger);
  expect(listed(ledger)).toEqual([["task_start", start.requestId]]);

  // 갱신은 영수증이 없는 지시라 내지 않는다.
  must(ledger.recordRenewInstruction({ runId: start.runId, requestId: id(), stopGeneration: 0, now: NOW + 1 }));
  expect(listed(ledger)).toEqual([["task_start", start.requestId]]);

  // 접수 영수증이 아직 없어도 그 실행의 다른 영수증이 오면 실행기는 시작을 받은 것이다.
  must(ledger.applyReceipt(started(start.runId, start.requestId), start.from));
  expect(listed(ledger)).toEqual([]);

  const first = id();
  must(ledger.recordStopInstruction({ runId: start.runId, requestId: first, action: "task_cancel", stopGeneration: 0, now: NOW + 2, reason: "requested" }));
  const second = id();
  must(ledger.recordStopInstruction({ runId: start.runId, requestId: second, action: "task_cancel", stopGeneration: 0, now: NOW + 3, reason: "deadline" }));
  expect(listed(ledger)).toEqual([
    ["task_cancel", first],
    ["task_cancel", second],
  ]);
  // 접수 영수증은 그 요청 ID의 지시만 답한다.
  must(ledger.applyReceipt(accepted(start.runId, first, "task_cancel"), start.from));
  expect(listed(ledger)).toEqual([["task_cancel", second]]);
  // 종료 확인은 그 실행의 모든 종료 지시를 답한다.
  must(ledger.applyReceipt(stopped(start.runId, "cancelled"), start.from));
  expect(listed(ledger)).toEqual([]);

  const finalizeA = id();
  const finalizeB = id();
  const body = { outcome: "cancelled" as const, resultDigest: null, storedAt: NOW + 4 };
  must(ledger.recordFinalizeInstruction({ runId: start.runId, requestId: finalizeA, stopGeneration: 0, now: NOW + 4, ...body }));
  must(ledger.recordFinalizeInstruction({ runId: start.runId, requestId: finalizeB, stopGeneration: 0, now: NOW + 5, ...body }));
  expect(listed(ledger)).toEqual([
    ["result_finalize", finalizeA],
    ["result_finalize", finalizeB],
  ]);
  // 정리 영수증은 가리킨 확정만 답하지만, 그 실행이 finalized가 되면 끝난 실행의 지시는 내지 않는다.
  must(ledger.applyReceipt(cleaned(start.runId, finalizeA), start.from));
  expect(ledger.getRun(start.runId)).toMatchObject({ known: true, value: { state: "finalized" } });
  expect(listed(ledger)).toEqual([]);
});

test("판정: 접수 영수증을 받은 시작은 내지 않고, 시작하지 않은 실행에는 지시가 없다", () => {
  const ledger = openAt(tempPath());
  const queued = must(ledger.admitRun(worker())).run;
  must(ledger.recordStopInstruction({ runId: queued.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  expect(ledger.getRun(queued.runId)).toMatchObject({ known: true, value: { state: "not_started" } });
  expect(listed(ledger)).toEqual([]);

  const start = startWorker(ledger);
  expect(listed(ledger)).toEqual([["task_start", start.requestId]]);
  must(ledger.applyReceipt(accepted(start.runId, start.requestId, "task_start"), start.from));
  expect(listed(ledger)).toEqual([]);
});

test("판정: 지시의 정지 세대와 장부의 지금 정지 세대를 함께 내고, 시작이 종료보다 앞이다", () => {
  const ledger = openAt(tempPath());
  const start = startWorker(ledger);
  must(ledger.applyStop({ generation: 1, stopped: true, now: NOW + 1 }));
  const cancel = id();
  must(ledger.recordStopInstruction({ runId: start.runId, requestId: cancel, action: "task_cancel", stopGeneration: 1, now: NOW - 5, reason: "emergency_stop" }));
  const value = unanswered(ledger);
  expect(value.stopGeneration).toBe(1);
  // 종료의 발행 시각이 시작보다 일러도 같은 실행 안에서는 시작이 앞이다.
  expect(value.instructions.map((i) => [i.action, i.stopGeneration, i.issuedAt])).toEqual([
    ["task_start", 0, NOW],
    ["task_cancel", 1, NOW - 5],
  ]);
});

test("읽기 실패는 known: false이고 장부를 바꾸지 않는다", () => {
  const path = tempPath();
  let failing = false;
  const ledger = openAt(path);
  startWorker(ledger);
  ledger.close();
  const rows = rawRows(path, "SELECT * FROM instructions ORDER BY request_id");
  const again = open(path, { clock, faults: { at: (point: string) => failing && point === "read" && fail() } });
  const before = unanswered(again);
  failing = true;
  expect(again.unansweredInstructions()).toMatchObject({ known: false });
  again.close();
  expect(rawRows(path, "SELECT * FROM instructions ORDER BY request_id")).toEqual(rows);
  failing = false;
  expect(unanswered(open(path, { clock }))).toEqual(before);
});

function fail(): never {
  throw new Error("주입한 읽기 실패");
}

// ---- 보장 4: 기존 장부와 기존 동작 ----

test("이관: 판 1~3의 장부가 판 4로 올라가고 기존 지시 줄은 그대로이며 다시 만들 수 없음으로 읽힌다", () => {
  expect(REBUILD_VERSION).toBe(4);
  const old = "request_id, run_id, action, stop_generation, issued_at";
  for (let version = 1; version < REBUILD_VERSION; version++) {
    const path = tempPath();
    const before = openAt(path, { migrations: loadMigrations().slice(0, version) });
    const start = startWorker(before);
    const cancel = id();
    must(before.recordStopInstruction({ runId: start.runId, requestId: cancel, action: "task_cancel", stopGeneration: 0, now: NOW }));
    // 끊어 연 장부에는 칸이 없어 읽기도 본문을 내지 않는다.
    expect(unanswered(before).instructions.map((i) => i.rebuild)).toEqual([null, null]);
    before.close();
    const rows = rawRows(path, `SELECT ${old} FROM instructions ORDER BY request_id`);

    const upgraded = openLedger(path, { clock, mode: "reopen" });
    expect(upgraded, `판 ${version}`).toMatchObject({ ok: true, migrated: { from: version, to: loadMigrations().length } });
    if (!upgraded.ok) continue;
    const value = unanswered(upgraded.ledger);
    expect(value.instructions.map((i) => [i.action, i.requestId, i.rebuild])).toEqual([
      ["task_start", start.requestId, null],
      ["task_cancel", cancel, null],
    ]);
    // 올라간 뒤의 새 지시는 본문 칸과 함께 적힌다.
    const later = id();
    must(ready(upgraded.ledger).recordStopInstruction({ runId: start.runId, requestId: later, action: "task_cancel", stopGeneration: 0, now: NOW + 1, reason: "budget" }));
    expect(unanswered(upgraded.ledger).instructions.find((i) => i.requestId === later)?.rebuild).toEqual({ action: "task_cancel", reason: "budget" });
    upgraded.ledger.close();

    // 기존 줄의 다른 칸은 그대로이고 새 칸은 비어 있다.
    const mine = `WHERE request_id IN ('${start.requestId}', '${cancel}') ORDER BY request_id`;
    expect(rawRows(path, `SELECT ${old} FROM instructions ${mine}`)).toEqual(rows);
    expect(rawRows(path, `SELECT DISTINCT budget_left, reason, outcome, result_digest, stored_at FROM instructions ${mine}`)).toEqual([
      { budget_left: null, reason: null, outcome: null, result_digest: null, stored_at: null },
    ]);
    // integrity_check는 CHECK 위반도 보고한다: 올라간 기존 줄이 판 4의 제약을 지난다.
    expect(rawRows(path, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  }
});

test("이관: 판 1~3에 적힌 확정 줄도 판 4의 제약을 지나 올라가고 다시 만들 수 없음으로 읽힌다", () => {
  for (let version = 1; version < REBUILD_VERSION; version++) {
    const path = tempPath();
    const before = openAt(path, { migrations: loadMigrations().slice(0, version) });
    const start = startWorker(before);
    must(before.recordStopInstruction({ runId: start.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW }));
    must(before.applyReceipt(stopped(start.runId, "cancelled"), start.from));
    const finalize = id();
    must(before.recordFinalizeInstruction({ runId: start.runId, requestId: finalize, stopGeneration: 0, now: NOW }));
    before.close();

    const upgraded = openLedger(path, { clock, mode: "reopen" });
    expect(upgraded, `판 ${version}`).toMatchObject({ ok: true, migrated: { from: version, to: loadMigrations().length } });
    if (!upgraded.ok) continue;
    expect(unanswered(upgraded.ledger).instructions.map((i) => [i.action, i.requestId, i.rebuild])).toEqual([["result_finalize", finalize, null]]);
    upgraded.ledger.close();
    expect(rawRows(path, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  }
});

test("이관: 본문 칸의 CHECK는 다시 만들 수 있는 완전한 꼴이거나 전부 빈 줄만 받는다", () => {
  const path = tempPath();
  const ledger = openAt(path);
  const start = startWorker(ledger);
  ledger.close();
  const count = () => rawRows(path, "SELECT count(*) AS n FROM instructions");
  const before = count();

  // 공개 쓰기(finalizeFields·oneOf)가 먼저 막는 조합이다. SQL로 직접 넣어도 줄이 생기지 않는지 본다.
  const rejected = [
    // 결과 digest만 있는 확정: outcome이 NULL이면 `=` 비교는 NULL이고 CHECK는 NULL을 통과로 보므로 이관이 IS로 막는 조합이다.
    { action: "result_finalize", result_digest: RESULT },
    { action: "result_finalize", outcome: "failed" },
    { action: "result_finalize", stored_at: NOW },
    { action: "result_finalize", result_digest: RESULT, stored_at: NOW },
    { action: "result_finalize", outcome: "succeeded", stored_at: NOW },
    { action: "result_finalize", outcome: "failed", result_digest: RESULT, stored_at: NOW },
    { action: "task_cancel", result_digest: RESULT },
    { action: "task_cancel", budget_left: 1 },
    { action: "task_cancel", reason: "daily_rotation" },
    { action: "session_stop", reason: "requested" },
    { action: "task_start", reason: "requested" },
    { action: "task_start", budget_left: 0 },
  ];
  const raw = new Database(path);
  try {
    for (const row of rejected) {
      const values = [id(), start.runId, row.action, 0, NOW, row.budget_left ?? null, row.reason ?? null, row.outcome ?? null, row.result_digest ?? null, row.stored_at ?? null];
      const insert = () =>
        raw
          .query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at, budget_left, reason, outcome, result_digest, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(...values);
      expect(insert, JSON.stringify(row)).toThrow("CHECK constraint failed");
    }
  } finally {
    raw.close();
  }
  expect(count()).toEqual(before);
});

test("이관: 판 4의 장부는 그 앞의 판 목록(옛 코드)으로 열지 않는다", () => {
  const path = tempPath();
  openAt(path).close();
  expect(openLedger(path, { clock, mode: "reopen", migrations: loadMigrations().slice(0, REBUILD_VERSION - 1) })).toMatchObject({ ok: false, reason: "too_new" });
});

test("불변: 같은 요청 ID로 다시 적으면 지금처럼 거절되고 적힌 본문 칸은 바뀌지 않는다", () => {
  const path = tempPath();
  const ledger = openAt(path);
  const start = startWorker(ledger);
  const cancel = id();
  must(ledger.recordStopInstruction({ runId: start.runId, requestId: cancel, action: "task_cancel", stopGeneration: 0, now: NOW, reason: "requested" }));
  expect(ledger.recordStopInstruction({ runId: start.runId, requestId: cancel, action: "task_cancel", stopGeneration: 0, now: NOW + 1, reason: "deadline" })).toEqual({
    ok: false,
    reason: "invariant_violation",
  });
  // 상태 검사가 먼저 걸리면 사유가 다르다: 같은 실행의 시작 재호출은 중복 INSERT 전에 transition_denied다.
  expect(ledger.startRun({ runId: start.runId, requestId: start.requestId, stopGeneration: 0, now: NOW + 1 })).toEqual({ ok: false, reason: "transition_denied" });
  ledger.close();
  expect(rawRows(path, `SELECT reason, issued_at FROM instructions WHERE request_id = '${cancel}'`)).toEqual([{ reason: "requested", issued_at: NOW }]);
  const raw = new Database(path);
  try {
    expect(() => raw.run(`UPDATE instructions SET reason = 'deadline' WHERE request_id = '${cancel}'`)).toThrow("instruction_fixed");
    expect(() => raw.run(`UPDATE instructions SET budget_left = 1 WHERE request_id = '${start.requestId}'`)).toThrow("instruction_fixed");
  } finally {
    raw.close();
  }
});

test("정적: 판 4의 허용 값 목록은 계약 v1의 목록과 같다", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, REBUILD_FILE), "utf8");
  const listIn = (pattern: RegExp) => {
    const match = pattern.exec(sql);
    if (match === null) throw new Error(`목록이 없다: ${pattern.source}`);
    return [...(match[1] as string).matchAll(/'([^']+)'/g)].map((value) => value[1] as string).sort();
  };
  expect(listIn(/action = 'task_cancel' AND reason IN \(([^)]*)\)/)).toEqual([...TASK_CANCEL_REASONS].sort());
  expect(listIn(/action = 'session_stop' AND reason IN \(([^)]*)\)/)).toEqual([...SESSION_STOP_REASONS].sort());
  expect(listIn(/outcome IN \(([^)]*)\)/)).toEqual([...FINALIZE_OUTCOMES].sort());
});
