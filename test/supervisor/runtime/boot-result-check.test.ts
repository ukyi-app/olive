// 조립(boot.ts)이 결과 검사 박자를 순서기에 잇는 자리. 실제 장부·실제 박자 여섯으로, 5단계를 받아들인 감독의 장부에 checking 실행과
// 결과 보고를 적고 박자를 돌린다. 판정 뒤 같은 박자의 수명 박자가 확정을 적는 것과, digest 충돌의 경보가 실행마다 한 줄인 것과,
// 보고 없이 기한이 지난 실행의 결과 없음 판정(D-113)이 경보 한 줄과 실패 확정으로 이어지는 것을 본다.
import { describe, expect, test } from "bun:test";
import type { Ledger } from "../../../src/ledger/index.ts";
import type { BootResult, SupervisorSettings } from "../../../src/supervisor/runtime/boot.ts";
import { digest, from, id, must, worker } from "../../ledger/helpers.ts";
import { WALL, world } from "./boot-world.ts";

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

function report(ledger: Ledger, run: ReturnType<typeof checking>, body: string) {
  const reportId = id();
  must(ledger.recordReport({ reportId, action: "report_result", runId: run.runId, bodyDigest: digest(`report:${reportId}`), storedRef: `results/${id()}`, resultDigest: digest(body), signal: null, now: WALL + 2 }, run.from));
  return reportId;
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
});
