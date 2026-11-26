// 시험 배정 값(src/supervisor/runtime/test-assign.ts)의 시험: 시험 숫자와 T1 역할, 진입점 설정(시험 값에서만 채우고 운영 값은 닫힌 값 그대로),
// 사실 공급자(앞 실행의 종료 미확인 하나만, 모르면 비움), 읽기 지점마다 던짐·모름을 넣는 훑기, 실제 조립에서 시험 작업 하나가 고르기까지 가서
// 근거 없는 다섯 사실로 보류되는 것과 운영 값의 policy_rejected, 진입점·조립의 연결 글.
// 진입점을 실제로 띄워 기동 기록 test_assign 한 줄을 보는 것은 test/entrypoints.test.ts가 한다.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { LEDGER_RUN_STATES, type Ledger } from "../../../src/ledger/index.ts";
import { frontDoorFor, SUPERVISOR_ENV, settingsFromEnv } from "../../../src/main/supervisor.ts";
import { type AskOutcome, exitFor } from "../../../src/supervisor/admin/client.ts";
import { answerLine, createAdminHandlers } from "../../../src/supervisor/admin/commands.ts";
import { ADMIN_LIMITS, parseReply, type TestJobRequest } from "../../../src/supervisor/admin/protocol.ts";
import { type AssignLoopPolicy, type AssignLoopPorts, assignAndStartTick, type TickResult } from "../../../src/supervisor/dispatch/assign-loop.ts";
import { lifeTick } from "../../../src/supervisor/dispatch/life-loop.ts";
import { linkLossTick } from "../../../src/supervisor/dispatch/link-loss.ts";
import { pickAssignment, PRE_ASSIGN_FACTS, type PreAssignFact, type PreAssignFacts } from "../../../src/supervisor/dispatch/pick.ts";
import { resendTick } from "../../../src/supervisor/dispatch/resend.ts";
import { resultCheckTick } from "../../../src/supervisor/dispatch/result-check.ts";
import { unreceivedTick } from "../../../src/supervisor/dispatch/unreceived.ts";
import { TEST_FRONT_DOOR_OWNER, testOriginOf } from "../../../src/supervisor/frontdoor/test-double.ts";
import { ROLE_POLICIES } from "../../../src/supervisor/roles/policy.ts";
import type { RunningSupervisor, SupervisorSettings } from "../../../src/supervisor/runtime/boot.ts";
import {
  END_UNCONFIRMED,
  TEST_ASSIGN_NUMBERS,
  TEST_ASSIGN_ROLE,
  TEST_ASSIGN_SNAPSHOT_DIGEST,
  type TestFactLedger,
  testAssignPolicy,
  testFactSource,
} from "../../../src/supervisor/runtime/test-assign.ts";
import { planNext } from "../../../src/supervisor/scheduler/queue.ts";
import { list, readText } from "../../files.ts";
import { digest } from "../../ledger/helpers.ts";
import { type World, world } from "./boot-world.ts";

const FULL: Record<(typeof SUPERVISOR_ENV)[number], string> = {
  OLIVE_SUPERVISOR_PORT: "8443",
  OLIVE_LEDGER_DIR: "/var/lib/olive",
  OLIVE_SIGNING_KEY_DIR: "/etc/olive/signing",
  OLIVE_ACCOUNTS_DIR: "/etc/olive/accounts",
  OLIVE_TLS_DIR: "/etc/olive/tls",
  OLIVE_TRUST_DIR: "/etc/olive/trust",
  OLIVE_REGISTRY_FILE: "/etc/olive/registry/registry.json",
  OLIVE_ENVIRONMENT: "home",
  OLIVE_TARGETS: JSON.stringify([{ target: "diagnosis", namespace: "olive-diagnosis", roles: ["diagnosis"] }]),
  OLIVE_POLICY_REVISION: "policy-1",
  OLIVE_RESULT_DIR: "/var/lib/olive/results",
};

