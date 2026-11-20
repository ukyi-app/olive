// 취소 포트 어댑터(cancel.ts). 실제 장부 파일(임시 폴더)과 실제 처리기(tools.ts)에 잇고, 연결·서명·내보내기·관측은 시험 안의 대역이다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type Envelope, sealEnvelope } from "../../../src/contract/v1/index.ts";
import { type Ledger, LedgerInputError } from "../../../src/ledger/index.ts";
import { type CancelDelivery, type CancelLedger, type CancelPorts, cancelAdapter } from "../../../src/supervisor/dispatch/cancel.ts";
import type { SendOutcome } from "../../../src/supervisor/dispatch/ports.ts";
import { type Answer, type CancelInput, type CancelWrite, handleToolCall, type ToolPorts, type WorkRecord } from "../../../src/supervisor/scheduler/tools.ts";
import { digest, from, id, must, NOW, open, ready, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";

// ID·키·digest는 이 시험이 고른 값이다. 운영값이 아니다.
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const SRC = "inbox/aaaaaaaa-1111-4000-8000-000000000001";
const SESSION = { id: "session-1", generation: 1 };
const keys = generateKeyPairSync("ed25519");

interface World {
  ledger: Ledger;
  path: string;
  ports: CancelPorts;
  cancel: (input: CancelInput) => Answer<CancelWrite>;
  log: string[];
  sent: Envelope[];
  events: CancelDelivery[];
  sendCalls(): number;
  wrap(over: Partial<CancelLedger>): void;
  setLink(next: () => unknown): void;
  setSend(next: () => unknown): void;
  setSigner(next: "real" | "throw" | "garbage"): void;
  // 다음 난수 읽기들(길이가 맞아야 한다). 다 쓰면 실제 난수다.
  queueBytes(...values: Uint8Array[]): void;
  setObserve(next: (event: CancelDelivery) => void): void;
}

function world(): World {
  const path = tempPath();
  const ledger = ready(open(path));
  must(ledger.enqueueInput({ requestId: OWNER, source: "admin-dm", sourceRef: { ref: SRC, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
  const log: string[] = [];
  const sent: Envelope[] = [];
  const events: CancelDelivery[] = [];
  let calls = 0;
  let override: Partial<CancelLedger> = {};
  let link: () => unknown = () => ({ ok: true });
  let send: () => unknown = async () => "sent";
  let signer: "real" | "throw" | "garbage" = "real";
  const bytes: Uint8Array[] = [];
  let observe = (event: CancelDelivery) => {
    events.push(event);
  };
  const port = (name: keyof CancelLedger) =>
    ((...args: unknown[]) => {
      log.push(name);
      const fn = (override[name] ?? ledger[name].bind(ledger)) as (...a: unknown[]) => unknown;
      return fn(...args);
    }) as never;
  const ports: CancelPorts = {
    ledger: { cancelToolRequest: port("cancelToolRequest"), unansweredInstructions: port("unansweredInstructions") },
    links: {
      mayIssue: (executorId, action) => {
        log.push(`mayIssue:${executorId}:${action}`);
        return link() as never;
      },
    },
    clock: { now: () => NOW },
    random: { bytes: (length) => bytes.shift() ?? getRandomValues(new Uint8Array(length)) },
    signer: {
      seal(input) {
        log.push("seal");
        if (signer === "throw") throw new Error("서명 포트 실패");
        if (signer === "garbage") return { header: {}, signature: "x", body: {} } as never;
        return sealEnvelope(input, keys.privateKey);
      },
    },
    sink: {
      send: (envelope) => {
        log.push("send");
        calls += 1;
        const outcome = send();
        return Promise.resolve(outcome).then((value) => {
          if (value === "sent") sent.push(envelope);
          return value as SendOutcome;
        });
      },
    },
    observe: (event) => observe(event),
  };
  return {
    ledger,
    path,
    ports,
    cancel: cancelAdapter(ports),
    log,
    sent,
    events,
    sendCalls: () => calls,
    wrap: (over) => {
      override = over;
    },
    setLink: (next) => {
      link = next;
    },
    setSend: (next) => {
      send = next;
    },
    setSigner: (next) => {
      signer = next;
    },
    queueBytes: (...values) => {
      bytes.push(...values);
    },
    setObserve: (next) => {
      observe = next;
    },
  };
}

// 작업 부탁 하나. 배정 전 대기다.
function waiting(w: World): string {
  return must(
    w.ledger.recordToolRequest({
      ref: id(),
      owner: OWNER,
      dedupeKey: `start_worker:${OWNER}:${id()}`,
      role: "diagnosis",
      purpose: "diagnose",
      sourceRef: SRC,
      inputDigest: digest("input"),
      sessionId: SESSION.id,
      callId: id(),
      now: NOW,
    }),
  ).request.ref;
}

// 부탁을 실행 줄에 잇는다. start면 시작 지시까지 적는다(preparing).
function linked(w: World, start = true) {
  const ref = waiting(w);
  const base = worker();
  const run = must(
    w.ledger.assignToolRequest({
      ref,
      runId: id(),
      snapshotDigest: base.snapshotDigest as string,
      profileRevision: base.profileRevision,
      policyRevision: base.policyRevision,
      executorId: base.executorId,
      credential: base.credential,
      deadlineAt: base.deadlineAt,
      budgetLeft: base.budgetLeft,
      now: NOW,
    }),
  ).run;
  if (start) must(w.ledger.startRun({ runId: run.runId, requestId: id(), stopGeneration: 0, now: NOW }));
  return { ref, run };
}

const input = (ref: string, over: Partial<CancelInput> = {}): CancelInput => ({ ref, owner: OWNER, sessionId: SESSION.id, callId: id(), now: NOW, ...over });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const STOPPING: Answer<CancelWrite> = { known: true, value: { ok: true, phase: "stopping" } };

// 장부 파일의 지시 줄을 장부 밖에서 직접 읽는다. 장부가 열려 있으면 파일이 잠겨 있어 먼저 닫는다(그 뒤로 이 장부를 쓰지 않는다).
function cancelRows(w: World, runId: string): { request_id: string; stop_generation: number; reason: string | null }[] {
  w.ledger.close();
  const raw = new Database(w.path, { readonly: true });
  try {
    return raw.query(`SELECT request_id, stop_generation, reason FROM instructions WHERE run_id = ? AND action = 'task_cancel' ORDER BY issued_at, request_id`).all(runId) as never;
  } finally {
    raw.close();
  }
}

function unansweredIds(ledger: Ledger): string[] {
  const read = ledger.unansweredInstructions();
  if (!read.known) throw new Error("읽지 못함");
  return read.value.instructions.filter((i) => i.action === "task_cancel").map((i) => i.requestId);
}

// 실제 처리기(handleToolCall)의 포트. 취소 포트만 이 어댑터이고 나머지는 cancel_worker가 지나가는 데 필요한 만큼만 채운다.
function toolPortsFor(w: World): ToolPorts {
  return {
    config: { purposeBriefMaxChars: 200 },
    policy: { judge: () => "allowed" },
    ledger: {
      liveSession: () => ({ known: true, value: SESSION }),
      inputPinned: () => ({ known: true, value: true }),
      findByRetryKey: () => ({ known: true, value: null }),
      readOwnedWork: (q) => {
        const read = w.ledger.readToolRequest({ owner: q.owner, ref: q.ref });
        if (!read.known || read.value === null) return read.known ? { known: true, value: null } : { known: false };
        const r = read.value;
        const record: WorkRecord = { ref: r.ref, owner: r.owner, retryKey: r.dedupeKey, content: { role: r.role, purpose: r.purpose, sourceRef: r.sourceRef, inputDigest: r.inputDigest }, phase: r.phase };
        return { known: true, value: record };
      },
      readResult: () => ({ known: true, value: { state: "none" } }),
      recordStart: () => ({ known: false }),
      requestCancel: w.cancel,
    },
  };
}

const toolContext = (callId: string = id()) => ({ session: SESSION, requestId: OWNER, callId, now: NOW, stop: { known: true as const, stopped: false } });

// ---- 보장 1: 장부가 적은 것만, 적은 그대로 ----

test("처리기의 취소는 장부에 적은 지시 줄의 값 그대로 지정 실행기에 한 번 나간다", async () => {
  const w = world();
  const { ref, run } = linked(w);
  const toolPorts = toolPortsFor(w);
  const callId = id();
  const ctx = toolContext(callId);
  expect(handleToolCall("cancel_worker", { ref }, ctx, toolPorts)).toEqual({ outcome: "ok", tool: "cancel_worker", ref, cancel: "accepted", phase: "stopping" });
  await flush();

  const rows = cancelRows(w, run.runId);
  expect(rows).toHaveLength(1);
  const row = rows[0] as (typeof rows)[number];
  expect(w.sent).toHaveLength(1);
  const envelope = w.sent[0] as Envelope;
  // 요청 ID는 장부의 지시 줄 그대로이고, 처리기 문맥의 호출 ID가 아니라 난수 포트에서 온 새 UUID다.
  expect(envelope.header.request_id).toBe(row.request_id);
  expect(row.request_id).not.toBe(callId);
  expect(envelope.header).toMatchObject({ action: "task_cancel", recipient: WORKER_EXECUTOR, stop_generation: row.stop_generation, run_generation: run.runGeneration, issued_at: NOW });
  expect(envelope.body).toEqual({ run_id: run.runId, reason: "requested" });
  expect(row.reason).toBe("requested");
  // 장부에 적은 뒤 그 줄을 다시 읽고, 연결을 본 뒤에만 봉하고 싣는다.
  expect(w.log).toEqual(["cancelToolRequest", "unansweredInstructions", `mayIssue:${WORKER_EXECUTOR}:task_cancel`, "seal", "send"]);
  expect(w.events).toEqual([{ outcome: "sent", ref, requestId: row.request_id, runId: run.runId, executorId: WORKER_EXECUTOR }]);
});

test("지시가 없는 취소(배정 전 대기, 시작 전 실행)는 아무것도 내보내지 않는다", async () => {
  const w = world();
  const ref = waiting(w);
  const queued = linked(w, false);
  expect(w.cancel(input(ref))).toEqual({ known: true, value: { ok: true, phase: "not_started" } });
  expect(w.cancel(input(queued.ref))).toEqual({ known: true, value: { ok: true, phase: "not_started" } });
  await flush();
  expect(w.log).toEqual(["cancelToolRequest", "cancelToolRequest"]);
  expect(w.events.map((e) => e.outcome)).toEqual(["nothing_to_send", "nothing_to_send"]);
  expect(w.ledger.getRun(queued.run.runId)).toMatchObject({ known: true, value: { state: "not_started" } });
});

// ---- 보장 2: 장부의 답 갈래마다 처리기에 주는 답 ----

test("장부의 답 갈래마다 처리기의 답은 표대로이고, 적었다고 확인되지 않으면 내보내지 않는다", async () => {
  const instruction = (over: Record<string, unknown> = {}) => (requestId: string) => ({ runId: id(), requestId, stopGeneration: 0, ...over });
  type Case = [string, ((callId: string) => unknown) | "throw" | "throw_input", Answer<CancelWrite>, CancelDelivery["outcome"]];
  const cases: Case[] = [
    ["not_started", () => ({ ok: true, phase: "not_started" }), { known: true, value: { ok: true, phase: "not_started" } }, "nothing_to_send"],
    ["transition_denied", () => ({ ok: false, reason: "transition_denied" }), { known: true, value: { ok: false, reason: "already_ended" } }, "refused"],
    ["stop_unknown", () => ({ ok: false, reason: "stop_unknown" }), { known: false }, "refused"],
    ["invariant_violation", () => ({ ok: false, reason: "invariant_violation" }), { known: false }, "refused"],
    ["unknown_run", () => ({ ok: false, reason: "unknown_run" }), { known: false }, "refused"],
    ["ledger_unwritable", () => ({ ok: false, reason: "ledger_unwritable" }), { known: false }, "refused"],
    ["예외", "throw", { known: false }, "record_unknown"],
    ["입력 오류", "throw_input", { known: false }, "record_unknown"],
    ["객체 아님", () => null, { known: false }, "record_unknown"],
    ["ok 꼴 틀림", () => ({ ok: "yes" }), { known: false }, "record_unknown"],
    ["모르는 거절 이름", () => ({ ok: false, reason: "nope" }), { known: false }, "record_unknown"],
    ["다른 단계", () => ({ ok: true, phase: "running" }), { known: false }, "record_unknown"],
    ["지시 없는 stopping", () => ({ ok: true, phase: "stopping" }), { known: false }, "record_unknown"],
    ["지시를 실은 not_started", (c) => ({ ok: true, phase: "not_started", instruction: instruction()(c) }), { known: false }, "record_unknown"],
    ["다른 요청 ID", () => ({ ok: true, phase: "stopping", instruction: instruction()(id()) }), { known: false }, "record_unknown"],
    ["정지 세대 없음", (c) => ({ ok: true, phase: "stopping", instruction: instruction({ stopGeneration: null })(c) }), { known: false }, "record_unknown"],
    ["정지 세대 음수", (c) => ({ ok: true, phase: "stopping", instruction: instruction({ stopGeneration: -1 })(c) }), { known: false }, "record_unknown"],
    ["실행 ID 꼴 틀림", (c) => ({ ok: true, phase: "stopping", instruction: instruction({ runId: "run" })(c) }), { known: false }, "record_unknown"],
  ];
  for (const [name, answer, expected, outcome] of cases) {
    const w = world();
    w.wrap({
      cancelToolRequest: ((args: { callId: string }) => {
        if (answer === "throw") throw new Error("디스크");
        if (answer === "throw_input") throw new LedgerInputError("cancelToolRequest: 꼴");
        return answer(args.callId);
      }) as never,
    });
    expect([name, w.cancel(input(id()))]).toEqual([name, expected]);
    await flush();
    expect([name, w.log]).toEqual([name, ["cancelToolRequest"]]);
    expect([name, w.events.map((e) => e.outcome)]).toEqual([name, [outcome]]);
  }
});

test("실제 장부: 끝난 실행은 already_ended, 같은 호출 ID·남의 부탁·닫힌 장부는 모름이고 내보내지 않는다", async () => {
  const w = world();
  const { ref, run } = linked(w);
  // 난수 포트가 같은 값을 두 번 주면 같은 호출 ID라 장부가 invariant_violation으로 막는다. 두 번째는 아무것도 싣지 않는다.
  const same = getRandomValues(new Uint8Array(16));
  w.queueBytes(Uint8Array.from(same));
  expect(w.cancel(input(ref))).toEqual(STOPPING);
  await flush();
  w.queueBytes(Uint8Array.from(same));
  expect(w.cancel(input(ref))).toEqual({ known: false });
  await flush();
  expect(w.sendCalls()).toBe(1);
  expect(w.events.at(-1)).toMatchObject({ outcome: "refused", reason: "invariant_violation" });

  // 남의 부탁은 없는 부탁과 같은 unknown_run이다.
  expect(w.cancel(input(ref, { owner: "bbbbbbbb-0000-4000-8000-000000000002" }))).toEqual({ known: false });
  expect(w.events.at(-1)).toMatchObject({ outcome: "refused", reason: "unknown_run" });

  // 종료가 확인되면 이미 끝난 부탁이다.
  must(w.ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: run.runId, exit: "failed", bodyDigest: digest("stopped"), now: NOW }, from(run)));
  expect(w.cancel(input(ref))).toEqual({ known: true, value: { ok: false, reason: "already_ended" } });

  w.ledger.close();
  expect(w.cancel(input(ref))).toEqual({ known: false });
  expect(w.events.at(-1)).toMatchObject({ outcome: "refused", reason: "ledger_unwritable" });
  await flush();
  expect(w.sendCalls()).toBe(1);
});

test("장부를 부르기 전의 실패(입력·난수·시계)는 모름이고 장부를 부르지 않는다", () => {
  const w = world();
  expect(w.cancel({ ...input(id()), ref: 7 } as never)).toEqual({ known: false });
  w.queueBytes(new Uint8Array(3));
  expect(w.cancel(input(id()))).toEqual({ known: false });
  const broken = cancelAdapter({ ...w.ports, clock: { now: () => Number.NaN } });
  expect(broken(input(id()))).toEqual({ known: false });
  expect(w.log).toEqual([]);
  expect(w.events.map((e) => (e.outcome === "not_recorded" ? e.reason : e.outcome))).toEqual(["input_malformed", "random_unavailable", "clock_unavailable"]);
});

// ---- 보장 3: 전달 실패는 답을 바꾸지 않고 다시 보내지 않는다 ----

test("적은 뒤의 전달 실패는 처리기의 답을 바꾸지 않고, 다시 보내지 않으며, 지시는 재전송 읽기에 남는다", async () => {
  type Mode = [string, (w: World) => void, Record<string, unknown>, number];
  const modes: Mode[] = [
    ["연결 없음", (w) => w.setLink(() => ({ ok: false, reason: "lost" })), { outcome: "recorded_not_sent", reason: "no_connection" }, 0],
    ["연결 포트 예외", (w) => w.setLink(() => { throw new Error("link"); }), { outcome: "recorded_not_sent", reason: "link_unknown" }, 0],
    ["연결 답 꼴 틀림", (w) => w.setLink(() => ({ ok: false })), { outcome: "recorded_not_sent", reason: "link_unknown" }, 0],
    ["서명 예외", (w) => w.setSigner("throw"), { outcome: "recorded_not_sent", reason: "seal_threw" }, 0],
    ["서명 꼴 틀림", (w) => w.setSigner("garbage"), { outcome: "recorded_not_sent", reason: "signer_mismatch" }, 0],
    ["내보내기 no_connection", (w) => w.setSend(() => "no_connection"), { outcome: "recorded_not_sent", reason: "no_connection" }, 1],
    ["내보내기 too_late_to_send", (w) => w.setSend(() => "too_late_to_send"), { outcome: "recorded_not_sent", reason: "too_late_to_send" }, 1],
    ["내보내기 동기 예외", (w) => w.setSend(() => { throw new Error("socket"); }), { outcome: "delivery_unknown", reason: "send_threw" }, 1],
    ["내보내기 거부", (w) => w.setSend(() => Promise.reject(new Error("socket"))), { outcome: "delivery_unknown", reason: "send_threw" }, 1],
    ["내보내기 답 꼴 틀림", (w) => w.setSend(() => "maybe"), { outcome: "delivery_unknown", reason: "send_answer_malformed" }, 1],
    ["다시 읽기 모름", (w) => w.wrap({ unansweredInstructions: () => ({ known: false, reason: "io" }) }), { outcome: "recorded_not_sent", reason: "read_unknown", executorId: null }, 0],
    ["다시 읽기 예외", (w) => w.wrap({ unansweredInstructions: () => { throw new Error("read"); } }), { outcome: "recorded_not_sent", reason: "read_unknown" }, 0],
    ["관측 포트 예외", (w) => w.setObserve(() => { throw new Error("observe"); }), {}, 1],
  ];
  for (const [name, arrange, event, sends] of modes) {
    const w = world();
    const { ref, run } = linked(w);
    arrange(w);
    expect([name, w.cancel(input(ref))]).toEqual([name, STOPPING]);
    await flush();
    await flush();
    expect([name, w.sendCalls()]).toEqual([name, sends]);
    // 이 지시는 영수증이 없어 재전송 읽기에 같은 요청 ID로 남는다(재전송 박자의 몫).
    const unanswered = unansweredIds(w.ledger);
    const rows = cancelRows(w, run.runId);
    expect([name, rows.length]).toEqual([name, 1]);
    const requestId = (rows[0] as { request_id: string }).request_id;
    expect([name, unanswered]).toEqual([name, [requestId]]);
    if (Object.keys(event).length > 0) {
      expect([name, w.events]).toEqual([name, [expect.objectContaining({ ref, requestId, runId: run.runId, ...event })]]);
    }
  }
});

// 관측 포트에는 async 함수도 대입된다. 그 약속의 거부를 아무도 받지 않으면 처리되지 않은 거절이 되어 Bun이 프로세스를 내리고,
// bun test는 그것을 실패로 센다. 그래서 이 시험은 전역 처리기 없이 런타임의 감지에 맡기고, 거부가 일어날 때까지 기다린다.
test("관측이 비동기로 거부돼도 처리되지 않은 거절이 남지 않고, 본체의 답·지시 줄·발송 수는 그대로다", async () => {
  const cases: [string, (w: World) => void, CancelDelivery["outcome"], number][] = [
    ["연결이 끊긴 채", (w) => w.setLink(() => ({ ok: false, reason: "lost" })), "recorded_not_sent", 0],
    ["전송 성공 뒤", () => {}, "sent", 1],
  ];
  for (const [name, arrange, outcome, sends] of cases) {
    const w = world();
    const { ref, run } = linked(w);
    arrange(w);
    const seen: CancelDelivery["outcome"][] = [];
    w.setObserve(async (event) => {
      seen.push(event.outcome);
      throw new Error("관측 저장 실패");
    });
    expect([name, handleToolCall("cancel_worker", { ref }, toolContext(), toolPortsFor(w))]).toEqual([
      name,
      { outcome: "ok", tool: "cancel_worker", ref, cancel: "accepted", phase: "stopping" },
    ]);
    await flush();
    await flush();
    expect([name, seen]).toEqual([name, [outcome]]);
    expect([name, w.sendCalls()]).toEqual([name, sends]);
    expect([name, cancelRows(w, run.runId).length]).toEqual([name, 1]);
  }
});

// ---- 보장 4: 순수하고 닫힌다 ----

test("직접 호출의 꼴이 틀린 참조·소유자·세션은 관측에 원문으로 실리지 않는다", async () => {
  const w = world();
  const odd = "sample-private-text-for-review";
  const oddOwner = "sample-private-owner-for-review";
  const oddSession = "sample-private-session-for-review";
  const valid = id();
  expect(w.cancel(input(odd))).toEqual({ known: false });
  expect(w.cancel(input(odd, { owner: 7 as never }))).toEqual({ known: false });
  expect(w.cancel(input(valid, { owner: oddOwner, sessionId: oddSession }))).toEqual({ known: false });
  await flush();
  expect(w.sendCalls()).toBe(0);
  expect(w.events.map((e) => [e.outcome, e.ref])).toEqual([
    ["record_unknown", null],
    ["not_recorded", null],
    ["record_unknown", valid],
  ]);
  const seen = JSON.stringify(w.events);
  for (const raw of [odd, oddOwner, oddSession]) expect(seen).not.toContain(raw);
});

test("지금 정지 세대를 모르거나 바뀌었거나 지시 줄이 맞지 않으면 내보내지 않는다(답은 적힌 그대로)", async () => {
  const cases: [string, (value: { stopGeneration: number | null; instructions: Record<string, unknown>[] }) => unknown, string][] = [
    ["세대 모름", (v) => ({ ...v, stopGeneration: null }), "stop_generation_unknown"],
    ["세대 꼴 틀림", (v) => ({ ...v, stopGeneration: "0" }), "read_unknown"],
    ["세대 바뀜", (v) => ({ ...v, stopGeneration: (v.stopGeneration as number) + 1 }), "stop_generation_changed"],
    ["줄 없음", (v) => ({ ...v, instructions: [] }), "instruction_not_found"],
    ["줄 둘", (v) => ({ ...v, instructions: [...v.instructions, ...v.instructions] }), "instruction_mismatch"],
    ["다른 실행", (v) => ({ ...v, instructions: v.instructions.map((i) => ({ ...i, runId: id() })) }), "instruction_mismatch"],
    ["다른 줄의 세대", (v) => ({ ...v, instructions: v.instructions.map((i) => ({ ...i, stopGeneration: 9 })) }), "instruction_mismatch"],
    ["실행 세대 0", (v) => ({ ...v, instructions: v.instructions.map((i) => ({ ...i, runGeneration: 0 })) }), "instruction_mismatch"],
    ["다시 만들 수 없음", (v) => ({ ...v, instructions: v.instructions.map((i) => ({ ...i, rebuild: null })) }), "not_rebuildable"],
    ["사유 밖", (v) => ({ ...v, instructions: v.instructions.map((i) => ({ ...i, rebuild: { action: "task_cancel", reason: "whim" } })) }), "not_rebuildable"],
  ];
  for (const [name, bend, reason] of cases) {
    const w = world();
    const { ref } = linked(w);
    w.wrap({
      unansweredInstructions: () => {
        const read = w.ledger.unansweredInstructions();
        if (!read.known) return read;
        return { known: true, value: bend(read.value as never) } as never;
      },
    });
    expect([name, w.cancel(input(ref))]).toEqual([name, STOPPING]);
    await flush();
    expect([name, w.log.includes("seal") || w.log.includes("send")]).toEqual([name, false]);
    expect([name, w.events.map((e): string => (e.outcome === "recorded_not_sent" ? e.reason : e.outcome))]).toEqual([name, [reason]]);
  }
});

test("같은 부탁의 취소를 두 번(다른 호출 ID) 부르면 장부의 지시 줄마다 그 요청 ID로 한 번씩 나간다", async () => {
  const w = world();
  const { ref, run } = linked(w);
  expect(w.cancel(input(ref))).toEqual(STOPPING);
  expect(w.cancel(input(ref))).toEqual(STOPPING);
  await flush();
  const unanswered = unansweredIds(w.ledger);
  const rows = cancelRows(w, run.runId);
  expect(rows).toHaveLength(2);
  expect(new Set(w.sent.map((e) => e.header.request_id))).toEqual(new Set(rows.map((r) => r.request_id)));
  expect(new Set(unanswered)).toEqual(new Set(rows.map((r) => r.request_id)));
  expect(w.sendCalls()).toBe(2);
});

test("수명 박자가 먼저 적은 종료 뒤의 취소도 장부가 둘째 줄을 받고, 어댑터는 그 줄만 보낸다", async () => {
  const w = world();
  const { ref, run } = linked(w);
  const deadline = id();
  must(w.ledger.recordStopInstruction({ runId: run.runId, requestId: deadline, action: "task_cancel", stopGeneration: 0, now: NOW - 1, reason: "deadline" }));
  expect(w.cancel(input(ref))).toEqual(STOPPING);
  await flush();
  const rows = cancelRows(w, run.runId);
  expect(rows.map((r) => r.reason)).toEqual(["deadline", "requested"]);
  expect(w.sent.map((e) => e.header.request_id)).toEqual([(rows[1] as { request_id: string }).request_id]);
  expect(w.sent.map((e) => e.header.request_id)).not.toContain(deadline);
});

test("입력을 바꾸지 않고 관측에 자격 참조·봉투·서명·nonce를 싣지 않는다", async () => {
  const w = world();
  const { ref } = linked(w);
  const frozen = Object.freeze(input(ref));
  const before = JSON.stringify(frozen);
  expect(w.cancel(frozen)).toEqual(STOPPING);
  await flush();
  expect(JSON.stringify(frozen)).toBe(before);
  const envelope = w.sent[0] as Envelope;
  const seen = JSON.stringify(w.events);
  for (const secret of [worker().credential.digest, worker().credential.account, envelope.signature, envelope.header.nonce, SRC]) expect(seen).not.toContain(secret);
});

test("이 모듈은 시계·난수·소켓·타이머를 직접 부르지 않는다", async () => {
  const source = await Bun.file(new URL("../../../src/supervisor/dispatch/cancel.ts", import.meta.url)).text();
  for (const banned of ["Date.now", "new Date", "performance.now", "Math.random", "randomUUID", "getRandomValues", "setTimeout", "setInterval", "node:", "bun:", "Bun.", "process.", "fetch("]) {
    expect(source).not.toContain(banned);
  }
});
