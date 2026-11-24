// 회복(D-104)의 보장. 감독에 붙은 뒤 원격이 잠기면 회복 요청(그때 읽은 세대 표식, 끝을 맺지 못한 실행)을 적고 restart_all(94)로 끝난다.
// 다음 기동은 표식이 요청 때와 다를 때만 그 실행을 남은 0으로 닫고 요청을 지운 뒤 붙는다. 같거나 모르면 닫지 않고 94, 감독 연결 0.
// 파일·대리·TLS 클라이언트·타이머는 가짜이고 저장소는 스크래치 폴더의 실제 파일이다.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { encodeAgent } from "../../src/agent/link.ts";
import { EXECUTOR_EXIT, type ExecutorDeps, type ExecutorSettings, type StartResult, type StartStep, startExecutor } from "../../src/executor/runtime.ts";
import { ExecutorStore, type RestartRequest, type StoreIo } from "../../src/executor/store.ts";
import { TlsConnectError } from "../../src/transport/tls-client.ts";
import { makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../transport/certs.ts";
import {
  Clock,
  credentialValue,
  executorKeys,
  FakeTransport,
  fromSupervisor,
  onDiskEvents,
  onDiskRun,
  type Rig,
  scratch,
  sha256,
  supervisorKeys,
  T0,
  taskStartBody,
  until,
} from "./support.ts";

const pki = makePki();
const leaf = pki.executor();
const pem = (key: { export(options: { type: "pkcs8" | "spki"; format: "pem" }): string | Buffer }, type: "pkcs8" | "spki") => String(key.export({ type, format: "pem" }));
const FILES = {
  profile: "/olive/profile.json",
  signingKey: "/olive/signing.pem",
  supervisorKey: "/olive/trust/supervisor-signing.pub",
  certificate: "/olive/tls/tls.crt",
  privateKey: "/olive/tls/tls.key",
  trustBundle: "/olive/trust/ca-bundle.pem",
};
const GENERATION = "/olive/generation/marker";
const PROFILE = { role: "diagnosis", revision: "profile-r1", program: "/usr/bin/true", argv: [], cwd: "/tmp", env: {}, credentialEnv: "OLIVE_CREDENTIAL" };
const TIMING: ExecutorSettings["timing"] = { replyWaitMs: 5_000, helloWaitMs: 1_000, helloPollMs: 50, tickMs: 1_000, stopWaitMs: 2_000, settleWaitMs: 1_500 };
const MARKER_A = "a".repeat(64);
const MARKER_B = "b".repeat(64);

function files(marker: string | null): Map<string, string> {
  const map = new Map([
    [FILES.profile, JSON.stringify(PROFILE)],
    [FILES.signingKey, pem(executorKeys.privateKey, "pkcs8")],
    [FILES.supervisorKey, pem(supervisorKeys.publicKey, "spki")],
    [FILES.certificate, leaf.pem],
    [FILES.privateKey, leaf.keyPem],
    [FILES.trustBundle, pki.ca.pem],
  ]);
  if (marker !== null) map.set(GENERATION, marker);
  return map;
}

function settings(storeDir: string): ExecutorSettings {
  return {
    role: "diagnosis",
    instance: "worker-1",
    policyRevision: "policy-r1",
    supervisor: { address: "127.0.0.1", port: 9, serverName: SUPERVISOR_DNS, uri: SUPERVISOR_URI },
    storeDir,
    agentSocket: "/olive/link/agent.sock",
    generationMarker: GENERATION,
    files: FILES,
    timing: TIMING,
    reconnect: { initialDelayMs: 100, maxDelayMs: 400, multiplier: 2, jitterRatio: 0 },
    receive: { maxQueuedBytes: 1_048_576 },
  };
}

// 스스로 돌지 않는 시계와 타이머.
class Timers {
  t = 0;
  readonly waits: { at: number; fire: () => void; done: boolean }[] = [];
  setTimer = (ms: number, fire: () => void) => {
    const wait = { at: this.t + ms, fire, done: false };
    this.waits.push(wait);
    return () => void (wait.done = true);
  };
}

interface Harness {
  deps: ExecutorDeps;
  calls: string[];
  steps: StartStep[];
  logs: string[];
  connects: number;
  // 대리 자리에서 받은 링크의 말(제어가 보낸 것).
  writes: string[];
  session: ReturnType<import("../../src/executor/remote-agent.ts").RemoteAgent["connect"]>;
  remote: import("../../src/executor/remote-agent.ts").RemoteAgent | null;
}

function harness(options: { marker?: string | null; readThrows?: boolean; io?: Partial<StoreIo> } = {}): Harness {
  const map = files(options.marker === undefined ? MARKER_B : options.marker);
  const timers = new Timers();
  const h: Harness = {
    calls: [],
    steps: [],
    logs: [],
    connects: 0,
    writes: [],
    session: null,
    remote: null,
    deps: {
      readText: async (path) => {
        h.calls.push(`read ${path}`);
        if (path === GENERATION && options.readThrows) throw Object.assign(new Error("io"), { code: "EIO" });
        const text = map.get(path);
        if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return text;
      },
      openStore: (dir, now) => {
        h.calls.push("openStore");
        return ExecutorStore.open(dir, { now, io: options.io });
      },
      listenAgent: (remote) => {
        h.calls.push("listenAgent");
        h.remote = remote;
        h.session = remote.connect({ write: (bytes) => void h.writes.push(new TextDecoder().decode(bytes)), close: () => {} });
        h.session?.receive(encodeAgent({ type: "hello" }));
        return { stop: () => h.calls.push("listener.stop") };
      },
      createTlsClient: () => {
        h.calls.push("createTlsClient");
        return {
          connect: (signal?: AbortSignal) => {
            h.connects++;
            return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new TlsConnectError({ kind: "aborted" }))));
          },
          close: () => h.calls.push("client.close"),
        };
      },
      wallNow: () => T0 + timers.t,
      monoNow: () => timers.t,
      setTimer: timers.setTimer,
      random: () => 0,
      log: (line) => h.logs.push(line),
      onStep: (step) => h.steps.push(step),
    },
  };
  return h;
}

