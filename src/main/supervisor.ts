// 감독의 진입점. 환경을 값으로 바꾸고 실제 파일·장부 열기·서버 시작·시계·타이머·CSPRNG를 src/supervisor/runtime/boot.ts의 조립에 넘긴다.
// 환경 읽기는 이 파일에만 둔다(감독 쪽). 환경이 하나라도 없거나 틀리면 아무 파일도 읽기 전에 91로 끝난다(빈 값으로 뜨지 않는다).
// 듣는 곳은 둘이다: 실행기를 받는 연결 서버(tls-server.ts의 TCP)와, 기동 뒤에 여는 관리 통로(admin/listener.ts의 경로 유닉스 소켓).
import { getRandomValues } from "node:crypto";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { limits } from "../contract/v1/index.ts";
import { openLedger } from "../ledger/index.ts";
import { nodeCredentialFiles } from "../supervisor/accounts/credential-ref.ts";
import { answerLine, createAdminHandlers } from "../supervisor/admin/commands.ts";
import { type AdminFs, type AdminListening, AdminListenRefused, listenAdmin } from "../supervisor/admin/listener.ts";
import { ADMIN_SOCKET_MODE, ADMIN_SOCKET_PATH } from "../supervisor/admin/protocol.ts";
import { bootSupervisor, type FrontDoorPorts, type LogFields, type RunningSupervisor, SUPERVISOR_EXIT, type SupervisorDeps, type SupervisorSettings } from "../supervisor/runtime/boot.ts";
import { testFrontDoorPorts, testOriginOf } from "../supervisor/frontdoor/test-double.ts";
import { RENEW_MARGIN_MS } from "../supervisor/scheduler/lifecycle.ts";
import { createFileResultBackend } from "../supervisor/scheduler/result-store-file.ts";
import { RegistryState, type RegistryTarget } from "../supervisor/transport/registry.ts";
import { startConnectionServer } from "../supervisor/transport/server.ts";
import { CREDENTIAL_MAX_BYTES } from "../transport/framing.ts";
import { KEEPALIVE_USER_TIMEOUT_MS } from "../transport/keepalive.ts";
import { LEDGER_FILE } from "./ledger-path.ts";

// 읽는 환경. 차례는 README "감독 진입점"의 표와 같다: 차트가 이미 주는 이름이 앞, 차트 짝(N5c)이 더할 이름이 뒤다.
export const SUPERVISOR_ENV = [
  "OLIVE_SUPERVISOR_PORT",
  "OLIVE_LEDGER_DIR",
  "OLIVE_SIGNING_KEY_DIR",
  "OLIVE_ACCOUNTS_DIR",
  "OLIVE_TLS_DIR",
  "OLIVE_TRUST_DIR",
  "OLIVE_REGISTRY_FILE",
  "OLIVE_ENVIRONMENT",
  "OLIVE_TARGETS",
  "OLIVE_POLICY_REVISION",
  "OLIVE_RESULT_DIR",
] as const;
// 없어도 되는 환경. README "감독 진입점"의 표에서 필수 이름 뒤에 이 차례로 둔다.
// OLIVE_TEST_JOBS: 시험 작업 넣기(D-98·D-101). "on"이면 켜고, 없거나 빈 값이나 "off"면 꺼짐이다. 그 밖의 값은 91: 오타가 조용히 켜짐·꺼짐으로
// 읽히지 않게. 운영 값에서 켜면 차트의 CI가 거절한다(차트 짝의 일, README "감독 관리 통로").
// OLIVE_TEST_FRONTDOOR: 시험 현관 대역(D-109). 값의 규칙은 OLIVE_TEST_JOBS와 같고, 더해 "on"은 OLIVE_TEST_JOBS도 "on"일 때만 받는다.
// 감독이 아는 "시험 값"의 표시는 OLIVE_TEST_JOBS=on 하나뿐이라(운영 값에서 그 값을 거절할 차트 CI는 뒤 homelab PR의 일이고 아직 없다) 그것 없이 켜면 운영 값으로 보고 91이다.
export const SUPERVISOR_OPTIONAL_ENV = ["OLIVE_TEST_JOBS", "OLIVE_TEST_FRONTDOOR"] as const;

