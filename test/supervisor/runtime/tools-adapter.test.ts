// 도구 어댑터(src/supervisor/runtime/tools-adapter.ts). 실제 임시 장부(공개 함수로만)와 실제 처리기(handleToolCall)·실제 취소 어댑터로 돈다.
// 장부가 던지거나 꼴이 틀린 줄을 주는 칸만 장부의 같은 함수를 감싼 대역으로 만든다(실제 장부는 손상 없이 그런 답을 내지 않는다).
// 닫힌 포트 둘(liveSession, inputPinned)을 여는 것은 시험의 대역이다: 이 공장은 그 둘을 늘 모름으로 둔다.
import { expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type Envelope, sealEnvelope } from "../../../src/contract/v1/index.ts";
import { type Ledger, REFUSALS } from "../../../src/ledger/index.ts";
import { RESTORE_KEY } from "../../../src/ledger/ledger.ts";
import type { CancelDelivery } from "../../../src/supervisor/dispatch/cancel.ts";
import { CLOSED_PORTS, createToolPorts, LINKED_PORTS, type ToolAdapterDeps, type ToolLedger } from "../../../src/supervisor/runtime/tools-adapter.ts";
import { handleToolCall, type ToolAnswer, type ToolCallContext, type ToolLedgerPort, type ToolPorts } from "../../../src/supervisor/scheduler/tools.ts";
import { readText } from "../../files.ts";
import { digest, id, must, NOW, open, ready, tempPath, worker } from "../../ledger/helpers.ts";

// ID·digest·키는 이 시험이 고른 값이다. 운영값이 아니다.
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const STRANGER = "cccccccc-0000-4000-8000-000000000003";
const SRC_A = "inbox/aaaaaaaa-1111-4000-8000-000000000001";
const SRC_B = "inbox/bbbbbbbb-1111-4000-8000-000000000002";
const SRC_OTHER = "inbox/dddddddd-1111-4000-8000-000000000004";
const D1 = digest("input one");
const SESSION = { id: "session-1", generation: 1 };
const MISSING = "eeeeeeee-0000-4000-8000-00000000000e";
const keys = generateKeyPairSync("ed25519");
const NAMES = ["findToolRequest", "readToolRequest", "recordToolRequest", "cancelToolRequest", "unansweredInstructions"] as const;
type Name = (typeof NAMES)[number];
type Fn = (...args: never[]) => unknown;

const keyOf = (owner: string) => `start_worker:${owner}:diagnose`;

interface World {
  ledger: Ledger;
  ports: ToolPorts;
  // 장부 함수를 부른 차례(이름).
  calls: Name[];
  // 이름마다 대역. 비어 있으면 실제 장부의 함수다.
  over: Partial<Record<Name, Fn>>;
  events: CancelDelivery[];
  sent: Envelope[];
  // 다음 난수 읽기들. 다 쓰면 실제 난수다.
  bytes: Uint8Array[];
}

// prepare: 장부를 연 뒤 할 일. 기본은 복원을 다 거친 장부에 소유자 둘(A, B)을 접수한다.
function world(prepare: (ledger: Ledger) => void = withOwners): World {
  const ledger = open(tempPath());
  prepare(ledger);
  const calls: Name[] = [];
  const over: Partial<Record<Name, Fn>> = {};
  const events: CancelDelivery[] = [];
  const sent: Envelope[] = [];
  const bytes: Uint8Array[] = [];
  const spy = Object.fromEntries(
    NAMES.map((name) => [
      name,
      (...args: never[]) => {
        calls.push(name);
        const fn = (over[name] ?? (ledger[name] as Fn).bind(ledger)) as Fn;
        return fn(...args);
      },
    ]),
  ) as unknown as ToolLedger;
  const deps: ToolAdapterDeps = {
    ledger: spy,
    policy: { judge: (role, purpose) => (role === "diagnosis" && purpose === "diagnose" ? "allowed" : "purpose_not_allowed") },
    config: { purposeBriefMaxChars: 200 },
    random: { bytes: (length) => bytes.shift() ?? getRandomValues(new Uint8Array(length)) },
    cancel: {
      links: { mayIssue: () => ({ ok: true }) },
      clock: { now: () => NOW },
      signer: { seal: (input) => sealEnvelope(input, keys.privateKey) },
      sink: {
        send: async (envelope) => {
          sent.push(envelope);
          return "sent";
        },
      },
      observe: (event) => {
        events.push(event);
      },
    },
  };
  return { ledger, ports: createToolPorts(deps), calls, over, events, sent, bytes };
}

