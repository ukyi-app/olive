// 복원 2단계가 필수 이웃을 그 단계 기한 안에서 기다리는가(D-141). 조립(boot.ts)과 이웃 포트(peers.ts)를 함께 본다.
// 세계는 boot-world.ts(실제 임시 장부, 손으로 돌리는 시계·타이머, 가짜 서버·현관)다. 서버의 연결 표만 시험이 바꿔 실행기가 붙는 때를 정한다.
// 기다림의 끝은 min(단계 시작 + 25,000, 단계 기한 − 5,000)이고 250ms마다 다시 읽는다(peers.ts의 상수). 여기서는 그 값을 글자로 고정한다.
import { describe, expect, test } from "bun:test";
import { parsePrincipal, type RunStatus } from "../../../src/contract/v1/index.ts";
import { type OccupancyAnswer, RestoreStepError } from "../../../src/ledger/index.ts";
import type { LogFields, RunningSupervisor } from "../../../src/supervisor/runtime/boot.ts";
import type { ConnectionServer } from "../../../src/supervisor/transport/server.ts";
import { EXECUTOR, executorKey, FILES, FRONT_ROWS, registryDoc, WALL, type World, world } from "./boot-world.ts";

const CLOSED_BY_PEER = "peer_unconfirmed,occupancy_unconfirmed";

// 필수 이웃: 현관·관측 중계(현관 행)와 등록표의 활성 실행기 하나(EXECUTOR). connected가 참인 동안만 연결 표에 그 실행기의 인사가 있다.
function arrange(restoreStepWaitMs: number, connected: boolean) {
  const w = world({ settings: { timing: { beatEveryMs: 100, beatWaitMs: 1_000, restoreStepWaitMs, startupWaitMs: 500, stopWaitMs: 700 } } });
  w.files.set(FILES.registry, () => Promise.resolve(registryDoc([{ publicKeyRaw: executorKey().raw }])));
  const table = { connected };
  const principal = parsePrincipal(EXECUTOR);
  if (principal === undefined) throw new Error("실행기 이름의 꼴이 틀렸다");
  const candidates = () => (table.connected ? [{ connection: 1, target: "reader", principal, keyId: "key-1", hello: { profile_revision: "", policy_revision: "policy-1" } }] : []);
  const occupancy = (): OccupancyAnswer[] => (table.connected ? [{ executorId: EXECUTOR, coverage: "full", runs: [] }] : []);
  const start = w.deps.startServer;
  const log = w.deps.log;
  // 기록마다 그때의 단조 시각을 붙인다.
  const stamped: { event: string; fields: LogFields; at: number }[] = [];
  w.deps = {
    ...w.deps,
    startServer: async (options) => {
      const made = await start(options);
      return made.ok ? { ok: true, server: { ...made.server, table: () => ({ candidates, occupancy }) } as unknown as ConnectionServer } : made;
    },
    log: (event, fields = {}) => {
      stamped.push({ event, fields, at: w.time.monoNow() });
      log(event, fields);
    },
  };
  // 현관 이웃 행을 물은 단조 시각. 이웃 행은 2단계에서만 묻는다: 첫 값이 2단계를 부른 때다.
  const asked: number[] = [];
  const rows = w.front.peers;
  w.front.peers = async () => {
    asked.push(w.time.monoNow());
    return rows();
  };
  const steps = () => stamped.filter((e) => e.event === "restore_step").map((e) => e.fields.step);
  const judged = (step: number) => stamped.find((e) => e.event === "restore_step" && e.fields.step === step);
  const fatal = () => stamped.find((e) => e.event === "fatal")?.fields.reason ?? null;
  return { w, table, stamped, asked, steps, judged, fatal };
}

async function started(w: World): Promise<RunningSupervisor> {
  const result = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  return result.running;
}

// 50ms씩 돌려 조건이 설 때까지. 조건이 서지 않으면 실패한다.
async function until(w: World, done: () => boolean, rounds = 3_000): Promise<void> {
  for (let i = 0; i < rounds && !done(); i += 1) await w.time.advance(50);
  expect(done()).toBe(true);
}

