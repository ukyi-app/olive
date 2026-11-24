// 감독의 답 줄. 연결 서버가 넘긴 출력(deliver)을 받아 실행기마다 답(인사의 full 점유, 대조할 상태 보고, 저장되지 않은 밀린 사본)을
// 받은 차례로 줄 세우고, 그 차례로 영수증 처리기(handleForward·replayBacklog)와 인사 처리기(passHelloAnswer·retryHelloAnswer)에
// 넘긴다. 영수증·보고는 줄에 넣지 않고 곧바로 영수증 처리기에 넘기고, 장부가 받은 것의 ack 초안만 봉해 writeAck로 그 연결에 쓴다.
// 처리기의 판단을 여기서 다시 만들지 않는다: 결과의 정해진 칸(backlog, retry, withhold, held)을 줄의 상태로 옮기기만 한다.
// 설명 문서는 answers.md다.
//
// 이 파일이 지키는 것:
// 1. 한 실행기의 답은 받은 차례로 넘긴다. 앞 답이 붙들린 동안(인사의 held·실패, 밀린 사본이 남음) 뒤 답을 장부에 넘기지 않는다.
//    실패한 인사는 처리기가 낸 원본 retry 객체로 먼저 다시 넘기고, held는 넘기는 순간의 가장 새 연결 표와 지금 게시된 복원기로 다시 넘긴다.
// 2. 복원이 붙든 관측이 적히기 전(observationsSettled가 참이 되기 전)에는 줄의 어떤 답도 넘기지 않는다. 다시 넘기기도 같다.
//    처리기를 한 번 부를 때마다 다시 본다(앞 처리의 기록이나 장부 쓰기가 같은 동기 구간에서 그 신호를 바꿀 수 있다).
// 3. 연결 대조는 소비하는 순간에 한다: 상태 보고는 처리기의 links(내보내기 포트의 answers.current), 인사는 그때의 연결 표로.
//    조회 대조는 받은 때 등록돼 있던 항목만으로 하고, 대조에 성공한 답 하나가 항목 하나만 끝낸다(같은 조회를 두 번 실으면 항목도 둘이다).
// 4. deliver는 던지지 않는다. 처리기와 장부를 부르는 흐름에 기다림이 없다(모두 한 동기 구간).
// 5. 맡기지 않을 실행기 집합은 인사가 줄에 들어온 때부터 그 실행기의 현재 연결 인사가 반영될 때까지 그 실행기를 싣는다.
//    반영한 뒤 연결 확인이 한 번 실패하면 반영한 연결 번호를 쥐고 다음 처리에서 해제 조건만 다시 본다(인사를 다시 넘기지 않는다).
//    뜻밖의 예외로 줄의 상태를 모르게 되면 집합을 known: false로 낸다(빈 목록으로 대신하지 않는다).
// 6. 줄이 쥐는 밀린 사본은 동결한 독립 값이다. 기록기에 넘긴 결과나 backlog()로 내보낸 값을 고쳐도 다시 넘길 내용은 그대로다.
// 시계·난수·소켓·타이머를 직접 쓰지 않는다. 시계·난수·서명·장부·복원기·연결 표는 포트로 받는다.
import { type Envelope, executorName, type RunStatus } from "../../contract/v1/index.ts";
import type { Restorer } from "../../ledger/index.ts";
import type { WithheldSource } from "../dispatch/assign-loop.ts";
import { type Draft, sealDraft } from "../dispatch/envelopes.ts";
import { type HelloAnswerOutcome, type HelloConnectionTable, type HelloRetry, passHelloAnswer, retryHelloAnswer } from "../dispatch/hello-answers.ts";
import type { Clock, Random, Signer } from "../dispatch/ports.ts";
import {
  type AnswerSettlement,
  type BacklogOutcome,
  type ExecutorAnswerCopy,
  handleForward,
  type ReceiptLedger,
  type ReceiptOutcome,
  replayBacklog,
  type ResultPorts,
  type SentQuery,
} from "../dispatch/receipts.ts";
import type { Delivered } from "../transport/server.ts";
import type { Cycle } from "./cycle.ts";
import type { QueryRegistry } from "./query-book.ts";
import type { AckOutcome, WireSink } from "./sink.ts";