const started: Promise<StartResult>[] = [];
afterEach(async () => {
  for (const run of started.splice(0)) {
    const result = await run;
    if (result.ok) await result.running.stop();
  }
});
function boot(h: Harness, dir: string) {
  const run = startExecutor(settings(dir), h.deps);
  started.push(run);
  return run;
}

// 접수 영수증까지 남은 실행 하나를 그 상태로 적는다(시험만 부르는 낮은 입구).
async function seedRun(store: ExecutorStore, state: "running" | "stopping" | "unknown_running" | "preparing"): Promise<string> {
  const run = randomUUID();
  const instruction = randomUUID();
  const accepted = randomUUID();
  const window = { start_stop_generation: 0, instruction_request_id: instruction, deadline_at: T0 + 600_000, lease_until: T0 + 30_000, credential_digest: "0".repeat(64) };
  expect(await store.beginRun({ run_id: run, run_generation: 1, state: "preparing", ...window, exit: null, last_receipt_id: null })).toBe(true);
  const body = { receipt_id: accepted, run_id: run, instruction_request_id: instruction, instruction: "task_start" };
  const done = await store.commit(run, { state, last_receipt_id: accepted }, [{ entry: { action: "receipt_accepted", id: accepted, run_id: run, run_generation: 1, acked: false, body } }]);
  expect(done.saved).toBe(true);
  return run;
}

async function seeded(runs: ("running" | "stopping" | "unknown_running" | "preparing")[], request: ((ids: string[]) => RestartRequest) | null) {
  const dir = scratch();
  const store = await ExecutorStore.open(dir, { now: () => T0 });
  await store.adoptStopGeneration(0);
  const ids: string[] = [];
  for (const state of runs) ids.push(await seedRun(store, state));
  if (request !== null) await store.writeRestartRequest(request(ids));
  return { dir, ids };
}

const stoppedReceipts = (dir: string, runId: string) => onDiskEvents(dir, runId).filter((event) => event.action === "receipt_stopped");
const requestOnDisk = (dir: string) => existsSync(join(dir, "restart-request.json"));
const reopened = async (dir: string) => (await ExecutorStore.open(dir, { now: () => T0 })).restartRequest();

