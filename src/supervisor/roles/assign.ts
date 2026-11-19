// 이 연결에 이 역할의 일을 배정할 수 있는가를 고르는 순수 판단. 모든 자료는 인자로 받는다(파일·환경·Secret을 읽지 않는다).
// 고정 역할 표, 주입된 대상 허용 표, 주입된 등록행의 단일 역할, 인증된 연결의 주체 전체(역할·인스턴스·저장소를 등록행과 대조),
// hello의 두 revision이 모두 맞아야 후보다. 등록·hello·연결 하나만으로는 자격이 생기지 않는다.
// 모르거나 꼴이 틀리면 보류·거절이고 예외로 끊기지 않는다.
//
// 후보(candidate)는 실행 허가가 아니다. 장부의 정지·슬롯·세대·기한 검사와 접수 열림 확인을 이 판단은 하지 않는다.
// 부르는 쪽은 후보를 받은 뒤에도 장부의 시작 트랜잭션을 통과해야 지시를 낼 수 있다.
import { type Principal, type Role, ROLES } from "../../contract/v1/index.ts";
import { ROLE_POLICIES } from "./policy.ts";

// 일에서 이 판단이 보는 것은 역할 하나다. 요청이 실어 온 프로필·계정·대상·revision 칸은 일부러 타입에 없다.
// 부르는 쪽이 더 많은 칸을 가진 객체를 넘겨도 여기서는 role만 읽는다.
export interface Job {
  readonly role: Role;
}

// 배포 대상마다 맡을 수 있는 역할(D-64의 "대상 목록 한 곳"). 운영 자료는 배포가 주입한다.
export interface TargetAllowance {
  readonly target: string;
  readonly roles: readonly Role[];
}

// 관리자가 등록표에 적은 실행기 한 줄(D-63). 실행기와 그 서명 키에는 역할이 하나다(D-64).
export interface Registration {
  readonly target: string;
  readonly role: Role;
  readonly instance: string;
  // 관리자가 승인한 저장소 ID. 저장소를 잃어 새로 만들면 ID가 바뀌므로, 연결 주체의 저장소가 이 값과 정확히 같아야 후보다.
  readonly storage: string;
  // 서명 공개 키의 식별. 키 값이 아니다.
  readonly keyId: string;
  readonly active: boolean;
}

export interface Revisions {
  readonly profile_revision: string;
  readonly policy_revision: string;
}

// 실제 연결이 인증으로 확인해 준 것. 모델이나 요청이 주장한 값을 여기에 넣지 않는다.
export interface AuthenticatedConnection {
  // 연결 인증서가 확인한 배포 대상 ID
  readonly target: string;
  // 봉투 서명을 검증한 주체 전체
  readonly principal: Principal;
  // 그 서명을 검증한 공개 키의 식별
  readonly keyId: string;
  // 같은 연결에서 서명이 맞은 hello의 revision
  readonly hello: Revisions;
}

export interface AssignmentContext {
  readonly allowed: readonly TargetAllowance[];
  readonly registrations: readonly Registration[];
  // 감독이 이 일의 역할에 기대하는 두 revision
  readonly expected: Revisions;
}

// 배정 후보. 실행 허가가 아니다(파일 머리 주석).
export interface AssignmentCandidate {
  readonly kind: "candidate";
  readonly role: Role;
  readonly target: string;
  readonly instance: string;
  readonly storage: string;
  readonly keyId: string;
  readonly profile_revision: string;
  readonly policy_revision: string;
}

export const HOLD_REASONS = [
  "unknown_job_role",
  "no_fixed_target",
  "principal_not_worker",
  "principal_role_mismatch",
  "target_mismatch",
  "target_not_allowed",
  "not_registered",
  "registration_inactive",
  "registration_role_mismatch",
  "registration_target_mismatch",
  "registration_instance_mismatch",
  "registration_storage_mismatch",
  // 기대 revision이 없거나 계약 v1의 revision 문법에 맞지 않을 때
  "expected_revision_missing",
  "profile_revision_mismatch",
  "policy_revision_mismatch",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export const INPUT_REJECT_REASONS = ["malformed_input", "unknown_role", "duplicate_target", "key_in_two_roles", "duplicate_key", "duplicate_identity"] as const;
export type InputRejectReason = (typeof INPUT_REJECT_REASONS)[number];

export type AssignmentJudgement =
  | AssignmentCandidate
  | { readonly kind: "held"; readonly reason: HoldReason }
  // 주입 자료 자체가 모순이면 어느 일도 배정하지 않는다.
  | { readonly kind: "input_rejected"; readonly reason: InputRejectReason };

const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);
const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

// 계약 v1의 revision 문법(src/contract/v1/schema.ts의 REVISION, hello 파서가 쓰는 꼴). 계약의 공개 면이 내지 않아 여기 다시 두고,
// 계약 스키마·장부의 REVISION과 같은지는 시험이 대조한다.
export const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isRevision = (value: unknown): value is string => typeof value === "string" && REVISION.test(value);

