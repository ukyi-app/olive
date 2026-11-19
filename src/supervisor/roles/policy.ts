// 다섯 역할의 고정 정책 표. 설계 문서가 값을 정한 칸만 채우고, 정하지 않은 칸은 비워 둔다.
// 대상이 null이면 설계가 대상 ID를 정하지 않았다는 뜻이고 그 역할의 일은 배정하지 않는다.
// 방식 목록은 "지금 배포가 넘길 수 있는 계정 참조로 고를 수 있는 방식"이다. 설계가 정한 실행 방식과 같은 뜻이 아니다.
// 비어 있으면 감독이 그 역할에 넘길 계정 참조가 없다는 뜻이고 계정은 고르지 않는다.
// 대상이 있어도 배정이 열리는 것은 아니다. 주입된 허용 표와 활성 등록행이 함께 맞아야 후보다(assign.ts).
// 이 표는 요청·결과의 글로 바뀌지 않는다. 값을 바꾸는 길은 코드 리뷰를 거친 PR 하나뿐이다.
import type { Role } from "../../contract/v1/index.ts";

// 계정 방식의 이름. 장부가 실행마다 적는 방식(src/ledger/input.ts의 AUTH_METHODS)과 같은 문자열이어야 한다.
// 감독의 판단 조각은 장부를 import하지 않으므로 여기 다시 두고, 일치는 시험이 대조한다.
export const AUTH_METHODS = ["subscription", "api_key"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export interface RolePolicy {
  // 이 역할의 실행기가 있어야 하는 배포 대상 ID. null이면 설계가 정하지 않았다는 뜻이고 배정은 보류다.
  readonly target: string | null;
  // 지금 배포가 넘길 수 있는 계정 참조로 고를 수 있는 방식. 비어 있으면 넘길 참조가 없어 계정을 고르지 않는다.
  readonly methods: readonly AuthMethod[];
}

function policy(target: string | null, methods: readonly AuthMethod[]): RolePolicy {
  return Object.freeze({ target, methods: Object.freeze([...methods]) });
}

// 출처는 설계 문서(homelab docs/plans/2026-11-13-olive)의 절과 대상 원본(homelab platform/olive/targets.yaml)이다.
// 대상 ID는 supervisor.md §1.1 표의 네임스페이스를 같은 절의 D-64가 가리키는 대상 원본의 id와 맞춘 값이다.
// 대상 원본의 start(지금 켤 수 있는지)는 이 표가 바꾸지 않는다.
export const ROLE_POLICIES: { readonly [R in Role]: RolePolicy } = Object.freeze({
  // 대상: supervisor.md §1.1의 olive-diagnosis 행 = targets.yaml의 id diagnosis(namespace olive-diagnosis).
  // 방식: spec.md B-08, accounts.md §1(크레딧 단계 OpenCode의 API 키, 구독 단계 Claude Code).
  diagnosis: policy("diagnosis", ["api_key", "subscription"]),
  // 대상: D-64(spec.md §5.1, supervisor.md §1.1). 배포 대상 reader에는 처음에 격리 읽기만 등록한다.
  // 방식: spec.md B-08("claude -p(API 키)는 격리 읽기처럼 도구 없이 정해진 모양의 결과만 내는 경로에만").
  isolated_reader: policy("reader", ["api_key"]),
  // 대상: supervisor.md §1.1의 sandbox 행(작성 실행기, worker-task) = targets.yaml의 id writer(namespace sandbox, deployment worker-task).
  // 방식: spec.md B-08, accounts.md §1.
  code_author: policy("writer", ["api_key", "subscription"]),
  // 대상: D-64. 별도 실행기를 승인하기 전까지 배정하지 않는다.
  // 방식: 실행 방식은 B-08이 Codex 구독으로 정했다(spec.md B-08, accounts.md §1은 이 작업자를 Claude 계정 순서 밖에 둔다).
  // 비어 있는 것은 감독이 넘길 그 Codex 계정의 참조다. 참조는 공급자를 가르지 않으므로 일반 subscription을 열지 않는다.
  pr_review: policy(null, []),
  // 대상·방식 모두 설계에 없다. 기억 관리기(spec.md 역할 표)는 "필요하면 그 실행 자격 하나"라고만 적었다.
  memory_curator: policy(null, []),
});
