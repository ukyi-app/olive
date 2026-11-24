// 감독 조립(boot.ts)의 기동·종료 차례, 같은 객체, 모름·실패 표, 기다림의 기한(결과가 먼저·타이머가 먼저인 정각), 정적 규칙.
// 장부는 임시 폴더의 실제 장부, 서버·파일·현관은 가짜, 시계와 타이머는 손으로 돌린다(boot-world.ts).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "../../../src/ledger/index.ts";
import { SUPERVISOR_EXIT, waitUntil } from "../../../src/supervisor/runtime/boot.ts";
import { createCycle } from "../../../src/supervisor/runtime/cycle.ts";
import type { RunningSupervisor } from "../../../src/supervisor/runtime/boot.ts";
import { readText } from "../../files.ts";
import { EXECUTOR, executorKey, FILES, manualTime, registryDoc, WALL, type World, world } from "./boot-world.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function started(w: World): Promise<RunningSupervisor> {
  const result = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  return result.running;
}

// 복원 다섯 단계를 받아들일 때까지 박자를 돌린다.
async function untilOpen(w: World): Promise<void> {
  for (let i = 0; i < 20 && !w.events.some((e) => e.event === "restore_step" && e.fields.step === 5); i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
  expect(w.events.find((e) => e.event === "restore_step" && e.fields.step === 5)?.fields).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });
}

const steps = (w: World) => w.trace.filter((item) => !item.startsWith("log:"));
const fatal = (w: World) => w.events.find((e) => e.event === "fatal")?.fields.reason ?? null;

describe("기동과 종료의 차례", () => {
  test("재료 → 등록표 → 장부(reopen) → 복원기 → 순서기 → 서버 → 발급·내보내기 포트·답 줄의 차례로 띄우고, 복원 5단계 뒤에만 박자가 돈다", async () => {
    const w = world();
    const running = await started(w);
    expect(steps(w)).toEqual([
      `read:${FILES.certificate}`,
      `read:${FILES.privateKey}`,
      `read:${FILES.trustBundle}`,
      `read:${FILES.signingKey}`,
      `read:${FILES.registry}`,
      "open:reopen",
      "results",
      "restorer",
      "cycle",
      "server_start",
      "issuance",
      "sink",
      "lines",
    ]);
    // 첫 박자는 복원 1단계를 받아들이기 전이라 서버 tick만 돈다.
    expect(w.events.find((e) => e.event === "beat")?.fields).toMatchObject({ kind: "ran", linkLoss: "skipped:restore_not_done", assign: "skipped:restore_not_done" });
    await untilOpen(w);
    expect(w.events.filter((e) => e.event === "restore_step").map((e) => e.fields.step)).toEqual([1, 2, 3, 4, 5]);
    await w.time.advance(w.settings.timing.beatEveryMs);
    const last = w.events.filter((e) => e.event === "beat").at(-1)!.fields;
    expect(last).toMatchObject({ kind: "ran", linkLoss: "returned", life: "returned", resend: "returned" });
    expect(w.captured.pumps).toBe(w.events.filter((e) => e.event === "beat").length);

    expect(await running.stop()).toBe(0);
    expect(await running.done).toBe(0);
    const tail = w.trace.slice(w.trace.indexOf("log:shutdown_called"));
    expect(tail).toEqual(["log:shutdown_called", "log:issuance", "server_close", "log:issuance", "log:stopped"]);
    expect(w.events.filter((e) => e.event === "issuance").map((e) => e.fields.step)).toEqual(["issuance_closed", "server_closed"]);
    // 장부를 닫았다: 같은 경로를 다시 열 수 있다(잠금이 풀렸다).
    const again = openLedger(w.ledgerPath, { clock: () => WALL, mode: "reopen" });
    expect(again.ok).toBe(true);
    if (again.ok) again.ledger.close();
  });

  test("stop()을 여러 번 불러도 끝 차례는 한 번이다", async () => {
    const w = world();
    const running = await started(w);
    const [a, b] = [running.stop(), running.stop()];
    expect(a).toBe(b);
    expect(await a).toBe(0);
    expect(w.fake.closes).toBe(1);
  });

  test("기동 중 멈춤: 서버 전이면 소켓 0으로 0, 서버 시작을 기다리는 중이면 늦게 선 서버를 닫고 0", async () => {
    const before = world();
    const early = new AbortController();
    early.abort();
    expect(await before.boot(early.signal)).toMatchObject({ ok: false, step: "aborted", code: 0 });
    expect(before.fake.starts).toBe(0);

    const during = world();
    const gate = deferred<void>();
    const start = during.fake.start;
    during.deps = { ...during.deps, startServer: async (options) => (await gate.promise, start(options)) };
    const stop = new AbortController();
    const pending = during.boot(stop.signal);
    await during.time.flush();
    stop.abort();
    expect(await pending).toMatchObject({ ok: false, step: "aborted", code: 0 });
    gate.resolve();
    await during.time.flush();
    expect(during.fake.closes).toBe(1);
    // 장부도 닫았다.
    const again = openLedger(during.ledgerPath, { clock: () => WALL, mode: "reopen" });
    expect(again.ok).toBe(true);
    if (again.ok) again.ledger.close();
  });
});

