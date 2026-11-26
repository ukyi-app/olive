// 배정 정책의 빈 칸을 배포 값으로 채우는 함수(src/supervisor/runtime/assign-policy.ts)와 그 연결(진입점 settingsFromEnv, 조립 boot.ts).
// 값이 없거나 맞지 않으면 채우기 전의 닫힌 값과 같고(보류·모름), 맞으면 등록표·판 값이 배정 판단과 자격 참조에 그대로 닿는지 본다.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type Role } from "../../../src/contract/v1/index.ts";
import { SUPERVISOR_ENV, settingsFromEnv } from "../../../src/main/supervisor.ts";
import { type AuthenticatedConnection, judgeAssignment } from "../../../src/supervisor/roles/assign.ts";
import { accountRevisionFromEnv, assignmentFrom, profileRevisionsFromEnv, registrationsFrom } from "../../../src/supervisor/runtime/assign-policy.ts";
import { RegistryState, type RegistryTarget } from "../../../src/supervisor/transport/registry.ts";
import { executorKey, FILES, world } from "./boot-world.ts";

const FULL: Record<(typeof SUPERVISOR_ENV)[number], string> = {
  OLIVE_SUPERVISOR_PORT: "8443",
  OLIVE_LEDGER_DIR: "/var/lib/olive",
  OLIVE_SIGNING_KEY_DIR: "/etc/olive/signing",
  OLIVE_ACCOUNTS_DIR: "/etc/olive/accounts",
  OLIVE_TLS_DIR: "/etc/olive/tls",
  OLIVE_TRUST_DIR: "/etc/olive/trust",
  OLIVE_REGISTRY_FILE: "/etc/olive/registry/registry.json",
  OLIVE_ENVIRONMENT: "home",
  OLIVE_TARGETS: JSON.stringify([
    { target: "diagnosis", namespace: "olive-diagnosis", roles: ["diagnosis"] },
    { target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] },
  ]),
  OLIVE_POLICY_REVISION: "policy-1",
  OLIVE_RESULT_DIR: "/var/lib/olive/results",
};

// 역할의 대상은 고정 표(roles/policy.ts)를 따른다: diagnosis → diagnosis, isolated_reader → reader.
const TARGETS: RegistryTarget[] = [
  { target: "diagnosis", namespace: "olive-diagnosis", roles: ["diagnosis"] },
  { target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] },
];
const targetOf = (role: Role) => (role === "isolated_reader" ? "reader" : "diagnosis");

function settingsOf(extra: Record<string, string>) {
  const parsed = settingsFromEnv({ ...FULL, ...extra });
  if (!parsed.ok) throw new Error(`${parsed.name} ${parsed.problem}`);
  return parsed;
}

type Row = { role: Role; instance: string; storage: string; raw: string; active?: boolean };
function doc(rows: Row[], revision = 1): Uint8Array {
  const executors = rows.map((r) => ({ target: targetOf(r.role), role: r.role, instance: r.instance, storage: r.storage, public_key: r.raw, active: r.active ?? true }));
  return new TextEncoder().encode(JSON.stringify({ environment: "home", revision, executors }));
}

function applied(content: Uint8Array): RegistryState {
  const result = RegistryState.start({ environment: "home", targets: TARGETS }).apply({ kind: "content", content });
  if (result.kind !== "applied") throw new Error(`등록표 적용 실패: ${result.kind}`);
  return result.state;
}

const peerOf = (role: Role) => {
  const target = targetOf(role);
  return { kind: "executor" as const, target, namespace: `olive-${target}`, uri: `spiffe://olive/ns/olive-${target}` };
};

function connection(role: Role, instance: string, storage: string, keyId: string, profile: string): AuthenticatedConnection {
  return { target: targetOf(role), principal: { kind: "worker_executor", role, instance, storage }, keyId, hello: { profile_revision: profile, policy_revision: "policy-1" } };
}

