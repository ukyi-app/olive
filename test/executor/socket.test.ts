// 실행기 소켓 조립의 보장 셋: 순서를 지켜 싣고 받기, 새 연결이면 앞 연결의 것을 버리기, 다시 붙기의 간격과 멈춤.
// 루프백(127.0.0.1, 빈 포트)의 실제 상호 TLS로 돈다. 인증서와 키는 시험 안에서 메모리로 만든다(../transport/certs.ts).
// 다시 붙기의 기다림은 가짜 타이머가 쥐고 시험이 직접 부른다(실제 시간으로 기다리지 않는다).
import { afterEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import type * as tls from "node:tls";
import { type Envelope, limits } from "../../src/contract/v1/index.ts";
import { type CredentialInbox, createCredentialInbox } from "../../src/executor/credential-inbox.ts";
import type { Connection, Transport } from "../../src/executor/link.ts";
import type { StoreIo } from "../../src/executor/store.ts";
import { createExecutorSocket, type ReceivePolicy, type ReconnectPolicy, type SocketEvent } from "../../src/executor/socket.ts";
import { startTlsServer, type TlsServer } from "../../src/supervisor/transport/tls-server.ts";
import { createFrameDecoder, encodeCredentialFrame, encodeFrame, FRAME_MAX_BODY_BYTES, FRAME_PREFIX_BYTES } from "../../src/transport/framing.ts";
import { createTlsClient, type TlsClient } from "../../src/transport/tls-client.ts";
import type { RawTlsMaterial } from "../../src/transport/tls-policy.ts";
import { type Issued, makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../transport/certs.ts";
import { barrier, fromSupervisor, gate, type Rig, rig, scriptedIo, sha256, syncReply } from "./support.ts";

const HOST = "127.0.0.1";
const pki = makePki();
const POLICY: ReconnectPolicy = { initialDelayMs: 100, maxDelayMs: 400, multiplier: 2, jitterRatio: 0 };
// 받을 수 있는 가장 작은 상한: 틀 하나의 최대 크기.
const RECEIVE: ReceivePolicy = { maxQueuedBytes: FRAME_PREFIX_BYTES + FRAME_MAX_BODY_BYTES };
const material = (leaf: Issued): RawTlsMaterial => ({ certificatePem: leaf.pem, privateKeyPem: leaf.keyPem, trustBundlePem: pki.ca.pem });
const inboxFor = (r: Rig) => createCredentialInbox({ epoch: () => r.link.epoch() });

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("기다리던 상태가 오지 않았다");
    await Bun.sleep(5);
  }
}

const frame = (value: unknown): Uint8Array => {
  const made = encodeFrame(new TextEncoder().encode(JSON.stringify(value)));
  if (!made.ok) throw new Error(made.reason);
  return made.frame;
};
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

// 감독 흉내: 기존 TLS 수신(tls-server.ts) 위에서 받은 틀을 모으고 바이트를 그대로 쓴다.
interface Peer {
  readonly socket: tls.TLSSocket;
  readonly got: Envelope[];
  closed: boolean;
}
async function supervisor(): Promise<{ server: TlsServer; peers: Peer[] }> {
  const peers: Peer[] = [];
  const server = await startTlsServer({
    host: HOST,
    port: 0,
    material: material(pki.supervisor()),
    now: Date.now,
    onConnection: (c) => {
      const decoder = createFrameDecoder();
      const peer: Peer = { socket: c.socket, got: [], closed: false };
      c.socket.on("data", (chunk: Uint8Array) => {
        for (const e of decoder.push(chunk).envelopes) peer.got.push(e.value as Envelope);
      });
      c.socket.once("close", () => (peer.closed = true));
      peers.push(peer);
    },
  });
  cleanup.push(() => server.close());
  return { server, peers };
}

class FakeTimer {
  readonly waits: { ms: number; fire: () => void; cleared: boolean }[] = [];
  set = (fire: () => void, ms: number) => {
    const wait = { ms, fire, cleared: false };
    this.waits.push(wait);
    return wait;
  };
  clear = (handle: unknown) => {
    (handle as { cleared: boolean }).cleared = true;
  };
}

// link를 감싸 연결마다 판단에 닿은 프레임을 적는다. hold가 있으면 그 연결의 receive를 거기서 붙든다.
interface Opened {
  readonly connection: Connection;
  readonly seen: unknown[];
  hold: Promise<void> | undefined;
  // 참이면 그 연결의 receive가 던진다(처리의 실패).
  fail: boolean;
  inFlight: number;
  maxInFlight: number;
}
function recordingLink(r: Rig) {
  const opened: Opened[] = [];
  return {
    opened,
    link: {
      open(transport: Transport): Connection {
        const connection = r.link.open(transport);
        const entry: Opened = { connection, seen: [], hold: undefined, fail: false, inFlight: 0, maxInFlight: 0 };
        const receive = connection.receive.bind(connection);
        connection.receive = async (raw: unknown) => {
          entry.seen.push(raw);
          entry.maxInFlight = Math.max(entry.maxInFlight, ++entry.inFlight);
          try {
            await entry.hold;
            if (entry.fail) throw new Error("처리 실패");
            await receive(raw);
          } finally {
            entry.inFlight--;
          }
        };
        opened.push(entry);
        return connection;
      },
      isCurrent: (connection: Connection) => r.link.isCurrent(connection),
      epoch: () => r.link.epoch(),
    },
  };
}

