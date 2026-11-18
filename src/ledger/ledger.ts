// 감독 장부(D-56): SQLite 파일 하나, 감독 하나만 쓴다. 표와 쓰기 규칙의 요약은 ledger.md.
//
// 열 때 고른 것과 이유(Bun 1.4.4·SQLite 3.53.4에서 실행해 확인):
// - locking_mode=EXCLUSIVE: 첫 쓰기 트랜잭션에서 파일 잠금을 잡고 닫을 때까지 놓지 않는다. 같은 파일을 다른 연결이나
//   다른 프로세스가 열면 첫 접근에서 SQLITE_BUSY다(busy_timeout 0으로 기다리지 않는다). 프로세스가 죽으면 운영체제가 잠금을 푼다.
//   별도 잠금 파일을 두지 않는 이유: SQLite가 이미 쥐는 잠금이라 장부와 잠금이 어긋날 수 없다.
//   함정: POSIX 잠금은 같은 프로세스가 같은 파일의 다른 FD를 닫기만 해도 풀린다. 그래서 있는 장부 파일은 SQLite 연결로만 읽는다.
// - journal_mode=WAL + synchronous=FULL: 커밋마다 WAL을 fsync한다. 그래서 커밋을 돌려준 쓰기(실행 줄, 영수증)는 전원이 나가도
//   남고, 실행 줄의 커밋이 끝난 뒤에만 지시를 내므로 접수 기록이 영수증보다 먼저 남는다. NORMAL은 마지막 커밋을 잃을 수 있다.
//   EXCLUSIVE와 함께 쓰면 공유 메모리(-shm) 파일 없이 동작한다. 로컬 볼륨 전제다(네트워크 파일시스템이 아님).
//   첫 설치는 저널 모드로 끝내고 첫 설치 기록을 커밋한 뒤에 WAL로 바꾼다. 끊긴 첫 설치의 내용이 본체 파일에만 있어야
//   WAL을 복구하지 않고(파일을 바꾸지 않고) 이어 받아도 되는지 가를 수 있다.
// - foreign_keys=ON: 지시·세션·게시·영수증이 없는 실행을 가리키지 못한다. 연결마다 켜야 하는 설정이다.
// - quick_check: 깨진 파일은 열 때 SQLITE_NOTADB·SQLITE_CORRUPT로 걸러 "쓸 수 없음"으로 연다(열지 않는다).
//
// 새 업무(접수·실행 줄·시작·자격·게시·갱신)의 공통 전제는 #write의 "start" 한 자리에 있다: 장부가 건강하고, 트랜잭션 안에서
// 읽은 지금의 정지 기록이 있고 정지가 아니며, 지금의 복원 시도가 바로 그 정지 상태에서 낸 접수 허가(#grant)가 살아 있다.
import { constants as sqliteOpen, Database } from "bun:sqlite";
import { type BigIntStats, closeSync, constants as fileOpen, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  HOOK_EVENTS,
  type InstructionAction,
  INSTRUCTIONS,
  limits,
  type NonceStore,
  parsePrincipal,
  ROLES,
  type RunState,
  SESSION_BROKEN_CAUSES,
  stateAfterLoss,
  STOP_FAILURE_ERRORS,
} from "../contract/v1/index.ts";
import { classify, describe, type Faults, LedgerUnavailableError, NO_FAULTS, type UnavailableReason } from "./errors.ts";
import {
  bool,
  count,
  type CredentialRef,
  credentialRef,
  exact,
  HANDOFF_REF,
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
import { applyMigration, loadMigrations, migrate, type Migration, validateMigrations } from "./migrate.ts";
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
  "run_blocked",
  "input_cancelled",
  "input_expired",
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
  "session_start_closed",
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

// 재시작 복원이 실행기의 점유와 장부가 맞지 않아 남긴 관측. 줄은 지워지지 않고, 줄이 있는 실행 ID는 영영 시작하지 않는다.
// holdsSlot이 true면 그 종류의 슬롯도 사용 중이다(끝났다고 보고한 관측과 해제한 관측은 실행 ID만 막는다).
export interface SlotHoldObservation {
  executorId: string;
  runId: string;
  kind: RunKind;
  runGeneration: number;
  holdsSlot: boolean;
  why: "outside_ledger" | "ended_in_ledger" | "state" | "executor" | "generation";
}

// observation은 이 관측의 번호다. 차단을 푸는 쪽은 자기가 확인한 관측의 세대와 번호를 함께 넘긴다.
export interface SlotHold extends SlotHoldObservation {
  observation: number;
}

// 이 대기 실행 자체를 시작하면 안 되는 이유. 5단계의 후보 목록과 시작 트랜잭션이 같은 판정을 읽는다(접수·슬롯·예산은 시작 트랜잭션만 본다).
export type StartBar = "run_generation_stale" | "run_blocked" | "input_cancelled" | "input_expired" | "deadline_passed";

// 복원 시도 하나의 표식. 장부만 만들고(beginRestore) 같은 값이 다시 나오지 않는다.
export type RestoreAttempt = symbol;

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
  // 호출자가 본 시각. 꼴만 확인한다. 기한 판정과 발행 시각은 장부의 시계 한 번으로 정한다.
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

// 규칙 확인 보고를 낸 쪽. 이 보고는 실행에 속하지 않아 머리의 실행 세대가 0이므로 낸 쪽 이름만 넘긴다.
export interface RuleCheckFrom {
  sender: string;
}

// 훅·세션 깨짐 보고를 ack한 뒤에도 업무를 잇는 데 필요한 칸(v1이 허용한 값만). turnId는 v1 훅 보고의 prompt_id다.
export type ReportSignal =
  | { kind: "hook"; event: (typeof HOOK_EVENTS)[number]; sessionId: string; turnId: string; stopFailure: (typeof STOP_FAILURE_ERRORS)[number] | null; observedAt: number }
  | { kind: "session_broken"; cause: (typeof SESSION_BROKEN_CAUSES)[number]; markerDigest: string; observedAt: number };

// 결과·훅·세션 깨짐 보고: 장부는 같은 보고를 한 번만 반영하고 업무를 잇는 데 필요한 것만 적는다(본문은 적지 않는다).
// 결과 보고는 감독이 결과를 먼저 저장한 자리와 그 digest를 함께 넘긴다. 그래야 ack 뒤에 끊겨도 반영할 결과가 장부에 남는다.
// 훅·세션 깨짐 보고는 signal을 함께 넘긴다. 결과 보고의 signal은 null이다.
export interface ReportInput {
  reportId: string;
  action: "report_result" | "report_session_broken" | "report_hook_event";
  runId: string;
  bodyDigest: string;
  storedRef: string | null;
  resultDigest: string | null;
  signal?: ReportSignal | null;
  now: number;
}

export interface PendingReport {
  reportId: string;
  action: ReportInput["action"];
  runId: string;
  storedRef: string | null;
  resultDigest: string | null;
  signal?: ReportSignal;
}

// 받아 적은 세션 증거. 이 PR은 적고 읽기까지만 하고, 세션 시작의 근거로 소비하지 않는다(ledger.md "세션 증거").
export interface TakeoverEvidence {
  receiptId: string;
  previousRunId: string;
  sender: string;
  newGenerationMarkerDigest: string;
  startPermitId: string;
  takenOverAt: number;
}

export interface RuleCheckEvidence {
  reportId: string;
  sender: string;
  outcome: RuleCheckInput["outcome"];
  firstMarkerDigest: string;
  restartedMarkerDigest: string | null;
  startPermitId: string | null;
  checkedAt: number;
}

export interface SessionReportEvidence {
  reportId: string;
  action: "report_session_broken" | "report_hook_event";
  runId: string;
  settled: boolean;
  signal: ReportSignal | null;
}

export interface SessionEvidence {
  takeovers: TakeoverEvidence[];
  ruleChecks: RuleCheckEvidence[];
  reports: SessionReportEvidence[];
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
  // 장부에 적는 시각, nonce 정리, 시작 직전의 기한 확인에 쓰는 시계(밀리초).
  clock: () => number;
  // create: 없는 경로를 새로 예약하는 첫 설치, 또는 내용이 끊긴 첫 설치와 정확히 같은 파일의 이어 받기(ledger.md "파일과 잠금").
  // reopen: 이미 만든 장부를 다시 연다. 운영의 보통 기동은 reopen이다. 장부가 사라진 볼륨을 첫 설치로 착각하지 않게 호출자가 고른다.
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

// 이 설치가 만든 파일의 표식(SQLite 머리의 application_id, "OLV1"). 첫 쓰기로 적어 본체 파일의 머리에 남긴다.
const APPLICATION_ID = 0x4f4c5631;
const SIDECARS = ["-wal", "-shm", "-journal"] as const;

type OpenMode = "create" | "reopen";

function notOurs(mode: OpenMode, detail: string): LedgerUnavailableError {
  return new LedgerUnavailableError(mode === "create" ? "foreign_data" : "not_initialized", detail);
}

// 폴더의 경로에 링크가 없을 때만 받는다. SQLite는 링크를 풀어 WAL·저널의 이름을 정하므로, 링크가 있으면 검사한 이름과 실제 이름이 갈라진다.
function ledgerPath(path: string, mode: OpenMode): string {
  const full = resolve(path);
  let real: string;
  try {
    real = realpathSync(dirname(full));
  } catch (error) {
    throw new LedgerUnavailableError("io", `장부 폴더를 읽지 못함: ${describe(error)}`);
  }
  if (real !== dirname(full)) throw notOurs(mode, "장부 폴더의 경로에 심볼릭 링크가 있다");
  return full;
}

// 이름과 종류만 본다(링크를 따라가지 않고 FD를 열지 않는다). 없으면 null, 이름이 하나뿐인 정규 파일이 아니면 던진다.
function fileEntry(path: string, mode: OpenMode): BigIntStats | null {
  let stats: BigIntStats | undefined;
  try {
    stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  } catch (error) {
    throw new LedgerUnavailableError("io", `장부 파일을 확인하지 못함: ${describe(error)}`);
  }
  if (stats === undefined) return null;
  if (!stats.isFile() || stats.nlink !== 1n) throw notOurs(mode, "장부 자리에 이름이 하나인 정규 파일이 아닌 것이 있다");
  return stats;
}

// 없는 경로를 이 호출의 것으로 예약한다. 방금 만든 파일이라 이 FD를 닫아도 풀릴 잠금이 없다.
function reserveFile(path: string): BigIntStats {
  try {
    closeSync(openSync(path, fileOpen.O_CREAT | fileOpen.O_EXCL | fileOpen.O_WRONLY | fileOpen.O_NOFOLLOW, 0o600));
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new LedgerUnavailableError("foreign_data", "예약하는 사이에 다른 파일이 생겼다");
    throw new LedgerUnavailableError("io", `장부 파일을 만들지 못함: ${describe(error)}`);
  }
  const reserved = fileEntry(path, "create");
  if (reserved === null) throw new LedgerUnavailableError("foreign_data", "예약한 파일이 사라졌다");
  return reserved;
}

// 판정과 실제로 쥔 파일이 같은 개체인지 본다. 판정 뒤에 경로가 다른 파일로 바뀌었으면 그 파일을 쓰지 않는다.
function requireSameFile(path: string, judged: BigIntStats, mode: OpenMode): void {
  const now = fileEntry(path, mode);
  if (now === null || now.dev !== judged.dev || now.ino !== judged.ino) throw notOurs(mode, "판정한 뒤에 장부 경로의 파일이 바뀌었다");
}

// 본체 파일만 읽는 연결(immutable): 잠금을 잡지 않고 WAL·저널을 보지 않아 파일을 바꾸지 않는다. 닫을 때 다른 연결의 잠금은 SQLite가 지킨다.
function readOnlyView(path: string): Database {
  const uri = `file:${path.split("/").map(encodeURIComponent).join("/")}?immutable=1`;
  return new Database(uri, sqliteOpen.SQLITE_OPEN_READONLY | sqliteOpen.SQLITE_OPEN_URI);
}

function schemaOf(db: Database): string {
  return JSON.stringify(db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all());
}

function rowsOf(db: Database, table: string): string {
  // 적용 시각은 설치마다 다르다.
  const columns = table === "ledger_migrations" ? "version, name" : "*";
  return JSON.stringify((db.query(`SELECT ${columns} FROM "${table}"`).all() as unknown[]).map((row) => JSON.stringify(row)).sort());
}

function sameContents(db: Database, expected: Database): boolean {
  if (schemaOf(db) !== schemaOf(expected)) return false;
  if (JSON.stringify(db.query("PRAGMA user_version").get()) !== JSON.stringify(expected.query("PRAGMA user_version").get())) return false;
  const tables = expected.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return tables.every(({ name }) => rowsOf(db, name) === rowsOf(expected, name));
}

// 끊긴 첫 설치의 증거: 파일의 스키마와 모든 행이 이 코드의 첫 설치가 어느 판까지 적용했을 때 남기는 내용과 정확히 같다.
// 업무 기록이 한 줄이라도 있거나 판 기록만 흉내 낸 파일은 여기서 걸린다. 내용이 같으면 이어 받아도 잃을 것이 없다.
function requireInterruptedInstall(db: Database, migrations: readonly Migration[]): void {
  const expected = new Database(":memory:");
  try {
    if (sameContents(db, expected)) return;
    for (const migration of migrations) {
      applyMigration(expected, migration, 1);
      if (sameContents(db, expected)) return;
    }
  } catch (error) {
    throw new LedgerUnavailableError("foreign_data", `끊긴 첫 설치와 대조하지 못함: ${describe(error)}`);
  } finally {
    expected.close();
  }
  throw new LedgerUnavailableError("foreign_data", "끊긴 첫 설치의 내용과 다르다");
}

// SQLite가 파일이나 저널을 건드리기 전의 판정. fresh: 이 호출이 새로 예약했다. 그 밖의 받지 않는 모양은 던진다.
function inspectFile(path: string, mode: OpenMode, migrations: readonly Migration[]): { fresh: boolean; file: BigIntStats } {
  const main = fileEntry(path, mode);
  const leftover = SIDECARS.filter((suffix) => fileEntry(`${path}${suffix}`, mode) !== null);
  if (main === null || main.size === 0n) {
    if (mode === "reopen") throw new LedgerUnavailableError("not_initialized", "장부 파일이 없거나 비었다");
    if (leftover.length > 0) throw new LedgerUnavailableError("foreign_data", `본체 없이 남은 파일: ${leftover.join(", ")}`);
    if (main !== null) throw new LedgerUnavailableError("foreign_data", "이미 있는 빈 파일은 이 설치가 예약했다는 증거가 없다");
    return { fresh: true, file: reserveFile(path) };
  }
  if (main.size < 100n) throw new LedgerUnavailableError("corrupt", "SQLite 장부의 머리가 아니다");
  const view = readOnlyView(path);
  try {
    const stored = view.query("PRAGMA application_id").get() as { application_id: number };
    if (stored.application_id !== APPLICATION_ID) throw notOurs(mode, "이 설치가 만든 장부가 아니다");
    if (mode === "create") {
      if (hasIdentity(view)) throw new LedgerUnavailableError("already_initialized", "이미 만든 장부다");
      if (leftover.some((suffix) => suffix !== "-journal")) throw new LedgerUnavailableError("foreign_data", "끊긴 첫 설치에는 WAL이 남지 않는다");
      requireInterruptedInstall(view, migrations);
    }
  } finally {
    view.close();
  }
  return { fresh: false, file: main };
}

function useWal(db: Database): void {
  const journal = (db.query("PRAGMA journal_mode = WAL").get() as { journal_mode: string }).journal_mode;
  if (journal !== "wal") throw new LedgerUnavailableError("db_error", `journal_mode ${journal}`);
}

// 여는 순서: 입력 확인 → 파일 판정 → 설정 → 잠금 → 같은 파일인지 → 검사 → 첫 설치 기록 확인 → 마이그레이션. 하나라도 실패하면 연결을 닫고 이유를 돌려준다.
export function openLedger(path: string, options: OpenOptions): OpenResult {
  const mode = oneOf(options.mode, ["create", "reopen"] as const, "openLedger.mode");
  let db: Database | undefined;
  try {
    const migrations = options.migrations ?? loadMigrations();
    try {
      validateMigrations(migrations);
    } catch (error) {
      throw new LedgerUnavailableError("migration_mismatch", describe(error));
    }
    // 적용 시각은 커밋된 뒤에는 고칠 수 없으므로 파일을 건드리기 전에 확인한다.
    const openedAt = options.clock();
    if (!Number.isSafeInteger(openedAt) || openedAt <= 0) throw new LedgerUnavailableError("db_error", "시계의 값이 안전한 시각이 아니다");
    const faults = options.faults ?? NO_FAULTS;
    const target = ledgerPath(path, mode);
    const { fresh, file } = inspectFile(target, mode, migrations);
    faults.at("open:inspected");
    db = new Database(target, { readwrite: true, strict: true });
    // 연결이 파일을 처음 읽기 전에 본다(synchronous가 첫 읽기이고, 끊긴 트랜잭션의 저널은 그때 되돌려진다).
    requireSameFile(target, file, mode);
    db.run("PRAGMA busy_timeout = 0");
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    db.run("PRAGMA synchronous = FULL");
    db.run("PRAGMA foreign_keys = ON");
    if (fresh) db.run(`PRAGMA application_id = ${APPLICATION_ID}`);
    // 빈 쓰기 트랜잭션으로 지금 잠금을 잡는다. EXCLUSIVE라 커밋 뒤에도 놓지 않는다.
    db.run("BEGIN EXCLUSIVE");
    db.run("COMMIT");
    requireSameFile(target, file, mode);
    const check = db.query("PRAGMA quick_check").all() as { quick_check: string }[];
    if (check.length !== 1 || check[0].quick_check !== "ok") throw new LedgerUnavailableError("corrupt", `quick_check: ${check.map((r) => r.quick_check).join("; ")}`);
    // 마이그레이션 전에 본다: 재개방에 빈 파일이 오면 표를 만들지 않고 닫는다.
    const identified = hasIdentity(db);
    if (mode === "reopen" && !identified) throw new LedgerUnavailableError("not_initialized", "첫 설치 기록이 없다(빈 파일이거나 다른 파일)");
    if (mode === "create" && identified) throw new LedgerUnavailableError("already_initialized", "이미 만든 장부다");
    // 잠금을 쥔 뒤의 내용으로 다시 판정한다. 잠금 전의 판정은 파일을 바꾸지 않고 거절하려는 것이고, 쓰기의 근거는 이쪽이다.
    if (mode === "create") requireInterruptedInstall(db, migrations);
    if (mode === "reopen") useWal(db);
    const migrated = migrate(db, migrations, openedAt, faults);
    if (mode === "create") {
      const conn = db;
      conn
        .transaction(() => {
          for (const sql of IDENTITY) conn.run(sql);
          conn.query("INSERT INTO ledger_identity (id, ledger_id, created_at) VALUES (1, ?, ?)").run(crypto.randomUUID(), openedAt);
        })
        .immediate();
      useWal(conn);
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
  // 지금의 복원 시도. stopEpoch는 그 시도가 1단계를 마칠 때의 정지 변경 횟수이고, 1단계 전에는 null이다.
  #attempt: { id: RestoreAttempt; stopEpoch: number | null } | null = null;
  // 접수 허가의 한 자리: 어느 복원 시도가 어느 정지 세대에서 냈는가. 열 때마다 비어 있고 복원 5단계만 채운다.
  // 정지 기록이 바뀌거나, 풀리거나, 새 시도가 시작되거나, 장부가 실패하면 비운다. 한 번 비면 새 시도가 5단계를 다시 마쳐야 찬다.
  #grant: { attempt: RestoreAttempt; generation: number } | null = null;
  // 정지 기록이 바뀐 횟수. 1단계 뒤에 정지가 바뀐 시도는 그 앞에서 모은 대조로 허가를 내지 못한다.
  #stopEpoch = 0;
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
    this.#grant = null;
    this.#db.close();
  }

  // 장부가 실패했다. 다시 열 때까지 새 일의 근거를 주지 않고, 이미 낸 접수 허가도 버린다.
  #fail(reason: UnavailableReason): void {
    this.#broken ??= reason;
    this.#grant = null;
  }

  // mode "start": 새 접수·새 실행·자격 발급·게시. 건강, 트랜잭션 안에서 읽은 지금의 정지 기록, 그 정지 상태의 접수 허가가 공통 전제다.
  // mode "new": 새 일의 근거가 되는 기록(규칙 확인, 풀기). 장부가 한 번이라도 실패했으면 시도하지 않는다.
  // mode "continue": 정지·종료·영수증처럼 진행 중인 것을 닫는 기록. 실패한 뒤에도 가능한 만큼 시도한다.
  #write<T extends object>(point: string, mode: WriteMode, fn: () => T): T | Refused {
    if (this.#closed || (mode !== "continue" && this.#broken !== null)) return { ok: false, reason: "ledger_unwritable" };
    try {
      return this.#db
        .transaction(() => {
          if (mode === "start") this.#requireIntake();
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
      this.#fail(classify(error));
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
      this.#fail(reason);
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

  // 정지 기록을 적는 유일한 자리. 세대나 정지 여부가 바뀌면 커밋을 기다리지 않고 접수 허가를 버린다(되돌려져도 닫힌 쪽으로 틀린다).
  #writeStop(generation: number, stopped: boolean, phase: StopPhase, now: number): StopRecord {
    const before = this.#stopRow();
    if (before === null || before.generation !== generation || before.stopped !== stopped) this.#revokeIntake();
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

  #revokeIntake(): void {
    this.#grant = null;
    this.#stopEpoch += 1;
  }

  // 허가는 지금의 복원 시도가 낸 것이고, 낸 때의 정지 세대가 지금과 같고, 지금 정지가 아닐 때만 살아 있다.
  #grantHolds(stop: StopRecord): boolean {
    return this.#grant !== null && this.#attempt?.id === this.#grant.attempt && this.#grant.generation === stop.generation && !stop.stopped;
  }

  // 새 일을 막는 확인. 기록이 없으면(모름) 막고, 정지면 막고, 지금 정지 상태의 접수 허가가 없으면 막는다.
  #requireIntake(): void {
    const stop = this.#stopRow();
    if (stop === null) throw new Refuse("stop_unknown");
    if (stop.stopped) throw new Refuse("stopped");
    if (!this.#grantHolds(stop)) throw new Refuse("intake_closed");
  }

  // 지시에 실을 정지 세대는 장부의 지금 값과 같아야 한다. 종료 지시도 같다: 호출자가 앞서 읽은 옛 값으로 적지 않는다.
  #requireStopGeneration(stopGeneration: number): void {
    const stop = this.#stopRow();
    if (stop === null) throw new Refuse("stop_unknown");
    if (stop.generation !== stopGeneration) throw new Refuse("stop_generation_mismatch");
  }

  #slotHeld(kind: RunKind): boolean {
    return this.#db.query("SELECT 1 AS x FROM slot_holds WHERE kind = ? AND holds_slot = 1 LIMIT 1").get(kind) !== null;
  }

  // 판정 하나에 쓰는 장부의 시각. 시계를 믿을 수 없으면 모든 기한이 지난 것으로 본다.
  #ledgerNow(): number {
    const now = this.#clock();
    return Number.isSafeInteger(now) && now > 0 ? now : Number.MAX_SAFE_INTEGER;
  }

  // 대기 실행을 지금 시작하면 안 되는 이유. 슬롯과 달리 이 실행 자체의 사실만 본다. now는 호출자가 넘긴 값이 아니라 #ledgerNow의 값이다.
  #startBar(row: RunRow, now: number): StartBar | null {
    if (row.run_generation !== this.#epoch()) return "run_generation_stale";
    if (this.#db.query("SELECT 1 AS x FROM slot_holds WHERE run_id = ? LIMIT 1").get(row.run_id) !== null) return "run_blocked";
    if (row.input_request_id !== null) {
      const input = this.#db.query("SELECT cancelled_at, source_expires_at FROM inputs WHERE request_id = ?").get(row.input_request_id) as {
        cancelled_at: number | null;
        source_expires_at: number;
      } | null;
      if (input === null || input.cancelled_at !== null) return "input_cancelled";
      if (input.source_expires_at <= now) return "input_expired";
    }
    return row.deadline_at <= now ? "deadline_passed" : null;
  }

  // 시작으로 옮기기 전 공통 확인: 대기인지, 지금 실행 세대의 줄인지, 슬롯 차단이 없는지, 이 실행을 시작해도 되는지.
  #requireStartable(row: RunRow | null, kind: RunKind, now: number): RunRow {
    if (row === null) throw new Refuse("unknown_run");
    if (row.kind !== kind) throw new Refuse("invariant_violation");
    if (row.state !== "queued") throw new Refuse("transition_denied");
    const bar = this.#startBar(row, now);
    if (bar === "run_generation_stale") throw new Refuse(bar);
    if (this.#slotHeld(kind)) throw new Refuse("slot_busy");
    if (bar !== null) throw new Refuse(bar);
    return row;
  }

  // ---- 접수 ----

  // 새 접수·실행·자격 발급을 지금 열어도 되는가. 살아 있는 접수 허가가 있고, 장부가 건강하고, 지금 읽은 정지 기록이 허가 때와 같을 때만 true.
  // attempt를 주면 그 복원 시도가 낸 허가만 센다. 읽지 못하면 false다.
  intakeOpen(attempt?: RestoreAttempt): boolean {
    if (this.#grant === null || this.health().writable !== true) return false;
    if (attempt !== undefined && this.#grant.attempt !== attempt) return false;
    const stop = this.readStop();
    return stop.known && stop.value !== null && this.#grantHolds(stop.value);
  }

  // 새 복원 시도를 시작한다. 앞 시도의 허가는 여기서 끝나고, 앞 시도는 더는 지금의 시도가 아니다.
  beginRestore(key: symbol): RestoreAttempt {
    if (key !== RESTORE_KEY) throw new TypeError("복원 시도는 재시작 복원만 시작한다");
    const id = Symbol("restore-attempt");
    this.#attempt = { id, stopEpoch: null };
    this.#grant = null;
    return id;
  }

  isCurrentRestore(attempt: RestoreAttempt | null): boolean {
    return attempt !== null && this.#attempt?.id === attempt;
  }

  // 복원 1단계가 정지 기록을 합친 직후에 부른다. 이 뒤로 정지가 바뀌면 이 시도는 허가를 내지 못한다.
  pinRestore(key: symbol, attempt: RestoreAttempt): void {
    if (key !== RESTORE_KEY) throw new TypeError("복원 시도는 재시작 복원만 고정한다");
    if (this.#attempt?.id === attempt) this.#attempt.stopEpoch = this.#stopEpoch;
  }

  // 복원 5단계만 부른다. 지금의 시도인지, 1단계 뒤 정지가 바뀌지 않았는지, 지금 정지가 아닌지를 한 동기 구간에서 보고 허가를 낸다.
  grantIntake(key: symbol, attempt: RestoreAttempt): boolean {
    if (key !== RESTORE_KEY) throw new TypeError("접수는 재시작 복원만 연다");
    const current = this.#attempt;
    if (this.#closed || this.#broken !== null || current === null || current.id !== attempt || current.stopEpoch !== this.#stopEpoch) return false;
    const stop = this.readStop();
    if (!stop.known || stop.value === null || stop.value.stopped) return false;
    this.#grant = { attempt, generation: stop.value.generation };
    return true;
  }

  // 맞춤 답(VerifyContext.stopGeneration)에 쓸 세대. 지금의 복원 시도가 권위 기록을 합쳤고 장부가 실패하지 않았을 때만 낸다.
  // 저장에 실패한 뒤에는 더 새로운 정지를 놓쳤을 수 있으므로 옛 행을 읽을 수 있어도 null이다. 진단은 readStop으로 읽는다.
  syncStopGeneration(attempt: RestoreAttempt | null): number | null {
    if (attempt === null || this.#attempt?.id !== attempt || this.#attempt.stopEpoch === null) return null;
    if (this.#closed || this.#broken !== null) return null;
    const stop = this.readStop();
    return stop.known && stop.value !== null ? stop.value.generation : null;
  }

  // ---- 정지·일시 중지 ----

  readStop(): Read<StopRecord | null> {
    return this.#read(() => this.#stopRow());
  }

  // 정지 기록을 합친다(일반 기록의 경로). 0도 적는다. 낮은 세대로 덮지 않는다(여기서 한 번, 트리거에서 한 번 더).
  // 이미 정지면 세대가 더 높은 해제 값이 와도 정지다. 세대는 올라가도 정지는 풀리지 않는다(풀기는 releaseStop 하나다).
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
      const record = this.#writeStop(generation, (before?.stopped ?? false) || stopped, phase ?? (same ? before.phase : "none"), now);
      return { ok: true as const, record };
    });
  }

  // 복원 1단계: 권위 기록(없으면 null)을 지금의 장부와 한 트랜잭션에서 합친다. 권위 기록을 기다리는 사이 커밋된 정지도
  // 여기서 다시 읽으므로 풀리지 않는다. 장부와 권위 모두 기록이 없으면 0을 적는다: 이 파일은 openLedger가 첫 설치 기록을
  // 확인했고(재개방은 그 기록이 없으면 열지 않음) 정지 줄은 지울 수 없으므로, 줄이 없다는 것은 첫 설치 뒤 아직 적지 않았다는 뜻이다.
  // 권위의 더 높은 세대는 해제 값이어도 사실로 적는다. 세대가 바뀌므로 접수 허가는 없어지고, 복원을 끝까지 다시 마쳐야 새 업무가 열린다.
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

  // 관리자의 풀기(§7.6)가 이 세대의 정지를 푼다. 다른 세대면 거절한다. 풀어도 접수는 닫힌 채다: 새 복원 시도가 끝까지 마쳐야 열린다.
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
    if (result.ok) this.#revokeIntake();
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
  #pendingInputs(now: number): PendingInputs {
    const processedSeq = safe((this.#db.query("SELECT COALESCE(MAX(processed_seq), 0) AS n FROM sessions").get() as { n: number }).n, "processed_seq");
    const rows = this.#db
      .query("SELECT request_id, seq, source_ref, source_expires_at, cancelled_at FROM inputs WHERE seq > ? ORDER BY seq")
      .all(processedSeq) as { request_id: string; seq: number; source_ref: string; source_expires_at: number; cancelled_at: number | null }[];
    const out: PendingInputs = { processedSeq, pending: [], cancelled: [], expired: [] };
    for (const row of rows) {
      if (row.cancelled_at !== null) out.cancelled.push(row.request_id);
      else if (row.source_expires_at <= now) out.expired.push(row.request_id);
      else out.pending.push({ requestId: row.request_id, seq: row.seq, sourceRef: { ref: row.source_ref, expiresAt: row.source_expires_at } });
    }
    return out;
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
    time(v.now, "now");
    return this.#write("start", "start", () => {
      this.#requireStopGeneration(stopGeneration);
      const now = this.#ledgerNow();
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

  // 세션 시작은 닫혀 있다. v1의 인수와 규칙 확인에는 다음 실행 ID가 없어, 어느 대기 실행의 시작 근거인지 장부가 정할 수 없다.
  // 세션 계약 작업이 앞 실행·유일하게 예약한 다음 실행·실행기·표식·허가·규칙 확인·영수증을 한 기록에 함께 커밋한 뒤에 연다(ledger.md "세션 증거").
  // 입력의 꼴과 새 업무의 공통 전제는 지금도 확인한다. 어떤 입력에도 시작 지시와 자격 참조를 내지 않는다.
  startSession(input: StartSessionInput): Refused {
    const v = exact(
      input,
      ["runId", "requestId", "stopGeneration", "now", "sessionId", "generationMarkerDigest", "takeoverReceiptId", "ruleCheckId", "handoffRef", "handoffDigest"],
      "startSession",
    );
    str(v.runId, UUID, "runId");
    str(v.requestId, UUID, "requestId");
    count(v.stopGeneration, "stopGeneration");
    time(v.now, "now");
    str(v.sessionId, UUID, "sessionId");
    str(v.generationMarkerDigest, SHA256, "generationMarkerDigest");
    strOrNull(v.takeoverReceiptId, UUID, "takeoverReceiptId");
    str(v.ruleCheckId, UUID, "ruleCheckId");
    const handoffRef = strOrNull(v.handoffRef, HANDOFF_REF, "handoffRef");
    const handoffDigest = strOrNull(v.handoffDigest, SHA256, "handoffDigest");
    if ((handoffRef === null) !== (handoffDigest === null)) throw new LedgerInputError("startSession: 인계 참조와 digest는 함께 있거나 함께 없다");
    return this.#write<never>("start_session", "start", () => {
      throw new Refuse("session_start_closed");
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

  // 결과 검사의 판정(checking에서만 상태를 옮긴다). digest가 있으면 ready_result, null이면 failed_stopped.
  // 판정한 실행의 결과 보고는 미반영으로 남기지 않는다: 같은 digest는 반영이고, 다른 digest는 충돌 기록을 남기고 닫는다.
  // reportId를 주면 그 보고가 이 실행의 미반영 보고이고 digest가 같아야 한다. 이미 같은 판정이 끝난 실행이면 상태를 되돌리지 않고 그 보고만 마친다.
  markResult(input: { runId: string; resultDigest: string | null; reportId?: string; now: number }): { ok: true; run: Run } | Refused {
    const v = exact(input, ["runId", "resultDigest", "reportId", "now"], "markResult");
    const runId = str(v.runId, UUID, "runId");
    const digest = strOrNull(v.resultDigest, SHA256, "resultDigest");
    const reportId = v.reportId === undefined ? null : str(v.reportId, UUID, "reportId");
    const now = time(v.now, "now");
    return this.#write("result", "continue", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (reportId !== null) {
        const report = this.#db.query("SELECT run_id, result_digest, applied_at FROM deliveries WHERE id = ? AND action = 'report_result'").get(reportId) as {
          run_id: string;
          result_digest: string;
          applied_at: number | null;
        } | null;
        if (report === null || report.run_id !== runId || report.applied_at !== null || (digest !== null && report.result_digest !== digest)) throw new Refuse("reference_mismatch");
      }
      if (row.state !== "checking") {
        const judged = ["ready_result", "failed_stopped", "cleanup_pending", "finalized"].includes(row.state);
        if (reportId === null || !judged || row.result_digest !== digest) throw new Refuse("transition_denied");
        this.#db.query("UPDATE deliveries SET applied_at = ? WHERE id = ?").run(now, reportId);
        return { ok: true as const, run: toRun(row) };
      }
      this.#setState(row, digest === null ? "failed_stopped" : "ready_result", now, { result_digest: digest });
      const open = this.#db.query("SELECT id, result_digest FROM deliveries WHERE run_id = ? AND action = 'report_result' AND applied_at IS NULL").all(runId) as { id: string; result_digest: string }[];
      for (const report of open) {
        if (digest !== null && report.result_digest !== digest) this.#recordConflict(report.id, digest, report.result_digest, now);
        this.#db.query("UPDATE deliveries SET applied_at = ? WHERE id = ?").run(now, report.id);
      }
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

  // 재시작 복원 2단계가 적는다. (실행기, 실행, 세대)마다 한 줄이고, 같은 관측을 다시 보면 새 번호를 받는다.
  // 다시 본 관측은 슬롯 차단을 낮추지 않는다(끝났다는 보고만으로 슬롯을 풀지 않는다). 돌려준 번호가 지금의 관측이다.
  // 줄을 지우는 곳은 같은 관측을 새 번호로 바꿔 적는 여기뿐이다. 그래서 한 번 적힌 실행 ID는 계속 시작하지 못한다.
  holdSlots(key: symbol, observations: readonly SlotHoldObservation[], now: number): { ok: true; holds: SlotHold[] } | Refused {
    if (key !== RESTORE_KEY) throw new TypeError("점유 차단은 재시작 복원만 적는다");
    const when = time(now, "now");
    return this.#write("slot_hold", "continue", () => {
      const holds: SlotHold[] = [];
      for (const seen of observations) {
        const before = this.#db.query("SELECT holds_slot FROM slot_holds WHERE executor_id = ? AND run_id = ? AND run_generation = ?").get(seen.executorId, seen.runId, seen.runGeneration) as {
          holds_slot: number;
        } | null;
        const holdsSlot = seen.holdsSlot || before?.holds_slot === 1;
        this.#db.query("DELETE FROM slot_holds WHERE executor_id = ? AND run_id = ? AND run_generation = ?").run(seen.executorId, seen.runId, seen.runGeneration);
        const row = this.#db
          .query("INSERT INTO slot_holds (executor_id, run_id, kind, run_generation, holds_slot, why, held_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING observation")
          .get(seen.executorId, seen.runId, seen.kind, seen.runGeneration, holdsSlot ? 1 : 0, seen.why, when) as { observation: number };
        holds.push({ ...seen, holdsSlot, observation: safe(row.observation, "slot_holds.observation") });
      }
      return { ok: true as const, holds };
    });
  }

  // 지금 슬롯을 막고 있는 관측. 해제할 수 있는 것만 낸다(실행 ID만 막는 줄은 해제할 것이 없다).
  slotHolds(): Read<SlotHold[]> {
    return this.#read(() =>
      (
        this.#db.query("SELECT observation, executor_id, run_id, kind, run_generation, holds_slot, why FROM slot_holds WHERE holds_slot = 1 ORDER BY observation").all() as {
          observation: number;
          executor_id: string;
          run_id: string;
          kind: RunKind;
          run_generation: number;
          holds_slot: number;
          why: SlotHold["why"];
        }[]
      ).map((row) => ({
        observation: safe(row.observation, "slot_holds.observation"),
        executorId: row.executor_id,
        runId: row.run_id,
        kind: row.kind,
        runGeneration: safe(row.run_generation, "slot_holds.run_generation"),
        holdsSlot: row.holds_slot === 1,
        why: row.why,
      })),
    );
  }

  // 그 실행기가 그 세대의 그 실행을 더는 쥐지 않는다고 재대조했거나 종료를 증명했을 때 부른다. 확인한 관측의 세대와 번호가 지금의 줄과 같을 때만 슬롯을 돌려준다.
  // 옛 세대의 종료 확인이나 다시 관측되기 전의 확인은 지금의 차단을 풀지 못한다. 무엇을 증명으로 볼지는 실제 연결 작업이 정한다.
  // 줄은 남긴다: 끝났다는 증명은 그 실행 ID가 이미 쓰였다는 증명이기도 하다. 다시 할 일은 새 실행 ID를 받는다.
  clearSlotHold(input: { executorId: string; runId: string; runGeneration: number; observation: number }): { ok: true } | Refused {
    const v = exact(input, ["executorId", "runId", "runGeneration", "observation"], "clearSlotHold");
    const executorId = str(v.executorId, REF, "executorId");
    const runId = str(v.runId, UUID, "runId");
    const runGeneration = count(v.runGeneration, "runGeneration");
    const observation = count(v.observation, "observation");
    return this.#write("slot_release", "continue", () => {
      const changed = this.#db.query("UPDATE slot_holds SET holds_slot = 0 WHERE executor_id = ? AND run_id = ? AND run_generation = ? AND observation = ?").run(executorId, runId, runGeneration, observation).changes;
      if (changed > 0) return { ok: true as const };
      const held = this.#db.query("SELECT 1 AS x FROM slot_holds WHERE executor_id = ? AND run_id = ? LIMIT 1").get(executorId, runId);
      throw new Refuse(held === null ? "unknown_run" : "reference_mismatch");
    });
  }

  // ---- 영수증·보고 ----

  // 이미 받은 id인가. 같은 본문이면 "duplicate", 다른 본문이면 receipt_conflicts에 남기고 거절, 처음이면 null이다.
  // 새 id에만 원 지시 대조와 효과를 적용하도록 그 앞에서 부른다(반영할 수 없는 새 id는 적지 않고 거절한다. 실행기는 ack가 올 때까지 다시 보낸다).
  #redelivery(id: string, digest: string, now: number): "duplicate" | Refused | null {
    const before = this.#db.query("SELECT body_digest FROM deliveries WHERE id = ?").get(id) as { body_digest: string } | null;
    if (before === null) return null;
    if (before.body_digest === digest) return "duplicate";
    this.#recordConflict(id, before.body_digest, digest, now);
    return { ok: false, reason: "receipt_conflict" };
  }

  // 같은 충돌은 한 줄이다. 거절한 보고는 ack가 없어 실행기가 같은 내용을 계속 다시 보낸다.
  #recordConflict(id: string, first: string, other: string, now: number): void {
    this.#db.query("INSERT INTO receipt_conflicts (id, first_digest, other_digest, received_at) VALUES (?, ?, ?, ?) ON CONFLICT (id, first_digest, other_digest) DO NOTHING").run(id, first, other, now);
  }

  #insertDelivery(
    id: string,
    action: string,
    runId: string | null,
    digest: string,
    now: number,
    extra: { instructionRequestId?: string; storedRef?: string | null; resultDigest?: string | null; appliedAt?: number | null } = {},
  ): void {
    this.#db
      .query("INSERT INTO deliveries (id, action, run_id, instruction_request_id, body_digest, stored_ref, result_digest, received_at, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, action, runId, extra.instructionRequestId ?? null, digest, extra.storedRef ?? null, extra.resultDigest ?? null, now, extra.appliedAt ?? null);
  }

  // 낸 쪽이 그 실행의 지정 실행기이고 머리의 실행 세대가 장부와 같은지. 다른 인스턴스의 관측은 이 실행의 증거가 아니다.
  #requireSender(row: RunRow, from: EnvelopeFrom): void {
    if (row.executor_id !== from.sender) throw new Refuse("sender_mismatch");
    if (row.run_generation !== from.runGeneration) throw new Refuse("run_generation_mismatch");
  }

  // 세션 인수 영수증은 다음 세대의 세션 실행기가 낸다. 앞 세션의 지정 실행기이거나, 장부에 대기 중인 세션 실행의 지정 실행기여야 한다.
  // 이미 받은 인수는 처음 낸 쪽만 다시 보낼 수 있다. 처음 낸 쪽의 대기 줄이 그사이 시작했어도 같은 인수의 재전송은 ack를 받아야 한다.
  #requireTakeoverSender(previous: RunRow, receiptId: string, from: EnvelopeFrom): void {
    if (previous.run_generation !== from.runGeneration) throw new Refuse("run_generation_mismatch");
    if (parsePrincipal(from.sender)?.kind !== "session_executor") throw new Refuse("sender_mismatch");
    const first = this.#db.query("SELECT sender FROM session_takeovers WHERE receipt_id = ?").get(receiptId) as { sender: string } | null;
    if (first !== null) {
      if (first.sender !== from.sender) throw new Refuse("sender_mismatch");
      return;
    }
    if (from.sender === previous.executor_id) return;
    const assigned = this.#db.query("SELECT 1 AS x FROM runs WHERE kind = 'session' AND executor_id = ? AND state = 'queued' LIMIT 1").get(from.sender);
    if (assigned === null) throw new Refuse("sender_mismatch");
  }

  // 순서: 발신자·실행·세대 → 이미 받은 id의 분류(같은 본문은 다시 ack, 다른 본문은 충돌 기록) → 새 id의 원 지시 대조와 효과.
  applyReceipt(input: ReceiptInput, from: EnvelopeFrom): { ok: true; delivery: Delivery; ack: string } | Refused {
    const r = validateReceipt(input);
    const sender = validateFrom(from);
    return this.#write("receipt", "continue", () => {
      const runId = r.action === "receipt_session_takeover" ? r.previousRunId : r.runId;
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (r.action === "receipt_session_takeover") this.#requireTakeoverSender(row, r.receiptId, sender);
      else this.#requireSender(row, sender);
      const seen = this.#redelivery(r.receiptId, r.bodyDigest, r.now);
      if (seen === "duplicate") return { ok: true as const, delivery: "duplicate" as const, ack: r.receiptId };
      if (seen !== null) return seen;
      const instructionRequestId = "instructionRequestId" in r ? r.instructionRequestId : undefined;
      if (instructionRequestId !== undefined) this.#instruction(instructionRequestId, row.run_id, r.action === "receipt_accepted" ? [r.instruction] : r.action === "receipt_started" ? ["task_start", "session_start"] : ["result_finalize"]);
      this.#insertDelivery(r.receiptId, r.action, runId, r.bodyDigest, r.now, { instructionRequestId });
      this.#faults.at("receipt:after_insert");
      this.#effect(row, r, sender);
      return { ok: true as const, delivery: "new" as const, ack: r.receiptId };
    });
  }

  #instruction(requestId: string, runId: string, actions: readonly string[]): void {
    const found = this.#db.query("SELECT action FROM instructions WHERE request_id = ? AND run_id = ?").get(requestId, runId) as { action: string } | null;
    if (found === null || !actions.includes(found.action)) throw new Refuse("unknown_instruction");
  }

  #effect(row: RunRow, r: ReceiptInput, from: EnvelopeFrom): void {
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
        // 증거로만 적는다. 앞 세션의 상태·종료 지시·표식의 대조와 앞 세션을 끝내는 일은 이 기록을 소비하는 세션 계약 작업이 한다.
        if (this.#db.query("SELECT 1 AS x FROM session_takeovers WHERE start_permit_id = ?").get(r.startPermitId)) throw new Refuse("permit_used");
        this.#db
          .query("INSERT INTO session_takeovers (receipt_id, previous_run_id, sender, new_generation_marker_digest, start_permit_id, taken_over_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(r.receiptId, row.run_id, from.sender, r.newGenerationMarkerDigest, r.startPermitId, r.takenOverAt);
        return;
      }
    }
  }

  // from은 검증된 봉투의 낸 쪽이다. 같은 보고의 재전송은 처음 낸 쪽만 ack를 받는다.
  applyRuleCheck(input: RuleCheckInput, from: RuleCheckFrom): { ok: true; delivery: Delivery; ack: string } | Refused {
    const who = exact(from, ["sender"], "from");
    const sender = str(who.sender, REF, "from.sender");
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
      if (parsePrincipal(sender)?.kind !== "session_executor") throw new Refuse("sender_mismatch");
      const earlier = this.#db.query("SELECT sender FROM rule_checks WHERE report_id = ?").get(reportId) as { sender: string } | null;
      if (earlier !== null && earlier.sender !== sender) throw new Refuse("sender_mismatch");
      const seen = this.#redelivery(reportId, digest, now);
      if (seen === "duplicate") return { ok: true as const, delivery: "duplicate" as const, ack: reportId };
      if (seen !== null) return seen;
      this.#insertDelivery(reportId, "report_rule_check", null, digest, now);
      this.#db
        .query("INSERT INTO rule_checks (report_id, sender, outcome, first_marker_digest, restarted_marker_digest, start_permit_id, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(reportId, sender, outcome, first, restarted, permit, checkedAt);
      return { ok: true as const, delivery: "new" as const, ack: reportId };
    });
  }

  // 결과 보고를 적어도 되는지 ack 전에 정한다. 판정이 끝난 실행은 상태를 다시 옮기지 않는다.
  // pending: 아직 판정 전이라 미반영으로 둔다. settled: 같은 결과가 이미 반영돼 적자마자 마친다.
  // 다른 결과는 충돌을 남기고 거절하고, 결과가 없다고 판정한 실행이나 시작하지 않은 실행의 결과는 적지 않고 거절한다(ack 없음).
  #resultDisposition(row: RunRow, reportId: string, resultDigest: string, now: number): "pending" | "settled" | Refused {
    if (row.kind !== "worker" || row.state === "queued" || row.state === "not_started") throw new Refuse("transition_denied");
    if (!["ready_result", "failed_stopped", "cleanup_pending", "finalized"].includes(row.state)) return "pending";
    if (row.result_digest === null) throw new Refuse("transition_denied");
    if (row.result_digest === resultDigest) return "settled";
    this.#recordConflict(reportId, row.result_digest, resultDigest, now);
    return { ok: false, reason: "receipt_conflict" };
  }

  // 보고를 받아 적는다. 결과 보고는 결과를 저장한 자리와 digest가, 훅·세션 깨짐 보고는 업무를 잇는 칸이 함께 커밋된 뒤에만 ack가 나간다.
  recordReport(input: ReportInput, from: EnvelopeFrom): { ok: true; delivery: Delivery; ack: string } | Refused {
    const v = exact(input, ["reportId", "action", "runId", "bodyDigest", "storedRef", "resultDigest", "signal", "now"], "recordReport");
    const reportId = str(v.reportId, UUID, "reportId");
    const action = oneOf(v.action, ["report_result", "report_session_broken", "report_hook_event"] as const, "action");
    const runId = str(v.runId, UUID, "runId");
    const digest = str(v.bodyDigest, SHA256, "bodyDigest");
    const storedRef = strOrNull(v.storedRef, STORED_REF, "storedRef");
    const resultDigest = strOrNull(v.resultDigest, SHA256, "resultDigest");
    if ((action === "report_result") !== (storedRef !== null && resultDigest !== null) || (action !== "report_result" && (storedRef !== null || resultDigest !== null))) {
      throw new LedgerInputError("recordReport: 결과 보고만 저장 자리와 결과 digest를 함께 싣는다");
    }
    const signal = validateSignal(v.signal, action);
    const sender = validateFrom(from);
    const now = time(v.now, "now");
    return this.#write("report", "continue", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      this.#requireSender(row, sender);
      const seen = this.#redelivery(reportId, digest, now);
      if (seen === "duplicate") return { ok: true as const, delivery: "duplicate" as const, ack: reportId };
      if (seen !== null) return seen;
      const disposition = resultDigest === null ? "pending" : this.#resultDisposition(row, reportId, resultDigest, now);
      if (typeof disposition === "object") return disposition;
      this.#insertDelivery(reportId, action, runId, digest, now, { storedRef, resultDigest, appliedAt: disposition === "settled" ? now : null });
      if (signal !== null) this.#insertSignal(reportId, signal);
      return { ok: true as const, delivery: "new" as const, ack: reportId };
    });
  }

  #insertSignal(reportId: string, signal: ReportSignal): void {
    const hook = signal.kind === "hook" ? signal : null;
    const broken = signal.kind === "session_broken" ? signal : null;
    this.#db
      .query("INSERT INTO report_signals (report_id, hook_event, session_id, turn_id, stop_failure, broken_cause, marker_digest, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(reportId, hook?.event ?? null, hook?.sessionId ?? null, hook?.turnId ?? null, hook?.stopFailure ?? null, broken?.cause ?? null, broken?.markerDigest ?? null, signal.observedAt);
  }

  // ack를 낸 뒤 아직 업무에 반영하지 않은 보고. 재시작 뒤 결과 검사와 훅·세션 깨짐의 처리를 다시 꺼내는 데 쓴다.
  pendingReports(): Read<PendingReport[]> {
    return this.#read(() =>
      (
        this.#db
          .query(
            `SELECT d.id, d.action, d.run_id, d.stored_ref, d.result_digest, s.hook_event, s.session_id, s.turn_id, s.stop_failure, s.broken_cause, s.marker_digest, s.observed_at
             FROM deliveries d LEFT JOIN report_signals s ON s.report_id = d.id
             WHERE d.applied_at IS NULL AND d.action IN ('report_result', 'report_session_broken', 'report_hook_event') ORDER BY d.received_at, d.id`,
          )
          .all() as PendingReportRow[]
      ).map((row) => {
        const signal = toSignal(row);
        return { reportId: row.id, action: row.action, runId: row.run_id, storedRef: row.stored_ref, resultDigest: row.result_digest, ...(signal === null ? {} : { signal }) };
      }),
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

  // 받아 적은 세션 증거를 실행기 기준으로 읽는다. previousRunId를 주면 인수와 보고를 그 실행의 것으로 좁힌다(규칙 확인은 실행에 속하지 않는다).
  // ack를 낸 뒤 재시작해도 여기서 다시 읽는다. 읽었다고 시작의 근거가 되지는 않는다.
  sessionEvidence(query: { executorId: string; previousRunId: string | null }): Read<SessionEvidence> {
    const v = exact(query, ["executorId", "previousRunId"], "sessionEvidence");
    const executorId = str(v.executorId, REF, "executorId");
    const previousRunId = strOrNull(v.previousRunId, UUID, "previousRunId");
    return this.#read(() => {
      const takeovers = this.#db
        .query(
          `SELECT receipt_id, previous_run_id, sender, new_generation_marker_digest, start_permit_id, taken_over_at FROM session_takeovers
           WHERE sender = ?1 AND (?2 IS NULL OR previous_run_id = ?2) ORDER BY taken_over_at, receipt_id`,
        )
        .all(executorId, previousRunId) as { receipt_id: string; previous_run_id: string; sender: string; new_generation_marker_digest: string; start_permit_id: string; taken_over_at: number }[];
      const ruleChecks = this.#db
        .query("SELECT report_id, sender, outcome, first_marker_digest, restarted_marker_digest, start_permit_id, checked_at FROM rule_checks WHERE sender = ? ORDER BY checked_at, report_id")
        .all(executorId) as {
        report_id: string;
        sender: string;
        outcome: RuleCheckInput["outcome"];
        first_marker_digest: string;
        restarted_marker_digest: string | null;
        start_permit_id: string | null;
        checked_at: number;
      }[];
      const reports = this.#db
        .query(
          `SELECT d.id, d.action, d.run_id, d.stored_ref, d.result_digest, d.applied_at, s.hook_event, s.session_id, s.turn_id, s.stop_failure, s.broken_cause, s.marker_digest, s.observed_at
           FROM deliveries d JOIN runs r ON r.run_id = d.run_id LEFT JOIN report_signals s ON s.report_id = d.id
           WHERE r.executor_id = ?1 AND (?2 IS NULL OR d.run_id = ?2) AND d.action IN ('report_session_broken', 'report_hook_event') ORDER BY d.received_at, d.id`,
        )
        .all(executorId, previousRunId) as (PendingReportRow & { applied_at: number | null })[];
      return {
        takeovers: takeovers.map((row) => ({
          receiptId: row.receipt_id,
          previousRunId: row.previous_run_id,
          sender: row.sender,
          newGenerationMarkerDigest: row.new_generation_marker_digest,
          startPermitId: row.start_permit_id,
          takenOverAt: row.taken_over_at,
        })),
        ruleChecks: ruleChecks.map((row) => ({
          reportId: row.report_id,
          sender: row.sender,
          outcome: row.outcome,
          firstMarkerDigest: row.first_marker_digest,
          restartedMarkerDigest: row.restarted_marker_digest,
          startPermitId: row.start_permit_id,
          checkedAt: row.checked_at,
        })),
        reports: reports.map((row) => ({
          reportId: row.id,
          action: row.action as SessionReportEvidence["action"],
          runId: row.run_id,
          settled: row.applied_at !== null,
          signal: toSignal(row),
        })),
      };
    });
  }

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

  #openRuns(now: number): (Run & { startBar: StartBar | null })[] {
    return (this.#db.query(`SELECT * FROM runs WHERE state NOT IN (${TERMINAL.map(() => "?").join(", ")}) ORDER BY queue_seq`).all(...TERMINAL) as RunRow[]).map((row) => ({
      ...toRun(row),
      startBar: row.state === "queued" ? this.#startBar(row, now) : null,
    }));
  }

  // 재시작 복원이 쓰는 읽기 묶음. 끝난 실행은 빼고 돌려준다. 대기 실행에는 이 실행 자체를 시작하면 안 되는 이유를 함께 준다.
  openRuns(): Read<(Run & { startBar: StartBar | null })[]> {
    return this.#read(() => this.#openRuns(this.#ledgerNow()));
  }

  // 복원 5단계의 대기 실행과 입력. 장부의 시각 하나로 함께 판정해 만료된 실행의 입력이 전달 대기로 나오지 않게 한다.
  queueView(): Read<{ runs: (Run & { startBar: StartBar | null })[]; inputs: PendingInputs }> {
    return this.#read(() => {
      const now = this.#ledgerNow();
      return { runs: this.#openRuns(now), inputs: this.#pendingInputs(now) };
    });
  }
}

