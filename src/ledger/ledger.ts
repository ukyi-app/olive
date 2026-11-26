// 감독 장부(D-56): SQLite 파일 하나, 감독 하나만 쓴다. 표와 쓰기 규칙의 요약은 ledger.md.
//
// 열 때 고른 것과 이유(Bun 1.4.4·SQLite 3.53.4에서 실행해 확인):
// - locking_mode=EXCLUSIVE: 첫 쓰기 트랜잭션에서 파일 잠금을 잡고 닫을 때까지 놓지 않는다. 같은 파일을 다른 연결이나
//   다른 프로세스가 열면 첫 접근에서 SQLITE_BUSY다(busy_timeout 0으로 기다리지 않는다). 프로세스가 죽으면 운영체제가 잠금을 푼다.
//   별도 잠금 파일을 두지 않는 이유: SQLite가 이미 쥐는 잠금이라 장부와 잠금이 어긋날 수 없다.
//   함정: POSIX 잠금은 같은 프로세스가 같은 파일의 다른 FD를 닫기만 해도 풀린다. 그래서 있는 장부 파일은 SQLite 연결로만 읽는다.
//   예외는 한 곳이다: 판정에서 본체만 읽는 연결이 머리를 읽지 못하면, 이 프로세스가 그 파일의 잠금을 쥐지 않았음을 /proc/locks로
//   확인한 뒤에만 머리 100바이트를 읽기 전용 FD로 읽는다(readHeader).
// - chunk size 4,096: 체크포인트가 페이지를 옮기기 전에 본체를 늘리게 해서, 도중에 끊겨도 머리의 페이지 수가 본체보다 앞서지 않는다.
// - journal_mode=WAL + synchronous=FULL: 커밋마다 WAL을 fsync한다. 그래서 커밋을 돌려준 쓰기(실행 줄, 영수증)는 전원이 나가도
//   남고, 실행 줄의 커밋이 끝난 뒤에만 지시를 내므로 접수 기록이 영수증보다 먼저 남는다. NORMAL은 마지막 커밋을 잃을 수 있다.
//   EXCLUSIVE와 함께 쓰면 공유 메모리(-shm) 파일 없이 동작한다. 로컬 볼륨 전제다(네트워크 파일시스템이 아님).
//   첫 설치는 저널 모드로 끝내고 첫 설치 기록을 커밋한 뒤에 WAL로 바꾼다. 끊긴 첫 설치의 내용이 본체 파일에만 있어야
//   WAL을 복구하지 않고(파일을 바꾸지 않고) 이어 받아도 되는지 가를 수 있다.
// - foreign_keys=ON: 지시·세션·게시·영수증이 없는 실행을 가리키지 못한다. 연결마다 켜야 하는 설정이다.
// - quick_check: 깨진 파일은 열 때 SQLITE_NOTADB·SQLITE_CORRUPT로 걸러 "쓸 수 없음"으로 연다(열지 않는다).
//
// 새 업무(접수·작업 부탁·실행 줄·시작·자격·게시·갱신)의 공통 전제는 #write의 "start" 한 자리에 있다: 장부가 건강하고, 트랜잭션 안에서
// 읽은 지금의 정지 기록이 있고 정지가 아니며, 지금의 복원 시도가 바로 그 정지 상태에서 낸 접수 허가(#grant)가 살아 있다.
import { constants as sqliteOpen, Database, SQLiteError } from "bun:sqlite";
import { type BigIntStats, closeSync, constants as fileOpen, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  HOOK_EVENTS,
  type InstructionAction,
  INSTRUCTIONS,
  limits,
  type NonceStore,
  parsePrincipal,
  type Role,
  ROLES,
  RUN_STATES,
  type RunState,
  type RunStatus,
  runsOutsideLedger,
  SESSION_BROKEN_CAUSES,
  SESSION_STOP_REASONS,
  stateAfterLoss,
  STOP_FAILURE_ERRORS,
  TASK_CANCEL_REASONS,
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
  SOURCE_REF,
  type SourceRef,
  sourceRef,
  STORED_REF,
  str,
  strOrNull,
  time,
  UUID,
} from "./input.ts";
import { appliedCount, applyMigration, BOOTSTRAP, loadMigrations, migrate, type Migration, validateMigrations } from "./migrate.ts";
import { latestOpenRecord, publishSnapshot, removeQuietly, sealSnapshot, SIDECARS, SNAPSHOT_UNOPENED, type SnapshotFailure, SnapshotRefused, snapshotTarget } from "./snapshot.ts";
import { LEDGER_RUN_STATES, type LedgerRunState, mayTransition, type RunKind, SLOT_FREE, TERMINAL } from "./states.ts";

// ---- 결과의 모양 ----

export type Read<T> = { known: true; value: T } | { known: false; reason: UnavailableReason };

// 관리 통로의 상태 조회가 읽는 값(Ledger.peekStatus). 개수는 cap에서 멈춘다(cap 이상이면 cap).
// slotRuns: 자리를 쥔 실행. 장부의 실행 줄(자리를 놓지 않은 상태)과 자리를 막는 점유 관측(장부 밖 실행 포함)을 (실행, 세대)로 합쳐 센다.
export interface StatusPeek {
  readonly stop: StopRecord | null;
  readonly pauseUntil: number | null;
  readonly waitingRequests: number;
  readonly queuedRuns: number;
  readonly slotRuns: number;
  readonly intakeOpen: boolean;
}

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
  "snapshot_hold",
  "invariant_violation",
  // closeUnreceivedRun(D-90 닫기)만 내는 거절. 조건마다 하나다(ledger.md "받은 적 없는 실행의 닫기").
  "answer_time_unknown",
  "answer_too_early",
  "run_in_answer",
  "receipt_seen",
  "run_sighted",
  "sent_by_other_open",
  "started_before_migration",
  "budget_reduced",
  "snapshot_bound_unknown",
  "created_before_snapshot",
  // closeRunByOperator(D-91 관리자 닫기)만 내는 거절(ledger.md "관리자가 실패로 닫기"). 앞 상태가 닫을 수 없는 나머지는 transition_denied다.
  "run_not_worker",
  "run_ended",
  "stop_confirmed",
  "start_may_launch",
  "pod_started_too_early",
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

// 실행 줄에 적힌 종료 영수증 exit(판 8). 목록 밖의 값이면 그 값으로 확정을 정하지 않고 corrupt로 닫는다.
function storedExit(value: unknown): StopExit {
  if (!(STOP_EXITS as readonly unknown[]).includes(value)) throw new LedgerUnavailableError("corrupt", "runs.stop_exit: 계약의 exit가 아니다");
  return value as StopExit;
}