function withOwners(ledger: Ledger): void {
  ready(ledger);
  must(ledger.enqueueInput({ requestId: A, source: "admin-dm", sourceRef: { ref: SRC_A, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
  must(ledger.enqueueInput({ requestId: B, source: "admin-dm", sourceRef: { ref: SRC_B, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
}

// 닫힌 포트 둘을 연 처리기 포트. 세션 계약(U6)과 입력 고정 연산이 생긴 뒤의 모습을 시험하려는 대역이고, 나머지 포트는 공장의 것 그대로다.
function opened(ports: ToolPorts, over: Partial<ToolLedgerPort> = {}): ToolPorts {
  return {
    ...ports,
    ledger: {
      ...ports.ledger,
      liveSession: () => ({ known: true, value: SESSION }),
      inputPinned: () => ({ known: true, value: true }),
      ...over,
    },
  };
}

function ctx(owner: string, over: Partial<ToolCallContext> = {}): ToolCallContext {
  return { session: SESSION, requestId: owner, callId: id(), now: NOW, stop: { known: true, stopped: false }, ...over };
}

const startArgs = (sourceRef: string) => ({ role: "diagnosis", task: { purpose: "diagnose", brief: "파드 재시작 원인을 찾는다", source_ref: sourceRef, input_digest: D1 } });
const refArgs = (ref: string) => ({ ref });
const unknown = (tool: string): ToolAnswer => ({ outcome: "unknown", tool });
const refused = (tool: string, reason: string): ToolAnswer => ({ outcome: "refused", tool, reason: reason as never, field: null });

// 장부에 적힌 것: 대기 부탁, 실행 줄, 답 없는 지시를 공개 읽기로 한 번에 본다. 같으면 이 사이에 아무것도 적히지 않았다.
function written(ledger: Ledger): string {
  return JSON.stringify([ledger.listWaitingToolRequests(), ledger.listRuns(), ledger.unansweredInstructions()]);
}

// 소유자의 대기 부탁 하나를 장부에 바로 적는다(처리기를 거치지 않는다).
function waiting(ledger: Ledger, owner: string, dedupeKey = keyOf(owner)): string {
  const sourceRef = owner === A ? SRC_A : SRC_B;
  return must(
    ledger.recordToolRequest({
      ref: id(),
      owner,
      dedupeKey,
      role: "diagnosis",
      purpose: "diagnose",
      sourceRef,
      inputDigest: D1,
      sessionId: SESSION.id,
      callId: id(),
      now: NOW,
    }),
  ).request.ref;
}

// 부탁을 실행 줄에 잇고, start면 시작 지시까지 적는다(preparing). 아니면 시작 전(queued)이다.
function running(ledger: Ledger, owner: string, start = true): { ref: string; runId: string } {
  const ref = waiting(ledger, owner, `start_worker:${owner}:run-${id()}`);
  const base = worker();
  const run = must(
    ledger.assignToolRequest({
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
  if (start) must(ledger.startRun({ runId: run.runId, requestId: id(), stopGeneration: 0, now: NOW }));
  return { ref, runId: run.runId };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// 장부 줄(ToolRequest) 꼴의 대역 값.
const row = (over: Record<string, unknown> = {}) => ({
  ref: MISSING,
  owner: A,
  dedupeKey: keyOf(A),
  role: "diagnosis",
  purpose: "diagnose",
  sourceRef: SRC_A,
  inputDigest: D1,
  phase: "waiting_assignment",
  ...over,
});

// ---- 닫힌 포트 ----

test("닫힌 포트: 공장이 돌려준 포트 그대로는 네 도구 모두 unknown이고 장부를 읽지도 쓰지도 않는다", () => {
  const w = world();
  const own = waiting(w.ledger, A);
  const before = written(w.ledger);
  const answers = [
    handleToolCall("start_worker", startArgs(SRC_A), ctx(A), w.ports),
    handleToolCall("worker_status", refArgs(own), ctx(A), w.ports),
    handleToolCall("worker_result", refArgs(own), ctx(A), w.ports),
    handleToolCall("cancel_worker", refArgs(own), ctx(A), w.ports),
  ];
  expect(answers).toEqual(["start_worker", "worker_status", "worker_result", "cancel_worker"].map(unknown));
  expect(w.calls).toEqual([]);
  expect(w.events).toEqual([]);
  expect(written(w.ledger)).toBe(before);
});

test("닫힌 포트: 셋은 늘 known: false이고, 이은 넷과 합쳐 처리기의 장부 포트 일곱을 빠짐없이 나눈다", () => {
  const w = world();
  const own = waiting(w.ledger, A);
  expect(w.ports.ledger.liveSession()).toEqual({ known: false });
  expect(w.ports.ledger.inputPinned({ owner: A, sourceRef: SRC_A, inputDigest: D1 })).toEqual({ known: false });
  expect(w.ports.ledger.readResult(own)).toEqual({ known: false });
  expect([...CLOSED_PORTS, ...LINKED_PORTS].map(String).sort()).toEqual(Object.keys(w.ports.ledger).sort());
  expect(Object.keys(w.ports.ledger)).toHaveLength(7);
  expect(w.calls).toEqual([]);
});

test("닫힌 포트: 세션만 열면 입력 고정이 모름이라 start_worker는 unknown이고 재시도 키 조회도 기록도 부르지 않는다", () => {
  const w = world();
  const before = written(w.ledger);
  const ports = { ...w.ports, ledger: { ...w.ports.ledger, liveSession: () => ({ known: true as const, value: SESSION }) } };
  expect(handleToolCall("start_worker", startArgs(SRC_A), ctx(A), ports)).toEqual(unknown("start_worker"));
  expect(w.calls).toEqual([]);
  expect(written(w.ledger)).toBe(before);
});

test("닫힌 포트: worker_result는 자기 부탁이면 결과를 모름(unknown), 없는 부탁과 남의 부탁은 같은 not_found다", () => {
  const w = world();
  const own = waiting(w.ledger, A);
  const others = waiting(w.ledger, B);
  const ports = opened(w.ports);
  expect(handleToolCall("worker_result", refArgs(own), ctx(A), ports)).toEqual(unknown("worker_result"));
  expect(handleToolCall("worker_result", refArgs(MISSING), ctx(A), ports)).toEqual(refused("worker_result", "not_found"));
  expect(handleToolCall("worker_result", refArgs(others), ctx(A), ports)).toEqual(refused("worker_result", "not_found"));
  expect(w.calls).toEqual(["readToolRequest", "readToolRequest", "readToolRequest"]);
});

// ---- start_worker ----

test("start_worker: 새 부탁은 대기로 한 줄 적히고, 같은 재시도 키를 다시 부르면 같은 참조이고 기록을 부르지 않는다", () => {
  const w = world();
  const ports = opened(w.ports);
  const first = handleToolCall("start_worker", startArgs(SRC_A), ctx(A), ports);
  expect(first).toMatchObject({ outcome: "ok", tool: "start_worker", phase: "waiting_assignment" });
  const ref = (first as { ref: string }).ref;
  expect(w.calls).toEqual(["findToolRequest", "recordToolRequest"]);
  const stored = w.ledger.readToolRequest({ owner: A, ref });
  expect(stored).toMatchObject({ known: true, value: { ref, owner: A, dedupeKey: keyOf(A), sourceRef: SRC_A, inputDigest: D1, phase: "waiting_assignment" } });

  w.calls.length = 0;
  const again = handleToolCall("start_worker", startArgs(SRC_A), ctx(A), ports);
  expect(again).toEqual(first);
  expect(w.calls).toEqual(["findToolRequest"]);
  const list = w.ledger.listWaitingToolRequests();
  if (!list.known) throw new Error("읽기 실패");
  expect(list.value.map((r) => r.ref)).toEqual([ref]);
});

test("start_worker: 같은 키에 내용이 다르면 retry_conflict이고 줄은 하나 그대로다", () => {
  const w = world();
  const ports = opened(w.ports);
  const first = handleToolCall("start_worker", startArgs(SRC_A), ctx(A), ports) as { ref: string };
  const before = written(w.ledger);
  expect(handleToolCall("start_worker", startArgs(SRC_OTHER), ctx(A), ports)).toEqual(refused("start_worker", "retry_conflict"));
  expect(written(w.ledger)).toBe(before);
  expect(w.ledger.readToolRequest({ owner: A, ref: first.ref })).toMatchObject({ known: true, value: { sourceRef: SRC_A } });
});

test("start_worker: 다른 소유자의 같은 키는 각자 자기 줄이고 답의 꼴이 같다(남의 줄의 존재가 드러나지 않는다)", () => {
  const w = world();
  const ports = opened(w.ports);
  const a = handleToolCall("start_worker", startArgs(SRC_A), ctx(A), ports) as { ref: string };
  const b = handleToolCall("start_worker", startArgs(SRC_B), ctx(B), ports) as { ref: string };
  expect({ ...a, ref: "_" }).toEqual({ ...b, ref: "_" });
  expect(a.ref).not.toBe(b.ref);
  expect(w.ledger.readToolRequest({ owner: A, ref: b.ref })).toEqual({ known: true, value: null });
  expect(w.ledger.readToolRequest({ owner: B, ref: b.ref })).toMatchObject({ known: true, value: { owner: B, sourceRef: SRC_B } });
});

test("start_worker: 조회와 기록 사이에 같은 키가 생기면(조회가 못 봄) 기록이 그 줄을 돌려줘 같은 참조, 내용이 다르면 retry_conflict다", () => {
  const w = world();
  const blind = opened(w.ports, { findByRetryKey: () => ({ known: true, value: null }) });
  const first = handleToolCall("start_worker", startArgs(SRC_A), ctx(A), blind);
  expect(first).toMatchObject({ outcome: "ok", phase: "waiting_assignment" });
  const before = written(w.ledger);
  expect(handleToolCall("start_worker", startArgs(SRC_A), ctx(A), blind)).toEqual(first);
  expect(handleToolCall("start_worker", startArgs(SRC_OTHER), ctx(A), blind)).toEqual(refused("start_worker", "retry_conflict"));
  expect(written(w.ledger)).toBe(before);
});

test("start_worker: 장부가 정지면 stopped, 복원 중(접수 허가 없음)이면 intake_closed이고 아무것도 적지 않는다", () => {
  const stoppedWorld = world();
  must(stoppedWorld.ledger.applyStop({ generation: 1, stopped: true, now: NOW }));
  const before = written(stoppedWorld.ledger);
  expect(handleToolCall("start_worker", startArgs(SRC_A), ctx(A), opened(stoppedWorld.ports))).toEqual(refused("start_worker", "stopped"));
  expect(written(stoppedWorld.ledger)).toBe(before);

  const restoring = world();
  restoring.ledger.beginRestore(RESTORE_KEY);
  const beforeRestore = written(restoring.ledger);
  expect(handleToolCall("start_worker", startArgs(SRC_A), ctx(A), opened(restoring.ports))).toEqual(refused("start_worker", "intake_closed"));
  expect(written(restoring.ledger)).toBe(beforeRestore);
});

test("start_worker: 정지 기록이 없으면(stop_unknown) unknown이다. intake_closed나 stopped로 바꾸지 않는다", () => {
  const w = world(() => {});
  expect(handleToolCall("start_worker", startArgs(SRC_A), ctx(A), opened(w.ports))).toEqual(unknown("start_worker"));
  expect(w.calls).toEqual(["findToolRequest", "recordToolRequest"]);
  expect(w.ledger.listWaitingToolRequests()).toEqual({ known: true, value: [] });
});

test("start_worker: 접수하지 않은 소유자(장부의 invariant_violation)는 unknown이고 줄이 생기지 않는다", () => {
  const w = world();
  const before = written(w.ledger);
  expect(handleToolCall("start_worker", startArgs(SRC_A), ctx(STRANGER), opened(w.ports))).toEqual(unknown("start_worker"));
  expect(written(w.ledger)).toBe(before);
});

test("start_worker: 장부 읽기가 실패하면(닫힌 장부) unknown이고 기록을 부르지 않는다", () => {
  const w = world();
  w.ledger.close();
  expect(handleToolCall("start_worker", startArgs(SRC_A), ctx(A), opened(w.ports))).toEqual(unknown("start_worker"));
  expect(w.calls).toEqual(["findToolRequest"]);
});

test("start_worker: 재시도 키 조회가 던지거나 꼴이 틀린 자기 줄·다른 키의 자기 줄을 주면 unknown이고 기록을 부르지 않는다", () => {
  const cases: [string, Fn][] = [
    [
      "던짐",
      () => {
        throw new Error("장부 실패");
      },
    ],
    ["Read 꼴이 아님", () => ({ ok: true })],
    ["단계가 처리기의 것이 아님", () => ({ known: true, value: row({ phase: "lost" }) })],
    ["소유자 칸 없음", () => ({ known: true, value: row({ owner: undefined }) })],
    ["다른 키의 자기 줄", () => ({ known: true, value: row({ dedupeKey: "start_worker:other" }) })],
  ];
  for (const [name, fake] of cases) {
    const w = world();
    w.over.findToolRequest = fake;
    const before = written(w.ledger);
    expect(handleToolCall("start_worker", startArgs(SRC_A), ctx(A), opened(w.ports)), name).toEqual(unknown("start_worker"));
    expect(w.calls, name).toEqual(["findToolRequest"]);
    expect(written(w.ledger), name).toBe(before);
  }
});

test("start_worker: 재시도 키 조회가 남의 줄을 주면 없는 줄로 다뤄 자기 줄을 새로 적고, 남의 줄은 답에 나오지 않는다", () => {
  const w = world();
  w.over.findToolRequest = () => ({ known: true, value: row({ owner: B, dedupeKey: keyOf(A), ref: MISSING }) });
  expect(w.ports.ledger.findByRetryKey({ owner: A, retryKey: keyOf(A) })).toEqual({ known: true, value: null });
  const answer = handleToolCall("start_worker", startArgs(SRC_A), ctx(A), opened(w.ports)) as { outcome: string; ref: string };
  expect(answer.outcome).toBe("ok");
  expect(answer.ref).not.toBe(MISSING);
  expect(w.ledger.readToolRequest({ owner: A, ref: answer.ref })).toMatchObject({ known: true, value: { owner: A } });
});

test("start_worker: 난수 포트가 참조 후보를 못 만들면 unknown이고 기록을 부르지 않는다", () => {
  const w = world();
  w.bytes.push(new Uint8Array(3));
  const before = written(w.ledger);
  expect(handleToolCall("start_worker", startArgs(SRC_A), ctx(A), opened(w.ports))).toEqual(unknown("start_worker"));
  expect(w.calls).toEqual(["findToolRequest"]);
  expect(written(w.ledger)).toBe(before);
});

test("start_worker: 기록의 거절은 stopped → stopped, intake_closed·snapshot_hold → intake_closed, 그 밖의 거절은 모두 unknown이다", () => {
  const w = world();
  for (const reason of REFUSALS) {
    w.over.recordToolRequest = () => ({ ok: false, reason });
    const expected =
      reason === "stopped" ? refused("start_worker", "stopped") : reason === "intake_closed" || reason === "snapshot_hold" ? refused("start_worker", "intake_closed") : unknown("start_worker");
    expect(handleToolCall("start_worker", startArgs(SRC_A), ctx(A), opened(w.ports)), reason).toEqual(expected);
  }
});

test("start_worker: 기록의 답이 넘긴 값과 맞지 않으면 unknown이다(남의 줄, 다른 키, 결과와 내용의 어긋남, 다른 참조의 새 줄)", () => {
  const cases: [string, (input: Record<string, unknown>) => unknown][] = [
    ["남의 줄", (input) => ({ ok: true, outcome: "existing", request: row({ owner: B, ref: input.ref }) })],
    ["다른 키", (input) => ({ ok: true, outcome: "existing", request: row({ dedupeKey: "start_worker:x", ref: input.ref }) })],
    ["existing인데 내용이 다름", () => ({ ok: true, outcome: "existing", request: row({ sourceRef: SRC_OTHER }) })],
    ["conflict인데 내용이 같음", () => ({ ok: true, outcome: "conflict", request: row() })],
    ["created인데 후보가 아닌 참조", () => ({ ok: true, outcome: "created", request: row() })],
    ["created인데 대기가 아님", (input) => ({ ok: true, outcome: "created", request: row({ ref: input.ref, phase: "running" }) })],
    ["모르는 결과", (input) => ({ ok: true, outcome: "replaced", request: row({ ref: input.ref }) })],
    ["꼴이 틀린 줄", (input) => ({ ok: true, outcome: "created", request: row({ ref: input.ref, inputDigest: "zz" }) })],
    [
      "던짐",
      () => {
        throw new Error("쓰기 실패");
      },
    ],
  ];
  const w = world();
  for (const [name, fake] of cases) {
    w.over.recordToolRequest = fake as Fn;
    expect(handleToolCall("start_worker", startArgs(SRC_A), ctx(A), opened(w.ports)), name).toEqual(unknown("start_worker"));
  }
  // 같은 대역에서 맞는 답이면 ok다(위 칸이 대역 자체 때문에 실패하지 않았음을 본다).
  w.over.recordToolRequest = ((input: Record<string, unknown>) => ({ ok: true, outcome: "created", request: row({ ref: input.ref }) })) as Fn;
  expect(handleToolCall("start_worker", startArgs(SRC_A), ctx(A), opened(w.ports))).toMatchObject({ outcome: "ok", phase: "waiting_assignment" });
});

// ---- 읽기 ----

test("worker_status: 자기 부탁은 단계, 없는 부탁과 남의 부탁은 같은 not_found이고 남의 줄은 그대로다", () => {
  const w = world();
  const own = waiting(w.ledger, A);
  const others = waiting(w.ledger, B);
  const ports = opened(w.ports);
  expect(handleToolCall("worker_status", refArgs(own), ctx(A), ports)).toEqual({ outcome: "ok", tool: "worker_status", ref: own, phase: "waiting_assignment" });
  const missing = handleToolCall("worker_status", refArgs(MISSING), ctx(A), ports);
  expect(missing).toEqual(refused("worker_status", "not_found"));
  expect(handleToolCall("worker_status", refArgs(others), ctx(A), ports)).toEqual(missing);
  const { ref: started } = running(w.ledger, B);
  expect(handleToolCall("worker_status", refArgs(started), ctx(A), ports)).toEqual(missing);
  expect(handleToolCall("worker_status", refArgs(started), ctx(B), ports)).toEqual({ outcome: "ok", tool: "worker_status", ref: started, phase: "preparing" });
});

test("worker_status: 참조 읽기가 남의 줄을 주면 not_found, 던짐·읽기 실패·꼴이 틀린 자기 줄·다른 참조의 자기 줄은 unknown이다", () => {
  const cases: [string, Fn, ToolAnswer][] = [
    ["남의 줄", () => ({ known: true, value: row({ owner: B }) }), refused("worker_status", "not_found")],
    ["남의 줄(꼴이 틀려도)", () => ({ known: true, value: row({ owner: B, phase: "lost" }) }), refused("worker_status", "not_found")],
    [
      "던짐",
      () => {
        throw new Error("장부 실패");
      },
      unknown("worker_status"),
    ],
    ["읽기 실패", () => ({ known: false, reason: "io" }), unknown("worker_status")],
    ["꼴이 틀린 자기 줄", () => ({ known: true, value: row({ role: "root" }) }), unknown("worker_status")],
    ["소유자 칸이 문자열이 아님", () => ({ known: true, value: row({ owner: 7 }) }), unknown("worker_status")],
    ["다른 참조의 자기 줄", () => ({ known: true, value: row({ ref: "ffffffff-0000-4000-8000-00000000000f" }) }), unknown("worker_status")],
  ];
  for (const [name, fake, expected] of cases) {
    const w = world();
    w.over.readToolRequest = fake;
    expect(handleToolCall("worker_status", refArgs(MISSING), ctx(A), opened(w.ports)), name).toEqual(expected);
  }
});

// ---- cancel_worker ----

test("cancel_worker: 대기 부탁은 not_started로 접수되고 다시 부르면 already_ended다. 지시는 0줄이고 아무것도 보내지 않는다", async () => {
  const w = world();
  const own = waiting(w.ledger, A);
  const ports = opened(w.ports);
  expect(handleToolCall("cancel_worker", refArgs(own), ctx(A), ports)).toEqual({ outcome: "ok", tool: "cancel_worker", ref: own, cancel: "accepted", phase: "not_started" });
  // 관측은 처리기가 답하기 전에 왔다: 받는 쪽은 공장을 만들 때 붙였다.
  expect(w.events.map((e) => e.outcome)).toEqual(["nothing_to_send"]);
  expect(handleToolCall("cancel_worker", refArgs(own), ctx(A), ports)).toEqual(refused("cancel_worker", "already_ended"));
  expect(handleToolCall("worker_status", refArgs(own), ctx(A), ports)).toMatchObject({ outcome: "ok", phase: "not_started" });
  await flush();
  expect(w.sent).toEqual([]);
  expect(w.ledger.unansweredInstructions()).toMatchObject({ known: true, value: { instructions: [] } });
});

test("cancel_worker: 시작한 실행은 stopping으로 접수되고 장부가 적은 지시 줄 하나를 그대로 한 번 보낸다(요청 ID는 문맥의 호출 ID가 아니다)", async () => {
  const w = world();
  const { ref, runId } = running(w.ledger, A);
  const call = ctx(A);
  expect(handleToolCall("cancel_worker", refArgs(ref), call, opened(w.ports))).toEqual({ outcome: "ok", tool: "cancel_worker", ref, cancel: "accepted", phase: "stopping" });
  const read = w.ledger.unansweredInstructions();
  if (!read.known) throw new Error("읽기 실패");
  const cancels = read.value.instructions.filter((i) => i.action === "task_cancel");
  expect(cancels).toHaveLength(1);
  expect(cancels[0]).toMatchObject({ runId });
  expect(cancels[0]?.requestId).not.toBe(call.callId);
  await flush();
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]?.header).toMatchObject({ action: "task_cancel", request_id: cancels[0]?.requestId });
  expect(w.events.map((e) => e.outcome)).toEqual(["sent"]);
});

test("cancel_worker: 배정됐지만 시작 전인 부탁은 not_started로 닫히고 다시 부르면 already_ended다. 지시는 0줄이다", async () => {
  const w = world();
  const { ref } = running(w.ledger, A, false);
  const ports = opened(w.ports);
  expect(handleToolCall("worker_status", refArgs(ref), ctx(A), ports)).toMatchObject({ outcome: "ok", phase: "queued" });
  expect(handleToolCall("cancel_worker", refArgs(ref), ctx(A), ports)).toEqual({ outcome: "ok", tool: "cancel_worker", ref, cancel: "accepted", phase: "not_started" });
  expect(handleToolCall("cancel_worker", refArgs(ref), ctx(A), ports)).toEqual(refused("cancel_worker", "already_ended"));
  expect(handleToolCall("worker_status", refArgs(ref), ctx(A), ports)).toMatchObject({ outcome: "ok", phase: "not_started" });
  await flush();
  expect(w.sent).toEqual([]);
  expect(w.ledger.unansweredInstructions()).toMatchObject({ known: true, value: { instructions: [] } });
});

test("cancel_worker: 남의 부탁은 not_found이고 취소를 부르지 않으며 그 부탁은 대기 그대로다", () => {
  const w = world();
  const others = waiting(w.ledger, B);
  const before = written(w.ledger);
  expect(handleToolCall("cancel_worker", refArgs(others), ctx(A), opened(w.ports))).toEqual(refused("cancel_worker", "not_found"));
  expect(w.calls).toEqual(["readToolRequest"]);
  expect(written(w.ledger)).toBe(before);
  expect(w.events).toEqual([]);
});

test("cancel_worker: 장부의 stop_unknown·invariant_violation·던짐은 unknown이고 아무것도 보내지 않는다", async () => {
  const cases: [string, Fn][] = [
    ["stop_unknown", () => ({ ok: false, reason: "stop_unknown" })],
    ["invariant_violation", () => ({ ok: false, reason: "invariant_violation" })],
    [
      "던짐",
      () => {
        throw new Error("쓰기 실패");
      },
    ],
  ];
  for (const [name, fake] of cases) {
    const w = world();
    const { ref } = running(w.ledger, A);
    w.over.cancelToolRequest = fake;
    expect(handleToolCall("cancel_worker", refArgs(ref), ctx(A), opened(w.ports)), name).toEqual(unknown("cancel_worker"));
    await flush();
    expect(w.sent, name).toEqual([]);
  }
});

test("cancel_worker: 같은 호출 ID로 두 번 부르면 둘 다 접수되고 서로 다른 요청 ID의 지시가 두 줄이다(같은 호출의 답 재생은 세션 계약의 일)", () => {
  const w = world();
  const { ref } = running(w.ledger, A);
  const call = ctx(A);
  const ports = opened(w.ports);
  expect(handleToolCall("cancel_worker", refArgs(ref), call, ports)).toMatchObject({ outcome: "ok", phase: "stopping" });
  expect(handleToolCall("cancel_worker", refArgs(ref), call, ports)).toMatchObject({ outcome: "ok", phase: "stopping" });
  const read = w.ledger.unansweredInstructions();
  if (!read.known) throw new Error("읽기 실패");
  const ids = read.value.instructions.filter((i) => i.action === "task_cancel").map((i) => i.requestId);
  expect(new Set(ids).size).toBe(2);
});

// ---- 조립 ----

test("조립: 취소 관측 포트·장부 함수가 없으면 만들 때 던지고, 만든 포트는 바꿀 수 없다", () => {
  const w = world();
  const base = {
    ledger: w.ledger,
    policy: { judge: () => "allowed" as const },
    config: { purposeBriefMaxChars: 10 },
    random: { bytes: (n: number) => new Uint8Array(n) },
    cancel: { links: { mayIssue: () => ({ ok: true as const }) }, clock: { now: () => NOW }, signer: { seal: () => ({}) as never }, sink: { send: async () => "sent" as const }, observe: () => {} },
  } satisfies ToolAdapterDeps;
  expect(() => createToolPorts({ ...base, cancel: { ...base.cancel, observe: undefined as never } })).toThrow(TypeError);
  const bound = Object.fromEntries(NAMES.map((name) => [name, (w.ledger[name] as Fn).bind(w.ledger)]));
  expect(() => createToolPorts({ ...base, ledger: bound as unknown as ToolLedger })).not.toThrow();
  expect(() => createToolPorts({ ...base, ledger: { ...bound, findToolRequest: undefined } as unknown as ToolLedger })).toThrow(TypeError);
  const ports = createToolPorts(base);
  expect(Object.isFrozen(ports) && Object.isFrozen(ports.ledger) && Object.isFrozen(ports.config)).toBe(true);
});

test("정적: tools-adapter.ts는 시계·난수·타이머·환경을 직접 부르지 않고, 소유자를 가리지 않는 장부 읽기와 배정을 잇지 않는다", async () => {
  const source = (await readText("src/supervisor/runtime/tools-adapter.ts"))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  for (const banned of [
    /process\.env/,
    /\bprocess\b/,
    /\bDate\b/,
    /\bperformance\b/,
    /\bMath\.random\b/,
    /\bcrypto\b/,
    /\bsetTimeout\b/,
    /\bsetInterval\b/,
    /\bBun\b/,
    /["']node:/,
    /["']bun:/,
    /listWaitingToolRequests/,
    /assignToolRequest/,
    /\bgetRun\b/,
    /\blistRuns\b/,
  ]) {
    expect(source, String(banned)).not.toMatch(banned);
  }
});
