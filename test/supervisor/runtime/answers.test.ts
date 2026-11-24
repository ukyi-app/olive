// 답 줄(answers.ts)과 조회 등록부(query-book.ts)의 시험. 연결 표·장부·내보내기 포트는 가짜이고 처리기(receipts.ts, hello-answers.ts)는
// 실제 것이다. status_report의 검증된 봉투는 처리기가 읽는 칸만 갖춘 값으로 짓는다(서명 검증은 연결 판단의 몫이다).
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { type Envelope, type RunStatus, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import type { HelloConnectionTable } from "../../../src/supervisor/dispatch/hello-answers.ts";
import type { ReceiptLedger, SentQuery } from "../../../src/supervisor/dispatch/receipts.ts";
import { type AnswerLinePorts, type AnswerNote, createAnswerLines } from "../../../src/supervisor/runtime/answers.ts";
import { createQueryBook } from "../../../src/supervisor/runtime/query-book.ts";
import type { AckOutcome } from "../../../src/supervisor/runtime/sink.ts";
import type { Delivered } from "../../../src/supervisor/transport/server.ts";
import { readText } from "../../files.ts";

const NOW = 1_800_000_000_000;
const GEN = 3;
const R1 = "executor/diagnosis/0/store-a";
const R2 = "executor/diagnosis/1/store-b";
const RUN = "11111111-1111-4111-8111-111111111111";
const RUN2 = "22222222-2222-4222-8222-222222222222";
const supervisorKey = generateKeyPairSync("ed25519").privateKey;

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
const run = (runId: string, state: RunStatus["state"]): RunStatus => ({ run_id: runId, state, run_generation: state === "not_known" ? null : 1, last_receipt_id: null });

// 처리기가 읽는 칸만 갖춘 검증된 봉투.
function verified(sender: string, action: string, body: Record<string, unknown>, issuedAt = NOW) {
  return { ok: true, action, header: { sender, action, run_generation: action === "status_report" ? 0 : 1, body_digest: "d".repeat(64), issued_at: issuedAt }, body } as never;
}
const statusForward = (connection: number, sender: string, inReplyTo: string, runs: RunStatus[], issuedAt = NOW): Delivered => ({
  kind: "forward",
  connection,
  verified: verified(sender, "status_report", { in_reply_to: inReplyTo, runs }, issuedAt),
});
const helloOutput = (connection: number, executorId: string, runs: RunStatus[], issuedAt = NOW): Delivered => ({
  kind: "occupancy",
  connection,
  answer: { executorId, coverage: "full", runs },
  issuedAt,
});

// 연결 표 흉내. greet한 연결만 인사한 연결이고 그 실행기의 지금 인정된 연결이다(실행기마다 하나).
class FakeTable {
  readonly rows = new Map<number, { principal: string; issuedAt: number; runs: RunStatus[] }>();
  greet(connection: number, principal: string, runs: RunStatus[], issuedAt = NOW): void {
    for (const [id, row] of this.rows) if (row.principal === principal) this.rows.delete(id);
    this.rows.set(connection, { principal, issuedAt, runs });
  }
  close(connection: number): void {
    this.rows.delete(connection);
  }
  recognized(principal: string): number | null {
    for (const [id, row] of this.rows) if (row.principal === principal) return id;
    return null;
  }
  view(): HelloConnectionTable {
    const rows = new Map(this.rows);
    return {
      get: (id: number) => {
        const row = rows.get(id);
        if (row === undefined) return undefined;
        return { id, phase: "greeted", sync: { principal: row.principal, generation: GEN }, greeting: { issued_at: row.issuedAt, runs: row.runs } } as never;
      },
      candidates: () => [...rows.keys()].map((connection) => ({ connection })) as never,
    };
  }
}

type Call = { kind: "full" | "partial"; sender: string; states: string; answeredAt: number | null };

// sightings: 관측만 적는 연산(recordAnswerSightings)의 답. 기본은 적지 못함(ledger_unwritable)이다: 인정이 끝난 연결의 안다는 답을 적지
// 못했을 때의 동작(상태 보고는 밀린 사본으로 쥐고 인사는 오염으로 남긴다)을 그대로 본다. 적히는 경우는 시험마다 "saved"로 고른다.
function harness(options: { settled?: boolean; intake?: boolean; sightings?: "saved" | "unwritable" } = {}) {
  const table = new FakeTable();
  const calls: Call[] = [];
  const sights: Call[] = [];
  const answers: unknown[] = [];
  const receipts: unknown[] = [];
  const receiptAnswers: unknown[] = [];
  const acks: { connection: number; envelope: Envelope }[] = [];
  const notes: AnswerNote[] = [];
  const candidates: string[] = [];
  const state = { settled: options.settled ?? true, intake: options.intake ?? true };
  const ledger: ReceiptLedger = {
    applyReceipt(input) {
      receipts.push(input);
      const next = receiptAnswers.shift() ?? { ok: true, delivery: "new", ack: input.receiptId };
      return next as ReturnType<Ledger["applyReceipt"]>;
    },
    recordReport: () => {
      throw new Error("recordReport를 부르면 안 된다");
    },
    applyExecutorAnswer(input, from) {
      calls.push({ kind: input.coverage as Call["kind"], sender: from.sender, states: input.runs.map((r) => r.state).join(","), answeredAt: input.answeredAt });
      const next = answers.length > 0 ? answers.shift() : { ok: true, moved: [], deferred: [], outsideLedger: [] };
      if (next instanceof Error) throw next;
      return next as ReturnType<Ledger["applyExecutorAnswer"]>;
    },
    recordAnswerSightings(input, from) {
      sights.push({ kind: input.coverage as Call["kind"], sender: from.sender, states: input.runs.map((r) => r.state).join(","), answeredAt: input.answeredAt });
      if (options.sightings === "saved") return { ok: true };
      const unsavedSightings = input.runs.filter((r) => r.state !== "not_known").map((r) => ({ runId: r.run_id, runGeneration: r.run_generation as number }));
      return { ok: false, reason: "ledger_unwritable", unsavedSightings };
    },
  };
  const queries = createQueryBook();
  const published = { stopGeneration: () => GEN, intakeOpen: () => state.intake };
  const ports: AnswerLinePorts = {
    table: () => table.view(),
    restorer: () => published,
    ledger,
    results: {
      backend: {} as never,
      ledger: {
        getRun: () => ({ known: false }) as never,
        instructionTimes: () => ({ known: false }) as never,
        recordReport: () => {
          throw new Error("결과 보고를 부르면 안 된다");
        },
      },
    },
    random: { bytes: (length) => new Uint8Array(length).map((_, i) => (i * 7 + seq++) & 0xff) },
    signer: { seal: (input) => sealEnvelope(input, supervisorKey) },
    clock: { now: () => NOW + 1000 },
    wire: {
      answers: { current: (connection, executorId) => table.recognized(executorId) === connection },
      writeAck(connection, envelope): AckOutcome {
        acks.push({ connection, envelope });
        return "sent";
      },
    },
    queries,
    cycle: { noteCandidate: (name) => candidates.push(name) },
    observationsSettled: () => state.settled,
    observe: (n) => notes.push(n),
  };
  const lines = createAnswerLines(ports);
  // 조회를 그 연결에 등록한다(내보내기 포트가 쓰기 전에 하는 일).
  const ask = (connection: number, recipient: string, runIds: string[]): SentQuery => {
    const query = { requestId: uuid(), recipient, runIds, connection };
    queries.add(query);
    return query;
  };
  return { table, calls, sights, answers, receipts, receiptAnswers, acks, notes, candidates, state, ports, lines, queries, ask };
}

describe("차례(C18·C19·C16)", () => {
  test("한 실행기의 인사 → 상태 보고가 받은 차례로 장부에 가고, 반영된 full은 다시 넘기지 않는다", () => {
    const h = harness();
    h.table.greet(1, R1, [run(RUN, "preparing")]);
    h.lines.deliver(helloOutput(1, R1, [run(RUN, "preparing")]));
    const q = h.ask(1, R1, [RUN]);
    h.lines.deliver({ kind: "occupancy", connection: 1, answer: { executorId: R1, coverage: "partial", runs: [run(RUN, "running")] } });
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "running")], NOW + 5));
    h.lines.pump();
    h.lines.pump();
    // partial 점유 행은 세지 않는다: 상태 보고는 forward로 한 번만 장부에 닿는다.
    expect(h.calls).toEqual([
      { kind: "full", sender: R1, states: "preparing", answeredAt: NOW },
      { kind: "partial", sender: R1, states: "running", answeredAt: NOW + 5 },
    ]);
  });

  test("실패한 인사는 원본 retry로 먼저 다시 넘기고, 그동안 뒤 상태 보고를 장부에 넘기지 않는다", () => {
    const h = harness();
    h.table.greet(1, R1, [run(RUN, "running")]);
    h.answers.push(new Error("disk"), { ok: false, reason: "ledger_unwritable", unsavedSightings: [] });
    h.lines.deliver(helloOutput(1, R1, [run(RUN, "running")]));
    expect(h.calls.map((c) => c.kind)).toEqual(["full"]);
    const q = h.ask(1, R1, [RUN]);
    // 새 답이 오면 줄을 다시 돌린다: 붙든 인사를 먼저 다시 넘기고, 또 실패하면 상태 보고는 넘기지 않는다.
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "stopping")]));
    expect(h.calls.map((c) => c.kind)).toEqual(["full", "full"]);
    expect(h.lines.withheld.executors()).toEqual({ known: true, value: [R1] });
    h.lines.pump();
    expect(h.calls.map((c) => `${c.kind}:${c.states}`)).toEqual(["full:running", "full:running", "full:running", "partial:stopping"]);
    // 다시 넘긴 것이 처리기가 낸 retry였다(복제본이면 not_retry로 장부에 닿지 않는다).
    const hellos = h.notes.filter((n) => n.kind === "hello").map((n) => (n.kind === "hello" ? n.outcome.kind : ""));
    expect(hellos).toEqual(["ledger_failed", "ledger_unsaved", "applied"]);
    expect(h.lines.withheld.executors()).toEqual({ known: true, value: [] });
  });

  test("접수 대기(held)의 인사는 넘기는 순간의 가장 새 연결 표로 다시 넘긴다: 밀려난 연결의 인사는 버리고 새 연결의 인사만 장부에 간다", () => {
    const h = harness({ intake: false });
    h.table.greet(1, R1, [run(RUN, "running")]);
    h.lines.deliver(helloOutput(1, R1, [run(RUN, "running")]));
    expect(h.calls).toEqual([]);
    expect(h.lines.withheld.executors()).toEqual({ known: true, value: [R1] });
    h.table.greet(2, R1, [], NOW + 10);
    h.lines.deliver(helloOutput(2, R1, [], NOW + 10));
    h.state.intake = true;
    h.lines.pump();
    expect(h.calls).toEqual([{ kind: "full", sender: R1, states: "", answeredAt: NOW + 10 }]);
    expect(h.lines.withheld.executors()).toEqual({ known: true, value: [] });
  });
});

