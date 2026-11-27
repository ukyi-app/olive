// 관리자 자리 풀기(D-149 ④, D-156)의 감독 쪽 처리기. 읽기 하나(holds)와 장부 쓰기마다 명령 하나다: close-unconfirmed(관리자 닫기,
// closeRunByOperator의 pod_replaced, D-91·D-96·D-97), abandon-result(결과 포기, abandonResult, D-148·D-157·D-168), close-store-reset(저장소
// 비움 닫기, closeRunByOperator의 store_reset, D-158), release-hold(점유 관측 풀기, releaseSlotHold, D-161). CLI(homelab olive release, 뒤 작업)는
// holds로 앞 상태를 읽어 절차를 고르고 쓰기 전에 다시 읽는다. 그 사이 상태가 바뀌면 장부가 거절하고, 처리기는 그 거절 이름을 그대로 낸다.
//
// 켜기: 설정 스위치 없이 늘 받는다(운영 관리 기능, D-91의 CLI 전용). 접수 닫힘·정지 중에도 받는다(장부의 쓰기 모드 new가 막지 않는다).
// 복원 5단계를 받아들이기 전에는 holds도 쓰기도 받지 않는다(restore_not_done, 3. 까닭은 README "감독 관리 통로"의 "자리 풀기").
//
// 쓰기의 차례(한 동기 구간): 칸 검사 → 상태 읽기(status.ts의 readStatus: 복원·살아 있음) → 시각(공유 시계 peek) → 파드 시각 대조 → 쓰기 함수
// 꺼내기 → 문 한 번 → 호출 하나 → 답 대조 → 자리 읽기(peekHolds) → 기록 한 줄. 꺼내기와 호출 사이에는 문 한 번의 호출만 있다(test-job.ts와 같다).
// 함정:
// - 쓰기 뒤의 자리 읽기와 holds는 장부를 고장으로 표시하지 않는 peekHolds다. 관리 통로는 늘 켜져 있어, 사람이 부른 조회의 일시 오류가
//   접수를 닫고 감독을 끝내면 안 된다. 쓰기 뒤 읽기가 실패해도 쓰기의 답은 그대로이고 slotFree만 모름(null)이다.
// - 장부의 LedgerInputError는 트랜잭션을 열기 전에 던진다(아무것도 쓰지 않았다). 파드 이름 규칙처럼 이 파일이 다시 보지 않는 꼴은 그것으로
//   malformed가 된다. 그 밖의 예외는 호출 뒤면 write_unknown이다.
// - 기록(note)에 파드 이름을 옮기지 않는다: 파드 이름은 운영 장부의 근거 줄에만 남는다(ledger.md "관리자 닫기를 부르는 쪽").
import { type Ledger, LedgerInputError, RESULT_ABANDON_REASONS } from "../../ledger/index.ts";
import { REF, UUID } from "../../ledger/input.ts";
import {
  ADMIN_LIMITS,
  type AdminArgs,
  type AdminReply,
  encodeReply,
  type HoldAction,
  type HoldObservation,
  type HoldRun,
  type Holds,
  LEDGER_REFUSALS,
  type LedgerRefusal,
  RELEASE_FIELDS,
  type ReleaseAnswer,
  type ReleaseCommand,
  type RefusedReason,
  type UnknownReason,
} from "./protocol.ts";
import { type AdminSources, readStatus } from "./status.ts";

// 감독 로그 admin_release 한 줄의 칸. result는 답의 갈래(closed·abandoned·hold_released, 아니면 refused·unknown), reason은 거절·모름의
// 사유(장부가 거절했으면 장부의 거절 이름), runId는 칸 검사를 지난 요청의 실행 ID다(꼴이 틀린 요청은 null).
// 기록 포트(LogFields)에 그대로 넘기도록 interface가 아니라 객체 타입이다(암묵 색인 서명).
export type ReleaseNote = {
  readonly command: ReleaseCommand;
  readonly runId: string | null;
  readonly result: "closed" | "abandoned" | "hold_released" | "refused" | "unknown";
  readonly reason: string | null;
  readonly slotFree: boolean | null;
};

// 조립(runtime/boot.ts)이 늘 만드는 포트.
export interface ReleasePorts {
  // 장부의 쓰기 셋과 장부를 고장으로 표시하지 않는 읽기 하나만 담은 객체. 처리기는 문을 보기 직전에 쓰기 칸을 꺼낸다.
  readonly ledger: Pick<Ledger, "closeRunByOperator" | "abandonResult" | "releaseSlotHold" | "peekHolds">;
  // 조립의 문 하나: 끝 차례·끝낼 사유(closed), 복원 5단계(restore_not_done), 박자 기한(closed)을 보고 맨 끝에 단조 시각으로 요청 기한
  // limit 정각 전인지 본다(late, 시각을 읽지 못해도 late). 장부를 읽지 않고 래치를 움직이지 않는다. 접수 허가는 보지 않는다.
  readonly gate: (limit: number) => "open" | "closed" | "restore_not_done" | "late";
  // 감독 로그 한 줄. 던져도 답은 그대로다.
  readonly note: (fields: ReleaseNote) => void;
}

