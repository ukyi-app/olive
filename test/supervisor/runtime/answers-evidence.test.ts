// 답 줄(answers.ts)의 D-90 증거 포트를 실제 닫기 박자(unreceived.ts의 unreceivedTick)와 함께 돌린다. 장부는 임시 폴더의 실제 장부이고
// 공개 함수로만 준비한다. 연결 표는 가짜(greet한 연결이 그 실행기의 지금 인정된 연결)이고 처리기(receipts.ts, hello-answers.ts)는 실제 것이다.
// 박자의 포트는 조립(N5)이 묶을 그대로 같은 답 줄의 evidence·withheld, 답 줄에 넘긴 복원기, 같은 복원 대기 신호다.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { type RunStatus, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { UnreceivedClosureInput } from "../../../src/ledger/index.ts";
import type { HelloConnectionTable } from "../../../src/supervisor/dispatch/hello-answers.ts";
import type { ReceiptLedger, SentQuery } from "../../../src/supervisor/dispatch/receipts.ts";
import {
  type UnreceivedOutcome,
  type UnreceivedPorts,
  type UnreceivedSkip,
  type UnreceivedTickResult,
  unreceivedTick,
} from "../../../src/supervisor/dispatch/unreceived.ts";
import {
  type AnswerEvidenceBook,
  type AnswerLinePorts,
  type AnswerLines,
  type AnswerNote,
  createAnswerEvidenceBook,
  createAnswerLines,
} from "../../../src/supervisor/runtime/answers.ts";
import { createQueryBook } from "../../../src/supervisor/runtime/query-book.ts";
import { createFileResultBackend, nodeFilePort } from "../../../src/supervisor/scheduler/result-store-file.ts";
import type { Delivered } from "../../../src/supervisor/transport/server.ts";
import { id, must, NOW, open, ready, tempDir, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";

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
// results면 실행에 소유자(입력 요청)를 두고 실제 파일 결과 보관소를 넘긴다(결과 보고는 소유자가 없으면 보관소에 닿지 않는다).
function world(options: { book?: AnswerEvidenceBook; results?: boolean } = {}) {
  // 답 저장의 실패는 장부 포트에서 던져 낸다. 실제 장부의 쓰기 실패는 장부를 고장(broken)으로 두어 닫기(start 모드)까지 거절하므로
  // 증거 포트가 막았는지 가를 수 없다. 영수증의 실패는 장부에 닿기 전의 것(답 줄의 시계, 결과 보관소의 디렉터리 fsync)만 낸다.
  const fault = { failAnswers: 0, failClock: 0, failDirSync: 0 };
  const real = ready(open(tempPath()));
  let owner: string | undefined;
  if (options.results === true) {
    owner = id();
    must(real.enqueueInput({ requestId: owner, source: "test", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 600_000 }, receivedAt: NOW }));
  }
  const runId = must(real.admitRun(worker(owner === undefined ? {} : { inputRequestId: owner }))).run.runId;
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
    // 답 줄의 기록기(observe) 안.
    onNote: null as ((note: AnswerNote) => void) | null,
  };
  const notes: AnswerNote[] = [];
  const acks: number[] = [];
  let backend: AnswerLinePorts["results"]["backend"] = {} as never;
  if (options.results === true) {
    const made = createFileResultBackend({
      dir: tempDir(),
      maxRecordBytes: 20 * 1024,
      files: {
        ...nodeFilePort,
        fsync(fd) {
          if (fault.failDirSync > 0 && nodeFilePort.fstat(fd).kind === "directory") {
            fault.failDirSync -= 1;
            throw new Error("EIO");
          }
          nodeFilePort.fsync(fd);
        },
      },
    });
    if (made.status !== "ok") throw new Error("결과 보관소를 만들지 못했다");
    backend = made.backend;
  }
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
    results: { backend, ledger: real },
    random: { bytes: (length) => crypto.getRandomValues(new Uint8Array(length)) },
    signer: { seal: (input) => sealEnvelope(input, supervisorKey) },
    clock: {
      now: () => {
        if (fault.failClock > 0) {
          fault.failClock -= 1;
          throw new Error("시계 실패");
        }
        return clock.now;
      },
    },
    wire: {
      answers: {
        current: (connection, executorId) => {
          hooks.onCurrent?.();
          return table.recognized(executorId) === connection;
        },
      },
      writeAck: (connection) => {
        acks.push(connection);
        return "sent";
      },
    },
    queries,
    cycle: { noteCandidate: () => {} },
    observationsSettled: () => gate.settled,
    observe: (note) => {
      notes.push(note);
      hooks.onNote?.(note);
    },
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
  // 연결 판단이 서명을 검증한 뒤 낸 영수증·결과 보고(같은 실행·세대).
  const receipt = (connection: number, action: "receipt_accepted" | "receipt_started" | "report_result"): void => {
    const body =
      action === "report_result"
        ? { report_id: id(), run_id: runId, result: { role: "diagnosis", outcome: "completed", summary: "ok", items: [], refs: [] } }
        : action === "receipt_accepted"
          ? { receipt_id: id(), run_id: runId, instruction: "task_start", instruction_request_id: requestId }
          : { receipt_id: id(), run_id: runId, instruction_request_id: requestId, started_at: PASSED };
    const header = { sender: R1, action, run_generation: runOf().runGeneration, stop_generation: 0, body_digest: "e".repeat(64), issued_at: PASSED };
    lines.deliver({ kind: "forward", connection, verified: { ok: true, action, header, body } as never });
  };
  const live = { requestId, runId, executorId: R1 };
  return {
    real,
    lines,
    queries,
    notes,
    acks,
    receipt,
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

  test("버린 옛 인사가 양성일 수 있으면(not_known 밖의 항목) 오염이라 닫지 않는다. 확인된 빈 목록이면 잃는 양성 관측이 없어 오염이 아니고 닫는다(대조군)", () => {
    // 오염은 버린 답이 양성 관측을 실었을 수 있을 때만이다(answers.ts의 mayBePositive). 빈 목록·전부 not_known인 목록을 버려도
    // 장부가 모르는 "안다"는 관측이 생기지 않는다.
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

describe("실행기 입력이 장부에 닿기 전의 구간(첫 외부 호출보다 먼저 서는 흔적)", () => {
  const slot = (w: ReturnType<typeof world>) => w.real.slotFree("worker");
  const receiptResult = (w: ReturnType<typeof world>): string => {
    const found = w.notes.findLast((note) => note.kind === "receipt");
    if (found?.kind !== "receipt") return "none";
    const outcome = found.outcome as { outcome: string; reason?: string; at?: string };
    return [outcome.outcome, outcome.at ?? outcome.reason].filter(Boolean).join("/");
  };

  test("검증한 시작 영수증·결과 보고가 장부 저장 전에 실패하면(시계가 한 번 던짐, 결과 보관의 디렉터리 fsync 실패) 그 주체를 오염으로 남겨 다음 빈 full 뒤에도 닫지 않는다", () => {
    for (const failure of ["clock", "store"] as const) {
      const w = world({ results: true });
      // 시한 전 인사. 영수증은 장부에 닿지 못하고, 다음 연결의 빈 full이 시한 뒤에 반영된다.
      w.hello(1, [], NOW + 2);
      const before = w.lines.evidence.read(R1);
      if (!before.known) throw new Error("모름");
      if (failure === "clock") {
        w.fault.failClock = 1;
        w.receipt(1, "receipt_started");
      } else {
        w.fault.failDirSync = 1;
        w.receipt(1, "report_result");
      }
      expect([failure, receiptResult(w), w.acks.length]).toEqual([failure, failure === "clock" ? "rejected/input_malformed" : "result_unknown/store", 0]);
      const after = w.lines.evidence.read(R1);
      expect([failure, after]).toMatchObject([failure, { known: true, tainted: true, pending: false }]);
      expect(after.known && after.version > before.version).toBe(true);
      w.table.greet(2, R1, [], SIGNED);
      w.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
      w.hello(2, []);
      expect([failure, ran(w.tick()).runs]).toEqual([failure, [skippedOutcome(w, "tainted")]]);
      expect([failure, w.closeCalls.length, w.runOf().state, slot(w)]).toEqual([failure, 0, "preparing", { known: true, value: false }]);
    }
  });

  test("증거를 읽은 뒤 전역 조회 안에서 결과 보고를 받고 그 보관이 실패하면 닫지 않는다. 다음 박자는 오염을 본다", () => {
    const w = world({ results: true });
    w.hello(1, []);
    w.hooks.onPort = (name, call) => {
      if (name !== "settled" || call !== 2) return;
      w.fault.failDirSync = 1;
      w.receipt(1, "report_result");
    };
    expect(ran(w.tick()).runs).toEqual([skippedOutcome(w, "evidence_changed")]);
    expect(receiptResult(w)).toBe("result_unknown/store");
    w.hooks.onPort = null;
    expect(ran(w.tick()).runs).toEqual([skippedOutcome(w, "tainted")]);
    expect([w.closeCalls.length, w.runOf().state, slot(w)]).toEqual([0, "preparing", { known: true, value: false }]);
  });

  test("처리기 안(장부 쓰기 직전)에서 박자가 돌면 받는 중인 영수증은 대기다. 장부가 받으면 오염 없이 거둔다", () => {
    const w = world({ results: true });
    w.hello(1, []);
    let inner: UnreceivedTickResult | null = null;
    let inside: unknown = null;
    const ledger = w.ports.ledger as { applyReceipt: ReceiptLedger["applyReceipt"] };
    const apply = ledger.applyReceipt;
    ledger.applyReceipt = (input, from) => {
      inside = w.lines.evidence.read(R1);
      inner = w.tick();
      return apply(input, from);
    };
    w.receipt(1, "receipt_accepted");
    expect(inside).toMatchObject({ known: true, pending: true, tainted: false });
    expect(ran(inner as unknown as UnreceivedTickResult).runs).toEqual([skippedOutcome(w, "pending")]);
    expect([receiptResult(w), w.acks.length, w.lines.evidence.read(R1)]).toMatchObject(["ack", 1, { pending: false, tainted: false }]);
    expect([w.closeCalls.length, slot(w)]).toEqual([0, { known: true, value: false }]);
  });

  test("장부가 받은 영수증·결과 보고는 오염을 남기지 않는다(대조군): 받은 뒤의 빈 full은 후보 없음, 증거를 읽은 뒤 받으면 번호가 바뀌어 evidence_changed", () => {
    for (const action of ["receipt_accepted", "receipt_started", "report_result"] as const) {
      const pre = world({ results: true });
      pre.hello(1, [], NOW + 2);
      pre.receipt(1, action);
      expect([action, receiptResult(pre), pre.lines.evidence.read(R1)]).toMatchObject([action, "ack", { tainted: false, pending: false }]);
      pre.table.greet(2, R1, [], SIGNED);
      pre.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
      pre.hello(2, []);
      expect([action, ran(pre.tick()).runs, pre.closeCalls.length, slot(pre)]).toEqual([action, [], 0, { known: true, value: false }]);

      const late = world({ results: true });
      late.hello(1, []);
      late.hooks.onPort = (name, call) => {
        if (name === "settled" && call === 2) late.receipt(1, action);
      };
      expect([action, ran(late.tick()).runs]).toEqual([action, [skippedOutcome(late, "evidence_changed")]]);
      expect([action, receiptResult(late), late.lines.evidence.read(R1)]).toMatchObject([action, "ack", { tainted: false, pending: false }]);
      expect([action, late.closeCalls.length, slot(late)]).toEqual([action, 0, { known: true, value: false }]);
    }
  });

  test("처리기가 던져도(결과 포트를 읽다 던짐) 그 영수증은 닫기 근거가 되지 않는다: 줄은 고장으로 모름이고 같은 장부의 새 답 줄에서 오염이다", () => {
    const book = createAnswerEvidenceBook();
    const w = world({ book, results: true });
    w.hello(1, []);
    const results = w.ports.results as { backend: unknown };
    const real = results.backend;
    Object.defineProperty(results, "backend", {
      configurable: true,
      get() {
        throw new Error("결과 포트 실패");
      },
    });
    w.receipt(1, "report_result");
    Object.defineProperty(results, "backend", { configurable: true, writable: true, value: real });
    expect(w.lines.evidence.read(R1)).toEqual({ known: false });
    const next = createAnswerLines({ ...w.ports, evidenceBook: book });
    expect(next.evidence.read(R1)).toMatchObject({ known: true, tainted: true, pending: false });
    expect([w.closeCalls.length, slot(w)]).toEqual([0, { known: true, value: false }]);
  });

  test("상태 보고를 받아 첫 등록부 조회 안에서 박자가 돌면 그 보고는 아직 줄에 없어도 대기라 닫지 않는다", () => {
    const w = world();
    w.hello(1, []);
    const queries = w.queries as { pending: () => readonly SentQuery[] };
    const pending = queries.pending;
    let inner: UnreceivedTickResult | null = null;
    let inside: unknown = null;
    queries.pending = () => {
      queries.pending = pending;
      const rows = pending.call(w.queries);
      inside = w.lines.evidence.read(R1);
      inner = w.tick();
      return rows;
    };
    w.status(1, w.running());
    expect(inside).toMatchObject({ known: true, pending: true });
    expect(ran(inner as unknown as UnreceivedTickResult).runs).toEqual([skippedOutcome(w, "pending")]);
    // 보고는 그 뒤 실제 장부에 적혔다.
    expect(w.real.hasRunSighting(w.live.runId)).toEqual({ known: true, value: true });
    expect([w.closeCalls.length, w.runOf().state, slot(w)]).toEqual([0, "preparing", { known: true, value: false }]);
  });

  test("양성 full의 저장이 실패하면 기록기를 부르기 전에 retry와 번호가 선다: 기록기 안의 증거가 그 뒤의 증거와 같다", () => {
    const w = world();
    w.hello(1, []);
    let atLedger: unknown = null;
    let atNote: unknown = null;
    w.hooks.beforeAnswer = () => {
      atLedger = w.lines.evidence.read(R1);
    };
    w.hooks.onNote = (note) => {
      if (note.kind === "hello" && note.outcome.kind === "ledger_failed") atNote = w.lines.evidence.read(R1);
    };
    w.fault.failAnswers = 1;
    w.hello(2, w.running());
    const after = w.lines.evidence.read(R1);
    expect(atLedger).toMatchObject({ known: true, pending: true });
    expect(atNote).toMatchObject({ known: true, pending: true });
    expect((atNote as { version: number }).version).toBeGreaterThan((atLedger as { version: number }).version);
    expect(after).toEqual(atNote as never);
  });

  test("변경 번호가 안전 정수 상한에 닿으면 그 장부는 사는 동안 모름이다: 닫지 않고, confirm은 current를 내지 않고, 같은 장부의 새 답 줄도 모름이다", () => {
    const book = createAnswerEvidenceBook({ firstVersion: Number.MAX_SAFE_INTEGER - 8 });
    const w = world({ book });
    w.hello(1, []);
    const seen: number[] = [];
    for (;;) {
      const read = w.lines.evidence.read(R1);
      if (!read.known) break;
      seen.push(read.version);
      if (seen.length > 20) throw new Error("상한에 닿지 않는다");
      // 철회는 그 주체의 번호를 하나 올린다(연결 99는 쓰지 않는 번호).
      w.lines.deliver({ kind: "withdrawn", connection: 99, principal: R1 });
    }
    expect(seen.at(-1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(seen.every((value, i) => Number.isSafeInteger(value) && (i === 0 || value > seen[i - 1]!))).toBe(true);
    expect(w.lines.evidence.confirm(R1, 1, Number.MAX_SAFE_INTEGER, 0)).toBe("evidence_changed");
    expect(ran(w.tick()).runs).toEqual([skippedOutcome(w, "evidence_unknown")]);
    expect(w.closeCalls.length).toBe(0);
    expect(createAnswerLines({ ...w.ports, evidenceBook: book }).evidence.read(R1)).toEqual({ known: false });
    expect(() => createAnswerEvidenceBook({ firstVersion: -1 })).toThrow(RangeError);
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
