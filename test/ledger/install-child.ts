// 끊긴 첫 설치 시험의 자식 프로세스. 둘째 판의 커밋 직전에 "READY"를 찍고 멈춘다. 부모가 이 프로세스의 pid에 SIGKILL을 보낸다.
// 둘째 판은 페이지 캐시를 넘겨 쓰므로 커밋 전의 페이지가 본체에 먼저 내려가고 hot journal이 남는다.
import { writeSync } from "node:fs";
import { openLedger } from "../../src/ledger/index.ts";
import { SPILL_MIGRATIONS } from "./spill-migrations.ts";

const [path] = process.argv.slice(2) as [string];
const faults = {
  at(point: string) {
    if (point !== "migration:2") return;
    writeSync(1, "READY\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
};
const opened = openLedger(path, { clock: () => 1_800_000_000_000, mode: "create", migrations: SPILL_MIGRATIONS, faults });
writeSync(1, `NOT REACHED ${opened.ok}\n`);