describe("같은 객체(S1~S9)", () => {
  test("공유 시계·장부·복원기·서버·등록부·순서기를 모든 소비자에 같은 객체로 넘긴다", async () => {
    const w = world();
    const running = await started(w);
    const c = w.captured;
    const shared = c.shared!;
    const restorer = c.restorer!.value;
    const ledger = w.opened!;
    const options = w.fake.options!;
    // 시계: 순서기·발급·내보내기 포트·답 줄은 그 객체, 장부·서버·복원기는 그 객체를 읽는 함수다(아래 시험이 하한으로 본다).
    expect(c.cycle!.deps.ledgerClock).toBe(shared);
    expect(c.issuance!.ports.clock).toBe(shared);
    expect(c.sink!.ports.clock).toBe(shared);
    expect(c.lines!.ports.clock).toBe(shared);
    // 장부 한 열기.
    expect(c.restorer!.ledger).toBe(ledger);
    expect(c.cycle!.deps.ledger).toBe(ledger);
    expect(c.issuance!.ports.ledger).toBe(ledger);
    expect(c.lines!.ports.ledger).toBe(ledger);
    expect(c.lines!.ports.results.ledger).toBe(ledger);
    // 복원기 하나를 게시 함수로.
    expect(options.restorer()).toBe(restorer);
    expect(c.sink!.ports.restorer()).toBe(restorer);
    expect(c.lines!.ports.restorer()).toBe(restorer);
    expect(c.issuance!.ports.restorer()).toBe(restorer);
    // 서버 하나, 등록부 하나, 순서기 하나.
    expect(c.issuance!.ports.server).toBe(w.fake.server);
    expect(c.sink!.ports.server).toBe(w.fake.server);
    expect(c.lines!.ports.table()).toBe(w.fake.server.table());
    expect(c.sink!.ports.queries).toBe(c.queries!);
    expect(c.lines!.ports.queries).toBe(c.queries!);
    expect(c.issuance!.ports.cycle).toBe(c.cycle!.value);
    expect(c.lines!.ports.cycle).toBe(c.cycle!.value);
    // 발급 깃발과 자격 값의 두 문(S8·S9). 깃발 칸이 빠지면 늘 열린 것으로 보는 선택 칸이다.
    expect(c.sink!.ports.issuanceOpen).toBe(c.issuance!.value.issuanceOpen);
    expect(c.lines!.ports.credentials).toBe(c.issuance!.value.credentials);
    // 맡기지 않을 실행기: 내보내기 포트는 같은 답 줄에 위임한다(S6).
    expect(c.sink!.ports.withheld.executors()).toEqual(c.lines!.value.withheld.executors());
    // nonce는 장부의 기록으로 한 번만 성공한다(S36).
    expect(options.nonces.consume(EXECUTOR, "a".repeat(32), WALL)).toBe(true);
    expect(options.nonces.consume(EXECUTOR, "a".repeat(32), WALL)).toBe(false);
    await running.stop();
  });

  test("장부·서버·복원기의 시계는 공유 시계를 거친다: 원천이 뒤로 가도 하한을 낸다(S1)", async () => {
    const w = world();
    const running = await started(w);
    const ledgerClock = w.openCalls[0]!.options.clock;
    w.wall = WALL + 5_000;
    expect(ledgerClock()).toBe(WALL + 5_000);
    w.wall = WALL + 1_000;
    expect(ledgerClock()).toBe(WALL + 5_000);
    expect(w.fake.options!.clock()).toBe(WALL + 5_000);
    expect(w.captured.restorer!.clock()).toBe(WALL + 5_000);
    // 순서기는 같은 하한으로 후퇴를 안다.
    expect(w.captured.shared!.read()).toEqual({ state: "regressed" });
    await running.stop();
  });

  test("도구 처리기 포트의 자리: 넘긴 정책·설정을 싣고, 처리기 문맥의 now는 공유 시계의 하한이다(S41)", async () => {
    const w = world();
    const running = await started(w);
    const judged: string[] = [];
    const policy = { judge: (role: string, purpose: string) => (judged.push(`${role}:${purpose}`), "allowed" as const) };
    const made = running.tools(policy, { purposeBriefMaxChars: 200 }, () => {});
    expect(made.ports.policy.judge("diagnosis", "p")).toBe("allowed");
    expect(judged).toEqual(["diagnosis:p"]);
    expect(made.ports.config.purposeBriefMaxChars).toBe(200);
    w.wall = WALL + 9_000;
    expect(made.now()).toBe(WALL + 9_000);
    w.wall = WALL + 1;
    expect(made.now()).toBe(WALL + 9_000);
    expect(w.captured.shared!.read()).toEqual({ state: "regressed" });
    await running.stop();
  });

  test("복원기의 필수 이웃은 현관·관측 중계와 등록표의 활성 실행기다(S21)", async () => {
    const k1 = executorKey();
    const k2 = executorKey();
    const w = world();
    w.files.set(FILES.registry, () => Promise.resolve(registryDoc([{ publicKeyRaw: k1.raw }, { publicKeyRaw: k2.raw, active: false }])));
    const running = await started(w);
    expect(w.captured.restorer!.requiredPeers).toEqual(["front-door", "observation-relay", EXECUTOR]);
    await running.stop();
  });
});

