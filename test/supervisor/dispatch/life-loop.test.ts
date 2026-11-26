import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { copyFileSync } from "node:fs";
import { type Envelope, sealEnvelope } from "../../../src/contract/v1/index.ts";
import { type InstructionTimes, type Ledger, loadMigrations } from "../../../src/ledger/index.ts";
import { type LifeLoopLedger, type LifeLoopPorts, type LifeTickResult, lifeTick, type RunOutcome } from "../../../src/supervisor/dispatch/life-loop.ts";
import type { Random, SendOutcome, Signer } from "../../../src/supervisor/dispatch/ports.ts";
import type { LifecyclePolicy } from "../../../src/supervisor/scheduler/lifecycle.ts";
import { digest, from, id, must, NOW, open, ready, SESSION_EXECUTOR, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";

// 정책 숫자와 키는 이 시험이 지어 넣는 자료다. 운영값이 아니다.
const POLICY: LifecyclePolicy = { renewEveryMs: 10_000, answerTimeoutMs: 20_000 };
const keys = generateKeyPairSync("ed25519");
const WRITES = ["recordRenewInstruction", "recordStopInstruction", "recordFinalizeInstruction"] as const;

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
  // 지정 실행기의 연결 판정(LinkGate.mayIssue의 답). 기본은 { ok: true }.
  setLink(next: (executorId: string) => unknown): void;
  failSigner(on: boolean): void;
  wrap(over: Partial<LifeLoopLedger>): void;
}

