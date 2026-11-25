// 조립(boot.ts) 시험의 세계. 실제 임시 장부(첫 설치로 만든 뒤 닫아 두고 조립이 reopen으로 연다), 손으로 돌리는 단조 시계와 타이머,
// 가짜 파일·현관·서버를 둔다. 같은 객체 단언을 위해 조립의 생성자(make)를 감싸 넘긴 인자를 적는다.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { rawPublicKey } from "../../../src/contract/v1/index.ts";
import { type Ledger, openLedger, type OpenOptions, type PeerContractAnswer, type RestorePorts } from "../../../src/ledger/index.ts";
import type { AnswerLinePorts, AnswerLines } from "../../../src/supervisor/runtime/answers.ts";
import {
  bootSupervisor,
  type BootResult,
  type LogFields,
  type SupervisorDeps,
  type SupervisorMakers,
  type SupervisorSettings,
} from "../../../src/supervisor/runtime/boot.ts";
import { type Cycle, type CycleDeps, createCycle } from "../../../src/supervisor/runtime/cycle.ts";
import { assignAndStartTick } from "../../../src/supervisor/dispatch/assign-loop.ts";
import { lifeTick } from "../../../src/supervisor/dispatch/life-loop.ts";
import { linkLossTick } from "../../../src/supervisor/dispatch/link-loss.ts";
import { resendTick } from "../../../src/supervisor/dispatch/resend.ts";
import { resultCheckTick } from "../../../src/supervisor/dispatch/result-check.ts";
import { unreceivedTick } from "../../../src/supervisor/dispatch/unreceived.ts";
import { createIssuance, type IssuancePorts } from "../../../src/supervisor/runtime/issuance.ts";
import { createAnswerLines } from "../../../src/supervisor/runtime/answers.ts";
import { createQueryBook } from "../../../src/supervisor/runtime/query-book.ts";
import { createSharedClock, type SharedClock } from "../../../src/supervisor/runtime/shared-clock.ts";
import { createWireSink, type WireSinkPorts } from "../../../src/supervisor/runtime/sink.ts";
import type { ConnectionServer, ConnectionServerOptions, StartResult } from "../../../src/supervisor/transport/server.ts";
import { Restorer } from "../../../src/ledger/index.ts";
import { tempDir } from "../../ledger/helpers.ts";

export const WALL = 1_800_000_000_000;
export const EXECUTOR = "executor/diagnosis/0/store-a";

