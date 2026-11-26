// 시험 배정 값(O-D). 감독이 시험 값(OLIVE_TEST_JOBS=on)일 때만 쓰는 배정 정책의 숫자와 배정 전 사실의 공급자다.
// 진입점(src/main/supervisor.ts)이 시험 값에서만 실행 계획·요청 한도를 넣고(testAssignPolicy), 조립(boot.ts)이 같은 시험 값의 설정(testAssign)에서만
// 사실 공급자를 쓴다(testFactSource). 운영 값에서는 이 파일의 무엇도 쓰지 않는다: 실행 계획 없음, 요청 한도 0(planNext가 거절), 사실 모름(보류).
// 파일·환경·시계·난수를 읽지 않는다.
//
// 숫자는 T1(시험 클러스터 한 바퀴)의 시험 숫자이고 T1 실측 뒤 조정한다(README "시험 배정 값").
//
// 배정 전 사실 여섯 가운데 "앞 실행의 종료 미확인"은 장부의 실행 줄·점유 관측으로 판정한다. 나머지 다섯(역할·목적 조합, 원본 고정, 자기 저장소
// 작성, 외부 코드 실행, 스스로 고치는 작성의 근거 문)은 판정할 원천이 감독에 없다. 관리자 결정 D-130에 따라 장부에서 읽은 부탁이 이 파일의
// 고정 T1 부탁(TEST_T1_REQUEST)과 칸마다 같고 앞 실행의 종료를 알 때만 그 다섯을 false(해당 없음)로 채운다. 알고 정한 것: D-118(모델 없는
// 고정 프로그램)을 근거로 시험 값에서 그 안전 검사 다섯을 실제로 하지 않고 건너뛴다. 하나라도 다르거나, 부탁·실행·점유를 읽지 못하면 다섯은
// 비우고 고르기는 evidence_missing으로 보류한다.
import type { Role } from "../../contract/v1/index.ts";
import { LEDGER_RUN_STATES, type Ledger, type LedgerRunState } from "../../ledger/index.ts";
import type { FactSource } from "../dispatch/assign-loop.ts";
import type { PreAssignFact, PreAssignFacts, RunPlan } from "../dispatch/pick.ts";
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

// 고정 T1 부탁(D-130). 시험 값에서 배정 전 사실 다섯을 false로 채우는 부탁은 아래 여섯 칸이 모두 이 값과 같은 것뿐이다. 이 자리 하나에서만 정한다.
// 시험 작업 넣기(homelab olive test-job → admin/test-job.ts)는 값을 그대로 장부에 적으므로 이 값을 넣으면 이 부탁이 된다(README "시험 배정 값").
// 재시도 키도 고정한다: 장부는 (소유자, 키)가 다른 줄을 내용이 같아도 별도 부탁으로 적으므로, 키를 보지 않으면 같은 내용의 부탁을 키만 바꿔
// 여럿 넣어 모두 다섯을 지나게 할 수 있다. 키까지 같으면 장부가 같은 줄(existing)로 돌려줘 한 장부에 고정 부탁은 한 줄뿐이다.
// 함정: 값 하나를 바꾸면 그 값으로 넣은 시험 작업은 다시 evidence_missing으로 보류된다. README의 명령과 함께 바꾼다.
export const TEST_T1_REQUEST: Readonly<{ owner: string; dedupeKey: string; role: Role; purpose: string; sourceRef: string; inputDigest: string }> = Object.freeze({
  // 시험 현관 대역의 소유자 입력(frontdoor/test-double.ts의 TEST_FRONT_DOOR_OWNER. 시험이 같은지 대조한다).
  owner: "00000000-0000-4000-8000-000000000109",
  // 재시도 키. 관리 명령의 key 자리에 이 값을 넣는다.
  dedupeKey: "t1-fixed-program",
  role: TEST_ASSIGN_ROLE,
  purpose: "t1_fixed_program",
  // 그 입력의 원문 참조. 대역이 입력에 적는 값과 같다.
  sourceRef: "test-front-door/00000000-0000-4000-8000-000000000109",
  // 고정 표지 "olive-test-assign/t1-input"의 SHA-256(시험이 다시 계산한다). 고정 프로그램은 입력 원문을 읽지 않는다.
  inputDigest: "921cb0367f6529305ab67ccde99dcf9e5629777718b3d9f309d32c052502b5aa",
});

