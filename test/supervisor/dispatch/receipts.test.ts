import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  type Action,
  ACTION_SPECS,
  ACTIONS,
  type Bodies,
  executorName,
  type RunStatus,
  sealEnvelope,
  type Verified,
  verifyEnvelope,
} from "../../../src/contract/v1/index.ts";
import type { EnvelopeFrom, Ledger, ReceiptInput, ReportInput } from "../../../src/ledger/index.ts";
import { statusQueryDraft } from "../../../src/supervisor/dispatch/envelopes.ts";
import type { Random } from "../../../src/supervisor/dispatch/ports.ts";
import {
  EXECUTOR_ACTION_HANDLING,
  type ForwardInput,
  handleForward,
  type ReceiptLedger,
  type ReceiptOutcome,
  type SentQuery,
} from "../../../src/supervisor/dispatch/receipts.ts";
import { digest, id, must, NOW, open, ready, SESSION_EXECUTOR, session, startedWorker, tempPath, WORKER_EXECUTOR } from "../../ledger/helpers.ts";

// 실행기 이름·키·실행 줄은 이 시험이 지어 넣는 자료다. 키는 실행마다 새로 만든다.
// WORKER_EXECUTOR는 장부 도우미가 실행 줄의 지정 실행기로 적는 이름이고, OTHER는 같은 역할의 다른 인스턴스다.
const OTHER = executorName("diagnosis", "1", "store-b");
const keys = new Map<string, { privateKey: KeyObject; publicKey: KeyObject }>(
  [WORKER_EXECUTOR, OTHER, SESSION_EXECUTOR].map((name) => [name, generateKeyPairSync("ed25519")] as const),
);

// 가짜 난수: 부를 때마다 다음 바이트. 부른 횟수를 센다.
function fakeRandom(seed = 1): Random & { calls: number } {
  let next = seed;
  const state = {
    calls: 0,
    bytes(length: number) {
      state.calls += 1;
      return Uint8Array.from({ length }, () => next++ & 0xff);
    },
  };
  return state;
}

let nonceSeq = 0;
const nonce = () => (++nonceSeq).toString(16).padStart(32, "0");

// 실행기의 키로 봉하고 감독의 맥락으로 검증한 봉투. 연결 판단이 forward로 내는 것과 같은 값이다.
// 같은 본문을 두 번 부르면 nonce만 다른 새 봉투다(실행기의 재전송).
async function verified<A extends Action>(
  action: A,
  sender: string,
  body: Bodies[A],
  runGeneration: number,
  ledgerGeneration: (runId: string) => number | undefined,
): Promise<Verified> {
  const envelope = sealEnvelope(
    { sender, recipient: "supervisor", action, request_id: id(), stop_generation: 0, run_generation: runGeneration, issued_at: NOW, nonce: nonce(), body },
    keys.get(sender)!.privateKey,
  );
  const result = await verifyEnvelope(envelope, {
    now: NOW + 1,
    expectedRecipient: "supervisor",
    publicKeyFor: (name) => keys.get(name)?.publicKey,
    stopGeneration: 0,
    runGeneration: ledgerGeneration,
    nonces: { consume: () => true },
  });
  if (!result.ok) throw new Error(`검증 실패: ${result.reason}`);
  return result;
}

// 연결 1은 지금도 인정된 연결이고 밀린 답은 없다. 연결·밀린 답의 경우는 receipts-answers.test.ts가 본다.
function forward(v: Verified, extra: Partial<ForwardInput> = {}): ForwardInput {
  return { forward: { verified: v, connection: 1 }, now: NOW + 2, stopGeneration: 0, pendingQueries: [], links: { current: () => true }, backlog: [], ...extra };
}

// 부르면 실패하는 장부. 장부를 부르지 않아야 하는 길에 쓴다.
const untouchable: ReceiptLedger = {
  applyReceipt: () => {
    throw new Error("applyReceipt를 부르면 안 된다");
  },
  recordReport: () => {
    throw new Error("recordReport를 부르면 안 된다");
  },
  applyExecutorAnswer: () => {
    throw new Error("applyExecutorAnswer를 부르면 안 된다");
  },
};

