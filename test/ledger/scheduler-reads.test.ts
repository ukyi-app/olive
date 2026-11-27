// 스케줄러의 판단(planNext·nextIntent)이 쓰는 장부 읽기. 실제 장부 파일에 적고, 닫았다 다시 연 뒤 공개 읽기만으로 판단의 입력을 조립한다.
// 조립은 이 시험 안의 도우미다. 출처 이름을 관리자·경보로 나누는 표(ORIGIN_OF)는 접수 정책의 대역이고 장부는 이름만 낸다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { limits } from "../../src/contract/v1/index.ts";
import { type Ledger, LEDGER_RUN_STATES, type LedgerRunState, loadMigrations, type OpenResult, openLedger, TRANSITIONS } from "../../src/ledger/index.ts";
import { type LifecyclePolicy, type LifecycleView, nextIntent } from "../../src/supervisor/scheduler/lifecycle.ts";
import { type Origin, planNext, type SchedulerInput, type SchedulerPolicy, type SchedulerRun, type SchedulerView } from "../../src/supervisor/scheduler/queue.ts";
import { clock, digest, id, must, NOW, open, ready, SESSION_EXECUTOR, session, tempPath, WORKER_EXECUTOR, worker } from "./helpers.ts";

// 숫자는 이 시험이 고른 값이다. 운영값이 아니다.
const POLICY: SchedulerPolicy = { alertMaxWaitMs: 60_000, requestBudget: { admin: 1_000_000, alert: 1_000_000 } };
const LIFE: LifecyclePolicy = { renewEveryMs: 10_000, answerTimeoutMs: 30_000 };
const ORIGIN_OF: Record<string, Origin> = { "admin-dm": "admin", alertmanager: "alert" };

function enqueue(ledger: Ledger, source: string, receivedAt: number): string {
  const requestId = id();
  must(ledger.enqueueInput({ requestId, source, sourceRef: { ref: `inbox/${id()}`, expiresAt: NOW + 3_600_000 }, receivedAt }));
  return requestId;
}

// planNext의 입력을 공개 읽기 넷(queueView·listRuns·slotHolds·listInputs)으로만 만든다. 하나라도 읽지 못하면 판단을 부르지 않는다.
function assemble(ledger: Ledger, now: number): SchedulerView {
  const queue = ledger.queueView();
  const all = ledger.listRuns();
  const holds = ledger.slotHolds();
  const inputs = ledger.listInputs();
  if (!queue.known || !all.known || !holds.known || !inputs.known) throw new Error("장부를 읽지 못함");
  const bars = new Map(queue.value.runs.map((r) => [r.runId, r.startBar]));
  const runs: SchedulerRun[] = all.value.map((r) => {
    // 대기 실행의 시작 불가 사유는 queueView만 준다. 빠졌으면 null로 채우지 않는다.
    if (r.state === "queued" && !bars.has(r.runId)) throw new Error("대기 실행의 startBar가 없다");
    return { ...r, startBar: bars.get(r.runId) ?? null };
  });
  const known: SchedulerInput[] = inputs.value.flatMap((i) => {
    const origin = ORIGIN_OF[i.source];
    return origin === undefined ? [] : [{ requestId: i.requestId, origin, receivedAt: i.receivedAt, expiresAt: i.expiresAt, cancelled: i.cancelled }];
  });
  return { runs, inputs: known, slotHolds: holds.value, now };
}

// nextIntent의 입력. 임대 끝을 모르면 lease=null, 지시 이력을 읽지 못하면 lastInstructionAt="unknown"이다.
function lifecycle(ledger: Ledger, runId: string, now: number): LifecycleView {
  const got = ledger.getRun(runId);
  if (!got.known || got.value === null) throw new Error("실행을 읽지 못함");
  const run = got.value;
  const times = ledger.instructionTimes(runId);
  const inputs = ledger.listInputs();
  // 연결된 입력의 취소 여부를 모르면 판단을 조립하지 않는다. "취소 없음"으로 채우면 취소된 실행의 임대를 갱신하게 된다.
  if (!inputs.known) throw new Error("입력을 읽지 못함");
  const input = inputs.value.find((i) => i.requestId === run.inputRequestId);
  if (run.inputRequestId !== null && input === undefined) throw new Error("연결된 입력이 없다");
  const lease = times.known && times.value !== null ? times.value.lease : null;
  return {
    run: { runId, kind: run.kind, state: run.state, deadlineAt: run.deadlineAt },
    lease: lease !== null && lease.expiresAt !== "unknown" ? { issuedAt: lease.issuedAt, expiresAt: lease.expiresAt } : null,
    cancelRequested: input?.cancelled === true,
    lastInstructionAt: !times.known || times.value === null ? "unknown" : run.state === "stopping" ? times.value.lastStopAt : times.value.lastFinalizeAt,
    resultSettled: false,
    now,
  };
}

