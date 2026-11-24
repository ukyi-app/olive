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
// 5. 기한이 있는 기다림은 결과를 받아들이는 순간의 단조 시각으로 판정한다(waitUntil). 정각 이후면 타이머보다 먼저 처리된 결과여도 만료다.
import { executorName, type Role } from "../../contract/v1/index.ts";
import {
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
import type { CredentialFiles, CredentialRefPolicy } from "../accounts/credential-ref.ts";
import { type AssignLoopPolicy, assignAndStartTick, type CandidateSource } from "../dispatch/assign-loop.ts";
import type { CancelDelivery } from "../dispatch/cancel.ts";
import { lifeTick } from "../dispatch/life-loop.ts";
import { linkLossTick } from "../dispatch/link-loss.ts";
import type { Random } from "../dispatch/ports.ts";
import { resendTick } from "../dispatch/resend.ts";
import { type UnreceivedEvidence, unreceivedTick } from "../dispatch/unreceived.ts";
import type { LifecyclePolicy } from "../scheduler/lifecycle.ts";
import type { FileBackendAnswer, FileBackendOptions } from "../scheduler/result-store-file.ts";
import type { ToolConfig, ToolPolicyPort, ToolPorts } from "../scheduler/tools.ts";
import type { ConnectionSettings } from "../transport/connections.ts";
import { RegistryState, type RegistrySettings } from "../transport/registry.ts";
import type { ConnectionServer, ConnectionServerOptions, Delivered, StartResult } from "../transport/server.ts";
import { type AnswerLines, createAnswerLines } from "./answers.ts";
import { type BeatReport, type Cycle, type CycleBeats, type CyclePolicy, createCycle } from "./cycle.ts";
import { createIssuance, type Issuance } from "./issuance.ts";
import { createPeers, type FrontPeers } from "./peers.ts";
import { createQueryBook } from "./query-book.ts";
import { createSharedClock, type SharedClock } from "./shared-clock.ts";
import { createSigning, SigningKeyError, type SupervisorSigning } from "./signer.ts";
import { createWireSink, type WireSink } from "./sink.ts";
import { createToolPorts } from "./tools-adapter.ts";

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
}

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

// 같은 객체가 넘어가는지 시험이 보려고 바꿔 끼우는 생성자. 운영은 넘기지 않는다(기본값이 실제 생성자다).
export interface SupervisorMakers {
  readonly sharedClock: typeof createSharedClock;
  readonly restorer: (ledger: Ledger, ports: RestorePorts, clock: () => number, requiredPeers: readonly string[]) => Restorer;
  readonly cycle: typeof createCycle;
  readonly queries: typeof createQueryBook;
  readonly issuance: typeof createIssuance;
  readonly sink: typeof createWireSink;
  readonly lines: typeof createAnswerLines;
}

const MAKERS: SupervisorMakers = {
  sharedClock: createSharedClock,
  restorer: (ledger, ports, clock, requiredPeers) => new Restorer(ledger, ports, clock, { requiredPeers }),
  cycle: createCycle,
  queries: createQueryBook,
  issuance: createIssuance,
  sink: createWireSink,
  lines: createAnswerLines,
};

