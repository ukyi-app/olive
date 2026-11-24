// 작업자 실행기(제어 컨테이너)의 기동 조립. 환경을 읽지 않는다: 진입점(src/main/executor.ts)이 환경을 값(ExecutorSettings)으로 바꾸고
// 실제 파일·시계·타이머·소켓을 ExecutorDeps로 넘긴다. 시험은 같은 자리에 가짜를 넣는다.
//
// 기동 순서(감독 소켓 start 전의 단계가 실패하면 감독에 붙기 전에 EXECUTOR_EXIT의 정한 코드로 끝난다):
//   재료(프로필·서명 키·감독 공개 키·TLS 파일) → 저장소 열기 → WorkerExecutor(기동 대조) → 대리 소켓 듣기 → 대리 hello 기다림
//   → recover → ExecutorLink 하나 → TLS 클라이언트 → 감독 소켓 하나 start → link.tick·worker.tick 주기
//
// - 대리의 hello 전에는 감독에 붙지 않는다. 대리 없이 붙으면 받은 시작을 띄우지 못하고 not_started로 버리게 된다.
//   예외는 물려받은 실행이 있어 원격이 처음부터 잠긴 기동이다(아래 inheritedUnverified). 그 원격은 어떤 hello도 받지 않으므로
//   기다리면 매번 상한에 걸려 감독에게 그 실행(unknown_running)을 알릴 길이 없다. 띄우기는 잠금이 막는다.
//   이 예외는 기동 대조(WorkerExecutor 생성자의 auditRuns)를 지난 장부와 recover가 쓰는 같은 유효한 사건(store.validEvents)으로만 정한다.
//   그래서 원격을 worker 뒤에 만든다.
// - hello는 받은 때(단조 시계)와 그 연결 세대로 판정한다. recover를 기다리는 사이 대리 연결이 바뀌면, 감독 소켓 start 전에
//   처음 상한의 남은 시간 안에서 새 세대의 hello를 다시 기다린다. 기다림에서 돌아올 때마다 지금 세대를 다시 본다.
// - worker의 exitWaitMs와 원격의 replyWaitMs는 같은 값(timing.replyWaitMs) 하나에서 넘긴다. 원격의 시계(runtime.now)는 단조 시계이고
//   worker의 상한 타이머(전역 setTimeout)와 같은 시간 기준이어야 한다(deps.monoNow·deps.setTimer). worker의 now는 벽시계다.
// - 감독 소켓은 이 ExecutorLink에 하나만 붙인다. 우편함 하나를 소켓(inbox)과 worker(credentials)에 함께 넘긴다.
// - 연결 뒤 지시 처리(Connection.receive)가 던지면(첫 접수·재정리 종료 영수증의 로컬 서명 실패 등) 이 WorkerExecutor를 더 쓰지 않는다.
//   프로세스 안에서 다시 열지 않고 소켓을 멈춘 뒤 fatal 코드로 끝내 컨테이너 재시작에 맡긴다(같은 저장소를 두 객체가 쥐지 않는다).
//   그 거절은 연결의 닫힘 사유와 따로 끝내기로 잇는다(아래 fatal). 끝내기는 예약기(setTimer)에 기대지 않는다.
//   앞 연결에서 시작한 지시 처리가 끝나기 전에는 다시 붙지 않는다(아래 gatedClient): 그 결과가 거절이면 끝내야 할 worker다.
//   그 기다림은 settleWaitMs에 묶는다. 넘으면 다시 붙지 않고 fatal로 끝낸다.
// - 기동의 기다림(재료 읽기·저장소 열기·recover)도 하나마다 settleWaitMs에 묶는다. 넘으면 그 단계의 코드로 끝난다(사유 timed_out).
// - 끝낼 때 소켓 stop()을 기다린 뒤 TLS 클라이언트를 닫는다. stop이 상한(stopWaitMs) 안에 끝나지 않거나 상한을 걸지 못하면 기다리지 않고 닫는다.
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { encodeControl } from "../agent/link.ts";
import { type Role, ROLES } from "../contract/v1/index.ts";
import type { TlsClient, TlsClientOptions } from "../transport/tls-client.ts";
import type { RawTlsMaterial } from "../transport/tls-policy.ts";
import type { UnixListening } from "./agent-listener.ts";
import type { ProcessCleanup } from "./containment.ts";
import { createCredentialInbox } from "./credential-inbox.ts";
import type { Launcher } from "./launcher.ts";
import { ExecutorLink } from "./link.ts";
import { fixProfile, ProfileError, type RoleProfile } from "./profile.ts";
import { type AgentLinkSession, type AgentLinkTransport, RemoteAgent, type RemoteAgentOptions } from "./remote-agent.ts";
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
  // 기동의 기다림(재료 읽기·저장소 열기·recover) 하나와, 감독에 다시 붙기 전 앞 연결의 지시 처리를 기다리는 상한(단조 시계).
  // 넘으면 이 worker를 버린다(기동이면 그 단계의 코드, 다시 붙기면 fatal). 지시 처리와 recover 안에서 상한이 걸린 기다림
  // (종료·계수 각각 replyWaitMs)보다 길어야 정상 처리를 끊지 않는다. 진입점의 값과 그 근거는 src/main/executor.ts에 있다.
  readonly settleWaitMs: number;
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
// 그래서 준비할 것이 없다. 지우기는 확인할 수 없으므로 false다: receipt_cleaned는 자격·tmp·작업 폴더를 지웠다는 뜻이고
// (계약 v1 receipt), 감독은 그 영수증으로 실행을 끝내고 슬롯을 푼다. 확인하지 못한 실행은 cleanup_pending으로 슬롯을 쥔 채 남는다.
// 실행마다 작업 폴더를 지우고 그것을 확인하는 일은 뒤 작업(O13)이 이 자리를 바꿔 정한다.
export const noRunFiles: RunSpace = {
  prepare: async () => {},
  clean: async () => false,
};

