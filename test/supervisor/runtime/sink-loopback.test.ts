// 루프백(127.0.0.1, 운영체제가 고르는 포트)의 실제 상호 TLS로 연 감독 연결 서버에, 실제 sendInstruction → 내보내기 포트(sink.ts) →
// writeFrame으로 시작 봉투 하나를 싣고 실행기 쪽 바이트 틀 디코더에 그대로 닿는지 본다. 인증서는 메모리에서 만든다(파일 없음).
// 실행기 쪽은 tls-client.ts와 봉투만 받는 디코더로 흉내 내고, 맞춤·인사 봉투는 계약 v1로 실제 서명한다.
// 기다리는 것은 소켓·서버의 사건뿐이고 시간을 재서 맞추지 않는다.
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { type Envelope, limits, rawPublicKey, sealEnvelope } from "../../../src/contract/v1/index.ts";
import { sendInstruction } from "../../../src/supervisor/dispatch/send-gate.ts";
import { createWireSink } from "../../../src/supervisor/runtime/sink.ts";
import { RegistryState } from "../../../src/supervisor/transport/registry.ts";
import { type Delivered, startConnectionServer } from "../../../src/supervisor/transport/server.ts";
import { createFrameDecoder, encodeFrame } from "../../../src/transport/framing.ts";
import { createTlsClient } from "../../../src/transport/tls-client.ts";
import { makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../../transport/certs.ts";

const HOST = "127.0.0.1";
const GEN = 3;
const R1 = "executor/isolated_reader/r1/s1";
const RUN = "11111111-1111-4111-8111-111111111111";

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

// 기다리던 사건이 오면 풀리는 약속. 오지 않으면 시험 시간 제한이 실패로 끝낸다.
function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("루프백: 실제 sendInstruction → 내보내기 포트 → 실제 서버로 실은 시작 봉투 하나가 실행기 쪽 디코더에 같은 봉투로 닿는다", async () => {
  const pki = makePki();
  const sup = keys();
  const k1 = keys();
  const now = Date.now();
  const material = (leaf: { pem: string; keyPem: string }) => ({ certificatePem: leaf.pem, privateKeyPem: leaf.keyPem, trustBundlePem: pki.ca.pem });
  const registryDoc = new TextEncoder().encode(
    JSON.stringify({ environment: "home", revision: 1, executors: [{ target: "reader", role: "isolated_reader", instance: "r1", storage: "s1", public_key: k1.raw, active: true }] }),
  );
  const applied = RegistryState.start({ environment: "home", targets: [{ target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] }] }).apply({
    kind: "content",
    content: registryDoc,
  });
  if (applied.kind !== "applied") throw new Error("시험 등록표가 적용되지 않았다");

  // 서버와 포트가 같은 복원기 게시 함수를 쓴다(조립이 지킬 조건).
  const published = { stopGeneration: () => GEN, intakeOpen: () => true };
  const restorer = () => published;
  const greeted = signal<number>();
  const seen = new Set<string>();
  const started = await startConnectionServer({
    host: HOST,
    port: 0,
    material: material(pki.supervisor()),
    clock: () => now,
    registry: applied.state,
    restorer,
    runGeneration: () => undefined,
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
      if (output.kind === "candidate") greeted.resolve(output.connection);
    },
    maxPendingWriteBytes: limits.MAX_MESSAGE_BYTES,
  });
  if (!started.ok) throw new Error(`서버가 시작하지 않았다: ${started.failure.kind}`);
  const server = started.server;
  cleanup.push(() => server.close());

  // 실행기 흉내: 봉투만 받는 디코더로 받은 틀을 푼다.
  const client = createTlsClient({ address: HOST, port: server.port, supervisorDnsName: SUPERVISOR_DNS, supervisorUri: SUPERVISOR_URI, material: material(pki.executor()), now: () => now });
  cleanup.push(() => client.close());
  const socket = (await client.connect()).socket;
  socket.on("error", () => {});
  const decoder = createFrameDecoder();
  const frames: unknown[] = [];
  const arrivals: ReturnType<typeof signal<void>>[] = [signal(), signal()];
  socket.on("data", (chunk: Buffer) => {
    const step = decoder.push(new Uint8Array(chunk));
    expect(step.rejected).toBeNull();
    for (const decoded of step.envelopes) {
      frames.push(decoded.value);
      arrivals[frames.length - 1]?.resolve();
    }
  });
  const put = (envelope: Envelope) => {
    const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(envelope)));
    if (!encoded.ok) throw new Error(encoded.reason);
    socket.write(encoded.frame);
  };
  const fromR1 = (action: string, generation: number, body: unknown) =>
    sealEnvelope({ sender: R1, recipient: "supervisor", action, request_id: uuid(), stop_generation: generation, run_generation: 0, issued_at: now, nonce: hex32(), body } as never, k1.privateKey);

  // 맞춤 → 인사. 인사가 반영되면 서버가 후보를 넘긴다.
  put(fromR1("stop_sync_request", 0, { challenge: hex32() }));
  await arrivals[0]!.promise;
  expect((frames[0] as Envelope).header.action).toBe("stop_sync_reply");
  put(fromR1("hello", GEN, { profile_revision: "profile-1", policy_revision: "policy-1", runs: [], unacked_ids: [] }));
  const connection = await greeted.promise;
  expect(server.recognized(R1)).toBe(connection);

  const wire = createWireSink({
    server,
    restorer,
    withheld: { executors: () => ({ known: true, value: [] }) },
    clock: { now: () => now },
    queries: { add() {}, remove() {} },
  });
  const start = sealEnvelope(
    {
      sender: "supervisor",
      recipient: R1,
      action: "task_start",
      request_id: uuid(),
      stop_generation: GEN,
      run_generation: 1,
      issued_at: now,
      nonce: hex32(),
      body: {
        run_id: RUN,
        role: "isolated_reader",
        profile_revision: "profile-1",
        policy_revision: "policy-1",
        snapshot_digest: "a".repeat(64),
        input_digest: "b".repeat(64),
        deadline_at: now + 600_000,
        budget_tokens: 1000,
        credential: { account: "acct", method: "subscription", revision: "rev-1", digest: "c".repeat(64) },
      },
    },
    sup.privateKey,
  );
  const marks: unknown[] = [];
  const gate = await sendInstruction({ sink: wire.sink }, start, {
    marker: {
      markStartDispatch: (input) => {
        marks.push(input);
        return { ok: true, created: true };
      },
    },
    at: now,
  });
  expect(gate).toEqual({ kind: "answered", answer: "sent" });
  expect(marks).toEqual([{ runId: RUN, requestId: start.header.request_id, now }]);
  await arrivals[1]!.promise;
  expect(frames).toHaveLength(2);
  expect(frames[1]).toEqual(JSON.parse(JSON.stringify(start)));
});
