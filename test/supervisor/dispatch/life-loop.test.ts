import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type Envelope, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { InstructionTimes, Ledger } from "../../../src/ledger/index.ts";
import { type LifeLoopLedger, type LifeLoopPorts, type LifeTickResult, lifeTick, type RunOutcome } from "../../../src/supervisor/dispatch/life-loop.ts";
import type { Random, SendOutcome, Signer } from "../../../src/supervisor/dispatch/ports.ts";
import type { LifecyclePolicy } from "../../../src/supervisor/scheduler/lifecycle.ts";
import { digest, from, id, must, NOW, open, ready, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";

// 정책 숫자와 키는 이 시험이 지어 넣는 자료다. 운영값이 아니다.
const POLICY: LifecyclePolicy = { renewEveryMs: 10_000, answerTimeoutMs: 20_000 };
const keys = generateKeyPairSync("ed25519");
const WRITES = ["recordRenewInstruction", "recordStopInstruction"] as const;

interface World {
  ledger: Ledger;
  ports: LifeLoopPorts;
  // 쓰기 호출, 서명, 내보내기의 차례.
  log: string[];
  sent: Envelope[];
  // 장부 시계와 박자 시계의 기본값.
  setClock(at: number): void;
  // 박자 시계의 다음 읽기들. 다 쓰면 기본값이다.
  queueClock(...ats: number[]): void;
  setIntake(open: boolean): void;
  setStopGeneration(value: number | null): void;
  setSend(next: () => Promise<SendOutcome>): void;
  failSigner(on: boolean): void;
  wrap(over: Partial<LifeLoopLedger>): void;
}

function world(): World {
  let clockAt = NOW;
  const queued: number[] = [];
  const ledger = ready(open(tempPath(), { clock: () => clockAt }));
  const log: string[] = [];
  const sent: Envelope[] = [];
  let intake = true;
  let stopGeneration: number | null = 0;
  let send: () => Promise<SendOutcome> = async () => "sent";
  let signerFails = false;
  let override: Partial<LifeLoopLedger> = {};
  const port = (name: keyof LifeLoopLedger) =>
    ((...args: unknown[]) => {
      if ((WRITES as readonly string[]).includes(name)) log.push(name);
      const fn = (override[name] ?? ledger[name].bind(ledger)) as (...a: unknown[]) => unknown;
      return fn(...args);
    }) as never;
  const random: Random = { bytes: (length) => getRandomValues(new Uint8Array(length)) };
  const signer: Signer = {
    seal(input) {
      log.push("seal");
      if (signerFails) throw new Error("서명 포트 실패");
      return sealEnvelope(input, keys.privateKey);
    },
  };
  const ports: LifeLoopPorts = {
    ledger: {
      listRuns: port("listRuns"),
      listInputs: port("listInputs"),
      instructionTimes: port("instructionTimes"),
      recordRenewInstruction: port("recordRenewInstruction"),
      recordStopInstruction: port("recordStopInstruction"),
    },
    intake: { intakeOpen: () => intake && ledger.intakeOpen(), stopGeneration: () => stopGeneration },
    clock: { now: () => queued.shift() ?? clockAt },
    random,
    signer,
    sink: {
      send: async (envelope) => {
        log.push("send");
        const outcome = await send();
        if (outcome === "sent") sent.push(envelope);
        return outcome;
      },
    },
  };
  return {
    ledger,
    ports,
    log,
    sent,
    setClock: (at) => {
      clockAt = at;
    },
    queueClock: (...ats) => {
      queued.push(...ats);
    },
    setIntake: (value) => {
      intake = value;
    },
    setStopGeneration: (value) => {
      stopGeneration = value;
    },
    setSend: (next) => {
      send = next;
    },
    failSigner: (on) => {
      signerFails = on;
    },
    wrap: (over) => {
      override = over;
    },
  };
}

// 소유자 입력 하나. 취소하려면 cancelInput.
function input(w: World): string {
  const requestId = id();
  must(w.ledger.enqueueInput({ requestId, source: "admin-dm", sourceRef: { ref: `inbox/${id()}`, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
  return requestId;
}

// 작업자 실행 하나를 NOW에 시작한다(시작 지시의 발행 시각 NOW, 임대 끝 NOW + 30000).
function started(w: World, overrides: Parameters<typeof worker>[0] = {}) {
  const run = must(w.ledger.admitRun(worker(overrides))).run;
  const requestId = id();
  must(w.ledger.startRun({ runId: run.runId, requestId, stopGeneration: 0, now: NOW }));
  return { runId: run.runId, requestId, from: from(run) };
}

function accept(w: World, s: ReturnType<typeof started>, action: "receipt_accepted" | "receipt_started" = "receipt_accepted"): void {
  const base = { receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, bodyDigest: digest(`${action}:${s.runId}`), now: NOW };
  must(w.ledger.applyReceipt(action === "receipt_accepted" ? { ...base, action, instruction: "task_start" } : { ...base, action }, s.from));
}

function ran(result: LifeTickResult): Extract<LifeTickResult, { kind: "ran" }> {
  if (result.kind !== "ran") throw new Error(`박자가 돌지 않음: ${JSON.stringify(result)}`);
  return result;
}

const tick = (w: World, lastQueries: { runId: string; at: number }[] = []) => lifeTick(w.ports, POLICY, { lastQueries });

function only(result: LifeTickResult, runId: string): RunOutcome {
  const outcome = ran(result).runs.find((r) => r.runId === runId);
  if (outcome === undefined) throw new Error(`결과 없음: ${JSON.stringify(result)}`);
  return outcome;
}

function times(w: World, runId: string): InstructionTimes {
  const read = w.ledger.instructionTimes(runId);
  if (!read.known || read.value === null) throw new Error("지시 이력을 읽지 못함");
  return read.value;
}

function unanswered(w: World) {
  const read = w.ledger.unansweredInstructions();
  if (!read.known) throw new Error("답 없는 지시를 읽지 못함");
  return read.value.instructions;
}

function state(w: World, runId: string): string | undefined {
  const runs = w.ledger.listRuns();
  if (!runs.known) throw new Error("실행 목록을 읽지 못함");
  return runs.value.find((run) => run.runId === runId)?.state;
}

const writes = (w: World) => w.log.filter((entry) => (WRITES as readonly string[]).includes(entry));

describe("보장 1: 의도 하나, 장부에 적은 뒤에만 지시", () => {
  test("기다림이면 아무것도 쓰지 않는다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    w.setClock(NOW + 5_000);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "wait" });
    expect(w.log).toEqual([]);
  });

  test("갱신은 장부의 기록이 성공한 뒤에 그 답의 값으로 만들어 지정 실행기에 내보낸다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    w.setClock(NOW + 10_000);
    const outcome = only(await tick(w), s.runId);
    expect(outcome).toMatchObject({ outcome: "renew_sent", issuedAt: NOW + 10_000, leaseUntil: NOW + 40_000, executorId: WORKER_EXECUTOR });
    expect(w.log).toEqual(["recordRenewInstruction", "seal", "send"]);
    expect(w.sent).toHaveLength(1);
    const [envelope] = w.sent as [Envelope];
    expect(envelope.header).toMatchObject({ action: "run_renew", recipient: WORKER_EXECUTOR, issued_at: NOW + 10_000, stop_generation: 0 });
    expect(envelope.header.request_id).toBe((outcome as { requestId: string }).requestId);
    expect(envelope.body).toEqual({ run_id: s.runId, lease_until: NOW + 40_000 });
    expect(times(w, s.runId).renewIssued).toEqual({ issuedAt: NOW + 10_000, leaseUntil: NOW + 40_000 });
  });

  test("장부가 거절하면 지시를 만들지 않는다(갱신·취소)", async () => {
    const w = world();
    const owner = input(w);
    const s = started(w, { inputRequestId: owner });
    accept(w, s);
    w.setClock(NOW + 10_000);
    // 박자의 정지 세대가 장부와 다르다. 장부가 같은 트랜잭션에서 거절한다.
    w.setStopGeneration(1);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "renew_refused", reason: "stop_generation_mismatch" });
    must(w.ledger.cancelInput(owner, NOW + 10_000));
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "stop_refused", reason: "stop_generation_mismatch" });
    expect(w.log).toEqual(["recordRenewInstruction", "recordStopInstruction"]);
    expect(w.sent).toEqual([]);
    expect(times(w, s.runId)).toMatchObject({ renewIssued: null, lastStopAt: null });
  });

  test("판단의 읽기가 하나라도 모름이면 그 실행에는 쓰지 않는다", async () => {
    const unknown = () => ({ known: false as const, reason: "io" as const });
    const make = () => {
      const w = world();
      const owner = input(w);
      const s = started(w, { inputRequestId: owner });
      accept(w, s);
      // 쓰기가 불리면 갱신(기한 전)이나 취소가 기록된다.
      must(w.ledger.cancelInput(owner, NOW + 1));
      w.setClock(NOW + 10_000);
      return { w, s };
    };
    for (const [over, read] of [
      [{ instructionTimes: unknown }, "instruction_times"],
      [{ instructionTimes: () => ({ known: true, value: null }) }, "instruction_times"],
      [{ instructionTimes: () => ({ known: "true", value: {} }) }, "instruction_times"],
      [{ listInputs: () => ({ known: true, value: [] }) }, "inputs"],
    ] as const) {
      const { w, s } = make();
      w.wrap(over as Partial<LifeLoopLedger>);
      expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "read_unknown", read });
      expect(w.log).toEqual([]);
    }
    for (const [over, read] of [
      [{ listRuns: unknown }, "runs"],
      [{ listInputs: unknown }, "inputs"],
    ] as const) {
      const { w } = make();
      w.wrap(over as Partial<LifeLoopLedger>);
      expect(await tick(w)).toEqual({ kind: "not_run", reason: "read_unknown", read });
      expect(w.log).toEqual([]);
    }
  });

  test("정지 세대·시계·입력·정책을 모르면 아무것도 쓰지 않는다", async () => {
    const make = () => {
      const w = world();
      const owner = input(w);
      started(w, { inputRequestId: owner });
      must(w.ledger.cancelInput(owner, NOW + 1));
      return w;
    };
    let w = make();
    w.setStopGeneration(null);
    expect(await tick(w)).toEqual({ kind: "not_run", reason: "stop_generation_unknown" });
    w = make();
    w.queueClock(Number.NaN);
    expect(await tick(w)).toEqual({ kind: "not_run", reason: "clock_unavailable" });
    w = make();
    expect(await lifeTick(w.ports, POLICY, { lastQueries: [{ runId: "x", at: -1 }] })).toEqual({ kind: "not_run", reason: "input_malformed" });
    w = make();
    expect(await lifeTick(w.ports, { renewEveryMs: 20_000, answerTimeoutMs: 1 }, { lastQueries: [] })).toEqual({ kind: "not_run", reason: "policy_rejected" });
    expect(w.log).toEqual([]);
  });

  test("정지 중에도 취소는 장부에 적고 내보낸다. 갱신은 새 업무라 적지 않는다", async () => {
    const w = world();
    const owner = input(w);
    const s = started(w, { inputRequestId: owner });
    accept(w, s);
    must(w.ledger.applyStop({ generation: 1, stopped: true, now: NOW + 1 }));
    w.setStopGeneration(1);
    w.setClock(NOW + 10_000);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "renew_withheld", reason: "intake_closed" });
    expect(w.log).toEqual([]);
    must(w.ledger.cancelInput(owner, NOW + 10_000));
    expect(only(await tick(w), s.runId)).toMatchObject({ outcome: "stop_sent", cancelReason: "requested" });
    expect(w.sent.map((e) => [e.header.action, e.header.stop_generation])).toEqual([["task_cancel", 1]]);
  });

  test("판단이 확정을 내도 확정을 적거나 내보내지 않는다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    must(w.ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: s.runId, exit: "failed", bodyDigest: digest("stopped"), now: NOW + 1 }, s.from));
    expect(state(w, s.runId)).toBe("failed_stopped");
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "finalize_withheld" });
    expect(w.log).toEqual([]);
    expect(times(w, s.runId).lastFinalizeAt).toBeNull();
  });
});

