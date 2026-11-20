// 배정기가 장부에서 읽고 쓰는 세 자리: 대기 부탁의 목록(listWaitingToolRequests), 시작 답의 발행 시각(startRun의 issuedAt),
// 잇기(assignToolRequest)의 소유자 입력 취소·만료 재확인. 실제 장부 파일에 적고, 장부 시계는 시험마다 바꿀 수 있게 주입한다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { AssignToolRequestInput, Ledger, ToolRequestInput, WaitingToolRequest } from "../../src/ledger/index.ts";
import { digest, id, must, NOW, open, ready, tempPath, worker } from "./helpers.ts";

// ID와 digest는 이 시험이 고른 값이다. 운영값이 아니다.
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D1 = digest("input one");
const D2 = digest("input two");
const SESSION_ID = "session-1";
const EXPIRES = NOW + 3_600_000;

// 장부 시계. 시험마다 처음 값으로 되돌린다.
let ledgerNow = NOW;
const clock = () => ledgerNow;

function openAt(path: string, options: Parameters<typeof open>[1] = {}): Ledger {
  ledgerNow = NOW;
  return ready(open(path, { clock, ...options }));
}

const sourceOf = (owner: string) => `inbox/${owner}`;

function enqueue(ledger: Ledger, owner: string, expiresAt = EXPIRES): void {
  must(ledger.enqueueInput({ requestId: owner, source: "admin-dm", sourceRef: { ref: sourceOf(owner), expiresAt }, receivedAt: NOW }));
}

function request(owner: string, over: Partial<ToolRequestInput> = {}): ToolRequestInput {
  return {
    ref: id(),
    owner,
    dedupeKey: `start_worker:${owner}:diagnose`,
    role: "diagnosis",
    purpose: "diagnose",
    sourceRef: sourceOf(owner),
    inputDigest: D1,
    sessionId: SESSION_ID,
    callId: id(),
    now: NOW,
    ...over,
  };
}

function assignment(ref: string, over: Partial<AssignToolRequestInput> = {}): AssignToolRequestInput {
  const w = worker();
  return {
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
    ...over,
  };
}

function rows(path: string, sql: string): unknown[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query(sql).all();
  } finally {
    raw.close();
  }
}

function waiting(ledger: Ledger) {
  const read = ledger.listWaitingToolRequests();
  if (!read.known) throw new Error(`대기 목록을 읽지 못함: ${read.reason}`);
  return read.value;
}

const runCount = (ledger: Ledger) => {
  const runs = ledger.listRuns();
  if (!runs.known) throw new Error("실행 목록을 읽지 못함");
  return runs.value.length;
};

// ---- 보장 1: 대기 부탁의 목록 ----

test("대기 목록은 이어지지 않은 대기 부탁만 소유자 입력의 순번 다음 기록 순서로 낸다", () => {
  const path = tempPath();
  const ledger = openAt(path);
  // 입력 순번은 A(1), B(2), C(3)다. 부탁은 순번과 다른 차례로 적는다.
  enqueue(ledger, A);
  enqueue(ledger, B);
  enqueue(ledger, C);
  const b = must(ledger.recordToolRequest(request(B, { inputDigest: D2 }))).request;
  const aLate = must(ledger.recordToolRequest(request(A, { dedupeKey: `start_worker:${A}:read`, purpose: "read", now: NOW + 5 }))).request;
  const aEarly = must(ledger.recordToolRequest(request(A, { dedupeKey: `start_worker:${A}:diagnose`, now: NOW + 1 }))).request;
  // 이을 부탁과 취소할 부탁(C의 둘)은 목록에서 빠진다.
  const linked = must(ledger.recordToolRequest(request(C, { dedupeKey: `start_worker:${C}:diagnose` }))).request;
  const cancelled = must(ledger.recordToolRequest(request(C, { dedupeKey: `start_worker:${C}:read`, purpose: "read" }))).request;
  must(ledger.assignToolRequest(assignment(linked.ref)));
  must(ledger.cancelToolRequest({ owner: C, ref: cancelled.ref, sessionId: SESSION_ID, callId: id(), now: NOW }));

  const input = { cancelled: false, expiresAt: EXPIRES };
  const expected: WaitingToolRequest[] = [
    { ref: aEarly.ref, owner: A, role: "diagnosis", inputDigest: D1, input },
    { ref: aLate.ref, owner: A, role: "diagnosis", inputDigest: D1, input },
    { ref: b.ref, owner: B, role: "diagnosis", inputDigest: D2, input },
  ];
  expect(ledger.listWaitingToolRequests()).toEqual({ known: true, value: expected });
  // 두 번 읽어도 같은 순서이고, 다시 연 뒤에도 같다.
  expect(ledger.listWaitingToolRequests()).toEqual({ known: true, value: expected });
  ledger.close();
  expect(openAt(path).listWaitingToolRequests()).toEqual({ known: true, value: expected });
});

