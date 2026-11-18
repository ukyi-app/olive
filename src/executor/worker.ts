// 작업자 실행기의 핵심: 검증을 통과한 지시를 처리하고, 고정 프로필로 한 번에 하나의 실행을 띄우고, 영수증·보고를 낸다.
// 연결의 수명(맞춤, hello, 재전송의 시점)은 link.ts가, 받아도 되는 메시지인지는 계약 모듈(verifyEnvelope)이 가른다.
//
// 지키는 것:
// - 새 정지 세대는 그 봉투의 효과보다 먼저 저장소에 적는다. 적지 못하면 종료는 계속하되 새 지시를 받지 않는다(intake 닫힘).
// - 권한이 필요한 효과(자격 요청, spawn, 임대 연장, 폴더 지우기)는 그 직전에 다시 본다: 그 지시를 받은 연결이 지금 연결인지,
//   지시의 정지 세대가 지금 세대이고 저장까지 끝났는지, 접수가 닫히지 않았는지, 취소·기한·임대. 검증 뒤의 await마다 바뀔 수 있다.
// - 띄우기 직전 확인과 spawn 사이에 await가 없다.
// - 자격은 받은 바이트의 SHA-256이 지시의 digest와 같을 때만 프로필의 이름 하나에 넣는다. 결과에 그 값이 있으면 결과를 버린다.
// - 종료 확인 영수증(receipt_stopped)은 남은 프로세스 0개를 확인한 뒤에만 낸다. 아니면 unknown_running으로 두고 슬롯을 놓지 않는다.
// - 영수증·보고는 파일에 적은 뒤에만 보낸다. 접수 영수증이 남기 전에는 자격을 받지도 띄우지도 않는다.
// - 아는 실행 ID의 시작 지시는 새 실행을 열지 않고 같은 영수증을 다시 보낸다. 결과가 없다는 이유로 다시 띄우지 않는다.
import { type KeyObject, randomBytes, randomUUID } from "node:crypto";
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
import type { ExecutorStore, ExitKind, OutboxAction, OutboxEntry, RunRecord, StoredRunState } from "./store.ts";

// 영수증·보고를 실어 보낼 곳. epoch()는 맞춘 연결마다 다른 수이고, 연결이 없거나 맞춤 전이면 null이다(보내지 않고 저장소에만 남긴다).
export interface Outlet {
  epoch(): number | null;
  send(envelope: Envelope): void;
  // 그 연결을 닫는다(세대 저장 실패). 지금 연결이 아니면 아무 일도 없다. 다시 맞추는 것은 새 연결에서다.
  drop(epoch: number): void;
}

// 실행마다 쓰는 폴더 등의 준비와 지우기. 실제 작업 폴더·tmp의 모양은 뒤 작업(O13)이 정한다.
export interface RunSpace {
  // signal이 중단되면 준비를 거둔다. 실행기는 중단 뒤 늦게 끝난 준비의 결과를 쓰지 않는다.
  prepare(runId: string, signal: AbortSignal): Promise<void>;
  // 지웠으면 true. 지우지 못했으면 false이고 그 실행은 cleanup_pending이다.
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
  // 중단 뒤 역할 프로그램의 끝과 정리(terminate)를 기다리는 상한. 넘으면 남은 수를 세고, 0이 아니면 unknown_running이다.
  exitWaitMs?: number;
  // 받음 확인이 없는 영수증·보고를 다시 보내는 간격.
  resendMs?: number;
}

// 프로세스가 살아 있을 수 있거나 정리가 남은 상태. 이 상태의 실행이 있으면 새 실행을 받지 않는다(슬롯 하나).
const HOLDS_SLOT: readonly StoredRunState[] = ["preparing", "running", "stopping", "checking", "unknown_running", "cleanup_pending"];
// 정리(result_finalize)를 받아도 되는 상태: 프로세스 0개를 이미 확인했다.
const MAY_CLEAN: readonly StoredRunState[] = ["ready_result", "failed_stopped", "not_started", "cleanup_pending"];
const RECEIPTS: readonly OutboxAction[] = ["receipt_accepted", "receipt_started", "receipt_stopped", "receipt_cleaned"];
const UNREADABLE_SUMMARY = "역할 프로그램의 결과를 계약의 모양으로 읽지 못했다";
const LEAKED_SUMMARY = "역할 프로그램의 결과에 그 실행의 자격 값이 들어 있어 결과를 버렸다";

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

