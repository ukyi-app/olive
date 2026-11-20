import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type Envelope, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import { type AssignLoopLedger, type AssignLoopPolicy, type AssignLoopPorts, assignAndStartTick, type TickResult } from "../../../src/supervisor/dispatch/assign-loop.ts";
import { PRE_ASSIGN_FACTS, type PreAssignFacts } from "../../../src/supervisor/dispatch/pick.ts";
import type { Random, SendOutcome, Signer } from "../../../src/supervisor/dispatch/ports.ts";
import type { Candidate } from "../../../src/supervisor/transport/connections.ts";
import { id, must, NOW, open, ready, tempPath } from "../../ledger/helpers.ts";

// 실행기 이름·키·정책 숫자는 이 시험이 지어 넣는 자료다. 운영값이 아니다.
const DIGEST = "a".repeat(64);
const SNAPSHOT = "b".repeat(64);
const CRED_DIGEST = "c".repeat(64);
const EXECUTOR = "executor/isolated_reader/r1/s1";
const CLEAR: PreAssignFacts = Object.fromEntries(PRE_ASSIGN_FACTS.map((fact) => [fact, false]));
const keys = generateKeyPairSync("ed25519");

const POLICY: AssignLoopPolicy = {
  assignment: {
    allowed: [{ target: "reader", roles: ["isolated_reader"] }],
    registrations: [{ target: "reader", role: "isolated_reader", instance: "r1", storage: "s1", keyId: "key-r1", active: true }],
    expected: { profile_revision: "prof-1", policy_revision: "pol-1" },
  },
  accounts: [{ account: "acct-a", method: "api_key" }],
  plans: [{ role: "isolated_reader", snapshotDigest: SNAPSHOT, budgetLeft: 5000, runDurationMs: 600_000 }],
  queue: { alertMaxWaitMs: 60_000 },
  originOf: (source) => (source === "admin-dm" ? "admin" : undefined),
};

const CONNECTION: Candidate = {
  connection: 1,
  target: "reader",
  principal: { kind: "worker_executor", role: "isolated_reader", instance: "r1", storage: "s1" },
  keyId: "key-r1",
  hello: { profile_revision: "prof-1", policy_revision: "pol-1" },
};

// 호출 순서를 한 줄로 적는다(장부 → 서명 → 내보내기 순서를 본다).
type Log = string[];

// 일부러 던지게 할 수 있는 포트. clock은 장부에 주입한 시계다(박자는 시계를 직접 받지 않는다).
const FAULT_PORTS = ["random", "clock", "facts", "credentials", "signer", "sink"] as const;
type FaultPort = (typeof FAULT_PORTS)[number];

interface World {
  ledger: Ledger;
  ports: AssignLoopPorts;
  log: Log;
  sent: Envelope[];
  uuids: number;
  // arm 뒤로 포트마다 불린 횟수.
  calls: Record<FaultPort, number>;
  // 그 포트의 nth번째 호출(arm 뒤로 1부터)만 던지게 하고, 호출 횟수를 0부터 다시 센다.
  arm(port: FaultPort | null, nth?: number): void;
  setClock(at: number): void;
  setIntake(open: boolean): void;
  setStopGeneration(value: number | null): void;
  setSend(next: () => Promise<SendOutcome>): void;
  setFacts(next: () => PreAssignFacts): void;
  wrap(over: Partial<AssignLoopLedger>): void;
  enqueueRequest(expiresAt?: number): { owner: string; ref: string };
}

