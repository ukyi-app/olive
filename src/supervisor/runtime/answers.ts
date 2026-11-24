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
//    받은 때 등록부를 읽지 못한 답은 어느 항목과도 대조하지 않고 그 실행을 다시 묻는다.
//    처리기가 쓸 항목은 답을 줄에서 빼는 순간 사용 중으로 두어, 처리 도중 들어온 철회가 그 항목을 줄에 남은 다른 답에 주지 않는다.
//    철회된 연결은 줄에 선 그 연결의 답이 다 처리될 때까지 정리할 목록에 남아, 답이 쓰지 않은 항목을 끝낸다.
// 4. deliver는 던지지 않는다. 처리기와 장부를 부르는 흐름에 기다림이 없다(모두 한 동기 구간).
// 5. 맡기지 않을 실행기 집합은 인사가 줄에 들어온 때부터 그 실행기의 현재 연결 인사가 반영될 때까지 그 실행기를 싣는다.
//    반영한 뒤 연결 확인이 한 번 실패하면 반영한 연결 번호를 쥐고 다음 처리에서 해제 조건만 다시 본다(인사를 다시 넘기지 않는다).
//    뜻밖의 예외로 줄의 상태를 모르게 되면 집합을 known: false로 낸다(빈 목록으로 대신하지 않는다).
// 6. 줄이 쥐는 밀린 사본은 동결한 독립 값이다. 기록기에 넘긴 결과나 backlog()로 내보낸 값을 고쳐도 다시 넘길 내용은 그대로다.
// 7. D-90 닫기 박자의 증거(evidence)는 줄의 한 시점을 데이터 칸만으로 낸다. 줄의 칸(답·retry·밀린 사본·처리 중·맡기지 않음)이나
//    마지막 반영 인사·오염이 바뀌는 자리마다 그 실행기의 변경 번호를 올리고, 그 일에 외부 코드를 부르지 않는다(answers.md "D-90 증거").
//    실행기에서 온 입력은 주체를 안 직후, 첫 외부 호출보다 먼저 대기로 세운다. 영수증·보고는 장부 저장이 확인되지 않으면 오염으로 남긴다.
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
  type ForwardInput,
  handleForward,
  type ReceiptLedger,
  type ReceiptOutcome,
  replayBacklog,
  type ResultPorts,
  type SentQuery,
} from "../dispatch/receipts.ts";
import type { UnreceivedConfirm, UnreceivedEvidence, UnreceivedEvidenceRead, UnreceivedFull } from "../dispatch/unreceived.ts";
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
  // 자격 값 보내기의 두 문. 조립(issuance.ts의 createIssuance)이 같은 서버·장부·시계로 만든 송신기를 감싸 넘긴다. 빠지면 값을 보내지 않는다
  // (실행기는 그 시작을 띄우지 못하고 실행기 쪽 기한으로 실패한다).
  readonly credentials?: AnswerCredentials;
  // D-90 증거의 장부(createAnswerEvidenceBook). 서버를 새로 만들어 답 줄을 다시 만들 때 같은 값을 넘겨야 변경 번호가 이어지고
  // 앞 줄이 쥔 채 버린 답이 오염으로 남는다. 빠지면 이 답 줄만 쓰는 장부를 새로 만든다.
  readonly evidenceBook?: AnswerEvidenceBook;
}

// 실행기마다 변경 번호·오염·마지막 반영 인사를 쥐는 장부. 프로세스에 하나를 만들어 그 프로세스의 답 줄마다 넘긴다.
// 칸이 없는 표지다: 상태는 이 모듈만 읽고 쓴다(밖에서 오염을 풀거나 번호를 되돌리는 길을 두지 않는다).
export interface AnswerEvidenceBook {
  readonly kind: "answer_evidence_book";
}

// 마지막 반영 인사. 그 인사의 원래 occupancy(full) 출력에서 넘기기 직전에 옮긴 동결한 값이다.
type StoredFull = Readonly<Omit<UnreceivedFull, "receivedAt">>;

interface EvidenceEntry {
  version: number;
  tainted: boolean;
  lastFull: UnreceivedFull | null;
}

interface BookState {
  // 모든 변화가 하나씩 올리는 번호. 실행기의 번호는 이 값을 받으므로 실행기마다 줄지도 다시 쓰이지도 않는다.
  counter: number;
  // 모든 실행기에 걸친 변화(고장, 답 줄 교체)를 받은 번호. 실행기의 번호는 자기 번호와 이 값 중 큰 쪽이다.
  floor: number;
  // 답 줄이 고장 난 적이 있다. 무엇을 잃었는지 모르므로 이 장부의 모든 실행기가 오염이다.
  allTainted: boolean;
  // 번호가 안전 정수의 상한에 닿았다. 그 뒤로는 바뀐 것을 번호로 가르지 못하므로 이 장부가 사는 동안 증거는 모름이다.
  exhausted: boolean;
  readonly entries: Map<string, EvidenceEntry>;
  // 지금 이 장부에 증거를 내는 답 줄(마지막에 만든 것)과, 그 줄이 쥔 답이 있는 실행기를 세는 함수.
  owner: object | null;
  pendingOf: (() => readonly string[]) | null;
}

