// 체크포인트 도중에 스스로 끝나는 자식. 장부를 만들고 한 커밋으로 WAL에 새 페이지를 쌓은 뒤 장부를 닫는다(닫기가 WAL을 본체로 체크포인트한다).
// 감시 Worker는 본체 파일이 커지기 시작하면(체크포인트가 파일을 늘렸다) 정해진 시간을 더 기다린 뒤 이 프로세스 자신에게 SIGKILL을 보낸다.
// 신호는 자기 자신에게만 보낸다. 닫기가 감시보다 먼저 끝나면 "CLOSED"를 찍고 정상 종료한다.
import type { Database } from "bun:sqlite";
import { lstatSync, writeSync } from "node:fs";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { openLedger } from "../../src/ledger/index.ts";

// WAL에 쌓을 nonce 줄 수. 4,096바이트 페이지로 수백 페이지(수 MB 미만)이고 자동 체크포인트(1,000페이지)에 닿지 않는다.
export const CHECKPOINT_ROWS = 12_000;

if (!isMainThread) {
  const { path, before, delayMicros } = workerData as { path: string; before: number; delayMicros: number };
  parentPort?.postMessage("armed");
  while (lstatSync(path).size <= before) {
    // 체크포인트가 본체를 늘릴 때까지 돈다.
  }
  const until = performance.now() + delayMicros / 1000;
  while (performance.now() < until) {
    // 체크포인트 안의 다른 지점에서 끊으려고 정해진 시간을 더 돈다.
  }
  process.kill(process.pid, "SIGKILL");
} else if (import.meta.main) {
  const [path, delay] = process.argv.slice(2) as [string, string];
  const NOW = 1_800_000_000_000;
  let raw: Database | undefined;
  const opened = openLedger(path, {
    clock: () => NOW,
    mode: "create",
    faults: {
      at() {},
      onOpen(db) {
        raw = db;
      },
    },
  });
  if (!opened.ok || raw === undefined) throw new Error(opened.ok ? "연결을 받지 못함" : opened.reason);
  raw.run(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${CHECKPOINT_ROWS})
     INSERT INTO nonces (sender, nonce, expires_at) SELECT 'executor/diagnosis/0/store-a', printf('%032x', i), ${NOW + 30_000} FROM n`,
  );
  const before = lstatSync(path).size;
  const worker = new Worker(import.meta.path, { workerData: { path, before, delayMicros: Number(delay) } });
  await new Promise((resolve) => worker.once("message", resolve));
  opened.ledger.close();
  writeSync(1, "CLOSED\n");
  await worker.terminate();
}