describe("대조·복원 전의 값으로 판단하지 않는다", () => {
  test("답 줄이 서기 전의 deliver는 던져 그 연결을 닫는다", async () => {
    const w = world();
    const thrown: string[] = [];
    const start = w.fake.start;
    w.deps = {
      ...w.deps,
      startServer: (options) => {
        try {
          options.deliver({ kind: "withdrawn", connection: 1 } as never);
        } catch (error) {
          thrown.push((error as Error).message);
        }
        return start(options);
      },
    };
    const running = await started(w);
    expect(thrown).toEqual(["not_ready"]);
    await running.stop();
  });

  test("답 줄의 관측 신호는 2단계를, 순서기의 복원 끝은 5단계를 받아들인 뒤에만 참이다(S23·S24)", async () => {
    const w = world();
    const gate = deferred<void>();
    w.front.peers = async () => (await gate.promise, [{ peer: "front-door", contract: "olive-control/v2", policy: "match" }, { peer: "observation-relay", contract: "olive-control/v1", policy: "match" }]);
    const running = await started(w);
    const settled = w.captured.lines!.ports.observationsSettled;
    const done = w.captured.cycle!.deps.restoreDone;
    await w.time.advance(100);
    expect(w.events.filter((e) => e.event === "restore_step").map((e) => e.fields.step)).toEqual([1]);
    // 1단계 뒤 세대는 알지만 2단계 전이다.
    expect(w.captured.restorer!.value.stopGeneration()).toBe(0);
    expect([settled(), done()]).toEqual([false, false]);
    gate.resolve();
    await w.time.advance(100);
    expect(settled()).toBe(true);
    expect(done()).toBe(false);
    await untilOpen(w);
    expect(done()).toBe(true);
    await running.stop();
  });

  test("현관이 답하지 않으면 1단계를 같은 복원기로 되풀이하고 재시작하지 않는다: 박자는 서버 tick만, 맞춤 세대는 null(D-76)", async () => {
    const w = world();
    w.front.stop = () => Promise.reject(new Error("front_door_absent"));
    const running = await started(w);
    for (let i = 0; i < 5; i += 1) await w.time.advance(100);
    expect(w.events.filter((e) => e.event === "restore_retry").map((e) => e.fields.step)).toEqual([1]);
    expect(w.captured.restorer!.value.stopGeneration()).toBeNull();
    expect(fatal(w)).toBeNull();
    expect(w.fake.ticks).toBeGreaterThanOrEqual(5);
    expect(w.events.filter((e) => e.event === "beat").every((e) => e.fields.linkLoss === "skipped:restore_not_done")).toBe(true);
    await running.stop();
  });

  test("5단계가 닫힌 판정이면 닫힌 채 박자(종료·조회)를 돌린다: 끝내지 않는다", async () => {
    const w = world();
    w.front.peers = async () => [{ peer: "front-door", contract: "olive-control/v2", policy: "match" }];
    const running = await started(w);
    for (let i = 0; i < 8; i += 1) await w.time.advance(100);
    expect(w.events.find((e) => e.event === "restore_step" && e.fields.step === 5)?.fields).toEqual({ step: 5, intakeMayOpen: false, closedBecause: "peer_unconfirmed" });
    expect(fatal(w)).toBeNull();
    expect(w.events.filter((e) => e.event === "beat").at(-1)!.fields).toMatchObject({ linkLoss: "returned" });
    await running.stop();
  });
});

