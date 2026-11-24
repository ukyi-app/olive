// 작업자 실행기의 핵심: 검증을 통과한 지시를 처리하고, 고정 프로필로 한 번에 하나의 실행을 띄우고, 영수증·보고를 낸다.
// 연결의 수명(맞춤, hello, 재전송의 시점)은 link.ts가, 받아도 되는 메시지인지는 계약 모듈(verifyEnvelope)이 가른다.
//
// 지키는 것:
// - 새 정지 세대는 그 봉투의 효과보다 먼저 저장소에 적는다. 적지 못하면 종료는 계속하되 새 지시를 받지 않는다(intake 닫힘).
// - 권한이 필요한 효과(폴더 준비, 자격 요청, spawn, 임대 연장, 폴더 지우기, 새 요청에 내는 영수증)는 그 직전에 다시 본다.
//   무엇을 다시 보는지는 효과마다 다르다: launchBlocked(준비·자격·spawn), authorized(임대 연장, 지우기, 새 요청의 영수증).
// - 띄우기 직전 확인과 spawn 사이에 await가 없다.
// - 닫는 쪽 효과(프로세스 정리, 연결 닫기)는 저장을 기다리지 않는다. 검증된 취소와 복원이 정리를 요구하면 기록보다 먼저 시작한다.
//   여는 쪽 효과(접수, 자격, spawn, 임대 연장, 일반 송신)는 실제로 실패한 그 연산이 회복된 뒤에만 열린다.
// - 장부가 설명하지 못하는 실행(store.validEvents가 비어 있는 실행)은 슬롯을 쥔 채 상태·사건·정리 승인을 함께 보류한다.
//   프로세스를 끝내고 세는 일은 계속하되 그 결과로 아무 사실도 새로 맺지 않는다.
// - 자격은 받은 바이트의 SHA-256이 지시의 digest와 같을 때만 프로필의 이름 하나에 넣는다. 결과에 그 값이 그대로 있으면 결과를 버린다.
// - 종료 확인 영수증(receipt_stopped)은 남은 프로세스 0개를 확인한 뒤에만 낸다. 아니면 unknown_running으로 두고 슬롯을 놓지 않는다.
// - 상태와 사건은 store.commit 한 자리로만 남긴다. 적은 사건만 보낸다. 접수 영수증이 남기 전에는 자격을 받지도 띄우지도 않는다.
// - 아는 실행 ID의 시작 지시는 새 실행을 열지 않는다. 처음 접수한 지시와 본문이 같을 때만 같은 영수증을 다시 보낸다.
//   결과가 없다는 이유로 다시 띄우지 않는다.
import { generateKeyPairSync, type KeyObject, randomBytes, randomUUID } from "node:crypto";
import {
  type Action,
  type Bodies,
  type Envelope,
  executorName,
  type Header,
  limits,
  type PendingStopSync,
  type Result,
  resultDigest,
  type RunStatus,
  sealEnvelope,
  SealError,
  type Verified,
  type VerifyContext,
} from "../contract/v1/index.ts";
import type { ProcessCleanup } from "./containment.ts";
import { bunLauncher, type Launcher, type LaunchOutcome } from "./launcher.ts";
import {
  assertLaunchSafe,
  type CredentialSource,
  credentialMatches,
  credentialText,
  fixProfile,
  type LaunchPlan,
  launchPlan,
  type RoleProfile,
} from "./profile.ts";
import { type ExecutorStore, type ExitKind, HOLDS_SLOT, type NewEvent, type OutboxAction, type OutboxEntry, type RunRecord, type StoredRunState } from "./store.ts";

// 영수증·보고를 실어 보낼 곳. epoch()는 맞춘 연결마다 다른 수이고, 연결이 없거나 맞춤 전이면 null이다(보내지 않고 저장소에만 남긴다).
export interface Outlet {
  epoch(): number | null;
  send(envelope: Envelope): void;
  // 그 연결을 닫는다(세대 저장 실패). 지금 연결이 아니면 아무 일도 없다. 다시 맞추는 것은 새 연결에서다.
  drop(epoch: number): void;
  // 맞춤 중인 연결까지 지금 연결을 닫는다(nonce 기록 장애: 그 연결에서 비상 종료를 놓쳤을 수 있다).
  dropCurrent(): void;
}

// 실행마다 쓰는 폴더 등의 준비와 지우기. 실제 작업 폴더·tmp의 모양은 뒤 작업(O13)이 정한다.
export interface RunSpace {
  // signal이 중단되면 준비를 거둔다. 실행기는 중단 뒤 늦게 끝난 준비의 결과를 쓰지 않는다.
  prepare(runId: string, signal: AbortSignal): Promise<void>;
  // 지웠으면 true. 지우지 못했으면 false이고 그 실행은 cleanup_pending이다. 같은 실행을 다시 불러도 안전해야 한다(재시작 뒤 이어 지운다).
  clean(runId: string): Promise<boolean>;
}

export interface WorkerOptions {
  instance: string;
  profile: RoleProfile;
  policyRevision: string;
  store: ExecutorStore;
  signingKey: KeyObject;
  supervisorKey: KeyObject;
  credentials: CredentialSource;
  cleanup: ProcessCleanup;
  space: RunSpace;
  launcher?: Launcher;
  now?: () => number;
  // 역할 프로그램 stdout의 바이트 상한. 넘으면 끝내고 실패로 친다.
  outputBytes?: number;
  drainMs?: number;
  // 중단 뒤 역할 프로그램의 끝과 정리(terminate)·계수(survivors)를 각각 기다리는 상한. 넘으면 슬롯을 쥔 unknown_running이다.
  exitWaitMs?: number;
  // 받음 확인이 없는 영수증·보고를 다시 보내는 간격.
  resendMs?: number;
  // 비상 종료가 세대 저장을 기다리는 상한. 저장이 멈춰도 이 뒤에는 종료를 시작한다.
  stopWriteWaitMs?: number;
}

// 정리(result_finalize)를 받아도 되는 상태: 프로세스 0개를 이미 확인했다.
const MAY_CLEAN: readonly StoredRunState[] = ["ready_result", "failed_stopped", "not_started", "cleanup_pending"];
// 끝을 아직 맺지 못한 상태. 재시작하면 같은 실행·세대의 지속된 사건으로 맺거나 남은 수를 다시 센다.
const IN_FLIGHT: readonly StoredRunState[] = ["preparing", "running", "stopping", "checking"];
const UNREADABLE_SUMMARY = "역할 프로그램의 결과를 계약의 모양으로 읽지 못했다";
const LEAKED_SUMMARY = "역할 프로그램의 결과에 그 실행의 자격 값이 들어 있어 결과를 버렸다";

// 봉투를 만들지 못한 까닭이 저장된 본문인지. 머리(시계·이름)의 malformed와 키·서명기의 실패는 장부의 손상이 아니다.
const bodyRejected = (error: unknown) => error instanceof SealError && error.reason !== "malformed";

interface Active {
  runId: string;
  // 이 실행을 받은 연결. 자격 요청과 spawn은 이 연결이 지금 연결일 때만 한다.
  epoch: number;
  controller: AbortController;
  cause: ExitKind | null;
  // 프로그램이 끝난 것을 안 시각. 종료를 기한·임대와 대조한다.
  exitedAt: number | null;
  done: Promise<void>;
}

