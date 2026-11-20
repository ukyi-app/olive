// 복원이 끝난 뒤 운영 중에 받은 검증된 인사(hello)의 전체 점유를 장부의 applyExecutorAnswer(full)로 넘기는 한 번의 처리.
// 순수 판단이다: 소켓·타이머·시계·난수를 직접 쓰지 않는다. 장부와 접수는 포트로, 연결 표와 지금 시각은 인자로 받는다.
// 입력 객체를 바꾸지 않고 예외를 던지지 않는다. 판단과 장부 호출 사이에 await가 없다(한 동기 구간).
//
// 지키는 것(hello-answers.md "보장 넷"):
// 1. 전체 답은 연결 판단이 낸 occupancy(full) 출력에서만, 그 인사 봉투의 서명 시각(issuedAt)과 함께 넘긴다. partial은 받지 않는다.
//    서명 시각이 없으면 받은 시각으로 대신하지 않고 장부를 부르지 않는다.
// 2. 넘기는 순간 그 출력이 그 실행기의 지금 인정된 연결의 인사인지 연결 표로 다시 본다. 접수가 닫혀 있으면 넘기지 않는다.
// 3. 장부의 답을 지우거나 합치지 않고 돌려준다. 반영하지 못했으면 같은 값을 다시 넘길 값과 "새 일을 맡기지 않을 실행기"를 낸다.
// 4. 자리를 풀거나 실행을 닫는 길이 없다. 장부 연산은 applyExecutorAnswer 하나만 부른다.
import type { RunStatus } from "../../contract/v1/index.ts";
import {
  type DeferredLoss,
  LEDGER_RUN_STATES,
  type Ledger,
  LedgerInputError,
  type LedgerRunState,
  type LostRun,
  REFUSALS,
  type Refusal,
  type Restorer,
} from "../../ledger/index.ts";
import type { Connections } from "../transport/connections.ts";

// 장부 포트. 실제 장부(openLedger가 연 Ledger)가 그대로 맞는다. 자리를 푸는 연산이 이 포트에 없다.
export type HelloAnswerLedger = Pick<Ledger, "applyExecutorAnswer">;

// 접수와 정지 세대. 실제로는 재시작 복원기(Restorer)이고, 연결 판단의 맞춤에 답한 그 객체여야 한다:
// 연결 표의 candidates(source)는 객체 동일성으로 "이번 복원의 인사"를 가른다.
export type HelloIntake = Pick<Restorer, "intakeOpen" | "stopGeneration">;

// 넘기는 순간의 연결 표(부르는 쪽이 쥔 Connections 값).
export type HelloConnectionTable = Pick<Connections, "get" | "candidates">;

export interface HelloAnswerPorts {
  readonly ledger: HelloAnswerLedger;
  readonly intake: HelloIntake;
}

export interface HelloAnswerInput {
  // 연결 판단(Connections.step)이 낸 occupancy 출력 하나 그대로.
  readonly output: unknown;
  readonly table: HelloConnectionTable;
  // 장부에 적는 시각(장부 시계).
  readonly now: number;
}

// 장부가 반영하지 못한 인사. 이 모듈이 실패 결과로 낸 값만 retryHelloAnswer가 받는다(지어낸 값으로 full을 넘기는 길을 막는다).
export interface HelloRetry {
  readonly executorId: string;
  readonly connection: number;
  readonly runs: readonly RunStatus[];
  readonly answeredAt: number;
}

export const REFUSED_WHY = ["not_occupancy", "partial", "malformed_output", "signed_time_missing", "malformed_now", "not_retry"] as const;
export type RefusedWhy = (typeof REFUSED_WHY)[number];

// 지금 인정된 연결의 인사가 아닌 까닭. 모두 장부를 부르지 않았다.
// no_connection: 연결 표에 그 번호가 없다(닫혀 지워짐). not_greeted: 인사한 연결이 아니다(닫힘·밀려남 포함).
// other_restore: 그 맞춤에 답한 복원기가 지금의 접수 복원기가 아니거나 세대를 모른다(candidates에 없다).
// other_principal: 그 연결의 주체가 출력의 실행기 이름과 다르다. other_greeting: 서명 시각이나 실행 목록이 그 연결의 인사와 다르다.
// stop_generation_changed: 그 연결이 맞춘 정지 세대가 지금 세대와 다르다.
export const NOT_CURRENT_WHY = ["no_connection", "not_greeted", "other_restore", "other_principal", "other_greeting", "stop_generation_changed"] as const;
export type NotCurrentWhy = (typeof NOT_CURRENT_WHY)[number];

