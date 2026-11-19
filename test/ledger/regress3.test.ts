// 파일 소유권, 실행 ID의 퇴역, 닫힌 세션 시작, 5단계의 한 시각, 증거 행의 보호를 경계 순서로 만든다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunStatus } from "../../src/contract/v1/index.ts";
import { type Ledger, type OccupancyAnswer, openLedger, type RestorePorts, Restorer } from "../../src/ledger/index.ts";
import { clock, digest, id, must, NOW, open, ready, session, tempDir, tempPath, worker } from "./helpers.ts";

const WORKER = "executor/diagnosis/0/store-a";
const SESSION = "executor/session/0/store-s";
const OTHER_SESSION = "executor/session/1/store-b";
const PEERS = ["front-door"];
const OLV1 = 0x4f4c5631;

function ports(answers: OccupancyAnswer[] = []): RestorePorts {
  return {
    stopAuthority: { latestStop: async () => null },
    // PEERS는 현관 하나다. 현관은 v2와 맞은 정책으로 답해야 맞은 응답이다.
    peers: { contracts: async () => PEERS.map((peer) => ({ peer, contract: "olive-control/v2", policy: "match" as const })) },
    occupancy: { occupancy: async () => answers },
    publications: { lookup: async () => ({ kind: "pending" as const }) },
  };
}

async function restore(ledger: Ledger, answers: OccupancyAnswer[] = [], restorerClock: () => number = clock) {
  const r = new Restorer(ledger, ports(answers), restorerClock, { requiredPeers: PEERS });
  return { s1: await r.step1(), s2: await r.step2(), s3: await r.step3(), s4: await r.step4(), s5: await r.step5() };
}

const status = (runId: string, state: RunStatus["state"], generation = 1): RunStatus => ({ run_id: runId, state, run_generation: generation, last_receipt_id: null });
const full = (executorId: string, runs: RunStatus[]): OccupancyAnswer => ({ executorId, coverage: "full", runs });
const start = (runId: string) => ({ runId, requestId: id(), stopGeneration: 0, now: NOW });
const stateOf = (ledger: Ledger, runId: string) => (ledger.getRun(runId) as { value: { state: string } }).value.state;

// 다른 프로세스가 장부에 실제로 쓰려고 할 때의 결과.
function writeFromChild(path: string): string {
  const script = `
    import { Database } from "bun:sqlite";
    try {
      const db = new Database(${JSON.stringify(path)});
      db.run("PRAGMA busy_timeout = 0");
      db.run("BEGIN IMMEDIATE");
      db.run("CREATE TABLE intruder (x INTEGER)");
      db.run("COMMIT");
      console.log("WROTE");
    } catch (error) {
      console.log(error.code);
    }
  `;
  return Bun.spawnSync([process.execPath, "-e", script]).stdout.toString().trim();
}

for (const mode of ["reopen", "create"] as const) {
  test(`G01 잠금: 같은 프로세스의 둘째 열기(${mode})를 거절한 뒤에도 첫 작성자가 다른 프로세스의 쓰기를 막는다`, () => {
    const path = tempPath();
    const first = open(path);
    must(first.applyStop({ generation: 1, stopped: false, now: NOW }));
    expect(openLedger(path, { clock, mode })).toMatchObject({ ok: false });
    expect(writeFromChild(path)).toBe("SQLITE_BUSY");
    expect(first.health()).toEqual({ writable: true });
    must(first.applyStop({ generation: 2, stopped: false, now: NOW }));
  });
}

test("G02 실행 ID: 끝났다고 답한 대기 실행은 관측을 해제해도 다시 시작하지 않는다", async () => {
  const ledger = ready(open(tempPath()));
  const a = must(ledger.admitRun(worker())).run;
  const first = await restore(ledger, [full(WORKER, [status(a.runId, "finalized", a.runGeneration)])]);
  const hold = first.s2.holds[0] as { observation: number };
  must(ledger.clearSlotHold({ executorId: WORKER, runId: a.runId, runGeneration: a.runGeneration, observation: hold.observation }));
  expect(ledger.startRun(start(a.runId))).toEqual({ ok: false, reason: "run_blocked" });
  const again = await restore(ledger);
  expect(again.s5.queued).toEqual([]);
  expect(again.s5.blockedQueued).toEqual([a.runId]);
  expect(ledger.startRun(start(a.runId))).toEqual({ ok: false, reason: "run_blocked" });
  expect(stateOf(ledger, a.runId)).toBe("queued");
});

