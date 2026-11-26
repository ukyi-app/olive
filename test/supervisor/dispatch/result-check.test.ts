// 결과 검사 박자(src/supervisor/dispatch/result-check.ts). 실제 임시 장부에 checking 실행과 결과 보고를 적고 박자를 부른다.
// "한 줄" 사례는 실제 순서기에 실제 결과 검사·수명 박자를 묶어 한 박자에 판정 → 확정 기록까지 본다. 나머지 박자는 아무것도 하지 않는다.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type Envelope, limits, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import { RESTORE_KEY } from "../../../src/ledger/ledger.ts";
import { lifeTick } from "../../../src/supervisor/dispatch/life-loop.ts";
import {
  type PendingResult,
  type ResultCheckPolicy,
  type ResultCheckPorts,
  type ResultCheckTickResult,
  resultCheckTick,
  resultVerdict,
} from "../../../src/supervisor/dispatch/result-check.ts";
import { createCycle } from "../../../src/supervisor/runtime/cycle.ts";
import { createSharedClock } from "../../../src/supervisor/runtime/shared-clock.ts";
import { readText } from "../../files.ts";
import { digest, from, id, must, NOW, open, ready, session, tempPath, worker, WORKER_EXECUTOR } from "../../ledger/helpers.ts";

const keys = generateKeyPairSync("ed25519");

interface World {
  ledger: Ledger;
  path: string;
  ports: ResultCheckPorts;
  // markResult에 넘긴 입력(장부에 닿은 차례).
  marks: unknown[];
  setClock(at: number): void;
  setIntake(open: boolean): void;
  setValid(open: boolean): void;
  // 장부 포트의 함수를 바꿔 끼운다.
  wrap(over: Partial<ResultCheckPorts["ledger"]>): void;
  // 기한 시작의 사실(D-123)을 바꾼다. 기본은 복원 5단계 NOW, 인정 NOW - RENEW_INTERVAL_MS다: 둘 다 종료 영수증(NOW + 1)보다 이르고
  // 인정 뒤 재전송 한 주기가 지났으므로 기한은 종료 영수증부터 센다. 단조 경과 셋의 기본은 한 시간(LONG)이라 장부 시각이 판정을 가른다.
  // 답한 조회의 기본(ANSWERED)은 NOW + 2·복원·인정 가운데 늦은 때 + 재전송 한 주기에 실은 조회이고, 그 단조 경과는 0이다: 기한 시작
  // 뒤 한 주기에 실은 조회에 실행기가 방금 답했다. 그래서 기본값으로는 이 조건이 다른 조건의 경계를 바꾸지 않는다.
  setReach(facts: ReachFacts): void;
  // greetedAt·sinceGreetedMs·answeredAt·sinceAnsweredMs에 넘긴 실행기 이름, sinceSeenMs에 넘긴 실행 ID(부른 차례).
  greeted: string[];
  seen: string[];
  answered: string[];
}

// 단조 경과의 기본값. 이 파일의 어떤 기한보다 길다.
const LONG = 3_600_000;
type ReachFacts = {
  restoredAt?: unknown;
  greetedAt?: unknown;
  sinceRestoredMs?: unknown;
  sinceGreetedMs?: unknown;
  sinceSeenMs?: unknown;
  answeredAt?: unknown;
  sinceAnsweredMs?: unknown;
};
const ANSWERED = Symbol("기한 시작 + 한 주기에 실은 조회");

function world(ledger?: Ledger, path?: string): World {
  let clockAt = NOW;
  const file = path ?? tempPath();
  const real = ledger ?? ready(open(file, { clock: () => clockAt }));
  const marks: unknown[] = [];
  let intake = true;
  let valid = true;
  let override: Partial<ResultCheckPorts["ledger"]> = {};
  let reach: Required<ReachFacts> = {
    restoredAt: NOW,
    greetedAt: NOW - limits.RENEW_INTERVAL_MS,
    sinceRestoredMs: LONG,
    sinceGreetedMs: LONG,
    sinceSeenMs: LONG,
    answeredAt: ANSWERED,
    sinceAnsweredMs: 0,
  };
  const greeted: string[] = [];
  const seen: string[] = [];
  const answered: string[] = [];
  const answeredDefault = () => Math.max(NOW + 2, ...[reach.restoredAt, reach.greetedAt].filter((at): at is number => typeof at === "number")) + limits.RENEW_INTERVAL_MS;
  const ports: ResultCheckPorts = {
    ledger: {
      listRuns: () => (override.listRuns ?? real.listRuns.bind(real))(),
      pendingReports: () => (override.pendingReports ?? real.pendingReports.bind(real))(),
      markResult: (input) => {
        marks.push(input);
        return (override.markResult ?? real.markResult.bind(real))(input);
      },
    },
    intake: { intakeOpen: () => intake && real.intakeOpen() },
    beatValid: () => valid,
    reach: {
      restoredAt: () => reach.restoredAt as number | null,
      greetedAt: (executorId) => {
        greeted.push(executorId);
        return reach.greetedAt as number | null;
      },
      sinceRestoredMs: () => reach.sinceRestoredMs as number | null,
      sinceGreetedMs: (executorId) => {
        greeted.push(executorId);
        return reach.sinceGreetedMs as number | null;
      },
      sinceSeenMs: (runId) => {
        seen.push(runId);
        return reach.sinceSeenMs as number | null;
      },
      answeredAt: (executorId) => {
        answered.push(executorId);
        return (reach.answeredAt === ANSWERED ? answeredDefault() : reach.answeredAt) as number | null;
      },
      sinceAnsweredMs: (executorId) => {
        answered.push(executorId);
        return reach.sinceAnsweredMs as number | null;
      },
    },
  };
  return {
    ledger: real,
    path: file,
    ports,
    marks,
    greeted,
    seen,
    answered,
    setReach: (facts) => {
      reach = { ...reach, ...facts };
    },
    setClock: (at) => {
      clockAt = at;
    },
    setIntake: (value) => {
      intake = value;
    },
    setValid: (value) => {
      valid = value;
    },
    wrap: (over) => {
      override = over;
    },
  };
}

// 작업자 실행을 시작·접수하고 completed 종료 영수증으로 checking까지 옮긴다.
function checking(ledger: Ledger) {
  const run = must(ledger.admitRun(worker())).run;
  const requestId = id();
  must(ledger.startRun({ runId: run.runId, requestId, stopGeneration: 0, now: NOW }));
  const sender = from(run);
  must(ledger.applyReceipt({ action: "receipt_accepted", instruction: "task_start", receiptId: id(), runId: run.runId, instructionRequestId: requestId, bodyDigest: digest(`accepted:${run.runId}`), now: NOW }, sender));
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: run.runId, exit: "completed", bodyDigest: digest(`stopped:${run.runId}`), now: NOW + 1 }, sender));
  return { runId: run.runId, from: sender };
}

// 결과 보고 하나를 저장 자리와 함께 적는다(반영 전).
function report(ledger: Ledger, run: { runId: string; from: { sender: string; runGeneration: number } }, body: string, at = NOW + 2) {
  const reportId = id();
  const resultDigest = digest(body);
  const storedRef = `results/${id()}`;
  must(ledger.recordReport({ reportId, action: "report_result", runId: run.runId, bodyDigest: digest(`report:${reportId}`), storedRef, resultDigest, signal: null, now: at }, run.from));
  return { reportId, resultDigest, storedRef };
}

// 작업자 자리는 하나라 checking 실행 둘을 장부로 만들 수 없다. 둘째 실행은 실행 목록·반영 전 보고에 한 줄씩 지어 붙이고, 그 실행의 판정
// 답은 second가 낸다(부르지 않으면 지은 답도 없다). 첫째 실행의 판정은 first가 낸다(기본은 실제 장부).
function withSecond(w: World, first: (input: Parameters<Ledger["markResult"]>[0]) => unknown = (input) => w.ledger.markResult(input)) {
  const runId = id();
  const reportId = id();
  const resultDigest = digest(`둘째:${runId}`);
  w.wrap({
    listRuns: () => {
      const read = w.ledger.listRuns();
      return read.known ? { known: true, value: [...read.value, { ...read.value[0]!, runId, state: "checking" }] } : read;
    },
    pendingReports: () => {
      const read = w.ledger.pendingReports();
      return read.known ? { known: true, value: [...read.value, { reportId, action: "report_result", runId, storedRef: `results/${reportId}`, resultDigest }] } : read;
    },
    markResult: ((input: Parameters<Ledger["markResult"]>[0]) =>
      input.runId === runId ? { ok: true, run: { runId, state: "ready_result", resultDigest } } : first(input)) as never,
  });
  return { runId, reportId, resultDigest };
}