function settingsOf(extra: Record<string, string>) {
  const parsed = settingsFromEnv({ ...FULL, ...extra });
  if (!parsed.ok) throw new Error(`${parsed.name} ${parsed.problem}`);
  return parsed.settings;
}

// 근거 원천이 없어 시험 공급자가 비우는 다섯 사실. 앞 실행의 종료 미확인만 채운다.
const SOURCELESS: readonly PreAssignFact[] = ["role_purpose_not_allowed", "source_not_pinned", "self_repo_write", "external_code", "self_fix_basis_closed"];
// 종료 영수증이 아직 없는 작업자 상태. 구현의 목록을 쓰지 않고 장부의 상태 표(ledger/states.ts)에서 이 시험이 직접 고른다.
const OPEN_STATES: readonly string[] = ["preparing", "running", "stopping", "unknown_running"];

describe("시험 숫자와 T1 역할", () => {
  test("T1 역할은 진단이고 구독 방식을 받는다. 숫자는 한 자리의 시험 숫자이고 snapshot digest는 고정 표지의 SHA-256이다", () => {
    expect(TEST_ASSIGN_ROLE).toBe("diagnosis");
    expect(ROLE_POLICIES[TEST_ASSIGN_ROLE].methods).toContain("subscription");
    expect(ROLE_POLICIES[TEST_ASSIGN_ROLE].target).toBe("diagnosis");
    expect(TEST_ASSIGN_NUMBERS).toEqual({ runBudgetTokens: 1_000, requestBudgetTokens: 1_000, runDurationMs: 600_000 });
    expect(Object.isFrozen(TEST_ASSIGN_NUMBERS)).toBe(true);
    expect(TEST_ASSIGN_SNAPSHOT_DIGEST).toBe(createHash("sha256").update("olive-test-assign/no-snapshot").digest("hex"));
  });

  test("실행 계획은 T1 역할 하나, 요청 한도는 두 출처 모두 시험 숫자다. 부를 때마다 새로 얼린 값이고 planNext가 받는다", () => {
    const a = testAssignPolicy();
    const b = testAssignPolicy();
    expect(a).toEqual({
      plans: [{ role: "diagnosis", snapshotDigest: TEST_ASSIGN_SNAPSHOT_DIGEST, budgetLeft: 1_000, runDurationMs: 600_000 }],
      requestBudget: { admin: 1_000, alert: 1_000 },
    });
    expect([a.plans === b.plans, a.requestBudget === b.requestBudget, Object.isFrozen(a.plans), Object.isFrozen(a.plans[0]), Object.isFrozen(a.requestBudget)]).toEqual([false, false, true, true, true]);
    expect(planNext({ runs: [], inputs: [], slotHolds: [], now: 1 }, { alertMaxWaitMs: 60_000, requestBudget: a.requestBudget })).toEqual({ candidates: [], held: [] });
  });
});