describe("복원이 붙든 관측이 먼저(C47·C48)", () => {
  test("observationsSettled가 거짓인 동안 인사·상태 보고·실패한 인사의 다시 넘기기·밀린 사본 모두 장부에 닿지 않는다", () => {
    const h = harness();
    h.table.greet(1, R1, [run(RUN, "running")]);
    h.answers.push(new Error("disk"));
    h.lines.deliver(helloOutput(1, R1, [run(RUN, "running")]));
    expect(h.calls.length).toBe(1);
    h.state.settled = false;
    const q = h.ask(1, R1, [RUN]);
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "running")]));
    h.table.greet(5, R2, [run(RUN2, "running")]);
    h.lines.deliver(helloOutput(5, R2, [run(RUN2, "running")]));
    h.lines.pump();
    h.lines.pump();
    expect(h.calls.length).toBe(1);
    // 줄에 들어온 인사의 실행기는 반영될 때까지 맡기지 않는다.
    expect(h.lines.withheld.executors()).toEqual({ known: true, value: [R1, R2] });
    h.state.settled = true;
    h.lines.pump();
    expect(h.calls.map((c) => `${c.kind}:${c.sender}`)).toEqual([`full:${R1}`, `full:${R1}`, `partial:${R1}`, `full:${R2}`]);
  });
});

