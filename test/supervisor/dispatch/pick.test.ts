import { describe, expect, test } from "bun:test";
import type { AssignToolRequestInput } from "../../../src/ledger/index.ts";
import { type AssignmentInput, type PickInput, pickAssignment, PRE_ASSIGN_FACTS, type PreAssignFacts } from "../../../src/supervisor/dispatch/pick.ts";
import type { AssignmentContext, HoldReason, Registration } from "../../../src/supervisor/roles/assign.ts";
import type { Candidate } from "../../../src/supervisor/transport/connections.ts";
import { id, NOW as LEDGER_NOW, must, open, ready, tempPath } from "../../ledger/helpers.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const DIGEST = "a".repeat(64);
const SNAPSHOT = "b".repeat(64);
const CRED_DIGEST = "c".repeat(64);
const REF = "11111111-1111-4111-8111-111111111111";
const NOW = 1_000_000;

// 대상 허용 표·등록행·정책 숫자는 운영 자료가 아니라 이 시험이 지어 넣는 자료다.
function conn(connection: number, instance: string, over: Partial<Candidate> = {}): Candidate {
  return {
    connection,
    target: "reader",
    principal: { kind: "worker_executor", role: "isolated_reader", instance, storage: "s1" },
    keyId: `key-${instance}`,
    hello: { profile_revision: "prof-1", policy_revision: "pol-1" },
    ...over,
  };
}

function reg(instance: string, over: Partial<Registration> = {}): Registration {
  return { target: "reader", role: "isolated_reader", instance, storage: "s1", keyId: `key-${instance}`, active: true, ...over };
}

function assignment(over: Partial<AssignmentContext> = {}): AssignmentContext {
  return {
    allowed: [{ target: "reader", roles: ["isolated_reader"] }],
    registrations: [reg("r1"), reg("r2"), reg("r3")],
    expected: { profile_revision: "prof-1", policy_revision: "pol-1" },
    ...over,
  };
}

const CLEAR: PreAssignFacts = Object.fromEntries(PRE_ASSIGN_FACTS.map((fact) => [fact, false]));

function base(over: Partial<PickInput> = {}): PickInput {
  return {
    request: { ref: REF, role: "isolated_reader", inputDigest: DIGEST, input: { cancelled: false, expiresAt: NOW + 3_600_000 } },
    connections: [conn(1, "r1")],
    assignment: assignment(),
    accounts: [{ account: "acct-a", method: "api_key" }],
    credential: { account: "acct-a", method: "api_key", revision: "cred-1", digest: CRED_DIGEST },
    plans: [{ role: "isolated_reader", snapshotDigest: SNAPSHOT, budgetLeft: 5000, runDurationMs: 600_000 }],
    facts: CLEAR,
    intakeOpen: true,
    now: NOW,
    ...over,
  };
}

