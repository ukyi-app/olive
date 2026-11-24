// 조립(boot.ts)의 효과 순서: 기한·장부 건강·허가 폐기를 효과(장부 발급 기록, 송신, 허가, 현관 결과의 장부 반영)보다 먼저 보는지.
// 가짜 세계(boot-world.ts)는 수동 시계로 정각과 동기 비용을 만든다. 실제 장부를 쓰므로 장부 쓰기는 커밋 직전 훅으로 센다.
import { describe, expect, test } from "bun:test";
import { openLedger, type OpenOptions } from "../../../src/ledger/index.ts";
import type { BootResult, RunningSupervisor } from "../../../src/supervisor/runtime/boot.ts";
import { type BeatReport, createCycle } from "../../../src/supervisor/runtime/cycle.ts";
import { digest, must, ready } from "../../ledger/helpers.ts";
import { FILES, WALL, type World, world } from "./boot-world.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}

// 장부의 커밋 직전마다 연산 이름을 적는다(성공한 쓰기 트랜잭션). after가 있으면 그 지점마다 부른다(읽기 실패 주입).
function countCommits(w: World, after?: (point: string) => void): string[] {
  const commits: string[] = [];
  const open = w.deps.openLedger;
  w.deps = {
    ...w.deps,
    openLedger: (path: string, options: OpenOptions) =>
      open(path, {
        ...options,
        faults: {
          at(point: string) {
            after?.(point);
            if (point.endsWith(":before_commit")) commits.push(point.split(":")[0]!);
          },
        },
      }),
  };
  return commits;
}

const named = (w: World, name: string) => w.events.filter((e) => e.event === name);
const fatals = (w: World) => named(w, "fatal").map((e) => e.fields.reason);
const steps = (w: World) => named(w, "restore_step").map((e) => e.fields.step);

async function running(w: World): Promise<RunningSupervisor> {
  const result: BootResult = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  await w.time.flush();
  return result.running;
}