export interface AnswerLinePorts {
  // 넘기는 순간의 연결 표(연결 서버의 table). 인사를 다시 넘길 때마다 새로 읽는다.
  readonly table: () => HelloConnectionTable;
  // 연결 서버·내보내기 포트에 넘긴 그 복원기 게시 함수. 부를 때마다 지금 게시된 복원기를 읽는다(쥐지 않는다).
  readonly restorer: () => Pick<Restorer, "stopGeneration" | "intakeOpen">;
  // 박자들과 같은 장부 객체. 영수증·보고·답의 장부 연산이다.
  readonly ledger: ReceiptLedger;
  // 결과 보고의 보관과 장부 읽기. ledger와 같은 장부여야 한다. 선택 칸이 아니다: 빠지면 결과 보고가 ack 없이 끝없이 다시 온다.
  readonly results: ResultPorts;
  // ack 초안의 요청 ID와 봉하기의 nonce.
  readonly random: Random;
  readonly signer: Signer;
  // 장부와 같은 공유 시계.
  readonly clock: Clock;
  // 같은 연결 서버 위에 만든 내보내기 포트의 답 연결 확인과 ack 쓰기.
  readonly wire: Pick<WireSink, "answers" | "writeAck">;
  // 내보내기 포트가 조회를 더하는 그 등록부.
  readonly queries: Pick<QueryRegistry, "pending" | "settle" | "dropConnection">;
  // 순서기의 candidate 기록.
  readonly cycle: Pick<Cycle, "noteCandidate">;
  // 지금의 복원기가 2단계를 마쳐 붙든 관측을 장부에 적었는가. 거짓이면(던짐 포함) 줄의 답을 넘기지 않고 쥔다.
  readonly observationsSettled: () => boolean;
  // 기록용. 동기 기록기여야 한다. 던져도 무시한다.
  readonly observe?: (note: AnswerNote) => void;
}

export type AnswerNote =
  | { readonly kind: "receipt"; readonly connection: number; readonly outcome: ReceiptOutcome }
  | { readonly kind: "status"; readonly executor: string; readonly connection: number; readonly outcome: ReceiptOutcome }
  | { readonly kind: "backlog"; readonly executor: string; readonly outcome: BacklogOutcome }
  | { readonly kind: "hello"; readonly executor: string; readonly outcome: HelloAnswerOutcome }
  | { readonly kind: "ack"; readonly connection: number; readonly id: string; readonly result: AckOutcome | "seal_refused" | "seal_threw" }
  // 뜻밖의 예외. 그 뒤 맡기지 않을 실행기 집합은 known: false다.
  | { readonly kind: "fault"; readonly where: "deliver" | "drain" };

export interface AnswerLines {
  // 연결 서버 옵션의 deliver. 던지지 않는다.
  deliver(output: Delivered): void;
  // 쥔 답(복원 대기, 접수 대기의 인사, 실패한 인사, 밀린 사본)을 다시 넘겨 본다. 박자마다 부른다.
  pump(): void;
  // 배정 박자와 내보내기 포트에 같은 객체로 넘기는 맡기지 않을 실행기 집합.
  readonly withheld: WithheldSource;
  // 그 실행기의 밀린 사본(받은 차례). 저장되지 않은 "안다"는 관측의 유일한 사본이다.
  backlog(executorId: string): readonly ExecutorAnswerCopy[];
  // 같은 실행 ID로 다시 물어야 할 실행(보류·저장 실패·인정이 끝난 연결의 답). 꺼내면 비운다.
  takeRequery(): readonly string[];
}

type StatusItem = {
  readonly kind: "status";
  readonly forward: Extract<Delivered, { kind: "forward" }>;
  // 받은 때 등록돼 있던 같은 요청 ID의 항목(등록부가 쥔 그 객체). 받은 뒤 더한 항목은 이 답의 조회가 아니다: 같은 키로 나중에 실은
  // 조회와 맞추면 그 조회의 진짜 답이 unknown_query로 버려진다. 받은 때 등록부를 읽지 못했으면 null(넘길 때의 항목으로 대조한다).
  readonly asked: readonly SentQuery[] | null;
};

type Item = { readonly kind: "hello"; readonly output: Extract<Delivered, { kind: "occupancy" }> } | StatusItem;