// 손으로 돌리는 단조 시계와 타이머. advance가 기한에 닿은 타이머를 차례로 부르고, 그 사이의 약속 처리를 기다린다.
export function manualTime(start = 1_000) {
  let now = start;
  const timers = new Set<{ at: number; fire: () => void }>();
  const flush = async (rounds = 20) => {
    for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return {
    monoNow: () => now,
    setTimer(ms: number, fire: () => void): () => void {
      const timer = { at: now + ms, fire };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    // 시각만 옮긴다(타이머는 부르지 않는다). "결과가 타이머보다 먼저"인 정각을 만든다.
    set(at: number) {
      now = at;
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        timers.delete(due);
        now = Math.max(now, due.at);
        due.fire();
        await flush();
      }
      now = until;
      await flush();
    },
    flush,
    pending: () => timers.size,
  };
}

export type Trace = string[];

export interface FakeServer {
  server: ConnectionServer;
  start: (options: ConnectionServerOptions) => Promise<StartResult>;
  options: ConnectionServerOptions | null;
  starts: number;
  ticks: number;
  closes: number;
  // close()가 돌려줄 약속(기본: 곧바로 이행).
  closeWith: () => Promise<void>;
}

export function fakeServer(trace: Trace): FakeServer {
  const state: FakeServer = {
    server: null as unknown as ConnectionServer,
    start: null as unknown as FakeServer["start"],
    options: null,
    starts: 0,
    ticks: 0,
    closes: 0,
    closeWith: () => Promise.resolve(),
  };
  const table = { occupancy: () => [], candidates: () => [] };
  const server = {
    port: 4321,
    table: () => table,
    registry: () => state.options?.registry,
    applyRegistry: () => {
      throw new Error("시험에서 부르지 않는다");
    },
    tick() {
      state.ticks += 1;
    },
    recognized: () => null,
    writeFrame: () => ({ kind: "not_written", reason: "not_recognized" }),
    closeConnection: () => ({ kind: "not_open" }),
    close() {
      state.closes += 1;
      trace.push("server_close");
      return state.closeWith();
    },
  } as unknown as ConnectionServer;
  state.server = server;
  state.start = async (options) => {
    state.starts += 1;
    state.options = options;
    trace.push("server_start");
    return { ok: true, server };
  };
  return state;
}

// 조립의 생성자를 감싸 넘긴 인자와 만든 객체를 적는다.
export interface Captured {
  shared?: SharedClock;
  restorer?: { value: Restorer; ledger: Ledger; ports: RestorePorts; clock: () => number; requiredPeers: readonly string[] };
  cycle?: { value: Cycle; deps: CycleDeps };
  queries?: ReturnType<typeof createQueryBook>;
  issuance?: { value: ReturnType<typeof createIssuance>; ports: IssuancePorts };
  sink?: { value: ReturnType<typeof createWireSink>; ports: WireSinkPorts };
  lines?: { value: AnswerLines; ports: AnswerLinePorts };
  // 박자마다 마지막으로 넘긴 포트 묶음(박자 유효 문의 같은 객체 단언).
  beatPorts?: Partial<Record<"linkLoss" | "resultCheck" | "life" | "resend" | "unreceived" | "assign", { readonly beatValid?: () => boolean }>>;
  pumps: number;
  delivers: number;
}

export function capturingMakers(captured: Captured, trace: Trace, over: Partial<SupervisorMakers> = {}): SupervisorMakers {
  return {
    sharedClock: (source) => (captured.shared = createSharedClock(source)),
    restorer: (ledger, ports, clock, requiredPeers) => {
      trace.push("restorer");
      const value = new Restorer(ledger, ports, clock, { requiredPeers });
      captured.restorer = { value, ledger, ports, clock, requiredPeers };
      return value;
    },
    cycle: (deps) => {
      trace.push("cycle");
      const value = createCycle(deps);
      captured.cycle = { value, deps };
      return value;
    },
    queries: () => (captured.queries = createQueryBook()),
    issuance: (ports) => {
      trace.push("issuance");
      const value = createIssuance(ports);
      captured.issuance = { value, ports };
      return value;
    },
    sink: (ports) => {
      trace.push("sink");
      const value = createWireSink(ports);
      captured.sink = { value, ports };
      return value;
    },
    lines: (ports) => {
      trace.push("lines");
      const real = createAnswerLines(ports);
      const value: AnswerLines = {
        ...real,
        withheld: real.withheld,
        deliver: (output) => {
          captured.delivers += 1;
          real.deliver(output);
        },
        pump: () => {
          captured.pumps += 1;
          real.pump();
        },
        backlog: (id) => real.backlog(id),
        takeRequery: () => real.takeRequery(),
      };
      captured.lines = { value, ports };
      return value;
    },
    ticks: {
      linkLoss: (ports, policy, input) => {
        (captured.beatPorts ??= {}).linkLoss = ports;
        return linkLossTick(ports, policy, input);
      },
      resultCheck: (ports, now) => {
        (captured.beatPorts ??= {}).resultCheck = ports;
        return resultCheckTick(ports, now);
      },
      life: (ports, policy, input) => {
        (captured.beatPorts ??= {}).life = ports;
        return lifeTick(ports, policy, input);
      },
      resend: (ports, policy, input) => {
        (captured.beatPorts ??= {}).resend = ports;
        return resendTick(ports, policy, input);
      },
      unreceived: (ports, now) => {
        (captured.beatPorts ??= {}).unreceived = ports;
        return unreceivedTick(ports, now);
      },
      assign: (ports, policy, now) => {
        (captured.beatPorts ??= {}).assign = ports;
        return assignAndStartTick(ports, policy, now);
      },
    },
    ...over,
  };
}

export interface FrontDoor {
  stop: () => Promise<{ generation: number; stopped: boolean } | null>;
  peers: () => Promise<PeerContractAnswer[]>;
}

export const FRONT_ROWS: PeerContractAnswer[] = [
  { peer: "front-door", contract: "olive-control/v2", policy: "match" },
  { peer: "observation-relay", contract: "olive-control/v1", policy: "match" },
];

export function supervisorKeyPem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

export function registryDoc(executors: { publicKeyRaw: string; active?: boolean }[] = []): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      environment: "home",
      revision: 1,
      executors: executors.map((row, i) => ({ target: "reader", role: "diagnosis", instance: `${i}`, storage: "store-a", public_key: row.publicKeyRaw, active: row.active ?? true })),
    }),
  );
}

