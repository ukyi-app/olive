// 감독 프로세스의 조립. 재료 → 등록표 → 장부·복원기 → 순서기·서버·발급·내보내기 포트·답 줄 → 주기의 차례로 띄우고,
// 끝낼 때 "발급 닫기 → 서버 닫기 → 장부 닫기" 차례를 밟는다. 설명 문서는 boot.md다.
// 환경을 읽지 않는다. 실제 파일·장부 열기·서버 시작·시계·타이머·난수는 진입점(src/main/supervisor.ts)이 포트로 넘긴다.
//
// 이 파일이 지키는 것:
// 1. 프로세스 하나 = 장부 열기 하나 = 공유 시계 하나 = 복원기 하나 = 서버 하나 = 순서기 하나. 다시 열거나 바꿔 끼우지 않는다.
//    장부를 쓸 수 없게 됐거나, 낸 접수 허가가 버려졌거나, 박자·복원 단계가 기한을 넘기거나 거부되면 끝 차례를 밟고 96으로 끝내
//    재시작(새 장부 열기·새 복원기)에 맡긴다.
// 2. 연결을 받기 전에 거를 것(재료, 등록표, 장부, 결과 폴더, 순서기 정책)은 서버를 시작하기 전에 거른다. 서버를 연 뒤의 실패는
//    서버를 닫고 장부를 닫은 뒤에 코드를 돌려준다.
// 3. 서버가 돌려준 뒤의 같은 동기 구간에서 발급·내보내기 포트·답 줄을 만든다. 그 전의 deliver는 던져 그 연결을 닫는다(받지 않는다).
// 4. 복원 단계는 주기마다 하나씩 부르고(이미 도는 단계가 있으면 부르지 않는다), 받아들인 단계만 센다. 순서기는 5단계를, 답 줄과
//    D-90 박자는 2단계를 받아들인 뒤에만 연다.
// 5. 기한이 있는 기다림은 일을 부르기 전에 절대 기한을 정하고(runBy), 결과를 받아들이는 순간의 단조 시각으로 판정한다(waitUntil).
//    일의 동기 비용도 기한 안에 든다. 정각 이후면 타이머보다 먼저 처리된 결과여도 만료다. 현관 답은 복원기에 넘기기 전에 단계 기한을 본다.
// 6. 효과의 문은 둘이다. 박자 유효 문(effectsOpen): 끝 코드가 정해졌거나, 진행 중인 박자의 기한이 지났거나, 장부를 쓸 수 없거나,
//    받아들인 허가가 사라졌거나 받아들이지 않은 허가가 있으면 닫힘이다. 접수 문(intake): 박자 유효 문에 복원기의 접수를 더한다.
//    기존 실행의 정리(종료·조회·끊김·D-90·재전송)는 박자 유효 문만, 새 일(접수·시작·갱신·자격 값)과 결과 판정은 접수 문을 본다. D-90의 새 인사
//    닫기(연결 하나 닫기)는 발급 깃발과 박자 유효 문을 함께 본다(서버는 발급 깃발을 모른다). 박자 여섯은
//    장부에 쓰기 직전(마지막 외부 호출 뒤의 같은 동기 구간)에 박자 유효 문을 다시 본다(beatValid 포트).
import { executorName, parsePrincipal, type Role } from "../../contract/v1/index.ts";
import {
  type InputRecord,
  type Ledger,
  type OpenOptions,
  type OpenResult,
  type PeerContractAnswer,
  type PublicationPort,
  type RestorePorts,
  Restorer,
  RestoreStepError,
  type StopAuthorityPort,
} from "../../ledger/index.ts";
import { type CredentialFiles, type CredentialRefPolicy, credentialPort } from "../accounts/credential-ref.ts";
import { type AssignLoopPolicy, assignAndStartTick, type CandidateSource, type FactSource } from "../dispatch/assign-loop.ts";
import type { CancelDelivery } from "../dispatch/cancel.ts";
import { lifeTick } from "../dispatch/life-loop.ts";
import { linkLossTick } from "../dispatch/link-loss.ts";
import type { Random } from "../dispatch/ports.ts";
import type { AnswerSettlement, LedgerAlarm } from "../dispatch/receipts.ts";
import { resendTick } from "../dispatch/resend.ts";
import { checkingRunIds, createResultWaitAlarm, createStoppedAnswerBook, RESULT_WAIT_ALERT_MS, type ResultCheckTickResult, resultCheckTick } from "../dispatch/result-check.ts";
import { createRehelloMemory, type UnreceivedRehello, type UnreceivedTickResult, unreceivedTick } from "../dispatch/unreceived.ts";
import type { LifecyclePolicy } from "../scheduler/lifecycle.ts";
import type { FileBackendAnswer, FileBackendOptions } from "../scheduler/result-store-file.ts";
import type { ToolConfig, ToolPolicyPort, ToolPorts } from "../scheduler/tools.ts";
import type { ConnectionSettings } from "../transport/connections.ts";
import { RegistryState, type RegistrySettings } from "../transport/registry.ts";
import type { ConnectionServer, ConnectionServerOptions, Delivered, StartResult } from "../transport/server.ts";
import { type AnswerLines, type AnswerNote, createAnswerEvidenceBook, createAnswerLines } from "./answers.ts";
import { registrationsFrom } from "./assign-policy.ts";
import { testFactSource } from "./test-assign.ts";
import { type BeatReport, type Cycle, type CycleBeats, type CyclePolicy, createCycle, type Step } from "./cycle.ts";
import { createIssuance, type Issuance } from "./issuance.ts";
import { createPeers, type FrontPeers } from "./peers.ts";
import { createQueryBook, createResultWaitQueries } from "./query-book.ts";
import { createSharedClock, type PeekableClock } from "./shared-clock.ts";
import { createSigning, SigningKeyError, type SupervisorSigning } from "./signer.ts";
import { createWireSink, type WireSink } from "./sink.ts";
import { createToolPorts } from "./tools-adapter.ts";
import type { AdminSources } from "../admin/status.ts";
import type { TestJobPorts } from "../admin/test-job.ts";

// 종료 코드. 0은 요청된 멈춤(SIGTERM 등)을 끝 차례까지 마쳤을 때뿐이다. 64·69는 이미지의 다른 진입점, 81~89는 작업자 실행기가 쓴다.
export const SUPERVISOR_EXIT = {
  // 진입점: 환경이 없거나 꼴이 틀렸다. 조립의 설정 값이 틀린 것도 여기다.
  config: 91,
  // TLS 인증서·키, 신뢰 묶음, 서명 개인 키를 읽지 못했거나 비었거나 꼴이 틀렸다.
  material: 92,
  // 등록표 파일을 읽지 못했거나 적용이 거절됐다(환경 이름 불일치 포함).
  registry: 93,
  // 장부를 열지 못했거나(not_initialized 포함, 첫 설치로 넘어가지 않는다) 결과 보관 폴더가 틀렸거나 복원기를 만들지 못했다.
  ledger: 94,
  // 순서기 정책이 범위 밖이거나 서버를 시작하지 못했거나 조립 생성자가 던졌다.
  server: 95,
  // 띄운 뒤 끝 차례를 밟아 끝냈다(장부 고장, 허가 폐기, 박자·복원 단계의 거부·기한 넘김, 끝 차례의 실패).
  fatal: 96,
  // 끝 차례를 밟지 못하고 끝났다(처리하지 않은 거부·예외). 진입점만 쓴다.
  uncaught: 97,
} as const;

export type BootStep = "config" | "material" | "registry" | "ledger" | "server" | "aborted";

// 현관 조각(O08)이 채울 포트. 현관이 없으면 셋 다 던져(모름) 복원 1단계가 실패하고 감독은 닫힌 채 듣는다(D-76).
export interface FrontDoorPorts {
  readonly stopAuthority: StopAuthorityPort;
  readonly publications: PublicationPort;
  readonly peers: FrontPeers;
  // 시험 현관 대역(D-109, frontdoor/test-double.ts)만 채운다. 받은 시각(장부 시계)으로 장부에 넣을 시험 소유자 입력 하나를 만든다.
  // 없으면(운영) 조립은 이 자리에서 아무것도 읽지 않는다. 넣는 차례는 아래 admitTestInput이다.
  readonly testInput?: (receivedAt: number) => InputRecord;
}

export interface SupervisorTiming {
  // 주기. 박자가 끝난 뒤 이만큼 쉬고 다음 박자를 부른다. 수명 박자가 갱신 구간(기본 7000ms) 안에서 여러 번 돌 만큼 짧게.
  readonly beatEveryMs: number;
  // 박자 하나의 기한. 넘기면 96(박자는 멈출 수 없으므로 끝 차례도 그 박자를 기한까지만 기다린다).
  readonly beatWaitMs: number;
  // 복원 단계 하나의 기한. 넘기면 96(복원기는 그 단계를 쥔 채라 같은 복원기로 다시 부를 수 없다).
  readonly restoreStepWaitMs: number;
  // 기동의 기다림(파일 읽기 하나, 서버 시작) 하나의 기한.
  readonly startupWaitMs: number;
  // 끝 차례(issuance.shutdown)의 기한. 넘기면 96.
  readonly stopWaitMs: number;
}

