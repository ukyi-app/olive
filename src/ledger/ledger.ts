// 감독 장부(D-56): SQLite 파일 하나, 감독 하나만 쓴다. 표와 쓰기 규칙의 요약은 ledger.md.
//
// 열 때 고른 것과 이유(Bun 1.4.4·SQLite 3.53.4에서 실행해 확인):
// - locking_mode=EXCLUSIVE: 첫 쓰기 트랜잭션에서 파일 잠금을 잡고 닫을 때까지 놓지 않는다. 같은 파일을 다른 연결이나
//   다른 프로세스가 열면 첫 접근에서 SQLITE_BUSY다(busy_timeout 0으로 기다리지 않는다). 프로세스가 죽으면 운영체제가 잠금을 푼다.
//   별도 잠금 파일을 두지 않는 이유: SQLite가 이미 쥐는 잠금이라 장부와 잠금이 어긋날 수 없다.
// - journal_mode=WAL + synchronous=FULL: 커밋마다 WAL을 fsync한다. 그래서 커밋을 돌려준 쓰기(실행 줄, 영수증)는 전원이 나가도
//   남고, 실행 줄의 커밋이 끝난 뒤에만 지시를 내므로 접수 기록이 영수증보다 먼저 남는다. NORMAL은 마지막 커밋을 잃을 수 있다.
//   EXCLUSIVE와 함께 쓰면 공유 메모리(-shm) 파일 없이 동작한다. 로컬 볼륨 전제다(네트워크 파일시스템이 아님).
// - foreign_keys=ON: 지시·세션·게시·영수증이 없는 실행을 가리키지 못한다. 연결마다 켜야 하는 설정이다.
// - quick_check: 깨진 파일은 열 때 SQLITE_NOTADB·SQLITE_CORRUPT로 걸러 "쓸 수 없음"으로 연다(열지 않는다).
//
// 새 업무(접수·실행 줄·시작·자격·게시·갱신)의 공통 전제는 #write의 "start" 한 자리에 있다: 장부가 건강하고, 이 연결에서
// 재시작 복원이 접수를 열었고(openIntake), 트랜잭션 안에서 읽은 지금의 정지 기록이 있고 정지가 아니다.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { type InstructionAction, INSTRUCTIONS, limits, type NonceStore, parsePrincipal, ROLES, type RunState, stateAfterLoss } from "../contract/v1/index.ts";
import { classify, describe, type Faults, LedgerUnavailableError, NO_FAULTS, type UnavailableReason } from "./errors.ts";
import {
  bool,
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
  STORED_REF,
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
  "intake_closed",
  "stop_unknown",
  "stopped",
  "stop_generation_mismatch",
  "stop_generation_lower",
  "slot_busy",
  "transition_denied",
  "unknown_run",
  "unknown_instruction",
  "receipt_conflict",
  "sender_mismatch",
  "run_generation_mismatch",
  "run_generation_stale",
  "not_startable",
  "deadline_passed",
  "budget_grows",
  "publication_confirmed",
  "publication_conflict",
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
  for (const raised of ["stop_generation_lower", "budget_grows", "publication_confirmed", "permit_used"] as const) if (message.includes(raised)) return raised;
  if (message.includes("run_transition_denied")) return "transition_denied";
  if (message.includes("runs.kind")) return "slot_busy";
  return "invariant_violation";
}

// 장부에서 읽은 정수가 안전 정수가 아니면 그 값으로 판단하지 않는다(스키마 CHECK를 지나친 파일).
function safe(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value)) throw new LedgerUnavailableError("corrupt", `${where}: 안전 정수가 아니다`);
  return value as number;
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
    runGeneration: safe(row.run_generation, "run_generation"),
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
    budgetLeft: safe(row.budget_left, "budget_left"),
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

// 재시작 복원이 실행기의 점유와 장부가 맞지 않아 막은 슬롯.
export interface SlotHold {
  executorId: string;
  runId: string;
  kind: RunKind;
  runGeneration: number | null;
  why: "outside_ledger" | "ended_in_ledger" | "state" | "executor" | "generation";
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
  // 계약의 실행기 주체 이름. 작업자는 같은 역할의 작업자 실행기, 세션은 세션 실행기여야 한다.
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

export interface InstructionInput {
  runId: string;
  requestId: string;
  stopGeneration: number;
  now: number;
}

// 검증을 통과한 봉투에서 온 것: 낸 쪽(계약의 실행기 주체 이름)과 머리의 run_generation.
export interface EnvelopeFrom {
  sender: string;
  runGeneration: number;
}

export type ReceiptInput =
  | { action: "receipt_accepted"; receiptId: string; runId: string; instructionRequestId: string; instruction: InstructionAction; bodyDigest: string; now: number }
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
// 결과 보고는 감독이 결과를 먼저 저장한 자리와 그 digest를 함께 넘긴다. 그래야 ack 뒤에 끊겨도 반영할 결과가 장부에 남는다.
export interface ReportInput {
  reportId: string;
  action: "report_result" | "report_session_broken" | "report_hook_event";
  runId: string;
  bodyDigest: string;
  storedRef: string | null;
  resultDigest: string | null;
  now: number;
}

export interface PendingReport {
  reportId: string;
  action: ReportInput["action"];
  runId: string;
  storedRef: string | null;
  resultDigest: string | null;
}

export interface InputRecord {
  requestId: string;
  source: string;
  sourceRef: SourceRef;
  receivedAt: number;
}

export interface QueuedInput {
  requestId: string;
  seq: number;
  sourceRef: SourceRef;
}

// 세션에 아직 전하지 않은 입력. 처리 위치는 세션들이 적은 위치의 최댓값이고 그 뒤의 입력만 센다.
export interface PendingInputs {
  processedSeq: number;
  pending: QueuedInput[];
  cancelled: string[];
  expired: string[];
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
  // create: 첫 설치(파일이 없거나 비었고, 첫 설치 기록이 아직 없다). reopen: 이미 만든 장부를 다시 연다.
  // 운영의 보통 기동은 reopen이다. 장부가 사라진 볼륨을 첫 설치로 착각하지 않게 호출자가 고른다.
  mode: "create" | "reopen";
  migrations?: readonly Migration[];
  faults?: Faults & { onOpen?(db: Database): void };
}

export type OpenResult = { ok: true; ledger: Ledger; migrated: { from: number; to: number } } | { ok: false; reason: UnavailableReason; detail: string };

// Ledger는 openLedger만 만든다. 열기 검사(잠금, 판, 첫 설치 기록)를 거치지 않은 연결을 장부로 쓰지 않게.
const OPENED = Symbol("openLedger");
// 재시작 복원만 접수를 열고 점유 차단을 적는다. index.ts가 내보내지 않는다.
export const RESTORE_KEY: unique symbol = Symbol("restore");

// 이 파일이 장부의 첫 설치로 만들어졌다는 기록. openLedger의 create만 적는다. 재개방은 이 줄이 없으면 열지 않는다
// (빈 볼륨이나 빈 대체 파일을 첫 설치로 착각해 정지 세대 0을 적지 않게). 마이그레이션 목록과 무관하게 있어야 해서 여기서 만든다.
const IDENTITY = [
  `CREATE TABLE IF NOT EXISTS ledger_identity (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     ledger_id TEXT NOT NULL,
     created_at INTEGER NOT NULL CHECK (created_at BETWEEN 1 AND 9007199254740991)
   ) STRICT`,
  `CREATE TRIGGER IF NOT EXISTS ledger_identity_permanent BEFORE DELETE ON ledger_identity
   BEGIN SELECT RAISE(ABORT, 'ledger_identity_permanent'); END`,
];

function hasIdentity(db: Database): boolean {
  const table = db.query("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'ledger_identity'").get();
  return table !== null && db.query("SELECT 1 AS x FROM ledger_identity WHERE id = 1").get() !== null;
}

// 여는 순서: 파일 → 설정 → 잠금 → 검사 → 첫 설치 기록 확인 → 마이그레이션. 하나라도 실패하면 연결을 닫고 이유를 돌려준다.
export function openLedger(path: string, options: OpenOptions): OpenResult {
  const mode = oneOf(options.mode, ["create", "reopen"] as const, "openLedger.mode");
  if (mode === "reopen" && !existsSync(path)) return { ok: false, reason: "not_initialized", detail: "장부 파일이 없다" };
  let db: Database | undefined;
  try {
    const migrations = options.migrations ?? loadMigrations();
    db = new Database(path, { create: mode === "create", readwrite: true, strict: true });
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
    // 마이그레이션 전에 본다: 재개방에 빈 파일이 오면 표를 만들지 않고 닫는다.
    const identified = hasIdentity(db);
    if (mode === "reopen" && !identified) throw new LedgerUnavailableError("not_initialized", "첫 설치 기록이 없다(빈 파일이거나 다른 파일)");
    if (mode === "create" && identified) throw new LedgerUnavailableError("already_initialized", "이미 만든 장부다");
    const faults = options.faults ?? NO_FAULTS;
    const migrated = migrate(db, migrations, options.clock(), faults);
    if (mode === "create") {
      const conn = db;
      conn
        .transaction(() => {
          for (const sql of IDENTITY) conn.run(sql);
          conn.query("INSERT INTO ledger_identity (id, ledger_id, created_at) VALUES (1, ?, ?)").run(crypto.randomUUID(), options.clock());
        })
        .immediate();
    }
    options.faults?.onOpen?.(db);
    return { ok: true, ledger: new Ledger(OPENED, db, options.clock, faults), migrated };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // 닫기의 실패는 이미 돌려줄 이유보다 덜 중요하다.
    }
    return { ok: false, reason: classify(error), detail: describe(error) };
  }
}

