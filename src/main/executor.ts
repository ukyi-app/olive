// 작업자 실행기(제어 컨테이너)의 진입점. 환경을 값으로 바꾸고 실제 파일·시계·타이머·소켓을 src/executor/runtime.ts의 조립에 넘긴다.
// 환경 읽기는 이 파일과 role-agent.ts에만 둔다. 환경이 하나라도 없거나 틀리면 감독에 붙기 전에 81로 끝난다(빈 값으로 뜨지 않는다).
// 실행기는 감독에 먼저 붙는 쪽이다. 듣는 곳은 역할 컨테이너의 대리가 붙는 경로 유닉스 소켓 하나다(D-102, agent-listener.ts).
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { limits } from "../contract/v1/index.ts";
import { listenForAgent, type UnixListening } from "../executor/agent-listener.ts";
import type { RemoteAgent } from "../executor/remote-agent.ts";
import { EXECUTOR_EXIT, type ExecutorDeps, type ExecutorSettings, isRole, startExecutor } from "../executor/runtime.ts";
import { ExecutorStore } from "../executor/store.ts";
import { createTlsClient } from "../transport/tls-client.ts";

// 읽는 환경. 출처와 없을 때의 동작은 README "작업자 실행기 진입점"의 표와 같아야 한다.
export const EXECUTOR_ENV = [
  "OLIVE_ROLE",
  "OLIVE_INSTANCE",
  "OLIVE_POLICY_REVISION",
  "OLIVE_SUPERVISOR_ADDR",
  "OLIVE_SUPERVISOR_SERVER_NAME",
  "OLIVE_SUPERVISOR_URI",
  "OLIVE_STORE_DIR",
  "OLIVE_TLS_DIR",
  "OLIVE_TRUST_DIR",
  "OLIVE_SIGNING_KEY_FILE",
  "OLIVE_PROFILE_FILE",
  "OLIVE_AGENT_SOCKET",
] as const;

// 운영 숫자의 임시값. socket.md가 기본값을 두지 않은 정책을 여기서 정한다. 실측 뒤 바꾼다.
const TIMING: ExecutorSettings["timing"] = {
  // worker의 기본 exitWaitMs와 같은 값. worker와 원격에 이 하나를 함께 넘긴다.
  replyWaitMs: limits.STOP_GRACE_MS + 5_000,
  helloWaitMs: 30_000,
  helloPollMs: 50,
  tickMs: 1_000,
  stopWaitMs: 10_000,
};
const RECONNECT: ExecutorSettings["reconnect"] = { initialDelayMs: 1_000, maxDelayMs: 30_000, multiplier: 2, jitterRatio: 0.2 };
const RECEIVE: ExecutorSettings["receive"] = { maxQueuedBytes: 1_048_576 };
// 대리 소켓 파일의 권한. 경로 유닉스 소켓에 붙으려면 그 파일의 쓰기 권한이 있어야 한다. D-103으로 역할 컨테이너(uid·gid 10002)는
// 제어(65532)와 그룹을 나누지 않으므로(fsGroup 없음) 기타(other)에 읽기·쓰기를 준다. 역할 컨테이너 안의 무엇이든 붙을 수 있는 것은
// 그룹으로 열어도 같다(대리와 역할 프로그램이 같은 uid). 두 번째 연결은 원격이 잠근다. bind 때는 umask로 소유자만 열어 두고 듣기 뒤에 이 값으로 연다.
const AGENT_SOCKET_MODE = 0o606;
const BIND_UMASK = 0o177;

export type EnvResult = { readonly ok: true; readonly settings: ExecutorSettings } | { readonly ok: false; readonly name: string; readonly problem: "missing" | "invalid" };

