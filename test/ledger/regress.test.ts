// 접수 허가의 수명, 점유 대조, 세션 교체, 첫 설치, 시작 직전 확인의 경계 순서를 하나씩 만든다.
// 공개 API와 helpers.ts의 공통 도구만 쓴다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import type { RunStatus } from "../../src/contract/v1/index.ts";
import { type Ledger, type OccupancyAnswer, openLedger, type RestorePorts, Restorer, RestoreStepError, type Run } from "../../src/ledger/index.ts";
import { clock, digest, id, must, NOW, open, ready, session, tempPath, worker } from "./helpers.ts";

const WORKER = "executor/diagnosis/0/store-a";
const SESSION_A = "executor/session/0/store-s";
const SESSION_B = "executor/session/1/store-b";
const SESSION_C = "executor/session/2/store-c";
const PEERS = ["front-door"];

function ports(overrides: Partial<{ [K in keyof RestorePorts]: Partial<RestorePorts[K]> }> = {}): RestorePorts {
  return {
    stopAuthority: { latestStop: async () => null, ...overrides.stopAuthority },
    // PEERS는 현관 하나다. 현관은 v2와 맞은 정책으로 답해야 맞은 응답이다.
    peers: { contracts: async () => PEERS.map((peer) => ({ peer, contract: "olive-control/v2", policy: "match" as const })), ...overrides.peers },
    occupancy: { occupancy: async () => [], ...overrides.occupancy },
    publications: { lookup: async () => ({ kind: "pending" as const }), ...overrides.publications },
  };
}

function restorer(ledger: Ledger, p: RestorePorts = ports(), requiredPeers: string[] = PEERS) {
  return new Restorer(ledger, p, clock, { requiredPeers });
}

async function restore(r: Restorer) {
  return { s1: await r.step1(), s2: await r.step2(), s3: await r.step3(), s4: await r.step4(), s5: await r.step5() };
}

const occupied = (answers: OccupancyAnswer[]) => ports({ occupancy: { occupancy: async () => answers } });
const running = (runId: string, generation: number, state: RunStatus["state"] = "running"): RunStatus => ({ run_id: runId, state, run_generation: generation, last_receipt_id: null });
const start = (runId: string, stopGeneration = 0) => ({ runId, requestId: id(), stopGeneration, now: NOW });
const newInput = (requestId: string, expiresAt: number) => ({ requestId, source: "discord", sourceRef: { ref: `inputs/${id()}`, expiresAt }, receivedAt: NOW });

test("R01 접수: 4·정지 뒤 applyStop의 5·해제는 정지를 풀지 않고 새 접수와 시작을 열지 않는다", async () => {
  const ledger = open(tempPath());
  must(ledger.applyStop({ generation: 3, stopped: false, now: NOW }));
  await restore(restorer(ledger));
  const queued = must(ledger.admitRun(worker())).run;
  must(ledger.applyStop({ generation: 4, stopped: true, now: NOW }));
  must(ledger.applyStop({ generation: 5, stopped: false, now: NOW }));
  expect(ledger.readStop()).toMatchObject({ value: { generation: 5, stopped: true } });
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "stopped" });
  expect(ledger.startRun(start(queued.runId, 5))).toEqual({ ok: false, reason: "stopped" });
  // 풀기 뒤에도 복원을 끝까지 다시 마칠 때까지 닫혀 있다.
  must(ledger.releaseStop({ generation: 5, now: NOW }));
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "intake_closed" });
  expect(ledger.startRun(start(queued.runId, 5))).toEqual({ ok: false, reason: "intake_closed" });
  await restore(restorer(ledger));
  expect(ledger.startRun(start(queued.runId, 5))).toMatchObject({ ok: true });
});

test("R01 접수: 4·정지 뒤 mergeStop의 5·해제는 사실로 적어도 복원을 다시 마치기 전에는 열지 않는다", async () => {
  const ledger = open(tempPath());
  must(ledger.applyStop({ generation: 3, stopped: false, now: NOW }));
  await restore(restorer(ledger));
  const queued = must(ledger.admitRun(worker())).run;
  must(ledger.applyStop({ generation: 4, stopped: true, now: NOW }));
  must(ledger.mergeStop({ generation: 5, stopped: false }, NOW));
  expect(ledger.intakeOpen()).toBe(false);
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "intake_closed" });
  expect(ledger.startRun(start(queued.runId, 5))).toEqual({ ok: false, reason: "intake_closed" });
  await restore(restorer(ledger));
  expect(ledger.startRun(start(queued.runId, 5))).toMatchObject({ ok: true });
});

