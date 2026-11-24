// D-90 자동 닫기의 한 박자. 실행기가 받은 적 없는 작업자 실행을 고르고, 그 실행기의 마지막 반영 인사(증거 포트)가 조건을 모두 채울 때만
// 장부의 closeUnreceivedRun을 부른다. 닫는 판단은 장부가 한 트랜잭션에서 다시 한다. 이 박자는 후보를 고르고 부를 뿐이다.
// 장부·증거·맡기지 않을 실행기·정지 세대·복원 대기는 포트로, 닫는 시각(now)은 순서기가 다시 읽은 장부 시계로 받는다.
// 소켓·타이머·시계·난수를 직접 부르지 않는다. 쥐는 것은 이 모듈의 박자가 진행 중이라는 표시 하나다(돌아오면 지운다).
//
// 지키는 것(unreceived.md "판단의 차례"):
// 1. 모름은 닫지 않는다. 포트가 던지거나 꼴이 틀리거나 known: false면 그 항목(전역 포트면 박자 전체)은 장부를 부르지 않는다.
//    포트 객체와 그 함수는 박자 처음에 한 번 꺼낸다(hold). 꺼내기의 예외·함수 아님은 그 포트를 쓸 수 없는 것으로 친다.
//    부른 뒤의 예외는 다르다: confirm이 던지면 확인하지 못한 것(link_not_current), 장부 닫기가 던지면 적었는지 모르는 것(멈춤)이다.
// 2. 근거는 그 실행기의 지금 인정된 연결이 낸 검증된 전체 인사 하나다. 연결 번호·주체·맞춘 정지 세대·서명 시각(answeredAt)·전체 목록을
//    한 묶음으로 받고, 받은 시각(receivedAt)은 근거 줄에 적을 값으로만 넘긴다.
// 3. 그 실행기의 앞선 답이 버려진 적이 있거나(tainted) 더 새 답이 줄에 남아 있으면(pending) 닫지 않는다.
// 4. 증거 포트의 confirm이 장부 호출 전의 마지막 증거 호출이다. 연결의 현재성, 증거를 읽은 뒤 그 실행기 줄의 변화(version),
//    정지 세대를 한 번에 판정한다. 그 뒤로는 박자 유효 문 하나만 부르고(confirm 안에서 박자 기한이 지났을 수 있다) 외부 객체의
//    속성도 읽지 않으며, 꺼내 둔 함수와 미리 만든 인자로 장부를 부른다.
//    증거 읽기부터 장부 호출까지 await가 없다.
// 5. 장부의 거절·예외·정의 밖의 답은 닫힘으로 세지 않는다. 예외와 정의 밖의 답은 그 자리에서 박자를 멈춘다(장부가 적었는지 모른다).
// 6. 새 인사를 부르는 갈래(rehello 포트가 있을 때만): 그 실행기의 마지막 반영 인사가 시한 전이라 장부를 부를 수 없고, 시한이 지났고,
//    그 연결을 닫은 적이 없고, 재접속 제한 창이 지났고, 그 실행기에 임대를 믿을 실행이 없을 때만 그 연결을 한 번 닫는다. 차례는 장부
//    닫기와 같다: confirm이 마지막 증거 호출이고, 그 뒤에는 닫기 문 하나와 기억 적기, 꺼내 둔 closeConnection 호출뿐이다.
import { limits, parsePrincipal, RUN_STATES, type RunState, type RunStatus } from "../../contract/v1/index.ts";
import {
  LEDGER_RUN_STATES,
  type Ledger,
  REFUSALS as LEDGER_REFUSALS,
  type LedgerRunState,
  type Refusal as LedgerRefusal,
  type Restorer,
  type UnreceivedClosureInput,
} from "../../ledger/index.ts";
import type { WithheldSource } from "./assign-loop.ts";

// 장부 포트. 읽기 하나와 닫기 하나다. 다른 쓰기는 받지 않는다. 닫기의 성공에서 이 박자가 보는 칸은 실행 ID와 상태 둘이고,
// closed의 보장도 그 수준이다(장부가 이 실행을 not_started로 닫았다고 답했다). 실제 장부는 같은 커밋에서 적은 실행 줄 전체를 돌려준다.
export interface UnreceivedLedger {
  unansweredInstructions: Ledger["unansweredInstructions"];
  closeUnreceivedRun(
    input: UnreceivedClosureInput,
    from: { sender: string },
  ): { ok: true; run: { readonly runId: string; readonly state: LedgerRunState } } | { ok: false; reason: LedgerRefusal };
  // 새 인사 갈래만 쓰는 읽기 둘(그 실행기에 임대를 믿을 실행이 있는가). 없으면 그 갈래는 닫지 않는다.
  listRuns?: Ledger["listRuns"];
  instructionTimes?: Ledger["instructionTimes"];
}