describe("pickAssignment: 고른 결과", () => {
  test("모든 입력이 맞으면 장부 배정 입력을 실행 ID 없이 만든다", () => {
    const picked = pickAssignment(base());
    expect(picked).toEqual({
      kind: "assign",
      connection: 1,
      candidate: expect.objectContaining({ kind: "candidate", role: "isolated_reader", instance: "r1" }),
      input: {
        ref: REF,
        snapshotDigest: SNAPSHOT,
        profileRevision: "prof-1",
        policyRevision: "pol-1",
        executorId: "executor/isolated_reader/r1/s1",
        credential: { account: "acct-a", method: "api_key", revision: "cred-1", digest: CRED_DIGEST },
        deadlineAt: NOW + 600_000,
        budgetLeft: 5000,
        now: NOW,
      },
    });
    // 장부 입력과 칸이 runId 하나만 다르다.
    const sameShape: Equal<keyof AssignmentInput | "runId", keyof AssignToolRequestInput> = true;
    expect(sameShape).toBe(true);
  });

  test("기한은 입력의 만료보다 늦지 않다", () => {
    const picked = pickAssignment(base({ request: { ...base().request, input: { cancelled: false, expiresAt: NOW + 10 } } }));
    expect(picked.kind === "assign" && picked.input.deadlineAt).toBe(NOW + 10);
  });

  test("장부가 받지 않는 시각이면 배정 입력을 만들지 않는다", () => {
    const at = (now: number, expiresAt: number, runDurationMs = 5) =>
      pickAssignment(
        base({
          now,
          request: { ...base().request, input: { cancelled: false, expiresAt } },
          plans: [{ role: "isolated_reader", snapshotDigest: SNAPSHOT, budgetLeft: 7, runDurationMs }],
        }),
      );
    const malformedNow = { kind: "input_rejected", reason: "malformed_now" } as const;
    const malformedRequest = { kind: "input_rejected", reason: "malformed_request" } as const;
    // 소수 시각은 유한하지만 장부의 시각(양의 안전 정수)이 아니다.
    expect(at(1000.25, 1010)).toEqual(malformedNow);
    expect(at(0, 1010)).toEqual(malformedNow);
    expect(at(-1, 1010)).toEqual(malformedNow);
    expect(at(2 ** 53, 2 ** 53 + 2, 1)).toEqual(malformedNow);
    expect(at(1000, 1000.5)).toEqual(malformedRequest);
    expect(at(1000, 2 ** 53 + 2)).toEqual(malformedRequest);
    // 합이 안전 범위를 넘어도 안전한 만료로 잘리면 고른다. 기한은 지금보다 뒤다.
    const max = Number.MAX_SAFE_INTEGER;
    const clipped = at(max - 10, max, max);
    expect(clipped.kind === "assign" && clipped.input.deadlineAt).toBe(max);
  });

  test("고른 입력은 실제 장부의 배정 검사를 지나 실행 줄이 된다", () => {
    const ledger = ready(open(tempPath()));
    const owner = id();
    const source = `inbox/${id()}`;
    const expiresAt = LEDGER_NOW + 10;
    must(ledger.enqueueInput({ requestId: owner, source: "admin-dm", sourceRef: { ref: source, expiresAt }, receivedAt: LEDGER_NOW }));
    const waiting = must(
      ledger.recordToolRequest({
        ref: id(),
        owner,
        dedupeKey: `start_worker:${owner}:read`,
        role: "isolated_reader",
        purpose: "read",
        sourceRef: source,
        inputDigest: DIGEST,
        sessionId: "session-1",
        callId: id(),
        now: LEDGER_NOW,
      }),
    ).request;
    // 기한은 정책 길이보다 짧은 입력 만료로 잘린 계산 값이다.
    const picked = pickAssignment(base({ now: LEDGER_NOW, request: { ref: waiting.ref, role: waiting.role, inputDigest: waiting.inputDigest, input: { cancelled: false, expiresAt } } }));
    if (picked.kind !== "assign") throw new Error(`배정 입력이 아님: ${JSON.stringify(picked)}`);
    expect(picked.input.deadlineAt).toBe(expiresAt);
    const assigned = must(ledger.assignToolRequest({ ...picked.input, runId: id() }));
    expect(assigned.outcome).toBe("assigned");
    expect(assigned.run).toEqual(expect.objectContaining({ executorId: picked.input.executorId, deadlineAt: expiresAt, budgetLeft: picked.input.budgetLeft }));
  });
});