describe("연결 전에 거를 값은 소켓을 열기 전에 끝낸다", () => {
  const cases: { name: string; arrange: (w: World) => void; code: number; step: string; reason: RegExp }[] = [
    { name: "TLS 키 파일 0바이트", arrange: (w) => w.files.set(FILES.privateKey, () => Promise.resolve(new Uint8Array())), code: 92, step: "material", reason: /^privateKey:empty$/ },
    { name: "신뢰 묶음 없음", arrange: (w) => w.files.delete(FILES.trustBundle), code: 92, step: "material", reason: /^trustBundle:unreadable$/ },
    { name: "서명 키가 ed25519가 아님", arrange: (w) => w.files.set(FILES.signingKey, () => Promise.resolve(new TextEncoder().encode("not a key"))), code: 92, step: "material", reason: /^signingKey:unreadable$/ },
    { name: "등록표 읽기 실패", arrange: (w) => w.files.delete(FILES.registry), code: 93, step: "registry", reason: /^unreadable$/ },
    {
      name: "등록표 environment 불일치",
      arrange: (w) => w.files.set(FILES.registry, () => Promise.resolve(new TextEncoder().encode(JSON.stringify({ environment: "other", revision: 1, executors: [] })))),
      code: 93,
      step: "registry",
      reason: /^rejected:/,
    },
    { name: "순서기 정책 범위 밖(resendEveryMs 19,001)", arrange: (w) => (w.settings = { ...w.settings, cycle: { ...w.settings.cycle, resendEveryMs: 19_001 } }), code: 95, step: "server", reason: /^cycle:/ },
    {
      name: "결과 보관 폴더가 틀림",
      arrange: (w) => (w.deps = { ...w.deps, createResultBackend: () => ({ status: "invalid", reason: "not_dir" }) }),
      code: 94,
      step: "ledger",
      reason: /^result_dir:not_dir$/,
    },
    { name: "타이밍 값이 0", arrange: (w) => (w.settings = { ...w.settings, timing: { ...w.settings.timing, stopWaitMs: 0 } }), code: 91, step: "config", reason: /^timing\.stopWaitMs$/ },
  ];
  for (const item of cases) {
    test(`${item.name} → ${item.code}, 서버 시작 0`, async () => {
      const w = world();
      item.arrange(w);
      const result = await w.boot();
      expect(result).toMatchObject({ ok: false, code: item.code, step: item.step });
      if (!result.ok) expect(result.reason).toMatch(item.reason);
      expect(w.fake.starts).toBe(0);
      // 장부를 열었다면 닫았다.
      const again = openLedger(w.ledgerPath, { clock: () => WALL, mode: "reopen" });
      expect(again.ok).toBe(true);
      if (again.ok) again.ledger.close();
    });
  }

  test("장부 not_initialized(빈 자리) → 94, 첫 설치로 넘어가지 않는다(파일을 만들지 않는다)", async () => {
    const w = world();
    const missing = join(w.ledgerPath, "..", "missing.db");
    w.settings = { ...w.settings, ledgerPath: missing };
    const result = await w.boot();
    expect(result).toMatchObject({ ok: false, code: 94, step: "ledger", reason: "open:not_initialized" });
    expect(w.openCalls.map((c) => c.options.mode)).toEqual(["reopen"]);
    expect(await Bun.file(missing).exists()).toBe(false);
    expect(w.fake.starts).toBe(0);
  });

  test("장부 locked(다른 열기가 쥠) → 94, 서버 시작 0", async () => {
    const w = world();
    const holder = openLedger(w.ledgerPath, { clock: () => WALL, mode: "reopen" });
    if (!holder.ok) throw new Error("잠금을 쥐지 못했다");
    try {
      expect(await w.boot()).toMatchObject({ ok: false, code: 94, reason: "open:locked" });
      expect(w.fake.starts).toBe(0);
    } finally {
      holder.ledger.close();
    }
  });

  test("서버 시작 실패: listen_failed → 95, no_material → 92. 둘 다 장부를 닫는다", async () => {
    for (const [failure, code] of [
      [{ kind: "listen_failed", message: "in use" }, 95],
      [{ kind: "no_material", reason: "certificate" }, 92],
    ] as const) {
      const w = world();
      w.deps = { ...w.deps, startServer: async () => ({ ok: false, failure }) as never };
      expect(await w.boot()).toMatchObject({ ok: false, code });
      const again = openLedger(w.ledgerPath, { clock: () => WALL, mode: "reopen" });
      expect(again.ok).toBe(true);
      if (again.ok) again.ledger.close();
    }
  });

  test("서버를 연 뒤 조립 생성자가 던지면 서버를 닫고 장부를 닫은 뒤 95", async () => {
    const w = world({
      makers: {
        lines: () => {
          throw new TypeError("boom");
        },
      },
    });
    expect(await w.boot()).toMatchObject({ ok: false, code: 95, reason: "wiring" });
    expect(w.fake.closes).toBe(1);
    const again = openLedger(w.ledgerPath, { clock: () => WALL, mode: "reopen" });
    expect(again.ok).toBe(true);
    if (again.ok) again.ledger.close();
  });
});