describe("소비하는 때의 연결 대조와 밀린 목록(C21·C20·C23)", () => {
  test("받을 때 인정된 연결의 상태 보고도 넘기는 순간 연결이 바뀌었으면 장부에 넘기지 않고, 안다는 사본은 밀린 목록 끝에 둔다", () => {
    const h = harness({ settled: false });
    h.table.greet(1, R1, []);
    const q1 = h.ask(1, R1, [RUN]);
    h.lines.deliver(statusForward(1, R1, q1.requestId, [run(RUN, "running")], NOW + 1));
    // 같은 실행기가 새 연결로 맞추고 인사했다. 옛 연결의 답은 아직 줄에 있다.
    h.table.greet(2, R1, []);
    const q2 = h.ask(2, R1, [RUN]);
    h.lines.deliver(statusForward(2, R1, q2.requestId, [run(RUN, "not_known")], NOW + 2));
    h.state.settled = true;
    h.lines.pump();
    // 옛 연결의 답은 지금 연결의 답으로 적히지 않는다. 새 답은 막힌 사본 뒤에 줄 선다(앞 관측이 묻히지 않게).
    expect(h.calls).toEqual([]);
    expect(h.lines.backlog(R1).map((c) => [c.connection, c.answeredAt])).toEqual([
      [1, NOW + 1],
      [2, NOW + 2],
    ]);
    expect(h.lines.takeRequery()).toEqual([RUN]);
    expect(h.lines.takeRequery()).toEqual([]);
    // 대조한 조회 항목은 끝났다.
    expect(h.queries.pending()).toEqual([]);
  });

  test("인정이 끝난 연결의 안다는 답은 관측이 적히면 쥐지 않아, 새 연결의 인사와 답이 막히지 않는다(적지 못하면 위처럼 밀린 사본으로 막는다)", () => {
    const h = harness({ settled: false, sightings: "saved" });
    h.table.greet(1, R1, []);
    const q1 = h.ask(1, R1, [RUN]);
    h.lines.deliver(statusForward(1, R1, q1.requestId, [run(RUN, "running")], NOW + 1));
    h.table.greet(2, R1, [], NOW + 2);
    h.lines.deliver(helloOutput(2, R1, [], NOW + 2));
    const q2 = h.ask(2, R1, [RUN]);
    h.lines.deliver(statusForward(2, R1, q2.requestId, [run(RUN, "not_known")], NOW + 3));
    expect(h.lines.withheld.executors()).toEqual({ known: true, value: [R1] });
    h.state.settled = true;
    h.lines.pump();
    expect(h.sights).toEqual([{ kind: "partial", sender: R1, states: "running", answeredAt: NOW + 1 }]);
    expect(h.calls).toEqual([
      { kind: "full", sender: R1, states: "", answeredAt: NOW + 2 },
      { kind: "partial", sender: R1, states: "not_known", answeredAt: NOW + 3 },
    ]);
    expect(h.lines.backlog(R1)).toEqual([]);
    expect(h.lines.withheld.executors()).toEqual({ known: true, value: [] });
    expect(h.lines.takeRequery()).toEqual([RUN]);
    expect(h.queries.pending()).toEqual([]);
  });

  test("not_known만 실은 옛 연결의 답은 밀린 목록에 남기지 않는다", () => {
    const h = harness({ settled: false });
    h.table.greet(1, R1, []);
    const q1 = h.ask(1, R1, [RUN]);
    h.lines.deliver(statusForward(1, R1, q1.requestId, [run(RUN, "not_known")]));
    h.table.greet(2, R1, []);
    h.state.settled = true;
    h.lines.pump();
    expect(h.lines.backlog(R1)).toEqual([]);
  });

  test("저장되지 않은 답은 밀린 사본으로 쥐었다가 다음 상태 보고보다 먼저 넘긴다", () => {
    const h = harness();
    h.table.greet(1, R1, []);
    const q1 = h.ask(1, R1, [RUN]);
    h.answers.push(new Error("disk"));
    h.lines.deliver(statusForward(1, R1, q1.requestId, [run(RUN, "running")], NOW + 1));
    expect(h.lines.backlog(R1).length).toBe(1);
    const q2 = h.ask(1, R1, [RUN]);
    h.lines.deliver(statusForward(1, R1, q2.requestId, [run(RUN, "stopping")], NOW + 2));
    expect(h.calls.map((c) => `${c.states}@${c.answeredAt}`)).toEqual([`running@${NOW + 1}`, `running@${NOW + 1}`, `stopping@${NOW + 2}`]);
    expect(h.lines.backlog(R1)).toEqual([]);
  });

  test("장부가 보류한 실행은 다시 물을 실행으로 낸다", () => {
    const h = harness();
    h.table.greet(1, R1, []);
    const q = h.ask(1, R1, [RUN]);
    h.answers.push({ ok: true, moved: [], deferred: [{ runId: RUN, runGeneration: 1, state: "preparing", why: "start_may_arrive" }], outsideLedger: [] });
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "not_known")]));
    expect(h.lines.takeRequery()).toEqual([RUN]);
  });
});