export type IntakeClosed = "stop_generation_unsaved" | "store_unavailable" | "store_inconsistent";

// 끝나거나 ms가 지나면 돌아온다. 거절이나 시간 초과면 fallback이다(늦게 끝난 결과는 버린다).
async function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([work.catch(() => fallback), new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]);
  clearTimeout(timer);
  return result;
}

// 중단되면 기다리기를 그만둔다. 이미 중단됐으면 작업을 시작하지 않는다. 늦게 끝난 작업의 결과와 거절은 버린다.
function abortable<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    start()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// 결과의 모든 글(값과 이름)에 자격 값이 그대로 들어 있는지. 재귀 없이 돌고, 계약의 깊이 상한을 넘으면 던진다.
function mentions(root: unknown, secret: string): boolean {
  const stack: [unknown, number][] = [[root, 0]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop()!;
    if (depth > limits.MAX_DEPTH) throw new Error("too_deep");
    if (typeof value === "string") {
      if (value.includes(secret)) return true;
    } else if (Array.isArray(value)) {
      for (const item of value) stack.push([item, depth + 1]);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        if (key.includes(secret)) return true;
        stack.push([item, depth + 1]);
      }
    }
  }
  return false;
}

export class WorkerExecutor {
  readonly name: string;
  readonly profile: RoleProfile;
  private outlet: Outlet = { epoch: () => null, send: () => {}, drop: () => {}, dropCurrent: () => {} };
  private active: Active | undefined;
  private stopUnsaved = false;
  // 세대를 디스크에 쓰는 동안 보류한 송신이 있다. 세대가 다시 일치하면 저장된 같은 본문을 보낸다.
  private heldSends = false;
  // 지우는 중인 실행. 첫 await 전에 넣어 슬롯을 쥐고, 같은 실행의 확정은 진행 중인 작업에 합류한다.
  private readonly cleaning = new Map<string, Promise<void>>();
  // 프로세스를 끝내고 세는 물리적 정리가 도는 실행. 첫 종료와 재정리가 함께 쓰고, 같은 실행의 정리가 겹치지 않는다.
  private readonly reclaiming = new Map<string, Promise<void>>();
  private readonly lastSent = new Map<string, number>();
  private readonly now: () => number;
  private readonly launcher: Launcher;
  private flushing: Promise<boolean> | undefined;

  constructor(private readonly options: WorkerOptions) {
    this.profile = fixProfile(options.profile);
    this.name = executorName(this.profile.role, options.instance, options.store.storageId);
    this.now = options.now ?? Date.now;
    this.launcher = options.launcher ?? bunLauncher;
    // 저장된 본문이 계약의 모양인지 서명해 보며 대조한다. 맞지 않는 본문은 다시 보낼 수 없으므로 그 사건은 보내지 않고 접수를 닫는다.
    // 대조는 임시 키로 한다. 실제 서명 키의 장애는 본문 검사 뒤의 일이고 장부의 사실이 아니다.
    // 본문을 거절한 것이 아닌 실패(시계·이름 등)는 그 본문을 끝까지 보지 못했다는 뜻이다. 걸러지지 않은 사건이 복원 증거로 남지 않게
    // 표식 없이 기동을 실패시킨다. 회복한 뒤 다시 열면 대조가 처음부터 돈다.
    const probeKey = generateKeyPairSync("ed25519").privateKey;
    for (const entry of options.store.outboxAll()) {
      try {
        this.seal(entry.action, entry.body, entry.run_generation, probeKey);
      } catch (error) {
        if (!bodyRejected(error)) throw error;
        options.store.markInconsistent("outbox_body", entry.id);
      }
    }
    // 본문까지 검증된 사건으로 실행마다 상태의 전제를 대조한다.
    options.store.auditRuns();
    options.store.onNonceFault(() => this.onNonceFault());
  }

  private get store(): ExecutorStore {
    return this.options.store;
  }

  attach(outlet: Outlet): void {
    this.outlet = outlet;
  }

  intakeClosed(): IntakeClosed | null {
    if (this.store.inconsistency() !== null) return "store_inconsistent";
    if (this.stopUnsaved) return "stop_generation_unsaved";
    if (!this.store.healthy()) return "store_unavailable";
    return null;
  }

  // 장부 전체를 설명할 수 없거나 지금의 점유·보류가 hello의 상한을 넘는다. 일부만 담은 목록으로 인사하지 않는다(link.ts가 연결을 닫는다).
  // 시작과 정리 예약은 상한 안에서만 점유를 늘린다. 실행 중에 넘는 것은 그 뒤에 선 보류가 더해졌거나 저장소의 낮은 쓰기 입구로 기록이 들어온 경우다.
  helloWithheld(): boolean {
    return this.store.ledgerHeld() || this.occupying().length > limits.STATUS_MAX_RUNS;
  }

  // hello가 반드시 실어야 하는 실행. 인사의 판정과 정리 예약의 상한이 같은 집합을 센다.
  private occupying(): RunRecord[] {
    return this.store.durableRunList().filter((run) => this.occupies(run));
  }

  // 슬롯을 쥐었거나 장부가 설명하지 못하는 실행. hello의 목록은 파일의 기록으로 만들므로 파일과 메모리 어느 쪽이 쥐었어도 센다.
  private occupies(run: RunRecord): boolean {
    const current = this.store.run(run.run_id)?.state ?? run.state;
    return this.store.suspectRun(run.run_id) || HOLDS_SLOT.includes(run.state) || HOLDS_SLOT.includes(current);
  }

  // 시험과 진입점이 지금 실행이 끝나기를 기다리는 자리.
  idle(): Promise<void> {
    return this.active?.done ?? Promise.resolve();
  }

  verifyContext(pending: PendingStopSync | null): VerifyContext {
    const supervisorKey = this.options.supervisorKey;
    return {
      now: this.now(),
      expectedRecipient: this.name,
      publicKeyFor: (sender) => (sender === "supervisor" ? supervisorKey : undefined),
      stopGeneration: this.store.stopGeneration(),
      stopSyncChallenge: pending,
      runGeneration: (runId) => this.store.run(runId)?.run_generation,
      nonces: this.store,
    };
  }

  // 새 정지 세대를 적는다. 메모리 울타리는 부르는 즉시 올라가 낮은 세대의 시작을 막는다(store.ts).
  // 적은 뒤 파일과 메모리가 같은 세대면 저장 장애로 닫힌 접수를 열고, 그동안 보류한 송신을 보낸다.
  async adopt(generation: number): Promise<boolean> {
    const { saved } = await this.store.adoptStopGeneration(generation);
    if (!saved) this.stopUnsaved = true;
    else if (this.store.durableStopGeneration() === this.store.stopGeneration()) {
      this.stopUnsaved = false;
      if (this.heldSends) {
        this.heldSends = false;
        this.resendUnacked();
      }
    }
    return saved;
  }

  // 맞춤 답의 세대를 적는다(link.ts). 같은 세대여도 파일이 낮으면 적는다. 파일·메모리가 모두 그 세대가 되었을 때만 true다.
  async syncTo(generation: number): Promise<boolean> {
    const saved = await this.adopt(generation);
    return saved && this.store.stopGeneration() === generation && this.store.durableStopGeneration() === generation;
  }

  // 맞춤의 세대 저장이 상한 안에 끝나지 않았다(link.ts가 연결을 닫는다). 저장 장애로 드러내고 새 지시를 받지 않는다.
  adoptionStalled(): void {
    this.stopUnsaved = true;
  }