function stateOf(ledger: Ledger, runId: string): string {
  const read = ledger.getRun(runId);
  return read.known && read.value !== null ? read.value.state : "unknown";
}

function pendingIds(ledger: Ledger): string[] {
  const read = ledger.pendingReports();
  if (!read.known) throw new Error("반영 전 보고를 읽지 못함");
  return read.value.map((item) => item.reportId);
}

function ranOf(result: ResultCheckTickResult): Extract<ResultCheckTickResult, { kind: "ran" }> {
  if (result.kind !== "ran") throw new Error(`박자가 돌지 않음: ${JSON.stringify(result)}`);
  return result;
}

const AT = NOW + 5_000;

describe("한 줄: 결과 보고 → 판정 → 확정", () => {
  test("checking 실행의 결과 보고 하나를 한 박자의 결과 검사가 ready_result로 판정하고, 같은 박자의 수명 박자가 확정을 적고 내보낸다", async () => {
    let wall = NOW + 10_000;
    const shared = createSharedClock({ now: () => wall });
    const ledger = ready(open(tempPath(), { clock: () => shared.now() }));
    const run = checking(ledger);
    const result = report(ledger, run, "결과 본문");
    const marks: unknown[] = [];
    const sent: Envelope[] = [];
    const intake = { intakeOpen: () => ledger.intakeOpen(), stopGeneration: () => 0 };
    const idle = (kind: string) => ({ kind: "not_run", reason: kind }) as never;
    const cycle = createCycle({
      beats: {
        linkLoss: () => idle("link_loss"),
        resultCheck: (now) =>
          resultCheckTick(
            {
              ledger: {
                listRuns: () => ledger.listRuns(),
                pendingReports: () => ledger.pendingReports(),
                markResult: (input) => {
                  marks.push(input);
                  return ledger.markResult(input);
                },
              },
              intake,
              beatValid: () => true,
            },
            now,
          ),
        life: (clock, input) =>
          lifeTick(
            {
              ledger,
              intake,
              links: { mayIssue: () => ({ ok: true }) },
              clock,
              random: { bytes: (length) => getRandomValues(new Uint8Array(length)) },
              signer: { seal: (draft) => sealEnvelope(draft, keys.privateKey) },
              sink: {
                send: async (envelope) => {
                  sent.push(envelope);
                  return "sent";
                },
              },
              beatValid: () => true,
            },
            { renewEveryMs: 10_000, answerTimeoutMs: 20_000 },
            input,
          ),
        resend: async () => idle("resend"),
        unreceived: () => idle("unreceived"),
        assign: async () => idle("assign"),
      },
      serverTick: () => {},
      ledgerClock: shared,
      monotonic: { now: () => 1 },
      restoreDone: () => true,
      ledger,
      policy: { judgeMs: 30_000, resendEveryMs: 5_000, assignCallsPerBeat: 1 },
    });

    const beat = await cycle.beat();
    if (beat.kind !== "ran" || beat.resultCheck.kind !== "returned" || beat.life.kind !== "returned" || beat.life.result.kind !== "ran") throw new Error(JSON.stringify(beat));
    expect(beat.resultCheck.result).toEqual({
      kind: "ran",
      runs: [{ runId: run.runId, outcome: "judged", reportId: result.reportId, resultDigest: result.resultDigest, state: "ready_result" }],
      halted: null,
      haltedAt: null,
    });
    // 판정에 그 보고의 reportId를 넘겼다(장부가 그 보고와 digest를 대조한다. 확정이 열리는 것은 reportId와 상관없이 장부가 판정에서 보고를 반영해서다).
    expect(marks).toEqual([{ runId: run.runId, resultDigest: result.resultDigest, reportId: result.reportId, now: NOW + 10_000 }]);
    expect(ledger.settledResult(run.runId)).toEqual({ known: true, value: { runId: run.runId, resultDigest: result.resultDigest, storedRef: result.storedRef, storedAt: NOW + 2 } });
    expect(beat.life.result.runs).toEqual([expect.objectContaining({ runId: run.runId, outcome: "finalize_sent" })]);
    expect(sent.map((envelope) => [envelope.header.action, envelope.body])).toEqual([
      ["result_finalize", { run_id: run.runId, outcome: "succeeded", result_digest: result.resultDigest, stored_at: NOW + 2 }],
    ]);
    const unanswered = ledger.unansweredInstructions();
    expect(unanswered.known ? unanswered.value.instructions.filter((item) => item.action === "result_finalize").map((item) => item.runId) : unanswered).toEqual([run.runId]);
    expect([stateOf(ledger, run.runId), pendingIds(ledger)]).toEqual(["ready_result", []]);

    // 다음 박자는 그 실행을 다시 판정하지 않는다(checking이 아니다).
    wall += 1_000;
    const again = await cycle.beat();
    expect(again.kind === "ran" && again.resultCheck.kind === "returned" ? again.resultCheck.result : again).toEqual({ kind: "ran", runs: [], halted: null, haltedAt: null });
    expect(marks).toHaveLength(1);
  });
});

describe("판정 자리", () => {
  const item = (body: string): PendingResult => ({ reportId: id(), resultDigest: digest(body), storedRef: `results/${id()}` });

  test("보고가 없으면 기다림, digest 하나면 첫 보고로 통과, 서로 다른 digest가 있으면 충돌(digest 수)", () => {
    const a = item("a");
    const a2 = { ...item("x"), resultDigest: a.resultDigest };
    const b = item("b");
    expect(resultVerdict([])).toEqual({ kind: "wait" });
    expect(resultVerdict([a, a2])).toEqual({ kind: "pass", resultDigest: a.resultDigest, reportId: a.reportId });
    expect(resultVerdict([a, b, a2])).toEqual({ kind: "conflict", digests: 2 });
  });
});

