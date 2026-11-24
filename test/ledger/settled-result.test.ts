import { describe, expect, test } from "bun:test";
import type { Ledger } from "../../src/ledger/index.ts";
import { digest, id, must, NOW, open, startedWorker, tempPath } from "./helpers.ts";

// 작업자 실행 하나를 종료 확인(checking)까지 올린다.
function checking(ledger: Ledger) {
  const s = startedWorker(ledger);
  must(ledger.applyReceipt({ action: "receipt_accepted", receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, instruction: "task_start", bodyDigest: digest(`accepted:${s.runId}`), now: NOW }, s.from));
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: s.runId, exit: "completed", bodyDigest: digest(`stopped:${s.runId}`), now: NOW + 1 }, s.from));
  return s;
}

function report(ledger: Ledger, s: ReturnType<typeof checking>, resultDigest: string, now: number, storedRef = `results/${id()}`) {
  const reportId = id();
  must(ledger.recordReport({ reportId, action: "report_result", runId: s.runId, bodyDigest: digest(`report:${reportId}`), storedRef, resultDigest, signal: null, now }, s.from));
  return { reportId, storedRef };
}

const RESULT = digest("result body");

describe("settledResult: 결과 보고가 저장 자리와 함께 반영됐고 digest가 실행 줄과 같은가", () => {
  test("반영된 같은 digest의 보고가 있으면 그 저장 자리와 보고를 적은 시각을 낸다", () => {
    const ledger = open(tempPath());
    const s = checking(ledger);
    const { reportId, storedRef } = report(ledger, s, RESULT, NOW + 2);
    // 판정 전(반영 전)에는 null이다.
    expect(ledger.settledResult(s.runId)).toEqual({ known: true, value: null });
    must(ledger.markResult({ runId: s.runId, resultDigest: RESULT, reportId, now: NOW + 3 }));
    expect(ledger.settledResult(s.runId)).toEqual({ known: true, value: { runId: s.runId, resultDigest: RESULT, storedRef, storedAt: NOW + 2 } });
    // 상태는 보지 않는다: 정리 대기로 옮겨도 같은 값이다.
    must(ledger.markCleanupPending({ runId: s.runId, now: NOW + 4 }));
    expect(ledger.settledResult(s.runId)).toEqual({ known: true, value: { runId: s.runId, resultDigest: RESULT, storedRef, storedAt: NOW + 2 } });
  });

  test("없는 실행, 진행 중 실행, 보고 없이 판정한 실행, 결과 없음으로 판정한 실행은 null이다", () => {
    const ledger = open(tempPath());
    expect(ledger.settledResult(id())).toEqual({ known: true, value: null });
    const running = startedWorker(ledger);
    expect(ledger.settledResult(running.runId)).toEqual({ known: true, value: null });

    const a = open(tempPath());
    const judged = checking(a);
    must(a.markResult({ runId: judged.runId, resultDigest: RESULT, now: NOW + 3 }));
    expect(a.getRun(judged.runId)).toMatchObject({ known: true, value: { state: "ready_result", resultDigest: RESULT } });
    expect(a.settledResult(judged.runId)).toEqual({ known: true, value: null });

    const b = open(tempPath());
    const failed = checking(b);
    const { reportId } = report(b, failed, RESULT, NOW + 2);
    must(b.markResult({ runId: failed.runId, resultDigest: null, reportId, now: NOW + 3 }));
    expect(b.getRun(failed.runId)).toMatchObject({ known: true, value: { state: "failed_stopped", resultDigest: null } });
    expect(b.settledResult(failed.runId)).toEqual({ known: true, value: null });
  });

  test("반영된 보고의 digest가 실행 줄과 다르면(충돌) null이다", () => {
    const ledger = open(tempPath());
    const s = checking(ledger);
    report(ledger, s, digest("other result"), NOW + 2);
    // 보고 없이 다른 digest로 판정하면 그 보고는 충돌로 남고 반영된다.
    must(ledger.markResult({ runId: s.runId, resultDigest: RESULT, now: NOW + 3 }));
    expect(ledger.conflicts()).toMatchObject({ known: true, value: [expect.anything()] });
    expect(ledger.settledResult(s.runId)).toEqual({ known: true, value: null });
  });

  test("같은 결과의 보고가 둘이면 먼저 적은 보고다", () => {
    const ledger = open(tempPath());
    const s = checking(ledger);
    const first = report(ledger, s, RESULT, NOW + 2);
    must(ledger.markResult({ runId: s.runId, resultDigest: RESULT, now: NOW + 3 }));
    // 판정 뒤 같은 결과의 다른 보고는 적자마자 마친다.
    report(ledger, s, RESULT, NOW + 4);
    expect(ledger.settledResult(s.runId)).toEqual({ known: true, value: { runId: s.runId, resultDigest: RESULT, storedRef: first.storedRef, storedAt: NOW + 2 } });
  });

  test("장부를 바꾸지 않고, 닫힌 장부에서는 모름이다", () => {
    const ledger = open(tempPath());
    const s = checking(ledger);
    const { reportId } = report(ledger, s, RESULT, NOW + 2);
    must(ledger.markResult({ runId: s.runId, resultDigest: RESULT, reportId, now: NOW + 3 }));
    const before = [ledger.listRuns(), ledger.pendingReports(), ledger.instructionTimes(s.runId), ledger.unansweredInstructions()];
    ledger.settledResult(s.runId);
    expect([ledger.listRuns(), ledger.pendingReports(), ledger.instructionTimes(s.runId), ledger.unansweredInstructions()]).toEqual(before);
    expect(ledger.health()).toEqual({ writable: true });
    ledger.close();
    expect(ledger.settledResult(s.runId)).toEqual({ known: false, reason: "closed" });
  });
});