  // nonce 기록의 로컬 장애. 거절된 봉투의 내용은 모른다. 그것이 비상 종료였을 수 있으므로 이 연결의 새 권한을 끊고,
  // 진행 중인 준비·자격 요청을 거두고, 실행 중인 작업의 안전한 종료를 시작한다(갱신도 nonce를 못 써 어차피 임대로 끝날 실행이다).
  // 이미 끝난 것을 본 프로그램의 종료와 결과는 그대로 둔다. 끝내는 것은 아직 도는 작업뿐이다.
  private onNonceFault(): void {
    this.outlet.dropCurrent();
    const active = this.active;
    if (active === undefined) return;
    if (active.exitedAt === null) active.cause ??= "failed";
    active.controller.abort();
  }

  // 지시의 정지 세대가 지금 세대이고 파일에도 적혔으며, 받은 연결이 지금 연결이고, 접수가 열려 있는지.
  private authorized(stopGeneration: number, epoch: number): boolean {
    return (
      this.intakeClosed() === null &&
      this.outlet.epoch() === epoch &&
      this.store.stopGeneration() === stopGeneration &&
      this.store.durableStopGeneration() === stopGeneration
    );
  }

  // 검증을 통과한 봉투 하나를 처리한다. epoch는 그 봉투를 받은 연결이다. stop_sync_reply의 세대는 link.ts가 syncTo로 적는다.
  async handle(verified: Verified, epoch: number): Promise<void> {
    if (this.outlet.epoch() !== epoch) return;
    if (verified.adoptedStopGeneration !== null && verified.action !== "stop_sync_reply") {
      // 비상 종료. 세대를 먼저 적되 저장이 멈춰도 종료를 붙들지 않는다. 적지 못했으면 이 연결은 닫고 종료는 계속한다.
      const saved = await bounded(this.adopt(verified.adoptedStopGeneration), this.options.stopWriteWaitMs ?? 2_000, false);
      if (!saved) {
        this.stopUnsaved = true;
        this.outlet.drop(epoch);
      }
      if (verified.action === "task_cancel") return this.onCancel(verified.header, verified.body, epoch);
      return;
    }
    switch (verified.action) {
      case "task_start":
        return this.onStart(verified.header, verified.body, epoch);
      case "task_cancel":
        // 멈추는 효과는 세대가 지난 지시여도 막지 않는다(더 높은 세대의 비상 종료와 같은 쪽의 효과다).
        return this.onCancel(verified.header, verified.body, epoch);
      case "run_renew":
        return this.onRenew(verified.header, verified.body, epoch);
      case "result_finalize":
        return this.onFinalize(verified.header, verified.body, epoch);
      case "status_query":
        return this.onStatus(verified.header, verified.body, epoch);
      case "ack":
        await this.store.ack(verified.body.ids);
        return;
      default:
        // 세션 지시는 받는 쪽이 세션 실행기라 계약이 wrong_direction으로 거절한다. 영수증·보고·hello는 실행기가 받는 동작이 아니다.
        return;
    }
  }

  // ---- 지시 ----

  private refusesStart(header: Header, body: Bodies["task_start"], epoch: number): boolean {
    if (this.active !== undefined || this.cleaning.size > 0 || !this.authorized(header.stop_generation, epoch)) return true;
    const runs = this.store.runs();
    if (runs.some((run) => HOLDS_SLOT.includes(run.state))) return true;
    // hello는 확정되지 않은 실행을 STATUS_MAX_RUNS개까지만 싣는다. 넘치면 감독이 장부 밖 점유를 볼 수 없으므로 그 전에 받지 않는다.
    if (runs.filter((run) => run.state !== "finalized").length >= limits.STATUS_MAX_RUNS) return true;
    return body.profile_revision !== this.profile.revision || body.policy_revision !== this.options.policyRevision;
  }

  private async onStart(header: Header, body: Bodies["task_start"], epoch: number): Promise<void> {
    const runId = body.run_id;
    if (this.store.run(runId) !== undefined) {
      this.resendFor(runId, header.body_digest);
      return;
    }
    if (this.refusesStart(header, body, epoch)) return;
    // 슬롯은 첫 await 전에 잡는다. 같은 때 온 다른 시작 지시가 함께 지나가지 않는다.
    let release!: () => void;
    const active: Active = {
      runId,
      epoch,
      controller: new AbortController(),
      cause: null,
      exitedAt: null,
      done: new Promise((resolve) => (release = resolve)),
    };
    this.active = active;
    const finish = () => {
      if (this.active === active) this.active = undefined;
      try {
        this.options.credentials.forget?.(runId);
      } catch {
        // 우편함의 실패가 슬롯을 놓는 일을 막지 않는다
      }
      release();
    };
    let accepted: boolean;
    try {
      const record: RunRecord = {
        run_id: runId,
        run_generation: header.run_generation,
        state: "preparing",
        start_stop_generation: header.stop_generation,
        instruction_request_id: header.request_id,
        deadline_at: body.deadline_at,
        // 첫 갱신 전의 임대: 같은 때 낸 run_renew가 줄 수 있는 최대와 같다. 계약은 시작 지시에 임대 칸을 두지 않는다.
        lease_until: header.issued_at + limits.RUN_LEASE_MAX_MS,
        credential_digest: body.credential.digest,
        exit: null,
        last_receipt_id: null,
      };
      if (!(await this.store.beginRun(record))) return finish();
      // 기록을 적는 사이 연결·세대·접수가 바뀌었으면 새 접수 영수증을 내지 않는다. 여기서 사건의 예약까지 await가 없다.
      accepted =
        this.authorized(header.stop_generation, epoch) &&
        (await this.emit("receipt_accepted", runId, { run_id: runId, instruction_request_id: header.request_id, instruction: "task_start" }, header.body_digest));
    } catch (error) {
      finish();
      throw error;
    }
    // 실행은 지시 처리와 따로 돈다. 그동안 온 취소·갱신·조회를 처리해야 한다.
    // 실행 중 예외로 끝나면 프로세스가 남았는지 모르므로 unknown_running으로 두고 슬롯을 놓지 않는다.
    // 접수 영수증을 적지 못했으면 띄우지 않고 닫는다(재전송할 수 없는 접수로 모델을 띄우지 않는다).
    const work = accepted ? this.execute(runId, active) : this.notStarted(runId, "failed");
    void work.catch(() => this.transition(runId, { state: "unknown_running" })).finally(finish);
  }