// 끊김 판정·재시작에서 끝났는지 모르게 되는 상태. checking은 종료 확인이 이미 적힌 뒤라 여기 없다.
const IN_FLIGHT: readonly LedgerRunState[] = ["preparing", "running", "stopping"];

type WriteMode = "start" | "new" | "continue";

export class Ledger {
  // 한 번 쓰기·읽기가 실패하면 다시 열 때까지 새 일의 근거를 주지 않는다(일시 오류인지 가를 수 없다).
  #broken: UnavailableReason | null = null;
  #closed = false;
  // 이 연결에서 재시작 복원이 접수를 열었는가. 열 때마다 false로 시작한다.
  #intake = false;
  readonly #db: Database;
  readonly #clock: () => number;
  readonly #faults: Faults;

  constructor(key: symbol, db: Database, clock: () => number, faults: Faults) {
    if (key !== OPENED) throw new TypeError("Ledger는 openLedger로만 연다");
    this.#db = db;
    this.#clock = clock;
    this.#faults = faults;
  }

  health(): { writable: true } | { writable: false; reason: UnavailableReason } {
    if (this.#closed) return { writable: false, reason: "closed" };
    return this.#broken === null ? { writable: true } : { writable: false, reason: this.#broken };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#intake = false;
    this.#db.close();
  }

  // mode "start": 새 접수·새 실행·자격 발급·게시. 건강, 복원이 연 접수, 지금의 정지 기록(트랜잭션 안에서 읽음)이 공통 전제다.
  // mode "new": 새 일의 근거가 되는 기록(규칙 확인, 풀기). 장부가 한 번이라도 실패했으면 시도하지 않는다.
  // mode "continue": 정지·종료·영수증처럼 진행 중인 것을 닫는 기록. 실패한 뒤에도 가능한 만큼 시도한다.
  #write<T extends object>(point: string, mode: WriteMode, fn: () => T): T | Refused {
    if (this.#closed || (mode !== "continue" && this.#broken !== null)) return { ok: false, reason: "ledger_unwritable" };
    if (mode === "start" && !this.#intake) return { ok: false, reason: "intake_closed" };
    try {
      return this.#db
        .transaction(() => {
          if (mode === "start") this.#requireOpenStop();
          const result = fn();
          this.#faults.at(`${point}:before_commit`);
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
      this.#faults.at("read");
      return { known: true, value: fn() };
    } catch (error) {
      const reason = classify(error);
      this.#broken ??= reason;
      return { known: false, reason };
    }
  }

  #runRow(runId: string): RunRow | null {
    return (this.#db.query("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | null) ?? null;
  }

  #stopRow(): StopRecord | null {
    const row = this.#db.query("SELECT generation, stopped, phase, updated_at FROM stop_state WHERE id = 1").get() as {
      generation: number;
      stopped: number;
      phase: StopPhase;
      updated_at: number;
    } | null;
    return row === null ? null : { generation: safe(row.generation, "stop_state.generation"), stopped: row.stopped === 1, phase: row.phase, updatedAt: row.updated_at };
  }

  #epoch(): number {
    const row = this.#db.query("SELECT generation FROM run_epoch WHERE id = 1").get() as { generation: number } | null;
    if (row === null) throw new Refuse("invariant_violation");
    return safe(row.generation, "run_epoch.generation");
  }

  #writeStop(generation: number, stopped: boolean, phase: StopPhase, now: number): StopRecord {
    this.#db
      .query(
        `INSERT INTO stop_state (id, generation, stopped, phase, updated_at) VALUES (1, $generation, $stopped, $phase, $now)
         ON CONFLICT (id) DO UPDATE SET generation = excluded.generation, stopped = excluded.stopped, phase = excluded.phase, updated_at = excluded.updated_at`,
      )
      .run({ generation, stopped: stopped ? 1 : 0, phase, now });
    const record = this.#stopRow();
    if (record === null) throw new Refuse("invariant_violation");
    return record;
  }