describe("보장 1: 맞는 실행기가 없으면 부르지 않는다", () => {
  test("후보가 없으면 no_executor 보류다", () => {
    expect(pickAssignment(base({ connections: [] }))).toEqual({ kind: "held", reason: "no_executor", holds: [] });
  });

  test("다른 역할의 실행기만 있으면 대신 고르지 않는다", () => {
    const writer = conn(4, "w1", { target: "writer", principal: { kind: "worker_executor", role: "code_author", instance: "w1", storage: "s1" } });
    const picked = pickAssignment(
      base({
        connections: [writer],
        assignment: assignment({ allowed: [{ target: "reader", roles: ["isolated_reader"] }, { target: "writer", roles: ["code_author"] }], registrations: [reg("r1"), reg("w1", { target: "writer", role: "code_author" })] }),
      }),
    );
    expect(picked).toEqual({ kind: "held", reason: "no_executor", holds: [{ connection: 4, reason: "principal_role_mismatch" }] });
  });

  test("계정이 없으면 no_account 보류다", () => {
    expect(pickAssignment(base({ accounts: [] }))).toEqual({ kind: "held", reason: "no_account", account: "no_account_injected" });
    // 격리 읽기는 api_key만 받는다(policy.ts). 다른 방식의 계정으로 대신하지 않는다.
    expect(pickAssignment(base({ accounts: [{ account: "acct-a", method: "subscription" }] }))).toEqual({ kind: "held", reason: "no_account", account: "method_not_allowed" });
  });

  test("자격 참조가 없거나 고른 계정과 다르면 보류다", () => {
    expect(pickAssignment(base({ credential: null }))).toEqual({ kind: "held", reason: "credential_unknown" });
    const other = { account: "acct-b", method: "api_key" as const, revision: "cred-1", digest: CRED_DIGEST };
    expect(pickAssignment(base({ credential: other }))).toEqual({ kind: "held", reason: "credential_mismatch" });
    expect(pickAssignment(base({ credential: { ...other, account: "acct-a", digest: "nope" } }))).toEqual({ kind: "input_rejected", reason: "malformed_credential" });
  });

  test("그 역할의 정책 값이 없으면 숫자를 지어내지 않고 보류한다", () => {
    expect(pickAssignment(base({ plans: [] }))).toEqual({ kind: "held", reason: "plan_missing" });
    expect(pickAssignment(base({ plans: [{ role: "code_author", snapshotDigest: SNAPSHOT, budgetLeft: 1, runDurationMs: 1 }] }))).toEqual({ kind: "held", reason: "plan_missing" });
    // 행은 있어도 숫자 칸이 빠지면 행이 없을 때와 같은 보류다. 값이 있는데 틀리면 꼴 오류다.
    const { budgetLeft: _b, ...noBudget } = base().plans[0]!;
    const { runDurationMs: _d, ...noDuration } = base().plans[0]!;
    expect(pickAssignment(base({ plans: [noBudget as never] }))).toEqual({ kind: "held", reason: "plan_missing" });
    expect(pickAssignment(base({ plans: [noDuration as never] }))).toEqual({ kind: "held", reason: "plan_missing" });
    expect(pickAssignment(base({ plans: [{ role: "isolated_reader", snapshotDigest: SNAPSHOT, budgetLeft: 0, runDurationMs: 1 }] }))).toEqual({ kind: "input_rejected", reason: "malformed_plan" });
    const plan = base().plans[0];
    expect(pickAssignment(base({ plans: [plan!, plan!] }))).toEqual({ kind: "input_rejected", reason: "duplicate_plan" });
  });

  test("접수가 닫혔으면 다른 입력과 무관하게 무엇도 고르지 않는다", () => {
    expect(pickAssignment(base({ intakeOpen: false }))).toEqual({ kind: "intake_closed" });
    expect(pickAssignment(base({ intakeOpen: "yes" as unknown as boolean }))).toEqual({ kind: "intake_closed" });
    expect(pickAssignment(base({ intakeOpen: false, now: Number.NaN, request: null as never }))).toEqual({ kind: "intake_closed" });
  });
});

describe("보장 2: 고르는 순서는 입력 순서와 무관하다", () => {
  test("실행기 이름이 가장 앞선 후보를 고른다", () => {
    const list = [conn(7, "r3"), conn(2, "r2"), conn(5, "r1")];
    const orders = [list, [...list].reverse(), [list[1]!, list[2]!, list[0]!]];
    const picks = orders.map((connections) => pickAssignment(base({ connections })));
    for (const picked of picks) {
      expect(picked.kind).toBe("assign");
      expect(picked.kind === "assign" && picked.input.executorId).toBe("executor/isolated_reader/r1/s1");
      expect(picked.kind === "assign" && picked.connection).toBe(5);
    }
  });

  test("같은 실행기의 연결이 둘이면 연결 번호가 작은 쪽이다", () => {
    for (const connections of [[conn(9, "r1"), conn(3, "r1")], [conn(3, "r1"), conn(9, "r1")]]) {
      const picked = pickAssignment(base({ connections }));
      expect(picked.kind === "assign" && picked.connection).toBe(3);
    }
  });

  test("보류 목록도 연결 번호 순이다", () => {
    const bad = (n: number) => conn(n, "rx", { hello: { profile_revision: "old", policy_revision: "pol-1" } });
    const registrations = [reg("rx")];
    const a = pickAssignment(base({ connections: [bad(8), bad(2)], assignment: assignment({ registrations }) }));
    expect(a).toEqual({ kind: "held", reason: "no_executor", holds: [{ connection: 2, reason: "profile_revision_mismatch" }, { connection: 8, reason: "profile_revision_mismatch" }] });
  });
});

