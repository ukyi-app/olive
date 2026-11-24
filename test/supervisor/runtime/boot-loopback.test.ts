// 루프백(127.0.0.1, 운영체제가 고르는 포트)의 실제 상호 TLS 연결 서버·실제 임시 장부·실제 결과 보관 폴더로 조립(boot.ts)을 띄운다.
// 현관 포트만 가짜다(답을 시험이 연다). 실행기 쪽 시험 클라이언트 하나가 맞추고 인사하고, 복원 5단계 뒤 박자가 도는 것까지 본다.
// 시계·타이머는 실제다. 기다리는 것은 조립의 기록과 소켓 사건뿐이고 시간을 재서 맞추지 않는다.
import { afterEach, expect, test } from "bun:test";
import { getRandomValues } from "node:crypto";
import { type Envelope, sealEnvelope } from "../../../src/contract/v1/index.ts";
import { openLedger } from "../../../src/ledger/index.ts";
import { bootSupervisor, type LogFields, type SupervisorDeps } from "../../../src/supervisor/runtime/boot.ts";
import { createFileResultBackend } from "../../../src/supervisor/scheduler/result-store-file.ts";
import { startConnectionServer } from "../../../src/supervisor/transport/server.ts";
import { createFrameDecoder, encodeFrame } from "../../../src/transport/framing.ts";
import { createTlsClient } from "../../../src/transport/tls-client.ts";
import { makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../../transport/certs.ts";
import { baseSettings, type Captured, capturingMakers, EXECUTOR, executorKey, FILES, FRONT_ROWS, installedLedger, registryDoc, resultDir, supervisorKeyPem } from "./boot-world.ts";

const HOST = "127.0.0.1";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

let counter = 0;
const hex32 = () => (++counter).toString(16).padStart(32, "0");
const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

// 기다리는 사건의 큐. 사건이 오면 맞는 기다림을 푼다.
function queue<T>() {
  const seen: T[] = [];
  const waiting: { match: (value: T) => boolean; done: (value: T) => void }[] = [];
  return {
    push(value: T) {
      seen.push(value);
      for (const w of waiting.splice(0)) {
        if (w.match(value)) w.done(value);
        else waiting.push(w);
      }
    },
    next(match: (value: T) => boolean): Promise<T> {
      const found = seen.find(match);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise<T>((resolve) => waiting.push({ match, done: resolve }));
    },
    // 지금부터 n번째로 오는 맞는 사건.
    after(match: (value: T) => boolean, n: number): Promise<T> {
      let left = n;
      return new Promise<T>((resolve) =>
        waiting.push({
          match: (value) => match(value) && --left === 0,
          done: resolve,
        }),
      );
    },
    all: () => [...seen],
  };
}

test("루프백: 복원 1단계 전의 맞춤에는 답하지 않고, 현관이 답한 뒤 실행기 하나가 맞추고 인사하면 5단계를 지나 박자가 돌며, 멈춤은 발급 닫기 → 서버 닫기 → 장부 닫기다", async () => {
  const pki = makePki();
  const k1 = executorKey();
  const leaf = pki.supervisor();
  const { path } = installedLedger();
  const results = resultDir();
  const files = new Map<string, Uint8Array>([
    [FILES.certificate, new TextEncoder().encode(leaf.pem)],
    [FILES.privateKey, new TextEncoder().encode(leaf.keyPem)],
    [FILES.trustBundle, new TextEncoder().encode(pki.ca.pem)],
    [FILES.signingKey, new TextEncoder().encode(supervisorKeyPem())],
    [FILES.registry, registryDoc([{ publicKeyRaw: k1.raw }])],
  ]);
  const stopGate = deferred<null>();
  const peersGate = deferred<void>();
  const log = queue<{ event: string; fields: LogFields }>();
  const order: string[] = [];
  const captured: Captured = { pumps: 0, delivers: 0 };
  const deps: SupervisorDeps = {
    readFile: async (file) => {
      const bytes = files.get(file);
      if (bytes === undefined) throw new Error("ENOENT");
      return bytes;
    },
    openLedger,
    createResultBackend: createFileResultBackend,
    startServer: startConnectionServer,
    credentialFiles: { read: async () => ({ kind: "missing" }) as never },
    frontDoor: {
      stopAuthority: { latestStop: () => stopGate.promise },
      publications: { lookup: () => Promise.reject(new Error("front_door_absent")) },
      peers: { contracts: async () => (await peersGate.promise, FRONT_ROWS) },
    },    wallNow: Date.now,
    monoNow: () => performance.now(),
    setTimer: (ms, fire) => {
      const handle = setTimeout(fire, ms);
      return () => clearTimeout(handle);
    },
    random: { bytes: (length) => getRandomValues(new Uint8Array(length)) },
    log: (event, fields = {}) => {
      if (event === "shutdown_called" || event === "stopped") order.push(event);
      if (event === "issuance" && fields.kind === "shutdown") order.push(String(fields.step));
      log.push({ event, fields });
    },
    make: capturingMakers(captured, []),
  };
  const settings = baseSettings(path, results, {
    timing: { beatEveryMs: 20, beatWaitMs: 5_000, restoreStepWaitMs: 10_000, startupWaitMs: 10_000, stopWaitMs: 10_000 },
  });
  const booted = await bootSupervisor(settings, deps, new AbortController().signal);
  if (!booted.ok) throw new Error(`기동하지 못했다: ${booted.step} ${booted.reason}`);
  const running = booted.running;
  let stopped = false;
  cleanup.push(async () => {
    if (!stopped) await running.stop();
  });
  const port = (await log.next((e) => e.event === "boot_step" && e.fields.step === "server")).fields.port as number;
  expect(port).toBeGreaterThan(0);

  // 실행기 흉내: 연결 하나, 봉투 디코더.
  async function executor() {
    const own = pki.executor();
    const client = createTlsClient({ address: HOST, port, supervisorDnsName: SUPERVISOR_DNS, supervisorUri: SUPERVISOR_URI, material: { certificatePem: own.pem, privateKeyPem: own.keyPem, trustBundlePem: pki.ca.pem }, now: () => Date.now() });
    cleanup.push(() => client.close());
    const socket = (await client.connect()).socket;
    socket.on("error", () => {});
    const decoder = createFrameDecoder();
    const envelopes = queue<Envelope>();
    const closed = deferred<true>();
    socket.on("close", () => closed.resolve(true));
    socket.on("data", (chunk: Buffer) => {
      const step = decoder.push(new Uint8Array(chunk));
      for (const decoded of step.envelopes) envelopes.push(decoded.value as Envelope);
    });
    const put = (action: string, body: unknown) => {
      const envelope = sealEnvelope({ sender: EXECUTOR, recipient: "supervisor", action, request_id: uuid(), stop_generation: 0, run_generation: 0, issued_at: Date.now(), nonce: hex32(), body } as never, k1.privateKey);
      const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(envelope)));
      if (!encoded.ok) throw new Error(encoded.reason);
      socket.write(encoded.frame);
    };
    return { socket, envelopes, put, closed: closed.promise, client };
  }
  const beat = (e: { event: string }) => e.event === "beat";

  // 1. 복원 1단계 전(현관이 아직 답하지 않음): 맞춤 요청에 답이 없고 답 줄의 deliver는 0이다.
  const early = await executor();
  early.put("stop_sync_request", { challenge: hex32() });
  await log.after(beat, 5);
  expect(early.envelopes.all().length).toBe(0);
  expect(captured.delivers).toBe(0);
  expect(captured.restorer!.value.stopGeneration()).toBeNull();
  early.client.close();

  // 2. 현관이 "기록 없음"을 답한다 → 1단계. 실행기가 맞추고 인사한다. 2단계는 현관의 이웃 행을 기다린다.
  stopGate.resolve(null);
  await log.next((e) => e.event === "restore_step" && e.fields.step === 1);
  const one = await executor();
  one.put("stop_sync_request", { challenge: hex32() });
  const reply = await one.envelopes.next((e) => e.header.action === "stop_sync_reply");
  expect(reply.header.stop_generation).toBe(0);
  one.put("hello", { profile_revision: "profile-1", policy_revision: "policy-1", runs: [], unacked_ids: [] });
  const live = () => captured.lines!.ports.table().candidates(captured.restorer!.value).length;
  for (let i = 0; i < 200 && live() === 0; i += 1) await log.after(beat, 1);
  expect(live()).toBe(1);

  // 3. 현관 행이 오면 2~5단계: 실행기 행(같은 연결 신원, 정책 일치)과 전체 점유가 맞아 접수가 열린다.
  peersGate.resolve();
  const step5 = await log.next((e) => e.event === "restore_step" && e.fields.step === 5);
  expect(step5.fields).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });
  expect(captured.restorer!.value.intakeOpen()).toBe(true);
  // 2단계 뒤의 박자에서 쥐었던 인사가 반영된다.
  const hello = await log.next((e) => e.event === "hello");
  expect(hello.fields).toEqual({ outcome: "applied" });
  // 5단계 뒤의 박자는 끊김·수명·재전송을 부른다.
  const ran = await log.next((e) => beat(e) && e.fields.linkLoss === "returned");
  expect(ran.fields).toMatchObject({ kind: "ran", serverTick: "ok", clock: "ok", life: "returned", resend: "returned" });
  expect(log.all().some((e) => e.event === "fatal")).toBe(false);

  // 4. 멈춤: 발급 닫기 → 서버 닫기(연결이 끊긴다) → 장부 닫기 → 0.
  stopped = true;
  expect(await running.stop()).toBe(0);
  await one.closed;
  expect(order).toEqual(["shutdown_called", "issuance_closed", "server_closed", "stopped"]);
  const again = openLedger(path, { clock: () => Date.now(), mode: "reopen" });
  expect(again.ok).toBe(true);
  if (again.ok) again.ledger.close();
});