test("G02 실행 ID: 활동 관측을 해제하면 슬롯은 돌아오고 그 실행 ID는 계속 막힌다", async () => {
  const ledger = ready(open(tempPath()));
  const ghost = id();
  const { s2 } = await restore(ledger, [full(WORKER, [status(ghost, "running")])]);
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  must(ledger.clearSlotHold({ executorId: WORKER, runId: ghost, runGeneration: 1, observation: (s2.holds[0] as { observation: number }).observation }));
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: true });
  expect(ledger.slotHolds()).toEqual({ known: true, value: [] });
  const late = must(ledger.admitRun(worker({ runId: ghost }))).run;
  expect(ledger.startRun(start(late.runId))).toEqual({ ok: false, reason: "run_blocked" });
  // 슬롯은 돌아왔으므로 관계없는 실행은 시작한다.
  const other = must(ledger.admitRun(worker())).run;
  expect(ledger.startRun(start(other.runId))).toMatchObject({ ok: true });
});

test("G02 실행 ID: 장부 밖 실행이 끝났다는 관측도 재시작 뒤 접수한 같은 ID의 시작을 막고 슬롯은 막지 않는다", async () => {
  const path = tempPath();
  let ledger = ready(open(path));
  const ended = id();
  await restore(ledger, [full(WORKER, [status(ended, "finalized")])]);
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: true });
  ledger.close();
  ledger = open(path);
  await restore(ledger);
  const late = must(ledger.admitRun(worker({ runId: ended }))).run;
  expect(ledger.startRun(start(late.runId))).toEqual({ ok: false, reason: "run_blocked" });
});

test("R06 점유: 마지막 줄을 같은 관측으로 바꿔 적어도 번호는 다시 쓰이지 않고 앞선 번호의 해제는 슬롯을 돌려주지 못한다", async () => {
  const ledger = ready(open(tempPath()));
  const ghost = id();
  const answers = [full(WORKER, [status(ghost, "running")])];
  const first = ((await restore(ledger, answers)).s2.holds[0] as { observation: number }).observation;
  const second = ((await restore(ledger, answers)).s2.holds[0] as { observation: number }).observation;
  expect(second).toBeGreaterThan(first);
  expect(ledger.clearSlotHold({ executorId: WORKER, runId: ghost, runGeneration: 1, observation: first })).toEqual({ ok: false, reason: "reference_mismatch" });
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
});

test("G02 실행 ID: 슬롯 종류를 모르는 실행기가 끝났다고 답한 장부 밖 실행은 적을 수 없으므로 접수를 보류한다", async () => {
  const ledger = ready(open(tempPath()));
  const { s2, s5 } = await restore(ledger, [full("someone", [status(id(), "finalized")])]);
  expect(s2.unresolvedExecutors).toEqual(["someone"]);
  expect(s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["occupancy_unresolved"] });
});

// 세션 증거 시험의 공통 조각.
const opening = { stopGeneration: 0, now: NOW, handoffRef: null, handoffDigest: null };
function ruleCheck(marker: string, permit: string) {
  const reportId = id();
  return { reportId, outcome: "rule_present" as const, firstMarkerDigest: digest(`first:${reportId}`), restartedMarkerDigest: marker, startPermitId: permit, checkedAt: NOW, bodyDigest: digest(`rc:${reportId}`), now: NOW };
}
function takeoverOf(previousRunId: string, marker: string, permit: string) {
  const receiptId = id();
  return { action: "receipt_session_takeover" as const, receiptId, previousRunId, newGenerationMarkerDigest: marker, startPermitId: permit, takenOverAt: NOW, bodyDigest: digest(`tk:${receiptId}`), now: NOW };
}

