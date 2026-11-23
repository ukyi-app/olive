// 박자들의 내보내기 포트(ports.ts의 InstructionSink), 연결 문(mayIssue), 답의 연결 확인(receipts.ts의 AnswerLinks), ack 쓰기를
// 감독 연결 서버의 쓰기 면(recognized, writeFrame) 위에 만든다. 설명 문서는 sink.md다.
//
// 이 파일이 지키는 것:
// - 싣는 순간의 확인은 서버가 부르는 두 콜백 안에서만 한다. lastCheck(서버 확인 뒤)에서 정지 세대 → (새 실행을 여는 지시면) 접수 →
//   맡기지 않을 실행기를 보고, finalCheck(서버의 인정 재확인 뒤, write 바로 앞)에서 시계를 한 번 읽어 시한과 작업 기한의 여유를 본다.
//   시계를 그보다 앞에서 읽으면 그 뒤의 동기 조회(장부 읽기 포함)와 서버 재확인에 걸린 시간만큼 실제 쓰기 때의 여유가 약속보다 준다.
//   그 앞에서 읽은 값으로 대신하지 않는다.
// - 포트는 동기로 끝난다. 이 파일에는 기다림·타이머·뒤로 미룬 콜백이 없고, 돌아온 뒤 이 포트나 서버에 쓸 것이 남지 않는다.
//   봉투를 쌓거나 저장하지 않는다.
// - 기다리는 조회는 쓰기 전에 그 연결 번호와 함께 등록하고, 결과가 written이 아니면 거둔다.
// - 연결 문과 AnswerLinks는 부르는 순간 서버의 recognized로 답한다. 실제로 실었는지는 writeFrame의 결과로만 정한다.
// 시계·난수·소켓을 직접 쓰지 않는다. 시작 봉투를 만드는 코드가 없다: 시작은 send-gate.ts의 sendInstruction을 지나 이 포트에 닿는다.
import { type Action, canonicalJson, type Envelope, isAction, type Link, limits, mayIssue as contractMayIssue, STARTS_RUN } from "../../contract/v1/index.ts";
import type { Restorer } from "../../ledger/index.ts";
import { encodeFrame } from "../../transport/framing.ts";
import { isWorkerName, type WithheldSource } from "../dispatch/assign-loop.ts";
import type { Clock, InstructionSink, SendOutcome } from "../dispatch/ports.ts";
import type { AnswerLinks, SentQuery } from "../dispatch/receipts.ts";
import { RENEW_MARGIN_MS } from "../scheduler/lifecycle.ts";
import { type ConnectionServer, NOT_WRITTEN_REASONS, type SendEnd } from "../transport/server.ts";

// 봉할 때(envelopes.ts의 sealDraft)와 같은 여유. 실행기가 자기 시계로 받는 시각에도 봉투 시한과 작업 기한이 남게 한다.
const SEND_MARGIN_MS = limits.DELIVERY_MAX_MS + limits.CLOCK_SKEW_MS;

// 서버에서 쓰는 면은 이 둘뿐이다. 소켓·연결 객체에는 닿지 않는다.
export type WireServer = Pick<ConnectionServer, "recognized" | "writeFrame">;

// 부르는 순간 게시된 복원기. 서버에 넘긴 restorer 포트와 같은 함수여야 한다(정지 세대와 접수를 같은 객체에서 읽는다).
export type PublishedRestorer = () => Pick<Restorer, "stopGeneration" | "intakeOpen">;

// 답을 기다리는 조회의 등록부. 항목의 수명(언제 지울지)은 조립이 정한다. 이 포트는 쓰기 전에 더하고 쓰지 못하면 같은 객체를 뺀다.
// 둘 다 동기다. remove는 없는 항목에도 던지지 않아야 한다.
export interface QueryBook {
  add(query: SentQuery): void;
  remove(query: SentQuery): void;
}

