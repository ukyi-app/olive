// 대기 부탁 하나를 어느 실행기에 맡길지 고르는 순수 판단. 상태를 갖지 않고 장부를 열거나 쓰지 않는다.
// 장부·연결·계정·정책에서 읽은 값과 지금 시각을 인자로 받아, assignToolRequest에 넘길 입력(실행 ID 뺌) 또는 구별된 답을 낸다.
//
// 고른 결과는 실행 허가가 아니다. 장부의 assignToolRequest가 정지·접수·꼴을 같은 트랜잭션에서 다시 보고, 시작은 그 뒤
// planNext와 startRun이 따로 정한다. 부르는 쪽은 고른 결과를 받아도 장부의 거절을 그대로 따른다.
//
// 틀리는 방향은 늘 "배정하지 않음"이다. 모르는 사실, 빠진 정책 값, 꼴이 틀린 입력은 배정 입력을 만들지 않는다.
// 역할·revision·등록의 대조는 roles/assign.ts의 judgeAssignment, 계정은 accounts/fixed.ts의 selectAccount가 한다.
// 그 검사를 여기 다시 쓰지 않는다: 두 곳이 갈라지면 한쪽만 고쳐진 검사가 후보를 통과시킨다.
import { executorName, type Role, ROLES } from "../../contract/v1/index.ts";
import type { AssignToolRequestInput, CredentialRef } from "../../ledger/index.ts";
import { type AccountRef, type AccountSelection, selectAccount } from "../accounts/fixed.ts";
import { type AssignmentCandidate, type AssignmentContext, type HoldReason, type InputRejectReason, judgeAssignment, REVISION } from "../roles/assign.ts";
import { PATTERNS } from "../scheduler/tools.ts";
import type { Candidate } from "../transport/connections.ts";

// 대기 부탁 하나. 장부의 대기 부탁 목록 읽기는 아직 없어 그 읽기가 낼 꼴을 여기서 선언한다.
// 소유자 입력의 취소·만료는 부탁 줄이 아니라 입력 줄의 값이다. 장부의 배정 연산은 이 둘을 보지 않으므로 여기서 거른다.
export interface WaitingRequest {
  readonly ref: string;
  readonly role: Role;
  readonly inputDigest: string;
  readonly input: {
    readonly cancelled: boolean;
    // 장부 inputs.source_expires_at. 이 시각 정각부터 만료다(장부 queueView와 같은 경계).
    readonly expiresAt: number;
  };
}

// 설계(supervisor.md §4 start_worker 행)가 배정 전에 거절하라고 한 조건 가운데 이 판단의 다른 입력으로 판정할 수 없는 것.
// 값은 "그 조건에 해당한다"다: true면 거절, false면 통과, 칸이 없거나 boolean이 아니면 모름(보류).
// 이 사실을 채우는 쪽(장부의 고정 입력에서 복원하는 어댑터)은 아직 없다. 그동안은 어떤 부탁도 배정되지 않는다.
export const PRE_ASSIGN_FACTS = [
  // 허용되지 않은 역할·목적 조합
  "role_purpose_not_allowed",
  // 고정되지 않은 원본
  "source_not_pinned",
  // 자기 저장소를 고치는 작성(D-25)
  "self_repo_write",
  // 외부 코드 실행
  "external_code",
  // 스스로 고치는 작성인데 근거 문이 닫힘(D-34). 관리자가 말로 시킨 변경의 예외는 사실을 채우는 쪽이 반영한다.
  "self_fix_basis_closed",
  // 앞 실행의 종료 미확인
  "prior_run_end_unconfirmed",
] as const;
export type PreAssignFact = (typeof PRE_ASSIGN_FACTS)[number];
export type PreAssignFacts = { readonly [F in PreAssignFact]?: boolean };

// 역할 하나의 실행 정책. 숫자는 배포가 넣는다: 진단 밖 역할의 예산은 설계에 없고 이 판단은 숫자를 지어내지 않는다.
export interface RunPlan {
  readonly role: Role;
  readonly snapshotDigest: string;
  // 실행 줄에 적을 남은 예산. 1 이상이어야 한다(장부의 startRun이 1 미만을 시작하지 않는다).
  readonly budgetLeft: number;
  // 배정 시각부터 기한까지의 길이(ms).
  readonly runDurationMs: number;
}

