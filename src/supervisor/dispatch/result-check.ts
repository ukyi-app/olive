// 결과 검사의 한 박자. checking에 머문 작업자 실행마다 반영 전 결과 보고를 모으고, 판정 자리(resultVerdict)가 통과로 낸 결과만
// 장부의 markResult로 ready_result에 옮긴다. 반영 전 결과 보고가 없는 채 기한(policy.reportWaitMs)이 지난 실행은
// markResult(null)로 failed_stopped에 옮긴다(D-113). 기한은 종료 영수증 시각·복원 5단계를 받아들인 시각·그 실행기의 지금 연결이
// 인정된 시각 가운데 가장 늦은 때부터 센다(D-123). 같은 기한과 재전송 한 주기를 이 프로세스의 단조 경과로도 본다(벽시계만 앞으로
// 뛰면 판정하지 않는다). 확정(result_finalize)은 이 박자가 아니라 수명 박자가 낸다.
// 장부·접수·박자 유효 문은 포트로, 판정 시각(now)은 순서기가 부르기 직전에 다시 읽은 장부 시계로, 기한은 정책 인자로 받는다.
// 소켓·타이머·시계·난수를 직접 부르지 않는다. 쥐는 것은 이 모듈의 박자가 진행 중이라는 표시 하나다(돌아오면 지운다).
//
// 지키는 것(result-check.md "판단의 차례"):
// 1. 모름은 판정하지 않는다. 실행 목록이나 반영 전 보고 목록을 읽지 못하거나 한 줄이라도 칸을 읽지 못하면 장부를 부르지 않는다.
//    보고 한 줄을 건너뛰고 판정하면 그 실행의 다른 digest를 보지 못한 채 판정해, 장부가 그 보고를 충돌로 닫는다.
// 2. 판정은 그 실행의 반영 전 결과 보고가 정확히 한 digest일 때만이다. 다른 digest가 함께 있으면 판정하지 않고 digest_conflict로 남긴다.
//    결과 없음 판정은 반영 전 결과 보고가 하나도 없고, 기한 시작(waitFrom)부터 now까지 기한 이상일 때만이다. 기한 시작은
//    실행 줄의 updated_at(checking이 된 시각)·복원 5단계를 받아들인 시각·그 실행기의 지금 연결이 인정된 시각 가운데 가장 늦은 때다.
//    그 실행기가 연결돼 있지 않거나, 인정 뒤 재전송 한 주기(RENEW_INTERVAL_MS)가 지나지 않았거나, 셋 중 하나라도 모르면 기다린다:
//    실행기는 연결이 맞춰져 있을 때만 결과 보고를 보내고(src/executor/worker.ts의 transmit), 받음 확인이 없는 보고를 그 주기로 다시 보낸다.
//    장부 시각의 비교와 함께 단조 경과(5단계 뒤·인정 뒤·이 프로세스가 그 실행을 처음 본 뒤)로도 기한과 그 주기가 지났어야 한다.
//    더해 그 연결에서 실행기가 실제로 답한 조회가 있고, 그 조회를 실은 때가 기한 시작 + 재전송 한 주기 이후여야 한다(장부 시각과
//    단조 경과 모두). 인정된 연결 번호만으로는 실행기와 주고받을 수 있는지 모른다: TCP 탐침을 대신 받는 중계 뒤에서 실행기가 사라져도
//    번호는 남는다. 실행기는 같은 연결에 먼저 실은 보고 뒤에 조회의 답을 싣으므로, 그 조회 전에 다시 보낼 기회가 있던 보고는 답보다 먼저 닿는다.
//    그 조회는 그 실행 ID를 물은 것이어야 한다: 같은 실행기의 다른 실행만 물은 조회의 답은 이 실행의 보고가 앞서 닿았다는 근거가 아니다.
//    그 답에서 실행기가 그 실행을 ready_result(결과 보고를 만들어 ack를 기다림)라고 말했으면 기다린다: 보고가 오는 중이거나 감독이 받고도
//    보관하지 못했다. 감독이 받은 그 실행의 결과 보고 가운데 보관소나 장부에 닿았는지 모르는 것이 남아 있어도 기다린다: 이미 받은 결과를
//    결과 없음으로 판정하면 복구 뒤 같은 보고를 장부가 영영 거절한다.
// 3. markResult에는 늘 그 보고의 reportId를 넘긴다. 장부가 그 보고가 이 실행의 반영 전 보고이고 digest가 같은지 대조해(아니면
//    reference_mismatch) 판정이 이 박자가 본 보고를 정확히 가리킨다. 확정을 여는 데에는 필요 없다: 빠져도 장부는 판정하면서
//    그 실행의 반영 전 결과 보고를 모두 반영한다.
// 4. 접수가 닫혔으면(복원 전·정지 중·허가 폐기) 판정하지 않는다. 박자 처음과, 장부 호출마다 그 바로 앞의 문 안에서 본다.
// 5. 장부 호출은 장부 포트 수신자·메서드·인자 얻기 → 문(접수 → 박자 유효 문) → 호출 하나다(send-gate.ts의 callAfterGate).
//    문 뒤에는 외부 코드가 없고, 읽기부터 호출까지 await가 없다.
// 6. 장부가 던지거나 답이 정의 밖이면 그 자리에서 박자를 멈춘다(판정이 적혔는지 모른다). 거절은 그 실행의 결과이고 박자는 이어 간다.
import { limits, RUN_STATES } from "../../contract/v1/index.ts";
import { LEDGER_RUN_STATES, type Ledger, REFUSALS as LEDGER_REFUSALS, type LedgerRunState, type Refusal as LedgerRefusal, type Restorer } from "../../ledger/index.ts";
import { callAfterGate, holdBeatValid } from "./send-gate.ts";

