// 내보내기 포트와 연결 문(src/supervisor/runtime/sink.ts)의 보장 넷. 서버는 쓰기 면(recognized, writeFrame)만 흉내 낸 가짜다:
// writeFrame은 실제 서버의 차례(서버 확인 → lastCheck 한 번 → 재확인 → finalCheck 한 번 → write)를 따르고, 넘긴 틀을 적는다.
// 시계는 시험이 쥔 값이고 실제 시간을 기다리지 않는다. 실제 서버로 가는 길은 sink-loopback.test.ts가 본다.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { sealEnvelope } from "../../../src/contract/v1/index.ts";
import { RESTORE_KEY } from "../../../src/ledger/ledger.ts";
import { resendTick } from "../../../src/supervisor/dispatch/resend.ts";
import { createFrameDecoder } from "../../../src/transport/framing.ts";
import type { SentQuery } from "../../../src/supervisor/dispatch/receipts.ts";
import { createWireSink, type SinkNote, type WireServer } from "../../../src/supervisor/runtime/sink.ts";
import type { SendEnd, WriteFrameOptions, WriteFrameResult } from "../../../src/supervisor/transport/server.ts";
import { list, readText } from "../../files.ts";
import { id, must, NOW, open, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";

const R1 = "executor/isolated_reader/r1/s1";
const R2 = "executor/isolated_reader/r2/s2";
const RUN = "11111111-1111-4111-8111-111111111111";
const GEN = 4;
const T0 = 1_800_000_000_000;
const LIFETIME = 30_000;
const SEND_MARGIN = 11_000;
const RENEW_MARGIN = 13_000;
const CONNECTION = 7;

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;

// 서명은 이 포트가 보지 않으므로 칸만 갖춘 봉투다. 시한은 T0 + 30초.
function envelope(action: string, body: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    header: {
      contract: "olive/v1",
      action,
      sender: "supervisor",
      recipient: R1,
      request_id: uuid(),
      stop_generation: GEN,
      run_generation: action === "status_query" || action === "ack" ? 0 : 1,
      issued_at: T0,
      expires_at: T0 + LIFETIME,
      nonce: "0".repeat(32),
      body_digest: "0".repeat(64),
      ...over,
    },
    signature: "sig",
    body,
  } as never;
}
const start = (deadline = T0 + 600_000, over: Record<string, unknown> = {}) => envelope("task_start", { run_id: RUN, deadline_at: deadline }, over);
const cancel = () => envelope("task_cancel", { run_id: RUN, reason: "requested" });
const renew = () => envelope("run_renew", { run_id: RUN, lease_until: T0 + 60_000 });
const query = () => envelope("status_query", { run_ids: [RUN] });
const ack = () => envelope("ack", { ids: [uuid()] });

type Before = Extract<WriteFrameResult, { kind: "not_written" }>["reason"];

// 시험이 고르는 가짜 서버의 답.
// before: lastCheck를 부르기 전에 돌려줄 결과(서버의 인정·닫힘·대기량 확인에서 걸림).
// after: lastCheck가 null을 낸 뒤의 결과. not_recognized·closed는 재확인에서 걸린 것이라 finalCheck를 부르지 않는다.
// 나머지는 finalCheck가 null을 낸 뒤의 결과다(no_reason·odd_reason·refused_bare는 서버 결과 타입에 없는 not_written).
interface World {
  now: number;
  generation: number | null;
  intake: boolean;
  withheld: { known: true; value: readonly unknown[] } | { known: false };
  recognized: number | null;
  before: Before | null;
  after: "written" | "unknown" | "not_recognized" | "closed" | "throw" | "malformed" | "no_reason" | "odd_reason" | "refused_bare";
  // writeFrame이 lastCheck를 부르기 바로 앞에 바꿀 것(앞에서 본 값을 믿지 않는지 본다).
  beforeCheck: () => void;
  // 포트가 읽힐 때마다 그 이름(차례 표시 포함)으로 부른다. 그 읽기에 시간이 걸린 것을 시계를 옮겨 흉내 낸다.
  onRead: (name: string) => void;
}