function world(path = tempPath()): World {
  let clockAt = NOW;
  const queued: number[] = [];
  const ledger = ready(open(path, { clock: () => clockAt }));
  const log: string[] = [];
  const sent: Envelope[] = [];
  let intake = true;
  let stopGeneration: number | null = 0;
  let send: () => Promise<SendOutcome> = async () => "sent";
  let link: (executorId: string) => unknown = () => ({ ok: true });
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
      settledResult: port("settledResult"),
      failedStop: port("failedStop"),
      recordRenewInstruction: port("recordRenewInstruction"),
      recordStopInstruction: port("recordStopInstruction"),
      recordFinalizeInstruction: port("recordFinalizeInstruction"),
    },
    intake: { intakeOpen: () => intake && ledger.intakeOpen(), stopGeneration: () => stopGeneration },
    links: { mayIssue: (executorId) => link(executorId) as never },
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
    setLink: (next) => {
      link = next;
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
type Started = ReturnType<typeof started>;

function accept(w: World, s: ReturnType<typeof started>, action: "receipt_accepted" | "receipt_started" = "receipt_accepted"): void {
  const base = { receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, bodyDigest: digest(`${action}:${s.runId}`), now: NOW };
  must(w.ledger.applyReceipt(action === "receipt_accepted" ? { ...base, action, instruction: "task_start" } : { ...base, action }, s.from));
}

function ran(result: LifeTickResult): Extract<LifeTickResult, { kind: "ran" }> {
  if (result.kind !== "ran") throw new Error(`박자가 돌지 않음: ${JSON.stringify(result)}`);
  return result;
}

const tick = (w: World, lastQueries: { runId: string; at: number }[] = [], unsentRenews: string[] = []) => lifeTick(w.ports, POLICY, { lastQueries, unsentRenews });

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
    expect(await lifeTick(w.ports, POLICY, { lastQueries: [{ runId: "x", at: -1 }], unsentRenews: [] })).toEqual({ kind: "not_run", reason: "input_malformed" });
    w = make();
    expect(await lifeTick(w.ports, POLICY, { lastQueries: [], unsentRenews: [7] } as never)).toEqual({ kind: "not_run", reason: "input_malformed" });
    w = make();
    expect(await lifeTick(w.ports, { renewEveryMs: 20_000, answerTimeoutMs: 1 }, { lastQueries: [], unsentRenews: [] })).toEqual({ kind: "not_run", reason: "policy_rejected" });
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

  test("종료 영수증이 곧바로 failed_stopped로 옮긴 실행(exit failed)은 요청 취소가 없어도 장부의 exit로 outcome failed를 정해 적고 내보낸다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    must(w.ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: s.runId, exit: "failed", bodyDigest: digest("stopped"), now: NOW + 1 }, s.from));
    expect(state(w, s.runId)).toBe("failed_stopped");
    w.setClock(NOW + 10_000);
    expect(only(await tick(w), s.runId)).toMatchObject({ runId: s.runId, outcome: "finalize_sent", issuedAt: NOW + 10_000 });
    expect(w.log).toEqual(["recordFinalizeInstruction", "seal", "send"]);
    expect((w.sent[0] as Envelope).body).toEqual({ run_id: s.runId, outcome: "failed", result_digest: null, stored_at: NOW + 1 });
    expect(times(w, s.runId).lastFinalizeAt).toBe(NOW + 10_000);
  });

  // 결과 보고가 받아들여지고 판정이 끝나도 보고가 저장 자리와 함께 반영되지 않았으면(markResult는 보고 없이도 판정한다) 확정 의도가
  // 나오지 않고 자리는 쥔 채다(보고의 수락은 종료 증명·게시 허가가 아니다). 반영된 실행의 확정은 아래 "확정".
  test("보고 없이 판정된 ready_result는 확정 의도를 내지 않고 자리를 풀지 않는다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    must(w.ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: s.runId, exit: "completed", bodyDigest: digest("stopped ok"), now: NOW + 1 }, s.from));
    must(w.ledger.markResult({ runId: s.runId, resultDigest: digest("result body"), now: NOW + 3 }));
    expect(state(w, s.runId)).toBe("ready_result");
    expect(w.ledger.settledResult(s.runId)).toEqual({ known: true, value: null });
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "wait" });
    expect(w.log).toEqual([]);
    expect(times(w, s.runId).lastFinalizeAt).toBeNull();
    expect(w.ledger.slotFree("worker")).toEqual({ known: true, value: false });
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

    // 둘째 실행의 장부 쓰기는 실제로 커밋되고 그 답을 읽다 던진다: 첫 실행의 결과와 둘째 실행의 항목이 남고, 셋째 실행은 쓰지 않는다.
    // 작업자 자리는 하나라 시작한 실행은 가운데 하나이고 앞뒤는 대기 실행이다.
    const w = world();
    const owners = [input(w), input(w), input(w)];
    const first = { runId: must(w.ledger.admitRun(worker({ inputRequestId: owners[0] }))).run.runId };
    const second = started(w, { inputRequestId: owners[1] });
    accept(w, second);
    const third = { runId: must(w.ledger.admitRun(worker({ inputRequestId: owners[2] }))).run.runId };
    for (const owner of owners) must(w.ledger.cancelInput(owner, NOW + 1));
    w.setClock(NOW + 2_000);
    w.wrap({
      recordStopInstruction: ((args: { runId: string }) => {
        const answer = w.ledger.recordStopInstruction(args as never);
        if (args.runId !== second.runId) return answer;
        return {
          ok: true,
          get run(): never {
            throw new Error("답 읽기 실패");
          },
        };
      }) as never,
    });
    result = ran(await tick(w));
    expect(result.halted).toBe("threw");
    expect(result.haltedAt).toBe(second.runId);
    const stopLine = unanswered(w).find((i) => i.runId === second.runId && i.action === "task_cancel");
    expect(result.runs).toEqual([
      { runId: first.runId, outcome: "closed_not_started" },
      expect.objectContaining({ runId: second.runId, outcome: "stop_recorded_not_sent", reason: "ledger_answer_malformed", requestId: stopLine?.requestId, issuedAt: NOW + 2_000, executorId: WORKER_EXECUTOR, cancelReason: "requested" }),
    ]);
    expect(writes(w)).toEqual(["recordStopInstruction", "recordStopInstruction"]);
    expect(state(w, third.runId)).toBe("queued");
    expect(w.sent).toEqual([]);
  });

  test("갱신의 답을 읽다 던지면 적힌 갱신이 결과에 남고, 쓰기 포트가 던지면 같은 식별값으로 기록 여부 모름을 낸다", async () => {
    // 실제 장부에 적은 뒤 leaseUntil을 읽다 던진다. 뒤의 대기 실행 b는 취소됐지만 닫히지 않는다.
    const w = world();
    const a = started(w);
    accept(w, a);
    const owner = input(w);
    const b = must(w.ledger.admitRun(worker({ inputRequestId: owner }))).run;
    must(w.ledger.cancelInput(owner, NOW + 1));
    w.setClock(NOW + 10_000);
    w.wrap({
      recordRenewInstruction: ((args: { runId: string }) => {
        const answer = must(w.ledger.recordRenewInstruction(args as never));
        if (args.runId !== a.runId) return answer;
        return {
          ok: true,
          get leaseUntil(): never {
            throw new Error("답 읽기 실패");
          },
        };
      }) as never,
    });
    const result = ran(await tick(w));
    expect(result).toMatchObject({ halted: "threw", haltedAt: a.runId });
    expect(result.runs).toEqual([
      expect.objectContaining({ runId: a.runId, outcome: "renew_recorded_not_sent", reason: "ledger_answer_malformed", leaseUntil: null, issuedAt: NOW + 10_000, delivery: "not_sent" }),
    ]);
    expect(times(w, a.runId).renewIssued).toEqual({ issuedAt: NOW + 10_000, leaseUntil: NOW + 40_000 });
    expect(writes(w)).toEqual(["recordRenewInstruction"]);
    expect(state(w, b.runId)).toBe("queued");

    // 쓰기 포트가 커밋한 뒤 던진다: 적혔는지 모르는 항목으로 같은 요청 ID를 내고, 다음 실행은 계속 본다.
    const w2 = world();
    const c = started(w2);
    accept(w2, c);
    const owner2 = input(w2);
    const d = must(w2.ledger.admitRun(worker({ inputRequestId: owner2 }))).run;
    must(w2.ledger.cancelInput(owner2, NOW + 1));
    w2.setClock(NOW + 10_000);
    let passed: string | undefined;
    w2.wrap({
      recordRenewInstruction: ((args: { runId: string; requestId: string }) => {
        const answer = w2.ledger.recordRenewInstruction(args as never);
        if (args.runId !== c.runId) return answer;
        passed = args.requestId;
        throw new Error("커밋 뒤 끊김");
      }) as never,
    });
    const second = ran(await tick(w2));
    const unknown = only(second, c.runId) as Extract<RunOutcome, { outcome: "renew_record_unknown" }>;
    expect(unknown).toMatchObject({ outcome: "renew_record_unknown", reason: "threw", issuedAt: NOW + 10_000, executorId: WORKER_EXECUTOR, stopGeneration: 0 });
    expect(unknown.requestId).toBe(passed as string);
    expect(times(w2, c.runId).renewIssued).toEqual({ issuedAt: NOW + 10_000, leaseUntil: NOW + 40_000 });
    expect(only(second, d.runId)).toEqual({ runId: d.runId, outcome: "closed_not_started" });
    expect(second.halted).toBeNull();
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

describe("쓰기 직전의 확인: 연결, 최신 읽기, 칸의 꼴, 싣지 못한 갱신, 시각", () => {
  const plain = (ports: LifeLoopPorts, policy: LifecyclePolicy = POLICY) => lifeTick(ports, policy, { lastQueries: [], unsentRenews: [] });

  test("지정 실행기의 연결이 지시를 낼 수 없거나 모르면 갱신을 적지 않는다. 종료는 연결을 보지 않고 적는다", async () => {
    const w = world();
    const owner = input(w);
    const s = started(w, { inputRequestId: owner });
    accept(w, s);
    w.setClock(NOW + 17_000);
    const asked: string[] = [];
    w.setLink((executorId) => {
      asked.push(executorId);
      return { ok: false, reason: "no_connection" };
    });
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "renew_withheld", reason: "no_connection" });
    expect(asked).toEqual([WORKER_EXECUTOR]);
    for (const answer of [
      () => {
        throw new Error("연결 표를 읽지 못함");
      },
      () => ({ ok: "true" }),
      () => undefined,
    ]) {
      w.setLink(answer);
      expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "renew_withheld", reason: "link_unknown" });
    }
    expect(w.log).toEqual([]);
    expect(times(w, s.runId)).toMatchObject({ lease: { issuedAt: NOW, expiresAt: NOW + 30_000 }, renewIssued: null });

    w.setLink((executorId) => {
      asked.push(executorId);
      return { ok: false, reason: "no_connection" };
    });
    must(w.ledger.cancelInput(owner, NOW + 17_000));
    w.setSend(async () => "no_connection");
    expect(only(await tick(w), s.runId)).toMatchObject({ outcome: "stop_recorded_not_sent", reason: "no_connection", cancelReason: "requested" });
    expect(asked).toEqual([WORKER_EXECUTOR]);
    expect(writes(w)).toEqual(["recordStopInstruction"]);
  });

  test("겹쳐 부른 박자는 읽기·쓰기 없이 돌려보낸다: 갱신·종료는 한 줄이고 갱신 봉투의 끝은 장부의 값과 같다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    w.setClock(NOW + 10_000);
    const [one, two] = await Promise.all([tick(w), tick(w)]);
    expect(two).toEqual({ kind: "not_run", reason: "tick_in_progress" });
    expect(only(one, s.runId)).toMatchObject({ outcome: "renew_sent", leaseUntil: NOW + 40_000 });
    expect(writes(w)).toEqual(["recordRenewInstruction"]);
    const stored = times(w, s.runId);
    expect(w.sent.map((e) => e.body)).toEqual([{ run_id: s.runId, lease_until: stored.renewIssued?.leaseUntil }]);
    expect(stored.lease).toEqual({ issuedAt: NOW + 10_000, expiresAt: NOW + 40_000 });
    // 앞 박자가 돌아온 뒤에는 다시 돈다.
    expect((await tick(w)).kind).toBe("ran");

    const w2 = world();
    const owner = input(w2);
    const c = started(w2, { inputRequestId: owner });
    accept(w2, c);
    must(w2.ledger.cancelInput(owner, NOW + 1));
    w2.setClock(NOW + 10_000);
    const [three, four] = await Promise.all([tick(w2), tick(w2)]);
    expect(only(three, c.runId)).toMatchObject({ outcome: "stop_sent" });
    expect(four).toEqual({ kind: "not_run", reason: "tick_in_progress" });
    expect(unanswered(w2).filter((i) => i.runId === c.runId && i.action === "task_cancel")).toHaveLength(1);
    expect(w2.sent.map((e) => e.header.action)).toEqual(["task_cancel"]);
  });

  test("다른 포트 묶음의 박자가 앞 항목을 기다리는 동안 끼어들면 쓰기 직전의 다시 읽기가 같은 실행의 두 번째 지시를 막는다", async () => {
    // 대기 실행 Q, 접수된 실행 A 순. 두 박자가 모두 A의 의도를 고른 뒤 Q를 처리하는 사이에 서로 끼어든다.
    for (const cancel of [false, true]) {
      const w = world();
      const q = must(w.ledger.admitRun(worker())).run;
      const owner = input(w);
      const a = started(w, { inputRequestId: owner });
      accept(w, a);
      if (cancel) must(w.ledger.cancelInput(owner, NOW + 1));
      w.setClock(NOW + 10_000);
      const other: LifeLoopPorts = { ...w.ports, ledger: { ...w.ports.ledger } };
      const results = (await Promise.all([tick(w), plain(other)])).map(ran);
      for (const r of results) expect(only(r, q.runId)).toEqual({ runId: q.runId, outcome: "wait" });
      // 두 포트 묶음은 같은 쓰기 함수를 나눠 쓰므로 쓰기 호출이 한 기록에 모인다.
      expect(writes(w)).toEqual([cancel ? "recordStopInstruction" : "recordRenewInstruction"]);
      if (cancel) expect(unanswered(w).filter((i) => i.runId === a.runId && i.action === "task_cancel")).toHaveLength(1);
      expect(results.map((r) => only(r, a.runId).outcome).sort()).toEqual([cancel ? "stop_sent" : "renew_sent", "superseded"]);
      expect(w.sent).toHaveLength(1);
      if (!cancel) expect((w.sent[0] as Envelope).body).toEqual({ run_id: a.runId, lease_until: times(w, a.runId).renewIssued?.leaseUntil });
    }
  });

  test("앞 실행을 내보내는 사이에 들어온 취소·종료 쓰기를 보고 낡은 판단으로 쓰지 않는다", async () => {
    // 대기 실행 Q(취소됨), 접수된 실행 A 순. Q를 닫는 장부 쓰기 뒤에 다른 쓰기가 A에 끼어든다.
    const make = (between: (w: World, a: Started, ownerA: string) => void, cancelA: boolean) => {
      const w = world();
      const ownerQ = input(w);
      const q = must(w.ledger.admitRun(worker({ inputRequestId: ownerQ }))).run;
      const ownerA = input(w);
      const a = started(w, { inputRequestId: ownerA });
      accept(w, a);
      must(w.ledger.cancelInput(ownerQ, NOW + 1));
      if (cancelA) must(w.ledger.cancelInput(ownerA, NOW + 1));
      w.setClock(NOW + 10_000);
      w.wrap({
        recordStopInstruction: ((args: { runId: string }) => {
          const answer = w.ledger.recordStopInstruction(args as never);
          if (args.runId === q.runId) between(w, a, ownerA);
          return answer;
        }) as never,
      });
      return { w, a, q };
    };
    // 갱신을 계획한 뒤 소유자 입력이 취소된다.
    const one = make((w, _a, ownerA) => must(w.ledger.cancelInput(ownerA, NOW + 10_000)), false);
    const result = ran(await tick(one.w));
    expect(only(result, one.q.runId)).toEqual({ runId: one.q.runId, outcome: "closed_not_started" });
    expect(only(result, one.a.runId)).toEqual({ runId: one.a.runId, outcome: "superseded", planned: "renew_lease" });
    expect(times(one.w, one.a.runId).renewIssued).toBeNull();
    expect(only(await tick(one.w), one.a.runId)).toMatchObject({ outcome: "stop_sent", cancelReason: "requested" });

    // 종료를 계획한 뒤 다른 쓰기가 같은 실행의 종료를 적는다.
    const two = make((w, a) => {
      must(w.ledger.recordStopInstruction({ runId: a.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW + 10_000, reason: "requested" }));
    }, true);
    const r2 = ran(await tick(two.w));
    expect(only(r2, two.a.runId)).toEqual({ runId: two.a.runId, outcome: "superseded", planned: "stop" });
    expect(unanswered(two.w).filter((i) => i.runId === two.a.runId && i.action === "task_cancel")).toHaveLength(1);
    expect(two.w.sent).toEqual([]);
  });

  test("시작 접수는 유효한 영수증 ID만 증거로 보고, 판단에 쓰는 칸이 빠지거나 틀리거나 줄이 겹치면 그 실행에 쓰지도 내보내지도 않는다", async () => {
    type Change = (value: Record<string, unknown>) => Record<string, unknown>[];
    const without =
      (key: string): Change =>
      (row) => {
        const copy = { ...row };
        delete copy[key];
        return [copy];
      };
    const set =
      (key: string, value: unknown): Change =>
      (row) => [{ ...row, [key]: value }];
    // fixture: accepted(접수됨, 갱신이 나갈 자리), fresh(접수 없음), cancelled(접수됨, 소유자 취소)
    const make = (fixture: "accepted" | "fresh" | "cancelled") => {
      const w = world();
      const owner = input(w);
      const s = started(w, { inputRequestId: owner });
      if (fixture !== "fresh") accept(w, s);
      if (fixture === "cancelled") must(w.ledger.cancelInput(owner, NOW + 1));
      w.setClock(NOW + 10_000);
      return { w, s };
    };
    const rows: [Parameters<typeof make>[0], Change][] = [
      ["fresh", without("acceptedReceiptId")],
      ["fresh", set("acceptedReceiptId", undefined)],
      ["fresh", set("acceptedReceiptId", "")],
      ["fresh", set("startedReceiptId", "receipt")],
      ["accepted", set("deadlineAt", Number.NaN)],
      ["accepted", set("state", "flying")],
      ["accepted", set("executorId", 7)],
      ["accepted", without("runGeneration")],
      ["accepted", (row) => [row, { ...row }]],
      ["cancelled", without("inputRequestId")],
    ];
    for (const [fixture, change] of rows) {
      const { w, s } = make(fixture);
      w.wrap({
        listRuns: (() => {
          const read = w.ledger.listRuns();
          return read.known ? { known: true, value: read.value.flatMap((row): unknown[] => (row.runId === s.runId ? change(row as never) : [row])) } : read;
        }) as never,
      });
      expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "read_unknown", read: "runs" });
      expect(w.log).toEqual([]);
      expect(w.sent).toEqual([]);
    }
    const histories: [Parameters<typeof make>[0], Change][] = [
      ["accepted", (v) => [{ lease: v.lease }]],
      ["accepted", (v) => [{ ...v, runId: id() }]],
      ["accepted", (v) => [{ ...v, lease: { issuedAt: "x", expiresAt: NOW + 30_000 } }]],
      ["cancelled", (v) => [{ ...v, lastStopAt: "x" }]],
      ["cancelled", (v) => [{ ...v, lastStopAt: {} }]],
    ];
    for (const [fixture, change] of histories) {
      const { w, s } = make(fixture);
      w.wrap({
        instructionTimes: ((runId: string) => {
          const read = w.ledger.instructionTimes(runId);
          return read.known && read.value !== null ? { known: true, value: change(read.value as never)[0] } : read;
        }) as never,
      });
      expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "read_unknown", read: "instruction_times" });
      expect(w.log).toEqual([]);
      expect(w.sent).toEqual([]);
    }
  });

  test("싣지 못한 갱신을 넘긴 실행은 장부의 임대 끝으로 새 갱신을 적지 않고 조회로 간다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    // 판단 17000, 기록 17000, 싣기 직전 17001: 송신 규칙으로 싣지 않는다. 장부는 끝 47000을 믿는다.
    w.queueClock(NOW + 17_000, NOW + 17_000, NOW + 17_001);
    expect(only(await tick(w), s.runId)).toMatchObject({ outcome: "renew_recorded_not_sent", reason: "renew_margin_lost" });
    const asked: { runId: string; at: number }[] = [];
    const seen: string[] = [];
    for (const at of [NOW + 18_000, NOW + 31_000, NOW + 41_000]) {
      w.setClock(at);
      const outcome = only(await tick(w, asked, [s.runId]), s.runId);
      seen.push(outcome.outcome);
      if (outcome.outcome === "query_sent") asked.push({ runId: s.runId, at: outcome.at });
    }
    expect(seen).toEqual(["query_sent", "query_held", "query_sent"]);
    expect(writes(w)).toEqual(["recordRenewInstruction"]);
    expect(w.sent.map((e) => e.header.action)).toEqual(["status_query", "status_query"]);
  });

  test("갱신의 마지막 여유 판정은 박자 유효 문 뒤에 장부 시계를 한 번 읽는다: 유효 문이 1ms를 쓰면 여유 12,999ms로 싣지 않고, 0ms면 13,000ms로 싣는다", async () => {
    for (const cost of [0, 1]) {
      const w = world();
      const s = started(w);
      accept(w, s);
      // 판단·기록 17000, 앞 임대 끝 30000. 장부에 갱신을 적은 뒤의 유효 문(송신 앞) 안에서만 cost가 흐른다.
      w.setClock(NOW + 17_000);
      const gates: number[] = [];
      const ports: LifeLoopPorts = {
        ...w.ports,
        beatValid: () => {
          if (w.log.includes("recordRenewInstruction")) w.setClock(NOW + 17_000 + cost);
          gates.push(w.ports.clock.now() - NOW);
          return true;
        },
      };
      const outcome = only(await lifeTick(ports, POLICY, { lastQueries: [], unsentRenews: [] }), s.runId);
      expect({ cost, outcome: outcome.outcome, reason: "reason" in outcome ? outcome.reason : null, gates, sends: w.log.filter((step) => step === "send").length, sent: w.sent.length }).toEqual({
        cost,
        outcome: cost === 0 ? "renew_sent" : "renew_recorded_not_sent",
        reason: cost === 0 ? null : "renew_margin_lost",
        gates: [17_000, 17_000 + cost],
        sends: cost === 0 ? 1 : 0,
        sent: cost === 0 ? 1 : 0,
      });
    }
  });

  test("요청 ID를 먼저 만들고, 마지막 시계 읽기와 장부 호출 사이에 다른 포트를 부르지 않는다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    w.setClock(NOW + 17_000);
    // 난수 포트가 도는 동안 1ms가 흐른다. 그 뒤에 읽은 시각(17001)으로는 여유가 모자란다.
    const random: Random = {
      bytes: (length) => {
        w.setClock(NOW + 17_001);
        return getRandomValues(new Uint8Array(length));
      },
    };
    expect(only(await plain({ ...w.ports, random }), s.runId)).toEqual({ runId: s.runId, outcome: "renew_withheld", reason: "margin_lost" });
    expect(writes(w)).toEqual([]);
    expect(times(w, s.runId).renewIssued).toBeNull();
  });

  test("싣는 시각에 작업 기한까지 여유가 모자라면 갱신을 싣지 않는다", async () => {
    const policy: LifecyclePolicy = { renewEveryMs: 1_000, answerTimeoutMs: 20_000 };
    const w = world();
    const s = started(w, { deadlineAt: NOW + 14_000 });
    accept(w, s);
    // 판단 1000, 기록 1000(기한까지 13000), 싣기 직전 14001(기한이 지났다).
    w.queueClock(NOW + 1_000, NOW + 1_000, NOW + 14_001);
    expect(only(await plain(w.ports, policy), s.runId)).toMatchObject({ outcome: "renew_recorded_not_sent", reason: "deadline_within_margin", issuedAt: NOW + 1_000, delivery: "not_sent" });
    expect(w.sent).toEqual([]);
    const w2 = world();
    const s2 = started(w2, { deadlineAt: NOW + 14_000 });
    accept(w2, s2);
    w2.queueClock(NOW + 1_000, NOW + 1_000, NOW + 1_000);
    expect(only(await plain(w2.ports, policy), s2.runId)).toMatchObject({ outcome: "renew_sent" });
  });

  test("조회의 간격은 내보내기가 돌아온 뒤에 읽은 시각부터 센다", async () => {
    const w = world();
    const s = started(w);
    must(w.ledger.markLost(NOW + 1));
    w.setClock(NOW + 10_000);
    // 포트가 19000ms 뒤에 싣는다.
    w.setSend(async () => {
      w.setClock(NOW + 29_000);
      return "sent";
    });
    const outcome = only(await tick(w), s.runId) as Extract<RunOutcome, { outcome: "query_sent" }>;
    expect(outcome).toMatchObject({ outcome: "query_sent", at: NOW + 29_000 });
    w.setSend(async () => "sent");
    w.setClock(NOW + 30_000);
    expect(only(await tick(w, [{ runId: s.runId, at: outcome.at }]), s.runId)).toMatchObject({ outcome: "query_held", lastQueryAt: NOW + 29_000 });
  });
});

