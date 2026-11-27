// 감독 관리 통로의 말(D-60·D-101). 관리 진입점(src/main/admin.ts)이 감독 컨테이너 안의 경로 유닉스 소켓에 붙어 요청 한 줄을 쓰고
// 답 한 줄을 읽는다. 두 쪽이 이 파일 하나의 꼴을 쓴다. 설명은 README "감독 관리 통로"다.
// 이 파일은 장부·박자·연결 서버를 import하지 않는다: 관리 진입점이 끌어오는 감독 쪽 코드는 이 파일과 client.ts뿐이다.

// 감독 컨테이너 안의 고정 경로. 차트가 감독 컨테이너에만 붙인 /tmp emptyDir(이미지가 쓰는 유일한 자리) 아래다. 환경으로 받지 않는다:
// 관리 진입점은 kubectl exec로 고정 argv만 받으므로 두 쪽이 같은 값을 코드에서 읽어야 한다.
export const ADMIN_SOCKET_PATH = "/tmp/olive-admin.sock";
// 감독과 kubectl exec로 들어온 관리 진입점은 같은 컨테이너의 같은 uid다. 그 밖의 uid는 붙지 못한다.
export const ADMIN_SOCKET_MODE = 0o600;

// 상한 표(README "감독 관리 통로"와 같다).
export const ADMIN_LIMITS = {
  // 요청 한 줄(줄바꿈 포함)의 상한. 넘으면 감독은 답하지 않고 닫는다.
  requestMaxBytes: 1_024,
  // 답 한 줄(줄바꿈 포함)의 상한. homelab CLI가 받는 진입점 출력의 상한(4,096바이트)과 같다.
  replyMaxBytes: 4_096,
  // 관리 진입점: 붙기 전에 정한 절대 기한. 답 한 줄을 받는 순간의 단조 시각으로 판정한다. CLI의 kubectl 요청 상한(20초)보다 짧게.
  clientWaitMs: 5_000,
  // 감독: 연결을 받은 순간부터 요청 한 줄을 다 받기까지. 받는 순간의 단조 시각으로 판정한다.
  serverWaitMs: 2_000,
  // 감독: 답을 쓰기 시작한 순간부터 다 쓰기까지. 상대가 받지 않아(drain이 오지 않아) 남은 바이트와 연결 자리를 쥐는 상한이다.
  // drain·타이머를 받는 순간의 단조 시각으로 판정한다. 요청 받기와 합쳐도 진입점의 기한(clientWaitMs)보다 짧다.
  serverWriteWaitMs: 2_000,
  // 감독이 동시에 쥐는 관리 연결의 상한. 넘친 연결에는 busy를 답하고 닫는다.
  maxConnections: 4,
} as const;

// homelab CLI(cli/src/core/olive-admin.ts)가 검사하는 상태 꼴. 칸을 바꾸면 판을 올린다(감독 이미지와 CLI는 따로 배포된다).
export const STATUS_SCHEMA = "olive-supervisor-status/v1";
// CLI가 받는 수의 상한(미만). 이 이상이면 상태를 내지 않고 모름이다.
export const STATUS_MAX_COUNT = 1_000_000;

// 관리 명령. 새 명령은 이 표와 commands.ts의 처리기 표에 함께 더한다.
export const ADMIN_COMMANDS = ["status", "test-job", "holds", "close-unconfirmed", "abandon-result", "close-store-reset", "release-hold"] as const;
export type AdminCommand = (typeof ADMIN_COMMANDS)[number];

