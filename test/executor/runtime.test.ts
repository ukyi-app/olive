// 실행기 기동 조립(runtime.ts)의 보장: 단계의 차례, 대리 hello 전에는 감독에 붙지 않음, 실패마다 정한 코드와 연결 0,
// 감독 소켓 하나와 stop() 뒤의 클라이언트 닫기, tick 주기, 연결 뒤 지시 처리가 던지면 끝남.
// 파일·저장소 열기·대리 듣기·TLS 클라이언트·타이머는 가짜다. 마지막 사례만 루프백의 실제 상호 TLS로 감독 흉내에 붙는다.
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type * as tls from "node:tls";
import { ControlDecoder, encodeAgent, encodeControl, type ReceivedControl } from "../../src/agent/link.ts";
import type { Envelope } from "../../src/contract/v1/index.ts";
import type { RemoteAgent } from "../../src/executor/remote-agent.ts";
import { REVISION as CONTRACT_REVISION } from "../../src/contract/v1/schema.ts";
import {
  EXECUTOR_EXIT,
  type ExecutorDeps,
  type ExecutorSettings,
  type StartResult,
  parseProfile,
  type StartStep,
  startExecutor,
} from "../../src/executor/runtime.ts";
import { ExecutorStore } from "../../src/executor/store.ts";
import { WorkerExecutor } from "../../src/executor/worker.ts";
import { settingsFromEnv } from "../../src/main/executor.ts";
import { startTlsServer } from "../../src/supervisor/transport/tls-server.ts";
import { createFrameDecoder, encodeFrame } from "../../src/transport/framing.ts";
import { createTlsClient, TlsConnectError } from "../../src/transport/tls-client.ts";
import { makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../transport/certs.ts";
import {
  Clock,
  credentialValue,
  executorKeys,
  FakeTransport,
  fromSupervisor,
  POD_UID,
  type Rig,
  runWrite,
  scratch,
  scriptedIo,
  sha256,
  stopWrite,
  supervisorKeys,
  T0,
  taskStartBody,
  until,
} from "./support.ts";

const pki = makePki();
const leaf = pki.executor();
const pemOf = (key: { export(options: { type: "pkcs8" | "spki"; format: "pem" }): string | Buffer }, type: "pkcs8" | "spki") =>
  String(key.export({ type, format: "pem" }));

const FILES = {
  profile: "/olive/profile.json",
  signingKey: "/olive/signing.pem",
  supervisorKey: "/olive/trust/supervisor-signing.pub",
  certificate: "/olive/tls/tls.crt",
  privateKey: "/olive/tls/tls.key",
  trustBundle: "/olive/trust/ca-bundle.pem",
};
const PROFILE = { role: "diagnosis", revision: "profile-r1", program: "/usr/bin/true", argv: [], cwd: "/tmp", env: {}, credentialEnv: "OLIVE_CREDENTIAL" };

function contents(): Map<string, string> {
  return new Map([
    [FILES.profile, JSON.stringify(PROFILE)],
    [FILES.signingKey, pemOf(executorKeys.privateKey, "pkcs8")],
    [FILES.supervisorKey, pemOf(supervisorKeys.publicKey, "spki")],
    [FILES.certificate, leaf.pem],
    [FILES.privateKey, leaf.keyPem],
    [FILES.trustBundle, pki.ca.pem],
  ]);
}

const TIMING: ExecutorSettings["timing"] = { replyWaitMs: 5_000, helloWaitMs: 1_000, helloPollMs: 50, tickMs: 1_000, stopWaitMs: 2_000, settleWaitMs: 1_500 };
// 세대 표식 경로. 회복 요청이 있는 기동만 읽는다(contents()에는 없어 읽으면 ENOENT다).
const GENERATION = "/olive/generation/marker";

function settings(over: Partial<ExecutorSettings> = {}): ExecutorSettings {
  return {
    role: "diagnosis",
    instance: "worker-1",
    policyRevision: "policy-r1",
    supervisor: { address: "127.0.0.1", port: 9, serverName: SUPERVISOR_DNS, uri: SUPERVISOR_URI },
    storeDir: scratch(),
    agentSocket: "/olive/link/agent.sock",
    generationMarker: GENERATION,
    podUid: POD_UID,
    files: FILES,
    timing: TIMING,
    reconnect: { initialDelayMs: 100, maxDelayMs: 400, multiplier: 2, jitterRatio: 0 },
    receive: { maxQueuedBytes: 1_048_576 },
    ...over,
  };
}

// 스스로 돌지 않는 타이머와 시계. advance가 시각을 옮기며 그 사이 기한이 된 타이머를 차례로 부른다.
class Timers {
  t = 0;
  readonly waits: { at: number; ms: number; fire: () => void; done: boolean }[] = [];
  setTimer = (ms: number, fire: () => void) => {
    const wait = { at: this.t + ms, ms, fire, done: false };
    this.waits.push(wait);
    return () => {
      wait.done = true;
    };
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.waits.filter((wait) => !wait.done && wait.at <= end).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      this.t = Math.max(this.t, next.at);
      next.done = true;
      next.fire();
    }
    this.t = end;
  }
}

// 대리 자리: 듣기가 열리면 원격에 붙는다. hello는 시험이 정한 때에 보낸다.
class FakeAgent {
  remote: RemoteAgent | null = null;
  session: ReturnType<RemoteAgent["connect"]> = null;
  readonly written: Uint8Array[] = [];
  attach(remote: RemoteAgent) {
    this.remote = remote;
    this.session = remote.connect({ write: (bytes) => void this.written.push(bytes.slice()), close: () => {} });
  }
  // 제어가 이 대리에게 보낸 말.
  controls(): ReceivedControl[] {
    const decoder = new ControlDecoder();
    return this.written.flatMap((bytes) => decoder.push(bytes));
  }
  hello() {
    this.session?.receive(encodeAgent({ type: "hello" }));
  }
}

interface Harness {
  deps: ExecutorDeps;
  timers: Timers;
  calls: string[];
  steps: StartStep[];
  agent: FakeAgent;
  connects: number;
  logs: string[];
  // 마지막 connect를 실패로 끝낸다.
  failConnect?: (error: unknown) => void;
}

// 모든 바깥 효과를 기록한다. 가짜 TLS 클라이언트의 connect는 중단될 때까지 끝나지 않는다.
function harness(options: { files?: Map<string, string>; openStore?: ExecutorDeps["openStore"]; listenThrows?: boolean; tlsThrows?: boolean; hello?: boolean } = {}): Harness {
  const files = options.files ?? contents();
  const timers = new Timers();
  const calls: string[] = [];
  const steps: StartStep[] = [];
  const agent = new FakeAgent();
  const logs: string[] = [];
  const h: Harness = {
    timers,
    calls,
    steps,
    agent,
    logs,
    connects: 0,
    deps: {
      readText: async (path) => {
        calls.push(`read ${path}`);
        const text = files.get(path);
        if (text === undefined) throw new Error("ENOENT");
        return text;
      },
      openStore: async (dir, now) => {
        calls.push("openStore");
        return (options.openStore ?? ((d, n) => ExecutorStore.open(d, { now: n })))(dir, now);
      },
      listenAgent: (remote) => {
        calls.push("listenAgent");
        if (options.listenThrows) throw new Error("EADDRINUSE");
        agent.attach(remote);
        if (options.hello !== false) agent.hello();
        return { stop: () => calls.push("listener.stop") };
      },
      createTlsClient: () => {
        calls.push("createTlsClient");
        if (options.tlsThrows) throw new Error("bad material");
        return {
          connect: (signal?: AbortSignal) => {
            h.connects++;
            calls.push("connect");
            return new Promise((_resolve, reject) => {
              h.failConnect = reject;
              signal?.addEventListener("abort", () => {
                calls.push("connect.aborted");
                reject(new TlsConnectError({ kind: "aborted" }));
              });
            });
          },
          close: () => calls.push("client.close"),
        };
      },
      wallNow: () => 1_800_000_000_000 + timers.t,
      monoNow: () => timers.t,
      setTimer: timers.setTimer,
      random: () => 0,
      log: (line) => logs.push(line),
      onStep: (step) => steps.push(step),
    },
  };
  return h;
}

const runs: Promise<StartResult>[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) {
    const result = await run;
    if (result.ok) await result.running.stop();
  }
});

function begin(h: Harness, s = settings()) {
  const run = startExecutor(s, h.deps);
  runs.push(run);
  return run;
}

