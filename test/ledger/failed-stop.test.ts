// 장부의 failedStop 읽기(src/ledger/ledger.ts). failed_stopped 실행이 그 상태가 된 장부 시각, 사유 requested의 취소 지시, 종료 영수증
// exit(판 8부터 실행 줄에 적힌 값, 그 전에 종료 확인을 받은 줄은 결과 검사를 거친 completed만)를 낸다. 실제 임시 장부에 실행을 적고 읽는다.
import { describe, expect, test } from "bun:test";
import { type Ledger, loadMigrations } from "../../src/ledger/index.ts";
import { digest, from, id, must, NOW, open, ready, tempPath, worker } from "./helpers.ts";

// 판 8(종료 영수증 exit 칸) 전까지의 판 목록. 이 목록으로 연 장부의 종료 확인은 exit를 남기지 않는다(판 8 전에 받은 줄과 같다).
const BEFORE_STOP_EXIT = () => loadMigrations().filter((m) => m.version < 8);

function started(ledger: Ledger) {
  const run = must(ledger.admitRun(worker())).run;
  const requestId = id();
  must(ledger.startRun({ runId: run.runId, requestId, stopGeneration: 0, now: NOW }));
  const sender = from(run);
  must(ledger.applyReceipt({ action: "receipt_accepted", instruction: "task_start", receiptId: id(), runId: run.runId, instructionRequestId: requestId, bodyDigest: digest(`accepted:${run.runId}`), now: NOW }, sender));
  return { runId: run.runId, from: sender };
}

function stopped(ledger: Ledger, s: ReturnType<typeof started>, exit: "completed" | "cancelled" | "deadline" | "failed", at: number): void {
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: s.runId, exit, bodyDigest: digest(`stopped:${s.runId}:${exit}`), now: at }, s.from));
}

function cancel(ledger: Ledger, s: ReturnType<typeof started>, reason: "requested" | "deadline" | null, at: number): void {
  must(ledger.recordStopInstruction({ runId: s.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: at, ...(reason === null ? {} : { reason }) }));
}

describe("failedStop", () => {
  test("종료 영수증이 곧바로 옮긴 failed_stopped는 그 영수증 시각과 그 exit다. 판 8 전의 줄이면 exit 모름(null)이다", () => {
    for (const exit of ["cancelled", "deadline", "failed"] as const) {
      const ledger = ready(open(tempPath()));
      const s = started(ledger);
      stopped(ledger, s, exit, NOW + 7);
      expect([exit, ledger.failedStop(s.runId)]).toEqual([exit, { known: true, value: { runId: s.runId, stoppedAt: NOW + 7, requestedCancel: false, exit } }]);

      const old = ready(open(tempPath(), { migrations: BEFORE_STOP_EXIT() }));
      const t = started(old);
      stopped(old, t, exit, NOW + 7);
      expect([exit, old.failedStop(t.runId)]).toEqual([exit, { known: true, value: { runId: t.runId, stoppedAt: NOW + 7, requestedCancel: false, exit: null } }]);
    }
  });

  test("completed로 checking이 된 뒤 결과 없음으로 판정된 failed_stopped는 판정 시각, exit completed다. 판 8 전의 줄이면 같은 밀리초의 판정은 exit 모름이다", () => {
    const ledger = ready(open(tempPath()));
    const s = started(ledger);
    stopped(ledger, s, "completed", NOW + 1);
    expect(ledger.failedStop(s.runId)).toEqual({ known: true, value: null });
    must(ledger.markResult({ runId: s.runId, resultDigest: null, now: NOW + 60_001 }));
    expect(ledger.failedStop(s.runId)).toEqual({ known: true, value: { runId: s.runId, stoppedAt: NOW + 60_001, requestedCancel: false, exit: "completed" } });

    const same = ready(open(tempPath()));
    const t = started(same);
    stopped(same, t, "completed", NOW + 1);
    must(same.markResult({ runId: t.runId, resultDigest: null, now: NOW + 1 }));
    expect(same.failedStop(t.runId)).toEqual({ known: true, value: { runId: t.runId, stoppedAt: NOW + 1, requestedCancel: false, exit: "completed" } });

    for (const [judgedAt, exit] of [
      [NOW + 60_001, "completed"],
      [NOW + 1, null],
    ] as const) {
      const old = ready(open(tempPath(), { migrations: BEFORE_STOP_EXIT() }));
      const u = started(old);
      stopped(old, u, "completed", NOW + 1);
      must(old.markResult({ runId: u.runId, resultDigest: null, now: judgedAt }));
      expect(old.failedStop(u.runId)).toEqual({ known: true, value: { runId: u.runId, stoppedAt: judgedAt, requestedCancel: false, exit } });
    }
  });

  test("취소 지시의 사유: requested가 있으면 true, 다른 사유뿐이면 false, requested 없이 사유 없는 지시가 있으면 null", () => {
    const cases: [string, ("requested" | "deadline" | null)[], boolean | null][] = [
      ["requested", ["requested"], true],
      ["deadline", ["deadline"], false],
      ["사유 없음", [null], null],
      ["사유 없음 + requested", [null, "requested"], true],
      ["deadline + 사유 없음", ["deadline", null], null],
    ];
    for (const [name, reasons, expected] of cases) {
      const ledger = ready(open(tempPath()));
      const s = started(ledger);
      reasons.forEach((reason, index) => cancel(ledger, s, reason, NOW + 1 + index));
      stopped(ledger, s, "cancelled", NOW + 10);
      expect([name, ledger.failedStop(s.runId)]).toEqual([name, { known: true, value: { runId: s.runId, stoppedAt: NOW + 10, requestedCancel: expected, exit: "cancelled" } }]);
    }
  });

  test("failed_stopped가 아니면(진행 중, checking, 없는 실행) null이고, 정리 영수증으로 finalized가 되면 updated_at이 바뀌어 null이다", () => {
    const ledger = ready(open(tempPath()));
    const s = started(ledger);
    expect(ledger.failedStop(s.runId)).toEqual({ known: true, value: null });
    expect(ledger.failedStop(id())).toEqual({ known: true, value: null });
    stopped(ledger, s, "failed", NOW + 5);
    const finalize = id();
    must(ledger.recordFinalizeInstruction({ runId: s.runId, requestId: finalize, stopGeneration: 0, now: NOW + 6, outcome: "failed", resultDigest: null, storedAt: NOW + 5 }));
    // 확정을 적어도 실행 줄은 그대로다(stored_at은 지시 줄에 고정됐다).
    expect(ledger.failedStop(s.runId)).toEqual({ known: true, value: { runId: s.runId, stoppedAt: NOW + 5, requestedCancel: false, exit: "failed" } });
    must(ledger.applyReceipt({ action: "receipt_cleaned", receiptId: id(), runId: s.runId, instructionRequestId: finalize, bodyDigest: digest("cleaned"), now: NOW + 9 }, s.from));
    const run = ledger.getRun(s.runId);
    expect(run.known && run.value !== null ? [run.value.state, run.value.updatedAt] : run).toEqual(["finalized", NOW + 9]);
    expect(ledger.failedStop(s.runId)).toEqual({ known: true, value: null });
  });

  test("닫힌 장부는 모름이다", () => {
    const ledger = ready(open(tempPath()));
    const s = started(ledger);
    stopped(ledger, s, "failed", NOW + 5);
    ledger.close();
    expect(ledger.failedStop(s.runId)).toEqual({ known: false, reason: "closed" });
  });
});
