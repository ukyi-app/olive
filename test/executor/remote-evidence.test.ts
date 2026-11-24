// evidence.test.ts의 시험을 원격 구현(RemoteAgent + 가짜 대리)으로 한 번 더 돌린다. 시험과 단언은 그 파일 그대로다.
// 링크로 옮길 수 없는 가짜 launcher를 전제한 시험(support.ts의 DIRECT_ONLY)만 등록하지 않고, 그 이름을 아래에서 대조한다.
// 이 파일이 WorkerExecutor를 직접 만드는 두 자리(G08·H03 기동 대조)는 띄우기·정리를 부르지 않아 rig를 거치지 않는다.
import { afterAll, beforeAll, expect } from "bun:test";
import { DIRECT_ONLY, implementation, test, unregisteredRemote } from "./support.ts";

beforeAll(() => {
  implementation.remote = true;
});
afterAll(() => {
  implementation.remote = false;
});

const target = "./evidence.test.ts?remote";
const before = unregisteredRemote.length;
implementation.registeringRemote = true;
try {
  await import(target);
} finally {
  implementation.registeringRemote = false;
}
const skipped = unregisteredRemote.slice(before);

test("원격 실행에서 뺀 evidence 시험은 DIRECT_ONLY의 그 이름뿐이다(직접 실행에서는 돈다)", () => {
  expect(skipped).toEqual(["F10 nonce 장애가 이미 정상 종료한 프로그램의 결과를 실패로 바꾸지 않는다"]);
  for (const name of skipped) expect(DIRECT_ONLY.has(name)).toBe(true);
});
