// 루프백(127.0.0.1, 운영체제가 고르는 포트)의 실제 상호 TLS 연결 서버와 실제 임시 장부로 답 줄을 잇는다. 인증서는 메모리에서 만든다.
// 서버의 deliver → 답 줄 → 처리기(인사·영수증) → 장부, 조회는 실제 내보내기 포트가 등록부에 더한다. 실행기 쪽은 tls-client.ts와
// 봉투만 받는 디코더로 흉내 내고 봉투는 계약 v1로 실제 서명한다. 기다리는 것은 소켓·서버의 사건뿐이고 시간을 재서 맞추지 않는다.
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { type Envelope, limits, rawPublicKey, type RunStatus, sealEnvelope } from "../../../src/contract/v1/index.ts";
import { sealDraft, statusQueryDraft } from "../../../src/supervisor/dispatch/envelopes.ts";
import type { ReceiptLedger } from "../../../src/supervisor/dispatch/receipts.ts";
import { createAnswerLines } from "../../../src/supervisor/runtime/answers.ts";
import { createQueryBook } from "../../../src/supervisor/runtime/query-book.ts";
import { createWireSink } from "../../../src/supervisor/runtime/sink.ts";
import { RegistryState } from "../../../src/supervisor/transport/registry.ts";
import { type Delivered, startConnectionServer } from "../../../src/supervisor/transport/server.ts";
import { createFrameDecoder, encodeFrame } from "../../../src/transport/framing.ts";
import { createTlsClient } from "../../../src/transport/tls-client.ts";
import { grant, open, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";
import { makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../../transport/certs.ts";

const HOST = "127.0.0.1";
const GEN = 0;
const R1 = WORKER_EXECUTOR;

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

function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

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
      if (found !== undefined) {
        seen.splice(seen.indexOf(found), 1);
        return Promise.resolve(found);
      }
      const s = signal<T>();
      waiting.push({
        match,
        done: (value) => {
          seen.splice(seen.indexOf(value), 1);
          s.resolve(value);
        },
      });
      return s.promise;
    },
  };
}

