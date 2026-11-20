// 고른 계정의 자격 파일을 읽어 그 자격을 가리키는 참조(계약 v1의 credential: account·method·revision·digest)를 만든다.
// 값은 참조에도 거절에도 싣지 않는다. 값을 실행기에 나르는 일은 이 모듈이 아니다.
// 파일 읽기는 주입받은 포트로만 한다. 실제 파일을 여는 코드는 아래 nodeCredentialFiles 하나뿐이다.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialRef } from "../../ledger/index.ts";
import type { CredentialPort } from "../dispatch/ports.ts";
import { AUTH_METHODS, type AuthMethod } from "../roles/policy.ts";
import { REVISION } from "../roles/assign.ts";
import { ACCOUNT_NAME } from "./fixed.ts";

// 계정 폴더 안의 파일 하나를 읽는 포트. 경로를 잇는 일과 파일 시스템 오류의 분류는 구현이 한다.
// maxBytes를 넘으면 그 바이트를 돌려주지 않고 too_large다. 돌려준 bytes는 부른 쪽이 지문을 낸 뒤 0으로 채운다.
export type CredentialRead =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "missing" }
  | { readonly kind: "not_a_file" }
  | { readonly kind: "too_large" }
  | { readonly kind: "failed" };

export interface CredentialFiles {
  read(location: { readonly dir: string; readonly account: string; readonly key: string }, maxBytes: number): Promise<CredentialRead>;
}

export interface CredentialRefPolicy {
  // 계정 폴더. 하위에 <별칭>/<키 이름> 파일이 있다. 컨테이너 안의 경로는 배포가 정하므로 여기 박지 않는다.
  readonly dir: string;
  // 방식마다 읽을 파일(키) 이름. 없는 방식은 method_not_configured로 닫는다.
  readonly keys: Readonly<Partial<Record<AuthMethod, string>>>;
  // 자격 값의 바이트 상한. 계약·설계에 정한 값이 없어 부르는 쪽이 정한다.
  readonly maxBytes: number;
  // 그 계정·방식의 자격 revision. 파일 내용에서 만들지 않는다(근거는 credential-ref.md "revision"). 모르면 null.
  readonly revisionOf: (account: string, method: AuthMethod) => string | null;
}

export const CREDENTIAL_REF_REJECTIONS = [
  "policy_invalid",
  "account_malformed",
  "method_unknown",
  "method_not_configured",
  "revision_unknown",
  "missing",
  "not_a_file",
  "read_failed",
  "empty",
  "too_large",
] as const;
export type CredentialRefRejection = (typeof CREDENTIAL_REF_REJECTIONS)[number];

export type CredentialRefAnswer =
  | { readonly ok: true; readonly credential: CredentialRef }
  | { readonly ok: false; readonly reason: CredentialRefRejection };

// Secret 볼륨의 키 이름 꼴(환경 변수 이름과 같은 모양). 슬래시·점이 없어 계정 폴더 밖이나 kubelet의 ..data 같은 숨은 항목을 가리키지 못한다.
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function refuse(reason: CredentialRefRejection): CredentialRefAnswer {
  return { ok: false, reason };
}

function validPolicy(policy: CredentialRefPolicy): boolean {
  if (typeof policy !== "object" || policy === null) return false;
  const { dir, maxBytes, keys, revisionOf } = policy;
  if (typeof dir !== "string" || !dir.startsWith("/") || dir.includes("\0")) return false;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return false;
  if (typeof keys !== "object" || keys === null || typeof revisionOf !== "function") return false;
  return true;
}

