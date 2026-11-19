// 본체와 WAL 쌍을 남기는 자식 프로세스. 정지와 nonce를 커밋한 뒤 "READY"를 찍고 멈춘다. 부모가 이 프로세스의 pid에 SIGKILL을 보낸다.
// 커밋은 WAL에만 있고 본체는 첫 설치 때의 크기로 남는다.
import { writeSync } from "node:fs";
import { openLedger } from "../../src/ledger/index.ts";

export const WAL_PAIR_GENERATION = 8;
export const WAL_PAIR_NONCES = 170;
export const WAL_PAIR_SENDER = "executor/diagnosis/0/store-a";
export const walPairNonce = (index: number) => index.toString(16).padStart(32, "0");

if (import.meta.main) {
  const [path] = process.argv.slice(2) as [string];
  const NOW = 1_800_000_000_000;
  const opened = openLedger(path, { clock: () => NOW, mode: "create" });
  if (!opened.ok) throw new Error(opened.reason);
  const { ledger } = opened;
  const stop = ledger.applyStop({ generation: WAL_PAIR_GENERATION, stopped: true, now: NOW });
  if (!stop.ok) throw new Error(stop.reason);
  const store = ledger.nonceStore();
  for (let index = 0; index < WAL_PAIR_NONCES; index++) store.consume(WAL_PAIR_SENDER, walPairNonce(index), NOW + 30_000);
  writeSync(1, "READY\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
