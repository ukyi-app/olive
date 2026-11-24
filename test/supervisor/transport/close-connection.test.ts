// 연결 서버의 closeConnection. 루프백(127.0.0.1, 운영체제가 고르는 포트)의 실제 상호 TLS로 돈다. 인증서는 메모리에서 만들고
// 봉투는 계약 v1로 실제 서명한다. 기다리는 것은 소켓·서버의 사건뿐이다.
// 앞 묶음은 서버 하나와 시험이 쥔 포트(nonce 저장소를 붙잡기, 하위 쓰기를 붙들기)로 닫기와 겹치는 일을 본다.
// 끝 시험은 서버의 deliver를 실제 답 줄·조회 등록부·임시 장부에 잇고, 닫은 뒤 실행기 흉내가 다시 붙어 새 hello를 보내는 길을 본다.
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type * as tls from "node:tls";
import { type Envelope, limits, type NonceStore, rawPublicKey, type RunStatus, sealEnvelope } from "../../../src/contract/v1/index.ts";
import { sealDraft, statusQueryDraft } from "../../../src/supervisor/dispatch/envelopes.ts";
import type { ReceiptLedger } from "../../../src/supervisor/dispatch/receipts.ts";
import { createAnswerLines } from "../../../src/supervisor/runtime/answers.ts";
import { createQueryBook } from "../../../src/supervisor/runtime/query-book.ts";
import { createWireSink } from "../../../src/supervisor/runtime/sink.ts";
import { RegistryState } from "../../../src/supervisor/transport/registry.ts";
import { type ConnectionServer, type Delivered, type SendEnd, type ServerNote, startConnectionServer } from "../../../src/supervisor/transport/server.ts";
import { createFrameDecoder, encodeFrame } from "../../../src/transport/framing.ts";
import { createTlsClient } from "../../../src/transport/tls-client.ts";
import { grant, open, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";
import { makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../../transport/certs.ts";

const HOST = "127.0.0.1";
const GEN = 3;
const pki = makePki();
const material = (leaf: { pem: string; keyPem: string }) => ({ certificatePem: leaf.pem, privateKeyPem: leaf.keyPem, trustBundlePem: pki.ca.pem });

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("기다리던 상태가 오지 않았다");
    await Bun.sleep(5);
  }
}

function keys(): { privateKey: KeyObject; raw: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, raw: rawPublicKey(publicKey) };
}

let counter = 0;
const hex32 = () => (++counter).toString(16).padStart(32, "0");
const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;

function frameOf(envelope: unknown): Uint8Array {
  const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(envelope)));
  if (!encoded.ok) throw new Error(encoded.reason);
  return encoded.frame;
}

// ---- 서버 하나와 붙잡을 수 있는 포트 ----

const SUP = keys();
const K1 = keys();
const K2 = keys();
const R1 = "executor/isolated_reader/r1/s1";
const R2 = "executor/isolated_reader/r2/s2";
const RUN = "11111111-1111-4111-8111-111111111111";
const running: RunStatus = { run_id: RUN, state: "running", run_generation: 1, last_receipt_id: null };
const row = (k: { raw: string }, instance: string, storage: string) => ({ target: "reader", role: "isolated_reader", instance, storage, public_key: k.raw, active: true });

function firstRegistry(): RegistryState {
  const content = new TextEncoder().encode(JSON.stringify({ environment: "home", revision: 1, executors: [row(K1, "r1", "s1"), row(K2, "r2", "s2")] }));
  const outcome = RegistryState.start({ environment: "home", targets: [{ target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] }] }).apply({ kind: "content", content });
  if (outcome.kind !== "applied") throw new Error("시험 등록표가 적용되지 않았다");
  return outcome.state;
}

function seal(k: { privateKey: KeyObject }, sender: string, action: string, generation: number, at: number, body: unknown): Envelope {
  return sealEnvelope(
    { sender, recipient: "supervisor", action, request_id: uuid(), stop_generation: generation, run_generation: 0, issued_at: at, nonce: hex32(), body } as never,
    k.privateKey,
  );
}

type ServerSocket = tls.TLSSocket & { _write(chunk: unknown, encoding: string, done: (error?: Error | null) => void): void };

