// 시험 작업 넣기(test-job, D-98·D-101)의 시험: 말의 꼴과 진입점 argv·종료 코드, 처리기의 판정(가짜 포트로 장부 호출을 센다), 실제 장부의 줄과
// 트랜잭션 안의 접수 재확인, 실제 조립에서 꺼짐·복원 전·정지 중 효과 0과 켜짐·정상에서 정확히 1, 관리 소켓이 넘기는 요청 기한, 루프백.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, openLedger, type Read, type StatusPeek, type ToolRequestInput } from "../../../src/ledger/index.ts";
import { PURPOSE, RESTORE_KEY } from "../../../src/ledger/ledger.ts";
import { adminFs } from "../../../src/main/supervisor.ts";
import { ask, type ClientDeps, commandOf, exitFor, requestOf } from "../../../src/supervisor/admin/client.ts";
import { answerLine, createAdminHandlers } from "../../../src/supervisor/admin/commands.ts";
import { type AdminPeer, type AdminSocketHandlers, listenAdmin } from "../../../src/supervisor/admin/listener.ts";
import {
  ADMIN_LIMITS,
  ADMIN_SOCKET_MODE,
  ADMIN_SOCKET_PATH,
  type AdminReply,
  encodeReply,
  encodeRequest,
  parseReply,
  parseRequest,
  TEST_JOB_FIELDS,
  TEST_JOB_SCHEMA,
  type TestJobRequest,
  testJobLine,
} from "../../../src/supervisor/admin/protocol.ts";
import type { AdminClockReading, AdminProgress, AdminSources } from "../../../src/supervisor/admin/status.ts";
import { TEST_JOB_LIMITS, TEST_JOB_PURPOSE, TEST_JOB_SESSION, type TestJobPorts } from "../../../src/supervisor/admin/test-job.ts";
import type { RunningSupervisor } from "../../../src/supervisor/runtime/boot.ts";
import { readText, root } from "../../files.ts";
import { digest, id, NOW, open, ready, tempDir, tempPath } from "../../ledger/helpers.ts";
import { loopbackTime, WALL, type World, world } from "../runtime/boot-world.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER = id();
const JOB: TestJobRequest = { owner: OWNER, key: "smoke-1", role: "isolated_reader", purpose: "smoke_test", sourceRef: `inbox/${OWNER}`, inputDigest: digest("fixture") };
const lineOf = (job: Record<string, unknown> = JOB) => JSON.stringify({ command: "test-job", ...job });
// 가짜 단조 시계에서 요청 한 줄의 기한.
const LIMIT = 10_000;
const known = <T>(value: T) => ({ known: true as const, value });
const PEEK: StatusPeek = { stop: { generation: 0, stopped: false, phase: "none", updatedAt: WALL }, pauseUntil: null, waitingRequests: 0, queuedRuns: 0, slotRuns: 0, intakeOpen: true };
const okAt = (at: number): AdminClockReading => ({ state: "ok", at });

// 장부가 넘긴 값 그대로의 새 줄.
const createdOf = (input: ToolRequestInput, over: Record<string, unknown> = {}) => ({
  ok: true,
  outcome: "created",
  request: { ref: input.ref, owner: input.owner, dedupeKey: input.dedupeKey, role: input.role, purpose: input.purpose, sourceRef: input.sourceRef, inputDigest: input.inputDigest, phase: "waiting_assignment", ...over },
});

// 부른 자리를 차례대로 적는 가짜 읽기·쓰기 포트. 쓰기(recordToolRequest)에 넘긴 값을 모은다.
function fake(
  over: Partial<{
    progress: AdminProgress;
    peek: Partial<StatusPeek>;
    view: () => Read<StatusPeek>;
    now: () => AdminClockReading;
    gate: (limit: number) => unknown;
    write: (input: ToolRequestInput) => unknown;
    bytes: (length: number) => Uint8Array;
  }> = {},
) {
  const calls: string[] = [];
  const written: ToolRequestInput[] = [];
  const limits: number[] = [];
  let seq = 0;
  const sources: AdminSources = {
    progress: () => (calls.push("progress"), over.progress ?? { restored: true, alive: true, granted: true }),
    view: () => (calls.push("view"), over.view === undefined ? known({ ...PEEK, ...over.peek }) : over.view()),
    now: () => (calls.push("now"), (over.now ?? (() => okAt(WALL)))()),
  };
  const ports: TestJobPorts = {
    ledger: {
      recordToolRequest: ((input: ToolRequestInput) => {
        calls.push("recordToolRequest");
        written.push(input);
        return over.write === undefined ? createdOf(input) : over.write(input);
      }) as Ledger["recordToolRequest"],
    },
    gate: ((limit: number) => (calls.push("gate"), limits.push(limit), (over.gate ?? (() => "open"))(limit))) as TestJobPorts["gate"],
    random: { bytes: over.bytes ?? ((length) => new Uint8Array(length).fill((seq += 1))) },
  };
  const handlers = createAdminHandlers(sources, ports);
  const reply = (line: string = lineOf(), limit: number = LIMIT) => parseReply(answerLine(line, handlers, limit).slice(0, -1));
  return { calls, written, limits, reply };
}

