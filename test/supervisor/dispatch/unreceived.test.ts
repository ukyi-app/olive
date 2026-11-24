// D-90 자동 닫기 박자(src/supervisor/dispatch/unreceived.ts). 장부는 임시 폴더의 실제 장부이고 공개 함수로만 준비한다. 증거·연결·맡기지 않을
// 실행기·정지 세대·복원 대기는 가짜 포트다. 장부의 closeUnreceivedRun은 감싸서 부른 횟수와 넘긴 값을 센다.
// "모름 표"의 줄 번호는 unreceived.md "모름으로 닫히는 입력"의 번호다.
import { describe, expect, test } from "bun:test";
import type { Ledger, UnreceivedClosureInput } from "../../../src/ledger/index.ts";
import type {
  UnreceivedEvidenceRead,
  UnreceivedFull,
  UnreceivedOutcome,
  UnreceivedPorts,
  UnreceivedRehelloResult,
  UnreceivedRehelloSkip,
  UnreceivedSkip,
  UnreceivedTickResult,
} from "../../../src/supervisor/dispatch/unreceived.ts";
import { createRehelloMemory, REHELLO_AFTER_MS, UNRECEIVED_ANSWER_AFTER_MS, unreceivedTick } from "../../../src/supervisor/dispatch/unreceived.ts";
import { type CycleBeats, createCycle } from "../../../src/supervisor/runtime/cycle.ts";
import { createSharedClock } from "../../../src/supervisor/runtime/shared-clock.ts";
import { readText } from "../../files.ts";
import { digest, id, must, NOW, open, ready, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";

// 시험이 고른 값이다. 시험의 장부 시계는 늘 NOW라 시작 지시의 발행 시각도 NOW다.
const CONN = 7;
const OTHER_CONN = 8;
const AT = NOW + 30_010;
const OTHER_EXECUTOR = "executor/diagnosis/1/store-b";

type Ran = Extract<UnreceivedTickResult, { kind: "ran" }>;
const ran = (result: UnreceivedTickResult): Ran => {
  if (result.kind !== "ran") throw new Error(`ran이 아니다: ${JSON.stringify(result)}`);
  return result;
};

function full(overrides: Partial<UnreceivedFull> = {}): UnreceivedFull {
  return { connection: CONN, principal: WORKER_EXECUTOR, stopGeneration: 0, runs: [], answeredAt: NOW + 30_000, receivedAt: NOW + 30_005, ...overrides };
}

// 시작 지시까지 적고(발행 = NOW) 그 열기의 송신 표식을 남긴 작업자 실행.
function started(ledger: Ledger, executorId = WORKER_EXECUTOR) {
  const runId = must(ledger.admitRun(worker({ executorId }))).run.runId;
  const requestId = id();
  must(ledger.startRun({ runId, requestId, stopGeneration: 0, now: NOW }));
  must(ledger.markStartDispatch({ runId, requestId, now: NOW }));
  return { runId, requestId };
}

// 장부에 없는 실행의 시작 지시 항목(장부 읽기의 꼴).
function ghost(executorId = WORKER_EXECUTOR) {
  return { requestId: id(), action: "task_start", runId: id(), runGeneration: 1, executorId, runState: "preparing", stopGeneration: 0, issuedAt: NOW, rebuild: null };
}

function world(path = tempPath()) {
  const ledger = ready(open(path));
  const calls: UnreceivedClosureInput[] = [];
  const state = {
    evidence: (_executorId: string): UnreceivedEvidenceRead => ({ known: true, tainted: false, pending: false, version: 0, lastFull: full() }),
    current: (connection: number, executorId: string): boolean => connection === CONN && executorId === WORKER_EXECUTOR,
    // 가짜 답 줄의 변경 번호. 증거를 읽은 뒤 늘면 confirm이 evidence_changed를 낸다.
    version: 0,
    // 증거 포트의 confirm. 계약의 차례대로 연결 → 정지 세대 → 변경 번호를 본다.
    confirm: (executorId: string, connection: number, version: number, generation: number): unknown => {
      if (!state.current(connection, executorId)) return "link_not_current";
      if (state.generation() !== generation) return "stop_generation";
      return version === state.version ? "current" : "evidence_changed";
    },
    withheld: (): unknown => ({ known: true, value: [] }),
    generation: (): unknown => 0,
    settled: (): unknown => true,
    // 작업자 자리가 하나라 실제 장부에는 닫을 수 있는 실행이 하나뿐이다. 후보 둘이 드는 사례는 실제 읽기 앞뒤에 가짜 항목을 붙인다
    // (가짜 실행은 장부에 없어 불리면 unknown_run이고, 부른 횟수로 드러난다).
    before: [] as unknown[],
    after: [] as unknown[],
    unanswered: (): unknown => {
      const read = ledger.unansweredInstructions();
      if (!read.known) return read;
      return { known: true, value: { stopGeneration: read.value.stopGeneration, instructions: [...state.before, ...read.value.instructions, ...state.after] } };
    },
    // closeUnreceivedRun을 부를 때 장부보다 먼저 부를 일.
    onClose: null as (() => void) | null,
    // 장부 대신 돌려줄 답. 함수가 던지면 장부 호출이 던진 것이다.
    closeAnswer: null as (() => unknown) | null,
  };
  const ports = {
    ledger: {
      unansweredInstructions: () => state.unanswered(),
      closeUnreceivedRun(input: UnreceivedClosureInput, from: { sender: string }) {
        calls.push(input);
        state.onClose?.();
        if (state.closeAnswer !== null) return state.closeAnswer();
        return ledger.closeUnreceivedRun(input, from);
      },
    },
    evidence: {
      read: (executorId: string) => state.evidence(executorId),
      confirm: (executorId: string, connection: number, version: number, generation: number) => state.confirm(executorId, connection, version, generation),
    },
    withheld: { executors: () => state.withheld() },
    intake: { stopGeneration: () => state.generation() },
    observationsSettled: () => state.settled(),
  } as unknown as UnreceivedPorts;
  const stateOf = (runId: string) => {
    const read = ledger.getRun(runId);
    if (!read.known || read.value === null) throw new Error("실행 없음");
    return read.value.state;
  };
  return { path, ledger, calls, state, ports, stateOf, tick: (now = AT) => unreceivedTick(ports, now) };
}

const skipped = (live: { runId: string; requestId: string }, reason: UnreceivedSkip, executorId = WORKER_EXECUTOR): UnreceivedOutcome => ({
  requestId: live.requestId,
  runId: live.runId,
  executorId,
  outcome: "skipped",
  reason,
});

describe("모름 표", () => {
  test("#1 서명 시각 = 발행 + 29,999면 장부를 부르지 않는다(장부도 같은 경계에서 answer_too_early)", () => {
    const w = world();
    const live = started(w.ledger);
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: full({ answeredAt: NOW + 29_999 }) });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "answer_too_early")]);
    expect([w.calls.length, w.stateOf(live.runId)]).toEqual([0, "preparing"]);
    // 미리 거르는 값이 장부의 경계와 같다: 장부에 직접 넘겨도 같은 값에서 거절한다.
    expect(UNRECEIVED_ANSWER_AFTER_MS).toBe(30_000);
    expect(w.ledger.closeUnreceivedRun({ runId: live.runId, runs: [], answeredAt: NOW + 29_999, receivedAt: NOW + 30_005, now: AT }, { sender: WORKER_EXECUTOR })).toEqual({
      ok: false,
      reason: "answer_too_early",
    });
  });

  test("#2 서명 시각 = 발행 + 30,000(정각)이면 한 번 불러 닫고, 장부에는 서명 시각과 받은 시각을 제 칸에 넘긴다", () => {
    const w = world();
    const live = started(w.ledger);
    const closed: UnreceivedOutcome = { requestId: live.requestId, runId: live.runId, executorId: WORKER_EXECUTOR, outcome: "closed", connection: CONN, answeredAt: NOW + 30_000, at: AT };
    expect(ran(w.tick()).runs).toEqual([closed]);
    expect(w.calls).toEqual([{ runId: live.runId, runs: [], answeredAt: NOW + 30_000, receivedAt: NOW + 30_005, now: AT }]);
    expect(w.stateOf(live.runId)).toBe("not_started");
    // 닫힌 실행은 다음 박자의 후보가 아니다.
    expect(ran(w.tick()).runs).toEqual([]);
    expect(w.calls.length).toBe(1);
  });

  test("#3 연결의 인사가 시작 발행보다 이르고 연결이 계속 살면 닫지 않는다(새 인사가 와야 한다)", () => {
    const w = world();
    const live = started(w.ledger);
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: full({ answeredAt: NOW - 5_000, receivedAt: NOW + 60_000 }) });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "answer_too_early")]);
    expect(ran(w.tick(NOW + 120_000)).runs).toEqual([skipped(live, "answer_too_early")]);
    expect([w.calls.length, w.stateOf(live.runId)]).toEqual([0, "preparing"]);
  });

  test("#4 박자 처음의 시계가 후퇴·읽지 못함이면 순서기가 박자를 부르지 않아 장부도 0회, 돌아오면 같은 증거로 닫는다", async () => {
    const w = world();
    const live = started(w.ledger);
    const source = { wall: NOW + 40_000 as number };
    const shared = createSharedClock({ now: () => source.wall });
    const beats: CycleBeats = {
      linkLoss: () => ({ kind: "ran", executors: [], watch: [], halted: null, haltedAt: null }),
      life: async () => ({ kind: "ran", runs: [], pendingQueries: [], halted: null, haltedAt: null }),
      resend: async () => ({ kind: "ran", instructions: [], halted: null, haltedAt: null }),
      unreceived: (now) => unreceivedTick(w.ports, now),
      assign: async () => ({ kind: "ran", starts: [], requests: [], halted: null, haltedAt: null }),
    };
    const cycle = createCycle({
      beats,
      serverTick: () => {},
      ledgerClock: shared,
      monotonic: { now: () => 1 },
      restoreDone: () => true,
      ledger: w.ledger,
      policy: { judgeMs: 30_000, resendEveryMs: 5_000, assignCallsPerBeat: 1 },
    });
    expect(shared.read()).toEqual({ state: "ok", at: NOW + 40_000 });
    source.wall = NOW + 39_000;
    const regressed = await cycle.beat();
    expect(regressed.kind === "ran" ? [regressed.clock, regressed.unreceived] : regressed).toEqual(["regressed", { kind: "skipped", reason: "clock_untrusted" }]);
    source.wall = Number.NaN;
    const blind = await cycle.beat();
    expect(blind.kind === "ran" ? [blind.clock, blind.unreceived] : blind).toEqual(["unavailable", { kind: "skipped", reason: "clock_untrusted" }]);
    expect([w.calls.length, w.stateOf(live.runId)]).toEqual([0, "preparing"]);
    // 대조군: 시계가 하한으로 돌아오면 같은 증거로 닫는다(묶음이 실제로 장부에 닿는다).
    source.wall = NOW + 40_000;
    const back = await cycle.beat();
    expect(back.kind === "ran" && back.unreceived.kind === "returned" ? ran(back.unreceived.result).runs.map((item) => item.outcome) : back).toEqual(["closed"]);
    expect([w.calls.length, w.calls[0]?.now, w.stateOf(live.runId)]).toEqual([1, NOW + 40_000, "not_started"]);
  });

  test("#5 증거를 읽은 뒤 장부를 부르기 직전의 재확인이 거짓·던짐이면 0회다. 증거·맡기지 않을 실행기 포트 안에서 철회돼도 같다", () => {
    for (const [name, arrange] of [
      ["거짓", (w: ReturnType<typeof world>) => (w.state.current = () => false)],
      [
        "던짐",
        (w: ReturnType<typeof world>) =>
          (w.state.current = () => {
            throw new Error("연결 표 읽기 실패");
          }),
      ],
      [
        "증거 읽기 안에서 철회",
        (w: ReturnType<typeof world>) => {
          w.state.evidence = () => {
            w.state.current = () => false;
            return { known: true, tainted: false, pending: false, version: 0, lastFull: full() };
          };
        },
      ],
      [
        "맡기지 않을 실행기 읽기 안에서 철회",
        (w: ReturnType<typeof world>) => {
          w.state.withheld = () => {
            w.state.current = () => false;
            return { known: true, value: [] };
          };
        },
      ],
    ] as const) {
      const w = world();
      const live = started(w.ledger);
      arrange(w);
      expect([name, ran(w.tick()).runs]).toEqual([name, [skipped(live, "link_not_current")]]);
      expect([name, w.calls.length, w.stateOf(live.runId)]).toEqual([name, 0, "preparing"]);
    }
  });

  test("#6 앞 실행의 장부 쓰기 도중 연결이 철회되면 같은 실행기의 다음 실행은 다시 확인해 0회다", () => {
    const w = world();
    const first = started(w.ledger);
    const second = ghost();
    w.state.after = [second];
    w.state.onClose = () => {
      w.state.current = () => false;
    };
    const result = ran(w.tick());
    expect(result.runs.map((item) => [item.outcome, "runId" in item ? item.runId : null, "reason" in item ? item.reason : null])).toEqual([
      ["closed", first.runId, null],
      ["skipped", second.runId, "link_not_current"],
    ]);
    expect([w.calls.map((call) => call.runId), w.stateOf(first.runId)]).toEqual([[first.runId], "not_started"]);
    // 대조군: 철회가 없으면 둘째 항목도 장부까지 간다(가짜 실행이라 장부가 unknown_run으로 거절한다).
    const control = world();
    started(control.ledger);
    control.state.after = [ghost()];
    expect(ran(control.tick()).runs.map((item) => [item.outcome, "reason" in item ? item.reason : null])).toEqual([
      ["closed", null],
      ["refused", "unknown_run"],
    ]);
    expect(control.calls.length).toBe(2);
  });

  test("#7 증거의 연결이 지금 인정된 연결과 다르면(옛 연결의 applied·retry 성공) 0회다", () => {
    const w = world();
    const live = started(w.ledger);
    w.state.current = (connection, executorId) => connection === OTHER_CONN && executorId === WORKER_EXECUTOR;
    expect(ran(w.tick()).runs).toEqual([skipped(live, "link_not_current")]);
    expect(w.calls.length).toBe(0);
  });

  test("#8 그 실행기의 앞선 인사·상태 보고가 버려졌으면(tainted) 0회다", () => {
    const w = world();
    const live = started(w.ledger);
    w.state.evidence = () => ({ known: true, tainted: true, pending: false, version: 0, lastFull: full() });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "tainted")]);
    expect(w.calls.length).toBe(0);
  });

  test("#9 그 실행기 줄에 held 인사·retry·밀린 사본이 남았으면(pending) 0회다", () => {
    const w = world();
    const live = started(w.ledger);
    w.state.evidence = () => ({ known: true, tainted: false, pending: true, version: 0, lastFull: full() });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "pending")]);
    expect(w.calls.length).toBe(0);
  });

  test("#10 서버를 새로 만들어 옛 밀린 사본을 버린 실행기는 증거가 오염으로 내고 0회다(이 모듈이 보는 칸은 #8과 같다)", () => {
    const w = world();
    const live = started(w.ledger);
    // 새 서버의 첫 인사가 빈 전체 목록이어도 버린 사본이 있었으면 오염이다.
    w.state.evidence = () => ({ known: true, tainted: true, pending: false, version: 0, lastFull: full({ connection: CONN }) });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "tainted")]);
    expect(w.calls.length).toBe(0);
  });

  test("#11 맡기지 않을 실행기에 들었거나 그 집합을 모르면 0회다(모름은 박자 전체를 부르지 않는다)", () => {
    const w = world();
    const live = started(w.ledger);
    w.state.withheld = () => ({ known: true, value: [WORKER_EXECUTOR] });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "withheld")]);
    for (const answer of [{ known: false }, { known: true, value: ["supervisor"] }, { known: true, value: [""] }, { known: true }, null]) {
      w.state.withheld = () => answer;
      expect([answer, w.tick()]).toEqual([answer, { kind: "not_run", reason: "withheld_unknown" }]);
    }
    w.state.withheld = () => {
      throw new Error("답 줄 고장");
    };
    expect(w.tick()).toEqual({ kind: "not_run", reason: "withheld_unknown" });
    expect([w.calls.length, w.stateOf(live.runId)]).toEqual([0, "preparing"]);
  });

  test("#12 복원이 붙든 관측을 적기 전(observationsSettled가 참이 아님)이면 0회다. 박자 중에 거짓이 되면 그 자리에서 멈춘다", () => {
    const w = world();
    const first = started(w.ledger);
    const second = ghost();
    w.state.after = [second];
    for (const value of [false, undefined, 1]) {
      w.state.settled = () => value;
      expect([value, w.tick()]).toEqual([value, { kind: "not_run", reason: "observations_unsettled" }]);
    }
    w.state.settled = () => {
      throw new Error("신호 읽기 실패");
    };
    expect(w.tick()).toEqual({ kind: "not_run", reason: "observations_unsettled" });
    expect(w.calls.length).toBe(0);
    // 첫 실행을 닫는 쓰기 안에서 신호가 거짓이 되면 둘째 실행은 장부를 부르지 않는다.
    w.state.settled = () => true;
    w.state.onClose = () => {
      w.state.settled = () => false;
    };
    const result = ran(w.tick());
    expect([result.runs.map((item) => item.outcome), result.halted, result.haltedAt]).toEqual([["closed"], "observations_unsettled", second.requestId]);
    expect(w.calls.map((call) => call.runId)).toEqual([first.runId]);
  });

  test("#13 인사가 맞춘 세대가 지금 세대와 다르거나, 지금 세대를 모르거나, 복원기와 장부의 세대가 다르면 0회다", () => {
    const w = world();
    const live = started(w.ledger);
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: full({ stopGeneration: 1 }) });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "stop_generation")]);
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: full() });
    for (const value of [null, undefined, -1, 0.5]) {
      w.state.generation = () => value;
      expect([value, w.tick()]).toEqual([value, { kind: "not_run", reason: "stop_generation_unknown" }]);
    }
    w.state.generation = () => {
      throw new Error("복원기 없음");
    };
    expect(w.tick()).toEqual({ kind: "not_run", reason: "stop_generation_unknown" });
    // 복원기는 1인데 장부의 지금 정지 세대는 0이다(정지·복원이 바뀌는 중).
    w.state.generation = () => 1;
    expect(w.tick()).toEqual({ kind: "not_run", reason: "stop_generation_mismatch" });
    expect([w.calls.length, w.stateOf(live.runId)]).toEqual([0, "preparing"]);
  });

  test("#14 증거의 전체 목록에 그 실행이 있으면 0회다", () => {
    const w = world();
    const live = started(w.ledger);
    const runs = [{ run_id: live.runId, run_generation: 1, state: "preparing", last_receipt_id: null }] as unknown as UnreceivedFull["runs"];
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: full({ runs }) });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "run_in_answer")]);
    expect(w.calls.length).toBe(0);
  });

  test("#15 증거 읽기가 던지거나 꼴이 틀리면 그 항목은 0회, 장부 읽기가 모름이면 박자 전체가 read_unknown이다", () => {
    const w = world();
    const live = started(w.ledger);
    const broken: (() => unknown)[] = [
      () => {
        throw new Error("답 줄 고장");
      },
      () => ({ known: false }),
      () => null,
      () => ({ known: true, pending: false, version: 0, lastFull: full() }),
      () => ({ known: true, tainted: "no", pending: false, version: 0, lastFull: full() }),
      () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: { ...full(), runs: "none" } }),
      () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: { ...full(), runs: [null] } }),
      () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: { ...full(), answeredAt: 0 } }),
      () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: { ...full(), answeredAt: null } }),
      () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: { ...full(), receivedAt: Number.NaN } }),
      () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: { ...full(), connection: -1 } }),
      () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: { ...full(), principal: undefined } }),
      () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: "full" }),
      () => ({ known: true, tainted: false, pending: false, lastFull: full() }),
      () => ({ known: true, tainted: false, pending: false, version: -1, lastFull: full() }),
    ];
    for (const [index, read] of broken.entries()) {
      w.state.evidence = read as () => UnreceivedEvidenceRead;
      expect([index, ran(w.tick()).runs]).toEqual([index, [skipped(live, "evidence_unknown")]]);
    }
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: null });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "no_full")]);
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: full({ principal: OTHER_EXECUTOR }) });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "principal_mismatch")]);
    for (const answer of [{ known: false, reason: "unwritable" }, { known: true, value: { stopGeneration: 0 } }, { known: true, value: { stopGeneration: 0.5, instructions: [] } }, null]) {
      w.state.unanswered = () => answer;
      expect([answer, w.tick()]).toEqual([answer, { kind: "not_run", reason: "read_unknown" }]);
    }
    w.state.unanswered = () => {
      throw new Error("장부 읽기 실패");
    };
    expect(w.tick()).toEqual({ kind: "not_run", reason: "read_unknown" });
    expect([w.calls.length, w.stateOf(live.runId)]).toEqual([0, "preparing"]);
  });

  test("#16 장부가 던지거나 답이 정의 밖이면 ledger_failed이고 문구를 싣지 않으며 박자를 멈춘다. 장부의 거절은 그 이름 그대로다", () => {
    for (const [name, answer, reason] of [
      [
        "던짐",
        () => {
          throw new Error("비밀 문구");
        },
        "threw",
      ],
      ["ok 아님", () => ({ ok: "yes" }), "malformed_answer"],
      ["모르는 거절", () => ({ ok: false, reason: "made_up" }), "malformed_answer"],
      ["다른 실행", () => ({ ok: true, run: { runId: id(), state: "not_started" } }), "malformed_answer"],
      ["닫히지 않은 상태", () => ({ ok: true, run: { runId: "same", state: "preparing" } }), "malformed_answer"],
    ] as const) {
      const w = world();
      const first = started(w.ledger);
      w.state.after = [ghost()];
      w.state.closeAnswer = name === "닫히지 않은 상태" ? () => ({ ok: true, run: { runId: first.runId, state: "preparing" } }) : answer;
      const result = ran(w.tick());
      const failed: UnreceivedOutcome = { requestId: first.requestId, runId: first.runId, executorId: WORKER_EXECUTOR, outcome: "ledger_failed", reason };
      expect([name, result.runs, result.halted, result.haltedAt] as unknown[]).toEqual([name, [failed], "threw", first.requestId]);
      expect([name, w.calls.length]).toEqual([name, 1]);
    }
    // 실제 장부의 거절: 다른 열기가 이 실행의 시작을 실었다(sent_by_other_open). 장부는 한 번 불렀고 상태는 그대로다.
    const path = tempPath();
    const before = ready(open(path));
    const live = started(before);
    before.close();
    const w = world(path);
    const refused: UnreceivedOutcome = { requestId: live.requestId, runId: live.runId, executorId: WORKER_EXECUTOR, outcome: "refused", reason: "sent_by_other_open" };
    expect(ran(w.tick()).runs).toEqual([refused]);
    expect([w.calls.length, w.stateOf(live.runId)]).toEqual([1, "preparing"]);
  });

  test("#17 세션·queued·running 실행은 후보가 아니다(장부 읽기에 없고, 있다고 읽혀도 부르지 않는다)", () => {
    const w = world();
    must(w.ledger.admitRun(worker()));
    must(w.ledger.admitRun({ ...worker(), kind: "session", role: null, snapshotDigest: null, executorId: "executor/session/0/store-s" }));
    const running = started(w.ledger);
    must(
      w.ledger.applyReceipt(
        { action: "receipt_started", receiptId: id(), runId: running.runId, instructionRequestId: running.requestId, bodyDigest: digest("started"), now: NOW + 1 },
        { sender: WORKER_EXECUTOR, runGeneration: 1 },
      ),
    );
    expect(w.stateOf(running.runId)).toBe("running");
    expect(ran(w.tick()).runs).toEqual([]);
    // 읽기가 틀리게 내도 이 모듈이 거른다: 닫을 수 없는 상태와 작업자 실행기가 아닌 이름.
    const item = { requestId: running.requestId, action: "task_start", runId: running.runId, runGeneration: 1, executorId: WORKER_EXECUTOR, runState: "running", stopGeneration: 0, issuedAt: NOW, rebuild: null };
    w.state.unanswered = () => ({
      known: true,
      value: { stopGeneration: 0, instructions: [item, { ...item, runState: "preparing", executorId: "executor/session/0/store-s" }, { ...item, action: "session_start" }] },
    });
    expect(ran(w.tick()).runs).toEqual([skipped(running, "run_state"), skipped(running, "not_worker", "executor/session/0/store-s")]);
    expect(w.calls.length).toBe(0);
  });

  test("#18 받은 시각은 서명 시각 대신 쓰지 않는다: 받은 시각이 늦어도 서명 시각이 이르면 0회다", () => {
    const w = world();
    const live = started(w.ledger);
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: full({ answeredAt: NOW + 29_999, receivedAt: NOW + 90_000 }) });
    expect(ran(w.tick(NOW + 90_010)).runs).toEqual([skipped(live, "answer_too_early")]);
    expect([w.calls.length, w.stateOf(live.runId)]).toEqual([0, "preparing"]);
  });
});