export interface ResultCheckPorts {
  // 읽기 둘과 판정 쓰기 하나. 박자들이 쓰는 그 장부 객체여야 한다.
  readonly ledger: Pick<Ledger, "listRuns" | "pendingReports" | "markResult">;
  // 조립의 접수 문(박자 유효 문 + 복원기의 접수). 복원 5단계 전·정지 중·허가 폐기면 거짓이다.
  readonly intake: Pick<Restorer, "intakeOpen">;
  // 이 박자가 아직 유효한가. 장부 호출 바로 앞에서 본다. 빠지면 늘 유효다(이 부품 단독의 쓰임). 조립은 반드시 넘긴다.
  readonly beatValid?: () => boolean;
  // 결과 없음 판정의 기한 시작과 연결 조건(D-123)에 드는 사실. 결과 없음 판정으로 가기 직전에만 읽고 통과 판정은 보지 않는다.
  // 빠지면 결과 없음 판정을 하지 않는다(이 부품 단독의 쓰임). 조립은 반드시 넘긴다.
  readonly reach?: ResultReach;
}

// 결과 보고가 장부에 닿을 수 있게 된 때를 가늠하는 사실(D-123). 모르면 null이고, null이면 결과 없음 판정을 하지 않는다. 던져도 null과 같다.
// ...At은 장부와 같은 시계의 시각이고, since...Ms는 이 프로세스의 단조 시계로 잰 그때부터 지금까지의 경과(ms, 0 이상의 유한수)다.
// 장부 시계는 벽시계를 따라 앞으로 뛸 수 있다: 두 쪽이 모두 기한을 넘겨야 판정한다. 음수 경과(단조 시계가 뒤로 감)도 모름이다.
export interface ResultReach {
  // 이 프로세스가 복원 5단계의 허가를 받아들인 시각. 받아들이기 전이거나 그때 시각을 읽지 못했으면 null.
  restoredAt(): number | null;
  // 그 실행기의 연결이 지금 인정돼 있으면(이번 복원기로 맞춘 뒤 인사까지 끝났고 서버가 아직 닫지 않은 연결 하나) 그 연결이 인정된
  // (greeted로 옮겨 간) 시각. 인사 바이트를 받은 시각이 아니다: 그 사이 서명 검증을 기다리는 동안 실행기는 아직 보고를 보낼 수 없다.
  // 연결이 없거나 둘 이상이거나 모르면 null.
  greetedAt(executorId: string): number | null;
  // 5단계를 받아들인 뒤의 단조 경과.
  sinceRestoredMs(): number | null;
  // 그 실행기의 지금 인정된 연결이 인정된 뒤의 단조 경과. greetedAt과 같은 연결이다.
  sinceGreetedMs(executorId: string): number | null;
  // 이 프로세스가 그 실행을 결과 없음 판정을 기다리는 checking으로 처음 물은 뒤의 단조 경과(처음 물을 때 0). 종료 영수증 시각은 장부
  // 시계뿐이라, 영수증이 기준일 때 단조 쪽 기준을 이것으로 대신한다(처음 물은 때는 영수증을 받은 때보다 이르지 않다).
  sinceSeenMs(runId: string): number | null;
  // greetedAt과 같은 연결에서 그 실행기가 답한(감독이 받아 대조한) 상태 조회 가운데 그 실행 ID를 물은 것 중 가장 늦게 실은 것의 실은
  // 시각. 답을 받은 시각이 아니다: 실행기는 조회를 받은 뒤에 답을 만들므로 실은 시각이 답을 만든 때의 하한이다. 그 실행을 묻지 않은
  // 조회의 답은 쓰지 않는다. 답한 조회가 없거나 모르면 null.
  answeredAt(executorId: string, runId: string): number | null;
  // 같은 답에서 실행기가 그 실행에 대해 말한 상태(계약 v1의 RUN_STATES). 모르면 null.
  answeredState(executorId: string, runId: string): string | null;
  // 같은 조회를 실은 뒤의 단조 경과.
  sinceAnsweredMs(executorId: string, runId: string): number | null;
  // 감독이 받은 그 실행의 결과 보고 가운데 보관소나 장부에 닿았는지 모르는(보관이 unknown, 장부가 던지거나 거절한) 것이 남아 있으면 true,
  // 없으면 false. 같은 보고를 뒤에 장부가 받거나(ack) 보관 전에 확정 거절하면 지운다. 모르면 null.
  unstoredResult(runId: string): boolean | null;
}

