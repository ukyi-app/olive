// 조립(boot.ts)이 결과 검사 박자를 순서기에 잇는 자리. 실제 장부·실제 박자 여섯으로, 5단계를 받아들인 감독의 장부에 checking 실행과
// 결과 보고를 적고 박자를 돌린다. 판정 뒤 같은 박자의 수명 박자가 확정을 적는 것과, digest 충돌의 경보가 실행마다 한 줄인 것과,
// 보고 없이 기한이 지난 실행의 결과 없음 판정(D-113)이 경보 한 줄과 실패 확정으로 이어지는 것과, 그 기한을 복원 5단계를 받아들인 때와
// 실행기 연결이 인정된 때부터도 세고 이 프로세스의 단조 경과로도 보는 것(D-123)을 본다. 장부 시계는 조립 세계의 벽시계(w.wall)이고
// 단조 시계는 손으로 돌리는 시계(w.time)다: 박자(beat)는 단조 시계만 박자 간격만큼 옮긴다.
import { describe, expect, test } from "bun:test";
import { limits, parsePrincipal } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import { KEEPALIVE_DETECT_MS, RESULT_CHECK } from "../../../src/main/supervisor.ts";
import type { BootResult, SupervisorSettings } from "../../../src/supervisor/runtime/boot.ts";
import { KEEPALIVE_USER_TIMEOUT_MS } from "../../../src/transport/keepalive.ts";
import { digest, from, id, must, worker } from "../../ledger/helpers.ts";
import { EXECUTOR, FRONT_ROWS, WALL, type World, world } from "./boot-world.ts";

async function booted(settings: Partial<SupervisorSettings> = {}) {
  const w = world({ settings });
  const result: BootResult = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  await w.time.flush();
  for (let i = 0; i < 20 && !w.events.some((e) => e.event === "restore_step" && e.fields.step === 5); i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
  const ledger = w.opened;
  if (ledger === null) throw new Error("장부를 열지 않았다");
  return { w, run: result.running, ledger, beat: () => w.time.advance(w.settings.timing.beatEveryMs) };
}

// 작업자 실행을 at에 시작·접수하고 at + 1의 completed 종료 영수증으로 checking까지 옮긴다.
function checking(ledger: Ledger, at = WALL) {
  const run = must(ledger.admitRun(worker({ now: at, deadlineAt: at + 600_000 }))).run;
  const requestId = id();
  must(ledger.startRun({ runId: run.runId, requestId, stopGeneration: 0, now: at }));
  const sender = from(run);
  must(ledger.applyReceipt({ action: "receipt_accepted", instruction: "task_start", receiptId: id(), runId: run.runId, instructionRequestId: requestId, bodyDigest: digest(`accepted:${run.runId}`), now: at }, sender));
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: run.runId, exit: "completed", bodyDigest: digest(`stopped:${run.runId}`), now: at + 1 }, sender));
  return { runId: run.runId, from: sender };
}

function report(ledger: Ledger, run: ReturnType<typeof checking>, body: string, at = WALL + 2) {
  const reportId = id();
  must(ledger.recordReport({ reportId, action: "report_result", runId: run.runId, bodyDigest: digest(`report:${reportId}`), storedRef: `results/${id()}`, resultDigest: digest(body), signal: null, now: at }, run.from));
  return reportId;
}

// 가짜 서버가 그 실행기의 연결 하나(번호 7)를 지금 인정한 것으로 두고, 판단이 그 연결을 greeted로 옮긴 순간처럼 배정 후보를 조립의
// deliver로 넘긴다. 조립은 그 순간의 장부 시각(지금의 w.wall)과 단조 시각을 인정 시각으로 적는다. helloAt은 연결 표의 greeting.at(인사
// 바이트를 받은 시각)이다: 서명 검증을 기다린 만큼 인정보다 이르고, 조립은 이 값을 기한에 쓰지 않는다.
function greet(w: World, helloAt = w.wall) {
  const server = w.fake.server as unknown as { table: () => object; recognized: (executorId: string) => number | null };
  const base = server.table();
  server.recognized = (executorId) => (executorId === EXECUTOR ? 7 : null);
  server.table = () => ({ ...base, get: (connection: number) => (connection === 7 ? { greeting: { at: helloAt } } : undefined) });
  const candidate = { connection: 7, target: "store-a", principal: parsePrincipal(EXECUTOR), keyId: "k1", hello: { profile_revision: "p", policy_revision: "p" } };
  w.fake.options!.deliver({ kind: "candidate", connection: 7, candidate } as never);
}

