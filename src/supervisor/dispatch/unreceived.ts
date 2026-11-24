// D-90 자동 닫기의 한 박자. 실행기가 받은 적 없는 작업자 실행을 고르고, 그 실행기의 마지막 반영 인사(증거 포트)가 조건을 모두 채울 때만
// 장부의 closeUnreceivedRun을 부른다. 닫는 판단은 장부가 한 트랜잭션에서 다시 한다. 이 박자는 후보를 고르고 부를 뿐이다.
// 장부·증거·맡기지 않을 실행기·정지 세대·복원 대기는 포트로, 닫는 시각(now)은 순서기가 다시 읽은 장부 시계로 받는다.
// 소켓·타이머·시계·난수를 직접 부르지 않는다. 쥐는 것은 같은 장부 포트로 박자가 진행 중이라는 표시 하나다(돌아오면 지운다).
//
// 지키는 것(unreceived.md "판단의 차례"):
// 1. 모름은 닫지 않는다. 포트가 던지거나 꼴이 틀리거나 known: false면 그 항목(전역 포트면 박자 전체)은 장부를 부르지 않는다.
//    포트 객체와 그 함수는 박자 처음에 한 번 꺼낸다(hold). 꺼내기의 예외·함수 아님은 그 포트를 불러 던진 것과 같게 친다.
// 2. 근거는 그 실행기의 지금 인정된 연결이 낸 검증된 전체 인사 하나다. 연결 번호·주체·맞춘 정지 세대·서명 시각(answeredAt)·전체 목록을
//    한 묶음으로 받고, 받은 시각(receivedAt)은 근거 줄에 적을 값으로만 넘긴다.
// 3. 그 실행기의 앞선 답이 버려진 적이 있거나(tainted) 더 새 답이 줄에 남아 있으면(pending) 닫지 않는다.
// 4. 증거 포트의 confirm이 장부 호출 전의 마지막 외부 호출이다. 연결의 현재성, 증거를 읽은 뒤 그 실행기 줄의 변화(version),
//    정지 세대를 한 번에 판정한다. 그 뒤로는 외부 객체의 속성도 읽지 않고, 꺼내 둔 함수와 미리 만든 인자로 장부를 부른다.
//    증거 읽기부터 장부 호출까지 await가 없다.
// 5. 장부의 거절·예외·정의 밖의 답은 닫힘으로 세지 않는다. 예외와 정의 밖의 답은 그 자리에서 박자를 멈춘다(장부가 적었는지 모른다).
import { limits, parsePrincipal, RUN_STATES, type RunState, type RunStatus } from "../../contract/v1/index.ts";
import {
  LEDGER_RUN_STATES,
  type Ledger,
  REFUSALS as LEDGER_REFUSALS,
  type LedgerRunState,
  type Refusal as LedgerRefusal,
  type Restorer,
  type UnreceivedClosureInput,
} from "../../ledger/index.ts";
import type { WithheldSource } from "./assign-loop.ts";

// 장부 포트. 읽기 하나와 닫기 하나다. 다른 쓰기는 받지 않는다. 닫기의 성공에서 이 박자가 보는 칸은 실행 ID와 상태 둘이고,
// closed의 보장도 그 수준이다(장부가 이 실행을 not_started로 닫았다고 답했다). 실제 장부는 같은 커밋에서 적은 실행 줄 전체를 돌려준다.
export interface UnreceivedLedger {
  unansweredInstructions: Ledger["unansweredInstructions"];
  closeUnreceivedRun(
    input: UnreceivedClosureInput,
    from: { sender: string },
  ): { ok: true; run: { readonly runId: string; readonly state: LedgerRunState } } | { ok: false; reason: LedgerRefusal };
}

// 그 실행기의 마지막 반영(applied) 인사. 연결 판단이 낸 그 occupancy(full) 출력과 같은 묶음이어야 한다(조립의 조건, unreceived.md).
// runs는 그 인사의 전체 목록 그대로, answeredAt은 그 인사 봉투의 서명 시각(실행기 시계), receivedAt은 감독이 그 인사를 넘긴 때의 장부 시계다.
export interface UnreceivedFull {
  readonly connection: number;
  readonly principal: string;
  readonly stopGeneration: number;
  readonly runs: readonly RunStatus[];
  readonly answeredAt: number;
  readonly receivedAt: number;
}

