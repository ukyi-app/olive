// 결과를 버린 실행(장부 판 9의 결과 포기 근거, D-148)의 결과 보고를 실제 수신 경로(handleForward)로 본다. D-169: 보관소에 넣지 않고 장부에
// 받은 기록만 적은 뒤 ack한다. D-168: 감독이 이미 보관하고 ack한 미반영 보고가 있는 실행은 버리지 않는다.
// 실제 임시 장부와 실제 파일 백엔드(임시 폴더)를 쓴다. 키·ID·digest·시각은 이 시험이 지어낸 값이다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { type Bodies, limits, sealEnvelope, type Verified, verifyEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import { type ForwardInput, handleForward, type ReceiptOutcome, type ResultPorts } from "../../../src/supervisor/dispatch/receipts.ts";
import { resultCheckTick } from "../../../src/supervisor/dispatch/result-check.ts";
import type { ResultBackend } from "../../../src/supervisor/scheduler/result-store.ts";
import { createFileResultBackend, type FilePort, nodeFilePort } from "../../../src/supervisor/scheduler/result-store-file.ts";
import { digest, id, must, NOW, open, ready, startedWorker, tempDir, tempPath, WORKER_EXECUTOR } from "../../ledger/helpers.ts";

const keys = generateKeyPairSync("ed25519");
const MAX_RECORD = limits.RESULT_MAX_BYTES + 4 + 1024;
const RESULT: Bodies["report_result"]["result"] = { role: "diagnosis", outcome: "completed", summary: "요약", items: [], refs: [] };
const OTHER_RESULT: Bodies["report_result"]["result"] = { ...RESULT, summary: "다른 요약" };
const random = { bytes: (length: number) => new Uint8Array(length).fill(7) };

let nonceSeq = 0;
async function resultReport(reportId: string, runId: string, result = RESULT): Promise<Verified> {
  const envelope = sealEnvelope(
    {
      sender: WORKER_EXECUTOR,
      recipient: "supervisor",
      action: "report_result",
      request_id: id(),
      stop_generation: 0,
      run_generation: 1,
      issued_at: NOW,
      nonce: (++nonceSeq).toString(16).padStart(32, "0"),
      body: { report_id: reportId, run_id: runId, result },
    },
    keys.privateKey,
  );
  const verified = await verifyEnvelope(envelope, {
    now: NOW + 1,
    expectedRecipient: "supervisor",
    publicKeyFor: () => keys.publicKey,
    stopGeneration: 0,
    runGeneration: () => 1,
    nonces: { consume: () => true },
  });
  if (!verified.ok) throw new Error(`검증 실패: ${verified.reason}`);
  return verified;
}

const forward = (v: Verified, now = NOW + 2): ForwardInput => ({ forward: { verified: v, connection: 1 }, now, stopGeneration: 0, pendingQueries: [], links: { current: () => true }, backlog: [] });

function fileBackend(files: FilePort = nodeFilePort): ResultBackend {
  const made = createFileResultBackend({ dir: tempDir(), maxRecordBytes: MAX_RECORD, files });
  if (made.status !== "ok") throw new Error(`백엔드: ${made.status}`);
  return made.backend;
}

// 폴더 fsync만 늘 실패하는 파일 포트(이어지는 보관 장애).
const brokenDirSync: FilePort = {
  ...nodeFilePort,
  fsync(fd) {
    if (nodeFilePort.fstat(fd).kind === "directory") throw new Error("EIO: 폴더를 내리지 못함");
    nodeFilePort.fsync(fd);
  },
};

function keyCount(backend: ResultBackend): number {
  const listed = backend.keys("result/");
  if (listed.status !== "ok") throw new Error("목록을 읽지 못함");
  return listed.keys.length;
}

// 소유자가 있고(owned) 종료가 확인된(exit completed) checking 작업자 실행.
function checkingRun(path: string, owned = true) {
  const ledger = ready(open(path));
  let inputRequestId: string | null = null;
  if (owned) {
    inputRequestId = id();
    must(ledger.enqueueInput({ requestId: inputRequestId, source: "test", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 600_000 }, receivedAt: NOW }));
  }
  const s = startedWorker(ledger, { inputRequestId });
  const stopReceiptId = id();
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: stopReceiptId, runId: s.runId, exit: "completed", bodyDigest: digest("stopped"), now: NOW + 1 }, s.from));
  return { ledger, ...s, stopReceiptId };
}

