// 감독 장부(D-56): SQLite 파일 하나, 감독 하나만 쓴다. 표와 쓰기 규칙의 요약은 ledger.md.
//
// 열 때 고른 것과 이유(Bun 1.4.4·SQLite 3.53.4에서 실행해 확인):
// - locking_mode=EXCLUSIVE: 첫 쓰기 트랜잭션에서 파일 잠금을 잡고 닫을 때까지 놓지 않는다. 같은 파일을 다른 연결이나
//   다른 프로세스가 열면 첫 접근에서 SQLITE_BUSY다(busy_timeout 0으로 기다리지 않는다). 프로세스가 죽으면 운영체제가 잠금을 푼다.
//   별도 잠금 파일을 두지 않는 이유: SQLite가 이미 쥐는 잠금이라 장부와 잠금이 어긋날 수 없다.
// - journal_mode=WAL + synchronous=FULL: 커밋마다 WAL을 fsync한다. 그래서 커밋을 돌려준 쓰기(실행 줄, 영수증)는 전원이 나가도
//   남고, 실행 줄의 커밋이 끝난 뒤에만 지시를 내므로 접수 기록이 영수증보다 먼저 남는다. NORMAL은 마지막 커밋을 잃을 수 있다.
//   EXCLUSIVE와 함께 쓰면 공유 메모리(-shm) 파일 없이 동작한다. 로컬 볼륨 전제다(네트워크 파일시스템이 아님).
// - foreign_keys=ON: 지시·세션·게시가 없는 실행을 가리키지 못한다. 연결마다 켜야 하는 설정이다.
// - quick_check: 깨진 파일은 열 때 SQLITE_NOTADB·SQLITE_CORRUPT로 걸러 "쓸 수 없음"으로 연다(열지 않는다).
import { Database } from "bun:sqlite";
import { limits, type NonceStore, ROLES, type RunState, stateAfterLoss } from "../contract/v1/index.ts";
import { classify, describe, type Faults, LedgerUnavailableError, NO_FAULTS, type UnavailableReason } from "./errors.ts";
import {
  count,
  type CredentialRef,
  credentialRef,
  exact,
  LedgerInputError,
  oneOf,
  REF,
  REVISION,
  SHA256,
  type SourceRef,
  sourceRef,
  str,
  strOrNull,
  time,
  UUID,
} from "./input.ts";
import { loadMigrations, migrate, type Migration } from "./migrate.ts";
import { type LedgerRunState, mayTransition, type RunKind, SLOT_FREE, TERMINAL } from "./states.ts";

// ---- 결과의 모양 ----

export type Read<T> = { known: true; value: T } | { known: false; reason: UnavailableReason };

export const REFUSALS = [
  "ledger_unwritable",
  "stop_unknown",
  "stopped",
  "stop_generation_mismatch",
  "stop_generation_lower",
  "slot_busy",
  "transition_denied",
  "unknown_run",
  "unknown_instruction",
  "receipt_conflict",
  "deadline_passed",
  "budget_grows",
  "publication_confirmed",
  "reference_mismatch",
  "permit_used",
  "invariant_violation",
] as const;
export type Refusal = (typeof REFUSALS)[number];
export type Refused = { ok: false; reason: Refusal };

class Refuse extends Error {
  constructor(readonly reason: Refusal) {
    super(reason);
  }
}

// 트리거와 제약의 오류를 거절 사유로 바꾼다. 이것들은 장부가 망가진 것이 아니라 규칙이 막은 것이다.
function constraintRefusal(error: unknown): Refusal | undefined {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (!code.startsWith("SQLITE_CONSTRAINT")) return undefined;
  const message = error instanceof Error ? error.message : "";
  for (const raised of ["stop_generation_lower", "budget_grows", "publication_confirmed"] as const) if (message.includes(raised)) return raised;
  if (message.includes("run_transition_denied")) return "transition_denied";
  if (message.includes("runs.kind")) return "slot_busy";
  return "invariant_violation";
}

// ---- 장부의 값 ----

export interface StopRecord {
  generation: number;
  stopped: boolean;
  phase: StopPhase;
  updatedAt: number;
}
export const STOP_PHASES = ["none", "accepted", "blocked", "node_unverified", "node_verified", "runtime_verified"] as const;
export type StopPhase = (typeof STOP_PHASES)[number];

