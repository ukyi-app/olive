// D-127·D-128: 장부가 답에 실은 닫힌 실행의 경보를 영수증 처리기(handleForward·replayBacklog)가 결과에 옮기는지, 그리고 경보 칸이
// 던지거나 약속 밖의 값이어도 ack·반영 결과(밀린 사본·다시 물을 실행)가 그대로인지(훑기) 본다.
// 실행기 이름·키·실행 줄·시각은 이 시험이 지어 넣는 자료다. 운영값이 아니다.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { type Action, type Bodies, type RunStatus, sealEnvelope, type Verified, verifyEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import type { Random } from "../../../src/supervisor/dispatch/ports.ts";
import { type ExecutorAnswerCopy, type ForwardInput, handleForward, type ReceiptLedger, type ReceiptOutcome, replayBacklog, type SentQuery } from "../../../src/supervisor/dispatch/receipts.ts";
import { id, must, NOW, open, ready, startedWorker, tempPath, WORKER_EXECUTOR } from "../../ledger/helpers.ts";

const keys = new Map<string, { privateKey: KeyObject; publicKey: KeyObject }>([[WORKER_EXECUTOR, generateKeyPairSync("ed25519")]]);
const random: Random = { bytes: (length) => new Uint8Array(length).fill(7) };
// D-90 닫기의 빈 전체 답 시각(시작 발행 NOW + 30000, 정각). 닫은 뒤의 영수증·답은 그 뒤에 받는다.
const SHUT = NOW + 30_000;
const AFTER = SHUT + 1_000;

let nonceSeq = 0;
const nonce = () => (++nonceSeq).toString(16).padStart(32, "0");

// 실행기의 키로 봉하고 감독의 맥락으로 검증한 봉투(연결 판단이 forward로 내는 값). 같은 본문을 두 번 부르면 nonce만 다른 새 봉투다.
async function verified<A extends Action>(action: A, body: Bodies[A], runGeneration: number, ledger: Ledger): Promise<Verified> {
  const envelope = sealEnvelope(
    { sender: WORKER_EXECUTOR, recipient: "supervisor", action, request_id: id(), stop_generation: 0, run_generation: runGeneration, issued_at: AFTER, nonce: nonce(), body },
    keys.get(WORKER_EXECUTOR)!.privateKey,
  );
  const result = await verifyEnvelope(envelope, {
    now: AFTER + 1,
    expectedRecipient: "supervisor",
    publicKeyFor: (name) => keys.get(name)?.publicKey,
    stopGeneration: 0,
    runGeneration: (runId) => ledger.runGeneration(runId),
    nonces: { consume: () => true },
  });
  if (!result.ok) throw new Error(`검증 실패: ${result.reason}`);
  return result;
}

function input(v: Verified, extra: Partial<ForwardInput> = {}): ForwardInput {
  return { forward: { verified: v, connection: 7 }, now: AFTER + 2, stopGeneration: 0, pendingQueries: [], links: { current: () => true }, backlog: [], ...extra };
}

// 시작 지시만 낸 작업자 실행을 D-90으로 닫는다. 닫힌 실행과 그 시작 지시의 요청 ID.
function closedRun(ledger: Ledger) {
  const live = startedWorker(ledger);
  must(ledger.closeUnreceivedRun({ runId: live.runId, runs: [], answeredAt: SHUT, receivedAt: SHUT + 5, now: SHUT + 10 }, { sender: WORKER_EXECUTOR }));
  return live;
}

const startedBody = (run: { runId: string; requestId: string }, receiptId: string) => ({ receipt_id: receiptId, run_id: run.runId, instruction_request_id: run.requestId, started_at: AFTER });
const running = (runId: string): RunStatus => ({ run_id: runId, state: "running", run_generation: 1, last_receipt_id: null });

function acked(outcome: ReceiptOutcome) {
  if (outcome.outcome !== "ack") throw new Error(`ack가 아니다: ${JSON.stringify(outcome)}`);
  return outcome;
}

