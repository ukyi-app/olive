// 지속 상태 저장소 시험: 정지 세대(0 포함, 단조 증가), nonce(재시작 뒤 거절), 저장소 ID(초기화되면 새 값), 실행 기록·보낸 영수증.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExecutorStore, type RunRecord } from "../../src/executor/store.ts";
import { Clock, scratch, sha256 } from "./support.ts";

test("저장소: 처음 열면 정지 세대가 없음(null)이고, 0을 받아들이면 0을 파일에 적는다", async () => {
  const dir = scratch();
  const store = await ExecutorStore.open(dir);
  expect(store.stopGeneration()).toBeNull();
  expect(await store.adoptStopGeneration(0)).toEqual({ saved: true, current: 0 });
  expect(JSON.parse(readFileSync(join(dir, "stop-generation.json"), "utf8"))).toEqual({ stop_generation: 0 });
  expect((await ExecutorStore.open(dir)).stopGeneration()).toBe(0);
});

test("저장소: 동시에 온 더 높은 세대를 낮은 값으로 덮지 않는다(저장 순간에 다시 확인한다)", async () => {
  const dir = scratch();
  const store = await ExecutorStore.open(dir);
  const results = await Promise.all([store.adoptStopGeneration(5), store.adoptStopGeneration(4), store.adoptStopGeneration(5)]);
  expect(results.map((r) => r.saved)).toEqual([true, true, true]);
  expect(store.durableStopGeneration()).toBe(5);
  expect((await ExecutorStore.open(dir)).stopGeneration()).toBe(5);
  // 낮은 값이 먼저 와도 높은 값이 남는다.
  const other = await ExecutorStore.open(scratch());
  await Promise.all([other.adoptStopGeneration(2), other.adoptStopGeneration(9)]);
  expect(other.durableStopGeneration()).toBe(9);
});

test("저장소: 저장 중이거나 저장에 실패한 더 높은 세대도 메모리 울타리는 곧바로 올라가고, 실패는 saved false다", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let fail = false;
  const store = await ExecutorStore.open(scratch(), {
    io: {
      writeDurable: async (path, data) => {
        await gate;
        if (fail) throw new Error("disk");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, data);
      },
    },
  });
  const pending = store.adoptStopGeneration(3);
  // 첫 await 전에 올라간다: 이 사이에 띄우기 직전 확인이 와도 낮은 세대의 실행을 막는다.
  expect(store.stopGeneration()).toBe(3);
  expect(store.durableStopGeneration()).toBeNull();
  release();
  expect(await pending).toEqual({ saved: true, current: 3 });
  fail = true;
  expect((await store.adoptStopGeneration(4)).saved).toBe(false);
  expect(store.stopGeneration()).toBe(4);
  expect(store.durableStopGeneration()).toBe(3);
});

test("저장소: nonce는 한 번만 성공하고, 같은 폴더로 다시 열어도 재사용을 거절한다(동시에 와도 하나만)", async () => {
  const clock = new Clock();
  const dir = scratch();
  const store = await ExecutorStore.open(dir, { now: clock.now });
  const nonce = "a".repeat(32);
  const results = await Promise.all([1, 2, 3].map(() => store.consume("supervisor", nonce, clock.now() + 30_000)));
  expect(results.filter(Boolean)).toHaveLength(1);
  // 낸 쪽이 다르면 다른 기록이다.
  expect(await store.consume("front-door", nonce, clock.now() + 30_000)).toBe(true);
  const reopened = await ExecutorStore.open(dir, { now: clock.now });
  expect(await reopened.consume("supervisor", nonce, clock.now() + 30_000)).toBe(false);
});

test("저장소: 초기화(빈 폴더)되면 저장소 ID가 새 값이고, 같은 폴더면 같은 값이다. ID는 주체 이름의 칸 꼴이다", async () => {
  const dir = scratch();
  const first = await ExecutorStore.open(dir);
  expect(first.storageId).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  expect((await ExecutorStore.open(dir)).storageId).toBe(first.storageId);
  expect((await ExecutorStore.open(scratch())).storageId).not.toBe(first.storageId);
  // 두 프로세스가 같은 빈 폴더를 동시에 열어도 하나의 ID로 모인다.
  const shared = scratch();
  const [a, b] = await Promise.all([ExecutorStore.open(shared), ExecutorStore.open(shared)]);
  expect(a.storageId).toBe(b.storageId);
});

test("저장소: 실행 기록과 보낸 영수증은 다시 열어도 같은 값이고, 접수 기록을 적지 못하면 메모리도 바꾸지 않는다", async () => {
  const dir = scratch();
  const store = await ExecutorStore.open(dir);
  const record: RunRecord = {
    run_id: randomUUID(),
    run_generation: 2,
    state: "preparing",
    start_stop_generation: 0,
    instruction_request_id: randomUUID(),
    deadline_at: 2_000,
    lease_until: 1_500,
    credential_digest: sha256("x"),
    exit: null,
    last_receipt_id: null,
  };
  expect(await store.beginRun(record)).toBe(true);
  expect(await store.beginRun(record)).toBe(false);
  const entry = { id: randomUUID(), action: "receipt_accepted" as const, run_id: record.run_id, run_generation: 2, body: { a: 1 }, acked: false };
  await store.addOutbox(entry);
  await store.ack([entry.id]);
  const reopened = await ExecutorStore.open(dir);
  expect(reopened.run(record.run_id)).toEqual(record);
  expect(reopened.outbox(entry.id)).toEqual({ ...entry, acked: true });
  expect(reopened.unacked()).toEqual([]);

  const broken = await ExecutorStore.open(scratch(), { io: { writeDurable: async () => Promise.reject(new Error("disk")) } });
  expect(await broken.beginRun(record)).toBe(false);
  expect(broken.run(record.run_id)).toBeUndefined();
});
