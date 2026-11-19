// 오케스트레이터 세션이 부르는 감독의 도구 넷(start_worker, worker_status, worker_result, cancel_worker)을 받는 순수 처리기.
// 후보다(O10이 소비하기 전). 도구의 입력·반환 세부는 O09·O10이 계약 파일로 정한다고만 설계에 있고(supervisor.md §4),
// 그 판을 언제 고정할지는 아직 정하지 않았다. 이 파일의 이름과 칸은 그 전까지 바뀔 수 있다.
//
// 상태를 갖지 않는다. 장부 읽기·쓰기와 역할 정책은 주입받은 포트로만 만나고, 시각은 문맥으로 받는다.
// 틀리는 방향은 늘 닫는 쪽이다.
// - 권한은 인자 밖의 문맥(인증된 세션·논리 요청·호출 ID)에서만 온다. 그런 칸이 인자에 오면 거절한다.
// - 남의 실행(참조·단계·결과)은 "없음"과 같은 거절로 답한다. 재시도 키 조회는 그 소유자의 줄만 돌려준다는 것이 포트의 전제이고,
//   남의 줄이 돌아오면 충돌이나 성공이 아니라 unknown이다.
// - 포트가 모른다고 답하거나 던지거나 정한 꼴 밖의 값을 내면 unknown이다. 빈 성공으로 바꾸지 않는다.
import { limits, type Result, type Role, ROLES } from "../../contract/v1/index.ts";
import { LEDGER_RUN_STATES, type LedgerRunState } from "../../ledger/index.ts";