// 쓰기가 커밋된 뒤의 접근을 자리 이름으로 적고, trap으로 고른 자리 하나를 처음 한 번 던지게 한다. 커밋 전의 접근은 건드리지 않는다.
// 자리 이름은 "ports.clock"(포트 묶음의 접근자), "ports.clock.now"(포트의 메서드), "answer.leaseUntil"(쓰기 답의 칸) 꼴이다.
function afterWrite(w: World, write: (typeof WRITES)[number], trap: string | null) {
  let committed = false;
  let fired = false;
  let requestId: string | undefined;
  const seen: string[] = [];
  const watch = <T extends object>(target: T, path: string): T =>
    new Proxy(target, {
      get(obj, key, receiver) {
        const value: unknown = Reflect.get(obj, key, receiver);
        if (typeof key !== "string" || !committed) return value;
        const point = `${path}.${key}`;
        seen.push(point);
        if (point === trap && !fired) {
          fired = true;
          throw new Error(`쓰기 뒤 ${point} 실패`);
        }
        return typeof value === "object" && value !== null ? watch(value, point) : value;
      },
    });
  const ledger: LifeLoopLedger = {
    ...w.ports.ledger,
    [write]: ((args: { requestId: string }) => {
      const answer: unknown = (w.ports.ledger[write] as (a: unknown) => unknown)(args);
      requestId = args.requestId;
      committed = true;
      return typeof answer === "object" && answer !== null ? watch(answer, "answer") : answer;
    }) as never,
  };
  return { ports: watch({ ...w.ports, ledger }, "ports"), seen, requestId: () => requestId, fired: () => fired };
}

// 부르는 쪽이 결과에서 고르는 싣지 못한 갱신(life-loop.md "넣는 것").
const unsentOf = (result: LifeTickResult) =>
  ran(result)
    .runs.filter((r) => r.outcome === "renew_recorded_not_sent" || r.outcome === "renew_record_unknown")
    .map((r) => r.runId);

