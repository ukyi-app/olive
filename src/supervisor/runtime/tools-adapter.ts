// 감독 도구 처리기(scheduler/tools.ts)의 포트(ToolPorts)를 실제 장부·취소 어댑터·정책·설정에 잇는 공장.
// 상태를 갖지 않는다. 시계·난수·타이머·환경을 직접 부르지 않는다: 새 참조의 후보는 주입한 난수 포트로, 취소의 기록 시각은 취소
// 어댑터가 받은 시계 포트로 만든다.
//
// 지키는 것:
// 1. 지금 장부에 맞는 연산이 있는 포트 넷만 잇는다. findByRetryKey → findToolRequest, readOwnedWork → readToolRequest,
//    recordStart → recordToolRequest, requestCancel → cancelAdapter(dispatch/cancel.ts, 안에서 cancelToolRequest).
// 2. 맞는 연산이 없는 포트 셋(liveSession, inputPinned, readResult)은 지어내지 않고 늘 모름(known: false)이다. 처리기는 모름을
//    unknown으로 닫고 그 뒤의 포트를 부르지 않는다. liveSession은 처리기가 도구마다 먼저 부르므로, 이 공장이 돌려준 포트 그대로는
//    네 도구 모두 장부를 읽지도 쓰지도 않고 unknown이다. 세션 계약(U6)이 그 연산을 낼 때까지 그렇게 닫혀 있는 것이 정한 동작이다.
// 3. 장부가 돌려준 줄의 소유자가 묻는 소유자와 다르면 없는 줄(null)로 답한다(처리기 포트의 전제). 남의 줄이 있든 없든 답이 같다.
//    소유자를 가릴 수 없는 줄, 꼴이 틀린 줄, 묻는 키·참조와 다른 자기 줄, 장부의 읽기 실패·던짐은 없음이 아니라 모름이다.
//    모름을 없음으로 바꾸면 본체가 같은 작업을 다시 부르거나 있는 작업을 잃는다.
// 4. 쓰기의 답은 넘긴 값과 대조한 뒤에만 넘긴다. 장부가 말한 결과(created·existing·conflict)와 돌려준 줄의 내용·소유자·키가
//    맞지 않으면 무엇이 적혔는지 모르는 것이라 모름이다. 거절은 장부 설명(ledger.md "작업 부탁")의 옮김대로 stopped,
//    intake_closed·snapshot_hold → intake_closed이고, 그 밖(stop_unknown, ledger_unwritable, invariant_violation 등)은 모름이다.
// 5. 취소 어댑터에는 이 공장이 받은 장부·난수 객체를 그대로 넣는다. 다른 열기의 장부나 다른 난수를 따로 받는 길이 없다.
//    취소의 관측 포트는 공장을 만들 때 받는다: 처리기가 어댑터를 부르기 전에 받는 쪽이 이미 붙어 있다(일부 관측은 처리기의 반환보다 먼저 온다).
import { ROLES } from "../../contract/v1/index.ts";
import type { Ledger } from "../../ledger/index.ts";
import { type CancelPorts, cancelAdapter } from "../dispatch/cancel.ts";
import { newUuid } from "../dispatch/envelopes.ts";
import type { Random } from "../dispatch/ports.ts";
import {
  type Answer,
  type CancelInput,
  type CancelWrite,
  PATTERNS,
  PHASES,
  type ResultView,
  type StartContent,
  type StartRecordInput,
  type StartWrite,
  type ToolConfig,
  type ToolLedgerPort,
  type ToolPolicyPort,
  type ToolPorts,
  type WorkRecord,
} from "../scheduler/tools.ts";

// 실제 장부(openLedger가 연 Ledger)가 그대로 맞는 꼴이다. unansweredInstructions는 취소 어댑터가 적은 지시 줄을 다시 찾는 읽기다.
export type ToolLedger = Pick<Ledger, "findToolRequest" | "readToolRequest" | "recordToolRequest" | "cancelToolRequest" | "unansweredInstructions">;