// 새 인사를 부르는 갈래의 박자 사이 기억. 이 갈래가 닫은 연결 번호를 쥔다. 값은 이 모듈의 WeakMap으로만 닿아 포트 코드가 고치지 못한다.
declare const rehelloMemoryBrand: unique symbol;
export type RehelloMemory = { readonly [rehelloMemoryBrand]: true };
const REHELLO_CLOSED = new WeakMap<object, Set<number>>();

// 프로세스에 하나를 만들어 박자마다 같은 값을 넘긴다. 박자마다 새로 만들면 같은 연결을 박자마다 닫는다.
export function createRehelloMemory(): RehelloMemory {
  const token = Object.freeze({});
  REHELLO_CLOSED.set(token, new Set());
  return token as RehelloMemory;
}

// 새 인사를 부르는 갈래(A6e)의 포트. 조립이 넘기고, 빠지면 이 갈래는 없다(닫지 않는다).
export interface UnreceivedRehello {
  // 서버의 closeConnection(transport/server.ts). 동기다.
  closeConnection(connection: number): { readonly kind: "closed" | "not_open" | "stopping" };
  // confirm 뒤, closeConnection 바로 앞에서 한 번 본다. 읽기만 한다. 조립은 순서기의 발급 깃발과 박자 유효 문을 함께 본 값을 넘긴다
  // (서버는 발급 깃발을 모른다, server.md "뒤 조각이 지켜야 할 것").
  valid(): boolean;
  // createRehelloMemory()가 만든 값. 다른 값이면 이 갈래는 닫지 않는다.
  readonly memory: RehelloMemory;
  // 서버에 넘긴 연결 판단의 재접속 제한 창(settings.reconnect.windowMs). 제한이 없으면 null.
  readonly reconnectWindowMs: number | null;
}

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
// version: 그 실행기 줄의 변경 번호. 이 읽기 뒤에 그 줄에 변화가 있으면 confirm이 evidence_changed를 낸다(unreceived.md "뒤 조각").
// 네 칸(version·tainted·pending·lastFull)은 한 시점의 값이어야 한다. 이 박자는 번호를 먼저·마지막에 다시 읽어 그 사이의 변화만 잡는다.
export type UnreceivedEvidenceRead =
  | { readonly known: false }
  | { readonly known: true; readonly tainted: boolean; readonly pending: boolean; readonly version: number; readonly lastFull: UnreceivedFull | null };

// confirm의 답. current만 장부로 간다.
export type UnreceivedConfirm = "current" | "link_not_current" | "evidence_changed" | "stop_generation";

// 동기여야 한다: 읽기와 확인과 장부 호출 사이에 await가 없다.
export interface UnreceivedEvidence {
  read(executorId: string): UnreceivedEvidenceRead;
  // 장부 호출 직전에 한 번 부른다. 차례대로 본다: connection이 지금의 복원기로 인정된 그 실행기의 연결인가(내보내기 포트의
  // answers.current와 같은 판정) → 복원기의 정지 세대가 stopGeneration인가 → 그 실행기 줄의 변경 번호가 아직 version인가.
  // 읽기만 한다(줄을 넘기거나 버리지 않는다).
  confirm(executorId: string, connection: number, version: number, stopGeneration: number): UnreceivedConfirm;
}

export interface UnreceivedPorts {
  readonly ledger: UnreceivedLedger;
  readonly evidence: UnreceivedEvidence;
  // 배정·송신과 같은 원천(답 줄의 withheld).
  readonly withheld: WithheldSource;
  // 연결 판단의 맞춤에 쓴 그 복원기.
  readonly intake: Pick<Restorer, "stopGeneration">;
  // 답 줄과 같은 신호: 복원 2단계가 붙든 관측을 적었는가.
  readonly observationsSettled: () => boolean;
  // 이 박자가 아직 유효한가(박자 기한, 끝 코드, 장부 건강, 낸 허가의 폐기). confirm 뒤, 장부 닫기 바로 앞에서 본다(그 사이 다른 호출은
  // 없다). 거짓·던짐이면 닫지 않고 박자를 멈춘다(beat_closed). 빠지면 늘 유효다(이 부품 단독의 쓰임). 조립은 반드시 넘긴다.
  readonly beatValid?: () => boolean;
  // 새 인사를 부르는 갈래. 빠지면 시한 전의 인사뿐인 실행은 그대로 answer_too_early다.
  readonly rehello?: UnreceivedRehello;
}

// 장부의 START_UNREACHABLE_MS와 같은 식이다(장부는 내보내지 않는다). 장부가 같은 트랜잭션에서 다시 보므로 이 값은 부르지 않을 항목을
// 미리 거르는 데만 쓴다: 장부 값보다 작으면 장부가 answer_too_early로 거절하고, 크면 늦게 닫힐 뿐이다. 정각(발행 + 이 값)은 통과다.
export const UNRECEIVED_ANSWER_AFTER_MS = Math.max(limits.RUN_LEASE_MAX_MS, limits.MESSAGE_TTL_MAX_MS);

