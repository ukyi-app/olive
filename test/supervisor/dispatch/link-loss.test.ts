// 연결 상실 반영의 한 박자. 장부는 실제 장부 파일이고, 연결 표는 occupancy(복원기)의 행만 내는 가짜다(맞춤·인사를 거친 실제 연결의
// 인정은 test/supervisor/transport/connections.test.ts가 본다). 가짜도 실제 표처럼 복원기의 객체 동일성과 세대를 본다.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { limits } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import { type LinkLossLedger, type LinkLossPorts, type LinkLossTickResult, linkLossTick, type WatchEntry } from "../../../src/supervisor/dispatch/link-loss.ts";
import { type LifecyclePolicy, type LifecycleView, nextIntent, RENEW_MARGIN_MS } from "../../../src/supervisor/scheduler/lifecycle.ts";
import { digest, id, must, NOW, open, ready, SESSION_EXECUTOR, session, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";

// 판정 시간은 계약 v1의 기본값(관리자 미확정)을 시험 자료로 넘긴다. 운영값을 정하는 것이 아니다.
const JUDGE = limits.DISCONNECT_JUDGE_MS;
const POLICY = { judgeMs: JUDGE };
// 저장소 ID만 다른 이름. 정확한 이름으로만 가르는지 본다.
const NEAR_EXECUTOR = "executor/diagnosis/0/store-b";
const OTHER_EXECUTOR = "executor/diagnosis/1/store-c";
const LIFE: LifecyclePolicy = { renewEveryMs: limits.RENEW_INTERVAL_MS, answerTimeoutMs: 30_000 };

interface World {
  ledger: Ledger;
  path: string;
  ports: LinkLossPorts;
  // markLostFor에 넘긴 실행기 이름의 차례.
  calls: string[];
  setClock(at: number | (() => number)): void;
  setLinked(names: string[]): void;
  setGeneration(value: number | null): void;
  wrap(over: Partial<LinkLossLedger>): void;
}

function world(): World {
  let clock: () => number = () => NOW;
  const path = tempPath();
  const ledger = ready(open(path, { clock: () => NOW }));
  let linked: string[] = [];
  let generation: number | null = 0;
  const calls: string[] = [];
  let over: Partial<LinkLossLedger> = {};
  const restorer = { stopGeneration: () => generation };
  const ports: LinkLossPorts = {
    ledger: {
      listRuns: () => (over.listRuns ?? ledger.listRuns.bind(ledger))(),
      markLostFor: (input) => {
        calls.push(input.executorId);
        return (over.markLostFor ?? ledger.markLostFor.bind(ledger))(input);
      },
    },
    connections: {
      occupancy: (source) => (source === restorer && generation !== null ? linked.map((executorId) => ({ executorId, coverage: "full" as const, runs: [] })) : []),
    },
    restorer,
    clock: { now: () => clock() },
  };
  return {
    ledger,
    path,
    ports,
    calls,
    setClock: (at) => {
      clock = typeof at === "number" ? () => at : at;
    },
    setLinked: (names) => {
      linked = names;
    },
    setGeneration: (value) => {
      generation = value;
    },
    wrap: (next) => {
      over = next;
    },
  };
}

// 작업자 실행 하나를 NOW에 시작하고 시작 영수증으로 running에 둔다.
function running(w: World, overrides: Parameters<typeof startedWorker>[1] = {}) {
  const s = startedWorker(w.ledger, overrides);
  must(w.ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, bodyDigest: digest("started"), now: NOW }, s.from));
  return s;
}

function state(ledger: Ledger, runId: string): string | undefined {
  const got = ledger.getRun(runId);
  return got.known && got.value !== null ? got.value.state : undefined;
}

function ran(result: LinkLossTickResult): Extract<LinkLossTickResult, { kind: "ran" }> {
  if (result.kind !== "ran") throw new Error(`박자가 돌지 않음: ${JSON.stringify(result)}`);
  return result;
}

const tick = (w: World, watch: WatchEntry[], policy: unknown = POLICY) => linkLossTick(w.ports, policy as never, { watch });

// 실행 줄의 꼴을 흉내 낸 가짜 줄(listRuns를 감싼 시험에서만 쓴다).
const row = (executorId: string, extra: Record<string, unknown> = {}) => ({ runId: id(), executorId, kind: "worker", state: "running", stopReceiptId: null, ...extra });

