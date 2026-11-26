// 배정 박자가 자격 참조(실제 포트는 계정의 자격 파일 읽기)를 묻는 때와 그 뒤의 재검사.
// 자격 앞의 검사(부탁·사실·역할·대상·허용 표·등록행·기대 revision·계정)를 통과한 후보가 있을 때만 묻는다. 고정 계정이 있어도
// 후보가 없으면 파일 읽기 0, 장부 쓰기 0이다. 조회를 기다린 뒤에는 접수·맡기지 않을 실행기를 다시 읽고 처음부터 다시 고른다.
import { expect, test } from "bun:test";
import { type CredentialFiles, credentialPort } from "../../../src/supervisor/accounts/credential-ref.ts";
import { type AssignLoopPolicy, type AssignLoopPorts, assignAndStartTick } from "../../../src/supervisor/dispatch/assign-loop.ts";
import { PRE_ASSIGN_FACTS, type PreAssignFacts } from "../../../src/supervisor/dispatch/pick.ts";
import type { Candidate } from "../../../src/supervisor/transport/connections.ts";

// 이름·키·숫자는 이 시험이 지어 넣는 자료다. 운영값이 아니다.
const NOW = 1_800_000_000_000;
const REF = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const EXECUTOR = "executor/diagnosis/d1/s1";
const TOKEN = new TextEncoder().encode("token-bytes\n");
const CLEAR: PreAssignFacts = Object.fromEntries(PRE_ASSIGN_FACTS.map((fact) => [fact, false]));
const ROW = { target: "diagnosis", role: "diagnosis", instance: "d1", storage: "s1", keyId: "key-d1", active: true } as const;

const POLICY: AssignLoopPolicy = {
  assignment: { allowed: [{ target: "diagnosis", roles: ["diagnosis"] }], registrations: [ROW], expected: { profile_revision: "prof-1", policy_revision: "pol-1" } },
  accounts: [{ account: "acct-a", method: "subscription" }],
  plans: [{ role: "diagnosis", snapshotDigest: "b".repeat(64), budgetLeft: 10, runDurationMs: 60_000 }],
  queue: { alertMaxWaitMs: 60_000, requestBudget: { admin: 1, alert: 1 } },
  originOf: () => undefined,
};

function connection(over: Partial<Candidate> = {}): Candidate {
  return {
    connection: 1,
    target: "diagnosis",
    principal: { kind: "worker_executor", role: "diagnosis", instance: "d1", storage: "s1" },
    keyId: "key-d1",
    hello: { profile_revision: "prof-1", policy_revision: "pol-1" },
    ...over,
  };
}

interface Rig {
  readonly ports: AssignLoopPorts;
  // 자격 파일 읽기, 자격 포트 호출, 장부 쓰기(잇기·시작), 송신의 횟수.
  readonly count: { fileReads: number; references: number; assigns: number; starts: number; sends: number };
  // 자격 포트가 답을 내기 직전에 부른다(조회를 기다리는 사이의 변화).
  onReference: (() => void) | null;
  intake: boolean;
  withheld: readonly string[];
}