describe("판단의 테두리", () => {
  test("지시를 적을 때의 세대가 지금 세대와 다르면 0회다", () => {
    const w = world();
    const live = started(w.ledger);
    const read = w.ledger.unansweredInstructions();
    if (!read.known) throw new Error("읽지 못함");
    w.state.unanswered = () => ({ known: true, value: { stopGeneration: 0, instructions: read.value.instructions.map((item) => ({ ...item, stopGeneration: 1 })) } });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "stop_generation")]);
    expect(w.calls.length).toBe(0);
  });

  test("한 실행기의 모름은 다른 실행기의 닫기를 막지 않는다", () => {
    const w = world();
    const other = ghost(OTHER_EXECUTOR);
    w.state.before = [other];
    const live = started(w.ledger);
    w.state.evidence = (executorId) =>
      executorId === OTHER_EXECUTOR ? { known: false } : { known: true, tainted: false, pending: false, version: 0, lastFull: full() };
    expect(ran(w.tick()).runs.map((item) => [item.outcome, "runId" in item ? item.runId : null])).toEqual([
      ["skipped", other.runId],
      ["closed", live.runId],
    ]);
    expect(w.calls.map((call) => call.runId)).toEqual([live.runId]);
  });

  test("연결 재확인이 증거 목록을 고쳐도 장부에는 읽은 그대로 넘긴다", () => {
    const w = world();
    const live = started(w.ledger);
    const runs: { run_id: string }[] = [];
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: full({ runs: runs as unknown as UnreceivedFull["runs"] }) });
    w.state.current = () => {
      runs.push({ run_id: "late" });
      return true;
    };
    expect(ran(w.tick()).runs.map((item) => item.outcome)).toEqual(["closed"]);
    expect(w.calls[0]?.runs).toEqual([]);
    expect(w.stateOf(live.runId)).toBe("not_started");
  });

  test("now가 양의 안전 정수가 아니면 부르지 않고, 포트 안에서 다시 부르면 tick_in_progress다", () => {
    const w = world();
    started(w.ledger);
    for (const now of [0, -1, Number.NaN, 1.5]) expect([now, w.tick(now)]).toEqual([now, { kind: "not_run", reason: "now_malformed" }]);
    const inner: UnreceivedTickResult[] = [];
    w.state.evidence = () => {
      inner.push(unreceivedTick(w.ports, AT));
      return { known: false };
    };
    w.tick();
    expect(inner).toEqual([{ kind: "not_run", reason: "tick_in_progress" }]);
    expect(w.calls.length).toBe(0);
  });

  test("포트를 꺼내는 접근자 안에서 박자를 다시 부르면 안쪽은 tick_in_progress이고 바깥 박자가 닫는다(장부 객체를 얻는 접근자 포함)", () => {
    for (const key of ["ledger", "evidence", "withheld", "intake", "observationsSettled"] as const) {
      const w = world();
      const live = started(w.ledger);
      const base = w.ports as unknown as Record<string, unknown>;
      const ports = { ...base };
      const inner: UnreceivedTickResult[] = [];
      Object.defineProperty(ports, key, {
        get() {
          inner.push(unreceivedTick(w.ports, AT));
          return base[key];
        },
      });
      const outer = ran(unreceivedTick(ports as unknown as UnreceivedPorts, AT));
      expect([key, inner, outer.runs.map((item) => item.outcome), w.calls.length, w.stateOf(live.runId)]).toEqual([
        key,
        [{ kind: "not_run", reason: "tick_in_progress" }],
        ["closed"],
        1,
        "not_started",
      ]);
    }
    // 진행 표시는 장부 객체가 아니라 이 모듈의 박자 단위다: 다른 장부의 포트로 부른 안쪽 박자도 돌지 않는다.
    const w = world();
    const other = world();
    const otherRun = started(other.ledger);
    started(w.ledger);
    const inner: UnreceivedTickResult[] = [];
    w.state.withheld = () => {
      inner.push(unreceivedTick(other.ports, AT));
      return { known: true, value: [] };
    };
    expect(ran(w.tick()).runs.map((item) => item.outcome)).toEqual(["closed"]);
    expect([inner, other.calls.length, other.stateOf(otherRun.runId)]).toEqual([
      [
        { kind: "not_run", reason: "tick_in_progress" },
        { kind: "not_run", reason: "tick_in_progress" },
      ],
      0,
      "preparing",
    ]);
  });
});

