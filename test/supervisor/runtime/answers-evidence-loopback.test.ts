// 루프백(127.0.0.1, 운영체제가 고르는 포트)의 실제 상호 TLS 연결 서버와 실제 임시 장부 위에서 답 줄의 D-90 증거 포트를 닫기 박자에 묶는다.
// 서버의 deliver → 답 줄 → 인사 처리기 → 장부, 박자의 포트는 같은 답 줄의 evidence·withheld와 서버·내보내기 포트에 넘긴 그 복원기다.
// 실행기 쪽은 tls-client.ts와 봉투만 받는 디코더로 흉내 내고 봉투는 계약 v1로 실제 서명한다. 기다리는 것은 소켓·서버의 사건뿐이다.
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, X509Certificate } from "node:crypto";
import { type Envelope, limits, rawPublicKey, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { UnreceivedClosureInput } from "../../../src/ledger/index.ts";
import { type UnreceivedPorts, type UnreceivedTickResult, unreceivedTick } from "../../../src/supervisor/dispatch/unreceived.ts";
import { createAnswerEvidenceBook, createAnswerLines } from "../../../src/supervisor/runtime/answers.ts";
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
      return new Promise<T>((resolve) => {
        waiting.push({
          match,
          done: (value) => {
            seen.splice(seen.indexOf(value), 1);
            resolve(value);
          },
        });
      });
    },
  };
}

