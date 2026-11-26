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
import { accountFromEnv, accountRevisionFromEnv, assignmentFrom, type ProfileUse, profileRevisionsFromEnv } from "../supervisor/runtime/assign-policy.ts";
import { testAssignPolicy } from "../supervisor/runtime/test-assign.ts";
import { RENEW_MARGIN_MS } from "../supervisor/scheduler/lifecycle.ts";
import { createFileResultBackend } from "../supervisor/scheduler/result-store-file.ts";
import { RegistryState, type RegistryTarget } from "../supervisor/transport/registry.ts";
import { startConnectionServer } from "../supervisor/transport/server.ts";
import { CREDENTIAL_MAX_BYTES } from "../transport/framing.ts";
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
// OLIVE_ACCOUNT_NAME: 고정 계정의 별칭(D-126, 계정 Secret을 붙이는 차트 값 supervisor.account.name을 같이 렌더한다). 계정 폴더 이름 꼴이다.
// 없거나 빈 값이면 계정이 없어 배정이 no_account로 보류하고 자격 파일을 읽지 않는다. 별칭과 판이 함께 있어야 자격 참조가 생긴다.
// OLIVE_ACCOUNT_REVISION: 고정 계정 자격의 판(D-111, 차트 값 하나를 사람 PR이 계정 Secret과 함께 올린다). v1 revision 꼴이다.
// OLIVE_PROFILE_REVISIONS: 역할별 기대 프로필 revision의 JSON 객체 { "<v1 역할>": "<revision>" }(역할 프로필 차트가 렌더한다).
// 세 값은 없거나 빈 값이면 모름이고 배정은 채우기 전처럼 보류된다. 꼴이 틀리면 다른 이름처럼 91이다: 오타가 "값 없음"과 같은
// 보류로 조용히 남으면 켜는 사람이 원인을 찾지 못한다.
// OLIVE_TEST_JOBS: 시험 작업 넣기(D-98·D-101). "on"이면 켜고, 없거나 빈 값이나 "off"면 꺼짐이다. 그 밖의 값은 91: 오타가 조용히 켜짐·꺼짐으로
// 읽히지 않게. 운영 값에서 켜면 차트의 CI가 거절한다(차트 짝의 일, README "감독 관리 통로"). "on"이면 시험 배정 값(runtime/test-assign.ts)도 쓴다.
// OLIVE_TEST_FRONTDOOR: 시험 현관 대역(D-109). 값의 규칙은 OLIVE_TEST_JOBS와 같고, 더해 "on"은 OLIVE_TEST_JOBS도 "on"일 때만 받는다.
// 감독이 아는 "시험 값"의 표시는 OLIVE_TEST_JOBS=on 하나뿐이라(운영 값에서 그 값을 거절할 차트 CI는 뒤 homelab PR의 일이고 아직 없다) 그것 없이 켜면 운영 값으로 보고 91이다.
export const SUPERVISOR_OPTIONAL_ENV = ["OLIVE_ACCOUNT_NAME", "OLIVE_ACCOUNT_REVISION", "OLIVE_PROFILE_REVISIONS", "OLIVE_TEST_JOBS", "OLIVE_TEST_FRONTDOOR"] as const;

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
const CYCLE: SupervisorSettings["cycle"] = { judgeMs: limits.DISCONNECT_JUDGE_MS, resendEveryMs: 5_000, assignCallsPerBeat: 4 };

// 계약 v1 hello의 revision 칸 꼴(contract/v1/schema.ts의 REVISION과 같다). 계약은 index.ts로만 import하므로 같은 꼴을 여기 둔다.
// 꼴이 틀린 값으로 뜨면 모든 실행기의 정책 대조가 mismatch가 되어 접수가 늘 닫힌다.
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// frontDoor: 진입점이 조립에 넘길 현관 포트. absent(현관 전, 늘 모름)가 기본이고 test_double은 시험 현관 대역이다(frontDoorFor).
// assignInputs: 배정 정책에 채운 배포 값의 요약(값은 싣지 않는다). 진입점이 기동 기록에 남긴다.
export type EnvResult =
  | { readonly ok: true; readonly settings: SupervisorSettings; readonly frontDoor: FrontDoorChoice; readonly assignInputs: AssignInputs }
  | { readonly ok: false; readonly name: string; readonly problem: "missing" | "invalid" };
