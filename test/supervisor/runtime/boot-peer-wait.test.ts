// 감독이 복원 2단계를 부르기 전에 필수 실행기가 연결 표에 모이기를 기다리는가(D-142·D-143). 조립(boot.ts)의 kickRestore만 본다:
// 2단계는 예전처럼 이웃·점유를 한 번 읽고 한 번 판정한다. 기다리는 것은 필수 실행기가 정확히 하나일 때뿐이고, 둘 이상이면 main과 같은
// 때(1단계 다음 주기)에 2단계를 부른다. 세계는 boot-world.ts(실제 임시 장부, 손으로 돌리는 시계·타이머, 가짜 서버·현관)다.
// 서버의 연결 표만 시험이 바꿔 실행기가 붙는 때를 정한다. 기다림의 상한 25,000ms는 boot.ts의 상수이고 여기서는 글자로 고정한다.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { parsePrincipal, type RunStatus } from "../../../src/contract/v1/index.ts";
import type { OccupancyAnswer } from "../../../src/ledger/index.ts";
import type { LogFields, RunningSupervisor } from "../../../src/supervisor/runtime/boot.ts";
import { Connections } from "../../../src/supervisor/transport/connections.ts";
import { open } from "../../ledger/helpers.ts";
import { EXECUTOR, executorKey, FILES, FRONT_ROWS, registryDoc, WALL, type World, world } from "./boot-world.ts";

const WAIT_MS = 25_000;
const BEAT_EVERY_MS = 100;
const CLOSED_BY_PEER = "peer_unconfirmed,occupancy_unconfirmed";
const WORKER_B = "executor/diagnosis/1/store-a";
// 장부에 없는 실행. 2단계가 실행기의 답에서 이것을 보면 점유 차단(slot_holds)을 쓴다.
const GHOST: RunStatus = { run_id: "cba41caf-f9a6-4d38-b1e7-5953b22896a0", state: "running", run_generation: 1, last_receipt_id: null };