describe("보장 1: 판정은 시간으로 한다", () => {
  test("본 연결이 사라지면 처음 없음을 확인한 박자부터 세고, 판정 시간을 넘겨야(정각은 아직) 옮긴다", () => {
    const w = world();
    const s = running(w);
    w.setLinked([WORKER_EXECUTOR]);
    const first = ran(tick(w, []));
    expect(first.executors).toEqual([{ executorId: WORKER_EXECUTOR, outcome: "linked" }]);
    expect(first.watch).toEqual([{ executorId: WORKER_EXECUTOR, absentSince: null }]);

    w.setLinked([]);
    w.setClock(NOW + 1_000);
    const second = ran(tick(w, [...first.watch]));
    expect(second.executors).toEqual([{ executorId: WORKER_EXECUTOR, outcome: "within_judge", absentSince: NOW + 1_000 }]);
    expect(second.watch).toEqual([{ executorId: WORKER_EXECUTOR, absentSince: NOW + 1_000 }]);

    // 정각: 아직 판정 시간 안이다.
    w.setClock(NOW + 1_000 + JUDGE);
    const exact = ran(tick(w, [...second.watch]));
    expect(exact.executors).toEqual([{ executorId: WORKER_EXECUTOR, outcome: "within_judge", absentSince: NOW + 1_000 }]);
    expect(w.calls).toEqual([]);
    expect(state(w.ledger, s.runId)).toBe("running");

    w.setClock(NOW + 1_000 + JUDGE + 1);
    const lost = ran(tick(w, [...exact.watch]));
    expect(lost.executors).toEqual([
      {
        executorId: WORKER_EXECUTOR,
        outcome: "moved",
        absentSince: NOW + 1_000,
        at: NOW + 1_000 + JUDGE + 1,
        runs: [{ runId: s.runId, runGeneration: w.ledger.runGeneration(s.runId) as number, before: "running", after: "unknown_running" }],
      },
    ]);
    expect(w.calls).toEqual([WORKER_EXECUTOR]);
    expect(state(w.ledger, s.runId)).toBe("unknown_running");
    // 옮긴 뒤에는 진행 중 실행이 없어 판정 대상이 아니다. 기억은 남는다.
    expect(lost.watch).toEqual([{ executorId: WORKER_EXECUTOR, absentSince: NOW + 1_000 }]);
    expect(ran(tick(w, [...lost.watch])).executors).toEqual([]);
  });

  test("판정 시간 안에 다시 인정되면 옮기지 않고, 다시 끊기면 처음부터 센다", () => {
    const w = world();
    const s = running(w);
    w.setLinked([WORKER_EXECUTOR]);
    w.setClock(NOW + JUDGE);
    const back = ran(tick(w, [{ executorId: WORKER_EXECUTOR, absentSince: NOW + 1 }]));
    expect(back.executors).toEqual([{ executorId: WORKER_EXECUTOR, outcome: "linked" }]);
    expect(back.watch).toEqual([{ executorId: WORKER_EXECUTOR, absentSince: null }]);
    w.setLinked([]);
    w.setClock(NOW + JUDGE + 5);
    const again = ran(tick(w, [...back.watch]));
    expect(again.executors).toEqual([{ executorId: WORKER_EXECUTOR, outcome: "within_judge", absentSince: NOW + JUDGE + 5 }]);
    expect(w.calls).toEqual([]);
    expect(state(w.ledger, s.runId)).toBe("running");
  });

  test("본 적 없는 실행기와 뒤로 간 시계는 모름이고 판정하지 않는다", () => {
    const w = world();
    const s = running(w);
    w.setClock(NOW + 10 * JUDGE);
    const fresh = ran(tick(w, []));
    expect(fresh.executors).toEqual([{ executorId: WORKER_EXECUTOR, outcome: "unknown", reason: "never_seen" }]);
    expect(fresh.watch).toEqual([]);

    w.setClock(NOW);
    const back = ran(tick(w, [{ executorId: WORKER_EXECUTOR, absentSince: NOW + 5_000 }]));
    expect(back.executors).toEqual([{ executorId: WORKER_EXECUTOR, outcome: "unknown", reason: "clock_regressed" }]);
    expect(back.watch).toEqual([{ executorId: WORKER_EXECUTOR, absentSince: NOW + 5_000 }]);
    expect(w.calls).toEqual([]);
    expect(state(w.ledger, s.runId)).toBe("running");
  });

  test("같은 실행기의 기억이 둘이면 판정이 늦어지는 쪽으로 합친다", () => {
    const w = world();
    running(w);
    w.setClock(NOW + JUDGE + 10);
    const twice = [
      { executorId: WORKER_EXECUTOR, absentSince: NOW },
      { executorId: WORKER_EXECUTOR, absentSince: NOW + 20 },
    ];
    expect(ran(tick(w, twice)).executors).toEqual([{ executorId: WORKER_EXECUTOR, outcome: "within_judge", absentSince: NOW + 20 }]);
    // 연결을 본 기록(null)이 있으면 이번 박자에 처음 없음을 확인한 것이다.
    expect(ran(tick(w, [...twice, { executorId: WORKER_EXECUTOR, absentSince: null }])).executors).toEqual([{ executorId: WORKER_EXECUTOR, outcome: "within_judge", absentSince: NOW + JUDGE + 10 }]);
    expect(w.calls).toEqual([]);
  });

  test("정책·기억·시계·연결 표·실행 목록을 모르면 돌지 않고 아무것도 쓰지 않는다", () => {
    const w = world();
    const s = running(w);
    const past = [{ executorId: WORKER_EXECUTOR, absentSince: NOW }];
    w.setClock(NOW + JUDGE + 1);
    for (const policy of [{ judgeMs: limits.RUN_LEASE_MAX_MS - 1 }, { judgeMs: JUDGE + 0.5 }, {}, null]) {
      expect(tick(w, past, policy)).toEqual({ kind: "not_run", reason: "policy_rejected" });
    }
    for (const watch of [[{ executorId: WORKER_EXECUTOR, absentSince: 0 }], [{ executorId: "", absentSince: null }], [{ executorId: WORKER_EXECUTOR }]]) {
      expect(tick(w, watch as never)).toEqual({ kind: "not_run", reason: "input_malformed" });
    }
    expect(linkLossTick(w.ports, POLICY, {} as never)).toEqual({ kind: "not_run", reason: "input_malformed" });
    for (const clock of [() => 0, () => Number.NaN, () => { throw new Error("시계 실패"); }]) {
      w.setClock(clock);
      expect(tick(w, past)).toEqual({ kind: "not_run", reason: "clock_unavailable" });
    }
    w.setClock(NOW + JUDGE + 1);
    // 세대를 모르면 연결 표는 아무도 인정하지 않는다. 그것을 없음으로 읽지 않는다.
    w.setGeneration(null);
    expect(tick(w, past)).toEqual({ kind: "not_run", reason: "links_unknown" });
    w.setGeneration(0);
    const original = w.ports.connections;
    for (const occupancy of [() => { throw new Error("표 실패"); }, () => ({}), () => [{ executorId: 7 }]]) {
      (w.ports as { connections: unknown }).connections = { occupancy };
      expect(tick(w, past)).toEqual({ kind: "not_run", reason: "links_unknown" });
    }
    (w.ports as { connections: unknown }).connections = original;
    w.wrap({ listRuns: () => ({ known: false, reason: "io" }) });
    expect(tick(w, past)).toEqual({ kind: "not_run", reason: "read_unknown" });
    // 어느 실행기의 줄인지 모르는 줄이 하나라도 있으면 실행 목록 전체가 모름이다.
    w.wrap({ listRuns: () => ({ known: true, value: [row(WORKER_EXECUTOR), { ...row(WORKER_EXECUTOR), executorId: 7 }] }) as never });
    expect(tick(w, past)).toEqual({ kind: "not_run", reason: "read_unknown" });
    expect(w.calls).toEqual([]);
    expect(state(w.ledger, s.runId)).toBe("running");
  });
});