export interface Run {
  runId: string;
  runGeneration: number;
  kind: RunKind;
  role: string | null;
  queueSeq: number;
  dedupeKey: string | null;
  inputRequestId: string | null;
  profileRevision: string;
  policyRevision: string;
  snapshotDigest: string | null;
  inputDigest: string | null;
  executorId: string;
  credential: CredentialRef;
  deadlineAt: number;
  budgetLeft: number;
  state: LedgerRunState;
  acceptedReceiptId: string | null;
  startedReceiptId: string | null;
  stopReceiptId: string | null;
  cleanedReceiptId: string | null;
  resultDigest: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RunRow {
  run_id: string;
  run_generation: number;
  kind: RunKind;
  role: string | null;
  queue_seq: number;
  dedupe_key: string | null;
  input_request_id: string | null;
  profile_revision: string;
  policy_revision: string;
  snapshot_digest: string | null;
  input_digest: string | null;
  executor_id: string;
  account: string;
  auth_method: string;
  credential_revision: string;
  credential_digest: string;
  deadline_at: number;
  budget_left: number;
  state: LedgerRunState;
  accepted_receipt_id: string | null;
  started_receipt_id: string | null;
  stop_receipt_id: string | null;
  cleaned_receipt_id: string | null;
  result_digest: string | null;
  created_at: number;
  updated_at: number;
}

function toRun(row: RunRow): Run {
  return {
    runId: row.run_id,
    runGeneration: row.run_generation,
    kind: row.kind,
    role: row.role,
    queueSeq: row.queue_seq,
    dedupeKey: row.dedupe_key,
    inputRequestId: row.input_request_id,
    profileRevision: row.profile_revision,
    policyRevision: row.policy_revision,
    snapshotDigest: row.snapshot_digest,
    inputDigest: row.input_digest,
    executorId: row.executor_id,
    credential: { account: row.account, method: row.auth_method, revision: row.credential_revision, digest: row.credential_digest },
    deadlineAt: row.deadline_at,
    budgetLeft: row.budget_left,
    state: row.state,
    acceptedReceiptId: row.accepted_receipt_id,
    startedReceiptId: row.started_receipt_id,
    stopReceiptId: row.stop_receipt_id,
    cleanedReceiptId: row.cleaned_receipt_id,
    resultDigest: row.result_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---- 쓰기 함수가 받는 값 ----

export interface AdmitRunInput {
  kind: RunKind;
  runId: string;
  dedupeKey: string | null;
  inputRequestId: string | null;
  // 작업자만: 역할과 snapshot. 세션이면 null.
  role: string | null;
  snapshotDigest: string | null;
  inputDigest: string | null;
  profileRevision: string;
  policyRevision: string;
  executorId: string;
  credential: CredentialRef;
  deadlineAt: number;
  budgetLeft: number;
  now: number;
}

export interface StartRunInput {
  runId: string;
  requestId: string;
  // 내려는 지시의 머리에 실을 정지 세대. 장부의 세대와 같아야 한다.
  stopGeneration: number;
  now: number;
}

export interface StartSessionInput extends StartRunInput {
  sessionId: string;
  generationMarkerDigest: string;
  takeoverReceiptId: string | null;
  ruleCheckId: string;
  handoffRef: string | null;
  handoffDigest: string | null;
}

export interface StopInstructionInput {
  runId: string;
  requestId: string;
  action: "task_cancel" | "session_stop";
  stopGeneration: number;
  now: number;
}

export interface FinalizeInstructionInput {
  runId: string;
  requestId: string;
  stopGeneration: number;
  now: number;
}

export type ReceiptInput =
  | { action: "receipt_accepted"; receiptId: string; runId: string; instructionRequestId: string; bodyDigest: string; now: number }
  | { action: "receipt_started"; receiptId: string; runId: string; instructionRequestId: string; bodyDigest: string; now: number }
  | { action: "receipt_stopped"; receiptId: string; runId: string; exit: StopExit; bodyDigest: string; now: number }
  | { action: "receipt_cleaned"; receiptId: string; runId: string; instructionRequestId: string; bodyDigest: string; now: number }
  | {
      action: "receipt_session_takeover";
      receiptId: string;
      previousRunId: string;
      newGenerationMarkerDigest: string;
      startPermitId: string;
      takenOverAt: number;
      bodyDigest: string;
      now: number;
    };
export const STOP_EXITS = ["completed", "cancelled", "deadline", "failed"] as const;
export type StopExit = (typeof STOP_EXITS)[number];

export interface RuleCheckInput {
  reportId: string;
  outcome: "rule_present" | "rule_missing";
  firstMarkerDigest: string;
  restartedMarkerDigest: string | null;
  startPermitId: string | null;
  checkedAt: number;
  bodyDigest: string;
  now: number;
}

// 결과·훅·세션 깨짐 보고: 장부는 같은 보고를 한 번만 반영하는 데 필요한 것만 적는다(본문은 적지 않는다).
export interface ReportInput {
  reportId: string;
  action: "report_result" | "report_session_broken" | "report_hook_event";
  runId: string;
  bodyDigest: string;
  now: number;
}

export interface InputRecord {
  requestId: string;
  source: string;
  sourceRef: SourceRef;
  receivedAt: number;
}

export type PublicationAnswer = { kind: "confirmed"; outcome: "posted" | "not_posted" } | { kind: "pending" } | { kind: "unknown" };

export interface Publication {
  frontJobId: string;
  candidateDigest: string;
  runId: string | null;
  state: "pending" | "confirmed" | "unknown";
  outcome: "posted" | "not_posted" | null;
}

export type Delivery = "new" | "duplicate";

export interface OpenOptions {
  // 장부에 적는 시각과 nonce 정리에 쓰는 시계(밀리초).
  clock: () => number;
  create?: boolean;
  migrations?: readonly Migration[];
  faults?: Faults & { onOpen?(db: Database): void };
}

export type OpenResult = { ok: true; ledger: Ledger; migrated: { from: number; to: number } } | { ok: false; reason: UnavailableReason; detail: string };

// 여는 순서: 파일 → 설정 → 잠금 → 검사 → 마이그레이션. 하나라도 실패하면 연결을 닫고 이유를 돌려준다(장부 객체를 내지 않는다).
export function openLedger(path: string, options: OpenOptions): OpenResult {
  let db: Database | undefined;
  try {
    const migrations = options.migrations ?? loadMigrations();
    db = new Database(path, { create: options.create ?? true, readwrite: true, strict: true });
    db.run("PRAGMA busy_timeout = 0");
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    const journal = (db.query("PRAGMA journal_mode = WAL").get() as { journal_mode: string }).journal_mode;
    if (journal !== "wal") throw new LedgerUnavailableError("db_error", `journal_mode ${journal}`);
    db.run("PRAGMA synchronous = FULL");
    db.run("PRAGMA foreign_keys = ON");
    // 빈 쓰기 트랜잭션으로 지금 잠금을 잡는다. EXCLUSIVE라 커밋 뒤에도 놓지 않는다.
    db.run("BEGIN IMMEDIATE");
    db.run("COMMIT");
    const check = db.query("PRAGMA quick_check").all() as { quick_check: string }[];
    if (check.length !== 1 || check[0].quick_check !== "ok") throw new LedgerUnavailableError("corrupt", `quick_check: ${check.map((r) => r.quick_check).join("; ")}`);
    const faults = options.faults ?? NO_FAULTS;
    const migrated = migrate(db, migrations, options.clock(), faults);
    options.faults?.onOpen?.(db);
    return { ok: true, ledger: new Ledger(db, options.clock, faults), migrated };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // 닫기의 실패는 이미 돌려줄 이유보다 덜 중요하다.
    }
    return { ok: false, reason: classify(error), detail: describe(error) };
  }
}

const IN_FLIGHT: readonly LedgerRunState[] = ["preparing", "running", "stopping", "checking"];

export class Ledger {
  // 한 번 쓰기·읽기가 실패하면 다시 열 때까지 새 일의 근거를 주지 않는다(일시 오류인지 가를 수 없다).
  #broken: UnavailableReason | null = null;
  #closed = false;

  constructor(
    private readonly db: Database,
    private readonly clock: () => number,
    private readonly faults: Faults,
  ) {}

  health(): { writable: true } | { writable: false; reason: UnavailableReason } {
    if (this.#closed) return { writable: false, reason: "closed" };
    return this.#broken === null ? { writable: true } : { writable: false, reason: this.#broken };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.db.close();
  }

  // mode "new": 새 접수·새 실행·자격 발급. 장부가 한 번이라도 실패했으면 시도하지 않는다.
  // mode "continue": 정지·종료·영수증처럼 진행 중인 것을 닫는 기록. 실패한 뒤에도 가능한 만큼 시도한다.
  #write<T extends object>(point: string, mode: "new" | "continue", fn: () => T): T | Refused {
    if (this.#closed || (mode === "new" && this.#broken !== null)) return { ok: false, reason: "ledger_unwritable" };
    try {
      return this.db
        .transaction(() => {
          const result = fn();
          this.faults.at(`${point}:before_commit`);
          return result;
        })
        .immediate();
    } catch (error) {
      if (error instanceof Refuse) return { ok: false, reason: error.reason };
      if (error instanceof LedgerInputError) throw error;
      const refusal = constraintRefusal(error);
      if (refusal !== undefined) return { ok: false, reason: refusal };
      this.#broken ??= classify(error);
      return { ok: false, reason: "ledger_unwritable" };
    }
  }

  #read<T>(fn: () => T): Read<T> {
    if (this.#closed) return { known: false, reason: "closed" };
    try {
      this.faults.at("read");
      return { known: true, value: fn() };
    } catch (error) {
      const reason = classify(error);
      this.#broken ??= reason;
      return { known: false, reason };
    }
  }

  #runRow(runId: string): RunRow | null {
    return (this.db.query("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | null) ?? null;
  }

  #stopRow(): StopRecord | null {
    const row = this.db.query("SELECT generation, stopped, phase, updated_at FROM stop_state WHERE id = 1").get() as {
      generation: number;
      stopped: number;
      phase: StopPhase;
      updated_at: number;
    } | null;
    return row === null ? null : { generation: row.generation, stopped: row.stopped === 1, phase: row.phase, updatedAt: row.updated_at };
  }

  #setState(row: RunRow, to: LedgerRunState, now: number, extra: Partial<Pick<RunRow, "stop_receipt_id" | "cleaned_receipt_id" | "result_digest">> = {}): void {
    if (!mayTransition(row.kind, row.state, to)) throw new Refuse("transition_denied");
    const sets = ["state = $state", "updated_at = $now"];
    const params: Record<string, string | number | null> = { state: to, now, run_id: row.run_id };
    for (const [key, value] of Object.entries(extra)) {
      sets.push(`${key} = $${key}`);
      params[key] = value ?? null;
    }
    this.db.query(`UPDATE runs SET ${sets.join(", ")} WHERE run_id = $run_id`).run(params);
  }

  // 새 실행·자격 발급을 막는 정지 확인. 기록이 없으면(모름) 막는다.
  #requireOpenStop(stopGeneration: number): void {
    const stop = this.#stopRow();
    if (stop === null) throw new Refuse("stop_unknown");
    if (stop.stopped) throw new Refuse("stopped");
    if (stop.generation !== stopGeneration) throw new Refuse("stop_generation_mismatch");
  }

  // ---- 정지·일시 중지 ----

  readStop(): Read<StopRecord | null> {
    return this.#read(() => this.#stopRow());
  }

  // 정지 세대를 적는다. 0도 적는다. 낮은 세대로 덮지 않는다(여기서 한 번, 트리거에서 한 번 더).
  // 같은 세대에서 stopped만 바꾸는 것은 풀기(§7.6)와 같은 세대의 확인 단계 갱신이다.
  applyStop(input: { generation: number; stopped: boolean; phase?: StopPhase; now: number }): { ok: true; record: StopRecord } | Refused {
    const v = exact(input, ["generation", "stopped", "phase", "now"], "applyStop");
    const generation = count(v.generation, "generation");
    if (typeof v.stopped !== "boolean") throw new LedgerInputError("applyStop.stopped: boolean이 아니다");
    const phase = v.phase === undefined ? "none" : oneOf(v.phase, STOP_PHASES, "phase");
    const now = time(v.now, "now");
    return this.#write("stop", "continue", () => {
      const before = this.#stopRow();
      if (before !== null && generation < before.generation) throw new Refuse("stop_generation_lower");
      this.db
        .query(
          `INSERT INTO stop_state (id, generation, stopped, phase, updated_at) VALUES (1, $generation, $stopped, $phase, $now)
           ON CONFLICT (id) DO UPDATE SET generation = excluded.generation, stopped = excluded.stopped, phase = excluded.phase, updated_at = excluded.updated_at`,
        )
        .run({ generation, stopped: v.stopped ? 1 : 0, phase, now });
      const record = this.#stopRow();
      if (record === null) throw new Refuse("invariant_violation");
      return { ok: true as const, record };
    });
  }

  readPause(): Read<number | null> {
    return this.#read(() => (this.db.query("SELECT until_at FROM diagnosis_pause WHERE id = 1").get() as { until_at: number | null } | null)?.until_at ?? null);
  }

  setPause(untilAt: number | null): { ok: true } | Refused {
    const until = untilAt === null ? null : time(untilAt, "untilAt");
    return this.#write("pause", "continue", () => {
      this.db.query("INSERT INTO diagnosis_pause (id, until_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET until_at = excluded.until_at").run(until);
      return { ok: true as const };
    });
  }

  // ---- 입력·대기열 ----

  // 같은 요청 ID는 같은 순번을 돌려준다.
  enqueueInput(input: InputRecord): { ok: true; seq: number; created: boolean } | Refused {
    const v = exact(input, ["requestId", "source", "sourceRef", "receivedAt"], "enqueueInput");
    const requestId = str(v.requestId, UUID, "requestId");
    const source = str(v.source, REF, "source");
    const ref = sourceRef(v.sourceRef, "sourceRef");
    const receivedAt = time(v.receivedAt, "receivedAt");
    return this.#write("input", "new", () => {
      const before = this.db.query("SELECT seq FROM inputs WHERE request_id = ?").get(requestId) as { seq: number } | null;
      if (before) return { ok: true as const, seq: before.seq, created: false };
      const seq = (this.db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM inputs").get() as { seq: number }).seq;
      this.db
        .query("INSERT INTO inputs (request_id, seq, source, source_ref, source_expires_at, received_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(requestId, seq, source, ref.ref, ref.expiresAt, receivedAt);
      return { ok: true as const, seq, created: true };
    });
  }

  cancelInput(requestId: string, at: number): { ok: true } | Refused {
    const id = str(requestId, UUID, "requestId");
    const when = time(at, "at");
    return this.#write("input_cancel", "continue", () => {
      const changed = this.db.query("UPDATE inputs SET cancelled_at = COALESCE(cancelled_at, ?) WHERE request_id = ?").run(when, id).changes;
      if (changed === 0) throw new Refuse("unknown_instruction");
      return { ok: true as const };
    });
  }

  // ---- 실행 ----

  // 실행 줄을 대기(queued)로 적는다. 같은 중복 키는 같은 실행을 돌려준다(새 줄을 만들지 않는다).
  admitRun(input: AdmitRunInput): { ok: true; run: Run; created: boolean } | Refused {
    const v = exact(
      input,
      ["kind", "runId", "dedupeKey", "inputRequestId", "role", "snapshotDigest", "inputDigest", "profileRevision", "policyRevision", "executorId", "credential", "deadlineAt", "budgetLeft", "now"],
      "admitRun",
    );
    const kind = oneOf(v.kind, ["worker", "session"] as const, "kind");
    // 역할과 snapshot은 작업자에만 있다. 세션이면 null이어야 한다.
    const workerOnly = (value: unknown, pattern: RegExp, where: string) => {
      if (kind === "worker") return str(value, pattern, where);
      if (value !== null) throw new LedgerInputError(`${where}: 세션에는 없다`);
      return null;
    };
    const row = {
      run_id: str(v.runId, UUID, "runId"),
      kind,
      role: workerOnly(v.role, REF, "role"),
      dedupe_key: strOrNull(v.dedupeKey, REF, "dedupeKey"),
      input_request_id: strOrNull(v.inputRequestId, UUID, "inputRequestId"),
      snapshot_digest: workerOnly(v.snapshotDigest, SHA256, "snapshotDigest"),
      input_digest: strOrNull(v.inputDigest, SHA256, "inputDigest"),
      profile_revision: str(v.profileRevision, REVISION, "profileRevision"),
      policy_revision: str(v.policyRevision, REVISION, "policyRevision"),
      executor_id: str(v.executorId, REF, "executorId"),
      deadline_at: time(v.deadlineAt, "deadlineAt"),
      budget_left: count(v.budgetLeft, "budgetLeft"),
      now: time(v.now, "now"),
    };
    if (row.role !== null) oneOf(row.role, ROLES, "role");
    const credential = credentialRef(v.credential, "credential");
    return this.#write("admit", "new", () => {
      if (row.dedupe_key !== null) {
        const same = this.db.query("SELECT * FROM runs WHERE dedupe_key = ?").get(row.dedupe_key) as RunRow | null;
        if (same) return { ok: true as const, run: toRun(same), created: false };
      }
      const generation = (this.db.query("SELECT generation FROM run_epoch WHERE id = 1").get() as { generation: number }).generation;
      const seq = (this.db.query("SELECT COALESCE(MAX(queue_seq), 0) + 1 AS seq FROM runs").get() as { seq: number }).seq;
      this.db
        .query(
          `INSERT INTO runs (run_id, run_generation, kind, role, queue_seq, dedupe_key, input_request_id, profile_revision, policy_revision,
             snapshot_digest, input_digest, executor_id, account, auth_method, credential_revision, credential_digest, deadline_at, budget_left,
             state, created_at, updated_at)
           VALUES ($run_id, $generation, $kind, $role, $seq, $dedupe_key, $input_request_id, $profile_revision, $policy_revision,
             $snapshot_digest, $input_digest, $executor_id, $account, $auth_method, $credential_revision, $credential_digest, $deadline_at, $budget_left,
             'queued', $now, $now)`,
        )
        .run({
          ...row,
          generation,
          seq,
          account: credential.account,
          auth_method: credential.method,
          credential_revision: credential.revision,
          credential_digest: credential.digest,
        });
      const created = this.#runRow(row.run_id);
      if (created === null) throw new Refuse("invariant_violation");
      return { ok: true as const, run: toRun(created), created: true };
    });
  }

  // 작업 시작 지시를 내기 직전에 부른다. 자리(작업자 슬롯)를 잡고 지시를 적은 커밋이 끝난 뒤에만 지시를 보낸다.
  // 돌려준 credential이 자격 발급의 근거다. 정지 중이거나 정지 기록을 모르거나 세대가 다르면 주지 않는다.
  startRun(input: StartRunInput): { ok: true; run: Run; credential: CredentialRef } | Refused {
    const v = exact(input, ["runId", "requestId", "stopGeneration", "now"], "startRun");
    const runId = str(v.runId, UUID, "runId");
    const requestId = str(v.requestId, UUID, "requestId");
    const stopGeneration = count(v.stopGeneration, "stopGeneration");
    const now = time(v.now, "now");
    return this.#write("start", "new", () => {
      this.#requireOpenStop(stopGeneration);
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (row.kind !== "worker") throw new Refuse("invariant_violation");
      if (row.state !== "queued") throw new Refuse("transition_denied");
      if (row.deadline_at <= now) throw new Refuse("deadline_passed");
      this.#setState(row, "preparing", now);
      this.db.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, 'task_start', ?, ?)").run(requestId, runId, stopGeneration, now);
      const after = this.#runRow(runId) as RunRow;
      return { ok: true as const, run: toRun(after), credential: toRun(after).credential };
    });
  }

  // 세션 시작: 규칙 확인 기록(D-51)과 인수 영수증(D-50)을 장부와 대조하고, 시작 허가를 한 번 쓴다.
  startSession(input: StartSessionInput): { ok: true; run: Run; credential: CredentialRef } | Refused {
    const v = exact(
      input,
      ["runId", "requestId", "stopGeneration", "now", "sessionId", "generationMarkerDigest", "takeoverReceiptId", "ruleCheckId", "handoffRef", "handoffDigest"],
      "startSession",
    );
    const runId = str(v.runId, UUID, "runId");
    const requestId = str(v.requestId, UUID, "requestId");
    const stopGeneration = count(v.stopGeneration, "stopGeneration");
    const now = time(v.now, "now");
    const sessionId = str(v.sessionId, UUID, "sessionId");
    const marker = str(v.generationMarkerDigest, SHA256, "generationMarkerDigest");
    const takeoverId = strOrNull(v.takeoverReceiptId, UUID, "takeoverReceiptId");
    const ruleCheckId = str(v.ruleCheckId, UUID, "ruleCheckId");
    const handoffRef = strOrNull(v.handoffRef, REF, "handoffRef");
    const handoffDigest = strOrNull(v.handoffDigest, SHA256, "handoffDigest");
    return this.#write("start_session", "new", () => {
      this.#requireOpenStop(stopGeneration);
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (row.kind !== "session") throw new Refuse("invariant_violation");
      if (row.state !== "queued") throw new Refuse("transition_denied");
      if (row.deadline_at <= now) throw new Refuse("deadline_passed");
      const check = this.db.query("SELECT outcome, restarted_marker_digest, start_permit_id FROM rule_checks WHERE report_id = ?").get(ruleCheckId) as {
        outcome: string;
        restarted_marker_digest: string | null;
        start_permit_id: string | null;
      } | null;
      if (check === null || check.outcome !== "rule_present" || check.restarted_marker_digest !== marker || check.start_permit_id === null) {
        throw new Refuse("reference_mismatch");
      }
      if (takeoverId === null) {
        // 첫 세션만 인수 영수증 없이 연다. 앞 세션이 한 번이라도 있었으면 인수가 있어야 한다.
        if (this.db.query("SELECT 1 AS x FROM sessions LIMIT 1").get()) throw new Refuse("reference_mismatch");
      } else {
        const takeover = this.db.query("SELECT new_generation_marker_digest, start_permit_id FROM session_takeovers WHERE receipt_id = ?").get(takeoverId) as {
          new_generation_marker_digest: string;
          start_permit_id: string;
        } | null;
        if (takeover === null || takeover.new_generation_marker_digest !== marker || takeover.start_permit_id !== check.start_permit_id) {
          throw new Refuse("reference_mismatch");
        }
      }
      if (this.db.query("SELECT 1 AS x FROM start_permit_uses WHERE start_permit_id = ?").get(check.start_permit_id)) throw new Refuse("permit_used");
      this.#setState(row, "preparing", now);
      this.db.query("INSERT INTO start_permit_uses (start_permit_id, run_id, used_at) VALUES (?, ?, ?)").run(check.start_permit_id, runId, now);
      this.db
        .query(
          "INSERT INTO sessions (session_id, run_id, generation_marker_digest, takeover_receipt_id, rule_check_id, handoff_ref, handoff_digest) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(sessionId, runId, marker, takeoverId, ruleCheckId, handoffRef, handoffDigest);
      this.db.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, 'session_start', ?, ?)").run(requestId, runId, stopGeneration, now);
      const after = toRun(this.#runRow(runId) as RunRow);
      return { ok: true as const, run: after, credential: after.credential };
    });
  }

  // 종료·취소 지시. 정지 중에도, 장부가 실패한 뒤에도 시도한다. 아직 지시를 내지 않은 대기 실행은 not_started로 닫는다.
  recordStopInstruction(input: StopInstructionInput): { ok: true; run: Run } | Refused {
    const v = exact(input, ["runId", "requestId", "action", "stopGeneration", "now"], "recordStopInstruction");
    const runId = str(v.runId, UUID, "runId");
    const requestId = str(v.requestId, UUID, "requestId");
    const action = oneOf(v.action, ["task_cancel", "session_stop"] as const, "action");
    const stopGeneration = count(v.stopGeneration, "stopGeneration");
    const now = time(v.now, "now");
    return this.#write("stop_instruction", "continue", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if ((action === "task_cancel") !== (row.kind === "worker")) throw new Refuse("invariant_violation");
      if (row.state === "queued") {
        this.#setState(row, "not_started", now);
        return { ok: true as const, run: toRun(this.#runRow(runId) as RunRow) };
      }
      if (["preparing", "running", "unknown_running"].includes(row.state)) this.#setState(row, "stopping", now);
      this.db.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, ?, ?, ?)").run(requestId, runId, action, stopGeneration, now);
      return { ok: true as const, run: toRun(this.#runRow(runId) as RunRow) };
    });
  }

  // 결과 확정 지시. 결과 쪽 상태(종료 확인이 있는)에서만 적는다. 정리 영수증은 이 지시만 가리킬 수 있다.
  recordFinalizeInstruction(input: FinalizeInstructionInput): { ok: true } | Refused {
    const v = exact(input, ["runId", "requestId", "stopGeneration", "now"], "recordFinalizeInstruction");
    const runId = str(v.runId, UUID, "runId");
    const requestId = str(v.requestId, UUID, "requestId");
    const stopGeneration = count(v.stopGeneration, "stopGeneration");
    const now = time(v.now, "now");
    return this.#write("finalize_instruction", "continue", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (!["ready_result", "failed_stopped", "cleanup_pending"].includes(row.state)) throw new Refuse("transition_denied");
      this.db.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, 'result_finalize', ?, ?)").run(requestId, runId, stopGeneration, now);
      return { ok: true as const };
    });
  }

  // 결과 검사의 판정(checking에서만). digest가 있으면 ready_result, null이면 failed_stopped.
  markResult(input: { runId: string; resultDigest: string | null; now: number }): { ok: true; run: Run } | Refused {
    const v = exact(input, ["runId", "resultDigest", "now"], "markResult");
    const runId = str(v.runId, UUID, "runId");
    const digest = strOrNull(v.resultDigest, SHA256, "resultDigest");
    const now = time(v.now, "now");
    return this.#write("result", "continue", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (row.state !== "checking") throw new Refuse("transition_denied");
      this.#setState(row, digest === null ? "failed_stopped" : "ready_result", now, { result_digest: digest });
      return { ok: true as const, run: toRun(this.#runRow(runId) as RunRow) };
    });
  }

  markCleanupPending(input: { runId: string; now: number }): { ok: true } | Refused {
    const v = exact(input, ["runId", "now"], "markCleanupPending");
    const runId = str(v.runId, UUID, "runId");
    const now = time(v.now, "now");
    return this.#write("cleanup_pending", "continue", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      this.#setState(row, "cleanup_pending", now);
      return { ok: true as const };
    });
  }

  // 남은 예산을 줄인다. 늘리는 쓰기는 거절한다(재시도·계정 전환이 예산을 새로 주지 않는다).
  recordBudget(input: { runId: string; budgetLeft: number; now: number }): { ok: true } | Refused {
    const v = exact(input, ["runId", "budgetLeft", "now"], "recordBudget");
    const runId = str(v.runId, UUID, "runId");
    const left = count(v.budgetLeft, "budgetLeft");
    const now = time(v.now, "now");
    return this.#write("budget", "continue", () => {
      const changed = this.db.query("UPDATE runs SET budget_left = ?, updated_at = ? WHERE run_id = ?").run(left, now, runId).changes;
      if (changed === 0) throw new Refuse("unknown_run");
      return { ok: true as const };
    });
  }

  // 끊김 판정(또는 재시작) 뒤: 끝났다고 증명되지 않은 진행 중 실행을 계약의 stateAfterLoss로 unknown_running에 둔다.
  markLost(now: number): { ok: true; runIds: string[] } | Refused {
    const when = time(now, "now");
    return this.#write("lost", "continue", () => {
      const rows = this.db.query(`SELECT * FROM runs WHERE state IN (${IN_FLIGHT.map(() => "?").join(", ")})`).all(...IN_FLIGHT) as RunRow[];
      const changed: string[] = [];
      for (const row of rows) {
        const next = stateAfterLoss(row.state as RunState) as LedgerRunState;
        if (next !== row.state) {
          this.#setState(row, next, when);
          changed.push(row.run_id);
        }
      }
      return { ok: true as const, runIds: changed };
    });
  }

  getRun(runId: string): Read<Run | null> {
    return this.#read(() => {
      const row = this.#runRow(runId);
      return row === null ? null : toRun(row);
    });
  }

  listRuns(): Read<Run[]> {
    return this.#read(() => (this.db.query("SELECT * FROM runs ORDER BY queue_seq").all() as RunRow[]).map(toRun));
  }

  // 계약의 VerifyContext.runGeneration에 넘긴다. 읽기가 실패하면 undefined(장부 밖)가 아니라 던진다.
  runGeneration(runId: string): number | undefined {
    const read = this.#read(() => (this.db.query("SELECT run_generation FROM runs WHERE run_id = ?").get(runId) as { run_generation: number } | null)?.run_generation);
    if (!read.known) throw new LedgerUnavailableError(read.reason, "runGeneration");
    return read.value ?? undefined;
  }

  // 새 실행에 자리가 있는가. 장부를 못 쓰면 없다(모름은 모름이고 자리는 주지 않는다).
  slotFree(kind: RunKind): Read<boolean> {
    if (this.#broken !== null) return { known: false, reason: this.#broken };
    return this.#read(() => {
      const held = this.db.query(`SELECT 1 AS x FROM runs WHERE kind = ? AND state NOT IN (${SLOT_FREE.map(() => "?").join(", ")}) LIMIT 1`).get(kind, ...SLOT_FREE);
      return held === null;
    });
  }

  // ---- 영수증·보고 ----

  // id → digest로 한 번만 반영한다. 같은 id에 다른 digest는 receipt_conflicts에 남기고 receipt_conflict로 거절한다.
  // 반영할 수 없는 영수증(실행이 없음, 그 상태에서 허용되지 않음)은 적지 않고 거절한다. 실행기는 ack가 올 때까지 다시 보낸다.
  #deliver(id: string, action: string, runId: string | null, digest: string, now: number): Delivery | Refused {
    const before = this.db.query("SELECT body_digest FROM deliveries WHERE id = ?").get(id) as { body_digest: string } | null;
    if (before) {
      if (before.body_digest === digest) return "duplicate";
      this.db.query("INSERT INTO receipt_conflicts (id, first_digest, other_digest, received_at) VALUES (?, ?, ?, ?)").run(id, before.body_digest, digest, now);
      return { ok: false, reason: "receipt_conflict" };
    }
    this.db.query("INSERT INTO deliveries (id, action, run_id, body_digest, received_at) VALUES (?, ?, ?, ?, ?)").run(id, action, runId, digest, now);
    return "new";
  }

  applyReceipt(input: ReceiptInput): { ok: true; delivery: Delivery; ack: string } | Refused {
    const r = validateReceipt(input);
    return this.#write("receipt", "continue", () => {
      const runId = r.action === "receipt_session_takeover" ? r.previousRunId : r.runId;
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      const delivery = this.#deliver(r.receiptId, r.action, runId, r.bodyDigest, r.now);
      if (delivery === "duplicate") return { ok: true as const, delivery, ack: r.receiptId };
      if (typeof delivery === "object") return delivery;
      this.faults.at("receipt:after_insert");
      this.#effect(row, r);
      return { ok: true as const, delivery, ack: r.receiptId };
    });
  }

  #instruction(requestId: string, runId: string, actions: readonly string[]): void {
    const found = this.db.query("SELECT action FROM instructions WHERE request_id = ? AND run_id = ?").get(requestId, runId) as { action: string } | null;
    if (found === null || !actions.includes(found.action)) throw new Refuse("unknown_instruction");
  }

  #effect(row: RunRow, r: ReceiptInput): void {
    switch (r.action) {
      case "receipt_accepted":
        this.#instruction(r.instructionRequestId, row.run_id, ["task_start", "session_start", "task_cancel", "session_stop", "result_finalize"]);
        if (row.state === "queued") throw new Refuse("transition_denied");
        this.db.query("UPDATE runs SET accepted_receipt_id = COALESCE(accepted_receipt_id, ?) WHERE run_id = ?").run(r.receiptId, row.run_id);
        return;
      case "receipt_started":
        this.#instruction(r.instructionRequestId, row.run_id, ["task_start", "session_start"]);
        if (row.state === "queued") throw new Refuse("transition_denied");
        this.db.query("UPDATE runs SET started_receipt_id = COALESCE(started_receipt_id, ?) WHERE run_id = ?").run(r.receiptId, row.run_id);
        if (row.state === "preparing") this.#setState(row, "running", r.now);
        return;
      case "receipt_stopped": {
        if (row.kind !== "worker") throw new Refuse("invariant_violation");
        // 이미 종료 확인이 있으면 상태를 다시 옮기지 않는다(다른 id의 늦은 영수증).
        if (row.stop_receipt_id !== null) return;
        this.#setState(row, r.exit === "completed" ? "checking" : "failed_stopped", r.now, { stop_receipt_id: r.receiptId });
        return;
      }
      case "receipt_cleaned":
        this.#instruction(r.instructionRequestId, row.run_id, ["result_finalize"]);
        this.#setState(row, "finalized", r.now, { cleaned_receipt_id: r.receiptId });
        return;
      case "receipt_session_takeover":
        if (row.kind !== "session") throw new Refuse("invariant_violation");
        this.db
          .query("INSERT INTO session_takeovers (receipt_id, previous_run_id, new_generation_marker_digest, start_permit_id, taken_over_at) VALUES (?, ?, ?, ?, ?)")
          .run(r.receiptId, row.run_id, r.newGenerationMarkerDigest, r.startPermitId, r.takenOverAt);
        this.#setState(row, "finalized", r.now, { stop_receipt_id: r.receiptId });
        this.db.query("UPDATE sessions SET rotated_at = COALESCE(rotated_at, ?) WHERE run_id = ?").run(r.takenOverAt, row.run_id);
        return;
    }
  }

  applyRuleCheck(input: RuleCheckInput): { ok: true; delivery: Delivery; ack: string } | Refused {
    const v = exact(input, ["reportId", "outcome", "firstMarkerDigest", "restartedMarkerDigest", "startPermitId", "checkedAt", "bodyDigest", "now"], "applyRuleCheck");
    const reportId = str(v.reportId, UUID, "reportId");
    const outcome = oneOf(v.outcome, ["rule_present", "rule_missing"] as const, "outcome");
    const first = str(v.firstMarkerDigest, SHA256, "firstMarkerDigest");
    const restarted = strOrNull(v.restartedMarkerDigest, SHA256, "restartedMarkerDigest");
    const permit = strOrNull(v.startPermitId, UUID, "startPermitId");
    const checkedAt = time(v.checkedAt, "checkedAt");
    const digest = str(v.bodyDigest, SHA256, "bodyDigest");
    const now = time(v.now, "now");
    return this.#write("rule_check", "new", () => {
      const delivery = this.#deliver(reportId, "report_rule_check", null, digest, now);
      if (typeof delivery === "object") return delivery;
      if (delivery === "new") {
        this.db
          .query("INSERT INTO rule_checks (report_id, outcome, first_marker_digest, restarted_marker_digest, start_permit_id, checked_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(reportId, outcome, first, restarted, permit, checkedAt);
      }
      return { ok: true as const, delivery, ack: reportId };
    });
  }

  recordReport(input: ReportInput): { ok: true; delivery: Delivery; ack: string } | Refused {
    const v = exact(input, ["reportId", "action", "runId", "bodyDigest", "now"], "recordReport");
    const reportId = str(v.reportId, UUID, "reportId");
    const action = oneOf(v.action, ["report_result", "report_session_broken", "report_hook_event"] as const, "action");
    const runId = str(v.runId, UUID, "runId");
    const digest = str(v.bodyDigest, SHA256, "bodyDigest");
    const now = time(v.now, "now");
    return this.#write("report", "continue", () => {
      if (this.#runRow(runId) === null) throw new Refuse("unknown_run");
      const delivery = this.#deliver(reportId, action, runId, digest, now);
      if (typeof delivery === "object") return delivery;
      return { ok: true as const, delivery, ack: reportId };
    });
  }

  conflicts(): Read<{ id: string; firstDigest: string; otherDigest: string }[]> {
    return this.#read(() =>
      (this.db.query("SELECT id, first_digest, other_digest FROM receipt_conflicts ORDER BY seq").all() as { id: string; first_digest: string; other_digest: string }[]).map(
        (row) => ({ id: row.id, firstDigest: row.first_digest, otherDigest: row.other_digest }),
      ),
    );
  }

  // ---- 세션 ----

  setProcessedSeq(input: { sessionId: string; processedSeq: number }): { ok: true } | Refused {
    const v = exact(input, ["sessionId", "processedSeq"], "setProcessedSeq");
    const sessionId = str(v.sessionId, UUID, "sessionId");
    const seq = count(v.processedSeq, "processedSeq");
    return this.#write("processed", "continue", () => {
      // 처리 위치는 뒤로 가지 않는다(같은 입력을 두 번 전하지 않게).
      const changed = this.db.query("UPDATE sessions SET processed_seq = MAX(processed_seq, ?) WHERE session_id = ?").run(seq, sessionId).changes;
      if (changed === 0) throw new Refuse("unknown_run");
      return { ok: true as const };
    });
  }

  planRotation(input: { sessionId: string; at: number }): { ok: true } | Refused {
    const v = exact(input, ["sessionId", "at"], "planRotation");
    const sessionId = str(v.sessionId, UUID, "sessionId");
    const at = time(v.at, "at");
    return this.#write("rotation", "continue", () => {
      const changed = this.db.query("UPDATE sessions SET rotation_planned_at = ? WHERE session_id = ?").run(at, sessionId).changes;
      if (changed === 0) throw new Refuse("unknown_run");
      return { ok: true as const };
    });
  }

  // ---- 게시 연결 ----

  recordPublication(input: { frontJobId: string; candidateDigest: string; runId: string | null; now: number }): { ok: true } | Refused {
    const v = exact(input, ["frontJobId", "candidateDigest", "runId", "now"], "recordPublication");
    const jobId = str(v.frontJobId, REF, "frontJobId");
    const digest = str(v.candidateDigest, SHA256, "candidateDigest");
    const runId = strOrNull(v.runId, UUID, "runId");
    const now = time(v.now, "now");
    return this.#write("publication", "new", () => {
      this.db
        .query("INSERT INTO publications (front_job_id, candidate_digest, run_id, state, updated_at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT (front_job_id) DO NOTHING")
        .run(jobId, digest, runId, now);
      return { ok: true as const };
    });
  }

  // 현관의 답을 적는다. 시간 초과·모름은 unknown이고 "게시 안 됨"이 아니다. 확정은 다시 바뀌지 않는다(트리거).
  settlePublication(frontJobId: string, answer: PublicationAnswer, now: number): { ok: true; publication: Publication } | Refused {
    const jobId = str(frontJobId, REF, "frontJobId");
    const when = time(now, "now");
    const kind = oneOf(answer.kind, ["confirmed", "pending", "unknown"] as const, "answer.kind");
    const outcome = kind === "confirmed" ? oneOf((answer as { outcome: unknown }).outcome, ["posted", "not_posted"] as const, "answer.outcome") : null;
    return this.#write("publication_settle", "continue", () => {
      const changed = this.db.query("UPDATE publications SET state = ?, outcome = ?, updated_at = ? WHERE front_job_id = ?").run(kind, outcome, when, jobId).changes;
      if (changed === 0) throw new Refuse("unknown_instruction");
      return { ok: true as const, publication: this.#publication(jobId) as Publication };
    });
  }

  #publication(jobId: string): Publication | null {
    const row = this.db.query("SELECT front_job_id, candidate_digest, run_id, state, outcome FROM publications WHERE front_job_id = ?").get(jobId) as {
      front_job_id: string;
      candidate_digest: string;
      run_id: string | null;
      state: Publication["state"];
      outcome: Publication["outcome"];
    } | null;
    return row === null ? null : { frontJobId: row.front_job_id, candidateDigest: row.candidate_digest, runId: row.run_id, state: row.state, outcome: row.outcome };
  }

  publications(): Read<Publication[]> {
    return this.#read(() =>
      (this.db.query("SELECT front_job_id FROM publications ORDER BY front_job_id").all() as { front_job_id: string }[]).map((r) => this.#publication(r.front_job_id) as Publication),
    );
  }

  // ---- nonce(계약의 NonceStore) ----

  // 같은 (낸 쪽, nonce)는 한 번만 true다. 재시작 뒤에도 같다(장부에 커밋한 뒤에 true를 돌려준다).
  // 장부를 쓸 수 없으면 false("재사용")로 꾸미지 않고 던진다. 봉투는 받아들여지지 않는다.
  // NONCE_RETENTION_MS보다 오래 전에 끝난 봉투의 기록만 지운다(그런 봉투는 시한으로 이미 거절된다).
  nonceStore(): NonceStore {
    return {
      consume: (sender: string, nonce: string, expiresAt: number): boolean => {
        const who = str(sender, REF, "sender");
        const value = str(nonce, /^[0-9a-f]{32}$/, "nonce");
        const until = time(expiresAt, "expiresAt");
        const result = this.#write("nonce", "continue", () => {
          this.db.query("DELETE FROM nonces WHERE expires_at < ?").run(this.clock() - limits.NONCE_RETENTION_MS);
          const inserted = this.db.query("INSERT INTO nonces (sender, nonce, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(who, value, until).changes;
          return { ok: true as const, fresh: inserted === 1 };
        });
        if (!result.ok) {
          const health = this.health();
          throw new LedgerUnavailableError(health.writable ? "db_error" : health.reason, `nonce: ${result.reason}`);
        }
        return result.fresh;
      },
    };
  }

  // 재시작 복원이 쓰는 읽기 묶음. 끝난 실행은 빼고 돌려준다.
  openRuns(): Read<Run[]> {
    return this.#read(() =>
      (this.db.query(`SELECT * FROM runs WHERE state NOT IN (${TERMINAL.map(() => "?").join(", ")}) ORDER BY queue_seq`).all(...TERMINAL) as RunRow[]).map(toRun),
    );
  }
}