// 박자가 쓰는 시계로 순서기를 한 번 돌리고, 같은 박자의 배정이 본 작업자 자리를 함께 돌려준다.
async function beatWithAssign(w: ReturnType<typeof world>) {
  const shared = createSharedClock({ now: () => AT });
  let freeAtAssign: boolean | null = null;
  const cycle = createCycle({
    beats: {
      linkLoss: () => ({ kind: "ran", executors: [], watch: [], halted: null, haltedAt: null }),
      life: async () => ({ kind: "ran", runs: [], pendingQueries: [], halted: null, haltedAt: null }),
      resend: async () => ({ kind: "ran", instructions: [], halted: null, haltedAt: null }),
      unreceived: (now) => unreceivedTick(w.ports, now),
      assign: async () => {
        const slot = w.ledger.slotFree("worker");
        freeAtAssign = slot.known ? slot.value : null;
        return { kind: "ran", starts: [], requests: [], halted: null, haltedAt: null };
      },
    },
    serverTick: () => {},
    ledgerClock: shared,
    monotonic: { now: () => 1 },
    restoreDone: () => true,
    ledger: w.ledger,
    policy: { judgeMs: 30_000, resendEveryMs: 5_000, assignCallsPerBeat: 1 },
  });
  const report = await cycle.beat();
  if (report.kind !== "ran" || report.unreceived.kind !== "returned") throw new Error(`박자가 돌지 않았다: ${JSON.stringify(report)}`);
  return { runs: ran(report.unreceived.result).runs, freeAtAssign: freeAtAssign as boolean | null };
}