describe("말과 진입점", () => {
  test("test-job 요청은 칸 여섯을 정한 차례로 싣고 감독이 그대로 읽는다. 장부의 최대 길이 값으로도 요청 한 줄 상한 안이다", () => {
    const line = encodeRequest({ command: "test-job", job: JOB });
    expect(Object.keys(JSON.parse(line))).toEqual(["command", ...TEST_JOB_FIELDS]);
    expect(parseRequest(line.slice(0, -1))).toEqual({ ok: true, command: "test-job", args: { ...JOB } });
    // 받은 객체를 펼치지 않는다: 더 붙은 칸은 싣지 않는다.
    expect(Object.keys(JSON.parse(encodeRequest({ command: "test-job", job: { ...JOB, extra: "x" } as TestJobRequest })))).toEqual(["command", ...TEST_JOB_FIELDS]);
    const longest: TestJobRequest = { owner: OWNER, key: `k${"x".repeat(199)}`, role: "isolated_reader", purpose: `p${"x".repeat(63)}`, sourceRef: `${"a".repeat(32)}/${OWNER}`, inputDigest: digest("x") };
    expect(new TextEncoder().encode(encodeRequest({ command: "test-job", job: longest })).length).toBeLessThanOrEqual(ADMIN_LIMITS.requestMaxBytes);
    expect(requestOf(["test-job", ...TEST_JOB_FIELDS.map((field) => longest[field])])).toEqual({ command: "test-job", job: longest });
  });

  test("답 test_job은 created·existing과 소문자 UUID 참조뿐이고, 꼴이 하나라도 다르면 받지 않는다", () => {
    const ref = id();
    for (const outcome of ["created", "existing"] as const) {
      const reply: AdminReply = { kind: "test_job", outcome, ref };
      expect(parseReply(encodeReply(reply).slice(0, -1))).toEqual(reply);
    }
    for (const bad of [
      { reply: "test_job", outcome: "created", ref, extra: 1 },
      { reply: "test_job", outcome: "conflict", ref },
      { reply: "test_job", outcome: "created", ref: ref.toUpperCase() },
      { reply: "test_job", outcome: "created", ref: "x" },
      { reply: "test_job", outcome: "created" },
      { reply: "refused", reason: "nope" },
    ]) {
      expect(parseReply(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  test("진입점 argv: test-job은 값 여섯(빈 값 없음, 요청 한 줄 상한 안)이고 그 밖은 사용법이다. status는 인자가 없다", () => {
    const values = TEST_JOB_FIELDS.map((field) => JOB[field]);
    expect(requestOf(["test-job", ...values])).toEqual({ command: "test-job", job: JOB });
    expect(requestOf(["status"])).toEqual({ command: "status" });
    for (const argv of [["test-job"], ["test-job", ...values.slice(1)], ["test-job", ...values, "x"], ["test-job", "", ...values.slice(1)], ["test-job", ...values.slice(0, 5), "x".repeat(1_000)], ["TEST-JOB", ...values], ["status", "x"]]) {
      expect(requestOf(argv), argv.join(" ").slice(0, 60)).toBeNull();
    }
    // 인자 없는 명령만 내는 commandOf는 test-job을 내지 않는다.
    expect(commandOf(["test-job", ...values])).toBeNull();
    expect(commandOf(["status"])).toBe("status");
  });

  test("종료 코드: 시험 작업은 0이면 stdout에 olive-test-job/v1 한 줄, 복원 전 3, 거절·모름 1(stdout 없음), 다른 명령의 답은 꼴이 틀린 답(1)이다", () => {
    const ref = id();
    expect(exitFor({ kind: "reply", reply: { kind: "test_job", outcome: "created", ref } }, "test-job")).toEqual({ code: 0, stdout: `${JSON.stringify({ schema: TEST_JOB_SCHEMA, outcome: "created", ref })}\n`, stderr: "" });
    expect(testJobLine({ outcome: "existing", ref })).toBe(`{"schema":"olive-test-job/v1","outcome":"existing","ref":"${ref}"}`);
    expect(exitFor({ kind: "reply", reply: { kind: "unknown", reason: "restore_not_done" } }, "test-job")).toEqual({ code: 3, stdout: "", stderr: "olive admin: 시험 작업 모름: 감독이 복원을 마치지 않았다(restore_not_done)\n" });
    const cases: [Parameters<typeof exitFor>[0], string][] = [
      [{ kind: "reply", reply: { kind: "refused", reason: "disabled" } }, "감독이 요청을 거절했다(disabled)"],
      [{ kind: "reply", reply: { kind: "refused", reason: "limit" } }, "감독이 요청을 거절했다(limit)"],
      [{ kind: "reply", reply: { kind: "unknown", reason: "write_unknown" } }, "시험 작업 모름: 장부에 적혔는지 모른다(write_unknown)"],
      [{ kind: "reply", reply: { kind: "unknown", reason: "ledger_unreadable" } }, "시험 작업 모름: 감독이 상태를 읽지 못했다(ledger_unreadable)"],
      [{ kind: "unreachable", reason: "no_socket" }, "시험 작업 모름: 감독에 닿지 못했다(no_socket)"],
      [{ kind: "failed", reason: "timeout" }, "시험 작업 모름: 감독의 답을 받지 못했다(timeout)"],
      [{ kind: "reply", reply: { kind: "status", status: { alive: true, queued: 0, running: 0, diagnosis: "active", stop: "none", stopGeneration: 0, intakeOpen: true } } }, "시험 작업 모름: 감독의 답을 받지 못했다(malformed)"],
    ];
    for (const [outcome, message] of cases) expect(exitFor(outcome, "test-job")).toEqual({ code: 1, stdout: "", stderr: `olive admin: ${message}\n` });
    // status에 시험 작업 답이 오면 상태로 읽지 않는다.
    expect(exitFor({ kind: "reply", reply: { kind: "test_job", outcome: "created", ref } })).toEqual({ code: 1, stdout: "", stderr: "olive admin: 상태 모름: 감독의 답을 받지 못했다(malformed)\n" });
  });
});

describe("처리기", () => {
  test("꺼진 감독(포트 없음)은 칸을 보지 않고 늘 disabled이고 아무것도 읽지 않는다", () => {
    const calls: string[] = [];
    const sources: AdminSources = {
      progress: () => (calls.push("progress"), { restored: true, alive: true, granted: true }),
      view: () => (calls.push("view"), known(PEEK)),
      now: () => (calls.push("now"), okAt(WALL)),
    };
    const handlers = createAdminHandlers(sources);
    for (const line of [lineOf(), lineOf({ ...JOB, owner: "x" }), '{"command":"test-job"}']) {
      expect(answerLine(line, handlers, LIMIT)).toBe('{"reply":"refused","reason":"disabled"}\n');
    }
    expect(calls).toEqual([]);
  });

  test("켜짐·정상: 장부 쓰기 정확히 한 번이고, 차례는 상태 읽기 → 시각 → 문(요청 기한을 넘김) → 쓰기다. 넘긴 값은 요청의 칸·고정 세션·새 참조 후보·새 호출 ID·장부 시계", () => {
    const f = fake();
    const reply = f.reply();
    expect(f.calls).toEqual(["progress", "view", "now", "gate", "recordToolRequest"]);
    expect(f.limits).toEqual([LIMIT]);
    expect(f.written.length).toBe(1);
    const input = f.written[0]!;
    expect(reply).toEqual({ kind: "test_job", outcome: "created", ref: input.ref });
    expect({ ...input, ref: "-", callId: "-" }).toEqual({ ref: "-", owner: JOB.owner, dedupeKey: JOB.key, role: JOB.role, purpose: JOB.purpose, sourceRef: JOB.sourceRef, inputDigest: JOB.inputDigest, sessionId: TEST_JOB_SESSION, callId: "-", now: WALL });
    expect([UUID.test(input.ref), UUID.test(input.callId), input.ref !== input.callId]).toEqual([true, true, true]);
  });

  test("칸 수·이름·꼴이 하나라도 틀리면 malformed이고 아무것도 읽지 않는다", () => {
    const { owner: _owner, ...noOwner } = JOB;
    for (const job of [
      noOwner,
      { ...JOB, extra: "x" },
      { ...JOB, owner: OWNER.toUpperCase() },
      { ...JOB, key: "smoke 1" },
      { ...JOB, key: `k${"x".repeat(200)}` },
      { ...JOB, key: ":smoke" },
      { ...JOB, role: "admin" },
      { ...JOB, purpose: "Smoke" },
      { ...JOB, sourceRef: "inbox/x" },
      { ...JOB, inputDigest: digest("x").slice(1) },
      { ...JOB, owner: 1 },
    ] as Record<string, unknown>[]) {
      const f = fake();
      expect(f.reply(lineOf(job)), JSON.stringify(job).slice(0, 80)).toEqual({ kind: "refused", reason: "malformed" });
      expect(f.calls).toEqual([]);
    }
  });

  test("복원 5단계 전은 restore_not_done이고 장부를 읽지도 쓰지도 않는다", () => {
    const f = fake({ progress: { restored: false, alive: true, granted: false } });
    expect(f.reply()).toEqual({ kind: "unknown", reason: "restore_not_done" });
    expect(f.calls).toEqual(["progress"]);
  });

  test("살아 있지 않음·정지·접수 닫힘·대기 한도는 거절이고 쓰지 않는다. 자리를 쥔 실행은 한도에 들지 않는다", () => {
    const stopped = { generation: 1, stopped: true, phase: "accepted", updatedAt: WALL } as const;
    const cases: [Parameters<typeof fake>[0], AdminReply][] = [
      [{ progress: { restored: true, alive: false, granted: true } }, { kind: "refused", reason: "not_alive" }],
      // 받아들인 허가가 장부에서 사라졌다(끝낼 사유가 이미 생김).
      [{ peek: { intakeOpen: false } }, { kind: "refused", reason: "not_alive" }],
      // 처음부터 허가가 없는 감독: 정지 기록이 정지면 stopped, 아니면 접수 닫힘.
      [{ progress: { restored: true, alive: true, granted: false }, peek: { intakeOpen: false, stop: stopped } }, { kind: "refused", reason: "stopped" }],
      [{ progress: { restored: true, alive: true, granted: false }, peek: { intakeOpen: false } }, { kind: "refused", reason: "intake_closed" }],
      [{ peek: { waitingRequests: TEST_JOB_LIMITS.maxQueued } }, { kind: "refused", reason: "limit" }],
      [{ peek: { queuedRuns: TEST_JOB_LIMITS.maxQueued } }, { kind: "refused", reason: "limit" }],
      [{ view: () => ({ known: false, reason: "io" }) }, { kind: "unknown", reason: "ledger_unreadable" }],
    ];
    for (const [over, expected] of cases) {
      const f = fake(over);
      expect(f.reply(), JSON.stringify(over)).toEqual(expected);
      expect(f.calls, JSON.stringify(over)).toEqual(["progress", "view"]);
    }
    expect(TEST_JOB_LIMITS.maxQueued).toBe(1);
    const busy = fake({ peek: { slotRuns: 1 } });
    expect(busy.reply()).toMatchObject({ kind: "test_job", outcome: "created" });
    expect(busy.written.length).toBe(1);
  });

  test("문의 답: open이면 쓰고, closed(또는 모르는 값)면 not_alive, late면 late이고 쓰지 않는다. 문이 던지면 read_threw", () => {
    const cases: [(limit: number) => unknown, AdminReply | "created"][] = [
      [() => "open", "created"],
      [() => "closed", { kind: "refused", reason: "not_alive" }],
      [() => "late", { kind: "refused", reason: "late" }],
      [() => true, { kind: "refused", reason: "not_alive" }],
      [() => undefined, { kind: "refused", reason: "not_alive" }],
      [
        () => {
          throw new Error("gate");
        },
        { kind: "unknown", reason: "read_threw" },
      ],
    ];
    for (const [gate, expected] of cases) {
      const f = fake({ gate });
      const reply = f.reply();
      expect(f.limits).toEqual([LIMIT]);
      if (expected === "created") {
        expect(reply).toMatchObject({ kind: "test_job", outcome: "created" });
        expect(f.written.length).toBe(1);
      } else {
        expect(reply, JSON.stringify(expected)).toEqual(expected);
        expect(f.written.length).toBe(0);
      }
    }
  });

  test("참조 후보·호출 ID를 만들지 못하거나 장부 시계를 모르면 쓰지 않는다", () => {
    const short = fake({ bytes: (length) => new Uint8Array(length - 1) });
    expect(short.reply()).toEqual({ kind: "unknown", reason: "random_unavailable" });
    for (const now of [() => ({ state: "unavailable" }) as AdminClockReading, () => ({ state: "regressed" }) as AdminClockReading, () => okAt(Number.NaN), () => okAt(0)]) {
      const f = fake({ now });
      expect(f.reply()).toEqual({ kind: "unknown", reason: "clock_unavailable" });
      expect(f.written.length).toBe(0);
    }
    const throwing = fake({
      now: () => {
        throw new Error("clock");
      },
    });
    expect(throwing.reply()).toEqual({ kind: "unknown", reason: "read_threw" });
    expect(short.written.length + throwing.written.length).toBe(0);
  });

  test("장부의 답: 거절(되돌린 트랜잭션)은 적힌 것 없음으로 옮기고, existing은 장부의 참조로, 넘긴 값과 어긋난 답·던짐은 write_unknown이다", () => {
    const other = id();
    const cases: [(input: ToolRequestInput) => unknown, AdminReply | "existing"][] = [
      [() => ({ ok: false, reason: "stopped" }), { kind: "refused", reason: "stopped" }],
      [() => ({ ok: false, reason: "intake_closed" }), { kind: "refused", reason: "intake_closed" }],
      [() => ({ ok: false, reason: "snapshot_hold" }), { kind: "refused", reason: "intake_closed" }],
      [() => ({ ok: false, reason: "invariant_violation" }), { kind: "refused", reason: "invariant_violation" }],
      [() => ({ ok: false, reason: "ledger_unwritable" }), { kind: "refused", reason: "ledger_refused" }],
      [() => ({ ok: false, reason: "stop_unknown" }), { kind: "refused", reason: "ledger_refused" }],
      [(input) => ({ ...createdOf(input, { ref: other }), outcome: "existing" }), "existing"],
      [(input) => ({ ...createdOf(input, { purpose: "other" }), outcome: "conflict" }), { kind: "refused", reason: "conflict" }],
      [(input) => createdOf(input, { ref: other }), { kind: "unknown", reason: "write_unknown" }],
      [(input) => createdOf(input, { owner: other }), { kind: "unknown", reason: "write_unknown" }],
      [(input) => createdOf(input, { dedupeKey: "other" }), { kind: "unknown", reason: "write_unknown" }],
      [(input) => createdOf(input, { inputDigest: digest("other") }), { kind: "unknown", reason: "write_unknown" }],
      [(input) => ({ ...createdOf(input, { purpose: "other" }), outcome: "existing" }), { kind: "unknown", reason: "write_unknown" }],
      [(input) => ({ ...createdOf(input), outcome: "conflict" }), { kind: "unknown", reason: "write_unknown" }],
      [(input) => ({ ...createdOf(input), outcome: "made" }), { kind: "unknown", reason: "write_unknown" }],
      [(input) => ({ ...createdOf(input), ok: "yes" }), { kind: "unknown", reason: "write_unknown" }],
      [(input) => ({ ...createdOf(input), request: null }), { kind: "unknown", reason: "write_unknown" }],
      [() => null, { kind: "unknown", reason: "write_unknown" }],
      [
        () => {
          throw new Error("write");
        },
        { kind: "unknown", reason: "write_unknown" },
      ],
    ];
    for (const [write, expected] of cases) {
      const f = fake({ write });
      const reply = f.reply();
      expect(f.written.length).toBe(1);
      expect(reply, String(write)).toEqual(expected === "existing" ? { kind: "test_job", outcome: "existing", ref: other } : expected);
    }
  });

  test("목적 꼴은 장부의 PURPOSE와 같다", () => {
    expect(TEST_JOB_PURPOSE.source).toBe(PURPOSE.source);
    expect(TEST_JOB_PURPOSE.flags).toBe(PURPOSE.flags);
  });
});

// 복원 시도 하나를 열고 그 시도의 허가를 낸다(정지 기록은 ready가 적는다).
function attemptOf(ledger: Ledger): symbol {
  const attempt = ledger.beginRestore(RESTORE_KEY);
  ledger.pinRestore(RESTORE_KEY, attempt);
  expect(ledger.grantIntake(RESTORE_KEY, attempt)).toBe(true);
  return attempt;
}
const inputOf = (ledger: Ledger, owner: string) =>
  expect(ledger.enqueueInput({ requestId: owner, source: "admin-dm", sourceRef: { ref: `inbox/${owner}`, expiresAt: NOW + 3_600_000 }, receivedAt: NOW })).toMatchObject({ ok: true });

describe("실제 장부", () => {
  function realLedger() {
    const ledger = ready(open(tempPath()));
    const attempt = attemptOf(ledger);
    inputOf(ledger, OWNER);
    // 대기 수를 0으로 보이게 할 수 있는 읽기(같은 키 다시 부르기를 한도 없이 보려고).
    let hideWaiting = false;
    const sources: AdminSources = {
      progress: () => ({ restored: true, alive: true, granted: true }),
      view: (cap) => {
        const read = ledger.peekStatus(cap, attempt);
        return read.known && hideWaiting ? known({ ...read.value, waitingRequests: 0 }) : read;
      },
      now: () => okAt(NOW),
    };
    const ports: TestJobPorts = { ledger, gate: () => "open", random: loopbackTime().random };
    const handlers = createAdminHandlers(sources, ports);
    const ask = (job: TestJobRequest = JOB) => parseReply(answerLine(lineOf(job), handlers, 1).slice(0, -1));
    const waiting = () => {
      const read = ledger.listWaitingToolRequests();
      if (!read.known) throw new Error("read");
      return read.value.map((row) => row.ref);
    };
    return { ledger, ask, waiting, hide: () => void (hideWaiting = true) };
  }

  test("접수한 입력의 소유자면 대기 부탁 한 줄(대기 단계)이고, 같은 키는 대기가 한도면 limit·한도 밖이면 existing, 내용이 다르면 conflict다", () => {
    const r = realLedger();
    const first = r.ask();
    if (first?.kind !== "test_job") throw new Error(JSON.stringify(first));
    expect(first.outcome).toBe("created");
    expect(r.waiting()).toEqual([first.ref]);
    expect(r.ledger.readToolRequest({ owner: OWNER, ref: first.ref })).toMatchObject({ known: true, value: { phase: "waiting_assignment", dedupeKey: JOB.key, role: JOB.role } });
    // 대기 한도: 다른 키도, 같은 키도 새 줄이 없다.
    expect(r.ask({ ...JOB, key: "smoke-2" })).toEqual({ kind: "refused", reason: "limit" });
    expect(r.ask()).toEqual({ kind: "refused", reason: "limit" });
    r.hide();
    expect(r.ask()).toEqual({ kind: "test_job", outcome: "existing", ref: first.ref });
    expect(r.ask({ ...JOB, purpose: "other_test" })).toEqual({ kind: "refused", reason: "conflict" });
    expect(r.waiting()).toEqual([first.ref]);
  });

  test("장부가 접수하지 않은 소유자는 invariant_violation이고 줄이 없다(소유자 입력 존재 검사를 우회하지 않는다)", () => {
    const r = realLedger();
    const stranger = id();
    expect(r.ask({ ...JOB, owner: stranger, sourceRef: `inbox/${stranger}` })).toEqual({ kind: "refused", reason: "invariant_violation" });
    expect(r.waiting()).toEqual([]);
    expect(r.ledger.health()).toEqual({ writable: true });
  });

  test("상태 읽기를 지나도 장부는 쓰기 트랜잭션 안에서 정지·접수를 다시 본다: 정지 뒤의 쓰기는 거절이고 줄이 없다", () => {
    const r = realLedger();
    expect(r.ledger.applyStop({ generation: 1, stopped: true, now: NOW + 1 })).toMatchObject({ ok: true });
    // 상태 읽기가 열림을 보더라도(조립이 아직 사유를 붙잡기 전) 장부의 거절로 끝난다.
    const ports: TestJobPorts = { ledger: r.ledger, gate: () => "open", random: loopbackTime().random };
    const handlers = createAdminHandlers({ progress: () => ({ restored: true, alive: true, granted: true }), view: () => known(PEEK), now: () => okAt(NOW) }, ports);
    const reply = parseReply(answerLine(lineOf(), handlers, 1).slice(0, -1));
    expect(reply?.kind).toBe("refused");
    expect(["stopped", "intake_closed"]).toContain((reply as { reason: string }).reason);
    expect(r.waiting()).toEqual([]);
  });
});

// 실제 조립(boot.ts). 장부를 감싸 부른 메서드를 적고, 가짜 서버의 송신 두 자리를 센다.
async function bootWith(testJobs: boolean): Promise<{ w: World; running: RunningSupervisor; calls: string[]; raw: () => Ledger; sends: { frames: number; closes: number } }> {
  const calls: string[] = [];
  let raw: Ledger | null = null;
  const w = world({
    settings: testJobs ? { testJobs: true } : {},
    deps: {
      openLedger: (file, options) => {
        const result = openLedger(file, options);
        if (!result.ok) return result;
        raw = result.ledger;
        const ledger = new Proxy(result.ledger, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              calls.push(String(key));
              return Reflect.apply(value, target, args);
            };
          },
        });
        return { ...result, ledger };
      },
    },
  });
  const sends = { frames: 0, closes: 0 };
  const server = w.fake.server as unknown as Record<string, unknown>;
  server.writeFrame = () => ((sends.frames += 1), { kind: "not_written", reason: "not_recognized" });
  server.closeConnection = () => ((sends.closes += 1), { kind: "not_open" });
  const result = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  return { w, running: result.running, calls, raw: () => raw as unknown as Ledger, sends };
}
const restoreSteps = (w: World) => w.events.filter((e) => e.event === "restore_step").map((e) => e.fields.step);
async function untilStep(w: World, step: number): Promise<void> {
  for (let i = 0; i < 20 && !restoreSteps(w).includes(step); i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
  expect(restoreSteps(w)).toContain(step);
}
// 진입점과 같은 잇기: 처리기 표를 running.admin·running.testJob으로 만들고, 요청 기한은 조립의 단조 시계로 넉넉히.
const jobOf = (w: World, running: RunningSupervisor, job: TestJobRequest = JOB) =>
  parseReply(answerLine(lineOf(job), createAdminHandlers(running.admin, running.testJob), w.deps.monoNow() + ADMIN_LIMITS.serverWaitMs).slice(0, -1));
const STATUS_LINE = '{"command":"status"}';
const queuedOf = (running: RunningSupervisor) => {
  const reply = parseReply(answerLine(STATUS_LINE, createAdminHandlers(running.admin)).slice(0, -1));
  return reply?.kind === "status" ? reply.status.queued : reply;
};

describe("실제 조립", () => {
  test("꺼진 감독(설정 없음): 쓰기 포트가 없고, 복원 뒤에도 disabled이며 장부 메서드를 하나도 부르지 않는다", async () => {
    const { w, running, calls, raw, sends } = await bootWith(false);
    expect(running.testJob).toBeNull();
    await untilStep(w, 5);
    inputOf(raw(), OWNER);
    const before = { calls: calls.length, sends: { ...sends } };
    expect(jobOf(w, running)).toEqual({ kind: "refused", reason: "disabled" });
    expect(calls.slice(before.calls)).toEqual([]);
    expect(sends).toEqual(before.sends);
    expect(queuedOf(running)).toBe(0);
    expect(await running.stop()).toBe(0);
  });

  test("켜진 감독: 복원 5단계 전은 restore_not_done(장부 호출 0), 뒤에는 장부 쓰기 정확히 한 번·송신 0이고 상태의 대기가 1이다. 감독은 계속 돈다", async () => {
    const { w, running, calls, raw, sends } = await bootWith(true);
    expect(running.testJob).not.toBeNull();
    await untilStep(w, 4);
    let before = calls.length;
    expect(jobOf(w, running)).toEqual({ kind: "unknown", reason: "restore_not_done" });
    expect(calls.slice(before)).toEqual([]);
    await untilStep(w, 5);
    inputOf(raw(), OWNER);
    before = calls.length;
    const sent = { ...sends };
    const reply = jobOf(w, running);
    expect(reply).toMatchObject({ kind: "test_job", outcome: "created" });
    expect(calls.slice(before)).toEqual(["peekStatus", "recordToolRequest"]);
    expect(sends).toEqual(sent);
    expect(queuedOf(running)).toBe(1);
    const waiting = raw().listWaitingToolRequests();
    expect(waiting).toMatchObject({ known: true, value: [{ ref: (reply as { ref: string }).ref, owner: OWNER, role: JOB.role }] });
    // 한도: 두 번째 부탁은 쓰지 않는다.
    before = calls.length;
    expect(jobOf(w, running, { ...JOB, key: "smoke-2" })).toEqual({ kind: "refused", reason: "limit" });
    expect(calls.slice(before)).toEqual(["peekStatus"]);
    for (let i = 0; i < 3; i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
    expect(w.names()).not.toContain("fatal");
    expect(await running.stop()).toBe(0);
  });

  test("조립의 문: 요청 기한 정각·기한 없음(NaN)이면 late이고 쓰지 않는다. 1ms 전이면 쓴다", async () => {
    const { w, running, calls, raw } = await bootWith(true);
    await untilStep(w, 5);
    inputOf(raw(), OWNER);
    const handlers = createAdminHandlers(running.admin, running.testJob);
    const send = (limit?: number) => parseReply((limit === undefined ? answerLine(lineOf(), handlers) : answerLine(lineOf(), handlers, limit)).slice(0, -1));
    const now = w.deps.monoNow();
    const before = calls.length;
    expect(send(now)).toEqual({ kind: "refused", reason: "late" });
    expect(send()).toEqual({ kind: "refused", reason: "late" });
    expect(send(Number.NaN)).toEqual({ kind: "refused", reason: "late" });
    expect(calls.slice(before)).toEqual(["peekStatus", "peekStatus", "peekStatus"]);
    expect(send(now + 1)).toMatchObject({ kind: "test_job", outcome: "created" });
    expect(calls.slice(before)).toEqual(["peekStatus", "peekStatus", "peekStatus", "peekStatus", "recordToolRequest"]);
    expect(await running.stop()).toBe(0);
  });

  test("켜진 감독의 정지 중: 끝 차례에 들어선 뒤와 장부 정지 기록 뒤의 시험 작업은 쓰지 않는다", async () => {
    for (const model of ["finish", "ledger_stop"] as const) {
      const { w, running, calls, raw } = await bootWith(true);
      await untilStep(w, 5);
      inputOf(raw(), OWNER);
      if (model === "finish") void running.stop();
      else expect(raw().applyStop({ generation: 1, stopped: true, now: WALL + 1 })).toMatchObject({ ok: true });
      const before = calls.length;
      expect(jobOf(w, running), model).toEqual({ kind: "refused", reason: "not_alive" });
      expect(calls.slice(before), model).not.toContain("recordToolRequest");
      expect(raw().listWaitingToolRequests(), model).toMatchObject({ known: true, value: [] });
      if (model === "ledger_stop") await w.time.advance(w.settings.timing.beatEveryMs);
      await running.done;
      // 끝 차례 뒤(장부 닫힘)도 쓰지 않는다.
      const after = calls.length;
      expect(jobOf(w, running)?.kind, model).not.toBe("test_job");
      expect(calls.slice(after), model).not.toContain("recordToolRequest");
    }
  });
});

describe("관리 소켓의 요청 기한", () => {
  test("듣는 쪽은 answer에 그 연결의 요청 받기 기한(연결을 받은 순간 + serverWaitMs)을 넘기고, 진입점은 그 값을 처리기 표에 그대로 잇는다", async () => {
    let now = 100;
    let handlers: AdminSocketHandlers | null = null;
    const seen: number[] = [];
    listenAdmin({
      path: "/x/admin.sock",
      mode: ADMIN_SOCKET_MODE,
      fs: { kind: () => "absent", unlink: () => {}, chmod: () => {} },
      monoNow: () => now,
      setTimer: () => () => {},
      answer: (_line, limit) => (seen.push(limit), '{"reply":"refused","reason":"busy"}\n'),
      listen: (_path, given) => ((handlers = given), { stop: () => {} }),
    });
    const peer: AdminPeer = { write: (bytes) => bytes.length, end: () => {} };
    handlers!.open(peer);
    now = 150;
    handlers!.data(peer, new TextEncoder().encode(`${STATUS_LINE}\n`));
    expect(seen).toEqual([100 + ADMIN_LIMITS.serverWaitMs]);
    const main = (await readText("src/main/supervisor.ts")).split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
    expect(main).toContain("answer: (line, limit) => answerLine(line, handlers, limit),");
  });
});

// 실제 Bun.connect로 붙는 쪽(관리 진입점과 같은 모양).
function realClient(): ClientDeps {
  const clock = loopbackTime();
  return {
    connect: (path, handlers) =>
      Bun.connect({ unix: path, socket: { data: (_socket, chunk) => handlers.data(chunk), close: () => handlers.close(), error: () => handlers.close() } }),
    monoNow: clock.mono,
    setTimer: clock.setTimer,
  };
}

describe("루프백", () => {
  test("실제 경로 유닉스 소켓으로 test-job을 넣으면 0과 시험 작업 한 줄이고, 감독 쪽 쓰기는 한 번이다", async () => {
    const path = join(tempDir(), "admin.sock");
    const clock = loopbackTime();
    const written: ToolRequestInput[] = [];
    const ports: TestJobPorts = {
      ledger: { recordToolRequest: ((input: ToolRequestInput) => (written.push(input), createdOf(input))) as Ledger["recordToolRequest"] },
      gate: (limit) => (clock.mono() < limit ? "open" : "late"),
      random: clock.random,
    };
    const handlers = createAdminHandlers({ progress: () => ({ restored: true, alive: true, granted: true }), view: () => known(PEEK), now: () => okAt(WALL) }, ports);
    const listening = listenAdmin({ path, mode: ADMIN_SOCKET_MODE, fs: adminFs, monoNow: clock.mono, setTimer: clock.setTimer, answer: (line, limit) => answerLine(line, handlers, limit) });
    try {
      const result = exitFor(await ask({ command: "test-job", job: JOB }, realClient(), path), "test-job");
      expect(written.length).toBe(1);
      expect(result).toEqual({ code: 0, stdout: `${testJobLine({ outcome: "created", ref: written[0]!.ref })}\n`, stderr: "" });
    } finally {
      listening.stop();
    }
  });

  test("관리 진입점: test-job 값이 여섯이 아니면 64, 감독 소켓이 없으면 stdout 없이 1", () => {
    expect(existsSync(ADMIN_SOCKET_PATH)).toBe(false);
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, "src/main/admin.ts", ...args], { cwd: root, env: { PATH: process.env.PATH ?? "" }, timeout: 10_000 });
    const values = TEST_JOB_FIELDS.map((field) => JOB[field]);
    const usage = run("test-job", ...values.slice(1));
    expect([usage.exitCode, usage.stdout.toString()]).toEqual([64, ""]);
    expect(usage.stderr.toString()).toStartWith("olive admin: 사용법: ");
    const result = run("test-job", ...values);
    expect([result.exitCode, result.stdout.toString(), result.stderr.toString()]).toEqual([1, "", "olive admin: 시험 작업 모름: 감독에 닿지 못했다(no_socket)\n"]);
  });
});
