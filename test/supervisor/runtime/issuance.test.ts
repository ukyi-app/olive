// 발급 문과 종료 차례(issuance.ts). 답 줄(answers.ts)·내보내기 포트(sink.ts)·자격 값 보내기(credential-send.ts)·순서기(cycle.ts)는 실제 것이고,
// 연결 서버·장부·계정 파일은 가짜다. 가짜 서버는 실제 서버의 쓰기 차례(인정 → lastCheck → 인정 재확인 → finalCheck → 넘김)를 따르되,
// 인정은 주체의 연결 번호만 본다. 복원기 게시 객체의 재확인은 실제 서버를 쓰는 루프백과 서버 시험이 입증한다.
// 자격 값의 표본은 이 파일이 지어낸 바이트이고, 새는지는 불리언으로만 단언한다(실패 진단에 표본이 실리지 않게).
import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger, Run } from "../../../src/ledger/index.ts";
import type { CredentialFiles, CredentialRefPolicy } from "../../../src/supervisor/accounts/credential-ref.ts";
import type { ReceiptLedger } from "../../../src/supervisor/dispatch/receipts.ts";
import { type AnswerNote, createAnswerLines } from "../../../src/supervisor/runtime/answers.ts";
import { type BeatReport, type CycleBeats, createCycle } from "../../../src/supervisor/runtime/cycle.ts";
import { createIssuance, type IssuanceNote } from "../../../src/supervisor/runtime/issuance.ts";
import { createQueryBook } from "../../../src/supervisor/runtime/query-book.ts";
import { createSharedClock } from "../../../src/supervisor/runtime/shared-clock.ts";
import { type AckOutcome, createWireSink, type SinkNote } from "../../../src/supervisor/runtime/sink.ts";
import type { Delivered, SendEnd, WriteFrameOptions, WriteFrameResult } from "../../../src/supervisor/transport/server.ts";
import { createMixedFrameDecoder } from "../../../src/transport/framing.ts";
import { readText } from "../../files.ts";

const SAMPLE = "QX8V-LK2M-WP7R-ZN3T-HD4F";
const sampleBytes = () => new TextEncoder().encode(SAMPLE);
const DIGEST = createHash("sha256").update(sampleBytes()).digest("hex");
const allZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);
// 바이트 그릇(뷰와 원시 ArrayBuffer)은 숫자 배열로, 오류는 이름과 메시지로 펴서 본다. JSON.stringify는 Error를 {}로 만든다.
const SAMPLE_NUMBERS = Array.from(sampleBytes()).join(",");
const leaks = (value: unknown): boolean => {
  const text =
    JSON.stringify(value, (_key, v: unknown) =>
      ArrayBuffer.isView(v)
        ? Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
        : v instanceof ArrayBuffer
          ? Array.from(new Uint8Array(v))
          : v instanceof Error
            ? { name: v.name, message: v.message, cause: v.cause }
            : v,
    ) ?? "";
  return (
    text.includes(SAMPLE) ||
    text.includes(Buffer.from(SAMPLE).toString("hex")) ||
    text.includes(Buffer.from(SAMPLE).toString("base64")) ||
    text.includes(SAMPLE_NUMBERS)
  );
};

// 관측에서 뽑은 이름 목록의 단언. 원래 문자열끼리 견준 결과는 불리언으로 보고, 실패 진단에는 ":"로 나눈 조각이 모두 허용된
// 이름(또는 연결 번호)인 항목만 그대로 싣는다. 관측에 표본이 섞이는 회귀가 생겨도 실패 메시지가 표본을 다시 찍지 않는다.
const NAMES = new Set([
  "ack",
  "status_query",
  "sent",
  "no_connection",
  "issuance_closed",
  "server_closed",
  "server_close_failed",
  "written",
  "already_sent",
  "blocked",
  "not_written",
  "intake_closed",
  "not_recognized",
  "envelope",
  "credential",
  "server.close",
  "life:end",
]);
const shown = (list: readonly string[]) => list.map((item) => (NAMES.has(item) || item.split(":").every((part) => part === "" || /^\d+$/.test(part) || NAMES.has(part)) ? item : "<not_allowed>"));
function expectNames(actual: readonly string[], wanted: readonly string[]): void {
  const equal = actual.length === wanted.length && actual.every((item, i) => item === wanted[i]);
  expect({ names: shown(actual), equal }).toEqual({ names: shown(wanted), equal: true });
}