export const TOOL_NAMES = ["start_worker", "worker_status", "worker_result", "cancel_worker"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// ---- 문맥: 처리기가 인자 밖에서 받는 것 ----

// 인증된 연결과 세션 쪽(U6/O10)이 채운다. 모델이 보낸 값을 여기에 넣지 않는다.
export interface ToolCallContext {
  readonly session: { readonly id: string; readonly generation: number };
  // 그 세션이 지금 처리 중인 논리 요청(장부 inputs의 요청 ID). 실행의 소유자다. 세션이 바뀌어도 같은 요청이면 같은 값이다.
  readonly requestId: string;
  readonly callId: string;
  readonly now: number;
  readonly stop: { readonly known: true; readonly stopped: boolean } | { readonly known: false };
}

// ---- 인자: 모델이 보내는 것 ----

export interface StartWorkerArgs {
  readonly role: Role;
  readonly task: {
    // 목적의 분류 코드. 역할과의 허용 조합은 정책 포트가 이 코드로만 판단한다.
    readonly purpose: string;
    // 목적의 자유 글. 어떤 판단(역할·우선순위·예산·권한·재시도 키)에도 쓰지 않는다.
    readonly brief: string;
    readonly source_ref: string;
    readonly input_digest: string;
  };
}

export interface RunRefArgs {
  readonly ref: string;
}

// ---- 응답 ----

// 모델에게 보이는 단계. 장부 상태 이름에 배정 전 대기 하나를 더했다.
// waiting_assignment: 맞는 실행기나 계정이 아직 없어 실행 줄(실행기·자격 참조)을 만들지 않은 접수다.
export const PHASES = ["waiting_assignment", ...LEDGER_RUN_STATES] as const;
export type Phase = "waiting_assignment" | LedgerRunState;

export const TOOL_REFUSALS = [
  // 문맥이나 설정이 꼴에 맞지 않는다(감독 쪽 결함). 모델의 잘못이 아니지만 아무것도 하지 않는다.
  "context_invalid",
  "unknown_tool",
  "stopped",
  "stop_unknown",
  // 문맥의 세션이 지금 살아 있는 세션·세대가 아니다(호출권을 거둔 세션).
  "session_retired",
  "forbidden_field",
  "unknown_field",
  "malformed_argument",
  "role_not_allowed",
  "purpose_not_allowed",
  "input_not_fixed",
  "retry_conflict",
  "intake_closed",
  // 없는 실행과 남의 실행을 구별하지 않는다.
  "not_found",
  "result_not_ready",
  "result_check_failed",
  "result_expired",
  "result_cleanup_pending",
  "already_ended",
] as const;
export type ToolRefusal = (typeof TOOL_REFUSALS)[number];

// 결과로 내주는 것. 계약 v1 결과에서 역할을 뺀 칸이다. 포트가 준 결과가 계약 v1 꼴(어느 깊이에도 더 붙은 칸 없음)일 때만
// 배열 원소까지 새 객체로 만들어 준다.
export type ResultSummary = Pick<Result, "outcome" | "summary" | "items" | "refs">;

export type ToolAnswer =
  | { readonly outcome: "ok"; readonly tool: "start_worker"; readonly ref: string; readonly phase: Phase }
  | { readonly outcome: "ok"; readonly tool: "worker_status"; readonly ref: string; readonly phase: Phase }
  | { readonly outcome: "ok"; readonly tool: "worker_result"; readonly ref: string; readonly result: ResultSummary }
  // 취소 접수는 완료가 아니다. phase는 접수한 그때의 단계다.
  | { readonly outcome: "ok"; readonly tool: "cancel_worker"; readonly ref: string; readonly cancel: "accepted"; readonly phase: Phase }
  // field는 거절의 원인이 된 인자 칸의 경로(모델이 보낸 이름)다. 칸과 무관한 거절이면 null.
  | { readonly outcome: "refused"; readonly tool: string; readonly reason: ToolRefusal; readonly field: string | null }
  | { readonly outcome: "unknown"; readonly tool: string };

// ---- 포트 ----

// 모름은 known: false 하나다. 이유를 모델에게 넘기지 않으므로 이유 칸이 없다.
export type Answer<T> = { readonly known: true; readonly value: T } | { readonly known: false };

// 재시도 키의 내용. 같은 키에 이 넷 가운데 하나라도 다르면 충돌이다(자유 글 brief는 넣지 않는다).
export interface StartContent {
  readonly role: Role;
  readonly purpose: string;
  readonly sourceRef: string;
  readonly inputDigest: string;
}

// 작업 요청 한 건. ref는 장부가 낸 불투명 UUID이고 배정 전 대기에서 실행이 된 뒤에도 같다.
export interface WorkRecord {
  readonly ref: string;
  // 이 요청을 낸 논리 요청 ID.
  readonly owner: string;
  readonly retryKey: string;
  readonly content: StartContent;
  readonly phase: Phase;
}

export interface StartRecordInput {
  readonly retryKey: string;
  readonly owner: string;
  readonly content: StartContent;
  readonly sessionId: string;
  readonly callId: string;
  readonly now: number;
}

// 같은 소유자의 같은 재시도 키가 이미 있으면 새 줄을 만들지 않고 그 줄을 돌려준다. 다른 소유자의 줄을 돌려주지 않는다
// (findByRetryKey의 전제). 처리기는 돌려받은 줄의 소유자와 내용을 다시 대조한다.
export type StartWrite = { readonly ok: true; readonly record: WorkRecord } | { readonly ok: false; readonly reason: "stopped" | "intake_closed" };

export interface CancelInput {
  readonly ref: string;
  readonly owner: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly now: number;
}
export type CancelWrite = { readonly ok: true; readonly phase: Phase } | { readonly ok: false; readonly reason: "already_ended" };

// 결과 쪽(S6)이 내준 확인. 이 처리기는 결과의 내용을 검증하지 않는다. 세 확인이 모두 true이고 결과가 계약 v1 꼴일 때만 내준다.
export type ResultView =
  | { readonly state: "none" }
  | {
      readonly state: "settled";
      readonly checksPassed: boolean;
      // 원문·결과가 만료되지 않았다.
      readonly valid: boolean;
      readonly cleanupPending: boolean;
      readonly result: Result | null;
    };

// 장부가 내줘야 하는 연산. 지금 장부(src/ledger)에 그대로 있는 것은 없다(PR 본문 "장부가 더 내줘야 하는 연산").
export interface ToolLedgerPort {
  // 지금 호출권을 가진 세션과 그 세대. 없으면 null.
  liveSession(): Answer<{ readonly id: string; readonly generation: number } | null>;
  // 이 원본 참조와 digest가 이 논리 요청의 고정된 입력인가.
  inputPinned(query: { readonly owner: string; readonly sourceRef: string; readonly inputDigest: string }): Answer<boolean>;
  // 전제: 재시도 키는 소유자(논리 요청)에 묶인다. 이 조회와 recordStart는 owner의 줄만 돌려주고, 다른 소유자의 줄은 없는 것으로 다룬다.
  // 처리기는 키에 요청 ID를 넣지만 장부가 키만으로 찾으면 이 전제가 깨진다. 깨진 줄이 돌아오면 처리기는 unknown으로 닫고 쓰지 않는다.
  findByRetryKey(query: { readonly owner: string; readonly retryKey: string }): Answer<WorkRecord | null>;
  // 소유자로 찾는 읽기. 처리기는 돌려받은 줄의 소유자를 다시 대조한다.
  readOwnedWork(query: { readonly owner: string; readonly ref: string }): Answer<WorkRecord | null>;
  readResult(ref: string): Answer<ResultView>;
  // 배정 전 대기의 기록. 실행기·자격 참조 없이 요청을 적는다.
  recordStart(input: StartRecordInput): Answer<StartWrite>;
  requestCancel(input: CancelInput): Answer<CancelWrite>;
}

export interface ToolPolicyPort {
  judge(role: Role, purpose: string): "allowed" | "role_not_allowed" | "purpose_not_allowed";
}

// 설정값(미확정 기본). 목적 자유 글의 길이 상한은 설계와 계약 v1에 없다. 코드에 기본값을 두지 않고 배포가 넣는다.
export interface ToolConfig {
  readonly purposeBriefMaxChars: number;
}

export interface ToolPorts {
  readonly ledger: ToolLedgerPort;
  readonly policy: ToolPolicyPort;
  readonly config: ToolConfig;
}

// ---- 꼴 ----

// uuid·sha256은 계약 v1과 장부, sourceRef는 장부의 원문 참조(<저장소 이름>/<UUID>)와 같은 꼴이다.
// 계약·장부의 공개 면이 내지 않아 여기 다시 두고, 같은지는 시험이 대조한다.
// purpose와 sessionId의 꼴은 설계에 없어 이 후보가 고른 것이다.
export const PATTERNS = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  sha256: /^[0-9a-f]{64}$/,
  sourceRef: /^[a-z][a-z0-9-]{0,31}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  purpose: /^[a-z][a-z0-9_]{0,63}$/,
  sessionId: /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,199}$/,
} as const;

