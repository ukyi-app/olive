// D-90 자동 닫기의 한 박자. 실행기가 받은 적 없는 작업자 실행을 고르고, 그 실행기의 마지막 반영 인사(증거 포트)가 조건을 모두 채울 때만
// 장부의 closeUnreceivedRun을 부른다. 닫는 판단은 장부가 한 트랜잭션에서 다시 한다. 이 박자는 후보를 고르고 부를 뿐이다.
// 장부·증거·연결·맡기지 않을 실행기·정지 세대·복원 대기는 포트로, 닫는 시각(now)은 순서기가 다시 읽은 장부 시계로 받는다.
// 소켓·타이머·시계·난수를 직접 부르지 않는다. 쥐는 것은 같은 장부 포트로 박자가 진행 중이라는 표시 하나다(돌아오면 지운다).
//
// 지키는 것(unreceived.md "판단의 차례"):
// 1. 모름은 닫지 않는다. 포트가 던지거나 꼴이 틀리거나 known: false면 그 항목(전역 포트면 박자 전체)은 장부를 부르지 않는다.
// 2. 근거는 그 실행기의 지금 인정된 연결이 낸 검증된 전체 인사 하나다. 연결 번호·주체·맞춘 정지 세대·서명 시각(answeredAt)·전체 목록을
//    한 묶음으로 받고, 받은 시각(receivedAt)은 근거 줄에 적을 값으로만 넘긴다.
// 3. 그 실행기의 앞선 답이 버려진 적이 있거나(tainted) 더 새 답이 줄에 남아 있으면(pending) 닫지 않는다.
// 4. 연결 재확인(links.current)이 장부 호출 전의 마지막 포트 호출이다. 증거 읽기부터 장부 호출까지 await가 없다.
// 5. 장부의 거절·예외·정의 밖의 답은 닫힘으로 세지 않는다. 예외와 정의 밖의 답은 그 자리에서 박자를 멈춘다(장부가 적었는지 모른다).
import { limits, parsePrincipal, type RunStatus } from "../../contract/v1/index.ts";
import { LEDGER_RUN_STATES, type Ledger, REFUSALS as LEDGER_REFUSALS, type LedgerRunState, type Refusal as LedgerRefusal, type Restorer } from "../../ledger/index.ts";
import type { WithheldSource } from "./assign-loop.ts";
import type { AnswerLinks } from "./receipts.ts";

// 장부 포트. 읽기 하나와 닫기 하나다. 다른 쓰기는 받지 않는다.
export type UnreceivedLedger = Pick<Ledger, "unansweredInstructions" | "closeUnreceivedRun">;

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
export type UnreceivedEvidenceRead =
  | { readonly known: false }
  | { readonly known: true; readonly tainted: boolean; readonly pending: boolean; readonly lastFull: UnreceivedFull | null };

// 동기여야 한다: 읽기와 연결 재확인과 장부 호출 사이에 await가 없다.
export interface UnreceivedEvidence {
  read(executorId: string): UnreceivedEvidenceRead;
}