const books = new WeakMap<AnswerEvidenceBook, BookState>();

const newBookState = (first = 0): BookState => ({ counter: first, floor: first, allTainted: false, exhausted: false, entries: new Map(), owner: null, pendingOf: null });

export interface AnswerEvidenceBookOptions {
  // 번호의 시작값(0 이상 안전 정수). 기본 0. 상한 근처의 동작을 시험으로 보려고 둔다.
  readonly firstVersion?: number;
}

export function createAnswerEvidenceBook(options: AnswerEvidenceBookOptions = {}): AnswerEvidenceBook {
  const first = options.firstVersion ?? 0;
  if (!Number.isSafeInteger(first) || first < 0) throw new RangeError("firstVersion은 0 이상 안전 정수여야 한다");
  const book: AnswerEvidenceBook = Object.freeze({ kind: "answer_evidence_book" });
  books.set(book, newBookState(first));
  return book;
}

const versionOf = (state: BookState, executorId: string): number => Math.max(state.entries.get(executorId)?.version ?? 0, state.floor);

// 번호를 하나 올린 값. 상한(Number.MAX_SAFE_INTEGER)을 넘길 수 없으면 올리지 않고 장부를 모름으로 둔다: 상한 위에서는 1을 더해도
// 같은 값이 나와 읽은 뒤의 변화를 confirm이 놓친다.
function bump(state: BookState): number {
  if (state.counter >= Number.MAX_SAFE_INTEGER) state.exhausted = true;
  else state.counter += 1;
  return state.counter;
}

function entryOf(state: BookState, executorId: string): EvidenceEntry {
  let entry = state.entries.get(executorId);
  if (entry === undefined) {
    entry = { version: 0, tainted: false, lastFull: null };
    state.entries.set(executorId, entry);
  }
  return entry;
}

// 답 줄이 자격 값 보내기에 넘기는 것. onReceipt는 기다리지 않고 돌려준 것을 보지 않는다(이 파일은 동기다). 둘 다 던지지 않게 감싸 넘긴다.
export interface AnswerCredentials {
  // 장부가 받은 영수증(ack·applied_without_ack)마다 handleForward에 넘긴 그 forward와 그 결과를 그대로 넘긴다.
  onReceipt(forward: ForwardInput["forward"], outcome: ReceiptOutcome): void;
  // 연결이 철회됐다(서버가 연결을 닫은 때도 withdrawn이 온다).
  forgetConnection(connection: number): void;
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
  // D-90 닫기 박자(unreceived.ts)의 증거 포트. read·confirm 모두 읽기만 하고 줄을 넘기거나 버리지 않는다.
  readonly evidence: UnreceivedEvidence;
}