export function executorKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, raw: rawPublicKey(publicKey) };
}

// 첫 설치로 만든 뒤 닫은 장부. 조립은 이 경로를 reopen으로 연다.
export function installedLedger(): { dir: string; path: string } {
  const dir = tempDir();
  const path = join(dir, "supervisor.db");
  const made = openLedger(path, { clock: () => WALL, mode: "create" });
  if (!made.ok) throw new Error(`장부를 만들지 못했다: ${made.reason}`);
  made.ledger.close();
  return { dir, path };
}

export function resultDir(): string {
  const dir = join(realpathSync(tempDir()), "results");
  mkdirSync(dir);
  return dir;
}

export const FILES = { certificate: "/m/tls.crt", privateKey: "/m/tls.key", trustBundle: "/m/ca-bundle.pem", signingKey: "/m/signing.key", registry: "/m/registry.json" };

export function baseSettings(ledgerPath: string, results: string, over: Partial<SupervisorSettings> = {}): SupervisorSettings {
  return {
    listen: { host: "127.0.0.1", port: 0 },
    files: FILES,
    ledgerPath,
    resultDir: results,
    maxResultRecordBytes: 32_768,
    registry: { environment: "home", targets: [{ target: "reader", namespace: "olive-reader", roles: ["diagnosis"] }] },
    otherPeers: ["front-door", "observation-relay"],
    expectedPolicyRevision: "policy-1",
    credentials: { dir: "/accounts", keys: { subscription: "CLAUDE_CODE_OAUTH_TOKEN" }, maxBytes: 16_384, revisionOf: () => null },
    assign: {
      assignment: { allowed: [{ target: "reader", roles: ["diagnosis"] }], registrations: [], expected: { profile_revision: "", policy_revision: "policy-1" } },
      accounts: [],
      plans: [],
      queue: { alertMaxWaitMs: 60_000, requestBudget: { admin: 0, alert: 0 } },
      originOf: () => undefined,
    },
    life: { renewEveryMs: 10_000, answerTimeoutMs: 20_000 },
    cycle: { judgeMs: 30_000, resendEveryMs: 5_000, assignCallsPerBeat: 1 },
    connection: {},
    maxPendingWriteBytes: 262_144,
    timing: { beatEveryMs: 100, beatWaitMs: 1_000, restoreStepWaitMs: 2_000, startupWaitMs: 500, stopWaitMs: 700 },
    ...over,
  };
}

