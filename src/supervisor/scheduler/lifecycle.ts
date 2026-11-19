// 실행 하나의 다음 의도를 고르는 순수 판단. 상태를 갖지 않고 장부를 열거나 쓰지 않는다.
// 의도(LifecycleIntent)는 실행 허가가 아니다. 갱신·종료·확정 지시는 장부의 record*Instruction이 정지·세대·상태를
// 다시 본 커밋 뒤에만 나간다.
//
// 의도마다 그 의도가 실행을 데려가려는 장부 상태(toward)가 있다. 의도는 장부의 전이 표(TRANSITIONS)가
// 지금 상태에서 toward로 가는 길을 허락할 때만 낸다. 표를 이 파일에 옮겨 적지 않고 장부의 것을 그대로 읽는다.
import { type LedgerRunState, type Run, type RunKind, SLOT_FREE, TRANSITIONS } from "../../ledger/index.ts";

export interface LifecycleView {
  run: Pick<Run, "runId" | "kind" | "state" | "deadlineAt">;
  // 마지막 시작·갱신 지시의 발행 시각과 그 임대의 끝. 모르면 null이다(그러면 갱신하지 않고 조회한다).
  lease: { issuedAt: number; expiresAt: number } | null;
  // 이 실행을 멈추라는 요청(입력 취소 등)이 있다.
  cancelRequested: boolean;
  // 지금 상태에서 낸 마지막 종료·확정 지시의 시각. 아직 내지 않았거나 모르면 null.
  lastInstructionAt: number | null;
  // 결과 검사와 결과 본문의 보관이 끝났다(ready_result에서 확정 지시를 내도 된다). 결과 쪽 판단(S6)이 정한다.
  resultSettled: boolean;
  now: number;
}

// 설정값. 설계의 S-10은 갱신 10초를 미확정 기본으로 적었고, 응답을 기다릴 시간은 정하지 않았다. 코드에 기본값이 없다.
export interface LifecyclePolicy {
  // 마지막 시작·갱신 지시로부터 이만큼 지나면 갱신한다.
  renewEveryMs: number;
  // 종료·확정 지시를 낸 뒤 이만큼 답이 없으면 같은 실행 ID로 조회하거나 확정을 다시 낸다.
  answerTimeoutMs: number;
}

export type LifecycleIntent =
  // run_renew. 실행을 running에 두려는 의도다.
  | { intent: "renew_lease"; runId: string; toward: LedgerRunState }
  // 대기면 not_started로 닫고(recordStopInstruction), 시작 뒤면 종료 지시(task_cancel·session_stop)로 stopping에 둔다.
  | { intent: "stop"; runId: string; toward: LedgerRunState }
  // 같은 실행 ID의 상태 조회. 종료를 아직 모르는 상태(unknown_running으로 갈 수 있거나 이미 그런 상태)에서만 낸다.
  | { intent: "query"; runId: string; toward: LedgerRunState }
  // result_finalize(정리 재시도 포함). finalized로 가려는 의도다.
  | { intent: "finalize"; runId: string; toward: LedgerRunState }
  | { intent: "wait"; runId: string; toward: LedgerRunState };

export type IntentName = LifecycleIntent["intent"];

// 장부의 전이 표가 kind의 from에서 to로 가는 길을 허락하는가. 같은 상태에 머무는 것은 전이가 아니므로 허락한다.
export function tableAllows(kind: RunKind, from: LedgerRunState, to: LedgerRunState): boolean {
  return from === to || (TRANSITIONS[kind][from]?.includes(to) ?? false);
}

function checkPolicy(policy: LifecyclePolicy): void {
  for (const key of ["renewEveryMs", "answerTimeoutMs"] as const) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new TypeError(`${key}: 양의 정수가 아니다`);
  }
}

export function nextIntent(view: LifecycleView, policy: LifecyclePolicy): LifecycleIntent {
  checkPolicy(policy);
  const { run, now } = view;
  const wait: LifecycleIntent = { intent: "wait", runId: run.runId, toward: run.state };
  // 표가 허락하는 길만 의도로 낸다. 허락하지 않으면 기다림이다.
  const go = (intent: Exclude<IntentName, "wait">, toward: LedgerRunState): LifecycleIntent | null =>
    tableAllows(run.kind, run.state, toward) ? { intent, runId: run.runId, toward } : null;
  const answerDue = view.lastInstructionAt === null || now - view.lastInstructionAt >= policy.answerTimeoutMs;
  const stopWanted = view.cancelRequested || now >= run.deadlineAt;

  // 대기 실행: 시작은 queue.ts가 고른다. 여기서는 멈추라는 요청만 not_started로 닫는다.
  if (run.state === "queued") return (view.cancelRequested ? go("stop", "not_started") : null) ?? wait;
  // 끝난 실행(finalized·not_started)은 더 할 일이 없다. 같은 상태에 머무는 것을 확정 의도로 내지 않게 먼저 닫는다.
  if (SLOT_FREE.includes(run.state)) return wait;

  // 종료를 아직 모르는 상태: 멈춰야 하면 종료 지시, 아니면 같은 ID로 조회. 지난 임대를 갱신으로 되살리지 않는다.
  if (tableAllows(run.kind, run.state, "unknown_running")) {
    if (run.state === "stopping") return (answerDue ? go("query", "unknown_running") : null) ?? wait;
    if (stopWanted) {
      const stop = go("stop", "stopping");
      if (stop !== null) return stop;
    }
    if (run.state === "unknown_running") return go("query", "unknown_running") ?? wait;
    if (view.lease === null || now >= view.lease.expiresAt) return go("query", "unknown_running") ?? wait;
    if (now - view.lease.issuedAt >= policy.renewEveryMs) return go("renew_lease", "running") ?? wait;
    return wait;
  }

  // 결과 쪽 상태(종료 확인이 있다): 확정 지시를 내거나, 답이 없으면 다시 낸다. ready_result는 결과 보관이 끝난 뒤에만.
  if (run.kind === "worker" && (run.state !== "ready_result" || view.resultSettled) && answerDue) {
    return go("finalize", "finalized") ?? wait;
  }
  return wait;
}