// 앞 세션을 열고(열 수 있으면) 종료를 지시한 뒤, 다음 세대의 인수와 규칙 확인을 받아 적는다.
function handover(ledger: Ledger) {
  const previous = must(ledger.admitRun(session())).run;
  const firstMarker = digest("marker-first");
  const firstCheck = ruleCheck(firstMarker, id());
  must(ledger.applyRuleCheck(firstCheck, { sender: SESSION }));
  ledger.startSession({ ...opening, runId: previous.runId, requestId: id(), sessionId: id(), generationMarkerDigest: firstMarker, takeoverReceiptId: null, ruleCheckId: firstCheck.reportId });
  must(ledger.recordStopInstruction({ runId: previous.runId, requestId: id(), action: "session_stop", stopGeneration: 0, now: NOW }));
  const marker = digest("marker-next");
  const permit = id();
  const takeover = takeoverOf(previous.runId, marker, permit);
  const check = ruleCheck(marker, permit);
  must(ledger.applyReceipt(takeover, { sender: SESSION, runGeneration: previous.runGeneration }));
  must(ledger.applyRuleCheck(check, { sender: SESSION }));
  const startInput = { ...opening, requestId: id(), sessionId: id(), generationMarkerDigest: marker, takeoverReceiptId: takeover.receiptId, ruleCheckId: check.reportId };
  return { previous, takeover, check, startInput };
}

test("G03 세션: 인수를 받은 뒤 접수한 같은 실행기의 다른 실행은 그 인수로 자격 참조를 받지 못한다", () => {
  const ledger = ready(open(tempPath()));
  must(ledger.admitRun(session()));
  const { startInput } = handover(ledger);
  const credential = { account: "acct-c", method: "api_key", revision: "cred-9", digest: digest("other credential") };
  const late = must(ledger.admitRun(session({ credential }))).run;
  expect(ledger.startSession({ ...startInput, runId: late.runId })).toEqual({ ok: false, reason: "session_start_closed" });
  expect(stateOf(ledger, late.runId)).toBe("queued");
});

test("G04 세션: 인수를 ack한 뒤 재시작해도 그 증거로 다음 세션의 자격 참조를 내지 않는다", async () => {
  const path = tempPath();
  let ledger = ready(open(path));
  const next = must(ledger.admitRun(session())).run;
  const { startInput } = handover(ledger);
  ledger.close();
  ledger = open(path);
  await restore(ledger);
  expect(ledger.startSession({ ...startInput, runId: next.runId })).toEqual({ ok: false, reason: "session_start_closed" });
  expect(stateOf(ledger, next.runId)).toBe("queued");
});

test("G04 세션: 앞 세션이 없는 첫 세션의 시작도 닫혀 있고 슬롯과 지시를 남기지 않는다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const run = must(ledger.admitRun(session())).run;
  const marker = digest("marker");
  const check = ruleCheck(marker, id());
  must(ledger.applyRuleCheck(check, { sender: SESSION }));
  expect(ledger.startSession({ ...opening, runId: run.runId, requestId: id(), sessionId: id(), generationMarkerDigest: marker, takeoverReceiptId: null, ruleCheckId: check.reportId })).toEqual({ ok: false, reason: "session_start_closed" });
  expect(ledger.slotFree("session")).toEqual({ known: true, value: true });
  ledger.close();
  const raw = new Database(path);
  expect(raw.query("SELECT COUNT(*) AS n FROM instructions").get()).toEqual({ n: 0 });
  expect(raw.query("SELECT COUNT(*) AS n FROM start_permit_uses").get()).toEqual({ n: 0 });
  raw.close();
});