function harness(over: Partial<World> = {}) {
  const world: World = {
    now: T0,
    generation: GEN,
    intake: true,
    withheld: { known: true, value: [R2] },
    recognized: CONNECTION,
    before: null,
    after: "written",
    beforeCheck: () => {},
    onRead: () => {},
    ...over,
  };
  // 포트가 읽힌 차례. lastCheck 안이면 check:, 서버의 재확인이면 recheck:, finalCheck 안이면 final:이 붙는다.
  const reads: string[] = [];
  let phase = "";
  const read = (name: string) => {
    reads.push(phase + name);
    world.onRead(phase + name);
  };
  const frames: { connection: number; principal: string; frame: Uint8Array }[] = [];
  const settles: ((end: SendEnd) => void)[] = [];
  const book: SentQuery[] = [];
  const notes: SinkNote[] = [];
  let serverCalls = 0;
  const server: WireServer = {
    recognized(principal) {
      serverCalls += 1;
      read(`recognized:${principal}`);
      return world.recognized;
    },
    writeFrame(connection: number, principal: string, frame: Uint8Array, options: WriteFrameOptions): WriteFrameResult {
      serverCalls += 1;
      read("writeFrame");
      if (world.before !== null) return { kind: "not_written", reason: world.before } as WriteFrameResult;
      world.beforeCheck();
      phase = "check:";
      let verdict: string | null;
      try {
        verdict = options.lastCheck();
      } finally {
        phase = "";
      }
      if (verdict !== null) return { kind: "not_written", reason: "refused", refusal: verdict };
      // 서버의 인정 재확인: 같은 복원기의 세대를 다시 읽는다.
      phase = "recheck:";
      try {
        restorer.stopGeneration();
      } finally {
        phase = "";
      }
      if (world.after === "not_recognized" || world.after === "closed") return { kind: "not_written", reason: world.after };
      if (options.finalCheck !== undefined) {
        phase = "final:";
        let timing: string | null;
        try {
          timing = options.finalCheck();
        } finally {
          phase = "";
        }
        if (timing !== null) return { kind: "not_written", reason: "refused", refusal: timing };
      }
      switch (world.after) {
        case "written":
          frames.push({ connection, principal, frame });
          settles.push(options.settled);
          return { kind: "written" };
        case "unknown":
          options.settled("failed");
          return { kind: "unknown" };
        case "throw":
          throw new Error("writeFrame 던짐");
        case "malformed":
          return { kind: "maybe" } as never;
        case "no_reason":
          return { kind: "not_written" } as never;
        case "odd_reason":
          return { kind: "not_written", reason: "gone_fishing" } as never;
        case "refused_bare":
          return { kind: "not_written", reason: "refused" } as never;
      }
    },
  };
  const restorer = {
    stopGeneration() {
      read("stopGeneration");
      return world.generation;
    },
    intakeOpen() {
      read("intakeOpen");
      return world.intake;
    },
  };
  const wire = createWireSink({
    server,
    restorer: () => {
      read("restorer");
      return restorer;
    },
    withheld: {
      executors() {
        read("withheld");
        return world.withheld as never;
      },
    },
    clock: {
      now() {
        read("clock");
        return world.now;
      },
    },
    queries: {
      add(query) {
        read("queries.add");
        book.push(query);
      },
      remove(query) {
        read("queries.remove");
        const at = book.indexOf(query);
        if (at >= 0) book.splice(at, 1);
      },
    },
    observe: (note) => notes.push(note),
  });
  return { world, wire, reads, frames, settles, book, notes, server, calls: () => serverCalls };
}

// 넘긴 틀을 실행기 쪽 디코더로 풀어 봉투를 돌려준다.
function decoded(frame: Uint8Array): unknown {
  const step = createFrameDecoder().push(frame);
  expect(step.envelopes).toHaveLength(1);
  return step.envelopes[0]!.value;
}

