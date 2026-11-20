// 본체의 cancel_worker가 부르는 취소 포트(tools.ts의 requestCancel)를 장부와 실행기 연결에 잇는 어댑터.
// 장부·시계·난수·서명·내보내기·연결·관측은 포트로만 받는다. 소켓·타이머·시계·난수를 직접 부르지 않고 상태를 쥐지 않는다.
//
// 지키는 것:
// 1. 장부가 적은 것만, 적은 그대로 내보낸다. 먼저 cancelToolRequest로 적고(호출 ID는 호출마다 난수 포트의 새 UUID), 장부가 종료 지시를
//    돌려주면 그 요청 ID의 지시 줄을 unansweredInstructions()에서 찾아 그 줄의 값(요청 ID, 정지 세대, 실행 ID·세대, 지정 실행기, 사유)으로만
//    task_cancel을 만든다. 새 요청 ID를 만들지 않는다. 장부가 적지 못했거나 지시가 없는 답이면 아무것도 내보내지 않는다.
// 2. 처리기에는 장부의 사실만 답한다: 적었으면 { ok: true, phase }, 끝난 부탁이면 already_ended, 그 밖은 모름(known: false).
// 3. 전달의 실패는 처리기의 답을 바꾸지 않고, 이 어댑터는 다시 보내지 않는다(그 지시는 unansweredInstructions()에 남아 재전송 박자의 몫이다).
//    전달의 결과는 observe 포트로 따로 낸다. 처리기의 포트는 동기이고 내보내기는 비동기라 답에 실을 자리가 없다.
// 4. 입력을 바꾸지 않고, 관측에 원문·자격 참조·봉투·서명·nonce와 꼴이 틀린 입력의 값을 싣지 않는다.
import { type Envelope, TASK_CANCEL_REASONS } from "../../contract/v1/index.ts";
import { type Ledger, REFUSALS as LEDGER_REFUSALS, type Refusal as LedgerRefusal, type TaskCancelReason } from "../../ledger/index.ts";
import type { Answer, CancelInput, CancelWrite } from "../scheduler/tools.ts";
import { newUuid, type RefusalReason as DraftRefusalReason, sealDraft, stopDraft } from "./envelopes.ts";
import type { Clock, InstructionSink, Random, Signer } from "./ports.ts";

// 실제 장부(openLedger가 연 Ledger)가 그대로 맞는 꼴이다.
export type CancelLedger = Pick<Ledger, "cancelToolRequest" | "unansweredInstructions">;

// 지정 실행기의 연결이 지금 task_cancel을 낼 수 있는가(계약 v1의 mayIssue). 조립이 그 실행기의 Link와 부르는 순간의 시각으로 부른 답이다.
// 장부에 적은 뒤에 본다: 취소는 연결이 없어도 적는다(전해야 할 것이 남았다는 기록이다).
export interface CancelLinkGate {
  mayIssue(executorId: string, action: "task_cancel"): { ok: true } | { ok: false; reason: string };
}

export interface CancelPorts {
  readonly ledger: CancelLedger;
  readonly links: CancelLinkGate;
  // 장부에 주입한 시계와 같은 시계(ports.ts). 호출마다 한 번 읽어 장부의 기록 시각과 처음 봉하는 시각에 함께 쓴다.
  readonly clock: Clock;
  // 호출 ID(= 지시의 요청 ID)와 nonce가 여기서 온다.
  readonly random: Random;
  readonly signer: Signer;
  readonly sink: InstructionSink;
  // 취소 호출 하나마다 한 번 부른다. 내보내기 포트가 돌려준 약속의 완료로 정해지는 결과(sent, 그 약속의 거부·no_connection·
  // too_late_to_send·정의 밖의 답)만 처리기에 답한 뒤에 오고, 그 약속이 끝나지 않으면 오지 않는다. 나머지(내보내기 포트가 동기로 던진
  // send_threw 포함)는 처리기가 답을 받기 전에 온다. 그래서 받는 쪽은 부르기 전에 등록해 둔다.
  // 동기로 던지거나 돌려준 약속이 거부돼도 처리기의 답·전달·장부와 다른 취소에 닿지 않는다.
  readonly observe: (event: CancelDelivery) => void;
}