// 자리 풀기(D-149 ④, D-156)의 쓰기 명령과 칸. 장부 쓰기마다 명령 하나다: 관리자 닫기(closeRunByOperator, pod_replaced), 결과 포기
// (abandonResult), 저장소 비움 닫기(closeRunByOperator, store_reset), 점유 관측 풀기(releaseSlotHold). 칸의 차례는 관리 진입점의 argv
// 차례이고, 칸 이름은 장부 연산의 입력 이름 그대로다(CLI·통로·장부가 같은 이름을 쓴다). 확인 방법(checkedBy)은 명령이 정하고 시각(now)은
// 감독이 읽으므로 칸이 아니다. 값은 모두 문자열로 싣고 감독이 장부의 꼴로 본다(release.ts). 이 파일은 장부를 import하지 않는다.
// fromState는 장부 입력이 아니다: 두 닫기에서 CLI가 holds로 본 앞 상태(그 줄의 state)이고, 감독이 쓰기 직전 같은 동기 구간에서 지금
// 줄과 견준다(다르면 state_changed, D-156의 재조회). 근거 줄의 fromState와 같은 이름이다. 결과 포기는 종료 영수증 ID, 점유 관측 풀기는
// 관측 번호·세대로 이미 그 줄에 묶여 장부가 거절한다.
export const RELEASE_COMMANDS = ["close-unconfirmed", "abandon-result", "close-store-reset", "release-hold"] as const;
export type ReleaseCommand = (typeof RELEASE_COMMANDS)[number];
export const RELEASE_FIELDS: { readonly [Command in ReleaseCommand]: readonly string[] } = {
  "close-unconfirmed": ["runId", "fromState", "podName", "podStartedAt"],
  "abandon-result": ["runId", "reason", "stopReceiptId"],
  "close-store-reset": ["runId", "fromState", "podName", "podStartedAt"],
  "release-hold": ["executorId", "runId", "runGeneration", "observation", "podName", "podStartedAt"],
};
export const isReleaseCommand = (value: unknown): value is ReleaseCommand => typeof value === "string" && (RELEASE_COMMANDS as readonly string[]).includes(value);

// 시험 작업 넣기(test-job, D-98·D-101)의 칸. 차례는 관리 진입점의 argv 차례다. 값의 꼴은 감독이 장부의 규칙으로 본다
// (supervisor/admin/test-job.ts). 이 파일은 장부를 import하지 않으므로 여기서는 칸의 이름과 수만 정한다.
export const TEST_JOB_FIELDS = ["owner", "key", "role", "purpose", "sourceRef", "inputDigest"] as const;
export type TestJobField = (typeof TEST_JOB_FIELDS)[number];
export type TestJobRequest = { readonly [Field in TestJobField]: string };
// 관리 진입점이 요청 한 줄로 보낼 말. status·holds는 칸이 없다. 자리 풀기 쓰기의 fields는 RELEASE_FIELDS의 칸 이름 → 값이다.
export type AdminCall =
  | { readonly command: "status" }
  | { readonly command: "holds" }
  | { readonly command: "test-job"; readonly job: TestJobRequest }
  | { readonly command: ReleaseCommand; readonly fields: Readonly<Record<string, string>> };
// 시험 작업의 답: created는 이 요청이 새 줄을 적었다, existing은 같은 소유자·키·내용의 줄이 이미 있어 적지 않았다.
export const TEST_JOB_OUTCOMES = ["created", "existing"] as const;
export type TestJobOutcome = (typeof TEST_JOB_OUTCOMES)[number];
// 관리 진입점이 시험 작업을 받았을 때 stdout에 쓰는 한 줄의 판. 칸을 바꾸면 판을 올린다.
export const TEST_JOB_SCHEMA = "olive-test-job/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 실행기 ID의 꼴. 장부의 REF(ledger/input.ts)와 같다(시험이 대조한다).
const EXECUTOR_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,199}$/;

