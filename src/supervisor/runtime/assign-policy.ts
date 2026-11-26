// 배정 박자(dispatch/assign-loop.ts)의 정책과 자격 참조 정책의 빈 칸을 배포 값으로 채우는 순수 함수들.
// 진입점(src/main/supervisor.ts)이 환경 값을, 조립(boot.ts)이 적용한 등록표를 넘긴다. 파일·환경·시계를 읽지 않는다.
// 값이 없거나 맞지 않으면 채우기 전의 닫힌 값(보류·모름)과 같은 결과를 낸다. 틀리는 방향은 늘 "배정하지 않음"이다.
import { executorName, type Role, ROLES } from "../../contract/v1/index.ts";
import { type AssignmentContext, type Registration, REVISION } from "../roles/assign.ts";
import type { RegistryState, RegistryTarget } from "../transport/registry.ts";

export type EnvValue<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

// 역할별로 감독이 기대하는 프로필 revision(실행기 hello의 profile_revision과 견준다). 칸이 없는 역할에는 기대값이 없다.
export type ProfileRevisions = { readonly [R in Role]?: string };

// 기대 프로필 revision을 어떻게 썼는가. none: 칸이 없다. single: 모든 칸이 한 값이다. split: 칸마다 값이 달라 하나로 고르지 못했다.
export type ProfileUse = "none" | "single" | "split";

// 계정 자격의 판(D-111). 없거나 빈 값이면 모름(null)이고, v1 revision 꼴이 아니면 틀림이다.
export function accountRevisionFromEnv(raw: string | undefined): EnvValue<string | null> {
  if (raw === undefined || raw === "") return { ok: true, value: null };
  return REVISION.test(raw) ? { ok: true, value: raw } : { ok: false };
}

// 역할별 기대 프로필 revision. JSON 객체 { "<v1 역할>": "<revision>" }이다. 없거나 빈 값이면 빈 객체다.
// 모르는 역할 이름(상속 이름 "__proto__" 포함), 꼴이 틀린 revision, 객체가 아닌 값은 틀림이다.
// 함정: JSON.parse는 같은 이름의 칸이 거듭되면 뒤의 값을 조용히 고른다. 차트가 맵에서 렌더하는 값이라 거듭될 수 없다고 본다.
export function profileRevisionsFromEnv(raw: string | undefined): EnvValue<ProfileRevisions> {
  if (raw === undefined || raw === "") return { ok: true, value: Object.freeze({}) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  const out: { [R in Role]?: string } = {};
  for (const [role, revision] of Object.entries(parsed)) {
    if (!(ROLES as readonly string[]).includes(role) || typeof revision !== "string" || !REVISION.test(revision)) return { ok: false };
    out[role as Role] = revision;
  }
  return { ok: true, value: Object.freeze(out) };
}

// 배정 판단의 허용 표와 기대 revision. 등록행은 비운다: 등록행은 적용한 등록표에서만 만든다(registrationsFrom).
// 함정: 배정 판단(roles/assign.ts의 judgeAssignment)은 기대 revision을 역할과 무관하게 하나만 받는다. 그래서 칸이 모두 한 값일 때만
// 그 값을 기대값으로 두고 허용 표에서 칸이 없는 역할을 뺀다(그 역할의 실행기가 같은 값을 내도 후보가 되지 않게).
// 칸마다 값이 다르면 기대값을 비운다: 모든 연결이 expected_revision_missing으로 보류된다. 역할마다 견주려면 판단을 바꿔야 한다.
export function assignmentFrom(
  targets: readonly RegistryTarget[],
  profiles: ProfileRevisions,
  policyRevision: string,
): { readonly context: AssignmentContext; readonly profile: ProfileUse } {
  const mapped: Role[] = ROLES.filter((role) => Object.hasOwn(profiles, role));
  const values = [...new Set(mapped.map((role) => profiles[role] as string))];
  const profile: ProfileUse = values.length === 0 ? "none" : values.length === 1 ? "single" : "split";
  const allowed = targets.map((t) => ({ target: t.target, roles: profile === "single" ? t.roles.filter((role) => mapped.includes(role)) : t.roles }));
  const expected = { profile_revision: profile === "single" ? (values[0] as string) : "", policy_revision: policyRevision };
  return { context: { allowed, registrations: [], expected }, profile };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

// 적용한 등록표 문서의 활성 행을 배정 판단의 등록행으로 바꾼다. content는 RegistryState.apply가 받아들인 같은 바이트여야 한다
// (그 적용이 BOM·중복 키·꼴을 이미 걸렀다). keyId는 그 상태의 keyFor가 답한 값만 쓴다: 연결 표가 서명을 확인할 때 적는 keyId와 같은 원천이다.
// 무엇이든 어긋나면(해석 실패, 활성 행인데 상태가 그 주체의 키를 믿지 않음, 던짐) 행을 골라 받지 않고 빈 목록이다.
// 그러면 어느 연결도 등록되지 않은 것이라 배정이 보류된다(not_registered). 비활성 행은 넣지 않는다: 그 키의 연결은 연결 표가 닫아 후보에 오르지 않는다.
export function registrationsFrom(content: Uint8Array, registry: RegistryState, targets: readonly RegistryTarget[]): readonly Registration[] {
  try {
    const doc: unknown = JSON.parse(UTF8.decode(content));
    const executors = (doc as { executors?: unknown } | null)?.executors;
    if (!Array.isArray(executors)) return [];
    const rows: Registration[] = [];
    for (const item of executors as unknown[]) {
      const { target, role, instance, storage, active } = item as Record<string, unknown>;
      if (active !== true) continue;
      if (typeof target !== "string" || typeof instance !== "string" || typeof storage !== "string" || !(ROLES as readonly unknown[]).includes(role)) return [];
      const namespace = targets.find((entry) => entry.target === target)?.namespace;
      if (namespace === undefined) return [];
      // keyFor는 TLS 신원 가운데 종류·대상·네임스페이스만 본다. uri는 그 판단에 쓰이지 않아 빈 값으로 둔다.
      const trusted = registry.keyFor({ kind: "executor", target, namespace, uri: "" }, executorName(role as Role, instance, storage));
      if (trusted === undefined || typeof trusted.keyId !== "string") return [];
      rows.push(Object.freeze({ target, role: role as Role, instance, storage, keyId: trusted.keyId, active: true }));
    }
    return Object.freeze(rows);
  } catch {
    return [];
  }
}
