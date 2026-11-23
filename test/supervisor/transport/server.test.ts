// 감독 연결 서버의 보장 넷. 루프백(127.0.0.1)의 빈 포트에서 실제 상호 TLS로 연다. 인증서는 시험 안에서 메모리로 만든다
// (test/transport/certs.ts, 파일을 쓰지 않는다). 실행기 쪽은 기존 tls-client.ts와 바이트 틀로 흉내 내고 봉투는 계약 v1로 실제 서명한다.
// 서버의 시계는 시험이 쥔 값이다. nonce 저장소는 시험이 한 번씩 붙잡아 검증이 오래 걸리는 순간을 만든다.
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type * as tls from "node:tls";
import { type Envelope, limits, type NonceStore, rawPublicKey, type RunStatus, sealEnvelope } from "../../../src/contract/v1/index.ts";
import { Connections, type Event, type ReplyTools, type StopGenerationSource } from "../../../src/supervisor/transport/connections.ts";
import { type RegistrySettings, RegistryState } from "../../../src/supervisor/transport/registry.ts";
import {
  type ConnectionServer,
  type ConnectionServerOptions,
  type Delivered,
  type SendEnd,
  type ServerNote,
  startConnectionServer,
  type WriteFrameOptions,
  type WriteFrameResult,
} from "../../../src/supervisor/transport/server.ts";
import { createFrameDecoder, encodeFrame } from "../../../src/transport/framing.ts";
import type { RawTlsMaterial } from "../../../src/transport/tls-policy.ts";
import { createTlsClient } from "../../../src/transport/tls-client.ts";
import { type Issued, makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../../transport/certs.ts";

const HOST = "127.0.0.1";
const ANSWER = limits.STOP_SYNC_ANSWER_MAX_MS;
const GENERATION = 3;
const pki = makePki();

const material = (leaf: Issued): RawTlsMaterial => ({ certificatePem: leaf.pem, privateKeyPem: leaf.keyPem, trustBundlePem: pki.ca.pem });

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

// ---- 키·등록표(시험이 지어 넣는 자료) ----

interface Keys {
  readonly privateKey: KeyObject;
  readonly raw: string;
}
function newKeys(): Keys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, raw: rawPublicKey(publicKey) };
}
const SUP = newKeys();
const K1 = newKeys();
const K2 = newKeys();
const K1B = newKeys();

const R1 = "executor/isolated_reader/r1/s1";
const R2 = "executor/isolated_reader/r2/s2";
const RUN = "11111111-1111-4111-8111-111111111111";
const running: RunStatus = { run_id: RUN, state: "running", run_generation: 1, last_receipt_id: null };

const registrySettings: RegistrySettings = { environment: "home", targets: [{ target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] }] };
const row = (keys: Keys, instance: string, storage: string) => ({ target: "reader", role: "isolated_reader", instance, storage, public_key: keys.raw, active: true });
const doc = (revision: number, executors: unknown[]) => new TextEncoder().encode(JSON.stringify({ environment: "home", revision, executors }));
function firstRegistry(): RegistryState {
  const outcome = RegistryState.start(registrySettings).apply({ kind: "content", content: doc(1, [row(K1, "r1", "s1"), row(K2, "r2", "s2")]) });
  if (outcome.kind !== "applied") throw new Error("시험 등록표가 적용되지 않았다");
  return outcome.state;
}

let counter = 0;
const hex32 = () => (++counter).toString(16).padStart(32, "0");
const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;

function seal(keys: Keys, sender: string, action: string, generation: number, at: number, body: unknown): Envelope {
  return sealEnvelope(
    { sender, recipient: "supervisor", action, request_id: uuid(), stop_generation: generation, run_generation: 0, issued_at: at, nonce: hex32(), body } as never,
    keys.privateKey,
  );
}
const syncRequest = (keys: Keys, sender: string, at: number) => seal(keys, sender, "stop_sync_request", 0, at, { challenge: hex32() });
const hello = (keys: Keys, sender: string, at: number) =>
  seal(keys, sender, "hello", GENERATION, at, { profile_revision: "profile-1", policy_revision: "policy-1", runs: [], unacked_ids: [] });
const statusReport = (keys: Keys, sender: string, at: number) => seal(keys, sender, "status_report", GENERATION, at, { in_reply_to: uuid(), runs: [running] });

// ---- 붙잡을 수 있는 nonce 저장소 ----

function heldNonces() {
  const seen = new Set<string>();
  const calls: string[] = [];
  let armed: { entered: boolean; release: () => void; promise: Promise<void> } | null = null;
  const store: NonceStore = {
    consume(sender, nonce) {
      calls.push(nonce);
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
  return {
    store,
    calls,
    // 다음 consume 하나를 release까지 붙잡는다.
    hold() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => (release = resolve));
      const gate = { entered: false, release, promise };
      armed = gate;
      return gate;
    },
  };
}

// ---- 서버와 실행기 흉내 ----

interface Harness {
  readonly server: ConnectionServer;
  readonly clock: { t: number };
  readonly delivered: Delivered[];
  readonly notes: ServerNote[];
  readonly nonces: ReturnType<typeof heldNonces>;
  readonly restorer: { stopGeneration(): number };
  // 서명하는 동안 시간이 흐르게 하는 자리.
  onSeal: () => void;
  // 서명한 답을 바꿔 끼우는 자리(틀로 만드는 사이 시간이 흐르게 할 때).
  wrapSealed: (envelope: Envelope) => Envelope;
  // 서버가 시계·복원기를 읽을 때, 전달할 때, 기록할 때 먼저 부른다. 던지면 그 읽기·전달이 던진다.
  onClock: () => void;
  onRestorer: () => void;
  onDeliver: (output: Delivered) => void;
  onNote: (note: ServerNote) => void;
  closedNotes(id: number): ServerNote[];
}

// shape는 서버에 넘기기 직전의 옵션 객체를 바꾼다(펼치기로는 옮길 수 없는 접근자 칸을 줄 때).
async function start(over: Partial<ConnectionServerOptions> = {}, shape: (options: ConnectionServerOptions) => ConnectionServerOptions = (o) => o): Promise<Harness> {
  const clock = { t: Date.now() };
  const delivered: Delivered[] = [];
  const notes: ServerNote[] = [];
  const nonces = heldNonces();
  const restorer = { stopGeneration: () => GENERATION };
  const harness = {
    clock,
    delivered,
    notes,
    nonces,
    restorer,
    onSeal: () => {},
    wrapSealed: (envelope: Envelope) => envelope,
    onClock: () => {},
    onRestorer: () => {},
    onDeliver: () => {},
    onNote: () => {},
  } as unknown as Harness;
  const reply: ReplyTools = {
    seal: (input) => {
      harness.onSeal();
      return harness.wrapSealed(sealEnvelope(input, SUP.privateKey));
    },
    requestId: uuid,
    nonce: hex32,
  };
  const result = await startConnectionServer(shape({
    host: HOST,
    port: 0,
    material: material(pki.supervisor()),
    clock: () => {
      harness.onClock();
      return clock.t;
    },
    registry: firstRegistry(),
    restorer: () => {
      harness.onRestorer();
      return restorer;
    },
    runGeneration: () => undefined,
    nonces: nonces.store,
    reply,
    deliver: (output) => {
      harness.onDeliver(output);
      delivered.push(output);
    },
    observe: (note) => {
      notes.push(note);
      harness.onNote(note);
    },
    maxPendingWriteBytes: limits.MAX_MESSAGE_BYTES,
    ...over,
  }));
  if (!result.ok) throw new Error(`서버가 시작하지 않았다: ${result.failure.kind}`);
  cleanup.push(() => result.server.close());
  return Object.assign(harness, {
    server: result.server,
    closedNotes: (id: number) => notes.filter((n) => n.kind === "closed" && n.connection === id),
  });
}

interface Peer {
  readonly id: number;
  readonly socket: tls.TLSSocket;
  readonly frames: Envelope[];
  closed(): boolean;
  send(...envelopes: Envelope[]): void;
  sendBytes(bytes: Uint8Array): void;
}

function frame(envelope: unknown): Uint8Array {
  const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(envelope)));
  if (!encoded.ok) throw new Error(encoded.reason);
  return encoded.frame;
}

// 실행기 하나가 붙는다. 서버가 그 연결을 연결 표에 연 뒤에 돌려준다(TLS 1.3에서는 클라이언트 쪽이 먼저 끝난다).
async function connect(h: Harness): Promise<Peer> {
  const client = createTlsClient({ address: HOST, port: h.server.port, supervisorDnsName: SUPERVISOR_DNS, supervisorUri: SUPERVISOR_URI, material: material(pki.executor()), now: Date.now });
  cleanup.push(() => client.close());
  const before = h.notes.filter((n) => n.kind === "opened").length;
  const conn = await client.connect();
  const socket = conn.socket;
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
  return {
    id: opened.connection,
    socket,
    frames,
    closed: () => closed,
    send: (...envelopes) => socket.write(Buffer.concat(envelopes.map((e) => frame(e)))),
    sendBytes: (bytes) => socket.write(bytes),
  };
}

const phaseOf = (h: Harness, peer: Peer) => h.server.table().get(peer.id)?.phase;

// 서버 쪽 소켓. 쓰기를 묶거나 하위 쓰기를 바꿔 로컬 쓰기의 완료를 시험이 정한다(서버의 내부 표를 읽는다).
type ServerSocket = tls.TLSSocket & {
  _write(chunk: unknown, encoding: string, done: (error?: Error | null) => void): void;
  _writableState: { highWaterMark: number };
};
const serverLinks = (h: Harness) => (h.server as unknown as { links: Map<number, { socket: ServerSocket }> }).links;
const serverSocket = (h: Harness, peer: Peer) => serverLinks(h).get(peer.id)!.socket;

// 판단에 넣은 사건을 그대로 적는다.
function spySteps(): Event[] {
  const events: Event[] = [];
  const original = Connections.prototype.step;
  Connections.prototype.step = function (event, ctx, tools) {
    events.push(event);
    return original.call(this, event, ctx, tools);
  };
  cleanup.push(() => {
    Connections.prototype.step = original;
  });
  return events;
}
const repliesSent = (events: Event[], id: number) => events.filter((e) => e.kind === "reply_sent" && e.connection === id).length;
// 상대가 받은 맞춤 답의 수(시험이 앞서 넣은 바이트는 세지 않는다).
const replies = (peer: Peer) => peer.frames.filter((f) => (f as { header?: { action?: string } }).header?.action === "stop_sync_reply").length;

// 서버가 그 소켓에 넘긴 것(공개 write 호출)을 적는다.
function handedTo(socket: ServerSocket): unknown[] {
  const handed: unknown[] = [];
  const write = socket.write;
  socket.write = function (this: ServerSocket, ...args: unknown[]) {
    handed.push(args[0]);
    return (write as (...a: unknown[]) => boolean).apply(this, args);
  } as typeof socket.write;
  return handed;
}

// 서버가 그 소켓에 넘긴 쓰기의 완료 콜백이 서버에 닿을 때마다 그 결과를 적는다(서버의 콜백은 바로 이어서 불린다).
function completionsOf(socket: ServerSocket): (Error | null)[] {
  const completed: (Error | null)[] = [];
  const write = socket.write;
  socket.write = function (this: ServerSocket, ...args: unknown[]) {
    const last = args.length - 1;
    const callback = args[last];
    if (typeof callback === "function") {
      args[last] = (error?: Error | null) => {
        completed.push(error ?? null);
        (callback as (error?: Error | null) => void)(error);
      };
    }
    return (write as (...a: unknown[]) => boolean).apply(this, args);
  } as typeof socket.write;
  return completed;
}