describe("진입점 설정", () => {
  test("운영 값(OLIVE_TEST_JOBS 없음·빈 값·off)은 실행 계획 없음·요청 한도 0·사실 모름(testAssign 거짓) 그대로다", () => {
    for (const extra of [{}, { OLIVE_TEST_JOBS: "" }, { OLIVE_TEST_JOBS: "off" }] as Record<string, string>[]) {
      const s = settingsOf(extra);
      expect([JSON.stringify(extra), s.assign.plans, s.assign.queue, s.testAssign, s.testJobs]).toEqual([
        JSON.stringify(extra),
        [],
        { alertMaxWaitMs: 60_000, requestBudget: { admin: 0, alert: 0 } },
        false,
        false,
      ]);
      expect(() => planNext({ runs: [], inputs: [], slotHolds: [], now: 1 }, s.assign.queue)).toThrow(TypeError);
    }
  });

  test("시험 값(OLIVE_TEST_JOBS=on)이면 시험 숫자의 실행 계획·요청 한도와 시험 사실 공급자(testAssign 참)다. 현관 대역과 무관하다", () => {
    for (const extra of [{ OLIVE_TEST_JOBS: "on" }, { OLIVE_TEST_JOBS: "on", OLIVE_TEST_FRONTDOOR: "on" }] as Record<string, string>[]) {
      const s = settingsOf(extra);
      expect([JSON.stringify(extra), s.assign.plans, s.assign.queue, s.testAssign]).toEqual([JSON.stringify(extra), testAssignPolicy().plans, { alertMaxWaitMs: 60_000, requestBudget: { admin: 1_000, alert: 1_000 } }, true]);
    }
  });

  // 결정이 나서 다섯 사실이 채워진 뒤의 모습을 고르기 하나로 본다(운영 코드가 아니라 이 시험이 사실을 넣는다). 시험 값의 실행 계획이 고르기의
  // 꼴 검사를 지나고 기한·예산·snapshot이 시험 숫자 그대로 장부 입력에 실리는지가 목적이다.
  test("시험 값의 실행 계획은 고르기를 지난다: 사실이 모두 확인되면 T1 역할의 배정 입력에 시험 숫자가 실린다", () => {
    const s = settingsOf({ OLIVE_TEST_JOBS: "on", OLIVE_ACCOUNT_NAME: "acct-a", OLIVE_ACCOUNT_REVISION: "acct-7", OLIVE_PROFILE_REVISIONS: JSON.stringify({ diagnosis: "prof-1" }) });
    const now = 1_800_000_000_000;
    const picked = pickAssignment({
      request: { ref: "11111111-1111-4111-8111-111111111111", role: "diagnosis", inputDigest: "a".repeat(64), input: { cancelled: false, expiresAt: now + 3_600_000 } },
      connections: [{ connection: 1, target: "diagnosis", principal: { kind: "worker_executor", role: "diagnosis", instance: "d1", storage: "s1" }, keyId: "key-d", hello: { profile_revision: "prof-1", policy_revision: "policy-1" } }],
      assignment: { ...s.assign.assignment, registrations: [{ target: "diagnosis", role: "diagnosis", instance: "d1", storage: "s1", keyId: "key-d", active: true }] },
      accounts: s.assign.accounts,
      credential: { account: "acct-a", method: "subscription", revision: "acct-7", digest: "c".repeat(64) },
      plans: s.assign.plans,
      facts: Object.fromEntries(PRE_ASSIGN_FACTS.map((fact) => [fact, false])),
      intakeOpen: true,
      now,
    });
    expect(picked).toMatchObject({ kind: "assign", input: { executorId: "executor/diagnosis/d1/s1", snapshotDigest: TEST_ASSIGN_SNAPSHOT_DIGEST, budgetLeft: 1_000, deadlineAt: now + 600_000 } });
  });
});

const run = (kind: unknown, state: unknown) => ({ runId: "11111111-1111-4111-8111-111111111111", kind, state });
const hold = (kind: unknown, holdsSlot: unknown) => ({ executorId: "executor/diagnosis/d1/s1", runId: "11111111-1111-4111-8111-111111111111", kind, runGeneration: 1, holdsSlot, why: "state", observation: 1 });
const ledgerOf = (runs: unknown, holds: unknown = { known: true, value: [] }) =>
  ({ listRuns: () => (typeof runs === "function" ? runs() : runs), slotHolds: () => (typeof holds === "function" ? holds() : holds) }) as unknown as TestFactLedger;
const known = (value: unknown) => ({ known: true, value });
const factsOf = (ledger: TestFactLedger) => testFactSource(ledger).facts({} as never) as PreAssignFacts;

