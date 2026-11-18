// 의존 패키지 없이 쓰는 엄격한 스키마 도구. 모든 객체는 닫혀 있다: 모르는 칸은 거절하고 빠진 칸도 거절한다.
// 선택 칸은 두지 않는다. 값이 없을 수 있는 칸은 null로 늘 싣는다. 칸이 있을 때와 없을 때 digest가 갈리는 길을 없앤다.
export type SchemaFault = "malformed" | "unknown" | "forbidden";

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

export function literal<const T extends string | number | boolean>(expected: T): Parser<T> {
  return (value, path) => (value === expected ? expected : fail(path));
}

export function oneOf<const T extends string>(values: readonly T[]): Parser<T> {
  return (value, path) => (typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : fail(path));
}

export function nullable<T>(inner: Parser<T>): Parser<T | null> {
  return (value, path) => (value === null ? null : inner(value, path));
}

export function list<T>(inner: Parser<T>, min: number, max: number, unique = false): Parser<T[]> {
  return (value, path) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) return fail(path);
    const out = value.map((item, i) => inner(item, `${path}[${i}]`));
    if (unique && new Set(out).size !== out.length) return fail(path);
    return out;
  };
}

// 사람이 읽는 짧은 글. 제어 문자(줄바꿈·탭 제외)와 짝 없는 서로게이트, 빈 글을 받지 않는다.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Zl}\p{Zp}\p{Bidi_Control}]/u;
export function text(maxChars: number): Parser<string> {
  return (value, path) =>
    typeof value === "string" && value.isWellFormed() && value.trim().length > 0 && [...value].length <= maxChars && !CONTROL.test(value)
      ? value
      : fail(path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
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

// 실행기가 지시에서 받지 않는 것(§9.2: 명령, 이미지, 볼륨, argv, 환경)과 결과에 싣지 않는 것(원문 로그, 사고 과정)의 칸 이름.
// 엄격한 스키마가 어차피 모르는 칸을 거절하지만, 이 이름은 깊이와 무관하게 먼저 찾아 forbidden_field로 따로 거절한다.
// 이름은 소문자로 바꾸고 -·_·공백을 지운 뒤 대조한다.
export const FORBIDDEN_FIELD_NAMES = [
  "command",
  "commands",
  "cmd",
  "entrypoint",
  "shell",
  "exec",
  "image",
  "images",
  "imageref",
  "volume",
  "volumes",
  "mount",
  "mounts",
  "hostpath",
  "argv",
  "args",
  "arguments",
  "env",
  "envs",
  "environment",
  "envvars",
  "log",
  "logs",
  "rawlog",
  "stdout",
  "stderr",
  "transcript",
  "thinking",
  "reasoning",
] as const;
const FORBIDDEN = new Set<string>(FORBIDDEN_FIELD_NAMES);
const normalizeName = (name: string) => name.toLowerCase().replace(/[-_\s]/g, "");

export function findForbidden(value: unknown, path = "body", depth = 0): string | undefined {
  if (depth > 32 || typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbidden(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (FORBIDDEN.has(normalizeName(key))) return `${path}.${key}`;
    const hit = findForbidden(inner, `${path}.${key}`, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}