interface Setup {
  r: Rig;
  peers: Peer[];
  client: TlsClient;
  timer: FakeTimer;
  events: SocketEvent[];
  opened: Opened[];
  socket: ReturnType<typeof made>;
  inbox: CredentialInbox;
  offered: Uint8Array[];
}
function made(result: ReturnType<typeof createExecutorSocket>) {
  if (!result.ok) throw new Error(result.reason);
  return result.socket;
}

// port를 주지 않으면 감독 흉내를 새로 띄운다. 주면 그 포트로 붙는다(닫힌 포트 시험).
// wrap은 소켓이 부르는 connect를 감싼다(시험이 붙기의 결과를 늦게 돌려준다).
async function setup(
  options: { port?: number; policy?: ReconnectPolicy; random?: () => number; io?: Partial<StoreIo>; wrap?: (client: TlsClient) => Pick<TlsClient, "connect"> } = {},
): Promise<Setup> {
  let peers: Peer[] = [];
  let port = options.port;
  if (port === undefined) {
    const sup = await supervisor();
    port = sup.server.port;
    peers = sup.peers;
  }
  const r = await rig({ syncTo: null, io: options.io });
  const client = createTlsClient({ address: HOST, port, supervisorDnsName: SUPERVISOR_DNS, supervisorUri: SUPERVISOR_URI, material: material(pki.executor()), now: Date.now });
  cleanup.push(() => client.close());
  const timer = new FakeTimer();
  const events: SocketEvent[] = [];
  const rec = recordingLink(r);
  const inbox = inboxFor(r);
  // 소켓이 우편함에 넘긴 값의 배열. 연결이 끝난 뒤 0으로 채워졌는지 시험이 본다.
  const offered: Uint8Array[] = [];
  const socket = made(
    createExecutorSocket({
      client: options.wrap?.(client) ?? client,
      link: rec.link,
      inbox: {
        offer: (epoch, credential) => {
          offered.push(credential.value);
          return inbox.offer(epoch, credential);
        },
        dropEpoch: (epoch) => inbox.dropEpoch(epoch),
      },
      policy: options.policy ?? POLICY,
      receive: RECEIVE,
      timer,
      random: options.random ?? (() => 0),
      onEvent: (e) => events.push(e),
    }),
  );
  cleanup.push(() => socket.stop());
  return { r, peers, client, timer, events, opened: rec.opened, socket, inbox, offered };
}

const kinds = (s: Setup) => s.events.map((e) => e.kind);
const closedReasons = (s: Setup) => s.events.flatMap((e) => (e.kind === "closed" ? [e.reason] : []));
const connectings = (s: Setup) => s.events.filter((e) => e.kind === "connecting").length;
const challengeOf = (e: Envelope) => (e.body as { challenge: string }).challenge;
const actionsOf = (peer: Peer) => peer.got.map((e) => e.header.action);

// i번째 연결의 맞춤 요청에 답하고 hello를 기다린다.
async function syncPeer(s: Setup, i: number, generation = 0): Promise<Peer> {
  await until(() => (s.peers[i]?.got.length ?? 0) >= 1);
  const peer = s.peers[i]!;
  peer.socket.write(frame(syncReply(s.r, generation, challengeOf(peer.got[0]!))));
  await until(() => actionsOf(peer).includes("hello"));
  return peer;
}

const query = (s: Setup, requestId: string) =>
  fromSupervisor(s.r.clock, s.r.worker.name, "status_query", { run_ids: [randomUUID()] }, { stop_generation: 0, request_id: requestId });

test("싣고 받기: 맞춤 요청이 연결의 첫 메시지이고, 받은 프레임은 조각이 어떻게 와도 받은 순서대로 하나씩 판단에 닿는다", async () => {
  const s = await setup();
  s.socket.start();
  const peer = await syncPeer(s, 0);
  expect(actionsOf(peer)).toEqual(["stop_sync_request", "hello"]);
  expect(kinds(s)).toEqual(["connecting", "connected", "synced"]);
  expect(s.r.link.live()).toBe(true);

  // 세 프레임을 한 덩어리로 이어 틀의 경계와 무관한 자리에서 셋으로 잘라 따로 쓴다.
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const bytes = concat(...ids.map((id) => frame(query(s, id))));
  for (const [from, to] of [
    [0, 3],
    [3, Math.floor(bytes.length / 2)],
    [Math.floor(bytes.length / 2), bytes.length],
  ] as const) {
    peer.socket.write(bytes.subarray(from, to));
    await Bun.sleep(5);
  }
  await until(() => actionsOf(peer).filter((a) => a === "status_report").length === 3);
  const seen = s.opened[0]!.seen.slice(1).map((raw) => (raw as Envelope).header.request_id);
  expect(seen).toEqual(ids);
  const replies = peer.got.filter((e) => e.header.action === "status_report").map((e) => (e.body as { in_reply_to: string }).in_reply_to);
  expect(replies).toEqual(ids);
  // 앞 프레임의 처리가 끝나기 전에 다음 것을 넘기지 않는다.
  expect(s.opened[0]!.maxInFlight).toBe(1);
  expect(s.opened).toHaveLength(1);
});