// 환경을 값으로 바꾼다. 처음 걸린 이름 하나를 돌려준다(값은 담지 않는다).
export function settingsFromEnv(env: Readonly<Record<string, string | undefined>>): EnvResult {
  for (const name of EXECUTOR_ENV) if ((env[name] ?? "") === "") return { ok: false, name, problem: "missing" };
  const value = (name: (typeof EXECUTOR_ENV)[number]) => env[name]!;
  const invalid = (name: string): EnvResult => ({ ok: false, name, problem: "invalid" });
  const role = value("OLIVE_ROLE");
  if (!isRole(role)) return invalid("OLIVE_ROLE");
  // 주소는 host:port 하나다. IPv6 리터럴은 받지 않는다(차트는 Service의 IPv4 고정 주소를 준다).
  const addr = /^([^:\s]+):(\d{1,5})$/.exec(value("OLIVE_SUPERVISOR_ADDR"));
  const port = addr === null ? 0 : Number(addr[2]);
  if (addr === null || port < 1 || port > 65_535) return invalid("OLIVE_SUPERVISOR_ADDR");
  for (const name of ["OLIVE_STORE_DIR", "OLIVE_TLS_DIR", "OLIVE_TRUST_DIR", "OLIVE_SIGNING_KEY_FILE", "OLIVE_PROFILE_FILE", "OLIVE_AGENT_SOCKET"] as const) {
    if (!isAbsolute(value(name))) return invalid(name);
  }
  const tlsDir = value("OLIVE_TLS_DIR");
  const trustDir = value("OLIVE_TRUST_DIR");
  return {
    ok: true,
    settings: {
      role,
      instance: value("OLIVE_INSTANCE"),
      policyRevision: value("OLIVE_POLICY_REVISION"),
      supervisor: { address: addr[1]!, port, serverName: value("OLIVE_SUPERVISOR_SERVER_NAME"), uri: value("OLIVE_SUPERVISOR_URI") },
      storeDir: value("OLIVE_STORE_DIR"),
      agentSocket: value("OLIVE_AGENT_SOCKET"),
      files: {
        profile: value("OLIVE_PROFILE_FILE"),
        signingKey: value("OLIVE_SIGNING_KEY_FILE"),
        // 차트의 신뢰 ConfigMap(olive-trust)이 감독 공개 키를 이 이름으로 함께 준다.
        supervisorKey: join(trustDir, "supervisor-signing.pub"),
        certificate: join(tlsDir, "tls.crt"),
        privateKey: join(tlsDir, "tls.key"),
        trustBundle: join(trustDir, "ca-bundle.pem"),
      },
      timing: TIMING,
      reconnect: RECONNECT,
      receive: RECEIVE,
    },
  };
}

// 지난 기동이 남긴 소켓 파일은 지운다(링크 폴더는 제어만 쓰고 역할 컨테이너에는 읽기 전용이다). 소켓이 아닌 파일이면 지우지 않고 거절한다.
function clearStaleSocket(path: string): void {
  let isSocket: boolean;
  try {
    isSocket = lstatSync(path).isSocket();
  } catch {
    return;
  }
  if (!isSocket) throw new Error("not_a_socket");
  unlinkSync(path);
}

// 대리 소켓을 실제로 듣는다. 지난 소켓 파일을 지우고, bind 동안만 umask를 좁히고, 듣기 뒤 AGENT_SOCKET_MODE로 연다.
export function listenAgentSocket(remote: RemoteAgent, path: string): UnixListening {
  clearStaleSocket(path);
  // 함정: 소켓 파일의 권한은 bind 때 umask로 정해지고 chmod는 그 뒤다. 그 틈에 다른 uid가 붙지 못하게 bind 동안만 umask를 좁힌다.
  // 저장소의 폴더 만들기가 좁은 umask를 물려받지 않게 바로 되돌린다.
  const previous = process.umask(BIND_UMASK);
  try {
    return listenForAgent(remote, { path, mode: AGENT_SOCKET_MODE, chmod: chmodSync });
  } finally {
    process.umask(previous);
  }
}

const productionDeps: ExecutorDeps = {
  readText: (path) => readFile(path, "utf8"),
  openStore: (dir, now) => ExecutorStore.open(dir, { now }),
  listenAgent: listenAgentSocket,
  createTlsClient,
  wallNow: Date.now,
  monoNow: () => performance.now(),
  // 원격의 기한 판정(monoNow)과 worker의 상한 타이머(전역 setTimeout)가 같은 시간 기준이다.
  setTimer: (ms, fire) => {
    const handle = setTimeout(fire, ms);
    return () => clearTimeout(handle);
  },
  random: Math.random,
  log: (line) => console.error(`olive executor: ${line}`),
};

async function main(): Promise<never> {
  const parsed = settingsFromEnv(process.env);
  if (!parsed.ok) {
    console.error(`olive executor ${pkg.version}: 환경 ${parsed.name}이(가) ${parsed.problem === "missing" ? "없다" : "틀렸다"}`);
    process.exit(EXECUTOR_EXIT.config);
  }
  const started = await startExecutor(parsed.settings, productionDeps);
  if (!started.ok) {
    console.error(`olive executor ${pkg.version}: 기동 단계 ${started.step}에서 멈췄다(${started.reason})`);
    process.exit(started.code);
  }
  const running = started.running;
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void running.stop());
  process.exit(await running.done);
}

if (import.meta.main) await main();
