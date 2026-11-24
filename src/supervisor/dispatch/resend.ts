// 답을 받지 못한 지시를 같은 요청으로 다시 내보내는 한 박자. 장부의 unansweredInstructions()가 낸 지시마다, 그 항목의 값만으로
// 초안을 다시 만들어 봉하고 지정 실행기의 연결에 싣는다. 장부에 쓰는 것은 시작의 송신 표식(markStartDispatch) 하나뿐이고,
// 그것도 이 모듈이 아니라 공유 함수(send-gate.ts의 sendInstruction)가 싣기 직전에 적는다. 지시 줄·실행 줄은 쓰지 않는다.
// 장부·접수·연결·시계·난수·서명·내보내기는 포트로, 정책과 앞 박자들의 기억(지시마다 마지막으로 내보낸 시각)은 인자로 받는다.
// 소켓·타이머·시계·난수를 직접 부르지 않는다. 쥐는 것은 같은 장부 포트로 박자가 진행 중이라는 표시 하나다(돌아오면 지운다).
//
// 지키는 것:
// 1. 같은 요청으로만 다시 낸다. 요청 ID·본문·정지 세대·실행 세대·받는 쪽은 장부 항목의 값이고, 시작은 발행 시각도 항목의 값이다.
//    새 요청 ID를 만들지 않는다. 본문을 다시 만들 수 없는 항목(rebuild: null)은 내보내지 않고 구별된 결과를 낸다.
// 2. 보낼 수 없는 것은 보내지 않는다. 시작은 발행 + START_LAST_SEAL_MS 뒤에 봉하지 않는다(시한이 지난 시작, 새 시각으로 되살리지 않음).
//    시작은 연결 확인 뒤와 내보내기 직전에 시계를 다시 읽어 발행 + START_LAST_SEAL_MS 한도를 다시 본다. 마지막 읽기가 보는 것은 이 한도뿐이다.
//    작업 기한의 여유는 봉할 때(sealDraft)와 실제로 싣는 순간의 내보내기 포트가 보고, 싣는 순간의 시작 한도도 그 포트가 지킨다.
//    항목의 정지 세대가 장부의 지금 세대와 다르거나, 연결이 지시를 낼 수 없거나, 읽기가 모름이면 봉하지 않는다.
//    장부가 모른다고 옮긴(unknown_running) 실행의 시작은 봉하지 않는다(조회만 한다, D-92).
// 3. 두드리지 않는다. 같은 요청 ID는 max(항목의 발행 시각, 부르는 쪽이 넘긴 마지막 송신 시각)부터 정책의 간격이 지나야 다시 낸다.
//    마지막 송신 시각은 결과의 at(내보내기 포트가 돌아온 뒤 읽은 시각)이다. 전달이 모름(포트가 던지거나 정의 밖의 값을 돌려줌)일 때
//    이 값이 실은 시각의 상한인 것은 내보내기 포트가 전달을 확정할 수 없는 모든 끝(예외, 정의 밖의 반환값)에서 맡은 쓰기를
//    이미 끝냈거나 거둔 경우뿐이다(InstructionSink를 조립할 때의 조건).
// 4. 한 항목의 실패는 그 항목의 결과이고 다음 항목을 본다. 항목 안에서 ports.ledger·ports.intake·ports.links의 접근이 던지면
//    그때까지의 결과와 함께 halted다. 그 밖의 포트(시계·난수·서명·내보내기)를 얻다 던지면 halted가 아니고, 결과는 단계에 따라 다르다.
//    난수·서명은 not_sealed(seal_threw)다. 시계는 내보내기 포트를 부르기 전이면 withheld(clock_unavailable)이고, 포트가 돌아온 뒤면
//    결과는 포트의 답대로(실었으면 resent)이며 at은 그 봉투의 시한이다(부르는 쪽은 그 at을 기억한다). 내보내기 포트를 얻다 던지면
//    not_sent(sink_unavailable)이지만, 시작은 그 뒤의 마지막 시계 읽기가 먼저라 한도를 넘었으면 start_expired, 그 시계까지 던지면
//    withheld(clock_unavailable)다.
import { ACTION_SPECS, type Envelope, limits } from "../../contract/v1/index.ts";
import { LEDGER_RUN_STATES, type Ledger, type Restorer, type UnansweredInstruction } from "../../ledger/index.ts";
import { type Drafted, type DraftAction, finalizeDraft, type RefusalReason as DraftRefusalReason, sealDraft, startDraft, stopDraft } from "./envelopes.ts";
import type { Clock, InstructionSink, Random, Signer } from "./ports.ts";
import { type MarkFailure, sendInstruction } from "./send-gate.ts";

// 장부 포트. 읽기 하나와 시작의 송신 표식이다. 표식은 그 항목을 다시 읽은 이 장부 객체로 적는다(표식은 장부 열기마다 따로 센다).
export type ResendLedger = Pick<Ledger, "unansweredInstructions" | "markStartDispatch">;