export interface SupervisorSettings {
  readonly listen: { readonly host: string; readonly port: number };
  readonly files: { readonly certificate: string; readonly privateKey: string; readonly trustBundle: string; readonly signingKey: string; readonly registry: string };
  readonly ledgerPath: string;
  readonly resultDir: string;
  readonly maxResultRecordBytes: number;
  readonly registry: RegistrySettings;
  // 실행기 밖의 필수 이웃(현관, 관측 중계). 등록표의 활성 실행기와 합쳐 복원기의 requiredPeers가 된다.
  readonly otherPeers: readonly string[];
  // 실행기의 인사에서 기대하는 정책 revision. 복원 2단계의 정책 대조에 쓴다.
  readonly expectedPolicyRevision: string;
  readonly credentials: CredentialRefPolicy;
  readonly assign: AssignLoopPolicy;
  readonly life: LifecyclePolicy;
  readonly cycle: CyclePolicy;
  readonly connection: ConnectionSettings;
  readonly maxPendingWriteBytes: number;
  readonly timing: SupervisorTiming;
  // 시험 작업 넣기(D-98·D-101). 참일 때만 관리 통로에 장부 쓰기 포트를 만든다. 없으면 꺼짐이다. 운영 값에서는 켜지 않는다(README "감독 관리 통로").
  readonly testJobs?: boolean;
  // 시험 배정 값(O-D). 참일 때만 배정 전 사실을 시험 공급자(test-assign.ts)로 채운다. 없으면 사실은 모두 모름이다. 운영 값에서는 켜지 않는다
  // (README "시험 배정 값"). 실행 계획·요청 한도는 assign 칸에 진입점이 넣는다.
  readonly testAssign?: boolean;
  // 결과 기다림 경보(D-151)의 한도(ms, 양의 정수). checking에 이만큼 머문 실행마다 감독 로그에 경보 한 줄을 남긴다. 판정은 하지 않는다.
  // 없으면 잠정 기본값 RESULT_WAIT_ALERT_MS다(T1 다음 바퀴 실측 뒤 정한다).
  readonly resultWaitAlertMs?: number;
}

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

// 박자 여섯의 함수. 시험이 각 박자에 넘긴 포트(박자 유효 문)를 보려고 바꿔 끼운다.
export interface BeatTicks {
  readonly linkLoss: typeof linkLossTick;
  readonly resultCheck: typeof resultCheckTick;
  readonly life: typeof lifeTick;
  readonly resend: typeof resendTick;
  readonly unreceived: typeof unreceivedTick;
  readonly assign: typeof assignAndStartTick;
}

// 같은 객체가 넘어가는지 시험이 보려고 바꿔 끼우는 생성자. 운영은 넘기지 않는다(기본값이 실제 생성자다).
export interface SupervisorMakers {
  readonly sharedClock: typeof createSharedClock;
  readonly restorer: (ledger: Ledger, ports: RestorePorts, clock: () => number, requiredPeers: readonly string[]) => Restorer;
  readonly cycle: typeof createCycle;
  readonly queries: typeof createQueryBook;
  readonly issuance: typeof createIssuance;
  readonly sink: typeof createWireSink;
  readonly lines: typeof createAnswerLines;
  readonly ticks: BeatTicks;
}

const MAKERS: SupervisorMakers = {
  sharedClock: createSharedClock,
  restorer: (ledger, ports, clock, requiredPeers) => new Restorer(ledger, ports, clock, { requiredPeers }),
  cycle: createCycle,
  queries: createQueryBook,
  issuance: createIssuance,
  sink: createWireSink,
  lines: createAnswerLines,
  ticks: { linkLoss: linkLossTick, resultCheck: resultCheckTick, life: lifeTick, resend: resendTick, unreceived: unreceivedTick, assign: assignAndStartTick },
};

export interface SupervisorDeps {
  // 파일 하나를 바이트로 읽는다(재료·등록표).
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly openLedger: (path: string, options: OpenOptions) => OpenResult;
  readonly createResultBackend: (options: FileBackendOptions) => FileBackendAnswer;
  readonly startServer: (options: ConnectionServerOptions) => Promise<StartResult>;
  readonly credentialFiles: CredentialFiles;
  readonly frontDoor: FrontDoorPorts;
  // 장부 시계의 원천(Unix epoch 밀리초). 이 파일이 공유 시계로 한 번 감싸 모든 소비자에 넘긴다.
  readonly wallNow: () => number;
  // 기다림의 기한과 끊김 판정을 재는 단조 시계(밀리초).
  readonly monoNow: () => number;
  // ms 뒤에 fire를 한 번 부른다. 돌려준 함수는 취소다. monoNow와 같은 시간 기준이어야 한다.
  readonly setTimer: (ms: number, fire: () => void) => () => void;
  // CSPRNG. 요청 ID·nonce·실행 ID가 모두 여기서 온다.
  readonly random: Random;
  // 한 줄 기록. 값·자격·봉투 본문을 싣지 않는다(이름·수·사유뿐). 던져도 무시한다.
  readonly log: (event: string, fields?: LogFields) => void;
  readonly make?: Partial<SupervisorMakers>;
}

export interface RunningSupervisor {
  // 끝 차례를 시작한다. 몇 번 불러도 같은 약속이다. 돌려주는 값은 done과 같다.
  stop(): Promise<number>;
  // 끝 차례가 끝난 뒤의 코드(0 또는 96).
  readonly done: Promise<number>;
  // 도구 처리기(scheduler/tools.ts)에 넘길 포트를 이 프로세스의 같은 장부·공유 시계·CSPRNG·연결 문·내보내기 포트로 만든다.
  // 처리기를 부르는 길(본체 도구 호출이 감독에 닿는 길)은 아직 없다. 그 조각은 이것만 쓰고, 처리기 문맥의 now도 여기의 now로 읽고,
  // 처리기 호출을 박자와 겹치지 않게 부른다.
  tools(policy: ToolPolicyPort, config: ToolConfig, observe: (event: CancelDelivery) => void): { readonly ports: ToolPorts; readonly now: () => number };
  // 관리 통로(src/supervisor/admin/)의 읽기 포트. 조립 상태, 복원기의 부작용 없는 상태 읽기, 공유 시계의 peek만 담는다(쓰기·송신·래치·하한 갱신 없음).
  readonly admin: AdminSources;
  // 관리 통로의 시험 작업 넣기 포트(장부 쓰기 recordToolRequest 하나와 그 문). 설정(testJobs)이 켜졌을 때만 있고, 꺼져 있으면 null이다.
  readonly testJob: TestJobPorts | null;
}

export type BootResult = { readonly ok: true; readonly running: RunningSupervisor } | { readonly ok: false; readonly step: BootStep; readonly code: number; readonly reason: string };

export type Waited<T> =
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "failed"; readonly error: unknown }
  // 기한 정각 이후에 받아들였다(결과가 먼저 왔든 타이머가 먼저 왔든).
  | { readonly kind: "lapsed" }
  // 상한 타이머를 걸지 못했다.
  | { readonly kind: "unarmed" }
  | { readonly kind: "aborted" };

type Clocks = Pick<SupervisorDeps, "monoNow" | "setTimer">;

// 시각을 읽지 못하면 기한이 지난 것으로 본다(모름을 시간이 남은 것으로 읽지 않는다).
const pastLimit = (clocks: Clocks, limit: number): boolean => {
  try {
    const at = clocks.monoNow();
    return !(Number.isFinite(at) && at < limit);
  } catch {
    return true;
  }
};

// 기한이 있는 기다림 하나. 결과를 받아들이는 순간(성공·실패 모두) 단조 시각을 다시 보고 정각 이후면 lapsed다. 상한 타이머는 깨우는
// 수단이라, 일찍 불리면 남은 시간만큼 다시 건다. 함정: 정각에 결과와 타이머가 같은 차례에 서면 이벤트 루프가 고른 쪽이 이긴다. 결과 쪽에서
// 시각을 보지 않으면 기한이 지난 결과로 다음 단계에 들어간다. 진행 중인 작업은 취소하지 않는다(늦게 끝난 결과는 버린다).
export function waitUntil<T>(work: Promise<T>, limit: number, clocks: Clocks, signal?: AbortSignal): Promise<Waited<T>> {
  return new Promise((resolve) => {
    let ended = false;
    let cancel: () => void = () => {};
    const end = (outcome: Waited<T>) => {
      if (ended) return;
      ended = true;
      resolve(outcome);
      try {
        cancel();
      } catch {
        // 취소하지 못한 타이머가 늦게 불려도 정해진 결과는 바뀌지 않는다.
      }
    };
    const accept = (outcome: Waited<T>) => end(pastLimit(clocks, limit) ? { kind: "lapsed" } : outcome);
    const arm = () => {
      let left: number;
      try {
        left = Math.max(1, Math.ceil(limit - clocks.monoNow()));
        if (!Number.isFinite(left)) throw new RangeError("clock");
      } catch {
        return end({ kind: "unarmed" });
      }
      try {
        cancel = clocks.setTimer(left, () => (pastLimit(clocks, limit) ? end({ kind: "lapsed" }) : arm()));
      } catch {
        end({ kind: "unarmed" });
      }
    };
    work.then(
      (value) => accept({ kind: "done", value }),
      (error: unknown) => accept({ kind: "failed", error }),
    );
    if (signal?.aborted) return end({ kind: "aborted" });
    signal?.addEventListener("abort", () => end({ kind: "aborted" }), { once: true });
    if (!ended) arm();
  });
}

// 복원 2단계를 부르기 전에 필수 실행기가 연결 표에 모이기를 기다리는 상한(D-142, kickRestore). 기다리는 것은 필수 실행기가 정확히
// 하나일 때뿐이다(D-143, peerWaitOver). 감독이 다시 뜨면 붙어 있던 실행기는 끊겼다가 재접속 간격(1초부터 두 배씩, src/main/executor.ts)에
// 맞춰 다시 붙는다. 2단계를 부른 순간의 표만 세면 곧 붙을 실행기를 빠진 이웃으로 닫고 그 프로세스 동안 접수가 닫힌 채 남는다. 기다리는
// 동안은 2단계 전이라 답 줄의 보류 해제·D-90·박자 여섯(기존 실행의 정지 지시·상태 조회)이 그만큼 늦으므로, 그 지연을 이 값으로 묶는다.
// 끝나면 모였든 아니든 2단계를 부르고 2단계는 자기 기한을 새로 받는다.
const PEER_WAIT_MS = 25_000;