  private async execute(runId: string, active: Active): Promise<void> {
    const record = this.store.run(runId)!;
    const signal = active.controller.signal;
    let plan: LaunchPlan;
    let credential: string;
    // 받은 값의 바이트. 대조와 문자열 변환이 끝나면 띄우든 띄우지 않든 아래 finally가 0으로 채운다(문자열 사본은 지울 수 없다).
    let value: Uint8Array | null = null;
    try {
      // 접수를 적는 사이 연결이 바뀌거나 취소됐을 수 있다. 준비를 시작하기 전에 본다.
      const ready = this.launchBlocked(runId, active);
      if (ready !== null) return this.notStarted(runId, ready);
      await abortable(() => this.options.space.prepare(runId, signal), signal);
      // 자격을 요청하기 직전과 받은 직후에 다시 본다(연결, 세대, 취소, 기한, 임대).
      const before = this.launchBlocked(runId, active);
      if (before !== null) return this.notStarted(runId, before);
      value = await abortable(() => this.options.credentials.take(runId, record.credential_digest, signal), signal).catch(() => null);
      const after = this.launchBlocked(runId, active);
      if (after !== null) return this.notStarted(runId, after);
      if (value === null || !credentialMatches(value, record.credential_digest)) return this.notStarted(runId, "failed");
      const text = credentialText(value);
      if (text === null) return this.notStarted(runId, "failed");
      credential = text;
      plan = launchPlan(this.profile, credential);
      assertLaunchSafe(this.profile, plan, credential);
    } catch {
      return this.notStarted(runId, active.cause ?? "failed");
    } finally {
      value?.fill(0);
    }
    // 띄우기 직전 확인. 여기서 launcher의 spawn까지 await가 없다.
    const blocked = this.launchBlocked(runId, active);
    if (blocked !== null) return this.notStarted(runId, blocked);
    let spawned = false;
    let outcome: LaunchOutcome | null = null;
    try {
      outcome = await this.launcher.run(plan, signal, {
        busy: () => this.options.cleanup.busy(),
        terminate: () => this.options.cleanup.terminate(),
        spawned: () => {
          spawned = true;
          void this.markStarted(runId, record.instruction_request_id).catch(() => {});
        },
        exited: () => {
          active.exitedAt ??= this.now();
        },
        outputBytes: this.options.outputBytes ?? 64 * 1024,
        drainMs: this.options.drainMs,
        exitWaitMs: this.exitWaitMs(),
      });
    } catch {
      // 프로세스가 생기기 전 실패이거나(LaunchFailed) 지켜보다 실패했거나 끝을 확인하지 못했다(ExitUnconfirmed). 아래에서 남은 수를 센다.
    }
    if (!spawned) return this.notStarted(runId, active.cause ?? "failed");
    // 시작 영수증의 쓰기를 기다리지 않고 정리로 간다. 사건의 차례는 저장소의 순번이 지킨다.
    const exit = this.exitOf(runId, active, outcome);
    await this.reserveCleanup(runId, exit, true, exit === "completed" ? (outcome?.stdout ?? null) : null, credential);
  }

  // 0으로 끝났어도 끝난 시각이 기한·임대를 넘었으면 completed가 아니다(감시 주기 사이에 넘긴 경우).
  // 끝난 것을 본 뒤에는 임대가 늘지 않으므로(onRenew) 끝난 시각과 그때의 임대를 대조하는 것이 된다.
  private exitOf(runId: string, active: Active, outcome: LaunchOutcome | null): ExitKind {
    if (active.cause !== null) return active.cause;
    if (outcome === null || outcome.exit.code !== 0 || outcome.overflow) return "failed";
    const record = this.store.run(runId);
    const ended = active.exitedAt ?? this.now();
    if (record === undefined) return "failed";
    if (ended >= record.deadline_at) return "deadline";
    if (ended >= record.lease_until) return "failed";
    return "completed";
  }

  // 폴더 준비, 자격 요청, spawn 직전의 확인. 하나라도 걸리면 그 효과를 내지 않는다.
  private launchBlocked(runId: string, active: Active): ExitKind | null {
    const record = this.store.run(runId);
    if (record === undefined) return "failed";
    if (active.controller.signal.aborted || active.cause !== null) return active.cause ?? "cancelled";
    const now = this.now();
    if (now >= record.deadline_at) return "deadline";
    const generation = record.start_stop_generation;
    if (this.store.stopGeneration() !== generation || this.store.durableStopGeneration() !== generation || this.stopUnsaved) return "cancelled";
    if (this.intakeClosed() !== null || this.outlet.epoch() !== active.epoch || now >= record.lease_until) return "failed";
    // 다른 실행이 정리 중이거나 정리를 남겼다(정리 실패가 접수 뒤에 일어난 경우).
    if (this.cleaning.size > 0 || this.store.runs().some((run) => run.run_id !== runId && HOLDS_SLOT.includes(run.state))) return "failed";
    // 첫 영수증(접수)이 파일에 남았다.
    if (!this.store.validEvents(runId).some((entry) => entry.action === "receipt_accepted" && this.store.persisted(entry.id))) return "failed";
    return null;
  }

  private async markStarted(runId: string, requestId: string): Promise<void> {
    const event = this.event("receipt_started", runId, { run_id: runId, instruction_request_id: requestId, started_at: this.now() });
    await this.transition(runId, { state: "running" }, [event]);
  }

  private notStarted(runId: string, exit: ExitKind): Promise<void> {
    return this.reserveCleanup(runId, exit, false, null, null);
  }

  // 남은 프로세스를 끝내고 센다. 0개일 때만 종료 확인 영수증을 낸다. 띄우지 않은 실행도 센다(세는 쪽이 0을 말해야 낸다).
  // 정리는 저장을 기다리지 않는다: 상태 기록은 줄에 넣어 두고 정리를 먼저 시작하며, 확인한 사실의 기록과 전송은 그 뒤에 온다.
  // 세는 쪽이 끝나지 않으면 상한에서 unknown_running으로 둔다(0을 만들어 내지 않는다).
  // 종료 확인 영수증·결과 보고·최종 상태는 전이 하나로 남긴다. 이미 있는 사건은 새로 만들지 않고 같은 ID로 다시 보낸다.
  // 장부가 설명하지 못하는 실행은 끝내고 세기만 한다. 끝을 맺지 못한 상태는 슬롯을 쥔 미확인으로 두고, 영수증과 완료 상태를 내지 않는다.
  // physicalDone은 두 백엔드(terminate, survivors)가 실제로 끝난 뒤에만 부른다(파일 쓰기의 완료는 기다리지 않는다).
  // 결과를 받은 동기 구간에서 이미 끝났으면 그 자리에서, 상한이 먼저 왔으면 마지막 백엔드가 끝날 때 부른다. 뒤에서 예외가 나도 같다.
  // 아직 신호를 낼 수 있는 정리와 새 정리가 겹치면 안 된다.
  private async confirmStopped(
    runId: string,
    exit: ExitKind,
    launched: boolean,
    stdout: Uint8Array | null,
    credential: string | null,
    physicalDone: () => void,
  ): Promise<void> {
    const backend = this.options.cleanup;
    // 아직 끝나지 않은 백엔드 작업의 수. 결과가 bounded에 닿기 전에 줄이므로, 결과를 받은 시점에 0이면 두 백엔드가 실제로 끝났다.
    let running = 0;
    let lastSettled: (() => void) | undefined;
    const settle = () => {
      if (--running === 0) lastSettled?.();
    };
    // 백엔드의 동기 예외도 거절로 받는다. 어느 실패든 settle을 지나야 한다.
    const watch = <T>(start: () => Promise<T>): Promise<T> => {
      running++;
      return new Promise<T>((resolve) => resolve(start())).then(
        (value) => {
          settle();
          return value;
        },
        (error: unknown) => {
          settle();
          throw error;
        },
      );
    };
    const cleanup = { terminate: () => watch(() => backend.terminate()), survivors: () => watch(() => backend.survivors()) };
    if (launched) {
      if (!this.store.suspectRun(runId)) void this.transition(runId, { state: "stopping", exit });
      await bounded(cleanup.terminate(), this.exitWaitMs(), undefined);
    }
    const survivors = await bounded(cleanup.survivors(), this.exitWaitMs(), null);
    // 여기서부터 결과의 메모리 반영과 순번 예약까지 한 동기 구간이다. 두 백엔드가 이미 끝났으면 이 구간에서 예약을 풀므로,
    // 이 뒤에 처리되는 취소는 반영된 결과와 빈 예약을 함께 본다.
    if (running === 0) physicalDone();
    else lastSettled = physicalDone;
    if (this.store.suspectRun(runId)) {
      if (IN_FLIGHT.includes(this.store.run(runId)!.state)) await this.transition(runId, { state: "unknown_running", exit });
      return;
    }
    if (survivors !== 0) {
      await this.transition(runId, { state: "unknown_running", exit });
      return;
    }
    void this.transition(runId, { state: "checking", exit });
    const prior = (action: OutboxAction) => this.store.validEvents(runId).find((entry) => entry.action === action);
    const stopped = prior("receipt_stopped");
    const report = prior("report_result");
    const events: NewEvent[] = [];
    if (stopped === undefined) events.push(this.event("receipt_stopped", runId, { run_id: runId, remaining_processes: 0, exit, stopped_at: this.now() }));
    let state: StoredRunState = launched ? "failed_stopped" : "not_started";
    if (report !== undefined) state = "ready_result";
    else if (exit === "completed" && stdout !== null) {
      events.push(this.event("report_result", runId, { run_id: runId, result: this.readResult(stdout, credential) }));
      state = "ready_result";
    }
    await this.transition(runId, { state, exit }, events);
    for (const entry of [stopped, report]) if (entry !== undefined) this.transmit(entry);
  }

