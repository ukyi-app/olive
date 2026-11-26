// 조립(boot.ts)이 결과 검사 박자를 순서기에 잇는 자리. 실제 장부·실제 박자 여섯으로, 5단계를 받아들인 감독의 장부에 checking 실행과
// 결과 보고를 적고 박자를 돌린다. 판정 뒤 같은 박자의 수명 박자가 확정을 적는 것과, digest 충돌의 경보가 실행마다 한 줄인 것과,
// 보고 없이 기한이 지난 실행의 결과 없음 판정(D-113)이 경보 한 줄과 실패 확정으로 이어지는 것과, 그 기한을 복원 5단계를 받아들인 때와
// 실행기 연결이 인정된 때부터도 세는 것(D-123)을 본다.
import { describe, expect, test } from "bun:test";
import { limits } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import type { BootResult, SupervisorSettings } from "../../../src/supervisor/runtime/boot.ts";
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

// 작업자 실행을 시작·접수하고 completed 종료 영수증으로 checking까지 옮긴다.
function checking(ledger: Ledger) {
  const run = must(ledger.admitRun(worker({ now: WALL, deadlineAt: WALL + 600_000 }))).run;
  const requestId = id();
  must(ledger.startRun({ runId: run.runId, requestId, stopGeneration: 0, now: WALL }));
  const sender = from(run);
  must(ledger.applyReceipt({ action: "receipt_accepted", instruction: "task_start", receiptId: id(), runId: run.runId, instructionRequestId: requestId, bodyDigest: digest(`accepted:${run.runId}`), now: WALL }, sender));
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: run.runId, exit: "completed", bodyDigest: digest(`stopped:${run.runId}`), now: WALL + 1 }, sender));
  return { runId: run.runId, from: sender };
}

function report(ledger: Ledger, run: ReturnType<typeof checking>, body: string, at = WALL + 2) {
  const reportId = id();
  must(ledger.recordReport({ reportId, action: "report_result", runId: run.runId, bodyDigest: digest(`report:${reportId}`), storedRef: `results/${id()}`, resultDigest: digest(body), signal: null, now: at }, run.from));
  return reportId;
}

// 가짜 서버가 그 실행기의 연결 하나(번호 7)를 지금 인정하고 그 연결의 인사를 at(장부 시계)에 받은 것으로 둔다. null이면 인정된 연결이 없다.
// 조립은 recognized로 연결 번호를, 연결 표의 get으로 그 인사 시각을 읽는다.
function greet(w: World, at: number | null) {
  const server = w.fake.server as unknown as { table: () => object; recognized: (executorId: string) => number | null };
  const base = server.table();
  server.recognized = (executorId) => (at !== null && executorId === EXECUTOR ? 7 : null);
  server.table = () => ({ ...base, get: (connection: number) => (at !== null && connection === 7 ? { greeting: { at } } : undefined) });
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
  greet(w, RESTART);
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
    // 기한은 이 시험의 숫자다(박자 100ms 몇 번 안에 지나게).
    const b = await booted({ resultCheck: { reportWaitMs: 300 } });
    // 결과 없음 판정은 그 실행기의 인정된 연결이 있을 때만이다(D-123). 인사와 5단계(WALL)가 모두 종료 영수증보다 이르고 인사 뒤 재전송
    // 한 주기가 지났으므로 기한은 종료 영수증부터 센다.
    greet(b.w, WALL - limits.RENEW_INTERVAL_MS);
    const run = checking(b.ledger);
    // 장부 시계는 조립 세계의 벽시계다(박자로 흐르지 않는다). 종료 영수증(WALL + 1)부터 기한 1ms 전과 정각으로 옮긴다.
    b.w.wall = WALL + 1 + 299;
    await b.beat();
    const ran = () => b.w.events.filter((e) => e.event === "beat" && e.fields.resultCheck === "ran").map((e) => e.fields.resultCheckOutcomes);
    expect(ran().at(-1)).toBe("waiting=1");
    b.w.wall = WALL + 1 + 300;
    for (let i = 0; i < 3; i += 1) await b.beat();
    // 조립은 설정의 정책 객체를 그대로 박자에 넘긴다.
    expect(b.w.captured.resultCheckPolicy).toBe(b.w.settings.resultCheck);
    expect(ran().filter((outcomes) => outcomes === "no_result=1")).toHaveLength(1);
    expect(b.w.events.filter((e) => e.event === "result_check_alert").map((e) => e.fields)).toEqual([{ reason: "no_result", runId: run.runId, checkingSince: WALL + 1 }]);
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
    greet(b.w, BACK);
    b.w.wall = BACK + limits.RENEW_INTERVAL_MS - 1;
    await b.beat();
    expect([outcomes(b.w).at(-1), alerts(b.w)]).toEqual(["waiting=1", []]);
    b.w.wall = BACK + limits.RENEW_INTERVAL_MS;
    for (let i = 0; i < 3; i += 1) await b.beat();
    expect(outcomes(b.w).filter((each) => each === "no_result=1")).toHaveLength(1);
    expect([stateOf(b.ledger, run.runId), alerts(b.w)]).toEqual(["failed_stopped", [{ reason: "no_result", runId: run.runId, checkingSince: WALL + 1 }]]);
    expect(await b.run.stop()).toBe(0);
  });
});