// 접수. 시작을 다시 낼 때만 본다(새 일을 여는 지시다). 종료·확정은 정지 중에도 접수가 닫혀도 다시 낸다.
export type ResendIntake = Pick<Restorer, "intakeOpen">;

// 이 박자가 다시 내는 동작. 세션의 시작·정지는 세션 계약 작업이 연다.
export type ResendAction = "task_start" | "task_cancel" | "result_finalize";

// 지정 실행기의 연결이 지금 그 지시를 낼 수 있는가(계약 v1의 mayIssue). 조립은 그 실행기의 Link와 부르는 순간의 시각(장부와 같은
// 시계)으로 mayIssue(action, link, now)를 불러 답을 돌려준다. 동기여야 한다: 이 답과 봉하기·싣기 사이에 await가 없다.
// 수명 박자의 LinkGate(갱신만 묻는다)와 같은 뜻이고 동작 이름만 넓다.
export interface ResendLinkGate {
  mayIssue(executorId: string, action: ResendAction): { ok: true } | { ok: false; reason: string };
}

export interface ResendPorts {
  readonly ledger: ResendLedger;
  readonly intake: ResendIntake;
  readonly links: ResendLinkGate;
  // 장부에 주입한 시계와 같은 시계. 박자 처음, 항목마다, 시작의 봉하기·내보내기 직전, 내보내기 포트가 돌아온 뒤에 읽는다
  // (앞서 읽은 시각보다 이르면 읽지 못한 것으로 본다).
  readonly clock: Clock;
  // nonce만 여기서 온다. 요청 ID는 만들지 않는다.
  readonly random: Random;
  readonly signer: Signer;
  readonly sink: InstructionSink;
  // 이 박자가 아직 유효한가(박자 기한, 끝 코드, 장부 건강, 낸 허가의 폐기). 시작이면 공유 함수(송신 표식을 적는 자리)를 부르기 바로 앞,
  // 마지막 외부 호출(봉하기의 서명·난수) 뒤에 본다. 거짓·던짐이면 표식을 적지 않고 싣지 않는다. 빠지면 늘 유효다(이 부품 단독의 쓰임).
  // 조립은 반드시 넘긴다.
  readonly beatValid?: () => boolean;
}

export interface ResendPolicy {
  // 같은 요청 ID를 다시 내는 최소 간격(ms). 양의 안전 정수.
  // 함정: 시작은 발행 + START_LAST_SEAL_MS까지만 봉해지고 간격은 발행 시각부터 세므로, 이 값이 그보다 크면 시작은 한 번도 다시 나가지 않는다.
  readonly resendEveryMs: number;
}

export interface ResendTickInput {
  // 앞 박자들이 다시 낸 시각(결과의 resent와 delivery가 unknown인 not_sent의 at. sealedAt이 아니다). 부르는 쪽이 메모리에 쥐고 넘긴다.
  // 감독이 다시 뜨면 비어 있고, 그때는 항목의 발행 시각만으로 간격을 잰다.
  readonly lastResends: readonly { readonly requestId: string; readonly at: number }[];
}

// 시작을 다시 봉할 수 있는 마지막 시각의 발행 뒤 거리. 봉투 모듈의 규칙(시한 - (DELIVERY_MAX_MS + CLOCK_SKEW_MS))과 같은 값이다(19000ms).
// 그 모듈이 이보다 일찍 거절하면(too_late_to_send) 그 답도 시한이 지난 시작으로 읽으므로, 둘이 어긋나도 늦은 시작이 나가지 않는다.
const START_LIFETIME_MS = ACTION_SPECS.task_start.lifetimeMs ?? limits.MESSAGE_TTL_MS;
export const START_LAST_SEAL_MS = START_LIFETIME_MS - limits.DELIVERY_MAX_MS - limits.CLOCK_SKEW_MS;

type Head = { readonly requestId: string; readonly runId: string; readonly action: UnansweredInstruction["action"] };

// 다시 내지 않은 이유. 모두 내보내기 포트를 부르지 않았다는 뜻이다. 대부분 봉하기 전의 것이고, clock_unavailable은
// 시작의 마지막 시계 읽기(서명 뒤)에서도 나며 그때는 이미 서명한 봉투를 버린다.
// session_run: 세션 실행의 지시. run_unknown: 장부가 모른다고 옮긴(unknown_running) 실행의 시작(조회만 한다, D-92).
// stop_recorded: 같은 실행에 종료가 적힌 시작(열자마자 닫힐 실행을 열지 않는다).
// read_unknown: 싣기 직전의 다시 읽기가 모름이거나 같은 요청 ID의 칸(머리 칸과 본문을 다시 만들 칸)이 처음 읽은 것과 다르다.
// beat_closed: 시작의 송신 표식을 적는 공유 함수 직전에 본 박자 유효 문이 닫혔다(표식을 적지 않았고 싣지 않았다).
export type Withheld = "session_run" | "run_unknown" | "stop_recorded" | "intake_closed" | "no_connection" | "link_unknown" | "clock_unavailable" | "read_unknown" | "beat_closed";