// 파일 이름. 폴더는 환경이 주고 이름은 코드가 정한다. 장부 파일 이름은 장부 초기화 진입점과 함께 쓴다(ledger-path.ts).
// 서명 키의 이름은 차트의 Secret 키 이름과 맞춰야 한다(차트 짝에서 맞춘다).
const SIGNING_KEY_FILE = "supervisor-signing.key";
// 듣는 주소. 파드 안의 모든 주소다(Service가 앞에 선다).
const LISTEN_HOST = "0.0.0.0";
// 실행기 밖의 필수 이웃. 현관은 계약의 주체 이름, 관측 중계는 계약에 이름이 없어 이 값을 현관 조각(O08)과 맞춘다.
const OTHER_PEERS = ["front-door", "observation-relay"] as const;

// 운영 숫자의 임시값. 시험 클러스터의 실측 뒤 바꾼다.
const TIMING: SupervisorSettings["timing"] = {
  // 갱신 구간(기본 7,000ms) 안에서 수명 박자가 여러 번 돈다.
  beatEveryMs: 1_000,
  // 박자 하나가 갱신 구간을 넘기기 전에 끊는다.
  beatWaitMs: 5_000,
  restoreStepWaitMs: 30_000,
  startupWaitMs: 10_000,
  // Kubernetes 기본 종료 유예(30초) 안에 끝 차례를 마친다.
  stopWaitMs: 10_000,
};
// 갱신을 낼 수 있는 구간을 7,000ms로 둔다(lifecycle.ts의 LifecyclePolicy 설명).
const LIFE: SupervisorSettings["life"] = { renewEveryMs: limits.RUN_LEASE_MAX_MS - RENEW_MARGIN_MS - 7_000, answerTimeoutMs: 20_000 };
// 감독 서버와 실행기 소켓의 TCP keepalive가 반쯤 열린 연결을 닫기까지의 한계(ms). TCP_USER_TIMEOUT이 0이 아니면 커널은 그 값으로 끊고,
// keepalive.ts는 그 값을 첫 탐침 지연 + 간격 × 횟수(30초 + 10초 × 4 = 70초)와 같게 둔다: 조용한 연결과 보낸 바이트가 확인되지 않는
// 연결이 모두 이 안에 닫힌다. keepalive 값을 바꾸면 이 한계도 따라 바뀌고, 결과 기한과의 관계는 시험이 다시 본다.
export const KEEPALIVE_DETECT_MS = KEEPALIVE_USER_TIMEOUT_MS;
// 결과 보고 없는 checking 실행을 결과 없음으로 판정하기까지의 기다림(D-113). T1 실측 전의 시험 숫자다. 감독은 닫힘을 통보받지 못한
// 연결(상대가 사라졌는데 FIN이 오지 않음)을 인정된 연결로 본다. 그 연결은 keepalive가 KEEPALIVE_DETECT_MS 안에 닫고, 실행기는 다시
// 붙은 뒤 ack가 없는 보고를 RENEW_INTERVAL_MS(10초)마다 다시 보낸다(worker.ts의 tick). 그래서 기한은 둘을 더한 80초보다 길어야
// 끊김을 알기 전에 판정하지 않는다: 여유 10초를 더해 90초(재전송 아홉 번)로 둔다. 관계는 시험이 묶는다.
export const RESULT_CHECK: SupervisorSettings["resultCheck"] = { reportWaitMs: 9 * limits.RENEW_INTERVAL_MS };
const CYCLE: SupervisorSettings["cycle"] = { judgeMs: limits.DISCONNECT_JUDGE_MS, resendEveryMs: 5_000, assignCallsPerBeat: 4 };

// 계약 v1 hello의 revision 칸 꼴(contract/v1/schema.ts의 REVISION과 같다). 계약은 index.ts로만 import하므로 같은 꼴을 여기 둔다.
// 꼴이 틀린 값으로 뜨면 모든 실행기의 정책 대조가 mismatch가 되어 접수가 늘 닫힌다.
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// frontDoor: 진입점이 조립에 넘길 현관 포트. absent(현관 전, 늘 모름)가 기본이고 test_double은 시험 현관 대역이다(frontDoorFor).
export type EnvResult =
  | { readonly ok: true; readonly settings: SupervisorSettings; readonly frontDoor: FrontDoorChoice }
  | { readonly ok: false; readonly name: string; readonly problem: "missing" | "invalid" };