describe("보장 2: 그 실행기의 실행만, 정확한 이름으로", () => {
  test("끊긴 실행기의 실행만 옮기고 다른 실행기(이름이 비슷해도)의 진행 중 실행은 그대로다", () => {
    const w = world();
    const live = running(w);
    const other = must(w.ledger.admitRun(session())).run.runId;
    w.ledger.close();
    const raw = new Database(w.path);
    raw.query("UPDATE runs SET state = 'preparing' WHERE run_id = ?").run(other);
    raw.close();
    w.ledger = ready(open(w.path, { clock: () => NOW }));
    const ledger = w.ledger;
    w.wrap({ listRuns: () => ledger.listRuns(), markLostFor: (input) => ledger.markLostFor(input) });
    w.setLinked([NEAR_EXECUTOR]);
    w.setClock(NOW + JUDGE + 1);
    const result = ran(tick(w, [{ executorId: WORKER_EXECUTOR, absentSince: NOW }, { executorId: SESSION_EXECUTOR, absentSince: NOW }]));
    expect(result.executors.map((e) => [e.executorId, e.outcome])).toEqual([
      [WORKER_EXECUTOR, "moved"],
      [SESSION_EXECUTOR, "not_worker"],
    ]);
    expect(w.calls).toEqual([WORKER_EXECUTOR]);
    expect(state(ledger, live.runId)).toBe("unknown_running");
    expect(state(ledger, other)).toBe("preparing");
  });

  test("판정한 실행기마다 한 번씩 그 이름으로만 부른다", () => {
    const w = world();
    const third = "executor/diagnosis/2/store-d";
    w.wrap({
      listRuns: () => ({ known: true, value: [row(WORKER_EXECUTOR), row(WORKER_EXECUTOR, { state: "stopping" }), row(OTHER_EXECUTOR), row(third), row(NEAR_EXECUTOR, { state: "checking", stopReceiptId: id() })] }) as never,
      markLostFor: () => ({ ok: true, runs: [] }),
    });
    w.setLinked([OTHER_EXECUTOR]);
    w.setClock(NOW + JUDGE + 1);
    const result = ran(tick(w, [{ executorId: WORKER_EXECUTOR, absentSince: NOW }, { executorId: third, absentSince: NOW + 2 }, { executorId: NEAR_EXECUTOR, absentSince: NOW }]));
    // 종료 확인이 있는 실행만 쥔 실행기는 판정 대상이 아니다.
    expect(result.executors).toEqual([
      { executorId: WORKER_EXECUTOR, outcome: "moved", absentSince: NOW, at: NOW + JUDGE + 1, runs: [] },
      { executorId: OTHER_EXECUTOR, outcome: "linked" },
      { executorId: third, outcome: "within_judge", absentSince: NOW + 2 },
    ]);
    expect(w.calls).toEqual([WORKER_EXECUTOR]);
  });

  test("장부가 못 쓰면 옮김으로 세지 않고, 기억이 남아 다음 박자가 다시 부른다", () => {
    const w = world();
    const s = running(w);
    w.setClock(NOW + JUDGE + 1);
    const ledger = w.ledger;
    w.wrap({ listRuns: () => ledger.listRuns(), markLostFor: () => ({ ok: false, reason: "ledger_unwritable" }) });
    const failed = ran(tick(w, [{ executorId: WORKER_EXECUTOR, absentSince: NOW }]));
    expect(failed.executors).toEqual([{ executorId: WORKER_EXECUTOR, outcome: "ledger_failed", absentSince: NOW, reason: "ledger_unwritable" }]);
    expect(failed.watch).toEqual([{ executorId: WORKER_EXECUTOR, absentSince: NOW }]);
    expect(state(ledger, s.runId)).toBe("running");
    w.wrap({});
    const retried = ran(tick(w, [...failed.watch]));
    expect(retried.executors).toMatchObject([{ executorId: WORKER_EXECUTOR, outcome: "moved", runs: [{ runId: s.runId, after: "unknown_running" }] }]);
    expect(w.calls).toEqual([WORKER_EXECUTOR, WORKER_EXECUTOR]);
  });
});

