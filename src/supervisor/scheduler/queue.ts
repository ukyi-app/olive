// 종류(작업자·세션)마다 다음에 시작해 볼 대기 실행 하나를 고르는 순수 판단. 상태를 갖지 않는다:
// 장부에서 읽은 실행·입력·점유 관측과 지금 시각을 인자로 받아 계산만 한다. 장부를 열거나 쓰지 않는다.
//
// 시작 후보(StartCandidate)는 실행 허가가 아니다. 실제 시작은 장부의 startRun이 정지·세대·기한·점유를
// 같은 트랜잭션에서 다시 본 뒤에만 된다. 부르는 쪽은 후보를 받아도 startRun의 거절을 그대로 따른다.
//
// 틀리는 방향은 늘 "시작하지 않음"이다. 종료를 확인하지 못한 실행, 출처를 모르는 입력, 앞 실행보다 많은 예산은 보류다.
// 값이 빠졌거나 꼴이 틀리면(유한하지 않은 시각, 0 이상의 안전 정수가 아닌 잔액, 등록되지 않은 출처) 모름으로 보고 보류한다.
import { type LedgerRunState, type Run, type RunKind, SLOT_FREE, type SlotHold, type StartBar } from "../../ledger/index.ts";

// 입력의 인증된 출처 종류. 장부의 inputs.source(인증된 출처 이름)를 관리자 요청과 자동 경보로 나눈 것이다.
// 나누는 규칙은 이 판단 밖(접수 쪽)의 일이고, 요청 본문으로 정하지 않는다.
export type Origin = "admin" | "alert";
const ORIGINS: readonly unknown[] = ["admin", "alert"] satisfies Origin[];

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isBudget = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// 이 판단이 실행 줄에서 읽는 칸. 모두 장부의 Run에 있는 칸이고 상태 이름도 장부 그대로다.
// startBar는 queueView()가 대기 실행에 붙여 주는 값이다. 끝난 실행처럼 장부가 붙이지 않는 줄은 null을 넣는다.
// closedByOperator는 not_started 줄이 관리자가 실패로 닫은 줄인가(장부의 listRuns가 싣는다). budgetBar만 읽는다.
export type SchedulerRun = Pick<Run, "runId" | "kind" | "role" | "state" | "queueSeq" | "inputRequestId" | "deadlineAt" | "budgetLeft" | "closedByOperator"> & {
  startBar: StartBar | null;
};

// 실행 줄에 연결된 입력. 장부의 inputs 표에 있는 칸만 둔다(원문은 없다. 본문으로 우선순위를 정하지 않기 위해 타입에 없다).
// queueView()는 출처와 접수 시각을 내주지 않는다. 장부의 listInputs()가 출처 이름(source)과 receivedAt을 내고, 출처 이름을
// origin으로 나누는 것은 접수 정책의 몫이다. 부르는 쪽이 채우지 못하면 이 항목을 넣지 않는다
// (그러면 그 실행은 input_unknown으로 보류된다). 넣었더라도 칸이 빠졌거나 꼴이 틀리면 같은 보류다.
export interface SchedulerInput {
  requestId: string;
  origin: Origin;
  receivedAt: number;
  expiresAt: number;
  cancelled: boolean;
}

export interface SchedulerView {
  // 장부의 실행 줄. 같은 입력의 실행 줄을 끝난 실행과 뒤 순번까지 포함해 전부 넣는다(listRuns()의 범위).
  // 줄이 하나 빠지면 그 줄의 소진을 볼 수 없어 막혀야 할 실행이 후보가 될 수 있고, 이 판단은 빠진 줄을 알아차리지 못한다.
  // queueView·listRuns·slotHolds 중 하나라도 known이 false면 부르는 쪽이 이 판단을 부르지 않는다.
  runs: readonly SchedulerRun[];
  inputs: readonly SchedulerInput[];
  // 장부의 slotHolds(): 재시작 복원이 남긴 점유 관측.
  slotHolds: readonly Pick<SlotHold, "kind" | "runId" | "holdsSlot">[];
  // 부르는 쪽이 넣는 지금 시각. 앞 호출에서 넣은 값보다 이르면 안 된다: 이 판단은 상태가 없어 시각의 후퇴를 알 수 없고,
  // 시각이 후퇴하면 이미 만료·기한으로 보류한 입력이 다시 후보가 된다. 유한한 수가 아니면 모든 대기 실행을 보류한다.
  now: number;
}

// 설정값. 설계는 "관리자 요청 우선, 경보가 굶지 않게"만 정했고 규칙과 숫자는 정하지 않았다(supervisor.md §11 S-10).
// 규칙(미확정 기본): 이만큼 이상 기다린 경보는 관리자 요청보다 앞선다. 숫자는 배포가 넣는다(코드에 기본값이 없다).
export interface SchedulerPolicy {
  alertMaxWaitMs: number;
}

