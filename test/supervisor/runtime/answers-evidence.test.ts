// 답 줄(answers.ts)의 D-90 증거 포트를 실제 닫기 박자(unreceived.ts의 unreceivedTick)와 함께 돌린다. 장부는 임시 폴더의 실제 장부이고
// 공개 함수로만 준비한다. 연결 표는 가짜(greet한 연결이 그 실행기의 지금 인정된 연결)이고 처리기(receipts.ts, hello-answers.ts)는 실제 것이다.
// 박자의 포트는 조립(N5)이 묶을 그대로 같은 답 줄의 evidence·withheld, 답 줄에 넘긴 복원기, 같은 복원 대기 신호다.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { type RunStatus, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { UnreceivedClosureInput } from "../../../src/ledger/index.ts";
import type { HelloConnectionTable } from "../../../src/supervisor/dispatch/hello-answers.ts";
import type { ReceiptLedger } from "../../../src/supervisor/dispatch/receipts.ts";
import {
  type UnreceivedOutcome,
  type UnreceivedPorts,
  type UnreceivedSkip,
  type UnreceivedTickResult,
  unreceivedTick,
} from "../../../src/supervisor/dispatch/unreceived.ts";
import { type AnswerEvidenceBook, type AnswerLinePorts, type AnswerLines, createAnswerEvidenceBook, createAnswerLines } from "../../../src/supervisor/runtime/answers.ts";
import { createQueryBook } from "../../../src/supervisor/runtime/query-book.ts";
import type { Delivered } from "../../../src/supervisor/transport/server.ts";
import { id, must, NOW, open, ready, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";

const R1 = WORKER_EXECUTOR;
const R2 = "executor/diagnosis/1/store-b";
// 시작 지시의 발행은 NOW다. 인사의 서명 시각은 정각 경계(발행 + 30,000), 답 줄이 넘기는 때와 박자의 시각은 그 뒤다.
const SIGNED = NOW + 30_000;
const PASSED = NOW + 30_005;
const AT = NOW + 30_010;
const supervisorKey = generateKeyPairSync("ed25519").privateKey;

type Ran = Extract<UnreceivedTickResult, { kind: "ran" }>;
const ran = (result: UnreceivedTickResult): Ran => {
  if (result.kind !== "ran") throw new Error(`ran이 아니다: ${JSON.stringify(result)}`);
  return result;
};

function verified(sender: string, body: Record<string, unknown>, issuedAt: number) {
  return { ok: true, action: "status_report", header: { sender, action: "status_report", run_generation: 0, body_digest: "d".repeat(64), issued_at: issuedAt }, body } as never;
}

// 연결 표 흉내. greet한 연결만 인사한 연결이고 그 실행기의 지금 인정된 연결이다(실행기마다 하나). 맞춘 세대는 장부와 같은 0.
class FakeTable {
  readonly rows = new Map<number, { principal: string; issuedAt: number; runs: RunStatus[] }>();
  greet(connection: number, principal: string, runs: RunStatus[], issuedAt: number): void {
    for (const [key, row] of this.rows) if (row.principal === principal) this.rows.delete(key);
    this.rows.set(connection, { principal, issuedAt, runs });
  }
  close(connection: number): void {
    this.rows.delete(connection);
  }
  recognized(principal: string): number | null {
    for (const [key, row] of this.rows) if (row.principal === principal) return key;
    return null;
  }
  view(): HelloConnectionTable {
    const rows = new Map(this.rows);
    return {
      get: (key: number) => {
        const row = rows.get(key);
        if (row === undefined) return undefined;
        return { id: key, phase: "greeted", sync: { principal: row.principal, generation: 0 }, greeting: { issued_at: row.issuedAt, runs: row.runs } } as never;
      },
      candidates: () => [...rows.keys()].map((connection) => ({ connection })) as never,
    };
  }
}

// 장부 하나와 그 위의 답 줄 하나, 그 답 줄을 묶은 박자. 시작 지시까지 적고(발행 = NOW) 송신 표식을 남긴 작업자 실행 하나를 둔다.
function world(options: { book?: AnswerEvidenceBook } = {}) {
  // 답 저장의 실패는 장부 포트에서 던져 낸다. 실제 장부의 쓰기 실패는 장부를 고장(broken)으로 두어 닫기(start 모드)까지 거절하므로
  // 증거 포트가 막았는지 가를 수 없다.
  const fault = { failAnswers: 0 };
  const real = ready(open(tempPath()));
  const runId = must(real.admitRun(worker())).run.runId;
  const requestId = id();
  must(real.startRun({ runId, requestId, stopGeneration: 0, now: NOW }));
  must(real.markStartDispatch({ runId, requestId, now: NOW }));

  const table = new FakeTable();
  const gate = { settled: true };
  const hooks = {
    // 답 줄이 장부의 applyExecutorAnswer를 부르기 직전.
    beforeAnswer: null as ((coverage: string) => void) | null,
    // 박자가 전역 포트·증거를 읽을 때(몇 번째 호출인지 함께).
    onPort: null as ((port: "stopGeneration" | "withheld" | "settled", call: number) => void) | null,
    onRead: null as (() => void) | null,
    // 답 줄의 confirm이 연결을 물을 때.
    onCurrent: null as (() => void) | null,
  };
  const answerCalls: string[] = [];
  const ledger: ReceiptLedger = {
    applyReceipt: (input, from) => real.applyReceipt(input, from),
    recordReport: (input, from) => real.recordReport(input, from),
    applyExecutorAnswer(input, from) {
      answerCalls.push(`${input.coverage}:${input.runs.map((r) => r.state).join(",")}`);
      hooks.beforeAnswer?.(input.coverage);
      if (fault.failAnswers > 0) {
        fault.failAnswers -= 1;
        throw new Error("장부 포트 실패");
      }
      return real.applyExecutorAnswer(input, from);
    },
  };
  const published = { stopGeneration: () => 0, intakeOpen: () => true };
  const queries = createQueryBook();
  const clock = { now: PASSED };
  const ports: AnswerLinePorts = {
    table: () => table.view(),
    restorer: () => published,
    ledger,
    results: { backend: {} as never, ledger: real },
    random: { bytes: (length) => crypto.getRandomValues(new Uint8Array(length)) },
    signer: { seal: (input) => sealEnvelope(input, supervisorKey) },
    clock: { now: () => clock.now },
    wire: {
      answers: {
        current: (connection, executorId) => {
          hooks.onCurrent?.();
          return table.recognized(executorId) === connection;
        },
      },
      writeAck: () => "sent",
    },
    queries,
    cycle: { noteCandidate: () => {} },
    observationsSettled: () => gate.settled,
    ...(options.book === undefined ? {} : { evidenceBook: options.book }),
  };
  const lines: AnswerLines = createAnswerLines(ports);

  const counts = { stopGeneration: 0, withheld: 0, settled: 0 };
  const closeCalls: UnreceivedClosureInput[] = [];
  const tickPorts = {
    ledger: {
      unansweredInstructions: () => real.unansweredInstructions(),
      closeUnreceivedRun(input: UnreceivedClosureInput, from: { sender: string }) {
        closeCalls.push(input);
        return real.closeUnreceivedRun(input, from);
      },
    },
    evidence: {
      read: (executorId: string) => {
        const read = lines.evidence.read(executorId);
        hooks.onRead?.();
        return read;
      },
      confirm: (executorId: string, connection: number, version: number, generation: number) => lines.evidence.confirm(executorId, connection, version, generation),
    },
    withheld: {
      executors: () => {
        hooks.onPort?.("withheld", ++counts.withheld);
        return lines.withheld.executors();
      },
    },
    intake: {
      stopGeneration: () => {
        hooks.onPort?.("stopGeneration", ++counts.stopGeneration);
        return published.stopGeneration();
      },
    },
    observationsSettled: () => {
      hooks.onPort?.("settled", ++counts.settled);
      return gate.settled;
    },
  } as unknown as UnreceivedPorts;

  const runOf = () => {
    const read = real.getRun(runId);
    if (!read.known || read.value === null) throw new Error("실행 없음");
    return read.value;
  };
  const running = (): RunStatus[] => [{ run_id: runId, state: "running", run_generation: runOf().runGeneration, last_receipt_id: null }];
  const hello = (connection: number, runs: RunStatus[], issuedAt = SIGNED, executorId = R1): void => {
    table.greet(connection, executorId, runs, issuedAt);
    lines.deliver({ kind: "occupancy", connection, answer: { executorId, coverage: "full", runs }, issuedAt } as Delivered);
  };
  // 내보내기 포트가 조회를 싣기 전에 하는 등록과, 그 조회에 같은 연결로 온 상태 보고.
  const status = (connection: number, runs: RunStatus[]): void => {
    const query = { requestId: id(), recipient: R1, runIds: runs.map((r) => r.run_id), connection };
    queries.add(query);
    lines.deliver({ kind: "forward", connection, verified: verified(R1, { in_reply_to: query.requestId, runs }, SIGNED + 1) });
  };
  const live = { requestId, runId, executorId: R1 };
  return {
    real,
    lines,
    table,
    gate,
    hooks,
    fault,
    clock,
    ports,
    answerCalls,
    closeCalls,
    live,
    runOf,
    running,
    hello,
    status,
    tick: () => unreceivedTick(tickPorts, AT),
  };
}

const closedOutcome = (w: ReturnType<typeof world>, connection: number): UnreceivedOutcome => ({ ...w.live, outcome: "closed", connection, answeredAt: SIGNED, at: AT });
const skippedOutcome = (w: ReturnType<typeof world>, reason: UnreceivedSkip): UnreceivedOutcome => ({ ...w.live, outcome: "skipped", reason });

describe("박자 + 실제 답 줄", () => {
  test("연결이 살아 있는데 실행기가 조용히 거절한 실행: 시한 뒤의 빈 full 인사가 반영되면 그 인사로 한 번 불러 닫는다", () => {
    const w = world();
    w.hello(1, []);
    expect(w.lines.evidence.read(R1)).toEqual({
      known: true,
      tainted: false,
      pending: false,
      version: expect.any(Number),
      lastFull: { connection: 1, principal: R1, stopGeneration: 0, runs: [], answeredAt: SIGNED, receivedAt: PASSED },
    });
    expect(w.lines.withheld.executors()).toEqual({ known: true, value: [] });
    expect(ran(w.tick()).runs).toEqual([closedOutcome(w, 1)]);
    expect(w.closeCalls).toEqual([{ runId: w.live.runId, runs: [], answeredAt: SIGNED, receivedAt: PASSED, now: AT }]);
    expect(w.runOf().state).toBe("not_started");
  });

  test("같은 연결의 running 보고가 저장되지 않아 줄(밀린 사본)에 남아 있으면 닫지 않는다(pending, 장부 0회, 자리 점유)", () => {
    const w = world();
    w.hello(1, []);
    w.fault.failAnswers = 1;
    w.status(1, w.running());
    expect(w.lines.backlog(R1).map((copy) => copy.runs[0]?.state)).toEqual(["running"]);
    expect(w.real.hasRunSighting(w.live.runId)).toEqual({ known: true, value: false });
    expect(ran(w.tick()).runs).toEqual([skippedOutcome(w, "pending")]);
    expect(w.closeCalls.length).toBe(0);
    expect(w.runOf().state).not.toBe("not_started");
  });

  test("같은 연결의 running 보고를 처리하는 중(장부 쓰기 직전)에 박자가 돌면 그 보고는 줄에 없어도 대기라 닫지 않는다", () => {
    const w = world();
    w.hello(1, []);
    let inner: UnreceivedTickResult | null = null;
    let pendingInside: unknown = null;
    w.hooks.beforeAnswer = (coverage) => {
      if (coverage !== "partial" || inner !== null) return;
      pendingInside = (w.lines.evidence.read(R1) as { pending?: boolean }).pending;
      inner = w.tick();
    };
    w.status(1, w.running());
    expect(ran(inner as unknown as UnreceivedTickResult).runs).toEqual([skippedOutcome(w, "pending")]);
    expect(w.closeCalls.length).toBe(0);
    expect(pendingInside).toBe(true);
    // 보고는 그 뒤 실제 장부에 적혔다.
    expect(w.real.hasRunSighting(w.live.runId)).toEqual({ known: true, value: true });
    expect(w.runOf().state).not.toBe("not_started");
  });

  test("옛 연결의 양성 인사가 not_current로 버려지고 새 연결의 빈 인사가 반영되면 오염이라 닫지 않는다. 버린 인사가 비었으면 닫는다(대조군)", () => {
    for (const oldRuns of ["positive", "empty"] as const) {
      const w = world();
      w.gate.settled = false;
      const first = oldRuns === "positive" ? [{ run_id: w.live.runId, state: "preparing", run_generation: w.runOf().runGeneration, last_receipt_id: null } as RunStatus] : [];
      w.hello(1, first);
      // 새 연결의 맞춤이 옛 연결을 밀어냈다(서버는 철회를 넘긴다). 그 뒤 새 연결의 인사가 온다.
      w.table.greet(2, R1, [], SIGNED);
      w.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
      w.hello(2, []);
      w.gate.settled = true;
      w.lines.pump();
      const read = w.lines.evidence.read(R1);
      const result = ran(w.tick()).runs;
      expect([oldRuns, result[0]?.outcome]).toEqual([oldRuns, oldRuns === "positive" ? "skipped" : "closed"]);
      expect([oldRuns, read]).toMatchObject([oldRuns, { known: true, tainted: oldRuns === "positive", pending: false, lastFull: { connection: 2 } }]);
      if (oldRuns === "positive") {
        expect(result).toEqual([skippedOutcome(w, "tainted")]);
        expect(w.closeCalls.length).toBe(0);
        expect(w.runOf().state).not.toBe("not_started");
      } else {
        expect(result).toEqual([closedOutcome(w, 2)]);
        expect(w.runOf().state).toBe("not_started");
      }
    }
  });

  test("인사의 연결이 철회됐으면(새 연결의 인사 전) 닫지 않는다(link_not_current)", () => {
    const w = world();
    w.hello(1, []);
    w.table.close(1);
    w.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
    expect(ran(w.tick()).runs).toEqual([skippedOutcome(w, "link_not_current")]);
    expect(w.closeCalls.length).toBe(0);
    expect(w.runOf().state).not.toBe("not_started");
  });
});

describe("박자가 증거를 읽은 뒤의 외부 코드(#66 리뷰의 재현 꼴, 실제 답 줄)", () => {
  test("증거를 읽은 뒤 정지 세대·맡기지 않을 실행기·복원 대기 조회 안에서 같은 연결의 running 보고가 들어오면(저장 실패) 닫지 않는다", () => {
    for (const port of ["stopGeneration", "withheld", "settled"] as const) {
      const w = world();
      w.hello(1, []);
      // 둘째 호출이 항목의 재조회다(첫째는 박자 처음). 증거 읽기 뒤다.
      w.hooks.onPort = (name, call) => {
        if (name !== port || call !== 2) return;
        w.fault.failAnswers = 1;
        w.status(1, w.running());
      };
      expect([port, ran(w.tick()).runs]).toEqual([port, [skippedOutcome(w, "evidence_changed")]]);
      expect([port, w.closeCalls.length, w.lines.backlog(R1).length]).toEqual([port, 0, 1]);
      expect(w.runOf().state).not.toBe("not_started");
    }
  });

  test("read가 돌아온 직후(박자가 칸을 옮기기 전) 같은 보고가 들어와도 confirm이 지금 번호와 견주어 닫지 않는다(고정 번호를 내는 포트)", () => {
    const w = world();
    w.hello(1, []);
    let once = false;
    w.hooks.onRead = () => {
      if (once) return;
      once = true;
      w.fault.failAnswers = 1;
      w.status(1, w.running());
    };
    expect(ran(w.tick()).runs).toEqual([skippedOutcome(w, "evidence_changed")]);
    expect(w.closeCalls.length).toBe(0);
    // 다음 박자는 대기를 본다.
    expect(ran(w.tick()).runs).toEqual([skippedOutcome(w, "pending")]);
  });
});

describe("증거 포트의 꼴과 차례", () => {
  test("read는 데이터 칸만 가진 새 객체를 낸다(목록도 새 배열·새 원소). 고쳐도 다음 읽기는 그대로다", () => {
    const w = world();
    const runs: RunStatus[] = [{ run_id: id(), state: "running", run_generation: 1, last_receipt_id: null }];
    w.hello(1, runs);
    const a = w.lines.evidence.read(R1);
    const b = w.lines.evidence.read(R1);
    if (!a.known || !b.known || a.lastFull === null || b.lastFull === null) throw new Error("증거가 없다");
    const accessors = (value: object) => Object.values(Object.getOwnPropertyDescriptors(value)).filter((d) => !("value" in d)).length;
    expect([accessors(a), accessors(a.lastFull), ...a.lastFull.runs.map(accessors)]).toEqual([0, 0, 0]);
    expect([a === b, a.lastFull === b.lastFull, a.lastFull.runs === b.lastFull.runs, a.lastFull.runs[0] === b.lastFull.runs[0]]).toEqual([false, false, false, false]);
    expect(Object.getPrototypeOf(a.lastFull.runs[0])).toBe(Object.prototype);
    (a.lastFull.runs as RunStatus[]).push(runs[0]!);
    (a.lastFull.runs[0] as { state: string }).state = "stopping";
    (runs[0] as { state: string }).state = "stopping";
    expect(w.lines.evidence.read(R1)).toEqual(b);
  });

  test("confirm은 연결 → 정지 세대 → 변경 번호 차례로 보고, 번호는 앞 조회가 돌아온 뒤에 견주며, 읽기만 한다", () => {
    const w = world();
    w.hello(1, []);
    const read = w.lines.evidence.read(R1);
    if (!read.known) throw new Error("모름");
    const v = read.version;
    // 연결이 아니면 세대·번호가 틀려도 link_not_current, 세대가 틀리면 번호가 틀려도 stop_generation.
    expect(w.lines.evidence.confirm(R1, 2, v + 1, 9)).toBe("link_not_current");
    expect(w.lines.evidence.confirm(R1, 1, v + 1, 9)).toBe("stop_generation");
    expect(w.lines.evidence.confirm(R1, 1, v + 1, 0)).toBe("evidence_changed");
    const answersBefore = w.answerCalls.length;
    expect(w.lines.evidence.confirm(R1, 1, v, 0)).toBe("current");
    // 읽기만 한다: 장부 호출·줄·번호가 그대로다.
    expect([w.answerCalls.length, w.lines.evidence.read(R1)]).toEqual([answersBefore, read]);
    // 연결 조회(외부 코드) 안에서 줄에 답이 들어오면 그 뒤의 번호 비교가 잡는다.
    w.hooks.onCurrent = () => {
      w.hooks.onCurrent = null;
      w.fault.failAnswers = 1;
      w.status(1, w.running());
    };
    expect(w.lines.evidence.confirm(R1, 1, v, 0)).toBe("evidence_changed");
  });

  test("lastFull은 반영된 인사에서만 바뀐다: held·not_current는 바꾸지 않고, 실패한 인사의 retry가 반영되면 그 인사의 옛 연결 번호로 둔다", () => {
    const w = world();
    w.hello(1, []);
    // 접수가 닫힌 동안의 새 연결 인사는 held: 마지막 반영 인사는 연결 1 그대로, 대기다.
    const intake = { open: false };
    const ports = w.ports as { restorer: () => unknown };
    const published = ports.restorer() as { stopGeneration: () => number; intakeOpen: () => boolean };
    published.intakeOpen = () => intake.open;
    w.hello(2, [], SIGNED + 1);
    expect(w.lines.evidence.read(R1)).toMatchObject({ pending: true, lastFull: { connection: 1 } });
    // 접수가 열리고 장부 쓰기가 한 번 실패하면 retry를 쥔다(여전히 연결 1).
    intake.open = true;
    w.fault.failAnswers = 1;
    w.lines.pump();
    expect(w.lines.evidence.read(R1)).toMatchObject({ pending: true, lastFull: { connection: 1 } });
    // 그 사이 연결 3이 맞추면 retry가 반영돼도 lastFull은 연결 2(그 인사의 번호)이고 확인은 연결이 아니다.
    w.table.greet(3, R1, [], SIGNED + 2);
    w.lines.pump();
    const read = w.lines.evidence.read(R1);
    expect(read).toMatchObject({ known: true, tainted: false, lastFull: { connection: 2, answeredAt: SIGNED + 1 } });
    if (!read.known) throw new Error("모름");
    expect(w.lines.evidence.confirm(R1, 2, read.version, 0)).toBe("link_not_current");
  });

  test("변경 번호는 줄지 않고, 서버를 새로 만들어 답 줄을 다시 만들어도 같은 장부로 이어 간다. 앞 줄이 쥔 답이 있던 실행기는 오염, 마지막 반영 인사는 지운다", () => {
    const book = createAnswerEvidenceBook();
    const w = world({ book });
    const r1: number[] = [];
    const read = (lines: AnswerLines, executorId: string) => {
      const value = lines.evidence.read(executorId);
      if (!value.known) throw new Error("모름");
      if (executorId === R1) r1.push(value.version);
      return value;
    };
    read(w.lines, R1);
    w.hello(1, []);
    read(w.lines, R1);
    w.hello(5, [], SIGNED, R2);
    w.fault.failAnswers = 1;
    w.status(1, w.running());
    expect(read(w.lines, R1)).toMatchObject({ pending: true, tainted: false, lastFull: { connection: 1 } });
    const r2Before = read(w.lines, R2);
    expect(r2Before).toMatchObject({ pending: false, tainted: false, lastFull: { connection: 5 } });
    // 새 서버 위의 새 답 줄. 같은 장부를 넘긴다.
    const next = createAnswerLines({ ...w.ports, evidenceBook: book });
    const r1After = read(next, R1);
    const r2After = read(next, R2);
    expect([r1After.tainted, r1After.pending, r1After.lastFull]).toEqual([true, false, null]);
    expect([r2After.tainted, r2After.lastFull, r2After.version > r2Before.version]).toEqual([false, null, true]);
    // 앞 줄은 더 이상 증거를 내지 않는다.
    expect(w.lines.evidence.read(R1)).toEqual({ known: false });
    // R1의 번호는 변화마다(인사, 보고, 답 줄 교체) 늘었다.
    expect(r1.every((value, i) => i === 0 || value > r1[i - 1]!)).toBe(true);
    expect(r1.length).toBe(4);
  });

  test("만들지 않은 장부 표지를 받으면 증거는 늘 모름이고 confirm은 current를 내지 않는다", () => {
    const w = world();
    const forged = createAnswerLines({ ...w.ports, evidenceBook: { kind: "answer_evidence_book" } });
    expect(forged.evidence.read(R1)).toEqual({ known: false });
    w.hello(1, []);
    expect(forged.evidence.confirm(R1, 1, 0, 0)).toBe("evidence_changed");
  });
});
