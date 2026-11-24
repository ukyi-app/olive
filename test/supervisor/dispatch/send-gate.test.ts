// 공유 송신 함수(send-gate.ts)가 입력을 읽는 시각. 입력 객체(holder·포트·start·표식 포트)의 칸은 진입 때 한 번 읽고, 박자 유효 문
// 뒤에는 쥔 함수·값만 쓴다. 칸마다 접근자를 두고 그중 하나가 1ms를 쓰게 해, 그 시간을 첫 유효 문이 보는지 잰다.
// 기한은 1,000(정각 포함 닫힘), 진입 전 시각은 999다.
import { describe, expect, test } from "bun:test";
import type { Envelope } from "../../../src/contract/v1/index.ts";
import { callAfterGate, type GateResult, sendInstruction } from "../../../src/supervisor/dispatch/send-gate.ts";
import { createWireSink } from "../../../src/supervisor/runtime/sink.ts";

const LIMIT = 1_000;
// sendInstruction이 읽는 칸(동작·요청 ID·실행 ID)만 둔 봉투. 서명은 보지 않는다.
const envelope = (action: string) => ({ header: { action, request_id: "request-1" }, body: { run_id: "run-1" } }) as unknown as Envelope;

const HOLDER_SPOTS = ["holder.sink", "sink.send", "holder.beatValid"] as const;
const START_SPOTS = ["start.at", "start.lastCheck", "start.marker", "marker.markStartDispatch"] as const;
type Spot = (typeof HOLDER_SPOTS)[number] | (typeof START_SPOTS)[number];

function world(slow: Spot | null) {
  let now = LIMIT - 1;
  const trace: string[] = [];
  const reads: Partial<Record<Spot, number>> = {};
  const read = <T>(spot: Spot, value: T): T => {
    reads[spot] = (reads[spot] ?? 0) + 1;
    if (spot === slow) now += 1;
    return value;
  };
  const marker = {
    get markStartDispatch() {
      return read("marker.markStartDispatch", (_input: unknown) => (trace.push(`mark@${now}`), { ok: true, created: true }));
    },
  };
  const sink = {
    get send() {
      return read("sink.send", async (_sent: Envelope) => (trace.push(`send@${now}`), "sent"));
    },
  };
  const holder = {
    get sink() {
      return read("holder.sink", sink);
    },
    get beatValid() {
      return read("holder.beatValid", () => (trace.push(`gate@${now}`), now < LIMIT));
    },
  };
  const start = {
    get at() {
      return read("start.at", LIMIT - 1);
    },
    get lastCheck() {
      return read("start.lastCheck", () => (trace.push(`check@${now}`), null));
    },
    get marker() {
      return read("start.marker", marker);
    },
  };
  return { holder: holder as never, start: start as never, trace, reads, plain: (value: string | null) => ({ check: () => (trace.push(`check@${now}`), value), stops: (answer: unknown): answer is string => typeof answer === "string" }) };
}

const once = (spots: readonly Spot[]) => Object.fromEntries(spots.map((spot) => [spot, 1]));

describe("공유 송신 함수: 마지막 확인의 답은 null만 싣기다", () => {
  // 시작: 표식을 실제로 센 뒤 마지막 확인이 낸 값으로 싣는지 본다. 부르는 쪽의 거절은 stops가 알아보는 객체 하나다.
  const refusal = { outcome: "start_expired" };
  const isRefusal = (value: unknown): value is typeof refusal => value === refusal;
  const run = async (answer: unknown, starting: boolean) => {
    const trace: string[] = [];
    const holder = {
      sink: { send: async (_sent: Envelope) => (trace.push("send"), "sent") },
      beatValid: () => (trace.push("gate"), true),
    };
    const check = () => (trace.push("check"), answer) as never;
    const result = starting
      ? await sendInstruction(holder as never, envelope("task_start"), {
          at: LIMIT - 1,
          marker: { markStartDispatch: () => (trace.push("mark"), { ok: true, created: true }) } as never,
          lastCheck: check,
          stops: isRefusal,
        })
      : await sendInstruction(holder as never, envelope("run_renew"), null, { check, stops: isRefusal });
    return { result, trace };
  };

  test("undefined·숫자·남의 객체를 내면 표식 커밋 뒤에도 싣지 않고 check_malformed다. null은 싣고, 부르는 쪽의 거절은 stopped다", async () => {
    for (const starting of [true, false]) {
      const head = starting ? ["gate", "mark", "gate", "check"] : ["gate", "check"];
      for (const answer of [undefined, 0, 42, { outcome: "start_expired" }, "start_expired"]) {
        expect({ starting, answer, ...(await run(answer, starting)) }).toEqual({ starting, answer, result: { kind: "check_malformed" }, trace: head });
      }
      expect({ starting, ...(await run(refusal, starting)) }).toEqual({ starting, result: { kind: "stopped", value: refusal }, trace: head });
      expect({ starting, ...(await run(null, starting)) }).toEqual({ starting, result: { kind: "answered", answer: "sent" }, trace: [...head, "send"] });
    }
  });
});