test("R02 접수: 5단계의 완료 표시·장부의 허가·반환값은 같은 동기 구간에서 정해지고 그 뒤의 정지는 허가를 없앤다", async () => {
  const ledger = open(tempPath());
  const r = restorer(ledger);
  await r.step1();
  await r.step2();
  await r.step3();
  await r.step4();
  const pending = r.step5();
  expect(ledger.intakeOpen()).toBe(true);
  expect(r.intakeOpen()).toBe(true);
  must(ledger.applyStop({ generation: 1, stopped: true, now: NOW }));
  expect(ledger.intakeOpen()).toBe(false);
  expect(r.intakeOpen()).toBe(false);
  expect(await pending).toMatchObject({ intakeMayOpen: true, closedBecause: [] });
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "stopped" });
});

test("R02 접수: 새 복원 시도가 시작되면 앞 시도의 허가가 끝나고, 닫힘 판정이 옛 허가를 남기지 않는다", async () => {
  const ledger = open(tempPath());
  const a = restorer(ledger);
  await restore(a);
  expect(a.intakeOpen()).toBe(true);
  const b = restorer(ledger, ports({ peers: { contracts: async () => [] } }));
  await b.step1();
  expect(ledger.intakeOpen()).toBe(false);
  expect(a.intakeOpen()).toBe(false);
  await b.step2();
  await b.step3();
  await b.step4();
  expect(await b.step5()).toMatchObject({ intakeMayOpen: false, closedBecause: ["peer_unconfirmed"] });
  expect(b.intakeOpen()).toBe(false);
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "intake_closed" });
});

test("R02 접수: 대조를 마친 뒤 정지가 걸렸다 풀리면 그 시도는 접수를 열지 못한다", async () => {
  const ledger = open(tempPath());
  const r = restorer(ledger);
  await r.step1();
  await r.step2();
  await r.step3();
  await r.step4();
  must(ledger.applyStop({ generation: 1, stopped: true, now: NOW }));
  must(ledger.releaseStop({ generation: 1, now: NOW }));
  expect(await r.step5()).toMatchObject({ intakeMayOpen: false, closedBecause: ["stop_changed"] });
  expect(r.intakeOpen()).toBe(false);
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "intake_closed" });
});

test("R02 접수: 앞 시도의 늦은 응답과 늦은 5단계는 지금 시도의 허가를 바꾸지 못한다", async () => {
  const ledger = open(tempPath());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = restorer(ledger, ports({ stopAuthority: { latestStop: async () => (await gate, { generation: 9, stopped: true }) } }));
  const late = slow.step1();
  const current = restorer(ledger);
  await restore(current);
  release();
  await expect(late).rejects.toBeInstanceOf(RestoreStepError);
  expect(ledger.readStop()).toMatchObject({ value: { generation: 0, stopped: false } });
  expect(current.intakeOpen()).toBe(true);

  const older = restorer(ledger);
  await older.step1();
  await older.step2();
  await older.step3();
  await older.step4();
  const newest = restorer(ledger);
  await restore(newest);
  await expect(older.step5()).rejects.toBeInstanceOf(RestoreStepError);
  expect(older.intakeOpen()).toBe(false);
  expect(newest.intakeOpen()).toBe(true);
  expect(ledger.admitRun(worker())).toMatchObject({ ok: true });
});