// failed_stopped가 된 장부 시각과 종료 영수증 exit(FailedStop의 두 칸 주석). 실패 상태가 된 시각 칸(판 8 runs.failed_stopped_at)이
// 있으면 그 값이고, 그때 exit 칸이 비었으면 completed다(트리거가 그 칸을 exit와 함께 적는 첫 종료 확인이나 checking에서 옮기는 쓰기에만
// 허락한다). 시각 칸이 빈 줄은 updated_at이 종료 확인 영수증을 받은 시각과 같을 때만 그 시각이고, 다르면 시각을 모른다(null).
function stopFacts(row: RunRow, receipt: { received_at: number } | null): Pick<FailedStop, "stoppedAt" | "exit"> {
  const exit = row.stop_exit === undefined || row.stop_exit === null ? null : storedExit(row.stop_exit);
  if (row.failed_stopped_at !== undefined && row.failed_stopped_at !== null) return { stoppedAt: safe(row.failed_stopped_at, "runs.failed_stopped_at"), exit: exit ?? "completed" };
  const updated = safe(row.updated_at, "runs.updated_at");
  return { stoppedAt: receipt !== null && updated === safe(receipt.received_at, "deliveries.received_at") ? updated : null, exit };
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
  // listRuns만 not_started 줄에 싣는다: 관리자가 실패로 닫은 줄(operator_closures)인가. 스케줄러의 예산 판단이 예약과 맞춰 본다
  // (src/supervisor/scheduler/queue.ts의 budgetBar: false가 아닌 not_started 줄의 예약이 0이면 모름으로 보류한다).
  // 다른 읽기와 다른 상태의 줄에는 이 칸이 없다.
  closedByOperator?: boolean;
  // listRuns만 작업자 줄에 싣는다: 이 실행이 같은 요청의 예산에서 잡고 있는 양(ledger.md "요청 예산의 예약").
  // 시작 지시가 없거나 D-90으로 닫혔으면 0, 그 밖은 시작 지시에 고정된 예산 전부(시작 뒤 감액·관리자 닫기와 무관), 모르면 null.
  // 세션 줄과 다른 읽기에는 이 칸이 없다.
  reservedBudget?: number | null;
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
  // 판 8(0008-stop-exit)의 칸 둘. 판 목록을 그 앞에서 끊어 연 장부에는 칸이 없어 undefined다.
  stop_exit?: string | null;
  failed_stopped_at?: number | null;
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

// markLostFor가 옮긴 실행 하나. 부르는 쪽은 runId로 같은 ID의 상태 조회를 낸다. after는 지금 규칙에서 늘 unknown_running이다.
export interface LostRun {
  runId: string;
  runGeneration: number;
  before: LedgerRunState;
  after: LedgerRunState;
}

// 실행기의 답 하나(applyExecutorAnswer). runs는 계약 v1의 실행 상태 항목 그대로다. answeredAt은 검증된 답 봉투의 issued_at(실행기 시계)이고,
// 그 값을 모르면 null이다(이른 not_known과 가를 수 없어 not_known으로는 임대를 거두지 않는다). now는 장부에 적는 시각(장부 시계)이다.
// full은 hello의 전체 목록, partial은 조회의 답이다. 지금은 둘을 같은 규칙으로 처리하고 관측에 적기만 한다.
export interface ExecutorAnswerInput {
  coverage: "full" | "partial";
  runs: readonly RunStatus[];
  answeredAt: number | null;
  now: number;
}

// not_known이 왔지만 임대를 거두지 않은 실행. 부르는 쪽은 같은 ID를 다시 조회한다.
// start_may_arrive: 답이 그 실행의 시작 봉투가 아직 실행기에 닿을 수 있는 동안(시작 발행 + RUN_LEASE_MAX_MS 전, 실행기 시계) 만들어졌다.
// answer_time_unknown: 답의 시각(answeredAt)을 모른다.
export interface DeferredLoss {
  runId: string;
  runGeneration: number;
  state: LedgerRunState;
  why: "start_may_arrive" | "answer_time_unknown";
}

// applyExecutorAnswer의 답에 싣는 경보(D-128). closed_run_running: 닫기 근거(D-90 또는 관리자)가 있는 not_started 실행을 지정 실행기가
// 같은 세대의 running으로 답했다(닫은 실행이 아직 돈다). 경보만이다: 상태·임대·점유는 바꾸지 않고, 그 답의 양성 관측은 다른 실행처럼 첫 줄만 적는다.
export type AnswerAlarm = "closed_run_running";

export interface ExecutorAnswerAlarm {
  runId: string;
  runGeneration: number;
  alarm: AnswerAlarm;
}

// moved: 믿던 임대를 거두고 unknown_running으로 옮긴 실행(접수 순번 순서). deferred: not_known을 받고도 옮기지 않은 실행(접수 순번 순서).
// outsideLedger: 장부 밖 실행, 닫는 지시에만 쓰는 세대와 함께. alarms: 경보가 난 실행(접수 순번 순서). 경보가 없으면 칸이 없다
// (applyReceipt의 alarm과 같이, 경보가 없는 답의 꼴은 그대로다).
export interface ExecutorAnswerResult {
  ok: true;
  moved: LostRun[];
  deferred: DeferredLoss[];
  outsideLedger: { runId: string; runGeneration: number }[];
  alarms?: ExecutorAnswerAlarm[];
}

// applyExecutorAnswer가 아무것도 적지 못했다(상태 이동도 양성 관측도 없다). unsavedSightings는 이 답의 not_known 밖 항목 전부다
// (장부와 대조하기 전이라 지정 실행기·세대가 다른 항목도 들어 있다). 비어 있지 않으면 부르는 쪽은 그 실행기의 더 새 답을 넘기기 전에
// 이 답을 같은 값(coverage·runs·answeredAt)으로 다시 넘긴다: 새 답이 그 실행을 빼먹으면 "안다고 한 적이 있다"가 영영 사라진다.
// 프로세스가 다시 떠 이 답을 잃으면 장부에는 흔적이 없다(run_sightings 0행이 "본 적 없음"이 아니게 된다. hasRunSighting).
export interface ExecutorAnswerUnsaved {
  ok: false;
  reason: Refusal;
  unsavedSightings: { runId: string; runGeneration: number }[];
}

// recordAnswerSightings의 입력. applyExecutorAnswer와 같은 꼴·같은 뜻이다(검증된 답 봉투의 coverage·runs·issued_at, 장부 시계의 now).
// 같은 타입으로 두어, 부르는 쪽이 받은 답을 바꾸지 않고 둘 중 어느 연산에든 넘길 수 있게 한다.
export type AnswerSightingsInput = ExecutorAnswerInput;

// 재시작 복원 2단계가 적는 양성 관측 하나. 지정 실행기·같은 세대·not_known 밖의 답만 넘긴다(트리거가 다시 본다).
export interface RunSightingObservation {
  executorId: string;
  coverage: "full" | "partial";
  status: RunStatus;
  // 복원기가 그 답을 처음 받은 시각(복원기의 시계). 적기를 다시 시도해도 received_at에 이 값을 쓴다.
  receivedAt: number;
}

// D-90 닫기(closeUnreceivedRun)의 입력. from.sender는 검증된 전체 답(hello) 봉투의 낸 쪽이다.
// runs는 그 답의 runs 그대로다(계약 v1의 실행 상태 항목). "그 답에 이 실행이 없다"를 부르는 쪽의 말로 받지 않고 장부가 이 목록에서 직접 본다:
// 부르는 쪽이 다른 답이나 부분 답을 잘못 고르면 닫는 쪽으로 틀릴 수 있는데, 목록을 받으면 그 실행이 실린 답으로는 닫히지 않는다.
// 이 목록이 그 실행기가 쥔 전부(full)인지는 장부가 가를 수 없다: 부르는 쪽은 그 연결의 검증된 hello만 넘긴다.
// answeredAt은 그 답 봉투의 issued_at(실행기 시계)이고 모르면 null(그러면 닫지 않는다), receivedAt은 감독이 그 답을 받은 시각,
// now는 닫는 시각이다(둘 다 근거 줄에 적는다).
export interface UnreceivedClosureInput {
  runId: string;
  runs: readonly RunStatus[];
  answeredAt: number | null;
  receivedAt: number;
  now: number;
}

// D-91 관리자 닫기(closeRunByOperator)의 입력(D-93·D-96·D-97). checkedBy는 관리자가 확인한 방법(고정 목록 OPERATOR_CHECKS: 작업자
// 파드를 바꿨다 하나), podName은 확인한 파드(바꾼 뒤의 작업자 파드)의 이름(Kubernetes 이름 규칙, POD_NAME), podStartedAt은 그 파드가
// 뜬 시각(Unix epoch 밀리초, 클러스터의 시계), now는 닫는 시각(감독의 시계)이다. 장부는 확인과 파드의 시각을 다시 보지 못한다:
// 사람·명령이 넘긴 값의 기록이다. 목록을 늘리려면 이관 0007의 트리거도 다음 판에서 함께 다시 만든다.
export const OPERATOR_CHECKS = ["pod_replaced"] as const;
export type OperatorCheck = (typeof OPERATOR_CHECKS)[number];
export interface OperatorClosureInput {
  runId: string;
  checkedBy: OperatorCheck;
  podName: string;
  podStartedAt: number;
  now: number;
}

// 관리자 닫기의 근거 줄 그대로(operator_closures). stopGeneration은 닫은 때의 정지 세대다.
export interface OperatorClosure {
  runId: string;
  fromState: LedgerRunState;
  checkedBy: OperatorCheck;
  podName: string;
  podStartedAt: number;
  stopGeneration: number;
  closedAt: number;
}

// 송신 표식의 입력. requestId는 그 실행의 시작 지시(task_start)의 요청 ID, now는 표식을 적는 시각이다.
export interface StartDispatchInput {
  runId: string;
  requestId: string;
  now: number;
}

// applyReceipt의 답에 싣는 경보. closed_run_started: 닫기 근거(D-90 또는 관리자)가 있는 not_started 실행에, 실행 줄에 연결된 첫 시작
// 영수증이 아닌 시작 영수증이 왔다(닫은 뒤의 시작이면 겹침의 증거). 새로 받은 것이면 장부는 그 종류의 자리를 다시 막는 점유를 적었다.
// 같은 영수증의 재전송(duplicate)에도 다시 싣는다. 닫기 전에 다른 ID로 받은 두 번째 시작 영수증의 재전송도 여기 든다(applyReceipt의 주석).
export type ReceiptAlarm = "closed_run_started";

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

export type TaskCancelReason = (typeof TASK_CANCEL_REASONS)[number];
export type SessionStopReason = (typeof SESSION_STOP_REASONS)[number];
export const FINALIZE_OUTCOMES = ["succeeded", "failed", "cancelled"] as const;
export type FinalizeOutcome = (typeof FINALIZE_OUTCOMES)[number];

export interface StopInstructionInput {
  runId: string;
  requestId: string;
  action: "task_cancel" | "session_stop";
  stopGeneration: number;
  now: number;
  // 본문의 reason(task_cancel이면 TASK_CANCEL_REASONS, session_stop이면 SESSION_STOP_REASONS). 지시 줄에 적혀 재전송의 본문이 된다.
  // 함정: 넘기지 않아도 지시는 적히지만 그 지시는 다시 만들 수 없음으로 남는다(unansweredInstructions의 rebuild가 null).
  reason?: TaskCancelReason | SessionStopReason;
}

export interface InstructionInput {
  runId: string;
  requestId: string;
  stopGeneration: number;
  now: number;
}

// 확정 지시. outcome·resultDigest·storedAt은 본문의 같은 칸이고 셋을 함께 넘기거나 함께 뺀다. 빼면 지시는 적히지만 다시 만들 수 없음으로 남는다.
// resultDigest는 succeeded일 때만 값이고 그 밖은 null이다(계약 parseResultFinalize). 실행 줄의 result_digest와 같은지는 장부가 보지 않는다.
export interface FinalizeInstructionInput extends InstructionInput {
  outcome?: FinalizeOutcome;
  resultDigest?: string | null;
  storedAt?: number;
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

// 확정(result_finalize)에 싣는 결과 보관. settledResult만 낸다. storedAt은 그 보고의 deliveries.received_at, 곧 결과 보고 처리기가
// 보관소와 장부에 함께 넘긴 시각이다. 첫 전달이면 보관소 머리의 storedAt과 같고, 장부가 거절·모름으로 답해 같은 보고가 다시 오면
// 보관소의 값보다 늦다. "저장을 마친 뒤의 시각"으로 기대해 계산하지 않는다.
export interface SettledResult {
  runId: string;
  resultDigest: string;
  storedRef: string;
  storedAt: number;
}

// failed_stopped 작업자 실행의 확정 본문(outcome·stored_at)을 정하는 데 쓰는 장부 사실. failedStop만 낸다.
export interface FailedStop {
  runId: string;
  // 실행 줄이 failed_stopped가 된 장부 시각: 그 상태로 옮긴 쓰기(종료 확인 영수증 또는 markResult의 결과 없음 판정)가 넘긴 시각이다.
  // 판 8부터는 그 쓰기가 runs.failed_stopped_at에 함께 적고 그 뒤로 바뀌지 않는다. runs.updated_at으로 읽지 않는다: recordBudget 같은
  // 뒤 쓰기가 상태와 무관하게 그 칸을 바꾼다.
  // 그 칸이 빈 줄(판 8 전에 failed_stopped가 된 줄, 원 SQL로 그 칸 없이 옮긴 줄)은 updated_at이 종료 확인 영수증을 받은 시각과 같을
  // 때만 그 시각이다. 종료 확인 쓰기는 그 영수증을 받은 시각을 같은 트랜잭션에서 updated_at으로 적으므로, 같으면 그 뒤에 다른 시각의
  // 쓰기가 없었고 곧바로 옮겼든 같은 밀리초에 판정했든 그 시각에 failed_stopped가 됐다(뒤 쓰기가 앞선 시각을 넘기지 않는다고 본다).
  // 다르면 null(모름): 뒤의 결과 없음 판정인지 예산 기록 같은 다른 쓰기인지 장부가 가를 근거가 없다.
  stoppedAt: number | null;
  // 그 실행에 사유 requested의 취소 지시(task_cancel)가 적혔으면 true, 취소 지시가 없거나 다른 사유뿐이면 false. requested는 없고
  // 사유 없이 적힌 취소 지시가 있으면 null(모름: requested였을 수 있다. 판 4 전의 줄이거나 사유를 넘기지 않은 기록).
  requestedCancel: boolean | null;
  // 종료 확인 영수증의 exit. 판 8(0008-stop-exit)부터는 그 영수증을 반영한 쓰기가 실행 줄에 함께 적은 값(runs.stop_exit)이다.
  // 그 칸이 NULL인데 failed_stopped_at이 있는 줄(판 8 전에 completed로 checking이 됐고 판 8 뒤에 결과 없음으로 판정된 줄)은 "completed"다:
  // 트리거가 failed_stopped_at을 exit 없이 적는 쓰기를 checking에서 옮길 때만 허락한다.
  // 두 칸이 다 빈 줄은 null(모름)이다. 시각으로 completed를 추론하지 않는다: updated_at이 영수증보다 늦은 것은 결과 없음 판정과 예산
  // 기록 같은 다른 쓰기가 같은 모양이라, cancelled로 곧바로 끝난 실행을 failed로 확정할 수 있다.
  exit: StopExit | null;
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

// 접수한 입력 한 줄(listInputs). source는 접수 때 받은 출처 이름 그대로다. 관리자 요청인지 경보인지 나누는 규칙은 접수 정책의
// 몫이라 장부가 정하지 않는다. 처리 위치와 무관하게 모든 입력을 낸다.
export interface InputEntry {
  requestId: string;
  seq: number;
  source: string;
  receivedAt: number;
  expiresAt: number;
  cancelled: boolean;
}

// 작업 부탁(start_worker) 줄에 적는 단계: 배정 전의 둘. 처리기의 단계 이름(src/supervisor/scheduler/tools.ts의 PHASES) 안에 있다.
// not_started는 배정 전에 취소돼 시작하지 않은 부탁이다. 이은 부탁의 줄은 waiting_assignment로 남고(CHECK), 읽기는 그 단계를
// 이은 실행 줄의 지금 상태에서 낸다(TOOL_REQUEST_RUN_PHASES).
export const TOOL_REQUEST_PHASES = ["waiting_assignment", "not_started"] as const;
export type ToolRequestPhase = (typeof TOOL_REQUEST_PHASES)[number] | LedgerRunState;

// 이은 부탁의 단계: 실행 상태 → 처리기의 단계 이름. 옮기는 자리는 여기 하나다. 처리기의 PHASES는 배정 전 대기에 장부의 실행 상태
// 이름을 그대로 더한 것이라 지금은 같은 이름으로 옮긴다. 상태가 더해지면 Record 타입과 시험이 이 표를 채우게 한다.
export const TOOL_REQUEST_RUN_PHASES: Readonly<Record<LedgerRunState, ToolRequestPhase>> = {
  queued: "queued",
  preparing: "preparing",
  running: "running",
  stopping: "stopping",
  checking: "checking",
  ready_result: "ready_result",
  finalized: "finalized",
  not_started: "not_started",
  failed_stopped: "failed_stopped",
  unknown_running: "unknown_running",
  cleanup_pending: "cleanup_pending",
};

// 관리자가 실패로 닫은 실행(not_started + operator_closures 줄)의 단계. 이 표의 not_started 칸 대신 쓴다(toToolRequest).
export const OPERATOR_CLOSED_PHASE: ToolRequestPhase = "failed_stopped";

// 목적의 분류 코드. 처리기가 인자에서 받는 꼴과 같다(시험이 대조한다).
export const PURPOSE = /^[a-z][a-z0-9_]{0,63}$/;

// 작업 부탁 한 건. 원문·자유 글·실행기·자격은 없다. ref는 장부가 돌려주는 불투명 참조이고, owner는 부탁을 낸 논리 요청이다.
export interface ToolRequest {
  ref: string;
  owner: string;
  dedupeKey: string;
  role: Role;
  purpose: string;
  sourceRef: string;
  inputDigest: string;
  phase: ToolRequestPhase;
}

// 배정을 기다리는 부탁 한 건(listWaitingToolRequests). 배정 고르기(pick.ts의 WaitingRequest)와 잇기(assignToolRequest의 ref)에
// 필요한 칸만 싣는다. 원문·자격·세션 ID·호출 ID·재시도 키·목적·원본 참조는 싣지 않는다(시험이 칸 이름 집합을 고정한다).
// input은 소유자 입력 줄의 지금 값이다. 취소·만료된 입력의 부탁도 내고 거르는 것은 고르는 쪽과 잇기다.
export interface WaitingToolRequest {
  ref: string;
  owner: string;
  role: Role;
  inputDigest: string;
  input: { cancelled: boolean; expiresAt: number };
}

// 새 부탁의 기록(recordToolRequest). ref는 새 줄을 만들 때만 쓰는 후보다. 장부는 난수를 직접 부르지 않으므로 부르는 쪽이 UUID를
// 넘기고, 같은 (owner, dedupeKey)의 줄이 이미 있으면 그 줄의 참조를 돌려주고 후보는 버린다.
export interface ToolRequestInput {
  ref: string;
  owner: string;
  dedupeKey: string;
  role: string;
  purpose: string;
  sourceRef: string;
  inputDigest: string;
  sessionId: string;
  callId: string;
  now: number;
}

// 배정(assignToolRequest): 대기 부탁을 새 실행 줄에 잇는다. 실행기·자격·기한·예산·snapshot·revision은 부르는 쪽(배정기)이 고른 값이고
// admitRun의 같은 칸과 같은 검사를 거친다. 역할·입력 digest·소유자(입력)는 부탁의 값이라 받지 않는다.
export interface AssignToolRequestInput {
  ref: string;
  runId: string;
  snapshotDigest: string;
  profileRevision: string;
  policyRevision: string;
  executorId: string;
  credential: CredentialRef;
  deadlineAt: number;
  budgetLeft: number;
  now: number;
}

interface ToolRequestRow {
  ref: string;
  owner: string;
  dedupe_key: string;
  role: string;
  purpose: string;
  source_ref: string;
  input_digest: string;
  phase: string;
  run_id: string | null;
  // 이은 실행 줄의 지금 상태. 이어지지 않았으면 null.
  run_state: string | null;
}

// 부탁과 이은 실행의 상태를 한 문장으로 읽는다. 두 번 나눠 읽으면 그 사이의 쓰기가 섞일 수 있다.
const TOOL_REQUEST_SELECT = `SELECT t.ref, t.owner, t.dedupe_key, t.role, t.purpose, t.source_ref, t.input_digest, t.phase, t.run_id, r.state AS run_state
  FROM tool_requests t LEFT JOIN runs r ON r.run_id = t.run_id`;

// 실행 줄의 중복 키. runs.dedupe_key는 소유자와 무관하게 전역 유일이라 부탁의 재시도 키를 그대로 쓰면 다른 소유자의 같은 키와
// 부딪혀 남의 실행이 돌아온다. 참조는 표 전체에서 유일하므로 참조에서 만든 키는 부탁마다 하나다.
const assignedRunKey = (ref: string) => `tool_request:${ref}`;

// 읽은 줄을 값으로 바꾼다. 이은 부탁의 단계는 이은 실행 줄의 지금 상태를 표(TOOL_REQUEST_RUN_PHASES)로 옮긴 값이다.
// 이은 실행 줄이 없거나(외래 키와 runs_permanent 트리거가 막으므로 제약을 지나친 파일에서만 생긴다) 그 상태가 장부의 상태가
// 아니면 단계를 지어내지 않고 읽지 못한 것(corrupt)으로 닫는다. 대기로 답하면 본체가 오지 않을 진행을 기다리고, not_started로
// 답하면 실행 중일 수 있는 일을 끝났다고 말하게 된다. 꼴이 어긋난 줄(스키마 CHECK를 지나친 파일)도 같다.
// operatorClosed는 이은 실행이 관리자가 실패로 닫은 not_started인지다(Ledger의 #toolRequest가 근거 표에서 읽는다). 그 실행은 이미 일부
// 돌았을 수 있어 not_started("시작 안 함")로 보이면 본체가 같은 일을 다시 맡길 수 있으므로 단계를 failed_stopped(실패)로 낸다.
// D-90으로 닫힌 실행과 대기에서 취소된 실행은 not_started 그대로다.
function toToolRequest(row: ToolRequestRow, operatorClosed: boolean): ToolRequest {
  const fits =
    UUID.test(row.ref) && UUID.test(row.owner) && (ROLES as readonly string[]).includes(row.role) && (TOOL_REQUEST_PHASES as readonly string[]).includes(row.phase);
  if (!fits) throw new LedgerUnavailableError("corrupt", "tool_requests: 꼴이 맞지 않는 줄");
  let phase = row.phase as ToolRequestPhase;
  if (row.run_id !== null) {
    const state = row.run_state;
    if (row.phase !== "waiting_assignment" || state === null || !(LEDGER_RUN_STATES as readonly string[]).includes(state)) {
      throw new LedgerUnavailableError("corrupt", "tool_requests: 이은 실행 줄을 읽을 수 없는 부탁");
    }
    phase = state === "not_started" && operatorClosed ? OPERATOR_CLOSED_PHASE : TOOL_REQUEST_RUN_PHASES[state as LedgerRunState];
  }
  return {
    ref: row.ref,
    owner: row.owner,
    dedupeKey: row.dedupe_key,
    role: row.role as Role,
    purpose: row.purpose,
    sourceRef: row.source_ref,
    inputDigest: row.input_digest,
    phase,
  };
}

// 실행 하나의 지시 이력에서 판단이 쓰는 시각(instructionTimes). null은 그런 지시를 낸 적이 없음을 장부에서 확인한 값이다.
// 읽지 못한 것은 이 값이 아니라 Read의 known: false다.
export interface InstructionTimes {
  runId: string;
  // 판단(nextIntent)이 살아 있는 임대로 쓰는 값: 임대를 준 지시의 발행 시각과 그 임대의 끝.
  // 갱신 지시(run_renew)가 하나라도 있으면 발행 시각은 기록된 갱신 발행 시각의 최댓값이고, 끝은 발급 기록의 끝이 숫자이며 시작 임대부터
  // 그 갱신까지 모든 갱신이 앞 임대의 끝보다 RENEW_MARGIN_MS 이상 앞서 발행됐을 때만 그 끝, 아니면 "unknown"이다.
  // 실행기 계약 v1에는 갱신의 영수증이 없어 실행기가 그 끝을 적용했는지 장부는 모른다. 이 끝은 감독의 추정이다(D-89 후보): 실행기는
  // 임대를 검사하는 시각이 앞 임대의 끝 이상(정각 포함)이면 연장하지 않고 닫는데, 여유를 두고 낸 갱신은 전달·시계 오차·양끝 처리가
  // 가정(RENEW_MARGIN_MS) 안이면 그 전에 검사된다. 가정은 이 시간 검사의 통과까지만 보장한다: 업무 기한 정각이나 시작 접수 중처럼
  // 시간 밖의 전제가 어긋나도 실행기는 갱신을 적용하지 않고, 감독은 그것을 확인하지 못할 수 있다(ledger.md "가정 넷이 보장하지 않는 것").
  // 가정 밖이거나, 그 전제가 어긋나거나, 갱신이 사라지면 장부의 끝은 실행기의 끝보다 늦다(ledger.md "남는 한계").
  // 종료 영수증·끊김 표시는 실행 상태를 옮겨 이 값보다 먼저 판단을 바꾼다. 발행 시각이 시작보다 이르게 기록됐어도 시작 임대로 돌아가지 않는다.
  // 갱신이 없을 때만 시작 지시의 임대다: 시작 지시는 계약이 정한 끝(발행 시각 + RUN_LEASE_MAX_MS), 세션 시작 지시는 "unknown".
  // 발행 시각이 같은 시작 지시가 여럿이면 하나라도 모르면 모름, 아니면 이른 끝을 낸다(살아 있지 않은 임대를 살아 있다고 내지 않는 쪽).
  lease: { issuedAt: number; expiresAt: number | "unknown" } | null;
  // 감독이 발급한 마지막 갱신의 기록(발급 기록): 발행 시각이 가장 큰 갱신의 시각과 그 지시 본문에 실은 끝. 갱신이 없으면 null.
  // 여유 없이 낸 갱신의 끝도 담는다. 판단에는 이 칸이 아니라 lease를 넘긴다.
  // 끝은 갱신마다 끝이 있고, 시각이 시작 뒤로 엄격히 늘고, 각 갱신이 앞 임대(시작 임대, 그 뒤로는 앞 갱신이 발급한 끝)가 끝나기 전에
  // 발행됐을 때만 낸다. 아니면(이 판 전의 줄, 순서가 어긋나 끝을 적지 않은 갱신, 끝난 임대 뒤의 갱신) "unknown"이다.
  renewIssued: { issuedAt: number; leaseUntil: number | "unknown" } | null;
  // 종료 지시(task_cancel·session_stop)와 확정 지시(result_finalize) 각각의 기록된 발행 시각의 최댓값. 마지막으로 기록한 행이
  // 아니다(더 이른 시각으로 나중에 기록한 지시는 앞 지시의 시각에 가려진다). 지금 상태에 들어온 뒤의 것으로
  // 좁히지 않는다(장부가 상태에 들어온 시각을 따로 적지 않는다).
  lastStopAt: number | null;
  lastFinalizeAt: number | null;
}

interface InstructionTime {
  action: InstructionAction;
  issuedAt: number;
  leaseUntil: number | null;
}

// 시작 지시(task_start·session_start)의 임대. 모르는 끝을 0이나 짐작한 값으로 채우지 않고 "unknown"으로 낸다.
function startLeaseOf(rows: readonly InstructionTime[]): InstructionTimes["lease"] {
  const starts = rows.filter((row) => row.action === "task_start" || row.action === "session_start");
  if (starts.length === 0) return null;
  const startAt = Math.max(...starts.map((row) => row.issuedAt));
  const ends = starts.filter((row) => row.issuedAt === startAt).map((row) => (row.action === "task_start" ? startAt + limits.RUN_LEASE_MAX_MS : null));
  const known = ends.every((end) => end !== null && Number.isSafeInteger(end));
  return { issuedAt: startAt, expiresAt: known ? Math.min(...(ends as number[])) : "unknown" };
}

// 갱신의 처리 허용치. 감독 쪽 기본값(관리자 미확정)이고 계약의 상수가 아니다. 장부에 갱신을 적은 시각부터 연결에 싣기까지와,
// 실행기가 받은 시각부터 임대를 검사하기까지의 합이 이 값 이하라고 가정한다(lifecycle.ts의 RENEW_HANDLING_MS와 같은 값).
const RENEW_HANDLING_MS = 2_000;

// 갱신을 믿는 여유. 발행 시각 s의 갱신은 s + RENEW_MARGIN_MS <= 앞 임대의 끝일 때만 그 끝을 임대로 믿는다.
// 실행기는 자기 시계로 임대를 검사하는 시각이 앞 임대의 끝 이상이면 연장하지 않는다. 그 시각은 감독 시계로 s + 싣기까지의 처리 + 전달
// + 받은 뒤의 처리이고, 끝은 감독 시계로 정한 값이라 실행기 시계가 앞서는 만큼 일찍 닿는다. 전달 < DELIVERY_MAX_MS, 시계 차이 <= CLOCK_SKEW_MS,
// 처리의 합 <= RENEW_HANDLING_MS이면 검사 시각 < s + RENEW_MARGIN_MS <= 앞 임대의 끝이 되어 등호(정각)도 믿는다. 이 가정은 앞 임대와
// 봉투의 시간 검사 통과까지만 보장한다. 가정 밖이거나 업무 기한·시작 접수 같은 다른 전제가 어긋나면 믿은 끝이 틀릴 수 있다. 수명 판단(lifecycle.ts의 RENEW_MARGIN_MS)이 같은 식을 쓴다: 장부의 공개 면을 늘리지 않고, 두 자리가 같은 값을 쓰는지는
// 경계 시험(test/ledger/lease-trust.test.ts)이 지킨다.
const RENEW_MARGIN_MS = limits.DELIVERY_MAX_MS + limits.CLOCK_SKEW_MS + RENEW_HANDLING_MS;

// 갱신 사슬. 갱신을 발행 시각 순서로 시작 임대부터 이어 본다: recordRenewInstruction이 앞 임대 지시보다 늦은 갱신에만
// 끝을 적으므로, 갱신마다 끝이 있으면 발행 시각 순서가 기록 순서이고 발행 시각이 가장 큰 갱신이 실제로 마지막에 발급한 갱신이다.
// 이어 보는 중에 하나라도 맞지 않으면 끝은 모름이다: 끝이 없는 갱신, 앞 임대 지시보다 늦지 않은 갱신(시각이 기록 순서와 어긋났다),
// 앞 임대가 끝난 시각 이후의 갱신(실행기는 이미 닫았고 지난 임대를 되살리지 않는다), 계약의 상한 밖의 끝.
// timely는 끝을 낸 사슬의 모든 갱신이 앞 임대의 끝보다 RENEW_MARGIN_MS 이상 앞서 발행됐는가다. 하나라도 늦으면 그 뒤가 다 제때여도 false다:
// 늦은 갱신을 실행기가 거절했으면 실행기는 그 앞 임대의 끝에서 이미 닫았다.
function renewChainOf(rows: readonly InstructionTime[], start: InstructionTimes["lease"]): { issuedAt: number; leaseUntil: number | "unknown"; timely: boolean } | null {
  const renews = rows.filter((row) => row.action === "run_renew").sort((a, b) => a.issuedAt - b.issuedAt);
  if (renews.length === 0) return null;
  const lastAt = renews[renews.length - 1].issuedAt;
  let issuedAt = start?.issuedAt ?? null;
  let end = start?.expiresAt ?? "unknown";
  let timely = true;
  for (const renew of renews) {
    const fits =
      issuedAt !== null &&
      end !== "unknown" &&
      renew.leaseUntil !== null &&
      issuedAt < renew.issuedAt &&
      renew.issuedAt < end &&
      renew.issuedAt < renew.leaseUntil &&
      renew.leaseUntil <= renew.issuedAt + limits.RUN_LEASE_MAX_MS;
    if (!fits) return { issuedAt: lastAt, leaseUntil: "unknown", timely: false };
    timely &&= renew.issuedAt + RENEW_MARGIN_MS <= (end as number);
    issuedAt = renew.issuedAt;
    end = renew.leaseUntil as number;
  }
  return { issuedAt: lastAt, leaseUntil: end, timely };
}

// 답을 받지 못한 지시 하나(unansweredInstructions). 같은 요청 ID·같은 본문으로 새 봉투를 만들 값과, 만들 수 없을 때의 표시를 함께 낸다.
// 자격은 참조(계정·방식·revision·digest)만 싣고 값과 원문은 싣지 않는다.
export interface UnansweredInstruction {
  requestId: string;
  action: "task_start" | "session_start" | "task_cancel" | "session_stop" | "result_finalize";
  runId: string;
  runGeneration: number;
  // 그 실행의 지정 실행기(받는 쪽).
  executorId: string;
  runState: LedgerRunState;
  // 이 지시를 적을 때의 정지 세대. 장부의 지금 정지 세대(UnansweredInstructions.stopGeneration)와 다르면 부르는 쪽은 보내지 않는다.
  // 함정: 실행기가 받는지는 실행기가 적용한 세대에 달렸다. 새 세대를 적용한 뒤에는 받지 않지만(비상 정지의 종료만 높은 세대를 받는다),
  // 적용하기 전이면 장부가 이미 넘어선 옛 세대의 지시를 받을 수 있다.
  stopGeneration: number;
  // 이 지시 줄에 적힌 발행 시각. 시작 지시는 머리의 issued_at에 그대로 싣는다(갱신 뒤의 instructionTimes.lease.issuedAt은 갱신의 시각이다).
  // 취소·세션 정지·확정의 머리 issued_at은 봉하는 때의 시각이라 이 값과 다를 수 있다.
  issuedAt: number;
  // 본문을 다시 만들 칸. null이면 장부가 그 본문을 다시 만들 수 없다: 판 4 전에 적힌 줄, 칸을 넘기지 않고 적힌 줄, 세션 시작.
  rebuild: InstructionRebuild | null;
}

// 동작마다 본문을 다시 만들 칸. 시작 지시는 실행 줄의 값과 시작 때의 예산(budgetLeft = 본문 budget_tokens)이다.
export type InstructionRebuild =
  | {
      action: "task_start";
      role: string;
      profileRevision: string;
      policyRevision: string;
      snapshotDigest: string;
      inputDigest: string;
      deadlineAt: number;
      budgetLeft: number;
      credential: CredentialRef;
    }
  | { action: "task_cancel"; reason: TaskCancelReason }
  | { action: "session_stop"; reason: SessionStopReason }
  | { action: "result_finalize"; outcome: FinalizeOutcome; resultDigest: string | null; storedAt: number };

export interface UnansweredInstructions {
  // 장부의 지금 정지 세대. 정지 기록이 없으면 null.
  stopGeneration: number | null;
  instructions: UnansweredInstruction[];
}

interface UnansweredRow {
  request_id: string;
  action: UnansweredInstruction["action"];
  run_id: string;
  stop_generation: number;
  issued_at: number;
  budget_left: number | null;
  reason: string | null;
  outcome: string | null;
  result_digest: string | null;
  stored_at: number | null;
}

// 칸이 모자라거나 계약 밖의 값이면 null이다(다시 만들 수 없음). 비어 있는 칸을 실행 줄의 지금 값이나 기본값으로 채우지 않는다.
function rebuildOf(row: UnansweredRow, run: RunRow): InstructionRebuild | null {
  switch (row.action) {
    case "task_start":
      if (row.budget_left === null || run.kind !== "worker" || run.role === null || run.snapshot_digest === null || run.input_digest === null) return null;
      return {
        action: "task_start",
        role: run.role,
        profileRevision: run.profile_revision,
        policyRevision: run.policy_revision,
        snapshotDigest: run.snapshot_digest,
        inputDigest: run.input_digest,
        deadlineAt: safe(run.deadline_at, "deadline_at"),
        budgetLeft: safe(row.budget_left, "instructions.budget_left"),
        credential: toRun(run).credential,
      };
    case "task_cancel": {
      const reason = TASK_CANCEL_REASONS.find((r) => r === row.reason);
      return reason === undefined ? null : { action: "task_cancel", reason };
    }
    case "session_stop": {
      const reason = SESSION_STOP_REASONS.find((r) => r === row.reason);
      return reason === undefined ? null : { action: "session_stop", reason };
    }
    case "result_finalize": {
      const outcome = FINALIZE_OUTCOMES.find((o) => o === row.outcome);
      if (outcome === undefined || row.stored_at === null || (outcome === "succeeded") !== (row.result_digest !== null)) return null;
      return { action: "result_finalize", outcome, resultDigest: row.result_digest, storedAt: safe(row.stored_at, "instructions.stored_at") };
    }
    case "session_start":
      return null;
  }
}

// 확정 본문의 세 칸. 셋 다 빠지면 다시 만들 수 없는 지시로 적는다. 일부만 있거나 succeeded와 결과 digest의 있고 없음이 어긋나면
// 계약이 받지 않는 본문이라(parseResultFinalize의 body_malformed) 적지 않고 던진다.
function finalizeFields(v: Record<string, unknown>): { outcome: FinalizeOutcome | null; resultDigest: string | null; storedAt: number | null } {
  const given = [v.outcome, v.resultDigest, v.storedAt].filter((value) => value !== undefined).length;
  if (given === 0) return { outcome: null, resultDigest: null, storedAt: null };
  if (given !== 3) throw new LedgerInputError("recordFinalizeInstruction: outcome·resultDigest·storedAt은 함께 넘긴다");
  const outcome = oneOf(v.outcome, FINALIZE_OUTCOMES, "outcome");
  const resultDigest = strOrNull(v.resultDigest, SHA256, "resultDigest");
  if ((outcome === "succeeded") !== (resultDigest !== null)) throw new LedgerInputError("recordFinalizeInstruction: 결과 digest는 succeeded일 때만 있다");
  return { outcome, resultDigest, storedAt: time(v.storedAt, "storedAt") };
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

// 대조 전까지 옛 시점일 수 있는 기록. 뒤의 관리 진입점이 이 목록을 그대로 관리자에게 전한다.
export const SNAPSHOT_STALE_RECORDS = ["account_locks", "receipts"] as const;

// 이 장부가 사본에서 떴다는 사실. held면 대조가 끝나지 않아 새 업무가 닫혀 있다.
export interface SnapshotOrigin {
  snapshotId: string;
  ledgerId: string;
  takenAt: number;
  reconciledAt: number | null;
  held: boolean;
  mayBeStale: typeof SNAPSHOT_STALE_RECORDS;
}

// path: 없는 경로 하나. maxBytes: 장부나 완성한 사본이 이 크기를 넘으면 사본을 내지 않는다. 쓰기가 막히는 시간이나 메모리의 상한은 아니다.
export interface SnapshotRequest {
  path: string;
  maxBytes: number;
}

export type SnapshotResult =
  | { ok: true; snapshotId: string; ledgerId: string; takenAt: number; path: string; bytes: number; sha256: string; blockedMs: number }
  | { ok: false; reason: SnapshotFailure; detail: string };

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

// 없는 경로를 이 호출의 것으로 예약하고, FD가 살아 있을 때 그 개체의 장치·inode를 기준으로 삼는다.
// 닫은 뒤에 이름으로 다시 읽으면 그 사이에 바뀐 파일이 기준이 된다. 방금 만든 파일이라 이 FD를 닫아도 풀릴 잠금이 없다.
function reserveFile(path: string, faults: Faults): BigIntStats {
  let reserved: BigIntStats;
  try {
    const fd = openSync(path, fileOpen.O_CREAT | fileOpen.O_EXCL | fileOpen.O_WRONLY | fileOpen.O_NOFOLLOW, 0o600);
    try {
      reserved = fstatSync(fd, { bigint: true });
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new LedgerUnavailableError("foreign_data", "예약하는 사이에 다른 파일이 생겼다");
    throw new LedgerUnavailableError("io", `장부 파일을 만들지 못함: ${describe(error)}`);
  }
  faults.at("open:reserved");
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
// journalLeft: 본체 곁에 저널이 남아 있다. 본체가 끊긴 트랜잭션의 중간 모습일 수 있어, 다르면 낯선 파일이 아니라 끊긴 설치로 가른다.
function requireInterruptedInstall(db: Database, migrations: readonly Migration[], journalLeft: boolean): void {
  const refused = (detail: string) => new LedgerUnavailableError(journalLeft ? "interrupted_install" : "foreign_data", detail);
  const expected = new Database(":memory:");
  try {
    if (sameContents(db, expected)) return;
    for (const migration of migrations) {
      applyMigration(expected, migration, 1);
      if (sameContents(db, expected)) return;
    }
  } catch (error) {
    throw refused(`끊긴 첫 설치와 대조하지 못함: ${describe(error)}`);
  } finally {
    expected.close();
  }
  throw refused("끊긴 첫 설치의 내용과 다르다");
}

// 코드가 적용된 판까지 만들었을 스키마. 식별 표와 트리거를 포함한다.
// 재개방은 이 결과와 장부를 대조하므로, 빈 DB에서 재생하지 못하는 판 목록으로는 장부를 만들거나 올리지 않는다.
function installedSchema(migrations: readonly Migration[], applied: number): string {
  const expected = new Database(":memory:");
  try {
    for (const migration of migrations.slice(0, applied)) applyMigration(expected, migration, 1);
    for (const sql of IDENTITY) expected.run(sql);
    return schemaOf(expected);
  } catch (error) {
    throw new LedgerUnavailableError("migration_failed", `판 목록을 빈 DB에서 재생하지 못한다: ${describe(error)}`);
  } finally {
    expected.close();
  }
}

function sqlOf(db: Database, name: string): string | null {
  return (db.query("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string } | null)?.sql ?? null;
}

// 재개방이 마이그레이션과 쓰기를 허용하기 전의 검증: 식별 표·트리거·행과 적용 기록, 적용된 판의 스키마 전체가 코드가 만드는 것과 같아야 한다.
// 첫 설치는 모든 판을 적용한 뒤에 식별 행을 적으므로, 식별 행이 있는데 적용 기록이 없는 파일은 이 코드가 만든 장부가 아니다.
// 호출자가 넘긴 판 목록도 같은 규칙이다. 적용 기록이 없으면 무엇과 대조할지 정할 수 없어 빈 목록이어도 거절한다.
function requireInstalled(db: Database, migrations: readonly Migration[]): void {
  // 행을 읽기 전에 구조부터 본다. 칸이 다른 표를 읽으면 SQL 오류가 "받지 않는 파일"이 아닌 다른 이유로 나간다.
  const reference = new Database(":memory:");
  try {
    reference.run(BOOTSTRAP);
    for (const sql of IDENTITY) reference.run(sql);
    for (const name of ["ledger_identity", "ledger_identity_permanent", "ledger_migrations"]) {
      if (sqlOf(db, name) !== sqlOf(reference, name)) throw new LedgerUnavailableError("not_initialized", `${name}이(가) 없거나 이 코드가 만든 구조가 아니다`);
    }
  } finally {
    reference.close();
  }
  const applied = appliedCount(db, migrations);
  if (applied === 0) throw new LedgerUnavailableError("not_initialized", "첫 판의 적용 기록이 없다");
  if (schemaOf(db) !== installedSchema(migrations, applied)) throw new LedgerUnavailableError("not_initialized", "적용된 판의 스키마가 이 코드의 것과 다르다");
  const row = db.query("SELECT ledger_id, created_at FROM ledger_identity WHERE id = 1").get() as { ledger_id: unknown; created_at: unknown } | null;
  if (row === null || typeof row.ledger_id !== "string" || !UUID.test(row.ledger_id) || !isTime(row.created_at)) throw new LedgerUnavailableError("not_initialized", "첫 설치 기록의 값이 이 코드의 것이 아니다");
  requireSnapshotRecords(db, row.ledger_id, userVersion(db) === SNAPSHOT_UNOPENED);
  // 판을 올리면 다음 재개방은 올린 판까지의 기준 스키마로 대조한다. 그 기준을 만들 수 없는 판은 커밋하기 전에 거절한다.
  if (applied < migrations.length) installedSchema(migrations, migrations.length);
}

function isTime(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

// 사본 기록이 있으면 이 장부의 것이고 값이 온전해야 한다. 깨졌거나 다른 장부를 가리키는 기록으로는 보류 여부를 판단할 수 없어 열지 않는다.
// unopened: 처음 여는 사본의 표식이 있다. 표식을 소비하면 이 파일이 사본이라는 근거는 기록만 남으므로, 보류를 걸 기록이 없으면 열지 않는다.
function requireSnapshotRecords(db: Database, ledgerId: string, unopened: boolean): void {
  if (sqlOf(db, "ledger_snapshots") === null) {
    if (unopened) throw new LedgerUnavailableError("corrupt", "사본 표식이 있는데 사본 기록의 표가 없다");
    return;
  }
  const rows = db.query("SELECT snapshot_id, ledger_id, taken_at, reconciled_at, reconciled_snapshot_id FROM ledger_snapshots").all() as {
    snapshot_id: unknown;
    ledger_id: unknown;
    taken_at: unknown;
    reconciled_at: unknown;
    reconciled_snapshot_id: unknown;
  }[];
  let open = 0;
  for (const row of rows) {
    if (row.ledger_id !== ledgerId) throw new LedgerUnavailableError("corrupt", "사본 기록이 다른 장부를 가리킨다");
    if (typeof row.snapshot_id !== "string" || !UUID.test(row.snapshot_id) || !isTime(row.taken_at)) throw new LedgerUnavailableError("corrupt", "사본 기록의 값이 깨졌다");
    if (row.reconciled_at === null && row.reconciled_snapshot_id === null) open += 1;
    else if (!isTime(row.reconciled_at) || row.reconciled_snapshot_id !== row.snapshot_id) throw new LedgerUnavailableError("corrupt", "사본 기록의 대조 끝 표시가 깨졌다");
  }
  if (open > 1) throw new LedgerUnavailableError("corrupt", "대조가 끝나지 않은 사본 기록이 여럿이다");
  if (unopened && latestOpenRecord(db) === null) throw new LedgerUnavailableError("corrupt", "사본 표식이 있는데 최신 미대조 사본 기록이 없다");
}

function pageSizeOf(view: Database): bigint {
  return BigInt((view.query("PRAGMA page_size").get() as { page_size: number }).page_size);
}

// SQLite는 페이지 도중에서 잘린 마지막 페이지를 0으로 채워 읽어 quick_check가 통과할 수 있다. 끊긴 사본을 여기서 거른다.
function requireWholePages(view: Database, size: bigint): void {
  if (size % pageSizeOf(view) !== 0n) throw new LedgerUnavailableError("corrupt", "본체 파일이 페이지 경계에서 끝나지 않는다(끊긴 파일)");
}

// WAL 머리(32바이트)와 프레임 하나(머리 24바이트 + 페이지)를 담지 못하는 WAL에는 복구할 커밋이 없다. 이름과 크기만 본다.
function walMayHoldCommit(path: string, view: Database): boolean {
  const wal = fileEntry(`${path}-wal`, "reopen");
  return wal !== null && wal.size >= 56n + pageSizeOf(view);
}

function requireIntact(db: Database): void {
  const check = db.query("PRAGMA quick_check").all() as { quick_check: string }[];
  if (check.length !== 1 || check[0].quick_check !== "ok") throw new LedgerUnavailableError("corrupt", `quick_check: ${check.map((r) => r.quick_check).join("; ")}`);
}

// 커밋이 든 WAL 곁의 장부를 읽기쓰기 연결을 열기 전에 판정한다. 읽기쓰기 연결은 닫을 때 WAL을 본체로 체크포인트하고 지워서, 거절하는 길에서도 파일 쌍이 바뀐다.
// 읽기 전용 연결은 WAL의 커밋을 읽고 체크포인트하지 않는다. WAL을 읽으려고 만든 -shm만 남으므로 이 호출이 생기게 한 것을 지운다.
function requireInstalledThroughWal(path: string, migrations: readonly Migration[]): void {
  const shm = `${path}-shm`;
  const shmLeft = fileEntry(shm, "reopen") !== null;
  const uri = `file:${path.split("/").map(encodeURIComponent).join("/")}?mode=ro`;
  const view = new Database(uri, sqliteOpen.SQLITE_OPEN_READONLY | sqliteOpen.SQLITE_OPEN_URI);
  try {
    requireIntact(view);
    requireInstalled(view, migrations);
  } finally {
    view.close();
    if (!shmLeft) removeQuietly(shm);
  }
}

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

// 이 설치의 표식과 처음 여는 사본의 표식. 본체만 읽는 연결이 읽은 값이든 본체 머리에서 읽은 값이든 같은 규칙으로 거절한다.
// 길이 판정보다 먼저 본다. 처음 여는 사본 곁의 WAL은 그 사본의 것일 수 없어 길이 판정을 비켜 갈 근거가 되지 않는다.
function requireMarks(mode: OpenMode, leftover: readonly string[], journalLeft: boolean, applicationId: number, version: () => number): void {
  if (applicationId !== APPLICATION_ID) throw notOurs(mode, "이 설치가 만든 장부가 아니다");
  if (mode === "reopen" && leftover.length > 0 && version() === SNAPSHOT_UNOPENED) {
    // 저널만 남았으면 이 사본의 첫 열기가 끊겼을 수 있다. 저널을 SQLite 밖에서 읽지 않아 다른 시점의 저널과 가르지 못하므로, 받지 않고 사유만 가른다.
    const reason = leftover.length === 1 && journalLeft ? "interrupted_install" : "not_initialized";
    throw new LedgerUnavailableError(reason, `한 번도 열지 않은 사본 곁에 다른 시점의 파일이 있다: ${leftover.join(", ")}`);
  }
}

// 이 프로세스가 그 파일에 잠금을 쥐고 있는지 /proc/locks로 본다. 읽지 못했거나 꼴을 모르는 줄이 있으면 null(모름).
// 줄의 꼴: "<번호>: [->] <종류> <방식> <읽기·쓰기> <pid> <major>:<minor>:<inode> <시작> <끝>". "->"는 기다리는 요청이다.
// pid가 이 프로세스이고 inode가 같으면 잠금의 종류와 장치 번호와 관계없이 쥔 것으로 본다. stat의 장치 번호가 잠금 목록의 것과
// 다른 파일시스템(btrfs 하위 볼륨 등)에서 장치까지 맞추면 쥔 파일을 놓쳐 FD를 열게 되고, 넓게 잡으면 locked로 끝날 뿐이다.
function heldHere(file: BigIntStats): boolean | null {
  let text: string;
  try {
    text = readFileSync("/proc/locks", "utf8");
  } catch {
    return null;
  }
  const pid = String(process.pid);
  let held = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.trim().split(/\s+/).filter((field) => field !== "->");
    if (fields.length !== 8 || !/^\d+:$/.test(fields[0] as string) || !/^-?\d+$/.test(fields[4] as string)) return null;
    if (fields[4] !== pid) continue;
    const inode = /^[0-9a-f]+:[0-9a-f]+:(\d+)$/.exec(fields[5] as string)?.[1];
    if (inode === undefined || BigInt(inode) === file.ino) held = true;
  }
  return held;
}

// 판정 단계에서 본체 머리 100바이트를 읽기 전용 FD로 읽는다. 이 프로세스가 그 파일을 쥐고 있으면 FD를 열지 않는다:
// 이 FD를 닫는 순간 쥔 쪽의 POSIX 잠금이 풀린다. 잠금 목록을 확인하지 못하면 FD를 열지 않고 null을 돌려준다.
// 함정: 확인과 닫기 사이에 같은 프로세스의 다른 스레드가 이 파일을 열어 잠그면 그 잠금이 풀린다. 장부를 여는 스레드는 하나라는 전제다.
function readHeader(path: string, judged: BigIntStats, mode: OpenMode): Buffer | null {
  const held = heldHere(judged);
  if (held === null) return null;
  if (held) throw new LedgerUnavailableError("locked", "이 프로세스가 이미 쥔 장부다");
  let fd: number;
  try {
    fd = openSync(path, fileOpen.O_RDONLY | fileOpen.O_NOFOLLOW);
  } catch (error) {
    throw new LedgerUnavailableError("io", `장부 머리를 열지 못함: ${describe(error)}`);
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== judged.dev || opened.ino !== judged.ino) throw notOurs(mode, "판정한 뒤에 장부 경로의 파일이 바뀌었다");
    const head = Buffer.alloc(100);
    if (readSync(fd, head, 0, 100, 0) !== 100) throw new LedgerUnavailableError("corrupt", "SQLite 장부의 머리가 아니다");
    return head;
  } finally {
    closeSync(fd);
  }
}

// 머리의 페이지 수가 유효하고(offset 92 = offset 24) 본체 길이를 페이지로 올린 수보다 크다. SQLite는 이 머리를 본체만으로 읽지 못한다.
function pagesAheadOfBody(head: Buffer, size: bigint): boolean {
  const raw = head.readUInt16BE(16);
  const page = raw === 1 ? 65536n : BigInt(raw);
  if (page < 512n || head.readUInt32BE(92) !== head.readUInt32BE(24)) return false;
  return BigInt(head.readUInt32BE(28)) > (size + page - 1n) / page;
}

// 본체만 읽는 연결이 머리를 읽지 못한 쌍 가운데 체크포인트가 파일을 늘리다 끊긴 모양만 WAL까지 읽은 판정으로 넘기고, 나머지는 그 오류로 거절한다.
// 체크포인트는 페이지를 번호 순으로 옮겨, 새 1번 페이지(늘어난 페이지 수)가 본체 끝보다 먼저 남을 수 있다.
// 본체 자신의 표식은 FD로 읽은 머리에서 본다. WAL까지 읽은 연결의 1번 페이지는 WAL이 덮은 것이라, 그것만 보면 잘린 미개봉 사본과 다른 시점의 WAL이 섞인 채 열린다.
// 머리는 이 모양일 수 있는 입력(reopen, 저널 없음, 커밋을 담을 수 있는 WAL)에서만 읽는다. 본체만 읽는 연결이 머리를 읽는 보통의 장부는 FD를 열지 않는다.
function requireCheckpointCut(error: unknown, path: string, main: BigIntStats, mode: OpenMode, leftover: readonly string[], journalLeft: boolean, view: Database): void {
  if (!(error instanceof SQLiteError) || error.code !== "SQLITE_CORRUPT" || mode !== "reopen" || journalLeft || !walMayHoldCommit(path, view)) throw error;
  const head = readHeader(path, main, mode);
  if (head === null) throw error;
  requireMarks(mode, leftover, journalLeft, head.readInt32BE(68), () => head.readInt32BE(60));
  if (!pagesAheadOfBody(head, main.size)) throw error;
}

// SQLite가 파일이나 저널을 건드리기 전의 판정. fresh: 이 호출이 새로 예약했다. 그 밖의 받지 않는 모양은 던진다.
function inspectFile(path: string, mode: OpenMode, migrations: readonly Migration[], faults: Faults): { fresh: boolean; file: BigIntStats } {
  const main = fileEntry(path, mode);
  const leftover = SIDECARS.filter((suffix) => fileEntry(`${path}${suffix}`, mode) !== null);
  if (main === null || main.size === 0n) {
    if (mode === "reopen") throw new LedgerUnavailableError("not_initialized", "장부 파일이 없거나 비었다");
    if (leftover.length > 0) throw new LedgerUnavailableError("foreign_data", `본체 없이 남은 파일: ${leftover.join(", ")}`);
    if (main !== null) throw new LedgerUnavailableError("foreign_data", "이미 있는 빈 파일은 이 설치가 예약했다는 증거가 없다");
    return { fresh: true, file: reserveFile(path, faults) };
  }
  if (main.size < 100n) throw new LedgerUnavailableError("corrupt", "SQLite 장부의 머리가 아니다");
  const journalLeft = leftover.includes("-journal");
  let recovering = false;
  const view = readOnlyView(path);
  try {
    let stored: { application_id: number } | undefined;
    try {
      stored = view.query("PRAGMA application_id").get() as { application_id: number };
    } catch (error) {
      requireCheckpointCut(error, path, main, mode, leftover, journalLeft, view);
    }
    if (stored === undefined) {
      // 머리가 본체보다 앞선 쌍: 표식은 본체 머리에서 봤고, 길이로는 판정하지 않고 WAL까지 읽은 SQLite가 판단한다.
      recovering = true;
    } else {
      requireMarks(mode, leftover, journalLeft, stored.application_id, () => userVersion(view));
      recovering = mode === "reopen" && !journalLeft && walMayHoldCommit(path, view);
      // 저널이 남은 본체는 되돌리기 전의 모습이다. 커밋이 든 WAL 곁의 본체는 체크포인트가 페이지 중간에서 끊겼을 수 있고, 논리 상태는 WAL까지 읽은 SQLite가 판단한다.
      if (!journalLeft && !recovering) requireWholePages(view, main.size);
      if (mode === "create") {
        // 저널이 남으면 커밋되지 않은 식별 행이 본체에 보일 수 있어 내용 대조로만 가른다.
        if (!journalLeft && hasIdentity(view)) throw new LedgerUnavailableError("already_initialized", "이미 만든 장부다");
        if (leftover.some((suffix) => suffix !== "-journal")) throw new LedgerUnavailableError("foreign_data", "끊긴 첫 설치에는 WAL이 남지 않는다");
        requireInterruptedInstall(view, migrations, journalLeft);
      }
    }
  } finally {
    view.close();
  }
  if (recovering) requireInstalledThroughWal(path, migrations);
  return { fresh: false, file: main };
}

// 본체를 늘리고 줄이는 단위. 페이지 크기(4,096)와 같아 파일이 페이지 배수보다 커지지 않는다.
const CHUNK_BYTES = 4096;

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
    // 첫 설치가 성공한 장부는 다음 재개방이 대조할 수 있어야 한다. 그럴 수 없는 목록은 파일을 만들기 전에 거절한다.
    if (mode === "create") {
      if (migrations.length === 0) throw new LedgerUnavailableError("migration_mismatch", "판이 없는 목록으로는 장부를 만들지 않는다. 재개방이 대조할 적용 기록이 남지 않는다");
      installedSchema(migrations, migrations.length);
    }
    // 적용 시각은 커밋된 뒤에는 고칠 수 없으므로 파일을 건드리기 전에 확인한다.
    const openedAt = options.clock();
    if (!Number.isSafeInteger(openedAt) || openedAt <= 0) throw new LedgerUnavailableError("db_error", "시계의 값이 안전한 시각이 아니다");
    const faults = options.faults ?? NO_FAULTS;
    const target = ledgerPath(path, mode);
    const { fresh, file } = inspectFile(target, mode, migrations, faults);
    faults.at("open:inspected");
    db = new Database(target, { readwrite: true, strict: true });
    // 연결이 파일을 처음 읽기 전에 본다(synchronous가 첫 읽기이고, 끊긴 트랜잭션의 저널은 그때 되돌려진다).
    requireSameFile(target, file, mode);
    // 첫 쓰기 전에 건다. 이 연결의 체크포인트가 페이지를 옮기기 전에 본체를 늘리게 해, 도중에 끊겨도 머리의 페이지 수가 본체보다 앞서지 않는다.
    // Bun 1.4.4·SQLite 3.53.4에서 체크포인트 도중 프로세스를 죽여 확인했다. 전원 차단에서의 디스크 반영 순서는 확인하지 못했다.
    if (db.fileControl(sqliteOpen.SQLITE_FCNTL_CHUNK_SIZE, CHUNK_BYTES) !== 0) throw new LedgerUnavailableError("db_error", "본체의 chunk size를 걸지 못했다");
    db.run("PRAGMA busy_timeout = 0");
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    db.run("PRAGMA synchronous = FULL");
    db.run("PRAGMA foreign_keys = ON");
    // 빈 쓰기 트랜잭션으로 지금 잠금을 잡는다. EXCLUSIVE라 커밋 뒤에도 놓지 않는다.
    db.run("BEGIN EXCLUSIVE");
    db.run("COMMIT");
    requireSameFile(target, file, mode);
    requireIntact(db);
    // 파일에 처음 쓰기 전에 본다: 받지 않는 파일은 표식도 표도 적지 않고 닫는다.
    // 잠금을 쥔 뒤의 내용으로 다시 판정한다. 잠금 전의 판정은 파일을 바꾸지 않고 거절하려는 것이고, 쓰기의 근거는 이쪽이다.
    if (mode === "reopen") {
      requireInstalled(db, migrations);
    } else {
      if (hasIdentity(db)) throw new LedgerUnavailableError("already_initialized", "이미 만든 장부다");
      requireInterruptedInstall(db, migrations, false);
    }
    if (fresh) db.run(`PRAGMA application_id = ${APPLICATION_ID}`);
    if (mode === "reopen") {
      // WAL로 바꾸기 전에 지운다. 표식이 남은 채 WAL이 생기면 다음 기동이 그 WAL을 다른 시점의 파일로 보고 거절한다.
      if (userVersion(db) === SNAPSHOT_UNOPENED) db.run("PRAGMA user_version = 0");
      useWal(db);
    }
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
    return { ok: true, ledger: new Ledger(OPENED, db, options.clock, faults, target), migrated };
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

// 실행기의 답이 믿던 임대를 거둘 수 있는 장부의 상태. stopping은 이미 갱신하지 않고, unknown_running은 어떤 답으로도 되살리지 않는다.
const LEASE_TRUSTED: readonly LedgerRunState[] = ["preparing", "running"];
// 실행기가 갱신을 아직 적용할 수 있는 상태(worker.ts의 onRenew: preparing·running에서만 늘리고, 한 번 닫힌 실행은 되살리지 않는다).
// 이 밖의 답(끝내는 중, 끝남, 모름, not_known)은 그 실행에 갱신이 더는 적용되지 않는다는 말이라 믿던 임대를 거둔다.
const RENEWABLE_REPORTED: readonly RunState[] = ["preparing", "running"];
const COVERAGES = ["full", "partial"] as const;

// D-90 닫기가 받는 앞 상태(작업자). 전이표의 두 줄(preparing·unknown_running → not_started)과 같다.
const UNRECEIVED_CLOSABLE: readonly LedgerRunState[] = ["preparing", "unknown_running"];
// 닫기 근거가 있는 not_started 실행에 늦게 와도 ack하는 영수증(계약의 실행기 영수증 셋). 나머지 동작은 닫힌 실행에도 원래 분기를 탄다.
const CLOSED_RUN_RECEIPTS: readonly ReceiptInput["action"][] = ["receipt_accepted", "receipt_stopped", "receipt_started"];
// 실행기가 그 시작을 더는 받지도 띄우지도 못하는 때까지의 길이(시작 지시의 발행 시각부터, 실행기 시계). 실행기는 봉투 시한
// (발행 + MESSAGE_TTL_MAX_MS) 뒤로는 시작을 받지 않고, 발행 + RUN_LEASE_MAX_MS부터는(정각 포함) 준비·자격·spawn 직전에 멈춘다.
// v1에서 둘 다 30000ms이고, 하나가 커져도 닫는 쪽으로 틀리지 않게 큰 쪽을 쓴다. 이관 0006의 트리거에 같은 값(30000)이 숫자로 있다(시험이 대조한다).
const START_UNREACHABLE_MS = Math.max(limits.RUN_LEASE_MAX_MS, limits.MESSAGE_TTL_MAX_MS);
// 송신 표식과 닫기 근거를 더한 판. 이 판을 적용하기 전에 시작한 실행은 표식 없이 실렸을 수 있어 닫지 않는다.
const UNRECEIVED_CLOSURE_VERSION = 6;
const UNRECEIVED_CLOSURE_FILE = "0006-unreceived-closure.sql";
// 관리자 닫기(D-91)가 받는 앞 상태(작업자, 종료 확인 없음). 전이표의 두 줄(unknown_running·stopping → not_started)과 같다.
// preparing·running은 믿는 임대가 있을 수 있어 받지 않는다: 끊김·답으로 unknown_running이 된 뒤 닫는다.
const OPERATOR_CLOSABLE: readonly LedgerRunState[] = ["unknown_running", "stopping"];
// 관리자 닫기를 받기 시작하는 때(그 실행의 task_start·run_renew 지시의 발행 시각 최댓값부터). 닫는 시각(감독의 시계)과 새 작업자
// 파드가 뜬 시각(클러스터의 시계, D-97)이 모두 이 값 뒤여야 한다. 막는 것은 새 파드의 실행기가 감독이 다시 보낸 시작을 받아 띄우는
// 길이다: 시작을 다시 보내도 장부의 발행 시각을 그대로 싣고(resend.ts), 실행기는 봉투의 시한(발행 + MESSAGE_TTL_MAX_MS) 뒤로는 받지
// 않으며 띄우기 직전에 자기 시계로 "지금 < 임대 끝"을 다시 본다(worker.ts의 launchBlocked). 임대 끝은 시작 지시의 발행 +
// RUN_LEASE_MAX_MS이고 띄우기 전(preparing)에 받은 갱신이 그 갱신의 발행 + RUN_LEASE_MAX_MS까지 늘릴 수 있다(worker.ts의 onRenew,
// 계약의 parseRunRenew). 그래서 실행기 시계로 발행 최댓값 + START_UNREACHABLE_MS부터 받기와 그 검사가 막힌다. 새 파드의 실행기는 파드가
// 뜬 뒤에 시작하므로 그 시각이 이 값 뒤면 그 시작을 받지 못한다. 갱신은 그 실행을 이미 받은 실행기에만 뜻이 있어 새 파드에는
// task_start만으로 족하지만, 같은 식을 써서 닫는 쪽으로만 틀린다. 검사를 이미 지난 옛 실행기가 프로세스를 만들기까지의 지연에는 상한이
// 없다: 그 길은 관리자의 파드 교체(D-96)가 끊고, 이 값은 그 지연의 상한이 아니다(ledger.md "관리자가 실패로 닫기").
// D-90(answer_too_early)은 같은 길이를 실행기 시계인 답의 시각과 바로 비교하지만, 여기서 아는 시각은 감독과 클러스터의 시각뿐이라
// 실행기 시계가 뒤처질 수 있는 CLOCK_SKEW_MS를 더한다(홈랩은 한 머신이라 세 시계가 같다는 전제). D-90이 갱신을 보지 않는 것은 그 실행을
// 받은 적 없는 실행기에는 갱신이 닿아도 늘릴 임대가 없어서다. 이관 0007의 트리거에 같은 값(31000)이 숫자로 두 번 있다(시험이 대조한다).
const OPERATOR_CLOSE_AFTER_MS = START_UNREACHABLE_MS + limits.CLOCK_SKEW_MS;
// 종료 확인 영수증이 적힌 뒤의 상태. 확정·정리의 정상 길이 있어 관리자 닫기를 받지 않는다(stop_confirmed).
const STOP_CONFIRMED: readonly LedgerRunState[] = ["checking", "ready_result", "failed_stopped", "cleanup_pending"];
// Kubernetes 이름 규칙(RFC 1123 DNS 서브도메인): 라벨은 소문자·숫자·'-'이고 영숫자로 시작하고 끝나며, 점으로 잇고, 전체 253자 이하.
// 이관 0007의 트리거가 같은 규칙을 GLOB로 다시 본다.
const POD_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const POD_NAME_MAX = 253;

// 실행을 맡을 수 있는 실행기 주체 이름(admitRun이 지정 실행기로 받는 것과 같은 판정). 그 밖의 이름은 잘못 넘긴 값이라,
// 실행이 없는 유효한 이름의 빈 결과와 가른다.
function runExecutor(value: unknown, where: string): string {
  const name = str(value, REF, where);
  const kind = parsePrincipal(name)?.kind;
  if (kind !== "worker_executor" && kind !== "session_executor") throw new LedgerInputError(`${where}: 실행을 맡을 수 있는 실행기 주체가 아니다`);
  return name;
}

// 실행기의 답의 runs. 계약 v1의 실행 상태 항목과 같은 꼴만 받는다(같은 실행 ID는 한 번, not_known이면 세대·영수증이 null, 상한 STATUS_MAX_RUNS,
// 조회의 답은 하나 이상). 배열의 빈 자리도 꼴이 틀린 항목이다.
function answerRuns(value: unknown, coverage: (typeof COVERAGES)[number]): RunStatus[] {
  if (!Array.isArray(value)) throw new LedgerInputError("runs: 배열이 아니다");
  if (value.length > limits.STATUS_MAX_RUNS || (coverage === "partial" && value.length === 0)) throw new LedgerInputError("runs: 항목 수가 계약의 범위 밖이다");
  const out: RunStatus[] = [];
  for (let index = 0; index < value.length; index++) {
    const where = `runs[${index}]`;
    const item = exact(value[index], ["run_id", "state", "run_generation", "last_receipt_id"], where);
    const runId = str(item.run_id, UUID, `${where}.run_id`);
    if (out.some((run) => run.run_id === runId)) throw new LedgerInputError(`${where}: 같은 실행 ID가 두 번 왔다`);
    const state = oneOf(item.state, RUN_STATES, `${where}.state`);
    if (state === "not_known") {
      if (item.run_generation !== null || item.last_receipt_id !== null) throw new LedgerInputError(`${where}: not_known은 세대와 영수증이 null이다`);
      out.push({ run_id: runId, state, run_generation: null, last_receipt_id: null });
      continue;
    }
    const generation = count(item.run_generation, `${where}.run_generation`);
    if (generation < 1) throw new LedgerInputError(`${where}.run_generation: 1 이상이어야 한다`);
    out.push({ run_id: runId, state, run_generation: generation, last_receipt_id: strOrNull(item.last_receipt_id, UUID, `${where}.last_receipt_id`) });
  }
  return out;
}

// 꼴 검사를 마친 실행 줄 입력(#admitInput → #admit).
interface AdmitChecked {
  row: {
    run_id: string;
    kind: RunKind;
    role: string | null;
    dedupe_key: string | null;
    input_request_id: string | null;
    snapshot_digest: string | null;
    input_digest: string | null;
    profile_revision: string;
    policy_revision: string;
    executor_id: string;
    deadline_at: number;
    budget_left: number;
    now: number;
  };
  credential: CredentialRef;
}

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
  readonly #path: string;
  // 호출자가 넘긴 판 목록으로 만든 장부에는 사본 기록의 표가 없을 수 있다.
  readonly #snapshots: boolean;
  // 판 4(0004-instruction-rebuild)의 지시 본문 칸. 판 목록을 그 앞에서 끊어 연 장부(시험용 길)에는 없어서, 지시를 그 판 전의 꼴로 적고
  // 판 4 전에 적힌 줄처럼 다시 만들 수 없음으로 읽는다. 기본 판 목록으로 연 장부에는 늘 있다.
  readonly #rebuildColumns: boolean;
  // 판 6(0006-unreceived-closure)의 닫기 근거 표. 판 목록을 그 앞에서 끊어 연 장부(시험용 길)에는 없어서, 늦은 영수증의 처리는
  // 닫힌 실행이 없는 것으로 읽는다(그런 장부에서는 닫을 수도 없다). 기본 판 목록으로 연 장부에는 늘 있다.
  readonly #closures: boolean;
  // 판 7(0007-operator-closure)의 관리자 닫기 근거 표. 판 목록을 그 앞에서 끊어 연 장부(시험용 길)에는 없어서, 관리자가 닫은 실행이
  // 없는 것으로 읽는다(그런 장부에서는 관리자 닫기를 거절한다). 기본 판 목록으로 연 장부에는 늘 있다.
  readonly #operatorClosures: boolean;
  // 판 8(0008-stop-exit)의 종료 영수증 exit 칸. 판 목록을 그 앞에서 끊어 연 장부(시험용 길)에는 없어서, 종료 확인만 적고 exit는
  // 판 8 전에 받은 줄처럼 모름으로 읽는다. 기본 판 목록으로 연 장부에는 늘 있다.
  readonly #stopExitColumn: boolean;
  // 판 8의 실패 상태가 된 시각 칸. 위와 같이 판 목록을 끊어 연 장부에는 없어서 적지 않고, 그 줄은 판 8 전의 줄처럼 읽는다.
  readonly #failedAtColumn: boolean;
  // 이 장부 객체의 열기 ID. 송신 표식이 "이 열기가 실었다"를 적는 값이다. 열 때마다(객체마다) 새로 만들어 다시 열면 달라진다.
  // 장부의 식별(ledger_id)·사본 ID와 같이 장부가 스스로 만드는 식별이라 crypto.randomUUID()로 만든다(업무 참조처럼 부르는 쪽이
  // 넘기게 하면 다시 연 객체가 앞 열기의 값을 쓸 수 있다). 파일에는 표식·닫기 근거 줄에만 남는다.
  readonly #openId: string;

  constructor(key: symbol, db: Database, clock: () => number, faults: Faults, path = "") {
    if (key !== OPENED) throw new TypeError("Ledger는 openLedger로만 연다");
    this.#db = db;
    this.#clock = clock;
    this.#faults = faults;
    this.#path = path;
    this.#snapshots = sqlOf(db, "ledger_snapshots") !== null;
    this.#rebuildColumns = db.query("SELECT 1 AS x FROM pragma_table_info('instructions') WHERE name = 'budget_left'").get() !== null;
    this.#closures = sqlOf(db, "unreceived_closures") !== null;
    this.#operatorClosures = sqlOf(db, "operator_closures") !== null;
    this.#stopExitColumn = db.query("SELECT 1 AS x FROM pragma_table_info('runs') WHERE name = 'stop_exit'").get() !== null;
    this.#failedAtColumn = db.query("SELECT 1 AS x FROM pragma_table_info('runs') WHERE name = 'failed_stopped_at'").get() !== null;
    this.#openId = crypto.randomUUID();
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

  #setState(row: RunRow, to: LedgerRunState, now: number, extra: Partial<Pick<RunRow, "stop_receipt_id" | "stop_exit" | "cleaned_receipt_id" | "result_digest">> = {}): void {
    if (!mayTransition(row.kind, row.state, to)) throw new Refuse("transition_denied");
    const sets = ["state = $state", "updated_at = $now"];
    const params: Record<string, string | number | null> = { state: to, now, run_id: row.run_id };
    // failed_stopped가 된 시각은 그 전이와 같은 UPDATE에서만 적힌다(판 8의 트리거). 실패 확정의 stored_at이 이 값이다(failedStop).
    const columns: Record<string, string | number | null | undefined> = to === "failed_stopped" && this.#failedAtColumn ? { ...extra, failed_stopped_at: now } : extra;
    for (const [key, value] of Object.entries(columns)) {
      sets.push(`${key} = $${key}`);
      params[key] = value ?? null;
    }
    this.#db.query(`UPDATE runs SET ${sets.join(", ")} WHERE run_id = $run_id`).run(params);
  }

  // 갱신 밖의 지시 줄을 적는 자리. 본문 칸은 그 지시를 적는 트랜잭션 안에서 함께 적고, 줄은 그 뒤 바뀌지 않는다(instructions_fixed).
  #insertInstruction(
    head: { requestId: string; runId: string; action: "task_start" | "task_cancel" | "session_stop" | "result_finalize"; stopGeneration: number; issuedAt: number },
    fields: { budgetLeft?: number; reason?: string | null; outcome?: string | null; resultDigest?: string | null; storedAt?: number | null } = {},
  ): void {
    const values = [head.requestId, head.runId, head.action, head.stopGeneration, head.issuedAt] as const;
    if (!this.#rebuildColumns) {
      this.#db.query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at) VALUES (?, ?, ?, ?, ?)").run(...values);
      return;
    }
    this.#db
      .query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at, budget_left, reason, outcome, result_digest, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...values, fields.budgetLeft ?? null, fields.reason ?? null, fields.outcome ?? null, fields.resultDigest ?? null, fields.storedAt ?? null);
  }

  #revokeIntake(): void {
    this.#grant = null;
    this.#stopEpoch += 1;
  }

  // 허가는 지금의 복원 시도가 낸 것이고, 낸 때의 정지 세대가 지금과 같고, 지금 정지가 아닐 때만 살아 있다.
  #grantHolds(stop: StopRecord): boolean {
    return this.#grant !== null && this.#attempt?.id === this.#grant.attempt && this.#grant.generation === stop.generation && !stop.stopped;
  }

  #snapshotHeld(): boolean {
    return this.#snapshots && this.#db.query("SELECT 1 AS x FROM ledger_snapshots WHERE reconciled_at IS NULL LIMIT 1").get() !== null;
  }

  // 새 일을 막는 확인. 사본에서 떠 대조가 끝나지 않았으면 막고, 기록이 없으면(모름) 막고, 정지면 막고, 지금 정지 상태의 접수 허가가 없으면 막는다.
  #requireIntake(): void {
    if (this.#snapshotHeld()) throw new Refuse("snapshot_hold");
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

  // 감독 관리 통로의 상태 조회 하나(README "감독 관리 통로"). 다른 읽기와 달리 실패해도 장부를 고장으로 표시하지 않고 허가를 버리지 않는다:
  // 감독 밖에서 온 조회가 감독의 접수와 끝 차례를 바꾸지 않게. 장부가 정말 고장이면 감독 자신의 다음 읽기·쓰기가 그것을 본다.
  // 접수 판정은 intakeOpen(attempt)과 같은 조건을 이 읽기의 정지 기록으로 본다. attempt가 null이면 닫힘이다.
  // 이미 고장으로 표시된 장부는 알려진 값을 내지 않는다: 저장에 실패한 뒤에는 더 새로운 정지를 놓쳤을 수 있다(syncStopGeneration과 같은 판정).
  // 개수는 줄을 펼치지 않고 cap에서 멈춰 센다. 함정: 조건에 맞는 줄을 찾는 훑기는 cap과 상관없이 표 크기만큼 돈다(상태 칸에 색인이 없다).
  peekStatus(cap: number, attempt: RestoreAttempt | null): Read<StatusPeek> {
    if (!Number.isSafeInteger(cap) || cap < 1) throw new LedgerInputError("cap: 1 이상의 안전 정수여야 한다");
    if (this.#closed) return { known: false, reason: "closed" };
    if (this.#broken !== null) return { known: false, reason: this.#broken };
    const count = (sql: string, ...params: (string | number)[]): number => {
      const row = this.#db.query(`SELECT COUNT(*) AS n FROM (${sql} LIMIT ?)`).get(...params, cap) as { n: number };
      return safe(row.n, "status.count");
    };
    try {
      this.#faults.at("read");
      const stop = this.#stopRow();
      const pause = (this.#db.query("SELECT until_at FROM diagnosis_pause WHERE id = 1").get() as { until_at: number | null } | null)?.until_at ?? null;
      const free = SLOT_FREE.map(() => "?").join(", ");
      const value: StatusPeek = {
        stop,
        pauseUntil: pause,
        waitingRequests: count("SELECT 1 FROM tool_requests WHERE phase = 'waiting_assignment' AND run_id IS NULL"),
        queuedRuns: count("SELECT 1 FROM runs WHERE state = 'queued'"),
        slotRuns: count(`SELECT run_id, run_generation FROM runs WHERE state NOT IN (${free}) UNION SELECT run_id, run_generation FROM slot_holds WHERE holds_slot = 1`, ...SLOT_FREE),
        intakeOpen: attempt !== null && this.#grant !== null && this.#grant.attempt === attempt && stop !== null && this.#grantHolds(stop),
      };
      return { known: true, value };
    } catch (error) {
      if (error instanceof LedgerInputError) throw error;
      return { known: false, reason: classify(error) };
    }
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
    const held = this.#read(() => this.#snapshotHeld());
    if (!held.known || held.value) return false;
    const stop = this.readStop();
    if (!stop.known || stop.value === null || stop.value.stopped) return false;
    this.#grant = { attempt, generation: stop.value.generation };
    return true;
  }

  // ---- 사본 ----

  #snapshotOrigin(): SnapshotOrigin | null {
    if (!this.#snapshots) return null;
    const row = this.#db.query("SELECT snapshot_id, ledger_id, taken_at, reconciled_at FROM ledger_snapshots ORDER BY seq DESC LIMIT 1").get() as {
      snapshot_id: string;
      ledger_id: string;
      taken_at: number;
      reconciled_at: number | null;
    } | null;
    if (row === null) return null;
    return { snapshotId: row.snapshot_id, ledgerId: row.ledger_id, takenAt: row.taken_at, reconciledAt: row.reconciled_at, held: this.#snapshotHeld(), mayBeStale: SNAPSHOT_STALE_RECORDS };
  }

  // 이 장부가 사본에서 떴는가. null이면 원본이다. held인 동안 계정 잠금과 영수증은 사본 시각(takenAt)의 것일 수 있다.
  snapshotOrigin(): Read<SnapshotOrigin | null> {
    return this.#read(() => this.#snapshotOrigin());
  }

  // 지금까지 커밋된 장부의 사본 파일을 만든다. 원본에는 아무것도 적지 않는다.
  // 동기 호출이라 끝날 때까지 이 프로세스의 쓰기와 읽기가 기다린다. 그 시간에는 상한이 없고, 성공한 결과의 blockedMs가 실제 값이다.
  // 열린 트랜잭션 안에서는 만들지 않는다. 그 연결의 그림에는 커밋되지 않은 페이지가 보인다.
  createSnapshot(input: SnapshotRequest): SnapshotResult {
    const v = exact(input, ["path", "maxBytes"], "createSnapshot");
    if (typeof v.path !== "string" || v.path === "") throw new LedgerInputError("createSnapshot.path: 경로가 아니다");
    const maxBytes = count(v.maxBytes, "maxBytes");
    const refused = (reason: SnapshotFailure, detail: string) => ({ ok: false as const, reason, detail });
    if (this.#closed || this.#broken !== null) return refused("ledger_unwritable", "장부를 쓸 수 없다");
    if (this.#db.inTransaction) return refused("in_transaction", "열린 트랜잭션 안에서는 사본을 만들지 않는다");
    if (!this.#snapshots) return refused("snapshot_unsupported", "이 장부의 판에는 사본 기록의 표가 없다");
    const startedAt = Bun.nanoseconds();
    let takenAt: number;
    try {
      takenAt = this.#clock();
    } catch (error) {
      return refused("ledger_unwritable", `시계를 읽지 못했다: ${describe(error)}`);
    }
    if (!Number.isSafeInteger(takenAt) || takenAt <= 0) return refused("ledger_unwritable", "시계의 값이 안전한 시각이 아니다");
    try {
      const target = snapshotTarget(v.path, this.#path);
      let image: Uint8Array;
      let ledgerId: string;
      try {
        if (this.#snapshotHeld()) return refused("snapshot_hold", "대조가 끝나지 않은 장부의 사본은 만들지 않는다");
        // 사본 표식이 이 칸을 덮고 첫 열기가 0으로 되돌리므로, 판이 쓰는 값은 사본에서 보존되지 않는다.
        if (userVersion(this.#db) !== 0) return refused("snapshot_unsupported", "이 장부의 판이 사본 표식의 칸(user_version)을 쓴다");
        const { size } = this.#db.query("SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()").get() as { size: number };
        if (size > maxBytes) return refused("too_large", `장부 ${size}바이트 > 상한 ${maxBytes}바이트`);
        ledgerId = (this.#db.query("SELECT ledger_id FROM ledger_identity WHERE id = 1").get() as { ledger_id: string }).ledger_id;
        image = this.#db.serialize();
        this.#faults.at("snapshot:serialized");
      } catch (error) {
        if (error instanceof SnapshotRefused) throw error;
        this.#fail(classify(error));
        return refused("ledger_unwritable", describe(error));
      }
      const snapshotId = crypto.randomUUID();
      const sealed = sealSnapshot(image, { snapshotId, ledgerId, takenAt });
      if (sealed.length > maxBytes) return refused("too_large", `사본 ${sealed.length}바이트 > 상한 ${maxBytes}바이트`);
      publishSnapshot(target, sealed, this.#faults);
      const sha256 = new Bun.CryptoHasher("sha256").update(sealed).digest("hex");
      return { ok: true, snapshotId, ledgerId, takenAt, path: target, bytes: sealed.length, sha256, blockedMs: (Bun.nanoseconds() - startedAt) / 1e6 };
    } catch (error) {
      if (error instanceof SnapshotRefused) return refused(error.reason, error.detail);
      return refused("io", describe(error));
    }
  }

  // 관리자가 대조를 마쳤다는 기록. 보류를 푸는 유일한 연산이다. 사본의 식별이 맞아야 하고, 누가 불렀는지는 받지 않는다.
  // 풀어도 접수는 닫힌 채다: 진행 중이던 복원 시도는 여기서 끝나고, 새 복원 시도가 1단계부터 끝까지 마쳐야 열린다.
  // 대조 전에 물은 권위 응답이 대조 뒤에 도착해도 그 시도를 잇지 못하게, 허가뿐 아니라 시도 자체를 지운다.
  confirmSnapshotReconciled(input: { snapshotId: string; now: number }): { ok: true; origin: SnapshotOrigin } | Refused {
    const v = exact(input, ["snapshotId", "now"], "confirmSnapshotReconciled");
    const snapshotId = str(v.snapshotId, UUID, "snapshotId");
    const now = time(v.now, "now");
    const result = this.#write("snapshot_reconcile", "new", () => {
      if (!this.#snapshots) throw new Refuse("reference_mismatch");
      const changed = this.#db.query("UPDATE ledger_snapshots SET reconciled_at = ?, reconciled_snapshot_id = snapshot_id WHERE snapshot_id = ? AND reconciled_at IS NULL").run(now, snapshotId).changes;
      if (changed === 0) throw new Refuse("reference_mismatch");
      return { ok: true as const, origin: this.#snapshotOrigin() as SnapshotOrigin };
    });
    if (result.ok) {
      this.#attempt = null;
      this.#revokeIntake();
    }
    return result;
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

  // 접수한 입력 전부를 순번대로 낸다. 대기열(queueView)과 달리 처리 위치를 지난 입력도 낸다: 시작한 실행의 입력이 나중에
  // 취소되면 그 취소를 실행 쪽 판단에 전해야 한다. 원문 참조는 싣지 않는다.
  listInputs(): Read<InputEntry[]> {
    return this.#read(() =>
      (
        this.#db.query("SELECT request_id, seq, source, received_at, source_expires_at, cancelled_at FROM inputs ORDER BY seq").all() as {
          request_id: string;
          seq: number;
          source: string;
          received_at: number;
          source_expires_at: number;
          cancelled_at: number | null;
        }[]
      ).map((row) => ({
        requestId: row.request_id,
        seq: safe(row.seq, "inputs.seq"),
        source: row.source,
        receivedAt: safe(row.received_at, "inputs.received_at"),
        expiresAt: safe(row.source_expires_at, "inputs.source_expires_at"),
        cancelled: row.cancelled_at !== null,
      })),
    );
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

  // ---- 작업 부탁(start_worker) ----

  // 두 조회는 소유자가 같은 줄만 본다. 다른 소유자의 같은 키·같은 참조는 이어졌든 아니든 없는 줄과 같은 답(null)이다.
  #toolRequestRow(column: "dedupe_key" | "ref", owner: string, value: string): ToolRequestRow | null {
    return (this.#db.query(`${TOOL_REQUEST_SELECT} WHERE t.owner = ? AND t.${column} = ?`).get(owner, value) as ToolRequestRow | null) ?? null;
  }

  findToolRequest(query: { owner: string; dedupeKey: string }): Read<ToolRequest | null> {
    const v = exact(query, ["owner", "dedupeKey"], "findToolRequest");
    const owner = str(v.owner, UUID, "owner");
    const key = str(v.dedupeKey, REF, "dedupeKey");
    return this.#read(() => {
      const row = this.#toolRequestRow("dedupe_key", owner, key);
      return row === null ? null : this.#toolRequest(row);
    });
  }

  readToolRequest(query: { owner: string; ref: string }): Read<ToolRequest | null> {
    const v = exact(query, ["owner", "ref"], "readToolRequest");
    const owner = str(v.owner, UUID, "owner");
    const ref = str(v.ref, UUID, "ref");
    return this.#read(() => {
      const row = this.#toolRequestRow("ref", owner, ref);
      return row === null ? null : this.#toolRequest(row);
    });
  }

  // 배정을 기다리는 부탁 전부(대기이고 실행에 이어지지 않은 줄). 소유자를 가리지 않는 감독 안쪽의 읽기라 도구 처리기의 포트에
  // 잇지 않는다(남의 부탁의 참조가 나온다). 순서는 소유자 입력의 순번, 부탁의 기록 시각, 참조 순이다. 기록 시각은 부르는 쪽이
  // 넘긴 값이라 같거나 뒤집힐 수 있어 참조로 끝까지 가른다(표가 WITHOUT ROWID라 삽입 순서는 없다).
  // 소유자 입력 줄이 없거나 꼴이 어긋난 줄은 빼지 않고 읽지 못한 것(corrupt)으로 닫는다: 빼면 그 부탁이 영영 배정되지 않는다.
  listWaitingToolRequests(): Read<WaitingToolRequest[]> {
    return this.#read(() =>
      (
        this.#db
          .query(
            `SELECT t.ref, t.owner, t.role, t.input_digest, i.request_id AS input_id, i.source_expires_at, i.cancelled_at
               FROM tool_requests t LEFT JOIN inputs i ON i.request_id = t.owner
              WHERE t.phase = 'waiting_assignment' AND t.run_id IS NULL
              ORDER BY i.seq, t.created_at, t.ref`,
          )
          .all() as {
          ref: string;
          owner: string;
          role: string;
          input_digest: string;
          input_id: string | null;
          source_expires_at: number | null;
          cancelled_at: number | null;
        }[]
      ).map((row) => {
        const fits =
          UUID.test(row.ref) && UUID.test(row.owner) && (ROLES as readonly string[]).includes(row.role) && SHA256.test(row.input_digest) && row.input_id !== null;
        if (!fits) throw new LedgerUnavailableError("corrupt", "tool_requests: 꼴이 맞지 않는 대기 부탁");
        return {
          ref: row.ref,
          owner: row.owner,
          role: row.role as Role,
          inputDigest: row.input_digest,
          input: { cancelled: row.cancelled_at !== null, expiresAt: safe(row.source_expires_at, "inputs.source_expires_at") },
        };
      }),
    );
  }

  // 배정 전 대기의 기록. 실행 줄·슬롯·실행기·자격을 만들지 않는다. 새 업무라 같은 트랜잭션에서 정지와 접수 허가를 다시 본다(쓰기 모드 start).
  // 같은 (소유자, 키)의 줄이 있으면 새 줄을 만들지 않고 그 줄을 돌려준다: 내용(역할·목적·원본·digest)이 같으면 existing, 다르면 conflict.
  // 다른 소유자의 같은 키는 보지 않는다. 소유자가 접수한 입력이 아니면 외래 키가 막는다(invariant_violation).
  recordToolRequest(input: ToolRequestInput): { ok: true; outcome: "created" | "existing" | "conflict"; request: ToolRequest } | Refused {
    const v = exact(input, ["ref", "owner", "dedupeKey", "role", "purpose", "sourceRef", "inputDigest", "sessionId", "callId", "now"], "recordToolRequest");
    const row = {
      ref: str(v.ref, UUID, "ref"),
      owner: str(v.owner, UUID, "owner"),
      dedupe_key: str(v.dedupeKey, REF, "dedupeKey"),
      role: oneOf(v.role, ROLES, "role"),
      purpose: str(v.purpose, PURPOSE, "purpose"),
      source_ref: str(v.sourceRef, SOURCE_REF, "sourceRef"),
      input_digest: str(v.inputDigest, SHA256, "inputDigest"),
      session_id: str(v.sessionId, REF, "sessionId"),
      call_id: str(v.callId, UUID, "callId"),
      now: time(v.now, "now"),
    };
    return this.#write("tool_request", "start", () => {
      const same = this.#toolRequestRow("dedupe_key", row.owner, row.dedupe_key);
      if (same !== null) {
        const request = this.#toolRequest(same);
        const sameContent = same.role === row.role && same.purpose === row.purpose && same.source_ref === row.source_ref && same.input_digest === row.input_digest;
        return { ok: true as const, outcome: sameContent ? ("existing" as const) : ("conflict" as const), request };
      }
      this.#db
        .query(
          `INSERT INTO tool_requests (ref, owner, dedupe_key, role, purpose, source_ref, input_digest, session_id, call_id, phase, created_at)
           VALUES ($ref, $owner, $dedupe_key, $role, $purpose, $source_ref, $input_digest, $session_id, $call_id, 'waiting_assignment', $now)`,
        )
        .run(row);
      const created = this.#toolRequestRow("ref", row.owner, row.ref);
      if (created === null) throw new Refuse("invariant_violation");
      return { ok: true as const, outcome: "created" as const, request: this.#toolRequest(created) };
    });
  }

  // 배정: 대기 부탁을 새 실행 줄에 한 트랜잭션으로 잇는다. 새 업무라 같은 트랜잭션에서 정지와 접수 허가를 다시 본다(쓰기 모드 start).
  // 실행 줄은 admitRun과 같은 검사·기록(#admitInput, #admit)으로 적고, 그 거절이면 부탁은 대기 그대로다. 부탁이 지금도 대기이고
  // 이어지지 않았는지 이 트랜잭션에서 다시 본다: 이미 이어졌으면 새 실행 줄 없이 그 실행(already_assigned), 취소됐으면
  // transition_denied, 없으면 unknown_run. 소유자 입력이 취소·만료됐으면 input_cancelled·input_expired이고 부탁은 대기 그대로다.
  // 부르는 쪽은 배정기 하나라 소유자를 받지 않는다(참조는 표 전체에서 유일하다).
  assignToolRequest(input: AssignToolRequestInput): { ok: true; outcome: "assigned" | "already_assigned"; run: Run } | Refused {
    const v = exact(input, ["ref", "runId", "snapshotDigest", "profileRevision", "policyRevision", "executorId", "credential", "deadlineAt", "budgetLeft", "now"], "assignToolRequest");
    const ref = str(v.ref, UUID, "ref");
    return this.#write("tool_request_assign", "start", () => {
      const row = (this.#db.query(`${TOOL_REQUEST_SELECT} WHERE t.ref = ?`).get(ref) as ToolRequestRow | null) ?? null;
      if (row === null) throw new Refuse("unknown_run");
      const request = this.#toolRequest(row);
      if (row.run_id !== null) return { ok: true as const, outcome: "already_assigned" as const, run: toRun(this.#runRow(row.run_id) as RunRow) };
      if (request.phase !== "waiting_assignment") throw new Refuse("transition_denied");
      // 입력의 꼴과 실행기·역할의 맞음은 admitRun과 같은 함수가 본다. 역할은 부탁의 것이라 이 트랜잭션 안에서만 알 수 있다.
      const admitted = this.#admit(
        this.#admitInput({
          kind: "worker",
          runId: v.runId,
          dedupeKey: assignedRunKey(ref),
          inputRequestId: request.owner,
          role: request.role,
          snapshotDigest: v.snapshotDigest,
          inputDigest: request.inputDigest,
          profileRevision: v.profileRevision,
          policyRevision: v.policyRevision,
          executorId: v.executorId,
          credential: v.credential,
          deadlineAt: v.deadlineAt,
          budgetLeft: v.budgetLeft,
          now: v.now,
        } as AdmitRunInput),
      );
      // 이 부탁의 키를 가진 실행이 이미 있다면 잇는 연산 밖에서 만든 줄이다. 남이 만든 실행을 이 부탁에 잇지 않는다.
      if (!admitted.created) throw new Refuse("invariant_violation");
      // 소유자 입력의 취소·만료는 startRun과 같은 이름·같은 경계(장부 시계, 만료 시각 정각부터)로 본다. 고른 뒤 만료된 부탁이
      // 시작할 수 없는 실행 줄을 얻지 않게 한다. 기존 거절이 모두 먼저라 이 검사는 잇기가 성공할 자리만 거절로 바꾼다.
      // 여기서 던지면 트랜잭션이 되돌려져 위에서 적은 실행 줄도 남지 않는다.
      const owner = this.#db.query("SELECT cancelled_at, source_expires_at FROM inputs WHERE request_id = ?").get(request.owner) as {
        cancelled_at: number | null;
        source_expires_at: number;
      } | null;
      if (owner === null || owner.cancelled_at !== null) throw new Refuse("input_cancelled");
      if (owner.source_expires_at <= this.#ledgerNow()) throw new Refuse("input_expired");
      const linked = this.#db.query("UPDATE tool_requests SET run_id = ? WHERE ref = ? AND run_id IS NULL AND phase = 'waiting_assignment'").run(admitted.run.runId, ref).changes;
      if (linked !== 1) throw new Refuse("invariant_violation");
      return { ok: true as const, outcome: "assigned" as const, run: admitted.run };
    });
  }

  // 취소 접수. 소유는 이 트랜잭션에서 다시 보고, 남의 부탁과 없는 부탁은 이어졌든 아니든 같은 거절(unknown_run)이다.
  // 닫는 기록이라 정지 중에도, 접수가 닫혀도 적는다(쓰기 모드 continue).
  // - 대기 부탁: not_started로 적는다. 이미 not_started면 transition_denied.
  // - 이은 부탁: 부탁 줄은 그대로 두고 그 실행의 취소를 종료 지시의 기록(recordStopInstruction과 같은 #recordStop)으로 남긴다.
  //   시작 전(queued)이면 not_started, 시작 뒤면 task_cancel 지시를 적고 stopping이다. 취소의 접수는 종료가 아니라 자리를 놓지 않는다.
  //   지시의 요청 ID는 이 취소 호출의 ID이고(장부는 난수를 부르지 않는다) 정지 세대는 장부의 지금 값이다. 그 지시를 보내는 것은
  //   부르는 쪽이고, 그래서 지시를 적었으면 instruction으로 돌려준다. 종료가 확인됐거나 끝난 실행이면 취소가 바꿀 것이 없어
  //   transition_denied다.
  cancelToolRequest(input: { owner: string; ref: string; sessionId: string; callId: string; now: number }):
    | { ok: true; phase: ToolRequestPhase; instruction?: { runId: string; requestId: string; stopGeneration: number } }
    | Refused {
    const v = exact(input, ["owner", "ref", "sessionId", "callId", "now"], "cancelToolRequest");
    const owner = str(v.owner, UUID, "owner");
    const ref = str(v.ref, UUID, "ref");
    const sessionId = str(v.sessionId, REF, "sessionId");
    const callId = str(v.callId, UUID, "callId");
    const now = time(v.now, "now");
    return this.#write("tool_request_cancel", "continue", () => {
      const row = this.#toolRequestRow("ref", owner, ref);
      if (row === null) throw new Refuse("unknown_run");
      const request = this.#toolRequest(row);
      if (row.run_id !== null) {
        const run = this.#runRow(row.run_id) as RunRow;
        if (run.stop_receipt_id !== null || TERMINAL.includes(run.state)) throw new Refuse("transition_denied");
        const stop = this.#stopRow();
        // 소유한 세션이 낸 취소라 본문의 reason은 requested다. 답의 instruction에는 싣지 않고 지시 줄에만 적는다.
        const after = this.#recordStop(run, callId, "task_cancel", stop?.generation ?? null, now, "requested");
        const phase = TOOL_REQUEST_RUN_PHASES[after.state];
        if (run.state === "queued" || stop === null) return { ok: true as const, phase };
        return { ok: true as const, phase, instruction: { runId: run.run_id, requestId: callId, stopGeneration: stop.generation } };
      }
      if (request.phase !== "waiting_assignment") throw new Refuse("transition_denied");
      this.#db
        .query("UPDATE tool_requests SET phase = 'not_started', cancelled_at = ?, cancel_session_id = ?, cancel_call_id = ? WHERE ref = ? AND owner = ?")
        .run(now, sessionId, callId, ref, owner);
      return { ok: true as const, phase: "not_started" as const };
    });
  }

  // ---- 실행 ----

  // 실행 줄을 대기(queued)로 적는다. 같은 중복 키는 같은 실행을 돌려준다(새 줄을 만들지 않는다).
  admitRun(input: AdmitRunInput): { ok: true; run: Run; created: boolean } | Refused {
    const admit = this.#admitInput(input);
    return this.#write("admit", "start", () => this.#admit(admit));
  }

  // 실행 줄 입력의 꼴 검사. admitRun과 배정(assignToolRequest)이 함께 쓴다.
  #admitInput(input: AdmitRunInput): AdmitChecked {
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
    return { row, credential };
  }

  // 실행 줄의 기록. 쓰기 트랜잭션 안에서만 부른다(admitRun, assignToolRequest).
  #admit({ row, credential }: AdmitChecked): { ok: true; run: Run; created: boolean } {
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
  }

  // 작업 시작 지시를 내기 직전에 부른다. 자리(작업자 슬롯)를 잡고 지시를 적은 커밋이 끝난 뒤에만 지시를 보낸다.
  // 돌려준 credential이 자격 발급의 근거다. 접수가 닫혔거나 정지 중이거나 세대가 다르면 주지 않는다.
  // issuedAt은 이 시작 지시에 적은 발행 시각(장부 시계)이고 넘긴 now가 아니다. task_start 머리의 issued_at에 그대로 싣는다.
  // 이미 시작한 실행을 다시 부르면 transition_denied라 발행 시각은 성공 답에만 있다.
  startRun(input: StartRunInput): { ok: true; run: Run; credential: CredentialRef; issuedAt: number } | Refused {
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
      // 본문의 budget_tokens는 이 시각의 남은 예산이다. 실행 줄의 값은 뒤에 줄 수 있어 지시 줄에 따로 적는다.
      this.#insertInstruction({ requestId, runId, action: "task_start", stopGeneration, issuedAt: now }, { budgetLeft: row.budget_left });
      const after = this.#runRow(runId) as RunRow;
      return { ok: true as const, run: toRun(after), credential: toRun(after).credential, issuedAt: now };
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
    const v = exact(input, ["runId", "requestId", "action", "stopGeneration", "now", "reason"], "recordStopInstruction");
    const runId = str(v.runId, UUID, "runId");
    const requestId = str(v.requestId, UUID, "requestId");
    const action = oneOf(v.action, ["task_cancel", "session_stop"] as const, "action");
    const stopGeneration = count(v.stopGeneration, "stopGeneration");
    const now = time(v.now, "now");
    // 칸을 빼면 본문을 다시 만들 수 없는 지시로 적는다(기존 호출 그대로). 넘겼으면 그 동작의 계약 목록 안이어야 한다.
    const reason = v.reason === undefined ? null : oneOf(v.reason, action === "task_cancel" ? TASK_CANCEL_REASONS : SESSION_STOP_REASONS, "reason");
    return this.#write("stop_instruction", "continue", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      return { ok: true as const, run: toRun(this.#recordStop(row, requestId, action, stopGeneration, now, reason)) };
    });
  }

  // 종료 지시의 기록. 쓰기 트랜잭션 안에서만 부른다(recordStopInstruction, 이은 부탁의 cancelToolRequest).
  // 대기 실행은 지시 없이 not_started로 닫고, 그 밖은 지금 정지 세대의 지시를 본문의 reason과 함께 적는다(정지 기록이 없으면 stop_unknown).
  #recordStop(row: RunRow, requestId: string, action: "task_cancel" | "session_stop", stopGeneration: number | null, now: number, reason: string | null): RunRow {
    if ((action === "task_cancel") !== (row.kind === "worker")) throw new Refuse("invariant_violation");
    if (row.state === "queued") {
      this.#setState(row, "not_started", now);
      return this.#runRow(row.run_id) as RunRow;
    }
    if (stopGeneration === null) throw new Refuse("stop_unknown");
    this.#requireStopGeneration(stopGeneration);
    if (["preparing", "running", "unknown_running"].includes(row.state)) this.#setState(row, "stopping", now);
    this.#insertInstruction({ requestId, runId: row.run_id, action, stopGeneration, issuedAt: now }, { reason });
    return this.#runRow(row.run_id) as RunRow;
  }

  // 결과 확정 지시. 결과 쪽 상태(종료 확인이 있는)에서만 적는다. 정리 영수증은 이 지시만 가리킬 수 있다.
  recordFinalizeInstruction(input: FinalizeInstructionInput): { ok: true } | Refused {
    const v = exact(input, ["runId", "requestId", "stopGeneration", "now", "outcome", "resultDigest", "storedAt"], "recordFinalizeInstruction");
    const runId = str(v.runId, UUID, "runId");
    const requestId = str(v.requestId, UUID, "requestId");
    const stopGeneration = count(v.stopGeneration, "stopGeneration");
    const now = time(v.now, "now");
    const fields = finalizeFields(v);
    return this.#write("finalize_instruction", "continue", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (!["ready_result", "failed_stopped", "cleanup_pending"].includes(row.state)) throw new Refuse("transition_denied");
      this.#requireStopGeneration(stopGeneration);
      this.#insertInstruction({ requestId, runId, action: "result_finalize", stopGeneration, issuedAt: now }, fields);
      return { ok: true as const };
    });
  }

  // 실행 갱신(run_renew) 지시. 기존 실행의 임대를 늘리는 것이라 새 일과 같은 전제(접수 열림, 정지 아님, 지금 세대)를 본다.
  // 돌려주는 leaseUntil(now + RUN_LEASE_MAX_MS)을 이 지시 본문의 lease_until에, now를 머리의 issued_at에 그대로 싣는다. 계약이 허락하는
  // 가장 긴 갱신이다(parseRunRenew). 실행기는 앞 임대가 끝나기 전에 받았을 때만 그 값을 임대 끝으로 삼고, 받은 시각이 앞 임대의 끝
  // 이상이면 연장하지 않고 닫는다(worker.ts의 onRenew). 그래서 장부가 적는 끝은 감독이 발급한 끝이고, instructionTimes는 그것을
  // 발급 기록(renewIssued)으로 내고, 앞 임대의 끝보다 RENEW_MARGIN_MS 이상 앞서 낸 갱신의 사슬일 때만 lease로도 낸다. 기록 자체는
  // 앞 임대의 끝과 여유를 보지 않는다(늦은 갱신도 적히고 그 끝은 믿지 않는다). 장부는 그 끝을 lease_until에 적되, 같은 실행의 앞 임대 지시(시작·갱신) 가운데 발행 시각이
  // now 이상인 것이 있으면 적지 않는다(NULL). 장부에는 지시의 기록 순서가 없어 발급 기록은 발행 시각으로 마지막 갱신을 고른다.
  // 끝을 적은 갱신들의 시각이 기록 순서대로 엄격히 느는 것을 여기서만 지킬 수 있다.
  recordRenewInstruction(input: InstructionInput): { ok: true; leaseUntil: number } | Refused {
    const v = exact(input, ["runId", "requestId", "stopGeneration", "now"], "recordRenewInstruction");
    const runId = str(v.runId, UUID, "runId");
    const requestId = str(v.requestId, UUID, "requestId");
    const stopGeneration = count(v.stopGeneration, "stopGeneration");
    const now = time(v.now, "now");
    const leaseUntil = now + limits.RUN_LEASE_MAX_MS;
    // 계약의 시각도 안전 정수다. 넘으면 이 지시의 본문을 만들 수 없다.
    if (!Number.isSafeInteger(leaseUntil)) throw new LedgerInputError("now: 임대 끝이 안전 정수를 넘는다");
    return this.#write("renew_instruction", "start", () => {
      this.#requireStopGeneration(stopGeneration);
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (!["preparing", "running"].includes(row.state)) throw new Refuse("transition_denied");
      if (row.run_generation !== this.#epoch()) throw new Refuse("run_generation_stale");
      const prior = this.#db
        .query("SELECT MAX(issued_at) AS at FROM instructions WHERE run_id = ? AND action IN ('task_start', 'session_start', 'run_renew')")
        .get(runId) as { at: number | null };
      const inOrder = prior.at === null || safe(prior.at, "instructions.issued_at") < now;
      this.#db
        .query("INSERT INTO instructions (request_id, run_id, action, stop_generation, issued_at, lease_until) VALUES (?, ?, 'run_renew', ?, ?, ?)")
        .run(requestId, runId, stopGeneration, now, inOrder ? leaseUntil : null);
      return { ok: true as const, leaseUntil };
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
    return this.#write("lost", "continue", () => ({ ok: true as const, runIds: this.#moveLost(when, null).map((moved) => moved.row.run_id) }));
  }

  // 운영 중 실행기 하나의 연결이 끊겼다: 지정 실행기가 그 실행기인 실행만 markLost와 같은 규칙으로 옮긴다.
  // 실행 세대로 더 좁히지 않는다. 세대는 시작·영수증의 대조 값이고 연결과 무관해서, 끊긴 연결 위의 옛 세대 실행도 똑같이 살아 있음을 모른다.
  // 옮긴 실행은 자리를 쥔 채이고(unknown_running), 이미 옮긴 실행은 집합 밖이라 다시 부르면 빈 목록이다.
  markLostFor(input: { executorId: string; now: number }): { ok: true; runs: LostRun[] } | Refused {
    const v = exact(input, ["executorId", "now"], "markLostFor");
    const executorId = runExecutor(v.executorId, "executorId");
    const when = time(v.now, "now");
    return this.#write("lost", "continue", () => ({
      ok: true as const,
      runs: this.#moveLost(when, executorId)
        .sort((a, b) => a.row.queue_seq - b.row.queue_seq)
        .map(({ row, next }) => ({ runId: row.run_id, runGeneration: safe(row.run_generation, "run_generation"), before: row.state, after: next })),
    }));
  }

  // 연결 상실 뒤의 상태로 옮기는 한 자리(markLost·markLostFor·applyExecutorAnswer). 옮기는 집합과 뒤 상태의 규칙이 연산마다 갈리지 않게 여기에만 둔다.
  // executorId가 null이면 실행기를 가리지 않고, runId가 null이 아니면 그 실행 하나만 본다.
  #moveLost(when: number, executorId: string | null, runId: string | null = null): { row: RunRow; next: LedgerRunState }[] {
    const scope = (executorId === null ? "" : " AND executor_id = ?") + (runId === null ? "" : " AND run_id = ?");
    const params: string[] = [...IN_FLIGHT, ...(executorId === null ? [] : [executorId]), ...(runId === null ? [] : [runId])];
    const rows = this.#db.query(`SELECT * FROM runs WHERE stop_receipt_id IS NULL AND state IN (${IN_FLIGHT.map(() => "?").join(", ")})${scope}`).all(...params) as RunRow[];
    const moved: { row: RunRow; next: LedgerRunState }[] = [];
    for (const row of rows) {
      const next = stateAfterLoss(row.state as RunState) as LedgerRunState;
      if (next !== row.state) {
        this.#setState(row, next, when);
        moved.push({ row, next });
      }
    }
    return moved;
  }

  // ---- 실행기의 답 ----

  // 운영 중에 받은 실행기의 답(status_report의 runs, 또는 hello의 runs)을 장부에 반영한다. from.sender는 검증된 답 봉투의 낸 쪽이다.
  // - 장부에 있고 지정 실행기가 sender인 항목만 본다. not_known 밖의 답은 세대도 장부와 같아야 하고(not_known은 계약상 세대가 null),
  //   그때 (실행, 실행기, 세대)의 첫 양성 관측을 적는다. 다른 실행기·다른 세대의 항목은 아무것도 바꾸지 않는다.
  // - 장부가 preparing·running인데 답이 갱신을 받는 상태(preparing·running)가 아니면 믿던 임대를 거둔다: markLostFor와 같은
  //   #moveLost로 unknown_running에 둔다. 자리는 그대로 쥔다. 끝난 상태(checking·failed_stopped 등)로는 옮기지 않는다:
  //   그 상태는 종료 확인 영수증이 있어야 하고(CHECK), 실행기는 ack를 받을 때까지 그 영수증을 다시 보낸다.
  // - 다만 not_known은 시작 봉투가 아직 닿을 수 있는 동안 만들어졌으면 거두지 않는다(#notKnownTooEarly). 그 답은 "아직 시작을
  //   받지 못했다"일 뿐이라, 거두면 곧 시작을 받아 정상으로 도는 작업이 갱신을 잃고 실패한다.
  // - "돈다"는 답은 상태도 임대도 바꾸지 않는다. 답에는 실행기의 임대 끝이 없어 갱신의 근거가 아니다.
  // - 닫힌 실행(#closedAfterStart)의 같은 세대 running 답은 답에 경보(closed_run_running)만 싣는다(D-128). 그 실행은 not_started라
  //   임대를 거두는 갈래에 들지 않고, 점유도 적지 않는다(자리를 다시 막는 것은 늦은 시작 영수증뿐이다).
  // - 장부 밖 실행은 실행 줄로 올리지 않고 닫을 대상으로만 돌려준다(계약의 runsOutsideLedger).
  // 쓰기 모드는 markLostFor와 같은 continue다: 임대를 거두는 것도 관측을 남기는 것도 자리를 더 오래 쥐는 쪽의 기록이다.
  applyExecutorAnswer(input: ExecutorAnswerInput, from: { sender: string }): ExecutorAnswerResult | ExecutorAnswerUnsaved {
    const v = exact(input, ["coverage", "runs", "answeredAt", "now"], "applyExecutorAnswer");
    const coverage = oneOf(v.coverage, COVERAGES, "coverage");
    const runs = answerRuns(v.runs, coverage);
    const answeredAt = v.answeredAt === null ? null : time(v.answeredAt, "answeredAt");
    const now = time(v.now, "now");
    const sender = runExecutor(exact(from, ["sender"], "from").sender, "from.sender");
    const written = this.#write("executor_answer", "continue", () => {
      const outsideLedger = runsOutsideLedger(runs, (runId) => this.#runRow(runId)?.run_generation).map((run) => ({ runId: run.run_id, runGeneration: run.run_generation }));
      const moved: { row: RunRow; next: LedgerRunState }[] = [];
      const deferred: { row: RunRow; why: DeferredLoss["why"] }[] = [];
      const alarmed: { row: RunRow }[] = [];
      for (const status of runs) {
        const row = this.#runRow(status.run_id);
        if (row === null || row.executor_id !== sender) continue;
        if (status.state !== "not_known") {
          if (status.run_generation !== row.run_generation) continue;
          this.#sight(sender, status, coverage, answeredAt, now);
          if (status.state === "running" && this.#closedAfterStart(row)) alarmed.push({ row });
        }
        if (!LEASE_TRUSTED.includes(row.state) || RENEWABLE_REPORTED.includes(status.state)) continue;
        const early = status.state === "not_known" ? this.#notKnownTooEarly(row.run_id, answeredAt) : null;
        if (early !== null) deferred.push({ row, why: early });
        else moved.push(...this.#moveLost(now, sender, row.run_id));
      }
      const byQueue = (a: { row: RunRow }, b: { row: RunRow }) => a.row.queue_seq - b.row.queue_seq;
      const alarms: { alarms?: ExecutorAnswerAlarm[] } =
        alarmed.length === 0
          ? {}
          : { alarms: alarmed.sort(byQueue).map(({ row }) => ({ runId: row.run_id, runGeneration: safe(row.run_generation, "run_generation"), alarm: "closed_run_running" as const })) };
      return {
        ok: true as const,
        moved: moved.sort(byQueue).map(({ row, next }) => ({ runId: row.run_id, runGeneration: safe(row.run_generation, "run_generation"), before: row.state, after: next })),
        deferred: deferred.sort(byQueue).map(({ row, why }) => ({ runId: row.run_id, runGeneration: safe(row.run_generation, "run_generation"), state: row.state, why })),
        outsideLedger,
        ...alarms,
      };
    });
    if (written.ok) return written;
    const unsavedSightings = runs.filter((run) => run.state !== "not_known").map((run) => ({ runId: run.run_id, runGeneration: run.run_generation as number }));
    return { ok: false, reason: written.reason, unsavedSightings };
  }

  // not_known이 그 실행의 시작을 받기 전에 만들어졌을 수 있는가. 시작 지시는 실행마다 하나이고 다시 봉해도 장부의 발행 시각을 싣는다.
  // 실행기는 발행 + MESSAGE_TTL_MAX_MS(봉투 시한) 뒤로는 그 봉투를 받지 않고, 받아도 발행 + RUN_LEASE_MAX_MS에 임대가 끝난다. 둘은 v1에서
  // 같은 30000ms다. 그래서 실행기 시계로 발행 + RUN_LEASE_MAX_MS 이후(정각 포함)에 만든 not_known만 "그 시작을 받을 수 없다"이다.
  // 발행 시각은 지시 줄의 값이다: 갱신 뒤의 instructionTimes.lease.issuedAt은 갱신의 시각이라 시작이 닿을 수 있는 동안을 말하지 않는다.
  // 답의 시각이나 시작 지시를 모르면 보류한다: 살아 있을 수 있는 작업을 죽이지 않는 쪽이고, 그 임대는 실행기 쪽에서 스스로 끝난다.
  #notKnownTooEarly(runId: string, answeredAt: number | null): DeferredLoss["why"] | null {
    if (answeredAt === null) return "answer_time_unknown";
    const start = this.#db.query("SELECT MAX(issued_at) AS at FROM instructions WHERE run_id = ? AND action IN ('task_start', 'session_start')").get(runId) as { at: number | null };
    if (start.at === null || answeredAt < safe(start.at, "issued_at") + limits.RUN_LEASE_MAX_MS) return "start_may_arrive";
    return null;
  }

  // 재시작 복원 2단계가 받은 실행기의 답 가운데 지정 실행기·같은 세대·not_known 밖의 것을 같은 표에 적는다. 복원의 판정은 바꾸지 않는다.
  // 포트가 답 봉투의 시각을 싣지 않아 answered_at은 비워 둔다. received_at은 관측마다 복원기가 처음 받은 시각이다.
  recordRunSightings(key: symbol, observations: readonly RunSightingObservation[]): { ok: true } | Refused {
    if (key !== RESTORE_KEY) throw new TypeError("recordRunSightings는 복원 전용 열쇠가 필요하다");
    const checked = observations.map((seen) => ({ ...seen, receivedAt: time(seen.receivedAt, "receivedAt") }));
    return this.#write("run_sighting", "continue", () => {
      for (const seen of checked) this.#sight(seen.executorId, seen.status, seen.coverage, null, seen.receivedAt);
      return { ok: true as const };
    });
  }

  // 운영 중 받은 실행기의 답에서 양성 관측만 적는다. 실행 상태·임대·영수증과 보고(deliveries)·자리는 바꾸지 않는다.
  // 지금 연결의 답으로 인정되지 않은 답(대체된 연결이나 아직 인정 전인 연결의 답, 연결 판단의 not_current)을 위한 길이다: 그런 답으로 임대를
  // 거두면 지금 연결이 아닌 쪽이 지금 실행을 바꾸지만, 관측까지 버리면 실행기가 안다고 한 실행을 D-90 닫기가 "받은 적 없음"으로 닫을 수 있다.
  // 받을 때 유효했던 답이라 "안다고 한 적이 있다"만 남긴다.
  // 보는 항목과 관측의 규칙은 applyExecutorAnswer와 같다: 장부에 있고 지정 실행기가 sender이고 세대가 같은 not_known 밖의 항목만, 첫 줄만 적는다.
  // 다른 실행기·다른 세대·장부 밖 항목은 거절하지 않고 건너뛴다(트리거에 닿으면 답 전체가 거절되어 맞는 항목의 관측까지 잃는다).
  // 장부 밖 실행을 돌려주지 않는 것은 닫을 대상을 고르는 일이 지금 연결의 답(applyExecutorAnswer)의 몫이어서다.
  // 쓰기 모드는 applyExecutorAnswer·recordRunSightings와 같은 continue다: 관측은 자리를 더 오래 쥐는 쪽(D-90을 막는 쪽)의 기록이라
  // 장부가 한 번 실패한 뒤에도, 사본 보류·정지 중에도 시도한다. 실패는 던지지 않고 applyExecutorAnswer와 같은 꼴로 돌려준다.
  recordAnswerSightings(input: AnswerSightingsInput, from: { sender: string }): { ok: true } | ExecutorAnswerUnsaved {
    const v = exact(input, ["coverage", "runs", "answeredAt", "now"], "recordAnswerSightings");
    const coverage = oneOf(v.coverage, COVERAGES, "coverage");
    const runs = answerRuns(v.runs, coverage);
    const answeredAt = v.answeredAt === null ? null : time(v.answeredAt, "answeredAt");
    const now = time(v.now, "now");
    const sender = runExecutor(exact(from, ["sender"], "from").sender, "from.sender");
    const written = this.#write("answer_sighting", "continue", () => {
      for (const status of runs) {
        if (status.state === "not_known") continue;
        const row = this.#runRow(status.run_id);
        if (row === null || row.executor_id !== sender || status.run_generation !== row.run_generation) continue;
        this.#sight(sender, status, coverage, answeredAt, now);
      }
      return { ok: true as const };
    });
    if (written.ok) return written;
    const unsavedSightings = runs.filter((run) => run.state !== "not_known").map((run) => ({ runId: run.run_id, runGeneration: run.run_generation as number }));
    return { ok: false, reason: written.reason, unsavedSightings };
  }

  // 양성 관측을 적는 한 자리. 같은 (실행, 실행기, 세대)의 줄이 있으면 그대로 둔다(첫 관측을 덮지 않는다).
  // 지정 실행기·같은 세대인지와 not_known이 아닌지는 트리거와 CHECK가 다시 본다. 어긋나면 트랜잭션째 거절된다.
  #sight(executorId: string, status: RunStatus, coverage: (typeof COVERAGES)[number], answeredAt: number | null, now: number): void {
    const seen = this.#db.query("SELECT 1 AS x FROM run_sightings WHERE run_id = ? AND executor_id = ? AND run_generation = ?").get(status.run_id, executorId, status.run_generation);
    if (seen !== null) return;
    this.#db
      .query("INSERT INTO run_sightings (run_id, executor_id, run_generation, reported_state, last_receipt_id, answered_at, received_at, coverage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(status.run_id, executorId, status.run_generation, status.state, status.last_receipt_id, answeredAt, now, coverage);
  }

  // 그 실행의 지정 실행기가 그 실행을 안다고 답한 적이 있는가(양성 관측이 하나라도 있는가). 없는 실행이면 null이다. 장부를 바꾸지 않는다.
  // 함정: false(0행)는 저장에 실패한 양성 관측이 없었을 때만 "본 적 없음"이다. 저장에 실패한 답은 같은 프로세스 안에서만 다시 넘길 수 있고
  // (applyExecutorAnswer의 unsavedSightings, 복원기가 붙든 항목), 프로세스가 다시 뜨거나 장부를 다시 열면 그 답은 어디에도 없다.
  // 읽기 실패도 같은 공백이다: 같은 복원기 객체에서도 양성 답을 받은 뒤 2단계의 실행 목록 읽기가 실패하면 그 답은 붙들리지 않고 사라진다.
  // 자리를 푸는 쪽은 이 값만으로 판정하지 않고, 이 공백(저장 실패, 읽기 실패, 재시작)을 걸친 실행을 자동 해제에서 빼는 조건을 스스로 갖춰야 한다.
  // D-90의 조건 1을 보는 쪽은 이 값과 unansweredInstructions()의 "영수증·보고 없음"을 함께 본다. 닫는 판단은 같은 트랜잭션에서 다시 본다.
  hasRunSighting(runId: string): Read<boolean | null> {
    return this.#read(() => {
      if (this.#runRow(runId) === null) return null;
      return this.#db.query("SELECT 1 AS x FROM run_sightings WHERE run_id = ? LIMIT 1").get(runId) !== null;
    });
  }

  // ---- 송신 표식과 받은 적 없는 실행의 닫기(D-90) ----

  // 시작 봉투를 연결에 싣기 직전에 부른다: "이 장부 열기가 이 실행의 시작을 실었다"를 커밋한다. 싣는 쪽은 이 답이 ok일 때만 싣는다.
  // 표식이 없는 실행은 한 번도 실리지 않았다는 것이 D-90 닫기의 전제라, 표식이 실패하면(거절·못 씀) 싣지 않는다(닫는 쪽으로 틀린다).
  // 시작 봉투를 싣는 것은 새 일을 여는 일이라 시작(startRun)과 같은 전제(쓰기 모드 start)를 거친다.
  // requestId는 그 실행의 시작 지시여야 하고(아니면 unknown_instruction), 끝났거나 종료가 확인된 실행에는 적지 않는다(transition_denied).
  // 같은 열기에서 같은 실행을 다시 적으면 그대로다(created: false, 처음 시각을 덮지 않는다).
  markStartDispatch(input: StartDispatchInput): { ok: true; created: boolean } | Refused {
    const v = exact(input, ["runId", "requestId", "now"], "markStartDispatch");
    const runId = str(v.runId, UUID, "runId");
    const requestId = str(v.requestId, UUID, "requestId");
    const now = time(v.now, "now");
    return this.#write("start_dispatch", "start", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      const start = this.#db.query("SELECT 1 AS x FROM instructions WHERE request_id = ? AND run_id = ? AND action = 'task_start'").get(requestId, runId);
      if (start === null) throw new Refuse("unknown_instruction");
      if (TERMINAL.includes(row.state) || row.stop_receipt_id !== null) throw new Refuse("transition_denied");
      if (this.#db.query("SELECT 1 AS x FROM start_dispatches WHERE run_id = ? AND open_id = ?").get(runId, this.#openId) !== null) return { ok: true as const, created: false };
      this.#db.query("INSERT INTO start_dispatches (run_id, request_id, open_id, marked_at) VALUES (?, ?, ?, ?)").run(runId, requestId, this.#openId, now);
      return { ok: true as const, created: true };
    });
  }

  // D-90: 실행기가 받은 적 없는 작업자 실행을 not_started로 닫아 자리를 푼다. 후보를 고르는 것은 부르는 쪽이고, 장부는 한 트랜잭션에서
  // 모든 조건을 다시 본다. 하나라도 아니거나 확인할 수 없으면 구별된 거절이고 상태·자리는 그대로다(닫는 쪽으로만 틀린다).
  // 조건과 거절의 순서(ledger.md "받은 적 없는 실행의 닫기"):
  // 새 일을 여는 전제(쓰기 모드 start: 못 씀·사본 보류·정지 기록 없음·정지·접수 닫힘) → 실행 있음(unknown_run) → 작업자이고 preparing·
  // unknown_running이고 종료 확인 없음(transition_denied) → 시작 지시가 하나(unknown_instruction) → 답을 낸 쪽이 지정 실행기(sender_mismatch) →
  // 답의 시각을 앎(answer_time_unknown) → 답의 시각 >= 시작 발행 + 시한(answer_too_early) → 그 답에 이 실행이 없음(run_in_answer) →
  // 영수증·보고 0(receipt_seen) → 양성 관측 0(run_sighted) → 점유 관측 0(run_blocked) → 이 판을 적용한 뒤에 낸 시작(started_before_migration) →
  // 시작 뒤 적힌 예산 감액 없음(budget_reduced) → 판 6 전의 사본 기록이 없고 사본 기록마다 경계가 있음(snapshot_bound_unknown) →
  // 사본에 없던 실행(created_before_snapshot) → 송신 표식이 없거나 모두 이 열기의 것(sent_by_other_open).
  // 판 이전의 시작과 사본 안의 실행은 시계와 무관한 값(starts_before_closure, snapshots_before_closure, 사본 경계의 queue_seq)으로 가른다.
  // 함께 보는 시각의 비교(적용 시각, 사본 시각)는 더 막기만 하는 보조다: 빼면 닫히는 경우가 늘어난다. 사본 시각은 같은 밀리초도 막아,
  // 시계가 뒤로 가지 않아도 사본과 같은 밀리초에 만들거나 발행한 실행은 닫지 않는다(적용 시각은 같은 밀리초를 받는다).
  // 닫으면 근거 줄과 not_started가 한 커밋이다. 근거 줄의 INSERT 트리거가 행으로 볼 수 있는 조건을 다시 본다(이관 0006의 주석).
  closeUnreceivedRun(input: UnreceivedClosureInput, from: { sender: string }): { ok: true; run: Run } | Refused {
    const v = exact(input, ["runId", "runs", "answeredAt", "receivedAt", "now"], "closeUnreceivedRun");
    const runId = str(v.runId, UUID, "runId");
    const runs = answerRuns(v.runs, "full");
    const answeredAt = v.answeredAt === null ? null : time(v.answeredAt, "answeredAt");
    const receivedAt = time(v.receivedAt, "receivedAt");
    const now = time(v.now, "now");
    const sender = runExecutor(exact(from, ["sender"], "from").sender, "from.sender");
    return this.#write("unreceived_closure", "start", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (row.kind !== "worker" || !UNRECEIVED_CLOSABLE.includes(row.state) || row.stop_receipt_id !== null) throw new Refuse("transition_denied");
      const starts = this.#db.query("SELECT request_id, issued_at FROM instructions WHERE run_id = ? AND action IN ('task_start', 'session_start')").all(runId) as {
        request_id: string;
        issued_at: number;
      }[];
      if (starts.length !== 1) throw new Refuse("unknown_instruction");
      const start = starts[0] as { request_id: string; issued_at: number };
      const issuedAt = safe(start.issued_at, "instructions.issued_at");
      if (row.executor_id !== sender) throw new Refuse("sender_mismatch");
      if (answeredAt === null) throw new Refuse("answer_time_unknown");
      if (answeredAt < issuedAt + START_UNREACHABLE_MS) throw new Refuse("answer_too_early");
      if (runs.some((run) => run.run_id === runId)) throw new Refuse("run_in_answer");
      if (this.#db.query("SELECT 1 AS x FROM deliveries WHERE run_id = ? LIMIT 1").get(runId) !== null) throw new Refuse("receipt_seen");
      if (this.#db.query("SELECT 1 AS x FROM run_sightings WHERE run_id = ? LIMIT 1").get(runId) !== null) throw new Refuse("run_sighted");
      if (this.#db.query("SELECT 1 AS x FROM slot_holds WHERE run_id = ? LIMIT 1").get(runId) !== null) throw new Refuse("run_blocked");
      // 판 6의 기록이 없는 장부(판 목록을 그 앞에서 끊어 연 시험용 길)에는 아래 표·칸이 없다. 그 확인이 먼저다.
      const migration = this.#db.query("SELECT applied_at FROM ledger_migrations WHERE version = ? AND name = ?").get(UNRECEIVED_CLOSURE_VERSION, UNRECEIVED_CLOSURE_FILE) as { applied_at: number } | null;
      if (migration === null) throw new Refuse("started_before_migration");
      if (this.#db.query("SELECT 1 AS x FROM starts_before_closure WHERE run_id = ? LIMIT 1").get(runId) !== null) throw new Refuse("started_before_migration");
      if (issuedAt < safe(migration.applied_at, "ledger_migrations.applied_at")) throw new Refuse("started_before_migration");
      // 시작 지시에 고정된 예산과 지금 남은 예산이 다르면 시작 뒤 감액이 적힌 실행이다. 닫으면 not_started의 숫자는 다음 실행의
      // 상한에서 빠지므로(scheduler/queue.ts의 budgetBar) 그 감액을 잊는다. 판 4 전의 시작 지시는 칸이 비어(null) 같은지 모른다.
      const fixed = this.#db.query("SELECT budget_left FROM instructions WHERE request_id = ?").get(start.request_id) as { budget_left: number | null };
      if (fixed.budget_left === null || safe(fixed.budget_left, "instructions.budget_left") !== row.budget_left) throw new Refuse("budget_reduced");
      if (this.#snapshots) {
        // 판 6을 적용할 때 있던 사본 기록이나 경계가 없는 사본 기록이 하나라도 있으면 그 사본에 어느 실행이 들어 있었는지 모른다.
        if (this.#db.query("SELECT 1 AS x FROM snapshots_before_closure LIMIT 1").get() !== null) throw new Refuse("snapshot_bound_unknown");
        if (this.#db.query("SELECT 1 AS x FROM ledger_snapshots p WHERE NOT EXISTS (SELECT 1 FROM snapshot_run_bounds b WHERE b.snapshot_id = p.snapshot_id) LIMIT 1").get() !== null) {
          throw new Refuse("snapshot_bound_unknown");
        }
        const bound = this.#db.query("SELECT MAX(queue_seq_bound) AS seq FROM snapshot_run_bounds").get() as { seq: number | null };
        if (bound.seq !== null && row.queue_seq <= safe(bound.seq, "snapshot_run_bounds.queue_seq_bound")) throw new Refuse("created_before_snapshot");
        const taken = this.#db.query("SELECT MAX(taken_at) AS at FROM ledger_snapshots").get() as { at: number | null };
        const takenAt = taken.at === null ? null : safe(taken.at, "ledger_snapshots.taken_at");
        if (takenAt !== null && (row.created_at <= takenAt || issuedAt <= takenAt)) throw new Refuse("created_before_snapshot");
      }
      if (this.#db.query("SELECT 1 AS x FROM start_dispatches WHERE run_id = ? AND open_id <> ? LIMIT 1").get(runId, this.#openId) !== null) throw new Refuse("sent_by_other_open");
      this.#db
        .query("INSERT INTO unreceived_closures (run_id, from_state, answer_executor_id, answer_issued_at, answer_received_at, open_id, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(runId, row.state, sender, answeredAt, receivedAt, this.#openId, now);
      this.#setState(row, "not_started", now);
      return { ok: true as const, run: toRun(this.#runRow(runId) as RunRow) };
    });
  }

  // D-91: 새 작업자 파드가 닫을 수 있게 되는 시각 뒤에 떴고 그 사실을 근거에 남긴 뒤에만(D-96의 확인 방법 하나, 확인한 파드의 이름과
  // 뜬 시각, D-97) 종료가 확인되지 않은 작업자 실행을 "실패로 끝남"으로 닫아 그 실행이 쥔 자리를 놓는다. 상태는 not_started이고 근거 줄(operator_closures)이 관리자 닫기를 말한다. 본체가 보는 단계는 실패다(toToolRequest).
  // 작업자 자리를 실제로 쓸 수 있는지는 따로다: 같은 종류의 점유 관측(slot_holds)이 있으면 닫아도 자리는 막혀 있다(slotFree로 읽는다).
  // 장부는 파드가 바뀌었는지 확인하지 못한다. 받는 것은 작업자의 unknown_running·stopping(종료 확인 없음)뿐이고, D-90이 좁혀 닫지 않는
  // 실행(다른 열기의 표식, 사본 안·경계 모름, 판 이전의 시작, 예산 감액)도 이 상태면 받는다: 영수증·관측·표식·사본은 보지 않는다.
  // 접수 영수증이 없는 실행, D-90이 닫을 수 있는 실행도 받는다(D-94). 관리자가 닫으면 늘 실패이고 예산은 시작한 줄로 세므로, 두 닫기
  // 가운데 먼저 된 쪽에 따라 본체가 보는 단계와 같은 입력의 다음 배정이 다르다.
  // 그 실행의 task_start 지시가 없거나 session_start 지시가 있거나(작업자의 정상 이력에는 없다: startRun은 task_start만 적고 startSession은
  // 지시를 적지 않는다), now가 그 실행의 task_start·run_renew 지시의 발행 최댓값 + OPERATOR_CLOSE_AFTER_MS 전이면 닫지 않는다
  // (start_may_launch). podStartedAt ≤ now를 먼저 요구하므로 now가 한도 전이면 그 파드도 한도 전에 떴고, 같은 파드로는 기다려도
  // 닫히지 않는다: 이력이 맞으면 한도까지 기다린 뒤 파드를 교체하고, 새 파드가 뜬 시각을 다시 읽어 닫는다. podStartedAt이 같은 한도 전이면 pod_started_too_early다(새 파드가 그 시작을 받을 수 있었다: 파드를
  // 한 번 더 바꾼다). 장부는 사람이 언제 확인했는지, 넘긴 파드의 시각이 맞는지 모른다(부르는 쪽이 지킬 조건).
  // 거절의 순서: 못 씀(ledger_unwritable) → 실행 있음(unknown_run) → 작업자(run_not_worker) → 끝 상태 아님(run_ended) →
  // 종료 확인 없음(stop_confirmed) → unknown_running·stopping(transition_denied) → 정지 기록 있음(stop_unknown) →
  // task_start 지시가 있고 session_start 지시가 없으며 닫을 수 있게 되는 시각이 지남(start_may_launch) → 파드가 그 시각 뒤에 뜸
  // (pod_started_too_early).
  // 확인 방법·파드 이름·파드의 시각이 꼴 밖이거나 파드의 시각이 now보다 늦으면 트랜잭션을 열기 전에 LedgerInputError다(아무것도 쓰지 않는다).
  // 쓰기 모드 new(풀기 releaseStop과 같은 묶음): 장부가 한 번이라도 실패했으면 거절하고, 사본 보류·정지·접수 닫힘은 막지 않는다.
  // 관리자는 사본을 대조하는 주체이고, 닫기는 새 일을 열지 않고 자리만 푼다(시작은 여전히 시작의 전제를 지난다).
  // 근거 줄을 넣는 문장 하나가 실행 줄을 not_started로 닫고 그 실행의 미반영 보고를 반영하지 않고 마친다(이관 0007의
  // operator_closures_close_run, applied_at = 닫은 시각: 닫힌 뒤에 처음 온 보고를 받은 자리에서 마치는 것(recordReport)과 같은 끝이다).
  // 그 INSERT 트리거가 행으로 볼 수 있는 조건(앞 상태, 종료 확인 없음, 이름, 정지 세대, 시작 지시, 두 시각과 그 순서)을 다시 본다.
  closeRunByOperator(input: OperatorClosureInput): { ok: true; run: Run; closure: OperatorClosure } | Refused {
    const v = exact(input, ["runId", "checkedBy", "podName", "podStartedAt", "now"], "closeRunByOperator");
    const runId = str(v.runId, UUID, "runId");
    if (!(OPERATOR_CHECKS as readonly unknown[]).includes(v.checkedBy)) throw new LedgerInputError("checkedBy: 확인 방법의 목록 밖이다");
    const checkedBy = v.checkedBy as OperatorCheck;
    if (typeof v.podName !== "string" || v.podName.length > POD_NAME_MAX || !POD_NAME.test(v.podName)) throw new LedgerInputError("podName: Kubernetes 이름 규칙 밖이다");
    const podName = v.podName;
    const podStartedAt = time(v.podStartedAt, "podStartedAt");
    const now = time(v.now, "now");
    if (podStartedAt > now) throw new LedgerInputError("podStartedAt: 닫는 시각보다 늦다");
    return this.#write("operator_closure", "new", () => {
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (row.kind !== "worker") throw new Refuse("run_not_worker");
      if (TERMINAL.includes(row.state)) throw new Refuse("run_ended");
      if (row.stop_receipt_id !== null || STOP_CONFIRMED.includes(row.state)) throw new Refuse("stop_confirmed");
      if (!OPERATOR_CLOSABLE.includes(row.state)) throw new Refuse("transition_denied");
      // 판 7의 기록이 없는 장부(판 목록을 그 앞에서 끊어 연 시험용 길)에는 근거 표가 없다.
      if (!this.#operatorClosures) throw new Refuse("transition_denied");
      const stop = this.#stopRow();
      if (stop === null) throw new Refuse("stop_unknown");
      // task_start가 없는 실행은 시간의 근거가 없다: 갱신·세션 시작 한 줄만으로 한도를 정하지 않는다. session_start가 섞인 실행은
      // 그 시작이 언제까지 띄울 수 있는지 아래 식이 세지 않아 닫지 않는다.
      const starts = this.#db
        .query("SELECT count(*) FILTER (WHERE action = 'task_start') AS task, count(*) FILTER (WHERE action = 'session_start') AS session FROM instructions WHERE run_id = ?")
        .get(runId) as { task: number; session: number };
      if (starts.task === 0 || starts.session !== 0) throw new Refuse("start_may_launch");
      const issued = this.#db.query("SELECT MAX(issued_at) AS at FROM instructions WHERE run_id = ? AND action IN ('task_start', 'run_renew')").get(runId) as {
        at: number | null;
      };
      if (issued.at === null) throw new Refuse("start_may_launch");
      const closableAt = safe(issued.at, "instructions.issued_at") + OPERATOR_CLOSE_AFTER_MS;
      if (now < closableAt) throw new Refuse("start_may_launch");
      if (podStartedAt < closableAt) throw new Refuse("pod_started_too_early");
      this.#db
        .query("INSERT INTO operator_closures (run_id, from_state, checked_by, pod_name, pod_started_at, stop_generation, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(runId, row.state, checkedBy, podName, podStartedAt, stop.generation, now);
      const closure: OperatorClosure = { runId, fromState: row.state, checkedBy, podName, podStartedAt, stopGeneration: stop.generation, closedAt: now };
      return { ok: true as const, run: toRun(this.#runRow(runId) as RunRow), closure };
    });
  }

  // 관리자가 실패로 닫은 실행의 근거 줄. 없으면 null이다(닫지 않았거나 D-90으로 닫았거나 판 7 전의 장부).
  operatorClosure(runId: string): Read<OperatorClosure | null> {
    return this.#read(() => {
      if (!this.#operatorClosures) return null;
      const row = this.#db
        .query("SELECT run_id, from_state, checked_by, pod_name, pod_started_at, stop_generation, closed_at FROM operator_closures WHERE run_id = ?")
        .get(runId) as {
        run_id: string;
        from_state: string;
        checked_by: string;
        pod_name: string;
        pod_started_at: number;
        stop_generation: number;
        closed_at: number;
      } | null;
      if (row === null) return null;
      if (!OPERATOR_CLOSABLE.includes(row.from_state as LedgerRunState) || !(OPERATOR_CHECKS as readonly string[]).includes(row.checked_by)) {
        throw new LedgerUnavailableError("corrupt", "operator_closures: 꼴이 맞지 않는 줄");
      }
      return {
        runId: row.run_id,
        fromState: row.from_state as LedgerRunState,
        checkedBy: row.checked_by as OperatorCheck,
        podName: row.pod_name,
        podStartedAt: safe(row.pod_started_at, "operator_closures.pod_started_at"),
        stopGeneration: safe(row.stop_generation, "operator_closures.stop_generation"),
        closedAt: safe(row.closed_at, "operator_closures.closed_at"),
      };
    });
  }

  #operatorClosed(runId: string): boolean {
    return this.#operatorClosures && this.#db.query("SELECT 1 AS x FROM operator_closures WHERE run_id = ?").get(runId) !== null;
  }

  // 부탁 줄을 값으로 바꾼다. 이은 실행이 not_started면 관리자 닫기의 근거가 있는지 읽어 단계를 가른다(toToolRequest).
  #toolRequest(row: ToolRequestRow): ToolRequest {
    return toToolRequest(row, row.run_id !== null && row.run_state === "not_started" && this.#operatorClosed(row.run_id));
  }

  // 이 실행이 닫기 근거(D-90 또는 관리자)를 가진 not_started인가(시작한 뒤 닫힌 실행). 대기에서 취소돼 not_started가 된 실행은 아니다.
  // 늦은 영수증·보고의 처리를 가르는 한 자리다.
  #closedAfterStart(row: RunRow): boolean {
    if (row.state !== "not_started") return false;
    if (this.#closures && this.#db.query("SELECT 1 AS x FROM unreceived_closures WHERE run_id = ?").get(row.run_id) !== null) return true;
    return this.#operatorClosed(row.run_id);
  }

  getRun(runId: string): Read<Run | null> {
    return this.#read(() => {
      const row = this.#runRow(runId);
      return row === null ? null : toRun(row);
    });
  }

  listRuns(): Read<Run[]> {
    return this.#read(() =>
      (this.#db.query("SELECT * FROM runs ORDER BY queue_seq").all() as RunRow[]).map((row) => {
        const run: Run = row.state === "not_started" ? { ...toRun(row), closedByOperator: this.#operatorClosed(row.run_id) } : toRun(row);
        return row.kind === "worker" ? { ...run, reservedBudget: this.#reservedBudget(row.run_id) } : run;
      }),
    );
  }

  // 작업자 실행이 그 요청의 예산에서 잡고 있는 양(ledger.md "요청 예산의 예약"). 장부가 아는 사실(시작 지시, D-90 근거)로만 정하고
  // runs.budget_left는 읽지 않는다: 시작 뒤 감액은 계측이 아직 없어 돌려주지 않고(D-77), 대기 중 감액은 시작 지시에 이미 고정돼 있다.
  #reservedBudget(runId: string): number | null {
    const starts = this.#db
      .query(`SELECT action, ${this.#rebuildColumns ? "budget_left" : "NULL AS budget_left"} FROM instructions WHERE run_id = ? AND action IN ('task_start', 'session_start')`)
      .all(runId) as { action: string; budget_left: number | null }[];
    if (starts.length === 0) return 0;
    // startRun은 한 번만 시작 지시를 적고 시작한 줄은 대기로 돌아가지 않는다. 둘 이상이거나 작업자 줄에 세션 시작이 있으면 어느 예산인지 정하지 않는다.
    const [start] = starts;
    if (starts.length > 1 || start?.action !== "task_start") return null;
    // D-90은 실행기가 받은 적 없고 감액도 없는 실행만 닫으므로(budget_reduced) 쓴 예산이 없다. 관리자 닫기는 이미 돌았을 수 있어 여기서 빼지 않는다(D-94).
    if (this.#closures && this.#db.query("SELECT 1 AS x FROM unreceived_closures WHERE run_id = ?").get(runId) !== null) return 0;
    // 판 4 전에 적힌 시작 지시에는 고정 예산이 없다. 지금 잔액으로 메우지 않는다.
    return start.budget_left === null ? null : safe(start.budget_left, "instructions.budget_left");
  }

  // 실행의 지시 이력 시각. 없는 실행이면 null이다. 장부를 바꾸지 않는다.
  instructionTimes(runId: string): Read<InstructionTimes | null> {
    return this.#read(() => {
      if (this.#runRow(runId) === null) return null;
      const rows = (
        this.#db.query("SELECT action, issued_at, lease_until FROM instructions WHERE run_id = ?").all(runId) as {
          action: InstructionAction;
          issued_at: number;
          lease_until: number | null;
        }[]
      ).map((row) => ({
        action: row.action,
        issuedAt: safe(row.issued_at, "instructions.issued_at"),
        leaseUntil: row.lease_until === null ? null : safe(row.lease_until, "instructions.lease_until"),
      }));
      const latest = (actions: readonly InstructionAction[]): number | null => {
        const times = rows.filter((row) => actions.includes(row.action)).map((row) => row.issuedAt);
        return times.length === 0 ? null : Math.max(...times);
      };
      const start = startLeaseOf(rows);
      const chain = renewChainOf(rows, start);
      const renewIssued: InstructionTimes["renewIssued"] = chain === null ? null : { issuedAt: chain.issuedAt, leaseUntil: chain.leaseUntil };
      // 갱신 뒤의 lease는 사슬의 모든 갱신이 여유를 두고 발행됐을 때만 발급한 끝이다(InstructionTimes.lease).
      const lease: InstructionTimes["lease"] = chain === null ? start : { issuedAt: chain.issuedAt, expiresAt: chain.timely ? chain.leaseUntil : "unknown" };
      return { runId, lease, renewIssued, lastStopAt: latest(["task_cancel", "session_stop"]), lastFinalizeAt: latest(["result_finalize"]) };
    });
  }

  // 아직 맞는 영수증을 받지 못한 지시. 장부를 바꾸지 않는다. 판정(ledger.md "답을 받지 못한 지시"):
  // - 시작(task_start·session_start): 그 실행에서 받은 영수증·보고가 하나도 없다. 실행기는 시작 지시로만 실행을 알게 되므로 그 실행의
  //   영수증·보고가 하나라도 있으면 시작을 받은 것이다. 접수 영수증만 보면, 그것만 늦게 오는 동안 이미 도는 실행을 "받은 적 없음"으로 읽는다.
  // - 종료(task_cancel·session_stop): 그 요청 ID의 접수 영수증도, 그 실행의 종료 확인도 없다.
  // - 확정(result_finalize): 그 요청 ID의 정리 영수증이 없다.
  // 갱신(run_renew)은 영수증이 없는 지시라 내지 않는다. 끝난 실행(finalized·not_started)과, 시작·종료는 종료가 확인된 실행의 것도 내지 않는다.
  // 순서는 실행의 대기 순번, 그 안에서 시작 → 종료 → 확정, 발행 시각, 요청 ID다.
  unansweredInstructions(): Read<UnansweredInstructions> {
    return this.#read(() => {
      const fields = this.#rebuildColumns
        ? "i.budget_left, i.reason, i.outcome, i.result_digest, i.stored_at"
        : "NULL AS budget_left, NULL AS reason, NULL AS outcome, NULL AS result_digest, NULL AS stored_at";
      const rows = this.#db
        .query(
          `SELECT i.request_id, i.action, i.run_id, i.stop_generation, i.issued_at, ${fields}
           FROM instructions i JOIN runs r ON r.run_id = i.run_id
           WHERE r.state NOT IN ('finalized', 'not_started') AND (
             (i.action IN ('task_start', 'session_start') AND r.stop_receipt_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.run_id = i.run_id))
             OR (i.action IN ('task_cancel', 'session_stop') AND r.stop_receipt_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.instruction_request_id = i.request_id AND d.action = 'receipt_accepted'))
             OR (i.action = 'result_finalize'
               AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.instruction_request_id = i.request_id AND d.action = 'receipt_cleaned')))
           ORDER BY r.queue_seq, CASE i.action WHEN 'task_start' THEN 0 WHEN 'session_start' THEN 0 WHEN 'result_finalize' THEN 2 ELSE 1 END,
             i.issued_at, i.request_id`,
        )
        .all() as UnansweredRow[];
      const instructions = rows.map((row): UnansweredInstruction => {
        const run = this.#runRow(row.run_id) as RunRow;
        return {
          requestId: row.request_id,
          action: row.action,
          runId: row.run_id,
          runGeneration: safe(run.run_generation, "run_generation"),
          executorId: run.executor_id,
          runState: run.state,
          stopGeneration: safe(row.stop_generation, "instructions.stop_generation"),
          issuedAt: safe(row.issued_at, "instructions.issued_at"),
          rebuild: rebuildOf(row, run),
        };
      });
      return { stopGeneration: this.#stopRow()?.generation ?? null, instructions };
    });
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
  // 줄을 지우는 곳은 같은 관측을 새 번호로 바꿔 적는 #hold뿐이다. 그래서 한 번 적힌 실행 ID는 계속 시작하지 못한다.
  holdSlots(key: symbol, observations: readonly SlotHoldObservation[], now: number): { ok: true; holds: SlotHold[] } | Refused {
    if (key !== RESTORE_KEY) throw new TypeError("점유 차단은 재시작 복원만 적는다");
    const when = time(now, "now");
    return this.#write("slot_hold", "continue", () => {
      // for…of는 배열의 빈 자리도 undefined로 돌아 #hold에서 던지고 거래 전체가 되돌아간다. map은 빈 자리를 건너뛰어 일부만 적고 성공을 낸다.
      const holds: SlotHold[] = [];
      for (const seen of observations) holds.push(this.#hold(seen, when));
      return { ok: true as const, holds };
    });
  }

  // 점유 관측 하나를 적는 자리(holdSlots, 닫힌 실행의 늦은 시작 영수증). 같은 (실행기, 실행, 세대)의 줄은 새 번호로 바꿔 적고,
  // 앞 줄이 슬롯을 막고 있었으면 계속 막는다.
  #hold(seen: SlotHoldObservation, when: number): SlotHold {
    const before = this.#db.query("SELECT holds_slot FROM slot_holds WHERE executor_id = ? AND run_id = ? AND run_generation = ?").get(seen.executorId, seen.runId, seen.runGeneration) as {
      holds_slot: number;
    } | null;
    const holdsSlot = seen.holdsSlot || before?.holds_slot === 1;
    this.#db.query("DELETE FROM slot_holds WHERE executor_id = ? AND run_id = ? AND run_generation = ?").run(seen.executorId, seen.runId, seen.runGeneration);
    const row = this.#db
      .query("INSERT INTO slot_holds (executor_id, run_id, kind, run_generation, holds_slot, why, held_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING observation")
      .get(seen.executorId, seen.runId, seen.kind, seen.runGeneration, holdsSlot ? 1 : 0, seen.why, when) as { observation: number };
    return { ...seen, holdsSlot, observation: safe(row.observation, "slot_holds.observation") };
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
  // 닫기 근거가 있는 not_started 실행(#closedAfterStart)의 시작 영수증은 겹침의 증거라 답에 경보(alarm)를 싣는다. 경보가 없는 답의 꼴은 그대로다.
  applyReceipt(input: ReceiptInput, from: EnvelopeFrom): { ok: true; delivery: Delivery; ack: string; alarm?: ReceiptAlarm } | Refused {
    const r = validateReceipt(input);
    const sender = validateFrom(from);
    return this.#write("receipt", "continue", () => {
      const runId = r.action === "receipt_session_takeover" ? r.previousRunId : r.runId;
      const row = this.#runRow(runId);
      if (row === null) throw new Refuse("unknown_run");
      if (r.action === "receipt_session_takeover") this.#requireTakeoverSender(row, r.receiptId, sender);
      else this.#requireSender(row, sender);
      const seen = this.#redelivery(r.receiptId, r.bodyDigest, r.now);
      // 닫힌 실행의 시작 영수증은 실행 줄에 연결된 첫 시작 영수증(started_receipt_id) 밖이면 모두 경보다. 앞의 답(경보)을 잃었을 수 있어
      // 그 재전송에도 싣는다. 닫은 뒤에 처음 온 것은 그 칸에 적지 않는다(#effect). D-90 닫기는 받은 기록이 0줄일 때만 닫아 그 칸이 늘
      // 비어 있다. 관리자 닫기는 시작 영수증을 받은 실행도 닫으므로, 그 칸의 영수증의 재전송(ack를 잃은 실행기)은 경보 없이 다시 ack한다.
      // 함정: 같은 시작 지시에 다른 ID로 닫기 전에 받은 두 번째 시작 영수증도 재전송에 경보가 난다. 그 영수증을 처음 받은 것이 닫기 전인지
      // 뒤인지는 칸으로 가를 수 없다: deliveries에는 받은 순서의 칸이 없고, received_at과 근거의 closed_at은 부르는 쪽이 넘긴 시각이라
      // 같은 밀리초나 뒤로 간 시계에서 순서를 말하지 않는다. 틀리면 경보가 빠지는 쪽보다 남는 쪽을 고른다.
      const lateStart = r.action === "receipt_started" && r.receiptId !== row.started_receipt_id && this.#closedAfterStart(row);
      const alarm: { alarm?: ReceiptAlarm } = lateStart ? { alarm: "closed_run_started" } : {};
      if (seen === "duplicate") return { ok: true as const, delivery: "duplicate" as const, ack: r.receiptId, ...alarm };
      if (seen !== null) return seen;
      const instructionRequestId = "instructionRequestId" in r ? r.instructionRequestId : undefined;
      if (instructionRequestId !== undefined) this.#instruction(instructionRequestId, row.run_id, r.action === "receipt_accepted" ? [r.instruction] : r.action === "receipt_started" ? ["task_start", "session_start"] : ["result_finalize"]);
      this.#insertDelivery(r.receiptId, r.action, runId, r.bodyDigest, r.now, { instructionRequestId });
      this.#faults.at("receipt:after_insert");
      this.#effect(row, r, sender);
      return { ok: true as const, delivery: "new" as const, ack: r.receiptId, ...alarm };
    });
  }

  #instruction(requestId: string, runId: string, actions: readonly string[]): void {
    const found = this.#db.query("SELECT action FROM instructions WHERE request_id = ? AND run_id = ?").get(requestId, runId) as { action: string } | null;
    if (found === null || !actions.includes(found.action)) throw new Refuse("unknown_instruction");
  }

  #effect(row: RunRow, r: ReceiptInput, from: EnvelopeFrom): void {
    // 닫기 근거가 있는 not_started 실행에 늦게 온 영수증: 받은 기록(위의 deliveries 줄)만 남기고 상태·증거 칸은 바꾸지 않는다(되살리지 않는다).
    // 접수·종료 영수증은 띄운 것이 없다는 말이라 ack만 받는다. 시작 영수증은 그 실행이 실제로 떴다는 말이라 그 종류의 자리를 다시 막는다:
    // 자리를 푼 뒤 같은 종류의 다른 실행이 시작됐을 수 있다(겹침). 막은 줄은 clearSlotHold로만 풀린다.
    // 이 처리는 그 실행 자신의 세 영수증에만 건다. 세션 인수 영수증은 닫힌 작업자를 앞 실행으로 가리켜도 아래의 종류 검사로 가야 하고,
    // 정리 영수증은 닫힌 실행에 확정 지시가 없어 여기 오기 전에 거절된다.
    if (CLOSED_RUN_RECEIPTS.includes(r.action) && this.#closedAfterStart(row)) {
      if (r.action === "receipt_started") this.#hold({ executorId: row.executor_id, runId: row.run_id, kind: row.kind, runGeneration: row.run_generation, holdsSlot: true, why: "ended_in_ledger" }, r.now);
      return;
    }
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
        // exit는 종료 확인과 같은 UPDATE에서만 적힌다(판 8의 트리거). 실패 확정의 outcome이 이 값을 읽는다(failedStop).
        const evidence = this.#stopExitColumn ? { stop_receipt_id: r.receiptId, stop_exit: r.exit } : { stop_receipt_id: r.receiptId };
        this.#setState(row, r.exit === "completed" ? "checking" : "failed_stopped", r.now, evidence);
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
      // 닫기 근거가 있는 not_started 실행의 늦은 보고는 적고 ack하되 반영하지 않는다: 적자마자 마친 것으로 두고(applied_at) 실행 줄은 그대로다.
      // 거절하면 실행기가 영영 다시 보내고, 미반영으로 두면 반영할 곳이 없는 보고가 pendingReports와 복원 3단계에 영영 남는다.
      const disposition = this.#closedAfterStart(row) ? "settled" : resultDigest === null ? "pending" : this.#resultDisposition(row, reportId, resultDigest, now);
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

  // 그 실행의 결과가 저장 자리와 함께 반영됐는가(확정의 전제, life-loop.md "확정"). 실행 줄에 결과 digest가 있고, 그 실행의 결과 보고
  // 가운데 반영됐고(applied_at) 저장 자리가 있고 digest가 실행 줄의 result_digest와 같은 것이 있을 때만 값이다. 아니면 null(없는 실행 포함).
  // 상태는 보지 않는다: result_digest는 markResult가 ready_result로 판정할 때만 생기고 그 뒤 상태(cleanup_pending·finalized)에도 남는다.
  // 같은 결과의 보고가 둘 이상이면 먼저 적은 것(받은 시각, id 차례)이다. 실행 줄과 보고를 한 읽기에서 대조한다. 장부를 바꾸지 않는다.
  settledResult(runId: string): Read<SettledResult | null> {
    return this.#read(() => {
      const row = this.#runRow(runId);
      if (row === null || row.result_digest === null) return null;
      const report = this.#db
        .query(
          "SELECT stored_ref, received_at FROM deliveries WHERE run_id = ? AND action = 'report_result' AND applied_at IS NOT NULL AND stored_ref IS NOT NULL AND result_digest = ? ORDER BY received_at, id LIMIT 1",
        )
        .get(runId, row.result_digest) as { stored_ref: string; received_at: number } | null;
      if (report === null) return null;
      return { runId, resultDigest: row.result_digest, storedRef: report.stored_ref, storedAt: safe(report.received_at, "deliveries.received_at") };
    });
  }

  // failed_stopped 작업자 실행의 확정 본문을 정할 사실(FailedStop). 실행 줄, 그 종료 확인 영수증, 취소 지시를 한 읽기에서 본다.
  // 없는 실행이거나 지금 failed_stopped가 아니면 null이다. 있는 칸만 읽고 장부를 바꾸지 않는다.
  failedStop(runId: string): Read<FailedStop | null> {
    return this.#read(() => {
      const row = this.#runRow(runId);
      if (row === null || row.kind !== "worker" || row.state !== "failed_stopped" || row.stop_receipt_id === null) return null;
      const receipt = this.#db.query("SELECT received_at FROM deliveries WHERE id = ? AND run_id = ? AND action = 'receipt_stopped'").get(row.stop_receipt_id, runId) as {
        received_at: number;
      } | null;
      const reasons = (
        this.#db.query(`SELECT ${this.#rebuildColumns ? "reason" : "NULL AS reason"} FROM instructions WHERE run_id = ? AND action = 'task_cancel'`).all(runId) as { reason: string | null }[]
      ).map((cancel) => cancel.reason);
      const requestedCancel = reasons.includes("requested") ? true : reasons.includes(null) ? null : false;
      const { stoppedAt, exit } = stopFacts(row, receipt);
      return { runId, stoppedAt, requestedCancel, exit };
    });
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
