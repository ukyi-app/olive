// 운영 중 인사(hello)의 전체 점유를 장부로 넘기는 처리(hello-answers.ts). 연결 판단은 실제 Connections에 실제로 서명한 봉투를 넣어
// 출력을 얻고, 장부는 임시 파일의 실제 장부다. 접수 복원기는 정지 세대와 접수 여부만 내는 가짜이고 연결 판단의 맞춤에도 같은 객체를 쓴다.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { type Envelope, limits, type NonceStore, rawPublicKey, type RunStatus, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import { type HelloAnswerLedger, type HelloAnswerOutcome, type HelloConnectionTable, type HelloRetry, passHelloAnswer, retryHelloAnswer } from "../../../src/supervisor/dispatch/hello-answers.ts";
import { Connections, type Output, type ReplyTools } from "../../../src/supervisor/transport/connections.ts";
import { type ExecutorPeer, type RegistrySettings, RegistryState } from "../../../src/supervisor/transport/registry.ts";
import { digest, id, must, NOW, open, ready, SESSION_EXECUTOR, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";

// 키·등록행·시각은 이 시험이 고른 값이다. 운영값이 아니다.
const OTHER = "executor/diagnosis/1/store-b";
let counter = 0;
const hex32 = () => (++counter).toString(16).padStart(32, "0");
const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;

interface Keys {
  readonly privateKey: KeyObject;
  readonly raw: string;
}
function newKeys(): Keys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, raw: rawPublicKey(publicKey) };
}
const SUP = newKeys();
const K0 = newKeys();
const K1 = newKeys();

const PEER: ExecutorPeer = { kind: "executor", namespace: "olive-diagnosis", target: "diagnosis", uri: "spiffe://olive.internal/ns/olive-diagnosis/executor/diagnosis" };
const registrySettings: RegistrySettings = { environment: "home", targets: [{ target: "diagnosis", namespace: "olive-diagnosis", roles: ["diagnosis"] }] };
const rowOf = (keys: Keys, instance: string, storage: string) => ({ target: "diagnosis", role: "diagnosis", instance, storage, public_key: keys.raw, active: true });

function registry(): RegistryState {
  const outcome = RegistryState.start(registrySettings).apply({ kind: "content", content: JSON.stringify({ environment: "home", revision: 1, executors: [rowOf(K0, "0", "store-a"), rowOf(K1, "1", "store-b")] }) });
  if (outcome.kind !== "applied") throw new Error("등록표를 적용하지 못함");
  return outcome.state;
}