// 효과를 세는 가짜 포트 묶음. 자격 포트는 실제 credentialPort이고 그 파일 포트만 바꿔 읽기를 센다.
function rig(connections: readonly Candidate[], options: { revision?: string | null; facts?: PreAssignFacts } = {}): Rig {
  const count = { fileReads: 0, references: 0, assigns: 0, starts: 0, sends: 0 };
  const files: CredentialFiles = {
    read: async () => {
      count.fileReads += 1;
      return { kind: "bytes", bytes: TOKEN.slice() };
    },
  };
  const revision = options.revision === undefined ? "acct-7" : options.revision;
  const real = credentialPort(files, { dir: "/accounts", keys: { subscription: "CLAUDE_CODE_OAUTH_TOKEN" }, maxBytes: 16_384, revisionOf: () => revision });
  const empty = () => ({ known: true as const, value: [] });
  const r: Rig = {
    count,
    onReference: null,
    intake: true,
    withheld: [],
    ports: {
      ledger: {
        listWaitingToolRequests: () => ({ known: true, value: [{ ref: REF, owner: OWNER, role: "diagnosis", inputDigest: "d".repeat(64), input: { cancelled: false, expiresAt: NOW + 3_600_000 } }] }),
        queueView: () => ({ known: true, value: { runs: [] } }),
        listRuns: empty,
        slotHolds: empty,
        listInputs: empty,
        assignToolRequest: (input: { runId: string; executorId: string }) => {
          count.assigns += 1;
          return { ok: true, outcome: "assigned", run: { runId: input.runId, executorId: input.executorId } };
        },
        startRun: () => {
          count.starts += 1;
          throw new Error("시작 후보가 없는 박자다");
        },
        markStartDispatch: () => {
          throw new Error("시작 후보가 없는 박자다");
        },
      },
      intake: { intakeOpen: () => r.intake, stopGeneration: () => 1 },
      connections: { candidates: () => ({ known: true, value: connections }) },
      withheld: { executors: () => ({ known: true, value: r.withheld }) },
      facts: { facts: () => options.facts ?? CLEAR },
      credentials: {
        reference: async (choice: { account: string; method: string }) => {
          count.references += 1;
          const answer = await real.reference(choice);
          r.onReference?.();
          return answer;
        },
      },
      random: { bytes: (length: number) => new Uint8Array(length).fill(7) },
      signer: {
        seal: () => {
          throw new Error("시작 후보가 없는 박자다");
        },
      },
      sink: {
        send: async () => {
          count.sends += 1;
          return "sent";
        },
      },
    } as unknown as AssignLoopPorts,
  };
  return r;
}

async function requestOutcome(r: Rig, policy: AssignLoopPolicy) {
  const result = await assignAndStartTick(r.ports, policy, NOW);
  if (result.kind !== "ran") throw new Error(`박자가 돌지 않음: ${JSON.stringify(result)}`);
  return result;
}

test("고정 계정이 있어도 역할·프로필·등록행·계정·사실을 통과한 후보가 없으면 자격 포트를 부르지 않는다: 파일 읽기 0, 장부 쓰기 0", async () => {
  const reader = connection({ target: "reader", principal: { kind: "worker_executor", role: "isolated_reader", instance: "r1", storage: "s1" } });
  const cases: [string, readonly Candidate[], AssignLoopPolicy, PreAssignFacts, string][] = [
    ["후보 연결 없음", [], POLICY, CLEAR, "no_executor"],
    ["역할이 다른 실행기", [reader], POLICY, CLEAR, "no_executor"],
    ["허용 표에 없음", [connection()], { ...POLICY, assignment: { ...POLICY.assignment, allowed: [] } }, CLEAR, "no_executor"],
    ["등록행 없음", [connection()], { ...POLICY, assignment: { ...POLICY.assignment, registrations: [] } }, CLEAR, "no_executor"],
    ["등록행과 인스턴스 불일치", [connection({ principal: { kind: "worker_executor", role: "diagnosis", instance: "d2", storage: "s1" } })], POLICY, CLEAR, "no_executor"],
    ["기대 프로필 없음", [connection()], { ...POLICY, assignment: { ...POLICY.assignment, expected: { profile_revision: "", policy_revision: "pol-1" } } }, CLEAR, "no_executor"],
    ["프로필 불일치", [connection({ hello: { profile_revision: "prof-2", policy_revision: "pol-1" } })], POLICY, CLEAR, "no_executor"],
    ["계정 없음", [connection()], { ...POLICY, accounts: [] }, CLEAR, "no_account"],
    ["배정 전 사실 없음", [connection()], POLICY, {}, "evidence_missing"],
  ];
  for (const [name, connections, policy, facts, reason] of cases) {
    const r = rig(connections, { facts });
    const result = await requestOutcome(r, policy);
    expect([name, result.halted, result.requests]).toEqual([name, null, [{ ref: REF, outcome: "skipped", pick: expect.objectContaining({ kind: "held", reason }) }]]);
    expect([name, r.count]).toEqual([name, { fileReads: 0, references: 0, assigns: 0, starts: 0, sends: 0 }]);
  }
});