// 그 실행기가 지금 인정된 연결 7에서 상태 조회 하나에 답한 것으로 둔다. 조회는 조립이 내보내기 포트에 넘긴 등록부에 지금 등록하고(조립은
// 등록하는 순간의 w.wall과 단조 시각을 그 조회를 실은 때로 적는다), 답(status_report)은 연결 판단이 검증해 넘긴 꼴로 조립의 deliver에 넣는다.
// 수명 박자가 실제로 싣는 조회는 가짜 서버가 싣지 못한다(not_recognized). 실제 조회의 송수신은 boot-relay.test.ts가 본다.
function answer(w: World, runId: string) {
  const requestId = id();
  w.captured.sink!.ports.queries.add({ requestId, recipient: EXECUTOR, runIds: [runId], connection: 7 });
  const read = w.opened!.getRun(runId);
  if (!read.known || read.value === null) throw new Error("실행 없음");
  const runs = [{ run_id: runId, state: "failed_stopped", run_generation: read.value.runGeneration, last_receipt_id: null }];
  const header = { sender: EXECUTOR, action: "status_report", run_generation: 0, body_digest: digest(`status:${requestId}`), issued_at: w.wall };
  w.fake.options!.deliver({ kind: "forward", connection: 7, verified: { ok: true, action: "status_report", header, body: { in_reply_to: requestId, runs } } } as never);
  return requestId;
}

// 그 실행기가 지금 인정된 연결 7에서 runIds를 묻는 조회 하나를 실었다(등록부에 등록). 요청 ID를 돌려준다.
function ask(w: World, runIds: string[]) {
  const requestId = id();
  w.captured.sink!.ports.queries.add({ requestId, recipient: EXECUTOR, runIds, connection: 7 });
  return requestId;
}

// 그 조회에 실행기가 답한다(연결 판단이 검증해 넘긴 꼴). 등록하지 않는다.
function replyTo(w: World, requestId: string, runs: { run_id: string; state: string; run_generation: number | null }[]) {
  const header = { sender: EXECUTOR, action: "status_report", run_generation: 0, body_digest: digest(`status:${requestId}:${w.wall}`), issued_at: w.wall };
  const body = { in_reply_to: requestId, runs: runs.map((run) => ({ ...run, last_receipt_id: null })) };
  w.fake.options!.deliver({ kind: "forward", connection: 7, verified: { ok: true, action: "status_report", header, body } } as never);
}

const generationOf = (w: World, runId: string) => {
  const read = w.opened!.getRun(runId);
  if (!read.known || read.value === null) throw new Error("실행 없음");
  return read.value.runGeneration;
};

// 조립이 답 줄의 기록기로 넘긴 함수에 영수증 처리 결과 하나를 넣는다(답 줄이 결과 보고를 처리한 뒤 부르는 그 자리).
function noteReceipt(w: World, outcome: Record<string, unknown>) {
  w.captured.lines!.ports.observe!({ kind: "receipt", connection: 7, outcome } as never);
}

// 판정의 다른 조건을 모두 채운 checking 실행: 인정·처음 본 때 + 한 주기 뒤 실은 조회에 실행기가 결과가 없다고 답했고, 장부 시각과 단조
// 경과 모두 기한이 지났다. 박자 한 번이면 결과 없음으로 판정되는 자리다.
async function ripe(settings: Partial<SupervisorSettings> = { resultCheck: RESULT_CHECK }) {
  const b = await booted(settings);
  greet(b.w);
  const run = checking(b.ledger);
  await b.beat();
  await b.w.time.advance(limits.RENEW_INTERVAL_MS + 1_000);
  b.w.wall = WALL + 1 + limits.RENEW_INTERVAL_MS;
  answer(b.w, run.runId);
  b.w.wall = WALL + 1 + RESULT_CHECK.reportWaitMs;
  b.w.time.set(b.w.time.monoNow() + RESULT_CHECK.reportWaitMs);
  const marks: unknown[] = [];
  const mark = b.ledger.markResult.bind(b.ledger);
  b.ledger.markResult = (input) => {
    marks.push(input);
    return mark(input);
  };
  return { w: b.w, running: b.run, ledger: b.ledger, beat: b.beat, run, marks };
}

const outcomes = (w: World) => w.events.filter((e) => e.event === "beat" && e.fields.resultCheck === "ran").map((e) => e.fields.resultCheckOutcomes);
const alerts = (w: World) => w.events.filter((e) => e.event === "result_check_alert").map((e) => e.fields);