export type HelloAnswerOutcome =
  // 장부가 반영했다. moved·deferred·outsideLedger는 장부의 답 그대로다. outsideLedger의 세대는 닫는 지시에만 쓴다.
  | {
      readonly kind: "applied";
      readonly executorId: string;
      readonly connection: number;
      readonly answeredAt: number;
      readonly moved: readonly LostRun[];
      readonly deferred: readonly DeferredLoss[];
      readonly outsideLedger: readonly { readonly runId: string; readonly runGeneration: number }[];
    }
  // 장부가 아무것도 적지 못했다(ok: false). reason·unsavedSightings는 장부의 답 그대로다.
  | {
      readonly kind: "ledger_unsaved";
      readonly executorId: string;
      readonly connection: number;
      readonly reason: Refusal;
      readonly unsavedSightings: readonly { readonly runId: string; readonly runGeneration: number }[];
      readonly retry: HelloRetry;
      readonly withhold: string;
    }
  // 장부가 던졌거나 답의 꼴이 틀렸다(항목 하나라도 약속한 꼴이 아니거나 답을 읽다가 던짐). input_rejected는 장부의 LedgerInputError
  // (같은 값을 다시 넘겨도 같다)라 retry가 null이다. message는 input_rejected의 장부 문구뿐이고 그 밖에는 null이다.
  | {
      readonly kind: "ledger_failed";
      readonly executorId: string;
      readonly connection: number;
      readonly failure: "input_rejected" | "threw" | "malformed_answer";
      readonly message: string | null;
      readonly retry: HelloRetry | null;
      readonly withhold: string;
    }
  // 접수가 열려 있지 않다(복원 중, 정지 중 등). 장부를 부르지 않았다. 같은 출력을 접수가 열린 뒤 다시 넘길 수 있다(연결을 다시 본다).
  | { readonly kind: "held"; readonly executorId: string; readonly connection: number; readonly withhold: string }
  | { readonly kind: "not_current"; readonly executorId: string; readonly connection: number; readonly why: NotCurrentWhy }
  | { readonly kind: "refused"; readonly why: RefusedWhy };

// 이 모듈이 낸 다시 넘길 값. 메모리에만 있다(프로세스가 다시 뜨면 사라진다: hello-answers.md "남는 한계").
const issuedRetries = new WeakSet<HelloRetry>();

// 연결 판단이 낸 occupancy(full) 출력 하나를 장부에 넘긴다.
export function passHelloAnswer(input: HelloAnswerInput, ports: HelloAnswerPorts): HelloAnswerOutcome {
  const read = readOutput(input.output);
  if ("why" in read) return read;
  const { connection, executorId, runs, issuedAt } = read;
  if (!isTime(input.now)) return { kind: "refused", why: "malformed_now" };
  const why = notCurrent(input.table, ports.intake, read);
  if (why !== null) return { kind: "not_current", executorId, connection, why };
  // 접수가 열리기 전의 인사는 복원 2단계가 occupancy(source)로 읽는 몫이다. 여기서 장부를 부르면 복원의 판정 전에 상태를 옮긴다.
  if (!readIntake(ports.intake)) return { kind: "held", executorId, connection, withhold: executorId };
  return apply(ports.ledger, Object.freeze({ executorId, connection, runs: frozenRuns(runs), answeredAt: issuedAt }), input.now);
}

// 반영하지 못한 인사를 같은 값으로 다시 넘긴다. 연결과 접수를 다시 보지 않는다: 처음 넘길 때 지금의 인사였고, 같은 값을 다시 적어야
// 그 인사의 양성 관측이 남는다(ledger.md "실행기의 답을 넘기는 쪽"). 그 실행기의 더 새 답보다 먼저 부르는 것은 부르는 쪽이 지킨다.
// 함정: 접수를 보지 않으므로 복원 중(2단계 전)에도 장부에 닿는다. 복원 작업과의 순서는 조립이 정한다(hello-answers.md).
export function retryHelloAnswer(retry: HelloRetry, now: number, ports: Pick<HelloAnswerPorts, "ledger">): HelloAnswerOutcome {
  if (typeof retry !== "object" || retry === null || !issuedRetries.has(retry)) return { kind: "refused", why: "not_retry" };
  if (!isTime(now)) return { kind: "refused", why: "malformed_now" };
  return apply(ports.ledger, retry, now);
}

