// worker.test.ts의 시험을 원격 구현(RemoteAgent + 가짜 대리)으로 한 번 더 돌린다. 시험과 단언은 그 파일 그대로다.
// 같은 파일을 쿼리를 붙여 다시 import하면 Bun이 새 모듈로 읽어 그 시험들이 이 파일 이름으로 다시 등록된다.
import { afterAll, beforeAll } from "bun:test";
import { implementation } from "./support.ts";

beforeAll(() => {
  implementation.remote = true;
});
afterAll(() => {
  implementation.remote = false;
});

const target = "./worker.test.ts?remote";
await import(target);
