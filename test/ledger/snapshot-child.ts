// 끊긴 사본 시험의 자식 프로세스. 사본을 쓰는 도중의 정해진 지점에서 "READY"를 찍고 멈춘다. 부모가 이 프로세스의 pid에 SIGKILL을 보낸다.
import { writeSync } from "node:fs";
import { openLedger } from "../../src/ledger/index.ts";

const [path, target, point] = process.argv.slice(2) as [string, string, string];
const faults = {
  at(reached: string) {
    if (reached !== point) return;
    writeSync(1, "READY\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
};
const opened = openLedger(path, { clock: () => 1_800_000_000_000, mode: "create", faults });
if (!opened.ok) throw new Error(opened.reason);
const result = opened.ledger.createSnapshot({ path: target, maxBytes: 10_000_000 });
writeSync(1, `NOT REACHED ${JSON.stringify(result)}\n`);
