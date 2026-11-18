// 작업자 실행기의 핵심: 검증을 통과한 지시를 처리하고, 고정 프로필로 한 번에 하나의 실행을 띄우고, 영수증·보고를 낸다.
// 연결의 수명(맞춤, hello, 재전송의 시점)은 link.ts가, 받아도 되는 메시지인지는 계약 모듈(verifyEnvelope)이 가른다.
//
// 지키는 것:
// - 새 정지 세대는 그 봉투의 효과보다 먼저 저장소에 적는다. 적지 못하면 종료는 계속하되 새 지시를 받지 않는다(intake 닫힘).
// - 띄우기 직전에 작업 기한, 정지 세대, 연결, 취소, 임대를 다시 본다. 그 확인과 spawn 사이에 await가 없다.
// - 자격은 연결이 살아 있을 때만 받고, 받은 바이트의 SHA-256이 지시의 digest와 같을 때만 프로필의 이름 하나에 넣는다.
// - 종료 확인 영수증(receipt_stopped)은 남은 프로세스 0개를 확인한 뒤에만 낸다. 아니면 unknown_running으로 두고 슬롯을 놓지 않는다.
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

// 영수증·보고를 실어 보낼 곳. live()가 false면(연결 없음, 맞춤 전) 보내지 않고 저장소에만 남긴다.
export interface Outlet {
  live(): boolean;
  send(envelope: Envelope): void;
}

// 실행마다 쓰는 폴더 등의 준비와 지우기. 실제 작업 폴더·tmp의 모양은 뒤 작업(O13)이 정한다.
export interface RunSpace {
  prepare(runId: string): Promise<void>;
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
  // 받음 확인이 없는 영수증·보고를 다시 보내는 간격.
  resendMs?: number;
}

// 프로세스가 살아 있을 수 있거나 정리가 남은 상태. 이 상태의 실행이 있으면 새 실행을 받지 않는다(슬롯 하나).
const HOLDS_SLOT: readonly StoredRunState[] = ["preparing", "running", "stopping", "checking", "unknown_running", "cleanup_pending"];
// 정리(result_finalize)를 받아도 되는 상태: 프로세스 0개를 이미 확인했다.
const MAY_CLEAN: readonly StoredRunState[] = ["ready_result", "failed_stopped", "not_started", "cleanup_pending"];
const RECEIPTS: readonly OutboxAction[] = ["receipt_accepted", "receipt_started", "receipt_stopped", "receipt_cleaned"];
const UNREADABLE_SUMMARY = "역할 프로그램의 결과를 계약의 모양으로 읽지 못했다";

interface Active {
  runId: string;
  controller: AbortController;
  cause: ExitKind | null;
  done: Promise<void>;
}

export type IntakeClosed = "stop_generation_unsaved";

export class WorkerExecutor {
  readonly name: string;
  readonly profile: RoleProfile;
  private outlet: Outlet = { live: () => false, send: () => {} };
  private active: Active | undefined;
  private closed: IntakeClosed | null = null;
  private readonly lastSent = new Map<string, number>();
  private readonly now: () => number;
  private readonly launcher: Launcher;

  constructor(private readonly options: WorkerOptions) {
    this.profile = fixProfile(options.profile);
    this.name = executorName(this.profile.role, options.instance, options.store.storageId);
    this.now = options.now ?? Date.now;
    this.launcher = options.launcher ?? bunLauncher;
  }

  private get store(): ExecutorStore {
    return this.options.store;
  }

  attach(outlet: Outlet): void {
    this.outlet = outlet;
  }

