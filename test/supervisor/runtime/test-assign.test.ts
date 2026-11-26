// 시험 배정 값(src/supervisor/runtime/test-assign.ts)의 시험: 시험 숫자와 T1 역할, 진입점 설정(시험 값에서만 채우고 운영 값은 닫힌 값 그대로),
// 사실 공급자(앞 실행의 종료 미확인은 장부에서, 다섯 사실은 재시도 키까지 고정 T1 부탁이고 앞 실행을 알 때만 false(D-130), 모르면 비움), 읽기 지점마다 던짐·모름과 칸 흔들기를
// 넣는 훑기, 가짜 포트로 고정 T1 부탁이 배정 쓰기까지 가는 것, 실제 조립에서 고정 부탁은 사실을 지나고 다른 시험 작업은 다섯 사실로 보류되는 것과
// 운영 값의 policy_rejected, 진입점·조립의 연결 글.
// 진입점을 실제로 띄워 기동 기록 test_assign 한 줄을 보는 것은 test/entrypoints.test.ts가 한다.
import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, getRandomValues } from "node:crypto";
import { sealEnvelope } from "../../../src/contract/v1/index.ts";
import { LEDGER_RUN_STATES, type Ledger } from "../../../src/ledger/index.ts";
import { REF, SHA256, SOURCE_REF, UUID } from "../../../src/ledger/input.ts";
import { frontDoorFor, SUPERVISOR_ENV, settingsFromEnv } from "../../../src/main/supervisor.ts";
import { type AskOutcome, exitFor } from "../../../src/supervisor/admin/client.ts";
import { answerLine, createAdminHandlers } from "../../../src/supervisor/admin/commands.ts";
import { ADMIN_LIMITS, parseReply, type TestJobRequest } from "../../../src/supervisor/admin/protocol.ts";
import { TEST_JOB_PURPOSE } from "../../../src/supervisor/admin/test-job.ts";
import { type AssignLoopLedger, type AssignLoopPolicy, type AssignLoopPorts, assignAndStartTick, type TickResult } from "../../../src/supervisor/dispatch/assign-loop.ts";
import { lifeTick } from "../../../src/supervisor/dispatch/life-loop.ts";
import { linkLossTick } from "../../../src/supervisor/dispatch/link-loss.ts";
import { pickAssignment, PRE_ASSIGN_FACTS, type PreAssignFact, type PreAssignFacts } from "../../../src/supervisor/dispatch/pick.ts";
import { resendTick } from "../../../src/supervisor/dispatch/resend.ts";
import { resultCheckTick } from "../../../src/supervisor/dispatch/result-check.ts";
import { unreceivedTick } from "../../../src/supervisor/dispatch/unreceived.ts";
import { TEST_FRONT_DOOR_OWNER, TEST_FRONT_DOOR_SOURCE, testOriginOf } from "../../../src/supervisor/frontdoor/test-double.ts";
import { ROLE_POLICIES } from "../../../src/supervisor/roles/policy.ts";
import type { RunningSupervisor, SupervisorSettings } from "../../../src/supervisor/runtime/boot.ts";
import {
  END_UNCONFIRMED,
  FIXED_T1_FACTS,
  TEST_ASSIGN_NUMBERS,
  TEST_ASSIGN_ROLE,
  TEST_ASSIGN_SNAPSHOT_DIGEST,
  TEST_T1_REQUEST,
  type TestFactLedger,
  testAssignPolicy,
  testFactSource,
} from "../../../src/supervisor/runtime/test-assign.ts";
import { planNext } from "../../../src/supervisor/scheduler/queue.ts";
import { list, readText } from "../../files.ts";
import { digest, id, must, NOW, open, ready, tempPath } from "../../ledger/helpers.ts";
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