const ORDER: StartStep[] = ["material", "store", "worker", "agent_listen", "agent_hello", "recover", "link", "tls", "socket"];

test("기동 순서: 재료 → 저장소 → worker → 대리 듣기 → hello → recover → link → TLS → 소켓 하나. hello 전에는 감독에 붙지 않는다", async () => {
  const h = harness({ hello: false });
  const run = begin(h);
  await until(() => h.steps.includes("agent_hello"));
  // 상한 직전까지 hello가 없다: TLS 클라이언트도 연결도 없다.
  h.timers.advance(TIMING.helloWaitMs - 1);
  await Promise.resolve();
  expect(h.steps).toEqual(ORDER.slice(0, 5));
  expect(h.calls).not.toContain("createTlsClient");
  expect(h.connects).toBe(0);
  h.agent.hello();
  h.timers.advance(TIMING.helloPollMs);
  const result = await run;
  expect(result.ok).toBe(true);
  expect(h.steps).toEqual(ORDER);
  expect(h.calls.filter((call) => !call.startsWith("read "))).toEqual(["openStore", "listenAgent", "createTlsClient", "connect"]);
  expect(h.calls.slice(0, 6).every((call) => call.startsWith("read "))).toBe(true);
});

test("대리 없음·늦음: 상한 안에 hello가 없으면 86으로 끝나고 TLS 클라이언트·연결이 0이다(그 뒤의 hello도 바꾸지 않는다)", async () => {
  const h = harness({ hello: false });
  const run = begin(h);
  await until(() => h.steps.includes("agent_hello"));
  h.timers.advance(TIMING.helloWaitMs);
  const result = await run;
  expect(result).toMatchObject({ ok: false, step: "agent_hello", code: EXECUTOR_EXIT.agent_absent, reason: "no_hello" });
  h.agent.hello();
  h.timers.advance(TIMING.helloWaitMs);
  expect(h.calls).not.toContain("createTlsClient");
  expect(h.connects).toBe(0);
  expect(h.calls).toContain("listener.stop");
});

test("대리 잠김: hello 전에 두 번째 연결이 오면 상한을 기다리지 않고 86, 연결 0", async () => {
  const h = harness({ hello: false });
  const run = begin(h);
  await until(() => h.steps.includes("agent_hello"));
  h.agent.remote!.connect({ write: () => {}, close: () => {} });
  h.timers.advance(TIMING.helloPollMs);
  expect(await run).toMatchObject({ ok: false, code: EXECUTOR_EXIT.agent_absent, reason: "second_connection" });
  expect(h.connects).toBe(0);
});

for (const [name, path] of Object.entries(FILES)) {
  test(`재료 없음: ${name} 파일을 읽지 못하면 82로 끝나고 저장소·대리·연결이 0이다`, async () => {
    const files = contents();
    files.delete(path);
    const h = harness({ files });
    expect(await begin(h)).toMatchObject({ ok: false, step: "material", code: EXECUTOR_EXIT.material });
    expect(h.calls.filter((call) => !call.startsWith("read "))).toEqual([]);
    expect(h.connects).toBe(0);
  });
}

test("재료 틀림: 프로필의 역할이 환경과 다르거나, 칸이 더 있거나, 서명 키가 Ed25519가 아니면 82, 연결 0", async () => {
  const cases: [string, string, string][] = [
    [FILES.profile, JSON.stringify({ ...PROFILE, role: "pr_review" }), "profile_role_mismatch"],
    [FILES.profile, JSON.stringify({ ...PROFILE, image: "x" }), "profile_fields"],
    [FILES.profile, JSON.stringify({ ...PROFILE, program: "true" }), "profile_path_not_absolute"],
    [FILES.signingKey, pemOf(generateKeyPairSync("x25519").privateKey, "pkcs8"), "signing_key_not_ed25519"],
    [FILES.supervisorKey, "not a key", "supervisor_key_invalid"],
  ];
  for (const [path, text, reason] of cases) {
    const files = contents();
    files.set(path, text);
    const h = harness({ files });
    expect(await begin(h)).toMatchObject({ ok: false, step: "material", code: EXECUTOR_EXIT.material, reason });
    expect(h.calls).not.toContain("openStore");
    expect(h.connects).toBe(0);
  }
});

test("저장소 실패는 83, 대리 듣기 실패는 85, TLS 재료 실패는 88. 어느 쪽이든 연결 0이다", async () => {
  const store = harness({ openStore: () => ExecutorStore.open("relative/dir") });
  expect(await begin(store)).toMatchObject({ ok: false, step: "store", code: EXECUTOR_EXIT.store, reason: "config_invalid" });
  expect(store.calls).not.toContain("listenAgent");
  const listen = harness({ listenThrows: true });
  expect(await begin(listen)).toMatchObject({ ok: false, step: "agent_listen", code: EXECUTOR_EXIT.agent_listen });
  const material = harness({ tlsThrows: true });
  expect(await begin(material)).toMatchObject({ ok: false, step: "tls", code: EXECUTOR_EXIT.supervisor_setup });
  expect(material.calls.at(-1)).toBe("listener.stop");
  for (const h of [store, listen, material]) expect(h.connects).toBe(0);
});

test("감독 소켓 정책이 틀리면 88로 끝나고 클라이언트를 닫으며 연결 0이다", async () => {
  const h = harness();
  const result = await begin(h, settings({ receive: { maxQueuedBytes: 10 } }));
  expect(result).toMatchObject({ ok: false, step: "socket", code: EXECUTOR_EXIT.supervisor_setup, reason: "policy_rejected" });
  expect(h.calls.slice(-2)).toEqual(["client.close", "listener.stop"]);
  expect(h.connects).toBe(0);
});

