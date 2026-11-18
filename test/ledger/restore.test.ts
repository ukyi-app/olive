import { expect, test } from "bun:test";
import type { RunStatus } from "../../src/contract/v1/index.ts";
import { type Ledger, type RestorePorts, RestoreOrderError, Restorer, RestoreStepError } from "../../src/ledger/index.ts";
import { clock, digest, id, must, NOW, open, startedWorker, tempPath } from "./helpers.ts";

// 시험용 가짜 포트. 기본은 "기록 없음, 모두 v1, 점유 없음, 게시는 대기".
function ports(overrides: Partial<{ [K in keyof RestorePorts]: Partial<RestorePorts[K]> }> = {}): RestorePorts {
  return {
    stopAuthority: { latestStop: async () => null, ...overrides.stopAuthority },
    peers: { contracts: async () => [{ peer: "front-door", contract: "olive-control/v1" }], ...overrides.peers },
    occupancy: { occupancy: async () => [], ...overrides.occupancy },
    publications: { lookup: async () => ({ kind: "pending" as const }), ...overrides.publications },
  };
}

async function all(restorer: Restorer) {
  return { s1: await restorer.step1(), s2: await restorer.step2(), s3: await restorer.step3(), s4: await restorer.step4(), s5: await restorer.step5() };
}

function stateOf(ledger: Ledger, runId: string) {
  const read = ledger.getRun(runId);
  return read.known ? read.value?.state : "모름";
}

test("복원: 1단계 전에는 정지 세대가 null이다", async () => {
  const ledger = open(tempPath());
  must(ledger.applyStop({ generation: 4, stopped: false, now: NOW }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const restorer = new Restorer(ledger, ports({ stopAuthority: { latestStop: async () => (await gate, null) } }), clock);
  expect(restorer.stopGeneration()).toBeNull();
  const pending = restorer.step1();
  expect(restorer.stopGeneration()).toBeNull();
  expect(restorer.intakeOpen()).toBe(false);
  release();
  expect(await pending).toEqual({ stopGeneration: 4, stopped: false, source: "ledger" });
  expect(restorer.stopGeneration()).toBe(4);
});

test("복원: 권위 기록이 더 새로우면 먼저 적용하고, 모르면 null을 유지한다", async () => {
  const ledger = open(tempPath());
  must(ledger.applyStop({ generation: 2, stopped: false, now: NOW }));
  const unknown = new Restorer(ledger, ports({ stopAuthority: { latestStop: async () => Promise.reject(new Error("timeout")) } }), clock);
  await expect(unknown.step1()).rejects.toBeInstanceOf(RestoreStepError);
  expect(unknown.stopGeneration()).toBeNull();
  await expect(unknown.step2()).rejects.toBeInstanceOf(RestoreOrderError);
  const newer = new Restorer(ledger, ports({ stopAuthority: { latestStop: async () => ({ generation: 7, stopped: true }) } }), clock);
  expect(await newer.step1()).toEqual({ stopGeneration: 7, stopped: true, source: "authority" });
  expect(ledger.readStop()).toMatchObject({ value: { generation: 7, stopped: true } });
});

test("복원: 장부와 권위 기록이 모두 없으면 0을 적는다", async () => {
  const ledger = open(tempPath());
  const restorer = new Restorer(ledger, ports(), clock);
  expect(await restorer.step1()).toEqual({ stopGeneration: 0, stopped: false, source: "initialized" });
  expect(ledger.readStop()).toMatchObject({ value: { generation: 0, stopped: false } });
});

test("복원: 앞 단계 없이 뒤 단계를 부르면 실패한다", async () => {
  const restorer = new Restorer(open(tempPath()), ports(), clock);
  await expect(restorer.step2()).rejects.toBeInstanceOf(RestoreOrderError);
  await expect(restorer.step5()).rejects.toBeInstanceOf(RestoreOrderError);
  await restorer.step1();
  await expect(restorer.step3()).rejects.toBeInstanceOf(RestoreOrderError);
  await expect(restorer.step1()).rejects.toBeInstanceOf(RestoreOrderError);
  // 같은 단계를 겹쳐 부르는 것도 실패한다.
  const second = new Restorer(open(tempPath()), ports(), clock);
  const first = second.step1();
  await expect(second.step1()).rejects.toBeInstanceOf(RestoreOrderError);
  await first;
});

test("복원: 장부에 없는 실행은 종료 대상이고 장부에 올리지 않는다", async () => {
  const ledger = open(tempPath());
  const known = startedWorker(ledger);
  const knownGeneration = ledger.runGeneration(known.runId) as number;
  const ghost = id();
  const runs: RunStatus[] = [
    { run_id: known.runId, state: "running", run_generation: knownGeneration, last_receipt_id: null },
    { run_id: ghost, state: "running", run_generation: 9, last_receipt_id: id() },
    { run_id: id(), state: "not_known", run_generation: null, last_receipt_id: null },
  ];
  const restorer = new Restorer(ledger, ports({ occupancy: { occupancy: async () => [{ executorId: "executor/diagnosis/0/store-a", runs }] } }), clock);
  await restorer.step1();
  const s2 = await restorer.step2();
  expect(s2.terminate).toEqual([{ executorId: "executor/diagnosis/0/store-a", runId: ghost, runGeneration: 9, why: "outside_ledger" }]);
  expect(ledger.getRun(ghost)).toEqual({ known: true, value: null });
  expect((ledger.listRuns() as { value: unknown[] }).value).toHaveLength(1);
});

test("복원: 시작 영수증만 있고 결과가 없으면 다시 실행하지 않고, 증명되지 않으면 unknown_running으로 슬롯을 막는다", async () => {
  const ledger = open(tempPath());
  const { runId, requestId } = startedWorker(ledger);
  must(ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId, instructionRequestId: requestId, bodyDigest: digest("st"), now: NOW }));
  const before = (ledger.listRuns() as { value: unknown[] }).value.length;
  const restorer = new Restorer(ledger, ports(), clock);
  const { s3, s5 } = await all(restorer);
  expect(s3.markedUnknown).toEqual([runId]);
  expect(s3.statusQueries).toEqual([{ executorId: "executor/diagnosis/0/store-a", runIds: [runId] }]);
  expect(stateOf(ledger, runId)).toBe("unknown_running");
  expect((ledger.listRuns() as { value: unknown[] }).value.length).toBe(before);
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  // 접수는 열려도 작업자 자리는 막혀 있다.
  expect(s5.intakeMayOpen).toBe(true);
});