describe("사실 공급자", () => {
  test("작업자 실행: 종료 영수증 전의 상태가 하나라도 있으면 true, 장부의 나머지 상태뿐이면 false다. 세션 실행은 보지 않는다", () => {
    expect(factsOf(ledgerOf(known([])))).toEqual({ prior_run_end_unconfirmed: false });
    for (const state of LEDGER_RUN_STATES) {
      const open = OPEN_STATES.includes(state);
      expect([state, factsOf(ledgerOf(known([run("worker", "finalized"), run("worker", state)])))]).toEqual([state, { prior_run_end_unconfirmed: open }]);
      expect([state, factsOf(ledgerOf(known([run("session", state)])))]).toEqual([state, { prior_run_end_unconfirmed: false }]);
    }
    // 구현의 목록이 장부 상태의 부분집합이고 이 시험의 목록과 같다.
    expect<readonly string[]>([...END_UNCONFIRMED].sort()).toEqual([...OPEN_STATES].sort());
  });

  test("재시작 복원의 점유 관측: 작업자 자리를 쥔 관측이 있으면 true, 세션 자리나 쥐지 않은 관측은 false다", () => {
    const empty = known([]);
    expect(factsOf(ledgerOf(empty, known([hold("worker", true)])))).toEqual({ prior_run_end_unconfirmed: true });
    expect(factsOf(ledgerOf(empty, known([hold("worker", false), hold("session", true)])))).toEqual({ prior_run_end_unconfirmed: false });
  });

  test("읽기가 모름·던짐이거나 줄의 꼴이 장부의 값이 아니면 칸을 비운다(false로 채우지 않는다). 나머지 다섯 칸은 늘 비어 있다", () => {
    const throws = () => {
      throw new Error("x");
    };
    const sparse = [run("worker", "finalized")];
    sparse.length = 2;
    const cases: [string, TestFactLedger][] = [
      ["runs unknown", ledgerOf({ known: false })],
      ["runs known 문자열", ledgerOf({ known: "true", value: [] })],
      ["runs throws", ledgerOf(throws)],
      ["runs 배열 아님", ledgerOf(known({ length: 0 }))],
      ["runs 빈 자리", ledgerOf(known(sparse))],
      ["runs 원소 null", ledgerOf(known([null]))],
      ["runs 종류 모름", ledgerOf(known([run("job", "finalized")]))],
      ["runs 상태 모름", ledgerOf(known([run("worker", "done")]))],
      ["runs 상태 빠짐", ledgerOf(known([{ kind: "worker" }]))],
      ["holds unknown", ledgerOf(known([]), { known: false })],
      ["holds throws", ledgerOf(known([]), throws)],
      ["holds 점유 칸 문자열", ledgerOf(known([]), known([hold("worker", "false")]))],
      ["holds 종류 모름", ledgerOf(known([]), known([hold(undefined, false)]))],
      ["포트 없음", {} as TestFactLedger],
    ];
    for (const [name, ledger] of cases) expect([name, factsOf(ledger)]).toEqual([name, {}]);
    for (const ledger of [ledgerOf(known([])), ledgerOf(known([run("worker", "running")]))]) {
      const facts = factsOf(ledger);
      expect(SOURCELESS.filter((fact) => Object.hasOwn(facts, fact))).toEqual([]);
    }
  });
});

// 읽기 지점마다 한 번씩 던지거나 모름(값은 undefined, has는 false, 호출은 undefined)을 넣는다. 읽기 지점은 프록시가 지나는 get·has·호출 전부다.
type Fault = { readonly at: number; readonly mode: "throw" | "unknown" } | null;
function faulty<T extends object>(target: T, fault: Fault, seen: string[]): T {
  const hit = (point: string): boolean => {
    const index = seen.length;
    seen.push(point);
    if (fault === null || fault.at !== index) return false;
    if (fault.mode === "throw") throw new Error(`fault:${point}`);
    return true;
  };
  const wrap = (value: unknown): unknown => (typeof value === "object" && value !== null ? faulty(value, fault, seen) : value);
  return new Proxy(target, {
    get(obj, key, receiver) {
      const point = `get:${String(key)}`;
      if (hit(point)) return undefined;
      const value: unknown = Reflect.get(obj, key, receiver);
      if (typeof value !== "function") return wrap(value);
      return (...args: unknown[]) => {
        if (hit(`call:${String(key)}`)) return undefined;
        return wrap(Reflect.apply(value, obj, args));
      };
    },
    has(obj, key) {
      if (hit(`has:${String(key)}`)) return false;
      return Reflect.has(obj, key);
    },
  });
}