export type FrontDoorChoice = "absent" | "test_double";

// 환경을 값으로 바꾼다. 처음 걸린 이름 하나를 돌려준다(값은 담지 않는다). 연결 전에 거를 수 있는 것(포트, 절대 경로, 등록표 설정,
// revision의 꼴)까지 여기서 본다.
export function settingsFromEnv(env: Readonly<Record<string, string | undefined>>): EnvResult {
  for (const name of SUPERVISOR_ENV) if ((env[name] ?? "") === "") return { ok: false, name, problem: "missing" };
  const value = (name: (typeof SUPERVISOR_ENV)[number]) => env[name]!;
  const invalid = (name: string): EnvResult => ({ ok: false, name, problem: "invalid" });
  const port = /^\d{1,5}$/.test(value("OLIVE_SUPERVISOR_PORT")) ? Number(value("OLIVE_SUPERVISOR_PORT")) : 0;
  if (port < 1 || port > 65_535) return invalid("OLIVE_SUPERVISOR_PORT");
  for (const name of ["OLIVE_LEDGER_DIR", "OLIVE_SIGNING_KEY_DIR", "OLIVE_ACCOUNTS_DIR", "OLIVE_TLS_DIR", "OLIVE_TRUST_DIR", "OLIVE_REGISTRY_FILE", "OLIVE_RESULT_DIR"] as const) {
    if (!isAbsolute(value(name))) return invalid(name);
  }
  let targets: RegistryTarget[];
  try {
    targets = JSON.parse(value("OLIVE_TARGETS"));
  } catch {
    return invalid("OLIVE_TARGETS");
  }
  const registry = { environment: value("OLIVE_ENVIRONMENT"), targets };
  // 등록표 설정은 RegistryState가 검사한다. 함정: 틀린 설정에도 start는 던지지 않고 아무도 믿지 않는 상태를 만들며, 적용할 때에야
  // bad_settings로 거절한다. 그래서 빈 문서를 적용해 보고 그 사유로 가른다(환경 이름만 따로 먼저 본다).
  const settingsRejected = (settings: { environment: string; targets: unknown }) => {
    try {
      const probe = RegistryState.start(settings as never).apply({ kind: "content", content: new Uint8Array() });
      return probe.kind === "rejected" && probe.reason === "bad_settings";
    } catch {
      return true;
    }
  };
  if (settingsRejected({ environment: registry.environment, targets: [] })) return invalid("OLIVE_ENVIRONMENT");
  if (settingsRejected(registry)) return invalid("OLIVE_TARGETS");
  const policyRevision = value("OLIVE_POLICY_REVISION");
  if (!REVISION.test(policyRevision)) return invalid("OLIVE_POLICY_REVISION");
  const testJobs = env.OLIVE_TEST_JOBS ?? "";
  if (testJobs !== "" && testJobs !== "on" && testJobs !== "off") return invalid("OLIVE_TEST_JOBS");
  const testFrontDoor = env.OLIVE_TEST_FRONTDOOR ?? "";
  if (testFrontDoor !== "" && testFrontDoor !== "on" && testFrontDoor !== "off") return invalid("OLIVE_TEST_FRONTDOOR");
  if (testFrontDoor === "on" && testJobs !== "on") return invalid("OLIVE_TEST_FRONTDOOR");
  const frontDoor: FrontDoorChoice = testFrontDoor === "on" ? "test_double" : "absent";
  const tlsDir = value("OLIVE_TLS_DIR");
  const trustDir = value("OLIVE_TRUST_DIR");
  return {
    ok: true,
    settings: {
      listen: { host: LISTEN_HOST, port },
      files: {
        certificate: join(tlsDir, "tls.crt"),
        privateKey: join(tlsDir, "tls.key"),
        trustBundle: join(trustDir, "ca-bundle.pem"),
        signingKey: join(value("OLIVE_SIGNING_KEY_DIR"), SIGNING_KEY_FILE),
        registry: value("OLIVE_REGISTRY_FILE"),
      },
      ledgerPath: join(value("OLIVE_LEDGER_DIR"), LEDGER_FILE),
      resultDir: value("OLIVE_RESULT_DIR"),
      // 판단의 기록은 [4바이트][머리][본문 ≤ RESULT_MAX_BYTES]다. 머리에 넉넉한 여유를 둔다.
      maxResultRecordBytes: limits.RESULT_MAX_BYTES + 4_096,
      registry,
      otherPeers: OTHER_PEERS,
      expectedPolicyRevision: policyRevision,
      credentials: {
        dir: value("OLIVE_ACCOUNTS_DIR"),
        keys: { subscription: "CLAUDE_CODE_OAUTH_TOKEN" },
        maxBytes: CREDENTIAL_MAX_BYTES,
        // 자격 revision의 출처(계정 Secret의 판)가 정해지기 전이라 모름이다. 모르면 새 자격 참조를 만들지 않는다(credential-ref.md).
        // 이미 접수된 실행의 값 송신(borrowCredentialValue)은 revision을 보지 않고 계정·방식·지문과 실행 상태·접수 문으로 판단한다.
        revisionOf: () => null,
      },
      // 배정 정책은 닫힌 값이다. 등록행·계정·실행 계획이 없어 후보가 없고 시작하지 않는다(역할 프로필 조각 전까지).
      // 접수 출처는 시험 현관 대역일 때만 그 대역의 출처 하나를 관리자 요청으로 본다(D-109). 그 밖은 늘 모름이라 입력의 일을 보류한다.
      assign: {
        assignment: { allowed: targets.map((t) => ({ target: t.target, roles: t.roles })), registrations: [], expected: { profile_revision: "", policy_revision: policyRevision } },
        accounts: [],
        plans: [],
        queue: { alertMaxWaitMs: 60_000, requestBudget: { admin: 0, alert: 0 } },
        originOf: frontDoor === "test_double" ? testOriginOf : () => undefined,
      },
      life: LIFE,
      resultCheck: RESULT_CHECK,
      cycle: CYCLE,
      connection: {},
      // 같은 박자에 한 연결로 나가는 ack·지시·자격 값 틀 하나씩과 여유 하나.
      maxPendingWriteBytes: limits.MAX_MESSAGE_BYTES * 4,
      timing: TIMING,
      testJobs: testJobs === "on",
    },
    frontDoor,
  };
}