describe("복원 2단계가 필수 이웃을 기다린다(D-141)", () => {
  test("(가) 2단계를 시작한 뒤 기한 안에 필수 실행기가 붙으면 그때의 읽기로 판정해 접수를 연다", async () => {
    const t = arrange(30_000, false);
    const running = await started(t.w);
    await until(t.w, () => t.asked.length > 0);
    const begun = t.asked[0]!;
    await t.w.time.advance(1_000);
    // 1초가 지나도 2단계는 판정하지 않았다(기다리는 중).
    expect(t.steps()).toEqual([1]);
    t.table.connected = true;
    await until(t.w, () => t.judged(5) !== undefined);
    expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });
    // 붙은 뒤 다음 읽기(250ms 안)에서 판정했다.
    const at = t.judged(2)!.at;
    expect(at - begun).toBeGreaterThanOrEqual(1_000);
    expect(at - begun).toBeLessThanOrEqual(1_250);
    expect(t.fatal()).toBeNull();
    expect(await running.stop()).toBe(0);
  });

  const lapses = [
    { name: "운영 값 30초: 기한 5초 전(= 시작 + 25초)", stepWait: 30_000, waited: 25_000 },
    { name: "기한 10초: 여유가 정한다(기한 5초 전)", stepWait: 10_000, waited: 5_000 },
    { name: "기한 120초: 대기 상한이 정한다(시작 + 25초)", stepWait: 120_000, waited: 25_000 },
  ];
  for (const c of lapses) {
    test(`(나) 끝내 붙지 않으면 기한 전에 2단계를 끝내고 지금처럼 닫는다, 감독은 끝나지 않는다: ${c.name}`, async () => {
      const t = arrange(c.stepWait, false);
      const running = await started(t.w);
      let ended: number | null = null;
      void running.done.then((code) => {
        ended = code;
      });
      await until(t.w, () => t.judged(5) !== undefined);
      const begun = t.asked[0]!;
      expect(t.judged(2)!.at - begun).toBe(c.waited);
      // 기다림의 끝은 그 단계 기한보다 확실히 앞이다.
      expect(t.judged(2)!.at).toBeLessThan(begun + c.stepWait);
      expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: false, closedBecause: CLOSED_BY_PEER });
      // 다시 읽기는 250ms 간격이고 끝 시각에는 새로 묻지 않는다: 기다린 시간 / 250번(0, 250, …, 끝 시각 − 250).
      expect(t.asked.length).toBe(c.waited / 250);
      expect(t.asked.at(-1)! - begun).toBe(c.waited - 250);
      // 닫힌 판정이면 닫힌 채 돈다. 기한을 넘겨 96으로 끝나지 않는다.
      await t.w.time.advance(c.stepWait);
      expect(t.fatal()).toBeNull();
      expect(ended).toBeNull();
      expect(await running.stop()).toBe(0);
    });
  }

  test("(다) 이미 모였으면 기다리지 않는다: 한 번 읽고 그 자리에서 판정, 열림", async () => {
    const t = arrange(30_000, true);
    const running = await started(t.w);
    await until(t.w, () => t.judged(5) !== undefined);
    expect(t.asked.length).toBe(1);
    expect(t.judged(2)!.at).toBe(t.asked[0]!);
    expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });
    expect(t.fatal()).toBeNull();
    expect(await running.stop()).toBe(0);
  });

  test("(라) 기다리는 중 멈춤: 기다림을 끊고 2단계를 판정하지 않으며(장부 쓰기·기록 없음) 0으로 끝난다", async () => {
    const t = arrange(30_000, false);
    const running = await started(t.w);
    await until(t.w, () => t.asked.length > 0);
    await t.w.time.advance(1_000);
    expect(t.steps()).toEqual([1]);
    const before = t.asked.length;
    expect(await running.stop()).toBe(0);
    // 멈춤 뒤에는 다시 읽지 않는다. 그 뒤 실행기가 붙어도, 기다림의 끝을 지나도 2단계 판정은 없다.
    t.table.connected = true;
    await t.w.time.advance(30_000);
    expect(t.asked.length).toBe(before);
    expect(t.steps()).toEqual([1]);
    expect(t.stamped.filter((e) => e.event === "restore_retry")).toEqual([]);
    expect(t.fatal()).toBeNull();
    expect(await running.done).toBe(0);
  });
});