test("G04 세션: 받아 적은 인수·규칙 확인·훅·세션 깨짐 보고를 재시작 뒤 실행기와 앞 실행 기준으로 읽는다", () => {
  const path = tempPath();
  let ledger = ready(open(path));
  const { previous, takeover, check } = handover(ledger);
  const unrelated = must(ledger.admitRun(session({ executorId: OTHER_SESSION }))).run;
  const foreignTakeover = takeoverOf(unrelated.runId, digest("marker-other"), id());
  must(ledger.applyReceipt(foreignTakeover, { sender: OTHER_SESSION, runGeneration: unrelated.runGeneration }));
  const from = { sender: SESSION, runGeneration: previous.runGeneration };
  const hookSignal = { kind: "hook" as const, event: "Stop" as const, sessionId: id(), turnId: id(), stopFailure: null, observedAt: NOW };
  const brokenSignal = { kind: "session_broken" as const, cause: "relay_lost" as const, markerDigest: digest("marker-first"), observedAt: NOW };
  const hook = { reportId: id(), action: "report_hook_event" as const, runId: previous.runId, bodyDigest: digest("hook"), storedRef: null, resultDigest: null, signal: hookSignal, now: NOW };
  const broken = { reportId: id(), action: "report_session_broken" as const, runId: previous.runId, bodyDigest: digest("broken"), storedRef: null, resultDigest: null, signal: brokenSignal, now: NOW };
  must(ledger.recordReport(hook, from));
  must(ledger.recordReport(broken, from));
  must(ledger.settleReport({ reportId: hook.reportId, now: NOW }));
  ledger.close();
  ledger = open(path);
  const read = ledger.sessionEvidence({ executorId: SESSION, previousRunId: previous.runId });
  if (!read.known) throw new Error("읽지 못함");
  expect(read.value.takeovers).toEqual([
    { receiptId: takeover.receiptId, previousRunId: previous.runId, sender: SESSION, newGenerationMarkerDigest: takeover.newGenerationMarkerDigest, startPermitId: takeover.startPermitId, takenOverAt: NOW },
  ]);
  expect(read.value.ruleChecks.map((row) => row.reportId)).toContain(check.reportId);
  expect(read.value.ruleChecks.find((row) => row.reportId === check.reportId)).toEqual({
    reportId: check.reportId,
    sender: SESSION,
    outcome: "rule_present",
    firstMarkerDigest: check.firstMarkerDigest,
    restartedMarkerDigest: check.restartedMarkerDigest,
    startPermitId: check.startPermitId,
    checkedAt: NOW,
  });
  const reports = new Map(read.value.reports.map((row) => [row.reportId, row]));
  expect(reports.get(hook.reportId)).toEqual({ reportId: hook.reportId, action: "report_hook_event", runId: previous.runId, settled: true, signal: hookSignal });
  expect(reports.get(broken.reportId)).toEqual({ reportId: broken.reportId, action: "report_session_broken", runId: previous.runId, settled: false, signal: brokenSignal });
  // 다른 실행기의 증거는 섞이지 않고, 앞 실행을 좁히면 다른 앞 실행의 인수가 빠진다.
  const other = ledger.sessionEvidence({ executorId: OTHER_SESSION, previousRunId: null });
  expect(other).toMatchObject({ known: true, value: { takeovers: [{ receiptId: foreignTakeover.receiptId }], ruleChecks: [], reports: [] } });
  expect(ledger.sessionEvidence({ executorId: OTHER_SESSION, previousRunId: previous.runId })).toMatchObject({ value: { takeovers: [] } });
});

test("G04 세션: 받아 적어도 앞 세션을 끝내지 않고, 재전송은 처음 낸 쪽만 ack를 받으며 같은 허가의 다른 인수는 적지 않는다", () => {
  const ledger = ready(open(tempPath()));
  const previous = must(ledger.admitRun(session())).run;
  must(ledger.admitRun(session({ executorId: OTHER_SESSION })));
  const from = { sender: SESSION, runGeneration: previous.runGeneration };
  const permit = id();
  const takeover = takeoverOf(previous.runId, digest("marker"), permit);
  const check = ruleCheck(digest("marker"), permit);
  expect(ledger.applyReceipt(takeover, from)).toMatchObject({ ok: true, delivery: "new" });
  expect(ledger.applyRuleCheck(check, { sender: SESSION })).toMatchObject({ ok: true, delivery: "new" });
  expect(stateOf(ledger, previous.runId)).toBe("queued");
  expect((ledger.getRun(previous.runId) as { value: { stopReceiptId: string | null } }).value.stopReceiptId).toBeNull();
  expect(ledger.applyReceipt(takeover, from)).toMatchObject({ ok: true, delivery: "duplicate" });
  expect(ledger.applyReceipt(takeover, { ...from, sender: OTHER_SESSION })).toEqual({ ok: false, reason: "sender_mismatch" });
  expect(ledger.applyRuleCheck(check, { sender: OTHER_SESSION })).toEqual({ ok: false, reason: "sender_mismatch" });
  expect(ledger.applyReceipt({ ...takeoverOf(previous.runId, digest("marker-2"), permit) }, from)).toEqual({ ok: false, reason: "permit_used" });
  // 앞 실행의 지정 실행기도 대기 중인 세션의 실행기도 아니면 적지 않는다.
  expect(ledger.applyReceipt(takeoverOf(previous.runId, digest("marker-3"), id()), { ...from, sender: "executor/session/9/store-z" })).toEqual({ ok: false, reason: "sender_mismatch" });
  expect(ledger.applyReceipt(takeoverOf(previous.runId, digest("marker-4"), id()), { ...from, runGeneration: 2 })).toEqual({ ok: false, reason: "run_generation_mismatch" });
});