// 붙은 실행기에 실행 하나를 띄운다: 맞춘 연결에서 값과 task_start를 받으면 대리에게 start가 가고, 대리가 spawned로 답한다.
async function launch(h: Harness, result: Extract<StartResult, { ok: true }>): Promise<string> {
  const { worker, link } = result.running;
  const connection = link.open(new FakeTransport());
  const clock = new Clock(h.deps.wallNow());
  await connection.receive(fromSupervisor(clock, worker.name, "stop_sync_reply", { challenge: connection.pending()!.challenge }, { stop_generation: 0 }));
  const runId = randomUUID();
  const value = credentialValue();
  const inbox = (worker as unknown as { options: { credentials: { offer(epoch: number, c: { runId: string; digest: string; value: Uint8Array }): unknown } } }).options.credentials;
  inbox.offer(connection.epoch, { runId, digest: sha256(value), value });
  const body = taskStartBody({ clock } as unknown as Rig, runId, sha256(value), { profile_revision: PROFILE.revision });
  await connection.receive(fromSupervisor(clock, worker.name, "task_start", body, { stop_generation: 0, run_generation: 1 }));
  await until(() => h.writes.some((text) => text.includes('"type":"start"') && text.includes(runId)));
  h.session!.receive(encodeAgent({ type: "spawned", run_id: runId }));
  await until(() => (worker.hello().body as { runs: { run_id: string; state: string }[] }).runs.some((row) => row.run_id === runId && row.state === "running"));
  return runId;
}

test("회복 요청: 붙은 뒤 실행 중에 대리 링크가 끊기면 그 세대 표식과 실행을 요청으로 적고 94로 끝난다(종료 영수증 0, 클라이언트·대리 소켓 닫음)", async () => {
  const dir = scratch();
  const h = harness({ marker: MARKER_A });
  const result = await boot(h, dir);
  if (!result.ok) throw new Error(result.reason);
  const runId = await launch(h, result);
  h.session!.closed();
  expect(await result.running.done).toBe(EXECUTOR_EXIT.restart_all);
  expect(result.running.remote.state().distrusted).toBe("link_lost_mid_run");
  expect(await reopened(dir)).toEqual({ marker: MARKER_A, runs: [runId] });
  expect(stoppedReceipts(dir, runId)).toEqual([]);
  expect(h.calls.slice(-2)).toEqual(["client.close", "listener.stop"]);
  // 끝내기 전에 감독 소켓을 멈췄다.
  expect(h.logs).toContain("감독 소켓: stopped");
});

test("회복 요청: 실행 중에 두 번째 연결이 오면 같은 길로 94다", async () => {
  const dir = scratch();
  const h = harness({ marker: MARKER_A });
  const result = await boot(h, dir);
  if (!result.ok) throw new Error(result.reason);
  const runId = await launch(h, result);
  h.remote!.connect({ write: () => {}, close: () => {} });
  expect(await result.running.done).toBe(EXECUTOR_EXIT.restart_all);
  expect(result.running.remote.state().distrusted).toBe("second_connection");
  expect(await reopened(dir)).toEqual({ marker: MARKER_A, runs: [runId] });
});

test("회복 요청: 요청을 적지 못하거나 세대 표식을 읽지 못하면(꼴 틀림 포함) 요청 없이 89로 끝난다", async () => {
  const cases: [string, Parameters<typeof harness>[0]][] = [
    ["write", { marker: MARKER_A, io: { writeDurable: async (path, data) => (path.endsWith("restart-request.json") ? Promise.reject(Object.assign(new Error("disk"), { code: "EIO" })) : Bun.write(path, data).then(() => {})) } }],
    ["unreadable", { readThrows: true }],
    ["malformed", { marker: `${MARKER_A}\n` }],
    ["missing", { marker: null }],
  ];
  for (const [name, options] of cases) {
    const dir = scratch();
    const h = harness(options);
    const result = await boot(h, dir);
    if (!result.ok) throw new Error(result.reason);
    await launch(h, result);
    h.session!.closed();
    expect(await result.running.done, name).toBe(EXECUTOR_EXIT.fatal);
    expect(requestOnDisk(dir), name).toBe(false);
  }
});

