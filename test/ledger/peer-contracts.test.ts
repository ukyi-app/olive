// 복원 2단계의 이웃 대조: 이웃마다 그 이웃의 계약 판을 기대하고(현관 v2, 실행기 v1), 필수 이웃의 누락·중복과
// 정책 불일치는 접수를 닫는다. 판 문자열은 계약 상수를 쓰지 않고 그대로 적는다: 복원기가 상수를 바꿔 끼워도 시험은 따라가지 않는다.
import { expect, test } from "bun:test";
import { type Ledger, type OccupancyAnswer, type PeerContractAnswer, type RestorePorts, Restorer } from "../../src/ledger/index.ts";
import { clock, open, tempPath, WORKER_EXECUTOR, worker } from "./helpers.ts";

const V1 = "olive-control/v1";
const V2 = "olive-control/v2";
const FRONT = "front-door";
// 관측 중계의 이름. 계약의 주체 이름이 아니어서 복원기는 지금처럼 v1을 기대한다.
const RELAY = "observer";
const REQUIRED = [FRONT, RELAY, WORKER_EXECUTOR];

const front = (over: Partial<PeerContractAnswer> = {}): PeerContractAnswer => ({ peer: FRONT, contract: V2, policy: "match", ...over });
const relay = (over: Partial<PeerContractAnswer> = {}): PeerContractAnswer => ({ peer: RELAY, contract: V1, ...over });
const executor = (over: Partial<PeerContractAnswer> = {}): PeerContractAnswer => ({ peer: WORKER_EXECUTOR, contract: V1, ...over });
const FULL: OccupancyAnswer = { executorId: WORKER_EXECUTOR, coverage: "full", runs: [] };

function ports(contracts: PeerContractAnswer[], occupancy: OccupancyAnswer[] = [FULL]): RestorePorts {
  return {
    stopAuthority: { latestStop: async () => null },
    peers: { contracts: async () => contracts },
    occupancy: { occupancy: async () => occupancy },
    publications: { lookup: async () => ({ kind: "pending" as const }) },
  };
}

async function restore(contracts: PeerContractAnswer[], occupancy?: OccupancyAnswer[], requiredPeers: string[] = REQUIRED) {
  const ledger = open(tempPath());
  const r = new Restorer(ledger, ports(contracts, occupancy), clock, { requiredPeers });
  const out = { s1: await r.step1(), s2: await r.step2(), s3: await r.step3(), s4: await r.step4(), s5: await r.step5() };
  return { ...out, r, ledger };
}

// 접수가 실제로 닫혔는지는 단계 결과만이 아니라 지금의 장부와 복원기에서도 본다.
function expectClosed(r: Restorer, ledger: Ledger) {
  expect(r.intakeOpen()).toBe(false);
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "intake_closed" });
}

test("현관 새 판과 실행기 v1 동시 대조", async () => {
  const { s2, s5, r, ledger } = await restore([front(), relay(), executor()]);
  expect(s2).toMatchObject({ contractMismatches: [], policyMismatches: [], missingPeers: [], duplicatePeers: [] });
  expect(s5).toMatchObject({ intakeMayOpen: true, closedBecause: [] });
  expect(r.intakeOpen()).toBe(true);
  expect(ledger.admitRun(worker())).toMatchObject({ ok: true });

  // 같은 판(v2)을 관측 중계가 답하면 맞지 않는다: 현관의 판은 이름이 현관인 이웃에게만 기대한다.
  const swapped = await restore([front(), relay({ contract: V2 }), executor()]);
  expect(swapped.s2.contractMismatches).toEqual([{ peer: RELAY, contract: V2 }]);
  expect(swapped.s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["contract_mismatch"] });
  expectClosed(swapped.r, swapped.ledger);
});

test("현관이 v1이라고 답하면 닫힘(다른 판으로 위장)", async () => {
  const { s2, s5, r, ledger } = await restore([front({ contract: V1 }), relay(), executor()]);
  expect(s2.contractMismatches).toEqual([{ peer: FRONT, contract: V1 }]);
  expect(s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["contract_mismatch"] });
  expectClosed(r, ledger);
});

