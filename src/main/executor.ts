// 작업자 실행기(제어 컨테이너)의 진입점. 환경을 값으로 바꾸고 실제 파일·시계·타이머·소켓을 src/executor/runtime.ts의 조립에 넘긴다.
// 환경 읽기는 이 파일과 role-agent.ts에만 둔다. 환경이 하나라도 없거나 틀리면 감독에 붙기 전에 81로 끝난다(빈 값으로 뜨지 않는다).
// 실행기는 감독에 먼저 붙는 쪽이다. 듣는 곳은 역할 컨테이너의 대리가 붙는 경로 유닉스 소켓 하나다(D-102, agent-listener.ts).
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { limits, parsePrincipal, type Role } from "../contract/v1/index.ts";
import { listenForAgent, type UnixListening } from "../executor/agent-listener.ts";
import type { RemoteAgent } from "../executor/remote-agent.ts";
import { EXECUTOR_EXIT, type ExecutorDeps, type ExecutorSettings, isRole, REVISION, type RunningExecutor, startExecutor } from "../executor/runtime.ts";
import { ExecutorStore } from "../executor/store.ts";
import { createTlsClient } from "../transport/tls-client.ts";
import { parseIdentityUri } from "../transport/tls-policy.ts";

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

// 점 넷의 십진 IPv4(각 칸 0~255, 앞자리 0 없음). 차트는 감독 Service의 IPv4 고정 주소를 준다. 이름이면 DNS 조회에 기대게 되고,
// 그 조회의 실패는 연결 뒤에야 드러난다.
const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/;
const isIpv4 = (host: string) => {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => IPV4_OCTET.test(part) && Number(part) <= 255);
};
// 감독 인증서의 DNS SAN(SNI로도 보낸다). RFC 1123 호스트 이름의 소문자 꼴이고, 칸의 글자 규칙은 tls-policy.ts의 LABEL과 같다.
// 이 꼴이 아니면 감독 인증서의 DNS SAN과 같을 수 없어 TLS 상대 확인에서 매번 거절된다.
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$/;
// 인스턴스 이름은 실행기 이름(executor/<역할>/<인스턴스>/<저장소 ID>)의 한 칸이다. 저장소 ID 자리에 꼴이 맞는 자리값을 넣고 계약의 규칙(parsePrincipal)으로 본다.
// 저장소를 만들기 전에 거른다: worker가 이름을 만들 때 걸리면 그 전에 저장소 ID가 이미 생긴다.
const instanceOk = (role: Role, instance: string) => parsePrincipal(`executor/${role}/${instance}/0`)?.kind === "worker_executor";

// 환경을 값으로 바꾼다. 처음 걸린 이름 하나를 돌려준다(값은 담지 않는다).
// 꼴은 연결 전에 거를 수 있는 것까지 본다(계약 v1의 revision·실행기 이름 칸, 감독 신원 URI). 틀린 값으로 붙으면 감독이 맞춤·인사 단계에서
// 거절하고 실행기는 다시 붙기를 되풀이한다.
export function settingsFromEnv(env: Readonly<Record<string, string | undefined>>): EnvResult {
  for (const name of EXECUTOR_ENV) if ((env[name] ?? "") === "") return { ok: false, name, problem: "missing" };
  const value = (name: (typeof EXECUTOR_ENV)[number]) => env[name]!;
  const invalid = (name: string): EnvResult => ({ ok: false, name, problem: "invalid" });
  // v1 역할 이름만 받는다. 차트의 대상 ID(읽기 대상 `reader` 등)는 역할이 아니다: 차트가 역할 이름(`isolated_reader`)으로 옮겨 넘긴다.
  const role = value("OLIVE_ROLE");
  if (!isRole(role)) return invalid("OLIVE_ROLE");
  if (!instanceOk(role, value("OLIVE_INSTANCE"))) return invalid("OLIVE_INSTANCE");
  if (!REVISION.test(value("OLIVE_POLICY_REVISION"))) return invalid("OLIVE_POLICY_REVISION");
  // 주소는 IPv4:port 하나다. IPv6 리터럴과 이름은 받지 않는다.
  const addr = /^([^:\s]+):(\d{1,5})$/.exec(value("OLIVE_SUPERVISOR_ADDR"));
  const port = addr === null ? 0 : Number(addr[2]);
  if (addr === null || !isIpv4(addr[1]!) || port < 1 || port > 65_535) return invalid("OLIVE_SUPERVISOR_ADDR");
  if (!DNS_NAME.test(value("OLIVE_SUPERVISOR_SERVER_NAME"))) return invalid("OLIVE_SUPERVISOR_SERVER_NAME");
  if (parseIdentityUri(value("OLIVE_SUPERVISOR_URI"))?.kind !== "supervisor") return invalid("OLIVE_SUPERVISOR_URI");
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
  // 신호 처리기는 기동 전에 건다. 기동 중(hello 대기 30초 포함)의 신호는 기동을 중단시켜 감독에 붙지 않고 0으로 끝내고,
  // 기동 뒤의 신호는 소켓을 멈춘 뒤 0으로 끝낸다. 함정: 이 프로세스가 컨테이너의 PID 1이면 커널은 처리기가 없는 신호를 버린다
  // (SIGKILL 제외). 처리기 없이 두면 기동 중의 SIGTERM이 사라지고 기동을 마친 실행기가 감독에 붙는다.
  const stop = new AbortController();
  let running: RunningExecutor | undefined;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (running === undefined) stop.abort();
      else void running.stop();
    });
  }
  const started = await startExecutor(parsed.settings, productionDeps, stop.signal);
  if (!started.ok) {
    console.error(`olive executor ${pkg.version}: 기동 단계 ${started.step}에서 멈췄다(${started.reason})`);
    process.exit(started.code);
  }
  running = started.running;
  process.exit(await running.done);
}

if (import.meta.main) await main();