test("싣고 받기: 틀이 거절한 바이트는 판단에 닿지 않고 그 연결을 닫는다(같은 조각의 앞 틀도 넘기지 않는다)", async () => {
  const s = await setup();
  s.socket.start();
  const peer = await syncPeer(s, 0);
  const duplicate = new TextEncoder().encode('{"header":{},"header":{}}');
  const bad = new Uint8Array(4 + duplicate.length);
  new DataView(bad.buffer).setUint32(0, duplicate.length, false);
  bad.set(duplicate, 4);
  peer.socket.write(concat(frame(query(s, randomUUID())), bad));
  await until(() => peer.closed);
  await until(() => closedReasons(s).length === 1);
  expect(closedReasons(s)).toEqual(["frame_duplicate_key"]);
  expect(s.opened[0]!.seen).toHaveLength(1);
  expect(actionsOf(peer)).toEqual(["stop_sync_request", "hello"]);
  expect(s.r.link.live()).toBe(false);
  expect(s.opened[0]!.connection.state).toBe("closed");
});

// 자격 값 틀. 값의 비교는 digest로만 단언한다(실패한 단언이 값을 싣지 않게).
const credentialFrame = (runId: string, value: Uint8Array, digest = sha256(value)): Uint8Array => {
  const made = encodeCredentialFrame(runId, digest, value);
  if (!made.ok) throw new Error(made.reason);
  return made.frame;
};
const zeroed = (value: Uint8Array) => value.every((byte) => byte === 0);
// 소켓 안에서만 쥐다 버리는 값(우편함에 넘기지 않은 값)이 0으로 채워졌는지 본다. 그 길이의 배열에 0을 채우는 호출마다
// 채우기 직전의 digest와 배열을 모은다. 길이를 다른 배열과 겹치지 않는 값으로 고른다.
const WIPE_PROBE_BYTES = 777;
function watchWipes(): { wiped: { sum: string; array: Uint8Array }[]; restore: () => void } {
  const wiped: { sum: string; array: Uint8Array }[] = [];
  const original = Uint8Array.prototype.fill;
  Uint8Array.prototype.fill = function (this: Uint8Array, ...args: Parameters<typeof original>) {
    if (this.length === WIPE_PROBE_BYTES && args[0] === 0 && args.length === 1) wiped.push({ sum: sha256(this), array: this });
    return original.apply(this, args);
  } as typeof original;
  const restore = () => {
    Uint8Array.prototype.fill = original;
  };
  cleanup.push(restore);
  return { wiped, restore };
}
const wipedValue = (wiped: { sum: string; array: Uint8Array }[], sum: string) => wiped.some((w) => w.sum === sum && zeroed(w.array));

test("자격 값: 감독이 encodeCredentialFrame으로 만든 틀이 맞춘 뒤 take로 나오고, 같은 조각의 봉투는 줄로 차례대로 가며 값은 link.receive에 닿지 않는다", async () => {
  const s = await setup();
  s.socket.start();
  const peer = await syncPeer(s, 0);
  // 봉투의 처리를 붙든다. 값은 줄을 지나지 않으므로 붙든 동안에도 우편함에 닿는다.
  const held = gate();
  s.opened[0]!.hold = held.wait;
  const runId = randomUUID();
  const value = randomBytes(300);
  const ids = [randomUUID(), randomUUID()];
  peer.socket.write(concat(frame(query(s, ids[0]!)), credentialFrame(runId, value), frame(query(s, ids[1]!))));
  await until(() => s.offered.length === 1);
  const got = await s.inbox.take(runId, sha256(value), new AbortController().signal);
  expect(got === null ? null : sha256(got)).toBe(sha256(value));
  expect(s.opened[0]!.inFlight).toBe(1);
  held.open();
  await until(() => actionsOf(peer).filter((a) => a === "status_report").length === 2);
  // 판단에 닿은 것은 맞춤 답과 두 봉투뿐이고 받은 차례 그대로다.
  expect(s.opened[0]!.seen).toHaveLength(3);
  expect(s.opened[0]!.seen.slice(1).map((raw) => (raw as Envelope).header.request_id)).toEqual(ids);

  // take가 먼저 기다리면 늦게 온 값을 내준다.
  const later = randomUUID();
  const lateValue = randomBytes(200);
  const waiting = s.inbox.take(later, sha256(lateValue), new AbortController().signal);
  peer.socket.write(credentialFrame(later, lateValue));
  const late = await waiting;
  expect(late === null ? null : sha256(late)).toBe(sha256(lateValue));
  expect(s.opened[0]!.seen).toHaveLength(3);
  expect(closedReasons(s)).toEqual([]);
  expect(s.r.link.live()).toBe(true);
});

