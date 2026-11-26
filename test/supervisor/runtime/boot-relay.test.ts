// 결과 없음 판정의 마지막 경계(D-113·D-123)를 실제 상호 TLS 연결 서버와 중계로 본다. 감독 쪽 TCP 상대가 중계이면 실행기가 사라져도 중계의
// 커널이 TCP 탐침에 답해 연결은 인정된 채 남는다. 그 연결 번호만으로 판정하면 실행기가 다시 보낼 결과를 영구히 거절한다. 그래서 결과 없음
// 판정은 그 연결에서 실행기가 그 실행을 물은 상태 조회에 실제로 답했는지(result-check.ts의 ResultReach.answeredAt), 그 답이 ready_result가
// 아닌지(answeredState), 감독이 받고 보관하지 못한 그 실행의 결과 보고가 없는지(unstoredResult) 본다. 결과 보고는 실제 소켓으로 보내고
// 실제 파일 보관소에 보관해 ack까지 본다.
// 감독은 실제 조립(boot.ts)과 실제 박자 여섯이고, 장부 시계(w.wall)와 단조 시계(w.time)는 시험이 옮긴다: 실시간을 기다리지 않고 같은 경계를
// 본다. 서버는 루프백의 빈 포트에서 연다. 인증서는 메모리로 만든다(test/transport/certs.ts). 실행기 쪽은 tls-client.ts와 바이트 틀로 흉내 내고
// 봉투는 계약 v1로 실제 서명한다.
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import * as net from "node:net";
import type * as tls from "node:tls";
import { type Envelope, limits, type NonceStore, rawPublicKey, type Result, resultDigest, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import { RESULT_CHECK } from "../../../src/main/supervisor.ts";
import type { ResultReach } from "../../../src/supervisor/dispatch/result-check.ts";
import type { ReceiptOutcome } from "../../../src/supervisor/dispatch/receipts.ts";
import type { AnswerNote } from "../../../src/supervisor/runtime/answers.ts";
import type { BootResult } from "../../../src/supervisor/runtime/boot.ts";
import { createFileResultBackend } from "../../../src/supervisor/scheduler/result-store-file.ts";
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

// 조립이 결과 검사 박자에 넘긴 사실 포트. 시험 세계는 박자 포트를 beatValid만 있는 꼴로 쥐므로 그 칸으로 읽는다. 첫 박자 뒤에만 있다.
function reachOf(w: World): ResultReach {
  const reach = (w.captured.beatPorts?.resultCheck as { reach?: ResultReach } | undefined)?.reach;
  if (reach === undefined) throw new Error("결과 검사 박자가 아직 돌지 않았다");
  return reach;
}
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
  // 맞춤에서 받은 감독의 정지 세대.
  readonly generation: number;
  closed(): boolean;
  send(envelope: Envelope): void;
}

// 실행기가 보내는 결과 본문. digest는 계약 v1의 resultDigest다.
const RESULT = { role: "isolated_reader", outcome: "completed", summary: "요약", items: [], refs: [] } as unknown as Result;
const queriesOf = (peer: Peer) => peer.frames.filter((envelope) => envelope.header.action === "status_query");
const acked = (peer: Peer, reportId: string) => peer.frames.some((envelope) => envelope.header.action === "ack" && (envelope.body as { ids: string[] }).ids.includes(reportId));