// 관리 진입점이 holds·자리 풀기를 받았을 때 stdout에 쓰는 한 줄의 판. 칸을 바꾸면 판을 올린다(CLI는 따로 배포된다).
export const HOLDS_SCHEMA = "olive-holds/v1";
export const RELEASE_SCHEMA = "olive-release/v1";
// 장부의 실행 상태(ledger/states.ts의 LEDGER_RUN_STATES와 같은 차례, 시험이 대조한다).
export const RUN_STATES = ["queued", "preparing", "running", "stopping", "checking", "ready_result", "finalized", "not_started", "failed_stopped", "unknown_running", "cleanup_pending"] as const;
export type RunState = (typeof RUN_STATES)[number];
export const RUN_KINDS = ["worker", "session"] as const;
// holds가 자리를 쥔 줄마다 싣는 다음 행동(release.ts의 nextFor가 장부의 앞 상태로 정한다). close_unconfirmed: 파드를 바꾼 뒤
// close-unconfirmed, abandon_result: abandon-result(결과를 버린다), wait_cleanup: 확정·정리 영수증을 기다린다(실행기가 영영 돌아오지
// 않으면 저장소를 비운 뒤 close-store-reset), close_store_reset: 실패 시각은 있으나 확정 outcome을 장부 사실로 정할 수 없는 failed_stopped
// (수명 박자의 finalize_withheld/outcome_unknown과 같은 계산)라 기다려도 확정·정리가 오지 않는다. D-158의 전제(실행기 저장소 비움·작업자
// 파드 교체)를 확인한 뒤 close-store-reset, release_hold: 파드를 바꾼 뒤 release-hold, none: 이 통로의 명령이 없다(진행 중이거나 장부 초기화).
export const HOLD_ACTIONS = ["close_unconfirmed", "abandon_result", "wait_cleanup", "close_store_reset", "release_hold", "none"] as const;
export type HoldAction = (typeof HOLD_ACTIONS)[number];
export interface HoldRun {
  readonly runId: string;
  readonly kind: (typeof RUN_KINDS)[number];
  readonly state: RunState;
  readonly executorId: string;
  readonly runGeneration: number;
  readonly accepted: boolean;
  readonly finalizeSent: boolean;
  readonly closableAt: number | null;
  readonly stopReceiptId: string | null;
  readonly next: HoldAction;
}
export interface HoldObservation {
  readonly observation: number;
  readonly executorId: string;
  readonly runId: string;
  readonly kind: (typeof RUN_KINDS)[number];
  readonly runGeneration: number;
  readonly why: string;
  readonly heldAt: number;
  readonly next: "release_hold";
}
// slotFree: 새 작업자 실행이 자리를 받을 수 있는가. truncated: 답 한 줄 상한(4,096바이트) 때문에 뒤의 줄을 뺐다.
export interface Holds {
  readonly slotFree: boolean;
  readonly runs: readonly HoldRun[];
  readonly slotHolds: readonly HoldObservation[];
  readonly truncated: boolean;
}
// 자리 풀기 쓰기의 답. outcome: closed(관리자 닫기·저장소 비움 닫기), abandoned(결과 포기), hold_released(점유 관측 풀기).
// released: 이 쓰기의 대상(실행 줄, 점유 관측)이 작업자 자리를 놓았다. 결과 포기는 false다(failed_stopped는 확정·정리 영수증 뒤에 놓는다).
// slotFree: 쓰기 뒤에 읽은 "작업자 자리를 쓸 수 있다". 다른 실행·점유 관측이 막으면 released가 true여도 false다. 읽지 못하면 null.
export const RELEASE_OUTCOMES = ["closed", "abandoned", "hold_released"] as const;
export type ReleaseOutcome = (typeof RELEASE_OUTCOMES)[number];
// 쓰기 명령마다 성공 답이 가질 outcome·released. 관리 진입점이 답을 요청과 대조한다(client.ts의 exitFor): 다르면 적혔는지 모른다.
export const RELEASE_EXPECTED: { readonly [Command in ReleaseCommand]: { readonly outcome: ReleaseOutcome; readonly released: boolean } } = {
  "close-unconfirmed": { outcome: "closed", released: true },
  "abandon-result": { outcome: "abandoned", released: false },
  "close-store-reset": { outcome: "closed", released: true },
  "release-hold": { outcome: "hold_released", released: true },
};
export interface ReleaseAnswer {
  readonly outcome: ReleaseOutcome;
  readonly runId: string;
  readonly released: boolean;
  readonly slotFree: boolean | null;
}

