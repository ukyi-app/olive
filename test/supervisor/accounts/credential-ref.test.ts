import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialMatches } from "../../../src/executor/profile.ts";
import { credentialRef as ledgerCredentialRef } from "../../../src/ledger/input.ts";
import { readText } from "../../files.ts";
import {
  CREDENTIAL_REF_REJECTIONS,
  type CredentialFiles,
  type CredentialRead,
  type CredentialRefPolicy,
  credentialPort,
  nodeCredentialFiles,
  resolveCredentialRef,
} from "../../../src/supervisor/accounts/credential-ref.ts";

const KEY = "CLAUDE_CODE_OAUTH_TOKEN";
// BOM, 비ASCII, CRLF를 함께 둔다. 문자열로 바꾸거나 줄바꿈·BOM을 다듬으면 지문이 달라지는 표본이다.
const SAMPLE = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("tok-α\r\n")]);
// printf '\xef\xbb\xbftok-\xce\xb1\r\n' | sha256sum
const SAMPLE_DIGEST = "e5d4c5f0606822cb75621a4bdfeef3390f68baa195bbc34ea94e880f005845f3";
// 소문자 16진·별칭·방식·revision 어디에도 나올 수 없는 대문자 값이라, 결과에 조각이 섞이면 바로 보인다.
const SECRET = "QXJ-SECRET-VALUE-9Z";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function tempAccounts(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "olive-accounts-"));
  roots.push(dir);
  return dir;
}

function policy(dir: string, extra: Partial<CredentialRefPolicy> = {}): CredentialRefPolicy {
  return { dir, keys: { subscription: KEY }, maxBytes: 64, revisionOf: () => "r1", ...extra };
}

function fakeFiles(answer: () => CredentialRead | Promise<CredentialRead>): CredentialFiles & { calls: number } {
  const files = {
    calls: 0,
    async read() {
      files.calls += 1;
      return answer();
    },
  };
  return files;
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// 결과를 JSON으로 펼쳐 값 전체와 네 글자 조각이 하나도 없는지 본다.
function expectNoSecret(answer: unknown): void {
  const text = JSON.stringify(answer);
  expect(text.includes(SECRET)).toBe(false);
  for (let i = 0; i + 4 <= SECRET.length; i += 1) expect(text.includes(SECRET.slice(i, i + 4)), SECRET.slice(i, i + 4)).toBe(false);
}

describe("지문은 정확한 바이트로", () => {
  test("파일의 바이트 그대로 SHA-256을 내고, 실행기의 대조 함수가 같은 바이트를 받아들인다", async () => {
    const dir = tempAccounts();
    mkdirSync(join(dir, "claude-sub"));
    writeFileSync(join(dir, "claude-sub", KEY), SAMPLE);
    const answer = await resolveCredentialRef(nodeCredentialFiles, policy(dir), { account: "claude-sub", method: "subscription" });
    expect(answer).toEqual({ ok: true, credential: { account: "claude-sub", method: "subscription", revision: "r1", digest: SAMPLE_DIGEST } });
    if (!answer.ok) throw new Error("unreachable");
    expect(credentialMatches(SAMPLE, answer.credential.digest)).toBe(true);
    // 줄바꿈만 다른 바이트는 다른 자격이다.
    expect(credentialMatches(SAMPLE.subarray(0, SAMPLE.length - 2), answer.credential.digest)).toBe(false);
    // 장부와 계약이 받는 네 칸의 꼴 그대로다.
    expect(ledgerCredentialRef(answer.credential, "credential")).toEqual(answer.credential);
  });

  test("Secret 볼륨처럼 링크를 거친 파일도 링크가 가리키는 바이트로 지문을 낸다", async () => {
    const dir = tempAccounts();
    const data = join(dir, "claude-sub", "..2026_11_20_00_00_00.000000001");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, KEY), SAMPLE);
    symlinkSync("..2026_11_20_00_00_00.000000001", join(dir, "claude-sub", "..data"));
    symlinkSync(join("..data", KEY), join(dir, "claude-sub", KEY));
    const answer = await resolveCredentialRef(nodeCredentialFiles, policy(dir), { account: "claude-sub", method: "subscription" });
    expect(answer.ok && answer.credential.digest).toBe(SAMPLE_DIGEST);
  });
});