// lastCheck·finalCheck가 싣지 말라고 답한 이름. too_late·deadline만 too_late_to_send이고 나머지는 no_connection으로 옮긴다(sink.md "옮김 표").
// clock_unavailable·too_late·deadline은 finalCheck, 나머지는 lastCheck가 낸다(check_threw는 둘 다).
export const SINK_REFUSALS = [
  // 시계가 던졌거나 안전 정수가 아닌 값을 냈다.
  "clock_unavailable",
  // 봉투 시한까지 남은 시간이 여유보다 짧다(갱신 13,000ms, 그 밖 11,000ms).
  "too_late",
  // 본문의 작업 기한(deadline_at)까지 남은 시간이 11,000ms보다 짧다.
  "deadline",
  // 지금 복원기의 정지 세대를 모른다(복원 1단계 전, 장부를 읽지 못함, 포트가 던짐).
  "stop_generation_unknown",
  // 지금 정지 세대가 봉투의 정지 세대와 다르다(정지로 세대가 오름).
  "stop_generation",
  // 새 실행을 여는 지시인데 접수가 닫혔다(던짐 포함).
  "intake_closed",
  // 새 실행을 여는 지시인데 받는 실행기가 맡기지 않을 실행기 집합에 있다.
  "withheld",
  // 새 실행을 여는 지시인데 맡기지 않을 실행기 집합을 모른다(던짐, 꼴이 틀림, 작업자 실행기 이름이 아닌 원소).
  "withheld_unknown",
  // 확인 안에서 뜻밖의 예외가 났다.
  "check_threw",
] as const;
export type SinkRefusal = (typeof SINK_REFUSALS)[number];

// 서버까지 가지 않은 까닭. 넘긴 바이트 0이고 서버를 부르지 않았다.
// not_ack: writeAck에 ack가 아닌 봉투가 왔다. ack_on_sink: sink에 ack가 왔다(ack는 그 영수증이 온 연결에 writeAck로 쓴다).
export const UNSENDABLE = ["envelope_unreadable", "frame_empty", "frame_too_large", "not_ack", "ack_on_sink"] as const;
export type Unsendable = (typeof UNSENDABLE)[number];

// ack 쓰기의 결과. 박자가 아니라 영수증 순환이 동기로 부르므로 송달 모름을 값으로 돌려준다.
// unsendable: 봉투가 ack가 아니거나 틀로 만들지 못했다(서버를 부르지 않았다). unknown: writeFrame이 unknown이었거나 던졌다.
export type AckOutcome = SendOutcome | "unsendable" | "unknown";

// 기록용. 던져도 무시한다. 싣는 결과가 sent가 아닐 때마다 한 번, 실제 이름과 함께 낸다(박자의 결과에는 no_connection만 보인다).
export type SinkNote =
  | {
      readonly kind: "not_sent";
      readonly action: string;
      readonly requestId: string;
      readonly recipient: string;
      readonly outcome: "no_connection" | "too_late_to_send";
      // recognized가 null이면 not_recognized, writeFrame이 refused면 SINK_REFUSALS의 이름, 그 밖은 writeFrame의 reason 그대로다
      // (NOT_WRITTEN_REASONS에 있는 것만. 없는 사유는 꼴 아닌 결과다).
      readonly reason: string;
    }
  | { readonly kind: "unsendable"; readonly reason: Unsendable }
  | { readonly kind: "delivery_unknown"; readonly action: string; readonly requestId: string; readonly recipient: string; readonly reason: "write_unknown" | "port_threw" | "result_malformed" }
  | { readonly kind: "query_withdraw_failed"; readonly requestId: string; readonly connection: number };

export interface WireSinkPorts {
  readonly server: WireServer;
  readonly restorer: PublishedRestorer;
  readonly withheld: WithheldSource;
  // 장부·박자와 같은 시계.
  readonly clock: Clock;
  readonly queries: QueryBook;
  readonly observe?: (note: SinkNote) => void;
}

// 박자 셋의 연결 문(LinkGate, ResendLinkGate, CancelLinkGate)이 모두 받는 꼴.
export interface IssueGate {
  mayIssue(executorId: string, action: Action): { ok: true } | { ok: false; reason: string };
}

export interface WireSink {
  // 네 박자의 ports.sink.
  readonly sink: InstructionSink;
  // 박자 셋의 ports.links.
  readonly links: IssueGate;
  // 영수증 처리기의 links.
  readonly answers: AnswerLinks;
  // 영수증 처리기가 낸 ack 초안을 봉한 봉투를 그 영수증이 온 연결에 쓴다. 동기다.
  writeAck(connection: number, envelope: Envelope): AckOutcome;
}