export interface SupervisorStatus {
  readonly alive: boolean;
  readonly queued: number;
  readonly running: number;
  readonly diagnosis: "active" | "paused";
  readonly stop: "none" | "stopping" | "stopped";
  readonly stopGeneration: number;
  readonly intakeOpen: boolean;
}

// 모르는 사유. 감독은 답했지만 상태를 알려진 값으로 내지 못한다. 시험 작업에서는 write_unknown만 "장부에 적혔는지 모른다"이고,
// 나머지는 쓰기를 부르기 전에 멈췄다는 뜻이다(random_unavailable: 참조 후보·호출 ID를 만들지 못했다).
export const UNKNOWN_REASONS = ["restore_not_done", "ledger_unreadable", "stop_unrecorded", "clock_unavailable", "out_of_range", "read_threw", "random_unavailable", "write_unknown"] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];
// 요청을 처리하지 않은 사유. 어느 사유든 장부에 새로 적힌 것이 없다. disabled부터 ledger_refused까지는 시험 작업의 것이고, 자리 풀기는
// 그 가운데 disabled(포트 없음)·not_alive·late·ledger_refused를 같은 뜻으로 쓴다. pod_started_later·state_changed는 자리 풀기만 낸다(README "감독 관리 통로").
export const REFUSED_REASONS = [
  "malformed",
  "unknown_command",
  "busy",
  "disabled",
  "not_alive",
  "stopped",
  "intake_closed",
  "owner_inactive",
  "limit",
  "late",
  "conflict",
  "invariant_violation",
  "ledger_refused",
  // 자리 풀기: 넘긴 파드가 뜬 시각이 감독 시계의 지금보다 늦다(시계 어긋남이거나 잘못 읽은 값). 장부를 부르지 않는다.
  "pod_started_later",
  // 자리 풀기의 두 닫기: 쓰기 직전에 읽은 실행 줄의 상태가 요청의 fromState(CLI가 holds로 본 앞 상태)와 다르다. 장부를 부르지 않는다.
  // CLI는 holds를 다시 읽고 절차를 다시 고른다.
  "state_changed",
] as const;
export type RefusedReason = (typeof REFUSED_REASONS)[number];

// 장부의 거절 이름(ledger/ledger.ts의 REFUSALS와 같은 차례, 시험이 대조한다). 자리 풀기는 장부가 거절하면 이 이름을 refusal 칸에 그대로
// 싣는다(reason은 ledger_refused). 통로의 사유와 칸을 나눈 까닭: stopped·intake_closed·invariant_violation처럼 같은 글자가 통로와 장부에서
// 뜻이 다르다.
export const LEDGER_REFUSALS = [
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
  "run_not_worker",
  "run_ended",
  "stop_confirmed",
  "start_may_launch",
  "pod_started_too_early",
  "not_checking",
  "stop_unconfirmed",
  "slot_not_held",
  "report_pending",
  "outcome_unknown",
  "failed_at_unknown",
] as const;
export type LedgerRefusal = (typeof LEDGER_REFUSALS)[number];

// refused의 refusal은 자리 풀기 쓰기를 장부가 거절했을 때만 있다(reason은 늘 ledger_refused). 시험 작업의 ledger_refused에는 없다.
export type AdminReply =
  | { readonly kind: "status"; readonly status: SupervisorStatus }
  | { readonly kind: "test_job"; readonly outcome: TestJobOutcome; readonly ref: string }
  | { readonly kind: "holds"; readonly holds: Holds }
  | { readonly kind: "release"; readonly release: ReleaseAnswer }
  | { readonly kind: "unknown"; readonly reason: UnknownReason }
  | { readonly kind: "refused"; readonly reason: RefusedReason; readonly refusal?: LedgerRefusal };

