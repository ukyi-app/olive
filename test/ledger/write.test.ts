import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Ledger, LedgerInputError, TRANSITIONS } from "../../src/ledger/index.ts";
import { digest, from, grant, id, must, NOW, open, ready, SESSION_EXECUTOR, session, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "./helpers.ts";

const W = { sender: WORKER_EXECUTOR, runGeneration: 1 };
const S = { sender: SESSION_EXECUTOR };

function receipt(runId: string, instructionRequestId: string, action: "receipt_started" | "receipt_cleaned", receiptId = id()) {
  return { action, receiptId, runId, instructionRequestId, bodyDigest: digest(`${action}:${receiptId}`), now: NOW };
}
function accepted(runId: string, instructionRequestId: string, instruction: "task_start" | "result_finalize" | "task_cancel" | "run_renew" | "session_start" | "session_stop" = "task_start", receiptId = id()) {
  return { action: "receipt_accepted" as const, receiptId, runId, instructionRequestId, instruction, bodyDigest: digest(`accepted:${receiptId}`), now: NOW };
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
  const path = tempPath();
  const ledger = ready(open(path));
  const ghost = id();
  expect(ledger.applyReceipt(accepted(ghost, id()), W)).toEqual({ ok: false, reason: "unknown_run" });
  expect(ledger.startRun({ runId: ghost, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "unknown_run" });
  // 실행 줄은 있지만 지시를 적지 않았으면(대기) 접수 영수증을 받지 않는다.
  const queued = must(ledger.admitRun(worker())).run;
  expect(ledger.applyReceipt(accepted(queued.runId, id()), W)).toEqual({ ok: false, reason: "unknown_instruction" });
  // 지시를 적은 뒤에만 그 지시를 가리키는 영수증을 받는다.
  const { runId, requestId } = startedWorker(ledger);
  expect(ledger.applyReceipt(accepted(runId, requestId), W)).toMatchObject({ ok: true, delivery: "new" });
  expect(ledger.getRun(runId)).toMatchObject({ value: { acceptedReceiptId: expect.any(String) } });
  ledger.close();
  // 코드를 지나쳐도 장부의 외래 키가 실행 줄 없는 지시·영수증을 막는다.
  const raw = new Database(path);
  raw.run("PRAGMA foreign_keys = ON");
  expect(() => raw.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, 'task_start', 0, 1)").run(id(), ghost)).toThrow("FOREIGN KEY");
  expect(() => raw.query("INSERT INTO deliveries (id, action, run_id, body_digest, received_at) VALUES (?, 'receipt_stopped', ?, ?, 1)").run(id(), ghost, digest("x"))).toThrow("FOREIGN KEY");
  raw.close();
});

test("쓰기: 같은 중복 키는 같은 실행", () => {
  const ledger = ready(open(tempPath()));
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
  expect(ledger.applyReceipt(started, W)).toMatchObject({ ok: true, delivery: "new", ack: started.receiptId });
  expect(ledger.applyReceipt(started, W)).toMatchObject({ ok: true, delivery: "duplicate", ack: started.receiptId });
  expect(state(ledger, runId)).toBe("running");
  expect(ledger.applyReceipt({ ...started, bodyDigest: digest("다른 본문") }, W)).toEqual({ ok: false, reason: "receipt_conflict" });
  expect(ledger.conflicts()).toEqual({ known: true, value: [{ id: started.receiptId, firstDigest: started.bodyDigest, otherDigest: digest("다른 본문") }] });
});

test("쓰기: 접수 영수증은 v1의 여섯 지시를 원래 이름과 함께 대조한다", () => {
  const ledger = open(tempPath());
  const { runId, requestId } = startedWorker(ledger);
  // 이름이 다른 접수는 받지 않는다.
  expect(ledger.applyReceipt(accepted(runId, requestId, "task_cancel"), W)).toEqual({ ok: false, reason: "unknown_instruction" });
  must(ledger.applyReceipt(accepted(runId, requestId, "task_start"), W));
  must(ledger.applyReceipt(receipt(runId, requestId, "receipt_started"), W));
  const renew = id();
  must(ledger.recordRenewInstruction({ runId, requestId: renew, stopGeneration: 0, now: NOW }));
  expect(ledger.applyReceipt(accepted(runId, renew, "run_renew"), W)).toMatchObject({ ok: true, delivery: "new" });
  const cancel = id();
  must(ledger.recordStopInstruction({ runId, requestId: cancel, action: "task_cancel", stopGeneration: 0, now: NOW }));
  expect(ledger.applyReceipt(accepted(runId, cancel, "task_cancel"), W)).toMatchObject({ ok: true });
  // 정지 중이면 갱신을 적지 않는다.
  must(ledger.applyStop({ generation: 1, stopped: true, now: NOW }));
  expect(ledger.recordRenewInstruction({ runId, requestId: id(), stopGeneration: 1, now: NOW })).toEqual({ ok: false, reason: "stopped" });
});

test("쓰기: 세션 시작·종료와 결과 확정 지시의 접수 영수증도 원래 이름으로 반영한다", () => {
  const ledger = ready(open(tempPath()));
  const run = must(ledger.admitRun(session())).run;
  const marker = digest("marker");
  const check = id();
  must(ledger.applyRuleCheck({ reportId: check, outcome: "rule_present", firstMarkerDigest: digest("m0"), restartedMarkerDigest: marker, startPermitId: id(), checkedAt: NOW, bodyDigest: digest("rc"), now: NOW }, S));
  const sessionStart = id();
  must(ledger.startSession({ runId: run.runId, requestId: sessionStart, stopGeneration: 0, now: NOW, sessionId: id(), generationMarkerDigest: marker, takeoverReceiptId: null, ruleCheckId: check, handoffRef: null, handoffDigest: null }));
  const sender = from(run);
  expect(ledger.applyReceipt(accepted(run.runId, sessionStart, "session_stop"), sender)).toEqual({ ok: false, reason: "unknown_instruction" });
  const startedReceipt = accepted(run.runId, sessionStart, "session_start");
  expect(ledger.applyReceipt(startedReceipt, sender)).toMatchObject({ ok: true, delivery: "new" });
  expect(ledger.getRun(run.runId)).toMatchObject({ value: { acceptedReceiptId: startedReceipt.receiptId } });
  const sessionStop = id();
  must(ledger.recordStopInstruction({ runId: run.runId, requestId: sessionStop, action: "session_stop", stopGeneration: 0, now: NOW }));
  expect(ledger.applyReceipt(accepted(run.runId, sessionStop, "session_stop"), sender)).toMatchObject({ ok: true, delivery: "new" });

  const { runId, requestId: taskStart } = startedWorker(ledger);
  must(ledger.applyReceipt(stopped(runId), W));
  must(ledger.markResult({ runId, resultDigest: digest("r"), now: NOW }));
  const finalize = id();
  must(ledger.recordFinalizeInstruction({ runId, requestId: finalize, stopGeneration: 0, now: NOW }));
  expect(ledger.applyReceipt(accepted(runId, taskStart, "result_finalize"), W)).toEqual({ ok: false, reason: "unknown_instruction" });
  const finalizeReceipt = accepted(runId, finalize, "result_finalize");
  expect(ledger.applyReceipt(finalizeReceipt, W)).toMatchObject({ ok: true, delivery: "new" });
  expect(ledger.getRun(runId)).toMatchObject({ value: { acceptedReceiptId: finalizeReceipt.receiptId } });
});

test("R13 영수증: 이미 받은 id의 다른 본문은 원 지시가 달라도 충돌로 남고, 다른 발신자는 충돌을 남기지 못한다", () => {
  const ledger = open(tempPath());
  const { runId, requestId } = startedWorker(ledger);
  const first = accepted(runId, requestId, "task_start");
  must(ledger.applyReceipt(first, W));
  const other = { ...first, instruction: "task_cancel" as const, bodyDigest: digest("원 지시 이름만 다른 본문") };
  expect(ledger.applyReceipt(other, { sender: "executor/diagnosis/1/store-b", runGeneration: 1 })).toEqual({ ok: false, reason: "sender_mismatch" });
  expect(ledger.applyReceipt(other, { ...W, runGeneration: 2 })).toEqual({ ok: false, reason: "run_generation_mismatch" });
  expect(ledger.conflicts()).toEqual({ known: true, value: [] });
  expect(ledger.applyReceipt(other, W)).toEqual({ ok: false, reason: "receipt_conflict" });
  expect(ledger.conflicts()).toEqual({ known: true, value: [{ id: first.receiptId, firstDigest: first.bodyDigest, otherDigest: other.bodyDigest }] });
  // 처음 받는 id는 원 지시와 맞아야 적힌다.
  expect(ledger.applyReceipt(accepted(runId, requestId, "task_cancel"), W)).toEqual({ ok: false, reason: "unknown_instruction" });
});

test("R15 증거: 영수증이 가리키는 지시와 쓴 허가는 저장 뒤 바뀌지 않고 rowid로도 교체되지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const { runId, requestId } = startedWorker(ledger);
  must(ledger.applyReceipt(accepted(runId, requestId), W));
  const run = must(ledger.admitRun(session())).run;
  const marker = digest("marker");
  const check = id();
  const permit = id();
  must(ledger.applyRuleCheck({ reportId: check, outcome: "rule_present", firstMarkerDigest: digest("m0"), restartedMarkerDigest: marker, startPermitId: permit, checkedAt: NOW, bodyDigest: digest("rc"), now: NOW }, S));
  must(ledger.startSession({ runId: run.runId, requestId: id(), stopGeneration: 0, now: NOW, sessionId: id(), generationMarkerDigest: marker, takeoverReceiptId: null, ruleCheckId: check, handoffRef: null, handoffDigest: null }));
  ledger.close();
  const raw = new Database(path);
  raw.run("PRAGMA foreign_keys = ON");
  for (const change of ["action = 'task_cancel'", `run_id = '${run.runId}'`, `request_id = '${id()}'`]) {
    expect(() => raw.query(`UPDATE instructions SET ${change} WHERE request_id = ?`).run(requestId), change).toThrow("instruction_fixed");
  }
  expect(() => raw.query("DELETE FROM instructions WHERE request_id = ?").run(requestId)).toThrow("instruction_fixed");
  expect(() => raw.query("INSERT OR REPLACE INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, 'task_cancel', 0, 1)").run(requestId, runId)).toThrow("instruction_fixed");
  for (const change of [`start_permit_id = '${id()}'`, `run_id = '${runId}'`]) {
    expect(() => raw.query(`UPDATE start_permit_uses SET ${change} WHERE start_permit_id = ?`).run(permit), change).toThrow("permit_used");
  }
  for (const table of ["instructions", "start_permit_uses", "deliveries", "runs", "session_takeovers", "rule_checks", "sessions"]) {
    expect(() => raw.query(`SELECT rowid FROM ${table}`).all(), table).toThrow("rowid");
  }
  raw.close();
});