// 고정 T1 부탁(D-130). 다섯 사실은 대기 항목과 장부의 부탁 줄이 모두 이 부탁일 때만 false다.
const T1 = TEST_T1_REQUEST;
const T1_REF = "22222222-2222-4222-8222-222222222222";
const T1_ENTRY = { ref: T1_REF, owner: T1.owner, role: T1.role, inputDigest: T1.inputDigest, input: { cancelled: false, expiresAt: 1_800_003_600_000 } };
const T1_ROW = { ref: T1_REF, owner: T1.owner, dedupeKey: T1.dedupeKey, role: T1.role, purpose: T1.purpose, sourceRef: T1.sourceRef, inputDigest: T1.inputDigest, phase: "waiting_assignment" };
const OTHER_UUID = "00000000-0000-4000-8000-000000000110";
const OTHER_REF = "33333333-3333-4333-8333-333333333333";
type T1Fields = Record<"owner" | "dedupeKey" | "role" | "purpose" | "sourceRef" | "inputDigest", string>;
// 칸마다 고정 값과 다른 값 하나. 모두 장부가 받는 꼴이라 장부를 지나도 다른 부탁이 된다.
const T1_OTHER: T1Fields = {
  owner: OTHER_UUID,
  dedupeKey: "t1-1",
  role: "isolated_reader",
  purpose: "t1_fixed_program_b",
  sourceRef: `${TEST_FRONT_DOOR_SOURCE}/${OTHER_UUID}`,
  inputDigest: digest("t1"),
};
const ENTRY_FIELDS = ["ref", "owner", "role", "inputDigest"] as const;
const ROW_FIELDS = ["ref", "owner", "dedupeKey", "role", "purpose", "sourceRef", "inputDigest"] as const;
const otherOf = (field: (typeof ROW_FIELDS)[number]) => (field === "ref" ? OTHER_REF : T1_OTHER[field]);
const CLEAR_FIVE: PreAssignFacts = Object.fromEntries(SOURCELESS.map((fact) => [fact, false]));

type ReadTool = TestFactLedger["readToolRequest"];
const t1Facts = (entry: unknown, read: unknown, runs: unknown = known([]), holds: unknown = known([])) =>
  testFactSource({ listRuns: typeof runs === "function" ? runs : () => runs, slotHolds: typeof holds === "function" ? holds : () => holds, readToolRequest: read } as unknown as TestFactLedger).facts(
    entry as never,
  ) as PreAssignFacts;
const rowRead = (row: unknown) => (() => known(row)) as unknown as ReadTool;
// 다섯 사실 가운데 칸이 있는 것(값과 무관하게). 고정 부탁이 아니면 비어야 한다.
const filled = (facts: PreAssignFacts) => FIXED_T1_FACTS.filter((fact) => Object.hasOwn(facts, fact));