const NOW = 1_800_000_000_000;
const GEN = 3;
const R1 = "executor/diagnosis/0/store-a";
const RUN = "11111111-1111-4111-8111-111111111111";
const POLICY: CredentialRefPolicy = { dir: "/accounts", keys: { subscription: "CLAUDE_CODE_OAUTH_TOKEN" }, maxBytes: 16_384, revisionOf: () => "rev-1" };
const supervisorKey = generateKeyPairSync("ed25519").privateKey;

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;

function runRow(): Run {
  return {
    runId: RUN,
    runGeneration: 1,
    kind: "worker",
    role: "diagnosis",
    queueSeq: 1,
    dedupeKey: null,
    inputRequestId: null,
    profileRevision: "profile-1",
    policyRevision: "policy-1",
    snapshotDigest: null,
    inputDigest: null,
    executorId: R1,
    credential: { account: "main", method: "subscription", revision: "rev-1", digest: DIGEST },
    deadlineAt: NOW + 600_000,
    budgetLeft: 1,
    state: "preparing",
    acceptedReceiptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    startedReceiptId: null,
    stopReceiptId: null,
    cleanedReceiptId: null,
    resultDigest: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// 연결 판단을 지난 접수 영수증(task_start). 처리기가 읽는 칸만 갖춘다.
const accepted = (connection: number, receiptId = uuid(), instruction = "task_start"): Delivered => ({
  kind: "forward",
  connection,
  verified: {
    ok: true,
    action: "receipt_accepted",
    header: { sender: R1, recipient: "supervisor", action: "receipt_accepted", run_generation: 1, body_digest: "d".repeat(64), issued_at: NOW },
    body: { receipt_id: receiptId, run_id: RUN, instruction_request_id: uuid(), instruction },
  } as never,
});

interface Written {
  readonly connection: number;
  readonly kind: "envelope" | "credential";
  readonly action: string | null;
}

// 연결 서버의 쓰기 면 흉내. 인정은 실행기마다 연결 하나. 넘긴 틀은 섞어 받는 디코더로 풀어 무엇이 나갔는지 남기고 settled를 곧 부른다.
function fakeServer() {
  const recognized = new Map<string, number>([[R1, 1]]);
  const written: Written[] = [];
  const calls: string[] = [];
  let closes = 0;
  const server = {
    recognized(principal: string): number | null {
      return recognized.get(principal) ?? null;
    },
    writeFrame(connection: number, principal: string, frame: Uint8Array, options: WriteFrameOptions): WriteFrameResult {
      if (closes > 0 || recognized.get(principal) !== connection) return { kind: "not_written", reason: "not_recognized" };
      const refusal = options.lastCheck();
      if (refusal !== null) return { kind: "not_written", reason: "refused", refusal };
      // 실제 서버처럼 lastCheck 뒤에 인정을 다시 본다. lastCheck 안에서 인정이 바뀌면 넘기지 않는다.
      if (closes > 0 || recognized.get(principal) !== connection) return { kind: "not_written", reason: "not_recognized" };
      const late = options.finalCheck?.() ?? null;
      if (late !== null) return { kind: "not_written", reason: "refused", refusal: late };
      const decoded = createMixedFrameDecoder().push(frame);
      for (const item of decoded.frames) {
        written.push(
          item.kind === "envelope"
            ? { connection, kind: "envelope", action: String((item.envelope.value as { header: { action: string } }).header.action) }
            : { connection, kind: "credential", action: null },
        );
        if (item.kind === "credential") item.credential.value.fill(0);
      }
      options.settled("flushed" as SendEnd);
      return { kind: "written" };
    },
    async close(): Promise<void> {
      calls.push("server.close");
      closes += 1;
    },
  };
  return { server, recognized, written, calls, closes: () => closes };
}

function fakeFiles() {
  const lent: Uint8Array[] = [];
  const files: CredentialFiles = {
    async read() {
      const bytes = sampleBytes();
      lent.push(bytes);
      return { kind: "bytes", bytes };
    },
  };
  return { files, lent };
}

// 실제 순서기. 수명 박자만 시험이 쥔 약속을 기다릴 수 있다(진행 중인 박자).
function cycleWith(wait: () => Promise<void>) {
  const done = (kind: string) => ({ kind: "not_run", reason: kind }) as never;
  const beats: CycleBeats = {
    linkLoss: () => done("link_loss"),
    async life() {
      await wait();
      return done("life");
    },
    resend: async () => done("resend"),
    unreceived: () => done("unreceived"),
    assign: async () => done("assign"),
  };
  return createCycle({
    beats,
    serverTick: () => {},
    ledgerClock: createSharedClock({ now: () => NOW }),
    monotonic: { now: () => 1 },
    restoreDone: () => true,
    ledger: {
      listRuns: () => ({ known: true, value: [] }),
      listWaitingToolRequests: () => ({ known: true, value: [] }),
      instructionTimes: () => ({ known: false }),
      unansweredInstructions: () => ({ known: false }),
    } as never,
    policy: { judgeMs: 30_000, resendEveryMs: 5_000, assignCallsPerBeat: 1 },
  });
}

function harness(options: { life?: () => Promise<void> } = {}) {
  const fake = fakeServer();
  const disk = fakeFiles();
  const receipts: unknown[] = [];
  const receiptAnswers: unknown[] = [];
  const ledger: ReceiptLedger = {
    applyReceipt(input) {
      receipts.push(input);
      return (receiptAnswers.shift() ?? { ok: true, delivery: "new", ack: input.receiptId }) as ReturnType<Ledger["applyReceipt"]>;
    },
    recordReport: () => {
      throw new Error("recordReport를 부르면 안 된다");
    },
    applyExecutorAnswer: () => ({ ok: true, moved: [], deferred: [], outsideLedger: [] }) as never,
  };
  const row = runRow();
  const restorer = () => ({ stopGeneration: () => GEN, intakeOpen: () => true });
  const clock = { now: () => NOW };
  const cycle = cycleWith(options.life ?? (async () => {}));
  const issuanceNotes: IssuanceNote[] = [];
  const forgotten: number[] = [];
  const issuance = createIssuance({
    cycle,
    server: fake.server,
    restorer,
    ledger: { getRun: (runId: string) => ({ known: true, value: runId === RUN ? row : null }) },
    clock,
    files: disk.files,
    policy: POLICY,
    observe: (note) => issuanceNotes.push(note),
  });
  const sinkNotes: SinkNote[] = [];
  const queries = createQueryBook();
  const lineRef: { withheld: () => ReturnType<ReturnType<typeof createAnswerLines>["withheld"]["executors"]> } = { withheld: () => ({ known: true, value: [] }) };
  const wire = createWireSink({
    server: fake.server,
    restorer,
    withheld: { executors: () => lineRef.withheld() },
    clock,
    queries,
    observe: (note) => sinkNotes.push(note),
    issuanceOpen: issuance.issuanceOpen,
  });
  const answerNotes: AnswerNote[] = [];
  // 영수증과 철회가 송신기에 닿는 횟수를 세려고 감싼다(송신기는 그대로 부른다).
  const received: string[] = [];
  const credentials = {
    onReceipt(forward: Parameters<typeof issuance.credentials.onReceipt>[0], outcome: Parameters<typeof issuance.credentials.onReceipt>[1]) {
      received.push(outcome.outcome);
      issuance.credentials.onReceipt(forward, outcome);
    },
    forgetConnection(connection: number) {
      forgotten.push(connection);
      issuance.credentials.forgetConnection(connection);
    },
  };
  const lines = createAnswerLines({
    table: () => ({ get: () => undefined, candidates: () => [] }) as never,
    restorer,
    ledger,
    results: { backend: {} as never, ledger: { getRun: () => ({ known: false }) as never, instructionTimes: () => ({ known: false }) as never, recordReport: () => ({ ok: false }) as never } },
    random: { bytes: (length) => new Uint8Array(length).map((_, i) => (i * 7 + seq++) & 0xff) },
    signer: { seal: (input) => sealEnvelope(input, supervisorKey) },
    clock,
    wire,
    queries,
    cycle,
    observationsSettled: () => true,
    observe: (note) => answerNotes.push(note),
    credentials,
  });
  lineRef.withheld = () => lines.withheld.executors();
  const attempts = () => issuanceNotes.flatMap((n) => (n.kind === "credential" && n.note.kind === "attempt" ? [n.note.outcome + (n.note.reason === null ? "" : `:${n.note.reason}`)] : []));
  const credentialFrames = () => fake.written.filter((w) => w.kind === "credential").length;
  const acks = () => answerNotes.flatMap((n) => (n.kind === "ack" ? [n.result as AckOutcome | string] : []));
  return { fake, disk, receipts, receiptAnswers, cycle, issuance, issuanceNotes, sinkNotes, wire, lines, answerNotes, forgotten, received, attempts, credentialFrames, acks };
}

// 송신기의 계정 파일 읽기(기다림 하나)와 그 뒤의 쓰기가 끝나도록 대기열을 비운다. 실제 시간을 기다리지 않는다.
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("자격 값 잇기(C50·C54)", () => {
  test("장부가 받은 접수 영수증(task_start) 하나에 자격 값 틀이 그 연결로 정확히 한 번 나가고, 빌린 값은 0으로 채워진다", async () => {
    const h = harness();
    h.lines.deliver(accepted(1));
    await flush();
    expectNames(h.received, ["ack"]);
    expect(h.credentialFrames()).toBe(1);
    expectNames(
      h.fake.written.map((w) => `${w.connection}:${w.kind}:${w.action ?? ""}`),
      ["1:envelope:ack", "1:credential:"],
    );
    expectNames(h.attempts(), ["written"]);
    expect(h.disk.lent.length).toBe(1);
    expect(allZero(h.disk.lent[0]!)).toBe(true);
    expect(leaks(h.issuanceNotes)).toBe(false);
    expect(leaks(h.answerNotes)).toBe(false);
  });

  test("같은 연결에서 같은 본문의 접수 영수증이 두 번 오면(장부는 new, duplicate) onReceipt는 두 번이지만 계정 파일 읽기와 값 틀은 한 번이다", async () => {
    const h = harness();
    // 실행기의 재전송처럼 같은 입력을 그대로 다시 넣는다(instruction_request_id도 같다).
    const id = uuid();
    const item = accepted(1, id);
    h.lines.deliver(item);
    h.receiptAnswers.push({ ok: true, delivery: "duplicate", ack: id });
    h.lines.deliver(item);
    await flush();
    expect(h.receipts.length).toBe(2);
    expectNames(h.received, ["ack", "ack"]);
    expect(h.credentialFrames()).toBe(1);
    expect(h.disk.lent.length).toBe(1);
    expectNames(h.attempts(), ["already_sent", "written"]);
    expectNames(h.acks(), ["sent", "sent"]);
  });

  test("장부가 거절했거나 적지 못한 영수증은 송신기에 넘기지 않는다: 시도 0, 읽기 0, 값 틀 0", async () => {
    const h = harness();
    h.receiptAnswers.push({ ok: false, reason: "unknown_run" });
    h.lines.deliver(accepted(1));
    h.receiptAnswers.push({ ok: "maybe" });
    h.lines.deliver(accepted(1));
    await flush();
    expect(h.receipts.length).toBe(2);
    expectNames(h.received, []);
    expectNames(h.attempts(), []);
    expect(h.disk.lent.length).toBe(0);
    expect(h.credentialFrames()).toBe(0);
    expect(h.fake.written).toEqual([]);
  });

  test("task_start가 아닌 접수 영수증에는 값을 보내지 않는다(ack는 나간다)", async () => {
    const h = harness();
    h.lines.deliver(accepted(1, uuid(), "run_renew"));
    await flush();
    expectNames(h.acks(), ["sent"]);
    expect(h.credentialFrames()).toBe(0);
    expect(h.disk.lent.length).toBe(0);
  });

  test("연결 철회마다 송신기의 그 연결 기억을 한 번 지운다: 지운 뒤 같은 번호의 같은 실행은 다시 시도한다", async () => {
    const h = harness();
    const id = uuid();
    h.lines.deliver(accepted(1, id));
    await flush();
    h.lines.deliver({ kind: "withdrawn", connection: 1, principal: R1 });
    expect(h.forgotten).toEqual([1]);
    // 실제 서버는 번호를 다시 쓰지 않는다. 기억이 지워졌는지만 보려고 같은 번호로 다시 넣는다.
    h.receiptAnswers.push({ ok: true, delivery: "duplicate", ack: id });
    h.lines.deliver(accepted(1, id));
    await flush();
    expectNames(h.attempts(), ["written", "written"]);
  });
});

describe("발급 닫기와 종료 차례(C36)", () => {
  test("깃발 뒤에는 지시·ack·자격 값 모두 넘긴 바이트 0이고 계정 파일도 읽지 않는다", async () => {
    const h = harness();
    const closing = h.cycle.closeIssuance();
    expect(h.issuance.issuanceOpen()).toBe(false);
    // ack와 자격 값: 접수 영수증 하나.
    h.lines.deliver(accepted(1));
    await flush();
    // 지시: 내보내기 포트에 조회 하나.
    const envelope = sealEnvelope(
      { sender: "supervisor", recipient: R1, action: "status_query", request_id: uuid(), stop_generation: GEN, run_generation: 0, issued_at: NOW, nonce: "a".repeat(32), body: { run_ids: [RUN] } } as never,
      supervisorKey,
    );
    expect(await h.wire.sink.send(envelope as never)).toBe("no_connection");
    await closing;
    expect(h.fake.written).toEqual([]);
    expect(h.credentialFrames()).toBe(0);
    expect(h.disk.lent.length).toBe(0);
    expectNames(h.acks(), ["no_connection"]);
    expectNames(h.attempts(), ["blocked:intake_closed"]);
    expectNames(
      h.sinkNotes.flatMap((n) => (n.kind === "not_sent" ? [`${n.action}:${n.reason}`] : [])),
      ["ack:issuance_closed", "status_query:issuance_closed"],
    );
  });

  test("계정 파일을 읽는 동안 깃발이 서면 lastCheck가 막는다: 값 틀 0, 값은 그 자리에서 0", async () => {
    const h = harness();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const read = h.disk.files.read.bind(h.disk.files);
    (h.disk.files as { read: CredentialFiles["read"] }).read = async (location, maxBytes) => {
      await held;
      return read(location, maxBytes);
    };
    h.lines.deliver(accepted(1));
    await flush();
    expectNames(h.attempts(), []);
    // 서버는 닫지 않는다: 서버의 not_recognized가 아니라 lastCheck가 막는 것을 본다.
    void h.cycle.closeIssuance();
    release();
    await flush();
    expect(h.credentialFrames()).toBe(0);
    expectNames(h.attempts(), ["not_written:intake_closed"]);
    expect(allZero(h.disk.lent[0]!)).toBe(true);
  });

  test("shutdown은 closeIssuance가 돌아온 뒤에만 server.close를 부르고, 진행 중인 박자가 끝난 뒤에 닫는다. 그 박자의 남은 발급도 0이다", async () => {
    const hold = deferred();
    const entered = deferred();
    const h = harness({
      life: async () => {
        entered.resolve();
        await hold.promise;
        h.fake.calls.push("life:end");
      },
    });
    const beat = h.cycle.beat();
    await entered.promise;
    const done = h.issuance.shutdown();
    await flush();
    expect(h.issuance.issuanceOpen()).toBe(false);
    expectNames(h.fake.calls, []);
    // 박자가 진행 중인 동안 온 영수증의 ack·자격 값도 깃발을 본다.
    h.lines.deliver(accepted(1));
    await flush();
    expect(h.fake.written).toEqual([]);
    expectNames(h.fake.calls, []);
    hold.resolve();
    const report: BeatReport = await beat;
    await done;
    expectNames(h.fake.calls, ["life:end", "server.close"]);
    expect(report.kind === "ran" && report.resend.kind === "skipped" && report.resend.reason).toBe("issuance_closed");
    expectNames(
      h.issuanceNotes.flatMap((n) => (n.kind === "shutdown" ? [n.step] : [])),
      ["issuance_closed", "server_closed"],
    );
    // 두 번 불러도 닫기는 한 번이다.
    await h.issuance.shutdown();
    expect(h.fake.closes()).toBe(1);
  });

  test("서버 닫기가 거절되면 shutdown은 고정된 이름의 오류로 끝나고 포트의 오류 원문은 cause에도 싣지 않는다", async () => {
    const h = harness();
    // 닫기 포트의 오류 메시지에 표본이 섞여도 shutdown의 호출자에게 건너가지 않아야 한다.
    const failure = new Error(`tls close near ${SAMPLE}`);
    (h.fake.server as { close: () => Promise<void> }).close = async () => {
      throw failure;
    };
    const settled = await h.issuance.shutdown().then(
      () => ({ rejected: false, error: null as unknown }),
      (error: unknown) => ({ rejected: true, error }),
    );
    const error = settled.error;
    expect(settled.rejected).toBe(true);
    expect(error instanceof Error).toBe(true);
    expect(error !== failure).toBe(true);
    expect(error instanceof Error && error.message === "server_close_failed").toBe(true);
    expect(error instanceof Error && error.cause === undefined && !("cause" in error)).toBe(true);
    expect(leaks(error)).toBe(false);
    expect(error instanceof Error && leaks(error.stack ?? "")).toBe(false);
    expect(leaks(h.issuanceNotes)).toBe(false);
    expectNames(
      h.issuanceNotes.flatMap((n) => (n.kind === "shutdown" ? [n.step] : [])),
      ["issuance_closed", "server_close_failed"],
    );
    // 같은 약속이라 다시 불러도 같은 고정 오류이고 닫기는 한 번이다.
    const again = await h.issuance.shutdown().then(
      () => null,
      (e: unknown) => e,
    );
    expect(again === error).toBe(true);
  });

  test("닫기 포트 안에서 shutdown()을 동기로 다시 불러도 같은 약속이고 server.close는 한 번이다", async () => {
    const h = harness();
    const closeIssuance = h.cycle.closeIssuance.bind(h.cycle);
    let nested: Promise<void> | null = null;
    let openWhenNested: boolean | null = null;
    (h.cycle as { closeIssuance: () => Promise<void> }).closeIssuance = () => {
      const wait = closeIssuance();
      if (nested === null) {
        openWhenNested = h.issuance.issuanceOpen();
        nested = h.issuance.shutdown();
      }
      return wait;
    };
    const outer = h.issuance.shutdown();
    // 첫 호출이 돌아온 그 자리에서 깃발은 이미 서 있다(다음 마이크로태스크로 미루지 않는다).
    expect(h.issuance.issuanceOpen()).toBe(false);
    expect(openWhenNested === false).toBe(true);
    await Promise.all([outer, nested]);
    expect(nested === outer).toBe(true);
    expect(h.fake.closes()).toBe(1);
    expectNames(h.fake.calls, ["server.close"]);
    expectNames(
      h.issuanceNotes.flatMap((n) => (n.kind === "shutdown" ? [n.step] : [])),
      ["issuance_closed", "server_closed"],
    );
  });

  test("깃발을 읽다 던지면 닫힌 것으로 본다(내보내기 포트와 자격 값 모두)", async () => {
    const h = harness();
    (h.cycle as { issuanceOpen: () => boolean }).issuanceOpen = () => {
      throw new Error("flag");
    };
    expect(h.issuance.issuanceOpen()).toBe(false);
    h.lines.deliver(accepted(1));
    await flush();
    expect(h.fake.written).toEqual([]);
    expect(h.disk.lent.length).toBe(0);
    expectNames(h.attempts(), ["blocked:intake_closed"]);
    expectNames(h.acks(), ["no_connection"]);
  });
});

describe("시험의 진단", () => {
  test("유출 판정은 문자열·hex·base64·바이트 뷰·숫자 배열·원시 ArrayBuffer·Error 메시지 꼴을 모두 잡는다", () => {
    const bytes = sampleBytes();
    const carriers: unknown[] = [
      SAMPLE,
      Buffer.from(SAMPLE).toString("hex"),
      Buffer.from(SAMPLE).toString("base64"),
      bytes,
      Array.from(bytes),
      Buffer.from(bytes),
      sampleBytes().buffer,
      new Error(`near ${SAMPLE}`),
      new Error("wrapped", { cause: new Error(SAMPLE) }),
    ];
    for (const carrier of carriers) expect(leaks({ nested: [{ carrier }] })).toBe(true);
    expect(leaks({ kind: "attempt", connection: 1, runId: RUN, outcome: "written", reason: null })).toBe(false);
  });

  test("관측 이름 단언이 실패해도 실패 메시지에 표본이 없다(허용된 이름만 진단에 오른다)", () => {
    const h = harness();
    h.issuanceNotes.push({ kind: "credential", note: { kind: "attempt", connection: 1, runId: RUN, outcome: "written", reason: SAMPLE } as never });
    const failures: unknown[] = [];
    try {
      expectNames(h.attempts(), ["written"]);
    } catch (error) {
      failures.push(error);
    }
    const note = h.issuanceNotes[0]!.kind === "credential" ? h.issuanceNotes[0]!.note : null;
    const line = note !== null && note.kind === "attempt" ? `1:${note.outcome}:${note.reason ?? ""}` : "";
    try {
      expectNames([line], ["1:written:"]);
    } catch (error) {
      failures.push(error);
    }
    expect(failures.length).toBe(2);
    expect(failures.every((error) => error instanceof Error)).toBe(true);
    expect(failures.some((error) => leaks(error))).toBe(false);
  });

  test("가짜 서버도 lastCheck 뒤에 인정을 다시 본다: 계정 파일 읽기 뒤 lastCheck 안에서 인정이 바뀌면 값 틀 0", async () => {
    const h = harness();
    let readDone = false;
    const read = h.disk.files.read.bind(h.disk.files);
    (h.disk.files as { read: CredentialFiles["read"] }).read = async (location, maxBytes) => {
      const answer = await read(location, maxBytes);
      readDone = true;
      return answer;
    };
    // 깃발 읽기는 송신기 lastCheck 안에서 불린다. 읽기가 끝난 뒤의 첫 깃발 읽기에서 같은 실행기를 연결 2로 옮긴다.
    const open = h.cycle.issuanceOpen.bind(h.cycle);
    (h.cycle as { issuanceOpen: () => boolean }).issuanceOpen = () => {
      if (readDone) h.fake.recognized.set(R1, 2);
      return open();
    };
    h.lines.deliver(accepted(1));
    await flush();
    expect(h.credentialFrames()).toBe(0);
    expectNames(h.attempts(), ["not_written:not_recognized"]);
    expect(allZero(h.disk.lent[0]!)).toBe(true);
  });
});

describe("정적", () => {
  test("issuance.ts는 시계·난수·타이머·환경을 직접 쓰지 않고, 틀을 직접 쓰거나 만들지 않는다", async () => {
    const source = (await readText("src/supervisor/runtime/issuance.ts"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    for (const banned of [
      /\bDate\b/,
      /\bperformance\b/,
      /Math\.random/,
      /randomUUID|getRandomValues/,
      /setTimeout|setInterval|setImmediate|queueMicrotask/,
      /\bprocess\b/,
      /\bBun\b/,
      /["']node:/,
      /\bwriteFrame\s*\(/,
      /\bencodeCredentialFrame\b/,
      /\bencodeFrame\b/,
      /["'`]task_start["'`]/,
    ]) {
      expect([String(banned), banned.test(source)]).toEqual([String(banned), false]);
    }
  });
});