test("판 값 환경: 없음·빈 값은 모름, v1 revision 꼴은 그 값, 그 밖은 틀림이다", () => {
  expect([accountRevisionFromEnv(undefined), accountRevisionFromEnv(""), accountRevisionFromEnv("acct-1.2_3")]).toEqual([
    { ok: true, value: null },
    { ok: true, value: null },
    { ok: true, value: "acct-1.2_3" },
  ]);
  for (const bad of ["-acct", "acct 1", " acct", "acct/1", "a".repeat(65), "계정"]) expect([bad, accountRevisionFromEnv(bad)]).toEqual([bad, { ok: false }]);
});

test("역할별 프로필 환경: 없음·빈 값·빈 객체는 칸 없음, 역할 이름과 revision 꼴이 맞는 객체만 받는다", () => {
  expect([profileRevisionsFromEnv(undefined), profileRevisionsFromEnv(""), profileRevisionsFromEnv("{}")]).toEqual([
    { ok: true, value: {} },
    { ok: true, value: {} },
    { ok: true, value: {} },
  ]);
  expect(profileRevisionsFromEnv(JSON.stringify({ diagnosis: "prof-1", code_author: "prof-2" }))).toEqual({ ok: true, value: { diagnosis: "prof-1", code_author: "prof-2" } });
  const bad = ["not json", "[]", "null", '"prof-1"', "1", '{"no_role":"p"}', '{"__proto__":"p"}', '{"constructor":"p"}', '{"diagnosis":1}', '{"diagnosis":"-p"}', '{"diagnosis":""}', '{"diagnosis":null}'];
  for (const raw of bad) expect([raw, profileRevisionsFromEnv(raw)]).toEqual([raw, { ok: false }]);
});

test("진입점: 새 환경이 없으면 배정 정책·자격 판은 채우기 전의 닫힌 값과 같다", () => {
  const parsed = settingsOf({});
  const s = parsed.settings;
  expect(s.assign.assignment).toEqual({
    allowed: [
      { target: "diagnosis", roles: ["diagnosis"] },
      { target: "reader", roles: ["isolated_reader"] },
    ],
    registrations: [],
    expected: { profile_revision: "", policy_revision: "policy-1" },
  });
  expect([s.assign.accounts, s.assign.plans]).toEqual([[], []]);
  expect([s.credentials.revisionOf("acct-a", "subscription"), s.credentials.revisionOf("acct-a", "api_key")]).toEqual([null, null]);
  expect(parsed.assignInputs).toEqual({ accountRevision: false, profileRevisions: "none" });
  // 빈 값도 없는 것과 같다.
  const empty = settingsOf({ OLIVE_ACCOUNT_REVISION: "", OLIVE_PROFILE_REVISIONS: "" });
  expect([empty.settings.assign.assignment, empty.settings.credentials.revisionOf("acct-a", "subscription"), empty.assignInputs]).toEqual([
    s.assign.assignment,
    null,
    { accountRevision: false, profileRevisions: "none" },
  ]);
});

test("진입점: 판 값은 자격 정책의 revisionOf로, 역할별 프로필은 허용 표·기대 revision으로 간다. 계정은 비어 있다", () => {
  const parsed = settingsOf({ OLIVE_ACCOUNT_REVISION: "acct-7", OLIVE_PROFILE_REVISIONS: JSON.stringify({ diagnosis: "prof-1" }) });
  const s = parsed.settings;
  expect(s.credentials.revisionOf("acct-a", "subscription")).toBe("acct-7");
  expect(s.assign.assignment).toEqual({
    allowed: [
      { target: "diagnosis", roles: ["diagnosis"] },
      { target: "reader", roles: [] },
    ],
    registrations: [],
    expected: { profile_revision: "prof-1", policy_revision: "policy-1" },
  });
  expect(s.assign.accounts).toEqual([]);
  expect(parsed.assignInputs).toEqual({ accountRevision: true, profileRevisions: "single" });
});

