// 서명과 digest가 보는 바이트는 이 직렬화 하나뿐이다. RFC 8785(JCS)의 부분집합이다.
// - 객체의 키는 UTF-16 코드 단위 순서로 정렬한다(JCS와 같다. 계약의 키는 모두 ASCII라 바이트 순서와도 같다).
// - 공백이 없다. 문자열은 JSON.stringify의 이스케이프(JCS와 같다)를 쓴다.
// - 숫자는 안전 정수(±(2^53-1))만 받는다. 소수·지수·NaN·무한대가 오면 직렬화하지 않는다. -0은 0으로 쓴다.
//   소수를 막는 이유: 구현마다 소수의 최단 표기가 달라질 수 있어 같은 뜻이 다른 바이트가 된다.
// - 짝이 없는 서로게이트가 든 문자열, 빈 칸이 있는 배열, undefined, 평범한 객체가 아닌 값은 받지 않는다.
// 그래서 받는 쪽이 받은 바이트가 아니라 해석한 값에서 이 바이트를 다시 만들어도 보낸 쪽과 같다.
// 함정: 같은 키가 두 번 든 JSON 글은 해석기마다 고르는 값이 다를 수 있다. 바이트 틀(뒤 작업)이 그런 글을 거절해야 한다.
import { createHash } from "node:crypto";
import { MAX_DEPTH } from "./limits.ts";

export class CanonicalError extends Error {
  constructor(readonly why: string) {
    super(`canonical: ${why}`);
  }
}

export function canonicalJson(value: unknown): string {
  return write(value, 0);
}

function write(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new CanonicalError("too_deep");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalError("not_safe_integer");
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      if (!value.isWellFormed()) throw new CanonicalError("lone_surrogate");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) throw new CanonicalError("sparse_array");
          parts.push(write(value[i], depth + 1));
        }
        return `[${parts.join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalError("not_plain_object");
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${write(record[key], depth + 1)}`).join(",")}}`;
    }
    default:
      throw new CanonicalError(`unsupported_${typeof value}`);
  }
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(utf8Bytes(text)).digest("hex");
}

// 본문 digest: 정규 직렬화의 UTF-8 바이트에 대한 SHA-256, 소문자 16진 64자.
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