test("루프백: 인사 → 상태 보고 → 밀린 사본이 받은 차례로 실제 장부에 적히고, 조회는 연결과 함께 등록·철회되며, 바뀐 연결 뒤에는 옛 연결의 답이 적히지 않는다", async () => {
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

  // 실제 장부: 정지 세대 0, 접수 허가, 작업자 실행 하나를 preparing(세대 1)까지. 한 번 실패시킬 수 있는 commit.
  const fault = { failAnswer: false };
  const real = open(tempPath(), {
    clock: () => now,
    faults: {
      at(point) {
        if (fault.failAnswer && point === "executor_answer:before_commit") {
          fault.failAnswer = false;
          throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
        }
      },
    },
  });
  if (!real.applyStop({ generation: GEN, stopped: false, now }).ok) throw new Error("정지 세대를 적지 못했다");
  grant(real);
  const admitted = real.admitRun(worker({ now, deadlineAt: now + 600_000 }));
  if (!admitted.ok) throw new Error(`admit: ${admitted.reason}`);
  const RUN = admitted.run.runId;
  if (!real.startRun({ runId: RUN, requestId: uuid(), stopGeneration: GEN, now }).ok) throw new Error("start");
  // 장부에 넘긴 답을 차례로 적는다(덮어쓰지 않고 실제 장부를 그대로 부른다).
  const order: string[] = [];
  const ledger: ReceiptLedger = {
    applyReceipt: (i, f) => real.applyReceipt(i, f),
    recordReport: (i, f) => real.recordReport(i, f),
    applyExecutorAnswer(i, f) {
      order.push(`${i.coverage}:${i.runs.map((r) => r.state).join(",")}@${i.answeredAt}`);
      return real.applyExecutorAnswer(i, f);
    },
  };

  const published = { stopGeneration: () => GEN, intakeOpen: () => true };
  const restorer = () => published;
  const lineRef: { deliver: (output: Delivered) => void } = { deliver: () => {} };
  const candidates = events<number>();
  const withdrawn = events<number>();
  const forwards = events<number>();
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
      if (output.kind === "candidate") candidates.push(output.connection);
      if (output.kind === "withdrawn") withdrawn.push(output.connection);
      if (output.kind === "forward") forwards.push(output.connection);
    },
    maxPendingWriteBytes: limits.MAX_MESSAGE_BYTES,
  });
  if (!started.ok) throw new Error(`서버가 시작하지 않았다: ${started.failure.kind}`);
  const server = started.server;
  cleanup.push(() => server.close());

  const queries = createQueryBook();
  const wire = createWireSink({ server, restorer, withheld: { executors: () => ({ known: true, value: [] }) }, clock: { now: () => now }, queries });
  const gate = { settled: true };
  const answered = events<string>();
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
    observationsSettled: () => gate.settled,
    observe: (note) => {
      if (note.kind === "status" || note.kind === "hello") answered.push(note.kind === "status" ? note.outcome.outcome : note.outcome.kind);
    },
  });
  lineRef.deliver = (output) => lines.deliver(output);

  // 실행기 흉내 하나: 연결 하나, 받은 틀을 푸는 디코더, 조회에 답하는 함수.
  async function executor() {
    const client = createTlsClient({ address: HOST, port: server.port, supervisorDnsName: SUPERVISOR_DNS, supervisorUri: SUPERVISOR_URI, material: material(pki.executor()), now: () => now });
    cleanup.push(() => client.close());
    const socket = (await client.connect()).socket;
    socket.on("error", () => {});
    const decoder = createFrameDecoder();
    const frames = events<Envelope>();
    socket.on("data", (chunk: Buffer) => {
      const step = decoder.push(new Uint8Array(chunk));
      for (const decoded of step.envelopes) frames.push(decoded.value as Envelope);
    });
    const put = (action: string, body: unknown, generation = GEN) => {
      const envelope = sealEnvelope({ sender: R1, recipient: "supervisor", action, request_id: uuid(), stop_generation: generation, run_generation: 0, issued_at: now, nonce: hex32(), body } as never, k1.privateKey);
      const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(envelope)));
      if (!encoded.ok) throw new Error(encoded.reason);
      socket.write(encoded.frame);
    };
    put("stop_sync_request", { challenge: hex32() });
    await frames.next((e) => e.header.action === "stop_sync_reply");
    return { socket, frames, put };
  }
  const runs = (state: RunStatus["state"]): RunStatus[] => [{ run_id: RUN, state, run_generation: state === "not_known" ? null : 1, last_receipt_id: null }];
  // 감독이 실제 내보내기 포트로 조회 하나를 싣는다. 포트가 쓰기 전에 그 연결과 함께 등록한다.
  async function ask(): Promise<string> {
    const drafted = statusQueryDraft({ recipient: R1, stopGeneration: GEN, runIds: [RUN] }, { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) });
    if (!drafted.ok) throw new Error(drafted.reason);
    const sealed = sealDraft(drafted.draft, now, { random: { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) }, signer: { seal: (input) => sealEnvelope(input, sup.privateKey) } });
    if (!sealed.ok) throw new Error(sealed.reason);
    expect(await wire.sink.send(sealed.envelope)).toBe("sent");
    return sealed.envelope.header.request_id;
  }

  // 1. 첫 연결의 인사(full) → 조회 → 그 답이 저장 실패(밀린 사본) → 다음 조회의 답 앞에 밀린 사본이 먼저 적힌다.
  const one = await executor();
  one.put("hello", { profile_revision: "profile-1", policy_revision: "policy-1", runs: runs("preparing"), unacked_ids: [] });
  const c1 = await candidates.next(() => true);
  await answered.next((kind) => kind === "applied");
  const q1 = await ask();
  expect(queries.pending().map((q) => [q.requestId, q.connection])).toEqual([[q1, c1]]);
  const asked1 = await one.frames.next((e) => e.header.action === "status_query");
  fault.failAnswer = true;
  one.put("status_report", { in_reply_to: asked1.header.request_id, runs: runs("running") });
  await forwards.next((connection) => connection === c1);
  await answered.next((kind) => kind === "status_matched");
  expect(lines.backlog(R1).map((c) => c.connection)).toEqual([c1]);
  // 대조한 조회는 끝났다.
  expect(queries.pending()).toEqual([]);
  const q2 = await ask();
  const asked2 = await one.frames.next((e) => e.header.action === "status_query" && e.header.request_id === q2);
  one.put("status_report", { in_reply_to: asked2.header.request_id, runs: runs("running") });
  await forwards.next((connection) => connection === c1);
  await answered.next((kind) => kind === "status_matched");
  expect(order).toEqual([`full:preparing@${now}`, `partial:running@${now}`, `partial:running@${now}`, `partial:running@${now}`]);
  expect(lines.backlog(R1)).toEqual([]);

  // 2. 답하지 않은 조회는 그 연결이 철회되면 끝난다.
  await ask();
  expect(queries.pending().map((q) => q.connection)).toEqual([c1]);

  // 3. 복원 관측 대기 중에 첫 연결의 답이 줄에 들어오고, 같은 실행기가 새 연결로 맞추고 인사한다.
  //    줄이 풀리면 옛 연결의 답은 지금 연결의 답으로 적히지 않고(장부 호출 0) 안다는 사본으로 밀린 목록에 남는다.
  gate.settled = false;
  const q4 = await ask();
  const asked4 = await one.frames.next((e) => e.header.action === "status_query" && e.header.request_id === q4);
  one.put("status_report", { in_reply_to: asked4.header.request_id, runs: runs("running") });
  // 옛 연결의 답이 서버를 지나 줄에 들어온 뒤에 새 연결을 맺는다(그 전에 밀려나면 서버가 그 답을 버린다).
  await forwards.next((connection) => connection === c1);
  const two = await executor();
  two.put("hello", { profile_revision: "profile-1", policy_revision: "policy-1", runs: runs("running"), unacked_ids: [] });
  const c2 = await candidates.next(() => true);
  // 새 연결의 맞춤이 옛 연결을 밀어냈다. 옛 연결의 답하지 않은 조회(2의 것)는 철회와 함께 끝났고, 이미 받아 줄에 선 답의 조회만 남았다.
  await withdrawn.next((connection) => connection === c1);
  expect(queries.pending().map((q) => [q.requestId, q.connection])).toEqual([[q4, c1]]);
  expect(server.recognized(R1)).toBe(c2);
  const before = order.length;
  gate.settled = true;
  lines.pump();
  await answered.next((kind) => kind === "status_not_current");
  // 옛 연결의 답은 장부에 닿지 않았다. 그 안다는 사본이 밀린 목록에 남아 있는 동안 새 연결의 인사도 그 뒤에 줄 서고(receipts.md
  // "밀린 답"), 그 실행기는 맡기지 않을 실행기로 남는다.
  expect(order.slice(before)).toEqual([]);
  expect(lines.backlog(R1).map((c) => [c.connection, c.runs[0]?.state])).toEqual([[c1, "running"]]);
  expect(lines.withheld.executors()).toEqual({ known: true, value: [R1] });
  expect(queries.pending()).toEqual([]);
  expect(real.getRun(RUN)).toMatchObject({ known: true, value: { state: "preparing" } });
});
