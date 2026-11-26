// 복원 2단계의 이웃 포트(peers.ts)가 필수 이웃을 기다리는 규칙(D-141): 모였는지의 셈이 복원기의 판정과 같은가, 기다림의 끝(기다림 전체에 하나),
// 멈춤이 진행 중인 기다림을 깨우는가, 본 실행을 점유 읽기에 보관하는가, 실패 갈래.
// 조립과 함께 도는 갈래(가~라)는 boot-peer-wait.test.ts가 본다.
import { describe, expect, test } from "bun:test";
import { parsePrincipal, type RunStatus } from "../../../src/contract/v1/index.ts";
import { type OccupancyAnswer, type PeerContractAnswer, Restorer } from "../../../src/ledger/index.ts";
import { createPeers, PEER_POLL_MS, PEER_WAIT_MARGIN_MS, PEER_WAIT_MAX_MS, type PeerWait, type PeersSource, peersGathered, peerWaitUntil } from "../../../src/supervisor/runtime/peers.ts";
import { clock, open, tempPath } from "../../ledger/helpers.ts";
import { manualTime } from "./boot-world.ts";

const EXEC = "executor/diagnosis/0/store-a";
const REQUIRED = ["front-door", "observation-relay", EXEC];
const FRONT: PeerContractAnswer[] = [
  { peer: "front-door", contract: "olive-control/v2", policy: "match" },
  { peer: "observation-relay", contract: "olive-control/v1", policy: "match" },
];
const EXEC_ROW: PeerContractAnswer = { peer: EXEC, contract: "olive-control/v1", policy: "match" };
const full = (executorId = EXEC): OccupancyAnswer => ({ executorId, coverage: "full", runs: [] });

test("상수와 기다림의 끝: min(단계 시작 + 25,000, 기한 − 5,000)", () => {
  expect([PEER_WAIT_MARGIN_MS, PEER_WAIT_MAX_MS, PEER_POLL_MS]).toEqual([5_000, 25_000, 250]);
  // 단계를 단조 1,000에 시작했다.
  expect(peerWaitUntil(31_000, 30_000)).toBe(26_000);
  expect(peerWaitUntil(11_000, 10_000)).toBe(6_000);
  expect(peerWaitUntil(121_000, 120_000)).toBe(26_000);
  // 기한이 여유보다 짧으면 시작보다 앞이라 기다리지 않는다.
  expect(peerWaitUntil(5_000, 4_000)).toBeLessThan(1_000);
});

describe("모였는가의 셈은 복원기 2단계의 이웃 판정(빠짐·겹침·전체 점유)과 같다", () => {
  const cases: { name: string; rows: PeerContractAnswer[]; occupancy: OccupancyAnswer[]; gathered: boolean }[] = [
    { name: "모두 한 번씩", rows: [...FRONT, EXEC_ROW], occupancy: [full()], gathered: true },
    { name: "목록 밖 이웃 행이 더 있음", rows: [...FRONT, EXEC_ROW, { peer: "other", contract: "olive-control/v1" }], occupancy: [full(), full("executor/diagnosis/1/store-a")], gathered: true },
    { name: "관측 중계 빠짐", rows: [FRONT[0]!, EXEC_ROW], occupancy: [full()], gathered: false },
    { name: "실행기 행 빠짐(점유만 있음)", rows: [...FRONT], occupancy: [full()], gathered: false },
    { name: "실행기 점유 빠짐(행만 있음)", rows: [...FRONT, EXEC_ROW], occupancy: [], gathered: false },
    { name: "실행기 행 겹침", rows: [...FRONT, EXEC_ROW, EXEC_ROW], occupancy: [full()], gathered: false },
    { name: "실행기 점유가 부분 조회뿐", rows: [...FRONT, EXEC_ROW], occupancy: [{ executorId: EXEC, coverage: "partial", runs: [] }], gathered: false },
    { name: "실행기 전체 점유 겹침", rows: [...FRONT, EXEC_ROW], occupancy: [full(), full()], gathered: false },
    { name: "현관 행 겹침", rows: [...FRONT, FRONT[0]!, EXEC_ROW], occupancy: [full()], gathered: false },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      expect(peersGathered(REQUIRED, c.rows, c.occupancy)).toBe(c.gathered);
      const restorer = new Restorer(
        open(tempPath()),
        {
          stopAuthority: { latestStop: async () => null },
          peers: { contracts: async () => c.rows },
          occupancy: { occupancy: async () => c.occupancy },
          publications: { lookup: async () => ({ kind: "pending" as const }) },
        },
        clock,
        { requiredPeers: REQUIRED },
      );
      await restorer.step1();
      const s2 = await restorer.step2();
      expect(s2.missingPeers.length + s2.duplicatePeers.length + s2.occupancyUnconfirmed.length === 0).toBe(c.gathered);
    });
  }
});