async function untilStep(w: World, step: number): Promise<void> {
  for (let i = 0; i < 20 && !steps(w).includes(step); i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
  expect(steps(w)).toContain(step);
}

describe("기한은 일을 부르기 전에 정한다(F2)", () => {
  // 일의 동기 비용만으로 상한을 1ms 넘긴다. 결과가 타이머보다 먼저 처리돼도 받아들이지 않는다.
  test("재료·등록표 파일 읽기의 동기 비용이 상한을 넘기면 92·93이고 소켓을 열지 않는다", async () => {
    for (const [file, code] of [
      [FILES.certificate, 92],
      [FILES.registry, 93],
    ] as const) {
      const w = world();
      const read = w.files.get(file)!;
      w.files.set(file, () => {
        w.time.set(w.time.monoNow() + w.settings.timing.startupWaitMs + 1);
        return read();
      });
      const result = await w.boot();
      expect(result.ok).toBe(false);
      if (!result.ok) expect([result.code, result.reason]).toEqual([code, file === FILES.certificate ? "certificate:lapsed" : "lapsed"]);
      expect(w.fake.starts).toBe(0);
    }
  });

  test("서버 시작의 동기 비용이 상한을 넘기면 95이고 늦게 선 서버를 닫는다", async () => {
    const w = world();
    const start = w.deps.startServer;
    w.deps = {
      ...w.deps,
      startServer: (options) => {
        w.time.set(w.time.monoNow() + w.settings.timing.startupWaitMs + 1);
        return start(options);
      },
    };
    const result = await w.boot();
    await w.time.flush();
    expect(result.ok).toBe(false);
    if (!result.ok) expect([result.code, result.reason]).toEqual([95, "start:lapsed"]);
    expect([w.fake.starts, w.fake.closes, w.captured.issuance]).toEqual([1, 1, undefined]);
  });

  test("5단계의 동기 비용이 상한을 넘기면 그 허가를 받아들이지 않는다: 96, 5단계 기록 0, 소비자가 보는 문은 모두 닫힘", async () => {
    const w = world();
    let spent = false;
    const open = w.deps.openLedger;
    w.deps = {
      ...w.deps,
      openLedger: (path, options) => {
        const result = open(path, options);
        if (result.ok) {
          const ledger = result.ledger;
          const view = ledger.queueView.bind(ledger);
          // queueView는 5단계 본문만 부른다. 그 동기 구간에서 상한 + 1ms를 쓴다.
          ledger.queueView = () => {
            if (!spent) {
              spent = true;
              w.time.set(w.time.monoNow() + w.settings.timing.restoreStepWaitMs + 1);
            }
            return view();
          };
        }
        return result;
      },
    };
    const run = await running(w);
    await untilStep(w, 4);
    for (let i = 0; i < 5 && !spent; i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
    const code = await run.done;
    expect(spent).toBe(true);
    expect(code).toBe(96);
    expect(fatals(w)).toEqual(["restore_lapsed"]);
    expect(steps(w)).toEqual([1, 2, 3, 4]);
    // 복원기는 장부에 허가를 냈지만(동기 5단계) 조립의 소비자는 그것을 보지 않는다.
    expect(w.captured.cycle!.deps.restoreDone()).toBe(false);
    expect(w.captured.issuance!.ports.cycle.issuanceOpen()).toBe(false);
    // 박자 다섯(수명·배정 포함)은 한 번도 불리지 않았다.
    expect(named(w, "beat").some((e) => e.fields.life !== "skipped:restore_not_done")).toBe(false);
  });

  test("끝 차례의 동기 비용이 상한을 넘기면 96이다(기한은 기록·시계 읽기·닫기 시작보다 먼저)", async () => {
    const w = world({
      makers: {
        cycle: (deps) => {
          const real = createCycle(deps);
          return {
            ...real,
            closeIssuance: () => {
              w.time.set(w.time.monoNow() + w.settings.timing.stopWaitMs + 1);
              return real.closeIssuance();
            },
          };
        },
      },
    });
    const run = await running(w);
    expect(await run.stop()).toBe(96);
    expect(named(w, "shutdown_incomplete").map((e) => e.fields.kind)).toEqual(["lapsed"]);
  });

  test("조립 실패 뒤 정리: 발급 문을 만들었으면 그 문으로 닫고(깃발 → 서버), 동기 비용이 상한을 넘기면 serverClosed:false", async () => {
    const w = world({
      makers: {
        lines: () => {
          throw new Error("lines");
        },
      },
    });
    w.fake.closeWith = () => {
      w.time.set(w.time.monoNow() + w.settings.timing.stopWaitMs + 1);
      return Promise.resolve();
    };
    const result = await w.boot();
    expect(result.ok).toBe(false);
    if (!result.ok) expect([result.code, result.reason]).toEqual([95, "wiring"]);
    expect(w.captured.cycle!.value.issuanceOpen()).toBe(false);
    expect(named(w, "issuance").map((e) => e.fields.step)).toEqual(["issuance_closed", "server_closed"]);
    expect(named(w, "boot_cleanup").map((e) => e.fields)).toEqual([{ serverClosed: false, ledgerClosed: true }]);
    expect(w.fake.closes).toBe(1);
  });
});

describe("현관 답은 장부에 반영하기 전에 단계 기한을 본다(F3)", () => {
  test("정각에 받은 권위 정지 기록은 장부에 적지 않는다(1단계)", async () => {
    const w = world();
    const commits = countCommits(w);
    const answer = deferred<{ generation: number; stopped: boolean } | null>();
    let askedAt = -1;
    w.front.stop = () => {
      askedAt = w.time.monoNow();
      return answer.promise;
    };
    const run = await running(w);
    w.time.set(askedAt + w.settings.timing.restoreStepWaitMs);
    answer.resolve({ generation: 1, stopped: true });
    await w.time.flush();
    expect(await run.done).toBe(96);
    expect(fatals(w)).toEqual(["restore_lapsed"]);
    expect(commits).not.toContain("stop");
    const check = openLedger(w.ledgerPath, { mode: "reopen", clock: () => WALL });
    if (!check.ok) throw new Error(check.reason);
    const stop = check.ledger.readStop();
    check.ledger.close();
    expect(stop.known && stop.value?.generation === 1).toBe(false);
  });

  test("4단계의 게시 둘은 기한 하나를 함께 쓴다: 정각에 받은 게시 확인은 확정으로 남지 않고, 새 기동의 4단계가 다시 묻는다", async () => {
    const w = world();
    const seed = openLedger(w.ledgerPath, { mode: "reopen", clock: () => WALL });
    if (!seed.ok) throw new Error(seed.reason);
    ready(seed.ledger);
    must(seed.ledger.recordPublication({ frontJobId: "job-a", candidateDigest: digest("a"), runId: null, now: WALL }));
    must(seed.ledger.recordPublication({ frontJobId: "job-b", candidateDigest: digest("b"), runId: null, now: WALL }));
    seed.ledger.close();
    const answers = new Map([
      ["job-a", deferred<{ kind: "pending" } | { kind: "confirmed"; outcome: "posted" }>()],
      ["job-b", deferred<{ kind: "pending" } | { kind: "confirmed"; outcome: "posted" }>()],
    ]);
    const asked: { job: string; at: number }[] = [];
    w.deps = {
      ...w.deps,
      frontDoor: {
        ...w.deps.frontDoor,
        publications: {
          lookup: (job: string) => {
            asked.push({ job, at: w.time.monoNow() });
            return answers.get(job)!.promise;
          },
        },
      },
    };
    const run = await running(w);
    await untilStep(w, 3);
    for (let i = 0; i < 5 && asked.length === 0; i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
    expect(asked.map((a) => a.job)).toEqual(["job-a"]);
    // 첫 게시는 기한 1ms 전에 대기로 답한다. 둘째 게시는 같은 단계 기한의 정각에 확정으로 답한다(둘째가 새 기한을 얻으면 받아들여진다).
    const limit = asked[0]!.at + w.settings.timing.restoreStepWaitMs;
    w.time.set(limit - 1);
    answers.get("job-a")!.resolve({ kind: "pending" });
    await w.time.flush();
    expect(asked.map((a) => a.job)).toEqual(["job-a", "job-b"]);
    w.time.set(limit);
    answers.get("job-b")!.resolve({ kind: "confirmed", outcome: "posted" });
    await w.time.flush();
    expect(await run.done).toBe(96);
    expect(fatals(w)).toEqual(["restore_lapsed"]);

    const check = openLedger(w.ledgerPath, { mode: "reopen", clock: () => WALL });
    if (!check.ok) throw new Error(check.reason);
    const states = check.ledger.publications();
    check.ledger.close();
    if (!states.known) throw new Error("publications");
    expect(states.value.find((p) => p.frontJobId === "job-b")?.state).not.toBe("confirmed");

    // 같은 장부로 새 기동: 확정되지 않은 두 게시를 4단계에서 다시 묻는다.
    const again = world();
    again.settings = { ...again.settings, ledgerPath: w.ledgerPath };
    const lookups: string[] = [];
    again.deps = {
      ...again.deps,
      frontDoor: {
        ...again.deps.frontDoor,
        publications: {
          lookup: async (job: string) => {
            lookups.push(job);
            return { kind: "pending" as const };
          },
        },
      },
    };
    const second = await running(again);
    await untilStep(again, 5);
    expect(lookups.sort()).toEqual(["job-a", "job-b"]);
    expect(await second.stop()).toBe(0);
  });
});

describe("이미 생긴 치명 실패는 멈춤 요청보다 먼저다(F5)", () => {
  test("박자가 거부된 같은 차례에 멈춤이 와도 96", async () => {
    const beat = deferred<BeatReport>();
    const w = world({ makers: { cycle: (deps) => ({ ...createCycle(deps), beat: () => beat.promise }) } });
    const run = await running(w);
    beat.reject(new Error("beat"));
    expect(await run.stop()).toBe(96);
    expect(fatals(w)).toEqual(["beat_failed"]);
  });

  test("장부 읽기 실패로 쓸 수 없게 된 뒤 다음 확인 전에 멈춰도 96", async () => {
    const w = world();
    let inject = false;
    countCommits(w, (point) => {
      if (inject && point === "read") {
        inject = false;
        throw new Error("read failure");
      }
    });
    const run = await running(w);
    inject = true;
    w.opened!.readStop();
    expect(w.opened!.health().writable).toBe(false);
    expect(await run.stop()).toBe(96);
    expect(fatals(w)).toEqual(["ledger_unwritable"]);
  });
});

describe("D-90 박자의 기록(F6)", () => {
  test("결과 종류별 건수·멈춘 이유·다시 읽은 사유를 정해진 이름으로 싣는다", async () => {
    const w = world();
    const run = await running(w);
    await untilStep(w, 5);
    await w.time.advance(w.settings.timing.beatEveryMs);
    const ran = named(w, "beat").filter((e) => e.fields.kind === "ran" && e.fields.linkLoss === "returned");
    expect(ran.length).toBeGreaterThan(0);
    const last = ran.at(-1)!.fields;
    // 실행이 없으면 D-90은 항목 0으로 돈다.
    expect(last).toMatchObject({ unreceived: "ran", unreceivedOutcomes: "", unreceivedHalted: null, rereadCauses: "" });
    expect(await run.stop()).toBe(0);
  });
});
