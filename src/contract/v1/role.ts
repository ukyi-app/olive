// 작업자 역할 다섯(O09 할 일 2). 실행 도구·모델·자격·네트워크·이미지는 역할 프로필에 고정돼 있고 지시로 바꿀 수 없다.
// 세션(오케스트레이터)은 작업자 역할이 아니다. 세션 실행기의 주체 이름에는 역할 대신 "session"이 온다.
export const ROLES = ["diagnosis", "isolated_reader", "code_author", "pr_review", "memory_curator"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