test("R03 맞춤: 더 새로운 정지를 저장하지 못한 장부는 옛 세대를 맞춤 답으로 내지 않는다", async () => {
  let fail = false;
  const path = tempPath();
  const ledger = open(path, {
    faults: {
      at(point) {
        if (fail && point === "stop:before_commit") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      },
    },
  });
  must(ledger.applyStop({ generation: 3, stopped: false, now: NOW }));
  const r = restorer(ledger);
  await restore(r);
  expect(r.stopGeneration()).toBe(3);
  fail = true;
  expect(ledger.applyStop({ generation: 4, stopped: true, now: NOW })).toEqual({ ok: false, reason: "ledger_unwritable" });
  fail = false;
  expect(ledger.health()).toEqual({ writable: false, reason: "io" });
  expect(ledger.intakeOpen()).toBe(false);
  expect(r.stopGeneration()).toBeNull();
  // 진단용 읽기는 옛 행을 그대로 보여 준다.
  expect(ledger.readStop()).toMatchObject({ known: true, value: { generation: 3 } });
  // 다시 열고 권위 기록을 합친 뒤에야 세대를 낸다.
  ledger.close();
  const again = open(path);
  const next = restorer(again, ports({ stopAuthority: { latestStop: async () => ({ generation: 4, stopped: true }) } }));
  expect(next.stopGeneration()).toBeNull();
  await next.step1();
  expect(next.stopGeneration()).toBe(4);
});

test("R04 점유: 필수 실행기의 응답 행이 없거나 부분 조회뿐이면 접수를 열지 않고, 명시적 빈 응답만 빈 점유다", async () => {
  const required = ["front-door", WORKER];
  // 판과 정책은 모두 맞게 답한다(현관 v2와 맞은 정책, 실행기 v1). 닫는 사유는 점유뿐이어야 한다.
  const contracts = async () => required.map((peer) => (peer === "front-door" ? { peer, contract: "olive-control/v2", policy: "match" as const } : { peer, contract: "olive-control/v1" }));
  const closed: OccupancyAnswer[][] = [
    [],
    [{ executorId: WORKER, coverage: "partial", runs: [] }],
    [{ executorId: WORKER, coverage: "partial", runs: [running(id(), 1, "not_known")] }],
    [
      { executorId: WORKER, coverage: "full", runs: [] },
      { executorId: WORKER, coverage: "full", runs: [] },
    ],
  ];
  for (const answers of closed) {
    const ledger = open(tempPath());
    const r = restorer(ledger, ports({ peers: { contracts }, occupancy: { occupancy: async () => answers } }), required);
    const { s2, s5 } = await restore(r);
    expect(s5.intakeMayOpen, JSON.stringify(answers)).toBe(false);
    expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "intake_closed" });
    expect(s5.closedBecause).toEqual(["occupancy_unconfirmed"]);
    expect(s2.occupancyUnconfirmed).toEqual([WORKER]);
  }
  const ledger = open(tempPath());
  const ok = restorer(ledger, ports({ peers: { contracts }, occupancy: { occupancy: async () => [{ executorId: WORKER, coverage: "full", runs: [] }] } }), required);
  expect((await restore(ok)).s5).toMatchObject({ intakeMayOpen: true, closedBecause: [] });
});

test("R05 점유: 대기 줄을 지정 실행기가 끝났다고 답하면 그 실행 ID를 다시 시작하지 않는다", async () => {
  const path = tempPath();
  let ledger = ready(open(path));
  const a = must(ledger.admitRun(worker())).run;
  const other = must(ledger.admitRun(worker())).run;
  ledger.close();
  ledger = open(path);
  const { s2, s5 } = await restore(restorer(ledger, occupied([{ executorId: WORKER, coverage: "full", runs: [running(a.runId, a.runGeneration, "finalized")] }])));
  expect(s2.occupancyMismatches).toMatchObject([{ runId: a.runId, why: "state" }]);
  expect(s5.queued).toEqual([other.runId]);
  expect(s5.blockedQueued).toEqual([a.runId]);
  expect(ledger.startRun(start(a.runId))).toEqual({ ok: false, reason: "run_blocked" });
  // 끝났다는 답은 슬롯을 쥐지 않는다. 관계없는 실행은 시작한다.
  expect(ledger.startRun(start(other.runId))).toMatchObject({ ok: true });
});

