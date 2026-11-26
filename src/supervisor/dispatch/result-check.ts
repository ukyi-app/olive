// 결과 검사의 한 박자. checking에 머문 작업자 실행마다 반영 전 결과 보고를 모으고, 판정 자리(resultVerdict)가 통과로 낸 결과만
// 장부의 markResult로 ready_result에 옮긴다. 반영 전 결과 보고가 없는 실행은 실행기가 대조된 조회 답에서 그 종료 영수증 그대로
// failed_stopped라고 말했을 때만 markResult(null)로 failed_stopped에 옮긴다(D-147, 아래 7번). 확정(result_finalize)은 이 박자가 아니라
// 수명 박자가 settledResult·failedStop을 보고 낸다.
// 장부·접수·박자 유효 문은 포트로, 판정 시각(now)은 순서기가 부르기 직전에 다시 읽은 장부 시계로 받는다.
// 소켓·타이머·시계·난수를 직접 부르지 않는다. 쥐는 것은 이 모듈의 박자가 진행 중이라는 표시 하나다(돌아오면 지운다).
//
// 지키는 것(result-check.md "판단의 차례"):
// 1. 모름은 판정하지 않는다. 실행 목록이나 반영 전 보고 목록을 읽지 못하거나 한 줄이라도 칸을 읽지 못하면 장부를 부르지 않는다.
//    보고 한 줄을 건너뛰고 판정하면 그 실행의 다른 digest를 보지 못한 채 판정해, 장부가 그 보고를 충돌로 닫는다.
// 2. 판정은 그 실행의 반영 전 결과 보고가 정확히 한 digest일 때만이다. 다른 digest가 함께 있으면 판정하지 않고 digest_conflict로 남긴다.
// 3. markResult에는 늘 그 보고의 reportId를 넘긴다. 장부가 그 보고가 이 실행의 반영 전 보고이고 digest가 같은지 대조해(아니면
//    reference_mismatch) 판정이 이 박자가 본 보고를 정확히 가리킨다. 확정을 여는 데에는 필요 없다: 빠져도 장부는 판정하면서
//    그 실행의 반영 전 결과 보고를 모두 반영한다.
// 4. 접수가 닫혔으면(복원 전·정지 중·허가 폐기) 판정하지 않는다. 박자 처음과, 장부 호출마다 그 바로 앞의 문 안에서 본다.
// 5. 장부 호출은 장부 포트 수신자·메서드·인자 얻기 → 문(접수 → 박자 유효 문) → 호출 하나다(send-gate.ts의 callAfterGate).
//    문 뒤에는 외부 코드가 없고, 읽기부터 호출까지 await가 없다.
// 6. 장부가 던지거나 답이 정의 밖이면 그 자리에서 박자를 멈춘다(판정이 적혔는지 모른다). 거절은 그 실행의 결과이고 박자는 이어 간다.
// 7. 결과 없음 판정(markResult(null))은 반영 전 결과 보고가 하나도 없는 실행에만, 같은 동기 구간에서 읽은 실행 줄의 지정 실행기·실행 세대·
//    종료 영수증 ID가 실행기의 failed_stopped 답(StoppedAnswer)의 낸 쪽·세대·last_receipt_id와 모두 같을 때만 부른다. 기한·연결 시각은
//    보지 않는다. 장부는 결과 없음 판정 때 그 실행의 반영 전 결과 보고를 반영된 것으로 닫으므로(ledger.ts markResult) 보고가 있으면 늘 보고
//    쪽 판정(2·3번)이 먼저다.
import { LEDGER_RUN_STATES, type Ledger, REFUSALS as LEDGER_REFUSALS, type LedgerRunState, type Refusal as LedgerRefusal, type Restorer } from "../../ledger/index.ts";
import type { ReceiptOutcome } from "./receipts.ts";
import { callAfterGate, holdBeatValid } from "./send-gate.ts";