interface Line {
  // 아직 넘기지 않았거나 접수 대기(held)인 답. 받은 차례.
  readonly items: Item[];
  // 반영하지 못한 인사의 원본 retry. 있으면 줄의 맨 앞이다.
  retry: HelloRetry | null;
  // 영수증 처리기가 돌려준 밀린 사본(keepCopies로 동결한 독립 값).
  backlog: readonly ExecutorAnswerCopy[];
  // 맡기지 않는다. 인사가 들어오면 서고, 현재 연결의 인사가 반영되고 붙든 인사가 없을 때 내린다.
  withhold: boolean;
  // 반영을 끝냈지만 아직 맡기지 않음을 내리지 못한 인사의 연결 번호. 그때 연결 확인이 실패했거나 거짓이었다. 해제 조건만 다시 본다.
  applied: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const isPositive = (run: RunStatus): boolean => run.state !== "not_known";

// 줄이 쥘 밀린 사본. 처리기 결과는 기록기에, 쥔 사본은 backlog()로 밖에 나가므로 결과와 떨어진 동결한 값을 쥔다. 밖에서 고친 값이
// 다시 넘길 내용이 되면 실행기가 서명하지 않은 관측이 장부에 간다.
const keepCopy = (copy: ExecutorAnswerCopy): ExecutorAnswerCopy =>
  Object.freeze({
    sender: copy.sender,
    connection: copy.connection,
    coverage: copy.coverage,
    runs: Object.freeze(copy.runs.map((run) => Object.freeze({ run_id: run.run_id, state: run.state, run_generation: run.run_generation, last_receipt_id: run.last_receipt_id }))),
    answeredAt: copy.answeredAt,
  });
const keepCopies = (copies: readonly ExecutorAnswerCopy[]): readonly ExecutorAnswerCopy[] => Object.freeze(copies.map(keepCopy));

// 상태 보고의 in_reply_to. 꼴이 틀리면 빈 문자열이다(어느 항목과도 맞지 않는다).
function inReplyTo(forward: Extract<Delivered, { kind: "forward" }>): string {
  try {
    const verified: unknown = forward.verified;
    const body = isRecord(verified) ? verified.body : undefined;
    const value = isRecord(body) ? body.in_reply_to : undefined;
    return isText(value) ? value : "";
  } catch {
    return "";
  }
}

export function createAnswerLines(ports: AnswerLinePorts): AnswerLines {
  const lines = new Map<string, Line>();
  const requery = new Set<string>();
  // 처리하는 동안 다시 들어온 실행기. 바깥 처리가 이어서 돈다(같은 줄을 겹쳐 돌리지 않는다).
  const dirty = new Set<string>();
  // 대조에 성공한 답이 쓴 등록 항목 중 등록부의 settle이 던져 아직 끝내지 못한 것. 처리마다 다시 끝내 보고, 그동안 어느 답과도 대조하지 않는다.
  const unsettled = new Set<SentQuery>();
  let draining = false;
  let faulted = false;

  const note = (value: AnswerNote): void => {
    try {
      ports.observe?.(value);
    } catch {
      // 기록이 던져도 처리는 그대로다.
    }
  };

  const lineOf = (executorId: string): Line => {
    let line = lines.get(executorId);
    if (line === undefined) {
      line = { items: [], retry: null, backlog: [], withhold: false, applied: null };
      lines.set(executorId, line);
    }
    return line;
  };

  const readNow = (): number | null => {
    try {
      const now: unknown = ports.clock.now();
      return Number.isSafeInteger(now) && (now as number) >= 1 ? (now as number) : null;
    } catch {
      return null;
    }
  };

  const settled = (): boolean => {
    try {
      return ports.observationsSettled() === true;
    } catch {
      return false;
    }
  };

  const stopGeneration = (): number | null => {
    try {
      const generation: unknown = ports.restorer().stopGeneration();
      return Number.isSafeInteger(generation) ? (generation as number) : null;
    } catch {
      return null;
    }
  };

  const markRequery = (runs: readonly RunStatus[]): void => {
    for (const run of runs) requery.add(run.run_id);
  };

  // 처리기가 반영하지 못했거나 보류한 실행은 같은 ID로 다시 묻는다(receipts.md "다시 조회로 얻는 것").
  const takeSettlements = (items: readonly AnswerSettlement[]): void => {
    for (const item of items) {
      if (item.settled === "applied") for (const loss of item.deferred) requery.add(loss.runId);
      else if (item.settled !== "held") markRequery(item.answer.runs);
    }
  };

  // ack 초안을 그때의 시각으로 봉해 그 영수증이 온 연결에 쓴다. 장부가 받은 결과(ack)에서만 부른다.
  const writeAck = (connection: number, draft: Draft<"ack">, now: number): void => {
    const id = draft.body.ids[0] ?? "";
    let envelope: Envelope;
    try {
      const sealed = sealDraft(draft, now, { random: ports.random, signer: ports.signer });
      if (!sealed.ok) return note({ kind: "ack", connection, id, result: "seal_refused" });
      envelope = sealed.envelope;
    } catch {
      return note({ kind: "ack", connection, id, result: "seal_threw" });
    }
    note({ kind: "ack", connection, id, result: ports.wire.writeAck(connection, envelope) });
  };

  // 영수증·보고·결과 보고. 실행기가 ack를 받을 때까지 다시 보내므로 답 줄에 세우지 않는다(막힌 줄 뒤에 두면 종료 영수증이 무기한 막힌다).
  const passReceipt = (forward: Extract<Delivered, { kind: "forward" }>): void => {
    const now = readNow() ?? Number.NaN;
    const outcome = handleForward(
      { forward, now, stopGeneration: stopGeneration(), pendingQueries: [], links: ports.wire.answers, backlog: [] },
      { ledger: ports.ledger, random: ports.random, results: ports.results },
    );
    note({ kind: "receipt", connection: forward.connection, outcome });
    if (outcome.outcome === "ack") writeAck(forward.connection, outcome.ack, now);
  };

  // 밀린 사본만 다시 넘긴다. 남은 사본이 있으면 false. 줄의 상태를 먼저 옮기고 기록한다(기록기가 결과를 고쳐도 쥔 사본은 그대로다).
  const replay = (executorId: string, line: Line, now: number): boolean => {
    if (line.backlog.length === 0) return true;
    const outcome = replayBacklog({ backlog: line.backlog, now, links: ports.wire.answers }, { ledger: ports.ledger });
    if (outcome.outcome === "backlog_settled") {
      takeSettlements(outcome.settled);
      line.backlog = keepCopies(outcome.backlog);
    }
    note({ kind: "backlog", executor: executorId, outcome });
    return outcome.outcome === "backlog_settled" && line.backlog.length === 0;
  };

  // 대조에 성공한 답이 쓴 항목을 끝낸다. settle이 던지면 쥐었다가 다음 처리에서 다시 끝낸다(줄의 상태는 이미 옮겼다).
  const settleQueries = (): void => {
    for (const entry of [...unsettled]) {
      try {
        ports.queries.settle(entry);
        unsettled.delete(entry);
      } catch {
        // 다음 pump에서 다시 끝내 본다.
      }
    }
  };

  // 지금 등록부의 항목 중 이 답과 대조할 것: 받은 때 있던 항목이고 아직 끝내지 않은 것. 등록부가 던지면 그대로 던진다(줄은 바꾸기 전이다).
  const askedNow = (item: StatusItem): SentQuery[] => {
    const wanted = inReplyTo(item.forward);
    const known = item.asked === null ? null : new Set(item.asked);
    return ports.queries.pending().filter((entry) => isRecord(entry) && entry.requestId === wanted && !unsettled.has(entry) && (known === null || known.has(entry)));
  };

  // 인사가 반영됐을 때 그 연결이 지금 그 실행기의 인정된 연결이고 붙든 인사가 더 없으면 맡기지 않음을 내린다. 확인이 실패하거나 거짓이면
  // 반영한 연결 번호를 쥔다: 같은 연결의 두 번째 인사는 오지 않으므로(서버가 닫는다) 쥐지 않으면 재접속 전까지 내릴 길이 없다.
  const release = (executorId: string, line: Line, connection: number): void => {
    line.applied = connection;
    if (line.retry !== null || line.items.some((item) => item.kind === "hello")) return;
    let current = false;
    try {
      current = ports.wire.answers.current(connection, executorId) === true;
    } catch {
      current = false;
    }
    if (!current) return;
    line.withhold = false;
    line.applied = null;
  };

  const takeHello = (executorId: string, line: Line, outcome: HelloAnswerOutcome): void => {
    note({ kind: "hello", executor: executorId, outcome });
    if (outcome.kind === "applied") {
      for (const loss of outcome.deferred) requery.add(loss.runId);
      release(executorId, line, outcome.connection);
    } else if (outcome.kind === "ledger_unsaved" || outcome.kind === "ledger_failed") {
      // input_rejected(retry 없음)는 다시 넘겨도 같으므로 버리고 맡기지 않음을 그대로 둔다.
      line.retry = outcome.retry;
      line.withhold = true;
    }
  };

  // 한 실행기의 줄을 막힐 때까지 넘긴다.
  const pumpLine = (executorId: string, line: Line): void => {
    if (!settled()) return;
    // 반영을 끝낸 인사의 해제 조건만 다시 본다. 그 인사를 장부에 다시 넘기지 않는다(C19).
    if (line.withhold && line.applied !== null) release(executorId, line, line.applied);
    let touched = false;
    for (;;) {
      // 처리기를 부를 때마다 복원 대기 신호를 다시 본다. 앞 처리의 기록(observe)이나 장부 쓰기가 같은 동기 구간에서 신호를 바꿀 수 있다.
      if (touched && !settled()) return;
      if (line.retry !== null) {
        const now = readNow();
        if (now === null) return;
        touched = true;
        const retry = line.retry;
        line.retry = null;
        takeHello(executorId, line, retryHelloAnswer(retry, now, { ledger: ports.ledger }));
        if (line.retry !== null) return;
        continue;
      }
      const head = line.items[0];
      if (head === undefined) {
        // 새 답 없는 다시 넘기기는 이번 처리에서 아무 답도 넘기지 않았을 때만 한다(방금 남은 사본을 곧바로 되풀이하지 않는다).
        const now = touched ? null : readNow();
        if (now !== null) replay(executorId, line, now);
        return;
      }
      touched = true;
      const now = readNow();
      if (now === null) return;
      if (head.kind === "hello") {
        // 밀린 사본이 남아 있는 동안 그 실행기의 full을 먼저 넘기지 않는다(receipts.md "한 실행기의 답은 받은 순서대로").
        if (!replay(executorId, line, now)) return;
        if (!settled()) return;
        let table: HelloConnectionTable;
        let intake: Pick<Restorer, "stopGeneration" | "intakeOpen">;
        try {
          table = ports.table();
          intake = ports.restorer();
        } catch {
          // 연결 표나 복원기를 읽지 못하면 버리지 않고 쥔다(모름을 "연결 없음"으로 읽지 않는다).
          return;
        }
        const outcome = passHelloAnswer({ output: head.output, table, now }, { ledger: ports.ledger, intake });
        if (outcome.kind === "held") {
          line.withhold = true;
          return;
        }
        line.items.shift();
        takeHello(executorId, line, outcome);
        // 실패한 인사는 다음 pump에서 다시 넘긴다(같은 처리 안에서 곧바로 되풀이하지 않는다).
        if (line.retry !== null) return;
        continue;
      }
      // 등록부를 줄에서 빼기 전에 읽는다: 읽기가 던지면 답은 줄 맨 앞에 남는다.
      const asked = askedNow(head);
      line.items.shift();
      const forward = head.forward;
      const outcome = handleForward(
        { forward, now, stopGeneration: stopGeneration(), pendingQueries: asked, links: ports.wire.answers, backlog: line.backlog },
        { ledger: ports.ledger, random: ports.random, results: ports.results },
      );
      // 줄의 상태를 먼저 옮긴다. 기록이나 등록 마감이 던져도 반영한 사본을 다시 넘기거나 받은 답을 잃지 않는다.
      if (outcome.outcome === "status_matched") {
        takeSettlements(outcome.settled);
        line.backlog = keepCopies(outcome.backlog);
      } else if (outcome.outcome === "status_not_current") {
        markRequery(outcome.answer.runs);
        // "안다"는 항목이 있으면 버리지 않고 그 실행기의 밀린 목록 끝에 둔다(receipts.md "뒤 조각이 지킬 것").
        if (outcome.answer.runs.some(isPositive)) line.backlog = Object.freeze([...line.backlog, keepCopy(outcome.answer)]);
      }
      note({ kind: "status", executor: executorId, connection: forward.connection, outcome });
      // 대조에 성공한 답(matched·not_current)만 그 항목 하나를 끝낸다. 처리기는 답이 온 연결의 첫 항목과 맞추므로 같은 항목을 고른다.
      // 맞지 않은 답(unknown_query·runs_mismatch 등)은 항목을 남긴다: 같은 조회의 올바른 답이 뒤에 올 수 있다.
      if (outcome.outcome === "status_matched" || outcome.outcome === "status_not_current") {
        const entry = asked.find((query) => query.connection === forward.connection);
        if (entry !== undefined) unsettled.add(entry);
        settleQueries();
      }
    }
  };

  // 비고 맡기지 않음도 내린 줄은 지운다(실행기 수만큼만 남게).
  const prune = (executorId: string, line: Line): void => {
    if (line.items.length === 0 && line.retry === null && line.backlog.length === 0 && !line.withhold) lines.delete(executorId);
  };

  const drain = (executorIds: Iterable<string>): void => {
    for (const executorId of executorIds) dirty.add(executorId);
    if (draining) return;
    draining = true;
    try {
      while (dirty.size > 0) {
        const executorId = dirty.values().next().value as string;
        dirty.delete(executorId);
        const line = lines.get(executorId);
        if (line === undefined) continue;
        pumpLine(executorId, line);
        prune(executorId, line);
      }
    } catch {
      faulted = true;
      dirty.clear();
      note({ kind: "fault", where: "drain" });
    } finally {
      draining = false;
    }
  };

  // 받은 때 등록돼 있던 같은 요청 ID의 항목. 읽지 못하면 답은 버리지 않고 null로 줄에 세우되, 줄의 상태를 다 안다고 하지 않는다
  // (그 답은 넘길 때의 항목으로 대조하므로 받은 뒤 더한 항목과 맞을 수 있다).
  const askedAt = (forward: Extract<Delivered, { kind: "forward" }>): readonly SentQuery[] | null => {
    const wanted = inReplyTo(forward);
    try {
      return ports.queries.pending().filter((entry) => isRecord(entry) && entry.requestId === wanted);
    } catch {
      faulted = true;
      note({ kind: "fault", where: "deliver" });
      return null;
    }
  };

  const take = (output: Delivered): string | null => {
    switch (output.kind) {
      case "candidate": {
        const principal = output.candidate.principal;
        if (principal.kind === "worker_executor") ports.cycle.noteCandidate(executorName(principal.role, principal.instance, principal.storage));
        return null;
      }
      case "withdrawn": {
        // 철회 전에 받아 줄에 선 그 연결의 답이 쓸 항목은 남긴다. 지우면 받을 때 유효했던 답이 unknown_query로 버려져
        // 그 답의 "안다"는 관측이 밀린 목록에도 남지 않는다. 답 하나에 항목 하나를 받은 차례로 맞춘다(넘길 때도 앞 항목부터 쓴다).
        const live = ports.queries.pending();
        const keep = new Set<SentQuery>();
        for (const line of lines.values()) {
          for (const item of line.items) {
            if (item.kind !== "status" || item.forward.connection !== output.connection) continue;
            const wanted = inReplyTo(item.forward);
            const known = item.asked === null ? null : new Set(item.asked);
            const entry = live.find(
              (query) => query.requestId === wanted && query.connection === output.connection && !keep.has(query) && !unsettled.has(query) && (known === null || known.has(query)),
            );
            if (entry !== undefined) keep.add(entry);
          }
        }
        ports.queries.dropConnection(output.connection, keep);
        return null;
      }
      case "occupancy": {
        // partial은 상태 보고의 점유 행이다. 같은 답이 forward로도 오므로 여기서는 세지 않는다.
        if (output.answer.coverage !== "full") return null;
        const executorId = output.answer.executorId;
        if (!isText(executorId)) return null;
        const line = lineOf(executorId);
        line.items.push({ kind: "hello", output });
        line.withhold = true;
        return executorId;
      }
      case "forward": {
        const verified: unknown = output.verified;
        const header = isRecord(verified) ? verified.header : undefined;
        const sender = isRecord(header) ? header.sender : undefined;
        if (isRecord(verified) && verified.action === "status_report" && isText(sender)) {
          lineOf(sender).items.push({ kind: "status", forward: output, asked: askedAt(output) });
          return sender;
        }
        passReceipt(output);
        return null;
      }
    }
  };

  return {
    deliver(output: Delivered): void {
      try {
        const executorId = take(output);
        if (executorId !== null) drain([executorId]);
      } catch {
        faulted = true;
        note({ kind: "fault", where: "deliver" });
      }
    },
    pump(): void {
      try {
        settleQueries();
        drain([...lines.keys()]);
      } catch {
        faulted = true;
        note({ kind: "fault", where: "drain" });
      }
    },
    withheld: {
      executors() {
        if (faulted) return { known: false };
        const names = [...lines].filter(([, line]) => line.withhold).map(([name]) => name);
        return { known: true, value: names.sort() };
      },
    },
    backlog(executorId: string): readonly ExecutorAnswerCopy[] {
      return [...(lines.get(executorId)?.backlog ?? [])];
    },
    takeRequery(): readonly string[] {
      const runIds = [...requery];
      requery.clear();
      return runIds;
    },
  };
}