// 손으로 돌리는 시각(boot-world의 manualTime, 0에서 시작). runsAt(at)이 null이 아니면 그 시각의 연결 표에 실행기(EXEC)가 그 runs로 있다.
function harness(over: Partial<PeerWait> = {}, runsAt: (at: number) => RunStatus[] | null = () => null) {
  const time = manualTime(0);
  const timers: number[] = [];
  const reads: number[] = [];
  const wakers = new Set<() => void>();
  let stopping = false;
  const wait: PeerWait = {
    required: REQUIRED,
    until: () => 1_000,
    now: time.monoNow,
    setTimer: (ms, fire) => {
      timers.push(ms);
      return time.setTimer(ms, fire);
    },
    stopping: () => stopping,
    onStop: (wake) => {
      wakers.add(wake);
      return () => void wakers.delete(wake);
    },
    ...over,
  };
  const principal = parsePrincipal(EXEC);
  const table = () => {
    const runs = runsAt(time.monoNow());
    return {
      candidates: () => (runs !== null ? [{ connection: 1, target: "reader", principal: principal!, keyId: "key-1", hello: { profile_revision: "", policy_revision: "policy-1" } }] : []),
      occupancy: (): OccupancyAnswer[] => (runs !== null ? [{ executorId: EXEC, coverage: "full", runs: runs.map((run) => ({ ...run })) }] : []),
    };
  };
  // 현관 답. 기본은 곧바로 FRONT다. 시험이 바꾼다.
  const front = { reply: (): Promise<PeerContractAnswer[]> => Promise.resolve(FRONT.map((row) => ({ ...row }))) };
  const source: PeersSource = {
    front: {
      contracts: () => {
        reads.push(time.monoNow());
        return front.reply();
      },
    },
    table,
    restorer: { stopGeneration: () => 0 },
    expectedPolicy: "policy-1",
    wait,
  };
  // 이행·거부를 기록해 둔다. 첫 현관 답까지의 약속 처리를 흘려보낸 뒤 돌려준다(advance는 걸린 타이머만 본다).
  const run = async <T>(work: Promise<T>) => {
    const out: { value?: T; error?: unknown; at?: number } = {};
    work.then(
      (value) => {
        out.value = value;
        out.at = time.monoNow();
      },
      (error: unknown) => {
        out.error = error;
        out.at = time.monoNow();
      },
    );
    await time.flush();
    return out;
  };
  return {
    source,
    time,
    timers,
    reads,
    front,
    run,
    wakers,
    // 끝 차례: 깃발을 세우고 건 것을 깨운다(boot.ts finish와 같은 차례).
    stop(wake = true) {
      stopping = true;
      if (wake) for (const fire of [...wakers]) fire();
    },
  };
}

const GHOST: RunStatus = { run_id: "cba41caf-f9a6-4d38-b1e7-5953b22896a0", state: "running", run_generation: 1, last_receipt_id: null };