test("R05 점유: 종료 확인이 있는 실행을 실행기가 돌고 있다고 답하면 불일치로 남기고 상태를 다시 묻는다", async () => {
  const path = tempPath();
  let ledger = ready(open(path));
  const a = must(ledger.admitRun(worker())).run;
  must(ledger.startRun(start(a.runId)));
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: a.runId, exit: "completed", bodyDigest: digest("stop"), now: NOW }, { sender: WORKER, runGeneration: a.runGeneration }));
  ledger.close();
  ledger = open(path);
  const { s2, s3 } = await restore(restorer(ledger, occupied([{ executorId: WORKER, coverage: "full", runs: [running(a.runId, a.runGeneration)] }])));
  expect(s2.occupancyMismatches).toMatchObject([{ runId: a.runId, why: "state" }]);
  expect(s2.holds).toMatchObject([{ runId: a.runId, holdsSlot: true }]);
  expect(s3.statusQueries).toEqual([{ executorId: WORKER, runIds: [a.runId] }]);
});

test("R05 점유: 다른 종류의 실행기가 쥔 실행은 재개방 뒤에도 시작 후보가 아니고, 다른 작업은 계속 시작한다", async () => {
  const path = tempPath();
  let ledger = ready(open(path));
  const a = must(ledger.admitRun(worker())).run;
  ledger.close();
  ledger = open(path);
  const first = await restore(restorer(ledger, occupied([{ executorId: SESSION_A, coverage: "full", runs: [running(a.runId, a.runGeneration)] }])));
  expect(first.s5.queued).toEqual([]);
  expect(ledger.startRun(start(a.runId))).toEqual({ ok: false, reason: "run_blocked" });
  // 이번 응답에 불일치가 없어도 남아 있는 관측은 그대로 막는다.
  ledger.close();
  ledger = open(path);
  const second = await restore(restorer(ledger));
  expect(second.s2.occupancyMismatches).toEqual([]);
  expect(second.s5.queued).toEqual([]);
  expect(second.s5.blockedQueued).toEqual([a.runId]);
  expect(ledger.startRun(start(a.runId))).toEqual({ ok: false, reason: "run_blocked" });
  const unrelated = must(ledger.admitRun(worker())).run;
  expect(ledger.startRun(start(unrelated.runId))).toMatchObject({ ok: true });
});

test("R06 점유: 옛 세대의 종료 확인과 다시 관측되기 전의 확인은 지금의 차단을 풀지 못한다", async () => {
  const ledger = open(tempPath());
  const ghost = id();
  await restore(restorer(ledger, occupied([{ executorId: WORKER, coverage: "full", runs: [running(ghost, 1)] }])));
  await restore(restorer(ledger, occupied([{ executorId: WORKER, coverage: "full", runs: [running(ghost, 2)] }])));
  const holds = (ledger.slotHolds() as { value: { runGeneration: number; observation: number }[] }).value;
  expect(holds.map((hold) => hold.runGeneration)).toEqual([1, 2]);
  const [older, newer] = holds as [{ runGeneration: number; observation: number }, { runGeneration: number; observation: number }];
  // 세대 1의 종료 확인은 세대 1의 줄만 지운다.
  must(ledger.clearSlotHold({ executorId: WORKER, runId: ghost, runGeneration: 1, observation: older.observation }));
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  // 같은 세대를 다시 관측하면 앞선 번호의 확인은 늦게 와도 지우지 못한다.
  await restore(restorer(ledger, occupied([{ executorId: WORKER, coverage: "full", runs: [running(ghost, 2)] }])));
  expect(ledger.clearSlotHold({ executorId: WORKER, runId: ghost, runGeneration: 2, observation: newer.observation })).toEqual({ ok: false, reason: "reference_mismatch" });
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  const latest = (ledger.slotHolds() as { value: { observation: number }[] }).value[0] as { observation: number };
  must(ledger.clearSlotHold({ executorId: WORKER, runId: ghost, runGeneration: 2, observation: latest.observation }));
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: true });
});

// 세션 증거 시험의 공통 조각.
const base = { stopGeneration: 0, now: NOW, handoffRef: null, handoffDigest: null };
function ruleCheck(marker: string, permit: string) {
  const reportId = id();
  return { reportId, outcome: "rule_present" as const, firstMarkerDigest: digest(`first:${reportId}`), restartedMarkerDigest: marker, startPermitId: permit, checkedAt: NOW, bodyDigest: digest(`rc:${reportId}`), now: NOW };
}
function takeoverOf(previous: Run, marker: string, permit: string) {
  const receiptId = id();
  return { action: "receipt_session_takeover" as const, receiptId, previousRunId: previous.runId, newGenerationMarkerDigest: marker, startPermitId: permit, takenOverAt: NOW, bodyDigest: digest(`tk:${receiptId}`), now: NOW };
}
const stateOf = (ledger: Ledger, runId: string) => (ledger.getRun(runId) as { value: { state: string } }).value.state;