test("물려받은 끝나지 않은 실행이 있으면 원격을 처음부터 잠그고, 대리를 기다리지 않고 감독에 붙는다", async () => {
  const dir = scratch();
  const seeded = await ExecutorStore.open(dir, { now: () => 1_800_000_000_000 });
  // 실행 하나가 끝을 맺지 못한 채 남은 장부를 만든다(beginRun은 시험만 부르는 낮은 입구다).
  const written = await seeded.beginRun({
    run_id: randomUUID(),
    run_generation: 1,
    state: "unknown_running",
    start_stop_generation: 0,
    instruction_request_id: randomUUID(),
    deadline_at: 1_800_000_100_000,
    lease_until: 1_800_000_030_000,
    credential_digest: "0".repeat(64),
    exit: "failed",
    last_receipt_id: null,
  });
  expect(written).toBe(true);
  const h = harness({ hello: false });
  const result = await begin(h, settings({ storeDir: dir }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.running.remote.state().distrusted).toBe("inherited_unverified");
  expect(h.connects).toBe(1);
});

test("감독 소켓은 하나이고, stop()은 붙는 중인 연결을 거둔 뒤에 클라이언트를 닫고 0으로 끝난다", async () => {
  const h = harness();
  const result = await begin(h);
  if (!result.ok) throw new Error(result.reason);
  h.timers.advance(TIMING.tickMs * 5);
  expect(h.connects).toBe(1);
  expect(await result.running.stop()).toBe(0);
  expect(await result.running.done).toBe(0);
  expect(h.calls.slice(-4)).toEqual(["connect", "connect.aborted", "client.close", "listener.stop"]);
  h.timers.advance(10_000);
  expect(h.connects).toBe(1);
});

test("tick: link.tick과 worker.tick을 tickMs마다 한 번씩 부르고, 멈춘 뒤에는 부르지 않는다", async () => {
  const h = harness();
  const result = await begin(h);
  if (!result.ok) throw new Error(result.reason);
  const { link, worker } = result.running;
  const seen: string[] = [];
  const linkTick = link.tick.bind(link);
  const workerTick = worker.tick.bind(worker);
  link.tick = () => (seen.push("link"), linkTick());
  worker.tick = () => (seen.push("worker"), workerTick());
  h.timers.advance(TIMING.tickMs - 1);
  expect(seen).toEqual([]);
  h.timers.advance(1);
  expect(seen).toEqual(["link", "worker"]);
  h.timers.advance(TIMING.tickMs * 2);
  expect(seen).toEqual(["link", "worker", "link", "worker", "link", "worker"]);
  await result.running.stop();
  h.timers.advance(TIMING.tickMs * 3);
  expect(seen).toHaveLength(6);
});

test("tick이 던지면 89로 끝나고 소켓을 멈춘 뒤 클라이언트를 닫는다", async () => {
  const h = harness();
  const result = await begin(h);
  if (!result.ok) throw new Error(result.reason);
  result.running.worker.tick = () => {
    throw new Error("broken");
  };
  h.timers.advance(TIMING.tickMs);
  expect(await result.running.done).toBe(EXECUTOR_EXIT.fatal);
  expect(h.calls.slice(-3)).toEqual(["connect.aborted", "client.close", "listener.stop"]);
});

const frame = (value: unknown) => {
  const made = encodeFrame(new TextEncoder().encode(JSON.stringify(value)));
  if (!made.ok) throw new Error(made.reason);
  return made.frame;
};

test("연결 뒤 지시 처리가 던지면(로컬 서명 실패 등) 그 worker를 더 쓰지 않고 소켓을 멈춘 뒤 클라이언트를 닫고 89로 끝난다(루프백 TLS)", async () => {
  // 감독 흉내: 실제 TLS 수신 위에서 받은 틀을 모은다. 감독 인증서는 실행기 leaf와 같은 발급 기관에서 따로 발급한다.
  const supervisorLeaf = pki.supervisor();
  const peers: { socket: tls.TLSSocket; got: Envelope[]; closed: boolean }[] = [];
  const server = await startTlsServer({
    host: "127.0.0.1",
    port: 0,
    material: { certificatePem: supervisorLeaf.pem, privateKeyPem: supervisorLeaf.keyPem, trustBundlePem: pki.ca.pem },
    now: Date.now,
    onConnection: (c) => {
      const decoder = createFrameDecoder();
      const peer = { socket: c.socket, got: [] as Envelope[], closed: false };
      c.socket.on("data", (chunk: Uint8Array) => {
        for (const e of decoder.push(chunk).envelopes) peer.got.push(e.value as Envelope);
      });
      c.socket.once("close", () => (peer.closed = true));
      peers.push(peer);
    },
  });
  try {
    const calls: string[] = [];
    const agent = new FakeAgent();
    const deps: ExecutorDeps = {
      readText: async (path) => contents().get(path)!,
      openStore: (dir, now) => ExecutorStore.open(dir, { now }),
      listenAgent: (remote) => {
        agent.attach(remote);
        agent.hello();
        return { stop: () => calls.push("listener.stop") };
      },
      createTlsClient: (options) => {
        const client = createTlsClient(options);
        return { connect: (signal) => client.connect(signal), close: () => (calls.push("client.close"), client.close()) };
      },
      wallNow: Date.now,
      monoNow: () => performance.now(),
      setTimer: (ms, fire) => {
        const handle = setTimeout(fire, ms);
        return () => clearTimeout(handle);
      },
      random: () => 0,
      log: (line) => calls.push(`log ${line}`),
    };
    const result = await startExecutor(settings({ supervisor: { address: "127.0.0.1", port: server.port, serverName: SUPERVISOR_DNS, uri: SUPERVISOR_URI } }), deps);
    if (!result.ok) throw new Error(result.reason);
    const { worker, link } = result.running;
    await until(() => peers[0]?.got.some((e) => e.header.action === "stop_sync_request") ?? false);
    const peer = peers[0]!;
    const request = peer.got[0]!;
    const clock = new Clock(Date.now());
    peer.socket.write(frame(fromSupervisor(clock, worker.name, "stop_sync_reply", { challenge: (request.body as { challenge: string }).challenge }, { stop_generation: 0 })));
    await until(() => peer.got.some((e) => e.header.action === "hello") && link.live());
    // 첫 접수 영수증의 서명 실패를 지시 처리의 던짐으로 흉내 낸다(Connection.receive가 거절된다).
    worker.handle = async () => {
      throw new Error("signing failed");
    };
    peer.socket.write(frame(fromSupervisor(clock, worker.name, "status_query", { run_ids: [randomUUID()] }, { stop_generation: 0 })));
    expect(await result.running.done).toBe(EXECUTOR_EXIT.fatal);
    expect(calls.filter((call) => !call.startsWith("log "))).toEqual(["client.close", "listener.stop"]);
    expect(calls).toContain("log 감독 소켓: closed(receive_failed)");
    await until(() => peer.closed);
    // 다시 붙지 않는다: 같은 저장소를 쥔 worker가 새 연결을 받지 않는다.
    await Bun.sleep(300);
    expect(peers).toHaveLength(1);
  } finally {
    await server.close();
  }
});

// 시간 안에 풀리지 않으면 "timeout"이다. 끝나지 않는 약속을 시험 전체의 시간 초과가 아니라 그 단언의 실패로 보이게 한다.
const within = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, Bun.sleep(ms).then(() => "timeout" as const)]);
const optionsOf = (value: object) => (value as unknown as { options: Record<string, unknown> }).options;

test("정리 확인(O13-a): worker가 받은 공간의 clean은 대리에게 clean을 묻고, 기한 안에 남은 항목 0을 들었을 때만 true다(남음·모름·기한 넘김은 false)", async () => {
  const h = harness();
  const result = await begin(h);
  if (!result.ok) throw new Error(result.reason);
  const space = optionsOf(result.running.worker).space as { clean(runId: string): Promise<boolean> };
  const asked = () => h.agent.controls().filter((message): message is Extract<ReceivedControl, { type: "clean" }> => message.type === "clean");
  const reply = (left: number | null) => h.agent.session?.receive(encodeAgent({ type: "cleaned", seq: asked().at(-1)!.seq, left }));
  const outcomes: (boolean | "timeout")[] = [];
  for (const left of [0, 3, null] as const) {
    const cleaned = space.clean(randomUUID());
    await until(() => asked().length === outcomes.length + 1);
    reply(left);
    outcomes.push(await within(cleaned, 1_000));
  }
  // 답이 없으면 기한(replyWaitMs)에 false로 돌아간다. worker는 이 호출에 상한을 걸지 않는다.
  const silent = space.clean(randomUUID());
  await until(() => asked().length === 4);
  expect(await within(silent, 50)).toBe("timeout");
  h.timers.advance(TIMING.replyWaitMs);
  outcomes.push(await within(silent, 1_000));
  expect(outcomes).toEqual([true, false, false, false]);
});

test("조립은 설정의 파드 UID와 기록 줄을 worker에 넘긴다(O13-b의 판정과 그 근거 줄, D-155)", async () => {
  const h = harness();
  const podUid = "7d1e4c2a-5b3f-4e8d-9a6c-2f0b8e4d1c57";
  const result = await begin(h, settings({ podUid }));
  if (!result.ok) throw new Error(result.reason);
  const options = optionsOf(result.running.worker);
  expect(options.podUid).toBe(podUid);
  (options.log as (line: string) => void)("정리 확인 시험 줄");
  expect(h.logs).toContain("정리 확인 시험 줄");
});

test("재료 틀림(D-154): 프로필 cwd나 HOME이 작업 공간(/tmp) 밖이면 82, 저장소·연결 0. /tmp 아래 하위 폴더는 기동한다", async () => {
  for (const profile of [
    { ...PROFILE, cwd: "/work" },
    { ...PROFILE, cwd: "/tmpx" },
    { ...PROFILE, cwd: "/tmp/../etc" },
    { ...PROFILE, env: { HOME: "/home/role" } },
  ]) {
    const files = contents();
    files.set(FILES.profile, JSON.stringify(profile));
    const h = harness({ files });
    expect(await begin(h), JSON.stringify(profile)).toMatchObject({ ok: false, step: "material", code: EXECUTOR_EXIT.material, reason: "profile_outside_workspace" });
    expect(h.calls).not.toContain("openStore");
    expect(h.connects).toBe(0);
  }
  const files = contents();
  files.set(FILES.profile, JSON.stringify({ ...PROFILE, cwd: "/tmp/work", env: { HOME: "/tmp/home" } }));
  expect(await begin(harness({ files }))).toMatchObject({ ok: true });
});