class MaterialError extends Error {}

interface Material {
  readonly profile: RoleProfile;
  readonly signingKey: KeyObject;
  readonly supervisorKey: KeyObject;
  readonly tls: RawTlsMaterial;
}

const PROFILE_KEYS = ["argv", "credentialEnv", "cwd", "env", "program", "revision", "role"];

// 계약 v1의 revision 꼴(hello의 profile_revision·policy_revision). 계약의 공개 면이 이 정규식을 내지 않아 여기 다시 두고,
// 계약 스키마의 것과 같은지는 시험이 대조한다. 진입점이 OLIVE_POLICY_REVISION을 볼 때도 쓴다.
export const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// 감독 공개 키 파일은 공개 형식 PEM(SubjectPublicKeyInfo) 한 덩이만 받는다. createPublicKey는 개인 키나 인증서에서도
// 공개 부분을 꺼내므로, 그 꼴로 잘못 넣은 파일도 기동하게 된다.
const PUBLIC_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/;

// worker가 원격에 넘기는 실행마다의 출력 상한(start의 output_bytes). 프로필 검사(LINK_PROBE)도 이 값으로 start를 인코딩한다.
// 링크가 받는 최댓값(OUTPUT_MAX_BYTES, 6자리)으로 재면 실제 start(5자리)에는 실리는 경계 프로필을 거절한다.
export const RUN_OUTPUT_BYTES = 64 * 1024;

// 대리 링크의 start에서 실행마다 달라지는 칸의 자리값. 실제 start와 같은 출력 상한, 꼴이 맞고 인코딩이 가장 긴 ID·시각을 넣어
// 프로필이 실제 start에 실리는지 본다.
const LINK_PROBE = {
  run_id: "00000000-0000-0000-0000-000000000000",
  credential_digest: "0".repeat(64),
  output_bytes: RUN_OUTPUT_BYTES,
  deadline_at: Number.MAX_SAFE_INTEGER,
  lease_until: Number.MAX_SAFE_INTEGER,
} as const;