export type ResendOutcome =
  // 같은 요청을 새 봉투에 담아 실었다(sent는 받았다는 뜻이 아니다). sealedAt은 봉할 때 읽은 시각이다.
  // at은 다음 박자의 lastResends에 넘길 시각이다: 내보내기 포트가 돌아온 뒤 읽은 시각, 읽지 못하면 그 봉투의 시한(실은 시각의 상한).
  | (Head & { readonly outcome: "resent"; readonly executorId: string; readonly sealedAt: number; readonly at: number })
  // 마지막 송신(또는 발행)부터 간격이 지나지 않았다.
  | (Head & { readonly outcome: "held"; readonly lastAt: number })
  // 싣기 직전에 다시 읽으니 더는 답을 기다리는 지시가 아니다(그 사이 영수증이 왔거나 실행이 끝났다).
  | (Head & { readonly outcome: "answered" })
  // 장부가 본문을 다시 만들 수 없다. 부르는 쪽은 같은 실행 ID를 조회한다.
  | (Head & { readonly outcome: "not_rebuildable" })
  // 시작의 재전송 한도(발행 + START_LAST_SEAL_MS)가 지났다. expiresAt은 그 시작의 모든 봉투가 갖는 시한(발행 + 기본 수명)이다.
  | (Head & { readonly outcome: "start_expired"; readonly issuedAt: number; readonly expiresAt: number })
  // 항목의 정지 세대가 장부의 지금 세대와 다르다. 실행기와 세대를 맞춘 뒤의 지시는 다른 조각이 새 요청으로 낸다.
  | (Head & { readonly outcome: "stop_generation_mismatch"; readonly stopGeneration: number; readonly currentStopGeneration: number | null })
  | (Head & { readonly outcome: "withheld"; readonly reason: Withheld })
  // 봉투를 만들지 못했다. 실리지 않았다.
  | (Head & { readonly outcome: "not_sealed"; readonly reason: DraftRefusalReason | "draft_threw" | "seal_threw"; readonly field?: string; readonly sealReason?: string })
  // 봉했지만 실은 것을 확인하지 못했다. 포트가 확실히 싣지 않았다고 답했거나(no_connection·too_late_to_send),
  // 내보내기 포트의 send를 얻다 던지거나 함수가 아니어서 포트를 부르지 않았으면(sink_unavailable) delivery가 not_sent다.
  | (Head & {
      readonly outcome: "not_sent";
      readonly reason: "no_connection" | "too_late_to_send" | "sink_unavailable";
      readonly delivery: "not_sent";
      readonly executorId: string;
      readonly sealedAt: number;
    })
  // 시작의 송신 표식이 ok가 아니어서 포트를 부르지 않았다(markReason에 그 이유). 장부의 지시는 그대로이고 다음 박자가 다시 시도한다.
  | (Head & {
      readonly outcome: "not_sent";
      readonly reason: "start_unmarked";
      readonly delivery: "not_sent";
      readonly executorId: string;
      readonly sealedAt: number;
      readonly markReason: MarkFailure;
    })
  // 실렸을 수 있다. at은 resent의 at과 같은 규칙의 시각이고 부르는 쪽은 이 값을 lastResends에 넣는다.
  | (Head & {
      readonly outcome: "not_sent";
      readonly reason: "send_threw" | "send_answer_malformed";
      readonly delivery: "unknown";
      readonly executorId: string;
      readonly sealedAt: number;
      readonly at: number;
    })
  // 항목의 칸을 읽을 수 없다. requestId를 읽지 못했으면 null이다.
  | { readonly requestId: string | null; readonly outcome: "malformed"; readonly field: string };