describe("공유 송신 함수: 입력 객체의 칸은 진입 때 한 번 읽는다", () => {
  test("시작: 칸 하나의 접근자가 1ms를 쓰면 첫 유효 문이 만료 정각을 보고 표식·송신 0이다. 대조군(0ms)은 유효 문 → 표식 → 유효 문 → 마지막 확인 → 송신", async () => {
    for (const spot of [...HOLDER_SPOTS, ...START_SPOTS]) {
      const w = world(spot);
      const result = await sendInstruction(w.holder, envelope("task_start"), w.start);
      expect({ spot, result, trace: w.trace, reads: w.reads }).toEqual({ spot, result: { kind: "beat_closed" }, trace: [`gate@${LIMIT}`], reads: once([...HOLDER_SPOTS, ...START_SPOTS]) });
    }
    const w = world(null);
    const result = await sendInstruction(w.holder, envelope("task_start"), w.start);
    expect({ result, trace: w.trace, reads: w.reads }).toEqual({
      result: { kind: "answered", answer: "sent" },
      trace: ["gate@999", "mark@999", "gate@999", "check@999", "send@999"],
      reads: once([...HOLDER_SPOTS, ...START_SPOTS]),
    });
  });

  test("시작이 아님: 마지막 확인(plainCheck)은 유효 문 바로 뒤, 포트 호출 바로 앞이다. 칸의 1ms는 유효 문이 보고, 확인이 값을 내면 싣지 않는다", async () => {
    for (const spot of HOLDER_SPOTS) {
      const w = world(spot);
      const result = await sendInstruction(w.holder, envelope("run_renew"), null, w.plain(null));
      expect({ spot, result, trace: w.trace, reads: w.reads }).toEqual({ spot, result: { kind: "beat_closed" }, trace: [`gate@${LIMIT}`], reads: once(HOLDER_SPOTS) });
    }
    for (const [value, result, trace] of [
      [null, { kind: "answered", answer: "sent" }, ["gate@999", "check@999", "send@999"]],
      ["margin_lost", { kind: "stopped", value: "margin_lost" }, ["gate@999", "check@999"]],
    ] as [string | null, GateResult<string>, string[]][]) {
      const w = world(null);
      expect({ value, result: await sendInstruction(w.holder, envelope("run_renew"), null, w.plain(value)), trace: w.trace, reads: w.reads }).toEqual({ value, result, trace, reads: once(HOLDER_SPOTS) });
    }
  });
});