// 판정 자리가 보는 반영 전 결과 보고 하나. 장부의 pendingReports가 낸 차례(받은 시각, id) 그대로 넘긴다.
export interface PendingResult {
  readonly reportId: string;
  readonly resultDigest: string;
  readonly storedRef: string;
}

// 결과 없음 판정의 기한. 운영 값은 감독 설정 한 자리(src/main/supervisor.ts의 RESULT_CHECK)다.
export interface ResultCheckPolicy {
  // checking이 된 뒤 반영 전 결과 보고 없이 기다리는 시간(ms, 양의 안전 정수). 정각(경과 = 이 값)부터 결과 없음으로 판정한다.
  readonly reportWaitMs: number;
}

export type ResultVerdict =
  // 그 digest로 판정한다. reportId는 그 digest의 첫 보고다(같은 digest의 나머지는 장부가 함께 반영한다).
  | { readonly kind: "pass"; readonly resultDigest: string; readonly reportId: string }
  // 반영 전 결과 보고가 없다. 판정하지 않고 기다린다.
  | { readonly kind: "wait" }
  // 서로 다른 digest의 보고가 함께 있다. 판정하지 않는다. digests는 서로 다른 digest의 수다.
  | { readonly kind: "conflict"; readonly digests: number };

// 결과 검사의 판정 자리. 판정에 걸린 결정 셋이 여기서 갈린다:
// - 보고가 없는 checking(D-113): 여기서는 기다림이다. 기한이 지났는지는 박자가 실행 줄의 시각으로 따로 본다.
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
  // 정책 인자가 있는데 기한이 양의 안전 정수가 아니다.
  | "policy_malformed"
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
  // 반영 전 결과 보고가 없고 기한 전이다(또는 정책 인자·기한 시작의 사실이 없거나 모르거나, 그 실행기의 연결이 없거나 인정 뒤 재전송
  // 한 주기 전이다). 장부를 부르지 않았다.
  | { readonly runId: string; readonly outcome: "waiting" }
  // 반영 전 결과 보고 없이 기한이 지나 장부가 결과 없음 판정을 적었다고 답했다(failed_stopped). checkingSince는 판정에 쓴 실행 줄의
  // updated_at이다. 조립이 감독 기록에 경보 한 줄을 남긴다.
  | { readonly runId: string; readonly outcome: "no_result"; readonly checkingSince: number; readonly state: LedgerRunState }
  // 서로 다른 digest의 반영 전 결과 보고가 있다. 장부를 부르지 않았다. 조립이 감독 기록에 경보 한 줄을 남긴다.
  | { readonly runId: string; readonly outcome: "digest_conflict"; readonly digests: number; readonly reports: number }
  // reportId는 판정에 넘긴 보고 ID다. 결과 없음 판정이면 null(보고를 넘기지 않는다).
  | { readonly runId: string; readonly outcome: "refused"; readonly reportId: string | null; readonly reason: LedgerRefusal }
  // 장부가 적었는지 모른다. 장부의 문구는 싣지 않는다.
  | { readonly runId: string; readonly outcome: "ledger_failed"; readonly reportId: string | null; readonly reason: "threw" | "malformed_answer" };

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
// 단조 경과. performance.now처럼 소수일 수 있다.
const isElapsed = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isRefusal = (value: unknown): value is LedgerRefusal => (LEDGER_REFUSALS as readonly unknown[]).includes(value);
const isState = (value: unknown): value is LedgerRunState => (LEDGER_RUN_STATES as readonly unknown[]).includes(value);
// 실행기가 상태 답에 싣는 실행 상태(계약 v1).
const isExecutorState = (value: unknown): boolean => (RUN_STATES as readonly unknown[]).includes(value);