// 새 인사를 부를 수 있는 이른 시각: 시작 발행 + 이 값. 실행기 시계가 CLOCK_SKEW_MS까지 늦으면 닫은 직후의 새 인사도 서명 시각이
// 그만큼 이르다. 그만큼 더 기다려 새 인사가 장부의 시간 경계(발행 + UNRECEIVED_ANSWER_AFTER_MS)를 넘게 한다.
export const REHELLO_AFTER_MS = UNRECEIVED_ANSWER_AFTER_MS + limits.CLOCK_SKEW_MS;

export type UnreceivedNotRun =
  | "now_malformed"
  | "tick_in_progress"
  | "observations_unsettled"
  | "stop_generation_unknown"
  // 복원기의 정지 세대와 장부의 지금 정지 세대가 다르다(정지·복원이 바뀌는 중).
  | "stop_generation_mismatch"
  | "withheld_unknown"
  // 장부 읽기를 모른다. 장부 포트나 그 두 함수를 꺼내지 못한 것도 여기다.
  | "read_unknown";

// 박자를 멈춘 이유. threw는 장부 호출이 던졌거나 답이 정의 밖이다. beat_closed는 장부 닫기 바로 앞에서 본 박자 유효 문이 닫혔다(그 항목은
// 장부를 부르지 않았다). 나머지는 항목마다 다시 본 전역 포트가 박자 처음과 달라졌다.
export type UnreceivedHalt = "threw" | "observations_unsettled" | "stop_generation_unknown" | "stop_generation_mismatch" | "withheld_unknown" | "beat_closed";

export type UnreceivedSkip =
  // 닫을 수 있는 상태(preparing·unknown_running)가 아니다.
  | "run_state"
  | "not_worker"
  // 지시를 적을 때의 세대나 인사가 맞춘 세대가 지금 세대와 다르다. confirm이 정지 세대가 바뀌었다고 낸 것도 여기다.
  | "stop_generation"
  | "withheld"
  // 증거를 읽지 못했거나 꼴이 틀렸거나 known: false다. 증거 포트를 꺼내지 못한 것도 여기다.
  | "evidence_unknown"
  | "tainted"
  | "pending"
  // 반영된 전체 인사가 없다.
  | "no_full"
  | "principal_mismatch"
  | "answer_too_early"
  | "run_in_answer"
  // confirm이 그 인사의 연결이 지금 인정된 연결이 아니라고 냈다. 던짐·정의 밖의 답도 여기다(확인하지 못했다).
  | "link_not_current"
  // confirm이 증거를 읽은 뒤 그 실행기 줄에 변화가 있었다고 냈다(접수·버림·넘김·고장·맡기지 않을 실행기에 듦).
  // 증거를 옮기는 도중 변경 번호가 바뀐 것도 여기다.
  | "evidence_changed";

// 새 인사 갈래가 닫지 않은 이유. 그 항목은 skipped/answer_too_early이고 이 이름을 rehello 칸에 싣는다.
export type UnreceivedRehelloSkip =
  // 지금이 시작 발행 + REHELLO_AFTER_MS 전이다.
  | "too_soon"
  // 이 갈래가 그 인사의 연결을 이미 닫았다(그 뒤 새 연결의 인사가 반영되지 않았다).
  | "closed_before"
  // 그 인사를 받은 지 재접속 제한 창이 지나지 않았다(그 연결이 창 안에서 열렸을 수 있다).
  | "reconnect_window"
  // 그 실행기에 임대를 믿을 실행이 있다(끝 모름 포함).
  | "lease_trusted"
  // 임대를 보는 장부 읽기를 모른다.
  | "lease_unknown"
  // confirm의 답(장부 닫기와 같은 이름).
  | "link_not_current"
  | "evidence_changed"
  | "stop_generation"
  // closeConnection 바로 앞의 문이 닫혔다.
  | "gate_closed";

// 새 인사 갈래가 부른 closeConnection의 결과. threw·malformed_answer는 닫혔는지 모른다(기억에는 남긴다).
export type UnreceivedRehelloResult = "closed" | "not_open" | "stopping" | "threw" | "malformed_answer";

type Head = { readonly requestId: string; readonly runId: string; readonly executorId: string };

