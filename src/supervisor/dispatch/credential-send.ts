// 접수된 작업 시작마다 그 접수 영수증이 온 연결로 자격 값 틀을 한 번 보낸다(D-95). 모델 계정의 토큰 값이 감독 밖으로 나가는 유일한 길이다.
// 소켓·시계·파일·장부는 포트로만 닿는다. 타이머와 난수를 쓰지 않는다. 차례와 근거는 credential-send.md에 있다.
//
// 지키는 것:
// 1. 검증되고 장부가 받은 receipt_accepted(instruction: task_start)에만, (연결, 실행)마다 많아야 한 번 보낸다. 기억에는 읽기 전에 넣는다.
// 2. 쓰기 바로 앞(lastCheck)에서 계정 파일 읽기의 await 뒤에 바뀌었을 수 있는 것(정지 세대, 접수, 실행 줄, 시계와 기한)을 다시 본다.
//    연결이 아직 그 주체의 인정된 연결인지는 서버가 본다.
// 3. 값은 계정 파일을 다시 읽어 얻고 실행 줄의 지문과 같을 때만 보낸다(borrowCredentialValue). 읽기 상한은 정책의 maxBytes(≤ CREDENTIAL_MAX_BYTES).
// 4. 값과 틀은 결과·관측·예외 메시지에 싣지 않는다. 넘긴 틀은 settled 뒤에, 넘기지 못한 틀은 그 자리에서 0으로 채운다.
import type { Ledger, Restorer, Run } from "../../ledger/index.ts";
import { encodeCredentialFrame } from "../../transport/framing.ts";
import { borrowCredentialValue, type CredentialBorrowRefusal, type CredentialFiles, type CredentialRefPolicy } from "../accounts/credential-ref.ts";
import { type ConnectionServer, NOT_WRITTEN_REASONS, type NotWrittenReason, type SendEnd } from "../transport/server.ts";
import type { Clock } from "./ports.ts";
import type { ForwardInput, ReceiptOutcome } from "./receipts.ts";

// 서버의 쓰기 문 하나. 조립은 영수증이 온 그 서버 객체를 넘긴다(연결 번호는 서버 객체마다 1부터다).
export type CredentialSendServer = Pick<ConnectionServer, "writeFrame">;
// 실행 줄의 동기 읽기. 영수증 처리기(handleForward)가 쓴 그 장부 객체여야 한다.
export type CredentialSendLedger = Pick<Ledger, "getRun">;
// 부르는 순간의 복원기의 정지 세대와 접수. 조립은 서버의 restorer 포트와 같은 게시를 읽는 객체를 넘긴다.
export type CredentialSendGate = Pick<Restorer, "stopGeneration" | "intakeOpen">;

export interface CredentialSendPorts {
  readonly server: CredentialSendServer;
  readonly ledger: CredentialSendLedger;
  readonly gate: CredentialSendGate;
  // 장부와 같은 시계. 작업 기한(deadlineAt)과 견준다.
  readonly clock: Clock;
  readonly files: CredentialFiles;
  // 계정 폴더 정책. maxBytes가 CREDENTIAL_MAX_BYTES보다 크면 읽지 않고 보내지 않는다.
  readonly policy: CredentialRefPolicy;
  // 기록용. 동기 예외는 무시한다. 돌려준 약속은 보지 않으므로 비동기 기록기는 자기 거절을 스스로 처리한다.
  readonly observe?: (note: CredentialSendNote) => void;
}

// 보낼 대상이 아니라서 기억도 읽기도 하지 않은 영수증.
export const CREDENTIAL_SEND_IGNORED = [
  // 장부가 받지 않았다(ack·applied_without_ack가 아님).
  "ledger_not_accepted",
  // receipt_accepted가 아니다.
  "not_accepted_receipt",
  // 접수한 지시가 task_start가 아니다(run_renew 등).
  "not_task_start",
  // 장부의 결과와 받은 봉투가 같은 영수증이 아니다.
  "outcome_mismatch",
  // forward·결과의 꼴이 틀렸거나 읽다 던졌다.
  "malformed",
] as const;
export type CredentialSendIgnored = (typeof CREDENTIAL_SEND_IGNORED)[number];