// 고정 T1 부탁에서만 false로 채우는 다섯 사실. prior_run_end_unconfirmed는 부탁 내용이 아니라 장부의 최신 실행 근거라 따로 읽는다.
export const FIXED_T1_FACTS: readonly PreAssignFact[] = Object.freeze([
  "role_purpose_not_allowed",
  "source_not_pinned",
  "self_repo_write",
  "external_code",
  "self_fix_basis_closed",
]);

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

export type TestFactLedger = Pick<Ledger, "listRuns" | "slotHolds" | "readToolRequest">;

const UNKNOWN: PreAssignFacts = Object.freeze({});
const FIXED_T1_CLEAR: PreAssignFacts = Object.freeze(Object.fromEntries(FIXED_T1_FACTS.map((fact) => [fact, false])));
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

// 부탁이 고정 T1 부탁인가. 고르기와 배정이 쓰는 대기 목록의 항목(소유자·역할·digest)과 장부에서 다시 읽은 부탁 줄(재시도 키·목적·원본 참조까지)을
// 둘 다 대조한다: 항목에는 목적·원본 참조가 없고, 줄만 보면 고르기가 쓰는 항목의 값과 어긋나도 다섯을 채운다.
// 칸마다 한 번만 읽고 그 값만 견준다. 꼴이 틀리거나 읽기가 모름·던짐이면 아니다(다섯 모름).
function isFixedT1(ledger: TestFactLedger, request: unknown): boolean {
  const t1 = TEST_T1_REQUEST;
  try {
    if (!isObject(request)) return false;
    const ref: unknown = request.ref;
    if (typeof ref !== "string") return false;
    if (request.owner !== t1.owner || request.role !== t1.role || request.inputDigest !== t1.inputDigest) return false;
    const answer: unknown = ledger.readToolRequest({ owner: t1.owner, ref });
    if (!isObject(answer) || answer.known !== true) return false;
    const row: unknown = answer.value;
    if (!isObject(row)) return false;
    return (
      row.ref === ref &&
      row.owner === t1.owner &&
      row.dedupeKey === t1.dedupeKey &&
      row.role === t1.role &&
      row.purpose === t1.purpose &&
      row.sourceRef === t1.sourceRef &&
      row.inputDigest === t1.inputDigest
    );
  } catch {
    return false;
  }
}

// 배정 전 사실의 시험 공급자. 앞 실행의 종료는 부탁 내용과 무관한 장부 사실이라 부탁마다 장부를 새로 읽는다(dispatch/pick.md "뒤 조각이 지킬 것").
// 같은 박자에서 시작을 먼저 하므로(assign-loop.ts) 그 박자에 시작한 실행도 이 읽기에 보인다. 다섯 사실은 고정 T1 부탁이고 앞 실행의 종료를
// 알 때만 채운다. 앞 실행을 모르는데 다섯만 false로 내면 장부를 읽지 못한 답이 확인된 사실처럼 보인다(D-130은 읽기 실패에서 다섯을 채우지 않는다).
// 그래서 실행·점유 읽기가 모름이면 부탁 줄을 읽지 않고 여섯을 모두 비운다.
export function testFactSource(ledger: TestFactLedger): FactSource {
  return {
    facts: (request) => {
      const prior = priorRunFacts(ledger);
      if (prior === UNKNOWN) return UNKNOWN;
      if (!isFixedT1(ledger, request)) return prior;
      return Object.freeze({ ...prior, ...FIXED_T1_CLEAR });
    },
  };
}
