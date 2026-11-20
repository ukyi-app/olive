// 실행기 소켓 조립의 보장 셋: 순서를 지켜 싣고 받기, 새 연결이면 앞 연결의 것을 버리기, 다시 붙기의 간격과 멈춤.
// 루프백(127.0.0.1, 빈 포트)의 실제 상호 TLS로 돈다. 인증서와 키는 시험 안에서 메모리로 만든다(../transport/certs.ts).
// 다시 붙기의 기다림은 가짜 타이머가 쥐고 시험이 직접 부른다(실제 시간으로 기다리지 않는다).
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type * as tls from "node:tls";
import { type Envelope, limits } from "../../src/contract/v1/index.ts";
import type { Connection, Transport } from "../../src/executor/link.ts";
import { createExecutorSocket, type ReconnectPolicy, type SocketEvent } from "../../src/executor/socket.ts";
import { startTlsServer, type TlsServer } from "../../src/supervisor/transport/tls-server.ts";
import { createFrameDecoder, encodeFrame } from "../../src/transport/framing.ts";
import { createTlsClient, type TlsClient } from "../../src/transport/tls-client.ts";
import type { RawTlsMaterial } from "../../src/transport/tls-policy.ts";
import { type Issued, makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../transport/certs.ts";
import { fromSupervisor, gate, type Rig, rig, syncReply } from "./support.ts";

const HOST = "127.0.0.1";
const pki = makePki();
const POLICY: ReconnectPolicy = { initialDelayMs: 100, maxDelayMs: 400, multiplier: 2, jitterRatio: 0 };
const material = (leaf: Issued): RawTlsMaterial => ({ certificatePem: leaf.pem, privateKeyPem: leaf.keyPem, trustBundlePem: pki.ca.pem });

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
}
function made(result: ReturnType<typeof createExecutorSocket>) {
  if (!result.ok) throw new Error(result.reason);
  return result.socket;
}

// port를 주지 않으면 감독 흉내를 새로 띄운다. 주면 그 포트로 붙는다(닫힌 포트 시험).
async function setup(options: { port?: number; policy?: ReconnectPolicy; random?: () => number } = {}): Promise<Setup> {
  let peers: Peer[] = [];
  let port = options.port;
  if (port === undefined) {
    const sup = await supervisor();
    port = sup.server.port;
    peers = sup.peers;
  }
  const r = await rig({ syncTo: null });
  const client = createTlsClient({ address: HOST, port, supervisorDnsName: SUPERVISOR_DNS, supervisorUri: SUPERVISOR_URI, material: material(pki.executor()), now: Date.now });
  cleanup.push(() => client.close());
  const timer = new FakeTimer();
  const events: SocketEvent[] = [];
  const rec = recordingLink(r);
  const socket = made(createExecutorSocket({ client, link: rec.link, policy: options.policy ?? POLICY, timer, random: options.random ?? (() => 0), onEvent: (e) => events.push(e) }));
  cleanup.push(() => socket.stop());
  return { r, peers, client, timer, events, opened: rec.opened, socket };
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
    expect(createExecutorSocket({ client, link: r.link, policy, timer: new FakeTimer(), random: () => 0 }), JSON.stringify(policy)).toEqual({ ok: false, reason: "policy_rejected" });
  }
  expect(createExecutorSocket({ client, link: r.link, policy: POLICY, timer: new FakeTimer(), random: () => 0 }).ok).toBe(true);
});