describe("보장 2: 갱신은 시작 접수 뒤에만, 여유가 있을 때만", () => {
  test("시작 접수가 장부에 없으면 적지 않는다. 시작 영수증만 있어도 접수로 본다", async () => {
    const w = world();
    const s = started(w);
    w.setClock(NOW + 10_000);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "renew_withheld", reason: "start_not_accepted" });
    expect(w.log).toEqual([]);
    expect(times(w, s.runId).renewIssued).toBeNull();
    accept(w, s, "receipt_started");
    expect(only(await tick(w), s.runId)).toMatchObject({ outcome: "renew_sent" });
  });

  test("기록 직전에 기록에 쓸 시각으로 여유를 다시 잰다", async () => {
    // 박자 처음 NOW+10000에는 갱신, 기록 직전 NOW+17001에는 여유(13000)가 앞 임대의 끝(NOW+30000)에 모자란다.
    const w = world();
    const s = started(w);
    accept(w, s);
    w.queueClock(NOW + 10_000, NOW + 17_001);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "renew_withheld", reason: "margin_lost" });
    expect(w.log).toEqual([]);
    // 경계: 기록 직전 NOW+17000이면 그 시각으로 적는다(싣기 직전도 같은 시각).
    w.queueClock(NOW + 10_000, NOW + 17_000, NOW + 17_000);
    expect(only(await tick(w), s.runId)).toMatchObject({ outcome: "renew_sent", issuedAt: NOW + 17_000, leaseUntil: NOW + 47_000 });
  });

  test("싣는 순간 앞 임대의 끝과 봉투 시한 가운데 이른 것까지 여유가 없으면 싣지 않고 구별해 낸다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    // 박자 처음, 기록 직전, 싣기 직전. 싣기 직전에 앞 임대의 끝(NOW+30000)까지 12999ms.
    w.queueClock(NOW + 10_000, NOW + 10_000, NOW + 17_001);
    const outcome = only(await tick(w), s.runId);
    expect(outcome).toMatchObject({
      outcome: "renew_recorded_not_sent",
      reason: "renew_margin_lost",
      delivery: "not_sent",
      issuedAt: NOW + 10_000,
      leaseUntil: NOW + 40_000,
      executorId: WORKER_EXECUTOR,
      stopGeneration: 0,
    });
    expect(w.log).toEqual(["recordRenewInstruction", "seal"]);
    expect(times(w, s.runId).renewIssued).toEqual({ issuedAt: NOW + 10_000, leaseUntil: NOW + 40_000 });

    const w2 = world();
    const s2 = started(w2);
    accept(w2, s2);
    w2.queueClock(NOW + 10_000, NOW + 10_000, NOW + 17_000);
    expect(only(await tick(w2), s2.runId)).toMatchObject({ outcome: "renew_sent" });
  });

  test("작업 기한이 여유 안에 끝나는 실행에는 갱신을 내지 않는다", async () => {
    const w = world();
    const s = started(w, { deadlineAt: NOW + 22_999 });
    accept(w, s);
    w.setClock(NOW + 10_000);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "renew_withheld", reason: "deadline_within_margin" });
    expect(w.log).toEqual([]);

    const w2 = world();
    const s2 = started(w2, { deadlineAt: NOW + 23_000 });
    accept(w2, s2);
    w2.setClock(NOW + 10_000);
    expect(only(await tick(w2), s2.runId)).toMatchObject({ outcome: "renew_sent" });
  });

  test("적었지만 싣지 못한 갱신은 식별값을 내고 새 요청 ID로 다시 만들지 않는다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    w.setClock(NOW + 10_000);
    w.setSend(async () => "no_connection");
    const outcome = only(await tick(w), s.runId) as Extract<RunOutcome, { outcome: "renew_recorded_not_sent" }>;
    expect(outcome).toMatchObject({ outcome: "renew_recorded_not_sent", reason: "no_connection", delivery: "not_sent", leaseUntil: NOW + 40_000 });
    expect(typeof outcome.requestId).toBe("string");
    // 같은 시각의 다음 박자는 새 갱신을 적지 않는다.
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "wait" });
    expect(writes(w)).toEqual(["recordRenewInstruction"]);
  });
});