// 적은 뒤 싣지 않은 이유. 앞의 여섯은 장부의 지시 줄을 다시 읽어 대조한 결과, no_connection·link_unknown은 연결 포트, draft_threw·seal_threw와
// 봉투 모듈의 거절 이름은 봉투를 만들지 못한 것, no_connection·too_late_to_send는 내보내기 포트의 거절이기도 하다.
export type CancelNotSentReason =
  | "read_unknown"
  | "stop_generation_unknown"
  | "stop_generation_changed"
  | "instruction_not_found"
  | "instruction_mismatch"
  | "not_rebuildable"
  | "no_connection"
  | "link_unknown"
  | "draft_threw"
  | "seal_threw"
  | DraftRefusalReason
  | "too_late_to_send";

export type CancelDelivery =
  // 장부를 부르지 않았다.
  | { readonly outcome: "not_recorded"; readonly ref: string | null; readonly reason: "input_malformed" | "random_unavailable" | "clock_unavailable" }
  // 장부가 거절했다. 아무것도 적히지 않았다.
  | { readonly outcome: "refused"; readonly ref: string | null; readonly requestId: string; readonly reason: LedgerRefusal }
  // 장부를 불렀지만 무엇이 적혔는지 모른다(쓰기가 던짐, 답이 정의 밖). 지시가 적혔다면 이 요청 ID다.
  | { readonly outcome: "record_unknown"; readonly ref: string | null; readonly requestId: string; readonly reason: "threw" | "malformed_answer" }
  // 적었고 보낼 지시가 없다(배정 전 대기의 부탁, 시작 전 실행).
  | { readonly outcome: "nothing_to_send"; readonly ref: string | null; readonly requestId: string }
  // 적었고 연결에 실었다. 실행기가 받았다는 뜻은 아니다(받았는지는 영수증으로만 안다).
  | { readonly outcome: "sent"; readonly ref: string | null; readonly requestId: string; readonly runId: string; readonly executorId: string }
  // 적었지만 싣지 않았다. executorId는 지시 줄을 대조하기 전이면 null이다.
  | {
      readonly outcome: "recorded_not_sent";
      readonly ref: string | null;
      readonly requestId: string;
      readonly runId: string;
      readonly executorId: string | null;
      readonly reason: CancelNotSentReason;
      readonly field?: string;
      readonly sealReason?: string;
    }
  // 적었고 내보내기 포트를 불렀지만 실었는지 모른다(포트가 던지거나 거부된 약속, 정의 밖의 답).
  | {
      readonly outcome: "delivery_unknown";
      readonly ref: string | null;
      readonly requestId: string;
      readonly runId: string;
      readonly executorId: string;
      readonly reason: "send_threw" | "send_answer_malformed";
    };

const UNKNOWN: Answer<CancelWrite> = { known: false };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isRefusal = (value: unknown): value is LedgerRefusal => (LEDGER_REFUSALS as readonly unknown[]).includes(value);
const isReason = (value: unknown): value is TaskCancelReason => (TASK_CANCEL_REASONS as readonly unknown[]).includes(value);

// 처리기의 requestCancel 자리에 넣을 함수를 만든다. 상태를 갖지 않는다.
export function cancelAdapter(ports: CancelPorts): (input: CancelInput) => Answer<CancelWrite> {
  return (input) => cancelOnce(ports, input);
}

const ignore = (): void => {};

// 관측 포트의 실패는 처리기의 답·전달·장부에 닿지 않는다. 반환형이 void여도 async 함수가 대입되므로 돌려준 약속의 거절도 여기서 삼킨다.
// 삼키지 않으면 처리되지 않은 거절이 되어 런타임이 감독 프로세스를 내린다. 약속을 기다리지 않으므로 답과 내보내기의 순서는 그대로다.
function emit(ports: CancelPorts, event: CancelDelivery): void {
  try {
    Promise.resolve(ports.observe(event) as unknown).then(undefined, ignore);
  } catch {
    // 관측 포트가 동기로 던졌다.
  }
}