// 요청의 명령 밖 칸. status·holds는 받지 않는다. 받는 명령(test-job, 자리 풀기 쓰기)은 자기 처리기에서 칸을 검사한다.
export type AdminArgs = Readonly<Record<string, unknown>>;
export type AdminRequest = { readonly ok: true; readonly command: AdminCommand; readonly args: AdminArgs } | { readonly ok: false; readonly reason: "malformed" | "unknown_command" };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCommand = (value: unknown): value is AdminCommand => typeof value === "string" && (ADMIN_COMMANDS as readonly string[]).includes(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < STATUS_MAX_COUNT;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

// 줄 하나를 JSON 객체로. 줄바꿈이 든 줄, 객체가 아닌 값은 null이다.
function objectOf(line: string): Record<string, unknown> | null {
  if (line.includes("\n")) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return isRecord(value) ? value : null;
}

// 명령 이름만 주면 칸 없는 요청이다. 시험 작업의 칸은 TEST_JOB_FIELDS 차례로, 자리 풀기의 칸은 RELEASE_FIELDS 차례로 하나씩 옮긴다
// (받은 객체를 펼치지 않는다).
export function encodeRequest(call: AdminCommand | AdminCall): string {
  if (typeof call === "string") return `${JSON.stringify({ command: call })}\n`;
  if (call.command === "status" || call.command === "holds") return `${JSON.stringify({ command: call.command })}\n`;
  const body: Record<string, string> = { command: call.command };
  if (call.command === "test-job") for (const field of TEST_JOB_FIELDS) body[field] = call.job[field];
  else for (const field of RELEASE_FIELDS[call.command]) body[field] = call.fields[field]!;
  return `${JSON.stringify(body)}\n`;
}

// 요청 한 줄(줄바꿈 뺀 것). command 칸이 문자열이 아니면 malformed, 모르는 이름이면 unknown_command다.
export function parseRequest(line: string): AdminRequest {
  const value = objectOf(line);
  if (value === null || typeof value.command !== "string") return { ok: false, reason: "malformed" };
  if (!isCommand(value.command)) return { ok: false, reason: "unknown_command" };
  const args = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "command"));
  return { ok: true, command: value.command, args };
}

// 상태 칸을 CLI의 규칙으로 본다(칸 여덟, 수는 0 이상 상한 미만의 정수, 좁은 enum).
export function validStatus(value: unknown): value is SupervisorStatus {
  if (!isRecord(value)) return false;
  return (
    typeof value.alive === "boolean" &&
    isCount(value.queued) &&
    isCount(value.running) &&
    (value.diagnosis === "active" || value.diagnosis === "paused") &&
    (value.stop === "none" || value.stop === "stopping" || value.stop === "stopped") &&
    Number.isSafeInteger(value.stopGeneration) &&
    (value.stopGeneration as number) >= 0 &&
    typeof value.intakeOpen === "boolean"
  );
}

// CLI가 읽는 상태 한 줄(줄바꿈 없음). 칸의 차례는 CLI의 STATUS_FIELDS와 같다. 받은 값을 펼치지 않고 칸마다 옮긴다(다른 칸이 실리지 않게).
export function statusLine(status: SupervisorStatus): string {
  return JSON.stringify({
    schema: STATUS_SCHEMA,
    alive: status.alive,
    queued: status.queued,
    running: status.running,
    diagnosis: status.diagnosis,
    stop: status.stop,
    stopGeneration: status.stopGeneration,
    intakeOpen: status.intakeOpen,
  });
}

// 관리 진입점이 stdout에 쓰는 시험 작업 한 줄(줄바꿈 없음).
export function testJobLine(reply: { readonly outcome: TestJobOutcome; readonly ref: string }): string {
  return JSON.stringify({ schema: TEST_JOB_SCHEMA, outcome: reply.outcome, ref: reply.ref });
}

// 관리 진입점이 stdout에 쓰는 holds 한 줄(줄바꿈 없음). 받은 값을 펼치지 않고 칸마다 옮긴다(다른 칸이 실리지 않게).
export function holdsLine(holds: Holds): string {
  return JSON.stringify({
    schema: HOLDS_SCHEMA,
    slotFree: holds.slotFree,
    runs: holds.runs.map((run) => ({
      runId: run.runId,
      kind: run.kind,
      state: run.state,
      executorId: run.executorId,
      runGeneration: run.runGeneration,
      accepted: run.accepted,
      finalizeSent: run.finalizeSent,
      closableAt: run.closableAt,
      stopReceiptId: run.stopReceiptId,
      next: run.next,
    })),
    slotHolds: holds.slotHolds.map((hold) => ({
      observation: hold.observation,
      executorId: hold.executorId,
      runId: hold.runId,
      kind: hold.kind,
      runGeneration: hold.runGeneration,
      why: hold.why,
      heldAt: hold.heldAt,
      next: hold.next,
    })),
    truncated: holds.truncated,
  });
}