test("재개방 후 관리자·경보 순서 복원", () => {
  const path = tempPath();
  const first = ready(open(path));
  const alertReq = enqueue(first, "alertmanager", NOW);
  const adminReq = enqueue(first, "admin-dm", NOW + 1_000);
  const alertRun = must(first.admitRun(worker({ inputRequestId: alertReq }))).run;
  const adminRun = must(first.admitRun(worker({ inputRequestId: adminReq }))).run;
  first.close();

  const ledger = ready(open(path));
  const inputs = ledger.listInputs();
  // 장부는 접수 때 받은 출처 이름과 시각을 그대로 낸다(분류하지 않는다).
  expect(inputs).toEqual({
    known: true,
    value: [
      { requestId: alertReq, seq: 1, source: "alertmanager", receivedAt: NOW, expiresAt: NOW + 3_600_000, cancelled: false },
      { requestId: adminReq, seq: 2, source: "admin-dm", receivedAt: NOW + 1_000, expiresAt: NOW + 3_600_000, cancelled: false },
    ],
  });

  // 경보가 먼저 들어왔어도 관리자 요청이 먼저다.
  const early = planNext(assemble(ledger, NOW + 2_000), POLICY);
  expect(early.candidates).toEqual([{ runId: adminRun.runId, kind: "worker", origin: "admin", budgetLeft: 50_000 }]);
  expect(early.held).toEqual([{ runId: alertRun.runId, kind: "worker", reason: "waiting_turn" }]);

  // 경보가 접수 시각부터 alertMaxWaitMs를 기다렸으면 경보가 앞선다(재개방 뒤에도 접수 시각이 남아 있어야 셀 수 있다).
  const aged = planNext(assemble(ledger, NOW + POLICY.alertMaxWaitMs), POLICY);
  expect(aged.candidates.map((c) => [c.runId, c.origin])).toEqual([[alertRun.runId, "alert"]]);
});