export interface ToolAdapterDeps {
  readonly ledger: ToolLedger;
  readonly policy: ToolPolicyPort;
  readonly config: ToolConfig;
  // 새 부탁 참조의 후보와 취소 지시의 요청 ID가 여기서 온다. 암호학적 난수여야 한다(ledger.md "참조": 후보가 이미 쓰인 참조면
  // 줄이 생기지 않고 unknown이다. 예측할 수 있는 값이면 남의 참조와 부딪힐 수 있다).
  readonly random: Random;
  // 취소 어댑터의 나머지 포트. 장부와 난수는 위의 것을 쓴다.
  readonly cancel: Omit<CancelPorts, "ledger" | "random">;
}

// 이 공장이 닫아 둔 포트. 문서·시험이 이 목록으로 대조한다.
export const CLOSED_PORTS = ["liveSession", "inputPinned", "readResult"] as const satisfies readonly (keyof ToolLedgerPort)[];
export const LINKED_PORTS = ["findByRetryKey", "readOwnedWork", "recordStart", "requestCancel"] as const satisfies readonly (keyof ToolLedgerPort)[];

const UNKNOWN: { readonly known: false } = Object.freeze({ known: false });
const NONE: Answer<null> = Object.freeze({ known: true, value: null });

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);
const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === "function";

// 장부 줄(ToolRequest)을 포트의 줄(WorkRecord)로 옮긴다. 이름만 다르다(dedupeKey ↔ retryKey, 펼친 네 칸 ↔ content).
// 칸은 한 번씩만 읽고, 처리기의 꼴(PATTERNS·PHASES·ROLES)에 맞지 않으면 null이다. 장부도 꼴을 거르지만 그 보장에 기대지 않는다:
// 처리기의 줄 검사는 목적·원본 참조·digest가 문자열인지만 보므로, 꼴이 틀린 값이 그대로 내용 대조(retry_conflict)에 쓰인다.
function toWork(row: Record<string, unknown>): WorkRecord | null {
  const { ref, owner, dedupeKey, role, purpose, sourceRef, inputDigest, phase } = row;
  if (!matches(ref, PATTERNS.uuid) || !matches(owner, PATTERNS.uuid) || typeof dedupeKey !== "string") return null;
  if (!(ROLES as readonly unknown[]).includes(role) || !matches(purpose, PATTERNS.purpose)) return null;
  if (!matches(sourceRef, PATTERNS.sourceRef) || !matches(inputDigest, PATTERNS.sha256)) return null;
  if (!(PHASES as readonly unknown[]).includes(phase)) return null;
  return Object.freeze({
    ref,
    owner,
    retryKey: dedupeKey,
    content: Object.freeze({ role: role as StartContent["role"], purpose, sourceRef, inputDigest }),
    phase: phase as WorkRecord["phase"],
  });
}

const sameContent = (a: StartContent, b: StartContent) => a.role === b.role && a.purpose === b.purpose && a.sourceRef === b.sourceRef && a.inputDigest === b.inputDigest;

// 소유자로 찾는 읽기 하나의 답. identity는 묻는 소유자와, 그 줄이 같아야 하는 식별 칸(재시도 키 또는 참조)이다.
// 순서: 읽기 실패 → 없음 → 소유자 → 꼴 → 식별. 소유자를 꼴보다 먼저 본다: 남의 줄은 꼴이 틀려도 없는 줄과 같은 답이어야 한다.
function ownedRead(read: unknown, owner: string, identity: { readonly field: "retryKey" | "ref"; readonly value: string }): Answer<WorkRecord | null> {
  if (!isPlainObject(read) || read.known !== true || !Object.hasOwn(read, "value")) return UNKNOWN;
  const value: unknown = read.value;
  if (value === null) return NONE;
  if (!isPlainObject(value)) return UNKNOWN;
  const rowOwner: unknown = value.owner;
  // 소유자 칸이 없으면 남의 줄인지 가릴 수 없다. 없음으로 바꾸지 않는다.
  if (typeof rowOwner !== "string") return UNKNOWN;
  if (rowOwner !== owner) return NONE;
  const record = toWork(value);
  if (record === null) return UNKNOWN;
  // 자기 줄인데 묻는 키·참조가 아니면 장부가 다른 줄을 돌려준 것이다. 없음(not_found)으로 답하면 본체가 자기 작업을 잃는다.
  if (record[identity.field] !== identity.value) return UNKNOWN;
  return { known: true, value: record };
}