describe("판정", () => {
  test("같은 digest의 보고가 둘이면 첫 보고의 reportId로 한 번 판정하고 장부가 둘 다 반영한다. 다음 박자의 같은 실행 판정은 0이다", () => {
    const w = world();
    const run = checking(w.ledger);
    const first = report(w.ledger, run, "본문", NOW + 2);
    report(w.ledger, run, "본문", NOW + 3);
    expect(ranOf(resultCheckTick(w.ports, AT)).runs).toEqual([{ runId: run.runId, outcome: "judged", reportId: first.reportId, resultDigest: first.resultDigest, state: "ready_result" }]);
    expect([stateOf(w.ledger, run.runId), pendingIds(w.ledger), w.marks.length]).toEqual(["ready_result", [], 1]);
    expect(resultCheckTick(w.ports, AT + 1)).toEqual({ kind: "ran", runs: [], halted: null, haltedAt: null });
    expect(w.marks).toHaveLength(1);
  });

  test("다른 digest가 섞이면 판정하지 않고 digest_conflict로 남긴다(장부 호출 0, 보고는 반영 전 그대로)", () => {
    const w = world();
    const run = checking(w.ledger);
    const a = report(w.ledger, run, "본문 a");
    const b = report(w.ledger, run, "본문 b", NOW + 3);
    for (const at of [AT, AT + 1_000]) {
      expect(ranOf(resultCheckTick(w.ports, at)).runs).toEqual([{ runId: run.runId, outcome: "digest_conflict", digests: 2, reports: 2 }]);
    }
    expect([w.marks.length, stateOf(w.ledger, run.runId), pendingIds(w.ledger)]).toEqual([0, "checking", [a.reportId, b.reportId]]);
  });

  test("보고가 없는 checking은 기다린다(장부 호출 0). 세션 실행과 checking이 아닌 실행은 결과에 없다", () => {
    const w = world();
    const waiting = checking(w.ledger);
    must(w.ledger.admitRun(session()));
    must(w.ledger.admitRun(worker()));
    expect(ranOf(resultCheckTick(w.ports, AT)).runs).toEqual([{ runId: waiting.runId, outcome: "waiting" }]);
    expect(w.marks).toEqual([]);
  });

  test("실행마다 따로 판정하고, 장부의 거절은 그 실행의 결과이며 다음 실행은 이어 간다", () => {
    const w = world();
    const one = checking(w.ledger);
    const r1 = report(w.ledger, one, "하나");
    const r2 = withSecond(w, () => ({ ok: false, reason: "transition_denied" }));
    const two = r2;
    expect(ranOf(resultCheckTick(w.ports, AT))).toEqual({
      kind: "ran",
      runs: [
        { runId: one.runId, outcome: "refused", reportId: r1.reportId, reason: "transition_denied" },
        { runId: two.runId, outcome: "judged", reportId: r2.reportId, resultDigest: r2.resultDigest, state: "ready_result" },
      ],
      halted: null,
      haltedAt: null,
    });
  });

  test("장부 호출이 던지거나 답이 정의 밖이면 그 자리에서 멈춘다(ledger_failed, halted threw)", () => {
    for (const [name, answer] of [
      ["던짐", () => {
        throw new Error("쓰기 실패");
      }],
      ["객체 아님", () => 7],
      ["거절 이름 아님", () => ({ ok: false, reason: "nope" })],
      ["다른 실행", () => ({ ok: true, run: { runId: id(), state: "ready_result", resultDigest: null } })],
      ["상태가 판정 뒤가 아님", (input: { runId: string; resultDigest: string | null }) => ({ ok: true, run: { runId: input.runId, state: "checking", resultDigest: input.resultDigest } })],
      ["digest 다름", (input: { runId: string }) => ({ ok: true, run: { runId: input.runId, state: "ready_result", resultDigest: digest("other") } })],
    ] as const) {
      const w = world();
      const one = checking(w.ledger);
      const r1 = report(w.ledger, one, "하나");
      withSecond(w, answer as never);
      expect([name, resultCheckTick(w.ports, AT)]).toEqual([
        name,
        { kind: "ran", runs: [{ runId: one.runId, outcome: "ledger_failed", reportId: r1.reportId, reason: name === "던짐" ? "threw" : "malformed_answer" }], halted: "threw", haltedAt: one.runId },
      ]);
      expect([name, w.marks.length]).toEqual([name, 1]);
    }
  });
});

describe("판정하지 않는 때", () => {
  test("복원 전(접수 문 닫힘)·정지 중이면 장부를 부르지 않는다", () => {
    const w = world();
    const run = checking(w.ledger);
    report(w.ledger, run, "본문");
    w.setIntake(false);
    expect(resultCheckTick(w.ports, AT)).toEqual({ kind: "not_run", reason: "intake_closed" });
    w.setIntake(true);
    must(w.ledger.applyStop({ generation: 1, stopped: true, now: NOW + 3 }));
    expect(resultCheckTick(w.ports, AT)).toEqual({ kind: "not_run", reason: "intake_closed" });
    expect([w.marks.length, stateOf(w.ledger, run.runId)]).toEqual([0, "checking"]);
  });

  test("장부 읽기를 모르면(known false, 던짐, 줄의 꼴 틀림, 같은 ID 둘) 장부를 부르지 않는다", () => {
    const w = world();
    const run = checking(w.ledger);
    report(w.ledger, run, "본문");
    const runs = w.ledger.listRuns();
    const reports = w.ledger.pendingReports();
    if (!runs.known || !reports.known) throw new Error("읽기 실패");
    const cases: [string, Partial<ResultCheckPorts["ledger"]>, "runs" | "reports"][] = [
      ["실행 모름", { listRuns: () => ({ known: false, reason: "db_error" }) as never }, "runs"],
      ["실행 던짐", { listRuns: () => {
        throw new Error("읽기 실패");
      } }, "runs"],
      ["실행 줄 꼴 틀림", { listRuns: () => ({ known: true, value: [...runs.value, { runId: "x", kind: "worker", state: "checking" }] }) as never }, "runs"],
      ["실행 같은 ID 둘", { listRuns: () => ({ known: true, value: [...runs.value, ...runs.value] }) }, "runs"],
      ["보고 모름", { pendingReports: () => ({ known: false, reason: "db_error" }) as never }, "reports"],
      ["보고 던짐", { pendingReports: () => {
        throw new Error("읽기 실패");
      } }, "reports"],
      ["보고 줄 꼴 틀림", { pendingReports: () => ({ known: true, value: [...reports.value, { reportId: id(), action: "report_result", runId: run.runId, storedRef: "", resultDigest: digest("b") }] }) as never }, "reports"],
      ["보고 같은 ID 둘", { pendingReports: () => ({ known: true, value: [...reports.value, ...reports.value] }) }, "reports"],
      ["결과 밖 보고 동작 틀림", { pendingReports: () => ({ known: true, value: [...reports.value, { reportId: id(), action: "report_other", runId: run.runId, storedRef: null, resultDigest: null }] }) as never }, "reports"],
    ];
    for (const [name, over, read] of cases) {
      w.wrap(over);
      expect([name, resultCheckTick(w.ports, AT)]).toEqual([name, { kind: "not_run", reason: "read_unknown", read }]);
    }
    expect([w.marks.length, stateOf(w.ledger, run.runId)]).toEqual([0, "checking"]);
  });

  test("장부 호출 직전의 접수 문이나 박자 유효 문이 닫히면 그 실행부터 부르지 않고 멈춘다", () => {
    for (const [close, halt] of [
      ["intake", "intake_closed"],
      ["valid", "beat_closed"],
    ] as const) {
      const w = world();
      const one = checking(w.ledger);
      const r1 = report(w.ledger, one, "하나");
      // 첫 실행의 판정이 장부에 닿은 뒤 문을 닫는다.
      const two = withSecond(w, (input) => {
        const answer = w.ledger.markResult(input);
        if (close === "intake") w.setIntake(false);
        else w.setValid(false);
        return answer;
      });
      expect([close, resultCheckTick(w.ports, AT)]).toEqual([
        close,
        { kind: "ran", runs: [{ runId: one.runId, outcome: "judged", reportId: r1.reportId, resultDigest: r1.resultDigest, state: "ready_result" }], halted: halt, haltedAt: two.runId },
      ]);
      expect([close, w.marks.length]).toEqual([close, 1]);
    }
  });

  test("now가 시각이 아니면 돌지 않고, 포트 안에서 다시 부르면 tick_in_progress다", () => {
    const w = world();
    const run = checking(w.ledger);
    report(w.ledger, run, "본문");
    for (const now of [0, -1, Number.NaN, 1.5]) expect(resultCheckTick(w.ports, now)).toEqual({ kind: "not_run", reason: "now_malformed" });
    const box: { inner: ResultCheckTickResult | null } = { inner: null };
    w.wrap({
      listRuns: () => {
        box.inner = resultCheckTick(w.ports, AT);
        return w.ledger.listRuns();
      },
    });
    expect(ranOf(resultCheckTick(w.ports, AT)).runs).toHaveLength(1);
    expect(box.inner).toEqual({ kind: "not_run", reason: "tick_in_progress" });
    expect(w.marks).toHaveLength(1);
  });
});

