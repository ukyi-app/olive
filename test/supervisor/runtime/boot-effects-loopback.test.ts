// 루프백(127.0.0.1, 운영체제가 고르는 포트)의 실제 상호 TLS 서버·실제 임시 장부로 조립(boot.ts)을 띄우고, 박자의 기한이 지났거나
// 받아들인 접수 허가가 버려진 뒤에는 장부에 발급을 적지도, 실행기에 싣지도 않는지 본다. 대조군은 같은 입력에서 기한 안·허가 유효다.
// 입력(실행 준비, 시계 건너뛰기, 정지 기록)은 박자 하나가 끝난 직후의 기록 훅에서 한 동기 구간에 넣는다: 그 실행의 지시는 입력 뒤에만
// 생길 수 있으므로 실행기가 받은 전체 봉투로 셀 수 있다.
import { afterEach, expect, test } from "bun:test";
import { type Envelope, sealEnvelope } from "../../../src/contract/v1/index.ts";
import { openLedger } from "../../../src/ledger/index.ts";
import { bootSupervisor, type LogFields, type SupervisorDeps } from "../../../src/supervisor/runtime/boot.ts";
import { createFileResultBackend } from "../../../src/supervisor/scheduler/result-store-file.ts";
import { startConnectionServer } from "../../../src/supervisor/transport/server.ts";
import { createFrameDecoder, encodeFrame } from "../../../src/transport/framing.ts";
import { createTlsClient } from "../../../src/transport/tls-client.ts";
import { id, must, worker } from "../../ledger/helpers.ts";
import { makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../../transport/certs.ts";
import {
  baseSettings,
  type Captured,
  capturingMakers,
  EXECUTOR,
  executorKey,
  FILES,
  FRONT_ROWS,
  installedLedger,
  loopbackTime,
  registryDoc,
  resultDir,
  supervisorKeyPem,
} from "./boot-world.ts";

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
    // 지금부터 처음 오는 맞는 사건.
    after(match: (value: T) => boolean): Promise<T> {
      return new Promise<T>((resolve) => waiting.push({ match, done: resolve }));
    },
    all: () => [...seen],
  };
}

// slow_beat: 갱신할 실행을 넣고 다음 박자의 서버 tick이 단조 시계를 박자 한도 + 1ms 옮긴다. renew_in_time: 같은 실행, 지연 없음.
// discard: 상태를 물을 실행을 넣고 같은 구간에서 새 정지를 적는다(받아들인 허가가 버려진다). query_in_time: 같은 실행, 정지 없음.
type Scenario = "slow_beat" | "renew_in_time" | "discard" | "query_in_time";

