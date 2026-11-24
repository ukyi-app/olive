// 결과 검사 박자(src/supervisor/dispatch/result-check.ts). 실제 임시 장부에 checking 실행과 결과 보고를 적고 박자를 부른다.
// "한 줄" 사례는 실제 순서기에 실제 결과 검사·수명 박자를 묶어 한 박자에 판정 → 확정 기록까지 본다. 나머지 박자는 아무것도 하지 않는다.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type Envelope, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import { RESTORE_KEY } from "../../../src/ledger/ledger.ts";
import { lifeTick } from "../../../src/supervisor/dispatch/life-loop.ts";
import {
  type PendingResult,
  type ResultCheckPorts,
  type ResultCheckTickResult,
  resultCheckTick,
  resultVerdict,
} from "../../../src/supervisor/dispatch/result-check.ts";
import { createCycle } from "../../../src/supervisor/runtime/cycle.ts";
import { createSharedClock } from "../../../src/supervisor/runtime/shared-clock.ts";
import { readText } from "../../files.ts";
import { digest, from, id, must, NOW, open, ready, session, tempPath, worker } from "../../ledger/helpers.ts";

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
}

function world(ledger?: Ledger, path?: string): World {
  let clockAt = NOW;
  const file = path ?? tempPath();
  const real = ledger ?? ready(open(file, { clock: () => clockAt }));
  const marks: unknown[] = [];
  let intake = true;
  let valid = true;
  let override: Partial<ResultCheckPorts["ledger"]> = {};
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
  };
  return {
    ledger: real,
    path: file,
    ports,
    marks,
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
    // 판정에 그 보고의 reportId를 넘겼다(넘기지 않으면 settledResult가 null이라 확정이 열리지 않는다).
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
