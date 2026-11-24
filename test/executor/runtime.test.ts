// 실행기 기동 조립(runtime.ts)의 보장: 단계의 차례, 대리 hello 전에는 감독에 붙지 않음, 실패마다 정한 코드와 연결 0,
// 감독 소켓 하나와 stop() 뒤의 클라이언트 닫기, tick 주기, 연결 뒤 지시 처리가 던지면 끝남.
// 파일·저장소 열기·대리 듣기·TLS 클라이언트·타이머는 가짜다. 마지막 사례만 루프백의 실제 상호 TLS로 감독 흉내에 붙는다.
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type * as tls from "node:tls";
import { encodeAgent } from "../../src/agent/link.ts";
import type { Envelope } from "../../src/contract/v1/index.ts";
import type { RemoteAgent } from "../../src/executor/remote-agent.ts";
import { EXECUTOR_EXIT, type ExecutorDeps, type ExecutorSettings, type StartResult, type StartStep, startExecutor } from "../../src/executor/runtime.ts";
import { ExecutorStore } from "../../src/executor/store.ts";
import { startTlsServer } from "../../src/supervisor/transport/tls-server.ts";
import { createFrameDecoder, encodeFrame } from "../../src/transport/framing.ts";
import { createTlsClient, TlsConnectError } from "../../src/transport/tls-client.ts";
import { makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../transport/certs.ts";
import { Clock, executorKeys, fromSupervisor, scratch, supervisorKeys, until } from "./support.ts";

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

const TIMING: ExecutorSettings["timing"] = { replyWaitMs: 5_000, helloWaitMs: 1_000, helloPollMs: 50, tickMs: 1_000, stopWaitMs: 2_000 };

function settings(over: Partial<ExecutorSettings> = {}): ExecutorSettings {
  return {
    role: "diagnosis",
    instance: "worker-1",
    policyRevision: "policy-r1",
    supervisor: { address: "127.0.0.1", port: 9, serverName: SUPERVISOR_DNS, uri: SUPERVISOR_URI },
    storeDir: scratch(),
    agentSocket: "/olive/link/agent.sock",
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
  attach(remote: RemoteAgent) {
    this.remote = remote;
    this.session = remote.connect({ write: () => {}, close: () => {} });
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
            return new Promise((_resolve, reject) =>
              signal?.addEventListener("abort", () => {
                calls.push("connect.aborted");
                reject(new TlsConnectError({ kind: "aborted" }));
              }),
            );
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