describe("ack(C17)", () => {
  const receipt = (connection: number, receiptId: string): Delivered => ({
    kind: "forward",
    connection,
    verified: verified(R1, "receipt_started", { receipt_id: receiptId, run_id: RUN, instruction_request_id: uuid(), started_at: NOW }),
  });

  test("장부가 받은 영수증만 그 영수증이 온 연결에 ack를 봉해 쓴다", () => {
    const h = harness();
    const id = uuid();
    h.lines.deliver(receipt(4, id));
    expect(h.acks.map((a) => [a.connection, a.envelope.header.action, a.envelope.header.recipient, (a.envelope.body as { ids: string[] }).ids])).toEqual([[4, "ack", R1, [id]]]);
    expect(h.acks[0]!.envelope.header.stop_generation).toBe(GEN);
    h.receiptAnswers.push({ ok: false, reason: "unknown_run" });
    h.lines.deliver(receipt(4, uuid()));
    expect(h.acks.length).toBe(1);
  });

  test("영수증은 막힌 답 줄을 기다리지 않는다", () => {
    const h = harness({ settled: false });
    h.table.greet(1, R1, []);
    h.lines.deliver(helloOutput(1, R1, []));
    h.lines.deliver(receipt(1, uuid()));
    expect([h.receipts.length, h.acks.length, h.calls.length]).toEqual([1, 1, 0]);
  });
});

describe("포트의 실패(C15·C44·C29)", () => {
  test("연결 표를 읽지 못하면 인사를 버리지 않고 쥐었다가 읽을 수 있을 때 넘긴다", () => {
    const h = harness();
    h.table.greet(1, R1, []);
    const view = h.ports.table;
    let broken = true;
    (h.ports as { table: AnswerLinePorts["table"] }).table = () => {
      if (broken) throw new Error("표");
      return view();
    };
    h.lines.deliver(helloOutput(1, R1, []));
    expect(h.calls).toEqual([]);
    expect(h.lines.withheld.executors()).toEqual({ known: true, value: [R1] });
    broken = false;
    h.lines.pump();
    expect(h.calls.map((c) => c.kind)).toEqual(["full"]);
  });

  test("deliver는 던지지 않고, 줄의 상태를 모르게 되면 맡기지 않을 실행기 집합을 known: false로 낸다", () => {
    const h = harness();
    h.table.greet(1, R1, []);
    (h.ports.queries as { pending: () => readonly SentQuery[] }).pending = () => {
      throw new Error("등록부");
    };
    (h.ports as { observe: AnswerLinePorts["observe"] }).observe = () => {
      throw new Error("기록");
    };
    expect(() => h.lines.deliver(statusForward(1, R1, uuid(), [run(RUN, "running")]))).not.toThrow();
    expect(() => h.lines.deliver({ kind: "forward", connection: 1, verified: null as never })).not.toThrow();
    expect(h.lines.withheld.executors()).toEqual({ known: false });
  });

  test("candidate마다 작업자 실행기 이름으로 순서기에 알린다", () => {
    const h = harness();
    h.lines.deliver({
      kind: "candidate",
      connection: 1,
      candidate: { connection: 1, target: "t", principal: { kind: "worker_executor", role: "diagnosis", instance: "0", storage: "store-a" }, keyId: "k", hello: { profile_revision: "p", policy_revision: "q" } },
    });
    expect(h.candidates).toEqual([R1]);
  });
});

