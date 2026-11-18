import { expect, test } from "bun:test";
import { canonicalJson } from "../../src/contract/v1/canonical.ts";
import { REJECT_REASONS, TRANSPORT_REASONS } from "../../src/contract/v1/errors.ts";
import { ACTIONS } from "../../src/contract/v1/header.ts";
import { list, readText } from "../files.ts";
import { buildCases, type ContractCase, freshKeys } from "./cases.ts";
import { leafDiff, verifyCase } from "./support.ts";

type Fixture = ContractCase & { fixture: string; signing_input: string };

const files = await list("contracts/fixtures/v1/**/*.json");
const fixtures = new Map<string, Fixture>();
for (const file of files) {
  const fixture = JSON.parse(await readText(file)) as Fixture;
  fixtures.set(fixture.name, fixture);
}

test("fixture: 파일 이름과 사례 이름이 같고, accept·reject 두 폴더뿐이다", () => {
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const name = file.replace(/^contracts\/fixtures\/v1\//, "").replace(/\.json$/, "");
    expect(name).toMatch(/^(accept|reject)\/[a-z0-9-]+$/);
    expect(fixtures.get(name)?.fixture, file).toBe("olive-control/v1");
  }
});

test("fixture: accept는 모두 통과하고 reject는 모두 정해진 사유로 거절된다", async () => {
  for (const fixture of fixtures.values()) {
    const result = await verifyCase(fixture);
    const got = result.ok ? { ok: true, adopted_stop_generation: result.adoptedStopGeneration } : { ok: false, reason: result.reason };
    expect(got, fixture.name).toEqual(fixture.expect);
  }
});

test("fixture: 서명 입력은 머리의 정규 직렬화다(다른 구현이 바이트를 맞춰 볼 수 있다)", () => {
  for (const fixture of fixtures.values()) expect(fixture.signing_input, fixture.name).toBe(canonicalJson(fixture.message.header));
});

test("fixture: 사례 정의와 같다(새 키로 다시 만들어도 서명과 키 말고는 그대로다)", () => {
  const regenerated = buildCases(freshKeys());
  expect([...fixtures.keys()].sort()).toEqual(regenerated.map((c) => c.name).sort());
  for (const c of regenerated) {
    const stored = fixtures.get(c.name)!;
    const strip = (x: ContractCase) => ({ ...x, keys: Object.keys(x.keys).sort(), message: { ...x.message, signature: "" } });
    const { fixture: _f, signing_input: _s, ...rest } = stored;
    expect(strip(rest), c.name).toEqual(strip(c));
  }
});

test("fixture: 거절 사례는 기준 사례(통과)에서 적어 둔 곳만 다르다", async () => {
  const derived = ["message.signature", "message.header.body_digest"];
  for (const fixture of fixtures.values()) {
    if (fixture.expect.ok) continue;
    const base = fixtures.get(fixture.base ?? "");
    expect(base?.expect.ok, `${fixture.name}의 기준`).toBe(true);
    expect((await verifyCase(base!)).ok).toBe(true);
    const pick = (f: Fixture) => ({ message: f.message, context: f.context, keys: f.keys });
    const diff = leafDiff(pick(base!), pick(fixture)).filter((path) => !derived.includes(path) || fixture.changed.includes(path));
    // 적어 둔 경로는 그 아래 잎 전체를 덮는다(배열을 통째로 바꾼 사례).
    const covers = (changed: string, path: string) => path === changed || path.startsWith(`${changed}.`) || path.startsWith(`${changed}[`);
    for (const path of diff) expect(fixture.changed.some((c) => covers(c, path)), `${fixture.name}: ${path}`).toBe(true);
    for (const changed of fixture.changed) expect(diff.some((path) => covers(changed, path)), `${fixture.name}: ${changed}`).toBe(true);
  }
});

test("fixture: 봉투 검증의 거절 사유마다 그것만 틀린 사례가 하나 이상 있다", () => {
  const counts = new Map<string, number>();
  for (const fixture of fixtures.values()) if (!fixture.expect.ok) counts.set(fixture.expect.reason, (counts.get(fixture.expect.reason) ?? 0) + 1);
  for (const reason of REJECT_REASONS) {
    if ((TRANSPORT_REASONS as readonly string[]).includes(reason)) continue;
    expect(counts.get(reason) ?? 0, reason).toBeGreaterThanOrEqual(1);
  }
});

test("fixture: 동작마다 통과 사례가 하나 있다", () => {
  const accepted = new Set([...fixtures.values()].filter((f) => f.expect.ok).map((f) => f.message.header.action));
  expect([...accepted].sort()).toEqual([...ACTIONS].sort());
});

test("fixture: 개인 키를 담지 않는다(공개 키는 32바이트 원시 값뿐)", async () => {
  for (const file of files) {
    const text = await readText(file);
    expect(text, file).not.toMatch(/PRIVATE KEY|"d"\s*:|privateKey|private_key/);
  }
  for (const fixture of fixtures.values()) {
    for (const raw of Object.values(fixture.keys)) expect(Buffer.from(raw, "base64url")).toHaveLength(32);
  }
});
