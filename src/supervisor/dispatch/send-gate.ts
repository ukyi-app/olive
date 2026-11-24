// 배정·시작 박자와 재전송 박자가 지시 봉투를 내보내기 포트에 싣는 한 자리. 시작 봉투(task_start)는 src/에서 이 함수로만 포트에 닿는다
// (test/supervisor/dispatch/start-send.test.ts가 소스를 읽어 센다).
// 시작이면 그 봉투의 실행·요청 ID로 송신 표식(장부의 markStartDispatch)을 커밋하고, 답이 ok일 때만 마지막 확인을 거쳐 싣는다.
// 장부의 D-90 자동 닫기는 "표식이 없는 실행은 한 번도 실리지 않았다"에 기댄다. 표식 없이 시작이 한 번이라도 실리면 실행기가 받은
// 실행을 감독이 받은 적 없음으로 닫아 작업 자리를 풀고 일이 겹친다. 그래서 표식이 거절·던짐·꼴이 틀린 답이면 싣지 않는다.
// 시작인지는 부르는 쪽의 말이 아니라 봉투의 동작으로 가른다. 시계·난수를 직접 부르지 않는다.
import { canonicalJson, type Envelope } from "../../contract/v1/index.ts";
import { REFUSALS as LEDGER_REFUSALS, type Refusal as LedgerRefusal } from "../../ledger/index.ts";
import type { InstructionSink, StartMarker } from "./ports.ts";

// 표식이 ok가 아니어서 싣지 않은 이유. 장부의 거절 이름, 표식 포트가 던짐 또는 표식 입력의 칸을 읽다 던짐(threw), 답이 성공·거절의 꼴이 아님(malformed_answer),
// 시작 봉투인데 표식 입력이 없음(marker_missing), 봉투에서 실행·요청 ID를 읽지 못함(envelope_unreadable).
export type MarkFailure = LedgerRefusal | "threw" | "malformed_answer" | "marker_missing" | "envelope_unreadable";

export interface StartMark<S> {
  // 박자가 읽고 쓰는 장부 포트 그 객체(같은 장부 열기)여야 한다.
  readonly marker: StartMarker;
  // 표식에 적는 시각. 박자가 마지막으로 읽은 시각(장부와 같은 시계)이다.
  readonly at: number;
  // 표식을 커밋한 뒤 포트를 부르기 직전의 마지막 확인. null이면 싣고, 값이면 싣지 않고 그 값을 돌려준다. 이 칸은 sendInstruction
  // 진입 때 한 번 읽는다(접근자여도 유효 문 앞에서 돈다).
  // 표식은 커밋(fsync)에 시간이 걸리므로 시계로 재는 확인은 표식 뒤에 둔다. 박자 유효 문 바로 뒤에 부르고, 이 확인이 포트 호출 전의
  // 마지막 외부 호출이다: 유효 문 안의 장부 읽기에 쓴 시간을 이 확인의 시계가 잰다.
  // 던지지 않아야 한다: 던지면 포트를 부르지 않은 채 이 함수 밖으로 예외가 나가고, 부르는 쪽은 실렸는지를 가르지 못한다.
  readonly lastCheck?: () => S | null;
  // 마지막 확인의 답이 부르는 쪽이 낸 거절인지 가른다. 참이면 stopped로 그 값을 돌려주고, 거짓이거나 칸이 없으면 꼴이 틀린 답(check_malformed)이다.
  readonly stops?: (value: unknown) => value is S;
}

// 시작이 아닌 봉투의 마지막 확인(지금은 갱신의 여유 판정)과 그 거절을 가르는 함수. 뜻은 StartMark의 같은 이름 칸과 같다.
export interface PlainCheck<S> {
  readonly check: () => S | null;
  readonly stops: (value: unknown) => value is S;
}