  // 물리적 정리를 예약하고 부르는 즉시 시작한다. 첫 종료와 재정리가 이 한 자리를 지나므로 같은 실행의 물리적 정리는 하나만 돈다.
  // 예약은 물리적 정리의 수명까지만 쥔다. 결과의 기록이 멈춰도 다음 검증된 취소가 종료를 다시 시도할 수 있다.
  private reserveCleanup(runId: string, exit: ExitKind, launched: boolean, stdout: Uint8Array | null, credential: string | null): Promise<void> {
    const release = () => {
      if (this.reclaiming.get(runId) === work) this.reclaiming.delete(runId);
    };
    const work: Promise<void> = this.confirmStopped(runId, exit, launched, stdout, credential, release);
    this.reclaiming.set(runId, work);
    // 거절은 이 작업을 기다리는 쪽이 받는다. 기다리기 전에 거절돼도 처리되지 않은 거절로 치지 않는다.
    work.catch(() => {});
    return work;
  }

  // 끝을 확인하지 못한 실행을 다시 끝내고 센다. 아직 도는 물리적 정리가 있으면 거기에 합류한다.
  // 앞선 정리의 예외는 그 정리를 시작한 쪽이 받는다. 합류한 쪽은 끝나기만 기다린다.
  private reclaim(runId: string, exit: ExitKind): Promise<void> {
    const reserved = this.reclaiming.get(runId);
    return reserved === undefined ? this.reserveCleanup(runId, exit, true, null, null) : reserved.catch(() => {});
  }

  private exitWaitMs(): number {
    return this.options.exitWaitMs ?? limits.STOP_GRACE_MS + 5_000;
  }