export interface SupervisorDeps {
  // 파일 하나를 바이트로 읽는다(재료·등록표).
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly openLedger: (path: string, options: OpenOptions) => OpenResult;
  readonly createResultBackend: (options: FileBackendOptions) => FileBackendAnswer;
  readonly startServer: (options: ConnectionServerOptions) => Promise<StartResult>;
  readonly credentialFiles: CredentialFiles;
  readonly frontDoor: FrontDoorPorts;
  // D-90 박자의 증거 포트(A6c-2). 그 조각 전에는 모든 실행기에 { known: false }를 내는 포트를 넘긴다.
  readonly evidence: UnreceivedEvidence;
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
    life: step(report.life),
    resend: step(report.resend),
    unreceived: report.unreceived.kind === "returned" ? `returned:${report.unreceived.result.kind}` : step(report.unreceived),
    assign: report.assign.map(step).join(","),
    rereads: report.rereads.length,
  };
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
  const bounded = <T>(begin: () => Promise<T>): Promise<Waited<T>> => {
    let work: Promise<T>;
    try {
      work = begin();
    } catch (error) {
      work = Promise.reject(error);
    }
    return waitUntil(work, deps.monoNow() + timing.startupWaitMs, deps, signal);
  };
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
  log("boot_step", { step: "registry", requiredPeers: requiredPeers.length });

  // 4. 공유 시계 하나, 장부 열기 하나(reopen만), 결과 보관, 복원기 하나(단계는 아직 부르지 않아 세대 null).
  if (signal.aborted) return aborted("ledger");
  const shared: SharedClock = make.sharedClock({ now: () => deps.wallNow() });
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
  let restorer: Restorer;
  try {
    const ports: RestorePorts = {
      stopAuthority: deps.frontDoor.stopAuthority,
      publications: deps.frontDoor.publications,
      peers: createPeers({ front: deps.frontDoor.peers, table, get restorer() { return restorer; }, expectedPolicy: settings.expectedPolicyRevision }),
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

  // 5. 순서기를 서버보다 먼저 만든다: 정책이 범위 밖이면 소켓을 열기 전에 끝낸다. 박자 다섯은 아래에서 만드는 객체에 부를 때 위임한다.
  let wire: WireSink | null = null;
  let lines: AnswerLines | null = null;
  const need = <T>(value: T | null): T => {
    if (value === null) throw new Error("not_wired");
    return value;
  };
  const beats: CycleBeats = {
    linkLoss: (clocks, policy, input) =>
      linkLossTick({ ledger, connections: { occupancy: (source) => table().occupancy(source) }, restorer, ...clocks }, policy, input),
    life: (clock, input) =>
      lifeTick({ ledger, intake: restorer, links: need(wire).links, clock, random: deps.random, signer: signing.signer, sink: need(wire).sink }, settings.life, input),
    resend: (clock, policy, input) =>
      resendTick({ ledger, intake: restorer, links: need(wire).links, clock, random: deps.random, signer: signing.signer, sink: need(wire).sink }, policy, input),
    unreceived: (now) => unreceivedTick({ ledger, evidence: deps.evidence, withheld: need(lines).withheld, intake: restorer, observationsSettled }, now),
    assign: (now) => assignAndStartTick(assignPorts(), settings.assign, now),
  };
  // 세대를 모르면 "후보 없음"이 아니라 모름이다(assign-loop.ts의 CandidateSource).
  const candidates: CandidateSource = {
    candidates: () => (restorer.stopGeneration() === null ? { known: false } : { known: true, value: table().candidates(restorer) }),
  };
  // 배정 전 사실과 자격 참조는 그 조각(역할 프로필·계정) 전까지 모름으로 닫는다: 고르기가 보류하고 시작하지 않는다.
  const assignPorts = () => ({
    ledger,
    intake: restorer,
    connections: candidates,
    withheld: need(lines).withheld,
    facts: { facts: () => ({}) },
    credentials: { reference: async () => ({ known: false as const }) },
    random: deps.random,
    signer: signing.signer,
    sink: need(wire).sink,
  });
  let cycle: Cycle;
  try {
    cycle = make.cycle({
      beats,
      serverTick: () => need(server).tick(),
      ledgerClock: shared,
      monotonic: { now: () => Math.floor(deps.monoNow()) },
      restoreDone: () => stage >= 5,
      ledger,
      policy: settings.cycle,
      observe: (report) => log("beat", summarize(report)),
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
  let startWork: Promise<StartResult>;
  try {
    startWork = deps.startServer({
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
    });
  } catch (error) {
    startWork = Promise.reject(error);
  }
  const started = await waitUntil(startWork, deps.monoNow() + timing.startupWaitMs, deps, signal);
  if (started.kind !== "done" || !started.value.ok) {
    // 받아들이지 않은 시작(기한 넘김·멈춤·타이머 없음)이 서버를 세웠으면 그 서버를 닫는다. 기다리지 않는다: 프로세스가 곧 끝난다.
    if (started.kind !== "done" && started.kind !== "failed") {
      void startWork.then(
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
  try {
    const queries = make.queries();
    issuance = make.issuance({
      cycle,
      server: live,
      restorer: published,
      ledger,
      clock: shared,
      files: deps.credentialFiles,
      policy: settings.credentials,
      observe: (note) =>
        log("issuance", note.kind === "credential" ? { kind: note.note.kind, outcome: note.note.kind === "attempt" ? note.note.outcome : null } : note.kind === "shutdown" ? { kind: "shutdown", step: note.step } : { kind: note.kind }),
    });
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
      observe: (note) => {
        if (note.kind === "fault") log("answer_fault", { where: note.where });
        else if (note.kind === "hello") log("hello", { outcome: note.outcome.kind });
      },
      credentials: issuance.credentials,
    });
    holder.lines = lines;
    const ready = lines;
    deliver = (output) => ready.deliver(output);
  } catch {
    // 발급을 만들지 못했으면 서버를 직접 닫는다(닫을 발급 문이 없다).
    const closed = await waitUntil(live.close(), deps.monoNow() + timing.stopWaitMs, deps);
    const ledgerClosed = closeLedger();
    log("boot_cleanup", { serverClosed: closed.kind === "done", ledgerClosed });
    return fail("server", SUPERVISOR_EXIT.server, "wiring");
  }
  log("boot_step", { step: "server", port: live.port });

  // 8. 주기와 끝 차례.
  const answerLines: AnswerLines = lines;
  let stopping = false;
  let exitCode: number = 0;
  let wake: () => void = () => {};
  let ending: Promise<number> | null = null;
  // done은 끝 차례가 시작될 때(stop() 또는 치명 실패) 그 약속을 따른다.
  let settle: (code: number) => void = () => {};
  const settled = new Promise<number>((resolve) => {
    settle = resolve;
  });
  let granted = false;
  let restoring = false;
  let lastRestoreFailure = "";

  const finish = (why: string): Promise<number> => {
    if (why !== "stop" && exitCode === 0) {
      exitCode = SUPERVISOR_EXIT.fatal;
      log("fatal", { reason: why });
    }
    if (ending !== null) return ending;
    stopping = true;
    wake();
    ending = (async () => {
      // shutdown()을 부른 시점. 자격 값 쪽 intake_closed가 깃발 때문인지 진짜 접수 닫힘인지 가르는 기준이다.
      const reading = shared.read();
      log("shutdown_called", { reason: why, at: reading.state === "ok" ? reading.at : null });
      const closed = await waitUntil(issuance.shutdown(), deps.monoNow() + timing.stopWaitMs, deps);
      if (closed.kind !== "done") {
        exitCode = SUPERVISOR_EXIT.fatal;
        log("shutdown_incomplete", { kind: closed.kind });
      }
      if (!closeLedger()) exitCode = SUPERVISOR_EXIT.fatal;
      log("stopped", { code: exitCode });
      return exitCode;
    })();
    void ending.then(settle);
    return ending;
  };

  const restoreSteps = [() => restorer.step1(), () => restorer.step2(), () => restorer.step3(), () => restorer.step4(), () => restorer.step5()] as const;
  const kickRestore = () => {
    if (restoring || stage >= 5 || stopping) return;
    restoring = true;
    const index = stage;
    let work: Promise<unknown>;
    try {
      work = restoreSteps[index]!();
    } catch (error) {
      work = Promise.reject(error);
    }
    void waitUntil(work, deps.monoNow() + timing.restoreStepWaitMs, deps).then((waited) => {
      restoring = false;
      if (stopping) return;
      if (waited.kind === "done") {
        stage = index + 1;
        lastRestoreFailure = "";
        if (stage === 5) {
          const step5 = waited.value as { intakeMayOpen: boolean; closedBecause: readonly string[] };
          granted = step5.intakeMayOpen === true;
          log("restore_step", { step: 5, intakeMayOpen: granted, closedBecause: step5.closedBecause.join(",") });
        } else log("restore_step", { step: stage });
        return;
      }
      // 모름(현관 없음 등)이면 같은 복원기로 같은 단계를 다음 주기에 다시 부른다. 재시작하지 않는다: 되풀이 재기동이 생기지 않게.
      if (waited.kind === "failed" && waited.error instanceof RestoreStepError) {
        const reason = `${index + 1}`;
        if (reason !== lastRestoreFailure) log("restore_retry", { step: index + 1 });
        lastRestoreFailure = reason;
        return;
      }
      void finish(`restore_${waited.kind}`);
    });
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
      kickRestore();
      const beatStarted = deps.monoNow();
      const waited = await waitUntil(cycle.beat(), beatStarted + timing.beatWaitMs, deps);
      if (stopping) return;
      if (waited.kind !== "done") return void finish(`beat_${waited.kind}`);
      log("beat_time", { startedMs: beatStarted, endedMs: deps.monoNow() });
      answerLines.pump();
      const requery = answerLines.takeRequery();
      if (requery.length > 0) log("requery", { count: requery.length });
      if (stopping) return;
      let writable = false;
      try {
        writable = ledger.health().writable === true;
      } catch {
        writable = false;
      }
      if (!writable) return void finish("ledger_unwritable");
      if (granted && restorer.intakeOpen() !== true) return void finish("intake_discarded");
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
  return { ok: true, running: { stop: () => finish("stop"), done: settled, tools } };
}
