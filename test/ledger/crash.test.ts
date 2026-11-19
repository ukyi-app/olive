// 감독 재시작 시험: 트랜잭션 도중에 프로세스가 끊긴 뒤 같은 파일을 다시 연다.
// 신호는 이 시험이 띄우고 pid를 기록한 자식 프로세스 하나에만 보낸다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadMigrations, openLedger, Restorer } from "../../src/ledger/index.ts";
import { clock, NOW, open, tempPath } from "./helpers.ts";

async function crashAt(path: string, scenario: string): Promise<Record<string, string>> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "crash-child.ts"), path, scenario], { stdout: "pipe", stderr: "pipe" });
  const pid = child.pid;
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  if (!text.startsWith("READY ")) {
    child.kill("SIGKILL");
    throw new Error(`자식이 멈춘 지점에 닿지 않음: ${text} ${await new Response(child.stderr).text()}`);
  }
  process.kill(pid, "SIGKILL");
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  return JSON.parse(text.slice("READY ".length).trim());
}

const OPTS = { requiredPeers: ["front-door"] };
const FROM = { sender: "executor/diagnosis/0/store-a", runGeneration: 1 };

const ports = {
  stopAuthority: { latestStop: async () => null },
  peers: { contracts: async () => [] },
  occupancy: { occupancy: async () => [] },
  publications: { lookup: async () => ({ kind: "pending" as const }) },
};

test("끊김: 기록과 영수증 사이에서 끊겨도 다시 열면 일관된다", async () => {
  const path = tempPath();
  const { runId, requestId, receiptId } = await crashAt(path, "receipt_gap");
  const ledger = open(path);
  // 실행 줄과 지시는 남고 영수증은 없다. 복원은 같은 실행을 묻기만 하고 다시 실행하지 않는다.
  expect(ledger.getRun(runId)).toMatchObject({ known: true, value: { state: "preparing", acceptedReceiptId: null } });
  const restorer = new Restorer(ledger, ports, clock, OPTS);
  await restorer.step1();
  await restorer.step2();
  const s3 = await restorer.step3();
  expect(s3.statusQueries).toEqual([{ executorId: "executor/diagnosis/0/store-a", runIds: [runId] }]);
  expect(ledger.getRun(runId)).toMatchObject({ value: { state: "unknown_running" } });
  // 실행기가 다시 보낸 같은 영수증은 한 번 반영된다.
  const again = { action: "receipt_accepted" as const, receiptId, runId, instructionRequestId: requestId, instruction: "task_start" as const, bodyDigest: "c".repeat(64), now: NOW };
  expect(ledger.applyReceipt(again, FROM)).toMatchObject({ ok: true, delivery: "new" });
  expect(ledger.applyReceipt(again, FROM)).toMatchObject({ ok: true, delivery: "duplicate" });
});

test("끊김: 영수증과 상태 전이 사이에서 끊기면 둘 다 없다", async () => {
  const path = tempPath();
  const { runId, receiptId } = await crashAt(path, "receipt_transition");
  const ledger = open(path);
  expect(ledger.getRun(runId)).toMatchObject({ value: { state: "stopping", stopReceiptId: null } });
  const stoppedReceipt = { action: "receipt_stopped" as const, receiptId, runId, exit: "completed" as const, bodyDigest: "d".repeat(64), now: NOW };
  expect(ledger.applyReceipt(stoppedReceipt, FROM)).toMatchObject({ ok: true, delivery: "new" });
  expect(ledger.getRun(runId)).toMatchObject({ value: { state: "checking", stopReceiptId: receiptId } });
});

test("끊김: 마이그레이션 도중에 끊기면 그 판이 없고, 다시 열면 처음부터 적용한다", async () => {
  const path = tempPath();
  await crashAt(path, "migration");
  const raw = new Database(path);
  expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  raw.close();
  // 첫 설치가 끝나지 않았으므로 재개방은 열지 않고, 첫 설치를 다시 하면 처음부터 적용한다.
  expect(openLedger(path, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "not_initialized" });
  const ledger = open(path, { mode: "create" });
  expect(ledger.readStop()).toEqual({ known: true, value: null });
});

test("끊김: 첫 설치가 트랜잭션 도중에 끊긴 파일은 남은 저널과 함께 create가 바로 이어 받고 끝나면 WAL로 동작한다", async () => {
  const path = tempPath();
  await crashAt(path, "migration");
  const resumed = openLedger(path, { clock, mode: "create" });
  // 첫 판에서 끊겼으므로 적용된 판이 없고, 이어 받으면 코드의 판을 처음부터 모두 적용한다.
  expect(resumed).toMatchObject({ ok: true, migrated: { from: 0, to: loadMigrations().length } });
  if (!resumed.ok) return;
  expect(resumed.ledger.readStop()).toEqual({ known: true, value: null });
  resumed.ledger.close();
  const raw = new Database(path);
  expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  raw.close();
  expect(openLedger(path, { clock, mode: "create" })).toMatchObject({ ok: false, reason: "already_initialized" });
});

test("끊김: 정지 세대 저장 도중에 끊기면 앞 세대가 그대로 남는다(정지 상태 유지)", async () => {
  const path = tempPath();
  await crashAt(path, "stop");
  const ledger = open(path);
  expect(ledger.readStop()).toMatchObject({ known: true, value: { generation: 3, stopped: true } });
  const restorer = new Restorer(ledger, ports, clock, OPTS);
  expect(await restorer.step1()).toEqual({ stopGeneration: 3, stopped: true, source: "ledger" });
});