test("재료 틀림(D-154): 자격 환경 이름이 HOME이면(역할이 받는 HOME이 자격 문자열이다) cwd가 /tmp 아래여도 82, 저장소·연결 0. VM 시험 프로필 둘은 그대로 받는다", async () => {
  for (const profile of [
    { ...PROFILE, credentialEnv: "HOME" },
    { ...PROFILE, cwd: "/tmp/work", credentialEnv: "HOME" },
  ]) {
    const files = contents();
    files.set(FILES.profile, JSON.stringify(profile));
    const h = harness({ files });
    expect(await begin(h), JSON.stringify(profile)).toMatchObject({ ok: false, step: "material", code: EXECUTOR_EXIT.material, reason: "profile_outside_workspace" });
    expect(h.calls).not.toContain("openStore");
    expect(h.connects).toBe(0);
  }
  // VM 시험 프로필(진단·격리 읽기)의 꼴: cwd는 /tmp, 고정 HOME 없음, 자격 환경 이름은 HOME이 아니다.
  const vm = (role: "diagnosis" | "isolated_reader") => ({
    role,
    revision: "t1-fixed-1",
    program: "/bin/sh",
    argv: ["-c", "printf '%s\\n' \"$FIXED_RESULT\""],
    cwd: "/tmp",
    env: { FIXED_RESULT: JSON.stringify({ role, outcome: "completed", summary: "고정 결과", items: [], refs: [] }) },
    credentialEnv: "CLAUDE_CODE_OAUTH_TOKEN",
  });
  for (const role of ["diagnosis", "isolated_reader"] as const) expect(parseProfile(JSON.stringify(vm(role))), role).toMatchObject({ role, cwd: "/tmp" });
  const files = contents();
  files.set(FILES.profile, JSON.stringify(vm("diagnosis")));
  expect(await begin(harness({ files }))).toMatchObject({ ok: true });
});

test("연결이 먼저 닫힌 뒤 지시 처리가 던져도 89로 끝나고, 같은 프로세스가 감독에 다시 붙지 않는다(루프백 TLS)", async () => {
  const supervisorLeaf = pki.supervisor();
  const peers: { socket: tls.TLSSocket; got: Envelope[]; closed: boolean }[] = [];
  const server = await startTlsServer({
    host: "127.0.0.1",
    port: 0,
    material: { certificatePem: supervisorLeaf.pem, privateKeyPem: supervisorLeaf.keyPem, trustBundlePem: pki.ca.pem },
    now: Date.now,
    onConnection: (c) => {
      const decoder = createFrameDecoder();
      const peer = { socket: c.socket, got: [] as Envelope[], closed: false };
      c.socket.on("data", (chunk: Uint8Array) => {
        for (const e of decoder.push(chunk).envelopes) peer.got.push(e.value as Envelope);
      });
      c.socket.once("close", () => (peer.closed = true));
      peers.push(peer);
    },
  });
  try {
    const calls: string[] = [];
    const agent = new FakeAgent();
    const deps: ExecutorDeps = {
      readText: async (path) => contents().get(path)!,
      openStore: (dir, now) => ExecutorStore.open(dir, { now }),
      listenAgent: (remote) => {
        agent.attach(remote);
        agent.hello();
        return { stop: () => calls.push("listener.stop") };
      },
      createTlsClient: (options) => {
        const client = createTlsClient(options);
        return { connect: (signal) => client.connect(signal), close: () => (calls.push("client.close"), client.close()) };
      },
      wallNow: Date.now,
      monoNow: () => performance.now(),
      setTimer: (ms, fire) => {
        const handle = setTimeout(fire, ms);
        return () => clearTimeout(handle);
      },
      random: () => 0,
      log: (line) => calls.push(`log ${line}`),
    };
    const result = await startExecutor(settings({ supervisor: { address: "127.0.0.1", port: server.port, serverName: SUPERVISOR_DNS, uri: SUPERVISOR_URI } }), deps);
    if (!result.ok) throw new Error(result.reason);
    const { worker, link } = result.running;
    await until(() => peers[0]?.got.some((e) => e.header.action === "stop_sync_request") ?? false);
    const peer = peers[0]!;
    const request = peer.got[0]!;
    const clock = new Clock(Date.now());
    peer.socket.write(frame(fromSupervisor(clock, worker.name, "stop_sync_reply", { challenge: (request.body as { challenge: string }).challenge }, { stop_generation: 0 })));
    await until(() => peer.got.some((e) => e.header.action === "hello") && link.live());
    // 지시 처리가 기다리는 동안 감독이 연결을 끝내고, 그 뒤에 처리가 던진다(재정리 종료 영수증의 서명 실패 자리).
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    worker.handle = async () => {
      entered = true;
      await gate;
      throw new Error("signing failed");
    };
    peer.socket.write(frame(fromSupervisor(clock, worker.name, "status_query", { run_ids: [randomUUID()] }, { stop_generation: 0 })));
    await until(() => entered);
    peer.socket.destroy();
    await until(() => calls.some((call) => call.startsWith("log 감독 소켓: closed(")));
    release();
    expect(await within(result.running.done, 2_000)).toBe(EXECUTOR_EXIT.fatal);
    expect(calls.filter((call) => !call.startsWith("log "))).toEqual(["client.close", "listener.stop"]);
    // 다시 붙기 간격(100ms)을 넘겨 기다려도 새 연결이 없다.
    await Bun.sleep(300);
    expect(peers).toHaveLength(1);
  } finally {
    await server.close();
  }
});

test("다시 붙기 예약기가 고장 나도(재시도·종료 예약·멈춤 상한 모두 거절) 89로 끝나고 클라이언트·대리 소켓을 닫는다", async () => {
  const h = harness();
  const result = await begin(h);
  if (!result.ok) throw new Error(result.reason);
  h.deps.setTimer = () => {
    throw new Error("timer unavailable");
  };
  h.failConnect!(new TlsConnectError({ kind: "tls_error", message: "refused" }));
  expect(await within(result.running.done, 500)).toBe(EXECUTOR_EXIT.fatal);
  expect(h.calls.slice(-2)).toEqual(["client.close", "listener.stop"]);
});

test("기동 대조가 거른 미접수 preparing만 남았으면 대리를 잠그지 않는다: hello 전 감독 연결 0, 상한이면 86", async () => {
  const dir = scratch();
  const seeded = await ExecutorStore.open(dir, { now: () => 1_800_000_000_000 });
  // 사건도 마지막 영수증도 없는 최초 기록(첫 접수 영수증을 적기 전에 멈춘 자리). 기동 대조(auditRuns)가 접수가 아니라고 거른다.
  const written = await seeded.beginRun({
    run_id: randomUUID(),
    run_generation: 1,
    state: "preparing",
    start_stop_generation: 0,
    instruction_request_id: randomUUID(),
    deadline_at: 1_800_000_100_000,
    lease_until: 1_800_000_030_000,
    credential_digest: "0".repeat(64),
    exit: null,
    last_receipt_id: null,
  });
  expect(written).toBe(true);
  const h = harness({ hello: false });
  const run = begin(h, settings({ storeDir: dir }));
  await until(() => h.steps.includes("agent_hello"));
  expect(h.agent.remote!.state().distrusted).toBeNull();
  expect(h.connects).toBe(0);
  h.timers.advance(TIMING.helloWaitMs);
  expect(await run).toMatchObject({ ok: false, step: "agent_hello", code: EXECUTOR_EXIT.agent_absent, reason: "no_hello" });
  expect(h.connects).toBe(0);
});

test("복원 중 대리 연결이 바뀌면 새 연결의 hello를 남은 기한 안에서 다시 기다린다: 없으면 86·연결 0, 오면 그 뒤에 붙는다", async () => {
  for (const greets of [false, true]) {
    const h = harness();
    h.deps.onStep = (step) => {
      h.steps.push(step);
      if (step !== "recover") return;
      // 1세대는 hello를 마쳤다. 복원을 기다리는 사이 끊기고 2세대가 붙기만 한다.
      h.agent.session!.closed();
      h.agent.attach(h.agent.remote!);
    };
    const run = begin(h);
    await until(() => h.steps.includes("recover"));
    await Bun.sleep(20);
    expect(h.agent.remote!.state()).toMatchObject({ generation: 2, greeted: false });
    expect(h.connects, `greets=${greets}`).toBe(0);
    if (greets) {
      h.agent.hello();
      h.timers.advance(TIMING.helloPollMs);
      expect(await run).toMatchObject({ ok: true });
      expect(h.connects).toBe(1);
    } else {
      h.timers.advance(TIMING.helloWaitMs);
      expect(await run).toMatchObject({ ok: false, step: "agent_hello", code: EXECUTOR_EXIT.agent_absent });
      expect(h.calls).not.toContain("createTlsClient");
      expect(h.connects).toBe(0);
      expect(h.calls.at(-1)).toBe("listener.stop");
    }
  }
});