test("실행기가 v2라고 답하면 닫힘", async () => {
  const { s2, s5, r, ledger } = await restore([front(), relay(), executor({ contract: V2 })]);
  expect(s2.contractMismatches).toEqual([{ peer: WORKER_EXECUTOR, contract: V2 }]);
  expect(s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["contract_mismatch"] });
  expectClosed(r, ledger);
});

test("필수 현관 누락·중복 닫힘", async () => {
  const missing = await restore([relay(), executor()]);
  expect(missing.s2).toMatchObject({ missingPeers: [FRONT], duplicatePeers: [], contractMismatches: [], policyMismatches: [] });
  expect(missing.s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["peer_unconfirmed"] });
  expectClosed(missing.r, missing.ledger);

  // 두 행이 모두 맞는 판·맞는 정책이어도 둘이면 어느 연결의 답인지 가를 수 없다.
  const twice = await restore([front(), front(), relay(), executor()]);
  expect(twice.s2).toMatchObject({ missingPeers: [], duplicatePeers: [FRONT], contractMismatches: [], policyMismatches: [] });
  expect(twice.s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["peer_unconfirmed"] });
  expectClosed(twice.r, twice.ledger);

  // 기대 집합 밖의 이웃 행은 누락·중복으로 세지 않고 판만 대조한다(지금 규칙 그대로). 판이 맞으면 접수를 막지 않는다.
  const extra = await restore([front(), relay(), executor(), { peer: "observer-2", contract: V1 }]);
  expect(extra.s5).toMatchObject({ intakeMayOpen: true, closedBecause: [] });
});

test("정책 불일치 닫힘", async () => {
  // 현관 행은 정책이 맞다고 밝혀야 한다. 어긋남, 모름, 칸 없음, 아는 값이 아님은 모두 닫는다.
  const cases: [PeerContractAnswer, "mismatch" | "unknown"][] = [
    [front({ policy: "mismatch" }), "mismatch"],
    [front({ policy: "unknown" }), "unknown"],
    [{ peer: FRONT, contract: V2 }, "unknown"],
    [front({ policy: "agreed" as PeerContractAnswer["policy"] }), "unknown"],
  ];
  for (const [answer, policy] of cases) {
    const { s2, s5, r, ledger } = await restore([answer, relay(), executor()]);
    expect(s2.policyMismatches, JSON.stringify(answer)).toEqual([{ peer: FRONT, policy }]);
    expect(s2.contractMismatches).toEqual([]);
    expect(s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["policy_mismatch"] });
    expectClosed(r, ledger);
  }

  // 실행기 v1 행은 칸이 없어도 된다(정책 revision은 hello에서 따로 본다). 칸을 실어 어긋남·모름을 밝히면 닫는다.
  for (const policy of ["mismatch", "unknown"] as const) {
    const { s2, s5 } = await restore([front(), relay(), executor({ policy })]);
    expect(s2.policyMismatches).toEqual([{ peer: WORKER_EXECUTOR, policy }]);
    expect(s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["policy_mismatch"] });
  }
});

test("partial은 full을 대신하지 못함", async () => {
  const contracts = [front(), relay(), executor()];
  const partial: OccupancyAnswer = { executorId: WORKER_EXECUTOR, coverage: "partial", runs: [] };
  for (const occupancy of [[partial], [partial, partial], [{ ...FULL, executorId: "executor/diagnosis/1/store-b" }, partial]]) {
    const { s2, s5, r, ledger } = await restore(contracts, occupancy);
    expect(s2.occupancyUnconfirmed, JSON.stringify(occupancy)).toEqual([WORKER_EXECUTOR]);
    // 판과 정책은 모두 맞으므로 닫는 사유는 점유뿐이다.
    expect(s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["occupancy_unconfirmed"] });
    expectClosed(r, ledger);
  }
  const both = await restore(contracts, [partial, FULL]);
  expect(both.s5).toMatchObject({ intakeMayOpen: true, closedBecause: [] });
});