export interface ResultCheckPorts {
  // 읽기 둘과 판정 쓰기 하나. 박자들이 쓰는 그 장부 객체여야 한다.
  readonly ledger: Pick<Ledger, "listRuns" | "pendingReports" | "markResult">;
  // 조립의 접수 문(박자 유효 문 + 복원기의 접수). 복원 5단계 전·정지 중·허가 폐기면 거짓이다.
  readonly intake: Pick<Restorer, "intakeOpen">;
  // 이 박자가 아직 유효한가. 장부 호출 바로 앞에서 본다. 빠지면 늘 유효다(이 부품 단독의 쓰임). 조립은 반드시 넘긴다.
  readonly beatValid?: () => boolean;
  // 답 줄이 적은 실행기의 failed_stopped 답(7번). 빠지면 결과 없음 판정을 하지 않는다(그 실행은 checking으로 자리를 쥔다). 조립은 넘긴다.
  readonly stopped?: Pick<StoppedAnswerBook, "answers" | "retain">;
}

// 실행기가 대조된 조회 답(receipts.ts의 status_matched)에서 그 실행을 failed_stopped라고 말한 것 하나. executorId는 검증된 답 봉투의
// 낸 쪽, runGeneration·lastReceiptId는 그 실행 항목의 칸 그대로다. 실행기는 결과 보고가 있는 실행을 ready_result로, 종료 확인 뒤 결과
// 보고가 없는 실행을 failed_stopped로 답하고 failed_stopped 뒤에 결과 보고를 만들지 않는다(src/contract/v1.md "실행 상태 항목").
// 그래서 이 값은 낡아도(늦게 온 답, 먼저 낸 조회의 답) 거짓이 되지 않는다. 판정은 이 값이 지금 장부의 그 종료와 같은지만 본다.
export interface StoppedAnswer {
  readonly runId: string;
  readonly executorId: string;
  readonly runGeneration: number;
  readonly lastReceiptId: string;
}

// 답 줄이 적고(note) 결과 검사 박자가 읽는(answers·retain) 자리. 실행마다 마지막에 적은 하나만 쥔다. 감독 프로세스의 메모리뿐이라 다시
// 뜨면 비고, 수명 박자의 다음 조회(result_wait)의 답이 다시 채운다.
export interface StoppedAnswerBook {
  note(answer: StoppedAnswer): void;
  answers(): readonly StoppedAnswer[];
  // 멈추지 않고 돈 결과 검사 박자가 그 박자의 checking 실행 ID로 부른다. 밖의 것은 버린다: checking으로 돌아오는 전이가 없다.
  retain(runIds: ReadonlySet<string>): void;
}

export function createStoppedAnswerBook(): StoppedAnswerBook {
  const held = new Map<string, StoppedAnswer>();
  return {
    note(answer) {
      const { runId, executorId, runGeneration, lastReceiptId } = answer;
      held.set(runId, Object.freeze({ runId, executorId, runGeneration, lastReceiptId }));
    },
    answers: () => [...held.values()],
    retain(runIds) {
      for (const runId of [...held.keys()]) if (!runIds.has(runId)) held.delete(runId);
    },
  };
}

// 영수증 처리기의 결과에서 적을 답을 고른다. 대조된 답(status_matched)이고 그 답 자신이 지금 연결의 답으로 장부에 반영됐을 때(settled의
// 마지막, 곧 이번 답이 applied)만 본다. 인정이 끝난 연결의 답(status_not_current), 대조되지 않은 답, 밀린 사본, 저장되지 않은 답은 고르지
// 않는다: 그 실행은 다음 조회로 다시 묻는다. 항목은 failed_stopped이고 실행 ID·세대(1 이상)·마지막 영수증 ID가 꼴에 맞는 것만이다.
// 고르지 못하면 빈 목록이다(판정이 늦어질 뿐 결과를 잃지 않는다).
export function stoppedAnswersOf(outcome: ReceiptOutcome): StoppedAnswer[] {
  try {
    if (outcome.outcome !== "status_matched") return [];
    const last = outcome.settled.at(-1);
    if (last === undefined || last.settled !== "applied") return [];
    const { sender, runs } = last.answer;
    if (sender !== outcome.executor || typeof sender !== "string" || sender === "" || !Array.isArray(runs)) return [];
    const picked: StoppedAnswer[] = [];
    for (const run of runs) {
      if (!isObject(run)) continue;
      const { run_id: runId, state, run_generation: runGeneration, last_receipt_id: lastReceiptId } = run as unknown as Record<string, unknown>;
      if (state !== "failed_stopped" || !isUuid(runId) || !isGeneration(runGeneration) || !isUuid(lastReceiptId)) continue;
      picked.push({ runId, executorId: sender, runGeneration, lastReceiptId });
    }
    return picked;
  } catch {
    return [];
  }
}

