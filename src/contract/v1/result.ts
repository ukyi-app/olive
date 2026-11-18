// 작업자 결과의 모양과 크기. 오케스트레이터에게 가는 것은 이 모양뿐이다(O09 할 일 3).
// 원문 로그와 사고 과정을 실을 칸이 없다. 그런 이름의 칸은 forbidden_field로, 그 밖의 모르는 칸은 unknown_field로 거절된다.
// 글 칸은 모델이 쓴 것이라 믿지 않는 입력이다. 공개 검사는 현관이 나가는 바이트에 다시 한다.
import { canonicalJson, digestOf, utf8Bytes } from "./canonical.ts";
import { BodyReject } from "./header.ts";
import { RESULT_ITEM_MAX_CHARS, RESULT_MAX_BYTES, RESULT_MAX_ITEMS, RESULT_MAX_REFS, RESULT_SUMMARY_MAX_CHARS } from "./limits.ts";
import { ROLES } from "./role.ts";
import { list, nullable, object, oneOf, pattern, sha256, text } from "./schema.ts";

const shape = object({
  role: oneOf(ROLES),
  outcome: oneOf(["completed", "needs_input", "failed"]),
  summary: text(RESULT_SUMMARY_MAX_CHARS),
  items: list(
    object({
      kind: oneOf(["finding", "next_step", "risk", "question"]),
      text: text(RESULT_ITEM_MAX_CHARS),
    }),
    0,
    RESULT_MAX_ITEMS,
  ),
  // 출처 참조. ref는 공백 없는 ASCII다. artifact는 digest가 있어야 한다(작성 결과는 digest를 고정한 뒤 검증한다, §3의 5).
  refs: list(
    object({
      kind: oneOf(["artifact", "commit", "pull_request", "path"]),
      ref: pattern(/^[\x21-\x7e]{1,256}$/),
      digest: nullable(sha256),
    }),
    0,
    RESULT_MAX_REFS,
  ),
});
export type Result = ReturnType<typeof shape>;

export function parseResult(value: unknown, path: string): Result {
  const result = shape(value, path);
  if (result.refs.some((ref) => ref.kind === "artifact" && ref.digest === null)) throw new BodyReject("body_malformed");
  if (utf8Bytes(canonicalJson(result)).length > RESULT_MAX_BYTES) throw new BodyReject("result_too_large");
  return result;
}

// result_finalize.result_digest에 싣는 값.
export function resultDigest(result: Result): string {
  return digestOf(result);
}