// 끝나거나 ms가 지나면 돌아온다(정리가 돌아오지 않아도 남은 수를 세러 간다).
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work.then(() => {}, () => {}), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}

// 중단되면 기다리기를 그만둔다. 늦게 끝난 작업의 결과는 버린다(Promise.race가 거절을 받아 두므로 처리되지 않은 거절도 남지 않는다).
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// 결과의 모든 글(값과 이름)에 자격 값이 들어 있는지.
function mentions(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value)) return value.some((item) => mentions(item, secret));
  if (typeof value === "object" && value !== null) return Object.entries(value).some(([key, item]) => key.includes(secret) || mentions(item, secret));
  return false;
}

export class WorkerExecutor {
  readonly name: string;
  readonly profile: RoleProfile;
  private outlet: Outlet = { epoch: () => null, send: () => {}, drop: () => {} };
  private active: Active | undefined;
  private stopUnsaved = false;
  // 지우는 중인 실행. 첫 await 전에 넣어 슬롯을 쥐고, 같은 실행의 확정은 진행 중인 작업에 합류한다.
  private readonly cleaning = new Map<string, Promise<void>>();
  private readonly lastSent = new Map<string, number>();
  private readonly now: () => number;
  private readonly launcher: Launcher;
  private flushing: Promise<boolean> | undefined;

  constructor(private readonly options: WorkerOptions) {
    this.profile = fixProfile(options.profile);
    this.name = executorName(this.profile.role, options.instance, options.store.storageId);
    this.now = options.now ?? Date.now;
    this.launcher = options.launcher ?? bunLauncher;
    // 저장된 본문이 계약의 모양인지 서명해 보며 대조한다. 맞지 않는 본문은 다시 보낼 수 없으므로 장부가 설명되지 않는 것과 같다.
    for (const entry of options.store.outboxAll()) {
      try {
        this.seal(entry.action, entry.body, entry.run_generation);
      } catch {
        options.store.markInconsistent("outbox_body");
      }
    }
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
  // 적은 뒤 파일과 메모리가 같은 세대면 저장 장애로 닫힌 접수를 연다.
  async adopt(generation: number): Promise<boolean> {
    const { saved } = await this.store.adoptStopGeneration(generation);
    if (!saved) this.stopUnsaved = true;
    else if (this.store.durableStopGeneration() === this.store.stopGeneration()) this.stopUnsaved = false;
    return saved;
  }

  // 맞춤 답의 세대를 적는다(link.ts). 같은 세대여도 파일이 낮으면 적는다. 파일·메모리가 모두 그 세대가 되었을 때만 true다.
  async syncTo(generation: number): Promise<boolean> {
    const saved = await this.adopt(generation);
    return saved && this.store.stopGeneration() === generation && this.store.durableStopGeneration() === generation;
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
      // 비상 종료. 세대를 먼저 적고, 적지 못했으면 이 연결은 닫되 종료는 계속한다.
      if (!(await this.adopt(verified.adoptedStopGeneration))) this.outlet.drop(epoch);
      if (verified.action === "task_cancel") return this.onCancel(verified.header, verified.body);
      return;
    }
    switch (verified.action) {
      case "task_start":
        return this.onStart(verified.header, verified.body, epoch);
      case "task_cancel":
        // 멈추는 효과는 세대가 지난 지시여도 막지 않는다(더 높은 세대의 비상 종료와 같은 쪽의 효과다).
        return this.onCancel(verified.header, verified.body);
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
      this.resendFor(runId);
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
      accepted = await this.emit("receipt_accepted", runId, { run_id: runId, instruction_request_id: header.request_id, instruction: "task_start" });
    } catch (error) {
      finish();
      throw error;
    }
    // 실행은 지시 처리와 따로 돈다. 그동안 온 취소·갱신·조회를 처리해야 한다.
    // 실행 중 예외로 끝나면 프로세스가 남았는지 모르므로 unknown_running으로 두고 슬롯을 놓지 않는다.
    // 접수 영수증을 적지 못했으면 띄우지 않고 닫는다(재전송할 수 없는 접수로 모델을 띄우지 않는다).
    const work = accepted ? this.execute(runId, active) : this.notStarted(runId, "failed");
    void work.catch(() => this.update(runId, { state: "unknown_running" }).catch(() => {})).finally(finish);
  }