describe("쓰기 전의 검증과 쓰기 뒤의 결과 보존", () => {
  const plain = (ports: LifeLoopPorts) => lifeTick(ports, POLICY, { lastQueries: [], unsentRenews: [] });

  test("다시 읽은 줄의 지정 실행기가 실행 종류와 맞지 않거나 실행 세대가 0이면 갱신·종료를 적지 않는다", async () => {
    // 지정 작업자의 연결은 끊겼고 세션 실행기의 연결만 산다. 잘못 읽은 실행기로 판정하면 연결이 살아 있다고 나온다.
    const changes: [string, (row: Record<string, unknown>, nth: number) => Record<string, unknown>][] = [
      ["다시 읽은 줄만 세션 실행기", (row, nth) => (nth === 0 ? row : { ...row, executorId: SESSION_EXECUTOR })],
      ["실행 세대 0", (row) => ({ ...row, runGeneration: 0 })],
    ];
    for (const [name, change] of changes) {
      for (const cancel of [false, true]) {
        const w = world();
        const owner = input(w);
        const s = started(w, { inputRequestId: owner });
        accept(w, s);
        if (cancel) must(w.ledger.cancelInput(owner, NOW + 1));
        w.setClock(NOW + 17_000);
        w.setLink((executorId) => (executorId === SESSION_EXECUTOR ? { ok: true } : { ok: false, reason: "no_connection" }));
        let nth = 0;
        w.wrap({
          listRuns: (() => {
            const read = w.ledger.listRuns();
            if (!read.known) return read;
            const value = read.value.map((row) => (row.runId === s.runId ? change(row as never, nth) : row));
            nth += 1;
            return { known: true, value };
          }) as never,
        });
        expect({ name, cancel, outcome: only(await tick(w), s.runId) }).toEqual({ name, cancel, outcome: { runId: s.runId, outcome: "read_unknown", read: "runs" } });
        expect(writes(w)).toEqual([]);
        expect(w.sent).toEqual([]);
        expect(times(w, s.runId)).toMatchObject({ lease: { issuedAt: NOW, expiresAt: NOW + 30_000 }, renewIssued: null, lastStopAt: null });
      }
    }
  });

  test("갱신을 적은 뒤 송신 시계의 접근자가 던져도 적은 갱신이 결과에 남고, 다음 박자는 새 갱신 대신 조회한다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    w.setClock(NOW + 17_000);
    const trap = afterWrite(w, "recordRenewInstruction", "ports.clock");
    const result = await plain(trap.ports);
    expect(trap.fired()).toBe(true);
    expect(only(result, s.runId)).toMatchObject({ outcome: "renew_recorded_not_sent", requestId: trap.requestId(), issuedAt: NOW + 17_000, leaseUntil: NOW + 47_000, delivery: "not_sent" });
    expect(w.sent).toEqual([]);
    const unsent = unsentOf(result);
    expect(unsent).toEqual([s.runId]);
    w.setClock(NOW + 31_000);
    expect(only(await tick(w, [], unsent), s.runId)).toMatchObject({ outcome: "query_sent" });
    expect(writes(w)).toEqual(["recordRenewInstruction"]);
    expect(times(w, s.runId).renewIssued).toEqual({ issuedAt: NOW + 17_000, leaseUntil: NOW + 47_000 });
  });

  test("종료를 실은 뒤 포트가 봉투의 받는 쪽을 읽지 못하게 해도 내보내기 전에 확보한 받는 쪽으로 결과를 낸다", async () => {
    const w = world();
    const owner = input(w);
    const s = started(w, { inputRequestId: owner });
    accept(w, s);
    must(w.ledger.cancelInput(owner, NOW + 1));
    w.setClock(NOW + 2_000);
    const sink = {
      send: async (envelope: Envelope): Promise<SendOutcome> => {
        Object.defineProperty(envelope.header, "recipient", {
          get(): never {
            throw new Error("봉투 읽기 실패");
          },
        });
        return "sent";
      },
    };
    const result = ran(await plain({ ...w.ports, sink }));
    const stopLine = unanswered(w).find((i) => i.runId === s.runId && i.action === "task_cancel");
    expect(result.halted).toBeNull();
    expect(only(result, s.runId)).toEqual({ runId: s.runId, outcome: "stop_sent", requestId: stopLine?.requestId as string, cancelReason: "requested", issuedAt: NOW + 2_000, executorId: WORKER_EXECUTOR });
  });

  test("쓰기가 성공한 뒤의 어느 포트 접근이 던져도 그 항목이 결과에 남는다(갱신·종료·확정의 접근 자리 훑기)", async () => {
    for (const write of WRITES) {
      const make = () => {
        const w = world();
        if (write === "recordFinalizeInstruction") {
          const s = settledRun(w);
          w.setClock(NOW + 10_000);
          return { w, s };
        }
        const owner = input(w);
        const s = started(w, { inputRequestId: owner });
        accept(w, s);
        if (write === "recordStopInstruction") must(w.ledger.cancelInput(owner, NOW + 1));
        w.setClock(NOW + 10_000);
        return { w, s };
      };
      const probe = make();
      const clean = afterWrite(probe.w, write, null);
      const name = { recordRenewInstruction: "renew", recordStopInstruction: "stop", recordFinalizeInstruction: "finalize" }[write];
      expect(only(await plain(clean.ports), probe.s.runId).outcome).toBe(`${name}_sent` as RunOutcome["outcome"]);
      const points = [...new Set(clean.seen)];
      const extra = { recordRenewInstruction: ["answer.leaseUntil", "ports.clock", "ports.clock.now"], recordStopInstruction: ["answer.run", "answer.run.executorId"], recordFinalizeInstruction: [] }[write];
      expect(points).toEqual(expect.arrayContaining(["answer.ok", "ports.signer", "ports.random", "ports.sink", "ports.sink.send", ...extra]));
      const kinds = [`${name}_recorded_not_sent`, `${name}_record_unknown`];
      for (const point of points) {
        const { w, s } = make();
        const trap = afterWrite(w, write, point);
        const result = await plain(trap.ports);
        expect({ point, fired: trap.fired() }).toEqual({ point, fired: true });
        const item = only(result, s.runId) as { outcome: string; requestId?: string };
        expect({ point, kind: kinds.includes(item.outcome), requestId: item.requestId }).toEqual({ point, kind: true, requestId: trap.requestId() });
        if (write === "recordRenewInstruction") expect({ point, unsent: unsentOf(result) }).toEqual({ point, unsent: [s.runId] });
        expect(writes(w)).toEqual([write]);
      }
    }
  });

  test("같은 소유자 입력의 줄 하나가 취소 칸을 읽다 던지면 두 순서 모두 그 입력은 모름이다", async () => {
    for (const throwingFirst of [false, true]) {
      const w = world();
      const owner = input(w);
      const s = started(w, { inputRequestId: owner });
      accept(w, s);
      // 장부에서는 취소됐다. 버린 줄 대신 남은 cancelled: false를 믿으면 갱신이 나간다.
      must(w.ledger.cancelInput(owner, NOW + 1));
      w.setClock(NOW + 10_000);
      w.wrap({
        listInputs: (() => {
          const read = w.ledger.listInputs();
          if (!read.known) return read;
          const value = read.value.flatMap((row): unknown[] => {
            if (row.requestId !== owner) return [row];
            const kept = { ...row, cancelled: false };
            const broken = {
              requestId: row.requestId,
              get cancelled(): never {
                throw new Error("칸 읽기 실패");
              },
            };
            return throwingFirst ? [broken, kept] : [kept, broken];
          });
          return { known: true, value };
        }) as never,
      });
      expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "read_unknown", read: "inputs" });
      expect(writes(w)).toEqual([]);
      expect(w.sent).toEqual([]);
    }
  });

  test("조회를 실은 뒤 시계를 읽지 못해도 기다리는 조회에 남기고, 간격은 봉투 시한부터 센다", async () => {
    for (const broken of ["now", "getter"] as const) {
      const w = world();
      const s = started(w);
      must(w.ledger.markLost(NOW + 1));
      w.setClock(NOW + 10_000);
      const clock = w.ports.clock;
      let loaded = false;
      const ports: LifeLoopPorts = {
        ...w.ports,
        get clock() {
          if (!loaded) return clock;
          if (broken === "getter") throw new Error("시계 접근 실패");
          return {
            now: () => {
              throw new Error("시계 실패");
            },
          };
        },
        // 봉한 10000보다 19000ms 늦게 싣는다.
        sink: {
          send: async (envelope) => {
            w.sent.push(envelope);
            w.setClock(NOW + 29_000);
            loaded = true;
            return "sent";
          },
        },
      };
      const result = ran(await plain(ports));
      const outcome = only(result, s.runId) as Extract<RunOutcome, { outcome: "query_sent" }>;
      const [envelope] = w.sent as [Envelope];
      expect(envelope.header.expires_at).toBe(NOW + 40_000);
      expect({ broken, outcome }).toMatchObject({ broken, outcome: { outcome: "query_sent", at: NOW + 40_000 } });
      expect(result.pendingQueries).toEqual([{ requestId: outcome.requestId, recipient: WORKER_EXECUTOR, runIds: [s.runId] }]);
      // 실제로 실은 29000부터 answerTimeoutMs가 지나지 않은 30000에는 다시 묻지 않는다. 시한부터 센 60000에는 묻는다.
      const asked = [{ runId: s.runId, at: outcome.at }];
      w.setClock(NOW + 30_000);
      expect(only(await tick(w, asked), s.runId)).toMatchObject({ outcome: "query_held", lastQueryAt: NOW + 40_000 });
      w.setClock(NOW + 60_000);
      expect(only(await tick(w, asked), s.runId)).toMatchObject({ outcome: "query_sent", at: NOW + 60_000 });
    }
  });

  test("연결 포트의 거절에 문자열 reason이 없으면 연결 끊김이 아니라 모름이다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    w.setClock(NOW + 17_000);
    for (const answer of [{ ok: false }, { ok: false, reason: 7 }]) {
      w.setLink(() => answer);
      expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "renew_withheld", reason: "link_unknown" });
    }
    expect(w.log).toEqual([]);
  });
});

test("이 모듈은 시계·난수·소켓·타이머를 직접 부르지 않고, 확정 초안과 확정 기록은 한 자리씩이다", async () => {
  const source = await Bun.file(new URL("../../../src/supervisor/dispatch/life-loop.ts", import.meta.url)).text();
  for (const banned of ["Date.now", "new Date", "performance.now", "Math.random", "randomUUID", "getRandomValues", "setTimeout", "setInterval", "node:", "bun:", "Bun.", "process.", "scheduler/tools"]) {
    expect(source).not.toContain(banned);
  }
  // 확정은 finalizeOne 한 자리에서만 적고 봉한다: 장부 기록은 callAfterGate 안, 초안은 기록 뒤.
  expect(source.split("finalizeDraft(").length - 1).toBe(1);
  expect(source.split("ledger.recordFinalizeInstruction").length - 1).toBe(1);
  expect(source).toContain("fn: ledger.recordFinalizeInstruction, args: [finalizeInput] }; }, () => beatValid(ctx.ports));");
});