describe("공유 송신 함수: 봉투·확인·문 함수를 읽고 부르는 꼴", () => {
  // 칸마다 읽은 수를 세는 봉투. slow 칸을 얻을 때 1ms를 쓴다.
  const counted = (action: string, clock: { now: number }, reads: Record<string, number>, slow: "header" | "body" | null) =>
    ({
      get header() {
        reads.header = (reads.header ?? 0) + 1;
        if (slow === "header") clock.now += 1;
        return { action, request_id: "request-1" };
      },
      get body() {
        reads.body = (reads.body ?? 0) + 1;
        if (slow === "body") clock.now += 1;
        return { run_id: "run-1" };
      },
    }) as unknown as Envelope;

  test("봉투의 머리·본문은 한 번씩만 읽는다: 998에 들어와 머리나 본문을 얻는 데 1ms를 쓰면 첫 유효 문은 999에 열리고 표식·송신 1. 시작이 아니어도 진입 때 사본을 뜨므로 본문을 한 번 읽는다", async () => {
    for (const slow of ["header", "body"] as const) {
      const clock = { now: LIMIT - 2 };
      const reads: Record<string, number> = {};
      const trace: string[] = [];
      const holder = { sink: { send: async () => (trace.push(`send@${clock.now}`), "sent") }, beatValid: () => (trace.push(`gate@${clock.now}`), clock.now < LIMIT) };
      const start = { at: LIMIT - 2, marker: { markStartDispatch: () => (trace.push(`mark@${clock.now}`), { ok: true, created: true }) }, lastCheck: () => (trace.push(`check@${clock.now}`), null) };
      const result = await sendInstruction(holder as never, counted("task_start", clock, reads, slow), start as never);
      expect({ slow, result, trace, reads }).toEqual({ slow, result: { kind: "answered", answer: "sent" }, trace: ["gate@999", "mark@999", "gate@999", "check@999", "send@999"], reads: { header: 1, body: 1 } });
    }
    const clock = { now: LIMIT - 1 };
    const reads: Record<string, number> = {};
    const holder = { sink: { send: async () => "sent" }, beatValid: () => clock.now < LIMIT };
    const result = await sendInstruction(holder as never, counted("task_cancel", clock, reads, null), null);
    expect({ result, reads }).toEqual({ result: { kind: "answered", answer: "sent" }, reads: { header: 1, body: 1 } });
  });

  test("마지막 확인·거절 판별·박자 유효 문은 그 칸을 읽은 객체를 this로 부른다: 자기 상태를 읽는 클래스 메서드와 bind가 없는 함수도 그대로 불린다", async () => {
    class Start {
      readonly at = LIMIT - 1;
      readonly marker = { markStartDispatch: () => ({ ok: true, created: true }) };
      readonly #refusal = { outcome: "start_expired" };
      constructor(readonly answer: "send" | "refuse") {}
      lastCheck() {
        return this.answer === "send" ? null : this.#refusal;
      }
      stops(value: unknown): value is { outcome: string } {
        return value === this.#refusal;
      }
    }
    class Margin {
      readonly #refusal = { outcome: "renew_margin_lost" };
      constructor(readonly lost: boolean) {}
      check() {
        return this.lost ? this.#refusal : null;
      }
      stops(value: unknown): value is { outcome: string } {
        return value === this.#refusal;
      }
    }
    const holder: Record<string, unknown> = { sink: { send: async () => "sent" } };
    // 상속한 bind·call이 없는 문 함수. 수신자가 holder일 때만 연다.
    const bare = function (this: unknown) {
      return this === holder;
    };
    Object.setPrototypeOf(bare, null);
    holder.beatValid = bare;
    const results: unknown[] = [
      await sendInstruction(holder as never, envelope("task_start"), new Start("send") as never),
      await sendInstruction(holder as never, envelope("task_start"), new Start("refuse") as never),
      await sendInstruction(holder as never, envelope("run_renew"), null, new Margin(false) as never),
      await sendInstruction(holder as never, envelope("run_renew"), null, new Margin(true) as never),
    ];
    expect(results).toEqual([
      { kind: "answered", answer: "sent" },
      { kind: "stopped", value: { outcome: "start_expired" } },
      { kind: "answered", answer: "sent" },
      { kind: "stopped", value: { outcome: "renew_margin_lost" } },
    ]);
  });

  test("마지막 확인 칸의 꼴이 틀리면 표식·송신 전에 check_malformed다: plain의 check·stops가 함수가 아님, 시작의 lastCheck가 함수·undefined·null이 아님", async () => {
    const isText = (value: unknown): value is string => typeof value === "string";
    const cases: [string, Envelope, unknown, unknown][] = [
      ["plain.check undefined", envelope("run_renew"), null, { check: undefined, stops: isText }],
      ["plain.check null", envelope("run_renew"), null, { check: null, stops: isText }],
      ["plain.check 42", envelope("run_renew"), null, { check: 42, stops: isText }],
      ["plain.stops undefined", envelope("run_renew"), null, { check: () => null, stops: undefined }],
      ["start.lastCheck 42", envelope("task_start"), "start", null],
    ];
    for (const [name, sent, start, plain] of cases) {
      const trace: string[] = [];
      const holder = { sink: { send: async () => (trace.push("send"), "sent") }, beatValid: () => (trace.push("gate"), true) };
      const mark = start === null ? null : { at: LIMIT - 1, marker: { markStartDispatch: () => (trace.push("mark"), { ok: true, created: true }) }, lastCheck: 42 };
      const result = await sendInstruction(holder as never, sent, mark as never, plain as never);
      expect({ name, result, trace }).toEqual({ name, result: { kind: "check_malformed" }, trace: [] });
    }
  });

  test("장부 쓰기 인자 배열의 원소는 박자 유효 문 전에 읽는다: 원소 접근자가 1ms를 쓰면 유효 문이 그 시각을 보고 부르지 않는다. 대조군(0ms)은 부른다", () => {
    for (const cost of [1, 0]) {
      let now = LIMIT - 1;
      const order: string[] = [];
      const args: unknown[] = [];
      Object.defineProperty(args, 0, {
        enumerable: true,
        get() {
          now += cost;
          order.push(`arg@${now}`);
          return "input";
        },
      });
      const result = callAfterGate(() => ({ receiver: null, fn: (value: unknown) => (order.push(`call:${String(value)}@${now}`), "ok"), args }), () => (order.push(`gate@${now}`), now < LIMIT));
      expect({ cost, result, order }).toEqual(
        cost === 1
          ? { cost, result: { kind: "closed" }, order: [`arg@${LIMIT}`, `gate@${LIMIT}`] }
          : { cost, result: { kind: "called", value: "ok" }, order: ["arg@999", "gate@999", "call:input@999"] },
      );
    }
  });
});