// 권한·자원·주체를 주장하는 칸의 이름. 엄격한 꼴 검사가 어차피 모르는 칸을 거절하지만, 이 이름은 깊이 MAX_DEPTH까지 먼저 찾아
// forbidden_field로 따로 거절한다(모델이 무엇을 시도했는지 구별해 남기기 위해). 한도를 먼저 만나면 malformed_argument다. 이름은 소문자로 바꾸고 -·_·공백을 지워 대조한다.
// 앞부분은 계약 v1의 FORBIDDEN_FIELD_NAMES와 같은 뜻의 이름이고, 뒤는 설계 §4 공통 줄(URL·경로·셸·PodSpec·모델명·계정명·승인)과
// 이 계약이 더한 것(PID·화면·목적지, 세션·소유자·호출 ID, 우선순위·예산·기한)이다.
const FORBIDDEN = new Set([
  "command", "commands", "cmd", "entrypoint", "shell", "exec", "script", "executable", "binary", "program", "bin",
  "image", "images", "imageref", "volume", "volumes", "mount", "mounts", "hostpath", "argv", "args", "arguments",
  "env", "envs", "environment", "envvars", "path", "paths", "file", "filepath", "filename", "cwd", "workdir", "dir", "directory",
  "url", "uri", "endpoint", "host", "podspec", "pod",
  "model", "modelname", "account", "accountname", "accounts", "credential", "credentials", "token", "apikey", "secret", "password", "authmethod",
  "pid", "pids", "process", "screen", "terminal", "pane", "tty",
  "approval", "approved", "approve", "approver", "destination", "dest", "channel", "recipient",
  "session", "sessionid", "sessiongeneration", "generation", "owner", "ownerid", "requestid", "callid", "caller", "principal", "executor", "executorid",
  "priority", "budget", "budgettokens", "tokens", "deadline", "deadlineat", "profile", "profilerevision", "policyrevision",
]);
const normalizeName = (name: string) => name.toLowerCase().replace(/[-_\s]/g, "");
const MAX_DEPTH = 16;