// 처리기 포트 하나의 몸통을 감싼다. 무엇이 던지든 모름이다(처리기도 던짐을 모름으로 받지만, 이 어댑터의 답으로 분명히 한다).
function guarded<A extends unknown[], T>(body: (...args: A) => Answer<T>): (...args: A) => Answer<T> {
  return (...args) => {
    try {
      return body(...args);
    } catch {
      return UNKNOWN;
    }
  };
}

function findByRetryKey(ledger: ToolLedger) {
  return guarded((query: { readonly owner: string; readonly retryKey: string }): Answer<WorkRecord | null> => {
    const { owner, retryKey } = query;
    return ownedRead(ledger.findToolRequest({ owner, dedupeKey: retryKey }), owner, { field: "retryKey", value: retryKey });
  });
}

function readOwnedWork(ledger: ToolLedger) {
  return guarded((query: { readonly owner: string; readonly ref: string }): Answer<WorkRecord | null> => {
    const { owner, ref } = query;
    return ownedRead(ledger.readToolRequest({ owner, ref }), owner, { field: "ref", value: ref });
  });
}

const START_OUTCOMES: readonly unknown[] = ["created", "existing", "conflict"];

function recordStart(ledger: ToolLedger, random: Random) {
  return guarded((input: StartRecordInput): Answer<StartWrite> => {
    // 입력의 칸은 한 번만 읽는다. 장부에 넘긴 값과 답을 대조하는 값이 갈리지 않게 한다.
    const { owner, retryKey, sessionId, callId, now } = input;
    const { role, purpose, sourceRef, inputDigest } = input.content;
    const content: StartContent = { role, purpose, sourceRef, inputDigest };
    // 새 줄을 만들 때만 장부가 쓰는 참조 후보. 만들지 못하면 장부를 부르지 않는다.
    const candidate = newUuid(random);
    if (candidate === null) return UNKNOWN;

    const written: unknown = ledger.recordToolRequest({ ref: candidate, owner, dedupeKey: retryKey, role, purpose, sourceRef, inputDigest, sessionId, callId, now });
    if (!isPlainObject(written)) return UNKNOWN;
    if (written.ok === false) {
      const reason: unknown = written.reason;
      if (reason === "stopped") return { known: true, value: { ok: false, reason: "stopped" } };
      if (reason === "intake_closed" || reason === "snapshot_hold") return { known: true, value: { ok: false, reason: "intake_closed" } };
      // stop_unknown·ledger_unwritable·invariant_violation(소유자가 접수한 입력이 아님, 이미 쓰인 참조 후보) 등: 처리기의 답 꼴에 갈래가 없다.
      return UNKNOWN;
    }
    if (written.ok !== true) return UNKNOWN;
    const outcome: unknown = written.outcome;
    const request: unknown = written.request;
    if (!START_OUTCOMES.includes(outcome) || !isPlainObject(request)) return UNKNOWN;
    const record = toWork(request);
    // 쓰기가 남의 줄을 돌려주면 없음으로 바꿀 수 없다: 이미 무엇인가 적혔을 수 있다.
    if (record === null || record.owner !== owner || record.retryKey !== retryKey) return UNKNOWN;
    const same = sameContent(record.content, content);
    // 장부의 결과와 돌려준 줄이 서로 맞아야 한다. 새로 만든 줄은 넘긴 후보·내용·대기 단계 그대로다.
    if (outcome === "created" && (!same || record.ref !== candidate || record.phase !== "waiting_assignment")) return UNKNOWN;
    if (outcome === "existing" && !same) return UNKNOWN;
    // 내용이 다른 같은 키는 그 줄을 넘긴다. 충돌의 판정(retry_conflict)은 처리기가 내용을 대조해 한다.
    if (outcome === "conflict" && same) return UNKNOWN;
    return { known: true, value: { ok: true, record } };
  });
}

// 맞는 장부 연산이 없는 포트들. 늘 모름이라 처리기는 그 도구를 unknown으로 닫고 아무것도 적지 않는다.

