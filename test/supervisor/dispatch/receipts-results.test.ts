// 결과 보고(report_result)의 처리: 거르기 → 보관 → 장부 → ack. 실제 장부와 실제 파일 백엔드(임시 폴더)로 한 번, 장애를 넣은 백엔드로 한 번씩 본다.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { type Action, type Bodies, executorName, limits, sealEnvelope, type Verified, verifyEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import type { Random } from "../../../src/supervisor/dispatch/ports.ts";
import { type ForwardInput, handleForward, type ReceiptOutcome, type ResultPorts } from "../../../src/supervisor/dispatch/receipts.ts";
import { type ResultBackend, listStored } from "../../../src/supervisor/scheduler/result-store.ts";
import { createFileResultBackend, type FilePort, nodeFilePort } from "../../../src/supervisor/scheduler/result-store-file.ts";
import { id, must, NOW, open, ready, SESSION_EXECUTOR, session, startedWorker, tempDir, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";

const OTHER = executorName("diagnosis", "1", "store-b");
const keys = new Map<string, { privateKey: KeyObject; publicKey: KeyObject }>(
  [WORKER_EXECUTOR, OTHER, SESSION_EXECUTOR].map((name) => [name, generateKeyPairSync("ed25519")] as const),
);

// 기록 하나의 상한: 계약의 결과 본문 상한(limits.RESULT_MAX_BYTES, 16KiB)에 머리 길이 4바이트와 직렬화한 머리(digest·소유자 표식·실행 ID·
// 크기·시각, 300바이트 미만)를 더한 값을 넉넉히 덮는다(result-store-file.md "기록 상한"). 운영 값이 아니라 이 시험의 값이다.
const MAX_RECORD = limits.RESULT_MAX_BYTES + 4 + 1024;

const RESULT: Bodies["report_result"]["result"] = { role: "diagnosis", outcome: "completed", summary: "요약", items: [{ kind: "finding", text: "찾은 것" }], refs: [] };
const OTHER_RESULT: Bodies["report_result"]["result"] = { ...RESULT, summary: "다른 요약" };

let nonceSeq = 0;
const nonce = () => (++nonceSeq).toString(16).padStart(32, "0");

// 실행기의 키로 봉하고 감독의 맥락으로 검증한 봉투(연결 판단이 forward로 내는 값). 같은 본문을 다시 부르면 nonce만 다른 재전송이다.
async function verified<A extends Action>(action: A, sender: string, body: Bodies[A], runGeneration: number): Promise<Verified> {
  const envelope = sealEnvelope(
    { sender, recipient: "supervisor", action, request_id: id(), stop_generation: 0, run_generation: runGeneration, issued_at: NOW, nonce: nonce(), body },
    keys.get(sender)!.privateKey,
  );
  const result = await verifyEnvelope(envelope, {
    now: NOW + 1,
    expectedRecipient: "supervisor",
    publicKeyFor: (name) => keys.get(name)?.publicKey,
    stopGeneration: 0,
    runGeneration: () => runGeneration,
    nonces: { consume: () => true },
  });
  if (!result.ok) throw new Error(`검증 실패: ${result.reason}`);
  return result;
}

const resultReport = (reportId: string, runId: string, result = RESULT, sender = WORKER_EXECUTOR, generation = 1) =>
  verified("report_result", sender, { report_id: reportId, run_id: runId, result }, generation);

function forward(v: Verified, extra: Partial<ForwardInput> = {}): ForwardInput {
  return { forward: { verified: v, connection: 1 }, now: NOW + 2, stopGeneration: 0, pendingQueries: [], links: { current: () => true }, backlog: [], ...extra };
}

function countingRandom(log: string[] = []): Random & { calls: number } {
  const state = {
    calls: 0,
    bytes(length: number) {
      state.calls += 1;
      log.push("random");
      return Uint8Array.from({ length }, (_, i) => (state.calls * 31 + i) & 0xff);
    },
  };
  return state;
}

function fileBackend(files: FilePort = nodeFilePort): ResultBackend {
  const made = createFileResultBackend({ dir: tempDir(), maxRecordBytes: MAX_RECORD, files });
  if (made.status !== "ok") throw new Error(`백엔드: ${made.status}`);
  return made.backend;
}

// 폴더 fsync(폴더를 내리기)만 실패시킬 수 있는 파일 포트. 파일 fsync는 그대로다.
function dirSyncFault() {
  const state = { failDir: true, dirSyncs: 0 };
  const port: FilePort = {
    ...nodeFilePort,
    fsync(fd) {
      if (nodeFilePort.fstat(fd).kind === "directory") {
        state.dirSyncs += 1;
        if (state.failDir) throw new Error("EIO: 폴더를 내리지 못함");
      }
      nodeFilePort.fsync(fd);
    },
  };
  return { state, port };
}

// 소유자(입력 요청 ID)가 있는 작업자 실행을 preparing까지 올린 실제 장부.
function ownedRun(ledger: Ledger = open(tempPath())) {
  ready(ledger);
  const owner = id();
  must(ledger.enqueueInput({ requestId: owner, source: "test", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 600_000 }, receivedAt: NOW }));
  const started = startedWorker(ledger, { inputRequestId: owner });
  return { ledger, owner, ...started };
}