// 실제 장부에 넘기고 그 답의 한 칸을 바꿔 돌려주는 장부 포트(훑기). 장부 쓰기는 실제 장부가 그대로 한다.
type Inject = (answer: Record<string, unknown>) => unknown;
function injecting(ledger: Ledger, field: "alarm" | "alarms", inject: Inject): ReceiptLedger {
  return {
    applyReceipt: (receipt, from) => (field === "alarm" ? inject({ ...ledger.applyReceipt(receipt, from) }) : ledger.applyReceipt(receipt, from)) as ReturnType<Ledger["applyReceipt"]>,
    recordReport: (report, from) => ledger.recordReport(report, from),
    applyExecutorAnswer: (answer, from) =>
      (field === "alarms" ? inject({ ...ledger.applyExecutorAnswer(answer, from) }) : ledger.applyExecutorAnswer(answer, from)) as ReturnType<Ledger["applyExecutorAnswer"]>,
    recordAnswerSightings: (answer, from) => ledger.recordAnswerSightings(answer, from),
  };
}

const throwing = (field: string): Inject => (answer) =>
  Object.defineProperty({ ...answer }, field, {
    enumerable: true,
    get() {
      throw new Error("경보 칸을 읽다 던짐");
    },
  });
const replaced = (field: string, value: unknown): Inject => (answer) => ({ ...answer, [field]: value });

describe("E16(D-127): 늦은 시작 영수증의 경보를 결과에 옮긴다", () => {
  test("닫힌 실행의 늦은 시작 영수증은 ack에 경보(실행 ID)를 싣고, 재전송(duplicate)에도 싣는다", async () => {
    const ledger = ready(open(tempPath()));
    const closed = closedRun(ledger);
    const receiptId = id();
    const first = acked(handleForward(input(await verified("receipt_started", startedBody(closed, receiptId), 1, ledger)), { ledger, random }));
    expect(first).toMatchObject({ action: "receipt_started", id: receiptId, delivery: "new", alarm: { alarm: "closed_run_started", runId: closed.runId } });
    expect(first.ack.body.ids).toEqual([receiptId]);
    const again = acked(handleForward(input(await verified("receipt_started", startedBody(closed, receiptId), 1, ledger)), { ledger, random }));
    expect(again).toMatchObject({ delivery: "duplicate", alarm: { alarm: "closed_run_started", runId: closed.runId } });
    expect(again.ack.body.ids).toEqual([receiptId]);
  });

  test("정지 세대를 몰라 ack 초안을 만들지 못해도(applied_without_ack) 경보는 싣는다", async () => {
    const ledger = ready(open(tempPath()));
    const closed = closedRun(ledger);
    const receiptId = id();
    const outcome = handleForward(input(await verified("receipt_started", startedBody(closed, receiptId), 1, ledger), { stopGeneration: null }), { ledger, random });
    expect(outcome).toEqual({
      outcome: "applied_without_ack",
      action: "receipt_started",
      id: receiptId,
      delivery: "new",
      reason: "stop_generation_unknown",
      alarm: { alarm: "closed_run_started", runId: closed.runId },
    });
  });

  test("경보 0: 열린 실행의 시작 영수증에는 경보 칸이 없다", async () => {
    const ledger = ready(open(tempPath()));
    const live = startedWorker(ledger);
    const outcome = acked(handleForward(input(await verified("receipt_started", startedBody(live, id()), 1, ledger)), { ledger, random }));
    expect(outcome.delivery).toBe("new");
    expect("alarm" in outcome).toBe(false);
  });

  test("훑기: 경보 칸이 던지거나 약속 밖의 값이어도 ack는 같은 id로 그대로이고 경보는 unreadable로 남는다", async () => {
    const injections: [string, Inject][] = [
      ["던짐", throwing("alarm")],
      ["모르는 이름", replaced("alarm", "closed_run_maybe")],
      ["숫자", replaced("alarm", 1)],
      ["null", replaced("alarm", null)],
    ];
    for (const [name, inject] of injections) {
      const ledger = ready(open(tempPath()));
      const closed = closedRun(ledger);
      const receiptId = id();
      const v = await verified("receipt_started", startedBody(closed, receiptId), 1, ledger);
      const outcome = handleForward(input(v), { ledger: injecting(ledger, "alarm", inject), random });
      expect({ name, outcome: outcome.outcome, delivery: "delivery" in outcome ? outcome.delivery : null, alarm: "alarm" in outcome ? outcome.alarm : null }).toEqual({
        name,
        outcome: "ack",
        delivery: "new",
        alarm: { alarm: "unreadable", runId: closed.runId },
      });
      expect(acked(outcome).ack.body.ids).toEqual([receiptId]);
      // 장부는 경보와 상관없이 그 영수증을 받았다: 다시 보내면 duplicate이고 실제 장부의 경보가 그대로 실린다.
      expect(handleForward(input(await verified("receipt_started", startedBody(closed, receiptId), 1, ledger)), { ledger, random })).toMatchObject({
        outcome: "ack",
        delivery: "duplicate",
        alarm: { alarm: "closed_run_started", runId: closed.runId },
      });
    }
  });
});