async function scenario(kind: Scenario) {
  const pki = makePki();
  const k1 = executorKey();
  const leaf = pki.supervisor();
  const { path } = installedLedger();
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
  const captured: Captured = { pumps: 0, delivers: 0 };
  const commits: string[] = [];
  const settings = baseSettings(path, resultDir(), {
    timing: { beatEveryMs: 20, beatWaitMs: 5_000, restoreStepWaitMs: 10_000, startupWaitMs: 10_000, stopWaitMs: 10_000 },
  });
  const time = loopbackTime();
  let monoOffset = 0;
  let wallOffset = 0;
  let delayNextTick = false;
  // 박자 하나가 끝난 직후(beat_time 기록) 한 번 부를 입력. 기록기는 던짐을 삼키므로 실패를 따로 쥔다.
  let onBeat: (() => void) | null = null;
  let inputFailed: unknown = null;
  const deps: SupervisorDeps = {
    readFile: async (file) => {
      const bytes = files.get(file);
      if (bytes === undefined) throw new Error("ENOENT");
      return bytes;
    },
    openLedger: (file, options) =>
      openLedger(file, {
        ...options,
        faults: {
          at(point) {
            if (point.endsWith(":before_commit")) commits.push(point.split(":")[0]!);
          },
        },
      }),
    createResultBackend: createFileResultBackend,
    startServer: async (options) => {
      const started = await startConnectionServer(options);
      if (started.ok) {
        const tick = started.server.tick.bind(started.server);
        started.server.tick = () => {
          tick();
          if (delayNextTick) {
            delayNextTick = false;
            monoOffset += settings.timing.beatWaitMs + 1;
          }
        };
      }
      return started;
    },
    credentialFiles: { read: async () => ({ kind: "missing" }) as never },
    frontDoor: {
      stopAuthority: { latestStop: () => stopGate.promise },
      publications: { lookup: () => Promise.reject(new Error("front_door_absent")) },
      peers: { contracts: async () => (await peersGate.promise, FRONT_ROWS) },
    },
    evidence: { read: () => ({ known: false }), confirm: () => "link_not_current" },
    wallNow: () => time.wall() + wallOffset,
    monoNow: () => time.mono() + monoOffset,
    setTimer: time.setTimer,
    random: time.random,
    log: (event, fields = {}) => {
      log.push({ event, fields });
      if (event === "beat_time" && onBeat !== null) {
        const input = onBeat;
        onBeat = null;
        try {
          input();
        } catch (error) {
          inputFailed = error;
        }
      }
    },
    make: capturingMakers(captured, []),
  };
  const booted = await bootSupervisor(settings, deps, new AbortController().signal);
  if (!booted.ok) throw new Error(`기동하지 못했다: ${booted.step} ${booted.reason}`);
  const running = booted.running;
  let ended = false;
  cleanup.push(async () => {
    if (!ended) await running.stop();
  });
  const port = (await log.next((e) => e.event === "boot_step" && e.fields.step === "server")).fields.port as number;

  const own = pki.executor();
  const client = createTlsClient({ address: HOST, port, supervisorDnsName: SUPERVISOR_DNS, supervisorUri: SUPERVISOR_URI, material: { certificatePem: own.pem, privateKeyPem: own.keyPem, trustBundlePem: pki.ca.pem }, now: time.wall });
  cleanup.push(() => client.close());
  stopGate.resolve(null);
  await log.next((e) => e.event === "restore_step" && e.fields.step === 1);
  const socket = (await client.connect()).socket;
  socket.on("error", () => {});
  const decoder = createFrameDecoder();
  const envelopes = queue<Envelope>();
  const closed = deferred<true>();
  socket.on("close", () => closed.resolve(true));
  socket.on("data", (chunk: Buffer) => {
    for (const decoded of decoder.push(new Uint8Array(chunk)).envelopes) envelopes.push(decoded.value as Envelope);
  });
  const put = (action: string, body: unknown) => {
    const envelope = sealEnvelope({ sender: EXECUTOR, recipient: "supervisor", action, request_id: uuid(), stop_generation: 0, run_generation: 0, issued_at: time.wall(), nonce: hex32(), body } as never, k1.privateKey);
    const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(envelope)));
    if (!encoded.ok) throw new Error(encoded.reason);
    socket.write(encoded.frame);
  };
  put("stop_sync_request", { challenge: hex32() });
  await envelopes.next((e) => e.header.action === "stop_sync_reply");
  put("hello", { profile_revision: "profile-1", policy_revision: "policy-1", runs: [], unacked_ids: [] });
  const live = () => captured.lines!.ports.table().candidates(captured.restorer!.value).length;
  for (let i = 0; i < 200 && live() === 0; i += 1) await log.after((e) => e.event === "beat");
  expect(live()).toBe(1);
  peersGate.resolve();
  const step5 = await log.next((e) => e.event === "restore_step" && e.fields.step === 5);
  expect(step5.fields).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });

  const ledger = captured.restorer!.ledger;
  const commitsBefore = { value: 0 };
  onBeat = () => {
    commitsBefore.value = commits.length;
    const at = time.wall() + wallOffset;
    const run = must(ledger.admitRun(worker({ now: at, deadlineAt: at + 600_000 }))).run;
    const request = id();
    must(ledger.startRun({ runId: run.runId, requestId: request, stopGeneration: 0, now: at }));
    if (kind === "slow_beat" || kind === "renew_in_time") {
      must(ledger.applyReceipt({ action: "receipt_accepted", receiptId: id(), runId: run.runId, instructionRequestId: request, instruction: "task_start", bodyDigest: "a".repeat(64), now: at }, { sender: run.executorId, runGeneration: run.runGeneration }));
      // 임대가 갱신 구간에 들도록 장부 시계를 옮긴다. slow_beat은 다음 박자의 서버 tick이 박자 한도를 넘긴다.
      wallOffset = 10_000;
      if (kind === "slow_beat") delayNextTick = true;
    } else {
      // 끊긴 실행(unknown_running)은 다음 박자의 수명 박자가 상태를 묻는다.
      must(ledger.markLost(at));
      if (kind === "discard") must(ledger.applyStop({ generation: 1, stopped: true, now: at }));
    }
  };
  const wanted = kind === "renew_in_time" ? "run_renew" : kind === "query_in_time" ? "status_query" : null;
  let code: number;
  if (wanted !== null) {
    await envelopes.next((e) => e.header.action === wanted);
    code = await running.stop();
  } else code = await running.done;
  ended = true;
  await closed.promise;
  expect(inputFailed).toBeNull();
  return {
    code,
    received: envelopes.all().map((e) => e.header.action),
    afterInput: commits.slice(commitsBefore.value),
    fatal: log
      .all()
      .filter((e) => e.event === "fatal")
      .map((e) => e.fields.reason),
  };
}

test("F1: 박자 한도를 넘긴 박자는 갱신을 장부에 적지도 싣지도 않고 96이다. 대조군(기한 안)은 갱신을 적고 싣는다", async () => {
  const slow = await scenario("slow_beat");
  expect(slow.code).toBe(96);
  expect(slow.fatal).toEqual(["beat_lapsed"]);
  expect(slow.received.filter((action) => action === "run_renew")).toEqual([]);
  expect(slow.afterInput).not.toContain("renew_instruction");

  const control = await scenario("renew_in_time");
  expect(control.code).toBe(0);
  expect(control.fatal).toEqual([]);
  expect(control.received).toContain("run_renew");
  expect(control.afterInput).toContain("renew_instruction");
}, 20_000);

test("F4: 받아들인 허가가 정지로 버려지면 다음 박자 전에 96이고 상태 조회를 싣지 않는다. 대조군(허가 유효)은 조회를 싣는다", async () => {
  const discard = await scenario("discard");
  expect(discard.code).toBe(96);
  expect(discard.fatal).toEqual(["intake_discarded"]);
  expect(discard.received.filter((action) => action === "status_query")).toEqual([]);
  expect(discard.afterInput).toEqual(["admit", "start", "lost", "stop"]);

  const control = await scenario("query_in_time");
  expect(control.code).toBe(0);
  expect(control.fatal).toEqual([]);
  expect(control.received).toContain("status_query");
}, 20_000);