// 리뷰 경계(PR #89 리뷰의 P1 둘·P2 하나). 연결 표를 시험이 바꾸고, 실행기의 인사·끊김은 답 줄에도 서버 출력으로 넘긴다(실제 서버 차례).
const WORKER_B = "executor/diagnosis/1/store-a";
// 장부에 없는 실행. 실행기가 쥐고 있다고 답하면 2단계가 그 실행 ID와(활동 중이면) 그 종류의 슬롯을 막는다.
const GHOST: RunStatus = { run_id: "cba41caf-f9a6-4d38-b1e7-5953b22896a0", state: "running", run_generation: 1, last_receipt_id: null };

function linked(executors: number, timing: { restoreStepWaitMs: number; stopWaitMs: number } = { restoreStepWaitMs: 30_000, stopWaitMs: 10_000 }) {
  const w = world({ settings: { timing: { beatEveryMs: 100, beatWaitMs: 1_000, startupWaitMs: 500, ...timing } } });
  w.files.set(FILES.registry, () => Promise.resolve(registryDoc(Array.from({ length: executors }, () => ({ publicKeyRaw: executorKey().raw })))));
  const links = new Map<number, { who: string; runs: RunStatus[] }>();
  const server = w.fake.server as unknown as Record<string, unknown>;
  server.recognized = (who: string) => [...links].find(([, link]) => link.who === who)?.[0] ?? null;
  server.table = () => {
    const snap = [...links];
    return {
      candidates: () => snap.map(([connection, link]) => ({ connection, target: "reader", keyId: "key-1", principal: parsePrincipal(link.who), hello: { profile_revision: "", policy_revision: "policy-1" } })),
      occupancy: (): OccupancyAnswer[] => snap.map(([, link]) => ({ executorId: link.who, coverage: "full", runs: link.runs.map((run) => ({ ...run })) })),
      get: (id: number) => {
        const link = snap.find(([connection]) => connection === id)?.[1];
        return link && { id, phase: "greeted", sync: { principal: link.who, generation: 0 }, greeting: { issued_at: WALL, runs: link.runs } };
      },
    };
  };
  const asked: number[] = [];
  w.front.peers = async () => {
    asked.push(w.time.monoNow());
    return FRONT_ROWS;
  };
  const stamped: { event: string; fields: LogFields; at: number }[] = [];
  const log = w.deps.log;
  w.deps = {
    ...w.deps,
    log: (event, fields = {}) => {
      stamped.push({ event, fields, at: w.time.monoNow() });
      log(event, fields);
    },
  };
  const deliver = (output: unknown) => (w.fake.options!.deliver as (value: unknown) => void)(output);
  return {
    w,
    asked,
    stamped,
    judged: (step: number) => stamped.find((e) => e.event === "restore_step" && e.fields.step === step),
    fatal: () => stamped.find((e) => e.event === "fatal")?.fields.reason ?? null,
    hello(connection: number, who: string, runs: RunStatus[]) {
      links.set(connection, { who, runs });
      deliver({ kind: "occupancy", connection, answer: { executorId: who, coverage: "full", runs }, issuedAt: WALL });
    },
    disconnect(connection: number, who: string) {
      links.delete(connection);
      deliver({ kind: "withdrawn", connection, principal: who });
    },
    holds: () => {
      const read = w.opened!.slotHolds();
      if (!read.known) throw new Error("점유 차단을 읽지 못했다");
      return read.value;
    },
  };
}

// 현관 이웃 행이 ms 뒤에 오게 한다(손으로 돌리는 타이머).
function slowFront(t: ReturnType<typeof linked>, ms: number) {
  t.w.front.peers = () => {
    t.asked.push(t.w.time.monoNow());
    return new Promise((resolve) => t.w.time.setTimer(ms, () => resolve(FRONT_ROWS)));
  };
}