// 이 설치의 표식을 가진 SQLite 파일을 만든다(저널 모드, 연결을 닫아 곁 파일이 남지 않는다).
function markedFile(path: string, build: (raw: Database) => void): Buffer {
  const raw = new Database(path);
  raw.run(`PRAGMA application_id = ${OLV1}`);
  build(raw);
  raw.close();
  return readFileSync(path);
}

test("G05 열기: 끊어진 링크 뒤의 create는 링크 대상을 만들지 않는다", () => {
  const dir = tempDir();
  const target = join(dir, "real.db");
  const path = join(dir, "ledger.db");
  symlinkSync(target, path);
  expect(openLedger(path, { clock, mode: "create" })).toMatchObject({ ok: false, reason: "foreign_data" });
  expect(existsSync(target)).toBe(false);
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
});

test("G05 열기: 링크로 가리킨 장부와 링크인 곁 파일, 링크가 낀 폴더는 받지 않는다", () => {
  const dir = tempDir();
  const real = join(dir, "real.db");
  open(real).close();
  const alias = join(dir, "alias.db");
  symlinkSync(real, alias);
  expect(openLedger(alias, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "not_initialized" });
  const linkedDir = join(dir, "linked");
  symlinkSync(dir, linkedDir);
  expect(openLedger(join(linkedDir, "real.db"), { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "not_initialized" });
  symlinkSync(join(dir, "elsewhere-wal"), `${real}-wal`);
  expect(openLedger(real, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "not_initialized" });
  expect(existsSync(join(dir, "elsewhere-wal"))).toBe(false);
});

test("G05 열기: 하드 링크로 이름이 둘인 장부는 받지 않는다", () => {
  const dir = tempDir();
  const real = join(dir, "real.db");
  open(real).close();
  linkSync(real, join(dir, "second.db"));
  expect(openLedger(real, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "not_initialized" });
});

test("G05 열기: 표식은 맞고 첫 설치 기록이 없는 파일에 표 밖의 개체가 있으면 받지 않고 바꾸지 않는다", () => {
  const path = tempPath();
  const before = markedFile(path, (raw) => raw.run("CREATE VIEW notes AS SELECT 1 AS x"));
  expect(openLedger(path, { clock, mode: "create" })).toMatchObject({ ok: false, reason: "foreign_data" });
  expect(readFileSync(path).equals(before)).toBe(true);
  expect(existsSync(`${path}-wal`)).toBe(false);
});

test("G05 열기: 같은 이름·판의 적용 행만 있는 파일은 끊긴 첫 설치로 받지 않고 바꾸지 않는다", () => {
  const path = tempPath();
  const before = markedFile(path, (raw) => {
    raw.run("CREATE TABLE ledger_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT");
    raw.run("INSERT INTO ledger_migrations VALUES (1, '0001-core.sql', 1)");
  });
  expect(openLedger(path, { clock, mode: "create" })).toMatchObject({ ok: false, reason: "foreign_data" });
  expect(readFileSync(path).equals(before)).toBe(true);
  expect(existsSync(`${path}-wal`)).toBe(false);
});

test("G05 열기: 이미 있는 빈 파일은 이 설치가 예약했다는 증거가 없어 create가 받지 않는다", () => {
  const path = tempPath();
  writeFileSync(path, "");
  expect(openLedger(path, { clock, mode: "create" })).toMatchObject({ ok: false, reason: "foreign_data" });
  expect(readFileSync(path).length).toBe(0);
});

test("G05 열기: 끊긴 첫 설치와 스키마가 같아도 업무 기록이 한 줄 있으면 받지 않는다", () => {
  const path = tempPath();
  const fixed = [
    { version: 1, name: "0001-a.sql", sql: "CREATE TABLE a (x INTEGER) STRICT;" },
    { version: 2, name: "0002-b.sql", sql: "CREATE TABLE b (x INTEGER) STRICT;" },
  ];
  // 둘째 판의 커밋 직전에 끊어 첫 판까지만 적용된 파일을 만든다.
  const faults = {
    at(point: string) {
      if (point === "migration:2") throw new Error("주입한 실패");
    },
  };
  expect(openLedger(path, { clock, mode: "create", migrations: fixed, faults })).toMatchObject({ ok: false, reason: "migration_failed" });
  const raw = new Database(path);
  raw.run("INSERT INTO a VALUES (7)");
  raw.close();
  const before = readFileSync(path);
  expect(openLedger(path, { clock, mode: "create", migrations: fixed })).toMatchObject({ ok: false, reason: "foreign_data" });
  expect(readFileSync(path).equals(before)).toBe(true);
});

test("G05 열기: 판정한 뒤 경로가 낯선 파일로 바뀌면 그 파일을 쓰지 않는다", () => {
  const dir = tempDir();
  const path = join(dir, "ledger.db");
  const foreign = join(dir, "foreign.db");
  const raw = new Database(foreign);
  raw.run("CREATE TABLE notes (x INTEGER)");
  raw.close();
  const before = readFileSync(foreign);
  const swap = (point: string) => {
    if (point === "open:inspected") renameSync(foreign, path);
  };
  expect(openLedger(path, { clock, mode: "create", faults: { at: swap } })).toMatchObject({ ok: false, reason: "foreign_data" });
  expect(readFileSync(path).equals(before)).toBe(true);
  expect(existsSync(`${path}-wal`)).toBe(false);
});

test("G05 열기: 새로 만든 장부는 정규 파일이고 첫 설치를 마치면 WAL로 동작한다", () => {
  const path = tempPath();
  const created = openLedger(path, { clock, mode: "create" });
  if (!created.ok) throw new Error(created.detail);
  created.ledger.close();
  expect(lstatSync(path).isFile()).toBe(true);
  const raw = new Database(path);
  expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(raw.query("PRAGMA application_id").get()).toEqual({ application_id: OLV1 });
  raw.close();
});

test("G06 5단계: 장부 시계로 만료된 입력은 복원기의 시계가 늦어도 전달 대기로 나오지 않는다", async () => {
  let now = NOW;
  const ledger = ready(open(tempPath(), { clock: () => now }));
  const input = id();
  must(ledger.enqueueInput({ requestId: input, source: "discord", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 1_000 }, receivedAt: NOW }));
  const run = must(ledger.admitRun(worker({ inputRequestId: input, deadlineAt: NOW + 600_000 }))).run;
  now = NOW + 1_000;
  const { s5 } = await restore(ledger, [], () => NOW);
  expect(s5.expiredQueued).toEqual([run.runId]);
  expect(s5.inputs.pending).toEqual([]);
  expect(s5.inputs.expired).toEqual([input]);
});