describe("보장 3: 모르면 같은 실행을 조회한다", () => {
  test("임대가 모름이면 같은 실행 ID로 조회하고, 장부에 지시 줄을 만들지 않고, 기다리는 조회를 싣는다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    // 여유 없이 적은 갱신(NOW+20000 + 13000 > NOW+30000): 장부는 그 끝을 믿지 않고 lease.expiresAt이 모름이다.
    must(w.ledger.recordRenewInstruction({ runId: s.runId, requestId: id(), stopGeneration: 0, now: NOW + 20_000 }));
    const before = times(w, s.runId);
    expect(before.lease?.expiresAt).toBe("unknown");
    const pendingBefore = unanswered(w);
    w.setClock(NOW + 20_001);
    const result = ran(await tick(w));
    const outcome = only(result, s.runId) as Extract<RunOutcome, { outcome: "query_sent" }>;
    expect(outcome).toMatchObject({ outcome: "query_sent", executorId: WORKER_EXECUTOR, at: NOW + 20_001, cause: "intent" });
    expect(w.sent.map((e) => [e.header.action, e.header.recipient, e.body])).toEqual([["status_query", WORKER_EXECUTOR, { run_ids: [s.runId] }]]);
    expect(result.pendingQueries).toEqual([{ requestId: outcome.requestId, recipient: WORKER_EXECUTOR, runIds: [s.runId] }]);
    expect(writes(w)).toEqual([]);
    expect(times(w, s.runId)).toEqual(before);
    expect(unanswered(w)).toEqual(pendingBefore);
  });

  test("마지막 조회부터 answerTimeoutMs 안에는 같은 실행을 다시 묻지 않는다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    must(w.ledger.markLost(NOW + 1));
    expect(state(w, s.runId)).toBe("unknown_running");
    w.setClock(NOW + 40_000);
    const asked = [{ runId: s.runId, at: NOW + 20_001 }];
    expect(only(await tick(w, asked), s.runId)).toEqual({ runId: s.runId, outcome: "query_held", lastQueryAt: NOW + 20_001, cause: "intent" });
    expect(w.log).toEqual([]);
    w.setClock(NOW + 40_001);
    expect(only(await tick(w, asked), s.runId)).toMatchObject({ outcome: "query_sent", at: NOW + 40_001 });
  });

  test("내보내기가 실렸는지 모르면 기다리는 조회로 남기고, 연결이 없으면 남기지 않는다", async () => {
    const w = world();
    const s = started(w);
    must(w.ledger.markLost(NOW + 1));
    w.setSend(async () => {
      throw new Error("소켓 실패");
    });
    const unknown = ran(await tick(w));
    expect(only(unknown, s.runId)).toMatchObject({ outcome: "query_not_sent", reason: "send_threw", delivery: "unknown" });
    expect(unknown.pendingQueries).toHaveLength(1);
    w.setSend(async () => "no_connection");
    const none = ran(await tick(w));
    expect(only(none, s.runId)).toMatchObject({ outcome: "query_not_sent", reason: "no_connection", delivery: "not_sent" });
    expect(none.pendingQueries).toEqual([]);
  });
});