function storedKeys(backend: ResultBackend): readonly string[] {
  const listed = backend.keys("result/");
  if (listed.status !== "ok") throw new Error("목록을 읽지 못함");
  return listed.keys;
}
const keyCount = (backend: ResultBackend) => storedKeys(backend).length;

const resultRows = (ledger: Ledger) => {
  const pending = ledger.pendingReports();
  if (!pending.known) throw new Error("보고를 읽지 못함");
  return pending.value.filter((report) => report.action === "report_result");
};

function expectAck(outcome: ReceiptOutcome, reportId: string, delivery: "new" | "duplicate") {
  if (outcome.outcome !== "ack") throw new Error(`ack가 아니다: ${JSON.stringify(outcome)}`);
  expect(outcome.id).toBe(reportId);
  expect(outcome.delivery).toBe(delivery);
  expect(outcome.ack.recipient).toBe(WORKER_EXECUTOR);
  expect(outcome.ack.body.ids).toEqual([reportId]);
}

function expectNoAck(outcome: ReceiptOutcome) {
  expect(outcome.outcome).not.toBe("ack");
  expect("ack" in outcome).toBe(false);
}

// 결과의 JSON에 결과 본문의 글이 없다(거절·오류·결과에 본문을 싣지 않는다).
function expectNoBody(outcome: ReceiptOutcome) {
  const text = JSON.stringify(outcome);
  for (const words of [RESULT.summary, OTHER_RESULT.summary, RESULT.items[0]!.text]) expect(text.includes(words)).toBe(false);
}