describe("기다림 전체의 절대 끝 시각(리뷰 P1: 재조회가 기한을 넘겨 96)", () => {
  test("현관 답이 매번 6초 걸려도 끝 시각(시작 + 25초)에 마지막으로 끝난 읽기로 판정하고, 끝 시각에는 새로 묻지 않는다, 감독은 끝나지 않는다", async () => {
    const t = linked(1);
    slowFront(t, 6_000);
    const running = await started(t.w);
    await until(t.w, () => t.fatal() !== null || t.judged(5) !== undefined);
    expect(t.fatal()).toBeNull();
    const begun = t.asked[0]!;
    expect(t.judged(2)!.at - begun).toBe(25_000);
    expect(t.asked.map((at) => at - begun)).toEqual([0, 6_250, 12_500, 18_750]);
    expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: false, closedBecause: CLOSED_BY_PEER });
    await t.w.time.advance(30_000);
    expect(t.fatal()).toBeNull();
    expect(await running.stop()).toBe(0);
  });

  test("기준 사례: 현관 답이 6초 걸려도 첫 답에 모였으면 그 답 하나로 판정한다(읽기 1번, 열림)", async () => {
    const t = linked(1);
    slowFront(t, 6_000);
    const running = await started(t.w);
    t.hello(1, EXECUTOR, []);
    await until(t.w, () => t.judged(5) !== undefined);
    expect(t.asked.length).toBe(1);
    expect(t.judged(2)!.at - t.asked[0]!).toBe(6_000);
    expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });
    expect(t.fatal()).toBeNull();
    expect(await running.stop()).toBe(0);
  });

  test("다시 읽기 타이머 하나가 5,001ms 늦어도 끝 시각에 판정한다", async () => {
    const t = linked(1);
    const timer = t.w.deps.setTimer;
    let delayed = 0;
    t.w.deps = {
      ...t.w.deps,
      setTimer: (ms, fire) => {
        if (ms === 250 && t.asked.length === 100) {
          delayed += 1;
          return timer(ms + 5_001, fire);
        }
        return timer(ms, fire);
      },
    };
    const running = await started(t.w);
    await until(t.w, () => t.fatal() !== null || t.judged(5) !== undefined);
    expect(t.fatal()).toBeNull();
    expect(delayed).toBe(1);
    expect(t.judged(2)!.at - t.asked[0]!).toBe(25_000);
    expect(t.judged(5)!.fields.intakeMayOpen).toBe(false);
    await t.w.time.advance(30_000);
    expect(t.fatal()).toBeNull();
    expect(await running.stop()).toBe(0);
  });

  // 여유 5초가 보장하는 것: 끝 시각 뒤의 판정과 장부 쓰기(점유 차단·양성 관측)가 합쳐 5초 미만이면 단계 기한 안이다. 5초 이상이면 지금처럼 96이다.
  const tails = [
    { cost: 4_999, fatal: null, code: 0 },
    { cost: 5_000, fatal: "restore_lapsed", code: 96 },
  ];
  for (const c of tails) {
    test(`느린 현관과 끝 시각 뒤의 점유 차단 쓰기 ${c.cost}ms: ${c.code === 0 ? "기한 안" : "여유를 넘기면 지금처럼 96"}`, async () => {
      const t = linked(2);
      slowFront(t, 6_000);
      let spent = 0;
      const mono = t.w.deps.monoNow;
      t.w.deps = { ...t.w.deps, monoNow: () => mono() + spent };
      const running = await started(t.w);
      t.hello(1, EXECUTOR, [GHOST]);
      const ledger = t.w.opened!;
      const hold = ledger.holdSlots.bind(ledger);
      let wroteAt = -1;
      ledger.holdSlots = (...args) => {
        wroteAt = mono() - t.asked[0]!;
        const written = hold(...args);
        spent += c.cost;
        return written;
      };
      await until(t.w, () => t.fatal() !== null || t.judged(5) !== undefined);
      expect(wroteAt).toBe(25_000);
      expect(t.fatal()).toBe(c.fatal);
      if (c.code === 0) expect(t.judged(5)!.fields.intakeMayOpen).toBe(false);
      expect(await running.stop()).toBe(c.code);
    });
  }
});

