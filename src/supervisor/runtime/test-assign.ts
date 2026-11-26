// 시험 배정 값(O-D). 감독이 시험 값(OLIVE_TEST_JOBS=on)일 때만 쓰는 배정 정책의 숫자와 배정 전 사실의 공급자다.
// 진입점(src/main/supervisor.ts)이 시험 값에서만 실행 계획·요청 한도를 넣고(testAssignPolicy), 조립(boot.ts)이 같은 시험 값의 설정(testAssign)에서만
// 사실 공급자를 쓴다(testFactSource). 운영 값에서는 이 파일의 무엇도 쓰지 않는다: 실행 계획 없음, 요청 한도 0(planNext가 거절), 사실 모름(보류).
// 파일·환경·시계·난수를 읽지 않는다.
//
// 숫자는 T1(시험 클러스터 한 바퀴)의 시험 숫자이고 T1 실측 뒤 조정한다(README "시험 배정 값").
//
// 배정 전 사실은 실제 근거가 있는 칸만 채운다. 지금 근거가 있는 것은 장부의 실행 줄·점유 관측으로 판정하는 "앞 실행의 종료 미확인" 하나다.
// 나머지 다섯(역할·목적 조합, 원본 고정, 자기 저장소 작성, 외부 코드 실행, 스스로 고치는 작성의 근거 문)은 판정할 원천이 감독에 없어 비운다.
// 그래서 고르기는 그 다섯으로 evidence_missing 보류를 낸다. 시험 값이라는 이유로 그 안전 검사를 "통과"로 채우는 것은 관리자 결정이다.
import type { Role } from "../../contract/v1/index.ts";
import { LEDGER_RUN_STATES, type Ledger, type LedgerRunState } from "../../ledger/index.ts";
import type { FactSource } from "../dispatch/assign-loop.ts";
import type { PreAssignFacts, RunPlan } from "../dispatch/pick.ts";
import type { Origin } from "../scheduler/queue.ts";

// T1 역할. D-118의 고정 프로그램(모델 없음)을 돌릴 역할이다. 고정 계정의 방식이 구독 하나라(OLIVE_ACCOUNT_NAME, D-126) 구독을 받는 역할이어야
// 한다(roles/policy.ts에서 진단·작성 둘). 진단은 작성 역할(code_author)이 아니라 자기 저장소 작성(D-25)·스스로 고치는 작성(D-34)의 거절과 더 멀다.
export const TEST_ASSIGN_ROLE: Role = "diagnosis";

// 시험 숫자. 이 자리 하나에서만 정한다.
export const TEST_ASSIGN_NUMBERS = Object.freeze({
  // 실행 하나의 예산(토큰). 고정 프로그램은 모델을 부르지 않아 쓰지 않는다. 장부가 1 미만을 시작하지 않아 양수다.
  runBudgetTokens: 1_000,
  // 요청(소유자 입력) 하나의 예산 합 한도(D-105). 시험 작업은 모두 시험 현관 대역의 같은 소유자 입력에 묶이므로, 이 값이 실행 하나의 예산과
  // 같으면 한 장부에서 시작하는 실행이 하나다(D-119: 다음 바퀴는 새 장부로).
  requestBudgetTokens: 1_000,
  // 배정 시각부터 기한까지(ms). 시작 대기·자격 값·고정 프로그램·결과 보고를 덮는다. 입력의 만료보다 늦으면 고르기가 만료로 자른다.
  runDurationMs: 600_000,
});

// 실행 줄의 snapshot digest. 고정 프로그램은 snapshot을 읽지 않으므로 "snapshot 없음"을 뜻하는 고정 표지
// "olive-test-assign/no-snapshot"의 SHA-256이다(시험이 다시 계산한다). 장부와 실행기는 이 값을 대조하지 않는다.
// 함정: snapshot을 실제로 읽는 역할 프로그램을 이 값으로 돌리면 실행 줄이 없는 출처를 적는다.
export const TEST_ASSIGN_SNAPSHOT_DIGEST = "e29c49f950c7cef9df8e1e61aa70b25ccc4e9cb41a413d56516d45500f38c703";