const isExecutorPeer = (peer: string): boolean => {
  const kind = parsePrincipal(peer)?.kind;
  return kind === "worker_executor" || kind === "session_executor";
};

const isPositive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const TIMING_FIELDS = ["beatEveryMs", "beatWaitMs", "restoreStepWaitMs", "startupWaitMs", "stopWaitMs"] as const;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

// 등록표 문서의 활성 행을 실행기 이름으로. 적용(RegistryState.apply)이 받아들인 같은 바이트에서만 부른다.
function activeExecutors(content: Uint8Array): string[] {
  const doc = JSON.parse(UTF8.decode(content)) as { executors: { role: Role; instance: string; storage: string; active: boolean }[] };
  return doc.executors.filter((row) => row.active === true).map((row) => executorName(row.role, row.instance, row.storage));
}

// 박자 보고의 요약. 결과 객체(실행 ID·상태가 든다)를 그대로 싣지 않고 갈래 이름만 싣는다.
function summarize(report: BeatReport): LogFields {
  if (report.kind === "skipped") return { kind: "skipped", reason: report.reason };
  const step = (value: { kind: string; reason?: string }) => (value.kind === "skipped" ? `skipped:${value.reason}` : value.kind);
  return {
    kind: "ran",
    serverTick: report.serverTick,
    clock: report.clock,
    linkLoss: step(report.linkLoss),
    ...resultCheckFields(report.resultCheck),
    life: step(report.life),
    resend: step(report.resend),
    ...unreceivedFields(report.unreceived),
    assign: report.assign.map(step).join(","),
    rereads: report.rereads.length,
    rereadCauses: tally(report.rereads.map((item) => `${item.beat}:${item.cause}`)),
  };
}

// 이름별 건수를 "이름=수" 꼴로 정렬해 한 칸에 싣는다. 이름은 박자 결과의 정해진 갈래뿐이다(실행 ID·요청 ID를 싣지 않는다).
function tally(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, count]) => `${name}=${count}`).join(",");
}

// D-90 박자의 결과. 항목마다 닫힘·거절·건너뜀(사유)·장부 고장을 세고, 멈춘 이유를 따로 싣는다. M1a가 이 기록으로 닫았는지를 가른다.
function unreceivedFields(value: Step<UnreceivedTickResult>): LogFields {
  if (value.kind === "skipped") return { unreceived: `skipped:${value.reason}` };
  if (value.kind === "threw") return { unreceived: "threw" };
  const result = value.result;
  if (result.kind === "not_run") return { unreceived: `not_run:${result.reason}` };
  const names = result.runs.map((run) =>
    run.outcome === "skipped" || run.outcome === "refused" || run.outcome === "ledger_failed" ? `${run.outcome}:${run.reason}` : run.outcome === "rehello" ? `rehello:${run.result}` : run.outcome,
  );
  return { unreceived: "ran", unreceivedOutcomes: tally(names), unreceivedHalted: result.halted };
}

// 장부 경보 한 줄의 칸과 반복을 가르는 열쇠. 열쇠가 null이면 거르지 않는다.
type LedgerAlert = { readonly key: string | null; readonly fields: LogFields };

// 장부가 답에 실은 닫힌 실행의 경보(D-127·D-128)를 기록 한 줄씩의 칸으로 옮긴다. 꼴은 result_check_alert와 같은 reason·runId이고,
// 영수증은 delivery(new·duplicate), 실행기의 답은 coverage(상태 보고와 그 밀린 사본은 partial, 인사는 full)를 더한다.
// 열쇠는 영수증이면 (실행 ID, 영수증 ID), 답이면 (실행 ID, 경보 이름)이다. 영수증 ID는 열쇠에만 쓰고 줄에 싣지 않는다(boot.md S44).
// unreadable은 열쇠가 없다: 답의 경보는 실행 ID가 null이라 열쇠를 만들면 서로 다른 읽기 실패가 한 열쇠로 뭉쳐 뒤 줄을 삼킨다.
function ledgerAlerts(note: AnswerNote): LedgerAlert[] {
  const alert = (alarm: LedgerAlarm, part: string, extra: LogFields): LedgerAlert => ({
    key: alarm.alarm === "unreadable" ? null : JSON.stringify([alarm.runId, part]),
    fields: { reason: alarm.alarm, runId: alarm.runId, ...extra },
  });
  const answer = (alarm: LedgerAlarm, coverage: string): LedgerAlert => alert(alarm, `answer:${alarm.alarm}`, { coverage });
  const applied = (settled: readonly AnswerSettlement[]): LedgerAlert[] =>
    settled.flatMap((item) => (item.settled === "applied" ? (item.alarms ?? []).map((alarm) => answer(alarm, item.answer.coverage)) : []));
  if (note.kind === "receipt") {
    const outcome = note.outcome;
    if ((outcome.outcome === "ack" || outcome.outcome === "applied_without_ack") && outcome.alarm !== undefined) return [alert(outcome.alarm, `receipt:${outcome.id}`, { delivery: outcome.delivery })];
    return [];
  }
  if (note.kind === "status") return note.outcome.outcome === "status_matched" ? applied(note.outcome.settled) : [];
  if (note.kind === "backlog") return note.outcome.outcome === "backlog_settled" ? applied(note.outcome.settled) : [];
  if (note.kind === "hello") return note.outcome.kind === "applied" ? (note.outcome.alarms ?? []).map((alarm) => answer(alarm, "full")) : [];
  return [];
}

// 결과 검사 박자의 결과. 실행마다 판정·대기·충돌·거절·장부 고장을 세고, 멈춘 이유를 따로 싣는다.
function resultCheckFields(value: Step<ResultCheckTickResult>): LogFields {
  if (value.kind === "skipped") return { resultCheck: `skipped:${value.reason}` };
  if (value.kind === "threw") return { resultCheck: "threw" };
  const result = value.result;
  if (result.kind === "not_run") return { resultCheck: `not_run:${result.reason}` };
  const names = result.runs.map((run) => (run.outcome === "refused" || run.outcome === "ledger_failed" ? `${run.outcome}:${run.reason}` : run.outcome));
  return { resultCheck: "ran", resultCheckOutcomes: tally(names), resultCheckHalted: result.halted };
}