describe("보장 1: 보관 → 장부 → ack, 사이에 await가 없다", () => {
  test("실제 장부·실제 파일 백엔드: 참조와 digest가 장부에 적히고 ack가 나간다", async () => {
    const { ledger, runId } = ownedRun();
    const backend = fileBackend();
    const reportId = id();
    const random = countingRandom();
    const outcome = handleForward(forward(await resultReport(reportId, runId)), { ledger, random, results: { backend, ledger } });
    expectAck(outcome, reportId, "new");
    expectNoBody(outcome);
    const rows = resultRows(ledger);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reportId).toBe(reportId);
    expect(rows[0]!.storedRef).toMatch(/^results\/[0-9a-f-]{36}$/);
    expect(keyCount(backend)).toBe(1);
    // 장부의 참조가 가리키는 자리에 그 digest의 본문이 있다.
    const listed = listStored(backend);
    expect(listed).toEqual({ status: "ok", entries: [{ ref: rows[0]!.storedRef!, state: "stored", runId, storedAt: NOW + 2 }] });
  });

  test("부르는 순서: 장부 읽기 → 보관(넣기·다시 읽기) → 장부 기록 → ack 난수", async () => {
    const { ledger, runId } = ownedRun();
    const inner = fileBackend();
    const log: string[] = [];
    const backend: ResultBackend = {
      putNew: (k, b) => (log.push("putNew"), inner.putNew(k, b)),
      read: (k) => (log.push("read"), inner.read(k)),
      readRange: (k, o, l) => (log.push("readRange"), inner.readRange(k, o, l)),
      remove: (k) => (log.push("remove"), inner.remove(k)),
      has: (k) => (log.push("has"), inner.has(k)),
      keys: (p) => (log.push("keys"), inner.keys(p)),
    };
    const results: ResultPorts = {
      backend,
      ledger: {
        getRun: (r) => (log.push("getRun"), ledger.getRun(r)),
        recordReport: (i, f) => (log.push("recordReport"), ledger.recordReport(i, f)),
      },
    };
    const reportId = id();
    expectAck(handleForward(forward(await resultReport(reportId, runId)), { ledger, random: countingRandom(log), results }), reportId, "new");
    expect(log).toEqual(["getRun", "putNew", "read", "recordReport", "random"]);
  });

  test("처리기는 동기다: 소스에 await·async·Promise·then·타이머가 없다", async () => {
    const source = await Bun.file(new URL("../../../src/supervisor/dispatch/receipts.ts", import.meta.url)).text();
    // 주석은 뺀다(주석의 "await가 없다"는 코드가 아니다).
    const code = source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    const found = [/\bawait\b/, /\basync\b/, /\bPromise\b/, /\.then\s*\(/, /\bqueueMicrotask\b/, /\bsetTimeout\b/, /\bsetImmediate\b/, /\bnextTick\b/].flatMap(
      (pattern) => code.match(new RegExp(pattern.source, "g")) ?? [],
    );
    expect(found).toEqual([]);
  });

  test("비동기로 답하는 백엔드는 모름이다: 장부에 적지 않고 ack가 없다", async () => {
    const { ledger, runId } = ownedRun();
    const promised = (() => Promise.resolve({ status: "stored" })) as unknown as ResultBackend["putNew"];
    const backend: ResultBackend = { ...fileBackend(), putNew: promised };
    const random = countingRandom();
    const outcome = handleForward(forward(await resultReport(id(), runId)), { ledger, random, results: { backend, ledger } });
    expect(outcome).toMatchObject({ outcome: "result_unknown", at: "store" });
    expect(random.calls).toBe(0);
    expect(resultRows(ledger)).toHaveLength(0);
  });
});