describe("마지막 확인 뒤의 외부 코드", () => {
  // 가짜 답 줄에 같은 실행기의 양성 상태 보고가 들어온다: 변경 번호가 늘고 넘기지 않은 답이 남는다.
  function line(w: ReturnType<typeof world>) {
    const queue = { submitted: false };
    w.state.evidence = () => ({ known: true, tainted: false, pending: queue.submitted, version: w.state.version, lastFull: full() });
    return () => {
      queue.submitted = true;
      w.state.version += 1;
    };
  }

  test("증거를 읽기 전·후에 같은 실행기 줄에 들어온 양성 답은 둘 다 닫지 않고, 같은 박자의 배정은 자리가 찬 것을 본다", async () => {
    const before = world();
    const beforeRun = started(before.ledger);
    line(before)();
    const early = await beatWithAssign(before);
    expect([early.runs, early.freeAtAssign, before.calls.length, before.stateOf(beforeRun.runId)]).toEqual([[skipped(beforeRun, "pending")], false, 0, "preparing"]);
    // 증거를 읽은 뒤 항목의 전역 포트 재조회(정지 세대·맡기지 않을 실행기·복원 대기) 안에서 들어온다.
    for (const port of ["generation", "withheld", "settled"] as const) {
      const w = world();
      const live = started(w.ledger);
      const submit = line(w);
      const original = w.state[port];
      let reads = 0;
      w.state[port] = () => {
        reads += 1;
        // 둘째 읽기가 증거를 읽은 뒤의 항목 재조회다.
        if (reads === 2) submit();
        return original();
      };
      const late = await beatWithAssign(w);
      expect([port, late.runs, late.freeAtAssign, w.calls.length, w.stateOf(live.runId)]).toEqual([port, [skipped(live, "evidence_changed")], false, 0, "preparing"]);
    }
  });

  test("맡기지 않을 실행기 조회 안에서 정지 세대가 바뀌면 confirm이 잡아 0회다(장부는 정지 세대를 보지 않는다)", () => {
    const w = world();
    const live = started(w.ledger);
    let reads = 0;
    let generation = 0;
    w.state.generation = () => generation;
    w.state.withheld = () => {
      reads += 1;
      if (reads === 2) generation = 1;
      return { known: true, value: [] };
    };
    expect(ran(w.tick()).runs).toEqual([skipped(live, "stop_generation")]);
    expect([w.calls.length, w.stateOf(live.runId)]).toEqual([0, "preparing"]);
  });

  test("포트·장부 객체의 속성은 박자 처음에 한 번씩만 읽고, confirm과 장부 호출 사이에는 아무 속성도 읽지 않는다", () => {
    const names = ["ports.ledger", "ledger.unansweredInstructions", "ledger.closeUnreceivedRun", "ports.evidence", "evidence.read", "evidence.confirm", "ports.withheld", "withheld.executors", "ports.intake", "intake.stopGeneration", "ports.observationsSettled"] as const;
    type Name = (typeof names)[number];
    const arrange = (revoke: (name: Name, trace: readonly string[]) => boolean) => {
      const w = world();
      const live = started(w.ledger);
      const trace: string[] = [];
      const inner = w.ports as unknown as Record<string, Record<string, unknown>>;
      const getter = (name: Name, value: unknown) => () => {
        if (revoke(name, trace)) w.state.current = () => false;
        trace.push(`get ${name}`);
        return value;
      };
      const wrap = (owner: Record<string, unknown>, prefix: string) => {
        const out = {};
        for (const [key, value] of Object.entries(owner)) {
          const name = `${prefix}.${key}` as Name;
          const fn = typeof value === "function" && key === "confirm" ? (...args: unknown[]) => (trace.push("confirm"), (value as (...a: unknown[]) => unknown)(...args)) : value;
          const fnClose = key === "closeUnreceivedRun" ? (...args: unknown[]) => (trace.push("close"), (fn as (...a: unknown[]) => unknown)(...args)) : fn;
          Object.defineProperty(out, key, { get: getter(name, fnClose), enumerable: true });
        }
        return out;
      };
      const ports = {};
      for (const key of ["ledger", "evidence", "withheld", "intake"]) Object.defineProperty(ports, key, { get: getter(`ports.${key}` as Name, wrap(inner[key] as Record<string, unknown>, key)) });
      Object.defineProperty(ports, "observationsSettled", { get: getter("ports.observationsSettled", inner.observationsSettled) });
      return { w, live, trace, result: ran(unreceivedTick(ports as unknown as UnreceivedPorts, AT)) };
    };
    // 철회 없음: 속성마다 한 번, 모두 confirm보다 앞이다.
    const plain = arrange(() => false);
    expect(plain.result.runs.map((item) => item.outcome)).toEqual(["closed"]);
    expect(plain.trace.slice(plain.trace.indexOf("confirm"))).toEqual(["confirm", "close"]);
    expect(names.map((name) => plain.trace.filter((entry) => entry === `get ${name}`).length)).toEqual(names.map(() => 1));
    // 리뷰의 입력: 확인 뒤에 읽히면 철회하는 접근자. 확인 뒤에 읽히지 않으므로 철회도 없다.
    const afterCheck = arrange((_name, trace) => trace.includes("confirm"));
    expect([afterCheck.result.runs.map((item) => item.outcome), afterCheck.trace.at(-1)]).toEqual([["closed"], "close"]);
    // 어느 접근자 안에서 철회해도 장부는 0회다.
    for (const name of names) {
      const revoked = arrange((current) => current === name);
      expect([name, revoked.result.runs, revoked.w.calls.length, revoked.w.stateOf(revoked.live.runId)]).toEqual([name, [skipped(revoked.live, "link_not_current")], 0, "preparing"]);
    }
  });
});

describe("증거를 복사하는 도중의 외부 코드", () => {
  // 증거 답의 칸을 읽는 순간 같은 실행기 줄에 양성 상태 보고가 들어온다(변경 번호가 늘고 넘기지 않은 답이 남는다).
  // version: live는 지금 번호를, snapshot은 read를 부른 때의 번호를 낸다. pending: live는 지금 줄을, sampled는 read를 부른 때의 줄을 낸다.
  function copying(w: ReturnType<typeof world>, trigger: string, version: "live" | "snapshot", pending: "live" | "sampled") {
    const queue = { submitted: false };
    const submit = () => {
      if (queue.submitted) return;
      queue.submitted = true;
      w.state.version += 1;
    };
    w.state.evidence = () => {
      const atRead = { version: w.state.version, pending: queue.submitted };
      const answer = { known: true };
      const field = (name: string, value: () => unknown) =>
        Object.defineProperty(answer, name, {
          enumerable: true,
          get() {
            if (name === trigger) submit();
            return value();
          },
        });
      field("tainted", () => false);
      field("pending", () => (pending === "live" ? queue.submitted : atRead.pending));
      field("version", () => (version === "live" ? w.state.version : atRead.version));
      field("lastFull", () => full());
      return answer as UnreceivedEvidenceRead;
    };
  }

  test("칸 접근자 안에서 양성 답이 들어오면 현재 번호를 내는 포트·읽은 때의 번호를 내는 포트 둘 다 닫지 않고, 같은 박자의 배정은 자리가 찬 것을 본다", async () => {
    const cases = [
      // 리뷰의 입력: 번호 칸의 접근자 안에서 들어오고 대기 칸은 지금 줄을 낸다.
      { trigger: "version", pending: "live", reason: "pending" },
      // 번호보다 먼저 읽히던 칸. 대기 칸이 read 때의 값이라 번호를 먼저 고정하고 다시 읽어야 잡힌다.
      { trigger: "tainted", pending: "sampled", reason: "evidence_changed" },
      { trigger: "pending", pending: "sampled", reason: "evidence_changed" },
      { trigger: "lastFull", pending: "sampled", reason: "evidence_changed" },
    ] as const;
    for (const version of ["live", "snapshot"] as const) {
      for (const { trigger, pending, reason } of cases) {
        const w = world();
        const live = started(w.ledger);
        copying(w, trigger, version, pending);
        const beat = await beatWithAssign(w);
        expect([version, trigger, beat.runs, beat.freeAtAssign, w.calls.length, w.stateOf(live.runId)]).toEqual([
          version,
          trigger,
          [skipped(live, reason)],
          false,
          0,
          "preparing",
        ]);
      }
    }
  });

  test("복사 도중 바뀐 번호는 confirm에 기대지 않고 복사를 마친 그 자리에서 잡는다", () => {
    const w = world();
    const live = started(w.ledger);
    copying(w, "lastFull", "live", "sampled");
    // 번호를 보지 않는 confirm. 복사 뒤의 다시 읽기만 남는다.
    w.state.confirm = () => "current";
    expect(ran(w.tick()).runs).toEqual([skipped(live, "evidence_changed")]);
    expect([w.calls.length, w.stateOf(live.runId)]).toEqual([0, "preparing"]);
    // 대조군: 복사 도중 아무것도 들어오지 않으면 같은 포트로 닫는다.
    const quiet = world();
    const closed = started(quiet.ledger);
    copying(quiet, "none", "live", "sampled");
    quiet.state.confirm = () => "current";
    expect(ran(quiet.tick()).runs.map((item) => item.outcome)).toEqual(["closed"]);
    expect([quiet.calls.length, quiet.stateOf(closed.runId)]).toEqual([1, "not_started"]);
  });
});

