// 배포가 주입한 계정 하나와 방식 하나의 참조를 그대로 고정한다(O09 할 일 8: 지금은 계정 하나 고정, 순서·전환은 O17).
// 참조는 이름뿐이다. 자격 값을 받거나 읽지 않고, 한도를 판단하거나 다른 계정으로 넘어가지 않는다.
// 요청은 인자에 없다. 요청의 어떤 칸도 고른 계정을 바꾸지 못한다.
import { type Role, ROLES } from "../../contract/v1/index.ts";
import { AUTH_METHODS, type AuthMethod, ROLE_POLICIES } from "../roles/policy.ts";

export interface AccountRef {
  readonly account: string;
  readonly method: AuthMethod;
}

export type AccountSelection =
  | { readonly kind: "fixed"; readonly account: AccountRef }
  | { readonly kind: "none"; readonly reason: "no_account_injected" | "multiple_accounts_injected" | "account_ref_malformed" | "method_not_allowed" };

// 장부가 받는 계정 이름의 꼴(src/ledger/input.ts의 ACCOUNT)과 같다. 짧은 이름만 받아 자격 값이 이름 칸으로 새어 들어오지 않게 한다.
// 감독의 판단 조각은 장부를 import하지 않으므로 여기 다시 두고, 일치는 시험이 대조한다.
export const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function selectAccount(role: Role, injected: readonly AccountRef[]): AccountSelection {
  if (!Array.isArray(injected) || injected.length === 0) return { kind: "none", reason: "no_account_injected" };
  // 둘 이상이면 어느 것도 고르지 않는다. 고르는 순서는 O17의 일이다.
  if (injected.length > 1) return { kind: "none", reason: "multiple_accounts_injected" };
  const ref = injected[0];
  if (typeof ref?.account !== "string" || !ACCOUNT_NAME.test(ref.account) || !(AUTH_METHODS as readonly unknown[]).includes(ref.method)) {
    return { kind: "none", reason: "account_ref_malformed" };
  }
  // 역할 목록에 있는지 먼저 본다. 표는 평범한 객체라 "__proto__"·"constructor" 같은 이름도 상속된 값을 돌려준다.
  if (!(ROLES as readonly unknown[]).includes(role) || !ROLE_POLICIES[role].methods.includes(ref.method)) return { kind: "none", reason: "method_not_allowed" };
  // 이름과 방식 두 칸만 새로 만들어 얼린다. 주입 객체에 다른 칸이 있어도 넘기지 않는다.
  return { kind: "fixed", account: Object.freeze({ account: ref.account, method: ref.method }) };
}