describe("고정 T1 부탁(D-130)", () => {
  test("상수는 시험 현관 대역의 소유자 입력에 묶인 진단 부탁이고, 칸마다 장부·관리 명령이 받는 꼴이다", () => {
    expect(TEST_T1_REQUEST).toEqual({
      owner: TEST_FRONT_DOOR_OWNER,
      dedupeKey: "t1-fixed-program",
      role: "diagnosis",
      purpose: "t1_fixed_program",
      sourceRef: `${TEST_FRONT_DOOR_SOURCE}/${TEST_FRONT_DOOR_OWNER}`,
      inputDigest: createHash("sha256").update("olive-test-assign/t1-input").digest("hex"),
    });
    expect([Object.isFrozen(TEST_T1_REQUEST), Object.isFrozen(FIXED_T1_FACTS)]).toEqual([true, true]);
    expect([UUID.test(T1.owner), TEST_JOB_PURPOSE.test(T1.purpose), SOURCE_REF.test(T1.sourceRef), SHA256.test(T1.inputDigest)]).toEqual([true, true, true, true]);
    // homelab olive test-job은 값마다 장부 참조의 글자 집합(1~200자)만 거른다. 여섯 값 모두 그 안이다.
    expect(Object.values(TEST_T1_REQUEST).filter((value) => !REF.test(value))).toEqual([]);
    expect([...FIXED_T1_FACTS]).toEqual([...SOURCELESS]);
  });

  test("대기 항목과 부탁 줄이 모두 고정 부탁이면 다섯 사실이 false이고, 앞 실행의 종료는 장부에서 따로 채운다", () => {
    expect(t1Facts(T1_ENTRY, rowRead(T1_ROW))).toEqual({ ...CLEAR_FIVE, prior_run_end_unconfirmed: false });
    expect(t1Facts(T1_ENTRY, rowRead(T1_ROW), known([run("worker", "running")]))).toEqual({ ...CLEAR_FIVE, prior_run_end_unconfirmed: true });
    const queries: unknown[] = [];
    t1Facts(T1_ENTRY, (query: unknown) => {
      queries.push(query);
      return known(T1_ROW);
    });
    expect(queries).toEqual([{ owner: T1.owner, ref: T1_REF }]);
  });

  // D-130은 읽기 실패에서 다섯을 채우지 않는다. 앞 실행을 모르면 고정 부탁이어도 여섯이 모두 비고 부탁 줄은 읽지 않는다.
  // 부탁 읽기만 실패하면 앞 실행 칸은 장부대로 남고 다섯만 빈다(아래 "부탁 읽기가 던짐·모름·없음…").
  test("앞 실행을 모르면(실행 읽기 실패·점유 읽기 실패 각각) 고정 부탁이어도 다섯 사실도 비운다. 부탁 줄은 읽지 않는다", () => {
    const throws = () => {
      throw new Error("x");
    };
    const cases: [string, unknown, unknown][] = [
      ["실행 모름", { known: false }, known([])],
      ["실행 던짐", throws, known([])],
      ["실행 꼴 틀림", known([run("worker", "done")]), known([])],
      ["점유 모름", known([]), { known: false }],
      ["점유 던짐", known([]), throws],
      ["점유 꼴 틀림", known([]), known([hold("worker", "false")])],
    ];
    for (const [name, runs, holds] of cases) {
      let reads = 0;
      const facts = t1Facts(
        T1_ENTRY,
        () => {
          reads += 1;
          return known(T1_ROW);
        },
        runs,
        holds,
      );
      expect([name, facts, reads]).toEqual([name, {}, 0]);
    }
    // 대조군: 같은 고정 부탁에서 실행·점유를 끝까지 읽으면 다섯이 채워진다.
    expect(t1Facts(T1_ENTRY, rowRead(T1_ROW), known([]), known([hold("worker", false)]))).toEqual({ ...CLEAR_FIVE, prior_run_end_unconfirmed: false });
  });

  test("칸 하나라도 다르면 다섯 사실을 비운다: 대기 항목의 참조·소유자·역할·digest, 부탁 줄의 참조·소유자·재시도 키·역할·목적·원본 참조·digest 각각", () => {
    for (const field of ENTRY_FIELDS) {
      expect([`entry.${field}`, t1Facts({ ...T1_ENTRY, [field]: otherOf(field) }, rowRead(T1_ROW))]).toEqual([`entry.${field}`, { prior_run_end_unconfirmed: false }]);
    }
    for (const field of ROW_FIELDS) {
      expect([`row.${field}`, t1Facts(T1_ENTRY, rowRead({ ...T1_ROW, [field]: otherOf(field) }))]).toEqual([`row.${field}`, { prior_run_end_unconfirmed: false }]);
    }
    // 대기 항목의 참조가 문자열이 아니면 장부가 같은 값을 돌려줘도 아니다.
    expect(t1Facts({ ...T1_ENTRY, ref: 42 }, rowRead({ ...T1_ROW, ref: 42 }))).toEqual({ prior_run_end_unconfirmed: false });
  });

  test("부탁 읽기가 던짐·모름·없음이거나 답의 꼴이 틀리면 다섯 사실을 비운다. 대기 항목이 다르면 장부를 읽지 않는다", () => {
    const cases: [string, unknown][] = [
      [
        "던짐",
        () => {
          throw new Error("x");
        },
      ],
      ["모름", () => ({ known: false, reason: "io" })],
      ["known 문자열", () => ({ known: "true", value: T1_ROW })],
      ["줄 없음", () => known(null)],
      ["줄 문자열", () => known("row")],
      ["답 없음", () => undefined],
      ["포트 없음", undefined],
    ];
    for (const [name, read] of cases) expect([name, t1Facts(T1_ENTRY, read)]).toEqual([name, { prior_run_end_unconfirmed: false }]);
    for (const entry of [{}, null, "x", { ...T1_ENTRY, role: "code_author" }]) {
      let reads = 0;
      const facts = t1Facts(entry, () => {
        reads += 1;
        return known(T1_ROW);
      });
      expect([facts, reads]).toEqual([{ prior_run_end_unconfirmed: false }, 0]);
    }
  });
});