test("R07 세션: B의 인수와 규칙 확인이 있어도 B와 C 어느 쪽도 시작하지 못한다", () => {
  const ledger = ready(open(tempPath()));
  const a = must(ledger.admitRun(session({ executorId: SESSION_A }))).run;
  const b = must(ledger.admitRun(session({ executorId: SESSION_B }))).run;
  const c = must(ledger.admitRun(session({ executorId: SESSION_C }))).run;
  const marker = digest("marker-b");
  const permit = id();
  const takeover = takeoverOf(a, marker, permit);
  const check = ruleCheck(marker, permit);
  must(ledger.applyReceipt(takeover, { sender: SESSION_B, runGeneration: a.runGeneration }));
  must(ledger.applyRuleCheck(check, { sender: SESSION_B }));
  expect(stateOf(ledger, a.runId)).toBe("queued");
  const opening = { ...base, requestId: id(), sessionId: id(), generationMarkerDigest: marker, takeoverReceiptId: takeover.receiptId, ruleCheckId: check.reportId };
  expect(ledger.startSession({ ...opening, runId: c.runId })).toEqual({ ok: false, reason: "session_start_closed" });
  expect(stateOf(ledger, c.runId)).toBe("queued");
  expect(ledger.startSession({ ...opening, runId: b.runId })).toEqual({ ok: false, reason: "session_start_closed" });
  expect(stateOf(ledger, b.runId)).toBe("queued");
});

test("R07 세션: 첫 세션은 자기 실행기가 낸 규칙 확인이 있어도 시작하지 않는다", () => {
  const ledger = ready(open(tempPath()));
  const c = must(ledger.admitRun(session({ executorId: SESSION_C }))).run;
  const marker = digest("marker-c");
  const foreign = ruleCheck(marker, id());
  must(ledger.applyRuleCheck(foreign, { sender: SESSION_B }));
  const opening = { ...base, runId: c.runId, requestId: id(), sessionId: id(), generationMarkerDigest: marker, takeoverReceiptId: null };
  expect(ledger.startSession({ ...opening, ruleCheckId: foreign.reportId })).toEqual({ ok: false, reason: "session_start_closed" });
  const own = ruleCheck(marker, id());
  must(ledger.applyRuleCheck(own, { sender: SESSION_C }));
  expect(ledger.startSession({ ...opening, ruleCheckId: own.reportId })).toEqual({ ok: false, reason: "session_start_closed" });
  expect(stateOf(ledger, c.runId)).toBe("queued");
});

test("R07 세션: 인수와 규칙 확인은 낸 실행기별로 따로 읽히고 다른 실행기의 확인과 섞이지 않는다", () => {
  const ledger = ready(open(tempPath()));
  const a = must(ledger.admitRun(session({ executorId: SESSION_A }))).run;
  must(ledger.admitRun(session({ executorId: SESSION_B })));
  must(ledger.admitRun(session({ executorId: SESSION_C })));
  const marker = digest("marker-b");
  const permit = id();
  const takeover = takeoverOf(a, marker, permit);
  const check = ruleCheck(marker, permit);
  must(ledger.applyReceipt(takeover, { sender: SESSION_B, runGeneration: a.runGeneration }));
  must(ledger.applyRuleCheck(check, { sender: SESSION_C }));
  expect(ledger.sessionEvidence({ executorId: SESSION_B, previousRunId: a.runId })).toMatchObject({ known: true, value: { takeovers: [{ receiptId: takeover.receiptId, sender: SESSION_B }], ruleChecks: [] } });
  expect(ledger.sessionEvidence({ executorId: SESSION_C, previousRunId: a.runId })).toMatchObject({ known: true, value: { takeovers: [], ruleChecks: [{ reportId: check.reportId, sender: SESSION_C }] } });
  expect(stateOf(ledger, a.runId)).toBe("queued");
  expect(ledger.slotFree("session")).toEqual({ known: true, value: true });
});