export type FrontDoorChoice = "absent" | "test_double";
export interface AssignInputs {
  readonly accountRevision: boolean;
  readonly profileRevisions: ProfileUse;
}

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
  const account = accountFromEnv(env.OLIVE_ACCOUNT_NAME);
  if (!account.ok) return invalid("OLIVE_ACCOUNT_NAME");
  const accountRevision = accountRevisionFromEnv(env.OLIVE_ACCOUNT_REVISION);
  if (!accountRevision.ok) return invalid("OLIVE_ACCOUNT_REVISION");
  const profileRevisions = profileRevisionsFromEnv(env.OLIVE_PROFILE_REVISIONS);
  if (!profileRevisions.ok) return invalid("OLIVE_PROFILE_REVISIONS");
  const testJobs = env.OLIVE_TEST_JOBS ?? "";
  if (testJobs !== "" && testJobs !== "on" && testJobs !== "off") return invalid("OLIVE_TEST_JOBS");
  const testFrontDoor = env.OLIVE_TEST_FRONTDOOR ?? "";
  if (testFrontDoor !== "" && testFrontDoor !== "on" && testFrontDoor !== "off") return invalid("OLIVE_TEST_FRONTDOOR");
  if (testFrontDoor === "on" && testJobs !== "on") return invalid("OLIVE_TEST_FRONTDOOR");
  const frontDoor: FrontDoorChoice = testFrontDoor === "on" ? "test_double" : "absent";
  // 시험 배정 값(O-D)은 시험 작업 넣기와 같은 시험 값에서만 쓴다. 운영 값에서는 null이고 실행 계획 없음·요청 한도 0·사실 모름이다.
  const testAssign = testJobs === "on" ? testAssignPolicy() : null;
  const assignment = assignmentFrom(targets, profileRevisions.value, policyRevision);
  const revision = accountRevision.value;
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
        // 고정 계정 하나의 자격 판(D-111). 없으면 모름이고 새 자격 참조를 만들지 않는다(credential-ref.md). 계정·방식을 가리지 않는 것은
        // 배정이 묻는 계정이 selectAccount가 고른 하나뿐이기 때문이다(둘 이상이면 고르지 않는다). 계정별 판이 필요해지면(O17) 원천을 새로 정한다.
        // 이미 접수된 실행의 값 송신(borrowCredentialValue)은 revision을 보지 않고 계정·방식·지문과 실행 상태·접수 문으로 판단한다.
        revisionOf: () => revision,
      },
      // 배정 정책. 허용 표와 기대 revision은 대상 표·역할별 기대 프로필 revision에서(runtime/assign-policy.ts의 assignmentFrom), 등록행은
      // 조립이 적용한 등록표에서 채운다(여기서는 비운다). 계정은 별칭 env 하나에서 고정 계정 하나다(D-126). 별칭이 없으면 비어 있고
      // 고르기가 no_account로 보류하며 자격 참조를 묻지 않는다. 별칭만 있고 판이 없으면 자격 참조는 파일을 열기 전에 모름이다.
      // 실행 계획·요청 한도는 시험 값에서만 시험 숫자(runtime/test-assign.ts)이고, 배정 전 사실은 같은 시험 값에서만 조립이 시험 공급자로 채운다(testAssign).
      // 운영 값에서는 셋 다 비어 있다: 요청 한도 0은 planNext가 거절해 박자가 policy_rejected로 끝난다.
      // 접수 출처는 시험 현관 대역일 때만 그 대역의 출처 하나를 관리자 요청으로 본다(D-109). 그 밖은 늘 모름이라 입력의 일을 보류한다.
      assign: {
        assignment: assignment.context,
        accounts: account.value === null ? [] : [account.value],
        plans: testAssign === null ? [] : testAssign.plans,
        queue: { alertMaxWaitMs: 60_000, requestBudget: testAssign === null ? { admin: 0, alert: 0 } : testAssign.requestBudget },
        originOf: frontDoor === "test_double" ? testOriginOf : () => undefined,
      },
      life: LIFE,
      cycle: CYCLE,
      connection: {},
      // 같은 박자에 한 연결로 나가는 ack·지시·자격 값 틀 하나씩과 여유 하나.
      maxPendingWriteBytes: limits.MAX_MESSAGE_BYTES * 4,
      timing: TIMING,
      testJobs: testJobs === "on",
      testAssign: testAssign !== null,
    },
    frontDoor,
    assignInputs: { accountRevision: revision !== null, profileRevisions: assignment.profile },
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
  // 배정에 채운 배포 값의 요약. 값 없이 켜져 배정이 늘 보류되는 것을 기록만 보고도 알게.
  productionDeps.log("assign_inputs", { accountRevision: parsed.assignInputs.accountRevision, profileRevisions: parsed.assignInputs.profileRevisions, accounts: parsed.settings.assign.accounts.length });
  // 시험 배정 값의 요약. 운영 값이면 mode=off·실행 계획 0·요청 한도 0이고 배정 전 사실은 모두 모름이다(README "시험 배정 값").
  const { plans, queue } = parsed.settings.assign;
  productionDeps.log("test_assign", { mode: parsed.settings.testAssign === true ? "on" : "off", plans: plans.length, requestBudget: `admin:${queue.requestBudget.admin},alert:${queue.requestBudget.alert}` });
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