// tainted: 이 프로세스·이 장부 열기에서 그 실행기의 인사·답이 반영되지 않고 버려진 적이 있다(옛 연결의 not_current, 서버를 새로 만들며
// 버린 밀린 사본, 내용을 모르는 버림 포함). pending: 그 실행기 줄에 아직 넘기지 않은 답이 있다(held 인사, retry, 밀린 사본).
// version: 그 실행기 줄의 변경 번호. 이 읽기 뒤에 그 줄에 변화가 있으면 confirm이 evidence_changed를 낸다(unreceived.md "뒤 조각").
export type UnreceivedEvidenceRead =
  | { readonly known: false }
  | { readonly known: true; readonly tainted: boolean; readonly pending: boolean; readonly version: number; readonly lastFull: UnreceivedFull | null };

// confirm의 답. current만 장부로 간다.
export type UnreceivedConfirm = "current" | "link_not_current" | "evidence_changed" | "stop_generation";

// 동기여야 한다: 읽기와 확인과 장부 호출 사이에 await가 없다.
export interface UnreceivedEvidence {
  read(executorId: string): UnreceivedEvidenceRead;
  // 장부 호출 직전에 한 번 부른다. 차례대로 본다: connection이 지금의 복원기로 인정된 그 실행기의 연결인가(내보내기 포트의
  // answers.current와 같은 판정) → 복원기의 정지 세대가 stopGeneration인가 → 그 실행기 줄의 변경 번호가 아직 version인가.
  // 읽기만 한다(줄을 넘기거나 버리지 않는다).
  confirm(executorId: string, connection: number, version: number, stopGeneration: number): UnreceivedConfirm;
}

export interface UnreceivedPorts {
  readonly ledger: UnreceivedLedger;
  readonly evidence: UnreceivedEvidence;
  // 배정·송신과 같은 원천(답 줄의 withheld).
  readonly withheld: WithheldSource;
  // 연결 판단의 맞춤에 쓴 그 복원기.
  readonly intake: Pick<Restorer, "stopGeneration">;
  // 답 줄과 같은 신호: 복원 2단계가 붙든 관측을 적었는가.
  readonly observationsSettled: () => boolean;
}

// 장부의 START_UNREACHABLE_MS와 같은 식이다(장부는 내보내지 않는다). 장부가 같은 트랜잭션에서 다시 보므로 이 값은 부르지 않을 항목을
// 미리 거르는 데만 쓴다: 장부 값보다 작으면 장부가 answer_too_early로 거절하고, 크면 늦게 닫힐 뿐이다. 정각(발행 + 이 값)은 통과다.
export const UNRECEIVED_ANSWER_AFTER_MS = Math.max(limits.RUN_LEASE_MAX_MS, limits.MESSAGE_TTL_MAX_MS);

export type UnreceivedNotRun =
  | "now_malformed"
  | "tick_in_progress"
  | "observations_unsettled"
  | "stop_generation_unknown"
  // 복원기의 정지 세대와 장부의 지금 정지 세대가 다르다(정지·복원이 바뀌는 중).
  | "stop_generation_mismatch"
  | "withheld_unknown"
  // 장부 읽기를 모른다. 장부 포트나 그 두 함수를 꺼내지 못한 것도 여기다.
  | "read_unknown";

// 박자를 멈춘 이유. threw는 장부 호출이 던졌거나 답이 정의 밖이다. 나머지는 항목마다 다시 본 전역 포트가 박자 처음과 달라졌다.
export type UnreceivedHalt = "threw" | "observations_unsettled" | "stop_generation_unknown" | "stop_generation_mismatch" | "withheld_unknown";

