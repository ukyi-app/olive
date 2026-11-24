// recovery.test.ts의 시험을 원격 구현(RemoteAgent + 가짜 대리)으로 한 번 더 돌린다. 시험과 단언은 그 파일 그대로다.
import { afterAll, beforeAll } from "bun:test";
import { implementation } from "./support.ts";

beforeAll(() => {
  implementation.remote = true;
});
afterAll(() => {
  implementation.remote = false;
});

const target = "./recovery.test.ts?remote";
await import(target);