test("R07 세션: 같은 앞 세션에 인수가 둘 와도 둘 다 증거로 남고 앞 세션을 끝내지 않으며, 재전송은 처음 낸 쪽만 ack를 받는다", () => {
  const ledger = ready(open(tempPath()));
  const a = must(ledger.admitRun(session({ executorId: SESSION_A }))).run;
  const b = must(ledger.admitRun(session({ executorId: SESSION_B }))).run;
  const c = must(ledger.admitRun(session({ executorId: SESSION_C }))).run;
  const [markerB, markerC] = [digest("marker-b"), digest("marker-c")];
  const [permitB, permitC] = [id(), id()];
  const takeoverB = takeoverOf(a, markerB, permitB);
  const takeoverC = takeoverOf(a, markerC, permitC);
  must(ledger.applyReceipt(takeoverB, { sender: SESSION_B, runGeneration: a.runGeneration }));
  must(ledger.applyReceipt(takeoverC, { sender: SESSION_C, runGeneration: a.runGeneration }));
  const checkB = ruleCheck(markerB, permitB);
  const checkC = ruleCheck(markerC, permitC);
  must(ledger.applyRuleCheck(checkB, { sender: SESSION_B }));
  expect(ledger.applyRuleCheck(checkC, { sender: SESSION_C })).toMatchObject({ ok: true, delivery: "new" });
  expect(stateOf(ledger, a.runId)).toBe("queued");
  expect((ledger.getRun(a.runId) as { value: { stopReceiptId: string | null } }).value.stopReceiptId).toBeNull();
  expect(ledger.startSession({ ...base, runId: c.runId, requestId: id(), sessionId: id(), generationMarkerDigest: markerC, takeoverReceiptId: takeoverC.receiptId, ruleCheckId: checkC.reportId })).toEqual({
    ok: false,
    reason: "session_start_closed",
  });
  expect(ledger.startSession({ ...base, runId: b.runId, requestId: id(), sessionId: id(), generationMarkerDigest: markerB, takeoverReceiptId: takeoverB.receiptId, ruleCheckId: checkB.reportId })).toEqual({
    ok: false,
    reason: "session_start_closed",
  });
  // 재전송은 처음 낸 쪽만 다시 ack를 받는다.
  expect(ledger.applyReceipt(takeoverB, { sender: SESSION_B, runGeneration: a.runGeneration })).toMatchObject({ ok: true, delivery: "duplicate" });
  expect(ledger.applyReceipt(takeoverB, { sender: SESSION_C, runGeneration: a.runGeneration })).toEqual({ ok: false, reason: "sender_mismatch" });
  expect(ledger.applyRuleCheck(checkB, { sender: SESSION_C })).toEqual({ ok: false, reason: "sender_mismatch" });
});

test("R09 열기: 비어 있지 않은 낯선 DB는 첫 설치로 받지 않고 건드리지 않는다", () => {
  const path = tempPath();
  const raw = new Database(path);
  raw.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  raw.run("INSERT INTO notes (body) VALUES ('keep')");
  raw.close();
  expect(openLedger(path, { clock, mode: "create" })).toMatchObject({ ok: false, reason: "foreign_data" });
  const after = new Database(path);
  expect(after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: "notes" }]);
  expect(after.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
  after.close();
});

test("R09 열기: 옛 스키마의 장부는 정지 기록이 있어도 첫 설치로 받지 않는다", () => {
  const path = tempPath();
  const raw = new Database(path);
  raw.run("PRAGMA journal_mode = WAL");
  raw.run("CREATE TABLE ledger_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT");
  raw.run("INSERT INTO ledger_migrations VALUES (1, '0001-core.sql', 1)");
  raw.run("CREATE TABLE stop_state (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, stopped INTEGER NOT NULL)");
  raw.run("INSERT INTO stop_state VALUES (1, 4, 1)");
  raw.close();
  expect(openLedger(path, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "not_initialized" });
  expect(openLedger(path, { clock, mode: "create" })).toMatchObject({ ok: false, reason: "foreign_data" });
  const after = new Database(path);
  expect(after.query("SELECT name FROM sqlite_master WHERE name = 'ledger_identity'").all()).toEqual([]);
  expect(after.query("SELECT generation, stopped FROM stop_state").get()).toEqual({ generation: 4, stopped: 1 });
  after.close();
});