describe("박자 유효 문(beatValid): 장부에 적기 직전, 마지막 시계 읽기 뒤에 본다", () => {
  const plain = (ports: LifeLoopPorts) => lifeTick(ports, POLICY, { lastQueries: [], unsentRenews: [] });
  // 박자 기한이 n번째 시계 읽기 안에서 지난다(그 읽기가 끝난 뒤부터 유효 문이 닫힌다). 박자 처음이 첫째, 기록 시각이 둘째다.
  const lapsingAt = (w: World, at: number, nth: number | null): LifeLoopPorts => {
    let reads = 0;
    let valid = true;
    return {
      ...w.ports,
      clock: {
        now: () => {
          reads += 1;
          if (reads === nth) valid = false;
          return at;
        },
      },
      beatValid: () => valid,
    };
  };

  test("종료: 기록 시각을 읽는 사이 박자 기한이 지나면 종료를 적지 않고 beat_closed다. 대조군(기한 안)은 적고 내보낸다", async () => {
    for (const nth of [2, null]) {
      const w = world();
      const s = started(w, { deadlineAt: NOW + 20_000 });
      accept(w, s);
      w.setClock(NOW + 20_000);
      const outcome = only(await plain(lapsingAt(w, NOW + 20_000, nth)), s.runId);
      if (nth !== null) {
        expect(outcome).toEqual({ runId: s.runId, outcome: "beat_closed", planned: "stop" });
        expect([writes(w), w.sent.length, unanswered(w).filter((i) => i.action === "task_cancel").length, state(w, s.runId)]).toEqual([[], 0, 0, "preparing"]);
      } else {
        expect(outcome).toMatchObject({ outcome: "stop_sent", cancelReason: "deadline" });
        expect([writes(w), w.sent.length]).toEqual([["recordStopInstruction"], 1]);
      }
    }
  });

  test("갱신: 기록 시각을 읽는 사이 박자 기한이 지나면 갱신을 적지 않고 beat_closed다. 대조군(기한 안)은 적고 내보낸다", async () => {
    for (const nth of [2, null]) {
      const w = world();
      const s = started(w);
      accept(w, s);
      w.setClock(NOW + 10_000);
      const outcome = only(await plain(lapsingAt(w, NOW + 10_000, nth)), s.runId);
      if (nth !== null) {
        expect(outcome).toEqual({ runId: s.runId, outcome: "beat_closed", planned: "renew_lease" });
        expect([writes(w), w.sent.length, times(w, s.runId).renewIssued]).toEqual([[], 0, null]);
      } else {
        expect(outcome).toMatchObject({ outcome: "renew_sent", leaseUntil: NOW + 40_000 });
        expect([writes(w), w.sent.length]).toEqual([["recordRenewInstruction"], 1]);
      }
    }
  });

  test("종료·갱신: 장부 포트 객체를 얻는 접근자 안에서 박자 기한이 지나면 적지 않고 beat_closed다. 대조군은 적고 내보낸다", async () => {
    for (const planned of ["stop", "renew_lease"] as const) {
      for (const lapse of [true, false]) {
        const w = world();
        const s = planned === "stop" ? started(w, { deadlineAt: NOW + 20_000 }) : started(w);
        accept(w, s);
        const at = planned === "stop" ? NOW + 20_000 : NOW + 10_000;
        w.setClock(at);
        let reads = 0;
        let valid = true;
        const ledger = w.ports.ledger;
        // 기록 시각(둘째 시계 읽기) 뒤에 장부 포트 객체를 얻으면 그 접근자 안에서 박자 기한이 지난다.
        const ports: LifeLoopPorts = {
          ...w.ports,
          clock: { now: () => ((reads += 1), at) },
          get ledger() {
            if (lapse && reads >= 2) valid = false;
            return ledger;
          },
          beatValid: () => valid,
        };
        const outcome = only(await plain(ports), s.runId);
        if (lapse) {
          expect([planned, outcome]).toEqual([planned, { runId: s.runId, outcome: "beat_closed", planned }]);
          expect([planned, writes(w), w.sent.length]).toEqual([planned, [], 0]);
        } else {
          expect(outcome).toMatchObject({ outcome: planned === "stop" ? "stop_sent" : "renew_sent" });
          expect([planned, writes(w), w.sent.length]).toEqual([planned, [planned === "stop" ? "recordStopInstruction" : "recordRenewInstruction"], 1]);
        }
      }
    }
  });

  test("종료·갱신: 장부 쓰기 메서드를 얻는 접근자 안에서 박자 기한이 지나면 적지 않고 beat_closed다. 대조군은 적고 내보낸다", async () => {
    for (const planned of ["stop", "renew_lease"] as const) {
      for (const lapse of [true, false]) {
        const w = world();
        const s = planned === "stop" ? started(w, { deadlineAt: NOW + 20_000 }) : started(w);
        accept(w, s);
        w.setClock(planned === "stop" ? NOW + 20_000 : NOW + 10_000);
        let valid = true;
        const real = w.ports.ledger;
        const name = planned === "stop" ? "recordStopInstruction" : "recordRenewInstruction";
        const ledger = { ...real };
        Object.defineProperty(ledger, name, {
          get() {
            if (lapse) valid = false;
            return real[name];
          },
        });
        const outcome = only(await plain({ ...w.ports, ledger, beatValid: () => valid }), s.runId);
        if (lapse) {
          expect([planned, outcome]).toEqual([planned, { runId: s.runId, outcome: "beat_closed", planned }]);
          expect([planned, writes(w), w.sent.length]).toEqual([planned, [], 0]);
        } else {
          expect(outcome).toMatchObject({ outcome: planned === "stop" ? "stop_sent" : "renew_sent" });
          expect([planned, writes(w), w.sent.length]).toEqual([planned, [name], 1]);
        }
      }
    }
  });

  test("접수가 닫혀도 유효한 박자의 종료는 적는다(접수 문과 박자 유효 문은 다르다). 유효 문이 던지거나 true가 아니면 적지 않는다", async () => {
    const closed = world();
    const s = started(closed, { deadlineAt: NOW + 20_000 });
    accept(closed, s);
    closed.setClock(NOW + 20_000);
    closed.setIntake(false);
    expect(only(await plain({ ...closed.ports, beatValid: () => true }), s.runId)).toMatchObject({ outcome: "stop_sent", cancelReason: "deadline" });
    for (const beatValid of [() => undefined as unknown as boolean, () => 1 as unknown as boolean, () => { throw new Error("유효 문 실패"); }]) {
      const w = world();
      const r = started(w, { deadlineAt: NOW + 20_000 });
      accept(w, r);
      w.setClock(NOW + 20_000);
      expect(only(await plain({ ...w.ports, beatValid }), r.runId)).toEqual({ runId: r.runId, outcome: "beat_closed", planned: "stop" });
      expect(writes(w)).toEqual([]);
    }
  });
});

describe("싣기: 갱신·취소·조회도 공유 송신 함수로 싣는다(포트의 수신 객체와 send를 얻은 뒤 박자 유효 문 → 쥔 send)", () => {
  const plain = (ports: LifeLoopPorts) => lifeTick(ports, POLICY, { lastQueries: [], unsentRenews: [] });

  test("포트의 send를 얻는 접근자 안에서 박자 기한이 지나면 포트를 부르지 않는다. 적은 갱신·종료는 남고 조회는 기다리지 않는다. 대조군은 싣는다", async () => {
    for (const planned of ["renew", "stop", "query"] as const) {
      for (const lapse of [true, false]) {
        const w = world();
        const s = planned === "stop" ? started(w, { deadlineAt: NOW + 20_000 }) : started(w);
        if (planned === "query") must(w.ledger.markLost(NOW + 1));
        else accept(w, s);
        w.setClock(planned === "stop" ? NOW + 20_000 : NOW + 10_000);
        let valid = true;
        let entries = 0;
        const target = w.ports.sink;
        // 포트 진입을 따로 센다: 조립의 내보내기 포트는 진입하자마자 조회를 등록부에 넣으므로, 닫힌 박자에서는 진입 자체가 0이어야 한다.
        const sink = {
          get send() {
            if (lapse) valid = false;
            return (envelope: Envelope): Promise<SendOutcome> => {
              entries += 1;
              return target.send(envelope);
            };
          },
        };
        const result = ran(await plain({ ...w.ports, sink, beatValid: () => valid }));
        const outcome = only(result, s.runId);
        const label = `${planned}:${lapse}`;
        if (lapse) {
          const kind = { renew: "renew_recorded_not_sent", stop: "stop_recorded_not_sent", query: "query_not_sent" }[planned];
          expect([label, outcome]).toMatchObject([label, { outcome: kind, reason: "beat_closed", delivery: "not_sent" }]);
          expect([label, entries, w.sent.length, result.pendingQueries]).toEqual([label, 0, 0, []]);
          expect([label, writes(w)]).toEqual([label, { renew: ["recordRenewInstruction"], stop: ["recordStopInstruction"], query: [] }[planned]]);
          if (planned === "renew") expect(unsentOf(result)).toEqual([s.runId]);
        } else {
          const kind = { renew: "renew_sent", stop: "stop_sent", query: "query_sent" }[planned];
          expect([label, outcome]).toMatchObject([label, { outcome: kind }]);
          expect([label, entries, w.sent.length, result.pendingQueries.length]).toEqual([label, 1, 1, planned === "query" ? 1 : 0]);
        }
      }
    }
  });

  test("정적: 이 모듈은 내보내기 포트를 직접 부르지 않고 공유 송신 함수 한 자리로만 싣는다", async () => {
    const source = await Bun.file(new URL("../../../src/supervisor/dispatch/life-loop.ts", import.meta.url)).text();
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect([code.match(/\.send\b/g) ?? [], code.match(/\bsendInstruction\s*\(/g)?.length]).toEqual([[], 1]);
  });
});

// 결과 보고를 저장 자리와 함께 적고 같은 digest로 판정한 실행(ready_result, 결과 보관이 장부에 반영됨). 보고는 NOW + 2에 적는다.
function settledRun(w: World) {
  const s = started(w);
  accept(w, s);
  must(w.ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: s.runId, exit: "completed", bodyDigest: digest("stopped ok"), now: NOW + 1 }, s.from));
  const reportId = id();
  const resultDigest = digest("result body");
  const storedRef = `results/${id()}`;
  must(w.ledger.recordReport({ reportId, action: "report_result", runId: s.runId, bodyDigest: digest("report"), storedRef, resultDigest, signal: null, now: NOW + 2 }, s.from));
  must(w.ledger.markResult({ runId: s.runId, resultDigest, reportId, now: NOW + 3 }));
  return { ...s, resultDigest, storedRef };
}

const finalizes = (w: World) => unanswered(w).filter((item) => item.action === "result_finalize");

