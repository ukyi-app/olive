import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
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
// 시험 소스의 이름(SECRET 등)과 네 글자도 겹치지 않게 지었다: 실패 출력의 코드 조각에 이름이 찍혀도 값의 조각으로 잡히지 않는다.
const SECRET = "QXJ-W8ZK-PV3-9Z";

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
// 이 단언이 실패해도 출력에 값이 실리지 않게, 포함 여부를 불리언으로 먼저 계산하고 실패 메시지와 차이에는 조각의 시작 위치만 둔다.
// 결과 객체를 통째로 비교하는 단언보다 먼저 부른다: 그쪽이 먼저 실패하면 값이 든 객체가 차이로 찍힌다.
// sample은 그 시험이 파일이나 포트에 넣은 표본이다. 표본마다 SECRET과 같은 규칙(대문자·숫자, 소스 이름과 겹치지 않음)으로 짓는다.
function expectNoSecret(answer: unknown, sample: string = SECRET): void {
  const text = JSON.stringify(answer) ?? "";
  const leakedAt: number[] = [];
  for (let i = 0; i + 4 <= sample.length; i += 1) if (text.includes(sample.slice(i, i + 4))) leakedAt.push(i);
  expect(leakedAt, "값의 네 글자 조각이 결과에 있다(배열은 조각의 시작 위치)").toEqual([]);
}