describe("재시작", () => {
  test("다시 연 장부의 복원 3단계 뒤 남은 checking과 반영 전 보고도 같은 길로 판정한다", () => {
    const path = tempPath();
    const first = ready(open(path));
    const run = checking(first);
    const result = report(first, run, "재시작 전 본문");
    first.close();

    const ledger = open(path);
    // 복원의 장부 쪽 차례(restore.ts의 step1·step3·step5): 시도 열기 → 진행 중 실행을 모름으로 → 실행·보고 다시 꺼내기 → 접수 허가.
    const attempt = ledger.beginRestore(RESTORE_KEY);
    ledger.pinRestore(RESTORE_KEY, attempt);
    expect(must(ledger.markLost(NOW + 4_000)).runIds).toEqual([]);
    const open3 = ledger.openRuns();
    const reports = ledger.pendingReports();
    expect([open3.known ? open3.value.filter((item) => item.state === "checking").map((item) => item.runId) : open3, reports.known ? reports.value.map((item) => item.reportId) : reports]).toEqual([
      [run.runId],
      [result.reportId],
    ]);
    expect(ledger.grantIntake(RESTORE_KEY, attempt)).toBe(true);

    const w = world(ledger, path);
    expect(ranOf(resultCheckTick(w.ports, AT)).runs).toEqual([{ runId: run.runId, outcome: "judged", reportId: result.reportId, resultDigest: result.resultDigest, state: "ready_result" }]);
    expect(ledger.settledResult(run.runId)).toEqual({ known: true, value: { runId: run.runId, resultDigest: result.resultDigest, storedRef: result.storedRef, storedAt: NOW + 2 } });
  });
});

// 결과 보고 없는 checking의 기한(D-113). 기한 숫자는 이 시험이 지어 넣는 값이다(운영 값은 src/main/supervisor.ts).
const WAIT = 60_000;
const WAITING: ResultCheckPolicy = { reportWaitMs: WAIT };
// checking()은 completed 종료 영수증을 NOW + 1에 적는다. 실행 줄의 updated_at이 그 시각이다.
const SINCE = NOW + 1;

// 실제 순서기에 실제 결과 검사·수명 박자를 묶는다(위 "한 줄"과 같은 꼴, 기한 정책만 넘긴다).
function line(policy: ResultCheckPolicy | undefined) {
  let wall = NOW + 10;
  const shared = createSharedClock({ now: () => wall });
  const ledger = ready(open(tempPath(), { clock: () => shared.now() }));
  const marks: unknown[] = [];
  const sent: Envelope[] = [];
  const intake = { intakeOpen: () => ledger.intakeOpen(), stopGeneration: () => 0 };
  const idle = (kind: string) => ({ kind: "not_run", reason: kind }) as never;
  const cycle = createCycle({
    beats: {
      linkLoss: () => idle("link_loss"),
      resultCheck: (now) =>
        resultCheckTick(
          {
            ledger: {
              listRuns: () => ledger.listRuns(),
              pendingReports: () => ledger.pendingReports(),
              markResult: (input) => {
                marks.push(input);
                return ledger.markResult(input);
              },
            },
            intake,
            beatValid: () => true,
            // 기한은 종료 영수증부터 센다(복원 5단계·인정 모두 그보다 이르고 재전송 한 주기가 지났다). 단조 경과는 모두 충분하다.
            // 실행기는 기한 시작(종료 영수증) + 한 주기에 실은 조회에 방금 답했다.
            reach: {
              restoredAt: () => NOW,
              greetedAt: () => NOW - limits.RENEW_INTERVAL_MS,
              sinceRestoredMs: () => LONG,
              sinceGreetedMs: () => LONG,
              sinceSeenMs: () => LONG,
              answeredAt: () => SINCE + limits.RENEW_INTERVAL_MS,
              sinceAnsweredMs: () => 0,
            },
          },
          now,
          policy,
        ),
      life: (clock, input) =>
        lifeTick(
          {
            ledger,
            intake,
            links: { mayIssue: () => ({ ok: true }) },
            clock,
            random: { bytes: (length) => getRandomValues(new Uint8Array(length)) },
            signer: { seal: (draft) => sealEnvelope(draft, keys.privateKey) },
            sink: {
              send: async (envelope) => {
                sent.push(envelope);
                return "sent";
              },
            },
            beatValid: () => true,
          },
          { renewEveryMs: 10_000, answerTimeoutMs: 20_000 },
          input,
        ),
      resend: async () => idle("resend"),
      unreceived: () => idle("unreceived"),
      assign: async () => idle("assign"),
    },
    serverTick: () => {},
    ledgerClock: shared,
    monotonic: { now: () => 1 },
    restoreDone: () => true,
    ledger,
    policy: { judgeMs: 30_000, resendEveryMs: 5_000, assignCallsPerBeat: 1 },
  });
  const beat = async (at: number) => {
    wall = at;
    const report = await cycle.beat();
    if (report.kind !== "ran" || report.resultCheck.kind !== "returned" || report.life.kind !== "returned" || report.life.result.kind !== "ran") throw new Error(JSON.stringify(report));
    return { resultCheck: report.resultCheck.result, life: report.life.result };
  };
  return { ledger, marks, sent, beat };
}

// 수명 박자 한 번(실제 장부, 고정 시계, 연결은 늘 열림).
async function lifeOnce(ledger: Ledger, at: number) {
  const sent: Envelope[] = [];
  const result = await lifeTick(
    {
      ledger,
      intake: { intakeOpen: () => ledger.intakeOpen(), stopGeneration: () => 0 },
      links: { mayIssue: () => ({ ok: true }) },
      clock: { now: () => at },
      random: { bytes: (length) => getRandomValues(new Uint8Array(length)) },
      signer: { seal: (draft) => sealEnvelope(draft, keys.privateKey) },
      sink: {
        send: async (envelope) => {
          sent.push(envelope);
          return "sent";
        },
      },
      beatValid: () => true,
    },
    { renewEveryMs: 10_000, answerTimeoutMs: 20_000 },
    { lastQueries: [], unsentRenews: [] },
  );
  if (result.kind !== "ran") throw new Error(JSON.stringify(result));
  return { runs: result.runs, sent: sent.map((envelope) => [envelope.header.action, envelope.body]) };
}