test("기동 회복 대조: 표식이 요청 때와 다르면 대리에게 묻지 않고 요청의 실행을 남은 0으로 닫고 요청을 지운 뒤 잠그지 않고 붙는다", async () => {
  for (const state of ["unknown_running", "running", "stopping", "preparing"] as const) {
    const { dir, ids } = await seeded([state], (runs) => ({ marker: MARKER_A, runs }));
    const h = harness({ marker: MARKER_B });
    const result = await boot(h, dir);
    if (!result.ok) throw new Error(`${state}: ${result.reason}`);
    expect(h.steps.slice(0, 5), state).toEqual(["material", "store", "worker", "restart_check", "agent_listen"]);
    const receipts = stoppedReceipts(dir, ids[0]!);
    expect(receipts.map((event) => event.body.remaining_processes), state).toEqual([0]);
    expect(onDiskRun(dir, ids[0]!).state, state).toBe("failed_stopped");
    expect(requestOnDisk(dir), state).toBe(false);
    expect(result.running.remote.state().distrusted, state).toBeNull();
    // 0은 대리의 계수가 아니다: 새 대리에게 끝내기·세기를 보내지 않았다.
    expect(h.writes.filter((text) => /"type":"(terminate|count)"/.test(text)), state).toEqual([]);
    expect(h.connects, state).toBe(1);
  }
});

test("기동 회복 대조: 표식이 같으면(제어만 다시 떴다) 닫지 않고 94로 끝난다. 대리 듣기·TLS·감독 연결 0이고 요청은 남는다", async () => {
  const { dir, ids } = await seeded(["unknown_running"], (runs) => ({ marker: MARKER_A, runs }));
  const h = harness({ marker: MARKER_A });
  expect(await boot(h, dir)).toMatchObject({ ok: false, step: "restart_check", code: EXECUTOR_EXIT.restart_all, reason: "generation_unchanged" });
  expect(stoppedReceipts(dir, ids[0]!)).toEqual([]);
  expect(onDiskRun(dir, ids[0]!).state).toBe("unknown_running");
  expect(await reopened(dir)).toEqual({ marker: MARKER_A, runs: ids });
  expect(h.calls).not.toContain("listenAgent");
  expect(h.calls).not.toContain("createTlsClient");
  expect(h.connects).toBe(0);
});

test("기동 회복 대조: 표식을 읽지 못하거나 꼴이 틀리면 모름이다. 닫지 않고 94, 연결 0, 요청은 남는다", async () => {
  const cases: [Parameters<typeof harness>[0], string][] = [
    [{ readThrows: true }, "generation_unreadable"],
    [{ marker: null }, "generation_unreadable"],
    [{ marker: "B".repeat(64) }, "generation_malformed"],
    [{ marker: `${MARKER_B}\n` }, "generation_malformed"],
    [{ marker: "" }, "generation_malformed"],
  ];
  for (const [options, reason] of cases) {
    const { dir, ids } = await seeded(["unknown_running"], (runs) => ({ marker: MARKER_A, runs }));
    const h = harness(options);
    expect(await boot(h, dir)).toMatchObject({ ok: false, step: "restart_check", code: EXECUTOR_EXIT.restart_all, reason });
    expect(stoppedReceipts(dir, ids[0]!)).toEqual([]);
    expect(requestOnDisk(dir)).toBe(true);
    expect(h.calls).not.toContain("listenAgent");
    expect(h.connects).toBe(0);
  }
});

test("기동 회복 대조: 요청이 없으면 그 전과 같다(회복 대조 단계 없음, 표식을 읽지 않음, 물려받은 실행은 잠금)", async () => {
  const { dir, ids } = await seeded(["unknown_running"], null);
  const h = harness({ marker: MARKER_B });
  const result = await boot(h, dir);
  if (!result.ok) throw new Error(result.reason);
  expect(h.steps).not.toContain("restart_check");
  expect(h.calls).not.toContain(`read ${GENERATION}`);
  expect(result.running.remote.state().distrusted).toBe("inherited_unverified");
  expect(stoppedReceipts(dir, ids[0]!)).toEqual([]);
  expect(h.connects).toBe(1);
});

test("기동 회복 대조: 요청의 실행이 모두 이미 끝을 맺었으면(빈 목록 포함) 표식을 읽지 않고 요청을 지운 뒤 그 전처럼 기동한다", async () => {
  const { dir } = await seeded([], () => ({ marker: MARKER_A, runs: [] }));
  const h = harness({ marker: MARKER_A });
  const result = await boot(h, dir);
  if (!result.ok) throw new Error(result.reason);
  expect(h.steps).toContain("restart_check");
  expect(h.calls).not.toContain(`read ${GENERATION}`);
  expect(requestOnDisk(dir)).toBe(false);
  expect(result.running.remote.state().distrusted).toBeNull();
  expect(h.connects).toBe(1);
});