export async function bootSupervisor(settings: SupervisorSettings, deps: SupervisorDeps, signal: AbortSignal): Promise<BootResult> {
  const make: SupervisorMakers = { ...MAKERS, ...deps.make };
  const log = (event: string, fields?: LogFields) => {
    try {
      deps.log(event, fields);
    } catch {
      // 기록 실패는 기동·종료에 영향을 주지 않는다.
    }
  };
  const fail = (step: BootStep, code: number, reason: string): BootResult => {
    log("boot_failed", { step, code, reason });
    return { ok: false, step, code, reason };
  };
  const aborted = (reason: string): BootResult => fail("aborted", 0, reason);
  const timing = settings.timing;
  for (const field of TIMING_FIELDS) if (!isPositive(timing?.[field])) return fail("config", SUPERVISOR_EXIT.config, `timing.${field}`);
  // 결과 기다림 경보(D-151)의 한도. 틀린 값은 기동 전에 설정 오류로 끝낸다: 조용히 기본값으로 바꾸면 넣은 값이 쓰이지 않는다.
  const waitLimit: unknown = settings.resultWaitAlertMs ?? RESULT_WAIT_ALERT_MS;
  if (!isPositive(waitLimit)) return fail("config", SUPERVISOR_EXIT.config, "resultWaitAlertMs");
  const waitAlarm = createResultWaitAlarm(waitLimit);
  // 결과 없음 판정의 근거(실행기의 failed_stopped 답, D-147). 답 줄이 적고 결과 검사 박자가 읽는다. 프로세스에 하나다.
  const stoppedAnswers = createStoppedAnswerBook();
  // 이 박자가 결과 검사에 넘긴 시각. 박자 기록 뒤의 경보가 이 박자에 결과 검사가 불렸는가로만 읽고 비운다(watchResultWait).
  let judgedAt: number | null = null;
  // 기한은 일을 부르기 전에 정한다. 부른 뒤에 정하면 일의 동기 비용(파일 읽기, 장부 조회)이 상한에서 빠진다.
  const deadline = (waitMs: number): number | null => {
    try {
      const at = deps.monoNow();
      return Number.isFinite(at) ? at + waitMs : null;
    } catch {
      return null;
    }
  };
  // limit이 null이면(시각을 읽지 못함) 일을 부르지 않는다. 닫기처럼 반드시 불러야 하는 일은 NaN을 넘긴다: 부르되 unarmed로 끝난다.
  const runBy = <T>(limit: number | null, begin: () => Promise<T>, abort?: AbortSignal): Promise<Waited<T>> => {
    if (limit === null) return Promise.resolve({ kind: "unarmed" });
    let work: Promise<T>;
    try {
      work = begin();
    } catch (error) {
      work = Promise.reject(error);
    }
    return waitUntil(work, limit, deps, abort);
  };
  const bounded = <T>(begin: () => Promise<T>): Promise<Waited<T>> => runBy(deadline(timing.startupWaitMs), begin, signal);
  const readText = async (path: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
    const read = await bounded(() => deps.readFile(path));
    if (read.kind !== "done") return { ok: false, reason: read.kind === "failed" ? "unreadable" : read.kind };
    if (!(read.value instanceof Uint8Array) || read.value.length === 0) return { ok: false, reason: "empty" };
    try {
      return { ok: true, text: UTF8.decode(read.value) };
    } catch {
      return { ok: false, reason: "not_utf8" };
    }
  };

  // 2. 재료. 바이트로 한 번 읽어 넘긴다. 비었거나 읽지 못하면 소켓을 열기 전에 끝낸다.
  if (signal.aborted) return aborted("before_material");
  const texts: Record<"certificate" | "privateKey" | "trustBundle" | "signingKey", string> = { certificate: "", privateKey: "", trustBundle: "", signingKey: "" };
  for (const name of ["certificate", "privateKey", "trustBundle", "signingKey"] as const) {
    const read = await readText(settings.files[name]);
    if (signal.aborted) return aborted("material");
    if (!read.ok) return fail("material", SUPERVISOR_EXIT.material, `${name}:${read.reason}`);
    texts[name] = read.text;
  }
  let signing: SupervisorSigning;
  try {
    signing = createSigning(texts.signingKey, deps.random);
  } catch (error) {
    return fail("material", SUPERVISOR_EXIT.material, `signingKey:${error instanceof SigningKeyError ? error.reason : "unreadable"}`);
  }
  const material = { certificatePem: texts.certificate, privateKeyPem: texts.privateKey, trustBundlePem: texts.trustBundle };
  log("boot_step", { step: "material" });

  // 3. 등록표. 빈 판으로 뜨면 감독이 떴는데 아무도 붙지 못하는 상태가 조용히 남으므로 적용에 성공해야만 넘어간다.
  const registryRead = await bounded(() => deps.readFile(settings.files.registry));
  if (signal.aborted) return aborted("registry");
  if (registryRead.kind !== "done") return fail("registry", SUPERVISOR_EXIT.registry, registryRead.kind === "failed" ? "unreadable" : registryRead.kind);
  let registry: RegistryState;
  let requiredPeers: string[];
  try {
    const applied = RegistryState.start(settings.registry).apply({ kind: "content", content: registryRead.value });
    if (applied.kind !== "applied") return fail("registry", SUPERVISOR_EXIT.registry, applied.kind === "rejected" ? `rejected:${applied.reason}` : applied.kind);
    registry = applied.state;
    requiredPeers = [...settings.otherPeers, ...activeExecutors(registryRead.value)];
  } catch {
    return fail("registry", SUPERVISOR_EXIT.registry, "settings_or_document");
  }
  if (requiredPeers.length === 0 || new Set(requiredPeers).size !== requiredPeers.length) return fail("registry", SUPERVISOR_EXIT.registry, "required_peers");
  // 2단계 앞 기다림이 세는 실행기. 복원기가 전체 점유를 요구하는 이웃(requiredPeers 가운데 실행기 주체, restore.ts)과 같은 셈이다.
  const requiredExecutors = requiredPeers.filter(isExecutorPeer);
  log("boot_step", { step: "registry", requiredPeers: requiredPeers.length });
  // 배정의 등록행은 방금 적용한 같은 바이트와 그 상태에서만 만든다. 설정의 registrations 칸은 쓰지 않는다: 명단을 채우는 길은 적용 하나다(D-63).
  // 만들지 못하면 빈 목록이라 배정이 보류될 뿐 기동은 계속한다(assign-policy.ts). 등록표는 기동 때 한 번 읽으므로 프로세스 동안 같다.
  const assignPolicy: AssignLoopPolicy = {
    ...settings.assign,
    assignment: { ...settings.assign.assignment, registrations: registrationsFrom(registryRead.value, registry, settings.registry.targets) },
  };
  log("assign_policy", { registrations: assignPolicy.assignment.registrations.length });

  // 4. 공유 시계 하나, 장부 열기 하나(reopen만), 결과 보관, 복원기 하나(단계는 아직 부르지 않아 세대 null).
  if (signal.aborted) return aborted("ledger");
  const shared: PeekableClock = make.sharedClock({ now: () => deps.wallNow() });
  const ledgerClock = () => shared.now();
  let opened: OpenResult;
  try {
    opened = deps.openLedger(settings.ledgerPath, { clock: ledgerClock, mode: "reopen" });
  } catch {
    return fail("ledger", SUPERVISOR_EXIT.ledger, "open:threw");
  }
  if (!opened.ok) return fail("ledger", SUPERVISOR_EXIT.ledger, `open:${opened.reason}`);
  const ledger = opened.ledger;
  const closeLedger = (): boolean => {
    try {
      ledger.close();
      return true;
    } catch {
      return false;
    }
  };
  let backend: FileBackendAnswer;
  try {
    backend = deps.createResultBackend({ dir: settings.resultDir, maxRecordBytes: settings.maxResultRecordBytes });
  } catch {
    closeLedger();
    return fail("ledger", SUPERVISOR_EXIT.ledger, "result_dir:threw");
  }
  if (backend.status !== "ok") {
    closeLedger();
    return fail("ledger", SUPERVISOR_EXIT.ledger, `result_dir:${backend.reason}`);
  }
  // 서버는 아래에서 시작한다. 복원 포트 둘(이웃, 점유)은 2단계에서만 서버를 읽고, 2단계는 서버가 선 뒤의 주기에서만 부른다.
  let server: ConnectionServer | null = null;
  const table = () => {
    if (server === null) throw new Error("server_not_started");
    return server.table();
  };
  // 지금 도는 복원 단계의 절대 기한. 단계를 부르기 전에 정한다(kickRestore). 현관 답은 복원기가 장부에 반영하기 전에 이 기한을 본다:
  // 정각 이후의 답은 복원기에 모름(거부)으로 넘긴다. 4단계의 여러 게시도 이 기한 하나를 함께 쓴다(각자 새 기한을 얻지 않는다).
  let stepLimit: number | null = null;
  const inStep = <T>(ask: () => Promise<T>): Promise<T> => {
    const limit = stepLimit;
    if (limit === null || pastLimit(deps, limit)) return Promise.reject(new Error("restore_step_lapsed"));
    let pending: Promise<T>;
    try {
      pending = ask();
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve(pending).then((value) => {
      if (pastLimit(deps, limit)) throw new Error("restore_step_lapsed");
      return value;
    });
  };
  const front = deps.frontDoor;
  let restorer: Restorer;
  try {
    const ports: RestorePorts = {
      stopAuthority: { latestStop: () => inStep(() => front.stopAuthority.latestStop()) },
      publications: { lookup: (frontJobId) => inStep(() => front.publications.lookup(frontJobId)) },
      peers: createPeers({ front: { contracts: () => inStep(() => front.peers.contracts()) }, table, get restorer() { return restorer; }, expectedPolicy: settings.expectedPolicyRevision }),
      occupancy: { occupancy: async () => table().occupancy(restorer) },
    };
    restorer = make.restorer(ledger, ports, ledgerClock, requiredPeers);
  } catch {
    closeLedger();
    return fail("ledger", SUPERVISOR_EXIT.ledger, "restorer");
  }
  // 게시 함수는 늘 같은 복원기를 낸다. 서버·내보내기 포트·답 줄·발급·박자가 이 함수 하나를 함께 쓴다.
  const published = () => restorer;
  log("boot_step", { step: "ledger", migratedTo: opened.migrated.to });

  // 받아들인 복원 단계(0~5). 순서기는 5, 답 줄과 D-90 박자는 2 이상일 때만 연다.
  let stage = 0;
  const observationsSettled = () => stage >= 2;

  // 효과의 문. 끝 차례가 정한 코드, 진행 중인 박자의 절대 기한, 받아들인 5단계의 허가를 한 판단으로 본다.
  let stopping = false;
  let exitCode: number = 0;
  let granted = false;
  // 복원 단계를 불렀고 그 결과를 아직 받지 않았다(kickRestore).
  let restoring = false;
  let beatLimit: number | null = null;
  // 처음 본 끝낼 사유. 한 번 보면 다음 읽기가 정상이어도 풀지 않는다: 박자 안의 문이 본 사유(허가 읽기 한 번의 예외 등)를
  // 거짓 한 값으로만 쓰면 주기가 그 사유를 다시 보지 못하고 감독이 계속 돈다.
  let halted: string | null = null;
  // 5단계를 부른 뒤 그 결과를 받기 전에 장부에 이미 낸 허가. 닫힘이지만 끝낼 사유는 아니다: 5단계는 첫 호출 안에서 동기로 허가를 내고
  // 결과는 그 뒤의 마이크로태스크에 받으므로, 그 사이(같은 동기 구간의 서버 tick 등)에 문을 읽으면 이 상태다. 사유로 붙잡으면
  // 정상 기동이 96으로 끝난다. 결과를 기한 안에 받지 못하면 kickRestore가 따로 끝낸다.
  const PENDING = { pending: true } as const;
  // 장부 건강과 허가를 읽는다. 모름을 건강·닫힘으로 읽지 않는다: 장부 건강을 읽다 던지면 ledger_unwritable, 허가를 읽다 던지면
  // intake_unreadable이다. 후자는 처음부터 닫힌 판정(기존 실행의 정리를 허락)과 다르다: 허가가 있는지조차 모르므로 끝낸다.
  // 판정과 그 판정에서 읽은 허가(open)를 함께 낸다. 접수 문은 이 open을 쓰고 허가를 다시 읽지 않는다: 다시 읽으면 그 둘째 읽기의
  // 예외가 래치 밖에서 닫힌 접수로만 읽혀(배정 박자는 그냥 다음 주기로 간다) 감독이 계속 돈다.
  const look = (): { readonly seen: string | typeof PENDING | null; readonly open: boolean } => {
    if (halted !== null) return { seen: halted, open: false };
    let seen: string | typeof PENDING | null = null;
    let open = false;
    try {
      if (ledger.health().writable !== true) seen = "ledger_unwritable";
    } catch {
      seen = "ledger_unwritable";
    }
    if (seen === null) {
      try {
        open = restorer.intakeOpen() === true;
      } catch {
        seen = "intake_unreadable";
      }
    }
    // 받아들인 허가가 사라졌다(새 정지 기록, 장부 고장). 반대로 조립이 받아들이지 않은 허가(기한을 넘겨 끝난 5단계가 장부에 이미 낸 것)도
    // 소비자에게 보이지 않게 닫힘으로 본다.
    if (seen === null && granted && !open) seen = "intake_discarded";
    if (seen === null && !granted && open) seen = restoring ? PENDING : "intake_unaccepted";
    if (typeof seen === "string") halted = seen;
    return { seen, open };
  };
  const judge = (): string | typeof PENDING | null => look().seen;
  // 끝낼 사유가 이미 생겼는가. 박자 앞뒤와 끝 차례가 본다.
  const haltReason = (): string | null => {
    const seen = judge();
    return typeof seen === "string" ? seen : null;
  };
  // 박자 유효 문. 차례가 판단이다: 끝 코드 → 장부 건강·허가 읽기 → 단조 시각 비교. 시각을 맨 끝에 보아야 읽기에 쓴 시간까지
  // 기한 비교에 든다. 처음부터 닫힌 5단계(받아들인 허가 없음, 장부의 허가도 없음)는 열림이다: 기존 실행의 정지·상태 조회는 나간다.
  // 새 접수·시작·갱신·자격 값은 아래 접수 문이 따로 막는다. 박자 여섯의 beatValid 포트에 이 함수 그대로를 넘긴다(빠지면 그 부품은
  // 늘 유효로 읽으므로 조립이 빠뜨리면 안 된다: boot-effects.test.ts의 같은 객체 단언). 이 함수는 읽기만 한다(답 줄·증거·연결·장부를
  // 바꾸지 않는다): D-90 박자가 마지막 증거 확인 뒤에 부른다(unreceived.md, boot-effects.test.ts "읽기만 한다").
  const SHUT = { open: false, intake: false } as const;
  const effects = (): { readonly open: boolean; readonly intake: boolean } => {
    if (exitCode !== 0) return SHUT;
    const view = look();
    if (view.seen !== null) return SHUT;
    if (beatLimit !== null && pastLimit(deps, beatLimit)) return SHUT;
    return { open: true, intake: view.open };
  };
  const effectsOpen = (): boolean => effects().open;
  // 박자 넷이 장부에 발급을 적기 직전에, 결과 검사가 판정을 적기 직전에 보는 접수 문. 효과의 문과 같은 판정 하나에서 허가를 한 번 읽고 그 값을 쓴다. 정지 세대는 복원기 그대로다.
  const intake = {
    intakeOpen: (): boolean => {
      const seen = effects();
      return seen.open && seen.intake;
    },
    stopGeneration: (): number | null => restorer.stopGeneration(),
  };
  // D-90 박자의 관측 문. 닫기마다 이 칸을 다시 보므로(unreceived.ts의 readGate) 효과의 문이 닫히면 다음 닫기를 적지 않는다.
  const unreceivedSettled = (): boolean => observationsSettled() && effectsOpen();
  // D-90 박자가 새 인사를 부르려고 연결 하나를 닫는 포트. 기억은 프로세스에 하나다: 박자마다 새로 만들면 같은 연결을 박자마다 닫는다.
  // 문은 발급 깃발과 같은 판정(순서기의 발급 && 박자 유효 문)이다. 서버는 발급 깃발을 모르므로 발급을 닫은 뒤에는 이 문이 막는다
  // (transport/server.md "뒤 조각이 지켜야 할 것"). 순서기·서버는 아래에서 만들고, 박자가 부를 때 읽는다.
  const rehello: UnreceivedRehello = {
    closeConnection: (connection) => need(server).closeConnection(connection),
    valid: () => cycle.issuanceOpen() && effectsOpen(),
    memory: createRehelloMemory(),
    reconnectWindowMs: settings.connection.reconnect?.windowMs ?? null,
  };

  // 결과 검사가 판정하지 않은 digest 충돌의 경보. 충돌한 실행마다 이 프로세스에서 한 줄만 남긴다: 판정하지 않은 보고는 반영 전으로 남아
  // 박자마다 같은 충돌이 다시 나온다. 기억은 메모리뿐이라 감독이 다시 뜨면 다시 한 줄을 남긴다.
  const conflicted = new Set<string>();
  const alertConflicts = (report: BeatReport): void => {
    if (report.kind !== "ran" || report.resultCheck.kind !== "returned" || report.resultCheck.result.kind !== "ran") return;
    for (const run of report.resultCheck.result.runs) {
      if (run.outcome !== "digest_conflict" || conflicted.has(run.runId)) continue;
      conflicted.add(run.runId);
      log("result_check_alert", { reason: "digest_conflict", runId: run.runId, digests: run.digests, reports: run.reports });
    }
  };

  // 결과 기다림 경보(D-151)와 결과 기다림 조회의 등록부 정리. 경보는 실행마다 이 프로세스에서 한 줄만 남긴다(result-check.ts의
  // createResultWaitAlarm). 감시 목록은 박자 뒤에 장부의 관측 읽기로 본 checking 실행이다(checkingRunIds): 접수가 닫혀 결과 검사가
  // 판정하지 않는 동안에도 센다. 그 읽기는 실패해도 장부 건강·허가를 바꾸지 않고, 읽지 못한 박자는 세지도 잊지도 않는다.
  // 머문 시간은 프로세스 단조 시계(monoNow)로 잰다. 경보 기억이 이 프로세스의 메모리뿐이라 같은 프로세스 안의 차이면 된다. 벽시계(공유
  // 시계)는 쓰지 않는다: peek()의 표본 하나가 앞서면 그것이 첫 관측이면 경보가 그만큼 늦고 뒤 관측이면 실제 몇 초에 울리며, read()는
  // 하한까지 올려 다음 박자의 결과 검사·배정을 clock_untrusted로 건너뛰게 한다. 판정·배정의 시각은 이 자리와 따로 공유 시계로 간다.
  // 단조 시각도 목록을 읽은 뒤에 읽는다: 판정 시각(judgedAt)이나 목록 앞의 시각으로 재면 박자 도중(배정을 기다리는 동안 등) checking이
  // 된 실행의 대기가 앞당겨진다. judgedAt은 이 박자의 결과 검사가 시각을 받았는지로만 본다. 받지 않은 박자(복원 전·시계를 믿지 못함)는
  // 경보를 건너뛰고 장부도 읽지 않는다: 복원 2단계 앞의 기다림 동안 장부를 읽지 않아야 한다(D-142, 그 읽기가 던져도 감독이 끝나지 않게).
  // 그 박자의 등록부 정리는 수만 줄인다. 기록과 등록부 정리만 하고 장부·박자·공유 시계를 바꾸지 않는다. 돌지 않은 박자(진행 중·발급
  // 닫힘)는 보지 않는다: 진행 중인 박자가 넘긴 시각을 가로채지 않게.
  const waitQueries = createResultWaitQueries();
  const watchResultWait = (report: BeatReport): void => {
    if (report.kind !== "ran") return;
    const at = judgedAt;
    judgedAt = null;
    const checking = at === null ? null : checkingRunIds(ledger);
    if (at !== null) for (const due of waitAlarm.observe(checking, Math.floor(deps.monoNow()))) log("result_check_alert", { reason: "result_wait_overdue", runId: due.runId, waitedMs: due.waitedMs });
    const life = report.life.kind === "returned" && report.life.result.kind === "ran" ? report.life.result.runs : [];
    const sent = life.flatMap((run) => (run.outcome === "query_sent" && run.cause === "result_wait" ? [{ runId: run.runId, requestId: run.requestId }] : []));
    const release = waitQueries.due(sent, checking);
    if (release.size > 0) waitQueries.unreleased(lines === null ? release : lines.releaseQueries(release));
  };

  // 장부 경보(ledger_alert)도 같은 경보마다 이 프로세스에서 한 줄만 남긴다: 실행기는 ack를 받을 때까지 같은 시작 영수증을 다시 보내고
  // (정지 세대를 모르면 계속), 인사·조회의 답은 연결·조회마다 다시 온다. 기억은 메모리뿐이라 감독이 다시 뜨면 다시 한 줄을 남긴다.
  const alerted = new Set<string>();
  const alertLedger = (note: AnswerNote): void => {
    for (const { key, fields } of ledgerAlerts(note)) {
      if (key !== null) {
        if (alerted.has(key)) continue;
        alerted.add(key);
      }
      log("ledger_alert", fields);
    }
  };

  // 5. 순서기를 서버보다 먼저 만든다: 정책이 범위 밖이면 소켓을 열기 전에 끝낸다. 박자 여섯은 아래에서 만드는 객체에 부를 때 위임한다.
  let wire: WireSink | null = null;
  let lines: AnswerLines | null = null;
  const need = <T>(value: T | null): T => {
    if (value === null) throw new Error("not_wired");
    return value;
  };
  const beats: CycleBeats = {
    linkLoss: (clocks, policy, input) =>
      make.ticks.linkLoss({ ledger, connections: { occupancy: (source) => table().occupancy(source) }, restorer, ...clocks, beatValid: effectsOpen }, policy, input),
    // 판정은 접수 문을 본다: 정지 중·허가 폐기·복원 전에는 확정도 열리지 않으므로 판정만 앞당기지 않는다(result-check.md "접수").
    // 실행기의 failed_stopped 답은 답 줄이 같은 자리(stoppedAnswers)에 적는다(result-check.md "결과 없음 판정").
    resultCheck: (now) => {
      judgedAt = now;
      return make.ticks.resultCheck({ ledger, intake, beatValid: effectsOpen, stopped: stoppedAnswers }, now);
    },
    life: (clock, input) =>
      make.ticks.life(
        { ledger, intake, links: need(wire).links, clock, random: deps.random, signer: signing.signer, sink: need(wire).sink, beatValid: effectsOpen },
        settings.life,
        input,
      ),
    resend: (clock, policy, input) =>
      make.ticks.resend({ ledger, intake, links: need(wire).links, clock, random: deps.random, signer: signing.signer, sink: need(wire).sink, beatValid: effectsOpen }, policy, input),
    // 증거·맡기지 않을 실행기는 같은 답 줄의 것이다: confirm이 보는 연결(내보내기 포트의 answers)과 정지 세대(published)가 이 박자의
    // intake·배정과 같은 원천이어야 장부 직전의 확인이 닫기의 근거와 같은 줄을 본다(unreceived.md "같은 객체"). 답 줄은 부를 때
    // 읽는다(박자 함수 본문에서 위임한다).
    unreceived: (now) => {
      const answered = need(lines);
      return make.ticks.unreceived({ ledger, evidence: answered.evidence, withheld: answered.withheld, intake, observationsSettled: unreceivedSettled, beatValid: effectsOpen, rehello }, now);
    },
    assign: (now) => make.ticks.assign(assignPorts(), assignPolicy, now),
  };
  // 세대를 모르면 "후보 없음"이 아니라 모름이다(assign-loop.ts의 CandidateSource).
  const candidates: CandidateSource = {
    candidates: () => (restorer.stopGeneration() === null ? { known: false } : { known: true, value: table().candidates(restorer) }),
  };
  // 배정이 고른 계정의 자격 참조. 값 송신(issuance)과 같은 파일 포트·같은 정책이라 참조와 송신이 같은 계정 폴더 규칙을 본다.
  // 정책의 revisionOf가 모름이면 파일을 열지 않고 모름이다(credential-ref.md). 박자마다 새로 만들지 않는다.
  const credentials = credentialPort(deps.credentialFiles, settings.credentials);
  // 배정 전 사실. 시험 배정 값이면 시험 공급자(앞 실행의 종료는 장부에서, 다섯 사실은 고정 T1 부탁일 때만, D-130)이고, 아니면 모두 모름이다:
  // 고르기가 보류하고 시작하지 않는다.
  // 박자마다 새로 만들지 않는다.
  const facts: FactSource = settings.testAssign === true ? testFactSource(ledger) : { facts: () => ({}) };
  const assignPorts = () => ({
    ledger,
    intake,
    connections: candidates,
    withheld: need(lines).withheld,
    facts,
    credentials,
    random: deps.random,
    signer: signing.signer,
    sink: need(wire).sink,
    beatValid: effectsOpen,
  });
  let cycle: Cycle;
  try {
    cycle = make.cycle({
      beats,
      serverTick: () => need(server).tick(),
      ledgerClock: shared,
      monotonic: { now: () => Math.floor(deps.monoNow()) },
      // 순서기가 박자 여섯을 부르기 직전마다 본다. 5단계를 받아들였고 효과의 문이 열렸을 때만 참이다(기한을 넘긴 박자의 남은 박자를 막는다).
      restoreDone: () => stage >= 5 && effectsOpen(),
      ledger,
      policy: settings.cycle,
      observe: (report) => {
        log("beat", summarize(report));
        alertConflicts(report);
        watchResultWait(report);
      },
    });
  } catch (error) {
    closeLedger();
    return fail("server", SUPERVISOR_EXIT.server, `cycle:${error instanceof Error ? error.message : "invalid"}`);
  }
  if (signal.aborted) {
    closeLedger();
    return aborted("before_server");
  }

  // 6. 서버. 답 줄이 서기 전의 deliver는 던져 그 연결을 닫는다. 1단계 전이라 맞춤에 답하지 않으므로 실제로는 오지 않는다.
  let deliver: (output: Delivered) => void = () => {
    throw new Error("not_ready");
  };
  const start: { work: Promise<StartResult> | null } = { work: null };
  const started = await runBy(
    deadline(timing.startupWaitMs),
    () =>
      (start.work = deps.startServer({
      host: settings.listen.host,
      port: settings.listen.port,
      material,
      clock: ledgerClock,
      registry,
      restorer: published,
      runGeneration: (runId) => ledger.runGeneration(runId),
      nonces: ledger.nonceStore(),
      reply: signing.reply,
      settings: settings.connection,
      deliver: (output) => deliver(output),
      observe: (note) => log("server", note.kind === "closed" ? { kind: note.kind, cause: note.cause } : note.kind === "rejected_tls" ? { kind: note.kind, reason: note.reason } : { kind: note.kind }),
      maxPendingWriteBytes: settings.maxPendingWriteBytes,
      })),
    signal,
  );
  if (started.kind !== "done" || !started.value.ok) {
    // 받아들이지 않은 시작(기한 넘김·멈춤·타이머 없음)이 서버를 세웠으면 그 서버를 닫는다. 기다리지 않는다: 프로세스가 곧 끝난다.
    const late = start.work;
    if (late !== null && started.kind !== "done" && started.kind !== "failed") {
      void late.then(
        (late) => {
          if (late.ok) late.server.close().catch(() => {});
        },
        () => {},
      );
    }
    closeLedger();
    if (started.kind === "aborted") return aborted("server_start");
    if (started.kind !== "done") return fail("server", SUPERVISOR_EXIT.server, `start:${started.kind}`);
    const failure = (started.value as Extract<StartResult, { ok: false }>).failure;
    if (failure.kind === "no_material") return fail("material", SUPERVISOR_EXIT.material, `tls:${failure.reason}`);
    return fail("server", SUPERVISOR_EXIT.server, `start:${failure.kind}`);
  }
  const live: ConnectionServer = started.value.server;
  server = live;

  // 7. 서버가 돌려준 이 동기 구간에서 발급·내보내기 포트·답 줄을 만든다. 사이에 await가 없어 소켓 사건이 끼지 않는다.
  let issuance: Issuance;
  let madeIssuance: Issuance | null = null;
  try {
    const queries = make.queries();
    issuance = make.issuance({
      // 발급 깃발은 순서기의 깃발에 효과의 문을 더한 것이다. 내보내기 포트의 lastCheck와 자격 값의 두 문이 이 깃발을 맨 앞에서 본다.
      // 닫기는 순서기 그대로다.
      cycle: { issuanceOpen: () => cycle.issuanceOpen() && effectsOpen(), closeIssuance: () => cycle.closeIssuance() },
      server: live,
      restorer: published,
      ledger,
      clock: shared,
      files: deps.credentialFiles,
      policy: settings.credentials,
      observe: (note) =>
        log("issuance", note.kind === "credential" ? { kind: note.note.kind, outcome: note.note.kind === "attempt" ? note.note.outcome : null } : note.kind === "shutdown" ? { kind: "shutdown", step: note.step } : { kind: note.kind }),
    });
    madeIssuance = issuance;
    const holder: { lines: AnswerLines | null } = { lines: null };
    wire = make.sink({
      server: live,
      restorer: published,
      // 답 줄이 내보내기 포트를 받아야 하므로 내보내기 포트를 먼저 만든다. 맡기지 않을 실행기는 같은 답 줄에 위임한다.
      withheld: { executors: () => need(holder.lines).withheld.executors() },
      clock: shared,
      queries,
      observe: (note) => log("sink", note.kind === "not_sent" ? { kind: note.kind, action: note.action, reason: note.reason } : { kind: note.kind }),
      issuanceOpen: issuance.issuanceOpen,
    });
    lines = make.lines({
      table: () => live.table(),
      restorer: published,
      ledger,
      results: { backend: backend.backend, ledger },
      random: deps.random,
      signer: signing.signer,
      clock: shared,
      wire,
      queries,
      cycle,
      observationsSettled,
      // 프로세스에 하나인 D-90 증거 장부. 답 줄을 다시 만드는 길이 생기면 같은 장부를 넘겨야 번호가 이어지고 앞 줄이 쥔 답이 오염으로 남는다.
      evidenceBook: createAnswerEvidenceBook(),
      stopped: stoppedAnswers,
      observe: (note) => {
        if (note.kind === "fault") log("answer_fault", { where: note.where });
        else if (note.kind === "hello") log("hello", { outcome: note.outcome.kind });
        // 답 줄은 장부 반영·ack 초안·줄의 상태를 정한 뒤에 기록하고 기록의 예외를 삼킨다(answers.ts의 note). 그래서 경보 줄은 ack·장부·줄을 바꾸지 않는다.
        alertLedger(note);
      },
      credentials: issuance.credentials,
    });
    holder.lines = lines;
    const ready = lines;
    deliver = (output) => ready.deliver(output);
  } catch {
    // 발급 문을 만들었으면 그 문으로 닫는다(깃발 → 서버). 만들기 전에 실패했으면 서버를 직접 닫는다. 닫기는 시각을 읽지 못해도 부른다.
    const made = madeIssuance;
    const closed = await runBy(deadline(timing.stopWaitMs) ?? Number.NaN, () => (made !== null ? made.shutdown() : live.close()));
    const ledgerClosed = closeLedger();
    log("boot_cleanup", { serverClosed: closed.kind === "done", ledgerClosed });
    return fail("server", SUPERVISOR_EXIT.server, "wiring");
  }
  log("boot_step", { step: "server", port: live.port });

  // 8. 주기와 끝 차례.
  const answerLines: AnswerLines = lines;
  let wake: () => void = () => {};
  let ending: Promise<number> | null = null;
  // done은 끝 차례가 시작될 때(stop() 또는 치명 실패) 그 약속을 따른다.
  let settle: (code: number) => void = () => {};
  const settled = new Promise<number>((resolve) => {
    settle = resolve;
  });
  let lastRestoreFailure = "";

  // 치명 코드를 처음 정할 때 박자 안의 문이 이미 붙잡은 사유(halted)가 있으면 그것을 사유로 적는다. 그 사유를 붙잡은 박자가 뒤이어
  // 기한을 넘기면 끝 차례는 beat_lapsed로 들어오는데, 그 이름만 적으면 먼저 생긴 원인(허가 읽기 실패 등)이 기록에서 사라진다.
  // 나중에 온 이름은 later 칸에 남긴다. 이 자리는 halted 변수만 읽는다(장부를 다시 읽지 않는다).
  // fatal은 한 번만 적고, 적었는지는 코드(96)가 아니라 이 깃발로 가른다: 명시적 정지(why = stop)는 여기서 코드를 정하지 않으므로
  // 서버 닫기 실패가 96을 먼저 정하면, 코드로 가르는 자리는 붙잡은 사유를 적지 않고 지나간다.
  let fatalLogged = false;
  const markFatal = (why: string) => {
    if (why !== "stop" && !fatalLogged) {
      exitCode = SUPERVISOR_EXIT.fatal;
      fatalLogged = true;
      if (halted !== null && halted !== why) log("fatal", { reason: halted, later: why });
      else log("fatal", { reason: why });
    }
  };
  const finish = (why: string): Promise<number> => {
    if (ending !== null) {
      markFatal(why);
      return ending;
    }
    // 끝 차례의 기한은 진입 즉시, 치명 기록·깨우기·시계 읽기보다 먼저 정한다. 시각을 읽지 못해도 닫기는 부른다(NaN 기한은 unarmed → 96).
    const limit = deadline(timing.stopWaitMs) ?? Number.NaN;
    markFatal(why);
    stopping = true;
    wake();
    ending = (async () => {
      // shutdown()을 부른 시점. 자격 값 쪽 intake_closed가 깃발 때문인지 진짜 접수 닫힘인지 가르는 기준이다.
      const reading = shared.read();
      log("shutdown_called", { reason: why, at: reading.state === "ok" ? reading.at : null });
      const closed = await runBy(limit, () => issuance.shutdown());
      if (closed.kind !== "done") {
        exitCode = SUPERVISOR_EXIT.fatal;
        log("shutdown_incomplete", { kind: closed.kind });
      }
      // 장부를 닫기 전에 이미 생긴 고장·허가 폐기를 코드에 반영한다. 멈춤 요청이 먼저 왔어도 0으로 덮지 않는다. 위 닫기 실패가
      // 96을 먼저 정했어도 fatal을 아직 적지 않았으면 그 사유를 적는다(닫기 실패의 진단은 shutdown_incomplete로 따로 남는다).
      const known = haltReason();
      if (known !== null && !fatalLogged) {
        exitCode = SUPERVISOR_EXIT.fatal;
        fatalLogged = true;
        log("fatal", { reason: known });
      }
      if (!closeLedger()) exitCode = SUPERVISOR_EXIT.fatal;
      // 마지막 장부 닫기(동기)도 끝 차례의 상한 안에 든다. 반드시 할 닫기를 모두 마친 뒤의 시각으로 판정한다. 발급 닫기가 이미 만료면
      // 그 기록이 있으므로 다시 적지 않는다.
      if (closed.kind === "done" && pastLimit(deps, limit)) {
        exitCode = SUPERVISOR_EXIT.fatal;
        log("shutdown_incomplete", { kind: "lapsed" });
      }
      log("stopped", { code: exitCode });
      return exitCode;
    })();
    void ending.then(settle);
    return ending;
  };

  const restoreSteps = [() => restorer.step1(), () => restorer.step2(), () => restorer.step3(), () => restorer.step4(), () => restorer.step5()] as const;
  // 2단계 앞 기다림(D-142). 처음 기다리기 시작한 단조 시각이다. 한 번 끝나면(모임, 상한, 시각·표를 읽지 못함) 이 프로세스에서 다시
  // 기다리지 않는다: 2단계가 모름으로 실패해 다시 부를 때는 곧바로 부른다.
  let peerWaitSince: number | null = null;
  // 필수 실행기가 정확히 하나일 때만 기다린다(D-143). 둘 이상이면 1단계 다음 주기에 곧바로 2단계를 부른다: 기다리는 동안 먼저 붙은
  // 실행기의 연결이 바뀌면(끊김, 다른 상태로 재접속) 2단계는 그 실행기의 앞 인사(장부 밖·정리 중 실행)를 보지 못하고, 답 줄도 끊긴
  // 연결의 인사로는 장부 밖 실행을 적지 않아 작업자 슬롯 차단이 빠진다. 하나면 그 실행기가 모이는 첫 주기에 기다림이 끝난다(그래도
  // 두 확인 사이에 붙었다 끊긴 연결의 답은 보지 못한다, boot.md 남는 한계). 0이면 기다릴 것이 없다.
  let peerWaitOver = requiredExecutors.length !== 1;
  // 이번 복원기로 맞추고 인사한 열린 연결이 정확히 하나가 아닌 필수 실행기의 수(2단계 occupancy_unconfirmed와 같은 셈). 연결 표의
  // 메모리만 읽는다(greetedCounts): 정지 세대·장부·실행 목록을 읽지 않는다. 주기마다 부르므로 장부를 읽으면 그 읽기의 일시 실패가
  // 2단계 전에 장부 고장(96)이 된다. 정지 세대와 점유의 확인은 2단계가 한다. 표를 읽지 못하면 null이다.
  const missingExecutors = (): number | null => {
    try {
      const greeted = table().greetedCounts(restorer);
      return requiredExecutors.filter((executor) => greeted.get(executor) !== 1).length;
    } catch {
      return null;
    }
  };
  // 이번 주기에 2단계를 미루는가. 모였거나, 상한이 지났거나, 시각이나 표를 읽지 못하면 기다림을 끝내고 2단계를 부르게 한다(모름을
  // 시간이 남은 것으로 읽지 않는다. 그 뒤는 예전과 같아 2단계 기한을 정하지 못하면 restore_unarmed다).
  const holdForPeers = (): boolean => {
    if (peerWaitOver) return false;
    const missing = missingExecutors();
    let at: number | null = null;
    try {
      const read = deps.monoNow();
      if (Number.isFinite(read)) at = read;
    } catch {
      at = null;
    }
    if (peerWaitSince === null) {
      if (missing !== null && missing > 0 && at !== null) {
        peerWaitSince = at;
        log("restore_wait", { step: 2, missing });
        return true;
      }
      peerWaitOver = true;
      return false;
    }
    const waitedMs = at === null ? null : at - peerWaitSince;
    if (missing !== null && missing > 0 && waitedMs !== null && waitedMs < PEER_WAIT_MS) return true;
    peerWaitOver = true;
    const outcome = missing === 0 ? "gathered" : waitedMs === null || missing === null ? "unknown" : "lapsed";
    log("restore_wait_end", { step: 2, outcome, missing, waitedMs: waitedMs === null ? null : Math.max(0, Math.floor(waitedMs)) });
    return false;
  };
  const kickRestore = () => {
    if (restoring || stage >= 5 || stopping) return;
    const index = stage;
    // 다음이 2단계면 필수 실행기가 모일 때까지 다음 주기에 다시 본다. 기다림이 끝난 뒤의 2단계는 아래에서 새 기한을 받는다.
    // 함정: 기다림을 끝내는 같은 동기 구간(표·시계 읽기, 기록 포트)에서 끝 차례가 시작될 수 있어 멈춤을 다시 본다.
    if (index === 1 && (holdForPeers() || stopping)) return;
    // 단계의 기한은 부르기 전에 정한다: 5단계의 판정·허가는 첫 호출 안에서 동기로 끝나므로, 부른 뒤에 정하면 그 비용이 상한에서 빠진다.
    const limit = deadline(timing.restoreStepWaitMs);
    if (limit === null) return void finish("restore_unarmed");
    // 함정: 기한을 정하는 시계 읽기(주입 포트) 안에서도 끝 차례가 시작될 수 있다. 멈춤이면 2단계를 부르지 않는다(D-142).
    if (index === 1 && stopping) return;
    restoring = true;
    stepLimit = limit;
    const step: () => Promise<unknown> = restoreSteps[index]!;
    void runBy(limit, step).then((waited) => {
      restoring = false;
      // 기한 안에 받은 단계는 멈춤 중이어도 센다: 5단계가 장부에 낸 허가를 받아들인 허가로 맞춰야 끝 차례의 haltReason이 그 허가를
      // "받아들이지 않은 허가"로 읽지 않는다. 멈춤 중에는 기록만 남기지 않는다. 실패·기한 넘김은 멈춤보다 먼저 96이다.
      if (waited.kind === "done") {
        stage = index + 1;
        lastRestoreFailure = "";
        const step5 = stage === 5 ? (waited.value as { intakeMayOpen: boolean; closedBecause: readonly string[] }) : null;
        if (step5 !== null) granted = step5.intakeMayOpen === true;
        if (stopping) return;
        if (step5 !== null) log("restore_step", { step: 5, intakeMayOpen: granted, closedBecause: step5.closedBecause.join(",") });
        else log("restore_step", { step: stage });
        return;
      }
      // 모름(현관 없음 등)이면 같은 복원기로 같은 단계를 다음 주기에 다시 부른다. 재시작하지 않는다: 되풀이 재기동이 생기지 않게.
      if (waited.kind === "failed" && waited.error instanceof RestoreStepError) {
        if (stopping) return;
        const reason = `${index + 1}`;
        if (reason !== lastRestoreFailure) log("restore_retry", { step: index + 1 });
        lastRestoreFailure = reason;
        return;
      }
      void finish(`restore_${waited.kind}`);
    });
  };

  // 시험 현관 대역의 소유자 입력(D-109). 5단계의 허가를 받아들인 뒤, 주기의 박자 밖(답 처리 뒤)에서 장부가 받을 때까지 주기마다 한 번 넣는다.
  // 같은 요청 ID라 다시 넣어도 줄은 하나다(enqueueInput의 created:false). 차례: 입력 만들기(장부 시계) → 데이터 사본 → 쓰기 함수 얻기 →
  // 문 한 번(intake.intakeOpen + 끝 차례) → 호출 하나. 문 뒤에는 그 호출만 있다(사본이라 장부가 칸을 읽어도 대역의 코드가 돌지 않는다).
  // 장부의 거절(접수 닫힘·정지)은 다음 주기에 다시 본다. 호출이 던지거나 답의 꼴이 틀리면 적혔는지 몰라 다시 넣지 않는다(장부 고장이면 주기가 96으로 끝낸다).
  const makeTestInput = front.testInput;
  let testInputSettled = makeTestInput === undefined;
  let lastTestInputNote = "";
  const noteTestInput = (outcome: string, reason: string | null = null) => {
    const key = `${outcome}:${reason ?? ""}`;
    if (key !== lastTestInputNote) log("front_door_test_input", { outcome, reason });
    lastTestInputNote = key;
  };
  const admitTestInput = () => {
    if (testInputSettled || makeTestInput === undefined || stopping || stage < 5 || !granted) return;
    let input: InputRecord;
    let write: Ledger["enqueueInput"];
    try {
      const made = makeTestInput(shared.now());
      input = { requestId: made.requestId, source: made.source, sourceRef: { ref: made.sourceRef.ref, expiresAt: made.sourceRef.expiresAt }, receivedAt: made.receivedAt };
      write = ledger.enqueueInput;
    } catch {
      return noteTestInput("not_made");
    }
    if (typeof write !== "function") return noteTestInput("not_made");
    // 문: 접수 문(장부 건강·허가를 읽고 끝낼 사유를 붙잡는다)과 끝 차례를 한 판단으로 본다. 끝 차례는 맨 끝에 읽는다: 입력을 만드는 사이나
    // 접수 문의 읽기 사이에 시작된 끝 차례도 본다(먼저 읽으면 그 뒤에 시작된 것을 놓친다).
    if (!intake.intakeOpen() || stopping) return noteTestInput("closed");
    // 답의 해석도 같은 try 안이다: 꼴이 틀린 답이나 칸을 읽다 던진 것은 적혔는지 모름(unknown)이다.
    let outcome: "created" | "existing" | "refused" | "unknown";
    let reason: string | null = null;
    try {
      const result: unknown = write.call(ledger, input);
      const ok = typeof result === "object" && result !== null ? (result as { ok?: unknown }).ok : undefined;
      if (ok === true) outcome = (result as { created?: unknown }).created === true ? "created" : "existing";
      else if (ok === false) {
        outcome = "refused";
        const why = (result as { reason?: unknown }).reason;
        reason = typeof why === "string" ? why : "unknown";
      } else outcome = "unknown";
    } catch {
      outcome = "unknown";
      reason = "threw";
    }
    if (outcome !== "refused") testInputSettled = true;
    noteTestInput(outcome, reason);
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      let cancel: () => void = () => {};
      wake = () => {
        cancel();
        resolve();
      };
      try {
        cancel = deps.setTimer(ms, resolve);
      } catch {
        void finish("timer_unarmed");
        resolve();
      }
    });

  const loop = async (): Promise<void> => {
    while (!stopping) {
      // 박자 전에 끝낼 사유를 본다: 장부 고장·허가 폐기 뒤에는 서버 tick도 박자도 부르지 않는다.
      const before = haltReason();
      if (before !== null) return void finish(before);
      kickRestore();
      if (stopping) return;
      // 박자의 절대 기한은 박자를 부르기 전에 정한다. 박자 안의 효과 자리(effectsOpen)와 결과 수락이 같은 기한을 본다.
      // 시각을 읽지 못하면(유한하지 않음 포함) 박자를 부르지 않는다: 기한 없는 박자는 그 안의 쓰기를 막을 기준이 없다.
      const limit = deadline(timing.beatWaitMs);
      if (limit === null) return void finish("beat_unarmed");
      const beatStarted = limit - timing.beatWaitMs;
      beatLimit = limit;
      const waited = await waitUntil(cycle.beat(), limit, deps);
      // 거부·기한 넘김은 멈춤 요청보다 먼저 코드에 반영한다. 기한을 넘긴 박자는 계속 돌 수 있으므로 beatLimit을 그대로 둔다.
      if (waited.kind !== "done") return void finish(`beat_${waited.kind}`);
      beatLimit = null;
      // 박자 시간 기록(시계 읽기·기록 포트)은 아래 확인보다 먼저 한다: 확인과 pump 사이에 외부 호출이 없게. 기록 포트 안에서 생긴
      // 장부 고장·허가 폐기도 아래 확인이 본다.
      log("beat_time", { startedMs: beatStarted, endedMs: deps.monoNow() });
      // 답 처리(pump) 바로 앞에서 다시 본다: 박자 안이나 기록 안에서 생긴 장부 고장·허가 폐기 뒤에는 쥔 답을 장부에 넘기지 않는다.
      const after = haltReason();
      if (after !== null) return void finish(after);
      if (stopping) return;
      answerLines.pump();
      const requery = answerLines.takeRequery();
      if (requery.length > 0) log("requery", { count: requery.length });
      if (stopping) return;
      admitTestInput();
      await sleep(timing.beatEveryMs);
    }
  };

  if (signal.aborted) {
    const code = await finish("stop");
    return { ok: false, step: "aborted", code, reason: "after_server" };
  }
  void loop().then(
    () => {
      if (!stopping) void finish("loop_ended");
    },
    () => void finish("loop_threw"),
  );
  const wired: WireSink = wire;
  const tools: RunningSupervisor["tools"] = (policy, config, observe) => ({
    ports: createToolPorts({ ledger, policy, config, random: deps.random, cancel: { links: wired.links, clock: shared, signer: signing.signer, sink: wired.sink, observe } }),
    now: () => shared.now(),
  });
  // 관리 통로가 읽는 자리. 감독의 어떤 상태도 바꾸지 않는 읽기만 넘긴다: 조립 상태는 변수를 읽기만 하고, 장부는 복원기의 statusView
  // (실패해도 장부를 고장으로 표시하지 않고 허가를 버리지 않는 읽기 하나), 시계는 공유 하한을 올리지 않는 peek다.
  // look()·haltReason()을 부르지 않는다: 끝낼 사유를 붙잡는 래치를 관리 요청이 움직이지 않게. 도구 처리기의 포트(tools)를 쓰지 않는다(tools-adapter.md "관리 통로").
  const admin: AdminSources = Object.freeze({
    progress: () => ({ restored: stage >= 5, alive: !stopping && exitCode === 0 && halted === null, granted }),
    view: (cap: number) => restorer.statusView(cap),
    now: () => shared.peek(),
  });
  // 시험 작업 넣기의 쓰기 포트. 설정이 켜졌을 때만 만든다: 꺼진 감독에는 관리 통로에서 장부 쓰기에 닿는 길이 없다. 장부 객체를 넘기지 않고
  // 쓰기 recordToolRequest 하나와, 소유자 입력과 대기 부탁이 배정될 수 있는지 볼 읽기 둘(listInputs·listWaitingToolRequests)만 담는다. 문은 조립의 변수·박자 기한·요청 기한만 본다: look()·haltReason()을 부르지 않고(래치를 움직이지 않는다)
  // 장부를 읽지 않는다. 접수 허가·정지는 장부가 쓰기 트랜잭션 안에서 다시 본다(쓰기 모드 start).
  const testJob: TestJobPorts | null =
    settings.testJobs === true
      ? Object.freeze({
          ledger: Object.freeze({
            recordToolRequest: (input: Parameters<Ledger["recordToolRequest"]>[0]) => ledger.recordToolRequest(input),
            listInputs: () => ledger.listInputs(),
            listWaitingToolRequests: () => ledger.listWaitingToolRequests(),
          }),
          gate: (limit: number) => {
            if (stopping || exitCode !== 0 || halted !== null || stage < 5 || !granted) return "closed";
            if (beatLimit !== null && pastLimit(deps, beatLimit)) return "closed";
            // 요청 기한은 맨 끝에 본다: 위 판단에 쓴 시간까지 기한 비교에 든다. 정각이면 late, 시각을 읽지 못해도 late.
            return pastLimit(deps, limit) ? "late" : "open";
          },
          random: deps.random,
        })
      : null;
  return { ok: true, running: { stop: () => finish("stop"), done: settled, tools, admin, testJob } };
}