export const RELEASE_LIMITS = {
  // holds가 장부에서 읽는 줄 수(실행 줄 + 점유 관측)의 상한. 답 한 줄(4,096바이트)에 들어가는 수보다 넉넉하다.
  holdsReadCap: 64,
} as const;

const refused = (reason: RefusedReason): AdminReply => ({ kind: "refused", reason });
const unknown = (reason: UnknownReason): AdminReply => ({ kind: "unknown", reason });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fits = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);
// 10진 정수 문자열(앞의 0 없음). 안전 정수가 아니면 null이다.
const DECIMAL = /^(0|[1-9][0-9]{0,15})$/;
const integer = (value: unknown): number | null => (fits(value, DECIMAL) && Number.isSafeInteger(Number(value)) ? Number(value) : null);

type Parsed =
  | { readonly command: "close-unconfirmed" | "close-store-reset"; readonly runId: string; readonly podName: string; readonly podStartedAt: number }
  | { readonly command: "abandon-result"; readonly runId: string; readonly reason: (typeof RESULT_ABANDON_REASONS)[number]; readonly stopReceiptId: string }
  | {
      readonly command: "release-hold";
      readonly executorId: string;
      readonly runId: string;
      readonly runGeneration: number;
      readonly observation: number;
      readonly podName: string;
      readonly podStartedAt: number;
    };

// 요청의 칸을 본다. 칸이 정확히 그 명령의 것이 아니거나 하나라도 꼴이 틀리면 null이다(장부를 부르지 않는다). 파드 이름의 규칙은 장부가 본다.
function parse(command: ReleaseCommand, args: AdminArgs): Parsed | null {
  const names = RELEASE_FIELDS[command];
  const keys = Object.keys(args);
  if (keys.length !== names.length || !names.every((name) => Object.hasOwn(args, name))) return null;
  if (!names.every((name) => typeof args[name] === "string" && args[name] !== "")) return null;
  const runId = args.runId;
  if (!fits(runId, UUID)) return null;
  if (command === "abandon-result") {
    const reason = args.reason;
    if (!(RESULT_ABANDON_REASONS as readonly unknown[]).includes(reason) || !fits(args.stopReceiptId, UUID)) return null;
    return { command, runId, reason: reason as (typeof RESULT_ABANDON_REASONS)[number], stopReceiptId: args.stopReceiptId };
  }
  const podName = args.podName as string;
  const podStartedAt = integer(args.podStartedAt);
  if (podStartedAt === null) return null;
  if (command === "release-hold") {
    const runGeneration = integer(args.runGeneration);
    const observation = integer(args.observation);
    if (!fits(args.executorId, REF) || runGeneration === null || observation === null) return null;
    return { command, executorId: args.executorId, runId, runGeneration, observation, podName, podStartedAt };
  }
  return { command, runId, podName, podStartedAt };
}

// 장부에 넘길 입력. 확인 방법은 명령이 정한다.
function inputOf(parsed: Parsed, now: number): Record<string, unknown> {
  if (parsed.command === "abandon-result") return { runId: parsed.runId, reason: parsed.reason, stopReceiptId: parsed.stopReceiptId, now };
  if (parsed.command === "release-hold") {
    const { executorId, runId, runGeneration, observation, podName, podStartedAt } = parsed;
    return { executorId, runId, runGeneration, observation, checkedBy: "pod_replaced", podName, podStartedAt, now };
  }
  const checkedBy = parsed.command === "close-unconfirmed" ? "pod_replaced" : "store_reset";
  return { runId: parsed.runId, checkedBy, podName: parsed.podName, podStartedAt: parsed.podStartedAt, now };
}