export type UnreceivedOutcome =
  // 장부가 not_started로 닫았다고 답했다. connection·answeredAt은 근거로 넘긴 인사의 값, at은 넘긴 now다.
  | (Head & { readonly outcome: "closed"; readonly connection: number; readonly answeredAt: number; readonly at: number })
  | (Head & { readonly outcome: "refused"; readonly reason: LedgerRefusal })
  // rehello는 새 인사 갈래가 있고 시한 전의 인사라 그 갈래를 본 항목에만 있다.
  | (Head & { readonly outcome: "skipped"; readonly reason: UnreceivedSkip; readonly rehello?: UnreceivedRehelloSkip })
  // 새 인사 갈래가 그 실행기의 연결을 닫으려고 closeConnection을 불렀다. 장부는 부르지 않았다. connection·answeredAt은 시한 전 인사의 값이다.
  | (Head & { readonly outcome: "rehello"; readonly connection: number; readonly answeredAt: number; readonly result: UnreceivedRehelloResult })
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
// 장부의 TERMINAL과 같은 집합. 이 둘 밖의 실행은 임대를 믿을 수 있다(새 인사 갈래의 임대 확인).
const ENDED: readonly LedgerRunState[] = ["finalized", "not_started"];
// 계약의 실행 상태 항목의 칸(transport.ts의 runStatus). 장부의 answerRuns도 이 칸만 받는다.
const RUN_STATUS_KEYS: readonly string[] = ["run_id", "state", "run_generation", "last_receipt_id"];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
// 계약의 일반 객체(src/contract/v1/schema.ts의 object가 받는 값): 배열이 아니고 원형이 Object.prototype이나 null이다.
// 계약 모듈은 이 판정을 내보내지 않아 같은 식을 둔다.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isRefusal = (value: unknown): value is LedgerRefusal => (LEDGER_REFUSALS as readonly unknown[]).includes(value);
const isState = (value: unknown): value is LedgerRunState => (LEDGER_RUN_STATES as readonly unknown[]).includes(value);
const isRunState = (value: unknown): value is RunState => (RUN_STATES as readonly unknown[]).includes(value);
// 꺼내 둔 함수를 꺼내 둔 수신자로 부른다. fn.call은 포트가 준 함수 객체의 속성이라 읽지 않는다.
const apply = Reflect.apply;

function isWorkerName(value: unknown): value is string {
  try {
    return typeof value === "string" && parsePrincipal(value)?.kind === "worker_executor";
  } catch {
    return false;
  }
}

type Fn = (...args: unknown[]) => unknown;
interface Bound {
  readonly receiver: unknown;
  readonly fn: Fn;
}

// 박자 처음에 한 번 꺼낸 포트. 그 뒤로는 포트 객체의 속성을 읽지 않는다. null은 꺼내지 못한 것이다.
interface Held {
  readonly ledger: object;
  readonly unanswered: Fn;
  readonly close: Fn;
  readonly evidence: { readonly read: Bound; readonly confirm: Bound } | null;
  readonly stopGeneration: Bound | null;
  readonly executors: Bound | null;
  readonly settled: Bound | null;
  // 박자 유효 문. absent는 포트가 없음(늘 유효), null은 꺼내지 못함(늘 무효)이다.
  readonly beatValid: Bound | "absent" | null;
  // 새 인사 갈래. null은 포트가 없거나 꺼내지 못한 것이다(닫지 않는다).
  readonly rehello: HeldRehello | null;
}

interface HeldRehello {
  readonly closeConnection: Bound;
  readonly valid: Bound;
  readonly closed: Set<number>;
  readonly windowMs: number | null;
  // 장부 포트의 읽기 둘. 수신자는 Held.ledger다.
  readonly runs: Fn;
  readonly times: Fn;
}

function take(get: () => { receiver: unknown; fn: unknown }): Bound | null {
  try {
    const { receiver, fn } = get();
    return typeof fn === "function" ? { receiver, fn: fn as Fn } : null;
  } catch {
    return null;
  }
}

// 장부를 꺼내지 못하면 박자 전체가 read_unknown이다. 다른 포트는 꺼내지 못해도 그 포트의 모름으로 이어 간다.
// 진행 표시를 세운 뒤에 부른다: 이 안의 접근자는 모두 외부 코드라 그 안에서 박자를 다시 부를 수 있다.
function hold(ports: UnreceivedPorts): Held | null {
  let ledger: unknown;
  let unanswered: unknown;
  let close: unknown;
  try {
    ledger = ports.ledger;
    if (!isObject(ledger)) return null;
    unanswered = ledger.unansweredInstructions;
    close = ledger.closeUnreceivedRun;
  } catch {
    return null;
  }
  if (typeof unanswered !== "function" || typeof close !== "function") return null;
  let beatValid: Held["beatValid"] = null;
  try {
    const fn: unknown = ports.beatValid;
    beatValid = fn === undefined ? "absent" : typeof fn === "function" ? { receiver: ports, fn: fn as Fn } : null;
  } catch {
    beatValid = null;
  }
  let evidence: Held["evidence"] = null;
  try {
    const port: unknown = ports.evidence;
    if (isObject(port)) {
      const read: unknown = port.read;
      const confirm: unknown = port.confirm;
      if (typeof read === "function" && typeof confirm === "function") evidence = { read: { receiver: port, fn: read as Fn }, confirm: { receiver: port, fn: confirm as Fn } };
    }
  } catch {
    evidence = null;
  }
  // 새 인사 갈래는 포트·기억·창·장부 읽기 둘 가운데 하나라도 꺼내지 못하면 없는 것이다(모름은 닫지 않는다).
  let rehello: HeldRehello | null = null;
  try {
    const port: unknown = ports.rehello;
    if (isObject(port)) {
      const closeConnection: unknown = port.closeConnection;
      const valid: unknown = port.valid;
      const memory: unknown = port.memory;
      const windowMs: unknown = port.reconnectWindowMs;
      const runs: unknown = ledger.listRuns;
      const times: unknown = ledger.instructionTimes;
      const closed = isObject(memory) ? REHELLO_CLOSED.get(memory) : undefined;
      if (
        typeof closeConnection === "function" &&
        typeof valid === "function" &&
        closed !== undefined &&
        (windowMs === null || isTime(windowMs)) &&
        typeof runs === "function" &&
        typeof times === "function"
      ) {
        rehello = { closeConnection: { receiver: port, fn: closeConnection as Fn }, valid: { receiver: port, fn: valid as Fn }, closed, windowMs, runs: runs as Fn, times: times as Fn };
      }
    }
  } catch {
    rehello = null;
  }
  return {
    ledger: ledger as object,
    unanswered: unanswered as Fn,
    close: close as Fn,
    evidence,
    stopGeneration: take(() => {
      const intake: unknown = ports.intake;
      return { receiver: intake, fn: isObject(intake) ? intake.stopGeneration : undefined };
    }),
    executors: take(() => {
      const source: unknown = ports.withheld;
      return { receiver: source, fn: isObject(source) ? source.executors : undefined };
    }),
    settled: take(() => ({ receiver: ports, fn: ports.observationsSettled })),
    beatValid,
    rehello,
  };
}

