// 입력 묶음(후보): 현관이 인증한 요청의 접수와 그 취소(현관 → 감독). 선로 형식과 검증뿐이고 장부에 쓰지 않는다.
// 원문(Discord 글의 본문)은 싣지 않는다: 원문 저장소가 발행한 참조, 원문의 digest, 원문의 만료만 오간다(관리자 결정 2026-11-19).
// 같은 요청의 재전달과 같은 ID 다른 본문의 충돌은 공통부의 작업 ID·request_digest로 보이고, 가르는 일은 장부가 한다.
import type { Bundle, EffectSpec } from "./actions.ts";
import { type GenerationRules, generationShape } from "./generations.ts";
import { byOutcome, effectBody, literal, object, oneOf, type Parser, sha256, sourceRefId, time, uuid } from "./schema.ts";

// 세대 규칙. 받는 쪽(감독)의 권위 값 기준이다(v2.md "입력·취소·이벤트"의 "세대를 고른 이유").
// - input_submit은 새 일이라 지금 정지 세대에 묶는다. 정지를 건너온 입력은 받지 않는다.
// - input_cancel은 일을 줄이기만 하고 정지 중·복원 1단계에서도 받아야 해서 세대와 무관하다. current면 정지 준비~확정 사이
//   (현관 원장은 새 세대, 감독은 옛 세대)와 감독이 세대를 모르는 동안 취소가 막힌다.
export const INPUT_GENERATIONS = {
  input_submit: { stop: "current", execution: "not_applicable" },
  input_cancel: { stop: "not_applicable", execution: "not_applicable" },
} as const satisfies Record<string, GenerationRules>;

// 출처 이름(후보): 현관이 관리자·서버·채널·대화 소유자를 검사한 관리자 요청인가, 자동 경보인가. 장부 enqueueInput의 source에
// 그대로 들어가고 장부는 이름을 분류하지 않으므로, 목록을 닫아 두는 곳은 여기다(장부의 REF 꼴에 맞는지는 시험이 본다).
export const INPUT_SOURCES = ["admin", "alert"] as const;
export type InputSource = (typeof INPUT_SOURCES)[number];

// ref는 원문 참조(schema.ts의 SOURCE_REF 꼴). digest는 원문의 SHA-256(소문자 16진), expires_at은 원문의 만료(밀리초). 만료가 지났는지·168시간(D-22) 안인지는 계약이 보지 않는다:
// 봉투를 만들 때는 받는 시각이 없어 만들기와 받기가 같은 꼴만 보게 둔다. 그 확인은 처리기의 일이다.
export interface SourceRef {
  ref: string;
  digest: string;
  expires_at: number;
}
export const parseSourceRef: Parser<SourceRef> = object({ ref: sourceRefId, digest: sha256, expires_at: time });

export interface InputSubmit {
  // 요청 식별자. 장부 enqueueInput의 requestId이고 작업 ID다.
  job_id: string;
  stop_generation: number;
  source: InputSource;
  source_ref: SourceRef;
}
export interface InputCancel {
  job_id: string;
  // 취소할 입력의 job_id(= 장부 cancelInput의 requestId).
  input_job_id: string;
}

// 확정 결과(job_status의 confirmed.result).
// queued: 장부에 접수를 적었다. refused: 감독이 받지 않았다(같은 ID 다른 본문 등. 사유 목록은 정하지 않았다).
export type InputSubmitResult = { outcome: "queued" } | { outcome: "refused" };
// cancelled: 입력에 취소를 적었다(이미 도는 실행이 멈췄다는 뜻은 아니다). not_found: 감독이 그 입력을 모른다.
export type InputCancelResult = { outcome: "cancelled" } | { outcome: "not_found" };

const parseInputSubmitResult = byOutcome<InputSubmitResult>({
  queued: object({ outcome: literal("queued") }),
  refused: object({ outcome: literal("refused") }),
});
const parseInputCancelResult = byOutcome<InputCancelResult>({
  cancelled: object({ outcome: literal("cancelled") }),
  not_found: object({ outcome: literal("not_found") }),
});

function inputEffect(rules: GenerationRules, duringClosedIntake: boolean, parseBody: Parser<unknown>, parseResult: Parser<unknown>): EffectSpec {
  return {
    class: "effect",
    from: ["front-door"],
    duringClosedIntake,
    duringPolicyMismatch: false,
    generations: rules,
    parse: (body) => parseBody(body, "body"),
    parseResult,
  };
}

const parseInputSubmit = effectBody({ source: oneOf(INPUT_SOURCES), source_ref: parseSourceRef, ...generationShape(INPUT_GENERATIONS.input_submit) });
const parseInputCancel = effectBody({ input_job_id: uuid, ...generationShape(INPUT_GENERATIONS.input_cancel) });

export const INPUT_BUNDLE: Bundle = {
  name: "inputs",
  actions: {
    // 새 일이라 감독의 접수가 닫히면 받지 않는다(intake_closed). 정지 중·복원 중에는 접수가 닫혀 있다(§8의 1, §7.3).
    input_submit: inputEffect(INPUT_GENERATIONS.input_submit, false, parseInputSubmit, parseInputSubmitResult),
    // 정지 중에도 취소는 받는다.
    input_cancel: inputEffect(INPUT_GENERATIONS.input_cancel, true, parseInputCancel, parseInputCancelResult),
  },
};
