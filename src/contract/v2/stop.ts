// 정지 묶음(후보): 정지·풀기의 준비와 확정(현관 → 감독), 권위 정지 기록의 조회(감독 → 현관)와 그 답. 선로 형식과 검증뿐이고
// 장부의 정지 상태를 바꾸지 않는다. 정지와 풀기를 시작하는 권한은 CLI와 현관의 원장에 있어(설계 §7.3·§7.6) 본문에 승인·권한 칸을
// 두지 않는다. 각 단계의 약속과 실행 세대의 교환은 v2.md "정지·풀기·권위 조회".
import type { Bundle, EffectSpec, ExchangeSpec, NoAnswerCause } from "./actions.ts";
import { type GenerationRules, generationShape } from "./generations.ts";
import { effectBody, generation, isPlainObject, literal, object, type Parser, SchemaError, uuid } from "./schema.ts";

// 세대 규칙. 규칙은 받는 쪽(감독)의 권위 값 기준이다. 감독의 generations.stop.prepared는 받아 두고 확정하지 않은 준비의 정지
// 세대이고, 정지 준비(지금보다 큼)와 풀기 준비(지금과 같음)가 그 칸 하나를 함께 쓴다.
// - stop_prepare는 next가 아니라 newer다: 정지는 앞 정지를 포함하므로, 잃어버린 메시지로 생긴 세대 틈 때문에 새 정지가 막히면 안 된다.
// - release_commit의 정지 세대는 current가 아니라 prepared다: 새 정지 준비가 준비 칸을 덮은 뒤의 늦은 풀기 확정을 계약에서 거절한다
//   (정지가 이긴다). 실행 세대 next는 풀기가 실행 세대를 꼭 한 번 올린다는 것과, 올린 뒤의 재전달 거절을 맡는다.
export const STOP_GENERATIONS = {
  stop_prepare: { stop: "newer", execution: "not_applicable" },
  stop_commit: { stop: "prepared", execution: "not_applicable" },
  release_prepare: { stop: "current", execution: "not_applicable" },
  release_commit: { stop: "prepared", execution: "next" },
} as const satisfies Record<string, GenerationRules>;

export interface StopStep {
  job_id: string;
  stop_generation: number;
}
export interface ReleaseCommit extends StopStep {
  execution_generation: number;
}

// 확정 결과(job_status의 confirmed.result). 정지에는 거절 결과가 없다: 감독이 적지 못하면 확정하지 않는다(pending·unknown).
export type StopPrepareResult = { outcome: "prepared" };
export type StopCommitResult = { outcome: "stopped" };
// prepared의 execution_generation은 확정되면 감독이 적을 실행 세대다. 현관은 이 값을 release_commit에 실어 서명한다.
export type ReleasePrepareResult = { outcome: "prepared"; execution_generation: number } | { outcome: "refused" };
export type ReleaseCommitResult = { outcome: "released" } | { outcome: "refused" };

// outcome 값으로 갈래를 고르는 닫힌 해석기.
function byOutcome<T>(cases: Readonly<Record<string, Parser<T>>>): Parser<T> {
  return (value, path) => {
    if (!isPlainObject(value)) throw new SchemaError("malformed", path);
    const outcome = value.outcome;
    if (typeof outcome !== "string" || !Object.hasOwn(cases, outcome)) throw new SchemaError("malformed", `${path}.outcome`);
    return cases[outcome]!(value, path);
  };
}

const parseStopPrepareResult: Parser<StopPrepareResult> = object({ outcome: literal("prepared") });
const parseStopCommitResult: Parser<StopCommitResult> = object({ outcome: literal("stopped") });
const parseReleasePrepareResult: Parser<ReleasePrepareResult> = byOutcome<ReleasePrepareResult>({
  prepared: object({ outcome: literal("prepared"), execution_generation: generation }),
  refused: object({ outcome: literal("refused") }),
});
const parseReleaseCommitResult: Parser<ReleaseCommitResult> = byOutcome<ReleaseCommitResult>({
  released: object({ outcome: literal("released") }),
  refused: object({ outcome: literal("refused") }),
});