// 계정 하나의 자격 참조를 만든다. 던지지 않는다: 모든 실패는 구별된 거절이다.
// 순서: 정책 → 별칭 → 방식 → 키 → revision → 읽기 → 지문. revision을 모르면 파일을 열지 않는다(쓰지 못할 값을 메모리에 올리지 않는다).
export async function resolveCredentialRef(
  files: CredentialFiles,
  policy: CredentialRefPolicy,
  choice: { readonly account: unknown; readonly method: unknown },
): Promise<CredentialRefAnswer> {
  if (!validPolicy(policy)) return refuse("policy_invalid");
  const account = choice?.account;
  if (typeof account !== "string" || !ACCOUNT_NAME.test(account)) return refuse("account_malformed");
  const method = choice.method;
  if (!(AUTH_METHODS as readonly unknown[]).includes(method)) return refuse("method_unknown");
  const authMethod = method as AuthMethod;
  // keys는 평범한 객체라 상속된 이름을 막으려고 자기 칸만 본다.
  const key = Object.hasOwn(policy.keys, authMethod) ? policy.keys[authMethod] : undefined;
  if (key === undefined) return refuse("method_not_configured");
  if (typeof key !== "string" || !KEY_NAME.test(key)) return refuse("policy_invalid");

  let revision: unknown;
  try {
    revision = policy.revisionOf(account, authMethod);
  } catch {
    return refuse("revision_unknown");
  }
  if (typeof revision !== "string" || !REVISION.test(revision)) return refuse("revision_unknown");

  let read: CredentialRead;
  try {
    read = await files.read({ dir: policy.dir, account, key }, policy.maxBytes);
  } catch {
    return refuse("read_failed");
  }
  if (read?.kind === "missing") return refuse("missing");
  if (read?.kind === "not_a_file") return refuse("not_a_file");
  if (read?.kind === "too_large") return refuse("too_large");
  if (read?.kind !== "bytes" || !(read.bytes instanceof Uint8Array)) return refuse("read_failed");

  const bytes = read.bytes;
  try {
    if (bytes.length === 0) return refuse("empty");
    // 포트가 상한을 지키지 않아도 여기서 다시 닫는다.
    if (bytes.length > policy.maxBytes) return refuse("too_large");
    // 읽은 바이트를 그대로 해시한다. 문자열로 바꾸거나 줄바꿈·공백·BOM을 다듬으면 실행기가 받은 바이트로 낸 지문
    // (src/executor/profile.ts의 credentialMatches)과 달라져 정상 작업이 시작되지 못한다.
    const digest = createHash("sha256").update(bytes).digest("hex");
    return { ok: true, credential: Object.freeze({ account, method: authMethod, revision, digest }) };
  } finally {
    // 이 버퍼의 바이트만 지운다. 커널의 페이지 캐시, 포트 구현 안의 다른 사본, 해시 객체 내부 상태는 이 줄이 지우지 못한다.
    bytes.fill(0);
  }
}

// 배정기의 CredentialPort 꼴로 감싼다. 그 꼴에는 거절 사유 칸이 없어 모든 거절이 known: false 하나로 접힌다.
export function credentialPort(files: CredentialFiles, policy: CredentialRefPolicy): CredentialPort {
  return {
    async reference(choice) {
      const answer = await resolveCredentialRef(files, policy, choice);
      return answer.ok ? { known: true, credential: answer.credential } : { known: false };
    },
  };
}

// 실제 파일을 읽는 얇은 구현. 이 모듈에서 파일 시스템을 부르는 곳은 여기뿐이다.
// - 심볼릭 링크는 따라간다: Kubernetes Secret 볼륨의 키 파일은 ..data/<키>를 가리키는 링크다. 별칭과 키의 꼴이 이미 슬래시·점을 막는다.
// - O_NONBLOCK으로 연다: 그 자리에 FIFO가 있으면 쓰는 쪽이 올 때까지 open이 멈추기 때문이다. 일반 파일에는 영향이 없다.
// - 크기는 fstat 값을 믿지 않고 maxBytes + 1바이트까지 실제로 읽어 본다(읽는 사이 파일이 바뀔 수 있다).
export const nodeCredentialFiles: CredentialFiles = {
  async read(location, maxBytes) {
    const path = join(location.dir, location.account, location.key);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "failed" };
    }
    const buffer = new Uint8Array(maxBytes + 1);
    try {
      if (!(await handle.stat()).isFile()) return { kind: "not_a_file" };
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes) {
        buffer.fill(0);
        return { kind: "too_large" };
      }
      // 사본을 만들지 않고 같은 버퍼의 앞부분을 넘긴다. 부른 쪽이 그 부분을 0으로 채운다.
      return { kind: "bytes", bytes: buffer.subarray(0, length) };
    } catch {
      buffer.fill(0);
      return { kind: "failed" };
    } finally {
      await handle.close().catch(() => undefined);
    }
  },
};