describe("이번 2단계에서 본 점유 차단을 연결이 사라져도 보관한다(리뷰 P1)", () => {
  test("A가 장부 밖 running을 답한 뒤 끊기고 B가 붙으면: 그 실행의 차단 행이 남고, 옛 full은 A의 전체 점유로 세지 않는다", async () => {
    const t = linked(2);
    const running = await started(t.w);
    t.hello(1, EXECUTOR, [GHOST]);
    await until(t.w, () => t.asked.length > 0);
    t.disconnect(1, EXECUTOR);
    t.hello(2, WORKER_B, []);
    await until(t.w, () => t.judged(5) !== undefined);
    expect(t.holds()).toEqual([{ runId: GHOST.run_id, executorId: EXECUTOR, kind: "worker", runGeneration: 1, holdsSlot: true, why: "outside_ledger", observation: expect.any(Number) }]);
    expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: false, closedBecause: CLOSED_BY_PEER });
    expect(t.fatal()).toBeNull();
    expect(await running.stop()).toBe(0);
  });

  test("A가 cleanup_pending을 답한 뒤 끊기고 빈 full로 다시 붙으면: 차단 행과 작업자 슬롯 막힘이 남고, 접수는 열린다", async () => {
    const t = linked(2);
    const running = await started(t.w);
    t.hello(1, EXECUTOR, [{ ...GHOST, state: "cleanup_pending" }]);
    await until(t.w, () => t.asked.length > 0);
    t.disconnect(1, EXECUTOR);
    t.hello(2, WORKER_B, []);
    t.hello(3, EXECUTOR, []);
    await until(t.w, () => t.judged(5) !== undefined);
    expect(t.holds()).toEqual([{ runId: GHOST.run_id, executorId: EXECUTOR, kind: "worker", runGeneration: 1, holdsSlot: true, why: "outside_ledger", observation: expect.any(Number) }]);
    expect(t.w.opened!.slotFree("worker")).toEqual({ known: true, value: false });
    expect(t.judged(5)!.fields).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });
    expect(t.fatal()).toBeNull();
    expect(await running.stop()).toBe(0);
  });
});

describe("현관 답을 기다리는 중의 멈춤(리뷰 P2)", () => {
  test("두 번째 현관 답을 기다리는 중 멈추면 그 답이 와도 2단계를 받아들이지 않고 장부에 쓰지 않는다", async () => {
    const t = linked(1);
    const reply = Promise.withResolvers<typeof FRONT_ROWS>();
    const closing = Promise.withResolvers<void>();
    t.w.front.peers = async () => {
      t.asked.push(t.w.time.monoNow());
      return t.asked.length === 1 ? FRONT_ROWS : reply.promise;
    };
    const running = await started(t.w);
    await until(t.w, () => t.asked.length === 2);
    t.hello(1, EXECUTOR, [GHOST]);
    // 끝 차례가 발급 닫기에서 머무는 동안 현관 답이 온다.
    const cycle = t.w.captured.cycle!.value;
    const closeIssuance = cycle.closeIssuance.bind(cycle);
    cycle.closeIssuance = async () => {
      await closeIssuance();
      await closing.promise;
    };
    const stopped = running.stop();
    await t.w.time.flush();
    // 멈춤이 진행 중인 현관 답을 깨워 그 2단계는 이미 끝났다: 다시 부르면 겹침(RestoreOrderError)이 아니라 멈춤 때문의 모름이다.
    await expect(t.w.captured.restorer!.value.step2()).rejects.toBeInstanceOf(RestoreStepError);
    reply.resolve(FRONT_ROWS);
    await t.w.time.flush();
    expect(t.w.captured.lines!.ports.observationsSettled()).toBe(false);
    expect(t.holds()).toEqual([]);
    expect(t.w.opened!.hasRunSighting(GHOST.run_id)).toEqual({ known: true, value: null });
    closing.resolve();
    expect(await stopped).toBe(0);
    expect(t.judged(2)).toBeUndefined();
    expect(t.stamped.filter((e) => e.event === "restore_retry")).toEqual([]);
    expect(t.fatal()).toBeNull();
  });
});