// 현관(O08) 전의 현관 포트. 모두 모름(던짐)이라 복원 1단계가 실패하고 감독은 닫힌 채 듣는다(D-76). "기록 없음"을 지어내지 않는다.
const absent = () => Promise.reject(new Error("front_door_absent"));
const ABSENT_FRONT_DOOR: FrontDoorPorts = { stopAuthority: { latestStop: absent }, publications: { lookup: absent }, peers: { contracts: absent } };

// 조립에 넘길 현관 포트. 시험 현관 대역은 settingsFromEnv가 시험 값에서만 test_double을 낸다.
export function frontDoorFor(choice: FrontDoorChoice): FrontDoorPorts {
  return choice === "test_double" ? testFrontDoorPorts() : ABSENT_FRONT_DOOR;
}

const format = (event: string, fields?: LogFields) =>
  [event, ...Object.entries(fields ?? {}).map(([key, item]) => `${key}=${item === null ? "-" : String(item)}`)].join(" ");

const productionDeps: SupervisorDeps = {
  readFile: (path) => readFile(path),
  openLedger,
  createResultBackend: createFileResultBackend,
  startServer: startConnectionServer,
  credentialFiles: nodeCredentialFiles,
  frontDoor: ABSENT_FRONT_DOOR,
  wallNow: Date.now,
  monoNow: () => performance.now(),
  setTimer: (ms, fire) => {
    const handle = setTimeout(fire, ms);
    return () => clearTimeout(handle);
  },
  random: { bytes: (length) => getRandomValues(new Uint8Array(length)) },
  log: (event, fields) => console.error(`olive supervisor: ${format(event, fields)}`),
};