describe("포트와 응답의 꼴", () => {
  test("전체 목록의 원소가 계약의 실행 상태 항목이 아니면 그 항목만 evidence_unknown이고 다른 실행기의 닫기는 간다", () => {
    const valid = { run_id: id(), state: "running", run_generation: 1, last_receipt_id: null };
    // 네 칸과 값이 맞아도 원형이 Object.prototype·null이 아니면 계약의 일반 객체가 아니다(src/contract/v1/schema.ts의 object).
    class RunEntry {
      run_id = id();
      state = "running";
      run_generation = 1;
      last_receipt_id = null;
    }
    const broken: unknown[][] = [
      [new RunEntry()],
      [Object.assign(Object.create({ inherited: true }), valid)],
      [{ run_id: id() }],
      [{ ...valid, extra: 1 }],
      [{ ...valid, state: "made_up" }],
      [{ ...valid, run_generation: 0 }],
      [{ ...valid, last_receipt_id: "r" }],
      [{ ...valid, state: "not_known" }],
      [{ ...valid, state: "not_known", run_generation: null, last_receipt_id: id() }],
      [valid, valid],
      Array.from({ length: 9 }, () => ({ ...valid, run_id: id() })),
      // 빈 자리도 꼴이 틀린 항목이다(장부의 answerRuns와 같다).
      [, valid],
    ];
    for (const [index, runs] of broken.entries()) {
      const w = world();
      const other = ghost(OTHER_EXECUTOR);
      w.state.before = [other];
      const live = started(w.ledger);
      w.state.evidence = (executorId) =>
        executorId === OTHER_EXECUTOR
          ? { known: true, tainted: false, pending: false, version: 0, lastFull: full({ principal: OTHER_EXECUTOR, runs: runs as unknown as UnreceivedFull["runs"] }) }
          : { known: true, tainted: false, pending: false, version: 0, lastFull: full() };
      const result = ran(w.tick());
      expect([index, result.runs.map((item) => [item.outcome, "reason" in item ? item.reason : null]), result.halted]).toEqual([
        index,
        [
          ["skipped", "evidence_unknown"],
          ["closed", null],
        ],
        null,
      ]);
      expect([index, w.calls.map((call) => call.runId)]).toEqual([index, [live.runId]]);
    }
    // 대조군: 꼴이 맞는 목록은 장부에 그대로 간다(not_known, 원형이 null인 객체 포함).
    const w = world();
    const live = started(w.ledger);
    const known = [
      valid,
      { run_id: id(), state: "not_known", run_generation: null, last_receipt_id: null },
      Object.assign(Object.create(null), { run_id: id(), state: "running", run_generation: 2, last_receipt_id: null }),
    ];
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: full({ runs: known as unknown as UnreceivedFull["runs"] }) });
    expect(ran(w.tick()).runs.map((item) => item.outcome)).toEqual(["closed"]);
    expect([w.calls[0]?.runs, w.stateOf(live.runId)] as unknown[]).toEqual([known, "not_started"]);
  });

  test("포트 속성을 꺼내다 던지면 그 포트를 쓸 수 없는 것이다: 증거는 항목마다 evidence_unknown, 전역 포트는 그 이유로 not_run", () => {
    const throwing = (w: ReturnType<typeof world>, key: string) => {
      const ports = { ...(w.ports as unknown as Record<string, unknown>) };
      Object.defineProperty(ports, key, {
        get() {
          throw new Error("접근자");
        },
      });
      return unreceivedTick(ports as unknown as UnreceivedPorts, AT);
    };
    const w = world();
    const other = ghost(OTHER_EXECUTOR);
    w.state.before = [other];
    const live = started(w.ledger);
    expect(ran(throwing(w, "evidence")).runs).toEqual([skipped({ requestId: other.requestId, runId: other.runId }, "evidence_unknown", OTHER_EXECUTOR), skipped(live, "evidence_unknown")]);
    for (const [key, reason] of [
      ["ledger", "read_unknown"],
      ["intake", "stop_generation_unknown"],
      ["withheld", "withheld_unknown"],
      ["observationsSettled", "observations_unsettled"],
    ] as const) {
      expect([key, throwing(w, key)]).toEqual([key, { kind: "not_run", reason }]);
    }
    // 증거 포트에 confirm이 없거나 장부 포트에 닫기가 없으면 꺼내지 못한 것이다.
    const ports = w.ports as unknown as Record<string, unknown>;
    expect(ran(unreceivedTick({ ...ports, evidence: { read: () => full() } } as unknown as UnreceivedPorts, AT)).runs.map((item) => "reason" in item && item.reason)).toEqual(["evidence_unknown", "evidence_unknown"]);
    expect(unreceivedTick({ ...ports, ledger: { unansweredInstructions: () => w.ledger.unansweredInstructions() } } as unknown as UnreceivedPorts, AT)).toEqual({ kind: "not_run", reason: "read_unknown" });
    expect([w.calls.length, w.stateOf(live.runId)]).toEqual([0, "preparing"]);
  });

  test("confirm이 던지거나 정의 밖의 값을 내면 link_not_current로 0회다", () => {
    for (const answer of [() => true, () => "ok", () => undefined, () => ({ toString: () => "current" })]) {
      const w = world();
      const live = started(w.ledger);
      w.state.confirm = answer;
      expect(ran(w.tick()).runs).toEqual([skipped(live, "link_not_current")]);
      expect(w.calls.length).toBe(0);
    }
  });

  test("닫기의 성공에서 보는 칸은 실행 ID와 상태 둘이다(closed는 장부 포트가 그렇게 답했다는 뜻이다)", () => {
    const w = world();
    const live = started(w.ledger);
    w.state.closeAnswer = () => ({ ok: true, run: { runId: live.runId, state: "not_started" } });
    expect(ran(w.tick()).runs.map((item) => item.outcome)).toEqual(["closed"]);
    // 장부 대역이 적지 않았으므로 실제 장부는 그대로다. 이 박자는 그것을 가르지 않는다(unreceived.md "정한 것").
    expect([w.calls.length, w.stateOf(live.runId)]).toEqual([1, "preparing"]);
  });
});