// 봉투에서 한 번 읽은 값. 칸은 직렬화한 글을 다시 푼 사본에서 읽으므로 확인한 값과 넘기는 바이트가 같다.
interface Head {
  readonly frame: Uint8Array;
  readonly action: Action;
  readonly requestId: string;
  readonly recipient: string;
  readonly stopGeneration: number;
  readonly expiresAt: number;
  // 본문에 deadline_at이 있으면 그 값(v1에서는 시작만 있다).
  readonly deadlineAt: number | null;
  // status_query면 물은 실행 ID.
  readonly runIds: readonly string[] | null;
}

// 서버의 settled. 지시·ack 봉투는 비밀이 아니라 끝에 할 정리가 없다. 넘긴 뒤에 서버나 다른 포트를 부르지 않게 비워 둔다.
const NOTHING_TO_SETTLE = (_end: SendEnd): void => {};

const UTF8 = new TextEncoder();
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const SERVER_REASONS: readonly unknown[] = NOT_WRITTEN_REASONS;

export function createWireSink(ports: WireSinkPorts): WireSink {
  const note = (value: SinkNote): void => {
    try {
      ports.observe?.(value);
    } catch {
      // 기록이 던져도 결과는 그대로다.
    }
  };

  // 한 번의 싣기. 지시(ack가 null)는 recognized로 받는 실행기의 인정된 연결을 고르고, ack는 그 영수증이 온 연결에만 쓴다.
  // 차례: 봉투를 읽고 틀을 만든다 → 연결을 고른다 → (조회) 등록 → writeFrame(그 안의 lastCheck, 서버 재확인, finalCheck)
  // → (조회) written이 아니면 거둠.
  const deliver = (envelope: unknown, ack: { readonly connection: number } | null): AckOutcome => {
    const head = readEnvelope(envelope);
    if (typeof head === "string") {
      note({ kind: "unsendable", reason: head });
      return "unsendable";
    }
    // ack는 writeAck로만, 그 밖은 sink로만 싣는다. 시작 규칙을 보지 않는 ack 문으로 지시가 나가지 않게 한다.
    if ((ack !== null) !== (head.action === "ack")) {
      note({ kind: "unsendable", reason: ack !== null ? "not_ack" : "ack_on_sink" });
      return "unsendable";
    }
    const named = { action: head.action, requestId: head.requestId, recipient: head.recipient };
    const refused = (outcome: "no_connection" | "too_late_to_send", reason: string): AckOutcome => {
      note({ kind: "not_sent", ...named, outcome, reason });
      return outcome;
    };
    // 새 실행을 여는 지시에만 접수와 맡기지 않을 실행기를 건다. 취소·조회·갱신·확정까지 막으면 멈춰야 할 실행을 멈추지 못한다.
    const opening = ack === null && STARTS_RUN.includes(head.action);
    const margin = head.action === "run_renew" ? RENEW_MARGIN_MS : SEND_MARGIN_MS;
    // lastCheck·finalCheck가 낸 이름. 서버가 돌려주는 refusal 대신 이 값으로 가른다.
    const seen: { refusal: SinkRefusal | null } = { refusal: null };
    const lastCheck = (): string | null => {
      seen.refusal = judge(head, opening, ports);
      return seen.refusal;
    };
    const finalCheck = (): string | null => {
      seen.refusal = timeVerdict(head, margin, ports.clock);
      return seen.refusal;
    };
    let query: SentQuery | null = null;
    let written = false;
    try {
      const connection = ack !== null ? ack.connection : ports.server.recognized(head.recipient);
      if (connection === null) return refused("no_connection", "not_recognized");
      if (head.runIds !== null) {
        query = { requestId: head.requestId, recipient: head.recipient, runIds: head.runIds, connection };
        ports.queries.add(query);
      }
      const result: unknown = ports.server.writeFrame(connection, head.recipient, head.frame, { lastCheck, finalCheck, settled: NOTHING_TO_SETTLE });
      const kind = isRecord(result) ? result.kind : undefined;
      written = kind === "written";
      if (written) return "sent";
      if (kind === "unknown") {
        note({ kind: "delivery_unknown", ...named, reason: "write_unknown" });
        return "unknown";
      }
      // 넘긴 바이트 0이라는 답은 서버의 결과 타입이 허락한 꼴일 때만 믿는다. 사유가 없거나 모르는 사유, refusal이 없는 refused는
      // 서버가 무엇을 했는지 모르는 답이라 송달 모름으로 둔다(no_connection으로 옮기면 박자가 확정 미송신으로 적는다).
      // 객체가 아닌 답(null 등)에서 .reason을 읽으면 던져 port_threw로 잘못 적히므로 not_written 객체에서만 읽는다.
      const reason = kind === "not_written" ? (result as { reason?: unknown }).reason : undefined;
      const wellFormed = kind === "not_written" && SERVER_REASONS.includes(reason) && (reason !== "refused" || typeof (result as { refusal?: unknown }).refusal === "string");
      if (!wellFormed) {
        note({ kind: "delivery_unknown", ...named, reason: "result_malformed" });
        return "unknown";
      }
      const refusal = seen.refusal;
      if (reason === "refused" && refusal !== null) return refused(refusal === "too_late" || refusal === "deadline" ? "too_late_to_send" : "no_connection", refusal);
      return refused("no_connection", reason as string);
    } catch {
      note({ kind: "delivery_unknown", ...named, reason: "port_threw" });
      return "unknown";
    } finally {
      // 쓰지 못한 조회는 거둔다. unknown도 거둔다: 서버는 unknown을 돌려주기 전에 그 연결을 닫았고 연결 번호를 다시 쓰지 않으므로
      // 그 연결로 오는 답이 없다. 등록 도중 던졌어도 같은 객체를 빼 본다(QueryBook.remove는 없는 항목에 던지지 않는다).
      if (query !== null && !written) withdraw(ports, query, note);
    }
  };

  const sink: InstructionSink = {
    // 약속은 돌려주기 전에 정해진다. 송달 모름과 서버까지 가지 않은 봉투는 거절로 알린다(박자는 send_threw로 읽는다).
    send(envelope: Envelope): Promise<SendOutcome> {
      const outcome = deliver(envelope, null);
      if (outcome === "unknown" || outcome === "unsendable") return Promise.reject(new Error(`wire sink: ${outcome}`));
      return Promise.resolve(outcome);
    },
  };

  const links: IssueGate = {
    // 인정된 연결이 있으면 connected, last_seen_at은 지금이다. 연결 표에 마지막으로 받은 시각이 없고, 받은 시각으로 채우면
    // 일 없는 실행기가 30초 뒤 끊긴 것으로 보인다(sink.md "정한 것" 4). since는 connected일 때 계약의 판정이 읽지 않는다.
    mayIssue(executorId: string, action: Action) {
      const now = readNow(ports.clock);
      if (now === null) return { ok: false, reason: "clock_unavailable" };
      const link: Link = ports.server.recognized(executorId) !== null ? { state: "connected", since: now, last_seen_at: now } : { state: "disconnected", since: now };
      return contractMayIssue(action, link, now);
    },
  };

  const answers: AnswerLinks = {
    // 캐시하지 않는다. 부를 때마다 지금의 복원기로 인정된 그 실행기의 연결이 이 번호일 때만 참이다.
    current(connection: number, executorId: string): boolean {
      return ports.server.recognized(executorId) === connection;
    },
  };

  return {
    sink,
    links,
    answers,
    writeAck(connection: number, envelope: Envelope): AckOutcome {
      return deliver(envelope, { connection });
    },
  };
}