  intakeClosed(): IntakeClosed | null {
    return this.closed;
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
  async adopt(generation: number): Promise<boolean> {
    const { saved } = await this.store.adoptStopGeneration(generation);
    if (!saved) this.closed = "stop_generation_unsaved";
    return saved;
  }

  // 검증을 통과한 봉투 하나를 처리한다. stop_sync_reply의 세대는 link.ts가 adopt로 적는다.
  async handle(verified: Verified): Promise<void> {
    if (verified.adoptedStopGeneration !== null && verified.action !== "stop_sync_reply") await this.adopt(verified.adoptedStopGeneration);
    switch (verified.action) {
      case "task_start":
        return this.onStart(verified.header, verified.body);
      case "task_cancel":
        return this.onCancel(verified.header, verified.body);
      case "run_renew":
        return this.onRenew(verified.body);
      case "result_finalize":
        return this.onFinalize(verified.header, verified.body);
      case "status_query":
        return this.onStatus(verified.header, verified.body);
      case "ack":
        await this.store.ack(verified.body.ids);
        return;
      default:
        // 세션 지시는 받는 쪽이 세션 실행기라 계약이 wrong_direction으로 거절한다. 영수증·보고·hello는 실행기가 받는 동작이 아니다.
        return;
    }
  }

  // ---- 지시 ----

  private refusesStart(body: Bodies["task_start"]): boolean {
    if (this.closed !== null || !this.outlet.live() || this.active !== undefined) return true;
    if (this.store.runs().some((run) => HOLDS_SLOT.includes(run.state))) return true;
    return body.profile_revision !== this.profile.revision || body.policy_revision !== this.options.policyRevision;
  }

  private async onStart(header: Header, body: Bodies["task_start"]): Promise<void> {
    const runId = body.run_id;
    if (this.store.run(runId) !== undefined) {
      this.resendFor(runId, "task_start");
      return;
    }
    if (this.refusesStart(body)) return;
    // 슬롯은 첫 await 전에 잡는다. 같은 때 온 다른 시작 지시가 함께 지나가지 않는다.
    let release!: () => void;
    const active: Active = { runId, controller: new AbortController(), cause: null, done: new Promise((resolve) => (release = resolve)) };
    this.active = active;
    const finish = () => {
      if (this.active === active) this.active = undefined;
      release();
    };
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
      await this.emit("receipt_accepted", runId, { run_id: runId, instruction_request_id: header.request_id, instruction: "task_start" });
    } catch (error) {
      finish();
      throw error;
    }
    // 실행은 지시 처리와 따로 돈다. 그동안 온 취소·갱신·조회를 처리해야 한다.
    // 실행 중 예외로 끝나면 프로세스가 남았는지 모르므로 unknown_running으로 두고 슬롯을 놓지 않는다.
    void this.execute(runId, active)
      .catch(() => this.update(runId, { state: "unknown_running" }).catch(() => {}))
      .finally(finish);
  }

  private async execute(runId: string, active: Active): Promise<void> {
    const record = this.store.run(runId)!;
    let plan: LaunchPlan;
    try {
      await this.options.space.prepare(runId);
      // 연결이 없으면 자격을 받지 않는다(새 자격 0).
      if (!this.outlet.live()) return this.notStarted(runId, active.cause ?? "failed");
      const value = await this.options.credentials.take(runId, record.credential_digest).catch(() => null);
      if (value === null || !credentialMatches(value, record.credential_digest)) return this.notStarted(runId, "failed");
      const credential = credentialText(value);
      if (credential === null) return this.notStarted(runId, "failed");
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
      outcome = await this.launcher.run(plan, active.controller.signal, {
        busy: () => this.options.cleanup.busy(),
        terminate: () => this.options.cleanup.terminate(),
        spawned: () => {
          spawned = true;
          started = this.markStarted(runId, record.instruction_request_id);
        },
        outputBytes: this.options.outputBytes ?? 64 * 1024,
        drainMs: this.options.drainMs,
      });
    } catch {
      // 프로세스가 생기기 전 실패이거나(LaunchFailed) 지켜보다 실패했다. 어느 쪽이든 아래에서 남은 수를 센다.
    }
    await started;
    if (!spawned) return this.notStarted(runId, active.cause ?? "failed");
    const exit: ExitKind = active.cause ?? (outcome !== null && outcome.exit.code === 0 && !outcome.overflow ? "completed" : "failed");
    await this.confirmStopped(runId, exit, true, exit === "completed" ? (outcome?.stdout ?? null) : null);
  }

  private launchBlocked(runId: string, active: Active): ExitKind | null {
    const record = this.store.run(runId);
    if (record === undefined) return "failed";
    const now = this.now();
    if (active.controller.signal.aborted) return active.cause ?? "cancelled";
    if (now >= record.deadline_at) return "deadline";
    if (this.store.stopGeneration() !== record.start_stop_generation || this.closed !== null) return "cancelled";
    if (!this.outlet.live() || now >= record.lease_until) return "failed";
    return null;
  }