test("자격 값: 맞추기 전의 값 틀은 우편함에 넘기지 않고 0으로 채운 뒤 credential_not_synced로 그 연결을 닫는다", async () => {
  const s = await setup();
  const probe = watchWipes();
  s.socket.start();
  await until(() => (s.peers[0]?.got.length ?? 0) >= 1);
  const value = randomBytes(WIPE_PROBE_BYTES);
  s.peers[0]!.socket.write(credentialFrame(randomUUID(), value));
  await until(() => closedReasons(s).length === 1);
  probe.restore();
  expect(closedReasons(s)).toEqual(["credential_not_synced"]);
  expect(s.offered).toHaveLength(0);
  expect(wipedValue(probe.wiped, sha256(value))).toBe(true);
  expect(s.opened[0]!.seen).toHaveLength(0);
  expect(s.opened[0]!.connection.state).toBe("closed");
});

test("자격 값: 거절과 함께 온 앞선 정상 값은 넘기지 않고 0으로 채운다", async () => {
  const s = await setup();
  s.socket.start();
  const peer = await syncPeer(s, 0);
  const probe = watchWipes();
  const value = randomBytes(WIPE_PROBE_BYTES);
  // 정상 값 틀 바로 뒤에 모르는 종류의 바이트.
  peer.socket.write(concat(credentialFrame(randomUUID(), value), Uint8Array.of(0x07)));
  await until(() => closedReasons(s).length === 1);
  probe.restore();
  expect(closedReasons(s)).toEqual(["frame_unknown_kind"]);
  expect(s.offered).toHaveLength(0);
  expect(wipedValue(probe.wiped, sha256(value))).toBe(true);
  expect(s.opened[0]!.seen).toHaveLength(1);
});

test("자격 값: 연결이 끝나면 우편함의 칸이 비고 그 값은 0으로 채워지며, 그 뒤의 take는 내받지 못한다", async () => {
  const s = await setup();
  s.socket.start();
  const peer = await syncPeer(s, 0);
  const runId = randomUUID();
  const value = randomBytes(64);
  peer.socket.write(credentialFrame(runId, value));
  await until(() => s.offered.length === 1);
  expect(zeroed(s.offered[0]!)).toBe(false);
  peer.socket.destroy();
  await until(() => closedReasons(s).length === 1);
  expect(zeroed(s.offered[0]!)).toBe(true);
  expect(await s.inbox.take(runId, sha256(value), new AbortController().signal)).toBeNull();
});

test("새 연결: 앞 연결이 끝나면 그 대기값과 남은 프레임을 버리고, 늦게 끝난 처리는 새 연결의 맞춤이 되지 않는다", async () => {
  const s = await setup();
  s.socket.start();
  await until(() => (s.peers[0]?.got.length ?? 0) >= 1);
  const a = s.peers[0]!;
  const challengeA = challengeOf(a.got[0]!);
  // 앞 연결의 맞춤 답 처리를 붙들어 둔 채 그 뒤에 지시 하나를 함께 보낸다.
  const held = gate();
  s.opened[0]!.hold = held.wait;
  a.socket.write(concat(frame(syncReply(s.r, 0, challengeA)), frame(query(s, randomUUID()))));
  await until(() => s.opened[0]!.seen.length === 1);
  a.socket.destroy();
  await until(() => closedReasons(s).length === 1);
  // 다시 붙기 전, 끝난 바로 그때 앞 연결의 challenge는 버려졌다.
  const old = s.opened[0]!.connection;
  expect(old.state).toBe("closed");
  expect(old.pending()).toBeNull();
  expect(s.timer.waits).toHaveLength(1);

  s.timer.waits[0]!.fire();
  await until(() => (s.peers[1]?.got.length ?? 0) >= 1);
  const b = s.peers[1]!;
  const challengeB = challengeOf(b.got[0]!);
  expect(actionsOf(b)).toEqual(["stop_sync_request"]);
  expect(challengeB).not.toBe(challengeA);
  expect(s.opened).toHaveLength(2);

  // 붙들었던 앞 연결의 처리가 이제 끝난다. 그 결과도, 그 연결에 남았던 지시도 쓰이지 않는다.
  held.open();
  await Bun.sleep(30);
  expect(s.opened[0]!.seen).toHaveLength(1);
  expect(s.r.link.live()).toBe(false);
  expect(s.opened[1]!.connection.state).toBe("syncing");
  expect(kinds(s)).not.toContain("synced");
  // 앞 연결의 challenge를 담은 답은 새 연결에서 맞춤이 되지 않는다. 새 challenge의 답만 된다.
  b.socket.write(frame(syncReply(s.r, 0, challengeA)));
  await Bun.sleep(30);
  expect(s.r.link.live()).toBe(false);
  b.socket.write(frame(syncReply(s.r, 0, challengeB)));
  await until(() => actionsOf(b).includes("hello"));
  expect(s.r.link.live()).toBe(true);
  expect(actionsOf(a)).toEqual(["stop_sync_request"]);
});

