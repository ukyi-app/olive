// 조회 대체의 판단(src/supervisor/runtime/query-book.ts의 supersededBy). 새 조회를 더하기 직전에, 같은 받는 이·연결에서 실행 ID가 하나라도
// 겹치는 등록 항목(같은 요청 ID 포함)을 끝낼 항목으로 고른다. 조립(boot.ts)이 등록부에 더할 때마다 이 항목을 끝내 받는 이·연결·실행마다
// 미결 조회가 하나 이하다. 등록부 자체는 대체를 모른다(같은 실행의 조회가 여럿 기다리는 답 줄의 처리는 answers.test.ts가 본다).
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SentQuery } from "../../../src/supervisor/dispatch/receipts.ts";
import { createQueryBook, supersededBy } from "../../../src/supervisor/runtime/query-book.ts";

const R1 = "executor/diagnosis/0/store-a";
const R2 = "executor/diagnosis/1/store-a";
const A = randomUUID();
const B = randomUUID();

// 조립과 같은 차례: 더하기 전에 고르고, 더한 뒤 고른 항목을 끝낸다.
function addWithBound(book: ReturnType<typeof createQueryBook>, query: SentQuery): void {
  const held = supersededBy(book.pending(), query);
  book.add(query);
  for (const entry of held) book.settle(entry);
}

// 받는 이·연결·실행 ID마다 등록 항목 수의 최댓값.
function maxPerRun(book: ReturnType<typeof createQueryBook>): number {
  const counts = new Map<string, number>();
  for (const entry of book.pending()) for (const runId of new Set(entry.runIds)) counts.set(`${entry.recipient} ${entry.connection} ${runId}`, (counts.get(`${entry.recipient} ${entry.connection} ${runId}`) ?? 0) + 1);
  return Math.max(0, ...counts.values());
}

describe("조회 대체의 판단", () => {
  test("더하기 전에 고른 항목을 더한 뒤 끝내면 같은 받는 이·연결·실행의 항목은 60번 더해도 하나만 남는다", () => {
    const book = createQueryBook();
    let last = "";
    for (let i = 0; i < 60; i += 1) {
      last = randomUUID();
      addWithBound(book, { requestId: last, recipient: R1, runIds: [A], connection: 1 });
      expect(book.pending().length).toBe(1);
    }
    expect(book.pending().map((entry) => entry.requestId)).toEqual([last]);
  });

  test("실행 ID가 하나라도 겹치면(차례·부분 집합·중첩·중복 무관) 고르고, 받는 이·연결이 다르거나 겹치는 실행이 없으면 고르지 않는다", () => {
    const query = { requestId: randomUUID(), recipient: R1, runIds: [B, A], connection: 1 };
    const overlapping = [
      { requestId: randomUUID(), recipient: R1, runIds: [A, B], connection: 1 },
      { requestId: randomUUID(), recipient: R1, runIds: [A], connection: 1 },
      { requestId: randomUUID(), recipient: R1, runIds: [A, B, randomUUID()], connection: 1 },
      { requestId: randomUUID(), recipient: R1, runIds: [A, A], connection: 1 },
      { requestId: randomUUID(), recipient: R1, runIds: [randomUUID(), B], connection: 1 },
    ];
    const others = [
      { requestId: randomUUID(), recipient: R2, runIds: [A, B], connection: 1 },
      { requestId: randomUUID(), recipient: R1, runIds: [A, B], connection: 2 },
      { requestId: randomUUID(), recipient: R1, runIds: [randomUUID()], connection: 1 },
    ];
    expect(supersededBy([...overlapping, ...others], query)).toEqual(overlapping);
  });

  test("같은 요청 ID를 다시 싣는 것도 대체다: 앞 항목을 고르고, 끝낸 뒤 그 요청 ID의 항목은 하나다", () => {
    const book = createQueryBook();
    const query = { requestId: randomUUID(), recipient: R1, runIds: [A], connection: 1 };
    addWithBound(book, query);
    const first = book.pending()[0]!;
    expect(supersededBy(book.pending(), { ...query })).toEqual([first]);
    addWithBound(book, { ...query });
    expect(book.pending()).toHaveLength(1);
    expect(book.pending()[0]).not.toBe(first);
  });

  test("여러 실행을 묻는 조회·실행 집합의 중첩·같은 요청 ID의 재송신을 섞어 더해도 받는 이·연결·실행마다 항목은 하나 이하다", () => {
    const book = createQueryBook();
    const runs = [A, B, randomUUID(), randomUUID()];
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 300; i += 1) {
      const picked = runs.filter(() => next(2) === 0);
      const runIds = picked.length === 0 ? [runs[next(runs.length)]!] : picked;
      addWithBound(book, { requestId: ids[next(ids.length)]!, recipient: next(4) === 0 ? R2 : R1, runIds, connection: 1 + next(2) });
      expect(maxPerRun(book)).toBeLessThanOrEqual(1);
    }
    expect(book.pending().length).toBeGreaterThan(0);
  });
});