  private async markStarted(runId: string, requestId: string): Promise<void> {
    await this.update(runId, { state: "running" });
    await this.emit("receipt_started", runId, { run_id: runId, instruction_request_id: requestId, started_at: this.now() });
  }

  private notStarted(runId: string, exit: ExitKind): Promise<void> {
    return this.confirmStopped(runId, exit, false, null);
  }

  // 남은 프로세스를 끝내고 센다. 0개일 때만 종료 확인 영수증을 낸다. 띄우지 않은 실행도 센다(세는 쪽이 0을 말해야 낸다).
  private async confirmStopped(runId: string, exit: ExitKind, launched: boolean, stdout: Uint8Array | null): Promise<void> {
    const cleanup = this.options.cleanup;
    if (launched) {
      await this.update(runId, { state: "stopping", exit });
      await cleanup.terminate().catch(() => {});
    }
    const survivors = await cleanup.survivors().catch(() => null);
    if (survivors !== 0) {
      await this.update(runId, { state: "unknown_running", exit });
      return;
    }
    await this.update(runId, { state: "checking", exit });
    await this.emit("receipt_stopped", runId, { run_id: runId, remaining_processes: 0, exit, stopped_at: this.now() });
    if (exit !== "completed" || stdout === null) {
      await this.update(runId, { state: launched ? "failed_stopped" : "not_started" });
      return;
    }
    await this.emit("report_result", runId, { run_id: runId, result: this.readResult(stdout) });
    await this.update(runId, { state: "ready_result" });
  }