test("처리된 입력의 취소가 실행에서 보임", () => {
  const path = tempPath();
  const first = ready(open(path));
  const requestId = enqueue(first, "admin-dm", NOW);
  const runId = must(first.admitRun(worker({ inputRequestId: requestId }))).run.runId;
  must(first.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  // 세션 줄은 지금의 공개 쓰기로 만들 수 없다(startSession이 닫혀 있다). 처리 위치를 올리려고 규칙 확인과 세션 실행을 API로 적고
  // 세션 줄 하나만 파일에 직접 넣는다.
  const check = id();
  must(
    first.applyRuleCheck(
      { reportId: check, outcome: "rule_present", firstMarkerDigest: digest("m0"), restartedMarkerDigest: null, startPermitId: null, checkedAt: NOW, bodyDigest: digest("rc"), now: NOW },
      { sender: SESSION_EXECUTOR },
    ),
  );
  const sessionRun = must(first.admitRun(session())).run.runId;
  first.close();
  const sessionId = id();
  const raw = new Database(path);
  raw.run("PRAGMA foreign_keys = ON");
  raw.query("INSERT INTO sessions (session_id, run_id, start_seq, generation_marker_digest, rule_check_id) VALUES (?, ?, 1, ?, ?)").run(sessionId, sessionRun, digest("m0"), check);
  raw.close();

  const ledger = ready(open(path));
  must(ledger.setProcessedSeq({ sessionId, processedSeq: 1 }));
  must(ledger.cancelInput(requestId, NOW + 5));
  // 대기열에서는 이미 처리한 입력이라 나오지 않는다.
  const queue = ledger.queueView();
  if (!queue.known) throw new Error("장부를 읽지 못함");
  expect(queue.value.inputs).toEqual({ processedSeq: 1, pending: [], cancelled: [], expired: [] });
  // 실행이 가리키는 입력의 만료와 취소는 처리 위치와 무관하게 읽힌다.
  expect(ledger.listInputs()).toEqual({
    known: true,
    value: [{ requestId, seq: 1, source: "admin-dm", receivedAt: NOW, expiresAt: NOW + 3_600_000, cancelled: true }],
  });
  // 시작 뒤의 취소 요청이 판단에 닿아 종료 의도가 된다.
  expect(nextIntent(lifecycle(ledger, runId, NOW + 10), LIFE)).toEqual({ intent: "stop", runId, toward: "stopping" });
});

test("미발행과 모름이 다른 값", () => {
  const ledger = ready(open(tempPath()));
  const requestId = enqueue(ledger, "admin-dm", NOW);
  const runId = must(ledger.admitRun(worker({ inputRequestId: requestId }))).run.runId;
  // 지시를 낸 적이 없다는 것을 장부에서 확인했다: 값이 null이다(읽지 못한 것과 다르다).
  expect(ledger.instructionTimes(runId)).toEqual({ known: true, value: { runId, lease: null, renewIssued: null, lastStopAt: null, lastFinalizeAt: null } });
  expect(ledger.instructionTimes(id())).toEqual({ known: true, value: null });

  // 시작 지시의 임대 끝은 계약이 정한다: 발행 시각 + RUN_LEASE_MAX_MS(실행기가 같은 식으로 정한다).
  must(ledger.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  expect(ledger.instructionTimes(runId)).toMatchObject({ value: { lease: { issuedAt: NOW, expiresAt: NOW + limits.RUN_LEASE_MAX_MS }, lastStopAt: null } });
  expect(nextIntent(lifecycle(ledger, runId, NOW + 10_000), LIFE).intent).toBe("renew_lease");

  // 앞 임대의 끝보다 전달 여유 이상 앞서 낸 갱신이라 판단이 쓰는 임대는 그 갱신이 발급한 끝이고, 다음 주기에 다시 갱신한다.
  must(ledger.recordRenewInstruction({ runId, requestId: id(), stopGeneration: 0, now: NOW + 10_000 }));
  expect(ledger.instructionTimes(runId)).toMatchObject({ value: { lease: { issuedAt: NOW + 10_000, expiresAt: NOW + 10_000 + limits.RUN_LEASE_MAX_MS } } });
  expect(nextIntent(lifecycle(ledger, runId, NOW + 20_000), LIFE).intent).toBe("renew_lease");
  // 감독이 발급한 끝(본문의 lease_until = 발행 시각 + RUN_LEASE_MAX_MS)은 발급 기록으로도 읽힌다.
  expect(ledger.instructionTimes(runId)).toMatchObject({ value: { renewIssued: { issuedAt: NOW + 10_000, leaseUntil: NOW + 10_000 + limits.RUN_LEASE_MAX_MS } } });

  // 종료 지시를 냈으면 그 시각이 마지막 종료 지시다. 답을 기다릴 시간이 지나면 같은 ID로 조회한다.
  must(ledger.recordStopInstruction({ runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW + 20_000 }));
  expect(ledger.instructionTimes(runId)).toMatchObject({ value: { lastStopAt: NOW + 20_000, lastFinalizeAt: null } });
  expect(nextIntent(lifecycle(ledger, runId, NOW + 20_000 + LIFE.answerTimeoutMs), LIFE).intent).toBe("query");

  // 읽지 못하면 값이 아니라 known: false다. 판단에는 "unknown"으로 넘어가 같은 시각에도 기다린다.
  const view = lifecycle(ledger, runId, NOW + 20_000 + LIFE.answerTimeoutMs);
  ledger.close();
  expect(ledger.instructionTimes(runId)).toEqual({ known: false, reason: "closed" });
  expect(ledger.listInputs()).toEqual({ known: false, reason: "closed" });
  expect(nextIntent({ ...view, lastInstructionAt: "unknown" }, LIFE).intent).toBe("wait");
});

test("갱신을 시작보다 이른 시각으로 기록해도 재개방 뒤 임대 끝은 모름이고 조회한다", () => {
  const path = tempPath();
  const first = ready(open(path));
  const requestId = enqueue(first, "admin-dm", NOW);
  const runId = must(first.admitRun(worker({ inputRequestId: requestId }))).run.runId;
  must(first.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  must(first.recordRenewInstruction({ runId, requestId: id(), stopGeneration: 0, now: NOW - 1 }));
  first.close();

  const ledger = ready(open(path));
  expect(ledger.instructionTimes(runId)).toMatchObject({ known: true, value: { lease: { issuedAt: NOW - 1, expiresAt: "unknown" } } });
  expect(nextIntent(lifecycle(ledger, runId, NOW + 10_000), LIFE).intent).toBe("query");
});

// ---- 갱신 지시의 임대 끝(판 0002-renew-lease-end) ----

const LEASE_END_VERSION = loadMigrations().findIndex((m) => m.name === "0002-renew-lease-end.sql") + 1;
const MAX = limits.RUN_LEASE_MAX_MS;

function opened(result: OpenResult): Ledger {
  if (!result.ok) throw new Error(`열지 못함: ${result.reason} ${result.detail}`);
  return result.ledger;
}

function failAt(point: string) {
  return {
    at(reached: string) {
      if (reached === point) throw new Error(`주입한 실패: ${point}`);
    },
  };
}

function rawRows(path: string, sql: string, ...params: string[]): unknown[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query(sql).all(...params);
  } finally {
    raw.close();
  }
}

// 갱신 끝의 판을 적용하기 전의 장부: 코드의 앞 판들만 적용하고 실행을 NOW에 시작한 뒤, 그 판들의 코드가 갱신을 적던 문장 그대로
// 갱신 한 줄을 넣는다(지금 코드는 끝 칸을 함께 적으므로 그 판의 장부에는 쓸 수 없다).
function ledgerBeforeLeaseEnd(renewAt: number) {
  expect(LEASE_END_VERSION).toBeGreaterThan(1);
  const path = tempPath();
  const first = ready(open(path, { migrations: loadMigrations().slice(0, LEASE_END_VERSION - 1) }));
  const requestId = enqueue(first, "admin-dm", NOW);
  const runId = must(first.admitRun(worker({ inputRequestId: requestId }))).run.runId;
  must(first.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  first.close();
  const renewId = id();
  const raw = new Database(path);
  raw.run("PRAGMA foreign_keys = ON");
  expect((raw.query("PRAGMA table_info(instructions)").all() as { name: string }[]).map((c) => c.name)).not.toContain("lease_until");
  raw.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, 'run_renew', 0, ?)").run(renewId, runId, renewAt);
  raw.close();
  return { path, runId, renewId };
}

test("제때 갱신한 실행의 발급 기록이 저장되고 임대는 발급한 끝이다", () => {
  const path = tempPath();
  const first = ready(open(path));
  const requestId = enqueue(first, "admin-dm", NOW);
  const runId = must(first.admitRun(worker({ inputRequestId: requestId }))).run.runId;
  must(first.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  expect(nextIntent(lifecycle(first, runId, NOW + 10_000), LIFE).intent).toBe("renew_lease");
  // 돌려준 끝이 갱신 본문의 lease_until이다.
  expect(first.recordRenewInstruction({ runId, requestId: id(), stopGeneration: 0, now: NOW + 10_000 })).toEqual({ ok: true, leaseUntil: NOW + 10_000 + MAX });
  first.close();

  // 발급한 끝은 재개방 뒤에도 발급 기록으로 읽힌다. 앞 임대의 끝보다 전달 여유 이상 앞서 낸 갱신이라 판단이 쓰는 임대도 그 끝이다.
  const second = ready(open(path));
  expect(second.instructionTimes(runId)).toEqual({
    known: true,
    value: {
      runId,
      lease: { issuedAt: NOW + 10_000, expiresAt: NOW + 10_000 + MAX },
      renewIssued: { issuedAt: NOW + 10_000, leaseUntil: NOW + 10_000 + MAX },
      lastStopAt: null,
      lastFinalizeAt: null,
    },
  });
  expect(nextIntent(lifecycle(second, runId, NOW + 15_000), LIFE).intent).toBe("wait");
  // 갱신 기록은 임대 끝을 보지 않아 더 적을 수 있고, 그 발급 기록도 이어서 저장된다.
  must(second.recordRenewInstruction({ runId, requestId: id(), stopGeneration: 0, now: NOW + 20_000 }));
  second.close();

  const ledger = ready(open(path));
  expect(ledger.instructionTimes(runId)).toMatchObject({
    known: true,
    value: { lease: { issuedAt: NOW + 20_000, expiresAt: NOW + 20_000 + MAX }, renewIssued: { issuedAt: NOW + 20_000, leaseUntil: NOW + 20_000 + MAX } },
  });
  // 시작 임대가 끝난 시각에도 두 번째 갱신의 임대 안이라 다시 갱신한다.
  expect(nextIntent(lifecycle(ledger, runId, NOW + MAX), LIFE).intent).toBe("renew_lease");
});

// 갱신을 앞 임대 만료 1ms 전에 발급했다. 실행기가 같은 순간에 받았으면 임대가 늘고, 만료 정각에 받았으면 연장하지 않고 실패로 닫는다.
// 장부의 기록은 두 경우에 같으므로, 판단이 기다리거나 다시 갱신하면 닫힌 실행을 살아 있다고 보게 된다.
test("만료 1ms 전에 발급한 갱신을 실행기가 만료 정각에 받는 경우에도 수명 판단은 같은 ID를 조회한다", () => {
  const path = tempPath();
  const first = ready(open(path));
  const runId = must(first.admitRun(worker({ inputRequestId: enqueue(first, "admin-dm", NOW) }))).run.runId;
  must(first.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  const issuedAt = NOW + MAX - 1;
  // 판단은 여유가 없는 이 시각에 갱신을 내지 않는다. 아래는 다른 호출자가 그래도 기록한 경우다.
  expect(nextIntent(lifecycle(first, runId, issuedAt), LIFE).intent).toBe("query");
  expect(first.recordRenewInstruction({ runId, requestId: id(), stopGeneration: 0, now: issuedAt })).toEqual({ ok: true, leaseUntil: issuedAt + MAX });
  first.close();

  const ledger = ready(open(path));
  expect(ledger.instructionTimes(runId)).toMatchObject({ value: { lease: { issuedAt, expiresAt: "unknown" }, renewIssued: { issuedAt, leaseUntil: issuedAt + MAX } } });
  const query = { intent: "query", runId, toward: "unknown_running" } as const;
  // 실행기가 닫은 시각(앞 임대의 끝)과 그 뒤 갱신 주기가 돈 시각. 발급한 끝을 임대로 쓰면 앞은 wait, 뒤는 renew_lease다.
  expect(nextIntent(lifecycle(ledger, runId, NOW + MAX), LIFE)).toEqual(query);
  expect(nextIntent(lifecycle(ledger, runId, issuedAt + LIFE.renewEveryMs), LIFE)).toEqual(query);
});

test("이관 전 장부의 옛 갱신은 모름", () => {
  const { path, runId, renewId } = ledgerBeforeLeaseEnd(NOW + 10_000);
  const before = rawRows(path, "SELECT request_id, run_id, action, stop_generation, issued_at FROM instructions ORDER BY request_id");

  const upgraded = openLedger(path, { clock, mode: "reopen" });
  expect(upgraded).toMatchObject({ ok: true, migrated: { from: LEASE_END_VERSION - 1, to: loadMigrations().length } });
  const ledger = ready(opened(upgraded));
  const unknown = {
    known: true,
    value: { runId, lease: { issuedAt: NOW + 10_000, expiresAt: "unknown" }, renewIssued: { issuedAt: NOW + 10_000, leaseUntil: "unknown" }, lastStopAt: null, lastFinalizeAt: null },
  } as const;
  expect(ledger.instructionTimes(runId)).toEqual(unknown);
  expect(nextIntent(lifecycle(ledger, runId, NOW + 20_000), LIFE).intent).toBe("query");
  ledger.close();

  // 기존 줄의 값은 그대로이고 더한 칸만 NULL이다(0이나 계산값으로 채우지 않는다).
  expect(rawRows(path, "SELECT request_id, run_id, action, stop_generation, issued_at FROM instructions ORDER BY request_id")).toEqual(before);
  expect(rawRows(path, "SELECT lease_until FROM instructions")).toEqual([{ lease_until: null }, { lease_until: null }]);

  // 다시 열어도 판은 한 번만 적용돼 있고 같은 값이다.
  const again = openLedger(path, { clock, mode: "reopen" });
  expect(again).toMatchObject({ ok: true, migrated: { from: loadMigrations().length, to: loadMigrations().length } });
  const reopened = ready(opened(again));
  expect(reopened.instructionTimes(runId)).toEqual(unknown);
  // 옛 갱신 뒤에 새 갱신을 적어도, 앞 임대의 끝을 모르므로 그 사이에 임대가 끝났는지 알 수 없어 발급 기록의 끝도 모름이다.
  must(reopened.recordRenewInstruction({ runId, requestId: id(), stopGeneration: 0, now: NOW + 20_000 }));
  expect(reopened.instructionTimes(runId)).toMatchObject({
    value: { lease: { issuedAt: NOW + 20_000, expiresAt: "unknown" }, renewIssued: { issuedAt: NOW + 20_000, leaseUntil: "unknown" } },
  });
  reopened.close();
  expect(rawRows(path, "SELECT lease_until FROM instructions WHERE request_id = ?", renewId)).toEqual([{ lease_until: null }]);
});

// 실행 하나를 NOW에 시작하고 갱신을 주어진 발행 시각 순서대로 기록한 뒤 다시 연다. 작업자 슬롯이 하나라 사례마다 장부를 따로 둔다.
function renewedInOrder(renewAts: number[]) {
  const path = tempPath();
  const first = ready(open(path));
  const runId = must(first.admitRun(worker({ inputRequestId: enqueue(first, "admin-dm", NOW) }))).run.runId;
  must(first.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  const returned = renewAts.map((now) => must(first.recordRenewInstruction({ runId, requestId: id(), stopGeneration: 0, now })).leaseUntil);
  first.close();
  const ledger = ready(open(path));
  const times = ledger.instructionTimes(runId);
  if (!times.known || times.value === null) throw new Error("지시를 읽지 못함");
  return { path, ledger, runId, lease: times.value.lease, issued: times.value.renewIssued, returned };
}

test("어긋난 시각의 갱신은 틀린 발급 기록을 내지 않는다", () => {
  // 앞 리뷰의 재현: 시작 NOW 뒤에 갱신을 NOW-1로 기록했다. 실제로 마지막에 발급한 끝은 그 갱신의 것(NOW-1+MAX)이다.
  const skewed = renewedInOrder([NOW - 1]);
  expect(skewed.returned).toEqual([NOW - 1 + MAX]);
  expect(skewed.issued).toEqual({ issuedAt: NOW - 1, leaseUntil: "unknown" });
  expect(skewed.lease).toEqual({ issuedAt: NOW - 1, expiresAt: "unknown" });
  expect(nextIntent(lifecycle(skewed.ledger, skewed.runId, NOW + 10_001), LIFE).intent).toBe("query");

  // 갱신이 여럿: NOW+20000 갱신 뒤에 더 이른 NOW+15000 갱신을 기록했다. 발행 시각이 가장 큰 갱신(끝 NOW+20000+MAX)은 마지막이 아니다.
  const reordered = renewedInOrder([NOW + 20_000, NOW + 15_000]);
  expect(reordered.issued).toEqual({ issuedAt: NOW + 20_000, leaseUntil: "unknown" });
  expect(reordered.lease).toEqual({ issuedAt: NOW + 20_000, expiresAt: "unknown" });
  expect(nextIntent(lifecycle(reordered.ledger, reordered.runId, NOW + 30_000), LIFE).intent).toBe("query");

  // 같은 발행 시각의 갱신 둘: 어느 쪽이 마지막인지 시각으로 가를 수 없다.
  const tied = renewedInOrder([NOW + 10_000, NOW + 10_000]);
  expect(tied.issued).toEqual({ issuedAt: NOW + 10_000, leaseUntil: "unknown" });
  expect(tied.lease).toEqual({ issuedAt: NOW + 10_000, expiresAt: "unknown" });
  expect(nextIntent(lifecycle(tied.ledger, tied.runId, NOW + 20_000), LIFE).intent).toBe("query");

  // 시작 임대가 끝난 시각(NOW+MAX)에 기록한 갱신: 실행기는 이미 닫았고 지난 임대를 되살리지 않는다.
  const late = renewedInOrder([NOW + MAX]);
  expect(late.issued).toEqual({ issuedAt: NOW + MAX, leaseUntil: "unknown" });
  expect(late.lease).toEqual({ issuedAt: NOW + MAX, expiresAt: "unknown" });
  expect(nextIntent(lifecycle(late.ledger, late.runId, NOW + MAX + 10_000), LIFE).intent).toBe("query");

  // 시각 순서대로 기록한 갱신 여럿은 마지막 갱신의 발급 기록이다(대조군). 모두 앞 임대의 끝보다 전달 여유 이상 앞서 냈으므로 판단이 쓰는 임대도 그 끝이다.
  const ordered = renewedInOrder([NOW + 10_000, NOW + 20_000]);
  expect(ordered.issued).toEqual({ issuedAt: NOW + 20_000, leaseUntil: NOW + 20_000 + MAX });
  expect(ordered.lease).toEqual({ issuedAt: NOW + 20_000, expiresAt: NOW + 20_000 + MAX });

  // 끝을 적지 않은 것은 순서가 어긋난 갱신뿐이다. 시각 순서대로 적힌 갱신의 끝은 남아 있다.
  const ends = (c: { path: string; runId: string; ledger: Ledger }) => {
    c.ledger.close();
    return rawRows(c.path, "SELECT issued_at, lease_until FROM instructions WHERE run_id = ? AND action = 'run_renew' ORDER BY issued_at DESC, lease_until", c.runId);
  };
  expect(ends(skewed)).toEqual([{ issued_at: NOW - 1, lease_until: null }]);
  expect(ends(reordered)).toEqual([
    { issued_at: NOW + 20_000, lease_until: NOW + 20_000 + MAX },
    { issued_at: NOW + 15_000, lease_until: null },
  ]);
  expect(ends(tied)).toEqual([
    { issued_at: NOW + 10_000, lease_until: null },
    { issued_at: NOW + 10_000, lease_until: NOW + 10_000 + MAX },
  ]);
  expect(ends(late)).toEqual([{ issued_at: NOW + MAX, lease_until: NOW + 2 * MAX }]);
  expect(ends(ordered)).toEqual([
    { issued_at: NOW + 20_000, lease_until: NOW + 20_000 + MAX },
    { issued_at: NOW + 10_000, lease_until: NOW + 10_000 + MAX },
  ]);
});

test("이관이 끊긴 뒤 다시 열린다", () => {
  const { path, runId } = ledgerBeforeLeaseEnd(NOW + 10_000);
  const versions = (n: number) => Array.from({ length: n }, (_, index) => ({ version: index + 1 }));

  // 판 하나는 트랜잭션 하나다. 판을 적용한 뒤 커밋 전에 끊기면 그 판의 칸도 적용 기록도 남지 않는다.
  expect(openLedger(path, { clock, mode: "reopen", faults: failAt(`migration:${LEASE_END_VERSION}`) })).toMatchObject({ ok: false, reason: "migration_failed" });
  expect(rawRows(path, "SELECT version FROM ledger_migrations ORDER BY version")).toEqual(versions(LEASE_END_VERSION - 1));
  expect((rawRows(path, "PRAGMA table_info(instructions)") as { name: string }[]).map((c) => c.name)).not.toContain("lease_until");

  // 다시 열면 끊긴 판부터 한 번 적용하고, 옛 갱신의 끝은 모름이다.
  const resumed = openLedger(path, { clock, mode: "reopen" });
  expect(resumed).toMatchObject({ ok: true, migrated: { from: LEASE_END_VERSION - 1, to: loadMigrations().length } });
  const ledger = ready(opened(resumed));
  expect(ledger.instructionTimes(runId)).toMatchObject({
    known: true,
    value: { lease: { issuedAt: NOW + 10_000, expiresAt: "unknown" }, renewIssued: { issuedAt: NOW + 10_000, leaseUntil: "unknown" } },
  });
  ledger.close();
  expect(rawRows(path, "SELECT version FROM ledger_migrations ORDER BY version")).toEqual(versions(loadMigrations().length));
});

// 판 목록을 옵션으로 줄여 연 장부(시험용 길)에는 갱신 끝의 칸이 없다. 지시 시각 읽기와 갱신 기록은 틀린 값을 내지 않고
// db_error로 닫히며 장부가 쓰기 불가가 된다(닫히는 쪽). 기본 판 목록의 재개방은 이 판까지 올라가 이 길을 타지 않는다.
test("판 목록을 갱신 끝의 판 앞에서 끊어 연 장부는 지시 시각 읽기와 갱신 기록에서 쓰기 불가로 닫힌다", () => {
  const started = () => {
    const ledger = ready(open(tempPath(), { migrations: loadMigrations().slice(0, LEASE_END_VERSION - 1) }));
    const runId = must(ledger.admitRun(worker({ inputRequestId: enqueue(ledger, "admin-dm", NOW) }))).run.runId;
    must(ledger.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
    expect(ledger.health()).toEqual({ writable: true });
    return { ledger, runId };
  };

  const read = started();
  expect(read.ledger.instructionTimes(read.runId)).toEqual({ known: false, reason: "db_error" });
  expect(read.ledger.health()).toEqual({ writable: false, reason: "db_error" });
  // 다른 실행의 새 접수도 닫힌다.
  expect(read.ledger.admitRun(worker())).toEqual({ ok: false, reason: "ledger_unwritable" });

  const renew = started();
  expect(renew.ledger.recordRenewInstruction({ runId: renew.runId, requestId: id(), stopGeneration: 0, now: NOW + 10_000 })).toEqual({ ok: false, reason: "ledger_unwritable" });
  expect(renew.ledger.health()).toEqual({ writable: false, reason: "db_error" });
});

test("입력을 읽지 못하면 수명 판단을 조립하지 않는다", () => {
  const ledger = ready(open(tempPath()));
  const requestId = enqueue(ledger, "admin-dm", NOW);
  const runId = must(ledger.admitRun(worker({ inputRequestId: requestId }))).run.runId;
  must(ledger.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  must(ledger.cancelInput(requestId, NOW + 5));
  expect(nextIntent(lifecycle(ledger, runId, NOW + 10_000), LIFE).intent).toBe("stop");
  // 실행·지시 읽기는 성공하고 입력 읽기만 실패하는 장부.
  const inputsFail = new Proxy(ledger, {
    get(target, key) {
      if (key === "listInputs") return () => ({ known: false, reason: "io" });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(() => lifecycle(inputsFail, runId, NOW + 10_000)).toThrow("입력을 읽지 못함");
});

// 시작 지시 뒤의 상태(preparing에서 닿는 모든 상태)에서 여러 걸음을 거쳐서라도 not_started에 닿는지.
function startedReachesNotStarted(table: Partial<Record<LedgerRunState, readonly LedgerRunState[]>>): boolean {
  const seen = new Set<LedgerRunState>(["preparing"]);
  const stack: LedgerRunState[] = ["preparing"];
  while (stack.length > 0) {
    for (const to of table[stack.pop() as LedgerRunState] ?? []) {
      if (!seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return seen.has("not_started");
}

test("시작 전에 닫힌 줄은 상한이 아님", () => {
  // 장부에서 not_started로 들어오는 길은 queued에서, 또는 닫기 근거가 있을 때(D-90, 관리자 닫기 D-91)이고, 시작한 줄은 대기로
  // 돌아가지 않는다. queued에서 닫힌 줄은 시작한 적이 없고, D-90으로 닫힌 줄은 시작 지시에 고정된 예산에서 감액이 적히지 않았을
  // 때만 닫혀서 어느 쪽이든 숫자가 쓰고 남긴 잔액이 아니다. 관리자가 닫은 줄은 이미 돌았을 수 있어 상한으로 센다(아래 시험).
  for (const kind of ["worker", "session"] as const) {
    const into = Object.entries(TRANSITIONS[kind])
      .filter(([, to]) => to?.includes("not_started"))
      .map(([from]) => from);
    // 예외는 작업자의 닫기 줄뿐이다. 장부 트리거가 근거 줄이 있을 때만 허락한다: D-90(preparing·unknown_running, 실행기가 받은 적
    // 없는 실행, 쓴 예산 없음)과 관리자 닫기(파드 교체의 unknown_running·stopping, 저장소 비움의 checking·ready_result·failed_stopped,
    // 이미 돌았을 수 있음).
    const unreceived: readonly LedgerRunState[] = kind === "worker" ? ["preparing", "unknown_running"] : [];
    const operator: readonly LedgerRunState[] = kind === "worker" ? ["unknown_running", "stopping", "checking", "ready_result", "failed_stopped"] : [];
    const closure = LEDGER_RUN_STATES.filter((state) => unreceived.includes(state) || operator.includes(state));
    expect(closure, kind).toEqual(kind === "worker" ? ["preparing", "stopping", "checking", "ready_result", "failed_stopped", "unknown_running"] : []);
    expect(into, kind).toEqual(["queued", ...closure]);
    const withoutClosure = Object.fromEntries(Object.entries(TRANSITIONS[kind]).map(([from, to]) => [from, closure.includes(from as LedgerRunState) ? to?.filter((s) => s !== "not_started") : to]));
    expect(startedReachesNotStarted(withoutClosure), kind).toBe(false);
    // 닫기 간선(위 closure의 상태 → not_started)을 뺀 표에 시작한 줄이 대기로 돌아가는 간선(running → queued)을 더하면 이 검사가 잡는다.
    const requeue = { ...withoutClosure, running: [...(withoutClosure.running ?? []), "queued" as const] };
    expect(startedReachesNotStarted(requeue), kind).toBe(true);
  }

  const path = tempPath();
  const first = ready(open(path));
  const requestId = enqueue(first, "admin-dm", NOW);
  const current = must(first.admitRun(worker({ inputRequestId: requestId, budgetLeft: 10 }))).run;
  const later = must(first.admitRun(worker({ inputRequestId: requestId, budgetLeft: 3 }))).run;
  // 뒤 순번 실행을 시작 전에 닫는다(배정기가 기한이 지난 대기 실행을 닫는 길).
  must(first.recordStopInstruction({ runId: later.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW }));
  first.close();

  const ledger = ready(open(path));
  const view = assemble(ledger, NOW + 1);
  expect(view.runs.map((r) => [r.runId, r.state, r.budgetLeft])).toEqual([
    [current.runId, "queued", 10],
    [later.runId, "not_started", 3],
  ]);
  const decision = planNext(view, POLICY);
  expect(decision).toEqual({ candidates: [{ runId: current.runId, kind: "worker", origin: "admin", budgetLeft: 10 }], held: [] });
  // 후보를 따라 부른 시작이 실제로 커밋된다.
  expect(ledger.startRun({ runId: current.runId, requestId: id(), stopGeneration: 0, now: NOW + 1 })).toMatchObject({ ok: true, run: { state: "preparing", budgetLeft: 10 } });
});

test("관리자가 닫은 줄은 시작 예산 전부를 같은 요청의 한도에서 잡고(감액이 적혔든 아니든), D-90으로 닫은 줄은 잡지 않는다", () => {
  // closed: 먼저 시작해 닫힌 실행의 예산, reduced: 시작 뒤 적힌 잔액(없으면 감액 없음), next: 같은 입력의 다음 실행의 예산.
  // 요청 한도 19: 관리자가 닫았으면 남은 몫은 19 - 10 = 9, D-90으로 닫았으면 19다.
  const policy: SchedulerPolicy = { ...POLICY, requestBudget: { admin: 19, alert: 19 } };
  const cases = [
    { by: "operator", closed: 10, reduced: 4, next: 10, held: true },
    { by: "operator", closed: 10, reduced: null, next: 12, held: true },
    { by: "operator", closed: 10, reduced: 4, next: 4, held: false },
    { by: "unreceived", closed: 10, reduced: null, next: 12, held: false },
  ] as const;
  for (const c of cases) {
    const label = JSON.stringify(c);
    const ledger = ready(open(tempPath()));
    const requestId = enqueue(ledger, "admin-dm", NOW);
    const first = must(ledger.admitRun(worker({ inputRequestId: requestId, budgetLeft: c.closed }))).run;
    must(ledger.startRun({ runId: first.runId, requestId: id(), stopGeneration: 0, now: NOW }));
    if (c.reduced !== null) must(ledger.recordBudget({ runId: first.runId, budgetLeft: c.reduced, now: NOW }));
    if (c.by === "operator") {
      must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
      must(ledger.closeRunByOperator({ runId: first.runId, checkedBy: "pod_replaced", podName: "worker-a-0", podStartedAt: NOW + 31_000, now: NOW + 31_000 }));
    } else {
      must(ledger.closeUnreceivedRun({ runId: first.runId, runs: [], answeredAt: NOW + 30_000, receivedAt: NOW + 30_001, now: NOW + 30_002 }, { sender: WORKER_EXECUTOR }));
    }
    const next = must(ledger.admitRun(worker({ inputRequestId: requestId, budgetLeft: c.next }))).run;
    const view = assemble(ledger, NOW + 40_000);
    expect(view.runs.map((r) => [r.runId, r.state, r.budgetLeft, r.closedByOperator]), label).toEqual([
      [first.runId, "not_started", c.reduced ?? c.closed, c.by === "operator"],
      [next.runId, "queued", c.next, undefined],
    ]);
    const decision = planNext(view, policy);
    if (c.held) expect(decision, label).toEqual({ candidates: [], held: [{ runId: next.runId, kind: "worker", reason: "request_budget_exceeded" }] });
    else expect(decision.candidates.map((x) => x.runId), label).toEqual([next.runId]);
    ledger.close();
  }
});

// 실행 ID → [상태, 남은 예산, 예약, 예약 칸이 있는가].
function reservations(ledger: Ledger): Map<string, [LedgerRunState, number, number | null | undefined, boolean]> {
  const all = ledger.listRuns();
  if (!all.known) throw new Error("실행 목록을 읽지 못함");
  return new Map(all.value.map((r) => [r.runId, [r.state, r.budgetLeft, r.reservedBudget, "reservedBudget" in r]]));
}

test("listRuns의 예약: 시작 전·대기에서 닫힘·D-90 닫힘은 0, 시작하면 시작 지시의 예산 전부(시작 뒤 감액·관리자 닫기와 무관), 세션 줄에는 칸이 없다", () => {
  const path = tempPath();
  const first = ready(open(path));
  const requestId = enqueue(first, "admin-dm", NOW);
  const queued = must(first.admitRun(worker({ inputRequestId: requestId, budgetLeft: 10 }))).run.runId;
  const cancelled = must(first.admitRun(worker({ inputRequestId: requestId, budgetLeft: 7 }))).run.runId;
  must(first.recordStopInstruction({ runId: cancelled, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW }));
  // 대기 중에 줄인 예산(9 → 6)은 시작 지시에 고정되고, 시작 뒤의 감액(6 → 2)은 예약을 줄이지 않는다.
  const operator = must(first.admitRun(worker({ inputRequestId: requestId, budgetLeft: 9 }))).run.runId;
  must(first.recordBudget({ runId: operator, budgetLeft: 6, now: NOW }));
  expect(reservations(first).get(operator)).toEqual(["queued", 6, 0, true]);
  must(first.startRun({ runId: operator, requestId: id(), stopGeneration: 0, now: NOW }));
  must(first.recordBudget({ runId: operator, budgetLeft: 2, now: NOW }));
  expect(reservations(first).get(operator)).toEqual(["preparing", 2, 6, true]);
  must(first.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  must(first.closeRunByOperator({ runId: operator, checkedBy: "pod_replaced", podName: "worker-a-0", podStartedAt: NOW + 31_000, now: NOW + 31_000 }));
  // 실행기가 받은 적 없는 실행: 시작한 동안은 예약 8, D-90으로 닫으면 0.
  const unreceived = must(first.admitRun(worker({ inputRequestId: requestId, budgetLeft: 8 }))).run.runId;
  must(first.startRun({ runId: unreceived, requestId: id(), stopGeneration: 0, now: NOW + 40_000 }));
  expect(reservations(first).get(unreceived)).toEqual(["preparing", 8, 8, true]);
  must(first.closeUnreceivedRun({ runId: unreceived, runs: [], answeredAt: NOW + 70_000, receivedAt: NOW + 70_001, now: NOW + 70_002 }, { sender: WORKER_EXECUTOR }));
  const sessionRun = must(first.admitRun(session())).run.runId;
  first.close();

  // 다시 연 장부의 공개 읽기만으로 같은 값이 나온다.
  const ledger = ready(open(path));
  expect([...reservations(ledger)]).toEqual([
    [queued, ["queued", 10, 0, true]],
    [cancelled, ["not_started", 7, 0, true]],
    [operator, ["not_started", 2, 6, true]],
    [unreceived, ["not_started", 8, 0, true]],
    [sessionRun, ["queued", 50_000, undefined, false]],
  ]);
  // 같은 요청의 예약 합은 6이다. 한도 16이면 남은 몫 10으로 예산 10의 대기 실행이 후보, 한도 15면 보류다.
  const view = assemble(ledger, NOW + 80_000);
  const worker10 = (limit: number) => planNext(view, { ...POLICY, requestBudget: { admin: limit, alert: limit } });
  expect(worker10(16).candidates).toEqual([{ runId: queued, kind: "worker", origin: "admin", budgetLeft: 10 }]);
  expect(worker10(15).candidates).toEqual([]);
  expect(worker10(15).held.find((h) => h.runId === queued)).toEqual({ runId: queued, kind: "worker", reason: "request_budget_exceeded" });
});

test("판 4 전에 적힌 시작 지시와 시작 지시가 둘인 작업자 줄은 예약을 모르고, 같은 요청의 다음 실행은 보류다", () => {
  const rebuildVersion = loadMigrations().findIndex((m) => m.name === "0004-instruction-rebuild.sql") + 1;
  expect(rebuildVersion).toBeGreaterThan(1);
  const path = tempPath();
  const old = ready(open(path, { migrations: loadMigrations().slice(0, rebuildVersion - 1) }));
  const requestId = enqueue(old, "admin-dm", NOW);
  const runId = must(old.admitRun(worker({ inputRequestId: requestId, budgetLeft: 10 }))).run.runId;
  must(old.startRun({ runId, requestId: id(), stopGeneration: 0, now: NOW }));
  old.close();

  // 판을 올려 연다. 그 시작 지시의 고정 예산 칸은 비어 있고, 지금 잔액(10)으로 메우지 않는다.
  const ledger = ready(open(path));
  const next = must(ledger.admitRun(worker({ inputRequestId: requestId, budgetLeft: 5 }))).run.runId;
  const view = assemble(ledger, NOW + 1);
  expect(view.runs.map((r) => [r.runId, r.state, r.reservedBudget])).toEqual([
    [runId, "preparing", null],
    [next, "queued", 0],
  ]);
  expect(planNext(view, POLICY).held).toEqual([{ runId: next, kind: "worker", reason: "budget_unknown" }]);
  ledger.close();

  // 시작 지시가 둘인 줄(API로는 생기지 않는다)은 어느 예산인지 정하지 않는다.
  const twice = tempPath();
  const a = ready(open(twice));
  const req = enqueue(a, "admin-dm", NOW);
  const started = must(a.admitRun(worker({ inputRequestId: req, budgetLeft: 10 }))).run.runId;
  must(a.startRun({ runId: started, requestId: id(), stopGeneration: 0, now: NOW }));
  a.close();
  const raw = new Database(twice);
  raw.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at, budget_left) VALUES (?, ?, 'task_start', 0, ?, 10)").run(id(), started, NOW + 1);
  raw.close();
  const b = ready(open(twice));
  expect(reservations(b).get(started)).toEqual(["preparing", 10, null, true]);
});