test("R16 세션: 인계 참조는 저장소가 낸 불투명 ID만 받고 digest와 짝을 이룬다", () => {
  const ledger = ready(open(tempPath()));
  const run = must(ledger.admitRun(session())).run;
  const marker = digest("marker");
  const check = id();
  must(ledger.applyRuleCheck({ reportId: check, outcome: "rule_present", firstMarkerDigest: digest("m0"), restartedMarkerDigest: marker, startPermitId: id(), checkedAt: NOW, bodyDigest: digest("rc"), now: NOW }, S));
  const input = { runId: run.runId, requestId: id(), stopGeneration: 0, now: NOW, sessionId: id(), generationMarkerDigest: marker, takeoverReceiptId: null, ruleCheckId: check };
  for (const handoffRef of ["https://user:secret@store.example/handoff/1", "s3://bucket/handoff", "user:secret@host/x", "handoffs/not-a-uuid"]) {
    expect(() => ledger.startSession({ ...input, handoffRef, handoffDigest: digest("handoff") }), handoffRef).toThrow(LedgerInputError);
  }
  expect(() => ledger.startSession({ ...input, handoffRef: `handoffs/${id()}`, handoffDigest: null })).toThrow(LedgerInputError);
  expect(() => ledger.startSession({ ...input, handoffRef: null, handoffDigest: digest("handoff") })).toThrow(LedgerInputError);
  expect(ledger.getRun(run.runId)).toMatchObject({ value: { state: "queued" } });
  expect(ledger.startSession({ ...input, handoffRef: `handoffs/${id()}`, handoffDigest: digest("handoff") })).toMatchObject({ ok: true });
});

