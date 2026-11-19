// olive-control/v2(후보)의 공개 면. 감독 구현은 이 파일만 import한다. 현관과 감독 사이의 계약이고, 실행기 연결은 v1이다.
import { COMMON_BUNDLE } from "./actions.ts";
import { defineContract } from "./contract.ts";

// 동작 표. 본문 묶음은 이 목록에 더한다(첫 자리는 늘 공통부). 표는 여기서 한 번 만들어 얼린다.
export const FRONTDOOR_CONTRACT = defineContract([COMMON_BUNDLE]);

export {
  type ActionClass,
  type ActionSpec,
  type ActionTable,
  type Awaited,
  type Bundle,
  COMMON_BUNDLE,
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
export { REJECT_REASONS, type RejectReason } from "./errors.ts";
export {
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
export { FORBIDDEN_FIELD_NAMES, SUPERVISOR_FORBIDDEN_FIELD_NAMES } from "./schema.ts";