interface Harness {
  readonly server: ConnectionServer;
  readonly t: number;
  readonly delivered: Delivered[];
  readonly notes: ServerNote[];
  // 다음 nonce 소비 하나를 release까지 붙잡는다.
  hold(): { entered: () => boolean; release: () => void };
  onDeliver: (output: Delivered) => void;
  onNote: (note: ServerNote) => void;
  closedNotes(id: number): ServerNote[];
  withdrawnOf(id: number): Delivered[];
  socketOf(id: number): ServerSocket;
  stop(): Promise<void>;
}

async function start(): Promise<Harness> {
  const t = Date.now();
  const delivered: Delivered[] = [];
  const notes: ServerNote[] = [];
  const seen = new Set<string>();
  const restorer = { stopGeneration: () => GEN };
  let armed: { entered: boolean; promise: Promise<void> } | null = null;
  const nonces: NonceStore = {
    consume(sender, nonce) {
      const key = `${sender} ${nonce}`;
      const fresh = !seen.has(key);
      seen.add(key);
      const gate = armed;
      if (gate === null) return fresh;
      armed = null;
      gate.entered = true;
      return gate.promise.then(() => fresh);
    },
  };
  const h = { t, delivered, notes, onDeliver: (_: Delivered) => {}, onNote: (_: ServerNote) => {} } as unknown as Harness & { onDeliver: (o: Delivered) => void };
  const result = await startConnectionServer({
    host: HOST,
    port: 0,
    material: material(pki.supervisor()),
    clock: () => t,
    registry: firstRegistry(),
    // 판단은 맞춤에 답한 복원기와 지금의 복원기를 객체로 견준다. 부를 때마다 같은 객체를 돌려준다.
    restorer: () => restorer,
    runGeneration: () => undefined,
    nonces,
    reply: { seal: (input) => sealEnvelope(input, SUP.privateKey), requestId: uuid, nonce: hex32 },
    deliver: (output) => {
      delivered.push(output);
      h.onDeliver(output);
    },
    observe: (note) => {
      notes.push(note);
      h.onNote(note);
    },
    maxPendingWriteBytes: limits.MAX_MESSAGE_BYTES,
  });
  if (!result.ok) throw new Error(`서버가 시작하지 않았다: ${result.failure.kind}`);
  const server = result.server;
  let closing: Promise<void> | null = null;
  const stop = () => (closing ??= server.close());
  cleanup.push(stop);
  return Object.assign(h, {
    server,
    stop,
    hold() {
      let release!: () => void;
      const gate = { entered: false, promise: new Promise<void>((resolve) => (release = resolve)) };
      armed = gate;
      return { entered: () => gate.entered, release };
    },
    closedNotes: (id: number) => notes.filter((n) => n.kind === "closed" && n.connection === id),
    withdrawnOf: (id: number) => delivered.filter((o) => o.kind === "withdrawn" && o.connection === id),
    // 서버 쪽 소켓(서버의 내부 표를 읽는다). 하위 쓰기를 붙드는 데만 쓴다.
    socketOf: (id: number) => (server as unknown as { links: Map<number, { socket: ServerSocket }> }).links.get(id)!.socket,
  });
}

interface Peer {
  readonly id: number;
  readonly frames: Envelope[];
  closed(): boolean;
  send(envelope: Envelope): void;
}

async function connect(h: Harness): Promise<Peer> {
  const client = createTlsClient({ address: HOST, port: h.server.port, supervisorDnsName: SUPERVISOR_DNS, supervisorUri: SUPERVISOR_URI, material: material(pki.executor()), now: Date.now });
  cleanup.push(() => client.close());
  const before = h.notes.filter((n) => n.kind === "opened").length;
  const socket = (await client.connect()).socket;
  socket.on("error", () => {});
  const frames: Envelope[] = [];
  const decoder = createFrameDecoder();
  socket.on("data", (chunk: Buffer) => {
    for (const envelope of decoder.push(new Uint8Array(chunk)).envelopes) frames.push(envelope.value as Envelope);
  });
  let closed = false;
  socket.once("close", () => (closed = true));
  await until(() => h.notes.filter((n) => n.kind === "opened").length > before);
  const opened = h.notes.filter((n) => n.kind === "opened").at(-1) as Extract<ServerNote, { kind: "opened" }>;
  return { id: opened.connection, frames, closed: () => closed, send: (envelope) => socket.write(frameOf(envelope)) };
}

