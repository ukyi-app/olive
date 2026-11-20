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
  // 표식은 커밋(fsync)에 시간이 걸리므로 시계로 재는 확인은 표식 뒤에 둔다. 이 확인과 포트 호출 사이에는 아무것도 없다.
  // 던지지 않아야 한다: 던지면 포트를 부르지 않은 채 이 함수 밖으로 예외가 나가고, 부르는 쪽은 실렸는지를 가르지 못한다.
  readonly lastCheck?: () => S | null;
}

export type GateResult<S> =
  // 포트를 불렀고 돌아왔다. 답의 꼴은 부르는 쪽이 본다.
  | { readonly kind: "answered"; readonly answer: unknown }
  // 포트를 불렀고 던졌다. 실렸는지 모른다.
  | { readonly kind: "threw" }
  // 포트를 얻다 던지거나 send가 함수가 아니어서 부르지 않았다. 시작이어도 표식을 적지 않았다.
  | { readonly kind: "sink_unavailable" }
  // 시작인데 표식이 ok가 아니어서 부르지 않았다.
  | { readonly kind: "unmarked"; readonly markReason: MarkFailure }
  // 시작의 마지막 확인이 싣지 말라고 했다. 표식이 커밋됐을 수 있다(포트를 얻지 못한 경우는 표식 없이 이 길로 온다).
  | { readonly kind: "stopped"; readonly value: S };

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

// 그 봉투의 실행·요청 ID로 표식을 커밋한다. ok면 null, 아니면 싣지 않을 이유다.
function mark(envelope: Envelope, start: StartMark<unknown>): MarkFailure | null {
  let runId: unknown;
  let requestId: unknown;
  try {
    requestId = envelope.header.request_id;
    runId = isObject(envelope.body) ? envelope.body.run_id : undefined;
  } catch {
    return "envelope_unreadable";
  }
  if (typeof runId !== "string" || typeof requestId !== "string") return "envelope_unreadable";
  let answer: unknown;
  try {
    answer = start.marker.markStartDispatch({ runId, requestId, now: start.at });
  } catch {
    return "threw";
  }
  if (isObject(answer) && answer.ok === true && typeof answer.created === "boolean") return null;
  if (isObject(answer) && answer.ok === false && isRefusal(answer.reason)) return answer.reason;
  return "malformed_answer";
}

// 봉투 하나를 holder.sink에 싣는다. 시작이 아니면 표식·마지막 확인 없이 싣는다(start는 보지 않는다).
// 차례: 포트의 수신 객체와 send를 얻는다 → (시작) 표식 → (시작) 마지막 확인 → 포트 호출. 수신 객체와 send는 표식 전에 얻는다:
// 그 접근자가 표식과 마지막 확인 사이나 확인 뒤에 돌면 그 안에서 흐른 시간만큼 확인이 낡는다.
// 포트를 얻지 못하면 표식을 적지 않는다. 다만 시작이면 마지막 확인을 먼저 보고(재전송의 결과 차례), 그 확인도 표식 없이 부른다.
export async function sendInstruction<S = never>(holder: { readonly sink: InstructionSink }, envelope: Envelope, start: StartMark<S> | null): Promise<GateResult<S>> {
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
    const refused = mark(envelope, start);
    if (refused !== null) return { kind: "unmarked", markReason: refused };
    const stop = start.lastCheck?.() ?? null;
    if (stop !== null) return { kind: "stopped", value: stop };
  }
  try {
    // 표식(과 마지막 확인) 뒤에는 이 호출 하나뿐이다. Reflect.apply는 함수의 call 같은 속성을 읽지 않고 this를 수신 객체로 둔다.
    return { kind: "answered", answer: await Reflect.apply(send, target, [envelope]) };
  } catch {
    return { kind: "threw" };
  }
}