function apply(ledger: HelloAnswerLedger, answer: HelloRetry, now: number): HelloAnswerOutcome {
  const { executorId, connection } = answer;
  const retry = issue(answer);
  let result: unknown;
  try {
    result = ledger.applyExecutorAnswer({ coverage: "full", runs: answer.runs, answeredAt: answer.answeredAt, now }, { sender: executorId });
  } catch (error) {
    // 장부의 입력 거절 문구는 장부가 정한 형식이다. 그 밖의 예외 문구는 포트의 진단(경로·값)을 담을 수 있어 결과에 싣지 않는다.
    if (error instanceof LedgerInputError) return { kind: "ledger_failed", executorId, connection, failure: "input_rejected", message: error.message, retry: null, withhold: executorId };
    return { kind: "ledger_failed", executorId, connection, failure: "threw", message: null, retry, withhold: executorId };
  }
  const malformed: HelloAnswerOutcome = { kind: "ledger_failed", executorId, connection, failure: "malformed_answer", message: null, retry, withhold: executorId };
  // 답을 읽는 것도 포트의 값을 건드리는 일이다(접근자가 던질 수 있다). 꼴이 틀린 항목을 반영으로 세면 뒤 조각이 지어낸 실행을 닫는다.
  // 칸마다 한 번만 읽고 그 값을 검사해 돌려준다: 접근자는 읽을 때마다 다른 값을 낼 수 있어, 다시 읽으면 검사하지 않은 값이 실린다.
  try {
    if (typeof result !== "object" || result === null) return malformed;
    const r = result as Record<string, unknown>;
    const ok = r.ok;
    if (ok === true) {
      const moved = items(r.moved, lostRun);
      const deferred = items(r.deferred, deferredLoss);
      const outsideLedger = items(r.outsideLedger, runRef);
      if (moved === null || deferred === null || outsideLedger === null) return malformed;
      return { kind: "applied", executorId, connection, answeredAt: answer.answeredAt, moved, deferred, outsideLedger };
    }
    if (ok !== false) return malformed;
    const reason = r.reason;
    if (!(REFUSALS as readonly unknown[]).includes(reason)) return malformed;
    const unsavedSightings = items(r.unsavedSightings, runRef);
    if (unsavedSightings === null) return malformed;
    return { kind: "ledger_unsaved", executorId, connection, reason: reason as Refusal, unsavedSightings, retry, withhold: executorId };
  } catch {
    return malformed;
  }
}

// 장부가 약속한 항목의 꼴(ledger.ts의 LostRun·DeferredLoss·{ runId, runGeneration })만 받는다. 칸 수까지 맞아야 하고 필드별 사본을 낸다.
function items<T>(value: unknown, read: (item: Record<string, unknown>) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const copy = read(item as Record<string, unknown>);
    if (copy === null) return null;
    out.push(copy);
  }
  return out;
}

// 각 칸은 한 번만 읽는다(apply의 답 해석 주석). 칸 수는 이름만 세므로 접근자를 부르지 않는다.
function runRef(item: Record<string, unknown>): { runId: string; runGeneration: number } | null {
  if (Object.keys(item).length !== 2) return null;
  const { runId, runGeneration } = item;
  if (!isRunId(runId) || !isGeneration(runGeneration)) return null;
  return { runId, runGeneration };
}

function lostRun(item: Record<string, unknown>): LostRun | null {
  if (Object.keys(item).length !== 4) return null;
  const { runId, runGeneration, before, after } = item;
  if (!isRunId(runId) || !isGeneration(runGeneration) || !isLedgerState(before) || !isLedgerState(after)) return null;
  return { runId, runGeneration, before, after };
}

const DEFER_WHY: readonly unknown[] = ["start_may_arrive", "answer_time_unknown"] satisfies DeferredLoss["why"][];

function deferredLoss(item: Record<string, unknown>): DeferredLoss | null {
  if (Object.keys(item).length !== 4) return null;
  const { runId, runGeneration, state, why } = item;
  if (!isRunId(runId) || !isGeneration(runGeneration) || !isLedgerState(state) || !DEFER_WHY.includes(why)) return null;
  return { runId, runGeneration, state, why: why as DeferredLoss["why"] };
}

function isRunId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// 계약의 실행 세대는 1 이상이다.
function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isLedgerState(value: unknown): value is LedgerRunState {
  return (LEDGER_RUN_STATES as readonly unknown[]).includes(value);
}