export interface World {
  readonly time: ReturnType<typeof manualTime>;
  readonly trace: Trace;
  readonly events: { event: string; fields: LogFields }[];
  readonly captured: Captured;
  readonly fake: FakeServer;
  readonly files: Map<string, () => Promise<Uint8Array>>;
  readonly front: FrontDoor;
  readonly ledgerPath: string;
  readonly openCalls: { path: string; options: OpenOptions }[];
  opened: Ledger | null;
  wall: number;
  settings: SupervisorSettings;
  deps: SupervisorDeps;
  boot(signal?: AbortSignal): Promise<BootResult>;
  // 그 이름의 기록이 차례대로 몇 번째에 있는가.
  names(): string[];
}

export function world(over: { settings?: Partial<SupervisorSettings>; makers?: Partial<SupervisorMakers>; deps?: Partial<SupervisorDeps> } = {}): World {
  const time = manualTime();
  const trace: Trace = [];
  const events: { event: string; fields: LogFields }[] = [];
  const captured: Captured = { pumps: 0, delivers: 0 };
  const fake = fakeServer(trace);
  const { path } = installedLedger();
  const results = resultDir();
  const pem = new TextEncoder().encode(supervisorKeyPem());
  const text = (value: string) => () => Promise.resolve(new TextEncoder().encode(value));
  const files = new Map<string, () => Promise<Uint8Array>>([
    [FILES.certificate, text("CERT")],
    [FILES.privateKey, text("KEY")],
    [FILES.trustBundle, text("CA")],
    [FILES.signingKey, () => Promise.resolve(pem)],
    [FILES.registry, () => Promise.resolve(registryDoc())],
  ]);
  const front: FrontDoor = { stop: async () => null, peers: async () => FRONT_ROWS };
  const state: World = {
    time,
    trace,
    events,
    captured,
    fake,
    files,
    front,
    ledgerPath: path,
    openCalls: [],
    opened: null,
    wall: WALL,
    settings: baseSettings(path, results, over.settings),
    deps: null as unknown as SupervisorDeps,
    boot: (signal = new AbortController().signal) => bootSupervisor(state.settings, state.deps, signal),
    names: () => events.map((e) => e.event),
  };
  state.deps = {
    readFile: (file) => {
      trace.push(`read:${file}`);
      const read = files.get(file);
      return read === undefined ? Promise.reject(new Error("ENOENT")) : read();
    },
    openLedger: (file, options) => {
      trace.push(`open:${options.mode}`);
      state.openCalls.push({ path: file, options });
      const result = openLedger(file, options);
      if (result.ok) state.opened = result.ledger;
      return result;
    },
    createResultBackend: (options) => {
      trace.push("results");
      return { status: "ok", backend: { dir: options.dir } as never };
    },
    startServer: (options) => fake.start(options),
    credentialFiles: { read: async () => ({ kind: "missing" }) as never },
    frontDoor: {
      stopAuthority: { latestStop: () => front.stop() },
      publications: { lookup: () => Promise.reject(new Error("front_door_absent")) },
      peers: { contracts: () => front.peers() },
    },    wallNow: () => state.wall,
    monoNow: time.monoNow,
    setTimer: time.setTimer,
    random: { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
    log: (event, fields = {}) => {
      events.push({ event, fields });
      trace.push(`log:${event}`);
    },
    make: capturingMakers(captured, trace, over.makers),
    ...over.deps,
  };
  return state;
}

export const uuid = () => randomUUID();

// 루프백 시험의 실제 시계·타이머·CSPRNG 한 자리. 실제 소켓과 함께 돌아야 해서 손으로 돌리는 시계를 쓰지 못한다. 루프백 시험 파일은
// 시계·타이머·난수를 직접 부르지 않고 이것을 조립의 포트, 봉투의 발행 시각, 준비 데이터의 시각에 함께 쓴다(옮김은 시험이 더한다).
export function loopbackTime() {
  return {
    wall: (): number => Date.now(),
    mono: (): number => performance.now(),
    setTimer(ms: number, fire: () => void): () => void {
      const handle = setTimeout(fire, ms);
      return () => clearTimeout(handle);
    },
    random: { bytes: (length: number) => crypto.getRandomValues(new Uint8Array(length)) },
  };
}