test("루프백: 시한 뒤 실행기가 빈 full로 인사하면 증거 포트가 그 인사를 내고 박자가 실제 장부로 한 번 닫는다. 인사 전에는 no_full로 0회다", async () => {
  // 시작 발행(t0) 뒤 30,000ms를 시험 시계로 옮긴다. 서버·장부·실행기가 같은 값을 읽는다.
  // 인증서 기간은 TLS 라이브러리가 프로세스 시계로 보므로 도우미(makePki)가 실제 시각을 기준으로 만든다. 시험 시계의 시작은 그
  // 기준에서 얻는다(발급 기관의 notBefore가 기준 - 1시간, 초 단위로 내림). 이 파일은 벽시계를 직접 읽지 않는다.
  const pki = makePki();
  let now = Date.parse(new X509Certificate(pki.ca.pem).validFrom) + 3_600_000;
  const t0 = now;
  const sup = keys();
  const k1 = keys();
  const material = (leaf: { pem: string; keyPem: string }) => ({ certificatePem: leaf.pem, privateKeyPem: leaf.keyPem, trustBundlePem: pki.ca.pem });
  const registryDoc = new TextEncoder().encode(
    JSON.stringify({ environment: "home", revision: 1, executors: [{ target: "reader", role: "diagnosis", instance: "0", storage: "store-a", public_key: k1.raw, active: true }] }),
  );
  const applied = RegistryState.start({ environment: "home", targets: [{ target: "reader", namespace: "olive-reader", roles: ["diagnosis"] }] }).apply({ kind: "content", content: registryDoc });
  if (applied.kind !== "applied") throw new Error("시험 등록표가 적용되지 않았다");

  // 실제 장부: 정지 세대 0, 접수 허가, 작업자 실행 하나를 시작 지시·송신 표식까지(발행 = t0).
  const real = open(tempPath(), { clock: () => now });
  if (!real.applyStop({ generation: GEN, stopped: false, now }).ok) throw new Error("정지 세대를 적지 못했다");
  grant(real);
  const admitted = real.admitRun(worker({ now, deadlineAt: now + 600_000 }));
  if (!admitted.ok) throw new Error(`admit: ${admitted.reason}`);
  const RUN = admitted.run.runId;
  const startRequest = uuid();
  if (!real.startRun({ runId: RUN, requestId: startRequest, stopGeneration: GEN, now }).ok) throw new Error("start");
  if (!real.markStartDispatch({ runId: RUN, requestId: startRequest, now }).ok) throw new Error("mark");

  const published = { stopGeneration: () => GEN, intakeOpen: () => true };
  const restorer = () => published;
  const lineRef: { deliver: (output: Delivered) => void } = { deliver: () => {} };
  const candidates = events<number>();
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
    },
    maxPendingWriteBytes: limits.MAX_MESSAGE_BYTES,
  });
  if (!started.ok) throw new Error(`서버가 시작하지 않았다: ${started.failure.kind}`);
  const server = started.server;
  cleanup.push(() => server.close());

  const queries = createQueryBook();
  const lineHolder: { withheld: () => unknown } = { withheld: () => ({ known: true, value: [] }) };
  const wire = createWireSink({ server, restorer, withheld: { executors: () => lineHolder.withheld() as never }, clock: { now: () => now }, queries });
  const answered = events<string>();
  const lines = createAnswerLines({
    table: () => server.table(),
    restorer,
    ledger: real,
    results: { backend: {} as never, ledger: real },
    random: { bytes: (length) => crypto.getRandomValues(new Uint8Array(length)) },
    signer: { seal: (input) => sealEnvelope(input, sup.privateKey) },
    clock: { now: () => now },
    wire,
    queries,
    cycle: { noteCandidate: () => {} },
    observationsSettled: () => true,
    observe: (note) => {
      if (note.kind === "hello") answered.push(note.outcome.kind);
    },
    evidenceBook: createAnswerEvidenceBook(),
  });
  lineRef.deliver = (output) => lines.deliver(output);
  lineHolder.withheld = () => lines.withheld.executors();

  // 조립(N5)이 묶을 그대로: 같은 장부, 같은 답 줄의 증거·맡기지 않을 실행기, 서버·내보내기 포트에 넘긴 그 복원기, 같은 복원 대기 신호.
  const closes: UnreceivedClosureInput[] = [];
  const ports = {
    ledger: {
      unansweredInstructions: () => real.unansweredInstructions(),
      closeUnreceivedRun(input: UnreceivedClosureInput, from: { sender: string }) {
        closes.push(input);
        return real.closeUnreceivedRun(input, from);
      },
    },
    evidence: lines.evidence,
    withheld: lines.withheld,
    intake: published,
    observationsSettled: () => true,
  } as unknown as UnreceivedPorts;
  const runs = (result: UnreceivedTickResult) => (result.kind === "ran" ? result.runs : result);
  const state = () => {
    const read = real.getRun(RUN);
    return read.known && read.value !== null ? read.value.state : null;
  };

  // 1. 실행기가 아직 인사하지 않았다: 마지막 반영 인사가 없어 장부를 부르지 않는다.
  now = t0 + 30_000;
  expect(runs(unreceivedTick(ports, now))).toEqual([{ requestId: startRequest, runId: RUN, executorId: R1, outcome: "skipped", reason: "no_full" }]);
  expect(closes.length).toBe(0);

  // 2. 실행기가 맞추고 그 시작을 모르는 빈 full로 인사한다(서명 시각 = 발행 + 30,000).
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
  const put = (action: string, body: unknown) => {
    const envelope = sealEnvelope({ sender: R1, recipient: "supervisor", action, request_id: uuid(), stop_generation: GEN, run_generation: 0, issued_at: now, nonce: hex32(), body } as never, k1.privateKey);
    const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(envelope)));
    if (!encoded.ok) throw new Error(encoded.reason);
    socket.write(encoded.frame);
  };
  put("stop_sync_request", { challenge: hex32() });
  await frames.next((e) => e.header.action === "stop_sync_reply");
  put("hello", { profile_revision: "profile-1", policy_revision: "policy-1", runs: [], unacked_ids: [] });
  const c1 = await candidates.next(() => true);
  expect(await answered.next(() => true)).toBe("applied");
  expect(server.recognized(R1)).toBe(c1);
  expect(lines.evidence.read(R1)).toMatchObject({ known: true, tainted: false, pending: false, lastFull: { connection: c1, principal: R1, stopGeneration: GEN, runs: [], answeredAt: t0 + 30_000, receivedAt: t0 + 30_000 } });

  // 3. 같은 박자가 이번에는 그 인사로 장부를 한 번 불러 닫는다.
  now = t0 + 30_010;
  expect(runs(unreceivedTick(ports, now))).toEqual([{ requestId: startRequest, runId: RUN, executorId: R1, outcome: "closed", connection: c1, answeredAt: t0 + 30_000, at: t0 + 30_010 }]);
  expect(closes).toEqual([{ runId: RUN, runs: [], answeredAt: t0 + 30_000, receivedAt: t0 + 30_000, now: t0 + 30_010 }]);
  expect(state()).toBe("not_started");
});