describe("공유 송신 함수: 원래 봉투는 진입 뒤 다시 읽지 않고, 표식·판정·포트가 같은 데이터 사본을 쓴다", () => {
  // 실제 내보내기 포트(createWireSink)에 쓰기 면만 흉내 낸 서버를 붙인다. 포트는 받은 봉투를 정규 직렬화하므로, 원래 봉투를
  // 넘기면 그 직렬화가 머리·본문 접근자를 유효 문 뒤에 다시 부른다.
  const RECIPIENT = "executor/isolated_reader/r1/s1";
  const T0 = 1_800_000_000_000;
  const wire = () => {
    const frames: Uint8Array[] = [];
    const server = {
      recognized: () => 7,
      writeFrame(_connection: number, _principal: string, frame: Uint8Array, options: { lastCheck: () => string | null; finalCheck?: () => string | null }) {
        if (options.lastCheck() !== null) return { kind: "not_written", reason: "refused", refusal: "check" };
        if (options.finalCheck !== undefined && options.finalCheck() !== null) return { kind: "not_written", reason: "refused", refusal: "final" };
        frames.push(frame);
        return { kind: "written" };
      },
    };
    const sink = createWireSink({
      server: server as never,
      restorer: (() => ({ stopGeneration: () => 4, intakeOpen: () => true })) as never,
      withheld: { executors: () => ({ known: true, value: [] }) } as never,
      clock: { now: () => T0 },
      queries: { add() {}, remove() {} },
    } as never);
    // 실린 틀의 봉투 JSON(틀 머리 뒤의 글).
    const written = () =>
      frames.map((frame) => {
        const text = new TextDecoder().decode(frame);
        return JSON.parse(text.slice(text.indexOf("{"))) as { header: { request_id: string }; body: { run_id: string } };
      });
    return { sink: sink.sink, written };
  };
  // 머리·본문이 접근자인 시작 봉투. 읽을 때마다 trace에 적고, changing이면 읽을 때마다 다른 요청·실행 ID를 낸다.
  const accessorEnvelope = (trace: string[], changing: boolean) => {
    let headerReads = 0;
    let bodyReads = 0;
    return {
      get header() {
        headerReads += 1;
        trace.push("header");
        const suffix = changing ? String(headerReads) : "1";
        return {
          contract: "olive/v1",
          action: "task_start",
          sender: "supervisor",
          recipient: RECIPIENT,
          request_id: `00000000-0000-4000-8000-00000000000${suffix}`,
          stop_generation: 4,
          run_generation: 1,
          issued_at: T0,
          expires_at: T0 + 30_000,
          nonce: "0".repeat(32),
          body_digest: "0".repeat(64),
        };
      },
      get body() {
        bodyReads += 1;
        trace.push("body");
        const suffix = changing ? String(bodyReads) : "1";
        return { run_id: `11111111-1111-4111-8111-11111111111${suffix}`, deadline_at: T0 + 600_000 };
      },
      signature: "sig",
    } as unknown as Envelope;
  };
  const run = async (changing: boolean) => {
    const trace: string[] = [];
    const port = wire();
    const marked: { runId: string; requestId: string }[] = [];
    const received: unknown[] = [];
    const holder = {
      sink: {
        send(value: Envelope) {
          trace.push("sink.enter");
          received.push(value);
          return port.sink.send(value);
        },
      },
      beatValid: () => (trace.push("gate"), true),
    };
    const start = {
      at: T0,
      marker: { markStartDispatch: (input: { runId: string; requestId: string }) => (trace.push("mark"), marked.push({ runId: input.runId, requestId: input.requestId }), { ok: true, created: true }) },
    };
    const result = await sendInstruction(holder as never, accessorEnvelope(trace, changing), start as never);
    const sent = received.map((value) => {
      const envelope = value as { header: { request_id: string }; body: { run_id: string } };
      return { runId: envelope.body.run_id, requestId: envelope.header.request_id };
    });
    const framed = port.written().map((envelope) => ({ runId: envelope.body.run_id, requestId: envelope.header.request_id }));
    return { result, trace, afterGate: trace.slice(trace.indexOf("gate")).filter((step) => step === "header" || step === "body").length, marked, sent, framed };
  };

  test("머리·본문 접근자는 진입 때 한 번씩만 돌고, 첫 유효 문 뒤(표식·포트·실제 포트의 직렬화)에는 0회다. 포트가 받은 봉투와 실린 틀의 ID가 표식 ID와 같다", async () => {
    const seen = await run(false);
    const ids = { runId: "11111111-1111-4111-8111-111111111111", requestId: "00000000-0000-4000-8000-000000000001" };
    expect(seen).toEqual({
      result: { kind: "answered", answer: "sent" },
      trace: ["body", "header", "gate", "mark", "gate", "sink.enter"],
      afterGate: 0,
      marked: [ids],
      sent: [ids],
      framed: [ids],
    });
  });

  test("읽을 때마다 ID가 바뀌는 접근자여도 표식·포트가 받은 봉투·실린 틀의 ID가 모두 첫 읽기의 값으로 같다", async () => {
    const seen = await run(true);
    const ids = { runId: "11111111-1111-4111-8111-111111111111", requestId: "00000000-0000-4000-8000-000000000001" };
    expect({ afterGate: seen.afterGate, marked: seen.marked, sent: seen.sent, framed: seen.framed, result: seen.result }).toEqual({
      afterGate: 0,
      marked: [ids],
      sent: [ids],
      framed: [ids],
      result: { kind: "answered", answer: "sent" },
    });
  });

  test("데이터로 읽을 수 없는 봉투(머리 접근자가 던짐, 정규 직렬화가 받지 않는 값)는 표식·포트 호출 0이다", async () => {
    const throwing = {
      get header() {
        throw new Error("머리 읽기 실패");
      },
      body: {},
    } as unknown as Envelope;
    const odd = { header: { action: "task_cancel", request_id: "r" }, body: { run_id: "run-1", at: 1.5 } } as unknown as Envelope;
    for (const [name, sent, start] of [
      ["머리 던짐·시작 입력 있음", throwing, true],
      ["소수 본문·시작 아님", odd, false],
    ] as const) {
      const trace: string[] = [];
      const holder = { sink: { send: async () => (trace.push("send"), "sent") }, beatValid: () => (trace.push("gate"), true) };
      const mark = start ? { at: LIMIT - 1, marker: { markStartDispatch: () => (trace.push("mark"), { ok: true, created: true }) } } : null;
      const result = await sendInstruction(holder as never, sent, mark as never);
      expect({ name, result, trace }).toEqual({ name, result: { kind: "unmarked", markReason: start ? "envelope_unreadable" : "marker_missing" }, trace: [] });
    }
  });
});