// 사람이 읽는 짧은 글. 제어 문자(줄바꿈·탭 제외)와 짝 없는 서로게이트, 빈 글을 받지 않는다(계약 v1 schema.ts의 text와 같은 규칙).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Zl}\p{Zp}\p{Bidi_Control}]/u;
const isText = (value: unknown, maxChars: number): value is string =>
  typeof value === "string" && value.isWellFormed() && value.trim().length > 0 && [...value].length <= maxChars && !CONTROL.test(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);
const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// ---- 거절의 모양 ----

// 두 표식은 private 칸으로 이름을 가진 타입이 된다. 빈 클래스면 어떤 객체든 그 타입으로 보여 좁히기가 깨진다.
class Refuse {
  private readonly mark = "refuse";
  constructor(
    readonly reason: ToolRefusal,
    readonly field: string | null = null,
  ) {}
}
// 포트가 모르거나 꼴이 틀린 값을 냈다.
class Unknown {
  private readonly mark = "unknown";
}

type Step<T> = T | Refuse | Unknown;
const stopped = (value: unknown): value is Refuse | Unknown => value instanceof Refuse || value instanceof Unknown;

// 포트 호출 하나. 던지거나 Answer 꼴이 아니면 모름이다.
function ask<T>(call: () => Answer<T>): Step<T> {
  try {
    const answer: unknown = call();
    if (isPlainObject(answer) && answer.known === true && Object.hasOwn(answer, "value")) return answer.value as T;
    return new Unknown();
  } catch {
    return new Unknown();
  }
}

// ---- 인자 ----