async function greet(h: Harness, k: { privateKey: KeyObject }, sender: string): Promise<Peer> {
  const peer = await connect(h);
  peer.send(seal(k, sender, "stop_sync_request", 0, h.t, { challenge: hex32() }));
  await until(() => peer.frames.length === 1);
  peer.send(seal(k, sender, "hello", GEN, h.t, { profile_revision: "profile-1", policy_revision: "policy-1", runs: [], unacked_ids: [] }));
  await until(() => h.server.table().get(peer.id)?.phase === "greeted");
  return peer;
}

describe("closeConnection", () => {
  test("지금 쥔 연결만 닫는다: 없는 번호는 아무것도 하지 않고, 닫은 연결은 돌아올 때 이미 판단에서 빠져 철회가 전달됐으며, 두 번째 부름은 not_open이다", async () => {
    const h = await start();
    const one = await greet(h, K1, R1);
    const two = await greet(h, K2, R2);
    const notesBefore = h.notes.length;
    const deliveredBefore = h.delivered.length;
    expect(h.server.closeConnection(two.id + 100)).toEqual({ kind: "not_open" });
    expect(h.notes.length).toBe(notesBefore);
    expect(h.delivered.length).toBe(deliveredBefore);

    expect(h.server.closeConnection(one.id)).toEqual({ kind: "closed" });
    // 소켓의 close 사건을 기다리지 않고 같은 호출 안에서 정상 끊김의 처리가 끝났다.
    expect(h.closedNotes(one.id)).toEqual([{ kind: "closed", connection: one.id, cause: "requested" }]);
    expect(h.withdrawnOf(one.id)).toEqual([{ kind: "withdrawn", connection: one.id, principal: R1 }]);
    expect(h.server.table().get(one.id)).toBeUndefined();
    expect(h.server.recognized(R1)).toBeNull();
    // 다른 연결은 그대로다.
    expect(h.server.recognized(R2)).toBe(two.id);

    expect(h.server.closeConnection(one.id)).toEqual({ kind: "not_open" });
    await until(() => one.closed());
    // 소켓의 늦은 close 사건도 두 번째 닫힘·철회를 만들지 않는다.
    expect(h.closedNotes(one.id).length).toBe(1);
    expect(h.withdrawnOf(one.id).length).toBe(1);
    expect(two.closed()).toBe(false);
  });

  test("닫힘이 전하는 철회 안에서 같은 번호를 다시 부르면 not_open이고 닫힘·철회는 한 번이다", async () => {
    const h = await start();
    const one = await greet(h, K1, R1);
    const inner: unknown[] = [];
    h.onDeliver = (output) => {
      if (output.kind === "withdrawn" && output.connection === one.id) inner.push(h.server.closeConnection(one.id));
    };
    expect(h.server.closeConnection(one.id)).toEqual({ kind: "closed" });
    expect(inner).toEqual([{ kind: "not_open" }]);
    expect(h.closedNotes(one.id).length).toBe(1);
    expect(h.withdrawnOf(one.id).length).toBe(1);
  });

  test("서버를 닫기 시작하면 남은 연결에도 stopping을 돌려주고 닫지 않는다(그 연결은 close()가 shutdown으로 닫는다)", async () => {
    const h = await start();
    const one = await greet(h, K1, R1);
    const two = await greet(h, K2, R2);
    const during: unknown[] = [];
    h.onNote = (note) => {
      if (note.kind === "closed" && note.connection === one.id) during.push(h.server.closeConnection(two.id));
    };
    await h.stop();
    expect(during).toEqual([{ kind: "stopping" }]);
    expect(h.closedNotes(two.id)).toEqual([{ kind: "closed", connection: two.id, cause: "shutdown" }]);
    expect(h.server.closeConnection(two.id)).toEqual({ kind: "stopping" });
    expect(h.server.closeConnection(one.id)).toEqual({ kind: "stopping" });
  });

  test("닫기 도중 검증을 기다리던 그 연결의 봉투는 판단에 넘기지 않는다(late_dropped, forward 0)", async () => {
    const h = await start();
    const one = await greet(h, K1, R1);
    const answers = () => h.delivered.filter((o) => o.connection === one.id && (o.kind === "forward" || o.kind === "occupancy")).length;
    // 인사가 낸 occupancy는 닫기 전의 것이다. 닫은 뒤에 늘지 않는지를 본다.
    const before = answers();
    const gate = h.hold();
    one.send(seal(K1, R1, "status_report", GEN, h.t, { in_reply_to: uuid(), runs: [running] }));
    await until(() => gate.entered());
    expect(h.server.closeConnection(one.id)).toEqual({ kind: "closed" });
    gate.release();
    await until(() => h.notes.some((n) => n.kind === "late_dropped" && n.connection === one.id));
    expect(answers()).toBe(before);
    expect(h.withdrawnOf(one.id).length).toBe(1);
  });

  test("넘긴 틀은 닫힘에서 settled(closed) 한 번으로 끝나고, lastCheck 안에서 닫으면 그 쓰기는 closed로 넘기지 않는다", async () => {
    const h = await start();
    const one = await greet(h, K1, R1);
    // 하위 쓰기를 붙들어 완료 콜백이 닫기 전에 오지 않게 한다.
    const socket = h.socketOf(one.id);
    socket._write = () => {};
    const ends: SendEnd[] = [];
    const written = h.server.writeFrame(one.id, R1, frameOf({ x: 1 }), { lastCheck: () => null, settled: (end) => ends.push(end) });
    expect(written).toEqual({ kind: "written" });
    expect(ends).toEqual([]);
    expect(h.server.closeConnection(one.id)).toEqual({ kind: "closed" });
    expect(ends).toEqual(["closed"]);

    const two = await greet(h, K2, R2);
    const handed: unknown[] = [];
    const twoSocket = h.socketOf(two.id);
    const write = twoSocket.write;
    twoSocket.write = function (this: ServerSocket, ...args: unknown[]) {
      handed.push(args[0]);
      return (write as (...a: unknown[]) => boolean).apply(this, args);
    } as typeof twoSocket.write;
    const lateEnds: SendEnd[] = [];
    const inner: unknown[] = [];
    const result = h.server.writeFrame(two.id, R2, frameOf({ x: 2 }), {
      lastCheck: () => {
        inner.push(h.server.closeConnection(two.id));
        return null;
      },
      settled: (end) => lateEnds.push(end),
    });
    expect(inner).toEqual([{ kind: "closed" }]);
    expect(result).toEqual({ kind: "not_written", reason: "closed" });
    expect(handed.length).toBe(0);
    expect(lateEnds).toEqual([]);
    expect(h.withdrawnOf(two.id).length).toBe(1);
  });
});