test("대리 hello는 받은 시각으로 상한과 견준다: 상한 뒤에 받은 hello는 확인이 밀려도 86, 상한 전에 받은 hello는 확인이 밀려도 붙는다", async () => {
  const late = harness({ hello: false });
  const lateRun = begin(late);
  await until(() => late.steps.includes("agent_hello"));
  // 950의 확인 뒤 다음 확인(1,000)이 밀려, 그 전 1,001에 hello를 받는다.
  late.timers.advance(TIMING.helloWaitMs - 1);
  late.timers.t = TIMING.helloWaitMs + 1;
  late.agent.hello();
  late.timers.advance(1);
  expect(await lateRun).toMatchObject({ ok: false, step: "agent_hello", code: EXECUTOR_EXIT.agent_absent });
  expect(late.connects).toBe(0);

  const early = harness({ hello: false });
  const earlyRun = begin(early);
  await until(() => early.steps.includes("agent_hello"));
  early.timers.advance(TIMING.helloWaitMs - 1);
  early.agent.hello();
  early.timers.t = TIMING.helloWaitMs + 2;
  early.timers.advance(0);
  expect(await earlyRun).toMatchObject({ ok: true });
  expect(early.connects).toBe(1);
});

test("재료 틀림(v1 규칙): 프로필 revision의 꼴, 대리 링크가 실을 수 없는 argv·env·크기, 감독 공개 키 자리의 개인 키 PEM이면 82, 저장소·연결 0", async () => {
  const names = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`E${i}`, "v"]));
  const cases: [string, string, string][] = [
    [FILES.profile, JSON.stringify({ ...PROFILE, revision: "bad/rev" }), "profile_role_or_revision"],
    [FILES.profile, JSON.stringify({ ...PROFILE, revision: "r".repeat(65) }), "profile_role_or_revision"],
    [FILES.profile, JSON.stringify({ ...PROFILE, argv: Array.from({ length: 257 }, () => "a") }), "profile_link_unencodable"],
    [FILES.profile, JSON.stringify({ ...PROFILE, env: names(129) }), "profile_link_unencodable"],
    [FILES.profile, JSON.stringify({ ...PROFILE, argv: ["x".repeat(70_000)] }), "profile_link_unencodable"],
    [FILES.supervisorKey, pemOf(supervisorKeys.privateKey, "pkcs8"), "supervisor_key_not_public"],
  ];
  for (const [path, text, reason] of cases) {
    const files = contents();
    files.set(path, text);
    const h = harness({ files });
    expect(await begin(h), reason).toMatchObject({ ok: false, step: "material", code: EXECUTOR_EXIT.material, reason });
    expect(h.calls).not.toContain("openStore");
    expect(h.connects).toBe(0);
  }
  // 대조군: 링크 상한 그대로(argv 256개, 고정 env 128개)는 실을 수 있다.
  const files = contents();
  files.set(FILES.profile, JSON.stringify({ ...PROFILE, argv: Array.from({ length: 256 }, () => "a"), env: names(128) }));
  expect(await begin(harness({ files }))).toMatchObject({ ok: true });
});

test("기동 중 멈춤 요청: hello를 기다리는 중이나 복원 중에 멈추면 감독에 붙지 않고 대리 소켓을 닫고 0으로 끝난다", async () => {
  const waiting = harness({ hello: false });
  const stopWaiting = new AbortController();
  const run = startExecutor(settings(), waiting.deps, stopWaiting.signal);
  runs.push(run);
  await until(() => waiting.steps.includes("agent_hello"));
  stopWaiting.abort();
  // 상한(1,000)까지 시계를 옮기지 않는다: 멈춤 요청만으로 기다림이 끝나야 한다.
  expect(await within(run, 500)).toMatchObject({ ok: false, step: "agent_hello", code: 0, reason: "stop_requested" });
  expect(waiting.calls).not.toContain("createTlsClient");
  expect(waiting.connects).toBe(0);
  expect(waiting.calls.at(-1)).toBe("listener.stop");

  const recovering = harness();
  const stopRecovering = new AbortController();
  recovering.deps.onStep = (step) => {
    recovering.steps.push(step);
    if (step === "recover") stopRecovering.abort();
  };
  const run2 = startExecutor(settings(), recovering.deps, stopRecovering.signal);
  runs.push(run2);
  expect(await within(run2, 500)).toMatchObject({ ok: false, step: "recover", code: 0, reason: "stop_requested" });
  expect(recovering.calls).not.toContain("createTlsClient");
  expect(recovering.connects).toBe(0);
  expect(recovering.calls.at(-1)).toBe("listener.stop");
});

test("REVISION은 계약 v1 스키마(hello의 두 revision 칸)의 꼴과 같다", async () => {
  // 계약의 공개 면이 이 정규식을 내지 않아 runtime.ts가 다시 둔다. 둘이 갈리면 여기서 걸린다.
  const { REVISION } = await import("../../src/executor/runtime.ts");
  expect(REVISION.source).toBe(CONTRACT_REVISION.source);
  expect(REVISION.flags).toBe(CONTRACT_REVISION.flags);
});

test("제품 설정의 응답 상한은 10초이고 worker의 exitWaitMs와 원격의 replyWaitMs에 같은 값으로 들어간다", async () => {
  const parsed = settingsFromEnv({
    OLIVE_ROLE: "diagnosis",
    OLIVE_INSTANCE: "worker-1",
    OLIVE_POLICY_REVISION: "policy-r1",
    OLIVE_SUPERVISOR_ADDR: "127.0.0.1:9",
    OLIVE_SUPERVISOR_SERVER_NAME: SUPERVISOR_DNS,
    OLIVE_SUPERVISOR_URI: SUPERVISOR_URI,
    OLIVE_STORE_DIR: scratch(),
    OLIVE_TLS_DIR: "/olive/tls",
    OLIVE_TRUST_DIR: "/olive/trust",
    OLIVE_SIGNING_KEY_FILE: FILES.signingKey,
    OLIVE_PROFILE_FILE: FILES.profile,
    OLIVE_AGENT_SOCKET: "/olive/link/agent.sock",
    OLIVE_POD_UID: POD_UID,
  });
  if (!parsed.ok) throw new Error(parsed.name);
  expect(parsed.settings.timing.replyWaitMs).toBe(10_000);
  // 다시 붙기 전 앞 지시와 기동 단계의 상한: 종료·계수 상한 둘(각 replyWaitMs)보다 길다.
  expect(parsed.settings.timing.settleWaitMs).toBe(25_000);
  const result = await begin(harness(), parsed.settings);
  if (!result.ok) throw new Error(result.reason);
  expect(optionsOf(result.running.worker).exitWaitMs).toBe(10_000);
  expect(optionsOf(result.running.remote).replyWaitMs).toBe(10_000);
});

// 루프백의 실제 상호 TLS 감독 흉내에 붙어 맞춤과 인사까지 마친 실행기. connects는 TLS 클라이언트의 connect 호출(TCP를 열기 전) 수다.
// synced가 false면 맞춤 답을 보낸 뒤 인사를 기다리지 않고 돌려준다(세대 쓰기가 멈춘 경우).
// clock을 주면 단조 시계와 타이머를 그것으로 바꾼다(기한 정각의 콜백 차례를 시험이 정할 때).
async function loopbackRun(options: { openStore?: ExecutorDeps["openStore"]; synced?: boolean; clock?: Pick<ExecutorDeps, "monoNow" | "setTimer"> } = {}) {
  const supervisorLeaf = pki.supervisor();
  const peers: { socket: tls.TLSSocket; got: Envelope[]; closed: boolean }[] = [];
  const server = await startTlsServer({
    host: "127.0.0.1",
    port: 0,
    material: { certificatePem: supervisorLeaf.pem, privateKeyPem: supervisorLeaf.keyPem, trustBundlePem: pki.ca.pem },
    now: Date.now,
    onConnection: (c) => {
      const decoder = createFrameDecoder();
      const peer = { socket: c.socket, got: [] as Envelope[], closed: false };
      c.socket.on("data", (chunk: Uint8Array) => {
        for (const e of decoder.push(chunk).envelopes) peer.got.push(e.value as Envelope);
      });
      c.socket.once("close", () => (peer.closed = true));
      peers.push(peer);
    },
  });
  const calls: string[] = [];
  let connects = 0;
  const agent = new FakeAgent();
  const deps: ExecutorDeps = {
    readText: async (path) => contents().get(path)!,
    openStore: options.openStore ?? ((dir, now) => ExecutorStore.open(dir, { now })),
    listenAgent: (remote) => {
      agent.attach(remote);
      agent.hello();
      return { stop: () => calls.push("listener.stop") };
    },
    createTlsClient: (options) => {
      const client = createTlsClient(options);
      return { connect: (signal) => (connects++, client.connect(signal)), close: () => (calls.push("client.close"), client.close()) };
    },
    wallNow: Date.now,
    monoNow: () => performance.now(),
    setTimer: (ms, fire) => {
      const handle = setTimeout(fire, ms);
      return () => clearTimeout(handle);
    },
    random: () => 0,
    log: (line) => calls.push(`log ${line}`),
    ...options.clock,
  };
  const result = await startExecutor(settings({ supervisor: { address: "127.0.0.1", port: server.port, serverName: SUPERVISOR_DNS, uri: SUPERVISOR_URI } }), deps);
  if (!result.ok) {
    await server.close();
    throw new Error(result.reason);
  }
  const { worker, link } = result.running;
  await until(() => peers[0]?.got.some((e) => e.header.action === "stop_sync_request") ?? false);
  const peer = peers[0]!;
  const clock = new Clock(Date.now());
  peer.socket.write(frame(fromSupervisor(clock, worker.name, "stop_sync_reply", { challenge: (peer.got[0]!.body as { challenge: string }).challenge }, { stop_generation: 0 })));
  if (options.synced !== false) await until(() => peer.got.some((e) => e.header.action === "hello") && link.live());
  return { server, peers, peer, calls, clock, running: result.running, connects: () => connects };
}

