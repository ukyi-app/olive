// 조회 대체의 판단(src/supervisor/runtime/query-book.ts의 supersededBy). 같은 받는 이·연결·실행 ID 집합에 새 요청 ID의 조회를 더하면 앞
// 항목을 끝낼 항목으로 고른다. 조립(boot.ts)이 등록부에 더할 때마다 이 항목을 끝내 답 없는 연결에 조회가 쌓이지 않게 한다. 등록부 자체는
// 대체를 모른다(같은 실행의 조회가 여럿 기다리는 답 줄의 처리는 answers.test.ts가 본다).
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createQueryBook, supersededBy } from "../../../src/supervisor/runtime/query-book.ts";

const R1 = "executor/diagnosis/0/store-a";
const R2 = "executor/diagnosis/1/store-a";
const A = randomUUID();
const B = randomUUID();

describe("조회 대체의 판단", () => {
  test("더할 때마다 고른 항목을 끝내면 같은 받는 이·연결·실행 집합의 항목은 60번 더해도 하나만 남는다", () => {
    const book = createQueryBook();
    let last = "";
    for (let i = 0; i < 60; i += 1) {
      last = randomUUID();
      const query = { requestId: last, recipient: R1, runIds: [A], connection: 1 };
      book.add(query);
      for (const held of supersededBy(book.pending(), query)) book.settle(held);
      expect(book.pending().length).toBe(1);
    }
    expect(book.pending().map((entry) => entry.requestId)).toEqual([last]);
  });

  test("실행 집합은 차례와 무관하게 같으면 고르고, 받는 이·연결·실행 집합 하나라도 다르면 고르지 않는다", () => {
    const first = { requestId: randomUUID(), recipient: R1, runIds: [A, B], connection: 1 };
    const others = [
      { requestId: randomUUID(), recipient: R2, runIds: [A, B], connection: 1 },
      { requestId: randomUUID(), recipient: R1, runIds: [A, B], connection: 2 },
      { requestId: randomUUID(), recipient: R1, runIds: [A], connection: 1 },
      { requestId: randomUUID(), recipient: R1, runIds: [A, B, randomUUID()], connection: 1 },
      { requestId: randomUUID(), recipient: R1, runIds: [A, A], connection: 1 },
    ];
    const query = { requestId: randomUUID(), recipient: R1, runIds: [B, A], connection: 1 };
    expect(supersededBy([first, ...others], query)).toEqual([first]);
  });

  test("같은 요청 ID를 다시 실은 항목은 고르지 않는다: 실은 횟수만큼 항목이 있다", () => {
    const query = { requestId: randomUUID(), recipient: R1, runIds: [A], connection: 1 };
    expect(supersededBy([query, { ...query }], { ...query, runIds: [A] })).toEqual([]);
  });
});