describe("정적(C46)", () => {
  test("답 줄과 등록부에는 기다림·미룸과 시계·난수·환경의 직접 사용이 없다", async () => {
    for (const file of ["src/supervisor/runtime/answers.ts", "src/supervisor/runtime/query-book.ts"]) {
      const source = (await readText(file))
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
      for (const banned of [/\bawait\b/, /\basync\b/, /\.then\s*\(/, /queueMicrotask/, /setTimeout|setInterval|setImmediate/, /Date\.now|new Date/, /Math\.random|crypto\./, /process\./]) {
        expect([file, String(banned), banned.test(source)]).toEqual([file, String(banned), false]);
      }
    }
  });
});

describe("조회 등록부(C43·C11)", () => {
  test("remove는 더한 그 객체로 찾고 없는 항목에 던지지 않는다. 연결 철회는 그 연결의 항목만 끝낸다", () => {
    const book = createQueryBook();
    const a = { requestId: uuid(), recipient: R1, runIds: [RUN], connection: 1 };
    const b = { requestId: a.requestId, recipient: R1, runIds: [RUN], connection: 2 };
    book.add(a);
    book.add(b);
    expect(() => book.remove({ ...a })).not.toThrow();
    expect(book.pending().map((q) => q.connection)).toEqual([1, 2]);
    a.runIds.push("바뀜");
    expect(book.pending()[0]!.runIds).toEqual([RUN]);
    expect(book.dropConnection(1)).toBe(1);
    expect(book.pending().map((q) => q.connection)).toEqual([2]);
    book.remove(b);
    book.remove(b);
    expect(book.pending()).toEqual([]);
  });

  test("대조된 답은 그 연결의 그 조회만 끝내고, withdrawn은 그 연결의 남은 조회를 끝낸다", () => {
    const h = harness();
    h.table.greet(1, R1, []);
    const answered = h.ask(1, R1, [RUN]);
    const open = h.ask(1, R1, [RUN2]);
    const other = h.ask(9, R2, [RUN2]);
    h.lines.deliver(statusForward(1, R1, answered.requestId, [run(RUN, "running")]));
    expect(h.queries.pending().map((q) => q.requestId)).toEqual([open.requestId, other.requestId]);
    h.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
    expect(h.queries.pending().map((q) => q.requestId)).toEqual([other.requestId]);
  });

  test("철회 전에 받아 줄에 선 답의 조회는 그 답을 처리할 때까지 남아, 그 답은 버려지지 않고 인정이 끝난 연결의 답(status_not_current)이 된다", () => {
    const h = harness({ settled: false });
    h.table.greet(1, R1, []);
    const queued = h.ask(1, R1, [RUN]);
    const unanswered = h.ask(1, R1, [RUN2]);
    h.lines.deliver(statusForward(1, R1, queued.requestId, [run(RUN, "running")]));
    h.table.close(1);
    h.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
    expect(h.queries.pending().map((q) => q.requestId)).toEqual([queued.requestId]);
    expect(unanswered.connection).toBe(1);
    h.state.settled = true;
    h.lines.pump();
    const statuses = h.notes.filter((n) => n.kind === "status").map((n) => (n.kind === "status" ? n.outcome.outcome : ""));
    expect(statuses).toEqual(["status_not_current"]);
    expect(h.lines.backlog(R1).map((c) => c.runs[0]?.state)).toEqual(["running"]);
    expect(h.queries.pending()).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("같은 조회를 같은 연결에 두 번 실으면 항목이 둘이고, 대조된 답 하나가 항목 하나만 끝낸다: 두 번째 답의 관측도 장부에 간다", () => {
    const h = harness();
    h.table.greet(1, R1, []);
    const q = h.ask(1, R1, [RUN]);
    // 같은 초안을 다시 봉해 실었다: 요청 ID가 같고 등록 객체는 새것이다(내보내기 포트는 쓸 때마다 더한다).
    h.queries.add({ ...q, runIds: [...q.runIds] });
    const counts = [h.queries.pending().length];
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "not_known")], NOW + 1));
    counts.push(h.queries.pending().length);
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "stopping")], NOW + 2));
    counts.push(h.queries.pending().length);
    expect(counts).toEqual([2, 1, 0]);
    expect(statusOutcomes(h.notes)).toEqual(["status_matched", "status_matched"]);
    expect(h.calls.map((c) => `${c.states}@${c.answeredAt}`)).toEqual([`not_known@${NOW + 1}`, `stopping@${NOW + 2}`]);
    // 실은 횟수보다 많은 답(같은 답의 중복)은 남은 항목이 없어 대조되지 않는다.
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "stopping")], NOW + 2));
    expect(statusOutcomes(h.notes).at(-1)).toBe("unknown_query");
    expect(h.calls.length).toBe(2);
  });
});

const statusOutcomes = (notes: readonly AnswerNote[]): string[] =>
  notes.flatMap((n) => (n.kind !== "status" ? [] : [n.outcome.outcome === "status_unmatched" ? n.outcome.reason : n.outcome.outcome]));

describe("맞지 않는 답과 받은 때의 등록(C43)", () => {
  test("물은 실행과 맞지 않는 답은 그 조회의 항목을 끝내지 않는다: 뒤에 온 올바른 답이 대조된다", () => {
    const h = harness();
    h.table.greet(1, R1, []);
    const q = h.ask(1, R1, [RUN]);
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN2, "running")], NOW + 1));
    expect(h.queries.pending().length).toBe(1);
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "running")], NOW + 2));
    expect(statusOutcomes(h.notes)).toEqual(["runs_mismatch", "status_matched"]);
    expect(h.calls.map((c) => `${c.states}@${c.answeredAt}`)).toEqual([`running@${NOW + 2}`]);
    expect(h.queries.pending()).toEqual([]);
  });

  test("받은 뒤 같은 키로 등록한 조회는 먼저 받은 답과 대조하지 않는다", () => {
    const h = harness({ settled: false });
    h.table.greet(1, R1, []);
    const requestId = uuid();
    h.lines.deliver(statusForward(1, R1, requestId, [run(RUN, "stopping")], NOW + 1));
    h.queries.add({ requestId, recipient: R1, runIds: [RUN], connection: 1 });
    h.lines.deliver(statusForward(1, R1, requestId, [run(RUN, "running")], NOW + 2));
    h.state.settled = true;
    h.lines.pump();
    expect(statusOutcomes(h.notes)).toEqual(["unknown_query", "status_matched"]);
    expect(h.calls.map((c) => `${c.states}@${c.answeredAt}`)).toEqual([`running@${NOW + 2}`]);
    expect(h.queries.pending()).toEqual([]);
  });
});