// 관리 진입점이 stdout에 쓰는 자리 풀기 한 줄(줄바꿈 없음).
export function releaseLine(answer: ReleaseAnswer): string {
  return JSON.stringify({ schema: RELEASE_SCHEMA, outcome: answer.outcome, runId: answer.runId, released: answer.released, slotFree: answer.slotFree });
}

export function encodeReply(reply: AdminReply): string {
  let body: string;
  if (reply.kind === "status") body = `{"reply":"status","status":${statusLine(reply.status)}}`;
  else if (reply.kind === "test_job") body = JSON.stringify({ reply: "test_job", outcome: reply.outcome, ref: reply.ref });
  else if (reply.kind === "holds") body = `{"reply":"holds","holds":${holdsLine(reply.holds)}}`;
  else if (reply.kind === "release") body = `{"reply":"release","release":${releaseLine(reply.release)}}`;
  else if (reply.kind === "refused" && reply.refusal !== undefined) body = JSON.stringify({ reply: "refused", reason: reply.reason, refusal: reply.refusal });
  else body = JSON.stringify({ reply: reply.kind, reason: reply.reason });
  return `${body}\n`;
}

const isInt = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const oneOf = <T extends string>(value: unknown, list: readonly T[]): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

// holds 칸의 꼴. 하나라도 다르면 null이다. 칸마다 옮긴다.
function holdsOf(value: unknown): Holds | null {
  if (!isRecord(value) || !exactKeys(value, ["schema", "slotFree", "runs", "slotHolds", "truncated"]) || value.schema !== HOLDS_SCHEMA) return null;
  if (typeof value.slotFree !== "boolean" || typeof value.truncated !== "boolean" || !Array.isArray(value.runs) || !Array.isArray(value.slotHolds)) return null;
  const runs: HoldRun[] = [];
  for (const run of value.runs as unknown[]) {
    if (!isRecord(run) || !exactKeys(run, ["runId", "kind", "state", "executorId", "runGeneration", "accepted", "finalizeSent", "closableAt", "stopReceiptId", "next"])) return null;
    if (typeof run.runId !== "string" || !UUID.test(run.runId) || !oneOf(run.kind, RUN_KINDS) || !oneOf(run.state, RUN_STATES)) return null;
    if (typeof run.executorId !== "string" || !EXECUTOR_REF.test(run.executorId) || !isInt(run.runGeneration, 0)) return null;
    if (typeof run.accepted !== "boolean" || typeof run.finalizeSent !== "boolean" || !(run.closableAt === null || isInt(run.closableAt, 1))) return null;
    if (!(run.stopReceiptId === null || (typeof run.stopReceiptId === "string" && UUID.test(run.stopReceiptId))) || !oneOf(run.next, HOLD_ACTIONS)) return null;
    runs.push({
      runId: run.runId,
      kind: run.kind,
      state: run.state,
      executorId: run.executorId,
      runGeneration: run.runGeneration,
      accepted: run.accepted,
      finalizeSent: run.finalizeSent,
      closableAt: run.closableAt,
      stopReceiptId: run.stopReceiptId,
      next: run.next,
    });
  }
  const slotHolds: HoldObservation[] = [];
  for (const hold of value.slotHolds as unknown[]) {
    if (!isRecord(hold) || !exactKeys(hold, ["observation", "executorId", "runId", "kind", "runGeneration", "why", "heldAt", "next"])) return null;
    if (!isInt(hold.observation, 0) || typeof hold.executorId !== "string" || !EXECUTOR_REF.test(hold.executorId) || typeof hold.runId !== "string" || !UUID.test(hold.runId)) return null;
    if (!oneOf(hold.kind, RUN_KINDS) || !isInt(hold.runGeneration, 0) || typeof hold.why !== "string" || !/^[a-z_]{1,32}$/.test(hold.why) || !isInt(hold.heldAt, 0) || hold.next !== "release_hold") return null;
    slotHolds.push({ observation: hold.observation, executorId: hold.executorId, runId: hold.runId, kind: hold.kind, runGeneration: hold.runGeneration, why: hold.why, heldAt: hold.heldAt, next: "release_hold" });
  }
  return { slotFree: value.slotFree, runs, slotHolds, truncated: value.truncated };
}