test("쓰기: 허용되지 않은 상태 전이는 거절(코드와 장부의 트리거 둘 다)", () => {
  const path = tempPath();
  const ledger = open(path);
  const { runId, requestId } = startedWorker(ledger);
  // running이 아닌데 결과 판정, finalize 지시 없이 정리 영수증
  expect(ledger.markResult({ runId, resultDigest: digest("r"), now: NOW })).toEqual({ ok: false, reason: "transition_denied" });
  expect(ledger.applyReceipt(receipt(runId, requestId, "receipt_cleaned"), W)).toEqual({ ok: false, reason: "unknown_instruction" });
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
  must(ledger.applyReceipt(receipt(runId, requestId, "receipt_started"), W));
  expect(ledger.markResult({ runId, resultDigest: digest("r"), now: NOW })).toEqual({ ok: false, reason: "transition_denied" });
  ledger.close();
  // 코드를 지나쳐 장부에 바로 써도 CHECK가 막는다.
  const raw = new Database(path);
  raw.run("PRAGMA foreign_keys = ON");
  expect(() => raw.query("UPDATE runs SET state = 'checking' WHERE run_id = ?").run(runId)).toThrow("CHECK constraint failed");
  raw.close();
  const again = ready(open(path));
  must(again.applyReceipt(stopped(runId), W));
  expect(state(again, runId)).toBe("checking");
  must(again.markResult({ runId, resultDigest: digest("r"), now: NOW }));
  expect(state(again, runId)).toBe("ready_result");
  const finalize = id();
  must(again.recordFinalizeInstruction({ runId, requestId: finalize, stopGeneration: 0, now: NOW }));
  must(again.applyReceipt(receipt(runId, finalize, "receipt_cleaned"), W));
  expect(state(again, runId)).toBe("finalized");
});