export type GateResult<S> =
  // 포트를 불렀고 돌아왔다. 답의 꼴은 부르는 쪽이 본다.
  | { readonly kind: "answered"; readonly answer: unknown }
  // 포트를 불렀고 던졌다. 실렸는지 모른다.
  | { readonly kind: "threw" }
  // 포트를 얻다 던지거나 send가 함수가 아니어서 부르지 않았다. 시작이어도 이번 시도는 표식을 적지 않았다(앞선 시도의 표식은 남아 있을 수 있다).
  | { readonly kind: "sink_unavailable" }
  // 시작인데 표식이 ok가 아니어서 부르지 않았다.
  | { readonly kind: "unmarked"; readonly markReason: MarkFailure }
  // 마지막 확인(시작은 StartMark.lastCheck, 아니면 plainCheck)이 싣지 말라고 했다. 시작이면 표식이 커밋됐을 수 있다(포트를 얻지 못한
  // 경우는 표식 없이 이 길로 온다).
  | { readonly kind: "stopped"; readonly value: S }
  // 마지막 확인이 null도 부르는 쪽의 거절도 아닌 값(undefined, 숫자, 남의 객체 등)을 냈다. 싣지 않았다. 시작이면 표식이 커밋됐을 수 있다.
  | { readonly kind: "check_malformed" }
  // 박자 유효 문이 닫혀 부르지 않았다. 표식 앞에서 닫혔으면 표식이 없고, 시작의 마지막 판정(표식 뒤)에서 닫혔으면 표식이 커밋됐을 수 있다.
  | { readonly kind: "beat_closed" };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isRefusal = (value: unknown): value is LedgerRefusal => (LEDGER_REFUSALS as readonly unknown[]).includes(value);

// 봉투에서 읽은 것. 시작인가, 시작이면 표식에 쓸 실행·요청 ID(읽지 못하면 null), 그리고 포트에 넘길 데이터 사본(만들지 못하면 null).
// 사본이 null이면 늘 시작·ID null이라, 포트에 닿기 전에 표식 없이 돌아간다.
interface EnvelopeView {
  readonly starting: boolean;
  readonly ids: { readonly runId: string; readonly requestId: string } | null;
  readonly copy: Envelope | null;
}

// 진입 때 봉투를 정규 직렬화로 한 번 읽어 그 글을 다시 푼 데이터 사본을 만들고, 동작·ID 판정과 포트 호출 모두 이 사본만 쓴다.
// 원래 봉투는 이 뒤로 다시 읽지 않는다. 받은 봉투를 포트에 그대로 넘기면 포트(내보내기 포트는 직렬화부터 한다)가 머리·본문의
// 접근자를 유효 문 뒤에 다시 돌리고, 읽을 때마다 값이 바뀌는 접근자면 표식에 적은 ID와 실제로 실리는 ID가 갈린다.
// 정규 직렬화는 칸마다 한 번 읽고, 포트도 같은 직렬화를 하므로 여기서 읽지 못한 봉투는 포트도 싣지 못한다.
// 사본을 만들지 못하거나(정규 직렬화가 던짐) 머리가 객체가 아니면 시작으로 친다. 표식을 적지 않고 포트도 부르지 않는다: start가
// null이면 marker_missing, 그 밖에는 앞 검사에 걸리지 않는 한 envelope_unreadable이다(ids·사본이 null).
// 머리는 있는데 동작이 task_start가 아니면(동작 칸이 없는 봉투 포함) 시작이 아니다: start를 넘겨도 표식은 적지 않고, 문과 송신 포트를
// 한 번씩 부른다. 동작이 계약의 값인지는 포트 쪽이 본다. 실제 송신기(runtime/sink.ts)는 그 봉투를 서버에 넘기지 않고(unsendable)
// 거절된 약속을 돌려주므로 이 함수의 결과는 threw다. 그대로 답하는 대역 포트면 answered다.
// 시작인데 두 ID를 읽지 못하면 ids가 null이다(envelope_unreadable).
function readEnvelope(envelope: Envelope): EnvelopeView {
  let copy: unknown;
  try {
    copy = JSON.parse(canonicalJson(envelope));
  } catch {
    return { starting: true, ids: null, copy: null };
  }
  const header = isObject(copy) ? copy.header : undefined;
  if (!isObject(copy) || !isObject(header)) return { starting: true, ids: null, copy: null };
  const sent = copy as unknown as Envelope;
  if (header.action !== "task_start") return { starting: false, ids: null, copy: sent };
  const requestId = header.request_id;
  const body = copy.body;
  const runId = isObject(body) ? body.run_id : undefined;
  return { starting: true, ids: typeof runId === "string" && typeof requestId === "string" ? { runId, requestId } : null, copy: sent };
}