describe("보장 1: 싣는 순간(lastCheck)에 다시 보고, 하나라도 아니면 넘긴 바이트 0", () => {
  test("통과: 시작 하나를 그 실행기의 인정된 연결에 그대로 넘기고 sent", async () => {
    const h = harness();
    const sent = start();
    expect(await h.wire.sink.send(sent)).toBe("sent");
    expect(h.frames.map((f) => [f.connection, f.principal])).toEqual([[CONNECTION, R1]]);
    expect(decoded(h.frames[0]!.frame)).toEqual(JSON.parse(JSON.stringify(sent)));
    expect(h.notes).toEqual([]);
  });

  test("차례: lastCheck 안에서 복원기 → 세대 → 접수 → 맡기지 않을 실행기, 서버의 재확인 뒤 finalCheck 안에서 시계 한 번. 그 앞에서는 recognized 말고 읽지 않는다", async () => {
    const h = harness();
    await h.wire.sink.send(start());
    expect(h.reads).toEqual([
      `recognized:${R1}`,
      "writeFrame",
      "check:restorer",
      "check:stopGeneration",
      "check:intakeOpen",
      "check:withheld",
      "recheck:stopGeneration",
      "final:clock",
    ]);
  });

  test("앞에서 본 값을 믿지 않는다: send를 부른 뒤 lastCheck 직전에 바뀐 세대·접수·집합·시계를 lastCheck가 잡는다", async () => {
    const changes: [string, (w: World) => void, string][] = [
      ["세대가 오름", (w) => (w.generation = GEN + 1), "stop_generation"],
      ["접수 닫힘", (w) => (w.intake = false), "intake_closed"],
      ["집합에 들어옴", (w) => (w.withheld = { known: true, value: [R1] }), "withheld"],
      ["시계가 흐름", (w) => (w.now = T0 + LIFETIME - SEND_MARGIN + 1), "too_late"],
    ];
    for (const [name, change, reason] of changes) {
      const h = harness();
      h.world.beforeCheck = () => change(h.world);
      const outcome = await h.wire.sink.send(start());
      expect([name, outcome, h.frames.length, h.notes.map((n) => (n.kind === "not_sent" ? n.reason : n.kind))]).toEqual([
        name,
        reason === "too_late" ? "too_late_to_send" : "no_connection",
        0,
        [reason],
      ]);
    }
  });

  test("정지 세대: 오름·내림·모름(null, 포트가 던짐)이면 넘긴 바이트 0이고 no_connection", async () => {
    const cases: [string, Partial<World>, string][] = [
      ["오름", { generation: GEN + 1 }, "stop_generation"],
      ["내림", { generation: GEN - 1 }, "stop_generation"],
      ["모름", { generation: null }, "stop_generation_unknown"],
    ];
    for (const [name, over, reason] of cases) {
      for (const make of [start, cancel, query]) {
        const h = harness(over);
        expect([name, await h.wire.sink.send(make()), h.frames.length, (h.notes[0] as { reason: string }).reason]).toEqual([name, "no_connection", 0, reason]);
      }
    }
    const h = harness();
    const thrower = createWireSink({
      server: h.server,
      restorer: () => {
        throw new Error("복원기 없음");
      },
      withheld: { executors: () => ({ known: true, value: [] }) },
      clock: { now: () => T0 },
      queries: { add() {}, remove() {} },
    });
    expect(await thrower.sink.send(start())).toBe("no_connection");
    expect(h.frames).toHaveLength(0);
  });

  test("봉투 시한: 남은 시간이 정확히 11,000ms면 싣고, 1ms라도 모자라면(시한 정각·1ms 전 포함) too_late_to_send", async () => {
    const expiresAt = T0 + LIFETIME;
    const cases: [number, string][] = [
      [expiresAt - SEND_MARGIN, "sent"],
      [expiresAt - SEND_MARGIN + 1, "too_late_to_send"],
      [expiresAt - 1, "too_late_to_send"],
      [expiresAt, "too_late_to_send"],
    ];
    for (const [now, outcome] of cases) {
      for (const make of [start, cancel, query]) {
        const h = harness({ now });
        expect([now - T0, await h.wire.sink.send(make()), h.frames.length] as unknown[]).toEqual([now - T0, outcome, outcome === "sent" ? 1 : 0]);
      }
    }
  });

  test("갱신의 봉투 시한은 13,000ms 여유로 본다(수명 박자의 RENEW_MARGIN_MS)", async () => {
    const expiresAt = T0 + LIFETIME;
    expect(await harness({ now: expiresAt - RENEW_MARGIN }).wire.sink.send(renew())).toBe("sent");
    const h = harness({ now: expiresAt - RENEW_MARGIN + 1 });
    expect(await h.wire.sink.send(renew())).toBe("too_late_to_send");
    expect(h.frames).toHaveLength(0);
  });

  test("작업 기한: deadline_at까지 정확히 11,000ms면 싣고, 1ms 모자라면 too_late_to_send(이름은 deadline)", async () => {
    const h1 = harness();
    expect(await h1.wire.sink.send(start(T0 + SEND_MARGIN))).toBe("sent");
    const h2 = harness();
    expect(await h2.wire.sink.send(start(T0 + SEND_MARGIN - 1))).toBe("too_late_to_send");
    expect([h2.frames.length, h2.notes]).toEqual([0, [expect.objectContaining({ kind: "not_sent", outcome: "too_late_to_send", reason: "deadline" })]]);
  });

  test("접수 닫힘: 새 실행을 여는 지시(task_start, session_start)는 넘긴 바이트 0, 취소·조회·갱신은 접수를 보지 않고 싣는다", async () => {
    for (const make of [start, () => envelope("session_start", { run_id: RUN })]) {
      const h = harness({ intake: false });
      expect([await h.wire.sink.send(make()), h.frames.length, (h.notes[0] as { reason: string }).reason]).toEqual(["no_connection", 0, "intake_closed"]);
    }
    for (const make of [cancel, query, renew]) {
      const h = harness({ intake: false });
      expect(await h.wire.sink.send(make())).toBe("sent");
      expect(h.reads.filter((r) => r.endsWith("intakeOpen") || r.endsWith("withheld"))).toEqual([]);
    }
  });

  test("맡기지 않을 실행기: 받는 실행기가 집합에 있거나 집합을 모르면(모름·던짐·배열 아님·문자열 아닌 원소·빈 칸) 시작은 넘긴 바이트 0", async () => {
    const cases: [string, World["withheld"] | "throw", string][] = [
      ["있음", { known: true, value: [R2, R1] }, "withheld"],
      ["모름", { known: false }, "withheld_unknown"],
      ["던짐", "throw", "withheld_unknown"],
      ["배열 아님", { known: true, value: R1 as never }, "withheld_unknown"],
      ["문자열 아님", { known: true, value: [R2, 3] }, "withheld_unknown"],
      // 빈 칸이 있는 배열을 일부러 넣는다.
      ["빈 칸", { known: true, value: [R2, , R1] }, "withheld_unknown"],
      // 배정 박자와 같은 검사(작업자 실행기 주체 이름)다. 문자열이어도 그 이름이 아니면 집합을 모른다.
      ["빈 문자열", { known: true, value: [""] }, "withheld_unknown"],
      ["모르는 역할", { known: true, value: [R2, "executor/no_such_role/r1/s1"] }, "withheld_unknown"],
      ["작업자 실행기가 아닌 주체", { known: true, value: ["supervisor"] }, "withheld_unknown"],
      ["세션 실행기", { known: true, value: ["executor/session/r1/s1"] }, "withheld_unknown"],
    ];
    for (const [name, withheld, reason] of cases) {
      const h = harness(withheld === "throw" ? {} : { withheld });
      if (withheld === "throw") {
        h.world.withheld = new Proxy({}, { get: () => {
          throw new Error("집합 없음");
        } }) as never;
      }
      expect([name, await h.wire.sink.send(start()), h.frames.length, (h.notes[0] as { reason: string }).reason]).toEqual([name, "no_connection", 0, reason]);
    }
  });

  test("맡기지 않을 실행기는 시작에만 건다: 같은 조건(집합에 있음·모름)에서 취소·조회는 집합을 읽지 않고 싣는다", async () => {
    for (const withheld of [{ known: true as const, value: [R1] }, { known: false as const }]) {
      for (const make of [cancel, query]) {
        const h = harness({ withheld });
        expect(await h.wire.sink.send(make())).toBe("sent");
        expect(h.frames).toHaveLength(1);
        expect(h.reads.filter((r) => r.endsWith("withheld"))).toEqual([]);
      }
    }
  });

  test("인정된 연결 없음: recognized가 null이면 writeFrame을 부르지 않고 no_connection(이름 not_recognized)", async () => {
    const h = harness({ recognized: null });
    expect(await h.wire.sink.send(start())).toBe("no_connection");
    expect(h.reads).toEqual([`recognized:${R1}`]);
    expect(h.notes).toEqual([expect.objectContaining({ kind: "not_sent", outcome: "no_connection", reason: "not_recognized" })]);
  });

  test("시계는 finalCheck 안에서만 한 번 읽는다. lastCheck에서 걸리면 시계를 읽지 않는다", async () => {
    const cases: [Partial<World>, number][] = [
      [{}, 1],
      [{ now: T0 + LIFETIME }, 1],
      [{ generation: GEN + 1 }, 0],
      [{ withheld: { known: true as const, value: [R1] } }, 0],
    ];
    for (const [over, reads] of cases) {
      const h = harness(over);
      await h.wire.sink.send(start());
      expect([over, h.reads.filter((r) => r === "final:clock").length]).toEqual([over, reads]);
      expect(h.reads.filter((r) => r.endsWith("clock") && !r.startsWith("final:"))).toEqual([]);
    }
  });

  test("시계가 던지거나 안전 정수가 아니면 싣지 않는다(no_connection, 이름 clock_unavailable)", async () => {
    for (const now of [Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      const h = harness({ now });
      expect([await h.wire.sink.send(start()), h.frames.length]).toEqual(["no_connection", 0]);
      expect((h.notes[0] as { reason: string }).reason).toBe("clock_unavailable");
    }
  });
});

describe("시간은 쓰기 바로 앞(finalCheck)에서 본다: 그 앞의 동기 조회와 서버 재확인에 흐른 시간이 여유에 든다", () => {
  // 시작의 시한 여유가 정확히 11,000ms인 시각. 이 시각에 시간이 더 흐르지 않으면 싣는다(대조군).
  const EDGE = T0 + LIFETIME - SEND_MARGIN;

  test("대조군: 여유 11,000ms에서 아무 읽기에도 시간이 흐르지 않으면 싣는다", async () => {
    const h = harness({ now: EDGE });
    expect(await h.wire.sink.send(start(T0 + 600_000, { request_id: FIXED_ID }))).toBe("sent");
    expect(h.frames).toHaveLength(1);
  });

  test("lastCheck 안의 동기 조회(맡기지 않을 실행기 집합)에 1ms가 흐르면 too_late_to_send, 넘긴 바이트 0", async () => {
    const h = harness({ now: EDGE, onRead: (name) => name === "check:withheld" && (h.world.now += 1) });
    expect(await h.wire.sink.send(start(T0 + 600_000, { request_id: FIXED_ID }))).toBe("too_late_to_send");
    expect([h.frames.length, h.notes]).toEqual([0, [notSent("too_late_to_send", "too_late")]]);
  });

  test("서버 재확인의 세대 조회에 1ms가 흐르면 too_late_to_send, 넘긴 바이트 0(시작과 ack 모두)", async () => {
    const h = harness({ now: EDGE, onRead: (name) => name === "recheck:stopGeneration" && (h.world.now += 1) });
    expect(await h.wire.sink.send(start(T0 + 600_000, { request_id: FIXED_ID }))).toBe("too_late_to_send");
    expect([h.frames.length, h.notes]).toEqual([0, [notSent("too_late_to_send", "too_late")]]);
    const a = harness({ now: EDGE, onRead: (name) => name === "recheck:stopGeneration" && (a.world.now += 1) });
    expect(a.wire.writeAck(CONNECTION, ack())).toBe("too_late_to_send");
    expect(a.frames).toHaveLength(0);
  });

  test("finalCheck 안에서 시계가 정각을 넘으면(봉투 시한, 작업 기한) too_late_to_send, 넘긴 바이트 0", async () => {
    const e = harness({ now: EDGE, onRead: (name) => name === "final:clock" && (e.world.now += 1) });
    expect(await e.wire.sink.send(start(T0 + 600_000, { request_id: FIXED_ID }))).toBe("too_late_to_send");
    expect([e.frames.length, e.notes]).toEqual([0, [notSent("too_late_to_send", "too_late")]]);
    const d = harness({ onRead: (name) => name === "final:clock" && (d.world.now += 1) });
    expect(await d.wire.sink.send(start(T0 + SEND_MARGIN, { request_id: FIXED_ID }))).toBe("too_late_to_send");
    expect([d.frames.length, d.notes]).toEqual([0, [notSent("too_late_to_send", "deadline")]]);
  });

  // 실제 재전송 박자 → sendInstruction → createWireSink. 장부는 임시 폴더의 실제 장부, 서버는 실제 서버의 차례를 따르는 가짜다.
  async function resendThroughSink(withheldTakesMs: number) {
    let now = NOW;
    const ledger = open(tempPath(), { clock: () => now });
    must(ledger.applyStop({ generation: 0, stopped: false, now }));
    const attempt = ledger.beginRestore(RESTORE_KEY);
    ledger.pinRestore(RESTORE_KEY, attempt);
    expect(ledger.grantIntake(RESTORE_KEY, attempt)).toBe(true);
    const admitted = must(ledger.admitRun(worker()));
    const requestId = id();
    must(ledger.startRun({ runId: admitted.run.runId, requestId, stopGeneration: 0, now }));
    const source = { stopGeneration: () => ledger.syncStopGeneration(attempt), intakeOpen: () => ledger.intakeOpen(attempt) };
    const published = () => source;
    const recognizedBy = (principal: string, restorer: typeof source) => (principal === WORKER_EXECUTOR && restorer.stopGeneration() !== null ? CONNECTION : null);
    const frames: Uint8Array[] = [];
    const notes: SinkNote[] = [];
    const server: WireServer = {
      recognized: (principal) => recognizedBy(principal, published()),
      writeFrame(connection, principal, frame, options) {
        const restorer = published();
        if (recognizedBy(principal, restorer) !== connection) return { kind: "not_written", reason: "not_recognized" };
        const verdict = options.lastCheck();
        if (verdict !== null) return { kind: "not_written", reason: "refused", refusal: verdict };
        if (recognizedBy(principal, restorer) !== connection || published() !== restorer) return { kind: "not_written", reason: "not_recognized" };
        const timing = options.finalCheck === undefined ? null : options.finalCheck();
        if (timing !== null) return { kind: "not_written", reason: "refused", refusal: timing };
        frames.push(frame);
        options.settled("flushed");
        return { kind: "written" };
      },
    };
    const wire = createWireSink({
      server,
      restorer: published,
      withheld: {
        executors: () => {
          now += withheldTakesMs;
          return { known: true, value: [] };
        },
      },
      clock: { now: () => now },
      queries: { add() {}, remove() {} },
      observe: (note) => notes.push(note),
    });
    const { privateKey } = generateKeyPairSync("ed25519");
    // 발행 뒤 19,000ms: 시작 봉투(수명 30,000ms)의 시한 여유가 정확히 11,000ms다.
    now = NOW + 19_000;
    const result = await resendTick(
      {
        ledger,
        intake: source,
        links: wire.links,
        sink: wire.sink,
        clock: { now: () => now },
        signer: { seal: (input) => sealEnvelope(input, privateKey) },
        random: { bytes: (length) => getRandomValues(new Uint8Array(length)) },
      },
      { resendEveryMs: 5_000 },
      { lastResends: [] },
    );
    if (!("instructions" in result)) throw new Error(`박자가 돌지 않음: ${JSON.stringify(result)}`);
    return { result, frames, notes, requestId };
  }

  test("실제 재전송 박자: 집합 읽기에 1ms가 흐른 시작은 resent가 아니라 not_sent(too_late_to_send, delivery not_sent)이고 넘긴 바이트 0", async () => {
    const control = await resendThroughSink(0);
    expect([control.result.instructions.map((row) => [row.requestId, row.outcome]), control.frames.length]).toEqual([[[control.requestId, "resent"]], 1]);

    const late = await resendThroughSink(1);
    expect(late.result.instructions).toEqual([
      expect.objectContaining({ requestId: late.requestId, outcome: "not_sent", reason: "too_late_to_send", delivery: "not_sent" }),
    ]);
    expect([late.frames.length, late.notes.map((n) => n.kind === "not_sent" && [n.outcome, n.reason])]).toEqual([0, [["too_late_to_send", "too_late"]]]);
  });
});

describe("보장 2: 포트는 동기로 끝나고, 돌아온 뒤 남는 것이 없다", () => {
  test("send가 돌려준 약속은 돌려줄 때 이미 정해져 있다(결과마다)", () => {
    const cases: [Partial<World>, () => never, "fulfilled" | "rejected"][] = [
      [{}, start, "fulfilled"],
      [{ recognized: null }, start, "fulfilled"],
      [{ now: T0 + LIFETIME }, start, "fulfilled"],
      [{ after: "unknown" }, start, "rejected"],
    ];
    for (const [over, make, status] of cases) {
      const promise = harness(over).wire.sink.send(make());
      expect(Bun.peek.status(promise)).toBe(status);
      promise.catch(() => {});
    }
  });

  test("send가 돌아온 뒤 서버 호출 0회: 서버가 settled를 불러도(flushed·closed) 포트는 서버를 다시 부르지 않는다", async () => {
    const h = harness();
    const promise = h.wire.sink.send(start());
    const after = h.calls();
    expect(after).toBe(2);
    for (const settled of h.settles) {
      settled("flushed");
      settled("closed");
    }
    await promise;
    await Promise.resolve();
    expect([h.calls(), h.frames.length]).toEqual([after, 1]);
  });

  test("줄 없음: 연결이 없을 때 넣은 봉투는 연결이 생긴 뒤에도 나가지 않고, 같은 봉투를 두 번 넣으면 두 번 따로 판정한다", async () => {
    const h = harness({ recognized: null });
    const same = start();
    expect(await h.wire.sink.send(same)).toBe("no_connection");
    expect(await h.wire.sink.send(same)).toBe("no_connection");
    h.world.recognized = CONNECTION;
    await Promise.resolve();
    expect([h.calls(), h.frames.length]).toEqual([2, 0]);
    // 다시 넣을 때마다 그때의 판정으로 하나씩 넘긴다. 앞서 거절한 것이 함께 나가지 않는다.
    expect(await h.wire.sink.send(same)).toBe("sent");
    expect(await h.wire.sink.send(same)).toBe("sent");
    expect(h.frames).toHaveLength(2);
    expect(h.frames[0]!.frame).toEqual(h.frames[1]!.frame);
  });
});

describe("보장 3: 기다리는 조회는 쓰기 전에 그 연결 번호와 함께 등록하고, written이 아니면 거둔다", () => {
  test("등록이 writeFrame보다 먼저이고, lastCheck가 불릴 때 이미 등록부에 있다. written이면 그대로 남는다", async () => {
    const h = harness();
    let presentAtCheck = false;
    h.world.beforeCheck = () => (presentAtCheck = h.book.length === 1);
    const sent = query();
    expect(await h.wire.sink.send(sent)).toBe("sent");
    expect(h.reads.slice(0, 3)).toEqual([`recognized:${R1}`, "queries.add", "writeFrame"]);
    expect(presentAtCheck).toBe(true);
    const header = (sent as { header: { request_id: string } }).header;
    expect(h.book).toEqual([{ requestId: header.request_id, recipient: R1, runIds: [RUN], connection: CONNECTION }]);
  });

  test("not_written(서버 확인에서 걸림·lastCheck 거절·재확인에서 인정 잃음)과 unknown·던짐·꼴 아닌 답이면 같은 항목을 거둔다", async () => {
    const cases: Partial<World>[] = [
      { before: "not_recognized" },
      { before: "closed" },
      { before: "backlog" },
      { generation: GEN + 1 },
      { now: T0 + LIFETIME },
      { after: "not_recognized" },
      { after: "unknown" },
      { after: "throw" },
      { after: "malformed" },
    ];
    for (const over of cases) {
      const h = harness(over);
      await h.wire.sink.send(query()).catch(() => "rejected");
      expect([over, h.book, h.reads.filter((r) => r.startsWith("queries"))]).toEqual([over, [], ["queries.add", "queries.remove"]]);
    }
  });

  test("인정된 연결이 없으면 등록하지 않는다. 등록이 던지면 쓰지 않고 거두기를 시도한 뒤 송달 모름으로 거절한다", async () => {
    const none = harness({ recognized: null });
    expect(await none.wire.sink.send(query())).toBe("no_connection");
    expect(none.reads.filter((r) => r.startsWith("queries"))).toEqual([]);

    const h = harness();
    let removed = 0;
    const wire = createWireSink({
      server: h.server,
      restorer: () => ({ stopGeneration: () => GEN, intakeOpen: () => true }),
      withheld: { executors: () => ({ known: true, value: [] }) },
      clock: { now: () => T0 },
      queries: {
        add() {
          throw new Error("등록부 고장");
        },
        remove() {
          removed += 1;
        },
      },
    });
    await expect(wire.sink.send(query())).rejects.toThrow();
    expect([h.frames.length, h.reads.includes("writeFrame"), removed]).toEqual([0, false, 1]);
  });

  test("조회가 아니면 등록부를 건드리지 않는다", async () => {
    for (const make of [start, cancel, renew]) {
      const h = harness();
      await h.wire.sink.send(make());
      expect(h.reads.filter((r) => r.startsWith("queries"))).toEqual([]);
    }
  });
});

describe("보장 4: 연결 문과 AnswerLinks는 부르는 순간의 인정된 연결로 동기 판정하고, ack는 같은 writeFrame을 지나며 시작 규칙을 보지 않는다", () => {
  test("mayIssue: 인정된 연결이 있으면 ok, 없으면 no_connection. 부를 때마다 서버에 다시 묻는다(캐시 없음)", () => {
    const h = harness();
    expect(h.wire.links.mayIssue(R1, "run_renew")).toEqual({ ok: true });
    h.world.recognized = null;
    expect(h.wire.links.mayIssue(R1, "task_cancel")).toEqual({ ok: false, reason: "no_connection" });
    h.world.recognized = CONNECTION;
    expect(h.wire.links.mayIssue(R1, "result_finalize")).toEqual({ ok: true });
    expect(h.reads.filter((r) => r.startsWith("recognized"))).toHaveLength(3);
    // 지시가 아닌 동작은 계약의 mayIssue가 연결을 보지 않는다.
    h.world.recognized = null;
    expect(h.wire.links.mayIssue(R1, "status_query")).toEqual({ ok: true });
  });

  test("mayIssue: 시계를 읽지 못하면 ok가 아니다", () => {
    expect(harness({ now: Number.NaN }).wire.links.mayIssue(R1, "run_renew")).toEqual({ ok: false, reason: "clock_unavailable" });
  });

  test("AnswerLinks.current: 지금 인정된 그 실행기의 연결 번호일 때만 참이고, 부를 때마다 다시 묻는다", () => {
    const h = harness();
    expect(h.wire.answers.current(CONNECTION, R1)).toBe(true);
    expect(h.wire.answers.current(CONNECTION + 1, R1)).toBe(false);
    h.world.recognized = CONNECTION + 1;
    expect(h.wire.answers.current(CONNECTION, R1)).toBe(false);
    expect(h.wire.answers.current(CONNECTION + 1, R1)).toBe(true);
    h.world.recognized = null;
    expect(h.wire.answers.current(CONNECTION + 1, R1)).toBe(false);
    expect(h.reads.filter((r) => r.startsWith("recognized"))).toHaveLength(5);
  });

  test("writeAck: 받은 연결 번호로 writeFrame에 넘기고(recognized를 고르지 않는다), 접수 닫힘·맡기지 않을 실행기에도 싣는다", () => {
    const h = harness({ intake: false, withheld: { known: true, value: [R1] } });
    const sent = ack();
    expect(h.wire.writeAck(CONNECTION + 3, sent)).toBe("sent");
    expect(h.frames.map((f) => [f.connection, f.principal])).toEqual([[CONNECTION + 3, R1]]);
    expect(h.reads).toEqual(["writeFrame", "check:restorer", "check:stopGeneration", "recheck:stopGeneration", "final:clock"]);
    expect(decoded(h.frames[0]!.frame)).toEqual(JSON.parse(JSON.stringify(sent)));
  });

  test("writeAck: 공통 규칙(시한·정지 세대)은 본다. 결과는 동기 값이고 송달 모름도 값이다", () => {
    expect(harness({ now: T0 + LIFETIME }).wire.writeAck(CONNECTION, ack())).toBe("too_late_to_send");
    expect(harness({ generation: GEN + 1 }).wire.writeAck(CONNECTION, ack())).toBe("no_connection");
    expect(harness({ before: "not_recognized" }).wire.writeAck(CONNECTION, ack())).toBe("no_connection");
    expect(harness({ after: "unknown" }).wire.writeAck(CONNECTION, ack())).toBe("unknown");
  });

  test("문을 섞지 않는다: writeAck에 지시를 넣거나 sink에 ack를 넣으면 서버를 부르지 않는다", async () => {
    for (const make of [start, cancel, query]) {
      const h = harness();
      expect(h.wire.writeAck(CONNECTION, make())).toBe("unsendable");
      expect([h.calls(), h.notes]).toEqual([0, [{ kind: "unsendable", reason: "not_ack" }]]);
    }
    const h = harness();
    await expect(h.wire.sink.send(ack())).rejects.toThrow();
    expect([h.calls(), h.notes]).toEqual([0, [{ kind: "unsendable", reason: "ack_on_sink" }]]);
  });
});

describe("옮김 표: writeFrame의 결과 → SendOutcome(그리고 기록의 실제 이름)", () => {
  test("모든 칸", async () => {
    const rows: [string, Partial<World>, string, SinkNote[]][] = [
      ["written", {}, "sent", []],
      ["recognized null", { recognized: null }, "no_connection", [notSent("no_connection", "not_recognized")]],
      ["not_recognized(서버 확인)", { before: "not_recognized" }, "no_connection", [notSent("no_connection", "not_recognized")]],
      ["closed", { before: "closed" }, "no_connection", [notSent("no_connection", "closed")]],
      ["backlog", { before: "backlog" }, "no_connection", [notSent("no_connection", "backlog")]],
      ["reentered", { before: "reentered" }, "no_connection", [notSent("no_connection", "reentered")]],
      ["check_failed", { before: "check_failed" }, "no_connection", [notSent("no_connection", "check_failed")]],
      ["not_recognized(재확인)", { after: "not_recognized" }, "no_connection", [notSent("no_connection", "not_recognized")]],
      ["closed(재확인)", { after: "closed" }, "no_connection", [notSent("no_connection", "closed")]],
      ["refused too_late", { now: T0 + LIFETIME }, "too_late_to_send", [notSent("too_late_to_send", "too_late")]],
      ["refused clock_unavailable", { now: Number.NaN }, "no_connection", [notSent("no_connection", "clock_unavailable")]],
      ["refused stop_generation", { generation: GEN + 1 }, "no_connection", [notSent("no_connection", "stop_generation")]],
      ["refused stop_generation_unknown", { generation: null }, "no_connection", [notSent("no_connection", "stop_generation_unknown")]],
      ["refused intake_closed", { intake: false }, "no_connection", [notSent("no_connection", "intake_closed")]],
      ["refused withheld", { withheld: { known: true, value: [R1] } }, "no_connection", [notSent("no_connection", "withheld")]],
      ["refused withheld_unknown", { withheld: { known: false } }, "no_connection", [notSent("no_connection", "withheld_unknown")]],
      ["unknown", { after: "unknown" }, "rejected", [unknownNote("write_unknown")]],
      ["writeFrame 던짐", { after: "throw" }, "rejected", [unknownNote("port_threw")]],
      ["꼴 아닌 답", { after: "malformed" }, "rejected", [unknownNote("result_malformed")]],
      // 서버의 결과 타입에 없는 not_written은 넘긴 바이트 0이라는 답으로 믿지 않는다.
      ["사유 없는 not_written", { after: "no_reason" }, "rejected", [unknownNote("result_malformed")]],
      ["모르는 사유의 not_written", { after: "odd_reason" }, "rejected", [unknownNote("result_malformed")]],
      ["refusal 없는 refused", { after: "refused_bare" }, "rejected", [unknownNote("result_malformed")]],
    ];
    for (const [name, over, outcome, notes] of rows) {
      const h = harness(over);
      const sent = start(T0 + 600_000, { request_id: FIXED_ID });
      const got = await h.wire.sink.send(sent).catch(() => "rejected");
      expect([name, got, h.notes]).toEqual([name, outcome, notes]);
      expect([name, h.frames.length]).toEqual([name, outcome === "sent" ? 1 : 0]);
    }
    // 작업 기한의 거절도 too_late_to_send다.
    const h = harness();
    expect(await h.wire.sink.send(start(T0 + 1, { request_id: FIXED_ID }))).toBe("too_late_to_send");
    expect(h.notes).toEqual([notSent("too_late_to_send", "deadline")]);
  });

  test("서버 결과 타입에 없는 not_written: 조회는 등록을 거두고 약속을 거절하고, ack는 unknown이다", async () => {
    for (const after of ["no_reason", "odd_reason", "refused_bare"] as const) {
      const q = harness({ after });
      await expect(q.wire.sink.send(query())).rejects.toThrow();
      expect([after, q.book, q.notes.map((n) => n.kind === "delivery_unknown" && n.reason)]).toEqual([after, [], ["result_malformed"]]);
      expect([after, harness({ after }).wire.writeAck(CONNECTION, ack())]).toEqual([after, "unknown"]);
    }
  });

  test("recognized가 던지면 writeFrame을 부르지 않고 약속을 거절한다(port_threw)", async () => {
    const h = harness();
    const wire = createWireSink({
      server: {
        recognized: () => {
          throw new Error("표 없음");
        },
        writeFrame: h.server.writeFrame,
      },
      restorer: () => ({ stopGeneration: () => GEN, intakeOpen: () => true }),
      withheld: { executors: () => ({ known: true, value: [] }) },
      clock: { now: () => T0 },
      queries: { add() {}, remove() {} },
      observe: (note) => h.notes.push(note),
    });
    await expect(wire.sink.send(start(T0 + 600_000, { request_id: FIXED_ID }))).rejects.toThrow();
    expect([h.calls(), h.notes]).toEqual([0, [unknownNote("port_threw")]]);
  });

  test("서버까지 가지 않는 봉투(읽지 못함, 틀 상한 초과)는 서버 호출 0회로 거절한다(박자는 send_threw로 읽는다)", async () => {
    const unreadable: unknown[] = [
      null,
      { header: null, body: {} },
      envelope("task_start", { run_id: RUN, deadline_at: 1.5 }),
      envelope("no_such_action", {}),
      envelope("status_query", { run_ids: [] }),
      envelope("task_start", { run_id: RUN, deadline_at: T0 + 600_000 }, { stop_generation: "4" }),
    ];
    for (const value of unreadable) {
      const h = harness();
      await expect(h.wire.sink.send(value as never)).rejects.toThrow();
      expect([h.calls(), h.notes]).toEqual([0, [{ kind: "unsendable", reason: "envelope_unreadable" }]]);
    }
    const h = harness();
    await expect(h.wire.sink.send(envelope("task_cancel", { run_id: RUN, reason: "requested", pad: "x".repeat(70_000) }))).rejects.toThrow();
    expect([h.calls(), h.notes]).toEqual([0, [{ kind: "unsendable", reason: "frame_too_large" }]]);
  });

  test("확인한 칸과 넘긴 바이트가 같다: 읽을 때마다 다른 값을 내는 접근자도 한 번 읽은 값으로 판정하고 그 값을 싣는다", async () => {
    const h = harness();
    let reads = 0;
    const sent = start();
    const header = (sent as { header: Record<string, unknown> }).header;
    Object.defineProperty(header, "stop_generation", {
      enumerable: true,
      get: () => (++reads === 1 ? GEN : GEN + 9),
    });
    expect(await h.wire.sink.send(sent)).toBe("sent");
    expect(reads).toBe(1);
    expect((decoded(h.frames[0]!.frame) as { header: { stop_generation: number } }).header.stop_generation).toBe(GEN);
  });
});

const FIXED_ID = "22222222-2222-4222-8222-222222222222";
const notSent = (outcome: string, reason: string): SinkNote => ({ kind: "not_sent", action: "task_start", requestId: FIXED_ID, recipient: R1, outcome, reason }) as SinkNote;
const unknownNote = (reason: string): SinkNote => ({ kind: "delivery_unknown", action: "task_start", requestId: FIXED_ID, recipient: R1, reason }) as SinkNote;

// ---- 정적 ----

const SINK = "src/supervisor/runtime/sink.ts";
// 줄 전체가 주석인 줄은 뺀다(start-send.test.ts와 같은 규칙).
const code = async (file: string) =>
  (await readText(file))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
// writeFrame을 부르는 자리. 선언(writeFrame(connection: number, ...): WriteFrameResult)은 빼고 센다.
const writeFrameCalls = (source: string) => [...source.matchAll(/(?<![\w$])writeFrame\s*\((?![^)\n]*\)\s*:)/g)].length;