export type HoldReason =
  // 같은 종류의 슬롯을 다른 실행이 쥐고 있다(준비·실행·결과 검사·결과 대기·실패 정리 전).
  | "slot_occupied"
  // 같은 종류에 종료를 확인하지 못한 실행이 있다(unknown_running, 또는 종료 중인 stopping).
  | "slot_end_unconfirmed"
  // 같은 종류에 정리가 남은 실행이 있다(cleanup_pending).
  | "slot_cleanup_pending"
  // 재시작 복원이 남긴 점유 관측이 그 종류의 슬롯을 막는다.
  | "slot_hold_observed"
  // 시작해 볼 수 있지만 같은 종류의 다른 실행이 이번 차례다.
  | "waiting_turn"
  // 장부가 붙인 이 실행 자체의 시작 불가 사유. 지금 시각으로 다시 본 입력 만료·취소·기한도 같은 이름을 쓴다.
  | StartBar
  // 지금 시각이 유한한 수가 아니다. 만료·기한을 판단할 수 없어 모든 대기 실행을 보류한다.
  | "now_unknown"
  // 실행 줄에 연결된 입력이 없거나, 입력의 출처·접수 시각·만료 시각·취소 여부가 빠졌거나 꼴이 틀리다.
  | "input_unknown"
  // 이 실행 또는 같은 입력의 다른 실행의 남은 예산이 0 이상의 안전 정수가 아니다(읽지 못함).
  | "budget_unknown"
  // 남은 예산이 없다(이 실행, 또는 같은 입력에 묶인 다른 실행 중 하나. 대기 순번과 무관하다).
  | "budget_exhausted"
  // 같은 입력 ID의 앞 순번 실행이나 상태가 queued가 아닌 실행보다 남은 예산이 많다(관리자가 닫지 않은 not_started 줄은 비교하지 않는다).
  | "budget_replenished";

export interface Held {
  runId: string;
  kind: RunKind;
  reason: HoldReason;
}

// 시작해 볼 후보. 실행 허가가 아니다(파일 머리 주석). budgetLeft는 장부 줄의 값을 그대로 옮긴 것이다.
export interface StartCandidate {
  runId: string;
  kind: RunKind;
  origin: Origin;
  budgetLeft: number;
}

export interface QueueDecision {
  // 종류마다 많아야 하나.
  candidates: StartCandidate[];
  held: Held[];
}

const KINDS: readonly RunKind[] = ["worker", "session"];

function slotReason(state: LedgerRunState): HoldReason | null {
  if (SLOT_FREE.includes(state)) return null;
  if (state === "unknown_running" || state === "stopping") return "slot_end_unconfirmed";
  if (state === "cleanup_pending") return "slot_cleanup_pending";
  return "slot_occupied";
}

// 슬롯을 막는 이유 하나. 종료 미확인과 정리 대기가 보통 점유보다 먼저 이름 붙는다(보고에서 더 중요하다).
function slotBlock(view: SchedulerView, kind: RunKind): HoldReason | null {
  const reasons = view.runs.filter((run) => run.kind === kind).map((run) => slotReason(run.state));
  for (const reason of ["slot_end_unconfirmed", "slot_cleanup_pending", "slot_occupied"] as const) {
    if (reasons.includes(reason)) return reason;
  }
  if (view.slotHolds.some((hold) => hold.kind === kind && hold.holdsSlot)) return "slot_hold_observed";
  return null;
}

// 같은 입력에 묶인 다른 실행들. 같은 중복 키는 장부가 같은 실행을 돌려주므로, 재시도·새 세션의 새 실행 줄은 입력으로 잇는다.
// 입력 ID가 다른 줄(세션 교체 뒤 새로 접수한 같은 논리 요청 등)은 여기서 이을 수 없다.
function sameInputRuns(view: SchedulerView, run: SchedulerRun): SchedulerRun[] {
  if (run.inputRequestId === null) return [];
  return view.runs.filter((other) => other.runId !== run.runId && other.inputRequestId === run.inputRequestId);
}

