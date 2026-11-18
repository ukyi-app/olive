// 실행기 시험이 함께 쓰는 도구: 시험 중에 만드는 키, 감독 쪽 봉투, 가짜 연결·정리·폴더·자격, 시계.
// 키와 자격 값은 시험이 돌 때마다 새로 만든다(저장소에 두지 않는다).
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Action, type Bodies, type Envelope, sealEnvelope, type SealInput } from "../../src/contract/v1/index.ts";
import type { ProcessCleanup } from "../../src/executor/containment.ts";
import { bunLauncher, type Launcher, type SpawnedChild } from "../../src/executor/launcher.ts";
import { type Connection, ExecutorLink, type Transport } from "../../src/executor/link.ts";
import type { CredentialSource, RoleProfile } from "../../src/executor/profile.ts";
import { ExecutorStore, type StoreIo } from "../../src/executor/store.ts";
import { type RunSpace, WorkerExecutor } from "../../src/executor/worker.ts";

export const FAKE_ROLE = fileURLToPath(new URL("./fake-role.ts", import.meta.url));
export const T0 = 1_800_000_000_000;
export const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export const supervisorKeys = generateKeyPairSync("ed25519");
export const executorKeys = generateKeyPairSync("ed25519");

export function scratch(prefix = "olive-executor-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export class Clock {
  constructor(public t = T0) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

// 감독이 낸 봉투. 기본은 지금 시각의 발급, 실행 세대 1.
export function fromSupervisor<A extends Action>(
  clock: Clock,
  recipient: string,
  action: A,
  body: Bodies[A],
  header: { stop_generation: number; run_generation?: number; issued_at?: number; request_id?: string },
): Envelope {
  const input: SealInput<A> = {
    sender: "supervisor",
    recipient,
    action,
    request_id: header.request_id ?? randomUUID(),
    stop_generation: header.stop_generation,
    run_generation: header.run_generation ?? 0,
    issued_at: header.issued_at ?? clock.now(),
    nonce: randomBytes(16).toString("hex"),
    body,
  };
  return sealEnvelope(input, supervisorKeys.privateKey);
}

export class FakeTransport implements Transport {
  sent: Envelope[] = [];
  closed = false;
  send(envelope: Envelope) {
    if (this.closed) throw new Error("closed");
    this.sent.push(envelope);
  }
  close() {
    this.closed = true;
  }
  actions() {
    return this.sent.map((envelope) => envelope.header.action);
  }
  of<A extends Action>(action: A): (Envelope & { body: Bodies[A] })[] {
    return this.sent.filter((envelope) => envelope.header.action === action) as (Envelope & { body: Bodies[A] })[];
  }
}

// 가짜 정리. survivors가 돌려줄 값을 시험이 정한다. terminate는 시험이 띄운 자식을 그 자식의 핸들로만 끝낸다.
// 숫자 PID로 보내지 않는다: 끝나 회수된 자식의 번호는 이 머신의 무관한 프로세스가 다시 받을 수 있다.
// 끝난 자식은 등록에서 빠지고(recordingLauncher), 핸들도 끝난 자식에는 보내지 않는다(launcher.ts).
export class FakeCleanup implements ProcessCleanup {
  remaining: number | null = 0;
  // survivors가 던지게 하는 자리(세는 쪽의 실패).
  survivorsError: Error | null = null;
  terminations = 0;
  survivorChecks = 0;
  // 살아 있다고 아는 자식과 끝나서 등록에서 뺀 자식.
  readonly children = new Set<SpawnedChild>();
  readonly exitedChildren = new Set<SpawnedChild>();
  // 신호를 보낸 자식(끝난 자식이 여기 있으면 안 된다).
  readonly signalled: SpawnedChild[] = [];
  // 정리가 걸린 경우: 신호가 닿지 않고(inert) terminate가 돌아오지 않는다(hold).
  inert = false;
  hold: Promise<void> | undefined;
  async terminate() {
    this.terminations++;
    if (!this.inert) {
      for (const child of this.children) {
        this.signalled.push(child);
        child.signal("SIGKILL");
      }
    }
    await this.hold;
  }
  async survivors() {
    this.survivorChecks++;
    if (this.survivorsError !== null) throw this.survivorsError;
    return this.remaining;
  }
  busy() {
    return false;
  }
}

export class FakeSpace implements RunSpace {
  prepared: string[] = [];
  cleaned: string[] = [];
  cleanResult = true;
  before: (() => void | Promise<void>) | undefined;
  // 지우기가 돌아오기 전에 시험이 끼어드는 자리(정리 중 경합).
  cleanGate: Promise<void> | undefined;
  signals: AbortSignal[] = [];
  async prepare(runId: string, signal?: AbortSignal) {
    this.prepared.push(runId);
    if (signal) this.signals.push(signal);
    await this.before?.();
  }
  async clean(runId: string) {
    this.cleaned.push(runId);
    await this.cleanGate;
    return this.cleanResult;
  }
}

export class FakeCredentials implements CredentialSource {
  values = new Map<string, Uint8Array>();
  calls: { runId: string; digest: string }[] = [];
  signals: AbortSignal[] = [];
  // 값을 내어 주기 전에 시험이 끼어드는 자리(준비 중 경합).
  before: (() => void | Promise<void>) | undefined;
  async take(runId: string, digest: string, signal?: AbortSignal) {
    this.calls.push({ runId, digest });
    if (signal) this.signals.push(signal);
    await this.before?.();
    return this.values.get(runId) ?? null;
  }
}

// 시험이 여닫는 문. open 전까지 기다리게 한다.
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

export const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// bunLauncher를 감싸 띄운 자식의 핸들을 정리 가짜에 알리고, 끝나면 등록에서 뺀다.
export function recordingLauncher(cleanup: FakeCleanup): Launcher & { spawned: number; onSpawned: (() => void) | undefined } {
  const launcher = {
    spawned: 0,
    // 자식이 생긴 직후 시험이 끼어드는 자리(예: 시계를 임대 뒤로 옮긴다).
    onSpawned: undefined as (() => void) | undefined,
    // 자식이 실제로 끝났을 때만 등록에서 뺀다(끝을 기다리다 포기한 자식은 계속 핸들로 끝낼 수 있어야 한다).
    run: (plan, signal, hooks) =>
      bunLauncher.run(plan, signal, {
        ...hooks,
        spawned: (child) => {
          launcher.spawned++;
          cleanup.children.add(child);
          void child.exited.then(() => {
            cleanup.children.delete(child);
            cleanup.exitedChildren.add(child);
          });
          hooks.spawned(child);
          launcher.onSpawned?.();
        },
      }),
  } satisfies Launcher & { spawned: number; onSpawned: (() => void) | undefined };
  return launcher;
}

export function fakeProfile(mode: string, cwd: string, extraEnv: Record<string, string> = {}): RoleProfile {
  return {
    role: "diagnosis",
    revision: "diagnosis-r1",
    program: process.execPath,
    argv: [FAKE_ROLE, mode, "diagnosis"],
    cwd,
    env: { LANG: "C.UTF-8", OLIVE_ROLE: "diagnosis", ...extraEnv },
    credentialEnv: "OLIVE_CREDENTIAL",
  };
}

export interface Rig {
  clock: Clock;
  dir: string;
  cwd: string;
  store: ExecutorStore;
  worker: WorkerExecutor;
  link: ExecutorLink;
  cleanup: FakeCleanup;
  space: FakeSpace;
  credentials: FakeCredentials;
  launcher: Launcher & { spawned: number; onSpawned: (() => void) | undefined };
  transport: FakeTransport;
  connection: Connection;
  challenge: string;
}

export interface RigOptions {
  mode?: string;
  dir?: string;
  clock?: Clock;
  io?: Partial<StoreIo>;
  connect?: boolean;
  // 맞춤 답의 정지 세대. null이면 맞추지 않는다(연결만 연다).
  syncTo?: number | null;
  extraEnv?: Record<string, string>;
  exitWaitMs?: number;
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  const clock = options.clock ?? new Clock();
  const dir = options.dir ?? scratch();
  const cwd = scratch("olive-role-cwd-");
  const store = await ExecutorStore.open(dir, { now: clock.now, io: options.io });
  const cleanup = new FakeCleanup();
  const space = new FakeSpace();
  const credentials = new FakeCredentials();
  const launcher = recordingLauncher(cleanup);
  const worker = new WorkerExecutor({
    instance: "worker-1",
    profile: fakeProfile(options.mode ?? "complete", cwd, options.extraEnv),
    policyRevision: "policy-r1",
    store,
    signingKey: executorKeys.privateKey,
    supervisorKey: supervisorKeys.publicKey,
    credentials,
    cleanup,
    space,
    launcher,
    now: clock.now,
    drainMs: 100,
    exitWaitMs: options.exitWaitMs,
  });
  let n = 0;
  const challenges: string[] = [];
  const link = new ExecutorLink(worker, {
    now: clock.now,
    challenge: () => {
      const value = (0xc0ffee00 + ++n).toString(16).padStart(32, "0");
      challenges.push(value);
      return value;
    },
  });
  const transport = new FakeTransport();
  const connection = link.open(transport);
  const r: Rig = { clock, dir, cwd, store, worker, link, cleanup, space, credentials, launcher, transport, connection, challenge: challenges[0]! };
  const syncTo = options.syncTo === undefined ? 0 : options.syncTo;
  if (syncTo !== null) await sync(r, syncTo);
  return r;
}

export function syncReply(r: Rig, stopGeneration: number, challenge = r.connection.pending()?.challenge ?? r.challenge, issuedAt = r.clock.now()) {
  return fromSupervisor(r.clock, r.worker.name, "stop_sync_reply", { challenge }, { stop_generation: stopGeneration, issued_at: issuedAt });
}

export async function sync(r: Rig, stopGeneration: number) {
  await r.connection.receive(syncReply(r, stopGeneration));
}

// 새 연결을 열고 맞춘다.
export async function reconnect(r: Rig, stopGeneration: number) {
  const transport = new FakeTransport();
  r.transport = transport;
  r.connection = r.link.open(transport);
  await r.connection.receive(syncReply(r, stopGeneration));
}

// 조건이 참이 될 때까지 짧게 기다린다(실제 프로세스가 뜨고 끝나는 시험).
export async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const limit = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > limit) throw new Error("기다린 조건이 시간 안에 참이 되지 않았다");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const credentialValue = () => new TextEncoder().encode(`test-credential-${randomBytes(12).toString("hex")}`);

export function taskStartBody(r: Rig, runId: string, digest: string, overrides: Partial<Bodies["task_start"]> = {}): Bodies["task_start"] {
  return {
    run_id: runId,
    role: "diagnosis",
    profile_revision: "diagnosis-r1",
    policy_revision: "policy-r1",
    snapshot_digest: sha256("snapshot"),
    input_digest: sha256("input"),
    deadline_at: r.clock.now() + 600_000,
    budget_tokens: 1_000,
    credential: { account: "main", method: "subscription", revision: "cred-1", digest },
    ...overrides,
  };
}

// 자격을 준비하고 task_start를 받는다.
export async function start(r: Rig, options: { stop?: number; runId?: string; value?: Uint8Array; digest?: string; body?: Partial<Bodies["task_start"]> } = {}) {
  const runId = options.runId ?? randomUUID();
  const value = options.value ?? credentialValue();
  r.credentials.values.set(runId, value);
  const envelope = fromSupervisor(r.clock, r.worker.name, "task_start", taskStartBody(r, runId, options.digest ?? sha256(value), options.body), {
    stop_generation: options.stop ?? 0,
    run_generation: 1,
  });
  await r.connection.receive(envelope);
  return { runId, value, envelope };
}