// 쥔 함수와 그 수신자(칸을 읽은 그 객체). 진입 때 만든다.
interface Held {
  readonly receiver: unknown;
  readonly fn: (...args: never[]) => unknown;
}

// 쥔 함수를 쥔 수신자로 부른다. Reflect.apply는 함수의 bind·call 같은 속성을 읽지 않는다(그 칸이 없거나 바뀐 함수도 그대로 불린다).
// 박자 유효 문과 마지막 확인·그 거절 판별만 이 함수로 부른다. 송신 포트는 sendInstruction의 마지막 호출로만 부른다
// (start-send.test.ts가 이 함수의 본문과 부르는 줄을 글자 그대로 본다).
function callHeld(held: Held, args: readonly unknown[]): unknown {
  return Reflect.apply(held.fn, held.receiver, args);
}

// 마지막 확인. 함수면 그 함수와 칸을 읽은 객체를 쥔다. 선택 칸(시작의 lastCheck)이 undefined·null이면 확인이 없다(absent).
// 그 밖(필수 칸인 plain.check가 함수가 아님 포함)은 꼴이 틀린 것이라 표식·송신 전에 check_malformed로 닫는다: 빠진 필수 확인을
// "확인 없음"으로 읽으면 확인이 막으려던 송신이 나간다.
type Check<S> = { readonly receiver: unknown; readonly fn: () => S | null } | "absent" | "malformed";
function checkOf<S>(fn: unknown, receiver: unknown, optional: boolean): Check<S> {
  if (typeof fn === "function") return { receiver, fn: fn as () => S | null };
  return optional && (fn === undefined || fn === null) ? "absent" : "malformed";
}

export type GatedCall = { readonly kind: "called"; readonly value: unknown } | { readonly kind: "closed" } | { readonly kind: "threw" };

// 박자 안의 장부 쓰기·송신 표식 하나의 차례: 수신 객체·메서드·인자를 모두 얻고(get) → 인자 원소를 이 함수의 배열로 옮기고 →
// 박자 유효 문(open) → 그 바로 뒤에 호출 하나. get과 원소 읽기의 접근자는 유효 문보다 먼저 돌므로 그 안에서 흐른 시간은 유효 문의
// 시각 비교에 든다(받은 배열을 그대로 넘기면 Reflect.apply가 유효 문 뒤에 원소를 읽는다). Reflect.apply는 함수의 call 같은
// 속성을 읽지 않는다. get·원소 읽기가 던지거나 메서드가 함수가 아니면 부르지 않은 채 threw다(부르는 쪽은 메서드가 던진 것과 같이 다룬다).
// 이 함수를 부르는 자리는 정적 시험(start-send.test.ts)이 글자 그대로 센다: 송신 포트를 부르는 데 쓰지 않는다.
export function callAfterGate(get: () => { readonly receiver: unknown; readonly fn: unknown; readonly args: readonly unknown[] }, open: () => boolean): GatedCall {
  let held: { readonly receiver: unknown; readonly fn: unknown; readonly args: readonly unknown[] };
  try {
    held = get();
  } catch {
    return { kind: "threw" };
  }
  const { receiver, fn, args } = held;
  if (typeof fn !== "function") return { kind: "threw" };
  const copied: unknown[] = [];
  try {
    const length = args.length;
    for (let index = 0; index < length; index += 1) copied[index] = args[index];
  } catch {
    return { kind: "threw" };
  }
  if (!open()) return { kind: "closed" };
  try {
    return { kind: "called", value: Reflect.apply(fn, receiver, copied) };
  } catch {
    return { kind: "threw" };
  }
}

