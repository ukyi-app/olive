// olive-control/v2(후보)의 공개 면. 감독 구현은 이 파일만 import한다. 현관과 감독 사이의 계약이고, 실행기 연결은 v1이다.
import { COMMON_BUNDLE } from "./actions.ts";
import { CANDIDATE_BUNDLE } from "./candidates.ts";
import { defineContract } from "./contract.ts";
import { EFFECTS_BUNDLE } from "./effects.ts";
import { EVENT_BUNDLE } from "./events.ts";
import { INPUT_BUNDLE } from "./inputs.ts";
import { STOP_BUNDLE } from "./stop.ts";

// 동작 표. 본문 묶음은 이 목록에 더한다(첫 자리는 늘 공통부). 표는 여기서 한 번 만들어 얼린다.
export const FRONTDOOR_CONTRACT = defineContract([COMMON_BUNDLE, STOP_BUNDLE, INPUT_BUNDLE, EVENT_BUNDLE, EFFECTS_BUNDLE, CANDIDATE_BUNDLE]);

export {
  type ActionClass,
  type ActionSpec,
  type ActionTable,
  type Awaited,
  type Bundle,
  COMMON_BUNDLE,
  EFFECTS_DURING_POLICY_MISMATCH,
  type EffectSpec,
  type ExchangeSpec,
  type HandshakeState,
  isSettled,
  type JobRef,
  type JobStatus,
  type JobStatusReply,
  type LookupOutcome,
  type NoAnswerCause,
} from "./actions.ts";
export {
  ASSEMBLY_FAULTS,
  type AssemblyFault,
  assembleCandidate,
  CANDIDATE_BUNDLE,
  CANDIDATE_CONTENT_FIELD,
  CANDIDATE_FIELD_NAMES,
  type CandidateAssembly,
  type CandidateChunkReply,
  type CandidateFetch,
  type CandidateFetchOutcome,
  type CandidatePiece,
  candidateDigestOf,
  candidatePieceOf,
} from "./candidates.ts";
export {
  afterHandshake,
  type Contract,
  type Envelope,
  type NonceStore,
  type Rejected,
  SealError,
  type SealInput,
  signingBytes,
  type Verified,
  type VerifyContext,
} from "./contract.ts";
export {
  type ApprovalCardRequest,
  type CardResult,
  EFFECTS_BUNDLE,
  EFFECTS_FIELD_NAMES,
  type ExecutionGenerationReply,
  OUTBOUND_GENERATIONS,
  PROGRESS_STAGES,
  type ProgressResult,
  type ProgressStage,
  type ProgressUpdate,
  PUBLICATION_KINDS,
  type PublicationCandidate,
  type PublicationLookup,
  type PublicationResult,
  PublicationUnknown,
  publicationLinkOf,
  publicationLookupOf,
  REPLY_PURPOSES,
  type ReplyCandidate,
  type ReplyResult,
} from "./effects.ts";
export { REJECT_REASONS, type RejectReason } from "./errors.ts";
export {
  adoptExecutionGeneration,
  type ExecutionGenerationOutcome,
  GENERATION_FIELDS,
  GENERATION_KINDS,
  GENERATION_RULES,
  type GenerationAuthorities,
  type GenerationAuthority,
  type GenerationKind,
  type GenerationRule,
  type GenerationRules,
  generationShape,
} from "./generations.ts";
export { type Header, PARTIES, type Party } from "./header.ts";
export * as limits from "./limits.ts";
export { CONTRACT } from "./limits.ts";
export { FORBIDDEN_FIELD_NAMES, SOURCE_REF, SUPERVISOR_FORBIDDEN_FIELD_NAMES } from "./schema.ts";
export {
  latestStopOf,
  type ReleaseCommit,
  type ReleaseCommitResult,
  type ReleasePrepareResult,
  STOP_BUNDLE,
  STOP_GENERATIONS,
  type StopCommitResult,
  type StopPrepareResult,
  type StopRecord,
  type StopRecordOutcome,
  type StopRecordReply,
  StopRecordUnknown,
  type StopStep,
} from "./stop.ts";
export {
  INPUT_BUNDLE,
  INPUT_GENERATIONS,
  INPUT_SOURCES,
  type InputCancel,
  type InputCancelResult,
  type InputSource,
  type InputSubmit,
  type InputSubmitResult,
  type SourceRef,
} from "./inputs.ts";
export {
  APPROVAL_STATES,
  type ApprovalChanged,
  EVENT_ACTIONS,
  EVENT_BUNDLE,
  EVENT_GENERATIONS,
  type EventAction,
  type EventResult,
  MERGE_COMMIT,
  type MergeObserved,
  PUBLICATION_STATES,
  type PublicationChanged,
  type SourceForgotten,
} from "./events.ts";