// 소유자 입력에 이은 작업자 실행을 시작·접수하고, 그 입력의 취소와 사유 requested의 취소 지시를 NOW + 1에 적는다.
function cancelledRun(ledger: Ledger) {
  const owner = id();
  must(ledger.enqueueInput({ requestId: owner, source: "admin-dm", sourceRef: { ref: `inbox/${id()}`, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
  const run = must(ledger.admitRun(worker({ inputRequestId: owner }))).run;
  const requestId = id();
  must(ledger.startRun({ runId: run.runId, requestId, stopGeneration: 0, now: NOW }));
  const sender = from(run);
  must(ledger.applyReceipt({ action: "receipt_accepted", instruction: "task_start", receiptId: id(), runId: run.runId, instructionRequestId: requestId, bodyDigest: digest(`accepted:${run.runId}`), now: NOW }, sender));
  must(ledger.cancelInput(owner, NOW + 1));
  must(ledger.recordStopInstruction({ runId: run.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW + 1, reason: "requested" }));
  return { runId: run.runId, from: sender };
}

describe("결과 보고 없는 checking의 기한(D-113)과 그 실패 확정(D-114)", () => {
  test("한 줄: completed 종료 뒤 보고가 없으면 기한 전에는 0, 기한 정각에 failed_stopped로 판정하고 같은 박자의 수명 박자가 확정(failed, 판정 시각)을 적고 내보낸다", async () => {
    const l = line(WAITING);
    const run = checking(l.ledger);
    const before = await l.beat(SINCE + WAIT - 1);
    expect(before.resultCheck).toEqual({ kind: "ran", runs: [{ runId: run.runId, outcome: "waiting" }], halted: null, haltedAt: null });
    // 기다리는 checking 실행에는 수명 박자가 같은 실행 ID로 상태 조회만 낸다(결과 검사가 볼 실행기의 답을 얻는 길).
    const query = ["status_query", { run_ids: [run.runId] }];
    expect([l.marks, l.sent.map((envelope) => [envelope.header.action, envelope.body]), stateOf(l.ledger, run.runId)]).toEqual([[], [query], "checking"]);

    const at = await l.beat(SINCE + WAIT);
    expect(at.resultCheck).toEqual({ kind: "ran", runs: [{ runId: run.runId, outcome: "no_result", checkingSince: SINCE, state: "failed_stopped" }], halted: null, haltedAt: null });
    // 결과 없음 판정은 보고 ID 없이 부른다.
    expect(l.marks).toStrictEqual([{ runId: run.runId, resultDigest: null, now: SINCE + WAIT }]);
    expect(l.ledger.failedStop(run.runId)).toEqual({ known: true, value: { runId: run.runId, stoppedAt: SINCE + WAIT, requestedCancel: false, exit: "completed" } });
    expect(at.life.runs).toEqual([expect.objectContaining({ runId: run.runId, outcome: "finalize_sent" })]);
    expect(l.sent.map((envelope) => [envelope.header.action, envelope.body])).toEqual([query, ["result_finalize", { run_id: run.runId, outcome: "failed", result_digest: null, stored_at: SINCE + WAIT }]]);
    const unanswered = l.ledger.unansweredInstructions();
    expect(unanswered.known ? unanswered.value.instructions.filter((item) => item.action === "result_finalize").map((item) => item.rebuild) : unanswered).toEqual([
      { action: "result_finalize", outcome: "failed", resultDigest: null, storedAt: SINCE + WAIT },
    ]);

    // 늦게 온 결과 보고는 장부가 transition_denied로 거절한다(ack 없음, 반영 전 보고에 남지 않음).
    const late = l.ledger.recordReport({ reportId: id(), action: "report_result", runId: run.runId, bodyDigest: digest("late"), storedRef: `results/${id()}`, resultDigest: digest("늦은 결과"), signal: null, now: SINCE + WAIT + 1 }, run.from);
    expect(late).toEqual({ ok: false, reason: "transition_denied" });
    expect(pendingIds(l.ledger)).toEqual([]);
    // 다음 박자는 그 실행을 다시 판정하지 않고 확정을 또 적지 않는다.
    const after = await l.beat(SINCE + WAIT + 1_000);
    expect(after.resultCheck).toEqual({ kind: "ran", runs: [], halted: null, haltedAt: null });
    expect([l.marks.length, l.sent.length, stateOf(l.ledger, run.runId)]).toEqual([1, 2, "failed_stopped"]);
  });

  test("취소 지시(requested) 뒤 cancelled로 끝난 실행은 결과 검사를 거치지 않고 확정 outcome cancelled, stored_at은 failed_stopped가 된 시각이다", async () => {
    const w = world();
    const run = cancelledRun(w.ledger);
    must(w.ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: run.runId, exit: "cancelled", bodyDigest: digest("stopped cancelled"), now: NOW + 2 }, run.from));
    expect(resultCheckTick(w.ports, NOW + 2 + WAIT, WAITING)).toEqual({ kind: "ran", runs: [], halted: null, haltedAt: null });
    expect(w.marks).toEqual([]);
    const life = await lifeOnce(w.ledger, NOW + 10_000);
    expect(life.runs).toEqual([expect.objectContaining({ runId: run.runId, outcome: "finalize_sent" })]);
    expect(life.sent).toEqual([["result_finalize", { run_id: run.runId, outcome: "cancelled", result_digest: null, stored_at: NOW + 2 }]]);
  });

  test("취소 지시(requested)가 적혔는데 completed로 끝나고 보고가 없으면 기한 뒤 판정하고 확정 outcome은 cancelled다", async () => {
    const w = world();
    const run = cancelledRun(w.ledger);
    must(w.ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: run.runId, exit: "completed", bodyDigest: digest("stopped completed"), now: NOW + 2 }, run.from));
    expect(ranOf(resultCheckTick(w.ports, NOW + 2 + WAIT, WAITING)).runs).toEqual([{ runId: run.runId, outcome: "no_result", checkingSince: NOW + 2, state: "failed_stopped" }]);
    const life = await lifeOnce(w.ledger, NOW + 2 + WAIT + 1);
    expect(life.sent).toEqual([["result_finalize", { run_id: run.runId, outcome: "cancelled", result_digest: null, stored_at: NOW + 2 + WAIT }]]);
  });

  test("기한 직전에 보고가 오면 기한 정각의 박자는 그 보고로 ready_result를 판정한다(결과 없음 판정 0)", () => {
    const w = world();
    const run = checking(w.ledger);
    const result = report(w.ledger, run, "직전 본문", SINCE + WAIT - 1);
    expect(ranOf(resultCheckTick(w.ports, SINCE + WAIT, WAITING)).runs).toEqual([{ runId: run.runId, outcome: "judged", reportId: result.reportId, resultDigest: result.resultDigest, state: "ready_result" }]);
    expect(w.marks).toEqual([{ runId: run.runId, resultDigest: result.resultDigest, reportId: result.reportId, now: SINCE + WAIT }]);
    expect(w.ledger.failedStop(run.runId)).toEqual({ known: true, value: null });
  });

  test("기한 1ms 전, 정책 없음, 시계가 그 시각보다 뒤, checking 시각을 읽지 못함이면 기다린다(장부 호출 0)", () => {
    const w = world();
    const run = checking(w.ledger);
    expect(ranOf(resultCheckTick(w.ports, SINCE + WAIT - 1, WAITING)).runs).toEqual([{ runId: run.runId, outcome: "waiting" }]);
    expect(ranOf(resultCheckTick(w.ports, SINCE + 10 * WAIT)).runs).toEqual([{ runId: run.runId, outcome: "waiting" }]);
    expect(ranOf(resultCheckTick(w.ports, SINCE - 1, { reportWaitMs: 1 })).runs).toEqual([{ runId: run.runId, outcome: "waiting" }]);
    for (const updatedAt of [undefined, 0, 1.5, "x"]) {
      w.wrap({
        listRuns: () => {
          const read = w.ledger.listRuns();
          return read.known ? { known: true, value: read.value.map((row) => ({ ...row, updatedAt })) } : read;
        },
      } as never);
      expect([String(updatedAt), ranOf(resultCheckTick(w.ports, SINCE + WAIT, WAITING)).runs]).toEqual([String(updatedAt), [{ runId: run.runId, outcome: "waiting" }]]);
    }
    expect([w.marks.length, stateOf(w.ledger, run.runId)]).toEqual([0, "checking"]);
  });

  test("기한 정책의 꼴이 틀리면 돌지 않는다", () => {
    const w = world();
    checking(w.ledger);
    for (const reportWaitMs of [0, -1, 1.5, Number.NaN, "60000"]) {
      expect([String(reportWaitMs), resultCheckTick(w.ports, SINCE + WAIT, { reportWaitMs } as never)]).toEqual([String(reportWaitMs), { kind: "not_run", reason: "policy_malformed" }]);
    }
    expect(w.marks).toEqual([]);
  });

  test("기한이 지나도 복원 전·정지 중·접수 문 닫힘·장부 읽기 모름이면 결과 없음 판정 0", () => {
    const path = tempPath();
    const first = ready(open(path));
    const run = checking(first);
    first.close();
    // 다시 연 장부는 복원 5단계의 접수 허가 전이다.
    const reopened = world(open(path), path);
    expect(resultCheckTick(reopened.ports, SINCE + WAIT, WAITING)).toEqual({ kind: "not_run", reason: "intake_closed" });
    expect(reopened.marks).toEqual([]);
    reopened.ledger.close();

    const w = world();
    const other = checking(w.ledger);
    w.setIntake(false);
    expect(resultCheckTick(w.ports, SINCE + WAIT, WAITING)).toEqual({ kind: "not_run", reason: "intake_closed" });
    w.setIntake(true);
    const cases: [string, Partial<ResultCheckPorts["ledger"]>, "runs" | "reports"][] = [
      ["실행 모름", { listRuns: () => ({ known: false, reason: "db_error" }) as never }, "runs"],
      ["실행 던짐", { listRuns: () => {
        throw new Error("읽기 실패");
      } }, "runs"],
      ["보고 모름", { pendingReports: () => ({ known: false, reason: "db_error" }) as never }, "reports"],
      ["보고 던짐", { pendingReports: () => {
        throw new Error("읽기 실패");
      } }, "reports"],
    ];
    for (const [name, over, read] of cases) {
      w.wrap(over);
      expect([name, resultCheckTick(w.ports, SINCE + WAIT, WAITING)]).toEqual([name, { kind: "not_run", reason: "read_unknown", read }]);
    }
    w.wrap({});
    must(w.ledger.applyStop({ generation: 1, stopped: true, now: NOW + 3 }));
    expect(resultCheckTick(w.ports, SINCE + WAIT, WAITING)).toEqual({ kind: "not_run", reason: "intake_closed" });
    expect([w.marks.length, stateOf(w.ledger, other.runId), run.runId === other.runId]).toEqual([0, "checking", false]);
  });

  test("결과 없음 판정 직전의 접수 문이나 박자 유효 문이 닫히면 그 실행부터 부르지 않고 멈춘다", () => {
    for (const [close, halt] of [
      ["intake", "intake_closed"],
      ["valid", "beat_closed"],
    ] as const) {
      const w = world();
      const one = checking(w.ledger);
      const r1 = report(w.ledger, one, "하나");
      // 둘째 실행은 보고 없이 기한이 지난 checking이다. 첫 실행의 판정이 장부에 닿은 뒤 문을 닫는다.
      const second = id();
      w.wrap({
        listRuns: () => {
          const read = w.ledger.listRuns();
          return read.known ? { known: true, value: [...read.value, { ...read.value[0]!, runId: second, state: "checking", updatedAt: SINCE }] } : read;
        },
        markResult: ((input: Parameters<Ledger["markResult"]>[0]) => {
          const answer = w.ledger.markResult(input);
          if (close === "intake") w.setIntake(false);
          else w.setValid(false);
          return answer;
        }) as never,
      });
      expect([close, resultCheckTick(w.ports, SINCE + WAIT, WAITING)]).toEqual([
        close,
        { kind: "ran", runs: [{ runId: one.runId, outcome: "judged", reportId: r1.reportId, resultDigest: r1.resultDigest, state: "ready_result" }], halted: halt, haltedAt: second },
      ]);
      expect([close, w.marks.length]).toEqual([close, 1]);
    }
  });

  test("결과 없음 판정의 거절은 그 실행의 결과(reportId null)이고, 답이 failed_stopped가 아니거나 digest가 있으면 멈춘다", () => {
    const answers: [string, (input: { runId: string }) => unknown, Record<string, unknown>, string | null][] = [
      ["거절", () => ({ ok: false, reason: "transition_denied" }), { outcome: "refused", reportId: null, reason: "transition_denied" }, null],
      ["상태가 ready_result", (input) => ({ ok: true, run: { runId: input.runId, state: "ready_result", resultDigest: null } }), { outcome: "ledger_failed", reportId: null, reason: "malformed_answer" }, "threw"],
      ["digest가 있음", (input) => ({ ok: true, run: { runId: input.runId, state: "failed_stopped", resultDigest: digest("x") } }), { outcome: "ledger_failed", reportId: null, reason: "malformed_answer" }, "threw"],
      ["던짐", () => {
        throw new Error("쓰기 실패");
      }, { outcome: "ledger_failed", reportId: null, reason: "threw" }, "threw"],
    ];
    for (const [name, answer, expected, halted] of answers) {
      const w = world();
      const run = checking(w.ledger);
      w.wrap({ markResult: answer as never });
      const result = ranOf(resultCheckTick(w.ports, SINCE + WAIT, WAITING));
      expect([name, result.runs as unknown[], result.halted]).toEqual([name, [{ runId: run.runId, ...expected }], halted]);
      expect([name, stateOf(w.ledger, run.runId)]).toEqual([name, "checking"]);
    }
  });
});