// lastCheck. 서버가 자기 확인 뒤에 부른다. 정한 차례로 보고 시계는 읽지 않는다(시간은 finalCheck가 본다). 이 안에서는 서버를 부르지 않고
// 기록도 남기지 않는다(observe가 서버를 다시 부를 수 있다). 포트가 던지면 그 조건을 모름으로 보고 싣지 않는다.
function judge(head: Head, opening: boolean, ports: WireSinkPorts): SinkRefusal | null {
  try {
    let source: Pick<Restorer, "stopGeneration" | "intakeOpen">;
    let generation: unknown;
    try {
      source = ports.restorer();
      generation = source.stopGeneration();
    } catch {
      return "stop_generation_unknown";
    }
    if (generation === null || generation === undefined) return "stop_generation_unknown";
    if (generation !== head.stopGeneration) return "stop_generation";
    if (!opening) return null;
    let open: unknown;
    try {
      open = source.intakeOpen();
    } catch {
      return "intake_closed";
    }
    if (open !== true) return "intake_closed";
    return withheldVerdict(ports.withheld, head.recipient);
  } catch {
    return "check_threw";
  }
}

// finalCheck. 서버가 인정의 재확인까지 마쳐 쓰기로 정한 뒤, write 바로 앞에서 부른다. 서버는 그 뒤 다시 확인하지 않으므로 여기서는
// 시계를 한 번 읽고 시한·작업 기한의 여유와 견주는 것만 한다(포트·서버·기록을 부르지 않는다).
function timeVerdict(head: Head, margin: number, clock: Clock): SinkRefusal | null {
  try {
    const now = readNow(clock);
    if (now === null) return "clock_unavailable";
    if (head.expiresAt - now < margin) return "too_late";
    if (head.deadlineAt !== null && head.deadlineAt - now < SEND_MARGIN_MS) return "deadline";
    return null;
  } catch {
    return "check_threw";
  }
}

