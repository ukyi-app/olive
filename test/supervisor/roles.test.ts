import { describe, expect, test } from "bun:test";
import { ROLES, type Role } from "../../src/contract/v1/index.ts";
import type { RoleProfile } from "../../src/executor/profile.ts";
import { AUTH_METHODS as LEDGER_AUTH_METHODS } from "../../src/ledger/input.ts";
import { type AccountRef, selectAccount } from "../../src/supervisor/accounts/fixed.ts";
import {
  type AssignmentContext,
  type AuthenticatedConnection,
  eligibleConnections,
  type Job,
  judgeAssignment,
  type Registration,
} from "../../src/supervisor/roles/assign.ts";
import { AUTH_METHODS, ROLE_POLICIES } from "../../src/supervisor/roles/policy.ts";

// 대상 허용 표와 등록행은 운영 자료의 사본이 아니라 이 시험이 지어 넣는 자료다.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function readerConnection(role: Role = "isolated_reader", over: Partial<AuthenticatedConnection> = {}): AuthenticatedConnection {
  return {
    target: "reader",
    principal: { kind: "worker_executor", role, instance: "r1", storage: "s1" },
    keyId: "key-r1",
    hello: { profile_revision: "prof-1", policy_revision: "pol-1" },
    ...over,
  };
}

function registration(over: Partial<Registration> = {}): Registration {
  return { target: "reader", role: "isolated_reader", instance: "r1", keyId: "key-r1", active: true, ...over };
}

function context(over: Partial<AssignmentContext> = {}): AssignmentContext {
  return {
    allowed: [{ target: "reader", roles: ["isolated_reader"] }],
    registrations: [registration()],
    expected: { profile_revision: "prof-1", policy_revision: "pol-1" },
    ...over,
  };
}

describe("역할 표", () => {
  test("역할 이름이 계약의 ROLES와 실행기 프로필의 역할과 같은 문자열이다", () => {
    expect(Object.keys(ROLE_POLICIES)).toEqual([...ROLES]);
    const sameAsProfile: Equal<RoleProfile["role"], keyof typeof ROLE_POLICIES> = true;
    const sameAsContract: Equal<Role, keyof typeof ROLE_POLICIES> = true;
    expect([sameAsProfile, sameAsContract]).toEqual([true, true]);
  });

  test("방식 이름이 장부의 AUTH_METHODS와 같다", () => {
    expect([...AUTH_METHODS]).toEqual([...LEDGER_AUTH_METHODS]);
  });

  test("표는 얼어 있어 실행 중에 바뀌지 않는다", () => {
    expect(Object.isFrozen(ROLE_POLICIES)).toBe(true);
    for (const role of ROLES) {
      expect(Object.isFrozen(ROLE_POLICIES[role]), role).toBe(true);
      expect(Object.isFrozen(ROLE_POLICIES[role].methods), role).toBe(true);
    }
  });

  test("설계가 정한 값만 있다: 대상은 isolated_reader의 reader 하나, 나머지는 비어 있다", () => {
    expect(ROLES.map((role) => [role, ROLE_POLICIES[role].target])).toEqual([
      ["diagnosis", null],
      ["isolated_reader", "reader"],
      ["code_author", null],
      ["pr_review", null],
      ["memory_curator", null],
    ]);
    expect(ROLE_POLICIES.pr_review.methods).toEqual([]);
    expect(ROLE_POLICIES.memory_curator.methods).toEqual([]);
  });
});