// 계약의 역할 이름인가. 진입점이 OLIVE_ROLE을 볼 때도 쓴다.
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// 대리 링크가 이 프로필로 start를 만들 수 있는가. 링크의 인코더(argv·고정 env의 개수, 이름, 틀 크기 상한)를 그대로 쓴다.
// 실을 수 없는 프로필로 뜨면 감독이 등록·배정까지 성공한 뒤 매 작업이 대리 start 없이 실패한다.
function linkCarries(profile: RoleProfile): boolean {
  try {
    encodeControl({
      type: "start",
      program: profile.program,
      argv: [...profile.argv],
      cwd: profile.cwd,
      env: { ...profile.env },
      credential_env: profile.credentialEnv,
      ...LINK_PROBE,
    });
    return true;
  } catch {
    return false;
  }
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
  if (!isRole(value.role) || typeof value.revision !== "string" || !REVISION.test(value.revision)) throw new MaterialError("profile_role_or_revision");
  if (typeof value.program !== "string" || typeof value.cwd !== "string" || typeof value.credentialEnv !== "string" || !strings(value.argv) || !envOk) {
    throw new MaterialError("profile_types");
  }
  const profile = fixProfile({
    role: value.role,
    revision: value.revision,
    program: value.program,
    argv: value.argv as string[],
    cwd: value.cwd,
    env: env as Record<string, string>,
    credentialEnv: value.credentialEnv,
  });
  if (!linkCarries(profile)) throw new MaterialError("profile_link_unencodable");
  return profile;
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
  if (!PUBLIC_KEY_PEM.test(supervisorPem)) throw new MaterialError("supervisor_key_not_public");
  return {
    profile,
    signingKey: ed25519(signingKey, "signing_key"),
    supervisorKey: ed25519(supervisorKey, "supervisor_key"),
    tls: { certificatePem, privateKeyPem, trustBundlePem },
  };
}

class StepTimeout extends Error {
  constructor(readonly code: "timed_out" | "bound_unavailable") {
    super(code);
  }
}

// 기동의 기다림 하나를 상한(단조 시계의 setTimer)에 묶는다. 상한이 되거나 상한을 걸지 못하면 StepTimeout으로 거절한다.
// 늦게 끝난 결과는 버린다: 기동이 실패하면 진입점이 프로세스를 끝내므로 그 결과(열린 저장소, 진행 중인 복원)를 쓸 자리가 없다.
function bounded<T>(work: Promise<T>, ms: number, setTimer: ExecutorDeps["setTimer"]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let cancel: () => void = () => {};
    const settle = () => {
      try {
        cancel();
      } catch {
        // 취소하지 못한 상한 타이머가 늦게 불려도 이미 정해진 약속은 바뀌지 않는다
      }
    };
    work.then(
      (value) => (settle(), resolve(value)),
      (error: unknown) => (settle(), reject(error)),
    );
    try {
      cancel = setTimer(ms, () => reject(new StepTimeout("timed_out")));
    } catch {
      reject(new StepTimeout("bound_unavailable"));
    }
  });
}

// 오류에서 사유 이름만 꺼낸다. 메시지에는 경로나 값이 들 수 있어 쓰지 않는다.
function reasonOf(error: unknown): string {
  if (error instanceof MaterialError) return error.message;
  if (error instanceof ProfileError) return `profile_${error.code}`;
  const code = (error as { code?: unknown; reason?: unknown } | null)?.code ?? (error as { reason?: unknown } | null)?.reason;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "threw";
}

// 대리의 hello를 받은 때(단조 시계)와 그 연결 세대를 적는 원격. 원격에는 hello를 알리는 훅이 없어, 받은 조각을 넘긴 직후 상태를 본다.
// 확인 간격의 타이머가 밀려도 받은 시각으로 상한과 견주려는 것이다: 상한 뒤에 받은 hello를 제때 온 것으로 치지 않고,
// 상한 전에 받은 hello를 확인이 늦었다고 버리지 않는다.
class GreetedRemote extends RemoteAgent {
  private greetedAt: { readonly generation: number; readonly at: number } | null = null;