export type ResendTickResult =
  | { readonly kind: "not_run"; readonly reason: "clock_unavailable" | "policy_rejected" | "input_malformed" | "read_unknown" | "stop_generation_unknown" | "tick_in_progress" }
  | {
      readonly kind: "ran";
      // 읽기의 항목마다 하나, 읽기의 순서대로. 멈췄으면 멈춘 항목(실었을 수 있으면)까지 있고 그 뒤는 없다.
      readonly instructions: readonly ResendOutcome[];
      readonly halted: "threw" | null;
      readonly haltedAt: string | null;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIONS: readonly UnansweredInstruction["action"][] = ["task_start", "session_start", "task_cancel", "session_stop", "result_finalize"];
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

// 같은 장부 포트로 진행 중인 박자. 박자를 겹쳐 부르지 않는 것이 호출 계약이고 이 표시는 그 계약을 어긴 호출을 읽기 없이 돌려보낸다.
// 다른 포트 객체로 겹쳐 부르면 알아채지 못한다.
const IN_FLIGHT = new WeakSet<object>();

// 다시 만들 칸. 장부의 InstructionRebuild를 칸마다 한 번 읽어 옮겨 적은 것이다(같은 칸을 두 번 읽어 다른 값을 보지 않는다).
type Rebuild = Exclude<UnansweredInstruction["rebuild"], null>;

interface Item {
  requestId: string;
  action: UnansweredInstruction["action"];
  runId: string;
  runGeneration: number;
  executorId: string;
  runState: string;
  stopGeneration: number;
  issuedAt: number;
  rebuild: Rebuild | null;
}

type Entry = { item: Item } | { requestId: string | null; field: string };

interface Unanswered {
  stopGeneration: number | null;
  entries: Entry[];
}

// 본문 칸. 꼴은 칸의 종류만 본다. 값이 계약 밖이면 초안·봉하기·서명 포트(계약의 sealEnvelope)가 거절한다.
function copyRebuild(raw: Record<string, unknown>, action: Item["action"]): Rebuild | null {
  if (raw.action !== action) return null;
  switch (action) {
    case "task_start": {
      const { role, profileRevision, policyRevision, snapshotDigest, inputDigest, deadlineAt, budgetLeft, credential } = raw;
      if (![role, profileRevision, policyRevision, snapshotDigest, inputDigest].every(isText) || !isTime(deadlineAt) || !Number.isSafeInteger(budgetLeft)) return null;
      if (!isObject(credential)) return null;
      const { account, method, revision, digest } = credential;
      if (![account, method, revision, digest].every(isText)) return null;
      return {
        action,
        role: role as string,
        profileRevision: profileRevision as string,
        policyRevision: policyRevision as string,
        snapshotDigest: snapshotDigest as string,
        inputDigest: inputDigest as string,
        deadlineAt,
        budgetLeft: budgetLeft as number,
        credential: { account: account as string, method: method as string, revision: revision as string, digest: digest as string },
      };
    }
    case "task_cancel":
    case "session_stop": {
      const { reason } = raw;
      return isText(reason) ? ({ action, reason } as Rebuild) : null;
    }
    case "result_finalize": {
      const { outcome, resultDigest, storedAt } = raw;
      if (!isText(outcome) || !(resultDigest === null || isText(resultDigest)) || !isTime(storedAt)) return null;
      return { action, outcome, resultDigest, storedAt } as Rebuild;
    }
    case "session_start":
      return null;
  }
}

// 항목 하나. 칸의 꼴이 틀리면 그 칸 이름과 함께 malformed다. 읽다 던져도 같다.
function snapshotItem(raw: unknown): Entry {
  let requestId: unknown = null;
  try {
    if (!isObject(raw)) return { requestId: null, field: "item" };
    requestId = raw.requestId;
    if (typeof requestId !== "string" || !UUID.test(requestId)) return { requestId: null, field: "requestId" };
    const id = requestId;
    const bad = (field: string): Entry => ({ requestId: id, field });
    const { action, runId, runGeneration, executorId, runState, stopGeneration, issuedAt, rebuild } = raw;
    const known = ACTIONS.find((a) => a === action);
    if (known === undefined) return bad("action");
    if (typeof runId !== "string" || !UUID.test(runId)) return bad("runId");
    if (!Number.isSafeInteger(runGeneration) || (runGeneration as number) < 1) return bad("runGeneration");
    if (!isText(executorId)) return bad("executorId");
    if (!(LEDGER_RUN_STATES as readonly unknown[]).includes(runState)) return bad("runState");
    if (!isGeneration(stopGeneration)) return bad("stopGeneration");
    if (!isTime(issuedAt)) return bad("issuedAt");
    let copied: Rebuild | null = null;
    if (rebuild !== null) {
      copied = isObject(rebuild) ? copyRebuild(rebuild, known) : null;
      if (copied === null) return bad("rebuild");
    }
    return { item: { requestId: id, action: known, runId, runGeneration: runGeneration as number, executorId, runState: runState as string, stopGeneration, issuedAt, rebuild: copied } };
  } catch {
    return { requestId: typeof requestId === "string" && UUID.test(requestId) ? requestId : null, field: "item" };
  }
}

// 장부의 읽기. known이 불리언 true가 아니거나, 값의 꼴이 틀리거나, 읽다 던지면 null(모름)이다.
// 같은 요청 ID의 항목이 둘 이상이면 어느 것이 맞는지 모르므로 모두 malformed다(장부의 지시 줄은 요청 ID마다 하나다).
function readUnanswered(ledger: ResendLedger): Unanswered | null {
  let answer: unknown;
  try {
    answer = ledger.unansweredInstructions();
    if (!isObject(answer) || answer.known !== true || !isObject(answer.value)) return null;
    const { stopGeneration, instructions } = answer.value;
    if (!(stopGeneration === null || isGeneration(stopGeneration)) || !Array.isArray(instructions)) return null;
    const entries = (instructions as unknown[]).map(snapshotItem);
    const seen = new Map<string, number>();
    for (const entry of entries) {
      const id = "item" in entry ? entry.item.requestId : entry.requestId;
      if (id !== null) seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    return {
      stopGeneration,
      entries: entries.map((entry) => ("item" in entry && (seen.get(entry.item.requestId) ?? 0) > 1 ? { requestId: entry.item.requestId, field: "requestId" } : entry)),
    };
  } catch {
    return null;
  }
}

function readClock(ports: { readonly clock: Clock }, floor: number): number | null {
  try {
    const at: unknown = ports.clock.now();
    return isTime(at) && at >= floor ? at : null;
  } catch {
    return null;
  }
}

function intakeOpen(intake: ResendIntake): boolean {
  try {
    return intake.intakeOpen() === true;
  } catch {
    return false;
  }
}

// 박자 유효 문. 포트가 없으면 유효, 던지거나 true가 아니면 무효다(모름을 유효로 읽지 않는다).
function beatValid(ports: ResendPorts): boolean {
  try {
    return ports.beatValid === undefined || ports.beatValid() === true;
  } catch {
    return false;
  }
}

function linkVerdict(links: ResendLinkGate, executorId: string, action: ResendAction): "no_connection" | "link_unknown" | null {
  try {
    const answer: unknown = links.mayIssue(executorId, action);
    if (!isObject(answer)) return "link_unknown";
    if (answer.ok === true) return null;
    return answer.ok === false && typeof answer.reason === "string" ? "no_connection" : "link_unknown";
  } catch {
    return "link_unknown";
  }
}

function validEvery(policy: unknown): number | null {
  try {
    if (!isObject(policy)) return null;
    const every = policy.resendEveryMs;
    return isTime(every) ? every : null;
  } catch {
    return null;
  }
}

function validMemory(input: unknown): Map<string, number> | null {
  try {
    if (!isObject(input) || !Array.isArray(input.lastResends)) return null;
    const last = new Map<string, number>();
    for (const entry of input.lastResends as unknown[]) {
      if (!isObject(entry) || typeof entry.requestId !== "string" || !isTime(entry.at)) return null;
      last.set(entry.requestId, Math.max(last.get(entry.requestId) ?? 0, entry.at));
    }
    return last;
  } catch {
    return null;
  }
}

// 본문을 다시 만들 칸이 같은가. 둘 다 copyRebuild가 만든 사본이라 칸은 원시 값과 그런 값만 담은 객체 하나(자격 참조)뿐이다.
function sameValues(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    if (!Object.hasOwn(right, key)) return false;
    const x = left[key];
    const y = right[key];
    return isObject(x) && isObject(y) ? sameValues(x, y) : Object.is(x, y);
  });
}