describe("하네스 훑기: 고정 부탁 판정", () => {
  test("실행·점유·대기 항목·부탁 읽기의 지점마다 던짐·모름을 넣고 칸마다 값을 흔들어도, 고정 부탁이 아니거나 앞 실행을 모르는 답에 다섯 사실이 채워진 것 0", () => {
    // 실행·점유 읽기도 같은 포트에 둬서 앞 실행 읽기의 지점도 훑는다(그 모름에서도 다섯이 채워지면 위반).
    const fresh = (fault: Fault, seen: string[]) => {
      const port = faulty(
        { listRuns: () => known([]), slotHolds: () => known([]), readToolRequest: (_query: unknown) => known(structuredClone(T1_ROW)) },
        fault,
        seen,
      );
      const entry = faulty(structuredClone(T1_ENTRY), fault, seen);
      return testFactSource(port as unknown as TestFactLedger).facts(entry as never) as PreAssignFacts;
    };
    const seen: string[] = [];
    expect(fresh(null, seen)).toEqual({ ...CLEAR_FIVE, prior_run_end_unconfirmed: false });
    const violations: string[] = [];
    let cases = 0;
    const check = (name: string, facts: PreAssignFacts) => {
      cases += 1;
      if (filled(facts).length > 0) violations.push(name);
    };
    for (let at = 0; at < seen.length; at += 1) {
      for (const mode of ["throw", "unknown"] as const) check(`${mode}@${at}:${seen[at]}`, fresh({ at, mode }, []));
    }
    // 고정 값 옆의 값: 없음·다른 타입, 앞뒤 공백, 대문자, 한 글자 덜·더, 문자열 객체, 배열·객체로 감싼 값, 다른 칸의 정상 값.
    const wobble = (value: unknown): unknown[] => {
      const s = String(value);
      return [undefined, null, 0, true, "", ` ${s}`, `${s} `, s.toUpperCase(), s.slice(0, -1), `${s}0`, `x${s}`, new String(s), [s], { value: s }, OTHER_REF, ...Object.values(T1_OTHER), ...Object.values(T1)].filter((v) => v !== value);
    };
    for (const field of ENTRY_FIELDS) for (const value of wobble(T1_ENTRY[field])) check(`entry.${field}=${String(value)}`, t1Facts({ ...T1_ENTRY, [field]: value }, rowRead(T1_ROW)));
    for (const field of ROW_FIELDS) for (const value of wobble(T1_ROW[field])) check(`row.${field}=${String(value)}`, t1Facts(T1_ENTRY, rowRead({ ...T1_ROW, [field]: value })));
    for (const answer of [{ known: "true", value: T1_ROW }, { known: 1, value: T1_ROW }, { value: T1_ROW }, { known: true }, { known: true, value: [T1_ROW] }, { known: true, value: JSON.stringify(T1_ROW) }, null, [], "x"]) {
      check(`answer=${JSON.stringify(answer)}`, t1Facts(T1_ENTRY, () => answer));
    }
    expect(seen.length).toBeGreaterThan(10);
    expect(cases).toBeGreaterThan(200);
    expect(violations).toEqual([]);  });
});