describe("정적", () => {
  const code = async (path: string) =>
    (await readText(path))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
  const FILE = "src/supervisor/dispatch/unreceived.ts";
  const CONFIRM = "const confirmed = confirmLast(evidence.confirm, item.executorId, full.connection, evidence.version, gate.generation);";
  const CALL = "answer = apply(close, receiver, closing);";
  const CONFIRM_CALL = "answer = apply(port.fn, port.receiver, [executorId, connection, version, generation]);";
  const squash = (text: string) => text.replace(/\s+/g, " ").trim();
  // confirm 호출문의 끝(같은 줄 포함)부터 장부 호출까지.
  const afterConfirm = (source: string) => {
    const at = source.indexOf(CONFIRM);
    if (at < 0 || source.indexOf(CONFIRM, at + 1) >= 0) return null;
    const from = at + CONFIRM.length;
    const to = source.indexOf(CALL, from);
    return to < 0 ? null : source.slice(from, to + CALL.length);
  };
  // confirmLast 안에서 confirm 호출 뒤부터 함수 끝까지.
  const confirmTail = (source: string) => {
    const start = source.indexOf("function confirmLast(");
    const body = source.slice(start, source.indexOf("\n}\n", start) + 2);
    const at = body.indexOf(CONFIRM_CALL);
    return at < 0 ? null : body.slice(at + CONFIRM_CALL.length);
  };
  // 꺼내 둔 닫기 함수(close)라는 낱말이 나오는 줄 전부. 꺼내는 hold·담는 Held·판단의 구조 분해·장부 호출 한 줄 밖에 나오면
  // 두 번째 호출 자리나 다른 이름에 담는 자리다.
  const closeLines = (source: string) =>
    source
      .split("\n")
      .filter((line) => /\bclose\b/.test(line))
      .map((line) => line.trim());
  const CLOSE_LINES = [
    "readonly close: Fn;",
    "let close: unknown;",
    "close = ledger.closeUnreceivedRun;",
    'if (typeof unanswered !== "function" || typeof close !== "function") return null;',
    "close: close as Fn,",
    "const { ledger: receiver, close } = held;",
    CALL,
  ];
  // 확인 뒤에 허용하는 문장: 확인의 답 비교, 박자 유효 문(꺼내 둔 함수를 부르는 한 줄), 답을 담을 자리, 장부 호출.
  // confirmLast는 예외 처리와 원시값 비교 반환뿐이다.
  const AFTER_CONFIRM = `if (confirmed !== "current") return skip(confirmed); if (!beatStillValid(held)) return { outcome: null, halt: "beat_closed" }; let answer: unknown; try { ${CALL}`;
  const CONFIRM_TAIL = '} catch { return "link_not_current"; } return answer === "current" || answer === "evidence_changed" || answer === "stop_generation" ? answer : "link_not_current"; }';

  test("기다리지 않고, 시계·난수·타이머·환경·파일을 직접 쓰지 않는다", async () => {
    const source = await code(FILE);
    for (const banned of [/\bawait\b/, /\basync\b/, /\.then\s*\(/, /\bDate\b/, /\bperformance\b/, /\bMath\.random\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bprocess\b/, /\bBun\b/, /["']node:/, /["']bun:/]) {
      expect([String(banned), banned.test(source)]).toEqual([String(banned), false]);
    }
  });

  test("포트 객체의 속성은 hold에서 한 번씩만 읽고, 장부에서는 읽기 셋(새 인사 갈래의 둘 포함)과 닫기 하나만 꺼낸다", async () => {
    const source = await code(FILE);
    const start = source.indexOf("function hold(");
    const end = source.indexOf("\n}\n", start);
    const reads = [...source.matchAll(/\b(ports|ledger)\.(\w+)/g)];
    expect(reads.map((match) => `${match[1]}.${match[2]}`).sort()).toEqual([
      "ledger.closeUnreceivedRun",
      "ledger.instructionTimes",
      "ledger.listRuns",
      "ledger.unansweredInstructions",
      "ports.beatValid",
      "ports.evidence",
      "ports.intake",
      "ports.ledger",
      "ports.observationsSettled",
      "ports.rehello",
      "ports.withheld",
    ]);
    expect(reads.every((match) => (match.index ?? -1) > start && (match.index ?? -1) < end)).toBe(true);
    // 대조군: 판단 안에서 포트를 다시 읽으면 잡는다.
    const broken = source.replace(CALL, "answer = apply(ledger.closeUnreceivedRun as Fn, receiver, closing);");
    expect([...broken.matchAll(/\bledger\.closeUnreceivedRun\b/g)].length).toBe(2);
  });

  test("confirm 뒤에는 박자 유효 문 하나만 부르고 장부를 부른다. 그 사이 속성을 읽지 않고 꺼내 둔 함수와 미리 만든 인자만 쓴다", async () => {
    const source = await code(FILE);
    expect([source.indexOf(CONFIRM) > 0, source.indexOf(CALL) > source.indexOf(CONFIRM)]).toEqual([true, true]);
    const between = afterConfirm(source) ?? "";
    expect([/[.[]/.test(between), [...between.matchAll(/(\w+)\s*\(/g)].map((match) => match[1])]).toEqual([false, ["if", "skip", "if", "beatStillValid", "apply"]]);
    expect(squash(between)).toBe(AFTER_CONFIRM);
    // confirmLast는 돌아온 뒤 원시값 비교만 한다.
    const body = source.slice(source.indexOf("function confirmLast("), source.indexOf("\n}\n", source.indexOf("function confirmLast(")));
    expect(/[.[]/.test(body.slice(body.indexOf("apply(") + "apply(".length).split("\n").slice(1).join("\n"))).toBe(false);
    expect(squash(confirmTail(source) ?? "")).toBe(CONFIRM_TAIL);
    // 꺼내 둔 닫기 함수를 부르는 자리는 모듈 전체에서 한 줄이다.
    expect(closeLines(source)).toEqual(CLOSE_LINES);
    // 대조군: 사이에서 속성을 읽거나 포트를 부르면 잡는다.
    for (const injected of ["const late = held.close;", "invoke(held.settled, []);"]) {
      const skipLine = 'if (confirmed !== "current") return skip(confirmed);';
      const broken = afterConfirm(source.replace(skipLine, `${skipLine}\n  ${injected}`)) ?? "";
      expect([injected, /[.[]/.test(broken) || [...broken.matchAll(/(\w+)\s*\(/g)].length !== 5]).toEqual([injected, true]);
    }
  });

  // confirm 뒤에 부르는 박자 유효 문의 본문과 그 함수가 쓰는 invoke의 본문. 꺼내 둔 함수를 꺼내 둔 수신자로 한 번 부르고 원시값만 견준다.
  // 그 함수(조립의 박자 유효 문)가 답 줄·증거·연결을 바꾸지 않는 것은 포트의 조건이고 조립 시험(boot-effects.test.ts)이 본다.
  const BEAT_STILL_VALID = 'function beatStillValid(held: Held): boolean { if (held.beatValid === "absent") return true; const answer = invoke(held.beatValid, []); return answer !== null && answer.value === true; }';
  const INVOKE = "function invoke(bound: Bound | null, args: readonly unknown[]): { readonly value: unknown } | null { if (bound === null) return null; try { return { value: apply(bound.fn, bound.receiver, args) }; } catch { return null; } }";
  const bodyOf = (source: string, head: string) => {
    const start = source.indexOf(head);
    return start < 0 || source.indexOf(head, start + 1) >= 0 ? null : squash(source.slice(start, source.indexOf("\n}\n", start) + 2));
  };

  test("confirm 뒤의 박자 유효 문은 꺼내 둔 함수를 한 번 부르고 원시값만 견준다(본문까지 글자 그대로)", async () => {
    const source = await code(FILE);
    expect([bodyOf(source, "function beatStillValid("), bodyOf(source, "function invoke(")]).toEqual([BEAT_STILL_VALID, INVOKE]);
    // 대조군: 본문에 속성 읽기·다른 포트 호출을 넣으면 잡는다.
    for (const injected of ["invoke(held.settled, []);", "const late = held.close;"]) {
      const anchor = 'if (held.beatValid === "absent") return true;';
      const broken = source.replace(anchor, `${anchor}\n  ${injected}`);
      expect([injected, broken !== source, bodyOf(broken, "function beatStillValid(") === BEAT_STILL_VALID]).toEqual([injected, true, false]);
    }
  });

  test("대조군: 닫기 호출을 두 번 두거나, confirmLast의 반환 직전이나 확인문과 같은 줄에 호출을 넣으면 위 단언이 잡는다", async () => {
    const source = await code(FILE);
    const ret = 'return answer === "current" ||';
    const twice = source.replace(CALL, `${CALL}\n      ${CALL}`);
    const beforeReturn = source.replace(ret, `observe();\n  ${ret}`);
    const sameLine = source.replace(CONFIRM, `${CONFIRM} observe();`);
    // 각 입력이 실제로 바뀌었는지 먼저 본다.
    expect([twice, beforeReturn, sameLine].map((text) => text !== source)).toEqual([true, true, true]);
    expect([closeLines(twice).length, squash(afterConfirm(twice) ?? "") === AFTER_CONFIRM]).toEqual([CLOSE_LINES.length + 1, true]);
    expect([squash(confirmTail(beforeReturn) ?? "") === CONFIRM_TAIL, closeLines(beforeReturn)]).toEqual([false, CLOSE_LINES]);
    expect([squash(afterConfirm(sameLine) ?? "") === AFTER_CONFIRM, closeLines(sameLine)]).toEqual([false, CLOSE_LINES]);
  });

  // 새 인사 갈래의 마지막 확인과 closeConnection 사이. 장부 닫기와 같은 규칙이다: 확인의 답 비교, 닫기 문 하나, 기억 적기, 호출.
  const LINKED = "const linked = confirmLast(evidence.confirm, head.executorId, connection, evidence.version, gate.generation);";
  const SHUT_CALL = "answer = apply(shut, shutReceiver, [connection]);";
  const AFTER_LINKED = `if (linked !== "current") return parked(linked); if (!rehelloStillValid(valid)) return parked("gate_closed"); closed.add(connection); let answer: unknown; try { ${SHUT_CALL}`;
  const REHELLO_STILL_VALID = "function rehelloStillValid(valid: Bound): boolean { const answer = invoke(valid, []); return answer !== null && answer.value === true; }";
  const afterLinked = (source: string) => {
    const at = source.indexOf(LINKED);
    if (at < 0 || source.indexOf(LINKED, at + 1) >= 0) return null;
    const to = source.indexOf(SHUT_CALL, at);
    return to < 0 ? null : squash(source.slice(at + LINKED.length, to + SHUT_CALL.length));
  };
  const shutLines = (source: string) =>
    source
      .split("\n")
      .filter((line) => /\bshut\b/.test(line))
      .map((line) => line.trim());

  test("새 인사 갈래도 confirm 뒤에는 닫기 문 하나와 기억 적기만 두고 꺼내 둔 closeConnection을 부른다(글자 그대로). 그 호출 자리는 하나다", async () => {
    const source = await code(FILE);
    expect([afterLinked(source), bodyOf(source, "function rehelloStillValid(")]).toEqual([AFTER_LINKED, REHELLO_STILL_VALID]);
    expect(shutLines(source)).toEqual(["const { closed, valid, closeConnection: { fn: shut, receiver: shutReceiver } } = port;", SHUT_CALL]);
    // 대조군: 사이에 포트 호출·속성 읽기를 넣거나 호출을 두 번 두면 잡는다.
    const gateLine = 'if (!rehelloStillValid(valid)) return parked("gate_closed");';
    for (const injected of ["invoke(held.settled, []);", "const late = port.valid;"]) {
      const broken = source.replace(gateLine, `${gateLine}\n  ${injected}`);
      expect([injected, broken !== source, afterLinked(broken) === AFTER_LINKED]).toEqual([injected, true, false]);
    }
    const twice = source.replace(SHUT_CALL, `${SHUT_CALL}\n    ${SHUT_CALL}`);
    expect([twice !== source, shutLines(twice).length]).toEqual([true, 3]);
  });
});

describe("박자 유효 문(beatValid): confirm 뒤, 장부 닫기 바로 앞에서 본다", () => {
  test("confirm 안에서 박자 기한이 지나면 닫지 않고 beat_closed로 멈춘다(장부 0회, 실행은 preparing). 대조군(기한 안)은 닫는다", () => {
    for (const lapse of [true, false]) {
      const w = world();
      const live = started(w.ledger);
      let valid = true;
      const confirm = w.state.confirm;
      // 마지막 증거 호출(confirm) 안에서 박자 기한이 지난다.
      w.state.confirm = (executorId, connection, version, generation) => {
        const answer = confirm(executorId, connection, version, generation);
        if (lapse) valid = false;
        return answer;
      };
      const result = ran(unreceivedTick({ ...w.ports, beatValid: () => valid }, AT));
      if (lapse) {
        expect(result).toEqual({ kind: "ran", runs: [], halted: "beat_closed", haltedAt: live.requestId });
        expect([w.calls.length, w.stateOf(live.runId)]).toEqual([0, "preparing"]);
      } else {
        expect(result.runs).toMatchObject([{ runId: live.runId, outcome: "closed" }]);
        expect([w.calls.length, w.stateOf(live.runId)]).toEqual([1, "not_started"]);
      }
    }
  });

  test("유효 문이 던지거나 true가 아니거나 함수가 아니면 닫지 않는다", () => {
    for (const beatValid of [() => undefined, () => {
      throw new Error("유효 문 실패");
    }, 1]) {
      const w = world();
      const live = started(w.ledger);
      const result = ran(unreceivedTick({ ...w.ports, beatValid } as unknown as UnreceivedPorts, AT));
      expect([result.halted, w.calls.length, w.stateOf(live.runId)]).toEqual(["beat_closed", 0, "preparing"]);
    }
  });
});


// 새 인사를 부르는 갈래(A6e, unreceived.md "새 인사를 부르는 갈래"). 시작 발행은 NOW이고, 그 실행기의 마지막 반영 인사는 시한 전
// (서명·받은 시각 NOW + 1,000)이다. 장부 시계는 늘 NOW라 시작 임대의 끝은 NOW + 30,000이다(instructionTimes).
// 서버의 closeConnection 대신 부른 연결 번호를 세는 가짜를 넘기고, 장부의 임대 읽기 둘은 실제 장부로 위임한다.
const EARLY = full({ answeredAt: NOW + 1_000, receivedAt: NOW + 1_000 });
const LATE = NOW + REHELLO_AFTER_MS;

function rehelloWorld(windowMs: number | null = null) {
  const w = world();
  w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: w.state.version, lastFull: EARLY });
  const order: string[] = [];
  const shuts: number[] = [];
  const r = {
    memory: createRehelloMemory(),
    windowMs: windowMs as unknown,
    valid: (): unknown => true,
    answer: (_connection: number): unknown => ({ kind: "closed" }),
    runs: (): unknown => w.ledger.listRuns(),
    times: (runId: string): unknown => w.ledger.instructionTimes(runId),
  };
  const confirm = w.state.confirm;
  w.state.confirm = (executorId, connection, version, generation) => {
    order.push("confirm");
    return confirm(executorId, connection, version, generation);
  };
  const base = w.ports as unknown as { ledger: object };
  const rp = () =>
    ({
      ...w.ports,
      ledger: {
        ...base.ledger,
        listRuns: () => {
          order.push("listRuns");
          return r.runs();
        },
        instructionTimes: (runId: string) => {
          order.push("instructionTimes");
          return r.times(runId);
        },
      },
      rehello: {
        closeConnection: (connection: number) => {
          order.push("closeConnection");
          shuts.push(connection);
          return r.answer(connection);
        },
        valid: () => {
          order.push("valid");
          return r.valid();
        },
        memory: r.memory,
        reconnectWindowMs: r.windowMs,
      },
    }) as unknown as UnreceivedPorts;
  return { ...w, r, order, shuts, rp, tick: (now = LATE) => unreceivedTick(rp(), now) };
}

const early = (live: { runId: string; requestId: string }, rehello?: UnreceivedRehelloSkip): UnreceivedOutcome =>
  rehello === undefined ? skipped(live, "answer_too_early") : { requestId: live.requestId, runId: live.runId, executorId: WORKER_EXECUTOR, outcome: "skipped", reason: "answer_too_early", rehello };
const reheld = (live: { runId: string; requestId: string }, result: UnreceivedRehelloResult, connection = CONN): UnreceivedOutcome => ({
  requestId: live.requestId,
  runId: live.runId,
  executorId: WORKER_EXECUTOR,
  outcome: "rehello",
  connection,
  answeredAt: NOW + 1_000,
  result,
});

describe("새 인사를 부르는 갈래(A6e)", () => {
  test("시한 전 인사뿐이고 조건이 모두 맞으면 그 연결을 한 번 닫고 장부는 부르지 않는다. 임대 읽기 → confirm → 닫기 문 → closeConnection 차례다", () => {
    expect(REHELLO_AFTER_MS).toBe(31_000);
    const w = rehelloWorld();
    const live = started(w.ledger);
    expect(ran(w.tick())).toEqual({ kind: "ran", runs: [reheld(live, "closed")], halted: null, haltedAt: null });
    expect([w.shuts, w.calls.length, w.stateOf(live.runId)]).toEqual([[CONN], 0, "preparing"]);
    expect(w.order).toEqual(["listRuns", "instructionTimes", "confirm", "valid", "closeConnection"]);
    // 대조군: 갈래가 없으면 그대로 answer_too_early이고 rehello 칸도 없다.
    const plain = world();
    const other = started(plain.ledger);
    plain.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: EARLY });
    expect(ran(plain.tick(LATE)).runs).toEqual([skipped(other, "answer_too_early")]);
  });

  test("같은 연결은 두 번 닫지 않고, 새 연결의 인사가 반영되기 전에는 그 실행기를 다시 닫지 않는다(박자 사이 기억). 새 기억이면 다시 닫는다", () => {
    const w = rehelloWorld();
    const live = started(w.ledger);
    ran(w.tick());
    expect(ran(w.tick(LATE + 1)).runs).toEqual([early(live, "closed_before")]);
    expect(w.shuts).toEqual([CONN]);
    // 새 연결의 인사가 반영됐는데 여전히 시한 전이면 그 새 연결은 닫을 수 있다(창이 없을 때).
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: w.state.version, lastFull: full({ connection: OTHER_CONN, answeredAt: NOW + 1_000, receivedAt: LATE }) });
    w.state.current = (connection, executorId) => connection === OTHER_CONN && executorId === WORKER_EXECUTOR;
    expect(ran(w.tick(LATE + 2)).runs).toEqual([reheld(live, "closed", OTHER_CONN)]);
    expect(ran(w.tick(LATE + 3)).runs).toEqual([early(live, "closed_before")]);
    expect(w.shuts).toEqual([CONN, OTHER_CONN]);
    // 대조군: 기억이 막는 것이다. 박자마다 새 기억을 넘기면 같은 연결을 또 닫는다.
    w.r.memory = createRehelloMemory();
    ran(w.tick(LATE + 4));
    expect(w.shuts).toEqual([CONN, OTHER_CONN, OTHER_CONN]);
  });

  test("시한 경계: 발행 + 30,999면 too_soon이고 31,000(정각)이면 닫는다. 시한 뒤 전체 인사가 있으면 이 갈래는 0이고 장부가 닫는다", () => {
    const a = rehelloWorld();
    const live = started(a.ledger);
    expect(ran(a.tick(LATE - 1)).runs).toEqual([early(live, "too_soon")]);
    expect([a.shuts, a.order]).toEqual([[], []]);
    expect(ran(a.tick(LATE)).runs).toEqual([reheld(live, "closed")]);
    const b = rehelloWorld();
    const other = started(b.ledger);
    b.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: full() });
    expect(ran(b.tick()).runs).toMatchObject([{ runId: other.runId, outcome: "closed" }]);
    expect([b.shuts, b.calls.length, b.order]).toEqual([[], 1, ["confirm"]]);
  });

  test("그 실행기에 임대를 믿을 실행이 있으면 닫지 않는다: 갱신으로 늘어난 임대는 끝 + 1,000ms 전까지 lease_trusted다", () => {
    const w = rehelloWorld();
    const live = started(w.ledger);
    // 끝 NOW + 40,000(발행 NOW + 10,000 + 30,000). 시작 임대 끝(NOW + 30,000)보다 13,000ms 앞서 발행해 장부가 믿는다.
    must(w.ledger.recordRenewInstruction({ runId: live.runId, requestId: id(), stopGeneration: 0, now: NOW + 10_000 }));
    expect(ran(w.tick(NOW + 40_999)).runs).toEqual([early(live, "lease_trusted")]);
    expect([w.shuts, w.order.includes("confirm")]).toEqual([[], false]);
    expect(ran(w.tick(NOW + 41_000)).runs).toEqual([reheld(live, "closed")]);
  });

  test("임대 읽기: 같은 실행기의 끝나지 않은 실행만 보고, 끝 모름은 lease_trusted, 읽기 모름·꼴 틀림은 lease_unknown으로 0이다", () => {
    const GHOST = id();
    const owned = (executorId: string, state: string, expiresAt: unknown, times: unknown = undefined) => (w: ReturnType<typeof rehelloWorld>) => {
      w.r.runs = () => {
        const read = w.ledger.listRuns();
        if (!read.known) return read;
        return { known: true, value: [...read.value, { runId: GHOST, executorId, state }] };
      };
      w.r.times = (runId) => (runId === GHOST ? (times ?? { known: true, value: { runId, lease: { issuedAt: NOW, expiresAt } } }) : w.ledger.instructionTimes(runId));
    };
    const cases: [string, (w: ReturnType<typeof rehelloWorld>) => void, UnreceivedRehelloSkip | null][] = [
      ["같은 실행기·running·끝 모름", owned(WORKER_EXECUTOR, "running", "unknown"), "lease_trusted"],
      ["같은 실행기·unknown_running·끝 = now - 999", owned(WORKER_EXECUTOR, "unknown_running", LATE - 999), "lease_trusted"],
      ["같은 실행기·끝 = now - 1,000(대조군)", owned(WORKER_EXECUTOR, "running", LATE - 1_000), null],
      ["같은 실행기·finalized·끝 모름(대조군)", owned(WORKER_EXECUTOR, "finalized", "unknown"), null],
      ["다른 실행기·끝 모름(대조군)", owned(OTHER_EXECUTOR, "running", "unknown"), null],
      ["같은 실행기·임대 없음(대조군)", owned(WORKER_EXECUTOR, "running", null, { known: true, value: { runId: GHOST, lease: null } }), null],
      ["끝이 숫자가 아님", owned(WORKER_EXECUTOR, "running", "later"), "lease_unknown"],
      ["instructionTimes 모름", owned(WORKER_EXECUTOR, "running", null, { known: false, reason: "db_error" }), "lease_unknown"],
      ["instructionTimes가 실행 없음(null)", owned(WORKER_EXECUTOR, "running", null, { known: true, value: null }), "lease_unknown"],
      ["실행 항목의 상태가 장부의 상태가 아님", owned(WORKER_EXECUTOR, "gone", "unknown"), "lease_unknown"],
      ["listRuns 모름", (w) => (w.r.runs = () => ({ known: false, reason: "db_error" })), "lease_unknown"],
      [
        "listRuns가 던짐",
        (w) =>
          (w.r.runs = () => {
            throw new Error("읽기 실패");
          }),
        "lease_unknown",
      ],
      [
        "instructionTimes가 던짐",
        (w) =>
          (w.r.times = () => {
            throw new Error("읽기 실패");
          }),
        "lease_unknown",
      ],
    ];
    for (const [label, arrange, why] of cases) {
      const w = rehelloWorld();
      const live = started(w.ledger);
      arrange(w);
      const runs = ran(w.tick()).runs;
      expect([label, runs]).toEqual([label, why === null ? [reheld(live, "closed")] : [early(live, why)]]);
      expect([label, w.shuts.length, w.calls.length]).toEqual([label, why === null ? 1 : 0, 0]);
    }
  });

  test("재접속 제한 창: 그 인사를 받은 지 창이 지나기 전에는 닫지 않고(reconnect_window), 정각부터 닫는다", () => {
    const w = rehelloWorld(60_000);
    const live = started(w.ledger);
    expect(ran(w.tick(NOW + 1_000 + 60_000 - 1)).runs).toEqual([early(live, "reconnect_window")]);
    expect(w.shuts).toEqual([]);
    expect(ran(w.tick(NOW + 1_000 + 60_000)).runs).toEqual([reheld(live, "closed")]);
  });

  test("closeConnection이 던지거나 not_open·stopping·정의 밖의 답이어도 장부는 0이고 박자는 이어 가며, 같은 연결을 다시 닫지 않는다", () => {
    const answers: [() => unknown, UnreceivedRehelloResult][] = [
      [
        () => {
          throw new Error("닫기 실패");
        },
        "threw",
      ],
      [() => ({ kind: "not_open" }), "not_open"],
      [() => ({ kind: "stopping" }), "stopping"],
      [() => ({ kind: "gone" }), "malformed_answer"],
      [() => null, "malformed_answer"],
    ];
    for (const [answer, result] of answers) {
      const w = rehelloWorld();
      const live = started(w.ledger);
      // 뒤 항목: 다른 실행기의 시한 뒤 인사로 장부까지 가는 가짜 실행(장부에 없어 unknown_run).
      const after = ghost(OTHER_EXECUTOR);
      w.state.after = [after];
      w.state.evidence = (executorId) =>
        executorId === OTHER_EXECUTOR
          ? { known: true, tainted: false, pending: false, version: 0, lastFull: full({ connection: OTHER_CONN, principal: OTHER_EXECUTOR }) }
          : { known: true, tainted: false, pending: false, version: 0, lastFull: EARLY };
      w.state.current = (connection, executorId) => (connection === CONN && executorId === WORKER_EXECUTOR) || (connection === OTHER_CONN && executorId === OTHER_EXECUTOR);
      w.r.answer = answer;
      const first = ran(w.tick());
      expect([result, first.halted, first.runs]).toEqual([
        result,
        null,
        [reheld(live, result), { requestId: after.requestId, runId: after.runId, executorId: OTHER_EXECUTOR, outcome: "refused", reason: "unknown_run" }],
      ]);
      expect([result, w.calls.map((call) => call.runId), w.stateOf(live.runId)]).toEqual([result, [after.runId], "preparing"]);
      expect([result, ran(w.tick(LATE + 1)).runs[0], w.shuts]).toEqual([result, early(live, "closed_before"), [CONN]]);
    }
  });

  test("닫기 문이 true가 아니거나 던지면 닫지 않는다(gate_closed). 장부도 0이다", () => {
    const gates: (() => unknown)[] = [
      () => false,
      () => undefined,
      () => 1,
      () => {
        throw new Error("문 실패");
      },
    ];
    for (const valid of gates) {
      const w = rehelloWorld();
      const live = started(w.ledger);
      w.r.valid = valid;
      expect(ran(w.tick()).runs).toEqual([early(live, "gate_closed")]);
      expect([w.shuts, w.calls.length, w.order.at(-1)]).toEqual([[], 0, "valid"]);
    }
  });

  test("confirm이 현재가 아니거나 던지면 0이다. 임대 읽기 안에서 그 실행기 줄이 바뀌거나 연결이 철회되면 confirm이 잡아 0이다", () => {
    const cases: [string, (w: ReturnType<typeof rehelloWorld>) => void, UnreceivedRehelloSkip][] = [
      ["연결 아님", (w) => (w.state.current = () => false), "link_not_current"],
      [
        "confirm이 던짐",
        (w) =>
          (w.state.confirm = () => {
            throw new Error("확인 실패");
          }),
        "link_not_current",
      ],
      [
        "listRuns 안에서 줄이 바뀜",
        (w) =>
          (w.r.runs = () => {
            w.state.version += 1;
            return w.ledger.listRuns();
          }),
        "evidence_changed",
      ],
      [
        "instructionTimes 안에서 연결 철회",
        (w) =>
          (w.r.times = (runId) => {
            w.state.current = () => false;
            return w.ledger.instructionTimes(runId);
          }),
        "link_not_current",
      ],
    ];
    for (const [label, arrange, why] of cases) {
      const w = rehelloWorld();
      const live = started(w.ledger);
      arrange(w);
      expect([label, ran(w.tick()).runs, w.shuts, w.calls.length]).toEqual([label, [early(live, why)], [], 0]);
    }
  });

  test("오염·대기·맡기지 않을 실행기·증거 모름·전체 인사 없음·복원 대기·정지 세대 바뀜이면 닫지 않는다", () => {
    const evidenceOf = (over: Record<string, unknown>) => (w: ReturnType<typeof rehelloWorld>) => {
      w.state.evidence = () => ({ known: true, tainted: false, pending: false, version: 0, lastFull: EARLY, ...over }) as UnreceivedEvidenceRead;
    };
    const cases: [string, (w: ReturnType<typeof rehelloWorld>) => void, (live: { runId: string; requestId: string }) => UnreceivedOutcome[] | null][] = [
      ["오염", evidenceOf({ tainted: true }), (live) => [skipped(live, "tainted")]],
      ["대기", evidenceOf({ pending: true }), (live) => [skipped(live, "pending")]],
      ["전체 인사 없음", evidenceOf({ lastFull: null }), (live) => [skipped(live, "no_full")]],
      ["증거 모름", (w) => (w.state.evidence = () => ({ known: false })), (live) => [skipped(live, "evidence_unknown")]],
      ["맡기지 않을 실행기", (w) => (w.state.withheld = () => ({ known: true, value: [WORKER_EXECUTOR] })), (live) => [skipped(live, "withheld")]],
      ["복원 대기", (w) => (w.state.settled = () => false), () => null],
      [
        "정지 세대 바뀜",
        (w) => {
          must(w.ledger.applyStop({ generation: 1, stopped: true, now: NOW }));
          w.state.generation = () => 1;
        },
        (live) => [skipped(live, "stop_generation")],
      ],
    ];
    for (const [label, arrange, expected] of cases) {
      const w = rehelloWorld();
      const live = started(w.ledger);
      arrange(w);
      const result = w.tick();
      const runs = result.kind === "ran" ? result.runs : null;
      expect([label, runs, w.shuts, w.calls.length]).toEqual([label, expected(live), [], 0]);
    }
  });

  test("새 인사 포트를 꺼내지 못하면 갈래가 없다: 만든 기억이 아님·창이 양의 안전 정수도 null도 아님·장부 읽기가 없음·접근자가 던짐", () => {
    const arrangements: [string, (ports: Record<string, unknown>) => Record<string, unknown>][] = [
      ["기억이 아님", (p) => ({ ...p, rehello: { ...(p.rehello as object), memory: {} } })],
      ["창 0", (p) => ({ ...p, rehello: { ...(p.rehello as object), reconnectWindowMs: 0 } })],
      ["창 문자열", (p) => ({ ...p, rehello: { ...(p.rehello as object), reconnectWindowMs: "60000" } })],
      ["창 빠짐", (p) => ({ ...p, rehello: { ...(p.rehello as object), reconnectWindowMs: undefined } })],
      ["closeConnection 아님", (p) => ({ ...p, rehello: { ...(p.rehello as object), closeConnection: 1 } })],
      ["listRuns 없음", (p) => ({ ...p, ledger: { ...(p.ledger as object), listRuns: undefined } })],
      [
        "rehello 접근자가 던짐",
        (p) => {
          const copy = { ...p };
          Object.defineProperty(copy, "rehello", {
            get() {
              throw new Error("접근 실패");
            },
          });
          return copy;
        },
      ],
    ];
    for (const [label, arrange] of arrangements) {
      const w = rehelloWorld();
      const live = started(w.ledger);
      const ports = arrange(w.rp() as unknown as Record<string, unknown>) as unknown as UnreceivedPorts;
      expect([label, ran(unreceivedTick(ports, LATE)).runs, w.shuts]).toEqual([label, [skipped(live, "answer_too_early")], []]);
    }
  });
});