test("기록 시각이 같거나 뒤집혀도 순서는 참조로 정해진다", () => {
  const ledger = openAt(tempPath());
  enqueue(ledger, A);
  const refs = ["99999999-0000-4000-8000-000000000009", "11111111-0000-4000-8000-000000000001", "55555555-0000-4000-8000-000000000005"];
  refs.forEach((ref, i) => must(ledger.recordToolRequest(request(A, { ref, dedupeKey: `start_worker:${A}:p${i}`, purpose: `p${i}`, now: NOW }))));
  expect(waiting(ledger).map((w) => w.ref)).toEqual([...refs].sort());
});

test("대기 목록의 항목은 고르기와 잇기에 필요한 칸만 싣는다", () => {
  const ledger = openAt(tempPath());
  enqueue(ledger, A);
  const callId = id();
  const written = request(A, { callId });
  must(ledger.recordToolRequest(written));
  const [item] = waiting(ledger);
  // 칸 이름 집합을 고정한다: 원문·자격·세션 ID·호출 ID·재시도 키·목적·원본 참조는 없다.
  expect(Object.keys(item as object).sort()).toEqual(["input", "inputDigest", "owner", "ref", "role"]);
  expect(Object.keys((item as { input: object }).input).sort()).toEqual(["cancelled", "expiresAt"]);
  const text = JSON.stringify(item);
  for (const hidden of [callId, SESSION_ID, written.dedupeKey, written.sourceRef, "credential", "acct-a"]) expect(text).not.toContain(hidden);
});

test("취소·만료된 입력의 부탁도 그 입력의 취소·만료 칸과 함께 낸다", () => {
  const ledger = openAt(tempPath());
  enqueue(ledger, A, NOW + 100);
  enqueue(ledger, B);
  const a = must(ledger.recordToolRequest(request(A))).request;
  const b = must(ledger.recordToolRequest(request(B))).request;
  must(ledger.cancelInput(B, NOW));
  ledgerNow = NOW + 100;
  expect(waiting(ledger)).toEqual([
    { ref: a.ref, owner: A, role: "diagnosis", inputDigest: D1, input: { cancelled: false, expiresAt: NOW + 100 } },
    { ref: b.ref, owner: B, role: "diagnosis", inputDigest: D1, input: { cancelled: true, expiresAt: EXPIRES } },
  ]);
});

test("대기 목록을 읽지 못하면 known: false이고 장부를 바꾸지 않는다", () => {
  const path = tempPath();
  const first = openAt(path);
  enqueue(first, A);
  must(first.recordToolRequest(request(A)));
  first.close();
  // 장부가 열려 있는 동안은 파일을 잠그므로 비교할 줄은 닫은 뒤에 읽는다.
  const before = rows(path, "SELECT * FROM tool_requests");
  let fail = false;
  const ledger = openAt(path, {
    faults: {
      at(point) {
        if (fail && point === "read") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      },
    },
  });
  fail = true;
  expect(ledger.listWaitingToolRequests()).toMatchObject({ known: false });
  fail = false;
  ledger.close();
  expect(rows(path, "SELECT * FROM tool_requests")).toEqual(before);
  expect(openAt(path).listWaitingToolRequests()).toMatchObject({ known: true, value: [{ owner: A }] });
});

// ---- 보장 2: 시작의 발행 시각 ----

test("startRun은 넘긴 now가 아니라 장부가 시작 지시에 적은 발행 시각을 돌려준다", () => {
  const path = tempPath();
  const ledger = openAt(path);
  enqueue(ledger, A);
  const ref = must(ledger.recordToolRequest(request(A))).request.ref;
  const runId = must(ledger.assignToolRequest(assignment(ref))).run.runId;
  const requestId = id();
  ledgerNow = NOW + 7;
  const started = must(ledger.startRun({ runId, requestId, stopGeneration: 0, now: NOW + 3 }));
  expect(started.issuedAt).toBe(NOW + 7);
  // 갱신 전의 lease.issuedAt과 장부에 적힌 지시의 issued_at이 같은 값이다.
  expect(ledger.instructionTimes(runId)).toMatchObject({ known: true, value: { lease: { issuedAt: started.issuedAt } } });
  // 기존 칸은 그대로다.
  expect(Object.keys(started).sort()).toEqual(["credential", "issuedAt", "ok", "run"]);
  expect(started.run).toMatchObject({ runId, state: "preparing" });
  // 이미 시작한 실행을 다시 부르면 거절이고 발행 시각을 내지 않는다.
  expect(ledger.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW + 8 })).toEqual({ ok: false, reason: "transition_denied" });
  ledger.close();
  expect(rows(path, `SELECT issued_at FROM instructions WHERE request_id = '${requestId}'`)).toEqual([{ issued_at: NOW + 7 }]);
});

// ---- 보장 3: 잇기는 입력의 취소·만료를 다시 본다 ----