// 장부의 답을 넘긴 값과 대조한다. ok:false는 트랜잭션이 되돌려진 거절이라 적힌 것이 없고, 그 이름을 그대로 싣는다. 답이 넘긴 값과
// 어긋나면 무엇이 적혔는지 모른다(write_unknown). 성공이면 released(대상이 자리를 놓았는가)까지 정한다.
function verdictOf(written: unknown, parsed: Parsed, input: Record<string, unknown>): { readonly ok: true; readonly answer: Omit<ReleaseAnswer, "slotFree"> } | { readonly ok: false; readonly reply: AdminReply } {
  const fail = (reply: AdminReply) => ({ ok: false as const, reply });
  if (!isRecord(written)) return fail(unknown("write_unknown"));
  if (written.ok === false) {
    const reason: unknown = written.reason;
    return (LEDGER_REFUSALS as readonly unknown[]).includes(reason) ? fail({ kind: "refused", reason: "ledger_refused", refusal: reason as LedgerRefusal }) : fail(unknown("write_unknown"));
  }
  if (written.ok !== true) return fail(unknown("write_unknown"));
  const same = (row: unknown, keys: Record<string, unknown>) => isRecord(row) && Object.entries(keys).every(([key, value]) => row[key] === value);
  const { runId } = parsed;
  if (parsed.command === "release-hold") {
    const { executorId, runGeneration, observation, podName, podStartedAt } = parsed;
    if (!same(written.release, { observation, executorId, runId, runGeneration, checkedBy: "pod_replaced", podName, podStartedAt, releasedAt: input.now })) return fail(unknown("write_unknown"));
    return { ok: true, answer: { outcome: "hold_released", runId, released: true } };
  }
  if (parsed.command === "abandon-result") {
    if (!same(written.run, { runId, state: "failed_stopped" })) return fail(unknown("write_unknown"));
    if (!same(written.abandon, { runId, reason: parsed.reason, stopReceiptId: parsed.stopReceiptId, abandonedAt: input.now })) return fail(unknown("write_unknown"));
    // failed_stopped는 확정과 실행기의 정리 영수증 뒤에 자리를 놓는다.
    return { ok: true, answer: { outcome: "abandoned", runId, released: false } };
  }
  if (!same(written.run, { runId, state: "not_started" })) return fail(unknown("write_unknown"));
  if (!same(written.closure, { runId, checkedBy: input.checkedBy, podName: parsed.podName, podStartedAt: parsed.podStartedAt, closedAt: input.now })) return fail(unknown("write_unknown"));
  return { ok: true, answer: { outcome: "closed", runId, released: true } };
}

// 쓰기 뒤 작업자 자리를 쓸 수 있는가. 읽지 못하거나 던지면 모름(null)이다.
function slotFreeAfter(ports: ReleasePorts): boolean | null {
  try {
    const read = ports.ledger.peekHolds(1);
    return read.known === true && typeof read.value.workerSlotFree === "boolean" ? read.value.workerSlotFree : null;
  } catch {
    return null;
  }
}

function noteOf(command: ReleaseCommand, runId: string | null, reply: AdminReply): ReleaseNote {
  if (reply.kind === "release") return { command, runId, result: reply.release.outcome, reason: null, slotFree: reply.release.slotFree };
  if (reply.kind === "refused") return { command, runId, result: "refused", reason: reply.refusal ?? reply.reason, slotFree: null };
  if (reply.kind === "unknown") return { command, runId, result: "unknown", reason: reply.reason, slotFree: null };
  return { command, runId, result: "unknown", reason: "malformed", slotFree: null };
}

// limit은 관리 소켓이 이 요청 한 줄에 정한 기한(listener.ts의 serverWaitMs)이다. 쓰기는 그 기한 정각 전에만 부른다.
export function releaseHandler(command: ReleaseCommand, sources: AdminSources, ports: ReleasePorts): (args: AdminArgs, limit: number) => AdminReply {
  const answer = (args: AdminArgs, limit: number): { readonly runId: string | null; readonly reply: AdminReply } => {
    const parsed = parse(command, args);
    if (parsed === null) return { runId: null, reply: refused("malformed") };
    const runId = parsed.runId;
    let calling = false;
    try {
      const status = readStatus(sources);
      if (!status.known) return { runId, reply: unknown(status.reason) };
      if (!status.status.alive) return { runId, reply: refused("not_alive") };
      // 근거 줄의 시각이자 31초 한도·파드 시각과 견줄 시각. 공유 시계의 peek라 하한을 올리지 않는다.
      const clock = sources.now();
      if (clock.state !== "ok" || !Number.isSafeInteger(clock.at) || clock.at <= 0) return { runId, reply: unknown("clock_unavailable") };
      const now = clock.at;
      if (parsed.command !== "abandon-result" && parsed.podStartedAt > now) return { runId, reply: refused("pod_started_later") };
      const input = inputOf(parsed, now);
      const ledger = ports.ledger;
      const write = command === "abandon-result" ? ledger.abandonResult : command === "release-hold" ? ledger.releaseSlotHold : ledger.closeRunByOperator;
      if (typeof write !== "function") return { runId, reply: unknown("read_threw") };
      const gate = ports.gate(limit);
      if (gate === "restore_not_done") return { runId, reply: unknown("restore_not_done") };
      if (gate !== "open") return { runId, reply: refused(gate === "late" ? "late" : "not_alive") };
      calling = true;
      const verdict = verdictOf((write as (input: unknown) => unknown).call(ledger, input), parsed, input);
      if (!verdict.ok) return { runId, reply: verdict.reply };
      return { runId, reply: { kind: "release", release: { ...verdict.answer, slotFree: slotFreeAfter(ports) } } };
    } catch (error) {
      if (calling && error instanceof LedgerInputError) return { runId, reply: refused("malformed") };
      return { runId, reply: unknown(calling ? "write_unknown" : "read_threw") };
    }
  };
  return (args, limit) => {
    const { runId, reply } = answer(args, limit);
    try {
      ports.note(noteOf(command, runId, reply));
    } catch {
      // 기록 실패는 답에 영향을 주지 않는다.
    }
    return reply;
  };
}

