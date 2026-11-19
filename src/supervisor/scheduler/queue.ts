// 종류(작업자·세션)마다 다음에 시작해 볼 대기 실행 하나를 고르는 순수 판단. 상태를 갖지 않는다:
// 장부에서 읽은 실행·입력·점유 관측과 지금 시각을 인자로 받아 계산만 한다. 장부를 열거나 쓰지 않는다.
//
// 시작 후보(StartCandidate)는 실행 허가가 아니다. 실제 시작은 장부의 startRun이 정지·세대·기한·점유를
// 같은 트랜잭션에서 다시 본 뒤에만 된다. 부르는 쪽은 후보를 받아도 startRun의 거절을 그대로 따른다.
//
// 틀리는 방향은 늘 "시작하지 않음"이다. 종료를 확인하지 못한 실행, 출처를 모르는 입력, 앞 실행보다 많은 예산은 보류다.
import { type LedgerRunState, type Run, type RunKind, SLOT_FREE, type SlotHold, type StartBar } from "../../ledger/index.ts";

// 입력의 인증된 출처 종류. 장부의 inputs.source(인증된 출처 이름)를 관리자 요청과 자동 경보로 나눈 것이다.
// 나누는 규칙은 이 판단 밖(접수 쪽)의 일이고, 요청 본문으로 정하지 않는다.
export type Origin = "admin" | "alert";

// 이 판단이 실행 줄에서 읽는 칸. 모두 장부의 Run에 있는 칸이고 상태 이름도 장부 그대로다.
// startBar는 queueView()가 대기 실행에 붙여 주는 값이다. 끝난 실행처럼 장부가 붙이지 않는 줄은 null을 넣는다.
export type SchedulerRun = Pick<Run, "runId" | "kind" | "role" | "state" | "queueSeq" | "inputRequestId" | "deadlineAt" | "budgetLeft"> & {
  startBar: StartBar | null;
};

// 실행 줄에 연결된 입력. 장부의 inputs 표에 있는 칸만 둔다(원문은 없다. 본문으로 우선순위를 정하지 않기 위해 타입에 없다).
// origin과 receivedAt은 장부 표에 있지만 지금의 queueView()가 내주지 않는다. 부르는 쪽이 채우지 못하면 이 항목을 넣지 않는다
// (그러면 그 실행은 input_unknown으로 보류된다).
export interface SchedulerInput {
  requestId: string;
  origin: Origin;
  receivedAt: number;
  expiresAt: number;
  cancelled: boolean;
}

export interface SchedulerView {
  // 장부의 실행 줄. 같은 논리 요청의 앞 실행(끝난 것 포함)을 넣어야 예산 보충을 잡는다(listRuns()의 범위).
  runs: readonly SchedulerRun[];
  inputs: readonly SchedulerInput[];
  // 장부의 slotHolds(): 재시작 복원이 남긴 점유 관측.
  slotHolds: readonly Pick<SlotHold, "kind" | "runId" | "holdsSlot">[];
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
  // 실행 줄에 연결된 입력이 없거나, 입력의 출처·접수 시각을 받지 못했다.
  | "input_unknown"
  // 남은 예산이 없다(이 실행 또는 같은 논리 요청의 앞 실행).
  | "budget_exhausted"
  // 같은 논리 요청의 앞 실행보다 남은 예산이 많다. 재시도·새 세션이 예산을 보충한 줄이다.
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

// 같은 입력에 묶인 앞 실행들. 같은 중복 키는 장부가 같은 실행을 돌려주므로, 재시도·새 세션의 새 실행 줄은 입력으로 잇는다.
function earlierRuns(view: SchedulerView, run: SchedulerRun): SchedulerRun[] {
  if (run.inputRequestId === null) return [];
  return view.runs.filter((other) => other.runId !== run.runId && other.inputRequestId === run.inputRequestId && other.queueSeq < run.queueSeq);
}

// 슬롯과 무관하게 이 대기 실행을 시작해 볼 수 없는 이유.
function ownBar(view: SchedulerView, run: SchedulerRun): HoldReason | { input: SchedulerInput } {
  if (run.startBar !== null) return run.startBar;
  if (view.now >= run.deadlineAt) return "deadline_passed";
  const input = run.inputRequestId === null ? undefined : view.inputs.find((item) => item.requestId === run.inputRequestId);
  if (input === undefined) return "input_unknown";
  if (input.cancelled) return "input_cancelled";
  if (view.now >= input.expiresAt) return "input_expired";
  if (run.budgetLeft <= 0) return "budget_exhausted";
  const earlier = earlierRuns(view, run);
  if (earlier.length > 0) {
    const least = Math.min(...earlier.map((other) => other.budgetLeft));
    if (least <= 0) return "budget_exhausted";
    if (run.budgetLeft > least) return "budget_replenished";
  }
  return { input };
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