function lifecycle(ledger: Ledger, runId: string, now: number): LifecycleView {
  const got = ledger.getRun(runId);
  const times = ledger.instructionTimes(runId);
  if (!got.known || got.value === null || !times.known || times.value === null) throw new Error("읽지 못함");
  const run = got.value;
  const lease = times.value.lease;
  return {
    run: { runId, kind: run.kind, state: run.state, deadlineAt: run.deadlineAt },
    lease: lease !== null && lease.expiresAt !== "unknown" ? { issuedAt: lease.issuedAt, expiresAt: lease.expiresAt } : null,
    cancelRequested: false,
    lastInstructionAt: run.state === "stopping" ? times.value.lastStopAt : times.value.lastFinalizeAt,
    resultSettled: false,
    now,
  };
}

describe("보장 3: 자리를 풀지 않고, 옮긴 실행을 돌려준다", () => {
  test("옮긴 뒤 같은 종류의 새 시작은 slot_busy이고, 실제 수명 판단은 믿은 임대가 남아도 갱신을 내지 않는다", () => {
    const w = world();
    const s = running(w);
    const renewedAt = NOW + LIFE.renewEveryMs;
    must(w.ledger.recordRenewInstruction({ runId: s.runId, requestId: id(), stopGeneration: 0, now: renewedAt }));
    const checkAt = renewedAt + LIFE.renewEveryMs;
    expect(checkAt + RENEW_MARGIN_MS).toBeLessThanOrEqual(renewedAt + limits.RUN_LEASE_MAX_MS);
    // 대조군: 옮기기 전에는 같은 시각에 갱신이다.
    expect(nextIntent(lifecycle(w.ledger, s.runId, checkAt), LIFE).intent).toBe("renew_lease");

    w.setClock(checkAt);
    const result = ran(tick(w, [{ executorId: WORKER_EXECUTOR, absentSince: checkAt - JUDGE - 1 }]));
    expect(result.executors).toMatchObject([{ outcome: "moved", runs: [{ runId: s.runId, before: "running", after: "unknown_running" }] }]);

    const next = must(w.ledger.admitRun(worker({ executorId: OTHER_EXECUTOR }))).run;
    expect(w.ledger.slotFree("worker")).toEqual({ known: true, value: false });
    expect(w.ledger.startRun({ runId: next.runId, requestId: id(), stopGeneration: 0, now: checkAt })).toEqual({ ok: false, reason: "slot_busy" });
    expect(nextIntent(lifecycle(w.ledger, s.runId, checkAt), LIFE).intent).toBe("query");
    expect(w.ledger.recordRenewInstruction({ runId: s.runId, requestId: id(), stopGeneration: 0, now: checkAt })).toEqual({ ok: false, reason: "transition_denied" });
  });

  test("다시 불러도 이미 옮긴 실행은 없고 끝난 상태로 옮기지 않는다", () => {
    const w = world();
    const s = running(w);
    w.setClock(NOW + JUDGE + 1);
    const watch = [{ executorId: WORKER_EXECUTOR, absentSince: NOW }];
    ran(tick(w, watch));
    const ledger = w.ledger;
    w.wrap({ listRuns: () => ({ known: true, value: [row(WORKER_EXECUTOR)] }) as never, markLostFor: (input) => ledger.markLostFor(input) });
    expect(ran(tick(w, watch)).executors).toEqual([{ executorId: WORKER_EXECUTOR, outcome: "moved", absentSince: NOW, at: NOW + JUDGE + 1, runs: [] }]);
    expect(state(ledger, s.runId)).toBe("unknown_running");
  });
});

