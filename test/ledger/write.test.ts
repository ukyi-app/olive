import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Ledger, LedgerInputError, TRANSITIONS } from "../../src/ledger/index.ts";
import { digest, id, must, NOW, open, session, startedWorker, tempPath, worker } from "./helpers.ts";

function receipt(runId: string, instructionRequestId: string, action: "receipt_accepted" | "receipt_started" | "receipt_cleaned", receiptId = id()) {
  return { action, receiptId, runId, instructionRequestId, bodyDigest: digest(`${action}:${receiptId}`), now: NOW };
}
function stopped(runId: string, exit: "completed" | "failed" = "completed", receiptId = id()) {
  return { action: "receipt_stopped" as const, receiptId, runId, exit, bodyDigest: digest(`stopped:${receiptId}`), now: NOW };
}
function state(ledger: Ledger, runId: string) {
  const read = ledger.getRun(runId);
  if (!read.known || read.value === null) throw new Error("실행 없음");
  return read.value.state;
}

test("쓰기: 실행 줄이 접수 영수증보다 먼저 남는다(줄 없는 영수증·지시는 적히지 않는다)", () => {
  const ledger = open(tempPath());
  ledger.applyStop({ generation: 0, stopped: false, now: NOW });
  const ghost = id();
  expect(ledger.applyReceipt(receipt(ghost, id(), "receipt_accepted"))).toEqual({ ok: false, reason: "unknown_run" });
  expect(ledger.startRun({ runId: ghost, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "unknown_run" });
  // 실행 줄은 있지만 지시를 적지 않았으면(대기) 접수 영수증을 받지 않는다.
  const queued = must(ledger.admitRun(worker())).run;
  expect(ledger.applyReceipt(receipt(queued.runId, id(), "receipt_accepted"))).toEqual({ ok: false, reason: "unknown_instruction" });
  // 지시를 적은 뒤에만 그 지시를 가리키는 영수증을 받는다.
  const { runId, requestId } = startedWorker(ledger);
  expect(ledger.applyReceipt(receipt(runId, requestId, "receipt_accepted"))).toMatchObject({ ok: true, delivery: "new" });
  expect(ledger.listRuns()).toMatchObject({ known: true });
});

test("쓰기: 같은 중복 키는 같은 실행", () => {
  const ledger = open(tempPath());
  const first = must(ledger.admitRun(worker({ dedupeKey: "start_worker:abc" })));
  const again = must(ledger.admitRun(worker({ dedupeKey: "start_worker:abc" })));
  expect(first.created).toBe(true);
  expect(again).toMatchObject({ created: false, run: { runId: first.run.runId } });
  expect((ledger.listRuns() as { value: unknown[] }).value).toHaveLength(1);
});

test("쓰기: 같은 영수증 두 번은 한 번만 반영, 같은 id에 다른 digest는 충돌", () => {
  const ledger = open(tempPath());
  const { runId, requestId } = startedWorker(ledger);
  const started = receipt(runId, requestId, "receipt_started");
  expect(ledger.applyReceipt(started)).toMatchObject({ ok: true, delivery: "new", ack: started.receiptId });
  expect(ledger.applyReceipt(started)).toMatchObject({ ok: true, delivery: "duplicate", ack: started.receiptId });
  expect(state(ledger, runId)).toBe("running");
  expect(ledger.applyReceipt({ ...started, bodyDigest: digest("다른 본문") })).toEqual({ ok: false, reason: "receipt_conflict" });
  expect(ledger.conflicts()).toEqual({ known: true, value: [{ id: started.receiptId, firstDigest: started.bodyDigest, otherDigest: digest("다른 본문") }] });
});

test("쓰기: 허용되지 않은 상태 전이는 거절(코드와 장부의 트리거 둘 다)", () => {
  const path = tempPath();
  const ledger = open(path);
  const { runId, requestId } = startedWorker(ledger);
  // running이 아닌데 결과 판정, finalize 지시 없이 정리 영수증
  expect(ledger.markResult({ runId, resultDigest: digest("r"), now: NOW })).toEqual({ ok: false, reason: "transition_denied" });
  expect(ledger.applyReceipt(receipt(runId, requestId, "receipt_cleaned"))).toEqual({ ok: false, reason: "unknown_instruction" });
  expect(ledger.markCleanupPending({ runId, now: NOW })).toEqual({ ok: false, reason: "transition_denied" });
  expect(state(ledger, runId)).toBe("preparing");
  ledger.close();
  const raw = new Database(path);
  expect(() => raw.query("UPDATE runs SET state = 'finalized' WHERE run_id = ?").run(runId)).toThrow("run_transition_denied");
  raw.close();
});

test("쓰기: 코드의 전이 표와 장부의 run_transitions가 같다", () => {
  const path = tempPath();
  open(path).close();
  const raw = new Database(path);
  const rows = raw.query("SELECT kind, from_state, to_state FROM run_transitions ORDER BY kind, from_state, to_state").all();
  raw.close();
  const code = Object.entries(TRANSITIONS)
    .flatMap(([kind, table]) => Object.entries(table).flatMap(([from, tos]) => (tos ?? []).map((to) => ({ kind, from_state: from, to_state: to }))))
    .sort((a, b) => `${a.kind} ${a.from_state} ${a.to_state}`.localeCompare(`${b.kind} ${b.from_state} ${b.to_state}`));
  expect(rows).toEqual(code);
});

test("쓰기: 종료 확인 없이 ready_result가 되지 않는다", () => {
  const path = tempPath();
  const ledger = open(path);
  const { runId, requestId } = startedWorker(ledger);
  must(ledger.applyReceipt(receipt(runId, requestId, "receipt_started")));
  expect(ledger.markResult({ runId, resultDigest: digest("r"), now: NOW })).toEqual({ ok: false, reason: "transition_denied" });
  ledger.close();
  // 코드를 지나쳐 장부에 바로 써도 CHECK가 막는다.
  const raw = new Database(path);
  raw.run("PRAGMA foreign_keys = ON");
  expect(() => raw.query("UPDATE runs SET state = 'checking' WHERE run_id = ?").run(runId)).toThrow("CHECK constraint failed");
  raw.close();
  const again = open(path);
  must(again.applyReceipt(stopped(runId)));
  expect(state(again, runId)).toBe("checking");
  must(again.markResult({ runId, resultDigest: digest("r"), now: NOW }));
  expect(state(again, runId)).toBe("ready_result");
  const finalize = id();
  must(again.recordFinalizeInstruction({ runId, requestId: finalize, stopGeneration: 0, now: NOW }));
  must(again.applyReceipt(receipt(runId, finalize, "receipt_cleaned")));
  expect(state(again, runId)).toBe("finalized");
});

test("슬롯: unknown_running·cleanup_pending인 실행이 있으면 새 실행의 자리를 주지 않는다", () => {
  const ledger = open(tempPath());
  const a = startedWorker(ledger);
  must(ledger.markLost(NOW));
  expect(state(ledger, a.runId)).toBe("unknown_running");
  const b = must(ledger.admitRun(worker())).run;
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  expect(ledger.startRun({ runId: b.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "slot_busy" });
  // 종료 확인 → 결과 실패 → 정리 대기: 여전히 자리를 쥔다.
  must(ledger.applyReceipt(stopped(a.runId, "failed")));
  must(ledger.markCleanupPending({ runId: a.runId, now: NOW }));
  expect(state(ledger, a.runId)).toBe("cleanup_pending");
  expect(ledger.startRun({ runId: b.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "slot_busy" });
  // 정리 영수증으로 끝나면 자리가 난다. 세션 슬롯은 따로다.
  const finalize = id();
  must(ledger.recordFinalizeInstruction({ runId: a.runId, requestId: finalize, stopGeneration: 0, now: NOW }));
  must(ledger.applyReceipt(receipt(a.runId, finalize, "receipt_cleaned")));
  expect(ledger.startRun({ runId: b.runId, requestId: id(), stopGeneration: 0, now: NOW })).toMatchObject({ ok: true });
});

test("정지: 0도 적는다, 더 낮은 세대로 덮지 않는다(코드와 트리거)", () => {
  const path = tempPath();
  const ledger = open(path);
  expect(ledger.readStop()).toEqual({ known: true, value: null });
  expect(ledger.applyStop({ generation: 0, stopped: false, now: NOW })).toMatchObject({ ok: true, record: { generation: 0, stopped: false } });
  expect(ledger.readStop()).toMatchObject({ known: true, value: { generation: 0 } });
  must(ledger.applyStop({ generation: 5, stopped: true, now: NOW }));
  expect(ledger.applyStop({ generation: 4, stopped: false, now: NOW })).toEqual({ ok: false, reason: "stop_generation_lower" });
  expect(ledger.readStop()).toMatchObject({ value: { generation: 5, stopped: true } });
  ledger.close();
  const raw = new Database(path);
  expect(() => raw.run("UPDATE stop_state SET generation = 1")).toThrow("stop_generation_lower");
  raw.close();
});

test("정지: 재시작 뒤에도 정지 상태가 남고 새 실행을 주지 않는다", () => {
  const path = tempPath();
  const ledger = open(path);
  const queued = must(ledger.admitRun(worker())).run;
  must(ledger.applyStop({ generation: 3, stopped: true, now: NOW }));
  ledger.close();
  const again = open(path);
  expect(again.readStop()).toMatchObject({ known: true, value: { generation: 3, stopped: true } });
  expect(again.startRun({ runId: queued.runId, requestId: id(), stopGeneration: 3, now: NOW })).toEqual({ ok: false, reason: "stopped" });
});

test("정지: 정지 기록을 모르거나 세대가 다르면 새 실행을 주지 않는다", () => {
  const ledger = open(tempPath());
  const queued = must(ledger.admitRun(worker())).run;
  expect(ledger.startRun({ runId: queued.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "stop_unknown" });
  must(ledger.applyStop({ generation: 2, stopped: false, now: NOW }));
  expect(ledger.startRun({ runId: queued.runId, requestId: id(), stopGeneration: 1, now: NOW })).toEqual({ ok: false, reason: "stop_generation_mismatch" });
});

test("쓰기: 예산은 늘지 않는다", () => {
  const ledger = open(tempPath());
  const { runId } = startedWorker(ledger);
  must(ledger.recordBudget({ runId, budgetLeft: 10_000, now: NOW }));
  expect(ledger.recordBudget({ runId, budgetLeft: 20_000, now: NOW })).toEqual({ ok: false, reason: "budget_grows" });
});

test("세션: 규칙 확인과 인수 영수증을 대조하고 시작 허가는 한 번만 쓴다", () => {
  const ledger = open(tempPath());
  ledger.applyStop({ generation: 0, stopped: false, now: NOW });
  const marker1 = digest("marker-1");
  const permit1 = id();
  const check1 = id();
  must(ledger.applyRuleCheck({ reportId: check1, outcome: "rule_present", firstMarkerDigest: digest("m0"), restartedMarkerDigest: marker1, startPermitId: permit1, checkedAt: NOW, bodyDigest: digest("rc1"), now: NOW }));
  const s1 = must(ledger.admitRun(session())).run;
  const base = { stopGeneration: 0, now: NOW, handoffRef: null, handoffDigest: null };
  expect(ledger.startSession({ ...base, runId: s1.runId, requestId: id(), sessionId: id(), generationMarkerDigest: digest("other"), takeoverReceiptId: null, ruleCheckId: check1 })).toEqual({ ok: false, reason: "reference_mismatch" });
  must(ledger.startSession({ ...base, runId: s1.runId, requestId: id(), sessionId: id(), generationMarkerDigest: marker1, takeoverReceiptId: null, ruleCheckId: check1 }));
  // 같은 허가를 두 번째 세션이 쓰지 못한다.
  const s2 = must(ledger.admitRun(session())).run;
  const stopReq = id();
  must(ledger.recordStopInstruction({ runId: s1.runId, requestId: stopReq, action: "session_stop", stopGeneration: 0, now: NOW }));
  const takeover = { action: "receipt_session_takeover" as const, receiptId: id(), previousRunId: s1.runId, newGenerationMarkerDigest: marker1, startPermitId: permit1, takenOverAt: NOW, bodyDigest: digest("tk"), now: NOW };
  must(ledger.applyReceipt(takeover));
  expect(state(ledger, s1.runId)).toBe("finalized");
  expect(ledger.startSession({ ...base, runId: s2.runId, requestId: id(), sessionId: id(), generationMarkerDigest: marker1, takeoverReceiptId: takeover.receiptId, ruleCheckId: check1 })).toEqual({ ok: false, reason: "permit_used" });
  // 앞 세션이 있었으면 인수 영수증 없이 열지 않는다.
  expect(ledger.startSession({ ...base, runId: s2.runId, requestId: id(), sessionId: id(), generationMarkerDigest: marker1, takeoverReceiptId: null, ruleCheckId: check1 })).toEqual({ ok: false, reason: "reference_mismatch" });
});

test("넣지 않는 것: 쓰기 함수는 원문·자격 값 칸과 원문 꼴의 값을 받지 않는다", () => {
  const ledger = open(tempPath());
  expect(() => ledger.admitRun({ ...worker(), prompt: "디스크가 찼어요. 고쳐 줘" } as never)).toThrow(LedgerInputError);
  expect(() => ledger.admitRun(worker({ credential: { account: "a", method: "m", revision: "r1", digest: digest("x"), value: "sk-live-123" } as never }))).toThrow(LedgerInputError);
  expect(() => ledger.admitRun(worker({ credential: { account: "a", method: "m", revision: "r1", digest: "sk-ant-api03-abcdef" } }))).toThrow(LedgerInputError);
  expect(() => ledger.enqueueInput({ requestId: id(), source: "discord", sourceRef: { ref: "로그 전체:\nerror at line 3", expiresAt: NOW }, receivedAt: NOW })).toThrow(LedgerInputError);
  expect(() => ledger.recordReport({ reportId: id(), action: "report_result", runId: id(), bodyDigest: digest("x"), now: NOW, summary: "모델 출력" } as never)).toThrow(LedgerInputError);
  expect(ledger.listRuns()).toEqual({ known: true, value: [] });
});
