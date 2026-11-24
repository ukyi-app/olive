// 배정·시작 박자와 재전송 박자가 지시 봉투를 내보내기 포트에 싣는 한 자리. 시작 봉투(task_start)는 src/에서 이 함수로만 포트에 닿는다
// (test/supervisor/dispatch/start-send.test.ts가 소스를 읽어 센다).
// 시작이면 그 봉투의 실행·요청 ID로 송신 표식(장부의 markStartDispatch)을 커밋하고, 답이 ok일 때만 마지막 확인을 거쳐 싣는다.
// 장부의 D-90 자동 닫기는 "표식이 없는 실행은 한 번도 실리지 않았다"에 기댄다. 표식 없이 시작이 한 번이라도 실리면 실행기가 받은
// 실행을 감독이 받은 적 없음으로 닫아 작업 자리를 풀고 일이 겹친다. 그래서 표식이 거절·던짐·꼴이 틀린 답이면 싣지 않는다.
// 시작인지는 부르는 쪽의 말이 아니라 봉투의 동작으로 가른다. 시계·난수를 직접 부르지 않는다.
import type { Envelope } from "../../contract/v1/index.ts";
import { REFUSALS as LEDGER_REFUSALS, type Refusal as LedgerRefusal } from "../../ledger/index.ts";
import type { InstructionSink, StartMarker } from "./ports.ts";

// 표식이 ok가 아니어서 싣지 않은 이유. 장부의 거절 이름, 표식 포트가 던짐(threw), 답이 성공·거절의 꼴이 아님(malformed_answer),
// 시작 봉투인데 표식 입력이 없음(marker_missing), 봉투에서 실행·요청 ID를 읽지 못함(envelope_unreadable).
export type MarkFailure = LedgerRefusal | "threw" | "malformed_answer" | "marker_missing" | "envelope_unreadable";

export interface StartMark<S> {
  // 박자가 읽고 쓰는 장부 포트 그 객체(같은 장부 열기)여야 한다.
  readonly marker: StartMarker;
  // 표식에 적는 시각. 박자가 마지막으로 읽은 시각(장부와 같은 시계)이다.
  readonly at: number;
  // 표식을 커밋한 뒤 포트를 부르기 직전의 마지막 확인. null이면 싣고, 값이면 싣지 않고 그 값을 돌려준다.
  // 표식은 커밋(fsync)에 시간이 걸리므로 시계로 재는 확인은 표식 뒤에 둔다. 박자 유효 문 바로 뒤에 부르고, 이 확인이 포트 호출 전의
  // 마지막 외부 호출이다: 유효 문 안의 장부 읽기에 쓴 시간을 이 확인의 시계가 잰다.
  // 던지지 않아야 한다: 던지면 포트를 부르지 않은 채 이 함수 밖으로 예외가 나가고, 부르는 쪽은 실렸는지를 가르지 못한다.
  readonly lastCheck?: () => S | null;
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
  // 시작의 마지막 확인이 싣지 말라고 했다. 표식이 커밋됐을 수 있다(포트를 얻지 못한 경우는 표식 없이 이 길로 온다).
  | { readonly kind: "stopped"; readonly value: S }
  // 박자 유효 문이 닫혀 부르지 않았다. 표식 앞에서 닫혔으면 표식이 없고, 시작의 마지막 판정(표식 뒤)에서 닫혔으면 표식이 커밋됐을 수 있다.
  | { readonly kind: "beat_closed" };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isRefusal = (value: unknown): value is LedgerRefusal => (LEDGER_REFUSALS as readonly unknown[]).includes(value);

// 봉투가 시작인가. 읽지 못하면 시작으로 친다(표식 없이 실을 수 있는 쪽으로 틀리지 않는다).
function isStart(envelope: Envelope): boolean {
  try {
    return envelope.header.action === "task_start";
  } catch {
    return true;
  }
}

export type GatedCall = { readonly kind: "called"; readonly value: unknown } | { readonly kind: "closed" } | { readonly kind: "threw" };

// 박자 안의 장부 쓰기·송신 표식 하나의 차례: 수신 객체·메서드·인자를 모두 얻고(get) → 박자 유효 문(open) → 그 바로 뒤에 호출 하나.
// get 안의 접근자는 유효 문보다 먼저 돌므로 그 안에서 흐른 시간은 유효 문의 시각 비교에 든다. Reflect.apply는 함수의 call 같은
// 속성을 읽지 않는다. get이 던지거나 메서드가 함수가 아니면 부르지 않은 채 threw다(부르는 쪽은 메서드가 던진 것과 같이 다룬다).
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
  if (!open()) return { kind: "closed" };
  try {
    return { kind: "called", value: Reflect.apply(fn, receiver, args) };
  } catch {
    return { kind: "threw" };
  }
}