  private async execute(runId: string, active: Active): Promise<void> {
    const record = this.store.run(runId)!;
    const signal = active.controller.signal;
    let plan: LaunchPlan;
    let credential: string;
    try {
      await abortable(this.options.space.prepare(runId, signal), signal);
      // 자격을 요청하기 직전과 받은 직후에 다시 본다(연결, 세대, 취소, 기한, 임대).
      const before = this.launchBlocked(runId, active);
      if (before !== null) return this.notStarted(runId, before);
      const value = await abortable(this.options.credentials.take(runId, record.credential_digest, signal), signal).catch(() => null);
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
    }
    // 띄우기 직전 확인. 여기서 launcher의 spawn까지 await가 없다.
    const blocked = this.launchBlocked(runId, active);
    if (blocked !== null) return this.notStarted(runId, blocked);
    let started: Promise<void> = Promise.resolve();
    let spawned = false;
    let outcome: LaunchOutcome | null = null;
    try {
      outcome = await this.launcher.run(plan, signal, {
        busy: () => this.options.cleanup.busy(),
        terminate: () => this.options.cleanup.terminate(),
        spawned: () => {
          spawned = true;
          started = this.markStarted(runId, record.instruction_request_id);
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
    await started;
    if (!spawned) return this.notStarted(runId, active.cause ?? "failed");
    const exit = this.exitOf(runId, active, outcome);
    await this.confirmStopped(runId, exit, true, exit === "completed" ? (outcome?.stdout ?? null) : null, credential);
  }

  // 0으로 끝났어도 끝난 시각이 기한·임대를 넘었으면 completed가 아니다(감시 주기 사이에 넘긴 경우).
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

  // 자격 요청과 spawn 직전의 확인. 하나라도 걸리면 띄우지 않는다.
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
    if (!this.store.outboxFor(runId).some((entry) => entry.action === "receipt_accepted" && this.store.persisted(entry.id))) return "failed";
    return null;
  }

  private async markStarted(runId: string, requestId: string): Promise<void> {
    await this.update(runId, { state: "running" });
    await this.emit("receipt_started", runId, { run_id: runId, instruction_request_id: requestId, started_at: this.now() });
  }

  private notStarted(runId: string, exit: ExitKind): Promise<void> {
    return this.confirmStopped(runId, exit, false, null, null);
  }

  // 남은 프로세스를 끝내고 센다. 0개일 때만 종료 확인 영수증을 낸다. 띄우지 않은 실행도 센다(세는 쪽이 0을 말해야 낸다).
  // 한 실행의 종료 확인 영수증과 결과 보고는 하나다. 이미 있으면(재시작 뒤 이어 가기) 새로 만들지 않고 그것을 다시 보낸다.
  private async confirmStopped(runId: string, exit: ExitKind, launched: boolean, stdout: Uint8Array | null, credential: string | null): Promise<void> {
    const cleanup = this.options.cleanup;
    if (launched) {
      await this.update(runId, { state: "stopping", exit });
      await within(cleanup.terminate(), this.exitWaitMs());
    }
    const survivors = await cleanup.survivors().catch(() => null);
    if (survivors !== 0) {
      await this.update(runId, { state: "unknown_running", exit });
      return;
    }
    await this.update(runId, { state: "checking", exit });
    await this.emitOnce("receipt_stopped", runId, { run_id: runId, remaining_processes: 0, exit, stopped_at: this.now() });
    if (exit !== "completed" || stdout === null) {
      await this.update(runId, { state: launched ? "failed_stopped" : "not_started" });
      return;
    }
    await this.emitOnce("report_result", runId, { run_id: runId, result: this.readResult(stdout, credential) });
    await this.update(runId, { state: "ready_result" });
  }

  private exitWaitMs(): number {
    return this.options.exitWaitMs ?? limits.STOP_GRACE_MS + 5_000;
  }

  // 결과는 모델이 쓴 믿지 않는 입력이다. 계약의 모양·크기(report_result 본문 검사)를 지나지 못하면 실패 결과로 바꾼다.
  // 그 실행의 자격 값이 어느 글에든 들어 있으면 원문 없이 고정 실패 결과로 바꾼다(서명·저장·전송 전에).
  private readResult(stdout: Uint8Array, credential: string | null): Result {
    const failed = (summary: string): Result => ({ role: this.profile.role, outcome: "failed", summary, items: [], refs: [] });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
    } catch {
      return failed(UNREADABLE_SUMMARY);
    }
    if (credential === null || mentions(value, credential)) return failed(credential === null ? UNREADABLE_SUMMARY : LEAKED_SUMMARY);
    try {
      this.seal("report_result", { report_id: randomUUID(), run_id: randomUUID(), result: value }, 1);
      return value as Result;
    } catch {
      return failed(UNREADABLE_SUMMARY);
    }
  }

  private async onCancel(header: Header, body: Bodies["task_cancel"]): Promise<void> {
    const runId = body.run_id;
    const record = this.store.run(runId);
    if (record === undefined) return;
    const cause: ExitKind = body.reason === "deadline" ? "deadline" : "cancelled";
    // 첫 I/O 전에 그 실행의 자격 요청과 spawn을 막는다(접수 영수증을 쓰는 동안 준비가 끝나도 띄우지 않는다).
    const active = this.active?.runId === runId ? this.active : undefined;
    if (active !== undefined) {
      active.cause ??= cause;
      active.controller.abort();
    }
    // 같은 요청의 재전송이면 같은 영수증, 다른 요청이면 그 요청의 영수증을 새로 낸다(멈추는 효과는 반복해도 같다).
    const answer = () =>
      this.store
        .outboxFor(runId)
        .filter((entry) => entry.action === "receipt_accepted" && entry.body.instruction === "task_cancel" && entry.body.instruction_request_id === header.request_id);
    const prior = answer();
    if (prior.length > 0) this.transmit(prior[0]!);
    else await this.emit("receipt_accepted", runId, { run_id: runId, instruction_request_id: header.request_id, instruction: "task_cancel" });
    if (active !== undefined) return;
    // 끝났다고 확인하지 못한 실행은 다시 끝내고 센다. 0이면 그때 종료 확인 영수증을 낸다.
    const latest = this.store.run(runId)!;
    if (latest.state === "unknown_running" && this.active === undefined) return this.confirmStopped(runId, latest.exit ?? cause, true, null, null);
    this.resendLatest(runId, answer());
  }

  // 기한·임대가 이미 지났으면 지금 닫는다. 감시 주기(tick)보다 갱신이 먼저 와도 지난 임대를 늘리지 않는다.
  private expire(active: Active, record: RunRecord): boolean {
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
    // 한 번 닫힌 실행(취소, 기한, 임대 만료)의 권한은 되살리지 않는다.
    if (this.expire(active, record) || active.cause !== null) return;
    if (!this.authorized(header.stop_generation, epoch)) return;
    if (body.lease_until > record.lease_until) await this.update(body.run_id, { lease_until: body.lease_until });
  }

  private async onFinalize(header: Header, body: Bodies["result_finalize"], epoch: number): Promise<void> {
    const runId = body.run_id;
    const ongoing = this.cleaning.get(runId);
    if (ongoing !== undefined) {
      await ongoing;
      if (this.store.run(runId)?.state === "finalized") await this.answerCleaned(runId, header.request_id);
      return;
    }
    const record = this.store.run(runId);
    if (record === undefined) return;
    if (record.state === "finalized") return this.answerCleaned(runId, header.request_id);
    if (!this.authorized(header.stop_generation, epoch)) return;
    // 프로세스가 살아 있을 수 있는 실행은 지우지 않는다. 쓰는 중인 파일을 지우거나 자격을 거둔 척하게 된다.
    if (!MAY_CLEAN.includes(record.state)) return;
    // 성공 확정은 감독이 저장한 결과가 실행기가 보낸 결과와 같을 때만 지운다. 결과가 없거나 다르면 보류한다.
    if (body.outcome === "succeeded" && !this.resultMatches(record, body.result_digest)) return;
    // 첫 await 전에 슬롯을 쥔다. 같은 실행의 다른 확정은 이 작업에 합류한다.
    const work = this.clean(runId, header.request_id);
    this.cleaning.set(runId, work);
    try {
      await work;
    } finally {
      this.cleaning.delete(runId);
    }
  }

  private async clean(runId: string, requestId: string): Promise<void> {
    const cleaned = await this.options.space.clean(runId).catch(() => false);
    if (!cleaned) {
      await this.update(runId, { state: "cleanup_pending" });
      return;
    }
    await this.emit("receipt_cleaned", runId, { run_id: runId, instruction_request_id: requestId, cleaned_at: this.now() });
    await this.update(runId, { state: "finalized" });
  }

  private resultMatches(record: RunRecord, digest: string | null): boolean {
    const report = this.store
      .outboxFor(record.run_id)
      .find((entry) => entry.action === "report_result" && entry.run_generation === record.run_generation);
    return report !== undefined && digest !== null && resultDigest(report.body.result as Result) === digest;
  }

  // 이미 지운 실행의 확정. 같은 요청이면 같은 정리 영수증, 다른 요청이면 같은 정리 사실(cleaned_at)로 그 요청의 영수증을 낸다.
  private async answerCleaned(runId: string, requestId: string): Promise<void> {
    const cleaned = this.store.outboxFor(runId).filter((entry) => entry.action === "receipt_cleaned");
    const same = cleaned.find((entry) => entry.body.instruction_request_id === requestId);
    if (same !== undefined) return this.transmit(same);
    const first = cleaned[0];
    if (first === undefined) return;
    await this.emit("receipt_cleaned", runId, { run_id: runId, instruction_request_id: requestId, cleaned_at: first.body.cleaned_at });
  }

  private onStatus(header: Header, body: Bodies["status_query"], epoch: number): void {
    if (this.outlet.epoch() !== epoch) return;
    const runs = body.run_ids.map((runId) => this.statusOf(runId));
    this.outlet.send(this.seal("status_report", { in_reply_to: header.request_id, runs }, 0));
  }

  private statusOf(runId: string): RunStatus {
    const record = this.store.run(runId);
    if (record === undefined) return { run_id: runId, state: "not_known", run_generation: null, last_receipt_id: null };
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
        for (const entry of written) {
          if (RECEIPTS.includes(entry.action)) await this.update(entry.run_id, { last_receipt_id: entry.id });
          this.transmit(entry);
        }
        return this.store.healthy();
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  // ---- 기동 뒤 복원 ----

  // 다시 뜬 뒤, 연결하기 전에 한 번 부른다. 프로세스가 살아 있을 수 있던 실행은 남은 수를 센다.
  // 0이면 끝난 것으로 확인하고 영수증을 낸다. 다시 띄우지 않는다(결과가 없어도 새 실행으로 바꾸지 않는다).
  // checking은 0을 확인한 뒤의 상태다. 종료 확인 영수증이 이미 적혔으면 같은 영수증으로 이어 가고 마지막 상태만 적는다.
  async recover(): Promise<void> {
    for (const record of this.store.runs()) {
      const exit = record.exit ?? "failed";
      if (record.state === "checking") {
        const entries = this.store.outboxFor(record.run_id).filter((entry) => entry.run_generation === record.run_generation);
        if (entries.some((entry) => entry.action === "receipt_stopped")) {
          const reported = entries.some((entry) => entry.action === "report_result");
          const launched = entries.some((entry) => entry.action === "receipt_started");
          await this.update(record.run_id, { state: reported ? "ready_result" : launched ? "failed_stopped" : "not_started" });
          continue;
        }
      }
      if (record.state === "preparing" || record.state === "running" || record.state === "stopping" || record.state === "checking") {
        await this.confirmStopped(record.run_id, exit, true, null, null);
      }
    }
  }

  // ---- 영수증·보고 ----

  private async update(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const record = this.store.run(runId);
    if (record !== undefined) await this.store.noteRun({ ...record, ...patch });
  }

  // 파일에 적었으면 true이고 그때만 보낸다. 적지 못한 것은 저장소가 기억했다가 flush가 적은 뒤 보낸다.
  private async emit(action: OutboxAction, runId: string, fields: Record<string, unknown>): Promise<boolean> {
    const record = this.store.run(runId)!;
    const id = randomUUID();
    const full = action === "report_result" ? { report_id: id, ...fields } : { receipt_id: id, ...fields };
    // 계약에 맞는 본문인지 서명해 보며 확인한다. 맞지 않으면 구현의 결함이라 던진다.
    this.seal(action, full, record.run_generation);
    const entry: OutboxEntry = { id, action, run_id: runId, run_generation: record.run_generation, body: full, acked: false };
    const saved = await this.store.addOutbox(entry);
    if (!saved) return false;
    if (RECEIPTS.includes(action)) await this.update(runId, { last_receipt_id: id });
    this.transmit(entry);
    return true;
  }

  private async emitOnce(action: "receipt_stopped" | "report_result", runId: string, fields: Record<string, unknown>): Promise<boolean> {
    const generation = this.store.run(runId)?.run_generation;
    const existing = this.store.outboxFor(runId).find((entry) => entry.action === action && entry.run_generation === generation);
    if (existing === undefined) return this.emit(action, runId, fields);
    this.transmit(existing);
    return this.store.persisted(existing.id);
  }

  // 같은 본문을 새 봉투에 담아 보낸다(같은 id, 같은 body_digest). 파일에 적은 것만, 연결이 맞춰져 있을 때만 보낸다.
  private transmit(entry: OutboxEntry): void {
    if (this.outlet.epoch() === null || this.store.stopGeneration() === null || !this.store.persisted(entry.id)) return;
    this.outlet.send(this.seal(entry.action, entry.body, entry.run_generation));
    this.lastSent.set(entry.id, this.now());
  }

  // 아는 실행의 시작 지시가 다시 왔다. 그 실행의 접수 영수증과 마지막 영수증을 같은 id·같은 본문으로 다시 보낸다(새 실행은 열지 않는다).
  private resendFor(runId: string): void {
    const wanted = this.store.outboxFor(runId).filter((entry) => entry.action === "receipt_accepted" && entry.body.instruction === "task_start");
    for (const entry of wanted) this.transmit(entry);
    this.resendLatest(runId, wanted);
  }

  private resendLatest(runId: string, already: readonly OutboxEntry[] = []): void {
    const last = this.store.run(runId)?.last_receipt_id;
    if (last === null || last === undefined || already.some((entry) => entry.id === last)) return;
    const entry = this.store.outbox(last);
    if (entry !== undefined) this.transmit(entry);
  }

  resendUnacked(): void {
    for (const entry of this.store.unacked()) this.transmit(entry);
  }

  // ---- 봉투 ----

  private seal<A extends Action>(action: A, body: unknown, runGeneration: number): Envelope {
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
      this.options.signingKey,
    );
  }

  syncRequest(challenge: string): Envelope {
    return this.seal("stop_sync_request", { challenge }, 0);
  }

  // 맞춤 뒤 첫 메시지. 쥔 실행의 상태와 받음 확인을 못 받은 id를 싣는다. 감독은 이것을 시작·자격의 근거로 쓰지 않는다.
  // 슬롯을 쥐었거나 끝을 확인하지 못한 실행을 앞에 둔다. 확정되지 않은 실행은 refusesStart가 STATUS_MAX_RUNS개 안으로 묶는다.
  hello(): Envelope {
    const rank = (run: RunRecord) => (HOLDS_SLOT.includes(run.state) ? 0 : 1);
    const runs = this.store
      .runs()
      .filter((run) => run.state !== "finalized")
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