test("새 연결: 앞 처리가 멈춘 채 감독이 닫아도 그 끝을 알아채 다시 붙고, 늦게 풀린 앞 처리의 nonce 쓰기가 오류 없이 끝나면 새 연결에 아무것도 바꾸지 않는다", async () => {
  const disk = scriptedIo();
  const s = await setup({ io: disk.io });
  s.socket.start();
  const a = await syncPeer(s, 0);
  // 맞춘 연결에서 정상 조회의 nonce 처리(검증 안)를 붙든다.
  const consuming = barrier();
  disk.markers.gate = consuming;
  a.socket.write(frame(query(s, randomUUID())));
  await consuming.entered;
  // 두 번째 조회는 따로 쓴다. 같은 조각이면 앞 조회와 함께 이미 디코더를 지나 줄에 들어간다.
  await new Promise<void>((done) => a.socket.write(frame(query(s, randomUUID())), () => done()));
  a.socket.destroy();
  await until(() => a.closed);

  // 앞 처리를 풀지 않은 채로 끝을 알아채고 다시 붙기를 건다.
  await until(() => s.timer.waits.length === 1);
  expect(closedReasons(s)).toEqual(["peer_ended"]);
  expect(s.socket.phase()).toBe("waiting");
  expect(s.opened[0]!.inFlight).toBe(1);
  expect(s.opened[0]!.connection.state).toBe("closed");
  expect(s.r.link.live()).toBe(false);
  s.timer.waits[0]!.fire();
  await until(() => (s.peers[1]?.got.length ?? 0) >= 1);
  const b = s.peers[1]!;
  expect(actionsOf(b)).toEqual(["stop_sync_request"]);
  const events = [...s.events];
  const pendingB = s.opened[1]!.connection.pending();

  // 이제 앞 처리를 푼다. 답을 새 연결에 쓰지 않고, 새 연결의 맞춤 상태와 다시 붙기의 간격을 바꾸지 않는다.
  disk.markers.gate = undefined;
  consuming.open();
  await until(() => s.opened[0]!.inFlight === 0);
  await until(() => s.client.openConnections() === 1);
  expect(s.opened[0]!.seen).toHaveLength(2);
  expect(s.events).toEqual(events);
  expect(s.timer.waits).toHaveLength(1);
  expect(s.opened[1]!.connection.state).toBe("syncing");
  expect(s.opened[1]!.connection.pending()).toEqual(pendingB);
  expect(actionsOf(b)).toEqual(["stop_sync_request"]);
  // 새 연결은 자기 challenge의 답으로 맞추고, 앞 연결의 조회 답은 그 뒤에도 실리지 않는다.
  b.socket.write(frame(syncReply(s.r, 0, challengeOf(b.got[0]!))));
  await until(() => actionsOf(b).includes("hello"));
  expect(actionsOf(b)).toEqual(["stop_sync_request", "hello"]);
  expect(actionsOf(a)).toEqual(["stop_sync_request", "hello"]);
  expect(s.opened).toHaveLength(2);
});

// 저장소가 고장 나면 nonce의 한 번 사용을 보장할 수 없어 어느 연결이든 닫는다(store.ts의 전역 장애 통지 → worker → link).
// 그래서 늦게 풀린 앞 처리가 저장 오류로 끝나면 그때의 연결, 곧 새 연결이 닫힌다. 이 동작을 그대로 고정한다.
test("새 연결: 늦게 풀린 앞 처리가 저장소의 오류로 끝나면 전역 장애 통지가 새 연결을 닫고 다음 간격으로 다시 붙기를 건다. 옛 조회의 답은 싣지 않는다", async () => {
  const disk = scriptedIo();
  const s = await setup({ io: disk.io });
  s.socket.start();
  const a = await syncPeer(s, 0);
  const consuming = barrier();
  disk.markers.gate = consuming;
  a.socket.write(frame(query(s, randomUUID())));
  await consuming.entered;
  // 감독이 조회 하나를 더 보내고 닫는다.
  a.socket.end(frame(query(s, randomUUID())));
  await until(() => a.closed && s.timer.waits.length === 1);
  expect(closedReasons(s)).toEqual(["peer_ended"]);
  expect(s.opened[0]!.inFlight).toBe(1);
  s.timer.waits[0]!.fire();
  await until(() => (s.peers[1]?.got.length ?? 0) >= 1);
  const b = s.peers[1]!;
  const connectionB = s.opened[1]!.connection;
  expect(actionsOf(b)).toEqual(["stop_sync_request"]);
  expect(connectionB.state).toBe("syncing");
  expect(connectionB.pending()).not.toBeNull();

  // 앞 연결의 nonce 쓰기만 저장 오류로 끝낸다. B는 아직 아무것도 검증하지 않았다.
  disk.markers.gate = undefined;
  disk.markers.failing = true;
  consuming.open();
  await until(() => s.opened[0]!.inFlight === 0);
  disk.markers.failing = false;
  await until(() => b.closed && s.timer.waits.length === 2);
  expect(closedReasons(s)).toEqual(["peer_ended", "link_closed"]);
  expect(connectionB.state).toBe("closed");
  expect(connectionB.pending()).toBeNull();
  expect(s.r.store.healthy()).toBe(false);
  expect(s.socket.phase()).toBe("waiting");
  // 맞추지 못한 연결 뒤이므로 기준값은 는다.
  expect(s.timer.waits.map((w) => w.ms)).toEqual([100, 200]);
  expect(kinds(s).filter((k) => k === "synced")).toHaveLength(1);
  // 옛 조회의 답은 어느 연결에도 실리지 않는다. 둘째 조회는 판단에 닿지 않았다.
  expect(actionsOf(b)).toEqual(["stop_sync_request"]);
  expect(actionsOf(a)).toEqual(["stop_sync_request", "hello"]);
  expect(s.opened[0]!.seen).toHaveLength(2);
});

