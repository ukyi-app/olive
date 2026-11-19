// v2 표본 재생: 모든 사례를 읽어 공개 면의 검증기에 넣고 기대와 대조한다. 다른 구현(현관)이 같은 파일을 재생할 수 있게
// 서명 입력, 공개 키의 꼴, 후보 표시도 본다.
import { expect, test } from "bun:test";
import { canonicalJson } from "../../../src/contract/v1/index.ts";
import { afterHandshake, FRONTDOOR_CONTRACT, REJECT_REASONS } from "../../../src/contract/v2/index.ts";
import { list, readText } from "../../files.ts";
import { buildCases, type Expect, FIXTURE_DIR, FIXTURE_TAG, type V2Case } from "./cases.ts";
import { contextOf, freshKeys, leafDiff, other } from "./support.ts";

type Fixture = V2Case & { fixture: string; signing_input: string };

const files = await list(`${FIXTURE_DIR}/**/*.json`);
const fixtures = new Map<string, Fixture>();
for (const file of files) {
  const fixture = JSON.parse(await readText(file)) as Fixture;
  fixtures.set(fixture.name, fixture);
}

async function replay(f: Pick<V2Case, "keys" | "context" | "message">): Promise<Expect> {
  const result = await FRONTDOOR_CONTRACT.verify(f.message, contextOf(f.keys, f.context));
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, handshake_after: result.class === "handshake" ? afterHandshake(result, f.context.own_policy_revision) : null };
}

// 공개 면의 표에 효과 동작이 없으면 표본을 만들 수 없는 것. 지금은 효과 동작이 있어 이 면제는 쓰이지 않는다(아래 시험이 표본을 요구한다).
const publicEffects = Object.values(FRONTDOOR_CONTRACT.actions).filter((spec) => spec.class === "effect");
const hasEffect = publicEffects.length > 0;
// intake_closed는 닫힌 접수에서 받지 않는 효과 동작이 있어야 닿는다. 지금은 입력·출력 묶음에 그런 효과가 있어 면제되지 않는다
// (모든 효과가 닫힌 접수에서 받는 표면 면제된다).
const hasIntakeGatedEffect = publicEffects.some((spec) => !spec.duringClosedIntake);
const WITHOUT_EFFECT: { reasons: readonly string[]; actions: readonly string[] } = {
  // 인사 밖의 동작이 필요한 사유(조회와 효과): 조회 본문의 action이 효과 동작이어야 하고, 세대 사유는 효과 동작에만 걸린다.
  reasons: ["handshake_required", "policy_mismatch", "intake_closed", "generation_missing", "generation_unknown", "generation_mismatch"],
  actions: ["job_lookup", "job_status"],
};
// 실제 신뢰 문맥(받는 쪽은 상대 키 하나만 믿는다)에서는 닿지 않는 사유. 당사자가 둘이라 서명이 맞으면 낸 쪽은 상대이고, 방향 검사가
// 받는 쪽 ≠ 낸 쪽을 요구하므로 받는 쪽은 늘 자기다. 검증기의 이 검사는 방어용으로 남기고, 두 키를 다 믿는 인위적 문맥의 단위 시험이 본다
// (table.test.ts). 표본에 두면 올바른 구현이 표본의 키 지도를 흉내 내야 기대 사유가 나오므로 공개 표본에서 뺀다.
const UNREACHABLE_WITH_PEER_KEY: readonly string[] = ["wrong_recipient"];

test("fixture v2: 파일 이름과 사례 이름이 같고, accept·reject 두 폴더뿐이며 모두 후보다", () => {
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const name = file.slice(FIXTURE_DIR.length + 1).replace(/\.json$/, "");
    expect(name).toMatch(/^(accept|reject)\/[a-z0-9-]+$/);
    const fixture = fixtures.get(name);
    expect(fixture?.fixture, file).toBe(FIXTURE_TAG);
    expect(fixture?.status, file).toBe("candidate");
  }
});

test("fixture v2: accept는 모두 통과하고 reject는 모두 정해진 사유로 거절된다", async () => {
  for (const fixture of fixtures.values()) expect(await replay(fixture), fixture.name).toEqual(fixture.expect);
});

test("fixture v2: 서명 입력은 머리의 정규 직렬화다", () => {
  for (const fixture of fixtures.values()) expect(fixture.signing_input, fixture.name).toBe(canonicalJson(fixture.message.header));
});