describe("createPeers의 기다림", () => {
  test("기다림이 없으면 한 번 읽고 그 순간의 행을 낸다", async () => {
    const h = harness();
    const rows = await createPeers({ ...h.source, wait: undefined }).contracts();
    expect(rows).toEqual(FRONT);
    expect(h.reads).toEqual([0]);
  });

  test("모일 때까지 250ms마다 다시 읽고, 모인 읽기를 그대로 낸다(끝 타이머는 거둔다)", async () => {
    const h = harness({}, (at) => (at >= 500 ? [] : null));
    const asked = await h.run(createPeers(h.source).contracts());
    await h.time.advance(2_000);
    expect(asked.value).toEqual([...FRONT, EXEC_ROW]);
    expect(asked.at).toBe(500);
    expect(h.reads).toEqual([0, 250, 500]);
    expect(h.timers).toEqual([1_000, 250, 250]);
    expect(h.time.pending()).toBe(0);
  });

  test("이미 모였으면 잠들지 않는다(타이머 0)", async () => {
    const h = harness({}, () => []);
    expect(await createPeers(h.source).contracts()).toEqual([...FRONT, EXEC_ROW]);
    expect(h.timers).toEqual([]);
    expect(h.reads).toEqual([0]);
  });

  test("끝까지 모이지 않으면 끝 시각에 마지막으로 끝난 읽기를 내고, 끝 시각에는 새로 묻지 않는다", async () => {
    const h = harness({ until: () => 600 });
    const asked = await h.run(createPeers(h.source).contracts());
    await h.time.advance(2_000);
    expect(asked.value).toEqual(FRONT);
    expect(asked.at).toBe(600);
    expect(h.reads).toEqual([0, 250, 500]);
    expect(h.time.pending()).toBe(0);
  });

  test("끝 시각이 null이거나 이미 지났으면 기다리지 않는다", async () => {
    for (const until of [() => null, () => 0, () => -5]) {
      const h = harness({ until });
      expect(await createPeers(h.source).contracts()).toEqual(FRONT);
      expect(h.timers).toEqual([]);
    }
  });

  test("시각을 읽지 못하거나 타이머를 걸지 못하면 더 기다리지 않고 지금 읽은 행을 낸다", async () => {
    const noClock = harness({
      now: () => {
        throw new Error("clock");
      },
    });
    expect(await createPeers(noClock.source).contracts()).toEqual(FRONT);
    expect(noClock.reads).toEqual([0]);
    const nanClock = harness({ now: () => Number.NaN });
    expect(await createPeers(nanClock.source).contracts()).toEqual(FRONT);
    expect(nanClock.reads).toEqual([0]);
    const noTimer = harness({
      setTimer: () => {
        throw new Error("timer");
      },
    });
    expect(await createPeers(noTimer.source).contracts()).toEqual(FRONT);
    expect(noTimer.reads).toEqual([0]);
    // 끝 타이머는 걸었고 다시 읽기 타이머만 걸지 못함: 그 자리에서 마지막 읽기를 낸다.
    const noPoll = harness();
    const poll = noPoll.source.wait!.setTimer;
    const asked = await noPoll.run(
      createPeers({
        ...noPoll.source,
        wait: {
          ...noPoll.source.wait!,
          setTimer: (ms, fire) => {
            if (ms === 250) throw new Error("timer");
            return poll(ms, fire);
          },
        },
      }).contracts(),
    );
    await noPoll.time.advance(10);
    expect(asked.value).toEqual(FRONT);
    expect(asked.at).toBe(0);
    expect(noPoll.reads).toEqual([0]);
    expect(noPoll.time.pending()).toBe(0);
  });

  test("현관이 던지면 기다리지 않고 그대로 던진다", async () => {
    const h = harness();
    const port = createPeers({ ...h.source, front: { contracts: () => Promise.reject(new Error("front_door_absent")) } });
    await expect(port.contracts()).rejects.toThrow("front_door_absent");
    expect(h.timers).toEqual([]);
  });
});

describe("기다림 전체의 끝 시각 하나(리뷰 P1)", () => {
  test("끝 시각에 진행 중인 현관 답은 기다리지 않고 버린다: 마지막으로 끝난 답과 그때의 연결 표를 낸다", async () => {
    const h = harness({}, () => []);
    // 첫 답에는 관측 중계가 없다. 두 번째 답은 2,000ms 뒤에 모두 싣고 온다(끝 시각 1,000 뒤).
    h.front.reply = () =>
      h.reads.length === 1 ? Promise.resolve([{ ...FRONT[0]! }]) : new Promise((resolve) => h.time.setTimer(2_000, () => resolve(FRONT.map((row) => ({ ...row })))));
    const asked = await h.run(createPeers(h.source).contracts());
    await h.time.advance(1_000);
    expect(asked.at).toBe(1_000);
    expect(asked.value).toEqual([FRONT[0], EXEC_ROW]);
    expect(h.reads).toEqual([0, 250]);
    await h.time.advance(3_000);
    expect(asked.value).toEqual([FRONT[0], EXEC_ROW]);
  });

  test("다시 읽기 타이머가 끝 시각보다 늦게 걸려도 끝 시각에 낸다", async () => {
    const h = harness();
    const timer = h.source.wait!.setTimer;
    const asked = await h.run(
      createPeers({ ...h.source, wait: { ...h.source.wait!, setTimer: (ms, fire) => timer(ms === 250 && h.reads.length === 2 ? ms + 5_001 : ms, fire) } }).contracts(),
    );
    await h.time.advance(10_000);
    expect(asked.at).toBe(1_000);
    expect(asked.value).toEqual(FRONT);
    expect(h.reads).toEqual([0, 250]);
    expect(h.time.pending()).toBe(0);
  });

  test("끝 시각 정각 이후에 처리된 답은 끝 타이머보다 먼저 와도 버린다", async () => {
    const h = harness({}, () => []);
    const late = Promise.withResolvers<PeerContractAnswer[]>();
    h.front.reply = () => (h.reads.length === 1 ? Promise.resolve([{ ...FRONT[0]! }]) : late.promise);
    const asked = await h.run(createPeers(h.source).contracts());
    await h.time.advance(250);
    expect(h.reads).toEqual([0, 250]);
    // 시각만 끝 시각으로 옮기고(타이머는 아직) 답을 먼저 처리한다.
    h.time.set(1_000);
    late.resolve(FRONT.map((row) => ({ ...row })));
    await h.time.flush();
    expect(asked.value).toEqual([FRONT[0], EXEC_ROW]);
  });

  test("첫 현관 답은 끝 시각 뒤에 와도 기다려 그 답으로 낸다(넘길 앞선 답이 없다), 더 묻지 않는다", async () => {
    const h = harness();
    h.front.reply = () => new Promise((resolve) => h.time.setTimer(1_500, () => resolve(FRONT.map((row) => ({ ...row })))));
    const asked = await h.run(createPeers(h.source).contracts());
    await h.time.advance(5_000);
    expect(asked.at).toBe(1_500);
    expect(asked.value).toEqual(FRONT);
    expect(h.reads).toEqual([0]);
  });
});

