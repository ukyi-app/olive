// 작업자 실행기(제어 컨테이너)의 기동 조립. 환경을 읽지 않는다: 진입점(src/main/executor.ts)이 환경을 값(ExecutorSettings)으로 바꾸고
// 실제 파일·시계·타이머·소켓을 ExecutorDeps로 넘긴다. 시험은 같은 자리에 가짜를 넣는다.
//
// 기동 순서(어느 단계든 실패하면 감독에 붙기 전에 EXECUTOR_EXIT의 정한 코드로 끝난다):
//   재료(프로필·서명 키·감독 공개 키·TLS 파일) → 저장소 열기 → WorkerExecutor(기동 대조) → 대리 소켓 듣기 → 대리 hello 기다림
//   → recover → ExecutorLink 하나 → TLS 클라이언트 → 감독 소켓 하나 start → link.tick·worker.tick 주기
//
// - 대리의 hello 전에는 감독에 붙지 않는다. 대리 없이 붙으면 받은 시작을 띄우지 못하고 not_started로 버리게 된다.
//   예외는 물려받은 실행이 있어 원격이 처음부터 잠긴 기동이다(아래 inheritedUnverified). 그 원격은 어떤 hello도 받지 않으므로
//   기다리면 매번 상한에 걸려 감독에게 그 실행(unknown_running)을 알릴 길이 없다. 띄우기는 잠금이 막는다.
// - worker의 exitWaitMs와 원격의 replyWaitMs는 같은 값(timing.replyWaitMs) 하나에서 넘긴다. 원격의 시계(runtime.now)는 단조 시계이고
//   worker의 상한 타이머(전역 setTimeout)와 같은 시간 기준이어야 한다(deps.monoNow·deps.setTimer). worker의 now는 벽시계다.
// - 감독 소켓은 이 ExecutorLink에 하나만 붙인다. 우편함 하나를 소켓(inbox)과 worker(credentials)에 함께 넘긴다.
// - 연결 뒤 지시 처리(Connection.receive)가 던지면(첫 접수·재정리 종료 영수증의 로컬 서명 실패 등) 이 WorkerExecutor를 더 쓰지 않는다.
//   프로세스 안에서 다시 열지 않고 소켓을 멈춘 뒤 fatal 코드로 끝내 컨테이너 재시작에 맡긴다(같은 저장소를 두 객체가 쥐지 않는다).
// - 끝낼 때 소켓 stop()을 기다린 뒤 TLS 클라이언트를 닫는다. stop이 상한(stopWaitMs) 안에 끝나지 않으면 기다리지 않고 닫는다.
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { type Role, ROLES } from "../contract/v1/index.ts";
import type { TlsClient, TlsClientOptions } from "../transport/tls-client.ts";
import type { RawTlsMaterial } from "../transport/tls-policy.ts";
import type { UnixListening } from "./agent-listener.ts";
import { createCredentialInbox } from "./credential-inbox.ts";
import { ExecutorLink } from "./link.ts";
import { fixProfile, ProfileError, type RoleProfile } from "./profile.ts";
import { RemoteAgent } from "./remote-agent.ts";
import { createExecutorSocket, type ExecutorSocket, type ReceivePolicy, type ReconnectPolicy, type SocketEvent } from "./socket.ts";
import type { ExecutorStore, StoredRunState } from "./store.ts";
import { type RunSpace, WorkerExecutor } from "./worker.ts";

// 종료 코드. 0은 요청된 멈춤(SIGTERM 등) 뒤뿐이다. 64·69는 이미지의 다른 진입점이, 75~80은 대리(src/agent/agent.ts)가 쓴다.
export const EXECUTOR_EXIT = {
  // 진입점: 환경이 없거나 꼴이 틀렸다.
  config: 81,
  // 프로필·서명 키·감독 공개 키·TLS 파일을 읽지 못했거나 꼴이 틀렸다(프로필의 역할이 환경의 역할과 다름 포함).
  material: 82,
  store: 83,
  // WorkerExecutor의 기동 대조가 던졌다.
  startup_audit: 84,
  agent_listen: 85,
  // 상한 안에 대리의 hello가 없었다(대리가 없거나 늦거나, 붙은 연결이 잠겼다).
  agent_absent: 86,
  // recover가 거절됐다(로컬 서명 실패 등).
  recover: 87,
  // TLS 클라이언트(재료 검사)나 감독 소켓(정책 검사)을 만들지 못했다.
  supervisor_setup: 88,
  // 감독에 붙은 뒤 지시 처리나 주기 처리가 던졌다. 이 WorkerExecutor를 버리고 컨테이너 재시작에 맡긴다.
  fatal: 89,
} as const;

