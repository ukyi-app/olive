// 출력 묶음(후보): 감독이 현관에 부탁하는 답 글·확인 카드·게시·진행 표시와, 현관이 실행 세대의 권위 값을 얻는 조회 쌍.
// 감독이 내는 것은 모두 후보다. 최종 목적지, 승인 여부, 실제로 보낼 바이트의 공개 검사, 카드의 발급·문구·유효 시간은 현관이
// 정한다(설계 supervisor.md §4·§9.1). 그래서 본문에 승인·목적지·권한·보낼 글의 칸을 두지 않고, 후보의 바이트는 감독 쪽 결과
// 보관소에 두어 digest로만 가리킨다. 선로 형식과 검증뿐이고 장부·Discord를 다루지 않는다. 표와 이유는 v2.md "답·카드·게시·진행".
import type { Bundle, EffectSpec, ExchangeSpec, LookupOutcome, NoAnswerCause } from "./actions.ts";
import { type GenerationRules, generationShape } from "./generations.ts";
import { effectBody, generation, int, isPlainObject, object, oneOf, type Parser, sha256, uuid } from "./schema.ts";

// 넷 모두 받는 쪽(현관)의 지금 정지·실행 세대와 같아야 한다. 정지 준비가 현관 원장에 적힌 뒤의 옛 정지 세대 후보, 풀기 전 실행
// 세대의 늦은 후보(정지 중에 만들어져 풀린 뒤 닿은 것)를 서명이 맞아도 거절하려면 둘 다 필요하다.
export const OUTBOUND_GENERATIONS = { stop: "current", execution: "current" } as const satisfies GenerationRules;

// 진행의 고정된 단계(discord.md §5): 원인 확인, 패치 작성, 검증, PR, 끝났어요, 멈췄어요. 표시 문구는 현관이 이 이름에서 만든다.
export const PROGRESS_STAGES = ["cause", "patch", "verify", "pull_request", "done", "stopped"] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];
// "멈췄어요(이유 한 마디)"(discord.md §5)의 이유. stopped 단계에만, 이 닫힌 목록의 값 하나를 반드시 싣는다(관리자 결정 2026-11-19).
// 목록 자체는 후보다: 설계와 감독 코드에서 서로 구별되는 멈춤의 원인만 두었다. 표시 문구는 현관이 이 이름에서 만들고, 자유로운 글은
// 받지 않는다. "기타" 같은 뜻 없는 값은 두지 않는다. 비상 정지는 없다: 정지 중에는 이 효과를 받지 않고(닫힌 접수) 풀린 뒤에는
// 실행 세대가 올라 옛 후보가 거절되므로, 정지 때의 "멈췄어요"는 현관이 자기 정지 원장으로 쓴다.
export const PROGRESS_STOP_CAUSES = [
  // 실행 기한이 지났다(작업 취소 사유 deadline, 종료 영수증 exit deadline, 시작 전 deadline_passed).
  "deadline",
  // 남은 예산이 없다. 자동 연장·재시도가 예산을 새로 주지 않는다.
  "budget_exhausted",
  // 관리자가 취소했다(입력 취소, 작업 취소 사유 requested).
  "cancelled",
  // 시작하기 전에 입력이 만료됐다.
  "input_expired",
  // 방화벽·격리·자격 가림이 실패해 모델을 띄우지 않았다.
  "launch_refused",
  // 작업자가 실패로 끝났다(종료 영수증 exit failed, 결과 outcome failed).
  "worker_failed",
  // 결과 검사(모양·크기·출처 참조·digest·비밀 검사)가 결과를 거절했다.
  "result_rejected",
  // 네트워크 없는 검증이나 자체 리뷰가 통과 영수증을 내지 않았다.
  "verification_failed",
  // 실행기와의 연결을 잃어 종료를 확인하지 못했다(unknown_running).
  "executor_lost",
] as const;
export type ProgressStopCause = (typeof PROGRESS_STOP_CAUSES)[number];
// start: 일을 시작할 때의 한 줄(진행이 고칠 글). answer: 그 밖의 답. 경보 자동 진단의 시작(👀만)·두 번째 시작 글을 현관이 가른다.
export const REPLY_PURPOSES = ["start", "answer"] as const;
export const PUBLICATION_KINDS = ["pull_request", "pull_request_review", "knowledge_pull_request"] as const;

const uuidOrNull: Parser<string | null> = (value, path) => (value === null ? null : uuid(value, path));