test("진입점: 새 환경의 꼴이 틀리면 그 이름으로 invalid다. 필수 이름과 정책 revision이 먼저고, 선택 이름끼리는 표의 차례다", () => {
  expect(settingsFromEnv({ ...FULL, OLIVE_ACCOUNT_REVISION: "-bad" })).toEqual({ ok: false, name: "OLIVE_ACCOUNT_REVISION", problem: "invalid" });
  expect(settingsFromEnv({ ...FULL, OLIVE_PROFILE_REVISIONS: '{"no_role":"p"}' })).toEqual({ ok: false, name: "OLIVE_PROFILE_REVISIONS", problem: "invalid" });
  expect(settingsFromEnv({ ...FULL, OLIVE_RESULT_DIR: "", OLIVE_ACCOUNT_REVISION: "-bad" })).toEqual({ ok: false, name: "OLIVE_RESULT_DIR", problem: "missing" });
  expect(settingsFromEnv({ ...FULL, OLIVE_POLICY_REVISION: "-bad", OLIVE_ACCOUNT_REVISION: "-bad" })).toEqual({ ok: false, name: "OLIVE_POLICY_REVISION", problem: "invalid" });
  expect(settingsFromEnv({ ...FULL, OLIVE_ACCOUNT_REVISION: "-bad", OLIVE_PROFILE_REVISIONS: "x" })).toEqual({ ok: false, name: "OLIVE_ACCOUNT_REVISION", problem: "invalid" });
  expect(settingsFromEnv({ ...FULL, OLIVE_PROFILE_REVISIONS: "x", OLIVE_TEST_JOBS: "x" })).toEqual({ ok: false, name: "OLIVE_PROFILE_REVISIONS", problem: "invalid" });
});

test("기대 revision: 칸이 모두 한 값이면 그 값과 칸이 있는 역할만, 칸마다 다르면 기대값이 비어 모두 보류다", () => {
  const key = "key-d";
  const rows = [
    { target: "diagnosis", role: "diagnosis" as const, instance: "d1", storage: "s1", keyId: key, active: true },
    { target: "reader", role: "isolated_reader" as const, instance: "r1", storage: "s1", keyId: "key-r", active: true },
  ];
  const judge = (profiles: Record<string, string>, conn: AuthenticatedConnection) => {
    const { context } = assignmentFrom(TARGETS, profiles, "policy-1");
    return judgeAssignment({ role: conn.principal.kind === "worker_executor" ? conn.principal.role : "diagnosis" }, conn, { ...context, registrations: rows });
  };
  const diag = (profile: string) => connection("diagnosis", "d1", "s1", key, profile);
  const reader = (profile: string) => connection("isolated_reader", "r1", "s1", "key-r", profile);
  // 칸 없음: 채우기 전과 같다.
  expect(judge({}, diag("prof-1"))).toEqual({ kind: "held", reason: "expected_revision_missing" });
  // 한 값: 그 역할만 후보가 될 수 있다. 칸이 없는 역할은 같은 값을 내도 허용 표에서 빠진다.
  expect(judge({ diagnosis: "prof-1" }, diag("prof-1")).kind).toBe("candidate");
  expect(judge({ diagnosis: "prof-1" }, diag("prof-2"))).toEqual({ kind: "held", reason: "profile_revision_mismatch" });
  expect(judge({ diagnosis: "prof-1" }, reader("prof-1"))).toEqual({ kind: "held", reason: "target_not_allowed" });
  expect(judge({ diagnosis: "prof-1", isolated_reader: "prof-1" }, reader("prof-1")).kind).toBe("candidate");
  // 칸마다 다른 값: 하나로 고를 수 없어 어느 역할도 후보가 아니다.
  const split = { diagnosis: "prof-1", isolated_reader: "prof-2" };
  expect([judge(split, diag("prof-1")), judge(split, reader("prof-2"))]).toEqual([
    { kind: "held", reason: "expected_revision_missing" },
    { kind: "held", reason: "expected_revision_missing" },
  ]);
  expect([assignmentFrom(TARGETS, {}, "p").profile, assignmentFrom(TARGETS, { diagnosis: "a" }, "p").profile, assignmentFrom(TARGETS, split, "p").profile]).toEqual([
    "none",
    "single",
    "split",
  ]);
});