// 정지·풀기는 현관만 내고, 감독의 접수가 닫혀 있어도 받는다(정지는 언제든, 풀기는 감독이 접수를 닫은 채 진행한다, §7.6).
function stopEffect(rules: GenerationRules, parseResult: Parser<unknown>): EffectSpec {
  const parseBody = effectBody(generationShape(rules));
  return {
    class: "effect",
    from: ["front-door"],
    duringClosedIntake: true,
    duringPolicyMismatch: false,
    generations: rules,
    parse: (body) => parseBody(body, "body"),
    parseResult,
  };
}

// ---- 권위 정지 기록 ----

// 현관의 원장 기록. absent는 현관이 원장을 읽고 기록이 없다고 확인한 것이다. 빈 값(null, {})은 이 꼴이 아니라 거절된다.
export type StopRecord = { state: "recorded"; generation: number; stopped: boolean } | { state: "absent" };
export interface StopRecordReply {
  in_reply_to: string;
  record: StopRecord;
}

const bool: Parser<boolean> = (value, path) => {
  if (typeof value !== "boolean") throw new SchemaError("malformed", path);
  return value;
};

const parseStopRecord: Parser<StopRecord> = (value, path) => {
  if (!isPlainObject(value)) throw new SchemaError("malformed", path);
  switch (value.state) {
    case "recorded":
      return object({ state: literal("recorded"), generation, stopped: bool })(value, path);
    case "absent":
      return object({ state: literal("absent") })(value, path);
    default:
      throw new SchemaError("malformed", `${path}.state`);
  }
};
const parseStopRecordReply: Parser<StopRecordReply> = object({ in_reply_to: uuid, record: parseStopRecord });
const parseStopRecordLookup = object({});

// 감독이 한 번 물어 얻은 것. 답을 받지 못했으면(시간 초과, 끊김, 받은 답이 거절됨) 모름이고, 이 갈래는 기록을 실을 수 없다.
export type StopRecordOutcome = { answered: true; record: StopRecord } | { answered: false; cause: NoAnswerCause };

export class StopRecordUnknown extends Error {
  constructor(readonly reason: NoAnswerCause) {
    super(`권위 정지 기록을 모름(${reason})`);
    this.name = "StopRecordUnknown";
  }
}

// main의 StopAuthorityPort.latestStop()의 뜻으로 옮긴다: 기록이면 {generation, stopped}, 확인된 부재만 null, 모르면 던진다.
// 가장 큰 함정은 모름을 null로 바꾸는 것이다(복원기가 첫 설치로 보고 정지 세대 0을 적는다). 그래서 null은 검증을 통과한 답의
// absent 한 가지에서만 나오고, 타입을 어긴 입력(답 갈래에 null 기록 등)도 없음으로 새지 않게 런타임에 다시 본다.
export function latestStopOf(outcome: StopRecordOutcome): { generation: number; stopped: boolean } | null {
  if (outcome.answered !== true) throw new StopRecordUnknown(outcome.cause);
  const record = outcome.record as StopRecord | null | undefined;
  if (record?.state === "recorded") return { generation: record.generation, stopped: record.stopped };
  if (record?.state === "absent") return null;
  throw new StopRecordUnknown("reply_rejected");
}

// 정책이 어긋난 연결에서도 받는다(관리자 결정 2026-11-19: 정지 기록은 계약 판이 뜻을 고정한 사실이다). 세대를 싣지 않으므로
// 감독이 정지 세대를 모르는 복원 1단계에서도 오간다.
const stopRecordLookup: ExchangeSpec = {
  class: "query",
  from: ["supervisor"],
  duringClosedIntake: true,
  duringPolicyMismatch: true,
  parse: (body) => parseStopRecordLookup(body, "body"),
};
const stopRecord: ExchangeSpec = {
  class: "query",
  from: ["front-door"],
  duringClosedIntake: true,
  duringPolicyMismatch: true,
  parse: (body) => parseStopRecordReply(body, "body"),
  answers: (awaitedAction) => awaitedAction === "stop_record_lookup",
};

export const STOP_BUNDLE: Bundle = {
  name: "stop",
  actions: {
    stop_record_lookup: stopRecordLookup,
    stop_record: stopRecord,
    stop_prepare: stopEffect(STOP_GENERATIONS.stop_prepare, parseStopPrepareResult),
    stop_commit: stopEffect(STOP_GENERATIONS.stop_commit, parseStopCommitResult),
    release_prepare: stopEffect(STOP_GENERATIONS.release_prepare, parseReleasePrepareResult),
    release_commit: stopEffect(STOP_GENERATIONS.release_commit, parseReleaseCommitResult),
  },
};
