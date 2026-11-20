import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { type Envelope, limits, type NonceStore, rawPublicKey, type RunStatus, sealEnvelope, verifyEnvelope } from "../../../src/contract/v1/index.ts";
import {
  type Checked,
  CLOSE_REASONS,
  type ConnectionSettings,
  Connections,
  type Event,
  OUTPUT_KINDS,
  type Output,
  type ReplyTools,
  type StopGenerationSource,
} from "../../../src/supervisor/transport/connections.ts";
import { handleForward, type ReceiptPorts } from "../../../src/supervisor/dispatch/receipts.ts";
import { type AssignmentContext, eligibleConnections } from "../../../src/supervisor/roles/assign.ts";
import { type ExecutorPeer, type RegistrySettings, RegistryState } from "../../../src/supervisor/transport/registry.ts";

// 키·등록행·대상 표는 이 시험이 지어 넣는 자료다. 키는 실행마다 새로 만든다. 시각은 모두 인자로 준다.
const T = 1_800_000_000_000;
const ANSWER = limits.STOP_SYNC_ANSWER_MAX_MS;
const WAIT = limits.STOP_SYNC_WAIT_MS;

let counter = 0;
const hex32 = () => (++counter).toString(16).padStart(32, "0");
const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;

interface Keys {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly raw: string;
}
function newKeys(): Keys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, raw: rawPublicKey(publicKey) };
}

const SUP = newKeys();
const K1 = newKeys();
const K2 = newKeys();
const KD = newKeys();

const R1 = "executor/isolated_reader/r1/s1";
const R2 = "executor/isolated_reader/r2/s2";
const D1 = "executor/diagnosis/d1/t1";
const RUN = "11111111-1111-4111-8111-111111111111";

const READER: ExecutorPeer = { kind: "executor", namespace: "olive-reader", target: "reader", uri: "spiffe://olive.internal/ns/olive-reader/executor/reader" };
const DIAGNOSIS: ExecutorPeer = {
  kind: "executor",
  namespace: "olive-diagnosis",
  target: "diagnosis",
  uri: "spiffe://olive.internal/ns/olive-diagnosis/executor/diagnosis",
};

const registrySettings: RegistrySettings = {
  environment: "home",
  targets: [
    { target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] },
    { target: "diagnosis", namespace: "olive-diagnosis", roles: ["diagnosis"] },
  ],
};
const row = (keys: Keys, instance: string, storage: string, over: Record<string, unknown> = {}) => ({
  target: "reader",
  role: "isolated_reader",
  instance,
  storage,
  public_key: keys.raw,
  active: true,
  ...over,
});
const ROWS = [row(K1, "r1", "s1"), row(K2, "r2", "s2"), row(KD, "d1", "t1", { target: "diagnosis", role: "diagnosis" })];
function applyDoc(state: RegistryState, revision: number, executors: unknown[]): RegistryState {
  const outcome = state.apply({ kind: "content", content: JSON.stringify({ environment: "home", revision, executors }) });
  expect(outcome.kind).toBe("applied");
  return outcome.state;
}