interface PendingReportRow {
  id: string;
  action: PendingReport["action"];
  run_id: string;
  stored_ref: string | null;
  result_digest: string | null;
  hook_event: (typeof HOOK_EVENTS)[number] | null;
  session_id: string | null;
  turn_id: string | null;
  stop_failure: (typeof STOP_FAILURE_ERRORS)[number] | null;
  broken_cause: (typeof SESSION_BROKEN_CAUSES)[number] | null;
  marker_digest: string | null;
  observed_at: number | null;
}

function toSignal(row: PendingReportRow): ReportSignal | null {
  if (row.observed_at === null) return null;
  if (row.hook_event !== null) {
    return { kind: "hook", event: row.hook_event, sessionId: row.session_id as string, turnId: row.turn_id as string, stopFailure: row.stop_failure, observedAt: row.observed_at };
  }
  return { kind: "session_broken", cause: row.broken_cause as (typeof SESSION_BROKEN_CAUSES)[number], markerDigest: row.marker_digest as string, observedAt: row.observed_at };
}

// 훅 보고와 세션 깨짐 보고만 signal을 싣는다. 값은 v1 본문이 허용한 것뿐이다.
function validateSignal(value: unknown, action: ReportInput["action"]): ReportSignal | null {
  if (action === "report_result") {
    if (value !== null && value !== undefined) throw new LedgerInputError("recordReport.signal: 결과 보고에는 없다");
    return null;
  }
  if (action === "report_hook_event") {
    const v = exact(value, ["kind", "event", "sessionId", "turnId", "stopFailure", "observedAt"], "recordReport.signal");
    if (v.kind !== "hook") throw new LedgerInputError("recordReport.signal.kind: 훅 보고의 칸이 아니다");
    const event = oneOf(v.event, HOOK_EVENTS, "signal.event");
    const stopFailure = v.stopFailure === null ? null : oneOf(v.stopFailure, STOP_FAILURE_ERRORS, "signal.stopFailure");
    if ((event === "StopFailure") !== (stopFailure !== null)) throw new LedgerInputError("recordReport.signal: StopFailure만 오류 종류를 싣는다");
    return { kind: "hook", event, sessionId: str(v.sessionId, UUID, "signal.sessionId"), turnId: str(v.turnId, UUID, "signal.turnId"), stopFailure, observedAt: time(v.observedAt, "signal.observedAt") };
  }
  const v = exact(value, ["kind", "cause", "markerDigest", "observedAt"], "recordReport.signal");
  if (v.kind !== "session_broken") throw new LedgerInputError("recordReport.signal.kind: 세션 깨짐 보고의 칸이 아니다");
  return { kind: "session_broken", cause: oneOf(v.cause, SESSION_BROKEN_CAUSES, "signal.cause"), markerDigest: str(v.markerDigest, SHA256, "signal.markerDigest"), observedAt: time(v.observedAt, "signal.observedAt") };
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