describe("확정: 결과 보관이 장부에 반영된 ready_result만 적고 내보낸다", () => {
  test("확정을 장부에 적은 뒤 같은 요청 ID로 지정 실행기에 내보낸다(본문: succeeded, 실행 줄의 digest, 보고를 적은 시각)", async () => {
    const w = world();
    const s = settledRun(w);
    w.setClock(NOW + 10_000);
    const outcome = only(await tick(w), s.runId);
    expect(outcome).toMatchObject({ outcome: "finalize_sent", issuedAt: NOW + 10_000, executorId: WORKER_EXECUTOR });
    expect(w.log).toEqual(["recordFinalizeInstruction", "seal", "send"]);
    const [envelope] = w.sent as [Envelope];
    expect(envelope.header).toMatchObject({ action: "result_finalize", recipient: WORKER_EXECUTOR, issued_at: NOW + 10_000, stop_generation: 0, request_id: (outcome as { requestId: string }).requestId });
    expect(envelope.body).toEqual({ run_id: s.runId, outcome: "succeeded", result_digest: s.resultDigest, stored_at: NOW + 2 });
    expect(times(w, s.runId).lastFinalizeAt).toBe(NOW + 10_000);
    // 재전송 박자가 같은 요청 ID로 다시 만들 수 있게 본문 세 칸이 함께 적혔다.
    expect(finalizes(w)).toEqual([expect.objectContaining({ requestId: (outcome as { requestId: string }).requestId, rebuild: { action: "result_finalize", outcome: "succeeded", resultDigest: s.resultDigest, storedAt: NOW + 2 } })]);
    // 확정은 자리를 풀지 않는다(정리 영수증이 풀어 준다).
    expect(state(w, s.runId)).toBe("ready_result");
  });

  test("보관이 반영되지 않았다는 답(null)이면 기다리고 아무것도 적지 않는다", async () => {
    const w = world();
    const s = settledRun(w);
    w.wrap({ settledResult: () => ({ known: true, value: null }) as never });
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "wait" });
    expect(w.log).toEqual([]);
    expect(finalizes(w)).toEqual([]);
  });

  test("결과 보관 읽기가 모름·던짐·꼴 틀림·다른 실행·다른 digest면 그 실행은 read_unknown(result)이고 아무것도 적지 않는다", async () => {
    const variants: [string, (runId: string, real: { runId: string; resultDigest: string; storedRef: string; storedAt: number }) => unknown][] = [
      ["모름", () => ({ known: false, reason: "db_error" })],
      ["던짐", () => {
        throw new Error("읽기 실패");
      }],
      ["답이 객체 아님", () => "x"],
      ["값이 객체 아님", () => ({ known: true, value: 7 })],
      ["다른 실행", (_, real) => ({ known: true, value: { ...real, runId: id() } })],
      ["digest가 실행 줄과 다름", (_, real) => ({ known: true, value: { ...real, resultDigest: digest("other") } })],
      ["digest 꼴 틀림", (_, real) => ({ known: true, value: { ...real, resultDigest: "ABC" } })],
      ["저장 자리 빔", (_, real) => ({ known: true, value: { ...real, storedRef: "" } })],
      ["저장 자리 없음", (_, real) => ({ known: true, value: { ...real, storedRef: null } })],
      ["보관 시각 틀림", (_, real) => ({ known: true, value: { ...real, storedAt: 0 } })],
    ];
    for (const [name, answer] of variants) {
      const w = world();
      const s = settledRun(w);
      const real = w.ledger.settledResult(s.runId);
      if (!real.known || real.value === null) throw new Error("보관을 읽지 못함");
      const value = real.value;
      w.wrap({ settledResult: ((runId: string) => answer(runId, value)) as never });
      w.setClock(NOW + 10_000);
      expect(only(await tick(w), s.runId), name).toEqual({ runId: s.runId, outcome: "read_unknown", read: "result" });
      expect(finalizes(w), name).toEqual([]);
      expect(w.log, name).toEqual([]);
    }
  });

  test("결과 보관은 ready_result 실행에만 읽는다: 그 읽기가 던져도 진행 중 실행의 갱신을 막지 않는다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    let reads = 0;
    w.wrap({
      settledResult: (() => {
        reads += 1;
        throw new Error("읽기 실패");
      }) as never,
    });
    w.setClock(NOW + 10_000);
    expect(only(await tick(w), s.runId).outcome).toBe("renew_sent");
    expect(reads).toBe(0);
  });

  test("확정이 이미 적힌 실행에는 답을 기다린 뒤에도 새 요청 ID의 확정을 또 적지 않는다", async () => {
    const w = world();
    const s = settledRun(w);
    w.setClock(NOW + 10_000);
    expect(only(await tick(w), s.runId).outcome).toBe("finalize_sent");
    w.setClock(NOW + 10_000 + POLICY.answerTimeoutMs - 1);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "wait" });
    w.setClock(NOW + 10_000 + POLICY.answerTimeoutMs);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "finalize_withheld", reason: "already_recorded" });
    expect(writes(w)).toEqual(["recordFinalizeInstruction"]);
    expect(finalizes(w)).toHaveLength(1);
  });

  test("접수가 닫혔으면(정지 포함) 확정을 적지 않고, 정지 세대를 모르면(복원 전) 박자가 돌지 않는다", async () => {
    const w = world();
    const s = settledRun(w);
    w.setIntake(false);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "finalize_withheld", reason: "intake_closed" });
    w.setIntake(true);
    w.setStopGeneration(null);
    expect(await tick(w)).toEqual({ kind: "not_run", reason: "stop_generation_unknown" });
    // 장부가 정지를 적용하면 접수가 닫힌다(장부의 접수 판정).
    w.setStopGeneration(0);
    must(w.ledger.applyStop({ generation: 1, stopped: true, now: NOW + 5 }));
    w.setStopGeneration(1);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "finalize_withheld", reason: "intake_closed" });
    expect(writes(w)).toEqual([]);
    expect(finalizes(w)).toEqual([]);
  });

  test("박자 유효 문이 닫혔으면 확정을 적지 않는다. 던져도 같다", async () => {
    for (const gate of [() => false, () => {
      throw new Error("문 실패");
    }]) {
      const w = world();
      const s = settledRun(w);
      const ports = { ...w.ports, beatValid: gate };
      const result = await lifeTick(ports, POLICY, { lastQueries: [], unsentRenews: [] });
      expect(only(result, s.runId)).toEqual({ runId: s.runId, outcome: "beat_closed", planned: "finalize" });
      expect(writes(w)).toEqual([]);
      expect(finalizes(w)).toEqual([]);
    }
  });

  test("쓰기 직전에 확정이 적혔거나 결과 보관이 바뀌었으면 쓰지 않는다(superseded)", async () => {
    {
      const w = world();
      const s = settledRun(w);
      let calls = 0;
      const other = id();
      w.wrap({
        instructionTimes: ((runId: string) => {
          calls += 1;
          // 박자 처음의 읽기 뒤, 쓰기 직전의 다시 읽기 전에 다른 경로가 확정을 적었다.
          // 그 확정의 발행 시각은 answerTimeoutMs보다 오래돼 판단만으로는 막지 못한다(이력 확인이 막는다).
          if (calls === 2) must(w.ledger.recordFinalizeInstruction({ runId, requestId: other, stopGeneration: 0, now: NOW + 5, outcome: "succeeded", resultDigest: s.resultDigest, storedAt: NOW + 2 }));
          return w.ledger.instructionTimes(runId);
        }) as never,
      });
      w.setClock(NOW + 5 + POLICY.answerTimeoutMs);
      expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "superseded", planned: "finalize" });
      expect(writes(w)).toEqual([]);
      expect(finalizes(w).map((item) => item.requestId)).toEqual([other]);
    }
    for (const change of [{ storedRef: `results/${id()}` }, { storedAt: NOW + 4 }]) {
      const w = world();
      const s = settledRun(w);
      let calls = 0;
      w.wrap({
        settledResult: ((runId: string) => {
          calls += 1;
          const real = w.ledger.settledResult(runId);
          return calls === 2 && real.known && real.value !== null ? { known: true, value: { ...real.value, ...change } } : real;
        }) as never,
      });
      expect(only(await tick(w), s.runId), JSON.stringify(change)).toEqual({ runId: s.runId, outcome: "superseded", planned: "finalize" });
      expect(writes(w)).toEqual([]);
    }
  });

  test("적었는지 모르는 확정(쓰기 포트가 적은 뒤 던짐)은 다음 박자가 장부의 이력을 보고 새 요청 ID로 다시 적지 않는다", async () => {
    const w = world();
    const s = settledRun(w);
    w.wrap({
      recordFinalizeInstruction: ((input: Parameters<Ledger["recordFinalizeInstruction"]>[0]) => {
        must(w.ledger.recordFinalizeInstruction(input));
        throw new Error("적은 뒤 실패");
      }) as never,
    });
    w.setClock(NOW + 10_000);
    expect(only(await tick(w), s.runId)).toMatchObject({ outcome: "finalize_record_unknown", reason: "threw", issuedAt: NOW + 10_000 });
    w.wrap({});
    w.setClock(NOW + 10_000 + POLICY.answerTimeoutMs);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "finalize_withheld", reason: "already_recorded" });
    expect(finalizes(w)).toHaveLength(1);
    expect(w.sent).toEqual([]);
  });

  test("장부의 거절·던짐·정의 밖의 답, 적은 뒤의 서명·내보내기 실패는 그 항목의 결과다", async () => {
    const cases: [string, (w: World) => void, Record<string, unknown>, number][] = [
      ["거절", (w) => w.wrap({ recordFinalizeInstruction: (() => ({ ok: false, reason: "stop_generation_mismatch" })) as never }), { outcome: "finalize_refused", reason: "stop_generation_mismatch" }, 0],
      ["쓰기가 던짐", (w) => w.wrap({ recordFinalizeInstruction: (() => {
        throw new Error("쓰기 실패");
      }) as never }), { outcome: "finalize_record_unknown", reason: "threw" }, 0],
      ["답이 정의 밖", (w) => w.wrap({ recordFinalizeInstruction: (() => ({ ok: "yes" })) as never }), { outcome: "finalize_record_unknown", reason: "malformed_answer" }, 0],
      ["서명 실패", (w) => w.failSigner(true), { outcome: "finalize_recorded_not_sent", reason: "seal_threw", delivery: "not_sent" }, 1],
      ["연결 없음", (w) => w.setSend(async () => "no_connection"), { outcome: "finalize_recorded_not_sent", reason: "no_connection", delivery: "not_sent" }, 1],
      ["내보내기가 던짐", (w) => w.setSend(async () => {
        throw new Error("송신 실패");
      }), { outcome: "finalize_recorded_not_sent", reason: "send_threw", delivery: "unknown" }, 1],
    ];
    for (const [name, arrange, expected, recorded] of cases) {
      const w = world();
      const s = settledRun(w);
      arrange(w);
      w.setClock(NOW + 10_000);
      expect(only(await tick(w), s.runId), name).toMatchObject({ runId: s.runId, ...expected });
      expect(writes(w), name).toEqual(["recordFinalizeInstruction"]);
      expect(finalizes(w), name).toHaveLength(recorded);
      expect(w.sent, name).toEqual([]);
    }
  });
});