// 표식의 인자. 봉투에서 실행·요청 ID를 읽지 못하면 null.
function markInput(envelope: Envelope, at: number): { readonly runId: string; readonly requestId: string; readonly now: number } | null {
  let runId: unknown;
  let requestId: unknown;
  try {
    requestId = envelope.header.request_id;
    runId = isObject(envelope.body) ? envelope.body.run_id : undefined;
  } catch {
    return null;
  }
  return typeof runId === "string" && typeof requestId === "string" ? { runId, requestId, now: at } : null;
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

// 박자 유효 문. 칸이 없으면 늘 유효, 던지거나 true가 아니면 닫힘이다(모름을 유효로 읽지 않는다).
function beatValid(holder: { readonly beatValid?: () => boolean }): boolean {
  try {
    return holder.beatValid === undefined || holder.beatValid() === true;
  } catch {
    return false;
  }
}

// 봉투 하나를 holder.sink에 싣는다. 시작이 아니면 표식·마지막 확인 없이 싣는다(start는 보지 않는다).
// 차례: 포트의 수신 객체와 send를 얻는다 → (시작) 표식의 인자·표식 포트·메서드 → 박자 유효 문 → 표식 → 박자 유효 문 → 마지막 확인 → 포트 호출.
// 시작이 아니면 수신 객체와 send를 얻은 뒤 박자 유효 문 → 포트 호출이다.
// 박자 유효 문(holder.beatValid, 선택 칸)은 장부 쓰기(표식)와 송신 바로 앞에서 본다. 수신 객체와 send는 그 앞에서 얻는다:
// 그 접근자가 유효 문 뒤에 돌면 그 안에서 흐른 시간만큼 유효 문과 마지막 확인이 낡는다.
// 시작의 송신 앞은 판정 하나다: 유효 문(조립에서는 장부 건강·허가 읽기 뒤 단조 시각) → 마지막 확인(시작 시한의 시계 읽기) → 호출.
// 유효 문을 마지막 확인 뒤에 두면 그 안의 장부 읽기에 쓴 시간을 시작 시한이 보지 못한다(발행 + 19,001ms에 포트가 불린다).
// 함정: 마지막 확인의 시계 읽기 자체에 걸린 시간은 박자 기한이 보지 못한다. 두 기한의 시계가 달라(박자는 단조, 시작 시한은 장부 시계)
// 한 번의 읽기로 둘을 볼 수 없어서, 비용이 큰 장부 읽기를 앞에 두고 시계 읽기 하나를 맨 끝에 둔다.
// 포트를 얻지 못하면 표식을 적지 않는다. 다만 시작이면 마지막 확인을 먼저 보고(재전송의 결과 차례), 그 확인도 표식 없이 부른다.
export async function sendInstruction<S = never>(
  holder: { readonly sink: InstructionSink; readonly beatValid?: () => boolean },
  envelope: Envelope,
  start: StartMark<S> | null,
): Promise<GateResult<S>> {
  const starting = isStart(envelope);
  if (starting && start === null) return { kind: "unmarked", markReason: "marker_missing" };
  let target: unknown;
  let send: unknown;
  try {
    target = holder.sink;
    send = (target as InstructionSink).send;
  } catch {
    send = undefined;
  }
  if (typeof send !== "function") {
    const stop = starting ? (start?.lastCheck?.() ?? null) : null;
    return stop !== null ? { kind: "stopped", value: stop } : { kind: "sink_unavailable" };
  }
  if (starting && start !== null) {
    const input = markInput(envelope, start.at);
    if (input === null) return { kind: "unmarked", markReason: "envelope_unreadable" };
    // 표식: 표식 포트와 그 메서드를 얻고 → 박자 유효 문 → 호출. 메서드를 유효 문 뒤에 읽으면 그 접근자 안에서 흐른 시간을 보지 못한다.
    const marking = callAfterGate(() => { const marker = start.marker; return { receiver: marker, fn: marker.markStartDispatch, args: [input] }; }, () => beatValid(holder));
    if (marking.kind === "closed") return { kind: "beat_closed" };
    const refused = markVerdict(marking);
    if (refused !== null) return { kind: "unmarked", markReason: refused };
    if (!beatValid(holder)) return { kind: "beat_closed" };
    const stop = start.lastCheck?.() ?? null;
    if (stop !== null) return { kind: "stopped", value: stop };
  } else if (!beatValid(holder)) return { kind: "beat_closed" };
  try {
    // 마지막 판정(시작이 아니면 박자 유효 문) 뒤에는 이 호출 하나뿐이다. Reflect.apply는 함수의 call 같은 속성을 읽지 않고 this를 수신 객체로 둔다.
    return { kind: "answered", answer: await Reflect.apply(send, target, [envelope]) };
  } catch {
    return { kind: "threw" };
  }
}