test("쓰기: 결과 쪽 상태의 증거는 같은 실행이 받은 맞는 종류의 영수증이어야 한다(장부의 트리거)", () => {
  const path = tempPath();
  const ledger = open(path);
  const a = startedWorker(ledger);
  const startedId = id();
  must(ledger.applyReceipt(receipt(a.runId, a.requestId, "receipt_started", startedId), W));
  // 다른 실행의 종료 영수증
  const b = must(ledger.admitRun(worker({ executorId: WORKER_EXECUTOR }))).run;
  const otherStop = id();
  ledger.close();
  const raw = new Database(path);
  raw.run("PRAGMA foreign_keys = ON");
  raw.query("INSERT INTO deliveries (id, action, run_id, body_digest, received_at) VALUES (?, 'receipt_stopped', ?, ?, 1)").run(otherStop, b.runId, digest("o"));
  const toChecking = raw.query("UPDATE runs SET state = 'checking', stop_receipt_id = ? WHERE run_id = ?");
  // CHECK(stop_receipt_id 있음)와 허용 전이(running → checking)를 모두 만족해도 증거 줄이 없거나, 종류가 다르거나, 다른 실행의 것이면 막는다.
  expect(() => toChecking.run(id(), a.runId)).toThrow("run_evidence_mismatch");
  expect(() => toChecking.run(startedId, a.runId)).toThrow("run_evidence_mismatch");
  expect(() => toChecking.run(otherStop, a.runId)).toThrow("run_evidence_mismatch");
  // 정리 영수증이 result_finalize가 아닌 지시를 가리키면 적히지 않는다.
  expect(() =>
    raw.query("INSERT INTO deliveries (id, action, run_id, instruction_request_id, body_digest, received_at) VALUES (?, 'receipt_cleaned', ?, ?, ?, 1)").run(id(), a.runId, a.requestId, digest("c")),
  ).toThrow("run_evidence_mismatch");
  // 실행 줄은 지우거나 바꿔 넣지 못한다.
  expect(() => raw.query("DELETE FROM runs WHERE run_id = ?").run(a.runId)).toThrow("runs_permanent");
  raw.close();
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
  must(ledger.applyReceipt(stopped(a.runId, "failed"), W));
  must(ledger.markCleanupPending({ runId: a.runId, now: NOW }));
  expect(state(ledger, a.runId)).toBe("cleanup_pending");
  expect(ledger.startRun({ runId: b.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "slot_busy" });
  // 정리 영수증으로 끝나면 자리가 난다. 세션 슬롯은 따로다.
  const finalize = id();
  must(ledger.recordFinalizeInstruction({ runId: a.runId, requestId: finalize, stopGeneration: 0, now: NOW }));
  must(ledger.applyReceipt(receipt(a.runId, finalize, "receipt_cleaned"), W));
  expect(ledger.startRun({ runId: b.runId, requestId: id(), stopGeneration: 0, now: NOW })).toMatchObject({ ok: true });
});

test("슬롯: 코드의 확인을 지나쳐도 부분 유일 인덱스가 둘째 점유를 막는다", () => {
  const path = tempPath();
  const ledger = open(path);
  startedWorker(ledger);
  const b = must(ledger.admitRun(worker())).run;
  ledger.close();
  const raw = new Database(path);
  expect(() => raw.query("UPDATE runs SET state = 'preparing' WHERE run_id = ?").run(b.runId)).toThrow("UNIQUE constraint failed: runs.kind");
  raw.close();
});

test("시작: v1 task_start로 만들 수 없는 작업자는 자리를 잡지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const noInput = must(ledger.admitRun(worker({ inputDigest: null }))).run;
  const noBudget = must(ledger.admitRun(worker({ budgetLeft: 0 }))).run;
  for (const run of [noInput, noBudget]) {
    expect(ledger.startRun({ runId: run.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "not_startable" });
    expect(state(ledger, run.runId)).toBe("queued");
  }
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: true });
  // 역할과 실행기의 역할이 다르거나, 세션 실행기에 작업자를 맡기는 줄은 들어오지 않는다.
  expect(() => ledger.admitRun(worker({ executorId: "executor/pr_review/0/store-a" }))).toThrow(LedgerInputError);
  expect(() => ledger.admitRun(worker({ executorId: SESSION_EXECUTOR }))).toThrow(LedgerInputError);
  expect(() => ledger.admitRun(session({ executorId: WORKER_EXECUTOR }))).toThrow(LedgerInputError);
  ledger.close();
  const raw = new Database(path);
  expect(raw.query("SELECT COUNT(*) AS n FROM instructions").get()).toEqual({ n: 0 });
  raw.close();
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

test("정지: 저장 제약은 보통 INSERT·UPSERT·REPLACE·DELETE 모두에서 낮은 세대와 행 부재를 막는다", () => {
  const path = tempPath();
  const ledger = open(path);
  must(ledger.applyStop({ generation: 5, stopped: true, now: NOW }));
  ledger.close();
  const raw = new Database(path);
  expect(() => raw.run("INSERT INTO stop_state (id, generation, stopped, phase, updated_at) VALUES (1, 6, 0, 'none', 1)")).toThrow("UNIQUE constraint failed");
  expect(() => raw.run("INSERT INTO stop_state (id, generation, stopped, phase, updated_at) VALUES (1, 4, 0, 'none', 1) ON CONFLICT (id) DO UPDATE SET generation = excluded.generation")).toThrow("stop_generation_lower");
  expect(() => raw.run("INSERT OR REPLACE INTO stop_state (id, generation, stopped, phase, updated_at) VALUES (1, 4, 0, 'none', 1)")).toThrow("stop_generation_lower");
  expect(() => raw.run("DELETE FROM stop_state")).toThrow("stop_state_permanent");
  expect(() => raw.run("INSERT OR REPLACE INTO run_epoch (id, generation) VALUES (1, 1)")).not.toThrow();
  raw.run("UPDATE run_epoch SET generation = 3");
  expect(() => raw.run("INSERT OR REPLACE INTO run_epoch (id, generation) VALUES (1, 2)")).toThrow("run_epoch_lower");
  expect(() => raw.run("DELETE FROM run_epoch")).toThrow("run_epoch_permanent");
  // 같은 세대 이상의 교체는 막지 않는다(정상 UPSERT와 같은 결과).
  expect(() => raw.run("INSERT OR REPLACE INTO stop_state (id, generation, stopped, phase, updated_at) VALUES (1, 5, 1, 'none', 1)")).not.toThrow();
  expect(raw.query("SELECT generation, stopped FROM stop_state").get()).toEqual({ generation: 5, stopped: 1 });
  raw.close();
});

test("정지: 트리거가 없어도 코드가 낮은 세대를 막는다(두 겹이 각각 동작한다)", () => {
  const path = tempPath();
  const ledger = open(path);
  must(ledger.applyStop({ generation: 5, stopped: true, now: NOW }));
  ledger.close();
  const raw = new Database(path);
  raw.run("DROP TRIGGER stop_generation_monotonic");
  raw.run("DROP TRIGGER stop_generation_monotonic_insert");
  raw.close();
  const again = open(path);
  expect(again.applyStop({ generation: 4, stopped: false, now: NOW })).toEqual({ ok: false, reason: "stop_generation_lower" });
  expect(again.mergeStop({ generation: 4, stopped: false }, NOW)).toMatchObject({ ok: true, source: "ledger", record: { generation: 5, stopped: true } });
  expect(again.readStop()).toMatchObject({ value: { generation: 5, stopped: true } });
});

test("열기: 장부의 연결은 외래 키를 켠 채 쓴다", () => {
  let conn: Database | undefined;
  const ledger = open(tempPath(), { faults: { at() {}, onOpen: (db) => (conn = db) } });
  expect(ledger.health()).toEqual({ writable: true });
  const db = conn as Database;
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(() => db.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, 'task_start', 0, 1)").run(id(), id())).toThrow("FOREIGN KEY");
});

test("정지: 같은 세대의 정지는 합치기로 풀리지 않고, 풀기는 별도 연산이며 접수를 다시 닫는다", () => {
  const ledger = ready(open(tempPath()));
  must(ledger.applyStop({ generation: 2, stopped: true, now: NOW }));
  expect(ledger.applyStop({ generation: 2, stopped: false, now: NOW })).toMatchObject({ ok: true, record: { generation: 2, stopped: true } });
  expect(ledger.releaseStop({ generation: 1, now: NOW })).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(ledger.releaseStop({ generation: 2, now: NOW })).toMatchObject({ ok: true, record: { generation: 2, stopped: false } });
  expect(ledger.intakeOpen()).toBe(false);
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "intake_closed" });
});