function checkInput(ctx: AssignmentContext): InputRejectReason | null {
  if (!Array.isArray(ctx.allowed) || !Array.isArray(ctx.registrations)) return "malformed_input";
  const targets = new Set<string>();
  for (const entry of ctx.allowed) {
    if (!isName(entry?.target) || !Array.isArray(entry.roles)) return "malformed_input";
    if (!entry.roles.every(isRole)) return "unknown_role";
    if (targets.has(entry.target)) return "duplicate_target";
    targets.add(entry.target);
  }
  const roleByKey = new Map<string, Role>();
  const activeInstances = new Set<string>();
  for (const row of ctx.registrations) {
    if (!isName(row?.target) || !isName(row.instance) || !isName(row.storage) || !isName(row.keyId) || typeof row.active !== "boolean") return "malformed_input";
    if (!isRole(row.role)) return "unknown_role";
    // 비활성 행의 키도 센다. 한 번 어떤 역할에 등록된 키는 다른 역할로 다시 쓰이지 않아야 한다.
    const seen = roleByKey.get(row.keyId);
    if (seen !== undefined) return seen === row.role ? "duplicate_key" : "key_in_two_roles";
    roleByKey.set(row.keyId, row.role);
    // 인스턴스는 활성 행끼리만 센다. 저장소를 잃어 새 키로 다시 등록하면 옛 행은 비활성으로 남는다.
    if (row.active) {
      if (activeInstances.has(row.instance)) return "duplicate_identity";
      activeInstances.add(row.instance);
    }
  }
  return null;
}

export function judgeAssignment(job: Job, connection: AuthenticatedConnection, ctx: AssignmentContext): AssignmentJudgement {
  // 타입 밖 호출(빈 값)도 예외가 아니라 입력 거절로 끝내야 목록 함수가 같은 거절 분기를 쓴다.
  if (!isObject(job) || !isObject(connection) || !isObject(ctx)) return { kind: "input_rejected", reason: "malformed_input" };
  const rejected = checkInput(ctx);
  if (rejected) return { kind: "input_rejected", reason: rejected };
  const held = (reason: HoldReason) => ({ kind: "held", reason }) as const;

  const role = job.role;
  if (!isRole(role)) return held("unknown_job_role");
  const target = ROLE_POLICIES[role].target;
  if (target === null) return held("no_fixed_target");

  const principal = connection.principal;
  if (principal?.kind !== "worker_executor") return held("principal_not_worker");
  if (principal.role !== role) return held("principal_role_mismatch");
  if (connection.target !== target) return held("target_mismatch");
  if (!ctx.allowed.some((entry) => entry.target === target && entry.roles.includes(role))) return held("target_not_allowed");

  const row = ctx.registrations.find((r) => r.keyId === connection.keyId);
  if (!row) return held("not_registered");
  if (!row.active) return held("registration_inactive");
  if (row.role !== role) return held("registration_role_mismatch");
  if (row.target !== target) return held("registration_target_mismatch");
  if (row.instance !== principal.instance) return held("registration_instance_mismatch");
  // row.storage는 checkInput이 빈 값 아닌 문자열로 확인했으므로, 정확 일치가 빈 값·누락·문자열 아님도 함께 막는다.
  if (principal.storage !== row.storage) return held("registration_storage_mismatch");

  // 기대값을 문법으로 먼저 거른다. 양쪽이 같은 무효 문자열이면 정확 비교만으로는 통과하기 때문이다.
  const expected = ctx.expected;
  if (!isRevision(expected?.profile_revision) || !isRevision(expected.policy_revision)) return held("expected_revision_missing");
  if (connection.hello?.profile_revision !== expected.profile_revision) return held("profile_revision_mismatch");
  if (connection.hello.policy_revision !== expected.policy_revision) return held("policy_revision_mismatch");

  // 결과의 값은 고정 표·등록행·인증된 연결에서만 가져온다. 일 객체의 다른 칸은 읽지 않는다.
  return {
    kind: "candidate",
    role,
    target,
    instance: row.instance,
    storage: row.storage,
    keyId: row.keyId,
    profile_revision: expected.profile_revision,
    policy_revision: expected.policy_revision,
  };
}

// 연결 여럿 가운데 후보만 남긴다. 빈 목록이면 고를 실행기가 없다는 뜻이고, 다른 역할의 실행기로 대신하지 않는다.
// 후보가 둘 이상일 때 어느 것을 쓸지는 슬롯·대기열을 보는 뒤 조각이 정한다.
export function eligibleConnections(job: Job, connections: readonly AuthenticatedConnection[], ctx: AssignmentContext): AssignmentCandidate[] {
  const out: AssignmentCandidate[] = [];
  if (!Array.isArray(connections)) return out;
  for (const connection of connections) {
    const judged = judgeAssignment(job, connection, ctx);
    if (judged.kind === "input_rejected") return [];
    if (judged.kind === "candidate") out.push(judged);
  }
  return out;
}