describe("값은 결과·거절에 실리지 않는다", () => {
  test("성공한 참조는 네 칸뿐이고 값의 조각이 없으며, 받은 버퍼를 0으로 채운다", async () => {
    const bytes = bytesOf(SECRET);
    const answer = await resolveCredentialRef(fakeFiles(() => ({ kind: "bytes", bytes })), policy("/accounts"), { account: "claude-sub", method: "subscription" });
    expect(answer.ok && Object.keys(answer.credential).sort()).toEqual(["account", "digest", "method", "revision"]);
    expectNoSecret(answer);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  test("상한을 넘은 바이트를 돌려받아도 거절에 조각이 없고 버퍼를 0으로 채운다", async () => {
    const bytes = bytesOf(SECRET);
    const answer = await resolveCredentialRef(fakeFiles(() => ({ kind: "bytes", bytes })), policy("/accounts", { maxBytes: 4 }), {
      account: "claude-sub",
      method: "subscription",
    });
    expect(answer).toEqual({ ok: false, reason: "too_large" });
    expectNoSecret(answer);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  test("배정기 포트의 답에도 값이 없다", async () => {
    const port = credentialPort(fakeFiles(() => ({ kind: "bytes", bytes: bytesOf(SECRET) })), policy("/accounts"));
    const answer = await port.reference({ account: "claude-sub", method: "subscription" });
    expect(answer.known).toBe(true);
    expectNoSecret(answer);
    expect(await credentialPort(fakeFiles(() => ({ kind: "missing" })), policy("/accounts")).reference({ account: "claude-sub", method: "subscription" })).toEqual({
      known: false,
    });
  });

  test("모듈은 로그를 남기지 않고, 파일 시스템은 실제 구현 한 자리에서만 연다", async () => {
    const source = await readText("src/supervisor/accounts/credential-ref.ts");
    expect(/\bconsole\.|process\.(stdout|stderr|env)/.test(source)).toBe(false);
    expect(source.match(/\bopen\(/g)?.length).toBe(1);
  });
});

describe("모르면 닫는다", () => {
  const choice = { account: "claude-sub", method: "subscription" };

  test("실제 파일: 없음·빈 파일·상한 초과·폴더는 각각 구별된 거절이다", async () => {
    const dir = tempAccounts();
    mkdirSync(join(dir, "claude-sub"));
    expect(await resolveCredentialRef(nodeCredentialFiles, policy(dir), choice)).toEqual({ ok: false, reason: "missing" });
    expect(await resolveCredentialRef(nodeCredentialFiles, policy(dir), { account: "nobody", method: "subscription" })).toEqual({ ok: false, reason: "missing" });
    writeFileSync(join(dir, "claude-sub", KEY), new Uint8Array(0));
    expect(await resolveCredentialRef(nodeCredentialFiles, policy(dir), choice)).toEqual({ ok: false, reason: "empty" });
    writeFileSync(join(dir, "claude-sub", KEY), new Uint8Array(65).fill(0x41));
    expect(await resolveCredentialRef(nodeCredentialFiles, policy(dir), choice)).toEqual({ ok: false, reason: "too_large" });
    writeFileSync(join(dir, "claude-sub", KEY), new Uint8Array(64).fill(0x41));
    expect((await resolveCredentialRef(nodeCredentialFiles, policy(dir), choice)).ok).toBe(true);
    mkdirSync(join(dir, "claude-sub", "OTHER_KEY"));
    expect(await resolveCredentialRef(nodeCredentialFiles, policy(dir, { keys: { subscription: "OTHER_KEY" } }), choice)).toEqual({
      ok: false,
      reason: "not_a_file",
    });
  });

  test("읽기 실패와 던지는 포트는 read_failed이고 빈 값의 지문을 내지 않는다", async () => {
    for (const files of [fakeFiles(() => ({ kind: "failed" })), fakeFiles(() => Promise.reject(new Error(SECRET))), fakeFiles(() => ({ kind: "odd" }) as never)]) {
      const answer = await resolveCredentialRef(files, policy("/accounts"), choice);
      expect(answer).toEqual({ ok: false, reason: "read_failed" });
      expectNoSecret(answer);
    }
  });

  test("별칭이 꼴에 맞지 않거나 경로를 벗어나면 파일을 열지 않고 account_malformed", async () => {
    for (const account of ["../claude-sub", "claude-sub/../x", "..", ".", "a/b", "Claude", "", "x".repeat(33), 1, null, undefined]) {
      const files = fakeFiles(() => ({ kind: "bytes", bytes: bytesOf(SECRET) }));
      expect(await resolveCredentialRef(files, policy("/accounts"), { account, method: "subscription" })).toEqual({ ok: false, reason: "account_malformed" });
      expect(files.calls).toBe(0);
    }
  });

  test("방식·키·정책이 틀리면 각각 구별된 거절이고 파일을 열지 않는다", async () => {
    const cases: [CredentialRefPolicy, unknown, string][] = [
      [policy("/accounts"), "oauth", "method_unknown"],
      [policy("/accounts"), "constructor", "method_unknown"],
      [policy("/accounts"), "api_key", "method_not_configured"],
      [policy("/accounts", { keys: { subscription: "../KEY" } }), "subscription", "policy_invalid"],
      [policy("/accounts", { keys: { subscription: "..data" } }), "subscription", "policy_invalid"],
      [policy("relative"), "subscription", "policy_invalid"],
      [policy("/accounts", { maxBytes: 0 }), "subscription", "policy_invalid"],
      [policy("/accounts", { maxBytes: 1.5 }), "subscription", "policy_invalid"],
    ];
    for (const [given, method, reason] of cases) {
      const files = fakeFiles(() => ({ kind: "bytes", bytes: bytesOf(SECRET) }));
      expect(await resolveCredentialRef(files, given, { account: "claude-sub", method })).toEqual({ ok: false, reason } as never);
      expect(files.calls).toBe(0);
    }
  });

  test("revision을 모르거나 꼴이 틀리거나 묻다가 던지면 revision_unknown이고 파일을 열지 않는다", async () => {
    const revisions: CredentialRefPolicy["revisionOf"][] = [
      () => null,
      () => "",
      () => "bad revision",
      () => 7 as never,
      () => {
        throw new Error(SECRET);
      },
    ];
    for (const revisionOf of revisions) {
      const files = fakeFiles(() => ({ kind: "bytes", bytes: bytesOf(SECRET) }));
      const answer = await resolveCredentialRef(files, policy("/accounts", { revisionOf }), choice);
      expect(answer).toEqual({ ok: false, reason: "revision_unknown" });
      expect(files.calls).toBe(0);
    }
  });

  test("거절 사유 목록은 위 사례가 쓰는 열 가지다", () => {
    expect<string[]>([...CREDENTIAL_REF_REJECTIONS].sort()).toEqual(
      ["account_malformed", "empty", "method_not_configured", "method_unknown", "missing", "not_a_file", "policy_invalid", "read_failed", "revision_unknown", "too_large"].sort(),
    );
  });
});