// 하위 쓰기를 붙든다. 서버가 넘긴 바이트가 운영체제로 나가지 않아 완료 콜백이 오지 않는다. release는 원래 하위 쓰기로 넘기고,
// complete는 하위 쓰기 없이 완료 콜백을 시험이 정한 결과로 부른다(바이트는 나가지 않는다).
function holdLowerWrite(socket: ServerSocket) {
  const original = socket._write;
  let pending: { chunk: unknown; encoding: string; done: (error?: Error | null) => void } | null = null;
  socket._write = (chunk, encoding, done) => {
    pending = { chunk, encoding, done };
  };
  return {
    entered: () => pending !== null,
    release: () => {
      socket._write = original;
      original.call(socket, pending!.chunk, pending!.encoding, pending!.done);
    },
    complete: (error?: Error) => {
      socket._write = original;
      pending!.done(error ?? null);
    },
  };
}

// 그 소켓에서만 접근자 하나를 감싸 읽힐 때마다 before를 먼저 부른다(원래 접근자의 값을 그대로 돌려준다).
function onAccess(socket: object, name: string, before: () => void): void {
  let owner: object | null = socket;
  let descriptor: PropertyDescriptor | undefined;
  while (owner !== null && descriptor === undefined) {
    descriptor = Object.getOwnPropertyDescriptor(owner, name);
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  const get = descriptor?.get;
  if (get === undefined) throw new Error(`시험: ${name}은 접근자가 아니다`);
  Object.defineProperty(socket, name, {
    configurable: true,
    get(this: object) {
      before();
      return get.call(this);
    },
  });
}

// 맞춤과 인사를 마친 연결.
async function greet(h: Harness, keys: Keys, sender: string): Promise<Peer> {
  const peer = await connect(h);
  peer.send(syncRequest(keys, sender, h.clock.t));
  await until(() => peer.frames.length === 1);
  expect(peer.frames[0]!.header.action).toBe("stop_sync_reply");
  peer.send(hello(keys, sender, h.clock.t));
  await until(() => phaseOf(h, peer) === "greeted");
  return peer;
}

describe("(1) 받은 순서·받은 시각·검증 뒤 판단", () => {
  test("받은 시각: 검증을 기다린 시간과 상관없이 바이트가 온 순간의 시각을 판단에 넘긴다", async () => {
    const h = await start();
    // 검증에 3초가 걸려도 받은 시각은 그대로이고, 답은 그 뒤에 싣는다.
    const a = await connect(h);
    const T0 = h.clock.t;
    const gate = h.nonces.hold();
    a.send(syncRequest(K1, R1, T0));
    await until(() => gate.entered);
    h.clock.t = T0 + 3_000;
    gate.release();
    await until(() => a.frames.length === 1);
    const sync = h.server.table().get(a.id)!.sync!;
    expect(sync.receivedAt).toBe(T0);
    expect(sync.answeredAt).toBe(T0 + 3_000);
    expect(phaseOf(h, a)).toBe("answered");

    // 받은 때부터 STOP_SYNC_ANSWER_MAX_MS가 된 뒤에 검증이 끝나면 답하지 않는다(처리한 시각으로 재면 답해 버린다).
    const b = await connect(h);
    const T1 = h.clock.t;
    const late = h.nonces.hold();
    b.send(syncRequest(K2, R2, T1));
    await until(() => late.entered);
    h.clock.t = T1 + ANSWER;
    late.release();
    await until(() => b.closed());
    expect(b.frames).toEqual([]);
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "judgment" }]);
    expect(h.server.table().get(b.id)).toBeUndefined();
  });

  test("받은 시각: 앞 봉투의 검증을 기다리며 줄을 선 봉투도 바이트가 온 순간의 시각으로 검증한다", async () => {
    const h = await start();
    const a = await greet(h, K1, R1);
    const T = h.clock.t;
    const first = statusReport(K1, R1, T);
    const second = statusReport(K1, R1, T);
    const gate = h.nonces.hold();
    a.send(first, second);
    await until(() => gate.entered);
    // 앞 봉투를 검증하는 사이 봉투 수명(30초)이 지났다. 뒤 봉투를 꺼낸 시각으로 검증하면 expired로 닫힌다.
    h.clock.t = T + limits.MESSAGE_TTL_MS;
    gate.release();
    const forwards = () => h.delivered.filter((o) => o.kind === "forward").length;
    await until(() => forwards() === 2 || h.closedNotes(a.id).length > 0);
    expect(h.closedNotes(a.id)).toEqual([]);
    expect(forwards()).toBe(2);
  });

  test("차례: 한 연결의 다음 봉투는 앞 봉투의 check와 step이 끝난 뒤에 check한다", async () => {
    const h = await start();
    const a = await greet(h, K1, R1);
    const first = statusReport(K1, R1, h.clock.t);
    const second = statusReport(K1, R1, h.clock.t);
    const gate = h.nonces.hold();
    a.send(first, second);
    await until(() => gate.entered);
    await Bun.sleep(50);
    // 앞 봉투의 검증이 끝나지 않았으므로 뒤 봉투는 아직 nonce에 닿지 않았다.
    expect(h.nonces.calls.at(-1)).toBe(first.header.nonce);
    expect(h.nonces.calls).not.toContain(second.header.nonce);
    gate.release();
    await until(() => h.delivered.filter((o) => o.kind === "forward").length === 2);
    expect(h.nonces.calls.slice(-2)).toEqual([first.header.nonce, second.header.nonce]);
    const after = h.delivered.filter((o) => o.kind === "forward" || o.kind === "occupancy").slice(-4);
    expect(after.map((o) => o.kind)).toEqual(["occupancy", "forward", "occupancy", "forward"]);
    const forwarded = after.filter((o) => o.kind === "forward").map((o) => (o.kind === "forward" ? o.verified.header.nonce : null));
    expect(forwarded).toEqual([first.header.nonce, second.header.nonce]);
  });

  test("틀이 거절한 바이트(중복 키, 크기 상한)는 판단에 닿지 않고 그 연결을 닫는다", async () => {
    const h = await start();
    const a = await connect(h);
    const request = syncRequest(K1, R1, h.clock.t);
    const text = JSON.stringify(request);
    const duplicated = `{"header":${JSON.stringify(request.header)},${text.slice(1)}`;
    // 틀의 길이 접두는 맞고 본문에 같은 키가 두 번 있다.
    const encoded = encodeFrame(new TextEncoder().encode(duplicated));
    if (!encoded.ok) throw new Error(encoded.reason);
    a.sendBytes(encoded.frame);
    await until(() => a.closed());
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "frame", frame: "frame_duplicate_key" }]);

    const b = await connect(h);
    const tooLarge = new Uint8Array(4);
    new DataView(tooLarge.buffer).setUint32(0, limits.MAX_MESSAGE_BYTES + 1, false);
    b.sendBytes(tooLarge);
    await until(() => b.closed());
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "frame", frame: "frame_too_large" }]);

    expect(h.nonces.calls).toEqual([]);
    expect(h.server.table().get(a.id)).toBeUndefined();
    expect(h.server.table().get(b.id)).toBeUndefined();
  });

  test("답을 싣기 전에 받은 hello는 답을 실은 뒤 차례가 와도 판단에 넘기지 않고 연결을 닫는다", async () => {
    const h = await start();
    const a = await connect(h);
    const gate = h.nonces.hold();
    // 시계가 멈춰 있어 hello의 받은 시각과 답을 실은 시각이 같다. 판단은 같은 시각을 소켓 사건의 순서에 맡긴다.
    a.send(syncRequest(K1, R1, h.clock.t), hello(K1, R1, h.clock.t));
    await until(() => gate.entered);
    await Bun.sleep(50);
    gate.release();
    await until(() => a.closed());
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "before_reply" }]);
    expect(h.delivered.filter((o) => o.kind === "candidate")).toEqual([]);
  });
});