export type StartStep = "material" | "store" | "worker" | "agent_listen" | "agent_hello" | "recover" | "link" | "tls" | "socket";

export interface SupervisorTarget {
  readonly address: string;
  readonly port: number;
  // 감독 인증서의 DNS SAN(SNI로도 보낸다).
  readonly serverName: string;
  // 감독 인증서의 URI SAN.
  readonly uri: string;
}

// 읽을 파일의 경로. 모두 절대 경로다(진입점이 확인한다).
export interface MaterialFiles {
  // 역할 프로필 JSON(RoleProfile의 칸과 정확히 같다).
  readonly profile: string;
  // 효과 서명 개인 키(Ed25519 PEM). 제어 컨테이너에만 붙인다(D-73).
  readonly signingKey: string;
  // 감독의 지시 서명 공개 키(Ed25519 PEM).
  readonly supervisorKey: string;
  readonly certificate: string;
  readonly privateKey: string;
  readonly trustBundle: string;
}

export interface ExecutorTiming {
  // worker의 exitWaitMs와 원격의 replyWaitMs에 함께 넘기는 하나의 값. 둘이 다르면 worker가 포기한 정리의 늦은 계수를 원격이 받아
  // 두 판단이 갈라진다(remote-agent.md "증거의 기한").
  readonly replyWaitMs: number;
  // 대리 소켓을 연 뒤 hello를 기다리는 상한(단조 시계).
  readonly helloWaitMs: number;
  // hello를 확인하는 간격. 원격은 hello를 알리는 훅이 없어 상태(state)를 본다.
  readonly helloPollMs: number;
  // link.tick·worker.tick을 부르는 간격.
  readonly tickMs: number;
  // 끝낼 때 소켓 stop()을 기다리는 상한.
  readonly stopWaitMs: number;
}

export interface ExecutorSettings {
  readonly role: Role;
  readonly instance: string;
  readonly policyRevision: string;
  readonly supervisor: SupervisorTarget;
  readonly storeDir: string;
  // 대리가 붙는 경로 유닉스 소켓(링크 폴더 안).
  readonly agentSocket: string;
  readonly files: MaterialFiles;
  readonly timing: ExecutorTiming;
  // 감독 소켓의 정책. 기본값이 없다(socket.md). 진입점이 임시값을 넘긴다.
  readonly reconnect: ReconnectPolicy;
  readonly receive: ReceivePolicy;
}

export interface ExecutorDeps {
  readText(path: string): Promise<string>;
  openStore(dir: string, now: () => number): Promise<ExecutorStore>;
  // 경로·권한·지난 소켓 파일의 처리를 마친 듣기. 던지면 agent_listen이다.
  listenAgent(remote: RemoteAgent, path: string): UnixListening;
  // 재료가 틀리면 던진다(TlsMaterialError).
  createTlsClient(options: TlsClientOptions): Pick<TlsClient, "connect" | "close">;
  // 벽시계(에포크 ms). 저장소·worker·link·TLS 기간에 쓴다.
  wallNow(): number;
  // 단조 시계(ms). 원격의 기한 판정과 hello 기다림에 쓴다. setTimer와 같은 시간 기준이어야 한다.
  monoNow(): number;
  // ms 뒤에 한 번 부른다. 돌려준 함수로 취소한다.
  setTimer(ms: number, fire: () => void): () => void;
  // [0, 1). 다시 붙기 간격의 흔들림.
  random(): number;
  // 사유 이름과 단계만 넘긴다. 값(키, 자격, 메시지)은 넘기지 않는다.
  log(line: string): void;
  // 시험이 기동 차례를 보는 자리.
  onStep?(step: StartStep): void;
}