function nonceStore(): NonceStore & { size(): number } {
  const seen = new Set<string>();
  return {
    consume(sender, nonce) {
      const key = `${sender} ${nonce}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    size: () => seen.size,
  };
}

function restorer(generation: number | null): StopGenerationSource & { generation: number | null } {
  const source = { generation, stopGeneration: () => source.generation };
  return source;
}

const tools: ReplyTools = { seal: (input) => sealEnvelope(input, SUP.privateKey), requestId: uuid, nonce: hex32 };

// ---- 실행기 쪽 봉투(계약 v1의 공개 함수로 실제 서명) ----

function syncRequest(keys: Keys, sender: string, at: number, challenge = hex32()): Envelope {
  return sealEnvelope(
    { sender, recipient: "supervisor", action: "stop_sync_request", request_id: uuid(), stop_generation: 0, run_generation: 0, issued_at: at, nonce: hex32(), body: { challenge } },
    keys.privateKey,
  );
}
function hello(keys: Keys, sender: string, generation: number, at: number, runs: RunStatus[] = []): Envelope {
  return sealEnvelope(
    {
      sender,
      recipient: "supervisor",
      action: "hello",
      request_id: uuid(),
      stop_generation: generation,
      run_generation: 0,
      issued_at: at,
      nonce: hex32(),
      body: { profile_revision: "profile-1", policy_revision: "policy-1", runs, unacked_ids: [] },
    },
    keys.privateKey,
  );
}
function statusReport(keys: Keys, sender: string, generation: number, at: number, runs: RunStatus[], inReplyTo = uuid()): Envelope {
  return sealEnvelope(
    { sender, recipient: "supervisor", action: "status_report", request_id: uuid(), stop_generation: generation, run_generation: 0, issued_at: at, nonce: hex32(), body: { in_reply_to: inReplyTo, runs } },
    keys.privateKey,
  );
}
function receiptStarted(keys: Keys, sender: string, generation: number, at: number): Envelope {
  return sealEnvelope(
    {
      sender,
      recipient: "supervisor",
      action: "receipt_started",
      request_id: uuid(),
      stop_generation: generation,
      run_generation: 1,
      issued_at: at,
      nonce: hex32(),
      body: { receipt_id: uuid(), run_id: RUN, instruction_request_id: uuid(), started_at: at },
    },
    keys.privateKey,
  );
}
const running: RunStatus = { run_id: RUN, state: "running", run_generation: 1, last_receipt_id: null };

// 실행기가 그 답을 받아들이는가(src/executor/link.ts가 넘기는 것과 같은 문맥).
function executorVerifies(reply: Envelope, recipient: string, challenge: string, sentAt: number, now: number) {
  return verifyEnvelope(reply, {
    now,
    expectedRecipient: recipient,
    publicKeyFor: (sender) => (sender === "supervisor" ? SUP.publicKey : undefined),
    stopGeneration: null,
    stopSyncChallenge: { challenge, sentAt },
    runGeneration: () => undefined,
    nonces: nonceStore(),
  });
}

// 감독 쪽: 연결 표 한 값과 문맥을 쥐고 사건을 차례로 넣는다.
class World {
  table: Connections;
  registry = applyDoc(RegistryState.start(registrySettings), 1, ROWS);
  nonces = nonceStore();
  all: Output[] = [];

  constructor(
    public stop: StopGenerationSource & { generation: number | null } = restorer(0),
    settings: ConnectionSettings = {},
  ) {
    this.table = Connections.start(settings);
  }

  open(peer: ExecutorPeer, at: number): number {
    const step = this.table.open(peer, at);
    this.table = step.table;
    this.all.push(...step.outputs);
    return step.id;
  }

  check(id: number, envelope: unknown, at: number): Promise<Checked> {
    return this.table.check(id, envelope, { now: at, registry: this.registry, stop: this.stop, runGeneration: (id) => (id === RUN ? 1 : undefined), nonces: this.nonces });
  }

  step(event: Event, at: number): Output[] {
    const step = this.table.step(event, { now: at, registry: this.registry, stop: this.stop }, tools);
    this.table = step.table;
    this.all.push(...step.outputs);
    return step.outputs;
  }

  async receive(id: number, envelope: unknown, at: number, decideAt = at): Promise<Output[]> {
    return this.step({ kind: "envelope", checked: await this.check(id, envelope, at) }, decideAt);
  }

  // 맞춤 요청을 받아 답을 싣는 데까지. 답 봉투와 challenge를 돌려준다.
  async sync(peer: ExecutorPeer, keys: Keys, principal: string, at: number): Promise<{ id: number; reply: Envelope; challenge: string }> {
    const id = this.open(peer, at);
    const challenge = hex32();
    const out = await this.receive(id, syncRequest(keys, principal, at, challenge), at);
    const send = out.find((o) => o.kind === "send_reply");
    if (send?.kind !== "send_reply") throw new Error(`답이 없다: ${JSON.stringify(out)}`);
    expect(this.step({ kind: "reply_sent", connection: id, at }, at)).toEqual([]);
    return { id, reply: send.envelope, challenge };
  }

  async greet(peer: ExecutorPeer, keys: Keys, principal: string, at: number, runs: RunStatus[] = []): Promise<number> {
    const { id } = await this.sync(peer, keys, principal, at);
    const out = await this.receive(id, hello(keys, principal, this.stop.generation!, at + 1, runs), at + 1);
    expect(out.map((o) => o.kind)).toEqual(["occupancy", "candidate"]);
    return id;
  }
}

const closes = (outputs: Output[]) => outputs.filter((o) => o.kind === "close").map((o) => (o.kind === "close" ? [o.connection, o.reason, o.reject ?? null] : null));
const kinds = (outputs: Output[]) => outputs.map((o) => o.kind);

describe("복원 전 응답 0·알려진 0은 허용", () => {
  test("세대를 모르면 맞춤 요청을 검증하지 않고 답 없이 닫는다", async () => {
    const w = new World(restorer(null));
    const id = w.open(READER, T);
    const out = await w.receive(id, syncRequest(K1, R1, T), T);
    expect(out).toEqual([{ kind: "close", connection: id, reason: "unknown_generation" }]);
    expect(w.nonces.size()).toBe(0);
    expect(w.table.get(id)?.phase).toBe("closed");
    expect(w.all.filter((o) => o.kind === "send_reply")).toEqual([]);
  });

  test("검증 때 알던 세대를 서명하는 순간에 모르면 답하지 않는다", async () => {
    const w = new World(restorer(3));
    const id = w.open(READER, T);
    const checked = await w.check(id, syncRequest(K1, R1, T), T);
    w.stop.generation = null;
    expect(w.step({ kind: "envelope", checked }, T)).toEqual([{ kind: "close", connection: id, reason: "unknown_generation" }]);
  });

  test("알려진 0은 유효한 세대다: 답은 그 연결의 challenge와 주체에 묶이고 실행기가 0을 받아들인다", async () => {
    const w = new World(restorer(0));
    const { id, reply, challenge } = await w.sync(READER, K1, R1, T);
    expect(reply.header.stop_generation).toBe(0);
    expect(reply.header.recipient).toBe(R1);
    expect(reply.body).toEqual({ challenge });
    expect(reply.header.expires_at - reply.header.issued_at).toBeLessThanOrEqual(limits.STOP_SYNC_TTL_MAX_MS);
    const accepted = await executorVerifies(reply, R1, challenge, T, T + 1);
    expect(accepted.ok && accepted.adoptedStopGeneration).toBe(0);
    // 다른 연결의 challenge를 기다리는 실행기는 이 답을 받지 않는다.
    expect(await executorVerifies(reply, R1, hex32(), T, T + 1)).toEqual({ ok: false, reason: "challenge_mismatch" });
    expect(w.table.get(id)?.phase).toBe("answered");
    const out = await w.receive(id, hello(K1, R1, 0, T + 2), T + 2);
    expect(kinds(out)).toEqual(["occupancy", "candidate"]);
  });

  test("답의 세대는 복원기의 지금 값이다", async () => {
    const w = new World(restorer(7));
    const { reply, challenge } = await w.sync(READER, K1, R1, T);
    expect(reply.header.stop_generation).toBe(7);
    const accepted = await executorVerifies(reply, R1, challenge, T, T + 1);
    expect(accepted.ok && accepted.adoptedStopGeneration).toBe(7);
  });
});

describe("5초 응답·25초 대기 정각 거절", () => {
  test("숫자는 계약 v1의 상수다", () => {
    expect(ANSWER).toBe(5_000);
    expect(WAIT).toBe(25_000);
  });

  test("받은 때부터 5초 미만이면 답하고, 5초 정각이면 답하지 않고 닫는다", async () => {
    const w = new World();
    const a = w.open(READER, T);
    const inTime = await w.receive(a, syncRequest(K1, R1, T), T, T + ANSWER - 1);
    expect(inTime.map((o) => (o.kind === "send_reply" ? o.deadline : o.kind))).toEqual([T + ANSWER]);

    const b = w.open(READER, T);
    const late = await w.receive(b, syncRequest(K2, R2, T), T, T + ANSWER);
    expect(late).toEqual([{ kind: "close", connection: b, reason: "answer_late" }]);
  });

  test("답을 실은 시각도 5초 미만이어야 한다", async () => {
    const w = new World();
    const a = w.open(READER, T);
    await w.receive(a, syncRequest(K1, R1, T), T);
    expect(w.step({ kind: "reply_sent", connection: a, at: T + ANSWER - 1 }, T + ANSWER - 1)).toEqual([]);
    expect(w.table.get(a)?.phase).toBe("answered");

    const b = w.open(READER, T);
    await w.receive(b, syncRequest(K2, R2, T), T);
    expect(w.step({ kind: "reply_sent", connection: b, at: T + ANSWER }, T + ANSWER)).toEqual([{ kind: "close", connection: b, reason: "answer_late" }]);
  });

  test("싣지 못한 답은 시간이 흘러 5초 정각에 닫힌다", async () => {
    const w = new World();
    const a = w.open(READER, T);
    await w.receive(a, syncRequest(K1, R1, T), T);
    expect(w.step({ kind: "tick" }, T + ANSWER - 1)).toEqual([]);
    expect(w.step({ kind: "tick" }, T + ANSWER)).toEqual([{ kind: "close", connection: a, reason: "answer_late" }]);
  });

  test("hello는 맞춤 요청을 받은 때부터 25초 미만, 정각이면 닫는다", async () => {
    const w = new World();
    const { id: a } = await w.sync(READER, K1, R1, T);
    expect(kinds(await w.receive(a, hello(K1, R1, 0, T + WAIT - 1), T + WAIT - 1))).toEqual(["occupancy", "candidate"]);

    const { id: b } = await w.sync(READER, K2, R2, T);
    expect(await w.receive(b, hello(K2, R2, 0, T + WAIT), T + WAIT)).toEqual([{ kind: "close", connection: b, reason: "hello_late" }]);

    // 제때 받았어도 판단이 정각에 닿으면 늦은 것이다.
    const { id: c } = await w.sync(DIAGNOSIS, KD, D1, T);
    expect(await w.receive(c, hello(KD, D1, 0, T + WAIT - 1), T + WAIT - 1, T + WAIT)).toEqual([{ kind: "close", connection: c, reason: "hello_late" }]);
  });

  test("hello 없이 25초 정각이 되면 시간이 흘러 닫힌다", async () => {
    const w = new World();
    const { id } = await w.sync(READER, K1, R1, T);
    expect(w.step({ kind: "tick" }, T + WAIT - 1)).toEqual([]);
    expect(w.step({ kind: "tick" }, T + WAIT)).toEqual([{ kind: "close", connection: id, reason: "hello_late" }]);
  });

  test("수명이 지난 맞춤 요청은 계약의 검증이 거절한다", async () => {
    const w = new World();
    const id = w.open(READER, T);
    const out = await w.receive(id, syncRequest(K1, R1, T), T + limits.STOP_SYNC_TTL_MAX_MS);
    expect(out).toEqual([{ kind: "close", connection: id, reason: "rejected", reject: "expired" }]);
  });

  test("hello 대기 한도는 25초보다 길게 둘 수 없다", () => {
    expect(() => Connections.start({ helloWaitMs: WAIT + 1 })).toThrow(TypeError);
    expect(() => Connections.start({ helloWaitMs: 0 })).toThrow(TypeError);
  });
});

describe("맞춤 생략·중복·옛 연결 거절", () => {
  test("맞춤 전의 hello·영수증·보고는 검증하지 않고 닫는다", async () => {
    for (const envelope of [hello(K1, R1, 0, T), statusReport(K1, R1, 0, T, [running]), receiptStarted(K1, R1, 0, T)]) {
      const w = new World();
      const id = w.open(READER, T);
      expect(await w.receive(id, envelope, T)).toEqual([{ kind: "close", connection: id, reason: "out_of_order" }]);
      expect(w.nonces.size()).toBe(0);
    }
  });

  test("맞춘 뒤 hello 전의 영수증·보고와 두 번째 맞춤 요청은 닫는다", async () => {
    for (const make of [() => statusReport(K1, R1, 0, T + 1, [running]), () => receiptStarted(K1, R1, 0, T + 1), () => syncRequest(K1, R1, T + 1)]) {
      const w = new World();
      const { id } = await w.sync(READER, K1, R1, T);
      expect(await w.receive(id, make(), T + 1)).toEqual([{ kind: "close", connection: id, reason: "out_of_order" }]);
      expect(w.table.candidates(w.stop)).toEqual([]);
    }
  });

  test("hello 뒤의 두 번째 hello와 맞춤 요청은 닫는다", async () => {
    for (const make of [() => hello(K1, R1, 0, T + 2), () => syncRequest(K1, R1, T + 2)]) {
      const w = new World();
      const id = await w.greet(READER, K1, R1, T);
      const out = await w.receive(id, make(), T + 2);
      expect(out).toEqual([
        { kind: "withdrawn", connection: id, principal: R1 },
        { kind: "close", connection: id, reason: "out_of_order" },
      ]);
    }
  });

  test("같은 연결에서 동시에 검증한 두 맞춤 요청은 두 번째에서 닫는다", async () => {
    const w = new World();
    const id = w.open(READER, T);
    const first = await w.check(id, syncRequest(K1, R1, T), T);
    const second = await w.check(id, syncRequest(K1, R1, T), T);
    expect(kinds(w.step({ kind: "envelope", checked: first }, T))).toEqual(["send_reply"]);
    expect(w.step({ kind: "envelope", checked: second }, T)).toEqual([{ kind: "close", connection: id, reason: "out_of_order" }]);
  });

  test("다른 연결에서 맞춘 세대의 hello(연결 바꿔 치기)는 닫는다", async () => {
    const w = new World();
    const { id: a } = await w.sync(READER, K1, R1, T);
    const b = w.open(READER, T + 1);
    expect(await w.receive(b, hello(K1, R1, 0, T + 1), T + 1)).toEqual([{ kind: "close", connection: b, reason: "out_of_order" }]);
    expect(w.table.get(a)?.phase).toBe("answered");
    expect(w.table.candidates(w.stop)).toEqual([]);
  });

  test("같은 주체의 새 연결이 맞추면 옛 연결은 닫히고 옛 연결에서 온 것은 버린다", async () => {
    const w = new World();
    const a = await w.greet(READER, K1, R1, T);
    const late = await w.check(a, statusReport(K1, R1, 0, T + 2, [running]), T + 2);
    const b = w.open(READER, T + 3);
    const out = await w.receive(b, syncRequest(K1, R1, T + 3), T + 3);
    expect(kinds(out)).toEqual(["withdrawn", "close", "send_reply"]);
    expect(closes(out)).toEqual([[a, "superseded", null]]);
    expect(w.step({ kind: "envelope", checked: late }, T + 3)).toEqual([]);
    expect(await w.receive(a, statusReport(K1, R1, 0, T + 4, [running]), T + 4)).toEqual([]);
    expect(w.table.candidates(w.stop)).toEqual([]);
    w.step({ kind: "reply_sent", connection: b, at: T + 3 }, T + 3);
    await w.receive(b, hello(K1, R1, 0, T + 4), T + 4);
    expect(w.table.candidates(w.stop).map((c) => c.connection)).toEqual([b]);
  });

  test("먼저 연 연결의 늦은 맞춤 요청은 나중 연결을 밀어내지 못한다", async () => {
    const w = new World();
    const a = w.open(READER, T);
    const b = w.open(READER, T);
    expect(kinds(await w.receive(b, syncRequest(K1, R1, T), T))).toEqual(["send_reply"]);
    expect(await w.receive(a, syncRequest(K1, R1, T), T)).toEqual([{ kind: "close", connection: a, reason: "superseded" }]);
    expect(w.table.get(b)?.phase).toBe("requested");
  });

  test("나중 연결이 인사하고 끊긴 뒤에도 먼저 연 연결의 늦은 맞춤은 superseded다", async () => {
    const w = new World();
    const a = w.open(READER, T);
    const b = await w.greet(READER, K1, R1, T);
    expect(w.step({ kind: "closed", connection: b }, T + 2)).toEqual([{ kind: "withdrawn", connection: b, principal: R1 }]);
    expect(await w.receive(a, syncRequest(K1, R1, T + 2), T + 2)).toEqual([{ kind: "close", connection: a, reason: "superseded" }]);
    expect(w.table.candidates(w.stop)).toEqual([]);
    expect(w.table.occupancy(w.stop)).toEqual([]);
    // 새 연결은 다시 맞출 수 있다.
    const c = await w.greet(READER, K1, R1, T + 3);
    expect(w.table.candidates(w.stop).map((x) => x.connection)).toEqual([c]);
  });

  test("답을 실은 시각보다 먼저 받은 hello는 인정하지 않고, 같은 시각은 사건 순서를 따른다", async () => {
    const w = new World();
    const a = w.open(READER, T);
    await w.receive(a, syncRequest(K1, R1, T), T);
    expect(w.step({ kind: "reply_sent", connection: a, at: T + 10 }, T + 10)).toEqual([]);
    expect(await w.receive(a, hello(K1, R1, 0, T + 9), T + 9, T + 10)).toEqual([{ kind: "close", connection: a, reason: "out_of_order" }]);
    expect(w.table.candidates(w.stop)).toEqual([]);
    expect(w.table.occupancy(w.stop)).toEqual([]);

    const b = w.open(READER, T);
    await w.receive(b, syncRequest(K2, R2, T), T);
    w.step({ kind: "reply_sent", connection: b, at: T + 10 }, T + 10);
    expect(kinds(await w.receive(b, hello(K2, R2, 0, T + 10), T + 10))).toEqual(["occupancy", "candidate"]);
  });

  test("닫혀 지운 연결의 늦은 검증 결과는 버린다", async () => {
    const w = new World();
    const id = w.open(READER, T);
    const checked = await w.check(id, syncRequest(K1, R1, T), T);
    expect(w.step({ kind: "closed", connection: id }, T)).toEqual([]);
    expect(w.step({ kind: "envelope", checked }, T)).toEqual([]);
    expect(w.table.get(id)).toBeUndefined();
    expect(w.open(READER, T)).not.toBe(id);
  });
});

describe("hello 누락 때 full 행 0", () => {
  test("맞춤에 답했어도 hello가 없으면 full 행이 없고 후보도 아니다", async () => {
    const w = new World();
    await w.sync(READER, K1, R1, T);
    expect(w.table.occupancy(w.stop)).toEqual([]);
    expect(w.table.candidates(w.stop)).toEqual([]);
    expect(w.all.filter((o) => o.kind === "occupancy" || o.kind === "candidate")).toEqual([]);
  });

  test("hello는 full 행 하나다: 빈 목록은 쥔 것이 없다는 답이다", async () => {
    const w = new World();
    const id = await w.greet(READER, K1, R1, T);
    expect(w.all.filter((o) => o.kind === "occupancy")).toEqual([{ kind: "occupancy", connection: id, answer: { executorId: R1, coverage: "full", runs: [] } }]);
    expect(w.table.occupancy(w.stop)).toEqual([{ executorId: R1, coverage: "full", runs: [] }]);
  });

  test("status_report는 partial이고 full 행을 늘리지 않는다", async () => {
    const w = new World();
    const id = await w.greet(READER, K1, R1, T, [running]);
    const out = await w.receive(id, statusReport(K1, R1, 0, T + 2, [running]), T + 2);
    expect(out.filter((o) => o.kind !== "forward")).toEqual([{ kind: "occupancy", connection: id, answer: { executorId: R1, coverage: "partial", runs: [running] } }]);
    expect(kinds(out)).toEqual(["occupancy", "forward"]);
    expect(w.table.occupancy(w.stop)).toEqual([{ executorId: R1, coverage: "full", runs: [running] }]);
  });

  test("다른 복원기로 답한 맞춤의 hello는 이번 복원의 full 행이 아니다", async () => {
    const w = new World();
    const old = w.stop;
    const { id } = await w.sync(READER, K1, R1, T);
    w.stop = restorer(0);
    expect(await w.receive(id, hello(K1, R1, 0, T + 1), T + 1)).toEqual([{ kind: "close", connection: id, reason: "restore_changed" }]);
    expect(w.table.occupancy(w.stop)).toEqual([]);
    expect(w.table.occupancy(old)).toEqual([]);
  });

  test("복원을 다시 하면 앞 복원에서 인사한 연결은 시간이 흐를 때 닫힌다", async () => {
    const w = new World();
    const id = await w.greet(READER, K1, R1, T);
    w.stop = restorer(0);
    expect(w.table.occupancy(w.stop)).toEqual([]);
    expect(w.step({ kind: "tick" }, T + 2)).toEqual([
      { kind: "withdrawn", connection: id, principal: R1 },
      { kind: "close", connection: id, reason: "restore_changed" },
    ]);
  });

  test("인사한 뒤 새 정지로 세대가 오르면 연결을 두고 새 세대의 영수증만 넘긴다", async () => {
    const w = new World();
    const id = await w.greet(READER, K1, R1, T, [running]);
    w.stop.generation = 1;
    expect(w.step({ kind: "tick" }, T + 2)).toEqual([]);
    expect(kinds(await w.receive(id, receiptStarted(K1, R1, 1, T + 2), T + 2))).toEqual(["forward"]);
    expect(closes(await w.receive(id, receiptStarted(K1, R1, 0, T + 3), T + 3))).toEqual([[id, "rejected", "stop_generation_mismatch"]]);
  });

  test("맞춘 뒤 hello 전에 세대가 오르면 그 hello는 받지 않는다", async () => {
    const w = new World();
    const { id } = await w.sync(READER, K1, R1, T);
    const checked = await w.check(id, hello(K1, R1, 0, T + 1), T + 1);
    w.stop.generation = 1;
    expect(w.step({ kind: "envelope", checked }, T + 1)).toEqual([{ kind: "close", connection: id, reason: "restore_changed" }]);
  });

  test("hello 뒤의 영수증은 뒤 조각의 처리기로 넘길 뿐이다", async () => {
    const w = new World();
    const id = await w.greet(READER, K1, R1, T);
    const out = await w.receive(id, receiptStarted(K1, R1, 0, T + 2), T + 2);
    expect(out.map((o) => (o.kind === "forward" ? [o.connection, o.verified.action, o.verified.header.sender] : o.kind))).toEqual([[id, "receipt_started", R1]]);
  });
});

describe("이번 복원에서 인사한 연결만 후보다", () => {
  const job = { role: "isolated_reader" } as const;
  const assignment = (keyId: string): AssignmentContext => ({
    allowed: [{ target: "reader", roles: ["isolated_reader"] }],
    registrations: [{ target: "reader", role: "isolated_reader", instance: "r1", storage: "s1", keyId, active: true }],
    expected: { profile_revision: "profile-1", policy_revision: "policy-1" },
  });

  test("복원기를 바꾼 직후 첫 tick 전에도 앞 복원의 인사는 후보·full 행·배정 후보가 아니다", async () => {
    const w = new World();
    const old = w.stop;
    const a = await w.greet(READER, K1, R1, T, [running]);
    const d = await w.greet(DIAGNOSIS, KD, D1, T);
    const reader = w.table.candidates(old).find((c) => c.target === "reader");
    const ctx = assignment(reader!.keyId);
    expect(eligibleConnections(job, w.table.candidates(old), ctx)).toHaveLength(1);

    w.stop = restorer(0);
    expect(w.table.candidates(w.stop)).toEqual([]);
    expect(w.table.occupancy(w.stop)).toEqual([]);
    expect(eligibleConnections(job, w.table.candidates(w.stop), ctx)).toEqual([]);

    // 새 복원에서 맞춤과 인사를 다시 한 연결만 후보다. 다시 인사하지 않은 d는 후보가 아니고 tick에서 닫힌다.
    const b = await w.greet(READER, K1, R1, T + 2, [running]);
    expect(closes(w.all)).toEqual([[a, "superseded", null]]);
    expect(w.table.candidates(w.stop).map((c) => c.connection)).toEqual([b]);
    expect(w.table.occupancy(w.stop)).toEqual([{ executorId: R1, coverage: "full", runs: [running] }]);
    expect(eligibleConnections(job, w.table.candidates(w.stop), ctx)).toHaveLength(1);
    expect(w.step({ kind: "tick" }, T + 4)).toEqual([
      { kind: "withdrawn", connection: d, principal: D1 },
      { kind: "close", connection: d, reason: "restore_changed" },
    ]);
  });

  test("같은 복원기가 세대를 모르게 되면 첫 tick 전에도 후보·full 행이 없다", async () => {
    const w = new World();
    const id = await w.greet(READER, K1, R1, T, [running]);
    w.stop.generation = null;
    expect(w.table.candidates(w.stop)).toEqual([]);
    expect(w.table.occupancy(w.stop)).toEqual([]);
    expect(w.step({ kind: "tick" }, T + 2)).toEqual([
      { kind: "withdrawn", connection: id, principal: R1 },
      { kind: "close", connection: id, reason: "restore_changed" },
    ]);
  });

  test("인사한 뒤 새 정지로 세대가 오른 연결은 후보와 full 행으로 남는다", async () => {
    const w = new World();
    const id = await w.greet(READER, K1, R1, T, [running]);
    w.stop.generation = 1;
    expect(w.table.candidates(w.stop).map((c) => c.connection)).toEqual([id]);
    expect(w.table.occupancy(w.stop)).toEqual([{ executorId: R1, coverage: "full", runs: [running] }]);
  });
});

describe("공개 조회는 보관한 값을 바꾸게 두지 않는다", () => {
  test("인사의 실행 목록과 각 항목은 동결되어 있다", async () => {
    const w = new World();
    const id = await w.greet(READER, K1, R1, T, [running]);
    const greeting = w.table.get(id)!.greeting!;
    expect(Object.isFrozen(greeting.runs)).toBe(true);
    expect(Object.isFrozen(greeting.runs[0])).toBe(true);
    expect(() => {
      (greeting.runs[0] as { state: string }).state = "finished";
    }).toThrow(TypeError);
    expect(() => (greeting.runs as RunStatus[]).push(running)).toThrow(TypeError);
    expect(w.table.occupancy(w.stop)).toEqual([{ executorId: R1, coverage: "full", runs: [running] }]);
  });
});

describe("연결 하나가 닫히는 것은 그 주체에 대한 사실일 뿐이다", () => {
  test("닫힌 연결의 주체만 후보에서 빠지고 다른 주체·다른 연결은 그대로다", async () => {
    const w = new World();
    const a = await w.greet(READER, K1, R1, T, [running]);
    const d = await w.greet(DIAGNOSIS, KD, D1, T);
    expect(w.step({ kind: "closed", connection: a }, T + 5)).toEqual([{ kind: "withdrawn", connection: a, principal: R1 }]);
    expect(w.table.candidates(w.stop).map((c) => [c.connection, c.target])).toEqual([[d, "diagnosis"]]);
    expect(w.table.occupancy(w.stop)).toEqual([{ executorId: D1, coverage: "full", runs: [] }]);
  });
});

describe("역할 바꿈과 신원 대조", () => {
  test("등록된 키로 다른 역할의 이름을 쓴 hello는 거절한다", async () => {
    const w = new World();
    const { id } = await w.sync(READER, K1, R1, T);
    const out = await w.receive(id, hello(K1, "executor/diagnosis/r1/s1", 0, T + 1), T + 1);
    expect(out).toEqual([{ kind: "close", connection: id, reason: "rejected", reject: "unknown_sender" }]);
  });

  test("TLS가 확인한 배포 대상과 등록행의 대상이 다르면 맞춤 요청부터 거절한다", async () => {
    const w = new World();
    const id = w.open(DIAGNOSIS, T);
    expect(await w.receive(id, syncRequest(K1, R1, T), T)).toEqual([{ kind: "close", connection: id, reason: "rejected", reject: "unknown_sender" }]);
  });

  test("맞춤 요청과 다른 등록 주체가 서명한 hello는 거절한다", async () => {
    const w = new World();
    const { id } = await w.sync(READER, K1, R1, T);
    expect(await w.receive(id, hello(K2, R2, 0, T + 1), T + 1)).toEqual([{ kind: "close", connection: id, reason: "principal_mismatch" }]);
  });

  test("후보는 TLS 대상·검증한 주체·키 식별·hello의 revision만 싣는다", async () => {
    const w = new World();
    await w.greet(READER, K1, R1, T);
    const [candidate] = w.table.candidates(w.stop);
    expect(Object.keys(candidate!).sort()).toEqual(["connection", "hello", "keyId", "principal", "target"]);
    expect(candidate!.principal).toEqual({ kind: "worker_executor", role: "isolated_reader", instance: "r1", storage: "s1" });
    expect(candidate!.hello).toEqual({ profile_revision: "profile-1", policy_revision: "policy-1" });
  });
});

describe("등록표 교체 뒤의 무효", () => {
  test("주체가 비활성이 된 판을 적용하면 그 연결을 닫는다", async () => {
    const w = new World();
    const a = await w.greet(READER, K1, R1, T);
    const d = await w.greet(DIAGNOSIS, KD, D1, T);
    w.registry = applyDoc(w.registry, 2, [row(K1, "r1", "s1", { active: false }), ROWS[1], ROWS[2]]);
    expect(w.step({ kind: "registry" }, T + 5)).toEqual([
      { kind: "withdrawn", connection: a, principal: R1 },
      { kind: "close", connection: a, reason: "registry" },
    ]);
    expect(w.table.candidates(w.stop).map((c) => c.connection)).toEqual([d]);
  });

  test("키가 바뀐 판도 옛 키로 맞춘 연결을 무효로 한다", async () => {
    const w = new World();
    const a = await w.greet(READER, K1, R1, T);
    w.registry = applyDoc(w.registry, 2, [row(newKeys(), "r1", "s1"), ROWS[1], ROWS[2]]);
    expect(closes(w.step({ kind: "registry" }, T + 5))).toEqual([[a, "registry", null]]);
  });

  test("적용에 실패해 아무도 믿지 않으면 모든 연결을 닫는다", async () => {
    const w = new World();
    const a = await w.greet(READER, K1, R1, T);
    const b = w.open(READER, T);
    const outcome = w.registry.apply({ kind: "unreadable" });
    w.registry = outcome.state;
    expect(closes(w.step({ kind: "registry" }, T + 5))).toEqual([[a, "registry", null]]);
    // 맞춤 전 연결은 다음 봉투를 새 판으로 검증할 때 거절된다.
    expect(await w.receive(b, syncRequest(K1, R1, T + 5), T + 5)).toEqual([{ kind: "close", connection: b, reason: "rejected", reject: "unknown_sender" }]);
  });

  test("검증한 뒤 판단 전에 판이 바뀌면 그 봉투를 쓰지 않고 닫는다", async () => {
    const w = new World();
    const { id } = await w.sync(READER, K1, R1, T);
    const checked = await w.check(id, hello(K1, R1, 0, T + 1), T + 1);
    w.registry = applyDoc(w.registry, 2, [ROWS[1], ROWS[2]]);
    expect(w.step({ kind: "envelope", checked }, T + 1)).toEqual([{ kind: "close", connection: id, reason: "registry" }]);
  });

  test("내용이 같은 새 판은 연결을 그대로 둔다", async () => {
    const w = new World();
    await w.greet(READER, K1, R1, T);
    w.registry = applyDoc(w.registry, 2, ROWS);
    expect(w.step({ kind: "registry" }, T + 5)).toEqual([]);
    expect(w.table.candidates(w.stop)).toHaveLength(1);
  });
});

describe("조회의 답은 영수증 처리기가 대조할 수 있는 꼴로도 나간다", () => {
  // 상태 보고는 영수증·보고 연산을 부르지 않고, 대조된 답만 applyExecutorAnswer에 닿는다. 불린 것을 모두 기록한다.
  const ledgerCalls: string[] = [];
  const answers: unknown[] = [];
  const ports: ReceiptPorts = {
    ledger: {
      applyReceipt: () => {
        ledgerCalls.push("applyReceipt");
        throw new Error("상태 보고가 영수증 연산을 불렀다");
      },
      recordReport: () => {
        ledgerCalls.push("recordReport");
        throw new Error("상태 보고가 보고 연산을 불렀다");
      },
      applyExecutorAnswer: (input, from) => {
        answers.push({ input, from });
        return { ok: true, moved: [], deferred: [], outsideLedger: [] };
      },
    },
    random: { bytes: (length) => new Uint8Array(length) },
  };
  const forwardOf = (outputs: Output[]) => {
    const found = outputs.filter((o) => o.kind === "forward");
    expect(found).toHaveLength(1);
    const forward = found[0]!;
    if (forward.kind !== "forward") throw new Error("forward가 아니다");
    return forward;
  };

  test("인사한 연결의 status_report는 점유 행 뒤에 forward로도 나가고, 그 꼴로 기다리는 조회와 대조된다", async () => {
    const w = new World();
    const id = await w.greet(READER, K1, R1, T, [running]);
    const query = uuid();
    const out = await w.receive(id, statusReport(K1, R1, 0, T + 2, [running], query), T + 2);
    expect(kinds(out)).toEqual(["occupancy", "forward"]);
    const forward = forwardOf(out);
    expect(forward.connection).toBe(id);
    if (!forward.verified.ok || forward.verified.action !== "status_report") throw new Error("검증된 status_report가 아니다");
    expect([forward.verified.header.sender, forward.verified.header.run_generation, forward.verified.header.stop_generation]).toEqual([R1, 0, 0]);
    expect(forward.verified.body).toEqual({ in_reply_to: query, runs: [running] });

    const pending = [{ requestId: query, recipient: R1, runIds: [RUN] }];
    // 지금 인정된 연결은 이 연결 하나다. now는 봉투의 issued_at(T + 2)과 다르게 둔다(answeredAt이 받은 시각이 아님을 가른다).
    const links = { current: (connection: number, executor: string) => connection === id && executor === R1 };
    expect(handleForward({ forward, now: T + 3, stopGeneration: 0, pendingQueries: pending, links, backlog: [] }, ports)).toEqual({
      outcome: "status_matched",
      queryRequestId: query,
      executor: R1,
      connection: id,
      settled: [{ settled: "applied", answer: { sender: R1, coverage: "partial", runs: [running], answeredAt: T + 2 }, moved: [], deferred: [], outsideLedger: [] }],
      backlog: [],
    });
    expect(answers).toEqual([{ input: { coverage: "partial", runs: [running], answeredAt: T + 2, now: T + 3 }, from: { sender: R1 } }]);
    // 맞지 않은 두 답은 장부를 부르지 않는다(applyExecutorAnswer 기록이 늘지 않는다).
    expect(handleForward({ forward, now: T + 3, stopGeneration: 0, pendingQueries: [], links, backlog: [] }, ports)).toEqual({ outcome: "status_unmatched", reason: "unknown_query" });
    expect(handleForward({ forward, now: T + 3, stopGeneration: 0, pendingQueries: [{ ...pending[0]!, requestId: uuid() }], links, backlog: [] }, ports)).toEqual({
      outcome: "status_unmatched",
      reason: "unknown_query",
    });
    expect(answers).toHaveLength(1);
    expect(ledgerCalls).toEqual([]);
  });

  test("status_report는 full 행·후보·인사의 실행 목록을 바꾸지 않는다", async () => {
    const w = new World();
    const id = await w.greet(READER, K1, R1, T, [running]);
    const before = { candidates: w.table.candidates(w.stop), occupancy: w.table.occupancy(w.stop), greeting: w.table.get(id)!.greeting };
    const gone: RunStatus = { run_id: RUN, state: "not_known", run_generation: null, last_receipt_id: null };
    const out = await w.receive(id, statusReport(K1, R1, 0, T + 2, [gone]), T + 2);
    expect(out.filter((o) => o.kind === "occupancy")).toEqual([{ kind: "occupancy", connection: id, answer: { executorId: R1, coverage: "partial", runs: [gone] } }]);
    expect(w.table.occupancy(w.stop)).toEqual(before.occupancy);
    expect(w.table.occupancy(w.stop)).toEqual([{ executorId: R1, coverage: "full", runs: [running] }]);
    expect(w.table.candidates(w.stop)).toEqual(before.candidates);
    expect(w.table.get(id)!.greeting).toBe(before.greeting);
  });

  test("맞춤·인사 전 연결의 status_report는 검증 없이 닫고 넘기지 않는다", async () => {
    const w = new World();
    const fresh = w.open(READER, T);
    expect(await w.receive(fresh, statusReport(K1, R1, 0, T, [running]), T)).toEqual([{ kind: "close", connection: fresh, reason: "out_of_order" }]);
    const { id: synced } = await w.sync(READER, K2, R2, T);
    expect(await w.receive(synced, statusReport(K2, R2, 0, T + 1, [running]), T + 1)).toEqual([{ kind: "close", connection: synced, reason: "out_of_order" }]);
    expect(w.nonces.size()).toBe(1);
    expect(w.all.filter((o) => o.kind === "forward" || o.kind === "occupancy")).toEqual([]);
  });

  test("옛 복원에서 인사한 연결의 status_report는 닫고 넘기지 않는다", async () => {
    const w = new World();
    const id = await w.greet(READER, K1, R1, T, [running]);
    w.stop = restorer(0);
    expect(await w.receive(id, statusReport(K1, R1, 0, T + 2, [running]), T + 2)).toEqual([
      { kind: "withdrawn", connection: id, principal: R1 },
      { kind: "close", connection: id, reason: "restore_changed" },
    ]);
  });

  test("닫는 중·닫힌 연결과 밀려난 연결의 status_report는 버린다", async () => {
    const w = new World();
    const a = await w.greet(READER, K1, R1, T, [running]);
    // 검증하는 사이에 그 연결이 닫혔다(세대를 모르게 되어 tick이 닫음). 늦게 끝난 검증 결과는 버린다.
    const late = await w.check(a, statusReport(K1, R1, 0, T + 2, [running]), T + 2);
    w.stop.generation = null;
    expect(kinds(w.step({ kind: "tick" }, T + 2))).toEqual(["withdrawn", "close"]);
    w.stop.generation = 0;
    expect(w.step({ kind: "envelope", checked: late }, T + 2)).toEqual([]);
    expect(await w.receive(a, statusReport(K1, R1, 0, T + 3, [running]), T + 3)).toEqual([]);

    // 같은 주체의 나중 연결이 맞추면 앞 연결은 밀려난다. 앞 연결에서 온 보고는 버린다.
    const w2 = new World();
    const old = await w2.greet(READER, K1, R1, T, [running]);
    const now = await w2.greet(READER, K1, R1, T + 2, [running]);
    expect(closes(w2.all)).toEqual([[old, "superseded", null]]);
    expect(await w2.receive(old, statusReport(K1, R1, 0, T + 4, [running]), T + 4)).toEqual([]);
    expect(kinds(await w2.receive(now, statusReport(K1, R1, 0, T + 5, [running]), T + 5))).toEqual(["occupancy", "forward"]);
  });
});

describe("맞춤과 인사는 권한이 아니다", () => {
  test("낼 것의 종류는 답·닫기·점유 행·후보 표시·후보 빠짐·넘기기뿐이다", async () => {
    expect([...OUTPUT_KINDS]).toEqual(["send_reply", "close", "occupancy", "candidate", "withdrawn", "forward"]);
    const w = new World();
    const id = await w.greet(READER, K1, R1, T, [running]);
    await w.receive(id, statusReport(K1, R1, 0, T + 2, [running]), T + 2);
    await w.receive(id, receiptStarted(K1, R1, 0, T + 3), T + 3);
    w.step({ kind: "closed", connection: id }, T + 4);
    expect(new Set(kinds(w.all))).toEqual(new Set(["send_reply", "occupancy", "candidate", "forward", "withdrawn"]));
    expect(CLOSE_REASONS).not.toContain("intake");
  });
});

describe("처리량 제한의 자리(값은 미확정)", () => {
  test("기본은 연결 수·재접속에 제한이 없다", () => {
    const w = new World();
    for (let i = 0; i < 5; i++) w.open(READER, T);
    expect(closes(w.all)).toEqual([]);
  });

  test("같은 TLS 신원의 재접속을 창 안에서 설정한 수까지만 받는다", () => {
    const w = new World(restorer(0), { reconnect: { windowMs: 1_000, max: 2 } });
    w.open(READER, T);
    w.open(READER, T + 1);
    const third = w.open(READER, T + 999);
    expect(closes(w.all)).toEqual([[third, "throttled", null]]);
    expect(w.open(DIAGNOSIS, T + 999)).toBeGreaterThan(third);
    w.open(READER, T + 1_000);
    expect(closes(w.all)).toHaveLength(1);
  });

  test("열린 연결 수의 상한을 넘는 연결은 연 즉시 닫는다", () => {
    const w = new World(restorer(0), { maxConnections: 1 });
    const first = w.open(READER, T);
    const second = w.open(DIAGNOSIS, T);
    expect(closes(w.all)).toEqual([[second, "connection_limit", null]]);
    w.step({ kind: "closed", connection: first }, T);
    w.open(DIAGNOSIS, T);
    expect(closes(w.all)).toHaveLength(1);
  });

  test("틀린 설정은 시작할 때 던진다", () => {
    expect(() => Connections.start({ maxConnections: 0 })).toThrow(TypeError);
    expect(() => Connections.start({ reconnect: { windowMs: 1_000, max: 0 } })).toThrow(TypeError);
  });
});
