// 복원 2단계의 이웃 포트(peers.ts)가 필수 이웃을 기다리는 규칙(D-141): 모였는지의 셈이 복원기의 판정과 같은가, 기다림의 끝, 실패 갈래.
// 조립과 함께 도는 갈래(가~라)는 boot-peer-wait.test.ts가 본다.
import { describe, expect, test } from "bun:test";
import { parsePrincipal } from "../../../src/contract/v1/index.ts";
import { type OccupancyAnswer, type PeerContractAnswer, Restorer } from "../../../src/ledger/index.ts";
import { createPeers, PEER_POLL_MS, PEER_WAIT_MARGIN_MS, PEER_WAIT_MAX_MS, type PeerWait, type PeersSource, peersGathered, peerWaitUntil } from "../../../src/supervisor/runtime/peers.ts";
import { clock, open, tempPath } from "../../ledger/helpers.ts";

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

// 손으로 돌리는 시각. sleep은 시각을 옮기고 곧바로 이행한다.
function harness(over: Partial<PeerWait> = {}, present: (at: number) => boolean = () => false) {
  let now = 0;
  const slept: number[] = [];
  const reads: number[] = [];
  const wait: PeerWait = {
    required: REQUIRED,
    until: () => 1_000,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    stopping: () => false,
    ...over,
  };
  const principal = parsePrincipal(EXEC);
  const table = () => ({
    candidates: () => (present(now) ? [{ connection: 1, target: "reader", principal: principal!, keyId: "key-1", hello: { profile_revision: "", policy_revision: "policy-1" } }] : []),
    occupancy: () => (present(now) ? [full()] : []),
  });
  const source: PeersSource = {
    front: {
      contracts: async () => {
        reads.push(now);
        return FRONT.map((row) => ({ ...row }));
      },
    },
    table,
    restorer: { stopGeneration: () => 0 },
    expectedPolicy: "policy-1",
    wait,
  };
  return { source, slept, reads, at: () => now };
}

describe("createPeers의 기다림", () => {
  test("기다림이 없으면 한 번 읽고 그 순간의 행을 낸다", async () => {
    const h = harness();
    const rows = await createPeers({ ...h.source, wait: undefined }).contracts();
    expect(rows).toEqual(FRONT);
    expect(h.reads).toEqual([0]);
  });

  test("모일 때까지 250ms마다 다시 읽고, 모인 읽기를 그대로 낸다", async () => {
    const h = harness({}, (at) => at >= 500);
    const rows = await createPeers(h.source).contracts();
    expect(rows).toEqual([...FRONT, EXEC_ROW]);
    expect(h.reads).toEqual([0, 250, 500]);
    expect(h.slept).toEqual([250, 250]);
  });

  test("이미 모였으면 잠들지 않는다", async () => {
    const h = harness({}, () => true);
    expect(await createPeers(h.source).contracts()).toEqual([...FRONT, EXEC_ROW]);
    expect(h.slept).toEqual([]);
    expect(h.reads).toEqual([0]);
  });

  test("끝까지 모이지 않으면 끝 시각의 마지막 읽기를 낸다(마지막 잠은 남은 시간만)", async () => {
    const h = harness({ until: () => 600 });
    expect(await createPeers(h.source).contracts()).toEqual(FRONT);
    expect(h.slept).toEqual([250, 250, 100]);
    expect(h.reads).toEqual([0, 250, 500, 600]);
  });

  test("끝 시각이 null이거나 이미 지났으면 기다리지 않는다", async () => {
    for (const until of [() => null, () => 0, () => -5]) {
      const h = harness({ until });
      expect(await createPeers(h.source).contracts()).toEqual(FRONT);
      expect(h.slept).toEqual([]);
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
    const noTimer = harness({ sleep: () => Promise.reject(new Error("timer")) });
    expect(await createPeers(noTimer.source).contracts()).toEqual(FRONT);
    expect(noTimer.reads).toEqual([0]);
  });

  test("멈춤이면 잠에서 깬 뒤 다시 읽지 않고 던진다(복원기는 모름으로 실패한다)", async () => {
    let stopped = false;
    const h = harness({ stopping: () => stopped });
    const asked = createPeers({
      ...h.source,
      wait: {
        ...h.source.wait!,
        sleep: async (ms) => {
          stopped = true;
          await h.source.wait!.sleep(ms);
        },
      },
    }).contracts();
    await expect(asked).rejects.toThrow("peer_wait_stopped");
    expect(h.reads).toEqual([0]);
  });

  test("현관이 던지면 기다리지 않고 그대로 던진다", async () => {
    const h = harness();
    const port = createPeers({ ...h.source, front: { contracts: () => Promise.reject(new Error("front_door_absent")) } });
    await expect(port.contracts()).rejects.toThrow("front_door_absent");
    expect(h.slept).toEqual([]);
  });
});