describe("보장 4: 취소와 기한은 전해진다, 쓰기 뒤의 실패는 결과를 지우지 않는다", () => {
  test("소유자 입력이 취소되면 사유 requested를 장부에 적고 같은 요청 ID로 내보낸다", async () => {
    const w = world();
    const owner = input(w);
    const s = started(w, { inputRequestId: owner });
    accept(w, s);
    must(w.ledger.cancelInput(owner, NOW + 1));
    w.setClock(NOW + 2_000);
    const outcome = only(await tick(w), s.runId) as Extract<RunOutcome, { outcome: "stop_sent" }>;
    expect(outcome).toMatchObject({ outcome: "stop_sent", cancelReason: "requested", issuedAt: NOW + 2_000, executorId: WORKER_EXECUTOR });
    expect(w.log).toEqual(["recordStopInstruction", "seal", "send"]);
    const [envelope] = w.sent as [Envelope];
    expect(envelope.header).toMatchObject({ action: "task_cancel", request_id: outcome.requestId, issued_at: NOW + 2_000 });
    expect(envelope.body).toEqual({ run_id: s.runId, reason: "requested" });
    expect(state(w, s.runId)).toBe("stopping");
    // 본문을 다시 만들 칸(사유)이 장부에 함께 적혔다.
    expect(unanswered(w).find((i) => i.requestId === outcome.requestId)?.rebuild).toEqual({ action: "task_cancel", reason: "requested" });
  });

  test("작업 기한이 지나면 사유 deadline으로 적고 내보낸다", async () => {
    const w = world();
    const s = started(w, { deadlineAt: NOW + 20_000 });
    accept(w, s);
    w.setClock(NOW + 20_000);
    const outcome = only(await tick(w), s.runId) as Extract<RunOutcome, { outcome: "stop_sent" }>;
    expect(outcome).toMatchObject({ outcome: "stop_sent", cancelReason: "deadline" });
    expect(w.sent.map((e) => e.body)).toEqual([{ run_id: s.runId, reason: "deadline" }]);
    expect(unanswered(w).find((i) => i.requestId === outcome.requestId)?.rebuild).toEqual({ action: "task_cancel", reason: "deadline" });
  });

  test("이미 종료 지시가 적힌 실행에는 새 요청 ID의 종료를 또 적지 않고 같은 ID로 묻는다", async () => {
    const w = world();
    const owner = input(w);
    const s = started(w, { inputRequestId: owner });
    accept(w, s);
    must(w.ledger.cancelInput(owner, NOW + 1));
    w.setClock(NOW + 2_000);
    expect(only(await tick(w), s.runId)).toMatchObject({ outcome: "stop_sent" });
    // 종료를 적은 뒤 끊겨 unknown_running이 되면 판단은 다시 종료를 낸다. 장부는 새 요청 ID면 받아 준다.
    must(w.ledger.markLost(NOW + 3_000));
    w.setClock(NOW + 4_000);
    expect(only(await tick(w), s.runId)).toMatchObject({ outcome: "query_sent", cause: "stop_already_recorded" });
    expect(writes(w)).toEqual(["recordStopInstruction"]);
    expect(unanswered(w).filter((i) => i.runId === s.runId && i.action === "task_cancel")).toHaveLength(1);
    expect(w.sent.map((e) => e.header.action)).toEqual(["task_cancel", "status_query"]);
  });

  test("대기 실행의 취소는 지시 없이 not_started로 닫는다", async () => {
    const w = world();
    const owner = input(w);
    const run = must(w.ledger.admitRun(worker({ inputRequestId: owner }))).run;
    must(w.ledger.cancelInput(owner, NOW + 1));
    expect(only(await tick(w), run.runId)).toEqual({ runId: run.runId, outcome: "closed_not_started" });
    expect(w.sent).toEqual([]);
    expect(state(w, run.runId)).toBe("not_started");
  });

  test("장부에 쓴 뒤의 실패는 그 항목의 결과가 되고, 예상하지 못한 예외도 앞의 결과를 지우지 않는다", async () => {
    const make = () => {
      const w = world();
      const a = input(w);
      const b = input(w);
      const first = started(w, { inputRequestId: a });
      accept(w, first);
      const second = must(w.ledger.admitRun(worker({ inputRequestId: b }))).run;
      must(w.ledger.cancelInput(a, NOW + 1));
      must(w.ledger.cancelInput(b, NOW + 1));
      return { w, first: first.runId, second: second.runId };
    };
    // 서명 포트의 실패: 적힌 취소의 식별값이 남고, 박자는 다음 실행을 닫는다.
    let c = make();
    c.w.failSigner(true);
    let result = ran(await tick(c.w));
    expect(result.halted).toBeNull();
    expect(only(result, c.first)).toMatchObject({ outcome: "stop_recorded_not_sent", reason: "seal_threw", cancelReason: "requested", executorId: WORKER_EXECUTOR });
    expect(only(result, c.second)).toEqual({ runId: c.second, outcome: "closed_not_started" });
    expect(state(c.w, c.first)).toBe("stopping");

    // 둘째 실행의 장부 답을 읽다 던진다: 첫 실행의 결과는 그대로이고 멈춘 자리가 나온다.
    c = make();
    const second = c.second;
    c.w.wrap({
      recordStopInstruction: ((args: { runId: string }) => {
        if (args.runId !== second) return c.w.ledger.recordStopInstruction(args as never);
        return {
          ok: true,
          get run(): never {
            throw new Error("답 읽기 실패");
          },
        };
      }) as never,
    });
    result = ran(await tick(c.w));
    expect(result.halted).toBe("threw");
    expect(result.haltedAt).toBe(second);
    expect(result.runs).toEqual([expect.objectContaining({ runId: c.first, outcome: "stop_sent" })]);
    expect(c.w.sent.map((e) => e.header.action)).toEqual(["task_cancel"]);
  });

  test("결과에는 자격 digest·서명·nonce·키 재료가 없다", async () => {
    const w = world();
    const owner = input(w);
    const s = started(w, { inputRequestId: owner });
    accept(w, s);
    w.setClock(NOW + 10_000);
    const renewed = ran(await tick(w));
    must(w.ledger.cancelInput(owner, NOW + 10_000));
    const stopped = ran(await tick(w));
    const text = JSON.stringify([renewed, stopped]);
    expect(text).not.toContain(digest("credential bytes"));
    for (const envelope of w.sent) {
      expect(text).not.toContain(envelope.signature);
      expect(text).not.toContain(envelope.header.nonce);
    }
    expect(text).not.toContain("PRIVATE");
  });
});

test("이 모듈은 시계·난수·소켓·타이머를 직접 부르지 않고 확정 초안을 쓰지 않는다", async () => {
  const source = await Bun.file(new URL("../../../src/supervisor/dispatch/life-loop.ts", import.meta.url)).text();
  for (const banned of ["Date.now", "new Date", "performance.now", "Math.random", "randomUUID", "getRandomValues", "setTimeout", "setInterval", "node:", "bun:", "Bun.", "process.", "scheduler/tools", "finalizeDraft"]) {
    expect(source).not.toContain(banned);
  }
});
