// 감독 관리 통로(src/supervisor/admin/)와 관리 진입점(src/main/admin.ts)의 시험: 말의 꼴(homelab CLI가 읽는 상태 한 줄), 상태 읽기의
// 판정, 실제 조립에서의 복원 전 모름·쓰기 0·송신 0, 실제 경로 유닉스 소켓의 루프백(권한·남은 소켓·감독 없음), 받는 순간의 기한 판정.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adminFs } from "../../../src/main/supervisor.ts";
import { type Ledger, openLedger, type Read, type StatusPeek, type StopRecord } from "../../../src/ledger/index.ts";
import { RESTORE_KEY } from "../../../src/ledger/ledger.ts";
import { ask, type AskOutcome, type ClientDeps, type ClientHandlers, type ClientSocket, commandOf, exitFor, USAGE } from "../../../src/supervisor/admin/client.ts";
import { answerLine, createAdminHandlers } from "../../../src/supervisor/admin/commands.ts";
import { type AdminFs, AdminListenRefused, type AdminPeer, type AdminSocketHandlers, listenAdmin } from "../../../src/supervisor/admin/listener.ts";
import {
  ADMIN_LIMITS,
  ADMIN_SOCKET_MODE,
  ADMIN_SOCKET_PATH,
  type AdminReply,
  encodeReply,
  encodeRequest,
  parseReply,
  parseRequest,
  STATUS_MAX_COUNT,
  STATUS_SCHEMA,
  statusLine,
  type SupervisorStatus,
} from "../../../src/supervisor/admin/protocol.ts";
import { type AdminClockReading, type AdminProgress, type AdminSources, readStatus } from "../../../src/supervisor/admin/status.ts";
import type { RunningSupervisor } from "../../../src/supervisor/runtime/boot.ts";
import { createSharedClock } from "../../../src/supervisor/runtime/shared-clock.ts";
import { root } from "../../files.ts";
import { id, must, NOW, open, ready, SESSION_EXECUTOR, startedWorker, tempDir, tempPath, worker, WORKER_EXECUTOR } from "../../ledger/helpers.ts";
import { loopbackTime, manualTime, WALL, type World, world } from "../runtime/boot-world.ts";

const STATUS: SupervisorStatus = { alive: true, queued: 2, running: 1, diagnosis: "active", stop: "none", stopGeneration: 3, intakeOpen: true };
// homelab CLI(cli/src/core/olive-admin.ts)의 STATUS_FIELDS 차례.
const CLI_FIELDS = ["schema", "alive", "queued", "running", "diagnosis", "stop", "stopGeneration", "intakeOpen"];
const STATUS_REQUEST = '{"command":"status"}';
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const known = <T>(value: T) => ({ known: true as const, value });
const stopOf = (over: Partial<StopRecord> = {}): StopRecord => ({ generation: 3, stopped: false, phase: "none", updatedAt: WALL, ...over });
// STATUS와 같은 값이 나오는 장부 읽기(대기 1+1, 자리 1).
const PEEK: StatusPeek = { stop: stopOf(), pauseUntil: null, waitingRequests: 1, queuedRuns: 1, slotRuns: 1, intakeOpen: true };
const okAt = (at: number): AdminClockReading => ({ state: "ok", at });

// 읽은 자리를 적는 가짜 읽기 포트.
function sources(over: Partial<{ progress: AdminProgress; view: () => Read<StatusPeek>; peek: Partial<StatusPeek>; now: () => AdminClockReading }> = {}) {
  const calls: string[] = [];
  const value: AdminSources = {
    progress: () => (calls.push("progress"), over.progress ?? { restored: true, alive: true, granted: true }),
    view: (cap) => (calls.push(`view:${cap}`), over.view === undefined ? known({ ...PEEK, ...over.peek }) : over.view()),
    now: () => (calls.push("now"), (over.now ?? (() => okAt(WALL)))()),
  };
  return { value, calls };
}