// 업무 칸. input_job_id는 현관이 그 입력을 접수시킨 input_submit의 job_id다(input_cancel의 input_job_id와 같은 이름·꼴·뜻).
// 보낼 곳은 현관이 이 입력에서 고른다.
const REPLY_FIELDS = { input_job_id: uuid, purpose: oneOf(REPLY_PURPOSES), candidate_digest: sha256 };
const CARD_FIELDS = { input_job_id: uuid, candidate_digest: sha256 };
// job_id·candidate_digest·run_id는 장부 recordPublication의 frontJobId·candidateDigest·runId와 같은 식별이다.
const PUBLICATION_FIELDS = { kind: oneOf(PUBLICATION_KINDS), candidate_digest: sha256, run_id: uuidOrNull, input_job_id: uuidOrNull };
const PROGRESS_FIELDS = { input_job_id: uuid, stage: oneOf(PROGRESS_STAGES), seq: int(0) };
// stopped 단계만 이 칸을 더 가진다. 다른 단계의 본문은 이 칸이 없는 닫힌 꼴이라 실으면 unknown_field, stopped인데 없으면 body_malformed다.
const PROGRESS_STOP_FIELD = { stop_cause: oneOf(PROGRESS_STOP_CAUSES) };

export interface ReplyCandidate {
  job_id: string;
  input_job_id: string;
  purpose: (typeof REPLY_PURPOSES)[number];
  candidate_digest: string;
  stop_generation: number;
  execution_generation: number;
}
export interface ApprovalCardRequest {
  job_id: string;
  input_job_id: string;
  candidate_digest: string;
  stop_generation: number;
  execution_generation: number;
}
export interface PublicationCandidate {
  job_id: string;
  kind: (typeof PUBLICATION_KINDS)[number];
  candidate_digest: string;
  run_id: string | null;
  input_job_id: string | null;
  stop_generation: number;
  execution_generation: number;
}
interface ProgressUpdateCommon {
  job_id: string;
  input_job_id: string;
  seq: number;
  stop_generation: number;
  execution_generation: number;
}
export type ProgressUpdate =
  | (ProgressUpdateCommon & { stage: Exclude<ProgressStage, "stopped"> })
  | (ProgressUpdateCommon & { stage: "stopped"; stop_cause: ProgressStopCause });

// 확정 결과(job_status의 confirmed.result). 카드 요청의 결과에 승인은 없다: 승인은 현관의 이벤트로만 온다.
// 게시의 결과는 복원 포트(PublicationPort)의 확정 두 값과 같다.
export type ReplyResult = { outcome: "posted" } | { outcome: "refused" };
export type CardResult = { outcome: "shown" } | { outcome: "refused" };
export type PublicationResult = { outcome: "posted" } | { outcome: "not_posted" };
// superseded: 같은 입력에서 이 순번 이상을 이미 보여 무시했다.
export type ProgressResult = { outcome: "shown" } | { outcome: "superseded" } | { outcome: "refused" };

const outcomes = <const T extends string>(values: readonly T[]): Parser<{ outcome: T }> => object({ outcome: oneOf(values) });

const outboundBody = (fields: Record<string, Parser<unknown>>) => effectBody({ ...fields, ...generationShape(OUTBOUND_GENERATIONS) });

// 진행의 본문은 단계에 따라 두 닫힌 꼴 가운데 하나다. stage가 stopped가 아니면(틀린 값 포함) 이유 칸이 없는 꼴로 본다.
const parseProgressRunning = outboundBody(PROGRESS_FIELDS);
const parseProgressStopped = outboundBody({ ...PROGRESS_FIELDS, ...PROGRESS_STOP_FIELD });
const parseProgress: Parser<unknown> = (value, path) =>
  isPlainObject(value) && value.stage === "stopped" ? parseProgressStopped(value, path) : parseProgressRunning(value, path);

// 감독만 내고, 현관의 접수가 닫혀 있으면(정지 중 게시·승인 닫힘, §7.3의 1) 받지 않는다.
function outboundEffect(parseBody: Parser<unknown>, parseResult: Parser<unknown>): EffectSpec {
  return {
    class: "effect",
    from: ["supervisor"],
    duringClosedIntake: false,
    duringPolicyMismatch: false,
    generations: OUTBOUND_GENERATIONS,
    parse: (body) => parseBody(body, "body"),
    parseResult,
  };
}

// ---- 현관의 실행 세대 권위 값 ----

export interface ExecutionGenerationReply {
  in_reply_to: string;
  generation: number;
}