test("R09 열기: 본체 없이 남은 WAL·SHM과 빈 본체 옆의 WAL은 첫 설치로 받지 않는다", () => {
  for (const suffix of ["-wal", "-shm"]) {
    const path = tempPath();
    writeFileSync(`${path}${suffix}`, Buffer.alloc(64, 7));
    expect(openLedger(path, { clock, mode: "create" }), suffix).toMatchObject({ ok: false, reason: "foreign_data" });
    expect(existsSync(path), suffix).toBe(false);
  }
  const empty = tempPath();
  writeFileSync(empty, "");
  writeFileSync(`${empty}-wal`, Buffer.alloc(64, 7));
  expect(openLedger(empty, { clock, mode: "create" })).toMatchObject({ ok: false, reason: "foreign_data" });
});

test("R09 열기: 새 경로는 첫 설치로 받고 다시 연 장부는 표식을 유지하며, 이미 있는 빈 파일은 받지 않는다", () => {
  const path = tempPath();
  const created = openLedger(path, { clock, mode: "create" });
  expect(created).toMatchObject({ ok: true });
  if (created.ok) created.ledger.close();
  const again = openLedger(path, { clock, mode: "reopen" });
  expect(again).toMatchObject({ ok: true });
  if (again.ok) again.ledger.close();
  const empty = tempPath();
  writeFileSync(empty, "");
  expect(openLedger(empty, { clock, mode: "create" })).toMatchObject({ ok: false, reason: "foreign_data" });
});

test("R10 시작: 목록을 낸 뒤 취소된 입력의 대기 실행은 자격을 받지 않는다", async () => {
  const ledger = ready(open(tempPath()));
  const input = id();
  must(ledger.enqueueInput(newInput(input, NOW + 60_000)));
  const run = must(ledger.admitRun(worker({ inputRequestId: input }))).run;
  const { s5 } = await restore(restorer(ledger));
  expect(s5.queued).toEqual([run.runId]);
  must(ledger.cancelInput(input, NOW));
  expect(ledger.startRun(start(run.runId))).toEqual({ ok: false, reason: "input_cancelled" });
  expect(stateOf(ledger, run.runId)).toBe("queued");
});

test("R10 시작: 원문이 실행 기한보다 먼저 만료되면 시작하지 않고 5단계 후보에서도 뺀다", async () => {
  let now = NOW;
  const ledger = ready(open(tempPath(), { clock: () => now }));
  const input = id();
  must(ledger.enqueueInput(newInput(input, NOW + 1_000)));
  const run = must(ledger.admitRun(worker({ inputRequestId: input, deadlineAt: NOW + 600_000 }))).run;
  now = NOW + 1_000;
  const { s5 } = await restore(restorer(ledger));
  expect(s5.queued).toEqual([]);
  expect(s5.expiredQueued).toEqual([run.runId]);
  expect(ledger.startRun(start(run.runId))).toEqual({ ok: false, reason: "input_expired" });
});

test("R10 시작: 기한은 호출자가 넘긴 시각이 아니라 장부의 시계로 잰다", () => {
  let now = NOW;
  const ledger = ready(open(tempPath(), { clock: () => now }));
  const run = must(ledger.admitRun(worker({ deadlineAt: NOW + 100 }))).run;
  now = NOW + 101;
  expect(ledger.startRun({ runId: run.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "deadline_passed" });
  expect(stateOf(ledger, run.runId)).toBe("queued");
});

test("R10 시작: 입력 없는 내부 실행과 아직 대기 중인 정상 입력의 실행은 시작한다", () => {
  const ledger = ready(open(tempPath()));
  const input = id();
  must(ledger.enqueueInput(newInput(input, NOW + 60_000)));
  const internal = must(ledger.admitRun(worker())).run;
  expect(ledger.startRun(start(internal.runId))).toMatchObject({ ok: true });
  const other = ready(open(tempPath()));
  must(other.enqueueInput(newInput(input, NOW + 60_000)));
  const linked = must(other.admitRun(worker({ inputRequestId: input }))).run;
  expect(other.startRun(start(linked.runId))).toMatchObject({ ok: true });
});