test("받기: 처리를 기다리는 받은 틀이 상한을 넘으면 그 연결만 닫고 넘친 틀은 판단에 닿지 않는다", async () => {
  const s = await setup();
  s.socket.start();
  const a = await syncPeer(s, 0);
  const held = gate();
  s.opened[0]!.hold = held.wait;
  a.socket.write(frame(query(s, randomUUID())));
  await until(() => s.opened[0]!.seen.length === 2);
  // 상한은 틀 하나의 최대 크기다. 이 틀 하나는 들고 둘이면 넘는다.
  const pad = frame({ pad: "x".repeat(40_000) });
  expect(pad.length).toBeLessThanOrEqual(RECEIVE.maxQueuedBytes);
  expect(2 * pad.length).toBeGreaterThan(RECEIVE.maxQueuedBytes);
  a.socket.write(pad);
  a.socket.write(pad);
  await until(() => closedReasons(s).length === 1);
  expect(closedReasons(s)).toEqual(["receive_backlog"]);
  await until(() => a.closed);
  expect(s.timer.waits.map((w) => w.ms)).toEqual([100]);
  expect(s.opened[0]!.connection.state).toBe("closed");
  held.open();
  await until(() => s.opened[0]!.inFlight === 0);
  expect(s.opened[0]!.seen).toHaveLength(2);
  expect(s.timer.waits).toHaveLength(1);
});

test("닫기: link가 그 연결을 닫으면(맞춤 기한) 소켓도 닫고, 받은 것의 처리가 던지면 그 연결을 닫는다. 둘 다 간격을 두고 다시 붙는다", async () => {
  const s = await setup();
  s.socket.start();
  await until(() => (s.peers[0]?.got.length ?? 0) >= 1);
  // 감독이 답하지 않는다. 맞춤 기한(link.ts의 판단)이 그 연결을 닫는다.
  s.r.clock.advance(limits.STOP_SYNC_WAIT_MS);
  s.r.link.tick();
  await until(() => s.peers[0]!.closed);
  expect(closedReasons(s)).toEqual(["link_closed"]);
  expect(s.timer.waits.map((w) => w.ms)).toEqual([100]);

  s.timer.waits[0]!.fire();
  await until(() => (s.peers[1]?.got.length ?? 0) >= 1);
  s.opened[1]!.fail = true;
  const b = s.peers[1]!;
  b.socket.write(frame(syncReply(s.r, 0, challengeOf(b.got[0]!))));
  await until(() => b.closed);
  expect(closedReasons(s)).toEqual(["link_closed", "receive_failed"]);
  expect(s.opened[1]!.connection.state).toBe("closed");
  expect(s.r.link.live()).toBe(false);
  expect(s.timer.waits.map((w) => w.ms)).toEqual([100, 200]);
});

test("다시 붙기: 간격은 처음에서 곱해 상한까지 늘고, 타이머가 부르기 전에는 붙지 않는다. 무작위는 정한 비율 안에서만 덜어 낸다", async () => {
  // 닫힌 포트: 붙기가 바로 실패한다.
  const gone = await startTlsServer({ host: HOST, port: 0, material: material(pki.supervisor()), now: Date.now, onConnection: () => {} });
  const port = gone.port;
  await gone.close();

  const s = await setup({ port });
  s.socket.start();
  const delays: number[] = [];
  for (let i = 1; i <= 4; i++) {
    await until(() => s.timer.waits.length === i);
    expect(connectings(s)).toBe(i);
    expect(s.socket.phase()).toBe("waiting");
    delays.push(s.timer.waits[i - 1]!.ms);
    s.timer.waits[i - 1]!.fire();
  }
  expect(delays).toEqual([100, 200, 400, 400]);
  expect(s.events.filter((e) => e.kind === "connect_failed").map((e) => (e as { reason: string }).reason)).toEqual(["tls_error", "tls_error", "tls_error", "tls_error"]);

  const j = await setup({ port, policy: { initialDelayMs: 1_000, maxDelayMs: 1_000, multiplier: 1, jitterRatio: 0.5 }, random: () => 0.5 });
  j.socket.start();
  await until(() => j.timer.waits.length === 1);
  expect(j.timer.waits[0]!.ms).toBe(750);
  // 무작위가 범위 밖이면 덜지 않는다.
  const k = await setup({ port, policy: { initialDelayMs: 1_000, maxDelayMs: 1_000, multiplier: 1, jitterRatio: 0.5 }, random: () => 1 });
  k.socket.start();
  await until(() => k.timer.waits.length === 1);
  expect(k.timer.waits[0]!.ms).toBe(1_000);
});