describe("(2) 답은 기한 안에만 싣고 실은 순간을 알린다", () => {
  test("서명하는 사이 기한 정각이 되면 싣지 않고 판단이 그 연결을 닫는다. 정각 전이면 싣고 그 시각을 reply_sent로 넣는다", async () => {
    const h = await start();
    const a = await connect(h);
    const T0 = h.clock.t;
    const gate = h.nonces.hold();
    a.send(syncRequest(K1, R1, T0));
    await until(() => gate.entered);
    h.clock.t = T0 + ANSWER - 1;
    h.onSeal = () => (h.clock.t = T0 + ANSWER);
    gate.release();
    await until(() => a.closed());
    expect(a.frames).toEqual([]);
    expect(h.notes).toContainEqual({ kind: "reply_not_sent", connection: a.id, deadline: T0 + ANSWER, at: T0 + ANSWER });
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "judgment" }]);

    const b = await connect(h);
    const T1 = h.clock.t;
    const next = h.nonces.hold();
    b.send(syncRequest(K2, R2, T1));
    await until(() => next.entered);
    h.clock.t = T1 + ANSWER - 2;
    h.onSeal = () => (h.clock.t = T1 + ANSWER - 1);
    next.release();
    await until(() => b.frames.length === 1);
    expect(b.frames[0]!.header.action).toBe("stop_sync_reply");
    expect(h.server.table().get(b.id)!.sync!.answeredAt).toBe(T1 + ANSWER - 1);
    expect(phaseOf(h, b)).toBe("answered");
  });

  test("답을 틀로 만드는 사이 기한 정각이 되면 소켓에 쓰지 않는다(기한은 쓰기 바로 앞에서 판정한다)", async () => {
    const h = await start();
    const steps = spySteps();
    const a = await connect(h);
    const T0 = h.clock.t;
    const gate = h.nonces.hold();
    a.send(syncRequest(K1, R1, T0));
    await until(() => gate.entered);
    h.onSeal = () => (h.clock.t = T0 + ANSWER - 1);
    // 서명 뒤 4,999ms, 답을 JSON으로 바꾸는 사이 1ms가 흐른다. 실행기가 받는 바이트는 서명한 답 그대로다.
    h.wrapSealed = (envelope) =>
      ({
        toJSON: () => {
          h.clock.t = T0 + ANSWER;
          return envelope;
        },
      }) as unknown as Envelope;
    gate.release();
    await until(() => a.closed());
    expect(a.frames).toEqual([]);
    expect(repliesSent(steps, a.id)).toBe(0);
    expect(h.notes).toContainEqual({ kind: "reply_not_sent", connection: a.id, deadline: T0 + ANSWER, at: T0 + ANSWER });
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "judgment" }]);
  });

  test("로컬 쓰기의 완료를 모르는 동안 reply_sent를 넣지 않는다. 그 사이 tick·applyRegistry·다른 연결은 멈추지 않고, 서버는 기다리는 연결을 닫는다", async () => {
    const h = await start();
    const steps = spySteps();
    const b = await greet(h, K2, R2);
    const a = await connect(h);
    const sa = serverSocket(h, a);
    // 서버는 빈 소켓에 답을 넘기고, 시험이 하위 쓰기를 붙들어 완료 콜백이 오지 않게 한다.
    const lowerA = holdLowerWrite(sa);
    const completedA = completionsOf(sa);
    a.send(syncRequest(K1, R1, h.clock.t));
    await until(lowerA.entered);
    expect(phaseOf(h, a)).toBe("requested");
    expect(repliesSent(steps, a.id)).toBe(0);

    h.server.tick();
    expect(h.server.applyRegistry({ kind: "content", content: doc(2, [row(K1, "r1", "s1"), row(K2, "r2", "s2")]) }).kind).toBe("applied");
    b.send(statusReport(K2, R2, h.clock.t));
    await until(() => h.delivered.some((o) => o.kind === "forward" && o.connection === b.id));
    expect(phaseOf(h, a)).toBe("requested");

    // 쓰기 완료를 모르는 동안 받은 hello는 판단에 넘기지 않고 기다린다(nonce에도 닿지 않는다).
    const early = hello(K1, R1, h.clock.t);
    const link = serverLinks(h).get(a.id) as unknown as { received: number };
    a.send(early);
    await until(() => link.received === 2);
    expect(h.nonces.calls).not.toContain(early.header.nonce);
    expect(phaseOf(h, a)).toBe("requested");

    // 내보내기 전에 소켓이 닫힌다.
    sa.destroy();
    await until(() => a.closed() && h.closedNotes(a.id).length > 0);
    expect(a.frames).toEqual([]);
    expect(repliesSent(steps, a.id)).toBe(0);
    expect(h.server.table().get(a.id)).toBeUndefined();
    expect(h.delivered.filter((o) => o.connection === a.id)).toEqual([]);
    expect(phaseOf(h, b)).toBe("greeted");
    // 파기 뒤에 쓰기의 완료가 오류로 돌아와도 닫힌 연결의 상태·사건·기록은 그대로다.
    const closedA = h.closedNotes(a.id);
    let notes = h.notes.length;
    let events = steps.length;
    lowerA.complete(new Error("시험: 파기 뒤 돌아온 오류"));
    await until(() => completedA.length === 1);
    expect(completedA[0]).toBeInstanceOf(Error);
    expect(h.notes.length).toBe(notes);
    expect(steps.length).toBe(events);
    expect(h.closedNotes(a.id)).toEqual(closedA);
    expect(h.server.table().get(a.id)).toBeUndefined();

    // 넘긴 답의 완료를 기다리는 연결도 서버를 닫으면 닫히고 표에서 빠진다. 그 뒤 완료가 성공으로 돌아와도 바뀌는 것이 없다.
    const d = await connect(h);
    const sd = serverSocket(h, d);
    const lowerD = holdLowerWrite(sd);
    const completedD = completionsOf(sd);
    d.send(syncRequest(K2, R2, h.clock.t));
    await until(lowerD.entered);
    expect(phaseOf(h, d)).toBe("requested");
    await h.server.close();
    expect(h.closedNotes(d.id)).toEqual([{ kind: "closed", connection: d.id, cause: "shutdown" }]);
    expect(repliesSent(steps, d.id)).toBe(0);
    expect(h.server.table().get(d.id)).toBeUndefined();
    notes = h.notes.length;
    events = steps.length;
    lowerD.complete();
    await until(() => completedD.length === 1);
    expect(completedD[0]).toBeNull();
    expect(h.notes.length).toBe(notes);
    expect(steps.length).toBe(events);
    expect(h.closedNotes(d.id)).toEqual([{ kind: "closed", connection: d.id, cause: "shutdown" }]);
    expect(h.notes.filter((n) => n.kind === "reply_written" && n.connection === d.id)).toEqual([]);
    expect(h.server.table().get(d.id)).toBeUndefined();
  });

  test("로컬 쓰기의 완료가 오류면 reply_sent를 넣지 않고, 밀렸다가 끝나면 한 번 넣고, 끝난 때가 기한 정각 이후면 닫는다", async () => {
    const h = await start();
    const steps = spySteps();

    // 하위 쓰기의 완료가 오류로 돌아온다.
    const a = await connect(h);
    const sa = serverSocket(h, a);
    let fail = () => {};
    let entered = false;
    sa._write = (_chunk, _encoding, done) => {
      entered = true;
      fail = () => done(new Error("시험: 로컬 쓰기 실패"));
    };
    a.send(syncRequest(K1, R1, h.clock.t));
    await until(() => entered);
    expect(phaseOf(h, a)).toBe("requested");
    fail();
    await until(() => a.closed() && h.closedNotes(a.id).length > 0);
    expect(a.frames).toEqual([]);
    expect(repliesSent(steps, a.id)).toBe(0);
    expect(h.server.table().get(a.id)).toBeUndefined();

    // 쓰기 버퍼 임계값을 낮춰 write가 false를 돌려준다. 내보내기는 정상으로 끝난다.
    const b = await connect(h);
    const sb = serverSocket(h, b);
    sb._writableState.highWaterMark = 1;
    const returned: boolean[] = [];
    const write = sb.write;
    sb.write = function (this: ServerSocket, ...args: unknown[]) {
      const value = (write as (...a: unknown[]) => boolean).apply(this, args);
      returned.push(value);
      return value;
    } as typeof sb.write;
    b.socket.pause();
    b.send(syncRequest(K2, R2, h.clock.t));
    await until(() => phaseOf(h, b) === "answered");
    expect(returned).toEqual([false]);
    b.socket.resume();
    await until(() => b.frames.length === 1);
    b.send(hello(K2, R2, h.clock.t));
    await until(() => phaseOf(h, b) === "greeted");
    expect(repliesSent(steps, b.id)).toBe(1);

    // 쓰기를 묶어 둔 소켓에는 답을 넘기지 않고 곧바로 닫는다. 정각에 풀고 박자를 줘도 나갈 답이 없다.
    const c = await connect(h);
    const sc = serverSocket(h, c);
    const handed = handedTo(sc);
    sc.cork();
    const T = h.clock.t;
    c.send(syncRequest(K1, R1, T));
    await until(() => h.closedNotes(c.id).length > 0);
    expect(h.closedNotes(c.id)).toEqual([{ kind: "closed", connection: c.id, cause: "write_busy" }]);
    expect(repliesSent(steps, c.id)).toBe(0);
    expect(h.server.table().get(c.id)).toBeUndefined();
    h.clock.t = T + ANSWER;
    sc.uncork();
    h.server.tick();
    expect(handed).toEqual([]);
    expect(h.notes.filter((n) => (n.kind === "reply_not_sent" || n.kind === "reply_written") && n.connection === c.id)).toEqual([]);
    await until(() => c.closed());
    expect(replies(c)).toBe(0);
  });

  test("답을 넘기려는 때 쓰기 버퍼에 앞선 바이트가 남았거나 묶였으면 넘기지 않고 곧바로 닫는다. 버퍼가 뒤에 비어도 넘길 답이 없다", async () => {
    const h = await start();
    const steps = spySteps();
    const unsent = (peer: Peer) => {
      expect(h.closedNotes(peer.id)).toEqual([{ kind: "closed", connection: peer.id, cause: "write_busy" }]);
      expect(repliesSent(steps, peer.id)).toBe(0);
      expect(h.notes.filter((n) => (n.kind === "reply_written" || n.kind === "reply_not_sent") && n.connection === peer.id)).toEqual([]);
      expect(h.server.table().get(peer.id)).toBeUndefined();
    };
    // 판단이 답을 낸 뒤까지 기다린다: 연결이 닫혔거나 답을 기다리는 단계다(닫히지 않은 경우는 뒤 단언이 잡는다).
    const settled = (peer: Peer) => until(() => h.closedNotes(peer.id).length > 0 || phaseOf(h, peer) === "requested");

    // 시험이 서버 소켓에 먼저 바이트를 넣고 묶는다. 버퍼가 기한 1ms 전에 비어도 넘기지 않는다.
    const a = await connect(h);
    const sa = serverSocket(h, a);
    sa._writableState.highWaterMark = 1;
    sa.cork();
    sa.write(frame({ prior: a.id }));
    const handedA = handedTo(sa);
    const T = h.clock.t;
    a.send(syncRequest(K1, R1, T));
    await settled(a);
    expect(sa.destroyed || sa.writableLength > 0).toBe(true);
    h.clock.t = T + ANSWER - 1;
    sa.uncork();
    h.server.tick();
    expect(handedA).toEqual([]);
    unsent(a);
    await until(() => a.closed());
    expect(replies(a)).toBe(0);

    // 묶지 않고 임계값도 그대로 둔 채 앞선 바이트 하나가 하위 쓰기에서 완료를 기다린다. 남은 것은 버퍼의 길이뿐이다
    // (비우기 대기·묶음이 아니다). 다른 입력들은 묶음만으로도 닫히므로 길이의 관측은 이 입력만 가른다.
    const c = await connect(h);
    const sc = serverSocket(h, c);
    const lowerC = holdLowerWrite(sc);
    sc.write(frame({ prior: c.id }));
    await until(lowerC.entered);
    expect(sc.writableLength).toBeGreaterThan(0);
    expect(sc.writableNeedDrain).toBe(false);
    expect(sc.writableCorked).toBe(0);
    const handedC = handedTo(sc);
    c.send(syncRequest(K1, R1, h.clock.t));
    await settled(c);
    expect(handedC).toEqual([]);
    unsent(c);
    await until(() => c.closed());
    expect(replies(c)).toBe(0);

    // 빈 스트림을 묶기만 했다. 세대를 모르는 복원기로 바꾼 뒤 기한 전의 박자를 줘도 옛 답의 쓰기를 시도하지 않는다.
    const b = await connect(h);
    const sb = serverSocket(h, b);
    const handedB = handedTo(sb);
    sb.cork();
    const T1 = h.clock.t;
    b.send(syncRequest(K2, R2, T1));
    await settled(b);
    (h.restorer as unknown as { stopGeneration: () => number | null }).stopGeneration = () => null;
    sb.uncork();
    h.clock.t = T1 + ANSWER - 1;
    h.server.tick();
    expect(handedB).toEqual([]);
    unsent(b);
    await until(() => b.closed());
    expect(replies(b)).toBe(0);
  });

  test("기한은 버퍼를 본 뒤 write 바로 앞에서 읽은 시각으로 판정한다: 버퍼를 보는 사이 정각이 되면 넘기지 않는다", async () => {
    const h = await start();
    const steps = spySteps();

    // 정상 맞춤: 갓 받은 연결의 빈 버퍼에 넘긴다. write 바로 앞의 일은 시계 읽기이고, 버퍼의 관측은 그보다 앞선다.
    const a = await connect(h);
    const sa = serverSocket(h, a);
    const order: string[] = [];
    for (const name of ["writableLength", "writableNeedDrain", "writableCorked"]) onAccess(sa, name, () => order.push(name));
    h.onClock = () => order.push("clock");
    const handedA = handedTo(sa);
    const write = sa.write;
    sa.write = function (this: ServerSocket, ...args: unknown[]) {
      order.push("write");
      return (write as (...a: unknown[]) => boolean).apply(this, args);
    } as typeof sa.write;
    a.send(syncRequest(K1, R1, h.clock.t));
    await until(() => phaseOf(h, a) === "answered");
    h.onClock = () => {};
    const w = order.indexOf("write");
    expect(order.slice(w - 4, w + 1)).toEqual(["writableLength", "writableNeedDrain", "writableCorked", "clock", "write"]);
    expect(handedA).toHaveLength(1);
    expect(repliesSent(steps, a.id)).toBe(1);
    await until(() => replies(a) === 1);

    // 버퍼를 보는 사이 시계가 4,999ms에서 5,000ms가 된다. 넘긴 것 0, 판단이 늦은 답으로 닫는다.
    const b = await connect(h);
    const sb = serverSocket(h, b);
    const T = h.clock.t;
    let armed = false;
    h.onSeal = () => {
      h.clock.t = T + ANSWER - 1;
      armed = true;
    };
    onAccess(sb, "writableCorked", () => {
      if (!armed) return;
      armed = false;
      h.clock.t = T + ANSWER;
    });
    const handedB = handedTo(sb);
    b.send(syncRequest(K2, R2, T));
    await until(() => h.closedNotes(b.id).length > 0);
    expect(handedB).toEqual([]);
    expect(repliesSent(steps, b.id)).toBe(0);
    expect(h.notes).toContainEqual({ kind: "reply_not_sent", connection: b.id, deadline: T + ANSWER, at: T + ANSWER });
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "judgment" }]);
    await until(() => b.closed());
    expect(replies(b)).toBe(0);
  });

  test("박자의 시각을 한 번 읽는다: 그 읽기만 던져도 판단의 tick이 던진 때와 같이 열린 연결을 모두 닫는다", async () => {
    const h = await start();
    const a = await connect(h);
    const lowerA = holdLowerWrite(serverSocket(h, a));
    a.send(syncRequest(K1, R1, h.clock.t));
    await until(lowerA.entered);
    const b = await connect(h);
    let fail = 1;
    h.onClock = () => {
      if (fail-- > 0) throw new Error("시험: 박자의 첫 시계 읽기");
    };
    h.server.tick();
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "judgment_failed" }]);
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "judgment_failed" }]);
    // 이어서 보낸 맞춤과 인사에서도 답·후보·점유가 나오지 않는다.
    b.send(syncRequest(K2, R2, h.clock.t), hello(K2, R2, h.clock.t));
    await until(() => b.closed() && a.closed());
    expect(replies(b)).toBe(0);
    expect(h.delivered.filter((o) => o.connection === b.id && (o.kind === "candidate" || o.kind === "occupancy"))).toEqual([]);
    expect(h.server.table().candidates(h.restorer)).toEqual([]);
    expect(h.server.table().occupancy(h.restorer)).toEqual([]);
  });

  test("한 박자에 완료 대기가 만료된 연결은 다른 연결이 있어도 write_late로 닫힌다", async () => {
    const h = await start();
    const steps = spySteps();
    // 먼저 등록된 연결 하나는 묶인 소켓이라 답이 넘겨지지 않는다. 그 연결이 박자 안에서 판단의 tick을 먼저 넣지 않는지 본다.
    const a = await connect(h);
    serverSocket(h, a).cork();
    const T = h.clock.t;
    a.send(syncRequest(K1, R1, T));
    await until(() => h.closedNotes(a.id).length > 0 || phaseOf(h, a) === "requested");
    const b = await connect(h);
    const lowerB = holdLowerWrite(serverSocket(h, b));
    b.send(syncRequest(K2, R2, T));
    await until(lowerB.entered);
    // 박자에 완료 대기가 둘 열려 있어야 만료를 하나만 보고 멈추는 회귀가 드러난다(A는 박자 전에 이미 닫힌다).
    const c = await connect(h);
    const lowerC = holdLowerWrite(serverSocket(h, c));
    c.send(syncRequest(K1, R1, T));
    await until(lowerC.entered);
    expect(phaseOf(h, b)).toBe("requested");
    expect(phaseOf(h, c)).toBe("requested");
    expect(h.closedNotes(b.id)).toEqual([]);
    expect(h.closedNotes(c.id)).toEqual([]);
    h.clock.t = T + ANSWER;
    h.server.tick();
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "write_late" }]);
    expect(repliesSent(steps, b.id)).toBe(0);
    expect(h.server.table().get(b.id)).toBeUndefined();
    expect(h.closedNotes(c.id)).toEqual([{ kind: "closed", connection: c.id, cause: "write_late" }]);
    expect(repliesSent(steps, c.id)).toBe(0);
    expect(h.server.table().get(c.id)).toBeUndefined();
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "write_busy" }]);
  });

  test("넘긴 답의 완료를 기다리는 동안 기한 정각의 박자가 오면 곧바로 끊는다. 그 전에 하위 쓰기가 나가면 막지 못한다", async () => {
    const h = await start();
    const steps = spySteps();

    // (다) 빈 소켓에 넘긴 답의 하위 쓰기를 붙든다. 정각 전의 박자는 기다리고, 정각의 박자는 완료를 기다리지 않고 끊는다.
    const a = await connect(h);
    const sa = serverSocket(h, a);
    const lowerA = holdLowerWrite(sa);
    const T = h.clock.t;
    a.send(syncRequest(K1, R1, T));
    await until(lowerA.entered);
    h.clock.t = T + ANSWER - 1;
    h.server.tick();
    expect(sa.destroyed).toBe(false);
    expect(phaseOf(h, a)).toBe("requested");
    h.clock.t = T + ANSWER;
    h.server.tick();
    expect(sa.destroyed).toBe(true);
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "write_late" }]);
    expect(repliesSent(steps, a.id)).toBe(0);
    expect(h.server.table().get(a.id)).toBeUndefined();
    await until(() => a.closed());
    expect(replies(a)).toBe(0);

    // 남는 틈: 넘긴 뒤 기한 정각과 다음 박자 사이에 하위 쓰기가 나가면 상대는 답을 받는다. 서버는 실었다고 세지 않고 닫는다.
    const b = await connect(h);
    const lowerB = holdLowerWrite(serverSocket(h, b));
    const T1 = h.clock.t;
    b.send(syncRequest(K2, R2, T1));
    await until(lowerB.entered);
    h.clock.t = T1 + ANSWER;
    lowerB.release();
    await until(() => h.closedNotes(b.id).length > 0);
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "write_late" }]);
    expect(repliesSent(steps, b.id)).toBe(0);
    expect(h.server.table().get(b.id)).toBeUndefined();
    await until(() => b.closed());
    expect(replies(b)).toBe(1);

    // reply_sent의 시각은 넘긴 시각이다. 완료를 안 시각은 기록에만 따로 남는다.
    const c = await connect(h);
    const lowerC = holdLowerWrite(serverSocket(h, c));
    const T2 = h.clock.t;
    c.send(syncRequest(K1, R1, T2));
    await until(lowerC.entered);
    h.clock.t = T2 + 30;
    lowerC.release();
    await until(() => phaseOf(h, c) === "answered");
    expect(h.server.table().get(c.id)!.sync!.answeredAt).toBe(T2);
    expect(h.notes).toContainEqual({ kind: "reply_written", connection: c.id, at: T2, done: T2 + 30 });
    expect(repliesSent(steps, c.id)).toBe(1);
  });
});