test("앞 연결의 지시가 끝나기 전에는 다시 붙지 않는다: 재시도 간격보다 늦고 응답 상한보다 이른 거절은 재연결 0·89, 같은 지연 뒤 정상 응답이면 그 뒤에 다시 붙는다(루프백 TLS)", async () => {
  for (const outcome of ["rejects", "resolves"] as const) {
    const r = await loopbackRun();
    try {
      const { worker } = r.running;
      const handle = worker.handle.bind(worker);
      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      worker.handle = async (...args: Parameters<typeof handle>) => {
        entered = true;
        await gate;
        if (outcome === "rejects") throw new Error("signing failed");
        return handle(...args);
      };
      r.peer.socket.write(frame(fromSupervisor(r.clock, worker.name, "status_query", { run_ids: [randomUUID()] }, { stop_generation: 0 })));
      await until(() => entered);
      r.peer.socket.destroy();
      await until(() => r.calls.some((call) => call.startsWith("log 감독 소켓: closed(")));
      // 다시 붙기 간격(100ms)의 세 배가 지나도 앞 연결의 지시가 끝나지 않았으면 새 연결 시도(TCP 전)가 없다.
      await Bun.sleep(300);
      expect(r.connects(), outcome).toBe(1);
      expect(r.peers).toHaveLength(1);
      release();
      if (outcome === "rejects") {
        expect(await within(r.running.done, 2_000)).toBe(EXECUTOR_EXIT.fatal);
        await Bun.sleep(300);
        expect(r.connects()).toBe(1);
        expect(r.peers).toHaveLength(1);
      } else {
        await until(() => r.peers[1]?.got.some((e) => e.header.action === "stop_sync_request") ?? false);
        expect(r.connects()).toBe(2);
        expect(await within(r.running.done, 200)).toBe("timeout");
        expect(await r.running.stop()).toBe(0);
      }
    } finally {
      await r.server.close();
    }
  }
});

test("앞 연결의 지시를 기다리는 다시 붙기에도 상한이 있다: 맞춤 답의 정지 세대 쓰기가 끝나지 않으면 settleWaitMs 뒤 다시 붙지 않고 89로 끝난다(루프백 TLS)", async () => {
  const disk = scriptedIo();
  const write = disk.hold(stopWrite);
  const r = await loopbackRun({ openStore: (dir, now) => ExecutorStore.open(dir, { now, io: disk.io }), synced: false });
  try {
    await write.entered;
    r.peer.socket.destroy();
    await until(() => r.calls.some((call) => call.startsWith("log 감독 소켓: closed(")));
    await until(() => r.calls.includes("log 앞 연결의 지시 처리가 끝나기를 기다린 뒤 다시 붙는다"));
    // 상한 전에는 다시 붙지도 끝나지도 않는다.
    expect(await within(r.running.done, TIMING.settleWaitMs - 300)).toBe("timeout");
    expect(r.connects()).toBe(1);
    expect(await within(r.running.done, 2_000)).toBe(EXECUTOR_EXIT.fatal);
    await Bun.sleep(300);
    expect(r.connects()).toBe(1);
    expect(r.peers).toHaveLength(1);
    expect(r.calls).toContain("client.close");
    expect(r.calls).toContain("listener.stop");
  } finally {
    write.open();
    await r.running.stop();
    await r.server.close();
  }
});

test("종료 영수증이 저장되고 실행 기록 쓰기만 실패한 볼륨: 재기동은 복원과 같은 유효한 종료 사건으로 판단해 대리를 잠그지 않는다(hello 전 연결 0, 뒤 연결 1, 새 작업 대리 start 1)", async () => {
  const dir = scratch();
  const disk = scriptedIo();
  const seeded = await ExecutorStore.open(dir, { io: disk.io, now: () => T0 });
  const run = randomUUID();
  const instruction = randomUUID();
  const accepted = randomUUID();
  const stopped = randomUUID();
  await seeded.adoptStopGeneration(0);
  const window = { start_stop_generation: 0, instruction_request_id: instruction, deadline_at: T0 + 50_000, lease_until: T0 + 20_000, credential_digest: "0".repeat(64) };
  expect(await seeded.beginRun({ run_id: run, run_generation: 1, state: "preparing", ...window, exit: null, last_receipt_id: null })).toBe(true);
  const acceptedBody = { receipt_id: accepted, run_id: run, instruction_request_id: instruction, instruction: "task_start" };
  const first = await seeded.commit(run, { state: "checking", last_receipt_id: accepted }, [
    { entry: { action: "receipt_accepted", id: accepted, run_id: run, run_generation: 1, acked: false, body: acceptedBody } },
  ]);
  expect(first.saved).toBe(true);
  disk.fail(runWrite("failed_stopped"));
  const stoppedBody = { receipt_id: stopped, run_id: run, exit: "failed", remaining_processes: 0, stopped_at: T0 };
  const last = await seeded.commit(run, { state: "failed_stopped", exit: "failed", last_receipt_id: stopped }, [
    { entry: { action: "receipt_stopped", id: stopped, run_id: run, run_generation: 1, acked: false, body: stoppedBody } },
  ]);
  expect(last.saved).toBe(false);
  expect(last.written.map((entry) => entry.action)).toEqual(["receipt_stopped"]);

  const h = harness({ hello: false });
  const writes: string[] = [];
  h.deps.listenAgent = (remote) => {
    h.calls.push("listenAgent");
    h.agent.remote = remote;
    h.agent.session = remote.connect({ write: (bytes) => void writes.push(new TextDecoder().decode(bytes)), close: () => {} });
    return { stop: () => h.calls.push("listener.stop") };
  };
  const starting = begin(h, settings({ storeDir: dir }));
  await until(() => h.steps.includes("agent_hello"));
  expect(h.agent.remote!.state().distrusted).toBeNull();
  expect(h.connects).toBe(0);
  h.agent.hello();
  h.timers.advance(TIMING.helloPollMs);
  const result = await starting;
  if (!result.ok) throw new Error(result.reason);
  expect(h.connects).toBe(1);
  const { worker, link, remote } = result.running;
  expect(remote.state().distrusted).toBeNull();
  expect((worker.hello().body as { runs: { state: string }[] }).runs.map((row) => row.state)).toEqual(["failed_stopped"]);

  // 새 작업: 맞춘 연결에서 값과 task_start를 받으면 대리에게 start가 간다.
  const connection = link.open(new FakeTransport());
  const clock = new Clock(h.deps.wallNow());
  await connection.receive(fromSupervisor(clock, worker.name, "stop_sync_reply", { challenge: connection.pending()!.challenge }, { stop_generation: 0 }));
  const runId = randomUUID();
  const value = credentialValue();
  const inbox = optionsOf(worker).credentials as { offer(epoch: number, credential: { runId: string; digest: string; value: Uint8Array }): unknown };
  inbox.offer(connection.epoch, { runId, digest: sha256(value), value });
  const body = taskStartBody({ clock } as unknown as Rig, runId, sha256(value), { profile_revision: PROFILE.revision });
  await connection.receive(fromSupervisor(clock, worker.name, "task_start", body, { stop_generation: 0, run_generation: 1 }));
  await until(() => writes.some((text) => text.includes('"type":"start"') && text.includes(runId)));
  expect(writes.filter((text) => text.includes('"type":"start"'))).toHaveLength(1);
});