type StatusItem = {
  readonly kind: "status";
  readonly forward: Extract<Delivered, { kind: "forward" }>;
  // 받은 때 등록돼 있던 같은 요청 ID의 항목(등록부가 쥔 그 객체). 받은 뒤 더한 항목은 이 답의 조회가 아니다: 같은 키로 나중에 실은
  // 조회와 맞추면 그 조회의 진짜 답이 unknown_query로 버려진다. 받은 때 등록부를 읽지 못했으면 null이고 어느 항목과도 대조하지 않는다.
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
  // 줄에서 빼 처리기에 넘기는 중인 답(상태 보고, 인사의 retry)의 수. 그 처리기의 장부 쓰기 안에서 증거를 읽으면 그 답은 줄에 없지만
  // 아직 반영 전이라 대기(pending)로 낸다.
  inflight: number;
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

// 줄에 선 상태 보고가 이 항목과 대조될 수 있는가. 처리기(receipts.ts의 matchStatus)와 같은 비교다: 받는 쪽이 낸 쪽이고, runs가 배열이며
// 모든 원소에 실행 ID가 있고, 물은 실행 집합과 답한 실행 집합이 같다. 꼴이 틀리면 처리기도 대조하지 않으므로 거짓이다.
function couldMatch(query: SentQuery, sender: string, forward: Extract<Delivered, { kind: "forward" }>): boolean {
  try {
    if (query.recipient !== sender) return false;
    const verified: unknown = forward.verified;
    const body = isRecord(verified) ? verified.body : undefined;
    const runs = isRecord(body) ? body.runs : undefined;
    if (!Array.isArray(runs) || runs.some((run: unknown) => !isRecord(run) || !isText(run.run_id))) return false;
    const asked = new Set(Array.isArray(query.runIds) ? query.runIds : []);
    const answered = new Set(runs.map((run: { run_id: string }) => run.run_id));
    return asked.size === answered.size && [...answered].every((runId) => asked.has(runId));
  } catch {
    return false;
  }
}

// 버린 답이 양성 관측("안다")을 실었을 수 있는가. 목록을 읽지 못했으면(null) 실었을 수 있는 것이다. not_known만 실은 답(빈 인사 포함)을
// 버리는 것은 잃는 양성 관측이 없어 오염이 아니다.
const mayBePositive = (runs: readonly RunStatus[] | null): boolean => runs === null || runs.some(isPositive);

// 상태 보고가 실은 목록의 사본. 꼴이 틀리면 null(양성일 수 있는 것으로 센다).
function statusRuns(forward: Extract<Delivered, { kind: "forward" }>): RunStatus[] | null {
  try {
    const verified: unknown = forward.verified;
    const body = isRecord(verified) ? verified.body : undefined;
    const runs = isRecord(body) ? body.runs : undefined;
    if (!Array.isArray(runs)) return null;
    const out: RunStatus[] = [];
    for (const item of runs as unknown[]) {
      if (!isRecord(item)) return null;
      out.push({ run_id: item.run_id, state: item.state, run_generation: item.run_generation, last_receipt_id: item.last_receipt_id } as RunStatus);
    }
    return out;
  } catch {
    return null;
  }
}

// 인사 출력의 전체 목록을 동결한 사본으로 옮긴다. 꼴이 틀리면 null(버릴 때 양성일 수 있는 것으로 센다).
function outputRuns(output: Extract<Delivered, { kind: "occupancy" }>): readonly RunStatus[] | null {
  try {
    const answer: unknown = output.answer;
    const runs = isRecord(answer) ? answer.runs : undefined;
    if (!Array.isArray(runs)) return null;
    const copied: RunStatus[] = [];
    for (const item of runs as unknown[]) {
      if (!isRecord(item)) return null;
      copied.push(Object.freeze({ run_id: item.run_id, state: item.state, run_generation: item.run_generation, last_receipt_id: item.last_receipt_id }) as RunStatus);
    }
    return Object.freeze(copied);
  } catch {
    return null;
  }
}

// 인사를 넘기기 직전에 그 원래 occupancy(full) 출력에서 증거의 묶음을 옮긴다. 맞춘 세대는 출력에 없어 그 연결 표의 같은 연결이
// 맞춘 세대(sync.generation)로 채운다: 인사 처리기가 반영 전에 지금 세대와 같은지 보는 그 값이다. 읽지 못하면 null이고, 그 인사가
// 반영돼도 마지막 반영 인사는 모름(null)이 된다(닫지 않는 쪽).
function fullOf(output: Extract<Delivered, { kind: "occupancy" }>, runs: readonly RunStatus[] | null, table: HelloConnectionTable): StoredFull | null {
  if (runs === null) return null;
  try {
    const connection: unknown = output.connection;
    const issuedAt: unknown = output.issuedAt;
    const answer: unknown = output.answer;
    const principal = isRecord(answer) ? answer.executorId : undefined;
    if (!Number.isSafeInteger(connection) || (connection as number) < 1 || !isText(principal) || !Number.isSafeInteger(issuedAt) || (issuedAt as number) < 1) return null;
    const sync: unknown = table.get(connection as number)?.sync;
    const generation: unknown = isRecord(sync) ? sync.generation : undefined;
    if (!Number.isSafeInteger(generation) || (generation as number) < 0) return null;
    return Object.freeze({ connection: connection as number, principal, stopGeneration: generation as number, runs, answeredAt: issuedAt as number });
  } catch {
    return null;
  }
}

// 상태 보고가 실은 실행 ID. 꼴이 틀린 항목은 건너뛴다.
function runIdsOf(forward: Extract<Delivered, { kind: "forward" }>): string[] {
  try {
    const verified: unknown = forward.verified;
    const body = isRecord(verified) ? verified.body : undefined;
    const runs = isRecord(body) ? body.runs : undefined;
    return Array.isArray(runs) ? runs.flatMap((run: unknown) => (isRecord(run) && isText(run.run_id) ? [run.run_id] : [])) : [];
  } catch {
    return [];
  }
}

export function createAnswerLines(ports: AnswerLinePorts): AnswerLines {
  const lines = new Map<string, Line>();
  const requery = new Set<string>();
  // 처리하는 동안 다시 들어온 실행기. 바깥 처리가 이어서 돈다(같은 줄을 겹쳐 돌리지 않는다).
  const dirty = new Set<string>();
  // 대조에 성공한 답이 쓴 등록 항목 중 등록부의 settle이 던져 아직 끝내지 못한 것. 처리마다 다시 끝내 보고, 그동안 어느 답과도 대조하지 않는다.
  const unsettled = new Set<SentQuery>();
  // 줄에서 뺀 답을 처리기에 넘기는 동안 그 답이 쓸 항목. 그 사이(장부 쓰기 안) 들어온 철회는 이 항목을 남기고 줄에 남은 답에 주지 않는다.
  const claimed = new Set<SentQuery>();
  // 철회됐지만 등록 정리를 마치지 못한 연결. 줄에 선 그 연결의 답이 쓸 항목을 남겼거나 정리 중 등록부가 던졌다.
  const withdrawnLinks = new Set<number>();
  let draining = false;
  let faulted = false;
  // 만들지 않은 표지를 받으면 장부가 없다(null): 증거는 늘 모름이다. 이어 갈 번호와 오염을 모르는 채 새로 세지 않는다.
  const book: BookState | null = ports.evidenceBook === undefined ? newBookState() : (books.get(ports.evidenceBook) ?? null);
  const self = {};
  // 받아서 줄에 넣거나 처리기에 넘기는 중인 실행기의 입력(상태 보고는 줄에 넣을 때까지, 영수증·보고는 처리기가 돌아올 때까지)의
  // 주체와 그 수. 그 사이의 외부 호출(등록부, 시계, 처리기·장부·보관소) 안에서 증거를 읽으면 그 입력은 줄에도 장부에도 없으므로 대기로 낸다.
  const receiving = new Map<string, number>();
  // 줄에서 넘기지 않은 답(줄의 답, retry, 밀린 사본, 처리 중)이 있는가.
  const holding = (line: Line): boolean => line.items.length > 0 || line.retry !== null || line.backlog.length > 0 || line.inflight > 0;
  // 그 실행기에 아직 반영하지 않은 입력이 있는가(줄이 쥔 답, 받는 중인 입력).
  const pendingFor = (executorId: string): boolean => {
    const line = lines.get(executorId);
    return (line !== undefined && holding(line)) || receiving.has(executorId);
  };
  if (book !== null) {
    // 앞 답 줄(서버를 새로 만들기 전)이 쥔 답은 새 줄로 옮기지 않으므로 반영되지 않고 버린 것이다. 앞 서버의 연결 번호는 새 서버에서
    // 다시 쓰이므로 마지막 반영 인사도 모두 지운다(옛 번호가 새 연결과 같은 번호로 확인되지 않게).
    if (book.owner !== null && book.pendingOf !== null) {
      for (const executorId of book.pendingOf()) entryOf(book, executorId).tainted = true;
      for (const entry of book.entries.values()) entry.lastFull = null;
      book.floor = bump(book);
    }
    book.owner = self;
    book.pendingOf = () => [...new Set([...lines.keys(), ...receiving.keys()])].filter(pendingFor);
  }
  const owns = (): boolean => book !== null && book.owner === self;

  // 그 실행기의 증거가 바뀌었다(줄의 칸, 받는 중인 입력, 마지막 반영 인사, 오염). 번호를 올린다. 외부 코드를 부르지 않는다.
  // 바뀐 뒤의 답 줄이 아니면(앞 서버의 줄이 아직 불림) 그 변화는 지금 증거에 들지 않으므로 오염으로 남긴다.
  const changed = (executorId: string): void => {
    if (book === null) return;
    const entry = entryOf(book, executorId);
    if (!owns()) entry.tainted = true;
    entry.version = bump(book);
  };

  // 실행기의 입력을 받기 시작했다. 주체를 안 직후, 그 입력의 첫 외부 호출보다 먼저 부른다.
  const hold = (executorId: string): void => {
    receiving.set(executorId, (receiving.get(executorId) ?? 0) + 1);
    changed(executorId);
  };
  // 받는 중 표시를 거둔다. 번호는 부르는 쪽이 올린다(그 입력이 남긴 것을 먼저 적은 뒤).
  const unhold = (executorId: string): void => {
    const left = (receiving.get(executorId) ?? 1) - 1;
    if (left > 0) receiving.set(executorId, left);
    else receiving.delete(executorId);
  };

  // 답을 반영하지 않고 버렸다. 양성 관측을 실었을 수 있으면 그 실행기를 오염으로 둔다.
  const discarded = (executorId: string, runs: readonly RunStatus[] | null): void => {
    if (book !== null && mayBePositive(runs)) entryOf(book, executorId).tainted = true;
    changed(executorId);
  };

  // 인사가 반영됐다. 넘기기 직전에 옮긴 묶음이 처리기 결과의 연결·주체·서명 시각과 같을 때만 마지막 반영 인사로 둔다.
  // 다르거나 옮기지 못했으면 모름(null)이다. 받은 시각은 그 인사를 넘긴(반영된) 때의 장부 시계다. 앞 서버의 줄은 쓰지 않는다.
  const appliedFull = (executorId: string, outcome: Extract<HelloAnswerOutcome, { kind: "applied" }>, full: StoredFull | null, now: number): void => {
    if (book !== null && owns()) {
      const same = full !== null && full.connection === outcome.connection && full.principal === outcome.executorId && full.answeredAt === outcome.answeredAt;
      entryOf(book, executorId).lastFull = same ? Object.freeze({ ...full, receivedAt: now }) : null;
    }
    changed(executorId);
  };

  // 줄의 상태를 모르게 됐다. 무엇을 잃었는지 모르므로 이 장부의 모든 실행기를 오염으로 두고 모든 번호를 올린다.
  const markFaulted = (): void => {
    faulted = true;
    if (book === null) return;
    book.allTainted = true;
    book.floor = bump(book);
  };

  // 실패한 인사의 원본 retry → 그 인사를 처음 넘길 때 옮긴 묶음. retry가 반영되면 이 묶음이 마지막 반영 인사다(옛 연결 번호 그대로).
  const retryFulls = new WeakMap<HelloRetry, StoredFull | null>();

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
      line = { items: [], retry: null, backlog: [], withhold: false, applied: null, inflight: 0 };
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
  // sender는 머리의 낸 쪽이다(연결 판단이 그 연결의 주체와 같을 때만 forward를 낸다). 읽지 못했으면 null.
  const passReceipt = (forward: Extract<Delivered, { kind: "forward" }>, sender: string | null): void => {
    // 첫 외부 호출(시계) 전에 처리 중으로 세운다. 장부에 닿기 전에 실패하면(시계·보관소가 던짐, 장부 실패) 그 영수증은 장부의 전달 행에도
    // 줄에도 없어, 다시 오기 전의 빈 full 하나로 그 실행이 닫힌다. 그래서 장부가 받았다는 결과(ack·applied_without_ack)가 아니면
    // 그 주체를 오염으로 남긴다(거절·모름·던짐 모두). 오염과 해제는 처리기가 돌아오거나 던진 그 자리에서, 송신기·기록기보다 먼저 한다.
    if (sender !== null) hold(sender);
    let saved = false;
    let now = Number.NaN;
    let outcome: ReceiptOutcome;
    try {
      now = readNow() ?? Number.NaN;
      outcome = handleForward(
        { forward, now, stopGeneration: stopGeneration(), pendingQueries: [], links: ports.wire.answers, backlog: [] },
        { ledger: ports.ledger, random: ports.random, results: ports.results },
      );
      saved = outcome.outcome === "ack" || outcome.outcome === "applied_without_ack";
    } finally {
      if (sender !== null) {
        unhold(sender);
        if (!saved && book !== null) entryOf(book, sender).tainted = true;
        changed(sender);
      } else if (!saved && book !== null) {
        // 누구의 영수증인지 모르므로 모든 실행기를 오염으로 둔다(진짜 서버의 forward는 늘 낸 쪽을 싣는다).
        book.allTainted = true;
        book.floor = bump(book);
      }
    }
    // 기록보다 먼저 넘긴다: 송신기는 결과의 칸을 부른 그 자리에서 읽으므로 기록기가 결과를 고쳐도 보낼 대상이 바뀌지 않는다. 장부가 받아들인
    // 영수증(new·duplicate)마다 넘기고, 계정 읽기·값 틀 송신을 (연결, 실행)마다 각각 최대 1회로 막는 것은 송신기다. 받지 않은 영수증은 넘기지 않는다.
    if (outcome.outcome === "ack" || outcome.outcome === "applied_without_ack") {
      try {
        ports.credentials?.onReceipt(forward, outcome);
      } catch {
        // 감싼 송신기는 던지지 않는다. 던져도 ack와 줄은 그대로다.
      }
    }
    note({ kind: "receipt", connection: forward.connection, outcome });
    if (outcome.outcome === "ack") writeAck(forward.connection, outcome.ack, now);
  };

  // 밀린 사본만 다시 넘긴다. 남은 사본이 있으면 false. 줄의 상태를 먼저 옮기고 기록한다(기록기가 결과를 고쳐도 쥔 사본은 그대로다).
  const replay = (executorId: string, line: Line, now: number): boolean => {
    if (line.backlog.length === 0) return true;
    const outcome = replayBacklog({ backlog: line.backlog, now, links: ports.wire.answers }, { ledger: ports.ledger });
    if (outcome.outcome === "backlog_settled") {
      takeSettlements(outcome.settled);
      // 처리기는 양성 사본을 반영하지 못하면 돌려주므로(receipts.ts의 settleInOrder) 여기서 빠지는 사본은 반영됐거나 not_known만 실었다.
      line.backlog = keepCopies(outcome.backlog);
    }
    changed(executorId);
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

  // 지금 등록부의 항목 중 이 답과 대조할 것: 받은 때 있던 항목이고 아직 끝내지 않았고 처리 중인 답이 쓰지 않는 것. 받은 때 등록부를
  // 읽지 못한 답은 어느 항목과도 대조하지 않는다(받은 뒤 같은 키로 등록한 조회를 끝낼 수 있다). 등록부가 던지면 그대로 던진다(줄은 바꾸기 전이다).
  const askedNow = (item: StatusItem): SentQuery[] => {
    if (item.asked === null) return [];
    const wanted = inReplyTo(item.forward);
    const known = new Set(item.asked);
    return ports.queries.pending().filter((entry) => isRecord(entry) && entry.requestId === wanted && known.has(entry) && !unsettled.has(entry) && !claimed.has(entry));
  };

  // 철회된 연결의 항목 중 남길 것은 처리 중인 답이 쓰는 항목과, 철회 전에 받아 줄에 선 그 연결의 답마다 그 답이 대조될 수 있는 항목 하나
  // (받은 차례로 앞 항목부터)다. 나머지를 끝낸다. 물은 실행과 맞지 않는 답에는 남기지 않는다: 그 답은 어느 항목도 끝내지 못하므로 남기면
  // 복원 대기 동안 쓸 데 없는 항목이 산다. 남길 것이 없으면 그 연결의 정리를 마친다. 등록부가 던지면 그대로 던진다(연결은 정리할 목록에 남는다).
  const reclaim = (connection: number): void => {
    const live = ports.queries.pending();
    const keep = new Set<SentQuery>();
    for (const entry of claimed) if (entry.connection === connection) keep.add(entry);
    for (const [executorId, line] of lines) {
      for (const item of line.items) {
        if (item.kind !== "status" || item.asked === null || item.forward.connection !== connection) continue;
        const wanted = inReplyTo(item.forward);
        const known = new Set(item.asked);
        const entry = live.find(
          (query) =>
            isRecord(query) &&
            query.requestId === wanted &&
            query.connection === connection &&
            known.has(query) &&
            !keep.has(query) &&
            !unsettled.has(query) &&
            !claimed.has(query) &&
            couldMatch(query, executorId, item.forward),
        );
        if (entry !== undefined) keep.add(entry);
      }
    }
    ports.queries.dropConnection(connection, keep);
    if (keep.size === 0) withdrawnLinks.delete(connection);
  };

  const tryReclaim = (connection: number): void => {
    try {
      reclaim(connection);
    } catch {
      // 연결은 정리할 목록에 남아 다음 pump에서 다시 정리한다.
      markFaulted();
      note({ kind: "fault", where: "drain" });
    }
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
    changed(executorId);
  };

  // full은 그 인사를 넘기기 직전에 원래 출력에서 옮긴 묶음(retry면 처음 넘길 때 옮긴 것), runs는 그 인사의 목록 사본(읽지 못했으면
  // null)이다. 증거와 줄의 상태(retry·맡기지 않음)를 먼저 옮기고 기록한다: 기록기 안에서 읽은 증거나 서버 교체 때의 pendingOf가
  // 줄에서 뺀 인사를 대기로 보지 못하면, 같은 번호에서 대기가 참→거짓→참으로 바뀐다.
  const takeHello = (executorId: string, line: Line, outcome: HelloAnswerOutcome, full: StoredFull | null, runs: readonly RunStatus[] | null, now: number): void => {
    if (outcome.kind === "applied") appliedFull(executorId, outcome, full, now);
    else if ((outcome.kind === "ledger_unsaved" || outcome.kind === "ledger_failed") && outcome.retry !== null) retryFulls.set(outcome.retry, full);
    // held는 이 함수에 오지 않는다. 나머지(not_current, refused, retry 없는 input_rejected)는 그 인사를 반영하지 않고 버린 것이다.
    else discarded(executorId, runs);
    if (outcome.kind === "ledger_unsaved" || outcome.kind === "ledger_failed") {
      // input_rejected(retry 없음)는 다시 넘겨도 같으므로 버리고 맡기지 않음을 그대로 둔다.
      line.retry = outcome.retry;
      line.withhold = true;
      changed(executorId);
    }
    note({ kind: "hello", executor: executorId, outcome });
    if (outcome.kind === "applied") {
      for (const loss of outcome.deferred) requery.add(loss.runId);
      release(executorId, line, outcome.connection);
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
        line.inflight += 1;
        changed(executorId);
        let outcome: HelloAnswerOutcome;
        try {
          outcome = retryHelloAnswer(retry, now, { ledger: ports.ledger });
        } finally {
          line.inflight -= 1;
        }
        // retry의 목록은 인사 처리기가 동결한 사본이다.
        takeHello(executorId, line, outcome, retryFulls.get(retry) ?? null, retry.runs, now);
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
        // 처리기가 읽기 직전에 같은 출력과 같은 표에서 옮긴다(반영되면 이 값이 마지막 반영 인사다). 처리기를 부르는 동안 인사는 줄 맨 앞에
        // 남아 있어 그 안에서 읽은 증거는 대기다.
        const runs = outputRuns(head.output);
        const full = fullOf(head.output, runs, table);
        const outcome = passHelloAnswer({ output: head.output, table, now }, { ledger: ports.ledger, intake });
        if (outcome.kind === "held") {
          line.withhold = true;
          changed(executorId);
          return;
        }
        line.items.shift();
        takeHello(executorId, line, outcome, full, runs, now);
        // 실패한 인사는 다음 pump에서 다시 넘긴다(같은 처리 안에서 곧바로 되풀이하지 않는다).
        if (line.retry !== null) return;
        continue;
      }
      // 등록부를 줄에서 빼기 전에 읽는다: 읽기가 던지면 답은 줄 맨 앞에 남는다.
      const asked = askedNow(head);
      const forward = head.forward;
      // 처리기가 고를 항목(답이 온 연결의 첫 항목)을 줄에서 빼는 그 순간 사용 중으로 둔다. 서버는 철회를 동기로 넘기므로 처리기의 장부
      // 쓰기 중에도 철회가 들어올 수 있고, 그때 이 항목이 줄에 남은 같은 조회의 답에 남겨지면 이 답이 그 항목을 끝내 뒤 답의 근거가 사라진다.
      const entry = asked.find((query) => query.connection === forward.connection);
      line.items.shift();
      if (entry !== undefined) claimed.add(entry);
      line.inflight += 1;
      changed(executorId);
      let outcome: ReceiptOutcome;
      try {
        outcome = handleForward(
          { forward, now, stopGeneration: stopGeneration(), pendingQueries: asked, links: ports.wire.answers, backlog: line.backlog },
          { ledger: ports.ledger, random: ports.random, results: ports.results },
        );
      } finally {
        if (entry !== undefined) claimed.delete(entry);
        line.inflight -= 1;
      }
      // 대조에 성공한 답(matched·not_current)만 그 항목 하나를 끝낸다. 처리기는 답이 온 연결의 첫 항목과 맞추므로 같은 항목이다. 기록보다
      // 먼저 끝낼 항목으로 옮긴다: 기록 중 들어온 철회도 이 항목을 남은 답에 주지 않는다.
      // 맞지 않은 답(unknown_query·runs_mismatch 등)은 항목을 남긴다: 같은 조회의 올바른 답이 뒤에 올 수 있다.
      const matched = outcome.outcome === "status_matched" || outcome.outcome === "status_not_current";
      if (matched && entry !== undefined) unsettled.add(entry);
      // 받은 때 등록을 입증하지 못한 답은 대조하지 않았으므로 그 관측을 같은 실행 ID로 다시 묻는다.
      if (head.asked === null) for (const runId of runIdsOf(forward)) requery.add(runId);
      // 줄의 상태를 먼저 옮긴다. 기록이나 등록 마감이 던져도 반영한 사본을 다시 넘기거나 받은 답을 잃지 않는다.
      if (outcome.outcome === "status_matched") {
        takeSettlements(outcome.settled);
        line.backlog = keepCopies(outcome.backlog);
      } else if (outcome.outcome === "status_not_current") {
        markRequery(outcome.answer.runs);
        // "안다"는 항목이 있으면 버리지 않고 그 실행기의 밀린 목록 끝에 둔다(receipts.md "뒤 조각이 지킬 것").
        if (outcome.answer.runs.some(isPositive)) line.backlog = Object.freeze([...line.backlog, keepCopy(outcome.answer)]);
      }
      // 대조한 답(matched·not_current)은 양성이면 반영됐거나 밀린 목록에 남는다. 그 밖의 결과(맞지 않음·꼴 거절)는 답을 버린 것이다.
      if (matched) changed(executorId);
      else discarded(executorId, statusRuns(forward));
      note({ kind: "status", executor: executorId, connection: forward.connection, outcome });
      if (matched) settleQueries();
      // 철회된 연결의 답이면 그 답이 쓰지 않은 항목(맞지 않은 답이 남긴 것 등)을 줄에 남은 답이 더 쓰지 않을 때 끝낸다.
      if (withdrawnLinks.has(forward.connection)) tryReclaim(forward.connection);
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
      // 정리를 마치지 못한 철회된 연결은 어느 실행기의 답을 처리하든 그 뒤에 다시 정리한다. 답이 온 연결만 다시 보면, 정리 중 등록부가
      // 던진 옛 연결의 항목은 그 실행기가 새 연결로 답해도 다음 pump()까지 남는다.
      for (const connection of [...withdrawnLinks]) tryReclaim(connection);
    } catch {
      markFaulted();
      dirty.clear();
      note({ kind: "fault", where: "drain" });
    } finally {
      draining = false;
    }
  };

  // 받은 때 등록돼 있던 같은 요청 ID의 항목. 읽지 못하면 null이다: 답은 버리지 않고 null로 줄에 세운다(차례를 지키고, 넘길 때 대조 없이
  // unknown_query로 끝내 그 실행을 다시 묻는다). 기록은 부르는 쪽이 답을 줄에 넣은 뒤에 한다.
  const askedAt = (forward: Extract<Delivered, { kind: "forward" }>): readonly SentQuery[] | null => {
    const wanted = inReplyTo(forward);
    try {
      return ports.queries.pending().filter((entry) => isRecord(entry) && entry.requestId === wanted);
    } catch {
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
        // 그 답의 "안다"는 관측이 밀린 목록에도 남지 않는다. 등록부를 읽기 전에 연결부터 적는다: 정리가 던져도 다음 pump에서 다시 한다.
        withdrawnLinks.add(output.connection);
        // 그 주체의 증거가 기댄 연결이 철회됐을 수 있다. confirm이 연결을 다시 보지만 번호도 올려 읽은 뒤의 철회를 줄의 변화로도 센다.
        if (isText(output.principal)) changed(output.principal);
        // 등록부 정리보다 먼저 한다: 정리가 던져도 그 연결의 자격 값 기억은 지운다.
        try {
          ports.credentials?.forgetConnection(output.connection);
        } catch {
          // 감싼 송신기는 던지지 않는다. 지우지 못해도 연결 번호는 다시 쓰이지 않아 정확성에는 영향이 없다.
        }
        reclaim(output.connection);
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
        changed(executorId);
        return executorId;
      }
      case "forward": {
        const verified: unknown = output.verified;
        const header = isRecord(verified) ? verified.header : undefined;
        const sender = isRecord(header) ? header.sender : undefined;
        if (isRecord(verified) && verified.action === "status_report" && isText(sender)) {
          // 첫 외부 호출(등록부 읽기) 전에 받는 중으로 세우고 줄에 넣을 때까지 둔다. 그 읽기 안에서 박자가 돌면 이 답은 아직 줄에 없다.
          // 답을 줄에 넣은 뒤에 기록한다. 기록기가 그 안에서 pump()를 부르면 빈 줄은 지워지므로, 넣기 전에 기록하면 답이 지워진 줄에 들어가
          // 넘겨지지도 다시 묻지도 않는다.
          hold(sender);
          let asked: readonly SentQuery[] | null;
          try {
            asked = askedAt(output);
            lineOf(sender).items.push({ kind: "status", forward: output, asked });
          } finally {
            unhold(sender);
          }
          changed(sender);
          if (asked === null) {
            // 뜻밖의 예외라 줄의 상태를 다 안다고 하지 않는다.
            markFaulted();
            note({ kind: "fault", where: "deliver" });
          }
          return sender;
        }
        passReceipt(output, isText(sender) ? sender : null);
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
        markFaulted();
        note({ kind: "fault", where: "deliver" });
      }
    },
    pump(): void {
      try {
        settleQueries();
        // 정리를 마치지 못한 철회된 연결은 drain의 끝에서 다시 정리한다(줄이 없어도 돈다).
        drain([...lines.keys()]);
      } catch {
        markFaulted();
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
    evidence: {
      // 한 시점의 값: 외부 코드를 부르지 않고 이 객체가 쥔 줄과 장부만 읽어 데이터 칸만 가진 새 객체로 낸다(목록도 새 배열·새 원소).
      // 고장 난 줄, 번호가 상한에 닿은 장부, 바뀐 뒤의 답 줄이 아님(앞 서버의 줄), 장부 없음은 모름이다.
      read(executorId: string): UnreceivedEvidenceRead {
        if (book === null || faulted || book.exhausted || !owns() || typeof executorId !== "string") return { known: false };
        const entry = book.entries.get(executorId);
        const full = entry?.lastFull ?? null;
        return {
          known: true,
          tainted: book.allTainted || entry?.tainted === true,
          pending: pendingFor(executorId),
          version: versionOf(book, executorId),
          lastFull:
            full === null
              ? null
              : {
                  connection: full.connection,
                  principal: full.principal,
                  stopGeneration: full.stopGeneration,
                  runs: full.runs.map((run) => ({ run_id: run.run_id, state: run.state, run_generation: run.run_generation, last_receipt_id: run.last_receipt_id }) as RunStatus),
                  answeredAt: full.answeredAt,
                  receivedAt: full.receivedAt,
                },
        };
      },
      // 장부 호출 직전의 마지막 확인. 연결(내보내기 포트의 answers) → 지금 게시된 복원기의 정지 세대 → 변경 번호 차례로 본다.
      // 앞의 두 조회는 외부 코드라 그 안에서 줄이 바뀔 수 있으므로 번호 비교와 고장·교체 확인을 마지막에 한다. 읽기만 한다.
      confirm(executorId: string, connection: number, version: number, stopGeneration: number): UnreceivedConfirm {
        let current = false;
        try {
          current = ports.wire.answers.current(connection, executorId) === true;
        } catch {
          current = false;
        }
        if (!current) return "link_not_current";
        let generation: unknown = null;
        try {
          generation = ports.restorer().stopGeneration();
        } catch {
          generation = null;
        }
        if (generation !== stopGeneration) return "stop_generation";
        if (book === null || faulted || book.exhausted || !owns() || versionOf(book, executorId) !== version) return "evidence_changed";
        return "current";
      },
    },
  };
}