describe("멈춤은 진행 중인 기다림을 깨운다(리뷰 P2)", () => {
  test("다시 읽기 잠 중의 멈춤: 타이머를 기다리지 않고 던진다", async () => {
    const h = harness();
    const asked = await h.run(createPeers(h.source).contracts());
    await h.time.advance(100);
    h.stop();
    await h.time.flush();
    expect(String(asked.error)).toContain("peer_wait_stopped");
    expect(asked.at).toBe(100);
    expect(h.reads).toEqual([0]);
    expect(h.time.pending()).toBe(0);
    expect(h.wakers.size).toBe(0);
  });

  for (const which of ["첫", "두 번째"] as const) {
    test(`${which} 현관 답을 기다리는 중의 멈춤: 답을 기다리지 않고 던지며, 뒤에 온 답은 버린다`, async () => {
      const h = harness({}, () => [GHOST]);
      const pending = Promise.withResolvers<PeerContractAnswer[]>();
      h.front.reply = () => (which === "두 번째" && h.reads.length === 1 ? Promise.resolve([{ ...FRONT[0]! }]) : pending.promise);
      const asked = await h.run(createPeers(h.source).contracts());
      await h.time.advance(which === "첫" ? 10 : 260);
      expect(h.reads.length).toBe(which === "첫" ? 1 : 2);
      h.stop();
      await h.time.flush();
      expect(String(asked.error)).toContain("peer_wait_stopped");
      pending.resolve(FRONT.map((row) => ({ ...row })));
      await h.time.flush();
      expect(asked.value).toBeUndefined();
    });
  }

  test("깨우기를 걸지 못해도 답을 받은 직후 멈춤을 보고 던진다", async () => {
    const h = harness({
      onStop: () => {
        throw new Error("no waker");
      },
    });
    const pending = Promise.withResolvers<PeerContractAnswer[]>();
    h.front.reply = () => (h.reads.length === 1 ? Promise.resolve([{ ...FRONT[0]! }]) : pending.promise);
    const asked = await h.run(createPeers(h.source).contracts());
    await h.time.advance(260);
    h.stop(false);
    pending.resolve(FRONT.map((row) => ({ ...row })));
    await h.time.flush();
    expect(String(asked.error)).toContain("peer_wait_stopped");
  });

  test("다시 읽기 타이머를 걸지 못해 지금 행을 내는 길에서도 멈춤이면 던진다", async () => {
    const h = harness();
    const timer = h.source.wait!.setTimer;
    const port = createPeers({
      ...h.source,
      wait: {
        ...h.source.wait!,
        setTimer: (ms, fire) => {
          if (ms !== 250) return timer(ms, fire);
          h.stop(false);
          throw new Error("timer");
        },
      },
    });
    await expect(port.contracts()).rejects.toThrow("peer_wait_stopped");
  });

  test("점유 읽기도 멈춤이면 던진다(판정에 넘기기 전 마지막 확인)", async () => {
    const h = harness({}, () => [GHOST]);
    const port = createPeers(h.source);
    expect(await port.occupancy()).toEqual([full()].map((answer) => ({ ...answer, runs: [GHOST] })));
    h.stop(false);
    await expect(port.occupancy()).rejects.toThrow("peer_wait_stopped");
  });
});