describe("치명 실패는 끝 차례를 밟고 96으로 끝난다", () => {
  test("박자 약속의 거부 → 96(발급 닫기 → 서버 닫기 → 장부 닫기)", async () => {
    const w = world({
      makers: {
        cycle: (deps) => {
          const real = createCycle(deps);
          return { ...real, beat: () => Promise.reject(new Error("beat")) };
        },
      },
    });
    const running = await started(w);
    expect(await running.done).toBe(SUPERVISOR_EXIT.fatal);
    expect(fatal(w)).toBe("beat_failed");
    const tail = w.trace.slice(w.trace.indexOf("log:shutdown_called"));
    expect(tail).toEqual(["log:shutdown_called", "log:issuance", "server_close", "log:issuance", "log:stopped"]);
  });

  test("장부가 쓸 수 없게 되면 → 96(다시 열지 않는다)", async () => {
    let broken = false;
    const w = world();
    const real = w.deps.openLedger;
    w.deps = {
      ...w.deps,
      openLedger: (path, options) => {
        const result = real(path, options);
        if (!result.ok) return result;
        const target = result.ledger;
        const proxy = new Proxy(target, {
          get(t, p) {
            if (p === "health" && broken) return () => ({ writable: false, reason: "io" });
            const value = Reflect.get(t, p, t);
            return typeof value === "function" ? value.bind(t) : value;
          },
        });
        return { ...result, ledger: proxy };
      },
    };
    const running = await started(w);
    await w.time.advance(100);
    broken = true;
    await w.time.advance(100);
    expect(await running.done).toBe(96);
    expect(fatal(w)).toBe("ledger_unwritable");
    expect(w.openCalls.length).toBe(1);
  });

  test("낸 접수 허가가 버려지면(정지 세대가 바뀜) → 96. 새 복원기는 재시작이 만든다", async () => {
    const w = world();
    const running = await started(w);
    await untilOpen(w);
    expect(w.opened!.applyStop({ generation: 1, stopped: true, now: WALL }).ok).toBe(true);
    await w.time.advance(100);
    expect(await running.done).toBe(96);
    expect(fatal(w)).toBe("intake_discarded");
  });

  test("끝 차례에서 서버 닫기가 실패하면 0이 아니라 96", async () => {
    const w = world();
    w.fake.closeWith = () => Promise.reject(new Error("close"));
    const running = await started(w);
    expect(await running.stop()).toBe(96);
    expect(w.events.find((e) => e.event === "shutdown_incomplete")?.fields).toEqual({ kind: "failed" });
  });
});