  // 결과는 모델이 쓴 믿지 않는 입력이다. 계약의 모양·크기(report_result 본문 검사)를 지나지 못하면 실패 결과로 바꾼다.
  // 그 실행의 자격 값이 어느 글에든 그대로 들어 있으면 원문 없이 고정 실패 결과로 바꾼다(서명·저장·전송 전에).
  // 어떤 입력도 여기서 던지지 않는다. 잘못된 출력이 이미 성립한 종료 증거를 뒤집지 못한다.
  private readResult(stdout: Uint8Array, credential: string | null): Result {
    const failed = (summary: string): Result => ({ role: this.profile.role, outcome: "failed", summary, items: [], refs: [] });
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
      if (credential === null) return failed(UNREADABLE_SUMMARY);
      if (mentions(value, credential)) return failed(LEAKED_SUMMARY);
      this.seal("report_result", { report_id: randomUUID(), run_id: randomUUID(), result: value }, 1);
      return value as Result;
    } catch {
      return failed(UNREADABLE_SUMMARY);
    }
  }

  private async onCancel(header: Header, body: Bodies["task_cancel"], epoch: number): Promise<void> {
    const runId = body.run_id;
    const record = this.store.run(runId);
    if (record === undefined) return;
    const cause: ExitKind = body.reason === "deadline" ? "deadline" : "cancelled";
    // 닫는 효과는 접수 영수증의 저장과 무관하게 첫 await 전에 시작한다. 진행 중인 실행의 자격 요청과 spawn도 여기서 막힌다.
    const active = this.active?.runId === runId ? this.active : undefined;
    if (active !== undefined) {
      active.cause ??= cause;
      active.controller.abort();
    }
    // 끝났다고 확인하지 못한 실행은 다시 끝내고 센다. 0이면 그때 종료 확인 영수증을 낸다.
    // 이 실행의 첫 종료가 미확인을 메모리에 남겼으면 그 기록의 파일 쓰기를 기다리지 않는다. 다른 실행이 도는 동안에는 공간에 신호를 보내지 않는다.
    const firstExitUnknown = active !== undefined && record.state === "unknown_running";
    const uncertain = firstExitUnknown || (this.active === undefined && (record.state === "unknown_running" || this.store.suspectRun(runId)));
    const reclaiming = uncertain ? this.reclaim(runId, record.exit ?? cause) : undefined;
    const answered = await this.answerCancel(header, runId, epoch);
    if (reclaiming !== undefined) return reclaiming;
    if (active === undefined && answered !== undefined) this.resendLatest(runId, [answered]);
  }

  // 같은 요청·같은 본문의 재전송이면 같은 영수증을 다시 보내고, 새 요청이면 지금 세대·지금 연결일 때만 그 요청의 영수증을 낸다.
  // 쓰는 중인 영수증도 조회에 보이므로 같은 요청에 새 ID를 만들지 않는다. 같은 요청 ID에 다른 본문이면 답하지 않는다.
  private async answerCancel(header: Header, runId: string, epoch: number): Promise<OutboxEntry | undefined> {
    const find = () =>
      this.store
        .validEvents(runId)
        .find((entry) => entry.action === "receipt_accepted" && entry.body.instruction === "task_cancel" && entry.body.instruction_request_id === header.request_id);
    const prior = find();
    if (prior !== undefined) {
      if (this.store.instructionDigest(prior.id) !== header.body_digest) return undefined;
      this.transmit(prior);
      return prior;
    }
    if (!this.authorized(header.stop_generation, epoch)) return undefined;
    await this.emit("receipt_accepted", runId, { run_id: runId, instruction_request_id: header.request_id, instruction: "task_cancel" }, header.body_digest);
    return find();
  }

  // 기한·임대가 이미 지났으면 지금 닫는다. 감시 주기(tick)보다 갱신이 먼저 와도 지난 임대를 늘리지 않는다.
  // 끝난 것을 이미 본 실행은 그 시각으로 exitOf가 판정한다(stdout을 읽거나 정리하는 사이의 시계로 닫지 않는다).
  private expire(active: Active, record: RunRecord): boolean {
    if (active.exitedAt !== null) return active.cause !== null;
    const now = this.now();
    if (now >= record.deadline_at) active.cause ??= "deadline";
    // 임대가 끝났다: 감독의 갱신이 끊겼다. 실패로 닫는다. 종료 확인 영수증은 다른 길과 같이 남은 수 0을 본 뒤에만 낸다.
    else if (now >= record.lease_until) active.cause ??= "failed";
    if (active.cause === null) return false;
    active.controller.abort();
    return true;
  }

  private async onRenew(header: Header, body: Bodies["run_renew"], epoch: number): Promise<void> {
    const record = this.store.run(body.run_id);
    const active = this.active?.runId === body.run_id ? this.active : undefined;
    if (record === undefined || active === undefined || (record.state !== "preparing" && record.state !== "running")) return;
    // 끝난 프로그램의 임대는 늘리지 않는다. 한 번 닫힌 실행(취소, 기한, 임대 만료)의 권한도 되살리지 않는다.
    if (active.exitedAt !== null || this.expire(active, record) || active.cause !== null) return;
    if (!this.authorized(header.stop_generation, epoch)) return;
    if (body.lease_until > record.lease_until) await this.transition(body.run_id, { lease_until: body.lease_until });
  }

  // 새 요청에 답하거나 지우기 전의 확인: 장부가 설명하는 실행이고, 지금 세대·지금 연결이고, 성공 확정이면 digest가 실행기가 보낸 결과와 같다.
  private mayFinalize(header: Header, body: Bodies["result_finalize"], epoch: number): boolean {
    const record = this.store.run(body.run_id);
    if (record === undefined || this.store.suspectRun(body.run_id) || !this.authorized(header.stop_generation, epoch)) return false;
    return body.outcome !== "succeeded" || this.resultMatches(record, body.result_digest);
  }

  private async onFinalize(header: Header, body: Bodies["result_finalize"], epoch: number): Promise<void> {
    const runId = body.run_id;
    const record = this.store.run(runId);
    if (record === undefined) return;
    if (this.resendCleaned(runId, header)) return;
    if (record.cleanup?.request_id === header.request_id && record.cleanup.instruction_digest !== header.body_digest) return;
    if (!this.mayFinalize(header, body, epoch)) return;
    const ongoing = this.cleaning.get(runId);
    if (ongoing !== undefined) {
      await ongoing;
      // 기다린 사이 세대·연결이 바뀌었을 수 있다. 지금도 맞을 때만 이 요청에 답한다.
      if (this.mayFinalize(header, body, epoch) && this.store.run(runId)?.state === "finalized") await this.answerCleaned(runId, header);
      return;
    }
    if (record.state === "finalized") return this.answerCleaned(runId, header);
    // 프로세스가 살아 있을 수 있는 실행은 지우지 않는다. 쓰는 중인 파일을 지우거나 자격을 거둔 척하게 된다.
    if (!MAY_CLEAN.includes(record.state) || !this.store.settled(runId)) return;
    // 점유가 hello의 상한에 이르렀으면 점유하지 않던 실행에 새 정리를 예약하지 않는다(아홉째 점유가 생기면 인사할 수 없어 정리 재시도도 받지 못한다).
    // 이미 점유 중인 실행의 재시도는 받는다. 여기서 clean의 메모리 예약까지 await가 없다.
    const occupying = this.occupying();
    if (occupying.length >= limits.STATUS_MAX_RUNS && !occupying.some((run) => run.run_id === runId)) return;
    // 첫 await 전에 슬롯을 쥔다. 같은 실행의 다른 확정은 이 작업에 합류한다.
    const work = this.clean(runId, header, epoch);
    this.cleaning.set(runId, work);
    try {
      await work;
    } finally {
      this.cleaning.delete(runId);
    }
    // 먼저 남은 정리 의도의 요청이 이 정리를 맡았으면, 그 사실이 확정된 뒤 이 요청에 따로 답한다.
    const finished = this.store.run(runId);
    if (finished?.state === "finalized" && finished.cleanup?.request_id !== header.request_id && this.mayFinalize(header, body, epoch)) await this.answerCleaned(runId, header);
  }

  // 정리 의도를 먼저 지속한 뒤 지운다. 디스크에서도 슬롯을 쥐고(cleanup_pending), 재시작하면 정해 둔 영수증 ID로 잇는다.
  // 끝나지 않은 의도의 요청은 바꾸지 않는다. 후속 요청이 지우기를 이어도 영수증은 처음 요청의 ID로 남는다.
  // 지우기가 끝나지 않으면 슬롯을 쥔 채로 둔다. 삭제의 소유를 확인할 수 없으므로 시간 초과로 놓지 않는다.
  private async clean(runId: string, header: Header, epoch: number): Promise<void> {
    const intent = this.store.run(runId)?.cleanup ?? { request_id: header.request_id, instruction_digest: header.body_digest, receipt_id: randomUUID() };
    const saved = await this.transition(runId, { state: "cleanup_pending", cleanup: intent });
    // 의도를 적는 사이 바뀌었을 수 있다. 여기서 지우기 호출까지 await가 없다.
    if (!saved || !this.authorized(header.stop_generation, epoch)) return;
    let cleaned: boolean;
    try {
      cleaned = await this.options.space.clean(runId);
    } catch {
      cleaned = false;
    }
    if (!cleaned) return;
    const fields = { run_id: runId, instruction_request_id: intent.request_id, cleaned_at: this.now() };
    const event = this.event("receipt_cleaned", runId, fields, intent.instruction_digest, intent.receipt_id);
    await this.transition(runId, { state: "finalized" }, [event]);
  }

  // 이미 낸 같은 요청의 정리 영수증이 있으면 true다. 본문까지 같을 때만 같은 사실을 다시 보내고, 같은 요청 ID에 다른 본문이면 답하지 않는다.
  private resendCleaned(runId: string, header: Header): boolean {
    const answered = this.store.validEvents(runId).find((entry) => entry.action === "receipt_cleaned" && entry.body.instruction_request_id === header.request_id);
    if (answered === undefined) return false;
    if (this.store.instructionDigest(answered.id) === header.body_digest) this.transmit(answered);
    return true;
  }

  private resultMatches(record: RunRecord, digest: string | null): boolean {
    const report = this.store.validEvents(record.run_id).find((entry) => entry.action === "report_result" && this.store.persisted(entry.id));
    return report !== undefined && digest !== null && resultDigest(report.body.result as Result) === digest;
  }

  // 이미 지운 실행의 새 요청. 같은 정리 사실(cleaned_at)로 그 요청의 영수증을 낸다.
  private async answerCleaned(runId: string, header: Header): Promise<void> {
    if (this.resendCleaned(runId, header)) return;
    const first = this.store.validEvents(runId).find((entry) => entry.action === "receipt_cleaned");
    if (first === undefined) return;
    await this.emit("receipt_cleaned", runId, { run_id: runId, instruction_request_id: header.request_id, cleaned_at: first.body.cleaned_at }, header.body_digest);
  }

  private onStatus(header: Header, body: Bodies["status_query"], epoch: number): void {
    if (this.outlet.epoch() !== epoch || !this.generationSettled()) return;
    const runs = body.run_ids.map((runId) => this.statusOf(runId));
    this.outlet.send(this.seal("status_report", { in_reply_to: header.request_id, runs }, 0));
  }

  // 밖으로 말하는 상태는 파일에 적힌 것이다. 장부가 설명하지 못하는 실행은 끝을 모른다고 답하고 그 포인터를 쓰지 않는다.
  private statusOf(runId: string): RunStatus {
    const record = this.store.durableRun(runId);
    if (record === undefined) return { run_id: runId, state: "not_known", run_generation: null, last_receipt_id: null };
    if (this.store.suspectRun(runId)) return { run_id: runId, state: "unknown_running", run_generation: record.run_generation, last_receipt_id: null };
    return { run_id: runId, state: record.state, run_generation: record.run_generation, last_receipt_id: record.last_receipt_id };
  }

  // ---- 시간 ----

  // 진입점이 주기로 부른다(뒤 작업). 기한과 임대를 넘긴 실행을 스스로 닫고, 받음 확인이 없는 영수증을 다시 보내고,
  // 저장 장애가 남았으면 다시 적어 본다.
  tick(): void {
    const now = this.now();
    const active = this.active;
    const record = active === undefined ? undefined : this.store.run(active.runId);
    if (active !== undefined && record !== undefined && (record.state === "preparing" || record.state === "running")) this.expire(active, record);
    const resendMs = this.options.resendMs ?? limits.RENEW_INTERVAL_MS;
    for (const entry of this.store.unacked()) {
      if (now - (this.lastSent.get(entry.id) ?? Number.NEGATIVE_INFINITY) >= resendMs) this.transmit(entry);
    }
    if (!this.store.healthy()) void this.flush();
  }

  // 적지 못한 기록을 다시 적고, 새로 적은 영수증·보고를 그때 보낸다. 장애가 풀렸으면 true(접수가 다시 열린다).
  flush(): Promise<boolean> {
    this.flushing ??= (async () => {
      try {
        const written = await this.store.flush();
        // 장애 중에 보류한 송신이 있으면 회복한 뒤 저장된 차례대로 모두 다시 보낸다(이번에 적은 사건도 그 안에 있다).
        if (this.heldSends && this.store.healthy()) {
          this.heldSends = false;
          this.resendUnacked();
        } else this.deliver(written);
        return this.store.healthy();
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  // ---- 기동 뒤 복원 ----

  // 다시 뜬 뒤, 연결하기 전에 한 번 부른다. 실행마다 대조를 동시에 시작한다: 한 실행의 보정 쓰기가 멈춰도 다른 실행의 정리는 시작된다.
  async recover(): Promise<void> {
    if (this.store.ledgerHeld()) return;
    await Promise.all(this.store.runs().map((record) => this.reconcile(record)));
  }

  // 파드 전체 재시작을 확인한 기동(D-104)이 연결 전에, recover보다 먼저 부른다. 그 실행들을 첫 종료·재정리와 같은 한 자리(reclaim →
  // confirmStopped)로 다시 끝내고 센다. 종료 영수증은 그 계수가 0일 때만 나고, 장부가 설명하지 못하는 실행은 세기만 한다.
  // recover와 따로 두는 까닭: recover는 unknown_running을 다시 세지 않고(검증된 취소가 다시 센다) 요청 밖의 실행까지 대조한다.
  // 남은 수는 생성자에 받은 cleanup이 답한다. 조립이 이 호출 동안만 그 자리를 재시작의 증거로 바꿔 넣는다(runtime.ts).
  async reclaimRestarted(runIds: readonly string[]): Promise<void> {
    if (this.store.ledgerHeld()) return;
    await Promise.all(
      runIds.map((runId) => {
        const record = this.store.run(runId);
        return record === undefined ? undefined : this.reclaim(runId, this.restartedExit(runId, record));
      }),
    );
  }

  // 재시작으로 원래 출력은 사라졌다. 결과 보고는 종료 영수증과 같은 전이에서만 나므로, 저장된 결과 보고가 없는 completed를 그대로 맺으면
  // 감독 장부는 오지 않을 결과를 checking에서 기다리며 자리를 쥔다(확정 기록이 거절된다). 그래서 새 종료 영수증은 failed로 맺는다.
  // 이미 저장된 종료 영수증은 confirmStopped가 같은 ID로 다시 쓰므로 이 값이 닿지 않는다.
  private restartedExit(runId: string, record: RunRecord): ExitKind {
    const exit = record.exit ?? "failed";
    if (exit !== "completed") return exit;
    return this.store.validEvents(runId).some((entry) => entry.action === "report_result") ? exit : "failed";
  }

  // 회복 대조가 요청을 지우기 전에 부른다. 종료 영수증은 파일에 있는데 실행 기록이 그 사건을 따라오지 못한 실행(앞선 기동의 실행 기록 쓰기 실패)을
  // recover와 같은 대조로 그 사건에 맞춰 적는다. 그 영수증이 이미 남은 0의 증거라 다시 세지 않는다. 장부가 설명하지 못하는 실행은 건드리지 않는다.
  async settleRestarted(runIds: readonly string[]): Promise<void> {
    if (this.store.ledgerHeld()) return;
    await Promise.all(
      runIds.map((runId) => {
        const record = this.store.run(runId);
        if (record === undefined || this.store.suspectRun(runId)) return undefined;
        if (!this.store.validEvents(runId).some((entry) => entry.action === "receipt_stopped")) return undefined;
        return this.reconcile(record);
      }),
    );
  }

  // 끝을 맺지 못한 모든 상태를 같은 방식으로 대조한다: 유효한 사건이 있으면 그 사건으로 최종 상태와 마지막 영수증을 맺고(같은 ID, 같은 본문),
  // 없으면 남은 수를 센다. 다시 띄우지 않는다(결과가 없어도 새 실행으로 바꾸지 않는다).
  // 시작 영수증이 없어도 띄우지 않았다는 증거는 아니므로, 종료만 확인된 실행은 not_started가 아니라 failed_stopped로 맺는다.
  // 마지막 영수증은 다시 세는 실행도 먼저 맞춘다. 계수가 양수·모름이어도 유효한 최신 영수증을 말하고, 그 뒤에 낸 영수증의 포인터가 이긴다.
  // 저장소가 후보 상태의 전제를 거절하면 그 자리에서 보류가 서므로, 끝을 맺지 못한 실행은 남은 수를 센다.
  private reconcile(record: RunRecord): Promise<unknown> {
    const runId = record.run_id;
    const unfinished = IN_FLIGHT.includes(record.state);
    if (this.store.suspectRun(runId)) return unfinished ? this.reclaim(runId, record.exit ?? "failed") : Promise.resolve();
    const entries = this.store.validEvents(runId);
    const has = (action: OutboxAction) => entries.some((entry) => entry.action === action);
    const patch: Partial<RunRecord> = {};
    if (has("receipt_cleaned")) {
      if (record.state !== "finalized") patch.state = "finalized";
    } else if (has("receipt_stopped") && (unfinished || record.state === "unknown_running")) {
      patch.state = has("report_result") ? "ready_result" : "failed_stopped";
      // 종료 값도 그 영수증을 따른다. 재시작 회복은 completed를 failed로 바꿔 영수증을 내므로(restartedExit) 그 기동이 실행 기록을 못 적었으면
      // 파일의 기록은 아직 completed다. 상태만 맞추면 실행 기록과 감독이 받은 영수증이 다른 종료 사유를 말한다.
      const exit = entries.findLast((entry) => entry.action === "receipt_stopped")!.body.exit as ExitKind;
      if (exit !== record.exit) patch.exit = exit;
    }
    const latest = entries.findLast((entry) => entry.action !== "report_result")?.id ?? null;
    if (latest !== record.last_receipt_id) patch.last_receipt_id = latest;
    const writing = Object.keys(patch).length > 0 ? this.transition(runId, patch) : Promise.resolve();
    if (!unfinished || (patch.state !== undefined && !this.store.suspectRun(runId))) return writing;
    return Promise.all([writing, this.reclaim(runId, record.exit ?? "failed")]);
  }

  // ---- 영수증·보고 ----

  private event(action: OutboxAction, runId: string, fields: Record<string, unknown>, digest: string | null = null, id: string = randomUUID()): NewEvent {
    const record = this.store.run(runId)!;
    const full = action === "report_result" ? { report_id: id, ...fields } : { receipt_id: id, ...fields };
    // 계약에 맞는 본문인지 서명해 보며 확인한다. 맞지 않으면 구현의 결함이라 던진다.
    this.seal(action, full, record.run_generation);
    return { entry: { id, action, run_id: runId, run_generation: record.run_generation, body: full, acked: false }, digest };
  }

  // 상태와 사건을 한 전이로 남기고, 이번 쓰기에서 적힌 사건을 보낸다. 앞선 전이의 쓰기가 뒤 전이의 사건까지 적을 수 있어
  // 어느 전이의 결과든 written은 언제나 보낸다. 그 전이가 모두 파일에 적혔으면 true다.
  private async transition(runId: string, patch: Partial<RunRecord>, events: readonly NewEvent[] = []): Promise<boolean> {
    const { saved, written } = await this.store.commit(runId, patch, events);
    this.deliver(written);
    return saved;
  }

  // 파일에 적었으면 true다. 적지 못한 것은 저장소가 순번을 지켜 기억했다가 flush가 적은 뒤 보낸다.
  private async emit(action: OutboxAction, runId: string, fields: Record<string, unknown>, digest: string | null = null): Promise<boolean> {
    const event = this.event(action, runId, fields, digest);
    return (await this.transition(runId, {}, [event])) && this.store.persisted(event.entry.id);
  }

  private deliver(written: readonly OutboxEntry[]): void {
    for (const entry of written) this.transmit(entry);
  }

  // 메모리와 파일의 정지 세대가 같은지. 다르면 그 머리로 서명한 봉투를 내보내지 않는다(저장이 실패하면 회수할 수 없다).
  private generationSettled(): boolean {
    return this.store.stopGeneration() === this.store.durableStopGeneration();
  }

  // 같은 본문을 새 봉투에 담아 보낸다(같은 id, 같은 body_digest). 파일에 적었고 장부가 설명하는 것만, 연결이 맞춰져 있을 때만 보낸다.
  // 세대가 파일과 어긋나거나 저장 장애가 남은 동안은 보류하고, 회복한 뒤 저장된 같은 본문을 보낸다.
  // 다시 서명할 수 없는 항목은 그 항목만 빼고 넘어간다(뒤의 정상 항목의 재전송을 막지 않는다).
  private transmit(entry: OutboxEntry): void {
    if (this.outlet.epoch() === null || this.store.stopGeneration() === null || !this.store.sendable(entry.id)) return;
    if (!this.generationSettled() || !this.store.healthy()) {
      this.heldSends = true;
      return;
    }
    let envelope: Envelope;
    try {
      envelope = this.seal(entry.action, entry.body, entry.run_generation);
    } catch (error) {
      // 본문 때문이 아니면 이번 송신만 미룬다(tick이 다시 보낸다).
      if (bodyRejected(error)) this.store.markInconsistent("outbox_body", entry.id);
      return;
    }
    this.outlet.send(envelope);
    this.lastSent.set(entry.id, this.now());
  }

  // 아는 실행의 시작 지시가 다시 왔다. 처음 접수한 지시와 본문이 같을 때만 접수 영수증과 마지막 영수증을 같은 id·같은 본문으로 다시 보낸다.
  // 본문이 다르면 답하지 않는다. 새 실행은 어느 쪽이든 열지 않는다.
  private resendFor(runId: string, bodyDigest: string): void {
    const accepted = this.store.validEvents(runId).find((entry) => entry.action === "receipt_accepted" && entry.body.instruction === "task_start");
    if (accepted === undefined || this.store.instructionDigest(accepted.id) !== bodyDigest) return;
    this.transmit(accepted);
    this.resendLatest(runId, [accepted]);
  }

  private resendLatest(runId: string, already: readonly OutboxEntry[]): void {
    const last = this.store.run(runId)?.last_receipt_id;
    if (last === null || last === undefined || already.some((entry) => entry.id === last)) return;
    const entry = this.store.validEvents(runId).find((candidate) => candidate.id === last);
    if (entry !== undefined) this.transmit(entry);
  }

  resendUnacked(): void {
    for (const entry of this.store.unacked()) this.transmit(entry);
  }

  // ---- 봉투 ----

  private seal<A extends Action>(action: A, body: unknown, runGeneration: number, key: KeyObject = this.options.signingKey): Envelope {
    return sealEnvelope(
      {
        sender: this.name,
        recipient: "supervisor",
        action,
        request_id: randomUUID(),
        // 맞춤 전(세대 없음)에 만드는 봉투는 모양 확인용이라 보내지 않는다(transmit이 세대 없음이면 보내지 않는다).
        stop_generation: action === "stop_sync_request" ? 0 : (this.store.stopGeneration() ?? 0),
        run_generation: runGeneration,
        issued_at: this.now(),
        nonce: randomBytes(16).toString("hex"),
        body: body as Bodies[A],
      },
      key,
    );
  }

  syncRequest(challenge: string): Envelope {
    return this.seal("stop_sync_request", { challenge }, 0);
  }

  // 맞춤 뒤 첫 메시지. 쥔 실행의 상태와 받음 확인을 못 받은 id를 싣는다. 감독은 이것을 시작·자격의 근거로 쓰지 않는다.
  // 끝을 모르는 실행, 슬롯을 쥔 실행, 나머지 차례로 싣는다. 확정되지 않은 실행은 refusesStart가 STATUS_MAX_RUNS개 안으로 묶고,
  // 점유·보류가 상한을 넘거나 실행 기록을 잃은 장부는 helloWithheld가 인사 직전에 막으므로 잘리는 것은 슬롯을 쥐지 않은 실행뿐이다.
  hello(): Envelope {
    const uncertain = (run: RunRecord) => run.state === "unknown_running" || this.store.suspectRun(run.run_id);
    const rank = (run: RunRecord) => (uncertain(run) ? 0 : this.occupies(run) ? 1 : 2);
    const runs = this.store
      .durableRunList()
      .filter((run) => run.state !== "finalized" || this.store.suspectRun(run.run_id))
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, limits.STATUS_MAX_RUNS)
      .map((run) => this.statusOf(run.run_id));
    const unacked = this.store
      .unacked()
      .map((entry) => entry.id)
      .slice(0, limits.ACK_MAX_IDS);
    return this.seal(
      "hello",
      { profile_revision: this.profile.revision, policy_revision: this.options.policyRevision, runs, unacked_ids: unacked },
      0,
    );
  }
}