// 감독이 다시 뜬 세계. 벽시계 RESTART에 떠서 2단계 전에 실행기가 인사했고(RESTART), 현관의 이웃 답이 늦어 5단계는 벽시계 RESTORED에
// 받아들였다. 종료 영수증은 앞 프로세스가 WALL + 1에 적은 것으로 둔다(기한 60000ms의 몇 배 전).
const RESTART = WALL + 1 + 3 * 60_000;
const RESTORED = RESTART + 2 * 60_000;
async function restarted() {
  const w = world();
  w.wall = RESTART;
  let peersReady = false;
  w.front.peers = async () => {
    if (!peersReady) throw new Error("이웃 답 전");
    return FRONT_ROWS;
  };
  const result: BootResult = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  for (let i = 0; i < 5; i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
  greet(w);
  w.wall = RESTORED;
  peersReady = true;
  for (let i = 0; i < 20 && !w.events.some((e) => e.event === "restore_step" && e.fields.step === 5); i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
  const ledger = w.opened;
  if (ledger === null || !w.events.some((e) => e.event === "restore_step" && e.fields.step === 5 && e.fields.intakeMayOpen === true)) throw new Error("5단계를 받아들이지 않았다");
  const run = checking(ledger);
  return { w, running: result.running, ledger, run, beat: () => w.time.advance(w.settings.timing.beatEveryMs) };
}

function stateOf(ledger: Ledger, runId: string): string {
  const read = ledger.getRun(runId);
  return read.known && read.value !== null ? read.value.state : "unknown";
}

describe("결과 검사 박자 + 조립", () => {
  test("checking 실행의 결과 보고 하나를 박자가 판정하고 같은 박자의 수명 박자가 확정을 장부에 적는다", async () => {
    const b = await booted();
    const run = checking(b.ledger);
    report(b.ledger, run, "결과 본문");
    await b.beat();
    const beat = b.w.events.filter((e) => e.event === "beat" && e.fields.kind === "ran").at(-1)?.fields;
    expect(beat).toMatchObject({ resultCheck: "ran", resultCheckOutcomes: "judged=1", resultCheckHalted: null });
    const times = b.ledger.instructionTimes(run.runId);
    expect([stateOf(b.ledger, run.runId), times.known && times.value !== null ? times.value.lastFinalizeAt !== null : times]).toEqual(["ready_result", true]);
    expect(b.w.events.filter((e) => e.event === "result_check_alert")).toEqual([]);
    expect(await b.run.stop()).toBe(0);
  });

  test("다른 digest가 섞이면 판정하지 않고, 경보는 그 실행에 한 줄만 남긴다", async () => {
    const b = await booted();
    const run = checking(b.ledger);
    report(b.ledger, run, "본문 a");
    report(b.ledger, run, "본문 b");
    for (let i = 0; i < 3; i += 1) await b.beat();
    const beats = b.w.events.filter((e) => e.event === "beat" && e.fields.resultCheck === "ran");
    expect(beats.length).toBeGreaterThanOrEqual(3);
    expect(beats.every((e) => e.fields.resultCheckOutcomes === "digest_conflict=1")).toBe(true);
    expect(b.w.events.filter((e) => e.event === "result_check_alert").map((e) => e.fields)).toEqual([{ reason: "digest_conflict", runId: run.runId, digests: 2, reports: 2 }]);
    expect(stateOf(b.ledger, run.runId)).toBe("checking");
    expect(await b.run.stop()).toBe(0);
  });

  test("보고 없이 기한이 지난 checking은 결과 없음으로 판정해 경보 한 줄을 남기고, 같은 박자의 수명 박자가 실패 확정을 장부에 적는다", async () => {
    // 기한은 이 시험의 숫자다(재전송 두 주기). 실행기가 답한 조회는 기한 시작 + 한 주기 뒤라야 하므로 그보다 길게 둔다.
    const WAIT = 2 * limits.RENEW_INTERVAL_MS;
    const b = await booted({ resultCheck: { reportWaitMs: WAIT } });
    // 결과 없음 판정은 그 실행기의 인정된 연결이 있을 때만이다(D-123). 인정과 5단계(WALL)가 모두 종료 영수증보다 이르고 인정 뒤 재전송
    // 한 주기가 장부 시각과 단조 경과 모두로 지났으므로 기한은 종료 영수증부터 센다.
    greet(b.w);
    await b.w.time.advance(limits.RENEW_INTERVAL_MS);
    const AT = WALL + limits.RENEW_INTERVAL_MS;
    b.w.wall = AT;
    const run = checking(b.ledger, AT);
    await b.beat();
    // 그 실행기가 기한 시작(종료 영수증 AT + 1) + 한 주기에 실은 조회에 답했다(단조 쪽은 처음 본 박자 + 한 주기 뒤).
    await b.w.time.advance(limits.RENEW_INTERVAL_MS + 1_000);
    b.w.wall = AT + 1 + limits.RENEW_INTERVAL_MS;
    answer(b.w, run.runId);
    // 장부 시계는 조립 세계의 벽시계다(박자로 흐르지 않는다). 종료 영수증(AT + 1)부터 기한 1ms 전과 정각으로 옮긴다. 단조 쪽은 이
    // 프로세스가 그 실행을 처음 본 박자부터 센다: 1ms 전에서 기한만큼 박자를 더 돌려 단조 경과를 먼저 채운다.
    b.w.wall = AT + 1 + WAIT - 1;
    await b.beat();
    const ran = () => b.w.events.filter((e) => e.event === "beat" && e.fields.resultCheck === "ran").map((e) => e.fields.resultCheckOutcomes);
    expect(ran().at(-1)).toBe("waiting=1");
    await b.w.time.advance(WAIT);
    expect(ran().at(-1)).toBe("waiting=1");
    b.w.wall = AT + 1 + WAIT;
    for (let i = 0; i < 3; i += 1) await b.beat();
    // 조립은 설정의 정책 객체를 그대로 박자에 넘긴다.
    expect(b.w.captured.resultCheckPolicy).toBe(b.w.settings.resultCheck);
    expect(ran().filter((outcomes) => outcomes === "no_result=1")).toHaveLength(1);
    expect(b.w.events.filter((e) => e.event === "result_check_alert").map((e) => e.fields)).toEqual([{ reason: "no_result", runId: run.runId, checkingSince: AT + 1 }]);
    const times = b.ledger.instructionTimes(run.runId);
    const unanswered = b.ledger.unansweredInstructions();
    expect([
      stateOf(b.ledger, run.runId),
      times.known && times.value !== null ? times.value.lastFinalizeAt !== null : times,
      unanswered.known ? unanswered.value.instructions.filter((item) => item.runId === run.runId).map((item) => item.rebuild?.action === "result_finalize" && item.rebuild.outcome) : unanswered,
    ]).toEqual(["failed_stopped", true, ["failed"]]);
    expect(await b.run.stop()).toBe(0);
  });

  test("감독이 기한보다 오래 멈췄다 다시 뜨면 5단계를 받아들인 뒤의 박자는 오래된 영수증으로 판정하지 않고, 그 사이 도착한 재전송 보고를 판정한다", async () => {
    const r = await restarted();
    await r.beat();
    r.w.wall = RESTORED + 60_000 - 1;
    await r.beat();
    expect(outcomes(r.w).slice(-2)).toEqual(["waiting=1", "waiting=1"]);
    // 실행기가 다시 보낸 결과 보고가 기한 안에 닿았다.
    const resentAt = RESTORED + 60_000 - 1;
    report(r.ledger, r.run, "다시 보낸 결과", resentAt);
    r.w.wall = resentAt;
    await r.beat();
    expect(outcomes(r.w).at(-1)).toBe("judged=1");
    expect([stateOf(r.ledger, r.run.runId), alerts(r.w)]).toEqual(["ready_result", []]);
    expect(await r.running.stop()).toBe(0);
  });

  test("다시 뜬 감독은 보고가 끝내 없으면 5단계를 받아들인 때부터 센 기한 정각에 결과 없음으로 판정한다", async () => {
    const r = await restarted();
    // 단조 경과로도 5단계 뒤·처음 본 뒤 기한이 지나게 박자를 먼저 돌린다(장부 시각은 5단계 시각 그대로라 기다림).
    await r.w.time.advance(60_000 + 1_000);
    expect([...new Set(outcomes(r.w))]).toEqual(["waiting=1"]);
    // 그 실행기가 5단계 + 한 주기에 실은 조회에 답했다.
    r.w.wall = RESTORED + limits.RENEW_INTERVAL_MS;
    answer(r.w, r.run.runId);
    r.w.wall = RESTORED + 60_000 - 1;
    await r.beat();
    expect(outcomes(r.w).at(-1)).toBe("waiting=1");
    r.w.wall = RESTORED + 60_000;
    for (let i = 0; i < 3; i += 1) await r.beat();
    expect(outcomes(r.w).filter((each) => each === "no_result=1")).toHaveLength(1);
    expect([stateOf(r.ledger, r.run.runId), alerts(r.w)]).toEqual(["failed_stopped", [{ reason: "no_result", runId: r.run.runId, checkingSince: WALL + 1 }]]);
    expect(await r.running.stop()).toBe(0);
  });

  test("실행기 연결이 없으면 기한이 지나도 판정하지 않고, 다시 인정되면 그 인사부터 재전송 한 주기와 기한이 지나야 판정한다", async () => {
    const b = await booted({ resultCheck: { reportWaitMs: 300 } });
    const run = checking(b.ledger);
    // 연결 없이 기한의 몇 배, 5단계(WALL)부터 재전송 한 주기의 몇 배가 지났다.
    b.w.wall = WALL + 1 + 10 * limits.RENEW_INTERVAL_MS;
    for (let i = 0; i < 3; i += 1) await b.beat();
    expect(outcomes(b.w).slice(-3)).toEqual(["waiting=1", "waiting=1", "waiting=1"]);
    const BACK = WALL + 20 * limits.RENEW_INTERVAL_MS;
    b.w.wall = BACK;
    greet(b.w);
    // 단조 경과로도 인정 뒤 재전송 한 주기가 지나게 박자를 먼저 돌린다(장부 시각은 인정 시각 그대로라 기다림).
    await b.w.time.advance(limits.RENEW_INTERVAL_MS + 1_000);
    expect([outcomes(b.w).at(-1), alerts(b.w)]).toEqual(["waiting=1", []]);
    b.w.wall = BACK + limits.RENEW_INTERVAL_MS - 1;
    await b.beat();
    expect([outcomes(b.w).at(-1), alerts(b.w)]).toEqual(["waiting=1", []]);
    b.w.wall = BACK + limits.RENEW_INTERVAL_MS;
    // 인정 뒤 한 주기가 지나도 그 연결에서 실행기가 답한 조회가 없으면 기다린다.
    for (let i = 0; i < 3; i += 1) await b.beat();
    expect([outcomes(b.w).slice(-3), alerts(b.w)]).toEqual([["waiting=1", "waiting=1", "waiting=1"], []]);
    answer(b.w, run.runId);
    for (let i = 0; i < 3; i += 1) await b.beat();
    expect(outcomes(b.w).filter((each) => each === "no_result=1")).toHaveLength(1);
    expect([stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual(["failed_stopped", [{ reason: "no_result", runId: run.runId, checkingSince: WALL + 1 }]]);
    expect(await b.run.stop()).toBe(0);
  });

  test("벽시계만 앞으로 뛰면(단조 경과는 짧다) 재연결 뒤 재전송 한 주기와 기한 전이라 checking을 유지하고, 뒤따른 결과 보고를 판정한다", async () => {
    // 기한은 조립 세계의 기본값(60000ms)이다.
    const b = await booted();
    const run = checking(b.ledger);
    b.w.wall = WALL + 2;
    greet(b.w);
    await b.beat();
    const mono = b.w.time.monoNow();
    // 장부 시각으로는 인정 뒤 재전송 한 주기와 기한이 모두 지났다.
    b.w.wall = WALL + 2 + 60_000 + limits.RENEW_INTERVAL_MS;
    for (let i = 0; i < 3; i += 1) await b.beat();
    expect(b.w.time.monoNow() - mono).toBeLessThan(limits.RENEW_INTERVAL_MS);
    expect([outcomes(b.w).slice(-3), stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual([["waiting=1", "waiting=1", "waiting=1"], "checking", []]);
    const resent = report(b.ledger, run, "다시 보낸 결과", b.w.wall);
    await b.beat();
    expect([outcomes(b.w).at(-1), stateOf(b.ledger, run.runId), b.ledger.pendingReports()]).toEqual(["judged=1", "ready_result", { known: true, value: [] }]);
    expect(typeof resent).toBe("string");
    expect(await b.run.stop()).toBe(0);
  });

  test("종료 영수증이 기한 시작일 때도 벽시계만 앞으로 뛰면 이 프로세스가 그 실행을 처음 본 뒤 단조 경과로 기한 전이라 판정하지 않는다", async () => {
    const b = await booted({ resultCheck: { reportWaitMs: 1_000 } });
    greet(b.w);
    // 인정·5단계 뒤 재전송 한 주기가 장부 시각과 단조 경과 모두로 지났다.
    await b.w.time.advance(limits.RENEW_INTERVAL_MS);
    const AT = WALL + limits.RENEW_INTERVAL_MS;
    b.w.wall = AT;
    const run = checking(b.ledger, AT);
    await b.beat();
    // 종료 영수증(AT + 1) 뒤 벽시계만 기한의 예순 배 앞으로 뛰었다.
    b.w.wall = AT + 1 + 60_000;
    for (let i = 0; i < 3; i += 1) await b.beat();
    expect([outcomes(b.w).slice(-4), stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual([["waiting=1", "waiting=1", "waiting=1", "waiting=1"], "checking", []]);
    report(b.ledger, run, "다시 보낸 결과", b.w.wall);
    await b.beat();
    expect([outcomes(b.w).at(-1), stateOf(b.ledger, run.runId)]).toEqual(["judged=1", "ready_result"]);
    expect(await b.run.stop()).toBe(0);
  });

  for (const wait of [1_000, 60_000]) {
    test(`인사 바이트를 받은 뒤 서명 검증이 12초 걸려 늦게 인정되면 인정한 때부터 재전송 한 주기와 기한을 센다(기한 ${wait}ms)`, async () => {
      const b = await booted({ resultCheck: { reportWaitMs: wait } });
      const run = checking(b.ledger);
      // 인사 바이트는 HELLO에 받았고(연결 표의 greeting.at), 검증이 12초 걸려 그 뒤에 인정됐다.
      const HELLO = WALL + 2;
      b.w.wall = HELLO;
      await b.w.time.advance(12_000);
      b.w.wall = HELLO + 12_000;
      greet(b.w, HELLO);
      const accepted = b.w.wall;
      // 단조 경과는 넉넉히 채워 두고 장부 시각으로 가른다. 인사 바이트부터 세면 아래 1ms 전에 이미 판정한다.
      await b.w.time.advance(Math.max(wait, limits.RENEW_INTERVAL_MS) + 1_000);
      const until = Math.max(wait, limits.RENEW_INTERVAL_MS);
      // 그 실행기는 인정 + 한 주기에 실은 조회에 답한다(기한이 한 주기보다 길면 1ms 전 박자보다 먼저).
      const answerAt = accepted + limits.RENEW_INTERVAL_MS;
      if (answerAt < accepted + until) {
        b.w.wall = answerAt;
        answer(b.w, run.runId);
      }
      b.w.wall = accepted + until - 1;
      await b.beat();
      expect([outcomes(b.w).at(-1), stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual(["waiting=1", "checking", []]);
      b.w.wall = accepted + until;
      if (answerAt === accepted + until) answer(b.w, run.runId);
      for (let i = 0; i < 3; i += 1) await b.beat();
      expect(outcomes(b.w).filter((each) => each === "no_result=1")).toHaveLength(1);
      expect([stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual(["failed_stopped", [{ reason: "no_result", runId: run.runId, checkingSince: WALL + 1 }]]);
      expect(await b.run.stop()).toBe(0);
    });
  }

  test("오래 기다리던 실행도 다시 인정된 뒤 벽시계만 앞으로 뛰면 인정 뒤 단조 경과로 재전송 한 주기 전이라 판정하지 않는다", async () => {
    // 기한은 조립 세계의 기본값(60000ms)이다.
    const b = await booted();
    const run = checking(b.ledger);
    // 연결 없이 장부 시각과 단조 경과 모두 기한의 두 배가 지났다(처음 본 뒤·5단계 뒤의 단조 경과도 길다).
    for (let i = 0; i < 2; i += 1) {
      b.w.wall += 60_000;
      await b.w.time.advance(60_000);
    }
    expect([outcomes(b.w).at(-1), stateOf(b.ledger, run.runId)]).toEqual(["waiting=1", "checking"]);
    greet(b.w);
    const back = b.w.wall;
    await b.w.time.advance(5_000);
    // 다시 인정된 뒤 벽시계만 기한과 한 주기보다 더 앞으로 뛰었다.
    b.w.wall = back + 60_000 + limits.RENEW_INTERVAL_MS;
    for (let i = 0; i < 3; i += 1) await b.beat();
    expect([outcomes(b.w).slice(-3), stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual([["waiting=1", "waiting=1", "waiting=1"], "checking", []]);
    // 단조 경과로도 인정 뒤 기한이 지나면 판정한다(위의 0이 다른 이유로 막힌 것이 아니다). 실행기는 인정 뒤 단조 한 주기가 지나 실은
    // 조회에 답했다.
    await b.w.time.advance(limits.RENEW_INTERVAL_MS);
    expect([stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual(["checking", []]);
    answer(b.w, run.runId);
    await b.w.time.advance(60_000 - limits.RENEW_INTERVAL_MS);
    expect([stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual(["failed_stopped", [{ reason: "no_result", runId: run.runId, checkingSince: WALL + 1 }]]);
    expect(await b.run.stop()).toBe(0);
  });

  test("철회된 연결의 인정 시각은 쓰지 않는다: 같은 번호가 다시 인정된 것처럼 보여도 새 후보가 오기 전에는 판정하지 않는다", async () => {
    const b = await booted({ resultCheck: { reportWaitMs: 300 } });
    const run = checking(b.ledger);
    greet(b.w);
    // 서버가 그 연결을 닫아 철회를 넘겼다. 가짜 서버의 recognized는 그대로 7을 낸다(인정 조회와 철회 사이의 어긋남).
    b.w.fake.options!.deliver({ kind: "withdrawn", connection: 7, principal: EXECUTOR } as never);
    await b.w.time.advance(limits.RENEW_INTERVAL_MS + 1_000);
    b.w.wall = WALL + 1 + 10 * limits.RENEW_INTERVAL_MS;
    for (let i = 0; i < 3; i += 1) await b.beat();
    expect([outcomes(b.w).at(-1), stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual(["waiting=1", "checking", []]);
    expect(await b.run.stop()).toBe(0);
  });
});

describe("첫 관측 기록의 정리 대상 읽기 실패", () => {
  test("기한이 찬 박자에서 첫 관측 기록의 정리 대상 읽기만 실패하면 결과 없음 판정(markResult(null))이 0회이고, 읽기가 돌아오면 판정한다", async () => {
    const b = await booted({ resultCheck: RESULT_CHECK });
    try {
      greet(b.w);
      const run = checking(b.ledger);
      await b.beat();
      // 다른 조건을 모두 채운다: 인정·처음 본 때 + 한 주기 뒤 실은 조회에 답했고, 장부 시각과 단조 경과 모두 기한이 지났다.
      await b.w.time.advance(limits.RENEW_INTERVAL_MS + 1_000);
      b.w.wall = WALL + 1 + limits.RENEW_INTERVAL_MS;
      answer(b.w, run.runId);
      b.w.wall = WALL + 1 + RESULT_CHECK.reportWaitMs;
      b.w.time.set(b.w.time.monoNow() + RESULT_CHECK.reportWaitMs);
      const marks: unknown[] = [];
      const mark = b.ledger.markResult.bind(b.ledger);
      b.ledger.markResult = (input) => {
        marks.push(input);
        return mark(input);
      };
      // 조립의 첫 관측 기록(실행 ID → 단조 시각)의 열거만 던지게 한다.
      const keys = Map.prototype.keys;
      let thrown = 0;
      Map.prototype.keys = function (this: Map<unknown, unknown>) {
        if (typeof this.get(run.runId) === "number" && (new Error().stack ?? "").includes("runtime/boot.ts")) {
          thrown += 1;
          throw new Error("정리 대상 읽기 실패");
        }
        return keys.call(this);
      } as typeof keys;
      try {
        await b.beat();
      } finally {
        Map.prototype.keys = keys;
      }
      expect(thrown).toBeGreaterThan(0);
      expect([marks, stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual([[], "checking", []]);
      // 읽기가 돌아오면 판정한다(위의 0이 다른 이유로 막힌 것이 아니다).
      await b.beat();
      expect([marks, stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual([[{ runId: run.runId, resultDigest: null, now: b.w.wall }], "failed_stopped", [{ reason: "no_result", runId: run.runId, checkingSince: WALL + 1 }]]);
    } finally {
      await b.run.stop();
    }
  });
});

describe("첫 관측 기록의 정리 대상 읽기 실패(수락 조건: 결과 없음 판정 0회)", () => {
  test("같은 박자에 유효한 결과 보고가 있으면 그 digest로 판정한다: 결과를 보존하는 판정은 막지 않고 결과 없음 판정(markResult(null))만 0회다", async () => {
    const b = await ripe();
    try {
      const body = "정리 실패 박자의 결과";
      report(b.ledger, b.run, body, b.w.wall);
      const keys = Map.prototype.keys;
      let thrown = 0;
      Map.prototype.keys = function (this: Map<unknown, unknown>) {
        if (typeof this.get(b.run.runId) === "number" && (new Error().stack ?? "").includes("runtime/boot.ts")) {
          thrown += 1;
          throw new Error("정리 대상 읽기 실패");
        }
        return keys.call(this);
      } as typeof keys;
      try {
        await b.beat();
      } finally {
        Map.prototype.keys = keys;
      }
      expect(thrown).toBeGreaterThan(0);
      expect([b.marks.filter((input) => (input as { resultDigest: unknown }).resultDigest === null), b.marks.map((input) => (input as { resultDigest: unknown }).resultDigest), stateOf(b.ledger, b.run.runId), alerts(b.w)]).toEqual([[], [digest(body)], "ready_result", []]);
    } finally {
      await b.running.stop();
    }
  });
});

describe("결과 없음 판정의 근거는 그 실행을 물은 조회의 답이다", () => {
  test("같은 연결에서 다른 실행만 물은 조회의 답은 이 실행의 근거가 아니고, 이 실행을 물은 조회의 답이 오면 판정한다", async () => {
    const b = await booted({ resultCheck: RESULT_CHECK });
    try {
      greet(b.w);
      const run = checking(b.ledger);
      await b.beat();
      await b.w.time.advance(limits.RENEW_INTERVAL_MS + 1_000);
      b.w.wall = WALL + 1 + limits.RENEW_INTERVAL_MS;
      const other = id();
      replyTo(b.w, ask(b.w, [other]), [{ run_id: other, state: "not_known", run_generation: null }]);
      b.w.wall = WALL + 1 + RESULT_CHECK.reportWaitMs;
      b.w.time.set(b.w.time.monoNow() + RESULT_CHECK.reportWaitMs);
      for (let i = 0; i < 3; i += 1) await b.beat();
      expect([outcomes(b.w).slice(-3), stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual([["waiting=1", "waiting=1", "waiting=1"], "checking", []]);
      // 두 실행을 함께 물은 조회의 답은 이 실행의 근거다.
      replyTo(b.w, ask(b.w, [other, run.runId]), [
        { run_id: other, state: "not_known", run_generation: null },
        { run_id: run.runId, state: "failed_stopped", run_generation: generationOf(b.w, run.runId) },
      ]);
      await b.beat();
      expect([stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual(["failed_stopped", [{ reason: "no_result", runId: run.runId, checkingSince: WALL + 1 }]]);
    } finally {
      await b.run.stop();
    }
  });

  test("새 조회가 대체한 같은 실행·연결의 앞 조회는 등록부에서 끝나고, 그 늦은 답은 근거가 아니다(새 조회의 답이 오면 판정한다)", async () => {
    const b = await booted({ resultCheck: RESULT_CHECK });
    try {
      greet(b.w);
      const run = checking(b.ledger);
      await b.beat();
      await b.w.time.advance(limits.RENEW_INTERVAL_MS + 1_000);
      b.w.wall = WALL + 1 + limits.RENEW_INTERVAL_MS;
      const first = ask(b.w, [run.runId]);
      const second = ask(b.w, [run.runId]);
      expect(b.w.captured.queries!.pending().map((entry) => entry.requestId)).toEqual([second]);
      const runs = [{ run_id: run.runId, state: "failed_stopped", run_generation: generationOf(b.w, run.runId) }];
      replyTo(b.w, first, runs);
      b.w.wall = WALL + 1 + RESULT_CHECK.reportWaitMs;
      b.w.time.set(b.w.time.monoNow() + RESULT_CHECK.reportWaitMs);
      for (let i = 0; i < 3; i += 1) await b.beat();
      expect([outcomes(b.w).slice(-3), stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual([["waiting=1", "waiting=1", "waiting=1"], "checking", []]);
      // 대체한 쪽의 답은 근거다. 그 사이 수명 박자가 같은 실행을 다시 물어(가짜 서버라 싣지 못한다) 둘째 조회도 대체됐으므로 새로 묻고 답한다.
      replyTo(b.w, ask(b.w, [run.runId]), runs);
      await b.beat();
      expect([stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual(["failed_stopped", [{ reason: "no_result", runId: run.runId, checkingSince: WALL + 1 }]]);
    } finally {
      await b.run.stop();
    }
  });

  test("그 실행을 물은 조회에 실행기가 ready_result로 답했으면 판정하지 않는다", async () => {
    const b = await booted({ resultCheck: RESULT_CHECK });
    try {
      greet(b.w);
      const run = checking(b.ledger);
      await b.beat();
      await b.w.time.advance(limits.RENEW_INTERVAL_MS + 1_000);
      b.w.wall = WALL + 1 + limits.RENEW_INTERVAL_MS;
      replyTo(b.w, ask(b.w, [run.runId]), [{ run_id: run.runId, state: "ready_result", run_generation: generationOf(b.w, run.runId) }]);
      b.w.wall = WALL + 1 + RESULT_CHECK.reportWaitMs;
      b.w.time.set(b.w.time.monoNow() + RESULT_CHECK.reportWaitMs);
      for (let i = 0; i < 3; i += 1) await b.beat();
      expect([outcomes(b.w).slice(-3), stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual([["waiting=1", "waiting=1", "waiting=1"], "checking", []]);
    } finally {
      await b.run.stop();
    }
  });
});

describe("감독이 받고 보관하지 못한 결과 보고의 기억", () => {
  test("보관 모름·장부 던짐·장부 거절은 그 실행만 막고, 같은 보고를 장부가 받거나 보관 전에 확정 거절하면 지운다", async () => {
    const b = await ripe();
    try {
      const [r1, r2, r3, r4] = [id(), id(), id(), id()];
      const runId = b.run.runId;
      const steps: string[] = [];
      const beat = async (name: string) => {
        await b.beat();
        steps.push(`${name}:${outcomes(b.w).at(-1)}`);
      };
      // 각 단계에서 남은 기억은 하나다: 그 단계의 적기·지우기 하나가 빠지면 그 단계나 마지막 단계의 결과가 바뀐다.
      noteReceipt(b.w, { outcome: "result_unknown", id: r1, runId, at: "store" });
      await beat("r1 보관 모름");
      // 다른 동작의 같은 ID ack는 결과 보고의 기억을 지우지 않는다.
      noteReceipt(b.w, { outcome: "ack", action: "receipt_stopped", id: r1, delivery: "new", ack: {} });
      await beat("다른 동작 ack");
      noteReceipt(b.w, { outcome: "ack", action: "report_result", id: r1, delivery: "new", ack: {} });
      noteReceipt(b.w, { outcome: "ledger_refused", action: "report_result", id: r2, reason: "ledger_unwritable", runId });
      await beat("r1 ack, r2 장부 거절");
      noteReceipt(b.w, { outcome: "applied_without_ack", action: "report_result", id: r2, delivery: "duplicate", reason: "stop_generation_unknown" });
      noteReceipt(b.w, { outcome: "ledger_failed", action: "report_result", id: r3, failure: "threw", runId });
      await beat("r2 장부가 받음, r3 장부 던짐");
      // 다른 실행의 보관하지 못한 보고는 이 실행을 막지 않는다.
      noteReceipt(b.w, { outcome: "result_unknown", id: r4, runId: id(), at: "ledger_read" });
      noteReceipt(b.w, { outcome: "result_refused", id: r3, runId, reason: "too_large" });
      await beat("r3 확정 거절, 다른 실행 r4");
      expect(steps).toEqual([
        "r1 보관 모름:waiting=1",
        "다른 동작 ack:waiting=1",
        "r1 ack, r2 장부 거절:waiting=1",
        "r2 장부가 받음, r3 장부 던짐:waiting=1",
        "r3 확정 거절, 다른 실행 r4:no_result=1",
      ]);
      expect([b.marks, stateOf(b.ledger, runId)]).toEqual([[{ runId, resultDigest: null, now: b.w.wall }], "failed_stopped"]);
    } finally {
      await b.running.stop();
    }
  });

  test("실행 ID 없이 장부가 결과 보고를 받지 않았다는 기록이 오면 어느 실행에 보관하지 못한 보고가 있는지 몰라 판정하지 않는다", async () => {
    const b = await ripe();
    try {
      noteReceipt(b.w, { outcome: "ledger_failed", action: "report_result", id: id(), failure: "threw" });
      for (let i = 0; i < 3; i += 1) await b.beat();
      expect([outcomes(b.w).slice(-3), b.marks, stateOf(b.ledger, b.run.runId)]).toEqual([["waiting=1", "waiting=1", "waiting=1"], [], "checking"]);
    } finally {
      await b.running.stop();
    }
  });
});

describe("결과 기한과 keepalive의 관계(D-113 시험 숫자)", () => {
  test("운영 기한은 keepalive가 반쯤 열린 연결을 닫는 한계에 재전송 한 주기를 더한 것보다 길다", () => {
    // 감독은 닫힘을 통보받지 못한 연결을 인정된 연결로 본다. 그 연결은 keepalive가 닫는다. 한계는 src/transport/keepalive.ts의
    // KEEPALIVE_USER_TIMEOUT_MS(= KEEPALIVE_INITIAL_DELAY_MS 30000 + KEEPALIVE_INTERVAL_MS 10000 × KEEPALIVE_PROBES 4)이고,
    // 진입점의 KEEPALIVE_DETECT_MS가 그 값이어야 한다. 70초 고정은 keepalive 값을 바꿀 때 이 기한을 다시 보게 하는 자리다.
    expect(KEEPALIVE_DETECT_MS).toBe(KEEPALIVE_USER_TIMEOUT_MS);
    expect(KEEPALIVE_USER_TIMEOUT_MS).toBe(30_000 + 10_000 * 4);
    expect(RESULT_CHECK.reportWaitMs).toBeGreaterThan(KEEPALIVE_USER_TIMEOUT_MS + limits.RENEW_INTERVAL_MS);
    expect(RESULT_CHECK.reportWaitMs).toBeGreaterThan(KEEPALIVE_DETECT_MS + limits.RENEW_INTERVAL_MS);
  });
});