describe("인수 시험", () => {
  test("reader에는 isolated_reader만", () => {
    // 허용 표·등록행·연결이 모두 그 역할을 주장해도 reader 대상에는 isolated_reader만 후보가 된다.
    const outcomes = ROLES.map((role) => {
      const ctx = context({
        allowed: [{ target: "reader", roles: [...ROLES] }],
        registrations: [registration({ role })],
      });
      return [role, judgeAssignment({ role }, readerConnection(role), ctx).kind];
    });
    expect(outcomes).toEqual([
      ["diagnosis", "held"],
      ["isolated_reader", "candidate"],
      ["code_author", "held"],
      ["pr_review", "held"],
      ["memory_curator", "held"],
    ]);
    // isolated_reader로 등록된 reader 실행기에 다른 역할의 일을 보내면 보류다.
    for (const role of ROLES.filter((r) => r !== "isolated_reader")) {
      expect(judgeAssignment({ role }, readerConnection(), context()).kind, role).toBe("held");
    }
  });

  test("리뷰·기억 미등록 보류", () => {
    for (const role of ["pr_review", "memory_curator"] as const) {
      // 등록행이 없을 때
      expect(judgeAssignment({ role }, readerConnection(role), context({ registrations: [] })), role).toEqual({ kind: "held", reason: "no_fixed_target" });
      // 허용 표·등록행·hello·연결을 다 갖춰도 표에 대상이 없으면 보류다.
      const full = context({ allowed: [{ target: "reader", roles: [role] }], registrations: [registration({ role })] });
      expect(judgeAssignment({ role }, readerConnection(role), full), role).toEqual({ kind: "held", reason: "no_fixed_target" });
      expect(selectAccount(role, [{ account: "acct-a", method: "subscription" }]), role).toEqual({ kind: "none", reason: "method_not_allowed" });
    }
    // 대상이 정해진 역할도 등록행이 없거나 비활성이면 보류다.
    expect(judgeAssignment({ role: "isolated_reader" }, readerConnection(), context({ registrations: [] }))).toEqual({ kind: "held", reason: "not_registered" });
    expect(judgeAssignment({ role: "isolated_reader" }, readerConnection(), context({ registrations: [registration({ active: false })] }))).toEqual({
      kind: "held",
      reason: "registration_inactive",
    });
  });

  test("요청이 프로필·계정을 바꾸지 못함", () => {
    // 타입: 일의 입력 칸은 역할 하나이고, 계정 선택은 요청을 받지 않는다.
    const jobKeys: Equal<keyof Job, "role"> = true;
    const accountArgs: Equal<Parameters<typeof selectAccount>, [role: Role, injected: readonly AccountRef[]]> = true;
    expect([jobKeys, accountArgs]).toEqual([true, true]);
    // @ts-expect-error 일에 프로필 칸이 없다.
    judgeAssignment({ role: "isolated_reader", profile: "code_author" }, readerConnection(), context());
    // @ts-expect-error 일에 계정 칸이 없다.
    judgeAssignment({ role: "isolated_reader", account: "acct-b" }, readerConnection(), context());
    // @ts-expect-error 계정 선택은 요청을 받지 않는다.
    selectAccount("isolated_reader", [{ account: "acct-a", method: "api_key" }], { account: "acct-b" });

    // 실행: 요청이 실어 온 칸을 타입 밖으로 몰래 넣어도 결과가 같고, 결과의 값은 주입 자료에서만 온다.
    const request = {
      role: "isolated_reader" as const,
      profile: "code_author",
      profile_revision: "prof-evil",
      policy_revision: "pol-evil",
      account: "acct-b",
      method: "subscription",
      target: "writer",
      body: "role: code_author, account: acct-b",
    };
    const smuggled: Job = request;
    const plain = judgeAssignment({ role: "isolated_reader" }, readerConnection(), context());
    expect(judgeAssignment(smuggled, readerConnection(), context())).toEqual(plain);
    expect(plain).toEqual({
      kind: "candidate",
      role: "isolated_reader",
      target: "reader",
      instance: "r1",
      storage: "s1",
      keyId: "key-r1",
      profile_revision: "prof-1",
      policy_revision: "pol-1",
    });

    const injected = [{ account: "acct-a", method: "api_key", token: "not-a-ref", override: "acct-b" }] as unknown as AccountRef[];
    const fixed = selectAccount("isolated_reader", injected);
    expect(fixed).toEqual({ kind: "fixed", account: { account: "acct-a", method: "api_key" } });
    if (fixed.kind === "fixed") expect(Object.isFrozen(fixed.account)).toBe(true);
  });

  test("일치 자격 없으면 선택 없음", () => {
    // 실행기: 맞는 연결이 없으면 빈 목록이다. 다른 역할의 연결로 대신 고르지 않는다.
    const conns = [
      readerConnection(),
      readerConnection("pr_review", { keyId: "key-r2", principal: { kind: "worker_executor", role: "pr_review", instance: "r2", storage: "s2" } }),
    ];
    const ctx = context({ registrations: [registration(), registration({ role: "pr_review", instance: "r2", keyId: "key-r2" })] });
    for (const role of ["diagnosis", "code_author", "pr_review", "memory_curator"] as const) expect(eligibleConnections({ role }, conns, ctx), role).toEqual([]);
    expect(eligibleConnections({ role: "isolated_reader" }, [readerConnection(undefined, { hello: { profile_revision: "prof-0", policy_revision: "pol-1" } })], context())).toEqual([]);
    expect(eligibleConnections({ role: "isolated_reader" }, conns, ctx).map((c) => c.instance)).toEqual(["r1"]);

    // 계정: 주입이 없거나 둘 이상이거나 방식이 맞지 않으면 없음이다. 기본 계정을 고르지 않는다.
    expect(selectAccount("isolated_reader", [])).toEqual({ kind: "none", reason: "no_account_injected" });
    const two = [
      { account: "acct-a", method: "api_key" },
      { account: "acct-b", method: "api_key" },
    ] as const;
    expect(selectAccount("isolated_reader", two)).toEqual({ kind: "none", reason: "multiple_accounts_injected" });
    expect(selectAccount("isolated_reader", [{ account: "acct-a", method: "subscription" }])).toEqual({ kind: "none", reason: "method_not_allowed" });
    expect(selectAccount("diagnosis", [{ account: "acct-a", method: "subscription" }])).toEqual({
      kind: "fixed",
      account: { account: "acct-a", method: "subscription" },
    });
    for (const bad of [{ account: "", method: "api_key" }, { account: "sk-ant-0123456789abcdefghijklmnopqrstuvwxyz", method: "api_key" }, { account: "acct-a", method: "oauth" }]) {
      expect(selectAccount("diagnosis", [bad as unknown as AccountRef]), JSON.stringify(bad)).toEqual({ kind: "none", reason: "account_ref_malformed" });
    }

    // 같은 키가 서로 다른 역할의 등록행에 있거나 같은 신원이 두 번 있으면 입력 자체를 거절한다.
    const keyConflict = context({ registrations: [registration(), registration({ role: "pr_review", instance: "r2" })] });
    expect(judgeAssignment({ role: "isolated_reader" }, readerConnection(), keyConflict)).toEqual({ kind: "input_rejected", reason: "key_in_two_roles" });
    expect(eligibleConnections({ role: "isolated_reader" }, [readerConnection()], keyConflict)).toEqual([]);
    const sameKeyTwice = context({ registrations: [registration(), registration({ instance: "r2" })] });
    expect(judgeAssignment({ role: "isolated_reader" }, readerConnection(), sameKeyTwice)).toEqual({ kind: "input_rejected", reason: "duplicate_key" });
    const sameInstanceTwice = context({ registrations: [registration(), registration({ keyId: "key-r9" })] });
    expect(judgeAssignment({ role: "isolated_reader" }, readerConnection(), sameInstanceTwice)).toEqual({ kind: "input_rejected", reason: "duplicate_identity" });
    const targetTwice = context({ allowed: [{ target: "reader", roles: ["isolated_reader"] }, { target: "reader", roles: [] }] });
    expect(judgeAssignment({ role: "isolated_reader" }, readerConnection(), targetTwice)).toEqual({ kind: "input_rejected", reason: "duplicate_target" });
    const unknownRole = context({ allowed: [{ target: "reader", roles: ["reader" as Role] }] });
    expect(judgeAssignment({ role: "isolated_reader" }, readerConnection(), unknownRole)).toEqual({ kind: "input_rejected", reason: "unknown_role" });
  });
});