describe("기다림마다 기한: 결과를 받아들이는 순간의 시각으로 판정한다", () => {
  test("waitUntil: 정각에 결과가 먼저 와도 만료, 타이머가 먼저 와도 만료, 정각 1ms 전의 결과는 받는다", async () => {
    const time = manualTime(0);
    const a = deferred<number>();
    const first = waitUntil(a.promise, 100, time);
    time.set(100);
    a.resolve(1);
    expect(await first).toEqual({ kind: "lapsed" });
    const b = deferred<number>();
    const second = waitUntil(b.promise, 200, time);
    await time.advance(100);
    expect(await second).toEqual({ kind: "lapsed" });
    b.resolve(2);
    const c = deferred<number>();
    const third = waitUntil(c.promise, 300, time);
    time.set(299);
    c.resolve(3);
    expect(await third).toEqual({ kind: "done", value: 3 });
    // 실패한 결과도 정각 이후면 만료다.
    const d = deferred<number>();
    const fourth = waitUntil(d.promise, 400, time);
    time.set(400);
    d.reject(new Error("x"));
    expect(await fourth).toEqual({ kind: "lapsed" });
    // 타이머를 걸지 못하면 unarmed.
    expect(await waitUntil(new Promise<number>(() => {}), 500, { monoNow: () => 0, setTimer: () => { throw new Error("no"); } })).toEqual({ kind: "unarmed" });
  });

  // 기동의 파일 읽기: 기한 = 시작 + startupWaitMs(500).
  for (const order of ["result_first", "timer_first"] as const) {
    test(`파일 읽기의 기한 정각(${order}) → 92`, async () => {
      const w = world();
      const late = deferred<Uint8Array>();
      w.files.set(FILES.certificate, () => late.promise);
      const pending = w.boot();
      await w.time.flush();
      if (order === "result_first") {
        w.time.set(1_500);
        late.resolve(new TextEncoder().encode("CERT"));
      } else await w.time.advance(500);
      expect(await pending).toMatchObject({ ok: false, code: 92, reason: "certificate:lapsed" });
    });

    test(`서버 시작의 기한 정각(${order}) → 95, 늦게 선 서버는 닫는다`, async () => {
      const w = world();
      const late = deferred<void>();
      const start = w.fake.start;
      w.deps = { ...w.deps, startServer: async (options) => (await late.promise, start(options)) };
      const pending = w.boot();
      await w.time.flush();
      if (order === "result_first") {
        w.time.set(1_500);
        late.resolve();
      } else {
        await w.time.advance(500);
        late.resolve();
      }
      expect(await pending).toMatchObject({ ok: false, code: 95, reason: "start:lapsed" });
      await w.time.flush();
      expect(w.fake.closes).toBe(1);
    });

    test(`복원 단계의 기한 정각(${order}) → 96`, async () => {
      const w = world();
      const late = deferred<null>();
      w.front.stop = () => late.promise;
      const running = await started(w);
      // 1단계는 첫 주기(단조 1,000)에 불렸다. 기한은 1,000 + restoreStepWaitMs(2,000).
      if (order === "result_first") {
        w.time.set(3_000);
        late.resolve(null);
        await w.time.flush();
      } else await w.time.advance(2_000);
      expect(await running.done).toBe(96);
      expect(fatal(w)).toBe("restore_lapsed");
    });

    test(`박자의 기한 정각(${order}) → 96`, async () => {
      const late = deferred<never>();
      const w = world({
        makers: {
          cycle: (deps) => {
            const real = createCycle(deps);
            return { ...real, beat: () => late.promise };
          },
        },
      });
      const running = await started(w);
      if (order === "result_first") {
        w.time.set(2_000);
        late.resolve(undefined as never);
        await w.time.flush();
      } else await w.time.advance(1_000);
      expect(await running.done).toBe(96);
      expect(fatal(w)).toBe("beat_lapsed");
    });

    test(`끝 차례의 기한 정각(${order}) → 96`, async () => {
      const w = world();
      const late = deferred<void>();
      w.fake.closeWith = () => late.promise;
      const running = await started(w);
      const stopping = running.stop();
      await w.time.flush();
      if (order === "result_first") {
        w.time.set(1_700);
        late.resolve();
      } else await w.time.advance(700);
      expect(await stopping).toBe(96);
      expect(w.events.find((e) => e.event === "shutdown_incomplete")?.fields).toEqual({ kind: "lapsed" });
    });
  }

  test("대조군: 기한 1ms 전의 복원 단계 결과는 받아들인다", async () => {
    const w = world();
    const late = deferred<null>();
    w.front.stop = () => late.promise;
    const running = await started(w);
    w.time.set(2_999);
    late.resolve(null);
    await w.time.flush();
    expect(w.events.filter((e) => e.event === "restore_step").map((e) => e.fields.step)).toContain(1);
    expect(fatal(w)).toBeNull();
    await running.stop();
  });
});