test("정리 영수증만 남고 같은 세대의 종료 영수증이 없는 stopping(G02 입력)은 잠금을 풀지 않는다: 원격을 처음부터 잠그고 대리 hello를 믿지 않는다", async () => {
  const dir = scratch();
  const seeded = await ExecutorStore.open(dir, { now: () => T0 });
  const run = randomUUID();
  const instruction = randomUUID();
  const accepted = randomUUID();
  const cleaned = randomUUID();
  await seeded.adoptStopGeneration(0);
  const window = { start_stop_generation: 0, instruction_request_id: instruction, deadline_at: T0 + 50_000, lease_until: T0 + 20_000, credential_digest: "0".repeat(64) };
  expect(await seeded.beginRun({ run_id: run, run_generation: 1, state: "preparing", ...window, exit: null, last_receipt_id: null })).toBe(true);
  const acceptedBody = { receipt_id: accepted, run_id: run, instruction_request_id: instruction, instruction: "task_start" };
  const cleanedBody = { receipt_id: cleaned, run_id: run, instruction_request_id: randomUUID(), cleaned_at: T0 };
  const written = await seeded.commit(run, { state: "stopping", exit: "failed", last_receipt_id: cleaned }, [
    { entry: { action: "receipt_accepted", id: accepted, run_id: run, run_generation: 1, acked: false, body: acceptedBody } },
    { entry: { action: "receipt_cleaned", id: cleaned, run_id: run, run_generation: 1, acked: false, body: cleanedBody } },
  ]);
  expect(written.saved).toBe(true);

  const h = harness({ hello: false });
  const writes: string[] = [];
  h.deps.listenAgent = (remote) => {
    h.calls.push("listenAgent");
    h.agent.remote = remote;
    h.agent.session = remote.connect({ write: (bytes) => void writes.push(new TextDecoder().decode(bytes)), close: () => {} });
    return { stop: () => h.calls.push("listener.stop") };
  };
  const starting = startExecutor(settings({ storeDir: dir }), h.deps);
  await until(() => h.agent.remote !== null);
  // 잠그지 않으면 hello 뒤 복원이 이 대리에 정리 요청(terminate)을 보내고 그 답을 기다린다.
  expect(h.agent.remote!.state().distrusted).toBe("inherited_unverified");
  h.agent.hello();
  const result = await starting;
  if (!result.ok) throw new Error(result.reason);
  runs.push(Promise.resolve(result));
  expect(result.running.remote.state().greeted).toBe(false);
  expect(writes.filter((text) => text.includes('"type":"terminate"'))).toHaveLength(0);
  expect(h.connects).toBe(1);
});

test("잠그지 않고 기동했는데 recover 뒤에 장부가 보류되면 감독에 붙지 않고 87로 끝나며 대리 소켓을 닫는다", async () => {
  let held = false;
  const h = harness({
    openStore: async (dir, now) => {
      const store = await ExecutorStore.open(dir, { now });
      const ledgerHeld = store.ledgerHeld.bind(store);
      store.ledgerHeld = () => held || ledgerHeld();
      return store;
    },
  });
  const recover = WorkerExecutor.prototype.recover;
  WorkerExecutor.prototype.recover = async () => {
    held = true;
  };
  try {
    expect(await begin(h)).toMatchObject({ ok: false, step: "recover", code: EXECUTOR_EXIT.recover, reason: "unverified_after_recover" });
  } finally {
    WorkerExecutor.prototype.recover = recover;
  }
  expect(h.agent.remote!.state().distrusted).toBeNull();
  expect(h.calls).not.toContain("createTlsClient");
  expect(h.connects).toBe(0);
  expect(h.calls.at(-1)).toBe("listener.stop");
});

test("두 번째 hello 기다림이 풀린 직후 대리가 또 바뀌면 다시 기다린다: 3세대가 인사하지 않으면 86·연결 0, 인사하면 그 뒤에 붙는다", async () => {
  for (const greets of [false, true]) {
    const h = harness();
    h.deps.onStep = (step) => {
      h.steps.push(step);
      if (step !== "recover") return;
      h.agent.session!.closed();
      h.agent.attach(h.agent.remote!);
    };
    const run = begin(h);
    await until(() => h.steps.filter((step) => step === "agent_hello").length === 2);
    // 2세대가 인사하고 확인이 그 hello로 풀린다. 이어지는 기동 코드가 돌기 전(같은 차례 안)에 3세대로 바뀐다.
    h.agent.hello();
    h.timers.advance(TIMING.helloPollMs);
    h.agent.session!.closed();
    h.agent.attach(h.agent.remote!);
    await Bun.sleep(20);
    expect(h.agent.remote!.state()).toMatchObject({ generation: 3, greeted: false });
    expect(h.connects, `greets=${greets}`).toBe(0);
    if (greets) {
      h.agent.hello();
      h.timers.advance(TIMING.helloPollMs);
      expect(await run).toMatchObject({ ok: true });
      expect(h.connects).toBe(1);
    } else {
      h.timers.advance(TIMING.helloWaitMs);
      expect(await run).toMatchObject({ ok: false, step: "agent_hello", code: EXECUTOR_EXIT.agent_absent });
      expect(h.connects).toBe(0);
    }
  }
});

test("프로필 크기 검사는 제품 출력 상한(64KiB)으로 인코딩한 실제 start에 묶인다: 틀 상한에 꼭 맞는 인자는 기동하고 한 글자 더 길면 82", async () => {
  // 실제 start에 실리는 값: worker가 원격에 넘기는 출력 상한(65,536)과 가장 긴 시간 값. 실리면 틀 크기(4바이트 길이 접두 포함), 아니면 null.
  const encoded = (n: number) => {
    try {
      return encodeControl({
        type: "start",
        run_id: randomUUID(),
        program: PROFILE.program,
        argv: ["x".repeat(n)],
        cwd: PROFILE.cwd,
        env: {},
        credential_env: PROFILE.credentialEnv,
        credential_digest: "0".repeat(64),
        output_bytes: 65_536,
        deadline_at: Number.MAX_SAFE_INTEGER,
        lease_until: Number.MAX_SAFE_INTEGER,
      }).length;
    } catch {
      return null;
    }
  };
  // 이 프로필에서 인자 65,200자의 start 본문이 틀 상한 65,536바이트에 꼭 맞는다.
  expect(encoded(65_200)).toBe(4 + 65_536);
  expect(encoded(65_201)).toBeNull();
  for (const [n, ok] of [
    [65_200, true],
    [65_201, false],
  ] as const) {
    const files = contents();
    files.set(FILES.profile, JSON.stringify({ ...PROFILE, argv: ["x".repeat(n)] }));
    const result = await begin(harness({ files }));
    if (!ok) {
      expect(result, String(n)).toMatchObject({ ok: false, step: "material", code: EXECUTOR_EXIT.material, reason: "profile_link_unencodable" });
      continue;
    }
    expect(result, String(n)).toMatchObject({ ok: true });
    if (result.ok) expect(optionsOf(result.running.worker).outputBytes).toBe(65_536);
  }
});

test("기동 중 멈춤 요청 뒤 단계가 실패해도 멈춤이 이긴다: 재료·저장소·복원 실패는 0이고, 연 대리 소켓을 닫으며 연결 0", async () => {
  const files = contents();
  files.set(FILES.profile, "{");
  const reading = harness({ files });
  const stopReading = new AbortController();
  const read = reading.deps.readText;
  reading.deps.readText = async (path) => {
    if (path === FILES.profile) stopReading.abort();
    return read(path);
  };
  expect(await startExecutor(settings(), reading.deps, stopReading.signal)).toMatchObject({ ok: false, step: "material", code: 0, reason: "stop_requested" });
  expect(reading.calls).not.toContain("openStore");

  const stopOpening = new AbortController();
  const opening = harness({
    openStore: async () => {
      stopOpening.abort();
      throw new Error("unavailable");
    },
  });
  expect(await startExecutor(settings(), opening.deps, stopOpening.signal)).toMatchObject({ ok: false, step: "store", code: 0, reason: "stop_requested" });
  expect(opening.calls).not.toContain("listenAgent");

  const stopRecovering = new AbortController();
  const recovering = harness();
  const recover = WorkerExecutor.prototype.recover;
  WorkerExecutor.prototype.recover = async () => {
    stopRecovering.abort();
    throw new Error("signing failed");
  };
  try {
    expect(await startExecutor(settings(), recovering.deps, stopRecovering.signal)).toMatchObject({ ok: false, step: "recover", code: 0, reason: "stop_requested" });
  } finally {
    WorkerExecutor.prototype.recover = recover;
  }
  expect(recovering.calls.at(-1)).toBe("listener.stop");
  expect(recovering.connects + opening.connects + reading.connects).toBe(0);
});