describe("보장 2: 모름과 거절에는 ack가 없다", () => {
  test("폴더를 내리지 못하는 백엔드: ack 0·장부 0, 다시 보내 성공하면 ack 1·장부 한 줄·보관 한 개", async () => {
    const { ledger, runId } = ownedRun();
    const fault = dirSyncFault();
    const backend = fileBackend(fault.port);
    const reportId = id();
    const random = countingRandom();
    const first = handleForward(forward(await resultReport(reportId, runId)), { ledger, random, results: { backend, ledger } });
    expect(first).toEqual({ outcome: "result_unknown", id: reportId, runId, at: "store" });
    expectNoAck(first);
    expect(random.calls).toBe(0);
    expect(resultRows(ledger)).toHaveLength(0);
    expect(fault.state.dirSyncs).toBeGreaterThan(0);

    fault.state.failDir = false;
    const again = handleForward(forward(await resultReport(reportId, runId)), { ledger, random, results: { backend, ledger } });
    expectAck(again, reportId, "new");
    expect(random.calls).toBe(1);
    expect(resultRows(ledger)).toHaveLength(1);
    expect(keyCount(backend)).toBe(1);
  });

  test("보관은 됐는데 장부가 거절하면 ack가 없고, 본문은 같은 참조로 남아 다시 보내면 이어진다", async () => {
    const { ledger, runId } = ownedRun();
    const backend = fileBackend();
    const reportId = id();
    const refuse = { getRun: (r: string) => ledger.getRun(r), recordReport: () => ({ ok: false as const, reason: "ledger_unwritable" as const }) };
    const random = countingRandom();
    const refused = handleForward(forward(await resultReport(reportId, runId)), { ledger, random, results: { backend, ledger: refuse } });
    expect(refused).toEqual({ outcome: "ledger_refused", action: "report_result", id: reportId, reason: "ledger_unwritable" });
    expect(random.calls).toBe(0);
    // 장부에 참조가 없는 본문이 남는다. 머리가 온전해 고아 정리가 보관 시각으로 고를 수 있다(이 처리기는 지우지 않는다).
    const left = listStored(backend);
    if (left.status !== "ok") throw new Error("목록을 읽지 못함");
    expect(left.entries).toMatchObject([{ state: "stored", runId, storedAt: NOW + 2 }]);
    expect(resultRows(ledger)).toHaveLength(0);

    const again = handleForward(forward(await resultReport(reportId, runId), { now: NOW + 5 }), { ledger, random, results: { backend, ledger } });
    expectAck(again, reportId, "new");
    expect(keyCount(backend)).toBe(1);
    const rows = resultRows(ledger);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.storedRef).toBe(left.entries[0]!.ref);
  });

  test("장부가 던지거나 꼴이 틀린 답이면 ack가 없다", async () => {
    const { ledger, runId } = ownedRun();
    for (const recordReport of [
      () => {
        throw new Error("장부 장애");
      },
      () => ({ ok: true, delivery: "maybe", ack: "x" }),
    ]) {
      const random = countingRandom();
      const outcome = handleForward(forward(await resultReport(id(), runId)), {
        ledger,
        random,
        results: { backend: fileBackend(), ledger: { getRun: (r) => ledger.getRun(r), recordReport: recordReport as Ledger["recordReport"] } },
      });
      expect(outcome.outcome).toBe("ledger_failed");
      expect(random.calls).toBe(0);
    }
  });

  test("정지 세대를 모르면 장부는 받고 ack는 없다. 다시 보내면 같은 참조·같은 줄로 ack한다", async () => {
    const { ledger, runId } = ownedRun();
    const backend = fileBackend();
    const reportId = id();
    const first = handleForward(forward(await resultReport(reportId, runId), { stopGeneration: null }), { ledger, random: countingRandom(), results: { backend, ledger } });
    expect(first).toMatchObject({ outcome: "applied_without_ack", delivery: "new", reason: "stop_generation_unknown" });
    expectAck(handleForward(forward(await resultReport(reportId, runId)), { ledger, random: countingRandom(), results: { backend, ledger } }), reportId, "duplicate");
    expect(resultRows(ledger)).toHaveLength(1);
    expect(keyCount(backend)).toBe(1);
  });

  test("장부를 읽지 못하면 보관소에 닿지 않고 ack가 없다", async () => {
    const { ledger, runId } = ownedRun();
    const backend = fileBackend();
    for (const getRun of [() => ({ known: false, reason: "io" }), () => ({ known: true, value: { runId: id() } }), () => { throw new Error("읽기 장애"); }]) {
      const outcome = handleForward(forward(await resultReport(id(), runId)), {
        ledger,
        random: countingRandom(),
        results: { backend, ledger: { getRun: getRun as Ledger["getRun"], recordReport: (i, f) => ledger.recordReport(i, f) } },
      });
      expect(outcome).toMatchObject({ outcome: "result_unknown", at: "ledger_read" });
    }
    expect(keyCount(backend)).toBe(0);
    expect(resultRows(ledger)).toHaveLength(0);
  });
});