describe("(3) 닫힘과 교체", () => {
  test("판단이 close를 내면 소켓을 닫고, 상대가 닫아도 closed를 한 번만 알린다", async () => {
    const h = await start();
    const a = await connect(h);
    a.send(hello(K1, R1, h.clock.t));
    await until(() => a.closed());
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "judgment" }]);
    expect(h.server.table().get(a.id)).toBeUndefined();

    const b = await greet(h, K1, R1);
    b.socket.destroy();
    await until(() => h.closedNotes(b.id).length > 0);
    await Bun.sleep(30);
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "peer" }]);
    expect(h.delivered.filter((o) => o.kind === "withdrawn")).toEqual([{ kind: "withdrawn", connection: b.id, principal: R1 }]);
    expect(h.server.table().get(b.id)).toBeUndefined();

    // 보내기만 끝낸 반쪽 닫힘도 닫힘이다.
    const c = await greet(h, K2, R2);
    c.socket.end();
    await until(() => h.closedNotes(c.id).length > 0);
    await Bun.sleep(30);
    expect(h.closedNotes(c.id)).toEqual([{ kind: "closed", connection: c.id, cause: "peer" }]);
    expect(h.delivered.filter((o) => o.kind === "withdrawn" && o.connection === c.id)).toEqual([{ kind: "withdrawn", connection: c.id, principal: R2 }]);
    expect(h.server.table().get(c.id)).toBeUndefined();
  });

  test("닫힌 연결의 늦게 끝난 검증 결과는 버리고, 같은 실행기의 새 연결을 바꾸지 않는다", async () => {
    const h = await start();
    const old = await greet(h, K1, R1);
    const gate = h.nonces.hold();
    old.send(statusReport(K1, R1, h.clock.t));
    await until(() => gate.entered);
    old.socket.destroy();
    await until(() => h.closedNotes(old.id).length > 0);

    const fresh = await greet(h, K1, R1);
    const before = { state: h.server.table().get(fresh.id), delivered: h.delivered.length };
    gate.release();
    await Bun.sleep(50);
    expect(h.delivered.length).toBe(before.delivered);
    expect(h.server.table().get(fresh.id)).toBe(before.state!);
    expect(fresh.closed()).toBe(false);
    // 서버가 그 결과를 판단에 넘기지 않고 버렸다. 연결 판단도 지운 행의 결과를 쓰지 않으므로(connections.ts) 위 효과는 두 겹으로 막힌다.
    expect(h.notes.filter((n) => n.kind === "late_dropped")).toEqual([{ kind: "late_dropped", connection: old.id }]);
  });

  test("검증을 기다리는 사이 다른 연결이 바꾼 상태를 되돌리지 않는다(step은 그때의 연결 표에 건다)", async () => {
    const h = await start();
    const a = await connect(h);
    const gate = h.nonces.hold();
    a.send(syncRequest(K1, R1, h.clock.t));
    await until(() => gate.entered);
    const b = await greet(h, K2, R2);
    gate.release();
    await until(() => a.frames.length === 1);
    expect(phaseOf(h, a)).toBe("answered");
    expect(phaseOf(h, b)).toBe("greeted");
    expect(b.closed()).toBe(false);
  });

  test("닫히는 순간 시계가 한 번 던져도 끊긴 실행기는 판단에서 빠진다(닫힘은 시계·복원기를 읽지 않는다)", async () => {
    const h = await start();
    const steps = spySteps();
    const a = await greet(h, K1, R1);
    const b = await greet(h, K2, R2);
    let armed = false;
    let reads = 0;
    const fault = () => {
      if (!armed) return;
      reads++;
      armed = false;
      throw new Error("시험: 한 번 실패");
    };
    h.onClock = fault;
    h.onRestorer = fault;
    // 닫힘을 기록하는 순간(판단에 closed를 넣기 바로 앞)부터 다음 읽기 하나가 던진다.
    h.onNote = (note) => {
      if (note.kind === "closed" && note.connection === a.id) armed = true;
    };
    a.socket.destroy();
    await until(() => h.closedNotes(a.id).length > 0);
    await Bun.sleep(30);
    armed = false;
    h.server.tick();
    expect(reads).toBe(0);
    expect(serverLinks(h).has(a.id)).toBe(false);
    expect(h.server.table().get(a.id)).toBeUndefined();
    expect(steps.filter((e) => e.kind === "closed" && e.connection === a.id)).toHaveLength(1);
    expect(h.delivered.filter((o) => o.kind === "withdrawn" && o.connection === a.id)).toHaveLength(1);
    expect(h.server.table().candidates(h.restorer).map((c) => c.connection)).toEqual([b.id]);
    expect(h.server.table().occupancy(h.restorer).map((o) => o.executorId)).toEqual([R2]);
    expect(phaseOf(h, b)).toBe("greeted");
  });

  test("닫힘의 전이는 시각과 복원기 칸을 읽지 않는다(서버가 closed에 넘기는 채움 값은 판단에 쓰이지 않는다)", async () => {
    const h = await start();
    const a = await greet(h, K1, R1);
    const b = await greet(h, K2, R2);
    const reads: string[] = [];
    const original = Connections.prototype.step;
    // closed에 서버의 채움 값 대신 읽으면 던지는 칸을 넘긴다. 판단이 읽으면 closed가 던져 끊긴 실행기가 표와 후보에 남는다.
    Connections.prototype.step = function (event, ctx, tools) {
      if (event.kind !== "closed") return original.call(this, event, ctx, tools);
      const guarded = {
        get now(): number {
          reads.push("now");
          throw new Error("시험: closed가 시각을 읽었다");
        },
        registry: ctx.registry,
        get stop(): StopGenerationSource {
          reads.push("stop");
          throw new Error("시험: closed가 복원기를 읽었다");
        },
      };
      return original.call(this, event, guarded, tools);
    };
    cleanup.push(() => {
      Connections.prototype.step = original;
    });
    a.socket.destroy();
    await until(() => h.closedNotes(a.id).length > 0);
    expect(reads).toEqual([]);
    expect(h.server.table().get(a.id)).toBeUndefined();
    expect(h.delivered.filter((o) => o.kind === "withdrawn" && o.connection === a.id)).toHaveLength(1);
    expect(h.server.table().candidates(h.restorer).map((c) => c.connection)).toEqual([b.id]);
  });

  test("전달이 던져 닫은 연결의 남은 후보는 내지 않는다. 철회와 다른 연결의 출력은 낸다", async () => {
    const h = await start();
    const b = await greet(h, K2, R2);
    const a = await connect(h);
    h.onDeliver = (output) => {
      if (output.kind === "occupancy" && output.connection === a.id) throw new Error("시험: 전달 실패");
    };
    a.send(syncRequest(K1, R1, h.clock.t));
    await until(() => a.frames.length === 1);
    a.send(hello(K1, R1, h.clock.t));
    await until(() => a.closed() && h.closedNotes(a.id).length > 0);
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "deliver_failed" }]);
    expect(h.delivered.filter((o) => o.connection === a.id).map((o) => o.kind)).toEqual(["withdrawn"]);
    expect(h.delivered.filter((o) => o.kind === "candidate").map((o) => o.connection)).toEqual([b.id]);
    expect(phaseOf(h, b)).toBe("greeted");
  });
});