export type UnreceivedSkip =
  // 닫을 수 있는 상태(preparing·unknown_running)가 아니다.
  | "run_state"
  | "not_worker"
  // 지시를 적을 때의 세대나 인사가 맞춘 세대가 지금 세대와 다르다. confirm이 정지 세대가 바뀌었다고 낸 것도 여기다.
  | "stop_generation"
  | "withheld"
  // 증거를 읽지 못했거나 꼴이 틀렸거나 known: false다. 증거 포트를 꺼내지 못한 것도 여기다.
  | "evidence_unknown"
  | "tainted"
  | "pending"
  // 반영된 전체 인사가 없다.
  | "no_full"
  | "principal_mismatch"
  | "answer_too_early"
  | "run_in_answer"
  // confirm이 그 인사의 연결이 지금 인정된 연결이 아니라고 냈다. 던짐·정의 밖의 답도 여기다(확인하지 못했다).
  | "link_not_current"
  // confirm이 증거를 읽은 뒤 그 실행기 줄에 변화가 있었다고 냈다(접수·버림·넘김·고장·맡기지 않을 실행기에 듦).
  | "evidence_changed";

type Head = { readonly requestId: string; readonly runId: string; readonly executorId: string };

export type UnreceivedOutcome =
  // 장부가 not_started로 닫았다고 답했다. connection·answeredAt은 근거로 넘긴 인사의 값, at은 넘긴 now다.
  | (Head & { readonly outcome: "closed"; readonly connection: number; readonly answeredAt: number; readonly at: number })
  | (Head & { readonly outcome: "refused"; readonly reason: LedgerRefusal })
  | (Head & { readonly outcome: "skipped"; readonly reason: UnreceivedSkip })
  // 장부가 닫았는지 모른다. 장부의 문구는 싣지 않는다.
  | (Head & { readonly outcome: "ledger_failed"; readonly reason: "threw" | "malformed_answer" })
  // 장부 읽기의 항목 칸을 읽을 수 없다. requestId를 읽지 못했으면 null이다.
  | { readonly requestId: string | null; readonly outcome: "malformed"; readonly field: string };