// 받은 입력·from을 적고 정한 답을 돌려주는 장부.
function spyLedger(answer: (id: string) => unknown = (x) => ({ ok: true, delivery: "new", ack: x })) {
  const calls: { op: "applyReceipt" | "recordReport"; input: ReceiptInput | ReportInput; from: EnvelopeFrom }[] = [];
  const ledger = {
    calls,
    applyReceipt(input: ReceiptInput, from: EnvelopeFrom) {
      calls.push({ op: "applyReceipt", input, from });
      return answer(input.receiptId) as ReturnType<Ledger["applyReceipt"]>;
    },
    recordReport(input: ReportInput, from: EnvelopeFrom) {
      calls.push({ op: "recordReport", input, from });
      return answer(input.reportId) as ReturnType<Ledger["recordReport"]>;
    },
    applyExecutorAnswer: untouchable.applyExecutorAnswer,
  };
  return ledger;
}

function expectNoAck(outcome: ReceiptOutcome) {
  expect(outcome.outcome).not.toBe("ack");
  expect("ack" in outcome).toBe(false);
}

function expectAck(outcome: ReceiptOutcome, id: string, recipient: string, delivery: "new" | "duplicate") {
  if (outcome.outcome !== "ack") throw new Error(`ack가 아니다: ${JSON.stringify(outcome)}`);
  expect(outcome.id).toBe(id);
  expect(outcome.delivery).toBe(delivery);
  expect(outcome.ack.action).toBe("ack");
  expect(outcome.ack.recipient).toBe(recipient);
  expect(outcome.ack.body.ids).toEqual([id]);
  expect(outcome.ack.runGeneration).toBe(0);
  expect(outcome.ack.stopGeneration).toBe(0);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// 실제 장부(임시 파일)에 작업자 실행 하나를 preparing까지 올린다. 지정 실행기는 WORKER_EXECUTOR, 세대 1.
function realLedger() {
  const ledger = open(tempPath());
  const started = startedWorker(ledger);
  const generation = (runId: string) => ledger.runGeneration(runId);
  return { ledger, ...started, generation };
}

describe("보장 1: from은 검증된 머리에서만 온다", () => {
  test("지정 실행기의 영수증은 장부가 받고 ack 초안이 나간다(실제 장부)", async () => {
    const { ledger, runId, requestId, generation } = realLedger();
    const receiptId = id();
    const v = await verified("receipt_started", WORKER_EXECUTOR, { receipt_id: receiptId, run_id: runId, instruction_request_id: requestId, started_at: NOW }, 1, generation);
    const random = fakeRandom();
    expectAck(handleForward(forward(v), { ledger, random }), receiptId, WORKER_EXECUTOR, "new");
    const run = ledger.getRun(runId);
    expect(run.known && run.value?.state).toBe("running");
    expect(run.known && run.value?.startedReceiptId).toBe(receiptId);
  });

  test("지정 실행기가 아닌 연결의 영수증은 장부가 sender_mismatch로 거절하고 ack가 없다(실제 장부)", async () => {
    const { ledger, runId, requestId, generation } = realLedger();
    const receiptId = id();
    const v = await verified("receipt_started", OTHER, { receipt_id: receiptId, run_id: runId, instruction_request_id: requestId, started_at: NOW }, 1, generation);
    const random = fakeRandom();
    const outcome = handleForward(forward(v), { ledger, random });
    expect(outcome).toEqual({ outcome: "ledger_refused", action: "receipt_started", id: receiptId, reason: "sender_mismatch" });
    expectNoAck(outcome);
    expect(random.calls).toBe(0);
    const run = ledger.getRun(runId);
    expect(run.known && run.value?.state).toBe("preparing");
    expect(run.known && run.value?.startedReceiptId).toBe(null);
  });

  // v1의 본문 해석은 모르는 칸을 거절하므로 실제 forward에는 이런 칸이 없다. 그래도 본문이 낸 쪽·세대를 주장하면
  // 처리기가 그것을 읽지 않는다는 것을 손으로 만든 forward로 본다.
  test("본문이 다른 실행기 이름과 세대를 주장해도 장부의 from은 머리의 값이다(실제 장부)", async () => {
    const { ledger, runId, requestId, generation } = realLedger();
    const receiptId = id();
    const v = await verified("receipt_started", OTHER, { receipt_id: receiptId, run_id: runId, instruction_request_id: requestId, started_at: NOW }, 1, generation);
    const forged = { ...v, body: { ...v.body, sender: WORKER_EXECUTOR, executor_id: WORKER_EXECUTOR, run_generation: 1 } } as unknown as Verified;
    const outcome = handleForward(forward(forged), { ledger, random: fakeRandom() });
    expect(outcome).toEqual({ outcome: "ledger_refused", action: "receipt_started", id: receiptId, reason: "sender_mismatch" });
  });

  test("장부로 가는 모든 동작의 from은 머리의 sender·run_generation과 같다(가짜 장부)", async () => {
    const runId = id();
    const gen = () => 4;
    const marker = digest("marker");
    const cases: Verified[] = [
      await verified("receipt_accepted", WORKER_EXECUTOR, { receipt_id: id(), run_id: runId, instruction_request_id: id(), instruction: "task_start" }, 4, gen),
      await verified("receipt_started", WORKER_EXECUTOR, { receipt_id: id(), run_id: runId, instruction_request_id: id(), started_at: NOW }, 4, gen),
      await verified("receipt_stopped", WORKER_EXECUTOR, { receipt_id: id(), run_id: runId, remaining_processes: 0, exit: "failed", stopped_at: NOW }, 4, gen),
      await verified("receipt_cleaned", WORKER_EXECUTOR, { receipt_id: id(), run_id: runId, instruction_request_id: id(), cleaned_at: NOW }, 4, gen),
      await verified("receipt_session_takeover", SESSION_EXECUTOR, { receipt_id: id(), previous_run_id: runId, new_generation_marker_digest: marker, start_permit_id: id(), taken_over_at: NOW }, 4, gen),
      await verified("report_session_broken", SESSION_EXECUTOR, { report_id: id(), run_id: runId, cause: "relay_lost", generation_marker_digest: marker, observed_at: NOW }, 4, gen),
      await verified("report_hook_event", SESSION_EXECUTOR, { report_id: id(), run_id: runId, session_id: id(), prompt_id: id(), event: "Stop", error: null, observed_at: NOW }, 4, gen),
    ];
    for (const v of cases) {
      const spy = spyLedger();
      const forged = { ...v, body: { ...v.body, sender: OTHER, run_generation: 9 } } as unknown as Verified;
      const outcome = handleForward(forward(forged), { ledger: spy, random: fakeRandom() });
      expect(outcome.outcome).toBe("ack");
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]!.from).toEqual({ sender: v.header.sender, runGeneration: 4 });
      expect(spy.calls[0]!.input.bodyDigest).toBe(v.header.body_digest);
      expect(spy.calls[0]!.input.now).toBe(NOW + 2);
    }
  });
});