describe("보장 3: 장부가 아는 실행의 결과만, 한 번만", () => {
  test("장부에 없는 실행·다른 실행기·다른 세대·세션·대기·소유자 없음은 보관소에 닿기 전에 거절한다", async () => {
    const { ledger, runId } = ownedRun();
    const backend = fileBackend();
    const queued = must(ledger.admitRun(worker())).run.runId;
    const sessionRun = must(ledger.admitRun(session())).run.runId;
    // 작업자 자리는 하나라 소유자 없는 실행은 다른 장부에서 시작한다.
    const bare = open(tempPath());
    const noOwner = startedWorker(bare).runId;
    const cases: [Verified, string][] = [
      [await resultReport(id(), id()), "unknown_run"],
      [await resultReport(id(), runId, RESULT, OTHER), "sender_mismatch"],
      [await resultReport(id(), runId, RESULT, WORKER_EXECUTOR, 2), "run_generation_mismatch"],
      [await resultReport(id(), queued, RESULT, WORKER_EXECUTOR, ledger.runGeneration(queued)), "not_receivable"],
      [await resultReport(id(), noOwner), "no_owner"],
    ];
    for (const [v, reason] of cases) {
      const random = countingRandom();
      const target = reason === "no_owner" ? bare : ledger;
      const outcome = handleForward(forward(v), { ledger: target, random, results: { backend, ledger: target } });
      expect(outcome).toMatchObject({ outcome: "result_refused", reason });
      expectNoBody(outcome);
      expect(random.calls).toBe(0);
    }
    // 세션 실행기는 report_result를 서명할 수 없다(계약). 지정 실행기·세대가 맞는 세션 줄을 읽었다고 해도 종류에서 걸린다.
    const sessionRow = ledger.getRun(sessionRun);
    if (!sessionRow.known || sessionRow.value === null) throw new Error("세션 실행을 읽지 못함");
    const sessionLike = { ...sessionRow.value, executorId: WORKER_EXECUTOR, runGeneration: 1 };
    const sessionView: ResultPorts["ledger"] = { getRun: () => ({ known: true, value: sessionLike }), recordReport: (i, f) => ledger.recordReport(i, f) };
    expect(handleForward(forward(await resultReport(id(), sessionRun)), { ledger, random: countingRandom(), results: { backend, ledger: sessionView } })).toMatchObject({
      outcome: "result_refused",
      reason: "not_receivable",
    });
    expect(keyCount(backend)).toBe(0);
    expect(resultRows(ledger)).toHaveLength(0);
  });

  test("같은 보고의 재전송은 같은 참조·같은 장부 줄로 끝나고 ack를 다시 만든다", async () => {
    const { ledger, runId } = ownedRun();
    const backend = fileBackend();
    const reportId = id();
    expectAck(handleForward(forward(await resultReport(reportId, runId)), { ledger, random: countingRandom(), results: { backend, ledger } }), reportId, "new");
    const before = resultRows(ledger);
    expectAck(handleForward(forward(await resultReport(reportId, runId), { now: NOW + 9 }), { ledger, random: countingRandom(), results: { backend, ledger } }), reportId, "duplicate");
    expect(resultRows(ledger)).toEqual(before);
    expect(keyCount(backend)).toBe(1);
  });

  test("같은 id에 다른 본문은 충돌이고 새 본문을 남기지 않는다. 앞의 본문과 장부 줄은 그대로다", async () => {
    const { ledger, runId } = ownedRun();
    const backend = fileBackend();
    const reportId = id();
    expectAck(handleForward(forward(await resultReport(reportId, runId)), { ledger, random: countingRandom(), results: { backend, ledger } }), reportId, "new");
    const before = resultRows(ledger);
    const stored = backend.read(storedKeys(backend)[0]!);
    const random = countingRandom();
    const outcome = handleForward(forward(await resultReport(reportId, runId, OTHER_RESULT)), { ledger, random, results: { backend, ledger } });
    expect(outcome).toEqual({ outcome: "result_refused", id: reportId, runId, reason: "conflict" });
    expectNoBody(outcome);
    expect(random.calls).toBe(0);
    expect(keyCount(backend)).toBe(1);
    expect(backend.read(storedKeys(backend)[0]!)).toEqual(stored);
    expect(resultRows(ledger)).toEqual(before);
  });
});