describe("등록부 예외와 밀린 사본(C15·C18·C20)", () => {
  test("넘길 때 등록부 읽기가 한 번 던지면 그 답은 줄 맨 앞에 남았다가 회복된 뒤 장부에 간다", () => {
    const h = harness({ settled: false });
    h.table.greet(1, R1, []);
    const q = h.ask(1, R1, [RUN]);
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "running")], NOW + 1));
    const pending = h.queries.pending.bind(h.queries);
    let broken = true;
    (h.ports.queries as { pending: () => readonly SentQuery[] }).pending = () => {
      if (broken) {
        broken = false;
        throw new Error("등록부");
      }
      return pending();
    };
    h.state.settled = true;
    h.lines.pump();
    expect(h.calls).toEqual([]);
    h.lines.pump();
    expect(h.calls.map((c) => `${c.states}@${c.answeredAt}`)).toEqual([`running@${NOW + 1}`]);
    expect(statusOutcomes(h.notes)).toEqual(["status_matched"]);
    expect(h.queries.pending()).toEqual([]);
  });

  test("밀린 사본과 새 답을 반영한 뒤 등록 마감이 한 번 던져도 반영한 사본을 다시 넘기지 않고, 마감은 다음 처리에서 끝낸다", () => {
    const h = harness();
    h.table.greet(1, R1, []);
    const q1 = h.ask(1, R1, [RUN]);
    h.answers.push(new Error("disk"));
    h.lines.deliver(statusForward(1, R1, q1.requestId, [run(RUN, "running")], NOW + 1));
    const q2 = h.ask(1, R1, [RUN]);
    const settle = h.queries.settle.bind(h.queries);
    let broken = true;
    (h.ports.queries as { settle: (...args: never[]) => unknown }).settle = (...args: never[]) => {
      if (broken) {
        broken = false;
        throw new Error("등록부");
      }
      return (settle as (...a: never[]) => unknown)(...args);
    };
    h.lines.deliver(statusForward(1, R1, q2.requestId, [run(RUN, "stopping")], NOW + 2));
    expect(h.lines.backlog(R1)).toEqual([]);
    expect(h.queries.pending().map((q) => q.requestId)).toEqual([q2.requestId]);
    h.lines.pump();
    expect(h.calls.map((c) => `${c.states}@${c.answeredAt}`)).toEqual([`running@${NOW + 1}`, `running@${NOW + 1}`, `stopping@${NOW + 2}`]);
    expect(h.queries.pending()).toEqual([]);
  });

  test("밖에 낸 밀린 사본과 기록기에 넘긴 결과를 고쳐도 다시 넘기는 내용은 실행기가 보낸 그대로다", () => {
    const h = harness();
    h.table.greet(1, R1, []);
    const q = h.ask(1, R1, [RUN]);
    h.answers.push(new Error("disk"));
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "running")], NOW + 1));
    const shown = h.lines.backlog(R1);
    expect(() => {
      (shown[0]!.runs[0] as { state: string }).state = "stopping";
    }).toThrow();
    const noted = h.notes.find((n) => n.kind === "status");
    if (noted?.kind !== "status" || noted.outcome.outcome !== "status_matched") throw new Error("status_matched 기록이 없다");
    (noted.outcome.backlog[0]!.runs[0] as { state: string }).state = "stopping";
    h.lines.pump();
    expect(h.calls.map((c) => `${c.states}@${c.answeredAt}`)).toEqual([`running@${NOW + 1}`, `running@${NOW + 1}`]);
  });

  test("한 줄을 비우는 중 기록이 복원 대기 신호를 다시 세우면 다음 답을 넘기지 않는다", () => {
    const h = harness({ settled: false });
    h.table.greet(1, R1, []);
    const q1 = h.ask(1, R1, [RUN]);
    const q2 = h.ask(1, R1, [RUN]);
    h.lines.deliver(statusForward(1, R1, q1.requestId, [run(RUN, "running")], NOW + 1));
    h.lines.deliver(statusForward(1, R1, q2.requestId, [run(RUN, "stopping")], NOW + 2));
    let raised = false;
    (h.ports as { observe: AnswerLinePorts["observe"] }).observe = (n) => {
      h.notes.push(n);
      if (n.kind === "status" && !raised) {
        raised = true;
        h.state.settled = false;
      }
    };
    h.state.settled = true;
    h.lines.pump();
    expect(h.calls.map((c) => c.states)).toEqual(["running"]);
    h.state.settled = true;
    h.lines.pump();
    expect(h.calls.map((c) => c.states)).toEqual(["running", "stopping"]);
  });
});

