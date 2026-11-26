// 결과 없음 판정의 마지막 경계(D-113·D-123)를 실제 상호 TLS 연결 서버와 중계로 본다. 감독 쪽 TCP 상대가 중계이면 실행기가 사라져도 중계의
// 커널이 TCP 탐침에 답해 연결은 인정된 채 남는다. 그 연결 번호만으로 판정하면 실행기가 다시 보낼 결과를 영구히 거절한다. 그래서 결과 없음
// 판정은 그 연결에서 실행기가 실제로 답한 상태 조회를 본다(result-check.ts의 ResultReach.answeredAt).
// 감독은 실제 조립(boot.ts)과 실제 박자 여섯이고, 장부 시계(w.wall)와 단조 시계(w.time)는 시험이 옮긴다: 실시간을 기다리지 않고 같은 경계를
// 본다. 서버는 루프백의 빈 포트에서 연다. 인증서는 메모리로 만든다(test/transport/certs.ts). 실행기 쪽은 tls-client.ts와 바이트 틀로 흉내 내고
// 봉투는 계약 v1로 실제 서명한다.
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import * as net from "node:net";
import type * as tls from "node:tls";
import { type Envelope, limits, type NonceStore, rawPublicKey, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import { RESULT_CHECK } from "../../../src/main/supervisor.ts";
import type { BootResult } from "../../../src/supervisor/runtime/boot.ts";
import { type RegistrySettings, RegistryState } from "../../../src/supervisor/transport/registry.ts";
import { type ConnectionServer, type Delivered, type ServerNote, startConnectionServer } from "../../../src/supervisor/transport/server.ts";
import { createFrameDecoder, encodeFrame } from "../../../src/transport/framing.ts";
import { KEEPALIVE_OPTIONS } from "../../../src/transport/keepalive.ts";
import { libcSocketOptions, type SocketOptionName } from "../../../src/transport/keepalive-ffi.ts";
import { createTlsClient } from "../../../src/transport/tls-client.ts";
import type { RawTlsMaterial } from "../../../src/transport/tls-policy.ts";
import { digest, from, id, must, worker } from "../../ledger/helpers.ts";
import { type Issued, makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../../transport/certs.ts";
import { type World, world } from "./boot-world.ts";

const HOST = "127.0.0.1";
const pki = makePki();
const material = (leaf: Issued): RawTlsMaterial => ({ certificatePem: leaf.pem, privateKeyPem: leaf.keyPem, trustBundlePem: pki.ca.pem });
const SUP = generateKeyPairSync("ed25519");
const K1 = generateKeyPairSync("ed25519");
const R1 = "executor/isolated_reader/r1/s1";
const registrySettings: RegistrySettings = { environment: "home", targets: [{ target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] }] };
const RENEW = limits.RENEW_INTERVAL_MS;
const WAIT = RESULT_CHECK.reportWaitMs;

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

function registry(): RegistryState {
  const row = { target: "reader", role: "isolated_reader", instance: "r1", storage: "s1", public_key: rawPublicKey(K1.publicKey), active: true };
  const outcome = RegistryState.start(registrySettings).apply({ kind: "content", content: new TextEncoder().encode(JSON.stringify({ environment: "home", revision: 1, executors: [row] })) });
  if (outcome.kind !== "applied") throw new Error("시험 등록표가 적용되지 않았다");
  return outcome.state;
}

const hex32 = () => crypto.getRandomValues(new Uint8Array(16)).reduce((text, byte) => text + byte.toString(16).padStart(2, "0"), "");
function seal(key: KeyObject, action: string, generation: number, at: number, body: unknown): Envelope {
  return sealEnvelope({ sender: R1, recipient: "supervisor", action, request_id: id(), stop_generation: generation, run_generation: 0, issued_at: at, nonce: hex32(), body } as never, key);
}
function frame(envelope: unknown): Uint8Array {
  const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(envelope)));
  if (!encoded.ok) throw new Error(encoded.reason);
  return encoded.frame;
}