// 지금 호출권을 가진 세션과 세대: 장부에 세션을 여는 길이 아직 닫혀 있다(startSession은 늘 session_start_closed). 세션 계약(U6)의 일이다.
const liveSession = (): Answer<{ readonly id: string; readonly generation: number } | null> => UNKNOWN;

// 원본 참조와 digest가 그 논리 요청의 고정된 입력인가: 장부의 입력 줄(inputs)에는 입력 digest가 없고 원본 참조를 소유자로 대조해
// 읽는 연산도 없다. 참이라고 답하면 고정되지 않은 입력에 작업이 접수된다.
const inputPinned = (_query: { readonly owner: string; readonly sourceRef: string; readonly inputDigest: string }): Answer<boolean> => UNKNOWN;

// 결과의 확인(검사 통과·만료·정리 대기)과 본문: 부탁 참조에서 이은 실행의 결과 참조·digest를 읽는 장부 연산이 없고, 결과 보관소의
// 판정 규칙(ReadGate, D-22·O18)도 정하지 않았다. 없음(state: none)으로 답하면 확정된 결과가 있는 작업을 "아직"이라고 말한다.
const readResult = (_ref: string): Answer<ResultView> => UNKNOWN;

function requestCancel(ledger: ToolLedger, random: Random, cancel: ToolAdapterDeps["cancel"]) {
  const adapter = cancelAdapter({
    ledger,
    random,
    links: cancel.links,
    clock: cancel.clock,
    signer: cancel.signer,
    sink: cancel.sink,
    observe: cancel.observe,
  });
  return guarded((input: CancelInput): Answer<CancelWrite> => adapter(input));
}

// 조립의 결함은 만들 때 던진다(감독이 뜨는 자리에서 멈춘다). 호출 중에는 던지지 않는다.
// 취소의 연결 문·시계·서명·내보내기 포트는 여기서 보지 않는다: 취소 어댑터가 부를 때마다 던짐과 꼴을 모름·관측으로 받는다.
// 관측 포트만 본다. 없으면 일부 관측(처리기의 반환보다 먼저 오는 것)이 받는 쪽 없이 사라진다.
function requireDeps(deps: ToolAdapterDeps): void {
  const ledger = deps?.ledger as unknown as Record<string, unknown> | undefined;
  for (const name of ["findToolRequest", "readToolRequest", "recordToolRequest", "cancelToolRequest", "unansweredInstructions"] as const) {
    if (!isFunction(ledger?.[name])) throw new TypeError(`도구 어댑터: 장부에 ${name}이 없다`);
  }
  if (!isFunction(deps.policy?.judge)) throw new TypeError("도구 어댑터: 정책에 judge가 없다");
  if (!isFunction(deps.random?.bytes)) throw new TypeError("도구 어댑터: 난수에 bytes가 없다");
  if (!isFunction(deps.cancel?.observe)) throw new TypeError("도구 어댑터: 취소 관측 포트가 없다");
}

export function createToolPorts(deps: ToolAdapterDeps): ToolPorts {
  requireDeps(deps);
  const { ledger, random, policy } = deps;
  // 정책의 답은 처리기가 확인한다(던짐·정한 셋 밖의 값은 unknown). this를 정책 객체에 둔다.
  const judge: ToolPolicyPort["judge"] = (role, purpose) => policy.judge(role, purpose);
  const ledgerPort: ToolLedgerPort = Object.freeze({
    liveSession,
    inputPinned,
    findByRetryKey: findByRetryKey(ledger),
    readOwnedWork: readOwnedWork(ledger),
    readResult,
    recordStart: recordStart(ledger, random),
    requestCancel: requestCancel(ledger, random, deps.cancel),
  });
  return Object.freeze({
    ledger: ledgerPort,
    policy: Object.freeze({ judge }),
    // 설정은 만들 때 한 번 읽어 고정한다. 처리기는 호출마다 이 값을 검사하므로 틀린 값이면 모든 호출이 context_invalid다.
    config: Object.freeze({ purposeBriefMaxChars: deps.config?.purposeBriefMaxChars as number }),
  });
}