describe("이번 2단계에서 본 실행을 점유 읽기에 보관한다(리뷰 P1)", () => {
  // at까지는 첫 runs로, 그 뒤에는 둘째 값(null이면 끊김)으로 연결 표에 있다.
  const phases = (first: RunStatus[] | null, then: RunStatus[] | null, at = 100) => (now: number) => (now < at ? first : then);

  test("끊긴 실행기가 답했던 실행은 partial 행으로 남고, 옛 full은 전체 점유로 세지 않는다(기다림도 끝 시각까지)", async () => {
    const h = harness({}, phases([GHOST], null));
    // 첫 답에는 관측 중계가 없어 첫 읽기에 모이지 않는다. 그 뒤 실행기가 끊긴다.
    h.front.reply = () => Promise.resolve(h.reads.length === 1 ? [{ ...FRONT[0]! }] : FRONT.map((row) => ({ ...row })));
    const port = createPeers(h.source);
    const asked = await h.run(port.contracts());
    await h.time.advance(2_000);
    expect(asked.at).toBe(1_000);
    expect(asked.value).toEqual(FRONT);
    const occupancy = await port.occupancy();
    expect(occupancy).toEqual([{ executorId: EXEC, coverage: "partial", runs: [GHOST] }]);
    expect(peersGathered(REQUIRED, [...FRONT, EXEC_ROW], occupancy)).toBe(false);
  });

  test("빈 full로 다시 붙어도 앞서 본 실행이 partial 행으로 남는다(지금의 full은 하나)", async () => {
    const cleanup: RunStatus = { ...GHOST, state: "cleanup_pending" };
    const h = harness({}, phases([cleanup], []));
    const port = createPeers(h.source);
    const asked = await h.run(port.contracts());
    await h.time.advance(2_000);
    expect(asked.at).toBe(0);
    // 첫 읽기에 모여 곧바로 냈다. 점유 읽기는 다시 붙은 뒤의 표로 한다.
    h.time.set(500);
    expect(await port.occupancy()).toEqual([
      { executorId: EXEC, coverage: "full", runs: [] },
      { executorId: EXEC, coverage: "partial", runs: [cleanup] },
    ]);
  });

  test("열쇠(실행기·실행 ID·세대)마다 하나: 지금 표에 같은 열쇠가 있으면 지금 것만, 없으면 마지막으로 본 상태 하나", async () => {
    const cleanup: RunStatus = { ...GHOST, state: "cleanup_pending" };
    const otherGeneration: RunStatus = { ...GHOST, run_generation: 2 };
    let runs: RunStatus[] | null = [GHOST];
    const h = harness({}, () => runs);
    const port = createPeers(h.source);
    expect(await port.occupancy()).toEqual([{ executorId: EXEC, coverage: "full", runs: [GHOST] }]);
    runs = [cleanup, otherGeneration];
    expect(await port.occupancy()).toEqual([{ executorId: EXEC, coverage: "full", runs: [cleanup, otherGeneration] }]);
    runs = null;
    expect(await port.occupancy()).toEqual([{ executorId: EXEC, coverage: "partial", runs: [cleanup, otherGeneration] }]);
  });

  test("실제 복원기에 넘기면 끊긴 실행기의 장부 밖 running이 점유 차단 행 하나로 남고 전체 점유는 미확인이다", async () => {
    const h = harness({}, phases([GHOST], null));
    h.front.reply = () => Promise.resolve(h.reads.length === 1 ? [{ ...FRONT[0]! }] : FRONT.map((row) => ({ ...row })));
    const port = createPeers(h.source);
    const ledger = open(tempPath());
    const restorer = new Restorer(
      ledger,
      { stopAuthority: { latestStop: async () => null }, peers: port, occupancy: port, publications: { lookup: async () => ({ kind: "pending" as const }) } },
      clock,
      { requiredPeers: REQUIRED },
    );
    await restorer.step1();
    const step2 = await h.run(restorer.step2());
    await h.time.advance(2_000);
    expect(step2.error).toBeUndefined();
    const s2 = step2.value!;
    expect(s2.occupancyUnconfirmed).toEqual([EXEC]);
    expect(s2.missingPeers).toEqual([EXEC]);
    expect(s2.holds.map((hold) => [hold.runId, hold.executorId, hold.holdsSlot, hold.why])).toEqual([[GHOST.run_id, EXEC, true, "outside_ledger"]]);
  });
});