test("대조군: 후보가 있으면 자격 파일을 한 번 읽고 잇는다. 판을 모르면 포트는 불리지만 파일을 열지 않고 잇지 않는다", async () => {
  const r = rig([connection()]);
  expect((await requestOutcome(r, POLICY)).requests).toEqual([{ ref: REF, outcome: "assigned", runId: expect.any(String), executorId: EXECUTOR }]);
  expect(r.count).toEqual({ fileReads: 1, references: 1, assigns: 1, starts: 0, sends: 0 });

  const unknown = rig([connection()], { revision: null });
  expect((await requestOutcome(unknown, POLICY)).requests).toEqual([{ ref: REF, outcome: "skipped", pick: { kind: "held", reason: "credential_unknown" } }]);
  expect(unknown.count).toEqual({ fileReads: 0, references: 1, assigns: 0, starts: 0, sends: 0 });
});

test("자격 조회를 기다리는 사이 접수가 닫히거나 그 실행기를 맡기지 않게 되면 잇지 않는다(조회 뒤에 다시 읽는다)", async () => {
  const closed = rig([connection()]);
  closed.onReference = () => {
    closed.intake = false;
  };
  const halted = await requestOutcome(closed, POLICY);
  expect([halted.halted, halted.haltedAt, halted.requests]).toEqual(["intake_closed", { step: "assign", ref: REF }, []]);
  expect(closed.count).toEqual({ fileReads: 1, references: 1, assigns: 0, starts: 0, sends: 0 });

  const listed = rig([connection()]);
  listed.onReference = () => {
    listed.withheld = [EXECUTOR];
  };
  expect((await requestOutcome(listed, POLICY)).requests).toEqual([{ ref: REF, outcome: "withheld", reason: "listed", executorId: EXECUTOR }]);
  expect(listed.count).toEqual({ fileReads: 1, references: 1, assigns: 0, starts: 0, sends: 0 });
});

test("두 번의 고르기 모두 후보의 주체를 거를 때 읽지 못해도, 고른 실행기가 집합에 있으면 잇지 않는다(고른 뒤의 대조)", async () => {
  // 맡기지 않을 실행기 포트를 읽을 때마다 바로 다음 주체 읽기(거르기)만 던지게 한다. 고르기의 읽기는 정상 주체를 낸다.
  let armed = false;
  const flaky: Candidate = {
    ...connection(),
    get principal() {
      if (armed) {
        armed = false;
        throw new Error("주체 읽기 실패");
      }
      return connection().principal;
    },
  };
  const r = rig([flaky]);
  r.withheld = [EXECUTOR];
  const read = r.ports.withheld.executors;
  (r.ports as { withheld: AssignLoopPorts["withheld"] }).withheld = {
    executors: () => {
      armed = true;
      return read();
    },
  };
  expect((await requestOutcome(r, POLICY)).requests).toEqual([{ ref: REF, outcome: "withheld", reason: "listed", executorId: EXECUTOR }]);
  expect(r.count).toEqual({ fileReads: 1, references: 1, assigns: 0, starts: 0, sends: 0 });
});

test("맡기지 않을 실행기만 맞는 부탁은 자격까지 보고 listed로 가른다. 그 실행기도 맞지 않으면 묻지 않는다", async () => {
  const listed = rig([connection()]);
  listed.withheld = [EXECUTOR];
  expect((await requestOutcome(listed, POLICY)).requests).toEqual([{ ref: REF, outcome: "withheld", reason: "listed", executorId: EXECUTOR }]);
  expect(listed.count).toEqual({ fileReads: 1, references: 1, assigns: 0, starts: 0, sends: 0 });

  const mismatch = rig([connection({ hello: { profile_revision: "prof-2", policy_revision: "pol-1" } })]);
  mismatch.withheld = [EXECUTOR];
  expect((await requestOutcome(mismatch, POLICY)).requests).toEqual([{ ref: REF, outcome: "skipped", pick: expect.objectContaining({ kind: "held", reason: "no_executor" }) }]);
  expect(mismatch.count).toEqual({ fileReads: 0, references: 0, assigns: 0, starts: 0, sends: 0 });
});