  // 결과는 모델이 쓴 믿지 않는 입력이다. 계약의 모양·크기(report_result 본문 검사)를 지나지 못하면 실패 결과로 바꾼다.
  private readResult(stdout: Uint8Array): Result {
    const failed: Result = { role: this.profile.role, outcome: "failed", summary: UNREADABLE_SUMMARY, items: [], refs: [] };
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
    } catch {
      return failed;
    }
    try {
      this.seal("report_result", { report_id: randomUUID(), run_id: randomUUID(), result: value }, 1);
      return value as Result;
    } catch {
      return failed;
    }
  }

  private async onCancel(header: Header, body: Bodies["task_cancel"]): Promise<void> {
    const runId = body.run_id;
    const record = this.store.run(runId);
    if (record === undefined) return;
    const prior = this.store.outboxFor(runId).find((entry) => entry.action === "receipt_accepted" && entry.body.instruction === "task_cancel");
    if (prior !== undefined) this.transmit(prior);
    else await this.emit("receipt_accepted", runId, { run_id: runId, instruction_request_id: header.request_id, instruction: "task_cancel" });
    const cause: ExitKind = body.reason === "deadline" ? "deadline" : "cancelled";
    const active = this.active;
    if (active?.runId === runId) {
      active.cause ??= cause;
      active.controller.abort();
      return;
    }
    // 끝났다고 확인하지 못한 실행은 다시 끝내고 센다. 0이면 그때 종료 확인 영수증을 낸다.
    if (record.state === "unknown_running") return this.confirmStopped(runId, record.exit ?? cause, true, null);
    this.resendLatest(runId);
  }

  private async onRenew(body: Bodies["run_renew"]): Promise<void> {
    if (this.closed !== null) return;
    const record = this.store.run(body.run_id);
    if (record === undefined || (record.state !== "preparing" && record.state !== "running")) return;
    if (body.lease_until > record.lease_until) await this.update(body.run_id, { lease_until: body.lease_until });
  }

  private async onFinalize(header: Header, body: Bodies["result_finalize"]): Promise<void> {
    if (this.closed !== null) return;
    const runId = body.run_id;
    const record = this.store.run(runId);
    if (record === undefined) return;
    if (record.state === "finalized") {
      this.resendFor(runId, "result_finalize");
      return;
    }
    // 프로세스가 살아 있을 수 있는 실행은 지우지 않는다. 쓰는 중인 파일을 지우거나 자격을 거둔 척하게 된다.
    if (!MAY_CLEAN.includes(record.state)) return;
    const cleaned = await this.options.space.clean(runId).catch(() => false);
    if (!cleaned) {
      await this.update(runId, { state: "cleanup_pending" });
      return;
    }
    await this.emit("receipt_cleaned", runId, { run_id: runId, instruction_request_id: header.request_id, cleaned_at: this.now() });
    await this.update(runId, { state: "finalized" });
  }

  private onStatus(header: Header, body: Bodies["status_query"]): void {
    if (!this.outlet.live()) return;
    const runs = body.run_ids.map((runId) => this.statusOf(runId));
    this.outlet.send(this.seal("status_report", { in_reply_to: header.request_id, runs }, 0));
  }

  private statusOf(runId: string): RunStatus {
    const record = this.store.run(runId);
    if (record === undefined) return { run_id: runId, state: "not_known", run_generation: null, last_receipt_id: null };
    return { run_id: runId, state: record.state, run_generation: record.run_generation, last_receipt_id: record.last_receipt_id };
  }

  // ---- 시간 ----

  // 진입점이 주기로 부른다(뒤 작업). 기한과 임대를 넘긴 실행을 스스로 닫고, 받음 확인이 없는 영수증을 다시 보낸다.
  tick(): void {
    const now = this.now();
    const active = this.active;
    const record = active === undefined ? undefined : this.store.run(active.runId);
    if (active !== undefined && record !== undefined && (record.state === "preparing" || record.state === "running")) {
      if (now >= record.deadline_at) active.cause ??= "deadline";
      // 임대가 끝났다: 감독의 갱신이 끊겼다. 실패로 닫는다. 종료 확인 영수증은 다른 길과 같이 남은 수 0을 본 뒤에만 낸다.
      else if (now >= record.lease_until) active.cause ??= "failed";
      if (active.cause !== null) active.controller.abort();
    }
    const resendMs = this.options.resendMs ?? limits.RENEW_INTERVAL_MS;
    for (const entry of this.store.unacked()) {
      if (now - (this.lastSent.get(entry.id) ?? Number.NEGATIVE_INFINITY) >= resendMs) this.transmit(entry);
    }
  }

  // ---- 기동 뒤 복원 ----

  // 다시 뜬 뒤, 연결하기 전에 한 번 부른다. 프로세스가 살아 있을 수 있던 실행은 남은 수를 센다.
  // 0이면 끝난 것으로 확인하고 영수증을 낸다. 다시 띄우지 않는다(결과가 없어도 새 실행으로 바꾸지 않는다).
  async recover(): Promise<void> {
    for (const record of this.store.runs()) {
      if (record.state === "preparing" || record.state === "running" || record.state === "stopping" || record.state === "checking") {
        await this.confirmStopped(record.run_id, record.exit ?? "failed", true, null);
      }
    }
  }

  // ---- 영수증·보고 ----

  private async update(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const record = this.store.run(runId);
    if (record !== undefined) await this.store.noteRun({ ...record, ...patch });
  }

  private async emit(action: OutboxAction, runId: string, fields: Record<string, unknown>): Promise<void> {
    const record = this.store.run(runId)!;
    const id = randomUUID();
    const full = action === "report_result" ? { report_id: id, ...fields } : { receipt_id: id, ...fields };
    // 계약에 맞는 본문인지 서명해 보며 확인한다. 맞지 않으면 구현의 결함이라 던진다.
    this.seal(action, full, record.run_generation);
    const entry: OutboxEntry = { id, action, run_id: runId, run_generation: record.run_generation, body: full, acked: false };
    await this.store.addOutbox(entry);
    if (RECEIPTS.includes(action)) await this.update(runId, { last_receipt_id: id });
    this.transmit(entry);
  }

  // 같은 본문을 새 봉투에 담아 보낸다(같은 id, 같은 body_digest). 연결이 없으면 다시 붙은 뒤 보낸다.
  private transmit(entry: OutboxEntry): void {
    if (!this.outlet.live() || this.store.stopGeneration() === null) return;
    this.outlet.send(this.seal(entry.action, entry.body, entry.run_generation));
    this.lastSent.set(entry.id, this.now());
  }

  // 같은 지시가 다시 왔을 때 그 지시가 낳은 영수증을 같은 id·같은 본문으로 다시 보낸다.
  private resendFor(runId: string, instruction: "task_start" | "result_finalize"): void {
    const entries = this.store.outboxFor(runId);
    const wanted =
      instruction === "task_start"
        ? entries.filter((entry) => entry.action === "receipt_accepted" && entry.body.instruction === "task_start")
        : entries.filter((entry) => entry.action === "receipt_cleaned");
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
  hello(): Envelope {
    const runs = this.store
      .runs()
      .filter((run) => run.state !== "finalized")
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