describe("보장 4: 모르면 옮기지 않고, 실패는 결과를 지우지 않는다", () => {
  test("그 실행기의 줄의 꼴이 틀리면 그 실행기만 판정하지 않는다", () => {
    const w = world();
    w.wrap({
      listRuns: () =>
        ({
          known: true,
          value: [row(WORKER_EXECUTOR), row(WORKER_EXECUTOR, { state: "bogus" }), row(OTHER_EXECUTOR), row(NEAR_EXECUTOR, { kind: "session" }), row(SESSION_EXECUTOR, { kind: "worker" })],
        }) as never,
      markLostFor: () => ({ ok: true, runs: [] }),
    });
    w.setClock(NOW + JUDGE + 1);
    const watch = [WORKER_EXECUTOR, OTHER_EXECUTOR, NEAR_EXECUTOR, SESSION_EXECUTOR].map((executorId) => ({ executorId, absentSince: NOW }));
    expect(ran(tick(w, watch)).executors).toEqual([
      { executorId: WORKER_EXECUTOR, outcome: "unknown", reason: "read_unknown" },
      { executorId: NEAR_EXECUTOR, outcome: "unknown", reason: "read_unknown" },
      { executorId: OTHER_EXECUTOR, outcome: "moved", absentSince: NOW, at: NOW + JUDGE + 1, runs: [] },
      { executorId: SESSION_EXECUTOR, outcome: "unknown", reason: "read_unknown" },
    ]);
    expect(w.calls).toEqual([OTHER_EXECUTOR]);
  });

  test("한 실행기의 장부 실패는 그 실행기의 결과이고 다음 실행기를 본다", () => {
    const w = world();
    const answers: Record<string, () => unknown> = {
      [WORKER_EXECUTOR]: () => {
        throw new Error("쓰기 실패");
      },
      [NEAR_EXECUTOR]: () => ({ ok: true, runs: [{ runId: "x", runGeneration: 1, before: "running", after: "unknown_running" }] }),
      [OTHER_EXECUTOR]: () => ({ ok: false, reason: "nope" }),
      "executor/diagnosis/3/store-e": () => ({ ok: "yes" }),
      "executor/diagnosis/4/store-f": () => ({ ok: true, runs: [{ runId: id(), runGeneration: 2, before: "running", after: "unknown_running" }] }),
    };
    const names = Object.keys(answers);
    w.wrap({ listRuns: () => ({ known: true, value: names.map((n) => row(n)) }) as never, markLostFor: ((input: { executorId: string }) => answers[input.executorId]!()) as never });
    w.setClock(NOW + JUDGE + 1);
    const result = ran(tick(w, names.map((executorId) => ({ executorId, absentSince: NOW }))));
    expect(result.halted).toBeNull();
    expect(result.executors.map((e) => [e.executorId, e.outcome, "reason" in e ? e.reason : null])).toEqual([
      [WORKER_EXECUTOR, "ledger_failed", "threw"],
      [NEAR_EXECUTOR, "ledger_failed", "malformed_answer"],
      [OTHER_EXECUTOR, "ledger_failed", "malformed_answer"],
      ["executor/diagnosis/3/store-e", "ledger_failed", "malformed_answer"],
      ["executor/diagnosis/4/store-f", "moved", null],
    ]);
    expect(w.calls).toEqual(names);
  });

  test("장부 답을 읽다 던지면 그 항목까지 싣고 halted로 멈추며 기억은 온전하다", () => {
    const w = world();
    const names = [WORKER_EXECUTOR, OTHER_EXECUTOR];
    w.wrap({
      listRuns: () => ({ known: true, value: names.map((n) => row(n)) }) as never,
      markLostFor: () =>
        ({
          get ok(): boolean {
            throw new Error("답 실패");
          },
        }) as never,
    });
    w.setClock(NOW + JUDGE + 1);
    const result = ran(tick(w, names.map((executorId) => ({ executorId, absentSince: NOW }))));
    expect(result).toEqual({
      kind: "ran",
      executors: [{ executorId: WORKER_EXECUTOR, outcome: "ledger_failed", absentSince: NOW, reason: "malformed_answer" }],
      watch: names.map((executorId) => ({ executorId, absentSince: NOW })).sort((a, b) => a.executorId.localeCompare(b.executorId)),
      halted: "threw",
      haltedAt: WORKER_EXECUTOR,
    });
    expect(w.calls).toEqual([WORKER_EXECUTOR]);
  });

  test("포트 안에서 다시 부른 박자는 읽기·쓰기 없이 돌아온다", () => {
    const w = world();
    const inner: LinkLossTickResult[] = [];
    w.wrap({
      listRuns: () => ({ known: true, value: [row(WORKER_EXECUTOR)] }) as never,
      markLostFor: () => {
        inner.push(tick(w, [{ executorId: WORKER_EXECUTOR, absentSince: NOW }]));
        return { ok: true, runs: [] };
      },
    });
    w.setClock(NOW + JUDGE + 1);
    expect(ran(tick(w, [{ executorId: WORKER_EXECUTOR, absentSince: NOW }])).executors).toMatchObject([{ outcome: "moved" }]);
    expect(inner).toEqual([{ kind: "not_run", reason: "tick_in_progress" }]);
    expect(w.calls).toEqual([WORKER_EXECUTOR]);
  });
});

test("이 모듈은 시계·소켓·타이머를 직접 부르지 않고 markLost(전부 옮기기)를 부르지 않는다", async () => {
  const source = await Bun.file(new URL("../../../src/supervisor/dispatch/link-loss.ts", import.meta.url)).text();
  for (const banned of ["Date.now", "new Date", "performance.now", "Math.random", "setTimeout", "setInterval", "node:", "bun:", "Bun.", "process.", "markLost(", "await "]) {
    expect(source).not.toContain(banned);
  }
});