test("fixture v2: 사례 정의와 같다(새 키로 다시 만들어도 서명과 키 말고는 그대로다)", () => {
  const regenerated = buildCases(freshKeys());
  expect([...fixtures.keys()].sort()).toEqual(regenerated.map((c) => c.name).sort());
  const strip = (x: V2Case) => ({ ...x, keys: Object.keys(x.keys).sort(), message: { ...x.message, signature: "" } });
  for (const c of regenerated) {
    const { fixture: _f, signing_input: _s, ...rest } = fixtures.get(c.name)!;
    expect(strip(rest), c.name).toEqual(strip(c));
  }
});

test("fixture v2: 거절 사례는 기준 사례(통과)에서 적어 둔 곳만 다르다", async () => {
  const derived = ["message.signature", "message.header.body_digest"];
  const covers = (changed: string, path: string) => path === changed || path.startsWith(`${changed}.`) || path.startsWith(`${changed}[`);
  for (const fixture of fixtures.values()) {
    if (fixture.expect.ok) {
      expect(fixture.base, fixture.name).toBeNull();
      continue;
    }
    const base = fixtures.get(fixture.base ?? "");
    expect(base?.expect.ok, `${fixture.name}의 기준`).toBe(true);
    expect((await replay(base!)).ok).toBe(true);
    const pick = (f: Fixture) => ({ message: f.message, context: f.context, keys: f.keys });
    const diff = leafDiff(pick(base!), pick(fixture)).filter((path) => !derived.includes(path) || fixture.changed.includes(path));
    for (const path of diff) expect(fixture.changed.some((c) => covers(c, path)), `${fixture.name}: ${path}`).toBe(true);
    for (const changed of fixture.changed) expect(diff.some((path) => covers(changed, path)), `${fixture.name}: ${changed}`).toBe(true);
  }
});

test("fixture v2: 믿는 키는 늘 받는 쪽의 상대 키 하나이고, 같은 당사자는 모든 사례에서 같은 키다", () => {
  const keyOf = new Map<string, string>();
  for (const fixture of fixtures.values()) {
    const peer = other(fixture.context.expected_recipient);
    expect(Object.keys(fixture.keys), fixture.name).toEqual([peer]);
    const raw = fixture.keys[peer]!;
    expect(keyOf.get(peer) ?? raw, fixture.name).toBe(raw);
    keyOf.set(peer, raw);
  }
  expect([...keyOf.keys()].sort()).toEqual(["front-door", "supervisor"]);
});

test("fixture v2: 거절 사유마다 그것만 틀린 사례가 있고, 동작마다 통과 사례가 있다(공개 면의 동작으로 아직 닿지 않는 사유의 면제와 상대 키 문맥에서 닿지 않는 사유만 뺀다)", () => {
  const reasons = new Set<string>([...fixtures.values()].flatMap((f) => (f.expect.ok ? [] : [f.expect.reason])));
  const exemptReasons = [...new Set([...(hasEffect ? [] : WITHOUT_EFFECT.reasons), ...(hasIntakeGatedEffect ? [] : ["intake_closed"]), ...UNREACHABLE_WITH_PEER_KEY])];
  for (const reason of REJECT_REASONS) if (!exemptReasons.includes(reason)) expect(reasons.has(reason), reason).toBe(true);
  for (const reason of exemptReasons) expect(reasons.has(reason), `면제가 낡았다: ${reason}`).toBe(false);

  const accepted = new Set([...fixtures.values()].filter((f) => f.expect.ok).map((f) => f.message.header.action));
  const exemptActions = hasEffect ? [] : WITHOUT_EFFECT.actions;
  for (const action of Object.keys(FRONTDOOR_CONTRACT.actions)) {
    if (exemptActions.includes(action)) expect(accepted.has(action), `면제가 낡았다: ${action}`).toBe(false);
    else expect(accepted.has(action), action).toBe(true);
  }
});

test("fixture v2: 개인 키를 담지 않는다(공개 키는 32바이트 원시 값뿐)", async () => {
  for (const file of files) expect(await readText(file), file).not.toMatch(/PRIVATE KEY|"d"\s*:|privateKey|private_key/);
  for (const fixture of fixtures.values()) for (const raw of Object.values(fixture.keys)) expect(Buffer.from(raw, "base64url")).toHaveLength(32);
});