// ---- 실제 답 줄·조회 등록부·장부에 이은 루프백 ----

function events<T>() {
  const seen: T[] = [];
  const waiting: { match: (value: T) => boolean; done: (value: T) => void }[] = [];
  return {
    push(value: T) {
      seen.push(value);
      const index = waiting.findIndex((w) => w.match(value));
      if (index >= 0) waiting.splice(index, 1)[0]!.done(value);
    },
    next(match: (value: T) => boolean): Promise<T> {
      const found = seen.find(match);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise<T>((resolve) => waiting.push({ match, done: resolve }));
    },
    all: () => [...seen],
  };
}

test("루프백: 닫은 연결의 철회가 답 줄·조회 등록부·자격 값 송신기 포트까지 가고, 실행기가 재접속 제한 안에서 다시 붙어 보낸 새 hello를 새 연결로 인정한다", async () => {
  const now = Date.now();
  const sup = keys();
  const k1 = keys();
  const R = WORKER_EXECUTOR;
  const registryDoc = new TextEncoder().encode(
    JSON.stringify({ environment: "home", revision: 1, executors: [{ target: "reader", role: "diagnosis", instance: "0", storage: "store-a", public_key: k1.raw, active: true }] }),
  );
  const applied = RegistryState.start({ environment: "home", targets: [{ target: "reader", namespace: "olive-reader", roles: ["diagnosis"] }] }).apply({ kind: "content", content: registryDoc });
  if (applied.kind !== "applied") throw new Error("시험 등록표가 적용되지 않았다");

  // 실제 장부: 정지 세대 0, 접수 허가, 작업자 실행 하나를 preparing(세대 1)까지.
  const real = open(tempPath(), { clock: () => now });
  if (!real.applyStop({ generation: 0, stopped: false, now }).ok) throw new Error("정지 세대를 적지 못했다");
  grant(real);
  const admitted = real.admitRun(worker({ now, deadlineAt: now + 600_000 }));
  if (!admitted.ok) throw new Error(`admit: ${admitted.reason}`);
  const run = admitted.run.runId;
  if (!real.startRun({ runId: run, requestId: uuid(), stopGeneration: 0, now }).ok) throw new Error("start");
  const ledger: ReceiptLedger = {
    applyReceipt: (i, f) => real.applyReceipt(i, f),
    recordReport: (i, f) => real.recordReport(i, f),
    applyExecutorAnswer: (i, f) => real.applyExecutorAnswer(i, f),
  };

  const published = { stopGeneration: () => 0, intakeOpen: () => true };
  const restorer = () => published;
  const lineRef: { deliver: (output: Delivered) => void } = { deliver: () => {} };
  const candidates = events<number>();
  const withdrawn = events<number>();
  const opened = events<number>();
  const closedNotes: ServerNote[] = [];
  const seen = new Set<string>();
  // 같은 실행기의 연결 둘(닫힌 것, 다시 붙은 것)은 받고 셋째는 막는 재접속 제한. 닫은 뒤 곧바로 다시 붙어도 이 제한 안이다.
  const reconnect = { windowMs: 60_000, max: 2 };
  const started = await startConnectionServer({
    host: HOST,
    port: 0,
    material: material(pki.supervisor()),
    clock: () => now,
    registry: applied.state,
    restorer,
    runGeneration: (runId) => real.runGeneration(runId),
    nonces: {
      consume(sender, nonce) {
        const key = `${sender} ${nonce}`;
        const fresh = !seen.has(key);
        seen.add(key);
        return fresh;
      },
    },
    reply: { seal: (input) => sealEnvelope(input, sup.privateKey), requestId: uuid, nonce: hex32 },
    settings: { reconnect },
    deliver: (output: Delivered) => {
      lineRef.deliver(output);
      if (output.kind === "candidate") candidates.push(output.connection);
      if (output.kind === "withdrawn") withdrawn.push(output.connection);
    },
    observe: (note) => {
      if (note.kind === "opened") opened.push(note.connection);
      if (note.kind === "closed") closedNotes.push(note);
    },
    maxPendingWriteBytes: limits.MAX_MESSAGE_BYTES,
  });
  if (!started.ok) throw new Error(`서버가 시작하지 않았다: ${started.failure.kind}`);
  const server = started.server;
  cleanup.push(() => server.close());

  const queries = createQueryBook();
  const wire = createWireSink({ server, restorer, withheld: { executors: () => ({ known: true, value: [] }) }, clock: { now: () => now }, queries });
  const hellos = events<string>();
  const forgotten: number[] = [];
  const lines = createAnswerLines({
    table: () => server.table(),
    restorer,
    ledger,
    results: { backend: {} as never, ledger: real },
    random: { bytes: (length) => crypto.getRandomValues(new Uint8Array(length)) },
    signer: { seal: (input) => sealEnvelope(input, sup.privateKey) },
    clock: { now: () => now },
    wire,
    queries,
    cycle: { noteCandidate: () => {} },
    observationsSettled: () => true,
    observe: (note) => {
      if (note.kind === "hello") hellos.push(note.outcome.kind);
    },
    // 발급 문이 자격 값 송신기의 forgetConnection에 잇는 자리다(issuance.ts). 여기서는 부른 번호만 적는다.
    credentials: { onReceipt: () => {}, forgetConnection: (connection) => forgotten.push(connection) },
  });
  lineRef.deliver = (output) => lines.deliver(output);

  async function executor() {
    const before = new Set(opened.all());
    const client = createTlsClient({ address: HOST, port: server.port, supervisorDnsName: SUPERVISOR_DNS, supervisorUri: SUPERVISOR_URI, material: material(pki.executor()), now: () => now });
    cleanup.push(() => client.close());
    const socket = (await client.connect()).socket;
    socket.on("error", () => {});
    const decoder = createFrameDecoder();
    const frames = events<Envelope>();
    const closed = events<true>();
    socket.on("close", () => closed.push(true));
    socket.on("data", (chunk: Buffer) => {
      for (const decoded of decoder.push(new Uint8Array(chunk)).envelopes) frames.push(decoded.value as Envelope);
    });
    const put = (action: string, body: unknown, generation = 0) => {
      const envelope = sealEnvelope({ sender: R, recipient: "supervisor", action, request_id: uuid(), stop_generation: generation, run_generation: 0, issued_at: now, nonce: hex32(), body } as never, k1.privateKey);
      socket.write(frameOf(envelope));
    };
    const connection = await opened.next((id) => !before.has(id));
    put("stop_sync_request", { challenge: hex32() });
    await frames.next((e) => e.header.action === "stop_sync_reply");
    return { frames, closed, put, connection };
  }
  const runs = (state: RunStatus["state"]): RunStatus[] => [{ run_id: run, state, run_generation: 1, last_receipt_id: null }];
  async function ask(): Promise<string> {
    const random = { bytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) };
    const drafted = statusQueryDraft({ recipient: R, stopGeneration: 0, runIds: [run] }, random);
    if (!drafted.ok) throw new Error(drafted.reason);
    const sealed = sealDraft(drafted.draft, now, { random, signer: { seal: (input) => sealEnvelope(input, sup.privateKey) } });
    if (!sealed.ok) throw new Error(sealed.reason);
    expect(await wire.sink.send(sealed.envelope)).toBe("sent");
    return sealed.envelope.header.request_id;
  }

  // 1. 첫 연결의 인사(full)와 답하지 않은 조회 하나.
  const one = await executor();
  one.put("hello", { profile_revision: "profile-1", policy_revision: "policy-1", runs: runs("preparing"), unacked_ids: [] });
  const c1 = await candidates.next(() => true);
  expect(c1).toBe(one.connection);
  await hellos.next((kind) => kind === "applied");
  const q1 = await ask();
  await one.frames.next((e) => e.header.action === "status_query" && e.header.request_id === q1);
  expect(queries.pending().map((q) => [q.requestId, q.connection])).toEqual([[q1, c1]]);

  // 2. 감독이 그 연결을 닫는다. 철회가 답 줄을 지나 송신기 포트와 조회 등록부에 닿고, 실행기 쪽 소켓이 닫힌다.
  expect(server.closeConnection(c1)).toEqual({ kind: "closed" });
  await withdrawn.next((connection) => connection === c1);
  expect(forgotten).toEqual([c1]);
  expect(queries.pending()).toEqual([]);
  expect(server.recognized(R)).toBeNull();
  await one.closed.next(() => true);

  // 3. 실행기가 곧바로 다시 붙어(재접속 제한 안) 맞추고 새 hello를 보낸다. 서버는 새 연결로 인정하고 답 줄이 그 인사를 적용한다.
  const two = await executor();
  expect(two.connection).not.toBe(c1);
  two.put("hello", { profile_revision: "profile-1", policy_revision: "policy-1", runs: runs("preparing"), unacked_ids: [] });
  const c2 = await candidates.next((connection) => connection === two.connection);
  await hellos.next((kind) => kind === "applied" && server.recognized(R) === c2);
  expect(server.recognized(R)).toBe(c2);
  // 새 연결은 재접속 제한에 걸려 닫히지 않았다. 닫힘 기록은 감독이 닫은 첫 연결 하나뿐이다.
  expect(closedNotes).toEqual([{ kind: "closed", connection: c1, cause: "requested" }]);

  // 4. 옛 번호를 다시 닫아도 아무것도 하지 않고, 새 연결의 조회는 새 번호로 묶인다.
  expect(server.closeConnection(c1)).toEqual({ kind: "not_open" });
  const q2 = await ask();
  expect(queries.pending().map((q) => [q.requestId, q.connection])).toEqual([[q2, c2]]);
  expect(withdrawn.all()).toEqual([c1]);
  expect(forgotten).toEqual([c1]);
});