describe("(4) 등록표가 바뀌면 판단에 알리고 더는 믿지 않는 연결을 끊는다", () => {
  test("적용할 때마다 registry 사건을 넣는다. 행이 빠진 실행기의 연결은 끊고, 적용에 실패하면 남은 연결도 끊는다", async () => {
    const h = await start();
    const a = await greet(h, K1, R1);
    const b = await greet(h, K2, R2);
    const content = doc(2, [row(K2, "r2", "s2")]);
    expect(h.server.applyRegistry({ kind: "content", content }).kind).toBe("applied");
    // 적용한 뒤 부르는 쪽이 같은 배열을 다시 써도 서버가 믿는 판은 그대로다.
    content.fill(0x20);
    await until(() => a.closed());
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "judgment" }]);
    expect(h.delivered).toContainEqual({ kind: "withdrawn", connection: a.id, principal: R1 });
    expect(phaseOf(h, b)).toBe("greeted");
    expect(h.server.registry().readout().revision).toBe(2);

    expect(h.server.applyRegistry({ kind: "unreadable" }).kind).toBe("rejected");
    await until(() => b.closed());
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "judgment" }]);
  });

  test("봉투마다 지금의 등록표에서 키를 얻는다: 연결을 맺은 뒤 바뀐 키로만 맞춤이 통한다", async () => {
    const h = await start();
    const a = await connect(h);
    const b = await connect(h);
    expect(h.server.applyRegistry({ kind: "content", content: doc(2, [row(K1B, "r1", "s1"), row(K2, "r2", "s2")]) }).kind).toBe("applied");
    a.send(syncRequest(K1, R1, h.clock.t));
    await until(() => a.closed());
    expect(a.frames).toEqual([]);
    b.send(syncRequest(K1B, R1, h.clock.t));
    await until(() => b.frames.length === 1);
    expect(phaseOf(h, b)).toBe("answered");
  });

  test("등록표의 바이트를 얻지 못하면(소유권이 넘어간 배열) 던지지 않고 읽을 수 없는 판으로 적용한다", async () => {
    const h = await start();
    const a = await greet(h, K1, R1);
    const content = doc(2, [row(K1, "r1", "s1"), row(K2, "r2", "s2")]);
    structuredClone(content.buffer, { transfer: [content.buffer] });
    expect(content.byteLength).toBe(0);
    const outcome = h.server.applyRegistry({ kind: "content", content });
    expect(outcome.kind === "rejected" ? outcome.reason : outcome.kind).toBe("unreadable");
    expect(h.server.registry()).toBe(outcome.state);
    await until(() => a.closed());
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "judgment" }]);
  });
});

describe("시작", () => {
  test("틀린 설정이나 쓸 수 없는 재료면 던지지 않고 구별된 실패를 돌려준다", async () => {
    const base = {
      host: HOST,
      port: 0,
      material: material(pki.supervisor()),
      clock: Date.now,
      registry: firstRegistry(),
      restorer: () => ({ stopGeneration: () => GENERATION }),
      runGeneration: () => undefined,
      nonces: heldNonces().store,
      reply: { seal: (input) => sealEnvelope(input, SUP.privateKey), requestId: uuid, nonce: hex32 } as ReplyTools,
      deliver: () => {},
      maxPendingWriteBytes: limits.MAX_MESSAGE_BYTES,
    } satisfies ConnectionServerOptions;
    const bad = await startConnectionServer({ ...base, settings: { helloWaitMs: 0 } });
    expect(bad.ok ? null : bad.failure.kind).toBe("bad_settings");
    const wrong = await startConnectionServer({ ...base, material: material(pki.executor()) });
    expect(wrong.ok ? null : wrong.failure).toEqual({ kind: "no_material", reason: "certificate_shape" });
  });
});