// 현관이 묻고 감독이 장부의 지금 실행 세대(run_epoch)로 답한다. 효과가 없고 세대를 싣지 않으므로 감독의 접수가 닫혀도,
// 정책이 어긋난 연결에서도 오간다(계약 판이 뜻을 고정한 사실). 감독이 자기 값을 모르면 답하지 않는다: 모름 상태의 답은 없다.
// 현관은 답의 generation을 adoptExecutionGeneration(generations.ts)으로 받는다. 풀기 확정 값도 같은 함수라 두 길의 규칙이 같다.
const executionGenerationLookup: ExchangeSpec = {
  class: "query",
  from: ["front-door"],
  duringClosedIntake: true,
  duringPolicyMismatch: true,
  parse: (body) => object({})(body, "body"),
};
const executionGenerationReply: ExchangeSpec = {
  class: "query",
  from: ["supervisor"],
  duringClosedIntake: true,
  duringPolicyMismatch: true,
  parse: (body) => object({ in_reply_to: uuid, generation })(body, "body"),
  answers: (awaitedAction) => awaitedAction === "execution_generation_lookup",
};

// ---- 게시 조회의 결론 ----

// main의 PublicationPort.lookup이 돌려주는 두 갈래와 같은 꼴. 모름은 값이 아니라 예외다(PublicationUnknown).
export type PublicationLookup = { kind: "confirmed"; outcome: "posted" | "not_posted" } | { kind: "pending" };

// unknown: 현관이 답했지만 모른다고 했다. 나머지는 답을 받지 못했거나(timeout·disconnected) 받은 답을 쓸 수 없다(reply_rejected).
export class PublicationUnknown extends Error {
  constructor(readonly reason: NoAnswerCause | "unknown") {
    super(`게시 결과를 모름(${reason})`);
    this.name = "PublicationUnknown";
  }
}

// 게시 후보 작업(publication_candidate)에 대한 한 번의 물음(바로 답이나 같은 job_id의 job_lookup)의 결론을 포트의 뜻으로 옮긴다.
// 가장 큰 함정은 시간 초과나 모름을 not_posted로 바꾸는 것이다(복원기가 다시 게시할 수 있다고 본다). 그래서 not_posted는 검증을
// 통과한 confirmed의 결과 한 가지에서만 나오고, 타입을 어긴 입력도 런타임에 다시 보아 모름으로 던진다.
export function publicationLookupOf(outcome: LookupOutcome): PublicationLookup {
  if (outcome.answered !== true) throw new PublicationUnknown(outcome.cause);
  const status: unknown = outcome.status;
  if (!isPlainObject(status)) throw new PublicationUnknown("reply_rejected");
  if (status.state === "pending") return { kind: "pending" };
  if (status.state === "unknown") throw new PublicationUnknown("unknown");
  if (status.state === "confirmed" && isPlainObject(status.result)) {
    const result = status.result.outcome;
    if (result === "posted" || result === "not_posted") return { kind: "confirmed", outcome: result };
  }
  throw new PublicationUnknown("reply_rejected");
}

// 검증한 게시 후보를 장부 recordPublication의 입력 이름으로 옮긴다(송신 전 기록과 같은 식별).
export function publicationLinkOf(body: PublicationCandidate): { frontJobId: string; candidateDigest: string; runId: string | null } {
  return { frontJobId: body.job_id, candidateDigest: body.candidate_digest, runId: body.run_id };
}

// 이 묶음의 본문과 확정 결과가 가질 수 있는 칸 이름 전부. 금지 이름과 부딪히지 않는다는 것을 시험이 본다.
export const EFFECTS_FIELD_NAMES: readonly string[] = Object.freeze([
  ...new Set([
    "job_id",
    "stop_generation",
    "execution_generation",
    ...Object.keys(REPLY_FIELDS),
    ...Object.keys(CARD_FIELDS),
    ...Object.keys(PUBLICATION_FIELDS),
    ...Object.keys(PROGRESS_FIELDS),
    ...Object.keys(PROGRESS_STOP_FIELD),
    "outcome",
    "in_reply_to",
    "generation",
  ]),
]);

export const EFFECTS_BUNDLE: Bundle = {
  name: "effects",
  actions: {
    reply_candidate: outboundEffect(outboundBody(REPLY_FIELDS), outcomes(["posted", "refused"])),
    approval_card_request: outboundEffect(outboundBody(CARD_FIELDS), outcomes(["shown", "refused"])),
    publication_candidate: outboundEffect(outboundBody(PUBLICATION_FIELDS), outcomes(["posted", "not_posted"])),
    progress_update: outboundEffect(parseProgress, outcomes(["shown", "superseded", "refused"])),
    execution_generation_lookup: executionGenerationLookup,
    execution_generation_reply: executionGenerationReply,
  },
};