// 박자 유효 문을 부른다. 던지거나 true가 아니면 무효다(모름을 유효로 읽지 않는다).
function beatStillValid(held: Held): boolean {
  if (held.beatValid === "absent") return true;
  const answer = invoke(held.beatValid, []);
  return answer !== null && answer.value === true;
}

// 던지면 null. 돌려준 값은 그대로 싣는다(꼴은 부른 쪽이 본다).
function invoke(bound: Bound | null, args: readonly unknown[]): { readonly value: unknown } | null {
  if (bound === null) return null;
  try {
    return { value: apply(bound.fn, bound.receiver, args) };
  } catch {
    return null;
  }
}

// 진행 중인 박자. 박자 안에 await가 없으므로 겹치는 길은 포트 안에서 다시 부르는 것뿐이다. 장부 객체로 가르지 않고 이 모듈 단위로
// 세운다: 장부 객체를 얻는 ports.ledger 접근자도 외부 코드이고, 감싼 다른 포트 객체가 같은 장부로 위임할 수도 있다.
let running = false;

export function unreceivedTick(ports: UnreceivedPorts, now: number): UnreceivedTickResult {
  if (running) return { kind: "not_run", reason: "tick_in_progress" };
  running = true;
  try {
    const held = hold(ports);
    if (held === null) return { kind: "not_run", reason: "read_unknown" };
    return tickOnce(held, now);
  } finally {
    running = false;
  }
}

interface Gate {
  readonly generation: number;
  readonly withheld: ReadonlySet<string>;
}

// 전역 포트 셋. 박자 처음과, 항목마다 증거를 읽은 뒤에 다시 본다(앞 항목의 장부 쓰기나 포트가 같은 동기 구간에서 바꿀 수 있다).
// 복원 대기를 마지막에 본다: 앞의 두 조회 안에서 바뀐 정지 세대·줄은 confirm이 다시 보지만 복원 대기는 다시 보지 않는다.
function readGate(held: Held): Gate | Exclude<UnreceivedHalt, "threw" | "stop_generation_mismatch" | "beat_closed"> {
  const generation = invoke(held.stopGeneration, []);
  if (generation === null || !isGeneration(generation.value)) return "stop_generation_unknown";
  const withheld = readWithheld(held.executors);
  if (withheld === null) return "withheld_unknown";
  const settled = invoke(held.settled, []);
  if (settled === null || settled.value !== true) return "observations_unsettled";
  return { generation: generation.value, withheld };
}