test("기동의 기다림에도 상한이 있다: 재료 읽기·저장소 열기·recover가 settleWaitMs 안에 끝나지 않으면 그 단계의 코드(timed_out)로 끝나고 연결 0", async () => {
  const never = new Promise<never>(() => {});
  const recover = WorkerExecutor.prototype.recover;
  const cases: { step: StartStep; code: number; stall: (h: Harness) => void }[] = [
    { step: "material", code: EXECUTOR_EXIT.material, stall: (h) => (h.deps.readText = () => never) },
    { step: "store", code: EXECUTOR_EXIT.store, stall: (h) => (h.deps.openStore = () => never) },
    { step: "recover", code: EXECUTOR_EXIT.recover, stall: () => (WorkerExecutor.prototype.recover = () => never) },
  ];
  try {
    for (const c of cases) {
      const h = harness();
      c.stall(h);
      const starting = startExecutor(settings(), h.deps);
      await until(() => h.steps.includes(c.step));
      h.timers.advance(TIMING.settleWaitMs - 1);
      expect(await within(starting, 50), c.step).toBe("timeout");
      h.timers.advance(1);
      expect(await within(starting, 1_000)).toEqual({ ok: false, step: c.step, code: c.code, reason: "timed_out" });
      expect(h.connects).toBe(0);
      expect(h.calls.includes("listener.stop"), c.step).toBe(c.step === "recover");
      WorkerExecutor.prototype.recover = recover;
    }
  } finally {
    WorkerExecutor.prototype.recover = recover;
  }
});

test("기동의 기다림은 결과를 받아들이는 때의 시각으로 판정한다: 재료·저장소·recover의 정상 결과가 기한 1ms 전이면 기동, 정각·정각 뒤면 타이머보다 먼저 와도 그 단계의 코드(timed_out)·연결 0. 기한은 단계를 부르기 전부터 잰다", async () => {
  const recover = WorkerExecutor.prototype.recover;
  const S = TIMING.settleWaitMs;
  const codes = { material: EXECUTOR_EXIT.material, store: EXECUTOR_EXIT.store, recover: EXECUTOR_EXIT.recover } as const;
  try {
    for (const step of ["material", "store", "recover"] as const) {
      for (const offset of [-1, 0, 1]) {
        const label = `${step} ${offset}`;
        const h = harness();
        const held = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        const take = async <T>(value: T) => {
          entered.resolve();
          await held.promise;
          return value;
        };
        const read = h.deps.readText;
        const open = h.deps.openStore;
        if (step === "material") h.deps.readText = async (path) => take(await read(path));
        if (step === "store") h.deps.openStore = async (dir, now) => take(await open(dir, now));
        if (step === "recover") {
          WorkerExecutor.prototype.recover = async function (this: WorkerExecutor) {
            await take(await recover.call(this));
          };
        }
        const run = begin(h);
        await entered.promise;
        // 타이머를 부르지 않고 시계만 옮긴다: 정상 결과가 상한 타이머의 콜백보다 먼저 처리된다.
        h.timers.t = S + offset;
        held.resolve();
        const result = await within(run, 1_000);
        if (offset < 0) {
          expect(result !== "timeout" && result.ok, label).toBe(true);
          expect(h.calls, label).toContain("connect");
        } else {
          expect(result, label).toEqual({ ok: false, step, code: codes[step], reason: "timed_out" });
          expect(h.connects, label).toBe(0);
          expect(h.calls.includes("listener.stop"), label).toBe(step === "recover");
        }
        WorkerExecutor.prototype.recover = recover;
      }
    }
    // 단계 호출 안에서 시각이 상한만큼 흐르면(동기 부분이 오래 걸림) 그 결과도 만료다. 기한을 호출 뒤에 재면 통과한다.
    const h = harness();
    const open = h.deps.openStore;
    h.deps.openStore = (dir, now) => {
      h.timers.t += S;
      return open(dir, now);
    };
    expect(await within(begin(h), 1_000)).toEqual({ ok: false, step: "store", code: EXECUTOR_EXIT.store, reason: "timed_out" });
    expect(h.connects).toBe(0);
  } finally {
    WorkerExecutor.prototype.recover = recover;
  }
});

test("기동의 기다림에서 상한 타이머가 정각 전에 깨면 시각을 다시 보고 남은 시간으로 다시 건다: 그 사이 온 정상 결과로 기동한다", async () => {
  const h = harness();
  const S = TIMING.settleWaitMs;
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const read = h.deps.readText;
  h.deps.readText = async (path) => {
    const text = await read(path);
    entered.resolve();
    await held.promise;
    return text;
  };
  // 첫 상한 타이머만 1ms 일찍 깨운다(실제 타이머도 단조 시계보다 조금 일찍 불릴 수 있다).
  const setTimer = h.deps.setTimer;
  let early = true;
  h.deps.setTimer = (ms, fire) => {
    if (early && ms === S) {
      early = false;
      return setTimer(ms - 1, fire);
    }
    return setTimer(ms, fire);
  };
  const run = begin(h);
  await entered.promise;
  h.timers.advance(S - 1);
  expect(await within(run, 50)).toBe("timeout");
  held.resolve();
  const result = await within(run, 1_000);
  expect(result !== "timeout" && result.ok).toBe(true);
  expect(h.calls).toContain("connect");
});

test("다시 붙기 전 앞 지시의 기한은 결과를 받아들이는 때의 시각으로 판정한다: 정각·정각 뒤면 결과와 타이머의 차례와 상관없이 89·재연결 0, 정각 1ms 전 정상 결과면 다시 붙는다(루프백 TLS)", async () => {
  const S = TIMING.settleWaitMs;
  const cases = [
    { at: S - 1, first: "result", reconnects: true },
    { at: S, first: "result", reconnects: false },
    { at: S, first: "timer", reconnects: false },
    { at: S + 1, first: "result", reconnects: false },
  ] as const;
  for (const c of cases) {
    const label = `${c.at} ${c.first}-first`;
    // 단조 시계는 시험이 옮긴다. 다시 붙기 전 기다림의 상한 타이머(ms = S)만 잡아 시험이 부르고, 나머지는 실제 타이머다.
    let logical = 0;
    let catchGate = false;
    let due: (() => void) | undefined;
    const clock = {
      monoNow: () => logical,
      setTimer: (ms: number, fire: () => void) => {
        if (catchGate && ms === S) {
          due = fire;
          return () => (due = undefined);
        }
        const handle = setTimeout(fire, ms);
        return () => clearTimeout(handle);
      },
    };
    const r = await loopbackRun({ clock });
    const complete = Promise.withResolvers<void>();
    try {
      const { worker } = r.running;
      const handle = worker.handle.bind(worker);
      let entered = false;
      worker.handle = async (...args: Parameters<typeof handle>) => {
        const out = await handle(...args);
        entered = true;
        await complete.promise;
        return out;
      };
      r.peer.socket.write(frame(fromSupervisor(r.clock, worker.name, "status_query", { run_ids: [randomUUID()] }, { stop_generation: 0 })));
      await until(() => entered);
      catchGate = true;
      r.peer.socket.destroy();
      await until(() => due !== undefined);
      logical = c.at;
      if (c.first === "timer") due!();
      complete.resolve();
      if (c.reconnects) {
        await until(() => r.peers[1]?.got.some((e) => e.header.action === "stop_sync_request") ?? false);
        expect(r.connects(), label).toBe(2);
        expect(await r.running.stop(), label).toBe(0);
      } else {
        expect(await within(r.running.done, 2_000), label).toBe(EXECUTOR_EXIT.fatal);
        await Bun.sleep(300);
        expect(r.connects(), label).toBe(1);
        expect(r.peers, label).toHaveLength(1);
        expect(r.calls, label).toContain("client.close");
        expect(r.calls, label).toContain("listener.stop");
      }
    } finally {
      complete.resolve();
      await r.running.stop();
      await r.server.close();
    }
  }
});