test("정지: 같은 정지 기록을 다시 받아도 확인 단계가 남는다", () => {
  const path = tempPath();
  const ledger = open(path);
  must(ledger.applyStop({ generation: 4, stopped: true, phase: "node_verified", now: NOW }));
  expect(ledger.applyStop({ generation: 4, stopped: true, now: NOW })).toMatchObject({ ok: true, record: { phase: "node_verified" } });
  ledger.close();
  const again = open(path);
  expect(again.readStop()).toMatchObject({ value: { generation: 4, phase: "node_verified" } });
  // 새 세대는 단계를 생략하면 none에서 시작한다.
  expect(again.applyStop({ generation: 5, stopped: true, now: NOW })).toMatchObject({ ok: true, record: { phase: "none" } });
});

test("정지: 재시작 뒤에도 정지 상태가 남고 새 실행을 주지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const queued = must(ledger.admitRun(worker())).run;
  must(ledger.applyStop({ generation: 3, stopped: true, now: NOW }));
  ledger.close();
  const again = ready(open(path));
  expect(again.readStop()).toMatchObject({ known: true, value: { generation: 3, stopped: true } });
  expect(again.startRun({ runId: queued.runId, requestId: id(), stopGeneration: 3, now: NOW })).toEqual({ ok: false, reason: "stopped" });
});