export interface PickInput {
  readonly request: WaitingRequest;
  // Connections.candidates(...)의 출력 그대로.
  readonly connections: readonly Candidate[];
  readonly assignment: AssignmentContext;
  // 배포가 주입한 계정 참조. 고르는 것은 selectAccount(부탁의 역할로)다.
  readonly accounts: readonly AccountRef[];
  // 고른 계정의 자격 revision·digest. 주는 쪽이 아직 없다. null이면 모름.
  readonly credential: CredentialRef | null;
  readonly plans: readonly RunPlan[];
  readonly facts: PreAssignFacts;
  // Restorer.intakeOpen()의 값. true가 아니면 무엇도 고르지 않는다.
  readonly intakeOpen: boolean;
  // 장부 시계와 같은 시계의 지금 시각.
  readonly now: number;
}

// 실행 ID만 부르는 쪽이 새 UUID로 채운다.
export type AssignmentInput = Omit<AssignToolRequestInput, "runId">;

export const PICK_REJECT_REASONS = ["malformed_now", "malformed_request", "malformed_connections", "malformed_credential", "malformed_plan", "duplicate_plan", "malformed_executor"] as const;
export type PickRejectReason = (typeof PICK_REJECT_REASONS)[number];

export type Pick =
  | { readonly kind: "assign"; readonly input: AssignmentInput; readonly connection: number; readonly candidate: AssignmentCandidate }
  | { readonly kind: "intake_closed" }
  // 부탁 자체가 배정될 수 없다. 다음 박자에도 같은 답이다.
  | { readonly kind: "refused"; readonly reason: "input_cancelled" | "input_expired" | PreAssignFact }
  // 보류(입력 없음): 판정할 사실이 없다. missing은 PRE_ASSIGN_FACTS 순서다.
  | { readonly kind: "held"; readonly reason: "evidence_missing"; readonly missing: readonly PreAssignFact[] }
  // 맞는 실행기가 없다. holds는 연결마다 judgeAssignment의 보류 그대로이고 연결 번호 순이다.
  | { readonly kind: "held"; readonly reason: "no_executor"; readonly holds: readonly { readonly connection: number; readonly reason: HoldReason }[] }
  | { readonly kind: "held"; readonly reason: "no_account"; readonly account: Extract<AccountSelection, { kind: "none" }>["reason"] }
  | { readonly kind: "held"; readonly reason: "credential_unknown" | "credential_mismatch" | "plan_missing" }
  // 입력의 꼴이 틀렸다(부르는 쪽이나 주입 자료의 결함). assign은 judgeAssignment의 입력 거절 그대로다.
  | { readonly kind: "input_rejected"; readonly reason: PickRejectReason }
  | { readonly kind: "input_rejected"; readonly reason: "assignment_input"; readonly assign: InputRejectReason };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRole = (value: unknown): value is Role => (ROLES as readonly unknown[]).includes(value);
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);

function validRequest(request: unknown): request is WaitingRequest {
  if (!isObject(request) || !isObject(request.input)) return false;
  return (
    matches(request.ref, PATTERNS.uuid) &&
    isRole(request.role) &&
    matches(request.inputDigest, PATTERNS.sha256) &&
    typeof request.input.cancelled === "boolean" &&
    isTime(request.input.expiresAt)
  );
}

function validCredential(value: unknown): value is CredentialRef {
  return isObject(value) && typeof value.account === "string" && typeof value.method === "string" && matches(value.revision, REVISION) && matches(value.digest, PATTERNS.sha256);
}

function validPlan(plan: unknown): plan is RunPlan {
  if (!isObject(plan)) return false;
  return (
    isRole(plan.role) &&
    matches(plan.snapshotDigest, PATTERNS.sha256) &&
    Number.isSafeInteger(plan.budgetLeft) &&
    (plan.budgetLeft as number) >= 1 &&
    Number.isSafeInteger(plan.runDurationMs) &&
    (plan.runDurationMs as number) > 0
  );
}

