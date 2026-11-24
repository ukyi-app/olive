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
  UnreceivedSkip,
  UnreceivedTickResult,
} from "../../../src/supervisor/dispatch/unreceived.ts";
import { UNRECEIVED_ANSWER_AFTER_MS, unreceivedTick } from "../../../src/supervisor/dispatch/unreceived.ts";
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
    evidence: (_executorId: string): UnreceivedEvidenceRead => ({ known: true, tainted: false, pending: false, lastFull: full() }),
    current: (connection: number, executorId: string): boolean => connection === CONN && executorId === WORKER_EXECUTOR,
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
    evidence: { read: (executorId: string) => state.evidence(executorId) },
    links: { current: (connection: number, executorId: string) => state.current(connection, executorId) },
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
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, lastFull: full({ answeredAt: NOW + 29_999 }) });
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
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, lastFull: full({ answeredAt: NOW - 5_000, receivedAt: NOW + 60_000 }) });
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
            return { known: true, tainted: false, pending: false, lastFull: full() };
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
    w.state.evidence = () => ({ known: true, tainted: true, pending: false, lastFull: full() });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "tainted")]);
    expect(w.calls.length).toBe(0);
  });

  test("#9 그 실행기 줄에 held 인사·retry·밀린 사본이 남았으면(pending) 0회다", () => {
    const w = world();
    const live = started(w.ledger);
    w.state.evidence = () => ({ known: true, tainted: false, pending: true, lastFull: full() });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "pending")]);
    expect(w.calls.length).toBe(0);
  });

  test("#10 서버를 새로 만들어 옛 밀린 사본을 버린 실행기는 증거가 오염으로 내고 0회다(이 모듈이 보는 칸은 #8과 같다)", () => {
    const w = world();
    const live = started(w.ledger);
    // 새 서버의 첫 인사가 빈 전체 목록이어도 버린 사본이 있었으면 오염이다.
    w.state.evidence = () => ({ known: true, tainted: true, pending: false, lastFull: full({ connection: CONN }) });
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
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, lastFull: full({ stopGeneration: 1 }) });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "stop_generation")]);
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, lastFull: full() });
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
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, lastFull: full({ runs }) });
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
      () => ({ known: true, pending: false, lastFull: full() }),
      () => ({ known: true, tainted: "no", pending: false, lastFull: full() }),
      () => ({ known: true, tainted: false, pending: false, lastFull: { ...full(), runs: "none" } }),
      () => ({ known: true, tainted: false, pending: false, lastFull: { ...full(), runs: [null] } }),
      () => ({ known: true, tainted: false, pending: false, lastFull: { ...full(), answeredAt: 0 } }),
      () => ({ known: true, tainted: false, pending: false, lastFull: { ...full(), answeredAt: null } }),
      () => ({ known: true, tainted: false, pending: false, lastFull: { ...full(), receivedAt: Number.NaN } }),
      () => ({ known: true, tainted: false, pending: false, lastFull: { ...full(), connection: -1 } }),
      () => ({ known: true, tainted: false, pending: false, lastFull: { ...full(), principal: undefined } }),
      () => ({ known: true, tainted: false, pending: false, lastFull: "full" }),
    ];
    for (const [index, read] of broken.entries()) {
      w.state.evidence = read as () => UnreceivedEvidenceRead;
      expect([index, ran(w.tick()).runs]).toEqual([index, [skipped(live, "evidence_unknown")]]);
    }
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, lastFull: null });
    expect(ran(w.tick()).runs).toEqual([skipped(live, "no_full")]);
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, lastFull: full({ principal: OTHER_EXECUTOR }) });
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
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, lastFull: full({ answeredAt: NOW + 29_999, receivedAt: NOW + 90_000 }) });
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
      executorId === OTHER_EXECUTOR ? { known: false } : { known: true, tainted: false, pending: false, lastFull: full() };
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
    w.state.evidence = () => ({ known: true, tainted: false, pending: false, lastFull: full({ runs: runs as unknown as UnreceivedFull["runs"] }) });
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
});

describe("정적", () => {
  const code = async (path: string) =>
    (await readText(path))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
  const FILE = "src/supervisor/dispatch/unreceived.ts";

  test("기다리지 않고, 시계·난수·타이머·환경·파일을 직접 쓰지 않으며, 장부에는 닫기 하나만 쓴다", async () => {
    const source = await code(FILE);
    for (const banned of [/\bawait\b/, /\basync\b/, /\.then\s*\(/, /\bDate\b/, /\bperformance\b/, /\bMath\.random\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bprocess\b/, /\bBun\b/, /["']node:/, /["']bun:/]) {
      expect([String(banned), banned.test(source)]).toEqual([String(banned), false]);
    }
    const ledgerCalls = [...source.matchAll(/ledger\.(\w+)\s*\(/g)].map((match) => match[1]).sort();
    expect(ledgerCalls).toEqual(["closeUnreceivedRun", "unansweredInstructions"]);
  });

  test("연결 재확인은 장부 호출 직전의 마지막 포트 호출이다(그 사이에 ports.를 부르지 않는다)", async () => {
    const source = await code(FILE);
    const check = source.indexOf("linkCurrent(ports.links, full.connection, item.executorId)");
    const call = source.indexOf("ports.ledger.closeUnreceivedRun(");
    expect([check > 0, call > check]).toEqual([true, true]);
    expect(source.slice(check + "linkCurrent(ports.links".length, call).includes("ports.")).toBe(false);
    // 대조군: 사이에 포트를 부르면 잡는다.
    const broken = source.replace("let answer: unknown;", "ports.evidence.read(item.executorId);\n  let answer: unknown;");
    expect(broken.slice(broken.indexOf("linkCurrent(ports.links") + "linkCurrent(ports.links".length, broken.indexOf("ports.ledger.closeUnreceivedRun(")).includes("ports.")).toBe(true);
  });
});