function runOf(ledger: Ledger, runId: string) {
  const read = ledger.getRun(runId);
  if (!read.known || read.value === null) throw new Error("실행을 읽지 못함");
  return read.value;
}

// 실패 문구에는 종류만 적는다(결과 객체를 직렬화하지 않는다).
function expectAck(outcome: ReceiptOutcome, reportId: string, delivery: "new" | "duplicate") {
  if (outcome.outcome !== "ack") throw new Error(`기대: ack(${delivery}), 실제: ${outcome.outcome}`);
  expect(outcome.id).toBe(reportId);
  expect(outcome.delivery).toBe(delivery);
  expect(outcome.ack.body.ids).toEqual([reportId]);
}

function abandonedRows(path: string) {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query("SELECT report_id, run_id, sender, run_generation FROM abandoned_result_reports ORDER BY received_at").all();
  } finally {
    raw.close();
  }
}

test("D-169: 보관 장애가 이어져도 포기(unstorable) 뒤의 같은 보고는 보관 없이 받은 기록으로 ack(new)되고 재전송은 duplicate다", async () => {
  const path = tempPath();
  const { ledger, runId, stopReceiptId } = checkingRun(path);
  const backend = fileBackend(brokenDirSync);
  const results: ResultPorts = { backend, ledger };
  const reportId = id();
  const report = await resultReport(reportId, runId);
  // 포기 전의 첫 수신: 보관하지 못해 ack가 없다(장부도 적지 않는다).
  const first = handleForward(forward(report), { ledger, random, results });
  expect(first).toMatchObject({ outcome: "result_unknown", at: "store" });
  expect("ack" in first).toBe(false);
  // 폴더를 내리지 못한 첫 보관의 파일은 남을 수 있다. 포기 뒤로는 보관소에 더 쓰지 않는다.
  const keysBefore = keyCount(backend);
  must(ledger.abandonResult({ runId, stopReceiptId, reason: "unstorable", now: NOW + 3 }));
  // 같은 ID·같은 본문의 재전송(nonce만 다름).
  expectAck(handleForward(forward(await resultReport(reportId, runId), NOW + 4), { ledger, random, results }), reportId, "new");
  expectAck(handleForward(forward(await resultReport(reportId, runId), NOW + 5), { ledger, random, results }), reportId, "duplicate");
  // 같은 ID의 다른 본문은 계속 충돌이다(ack 없음).
  const conflict = handleForward(forward(await resultReport(reportId, runId, OTHER_RESULT), NOW + 6), { ledger, random, results });
  expect(conflict).toMatchObject({ outcome: "ledger_refused", reason: "receipt_conflict" });
  expect("ack" in conflict).toBe(false);
  expect(keyCount(backend)).toBe(keysBefore);
  expect(runOf(ledger, runId)).toMatchObject({ state: "failed_stopped", resultDigest: null });
  expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  ledger.close();
  expect(abandonedRows(path)).toEqual([{ report_id: reportId, run_id: runId, sender: WORKER_EXECUTOR, run_generation: 1 }]);
});