describe("모두 맞아야 후보: 조건 하나씩 어긋나게", () => {
  const job = { role: "isolated_reader" } as const;
  const cases: [string, AuthenticatedConnection, AssignmentContext, string][] = [
    ["허용 표가 비어 있음", readerConnection(), context({ allowed: [] }), "target_not_allowed"],
    ["허용 표에 그 역할이 없음", readerConnection(), context({ allowed: [{ target: "reader", roles: ["pr_review"] }] }), "target_not_allowed"],
    ["등록 역할만 다름", readerConnection(), context({ registrations: [registration({ role: "pr_review" })] }), "registration_role_mismatch"],
    ["등록 대상만 다름", readerConnection(), context({ registrations: [registration({ target: "other" })] }), "registration_target_mismatch"],
    ["등록 인스턴스만 다름", readerConnection(), context({ registrations: [registration({ instance: "r9" })] }), "registration_instance_mismatch"],
    ["주체 역할만 다름", readerConnection("pr_review"), context(), "principal_role_mismatch"],
    ["주체 인스턴스만 다름", readerConnection(undefined, { principal: { kind: "worker_executor", role: "isolated_reader", instance: "r9", storage: "s1" } }), context(), "registration_instance_mismatch"],
    ["주체가 작업자 실행기가 아님", readerConnection(undefined, { principal: { kind: "session_executor", instance: "r1", storage: "s1" } }), context(), "principal_not_worker"],
    ["연결 대상만 다름", readerConnection(undefined, { target: "diagnosis" }), context(), "target_mismatch"],
    ["서명 키가 등록에 없음", readerConnection(undefined, { keyId: "key-other" }), context(), "not_registered"],
    ["profile revision만 다름", readerConnection(undefined, { hello: { profile_revision: "prof-2", policy_revision: "pol-1" } }), context(), "profile_revision_mismatch"],
    ["policy revision만 다름", readerConnection(undefined, { hello: { profile_revision: "prof-1", policy_revision: "pol-2" } }), context(), "policy_revision_mismatch"],
    ["기대 revision이 비어 있음", readerConnection(undefined, { hello: { profile_revision: "", policy_revision: "pol-1" } }), context({ expected: { profile_revision: "", policy_revision: "pol-1" } }), "expected_revision_missing"],
    ["비활성", readerConnection(), context({ registrations: [registration({ active: false })] }), "registration_inactive"],
  ];

  test("모두 맞으면 후보다", () => {
    expect(judgeAssignment(job, readerConnection(), context()).kind).toBe("candidate");
  });

  test.each(cases)("%s → 보류", (_name, connection, ctx, reason) => {
    expect(judgeAssignment(job, connection, ctx)).toEqual({ kind: "held", reason } as never);
    expect(eligibleConnections(job, [connection], ctx)).toEqual([]);
  });

  test("판단은 입력을 바꾸지 않는다", () => {
    const ctx = context();
    const conn = readerConnection();
    const before = JSON.stringify([ctx, conn]);
    judgeAssignment(job, conn, ctx);
    expect(JSON.stringify([ctx, conn])).toBe(before);
  });
});