export interface UnreceivedPorts {
  readonly ledger: UnreceivedLedger;
  readonly evidence: UnreceivedEvidence;
  // 내보내기 포트의 answers와 같은 것: 지금의 복원기로 인정된 그 실행기의 연결이 이 번호일 때만 참.
  readonly links: AnswerLinks;
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
  | "read_unknown";

// 박자를 멈춘 이유. threw는 장부 호출이 던졌거나 답이 정의 밖이다. 나머지는 항목마다 다시 본 전역 포트가 박자 처음과 달라졌다.
export type UnreceivedHalt = "threw" | "observations_unsettled" | "stop_generation_unknown" | "stop_generation_mismatch" | "withheld_unknown";

export type UnreceivedSkip =
  // 닫을 수 있는 상태(preparing·unknown_running)가 아니다.
  | "run_state"
  | "not_worker"
  // 지시를 적을 때의 세대나 인사가 맞춘 세대가 지금 세대와 다르다.
  | "stop_generation"
  | "withheld"
  // 증거를 읽지 못했거나 꼴이 틀렸거나 known: false다.
  | "evidence_unknown"
  | "tainted"
  | "pending"
  // 반영된 전체 인사가 없다.
  | "no_full"
  | "principal_mismatch"
  | "answer_too_early"
  | "run_in_answer"
  // 장부를 부르기 직전의 재확인에서 그 인사의 연결이 지금 인정된 연결이 아니다(던짐 포함).
  | "link_not_current";

type Head = { readonly requestId: string; readonly runId: string; readonly executorId: string };

export type UnreceivedOutcome =
  // 장부가 not_started로 닫았다. connection·answeredAt은 근거로 넘긴 인사의 값, at은 넘긴 now다.
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
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isRefusal = (value: unknown): value is LedgerRefusal => (LEDGER_REFUSALS as readonly unknown[]).includes(value);
const isState = (value: unknown): value is LedgerRunState => (LEDGER_RUN_STATES as readonly unknown[]).includes(value);

function isWorkerName(value: unknown): value is string {
  try {
    return typeof value === "string" && parsePrincipal(value)?.kind === "worker_executor";
  } catch {
    return false;
  }
}

// 같은 장부 포트로 진행 중인 박자. 박자 안에 await가 없으므로 겹치는 길은 포트 안에서 다시 부르는 것뿐이다.
const RUNNING = new WeakSet<object>();

export function unreceivedTick(ports: UnreceivedPorts, now: number): UnreceivedTickResult {
  const key = ports.ledger;
  if (RUNNING.has(key)) return { kind: "not_run", reason: "tick_in_progress" };
  RUNNING.add(key);
  try {
    return tickOnce(ports, now);
  } finally {
    RUNNING.delete(key);
  }
}

interface Gate {
  readonly generation: number;
  readonly withheld: ReadonlySet<string>;
}

// 전역 포트 셋. 박자 처음과, 항목마다 증거를 읽은 뒤에 다시 본다(앞 항목의 장부 쓰기나 포트가 같은 동기 구간에서 바꿀 수 있다).
function readGate(ports: UnreceivedPorts): Gate | Exclude<UnreceivedHalt, "threw" | "stop_generation_mismatch"> {
  let settled = false;
  try {
    settled = ports.observationsSettled() === true;
  } catch {
    settled = false;
  }
  if (!settled) return "observations_unsettled";
  let generation: unknown;
  try {
    generation = ports.intake.stopGeneration();
  } catch {
    return "stop_generation_unknown";
  }
  if (!isGeneration(generation)) return "stop_generation_unknown";
  const withheld = readWithheld(ports.withheld);
  if (withheld === null) return "withheld_unknown";
  return { generation, withheld };
}

// 배정 박자(assign-loop.ts의 readWithheld)와 같은 검사다. value는 한 번만 읽고, 원소 하나라도 작업자 실행기 이름이 아니면 모름이다.
function readWithheld(source: WithheldSource): ReadonlySet<string> | null {
  try {
    const answer: unknown = source.executors();
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

function readUnanswered(ledger: UnreceivedLedger): { stopGeneration: number | null; instructions: unknown[] } | null {
  try {
    const answer: unknown = ledger.unansweredInstructions();
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
  readonly full: UnreceivedFull | null;
}

// 증거를 한 번 읽어 칸마다 옮긴다. 목록은 원소까지 복사한다: 뒤의 포트(연결 재확인)가 넘겨준 객체를 고쳐도 장부에 넘기는 값은 읽은 그대로다.
// 칸 하나라도 틀리면(꼴이 아닌 깃발 포함) 모름이다.
function readEvidence(source: UnreceivedEvidence, executorId: string): Evidence | null {
  try {
    const answer: unknown = source.read(executorId);
    if (!isObject(answer) || answer.known !== true) return null;
    const tainted: unknown = answer.tainted;
    const pending: unknown = answer.pending;
    const lastFull: unknown = answer.lastFull;
    if (typeof tainted !== "boolean" || typeof pending !== "boolean") return null;
    if (lastFull === null) return { tainted, pending, full: null };
    if (!isObject(lastFull)) return null;
    const connection: unknown = lastFull.connection;
    const principal: unknown = lastFull.principal;
    const stopGeneration: unknown = lastFull.stopGeneration;
    const runs: unknown = lastFull.runs;
    const answeredAt: unknown = lastFull.answeredAt;
    const receivedAt: unknown = lastFull.receivedAt;
    if (!isGeneration(connection) || typeof principal !== "string" || !isGeneration(stopGeneration) || !isTime(answeredAt) || !isTime(receivedAt)) return null;
    if (!Array.isArray(runs)) return null;
    const copied: RunStatus[] = [];
    const length = runs.length;
    for (let i = 0; i < length; i += 1) {
      const item: unknown = runs[i];
      if (!isObject(item)) return null;
      const copy: Record<string, unknown> = { ...item };
      if (typeof copy.run_id !== "string") return null;
      copied.push(copy as RunStatus);
    }
    return { tainted, pending, full: { connection, principal, stopGeneration, runs: copied, answeredAt, receivedAt } };
  } catch {
    return null;
  }
}

function linkCurrent(links: AnswerLinks, connection: number, executorId: string): boolean {
  try {
    return links.current(connection, executorId) === true;
  } catch {
    return false;
  }
}

type Judged = { readonly outcome: UnreceivedOutcome | null; readonly halt: UnreceivedHalt | null };

function tickOnce(ports: UnreceivedPorts, now: number): UnreceivedTickResult {
  if (!isTime(now)) return { kind: "not_run", reason: "now_malformed" };
  const first = readGate(ports);
  if (typeof first === "string") return { kind: "not_run", reason: first };
  const read = readUnanswered(ports.ledger);
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
    const judged = judge(ports, item, ledgerGeneration, now);
    if (judged.outcome !== null) runs.push(judged.outcome);
    if (judged.halt !== null) return { kind: "ran", runs, halted: judged.halt, haltedAt: item.requestId };
  }
  return { kind: "ran", runs, halted: null, haltedAt: null };
}

// 항목 하나의 판단. 포트를 부르는 차례는 증거 → 전역 포트(복원 대기·정지 세대·맡기지 않을 실행기) → 연결 재확인 → 장부이고,
// 그 사이의 비교는 읽어 둔 값만 쓴다. 연결 재확인 뒤에는 장부 호출 말고 아무 포트도 부르지 않는다.
function judge(ports: UnreceivedPorts, item: StartItem, ledgerGeneration: number, now: number): Judged {
  const head: Head = { requestId: item.requestId, runId: item.runId, executorId: item.executorId };
  const skip = (reason: UnreceivedSkip): Judged => ({ outcome: { ...head, outcome: "skipped", reason }, halt: null });
  if (!CLOSABLE.includes(item.runState)) return skip("run_state");
  if (!isWorkerName(item.executorId)) return skip("not_worker");

  const evidence = readEvidence(ports.evidence, item.executorId);
  const gate = readGate(ports);
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

  // 마지막 포트 호출. 증거를 읽은 뒤 같은 주체의 새 연결이 옛 연결을 밀어냈거나, 앞 항목의 장부 쓰기가 복원기의 세대를 지워 인정이
  // 끝났을 수 있다(await가 없어도 바뀐다). 장부를 부를 때마다 그 직전에 다시 본다.
  if (!linkCurrent(ports.links, full.connection, item.executorId)) return skip("link_not_current");

  let answer: unknown;
  try {
    answer = ports.ledger.closeUnreceivedRun(
      { runId: item.runId, runs: full.runs, answeredAt: full.answeredAt, receivedAt: full.receivedAt, now },
      { sender: item.executorId },
    );
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
    if (!isObject(run) || run.runId !== item.runId || run.state !== "not_started") return malformed;
    return { outcome: { ...head, outcome: "closed", connection: full.connection, answeredAt: full.answeredAt, at: now }, halt: null };
  } catch {
    return malformed;
  }
}