test("D-169: 버린 실행의 보고는 보관소가 건강해도 넣지 않고, 소유자 없는 실행도 받는다. 버리지 않은 실패 실행은 지금처럼 보관 길로 간다", async () => {
  const path = tempPath();
  const { ledger, runId, stopReceiptId } = checkingRun(path, false);
  const backend = fileBackend();
  const results: ResultPorts = { backend, ledger };
  must(ledger.abandonResult({ runId, stopReceiptId, reason: "no_answer", now: NOW + 3 }));
  const reportId = id();
  expectAck(handleForward(forward(await resultReport(reportId, runId)), { ledger, random, results }), reportId, "new");
  expect(keyCount(backend)).toBe(0);

  ledger.close();
  // 대조군: 곧바로 실패로 끝난(exit failed) 실행은 버린 실행이 아니다. 보관한 뒤 장부가 지금처럼 거절한다.
  const other = ready(open(tempPath()));
  const owner = id();
  must(other.enqueueInput({ requestId: owner, source: "test", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 600_000 }, receivedAt: NOW }));
  const f = startedWorker(other, { inputRequestId: owner });
  must(other.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: f.runId, exit: "failed", bodyDigest: digest("failed"), now: NOW + 1 }, f.from));
  const refused = handleForward(forward(await resultReport(id(), f.runId)), { ledger: other, random, results: { backend, ledger: other } });
  expect(refused).toMatchObject({ outcome: "ledger_refused", reason: "transition_denied" });
  expect(keyCount(backend)).toBe(1);
  expect(abandonedRows(path)).toEqual([{ report_id: reportId, run_id: runId, sender: WORKER_EXECUTOR, run_generation: 1 }]);
});

test("D-169: 버린 실행이 있을 수 있는 상태의 보고인데 포기 읽기·기록 포트가 없거나 읽지 못하면 보관하지 않고 ack도 없다", async () => {
  const { ledger, runId, stopReceiptId } = checkingRun(tempPath());
  must(ledger.abandonResult({ runId, stopReceiptId, reason: "no_answer", now: NOW + 3 }));
  const backend = fileBackend();
  const bare: ResultPorts["ledger"] = { getRun: (r) => ledger.getRun(r), instructionTimes: (r) => ledger.instructionTimes(r), recordReport: (i, f) => ledger.recordReport(i, f) };
  expect(handleForward(forward(await resultReport(id(), runId)), { ledger, random, results: { backend, ledger: bare } })).toMatchObject({ outcome: "result_unknown", at: "ports" });
  for (const resultAbandon of [() => ({ known: false, reason: "io" }), () => ({ known: true, value: { runId: id() } }), () => { throw new Error("읽기 장애"); }]) {
    const view: ResultPorts["ledger"] = { ...bare, resultAbandon: resultAbandon as Ledger["resultAbandon"], recordAbandonedReport: (i, f) => ledger.recordAbandonedReport(i, f) };
    expect(handleForward(forward(await resultReport(id(), runId)), { ledger, random, results: { backend, ledger: view } })).toMatchObject({ outcome: "result_unknown", at: "ledger_read" });
  }
  expect(keyCount(backend)).toBe(0);
});

// D-168: 리뷰 재현의 두 순서. 어느 쪽이든 보관하고 ack한 결과는 그 실행의 결과로 남는다.
for (const first of ["abandon", "judge"] as const) {
  test(`D-168: 보관하고 ack한 결과가 미반영일 때 ${first === "abandon" ? "포기를 먼저 불러도 거절되고 결과 검사가 판정한다" : "결과 검사가 먼저 판정하면 포기는 not_checking이다"}`, async () => {
    const { ledger, runId, stopReceiptId } = checkingRun(tempPath());
    const backend = fileBackend();
    const reportId = id();
    expectAck(handleForward(forward(await resultReport(reportId, runId)), { ledger, random, results: { backend, ledger } }), reportId, "new");
    expect(ledger.pendingReports()).toMatchObject({ known: true, value: [{ reportId }] });
    const drop = () => ledger.abandonResult({ runId, stopReceiptId, reason: "no_answer", now: NOW + 3 });
    const tick = () => resultCheckTick({ ledger, intake: { intakeOpen: () => true } }, NOW + 4);
    if (first === "abandon") {
      expect(drop()).toEqual({ ok: false, reason: "report_pending" });
      expect(runOf(ledger, runId).state).toBe("checking");
      tick();
    } else {
      tick();
      expect(drop()).toEqual({ ok: false, reason: "not_checking" });
    }
    expect(runOf(ledger, runId)).toMatchObject({ state: "ready_result" });
    expect(ledger.resultAbandon(runId)).toEqual({ known: true, value: null });
    expect(ledger.settledResult(runId)).toMatchObject({ known: true, value: { runId } });
    expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
    expect(keyCount(backend)).toBe(1);
  });
}