describe("반영한 인사의 해제 재확인(C15·C29·C19)", () => {
  test("인사를 반영한 직후 연결 확인이 한 번 실패해도 다음 처리에서 해제 조건만 다시 보고 내린다: 인사는 다시 넘기지 않는다", () => {
    const h = harness();
    h.table.greet(1, R1, [run(RUN, "preparing")]);
    const answers = h.ports.wire.answers as { current: (connection: number, executorId: string) => boolean };
    const current = answers.current;
    let broken = true;
    answers.current = (connection, executorId) => {
      if (broken) {
        broken = false;
        throw new Error("게시 함수");
      }
      return current(connection, executorId);
    };
    h.lines.deliver(helloOutput(1, R1, [run(RUN, "preparing")]));
    expect(h.lines.withheld.executors()).toEqual({ known: true, value: [R1] });
    h.lines.pump();
    expect(h.lines.withheld.executors()).toEqual({ known: true, value: [] });
    expect(h.calls.map((c) => `${c.kind}:${c.states}`)).toEqual(["full:preparing"]);
  });

  test("반영한 인사의 연결이 더는 인정된 연결이 아니면 맡기지 않음을 내리지 않고, 새 연결의 인사가 반영될 때 내린다", () => {
    const h = harness();
    h.table.greet(1, R1, []);
    const answers = h.ports.wire.answers as { current: (connection: number, executorId: string) => boolean };
    const current = answers.current;
    let broken = true;
    answers.current = (connection, executorId) => {
      if (broken) {
        broken = false;
        return false;
      }
      return current(connection, executorId);
    };
    h.lines.deliver(helloOutput(1, R1, []));
    h.table.greet(2, R1, [], NOW + 10);
    h.lines.pump();
    expect(h.lines.withheld.executors()).toEqual({ known: true, value: [R1] });
    h.lines.deliver(helloOutput(2, R1, [], NOW + 10));
    expect(h.lines.withheld.executors()).toEqual({ known: true, value: [] });
    expect(h.calls.map((c) => `${c.kind}@${c.answeredAt}`)).toEqual([`full@${NOW}`, `full@${NOW + 10}`]);
  });
});

// 등록부 읽기(pending)를 다음 한 번만 던지게 한다.
const failPendingOnce = (h: ReturnType<typeof harness>): void => {
  const pending = h.queries.pending.bind(h.queries);
  const port = h.ports.queries as { pending: () => readonly SentQuery[] };
  port.pending = () => {
    port.pending = pending;
    throw new Error("등록부");
  };
};