// 쓰기 앞에서 보내지 않기로 한 까닭. 읽기 앞의 확인과 lastCheck가 같은 이름을 쓴다(lastCheck의 이름은 서버의 refusal로 돌아온다).
export const CREDENTIAL_SEND_BLOCKS = [
  "clock_failed",
  "deadline_passed",
  "gate_failed",
  "stop_generation_unknown",
  "stop_generation_changed",
  "intake_closed",
  "ledger_unavailable",
  "run_unknown",
  "not_assigned",
  "not_worker",
  "not_preparing",
  "not_accepted",
  "run_ended",
  // 실행 줄의 지문이 읽은 값의 지문과 달라졌다.
  "credential_changed",
] as const;
export type CredentialSendBlock = (typeof CREDENTIAL_SEND_BLOCKS)[number];

// 결과에는 이름과 번호만 싣는다. 바이트 칸을 두지 않는다(정적 시험).
export type CredentialSendResult =
  | { readonly kind: "ignored"; readonly reason: CredentialSendIgnored }
  // 이 (연결, 실행)에는 이미 한 번 시도했다(보냈든 못 보냈든).
  | { readonly kind: "already_sent"; readonly connection: number; readonly runId: string }
  // 읽기 앞의 확인에서 막혔다. 계정 파일을 읽지 않았다.
  | { readonly kind: "blocked"; readonly connection: number; readonly runId: string; readonly reason: CredentialSendBlock }
  // 계정 파일에서 값을 얻지 못했다(지문 불일치 포함). 바이트는 이미 0이다.
  | { readonly kind: "unreadable"; readonly connection: number; readonly runId: string; readonly reason: CredentialBorrowRefusal }
  // 틀을 만들지 못했다. 값은 0으로 채웠다.
  | { readonly kind: "frame_failed"; readonly connection: number; readonly runId: string; readonly reason: string }
  // 서버가 넘기지 않았다고 돌려줬다(넘긴 바이트 0). refused면 refusal에 lastCheck의 이름이 있다. 값과 틀은 0으로 채웠다.
  | {
      readonly kind: "not_written";
      readonly connection: number;
      readonly runId: string;
      readonly reason: NotWrittenReason;
      readonly refusal: string | null;
    }
  // 틀 하나를 통째로 넘겼다. 상대가 받았다는 뜻이 아니다. settled에서 0으로 채운다.
  | { readonly kind: "written"; readonly connection: number; readonly runId: string }
  // 넘겼는지 모른다. 값과 틀은 이미 0이다.
  // server_unknown: 서버가 unknown을 돌려줬다(write가 던졌고, 돌아오기 전에 settled를 불렀다).
  // write_threw·write_result_malformed: 서버가 계약 밖으로 던졌거나 꼴이 아닌 답을 줬다. 그 자리에서 채웠다.
  | { readonly kind: "unknown"; readonly connection: number; readonly runId: string; readonly reason: CredentialSendUnknown };

export type CredentialSendUnknown = "server_unknown" | "write_threw" | "write_result_malformed";

// 관측. 사유 이름·연결 번호·실행 ID만 싣는다.
export type CredentialSendNote =
  | { readonly kind: "attempt"; readonly connection: number; readonly runId: string; readonly outcome: Exclude<CredentialSendResult["kind"], "ignored">; readonly reason: string | null }
  // 값과 틀을 0으로 채웠다. at은 그 자리: settled의 끝, 또는 넘기지 못한 길의 이름.
  | {
      readonly kind: "wiped";
      readonly connection: number;
      readonly runId: string;
      readonly at: SendEnd | "not_written" | "frame_failed" | "write_threw" | "write_result_malformed";
    };