function world(): World {
  let clockAt = NOW;
  const calls: Record<FaultPort, number> = { random: 0, clock: 0, facts: 0, credentials: 0, signer: 0, sink: 0 };
  let fault: { port: FaultPort; nth: number } | null = null;
  const hit = (port: FaultPort) => {
    calls[port] += 1;
    if (fault?.port === port && calls[port] === fault.nth) throw new Error(`${port} 포트 실패`);
  };
  const ledger = ready(
    open(tempPath(), {
      clock: () => {
        hit("clock");
        return clockAt;
      },
    }),
  );
  const log: Log = [];
  const sent: Envelope[] = [];
  let intake = true;
  let stopGeneration: number | null = 0;
  let send: () => Promise<SendOutcome> = async () => "sent";
  let facts: () => PreAssignFacts = () => CLEAR;
  let override: Partial<AssignLoopLedger> = {};
  const w: World = {
    ledger,
    log,
    sent,
    uuids: 0,
    calls,
    arm: (port, nth = 1) => {
      for (const name of FAULT_PORTS) calls[name] = 0;
      fault = port === null ? null : { port, nth };
    },
    setClock: (at) => {
      clockAt = at;
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
    setFacts: (next) => {
      facts = next;
    },
    wrap: (over) => {
      override = over;
    },
    enqueueRequest(expiresAt = NOW + 3_600_000) {
      const owner = id();
      const source = `inbox/${id()}`;
      must(ledger.enqueueInput({ requestId: owner, source: "admin-dm", sourceRef: { ref: source, expiresAt }, receivedAt: NOW }));
      const ref = must(
        ledger.recordToolRequest({
          ref: id(),
          owner,
          dedupeKey: `start_worker:${owner}:read`,
          role: "isolated_reader",
          purpose: "read",
          sourceRef: source,
          inputDigest: DIGEST,
          sessionId: "session-1",
          callId: id(),
          now: NOW,
        }),
      ).request.ref;
      return { owner, ref };
    },
    ports: undefined as unknown as AssignLoopPorts,
  };
  // 실제 장부의 연산을 부르되, 시험이 바꾼 연산과 쓰기 호출을 적는다.
  const port = (name: keyof AssignLoopLedger) =>
    ((...args: unknown[]) => {
      if (name === "assignToolRequest" || name === "startRun") log.push(name);
      const fn = (override[name] ?? ledger[name].bind(ledger)) as (...a: unknown[]) => unknown;
      return fn(...args);
    }) as never;
  const random: Random = {
    bytes(length) {
      w.uuids += 1;
      hit("random");
      return getRandomValues(new Uint8Array(length));
    },
  };
  const signer: Signer = {
    seal(input) {
      log.push("seal");
      hit("signer");
      return sealEnvelope(input, keys.privateKey);
    },
  };
  w.ports = {
    ledger: {
      listWaitingToolRequests: port("listWaitingToolRequests"),
      assignToolRequest: port("assignToolRequest"),
      queueView: port("queueView"),
      listRuns: port("listRuns"),
      slotHolds: port("slotHolds"),
      listInputs: port("listInputs"),
      startRun: port("startRun"),
    },
    intake: { intakeOpen: () => intake && ledger.intakeOpen(), stopGeneration: () => stopGeneration },
    connections: { candidates: () => ({ known: true, value: [CONNECTION] }) },
    facts: {
      facts: () => {
        hit("facts");
        return facts();
      },
    },
    credentials: {
      reference: async () => {
        hit("credentials");
        return { known: true, credential: { account: "acct-a", method: "api_key", revision: "cred-1", digest: CRED_DIGEST } };
      },
    },
    random,
    signer,
    sink: {
      send: async (envelope) => {
        log.push("send");
        hit("sink");
        const outcome = await send();
        if (outcome === "sent") sent.push(envelope);
        return outcome;
      },
    },
  };
  return w;
}

function ran(result: TickResult): Extract<TickResult, { kind: "ran" }> {
  if (result.kind !== "ran") throw new Error(`박자가 돌지 않음: ${JSON.stringify(result)}`);
  return result;
}

function runCount(ledger: Ledger): number {
  const runs = ledger.listRuns();
  if (!runs.known) throw new Error("실행 목록을 읽지 못함");
  return runs.value.length;
}

// 부탁 하나를 잇고(1박자) 시작한다(2박자). 2박자의 결과를 낸다.
async function assignThenStart(w: World, now = NOW): Promise<{ runId: string; second: Extract<TickResult, { kind: "ran" }> }> {
  const { ref } = w.enqueueRequest();
  const first = ran(await assignAndStartTick(w.ports, POLICY, now));
  const assigned = first.requests.find((r) => r.ref === ref);
  if (assigned?.outcome !== "assigned") throw new Error(`잇지 못함: ${JSON.stringify(first)}`);
  return { runId: assigned.runId, second: ran(await assignAndStartTick(w.ports, POLICY, now)) };
}

describe("보장 1: 닫혔거나 모르면 쓰지 않는다", () => {
  test("접수가 닫혔으면 잇기도 시작도 부르지 않는다", async () => {
    const w = world();
    w.enqueueRequest();
    w.setIntake(false);
    expect(await assignAndStartTick(w.ports, POLICY, NOW)).toEqual({ kind: "not_run", reason: "intake_closed" });
    expect(w.log).toEqual([]);
    expect(runCount(w.ledger)).toBe(0);
  });

  test("정지 세대를 모르면 쓰지 않는다", async () => {
    const w = world();
    w.enqueueRequest();
    w.setStopGeneration(null);
    expect(await assignAndStartTick(w.ports, POLICY, NOW)).toEqual({ kind: "not_run", reason: "stop_generation_unknown" });
    expect(w.log).toEqual([]);
  });

  test("읽기 하나라도 모름이면 그 읽기의 이름으로 쓰지 않는다", async () => {
    const unknown = () => ({ known: false as const, reason: "io" as const });
    const cases = [
      ["waiting_requests", { listWaitingToolRequests: unknown }],
      ["queue_view", { queueView: unknown }],
      ["runs", { listRuns: unknown }],
      ["slot_holds", { slotHolds: unknown }],
      ["inputs", { listInputs: unknown }],
      ["queue_view", { queueView: () => ({ known: true as const, value: { runs: [], inputs: { processedSeq: 0, pending: [], cancelled: [], expired: [] } } }) }],
    ] as const;
    for (const [read, over] of cases) {
      const w = world();
      // 대기 실행 하나(시작 후보가 될 것)와 대기 부탁 하나를 둔다. 쓰기가 하나라도 불리면 log에 남는다.
      await assignThenStartSetup(w);
      w.wrap(over as Partial<AssignLoopLedger>);
      expect(await assignAndStartTick(w.ports, POLICY, NOW)).toEqual({ kind: "not_run", reason: "read_unknown", read });
      expect(w.log).toEqual([]);
    }
    for (const candidates of [() => ({ known: false as const }), () => ({ known: true as const, value: [null] }) as never, (): never => { throw new Error("연결 표 실패"); }]) {
      const w = world();
      await assignThenStartSetup(w);
      w.ports = { ...w.ports, connections: { candidates } };
      expect(await assignAndStartTick(w.ports, POLICY, NOW)).toEqual({ kind: "not_run", reason: "read_unknown", read: "candidates" });
      expect(w.log).toEqual([]);
    }
  });

  test("형식이 틀린 큐 읽기(known이 불리언 true가 아님, 대기 실행의 startBar 칸이 빠짐)도 모름이다", async () => {
    const malformed = [
      (w: World) => () => ({ ...w.ledger.queueView(), known: "false" }),
      (w: World) => () => {
        const real = w.ledger.queueView();
        if (!real.known) throw new Error("읽지 못함");
        const runs = real.value.runs.map((run) => Object.fromEntries(Object.entries(run).filter(([key]) => key !== "startBar")));
        return { known: true, value: { ...real.value, runs } };
      },
    ];
    for (const make of malformed) {
      const w = world();
      await assignThenStartSetup(w);
      w.wrap({ queueView: make(w) as never });
      expect(await assignAndStartTick(w.ports, POLICY, NOW)).toEqual({ kind: "not_run", reason: "read_unknown", read: "queue_view" });
      expect(w.log).toEqual([]);
      expect(runCount(w.ledger)).toBe(1);
    }
  });

  test("이 모듈은 시계·난수·소켓·타이머를 직접 부르지 않고 도구 처리기를 import하지 않는다", async () => {
    const source = await Bun.file(new URL("../../../src/supervisor/dispatch/assign-loop.ts", import.meta.url)).text();
    for (const banned of ["Date.now", "new Date", "performance.now", "Math.random", "randomUUID", "getRandomValues", "setTimeout", "setInterval", "node:", "bun:", "Bun.", "process.", "scheduler/tools"]) {
      expect(source).not.toContain(banned);
    }
  });

  test("박자 중에 접수가 닫히면 남은 쓰기를 부르지 않는다", async () => {
    const w = world();
    await assignThenStartSetup(w);
    // 시작 지시를 내보내는 동안 접수가 닫힌다. 남은 대기 부탁은 잇지 않는다.
    w.setSend(async () => {
      w.setIntake(false);
      return "sent";
    });
    const result = ran(await assignAndStartTick(w.ports, POLICY, NOW));
    expect(result.halted).toBe("intake_closed");
    expect(result.starts.map((s) => s.outcome)).toEqual(["sent"]);
    expect(result.requests).toEqual([]);
    expect(w.log).toEqual(["startRun", "seal", "send"]);
  });
});

// 대기 실행 하나와 대기 부탁 하나를 만들고 기록을 비운다.
async function assignThenStartSetup(w: World): Promise<void> {
  w.enqueueRequest();
  ran(await assignAndStartTick(w.ports, POLICY, NOW));
  w.enqueueRequest();
  w.log.length = 0;
}

describe("보장 2: 고른 부탁만 새 실행 ID로 잇는다", () => {
  test("한 부탁의 보류·거절이 다음 부탁을 막지 않고, 실행 ID는 난수 포트의 새 값이다", async () => {
    const w = world();
    // 장부 시계가 박자의 now보다 앞서 있다: 고르기는 만료 전으로 보고, 장부의 잇기는 만료로 거절한다.
    w.setClock(NOW + 10);
    const expiring = w.enqueueRequest(NOW + 5);
    const cancelled = w.enqueueRequest();
    must(w.ledger.cancelInput(cancelled.owner, NOW));
    const good = w.enqueueRequest();
    const result = ran(await assignAndStartTick(w.ports, POLICY, NOW));
    expect(result.requests).toEqual([
      { ref: expiring.ref, outcome: "assign_refused", reason: "input_expired" },
      { ref: cancelled.ref, outcome: "skipped", pick: { kind: "refused", reason: "input_cancelled" } },
      { ref: good.ref, outcome: "assigned", runId: expect.any(String), executorId: EXECUTOR },
    ]);
    const assigned = result.requests[2] as { runId: string };
    const runs = w.ledger.listRuns();
    expect(runs.known && runs.value.map((r) => r.runId)).toEqual([assigned.runId]);
    // 고르지 않은 부탁은 대기 그대로다.
    const waiting = w.ledger.listWaitingToolRequests();
    expect(waiting.known && waiting.value.map((r) => r.ref)).toEqual([expiring.ref, cancelled.ref]);
  });

  test("사실을 모르면 비워 넘겨 고르기가 보류한다(지어내지 않는다)", async () => {
    for (const facts of [() => ({}), () => ({ ...CLEAR, external_code: undefined }) as PreAssignFacts, () => { throw new Error("사실 포트 실패"); }]) {
      const w = world();
      const { ref } = w.enqueueRequest();
      w.setFacts(facts as () => PreAssignFacts);
      const result = ran(await assignAndStartTick(w.ports, POLICY, NOW));
      expect(result.requests).toEqual([{ ref, outcome: "skipped", pick: expect.objectContaining({ kind: "held", reason: "evidence_missing" }) }]);
      expect(w.log).toEqual([]);
    }
  });

  test("already_assigned면 새 실행을 만들지 않고 돌려받은 실행을 쓴다", async () => {
    const w = world();
    w.enqueueRequest();
    // 잇기 전의 목록을 붙잡아 두었다가 다시 내는 읽기: 이미 이은 부탁이 대기로 다시 나오는 경합이다.
    const stale = w.ledger.listWaitingToolRequests();
    const first = ran(await assignAndStartTick(w.ports, POLICY, NOW));
    const runId = (first.requests[0] as { runId: string }).runId;
    w.wrap({ listWaitingToolRequests: () => stale });
    const second = ran(await assignAndStartTick(w.ports, POLICY, NOW));
    expect(second.requests).toEqual([{ ref: expect.any(String), outcome: "already_assigned", runId, executorId: EXECUTOR }]);
    expect(runCount(w.ledger)).toBe(1);
  });
});

describe("보장 3: 장부가 시작을 승인한 뒤에만 시작 지시가 나간다", () => {
  test("시작 지시의 issued_at은 장부의 발행 시각이고, 장부 시계가 박자의 now보다 늦어도 나간다", async () => {
    const w = world();
    w.enqueueRequest();
    ran(await assignAndStartTick(w.ports, POLICY, NOW));
    // 장부는 박자의 now를 읽은 뒤 같은 시계로 발행 시각을 정한다.
    w.setClock(NOW + 7);
    w.log.length = 0;
    const result = ran(await assignAndStartTick(w.ports, POLICY, NOW));
    expect(result.starts).toHaveLength(1);
    const start = result.starts[0];
    if (start?.outcome !== "sent") throw new Error(JSON.stringify(start));
    const times = w.ledger.instructionTimes(start.runId);
    if (!times.known || times.value === null) throw new Error("지시 시각을 읽지 못함");
    expect(start.issuedAt).toBe(NOW + 7);
    expect(times.value.lease?.issuedAt).toBe(NOW + 7);
    const envelope = w.sent[0] as Envelope;
    expect(envelope.header).toEqual(
      expect.objectContaining({ action: "task_start", recipient: EXECUTOR, request_id: start.requestId, stop_generation: 0, issued_at: NOW + 7 }),
    );
    expect(envelope.body).toEqual(expect.objectContaining({ run_id: start.runId }));
    const run = w.ledger.getRun(start.runId);
    expect(run.known && run.value?.state).toBe("preparing");
    expect(w.log).toEqual(["startRun", "seal", "send"]);
  });

  test("장부가 거절하면 지시를 만들지 않는다", async () => {
    // 정지 세대가 장부와 다르다.
    const w = world();
    w.enqueueRequest();
    const first = ran(await assignAndStartTick(w.ports, POLICY, NOW));
    const runId = (first.requests[0] as { runId: string }).runId;
    w.setStopGeneration(1);
    w.log.length = 0;
    expect(ran(await assignAndStartTick(w.ports, POLICY, NOW)).starts).toEqual([{ runId, outcome: "start_refused", reason: "stop_generation_mismatch" }]);
    expect(w.log).toEqual(["startRun"]);
    expect(w.sent).toEqual([]);

    // 판단이 본 읽기에는 자리가 비었지만 장부에는 다른 실행이 자리를 쥐고 있다: 장부의 거절을 따른다.
    const v = world();
    await assignThenStartSetup(v);
    const holder = v.ledger.listRuns();
    if (!holder.known) throw new Error("읽지 못함");
    const busy = holder.value[0]?.runId as string;
    must(v.ledger.startRun({ runId: busy, requestId: id(), stopGeneration: 0, now: NOW }));
    ran(await assignAndStartTick(v.ports, POLICY, NOW));
    v.wrap({ listRuns: () => ({ known: true, value: (v.ledger.listRuns() as { value: { runId: string }[] }).value.filter((r) => r.runId !== busy) }) as never });
    v.log.length = 0;
    const starts = ran(await assignAndStartTick(v.ports, POLICY, NOW)).starts;
    expect(starts).toEqual([{ runId: expect.any(String), outcome: "start_refused", reason: "slot_busy" }]);
    expect(v.log).toEqual(["startRun"]);
  });

  test("장부가 던지거나 답의 꼴이 틀리면 지시를 만들지 않는다", async () => {
    for (const startRun of [
      () => {
        throw new Error("장부 실패");
      },
      () => ({ ok: "yes" }),
      () => ({ ok: false, reason: "made_up" }),
    ]) {
      const w = world();
      w.enqueueRequest();
      ran(await assignAndStartTick(w.ports, POLICY, NOW));
      w.wrap({ startRun: startRun as never });
      w.log.length = 0;
      const starts = ran(await assignAndStartTick(w.ports, POLICY, NOW)).starts;
      expect(starts).toEqual([{ runId: expect.any(String), outcome: "start_failed", failure: expect.stringMatching(/^(threw|malformed_answer)$/) }]);
      expect(w.log).toEqual(["startRun"]);
      expect(w.sent).toEqual([]);
    }
  });
});

describe("보장 4: 내보내지 못해도 새로 만들지 않는다", () => {
  test("no_connection이면 장부에 적힌 그대로 두고 식별값을 내며, 다음 박자도 다시 만들지 않는다", async () => {
    const w = world();
    w.setSend(async () => "no_connection");
    const { runId, second } = await assignThenStart(w);
    const times = w.ledger.instructionTimes(runId);
    if (!times.known || times.value === null || times.value.lease === null) throw new Error("지시 시각을 읽지 못함");
    expect(second.starts).toEqual([
      {
        runId,
        outcome: "recorded_not_sent",
        requestId: expect.any(String),
        stopGeneration: 0,
        issuedAt: times.value.lease.issuedAt,
        executorId: EXECUTOR,
        reason: "no_connection",
        delivery: "not_sent",
      },
    ]);
    const uuidsAfter = w.uuids;
    w.log.length = 0;
    const third = ran(await assignAndStartTick(w.ports, POLICY, NOW));
    expect(third.starts).toEqual([]);
    expect(w.log).toEqual([]);
    expect(w.uuids).toBe(uuidsAfter);
    expect(runCount(w.ledger)).toBe(1);
    const run = w.ledger.getRun(runId);
    expect(run.known && run.value?.state).toBe("preparing");
  });

  test("봉하기·내보내기 포트가 실패해도 같다. 포트가 실었는지 모르면 delivery는 unknown", async () => {
    const cases: [string, (w: World) => void, string, string][] = [
      ["too_late", (w) => w.setSend(async () => "too_late_to_send"), "too_late_to_send", "not_sent"],
      [
        "send_throws",
        (w) =>
          w.setSend(async () => {
            throw new Error("소켓 실패");
          }),
        "send_threw",
        "unknown",
      ],
      ["send_weird", (w) => w.setSend(async () => "maybe" as SendOutcome), "send_answer_malformed", "unknown"],
      [
        "signer_throws",
        (w) => {
          w.ports = {
            ...w.ports,
            signer: {
              seal() {
                throw new Error("키 없음");
              },
            },
          };
        },
        "seal_threw",
        "not_sent",
      ],
    ];
    for (const [, arrange, reason, delivery] of cases) {
      const w = world();
      arrange(w);
      const { runId, second } = await assignThenStart(w);
      expect(second.starts).toEqual([expect.objectContaining({ runId, outcome: "recorded_not_sent", reason, delivery })]);
      expect(runCount(w.ledger)).toBe(1);
    }
  });

  test("결과에 서명·자격 참조 값·봉투를 싣지 않는다", async () => {
    const w = world();
    const { second } = await assignThenStart(w);
    const text = JSON.stringify(second);
    expect(text).not.toContain(CRED_DIGEST);
    expect(text).not.toContain((w.sent[0] as Envelope).signature);
    expect(text).not.toContain("nonce");
  });
});

// 대기 실행 하나(이번 박자의 시작 후보)와 대기 부탁 둘을 만들고 기록을 비운다.
async function startPlusTwo(w: World): Promise<{ runId: string; a: string; b: string }> {
  w.enqueueRequest();
  const first = ran(await assignAndStartTick(w.ports, POLICY, NOW));
  const runId = (first.requests[0] as { runId: string }).runId;
  const a = w.enqueueRequest().ref;
  const b = w.enqueueRequest().ref;
  w.log.length = 0;
  return { runId, a, b };
}

function runStates(ledger: Ledger): Map<string, string> {
  const runs = ledger.listRuns();
  if (!runs.known) throw new Error("실행 목록을 읽지 못함");
  return new Map(runs.value.map((run) => [run.runId, run.state]));
}

describe("장부에 쓴 뒤에는 무엇이 던져도 그때까지의 결과가 돌아온다", () => {
  test("no_connection 뒤 다음 부탁의 난수가 던져도 recorded_not_sent와 남은 부탁의 결과가 함께 돌아온다", async () => {
    const w = world();
    w.setSend(async () => "no_connection");
    const { runId, a, b } = await startPlusTwo(w);
    // 난수 호출 순서: 시작의 요청 ID(1), nonce(2), 부탁 a의 실행 ID(3), 부탁 b의 실행 ID(4). 셋째만 던진다.
    w.arm("random", 3);
    const result = ran(await assignAndStartTick(w.ports, POLICY, NOW));
    expect(result.starts).toEqual([expect.objectContaining({ runId, outcome: "recorded_not_sent", reason: "no_connection", delivery: "not_sent" })]);
    expect(result.requests).toEqual([
      { ref: a, outcome: "assign_failed", failure: "random_unavailable" },
      { ref: b, outcome: "assigned", runId: expect.any(String), executorId: EXECUTOR },
    ]);
    expect([result.halted, result.haltedAt]).toEqual([null, null]);
    expect(w.log).toEqual(["startRun", "seal", "send", "assignToolRequest"]);
  });

  test("실제로 실은 뒤 내보내기 포트가 던지고 다음 부탁의 난수가 던져도 delivery unknown 결과가 돌아온다", async () => {
    const w = world();
    const { runId, a, b } = await startPlusTwo(w);
    const loaded: Envelope[] = [];
    w.ports = {
      ...w.ports,
      sink: {
        send: async (envelope) => {
          loaded.push(envelope);
          throw new Error("실은 뒤 소켓 실패");
        },
      },
    };
    w.arm("random", 3);
    const result = ran(await assignAndStartTick(w.ports, POLICY, NOW));
    expect(loaded).toHaveLength(1);
    expect(result.starts).toEqual([expect.objectContaining({ runId, outcome: "recorded_not_sent", reason: "send_threw", delivery: "unknown" })]);
    expect(result.requests).toEqual([
      { ref: a, outcome: "assign_failed", failure: "random_unavailable" },
      { ref: b, outcome: "assigned", runId: expect.any(String), executorId: EXECUTOR },
    ]);
  });

  test("난수·시계·사실·자격·서명·내보내기 포트가 어느 호출에서 던져도 박자는 던지지 않고, 장부에 적힌 시작과 이음이 모두 결과에 있다", async () => {
    // 기준 박자(시작 하나, 잇기 둘)에서 포트마다 불린 횟수를 세고, 그 호출 하나하나를 던지게 해 본다(쓰기 전과 쓰기 뒤가 모두 들어간다).
    const reference = world();
    await startPlusTwo(reference);
    reference.arm(null);
    ran(await assignAndStartTick(reference.ports, POLICY, NOW));
    const counts = { ...reference.calls };
    for (const port of FAULT_PORTS) {
      expect([port, counts[port] > 0]).toEqual([port, true]);
      for (let nth = 1; nth <= counts[port]; nth += 1) {
        const label = `${port}#${nth}`;
        const w = world();
        await startPlusTwo(w);
        const before = runStates(w.ledger);
        w.arm(port, nth);
        const result = await assignAndStartTick(w.ports, POLICY, NOW);
        w.arm(null);
        if (result.kind === "not_run") {
          // 쓰기 전의 읽기에서 던졌다(장부 시계). 쓰기 0.
          expect([label, result]).toEqual([label, { kind: "not_run", reason: "read_unknown", read: expect.any(String) }]);
          expect([label, w.log]).toEqual([label, []]);
          continue;
        }
        // 포트의 예외는 그 항목의 결과가 되고 박자를 멈추지 않는다: 시작 하나와 부탁 둘이 모두 결과에 있다.
        // 장부 시계가 쓰기 안에서 던지면 실제 장부가 접수를 닫으므로 그 뒤는 intake_closed로 멈춘다(멈춘 자리가 결과에 있다).
        if (result.halted === "intake_closed") {
          expect([label, result.haltedAt === null, result.starts.length + result.requests.length < 3]).toEqual([label, false, true]);
        } else {
          expect([label, result.halted, result.starts.length, result.requests.length]).toEqual([label, null, 1, 2]);
        }
        for (const [runId, state] of runStates(w.ledger)) {
          if (!before.has(runId)) {
            expect([label, result.requests]).toEqual([label, expect.arrayContaining([expect.objectContaining({ runId, outcome: "assigned" })])]);
          } else if (before.get(runId) === "queued" && state !== "queued") {
            expect([label, result.starts]).toEqual([label, [expect.objectContaining({ runId, outcome: expect.stringMatching(/^(sent|recorded_not_sent)$/) })]]);
          }
        }
      }
    }
  });

  test("포트 밖의 예외(사실 답의 칸을 읽다 던짐)는 박자를 멈추되, 그 전의 결과와 멈춘 자리를 낸다", async () => {
    const w = world();
    w.setSend(async () => "no_connection");
    const { runId, a } = await startPlusTwo(w);
    // await가 보는 then만 없다고 답하고, 고르기가 칸을 읽으면 던진다.
    const throwing = new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === "then") return undefined;
          throw new Error("사실 칸 읽기 실패");
        },
      },
    );
    w.setFacts(() => throwing as PreAssignFacts);
    const result = ran(await assignAndStartTick(w.ports, POLICY, NOW));
    expect(result.starts).toEqual([expect.objectContaining({ runId, outcome: "recorded_not_sent", reason: "no_connection" })]);
    expect(result.requests).toEqual([]);
    expect(result.halted).toBe("threw");
    expect(result.haltedAt).toEqual({ step: "assign", ref: a });
    expect(w.log).toEqual(["startRun", "seal", "send"]);
  });
});