// 진행 중인 박자. 박자 안에 await가 없으므로 겹치는 길은 포트 안에서 다시 부르는 것뿐이다. 장부 객체로 가르지 않고 모듈 단위로 세운다:
// 장부 객체를 얻는 ports.ledger 접근자도 외부 코드다.
let running = false;

// policy가 없으면 결과 없음 판정을 하지 않는다(이 부품 단독의 쓰임). 조립은 반드시 넘긴다.
export function resultCheckTick(ports: ResultCheckPorts, now: number, policy?: ResultCheckPolicy): ResultCheckTickResult {
  if (running) return { kind: "not_run", reason: "tick_in_progress" };
  running = true;
  try {
    return tickOnce(ports, now, policy);
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

// checking인 작업자 실행을 실행 목록의 차례대로. 모든 줄의 실행 ID·종류·상태를 칸마다 한 번 읽는다. 한 줄이라도 읽지 못하거나
// 꼴이 틀리거나 같은 실행 ID가 둘이면 목록 전체가 모름이다(그 줄이 checking 실행일 수 있다).
// checking 줄은 updated_at과 지정 실행기도 한 번씩 읽는다. checking으로 오는 길은 completed 종료 영수증 하나라 그 시각이 영수증을 받은
// 시각이다. 두 칸은 결과 없음 판정에만 쓴다: 꼴이 틀리면 그 칸이 null이고 그 실행은 결과 없음으로 판정하지 않는다.
interface CheckingRun {
  readonly runId: string;
  readonly since: number | null;
  readonly executorId: string | null;
}
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
      if (kind !== "worker" || state !== "checking") continue;
      const since: unknown = row.updatedAt;
      const executorId: unknown = row.executorId;
      checking.push({ runId, since: isTime(since) ? since : null, executorId: typeof executorId === "string" && executorId.length > 0 ? executorId : null });
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

// 결과 없음 판정의 기한 시작(D-123): 종료 영수증 시각(since)·복원 5단계를 받아들인 시각·그 실행기의 지금 연결이 인정된 시각 가운데
// 가장 늦은 때. 그 실행기가 연결돼 있지 않거나, 인정 뒤 재전송 한 주기가 지나지 않았거나(정각부터 지난 것으로 본다), 그 연결에서
// 실행기가 그 실행을 물은 조회에 답하지 않았거나 그 조회를 기한 시작 + 재전송 한 주기 이후에 싣지 않았거나, 그 답이 ready_result이거나,
// 감독이 보관하지 못한 그 실행의 결과 보고가 남았거나, 하나라도 모르면 null(기다림)이다. 감독이 멈춰 있던 동안이나
// 실행기 연결이 끊긴 동안은 실행기가 결과 보고를 장부에 닿게 할 수 없으므로 기한에 넣지 않는다. 단조 경과도 같은 조건(인정 뒤 한 주기,
// 세 기준 모두에서 기한, 세 기준 모두에서 한 주기 뒤에 실은 답한 조회)을 넘어야 한다. 장부 시계만 보면 벽시계가 앞으로 뛴 만큼 실행기가
// 실제로 기다린 시간 없이 기한이 지난다. 포트의 칸과 호출마다 한 번만 읽고, 던짐은 모름이다.
function waitFrom(ports: ResultCheckPorts, run: CheckingRun, since: number, now: number, wait: number): number | null {
  const executorId = run.executorId;
  if (executorId === null) return null;
  try {
    const reach = ports.reach;
    if (reach === undefined) return null;
    // 처음 물은 때를 다른 사실보다 먼저 남긴다: 다른 사실을 모르는 동안에도 그 실행을 이미 보고 있었다.
    const seenMs: unknown = reach.sinceSeenMs(run.runId);
    const restoredAt: unknown = reach.restoredAt();
    if (!isTime(restoredAt)) return null;
    const greetedAt: unknown = reach.greetedAt(executorId);
    if (!isTime(greetedAt)) return null;
    // 실행기는 받음 확인이 없는 보고를 마지막 송신에서 이 간격이 지나면 다시 보낸다(src/executor/worker.ts의 tick). 인정 뒤 이 간격 안에는
    // 다시 보낸 보고가 아직 장부에 닿지 않았을 수 있다.
    if (now - greetedAt < limits.RENEW_INTERVAL_MS) return null;
    const restoredMs: unknown = reach.sinceRestoredMs();
    const greetedMs: unknown = reach.sinceGreetedMs(executorId);
    if (!isElapsed(seenMs) || !isElapsed(restoredMs) || !isElapsed(greetedMs)) return null;
    if (greetedMs < limits.RENEW_INTERVAL_MS) return null;
    const earliest = Math.min(seenMs, restoredMs, greetedMs);
    if (earliest < wait) return null;
    const from = Math.max(since, restoredAt, greetedAt);
    // 답한 조회. 실은 시각이 지금보다 뒤면 장부 시계가 뒤로 간 것이라 모름이다.
    const answeredAt: unknown = reach.answeredAt(executorId, run.runId);
    if (!isTime(answeredAt) || answeredAt > now || answeredAt - from < limits.RENEW_INTERVAL_MS) return null;
    // 실행기는 결과 보고를 만든 실행을 ready_result로 답한다(src/executor/worker.ts의 statusOf). 그 보고는 아직 장부에 없다.
    const answeredState: unknown = reach.answeredState(executorId, run.runId);
    if (!isExecutorState(answeredState) || answeredState === "ready_result") return null;
    // 단조 경과는 다른 기준들보다 뒤에 읽는다: 읽기 사이에 흐른 시간이 실은 때와 기준 사이를 짧게 보이게 할 뿐 길게 보이게 하지 않는다.
    const answeredMs: unknown = reach.sinceAnsweredMs(executorId, run.runId);
    if (!isElapsed(answeredMs) || earliest - answeredMs < limits.RENEW_INTERVAL_MS) return null;
    // 감독이 받았지만 장부에 닿았는지 모르는 결과 보고. 판정 쓰기 직전의 마지막 읽기다(그 사이에 await가 없다).
    if (reach.unstoredResult(run.runId) !== false) return null;
    return from;
  } catch {
    return null;
  }
}

// 기한. 정책 인자가 없으면 null(결과 없음 판정 없음), 칸을 읽지 못하거나 꼴이 틀리면 undefined다.
function waitOf(policy: ResultCheckPolicy | undefined): number | null | undefined {
  if (policy === undefined) return null;
  try {
    const wait: unknown = policy.reportWaitMs;
    return isTime(wait) ? wait : undefined;
  } catch {
    return undefined;
  }
}

function tickOnce(ports: ResultCheckPorts, now: number, policy: ResultCheckPolicy | undefined): ResultCheckTickResult {
  if (!isTime(now)) return { kind: "not_run", reason: "now_malformed" };
  const wait = waitOf(policy);
  if (wait === undefined) return { kind: "not_run", reason: "policy_malformed" };
  if (!intakeOpen(ports)) return { kind: "not_run", reason: "intake_closed" };
  const checking = readChecking(ports);
  if (checking === null) return { kind: "not_run", reason: "read_unknown", read: "runs" };
  const pending = readPending(ports);
  if (pending === null) return { kind: "not_run", reason: "read_unknown", read: "reports" };

  const runs: ResultCheckOutcome[] = [];
  for (const run of checking) {
    const { runId, since } = run;
    const verdict = resultVerdict(pending.get(runId) ?? []);
    if (verdict.kind === "wait") {
      // 기한 정각부터 판정한다. 시계가 기한 시작보다 뒤로 갔으면(now < from) 경과가 음수라 기다린다.
      const from = wait === null || since === null ? null : waitFrom(ports, run, since, now, wait);
      if (wait === null || since === null || from === null || now - from < wait) {
        runs.push({ runId, outcome: "waiting" });
        continue;
      }
      const judged = mark(ports, runId, { resultDigest: null, since }, now);
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
  return { kind: "ran", runs, halted: null, haltedAt: null };
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

// 판정 하나: 통과(그 digest와 첫 보고 ID) 또는 결과 없음(digest null, 보고 ID 없음). 결과 없음은 장부에 reportId를 넘기지 않는다:
// 반영할 보고가 없고, 장부는 판정하면서 그 실행의 반영 전 결과 보고를 모두 닫는다.
type Judgement = { readonly resultDigest: string; readonly reportId: string } | { readonly resultDigest: null; readonly since: number };

// 인자는 문보다 먼저 만든다. callAfterGate가 장부 포트 수신자·메서드·인자 원소를 얻고 → 문 → 호출 하나다.
// 답의 칸은 예외 처리 안에서 칸마다 한 번만 읽는다.
function mark(ports: ResultCheckPorts, runId: string, judgement: Judgement, now: number): Judged {
  const resultDigest = judgement.resultDigest;
  const reportId = judgement.resultDigest === null ? null : judgement.reportId;
  const markInput = judgement.resultDigest === null ? { runId, resultDigest: null, now } : { runId, resultDigest: judgement.resultDigest, reportId: judgement.reportId, now };
  const shut: { halt: Exclude<ResultCheckHalt, "threw"> } = { halt: "beat_closed" };
  const call = callAfterGate(() => { const ledger = ports.ledger; return { receiver: ledger, fn: ledger.markResult, args: [markInput] }; }, () => gateOpen(ports, shut));
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
    if (answeredId !== runId || digest !== resultDigest || !isState(state)) return failed("malformed_answer");
    // 결과 없음은 보고 ID 없이 부르므로 장부는 checking에서 옮길 때만 ok로 답한다(이미 판정된 실행이면 transition_denied).
    if (judgement.resultDigest === null) return state === "failed_stopped" ? { outcome: { runId, outcome: "no_result", checkingSince: judgement.since, state }, halt: null } : failed("malformed_answer");
    if (!JUDGED.includes(state)) return failed("malformed_answer");
    return { outcome: { runId, outcome: "judged", reportId: judgement.reportId, resultDigest: judgement.resultDigest, state }, halt: null };
  } catch {
    return failed("malformed_answer");
  }
}
