// 역할 프로필과 띄우기 전 마지막 검사. 실행기는 프로필에 고정된 프로그램·argv·작업 폴더·환경 이름으로만 띄운다.
// 지시에서 명령·이미지·볼륨·argv·환경을 받지 않으므로 이 파일은 계약의 지시 타입을 import하지 않는다.
// 환경은 프로필에서 새로 만든다. 실행기 자신의 환경(process.env)을 읽거나 물려주지 않는다.
import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Role } from "../contract/v1/index.ts";

export interface RoleProfile {
  readonly role: Role;
  // hello와 task_start의 profile_revision과 대조하는 값.
  readonly revision: string;
  // 절대 경로. PATH로 찾지 않는다.
  readonly program: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  // 자격 밖의 고정 환경(이름 → 값). 띄운 프로그램이 받는 환경은 이것과 credentialEnv 하나뿐이다.
  readonly env: Readonly<Record<string, string>>;
  // 그 실행의 자격 값을 넣는 환경 이름 하나.
  readonly credentialEnv: string;
}

export class ProfileError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// 띄우기를 거절한 사유. 값(자격, 환경 값)은 담지 않는다.
export class LaunchRefused extends Error {
  constructor(readonly code: "env_not_allowed" | "credential_env_missing" | "credential_in_argv" | "credential_in_env" | "credential_unusable") {
    super(code);
  }
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const hasNul = (text: string) => text.includes("\0");

// 프로필을 검사하고 얼린다. 실행기가 뜰 때 한 번 부른다. 잘못된 프로필이면 실행기가 뜨지 않는다.
export function fixProfile(profile: RoleProfile): RoleProfile {
  if (!isAbsolute(profile.program) || !isAbsolute(profile.cwd)) throw new ProfileError("path_not_absolute");
  if ([profile.program, profile.cwd, ...profile.argv].some(hasNul)) throw new ProfileError("nul_in_profile");
  if (!ENV_NAME.test(profile.credentialEnv)) throw new ProfileError("credential_env_invalid");
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(profile.env)) {
    if (!ENV_NAME.test(name) || name === profile.credentialEnv || typeof value !== "string" || hasNul(value)) throw new ProfileError("env_invalid");
    env[name] = value;
  }
  return Object.freeze({
    role: profile.role,
    revision: profile.revision,
    program: profile.program,
    argv: Object.freeze([...profile.argv]),
    cwd: profile.cwd,
    env: Object.freeze(env),
    credentialEnv: profile.credentialEnv,
  });
}

// 자격 값은 지시에 없다. 그 실행의 값을 내어 주는 곳이 따로 있다(같은 연결의 자격 값 틀을 받는 우편함, credential-inbox.ts).
// 실행기는 받은 바이트의 SHA-256이 지시의 credential.digest와 같을 때만 쓴다.
export interface CredentialSource {
  // 없으면 null. 돌려준 바이트를 그대로 대조하고 쓴다(인코딩·줄바꿈을 바꾸지 않는다).
  // signal이 중단되면 요청을 거둔다. 실행기는 중단 뒤 늦게 온 값을 쓰지 않는다.
  take(runId: string, digest: string, signal: AbortSignal): Promise<Uint8Array | null>;
  // 그 실행이 끝났다(띄웠든 아니든). 그 실행을 위해 쥔 값을 버리고 0으로 채운다. 실행기는 실행이 끝날 때마다 한 번 부른다.
  // 선택인 까닭: 값을 쥐지 않는 구현(시험의 가짜 등)은 할 일이 없다.
  forget?(runId: string): void;
}

// 정확한 바이트로 digest를 대조한다. digest 칸은 계약이 소문자 16진 64자로 묶는다.
export function credentialMatches(value: Uint8Array, digest: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(digest)) return false;
  const actual = createHash("sha256").update(value).digest();
  return timingSafeEqual(actual, Buffer.from(digest, "hex"));
}

// 환경 값은 글이라 바이트가 UTF-8로 그대로 오가야 같은 자격이다. 깨진 UTF-8, NUL, 빈 값이면 쓰지 않는다.
export function credentialText(value: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    return null;
  }
  if (text.length === 0 || hasNul(text)) return null;
  const back = new TextEncoder().encode(text);
  return back.length === value.length && back.every((byte, i) => byte === value[i]) ? text : null;
}

export interface LaunchPlan {
  readonly program: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

// 띄울 계획은 프로필과 자격 값으로만 만든다.
export function launchPlan(profile: RoleProfile, credential: string): LaunchPlan {
  const env: Record<string, string> = { ...profile.env, [profile.credentialEnv]: credential };
  return { program: profile.program, argv: [...profile.argv], cwd: profile.cwd, env };
}

// 띄우기 직전의 검사. 환경 이름은 프로필의 이름과 자격 이름 하나뿐이고, 자격 값은 그 이름 하나에만 있어야 한다.
export function assertLaunchSafe(profile: RoleProfile, plan: LaunchPlan, credential: string): void {
  if (credential.length === 0) throw new LaunchRefused("credential_unusable");
  const allowed = new Set([...Object.keys(profile.env), profile.credentialEnv]);
  const names = Object.keys(plan.env);
  if (names.length !== allowed.size || names.some((name) => !allowed.has(name))) throw new LaunchRefused("env_not_allowed");
  if (plan.env[profile.credentialEnv] !== credential) throw new LaunchRefused("credential_env_missing");
  if ([plan.program, plan.cwd, ...plan.argv].some((part) => part.includes(credential))) throw new LaunchRefused("credential_in_argv");
  for (const [name, value] of Object.entries(plan.env)) {
    if (name !== profile.credentialEnv && value.includes(credential)) throw new LaunchRefused("credential_in_env");
  }
}