function findForbidden(value: unknown, path: string, depth: number): Step<null> {
  if (depth > MAX_DEPTH) return new Refuse("malformed_argument", path || null);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbidden(value[i], `${path}[${i}]`, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const [key, inner] of Object.entries(value)) {
    const at = path === "" ? key : `${path}.${key}`;
    if (FORBIDDEN.has(normalizeName(key))) return new Refuse("forbidden_field", at);
    const hit = findForbidden(inner, at, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

// 닫힌 객체: 모르는 칸은 거절하고, 정한 칸은 모두 있어야 한다(optional만 빠져도 된다).
function closed(value: unknown, keys: readonly string[], path: string, optional: readonly string[] = []): Step<Record<string, unknown>> {
  if (!isPlainObject(value)) return new Refuse("malformed_argument", path || null);
  for (const key of Object.keys(value)) if (!keys.includes(key)) return new Refuse("unknown_field", path === "" ? key : `${path}.${key}`);
  for (const key of keys) if (!optional.includes(key) && !Object.hasOwn(value, key)) return new Refuse("malformed_argument", path === "" ? key : `${path}.${key}`);
  return value;
}

function parseStart(args: unknown, briefMax: number): Step<StartWorkerArgs> {
  const top = closed(args, ["role", "task"], "");
  if (stopped(top)) return top;
  const task = closed(top.task, ["purpose", "brief", "source_ref", "input_digest"], "task", ["input_digest"]);
  if (stopped(task)) return task;
  if (!(ROLES as readonly unknown[]).includes(top.role)) return new Refuse("role_not_allowed", "role");
  if (!matches(task.purpose, PATTERNS.purpose)) return new Refuse("malformed_argument", "task.purpose");
  if (!isText(task.brief, briefMax)) return new Refuse("malformed_argument", "task.brief");
  if (!matches(task.source_ref, PATTERNS.sourceRef)) return new Refuse("malformed_argument", "task.source_ref");
  // 칸이 없거나 null이거나 digest 꼴이 아니면 고정된 입력이 아니다.
  if (!matches(task.input_digest, PATTERNS.sha256)) return new Refuse("input_not_fixed", "task.input_digest");
  return { role: top.role as Role, task: { purpose: task.purpose, brief: task.brief, source_ref: task.source_ref, input_digest: task.input_digest } };
}

function parseRef(args: unknown): Step<RunRefArgs> {
  const top = closed(args, ["ref"], "");
  if (stopped(top)) return top;
  if (!matches(top.ref, PATTERNS.uuid)) return new Refuse("malformed_argument", "ref");
  return { ref: top.ref };
}

// ---- 문맥과 포트의 값 ----

function validContext(ctx: unknown, config: unknown): boolean {
  if (!isPlainObject(ctx) || !isPlainObject(ctx.session) || !isPlainObject(ctx.stop)) return false;
  if (!matches(ctx.session.id, PATTERNS.sessionId) || !isGeneration(ctx.session.generation)) return false;
  if (!matches(ctx.requestId, PATTERNS.uuid) || !matches(ctx.callId, PATTERNS.uuid)) return false;
  if (typeof ctx.now !== "number" || !Number.isFinite(ctx.now)) return false;
  if (ctx.stop.known === true ? typeof ctx.stop.stopped !== "boolean" : ctx.stop.known !== false) return false;
  return isPlainObject(config) && Number.isSafeInteger(config.purposeBriefMaxChars) && (config.purposeBriefMaxChars as number) > 0;
}

const isPhase = (value: unknown): value is Phase => (PHASES as readonly unknown[]).includes(value);

function validRecord(value: unknown): value is WorkRecord {
  if (!isPlainObject(value) || !isPlainObject(value.content)) return false;
  const c = value.content;
  return (
    matches(value.ref, PATTERNS.uuid) &&
    typeof value.owner === "string" &&
    typeof value.retryKey === "string" &&
    isPhase(value.phase) &&
    (ROLES as readonly unknown[]).includes(c.role) &&
    typeof c.purpose === "string" &&
    typeof c.sourceRef === "string" &&
    typeof c.inputDigest === "string"
  );
}

const sameContent = (a: StartContent, b: StartContent) => a.role === b.role && a.purpose === b.purpose && a.sourceRef === b.sourceRef && a.inputDigest === b.inputDigest;

// 재시도 키는 논리 요청과 목적 분류로만 만든다. 호출 ID와 세션은 넣지 않는다: 세션이 교체된 뒤의 같은 부탁도 같은 키여야 한다.
const retryKeyOf = (requestId: string, purpose: string) => `start_worker:${requestId}:${purpose}`;

// 이미 있는 줄을 이 요청의 같은 부탁으로 받아도 되는가. 소유자를 내용보다 먼저 본다.
// 남의 줄은 포트가 전제를 어긴 것이다. retry_conflict로 답하면 빈 키의 새 접수(ok)와 구별돼 그 키에 줄이 있다는 것이 드러나므로 unknown이다.
function acceptExisting(record: unknown, ctx: ToolCallContext, key: string, content: StartContent): Step<WorkRecord> {
  if (!isPlainObject(record)) return new Unknown();
  if (record.owner !== ctx.requestId) return new Unknown();
  if (!validRecord(record)) return new Unknown();
  if (record.retryKey !== key || !sameContent(record.content, content)) return new Refuse("retry_conflict");
  return record;
}

// 소유자가 이 요청인 줄만 받는다. 없는 줄과 남의 줄은 같은 거절이다.
function ownedWork(ports: ToolPorts, ctx: ToolCallContext, ref: string): Step<WorkRecord> {
  const record = ask(() => ports.ledger.readOwnedWork({ owner: ctx.requestId, ref }));
  if (stopped(record)) return record;
  if (record === null) return new Refuse("not_found");
  if (!isPlainObject(record)) return new Unknown();
  // 식별 칸이 없으면 남의 줄인지 가릴 수 없다. not_found로 바꾸지 않는다.
  if (typeof record.owner !== "string" || typeof record.ref !== "string") return new Unknown();
  if (record.owner !== ctx.requestId || record.ref !== ref) return new Refuse("not_found");
  if (!validRecord(record)) return new Unknown();
  return record;
}

// ---- 처리기 ----

function startWorker(args: StartWorkerArgs, ctx: ToolCallContext, ports: ToolPorts): Step<ToolAnswer> {
  let verdict: unknown;
  try {
    verdict = ports.policy.judge(args.role, args.task.purpose);
  } catch {
    return new Unknown();
  }
  if (verdict === "role_not_allowed") return new Refuse("role_not_allowed", "role");
  if (verdict === "purpose_not_allowed") return new Refuse("purpose_not_allowed", "task.purpose");
  if (verdict !== "allowed") return new Unknown();

  const content: StartContent = { role: args.role, purpose: args.task.purpose, sourceRef: args.task.source_ref, inputDigest: args.task.input_digest };
  const pinned = ask(() => ports.ledger.inputPinned({ owner: ctx.requestId, sourceRef: content.sourceRef, inputDigest: content.inputDigest }));
  if (stopped(pinned)) return pinned;
  if (pinned !== true) return pinned === false ? new Refuse("input_not_fixed", "task.input_digest") : new Unknown();

  const key = retryKeyOf(ctx.requestId, content.purpose);
  const existing = ask(() => ports.ledger.findByRetryKey({ owner: ctx.requestId, retryKey: key }));
  if (stopped(existing)) return existing;
  let record: Step<WorkRecord>;
  if (existing !== null) {
    record = acceptExisting(existing, ctx, key, content);
  } else {
    const written = ask(() => ports.ledger.recordStart({ retryKey: key, owner: ctx.requestId, content, sessionId: ctx.session.id, callId: ctx.callId, now: ctx.now }));
    if (stopped(written)) return written;
    if (!isPlainObject(written)) return new Unknown();
    if (written.ok === false) {
      if (written.reason === "stopped") return new Refuse("stopped");
      if (written.reason === "intake_closed") return new Refuse("intake_closed");
      return new Unknown();
    }
    if (written.ok !== true) return new Unknown();
    // 읽기와 쓰기 사이에 같은 키가 생겼을 수 있다. 쓰기가 돌려준 줄도 같은 대조를 거친다.
    record = acceptExisting(written.record, ctx, key, content);
  }
  if (stopped(record)) return record;
  return { outcome: "ok", tool: "start_worker", ref: record.ref, phase: record.phase };
}

function workerStatus(args: RunRefArgs, ctx: ToolCallContext, ports: ToolPorts): Step<ToolAnswer> {
  const record = ownedWork(ports, ctx, args.ref);
  if (stopped(record)) return record;
  return { outcome: "ok", tool: "worker_status", ref: record.ref, phase: record.phase };
}

function workerResult(args: RunRefArgs, ctx: ToolCallContext, ports: ToolPorts): Step<ToolAnswer> {
  const record = ownedWork(ports, ctx, args.ref);
  if (stopped(record)) return record;
  const view = ask(() => ports.ledger.readResult(record.ref));
  if (stopped(view)) return view;
  if (!isPlainObject(view)) return new Unknown();
  if (view.state === "none") return new Refuse("result_not_ready");
  if (view.state !== "settled") return new Unknown();
  const { checksPassed, valid, cleanupPending, result } = view;
  if (typeof checksPassed !== "boolean" || typeof valid !== "boolean" || typeof cleanupPending !== "boolean") return new Unknown();
  if (!checksPassed) return new Refuse("result_check_failed");
  if (!valid) return new Refuse("result_expired");
  if (cleanupPending) return new Refuse("result_cleanup_pending");
  const summary = publicResult(result);
  if (summary === null) return new Unknown();
  return { outcome: "ok", tool: "worker_result", ref: record.ref, result: summary };
}

const RESULT_OUTCOMES: readonly unknown[] = ["completed", "needs_input", "failed"];
const ITEM_KINDS: readonly unknown[] = ["finding", "next_step", "risk", "question"];
const REF_KINDS: readonly unknown[] = ["artifact", "commit", "pull_request", "path"];
const RESULT_REF = /^[\x21-\x7e]{1,256}$/;
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

// 계약 v1 결과 꼴(src/contract/v1/result.ts)의 칸·값을 다시 확인하고 공개 칸만 새로 만든다. 맞지 않으면 null.
// 어느 깊이든 계약 밖의 칸이 있으면 결과 전체를 버린다: 그런 칸이 있다는 것은 결과 쪽 검사가 덜 됐다는 뜻이다.
// 전체 바이트 상한과 내용의 검증은 결과 쪽(S6) 몫이다.
function publicResult(value: unknown): ResultSummary | null {
  if (!isPlainObject(value) || !hasExactly(value, ["role", "outcome", "summary", "items", "refs"])) return null;
  if (!(ROLES as readonly unknown[]).includes(value.role) || !RESULT_OUTCOMES.includes(value.outcome)) return null;
  if (!isText(value.summary, limits.RESULT_SUMMARY_MAX_CHARS)) return null;
  const { items, refs } = value;
  if (!Array.isArray(items) || items.length > limits.RESULT_MAX_ITEMS) return null;
  if (!Array.isArray(refs) || refs.length > limits.RESULT_MAX_REFS) return null;
  const outItems: Result["items"][number][] = [];
  for (const item of items) {
    if (!isPlainObject(item) || !hasExactly(item, ["kind", "text"])) return null;
    if (!ITEM_KINDS.includes(item.kind) || !isText(item.text, limits.RESULT_ITEM_MAX_CHARS)) return null;
    outItems.push({ kind: item.kind as Result["items"][number]["kind"], text: item.text });
  }
  const outRefs: Result["refs"][number][] = [];
  for (const ref of refs) {
    if (!isPlainObject(ref) || !hasExactly(ref, ["kind", "ref", "digest"])) return null;
    if (!REF_KINDS.includes(ref.kind) || !matches(ref.ref, RESULT_REF)) return null;
    if (ref.digest !== null && !matches(ref.digest, PATTERNS.sha256)) return null;
    if (ref.kind === "artifact" && ref.digest === null) return null;
    outRefs.push({ kind: ref.kind as Result["refs"][number]["kind"], ref: ref.ref, digest: ref.digest });
  }
  return { outcome: value.outcome as Result["outcome"], summary: value.summary, items: outItems, refs: outRefs };
}

function cancelWorker(args: RunRefArgs, ctx: ToolCallContext, ports: ToolPorts): Step<ToolAnswer> {
  const record = ownedWork(ports, ctx, args.ref);
  if (stopped(record)) return record;
  const written = ask(() => ports.ledger.requestCancel({ ref: record.ref, owner: ctx.requestId, sessionId: ctx.session.id, callId: ctx.callId, now: ctx.now }));
  if (stopped(written)) return written;
  if (!isPlainObject(written)) return new Unknown();
  if (written.ok === false) return written.reason === "already_ended" ? new Refuse("already_ended") : new Unknown();
  if (written.ok !== true || !isPhase(written.phase)) return new Unknown();
  return { outcome: "ok", tool: "cancel_worker", ref: record.ref, cancel: "accepted", phase: written.phase };
}

// 도구 하나의 호출. 순서: 문맥 → 정지 → 인자 → 살아 있는 세션 → 도구별 판단.
// 정지는 문맥만으로 거절해 포트를 하나도 부르지 않는다. 설계는 정지 중 모든 새 호출을 거절하고(supervisor.md §4 공통),
// 교체할 때 옛 세션의 호출권을 거둔다(§6의 3). 그래서 읽기와 취소도 정지·폐기 세션에서는 거절한다.
export function handleToolCall(tool: string, args: unknown, ctx: ToolCallContext, ports: ToolPorts): ToolAnswer {
  const answer = run(tool, args, ctx, ports);
  if (answer instanceof Refuse) return { outcome: "refused", tool, reason: answer.reason, field: answer.field };
  if (answer instanceof Unknown) return { outcome: "unknown", tool };
  return answer;
}

function run(tool: string, args: unknown, ctx: ToolCallContext, ports: ToolPorts): Step<ToolAnswer> {
  if (!(TOOL_NAMES as readonly string[]).includes(tool)) return new Refuse("unknown_tool");
  if (!validContext(ctx, ports?.config)) return new Refuse("context_invalid");
  if (!ctx.stop.known) return new Refuse("stop_unknown");
  if (ctx.stop.stopped) return new Refuse("stopped");

  const forbidden = findForbidden(args, "", 0);
  if (forbidden !== null) return forbidden;
  const parsed = tool === "start_worker" ? parseStart(args, ports.config.purposeBriefMaxChars) : parseRef(args);
  if (stopped(parsed)) return parsed;

  const live = ask(() => ports.ledger.liveSession());
  if (stopped(live)) return live;
  if (live === null) return new Refuse("session_retired");
  if (!isPlainObject(live) || typeof live.id !== "string" || !isGeneration(live.generation)) return new Unknown();
  if (live.id !== ctx.session.id || live.generation !== ctx.session.generation) return new Refuse("session_retired");

  switch (tool as ToolName) {
    case "start_worker":
      return startWorker(parsed as StartWorkerArgs, ctx, ports);
    case "worker_status":
      return workerStatus(parsed as RunRefArgs, ctx, ports);
    case "worker_result":
      return workerResult(parsed as RunRefArgs, ctx, ports);
    case "cancel_worker":
      return cancelWorker(parsed as RunRefArgs, ctx, ports);
  }
}