test("등록행: 적용한 문서의 활성 행만, keyId는 등록표 상태가 그 주체에 답한 값이다", () => {
  const a = executorKey();
  const b = executorKey();
  const c = executorKey();
  const content = doc([
    { role: "diagnosis", instance: "d1", storage: "s1", raw: a.raw },
    { role: "isolated_reader", instance: "r1", storage: "s2", raw: b.raw },
    { role: "diagnosis", instance: "d0", storage: "s0", raw: c.raw, active: false },
  ]);
  const state = applied(content);
  const rows = registrationsFrom(content, state, TARGETS);
  const keyOf = (role: Role, name: string) => state.keyFor(peerOf(role), name)?.keyId;
  expect(rows).toEqual([
    { target: "diagnosis", role: "diagnosis", instance: "d1", storage: "s1", keyId: keyOf("diagnosis", "executor/diagnosis/d1/s1")!, active: true },
    { target: "reader", role: "isolated_reader", instance: "r1", storage: "s2", keyId: keyOf("isolated_reader", "executor/isolated_reader/r1/s2")!, active: true },
  ]);
  expect(new Set(rows.map((row) => row.keyId)).size).toBe(2);
  expect(rows.every((row) => typeof row.keyId === "string" && row.keyId.length > 0)).toBe(true);
  // 만든 등록행과 역할별 프로필로 그 연결이 후보가 된다(연결 표가 같은 keyFor로 keyId를 적는다).
  const { context } = assignmentFrom(TARGETS, { diagnosis: "prof-1" }, "policy-1");
  const judged = judgeAssignment({ role: "diagnosis" }, connection("diagnosis", "d1", "s1", rows[0]!.keyId, "prof-1"), { ...context, registrations: rows });
  expect(judged.kind).toBe("candidate");
});

test("등록행: 문서·상태가 어긋나거나 던지면 행을 골라 받지 않고 빈 목록이다", () => {
  const a = executorKey();
  const b = executorKey();
  const content = doc([{ role: "diagnosis", instance: "d1", storage: "s1", raw: a.raw }]);
  const state = applied(content);
  const other = doc([{ role: "diagnosis", instance: "d1", storage: "s1", raw: a.raw }, { role: "diagnosis", instance: "d2", storage: "s1", raw: b.raw }], 2);
  const cases: [string, readonly unknown[]][] = [
    ["not json", registrationsFrom(new TextEncoder().encode("not json"), state, TARGETS)],
    ["깨진 UTF-8", registrationsFrom(new Uint8Array([0xff, 0xfe]), state, TARGETS)],
    ["executors 없음", registrationsFrom(new TextEncoder().encode('{"environment":"home","revision":1}'), state, TARGETS)],
    ["null 문서", registrationsFrom(new TextEncoder().encode("null"), state, TARGETS)],
    // 상태가 믿지 않는 활성 행이 하나라도 있으면 전부 버린다.
    ["상태가 모르는 행", registrationsFrom(other, state, TARGETS)],
    ["적용 전 상태", registrationsFrom(content, RegistryState.start({ environment: "home", targets: TARGETS }), TARGETS)],
    ["대상 표에 없는 대상", registrationsFrom(content, state, [])],
    ["keyFor 던짐", registrationsFrom(content, { keyFor: () => { throw new Error("x"); } } as unknown as RegistryState, TARGETS)],
    ["keyFor 꼴 틀림", registrationsFrom(content, { keyFor: () => ({ keyId: 7 }) } as unknown as RegistryState, TARGETS)],
  ];
  for (const [name, rows] of cases) expect([name, rows]).toEqual([name, []]);
});