describe("정적 규칙: 한 자리와 재개방 없음(S33·S34 해당 없음)", () => {
  const count = (source: string, pattern: RegExp) => [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))].length;
  const code = (source: string) =>
    source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

  test("장부 열기·복원기·순서기·서버 시작·발급 닫기가 각각 한 자리이고 재개방·첫 설치가 없다", async () => {
    const boot = code(await readText("src/supervisor/runtime/boot.ts"));
    expect(count(boot, /\bdeps\.openLedger\(/)).toBe(1);
    expect(count(boot, /\bmode: "reopen"/)).toBe(1);
    expect(count(boot, /"create"/)).toBe(0);
    expect(count(boot, /\bmake\.restorer\(/)).toBe(1);
    expect(count(boot, /\bmake\.cycle\(/)).toBe(1);
    expect(count(boot, /\bdeps\.startServer\(/)).toBe(1);
    expect(count(boot, /\bissuance\.shutdown\(\)/)).toBe(1);
    // 같은 이름에 다시 넣는 자리가 없다(장부·복원기·서버·순서기를 바꿔 끼우지 않는다).
    expect(count(boot, /^\s*restorer = /m)).toBe(1);
    expect(count(boot, /^\s*server = /m)).toBe(1);
    expect(count(boot, /^\s*cycle = /m)).toBe(1);
    expect(count(boot, /\bconst ledger = /)).toBe(1);
    // 대조군: 두 번 부르는 글은 둘로 센다.
    expect(count("deps.openLedger(a); deps.openLedger(b);", /\bdeps\.openLedger\(/)).toBe(2);
  });

  test("조립 모듈은 환경·시계·타이머·난수를 직접 부르지 않는다", async () => {
    const direct = /\bprocess\.env\b|\bBun\.env\b|\bDate\.now\b|\bperformance\.now\b|\bsetTimeout\b|\bsetInterval\b|\bMath\.random\b|\bgetRandomValues\b/;
    for (const file of ["src/supervisor/runtime/boot.ts", "src/supervisor/runtime/peers.ts", "src/supervisor/runtime/signer.ts"]) {
      expect(direct.test(code(await readText(file))), file).toBe(false);
    }
    expect(direct.test("const t = setTimeout(f, 1);")).toBe(true);
  });
});
