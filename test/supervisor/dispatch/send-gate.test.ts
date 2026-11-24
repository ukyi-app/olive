// 공유 송신 함수(send-gate.ts)가 입력을 읽는 시각. 입력 객체(holder·포트·start·표식 포트)의 칸은 진입 때 한 번 읽고, 박자 유효 문
// 뒤에는 쥔 함수·값만 쓴다. 칸마다 접근자를 두고 그중 하나가 1ms를 쓰게 해, 그 시간을 첫 유효 문이 보는지 잰다.
// 기한은 1,000(정각 포함 닫힘), 진입 전 시각은 999다.
import { describe, expect, test } from "bun:test";
import type { Envelope } from "../../../src/contract/v1/index.ts";
import { type GateResult, sendInstruction } from "../../../src/supervisor/dispatch/send-gate.ts";

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