// 표식 포트의 답을 판정한다. ok면 null, 아니면 싣지 않을 이유다.
function markVerdict(call: GatedCall): MarkFailure | null {
  if (call.kind !== "called") return "threw";
  // 답의 칸은 접근자일 수 있다. 칸마다 한 번만 읽어 지역 값에 담고, 판정과 반환은 그 값으로만 한다: 다시 읽으면 검사한 값과
  // 돌려주는 값이 달라져 거절이 성공(null)으로 바뀔 수 있다. 칸을 읽다 던지면 표식 메서드가 던진 것과 같다.
  let ok: unknown;
  let created: unknown;
  let reason: unknown;
  try {
    const answer: unknown = call.value;
    if (!isObject(answer)) return "malformed_answer";
    ok = answer.ok;
    if (ok === true) created = answer.created;
    else if (ok === false) reason = answer.reason;
  } catch {
    return "threw";
  }
  if (ok === true && typeof created === "boolean") return null;
  if (ok === false && isRefusal(reason)) return reason;
  return "malformed_answer";
}

// 박자 유효 문을 한 번 얻는다. 칸이 없으면 늘 유효, 칸을 읽다 던지거나 함수가 아니면 늘 닫힘이다. 부를 때 던지거나 true가
// 아니면 닫힘이다(모름을 유효로 읽지 않는다). 칸을 읽은 그 객체(holder)를 수신자로 쥐고 callHeld로 부른다: 부를 때 holder의 칸도
// 함수의 bind·call도 다시 읽지 않는다. 배정·수명·끊김 박자도 장부 쓰기마다 이 함수로 유효 문을 얻는다(칸 읽기 한 번, 호출 한 번).
export function holdBeatValid(holder: { readonly beatValid?: () => boolean }): () => boolean {
  let valid: Held;
  try {
    const fn: unknown = holder.beatValid;
    if (fn === undefined) return () => true;
    if (typeof fn !== "function") return () => false;
    valid = { receiver: holder, fn: fn as Held["fn"] };
  } catch {
    return () => false;
  }
  return () => {
    try {
      return callHeld(valid, []) === true;
    } catch {
      return false;
    }
  };
}

// 시작 표식 입력(start)의 칸을 진입 때 한 번 읽어 쥔다. 시각·마지막 확인을 읽다 던지면 null이다(표식도 송신도 하지 않는다).
// 표식 포트나 그 메서드를 읽다 던지면 mark만 null이고, 표식 차례에서 callAfterGate가 부르지 않은 채 threw로 낸다.
// 마지막 확인과 그 거절 판별은 start를 수신자로 쥔다(메서드가 자기 상태를 읽어도 this가 그대로다). 표식의 인자는 진입 때 봉투에서
// 읽은 두 ID와 이 시각으로 만든다(ID를 읽지 못했으면 null).
interface HeldStart<S> {
  readonly mark: { readonly receiver: unknown; readonly fn: unknown } | null;
  readonly input: { readonly runId: string; readonly requestId: string; readonly now: number } | null;
  readonly check: Check<S>;
  readonly stops: Held | null;
}
function holdStart<S>(start: StartMark<S>, ids: EnvelopeView["ids"]): HeldStart<S> | null {
  let at: number;
  let lastCheck: unknown;
  let stops: unknown;
  try {
    at = start.at;
    lastCheck = start.lastCheck;
    stops = start.stops;
  } catch {
    return null;
  }
  let mark: HeldStart<S>["mark"] = null;
  try {
    const marker = start.marker;
    mark = { receiver: marker, fn: marker.markStartDispatch };
  } catch {
    mark = null;
  }
  return {
    mark,
    input: ids === null ? null : { runId: ids.runId, requestId: ids.requestId, now: at },
    check: checkOf<S>(lastCheck, start, true),
    stops: typeof stops === "function" ? { receiver: start, fn: stops as Held["fn"] } : null,
  };
}