// 등록표의 활성 실행기 executors개(EXECUTOR, WORKER_B 차례). links에 있는 실행기만 연결 표에 인사한 연결(전체 점유 하나)로 보인다.
// greetedCounts는 실제 연결 표의 같은 이름 함수처럼 주체별 연결 수만 낸다(실행 목록 없음).
function arrange(executors: number, restoreStepWaitMs = 30_000) {
  const w = world({ settings: { timing: { beatEveryMs: BEAT_EVERY_MS, beatWaitMs: 1_000, restoreStepWaitMs, startupWaitMs: 500, stopWaitMs: 10_000 } } });
  w.files.set(FILES.registry, () => Promise.resolve(registryDoc(Array.from({ length: executors }, () => ({ publicKeyRaw: executorKey().raw })))));
  const links = new Map<number, { who: string; runs: RunStatus[] }>();
  const server = w.fake.server as unknown as Record<string, unknown>;
  server.recognized = (who: string) => [...links].find(([, link]) => link.who === who)?.[0] ?? null;
  server.table = () => {
    const snap = [...links];
    return {
      candidates: () => snap.map(([connection, link]) => ({ connection, target: "reader", keyId: "key-1", principal: parsePrincipal(link.who), hello: { profile_revision: "", policy_revision: "policy-1" } })),
      occupancy: (): OccupancyAnswer[] => snap.map(([, link]) => ({ executorId: link.who, coverage: "full", runs: link.runs.map((run) => ({ ...run })) })),
      greetedCounts: () => {
        const counts = new Map<string, number>();
        for (const [, link] of snap) counts.set(link.who, (counts.get(link.who) ?? 0) + 1);
        return counts;
      },
      get: (id: number) => {
        const link = snap.find(([connection]) => connection === id)?.[1];
        return link && { id, phase: "greeted", sync: { principal: link.who, generation: 0 }, greeting: { issued_at: WALL, runs: link.runs } };
      },
    };
  };
  // 현관 이웃 행을 물은 단조 시각. 이웃 행은 2단계에서만 묻는다.
  const asked: number[] = [];
  w.front.peers = async () => {
    asked.push(w.time.monoNow());
    return FRONT_ROWS;
  };
  // 기록마다 그때의 단조 시각을 붙인다. onLog는 기록 포트 안에서 부른다(같은 동기 구간).
  const stamped: { event: string; fields: LogFields; at: number }[] = [];
  const hooks: { onLog: ((event: string) => void) | null } = { onLog: null };
  const log = w.deps.log;
  w.deps = {
    ...w.deps,
    log: (event, fields = {}) => {
      stamped.push({ event, fields, at: w.time.monoNow() });
      log(event, fields);
      hooks.onLog?.(event);
    },
  };
  // 2단계 호출과 2단계의 장부 쓰기(점유 차단, 양성 관측)를 센다. 기동 뒤에 건다(watch).
  const calls = { step2: 0, holdSlots: 0, recordRunSightings: 0 };
  const watch = () => {
    const restorer = w.captured.restorer!.value as unknown as Record<string, (...args: unknown[]) => unknown>;
    const step2 = restorer.step2!.bind(restorer);
    restorer.step2 = () => {
      calls.step2 += 1;
      return step2();
    };
    const ledger = w.opened as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ["holdSlots", "recordRunSightings"] as const) {
      const write = ledger[name]!.bind(ledger);
      ledger[name] = (...args: unknown[]) => {
        calls[name] += 1;
        return write(...args);
      };
    }
  };
  const named = (event: string) => stamped.filter((e) => e.event === event);
  return {
    w,
    asked,
    stamped,
    hooks,
    calls,
    watch,
    named,
    // 끝 차례가 장부를 닫은 뒤의 점유 차단. 같은 파일을 다시 열어 읽는다.
    holdsAfterStop: () => {
      const reopened = open(w.ledgerPath);
      try {
        return reopened.slotHolds();
      } finally {
        reopened.close();
      }
    },
    connect: (connection: number, who: string, runs: RunStatus[] = []) => void links.set(connection, { who, runs }),
    // 실제 서버처럼 표를 바꾸고 답 줄에 그 출력을 넘긴다(인사의 full 행, 끊김의 후보 빠짐).
    hello: (connection: number, who: string, runs: RunStatus[]) => {
      links.set(connection, { who, runs });
      w.fake.options!.deliver({ kind: "occupancy", connection, answer: { executorId: who, coverage: "full", runs: runs.map((run) => ({ ...run })) }, issuedAt: WALL });
    },
    drop: (connection: number, who: string) => {
      links.delete(connection);
      w.fake.options!.deliver({ kind: "withdrawn", connection, principal: who });
    },
    steps: () => named("restore_step").map((e) => e.fields.step),
    judged: (step: number) => stamped.find((e) => e.event === "restore_step" && e.fields.step === step),
    fatal: () => stamped.find((e) => e.event === "fatal")?.fields.reason ?? null,
  };
}

async function started(t: ReturnType<typeof arrange>): Promise<RunningSupervisor> {
  const result = await t.w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  t.watch();
  return result.running;
}

// 50ms씩 돌려 조건이 설 때까지. 조건이 서지 않으면 실패한다.
async function until(w: World, done: () => boolean, rounds = 3_000): Promise<void> {
  for (let i = 0; i < rounds && !done(); i += 1) await w.time.advance(50);
  expect(done()).toBe(true);
}