// 감독(실제 조립)을 기동해 5단계까지 받아들이고, 그 조립의 서버 자리(가짜 서버)를 실제 연결 서버에 잇는다. 서버의 시계·복원기·실행 세대·
// deliver는 조립이 넘긴 그 값이다. 장부 시계는 실제 시각 근처에서 시작한다: 서버가 같은 시계로 TLS 인증서 기간과 봉투 시각을 본다.
// 결과 보관소는 실제 파일 보관소다(조립 세계의 기본 대역은 보관하지 못한다).
async function supervised() {
  const w: World = world({ settings: { resultCheck: RESULT_CHECK }, deps: { createResultBackend: createFileResultBackend } });
  w.wall = Date.now();
  const result: BootResult = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  cleanup.push(() => result.running.stop());
  await w.time.flush();
  for (let i = 0; i < 20 && !w.events.some((e) => e.event === "restore_step" && e.fields.step === 5); i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
  const ledger = w.opened;
  if (ledger === null) throw new Error("장부를 열지 않았다");
  const options = w.fake.options!;
  // 답 줄의 기록(영수증·보고·상태 보고를 처리한 결과)을 시험도 본다. 조립의 기록기는 그대로 부른다.
  const answers: AnswerNote[] = [];
  const linePorts = w.captured.lines!.ports;
  const observer = linePorts.observe;
  Object.assign(linePorts, {
    observe: (note: AnswerNote) => {
      answers.push(note);
      observer?.(note);
    },
  });
  // 조립이 답 줄에 넘긴 보관소. 시험이 putNew만 바꿔 보관 장애를 만든다.
  const backend = linePorts.results!.backend;
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
  // 조립이 서버에 쓴 틀(연결 번호, 동작, 요청 ID, 썼는지).
  const queries: { connection: number; action: string; requestId: string; written: boolean }[] = [];
  Object.assign(w.fake.server, {
    recognized: (principal: string) => server.recognized(principal),
    table: () => server.table(),
    tick: () => server.tick(),
    closeConnection: (connection: number) => server.closeConnection(connection),
    writeFrame: (...args: Parameters<ConnectionServer["writeFrame"]>) => {
      const written = server.writeFrame(...args);
      const header = (createFrameDecoder().push(args[2]).envelopes[0]?.value as Envelope | undefined)?.header;
      queries.push({ connection: args[0], action: String(header?.action), requestId: String(header?.request_id), written: written.kind === "written" });
      return written;
    },
  });
  const marks: unknown[] = [];
  const mark = ledger.markResult.bind(ledger);
  ledger.markResult = (input) => {
    marks.push(input);
    return mark(input);
  };
  // 작업자 실행을 지금 시작·접수하고 1ms 뒤 completed 종료 영수증으로 checking까지 옮긴다. 지정 실행기는 R1이고, 결과 보고를 보관할
  // 소유자(입력 요청)가 있다(없으면 수신기가 보관 전에 거절한다).
  const at = w.wall;
  const owner = id();
  must(ledger.enqueueInput({ requestId: owner, source: "test", sourceRef: { ref: `inputs/${owner}`, expiresAt: at + 3_600_000 }, receivedAt: at }));
  const admitted = must(ledger.admitRun(worker({ now: at, inputRequestId: owner, deadlineAt: at + 3_600_000, executorId: R1, role: "isolated_reader" }))).run;
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
    const send = (envelope: Envelope) => socket.write(frame(envelope));
    send(seal(K1.privateKey, "stop_sync_request", 0, w.wall, { challenge: hex32() }));
    await until(() => frames.length > 0);
    const generation = frames[0]!.header.stop_generation;
    send(seal(K1.privateKey, "hello", generation, w.wall, { profile_revision: "profile-1", policy_revision: "policy-1", runs: [], unacked_ids: [] }));
    await until(() => server.recognized(R1) === connection);
    return { id: connection, socket, frames, generation, closed: () => closed, send };
  }

  // 받은 상태 조회에 실행기가 답한다(그 조회의 요청 ID, 그 실행의 세대). state는 실행기가 말하는 그 실행의 상태다.
  async function reply(peer: Peer, query: Envelope, state = "failed_stopped") {
    const read = ledger!.getRun(run.runId);
    if (!read.known || read.value === null) throw new Error("실행 없음");
    const count = forwards.length;
    const status = { run_id: run.runId, state, run_generation: read.value.runGeneration, last_receipt_id: null };
    peer.send(seal(K1.privateKey, "status_report", query.header.stop_generation, w.wall, { in_reply_to: query.header.request_id, runs: [status] }));
    await until(() => forwards.length > count);
  }

  // 실행기가 그 실행의 결과 보고를 그 연결로 보낸다(같은 보고 ID면 다시 보낸 것). 감독의 영수증 처리기가 낸 결과(답 줄의 receipt 기록)를 돌려준다.
  async function sendResult(peer: Peer, reportId: string): Promise<ReceiptOutcome> {
    const before = answers.length;
    const body = { report_id: reportId, run_id: run.runId, result: RESULT };
    peer.send(
      sealEnvelope(
        { sender: R1, recipient: "supervisor", action: "report_result", request_id: id(), stop_generation: peer.generation, run_generation: run.from.runGeneration, issued_at: w.wall, nonce: hex32(), body } as never,
        K1.privateKey,
      ),
    );
    await until(() => answers.slice(before).some((note) => note.kind === "receipt"));
    return (answers.slice(before).find((note) => note.kind === "receipt") as Extract<AnswerNote, { kind: "receipt" }>).outcome;
  }

  // 그 연결에 실은 상태 조회가 실행기 쪽에 다 닿을 때까지 기다린다.
  const delivered = (peer: Peer) => {
    const sent = queries.filter((query) => query.connection === peer.id && query.written && query.action === "status_query").map((query) => query.requestId);
    return until(() => sent.every((requestId) => queriesOf(peer).some((envelope) => envelope.header.request_id === requestId)));
  };
  const matched = () => answers.filter((note) => note.kind === "status" && note.outcome.outcome === "status_matched").length;

  const state = () => {
    const read = ledger.getRun(run.runId);
    return read.known && read.value !== null ? read.value.state : "unknown";
  };
  const alerts = () => w.events.filter((e) => e.event === "result_check_alert").map((e) => e.fields);
  const beat = () => w.time.advance(w.settings.timing.beatEveryMs);
  const nulls = () => marks.filter((input) => (input as { resultDigest: unknown }).resultDigest === null).length;
  return { w, ledger, server, run, marks, queries, connect, reply, sendResult, delivered, matched, backend, answers, state, alerts, beat, nulls };
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
      // 실행기가 새 연결로 돌아와 ack가 없는 결과 보고를 그 소켓으로 다시 보낸다. 감독이 보관소에 보관하고 장부에 적어 그 보고 ID로 ack하고,
      // 다음 박자가 그 digest로 판정한다.
      const fresh = await s.connect();
      expect(fresh.id).not.toBe(old.id);
      const reportId = id();
      expect(await s.sendResult(fresh, reportId)).toEqual(expect.objectContaining({ outcome: "ack", action: "report_result", id: reportId, delivery: "new" }));
      await until(() => acked(fresh, reportId));
      await s.beat();
      expect([s.state(), s.marks.map((input) => (input as { resultDigest: unknown }).resultDigest), s.alerts()]).toEqual(["ready_result", [resultDigest(RESULT)], []]);
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

// 감독이 이미 받은 결과를 보관하지 못했거나 실행기가 결과가 있다고 답하면, 상태 답이 있어도 결과 없음으로 판정하지 않는다(F3). 결과 없음
// 판정의 근거는 그 실행을 물은 조회의 답만이다(F9). 답 없는 연결에 같은 실행의 조회가 쌓이지 않는다(F10).
describe("결과 없음 판정 전 보관하지 못한 결과와 그 실행의 답", () => {
  test("같은 연결로 같은 결과 보고를 10초마다 아홉 번 보내는 동안 보관소만 모름이면 결과 없음 판정 0이고, 보관소가 돌아온 뒤 같은 보고를 ack하고 그 digest로 판정한다", async () => {
    const s = await supervised();
    const peer = await s.connect();
    const wall = s.w.wall;
    const mono = s.w.time.monoNow();
    const putNew = s.backend.putNew.bind(s.backend);
    let unavailable = true;
    let attempts = 0;
    s.backend.putNew = (...args) => {
      attempts += 1;
      return unavailable ? { status: "unknown" } : putNew(...args);
    };
    const reportId = id();
    await s.beat();
    const outcomes: ReceiptOutcome[] = [];
    const handled = new Set<string>();
    for (let i = 1; i <= 9; i += 1) {
      const elapsed = i * RENEW + 1_000;
      s.w.wall = wall + elapsed;
      s.w.time.set(mono + elapsed);
      outcomes.push(await s.sendResult(peer, reportId));
      await s.beat();
      await s.delivered(peer);
      // 실제 실행기는 결과 보고를 만든 실행을 ready_result로 답한다.
      for (const query of queriesOf(peer).filter((envelope) => !handled.has(envelope.header.request_id))) {
        await s.reply(peer, query, "ready_result");
        handled.add(query.header.request_id);
      }
    }
    expect(outcomes.map((outcome) => [outcome.outcome, (outcome as { at?: unknown }).at])).toEqual(Array.from({ length: 9 }, () => ["result_unknown", "store"]));
    // 기한(90초)이 지난 박자까지 실행기가 같은 연결에서 조회에 답했다.
    expect(s.w.wall - s.run.since).toBeGreaterThan(WAIT);
    expect(s.matched()).toBeGreaterThanOrEqual(4);
    expect([s.nulls(), s.marks, s.state(), s.alerts(), peer.frames.filter((envelope) => envelope.header.action === "result_finalize")]).toEqual([0, [], "checking", [], []]);
    unavailable = false;
    expect(await s.sendResult(peer, reportId)).toEqual(expect.objectContaining({ outcome: "ack", action: "report_result", id: reportId, delivery: "new" }));
    await until(() => acked(peer, reportId));
    await s.beat();
    expect([attempts, s.state(), s.marks.map((input) => (input as { resultDigest: unknown }).resultDigest), s.alerts()]).toEqual([10, "ready_result", [resultDigest(RESULT)], []]);
  });

  test("보관이 한 번 실패한 뒤 실행기가 그 실행을 ready_result로 답하고 중계가 멈추면 기한이 지나도 결과 없음 판정 0이고, 새 연결로 다시 보낸 같은 보고를 ack하고 그 digest로 판정한다", async () => {
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
    const wall = s.w.wall;
    const mono = s.w.time.monoNow();
    await s.beat();
    // 기한 시작 + 한 주기 뒤의 박자가 새 조회를 싣는다.
    s.w.wall = wall + 21_000;
    s.w.time.set(mono + 21_000);
    await s.beat();
    await s.delivered(old);
    expect(queriesOf(old).length).toBeGreaterThanOrEqual(2);
    const reportId = id();
    const putNew = s.backend.putNew;
    s.backend.putNew = () => ({ status: "unknown" });
    expect(await s.sendResult(old, reportId)).toEqual(expect.objectContaining({ outcome: "result_unknown", at: "store", id: reportId }));
    s.backend.putNew = putNew;
    const latest = queriesOf(old).at(-1)!;
    const before = s.matched();
    await s.reply(old, latest, "ready_result");
    expect(s.matched()).toBe(before + 1);
    // 중계가 양방향 전달을 멈추고 실행기가 사라진다. 감독은 옛 연결을 인정한 채 남는다.
    a!.unpipe(z!);
    z!.unpipe(a!);
    old.socket.destroy();
    await until(old.closed);
    for (let i = 22; i <= 91; i += 1) {
      s.w.wall = wall + i * 1_000;
      s.w.time.set(mono + i * 1_000);
      await s.beat();
    }
    expect([s.server.recognized(R1), s.nulls(), s.state(), s.alerts()]).toEqual([old.id, 0, "checking", []]);
    const fresh = await s.connect();
    expect(await s.sendResult(fresh, reportId)).toEqual(expect.objectContaining({ outcome: "ack", action: "report_result", id: reportId, delivery: "new" }));
    await until(() => acked(fresh, reportId));
    await s.beat();
    expect([s.state(), s.marks.map((input) => (input as { resultDigest: unknown }).resultDigest), s.alerts()]).toEqual(["ready_result", [resultDigest(RESULT)], []]);
  });

  test("실행기가 결과가 없다고(ready_result가 아니라고) 답해도 감독이 받고 보관하지 못한 그 실행의 보고가 남았으면 결과 없음 판정 0이다", async () => {
    const s = await supervised();
    const peer = await s.connect();
    const wall = s.w.wall;
    const mono = s.w.time.monoNow();
    await s.beat();
    const reportId = id();
    const putNew = s.backend.putNew;
    s.backend.putNew = () => ({ status: "unknown" });
    expect(await s.sendResult(peer, reportId)).toEqual(expect.objectContaining({ outcome: "result_unknown", at: "store" }));
    s.backend.putNew = putNew;
    const handled = new Set<string>();
    for (const elapsed of [21_000, 41_000, 61_000, 81_000, 91_000, 10 * WAIT]) {
      s.w.wall = wall + elapsed;
      s.w.time.set(mono + elapsed);
      await s.beat();
      await s.delivered(peer);
      for (const query of queriesOf(peer).filter((envelope) => !handled.has(envelope.header.request_id))) {
        await s.reply(peer, query, "failed_stopped");
        handled.add(query.header.request_id);
      }
      await s.beat();
    }
    expect(s.matched()).toBeGreaterThanOrEqual(4);
    expect([s.nulls(), s.state(), s.alerts()]).toEqual([0, "checking", []]);
    expect(await s.sendResult(peer, reportId)).toEqual(expect.objectContaining({ outcome: "ack", id: reportId }));
    await s.beat();
    expect([s.state(), s.marks.map((input) => (input as { resultDigest: unknown }).resultDigest)]).toEqual(["ready_result", [resultDigest(RESULT)]]);
  });

  test("실행기가 기한 시작 + 한 주기 뒤 실은 조회에 ready_result로 답하면 결과 없음 판정 0이고, 그 뒤 결과가 없다고 답해도 양성 관측이 남아 판정 0이며, 결과 보고를 ack한 뒤 그 digest로 판정한다", async () => {
    const s = await supervised();
    const peer = await s.connect();
    const wall = s.w.wall;
    const mono = s.w.time.monoNow();
    await s.beat();
    s.w.wall = wall + 21_000;
    s.w.time.set(mono + 21_000);
    await s.beat();
    await s.delivered(peer);
    await s.reply(peer, queriesOf(peer).at(-1)!, "ready_result");
    s.w.wall = wall + 91_000;
    s.w.time.set(mono + 91_000);
    await s.beat();
    await s.beat();
    expect([s.nulls(), s.state(), s.alerts()]).toEqual([0, "checking", []]);
    // 마지막 조회에서 20초가 지나 수명 박자가 새 조회를 싣고, 실행기가 결과가 없다고 답한다. 그 답은 대조돼 결과 없음의 근거 조건은
    // 모두 찼지만, 앞의 ready_result 답(양성 관측)은 같은 실행의 보고를 장부가 받아야만 지워진다.
    await s.delivered(peer);
    const latest = queriesOf(peer).at(-1)!;
    await s.reply(peer, latest, "failed_stopped");
    await s.beat();
    await s.beat();
    const reach = reachOf(s.w);
    expect([reach.answeredState(R1, s.run.runId), reach.positiveObserved(s.run.runId)]).toEqual(["failed_stopped", true]);
    expect([s.nulls(), s.state(), s.alerts(), peer.frames.filter((envelope) => envelope.header.action === "result_finalize")]).toEqual([0, "checking", [], []]);
    const reportId = id();
    expect(await s.sendResult(peer, reportId)).toEqual(expect.objectContaining({ outcome: "ack", id: reportId }));
    await until(() => acked(peer, reportId));
    expect(reach.positiveObserved(s.run.runId)).toBe(false);
    await s.beat();
    expect([s.state(), s.marks.map((input) => (input as { resultDigest: unknown }).resultDigest), s.alerts()]).toEqual(["ready_result", [resultDigest(RESULT)], []]);
  });

  test("같은 실행기의 다른 실행(B)을 물은 조회의 올바른 답은 대상 실행(A)의 결과 없음 판정 근거가 아니다", async () => {
    const s = await supervised();
    const peer = await s.connect();
    const wall = s.w.wall;
    const mono = s.w.time.monoNow();
    await s.beat();
    const other = must(s.ledger.admitRun(worker({ now: wall, deadlineAt: wall + 3_600_000, executorId: R1, role: "isolated_reader" }))).run;
    expect(s.ledger.startRun({ runId: other.runId, requestId: id(), stopGeneration: 0, now: wall })).toMatchObject({ ok: false, reason: "slot_busy" });
    s.w.wall = wall + 21_000;
    s.w.time.set(mono + 21_000);
    // 감독의 실제 송신 포트로 B를 묻는다. 실행기가 B에 대해 올바르게 답한다.
    const query = sealEnvelope(
      { sender: "supervisor", recipient: R1, action: "status_query", request_id: id(), stop_generation: peer.generation, run_generation: 0, issued_at: s.w.wall, nonce: hex32(), body: { run_ids: [other.runId] } },
      SUP.privateKey,
    );
    expect(await s.w.captured.sink!.value.sink.send(query)).toBe("sent");
    await until(() => peer.frames.some((envelope) => envelope.header.request_id === query.header.request_id));
    peer.send(seal(K1.privateKey, "status_report", peer.generation, s.w.wall, { in_reply_to: query.header.request_id, runs: [{ run_id: other.runId, state: "not_known", run_generation: null, last_receipt_id: null }] }));
    await until(() => s.answers.some((note) => note.kind === "status" && note.outcome.outcome === "status_matched" && note.outcome.queryRequestId === query.header.request_id));
    s.w.wall = wall + 91_000;
    s.w.time.set(mono + 91_000);
    await s.beat();
    await s.beat();
    expect([s.marks, s.state(), s.alerts()]).toEqual([[], "checking", []]);
    // A를 물은 조회에 답하면 판정한다(위의 0이 다른 이유로 막힌 것이 아니다).
    await s.delivered(peer);
    await s.reply(peer, queriesOf(peer).filter((envelope) => (envelope.body as { run_ids: string[] }).run_ids.includes(s.run.runId)).at(-1)!);
    await s.beat();
    expect([s.nulls(), s.state()]).toEqual([1, "failed_stopped"]);
  });

  test("답 없는 인정된 연결에서 20.1초 간격으로 60번 박자를 돌아도 그 실행의 미결 조회는 하나뿐이고, 대체된 조회의 늦은 답은 대조되지 않는다", async () => {
    const s = await supervised();
    const peer = await s.connect();
    const wall = s.w.wall;
    const mono = s.w.time.monoNow();
    const samples: [number, number][] = [];
    for (let i = 0; i <= 60; i += 1) {
      s.w.wall = wall + i * 20_100;
      s.w.time.set(mono + i * 20_100);
      await s.beat();
      samples.push([i, s.w.captured.queries!.pending().length]);
    }
    expect(samples.filter(([, count]) => count > 1)).toEqual([]);
    expect(samples.at(-1)).toEqual([60, 1]);
    expect([s.marks, s.state(), s.server.recognized(R1)]).toEqual([[], "checking", peer.id]);
    // 실행기가 첫 조회에 이제야 답한다. 그 조회는 대체돼 대조할 항목이 없다.
    await s.delivered(peer);
    const first = queriesOf(peer)[0]!;
    const before = s.answers.length;
    await s.reply(peer, first);
    expect(s.answers.slice(before).filter((note) => note.kind === "status").map((note) => (note.kind === "status" && note.outcome.outcome === "status_unmatched" ? note.outcome.reason : "?"))).toEqual([
      "unknown_query",
    ]);
    await s.beat();
    expect([s.marks, s.state()]).toEqual([[], "checking"]);
  });
});

// 결과가 있을 수 있다는 관측(양성 관측)이 하나라도 남으면 결과 없음 판정을 하지 않는다: 검증을 지난 결과 보고의 도착(처리 결과와 무관),
// 어느 조회·연결의 ready_result 답, 대조됐지만 근거로 적지 못한 최신 답. 같은 실행의 보고를 장부가 받으면(ack) 지운다. 늦게 오는 답과
// 송신 포트의 미결 조회 상한도 실제 소켓으로 본다.
describe("양성 관측과 늦은 답", () => {
  const digestsOf = (s: Awaited<ReturnType<typeof supervised>>) => s.marks.map((input) => (input as { resultDigest: unknown }).resultDigest);
  const finalized = (peer: Peer) => peer.frames.filter((envelope) => envelope.header.action === "result_finalize");

  for (const failure of ["clock", "handler"] as const) {
    test(`검증을 지난 첫 결과 보고의 처리가 한 번 실패하면(${failure === "clock" ? "답 줄의 시계 한 번 던짐" : "결과 포트 접근자 한 번 던짐"}) 보관하지 못한 보고의 기억이 없어도 결과 없음 판정 0이고, 복구 뒤 같은 보고를 ack하고 그 digest로 판정한다`, async () => {
      const s = await supervised();
      const peer = await s.connect();
      const wall = s.w.wall;
      const mono = s.w.time.monoNow();
      const at = (ms: number) => {
        s.w.wall = wall + ms;
        s.w.time.set(mono + ms);
      };
      const ports = s.w.captured.lines!.ports;
      await s.beat();
      // 기한 시작 + 한 주기 뒤 실은 조회에 실행기가 checking으로 답했다: 결과 없음의 다른 조건은 기한 뒤 모두 찬다.
      at(80_000);
      await s.beat();
      await s.delivered(peer);
      await s.reply(peer, queriesOf(peer).at(-1)!, "checking");
      await until(() => s.matched() === 1);
      at(89_900);
      const reportId = id();
      const start = s.answers.length;
      const clock = ports.clock;
      const results = ports.results!;
      const backend = Object.getOwnPropertyDescriptor(results, "backend")!;
      try {
        if (failure === "clock") {
          Object.assign(ports, {
            clock: {
              now: () => {
                throw new Error("시계 한 번");
              },
            },
          });
        } else {
          Object.defineProperty(results, "backend", {
            configurable: true,
            get: () => {
              throw new Error("포트 한 번");
            },
          });
        }
        const body = { report_id: reportId, run_id: s.run.runId, result: RESULT };
        peer.send(sealEnvelope({ sender: R1, recipient: "supervisor", action: "report_result", request_id: id(), stop_generation: peer.generation, run_generation: s.run.from.runGeneration, issued_at: s.w.wall, nonce: hex32(), body } as never, K1.privateKey));
        await until(() => s.answers.slice(start).some((note) => note.kind === "receipt" || note.kind === "fault"));
      } finally {
        Object.assign(ports, { clock });
        Object.defineProperty(results, "backend", backend);
      }
      const incoming = s.answers.slice(start).find((note) => note.kind === "receipt" || note.kind === "fault");
      expect(incoming).toMatchObject(failure === "clock" ? { kind: "receipt", outcome: { outcome: "rejected", reason: "input_malformed", field: "now" } } : { kind: "fault", where: "deliver" });
      expect([reachOf(s.w).unstoredResult(s.run.runId), reachOf(s.w).positiveObserved(s.run.runId)]).toEqual([false, true]);
      for (const elapsed of [91_000, 10 * WAIT]) {
        at(elapsed);
        await s.beat();
        expect([elapsed, s.nulls(), s.state(), s.alerts(), finalized(peer)]).toEqual([elapsed, 0, "checking", [], []]);
      }
      expect(await s.sendResult(peer, reportId)).toEqual(expect.objectContaining({ outcome: "ack", action: "report_result", id: reportId }));
      await until(() => acked(peer, reportId));
      expect([reachOf(s.w).unstoredResult(s.run.runId), reachOf(s.w).positiveObserved(s.run.runId)]).toEqual([false, false]);
      await s.beat();
      expect([s.state(), digestsOf(s), s.alerts()]).toEqual(["ready_result", [resultDigest(RESULT)], []]);
    });
  }

  test("대체된 조회에 늦게 온 ready_result 답은 대조되지 않아도 양성 관측이다: 앞서 대조된 부정 답이 남아도 결과 없음 판정 0이고, 결과 보고를 ack한 뒤 그 digest로 판정한다", async () => {
    const s = await supervised();
    const peer = await s.connect();
    const wall = s.w.wall;
    const mono = s.w.time.monoNow();
    const advance = async (ms: number) => {
      s.w.wall = wall + ms;
      s.w.time.set(mono + ms);
      await s.beat();
      await s.delivered(peer);
      return queriesOf(peer).at(-1)!;
    };
    await s.beat();
    const negative = await advance(21_000);
    await s.reply(peer, negative, "checking");
    await until(() => s.matched() === 1);
    const positive = await advance(68_000);
    const newest = await advance(89_000);
    expect(newest.header.request_id).not.toBe(positive.header.request_id);
    const before = s.answers.length;
    await s.reply(peer, positive, "ready_result");
    expect(s.answers.slice(before).filter((note) => note.kind === "status").map((note) => (note.kind === "status" && note.outcome.outcome === "status_unmatched" ? note.outcome.reason : "?"))).toEqual(["unknown_query"]);
    // 부정 근거는 앞의 대조된 답 그대로다. 양성 관측이 판정을 막는다.
    expect([reachOf(s.w).answeredState(R1, s.run.runId), reachOf(s.w).positiveObserved(s.run.runId)]).toEqual(["checking", true]);
    await advance(91_000);
    await advance(10 * WAIT);
    expect([s.nulls(), s.state(), s.alerts(), finalized(peer)]).toEqual([0, "checking", [], []]);
    const reportId = id();
    expect(await s.sendResult(peer, reportId)).toEqual(expect.objectContaining({ outcome: "ack", id: reportId }));
    await until(() => acked(peer, reportId));
    await s.beat();
    expect([s.state(), digestsOf(s), s.alerts()]).toEqual(["ready_result", [resultDigest(RESULT)], []]);
  });

  for (const state of ["ready_result", "failed_stopped"] as const) {
    test(`대조된 최신 답을 그 조회의 실은 시각을 몰라(단조 시계 한 번 던짐) 근거로 적지 못하면 그 답이 ${state}여도 앞의 부정 답으로 판정하지 않고(양성 관측), 결과 보고를 ack한 뒤 그 digest로 판정한다`, async () => {
      const s = await supervised();
      const peer = await s.connect();
      const wall = s.w.wall;
      const mono = s.w.time.monoNow();
      const at = (ms: number) => {
        s.w.wall = wall + ms;
        s.w.time.set(mono + ms);
      };
      await s.beat();
      at(21_000);
      await s.beat();
      await s.delivered(peer);
      await s.reply(peer, queriesOf(peer).at(-1)!, "checking");
      await until(() => s.matched() === 1);
      at(89_000);
      // 조립이 조회를 등록하며 실은 시각을 적는 그 단조 시계 읽기 하나만 던진다.
      const prior = s.w.deps.monoNow;
      let failures = 0;
      Object.assign(s.w.deps, {
        monoNow: () => {
          const stack = new Error().stack ?? "";
          if (failures === 0 && stack.includes("monoRead") && stack.includes("add")) {
            failures += 1;
            throw new Error("조회 시각 한 번");
          }
          return prior();
        },
      });
      try {
        await s.beat();
      } finally {
        Object.assign(s.w.deps, { monoNow: prior });
      }
      expect(failures).toBe(1);
      await s.delivered(peer);
      await s.reply(peer, queriesOf(peer).at(-1)!, state);
      await until(() => s.matched() === 2);
      expect([reachOf(s.w).answeredState(R1, s.run.runId), reachOf(s.w).positiveObserved(s.run.runId)]).toEqual(["checking", true]);
      for (const elapsed of [91_000, 10 * WAIT]) {
        at(elapsed);
        await s.beat();
        expect([elapsed, s.nulls(), s.state(), s.alerts(), finalized(peer)]).toEqual([elapsed, 0, "checking", [], []]);
      }
      const reportId = id();
      expect(await s.sendResult(peer, reportId)).toEqual(expect.objectContaining({ outcome: "ack", id: reportId }));
      await until(() => acked(peer, reportId));
      await s.beat();
      expect([s.state(), digestsOf(s)]).toEqual(["ready_result", [resultDigest(RESULT)]]);
    });
  }

  test("실행기가 매번 직전 조회에 20.1초 늦게 결과가 없다고 답하면 늦은 답은 대조되지 않아 60번 뒤에도 결과 없음 판정 0으로 자리를 쥐고(미결 조회는 하나), 마지막 조회에 제때 답하면 다음 박자에 판정한다", async () => {
    const s = await supervised();
    const peer = await s.connect();
    const wall = s.w.wall;
    const mono = s.w.time.monoNow();
    await s.beat();
    await s.delivered(peer);
    let prev = queriesOf(peer).at(-1)!;
    const statuses = () => s.answers.filter((note) => note.kind === "status").map((note) => (note.kind === "status" ? note.outcome : null));
    let maxPending = 0;
    for (let i = 1; i <= 60; i += 1) {
      s.w.wall = wall + i * 20_100;
      s.w.time.set(mono + i * 20_100);
      await s.beat();
      await s.delivered(peer);
      const current = queriesOf(peer).at(-1)!;
      expect(current.header.request_id).not.toBe(prev.header.request_id);
      const before = statuses().length;
      await s.reply(peer, prev);
      await until(() => statuses().length === before + 1);
      maxPending = Math.max(maxPending, s.w.captured.queries!.pending().length);
      prev = current;
    }
    const late = statuses().map((outcome) => (outcome?.outcome === "status_unmatched" ? outcome.reason : outcome?.outcome));
    expect([maxPending, late.length, late.filter((reason) => reason === "unknown_query").length]).toEqual([1, 60, 60]);
    expect([s.matched(), s.nulls(), s.state(), s.server.recognized(R1), reachOf(s.w).positiveObserved(s.run.runId)]).toEqual([0, 0, "checking", peer.id, false]);
    await s.reply(peer, prev);
    await s.beat();
    expect([s.matched(), s.nulls(), s.state(), s.alerts()]).toEqual([1, 1, "failed_stopped", [{ reason: "no_result", runId: s.run.runId, checkingSince: s.run.since }]]);
  });

  test("감독의 실제 송신 포트로 같은 요청 ID를 두 번, 실행이 겹치는 여러 실행 조회를 두 번 실어도 네 틀 모두 실리고 그 실행의 미결 조회는 늘 하나다", async () => {
    const s = await supervised();
    const peer = await s.connect();
    const active = s.run.runId;
    const count = () => s.w.captured.queries!.pending().filter((query) => query.connection === peer.id && query.runIds.includes(active)).length;
    const fixed = id();
    const cases = [
      { request: fixed, runs: [active] },
      { request: fixed, runs: [active] },
      { request: id(), runs: [active, id()] },
      { request: id(), runs: [id(), active] },
    ];
    const observed: number[] = [];
    for (const each of cases) {
      const query = sealEnvelope(
        { sender: "supervisor", recipient: R1, action: "status_query", request_id: each.request, stop_generation: peer.generation, run_generation: 0, issued_at: s.w.wall, nonce: hex32(), body: { run_ids: each.runs } },
        SUP.privateKey,
      );
      expect(await s.w.captured.sink!.value.sink.send(query)).toBe("sent");
      observed.push(count());
    }
    await until(() => queriesOf(peer).length === 4);
    expect(observed).toEqual([1, 1, 1, 1]);
    expect(s.w.captured.queries!.pending().filter((query) => query.runIds.includes(active)).map((query) => query.requestId)).toEqual([cases[3]!.request]);
  });
});