test("복원: 게시 조회의 시간 초과는 모름으로 남는다", async () => {
  const ledger = open(tempPath());
  must(ledger.recordPublication({ frontJobId: "job-1", candidateDigest: digest("c1"), runId: null, now: NOW }));
  must(ledger.recordPublication({ frontJobId: "job-2", candidateDigest: digest("c2"), runId: null, now: NOW }));
  const restorer = new Restorer(
    ledger,
    ports({
      publications: {
        lookup: async (job) => {
          if (job === "job-1") throw new Error("timeout");
          return { kind: "confirmed", outcome: "posted" };
        },
      },
    }),
    clock,
  );
  const { s4 } = await all(restorer);
  expect(s4).toEqual({ confirmed: ["job-2"], pending: [], unknown: ["job-1"] });
  expect(ledger.publications()).toMatchObject({
    value: [
      { frontJobId: "job-1", state: "unknown", outcome: null },
      { frontJobId: "job-2", state: "confirmed", outcome: "posted" },
    ],
  });
  // 확정은 모름으로 되돌아가지 않는다.
  expect(ledger.settlePublication("job-2", { kind: "unknown" }, NOW)).toEqual({ ok: false, reason: "publication_confirmed" });
});

test("복원: 정지 중이면 접수를 열지 않는다", async () => {
  const ledger = open(tempPath());
  must(ledger.applyStop({ generation: 3, stopped: true, now: NOW }));
  const restorer = new Restorer(ledger, ports(), clock);
  const { s1, s5 } = await all(restorer);
  expect(s1.stopped).toBe(true);
  expect(s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["stopped"] });
  expect(restorer.intakeOpen()).toBe(false);
  expect(restorer.stopGeneration()).toBe(3);
});

test("복원: 이웃의 계약 판이 다르면 접수를 열지 않는다", async () => {
  const restorer = new Restorer(open(tempPath()), ports({ peers: { contracts: async () => [{ peer: "front-door", contract: "olive-control/v2" }] } }), clock);
  const { s5 } = await all(restorer);
  expect(s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["contract_mismatch"] });
});

test("복원: 모두 맞으면 접수를 열어도 된다고 내고 예산·일시 중지를 돌려준다", async () => {
  const ledger = open(tempPath());
  must(ledger.setPause(NOW + 3_600_000));
  const restorer = new Restorer(ledger, ports(), clock);
  const { s5 } = await all(restorer);
  expect(s5).toEqual({ intakeMayOpen: true, closedBecause: [], diagnosisPausedUntil: NOW + 3_600_000, queued: [], budgets: [] });
  expect(restorer.intakeOpen()).toBe(true);
});