// 가짜 포트(실제 장부에 실행기 연결·자격·서명·내보내기는 시험이 지은 값)로 배정 박자 한 번을 돌리고 장부 쓰기 호출을 센다.
const T1_KEYS = generateKeyPairSync("ed25519");
const T1_POLICY: AssignLoopPolicy = {
  assignment: {
    allowed: [{ target: "diagnosis", roles: ["diagnosis"] }],
    registrations: [{ target: "diagnosis", role: "diagnosis", instance: "d1", storage: "s1", keyId: "key-d", active: true }],
    expected: { profile_revision: "prof-1", policy_revision: "pol-1" },
  },
  accounts: [{ account: "acct-a", method: "subscription" }],
  plans: testAssignPolicy().plans,
  queue: { alertMaxWaitMs: 60_000, requestBudget: testAssignPolicy().requestBudget },
  originOf: testOriginOf,
};

async function t1Tick(
  fields: T1Fields,
  over: { policy?: AssignLoopPolicy; prodFacts?: boolean; read?: unknown; runs?: () => unknown; holds?: () => unknown } = {},
): Promise<{ tick: TickResult; writes: string[] }> {
  const ledger = ready(open(tempPath()));
  for (const owner of new Set([TEST_FRONT_DOOR_OWNER, fields.owner])) {
    must(ledger.enqueueInput({ requestId: owner, source: TEST_FRONT_DOOR_SOURCE, sourceRef: { ref: `${TEST_FRONT_DOOR_SOURCE}/${owner}`, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
  }
  must(ledger.recordToolRequest({ ref: id(), ...fields, sessionId: "admin-test-job", callId: id(), now: NOW }));
  const writes: string[] = [];
  const port = (name: keyof AssignLoopLedger) =>
    ((...args: unknown[]) => {
      if (name === "assignToolRequest" || name === "startRun") writes.push(name);
      return (ledger[name] as (...a: unknown[]) => unknown).apply(ledger, args);
    }) as never;
  const factLedger = { listRuns: over.runs ?? (() => ledger.listRuns()), slotHolds: over.holds ?? (() => ledger.slotHolds()), readToolRequest: over.read ?? ((query: never) => ledger.readToolRequest(query)) } as unknown as TestFactLedger;
  const random = { bytes: (length: number) => getRandomValues(new Uint8Array(length)) };
  const ports: AssignLoopPorts = {
    ledger: {
      listWaitingToolRequests: port("listWaitingToolRequests"),
      assignToolRequest: port("assignToolRequest"),
      queueView: port("queueView"),
      listRuns: port("listRuns"),
      slotHolds: port("slotHolds"),
      listInputs: port("listInputs"),
      startRun: port("startRun"),
      markStartDispatch: port("markStartDispatch"),
    },
    intake: { intakeOpen: () => ledger.intakeOpen(), stopGeneration: () => 0 },
    connections: {
      candidates: () => ({
        known: true,
        value: [{ connection: 1, target: "diagnosis", principal: { kind: "worker_executor", role: "diagnosis", instance: "d1", storage: "s1" }, keyId: "key-d", hello: { profile_revision: "prof-1", policy_revision: "pol-1" } }],
      }),
    },
    withheld: { executors: () => ({ known: true, value: [] }) },
    facts: over.prodFacts === true ? { facts: () => ({}) } : testFactSource(factLedger),
    credentials: { reference: async () => ({ known: true, credential: { account: "acct-a", method: "subscription", revision: "cred-1", digest: "c".repeat(64) } }) },
    random,
    signer: { seal: (input) => sealEnvelope(input, T1_KEYS.privateKey) },
    sink: { send: async () => "sent" },
  };
  return { tick: await assignAndStartTick(ports, over.policy ?? T1_POLICY, NOW), writes };
}

const heldFive = { kind: "held", reason: "evidence_missing", missing: [...SOURCELESS] };
const requestsOf = (tick: TickResult) => (tick.kind === "ran" ? tick.requests : tick);

describe("가짜 포트로 배정 박자", () => {
  test("고정 T1 부탁은 사실 여섯을 지나 배정 쓰기 하나로 이어진다", async () => {
    const { tick, writes } = await t1Tick({ ...T1 });
    expect(requestsOf(tick)).toEqual([{ ref: expect.any(String), outcome: "assigned", runId: expect.any(String), executorId: "executor/diagnosis/d1/s1" }]);
    expect(writes).toEqual(["assignToolRequest"]);
  });

  test("칸 하나씩 다른 부탁(재시도 키·역할·목적·원본 참조·digest·소유자)은 다섯 사실로 보류되고 배정 쓰기 0", async () => {
    for (const field of ["dedupeKey", "role", "purpose", "sourceRef", "inputDigest", "owner"] as const) {
      const { tick, writes } = await t1Tick({ ...T1, [field]: T1_OTHER[field] });
      expect<unknown>([field, requestsOf(tick), writes]).toEqual([field, [{ ref: expect.any(String), outcome: "skipped", pick: heldFive }], []]);
    }
  });

  test("부탁 읽기가 던짐·모름·없음이면 고정 부탁도 다섯 사실로 보류되고 배정 쓰기 0", async () => {
    const reads: [string, unknown][] = [
      [
        "던짐",
        () => {
          throw new Error("x");
        },
      ],
      ["모름", () => ({ known: false, reason: "io" })],
      ["없음", () => known(null)],
    ];
    for (const [name, read] of reads) {
      const { tick, writes } = await t1Tick({ ...T1 }, { read });
      expect<unknown>([name, requestsOf(tick), writes]).toEqual([name, [{ ref: expect.any(String), outcome: "skipped", pick: heldFive }], []]);
    }
  });

  test("실행·점유 읽기가 모름이면 고정 부탁도 여섯 사실로 보류되고 배정 쓰기 0", async () => {
    const unknown = () => ({ known: false, reason: "io" });
    for (const [name, over] of [
      ["실행 모름", { runs: unknown }],
      ["점유 모름", { holds: unknown }],
    ] as const) {
      const { tick, writes } = await t1Tick({ ...T1 }, over);
      expect<unknown>([name, requestsOf(tick), writes]).toEqual([name, [{ ref: expect.any(String), outcome: "skipped", pick: { kind: "held", reason: "evidence_missing", missing: [...PRE_ASSIGN_FACTS] } }], []]);
    }
  });

  test("운영 값: 진입점의 운영 설정이면 고정 부탁도 policy_rejected이고, 운영 사실 포트(모두 모름)면 여섯 사실로 보류된다. 배정 쓰기 0", async () => {
    const prod = settingsOf({});
    const rejected = await t1Tick({ ...T1 }, { policy: { ...T1_POLICY, plans: prod.assign.plans, queue: prod.assign.queue }, prodFacts: true });
    expect([rejected.tick, rejected.writes]).toEqual([{ kind: "not_run", reason: "policy_rejected" }, []]);
    const held = await t1Tick({ ...T1 }, { prodFacts: true });
    expect([requestsOf(held.tick), held.writes]).toEqual([[{ ref: expect.any(String), outcome: "skipped", pick: { kind: "held", reason: "evidence_missing", missing: [...PRE_ASSIGN_FACTS] } }], []]);
  });
});

// 실제 조립(boot.ts)과 실제 장부, 시험 현관 대역. 배정 박자의 결과와 넘긴 포트를 적는다.
// 고정 T1 부탁의 시험 작업(README "시험 배정 값"의 명령과 같은 값)과 digest만 다른 시험 작업, 재시도 키만 다른 시험 작업.
const JOB: TestJobRequest = {
  owner: TEST_T1_REQUEST.owner,
  key: TEST_T1_REQUEST.dedupeKey,
  role: TEST_T1_REQUEST.role,
  purpose: TEST_T1_REQUEST.purpose,
  sourceRef: TEST_T1_REQUEST.sourceRef,
  inputDigest: TEST_T1_REQUEST.inputDigest,
};
const OTHER_JOB: TestJobRequest = { ...JOB, key: "t1-other", inputDigest: T1_OTHER.inputDigest };
const OTHER_KEY_JOB: TestJobRequest = { ...JOB, key: T1_OTHER.dedupeKey };

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
const jobOf = (w: World, running: RunningSupervisor, job: TestJobRequest = JOB) => {
  const reply = parseReply(answerLine(JSON.stringify({ command: "test-job", ...job }), createAdminHandlers(running.admin, running.testJob), w.deps.monoNow() + ADMIN_LIMITS.serverWaitMs).slice(0, -1));
  return { reply, code: exitFor({ kind: "reply", reply } as AskOutcome, "test-job").code };
};
const lastRequests = (ticks: readonly TickResult[]) => {
  const ran = ticks.filter((t) => t.kind === "ran" && t.requests.length > 0);
  return ran.length === 0 ? null : (ran[ran.length - 1] as Extract<TickResult, { kind: "ran" }>).requests;
};

describe("실제 조립", () => {
  test("시험 값: 고정 T1 부탁의 시험 작업은 관리 명령으로 넣어져 배정 전 사실 여섯을 지나 실행기 고르기에 닿는다(이 조립에는 연결이 없어 no_executor)", async () => {
    const test = testAssignPolicy();
    const { w, running, ticks } = await bootT1({ testAssign: true, plans: test.plans, queue: { alertMaxWaitMs: 60_000, requestBudget: test.requestBudget } });
    await cycles(w, 10);
    expect(jobOf(w, running)).toMatchObject({ code: 0, reply: { kind: "test_job", outcome: "created" } });
    await cycles(w, 3);
    expect(lastRequests(ticks)).toEqual([{ ref: expect.any(String), outcome: "skipped", pick: { kind: "held", reason: "no_executor", holds: [] } }]);
    expect(w.names()).not.toContain("fatal");
    expect(await running.stop()).toBe(0);
  });

  test("시험 값: 고정 T1 부탁과 digest만 또는 재시도 키만 다른 시험 작업은 고르기까지 가서, 다섯 사실로 evidence_missing 보류된다(앞 실행 종료는 장부에서 확인)", async () => {
    for (const [name, job] of [
      ["digest", OTHER_JOB],
      ["key", OTHER_KEY_JOB],
    ] as const) {
      const test = testAssignPolicy();
      const { w, running, ticks, ledgerCalls } = await bootT1({ testAssign: true, plans: test.plans, queue: { alertMaxWaitMs: 60_000, requestBudget: test.requestBudget } });
      await cycles(w, 10);
      expect(jobOf(w, running, job)).toMatchObject({ code: 0, reply: { kind: "test_job", outcome: "created" } });
      await cycles(w, 3);
      const requests = lastRequests(ticks);
      expect([name, requests]).toEqual([name, [{ ref: expect.any(String), outcome: "skipped", pick: { kind: "held", reason: "evidence_missing", missing: [...SOURCELESS] } }]]);
      expect(ticks.some((t) => t.kind === "not_run" && t.reason === "policy_rejected")).toBe(false);
      expect([name, ledgerCalls.filter((call) => call === "assignToolRequest" || call === "startRun")]).toEqual([name, []]);
      expect(w.names()).not.toContain("fatal");
      expect(await running.stop()).toBe(0);
    }
  });

  test("시험 숫자만 있고 사실 공급자가 꺼지면(testAssign 거짓) 고정 T1 부탁도 여섯 사실이 모두 모름이다", async () => {
    const test = testAssignPolicy();
    const { w, running, ticks } = await bootT1({ testAssign: false, plans: test.plans, queue: { alertMaxWaitMs: 60_000, requestBudget: test.requestBudget } });
    await cycles(w, 10);
    expect(jobOf(w, running).code).toBe(0);
    await cycles(w, 3);
    expect(lastRequests(ticks)).toEqual([{ ref: expect.any(String), outcome: "skipped", pick: { kind: "held", reason: "evidence_missing", missing: [...PRE_ASSIGN_FACTS] } }]);
    expect(await running.stop()).toBe(0);
  });

  test("운영 값(진입점의 운영 설정): 고정 T1 부탁이 대기해도 박자는 policy_rejected이고 사실 포트는 장부를 읽지 않고 모름이다. 배정·시작 쓰기 0", async () => {
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