describe("복원 2단계 앞에서 필수 실행기를 기다린다(D-142·D-143)", () => {
  test("(가) 필수 실행기 하나가 기다리는 중에 붙으면 다음 주기에 2단계를 한 번 부르고 접수를 연다", async () => {
    const t = arrange(1);
    const running = await started(t);
    await until(t.w, () => t.judged(1) !== undefined);
    await t.w.time.advance(3_000);
    // 1단계 뒤 3초가 지나도 2단계를 부르지 않았다: 현관 이웃 행도 묻지 않는다.
    expect(t.steps()).toEqual([1]);
    expect([t.asked.length, t.calls.step2]).toEqual([0, 0]);
    const begun = t.named("restore_wait")[0]!;
    expect(begun.fields).toEqual({ step: 2, missing: 1 });
    expect(begun.at - t.judged(1)!.at).toBeLessThanOrEqual(BEAT_EVERY_MS);
    t.connect(1, EXECUTOR);
    await until(t.w, () => t.judged(5) !== undefined);
    expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });
    const ended = t.named("restore_wait_end");
    expect(ended.length).toBe(1);
    expect(ended[0]!.fields).toMatchObject({ step: 2, outcome: "gathered", missing: 0 });
    // 붙은 뒤 다음 주기(100ms 안)에 2단계를 불렀고, 2단계는 이웃 행을 한 번 읽었다.
    const at = t.judged(2)!.at;
    expect(at - begun.at).toBeGreaterThanOrEqual(3_000 - BEAT_EVERY_MS);
    expect(at - begun.at).toBeLessThanOrEqual(3_000 + BEAT_EVERY_MS);
    expect([t.asked.length, t.calls.step2]).toEqual([1, 1]);
    expect(t.asked[0]).toBe(at);
    // 기록 차례: 1단계 → 기다림 시작 → 기다림 끝 → 2단계.
    expect(t.stamped.map((e) => e.event).filter((name) => name.startsWith("restore_"))).toEqual(["restore_step", "restore_wait", "restore_wait_end", "restore_step", "restore_step", "restore_step", "restore_step"]);
    expect(t.named("restore_wait").length).toBe(1);
    expect(t.fatal()).toBeNull();
    expect(await running.stop()).toBe(0);
  });

  const lapses = [
    { name: "단계 기한 30초", stepWait: 30_000 },
    // 기다림(25초)이 단계 기한보다 길어도 2단계는 부를 때 새 기한을 받는다.
    { name: "단계 기한 10초(2단계는 새 기한)", stepWait: 10_000 },
  ];
  for (const c of lapses) {
    test(`(나) 25초 안에 붙지 않으면 2단계를 부르고 예전처럼 peer_unconfirmed로 닫힌 채 돈다(96 아님): ${c.name}`, async () => {
      const t = arrange(1, c.stepWait);
      const running = await started(t);
      let ended: number | null = null;
      void running.done.then((code) => {
        ended = code;
      });
      await until(t.w, () => t.judged(5) !== undefined);
      const at = t.judged(2)!.at;
      // 1단계 뒤 25초를 기다린 다음에야 2단계를 불렀다.
      expect(at - t.judged(1)!.at).toBeGreaterThanOrEqual(WAIT_MS);
      const begun = t.named("restore_wait")[0]!;
      expect(begun.fields).toEqual({ step: 2, missing: 1 });
      expect(at - begun.at).toBeGreaterThanOrEqual(WAIT_MS);
      expect(at - begun.at).toBeLessThanOrEqual(WAIT_MS + BEAT_EVERY_MS);
      expect(t.named("restore_wait_end").map((e) => e.fields)).toEqual([{ step: 2, outcome: "lapsed", missing: 1, waitedMs: at - begun.at }]);
      // 2단계는 한 번 읽고 한 번 판정했다(다시 읽지 않는다).
      expect([t.asked.length, t.calls.step2]).toEqual([1, 1]);
      expect(t.asked[0]).toBe(at);
      expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: false, closedBecause: CLOSED_BY_PEER });
      // 닫힌 판정이면 닫힌 채 돈다. 늦게 붙어도 이 프로세스에서 다시 기다리거나 판정하지 않는다.
      t.connect(1, EXECUTOR);
      await t.w.time.advance(c.stepWait + WAIT_MS);
      expect(t.steps()).toEqual([1, 2, 3, 4, 5]);
      expect(t.named("restore_wait").length).toBe(1);
      expect(t.fatal()).toBeNull();
      expect(ended).toBeNull();
      expect(await running.stop()).toBe(0);
    });
  }

  test("(다) 필수 실행기 하나가 이미 붙어 있으면 기다리지 않는다: 1단계 다음 주기에 2단계, 기다림 기록 없음", async () => {
    const t = arrange(1);
    t.connect(1, EXECUTOR);
    const running = await started(t);
    await until(t.w, () => t.judged(5) !== undefined);
    expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });
    expect(t.judged(2)!.at - t.judged(1)!.at).toBeLessThanOrEqual(BEAT_EVERY_MS);
    expect([t.asked.length, t.calls.step2]).toEqual([1, 1]);
    expect([t.named("restore_wait").length, t.named("restore_wait_end").length]).toEqual([0, 0]);
    expect(t.fatal()).toBeNull();
    expect(await running.stop()).toBe(0);
  });

  test("(라) 기다리는 중 멈춤: 2단계를 부르지 않고 장부 쓰기 0, 0으로 끝난다", async () => {
    // 기다리는 것은 필수 실행기 하나가 빠졌을 때뿐이라, 장부 밖 실행을 든 실행기는 멈춤 뒤에 붙인다.
    const t = arrange(1);
    const running = await started(t);
    await until(t.w, () => t.judged(1) !== undefined);
    await t.w.time.advance(1_000);
    expect(await running.stop()).toBe(0);
    // 멈춤 뒤에 실행기가 장부 밖 실행을 들고 붙고 상한을 지나도 2단계는 없다.
    t.connect(1, EXECUTOR, [GHOST]);
    await t.w.time.advance(WAIT_MS + 5_000);
    expect(t.calls).toEqual({ step2: 0, holdSlots: 0, recordRunSightings: 0 });
    expect(t.steps()).toEqual([1]);
    expect(t.asked.length).toBe(0);
    expect(t.holdsAfterStop()).toEqual({ known: true, value: [] });
    expect(t.w.captured.lines!.ports.observationsSettled()).toBe(false);
    expect(t.named("restore_wait").map((e) => e.fields)).toEqual([{ step: 2, missing: 1 }]);
    expect(t.named("restore_wait_end")).toEqual([]);
    expect(t.named("restore_retry")).toEqual([]);
    expect(t.fatal()).toBeNull();
    expect(await running.done).toBe(0);
  });

  test("(라) 기다림이 끝나는 같은 동기 구간에서 멈춤이 시작되면 2단계를 부르지 않는다", async () => {
    const t = arrange(1);
    const running = await started(t);
    await until(t.w, () => t.judged(1) !== undefined);
    // 기다림이 시작된 뒤에 실행기를 붙인다.
    await t.w.time.advance(500);
    let stopping: Promise<number> | null = null;
    // 기다림 끝의 기록 포트 안(kickRestore의 같은 동기 구간)에서 끝 차례를 시작한다.
    t.hooks.onLog = (event) => {
      if (event === "restore_wait_end" && stopping === null) stopping = running.stop();
    };
    // 붙은 실행기가 장부 밖 실행을 답했다. 2단계를 불렀다면 점유 차단을 썼을 것이다.
    t.connect(1, EXECUTOR, [GHOST]);
    for (let i = 0; i < 100 && stopping === null; i += 1) await t.w.time.advance(50);
    await t.w.time.advance(WAIT_MS);
    expect(t.calls).toEqual({ step2: 0, holdSlots: 0, recordRunSightings: 0 });
    expect(stopping).not.toBeNull();
    expect(await stopping!).toBe(0);
    expect(t.named("restore_wait_end").map((e) => e.fields.outcome)).toEqual(["gathered"]);
    expect(t.steps()).toEqual([1]);
    expect(t.asked.length).toBe(0);
    expect(t.holdsAfterStop()).toEqual({ known: true, value: [] });
    expect(t.fatal()).toBeNull();
  });

  test("(마) 등록표에 활성 실행기가 없으면 기다리지 않는다", async () => {
    const t = arrange(0);
    const running = await started(t);
    await until(t.w, () => t.judged(5) !== undefined);
    expect(t.w.captured.restorer!.requiredPeers).toEqual(["front-door", "observation-relay"]);
    expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });
    expect(t.judged(2)!.at - t.judged(1)!.at).toBeLessThanOrEqual(BEAT_EVERY_MS);
    expect([t.asked.length, t.calls.step2]).toEqual([1, 1]);
    expect([t.named("restore_wait").length, t.named("restore_wait_end").length]).toEqual([0, 0]);
    expect(t.fatal()).toBeNull();
    expect(await running.stop()).toBe(0);
  });

  // D-143: 필수 실행기가 둘 이상이면 기다리지 않는다. 기다리는 동안 먼저 붙은 실행기의 연결이 바뀌면 2단계가 그 실행기의 앞 답(장부 밖
  // 실행)을 보지 못해 main보다 슬롯을 덜 막기 때문이다(아래 (사)).
  const pairs = [
    { name: "하나만 붙음", present: [EXECUTOR] },
    { name: "둘 다 없음", present: [] as string[] },
  ];
  for (const c of pairs) {
    test(`(바) 필수 실행기가 둘이면 기다리지 않고 main처럼 1단계 다음 주기에 2단계를 부른다: ${c.name}`, async () => {
      const t = arrange(2);
      c.present.forEach((who, i) => t.connect(i + 1, who));
      const running = await started(t);
      await until(t.w, () => t.judged(5) !== undefined);
      expect(t.judged(2)!.at - t.judged(1)!.at).toBeLessThanOrEqual(BEAT_EVERY_MS);
      expect([t.asked.length, t.calls.step2]).toEqual([1, 1]);
      expect(t.asked[0]).toBe(t.judged(2)!.at);
      expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: false, closedBecause: CLOSED_BY_PEER });
      expect([t.named("restore_wait").length, t.named("restore_wait_end").length]).toEqual([0, 0]);
      // 늦게 붙어도 이 프로세스에서 다시 판정하지 않는다.
      t.connect(1, EXECUTOR);
      t.connect(2, WORKER_B);
      await t.w.time.advance(WAIT_MS + 5_000);
      expect(t.steps()).toEqual([1, 2, 3, 4, 5]);
      expect([t.asked.length, t.calls.step2]).toEqual([1, 1]);
      expect(t.fatal()).toBeNull();
      expect(await running.stop()).toBe(0);
    });
  }

  // 리뷰 3 P1의 두 재접속 순서. 실행기 A(EXECUTOR)가 장부 밖 실행을 인사하고 200ms 뒤 끊긴 다음, A가 다른 상태로 다시 붙고 B가 빈
  // full로 붙는다. main은 1단계 다음 주기에 A의 첫 인사를 읽어 작업자 슬롯 차단 1행을 쓰고 B가 빠져 닫는다. 실행기가 둘이면 같은 때에
  // 2단계를 부르므로 결과가 main과 같아야 한다.
  const rejoins: { name: string; first: RunStatus["state"]; again: RunStatus[] }[] = [
    { name: "A cleanup_pending → 끊김 → A·B 빈 full", first: "cleanup_pending", again: [] },
    { name: "A preparing → 끊김 → A not_started, B 빈 full", first: "preparing", again: [{ ...GHOST, state: "not_started" }] },
  ];
  for (const c of rejoins) {
    test(`(사) 실행기 둘의 재접속 순서에서 main과 같다: 접수 닫힘, 작업자 슬롯 막힘, 차단 1행: ${c.name}`, async () => {
      const t = arrange(2);
      const running = await started(t);
      await t.w.time.flush();
      expect(t.steps()).toEqual([1]);
      expect(t.calls.step2).toBe(0);
      t.hello(1, EXECUTOR, [{ ...GHOST, state: c.first }]);
      await t.w.time.advance(200);
      t.drop(1, EXECUTOR);
      t.hello(2, EXECUTOR, c.again);
      t.hello(3, WORKER_B, []);
      await t.w.time.advance(2_000);
      expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: false, closedBecause: CLOSED_BY_PEER });
      expect(t.named("restore_wait")).toEqual([]);
      expect(t.calls.step2).toBe(1);
      expect(t.w.opened!.slotFree("worker")).toEqual({ known: true, value: false });
      expect(t.fatal()).toBeNull();
      expect(await running.stop()).toBe(0);
      // 끝 차례가 장부를 닫은 뒤 비활성 행까지 전부 읽는다(slotHolds는 holds_slot=1만 낸다).
      const db = new Database(t.w.ledgerPath, { readonly: true });
      try {
        expect(db.query("SELECT executor_id, run_id, run_generation, holds_slot, why FROM slot_holds ORDER BY observation").all()).toEqual([
          { executor_id: EXECUTOR, run_id: GHOST.run_id, run_generation: 1, holds_slot: 1, why: "outside_ledger" },
        ]);
      } finally {
        db.close();
      }
    });
  }

  // 리뷰 3 P2. 기다리는 동안 주기마다 하는 조회가 정지 세대를 장부에서 읽으면, 그 읽기의 일시 실패가 장부 고장(96)이 된다.
  test("(아) 기다리는 동안의 조회는 장부를 읽지 않는다: 실제 연결 표·실제 임시 장부, 그동안 장부 읽기가 던져도 96 아님", async () => {
    // 운영과 같은 1초 주기. 연결 표는 실제 Connections이고 붙은 실행기가 없어 기다린다.
    const w = world({ settings: { timing: { beatEveryMs: 1_000, beatWaitMs: 5_000, restoreStepWaitMs: 30_000, startupWaitMs: 10_000, stopWaitMs: 10_000 } } });
    const table = Connections.start();
    w.fake.server.table = () => table;
    w.files.set(FILES.registry, () => Promise.resolve(registryDoc([{ publicKeyRaw: executorKey().raw }])));
    let frontCalls = 0;
    w.front.peers = () => {
      frontCalls += 1;
      return Promise.resolve(FRONT_ROWS);
    };
    // 기다리는 구간의 장부 읽기를 세고 모두 던진다.
    let watching = false;
    let reads = 0;
    const openLedger = w.deps.openLedger;
    w.deps = {
      ...w.deps,
      openLedger: (path, options) =>
        openLedger(path, {
          ...options,
          faults: {
            at(point) {
              if (point !== "read" || !watching) return;
              reads += 1;
              throw new Error("시험: 기다리는 동안의 장부 읽기");
            },
          },
        }),
    };
    const booted = await w.boot();
    if (!booted.ok) throw new Error(`기동하지 못했다: ${booted.step} ${booted.reason}`);
    await w.time.flush();
    expect(w.events.some((e) => e.event === "restore_step" && e.fields.step === 1)).toBe(true);
    watching = true;
    await w.time.advance(5_000);
    watching = false;
    expect(reads).toBe(0);
    expect(frontCalls).toBe(0);
    expect(w.events.filter((e) => e.event === "restore_wait").map((e) => e.fields)).toEqual([{ step: 2, missing: 1 }]);
    expect(w.opened!.health().writable).toBe(true);
    expect(w.events.find((e) => e.event === "fatal")).toBeUndefined();
    expect(await booted.running.stop()).toBe(0);
  });

  // 리뷰 3 P3. 2단계의 새 기한을 읽는 시계(주입 포트) 안에서 멈춤이 시작된다. 운영 시계(performance.now)는 재진입하지 않으므로 포트
  // 경계의 틈이다. 기다림 끝의 멈춤 확인((라) 둘째) 뒤라 그 확인으로는 막히지 않는다.
  const deadlineStops = [
    { name: "필수 실행기 하나, 기다림이 모여 끝난 뒤", executors: 1 },
    { name: "필수 실행기 둘, 기다리지 않음", executors: 2 },
  ];
  for (const c of deadlineStops) {
    test(`(자) 2단계의 기한을 읽는 도중 멈춤이 시작되면 2단계를 부르지 않는다: ${c.name}`, async () => {
      const t = arrange(c.executors);
      if (c.executors === 2) t.connect(1, EXECUTOR, [GHOST]);
      // kickRestore가 단계 기한을 정하는 시계 읽기(deadline) 안에서만 멈춤을 건다.
      const mono = t.w.deps.monoNow;
      let onDeadline: (() => void) | null = null;
      t.w.deps = {
        ...t.w.deps,
        monoNow: () => {
          const act = onDeadline;
          if (act !== null) {
            const frames = new Error().stack ?? "";
            if (frames.includes("at deadline (") && frames.includes("at kickRestore (")) {
              onDeadline = null;
              act();
            }
          }
          return mono();
        },
      };
      const running = await started(t);
      await until(t.w, () => t.judged(1) !== undefined);
      let stopping: Promise<number> | null = null;
      onDeadline = () => {
        stopping = running.stop();
      };
      if (c.executors === 1) {
        await t.w.time.advance(500);
        expect(t.named("restore_wait").length).toBe(1);
        t.connect(1, EXECUTOR, [GHOST]);
      }
      for (let i = 0; i < 100 && stopping === null; i += 1) await t.w.time.advance(50);
      expect(stopping).not.toBeNull();
      expect(await stopping!).toBe(0);
      await t.w.time.advance(WAIT_MS);
      expect(t.calls).toEqual({ step2: 0, holdSlots: 0, recordRunSightings: 0 });
      expect(t.steps()).toEqual([1]);
      expect(t.asked.length).toBe(0);
      expect(t.holdsAfterStop()).toEqual({ known: true, value: [] });
      expect(t.fatal()).toBeNull();
    });
  }
});
