import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  borrowCredentialValue,
  CREDENTIAL_BORROW_REFUSALS,
  type CredentialBorrow,
  type CredentialFiles,
  type CredentialRead,
  type CredentialRefPolicy,
  nodeCredentialFiles,
} from "../../../src/supervisor/accounts/credential-ref.ts";

const KEY = "CLAUDE_CODE_OAUTH_TOKEN";
// 시험이 지어낸 값. 새는지는 불리언으로만 단언한다.
const SAMPLE = "VW8R-KQ3Z-PL5M-XT9H";
const sampleBytes = () => new TextEncoder().encode(SAMPLE);
const DIGEST = createHash("sha256").update(sampleBytes()).digest("hex");
const REF = { account: "main", method: "subscription", digest: DIGEST };
const policy = (dir: string, over: Partial<CredentialRefPolicy> = {}): CredentialRefPolicy => ({
  dir,
  keys: { subscription: KEY },
  maxBytes: 1024,
  revisionOf: () => "rev-1",
  ...over,
});
const allZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);
// 거절의 이름만 꺼낸다. 결과를 통째로 견주면 성공 결과의 값 버퍼가 실패 진단에 찍히므로, 성공이나 다른 칸이 있으면 표식을 낸다.
const refusalOf = (result: CredentialBorrow): string =>
  result.ok === false && Object.keys(result).sort().join(",") === "ok,reason" ? result.reason : "<not_a_bare_refusal>";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
function accountsDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "olive-borrow-")));
  roots.push(dir);
  return dir;
}

function fake(answer: () => CredentialRead) {
  const calls: { location: unknown; maxBytes: number }[] = [];
  const files: CredentialFiles = {
    async read(location, maxBytes) {
      calls.push({ location, maxBytes });
      return answer();
    },
  };
  return { files, calls };
}

describe("borrowCredentialValue", () => {
  test("실제 파일: 지문이 같으면 그 바이트를 빌려준다(정책의 maxBytes로 읽는다)", async () => {
    const dir = accountsDir();
    mkdirSync(join(dir, "main"));
    writeFileSync(join(dir, "main", KEY), sampleBytes());
    const borrowed = await borrowCredentialValue(nodeCredentialFiles, policy(dir), REF);
    expect(borrowed.ok).toBe(true);
    if (!borrowed.ok) return;
    expect(new TextDecoder().decode(borrowed.value) === SAMPLE).toBe(true);
    borrowed.value.fill(0);
  });

  test("실제 파일: 다른 계정 폴더로 이어진 링크는 지문이 같아도 빌려주지 않는다", async () => {
    const dir = accountsDir();
    mkdirSync(join(dir, "other"));
    writeFileSync(join(dir, "other", KEY), sampleBytes());
    symlinkSync(join(dir, "other"), join(dir, "main"));
    expect(refusalOf(await borrowCredentialValue(nodeCredentialFiles, policy(dir), REF))).toBe("outside_account");
  });

  test("지문이 다르면 거절하고 읽은 버퍼를 0으로 채운다", async () => {
    const bytes = sampleBytes();
    const port = fake(() => ({ kind: "bytes", bytes }));
    const result = await borrowCredentialValue(port.files, policy("/accounts"), { ...REF, digest: "f".repeat(64) });
    expect(result.ok === false).toBe(true);
    expect(refusalOf(result)).toBe("digest_mismatch");
    expect(allZero(bytes)).toBe(true);
    expect(JSON.stringify(result).includes(SAMPLE)).toBe(false);
  });

  test("상한: 정책의 maxBytes로 읽고, 포트가 상한을 어긴 바이트도 거절하며 0으로 채운다", async () => {
    const big = new Uint8Array(1025).fill(0x41);
    const port = fake(() => ({ kind: "bytes", bytes: big }));
    expect(refusalOf(await borrowCredentialValue(port.files, policy("/accounts"), REF))).toBe("too_large");
    expect(port.calls.map((c) => c.maxBytes)).toEqual([1024]);
    expect(allZero(big)).toBe(true);
  });

  test("정책의 maxBytes가 값 틀 상한(16,384)보다 크면 읽지 않는다. 정각은 받는다", async () => {
    const over = fake(() => ({ kind: "bytes", bytes: sampleBytes() }));
    expect(refusalOf(await borrowCredentialValue(over.files, policy("/accounts", { maxBytes: 16_385 }), REF))).toBe("limit_above_frame");
    expect(over.calls.length).toBe(0);
    const exact = fake(() => ({ kind: "bytes", bytes: sampleBytes() }));
    expect((await borrowCredentialValue(exact.files, policy("/accounts", { maxBytes: 16_384 }), REF)).ok).toBe(true);
  });

  test("참조·정책의 꼴이 틀리면 읽지 않는다. 포트가 던져도 던지지 않는다", async () => {
    const port = fake(() => ({ kind: "bytes", bytes: sampleBytes() }));
    const cases: [Parameters<typeof borrowCredentialValue>[2], CredentialRefPolicy, string][] = [
      [{ ...REF, account: "../x" }, policy("/accounts"), "account_malformed"],
      [{ ...REF, method: "password" }, policy("/accounts"), "method_unknown"],
      [{ ...REF, method: "api_key" }, policy("/accounts"), "method_not_configured"],
      [{ ...REF, digest: DIGEST.toUpperCase() }, policy("/accounts"), "digest_malformed"],
      [REF, policy("relative"), "policy_invalid"],
    ];
    for (const [ref, given, reason] of cases) expect(refusalOf(await borrowCredentialValue(port.files, given, ref))).toBe(reason);
    expect(port.calls.length).toBe(0);
    const throwing = fake(() => {
      throw new Error(`port failed ${SAMPLE}`);
    });
    const result = await borrowCredentialValue(throwing.files, policy("/accounts"), REF);
    expect(refusalOf(result)).toBe("read_failed");
    expect(JSON.stringify(result).includes(SAMPLE)).toBe(false);
  });

  test("포트 답의 kind·bytes 접근자가 표본을 담아 던져도 read_failed이고 결과·거절에 표본이 없다", async () => {
    for (const field of ["kind", "bytes"] as const) {
      const answer = { kind: "bytes", bytes: sampleBytes() } as Record<string, unknown>;
      Object.defineProperty(answer, field, {
        get() {
          throw new Error(`answer broken near ${SAMPLE}`);
        },
      });
      const port = fake(() => answer as unknown as CredentialRead);
      const settled = await borrowCredentialValue(port.files, policy("/accounts"), REF).then(
        (result) => ({ resolved: true, result, text: JSON.stringify(result) }),
        (error: unknown) => ({ resolved: false, result: null, text: String((error as Error)?.message ?? error) }),
      );
      expect(settled.resolved).toBe(true);
      expect(settled.text.includes(SAMPLE)).toBe(false);
      expect(settled.result !== null && refusalOf(settled.result)).toBe("read_failed");
    }
  });

  test("거절 이름은 목록 안이다", () => {
    expect(new Set(CREDENTIAL_BORROW_REFUSALS).size).toBe(CREDENTIAL_BORROW_REFUSALS.length);
    expect(CREDENTIAL_BORROW_REFUSALS).toContain("digest_mismatch");
    expect(CREDENTIAL_BORROW_REFUSALS).toContain("limit_above_frame");
  });
});