test("기동 회복 대조: 장부가 보류되면 닫지 않고 요청을 둔 채 잠금을 유지하고, 요청 밖의 미확인 실행이 있으면 요청의 실행만 닫고 잠금을 유지한다", async () => {
  // 장부 보류: 실행 기록 폴더를 잃은 장부(unlisted).
  {
    const { dir, ids } = await seeded(["unknown_running"], (runs) => ({ marker: MARKER_A, runs }));
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "runs"), { recursive: true });
    const h = harness({ marker: MARKER_B });
    const result = await boot(h, dir);
    if (!result.ok) throw new Error(result.reason);
    expect(h.steps).toContain("restart_check");
    expect(h.calls).not.toContain(`read ${GENERATION}`);
    expect(result.running.remote.state().distrusted).toBe("inherited_unverified");
    expect(stoppedReceipts(dir, ids[0]!)).toEqual([]);
    expect(requestOnDisk(dir)).toBe(true);
  }
  // 요청 밖의 실행: 요청에는 첫 실행만 있다.
  {
    const { dir, ids } = await seeded(["unknown_running", "unknown_running"], (runs) => ({ marker: MARKER_A, runs: [runs[0]!] }));
    const h = harness({ marker: MARKER_B });
    const result = await boot(h, dir);
    if (!result.ok) throw new Error(result.reason);
    expect(stoppedReceipts(dir, ids[0]!).map((event) => event.body.remaining_processes)).toEqual([0]);
    expect(stoppedReceipts(dir, ids[1]!)).toEqual([]);
    expect(onDiskRun(dir, ids[1]!).state).toBe("unknown_running");
    expect(result.running.remote.state().distrusted).toBe("inherited_unverified");
    expect(requestOnDisk(dir)).toBe(false);
  }
});

test("기동 회복 대조: 닫은 결과를 파일에 적지 못하면 요청을 지우지 않고 87로 끝나며 연결 0이다. 다음 기동이 같은 요청으로 닫는다", async () => {
  const { dir, ids } = await seeded(["unknown_running"], (runs) => ({ marker: MARKER_A, runs }));
  const failing: Partial<StoreIo> = {
    writeDurable: async (path, data) => {
      if (path.includes("/runs/") && (JSON.parse(data) as { state?: string }).state === "failed_stopped") throw Object.assign(new Error("disk"), { code: "EIO" });
      await Bun.write(path, data);
    },
  };
  const h = harness({ marker: MARKER_B, io: failing });
  expect(await boot(h, dir)).toMatchObject({ ok: false, step: "restart_check", code: EXECUTOR_EXIT.recover, reason: "restart_close_unsaved" });
  expect(requestOnDisk(dir)).toBe(true);
  expect(h.connects).toBe(0);
  // 다음 기동: 종료 영수증은 이미 적혔으므로 그 사건으로 맺고 요청을 지운다(같은 영수증, 새로 만들지 않는다).
  const again = harness({ marker: MARKER_B });
  const result = await boot(again, dir);
  if (!result.ok) throw new Error(result.reason);
  expect(stoppedReceipts(dir, ids[0]!)).toHaveLength(1);
  expect(requestOnDisk(dir)).toBe(false);
  expect(result.running.remote.state().distrusted).toBeNull();
});

test("붙기 전의 잠금은 회복을 시작하지 않는다: hello를 기다리는 중 두 번째 연결이면 86이고 요청을 적지 않는다", async () => {
  const dir = scratch();
  const h = harness();
  h.deps.listenAgent = (remote) => {
    h.calls.push("listenAgent");
    h.remote = remote;
    remote.connect({ write: () => {}, close: () => {} });
    remote.connect({ write: () => {}, close: () => {} });
    return { stop: () => h.calls.push("listener.stop") };
  };
  expect(await boot(h, dir)).toMatchObject({ ok: false, code: EXECUTOR_EXIT.agent_absent, reason: "second_connection" });
  expect(requestOnDisk(dir)).toBe(false);
  expect(h.connects).toBe(0);
});