export type UnreceivedTickResult =
  | { readonly kind: "not_run"; readonly reason: UnreceivedNotRun }
  | {
      readonly kind: "ran";
      // 시작 지시 항목마다 하나, 읽기의 순서대로. 멈췄으면 멈춘 항목(장부를 불렀으면)까지 있고 그 뒤는 없다.
      readonly runs: readonly UnreceivedOutcome[];
      readonly halted: UnreceivedHalt | null;
      readonly haltedAt: string | null;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 장부의 UNRECEIVED_CLOSABLE과 같은 집합(장부는 내보내지 않는다). 장부가 다시 본다.
const CLOSABLE: readonly LedgerRunState[] = ["preparing", "unknown_running"];
// 계약의 실행 상태 항목의 칸(transport.ts의 runStatus). 장부의 answerRuns도 이 칸만 받는다.
const RUN_STATUS_KEYS: readonly string[] = ["run_id", "state", "run_generation", "last_receipt_id"];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isRefusal = (value: unknown): value is LedgerRefusal => (LEDGER_REFUSALS as readonly unknown[]).includes(value);
const isState = (value: unknown): value is LedgerRunState => (LEDGER_RUN_STATES as readonly unknown[]).includes(value);
const isRunState = (value: unknown): value is RunState => (RUN_STATES as readonly unknown[]).includes(value);
// 꺼내 둔 함수를 꺼내 둔 수신자로 부른다. fn.call은 포트가 준 함수 객체의 속성이라 읽지 않는다.
const apply = Reflect.apply;

function isWorkerName(value: unknown): value is string {
  try {
    return typeof value === "string" && parsePrincipal(value)?.kind === "worker_executor";
  } catch {
    return false;
  }
}

type Fn = (...args: unknown[]) => unknown;
interface Bound {
  readonly receiver: unknown;
  readonly fn: Fn;
}

// 박자 처음에 한 번 꺼낸 포트. 그 뒤로는 포트 객체의 속성을 읽지 않는다. null은 꺼내지 못한 것이다.
interface Held {
  readonly ledger: object;
  readonly unanswered: Fn;
  readonly close: Fn;
  readonly evidence: { readonly read: Bound; readonly confirm: Bound } | null;
  readonly stopGeneration: Bound | null;
  readonly executors: Bound | null;
  readonly settled: Bound | null;
}

function take(get: () => { receiver: unknown; fn: unknown }): Bound | null {
  try {
    const { receiver, fn } = get();
    return typeof fn === "function" ? { receiver, fn: fn as Fn } : null;
  } catch {
    return null;
  }
}

// 장부를 꺼내지 못하면 박자 전체가 read_unknown이다. 다른 포트는 꺼내지 못해도 그 포트의 모름으로 이어 간다.
function hold(ports: UnreceivedPorts): Held | null {
  let ledger: unknown;
  let unanswered: unknown;
  let close: unknown;
  try {
    ledger = ports.ledger;
    if (!isObject(ledger)) return null;
    unanswered = ledger.unansweredInstructions;
    close = ledger.closeUnreceivedRun;
  } catch {
    return null;
  }
  if (typeof unanswered !== "function" || typeof close !== "function") return null;
  let evidence: Held["evidence"] = null;
  try {
    const port: unknown = ports.evidence;
    if (isObject(port)) {
      const read: unknown = port.read;
      const confirm: unknown = port.confirm;
      if (typeof read === "function" && typeof confirm === "function") evidence = { read: { receiver: port, fn: read as Fn }, confirm: { receiver: port, fn: confirm as Fn } };
    }
  } catch {
    evidence = null;
  }
  return {
    ledger: ledger as object,
    unanswered: unanswered as Fn,
    close: close as Fn,
    evidence,
    stopGeneration: take(() => {
      const intake: unknown = ports.intake;
      return { receiver: intake, fn: isObject(intake) ? intake.stopGeneration : undefined };
    }),
    executors: take(() => {
      const source: unknown = ports.withheld;
      return { receiver: source, fn: isObject(source) ? source.executors : undefined };
    }),
    settled: take(() => ({ receiver: ports, fn: ports.observationsSettled })),
  };
}

// 던지면 null. 돌려준 값은 그대로 싣는다(꼴은 부른 쪽이 본다).
function invoke(bound: Bound | null, args: readonly unknown[]): { readonly value: unknown } | null {
  if (bound === null) return null;
  try {
    return { value: apply(bound.fn, bound.receiver, args) };
  } catch {
    return null;
  }
}

// 같은 장부 포트로 진행 중인 박자. 박자 안에 await가 없으므로 겹치는 길은 포트 안에서 다시 부르는 것뿐이다.
const RUNNING = new WeakSet<object>();

export function unreceivedTick(ports: UnreceivedPorts, now: number): UnreceivedTickResult {
  const held = hold(ports);
  if (held === null) return { kind: "not_run", reason: "read_unknown" };
  const key = held.ledger;
  if (RUNNING.has(key)) return { kind: "not_run", reason: "tick_in_progress" };
  RUNNING.add(key);
  try {
    return tickOnce(held, now);
  } finally {
    RUNNING.delete(key);
  }
}

interface Gate {
  readonly generation: number;
  readonly withheld: ReadonlySet<string>;
}

// 전역 포트 셋. 박자 처음과, 항목마다 증거를 읽은 뒤에 다시 본다(앞 항목의 장부 쓰기나 포트가 같은 동기 구간에서 바꿀 수 있다).
// 복원 대기를 마지막에 본다: 앞의 두 조회 안에서 바뀐 정지 세대·줄은 confirm이 다시 보지만 복원 대기는 다시 보지 않는다.
function readGate(held: Held): Gate | Exclude<UnreceivedHalt, "threw" | "stop_generation_mismatch"> {
  const generation = invoke(held.stopGeneration, []);
  if (generation === null || !isGeneration(generation.value)) return "stop_generation_unknown";
  const withheld = readWithheld(held.executors);
  if (withheld === null) return "withheld_unknown";
  const settled = invoke(held.settled, []);
  if (settled === null || settled.value !== true) return "observations_unsettled";
  return { generation: generation.value, withheld };
}

// 배정 박자(assign-loop.ts의 readWithheld)와 같은 검사다. value는 한 번만 읽고, 원소 하나라도 작업자 실행기 이름이 아니면 모름이다.
function readWithheld(source: Bound | null): ReadonlySet<string> | null {
  const read = invoke(source, []);
  if (read === null) return null;
  try {
    const answer: unknown = read.value;
    if (!isObject(answer) || answer.known !== true) return null;
    const value: unknown = answer.value;
    if (!Array.isArray(value)) return null;
    const names = new Set<string>();
    const length = value.length;
    for (let i = 0; i < length; i += 1) {
      const name: unknown = value[i];
      if (!isWorkerName(name)) return null;
      names.add(name);
    }
    return names;
  } catch {
    return null;
  }
}

function readUnanswered(held: Held): { stopGeneration: number | null; instructions: unknown[] } | null {
  try {
    const answer: unknown = apply(held.unanswered, held.ledger, []);
    if (!isObject(answer) || answer.known !== true) return null;
    const value: unknown = answer.value;
    if (!isObject(value)) return null;
    const stopGeneration: unknown = value.stopGeneration;
    const items: unknown = value.instructions;
    if (!(stopGeneration === null || isGeneration(stopGeneration)) || !Array.isArray(items)) return null;
    const instructions: unknown[] = [];
    const length = items.length;
    for (let i = 0; i < length; i += 1) instructions.push(items[i]);
    return { stopGeneration, instructions };
  } catch {
    return null;
  }
}

interface StartItem extends Head {
  readonly runState: LedgerRunState;
  readonly issuedAt: number;
  readonly stopGeneration: number;
}

// 시작 지시 항목만 칸마다 한 번 읽어 옮긴다. 시작 지시가 아니면 null(후보가 아니다). 칸이 틀리면 malformed 결과다.
function readItem(value: unknown): StartItem | null | UnreceivedOutcome {
  let requestId: string | null = null;
  try {
    if (!isObject(value)) return { requestId, outcome: "malformed", field: "item" };
    const rawRequestId: unknown = value.requestId;
    if (!isUuid(rawRequestId)) return { requestId, outcome: "malformed", field: "requestId" };
    requestId = rawRequestId;
    const action: unknown = value.action;
    if (typeof action !== "string") return { requestId, outcome: "malformed", field: "action" };
    if (action !== "task_start") return null;
    const runId: unknown = value.runId;
    if (!isUuid(runId)) return { requestId, outcome: "malformed", field: "runId" };
    const executorId: unknown = value.executorId;
    if (typeof executorId !== "string") return { requestId, outcome: "malformed", field: "executorId" };
    const runState: unknown = value.runState;
    if (!isState(runState)) return { requestId, outcome: "malformed", field: "runState" };
    const issuedAt: unknown = value.issuedAt;
    if (!isTime(issuedAt)) return { requestId, outcome: "malformed", field: "issuedAt" };
    const stopGeneration: unknown = value.stopGeneration;
    if (!isGeneration(stopGeneration)) return { requestId, outcome: "malformed", field: "stopGeneration" };
    return { requestId, runId, executorId, runState, issuedAt, stopGeneration };
  } catch {
    return { requestId, outcome: "malformed", field: "item" };
  }
}

interface Evidence {
  readonly tainted: boolean;
  readonly pending: boolean;
  readonly version: number;
  readonly full: UnreceivedFull | null;
  readonly confirm: Bound;
}

// 전체 목록을 계약의 실행 상태 항목 규칙(transport.ts의 runStatus·runList)으로 보고 새 객체로 옮긴다. 장부가 입력에서 거절할 꼴을
// 장부까지 보내면 박자 전체가 멈추므로 여기서 그 항목의 모름으로 끝낸다. 칸마다 한 번 읽고, 하나라도 틀리면 null이다.
function copyRuns(value: unknown): RunStatus[] | null {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  if (length > limits.STATUS_MAX_RUNS) return null;
  const out: RunStatus[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < length; i += 1) {
    const item: unknown = value[i];
    if (!isObject(item) || Array.isArray(item)) return null;
    const keys = Object.keys(item);
    if (keys.length !== RUN_STATUS_KEYS.length || !keys.every((key) => RUN_STATUS_KEYS.includes(key))) return null;
    const runId: unknown = item.run_id;
    const state: unknown = item.state;
    const generation: unknown = item.run_generation;
    const receipt: unknown = item.last_receipt_id;
    if (!isUuid(runId) || seen.has(runId) || !isRunState(state)) return null;
    seen.add(runId);
    if (state === "not_known") {
      if (generation !== null || receipt !== null) return null;
      out.push({ run_id: runId, state, run_generation: null, last_receipt_id: null });
      continue;
    }
    if (!Number.isSafeInteger(generation) || (generation as number) < 1 || !(receipt === null || isUuid(receipt))) return null;
    out.push({ run_id: runId, state, run_generation: generation as number, last_receipt_id: receipt });
  }
  return out;
}

// 증거를 한 번 읽어 칸마다 옮긴다. 목록은 원소까지 새로 만든다: 뒤의 포트(confirm)가 넘겨준 객체를 고쳐도 장부에 넘기는 값은 읽은 그대로다.
// 칸 하나라도 틀리면(꼴이 아닌 깃발 포함) 모름이다.
function readEvidence(port: Held["evidence"], executorId: string): Evidence | null {
  if (port === null) return null;
  const read = invoke(port.read, [executorId]);
  if (read === null) return null;
  try {
    const answer: unknown = read.value;
    if (!isObject(answer) || answer.known !== true) return null;
    const tainted: unknown = answer.tainted;
    const pending: unknown = answer.pending;
    const version: unknown = answer.version;
    const lastFull: unknown = answer.lastFull;
    if (typeof tainted !== "boolean" || typeof pending !== "boolean" || !isGeneration(version)) return null;
    if (lastFull === null) return { tainted, pending, version, full: null, confirm: port.confirm };
    if (!isObject(lastFull)) return null;
    const connection: unknown = lastFull.connection;
    const principal: unknown = lastFull.principal;
    const stopGeneration: unknown = lastFull.stopGeneration;
    const runs: unknown = lastFull.runs;
    const answeredAt: unknown = lastFull.answeredAt;
    const receivedAt: unknown = lastFull.receivedAt;
    if (!isGeneration(connection) || typeof principal !== "string" || !isGeneration(stopGeneration) || !isTime(answeredAt) || !isTime(receivedAt)) return null;
    const copied = copyRuns(runs);
    if (copied === null) return null;
    return { tainted, pending, version, full: { connection, principal, stopGeneration, runs: copied, answeredAt, receivedAt }, confirm: port.confirm };
  } catch {
    return null;
  }
}

// 장부 호출 전의 마지막 외부 호출. 돌아온 뒤에는 원시값 비교만 한다. 던짐·정의 밖의 답은 확인하지 못한 것이다.
function confirmLast(port: Bound, executorId: string, connection: number, version: number, generation: number): UnreceivedConfirm {
  let answer: unknown;
  try {
    answer = apply(port.fn, port.receiver, [executorId, connection, version, generation]);
  } catch {
    return "link_not_current";
  }
  return answer === "current" || answer === "evidence_changed" || answer === "stop_generation" ? answer : "link_not_current";
}

type Judged = { readonly outcome: UnreceivedOutcome | null; readonly halt: UnreceivedHalt | null };

function tickOnce(held: Held, now: number): UnreceivedTickResult {
  if (!isTime(now)) return { kind: "not_run", reason: "now_malformed" };
  const first = readGate(held);
  if (typeof first === "string") return { kind: "not_run", reason: first };
  const read = readUnanswered(held);
  if (read === null) return { kind: "not_run", reason: "read_unknown" };
  if (read.stopGeneration === null) return { kind: "not_run", reason: "stop_generation_unknown" };
  if (read.stopGeneration !== first.generation) return { kind: "not_run", reason: "stop_generation_mismatch" };
  const ledgerGeneration = read.stopGeneration;

  const runs: UnreceivedOutcome[] = [];
  for (const value of read.instructions) {
    const item = readItem(value);
    if (item === null) continue;
    if ("outcome" in item) {
      runs.push(item);
      continue;
    }
    const judged = judge(held, item, ledgerGeneration, now);
    if (judged.outcome !== null) runs.push(judged.outcome);
    if (judged.halt !== null) return { kind: "ran", runs, halted: judged.halt, haltedAt: item.requestId };
  }
  return { kind: "ran", runs, halted: null, haltedAt: null };
}

// 항목 하나의 판단. 외부 호출의 차례는 증거 → 전역 포트(정지 세대·맡기지 않을 실행기·복원 대기) → confirm → 장부이고,
// 그 사이의 비교는 읽어 둔 값만 쓴다. confirm 뒤에는 꺼내 둔 함수(close)와 미리 만든 인자(closing)로 장부를 부를 뿐이다.
function judge(held: Held, item: StartItem, ledgerGeneration: number, now: number): Judged {
  const { ledger: receiver, close } = held;
  const head: Head = { requestId: item.requestId, runId: item.runId, executorId: item.executorId };
  const skip = (reason: UnreceivedSkip): Judged => ({ outcome: { ...head, outcome: "skipped", reason }, halt: null });
  if (!CLOSABLE.includes(item.runState)) return skip("run_state");
  if (!isWorkerName(item.executorId)) return skip("not_worker");

  const evidence = readEvidence(held.evidence, item.executorId);
  const gate = readGate(held);
  if (typeof gate === "string") return { outcome: null, halt: gate };
  if (gate.generation !== ledgerGeneration) return { outcome: null, halt: "stop_generation_mismatch" };

  if (item.stopGeneration !== gate.generation) return skip("stop_generation");
  if (gate.withheld.has(item.executorId)) return skip("withheld");
  if (evidence === null) return skip("evidence_unknown");
  if (evidence.tainted) return skip("tainted");
  if (evidence.pending) return skip("pending");
  const full = evidence.full;
  if (full === null) return skip("no_full");
  if (full.principal !== item.executorId) return skip("principal_mismatch");
  if (full.stopGeneration !== gate.generation) return skip("stop_generation");
  // 서명 시각만 견준다. 받은 시각은 실행기가 그 시작을 받을 수 없게 된 뒤라는 증거가 아니다.
  if (full.answeredAt < item.issuedAt + UNRECEIVED_ANSWER_AFTER_MS) return skip("answer_too_early");
  if (full.runs.some((run) => run.run_id === item.runId)) return skip("run_in_answer");

  const closing: readonly unknown[] = [
    { runId: item.runId, runs: full.runs, answeredAt: full.answeredAt, receivedAt: full.receivedAt, now },
    { sender: item.executorId },
  ];
  // 마지막 외부 호출. 증거를 읽은 뒤의 포트 조회 안에서 같은 주체의 새 연결이 옛 연결을 밀어냈거나, 같은 실행기의 새 답이 줄에
  // 들어왔거나, 앞 항목의 장부 쓰기가 복원기의 세대를 바꿨을 수 있다(await가 없어도 바뀐다). 장부를 부를 때마다 그 직전에 다시 본다.
  const confirmed = confirmLast(evidence.confirm, item.executorId, full.connection, evidence.version, gate.generation);
  if (confirmed !== "current") return skip(confirmed);
  let answer: unknown;
  try {
    answer = apply(close, receiver, closing);
  } catch {
    return { outcome: { ...head, outcome: "ledger_failed", reason: "threw" }, halt: "threw" };
  }
  const malformed: Judged = { outcome: { ...head, outcome: "ledger_failed", reason: "malformed_answer" }, halt: "threw" };
  try {
    if (!isObject(answer)) return malformed;
    const ok: unknown = answer.ok;
    if (ok === false) {
      const reason: unknown = answer.reason;
      return isRefusal(reason) ? { outcome: { ...head, outcome: "refused", reason }, halt: null } : malformed;
    }
    if (ok !== true) return malformed;
    const run: unknown = answer.run;
    if (!isObject(run)) return malformed;
    const runId: unknown = run.runId;
    const state: unknown = run.state;
    if (runId !== item.runId || state !== "not_started") return malformed;
    return { outcome: { ...head, outcome: "closed", connection: full.connection, answeredAt: full.answeredAt, at: now }, halt: null };
  } catch {
    return malformed;
  }
}