test("잇기는 소유자 입력이 취소됐으면 실행 줄을 만들지 않고 input_cancelled다", () => {
  const path = tempPath();
  const ledger = openAt(path);
  enqueue(ledger, A);
  const ref = must(ledger.recordToolRequest(request(A))).request.ref;
  must(ledger.cancelInput(A, NOW));
  const tried = assignment(ref);
  expect(ledger.assignToolRequest(tried)).toEqual({ ok: false, reason: "input_cancelled" });
  expect(ledger.getRun(tried.runId)).toEqual({ known: true, value: null });
  expect(runCount(ledger)).toBe(0);
  expect(ledger.readToolRequest({ owner: A, ref })).toMatchObject({ known: true, value: { phase: "waiting_assignment" } });
  expect(waiting(ledger).map((w) => w.ref)).toEqual([ref]);
  ledger.close();
  expect(rows(path, "SELECT COUNT(*) AS n FROM runs")).toEqual([{ n: 0 }]);
  expect(rows(path, `SELECT phase, run_id FROM tool_requests WHERE ref = '${ref}'`)).toEqual([{ phase: "waiting_assignment", run_id: null }]);
});

test("잇기는 장부 시계로 만료 시각 정각부터 input_expired다(넘긴 now가 아니다)", () => {
  const ledger = openAt(tempPath());
  enqueue(ledger, A, NOW + 100);
  enqueue(ledger, B, NOW + 100);
  const a = must(ledger.recordToolRequest(request(A))).request.ref;
  const b = must(ledger.recordToolRequest(request(B))).request.ref;
  // 만료 1ms 전은 잇는다.
  ledgerNow = NOW + 99;
  expect(must(ledger.assignToolRequest(assignment(a))).outcome).toBe("assigned");
  // 정각은 만료다. 넘긴 now가 만료 전이어도 장부 시계를 따른다.
  ledgerNow = NOW + 100;
  const tried = assignment(b, { now: NOW });
  expect(ledger.assignToolRequest(tried)).toEqual({ ok: false, reason: "input_expired" });
  expect(ledger.getRun(tried.runId)).toEqual({ known: true, value: null });
  expect(runCount(ledger)).toBe(1);
  expect(waiting(ledger).map((w) => w.ref)).toEqual([b]);
});

test("잇기의 입력 검사는 기존 거절과 already_assigned보다 뒤다", () => {
  const ledger = openAt(tempPath());
  enqueue(ledger, A);
  enqueue(ledger, B);
  const a = must(ledger.recordToolRequest(request(A))).request.ref;
  const first = must(ledger.assignToolRequest(assignment(a)));
  const notStarted = must(ledger.recordToolRequest(request(A, { dedupeKey: `start_worker:${A}:read`, purpose: "read" }))).request.ref;
  must(ledger.cancelToolRequest({ owner: A, ref: notStarted, sessionId: SESSION_ID, callId: id(), now: NOW }));
  const b = must(ledger.recordToolRequest(request(B))).request.ref;
  const existing = must(ledger.admitRun(worker())).run;
  must(ledger.cancelInput(A, NOW));
  must(ledger.cancelInput(B, NOW));

  // 이미 이어진 부탁은 입력이 취소돼도 이은 그 실행이다.
  expect(ledger.assignToolRequest(assignment(a))).toEqual({ ok: true, outcome: "already_assigned", run: first.run });
  // 취소된 부탁, 없는 참조, 이미 쓰인 실행 ID, 입력 오류는 지금 이름 그대로다.
  expect(ledger.assignToolRequest(assignment(notStarted))).toEqual({ ok: false, reason: "transition_denied" });
  expect(ledger.assignToolRequest(assignment(id()))).toEqual({ ok: false, reason: "unknown_run" });
  expect(ledger.assignToolRequest(assignment(b, { runId: existing.runId }))).toEqual({ ok: false, reason: "invariant_violation" });
  expect(() => ledger.assignToolRequest(assignment(b, { executorId: "executor/research/0/store-a" }))).toThrow();
  // 그 밖이면 입력 취소다.
  expect(ledger.assignToolRequest(assignment(b))).toEqual({ ok: false, reason: "input_cancelled" });
  expect(runCount(ledger)).toBe(2);
});

test("잇기와 startRun은 같은 입력 조건에서 같은 거절 이름을 낸다", () => {
  const ledger = openAt(tempPath());
  enqueue(ledger, A, NOW + 100);
  enqueue(ledger, B);
  const a = must(ledger.recordToolRequest(request(A))).request.ref;
  const b = must(ledger.recordToolRequest(request(B))).request.ref;
  // 이은 뒤에 조건이 생긴 실행은 startRun이, 아직 잇지 않은 부탁은 잇기가 같은 이름으로 거절한다.
  const runA = must(ledger.assignToolRequest(assignment(a))).run.runId;
  ledgerNow = NOW + 100;
  expect(ledger.startRun({ runId: runA, requestId: id(), stopGeneration: 0, now: NOW + 100 })).toEqual({ ok: false, reason: "input_expired" });
  must(ledger.cancelInput(B, NOW + 100));
  const runB = must(ledger.admitRun(worker({ inputRequestId: B }))).run.runId;
  expect(ledger.startRun({ runId: runB, requestId: id(), stopGeneration: 0, now: NOW + 100 })).toEqual({ ok: false, reason: "input_cancelled" });
  expect(ledger.assignToolRequest(assignment(b))).toEqual({ ok: false, reason: "input_cancelled" });
});