function cancelOnce(ports: CancelPorts, input: CancelInput): Answer<CancelWrite> {
  // 입력의 칸은 한 번만 읽는다. 장부에 넘기는 값과 관측에 싣는 값이 갈리지 않게 한다.
  let ref: unknown;
  let owner: unknown;
  let sessionId: unknown;
  try {
    ({ ref, owner, sessionId } = input);
  } catch {
    emit(ports, { outcome: "not_recorded", ref: null, reason: "input_malformed" });
    return UNKNOWN;
  }
  // 관측에는 UUID 꼴의 참조만 싣는다. 처리기는 꼴을 걸러 부르지만 이 함수를 직접 부르면 아무 문자열이나 올 수 있고,
  // 관측은 기록으로 남으므로 꼴이 틀린 원문을 옮기지 않는다. 장부에는 받은 값 그대로 넘긴다(거절은 장부가 한다).
  const shown = typeof ref === "string" && UUID.test(ref) ? ref : null;
  if (typeof ref !== "string" || typeof owner !== "string" || typeof sessionId !== "string") {
    emit(ports, { outcome: "not_recorded", ref: shown, reason: "input_malformed" });
    return UNKNOWN;
  }

  // 처리기 문맥의 callId를 넘기지 않는다. 장부는 이 값을 지시의 요청 ID로 쓰고 같은 값을 다시 받으면 invariant_violation으로 막는데,
  // 문맥의 호출 ID는 꼴(UUID)만 검사될 뿐 호출마다 새것이라는 보장이 없다. 그래서 호출마다 난수 포트로 새 UUID를 만든다.
  let requestId: string | null;
  try {
    requestId = newUuid(ports.random);
  } catch {
    requestId = null;
  }
  if (requestId === null) {
    emit(ports, { outcome: "not_recorded", ref: shown, reason: "random_unavailable" });
    return UNKNOWN;
  }
  // 기록 시각은 문맥의 now가 아니라 장부와 같은 시계를 장부를 부르기 직전에 읽은 값이다. 이 시각이 lastStopAt이 되어 수명 판단이
  // 같은 시계로 답을 기다리므로 다른 시계의 값을 섞지 않는다. 읽은 뒤 장부를 부르기까지 포트도 await도 없다.
  let recordAt: unknown;
  try {
    recordAt = ports.clock.now();
  } catch {
    recordAt = null;
  }
  if (!Number.isSafeInteger(recordAt) || (recordAt as number) < 1) {
    emit(ports, { outcome: "not_recorded", ref: shown, reason: "clock_unavailable" });
    return UNKNOWN;
  }
  const now = recordAt as number;

  let answer: unknown;
  try {
    // 종료 사유는 장부가 이은 부탁의 취소에 늘 requested로 함께 적는다(이 연산은 사유 칸을 받지 않는다). 그래서 다시 만들 수 있는 줄로 남는다.
    answer = ports.ledger.cancelToolRequest({ owner, ref, sessionId, callId: requestId, now });
  } catch {
    emit(ports, { outcome: "record_unknown", ref: shown, requestId, reason: "threw" });
    return UNKNOWN;
  }
  const read = readAnswer(answer, requestId);
  if (read.kind === "malformed") {
    emit(ports, { outcome: "record_unknown", ref: shown, requestId, reason: "malformed_answer" });
    return UNKNOWN;
  }
  if (read.kind === "refused") {
    emit(ports, { outcome: "refused", ref: shown, requestId, reason: read.reason });
    // 종료가 확인됐거나 끝난 실행, 이미 닫힌 부탁이다(ledger.md "이은 부탁의 취소"). 다른 거절은 처리기의 답 꼴에 갈래가 없다.
    return read.reason === "transition_denied" ? { known: true, value: { ok: false, reason: "already_ended" } } : UNKNOWN;
  }
  if (read.kind === "closed") {
    emit(ports, { outcome: "nothing_to_send", ref: shown, requestId });
    return { known: true, value: { ok: true, phase: "not_started" } };
  }
  // 여기부터 장부에는 이 요청 ID의 task_cancel이 적혔다. 전달의 결과와 무관하게 답은 이것이다.
  deliver(ports, shown, requestId, read.runId, read.stopGeneration, now);
  return { known: true, value: { ok: true, phase: "stopping" } };
}