// 훑기의 장면. 기준 답이 false인 장면(모든 상태의 줄이 섞여도 열린 작업자 실행 없음)과 true인 장면(작업자 하나가 running).
const SWEEP_SCENES: readonly { readonly name: string; readonly runs: readonly unknown[]; readonly holds: readonly unknown[]; readonly expected: boolean }[] = [
  {
    name: "closed",
    runs: [run("worker", "finalized"), run("worker", "queued"), run("worker", "cleanup_pending"), run("session", "running")],
    holds: [hold("worker", false), hold("session", true)],
    expected: false,
  },
  { name: "open", runs: [run("worker", "finalized"), run("worker", "running")], holds: [hold("worker", false)], expected: true },
];

function sweepScene(scene: (typeof SWEEP_SCENES)[number]): { points: number; outcomes: { at: number; mode: string; point: string; facts: PreAssignFacts }[]; baseline: PreAssignFacts } {
  const fresh = () => ({ listRuns: () => known(structuredClone(scene.runs)), slotHolds: () => known(structuredClone(scene.holds)) });
  const seen: string[] = [];
  const baseline = factsOf(faulty(fresh(), null, seen) as unknown as TestFactLedger);
  const points = [...seen];
  const outcomes: { at: number; mode: string; point: string; facts: PreAssignFacts }[] = [];
  for (let at = 0; at < points.length; at += 1) {
    for (const mode of ["throw", "unknown"] as const) {
      const facts = factsOf(faulty(fresh(), { at, mode }, []) as unknown as TestFactLedger);
      outcomes.push({ at, mode, point: points[at] as string, facts });
    }
  }
  return { points: points.length, outcomes, baseline };
}

describe("하네스 훑기", () => {
  test("공급자의 읽기 지점마다 던짐·모름을 넣어도 답은 false(종료 확인)가 아니고, 고르기는 다섯 사실을 확인으로 넣어도 배정하지 않는다", () => {
    const now = 1_800_000_000_000;
    for (const scene of SWEEP_SCENES) {
      const { points, outcomes, baseline } = sweepScene(scene);
      expect([scene.name, baseline]).toEqual([scene.name, { prior_run_end_unconfirmed: scene.expected }]);
      expect(points).toBeGreaterThan(10);
      for (const outcome of outcomes) {
        expect([scene.name, outcome.at, outcome.mode, outcome.point, outcome.facts.prior_run_end_unconfirmed === false]).toEqual([scene.name, outcome.at, outcome.mode, outcome.point, false]);
        // 다섯 사실을 확인으로 넣은 고르기(결정 뒤를 가정)에서도 모름·true는 배정 입력을 만들지 않는다.
        const facts = { ...Object.fromEntries(SOURCELESS.map((fact) => [fact, false])), ...outcome.facts };
        const picked = pickAssignment({
          request: { ref: "11111111-1111-4111-8111-111111111111", role: "diagnosis", inputDigest: "a".repeat(64), input: { cancelled: false, expiresAt: now + 3_600_000 } },
          connections: [],
          assignment: { allowed: [], registrations: [], expected: { profile_revision: "", policy_revision: "policy-1" } },
          accounts: [],
          credential: null,
          plans: testAssignPolicy().plans,
          facts,
          intakeOpen: true,
          now,
        });
        expect([scene.name, outcome.at, outcome.mode, picked.kind === "held" || picked.kind === "refused", picked.kind === "held" && picked.reason === "no_executor"]).toEqual([
          scene.name,
          outcome.at,
          outcome.mode,
          true,
          false,
        ]);
      }
    }
  });
});