test("다시 붙기: 맞춤을 끝낸 연결 뒤에만 처음 간격으로 돌아간다. TLS만 붙고 맞추지 못한 연결은 실패로 센다", async () => {
  const s = await setup();
  s.socket.start();
  const a = await syncPeer(s, 0);
  a.socket.destroy();
  await until(() => s.timer.waits.length === 1);
  s.timer.waits[0]!.fire();
  await until(() => (s.peers[1]?.got.length ?? 0) >= 1);
  s.peers[1]!.socket.destroy();
  await until(() => s.timer.waits.length === 2);
  s.timer.waits[1]!.fire();
  const c = await syncPeer(s, 2);
  c.socket.destroy();
  await until(() => s.timer.waits.length === 3);
  expect(s.timer.waits.map((w) => w.ms)).toEqual([100, 200, 100]);
  expect(s.events.filter((e) => e.kind === "synced").map((e) => (e as { attempt: number }).attempt)).toEqual([1, 3]);
});

test("멈춤: 열린 소켓을 닫고 더 붙지 않는다. 기다리는 중이나 붙는 중에 멈춰도 같다", async () => {
  const s = await setup();
  s.socket.start();
  const peer = await syncPeer(s, 0);
  await s.socket.stop();
  expect(s.socket.phase()).toBe("stopped");
  await until(() => peer.closed);
  await until(() => s.client.openConnections() === 0);
  expect(s.r.link.live()).toBe(false);
  expect(closedReasons(s)).toEqual(["stopped"]);
  expect(s.timer.waits).toHaveLength(0);
  expect(kinds(s).at(-1)).toBe("stopped");
  s.socket.start();
  await Bun.sleep(30);
  expect(connectings(s)).toBe(1);

  // 기다리는 중: 걸어 둔 기다림을 거두고, 타이머가 늦게 불러도 붙지 않는다.
  const gone = await startTlsServer({ host: HOST, port: 0, material: material(pki.supervisor()), now: Date.now, onConnection: () => {} });
  const port = gone.port;
  await gone.close();
  const w = await setup({ port });
  w.socket.start();
  await until(() => w.timer.waits.length === 1);
  await w.socket.stop();
  expect(w.timer.waits[0]!.cleared).toBe(true);
  w.timer.waits[0]!.fire();
  await Bun.sleep(30);
  expect(connectings(w)).toBe(1);

  // 붙는 중: 그 붙기를 거두고 늦게 끝난 결과로 link를 열지 않는다.
  const p = await setup();
  p.socket.start();
  await p.socket.stop();
  await Bun.sleep(50);
  expect(p.opened).toHaveLength(0);
  expect(p.timer.waits).toHaveLength(0);
  await until(() => p.client.openConnections() === 0);
});

test("멈춤: 열린 연결에서 연달아 부른 둘째 stop()도 소켓의 close 뒤에 돌아온다", async () => {
  const s = await setup();
  s.socket.start();
  await syncPeer(s, 0);
  const first = s.socket.stop();
  await s.socket.stop();
  expect(s.client.openConnections()).toBe(0);
  await first;
  expect(closedReasons(s)).toEqual(["stopped"]);
});

test("멈춤: link가 먼저 닫아 기다림으로 바뀐 직후의 stop()도 그 소켓의 close 뒤에 돌아온다", async () => {
  const s = await setup();
  s.socket.start();
  await until(() => (s.peers[0]?.got.length ?? 0) >= 1);
  s.r.clock.advance(limits.STOP_SYNC_WAIT_MS);
  s.r.link.tick();
  expect(closedReasons(s)).toEqual(["link_closed"]);
  expect(s.socket.phase()).toBe("waiting");
  await s.socket.stop();
  expect(s.client.openConnections()).toBe(0);
  expect(s.timer.waits[0]!.cleared).toBe(true);
});

test("멈춤: 멈춘 뒤 늦게 돌아온 검증된 소켓도 link에 열지 않고, stop()은 그 소켓의 close 뒤에 돌아온다", async () => {
  const late = gate();
  const s = await setup({
    wrap: (client) => ({
      // 신호를 넘기지 않아 TLS는 끝까지 맺고, 그 결과만 시험이 열 때까지 늦춘다.
      connect: async () => {
        const verified = await client.connect();
        await late.wait;
        return verified;
      },
    }),
  });
  s.socket.start();
  await until(() => s.client.openConnections() === 1);
  const stopping = s.socket.stop();
  late.open();
  await stopping;
  expect(s.client.openConnections()).toBe(0);
  expect(s.opened).toHaveLength(0);
  expect(s.timer.waits).toHaveLength(0);
  expect(kinds(s)).toEqual(["connecting", "stopped"]);
});

