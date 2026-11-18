// 장부 쓰기 함수가 받는 값의 확인. 원문(요청 글, 모델 출력, 로그)과 자격 값이 장부에 들어오는 길을 막는다.
// - 입력 객체는 정해진 칸만 받는다. 모르는 칸(예: prompt, token)이 있으면 던진다.
// - 글자 칸은 공백·줄바꿈이 없는 짧은 식별자만 받는다. 원문은 그런 꼴이 아니라 여기서 걸린다.
// - 자격은 계정·방식·revision·digest(값의 SHA-256)만 받는다.
// 꼴은 계약(src/contract/v1/schema.ts)의 UUID·SHA256·REVISION과 같다. 계약의 공개 면이 이 정규식을 내지 않아 여기 다시 둔다.
// 같은지는 test/ledger/static.test.ts가 대조한다.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// 출처·현관 작업 ID·인계 참조·중복 키. 공백 없는 200자 이하. 원문을 담을 수 없게 짧고 좁다.
export const REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,199}$/;
// 계약 credential의 account·method와 같은 허용값(src/contract/v1/instruction.ts).
export const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const AUTH_METHODS = ["subscription", "api_key"] as const;
// 원문 참조는 저장소가 발행한 ID다: `<저장소 이름>/<UUID>`. 짧은 요청 글은 이 꼴이 될 수 없다.
export const SOURCE_REF = /^[a-z][a-z0-9-]{0,31}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 감독이 저장한 결과의 자리. 원문 참조와 같은 꼴이다.
export const STORED_REF = SOURCE_REF;
// 인계 묶음의 자리. 인계 저장소의 ID 꼴은 설계에 없어 장부가 받을 수 있는 가장 좁은 꼴(저장소가 낸 불투명 ID)만 받는다.
// 스킴·사용자·비밀번호·호스트를 담는 URI는 이 꼴이 될 수 없다.
export const HANDOFF_REF = SOURCE_REF;

export class LedgerInputError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInputError";
  }
}

export function exact(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LedgerInputError(`${where}: 객체가 아니다`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new LedgerInputError(`${where}: 받지 않는 칸 ${key}`);
  }
  return value as Record<string, unknown>;
}

export function str(value: unknown, pattern: RegExp, where: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new LedgerInputError(`${where}: 꼴이 맞지 않는다`);
  return value;
}

export function strOrNull(value: unknown, pattern: RegExp, where: string): string | null {
  return value === null ? null : str(value, pattern, where);
}

// 정수는 모두 안전 정수다(스키마의 CHECK와 같은 상한). 넘으면 JS의 비교가 틀어진다.
export function time(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new LedgerInputError(`${where}: 시각이 아니다`);
  return value as number;
}

export function count(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new LedgerInputError(`${where}: 0 이상 정수가 아니다`);
  return value as number;
}

export function bool(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") throw new LedgerInputError(`${where}: boolean이 아니다`);
  return value;
}

export function oneOf<const T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new LedgerInputError(`${where}: 허용 값이 아니다`);
  return value as T;
}

// 자격은 값이 아니라 무엇을 넘겼는지의 기록이다(계약의 credential과 같은 네 칸).
export interface CredentialRef {
  account: string;
  method: string;
  revision: string;
  digest: string;
}

export function credentialRef(value: unknown, where: string): CredentialRef {
  const v = exact(value, ["account", "method", "revision", "digest"], where);
  return {
    account: str(v.account, ACCOUNT, `${where}.account`),
    method: oneOf(v.method, AUTH_METHODS, `${where}.method`),
    revision: str(v.revision, REVISION, `${where}.revision`),
    digest: str(v.digest, SHA256, `${where}.digest`),
  };
}

// 원문은 참조와 만료만.
export interface SourceRef {
  ref: string;
  expiresAt: number;
}

export function sourceRef(value: unknown, where: string): SourceRef {
  const v = exact(value, ["ref", "expiresAt"], where);
  return { ref: str(v.ref, SOURCE_REF, `${where}.ref`), expiresAt: time(v.expiresAt, `${where}.expiresAt`) };
}