// 판정 자리가 보는 반영 전 결과 보고 하나. 장부의 pendingReports가 낸 차례(받은 시각, id) 그대로 넘긴다.
export interface PendingResult {
  readonly reportId: string;
  readonly resultDigest: string;
  readonly storedRef: string;
}

export type ResultVerdict =
  // 그 digest로 판정한다. reportId는 그 digest의 첫 보고다(같은 digest의 나머지는 장부가 함께 반영한다).
  | { readonly kind: "pass"; readonly resultDigest: string; readonly reportId: string }
  // 반영 전 결과 보고가 없다. 판정하지 않고 기다린다.
  | { readonly kind: "wait" }
  // 서로 다른 digest의 보고가 함께 있다. 판정하지 않는다. digests는 서로 다른 digest의 수다.
  | { readonly kind: "conflict"; readonly digests: number };

// 결과 검사의 판정 자리. 관리자 결정을 기다리는 세 가지가 모두 여기서 갈린다:
// - 보고가 없는 checking(Q-H3): 기다린다. 기한과 결과 없음 판정은 정하지 않았다.
// - 감독이 직접 검사할 범위(Q-H1): 반영 전 결과 보고가 정확히 한 digest인지만 본다.
// - 결과 outcome이 failed·needs_input인 결과(Q-H5): 장부의 보고 줄에는 outcome이 없고 이 박자는 보관소 본문을 읽지 않으므로,
//   digest가 있는 결과는 모두 통과다. outcome으로 가르려면 보관소 읽기 포트가 함께 필요하다.
export function resultVerdict(reports: readonly PendingResult[]): ResultVerdict {
  const first = reports[0];
  if (first === undefined) return { kind: "wait" };
  const digests = new Set(reports.map((report) => report.resultDigest));
  if (digests.size > 1) return { kind: "conflict", digests: digests.size };
  return { kind: "pass", resultDigest: first.resultDigest, reportId: first.reportId };
}

export type ResultCheckNotRun =
  | "now_malformed"
  | "tick_in_progress"
  // 박자 처음의 접수 문이 닫혔거나 읽지 못했다.
  | "intake_closed"
  // 장부 읽기를 모른다(포트를 얻지 못함, known이 true가 아님, 줄의 칸을 읽지 못하거나 꼴이 틀림, 같은 ID의 줄이 둘).
  | "read_unknown";

export type ResultCheckHalt =
  // 장부 호출이 던졌거나 답이 정의 밖이다.
  | "threw"
  // 장부 호출 직전의 접수 문이 닫혔다(그 실행의 장부 호출은 0회).
  | "intake_closed"
  // 장부 호출 바로 앞의 박자 유효 문이 닫혔다(그 실행의 장부 호출은 0회).
  | "beat_closed";