test("정지: 정지 기록을 모르거나 세대가 다르면 새 실행을 주지 않는다", () => {
  const ledger = ready(open(tempPath()));
  const queued = must(ledger.admitRun(worker())).run;
  must(ledger.applyStop({ generation: 2, stopped: false, now: NOW }));
  // 세대가 바뀌면 앞 허가는 끝난다. 새 세대의 허가로 지시의 옛 세대를 대조한다.
  expect(ledger.startRun({ runId: queued.runId, requestId: id(), stopGeneration: 2, now: NOW })).toEqual({ ok: false, reason: "intake_closed" });
  grant(ledger);
  expect(ledger.startRun({ runId: queued.runId, requestId: id(), stopGeneration: 1, now: NOW })).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  const fresh = open(tempPath());
  expect(grant(fresh)).toBe(false);
  expect(fresh.admitRun(worker())).toEqual({ ok: false, reason: "stop_unknown" });
});

test("정지: 종료·확정 지시에 장부와 다른 정지 세대를 적지 않는다", () => {
  const ledger = open(tempPath());
  const { runId } = startedWorker(ledger);
  must(ledger.applyStop({ generation: 3, stopped: true, now: NOW }));
  expect(ledger.recordStopInstruction({ runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(ledger.recordStopInstruction({ runId, requestId: id(), action: "task_cancel", stopGeneration: 3, now: NOW })).toMatchObject({ ok: true, run: { state: "stopping" } });
  must(ledger.applyReceipt(stopped(runId, "failed"), W));
  expect(ledger.recordFinalizeInstruction({ runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "stop_generation_mismatch" });
  expect(ledger.recordFinalizeInstruction({ runId, requestId: id(), stopGeneration: 3, now: NOW })).toEqual({ ok: true });
});

test("쓰기: 예산은 늘지 않는다", () => {
  const ledger = open(tempPath());
  const { runId } = startedWorker(ledger);
  must(ledger.recordBudget({ runId, budgetLeft: 10_000, now: NOW }));
  expect(ledger.recordBudget({ runId, budgetLeft: 20_000, now: NOW })).toEqual({ ok: false, reason: "budget_grows" });
});

test("쓰기: 장부의 정수는 안전 정수다(쓰기 함수와 STRICT 열)", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  expect(() => ledger.applyStop({ generation: 2 ** 53, stopped: true, now: NOW })).toThrow(LedgerInputError);
  expect(() => ledger.admitRun(worker({ budgetLeft: 2 ** 53 }))).toThrow(LedgerInputError);
  ledger.close();
  const raw = new Database(path);
  expect(() => raw.run("UPDATE stop_state SET generation = 9007199254740992")).toThrow("CHECK constraint failed");
  expect(() => raw.run("UPDATE run_epoch SET generation = 9007199254740993")).toThrow("CHECK constraint failed");
  raw.close();
});

test("세션: 규칙 확인과 확정된 인수를 대조하고 시작 허가는 한 번만 쓴다", () => {
  const ledger = ready(open(tempPath()));
  const marker1 = digest("marker-1");
  const permit1 = id();
  const check1 = id();
  must(ledger.applyRuleCheck({ reportId: check1, outcome: "rule_present", firstMarkerDigest: digest("m0"), restartedMarkerDigest: marker1, startPermitId: permit1, checkedAt: NOW, bodyDigest: digest("rc1"), now: NOW }, S));
  const s1 = must(ledger.admitRun(session())).run;
  const base = { stopGeneration: 0, now: NOW, handoffRef: null, handoffDigest: null };
  expect(ledger.startSession({ ...base, runId: s1.runId, requestId: id(), sessionId: id(), generationMarkerDigest: digest("other"), takeoverReceiptId: null, ruleCheckId: check1 })).toEqual({ ok: false, reason: "reference_mismatch" });
  must(ledger.startSession({ ...base, runId: s1.runId, requestId: id(), sessionId: id(), generationMarkerDigest: marker1, takeoverReceiptId: null, ruleCheckId: check1 }));
  const s2 = must(ledger.admitRun(session())).run;
  must(ledger.recordStopInstruction({ runId: s1.runId, requestId: id(), action: "session_stop", stopGeneration: 0, now: NOW }));
  // 새 세대: 인수 영수증이 규칙 확인보다 먼저 와도 인수 대기로 두고 앞 세션의 자리를 쥔다.
  const marker2 = digest("marker-2");
  const permit2 = id();
  const takeover = { action: "receipt_session_takeover" as const, receiptId: id(), previousRunId: s1.runId, newGenerationMarkerDigest: marker2, startPermitId: permit2, takenOverAt: NOW, bodyDigest: digest("tk"), now: NOW };
  must(ledger.applyReceipt(takeover, from(s1)));
  expect(state(ledger, s1.runId)).toBe("stopping");
  expect(ledger.slotFree("session")).toEqual({ known: true, value: false });
  // 확정되지 않은 인수로는 다음 세션을 열지 않는다.
  const check2 = id();
  // 규칙 확인이 오면 같은 표식·허가의 인수를 확정하고 앞 세션을 끝낸다.
  must(ledger.applyRuleCheck({ reportId: check2, outcome: "rule_present", firstMarkerDigest: digest("m1"), restartedMarkerDigest: marker2, startPermitId: permit2, checkedAt: NOW, bodyDigest: digest("rc2"), now: NOW }, S));
  expect(state(ledger, s1.runId)).toBe("finalized");
  // 앞 세션의 허가(이미 쓴 것)로는 열지 않는다.
  expect(ledger.startSession({ ...base, runId: s2.runId, requestId: id(), sessionId: id(), generationMarkerDigest: marker1, takeoverReceiptId: takeover.receiptId, ruleCheckId: check1 })).toEqual({ ok: false, reason: "reference_mismatch" });
  // 앞 세션이 있었으면 인수 영수증 없이 열지 않는다.
  expect(ledger.startSession({ ...base, runId: s2.runId, requestId: id(), sessionId: id(), generationMarkerDigest: marker2, takeoverReceiptId: null, ruleCheckId: check2 })).toEqual({ ok: false, reason: "reference_mismatch" });
  must(ledger.startSession({ ...base, runId: s2.runId, requestId: id(), sessionId: id(), generationMarkerDigest: marker2, takeoverReceiptId: takeover.receiptId, ruleCheckId: check2 }));
  // 같은 인수·허가로 세 번째 세션을 열지 않는다.
  const s3 = must(ledger.admitRun(session())).run;
  must(ledger.recordStopInstruction({ runId: s2.runId, requestId: id(), action: "session_stop", stopGeneration: 0, now: NOW }));
  expect(ledger.startSession({ ...base, runId: s3.runId, requestId: id(), sessionId: id(), generationMarkerDigest: marker2, takeoverReceiptId: takeover.receiptId, ruleCheckId: check2 })).toEqual({ ok: false, reason: "reference_mismatch" });
  // 이미 쓴 허가를 실은 인수 영수증은 받지 않는다.
  const reused = { ...takeover, receiptId: id(), previousRunId: s2.runId, newGenerationMarkerDigest: digest("marker-3"), bodyDigest: digest("tk3") };
  expect(ledger.applyReceipt(reused, from(s2))).toEqual({ ok: false, reason: "permit_used" });
  expect(state(ledger, s2.runId)).toBe("stopping");
});

test("넣지 않는 것: 쓰기 함수는 원문·자격 값 칸과 원문 꼴의 값을 받지 않는다", () => {
  const ledger = ready(open(tempPath()));
  const credential = { account: "acct-a", method: "subscription", revision: "r1", digest: digest("x") };
  expect(() => ledger.admitRun({ ...worker(), prompt: "디스크가 찼어요. 고쳐 줘" } as never)).toThrow(LedgerInputError);
  expect(() => ledger.admitRun(worker({ credential: { ...credential, value: "sk-live-123" } as never }))).toThrow(LedgerInputError);
  expect(() => ledger.admitRun(worker({ credential: { ...credential, digest: "sk-ant-api03-abcdef" } }))).toThrow(LedgerInputError);
  expect(() => ledger.enqueueInput({ requestId: id(), source: "discord", sourceRef: { ref: "로그 전체:\nerror at line 3", expiresAt: NOW }, receivedAt: NOW })).toThrow(LedgerInputError);
  expect(ledger.listRuns()).toEqual({ known: true, value: [] });
});

test("넣지 않는 것: 유효한 결과 보고에 summary 칸 하나만 더해도 그 칸을 지목해 거절한다", () => {
  const ledger = open(tempPath());
  const { runId } = startedWorker(ledger);
  const report = { reportId: id(), action: "report_result" as const, runId, bodyDigest: digest("x"), storedRef: `results/${id()}`, resultDigest: digest("r"), now: NOW };
  expect(() => ledger.recordReport({ ...report, summary: "모델 출력" } as never, W)).toThrow("받지 않는 칸 summary");
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  expect(ledger.recordReport(report, W)).toMatchObject({ ok: true, delivery: "new" });
});

test("넣지 않는 것: 허용 칸에 자격·원문 꼴의 값이 들어오면 거절한다", () => {
  const ledger = ready(open(tempPath()));
  const credential = { account: "acct-a", method: "subscription", revision: "r1", digest: digest("x") };
  // 실제 자격 값은 계약의 별칭 상한(32자)보다 길다.
  for (const bad of [{ account: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }, { account: "admin@example.com" }, { account: "ACCT" }, { method: "oauth" }, { method: "sk-live-123" }]) {
    expect(() => ledger.admitRun(worker({ credential: { ...credential, ...bad } })), JSON.stringify(bad)).toThrow(LedgerInputError);
  }
  for (const ref of ["inputs/1", "고쳐줘", "fix-the-disk-now", "inputs/please-fix-disk", "Inputs/0b0e6c3c-6a63-4d1d-9a8e-111111111111"]) {
    expect(() => ledger.enqueueInput({ requestId: id(), source: "discord", sourceRef: { ref, expiresAt: NOW + 1 }, receivedAt: NOW }), ref).toThrow(LedgerInputError);
  }
  expect(ledger.enqueueInput({ requestId: id(), source: "discord", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 1 }, receivedAt: NOW })).toMatchObject({ ok: true });
  expect(() => ledger.admitRun(worker({ executorId: "someone@example.com" }))).toThrow(LedgerInputError);
});