export interface RunningExecutor {
  // 끝날 때의 종료 코드로 풀린다. 소켓 stop()과 클라이언트 닫기가 끝난 뒤다.
  readonly done: Promise<number>;
  // 요청된 멈춤. done과 같은 약속을 돌려준다(코드 0).
  stop(): Promise<number>;
  readonly remote: RemoteAgent;
  readonly link: ExecutorLink;
  readonly worker: WorkerExecutor;
}

export type StartResult =
  | { readonly ok: true; readonly running: RunningExecutor }
  | { readonly ok: false; readonly step: StartStep; readonly code: number; readonly reason: string };

// 장부에 끝을 맺지 못한 채 남은 실행의 상태. 이 프로세스 전부터 있었다면 그 실행의 공간이 사라졌다는 따로 된 확인이 없다.
const UNFINISHED: readonly StoredRunState[] = ["preparing", "running", "stopping", "checking", "unknown_running"];

// 제어 컨테이너는 실행마다 만드는 폴더가 없다. 역할 프로그램의 작업 폴더는 역할 컨테이너에 있고 이 컨테이너에 붙지 않는다(D-100).
// 그래서 준비할 것도 지울 것도 없다. 실행마다 작업 폴더를 새로 만들고 지우는 일은 뒤 작업(O13)이 이 자리를 바꿔 정한다.
export const noRunFiles: RunSpace = {
  prepare: async () => {},
  clean: async () => true,
};

class MaterialError extends Error {}

interface Material {
  readonly profile: RoleProfile;
  readonly signingKey: KeyObject;
  readonly supervisorKey: KeyObject;
  readonly tls: RawTlsMaterial;
}

const PROFILE_KEYS = ["argv", "credentialEnv", "cwd", "env", "program", "revision", "role"];

// 계약의 역할 이름인가. 진입점이 OLIVE_ROLE을 볼 때도 쓴다.
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// 프로필 JSON을 RoleProfile로 읽는다. 칸이 빠지거나 더 있거나 타입이 틀리면 거절한다. 경로·환경의 규칙은 fixProfile이 본다.
export function parseProfile(text: string): RoleProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MaterialError("profile_not_json");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new MaterialError("profile_not_object");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== PROFILE_KEYS.join(",")) throw new MaterialError("profile_fields");
  const strings = (items: unknown) => Array.isArray(items) && items.every((item) => typeof item === "string");
  const env = value.env;
  const envOk = typeof env === "object" && env !== null && !Array.isArray(env) && Object.values(env).every((item) => typeof item === "string");
  if (!isRole(value.role) || typeof value.revision !== "string" || value.revision === "") throw new MaterialError("profile_role_or_revision");
  if (typeof value.program !== "string" || typeof value.cwd !== "string" || typeof value.credentialEnv !== "string" || !strings(value.argv) || !envOk) {
    throw new MaterialError("profile_types");
  }
  return fixProfile({
    role: value.role,
    revision: value.revision,
    program: value.program,
    argv: value.argv as string[],
    cwd: value.cwd,
    env: env as Record<string, string>,
    credentialEnv: value.credentialEnv,
  });
}

function ed25519(key: KeyObject, name: string): KeyObject {
  if (key.asymmetricKeyType !== "ed25519") throw new MaterialError(`${name}_not_ed25519`);
  return key;
}

async function readMaterial(settings: ExecutorSettings, readText: ExecutorDeps["readText"]): Promise<Material> {
  const files = settings.files;
  const read = (path: string, name: string) =>
    readText(path).catch(() => {
      throw new MaterialError(`${name}_unreadable`);
    });
  const [profileText, signingPem, supervisorPem, certificatePem, privateKeyPem, trustBundlePem] = await Promise.all([
    read(files.profile, "profile"),
    read(files.signingKey, "signing_key"),
    read(files.supervisorKey, "supervisor_key"),
    read(files.certificate, "certificate"),
    read(files.privateKey, "private_key"),
    read(files.trustBundle, "trust_bundle"),
  ]);
  const profile = parseProfile(profileText);
  if (profile.role !== settings.role) throw new MaterialError("profile_role_mismatch");
  let signingKey: KeyObject;
  let supervisorKey: KeyObject;
  try {
    signingKey = createPrivateKey(signingPem);
  } catch {
    throw new MaterialError("signing_key_invalid");
  }
  try {
    supervisorKey = createPublicKey(supervisorPem);
  } catch {
    throw new MaterialError("supervisor_key_invalid");
  }
  return {
    profile,
    signingKey: ed25519(signingKey, "signing_key"),
    supervisorKey: ed25519(supervisorKey, "supervisor_key"),
    tls: { certificatePem, privateKeyPem, trustBundlePem },
  };
}

