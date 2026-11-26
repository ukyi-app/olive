// D-127·D-128: 조립(boot.ts)이 장부 경보를 감독 로그 한 줄(ledger_alert, 실행 ID 포함)로 내는 자리. 같은 경보는 프로세스에서 한 줄이다
// (영수증은 실행 ID + 영수증 ID, 답은 실행 ID + 경보 이름. unreadable은 거르지 않는다). 실제 장부·실제 답 줄로 닫힌 실행의 늦은 시작
// 영수증과 조회 답(status_report)을 넣어 보고, 밀린 사본·인사의 경보는 답 줄의 기록 포트에 실제 처리기의 결과를 넘겨 본다.
// 기록이 던져도 ack 시도와 장부는 그대로인지 본다(훑기).
// 실행 ID·digest·시각은 이 시험이 고른 값이다. 운영값이 아니다.
import { describe, expect, test } from "bun:test";
import type { RunStatus, Verified } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import type { HelloAnswerOutcome } from "../../../src/supervisor/dispatch/hello-answers.ts";
import { type ExecutorAnswerCopy, handleForward, replayBacklog } from "../../../src/supervisor/dispatch/receipts.ts";
import type { BootResult } from "../../../src/supervisor/runtime/boot.ts";
import { digest, id, must, worker } from "../../ledger/helpers.ts";
import { EXECUTOR, WALL, type World, world } from "./boot-world.ts";