type ReadAnswer =
  | { kind: "malformed" }
  | { kind: "refused"; reason: LedgerRefusal }
  | { kind: "closed" }
  | { kind: "instruction"; runId: string; stopGeneration: number };

// 장부의 답에서 처리기의 답과 보낼 지시를 가른다. 칸은 한 번씩만 읽는다.
// 정의 안의 답은 셋이다: 거절, 지시 없는 not_started(배정 전 대기·시작 전 실행), 이 요청 ID의 지시를 실은 stopping.
// 지시 없는 stopping, 지시를 실은 not_started, 다른 단계, 다른 요청 ID, 정지 세대가 없는 지시는 무엇이 적혔는지 모르는 답이다.
function readAnswer(answer: unknown, requestId: string): ReadAnswer {
  try {
    if (!isObject(answer)) return { kind: "malformed" };
    const ok: unknown = answer.ok;
    if (ok === false) {
      const reason: unknown = answer.reason;
      return isRefusal(reason) ? { kind: "refused", reason } : { kind: "malformed" };
    }
    if (ok !== true) return { kind: "malformed" };
    const phase: unknown = answer.phase;
    const instruction: unknown = answer.instruction;
    if (phase === "not_started") return instruction === undefined ? { kind: "closed" } : { kind: "malformed" };
    if (phase !== "stopping" || !isObject(instruction)) return { kind: "malformed" };
    const runId: unknown = instruction.runId;
    const answeredId: unknown = instruction.requestId;
    const stopGeneration: unknown = instruction.stopGeneration;
    if (typeof runId !== "string" || !UUID.test(runId) || answeredId !== requestId || !isGeneration(stopGeneration)) return { kind: "malformed" };
    return { kind: "instruction", runId, stopGeneration };
  } catch {
    return { kind: "malformed" };
  }
}

type Located = { ok: true; runGeneration: number; executorId: string; reason: TaskCancelReason } | { ok: false; reason: CancelNotSentReason; executorId: string | null };

// 방금 적은 지시 줄을 장부에서 다시 찾는다. 장부의 답(instruction)에는 받는 실행기와 실행 세대가 없고, 사유는 지시 줄에만 있다.
// 그 줄을 재전송과 같은 읽기로 찾아, 줄의 값이 답과 같고 본문을 다시 만들 수 있을 때만 그 값을 쓴다.
// 이 읽기는 cancelToolRequest와 같은 동기 흐름에서 await 없이 부르므로, 그 사이에 이 요청 ID의 영수증이 장부에 닿을 수 없다.
function locate(ledger: CancelLedger, requestId: string, runId: string, stopGeneration: number): Located {
  try {
    const read: unknown = ledger.unansweredInstructions();
    if (!isObject(read) || read.known !== true || !isObject(read.value)) return { ok: false, reason: "read_unknown", executorId: null };
    const current: unknown = read.value.stopGeneration;
    const items: unknown = read.value.instructions;
    if (!Array.isArray(items)) return { ok: false, reason: "read_unknown", executorId: null };
    // 지금 정지 세대를 모르거나 적은 뒤 바뀌었으면 보내지 않는다. 실행기는 정확히 같은 세대만 받고, 적용 전의 옛 세대 지시를 받으면
    // 장부가 이미 넘어선 세대의 지시가 실행된다(ledger.md "재전송").
    if (current === null) return { ok: false, reason: "stop_generation_unknown", executorId: null };
    if (!isGeneration(current)) return { ok: false, reason: "read_unknown", executorId: null };
    if (current !== stopGeneration) return { ok: false, reason: "stop_generation_changed", executorId: null };
    const matches = items.filter((item) => isObject(item) && item.requestId === requestId) as Record<string, unknown>[];
    if (matches.length === 0) return { ok: false, reason: "instruction_not_found", executorId: null };
    if (matches.length > 1) return { ok: false, reason: "instruction_mismatch", executorId: null };
    const item = matches[0] as Record<string, unknown>;
    const action: unknown = item.action;
    const itemRun: unknown = item.runId;
    const itemStop: unknown = item.stopGeneration;
    const runGeneration: unknown = item.runGeneration;
    const executorId: unknown = item.executorId;
    const rebuild: unknown = item.rebuild;
    if (action !== "task_cancel" || itemRun !== runId || itemStop !== stopGeneration) return { ok: false, reason: "instruction_mismatch", executorId: null };
    if (!Number.isSafeInteger(runGeneration) || (runGeneration as number) < 1 || typeof executorId !== "string") {
      return { ok: false, reason: "instruction_mismatch", executorId: null };
    }
    if (!isObject(rebuild)) return { ok: false, reason: "not_rebuildable", executorId };
    const rebuildAction: unknown = rebuild.action;
    const reason: unknown = rebuild.reason;
    if (rebuildAction !== "task_cancel" || !isReason(reason)) return { ok: false, reason: "not_rebuildable", executorId };
    return { ok: true, runGeneration: runGeneration as number, executorId, reason };
  } catch {
    return { ok: false, reason: "read_unknown", executorId: null };
  }
}