describe("보장 3: 배정 판단은 roles/assign.ts의 것을 그대로 쓴다", () => {
  test("judgeAssignment의 보류 이유를 연결마다 그대로 낸다", () => {
    const cases: [Candidate, AssignmentContext, HoldReason][] = [
      [conn(1, "r1", { hello: { profile_revision: "prof-1", policy_revision: "pol-old" } }), assignment(), "policy_revision_mismatch"],
      [conn(1, "r1"), assignment({ registrations: [reg("r1", { active: false })] }), "registration_inactive"],
      [conn(1, "r9"), assignment(), "not_registered"],
      [conn(1, "r1"), assignment({ expected: { profile_revision: "", policy_revision: "pol-1" } }), "expected_revision_missing"],
    ];
    for (const [c, ctx, reason] of cases) {
      expect(pickAssignment(base({ connections: [c], assignment: ctx }))).toEqual({ kind: "held", reason: "no_executor", holds: [{ connection: 1, reason }] });
    }
  });

  test("통과한 후보만 고른다: 앞선 이름이라도 보류된 연결은 건너뛴다", () => {
    const stale = conn(1, "r1", { hello: { profile_revision: "old", policy_revision: "pol-1" } });
    const picked = pickAssignment(base({ connections: [stale, conn(2, "r2")] }));
    expect(picked.kind === "assign" && picked.input.executorId).toBe("executor/isolated_reader/r2/s1");
    expect(picked.kind === "assign" && picked.input.profileRevision).toBe("prof-1");
  });

  test("주입 자료가 모순이면 judgeAssignment의 입력 거절을 그대로 낸다", () => {
    const ctx = assignment({ registrations: [reg("r1"), reg("r1", { keyId: "key-other" })] });
    expect(pickAssignment(base({ assignment: ctx }))).toEqual({ kind: "input_rejected", reason: "assignment_input", assign: "duplicate_identity" });
  });
});

describe("보장 4: 취소·만료된 입력과 설계의 배정 전 거절", () => {
  test("입력이 취소됐으면 고르지 않는다", () => {
    expect(pickAssignment(base({ request: { ...base().request, input: { cancelled: true, expiresAt: NOW + 1000 } } }))).toEqual({ kind: "refused", reason: "input_cancelled" });
  });

  test("입력의 만료 시각 정각부터 고르지 않는다", () => {
    expect(pickAssignment(base({ request: { ...base().request, input: { cancelled: false, expiresAt: NOW } } }))).toEqual({ kind: "refused", reason: "input_expired" });
    expect(pickAssignment(base({ request: { ...base().request, input: { cancelled: false, expiresAt: NOW + 1 } } })).kind).toBe("assign");
  });

  test("취소·만료는 후보가 없어도 먼저 구별된다", () => {
    expect(pickAssignment(base({ connections: [], request: { ...base().request, input: { cancelled: true, expiresAt: NOW + 1000 } } }))).toEqual({ kind: "refused", reason: "input_cancelled" });
  });

  test("거절 조건에 해당한다는 사실이 있으면 거절한다", () => {
    for (const fact of PRE_ASSIGN_FACTS) {
      expect(pickAssignment(base({ facts: { ...CLEAR, [fact]: true } }))).toEqual({ kind: "refused", reason: fact });
    }
  });

  test("앞 실행의 종료 미확인 거절은 종료가 확인되면 풀린다", () => {
    expect(pickAssignment(base({ facts: { ...CLEAR, prior_run_end_unconfirmed: true } }))).toEqual({ kind: "refused", reason: "prior_run_end_unconfirmed" });
    expect(pickAssignment(base({ facts: { ...CLEAR, prior_run_end_unconfirmed: false } })).kind).toBe("assign");
  });

  test("사실이 없으면 보류(입력 없음)이고 빠진 것을 순서대로 적는다", () => {
    expect(pickAssignment(base({ facts: {} }))).toEqual({ kind: "held", reason: "evidence_missing", missing: [...PRE_ASSIGN_FACTS] });
    const partial = { ...CLEAR, external_code: "no" as unknown as boolean };
    expect(pickAssignment(base({ facts: partial }))).toEqual({ kind: "held", reason: "evidence_missing", missing: ["external_code"] });
  });

  test("꼴이 틀린 부탁·시각은 구별된 거절이다", () => {
    expect(pickAssignment(base({ now: Number.POSITIVE_INFINITY }))).toEqual({ kind: "input_rejected", reason: "malformed_now" });
    expect(pickAssignment(base({ request: { ...base().request, inputDigest: "x" } }))).toEqual({ kind: "input_rejected", reason: "malformed_request" });
    expect(pickAssignment(base({ request: { ...base().request, role: "admin" as never } }))).toEqual({ kind: "input_rejected", reason: "malformed_request" });
    expect(pickAssignment(base({ request: { ...base().request, input: { cancelled: "no" as never, expiresAt: NOW + 1 } } }))).toEqual({ kind: "input_rejected", reason: "malformed_request" });
  });
});
