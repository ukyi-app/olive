// 복원 2단계가 필수 이웃을 그 단계 기한 안에서 기다리는가(D-141). 조립(boot.ts)과 이웃 포트(peers.ts)를 함께 본다.
// 세계는 boot-world.ts(실제 임시 장부, 손으로 돌리는 시계·타이머, 가짜 서버·현관)다. 서버의 연결 표만 시험이 바꿔 실행기가 붙는 때를 정한다.
// 기다림의 끝은 min(단계 시작 + 25,000, 단계 기한 − 5,000)이고 250ms마다 다시 읽는다(peers.ts의 상수). 여기서는 그 값을 글자로 고정한다.
import { describe, expect, test } from "bun:test";
import { parsePrincipal } from "../../../src/contract/v1/index.ts";
import type { OccupancyAnswer } from "../../../src/ledger/index.ts";
import type { LogFields, RunningSupervisor } from "../../../src/supervisor/runtime/boot.ts";
import type { ConnectionServer } from "../../../src/supervisor/transport/server.ts";
import { EXECUTOR, executorKey, FILES, registryDoc, type World, world } from "./boot-world.ts";

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
      // 다시 읽기는 250ms 간격: 시작 + 기다린 시간 / 250 + 1번.
      expect(t.asked.length).toBe(c.waited / 250 + 1);
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