function validateReceipt(input: ReceiptInput): ReceiptInput {
  const action = oneOf((input as { action: unknown }).action, ["receipt_accepted", "receipt_started", "receipt_stopped", "receipt_cleaned", "receipt_session_takeover"] as const, "action");
  if (action === "receipt_session_takeover") {
    const v = exact(input, ["action", "receiptId", "previousRunId", "newGenerationMarkerDigest", "startPermitId", "takenOverAt", "bodyDigest", "now"], "receipt");
    return {
      action,
      receiptId: str(v.receiptId, UUID, "receiptId"),
      previousRunId: str(v.previousRunId, UUID, "previousRunId"),
      newGenerationMarkerDigest: str(v.newGenerationMarkerDigest, SHA256, "newGenerationMarkerDigest"),
      startPermitId: str(v.startPermitId, UUID, "startPermitId"),
      takenOverAt: time(v.takenOverAt, "takenOverAt"),
      bodyDigest: str(v.bodyDigest, SHA256, "bodyDigest"),
      now: time(v.now, "now"),
    };
  }
  if (action === "receipt_stopped") {
    const v = exact(input, ["action", "receiptId", "runId", "exit", "bodyDigest", "now"], "receipt");
    return {
      action,
      receiptId: str(v.receiptId, UUID, "receiptId"),
      runId: str(v.runId, UUID, "runId"),
      exit: oneOf(v.exit, STOP_EXITS, "exit"),
      bodyDigest: str(v.bodyDigest, SHA256, "bodyDigest"),
      now: time(v.now, "now"),
    };
  }
  const v = exact(input, ["action", "receiptId", "runId", "instructionRequestId", "bodyDigest", "now"], "receipt");
  return {
    action,
    receiptId: str(v.receiptId, UUID, "receiptId"),
    runId: str(v.runId, UUID, "runId"),
    instructionRequestId: str(v.instructionRequestId, UUID, "instructionRequestId"),
    bodyDigest: str(v.bodyDigest, SHA256, "bodyDigest"),
    now: time(v.now, "now"),
  };
}