// failed_stopped 실행을 만든다. no_result: completed 종료(NOW + 1) 뒤 결과 없음 판정(NOW + 3). exit: 그 exit의 종료 영수증(NOW + 1).
// requested·deadline·unknown: 그 사유(unknown은 사유 없음)의 취소 지시를 NOW + 1에 적고 exit(기본 cancelled)의 종료 영수증을 NOW + 2에 적는다.
function failedRun(w: World, how: "no_result" | "exit" | "requested" | "deadline" | "unknown", exit: "completed" | "cancelled" | "deadline" | "failed" = "cancelled") {
  const s = started(w);
  accept(w, s);
  const stopped = (kind: typeof exit, at: number) =>
    must(w.ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: s.runId, exit: kind, bodyDigest: digest(`stopped:${kind}`), now: at }, s.from));
  if (how === "no_result") {
    stopped("completed", NOW + 1);
    must(w.ledger.markResult({ runId: s.runId, resultDigest: null, now: NOW + 3 }));
    return s;
  }
  if (how === "exit") {
    stopped(exit, NOW + 1);
    return s;
  }
  const reason = how === "unknown" ? {} : { reason: how };
  must(w.ledger.recordStopInstruction({ runId: s.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW + 1, ...reason }));
  stopped(exit, NOW + 2);
  if (exit === "completed") must(w.ledger.markResult({ runId: s.runId, resultDigest: null, now: NOW + 3 }));
  return s;
}

describe("실패 확정(D-114): failed_stopped 실행의 확정 본문은 장부 이력으로", () => {
  test("결과 없음으로 판정된 실행은 outcome failed, stored_at은 판정 시각으로 적은 뒤 내보낸다", async () => {
    const w = world();
    const s = failedRun(w, "no_result");
    w.setClock(NOW + 10_000);
    const outcome = only(await tick(w), s.runId);
    expect(outcome).toMatchObject({ outcome: "finalize_sent", issuedAt: NOW + 10_000, executorId: WORKER_EXECUTOR });
    expect(w.log).toEqual(["recordFinalizeInstruction", "seal", "send"]);
    const [envelope] = w.sent as [Envelope];
    expect(envelope.header).toMatchObject({ action: "result_finalize", recipient: WORKER_EXECUTOR, request_id: (outcome as { requestId: string }).requestId });
    expect(envelope.body).toEqual({ run_id: s.runId, outcome: "failed", result_digest: null, stored_at: NOW + 3 });
    expect(finalizes(w)).toEqual([expect.objectContaining({ rebuild: { action: "result_finalize", outcome: "failed", resultDigest: null, storedAt: NOW + 3 } })]);
    // 확정은 자리를 풀지 않는다(정리 영수증이 풀어 준다).
    expect(state(w, s.runId)).toBe("failed_stopped");
  });

  test("사유 requested의 취소 지시가 적혔으면 exit와 무관하게 outcome cancelled, stored_at은 failed_stopped가 된 시각이다", async () => {
    for (const [exit, storedAt] of [
      ["cancelled", NOW + 2],
      ["failed", NOW + 2],
      ["completed", NOW + 3],
    ] as const) {
      const w = world();
      const s = failedRun(w, "requested", exit);
      w.setClock(NOW + 10_000);
      expect([exit, only(await tick(w), s.runId).outcome]).toEqual([exit, "finalize_sent"]);
      expect([exit, (w.sent[0] as Envelope).body]).toEqual([exit, { run_id: s.runId, outcome: "cancelled", result_digest: null, stored_at: storedAt }]);
    }
  });

  test("D-114 글자대로: 사유 requested의 취소 지시가 없어도 종료 영수증 exit가 cancelled면 cancelled, 그 밖의 exit면 failed다", async () => {
    const cases: [string, (w: World) => Started, "cancelled" | "failed", number][] = [
      ["exit completed 뒤 결과 없음 판정", (w) => failedRun(w, "no_result"), "failed", NOW + 3],
      ["exit cancelled, 취소 지시 없음", (w) => failedRun(w, "exit", "cancelled"), "cancelled", NOW + 1],
      ["exit deadline", (w) => failedRun(w, "exit", "deadline"), "failed", NOW + 1],
      ["exit failed", (w) => failedRun(w, "exit", "failed"), "failed", NOW + 1],
      ["사유 deadline의 취소 지시 뒤 exit cancelled", (w) => failedRun(w, "deadline", "cancelled"), "cancelled", NOW + 2],
      ["사유 deadline의 취소 지시 뒤 exit deadline", (w) => failedRun(w, "deadline", "deadline"), "failed", NOW + 2],
      ["사유 없는 취소 지시 뒤 exit cancelled", (w) => failedRun(w, "unknown", "cancelled"), "cancelled", NOW + 2],
    ];
    for (const [name, make, outcome, storedAt] of cases) {
      const w = world();
      const s = make(w);
      w.setClock(NOW + 10_000);
      expect([name, only(await tick(w), s.runId).outcome]).toEqual([name, "finalize_sent"]);
      expect([name, (w.sent[0] as Envelope).body]).toEqual([name, { run_id: s.runId, outcome, result_digest: null, stored_at: storedAt }]);
      expect(finalizes(w), name).toEqual([expect.objectContaining({ rebuild: { action: "result_finalize", outcome, resultDigest: null, storedAt } })]);
    }
  });

  test("곧바로 failed_stopped가 된 실행은 확정과 정리 영수증으로 finalized가 되어 작업자 자리가 풀린다", async () => {
    const w = world();
    const s = failedRun(w, "exit", "deadline");
    expect(w.ledger.slotFree("worker")).toEqual({ known: true, value: false });
    w.setClock(NOW + 10_000);
    const outcome = only(await tick(w), s.runId);
    expect(outcome).toMatchObject({ outcome: "finalize_sent" });
    const requestId = (outcome as { requestId: string }).requestId;
    must(w.ledger.applyReceipt({ action: "receipt_cleaned", receiptId: id(), runId: s.runId, instructionRequestId: requestId, bodyDigest: digest("cleaned"), now: NOW + 10_001 }, s.from));
    expect(state(w, s.runId)).toBe("finalized");
    expect(w.ledger.slotFree("worker")).toEqual({ known: true, value: true });
  });

  test("outcome을 정하지 못하면(사유 없는 취소 지시에 exit가 cancelled가 아님, exit 모름) 적거나 내보내지 않는다", async () => {
    const exitUnknown = (w: World) => {
      const s = failedRun(w, "exit", "failed");
      // 판 8 전에 종료 확인을 받은 줄처럼 장부가 exit를 모르는 답(failedStop의 exit null).
      w.wrap({
        failedStop: ((runId: string) => {
          const real = w.ledger.failedStop(runId);
          return real.known && real.value !== null ? { known: true, value: { ...real.value, exit: null } } : real;
        }) as never,
      });
      return s;
    };
    const cases: [string, (w: World) => Started][] = [
      ["사유 없는 취소 지시 뒤 결과 없음", (w) => failedRun(w, "unknown", "completed")],
      ["사유 없는 취소 지시 뒤 exit failed", (w) => failedRun(w, "unknown", "failed")],
      ["exit 모름, 취소 지시 없음", exitUnknown],
    ];
    for (const [name, make] of cases) {
      const w = world();
      const s = make(w);
      w.setClock(NOW + 10_000);
      expect(only(await tick(w), s.runId), name).toEqual({ runId: s.runId, outcome: "finalize_withheld", reason: "outcome_unknown" });
      expect(w.log, name).toEqual([]);
      expect(finalizes(w), name).toEqual([]);
      expect(w.ledger.slotFree("worker"), name).toEqual({ known: true, value: false });
    }
  });

  test("확정 사실 읽기가 모름·던짐·값 없음·꼴 틀림·다른 실행이면 read_unknown(result)이고 아무것도 적지 않는다", async () => {
    const variants: [string, (real: Record<string, unknown>) => unknown][] = [
      ["모름", () => ({ known: false, reason: "db_error" })],
      ["던짐", () => {
        throw new Error("읽기 실패");
      }],
      ["값 없음", () => ({ known: true, value: null })],
      ["다른 실행", (real) => ({ known: true, value: { ...real, runId: id() } })],
      ["시각 틀림", (real) => ({ known: true, value: { ...real, stoppedAt: 0 } })],
      ["취소 칸 틀림", (real) => ({ known: true, value: { ...real, requestedCancel: "yes" } })],
      ["exit 칸 틀림", (real) => ({ known: true, value: { ...real, exit: "aborted" } })],
    ];
    for (const [name, answer] of variants) {
      const w = world();
      const s = failedRun(w, "no_result");
      const real = w.ledger.failedStop(s.runId);
      if (!real.known || real.value === null) throw new Error("확정 사실을 읽지 못함");
      const value = { ...real.value } as Record<string, unknown>;
      w.wrap({ failedStop: (() => answer(value)) as never });
      w.setClock(NOW + 10_000);
      expect(only(await tick(w), s.runId), name).toEqual({ runId: s.runId, outcome: "read_unknown", read: "result" });
      expect(w.log, name).toEqual([]);
    }
  });

  test("쓰기 직전에 다시 읽은 확정 사실이 처음과 다르면 superseded이고 적지 않는다", async () => {
    for (const change of [{ stoppedAt: NOW + 4 }, { requestedCancel: true }, { exit: null }]) {
      const w = world();
      const s = failedRun(w, "no_result");
      let calls = 0;
      w.wrap({
        failedStop: ((runId: string) => {
          calls += 1;
          const real = w.ledger.failedStop(runId);
          return calls === 2 && real.known && real.value !== null ? { known: true, value: { ...real.value, ...change } } : real;
        }) as never,
      });
      w.setClock(NOW + 10_000);
      expect(only(await tick(w), s.runId), JSON.stringify(change)).toEqual({ runId: s.runId, outcome: "superseded", planned: "finalize" });
      expect(writes(w)).toEqual([]);
    }
  });

  test("확정이 이미 적힌 실행에는 새 요청 ID로 또 적지 않고, 접수가 닫혔으면 적지 않는다", async () => {
    const w = world();
    const s = failedRun(w, "no_result");
    w.setIntake(false);
    w.setClock(NOW + 10_000);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "finalize_withheld", reason: "intake_closed" });
    expect(w.log).toEqual([]);
    w.setIntake(true);
    expect(only(await tick(w), s.runId).outcome).toBe("finalize_sent");
    w.setClock(NOW + 10_000 + POLICY.answerTimeoutMs);
    expect(only(await tick(w), s.runId)).toEqual({ runId: s.runId, outcome: "finalize_withheld", reason: "already_recorded" });
    expect(writes(w)).toEqual(["recordFinalizeInstruction"]);
    expect(finalizes(w)).toHaveLength(1);
  });

  test("확정 사실은 failed_stopped 실행에만 읽는다: 그 읽기가 던져도 진행 중 실행의 갱신을 막지 않는다", async () => {
    const w = world();
    const s = started(w);
    accept(w, s);
    let reads = 0;
    w.wrap({
      failedStop: (() => {
        reads += 1;
        throw new Error("읽기 실패");
      }) as never,
    });
    w.setClock(NOW + 10_000);
    expect(only(await tick(w), s.runId).outcome).toBe("renew_sent");
    expect(reads).toBe(0);
  });
});