export type ResultCheckOutcome =
  // 장부가 판정을 적었다고 답했다. state는 답의 실행 줄 상태다.
  | { readonly runId: string; readonly outcome: "judged"; readonly reportId: string; readonly resultDigest: string; readonly state: LedgerRunState }
  // 반영 전 결과 보고가 없다(Q-H3 대기). 장부를 부르지 않았다.
  | { readonly runId: string; readonly outcome: "waiting" }
  // 서로 다른 digest의 반영 전 결과 보고가 있다. 장부를 부르지 않았다. 조립이 감독 기록에 경보 한 줄을 남긴다.
  | { readonly runId: string; readonly outcome: "digest_conflict"; readonly digests: number; readonly reports: number }
  | { readonly runId: string; readonly outcome: "refused"; readonly reportId: string; readonly reason: LedgerRefusal }
  // 장부가 적었는지 모른다. 장부의 문구는 싣지 않는다.
  | { readonly runId: string; readonly outcome: "ledger_failed"; readonly reportId: string; readonly reason: "threw" | "malformed_answer" }
  // 결과 없음 판정(7번). 장부가 failed_stopped로 옮겼다고 답했다. lastReceiptId는 판정의 근거가 된 답의 마지막 영수증 ID(= 장부의 종료 영수증 ID)다.
  | { readonly runId: string; readonly outcome: "judged_no_result"; readonly lastReceiptId: string }
  // 결과 없음 판정을 장부가 거절했다(그 사이 다른 판정이 적혔으면 transition_denied).
  | { readonly runId: string; readonly outcome: "no_result_refused"; readonly reason: LedgerRefusal }
  // 결과 없음 판정을 장부가 적었는지 모른다. 박자를 멈춘다.
  | { readonly runId: string; readonly outcome: "no_result_failed"; readonly reason: "threw" | "malformed_answer" };