async function booted(w: World = world()) {
  const result: BootResult = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  await w.time.flush();
  for (let i = 0; i < 20 && !w.events.some((e) => e.event === "restore_step" && e.fields.step === 5); i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
  const ledger = w.opened;
  if (ledger === null) throw new Error("장부를 열지 않았다");
  const lines = w.captured.lines;
  if (lines === undefined) throw new Error("답 줄을 만들지 않았다");
  return { w, run: result.running, ledger, lines };
}

// 시작 지시만 낸 작업자 실행을 D-90으로 닫는다(시작 발행 WALL + 30000의 빈 전체 답).
function closedRun(ledger: Ledger) {
  const run = must(ledger.admitRun(worker({ now: WALL, deadlineAt: WALL + 600_000 }))).run;
  const requestId = id();
  must(ledger.startRun({ runId: run.runId, requestId, stopGeneration: 0, now: WALL }));
  must(ledger.closeUnreceivedRun({ runId: run.runId, runs: [], answeredAt: WALL + 30_000, receivedAt: WALL + 30_005, now: WALL + 30_010 }, { sender: EXECUTOR }));
  return { runId: run.runId, requestId };
}

// 연결 판단이 낼 검증된 봉투의 값. 처리기는 서명을 다시 보지 않고 머리·본문의 칸만 읽는다.
function startedForward(run: { runId: string; requestId: string }, receiptId: string) {
  const body = { receipt_id: receiptId, run_id: run.runId, instruction_request_id: run.requestId, started_at: WALL + 31_000 };
  const header = { action: "receipt_started", sender: EXECUTOR, run_generation: 1, body_digest: digest(`started:${receiptId}`), issued_at: WALL + 31_000 };
  return { kind: "forward" as const, connection: 3, verified: { ok: true, action: "receipt_started", header, body } as unknown as Verified };
}

const alerts = (w: World) => w.events.filter((e) => e.event === "ledger_alert").map((e) => e.fields);
const ackTries = (w: World) => w.events.filter((e) => e.event === "sink" && e.fields.action === "ack").length;
const running = (runId: string): RunStatus => ({ run_id: runId, state: "running", run_generation: 1, last_receipt_id: null });

function slotView(ledger: Ledger, runId: string) {
  const run = ledger.getRun(runId);
  const holds = ledger.slotHolds();
  return { state: run.known && run.value !== null ? run.value.state : "unknown", holds: holds.known ? holds.value.map((h) => [h.runId, h.why, h.holdsSlot]) : "unknown" };
}

describe("장부 경보의 감독 로그(ledger_alert)", () => {
  test("E16: 닫힌 실행의 늦은 시작 영수증은 실행 ID를 실은 한 줄이고, 같은 영수증의 재전송은 줄 없이 ack 시도만 다시 한다", async () => {
    const b = await booted();
    const closed = closedRun(b.ledger);
    const receiptId = id();
    b.lines.value.deliver(startedForward(closed, receiptId));
    expect(alerts(b.w)).toEqual([{ reason: "closed_run_started", runId: closed.runId, delivery: "new" }]);
    expect(ackTries(b.w)).toBe(1);
    b.lines.value.deliver(startedForward(closed, receiptId));
    b.lines.value.deliver(startedForward(closed, receiptId));
    expect(alerts(b.w)).toEqual([{ reason: "closed_run_started", runId: closed.runId, delivery: "new" }]);
    expect(ackTries(b.w)).toBe(3);
    expect(slotView(b.ledger, closed.runId)).toEqual({ state: "not_started", holds: [[closed.runId, "ended_in_ledger", true]] });
    expect(await b.run.stop()).toBe(0);
  });

  test("E16: 같은 실행의 다른 영수증 ID는 따로 한 줄이고, 그 재전송은 줄이 없다", async () => {
    const b = await booted();
    const closed = closedRun(b.ledger);
    const first = id();
    const second = id();
    b.lines.value.deliver(startedForward(closed, first));
    b.lines.value.deliver(startedForward(closed, second));
    b.lines.value.deliver(startedForward(closed, second));
    expect(alerts(b.w)).toEqual([
      { reason: "closed_run_started", runId: closed.runId, delivery: "new" },
      { reason: "closed_run_started", runId: closed.runId, delivery: "new" },
    ]);
    expect(ackTries(b.w)).toBe(3);
    expect(await b.run.stop()).toBe(0);
  });

  test("E16 경보 0: 열린 실행의 시작 영수증에는 줄이 없다", async () => {
    const b = await booted();
    const run = must(b.ledger.admitRun(worker({ now: WALL, deadlineAt: WALL + 600_000 }))).run;
    const requestId = id();
    must(b.ledger.startRun({ runId: run.runId, requestId, stopGeneration: 0, now: WALL }));
    b.lines.value.deliver(startedForward({ runId: run.runId, requestId }, id()));
    expect(ackTries(b.w)).toBe(1);
    expect(alerts(b.w)).toEqual([]);
    expect(await b.run.stop()).toBe(0);
  });

  test("E17: 실제 답 줄에 넣은 조회 답(status_report)의 경보는 partial 한 줄이고, 같은 실행의 같은 경보를 실은 다음 답은 줄이 없다", async () => {
    const b = await booted();
    const closed = closedRun(b.ledger);
    // 답 줄은 지금 인정된 연결의 답만 반영한다(sink.ts answers.current). 이 시험의 연결 3을 그 실행기의 연결로 둔다.
    (b.w.fake.server as unknown as { recognized: (executorId: string) => number | null }).recognized = (executorId) => (executorId === EXECUTOR ? 3 : null);
    const queries = b.w.captured.queries;
    if (queries === undefined) throw new Error("조회 등록부를 만들지 않았다");
    const answerQuery = (n: number) => {
      const query = { requestId: id(), recipient: EXECUTOR, runIds: [closed.runId], connection: 3 };
      queries.add(query as never);
      const header = { action: "status_report", sender: EXECUTOR, run_generation: 0, body_digest: digest(`status:${n}`), issued_at: WALL + 31_000 + n };
      b.lines.value.deliver({ kind: "forward", connection: 3, verified: { ok: true, action: "status_report", header, body: { in_reply_to: query.requestId, runs: [running(closed.runId)] } } } as never);
    };
    answerQuery(1);
    expect(alerts(b.w)).toEqual([{ reason: "closed_run_running", runId: closed.runId, coverage: "partial" }]);
    answerQuery(2);
    expect(alerts(b.w)).toEqual([{ reason: "closed_run_running", runId: closed.runId, coverage: "partial" }]);
    expect(b.w.events.filter((e) => e.event === "answer_fault")).toEqual([]);
    expect(slotView(b.ledger, closed.runId)).toEqual({ state: "not_started", holds: [] });
    expect(await b.run.stop()).toBe(0);
  });

  test("E17: 상태 보고·밀린 사본(partial)과 인사(full)의 경보를 실행마다 한 줄로 남기고, 같은 실행의 같은 경보는 한 줄, unreadable은 매번이다", async () => {
    const b = await booted();
    // 길마다 다른 닫힌 실행을 쓴다: 같은 실행의 같은 경보는 어느 길로 와도 한 줄이다.
    const [statusRun, backlogRun, helloRun] = [closedRun(b.ledger), closedRun(b.ledger), closedRun(b.ledger)];
    const observe = b.lines.ports.observe;
    if (observe === undefined) throw new Error("기록 포트가 없다");
    const query = { requestId: id(), recipient: EXECUTOR, runIds: [statusRun.runId], connection: 3 };
    const header = { action: "status_report", sender: EXECUTOR, run_generation: 0, body_digest: digest("status"), issued_at: WALL + 31_000 };
    const verified = { ok: true, action: "status_report", header, body: { in_reply_to: query.requestId, runs: [running(statusRun.runId)] } } as unknown as Verified;
    const links = { current: () => true };
    const status = handleForward(
      { forward: { verified, connection: 3 }, now: WALL + 31_001, stopGeneration: 0, pendingQueries: [query], links, backlog: [] },
      { ledger: b.ledger, random: { bytes: (n) => new Uint8Array(n) } },
    );
    observe({ kind: "status", executor: EXECUTOR, connection: 3, outcome: status });
    const copy: ExecutorAnswerCopy = { sender: EXECUTOR, connection: 3, coverage: "partial", runs: [running(backlogRun.runId)], answeredAt: WALL + 31_002 };
    observe({ kind: "backlog", executor: EXECUTOR, outcome: replayBacklog({ backlog: [copy], now: WALL + 31_003, links }, { ledger: b.ledger }) });
    const hello: HelloAnswerOutcome = { kind: "applied", executorId: EXECUTOR, connection: 3, answeredAt: WALL + 31_004, moved: [], deferred: [], outsideLedger: [], alarms: [{ alarm: "closed_run_running", runId: helloRun.runId }] };
    observe({ kind: "hello", executor: EXECUTOR, outcome: hello });
    // 같은 실행의 같은 경보: 인사로 다시 와도, 앞서 상태 보고로 낸 실행이 인사로 와도 줄이 없다.
    observe({ kind: "hello", executor: EXECUTOR, outcome: hello });
    observe({ kind: "hello", executor: EXECUTOR, outcome: { ...hello, alarms: [{ alarm: "closed_run_running", runId: statusRun.runId }] } });
    // 경보 없는 반영 결과와 경보 칸을 읽지 못한 결과(두 번).
    observe({ kind: "hello", executor: EXECUTOR, outcome: { ...hello, alarms: undefined } });
    observe({ kind: "hello", executor: EXECUTOR, outcome: { ...hello, alarms: [{ alarm: "unreadable", runId: null }] } });
    observe({ kind: "hello", executor: EXECUTOR, outcome: { ...hello, alarms: [{ alarm: "unreadable", runId: null }] } });
    expect(alerts(b.w)).toEqual([
      { reason: "closed_run_running", runId: statusRun.runId, coverage: "partial" },
      { reason: "closed_run_running", runId: backlogRun.runId, coverage: "partial" },
      { reason: "closed_run_running", runId: helloRun.runId, coverage: "full" },
      { reason: "unreadable", runId: null, coverage: "full" },
      { reason: "unreadable", runId: null, coverage: "full" },
    ]);
    for (const run of [statusRun, backlogRun, helloRun]) expect(slotView(b.ledger, run.runId)).toEqual({ state: "not_started", holds: [] });
    expect(await b.run.stop()).toBe(0);
  });

  test("훑기: 경보 줄의 기록이 던져도 ack 시도·장부의 받은 기록·점유는 기록이 던지지 않을 때와 같다", async () => {
    const results: unknown[] = [];
    for (const throwOnAlert of [false, true]) {
      const w = world();
      const base = w.deps.log;
      w.deps = {
        ...w.deps,
        log: (event, fields) => {
          base(event, fields);
          if (throwOnAlert && event === "ledger_alert") throw new Error("기록 실패");
        },
      };
      const b = await booted(w);
      const closed = closedRun(b.ledger);
      const receiptId = id();
      b.lines.value.deliver(startedForward(closed, receiptId));
      b.lines.value.deliver(startedForward(closed, receiptId));
      results.push({ alerts: alerts(b.w).map((f) => f.delivery), acks: ackTries(b.w), view: slotView(b.ledger, closed.runId).holds.length, faults: b.w.events.filter((e) => e.event === "answer_fault").length });
      expect(await b.run.stop()).toBe(0);
    }
    expect(results).toEqual([
      { alerts: ["new"], acks: 2, view: 1, faults: 0 },
      { alerts: ["new"], acks: 2, view: 1, faults: 0 },
    ]);
  });
});