function issue(answer: HelloRetry): HelloRetry {
  issuedRetries.add(answer);
  return answer;
}

interface FullOutput {
  readonly connection: number;
  readonly executorId: string;
  readonly runs: readonly RunStatus[];
  readonly issuedAt: number;
}

// 출력의 꼴만 본다. 실행 목록의 항목은 연결 표의 인사와 같은지로 다시 보고(notCurrent), 계약의 꼴은 장부가 다시 본다.
function readOutput(output: unknown): FullOutput | Extract<HelloAnswerOutcome, { kind: "refused" }> {
  try {
    if (typeof output !== "object" || output === null) return { kind: "refused", why: "malformed_output" };
    const o = output as Record<string, unknown>;
    if (o.kind !== "occupancy") return { kind: "refused", why: "not_occupancy" };
    const answer = o.answer as Record<string, unknown> | null;
    if (typeof answer !== "object" || answer === null) return { kind: "refused", why: "malformed_output" };
    // 상태 보고의 행이다. 물은 실행만 답한 것이라 full로 올리는 길을 두지 않는다.
    if (answer.coverage === "partial") return { kind: "refused", why: "partial" };
    if (answer.coverage !== "full") return { kind: "refused", why: "malformed_output" };
    const connection = o.connection;
    const executorId = answer.executorId;
    const runs = answer.runs;
    if (!Number.isSafeInteger(connection) || (connection as number) < 1 || typeof executorId !== "string" || !Array.isArray(runs)) {
      return { kind: "refused", why: "malformed_output" };
    }
    // 받은 시각이나 장부 시계로 대신하지 않는다: 뒤 조각(D-90)이 full + 시각 모름의 답을 자리 해제의 근거로 쓰지 못하게 장부를 부르지 않는다.
    if (!isTime(o.issuedAt)) return { kind: "refused", why: "signed_time_missing" };
    return { connection: connection as number, executorId, runs: runs as RunStatus[], issuedAt: o.issuedAt };
  } catch {
    return { kind: "refused", why: "malformed_output" };
  }
}

function notCurrent(table: HelloConnectionTable, intake: HelloIntake, read: FullOutput): NotCurrentWhy | null {
  try {
    const conn = table.get(read.connection);
    if (conn === undefined) return "no_connection";
    const sync = conn.sync;
    const greeting = conn.greeting;
    if (conn.phase !== "greeted" || sync === null || greeting === null) return "not_greeted";
    // 연결 판단이 배정 후보로 내는 것과 같은 판정(#greetedNow)을 다시 쓴다.
    if (!table.candidates(intake).some((candidate) => candidate.connection === read.connection)) return "other_restore";
    if (sync.principal !== read.executorId) return "other_principal";
    if (greeting.issued_at !== read.issuedAt || !sameRuns(greeting.runs, read.runs)) return "other_greeting";
    // 연결 판단은 인사 뒤 새 정지로 오른 세대를 막지 않는다(비상 종료를 보내야 한다). 장부에 넘기는 것은 맞춘 세대 그대로일 때만이다.
    if (intake.stopGeneration() !== sync.generation) return "stop_generation_changed";
    return null;
  } catch {
    return "other_restore";
  }
}

function readIntake(intake: HelloIntake): boolean {
  try {
    return intake.intakeOpen() === true;
  } catch {
    return false;
  }
}

function sameRuns(a: readonly RunStatus[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((run, i) => {
    const other = b[i] as Record<string, unknown> | null;
    if (typeof other !== "object" || other === null || Object.keys(other).length !== 4) return false;
    return other.run_id === run.run_id && other.state === run.state && other.run_generation === run.run_generation && other.last_receipt_id === run.last_receipt_id;
  });
}

// 다시 넘길 값은 처음 넘긴 값과 같아야 하므로 배열과 항목까지 동결한 사본을 쓴다(RunStatus는 평평한 객체다).
function frozenRuns(runs: readonly RunStatus[]): readonly RunStatus[] {
  return Object.freeze(runs.map((run) => Object.freeze({ run_id: run.run_id, state: run.state, run_generation: run.run_generation, last_receipt_id: run.last_receipt_id }) as RunStatus));
}

// 계약의 머리 시각과 장부의 시각은 1 이상이다. 0을 장부에 넘기면 입력 거절(input_rejected)이 되어 정상 인사가 재시도 없는 실패로 보인다.
function isTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}