// 판 8(종료 영수증 exit·실패 시각 칸) 전까지의 판 목록. 이 목록으로 연 장부는 판 8 전에 종료 확인·판정을 받은 장부와 같은 줄을 남긴다.
const BEFORE_STOP_EXIT = () => loadMigrations().filter((m) => m.version < 8);

type LedgerStep = (ledger: Ledger, s: ReturnType<typeof startedWorker>) => void;
const stopAt = (exit: "completed" | "cancelled", at: number): LedgerStep => (ledger, s) =>
  void must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: s.runId, exit, bodyDigest: digest(`stopped:${exit}:${at}`), now: at }, s.from));
const budgetAt = (at: number): LedgerStep => (ledger, s) => void must(ledger.recordBudget({ runId: s.runId, budgetLeft: 7, now: at }));
const judgeAt = (at: number): LedgerStep => (ledger, s) => void must(ledger.markResult({ runId: s.runId, resultDigest: null, now: at }));
const requestedAt = (at: number): LedgerStep => (ledger, s) =>
  void must(ledger.recordStopInstruction({ runId: s.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: at, reason: "requested" }));

// 장부 파일을 version 판까지로 만들어 before를 적고 닫은 뒤, 전체 판으로 다시 열어(판 7이면 여기서 판 8로 올라간다) after를 적고 박자를 한 번 돌린다.
async function finalizeOf(version: 7 | 8, before: LedgerStep[], after: LedgerStep[] = []) {
  const path = tempPath();
  const ledger = ready(open(path, version === 7 ? { migrations: BEFORE_STOP_EXIT() } : {}));
  const s = startedWorker(ledger);
  for (const step of before) step(ledger, s);
  ledger.close();
  const w = world(path);
  for (const step of after) step(w.ledger, s);
  const read = w.ledger.failedStop(s.runId);
  w.setClock(NOW + 30);
  const outcome = only(await tick(w), s.runId);
  const { runId: _, ...rest } = outcome;
  return { facts: read.known && read.value !== null ? { stoppedAt: read.value.stoppedAt, exit: read.value.exit } : read, outcome: rest, writes: writes(w), bodies: w.sent.map((e) => e.body) };
}

const sentAs = (outcome: "cancelled" | "failed", storedAt: number) => ({ outcome: { outcome: "finalize_sent" }, bodies: [expect.objectContaining({ outcome, result_digest: null, stored_at: storedAt })] });
const withheldAs = (reason: "outcome_unknown" | "stored_at_unknown") => ({ outcome: { outcome: "finalize_withheld", reason }, writes: [], bodies: [] });

describe("실패 확정의 stored_at(D-114): 예산 기록 같은 뒤 쓰기가 failed_stopped가 된 시각과 옛 줄의 exit를 바꾸지 않는다", () => {
  // 리뷰 재현의 네 대조군: 취소 지시 없이 exit cancelled 영수증을 NOW + 2에 적고, 예산 기록이 있으면 NOW + 19에 적는다.
  // 판 7 줄은 실패 시각 칸이 없어 실패 시각도 exit도 모르고 보류한다(아래 "updated_at이 영수증 시각과 같아도").
  const controls: [7 | 8, boolean, Record<string, unknown>, Record<string, unknown>][] = [
    [8, false, { stoppedAt: NOW + 2, exit: "cancelled" }, sentAs("cancelled", NOW + 2)],
    [8, true, { stoppedAt: NOW + 2, exit: "cancelled" }, sentAs("cancelled", NOW + 2)],
    [7, false, { stoppedAt: null, exit: null }, withheldAs("outcome_unknown")],
    [7, true, { stoppedAt: null, exit: null }, withheldAs("outcome_unknown")],
  ];
  for (const [version, budget, facts, expected] of controls) {
    test(`판 ${version}, 예산 기록 ${budget ? "있음" : "없음"}: exit cancelled로 곧바로 끝난 실행`, async () => {
      const got = await finalizeOf(version, [stopAt("cancelled", NOW + 2), ...(budget ? [budgetAt(NOW + 19)] : [])]);
      expect(got).toMatchObject({ facts, ...expected });
    });
  }

  test("판 8: 결과 없음 판정 뒤의 예산 기록은 stored_at(판정 시각)을 바꾸지 않는다", async () => {
    const got = await finalizeOf(8, [stopAt("completed", NOW + 1), judgeAt(NOW + 3), budgetAt(NOW + 19)]);
    expect(got).toMatchObject({ facts: { stoppedAt: NOW + 3, exit: "completed" }, ...sentAs("failed", NOW + 3) });
  });

  test("판 7에서 checking이던 실행을 판 8에서 판정하면 판정 시각·exit completed로 확정한다(뒤 예산 기록과 무관)", async () => {
    const got = await finalizeOf(7, [stopAt("completed", NOW + 1)], [judgeAt(NOW + 3), budgetAt(NOW + 19)]);
    expect(got).toMatchObject({ facts: { stoppedAt: NOW + 3, exit: "completed" }, ...sentAs("failed", NOW + 3) });
  });

  test("판 7에서 결과 없음으로 판정된 정상 옛 줄은 예산 기록이 있는 대조군과 장부에서 같은 모양이라 확정을 보류한다", async () => {
    const judged = await finalizeOf(7, [stopAt("completed", NOW + 1), judgeAt(NOW + 3)]);
    const budgeted = await finalizeOf(7, [stopAt("cancelled", NOW + 1), budgetAt(NOW + 3)]);
    expect(judged).toMatchObject({ facts: { stoppedAt: null, exit: null }, ...withheldAs("outcome_unknown") });
    expect(budgeted).toEqual(judged);
  });

  test("판 7 줄의 사유 requested 취소: 영수증 시각 그대로여도, 뒤 쓰기로 시각이 바뀌었어도 stored_at을 몰라 보류한다", async () => {
    const plain = await finalizeOf(7, [requestedAt(NOW + 1), stopAt("cancelled", NOW + 2)]);
    expect(plain).toMatchObject({ facts: { stoppedAt: null, exit: null }, ...withheldAs("stored_at_unknown") });
    for (const [name, after] of [
      ["예산 기록", budgetAt(NOW + 19)],
      ["결과 없음 판정", judgeAt(NOW + 19)],
    ] as const) {
      const exit = name === "예산 기록" ? "cancelled" : "completed";
      const got = await finalizeOf(7, [requestedAt(NOW + 1), stopAt(exit, NOW + 2), after]);
      expect([name, got]).toMatchObject([name, { facts: { stoppedAt: null, exit: null }, ...withheldAs("stored_at_unknown") }]);
    }
  });

  // 감독이 다시 뜨면 공유 시계의 하한이 0부터라(src/supervisor/runtime/shared-clock.ts), 결과 없음 판정 뒤의 예산 기록이 판정보다
  // 이른 영수증 시각을 다시 적을 수 있다. 그러면 판정이 영수증과 같은 시각인 이력과 늦은 이력이 장부의 모든 표에서 같아져,
  // updated_at과 영수증 시각의 일치로는 실패 시각을 가를 수 없다.
  test("판 7에서 실패 상태가 된 줄은 updated_at이 영수증 시각과 같아도 확정을 보류한다: 판정 시각이 같은 이력과 늦은 이력이 장부로 같다", async () => {
    const seed = tempPath();
    const base = ready(open(seed, { migrations: BEFORE_STOP_EXIT() }));
    const s = startedWorker(base);
    requestedAt(NOW + 1)(base, s);
    stopAt("completed", NOW + 2)(base, s);
    base.close();
    const tables: Record<string, unknown[]>[] = [];
    for (const judgedAt of [NOW + 2, NOW + 19]) {
      const path = tempPath();
      copyFileSync(seed, path);
      const judging = ready(open(path, { migrations: BEFORE_STOP_EXIT() }));
      judgeAt(judgedAt)(judging, s);
      judging.close();
      const restarted = ready(open(path, { migrations: BEFORE_STOP_EXIT() }));
      budgetAt(NOW + 2)(restarted, s);
      restarted.close();
      tables.push(tablesOf(path));
      const w = world(path);
      const read = w.ledger.failedStop(s.runId);
      w.setClock(NOW + 30);
      const { runId: _, ...outcome } = only(await tick(w), s.runId);
      const facts = read.known && read.value !== null ? { stoppedAt: read.value.stoppedAt, exit: read.value.exit } : read;
      expect([judgedAt, { facts, outcome, writes: writes(w), bodies: w.sent.map((e) => e.body) }]).toMatchObject([
        judgedAt,
        { facts: { stoppedAt: null, exit: null }, ...withheldAs("stored_at_unknown") },
      ]);
    }
    expect(Object.keys(tables[0] ?? {}).length).toBeGreaterThan(0);
    expect(tables[1]).toEqual(tables[0]);

    // 판 8의 같은 이력은 실패 시각 칸이 판정 시각을 고정해 뒤 예산 기록과 무관하게 그 시각으로 보낸다.
    const fixed = await finalizeOf(8, [requestedAt(NOW + 1), stopAt("completed", NOW + 2), judgeAt(NOW + 19), budgetAt(NOW + 2)]);
    expect(fixed).toMatchObject({ facts: { stoppedAt: NOW + 19, exit: "completed" }, ...sentAs("cancelled", NOW + 19) });
  });
});

// 장부 파일의 모든 표 내용. 두 이력이 장부만으로 갈리는지 보는 데 쓴다.
function tablesOf(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  try {
    const names = db.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(names.map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]));
  } finally {
    db.close();
  }
}