function nonceStore(): NonceStore {
  const seen = new Set<string>();
  return {
    consume(sender, nonce) {
      const key = `${sender} ${nonce}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}

// 접수 복원기(Restorer의 두 읽기). 연결 판단의 맞춤 답에도 이 객체를 쓴다(candidates의 객체 동일성).
function intake(open = true, generation: number | null = 0) {
  const source = { open, generation, intakeOpen: () => source.open, stopGeneration: () => source.generation };
  return source;
}

const tools: ReplyTools = { seal: (input) => sealEnvelope(input, SUP.privateKey), requestId: uuid, nonce: hex32 };

function envelope(keys: Keys, sender: string, action: "stop_sync_request" | "hello" | "status_report", generation: number, issuedAt: number, body: unknown): Envelope {
  return sealEnvelope({ sender, recipient: "supervisor", action, request_id: uuid(), stop_generation: generation, run_generation: 0, issued_at: issuedAt, nonce: hex32(), body } as never, keys.privateKey);
}

// 연결 판단 하나와 장부 하나. 연결 표는 사건마다 새 값으로 바꾼다.
class World {
  table = Connections.start();
  readonly registry = registry();
  readonly nonces = nonceStore();
  constructor(
    readonly ledger: Ledger,
    public stop = intake(),
  ) {}

  async receive(conn: number, env: Envelope, at: number): Promise<Output[]> {
    const checked = await this.table.check(conn, env, { now: at, registry: this.registry, stop: this.stop, runGeneration: (runId) => this.ledger.runGeneration(runId), nonces: this.nonces });
    return this.step({ kind: "envelope", checked }, at);
  }

  step(event: Parameters<Connections["step"]>[0], at: number): Output[] {
    const step = this.table.step(event, { now: at, registry: this.registry, stop: this.stop }, tools);
    this.table = step.table;
    return step.outputs;
  }

  // 맞춤 → 답 싣기 → hello. signedAt은 실행기 시계의 서명 시각, at은 감독이 받은 시각이다. hello의 full 출력을 돌려준다.
  async greet(keys: Keys, principal: string, runs: RunStatus[], signedAt: number, at: number): Promise<{ conn: number; output: Output }> {
    const opened = this.table.open(PEER, at);
    this.table = opened.table;
    const conn = opened.id;
    await this.receive(conn, envelope(keys, principal, "stop_sync_request", 0, at, { challenge: hex32() }), at);
    this.step({ kind: "reply_sent", connection: conn, at }, at);
    const out = await this.receive(conn, envelope(keys, principal, "hello", this.stop.generation!, signedAt, { profile_revision: "profile-1", policy_revision: "policy-1", runs, unacked_ids: [] }), at);
    const output = out.find((o) => o.kind === "occupancy");
    if (output === undefined) throw new Error(`인사가 받아들여지지 않음: ${JSON.stringify(out)}`);
    return { conn, output };
  }
}

// 장부 호출을 그대로 기록하고 실제 장부에 넘긴다.
function spy(ledger: HelloAnswerLedger) {
  const calls: unknown[][] = [];
  const port: HelloAnswerLedger = {
    applyExecutorAnswer(input, from) {
      calls.push([structuredClone(input), structuredClone(from)]);
      return ledger.applyExecutorAnswer(input, from);
    },
  };
  return { calls, port };
}

function status(runId: string, state: RunStatus["state"], lastReceiptId: string | null = null): RunStatus {
  return state === "not_known" ? { run_id: runId, state, run_generation: null, last_receipt_id: null } : { run_id: runId, state, run_generation: 1, last_receipt_id: lastReceiptId };
}

function runState(ledger: Ledger, runId: string) {
  const read = ledger.getRun(runId);
  if (!read.known || read.value === null) throw new Error("실행 없음");
  return read.value.state;
}

function sightings(path: string): unknown[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query("SELECT run_id, executor_id, reported_state, answered_at, received_at, coverage FROM run_sightings ORDER BY run_id").all();
  } finally {
    raw.close();
  }
}

// 시작 영수증으로 running에 둔 작업자 실행.
function runningWorker(ledger: Ledger) {
  const started = startedWorker(ledger);
  must(ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId: started.runId, instructionRequestId: started.requestId, bodyDigest: digest("started"), now: NOW }, started.from));
  return started;
}

const SIGNED = NOW + 5_000;
const RECEIVED = NOW + 6_200;
const LATER = NOW + 7_000;

function expectNoRetry(outcome: HelloAnswerOutcome): void {
  expect("retry" in outcome ? outcome.retry : null).toBeNull();
}

describe("보장 1: 전체 답은 검증된 인사에서만, 서명 시각과 함께", () => {
  test("full 출력을 coverage full, 낸 쪽, 인사의 실행 목록 그대로, 받은 시각이 아닌 서명 시각으로 넘긴다", async () => {
    const path = tempPath();
    const ledger = ready(open(path));
    const live = runningWorker(ledger);
    const w = new World(ledger);
    const runs = [status(live.runId, "running")];
    const { conn, output } = await w.greet(K0, WORKER_EXECUTOR, runs, SIGNED, RECEIVED);
    const { calls, port } = spy(ledger);
    const outcome = passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: port, intake: w.stop });
    expect(outcome).toEqual({ kind: "applied", executorId: WORKER_EXECUTOR, connection: conn, answeredAt: SIGNED, moved: [], deferred: [], outsideLedger: [] });
    expect(calls).toEqual([[{ coverage: "full", runs, answeredAt: SIGNED, now: LATER }, { sender: WORKER_EXECUTOR }]]);
    ledger.close();
    expect(sightings(path)).toEqual([{ run_id: live.runId, executor_id: WORKER_EXECUTOR, reported_state: "running", answered_at: SIGNED, received_at: LATER, coverage: "full" }]);
  });

  test("상태 보고의 partial 행은 받지 않는다: 서명 시각을 붙여도 full로 올리는 길이 없다", async () => {
    const ledger = ready(open(tempPath()));
    const live = runningWorker(ledger);
    const w = new World(ledger);
    const runs = [status(live.runId, "running")];
    const { conn } = await w.greet(K0, WORKER_EXECUTOR, runs, SIGNED, RECEIVED);
    const report = await w.receive(conn, envelope(K0, WORKER_EXECUTOR, "status_report", 0, SIGNED + 100, { in_reply_to: uuid(), runs }), RECEIVED + 100);
    const partial = report.find((o) => o.kind === "occupancy")!;
    const { calls, port } = spy(ledger);
    const ports = { ledger: port, intake: w.stop };
    expect(passHelloAnswer({ output: partial, table: w.table, now: LATER }, ports)).toEqual({ kind: "refused", why: "partial" });
    // 인사와 같은 실행 목록에 인사의 서명 시각까지 붙인 partial도 같다.
    expect(passHelloAnswer({ output: { ...partial, issuedAt: SIGNED }, table: w.table, now: LATER }, ports)).toEqual({ kind: "refused", why: "partial" });
    // 상태 보고의 forward 출력도 점유가 아니다.
    expect(passHelloAnswer({ output: report.find((o) => o.kind === "forward"), table: w.table, now: LATER }, ports)).toEqual({ kind: "refused", why: "not_occupancy" });
    expect(calls).toEqual([]);
  });

  test("서명 시각이 없거나 꼴이 틀리면 받은 시각으로 대신하지 않고 장부를 부르지 않는다", async () => {
    const ledger = ready(open(tempPath()));
    const w = new World(ledger);
    const { output } = await w.greet(K0, WORKER_EXECUTOR, [], SIGNED, RECEIVED);
    const { issuedAt: _, ...unsigned } = output as Extract<Output, { kind: "occupancy" }>;
    const { calls, port } = spy(ledger);
    const ports = { ledger: port, intake: w.stop };
    for (const bad of [unsigned, { ...unsigned, issuedAt: null }, { ...unsigned, issuedAt: -1 }, { ...unsigned, issuedAt: "1" }, { ...unsigned, issuedAt: SIGNED + 0.5 }]) {
      expect(passHelloAnswer({ output: bad, table: w.table, now: LATER }, ports), JSON.stringify(bad)).toEqual({ kind: "refused", why: "signed_time_missing" });
    }
    for (const bad of [null, 7, { kind: "occupancy" }, { ...unsigned, answer: { ...(unsigned.answer as object), coverage: "most" } }, { ...output, connection: 0 }]) {
      expect(passHelloAnswer({ output: bad, table: w.table, now: LATER }, ports), JSON.stringify(bad)).toEqual({ kind: "refused", why: "malformed_output" });
    }
    expect(passHelloAnswer({ output, table: w.table, now: Number.NaN }, ports)).toEqual({ kind: "refused", why: "malformed_now" });
    expect(calls).toEqual([]);
  });
});

describe("보장 2: 지금의 인정된 인사만", () => {
  test("같은 주체의 새 연결이 맞추면 옛 연결의 인사는 넘기지 않고, 새 연결의 인사는 넘긴다", async () => {
    const ledger = ready(open(tempPath()));
    const w = new World(ledger);
    const first = await w.greet(K0, WORKER_EXECUTOR, [], SIGNED, RECEIVED);
    const second = await w.greet(K0, WORKER_EXECUTOR, [], SIGNED + 10, RECEIVED + 10);
    expect(w.table.get(first.conn)!.closed).toBe("superseded");
    const { calls, port } = spy(ledger);
    const ports = { ledger: port, intake: w.stop };
    expect(passHelloAnswer({ output: first.output, table: w.table, now: LATER }, ports)).toEqual({ kind: "not_current", executorId: WORKER_EXECUTOR, connection: first.conn, why: "not_greeted" });
    expect(calls).toEqual([]);
    expect(passHelloAnswer({ output: second.output, table: w.table, now: LATER }, ports).kind).toBe("applied");
    // 닫혀 지운 연결.
    w.step({ kind: "closed", connection: second.conn }, LATER);
    expect(passHelloAnswer({ output: second.output, table: w.table, now: LATER }, ports)).toEqual({ kind: "not_current", executorId: WORKER_EXECUTOR, connection: second.conn, why: "no_connection" });
    expect(calls).toHaveLength(1);
  });

  test("다른 복원기, 세대 모름, 오른 정지 세대의 연결은 넘기지 않는다", async () => {
    const ledger = ready(open(tempPath()));
    const w = new World(ledger);
    const { conn, output } = await w.greet(K0, WORKER_EXECUTOR, [], SIGNED, RECEIVED);
    const { calls, port } = spy(ledger);
    expect(passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: port, intake: intake() })).toEqual({ kind: "not_current", executorId: WORKER_EXECUTOR, connection: conn, why: "other_restore" });
    w.stop.generation = null;
    expect(passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: port, intake: w.stop })).toEqual({ kind: "not_current", executorId: WORKER_EXECUTOR, connection: conn, why: "other_restore" });
    w.stop.generation = 1;
    expect(passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: port, intake: w.stop })).toEqual({ kind: "not_current", executorId: WORKER_EXECUTOR, connection: conn, why: "stop_generation_changed" });
    expect(calls).toEqual([]);
  });

  test("남의 인사로 바꾼 출력(낸 쪽, 서명 시각, 실행 목록)은 넘기지 않는다", async () => {
    const ledger = ready(open(tempPath()));
    const live = runningWorker(ledger);
    const w = new World(ledger);
    const mine = await w.greet(K0, WORKER_EXECUTOR, [status(live.runId, "running")], SIGNED, RECEIVED);
    const theirs = await w.greet(K1, OTHER, [], SIGNED + 1, RECEIVED + 1);
    const full = mine.output as Extract<Output, { kind: "occupancy" }>;
    const { calls, port } = spy(ledger);
    const ports = { ledger: port, intake: w.stop };
    const cases: [unknown, string][] = [
      [{ ...full, answer: { ...full.answer, executorId: OTHER } }, "other_principal"],
      [{ ...full, answer: { ...full.answer, executorId: SESSION_EXECUTOR } }, "other_principal"],
      [{ ...full, issuedAt: SIGNED + 1 }, "other_greeting"],
      [{ ...full, answer: { ...full.answer, runs: [status(live.runId, "failed_stopped", id())] } }, "other_greeting"],
      [{ ...full, answer: { ...full.answer, runs: [] } }, "other_greeting"],
      [{ ...(theirs.output as object), connection: mine.conn }, "other_principal"],
    ];
    for (const [output, why] of cases) expect((passHelloAnswer({ output, table: w.table, now: LATER }, ports) as { why?: string }).why, why).toBe(why);
    expect(calls).toEqual([]);
    expect(runState(ledger, live.runId)).toBe("running");
  });

  test("접수가 열리기 전(복원 중)에는 넘기지 않고 held로 그 실행기를 빼며, 열린 뒤 같은 출력을 다시 넘기면 반영한다", async () => {
    const ledger = ready(open(tempPath()));
    const live = runningWorker(ledger);
    const w = new World(ledger, intake(false));
    const { conn, output } = await w.greet(K0, WORKER_EXECUTOR, [status(live.runId, "finalized", id())], SIGNED, RECEIVED);
    const { calls, port } = spy(ledger);
    expect(passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: port, intake: w.stop })).toEqual({ kind: "held", executorId: WORKER_EXECUTOR, connection: conn, withhold: WORKER_EXECUTOR });
    expect(calls).toEqual([]);
    expect(runState(ledger, live.runId)).toBe("running");
    w.stop.open = true;
    expect(passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: port, intake: w.stop }).kind).toBe("applied");
    expect(runState(ledger, live.runId)).toBe("unknown_running");
  });

  test("실행을 맡을 수 없는 주체의 인사는 장부의 거절(LedgerInputError)을 구별해 돌려주고 다시 넘길 값이 없다", () => {
    const ledger = ready(open(tempPath()));
    const source = intake();
    const runs: RunStatus[] = [];
    // 연결 판단은 작업자 실행기만 맞추므로(syncRequest) 이 연결 표는 지어낸 것이다. 장부의 판정이 그대로 나오는지만 본다.
    const greeted = { phase: "greeted", sync: { principal: "supervisor", generation: 0 }, greeting: { issued_at: SIGNED, runs } };
    const table = { get: () => greeted, candidates: () => [{ connection: 9 }] } as unknown as HelloConnectionTable;
    const output = { kind: "occupancy", connection: 9, answer: { executorId: "supervisor", coverage: "full", runs }, issuedAt: SIGNED };
    const outcome = passHelloAnswer({ output, table, now: LATER }, { ledger, intake: source });
    expect(outcome).toMatchObject({ kind: "ledger_failed", executorId: "supervisor", connection: 9, failure: "input_rejected", retry: null, withhold: "supervisor" });
    expect((outcome as { message: string }).message).toContain("실행을 맡을 수 있는 실행기 주체가 아니다");
    expectNoRetry(outcome);
  });
});

describe("보장 3: 장부의 답을 구별해 돌려주고, 실패한 답은 같은 값으로 다시 넘긴다", () => {
  test("moved·deferred·outsideLedger를 지우거나 합치지 않는다", async () => {
    const ledger = ready(open(tempPath()));
    const w = new World(ledger);
    const { conn, output } = await w.greet(K0, WORKER_EXECUTOR, [], SIGNED, RECEIVED);
    const answer = {
      ok: true,
      moved: [{ runId: id(), runGeneration: 1, before: "running", after: "unknown_running" }],
      deferred: [{ runId: id(), runGeneration: 2, state: "preparing", why: "start_may_arrive" }],
      outsideLedger: [{ runId: id(), runGeneration: 3 }],
    };
    const fake = { applyExecutorAnswer: () => answer } as unknown as HelloAnswerLedger;
    expect(passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: fake, intake: w.stop })).toEqual({
      kind: "applied",
      executorId: WORKER_EXECUTOR,
      connection: conn,
      answeredAt: SIGNED,
      moved: answer.moved,
      deferred: answer.deferred,
      outsideLedger: answer.outsideLedger,
    } as never);
  });

  test("실패는 반영으로 세지 않는다: 장부의 사유와 unsavedSightings 그대로, 다시 넘길 값과 맡기지 않을 실행기를 내고, 다시 넘기면 남는다", async () => {
    let fail = true;
    const path = tempPath();
    const ledger = open(path, {
      faults: {
        at(point) {
          if (fail && point === "executor_answer:before_commit") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
        },
      },
    });
    const live = runningWorker(ledger);
    const w = new World(ledger);
    const runs = [status(live.runId, "failed_stopped", id())];
    const { conn, output } = await w.greet(K0, WORKER_EXECUTOR, runs, SIGNED, RECEIVED);
    const failed = passHelloAnswer({ output, table: w.table, now: LATER }, { ledger, intake: w.stop });
    expect(failed).toMatchObject({
      kind: "ledger_unsaved",
      executorId: WORKER_EXECUTOR,
      connection: conn,
      reason: "ledger_unwritable",
      unsavedSightings: [{ runId: live.runId, runGeneration: 1 }],
      retry: { executorId: WORKER_EXECUTOR, connection: conn, runs, answeredAt: SIGNED },
      withhold: WORKER_EXECUTOR,
    });
    expect(runState(ledger, live.runId)).toBe("running");
    const retry = (failed as { retry: HelloRetry }).retry;
    expect(Object.isFrozen(retry) && Object.isFrozen(retry.runs) && Object.isFrozen(retry.runs[0])).toBe(true);
    // 다시 넘기기는 연결을 다시 보지 않는다: 그 사이 연결이 닫혀도 같은 값이 남는다.
    w.step({ kind: "closed", connection: conn }, LATER);
    fail = false;
    const { calls, port } = spy(ledger);
    expect(retryHelloAnswer(retry, LATER + 1, { ledger: port })).toEqual({
      kind: "applied",
      executorId: WORKER_EXECUTOR,
      connection: conn,
      answeredAt: SIGNED,
      moved: [{ runId: live.runId, runGeneration: 1, before: "running", after: "unknown_running" }],
      deferred: [],
      outsideLedger: [],
    });
    expect(calls).toEqual([[{ coverage: "full", runs, answeredAt: SIGNED, now: LATER + 1 }, { sender: WORKER_EXECUTOR }]]);
    ledger.close();
    expect(sightings(path)).toEqual([{ run_id: live.runId, executor_id: WORKER_EXECUTOR, reported_state: "failed_stopped", answered_at: SIGNED, received_at: LATER + 1, coverage: "full" }]);
  });

  test("다시 넘기는 입구는 이 모듈이 낸 값만 받는다(지어낸 값으로 full을 넘기지 못한다)", () => {
    const ledger = ready(open(tempPath()));
    const { calls, port } = spy(ledger);
    const forged: HelloRetry = { executorId: WORKER_EXECUTOR, connection: 1, runs: [], answeredAt: SIGNED };
    expect(retryHelloAnswer(forged, LATER, { ledger: port })).toEqual({ kind: "refused", why: "not_retry" });
    expect(retryHelloAnswer(null as never, LATER, { ledger: port })).toEqual({ kind: "refused", why: "not_retry" });
    expect(calls).toEqual([]);
  });

  test("장부가 던지거나 답의 꼴이 틀리면 ledger_failed이고 다시 넘길 값을 싣는다", async () => {
    const ledger = ready(open(tempPath()));
    const w = new World(ledger);
    const { output } = await w.greet(K0, WORKER_EXECUTOR, [], SIGNED, RECEIVED);
    const throwing = {
      applyExecutorAnswer: () => {
        throw new Error("boom");
      },
    } as unknown as HelloAnswerLedger;
    const thrown = passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: throwing, intake: w.stop });
    expect(thrown).toMatchObject({ kind: "ledger_failed", failure: "threw", message: null, withhold: WORKER_EXECUTOR });
    expect((thrown as { retry: HelloRetry | null }).retry).not.toBeNull();
    for (const answer of [null, { ok: true }, { ok: false, reason: "made_up", unsavedSightings: [] }, { ok: false, reason: "ledger_unwritable" }]) {
      const odd = { applyExecutorAnswer: () => answer } as unknown as HelloAnswerLedger;
      expect(passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: odd, intake: w.stop }), JSON.stringify(answer)).toMatchObject({ kind: "ledger_failed", failure: "malformed_answer", withhold: WORKER_EXECUTOR });
    }
    // 다시 넘긴 값도 성공하면 applied다.
    expect(retryHelloAnswer((thrown as { retry: HelloRetry }).retry, LATER, { ledger }).kind).toBe("applied");
  });
});

describe("보장 4: 자리를 풀지 않고, 기존 동작은 그대로다", () => {
  // 장부 포트는 applyExecutorAnswer 하나만 쓴다: 다른 연산에 손대면 이 감싸개가 던지고 결과가 applied가 아니게 된다.
  function onlyAnswer(ledger: Ledger): HelloAnswerLedger {
    return new Proxy(ledger, {
      get(target, key) {
        if (key !== "applyExecutorAnswer") throw new Error(`쓰지 않아야 할 장부 연산: ${String(key)}`);
        return target.applyExecutorAnswer.bind(target);
      },
    });
  }

  test("인사가 끝났다고 한 running 실행은 unknown_running으로 가고 자리는 slot_busy다. 다시 '돈다'고 해도 되살리지 않는다", async () => {
    const path = tempPath();
    const ledger = ready(open(path));
    const live = runningWorker(ledger);
    const w = new World(ledger);
    const first = await w.greet(K0, WORKER_EXECUTOR, [status(live.runId, "failed_stopped", id())], SIGNED, RECEIVED);
    const outcome = passHelloAnswer({ output: first.output, table: w.table, now: LATER }, { ledger: onlyAnswer(ledger), intake: w.stop });
    expect(outcome).toMatchObject({ kind: "applied", moved: [{ runId: live.runId, runGeneration: 1, before: "running", after: "unknown_running" }] });
    expect(runState(ledger, live.runId)).toBe("unknown_running");
    const next = must(ledger.admitRun(worker())).run.runId;
    expect(ledger.startRun({ runId: next, requestId: id(), stopGeneration: 0, now: LATER })).toEqual({ ok: false, reason: "slot_busy" });
    const again = await w.greet(K0, WORKER_EXECUTOR, [status(live.runId, "running")], SIGNED + 100, RECEIVED + 100);
    expect(passHelloAnswer({ output: again.output, table: w.table, now: LATER + 1 }, { ledger: onlyAnswer(ledger), intake: w.stop })).toMatchObject({ kind: "applied", moved: [] });
    expect(runState(ledger, live.runId)).toBe("unknown_running");
    expect(runState(ledger, next)).toBe("queued");
    ledger.close();
    // 첫 관측은 full로, 서명 시각과 함께 남고 뒤의 답이 덮지 않는다.
    expect(sightings(path)).toEqual([{ run_id: live.runId, executor_id: WORKER_EXECUTOR, reported_state: "failed_stopped", answered_at: SIGNED, received_at: LATER, coverage: "full" }]);
  });

  test("인사에 없는 preparing 실행은 그대로다(닫지 않고 관측도 없다). 장부 밖 실행은 닫을 대상으로만 돌려준다", async () => {
    const path = tempPath();
    const ledger = ready(open(path));
    const started = startedWorker(ledger);
    const before = ledger.instructionTimes(started.runId);
    const runsBefore = ledger.listRuns();
    const w = new World(ledger);
    const ghost = id();
    // 실행기 시계로 시작 발행 + RUN_LEASE_MAX_MS 뒤에 서명한 전체 답에도 그 실행이 없다. 이 PR은 그것으로 닫지 않는다(D-90은 뒤 조각).
    const signed = NOW + limits.RUN_LEASE_MAX_MS + 1;
    const { output } = await w.greet(K0, WORKER_EXECUTOR, [status(ghost, "running")], signed, signed);
    expect(passHelloAnswer({ output, table: w.table, now: signed + 1 }, { ledger: onlyAnswer(ledger), intake: w.stop })).toMatchObject({
      kind: "applied",
      answeredAt: signed,
      moved: [],
      deferred: [],
      outsideLedger: [{ runId: ghost, runGeneration: 1 }],
    });
    expect(runState(ledger, started.runId)).toBe("preparing");
    expect(ledger.instructionTimes(started.runId)).toEqual(before);
    expect(ledger.hasRunSighting(started.runId)).toEqual({ known: true, value: false });
    expect(ledger.getRun(ghost)).toEqual({ known: true, value: null });
    expect(ledger.listRuns()).toEqual(runsBefore);
    ledger.close();
    expect(sightings(path)).toEqual([]);
  });
});

describe("경계: 시각 0, 장부 답의 꼴, 포트 오류의 원문", () => {
  test("시각 0은 두 입구 모두 장부를 부르기 전에 거절하고 맡기지 않을 실행기를 내지 않는다", async () => {
    const ledger = ready(open(tempPath()));
    const live = runningWorker(ledger);
    const w = new World(ledger);
    const { output } = await w.greet(K0, WORKER_EXECUTOR, [status(live.runId, "running")], SIGNED, RECEIVED);
    const { calls, port } = spy(ledger);
    const ports = { ledger: port, intake: w.stop };
    // 계약의 머리 시각과 장부의 시각은 1 이상이다. 0을 넘기면 장부가 입력을 거절해 재시도 없는 실행기 오류처럼 보인다.
    expect(passHelloAnswer({ output, table: w.table, now: 0 }, ports)).toEqual({ kind: "refused", why: "malformed_now" });
    expect(passHelloAnswer({ output: { ...(output as object), issuedAt: 0 }, table: w.table, now: LATER }, ports)).toEqual({ kind: "refused", why: "signed_time_missing" });
    const throwing = {
      applyExecutorAnswer: () => {
        throw new Error("boom");
      },
    } as unknown as HelloAnswerLedger;
    const retry = (passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: throwing, intake: w.stop }) as { retry: HelloRetry }).retry;
    expect(retryHelloAnswer(retry, 0, { ledger: port })).toEqual({ kind: "refused", why: "malformed_now" });
    expect(calls).toEqual([]);
    expect(runState(ledger, live.runId)).toBe("running");
  });

  test("장부 답을 읽다가 던져도 밖으로 나가지 않고, 약속한 꼴이 아닌 항목은 반영으로 세지 않는다", async () => {
    const ledger = ready(open(tempPath()));
    const w = new World(ledger);
    const { output } = await w.greet(K0, WORKER_EXECUTOR, [], SIGNED, RECEIVED);
    const runId = id();
    const answers: unknown[] = [
      { ok: true, moved: [null], deferred: [{ unexpected: "CANARY" }], outsideLedger: [{ runId: 17, runGeneration: -1 }] },
      { ok: true, moved: [null], deferred: [], outsideLedger: [] },
      { ok: true, moved: [], deferred: [{ unexpected: "CANARY" }], outsideLedger: [] },
      { ok: true, moved: [], deferred: [], outsideLedger: [{ runId: 17, runGeneration: -1 }] },
      { ok: true, moved: [{ runId, runGeneration: 1, before: "running", after: "nowhere" }], deferred: [], outsideLedger: [] },
      { ok: true, moved: [], deferred: [{ runId, runGeneration: 1, state: "preparing", why: "because" }], outsideLedger: [] },
      { ok: true, moved: [], deferred: [], outsideLedger: [{ runId, runGeneration: 0 }] },
      { ok: false, reason: "ledger_unwritable", unsavedSightings: [false] },
      {
        get ok(): never {
          throw new Error("getter");
        },
      },
    ];
    for (const answer of answers) {
      const odd = { applyExecutorAnswer: () => answer } as unknown as HelloAnswerLedger;
      const outcome = passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: odd, intake: w.stop });
      expect(outcome, String(answers.indexOf(answer))).toMatchObject({ kind: "ledger_failed", failure: "malformed_answer", message: null, withhold: WORKER_EXECUTOR });
      expect((outcome as { retry: HelloRetry | null }).retry).not.toBeNull();
    }
  });

  test("장부 답의 칸은 한 번만 읽고, 검사한 그 값을 돌려준다", async () => {
    const ledger = ready(open(tempPath()));
    const w = new World(ledger);
    const { output } = await w.greet(K0, WORKER_EXECUTOR, [], SIGNED, RECEIVED);
    // 읽을 때마다 다음 값을 내는 칸. 두 번째 값은 처음 값과 달라 다시 읽으면 결과나 분기에 드러난다.
    const reads = new Map<string, number>();
    function shifting<T extends object>(name: string, cells: Record<string, readonly [unknown, unknown]>): T {
      const item = {};
      for (const [key, values] of Object.entries(cells)) {
        const label = `${name}.${key}`;
        Object.defineProperty(item, key, {
          enumerable: true,
          get() {
            const n = reads.get(label) ?? 0;
            reads.set(label, n + 1);
            return values[Math.min(n, 1)];
          },
        });
      }
      return item as T;
    }
    const answers = {
      applied: shifting("applied", {
        ok: [true, false],
        moved: [[shifting("moved", { runId: ["m", ""], runGeneration: [1, 0], before: ["running", "nowhere"], after: ["unknown_running", "nowhere"] })], null],
        deferred: [[shifting("deferred", { runId: ["d", ""], runGeneration: [2, 0], state: ["preparing", "nowhere"], why: ["start_may_arrive", "because"] })], null],
        outsideLedger: [[shifting("outside", { runId: ["o", ""], runGeneration: [3, 0] })], null],
      }),
      unsaved: shifting("unsaved", {
        ok: [false, true],
        reason: ["ledger_unwritable", "CANARY"],
        unsavedSightings: [[shifting("sighting", { runId: ["s", ""], runGeneration: [4, 0] })], null],
      }),
    };
    const outcome = (answer: unknown) => passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: { applyExecutorAnswer: () => answer } as unknown as HelloAnswerLedger, intake: w.stop });
    expect(outcome(answers.applied)).toMatchObject({
      kind: "applied",
      moved: [{ runId: "m", runGeneration: 1, before: "running", after: "unknown_running" }],
      deferred: [{ runId: "d", runGeneration: 2, state: "preparing", why: "start_may_arrive" }],
      outsideLedger: [{ runId: "o", runGeneration: 3 }],
    });
    expect(outcome(answers.unsaved)).toMatchObject({ kind: "ledger_unsaved", reason: "ledger_unwritable", unsavedSightings: [{ runId: "s", runGeneration: 4 }], withhold: WORKER_EXECUTOR });
    expect(Object.fromEntries(reads)).toEqual(Object.fromEntries([...reads.keys()].map((label) => [label, 1])));
    expect(reads.size).toBe(19);
  });

  test("장부 포트가 던진 일반 예외의 원문은 결과에 싣지 않는다", async () => {
    const ledger = ready(open(tempPath()));
    const w = new World(ledger);
    const { output } = await w.greet(K0, WORKER_EXECUTOR, [], SIGNED, RECEIVED);
    for (const thrown of [new Error("DIAGNOSTIC_CANARY"), "DIAGNOSTIC_CANARY"]) {
      const throwing = {
        applyExecutorAnswer: () => {
          throw thrown;
        },
      } as unknown as HelloAnswerLedger;
      const outcome = passHelloAnswer({ output, table: w.table, now: LATER }, { ledger: throwing, intake: w.stop });
      expect(outcome).toMatchObject({ kind: "ledger_failed", failure: "threw", message: null, withhold: WORKER_EXECUTOR });
      expect(JSON.stringify(outcome)).not.toContain("DIAGNOSTIC_CANARY");
    }
  });
});