test("G06 시작: 발행 시각은 기한을 판정한 장부의 시각이고 호출자의 시각이 아니다", () => {
  let now = NOW;
  const path = tempPath();
  const ledger = ready(open(path, { clock: () => now }));
  const run = must(ledger.admitRun(worker({ deadlineAt: NOW + 120 }))).run;
  now = NOW + 119;
  must(ledger.startRun({ runId: run.runId, requestId: id(), stopGeneration: 0, now: NOW + 120 }));
  ledger.close();
  const raw = new Database(path);
  expect(raw.query("SELECT issued_at FROM instructions").get()).toEqual({ issued_at: NOW + 119 });
  expect(raw.query("SELECT updated_at FROM runs").get()).toEqual({ updated_at: NOW + 119 });
  raw.close();
});

test("G06 시계: 장부의 시계를 믿을 수 없으면 입력과 실행을 모두 만료로 보고 시작하지 않는다", async () => {
  let now = NOW;
  const ledger = ready(open(tempPath(), { clock: () => now }));
  const input = id();
  must(ledger.enqueueInput({ requestId: input, source: "discord", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 1_000 }, receivedAt: NOW }));
  const run = must(ledger.admitRun(worker({ inputRequestId: input }))).run;
  now = Number.NaN;
  const { s5 } = await restore(ledger);
  expect(s5.queued).toEqual([]);
  expect(s5.expiredQueued).toEqual([run.runId]);
  expect(s5.inputs).toMatchObject({ pending: [], expired: [input] });
  expect(ledger.startRun(start(run.runId))).toEqual({ ok: false, reason: "input_expired" });
});