describe("(5) 인정된 연결에 틀 하나를 쓴다(recognized, writeFrame)", () => {
  const WRITTEN: WriteFrameResult = { kind: "written" };
  const NOT_RECOGNIZED: WriteFrameResult = { kind: "not_written", reason: "not_recognized" };
  const BACKLOG: WriteFrameResult = { kind: "not_written", reason: "backlog" };

  // 길이가 정확히 n바이트인 틀(접두 4 + `{"p":"…"}`).
  const sized = (n: number, fill = "x") => frame({ p: fill.repeat(n - 12) });
  const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

  // 상대가 받은 바이트를 이 함수를 부른 뒤부터 모은다.
  function rawOf(peer: Peer): () => Uint8Array {
    const chunks: Buffer[] = [];
    peer.socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    return () => new Uint8Array(Buffer.concat(chunks));
  }

  // 부르는 쪽 흉내. lastCheck를 부른 수와 settled에 온 끝을 적는다.
  function caller(verdict: () => string | null = () => null) {
    let checks = 0;
    const ends: SendEnd[] = [];
    const options: WriteFrameOptions = {
      lastCheck: () => {
        checks++;
        return verdict();
      },
      settled: (end) => {
        ends.push(end);
      },
    };
    return { ends, options, checks: () => checks };
  }

  test("상한은 진입점이 넣는다: 양의 정수가 아니면 시작하지 않는다", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(start({ maxPendingWriteBytes: bad })).rejects.toThrow("bad_settings");
    }
  });

  test("상한은 시작 때 검사한 값으로 비교한다: 설정 칸을 쓰기 때 다시 읽지 않는다", async () => {
    let cap = 300;
    let reads = 0;
    const h = await start({}, (options) =>
      Object.defineProperty({ ...options }, "maxPendingWriteBytes", {
        enumerable: true,
        get: () => {
          reads++;
          return cap;
        },
      }),
    );
    expect(reads).toBe(1);
    const a = await greet(h, K1, R1);
    const sa = serverSocket(h, a);
    const handedA = handedTo(sa);
    const lowerA = holdLowerWrite(sa);
    // 칸이 뒤에 10을 내도 비교는 시작 때의 300이다: 100 + 200 = 정각까지 넘기고 그 위는 넘기지 않는다.
    cap = 10;
    const first = sized(100);
    const second = sized(200);
    const [c1, c2, c3] = [caller(), caller(), caller()];
    expect(h.server.writeFrame(a.id, R1, first, c1.options)).toEqual(WRITTEN);
    await until(lowerA.entered);
    expect(h.server.writeFrame(a.id, R1, second, c2.options)).toEqual(WRITTEN);
    expect(sa.writableLength).toBe(300);
    expect(h.server.writeFrame(a.id, R1, sized(12), c3.options)).toEqual(BACKLOG);
    expect(handedA).toEqual([first, second]);
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "send_backlog" }]);
    expect(reads).toBe(1);
  });

  test("인정된 연결에 넘긴 틀은 상대의 디코더에 같은 바이트로 닿고, 연달아 넘긴 틀은 순서대로 섞이지 않고 닿는다. 끝은 틀마다 한 번이다", async () => {
    const h = await start();
    const a = await greet(h, K1, R1);
    const raw = rawOf(a);
    expect(h.server.recognized(R1)).toBe(a.id);
    expect(h.server.recognized(R2)).toBeNull();

    const one = frame({ n: 1 });
    const c1 = caller();
    expect(h.server.writeFrame(a.id, R1, one, c1.options)).toEqual(WRITTEN);
    expect(c1.checks()).toBe(1);
    await until(() => a.frames.length === 2);
    expect(raw()).toEqual(one);
    expect(a.frames[1] as unknown).toEqual({ n: 1 });
    await until(() => c1.ends.length > 0);
    expect(c1.ends).toEqual(["flushed"]);

    // 큰 틀은 TLS 레코드 여럿으로 나뉘어 나간다. 바로 뒤에 넘긴 작은 틀이 그 사이에 끼지 않는다.
    const two = sized(60_000, "a");
    const three = frame({ n: 3 });
    const c2 = caller();
    const c3 = caller();
    expect(h.server.writeFrame(a.id, R1, two, c2.options)).toEqual(WRITTEN);
    expect(h.server.writeFrame(a.id, R1, three, c3.options)).toEqual(WRITTEN);
    await until(() => a.frames.length === 4);
    expect(raw()).toEqual(concat(one, two, three));
    expect(a.frames.slice(2) as unknown).toEqual([{ p: "a".repeat(60_000 - 12) }, { n: 3 }]);
    await until(() => c2.ends.length + c3.ends.length === 2);
    expect([c2.ends, c3.ends]).toEqual([["flushed"], ["flushed"]]);

    // 끝을 알린 뒤 연결이 닫혀도 다시 부르지 않는다.
    a.socket.destroy();
    await until(() => h.closedNotes(a.id).length > 0);
    await Bun.sleep(20);
    expect([c1.ends, c2.ends, c3.ends]).toEqual([["flushed"], ["flushed"], ["flushed"]]);
  });

  test("인정되지 않은 연결에는 한 바이트도 넘기지 않고 lastCheck·settled를 부르지 않는다: 맞춤 전, 답의 완료 대기, 인사 전, 다른 주체, 없는 번호, 닫힌 연결, 복원기가 바뀐 뒤", async () => {
    const original: { stopGeneration(): number | null } = { stopGeneration: () => GENERATION };
    const box: { source: StopGenerationSource } = { source: original };
    const h = await start({ restorer: () => box.source });
    const refused: ReturnType<typeof caller>[] = [];
    const attempt = (id: number, principal: string, expected: WriteFrameResult) => {
      const c = caller();
      refused.push(c);
      expect(h.server.writeFrame(id, principal, frame({ never: id }), c.options)).toEqual(expected);
    };

    // 맞춤 전.
    const p = await connect(h);
    const handedP = handedTo(serverSocket(h, p));
    attempt(p.id, R1, NOT_RECOGNIZED);
    expect(handedP).toEqual([]);

    // 맞춤의 답을 넘기고 완료를 기다리는 중. 답의 길은 그대로 끝나고(write_busy 없음), 인사 전에도 쓰지 않는다.
    const q = await connect(h);
    const sq = serverSocket(h, q);
    const handedQ = handedTo(sq);
    const lowerQ = holdLowerWrite(sq);
    q.send(syncRequest(K2, R2, h.clock.t));
    await until(lowerQ.entered);
    expect(phaseOf(h, q)).toBe("requested");
    attempt(q.id, R2, NOT_RECOGNIZED);
    expect(handedQ).toHaveLength(1);
    lowerQ.release();
    await until(() => phaseOf(h, q) === "answered" && q.frames.length === 1);
    attempt(q.id, R2, NOT_RECOGNIZED);
    expect(handedQ).toHaveLength(1);
    q.send(hello(K2, R2, h.clock.t));
    await until(() => phaseOf(h, q) === "greeted");
    expect(h.closedNotes(q.id)).toEqual([]);
    expect(replies(q)).toBe(1);
    expect(h.server.recognized(R2)).toBe(q.id);

    // 인정된 연결이어도 주체가 다르거나 번호가 없으면 쓰지 않는다.
    const a = await greet(h, K1, R1);
    const handedA = handedTo(serverSocket(h, a));
    attempt(a.id, R2, NOT_RECOGNIZED);
    attempt(q.id, R1, NOT_RECOGNIZED);
    attempt(9_999, R1, NOT_RECOGNIZED);
    expect(handedA).toEqual([]);

    // 복원기가 바뀌었거나 세대를 모르게 되면 박자가 옛 연결을 닫기 전에도 인정하지 않는다. 지금의 복원기를 부를 때마다 본다.
    box.source = { stopGeneration: () => GENERATION };
    expect(h.server.recognized(R1)).toBeNull();
    attempt(a.id, R1, NOT_RECOGNIZED);
    box.source = original;
    original.stopGeneration = () => null;
    expect(h.server.recognized(R1)).toBeNull();
    attempt(a.id, R1, NOT_RECOGNIZED);
    original.stopGeneration = () => {
      throw new Error("시험: 세대 읽기 실패");
    };
    expect(h.server.recognized(R1)).toBeNull();
    attempt(a.id, R1, NOT_RECOGNIZED);
    original.stopGeneration = () => GENERATION;
    expect(h.server.recognized(R1)).toBe(a.id);
    expect(handedA).toEqual([]);

    // 서버 쪽 소켓이 파기된 그 순간(close 사건을 처리하기 전)과 닫힘을 처리한 뒤.
    const sa = serverSocket(h, a);
    sa.destroy();
    expect(serverLinks(h).has(a.id)).toBe(true);
    const closing = caller();
    refused.push(closing);
    expect(h.server.writeFrame(a.id, R1, frame({ never: "closing" }), closing.options)).toEqual({ kind: "not_written", reason: "closed" });
    await until(() => h.closedNotes(a.id).length > 0);
    attempt(a.id, R1, NOT_RECOGNIZED);
    expect(handedA).toEqual([]);
    expect(h.server.recognized(R1)).toBeNull();

    await Bun.sleep(20);
    expect(refused.map((c) => [c.checks(), c.ends.length])).toEqual(refused.map(() => [0, 0]));
    expect(p.frames).toEqual([]);
    expect(q.frames).toHaveLength(1);
    expect(a.frames).toHaveLength(1);
  });

  test("lastCheck 안에서 인정이 바뀌면 쓴다고 답해도 넘기지 않는다: 같은 세대의 새 복원기, 같은 복원기의 세대 모름. 연결은 다음 박자가 닫는다", async () => {
    const original: { stopGeneration(): number | null } = { stopGeneration: () => GENERATION };
    const box: { source: StopGenerationSource } = { source: original };
    const h = await start({ restorer: () => box.source });
    const a = await greet(h, K1, R1);
    const raw = rawOf(a);
    const handedA = handedTo(serverSocket(h, a));

    // 서버를 거치지 않고 같은 세대의 새 복원기를 게시한다. 연결은 닫히지 않았지만 맞춤에 쓴 복원기가 지금의 것이 아니다.
    const swapped = caller(() => {
      box.source = { stopGeneration: () => GENERATION };
      return null;
    });
    expect(h.server.writeFrame(a.id, R1, frame({ never: "swapped" }), swapped.options)).toEqual(NOT_RECOGNIZED);
    expect(h.closedNotes(a.id)).toEqual([]);
    expect(phaseOf(h, a)).toBe("greeted");
    box.source = original;

    // 복원기는 그대로이고 세대만 모르게 된다.
    const forgot = caller(() => {
      original.stopGeneration = () => null;
      return null;
    });
    expect(h.server.writeFrame(a.id, R1, frame({ never: "forgot" }), forgot.options)).toEqual(NOT_RECOGNIZED);
    expect(h.closedNotes(a.id)).toEqual([]);
    original.stopGeneration = () => GENERATION;

    // 인정이 그대로면 지금과 같이 넘기고 끝은 한 번이다.
    const kept = frame({ n: 1 });
    const ok = caller();
    expect(h.server.writeFrame(a.id, R1, kept, ok.options)).toEqual(WRITTEN);
    await until(() => a.frames.length === 2 && ok.ends.length > 0);
    expect(a.frames[1] as unknown).toEqual({ n: 1 });
    expect(ok.ends).toEqual(["flushed"]);
    await Bun.sleep(20);
    expect(handedA).toEqual([kept]);
    expect(raw()).toEqual(kept);
    expect([swapped, forgot].map((c) => [c.checks(), c.ends])).toEqual([
      [1, []],
      [1, []],
    ]);

    // 인정을 잃은 연결은 서버가 아니라 다음 박자의 판단이 닫는다.
    box.source = { stopGeneration: () => GENERATION };
    h.server.tick();
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "judgment" }]);
  });

  test("재확인의 세대 조회 안에서 같은 세대의 새 복원기를 게시해도 넘기지 않는다: 재확인의 마지막 외부 읽기는 복원기 게시의 확인이다", async () => {
    const original: { stopGeneration(): number | null } = { stopGeneration: () => GENERATION };
    const box: { source: StopGenerationSource } = { source: original };
    const h = await start({ restorer: () => box.source });
    const a = await greet(h, K1, R1);
    const raw = rawOf(a);
    const handedA = handedTo(serverSocket(h, a));

    // lastCheck가 쓴다고 답한 뒤의 세대 조회에서만 게시를 바꾼다. 처음 인정을 볼 때의 세대 조회는 그대로 둔다.
    let armed = false;
    let published = 0;
    original.stopGeneration = () => {
      if (armed) {
        armed = false;
        published++;
        box.source = { stopGeneration: () => GENERATION };
      }
      return GENERATION;
    };
    const swapped = caller(() => {
      armed = true;
      return null;
    });
    const result = h.server.writeFrame(a.id, R1, frame({ never: "swapped" }), swapped.options);
    await Bun.sleep(20);
    expect({ result, handed: handedA.length, received: raw().byteLength, ends: swapped.ends }).toEqual({ result: NOT_RECOGNIZED, handed: 0, received: 0, ends: [] });
    expect([swapped.checks(), published]).toEqual([1, 1]);
    expect(h.closedNotes(a.id)).toEqual([]);
    expect(phaseOf(h, a)).toBe("greeted");

    // 새 복원기로 맞춘 적이 없으므로 다음 박자의 판단이 닫는다. 넘기지 않은 틀의 끝은 그 뒤에도 오지 않는다.
    h.server.tick();
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "judgment" }]);
    expect(swapped.ends).toEqual([]);
  });

  test("줄을 두지 않는다: 하위 쓰기를 붙든 채 대기량이 상한 정각이면 넘기고, 넘으면 넘기지 않고 send_backlog로 닫는다. 묶인 스트림도 같다", async () => {
    const LIMIT = 300;
    const h = await start({ maxPendingWriteBytes: LIMIT });

    // 100 + 200 = 상한 정각까지 넘긴다. 셋째는 넘기지 않고 닫는다.
    const a = await greet(h, K1, R1);
    const sa = serverSocket(h, a);
    const handedA = handedTo(sa);
    const lowerA = holdLowerWrite(sa);
    const first = sized(100);
    const second = sized(200);
    const [c1, c2, c3] = [caller(), caller(), caller()];
    expect(h.server.writeFrame(a.id, R1, first, c1.options)).toEqual(WRITTEN);
    await until(lowerA.entered);
    expect(sa.writableLength).toBe(100);
    expect(h.server.writeFrame(a.id, R1, second, c2.options)).toEqual(WRITTEN);
    expect(sa.writableLength).toBe(LIMIT);
    expect(h.server.writeFrame(a.id, R1, sized(13), c3.options)).toEqual(BACKLOG);
    expect(handedA).toEqual([first, second]);
    expect(c3.checks()).toBe(0);
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "send_backlog" }]);
    expect([c1.ends, c2.ends, c3.ends]).toEqual([["closed"], ["closed"], []]);
    // 파기 뒤에 붙든 쓰기가 끝나도 끝을 다시 알리지 않고, 넘기지 않은 틀을 뒤에 쓰지 않는다.
    lowerA.complete();
    await until(() => a.closed());
    await Bun.sleep(20);
    expect([c1.ends, c2.ends, c3.ends]).toEqual([["closed"], ["closed"], []]);
    expect(handedA).toEqual([first, second]);
    expect(a.frames).toHaveLength(1);

    // 100 + 201 = 상한 + 1이면 둘째를 넘기지 않는다.
    const b = await greet(h, K2, R2);
    const sb = serverSocket(h, b);
    const handedB = handedTo(sb);
    const lowerB = holdLowerWrite(sb);
    const d1 = caller();
    const d2 = caller();
    expect(h.server.writeFrame(b.id, R2, first, d1.options)).toEqual(WRITTEN);
    await until(lowerB.entered);
    expect(h.server.writeFrame(b.id, R2, sized(201), d2.options)).toEqual(BACKLOG);
    expect(handedB).toEqual([first]);
    expect(d2.checks()).toBe(0);
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "send_backlog" }]);
    expect([d1.ends, d2.ends]).toEqual([["closed"], []]);

    // 빈 스트림을 묶기만 했다. 넘기지 않고 닫는다. 뒤에 풀어도 나갈 것이 없다.
    const c = await greet(h, K1, R1);
    const sc = serverSocket(h, c);
    const handedC = handedTo(sc);
    sc.cork();
    const e = caller();
    expect(h.server.writeFrame(c.id, R1, sized(20), e.options)).toEqual(BACKLOG);
    expect(h.closedNotes(c.id)).toEqual([{ kind: "closed", connection: c.id, cause: "send_backlog" }]);
    sc.uncork();
    await until(() => c.closed());
    await Bun.sleep(20);
    expect(handedC).toEqual([]);
    expect([e.checks(), e.ends]).toEqual([0, []]);
    expect(c.frames).toHaveLength(1);
  });

  test("lastCheck가 이름을 답하거나 던지면 넘긴 바이트 0이고 연결은 열린 채다. 그 안에서 다시 쓰거나 그 연결을 닫으면 넘기지 않는다", async () => {
    const h = await start();
    const a = await greet(h, K1, R1);
    const handedA = handedTo(serverSocket(h, a));

    const named = caller(() => "too_late");
    expect(h.server.writeFrame(a.id, R1, frame({ n: 1 }), named.options)).toEqual({ kind: "not_written", reason: "refused", refusal: "too_late" });
    const threw = caller(() => {
      throw new Error("시험: lastCheck 실패");
    });
    expect(h.server.writeFrame(a.id, R1, frame({ n: 2 }), threw.options)).toEqual({ kind: "not_written", reason: "check_failed" });
    const odd = caller(() => undefined as unknown as null);
    expect(h.server.writeFrame(a.id, R1, frame({ n: 3 }), odd.options)).toEqual({ kind: "not_written", reason: "check_failed" });
    let inner = null as WriteFrameResult | null;
    const innerCaller = caller();
    const nested = caller(() => {
      inner = h.server.writeFrame(a.id, R1, frame({ n: "inner" }), innerCaller.options);
      return "stop";
    });
    expect(h.server.writeFrame(a.id, R1, frame({ n: 4 }), nested.options)).toEqual({ kind: "not_written", reason: "refused", refusal: "stop" });
    expect(inner).toEqual({ kind: "not_written", reason: "reentered" });
    expect(handedA).toEqual([]);
    expect(h.closedNotes(a.id)).toEqual([]);
    expect(phaseOf(h, a)).toBe("greeted");
    expect([named, threw, odd, nested].map((c) => c.checks())).toEqual([1, 1, 1, 1]);
    expect([named, threw, odd, nested, innerCaller].map((c) => c.ends)).toEqual([[], [], [], [], []]);

    // 같은 연결에 이어서 쓸 수 있다.
    const ok = caller();
    expect(h.server.writeFrame(a.id, R1, frame({ n: 5 }), ok.options)).toEqual(WRITTEN);
    await until(() => a.frames.length === 2);
    expect(a.frames[1] as unknown).toEqual({ n: 5 });

    // lastCheck가 등록표를 적용해 그 연결이 닫혔으면 쓴다고 답해도 넘기지 않는다.
    const b = await greet(h, K2, R2);
    const handedB = handedTo(serverSocket(h, b));
    const dropping = caller(() => {
      h.server.applyRegistry({ kind: "content", content: doc(2, [row(K1, "r1", "s1")]) });
      return null;
    });
    expect(h.server.writeFrame(b.id, R2, frame({ n: 6 }), dropping.options)).toEqual({ kind: "not_written", reason: "closed" });
    expect(handedB).toEqual([]);
    expect(dropping.ends).toEqual([]);
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "judgment" }]);
    await until(() => b.closed());
    expect(b.frames).toHaveLength(1);
  });

  test("서버의 확인 → lastCheck → 인정의 재확인 → write: lastCheck가 주입 시계를 읽은 뒤 write까지 복원기 포트의 재확인 밖에 소켓의 접근자·시계 읽기가 없다", async () => {
    const shared = { t: Date.now() };
    const order: string[] = [];
    const injected = () => {
      order.push("clock");
      return shared.t;
    };
    const h = await start({ clock: injected });
    h.onRestorer = () => order.push("restorer");
    const generation = h.restorer.stopGeneration;
    h.restorer.stopGeneration = () => {
      order.push("stopGeneration");
      return generation();
    };
    const a = await greet(h, K1, R1);
    const sa = serverSocket(h, a);
    const candidates = ["destroyed", "writable", "writableLength", "writableNeedDrain", "writableCorked", "writableEnded", "writableFinished", "writableHighWaterMark", "writableObjectMode", "readyState", "bufferSize", "pending", "connecting"];
    const watched = candidates.filter((name) => {
      try {
        onAccess(sa, name, () => order.push(name));
        return true;
      } catch {
        return false;
      }
    });
    expect(watched).toEqual(expect.arrayContaining(["writableLength", "writableCorked"]));
    const write = sa.write;
    sa.write = function (this: ServerSocket, ...args: unknown[]) {
      order.push("write");
      return (write as (...a: unknown[]) => boolean).apply(this, args);
    } as typeof sa.write;
    const deadline = shared.t + 1;
    order.length = 0;
    const result = h.server.writeFrame(a.id, R1, frame({ n: 1 }), {
      lastCheck: () => {
        order.push("lastCheck");
        const now = injected();
        order.push("lastCheck:end");
        return now < deadline ? null : "too_late";
      },
      settled: () => {},
    });
    expect(result).toEqual(WRITTEN);
    const l = order.indexOf("lastCheck");
    const w = order.indexOf("write");
    // lastCheck 뒤에 서버가 읽는 것은 확인이 기댄 인정을 다시 보는 복원기 포트 둘뿐이고, 마지막이 복원기 게시의 읽기다.
    expect(order.slice(l, w + 1)).toEqual(["lastCheck", "clock", "lastCheck:end", "stopGeneration", "restorer", "write"]);
    // 서버의 확인(복원기, 소켓의 닫힘·묶임·대기량)은 lastCheck 앞에 있고, 서버는 시계를 읽지 않는다.
    expect(order.slice(0, l)).toEqual(expect.arrayContaining(["restorer", "stopGeneration", "writableCorked", "writableLength"]));
    expect(order.slice(0, l)).not.toContain("clock");
    await until(() => a.frames.length === 2);

    // lastCheck가 읽은 시각이 기한 정각이면 넘기지 않는다.
    shared.t = deadline;
    order.length = 0;
    const late = h.server.writeFrame(a.id, R1, frame({ n: 2 }), {
      lastCheck: () => (injected() < deadline ? null : "too_late"),
      settled: () => {},
    });
    expect(late).toEqual({ kind: "not_written", reason: "refused", refusal: "too_late" });
    expect(order).not.toContain("write");
  });

  test("서버의 확인 → lastCheck → 인정의 재확인 → finalCheck → write: finalCheck는 재확인 뒤에 한 번 불리고, 그 뒤 write까지 외부 읽기가 없다", async () => {
    const shared = { t: Date.now() };
    const order: string[] = [];
    const injected = () => {
      order.push("clock");
      return shared.t;
    };
    const h = await start({ clock: injected });
    h.onRestorer = () => order.push("restorer");
    const generation = h.restorer.stopGeneration;
    h.restorer.stopGeneration = () => {
      order.push("stopGeneration");
      return generation();
    };
    const a = await greet(h, K1, R1);
    const sa = serverSocket(h, a);
    const watched = ["destroyed", "writable", "writableLength", "writableNeedDrain", "writableCorked", "writableEnded", "writableFinished"].filter((name) => {
      try {
        onAccess(sa, name, () => order.push(name));
        return true;
      } catch {
        return false;
      }
    });
    expect(watched).toEqual(expect.arrayContaining(["writableLength", "writableCorked"]));
    const write = sa.write;
    sa.write = function (this: ServerSocket, ...args: unknown[]) {
      order.push("write");
      return (write as (...a: unknown[]) => boolean).apply(this, args);
    } as typeof sa.write;
    const deadline = shared.t + 1;
    const timed = () => ({
      lastCheck: () => {
        order.push("lastCheck");
        return null;
      },
      finalCheck: () => {
        order.push("finalCheck");
        const now = injected();
        order.push("finalCheck:end");
        return now < deadline ? null : "too_late";
      },
      settled: () => {},
    });
    order.length = 0;
    expect(h.server.writeFrame(a.id, R1, frame({ n: 1 }), timed())).toEqual(WRITTEN);
    const l = order.indexOf("lastCheck");
    // lastCheck 뒤에 재확인의 두 읽기, 그다음 finalCheck(그 안의 시계 한 번), 그 뒤 곧바로 write다.
    expect(order.slice(l)).toEqual(["lastCheck", "stopGeneration", "restorer", "finalCheck", "clock", "finalCheck:end", "write"]);
    expect(order.slice(0, l)).not.toContain("clock");
    await until(() => a.frames.length === 2);

    // finalCheck가 읽은 시각이 기한 정각이면 넘기지 않는다. 연결은 열린 채다.
    shared.t = deadline;
    order.length = 0;
    expect(h.server.writeFrame(a.id, R1, frame({ n: 2 }), timed())).toEqual({ kind: "not_written", reason: "refused", refusal: "too_late" });
    expect(order).not.toContain("write");
    expect(h.closedNotes(a.id)).toEqual([]);
  });

  test("finalCheck가 이름을 답하거나 던지면 넘긴 바이트 0이고 연결은 열린 채다. lastCheck가 거절했거나 재확인에서 인정을 잃었으면 부르지 않는다. 없으면 재확인 뒤 곧바로 쓴다", async () => {
    const original: { stopGeneration(): number | null } = { stopGeneration: () => GENERATION };
    const box: { source: StopGenerationSource } = { source: original };
    const h = await start({ restorer: () => box.source });
    const a = await greet(h, K1, R1);
    const raw = rawOf(a);
    const handedA = handedTo(serverSocket(h, a));
    // caller()에 finalCheck를 붙인다. 부른 수를 센다.
    const timed = (final: () => unknown, verdict: () => string | null = () => null) => {
      const c = caller(verdict);
      let finals = 0;
      const options: WriteFrameOptions = {
        ...c.options,
        finalCheck: () => {
          finals++;
          return final() as string | null;
        },
      };
      return { ...c, options, finals: () => finals };
    };

    const named = timed(() => "too_late");
    expect(h.server.writeFrame(a.id, R1, frame({ n: 1 }), named.options)).toEqual({ kind: "not_written", reason: "refused", refusal: "too_late" });
    const threw = timed(() => {
      throw new Error("시험: finalCheck 실패");
    });
    expect(h.server.writeFrame(a.id, R1, frame({ n: 2 }), threw.options)).toEqual({ kind: "not_written", reason: "check_failed" });
    const odd = timed(() => undefined);
    expect(h.server.writeFrame(a.id, R1, frame({ n: 3 }), odd.options)).toEqual({ kind: "not_written", reason: "check_failed" });
    let inner = null as WriteFrameResult | null;
    const nested = timed(() => {
      inner = h.server.writeFrame(a.id, R1, frame({ n: "inner" }), caller().options);
      return "stop";
    });
    expect(h.server.writeFrame(a.id, R1, frame({ n: 4 }), nested.options)).toEqual({ kind: "not_written", reason: "refused", refusal: "stop" });
    expect(inner).toEqual({ kind: "not_written", reason: "reentered" });
    // lastCheck가 거절하면 finalCheck를 부르지 않는다.
    const refusedFirst = timed(() => null, () => "intake_closed");
    expect(h.server.writeFrame(a.id, R1, frame({ n: 5 }), refusedFirst.options)).toEqual({ kind: "not_written", reason: "refused", refusal: "intake_closed" });
    // 재확인에서 인정을 잃으면(같은 세대의 새 복원기) finalCheck를 부르지 않는다.
    const swapped = timed(
      () => null,
      () => {
        box.source = { stopGeneration: () => GENERATION };
        return null;
      },
    );
    expect(h.server.writeFrame(a.id, R1, frame({ n: 6 }), swapped.options)).toEqual(NOT_RECOGNIZED);
    box.source = original;
    await Bun.sleep(20);
    expect({ handed: handedA.length, received: raw().byteLength }).toEqual({ handed: 0, received: 0 });
    expect([named, threw, odd, nested, refusedFirst, swapped].map((c) => [c.checks(), c.finals(), c.ends])).toEqual([
      [1, 1, []],
      [1, 1, []],
      [1, 1, []],
      [1, 1, []],
      [1, 0, []],
      [1, 0, []],
    ]);
    expect(h.closedNotes(a.id)).toEqual([]);
    expect(phaseOf(h, a)).toBe("greeted");

    // 같은 연결에 이어서 쓴다: finalCheck가 null이면 쓰고, finalCheck가 없으면 지금과 같이 쓴다.
    const passed = timed(() => null);
    const one = frame({ n: 7 });
    expect(h.server.writeFrame(a.id, R1, one, passed.options)).toEqual(WRITTEN);
    const plain = caller();
    const two = frame({ n: 8 });
    expect(h.server.writeFrame(a.id, R1, two, plain.options)).toEqual(WRITTEN);
    await until(() => a.frames.length === 3 && passed.ends.length + plain.ends.length === 2);
    expect(raw()).toEqual(concat(one, two));
    expect([passed.finals(), passed.ends, plain.ends]).toEqual([1, ["flushed"], ["flushed"]]);

    // finalCheck가 등록표를 적용해 그 연결이 닫혔으면 null을 답해도 넘기지 않는다(서버 자기 기록으로 본다).
    const b = await greet(h, K2, R2);
    const handedB = handedTo(serverSocket(h, b));
    const dropping = timed(() => {
      h.server.applyRegistry({ kind: "content", content: doc(2, [row(K1, "r1", "s1")]) });
      return null;
    });
    expect(h.server.writeFrame(b.id, R2, frame({ n: 9 }), dropping.options)).toEqual({ kind: "not_written", reason: "closed" });
    expect([handedB, dropping.finals(), dropping.ends]).toEqual([[], 1, []]);
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "judgment" }]);
  });

  test("재확인의 마지막 게시 조회가 서버를 닫고 같은 복원기를 돌려주면 finalCheck와 그 시계를 부르지 않고 closed다", async () => {
    const h = await start();
    const a = await greet(h, K1, R1);
    const handedA = handedTo(serverSocket(h, a));
    let reads = 0;
    let closing: Promise<void> | null = null;
    // 처음 읽기는 writeFrame의 인정, 두 번째가 재확인의 마지막 게시 조회다. 그 안에서 닫고 같은 객체를 돌려준다.
    h.onRestorer = () => {
      reads++;
      if (reads === 2) closing = h.server.close();
    };
    let finals = 0;
    let clocks = 0;
    const ends: string[] = [];
    const result = h.server.writeFrame(a.id, R1, frame({ n: 1 }), {
      lastCheck: () => null,
      finalCheck: () => {
        finals++;
        clocks++;
        return null;
      },
      settled: (end) => void ends.push(end),
    });
    h.onRestorer = () => {};
    await closing;
    const closed = result.kind === "not_written" && result.reason === "closed";
    expect(reads === 2 && closing !== null && finals === 0 && clocks === 0 && closed && handedA.length === 0 && ends.length === 0).toBe(true);
  });

  test("넘긴 틀의 끝은 정확히 한 번이다: 완료 오류, 완료 전의 닫힘(상대, 등록표, 서버 종료), 닫힌 뒤 늦게 온 완료", async () => {
    const h = await start();

    // 완료가 오류면 send_failed로 닫고 failed를 한 번.
    const a = await greet(h, K1, R1);
    const lowerA = holdLowerWrite(serverSocket(h, a));
    const ca = caller();
    expect(h.server.writeFrame(a.id, R1, frame({ n: 1 }), ca.options)).toEqual(WRITTEN);
    await until(lowerA.entered);
    expect(ca.ends).toEqual([]);
    lowerA.complete(new Error("시험: 로컬 쓰기 실패"));
    await until(() => ca.ends.length > 0);
    expect(ca.ends).toEqual(["failed"]);
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "send_failed" }]);
    await until(() => a.closed());

    // 상대가 닫는다. 하위 쓰기에 하나, 스트림 버퍼에 하나. 둘 다 closed 한 번이고 뒤늦은 완료는 무시한다.
    const b = await greet(h, K2, R2);
    const lowerB = holdLowerWrite(serverSocket(h, b));
    const [b1, b2] = [caller(), caller()];
    expect(h.server.writeFrame(b.id, R2, frame({ n: 2 }), b1.options)).toEqual(WRITTEN);
    expect(h.server.writeFrame(b.id, R2, frame({ n: 3 }), b2.options)).toEqual(WRITTEN);
    await until(lowerB.entered);
    b.socket.destroy();
    await until(() => h.closedNotes(b.id).length > 0);
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "peer" }]);
    expect([b1.ends, b2.ends]).toEqual([["closed"], ["closed"]]);
    lowerB.complete();
    await Bun.sleep(20);
    expect([b1.ends, b2.ends]).toEqual([["closed"], ["closed"]]);

    // 등록표에서 빠진다. 뒤늦은 완료가 오류여도 그대로다.
    const c = await greet(h, K1, R1);
    const lowerC = holdLowerWrite(serverSocket(h, c));
    const cc = caller();
    expect(h.server.writeFrame(c.id, R1, frame({ n: 4 }), cc.options)).toEqual(WRITTEN);
    await until(lowerC.entered);
    expect(h.server.applyRegistry({ kind: "content", content: doc(2, [row(K2, "r2", "s2")]) }).kind).toBe("applied");
    expect(h.closedNotes(c.id)).toEqual([{ kind: "closed", connection: c.id, cause: "judgment" }]);
    expect(cc.ends).toEqual(["closed"]);
    lowerC.complete(new Error("시험: 닫힌 뒤 온 오류"));
    await Bun.sleep(20);
    expect(cc.ends).toEqual(["closed"]);

    // 서버를 닫는다.
    const d = await greet(h, K2, R2);
    const lowerD = holdLowerWrite(serverSocket(h, d));
    const cd = caller();
    expect(h.server.writeFrame(d.id, R2, frame({ n: 5 }), cd.options)).toEqual(WRITTEN);
    await until(lowerD.entered);
    h.server.tick();
    expect(cd.ends).toEqual([]);
    await h.server.close();
    expect(h.closedNotes(d.id)).toEqual([{ kind: "closed", connection: d.id, cause: "shutdown" }]);
    expect(cd.ends).toEqual(["closed"]);
    lowerD.complete();
    await Bun.sleep(20);
    expect(cd.ends).toEqual(["closed"]);
  });

  test("settled가 던지거나 write가 던져도 다른 연결과 tick·applyRegistry·close가 그대로다. write가 던지면 닫고 모른다고 하며 끝은 한 번이다", async () => {
    const h = await start();
    const a = await greet(h, K1, R1);
    const b = await greet(h, K2, R2);
    let thrown = 0;
    const throwing: WriteFrameOptions = {
      lastCheck: () => null,
      settled: () => {
        thrown++;
        throw new Error("시험: settled 실패");
      },
    };

    // 완료에서 던진다. 연결은 열린 채다.
    expect(h.server.writeFrame(a.id, R1, frame({ n: 1 }), throwing)).toEqual(WRITTEN);
    await until(() => thrown === 1);
    expect(phaseOf(h, a)).toBe("greeted");
    expect(h.closedNotes(a.id)).toEqual([]);

    // 하위 쓰기를 붙든 A에 둘을 넘긴 채 B·박자·등록표가 돈다. A를 닫을 때 둘 다 던져도 각자 한 번씩이다.
    const lowerA = holdLowerWrite(serverSocket(h, a));
    expect(h.server.writeFrame(a.id, R1, frame({ n: 2 }), throwing)).toEqual(WRITTEN);
    expect(h.server.writeFrame(a.id, R1, frame({ n: 3 }), throwing)).toEqual(WRITTEN);
    await until(lowerA.entered);
    const cb = caller();
    expect(h.server.writeFrame(b.id, R2, frame({ n: 4 }), cb.options)).toEqual(WRITTEN);
    await until(() => cb.ends.length > 0 && b.frames.length === 2);
    h.server.tick();
    expect(h.server.applyRegistry({ kind: "content", content: doc(2, [row(K1, "r1", "s1"), row(K2, "r2", "s2")]) }).kind).toBe("applied");
    expect(phaseOf(h, a)).toBe("greeted");
    a.socket.destroy();
    await until(() => h.closedNotes(a.id).length > 0);
    expect(thrown).toBe(3);
    expect(h.server.table().get(a.id)).toBeUndefined();
    expect(h.delivered.filter((o) => o.kind === "withdrawn" && o.connection === a.id)).toHaveLength(1);
    expect(phaseOf(h, b)).toBe("greeted");

    // write가 콜백을 맡은 뒤 던진다. 그 자리에서 닫고 unknown, 끝은 failed 한 번이고 뒤에 온 콜백은 무시한다.
    const sb = serverSocket(h, b);
    const write = sb.write;
    sb.write = function (this: ServerSocket, ...args: unknown[]) {
      (write as (...a: unknown[]) => boolean).apply(this, args);
      throw new Error("시험: write가 던짐");
    } as typeof sb.write;
    const cw = caller();
    expect(h.server.writeFrame(b.id, R2, frame({ n: 5 }), cw.options)).toEqual({ kind: "unknown" });
    expect(cw.ends).toEqual(["failed"]);
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "send_failed" }]);
    await until(() => b.closed());
    await Bun.sleep(20);
    expect(cw.ends).toEqual(["failed"]);
    expect(cb.ends).toEqual(["flushed"]);

    // 서버는 그대로 새 연결을 받아 쓴다.
    h.server.tick();
    const c = await greet(h, K1, R1);
    const cc = caller();
    expect(h.server.writeFrame(c.id, R1, frame({ n: 6 }), cc.options)).toEqual(WRITTEN);
    await until(() => c.frames.length === 2 && cc.ends.length === 1);
    expect(cc.ends).toEqual(["flushed"]);
  });

  test("완료 콜백·write의 예외·닫힘이 어느 순서로 와도 끝은 한 번이다: 완료를 동기로 먼저 알리고 던짐, 던진 뒤 완료", async () => {
    const h = await start();
    type Done = (error?: Error | null) => void;
    // 서버 쪽 소켓의 write를 바꿔 끼운다. 바이트를 하위로 넘기지 않고 콜백만 시험이 정한 때 부른다.
    const throwingWrite = (peer: Peer, before: ((done: Done) => void) | null) => {
      let held: Done | null = null;
      serverSocket(h, peer).write = ((_bytes: Uint8Array, done: Done) => {
        held = done;
        before?.(done);
        throw new Error("시험: write가 던짐");
      }) as unknown as ServerSocket["write"];
      return () => held!;
    };

    // 완료 오류를 동기로 먼저 알리고 던진다.
    const a = await greet(h, K1, R1);
    const rawA = rawOf(a);
    throwingWrite(a, (done) => done(new Error("시험: 동기 완료 오류")));
    const ca = caller();
    expect(h.server.writeFrame(a.id, R1, frame({ n: 1 }), ca.options)).toEqual({ kind: "unknown" });
    expect(ca.ends).toEqual(["failed"]);
    expect(h.closedNotes(a.id)).toEqual([{ kind: "closed", connection: a.id, cause: "send_failed" }]);

    // 정상 완료를 동기로 먼저 알리고 던진다. 끝은 먼저 온 flushed 하나다.
    const b = await greet(h, K2, R2);
    throwingWrite(b, (done) => done(null));
    const cb = caller();
    expect(h.server.writeFrame(b.id, R2, frame({ n: 2 }), cb.options)).toEqual({ kind: "unknown" });
    expect(cb.ends).toEqual(["flushed"]);
    expect(h.closedNotes(b.id)).toEqual([{ kind: "closed", connection: b.id, cause: "send_failed" }]);

    // 던진 뒤에 정상 완료가 온다.
    const c = await greet(h, K1, R1);
    const late = throwingWrite(c, null);
    const cc = caller();
    expect(h.server.writeFrame(c.id, R1, frame({ n: 3 }), cc.options)).toEqual({ kind: "unknown" });
    expect(cc.ends).toEqual(["failed"]);
    late()(null);
    expect(cc.ends).toEqual(["failed"]);
    expect(h.closedNotes(c.id)).toEqual([{ kind: "closed", connection: c.id, cause: "send_failed" }]);

    await until(() => a.closed() && b.closed() && c.closed());
    await Bun.sleep(20);
    expect([ca.ends, cb.ends, cc.ends]).toEqual([["failed"], ["flushed"], ["failed"]]);
    expect(rawA()).toEqual(new Uint8Array(0));
  });
});
