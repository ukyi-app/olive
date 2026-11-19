// 지속 상태 저장소 시험: 정지 세대(0 포함, 단조 증가), nonce(재시작 뒤 거절), 저장소 ID(초기화되면 새 값), 실행 기록·보낸 영수증.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { limits } from "../../src/contract/v1/index.ts";
import { ExecutorStore, type RunRecord, type StoreError } from "../../src/executor/store.ts";
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
  // 최종값만이 아니라 파일에 적힌 값 하나하나가 줄지 않는지 본다(중간에 4를 적었다가 5로 덮는 퇴행도 잡는다).
  const written: number[] = [];
  const store = await ExecutorStore.open(dir, {
    io: {
      writeDurable: async (path, data) => {
        if (path.endsWith("stop-generation.json")) written.push((JSON.parse(data) as { stop_generation: number }).stop_generation);
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, data);
      },
    },
  });
  const results = await Promise.all([store.adoptStopGeneration(5), store.adoptStopGeneration(4), store.adoptStopGeneration(5)]);
  expect(results.map((r) => r.saved)).toEqual([true, true, true]);
  expect(written).toEqual([5]);
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
  const id = randomUUID();
  const body = { receipt_id: id, run_id: record.run_id, instruction_request_id: record.instruction_request_id, instruction: "task_start" };
  const entry = { id, action: "receipt_accepted" as const, run_id: record.run_id, run_generation: 2, body, acked: false };
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

function sampleRun(): RunRecord {
  return {
    run_id: randomUUID(),
    run_generation: 1,
    state: "running",
    start_stop_generation: 0,
    instruction_request_id: randomUUID(),
    deadline_at: 2_000,
    lease_until: 1_500,
    credential_digest: sha256("x"),
    exit: null,
    last_receipt_id: null,
  };
}

test("저장소: 빈 새 볼륨, 일부만 복원된 같은 ID, ID만 잃은 폴더, 끊긴 JSON·맞지 않는 본문을 서로 다른 경우로 연다", async () => {
  expect((await ExecutorStore.open(scratch())).inconsistency()).toBeNull();
  const seed = async () => {
    const dir = scratch();
    const store = await ExecutorStore.open(dir);
    await store.adoptStopGeneration(0);
    const record = sampleRun();
    await store.beginRun(record);
    const id = randomUUID();
    const body = { receipt_id: id, run_id: record.run_id, instruction_request_id: record.instruction_request_id, instruction: "task_start" };
    await store.addOutbox({ id, action: "receipt_accepted", run_id: record.run_id, run_generation: 1, body, acked: false });
    await store.noteRun({ ...record, last_receipt_id: id });
    expect((await ExecutorStore.open(dir)).inconsistency()).toBeNull();
    return { dir, record, id };
  };
  // 실행 기록만 잃었다.
  const lostRun = await seed();
  rmSync(join(lostRun.dir, "runs", `${lostRun.record.run_id}.json`));
  expect((await ExecutorStore.open(lostRun.dir)).inconsistency()).toBe("run_missing");
  // 영수증만 잃었다.
  const lostReceipt = await seed();
  rmSync(join(lostReceipt.dir, "outbox", `${lostReceipt.id}.json`));
  expect((await ExecutorStore.open(lostReceipt.dir)).inconsistency()).toBe("receipt_missing");
  // 하위 폴더를 잃었다: 새로 만들지 않는다.
  const lostDir = await seed();
  rmSync(join(lostDir.dir, "runs"), { recursive: true });
  expect((await ExecutorStore.open(lostDir.dir)).inconsistency()).toBe("dir_missing");
  // ID만 잃었다: 새 ID가 되지만 옛 기록이 남은 것을 알린다.
  const lostId = await seed();
  rmSync(join(lostId.dir, "storage-id"));
  expect((await ExecutorStore.open(lostId.dir)).inconsistency()).toBe("storage_id_lost");
  // 끊긴 JSON, 기록의 id와 맞지 않는 본문은 열지 않는다.
  const cut = await seed();
  writeFileSync(join(cut.dir, "outbox", `${cut.id}.json`), "{\"id\":");
  expect(await ExecutorStore.open(cut.dir).then(() => "opened", (error: StoreError) => error.code)).toBe("store_corrupt");
  const wrong = await seed();
  const path = join(wrong.dir, "outbox", `${wrong.id}.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), body: { a: 1 } }));
  expect(await ExecutorStore.open(wrong.dir).then(() => "opened", (error: StoreError) => error.code)).toBe("store_corrupt");
});

test("저장소: nonce는 실제 소비 시각에 만료됐으면 표식 없이 거절하고, 줄이 밀려 보존 기한을 넘겨도 같은 봉투를 두 번 받지 않는다", async () => {
  const clock = new Clock();
  const dir = scratch();
  const store = await ExecutorStore.open(dir, { now: clock.now });
  const expires = clock.now() + limits.MESSAGE_TTL_MAX_MS;
  expect(await store.consume("supervisor", "a".repeat(32), expires)).toBe(true);
  // 첫 표식이 정리될 만큼 소비가 늦어졌다. 봉투는 그 사이 만료됐다.
  clock.advance(limits.NONCE_RETENTION_MS + 1_000);
  expect(await store.consume("supervisor", "a".repeat(32), expires)).toBe(false);
  expect(readdirSync(join(dir, "nonces"))).toEqual([]);
  // 정각도 만료다.
  expect(await store.consume("supervisor", "b".repeat(32), clock.now())).toBe(false);
  expect(readdirSync(join(dir, "nonces"))).toEqual([]);
  expect(store.healthy()).toBe(true);
});

test("저장소: nonce 기록 실패는 재사용과 구별해 장애로 알리고, 쓰기가 돌아온 것을 확인하면 풀린다", async () => {
  const clock = new Clock();
  let failing = true;
  const store = await ExecutorStore.open(scratch(), {
    now: clock.now,
    io: {
      createMarker: async (path) => {
        if (failing) throw Object.assign(new Error("disk"), { code: "ENOSPC" });
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, "", { flag: "wx" });
      },
    },
  });
  expect(await store.consume("supervisor", "c".repeat(32), clock.now() + 30_000)).toBe(false);
  expect(store.healthy()).toBe(false);
  failing = false;
  expect(await store.consume("supervisor", "d".repeat(32), clock.now() + 30_000)).toBe(true);
  // 재사용은 장애가 아니다.
  expect(await store.consume("supervisor", "d".repeat(32), clock.now() + 30_000)).toBe(false);
  expect(store.healthy()).toBe(false);
  await store.flush();
  expect(store.healthy()).toBe(true);
});