// 같은 실행기 이름이면 연결 번호가 작은 쪽. 이름이 같으면 장부에 적히는 값이 같아 어느 쪽이든 실행 줄은 같다.
const byExecutor = (a: { name: string; connection: number }, b: { name: string; connection: number }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.connection - b.connection;

export function pickAssignment(input: PickInput): Pick {
  if (!isObject(input) || input.intakeOpen !== true) return { kind: "intake_closed" };
  const now = input.now;
  if (!isTime(now)) return { kind: "input_rejected", reason: "malformed_now" };
  const request = input.request;
  if (!validRequest(request)) return { kind: "input_rejected", reason: "malformed_request" };

  if (request.input.cancelled) return { kind: "refused", reason: "input_cancelled" };
  if (request.input.expiresAt <= now) return { kind: "refused", reason: "input_expired" };

  const facts: Record<string, unknown> = isObject(input.facts) ? input.facts : {};
  const hit = PRE_ASSIGN_FACTS.find((fact) => facts[fact] === true);
  if (hit !== undefined) return { kind: "refused", reason: hit };
  const missing = PRE_ASSIGN_FACTS.filter((fact) => facts[fact] !== false);
  if (missing.length > 0) return { kind: "held", reason: "evidence_missing", missing };

  if (!Array.isArray(input.connections)) return { kind: "input_rejected", reason: "malformed_connections" };
  const job = { role: request.role };
  const passed: { name: string; connection: number; candidate: AssignmentCandidate }[] = [];
  const holds: { connection: number; reason: HoldReason }[] = [];
  for (const conn of input.connections as readonly unknown[]) {
    if (!isObject(conn) || !Number.isSafeInteger(conn.connection)) return { kind: "input_rejected", reason: "malformed_connections" };
    const id = conn.connection as number;
    // 나머지 칸의 꼴은 judgeAssignment가 보고 틀리면 보류로 답한다.
    const judged = judgeAssignment(job, conn as unknown as Candidate, input.assignment);
    if (judged.kind === "input_rejected") return { kind: "input_rejected", reason: "assignment_input", assign: judged.reason };
    if (judged.kind === "held") {
      holds.push({ connection: id, reason: judged.reason });
      continue;
    }
    let name: string;
    try {
      name = executorName(judged.role, judged.instance, judged.storage);
    } catch {
      return { kind: "input_rejected", reason: "malformed_executor" };
    }
    passed.push({ name, connection: id, candidate: judged });
  }
  if (passed.length === 0) return { kind: "held", reason: "no_executor", holds: holds.sort((a, b) => a.connection - b.connection) };
  const chosen = passed.sort(byExecutor)[0] as (typeof passed)[number];

  const account = selectAccount(request.role, input.accounts);
  if (account.kind === "none") return { kind: "held", reason: "no_account", account: account.reason };

  const credential = input.credential;
  if (credential === null || credential === undefined) return { kind: "held", reason: "credential_unknown" };
  if (!validCredential(credential)) return { kind: "input_rejected", reason: "malformed_credential" };
  if (credential.account !== account.account.account || credential.method !== account.account.method) return { kind: "held", reason: "credential_mismatch" };

  if (!Array.isArray(input.plans)) return { kind: "input_rejected", reason: "malformed_plan" };
  const plans = input.plans.filter((plan) => isObject(plan) && plan.role === request.role);
  if (plans.length > 1) return { kind: "input_rejected", reason: "duplicate_plan" };
  const plan = plans[0];
  if (plan === undefined) return { kind: "held", reason: "plan_missing" };
  if (!validPlan(plan)) return { kind: "input_rejected", reason: "malformed_plan" };

  // 기한은 입력의 만료보다 늦지 않게 자른다. 입력이 만료된 실행은 장부가 시작하지 않으므로, 더 긴 기한은 쓸 수 없는 약속이다.
  const deadlineAt = Math.min(now + plan.runDurationMs, request.input.expiresAt);
  if (!isTime(deadlineAt)) return { kind: "input_rejected", reason: "malformed_plan" };

  const c = chosen.candidate;
  return {
    kind: "assign",
    connection: chosen.connection,
    candidate: c,
    input: Object.freeze({
      ref: request.ref,
      snapshotDigest: plan.snapshotDigest,
      profileRevision: c.profile_revision,
      policyRevision: c.policy_revision,
      executorId: chosen.name,
      credential: Object.freeze({ account: credential.account, method: credential.method, revision: credential.revision, digest: credential.digest }),
      deadlineAt,
      budgetLeft: plan.budgetLeft,
      now,
    }),
  };
}