export interface CredentialSender {
  // handleForward가 돌려준 결과와 그 forward를 그대로 받는다. 대상이 아니면 ignored. 던지지 않고 거절된 약속을 내지 않는다.
  onReceipt(forward: ForwardInput["forward"], outcome: ReceiptOutcome): Promise<CredentialSendResult>;
  // 그 연결의 기억을 지운다. 연결이 withdrawn·닫힘일 때 부른다.
  forgetConnection(connection: number): void;
}

interface Target {
  readonly connection: number;
  readonly executorId: string;
  readonly runId: string;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

// 검증되고 장부가 받은 task_start의 접수 영수증만 고른다. 봉투의 값은 이미 계약 검증과 장부를 지났고, 여기서는 꼴만 본다.
function acceptedStart(forward: ForwardInput["forward"], outcome: ReceiptOutcome): Target | CredentialSendIgnored {
  try {
    const verdict = outcome.outcome;
    if (verdict !== "ack" && verdict !== "applied_without_ack") return "ledger_not_accepted";
    const verified = forward.verified;
    if (verified.ok !== true) return "malformed";
    if (outcome.action !== "receipt_accepted" || verified.action !== "receipt_accepted" || verified.header.action !== "receipt_accepted") {
      return "not_accepted_receipt";
    }
    const body = verified.body as { receipt_id?: unknown; run_id?: unknown; instruction?: unknown };
    if (body.instruction !== "task_start") return "not_task_start";
    if (body.receipt_id !== outcome.id) return "outcome_mismatch";
    const connection = forward.connection;
    const executorId = verified.header.sender;
    const runId = body.run_id;
    if (!Number.isSafeInteger(connection) || connection < 0 || !isText(executorId) || !isText(runId)) return "malformed";
    return { connection, executorId, runId };
  } catch {
    return "malformed";
  }
}

// 실행 줄에서 뒤에 쓰는 칸만 옮긴 평범한 사본.
interface RunView {
  readonly credential: Pick<Run["credential"], "account" | "method" | "digest">;
  readonly deadlineAt: number;
}

// 실행 줄이 지금 값을 받을 실행인가. 읽기 앞과 lastCheck가 같은 판정을 쓴다.
// 장부가 준 객체의 칸은 여기서 한 번씩 꺼낸다: 부르는 check가 예외를 잡으므로 접근자가 던져도 이름으로 끝나고, 뒤에서 다시 읽지 않는다.
function runBlock(ledger: CredentialSendLedger, target: Target): { readonly run: RunView } | { readonly block: CredentialSendBlock } {
  const read = ledger.getRun(target.runId);
  if (read.known !== true) return { block: "ledger_unavailable" };
  const run = read.value;
  if (run === null) return { block: "run_unknown" };
  if (run.executorId !== target.executorId) return { block: "not_assigned" };
  if (run.kind !== "worker") return { block: "not_worker" };
  if (run.state !== "preparing") return { block: "not_preparing" };
  if (run.acceptedReceiptId === null) return { block: "not_accepted" };
  if (run.stopReceiptId !== null || run.cleanedReceiptId !== null || run.resultDigest !== null) return { block: "run_ended" };
  const credential = run.credential;
  return { run: { credential: { account: credential.account, method: credential.method, digest: credential.digest }, deadlineAt: run.deadlineAt } };
}

type WriteAnswer = { readonly kind: "written" } | { readonly kind: "unknown" } | { readonly kind: "not_written"; readonly reason: NotWrittenReason; readonly refusal: string | null };

// 서버의 답에서 쓸 칸을 한 번씩 꺼낸다. 꼴이 아니거나 읽다 던지면 null이다(넘겼는지 모른다).
function writeAnswer(result: unknown): WriteAnswer | null {
  try {
    const kind = (result as { kind?: unknown } | null)?.kind;
    if (kind === "written" || kind === "unknown") return { kind };
    if (kind !== "not_written") return null;
    const reason = (result as { reason?: unknown }).reason;
    // 서버의 사유 목록 밖 글자는 결과·관측에 옮기지 않는다. 넘긴 바이트 0이라는 답도 믿을 수 없어 꼴이 아닌 답으로 본다.
    if (typeof reason !== "string" || !(NOT_WRITTEN_REASONS as readonly string[]).includes(reason)) return null;
    if (reason !== "refused") return { kind, reason: reason as NotWrittenReason, refusal: null };
    const refusal = (result as { refusal?: unknown }).refusal;
    // refusal은 lastCheck가 낸 이름이다. 그 밖의 글자를 결과에 옮기지 않는다.
    return typeof refusal === "string" && (CREDENTIAL_SEND_BLOCKS as readonly string[]).includes(refusal) ? { kind, reason, refusal } : null;
  } catch {
    return null;
  }
}

export function createCredentialSender(ports: CredentialSendPorts): CredentialSender {
  // 연결 번호 → 이미 시도한 실행 ID. 메모리에만 둔다. 서버 객체가 바뀌면 이 객체도 새로 만든다(연결 번호가 1부터 다시 쓰인다).
  const tried = new Map<number, Set<string>>();

  const note = (value: CredentialSendNote) => {
    try {
      ports.observe?.(value);
    } catch {
      // 기록이 실패해도 보내기와 정리는 그대로다.
    }
  };
  const finish = (target: Target, result: Exclude<CredentialSendResult, { kind: "ignored" }>): CredentialSendResult => {
    const reason = "reason" in result ? (result.kind === "not_written" && result.refusal !== null ? result.refusal : result.reason) : null;
    note({ kind: "attempt", connection: target.connection, runId: target.runId, outcome: result.kind, reason });
    return result;
  };

  // 정지 세대·접수·실행 줄·시계와 기한. 읽기 앞에서는 기준을 잡고, lastCheck에서는 그 기준과 지금을 견준다.
  // 시계는 마지막에 읽는다: 쓰기에 가장 가까운 시각으로 기한을 본다.
  const check = (target: Target, expected: { readonly generation: number; readonly digest: string } | null) => {
    let generation: number | null;
    let open: boolean;
    try {
      generation = ports.gate.stopGeneration();
      open = ports.gate.intakeOpen();
    } catch {
      return { block: "gate_failed" as const };
    }
    if (generation === null || !Number.isSafeInteger(generation)) return { block: "stop_generation_unknown" as const };
    if (expected !== null && generation !== expected.generation) return { block: "stop_generation_changed" as const };
    if (open !== true) return { block: "intake_closed" as const };
    let row: ReturnType<typeof runBlock>;
    try {
      row = runBlock(ports.ledger, target);
    } catch {
      return { block: "ledger_unavailable" as const };
    }
    if ("block" in row) return row;
    if (expected !== null && row.run.credential.digest !== expected.digest) return { block: "credential_changed" as const };
    // row.run은 runBlock이 옮긴 평범한 사본이라 아래 읽기는 던지지 않는다.
    let now: number;
    try {
      now = ports.clock.now();
    } catch {
      return { block: "clock_failed" as const };
    }
    if (!Number.isSafeInteger(now)) return { block: "clock_failed" as const };
    if (now >= row.run.deadlineAt) return { block: "deadline_passed" as const };
    return { generation, run: row.run };
  };

  return {
    async onReceipt(forward, outcome) {
      const picked = acceptedStart(forward, outcome);
      if (typeof picked === "string") return { kind: "ignored", reason: picked };
      const target = picked;

      // 읽기 전에 넣는다. 같은 연결의 같은 영수증이 계정 파일 읽기를 기다리는 동안 다시 와도 여기서 끝난다.
      let runs = tried.get(target.connection);
      if (runs?.has(target.runId)) return finish(target, { kind: "already_sent", connection: target.connection, runId: target.runId });
      if (runs === undefined) tried.set(target.connection, (runs = new Set()));
      runs.add(target.runId);

      const before = check(target, null);
      if ("block" in before) return finish(target, { kind: "blocked", connection: target.connection, runId: target.runId, reason: before.block });
      const expected = { generation: before.generation, digest: before.run.credential.digest };

      // 이 await와 아래 writeFrame 사이에 다른 await가 없다. 그 사이에 바뀐 것은 lastCheck가 다시 본다.
      const borrowed = await borrowCredentialValue(ports.files, ports.policy, before.run.credential);
      if (!borrowed.ok) return finish(target, { kind: "unreadable", connection: target.connection, runId: target.runId, reason: borrowed.reason });
      const value = borrowed.value;

      let encoded: ReturnType<typeof encodeCredentialFrame>;
      try {
        encoded = encodeCredentialFrame(target.runId, expected.digest, value);
      } catch {
        encoded = { ok: false, reason: "frame_credential_bad_run_id" };
      }
      if (!encoded.ok) {
        value.fill(0);
        note({ kind: "wiped", connection: target.connection, runId: target.runId, at: "frame_failed" });
        return finish(target, { kind: "frame_failed", connection: target.connection, runId: target.runId, reason: encoded.reason });
      }
      const frame = encoded.frame;

      // 정리는 한 번이다. 넘긴 틀은 settled에서, 넘기지 못한 틀은 반환을 본 자리에서 채운다(먼저 채우면 0이 나간다).
      let wiped = false;
      const wipe = (at: Extract<CredentialSendNote, { kind: "wiped" }>["at"]) => {
        if (wiped) return;
        wiped = true;
        // 한 배열의 fill이 던져도(소유를 어긴 포트가 버퍼를 떼어 간 때) 다른 배열은 채운다. settled 안이므로 던지지 않는다.
        try {
          value.fill(0);
        } catch {}
        try {
          frame.fill(0);
        } catch {}
        note({ kind: "wiped", connection: target.connection, runId: target.runId, at });
      };

      let result: unknown;
      try {
        result = ports.server.writeFrame(target.connection, target.executorId, frame, {
          lastCheck: () => {
            const now = check(target, expected);
            return "block" in now ? now.block : null;
          },
          settled: (end) => wipe(end),
        });
      } catch {
        // 서버 계약 밖이다. 틀을 받은 뒤 던졌을 수 있으므로 넘긴 바이트 0이라고 하지 않는다(unknown).
        // settled가 올지 모르므로 여기서 채운다: 값이 남는 것보다, 넘겨졌다면 0이 나가 상대 디코더가 거절하는 쪽을 고른다.
        wipe("write_threw");
        return finish(target, { kind: "unknown", connection: target.connection, runId: target.runId, reason: "write_threw" });
      }
      const answer = writeAnswer(result);
      if (answer === null) {
        // 꼴이 아닌 답도 넘겼는지 모른다. 위와 같이 그 자리에서 채운다.
        wipe("write_result_malformed");
        return finish(target, { kind: "unknown", connection: target.connection, runId: target.runId, reason: "write_result_malformed" });
      }
      if (answer.kind === "written") return finish(target, { kind: "written", connection: target.connection, runId: target.runId });
      // unknown이면 서버가 돌아오기 전에 settled를 불렀다. 다시 정리하지 않는다.
      if (answer.kind === "unknown") return finish(target, { kind: "unknown", connection: target.connection, runId: target.runId, reason: "server_unknown" });
      wipe("not_written");
      return finish(target, { kind: "not_written", connection: target.connection, runId: target.runId, reason: answer.reason, refusal: answer.refusal });
    },

    forgetConnection(connection) {
      tried.delete(connection);
    },
  };
}