describe("말의 꼴", () => {
  test("상태 한 줄은 homelab CLI가 읽는 꼴 그대로다: 칸 여덟(그 차례), 판 olive-supervisor-status/v1, 줄바꿈 없음, 상한 안", () => {
    const line = statusLine(STATUS);
    expect(Object.keys(JSON.parse(line))).toEqual(CLI_FIELDS);
    expect(JSON.parse(line)).toEqual({ schema: STATUS_SCHEMA, ...STATUS });
    expect(STATUS_SCHEMA).toBe("olive-supervisor-status/v1");
    expect(line.includes("\n")).toBe(false);
    expect(new TextEncoder().encode(line).length).toBeLessThan(ADMIN_LIMITS.replyMaxBytes);
    // 받은 값에 다른 칸이 있어도 싣지 않는다.
    expect(Object.keys(JSON.parse(statusLine({ ...STATUS, extra: 1 } as SupervisorStatus)))).toEqual(CLI_FIELDS);
  });

  test("요청은 명령 한 줄이고, 모르는 명령·꼴이 틀린 줄을 가른다", () => {
    expect(encodeRequest("status")).toBe(`${STATUS_REQUEST}\n`);
    expect(parseRequest(STATUS_REQUEST)).toEqual({ ok: true, command: "status", args: {} });
    expect(parseRequest('{"command":"status","x":1}')).toEqual({ ok: true, command: "status", args: { x: 1 } });
    expect(parseRequest('{"command":"queue"}')).toEqual({ ok: false, reason: "unknown_command" });
    for (const bad of ["", "status", "[]", "null", '{"command":1}', '{"cmd":"status"}', `${STATUS_REQUEST}\n${STATUS_REQUEST}`]) expect(parseRequest(bad), bad).toEqual({ ok: false, reason: "malformed" });
  });

  test("답은 세 갈래이고 꼴이 하나라도 다르면 받지 않는다", () => {
    const replies: AdminReply[] = [
      { kind: "status", status: STATUS },
      { kind: "unknown", reason: "restore_not_done" },
      { kind: "refused", reason: "unknown_command" },
    ];
    for (const reply of replies) expect(parseReply(encodeReply(reply).slice(0, -1))).toEqual(reply);
    const good = JSON.parse(encodeReply(replies[0]!));
    for (const bad of [
      { ...good, extra: 1 },
      { ...good, status: { ...good.status, schema: "olive-supervisor-status/v2" } },
      { ...good, status: { ...good.status, queued: -1 } },
      { ...good, status: { ...good.status, running: 1_000_000 } },
      { ...good, status: { ...good.status, stop: "paused" } },
      { ...good, status: { ...good.status, extra: 1 } },
      { reply: "unknown", reason: "maybe" },
      { reply: "refused", reason: "restore_not_done" },
      { reply: "unknown", reason: "restore_not_done", extra: 1 },
    ]) {
      expect(parseReply(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("상태 읽기", () => {
  test("복원 5단계를 받아들이기 전에는 모름이고 장부를 읽지 않는다", () => {
    const s = sources({ progress: { restored: false, alive: true, granted: false } });
    expect(readStatus(s.value)).toEqual({ known: false, reason: "restore_not_done" });
    expect(s.calls).toEqual(["progress"]);
  });

  test("알려진 상태: 대기는 배정 전 부탁과 자리 받기 전 실행, 작업은 자리를 쥔 실행이다. 장부 읽기는 한 번이고 상한에서 멈춘다", () => {
    const s = sources({ peek: { waitingRequests: 3, queuedRuns: 2, slotRuns: 4 } });
    expect(readStatus(s.value)).toEqual({ known: true, status: { alive: true, queued: 5, running: 4, diagnosis: "active", stop: "none", stopGeneration: 3, intakeOpen: true } });
    // 일시 중지가 없으면 시계를 읽지 않는다.
    expect(s.calls).toEqual(["progress", "view:1000000"]);
  });

  test("정지는 실행 쪽 소멸까지 확인했을 때만 stopped다. 접수만 된 정지는 stopping, 풀린 정지는 none", () => {
    const stopAs = (over: Partial<StopRecord>) => {
      const answer = readStatus(sources({ peek: { stop: stopOf(over) } }).value);
      return answer.known ? answer.status.stop : answer.reason;
    };
    expect(stopAs({ stopped: true, phase: "runtime_verified" })).toBe("stopped");
    for (const phase of ["none", "accepted", "blocked", "node_unverified", "node_verified"] as const) expect(stopAs({ stopped: true, phase })).toBe("stopping");
    expect(stopAs({ stopped: false, phase: "runtime_verified" })).toBe("none");
  });

  test("진단 일시 중지는 끝이 장부 시계보다 뒤일 때만 paused다. 시계를 모르면 모름", () => {
    const diagnosis = (until: number | null, now: () => AdminClockReading = () => okAt(WALL)) => {
      const answer = readStatus(sources({ peek: { pauseUntil: until }, now }).value);
      return answer.known ? answer.status.diagnosis : answer.reason;
    };
    expect(diagnosis(null)).toBe("active");
    expect(diagnosis(WALL + 1)).toBe("paused");
    expect(diagnosis(WALL)).toBe("active");
    expect(diagnosis(WALL + 1, () => okAt(Number.NaN))).toBe("clock_unavailable");
    expect(diagnosis(WALL + 1, () => ({ state: "unavailable" }))).toBe("clock_unavailable");
    expect(diagnosis(WALL + 1, () => ({ state: "regressed" }))).toBe("clock_unavailable");
    expect(
      diagnosis(WALL + 1, () => {
        throw new Error("clock");
      }),
    ).toBe("read_threw");
  });

  test("접수 열림은 조립이 살아 있고 허가를 받아들였고 복원기가 지금도 열림일 때뿐이다", () => {
    const intake = (progress: AdminProgress, open: boolean) => {
      const answer = readStatus(sources({ progress, peek: { intakeOpen: open } }).value);
      return answer.known ? [answer.status.alive, answer.status.intakeOpen] : answer.reason;
    };
    expect(intake({ restored: true, alive: true, granted: true }, true)).toEqual([true, true]);
    expect(intake({ restored: true, alive: false, granted: true }, true)).toEqual([false, false]);
    expect(intake({ restored: true, alive: true, granted: false }, true)).toEqual([true, false]);
    expect(intake({ restored: true, alive: true, granted: true }, false)).toEqual([true, false]);
  });

  test("장부를 읽지 못함·정지 기록 없음·상한 넘는 수는 모름이다(지어내지 않는다)", () => {
    for (const reason of ["closed", "io"] as const) expect(readStatus(sources({ view: () => ({ known: false, reason }) }).value)).toEqual({ known: false, reason: "ledger_unreadable" });
    expect(readStatus(sources({ peek: { stop: null } }).value)).toEqual({ known: false, reason: "stop_unrecorded" });
    expect(readStatus(sources({ peek: { waitingRequests: 1_000_000 } }).value)).toEqual({ known: false, reason: "out_of_range" });
    expect(readStatus(sources({ peek: { slotRuns: 1_000_000 } }).value)).toEqual({ known: false, reason: "out_of_range" });
    expect(readStatus(sources({ peek: { queuedRuns: -1 } }).value)).toEqual({ known: false, reason: "out_of_range" });
    expect(
      readStatus(
        sources({
          view: () => {
            throw new Error("x");
          },
        }).value,
      ),
    ).toEqual({ known: false, reason: "read_threw" });
  });
});

// 장부의 "read" 고장 자리에 I/O 오류 한 번을 거는 장부.
function faultyLedger() {
  let armed = false;
  const ledger = open(tempPath(), {
    faults: {
      at(point: string) {
        if (point !== "read" || !armed) return;
        armed = false;
        throw Object.assign(new Error("fixture"), { code: "SQLITE_IOERR" });
      },
    },
  });
  return { ledger, arm: () => void (armed = true), armed: () => armed };
}
// 복원 시도 하나를 열고 그 시도의 허가를 낸다(정지 기록은 ready가 적는다).
function attemptOf(ledger: Ledger): symbol {
  const attempt = ledger.beginRestore(RESTORE_KEY);
  ledger.pinRestore(RESTORE_KEY, attempt);
  expect(ledger.grantIntake(RESTORE_KEY, attempt)).toBe(true);
  return attempt;
}

describe("부작용 없는 읽기: 장부의 peekStatus와 공유 시계의 peek", () => {
  test("장부의 상태 읽기가 실패해도 장부를 고장으로 표시하지 않고 허가를 버리지 않는다. 같은 고장을 다른 읽기가 만나면 표시한다(대조군)", () => {
    const { ledger, arm, armed } = faultyLedger();
    ready(ledger);
    const attempt = attemptOf(ledger);
    const state = () => ({ health: ledger.health(), intake: ledger.intakeOpen(attempt) });
    const before = state();
    expect(before).toEqual({ health: { writable: true }, intake: true });
    arm();
    expect(ledger.peekStatus(STATUS_MAX_COUNT, attempt)).toEqual({ known: false, reason: "io" });
    expect(armed()).toBe(false);
    expect(state()).toEqual(before);
    expect(ledger.peekStatus(STATUS_MAX_COUNT, attempt)).toMatchObject({ known: true, value: { intakeOpen: true } });
    // 대조군: 같은 고장을 감독의 읽기(readStop)가 만나면 장부가 고장으로 표시되고 허가가 사라진다. 그 뒤의 상태 읽기는 접수 닫힘이다.
    arm();
    expect(ledger.readStop()).toEqual({ known: false, reason: "io" });
    expect(state()).toEqual({ health: { writable: false, reason: "io" }, intake: false });
    expect(ledger.peekStatus(STATUS_MAX_COUNT, attempt)).toMatchObject({ known: true, value: { intakeOpen: false } });
  });

  test("장부의 상태 읽기: 자리를 쥔 실행은 장부 줄과 점유 관측(장부 밖 실행 포함)을 (실행, 세대)로 합쳐 세고, 개수는 상한에서 멈춘다", () => {
    const ledger = open(tempPath());
    const started = startedWorker(ledger);
    must(ledger.admitRun(worker()));
    const attempt = attemptOf(ledger);
    const outside = id();
    must(
      ledger.holdSlots(
        RESTORE_KEY,
        [
          // 장부 밖 실행이 세션 자리를 쥐고 있다(복원 2단계의 관측, 실행 줄은 없다). 두 실행기가 같은 (실행, 세대)를 말하면 하나다.
          { executorId: SESSION_EXECUTOR, runId: outside, kind: "session", runGeneration: 1, holdsSlot: true, why: "outside_ledger" },
          { executorId: "executor/session/1/store-t", runId: outside, kind: "session", runGeneration: 1, holdsSlot: true, why: "outside_ledger" },
          // 장부 줄이 이미 자리를 쥔 실행의 같은 세대 관측은 더하지 않는다.
          { executorId: WORKER_EXECUTOR, runId: started.runId, kind: "worker", runGeneration: started.from.runGeneration, holdsSlot: true, why: "state" },
        ],
        NOW,
      ),
    );
    expect(ledger.peekStatus(STATUS_MAX_COUNT, attempt)).toMatchObject({ known: true, value: { pauseUntil: null, waitingRequests: 0, queuedRuns: 1, slotRuns: 2, intakeOpen: true } });
    expect(ledger.peekStatus(1, attempt)).toMatchObject({ known: true, value: { queuedRuns: 1, slotRuns: 1 } });
    // 접수 판정은 복원기가 넘긴 시도의 허가만 센다.
    expect(ledger.peekStatus(STATUS_MAX_COUNT, null)).toMatchObject({ known: true, value: { intakeOpen: false } });
    expect(ledger.peekStatus(STATUS_MAX_COUNT, Symbol("other"))).toMatchObject({ known: true, value: { intakeOpen: false } });
    const answer = readStatus({ progress: () => ({ restored: true, alive: true, granted: true }), view: (cap) => ledger.peekStatus(cap, attempt), now: () => okAt(NOW) });
    expect(answer).toEqual({ known: true, status: { alive: true, queued: 1, running: 2, diagnosis: "active", stop: "none", stopGeneration: 0, intakeOpen: true } });
  });

  test("공유 시계의 peek는 now()가 낼 값을 내되 하한을 올리지 않는다: 일시 중지를 읽는 조회가 있든 없든 다음 읽기의 판정이 같다", () => {
    const next = (query: boolean) => {
      let value = 100;
      const clock = createSharedClock({ now: () => value });
      clock.now();
      value = 200;
      const answer = query ? readStatus({ ...sources({ peek: { pauseUntil: 250 } }).value, now: () => clock.peek() }) : null;
      value = 150;
      return { answer, next: clock.read() };
    };
    expect(next(false).next).toEqual({ state: "ok", at: 150 });
    const queried = next(true);
    expect(queried.answer).toMatchObject({ known: true, status: { diagnosis: "paused" } });
    expect(queried.next).toEqual({ state: "ok", at: 150 });
    // 원천이 하한보다 이르면 하한을 ok로 낸다(now()가 낼 값). 무효 값·던짐은 unavailable이고 던지지 않는다. 어느 쪽도 하한을 바꾸지 않는다.
    let value = 300;
    const clock = createSharedClock({ now: () => value });
    clock.now();
    value = 250;
    expect(clock.peek()).toEqual({ state: "ok", at: 300 });
    value = Number.NaN;
    expect(clock.peek()).toEqual({ state: "unavailable" });
    value = 250;
    expect(clock.read()).toEqual({ state: "regressed" });
    const throwing = createSharedClock({
      now: () => {
        throw new Error("x");
      },
    });
    expect(throwing.peek()).toEqual({ state: "unavailable" });
  });
});

describe("명령 디스패치와 종료 코드", () => {
  test("명령 이름으로 처리기를 고른다: 모르는 명령·칸이 더 붙은 status는 거절, 처리기 예외는 모름", () => {
    const handlers = createAdminHandlers(sources().value);
    expect(parseReply(answerLine(STATUS_REQUEST, handlers).slice(0, -1))).toEqual({ kind: "status", status: { ...STATUS, queued: 2, running: 1 } });
    expect(answerLine('{"command":"queue"}', handlers)).toBe('{"reply":"refused","reason":"unknown_command"}\n');
    expect(answerLine('{"command":"status","x":1}', handlers)).toBe('{"reply":"refused","reason":"malformed"}\n');
    expect(answerLine("x", handlers)).toBe('{"reply":"refused","reason":"malformed"}\n');
    const throwing = { ...handlers, status: () => {
      throw new Error("x");
    } };
    expect(answerLine(STATUS_REQUEST, throwing)).toBe('{"reply":"unknown","reason":"read_threw"}\n');
  });

  test("종료 코드: 알려진 상태 0(stdout에 상태 한 줄만), 복원 전 모름 3, 감독에 닿지 못함·읽지 못함·거절·답 없음 1, 사용법 64", () => {
    expect(exitFor({ kind: "reply", reply: { kind: "status", status: STATUS } })).toEqual({ code: 0, stdout: `${statusLine(STATUS)}\n`, stderr: "" });
    expect(exitFor({ kind: "reply", reply: { kind: "unknown", reason: "restore_not_done" } })).toEqual({ code: 3, stdout: "", stderr: "olive admin: 상태 모름: 감독이 복원을 마치지 않았다(restore_not_done)\n" });
    const cases: [AskOutcome, string][] = [
      [{ kind: "reply", reply: { kind: "unknown", reason: "ledger_unreadable" } }, "상태 모름: 감독이 상태를 읽지 못했다(ledger_unreadable)"],
      [{ kind: "reply", reply: { kind: "refused", reason: "busy" } }, "감독이 요청을 거절했다(busy)"],
      [{ kind: "unreachable", reason: "no_socket" }, "상태 모름: 감독에 닿지 못했다(no_socket)"],
      [{ kind: "unreachable", reason: "not_listening" }, "상태 모름: 감독에 닿지 못했다(not_listening)"],
      [{ kind: "failed", reason: "timeout" }, "상태 모름: 감독의 답을 받지 못했다(timeout)"],
    ];
    for (const [outcome, message] of cases) expect(exitFor(outcome)).toEqual({ code: 1, stdout: "", stderr: `olive admin: ${message}\n` });
    expect(commandOf(["status"])).toBe("status");
    for (const argv of [[], ["status", "x"], ["STATUS"], ["queue"]]) expect(commandOf(argv), argv.join(" ")).toBeNull();
    expect(USAGE.code).toBe(64);
  });
});

// 손으로 돌리는 시계 위의 붙는 쪽. connect는 곧바로 붙고, 시험이 답 바이트를 손으로 넣는다.
function fakeClient(time: ReturnType<typeof manualTime>) {
  let handlers: ClientHandlers | null = null;
  const written: string[] = [];
  const ended: number[] = [];
  const deps: ClientDeps = {
    connect: (_path, given) => {
      handlers = given;
      return Promise.resolve({
        write: (bytes) => (written.push(decode(bytes)), bytes.length),
        end: () => void ended.push(1),
      });
    },
    monoNow: time.monoNow,
    setTimer: time.setTimer,
  };
  return { deps, written, ended, handlers: () => handlers as unknown as ClientHandlers };
}

describe("붙는 쪽의 기한: 답을 받는 순간의 단조 시각으로 판정한다", () => {
  test("기한 정각에 온 답은 타이머가 아직 불리지 않았어도 쓰지 않는다(timeout). 1ms 전에 온 답은 쓴다", async () => {
    for (const [late, expected] of [
      [ADMIN_LIMITS.clientWaitMs, { kind: "failed", reason: "timeout" }],
      [ADMIN_LIMITS.clientWaitMs - 1, { kind: "reply", reply: { kind: "status", status: STATUS } }],
    ] as const) {
      const time = manualTime();
      const client = fakeClient(time);
      const asked = ask("status", client.deps, "/x/admin.sock");
      await time.flush();
      expect(client.written).toEqual([`${STATUS_REQUEST}\n`]);
      time.set(1_000 + late);
      client.handlers().data(new TextEncoder().encode(encodeReply({ kind: "status", status: STATUS })));
      expect(await asked).toEqual(expected);
      expect(client.ended.length).toBe(1);
    }
  });

  test("답이 없으면 타이머가 기한에 끝낸다. 끊김·두 줄·상한 넘음·연결 실패를 가른다", async () => {
    const time = manualTime();
    const silent = fakeClient(time);
    const waiting = ask("status", silent.deps, "/x/admin.sock");
    await time.advance(ADMIN_LIMITS.clientWaitMs);
    expect(await waiting).toEqual({ kind: "failed", reason: "timeout" });
    const outcomeOf = async (feed: (handlers: ClientHandlers) => void) => {
      const t = manualTime();
      const client = fakeClient(t);
      const asked = ask("status", client.deps, "/x/admin.sock");
      await t.flush();
      feed(client.handlers());
      return asked;
    };
    const line = encodeReply({ kind: "unknown", reason: "restore_not_done" });
    expect(await outcomeOf((h) => h.close())).toEqual({ kind: "failed", reason: "closed" });
    expect(await outcomeOf((h) => h.data(new TextEncoder().encode(line + line)))).toEqual({ kind: "failed", reason: "malformed" });
    expect(await outcomeOf((h) => h.data(new Uint8Array(ADMIN_LIMITS.replyMaxBytes).fill(0x20)))).toEqual({ kind: "failed", reason: "too_long" });
    // 나뉘어 온 한 줄은 이어 붙여 읽는다.
    expect(
      await outcomeOf((h) => {
        h.data(new TextEncoder().encode(line.slice(0, 5)));
        h.data(new TextEncoder().encode(line.slice(5)));
      }),
    ).toEqual({ kind: "reply", reply: { kind: "unknown", reason: "restore_not_done" } });
    for (const [code, reason] of [["ENOENT", "no_socket"], ["ECONNREFUSED", "not_listening"], ["EACCES", "connect_failed"]] as const) {
      const t = manualTime();
      const deps: ClientDeps = { connect: () => Promise.reject(Object.assign(new Error(code), { code })), monoNow: t.monoNow, setTimer: t.setTimer };
      expect(await ask("status", deps, "/x/admin.sock")).toEqual({ kind: "unreachable", reason });
    }
  });

  test("연결을 받은 순간이 기한 정각이면 요청을 쓰지 않고 닫는다(타이머가 아직 불리지 않았어도). 1ms 전이면 쓴다", async () => {
    for (const [late, writes] of [
      [ADMIN_LIMITS.clientWaitMs, 0],
      [ADMIN_LIMITS.clientWaitMs - 1, 1],
    ] as const) {
      const time = manualTime();
      const written: string[] = [];
      const ended: number[] = [];
      let complete: (socket: ClientSocket) => void = () => {};
      const deps: ClientDeps = {
        connect: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
        monoNow: time.monoNow,
        setTimer: time.setTimer,
      };
      const asked = ask("status", deps, "/x/admin.sock");
      time.set(1_000 + late);
      complete({ write: (bytes) => (written.push(decode(bytes)), bytes.length), end: () => void ended.push(1) });
      await time.flush();
      expect(written).toEqual(writes === 0 ? [] : [`${STATUS_REQUEST}\n`]);
      if (writes === 0) expect(ended.length).toBe(1);
      else await time.advance(ADMIN_LIMITS.clientWaitMs);
      expect(await asked).toEqual({ kind: "failed", reason: "timeout" });
    }
  });
});

// 손으로 넣는 듣기. 시험이 연결을 열고 바이트를 넣는다.
function fakeListener(time: ReturnType<typeof manualTime>, answer: (line: string) => string = () => encodeReply({ kind: "status", status: STATUS }), kind: ReturnType<AdminFs["kind"]> = "absent") {
  let handlers: AdminSocketHandlers | null = null;
  const fsCalls: string[] = [];
  const answered: string[] = [];
  const notes: string[] = [];
  let stops = 0;
  const fs: AdminFs = {
    kind: () => kind,
    unlink: () => void fsCalls.push("unlink"),
    chmod: (_path, mode) => void fsCalls.push(`chmod:${mode.toString(8)}`),
  };
  const listening = listenAdmin({
    path: "/x/admin.sock",
    mode: ADMIN_SOCKET_MODE,
    fs,
    monoNow: time.monoNow,
    setTimer: time.setTimer,
    answer: (line) => (answered.push(line), answer(line)),
    note: (value) => void notes.push(value),
    listen: (_path, given) => {
      fsCalls.push("listen");
      handlers = given;
      return { stop: () => void (stops += 1) };
    },
  });
  const peer = (writeLimit = Number.POSITIVE_INFINITY) => {
    const out: string[] = [];
    let ends = 0;
    const value: AdminPeer = {
      write: (bytes) => {
        const n = Math.min(bytes.length, writeLimit);
        out.push(decode(bytes.subarray(0, n)));
        return n;
      },
      end: () => void (ends += 1),
    };
    return { value, out, ends: () => ends };
  };
  return { listening, fsCalls, answered, notes, handlers: () => handlers as unknown as AdminSocketHandlers, peer, stops: () => stops };
}

describe("듣는 쪽: 연결 하나 = 요청 한 줄 → 답 한 줄 → 닫기", () => {
  test("요청 줄을 다 받은 순간이 기한 정각이면 답하지 않고 닫는다(타이머가 아직 불리지 않았어도). 1ms 전이면 답한다", () => {
    for (const [late, answered] of [
      [ADMIN_LIMITS.serverWaitMs, false],
      [ADMIN_LIMITS.serverWaitMs - 1, true],
    ] as const) {
      const time = manualTime();
      const l = fakeListener(time);
      const p = l.peer();
      l.handlers().open(p.value);
      time.set(1_000 + late);
      l.handlers().data(p.value, new TextEncoder().encode(`${STATUS_REQUEST}\n`));
      expect(l.answered.length).toBe(answered ? 1 : 0);
      expect(p.out).toEqual(answered ? [encodeReply({ kind: "status", status: STATUS })] : []);
      expect(p.ends()).toBe(1);
    }
  });

  test("요청 없이 쉬는 연결은 기한 타이머가 닫는다. 상한을 넘는 줄은 답하지 않고, 줄 뒤에 더 온 바이트는 거절한다", async () => {
    const time = manualTime();
    const l = fakeListener(time);
    const idle = l.peer();
    l.handlers().open(idle.value);
    await time.advance(ADMIN_LIMITS.serverWaitMs);
    expect(idle.ends()).toBe(1);
    const long = l.peer();
    l.handlers().open(long.value);
    l.handlers().data(long.value, new Uint8Array(ADMIN_LIMITS.requestMaxBytes).fill(0x20));
    expect([long.out, long.ends()]).toEqual([[], 1]);
    const extra = l.peer();
    l.handlers().open(extra.value);
    l.handlers().data(extra.value, new TextEncoder().encode(`${STATUS_REQUEST}\n{}`));
    expect([extra.out, extra.ends()]).toEqual([[encodeReply({ kind: "refused", reason: "malformed" })], 1]);
    expect(l.answered).toEqual([]);
  });

  test("동시 연결 상한을 넘은 연결에는 busy를 답하고 닫는다. 다 못 쓴 답은 drain에서 이어 쓴 뒤 닫는다", () => {
    const time = manualTime();
    const l = fakeListener(time);
    const held = Array.from({ length: ADMIN_LIMITS.maxConnections }, () => l.peer());
    for (const p of held) l.handlers().open(p.value);
    const over = l.peer();
    l.handlers().open(over.value);
    expect([over.out, over.ends()]).toEqual([[encodeReply({ kind: "refused", reason: "busy" })], 1]);
    l.handlers().close(held[0]!.value);
    const slow = l.peer(10);
    l.handlers().open(slow.value);
    l.handlers().data(slow.value, new TextEncoder().encode(`${STATUS_REQUEST}\n`));
    expect(slow.ends()).toBe(0);
    for (let i = 0; i < 100 && slow.ends() === 0; i += 1) l.handlers().drain(slow.value);
    expect(slow.out.join("")).toBe(encodeReply({ kind: "status", status: STATUS }));
    expect(slow.ends()).toBe(1);
  });

  test("다 못 쓴 답에 drain이 오지 않으면 쓰기 기한에 닫고 연결 자리를 돌려준다. drain을 받은 순간이 기한 정각이면 쓰지 않고 닫는다", async () => {
    const request = new TextEncoder().encode(`${STATUS_REQUEST}\n`);
    const time = manualTime();
    const l = fakeListener(time);
    const stuck = Array.from({ length: ADMIN_LIMITS.maxConnections }, () => l.peer(0));
    for (const p of stuck) {
      l.handlers().open(p.value);
      l.handlers().data(p.value, request);
    }
    expect(stuck.map((p) => p.ends())).toEqual([0, 0, 0, 0]);
    await time.advance(ADMIN_LIMITS.serverWriteWaitMs - 1);
    expect(stuck.map((p) => p.ends())).toEqual([0, 0, 0, 0]);
    await time.advance(1);
    expect(stuck.map((p) => p.ends())).toEqual([1, 1, 1, 1]);
    expect(l.notes).toEqual(["write_late", "write_late", "write_late", "write_late"]);
    expect(time.pending()).toBe(0);
    // 자리를 돌려받았다: 새 연결이 busy 없이 답을 받는다.
    const fresh = l.peer();
    l.handlers().open(fresh.value);
    l.handlers().data(fresh.value, request);
    expect([fresh.out, fresh.ends()]).toEqual([[encodeReply({ kind: "status", status: STATUS })], 1]);
    for (const [at, closed] of [
      [ADMIN_LIMITS.serverWriteWaitMs, true],
      [ADMIN_LIMITS.serverWriteWaitMs - 1, false],
    ] as const) {
      const t = manualTime();
      const s = fakeListener(t);
      const slow = s.peer(0);
      s.handlers().open(slow.value);
      s.handlers().data(slow.value, request);
      const writes = slow.out.length;
      t.set(1_000 + at);
      s.handlers().drain(slow.value);
      expect([slow.out.length - writes, slow.ends()]).toEqual(closed ? [0, 1] : [1, 0]);
    }
  });

  test("경로: 남은 소켓은 지우고 듣고, 소켓이 아닌 파일·상대 경로는 듣지 않는다. 듣고 나서 권한을 0600으로 둔다", () => {
    const time = manualTime();
    expect(fakeListener(time).fsCalls).toEqual(["listen", "chmod:600"]);
    expect(fakeListener(time, undefined, "socket").fsCalls).toEqual(["unlink", "listen", "chmod:600"]);
    expect(() => fakeListener(time, undefined, "other")).toThrow(AdminListenRefused);
    const base = { mode: ADMIN_SOCKET_MODE, fs: adminFs, monoNow: time.monoNow, setTimer: time.setTimer, answer: () => "" };
    expect(() => listenAdmin({ ...base, path: "admin.sock" })).toThrow("path_not_absolute");
    expect(() => listenAdmin({ ...base, path: "\0olive-admin" })).toThrow("path_not_absolute");
  });
});

// 실제 Bun.connect로 붙는 쪽(관리 진입점과 같은 모양).
function realClient(): ClientDeps {
  const clock = loopbackTime();
  return {
    connect: (path, handlers) =>
      Bun.connect({
        unix: path,
        socket: { data: (_socket, chunk) => handlers.data(chunk), close: () => handlers.close(), error: () => handlers.close() },
      }),
    monoNow: clock.mono,
    setTimer: clock.setTimer,
  };
}

describe("루프백: 실제 경로 유닉스 소켓", () => {
  test("감독 쪽 듣기와 진입점 쪽 붙기가 상태 한 줄을 주고받는다. 소켓 권한은 0600, 멈추면 소켓이 사라지고 그 뒤는 감독 없음(1)이다", async () => {
    const path = join(tempDir(), "admin.sock");
    const clock = loopbackTime();
    let progress: AdminProgress = { restored: false, alive: true, granted: false };
    const handlers = createAdminHandlers({ ...sources().value, progress: () => progress });
    const listening = listenAdmin({ path, mode: ADMIN_SOCKET_MODE, fs: adminFs, monoNow: clock.mono, setTimer: clock.setTimer, answer: (line) => answerLine(line, handlers) });
    try {
      expect(lstatSync(path).isSocket()).toBe(true);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(exitFor(await ask("status", realClient(), path))).toEqual({ code: 3, stdout: "", stderr: "olive admin: 상태 모름: 감독이 복원을 마치지 않았다(restore_not_done)\n" });
      progress = { restored: true, alive: true, granted: true };
      expect(exitFor(await ask("status", realClient(), path))).toEqual({ code: 0, stdout: `${statusLine(STATUS)}\n`, stderr: "" });
    } finally {
      listening.stop();
    }
    expect(existsSync(path)).toBe(false);
    expect(exitFor(await ask("status", realClient(), path))).toEqual({ code: 1, stdout: "", stderr: "olive admin: 상태 모름: 감독에 닿지 못했다(no_socket)\n" });
    // 소켓이 아닌 파일이 그 경로에 있으면 감독은 지우지 않고 듣지 않는다. 붙는 쪽은 듣는 프로세스 없음으로 본다.
    writeFileSync(path, "x");
    expect(() => listenAdmin({ path, mode: ADMIN_SOCKET_MODE, fs: adminFs, monoNow: clock.mono, setTimer: clock.setTimer, answer: () => "" })).toThrow("path_taken");
    expect(readFileSync(path, "utf8")).toBe("x");
    expect(exitFor(await ask("status", realClient(), path)).stderr).toBe("olive admin: 상태 모름: 감독에 닿지 못했다(not_listening)\n");
  });

  test("관리 진입점: 인자가 틀리면 64, 감독 소켓이 없으면 stdout 없이 1", () => {
    expect(existsSync(ADMIN_SOCKET_PATH)).toBe(false);
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, "src/main/admin.ts", ...args], { cwd: root, env: { PATH: process.env.PATH ?? "" }, timeout: 10_000 });
    for (const args of [[], ["status", "x"], ["queue"]]) {
      const result = run(...args);
      expect([result.exitCode, result.stdout.toString(), result.stderr.toString()]).toEqual([64, "", "olive admin: 사용법: bun src/main/admin.ts <status>\n"]);
    }
    const result = run("status");
    expect([result.exitCode, result.stdout.toString(), result.stderr.toString()]).toEqual([1, "", "olive admin: 상태 모름: 감독에 닿지 못했다(no_socket)\n"]);
  });
});

// 실제 조립(boot.ts)의 관리 포트. 장부를 감싸 부른 메서드를 적고, 가짜 서버의 송신 두 자리를 센다. fault는 장부의 "read" 고장 자리에 걸린다.
async function bootAdmin(fault?: () => void): Promise<{ w: World; running: RunningSupervisor; calls: string[]; raw: () => Ledger; sends: { frames: number; closes: number } }> {
  const calls: string[] = [];
  let raw: Ledger | null = null;
  const w = world({
    deps: {
      openLedger: (file, options) => {
        const base = options.faults;
        const faults = fault === undefined ? base : { ...base, at: (point: string) => (point === "read" && fault(), base?.at(point)) };
        const result = openLedger(file, { ...options, faults });
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
  server.writeFrame = () => (sends.frames += 1, { kind: "not_written", reason: "not_recognized" });
  server.closeConnection = () => (sends.closes += 1, { kind: "not_open" });
  const result = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  return { w, running: result.running, calls, raw: () => raw as unknown as Ledger, sends };
}

const restoreSteps = (w: World) => w.events.filter((e) => e.event === "restore_step").map((e) => e.fields.step);
async function untilStep(w: World, step: number): Promise<void> {
  for (let i = 0; i < 20 && !restoreSteps(w).includes(step); i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
  expect(restoreSteps(w)).toContain(step);
}
const statusOf = (running: RunningSupervisor) => parseReply(answerLine(STATUS_REQUEST, createAdminHandlers(running.admin)).slice(0, -1));
// 장부 파일의 해시는 다른 프로세스에서 잰다: 감독이 장부를 연 동안 같은 프로세스가 그 파일을 따로 열고 닫으면 감독의 POSIX 잠금이
// 풀릴 수 있다(src/ledger/ledger.md).
function fileHash(path: string): string | null {
  const script = `const fs = require("node:fs"); const p = ${JSON.stringify(path)}; process.stdout.write(fs.existsSync(p) ? require("node:crypto").createHash("sha256").update(fs.readFileSync(p)).digest("hex") : "null");`;
  const result = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: process.env.PATH ?? "" }, timeout: 10_000 });
  if (result.exitCode !== 0) throw new Error(`해시를 재지 못함: ${result.stderr.toString()}`);
  const text = result.stdout.toString();
  return text === "null" ? null : text;
}

describe("실제 조립의 관리 포트", () => {
  test("복원 4단계까지 받아들인 감독(정지 기록은 이미 합침)도 5단계 전에는 모름(restore_not_done, 3)이고 장부를 읽지 않는다. 5단계 뒤에는 알려진 상태다", async () => {
    const { w, running, calls, raw } = await bootAdmin();
    await untilStep(w, 4);
    expect(restoreSteps(w)).toEqual([1, 2, 3, 4]);
    // 장부에는 이미 읽을 정지 기록이 있다: 판정이 복원 단계를 보지 않으면 여기서 알려진 상태가 나온다.
    expect(raw().readStop()).toMatchObject({ known: true, value: { generation: 0, stopped: false } });
    const before = calls.length;
    const reply = statusOf(running);
    expect(reply).toEqual({ kind: "unknown", reason: "restore_not_done" });
    expect(calls.slice(before)).toEqual([]);
    expect(exitFor({ kind: "reply", reply: reply! }).code).toBe(3);
    await untilStep(w, 5);
    expect(statusOf(running)).toEqual({ kind: "status", status: { alive: true, queued: 0, running: 0, diagnosis: "active", stop: "none", stopGeneration: 0, intakeOpen: true } });
    await running.stop();
  });

  test("상태 읽기는 장부에 쓰지 않고 연결에 싣지 않는다: 부른 장부 메서드는 읽기뿐이고 장부 파일·송신 수가 그대로다", async () => {
    const { w, running, calls, raw, sends } = await bootAdmin();
    await untilStep(w, 5);
    // 시험이 쓴 진단 일시 중지(관리 통로가 쓴 것이 아니다).
    expect(raw().setPause(WALL + 60_000)).toEqual({ ok: true });
    const files = () => [w.ledgerPath, `${w.ledgerPath}-wal`].map(fileHash);
    const before = { files: files(), calls: calls.length, sends: { ...sends } };
    const replies = [statusOf(running), statusOf(running), statusOf(running)];
    for (const reply of replies) expect(reply).toEqual({ kind: "status", status: { alive: true, queued: 0, running: 0, diagnosis: "paused", stop: "none", stopGeneration: 0, intakeOpen: true } });
    expect(calls.slice(before.calls)).toEqual(["peekStatus", "peekStatus", "peekStatus"]);
    expect(files()).toEqual(before.files);
    expect(before.files[0]).not.toBeNull();
    expect(sends).toEqual(before.sends);
    // 끝 차례 뒤에는 장부가 닫혀 모름(1)이다.
    await running.stop();
    const after = statusOf(running);
    expect(after).toEqual({ kind: "unknown", reason: "ledger_unreadable" });
    expect(exitFor({ kind: "reply", reply: after! }).code).toBe(1);
  });

  test("상태 조회 중 장부 읽기가 실패해도 감독 상태가 그대로다: 그 조회만 모름(1)이고, 장부 건강·조립 상태·장부 파일이 같고, 감독은 끝나지 않는다", async () => {
    let armed = false;
    const { w, running, raw } = await bootAdmin(() => {
      if (!armed) return;
      armed = false;
      throw Object.assign(new Error("fixture"), { code: "SQLITE_IOERR" });
    });
    await untilStep(w, 5);
    const state = () => ({ health: raw().health(), progress: running.admin.progress(), files: [w.ledgerPath, `${w.ledgerPath}-wal`].map(fileHash) });
    const before = state();
    expect(before.progress).toEqual({ restored: true, alive: true, granted: true });
    armed = true;
    const reply = statusOf(running);
    expect(armed).toBe(false);
    expect(reply).toEqual({ kind: "unknown", reason: "ledger_unreadable" });
    expect(exitFor({ kind: "reply", reply: reply! })).toEqual({ code: 1, stdout: "", stderr: "olive admin: 상태 모름: 감독이 상태를 읽지 못했다(ledger_unreadable)\n" });
    expect(state()).toEqual(before);
    // 감독은 박자를 이어 가고 끝낼 사유를 붙잡지 않는다. 다음 조회는 알려진 상태이고 접수는 열려 있다.
    for (let i = 0; i < 3; i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
    expect(w.names()).not.toContain("fatal");
    expect(statusOf(running)).toEqual({ kind: "status", status: { alive: true, queued: 0, running: 0, diagnosis: "active", stop: "none", stopGeneration: 0, intakeOpen: true } });
    expect(await running.stop()).toBe(0);
  });

  test("일시 중지를 읽는 조회도 공유 시계의 하한을 올리지 않는다: 조회 뒤 원천 시계가 조회 시각보다 이르게 와도 감독의 다음 읽기는 regressed가 아니다", async () => {
    const { w, running, raw } = await bootAdmin();
    await untilStep(w, 5);
    expect(raw().setPause(WALL + 60_000)).toEqual({ ok: true });
    w.wall = WALL + 50_000;
    expect(statusOf(running)).toMatchObject({ kind: "status", status: { diagnosis: "paused" } });
    w.wall = WALL + 10_000;
    expect(w.captured.shared?.read()).toEqual({ state: "ok", at: WALL + 10_000 });
    expect(await running.stop()).toBe(0);
  });
});