describe("E17(D-128): 닫힌 실행의 running 답(partial)의 경보를 결과에 옮긴다", () => {
  async function statusAnswer(ledger: Ledger, runId: string) {
    const query: SentQuery = { requestId: id(), recipient: WORKER_EXECUTOR, runIds: [runId], connection: 7 };
    const v = await verified("status_report", { in_reply_to: query.requestId, runs: [running(runId)] }, 0, ledger);
    return input(v, { pendingQueries: [query] });
  }

  test("조회의 답이 닫힌 실행을 running으로 실으면 반영 결과(applied)에 경보가 실리고 밀린 사본은 없다", async () => {
    const ledger = ready(open(tempPath()));
    const closed = closedRun(ledger);
    const outcome = handleForward(await statusAnswer(ledger, closed.runId), { ledger, random });
    if (outcome.outcome !== "status_matched") throw new Error(JSON.stringify(outcome));
    expect(outcome.backlog).toEqual([]);
    expect(outcome.settled).toEqual([
      { settled: "applied", answer: expect.objectContaining({ coverage: "partial" }), moved: [], deferred: [], outsideLedger: [], alarms: [{ alarm: "closed_run_running", runId: closed.runId }] },
    ]);
  });

  test("밀린 사본을 다시 넘길 때(replayBacklog)도 경보가 실린다", () => {
    const ledger = ready(open(tempPath()));
    const closed = closedRun(ledger);
    const copy: ExecutorAnswerCopy = { sender: WORKER_EXECUTOR, connection: 7, coverage: "partial", runs: [running(closed.runId)], answeredAt: AFTER };
    expect(replayBacklog({ backlog: [copy], now: AFTER + 2, links: { current: () => true } }, { ledger })).toEqual({
      outcome: "backlog_settled",
      settled: [{ settled: "applied", answer: copy, moved: [], deferred: [], outsideLedger: [], alarms: [{ alarm: "closed_run_running", runId: closed.runId }] }],
      backlog: [],
    });
  });

  test("경보 0: 열린 실행의 running 답에는 경보 칸이 없다", async () => {
    const ledger = ready(open(tempPath()));
    const live = startedWorker(ledger);
    const outcome = handleForward(await statusAnswer(ledger, live.runId), { ledger, random });
    if (outcome.outcome !== "status_matched") throw new Error(JSON.stringify(outcome));
    expect(outcome.settled.map((item) => [item.settled, "alarms" in item])).toEqual([["applied", false]]);
  });

  test("훑기: 경보 칸이 던지거나 약속 밖의 꼴이어도 반영(applied)·밀린 사본 0은 그대로이고 경보는 unreadable 하나로 남는다", async () => {
    const injections: [string, Inject][] = [
      ["칸이 던짐", throwing("alarms")],
      ["배열 아님", replaced("alarms", "closed_run_running")],
      ["모르는 이름", replaced("alarms", [{ runId: id(), runGeneration: 1, alarm: "closed_run_maybe" }])],
      ["세대 0", replaced("alarms", [{ runId: id(), runGeneration: 0, alarm: "closed_run_running" }])],
      ["빈 실행 ID", replaced("alarms", [{ runId: "", runGeneration: 1, alarm: "closed_run_running" }])],
      [
        "항목이 던짐",
        replaced("alarms", [
          Object.defineProperty({}, "alarm", {
            enumerable: true,
            get() {
              throw new Error("항목을 읽다 던짐");
            },
          }),
        ]),
      ],
    ];
    for (const [name, inject] of injections) {
      const ledger = ready(open(tempPath()));
      const closed = closedRun(ledger);
      const outcome = handleForward(await statusAnswer(ledger, closed.runId), { ledger: injecting(ledger, "alarms", inject), random });
      if (outcome.outcome !== "status_matched") throw new Error(`${name}: ${JSON.stringify(outcome)}`);
      expect({ name, backlog: outcome.backlog, settled: outcome.settled.map((item) => ({ ...item, answer: null })) }).toEqual({
        name,
        backlog: [],
        settled: [{ settled: "applied", answer: null, moved: [], deferred: [], outsideLedger: [], alarms: [{ alarm: "unreadable", runId: null }] }],
      });
      expect(ledger.getRun(closed.runId)).toMatchObject({ known: true, value: { state: "not_started" } });
    }
  });
});