export type ResultCheckTickResult =
  | { readonly kind: "not_run"; readonly reason: Exclude<ResultCheckNotRun, "read_unknown"> }
  | { readonly kind: "not_run"; readonly reason: "read_unknown"; readonly read: "runs" | "reports" }
  | {
      readonly kind: "ran";
      // checking인 작업자 실행마다 하나, 실행 목록의 차례대로. 멈췄으면 멈춘 실행(장부를 불렀으면)까지 있고 그 뒤는 없다.
      readonly runs: readonly ResultCheckOutcome[];
      readonly halted: ResultCheckHalt | null;
      readonly haltedAt: string | null;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPORT_ACTIONS: readonly unknown[] = ["report_result", "report_session_broken", "report_hook_event"];
// 판정이 끝난 실행의 상태. 장부는 판정이 끝난 실행에 같은 digest와 reportId로 부르면 상태를 되돌리지 않고 보고만 마친다.
const JUDGED: readonly unknown[] = ["ready_result", "cleanup_pending", "finalized"];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isRefusal = (value: unknown): value is LedgerRefusal => (LEDGER_REFUSALS as readonly unknown[]).includes(value);
const isState = (value: unknown): value is LedgerRunState => (LEDGER_RUN_STATES as readonly unknown[]).includes(value);
const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

// 진행 중인 박자. 박자 안에 await가 없으므로 겹치는 길은 포트 안에서 다시 부르는 것뿐이다. 장부 객체로 가르지 않고 모듈 단위로 세운다:
// 장부 객체를 얻는 ports.ledger 접근자도 외부 코드다.
let running = false;

export function resultCheckTick(ports: ResultCheckPorts, now: number): ResultCheckTickResult {
  if (running) return { kind: "not_run", reason: "tick_in_progress" };
  running = true;
  try {
    return tickOnce(ports, now);
  } finally {
    running = false;
  }
}

// 접수 문. 던지거나 true가 아니면 닫힘이다(모름을 열림으로 읽지 않는다).
function intakeOpen(ports: ResultCheckPorts): boolean {
  try {
    return ports.intake.intakeOpen() === true;
  } catch {
    return false;
  }
}

// 박자 유효 문을 부를 때마다 칸을 한 번 읽고 포트 묶음을 수신자로 부른다(send-gate.ts의 holdBeatValid).
function beatValid(ports: ResultCheckPorts): boolean {
  return holdBeatValid(ports)();
}

// checking 실행 줄에서 결과 없음 판정(7번)에 대조할 칸. 칸 하나라도 읽지 못하거나 꼴이 틀리면 null이고 그 실행은 결과 없음 판정을 하지
// 않는다(보고 쪽 판정은 그대로 한다).
type StopFacts = { readonly executorId: string; readonly runGeneration: number; readonly stopReceiptId: string };
type CheckingRun = { readonly runId: string; readonly stop: StopFacts | null };

function stopFactsOf(row: Record<string, unknown>): StopFacts | null {
  try {
    const executorId: unknown = row.executorId;
    const runGeneration: unknown = row.runGeneration;
    const stopReceiptId: unknown = row.stopReceiptId;
    if (typeof executorId !== "string" || executorId === "" || !isGeneration(runGeneration) || !isUuid(stopReceiptId)) return null;
    return { executorId, runGeneration, stopReceiptId };
  } catch {
    return null;
  }
}

// checking인 작업자 실행을 실행 목록의 차례대로. 모든 줄의 실행 ID·종류·상태를 칸마다 한 번 읽는다. 한 줄이라도 읽지 못하거나
// 꼴이 틀리거나 같은 실행 ID가 둘이면 목록 전체가 모름이다(그 줄이 checking 실행일 수 있다).
function readChecking(ports: ResultCheckPorts): CheckingRun[] | null {
  try {
    const answer: unknown = ports.ledger.listRuns();
    if (!isObject(answer) || answer.known !== true) return null;
    const value: unknown = answer.value;
    if (!Array.isArray(value)) return null;
    const seen = new Set<string>();
    const checking: CheckingRun[] = [];
    const length = value.length;
    for (let index = 0; index < length; index += 1) {
      const row: unknown = value[index];
      if (!isObject(row)) return null;
      const runId: unknown = row.runId;
      const kind: unknown = row.kind;
      const state: unknown = row.state;
      if (!isUuid(runId) || (kind !== "worker" && kind !== "session") || !isState(state) || seen.has(runId)) return null;
      seen.add(runId);
      if (kind === "worker" && state === "checking") checking.push({ runId, stop: stopFactsOf(row) });
    }
    return checking;
  } catch {
    return null;
  }
}

// 반영 전 결과 보고를 실행마다 장부의 차례대로 모은다. 결과 밖의 보고(세션 깨짐·훅)는 동작 칸만 본다. 결과 보고는 실행 ID·저장 자리·
// digest를 칸마다 한 번 읽고, 하나라도 꼴이 틀리거나 같은 보고 ID가 둘이면 목록 전체가 모름이다(1번).
function readPending(ports: ResultCheckPorts): Map<string, PendingResult[]> | null {
  try {
    const answer: unknown = ports.ledger.pendingReports();
    if (!isObject(answer) || answer.known !== true) return null;
    const value: unknown = answer.value;
    if (!Array.isArray(value)) return null;
    const seen = new Set<string>();
    const byRun = new Map<string, PendingResult[]>();
    const length = value.length;
    for (let index = 0; index < length; index += 1) {
      const row: unknown = value[index];
      if (!isObject(row)) return null;
      const reportId: unknown = row.reportId;
      const action: unknown = row.action;
      if (!isUuid(reportId) || !REPORT_ACTIONS.includes(action) || seen.has(reportId)) return null;
      seen.add(reportId);
      if (action !== "report_result") continue;
      const runId: unknown = row.runId;
      const storedRef: unknown = row.storedRef;
      const resultDigest: unknown = row.resultDigest;
      if (!isUuid(runId) || typeof storedRef !== "string" || storedRef.length === 0 || typeof resultDigest !== "string" || !SHA256.test(resultDigest)) return null;
      const list = byRun.get(runId) ?? [];
      list.push({ reportId, resultDigest, storedRef });
      byRun.set(runId, list);
    }
    return byRun;
  } catch {
    return null;
  }
}

type Judged = { readonly outcome: ResultCheckOutcome | null; readonly halt: ResultCheckHalt | null };

function tickOnce(ports: ResultCheckPorts, now: number): ResultCheckTickResult {
  if (!isTime(now)) return { kind: "not_run", reason: "now_malformed" };
  if (!intakeOpen(ports)) return { kind: "not_run", reason: "intake_closed" };
  const checking = readChecking(ports);
  if (checking === null) return { kind: "not_run", reason: "read_unknown", read: "runs" };
  const pending = readPending(ports);
  if (pending === null) return { kind: "not_run", reason: "read_unknown", read: "reports" };

  const answers = readStopped(ports);
  const runs: ResultCheckOutcome[] = [];
  for (const { runId, stop } of checking) {
    const verdict = resultVerdict(pending.get(runId) ?? []);
    if (verdict.kind === "wait") {
      const answer = answers.get(runId);
      if (answer === undefined || !sameStop(answer, stop)) {
        runs.push({ runId, outcome: "waiting" });
        continue;
      }
      const judged = markStopped(ports, runId, answer.lastReceiptId, now);
      if (judged.outcome !== null) runs.push(judged.outcome);
      if (judged.halt !== null) return { kind: "ran", runs, halted: judged.halt, haltedAt: runId };
      continue;
    }
    if (verdict.kind === "conflict") {
      runs.push({ runId, outcome: "digest_conflict", digests: verdict.digests, reports: pending.get(runId)?.length ?? 0 });
      continue;
    }
    const judged = mark(ports, runId, verdict, now);
    if (judged.outcome !== null) runs.push(judged.outcome);
    if (judged.halt !== null) return { kind: "ran", runs, halted: judged.halt, haltedAt: runId };
  }
  retainStopped(ports, new Set(checking.map((run) => run.runId)));
  return { kind: "ran", runs, halted: null, haltedAt: null };
}

// 답 줄이 적은 failed_stopped 답을 실행 ID로. 포트가 없거나 읽다 던지거나 꼴이 틀리면 그 항목(목록을 읽지 못하면 전부)을 없는 것으로
// 둔다: 답이 없는 실행은 결과 없음 판정을 하지 않으므로 모름이 판정 쪽으로 기울지 않는다.
function readStopped(ports: ResultCheckPorts): Map<string, StoppedAnswer> {
  const byRun = new Map<string, StoppedAnswer>();
  try {
    const book = ports.stopped;
    if (book === undefined) return byRun;
    const list: unknown = book.answers();
    if (!Array.isArray(list)) return byRun;
    for (const item of list as unknown[]) {
      if (!isObject(item)) continue;
      const { runId, executorId, runGeneration, lastReceiptId } = item;
      if (!isUuid(runId) || typeof executorId !== "string" || executorId === "" || !isGeneration(runGeneration) || !isUuid(lastReceiptId)) continue;
      byRun.set(runId, { runId, executorId, runGeneration, lastReceiptId });
    }
  } catch {
    byRun.clear();
  }
  return byRun;
}

// 7번의 대조. 답의 낸 쪽이 실행 줄의 지정 실행기이고, 그 항목의 세대가 실행 줄의 세대이고, 그 항목의 마지막 영수증 ID가 장부에 적힌
// 그 실행의 종료 영수증 ID일 때만 참이다(결과 보고 ID는 last_receipt_id에 들지 않는다). 함정: 실행기는 종료 뒤에 닿은 취소에도 접수
// 영수증을 내고 그 ID가 last_receipt_id가 된다. 그 답은 같은 종료를 가리킨다고 증명하지 못하므로 판정하지 않는다(자리를 쥔다).
function sameStop(answer: StoppedAnswer, stop: StopFacts | null): boolean {
  return stop !== null && answer.executorId === stop.executorId && answer.runGeneration === stop.runGeneration && answer.lastReceiptId === stop.stopReceiptId;
}

// 멈추지 않고 돈 박자 뒤에만 부른다(멈춘 박자의 목록은 일부다). 던져도 박자의 결과는 그대로다(남은 답은 다음 박자에 다시 대조된다).
function retainStopped(ports: ResultCheckPorts, runIds: ReadonlySet<string>): void {
  try {
    ports.stopped?.retain(runIds);
  } catch {
    // 버리지 못한 답은 그 실행이 checking이 아니면 대조될 곳이 없다.
  }
}

// 결과 없음 판정 하나(7번). 보고 판정(mark)과 같은 문·같은 호출 차례이고 reportId를 넘기지 않는다. 장부의 답은 그 실행이 failed_stopped이고
// 결과 digest가 없을 때만 판정으로 읽는다.
function markStopped(ports: ResultCheckPorts, runId: string, lastReceiptId: string, now: number): Judged {
  const shut: { halt: Exclude<ResultCheckHalt, "threw"> } = { halt: "beat_closed" };
  const call = callMark(ports, { runId, resultDigest: null, now }, shut);
  if (call.kind === "closed") return { outcome: null, halt: shut.halt };
  const failed = (reason: "threw" | "malformed_answer"): Judged => ({ outcome: { runId, outcome: "no_result_failed", reason }, halt: "threw" });
  if (call.kind === "threw") return failed("threw");
  try {
    const answer: unknown = call.value;
    if (!isObject(answer)) return failed("malformed_answer");
    const ok: unknown = answer.ok;
    if (ok === false) {
      const reason: unknown = answer.reason;
      return isRefusal(reason) ? { outcome: { runId, outcome: "no_result_refused", reason }, halt: null } : failed("malformed_answer");
    }
    if (ok !== true) return failed("malformed_answer");
    const run: unknown = answer.run;
    if (!isObject(run)) return failed("malformed_answer");
    const answeredId: unknown = run.runId;
    const state: unknown = run.state;
    const digest: unknown = run.resultDigest;
    if (answeredId !== runId || state !== "failed_stopped" || digest !== null) return failed("malformed_answer");
    return { outcome: { runId, outcome: "judged_no_result", lastReceiptId }, halt: null };
  } catch {
    return failed("malformed_answer");
  }
}

// 결과 기다림 경보(D-151)의 기본 한도. 잠정값이다: T1 다음 바퀴에서 checking에 머문 시간을 잰 뒤 정한다. 판정에 쓰지 않으므로 틀려도
// 결과를 잃지 않는다(경보가 이르거나 늦을 뿐이다).
export const RESULT_WAIT_ALERT_MS = 90_000;

// checking에 오래 머문 실행을 고르는 경보 자리(D-151). 장부를 읽거나 쓰지 않고 판정하지 않는다. 결과 검사 박자의 결과와 그 박자 뒤에
// 읽은 장부 시계를 받아, 이번에 경보할 실행과 머문 시간을 낸다. 머문 시간은 이 자리가 그 실행을 checking으로 처음 본 박자부터 센다:
// 감독이 다시 뜨면 다시 센다(경보가 늦어질 뿐이다). 같은 실행에는 한 번만 낸다: 보고·답이 끝내 오지 않는 실행은 관리자가 손댈 때까지
// 박자마다 같은 상태로 남아, 거르지 않으면 박자 수만큼 같은 줄이 쌓인다. 그 실행이 checking을 떠나면 기억에서 뺀다.
export interface ResultWaitAlarm {
  observe(result: ResultCheckTickResult, now: number): readonly { readonly runId: string; readonly waitedMs: number }[];
}

// 판정으로 checking을 떠난 결과. 나머지(기다림·충돌·거절·장부 고장)는 박자 처음에 checking이었고 떠났는지 모르므로 계속 센다.
const LEFT_CHECKING: readonly ResultCheckOutcome["outcome"][] = ["judged", "judged_no_result"];

export function createResultWaitAlarm(limitMs: number): ResultWaitAlarm {
  if (!Number.isSafeInteger(limitMs) || limitMs <= 0) throw new RangeError("결과 기다림 경보 한도는 양의 정수 ms여야 한다");
  const firstSeen = new Map<string, number>();
  const alerted = new Set<string>();
  return {
    observe(result, now) {
      if (result.kind !== "ran" || !Number.isSafeInteger(now)) return [];
      const staying = result.runs.filter((run) => !LEFT_CHECKING.includes(run.outcome)).map((run) => run.runId);
      const due: { runId: string; waitedMs: number }[] = [];
      for (const runId of staying) {
        const first = firstSeen.get(runId) ?? now;
        firstSeen.set(runId, first);
        const waitedMs = now - first;
        if (waitedMs >= limitMs && !alerted.has(runId)) {
          alerted.add(runId);
          due.push({ runId, waitedMs });
        }
      }
      // 멈춘 박자의 목록은 멈춘 실행까지라 그 뒤의 checking 실행이 빠져 있다. 그때는 줄이지 않는다.
      if (result.halted === null) {
        const kept = new Set(staying);
        for (const runId of [...firstSeen.keys()]) if (!kept.has(runId)) firstSeen.delete(runId);
        for (const runId of [...alerted]) if (!kept.has(runId)) alerted.delete(runId);
      }
      return due;
    },
  };
}

// 장부 호출 바로 앞의 문. 접수 문을 장부 포트·메서드 얻기 뒤에 둔다: 얻기의 접근자 안에서 정지가 적용돼도 판정을 적지 않는다(장부는
// 판정을 정지 중에도 받는다). 박자 유효 문을 맨 끝에 두어 접수 문 안의 읽기에 쓴 시간까지 박자 기한 비교에 든다.
function gateOpen(ports: ResultCheckPorts, shut: { halt: Exclude<ResultCheckHalt, "threw"> }): boolean {
  if (!intakeOpen(ports)) {
    shut.halt = "intake_closed";
    return false;
  }
  shut.halt = "beat_closed";
  return beatValid(ports);
}

// 판정 쓰기 하나. 보고 판정(mark)과 결과 없음 판정(markStopped)이 이 한 줄로만 장부를 부른다: 장부 포트 수신자·메서드·인자 얻기 → 문 → 호출.
function callMark(ports: ResultCheckPorts, markInput: Parameters<Ledger["markResult"]>[0], shut: { halt: Exclude<ResultCheckHalt, "threw"> }) {
  const call = callAfterGate(() => { const ledger = ports.ledger; return { receiver: ledger, fn: ledger.markResult, args: [markInput] }; }, () => gateOpen(ports, shut));
  return call;
}

// 판정 하나. 인자는 문보다 먼저 만든다. callAfterGate가 장부 포트 수신자·메서드·인자 원소를 얻고 → 문 → 호출 하나다.
// 답의 칸은 예외 처리 안에서 칸마다 한 번만 읽는다.
function mark(ports: ResultCheckPorts, runId: string, verdict: Extract<ResultVerdict, { kind: "pass" }>, now: number): Judged {
  const { reportId, resultDigest } = verdict;
  const shut: { halt: Exclude<ResultCheckHalt, "threw"> } = { halt: "beat_closed" };
  const call = callMark(ports, { runId, resultDigest, reportId, now }, shut);
  if (call.kind === "closed") return { outcome: null, halt: shut.halt };
  const failed = (reason: "threw" | "malformed_answer"): Judged => ({ outcome: { runId, outcome: "ledger_failed", reportId, reason }, halt: "threw" });
  if (call.kind === "threw") return failed("threw");
  try {
    const answer: unknown = call.value;
    if (!isObject(answer)) return failed("malformed_answer");
    const ok: unknown = answer.ok;
    if (ok === false) {
      const reason: unknown = answer.reason;
      return isRefusal(reason) ? { outcome: { runId, outcome: "refused", reportId, reason }, halt: null } : failed("malformed_answer");
    }
    if (ok !== true) return failed("malformed_answer");
    const run: unknown = answer.run;
    if (!isObject(run)) return failed("malformed_answer");
    const answeredId: unknown = run.runId;
    const state: unknown = run.state;
    const digest: unknown = run.resultDigest;
    if (answeredId !== runId || digest !== resultDigest || !isState(state) || !JUDGED.includes(state)) return failed("malformed_answer");
    return { outcome: { runId, outcome: "judged", reportId, resultDigest, state }, halt: null };
  } catch {
    return failed("malformed_answer");
  }
}