// 맡기지 않을 실행기 집합을 한 번 읽는다. value는 한 번만 읽고, 원소 하나라도 작업자 실행기 이름이 아니면(빈 칸 포함) 모름이다.
// 배정 박자(assign-loop.ts의 readWithheld)와 같은 검사다: 같은 원천을 두 곳이 다르게 읽으면 배정은 모름으로 멈추고 송신은 싣는다.
function withheldVerdict(source: WithheldSource, recipient: string): SinkRefusal | null {
  try {
    const answer: unknown = source.executors();
    if (!isRecord(answer) || answer.known !== true) return "withheld_unknown";
    const names: unknown = answer.value;
    if (!Array.isArray(names)) return "withheld_unknown";
    let listed = false;
    for (let i = 0; i < names.length; i += 1) {
      const name: unknown = names[i];
      if (!isWorkerName(name)) return "withheld_unknown";
      if (name === recipient) listed = true;
    }
    return listed ? "withheld" : null;
  } catch {
    return "withheld_unknown";
  }
}

function readNow(clock: Clock): number | null {
  try {
    const now: unknown = clock.now();
    return Number.isSafeInteger(now) ? (now as number) : null;
  } catch {
    return null;
  }
}

function withdraw(ports: WireSinkPorts, query: SentQuery, note: (value: SinkNote) => void): void {
  try {
    ports.queries.remove(query);
  } catch {
    note({ kind: "query_withdraw_failed", requestId: query.requestId, connection: query.connection });
  }
}

// 봉투를 정규 직렬화로 한 번 읽어 글로 만들고, 그 글을 다시 푼 사본에서 칸을 읽는다. 접근자가 읽을 때마다 다른 값을 내도
// 확인한 칸과 넘기는 바이트가 갈리지 않는다. 읽지 못하면 서버를 부르지 않는다.
function readEnvelope(envelope: unknown): Head | Unsendable {
  let text: string;
  let copy: unknown;
  try {
    text = canonicalJson(envelope);
    copy = JSON.parse(text);
  } catch {
    return "envelope_unreadable";
  }
  if (!isRecord(copy) || !isRecord(copy.header) || !isRecord(copy.body)) return "envelope_unreadable";
  const header = copy.header;
  const body = copy.body;
  const action = header.action;
  const requestId = header.request_id;
  const recipient = header.recipient;
  const stopGeneration = header.stop_generation;
  const expiresAt = header.expires_at;
  if (!isAction(action) || !isText(requestId) || !isText(recipient) || !Number.isSafeInteger(stopGeneration) || !Number.isSafeInteger(expiresAt)) return "envelope_unreadable";
  let deadlineAt: number | null = null;
  if (Object.hasOwn(body, "deadline_at")) {
    if (!Number.isSafeInteger(body.deadline_at)) return "envelope_unreadable";
    deadlineAt = body.deadline_at as number;
  }
  let runIds: string[] | null = null;
  if (action === "status_query") {
    const asked = body.run_ids;
    if (!Array.isArray(asked) || asked.length === 0 || !asked.every(isText)) return "envelope_unreadable";
    runIds = [...asked];
  }
  const encoded = encodeFrame(UTF8.encode(text));
  if (!encoded.ok) return encoded.reason;
  return { frame: encoded.frame, action, requestId, recipient, stopGeneration: stopGeneration as number, expiresAt: expiresAt as number, deadlineAt, runIds };
}