// 배정 박자(assign-loop.ts의 readWithheld)와 같은 검사다. value는 한 번만 읽고, 원소 하나라도 작업자 실행기 이름이 아니면 모름이다.
function readWithheld(source: Bound | null): ReadonlySet<string> | null {
  const read = invoke(source, []);
  if (read === null) return null;
  try {
    const answer: unknown = read.value;
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

function readUnanswered(held: Held): { stopGeneration: number | null; instructions: unknown[] } | null {
  try {
    const answer: unknown = apply(held.unanswered, held.ledger, []);
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
  readonly version: number;
  readonly full: UnreceivedFull | null;
  readonly confirm: Bound;
}

// 전체 목록을 계약의 실행 상태 항목 규칙(transport.ts의 runStatus·runList)으로 보고 새 객체로 옮긴다. 장부가 입력에서 거절할 꼴을
// 장부까지 보내면 박자 전체가 멈추므로 여기서 그 항목의 모름으로 끝낸다. 칸마다 한 번 읽고, 하나라도 틀리면 null이다.
function copyRuns(value: unknown): RunStatus[] | null {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  if (length > limits.STATUS_MAX_RUNS) return null;
  const out: RunStatus[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < length; i += 1) {
    const item: unknown = value[i];
    if (!isPlainObject(item)) return null;
    const keys = Object.keys(item);
    if (keys.length !== RUN_STATUS_KEYS.length || !keys.every((key) => RUN_STATUS_KEYS.includes(key))) return null;
    const runId: unknown = item.run_id;
    const state: unknown = item.state;
    const generation: unknown = item.run_generation;
    const receipt: unknown = item.last_receipt_id;
    if (!isUuid(runId) || seen.has(runId) || !isRunState(state)) return null;
    seen.add(runId);
    if (state === "not_known") {
      if (generation !== null || receipt !== null) return null;
      out.push({ run_id: runId, state, run_generation: null, last_receipt_id: null });
      continue;
    }
    if (!Number.isSafeInteger(generation) || (generation as number) < 1 || !(receipt === null || isUuid(receipt))) return null;
    out.push({ run_id: runId, state, run_generation: generation as number, last_receipt_id: receipt });
  }
  return out;
}

// 증거를 한 번 읽어 칸마다 옮긴다. 목록은 원소까지 새로 만든다: 뒤의 포트(confirm)가 넘겨준 객체를 고쳐도 장부에 넘기는 값은 읽은 그대로다.
// 칸 하나라도 틀리면(꼴이 아닌 깃발 포함) 모름이다.
// 변경 번호를 다른 칸보다 먼저 읽고, 다 옮긴 뒤 다시 읽는다. 칸의 접근자는 외부 코드라 읽는 도중에 그 실행기 줄에 답이 들어올 수 있다.
// 번호를 나중에 읽으면 앞서 옮긴 대기·오염 값(변화 전)과 변화 뒤의 번호가 한 쌍이 되어 confirm이 번호끼리 같다고 본다.
// 다시 읽은 번호가 다르면 changed다(그 시도는 닫지 않는다). 번호 칸의 접근자 자체나 read 안에서 생긴 변화는 여기서 가를 수 없어
// read가 모든 칸을 한 시점의 값으로 내야 한다(unreceived.md "뒤 조각").
function readEvidence(port: Held["evidence"], executorId: string): Evidence | "changed" | null {
  if (port === null) return null;
  const read = invoke(port.read, [executorId]);
  if (read === null) return null;
  try {
    const answer: unknown = read.value;
    if (!isObject(answer)) return null;
    const version: unknown = answer.version;
    if (answer.known !== true || !isGeneration(version)) return null;
    const tainted: unknown = answer.tainted;
    const pending: unknown = answer.pending;
    const lastFull: unknown = answer.lastFull;
    if (typeof tainted !== "boolean" || typeof pending !== "boolean") return null;
    let full: UnreceivedFull | null = null;
    if (lastFull !== null) {
      if (!isObject(lastFull)) return null;
      const connection: unknown = lastFull.connection;
      const principal: unknown = lastFull.principal;
      const stopGeneration: unknown = lastFull.stopGeneration;
      const runs: unknown = lastFull.runs;
      const answeredAt: unknown = lastFull.answeredAt;
      const receivedAt: unknown = lastFull.receivedAt;
      if (!isGeneration(connection) || typeof principal !== "string" || !isGeneration(stopGeneration) || !isTime(answeredAt) || !isTime(receivedAt)) return null;
      const copied = copyRuns(runs);
      if (copied === null) return null;
      full = { connection, principal, stopGeneration, runs: copied, answeredAt, receivedAt };
    }
    if (answer.version !== version) return "changed";
    return { tainted, pending, version, full, confirm: port.confirm };
  } catch {
    return null;
  }
}

// 장부 호출 전의 마지막 외부 호출. 돌아온 뒤에는 원시값 비교만 한다. 던짐·정의 밖의 답은 확인하지 못한 것이다.
function confirmLast(port: Bound, executorId: string, connection: number, version: number, generation: number): UnreceivedConfirm {
  let answer: unknown;
  try {
    answer = apply(port.fn, port.receiver, [executorId, connection, version, generation]);
  } catch {
    return "link_not_current";
  }
  return answer === "current" || answer === "evidence_changed" || answer === "stop_generation" ? answer : "link_not_current";
}

type Judged = { readonly outcome: UnreceivedOutcome | null; readonly halt: UnreceivedHalt | null };

// 새 인사 갈래의 준비 결과. go면 confirm부터 간다. null이면 이 갈래를 볼 항목이 아니다.
type RehelloPlan = "go" | Exclude<UnreceivedRehelloSkip, "link_not_current" | "evidence_changed" | "stop_generation" | "gate_closed">;

// 새 인사 갈래의 준비. 그 실행기의 마지막 반영 인사가 시한 전이라 장부를 부를 수 없는 항목만 본다. 증거를 읽은 바로 뒤, 전역 포트를
// 다시 보기 전에 부른다: 장부 읽기(임대)도 외부 코드라, 복원 대기를 confirm 앞의 마지막 전역 조회로 두는 차례(readGate)를 지킨다.
function planRehello(held: Held, item: StartItem, evidence: Evidence | "changed" | null, now: number): RehelloPlan | null {
  const port = held.rehello;
  if (port === null || evidence === null || evidence === "changed" || evidence.tainted || evidence.pending) return null;
  const full = evidence.full;
  if (full === null || full.principal !== item.executorId || full.answeredAt >= item.issuedAt + UNRECEIVED_ANSWER_AFTER_MS) return null;
  if (now < item.issuedAt + REHELLO_AFTER_MS) return "too_soon";
  // 닫은 연결의 인사가 아직 마지막 반영 인사다: 새 연결의 인사가 오기 전이다. 연결 번호는 서버가 다시 쓰지 않는다.
  if (port.closed.has(full.connection)) return "closed_before";
  // 연결은 그 인사를 받기 전에 열렸다. 받은 때가 창 정각 이전이면 다시 붙는 시각의 창(정각 제외)에 이 연결이 들지 않아, 닫은 뒤의
  // 재접속이 이 연결 때문에 throttled가 되지 않는다(server.md "재접속 제한과 간격을 맞춘다"). 한 실행기를 창마다 한 번 넘게 닫지 않는 것도 된다.
  if (port.windowMs !== null && now - full.receivedAt < port.windowMs) return "reconnect_window";
  return leaseFree(held.ledger, port, item.executorId, now);
}

// 그 실행기에 임대를 믿을 실행이 없는가. 끝나지 않은(finalized·not_started 밖) 그 실행기 실행마다 장부가 믿는 임대의 끝을 본다.
// 끝 + CLOCK_SKEW_MS가 now 이하일 때만 끝난 것으로 친다(실행기 시계가 늦으면 그만큼 더 돈다). 끝 모름은 믿는 것, 읽기 모름은 모름이다.
// 닫으면 그 실행기는 다시 붙어 맞출 때까지 지시·갱신을 받지 못한다(server.md "closeConnection은 그 실행기에 임대를 믿는 실행이 없을 때만").
function leaseFree(ledger: object, port: HeldRehello, executorId: string, now: number): RehelloPlan {
  const ids: string[] = [];
  try {
    const read: unknown = apply(port.runs, ledger, []);
    if (!isObject(read) || read.known !== true) return "lease_unknown";
    const value: unknown = read.value;
    if (!Array.isArray(value)) return "lease_unknown";
    const length = value.length;
    for (let i = 0; i < length; i += 1) {
      const run: unknown = value[i];
      if (!isObject(run)) return "lease_unknown";
      const runId: unknown = run.runId;
      const owner: unknown = run.executorId;
      const state: unknown = run.state;
      if (!isUuid(runId) || typeof owner !== "string" || !isState(state)) return "lease_unknown";
      if (owner === executorId && !ENDED.includes(state)) ids.push(runId);
    }
  } catch {
    return "lease_unknown";
  }
  for (const runId of ids) {
    try {
      const read: unknown = apply(port.times, ledger, [runId]);
      if (!isObject(read) || read.known !== true) return "lease_unknown";
      const times: unknown = read.value;
      if (!isObject(times)) return "lease_unknown";
      const lease: unknown = times.lease;
      if (lease === null) continue;
      if (!isObject(lease)) return "lease_unknown";
      const end: unknown = lease.expiresAt;
      if (end === "unknown") return "lease_trusted";
      if (!isTime(end)) return "lease_unknown";
      if (now < end + limits.CLOCK_SKEW_MS) return "lease_trusted";
    } catch {
      return "lease_unknown";
    }
  }
  return "go";
}

// 새 인사 갈래의 닫기 문. 던지거나 true가 아니면 닫힘이다.
function rehelloStillValid(valid: Bound): boolean {
  const answer = invoke(valid, []);
  return answer !== null && answer.value === true;
}

// 시한 전의 인사뿐인 항목. 갈래가 없거나 볼 항목이 아니면 answer_too_early 그대로다. 차례는 장부 닫기(judge)와 같다: confirm이 마지막
// 증거 호출이고, 그 뒤에는 닫기 문 하나, 기억 적기, 꺼내 둔 closeConnection 호출뿐이다. 닫기 실패(던짐·정의 밖의 답)는 박자를 멈추지 않는다:
// 장부를 쓰지 않았고, 기억에 남겨 같은 연결을 다시 닫지 않는다.
function rehello(held: Held, head: Head, full: UnreceivedFull, evidence: Evidence, gate: Gate, plan: RehelloPlan | null): Judged {
  const early: UnreceivedOutcome = { ...head, outcome: "skipped", reason: "answer_too_early" };
  const port = held.rehello;
  if (port === null || plan === null) return { outcome: early, halt: null };
  const parked = (why: UnreceivedRehelloSkip): Judged => ({ outcome: { ...head, outcome: "skipped", reason: "answer_too_early", rehello: why }, halt: null });
  if (plan !== "go") return parked(plan);
  const { closed, valid, closeConnection: { fn: shut, receiver: shutReceiver } } = port;
  const connection = full.connection;
  const done = (result: UnreceivedRehelloResult): Judged => ({ outcome: { ...head, outcome: "rehello", connection, answeredAt: full.answeredAt, result }, halt: null });
  const linked = confirmLast(evidence.confirm, head.executorId, connection, evidence.version, gate.generation);
  if (linked !== "current") return parked(linked);
  if (!rehelloStillValid(valid)) return parked("gate_closed");
  closed.add(connection);
  let answer: unknown;
  try {
    answer = apply(shut, shutReceiver, [connection]);
  } catch {
    return done("threw");
  }
  try {
    if (!isObject(answer)) return done("malformed_answer");
    const kind: unknown = answer.kind;
    return done(kind === "closed" || kind === "not_open" || kind === "stopping" ? kind : "malformed_answer");
  } catch {
    return done("malformed_answer");
  }
}

function tickOnce(held: Held, now: number): UnreceivedTickResult {
  if (!isTime(now)) return { kind: "not_run", reason: "now_malformed" };
  const first = readGate(held);
  if (typeof first === "string") return { kind: "not_run", reason: first };
  const read = readUnanswered(held);
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
    const judged = judge(held, item, ledgerGeneration, now);
    if (judged.outcome !== null) runs.push(judged.outcome);
    if (judged.halt !== null) return { kind: "ran", runs, halted: judged.halt, haltedAt: item.requestId };
  }
  return { kind: "ran", runs, halted: null, haltedAt: null };
}

// 항목 하나의 판단. 외부 호출의 차례는 증거 → 전역 포트(정지 세대·맡기지 않을 실행기·복원 대기) → confirm → 박자 유효 문 → 장부이고,
// 그 사이의 비교는 읽어 둔 값만 쓴다. 박자 유효 문 뒤에는 꺼내 둔 함수(close)와 미리 만든 인자(closing)로 장부를 부를 뿐이다.
function judge(held: Held, item: StartItem, ledgerGeneration: number, now: number): Judged {
  const { ledger: receiver, close } = held;
  const head: Head = { requestId: item.requestId, runId: item.runId, executorId: item.executorId };
  const skip = (reason: UnreceivedSkip): Judged => ({ outcome: { ...head, outcome: "skipped", reason }, halt: null });
  if (!CLOSABLE.includes(item.runState)) return skip("run_state");
  if (!isWorkerName(item.executorId)) return skip("not_worker");

  const evidence = readEvidence(held.evidence, item.executorId);
  const plan = planRehello(held, item, evidence, now);
  const gate = readGate(held);
  if (typeof gate === "string") return { outcome: null, halt: gate };
  if (gate.generation !== ledgerGeneration) return { outcome: null, halt: "stop_generation_mismatch" };

  if (item.stopGeneration !== gate.generation) return skip("stop_generation");
  if (gate.withheld.has(item.executorId)) return skip("withheld");
  if (evidence === null) return skip("evidence_unknown");
  if (evidence === "changed") return skip("evidence_changed");
  if (evidence.tainted) return skip("tainted");
  if (evidence.pending) return skip("pending");
  const full = evidence.full;
  if (full === null) return skip("no_full");
  if (full.principal !== item.executorId) return skip("principal_mismatch");
  if (full.stopGeneration !== gate.generation) return skip("stop_generation");
  // 서명 시각만 견준다. 받은 시각은 실행기가 그 시작을 받을 수 없게 된 뒤라는 증거가 아니다.
  if (full.answeredAt < item.issuedAt + UNRECEIVED_ANSWER_AFTER_MS) return rehello(held, head, full, evidence, gate, plan);
  if (full.runs.some((run) => run.run_id === item.runId)) return skip("run_in_answer");

  const closing: readonly unknown[] = [
    { runId: item.runId, runs: full.runs, answeredAt: full.answeredAt, receivedAt: full.receivedAt, now },
    { sender: item.executorId },
  ];
  // 마지막 외부 호출. 증거를 읽은 뒤의 포트 조회 안에서 같은 주체의 새 연결이 옛 연결을 밀어냈거나, 같은 실행기의 새 답이 줄에
  // 들어왔거나, 앞 항목의 장부 쓰기가 복원기의 세대를 바꿨을 수 있다(await가 없어도 바뀐다). 장부를 부를 때마다 그 직전에 다시 본다.
  const confirmed = confirmLast(evidence.confirm, item.executorId, full.connection, evidence.version, gate.generation);
  if (confirmed !== "current") return skip(confirmed);
  // confirm 안에서 흐른 시간으로 박자 기한이 지났을 수 있다. 장부 호출 바로 앞에서 박자 유효 문을 본다.
  if (!beatStillValid(held)) return { outcome: null, halt: "beat_closed" };
  let answer: unknown;
  try {
    answer = apply(close, receiver, closing);
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
    if (!isObject(run)) return malformed;
    const runId: unknown = run.runId;
    const state: unknown = run.state;
    if (runId !== item.runId || state !== "not_started") return malformed;
    return { outcome: { ...head, outcome: "closed", connection: full.connection, answeredAt: full.answeredAt, at: now }, halt: null };
  } catch {
    return malformed;
  }
}
