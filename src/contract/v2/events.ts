// 이벤트 묶음(후보): 현관이 알리는 사실 넷(현관 → 감독). 승인 변화, 게시 변화, 병합 관측, 잊기. 넷은 각각의 동작이라 넷 밖의
// 종류는 동작 표에 없어 unknown_action이다. 선로 형식과 검증뿐이고, 같은 사실을 한 번만 적용하는 일과 늦은 순번을 버리는 일은
// 감독의 처리기와 장부가 한다.
// 승인은 현관이 검증한 관리자 이벤트에서만 생긴다(spec §6의 2, D-30). 그래서 승인 변화는 현관만 내고, 본문에 글 칸이 없다:
// 모델의 글이 승인 사실로 올라갈 자리가 없다. 감독이 낸 본문의 승인 이름은 공통부가 막는다(SUPERVISOR_FORBIDDEN_FIELD_NAMES).
import type { Bundle, EffectSpec } from "./actions.ts";
import { type GenerationRules, generationShape } from "./generations.ts";
import { effectBody, int, literal, object, oneOf, type Parser, pattern, sha256, sourceRefId, uuid } from "./schema.ts";

// 세대 규칙(v2.md "세대를 고른 이유").
// - approval_changed는 한 정지 세대 안의 사실이라 current다. 정지를 건너온 승인은 받지 않는다(닫힌 쪽). 정지 세대가 바뀌면 처리기는
//   받아 둔 승인 사실을 버려야 옛 세대의 무효·만료가 거절돼도 승인이 남지 않는다(인계 문서).
// - 나머지 셋은 바깥에서 이미 일어난 사실이라 세대와 무관하다. 정지 중·복원 1단계에도 받아야 잃지 않는다.
export const EVENT_GENERATIONS = {
  approval_changed: { stop: "current", execution: "not_applicable" },
  publication_changed: { stop: "not_applicable", execution: "not_applicable" },
  merge_observed: { stop: "not_applicable", execution: "not_applicable" },
  source_forgotten: { stop: "not_applicable", execution: "not_applicable" },
} as const satisfies Record<string, GenerationRules>;

export const EVENT_ACTIONS = ["approval_changed", "publication_changed", "merge_observed", "source_forgotten"] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];

// 확인 카드의 상태 변화(discord.md §3): 승인(`올려`), 거절(`취소`), 24시간 만료, 내용·대상·보호 경로가 바뀌어 무효.
export const APPROVAL_STATES = ["approved", "declined", "expired", "invalidated"] as const;
// 게시의 상태 변화(후보): 게시함, 게시하지 않음(현관의 검사에 걸림 등), 병합 없이 닫힘. 병합은 merge_observed로 따로 온다.
export const PUBLICATION_STATES = ["posted", "not_posted", "closed"] as const;
// 병합 커밋: git SHA-1의 소문자 16진(후보. GitHub 저장소의 객체 이름 꼴).
export const MERGE_COMMIT = /^[0-9a-f]{40}$/;

// 순번은 대상(카드, 게시)마다 1부터 오른다. 같은 대상에서 적용한 것보다 크지 않은 순번은 처리기가 버린다.
const seq = int(1);

export interface ApprovalChanged {
  job_id: string;
  stop_generation: number;
  // 감독이 낸 확인 카드 요청의 job_id(감독 → 현관 효과).
  card_job_id: string;
  candidate_digest: string;
  seq: number;
  state: (typeof APPROVAL_STATES)[number];
}
export interface PublicationChanged {
  job_id: string;
  // 감독이 낸 게시 요청의 job_id(감독 → 현관 효과).
  publication_job_id: string;
  candidate_digest: string;
  seq: number;
  state: (typeof PUBLICATION_STATES)[number];
}
export interface MergeObserved {
  job_id: string;
  publication_job_id: string;
  merge_commit: string;
}
export interface SourceForgotten {
  job_id: string;
  // 잊을 원문의 참조 하나. 원문은 싣지 않는다.
  source_ref: string;
}

// 확정 결과: 감독이 그 사실을 적었다. 사실이라 거절 결과가 없다: 적지 못하면 확정하지 않는다(pending·unknown).
export type EventResult = { outcome: "recorded" };
const parseEventResult: Parser<EventResult> = object({ outcome: literal("recorded") });

function event(rules: GenerationRules, parseBody: Parser<unknown>): EffectSpec {
  return {
    class: "effect",
    from: ["front-door"],
    // 사실의 통지라 감독의 접수가 닫혀도 받는다(정지 중의 무효·만료·병합·잊기를 잃지 않게).
    duringClosedIntake: true,
    duringPolicyMismatch: false,
    generations: rules,
    parse: (body) => parseBody(body, "body"),
    parseResult: parseEventResult,
  };
}

const parseApprovalChanged = effectBody({
  card_job_id: uuid,
  candidate_digest: sha256,
  seq,
  state: oneOf(APPROVAL_STATES),
  ...generationShape(EVENT_GENERATIONS.approval_changed),
});
const parsePublicationChanged = effectBody({
  publication_job_id: uuid,
  candidate_digest: sha256,
  seq,
  state: oneOf(PUBLICATION_STATES),
  ...generationShape(EVENT_GENERATIONS.publication_changed),
});
const parseMergeObserved = effectBody({ publication_job_id: uuid, merge_commit: pattern(MERGE_COMMIT), ...generationShape(EVENT_GENERATIONS.merge_observed) });
const parseSourceForgotten = effectBody({ source_ref: sourceRefId, ...generationShape(EVENT_GENERATIONS.source_forgotten) });

export const EVENT_BUNDLE: Bundle = {
  name: "events",
  actions: {
    approval_changed: event(EVENT_GENERATIONS.approval_changed, parseApprovalChanged),
    publication_changed: event(EVENT_GENERATIONS.publication_changed, parsePublicationChanged),
    merge_observed: event(EVENT_GENERATIONS.merge_observed, parseMergeObserved),
    source_forgotten: event(EVENT_GENERATIONS.source_forgotten, parseSourceForgotten),
  },
};
