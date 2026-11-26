// 장부 초기화 시험의 자식: 감독처럼 장부를 reopen으로 열어 쥔다. 표준 입력이 닫히면 장부를 닫고 0으로 끝난다(신호 없이 끝내려고).
import { openLedger } from "../src/ledger/index.ts";

const opened = openLedger(process.argv[2]!, { clock: Date.now, mode: "reopen" });
if (!opened.ok) {
  console.log(`failed ${opened.reason}`);
  process.exit(1);
}
console.log("held");
for await (const _ of Bun.stdin.stream()) {
  // 내용은 쓰지 않는다. 닫힘만 기다린다.
}
opened.ledger.close();
process.exit(0);