interface Peer {
  readonly id: number;
  readonly socket: tls.TLSSocket;
  readonly frames: Envelope[];
  closed(): boolean;
  send(envelope: Envelope): void;
}

// 감독(실제 조립)을 기동해 5단계까지 받아들이고, 그 조립의 서버 자리(가짜 서버)를 실제 연결 서버에 잇는다. 서버의 시계·복원기·실행 세대·
// deliver는 조립이 넘긴 그 값이다. 장부 시계는 실제 시각 근처에서 시작한다: 서버가 같은 시계로 TLS 인증서 기간과 봉투 시각을 본다.
async function supervised() {
  const w: World = world({ settings: { resultCheck: RESULT_CHECK } });
  w.wall = Date.now();
  const result: BootResult = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  cleanup.push(() => result.running.stop());
  await w.time.flush();
  for (let i = 0; i < 20 && !w.events.some((e) => e.event === "restore_step" && e.fields.step === 5); i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
  const ledger = w.opened;
  if (ledger === null) throw new Error("장부를 열지 않았다");
  const options = w.fake.options!;
  const seen = new Set<string>();
  const nonces: NonceStore = {
    consume(sender, nonce) {
      const key = `${sender} ${nonce}`;
      const fresh = !seen.has(key);
      seen.add(key);
      return fresh;
    },
  };
  const forwards: Delivered[] = [];
  const notes: ServerNote[] = [];
  const started = await startConnectionServer({
    host: HOST,
    port: 0,
    material: material(pki.supervisor()),
    clock: options.clock,
    registry: registry(),
    restorer: options.restorer,
    runGeneration: options.runGeneration,
    nonces,
    reply: { seal: (input) => sealEnvelope(input, SUP.privateKey), requestId: id, nonce: hex32 },
    deliver: (output) => {
      if (output.kind === "forward") forwards.push(output);
      options.deliver(output);
    },
    observe: (note) => notes.push(note),
    maxPendingWriteBytes: limits.MAX_MESSAGE_BYTES,
  });
  if (!started.ok) throw new Error(`서버가 시작하지 않았다: ${started.failure.kind}`);
  const server: ConnectionServer = started.server;
  cleanup.push(() => server.close());
  // 조립이 실은 상태 조회(연결 번호와 요청 ID).
  const queries: { connection: number; written: boolean }[] = [];
  Object.assign(w.fake.server, {
    recognized: (principal: string) => server.recognized(principal),
    table: () => server.table(),
    tick: () => server.tick(),
    closeConnection: (connection: number) => server.closeConnection(connection),
    writeFrame: (...args: Parameters<ConnectionServer["writeFrame"]>) => {
      const written = server.writeFrame(...args);
      queries.push({ connection: args[0], written: written.kind === "written" });
      return written;
    },
  });
  const marks: unknown[] = [];
  const mark = ledger.markResult.bind(ledger);
  ledger.markResult = (input) => {
    marks.push(input);
    return mark(input);
  };
  // 작업자 실행을 지금 시작·접수하고 1ms 뒤 completed 종료 영수증으로 checking까지 옮긴다. 지정 실행기는 R1이다.
  const at = w.wall;
  const admitted = must(ledger.admitRun(worker({ now: at, deadlineAt: at + 3_600_000, executorId: R1, role: "isolated_reader" }))).run;
  const requestId = id();
  must(ledger.startRun({ runId: admitted.runId, requestId, stopGeneration: 0, now: at }));
  const sender = from(admitted);
  must(ledger.applyReceipt({ action: "receipt_accepted", instruction: "task_start", receiptId: id(), runId: admitted.runId, instructionRequestId: requestId, bodyDigest: digest(`accepted:${admitted.runId}`), now: at }, sender));
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: admitted.runId, exit: "completed", bodyDigest: digest(`stopped:${admitted.runId}`), now: at + 1 }, sender));
  const run = { runId: admitted.runId, from: sender, since: at + 1 };

  // 실행기 하나가 붙어 맞춤과 인사를 마친다. 서버가 그 연결을 인정한 뒤에 돌려준다.
  async function connect(port = server.port): Promise<Peer> {
    const client = createTlsClient({ address: HOST, port, supervisorDnsName: SUPERVISOR_DNS, supervisorUri: SUPERVISOR_URI, material: material(pki.executor()), now: Date.now });
    cleanup.push(() => client.close());
    const opened = () => notes.filter((note): note is Extract<ServerNote, { kind: "opened" }> => note.kind === "opened");
    const before = opened().length;
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
    await until(() => opened().length > before);
    const connection = opened().at(-1)!.connection;
    const peer: Peer = { id: connection, socket, frames, closed: () => closed, send: (envelope) => socket.write(frame(envelope)) };
    peer.send(seal(K1.privateKey, "stop_sync_request", 0, w.wall, { challenge: hex32() }));
    await until(() => frames.length > 0);
    const generation = frames[0]!.header.stop_generation;
    peer.send(seal(K1.privateKey, "hello", generation, w.wall, { profile_revision: "profile-1", policy_revision: "policy-1", runs: [], unacked_ids: [] }));
    await until(() => server.recognized(R1) === connection);
    return peer;
  }

  // 받은 상태 조회에 실행기가 답한다(그 조회의 요청 ID, 그 실행의 세대).
  async function reply(peer: Peer, query: Envelope) {
    const read = ledger!.getRun(run.runId);
    if (!read.known || read.value === null) throw new Error("실행 없음");
    const count = forwards.length;
    const status = { run_id: run.runId, state: "failed_stopped", run_generation: read.value.runGeneration, last_receipt_id: null };
    peer.send(seal(K1.privateKey, "status_report", query.header.stop_generation, w.wall, { in_reply_to: query.header.request_id, runs: [status] }));
    await until(() => forwards.length > count);
  }

  const state = () => {
    const read = ledger.getRun(run.runId);
    return read.known && read.value !== null ? read.value.state : "unknown";
  };
  const alerts = () => w.events.filter((e) => e.event === "result_check_alert").map((e) => e.fields);
  const beat = () => w.time.advance(w.settings.timing.beatEveryMs);
  return { w, ledger, server, run, marks, queries, connect, reply, state, alerts, beat };
}