// D-123: 기한은 종료 영수증·복원 5단계를 받아들인 때·그 실행기의 지금 연결이 인정된 때 가운데 가장 늦은 때부터 세고, 그 실행기가
// 연결돼 있고 인정 뒤 재전송 한 주기(계약의 RENEW_INTERVAL_MS)가 지났을 때만 결과 없음으로 판정한다.
const RESEND = limits.RENEW_INTERVAL_MS;

describe("결과 없음 판정의 기한 시작과 연결 조건(D-123)", () => {
  test("감독이 기한보다 오래 멈췄다 다시 뜨면 복원 5단계를 받아들인 때부터 기한을 새로 세고, 그 사이 도착한 재전송 보고를 판정한다", () => {
    // 종료 영수증(SINCE) 뒤 감독이 기한의 두 배 동안 멈췄다. 다시 뜬 감독에 실행기가 곧 인사했고(GREETED), 복원이 늦어 5단계는 그보다
    // 기한만큼 뒤에 받아들였다(RESTORED). 영수증이나 인사부터 세면 5단계 직후의 첫 박자가 결과 없음이다.
    const GREETED = SINCE + 2 * WAIT;
    const RESTORED = GREETED + WAIT;
    const w = world();
    const run = checking(w.ledger);
    w.setReach({ restoredAt: RESTORED, greetedAt: GREETED });
    for (const at of [RESTORED, RESTORED + WAIT - 1]) {
      expect([at - RESTORED, ranOf(resultCheckTick(w.ports, at, WAITING)).runs]).toEqual([at - RESTORED, [{ runId: run.runId, outcome: "waiting" }]]);
    }
    expect(w.marks).toEqual([]);
    // 실행기가 다시 보낸 결과 보고가 5단계 뒤 기한 안에 닿았다. 기한 정각의 박자는 그 보고로 판정한다.
    const resent = report(w.ledger, run, "다시 보낸 결과", RESTORED + RESEND);
    expect(ranOf(resultCheckTick(w.ports, RESTORED + WAIT, WAITING)).runs).toEqual([
      { runId: run.runId, outcome: "judged", reportId: resent.reportId, resultDigest: resent.resultDigest, state: "ready_result" },
    ]);
    expect(w.marks).toEqual([{ runId: run.runId, resultDigest: resent.resultDigest, reportId: resent.reportId, now: RESTORED + WAIT }]);
    expect(w.greeted.every((name) => name === WORKER_EXECUTOR)).toBe(true);

    // 보고가 끝내 오지 않으면 5단계부터 센 기한 정각에 판정한다(checkingSince는 그대로 종료 영수증 시각).
    const quiet = world();
    const silent = checking(quiet.ledger);
    quiet.setReach({ restoredAt: RESTORED, greetedAt: GREETED });
    expect(ranOf(resultCheckTick(quiet.ports, RESTORED + WAIT - 1, WAITING)).runs).toEqual([{ runId: silent.runId, outcome: "waiting" }]);
    expect(ranOf(resultCheckTick(quiet.ports, RESTORED + WAIT, WAITING)).runs).toEqual([{ runId: silent.runId, outcome: "no_result", checkingSince: SINCE, state: "failed_stopped" }]);
    expect(quiet.marks).toStrictEqual([{ runId: silent.runId, resultDigest: null, now: RESTORED + WAIT }]);
  });

  test("실행기 연결이 기한보다 오래 끊겼다 돌아오면 끊긴 동안은 판정하지 않고, 다시 인정된 때부터 기한을 센다", () => {
    const w = world();
    const run = checking(w.ledger);
    const waiting = [{ runId: run.runId, outcome: "waiting" as const }];
    // 영수증 직후 연결이 끊겼다(인정된 연결 없음). 영수증부터 기한의 세 배가 지나도 기다린다.
    w.setReach({ greetedAt: null });
    for (const at of [SINCE + WAIT, SINCE + 3 * WAIT]) expect([at - SINCE, ranOf(resultCheckTick(w.ports, at, WAITING)).runs]).toEqual([at - SINCE, waiting]);
    // 그때 다시 인정됐다. 재전송 한 주기가 지나도 기한은 그 인정부터다.
    const BACK = SINCE + 3 * WAIT;
    w.setReach({ greetedAt: BACK });
    for (const at of [BACK + RESEND, BACK + WAIT - 1]) expect([at - BACK, ranOf(resultCheckTick(w.ports, at, WAITING)).runs]).toEqual([at - BACK, waiting]);
    expect(w.marks).toEqual([]);
    expect(ranOf(resultCheckTick(w.ports, BACK + WAIT, WAITING)).runs).toEqual([{ runId: run.runId, outcome: "no_result", checkingSince: SINCE, state: "failed_stopped" }]);
    expect(w.marks).toStrictEqual([{ runId: run.runId, resultDigest: null, now: BACK + WAIT }]);
  });

  test("그 실행기의 인정된 연결이 없거나 기한 시작의 사실을 모르면(포트 없음·null·던짐·꼴 틀림·실행 줄의 실행기 모름) 기한이 한참 지나도 판정 0", () => {
    const w = world();
    const run = checking(w.ledger);
    const late = SINCE + 10 * WAIT;
    const waiting = [{ runId: run.runId, outcome: "waiting" as const }];
    const boom = () => {
      throw new Error("읽기 실패");
    };
    const facts: [string, ReachFacts][] = [
      ["연결 없음", { greetedAt: null }],
      ["인정 시각 꼴 틀림 0", { greetedAt: 0 }],
      ["인정 시각 꼴 틀림 1.5", { greetedAt: 1.5 }],
      ["인정 시각 꼴 틀림 문자", { greetedAt: String(NOW) }],
      ["인정 시각 undefined", { greetedAt: undefined }],
      ["5단계 전", { restoredAt: null }],
      ["5단계 시각 꼴 틀림", { restoredAt: -1 }],
    ];
    for (const [name, over] of facts) {
      w.setReach({ restoredAt: NOW, greetedAt: NOW - RESEND, ...over });
      expect([name, ranOf(resultCheckTick(w.ports, late, WAITING)).runs]).toEqual([name, waiting]);
    }
    w.setReach({ restoredAt: NOW, greetedAt: NOW - RESEND });
    const ports: [string, ResultCheckPorts][] = [
      ["포트 없음", { ...w.ports, reach: undefined }],
      ["인정 읽기 던짐", { ...w.ports, reach: { ...w.ports.reach!, restoredAt: () => NOW, greetedAt: boom } }],
      ["5단계 읽기 던짐", { ...w.ports, reach: { ...w.ports.reach!, restoredAt: boom, greetedAt: () => NOW } }],
      ["포트 접근자 던짐", Object.defineProperty({ ...w.ports }, "reach", { get: boom })],
    ];
    for (const [name, each] of ports) expect([name, ranOf(resultCheckTick(each, late, WAITING)).runs]).toEqual([name, waiting]);
    for (const executorId of [undefined, "", 7]) {
      w.wrap({
        listRuns: () => {
          const read = w.ledger.listRuns();
          return read.known ? { known: true, value: read.value.map((row) => ({ ...row, executorId })) } : read;
        },
      } as never);
      expect([String(executorId), ranOf(resultCheckTick(w.ports, late, WAITING)).runs]).toEqual([String(executorId), waiting]);
    }
    expect([w.marks.length, stateOf(w.ledger, run.runId)]).toEqual([0, "checking"]);
    // 같은 실행이 연결과 사실을 되찾으면 판정한다(위의 0이 다른 이유로 막힌 것이 아니다).
    w.wrap({});
    expect(ranOf(resultCheckTick(w.ports, late, WAITING)).runs).toEqual([{ runId: run.runId, outcome: "no_result", checkingSince: SINCE, state: "failed_stopped" }]);
  });

  test("다시 인정된 뒤 재전송 한 주기 전에는 기한이 더 짧아도 판정 0이고, 그 정각부터 판정한다(시계가 인정 시각보다 뒤여도 0)", () => {
    // 기한(1초)이 재전송 한 주기(10초)보다 짧은 정책. 기한만 보면 인정 1초 뒤에 판정한다.
    const SHORT: ResultCheckPolicy = { reportWaitMs: 1_000 };
    const w = world();
    const run = checking(w.ledger);
    const BACK = SINCE + 5_000;
    w.setReach({ greetedAt: BACK });
    for (const at of [BACK - 1, BACK + SHORT.reportWaitMs, BACK + RESEND - 1]) {
      expect([at - BACK, ranOf(resultCheckTick(w.ports, at, SHORT)).runs]).toEqual([at - BACK, [{ runId: run.runId, outcome: "waiting" }]]);
    }
    expect(w.marks).toEqual([]);
    expect(ranOf(resultCheckTick(w.ports, BACK + RESEND, SHORT)).runs).toEqual([{ runId: run.runId, outcome: "no_result", checkingSince: SINCE, state: "failed_stopped" }]);
    expect(w.marks).toStrictEqual([{ runId: run.runId, resultDigest: null, now: BACK + RESEND }]);
  });

  test("장부 시각으로는 기한이 지났어도 단조 경과(처음 본 뒤·5단계 뒤·인정 뒤) 하나라도 기한 전이거나 모르면 판정 0이고, 모두 정각이면 판정한다", () => {
    // 벽시계만 앞으로 뛴 경우다: 장부 시각은 종료 영수증부터 기한 정각인데 이 프로세스가 실제로 기다린 시간은 모자란다. 종료 영수증이
    // 기준일 때는 처음 본 뒤의 경과가 그 단조 쪽 기준이다.
    const w = world();
    const run = checking(w.ledger);
    const at = SINCE + WAIT;
    const waiting = [{ runId: run.runId, outcome: "waiting" as const }];
    const boom = () => {
      throw new Error("읽기 실패");
    };
    const enough = { sinceRestoredMs: LONG, sinceGreetedMs: LONG, sinceSeenMs: LONG };
    const cases: [string, ReachFacts][] = [
      ["처음 본 뒤 기한 1ms 전", { sinceSeenMs: WAIT - 1 }],
      ["5단계 뒤 기한 1ms 전", { sinceRestoredMs: WAIT - 1 }],
      ["인정 뒤 기한 1ms 전", { sinceGreetedMs: WAIT - 1 }],
      ["단조 시계가 뒤로 감", { sinceSeenMs: -1 }],
      ["처음 본 때 모름", { sinceSeenMs: null }],
      ["5단계 단조 모름", { sinceRestoredMs: null }],
      ["인정 단조 모름", { sinceGreetedMs: null }],
      ["NaN", { sinceGreetedMs: Number.NaN }],
      ["무한", { sinceRestoredMs: Number.POSITIVE_INFINITY }],
      ["문자", { sinceSeenMs: String(LONG) }],
    ];
    for (const [name, over] of cases) {
      w.setReach({ ...enough, ...over });
      expect([name, ranOf(resultCheckTick(w.ports, at, WAITING)).runs]).toEqual([name, waiting]);
    }
    w.setReach(enough);
    for (const [name, method] of [
      ["처음 본 때 던짐", "sinceSeenMs"],
      ["5단계 단조 던짐", "sinceRestoredMs"],
      ["인정 단조 던짐", "sinceGreetedMs"],
    ] as const) {
      expect([name, ranOf(resultCheckTick({ ...w.ports, reach: { ...w.ports.reach!, [method]: boom } }, at, WAITING)).runs]).toEqual([name, waiting]);
    }
    expect([w.marks.length, stateOf(w.ledger, run.runId)]).toEqual([0, "checking"]);
    // 처음 본 때는 그 실행 ID로, 인정된 연결이 없어 기다리는 박자에서도 묻는다(그동안에도 그 실행을 이미 보고 있었다).
    const asked = w.seen.length;
    w.setReach({ greetedAt: null });
    expect(ranOf(resultCheckTick(w.ports, at, WAITING)).runs).toEqual(waiting);
    expect([w.seen.length - asked, [...new Set(w.seen)]]).toEqual([1, [run.runId]]);
    // 셋 모두 기한 정각이면 판정한다(위의 0이 다른 이유로 막힌 것이 아니다).
    w.setReach({ greetedAt: NOW - RESEND, sinceRestoredMs: WAIT, sinceGreetedMs: WAIT, sinceSeenMs: WAIT });
    expect(ranOf(resultCheckTick(w.ports, at, WAITING)).runs).toEqual([{ runId: run.runId, outcome: "no_result", checkingSince: SINCE, state: "failed_stopped" }]);
    expect(w.marks).toStrictEqual([{ runId: run.runId, resultDigest: null, now: at }]);
  });

  test("단조 경과로도 인정 뒤 재전송 한 주기 전이면 기한이 더 짧아도 판정 0이고, 그 정각부터 판정한다", () => {
    const SHORT: ResultCheckPolicy = { reportWaitMs: 1_000 };
    const w = world();
    const run = checking(w.ledger);
    // 장부 시각으로는 인정 뒤 한 시간이 지났다. 단조 경과로는 인정 뒤 한 주기 1ms 전이다.
    w.setReach({ sinceGreetedMs: RESEND - 1 });
    expect(ranOf(resultCheckTick(w.ports, SINCE + LONG, SHORT)).runs).toEqual([{ runId: run.runId, outcome: "waiting" }]);
    expect(w.marks).toEqual([]);
    w.setReach({ sinceGreetedMs: RESEND });
    expect(ranOf(resultCheckTick(w.ports, SINCE + LONG, SHORT)).runs).toEqual([{ runId: run.runId, outcome: "no_result", checkingSince: SINCE, state: "failed_stopped" }]);
  });
});