// 같은 요청 ID의 항목이 처음 읽은 것과 같은 지시인가. 지시 줄은 적은 뒤 바뀌지 않으므로 다르면 틀린 읽기다.
// 본문 칸도 본다: 다르면 같은 요청 ID에 다른 본문 digest를 봉하게 된다.
const sameInstruction = (a: Item, b: Item): boolean =>
  a.action === b.action &&
  a.runId === b.runId &&
  a.runGeneration === b.runGeneration &&
  a.executorId === b.executorId &&
  a.stopGeneration === b.stopGeneration &&
  a.issuedAt === b.issuedAt &&
  (a.rebuild === null || b.rebuild === null ? a.rebuild === b.rebuild : sameValues(a.rebuild, b.rebuild));

// 항목의 값만으로 만든 초안. 실행 줄을 따로 읽지 않는다. 정지 세대는 항목의 값(처음 지시의 세대)이다.
function redraft(item: Item, rebuild: Rebuild): Drafted<DraftAction> {
  const run = { runId: item.runId, runGeneration: item.runGeneration, executorId: item.executorId };
  const head = { requestId: item.requestId, stopGeneration: item.stopGeneration };
  switch (rebuild.action) {
    case "task_start": {
      const { action: _, ...fields } = rebuild;
      return startDraft({ run: { ...run, kind: "worker", ...fields }, ...head, issuedAt: item.issuedAt });
    }
    case "task_cancel":
      return stopDraft({ action: "task_cancel", run, ...head, reason: rebuild.reason });
    case "session_stop":
      return stopDraft({ action: "session_stop", run, ...head, reason: rebuild.reason });
    case "result_finalize":
      return finalizeDraft({ run, ...head, outcome: rebuild.outcome, resultDigest: rebuild.resultDigest, storedAt: rebuild.storedAt });
  }
}