  #setState(row: RunRow, to: LedgerRunState, now: number, extra: Partial<Pick<RunRow, "stop_receipt_id" | "cleaned_receipt_id" | "result_digest">> = {}): void {
    if (!mayTransition(row.kind, row.state, to)) throw new Refuse("transition_denied");
    const sets = ["state = $state", "updated_at = $now"];
    const params: Record<string, string | number | null> = { state: to, now, run_id: row.run_id };
    for (const [key, value] of Object.entries(extra)) {
      sets.push(`${key} = $${key}`);
      params[key] = value ?? null;
    }
    this.#db.query(`UPDATE runs SET ${sets.join(", ")} WHERE run_id = $run_id`).run(params);
  }

  // 새 일을 막는 정지 확인. 기록이 없으면(모름) 막는다.
  #requireOpenStop(): StopRecord {
    const stop = this.#stopRow();
    if (stop === null) throw new Refuse("stop_unknown");
    if (stop.stopped) throw new Refuse("stopped");
    return stop;
  }

  // 지시에 실을 정지 세대는 장부의 지금 값과 같아야 한다. 종료 지시도 같다: 호출자가 앞서 읽은 옛 값으로 적지 않는다.
  #requireStopGeneration(stopGeneration: number): void {
    const stop = this.#stopRow();
    if (stop === null) throw new Refuse("stop_unknown");
    if (stop.generation !== stopGeneration) throw new Refuse("stop_generation_mismatch");
  }

  #slotHeld(kind: RunKind): boolean {
    return this.#db.query("SELECT 1 AS x FROM slot_holds WHERE kind = ? LIMIT 1").get(kind) !== null;
  }

  // 시작으로 옮기기 전 공통 확인: 지금 실행 세대의 줄인지, 대기인지, 점유 차단이 없는지, 기한이 남았는지.
  #requireStartable(row: RunRow | null, kind: RunKind, now: number): RunRow {
    if (row === null) throw new Refuse("unknown_run");
    if (row.kind !== kind) throw new Refuse("invariant_violation");
    if (row.state !== "queued") throw new Refuse("transition_denied");
    if (row.run_generation !== this.#epoch()) throw new Refuse("run_generation_stale");
    if (this.#slotHeld(kind)) throw new Refuse("slot_busy");
    if (row.deadline_at <= now) throw new Refuse("deadline_passed");
    return row;
  }

  // ---- 접수 ----

  // 새 접수·실행·자격 발급을 지금 열어도 되는가. 복원이 열었고, 장부가 건강하고, 지금 읽은 정지 기록이 정지가 아닐 때만 true.
  // 읽지 못하면 false다.
  intakeOpen(): boolean {
    if (!this.#intake || this.health().writable !== true) return false;
    const stop = this.readStop();
    return stop.known && stop.value !== null && !stop.value.stopped;
  }

  openIntake(key: symbol): void {
    if (key !== RESTORE_KEY) throw new TypeError("접수는 재시작 복원만 연다");
    this.#intake = true;
  }

  // ---- 정지·일시 중지 ----

  readStop(): Read<StopRecord | null> {
    return this.#read(() => this.#stopRow());
  }

  // 정지 기록을 합친다. 0도 적는다. 낮은 세대로 덮지 않는다(여기서 한 번, 트리거에서 한 번 더).
  // 같은 세대에서는 한쪽이라도 정지면 정지다. 이 함수로는 정지를 풀 수 없다(풀기는 releaseStop).
  // phase를 생략하면 같은 세대에서는 이미 적은 확인 단계를 그대로 두고, 새 세대에서는 none이다.
  applyStop(input: { generation: number; stopped: boolean; phase?: StopPhase; now: number }): { ok: true; record: StopRecord } | Refused {
    const v = exact(input, ["generation", "stopped", "phase", "now"], "applyStop");
    const generation = count(v.generation, "generation");
    const stopped = bool(v.stopped, "applyStop.stopped");
    const phase = v.phase === undefined ? undefined : oneOf(v.phase, STOP_PHASES, "phase");
    const now = time(v.now, "now");
    return this.#write("stop", "continue", () => {
      const before = this.#stopRow();
      if (before !== null && generation < before.generation) throw new Refuse("stop_generation_lower");
      const same = before !== null && before.generation === generation;
      const record = this.#writeStop(generation, same ? before.stopped || stopped : stopped, phase ?? (same ? before.phase : "none"), now);
      return { ok: true as const, record };
    });
  }

  // 복원 1단계: 권위 기록(없으면 null)을 지금의 장부와 한 트랜잭션에서 합친다. 권위 기록을 기다리는 사이 커밋된 정지도
  // 여기서 다시 읽으므로 풀리지 않는다. 장부와 권위 모두 기록이 없으면 0을 적는다: 이 파일은 openLedger가 첫 설치 기록을
  // 확인했고(재개방은 그 기록이 없으면 열지 않음) 정지 줄은 지울 수 없으므로, 줄이 없다는 것은 첫 설치 뒤 아직 적지 않았다는 뜻이다.
  mergeStop(authority: { generation: number; stopped: boolean } | null, now: number): { ok: true; record: StopRecord; source: "ledger" | "authority" | "initialized" } | Refused {
    const auth = authority === null ? null : exact(authority, ["generation", "stopped"], "mergeStop.authority");
    const target = auth === null ? null : { generation: count(auth.generation, "authority.generation"), stopped: bool(auth.stopped, "authority.stopped") };
    const when = time(now, "now");
    return this.#write("stop", "continue", () => {
      const before = this.#stopRow();
      if (before === null && target === null) {
        if (!hasIdentity(this.#db)) throw new Refuse("stop_unknown");
        return { ok: true as const, record: this.#writeStop(0, false, "none", when), source: "initialized" as const };
      }
      if (before === null && target !== null) return { ok: true as const, record: this.#writeStop(target.generation, target.stopped, "none", when), source: "authority" as const };
      if (before !== null && target !== null && target.generation > before.generation) {
        return { ok: true as const, record: this.#writeStop(target.generation, target.stopped, "none", when), source: "authority" as const };
      }
      if (before !== null && target !== null && target.generation === before.generation && target.stopped && !before.stopped) {
        return { ok: true as const, record: this.#writeStop(before.generation, true, before.phase, when), source: "authority" as const };
      }
      return { ok: true as const, record: before as StopRecord, source: "ledger" as const };
    });
  }

  // 관리자의 풀기(§7.6)가 이 세대의 정지를 푼다. 다른 세대면 거절한다. 풀어도 접수는 닫힌 채다: 다시 복원을 거쳐야 열린다.
  releaseStop(input: { generation: number; now: number }): { ok: true; record: StopRecord } | Refused {
    const v = exact(input, ["generation", "now"], "releaseStop");
    const generation = count(v.generation, "generation");
    const now = time(v.now, "now");
    const result = this.#write("stop_release", "new", () => {
      const before = this.#stopRow();
      if (before === null) throw new Refuse("stop_unknown");
      if (before.generation !== generation) throw new Refuse("stop_generation_mismatch");
      return { ok: true as const, record: this.#writeStop(generation, false, before.phase, now) };
    });
    if (result.ok) this.#intake = false;
    return result;
  }

  readPause(): Read<number | null> {
    return this.#read(() => (this.#db.query("SELECT until_at FROM diagnosis_pause WHERE id = 1").get() as { until_at: number | null } | null)?.until_at ?? null);
  }

  setPause(untilAt: number | null): { ok: true } | Refused {
    const until = untilAt === null ? null : time(untilAt, "untilAt");
    return this.#write("pause", "continue", () => {
      this.#db.query("INSERT INTO diagnosis_pause (id, until_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET until_at = excluded.until_at").run(until);
      return { ok: true as const };
    });
  }

  runEpoch(): Read<number> {
    return this.#read(() => this.#epoch());
  }

  // ---- 입력·대기열 ----

  // 같은 요청 ID는 같은 순번을 돌려준다.
  enqueueInput(input: InputRecord): { ok: true; seq: number; created: boolean } | Refused {
    const v = exact(input, ["requestId", "source", "sourceRef", "receivedAt"], "enqueueInput");
    const requestId = str(v.requestId, UUID, "requestId");
    const source = str(v.source, REF, "source");
    const ref = sourceRef(v.sourceRef, "sourceRef");
    const receivedAt = time(v.receivedAt, "receivedAt");
    return this.#write("input", "start", () => {
      const before = this.#db.query("SELECT seq FROM inputs WHERE request_id = ?").get(requestId) as { seq: number } | null;
      if (before) return { ok: true as const, seq: before.seq, created: false };
      const seq = (this.#db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM inputs").get() as { seq: number }).seq;
      this.#db
        .query("INSERT INTO inputs (request_id, seq, source, source_ref, source_expires_at, received_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(requestId, seq, source, ref.ref, ref.expiresAt, receivedAt);
      return { ok: true as const, seq, created: true };
    });
  }

  cancelInput(requestId: string, at: number): { ok: true } | Refused {
    const id = str(requestId, UUID, "requestId");
    const when = time(at, "at");
    return this.#write("input_cancel", "continue", () => {
      const changed = this.#db.query("UPDATE inputs SET cancelled_at = COALESCE(cancelled_at, ?) WHERE request_id = ?").run(when, id).changes;
      if (changed === 0) throw new Refuse("unknown_instruction");
      return { ok: true as const };
    });
  }

  // 재시작 뒤 새 세션이 이어받을 입력. 처리 위치 뒤의 입력을 순번대로 내고, 취소·만료는 따로 낸다(전하지 않는다).
  pendingInputs(now: number): Read<PendingInputs> {
    const when = time(now, "now");
    return this.#read(() => {
      const processedSeq = safe((this.#db.query("SELECT COALESCE(MAX(processed_seq), 0) AS n FROM sessions").get() as { n: number }).n, "processed_seq");
      const rows = this.#db
        .query("SELECT request_id, seq, source_ref, source_expires_at, cancelled_at FROM inputs WHERE seq > ? ORDER BY seq")
        .all(processedSeq) as { request_id: string; seq: number; source_ref: string; source_expires_at: number; cancelled_at: number | null }[];
      const out: PendingInputs = { processedSeq, pending: [], cancelled: [], expired: [] };
      for (const row of rows) {
        if (row.cancelled_at !== null) out.cancelled.push(row.request_id);
        else if (row.source_expires_at <= when) out.expired.push(row.request_id);
        else out.pending.push({ requestId: row.request_id, seq: row.seq, sourceRef: { ref: row.source_ref, expiresAt: row.source_expires_at } });
      }
      return out;
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
    const principal = parsePrincipal(row.executor_id);
    const fits = kind === "worker" ? principal?.kind === "worker_executor" && principal.role === row.role : principal?.kind === "session_executor";
    if (!fits) throw new LedgerInputError("executorId: 이 실행을 맡을 수 있는 실행기 주체가 아니다");
    const credential = credentialRef(v.credential, "credential");
    return this.#write("admit", "start", () => {
      if (row.dedupe_key !== null) {
        const same = this.#db.query("SELECT * FROM runs WHERE dedupe_key = ?").get(row.dedupe_key) as RunRow | null;
        if (same) return { ok: true as const, run: toRun(same), created: false };
      }
      const generation = this.#epoch();
      const seq = (this.#db.query("SELECT COALESCE(MAX(queue_seq), 0) + 1 AS seq FROM runs").get() as { seq: number }).seq;
      this.#db
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
  // 돌려준 credential이 자격 발급의 근거다. 접수가 닫혔거나 정지 중이거나 세대가 다르면 주지 않는다.
  startRun(input: StartRunInput): { ok: true; run: Run; credential: CredentialRef } | Refused {
    const v = exact(input, ["runId", "requestId", "stopGeneration", "now"], "startRun");
    const runId = str(v.runId, UUID, "runId");
    const requestId = str(v.requestId, UUID, "requestId");
    const stopGeneration = count(v.stopGeneration, "stopGeneration");
    const now = time(v.now, "now");
    return this.#write("start", "start", () => {
      this.#requireStopGeneration(stopGeneration);
      const row = this.#requireStartable(this.#runRow(runId), "worker", now);
      // v1 task_start로 만들 수 있는 실행만 자리를 잡는다(입력 digest, 1 이상의 예산, 역할과 지정 실행기).
      const principal = parsePrincipal(row.executor_id);
      if (row.input_digest === null || row.budget_left < 1 || principal?.kind !== "worker_executor" || principal.role !== row.role) throw new Refuse("not_startable");
      this.#setState(row, "preparing", now);
      this.#db.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, 'task_start', ?, ?)").run(requestId, runId, stopGeneration, now);
      const after = this.#runRow(runId) as RunRow;
      return { ok: true as const, run: toRun(after), credential: toRun(after).credential };
    });
  }

  // 세션 시작: 규칙 확인 기록(D-51)과 인수 영수증(D-50)을 장부와 대조하고, 시작 허가를 한 번 쓴다. 모두 한 트랜잭션이다.
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
    return this.#write("start_session", "start", () => {
      this.#requireStopGeneration(stopGeneration);
      this.#requireStartable(this.#runRow(runId), "session", now);
      const row = this.#runRow(runId) as RunRow;
      const check = this.#db.query("SELECT outcome, restarted_marker_digest, start_permit_id FROM rule_checks WHERE report_id = ?").get(ruleCheckId) as {
        outcome: string;
        restarted_marker_digest: string | null;
        start_permit_id: string | null;
      } | null;
      if (check === null || check.outcome !== "rule_present" || check.restarted_marker_digest !== marker || check.start_permit_id === null) {
        throw new Refuse("reference_mismatch");
      }
      // 바로 앞에 연 세션. 인수는 그 세션의 교체를 끝낸 것이어야 한다.
      const previous = this.#db.query("SELECT s.run_id FROM sessions s JOIN runs r ON r.run_id = s.run_id ORDER BY r.queue_seq DESC LIMIT 1").get() as { run_id: string } | null;
      if (takeoverId === null) {
        // 첫 세션만 인수 영수증 없이 연다. 앞 세션이 한 번이라도 있었으면 인수가 있어야 한다.
        if (previous !== null) throw new Refuse("reference_mismatch");
      } else {
        const takeover = this.#db.query("SELECT previous_run_id, new_generation_marker_digest, start_permit_id, confirmed_at FROM session_takeovers WHERE receipt_id = ?").get(takeoverId) as {
          previous_run_id: string;
          new_generation_marker_digest: string;
          start_permit_id: string;
          confirmed_at: number | null;
        } | null;
        if (
          takeover === null ||
          takeover.confirmed_at === null ||
          previous === null ||
          takeover.previous_run_id !== previous.run_id ||
          takeover.new_generation_marker_digest !== marker ||
          takeover.start_permit_id !== check.start_permit_id
        ) {
          throw new Refuse("reference_mismatch");
        }
        if (this.#db.query("SELECT 1 AS x FROM sessions WHERE takeover_receipt_id = ?").get(takeoverId)) throw new Refuse("reference_mismatch");
      }
      if (this.#db.query("SELECT 1 AS x FROM start_permit_uses WHERE start_permit_id = ?").get(check.start_permit_id)) throw new Refuse("permit_used");
      this.#setState(row, "preparing", now);
      this.#db.query("INSERT INTO start_permit_uses (start_permit_id, run_id, used_at) VALUES (?, ?, ?)").run(check.start_permit_id, runId, now);
      this.#db
        .query(
          "INSERT INTO sessions (session_id, run_id, generation_marker_digest, takeover_receipt_id, rule_check_id, handoff_ref, handoff_digest) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(sessionId, runId, marker, takeoverId, ruleCheckId, handoffRef, handoffDigest);
      this.#db.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, 'session_start', ?, ?)").run(requestId, runId, stopGeneration, now);
      const after = toRun(this.#runRow(runId) as RunRow);
      return { ok: true as const, run: after, credential: after.credential };
    });
  }

  // 종료·취소 지시. 정지 중에도, 접수가 닫혀도, 장부가 실패한 뒤에도 시도한다. 아직 지시를 내지 않은 대기 실행은 not_started로 닫는다.
  // 지시의 정지 세대는 장부의 지금 값과 같아야 한다. 장부를 쓸 수 없어 이 기록이 실패해도 호출자는 최선 노력의 종료를 보낼 수 있지만,
  // 그것은 "지금 세대로 발급하도록 기록한 지시"가 아니다.
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
      this.#requireStopGeneration(stopGeneration);
      if (["preparing", "running", "unknown_running"].includes(row.state)) this.#setState(row, "stopping", now);
      this.#db.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, ?, ?, ?)").run(requestId, runId, action, stopGeneration, now);
      return { ok: true as const, run: toRun(this.#runRow(runId) as RunRow) };
    });
  }

  // 결과 확정 지시. 결과 쪽 상태(종료 확인이 있는)에서만 적는다. 정리 영수증은 이 지시만 가리킬 수 있다.
  recordFinalizeInstruction(input: InstructionInput): { ok: true } | Refused {
    const v = exact(input, ["runId", "requestId", "stopGeneration", "now"], "recordFinalizeInstruction");
    const runId = str(v.runId, UUID, "runId");
    const requestId = str(v.requestId, UUID, "requestId");
    const stopGeneration = count(v.stopGeneration, "stopGeneration");
    const now = time(v.now, "now");
    return this.#write("finalize_instruction", "continue", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (!["ready_result", "failed_stopped", "cleanup_pending"].includes(row.state)) throw new Refuse("transition_denied");
      this.#requireStopGeneration(stopGeneration);
      this.#db.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, 'result_finalize', ?, ?)").run(requestId, runId, stopGeneration, now);
      return { ok: true as const };
    });
  }

  // 실행 갱신(run_renew) 지시. 기존 실행의 임대를 늘리는 것이라 새 일과 같은 전제(접수 열림, 정지 아님, 지금 세대)를 본다.
  recordRenewInstruction(input: InstructionInput): { ok: true } | Refused {
    const v = exact(input, ["runId", "requestId", "stopGeneration", "now"], "recordRenewInstruction");
    const runId = str(v.runId, UUID, "runId");
    const requestId = str(v.requestId, UUID, "requestId");
    const stopGeneration = count(v.stopGeneration, "stopGeneration");
    const now = time(v.now, "now");
    return this.#write("renew_instruction", "start", () => {
      this.#requireStopGeneration(stopGeneration);
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (!["preparing", "running"].includes(row.state)) throw new Refuse("transition_denied");
      if (row.run_generation !== this.#epoch()) throw new Refuse("run_generation_stale");
      this.#db.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, 'run_renew', ?, ?)").run(requestId, runId, stopGeneration, now);
      return { ok: true as const };
    });
  }

  // 결과 검사의 판정(checking에서만). digest가 있으면 ready_result, null이면 failed_stopped.
  // reportId를 주면 그 결과 보고를 같은 트랜잭션에서 반영 완료로 적는다(보고의 결과 digest와 같아야 한다).
  markResult(input: { runId: string; resultDigest: string | null; reportId?: string; now: number }): { ok: true; run: Run } | Refused {
    const v = exact(input, ["runId", "resultDigest", "reportId", "now"], "markResult");
    const runId = str(v.runId, UUID, "runId");
    const digest = strOrNull(v.resultDigest, SHA256, "resultDigest");
    const reportId = v.reportId === undefined ? null : str(v.reportId, UUID, "reportId");
    const now = time(v.now, "now");
    return this.#write("result", "continue", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (row.state !== "checking") throw new Refuse("transition_denied");
      if (reportId !== null) {
        const report = this.#db.query("SELECT run_id, result_digest, applied_at FROM deliveries WHERE id = ? AND action = 'report_result'").get(reportId) as {
          run_id: string;
          result_digest: string;
          applied_at: number | null;
        } | null;
        if (report === null || report.run_id !== runId || report.applied_at !== null || (digest !== null && report.result_digest !== digest)) throw new Refuse("reference_mismatch");
        this.#db.query("UPDATE deliveries SET applied_at = ? WHERE id = ?").run(now, reportId);
      }
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

  // 남은 예산을 줄인다. 늘리는 쓰기는 거절한다(재시도·계정 전환이 예산을 새로 주지 않는다). 비교는 트리거가 한다.
  recordBudget(input: { runId: string; budgetLeft: number; now: number }): { ok: true } | Refused {
    const v = exact(input, ["runId", "budgetLeft", "now"], "recordBudget");
    const runId = str(v.runId, UUID, "runId");
    const left = count(v.budgetLeft, "budgetLeft");
    const now = time(v.now, "now");
    return this.#write("budget", "continue", () => {
      const changed = this.#db.query("UPDATE runs SET budget_left = ?, updated_at = ? WHERE run_id = ?").run(left, now, runId).changes;
      if (changed === 0) throw new Refuse("unknown_run");
      return { ok: true as const };
    });
  }

  // 끊김 판정(또는 재시작) 뒤: 끝났다고 증명되지 않은 진행 중 실행을 계약의 stateAfterLoss로 unknown_running에 둔다.
  // 종료 확인 영수증이 이미 적힌 실행(checking 등)은 건드리지 않는다. 계약의 stateAfterLoss는 종료 증명이 없는
  // 실행기 쪽 상태의 함수라, 장부에서는 stop_receipt_id가 없는 줄에만 그대로 쓴다.
  markLost(now: number): { ok: true; runIds: string[] } | Refused {
    const when = time(now, "now");
    return this.#write("lost", "continue", () => {
      const rows = this.#db.query(`SELECT * FROM runs WHERE stop_receipt_id IS NULL AND state IN (${IN_FLIGHT.map(() => "?").join(", ")})`).all(...IN_FLIGHT) as RunRow[];
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
    return this.#read(() => (this.#db.query("SELECT * FROM runs ORDER BY queue_seq").all() as RunRow[]).map(toRun));
  }

  // 계약의 VerifyContext.runGeneration에 넘긴다. 읽기가 실패하면 undefined(장부 밖)가 아니라 던진다.
  runGeneration(runId: string): number | undefined {
    const read = this.#read(() => (this.#db.query("SELECT run_generation FROM runs WHERE run_id = ?").get(runId) as { run_generation: number } | null)?.run_generation);
    if (!read.known) throw new LedgerUnavailableError(read.reason, "runGeneration");
    return read.value === undefined ? undefined : safe(read.value, "run_generation");
  }

  // 새 실행에 자리가 있는가. 장부를 못 쓰면 없다(모름은 모름이고 자리는 주지 않는다). 점유 차단이 있으면 없다.
  slotFree(kind: RunKind): Read<boolean> {
    if (this.#broken !== null) return { known: false, reason: this.#broken };
    return this.#read(() => {
      const held = this.#db.query(`SELECT 1 AS x FROM runs WHERE kind = ? AND state NOT IN (${SLOT_FREE.map(() => "?").join(", ")}) LIMIT 1`).get(kind, ...SLOT_FREE);
      return held === null && !this.#slotHeld(kind);
    });
  }

  // ---- 점유 차단 ----

  // 재시작 복원 2단계가 적는다. 같은 (실행기, 실행)은 한 줄이다.
  holdSlots(key: symbol, holds: readonly SlotHold[], now: number): { ok: true } | Refused {
    if (key !== RESTORE_KEY) throw new TypeError("점유 차단은 재시작 복원만 적는다");
    const when = time(now, "now");
    return this.#write("slot_hold", "continue", () => {
      for (const hold of holds) {
        this.#db
          .query("INSERT INTO slot_holds (executor_id, run_id, kind, run_generation, why, held_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
          .run(hold.executorId, hold.runId, hold.kind, hold.runGeneration, hold.why, when);
      }
      return { ok: true as const };
    });
  }

  slotHolds(): Read<SlotHold[]> {
    return this.#read(() =>
      (
        this.#db.query("SELECT executor_id, run_id, kind, run_generation, why FROM slot_holds ORDER BY held_at, executor_id, run_id").all() as {
          executor_id: string;
          run_id: string;
          kind: RunKind;
          run_generation: number | null;
          why: SlotHold["why"];
        }[]
      ).map((row) => ({ executorId: row.executor_id, runId: row.run_id, kind: row.kind, runGeneration: row.run_generation, why: row.why })),
    );
  }

  // 그 실행기가 그 실행을 더는 쥐지 않는다고 재대조했거나 종료를 증명했을 때 부른다. 무엇을 증명으로 볼지는 실제 연결 작업이 정한다.
  clearSlotHold(input: { executorId: string; runId: string }): { ok: true } | Refused {
    const v = exact(input, ["executorId", "runId"], "clearSlotHold");
    const executorId = str(v.executorId, REF, "executorId");
    const runId = str(v.runId, UUID, "runId");
    return this.#write("slot_release", "continue", () => {
      const changed = this.#db.query("DELETE FROM slot_holds WHERE executor_id = ? AND run_id = ?").run(executorId, runId).changes;
      if (changed === 0) throw new Refuse("unknown_run");
      return { ok: true as const };
    });
  }

  // ---- 영수증·보고 ----

  // id → digest로 한 번만 반영한다. 같은 id에 다른 digest는 receipt_conflicts에 남기고 receipt_conflict로 거절한다.
  // 반영할 수 없는 영수증(실행이 없음, 그 상태에서 허용되지 않음)은 적지 않고 거절한다. 실행기는 ack가 올 때까지 다시 보낸다.
  #deliver(
    id: string,
    action: string,
    runId: string | null,
    digest: string,
    now: number,
    extra: { instructionRequestId?: string; storedRef?: string | null; resultDigest?: string | null } = {},
  ): Delivery | Refused {
    const before = this.#db.query("SELECT body_digest FROM deliveries WHERE id = ?").get(id) as { body_digest: string } | null;
    if (before) {
      if (before.body_digest === digest) return "duplicate";
      this.#db.query("INSERT INTO receipt_conflicts (id, first_digest, other_digest, received_at) VALUES (?, ?, ?, ?)").run(id, before.body_digest, digest, now);
      return { ok: false, reason: "receipt_conflict" };
    }
    this.#db
      .query("INSERT INTO deliveries (id, action, run_id, instruction_request_id, body_digest, stored_ref, result_digest, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, action, runId, extra.instructionRequestId ?? null, digest, extra.storedRef ?? null, extra.resultDigest ?? null, now);
    return "new";
  }

  // 낸 쪽이 그 실행의 지정 실행기이고 머리의 실행 세대가 장부와 같은지. 다른 인스턴스의 관측은 이 실행의 증거가 아니다.
  #requireSender(row: RunRow, from: EnvelopeFrom): void {
    if (row.executor_id !== from.sender) throw new Refuse("sender_mismatch");
    if (row.run_generation !== from.runGeneration) throw new Refuse("run_generation_mismatch");
  }

  // 세션 인수 영수증은 다음 세대의 세션 실행기가 낸다. 앞 세션의 지정 실행기이거나, 장부에 지정된 끝나지 않은 세션 실행의 실행기여야 한다.
  #requireTakeoverSender(previous: RunRow, from: EnvelopeFrom): void {
    if (previous.run_generation !== from.runGeneration) throw new Refuse("run_generation_mismatch");
    if (parsePrincipal(from.sender)?.kind !== "session_executor") throw new Refuse("sender_mismatch");
    if (from.sender === previous.executor_id) return;
    const assigned = this.#db.query("SELECT 1 AS x FROM runs WHERE kind = 'session' AND executor_id = ? AND state NOT IN ('finalized', 'not_started') LIMIT 1").get(from.sender);
    if (assigned === null) throw new Refuse("sender_mismatch");
  }

  applyReceipt(input: ReceiptInput, from: EnvelopeFrom): { ok: true; delivery: Delivery; ack: string } | Refused {
    const r = validateReceipt(input);
    const sender = validateFrom(from);
    return this.#write("receipt", "continue", () => {
      const runId = r.action === "receipt_session_takeover" ? r.previousRunId : r.runId;
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (r.action === "receipt_session_takeover") this.#requireTakeoverSender(row, sender);
      else this.#requireSender(row, sender);
      const instructionRequestId = "instructionRequestId" in r ? r.instructionRequestId : undefined;
      if (instructionRequestId !== undefined) this.#instruction(instructionRequestId, row.run_id, r.action === "receipt_accepted" ? [r.instruction] : r.action === "receipt_started" ? ["task_start", "session_start"] : ["result_finalize"]);
      const delivery = this.#deliver(r.receiptId, r.action, runId, r.bodyDigest, r.now, { instructionRequestId });
      if (delivery === "duplicate") return { ok: true as const, delivery, ack: r.receiptId };
      if (typeof delivery === "object") return delivery;
      this.#faults.at("receipt:after_insert");
      this.#effect(row, r);
      return { ok: true as const, delivery, ack: r.receiptId };
    });
  }

  #instruction(requestId: string, runId: string, actions: readonly string[]): void {
    const found = this.#db.query("SELECT action FROM instructions WHERE request_id = ? AND run_id = ?").get(requestId, runId) as { action: string } | null;
    if (found === null || !actions.includes(found.action)) throw new Refuse("unknown_instruction");
  }

  #effect(row: RunRow, r: ReceiptInput): void {
    switch (r.action) {
      case "receipt_accepted":
        if (row.state === "queued") throw new Refuse("transition_denied");
        this.#db.query("UPDATE runs SET accepted_receipt_id = COALESCE(accepted_receipt_id, ?) WHERE run_id = ?").run(r.receiptId, row.run_id);
        return;
      case "receipt_started":
        if (row.state === "queued") throw new Refuse("transition_denied");
        this.#db.query("UPDATE runs SET started_receipt_id = COALESCE(started_receipt_id, ?) WHERE run_id = ?").run(r.receiptId, row.run_id);
        if (row.state === "preparing") this.#setState(this.#runRow(row.run_id) as RunRow, "running", r.now);
        return;
      case "receipt_stopped": {
        if (row.kind !== "worker") throw new Refuse("invariant_violation");
        // 이미 종료 확인이 있으면 상태를 다시 옮기지 않는다(다른 id의 늦은 영수증).
        if (row.stop_receipt_id !== null) return;
        this.#setState(row, r.exit === "completed" ? "checking" : "failed_stopped", r.now, { stop_receipt_id: r.receiptId });
        return;
      }
      case "receipt_cleaned":
        this.#setState(row, "finalized", r.now, { cleaned_receipt_id: r.receiptId });
        return;
      case "receipt_session_takeover": {
        if (row.kind !== "session") throw new Refuse("invariant_violation");
        // 인수 대상: 장부가 종료(교체)를 지시한 앞 세션이어야 한다.
        if (!["stopping", "unknown_running"].includes(row.state)) throw new Refuse("transition_denied");
        if (this.#db.query("SELECT 1 AS x FROM instructions WHERE run_id = ? AND action = 'session_stop'").get(row.run_id) === null) throw new Refuse("reference_mismatch");
        // 새 세대 표식은 앞 세션의 표식과 달라야 하고, 새 허가는 아직 쓰이지 않았어야 한다.
        const previous = this.#db.query("SELECT generation_marker_digest FROM sessions WHERE run_id = ?").get(row.run_id) as { generation_marker_digest: string } | null;
        if (previous === null || previous.generation_marker_digest === r.newGenerationMarkerDigest) throw new Refuse("reference_mismatch");
        if (this.#db.query("SELECT 1 AS x FROM start_permit_uses WHERE start_permit_id = ?").get(r.startPermitId)) throw new Refuse("permit_used");
        if (this.#db.query("SELECT 1 AS x FROM session_takeovers WHERE start_permit_id = ?").get(r.startPermitId)) throw new Refuse("permit_used");
        this.#db
          .query("INSERT INTO session_takeovers (receipt_id, previous_run_id, new_generation_marker_digest, start_permit_id, taken_over_at) VALUES (?, ?, ?, ?, ?)")
          .run(r.receiptId, row.run_id, r.newGenerationMarkerDigest, r.startPermitId, r.takenOverAt);
        // 같은 표식·허가의 규칙 확인이 이미 있으면 지금 확정한다. 없으면 인수 대기로 두고 앞 세션의 슬롯을 쥔 채 기다린다.
        this.#confirmTakeovers(r.now);
        return;
      }
    }
  }

  // 규칙 확인(rule_present)과 표식·허가가 같은 인수 대기를 확정하고 앞 세션을 끝낸다.
  #confirmTakeovers(now: number): void {
    const ready = this.#db
      .query(
        `SELECT t.receipt_id, t.previous_run_id, t.taken_over_at FROM session_takeovers t
         JOIN rule_checks c ON c.outcome = 'rule_present' AND c.restarted_marker_digest = t.new_generation_marker_digest AND c.start_permit_id = t.start_permit_id
         WHERE t.confirmed_at IS NULL`,
      )
      .all() as { receipt_id: string; previous_run_id: string; taken_over_at: number }[];
    for (const takeover of ready) {
      const previous = this.#runRow(takeover.previous_run_id) as RunRow;
      this.#setState(previous, "finalized", now, { stop_receipt_id: takeover.receipt_id });
      this.#db.query("UPDATE session_takeovers SET confirmed_at = ? WHERE receipt_id = ?").run(now, takeover.receipt_id);
      this.#db.query("UPDATE sessions SET rotated_at = COALESCE(rotated_at, ?) WHERE run_id = ?").run(takeover.taken_over_at, takeover.previous_run_id);
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
        this.#db
          .query("INSERT INTO rule_checks (report_id, outcome, first_marker_digest, restarted_marker_digest, start_permit_id, checked_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(reportId, outcome, first, restarted, permit, checkedAt);
        this.#confirmTakeovers(now);
      }
      return { ok: true as const, delivery, ack: reportId };
    });
  }

  // 보고를 받아 적는다. 결과 보고는 결과를 저장한 자리와 digest가 함께 커밋된 뒤에만 ack가 나간다.
  recordReport(input: ReportInput, from: EnvelopeFrom): { ok: true; delivery: Delivery; ack: string } | Refused {
    const v = exact(input, ["reportId", "action", "runId", "bodyDigest", "storedRef", "resultDigest", "now"], "recordReport");
    const reportId = str(v.reportId, UUID, "reportId");
    const action = oneOf(v.action, ["report_result", "report_session_broken", "report_hook_event"] as const, "action");
    const runId = str(v.runId, UUID, "runId");
    const digest = str(v.bodyDigest, SHA256, "bodyDigest");
    const storedRef = strOrNull(v.storedRef, STORED_REF, "storedRef");
    const resultDigest = strOrNull(v.resultDigest, SHA256, "resultDigest");
    if ((action === "report_result") !== (storedRef !== null && resultDigest !== null) || (action !== "report_result" && (storedRef !== null || resultDigest !== null))) {
      throw new LedgerInputError("recordReport: 결과 보고만 저장 자리와 결과 digest를 함께 싣는다");
    }
    const sender = validateFrom(from);
    const now = time(v.now, "now");
    return this.#write("report", "continue", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      this.#requireSender(row, sender);
      const delivery = this.#deliver(reportId, action, runId, digest, now, { storedRef, resultDigest });
      if (typeof delivery === "object") return delivery;
      return { ok: true as const, delivery, ack: reportId };
    });
  }

  // ack를 낸 뒤 아직 업무에 반영하지 않은 보고. 재시작 뒤 결과 검사를 다시 꺼내는 데 쓴다.
  pendingReports(): Read<PendingReport[]> {
    return this.#read(() =>
      (
        this.#db
          .query(
            "SELECT id, action, run_id, stored_ref, result_digest FROM deliveries WHERE applied_at IS NULL AND action IN ('report_result', 'report_session_broken', 'report_hook_event') ORDER BY received_at, id",
          )
          .all() as { id: string; action: PendingReport["action"]; run_id: string; stored_ref: string | null; result_digest: string | null }[]
      ).map((row) => ({ reportId: row.id, action: row.action, runId: row.run_id, storedRef: row.stored_ref, resultDigest: row.result_digest })),
    );
  }

  // 결과 밖의 보고(세션 깨짐, 훅 사건)를 반영했다고 적는다. 결과 보고는 markResult의 reportId로 적는다.
  settleReport(input: { reportId: string; now: number }): { ok: true } | Refused {
    const v = exact(input, ["reportId", "now"], "settleReport");
    const reportId = str(v.reportId, UUID, "reportId");
    const now = time(v.now, "now");
    return this.#write("report_settle", "continue", () => {
      const changed = this.#db
        .query("UPDATE deliveries SET applied_at = ? WHERE id = ? AND applied_at IS NULL AND action IN ('report_session_broken', 'report_hook_event')")
        .run(now, reportId).changes;
      if (changed === 0) throw new Refuse("reference_mismatch");
      return { ok: true as const };
    });
  }

  conflicts(): Read<{ id: string; firstDigest: string; otherDigest: string }[]> {
    return this.#read(() =>
      (this.#db.query("SELECT id, first_digest, other_digest FROM receipt_conflicts ORDER BY seq").all() as { id: string; first_digest: string; other_digest: string }[]).map(
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
      const changed = this.#db.query("UPDATE sessions SET processed_seq = MAX(processed_seq, ?) WHERE session_id = ?").run(seq, sessionId).changes;
      if (changed === 0) throw new Refuse("unknown_run");
      return { ok: true as const };
    });
  }

  planRotation(input: { sessionId: string; at: number }): { ok: true } | Refused {
    const v = exact(input, ["sessionId", "at"], "planRotation");
    const sessionId = str(v.sessionId, UUID, "sessionId");
    const at = time(v.at, "at");
    return this.#write("rotation", "continue", () => {
      const changed = this.#db.query("UPDATE sessions SET rotation_planned_at = ? WHERE session_id = ?").run(at, sessionId).changes;
      if (changed === 0) throw new Refuse("unknown_run");
      return { ok: true as const };
    });
  }

  // ---- 게시 연결 ----

  // 같은 작업 ID·같은 후보·같은 실행이면 재시도로 보고 성공이다. 다른 후보나 실행이면 publication_conflict이고 기존 연결은 그대로다.
  recordPublication(input: { frontJobId: string; candidateDigest: string; runId: string | null; now: number }): { ok: true; created: boolean } | Refused {
    const v = exact(input, ["frontJobId", "candidateDigest", "runId", "now"], "recordPublication");
    const jobId = str(v.frontJobId, REF, "frontJobId");
    const digest = str(v.candidateDigest, SHA256, "candidateDigest");
    const runId = strOrNull(v.runId, UUID, "runId");
    const now = time(v.now, "now");
    return this.#write("publication", "start", () => {
      const before = this.#publication(jobId);
      if (before !== null) {
        if (before.candidateDigest !== digest || before.runId !== runId) throw new Refuse("publication_conflict");
        return { ok: true as const, created: false };
      }
      this.#db.query("INSERT INTO publications (front_job_id, candidate_digest, run_id, state, updated_at) VALUES (?, ?, ?, 'pending', ?)").run(jobId, digest, runId, now);
      return { ok: true as const, created: true };
    });
  }

  // 현관의 답을 적는다. 시간 초과·모름은 unknown이고 "게시 안 됨"이 아니다. 확정은 다시 바뀌지 않는다(트리거).
  settlePublication(frontJobId: string, answer: PublicationAnswer, now: number): { ok: true; publication: Publication } | Refused {
    const jobId = str(frontJobId, REF, "frontJobId");
    const when = time(now, "now");
    const kind = oneOf(answer.kind, ["confirmed", "pending", "unknown"] as const, "answer.kind");
    const outcome = kind === "confirmed" ? oneOf((answer as { outcome: unknown }).outcome, ["posted", "not_posted"] as const, "answer.outcome") : null;
    return this.#write("publication_settle", "continue", () => {
      const changed = this.#db.query("UPDATE publications SET state = ?, outcome = ?, updated_at = ? WHERE front_job_id = ?").run(kind, outcome, when, jobId).changes;
      if (changed === 0) throw new Refuse("unknown_instruction");
      return { ok: true as const, publication: this.#publication(jobId) as Publication };
    });
  }

  #publication(jobId: string): Publication | null {
    const row = this.#db.query("SELECT front_job_id, candidate_digest, run_id, state, outcome FROM publications WHERE front_job_id = ?").get(jobId) as {
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
      (this.#db.query("SELECT front_job_id FROM publications ORDER BY front_job_id").all() as { front_job_id: string }[]).map((r) => this.#publication(r.front_job_id) as Publication),
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
          this.#db.query("DELETE FROM nonces WHERE expires_at < ?").run(this.#clock() - limits.NONCE_RETENTION_MS);
          const inserted = this.#db.query("INSERT INTO nonces (sender, nonce, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(who, value, until).changes;
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

  // 재시작 복원이 쓰는 읽기 묶음. 끝난 실행은 빼고 돌려준다. 대기 실행의 입력이 취소됐는지도 함께 준다.
  openRuns(): Read<(Run & { inputCancelled: boolean })[]> {
    return this.#read(() =>
      (
        this.#db
          .query(
            `SELECT r.*, i.cancelled_at AS input_cancelled_at FROM runs r LEFT JOIN inputs i ON i.request_id = r.input_request_id
             WHERE r.state NOT IN (${TERMINAL.map(() => "?").join(", ")}) ORDER BY r.queue_seq`,
          )
          .all(...TERMINAL) as (RunRow & { input_cancelled_at: number | null })[]
      ).map((row) => ({ ...toRun(row), inputCancelled: row.input_cancelled_at !== null })),
    );
  }
}

function validateFrom(from: EnvelopeFrom): EnvelopeFrom {
  const v = exact(from, ["sender", "runGeneration"], "from");
  const sender = str(v.sender, REF, "from.sender");
  if (parsePrincipal(sender) === undefined) throw new LedgerInputError("from.sender: 계약의 주체 이름이 아니다");
  const runGeneration = count(v.runGeneration, "from.runGeneration");
  if (runGeneration < 1) throw new LedgerInputError("from.runGeneration: 1 이상이어야 한다");
  return { sender, runGeneration };
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
  if (action === "receipt_accepted") {
    const v = exact(input, ["action", "receiptId", "runId", "instructionRequestId", "instruction", "bodyDigest", "now"], "receipt");
    return {
      action,
      receiptId: str(v.receiptId, UUID, "receiptId"),
      runId: str(v.runId, UUID, "runId"),
      instructionRequestId: str(v.instructionRequestId, UUID, "instructionRequestId"),
      instruction: oneOf(v.instruction, INSTRUCTIONS, "instruction"),
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