  constructor(
    options: RemoteAgentOptions,
    private readonly greetClock: () => number,
  ) {
    super(options);
  }

  override connect(transport: AgentLinkTransport): AgentLinkSession | null {
    const session = super.connect(transport);
    if (session === null) return null;
    const generation = this.state().generation;
    return {
      receive: (chunk) => {
        session.receive(chunk);
        const state = this.state();
        if (this.greetedAt?.generation !== generation && state.generation === generation && state.greeted) {
          this.greetedAt = { generation, at: this.greetClock() };
        }
      },
      closed: () => session.closed(),
    };
  }

  // 지금 연결이 hello를 했고 잠기지 않았으면 그 hello의 세대와 받은 시각. 아니면 null.
  greeting(): { readonly generation: number; readonly at: number } | null {
    const state = this.state();
    if (!state.connected || !state.greeted || state.distrusted !== null) return null;
    return this.greetedAt?.generation === state.generation ? this.greetedAt : null;
  }
}

// 상한(limit, 단조 시계) 전에 받은 지금 연결의 hello가 있으면 그 세대, 없으면 null. 간격마다 본다. 잠기거나(두 번째 연결 등) 멈춤 요청이 오면
// 기다리지 않는다.
function waitForHello(remote: GreetedRemote, limit: number, timing: ExecutorTiming, deps: ExecutorDeps, stop: AbortSignal | undefined): Promise<number | null> {
  return new Promise((resolve) => {
    stop?.addEventListener("abort", () => resolve(null), { once: true });
    const check = () => {
      if (stop?.aborted) return resolve(null);
      const greeting = remote.greeting();
      if (greeting !== null && greeting.at < limit) return resolve(greeting.generation);
      if (remote.state().distrusted !== null || deps.monoNow() >= limit) return resolve(null);
      try {
        deps.setTimer(Math.max(1, Math.min(timing.helloPollMs, Math.ceil(limit - deps.monoNow()))), check);
      } catch {
        // 다시 볼 수 없으면 hello가 없는 것으로 끝낸다(감독에 붙기 전이다).
        resolve(null);
      }
    };
    check();
  });
}