// 마지막 확인의 답을 가른다. null만 싣기다. 부르는 쪽이 낸 거절(stops가 true)이면 stopped, 그 밖은 꼴이 틀린 답이라 싣지 않는다:
// "?? null"처럼 모름(undefined 등)을 싣기로 읽으면 확인이 막으려던 송신이 나간다. 확인이 없으면 싣기다. stops가 던지면 꼴 틀림이다.
// 확인을 부른 뒤 싣는 길에는 stops를 부르지 않는다(답이 null이면 바로 싣는다). 둘 다 쥔 수신자로 부른다.
function verdictOf<S>(check: Check<S>, stops: Held | null): GateResult<S> | null {
  if (check === "absent") return null;
  if (check === "malformed") return { kind: "check_malformed" };
  const answer: unknown = callHeld(check, []);
  if (answer === null) return null;
  try {
    return stops !== null && callHeld(stops, [answer]) === true ? { kind: "stopped", value: answer as S } : { kind: "check_malformed" };
  } catch {
    return { kind: "check_malformed" };
  }
}

// 봉투 하나를 holder.sink에 싣는다. 시작이 아니면 표식 없이 싣는다(start는 보지 않는다).
// 진입 때 입력 객체의 칸을 모두 한 번씩 읽어 지역 값에 쥔다: 봉투의 데이터 사본(readEnvelope, 칸마다 한 번), holder의 sink·beatValid,
// 포트의 send, (시작) start의 시각·마지막 확인·거절 판별·표식 포트와 그 메서드, (시작이 아님) plain의 확인·거절 판별. 유효 문 뒤에는
// 쥔 함수·값만 쓴다. 칸이 접근자면 유효 문 뒤에 읽는 순간 그 안에서 흐른 시간을
// 유효 문도 마지막 확인도 보지 못한다(start.lastCheck 접근자에 1ms면 박자 만료 정각에 포트가 불린다).
// 차례(시작): 칸 쥐기 → 박자 유효 문 → 표식 → 박자 유효 문 → 마지막 확인 → 포트 호출.
// 차례(시작이 아님): 칸 쥐기 → 박자 유효 문 → 마지막 확인(plainCheck, 있으면) → 포트 호출.
// 송신 앞은 판정 하나다: 유효 문(조립에서는 장부 건강·허가 읽기 뒤 단조 시각) → 마지막 확인(시한의 시계 읽기) → 호출.
// 유효 문을 마지막 확인 뒤에 두면 그 안의 장부 읽기에 쓴 시간을 시한이 보지 못한다(시작은 발행 + 19,001ms, 갱신은 여유 12,999ms에 포트가 불린다).
// 함정: 마지막 확인의 시계 읽기 자체에 걸린 시간은 박자 기한이 보지 못한다. 두 기한의 시계가 달라(박자는 단조, 시한은 장부 시계)
// 한 번의 읽기로 둘을 볼 수 없어서, 비용이 큰 장부 읽기를 앞에 두고 시계 읽기 하나를 맨 끝에 둔다. 마지막 확인과 거절 판별은 그 칸을
// 읽은 객체(start·plain)를 수신자로 부르고, 박자 유효 문은 holder를 수신자로 부른다(메서드의 this를 잃지 않는다).
// 마지막 확인 칸이 꼴이 틀리면(시작의 lastCheck가 함수·undefined·null이 아님, plain의 두 칸 중 하나라도 함수가 아님) 표식·송신 전에 check_malformed다.
// 포트를 얻지 못하면 표식을 적지 않는다. 시작이면 마지막 확인을 먼저 보고(재전송의 결과 차례), 그 확인도 표식 없이 부른다.
// 시작이 아니면 마지막 확인 없이 sink_unavailable이다.
export async function sendInstruction<S = never>(
  holder: { readonly sink: InstructionSink; readonly beatValid?: () => boolean },
  envelope: Envelope,
  start: StartMark<S> | null,
  // 시작이 아닌 봉투의 마지막 확인. 유효 문 바로 뒤, 포트 호출 바로 앞에 부른다. null이면 싣고, stops가 알아보는 값이면 stopped,
  // 그 밖이면 check_malformed다. 던지지 않아야 한다(StartMark.lastCheck와 같다). 시작 봉투에는 쓰지 않는다. 두 칸은 진입 때 읽고 둘 다 필수다.
  plain: PlainCheck<S> | null = null,
): Promise<GateResult<S>> {
  const view = readEnvelope(envelope);
  const starting = view.starting;
  if (starting && start === null) return { kind: "unmarked", markReason: "marker_missing" };
  let target: unknown;
  let send: unknown;
  try {
    target = holder.sink;
    send = (target as InstructionSink).send;
  } catch {
    send = undefined;
  }
  const gate = holdBeatValid(holder);
  const held = starting && start !== null ? holdStart(start, view.ids) : null;
  if (starting && held === null) return { kind: "unmarked", markReason: "threw" };
  let check: Check<S> = "absent";
  let stops: Held | null = null;
  if (held !== null) {
    check = held.check;
    stops = held.stops;
  } else if (plain !== null) {
    // 두 칸 모두 필수다. 하나라도 함수가 아니면 꼴이 틀린 것이라 송신 전에 닫는다.
    try {
      const fn: unknown = plain.check;
      const judge: unknown = plain.stops;
      check = typeof judge === "function" ? checkOf<S>(fn, plain, false) : "malformed";
      stops = typeof judge === "function" ? { receiver: plain, fn: judge as Held["fn"] } : null;
    } catch {
      return { kind: "check_malformed" };
    }
  }
  if (check === "malformed") return { kind: "check_malformed" };
  if (typeof send !== "function") {
    const early = starting ? verdictOf(check, stops) : null;
    return early !== null ? early : { kind: "sink_unavailable" };
  }
  if (held !== null) {
    const { mark, input } = held;
    if (input === null) return { kind: "unmarked", markReason: "envelope_unreadable" };
    // 표식: 쥔 표식 포트·메서드 → 박자 유효 문 → 호출. 메서드를 읽지 못했으면(mark가 null) 부르지 않은 채 threw다.
    const marking = callAfterGate(() => ({ receiver: mark?.receiver, fn: mark?.fn, args: [input] }), gate);
    if (marking.kind === "closed") return { kind: "beat_closed" };
    const refused = markVerdict(marking);
    if (refused !== null) return { kind: "unmarked", markReason: refused };
  }
  // 사본이 없으면 시작으로 읽혀 위에서 이미 돌아갔다. 타입을 좁히려고 문 앞에서 한 번 더 본다.
  const sent = view.copy;
  if (sent === null) return { kind: "unmarked", markReason: "envelope_unreadable" };
  if (!gate()) return { kind: "beat_closed" };
  const verdict = verdictOf(check, stops);
  if (verdict !== null) return verdict;
  try {
    // 마지막 판정 뒤에는 이 호출 하나뿐이다. Reflect.apply는 함수의 call 같은 속성을 읽지 않고 this를 수신 객체로 둔다.
    // 넘기는 것은 진입 때 만든 데이터 사본이다(표식의 ID를 읽은 그 사본).
    return { kind: "answered", answer: await Reflect.apply(send, target, [sent]) };
  } catch {
    return { kind: "threw" };
  }
}