// 관리 소켓 경로의 파일 조작. 링크를 따라가지 않는다(lstat).
export const adminFs: AdminFs = {
  kind: (path) => {
    try {
      return lstatSync(path).isSocket() ? "socket" : "other";
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return "absent";
      throw error;
    }
  },
  unlink: (path) => unlinkSync(path),
  chmod: (path, mode) => chmodSync(path, mode),
};

// 관리 통로(D-60·D-101)를 듣는다. 듣지 못해도 감독은 계속 돈다: 감독의 일은 관리 통로에 기대지 않고, 상태 조회는 "감독에 닿지 못함(모름)"으로
// 남는다(시험 작업도 넣지 못한다). 사유는 기록에 남긴다. 시험 작업 넣기가 켜졌는지는 듣기 시작 기록에 남긴다.
function startAdmin(running: RunningSupervisor): AdminListening | null {
  const handlers = createAdminHandlers(running.admin, running.testJob);
  try {
    const listening = listenAdmin({
      path: ADMIN_SOCKET_PATH,
      mode: ADMIN_SOCKET_MODE,
      fs: adminFs,
      monoNow: productionDeps.monoNow,
      setTimer: productionDeps.setTimer,
      answer: (line, limit) => answerLine(line, handlers, limit),
      note: (note) => productionDeps.log("admin", { note }),
    });
    productionDeps.log("admin_listening", { testJobs: running.testJob !== null });
    return listening;
  } catch (error) {
    productionDeps.log("admin_listen_failed", { reason: error instanceof AdminListenRefused ? error.reason : "threw" });
    return null;
  }
}

async function main(): Promise<never> {
  // 신호 처리기는 무엇보다 먼저 건다. 함정: 이 프로세스가 컨테이너의 PID 1이면 커널은 처리기가 없는 신호를 버린다(SIGKILL 제외).
  // 기동 중의 신호는 기동을 멈추고(서버를 열었으면 닫고) 0으로, 기동 뒤의 신호는 끝 차례를 밟는다.
  const stop = new AbortController();
  let running: RunningSupervisor | undefined;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (running === undefined) stop.abort();
      else void running.stop();
    });
  }
  // 끝 차례 밖에서 빠진 예외는 상태를 모르므로 끝 차례를 밟지 않고 97로 끝낸다. 메시지는 싣지 않는다(무엇이 실렸는지 모른다).
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    process.on(event, (error: unknown) => {
      console.error(`olive supervisor: ${event} ${error instanceof Error ? error.name : typeof error}`);
      process.exit(SUPERVISOR_EXIT.uncaught);
    });
  }
  const parsed = settingsFromEnv(process.env);
  if (!parsed.ok) {
    console.error(`olive supervisor ${pkg.version}: 환경 ${parsed.name}이(가) ${parsed.problem === "missing" ? "없다" : "틀렸다"}`);
    process.exit(SUPERVISOR_EXIT.config);
  }
  // 시험 현관 대역이면 기록에 먼저 남긴다: 이 감독의 정지 아님 기록·이웃 행·소유자 입력이 지어낸 값이라는 것을 기록만 보고도 알게.
  productionDeps.log("front_door", { mode: parsed.frontDoor });
  const started = await bootSupervisor(parsed.settings, { ...productionDeps, frontDoor: frontDoorFor(parsed.frontDoor) }, stop.signal);
  if (!started.ok) {
    console.error(`olive supervisor ${pkg.version}: 기동 단계 ${started.step}에서 멈췄다(${started.reason})`);
    process.exit(started.code);
  }
  running = started.running;
  // 복원 전에도 듣는다: 그때의 상태 조회는 "복원 전 모름"으로 답한다.
  const admin = startAdmin(running);
  // 조립의 마지막 멈춤 확인과 이 줄 사이에 온 신호는 위 처리기가 abort만 했다. 여기서 끝 차례로 잇는다.
  if (stop.signal.aborted) void running.stop();
  const code = await running.done;
  admin?.stop();
  process.exit(code);
}

if (import.meta.main) await main();
