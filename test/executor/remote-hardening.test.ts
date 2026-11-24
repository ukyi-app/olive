// hardening.test.ts의 시험을 원격 구현(RemoteAgent + 가짜 대리)으로 한 번 더 돌린다. 시험과 단언은 그 파일 그대로다.
// 링크로 옮길 수 없는 가짜 launcher를 전제한 시험(support.ts의 DIRECT_ONLY)만 등록하지 않고, 그 이름을 아래에서 대조한다.
import { afterAll, beforeAll, expect } from "bun:test";
import { DIRECT_ONLY, implementation, test, unregisteredRemote } from "./support.ts";

beforeAll(() => {
  implementation.remote = true;
});
afterAll(() => {
  implementation.remote = false;
});

const target = "./hardening.test.ts?remote";
const before = unregisteredRemote.length;
implementation.registeringRemote = true;
try {
  await import(target);
} finally {
  implementation.registeringRemote = false;
}
const skipped = unregisteredRemote.slice(before);

test("원격 실행에서 뺀 hardening 시험은 DIRECT_ONLY의 그 이름들뿐이다(직접 실행에서는 돈다)", () => {
  expect(skipped).toEqual([
    "R11 제때 끝난 프로그램은 stdout을 읽는 사이 임대 시각이 지나도 completed다(뒤의 정리·계수는 계속한다)",
    "R11 끝난 프로그램의 임대는 늘지 않는다",
    "R16 깊이 상한을 넘는 결과는 고정 실패 결과가 되고 이미 확인한 종료 증거·상태를 뒤집지 않는다",
  ]);
  for (const name of skipped) expect(DIRECT_ONLY.has(name)).toBe(true);
});