// 조립의 배정 박자를 순서기 없이 한 번 부르고, 박자 함수에 넘긴 포트·정책을 붙잡는다(박자는 돌리지 않는다).
async function capturedAssign(over: Parameters<typeof world>[0], content?: Uint8Array) {
  type Seen = { ports: { credentials: { reference: (c: { account: string; method: string }) => Promise<unknown> } }; policy: unknown };
  // 닫힘 안에서 채우는 칸이라 상자에 둔다(지역 변수면 타입 검사가 null로 좁힌다).
  const box: { seen: Seen | null } = { seen: null };
  const w = world({
    ...over,
    makers: {
      ...over?.makers,
      ticks: {
        linkLoss: () => { throw new Error("x"); },
        resultCheck: () => { throw new Error("x"); },
        life: () => { throw new Error("x"); },
        resend: () => { throw new Error("x"); },
        unreceived: () => { throw new Error("x"); },
        assign: async (ports, policy) => {
          box.seen = { ports: ports as never, policy };
          return { kind: "not_run", reason: "intake_closed" } as never;
        },
      },
    },
  });
  if (content) w.files.set(FILES.registry, () => Promise.resolve(content));
  const result = await w.boot();
  if (!result.ok) throw new Error(`기동 실패 ${result.step} ${result.reason}`);
  await w.captured.cycle!.deps.beats.assign(1_800_000_000_000);
  await result.running.stop();
  if (box.seen === null) throw new Error("배정 박자가 불리지 않았다");
  return { w, seen: box.seen };
}

test("조립: 배정 정책의 등록행은 적용한 등록표에서 만들고(설정의 칸은 쓰지 않는다) 기록에 그 수를 남긴다", async () => {
  const a = executorKey();
  const content = new TextEncoder().encode(
    JSON.stringify({ environment: "home", revision: 1, executors: [{ target: "reader", role: "diagnosis", instance: "0", storage: "store-a", public_key: a.raw, active: true }] }),
  );
  const fake = { target: "reader", role: "diagnosis" as const, instance: "9", storage: "x", keyId: "fake", active: true };
  const { w, seen } = await capturedAssign(
    { settings: { assign: { ...world().settings.assign, assignment: { ...world().settings.assign.assignment, registrations: [fake] } } } },
    content,
  );
  const state = RegistryState.start(w.settings.registry).apply({ kind: "content", content });
  if (state.kind !== "applied") throw new Error("적용 실패");
  const keyId = state.state.keyFor({ kind: "executor", target: "reader", namespace: "olive-reader", uri: "u" }, "executor/diagnosis/0/store-a")?.keyId;
  const policy = seen.policy as typeof w.settings.assign;
  expect(policy.assignment.registrations).toEqual([{ target: "reader", role: "diagnosis", instance: "0", storage: "store-a", keyId: keyId!, active: true }]);
  // 나머지 칸은 설정의 값 그대로다.
  expect([policy.assignment.allowed, policy.assignment.expected, policy.accounts, policy.plans, policy.originOf]).toEqual([
    w.settings.assign.assignment.allowed,
    w.settings.assign.assignment.expected,
    w.settings.assign.accounts,
    w.settings.assign.plans,
    w.settings.assign.originOf,
  ]);
  expect(w.events.filter((e) => e.event === "assign_policy").map((e) => e.fields)).toEqual([{ registrations: 1 }]);
});

test("조립: 자격 참조 포트는 주입한 파일 포트와 설정의 자격 정책으로 만든다. 판을 모르면 파일을 열지 않고 모름이다", async () => {
  const token = new TextEncoder().encode("token-bytes\n");
  const reads: string[] = [];
  const credentialFiles = {
    read: async (location: { dir: string; account: string; key: string }) => {
      reads.push(`${location.dir}/${location.account}/${location.key}`);
      return { kind: "bytes" as const, bytes: token.slice() };
    },
  };
  const known = await capturedAssign({ deps: { credentialFiles }, settings: { credentials: { ...settingsOf({ OLIVE_ACCOUNT_REVISION: "acct-7" }).settings.credentials, dir: "/accounts" } } });
  const answer = await known.seen.ports.credentials.reference({ account: "acct-a", method: "subscription" });
  expect(answer).toEqual({ known: true, credential: { account: "acct-a", method: "subscription", revision: "acct-7", digest: createHash("sha256").update(token).digest("hex") } });
  expect(reads).toEqual(["/accounts/acct-a/CLAUDE_CODE_OAUTH_TOKEN"]);

  reads.length = 0;
  const unknown = await capturedAssign({ deps: { credentialFiles }, settings: { credentials: { ...settingsOf({}).settings.credentials, dir: "/accounts" } } });
  expect(await unknown.seen.ports.credentials.reference({ account: "acct-a", method: "subscription" })).toEqual({ known: false });
  expect(reads).toEqual([]);
});