// 실제 조립(boot.ts)과 실제 장부, 시험 현관 대역. 배정 박자의 결과와 넘긴 포트를 적는다.
const JOB: TestJobRequest = {
  owner: TEST_FRONT_DOOR_OWNER,
  key: "t1-1",
  role: TEST_ASSIGN_ROLE,
  purpose: "t1_fixed_program",
  sourceRef: `test-front-door/${TEST_FRONT_DOOR_OWNER}`,
  inputDigest: digest("t1"),
};

async function bootT1(assign: Pick<SupervisorSettings, "testAssign"> & Pick<AssignLoopPolicy, "plans" | "queue">): Promise<{
  w: World;
  running: RunningSupervisor;
  ticks: TickResult[];
  ports: () => AssignLoopPorts;
  ledgerCalls: string[];
}> {
  const ticks: TickResult[] = [];
  let seenPorts: AssignLoopPorts | null = null;
  const ledgerCalls: string[] = [];
  const w = world({
    settings: { testJobs: true, testAssign: assign.testAssign },
    deps: { frontDoor: frontDoorFor("test_double") },
    makers: {
      ticks: {
        linkLoss: linkLossTick,
        resultCheck: resultCheckTick,
        life: lifeTick,
        resend: resendTick,
        unreceived: unreceivedTick,
        assign: async (ports, policy, now) => {
          seenPorts = ports;
          const result = await assignAndStartTick(ports, policy, now);
          ticks.push(result);
          return result;
        },
      },
    },
  });
  const open = w.deps.openLedger;
  w.deps = {
    ...w.deps,
    openLedger: (path, options) => {
      const result = open(path, options);
      if (!result.ok) return result;
      const ledger = new Proxy(result.ledger, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            ledgerCalls.push(String(key));
            return Reflect.apply(value, target, args);
          };
        },
      }) as Ledger;
      return { ...result, ledger };
    },
  };
  w.settings = { ...w.settings, assign: { ...w.settings.assign, plans: assign.plans, queue: assign.queue, originOf: testOriginOf } };
  const result = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  return { w, running: result.running, ticks, ports: () => seenPorts as unknown as AssignLoopPorts, ledgerCalls };
}

async function cycles(w: World, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
}
const jobOf = (w: World, running: RunningSupervisor) => {
  const reply = parseReply(answerLine(JSON.stringify({ command: "test-job", ...JOB }), createAdminHandlers(running.admin, running.testJob), w.deps.monoNow() + ADMIN_LIMITS.serverWaitMs).slice(0, -1));
  return { reply, code: exitFor({ kind: "reply", reply } as AskOutcome, "test-job").code };
};
const lastRequests = (ticks: readonly TickResult[]) => {
  const ran = ticks.filter((t) => t.kind === "ran" && t.requests.length > 0);
  return ran.length === 0 ? null : (ran[ran.length - 1] as Extract<TickResult, { kind: "ran" }>).requests;
};

