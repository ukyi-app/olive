// 감독 장부의 실행 상태와 허용된 전이(supervisor.md §3). 같은 표가 마이그레이션 0001의 run_transitions에 있고,
// 시험이 둘을 대조한다. 여기서 바꾸면 새 마이그레이션으로 그 표도 바꿔야 한다(적용된 마이그레이션은 고치지 않는다).

export const LEDGER_RUN_STATES = [
  "queued",
  "preparing",
  "running",
  "stopping",
  "checking",
  "ready_result",
  "finalized",
  "not_started",
  "failed_stopped",
  "unknown_running",
  "cleanup_pending",
] as const;
export type LedgerRunState = (typeof LEDGER_RUN_STATES)[number];

export type RunKind = "worker" | "session";

// 자리를 놓은 상태. queued는 아직 자리를 받지 않았다. 그 밖은 모두 자리를 쥔다(unknown_running·cleanup_pending 포함).
export const SLOT_FREE: readonly LedgerRunState[] = ["queued", "finalized", "not_started"];
export const TERMINAL: readonly LedgerRunState[] = ["finalized", "not_started"];

// not_started로 가는 길은 queued뿐이다. 지시를 낸 뒤에는 실행기가 띄우지 않았다는 증명이 계약에 없으므로
// 슬롯을 놓지 않는다(끊기면 unknown_running).
// checking → unknown_running은 계약의 stateAfterLoss가 checking을 정착 상태로 보지 않기 때문이다(종료 확인은 이미 있다).
export const TRANSITIONS: Readonly<Record<RunKind, Readonly<Partial<Record<LedgerRunState, readonly LedgerRunState[]>>>>> = {
  worker: {
    queued: ["preparing", "not_started"],
    preparing: ["running", "stopping", "unknown_running", "checking", "failed_stopped"],
    running: ["stopping", "unknown_running", "checking", "failed_stopped"],
    stopping: ["unknown_running", "checking", "failed_stopped"],
    unknown_running: ["stopping", "checking", "failed_stopped"],
    checking: ["ready_result", "failed_stopped", "unknown_running"],
    ready_result: ["finalized", "cleanup_pending"],
    failed_stopped: ["finalized", "cleanup_pending"],
    cleanup_pending: ["finalized"],
  },
  // 세션은 결과가 없고, 종료 확인은 다음 세대의 인수 영수증이다(D-50).
  session: {
    queued: ["preparing", "not_started"],
    preparing: ["running", "stopping", "unknown_running"],
    running: ["stopping", "unknown_running"],
    stopping: ["unknown_running", "finalized"],
    unknown_running: ["stopping", "finalized"],
  },
};

export function mayTransition(kind: RunKind, from: LedgerRunState, to: LedgerRunState): boolean {
  return from === to || (TRANSITIONS[kind][from]?.includes(to) ?? false);
}