// 자리 풀기 답 칸의 꼴. 하나라도 다르면 null이다.
function releaseOf(value: unknown): ReleaseAnswer | null {
  if (!isRecord(value) || !exactKeys(value, ["schema", "outcome", "runId", "released", "slotFree"]) || value.schema !== RELEASE_SCHEMA) return null;
  if (!oneOf(value.outcome, RELEASE_OUTCOMES) || typeof value.runId !== "string" || !UUID.test(value.runId) || typeof value.released !== "boolean") return null;
  if (!(value.slotFree === null || typeof value.slotFree === "boolean")) return null;
  return { outcome: value.outcome, runId: value.runId, released: value.released, slotFree: value.slotFree };
}

// 답 한 줄(줄바꿈 뺀 것). 꼴이 하나라도 다르면 null이다(모르는 칸, 모르는 사유, 판이 다른 상태).
export function parseReply(line: string): AdminReply | null {
  const value = objectOf(line);
  if (value === null) return null;
  if (value.reply === "status") {
    if (!exactKeys(value, ["reply", "status"]) || !isRecord(value.status)) return null;
    const status = value.status;
    if (!exactKeys(status, ["schema", "alive", "queued", "running", "diagnosis", "stop", "stopGeneration", "intakeOpen"]) || status.schema !== STATUS_SCHEMA) return null;
    if (!validStatus(status)) return null;
    // 칸마다 옮긴다(판 칸과 받은 객체를 싣지 않는다).
    return {
      kind: "status",
      status: {
        alive: status.alive,
        queued: status.queued,
        running: status.running,
        diagnosis: status.diagnosis,
        stop: status.stop,
        stopGeneration: status.stopGeneration,
        intakeOpen: status.intakeOpen,
      },
    };
  }
  if (value.reply === "test_job") {
    if (!exactKeys(value, ["reply", "outcome", "ref"])) return null;
    if (!(TEST_JOB_OUTCOMES as readonly unknown[]).includes(value.outcome) || typeof value.ref !== "string" || !UUID.test(value.ref)) return null;
    return { kind: "test_job", outcome: value.outcome as TestJobOutcome, ref: value.ref };
  }
  if (value.reply === "holds") {
    if (!exactKeys(value, ["reply", "holds"])) return null;
    const holds = holdsOf(value.holds);
    return holds === null ? null : { kind: "holds", holds };
  }
  if (value.reply === "release") {
    if (!exactKeys(value, ["reply", "release"])) return null;
    const release = releaseOf(value.release);
    return release === null ? null : { kind: "release", release };
  }
  if (value.reply === "refused" && value.reason === "ledger_refused" && exactKeys(value, ["reply", "reason", "refusal"])) {
    return oneOf(value.refusal, LEDGER_REFUSALS) ? { kind: "refused", reason: "ledger_refused", refusal: value.refusal } : null;
  }
  if (!exactKeys(value, ["reply", "reason"])) return null;
  if (value.reply === "unknown" && (UNKNOWN_REASONS as readonly unknown[]).includes(value.reason)) return { kind: "unknown", reason: value.reason as UnknownReason };
  if (value.reply === "refused" && (REFUSED_REASONS as readonly unknown[]).includes(value.reason)) return { kind: "refused", reason: value.reason as RefusedReason };
  return null;
}