// 같은 입력 ID의 줄만 본다. 입력 ID가 다른 줄의 잔액은 이 판단이 거르지 않는다.
function budgetBar(view: SchedulerView, run: SchedulerRun): HoldReason | null {
  // 이 실행의 잔액을 모르면 다른 줄을 보기 전에 모름으로 보고한다(다른 줄의 0이 있어도 사유는 budget_unknown, 보류는 같다).
  if (!isBudget(run.budgetLeft)) return "budget_unknown";
  if (run.budgetLeft === 0) return "budget_exhausted";
  const others = sameInputRuns(view, run);
  // 소진을 확인한 실행이 하나라도 있으면 순번과 무관하게 막는다. 다른 줄들 사이에서는 읽지 못한 잔액이 이 0을 가리지 않게
  // 모름보다 먼저 본다.
  if (others.some((other) => other.budgetLeft === 0)) return "budget_exhausted";
  if (others.some((other) => !isBudget(other.budgetLeft))) return "budget_unknown";
  // 상한: 같은 입력 ID의 앞 순번 행, 또는 상태가 queued가 아닌 행의 숫자. 관리자가 닫지 않은 not_started 행(closedByOperator가
  // false)은 뺀다: 장부에서 not_started로 가는 길은 queued에서, D-90 닫기(근거 줄이 있을 때), 관리자 닫기(D-91, 근거 줄이 있을 때)뿐이다.
  // queued에서 닫힌 줄의 숫자는 시작하지 않은 줄의 배정액이고, D-90으로 닫힌 줄은 장부가 시작 지시에 고정된 예산에서 감액이 적히지
  // 않았을 때만 닫으므로 그 숫자도 쓰고 남긴 잔액이 아니다. 관리자가 닫은 줄은 "실패로 끝남"이고 이미 돌았을 수 있어 그 숫자는
  // 쓰고 남긴 잔액이다: 시작한 줄과 같이 상한으로 센다. 관리자가 닫았는지 모르는 not_started 줄(칸이 없거나 불리언이 아님)도
  // 상한으로 센다(막는 쪽). 시험이 전이표를 읽어 이 전제를 지킨다. 잔액 0의 not_started는 위의 소진 검사가 이미 막는다.
  const bounds = others.filter((other) => !(other.state === "not_started" && other.closedByOperator === false) && (other.queueSeq < run.queueSeq || other.state !== "queued"));
  if (bounds.some((other) => run.budgetLeft > other.budgetLeft)) return "budget_replenished";
  return null;
}

// 입력 행의 칸을 모두 읽었는가. 하나라도 빠졌거나 꼴이 틀리면 출처의 차례·만료·취소를 판단할 수 없다.
function inputKnown(input: SchedulerInput): boolean {
  return ORIGINS.includes(input.origin) && isTime(input.receivedAt) && isTime(input.expiresAt) && typeof input.cancelled === "boolean";
}

// 슬롯과 무관하게 이 대기 실행을 시작해 볼 수 없는 이유. view.now가 유한한 수임을 부르는 쪽(planNext)이 확인했다.
function ownBar(view: SchedulerView, run: SchedulerRun): HoldReason | { input: SchedulerInput } {
  if (run.startBar !== null) return run.startBar;
  if (view.now >= run.deadlineAt) return "deadline_passed";
  const input = run.inputRequestId === null ? undefined : view.inputs.find((item) => item.requestId === run.inputRequestId);
  if (input === undefined || !inputKnown(input)) return "input_unknown";
  if (input.cancelled) return "input_cancelled";
  if (view.now >= input.expiresAt) return "input_expired";
  return budgetBar(view, run) ?? { input };
}

function checkPolicy(policy: SchedulerPolicy): void {
  if (!Number.isSafeInteger(policy.alertMaxWaitMs) || policy.alertMaxWaitMs <= 0) throw new TypeError("alertMaxWaitMs: 양의 정수가 아니다");
}

// 차례: 오래 기다린 경보(접수 순) → 관리자 요청(대기 순번) → 경보(대기 순번).
function rank(entry: { run: SchedulerRun; input: SchedulerInput }, now: number, policy: SchedulerPolicy): [number, number] {
  if (entry.input.origin === "alert") {
    const aged = now - entry.input.receivedAt >= policy.alertMaxWaitMs;
    return aged ? [0, entry.input.receivedAt] : [2, entry.run.queueSeq];
  }
  return [1, entry.run.queueSeq];
}

export function planNext(view: SchedulerView, policy: SchedulerPolicy): QueueDecision {
  checkPolicy(policy);
  const decision: QueueDecision = { candidates: [], held: [] };
  for (const kind of KINDS) {
    const queued = view.runs.filter((run) => run.kind === kind && run.state === "queued");
    if (!isTime(view.now)) {
      for (const run of queued) decision.held.push({ runId: run.runId, kind, reason: "now_unknown" });
      continue;
    }
    const ready: { run: SchedulerRun; input: SchedulerInput }[] = [];
    for (const run of queued) {
      const bar = ownBar(view, run);
      if (typeof bar === "string") decision.held.push({ runId: run.runId, kind, reason: bar });
      else ready.push({ run, input: bar.input });
    }
    const block = slotBlock(view, kind);
    if (block !== null) {
      for (const { run } of ready) decision.held.push({ runId: run.runId, kind, reason: block });
      continue;
    }
    ready.sort((a, b) => {
      const [ga, ka] = rank(a, view.now, policy);
      const [gb, kb] = rank(b, view.now, policy);
      return ga - gb || ka - kb || a.run.queueSeq - b.run.queueSeq;
    });
    const [first, ...rest] = ready;
    if (first !== undefined) decision.candidates.push({ runId: first.run.runId, kind, origin: first.input.origin, budgetLeft: first.run.budgetLeft });
    for (const { run } of rest) decision.held.push({ runId: run.runId, kind, reason: "waiting_turn" });
  }
  return decision;
}