test("멈춤: 검증은 끝났고 반환만 늦은 소켓을 감독이 끝내는 중에 넘겨받아도 stop()은 그 소켓의 실제 close 뒤에 돌아온다", async () => {
  const verifiedReady = gate();
  const closing = gate();
  let closeHeard = false;
  let atHandOver: { closed: boolean; closeHeard: boolean } | undefined;
  const s = await setup({
    wrap: (client) => ({
      connect: async () => {
        const verified = await client.connect();
        const raw = verified.socket;
        raw.once("close", () => (closeHeard = true));
        // 감독의 끝을 받은 소켓이 스스로 destroy를 부른 차례에 결과를 넘긴다. 그때 closed는 이미 참이지만
        // close 사건은 아직 오지 않았다.
        const destroy = raw.destroy.bind(raw);
        raw.destroy = (error?: Error) => {
          destroy(error);
          atHandOver ??= { closed: raw.closed, closeHeard };
          closing.open();
          return raw;
        };
        verifiedReady.open();
        await closing.wait;
        return verified;
      },
    }),
  });
  s.socket.start();
  await verifiedReady.wait;
  await until(() => s.peers.length === 1);
  const stopping = s.socket.stop();
  s.peers[0]!.socket.end();
  await stopping;
  // 겨냥한 차례가 실제로 만들어졌다.
  expect(atHandOver).toEqual({ closed: true, closeHeard: false });
  expect(closeHeard).toBe(true);
  expect(s.client.openConnections()).toBe(0);
  expect(s.opened).toHaveLength(0);
  expect(s.timer.waits).toHaveLength(0);
});

// bun test는 처리되지 않은 거절을 그때 돌던 시험의 실패로 센다(unhandledRejection을 들어도 같다). 그래서 이 시험은
// 거절이 처리되지 않으면 그 자체로 실패하고, 더해 돌려준 약속마다 거절 처리기가 붙었는지를 직접 센다.
test("기록: 비동기 기록 콜백이 실패해도 처리되지 않은 거절로 나가지 않고 연결의 수명을 바꾸지 않는다", async () => {
  const r = await rig({ syncTo: null });
  const timer = new FakeTimer();
  const returned: Promise<void>[] = [];
  let handled = 0;
  const socket = made(
    createExecutorSocket({
      client: { connect: () => Promise.reject(new Error("붙지 않는다")) },
      link: r.link,
      inbox: inboxFor(r),
      policy: POLICY,
      receive: RECEIVE,
      timer,
      random: () => 0,
      onEvent: () => {
        const failing = Promise.reject(new Error("기록 실패"));
        const then = failing.then.bind(failing);
        failing.then = ((onFulfilled, onRejected) => {
          if (typeof onRejected === "function") handled++;
          return then(onFulfilled, onRejected);
        }) as typeof failing.then;
        returned.push(failing);
        return failing;
      },
    }),
  );
  socket.start();
  await until(() => timer.waits.length === 1);
  // connecting, connect_failed, retry_scheduled
  expect(returned).toHaveLength(3);
  expect(handled).toBe(3);
  expect(socket.phase()).toBe("waiting");
  // 처리되지 않은 거절이 있었다면 실행기가 알아챌 차례(매크로태스크 한 바퀴)를 이 시험 안에서 지난다.
  await new Promise((done) => setImmediate(done));
  await socket.stop();
  expect(handled).toBe(4);
});

test("정책: 간격의 숫자가 범위 밖이면 소켓을 만들지 않고 구별된 거절을 낸다", async () => {
  const r = await rig({ syncTo: null });
  const client = { connect: () => Promise.reject(new Error("붙지 않는다")) };
  const bad: ReconnectPolicy[] = [
    { ...POLICY, initialDelayMs: 0 },
    { ...POLICY, initialDelayMs: 1.5 },
    { ...POLICY, maxDelayMs: 50 },
    { ...POLICY, maxDelayMs: 2_147_483_648 },
    { ...POLICY, multiplier: 0.5 },
    { ...POLICY, multiplier: Number.POSITIVE_INFINITY },
    { ...POLICY, jitterRatio: 1 },
    { ...POLICY, jitterRatio: -0.1 },
    { ...POLICY, initialDelayMs: Number.NaN },
  ];
  for (const policy of bad) {
    expect(createExecutorSocket({ client, link: r.link, inbox: inboxFor(r), policy, receive: RECEIVE, timer: new FakeTimer(), random: () => 0 }), JSON.stringify(policy)).toEqual({ ok: false, reason: "policy_rejected" });
  }
  // 받아 둘 양의 상한: 틀 하나의 최대 크기보다 작거나 정수가 아니면 거절한다.
  const badReceive: ReceivePolicy[] = [
    { maxQueuedBytes: RECEIVE.maxQueuedBytes - 1 },
    { maxQueuedBytes: RECEIVE.maxQueuedBytes + 0.5 },
    { maxQueuedBytes: Number.NaN },
    { maxQueuedBytes: Number.POSITIVE_INFINITY },
  ];
  for (const receive of badReceive) {
    expect(createExecutorSocket({ client, link: r.link, inbox: inboxFor(r), policy: POLICY, receive, timer: new FakeTimer(), random: () => 0 }), JSON.stringify(receive)).toEqual({ ok: false, reason: "policy_rejected" });
  }
  expect(createExecutorSocket({ client, link: r.link, inbox: inboxFor(r), policy: POLICY, receive: RECEIVE, timer: new FakeTimer(), random: () => 0 }).ok).toBe(true);
});