test("G07 증거: 보조 고유 키가 부딪히는 REPLACE는 교체 기록과 실행 줄을 지우지 못한다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  const previous = must(ledger.admitRun(session())).run;
  const from = { sender: SESSION, runGeneration: previous.runGeneration };
  const [first, second] = [takeoverOf(previous.runId, digest("m1"), id()), takeoverOf(previous.runId, digest("m2"), id())];
  must(ledger.applyReceipt(first, from));
  must(ledger.applyReceipt(second, from));
  const check = ruleCheck(digest("m1"), first.startPermitId);
  must(ledger.applyRuleCheck(check, { sender: SESSION }));
  const a = must(ledger.admitRun(worker({ dedupeKey: "key-a" }))).run;
  const b = must(ledger.admitRun(worker({ dedupeKey: "key-b" }))).run;
  must(ledger.startRun(start(a.runId)));
  ledger.close();
  const raw = new Database(path);
  const count = (table: string) => (raw.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const confirm = raw.query("UPDATE session_takeovers SET confirmed_at = 1, rule_check_id = ?, next_run_id = ? WHERE receipt_id = ?");
  confirm.run(check.reportId, b.runId, first.receiptId);
  expect(() => raw.query("UPDATE OR REPLACE session_takeovers SET confirmed_at = 1, rule_check_id = ? WHERE receipt_id = ?").run(check.reportId, second.receiptId)).toThrow("takeover_fixed");
  expect(() => raw.query("UPDATE OR REPLACE session_takeovers SET next_run_id = ? WHERE receipt_id = ?").run(b.runId, second.receiptId)).toThrow("takeover_fixed");
  const insert = "INSERT OR REPLACE INTO session_takeovers (receipt_id, previous_run_id, sender, new_generation_marker_digest, start_permit_id, taken_over_at, confirmed_at, rule_check_id, next_run_id) VALUES (?, ?, 's', 'm', ?, 1, ?, ?, ?)";
  expect(() => raw.query(insert).run(id(), previous.runId, id(), null, null, b.runId)).toThrow("takeover_fixed");
  expect(() => raw.query(insert).run(id(), previous.runId, id(), 1, check.reportId, null)).toThrow("takeover_fixed");
  expect(count("session_takeovers")).toBe(2);
  expect(() => raw.query("UPDATE OR REPLACE runs SET queue_seq = ? WHERE run_id = ?").run(a.queueSeq, b.runId)).toThrow("run_evidence_mismatch");
  expect(() => raw.query("UPDATE OR REPLACE runs SET dedupe_key = 'key-a' WHERE run_id = ?").run(b.runId)).toThrow("run_evidence_mismatch");
  expect(() => raw.query("UPDATE OR REPLACE runs SET state = 'preparing' WHERE run_id = ?").run(b.runId)).toThrow("UNIQUE constraint failed: runs.kind");
  expect(count("runs")).toBe(3);
  expect(raw.query("SELECT state FROM runs WHERE run_id = ?").get(a.runId)).toEqual({ state: "preparing" });
  raw.close();
});

test("G08 충돌: ack 없이 되풀이되는 같은 충돌은 한 줄이고 다른 내용의 충돌은 따로 남는다", () => {
  const ledger = ready(open(tempPath()));
  const run = must(ledger.admitRun(worker())).run;
  must(ledger.startRun(start(run.runId)));
  const from = { sender: WORKER, runGeneration: run.runGeneration };
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: run.runId, exit: "completed", bodyDigest: digest("stop"), now: NOW }, from));
  must(ledger.markResult({ runId: run.runId, resultDigest: digest("kept"), now: NOW }));
  const late = { reportId: id(), action: "report_result" as const, runId: run.runId, bodyDigest: digest("late"), storedRef: `results/${id()}`, resultDigest: digest("other"), now: NOW };
  for (let i = 0; i < 3; i++) expect(ledger.recordReport(late, from)).toEqual({ ok: false, reason: "receipt_conflict" });
  expect(ledger.conflicts()).toEqual({ known: true, value: [{ id: late.reportId, firstDigest: digest("kept"), otherDigest: digest("other") }] });
  const accepted = { action: "receipt_stopped" as const, receiptId: id(), runId: run.runId, exit: "completed" as const, bodyDigest: digest("one"), now: NOW };
  must(ledger.applyReceipt(accepted, from));
  for (let i = 0; i < 3; i++) expect(ledger.applyReceipt({ ...accepted, bodyDigest: digest("two") }, from)).toEqual({ ok: false, reason: "receipt_conflict" });
  expect(ledger.applyReceipt({ ...accepted, bodyDigest: digest("three") }, from)).toEqual({ ok: false, reason: "receipt_conflict" });
  expect((ledger.conflicts() as { value: unknown[] }).value).toHaveLength(3);
});