// 적은 지시를 그 실행의 지정 실행기에 한 번 싣는다. 어느 실패든 다시 시도하지 않고 결과를 관측으로만 낸다.
function deliver(ports: CancelPorts, ref: string | null, requestId: string, runId: string, stopGeneration: number, now: number): void {
  const notSent = (reason: CancelNotSentReason, executorId: string | null, extra: { field?: string; sealReason?: string } = {}): void =>
    emit(ports, {
      outcome: "recorded_not_sent",
      ref,
      requestId,
      runId,
      executorId,
      reason,
      ...(extra.field === undefined ? {} : { field: extra.field }),
      ...(extra.sealReason === undefined ? {} : { sealReason: extra.sealReason }),
    });

  const line = locate(ports.ledger, requestId, runId, stopGeneration);
  if (!line.ok) return notSent(line.reason, line.executorId);
  const { executorId, runGeneration, reason } = line;

  let gate: unknown;
  try {
    gate = ports.links.mayIssue(executorId, "task_cancel");
  } catch {
    return notSent("link_unknown", executorId);
  }
  let verdict: "open" | "no_connection" | "link_unknown";
  try {
    verdict = isObject(gate) && gate.ok === true ? "open" : isObject(gate) && gate.ok === false && typeof gate.reason === "string" ? "no_connection" : "link_unknown";
  } catch {
    verdict = "link_unknown";
  }
  if (verdict !== "open") return notSent(verdict, executorId);

  let envelope: Envelope;
  try {
    const drafted = stopDraft({ action: "task_cancel", run: { runId, runGeneration, executorId }, requestId, stopGeneration, reason });
    if (!drafted.ok) return notSent(drafted.reason, executorId, { field: drafted.field });
    let sealed: ReturnType<typeof sealDraft>;
    try {
      // 종료의 머리 issued_at은 봉하는 때의 시각이고, 처음 봉할 때는 장부 기록에 넘긴 시각이다(envelopes.md "시각 규칙").
      sealed = sealDraft(drafted.draft, now, { random: ports.random, signer: ports.signer });
    } catch {
      return notSent("seal_threw", executorId);
    }
    if (!sealed.ok) return notSent(sealed.reason, executorId, { field: sealed.field, sealReason: sealed.sealReason });
    envelope = sealed.envelope;
  } catch {
    return notSent("draft_threw", executorId);
  }

  const unknown = (why: "send_threw" | "send_answer_malformed"): void => emit(ports, { outcome: "delivery_unknown", ref, requestId, runId, executorId, reason: why });
  let pending: unknown;
  try {
    pending = ports.sink.send(envelope);
  } catch {
    return unknown("send_threw");
  }
  // 받는 쪽과 식별값은 내보내기 전에 확보한 값이다. 포트가 넘겨받은 봉투를 고쳐도 관측은 바뀌지 않는다.
  Promise.resolve(pending).then(
    (outcome: unknown) => {
      if (outcome === "sent") emit(ports, { outcome: "sent", ref, requestId, runId, executorId });
      else if (outcome === "no_connection" || outcome === "too_late_to_send") notSent(outcome, executorId);
      else unknown("send_answer_malformed");
    },
    () => unknown("send_threw"),
  );
}