describe("보장 2: 장부가 받은 것에만 ack", () => {
  test("같은 영수증을 다시 받으면 장부의 duplicate로 ack를 다시 만든다(실제 장부)", async () => {
    const { ledger, runId, requestId, generation } = realLedger();
    const receiptId = id();
    const body = { receipt_id: receiptId, run_id: runId, instruction_request_id: requestId, instruction: "task_start" } as const;
    const first = handleForward(forward(await verified("receipt_accepted", WORKER_EXECUTOR, body, 1, generation)), { ledger, random: fakeRandom(1) });
    const second = handleForward(forward(await verified("receipt_accepted", WORKER_EXECUTOR, body, 1, generation)), { ledger, random: fakeRandom(50) });
    expectAck(first, receiptId, WORKER_EXECUTOR, "new");
    expectAck(second, receiptId, WORKER_EXECUTOR, "duplicate");
    // ack는 매번 새 요청 ID의 새 초안이다(같은 ack 봉투를 다시 보내지 않는다).
    if (first.outcome === "ack" && second.outcome === "ack") expect(first.ack.requestId).not.toBe(second.ack.requestId);
    const run = ledger.getRun(runId);
    expect(run.known && run.value?.acceptedReceiptId).toBe(receiptId);
  });

  test("장부가 거절한 영수증에는 ack가 없고 난수도 쓰지 않는다(실제 장부: unknown_instruction, receipt_conflict)", async () => {
    const { ledger, runId, requestId, generation } = realLedger();
    const random = fakeRandom();
    const stray = handleForward(
      forward(await verified("receipt_accepted", WORKER_EXECUTOR, { receipt_id: id(), run_id: runId, instruction_request_id: id(), instruction: "task_start" }, 1, generation)),
      { ledger, random },
    );
    expect(stray.outcome).toBe("ledger_refused");
    expect(stray.outcome === "ledger_refused" && stray.reason).toBe("unknown_instruction");
    expectNoAck(stray);

    const receiptId = id();
    expectAck(
      handleForward(forward(await verified("receipt_started", WORKER_EXECUTOR, { receipt_id: receiptId, run_id: runId, instruction_request_id: requestId, started_at: NOW }, 1, generation)), {
        ledger,
        random: fakeRandom(),
      }),
      receiptId,
      WORKER_EXECUTOR,
      "new",
    );
    const conflict = handleForward(
      forward(await verified("receipt_started", WORKER_EXECUTOR, { receipt_id: receiptId, run_id: runId, instruction_request_id: requestId, started_at: NOW + 5 }, 1, generation)),
      { ledger, random },
    );
    expect(conflict.outcome === "ledger_refused" && conflict.reason).toBe("receipt_conflict");
    expectNoAck(conflict);
    expect(random.calls).toBe(0);
  });

  test("장부가 던지거나 답의 꼴이 틀리면 ack가 없다(가짜 장부)", async () => {
    const v = await verified("receipt_stopped", WORKER_EXECUTOR, { receipt_id: id(), run_id: id(), remaining_processes: 0, exit: "completed", stopped_at: NOW }, 1, () => 1);
    const receiptId = (v.body as Bodies["receipt_stopped"]).receipt_id;
    const answers: [() => unknown, string][] = [
      [() => { throw new Error("디스크"); }, "threw"],
      [() => undefined, "malformed_answer"],
      [() => ({ ok: true, delivery: "new", ack: id() }), "malformed_answer"],
      [() => ({ ok: true, delivery: "fresh", ack: receiptId }), "malformed_answer"],
      [() => ({ ok: true, ack: receiptId }), "malformed_answer"],
      [() => ({ ok: false, reason: "made_up" }), "malformed_answer"],
      [() => ({ ok: "yes", delivery: "new", ack: receiptId }), "malformed_answer"],
    ];
    for (const [answer, failure] of answers) {
      const random = fakeRandom();
      const outcome = handleForward(forward(v), { ledger: spyLedger(answer), random });
      expect(outcome).toEqual({ outcome: "ledger_failed", action: "receipt_stopped", id: receiptId, failure: failure as "threw" });
      expect(random.calls).toBe(0);
    }
  });

  test("장부의 답에서 칸을 읽다 던지면 예외가 새지 않고 malformed_answer이며 그 문구를 싣지 않는다(가짜 장부)", async () => {
    const v = await verified("receipt_stopped", WORKER_EXECUTOR, { receipt_id: id(), run_id: id(), remaining_processes: 0, exit: "completed", stopped_at: NOW }, 1, () => 1);
    const receiptId = (v.body as Bodies["receipt_stopped"]).receipt_id;
    const marker = `장부답표본-${id()}`;
    const boom = (): never => {
      throw new Error(marker);
    };
    const answers: (() => unknown)[] = [
      () => ({ get ok() { return boom(); } }),
      () => ({ ok: true, get delivery() { return boom(); }, ack: receiptId }),
      () => ({ ok: true, delivery: "new", get ack() { return boom(); } }),
      () => ({ ok: false, get reason() { return boom(); } }),
    ];
    for (const answer of answers) {
      const random = fakeRandom();
      // 예외의 문구가 시험 출력에 실리지 않게 던졌는지만 센다.
      let outcome: ReceiptOutcome | undefined;
      let threw = false;
      try {
        outcome = handleForward(forward(v), { ledger: spyLedger(answer), random });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(outcome).toEqual({ outcome: "ledger_failed", action: "receipt_stopped", id: receiptId, failure: "malformed_answer" });
      expect(JSON.stringify(outcome).includes(marker)).toBe(false);
      expect(random.calls).toBe(0);
    }
  });

  test("ack 초안은 장부가 ok를 돌려준 뒤에만 만든다(호출 순서)", async () => {
    const v = await verified("receipt_cleaned", WORKER_EXECUTOR, { receipt_id: id(), run_id: id(), instruction_request_id: id(), cleaned_at: NOW }, 1, () => 1);
    const order: string[] = [];
    const receiptId = (v.body as Bodies["receipt_cleaned"]).receipt_id;
    const ledger = spyLedger((x) => {
      order.push("ledger");
      return { ok: true, delivery: "new", ack: x };
    });
    const random: Random = {
      bytes(length) {
        order.push("random");
        return new Uint8Array(length).fill(7);
      },
    };
    expectAck(handleForward(forward(v), { ledger, random }), receiptId, WORKER_EXECUTOR, "new");
    expect(order).toEqual(["ledger", "random"]);
  });

  test("정지 세대를 모르면 장부만 반영하고 ack를 만들지 않으며, 다시 오면 duplicate로 ack한다(실제 장부)", async () => {
    const { ledger, runId, requestId, generation } = realLedger();
    const receiptId = id();
    const body = { receipt_id: receiptId, run_id: runId, instruction_request_id: requestId, started_at: NOW };
    const first = handleForward(forward(await verified("receipt_started", WORKER_EXECUTOR, body, 1, generation), { stopGeneration: null }), { ledger, random: fakeRandom() });
    expect(first).toEqual({ outcome: "applied_without_ack", action: "receipt_started", id: receiptId, delivery: "new", reason: "stop_generation_unknown" });
    const again = handleForward(forward(await verified("receipt_started", WORKER_EXECUTOR, body, 1, generation)), { ledger, random: fakeRandom() });
    expectAck(again, receiptId, WORKER_EXECUTOR, "duplicate");
  });

  test("난수 포트가 틀린 길이를 주면 ack를 만들지 않는다(applied_without_ack)", async () => {
    const v = await verified("receipt_started", WORKER_EXECUTOR, { receipt_id: id(), run_id: id(), instruction_request_id: id(), started_at: NOW }, 1, () => 1);
    const outcome = handleForward(forward(v), { ledger: spyLedger(), random: { bytes: () => new Uint8Array(3) } });
    expect(outcome.outcome).toBe("applied_without_ack");
    expect(outcome.outcome === "applied_without_ack" && outcome.reason).toBe("random_unavailable");
  });
});

describe("보장 3: status_report는 감독이 낸 조회의 답일 때만 받는다", () => {
  async function setup() {
    const { ledger, runId, generation } = realLedger();
    const drafted = statusQueryDraft({ recipient: WORKER_EXECUTOR, stopGeneration: 0, runIds: [runId] }, fakeRandom(9));
    if (!drafted.ok) throw new Error(drafted.reason);
    // 조회를 실은 연결은 forward()의 연결(1)이다.
    const pending: SentQuery = { requestId: drafted.draft.requestId, recipient: drafted.draft.recipient, runIds: drafted.draft.body.run_ids, connection: 1 };
    const runs: RunStatus[] = [{ run_id: runId, state: "running", run_generation: 1, last_receipt_id: null }];
    return { ledger, runId, generation, pending, runs };
  }

  test("조회를 받은 실행기의 답은 대조되고 장부의 applyExecutorAnswer에 partial로 넘어간다(status_matched, 실제 장부)", async () => {
    const { ledger, runId, generation, pending, runs } = await setup();
    const v = await verified("status_report", WORKER_EXECUTOR, { in_reply_to: pending.requestId, runs }, 0, generation);
    const outcome = handleForward(forward(v, { pendingQueries: [pending] }), { ledger, random: fakeRandom() });
    const answer = { sender: WORKER_EXECUTOR, connection: 1, coverage: "partial" as const, runs, answeredAt: NOW };
    expect(outcome).toEqual({
      outcome: "status_matched",
      queryRequestId: pending.requestId,
      executor: WORKER_EXECUTOR,
      connection: 1,
      settled: [{ settled: "applied", answer, moved: [], deferred: [], outsideLedger: [] }],
      backlog: [],
    });
    expectNoAck(outcome);
    const run = ledger.getRun(runId);
    expect(run.known && run.value?.state).toBe("preparing");
    expect(ledger.hasRunSighting(runId)).toEqual({ known: true, value: true });
  });

  test("다른 실행기가 같은 in_reply_to로 답하면 받지 않는다(other_executor)", async () => {
    const { generation, pending, runs } = await setup();
    const v = await verified("status_report", OTHER, { in_reply_to: pending.requestId, runs }, 0, generation);
    expect(handleForward(forward(v, { pendingQueries: [pending] }), { ledger: untouchable, random: fakeRandom() })).toEqual({ outcome: "status_unmatched", reason: "other_executor" });
  });

  test("기다리는 조회가 아닌 in_reply_to는 받지 않는다(unknown_query)", async () => {
    const { generation, pending, runs } = await setup();
    const v = await verified("status_report", WORKER_EXECUTOR, { in_reply_to: id(), runs }, 0, generation);
    expect(handleForward(forward(v, { pendingQueries: [pending] }), { ledger: untouchable, random: fakeRandom() })).toEqual({ outcome: "status_unmatched", reason: "unknown_query" });
    expect(handleForward(forward(v), { ledger: untouchable, random: fakeRandom() })).toEqual({ outcome: "status_unmatched", reason: "unknown_query" });
  });

  test("물은 실행 ID와 다른 실행의 답은 받지 않는다(runs_mismatch)", async () => {
    const { generation, pending } = await setup();
    const v = await verified("status_report", WORKER_EXECUTOR, { in_reply_to: pending.requestId, runs: [{ run_id: id(), state: "not_known", run_generation: null, last_receipt_id: null }] }, 0, generation);
    expect(handleForward(forward(v, { pendingQueries: [pending] }), { ledger: untouchable, random: fakeRandom() })).toEqual({ outcome: "status_unmatched", reason: "runs_mismatch" });
  });
});

describe("보장 4: 결과 보고는 보관 포트 없이 받지 않는다(보관·기록·ack는 receipts-results.test.ts)", () => {
  const result: Bodies["report_result"]["result"] = { role: "diagnosis", outcome: "completed", summary: "요약", items: [], refs: [] };

  test("결과 포트가 없으면 report_result는 장부에 넘기지 않고 ack도 없다(실제 장부)", async () => {
    const { ledger, runId, generation } = realLedger();
    const reportId = id();
    const v = await verified("report_result", WORKER_EXECUTOR, { report_id: reportId, run_id: runId, result }, 1, generation);
    const random = fakeRandom();
    const outcome = handleForward(forward(v), { ledger, random });
    expect(outcome).toEqual({ outcome: "result_unknown", id: reportId, runId, at: "ports" });
    expectNoAck(outcome);
    expect(random.calls).toBe(0);
    expect(ledger.pendingReports()).toEqual({ known: true, value: [] });
  });

  test("결과 포트가 없으면 report_result는 장부 포트를 부르지 않는다(가짜 장부)", async () => {
    const v = await verified("report_result", WORKER_EXECUTOR, { report_id: id(), run_id: id(), result }, 1, () => 1);
    const spy = spyLedger();
    expect(handleForward(forward(v), { ledger: spy, random: fakeRandom() }).outcome).toBe("result_unknown");
    expect(spy.calls).toHaveLength(0);
  });

  test("결과 본문이 없는 훅 보고는 signal과 함께 recordReport로 가고 ack가 나간다(실제 장부)", async () => {
    const ledger = ready(open(tempPath()));
    const admitted = must(ledger.admitRun(session()));
    const reportId = id();
    const sessionId = id();
    const promptId = id();
    const v = await verified(
      "report_hook_event",
      SESSION_EXECUTOR,
      { report_id: reportId, run_id: admitted.run.runId, session_id: sessionId, prompt_id: promptId, event: "StopFailure", error: "rate_limit", observed_at: NOW - 10 },
      1,
      (runId) => ledger.runGeneration(runId),
    );
    expectAck(handleForward(forward(v), { ledger, random: fakeRandom() }), reportId, SESSION_EXECUTOR, "new");
    expect(ledger.pendingReports()).toEqual({
      known: true,
      value: [
        {
          reportId,
          action: "report_hook_event",
          runId: admitted.run.runId,
          storedRef: null,
          resultDigest: null,
          signal: { kind: "hook", event: "StopFailure", sessionId, turnId: promptId, stopFailure: "rate_limit", observedAt: NOW - 10 },
        },
      ],
    });
  });

  test("세션 깨짐 보고는 원인·표식 digest를 signal로 옮긴다(가짜 장부)", async () => {
    const marker = digest("marker");
    const v = await verified("report_session_broken", SESSION_EXECUTOR, { report_id: id(), run_id: id(), cause: "main_exited", generation_marker_digest: marker, observed_at: NOW }, 1, () => 1);
    const spy = spyLedger();
    expect(handleForward(forward(v), { ledger: spy, random: fakeRandom() }).outcome).toBe("ack");
    expect(spy.calls[0]!.op).toBe("recordReport");
    expect(spy.calls[0]!.input).toMatchObject({ storedRef: null, resultDigest: null, signal: { kind: "session_broken", cause: "main_exited", markerDigest: marker, observedAt: NOW } });
  });
});

describe("동작별 처리 표와 구별된 거절", () => {
  test("표는 계약 v1에서 감독이 받는 동작 전부와 정확히 같다", () => {
    const toSupervisor = ACTIONS.filter((action) => ACTION_SPECS[action].to.includes("supervisor")).sort();
    expect(Object.keys(EXECUTOR_ACTION_HANDLING).sort()).toEqual(toSupervisor);
  });

  test("받지 않는 동작·모르는 동작은 장부를 부르지 않는 구별된 거절이다", async () => {
    const base = await verified("receipt_started", WORKER_EXECUTOR, { receipt_id: id(), run_id: id(), instruction_request_id: id(), started_at: NOW }, 1, () => 1);
    const as = (action: string) => ({ ...base, action, header: { ...base.header, action } }) as unknown as Verified;
    for (const action of ACTIONS.filter((a) => !ACTION_SPECS[a].to.includes("supervisor"))) {
      expect(handleForward(forward(as(action)), { ledger: untouchable, random: fakeRandom() })).toEqual({ outcome: "rejected", reason: "not_executor_action" });
    }
    expect(handleForward(forward(as("receipt_eaten")), { ledger: untouchable, random: fakeRandom() })).toEqual({ outcome: "rejected", reason: "unknown_action" });
    expect(handleForward(forward(as("hello")), { ledger: untouchable, random: fakeRandom() })).toEqual({ outcome: "rejected", reason: "connection_layer" });
    expect(handleForward(forward(as("stop_sync_request")), { ledger: untouchable, random: fakeRandom() })).toEqual({ outcome: "rejected", reason: "connection_layer" });
    const rule = await verified(
      "report_rule_check",
      SESSION_EXECUTOR,
      { report_id: id(), outcome: "rule_missing", first_marker_digest: digest("m"), restarted_marker_digest: null, start_permit_id: null, checked_at: NOW },
      0,
      () => undefined,
    );
    expect(handleForward(forward(rule), { ledger: untouchable, random: fakeRandom() })).toEqual({ outcome: "rejected", reason: "rule_check_not_supported" });
  });

  test("꼴이 틀린 본문·입력은 예외가 아니라 구별된 거절이고 장부를 부르지 않는다", async () => {
    const base = await verified("receipt_started", WORKER_EXECUTOR, { receipt_id: id(), run_id: id(), instruction_request_id: id(), started_at: NOW }, 1, () => 1);
    const opts = { ledger: untouchable, random: fakeRandom() };
    expect(handleForward(forward({ ...base, body: { ...base.body, receipt_id: 7 } } as unknown as Verified), opts)).toEqual({ outcome: "rejected", reason: "body_malformed", field: "receipt_id" });
    expect(handleForward(forward({ ...base, body: null } as unknown as Verified), opts)).toEqual({ outcome: "rejected", reason: "body_malformed", field: "body" });
    expect(handleForward(forward(base, { now: Number.NaN }), opts)).toEqual({ outcome: "rejected", reason: "input_malformed", field: "now" });
    expect(handleForward(forward({ ...base, ok: false } as unknown as Verified), opts)).toEqual({ outcome: "rejected", reason: "input_malformed", field: "verified" });
    expect(handleForward(forward({ ...base, header: { ...base.header, action: "receipt_stopped" } } as unknown as Verified), opts)).toEqual({ outcome: "rejected", reason: "input_malformed", field: "header" });
    expect(handleForward(forward({ ...base, header: { ...base.header, sender: "" } } as unknown as Verified), opts)).toEqual({ outcome: "rejected", reason: "input_malformed", field: "header.sender" });
    expect(handleForward(null as unknown as ForwardInput, opts)).toEqual({ outcome: "rejected", reason: "input_malformed", field: "forward" });
    const status = await verified("status_report", WORKER_EXECUTOR, { in_reply_to: id(), runs: [{ run_id: id(), state: "not_known", run_generation: null, last_receipt_id: null }] }, 0, () => undefined);
    expect(handleForward(forward({ ...status, body: { ...status.body, in_reply_to: 3 } } as unknown as Verified), opts)).toEqual({ outcome: "rejected", reason: "body_malformed", field: "in_reply_to" });
  });

  test("입력 객체를 바꾸지 않는다", async () => {
    const { ledger, runId, requestId, generation } = realLedger();
    const v = await verified("receipt_started", WORKER_EXECUTOR, { receipt_id: id(), run_id: runId, instruction_request_id: requestId, started_at: NOW }, 1, generation);
    const pending: SentQuery = { requestId: id(), recipient: WORKER_EXECUTOR, runIds: [runId], connection: 1 };
    const input = deepFreeze(forward(v, { pendingQueries: [pending] }));
    const before = JSON.stringify(input);
    expect(handleForward(input, { ledger, random: fakeRandom() }).outcome).toBe("ack");
    expect(JSON.stringify(input)).toBe(before);
    const status = deepFreeze(forward(await verified("status_report", WORKER_EXECUTOR, { in_reply_to: pending.requestId, runs: [{ run_id: runId, state: "running", run_generation: 1, last_receipt_id: null }] }, 0, generation), { pendingQueries: [pending] }));
    const statusBefore = JSON.stringify(status);
    const matched = handleForward(status, { ledger, random: fakeRandom() });
    expect(matched.outcome).toBe("status_matched");
    expect(JSON.stringify(status)).toBe(statusBefore);
    // 돌려준 runs는 입력과 다른 객체다(부르는 쪽이 고쳐도 입력이 바뀌지 않는다).
    if (matched.outcome === "status_matched") expect(matched.settled[0]!.answer.runs[0]).not.toBe((status.forward.verified.body as Bodies["status_report"]).runs[0]);
  });
});