interface Context {
  ports: ResendPorts;
  every: number;
  lastResends: Map<string, number>;
  // 마지막으로 읽은 시각. 항목마다 다시 읽은 시각은 이보다 이르면 안 된다.
  floor: number;
}

interface Trace {
  fallback: (() => ResendOutcome) | null;
}

export async function resendTick(ports: ResendPorts, policy: ResendPolicy, input: ResendTickInput): Promise<ResendTickResult> {
  // 포트 묶음의 속성 접근(getter)도 던질 수 있다. 박자 처음에 장부 포트를 얻지 못하면 장부를 읽지 못한 것과 같다.
  // 진행 표시와 첫 읽기는 여기서 한 번 얻은 객체로 한다.
  let key: unknown;
  try {
    key = ports.ledger;
  } catch {
    return { kind: "not_run", reason: "read_unknown" };
  }
  // 읽기 메서드를 붙인 함수도 장부 포트다(WeakSet은 함수도 키로 받는다). 메서드가 없거나 던지면 readUnanswered가 모름으로 낸다.
  if (!isObject(key) && typeof key !== "function") return { kind: "not_run", reason: "read_unknown" };
  if (IN_FLIGHT.has(key)) return { kind: "not_run", reason: "tick_in_progress" };
  IN_FLIGHT.add(key);
  try {
    return await tickOnce(ports, key as ResendLedger, policy, input);
  } finally {
    IN_FLIGHT.delete(key);
  }
}

async function tickOnce(ports: ResendPorts, ledger: ResendLedger, policy: ResendPolicy, input: ResendTickInput): Promise<ResendTickResult> {
  const now = readClock(ports, 1);
  if (now === null) return { kind: "not_run", reason: "clock_unavailable" };
  const every = validEvery(policy);
  if (every === null) return { kind: "not_run", reason: "policy_rejected" };
  const lastResends = validMemory(input);
  if (lastResends === null) return { kind: "not_run", reason: "input_malformed" };
  const read = readUnanswered(ledger);
  if (read === null) return { kind: "not_run", reason: "read_unknown" };
  // 정지 기록이 없으면 지시도 적힐 수 없다. 항목과 대조할 세대를 모르므로 아무것도 내지 않는다.
  if (read.stopGeneration === null) return { kind: "not_run", reason: "stop_generation_unknown" };

  const ctx: Context = { ports, every, lastResends, floor: now };
  const outcomes: ResendOutcome[] = [];
  for (const entry of read.entries) {
    if (!("item" in entry)) {
      outcomes.push({ requestId: entry.requestId, outcome: "malformed", field: entry.field });
      continue;
    }
    const trace: Trace = { fallback: null };
    try {
      outcomes.push(await resendOne(ctx, entry.item, trace));
    } catch {
      // 항목 안에서 포트 묶음의 속성(ledger·intake·links)을 읽다 던지면 여기로 온다.
      // 실행 줄과 미응답 지시 줄을 바꾸지 않으므로(시작의 재전송은 송신 표식을 쓴다) 멈춰도 잃는 기록은 없다. 실렸을 수 있는 항목만 그 사실로 남긴다.
      if (trace.fallback !== null) outcomes.push(trace.fallback());
      return { kind: "ran", instructions: outcomes, halted: "threw", haltedAt: entry.item.requestId };
    }
  }
  return { kind: "ran", instructions: outcomes, halted: null, haltedAt: null };
}

