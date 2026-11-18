// 끊김 시험의 자식 프로세스. 장부 트랜잭션의 정해진 지점에서 "READY"를 찍고 멈춘다. 부모가 이 프로세스의 pid에 SIGKILL을 보낸다.
// 쓰기는 fs.writeSync로 한다: console.log는 파이프에서 비동기로 버퍼링돼 멈추기 전에 나가지 않을 수 있다.
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { openLedger } from "../../src/ledger/index.ts";

const [path, scenario] = process.argv.slice(2);
const NOW = 1_800_000_000_000;
const sha = (c: string) => c.repeat(64);
let target = "";
const info: Record<string, string> = {};
const faults = {
  at(point: string) {
    if (point !== target) return;
    writeSync(1, `READY ${JSON.stringify(info)}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
};

if (scenario === "migration") target = "migration:1";
const opened = openLedger(path, { clock: () => NOW, faults });
if (!opened.ok) throw new Error(opened.reason);
const ledger = opened.ledger;

function startWorker() {
  ledger.applyStop({ generation: 0, stopped: false, now: NOW });
  const runId = randomUUID();
  const admitted = ledger.admitRun({
    kind: "worker",
    runId,
    dedupeKey: null,
    inputRequestId: null,
    role: "diagnosis",
    snapshotDigest: sha("a"),
    inputDigest: null,
    profileRevision: "p1",
    policyRevision: "q1",
    executorId: "executor/diagnosis/0/store-a",
    credential: { account: "acct", method: "subscription", revision: "r1", digest: sha("b") },
    deadlineAt: NOW + 600_000,
    budgetLeft: 1000,
    now: NOW,
  });
  const requestId = randomUUID();
  const started = ledger.startRun({ runId, requestId, stopGeneration: 0, now: NOW });
  if (!admitted.ok || !started.ok) throw new Error("setup");
  info.runId = runId;
  info.requestId = requestId;
  return { runId, requestId };
}

if (scenario === "receipt_gap") {
  const { runId, requestId } = startWorker();
  info.receiptId = randomUUID();
  target = "receipt:before_commit";
  ledger.applyReceipt({ action: "receipt_accepted", receiptId: info.receiptId, runId, instructionRequestId: requestId, bodyDigest: sha("c"), now: NOW });
} else if (scenario === "receipt_transition") {
  const { runId } = startWorker();
  ledger.recordStopInstruction({ runId, requestId: randomUUID(), action: "task_cancel", stopGeneration: 0, now: NOW });
  info.receiptId = randomUUID();
  target = "receipt:after_insert";
  ledger.applyReceipt({ action: "receipt_stopped", receiptId: info.receiptId, runId, exit: "completed", bodyDigest: sha("d"), now: NOW });
} else if (scenario === "stop") {
  ledger.applyStop({ generation: 3, stopped: true, now: NOW });
  target = "stop:before_commit";
  ledger.applyStop({ generation: 4, stopped: false, now: NOW });
}
writeSync(1, "NOT REACHED\n");