// stop: 기동 중의 멈춤 요청(진입점이 기동 전에 건 신호 처리기가 중단한다). 기다림(재료·저장소·hello·recover) 뒤마다 보고, 중단됐으면
// 감독에 붙지 않고 연 대리 소켓을 닫은 뒤 코드 0으로 돌려준다. 기동을 마친 뒤의 멈춤은 RunningExecutor.stop이다.
export async function startExecutor(settings: ExecutorSettings, deps: ExecutorDeps, stop?: AbortSignal): Promise<StartResult> {
  const step = (name: StartStep) => deps.onStep?.(name);
  const stopped = (at: StartStep): StartResult => ({ ok: false, step: at, code: 0, reason: "stop_requested" });
  // 멈춤 요청이 단계 실패보다 앞선다: 요청을 받은 뒤 끝난 기다림이 실패여도 0이다(요청된 멈춤이다). 실패의 사유 이름은 기록만 한다.
  // 부르는 자리는 그 전에 연 대리 소켓을 이미 닫았다.
  const fail = (at: StartStep, code: number, error: unknown): StartResult => {
    const reason = reasonOf(error);
    if (!stop?.aborted) return { ok: false, step: at, code, reason };
    deps.log(`멈춤 요청 뒤 ${at} 단계가 실패했다(${reason}). 멈춤이 앞서 0으로 끝낸다`);
    return stopped(at);
  };
  const timing = settings.timing;

  step("material");
  let material: Material;
  try {
    material = await bounded(readMaterial(settings, deps.readText), timing.settleWaitMs, deps.setTimer);
  } catch (error) {
    return fail("material", EXECUTOR_EXIT.material, error);
  }
  if (stop?.aborted) return stopped("material");

  step("store");
  let store: ExecutorStore;
  try {
    store = await bounded(deps.openStore(settings.storeDir, deps.wallNow), timing.settleWaitMs, deps.setTimer);
  } catch (error) {
    return fail("store", EXECUTOR_EXIT.store, error);
  }
  if (stop?.aborted) return stopped("store");

  let link: ExecutorLink | undefined;
  // 우편함은 소켓과 worker가 함께 쓰는 하나다. epoch는 offer·take 안에서만 읽으므로 link를 뒤에 만들어도 된다.
  const inbox = createCredentialInbox({ epoch: () => link?.epoch() ?? null });

  // 원격은 기동 대조 뒤에 만든다(아래). worker에는 그 원격으로 넘기는 자리를 준다. worker는 생성자에서 이 셋을 부르지 않는다
  // (프로세스 정리·공간·띄우기는 recover와 지시 처리부터 쓴다).
  let remote: GreetedRemote | undefined;
  let remoteSpace: RunSpace | undefined;
  const ready = () => {
    if (remote === undefined || remoteSpace === undefined) throw new Error("remote_not_ready");
    return { remote, space: remoteSpace };
  };
  const cleanup: ProcessCleanup = {
    terminate: () => ready().remote.cleanup.terminate(),
    survivors: () => ready().remote.cleanup.survivors(),
    busy: () => ready().remote.cleanup.busy(),
  };
  const space: RunSpace = {
    prepare: (runId, signal) => ready().space.prepare(runId, signal),
    clean: (runId) => ready().space.clean(runId),
  };
  const launcher: Launcher = { run: (plan, signal, hooks) => ready().remote.launcher.run(plan, signal, hooks) };

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
      cleanup,
      space,
      launcher,
      now: deps.wallNow,
      exitWaitMs: timing.replyWaitMs,
      outputBytes: RUN_OUTPUT_BYTES,
    });
  } catch (error) {
    return fail("worker", EXECUTOR_EXIT.startup_audit, error);
  }

  // 공간이 사라졌다는 따로 된 확인(D-104의 새 세대 표식)은 아직 없다. 그래서 끝을 맺지 못한 실행이 하나라도 남았거나 장부를 설명하지 못하면
  // 원격을 처음부터 잠근다: 그 실행을 지금 붙을 대리의 0으로 닫지 않는다.
  // 함정: 장부는 worker 생성자의 기동 대조(auditRuns)를 지난 뒤에 본다. 그 전의 장부에는 접수가 아닌 최초 preparing(사건·영수증 없음)이 남아,
  // 물려받은 실행이 없는데도 대리를 잠그고 감독에 빈 목록으로 인사한 뒤 새 작업을 띄우지 못한다.
  // 함정: 상태 이름만 보지 않는다. 종료 영수증은 저장되고 실행 기록 쓰기만 실패한 실행은 checking 등으로 남지만, recover는 그 유효한 사건으로
  // 맺고 남은 수를 세지 않는다(worker.reconcile). 대리의 계수를 쓰지 않는 실행으로 잠그면 recover 뒤에도 잠금이 풀리지 않아, 정상 대리를
  // 거절하고 새 작업을 띄우지 못한다. 그래서 같은 사건으로 판단한다.
  // 함정: 잠금을 푸는 조건은 recover가 고를 후보 상태를 저장소가 받아들일 때와 같아야 한다. 그 후보(failed_stopped·ready_result·finalized)는
  // 모두 같은 세대의 유효한 receipt_stopped를 전제한다(store.ts REQUIRED_EVENTS). receipt_cleaned만 있으면 finalized가 거절돼 보류가 서고
  // recover가 남은 수를 센다: 그때 잠기지 않은 원격이면 방금 붙은 대리에 정리 요청을 보낸다. 그래서 receipt_cleaned 하나로는 풀지 않는다.
  const settledByEvent = (runId: string) => !store.suspectRun(runId) && store.validEvents(runId).some((entry) => entry.action === "receipt_stopped");
  const unverified = () => store.ledgerHeld() || store.runs().some((run) => UNFINISHED.includes(run.state) && !settledByEvent(run.run_id));
  const inheritedUnverified = unverified();
  const agent = new GreetedRemote(
    {
      credentialEnv: material.profile.credentialEnv,
      runWindow: (runId) => store.run(runId),
      runtime: { setTimer: deps.setTimer, now: deps.monoNow },
      inheritedUnverified,
      replyWaitMs: timing.replyWaitMs,
    },
    deps.monoNow,
  );
  remote = agent;
  remoteSpace = agent.space(noRunFiles);

  step("agent_listen");
  let listener: UnixListening;
  try {
    listener = deps.listenAgent(agent, settings.agentSocket);
  } catch (error) {
    return fail("agent_listen", EXECUTOR_EXIT.agent_listen, error);
  }

  step("agent_hello");
  const helloLimit = deps.monoNow() + timing.helloWaitMs;
  const absent = (): StartResult => {
    listener.stop();
    if (stop?.aborted) return stopped("agent_hello");
    return { ok: false, step: "agent_hello", code: EXECUTOR_EXIT.agent_absent, reason: agent.state().distrusted ?? "no_hello" };
  };
  let greeted: number | null = null;
  if (inheritedUnverified) deps.log("물려받은 실행이 있어 대리를 믿지 않는다(inherited_unverified). 대리를 기다리지 않고 감독에 알린다");
  else {
    greeted = await waitForHello(agent, helloLimit, timing, deps, stop);
    if (greeted === null) return absent();
  }

  step("recover");
  try {
    await bounded(worker.recover(), timing.settleWaitMs, deps.setTimer);
  } catch (error) {
    listener.stop();
    return fail("recover", EXECUTOR_EXIT.recover, error);
  }

  // 잠그지 않은 판단은 recover가 남은 실행을 모두 사건으로 맺는다는 예상이었다. recover 뒤에 그와 달리 끝을 맺지 못한 실행이 남거나 장부가
  // 보류됐으면 잠기지 않은 원격으로 그 실행을 감독에 알리게 된다. 붙지 않고 끝내 다음 기동이 잠금을 다시 정하게 한다.
  if (!inheritedUnverified && unverified()) {
    listener.stop();
    if (stop?.aborted) return stopped("recover");
    return { ok: false, step: "recover", code: EXECUTOR_EXIT.recover, reason: "unverified_after_recover" };
  }

  // recover를 기다리는 사이 대리 연결이 바뀌었을 수 있다(끊기고 새 세대가 붙음). 인사한 그 세대가 아직 연결·인사·신뢰 상태인지 다시 보고,
  // 아니면 처음 상한의 남은 시간 안에서 지금 세대의 hello를 기다린다. 다시 기다린 뒤에도 그 사이 또 바뀌었을 수 있어, 기다림에서 돌아올 때마다
  // 다시 본다. 상한이 고정이라 계속 바뀌면 waitForHello가 null(86)로 끝난다. 이 반복을 나온 뒤 감독 소켓 start까지는 await가 없다.
  while (!inheritedUnverified && agent.greeting()?.generation !== greeted) {
    deps.log("복원 중 대리 연결이 바뀌어 새 연결의 hello를 기다린다");
    step("agent_hello");
    greeted = await waitForHello(agent, helloLimit, timing, deps, stop);
    if (greeted === null) return absent();
  }
  if (stop?.aborted) {
    listener.stop();
    return stopped("recover");
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
  let fatalReason: string | null = null;
  // 감독 연결에서 시작해 아직 끝나지 않은 지시 처리(Connection.receive)의 끝. 거절이면 fatal을 정한 뒤에 풀리므로 이 약속 자체는 거절되지 않는다.
  const inFlight = new Set<Promise<void>>();

  // 닫는 쪽 효과는 하나가 실패해도 나머지를 막지 않는다. 예약기가 고장 나 상한을 걸지 못하면 stop을 기다리지 않고 닫는다
  // (끝나지 않을 수 있는 stop에 프로세스를 묶지 않는다).
  const shutdown = (code: number, reason: string): Promise<number> => {
    ending ??= (async () => {
      try {
        cancelTick();
      } catch {
        // 다음 tick은 ending을 보고 돌지 않는다
      }
      deps.log(`실행기를 멈춘다(${reason}), 코드 ${code}`);
      if (socket !== undefined) {
        const stopping = socket.stop().then(() => true);
        let stopped: boolean;
        try {
          let cancelBound: () => void = () => {};
          const bound = new Promise<boolean>((resolve) => (cancelBound = deps.setTimer(timing.stopWaitMs, () => resolve(false))));
          stopped = await Promise.race([stopping, bound]);
          cancelBound();
        } catch {
          stopped = false;
        }
        if (!stopped) deps.log("감독 소켓이 상한 안에 멈추지 않았거나 상한을 걸지 못해 기다리지 않고 닫는다");
      }
      try {
        client.close();
      } catch {
        // 클라이언트 닫기의 실패가 대리 소켓 닫기와 종료를 막지 않는다
      }
      try {
        listener.stop();
      } catch {
        // 위와 같다
      }
      resolveDone(code);
      return code;
    })();
    return ending;
  };

  // 치명 실패를 끝내기로 잇는다. 부른 자리(소켓 사건, 지시 처리의 거절) 밖의 마이크로태스크에서 끝낸다(socket.md: onEvent 안에서 소켓을
  // 부르지 않는다). 예약기에 기대지 않는다: 예약기가 고장 난 것이 끝내는 이유일 수 있다(retry_unavailable).
  // 끝내기가 정해진 순간부터 감독 소켓은 새 연결을 열지 않는다(아래 guardedLink.open).
  const fatal = (reason: string) => {
    if (fatalReason !== null) return;
    fatalReason = reason;
    queueMicrotask(() => void shutdown(EXECUTOR_EXIT.fatal, reason));
  };

  // 기록하고, 치명 사건이면 fatal로 넘긴다.
  const onEvent = (event: SocketEvent) => {
    deps.log(`감독 소켓: ${event.kind}${"reason" in event ? `(${event.reason})` : ""}`);
    if (event.kind === "closed" && event.reason === "receive_failed") fatal("receive_failed");
    if (event.kind === "retry_unavailable") fatal("retry_unavailable");
  };

  // 감독 소켓이 여는 연결마다 지시 처리(Connection.receive)의 거절을 fatal로 바로 잇는다. 소켓도 그 거절을 receive_failed 닫힘으로 알리지만,
  // 연결이 먼저 닫혔으면(상대가 끊음 등) 그 연결의 닫힘 사건은 이미 나갔고 다시 나오지 않는다(socket.ts의 shut은 한 연결에 한 번).
  // 연결 객체는 감싸지 않는다: 소켓이 link.isCurrent로 같은 객체인지 본다. 거절 반응은 소켓의 await보다 먼저 걸리므로 fatal의 끝내기는
  // 소켓이 그 거절을 처리한 뒤에 돈다. 처리마다 끝을 inFlight에 두어 다시 붙기가 기다린다(아래 gatedClient).
  const guardedLink: Pick<ExecutorLink, "open" | "isCurrent" | "epoch"> = {
    open: (transport) => {
      if (fatalReason !== null || ending !== undefined) throw new Error("executor_stopping");
      const connection = current.open(transport);
      const receive = connection.receive.bind(connection);
      connection.receive = (raw) => {
        const handled = receive(raw);
        const settled = handled.then(
          () => {},
          () => fatal("receive_failed"),
        );
        inFlight.add(settled);
        void settled.then(() => inFlight.delete(settled));
        return handled;
      };
      return connection;
    },
    isCurrent: (connection) => current.isCurrent(connection),
    epoch: () => current.epoch(),
  };

  // 감독 소켓이 붙을 때마다(처음과 다시 붙기) 앞 연결에서 시작한 지시 처리가 모두 끝난 뒤에만 TCP를 연다. 그 처리가 거절되면 fatal이
  // 정해져 붙지 않는다. 함정: 소켓은 연결이 닫히면 그 연결의 처리를 기다리지 않고 다시 붙기를 건다. 기다리지 않으면 재정리 응답이 다시 붙기
  // 간격보다 늦고 응답 상한보다 이를 때, 곧 끝낼 worker가 감독과 다시 맞추고 인사·영수증 재전송을 한 뒤에야 89로 끝난다.
  // 함정: 처리 안의 저장소 쓰기(맞춤 답의 정지 세대 쓰기, 검증의 nonce, 영수증·실행 기록)에는 상한이 없다. 그 쓰기가 돌아오지 않으면
  // 이 기다림도 끝나지 않아, 실행기가 살아 있는 채 다시 붙지도 끝나지도 않는다. 그래서 기다림마다 settleWaitMs를 걸고, 넘으면 다시 붙지
  // 않고 fatal로 끝내 컨테이너 재시작에 맡긴다. 저장소는 쓰기를 차례로 하므로 멈춘 쓰기 뒤에서는 새 연결의 맞춤도 끝나지 않는다.
  // 소켓의 멈춤(중단 신호)이면 기다리지 않고 거절한다.
  const settledInFlight = (signal: AbortSignal | undefined, limit: number) =>
    new Promise<"settled" | "aborted" | "lapsed">((resolve) => {
      if (signal?.aborted) return resolve("aborted");
      let cancelBound: () => void = () => {};
      const end = (how: "settled" | "aborted") => {
        resolve(how);
        try {
          cancelBound();
        } catch {
          // 늦게 불린 상한은 이미 정해진 약속을 바꾸지 않는다
        }
      };
      signal?.addEventListener("abort", () => end("aborted"), { once: true });
      void Promise.all([...inFlight]).then(() => end("settled"));
      try {
        cancelBound = deps.setTimer(Math.max(1, Math.ceil(limit - deps.monoNow())), () => resolve("lapsed"));
      } catch {
        // 상한을 걸지 못하면 기다리지 않는다(끝나지 않을 수 있는 처리에 다시 붙기를 묶지 않는다)
        resolve("lapsed");
      }
    });
  const gatedClient: Pick<TlsClient, "connect" | "close"> = {
    connect: async (signal) => {
      const limit = deps.monoNow() + timing.settleWaitMs;
      while (inFlight.size > 0 && !signal?.aborted && fatalReason === null) {
        deps.log("앞 연결의 지시 처리가 끝나기를 기다린 뒤 다시 붙는다");
        if ((await settledInFlight(signal, limit)) === "lapsed") fatal("in_flight_stalled");
      }
      if (signal?.aborted) throw new Error("connect_aborted");
      if (fatalReason !== null || ending !== undefined) throw new Error("executor_stopping");
      return client.connect(signal);
    },
    close: () => client.close(),
  };

  const created = createExecutorSocket({
    client: gatedClient,
    link: guardedLink,
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

  // 다음 tick을 걸지 못하는 것도 tick의 실패다: 걸리지 않은 채 두면 임대·맞춤 기한을 보지 않는 실행기가 살아남는다.
  const tick = () => {
    if (ending !== undefined) return;
    try {
      current.tick();
      worker.tick();
      cancelTick = deps.setTimer(timing.tickMs, tick);
    } catch {
      void shutdown(EXECUTOR_EXIT.fatal, "tick_failed");
    }
  };
  try {
    cancelTick = deps.setTimer(timing.tickMs, tick);
  } catch {
    fatal("tick_failed");
  }

  return {
    ok: true,
    running: { done, stop: () => shutdown(0, "requested"), remote: agent, link: current, worker },
  };
}