// 진입점이 시험 값에서만 넣는 실행 계획과 요청 한도. 부를 때마다 새로 얼린 값이다.
export function testAssignPolicy(): { readonly plans: readonly RunPlan[]; readonly requestBudget: Readonly<Record<Origin, number>> } {
  const plan: RunPlan = Object.freeze({
    role: TEST_ASSIGN_ROLE,
    snapshotDigest: TEST_ASSIGN_SNAPSHOT_DIGEST,
    budgetLeft: TEST_ASSIGN_NUMBERS.runBudgetTokens,
    runDurationMs: TEST_ASSIGN_NUMBERS.runDurationMs,
  });
  // 경보 출처의 한도는 planNext가 두 출처 모두 양수를 요구해서 둔다. 시험 값의 출처 정책(시험 현관 대역)은 경보 출처를 내지 않는다.
  const limit = TEST_ASSIGN_NUMBERS.requestBudgetTokens;
  return { plans: Object.freeze([plan]), requestBudget: Object.freeze({ admin: limit, alert: limit }) };
}

// 지시를 낸 뒤 종료 영수증이 아직 적히지 않은 작업자 실행의 상태(ledger/states.ts). checking부터는 종료 확인 영수증이 적힌 뒤이고,
// queued는 아직 시작하지 않았고, not_started·finalized는 끝났다.
export const END_UNCONFIRMED: readonly LedgerRunState[] = Object.freeze(["preparing", "running", "stopping", "unknown_running"]);

export type TestFactLedger = Pick<Ledger, "listRuns" | "slotHolds">;

const UNKNOWN: PreAssignFacts = Object.freeze({});
const KINDS: readonly unknown[] = ["worker", "session"];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

// 읽기 답의 값 목록. known이 불리언 true이고 값이 배열이며 원소가 모두 객체일 때만 낸다. 길이는 한 번 읽고 그 수만큼 칸을 본다:
// 길이가 정수가 아닌 목록을 "줄 없음"으로 읽지 않는다. 빈 자리는 undefined라 객체 검사에 걸린다.
function rowsOf(read: () => unknown): readonly Record<string, unknown>[] | null {
  const answer: unknown = read();
  if (!isObject(answer) || answer.known !== true) return null;
  const value: unknown = answer.value;
  if (!Array.isArray(value)) return null;
  const length: unknown = value.length;
  if (!Number.isSafeInteger(length)) return null;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < (length as number); i += 1) {
    const row: unknown = value[i];
    if (!isObject(row)) return null;
    rows.push(row);
  }
  return rows;
}

// 앞 실행의 종료 미확인. 작업자 실행 가운데 종료가 확인되지 않은 것이 있거나 재시작 복원이 남긴 작업자 자리의 점유 관측이 있으면 true,
// 둘 다 없음을 끝까지 읽었으면 false다. 읽기가 모름·던짐이거나 줄의 종류·상태·점유 칸이 장부의 값이 아니면 칸을 비운다(모름).
// 세션 실행은 보지 않는다: 작업자 자리와 세션 자리는 따로다(B-07, scheduler/queue.ts의 종류별 자리).
function priorRunFacts(ledger: TestFactLedger): PreAssignFacts {
  try {
    const runs = rowsOf(() => ledger.listRuns());
    if (runs === null) return UNKNOWN;
    const holds = rowsOf(() => ledger.slotHolds());
    if (holds === null) return UNKNOWN;
    let unconfirmed = false;
    for (const run of runs) {
      const kind: unknown = run.kind;
      const state: unknown = run.state;
      if (!KINDS.includes(kind) || !(LEDGER_RUN_STATES as readonly unknown[]).includes(state)) return UNKNOWN;
      if (kind === "worker" && END_UNCONFIRMED.includes(state as LedgerRunState)) unconfirmed = true;
    }
    for (const hold of holds) {
      const kind: unknown = hold.kind;
      const holdsSlot: unknown = hold.holdsSlot;
      if (!KINDS.includes(kind) || typeof holdsSlot !== "boolean") return UNKNOWN;
      if (kind === "worker" && holdsSlot) unconfirmed = true;
    }
    return Object.freeze({ prior_run_end_unconfirmed: unconfirmed });
  } catch {
    return UNKNOWN;
  }
}

// 배정 전 사실의 시험 공급자. 부탁 내용과 무관한 장부 사실이라 부탁마다 장부를 새로 읽는다(dispatch/pick.md "뒤 조각이 지킬 것").
// 같은 박자에서 시작을 먼저 하므로(assign-loop.ts) 그 박자에 시작한 실행도 이 읽기에 보인다.
export function testFactSource(ledger: TestFactLedger): FactSource {
  return { facts: () => priorRunFacts(ledger) };
}
