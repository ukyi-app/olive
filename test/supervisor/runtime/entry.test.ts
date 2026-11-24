// 감독 진입점의 환경 → 값(settingsFromEnv). 이름마다 없음·틀림이 첫 걸린 이름 하나로 돌아오고(값은 싣지 않는다), 다 있으면 경로와
// 등록표 설정을 그대로 옮긴다. 진입점을 실제로 띄워 91로 끝나는 것은 test/entrypoints.test.ts가 본다.
import { expect, test } from "bun:test";
import { SUPERVISOR_ENV, settingsFromEnv } from "../../../src/main/supervisor.ts";
import { readText } from "../../files.ts";

const FULL: Record<(typeof SUPERVISOR_ENV)[number], string> = {
  OLIVE_SUPERVISOR_PORT: "8443",
  OLIVE_LEDGER_DIR: "/var/lib/olive",
  OLIVE_SIGNING_KEY_DIR: "/etc/olive/signing",
  OLIVE_ACCOUNTS_DIR: "/etc/olive/accounts",
  OLIVE_TLS_DIR: "/etc/olive/tls",
  OLIVE_TRUST_DIR: "/etc/olive/trust",
  OLIVE_REGISTRY_FILE: "/etc/olive/registry/registry.json",
  OLIVE_ENVIRONMENT: "home",
  OLIVE_TARGETS: JSON.stringify([{ target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] }]),
  OLIVE_POLICY_REVISION: "policy-1",
  OLIVE_RESULT_DIR: "/var/lib/olive/results",
};

test("환경이 모두 있으면 경로·등록표 설정·정책 revision을 옮기고, 장부는 reopen 자리 하나다", () => {
  const parsed = settingsFromEnv(FULL);
  if (!parsed.ok) throw new Error(`${parsed.name} ${parsed.problem}`);
  const s = parsed.settings;
  expect(s.listen).toEqual({ host: "0.0.0.0", port: 8443 });
  expect(s.files).toEqual({
    certificate: "/etc/olive/tls/tls.crt",
    privateKey: "/etc/olive/tls/tls.key",
    trustBundle: "/etc/olive/trust/ca-bundle.pem",
    signingKey: "/etc/olive/signing/supervisor-signing.key",
    registry: "/etc/olive/registry/registry.json",
  });
  expect(s.ledgerPath).toBe("/var/lib/olive/supervisor.db");
  expect(s.resultDir).toBe("/var/lib/olive/results");
  expect(s.registry).toEqual({ environment: "home", targets: [{ target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] }] });
  expect(s.expectedPolicyRevision).toBe("policy-1");
  expect(s.otherPeers).toEqual(["front-door", "observation-relay"]);
  expect(s.credentials.dir).toBe("/etc/olive/accounts");
  expect(s.credentials.maxBytes).toBeLessThanOrEqual(16_384);
  // 배정은 닫힌 값이다: 등록행·계정·실행 계획이 없다.
  expect([s.assign.assignment.registrations.length, s.assign.accounts.length, s.assign.plans.length]).toEqual([0, 0, 0]);
});

test("환경 이름마다 비면 그 이름 하나로 missing이다(차례대로 첫 이름)", () => {
  for (const name of SUPERVISOR_ENV) {
    expect(settingsFromEnv({ ...FULL, [name]: "" })).toEqual({ ok: false, name, problem: "missing" });
    const { [name]: _, ...rest } = FULL;
    expect(settingsFromEnv(rest)).toEqual({ ok: false, name, problem: "missing" });
  }
  expect(settingsFromEnv({})).toEqual({ ok: false, name: "OLIVE_SUPERVISOR_PORT", problem: "missing" });
});

test("꼴이 틀리면 그 이름으로 invalid다(포트 범위, 상대 경로, 등록표 설정, revision)", () => {
  const cases: [string, string, string][] = [
    ["OLIVE_SUPERVISOR_PORT", "0", "OLIVE_SUPERVISOR_PORT"],
    ["OLIVE_SUPERVISOR_PORT", "65536", "OLIVE_SUPERVISOR_PORT"],
    ["OLIVE_SUPERVISOR_PORT", "84a3", "OLIVE_SUPERVISOR_PORT"],
    ["OLIVE_LEDGER_DIR", "var/lib/olive", "OLIVE_LEDGER_DIR"],
    ["OLIVE_RESULT_DIR", "results", "OLIVE_RESULT_DIR"],
    ["OLIVE_REGISTRY_FILE", "registry.json", "OLIVE_REGISTRY_FILE"],
    ["OLIVE_TARGETS", "not json", "OLIVE_TARGETS"],
    ["OLIVE_TARGETS", JSON.stringify([{ target: "reader", namespace: "olive-reader", roles: ["no_such_role"] }]), "OLIVE_TARGETS"],
    ["OLIVE_POLICY_REVISION", "-bad", "OLIVE_POLICY_REVISION"],
  ];
  for (const [name, value, expected] of cases) {
    expect([name, value, settingsFromEnv({ ...FULL, [name]: value })]).toEqual([name, value, { ok: false, name: expected, problem: "invalid" }]);
  }
});

test("README의 감독 환경 표는 진입점이 읽는 이름과 같은 차례다", async () => {
  const readme = await readText("README.md");
  const section = readme.slice(readme.indexOf("## 감독 진입점"), readme.indexOf("## 공개 저장소"));
  const names = [...section.matchAll(/^\| `(OLIVE_[A-Z_]+)` \|/gm)].map((m) => m[1]);
  expect(names).toEqual([...SUPERVISOR_ENV]);
});