describe("실제 조립", () => {
  test("시험 값: T1 역할의 시험 작업 하나가 고르기까지 가서, 근거 원천이 없는 다섯 사실로 evidence_missing 보류된다(앞 실행 종료는 장부에서 확인)", async () => {
    const test = testAssignPolicy();
    const { w, running, ticks } = await bootT1({ testAssign: true, plans: test.plans, queue: { alertMaxWaitMs: 60_000, requestBudget: test.requestBudget } });
    await cycles(w, 10);
    expect(jobOf(w, running)).toMatchObject({ code: 0, reply: { kind: "test_job", outcome: "created" } });
    await cycles(w, 3);
    const requests = lastRequests(ticks);
    expect(requests).toEqual([{ ref: expect.any(String), outcome: "skipped", pick: { kind: "held", reason: "evidence_missing", missing: [...SOURCELESS] } }]);
    expect(ticks.some((t) => t.kind === "not_run" && t.reason === "policy_rejected")).toBe(false);
    expect(w.names()).not.toContain("fatal");
    expect(await running.stop()).toBe(0);
  });

  test("시험 숫자만 있고 사실 공급자가 꺼지면(testAssign 거짓) 여섯 사실이 모두 모름이다", async () => {
    const test = testAssignPolicy();
    const { w, running, ticks } = await bootT1({ testAssign: false, plans: test.plans, queue: { alertMaxWaitMs: 60_000, requestBudget: test.requestBudget } });
    await cycles(w, 10);
    expect(jobOf(w, running).code).toBe(0);
    await cycles(w, 3);
    expect(lastRequests(ticks)).toEqual([{ ref: expect.any(String), outcome: "skipped", pick: { kind: "held", reason: "evidence_missing", missing: [...PRE_ASSIGN_FACTS] } }]);
    expect(await running.stop()).toBe(0);
  });

  test("운영 값(진입점의 운영 설정): 대기 부탁이 있어도 박자는 policy_rejected이고 사실 포트는 장부를 읽지 않고 모름이다. 배정·시작 쓰기 0", async () => {
    const prod = settingsOf({});
    const { w, running, ticks, ports, ledgerCalls } = await bootT1({ testAssign: prod.testAssign, plans: prod.assign.plans, queue: prod.assign.queue });
    await cycles(w, 10);
    expect(jobOf(w, running).code).toBe(0);
    await cycles(w, 3);
    const after = ticks.slice(-3);
    expect(after.length).toBe(3);
    for (const tick of after) expect(tick).toEqual({ kind: "not_run", reason: "policy_rejected" });
    const before = ledgerCalls.length;
    expect(await ports().facts.facts({} as never)).toEqual({});
    expect(ledgerCalls.length).toBe(before);
    expect(ledgerCalls.filter((call) => call === "assignToolRequest" || call === "startRun")).toEqual([]);
    expect(await running.stop()).toBe(0);
  });
});

// 진입점·조립이 시험 배정 값을 고르는 자리는 프로세스를 띄워도 재료 읽기(92)에서 멈춰 닿지 않는다. 그래서 글로 고정한다.
describe("연결 글", () => {
  test("시험 배정 모듈을 import하는 src는 진입점과 조립 둘이고, 실행 계획·요청 한도는 시험 작업 값으로만, 사실 공급자는 testAssign으로만 고른다", async () => {
    const importers: string[] = [];
    for (const path of await list("src/**/*.ts")) {
      if (path === "src/supervisor/runtime/test-assign.ts") continue;
      if (/["'][^"'\n]*\/test-assign(?:\.ts)?["']/.test(await readText(path))) importers.push(path);
    }
    expect(importers.sort()).toEqual(["src/main/supervisor.ts", "src/supervisor/runtime/boot.ts"]);
    const flat = async (path: string) =>
      (await readText(path))
        .split("\n")
        .filter((line) => !/^\s*\/\//.test(line))
        .join("\n")
        .replace(/\s+/g, " ");
    const count = (text: string, needle: string) => text.split(needle).length - 1;
    const entry = await flat("src/main/supervisor.ts");
    expect(count(entry, "testAssignPolicy(")).toBe(1);
    expect(count(entry, 'const testAssign = testJobs === "on" ? testAssignPolicy() : null;')).toBe(1);
    expect(count(entry, "plans: testAssign === null ? [] : testAssign.plans,")).toBe(1);
    expect(count(entry, "requestBudget: testAssign === null ? { admin: 0, alert: 0 } : testAssign.requestBudget")).toBe(1);
    expect(count(entry, "testAssign: testAssign !== null,")).toBe(1);
    const boot = await flat("src/supervisor/runtime/boot.ts");
    expect(count(boot, "testFactSource(")).toBe(1);
    expect(count(boot, "const facts: FactSource = settings.testAssign === true ? testFactSource(ledger) : { facts: () => ({}) };")).toBe(1);
  });
});