// 오류에서 사유 이름만 꺼낸다. 메시지에는 경로나 값이 들 수 있어 쓰지 않는다.
function reasonOf(error: unknown): string {
  if (error instanceof MaterialError) return error.message;
  if (error instanceof ProfileError) return `profile_${error.code}`;
  const code = (error as { code?: unknown; reason?: unknown } | null)?.code ?? (error as { reason?: unknown } | null)?.reason;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "threw";
}

// 지금 연결이 hello를 했고 잠기지 않았으면 true. 상한까지 간격마다 본다. 잠기면(두 번째 연결 등) 기다리지 않고 false다.
function waitForHello(remote: RemoteAgent, timing: ExecutorTiming, deps: ExecutorDeps): Promise<boolean> {
  const limit = deps.monoNow() + timing.helloWaitMs;
  return new Promise((resolve) => {
    const check = () => {
      const state = remote.state();
      if (state.greeted && state.distrusted === null) return resolve(true);
      if (state.distrusted !== null || deps.monoNow() >= limit) return resolve(false);
      deps.setTimer(Math.max(1, Math.min(timing.helloPollMs, Math.ceil(limit - deps.monoNow()))), check);
    };
    check();
  });
}

export async function startExecutor(settings: ExecutorSettings, deps: ExecutorDeps): Promise<StartResult> {
  const step = (name: StartStep) => deps.onStep?.(name);
  const fail = (at: StartStep, code: number, error: unknown): StartResult => ({ ok: false, step: at, code, reason: reasonOf(error) });
  const timing = settings.timing;

  step("material");
  let material: Material;
  try {
    material = await readMaterial(settings, deps.readText);
  } catch (error) {
    return fail("material", EXECUTOR_EXIT.material, error);
  }

  step("store");
  let store: ExecutorStore;
  try {
    store = await deps.openStore(settings.storeDir, deps.wallNow);
  } catch (error) {
    return fail("store", EXECUTOR_EXIT.store, error);
  }

  // 공간이 사라졌다는 따로 된 확인(D-104의 새 세대 표식)은 아직 없다. 그래서 끝을 맺지 못한 실행이 하나라도 남았거나 장부를 설명하지 못하면
  // 원격을 처음부터 잠근다: 그 실행을 지금 붙을 대리의 0으로 닫지 않는다.
  const inheritedUnverified = store.ledgerHeld() || store.runs().some((run) => UNFINISHED.includes(run.state));
  const remote = new RemoteAgent({
    credentialEnv: material.profile.credentialEnv,
    runWindow: (runId) => store.run(runId),
    runtime: { setTimer: deps.setTimer, now: deps.monoNow },
    inheritedUnverified,
    replyWaitMs: timing.replyWaitMs,
  });
  let link: ExecutorLink | undefined;
  // 우편함은 소켓과 worker가 함께 쓰는 하나다. epoch는 offer·take 안에서만 읽으므로 link를 뒤에 만들어도 된다.
  const inbox = createCredentialInbox({ epoch: () => link?.epoch() ?? null });

  step("worker");
  let worker: WorkerExecutor;
  try {
    worker = new WorkerExecutor({
      instance: settings.instance,
      profile: material.profile,
      policyRevision: settings.policyRevision,
      store,
      signingKey: material.signingKey,
      supervisorKey: material.supervisorKey,
      credentials: inbox,
      cleanup: remote.cleanup,
      space: remote.space(noRunFiles),
      launcher: remote.launcher,
      now: deps.wallNow,
      exitWaitMs: timing.replyWaitMs,
    });
  } catch (error) {
    return fail("worker", EXECUTOR_EXIT.startup_audit, error);
  }

  step("agent_listen");
  let listener: UnixListening;
  try {
    listener = deps.listenAgent(remote, settings.agentSocket);
  } catch (error) {
    return fail("agent_listen", EXECUTOR_EXIT.agent_listen, error);
  }

  step("agent_hello");
  if (inheritedUnverified) deps.log("물려받은 실행이 있어 대리를 믿지 않는다(inherited_unverified). 대리를 기다리지 않고 감독에 알린다");
  else if (!(await waitForHello(remote, timing, deps))) {
    listener.stop();
    return { ok: false, step: "agent_hello", code: EXECUTOR_EXIT.agent_absent, reason: remote.state().distrusted ?? "no_hello" };
  }

  step("recover");
  try {
    await worker.recover();
  } catch (error) {
    listener.stop();
    return fail("recover", EXECUTOR_EXIT.recover, error);
  }

  step("link");
  const current = new ExecutorLink(worker, { now: deps.wallNow });
  link = current;

  step("tls");
  let client: Pick<TlsClient, "connect" | "close">;
  try {
    client = deps.createTlsClient({
      address: settings.supervisor.address,
      port: settings.supervisor.port,
      supervisorDnsName: settings.supervisor.serverName,
      supervisorUri: settings.supervisor.uri,
      material: material.tls,
      now: deps.wallNow,
    });
  } catch (error) {
    listener.stop();
    return fail("tls", EXECUTOR_EXIT.supervisor_setup, error);
  }

  step("socket");
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => (resolveDone = resolve));
  let ending: Promise<number> | undefined;
  let cancelTick: () => void = () => {};
  let socket: ExecutorSocket | undefined;

  const shutdown = (code: number, reason: string): Promise<number> => {
    ending ??= (async () => {
      cancelTick();
      deps.log(`실행기를 멈춘다(${reason}), 코드 ${code}`);
      if (socket !== undefined) {
        let cancelBound: () => void = () => {};
        const stopped = await Promise.race([
          socket.stop().then(() => true),
          new Promise<boolean>((resolve) => (cancelBound = deps.setTimer(timing.stopWaitMs, () => resolve(false)))),
        ]);
        cancelBound();
        if (!stopped) deps.log("감독 소켓이 상한 안에 멈추지 않아 기다리지 않고 닫는다");
      }
      client.close();
      listener.stop();
      resolveDone(code);
      return code;
    })();
    return ending;
  };

  // 기록만 한다(socket.md: onEvent 안에서 소켓·link를 부르지 않는다). 치명 사건이면 멈춤을 타이머로 미뤄 연다.
  const onEvent = (event: SocketEvent) => {
    deps.log(`감독 소켓: ${event.kind}${"reason" in event ? `(${event.reason})` : ""}`);
    if (event.kind === "closed" && event.reason === "receive_failed") deps.setTimer(0, () => void shutdown(EXECUTOR_EXIT.fatal, "receive_failed"));
    if (event.kind === "retry_unavailable") deps.setTimer(0, () => void shutdown(EXECUTOR_EXIT.fatal, "retry_unavailable"));
  };

  const created = createExecutorSocket({
    client,
    link: current,
    inbox,
    policy: settings.reconnect,
    receive: settings.receive,
    timer: {
      set: (callback, ms) => deps.setTimer(ms, callback),
      clear: (handle) => (handle as () => void)(),
    },
    random: deps.random,
    onEvent,
  });
  if (!created.ok) {
    client.close();
    listener.stop();
    return { ok: false, step: "socket", code: EXECUTOR_EXIT.supervisor_setup, reason: created.reason };
  }
  socket = created.socket;
  socket.start();

  const tick = () => {
    if (ending !== undefined) return;
    try {
      current.tick();
      worker.tick();
    } catch {
      void shutdown(EXECUTOR_EXIT.fatal, "tick_failed");
      return;
    }
    cancelTick = deps.setTimer(timing.tickMs, tick);
  };
  cancelTick = deps.setTimer(timing.tickMs, tick);

  return {
    ok: true,
    running: { done, stop: () => shutdown(0, "requested"), remote, link: current, worker },
  };
}
