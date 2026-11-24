// 루프백(127.0.0.1, 운영체제가 고르는 포트)의 실제 상호 TLS 연결 서버와 실제 임시 장부로 발급 문(issuance.ts)을 잇는다. 계정 파일만 가짜다.
// 서버의 deliver → 답 줄 → 처리기 → 장부 → 자격 값 보내기 → 서버의 writeFrame → 실행기 쪽 섞어 받는 디코더. 인증서는 메모리에서 만들고
// 봉투는 계약 v1로 실제 서명한다. 기다리는 것은 소켓·서버의 사건뿐이고 시간을 재서 맞추지 않는다.
// 자격 값의 표본은 이 파일이 지어낸 바이트이고, 받은 값이 같은지는 불리언으로만 단언한다.
import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { type Envelope, limits, rawPublicKey, type RunStatus, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { CredentialFiles } from "../../../src/supervisor/accounts/credential-ref.ts";
import type { ReceiptLedger } from "../../../src/supervisor/dispatch/receipts.ts";
import { createAnswerLines } from "../../../src/supervisor/runtime/answers.ts";
import { type CycleBeats, createCycle } from "../../../src/supervisor/runtime/cycle.ts";
import { createIssuance, type IssuanceNote } from "../../../src/supervisor/runtime/issuance.ts";
import { createQueryBook } from "../../../src/supervisor/runtime/query-book.ts";
import { createSharedClock } from "../../../src/supervisor/runtime/shared-clock.ts";
import { createWireSink, type SinkNote } from "../../../src/supervisor/runtime/sink.ts";
import { RegistryState } from "../../../src/supervisor/transport/registry.ts";
import { type Delivered, startConnectionServer } from "../../../src/supervisor/transport/server.ts";
import { createMixedFrameDecoder, type DecodedCredential, encodeFrame } from "../../../src/transport/framing.ts";
import { createTlsClient } from "../../../src/transport/tls-client.ts";
import { grant, open, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";
import { makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../../transport/certs.ts";

const HOST = "127.0.0.1";
const GEN = 0;
const R1 = WORKER_EXECUTOR;
const SAMPLE = "MW4C-JT8Q-RV2X-GN6L-PZ5K";
const sampleBytes = () => new TextEncoder().encode(SAMPLE);
const DIGEST = createHash("sha256").update(sampleBytes()).digest("hex");
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const allZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);
// 관측에서 뽑은 이름 목록의 단언. 원래 문자열끼리 견준 결과는 불리언으로 보고, 실패 진단에는 ":"로 나눈 조각이 모두 허용된
// 이름(또는 연결 번호)인 항목만 그대로 싣는다. 관측에 표본이 섞이는 회귀가 생겨도 실패 메시지가 표본을 다시 찍지 않는다.
const NAMES = new Set(["ack", "issuance_closed", "server_closed", "server_close_failed", "close", "after_flag", "written", "blocked", "intake_closed"]);
const shown = (list: readonly string[]) => list.map((item) => (item.split(":").every((part) => part === "" || /^\d+$/.test(part) || NAMES.has(part)) ? item : "<not_allowed>"));
function expectNames(actual: readonly string[], wanted: readonly string[]): void {
  const equal = actual.length === wanted.length && actual.every((item, i) => item === wanted[i]);
  expect({ names: shown(actual), equal }).toEqual({ names: shown(wanted), equal: true });
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function keys(): { privateKey: KeyObject; raw: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, raw: rawPublicKey(publicKey) };
}

let counter = 0;
const hex32 = () => (++counter).toString(16).padStart(32, "0");
const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;

// 기다리는 사건의 큐. 사건이 오면 다음 기다림을 푼다.
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

test("루프백: 접수 영수증 뒤 자격 값 틀 하나가 그 연결의 실행기 쪽 디코더에 닿고, 발급 깃발 뒤에는 새 연결의 같은 접수에도 값·ack가 0이며, 종료는 깃발 → 서버 닫기 차례다", async () => {
  const now = Date.now();
  const pki = makePki();
  const sup = keys();
  const k1 = keys();
  const material = (leaf: { pem: string; keyPem: string }) => ({ certificatePem: leaf.pem, privateKeyPem: leaf.keyPem, trustBundlePem: pki.ca.pem });
  const registryDoc = new TextEncoder().encode(
    JSON.stringify({ environment: "home", revision: 1, executors: [{ target: "reader", role: "diagnosis", instance: "0", storage: "store-a", public_key: k1.raw, active: true }] }),
  );
  const applied = RegistryState.start({ environment: "home", targets: [{ target: "reader", namespace: "olive-reader", roles: ["diagnosis"] }] }).apply({ kind: "content", content: registryDoc });
  if (applied.kind !== "applied") throw new Error("시험 등록표가 적용되지 않았다");

  // 실제 장부: 정지 세대 0, 접수 허가, 작업자 실행 하나를 preparing(세대 1)까지. 실행 줄의 지문은 표본의 지문이다.
  const real = open(tempPath(), { clock: () => now });
  if (!real.applyStop({ generation: GEN, stopped: false, now }).ok) throw new Error("정지 세대를 적지 못했다");
  grant(real);
  const admitted = real.admitRun(worker({ now, deadlineAt: now + 600_000, credential: { account: "acct-a", method: "subscription", revision: "cred-3", digest: DIGEST } }));
  if (!admitted.ok) throw new Error(`admit: ${admitted.reason}`);
  const RUN = admitted.run.runId;
  const START = uuid();
  if (!real.startRun({ runId: RUN, requestId: START, stopGeneration: GEN, now }).ok) throw new Error("start");
  const ledger: ReceiptLedger = {
    applyReceipt: (i, f) => real.applyReceipt(i, f),
    recordReport: (i, f) => real.recordReport(i, f),
    applyExecutorAnswer: (i, f) => real.applyExecutorAnswer(i, f),
  };

  // 실제 순서기. 박자는 부르지 않는다: 깃발과 닫기의 기다림만 쓴다.
  const idle = (kind: string) => ({ kind: "not_run", reason: kind }) as never;
  const beats: CycleBeats = { linkLoss: () => idle("l"), life: async () => idle("f"), resend: async () => idle("r"), unreceived: () => idle("u"), assign: async () => idle("a") };
  const cycle = createCycle({
    beats,
    serverTick: () => {},
    ledgerClock: createSharedClock({ now: () => now }),
    monotonic: { now: () => 1 },
    restoreDone: () => true,
    ledger: real,
    policy: { judgeMs: 30_000, resendEveryMs: 5_000, assignCallsPerBeat: 1 },
  });

  const published = { stopGeneration: () => GEN, intakeOpen: () => true };
  const restorer = () => published;
  const lineRef: { deliver: (output: Delivered) => void } = { deliver: () => {} };
  const withdrawn = events<number>();
  const opened = events<number>();
  const order: string[] = [];
  const seen = new Set<string>();
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
    deliver: (output: Delivered) => {
      lineRef.deliver(output);
      if (output.kind === "withdrawn") withdrawn.push(output.connection);
    },
    observe: (note) => {
      if (note.kind === "opened") opened.push(note.connection);
    },
    maxPendingWriteBytes: limits.MAX_MESSAGE_BYTES,
  });
  if (!started.ok) throw new Error(`서버가 시작하지 않았다: ${started.failure.kind}`);
  const server = started.server;
  let closeOnce: Promise<void> | null = null;
  const realClose = (): Promise<void> => (closeOnce ??= server.close());
  // 닫기 차례를 적는다(쓰기와 닫기 자체는 실제 서버의 것).
  const closing = {
    writeFrame: server.writeFrame.bind(server),
    close: () => {
      order.push(cycle.issuanceOpen() ? "close:open" : "close:after_flag");
      return realClose();
    },
  };
  cleanup.push(() => realClose());

  const lent: Uint8Array[] = [];
  const files: CredentialFiles = {
    async read() {
      const bytes = sampleBytes();
      lent.push(bytes);
      return { kind: "bytes", bytes };
    },
  };
  const notes: IssuanceNote[] = [];
  const attempts = events<string>();
  const issuance = createIssuance({
    cycle,
    server: closing,
    restorer,
    ledger: real,
    clock: { now: () => now },
    files,
    policy: { dir: "/accounts", keys: { subscription: "CLAUDE_CODE_OAUTH_TOKEN" }, maxBytes: 16_384, revisionOf: () => "cred-3" },
    observe: (note) => {
      notes.push(note);
      if (note.kind === "credential" && note.note.kind === "attempt") attempts.push(`${note.note.connection}:${note.note.outcome}:${note.note.reason ?? ""}`);
      if (note.kind === "shutdown") order.push(note.step);
    },
  });
  const forgotten: number[] = [];
  const queries = createQueryBook();
  const sinkNotes: SinkNote[] = [];
  const holder: { withheld: () => ReturnType<ReturnType<typeof createAnswerLines>["withheld"]["executors"]> } = { withheld: () => ({ known: true, value: [] }) };
  const wire = createWireSink({
    server,
    restorer,
    withheld: { executors: () => holder.withheld() },
    clock: { now: () => now },
    queries,
    observe: (note) => sinkNotes.push(note),
    issuanceOpen: issuance.issuanceOpen,
  });
  const hellos = events<string>();
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
    cycle,
    observationsSettled: () => true,
    observe: (note) => {
      if (note.kind === "hello") hellos.push(note.outcome.kind);
    },
    credentials: {
      onReceipt: issuance.credentials.onReceipt,
      forgetConnection(connection) {
        forgotten.push(connection);
        issuance.credentials.forgetConnection(connection);
      },
    },
  });
  holder.withheld = () => lines.withheld.executors();
  lineRef.deliver = (output) => lines.deliver(output);

  // 실행기 흉내 하나: 연결 하나, 봉투와 값 틀을 함께 푸는 디코더.
  async function executor() {
    const before = new Set(opened.all());
    const client = createTlsClient({ address: HOST, port: server.port, supervisorDnsName: SUPERVISOR_DNS, supervisorUri: SUPERVISOR_URI, material: material(pki.executor()), now: () => now });
    cleanup.push(() => client.close());
    const socket = (await client.connect()).socket;
    socket.on("error", () => {});
    const decoder = createMixedFrameDecoder();
    const envelopes = events<Envelope>();
    const credentials = events<DecodedCredential>();
    let rejected: string | null = null;
    const closed = events<true>();
    socket.on("close", () => closed.push(true));
    socket.on("data", (chunk: Buffer) => {
      const step = decoder.push(new Uint8Array(chunk));
      if (step.rejected !== null) rejected = step.rejected;
      for (const frame of step.frames) {
        if (frame.kind === "envelope") envelopes.push(frame.envelope.value as Envelope);
        else credentials.push(frame.credential);
      }
    });
    const put = (action: string, body: unknown, runGeneration = 0) => {
      const envelope = sealEnvelope(
        { sender: R1, recipient: "supervisor", action, request_id: uuid(), stop_generation: GEN, run_generation: runGeneration, issued_at: now, nonce: hex32(), body } as never,
        k1.privateKey,
      );
      const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(envelope)));
      if (!encoded.ok) throw new Error(encoded.reason);
      socket.write(encoded.frame);
    };
    const connection = await opened.next((id) => !before.has(id));
    put("stop_sync_request", { challenge: hex32() });
    await envelopes.next((e) => e.header.action === "stop_sync_reply");
    return { socket, envelopes, credentials, put, connection, closed, rejected: () => rejected };
  }
  const runs = (state: RunStatus["state"]): RunStatus[] => [{ run_id: RUN, state, run_generation: 1, last_receipt_id: null }];
  const receiptId = uuid();
  const accept = { receipt_id: receiptId, run_id: RUN, instruction_request_id: START, instruction: "task_start" };

  // 1. 첫 연결: 인사 → 접수 영수증. ack 하나와 값 틀 하나가 그 연결에 닿는다.
  const one = await executor();
  one.put("hello", { profile_revision: "profile-1", policy_revision: "policy-1", runs: runs("preparing"), unacked_ids: [] });
  await hellos.next((kind) => kind === "applied");
  expect(server.recognized(R1)).toBe(one.connection);
  one.put("receipt_accepted", accept, 1);
  await one.envelopes.next((e) => e.header.action === "ack");
  expectNames([await attempts.next(() => true)], [`${one.connection}:written:`]);
  const got = await one.credentials.next(() => true);
  expect(one.rejected()).toBeNull();
  expect(one.credentials.all().length).toBe(1);
  expect(got.runId).toBe(RUN);
  expect(got.digest).toBe(DIGEST);
  expect(same(got.value, sampleBytes())).toBe(true);
  got.value.fill(0);
  expect(lent.length).toBe(1);
  expect(allZero(lent[0]!)).toBe(true);
  expect(real.getRun(RUN)).toMatchObject({ known: true, value: { state: "preparing", acceptedReceiptId: receiptId } });

  // 2. 발급 깃발. 같은 실행기가 새 연결로 맞추면 첫 연결이 철회되고 송신기의 그 연결 기억이 지워진다.
  //    새 연결에서 같은 접수 영수증을 다시 보내면(깃발 전이면 새 연결이라 값을 보낸다) 장부는 받지만 ack·값은 나가지 않는다.
  await cycle.closeIssuance();
  const two = await executor();
  two.put("hello", { profile_revision: "profile-1", policy_revision: "policy-1", runs: runs("preparing"), unacked_ids: [] });
  await withdrawn.next((connection) => connection === one.connection);
  expect(forgotten).toEqual([one.connection]);
  await hellos.next((kind) => kind === "applied" && server.recognized(R1) === two.connection);
  two.put("receipt_accepted", accept, 1);
  expectNames([await attempts.next((value) => value.startsWith(`${two.connection}:`))], [`${two.connection}:blocked:intake_closed`]);
  expectNames(
    sinkNotes.flatMap((n) => (n.kind === "not_sent" ? [`${n.action}:${n.reason}`] : [])),
    ["ack:issuance_closed"],
  );
  expect(lent.length).toBe(1);

  // 3. 종료: 깃발이 선 뒤에만 서버를 닫는다. 닫힘의 철회도 기억을 지운다. 둘째 연결에는 값 틀도 ack도 닿지 않았다.
  await issuance.shutdown();
  await two.closed.next(() => true);
  await withdrawn.next((connection) => connection === two.connection);
  expectNames(order, ["issuance_closed", "close:after_flag", "server_closed"]);
  expect(forgotten).toEqual([one.connection, two.connection]);
  expect(two.credentials.all().length).toBe(0);
  expect(two.envelopes.all().filter((e) => e.header.action === "ack").length).toBe(0);
  expect(two.rejected()).toBeNull();
});