// 실제 구현이 연 파일 핸들의 read·close 호출 수를 센다. 구현은 연 핸들마다 finally에서 한 번 닫으므로 close 수가 연 횟수다.
async function countHandles<T>(run: () => Promise<T>): Promise<{ result: T; reads: number; closes: number }> {
  const dir = tempAccounts();
  writeFileSync(join(dir, "probe"), "x");
  const probe = await open(join(dir, "probe"), "r");
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const reads = spyOn(proto, "read");
  const closes = spyOn(proto, "close");
  try {
    const result = await run();
    return { result, reads: reads.mock.calls.length, closes: closes.mock.calls.length };
  } finally {
    reads.mockRestore();
    closes.mockRestore();
  }
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

describe("고른 계정의 폴더 안의 파일만 읽는다", () => {
  const choice = { account: "claude-sub", method: "subscription" };
  // 다른 계정의 자격. 이것의 지문이 claude-sub의 참조로 나가면 계정이 섞인 것이다.
  // SECRET과 네 글자도 겹치지 않는다. 소문자 이름(outside_account 등)과 겹치는 값이면 누출 검사가 정상 거절에서도 실패한다.
  const OTHER_TEXT = "7HDN-K4QW-2RT-XB";
  const OTHER = bytesOf(OTHER_TEXT);

  test("별칭이 같은 루트의 다른 계정 폴더를 가리키는 링크면 outside_account이고 파일을 열지 않는다", async () => {
    const dir = tempAccounts();
    mkdirSync(join(dir, "normal"));
    writeFileSync(join(dir, "normal", KEY), OTHER);
    symlinkSync("normal", join(dir, "claude-sub"));
    const seen = await countHandles(() => resolveCredentialRef(nodeCredentialFiles, policy(dir), choice));
    expectNoSecret(seen.result, OTHER_TEXT);
    expect(seen.result).toEqual({ ok: false, reason: "outside_account" });
    expect([seen.reads, seen.closes]).toEqual([0, 0]);
    expect(await credentialPort(nodeCredentialFiles, policy(dir)).reference(choice)).toEqual({ known: false });
  });

  test("별칭이 루트 밖의 실제 파일이 있는 폴더를 가리키는 링크면 outside_account이고 파일을 열지 않는다", async () => {
    const dir = tempAccounts();
    const outside = tempAccounts();
    writeFileSync(join(outside, KEY), OTHER);
    symlinkSync(outside, join(dir, "claude-sub"));
    const seen = await countHandles(() => resolveCredentialRef(nodeCredentialFiles, policy(dir), choice));
    expectNoSecret(seen.result, OTHER_TEXT);
    expect(seen.result).toEqual({ ok: false, reason: "outside_account" });
    expect([seen.reads, seen.closes]).toEqual([0, 0]);
  });

  test("키 파일이나 ..data의 링크가 계정 폴더 밖으로 나가면 outside_account이고 파일을 열지 않는다", async () => {
    // 키 → 같은 루트의 다른 계정 파일
    const dir = tempAccounts();
    mkdirSync(join(dir, "normal"));
    writeFileSync(join(dir, "normal", KEY), OTHER);
    mkdirSync(join(dir, "claude-sub"));
    symlinkSync(join("..", "normal", KEY), join(dir, "claude-sub", KEY));
    const viaKey = await countHandles(() => resolveCredentialRef(nodeCredentialFiles, policy(dir), choice));
    expectNoSecret(viaKey.result, OTHER_TEXT);
    expect(viaKey.result).toEqual({ ok: false, reason: "outside_account" });
    expect([viaKey.reads, viaKey.closes]).toEqual([0, 0]);

    // 키 → ..data/<키> 이지만 ..data가 루트 밖의 폴더를 가리킴
    const dir2 = tempAccounts();
    const outside = tempAccounts();
    writeFileSync(join(outside, KEY), OTHER);
    mkdirSync(join(dir2, "claude-sub"));
    symlinkSync(outside, join(dir2, "claude-sub", "..data"));
    symlinkSync(join("..data", KEY), join(dir2, "claude-sub", KEY));
    const viaData = await countHandles(() => resolveCredentialRef(nodeCredentialFiles, policy(dir2), choice));
    expectNoSecret(viaData.result, OTHER_TEXT);
    expect(viaData.result).toEqual({ ok: false, reason: "outside_account" });
    expect([viaData.reads, viaData.closes]).toEqual([0, 0]);
  });

  test("상한이 런타임의 배열 한도보다 커서 버퍼를 만들지 못해도 연 파일을 한 번 닫고 failed다", async () => {
    const dir = tempAccounts();
    mkdirSync(join(dir, "claude-sub"));
    writeFileSync(join(dir, "claude-sub", KEY), new Uint8Array(8).fill(0x41));
    // maxBytes + 1 길이의 배열은 만들 수 없어 바로 RangeError가 난다(실제로 큰 메모리를 잡지 않는다).
    const seen = await countHandles(() =>
      nodeCredentialFiles.read({ dir, account: "claude-sub", key: KEY }, Number.MAX_SAFE_INTEGER - 1).catch(() => ({ kind: "threw" })),
    );
    expect(seen.result).toEqual({ kind: "failed" });
    expect([seen.reads, seen.closes]).toEqual([0, 1]);
  });
});

describe("값은 결과·거절에 실리지 않는다", () => {
  test("성공한 참조는 네 칸뿐이고 값의 조각이 없으며, 받은 버퍼를 0으로 채운다", async () => {
    const bytes = bytesOf(SECRET);
    const answer = await resolveCredentialRef(fakeFiles(() => ({ kind: "bytes", bytes })), policy("/accounts"), { account: "claude-sub", method: "subscription" });
    expectNoSecret(answer);
    expect(answer.ok && Object.keys(answer.credential).sort()).toEqual(["account", "digest", "method", "revision"]);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  test("상한을 넘은 바이트를 돌려받아도 거절에 조각이 없고 버퍼를 0으로 채운다", async () => {
    const bytes = bytesOf(SECRET);
    const answer = await resolveCredentialRef(fakeFiles(() => ({ kind: "bytes", bytes })), policy("/accounts", { maxBytes: 4 }), {
      account: "claude-sub",
      method: "subscription",
    });
    expectNoSecret(answer);
    expect(answer).toEqual({ ok: false, reason: "too_large" });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  test("배정기 포트의 답에도 값이 없다", async () => {
    const port = credentialPort(fakeFiles(() => ({ kind: "bytes", bytes: bytesOf(SECRET) })), policy("/accounts"));
    const answer = await port.reference({ account: "claude-sub", method: "subscription" });
    expectNoSecret(answer);
    expect(answer.known).toBe(true);
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
      expectNoSecret(answer);
      expect(answer).toEqual({ ok: false, reason: "read_failed" });
    }
  });

  test("별칭이 꼴에 맞지 않거나 경로를 벗어나면 파일을 열지 않고 account_malformed", async () => {
    for (const account of ["../claude-sub", "claude-sub/../x", "..", ".", "a/b", "Claude", "", "x".repeat(33), 1, null, undefined]) {
      const files = fakeFiles(() => ({ kind: "bytes", bytes: bytesOf(SECRET) }));
      const answer = await resolveCredentialRef(files, policy("/accounts"), { account, method: "subscription" });
      expectNoSecret(answer);
      expect(answer).toEqual({ ok: false, reason: "account_malformed" });
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
      const answer = await resolveCredentialRef(files, given, { account: "claude-sub", method });
      expectNoSecret(answer);
      expect(answer).toEqual({ ok: false, reason } as never);
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
      expectNoSecret(answer);
      expect(answer).toEqual({ ok: false, reason: "revision_unknown" });
      expect(files.calls).toBe(0);
    }
  });

  test("거절 사유 목록은 위 사례가 쓰는 열한 가지다", () => {
    expect<string[]>([...CREDENTIAL_REF_REJECTIONS].sort()).toEqual(
      [
        "account_malformed",
        "empty",
        "method_not_configured",
        "method_unknown",
        "missing",
        "not_a_file",
        "outside_account",
        "policy_invalid",
        "read_failed",
        "revision_unknown",
        "too_large",
      ].sort(),
    );
  });
});