async function resendOne(ctx: Context, planned: Item, trace: Trace): Promise<ResendOutcome> {
  const head: Head = { requestId: planned.requestId, runId: planned.runId, action: planned.action };
  const withheld = (reason: Withheld): ResendOutcome => ({ ...head, outcome: "withheld", reason });

  // 싣기 직전에 다시 읽는다. 처음 읽은 뒤 앞 항목의 송신을 기다리는 동안 영수증이 왔거나, 정지 세대가 바뀌었거나, 같은 실행에
  // 종료가 적혔을 수 있다. 판단은 모두 이 읽기의 값으로 한다.
  // 시작의 송신 표식도 이 읽기와 같은 장부 객체로 적는다.
  const ledger = ctx.ports.ledger;
  const fresh = readUnanswered(ledger);
  if (fresh === null) return withheld("read_unknown");
  const found = fresh.entries.filter((e) => ("item" in e ? e.item.requestId : e.requestId) === planned.requestId);
  if (found.length === 0) return { ...head, outcome: "answered" };
  const entry = found[0] as Entry;
  if (!("item" in entry)) return { requestId: planned.requestId, outcome: "malformed", field: entry.field };
  const item = entry.item;
  if (!sameInstruction(planned, item)) return withheld("read_unknown");

  if (item.action === "session_start" || item.action === "session_stop") return withheld("session_run");
  const rebuild = item.rebuild;
  if (rebuild === null) return { ...head, outcome: "not_rebuildable" };
  const action = item.action;

  const at = readClock(ctx.ports, ctx.floor);
  if (at === null) return withheld("clock_unavailable");
  ctx.floor = at;
  // 시작은 장부의 발행 시각을 그대로 싣는다. 한도가 지나면 새 시각으로 다시 만들지 않는다(D-90의 "더 보내지 않음"의 재료).
  const expired = (): ResendOutcome => ({ ...head, outcome: "start_expired", issuedAt: item.issuedAt, expiresAt: item.issuedAt + START_LIFETIME_MS });
  if (action === "task_start" && at > item.issuedAt + START_LAST_SEAL_MS) return expired();
  if (fresh.stopGeneration !== item.stopGeneration) {
    return { ...head, outcome: "stop_generation_mismatch", stopGeneration: item.stopGeneration, currentStopGeneration: fresh.stopGeneration };
  }
  if (action === "task_start") {
    // 끊김(markLostFor)이나 복원 3단계(markLost)가 모른다고 옮긴 실행은 되살리지 않고 같은 실행 ID로 조회만 한다(D-92).
    // 처음 봉투를 받지 못한 실행기가 새 연결로 받으면 쓸모없는 실행을 연다. 조회는 수명 박자의 일이다.
    // 함정: 이 판정은 시한 판정(start_expired) 뒤에 둔다. 본문을 다시 만들 수 있고 유효한 시각으로 시한 판정에 닿은 시작은
    // 발행 + START_LAST_SEAL_MS가 지났으면 상태와 무관하게 start_expired로 끝나야 부르는 쪽이 그 결과를 D-90의 "더 보내지 않음"
    // 재료로 쓴다. 본문을 다시 만들 수 없는 옛 판의 시작은 그 전에 not_rebuildable로 끝나 같은 실행 ID를 조회하고,
    // 장부의 D-90 자동 닫기도 그 실행을 닫지 않는다(started_before_migration).
    if (item.runState === "unknown_running") return withheld("run_unknown");
    // 같은 실행에 종료가 적혔으면 시작을 다시 내지 않는다. 실행기가 시작을 받은 적이 없다면 열자마자 닫힐 일을 여는 것이고,
    // 받았다면 시작의 재전송은 영수증을 다시 받는 것밖에 없다. 종료는 따로 다시 낸다.
    const stopRecorded =
      item.runState === "stopping" ||
      fresh.entries.some((e) => "item" in e && e.item.runId === item.runId && (e.item.action === "task_cancel" || e.item.action === "session_stop"));
    if (stopRecorded) return withheld("stop_recorded");
    if (!intakeOpen(ctx.ports.intake)) return withheld("intake_closed");
  }
  // 간격은 항목의 발행 시각부터도 센다. 다른 박자가 방금 적고 실은 지시를 곧바로 다시 내지 않는다.
  const lastAt = Math.max(item.issuedAt, ctx.lastResends.get(item.requestId) ?? 0);
  if (at - lastAt < ctx.every) return { ...head, outcome: "held", lastAt };
  const link = linkVerdict(ctx.ports.links, item.executorId, action);
  if (link !== null) return withheld(link);

  // 시작은 판단한 뒤에도 연결·서명 포트 안에서 시각이 흐른다. 봉하기 직전과 내보내기 직전에 다시 읽어 발행 + 한도를 다시 본다.
  // 함정: 이 읽기는 작업 기한의 여유를 보지 않는다(sealDraft만 그 규칙을 갖고, 다시 부르면 다시 서명한다). 그 여유와
  // 마지막으로 읽은 뒤에 흐른 시간은 실제로 싣는 순간의 내보내기 포트가 본다(InstructionSink의 조건).
  const startStillSealable = (): ResendOutcome | number => {
    const checked = readClock(ctx.ports, ctx.floor);
    if (checked === null) return withheld("clock_unavailable");
    ctx.floor = checked;
    return checked > item.issuedAt + START_LAST_SEAL_MS ? expired() : checked;
  };
  let sealAt = at;
  if (action === "task_start") {
    const checked = startStillSealable();
    if (typeof checked !== "number") return checked;
    sealAt = checked;
  }

  // 여기부터 내보내기까지 await가 없다. 취소·확정은 위에서 읽은 at으로, 시작은 연결 확인 뒤에 다시 읽은 시각으로 봉한다.
  let envelope: Envelope;
  try {
    const drafted = redraft(item, rebuild);
    if (!drafted.ok) return { ...head, outcome: "not_sealed", reason: drafted.reason, ...(drafted.field === undefined ? {} : { field: drafted.field }) };
    let sealed: ReturnType<typeof sealDraft>;
    try {
      sealed = sealDraft(drafted.draft, sealAt, { random: ctx.ports.random, signer: ctx.ports.signer });
    } catch {
      return { ...head, outcome: "not_sealed", reason: "seal_threw" };
    }
    if (!sealed.ok) {
      if (action === "task_start" && sealed.reason === "too_late_to_send") return expired();
      return {
        ...head,
        outcome: "not_sealed",
        reason: sealed.reason,
        ...(sealed.field === undefined ? {} : { field: sealed.field }),
        ...(sealed.sealReason === undefined ? {} : { sealReason: sealed.sealReason }),
      };
    }
    envelope = sealed.envelope;
  } catch {
    return { ...head, outcome: "not_sealed", reason: "draft_threw" };
  }
  // 받는 쪽과 봉투 시한은 내보내기 전에 확보한 값이다. 포트가 넘겨받은 봉투를 고쳐도 결과는 바뀌지 않는다.
  const executorId = item.executorId;
  const expiresAt = envelope.header.expires_at;
  // 송신 표식 → 마지막 시계 읽기 → 내보내기는 공유 함수 하나로만 한다(배정·시작 박자와 같은 자리, send-gate.md). 그 함수는
  // 내보내기 포트의 수신 객체와 함수를 표식과 시작의 마지막 시계 읽기보다 먼저 얻는다. 그 읽기 뒤에 포트의 접근자(get send() 등)가
  // 돌면 그 안에서 흐른 시간만큼 한도가 지난 시작이 포트에 닿는다. 얻다 던지거나 함수가 아니면 포트를 부르지 않은 그 항목의 실패이고
  // 표식도 적지 않는다(시작이면 마지막 시계 읽기가 먼저다). 표식의 커밋은 마지막 시계 읽기보다 앞이다: 커밋에 걸린 시간은 그 읽기가 잰다.
  // 표식은 마지막으로 읽은 시각으로 적는다. 취소·확정은 표식·마지막 읽기 없이 싣는다.
  const mayBeLoaded = (reason: "send_threw" | "send_answer_malformed", loadedBy: number): ResendOutcome => ({
    ...head,
    outcome: "not_sent",
    reason,
    delivery: "unknown",
    executorId,
    sealedAt: sealAt,
    at: loadedBy,
  });
  trace.fallback = () => mayBeLoaded("send_threw", expiresAt);
  // sendInstruction은 포트 호출 전까지 기다리지 않는다(표식·마지막 시계 읽기는 동기). 그래서 마지막 읽기와 포트 호출 사이에 await가 없다.
  const lastCheck = (): ResendOutcome | null => {
    const checked = startStillSealable();
    return typeof checked === "number" ? null : checked;
  };
  // 시작의 표식은 장부 쓰기다. 공유 함수를 부르기 바로 앞에서 박자 유효 문을 본다. 여기부터 표식까지는 공유 함수 안의 봉투·포트 묶음
  // 속성 읽기(수신 객체와 send 얻기)뿐이고 포트 호출과 await가 없다(send-gate.ts의 차례).
  if (action === "task_start" && !beatValid(ctx.ports)) return withheld("beat_closed");
  const gate = await sendInstruction(ctx.ports, envelope, action === "task_start" ? { marker: ledger, at: ctx.floor, lastCheck } : null);
  if (gate.kind === "stopped") return gate.value;
  if (gate.kind === "sink_unavailable") return { ...head, outcome: "not_sent", reason: "sink_unavailable", delivery: "not_sent", executorId, sealedAt: sealAt };
  if (gate.kind === "unmarked") return { ...head, outcome: "not_sent", reason: "start_unmarked", delivery: "not_sent", executorId, sealedAt: sealAt, markReason: gate.markReason };
  const threw = gate.kind === "threw";
  const sent = gate.kind === "answered" ? gate.answer : undefined;
  if (!threw && (sent === "no_connection" || sent === "too_late_to_send")) {
    return { ...head, outcome: "not_sent", reason: sent, delivery: "not_sent", executorId, sealedAt: sealAt };
  }
  // 간격은 실제로 실은 시각부터 센다. 포트가 돌아온 뒤에 읽은 시각은 실은 시각보다 이르지 않다. 그 시계를 읽지 못하면
  // 봉투 시한을 쓴다: 포트는 시한 뒤에 싣지 않으므로 실은 시각의 확실한 상한이다(봉한 시각으로 되돌리면 간격이 짧아진다).
  const after = readClock(ctx.ports, ctx.floor);
  if (after !== null) ctx.floor = after;
  const loadedBy = after ?? expiresAt;
  if (threw) return mayBeLoaded("send_threw", loadedBy);
  if (sent === "sent") return { ...head, outcome: "resent", executorId, sealedAt: sealAt, at: loadedBy };
  return mayBeLoaded("send_answer_malformed", loadedBy);
}