// 자리를 쥔 실행 줄의 다음 행동(README "감독 관리 통로"의 holds 표). 세션은 이 통로의 명령이 없다.
export function nextFor(run: { readonly kind: string; readonly state: string; readonly stopReceiptId: string | null; readonly failedStoppedAt: number | null }): HoldAction {
  if (run.kind !== "worker") return "none";
  if ((run.state === "unknown_running" || run.state === "stopping") && run.stopReceiptId === null) return "close_unconfirmed";
  if (run.state === "checking") return "abandon_result";
  if (run.state === "ready_result" || run.state === "cleanup_pending") return "wait_cleanup";
  // 실패 시각이 없는 failed_stopped(판 8 전에 실패한 줄)는 확정도 저장소 비움 닫기도 못 한다(D-162: 장부 초기화).
  if (run.state === "failed_stopped") return run.failedStoppedAt === null ? "none" : "wait_cleanup";
  return "none";
}

const BYTES = new TextEncoder();

// 답 한 줄이 상한 안에 들도록 뒤의 줄부터 뺀다(점유 관측의 끝부터, 그다음 실행 줄의 끝부터). 하나라도 뺐거나 장부 읽기가 cap에서 멈췄으면 truncated다.
export function fitHolds(slotFree: boolean, runs: readonly HoldRun[], slotHolds: readonly HoldObservation[], more: boolean): Holds {
  let r = runs.length;
  let h = slotHolds.length;
  let holds: Holds = { slotFree, runs, slotHolds, truncated: more };
  while (BYTES.encode(encodeReply({ kind: "holds", holds })).length > ADMIN_LIMITS.replyMaxBytes && r + h > 0) {
    if (h > 0) h -= 1;
    else r -= 1;
    holds = { slotFree, runs: runs.slice(0, r), slotHolds: slotHolds.slice(0, h), truncated: true };
  }
  return holds;
}

// holds: 칸이 없다. 복원 5단계 전에는 장부를 읽지 않고 모름이다. 읽기는 peekHolds 한 번이다.
export function holdsHandler(sources: AdminSources, ports: ReleasePorts): (args: AdminArgs) => AdminReply {
  return (args) => {
    if (Object.keys(args).length !== 0) return refused("malformed");
    try {
      if (sources.progress().restored !== true) return unknown("restore_not_done");
      const read = ports.ledger.peekHolds(RELEASE_LIMITS.holdsReadCap);
      if (read.known !== true) return unknown("ledger_unreadable");
      const { runs, slotHolds, more, workerSlotFree } = read.value;
      const lines: HoldRun[] = runs.map((run) => ({
        runId: run.runId,
        kind: run.kind,
        state: run.state,
        executorId: run.executorId,
        runGeneration: run.runGeneration,
        accepted: run.accepted,
        finalizeSent: run.finalizeSent,
        closableAt: run.closableAt,
        // 결과 포기 후보에만 싣는다: CLI가 이 값을 그대로 abandon-result에 넘긴다(ledger.md "판 9의 자리 풀기를 부르는 쪽").
        stopReceiptId: run.state === "checking" ? run.stopReceiptId : null,
        next: nextFor(run),
      }));
      const holds: HoldObservation[] = slotHolds.map((hold) => ({
        observation: hold.observation,
        executorId: hold.executorId,
        runId: hold.runId,
        kind: hold.kind,
        runGeneration: hold.runGeneration,
        why: hold.why,
        heldAt: hold.heldAt,
        next: "release_hold",
      }));
      return { kind: "holds", holds: fitHolds(workerSlotFree, lines, holds, more) };
    } catch {
      return unknown("read_threw");
    }
  };
}