describe("중계 뒤의 실행기: 결과 없음 판정 전에 그 연결에서 실행기가 실제로 답했는지 본다", () => {
  for (const keepalive of [true, false]) {
    test(`인사 뒤 중계가 양방향 전달을 멈추고 실행기가 사라지면 기한의 몇 배가 지나도 판정 쓰기(markResult) 0이고, 돌아온 실행기의 보고를 받는다(keepalive ${keepalive ? "켬" : "끔"})`, async () => {
      const s = await supervised();
      let a: net.Socket | undefined;
      let z: net.Socket | undefined;
      const relay = net.createServer((socket) => {
        a = socket;
        z = net.connect(s.server.port, HOST);
        a.pipe(z, { end: false });
        z.pipe(a, { end: false });
      });
      await new Promise<void>((resolve) => relay.listen(0, HOST, resolve));
      cleanup.push(() => {
        a?.destroy();
        z?.destroy();
        return new Promise<void>((resolve) => relay.close(() => resolve()));
      });
      const old = await s.connect((relay.address() as net.AddressInfo).port);
      // 감독 소켓의 TCP 상대는 중계다. 운영 keepalive를 넣은 소켓과 끈 대조군에서 같은 결과여야 한다.
      const socket = (s.server as unknown as { links: Map<number, { socket: { _handle: { fd: number }; setKeepAlive(on: boolean): void } }> }).links.get(old.id)!.socket;
      if (!keepalive) socket.setKeepAlive(false);
      const opts = Object.fromEntries(Object.keys(KEEPALIVE_OPTIONS).map((name) => [name, libcSocketOptions.get(socket._handle.fd, name as SocketOptionName)]));
      expect(opts.SO_KEEPALIVE).toBe(keepalive ? 1 : 0);
      if (keepalive) expect(opts).toEqual(KEEPALIVE_OPTIONS);
      a!.unpipe(z!);
      z!.unpipe(a!);
      old.socket.destroy();
      await until(old.closed);
      const connected = s.w.wall;
      const mono = s.w.time.monoNow();
      // 앞 리뷰가 실시간으로 본 70.1초·89초·90.1초와 기한의 열 배. 각 시각에서 박자를 돌린다.
      for (const elapsed of [70_100, 89_000, 90_100, 10 * WAIT]) {
        s.w.wall = connected + elapsed;
        s.w.time.set(mono + elapsed);
        await s.beat();
        expect([elapsed, s.server.recognized(R1), s.state(), s.marks.length, s.alerts()]).toEqual([elapsed, old.id, "checking", 0, []]);
      }
      // 감독은 그 연결에 상태 조회를 실었다(중계의 커널이 받는다). 답이 없어 판정하지 않았다.
      expect(s.queries.some((query) => query.connection === old.id && query.written)).toBe(true);
      // 실행기가 새 연결로 돌아와 ack가 없는 결과 보고를 다시 보낸다. 장부가 받고 다음 박자가 그 보고로 판정한다.
      await s.connect();
      const resent = s.ledger.recordReport(
        { reportId: id(), action: "report_result", runId: s.run.runId, bodyDigest: digest("resent"), storedRef: `results/${id()}`, resultDigest: digest("결과"), signal: null, now: s.w.wall },
        s.run.from,
      );
      expect(resent).toEqual(expect.objectContaining({ ok: true }));
      await s.beat();
      expect([s.state(), s.marks.map((input) => (input as { resultDigest: unknown }).resultDigest), s.alerts()]).toEqual(["ready_result", [digest("결과")], []]);
    });
  }

  test("실행기가 기한 시작 + 한 주기 뒤 실은 조회에 답하면, 보고가 끝내 없을 때 기한이 지난 다음 박자에 판정한다(한 주기 전 조회의 답은 근거가 아니다)", async () => {
    const s = await supervised();
    const peer = await s.connect();
    const greeted = s.w.wall;
    const mono = s.w.time.monoNow();
    // 인정 직후 박자가 실은 조회는 한 주기 전이라 답해도 근거가 아니다.
    await s.beat();
    const early = peer.frames.filter((envelope) => envelope.header.action === "status_query");
    expect(early.map((envelope) => envelope.body)).toEqual([{ run_ids: [s.run.runId] }]);
    await s.reply(peer, early[0]!);
    // 기한 시작(종료 영수증, 인정보다 1ms 뒤)부터 장부 시각과 단조 경과 모두 기한이 지났다. 그 박자의 결과 검사는 한 주기 전 조회의 답만
    // 있어 판정하지 않고, 같은 박자의 수명 박자가 새 조회를 싣는다(마지막 조회부터 answerTimeoutMs가 지났다).
    expect(s.run.since).toBeGreaterThan(greeted);
    s.w.wall = s.run.since + WAIT;
    s.w.time.set(mono + WAIT + 1_000);
    await s.beat();
    expect([s.state(), s.marks.length, s.alerts()]).toEqual(["checking", 0, []]);
    const later = peer.frames.filter((envelope) => envelope.header.action === "status_query");
    expect(later).toHaveLength(2);
    // 실행기가 그 조회에 답한다. 기한은 답을 받은 때가 아니라 기한 시작부터 센 것이라 이미 지났고, 다음 박자에 판정한다.
    await s.reply(peer, later[1]!);
    await s.beat();
    expect([s.state(), s.marks, s.alerts()]).toEqual([
      "failed_stopped",
      [{ runId: s.run.runId, resultDigest: null, now: s.w.wall }],
      [{ reason: "no_result", runId: s.run.runId, checkingSince: s.run.since }],
    ]);
  });
});
