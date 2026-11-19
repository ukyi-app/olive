// v2의 엄격한 해석 도구. v1 schema.ts와 같은 원칙이다: 객체는 닫혀 있고(모르는 칸 거절), 선택 칸이 없다(없을 수 있는 값은 null로
// 늘 싣는다). v1의 schema.ts는 v1 공개 면(index.ts)에 없어서 여기에 따로 둔다. 서명·digest가 보는 바이트를 만드는 정규화는
// 따로 두지 않고 v1 공개 면의 canonicalJson 하나를 쓴다(contract.ts).
import { FORBIDDEN_FIELD_NAMES as V1_FORBIDDEN_FIELD_NAMES } from "../v1/index.ts";

export type SchemaFault = "malformed" | "unknown";

export class SchemaError extends Error {
  constructor(
    readonly fault: SchemaFault,
    readonly path: string,
  ) {
    super(`${fault} at ${path}`);
  }
}

export type Parser<T> = (value: unknown, path: string) => T;

const fail = (path: string): never => {
  throw new SchemaError("malformed", path);
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ACTION_NAME = /^[a-z_]{1,40}$/;
export const NONCE = /^[0-9a-f]{32}$/;

export function pattern(re: RegExp): Parser<string> {
  return (value, path) => (typeof value === "string" && re.test(value) ? value : fail(path));
}

export const uuid = pattern(UUID);
export const sha256 = pattern(SHA256);
export const revision = pattern(REVISION);

export function int(min: number, max = Number.MAX_SAFE_INTEGER): Parser<number> {
  return (value, path) => (Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max ? (value as number) : fail(path));
}
// 시각은 Unix epoch 밀리초 정수다.
export const time = int(1);
// 정지 세대·실행 세대는 0 이상의 정수다(v1 머리의 stop_generation과 같은 꼴).
export const generation = int(0);

export function literal<const T extends string | number | boolean>(expected: T): Parser<T> {
  return (value, path) => (value === expected ? expected : fail(path));
}

export function oneOf<const T extends string>(values: readonly T[]): Parser<T> {
  return (value, path) => (typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : fail(path));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

type Shape = Record<string, Parser<unknown>>;
export type Parsed<S extends Shape> = { [K in keyof S]: S[K] extends Parser<infer T> ? T : never };

export function object<S extends Shape>(shape: S): Parser<Parsed<S>> {
  return (value, path) => {
    if (!isPlainObject(value)) return fail(path);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(shape, key)) throw new SchemaError("unknown", `${path}.${key}`);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      if (!Object.hasOwn(value, key)) return fail(`${path}.${key}`);
      out[key] = shape[key]!(value[key], `${path}.${key}`);
    }
    return out as Parsed<S>;
  };
}

// outcome 값으로 갈래를 고르는 닫힌 해석기. 효과의 확정 결과(job_status의 confirmed.result)를 묶음들이 이것으로 만든다.
export function byOutcome<T>(cases: Readonly<Record<string, Parser<T>>>): Parser<T> {
  return (value, path) => {
    if (!isPlainObject(value)) throw new SchemaError("malformed", path);
    const outcome = value.outcome;
    if (typeof outcome !== "string" || !Object.hasOwn(cases, outcome)) throw new SchemaError("malformed", `${path}.outcome`);
    return cases[outcome]!(value, path);
  };
}

// 원문 참조: 원문 저장소가 발행한 `<저장소 이름>/<UUID>`. 장부(src/ledger/input.ts)의 SOURCE_REF와 같은 꼴이다(계약 모듈은 장부를
// import하지 않으므로 다시 두고, 같은지는 시험이 대조한다). 공백·문장이 이 꼴이 될 수 없어 원문이 참조 칸으로 새지 않는다.
// 입력의 접수와 잊기 이벤트가 함께 쓴다.
export const SOURCE_REF = /^[a-z][a-z0-9-]{0,31}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const sourceRefId: Parser<string> = pattern(SOURCE_REF);

// 효과 동작의 본문: 보낸 쪽이 정한 job_id를 맨 위 칸으로 갖는 닫힌 객체. 묶음은 이것으로 본문 해석기를 만든다.
export function effectBody<S extends Shape>(shape: S): Parser<Parsed<S & { job_id: Parser<string> }>> {
  return object({ ...shape, job_id: uuid });
}

// 칸 이름은 소문자로 바꾸고 -·_·공백을 지운 뒤 대조한다(v1과 같은 방법).
// 둘 다 막는 것: v1의 금지 이름(명령·이미지·볼륨·argv·환경·로그·사고 과정), 비밀, 원문.
// 원문(Discord 글의 본문)은 참조와 digest로만 오간다. 그 꼴은 묶음이 정하고, 여기서는 원문을 싣는 흔한 칸 이름을 막는다.
export const FORBIDDEN_FIELD_NAMES = [
  ...V1_FORBIDDEN_FIELD_NAMES,
  "token",
  "secret",
  "password",
  "apikey",
  "privatekey",
  "credential",
  "credentials",
  "rawmessage",
  "messagecontent",
  "originaltext",
  "rawtext",
] as const;
// 감독이 낸 본문만 막는 것: 승인·최종 목적지·권한의 주장. 모델이 만든 후보가 실릴 수 있는 쪽이라 이 칸이 있으면 안 된다.
// 승인 변화는 현관이 알리는 사실이라 현관이 낸 본문에는 막지 않는다(그 꼴은 묶음이 정한다).
export const SUPERVISOR_FORBIDDEN_FIELD_NAMES = [
  "approved",
  "approval",
  "approvals",
  "approvedby",
  "approver",
  "authorized",
  "authorization",
  "permission",
  "permissions",
  "destination",
  "destinations",
  "channelid",
  "webhook",
  "webhookurl",
] as const;

const normalizeName = (name: string) => name.toLowerCase().replace(/[-_\s]/g, "");

export function findForbidden(value: unknown, names: ReadonlySet<string>, path = "body", depth = 0): string | undefined {
  if (depth > 32 || typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbidden(value[i], names, `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (names.has(normalizeName(key))) return `${path}.${key}`;
    const hit = findForbidden(inner, names, `${path}.${key}`, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}