describe("철회와 등록 정리(C43·C20·C15)", () => {
  // 서버는 바뀐 등록표를 적용하며 철회를 동기로 넘기므로, 처리기를 부른 뒤의 기록이나 처리기 안의 장부 쓰기 중에도 철회가 들어온다.
  for (const during of ["기록", "장부 쓰기"] as const) {
    test(`같은 조회의 첫 답을 처리하는 도중(${during}) 연결이 철회돼도 줄에 남은 두 번째 답의 항목은 남아, 그 안다는 사본이 밀린 목록에 남는다`, () => {
      const h = harness({ settled: false });
      h.table.greet(1, R1, []);
      const q = h.ask(1, R1, [RUN]);
      h.queries.add({ ...q, runIds: [...q.runIds] });
      h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "not_known")], NOW + 1));
      h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "stopping")], NOW + 2));
      let withdrawn = false;
      const withdraw = (): void => {
        if (withdrawn) return;
        withdrawn = true;
        h.table.close(1);
        h.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
      };
      if (during === "기록") {
        (h.ports as { observe: AnswerLinePorts["observe"] }).observe = (n) => {
          h.notes.push(n);
          if (n.kind === "status") withdraw();
        };
      } else {
        const ledger = h.ports.ledger as { applyExecutorAnswer: ReceiptLedger["applyExecutorAnswer"] };
        const apply = ledger.applyExecutorAnswer.bind(ledger);
        ledger.applyExecutorAnswer = (input, from) => {
          const result = apply(input, from);
          withdraw();
          return result;
        };
      }
      h.state.settled = true;
      h.lines.pump();
      expect(statusOutcomes(h.notes)).toEqual(["status_matched", "status_not_current"]);
      expect(h.calls.map((c) => `${c.states}@${c.answeredAt}`)).toEqual([`not_known@${NOW + 1}`]);
      expect(h.lines.backlog(R1).map((c) => `${c.runs[0]?.state}@${c.answeredAt}`)).toEqual([`stopping@${NOW + 2}`]);
      expect(h.queries.pending()).toEqual([]);
      expect(h.lines.takeRequery()).toEqual([RUN]);
    });
  }

  test("받은 때 등록부를 읽지 못한 답은 받은 뒤 같은 키로 등록한 조회를 끝내지 않고, 그 실행을 다시 물을 실행으로 낸다", () => {
    const h = harness({ settled: false });
    h.table.greet(1, R1, []);
    const requestId = uuid();
    failPendingOnce(h);
    h.lines.deliver(statusForward(1, R1, requestId, [run(RUN, "not_known")], NOW + 1));
    h.queries.add({ requestId, recipient: R1, runIds: [RUN], connection: 1 });
    h.lines.deliver(statusForward(1, R1, requestId, [run(RUN, "stopping")], NOW + 2));
    h.state.settled = true;
    h.lines.pump();
    expect(statusOutcomes(h.notes)).toEqual(["unknown_query", "status_matched"]);
    expect(h.calls.map((c) => `${c.states}@${c.answeredAt}`)).toEqual([`stopping@${NOW + 2}`]);
    expect(h.queries.pending()).toEqual([]);
    expect(h.lines.takeRequery()).toEqual([RUN]);
    expect(h.lines.withheld.executors()).toEqual({ known: false });
  });

  test("철회 전에 줄에 선 답이 물은 실행과 맞지 않으면, 그 답을 처리한 뒤 철회된 연결의 항목이 남지 않는다", () => {
    const h = harness({ settled: false });
    h.table.greet(1, R1, []);
    const q = h.ask(1, R1, [RUN]);
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN2, "running")], NOW + 1));
    h.table.close(1);
    h.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
    expect(h.queries.pending().map((p) => p.requestId)).toEqual([]);
    h.state.settled = true;
    h.lines.pump();
    expect(statusOutcomes(h.notes)).toEqual(["unknown_query"]);
    expect(h.queries.pending()).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("철회 전에 맞지 않는 답과 올바른 답이 차례로 줄에 섰으면, 맞지 않는 답을 처리한 뒤에도 올바른 답의 항목이 남아 그 답이 대조된다", () => {
    const h = harness({ settled: false });
    h.table.greet(1, R1, []);
    const q = h.ask(1, R1, [RUN]);
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN2, "running")], NOW + 1));
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "running")], NOW + 2));
    h.table.close(1);
    h.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
    h.state.settled = true;
    h.lines.pump();
    expect(statusOutcomes(h.notes)).toEqual(["runs_mismatch", "status_not_current"]);
    expect(h.lines.backlog(R1).map((c) => `${c.runs[0]?.state}@${c.answeredAt}`)).toEqual([`running@${NOW + 2}`]);
    expect(h.queries.pending()).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("철회를 처리할 때 등록부 읽기가 한 번 던져도 다음 처리에서 철회된 연결의 답하지 않은 항목을 끝낸다", () => {
    const h = harness();
    h.table.greet(1, R1, []);
    h.ask(1, R1, [RUN]);
    h.ask(1, R1, [RUN2]);
    const other = h.ask(2, R2, [RUN2]);
    h.table.close(1);
    failPendingOnce(h);
    h.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
    expect(h.queries.pending().length).toBe(3);
    h.lines.pump();
    expect(h.queries.pending().map((p) => p.requestId)).toEqual([other.requestId]);
  });

  test("받을 때 등록부 읽기 실패를 기록하는 동안 기록기가 pump()를 불러도 그 답은 줄에 남아, 대조 없이 끝나고 그 실행을 한 번 다시 묻는다", () => {
    const h = harness({ settled: false });
    h.table.greet(1, R1, []);
    const q = h.ask(1, R1, [RUN]);
    failPendingOnce(h);
    (h.ports as { observe: AnswerLinePorts["observe"] }).observe = (n) => {
      h.notes.push(n);
      if (n.kind === "fault") h.lines.pump();
    };
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN, "stopping")], NOW + 1));
    h.state.settled = true;
    h.lines.pump();
    h.lines.pump();
    expect(h.notes.filter((n) => n.kind === "fault").length).toBe(1);
    expect(statusOutcomes(h.notes)).toEqual(["unknown_query"]);
    expect(h.calls).toEqual([]);
    expect(h.lines.takeRequery()).toEqual([RUN]);
  });

  test("철회 전에 줄에 선 답이 모두 물은 실행과 맞지 않으면 철회 때 그 연결의 항목을 곧바로 끝낸다: 복원 대기 동안 쓸 데 없는 등록이 남지 않는다", () => {
    const h = harness({ settled: false });
    h.table.greet(1, R1, []);
    const q = h.ask(1, R1, [RUN]);
    // 다른 실행을 실은 답과, 같은 실행이지만 다른 실행기가 낸 답(대조하면 other_executor) 모두 그 항목을 쓸 수 없다.
    h.lines.deliver(statusForward(1, R1, q.requestId, [run(RUN2, "running")], NOW + 1));
    h.lines.deliver(statusForward(1, R2, q.requestId, [run(RUN, "running")], NOW + 2));
    h.table.close(1);
    h.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
    const counts = [h.queries.pending().length];
    for (let beat = 0; beat < 3; beat += 1) {
      h.lines.pump();
      counts.push(h.queries.pending().length);
    }
    expect(counts).toEqual([0, 0, 0, 0]);
    h.state.settled = true;
    h.lines.pump();
    expect(statusOutcomes(h.notes)).toEqual(["unknown_query", "unknown_query"]);
    expect(h.calls).toEqual([]);
    expect(h.lines.backlog(R1)).toEqual([]);
  });

  test("철회 정리 중 등록부가 던진 옛 연결의 항목은 그 실행기가 새 연결로 답한 처리 끝에 다시 정리한다(pump를 기다리지 않는다)", () => {
    const h = harness();
    h.table.greet(1, R1, []);
    h.ask(1, R1, [RUN]);
    const other = h.ask(3, R2, [RUN2]);
    h.table.close(1);
    failPendingOnce(h);
    h.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
    expect(h.queries.pending().map((p) => p.connection)).toEqual([1, 3]);
    h.table.greet(2, R1, []);
    h.lines.deliver(helloOutput(2, R1, []));
    expect(h.queries.pending().map((p) => p.requestId)).toEqual([other.requestId]);
  });
});
