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
export const ADMIN_COMMANDS = ["status", "test-job"] as const;
export type AdminCommand = (typeof ADMIN_COMMANDS)[number];

// 시험 작업 넣기(test-job, D-98·D-101)의 칸. 차례는 관리 진입점의 argv 차례다. 값의 꼴은 감독이 장부의 규칙으로 본다
// (supervisor/admin/test-job.ts). 이 파일은 장부를 import하지 않으므로 여기서는 칸의 이름과 수만 정한다.
export const TEST_JOB_FIELDS = ["owner", "key", "role", "purpose", "sourceRef", "inputDigest"] as const;
export type TestJobField = (typeof TEST_JOB_FIELDS)[number];
export type TestJobRequest = { readonly [Field in TestJobField]: string };
// 관리 진입점이 요청 한 줄로 보낼 말. status는 칸이 없다.
export type AdminCall = { readonly command: "status" } | { readonly command: "test-job"; readonly job: TestJobRequest };
// 시험 작업의 답: created는 이 요청이 새 줄을 적었다, existing은 같은 소유자·키·내용의 줄이 이미 있어 적지 않았다.
export const TEST_JOB_OUTCOMES = ["created", "existing"] as const;
export type TestJobOutcome = (typeof TEST_JOB_OUTCOMES)[number];
// 관리 진입점이 시험 작업을 받았을 때 stdout에 쓰는 한 줄의 판. 칸을 바꾸면 판을 올린다.
export const TEST_JOB_SCHEMA = "olive-test-job/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
// 요청을 처리하지 않은 사유. 어느 사유든 장부에 새로 적힌 것이 없다. disabled부터 뒤 아홉은 시험 작업의 것이다(README "감독 관리 통로").
export const REFUSED_REASONS = [
  "malformed",
  "unknown_command",
  "busy",
  "disabled",
  "not_alive",
  "stopped",
  "intake_closed",
  "limit",
  "late",
  "conflict",
  "invariant_violation",
  "ledger_refused",
] as const;
export type RefusedReason = (typeof REFUSED_REASONS)[number];

export type AdminReply =
  | { readonly kind: "status"; readonly status: SupervisorStatus }
  | { readonly kind: "test_job"; readonly outcome: TestJobOutcome; readonly ref: string }
  | { readonly kind: "unknown"; readonly reason: UnknownReason }
  | { readonly kind: "refused"; readonly reason: RefusedReason };

// 요청의 명령 밖 칸. status는 받지 않는다. 받는 명령(test-job)은 자기 처리기에서 칸을 검사한다.
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

// 명령 이름만 주면 칸 없는 요청이다. 시험 작업의 칸은 TEST_JOB_FIELDS 차례로 하나씩 옮긴다(받은 객체를 펼치지 않는다).
export function encodeRequest(call: AdminCommand | AdminCall): string {
  if (typeof call === "string") return `${JSON.stringify({ command: call })}\n`;
  if (call.command === "status") return `${JSON.stringify({ command: "status" })}\n`;
  const body: Record<string, string> = { command: "test-job" };
  for (const field of TEST_JOB_FIELDS) body[field] = call.job[field];
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

export function encodeReply(reply: AdminReply): string {
  let body: string;
  if (reply.kind === "status") body = `{"reply":"status","status":${statusLine(reply.status)}}`;
  else if (reply.kind === "test_job") body = JSON.stringify({ reply: "test_job", outcome: reply.outcome, ref: reply.ref });
  else body = JSON.stringify({ reply: reply.kind, reason: reply.reason });
  return `${body}\n`;
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
  if (!exactKeys(value, ["reply", "reason"])) return null;
  if (value.reply === "unknown" && (UNKNOWN_REASONS as readonly unknown[]).includes(value.reason)) return { kind: "unknown", reason: value.reason as UnknownReason };
  if (value.reply === "refused" && (REFUSED_REASONS as readonly unknown[]).includes(value.reason)) return { kind: "refused", reason: value.reason as RefusedReason };
  return null;
}