// 인정된 연결 번호만으로는 실행기와 주고받을 수 있는지 모른다(TCP 탐침을 대신 받는 중계). 결과 없음 판정은 그 연결에서 실행기가 답한
// 조회가 있고, 그 조회를 기한 시작 + 재전송 한 주기 이후에 실었을 때만이다(장부 시각과 단조 경과 모두).
describe("결과 없음 판정 전 실행기의 실제 답", () => {
  test("답한 조회가 없거나 기한 시작 + 한 주기 1ms 전에 실었으면 기한이 한참 지나도 판정 0이고, 그 정각에 실었으면 판정한다", () => {
    const w = world();
    const run = checking(w.ledger);
    const late = SINCE + 10 * WAIT;
    const waiting = [{ runId: run.runId, outcome: "waiting" as const }];
    for (const [name, at] of [
      ["답 없음", null],
      ["기한 시작 전에 실음", SINCE - 1],
      ["기한 시작에 실음", SINCE],
      ["한 주기 1ms 전에 실음", SINCE + RESEND - 1],
    ] as const) {
      w.setReach({ answeredAt: at, sinceAnsweredMs: 0 });
      expect([name, ranOf(resultCheckTick(w.ports, late, WAITING)).runs]).toEqual([name, waiting]);
    }
    // 기한 시작이 인정이나 5단계로 늦춰지면 그 때부터 한 주기다(종료 영수증 + 한 주기에 실은 조회로는 모자란다).
    for (const [name, over] of [
      ["인정이 기한 시작", { greetedAt: SINCE + 5_000 }],
      ["5단계가 기한 시작", { restoredAt: SINCE + 5_000 }],
    ] as const) {
      w.setReach({ restoredAt: NOW, greetedAt: NOW - RESEND, ...over, answeredAt: SINCE + RESEND, sinceAnsweredMs: 0 });
      expect([name, ranOf(resultCheckTick(w.ports, late, WAITING)).runs]).toEqual([name, waiting]);
    }
    expect([w.marks.length, stateOf(w.ledger, run.runId)]).toEqual([0, "checking"]);
    w.setReach({ restoredAt: NOW, greetedAt: NOW - RESEND, answeredAt: SINCE + RESEND, sinceAnsweredMs: 0 });
    expect(ranOf(resultCheckTick(w.ports, late, WAITING)).runs).toEqual([{ runId: run.runId, outcome: "no_result", checkingSince: SINCE, state: "failed_stopped" }]);
    expect(w.answered.every((name) => name === WORKER_EXECUTOR)).toBe(true);
  });

  test("장부 시각으로는 넉넉해도 답한 조회를 기준들의 단조 시각 + 한 주기 전에 실었거나 모르면 판정 0이고, 그 정각이면 판정한다", () => {
    const w = world();
    const run = checking(w.ledger);
    const at = SINCE + WAIT;
    const waiting = [{ runId: run.runId, outcome: "waiting" as const }];
    const boom = () => {
      throw new Error("읽기 실패");
    };
    // 단조 기준 셋이 모두 WAIT 전이다. 답한 조회를 실은 뒤의 경과가 WAIT - RESEND보다 크면 기준 + 한 주기보다 일찍 실었다.
    const anchors = { sinceSeenMs: WAIT, sinceRestoredMs: WAIT + 5_000, sinceGreetedMs: WAIT + 9_000 };
    const cases: [string, ReachFacts][] = [
      ["처음 본 때 + 한 주기 1ms 전", { sinceAnsweredMs: WAIT - RESEND + 1 }],
      ["5단계 + 한 주기 1ms 전", { sinceSeenMs: LONG, sinceRestoredMs: WAIT, sinceAnsweredMs: WAIT - RESEND + 1 }],
      ["인정 + 한 주기 1ms 전", { sinceSeenMs: LONG, sinceRestoredMs: LONG, sinceGreetedMs: WAIT, sinceAnsweredMs: WAIT - RESEND + 1 }],
      ["단조 모름", { sinceAnsweredMs: null }],
      ["단조가 뒤로 감", { sinceAnsweredMs: -1 }],
      ["NaN", { sinceAnsweredMs: Number.NaN }],
      ["문자", { sinceAnsweredMs: "0" }],
      ["장부 시각 꼴 틀림", { answeredAt: 1.5 }],
      ["장부 시각이 지금보다 뒤", { answeredAt: at + 1 }],
    ];
    for (const [name, over] of cases) {
      w.setReach({ ...anchors, answeredAt: ANSWERED, sinceAnsweredMs: 0, ...over });
      expect([name, ranOf(resultCheckTick(w.ports, at, WAITING)).runs]).toEqual([name, waiting]);
    }
    w.setReach({ ...anchors, answeredAt: ANSWERED, sinceAnsweredMs: 0 });
    for (const method of ["answeredAt", "sinceAnsweredMs"] as const) {
      expect([method, ranOf(resultCheckTick({ ...w.ports, reach: { ...w.ports.reach!, [method]: boom } }, at, WAITING)).runs]).toEqual([method, waiting]);
    }
    expect([w.marks.length, stateOf(w.ledger, run.runId)]).toEqual([0, "checking"]);
    // 처음 본 때 + 한 주기 정각에 실은 조회면 판정한다(위의 0이 다른 이유로 막힌 것이 아니다).
    w.setReach({ ...anchors, answeredAt: ANSWERED, sinceAnsweredMs: WAIT - RESEND });
    expect(ranOf(resultCheckTick(w.ports, at, WAITING)).runs).toEqual([{ runId: run.runId, outcome: "no_result", checkingSince: SINCE, state: "failed_stopped" }]);
  });

  test("답한 조회는 통과 판정을 막지 않는다: 답이 없어도 반영 전 결과 보고는 판정한다", () => {
    const w = world();
    const run = checking(w.ledger);
    w.setReach({ answeredAt: null, sinceAnsweredMs: null });
    const result = report(w.ledger, run, "본문");
    expect(ranOf(resultCheckTick(w.ports, SINCE + 10 * WAIT, WAITING)).runs).toEqual([
      { runId: run.runId, outcome: "judged", reportId: result.reportId, resultDigest: result.resultDigest, state: "ready_result" },
    ]);
  });
});

describe("정적", () => {
  test("result-check.ts에는 장부 쓰기가 markResult 하나이고, 시계·난수·타이머·환경·송신을 직접 부르지 않는다", async () => {
    const source = (await readText("src/supervisor/dispatch/result-check.ts"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    for (const banned of [/\bDate\b/, /\bperformance\b/, /\bMath\.random\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /\bprocess\b/, /\bBun\b/, /["']node:/, /["']bun:/, /\.send\b/, /\bsendInstruction\b/, /\bReflect\b/]) {
      expect([String(banned), banned.test(source)]).toEqual([String(banned), false]);
    }
    // 장부 메서드 이름 가운데 쓰기로 보이는 것(record·mark·apply·settle·close·admit·start·grant·assign 등)은 markResult뿐이다.
    const writes = [...new Set([...source.matchAll(/\bledger\.(\w+)/g)].map((match) => match[1]))].filter((name) => !["listRuns", "pendingReports"].includes(name as string));
    expect(writes).toEqual(["markResult"]);
  });
});