describe("정적", () => {
  test("src/에서 writeFrame을 부르는 파일은 runtime/sink.ts(한 자리)와 자격 값 보내기(dispatch/credential-send.ts)뿐이다", async () => {
    const callers: Record<string, number> = {};
    for (const file of await list("src/**/*.ts")) {
      const count = writeFrameCalls(await code(file));
      if (count > 0) callers[file] = count;
    }
    expect(callers[SINK]).toBe(1);
    expect(Object.keys(callers).filter((file) => file !== SINK && file !== "src/supervisor/dispatch/credential-send.ts")).toEqual([]);
    // 대조군: 선언은 세지 않고 호출은 센다.
    expect(writeFrameCalls("  writeFrame(connection: number, principal: string, frame: Uint8Array, options: WriteFrameOptions): WriteFrameResult {")).toBe(0);
    expect(writeFrameCalls("ports.server.writeFrame(connection, head.recipient, head.frame, { lastCheck, settled });")).toBe(1);
  });

  test("sink.ts에는 시작 봉투를 만들거나 표식을 적는 코드가 없다", async () => {
    const source = await code(SINK);
    for (const banned of [/\bstartDraft\b/, /["'`]task_start["'`]/, /\bmarkStartDispatch\b/, /\bsendInstruction\b/, /\.seal\s*\(/, /\bsealEnvelope\b/, /\bsealDraft\b/]) {
      expect([String(banned), banned.test(source)]).toEqual([String(banned), false]);
    }
  });

  test("sink.ts는 기다리지 않고 미루지 않으며, 시계·난수·타이머·파일·환경을 직접 쓰지 않는다", async () => {
    const source = await code(SINK);
    for (const banned of [
      /\bawait\b/,
      /\basync\b/,
      /\.then\s*\(/,
      /\.finally\s*\(/,
      /\bqueueMicrotask\b/,
      /\bsetTimeout\b/,
      /\bsetInterval\b/,
      /\bsetImmediate\b/,
      /\bprocess\b/,
      /\bDate\b/,
      /\bperformance\b/,
      /\bMath\.random\b/,
      /\brandomUUID\b/,
      /\bgetRandomValues\b/,
      /\bBun\b/,
      /["']node:/,
      /["']bun:/,
    ]) {
      expect([String(banned), banned.test(source)]).toEqual([String(banned), false]);
    }
  });
});
