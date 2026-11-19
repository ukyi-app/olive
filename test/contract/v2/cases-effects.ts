// 출력 묶음(src/contract/v2/effects.ts)의 표본 사례. cases.ts의 buildCases가 앞 묶음 사례 뒤에 붙인다.
// 현관의 권위 값은 정지 묶음 사례가 끝난 뒤의 값이다: 정지 세대 8(현관 원장), 실행 세대 4(마지막 풀기 확정).
// 요청 ID·nonce는 0x60~0x6f, 작업·입력 ID는 0x70~0x7f를 쓴다(공통부 0x10대, 정지 묶음 0x20~0x3f).
import type { Envelope } from "../../../src/contract/v2/contract.ts";
import type { GenerationAuthorities, GenerationAuthority } from "../../../src/contract/v2/generations.ts";
import { accept, type Expect, type V2Case, type Variant, variant } from "./case-kit.ts";
import { baseContext, type CaseContext, envelope, id, type Keys, nonceOf } from "./support.ts";

const OK: Expect & { ok: true } = { ok: true, handshake_after: null };
const known = (current: number, prepared: number | null = null): GenerationAuthority => ({ known: true, current, prepared });
const FRONT_GENS: GenerationAuthorities = { stop: known(8), execution: known(4) };
const jobOf = (message: Envelope) => ({ job_id: (message.body as { job_id: string }).job_id, action: message.header.action, request_digest: message.header.body_digest });

const INPUT = id(0x7a);
const RUN = id(0x7b);
const REPLY_DIGEST = "1".repeat(64);
const CANDIDATE_DIGEST = "2".repeat(64);
const GEN = { stop_generation: 8, execution_generation: 4 };

export function buildEffectsCases(keys: Keys): V2Case[] {
  const fromSupervisor = (action: string, n: number, body: Record<string, unknown>) =>
    envelope(keys, { sender: "supervisor", recipient: "front-door", action, request_id: id(n), nonce: nonceOf(n) }, body);
  const fromFront = (action: string, n: number, body: Record<string, unknown>) =>
    envelope(keys, { sender: "front-door", recipient: "supervisor", action, request_id: id(n), nonce: nonceOf(n) }, body);
  // 현관: 인사가 끝났고 접수가 열려 있으며 세대를 안다.
  const atFront = (over: Partial<CaseContext> = {}) => baseContext("front-door", { handshake: "agreed", intake_open: true, generations: FRONT_GENS, ...over });
  const atSupervisor = (over: Partial<CaseContext> = {}) => baseContext("supervisor", { handshake: "agreed", intake_open: true, ...over });
  const awaitingOf = (request: Envelope) => ({ [request.header.request_id]: { action: request.header.action, job: jobOf(request) } });
  const statusOf = (n: number, request: Envelope, inReplyTo: string, status: Record<string, unknown>) => fromFront("job_status", n, { in_reply_to: inReplyTo, ...jobOf(request), status });

  // ---- 답 글 ----
  const replyMsg = fromSupervisor("reply_candidate", 0x60, { job_id: id(0x70), input_id: INPUT, purpose: "answer", candidate_digest: REPLY_DIGEST, ...GEN });
  const reply = accept(
    keys,
    "reply-candidate",
    "답 글의 후보. 글 대신 감독 쪽 결과 보관소의 digest만 싣고, 보낼 곳은 현관이 입력(input_id)에서 고른다. 정지·실행 세대는 현관의 지금 값(8, 4)",
    "front-door",
    atFront(),
    replyMsg,
    OK,
  );
  const replyPosted = accept(keys, "reply-candidate-posted", "답 글 후보의 바로 답: 확정 posted(현관이 공개 검사를 거쳐 보냈다)", "supervisor", atSupervisor({ awaiting: awaitingOf(replyMsg) }), statusOf(0x61, replyMsg, replyMsg.header.request_id, { state: "confirmed", result: { outcome: "posted" } }), OK);

  // ---- 확인 카드 ----
  const cardMsg = fromSupervisor("approval_card_request", 0x62, { job_id: id(0x71), input_id: INPUT, candidate_digest: CANDIDATE_DIGEST, ...GEN });
  const card = accept(keys, "approval-card-request", "보호 경로를 건드린 게시 후보에 확인 카드를 부탁한다. 카드의 문구·발급·만료는 현관이 정한다", "front-door", atFront(), cardMsg, OK);
  const cardShown = accept(
    keys,
    "approval-card-shown",
    "카드 요청의 바로 답: 확정 shown. 카드를 띄웠다는 것이지 승인이 아니다(승인은 현관의 이벤트로만 온다)",
    "supervisor",
    atSupervisor({ awaiting: awaitingOf(cardMsg) }),
    statusOf(0x63, cardMsg, cardMsg.header.request_id, { state: "confirmed", result: { outcome: "shown" } }),
    OK,
  );

  // ---- 게시 ----
  const publicationMsg = fromSupervisor("publication_candidate", 0x64, { job_id: id(0x72), kind: "pull_request", candidate_digest: CANDIDATE_DIGEST, run_id: RUN, input_id: INPUT, ...GEN });
  const publication = accept(
    keys,
    "publication-candidate",
    "PR 게시의 후보. job_id·candidate_digest·run_id는 감독 장부의 게시 연결(recordPublication)과 같은 식별이다. 현관이 다시 검사할 후보이고 실행 허가가 아니다",
    "front-door",
    atFront(),
    publicationMsg,
    OK,
  );
  const publicationPosted = accept(
    keys,
    "publication-candidate-posted",
    "게시 후보의 바로 답: 확정 posted",
    "supervisor",
    atSupervisor({ awaiting: awaitingOf(publicationMsg) }),
    statusOf(0x65, publicationMsg, publicationMsg.header.request_id, { state: "confirmed", result: { outcome: "posted" } }),
    OK,
  );
  // 바로 답을 잃은 감독이 재시작 복원(§8의 4)에서 같은 작업 ID로 묻는다. 정책이 어긋나도, 접수가 닫혀도 된다(이미 보낸 작업의 결과).
  const lookupMsg = fromSupervisor("job_lookup", 0x66, jobOf(publicationMsg));
  const lookup = accept(
    keys,
    "publication-lookup",
    "게시의 답을 잃은 감독이 같은 작업 ID·동작·요청 digest로 묻는다. 정책이 어긋난 연결, 닫힌 접수에서도 받는다",
    "front-door",
    atFront({ handshake: "policy_mismatch", intake_open: false }),
    lookupMsg,
    OK,
  );
  const lookupUnknown = accept(
    keys,
    "publication-lookup-unknown",
    "현관이 그 게시를 모른다고 답함. 받아들이는 답이지만 확정이 아니다: 감독은 not_posted로 읽지 않고 모름(PublicationUnknown)으로 적는다",
    "supervisor",
    atSupervisor({ handshake: "policy_mismatch", intake_open: false, awaiting: { [lookupMsg.header.request_id]: { action: "job_lookup", job: jobOf(publicationMsg) } } }),
    statusOf(0x67, publicationMsg, lookupMsg.header.request_id, { state: "unknown" }),
    OK,
  );

  // ---- 진행 ----
  const progressMsg = fromSupervisor("progress_update", 0x68, { job_id: id(0x73), input_id: INPUT, stage: "verify", seq: 3, ...GEN });
  const progress = accept(keys, "progress-update", "진행 표시: 고정된 단계 이름(verify = 검증)과 순번뿐이다. 표시 문구는 현관이 단계 이름에서 만든다", "front-door", atFront(), progressMsg, OK);

  // ---- 현관의 실행 세대 권위 값 ----
  const executionLookupMsg = fromFront("execution_generation_lookup", 0x69, {});
  const executionLookup = accept(
    keys,
    "execution-generation-lookup",
    "실행 세대를 모르는 현관(첫 설치, 기록 유실)이 감독의 지금 실행 세대를 묻는다. 세대 없이, 정책이 어긋난 연결과 닫힌 접수에서도 받는다",
    "supervisor",
    atSupervisor({ handshake: "policy_mismatch", intake_open: false }),
    executionLookupMsg,
    OK,
  );
  const executionReply = accept(
    keys,
    "execution-generation-reply",
    "감독이 장부의 지금 실행 세대(4)로 답한다. 현관은 이 값을 낮추지 않는 쪽으로만 받아 generations.execution에 쓴다(adoptExecutionGeneration)",
    "front-door",
    atFront({
      intake_open: false,
      generations: { stop: known(8), execution: { known: false } },
      awaiting: { [executionLookupMsg.header.request_id]: { action: "execution_generation_lookup", job: null } },
    }),
    fromSupervisor("execution_generation_reply", 0x6a, { in_reply_to: executionLookupMsg.header.request_id, generation: 4 }),
    OK,
  );

  const on = (base: V2Case) => (v: Variant) => variant(keys, base, v);
  const P = on(publication);
  return [
    reply,
    replyPosted,
    card,
    cardShown,
    publication,
    publicationPosted,
    lookup,
    lookupUnknown,
    progress,
    executionLookup,
    executionReply,
    P({
      name: "publication-candidate-intake-closed",
      description: "현관의 접수가 닫혔을 때(정지 중 게시·승인 닫힘) 온 게시 후보",
      reason: "intake_closed",
      changed: ["context.intake_open"],
      edit: (c) => void (c.context.intake_open = false),
      signer: null,
    }),
    P({
      name: "publication-candidate-claims-approval",
      description: "모델이 만든 후보에 승인 주장 칸. 승인은 현관이 검증한 관리자 이벤트에서만 생긴다",
      reason: "forbidden_field",
      changed: ["message.body.approved"],
      edit: (c) => void (c.message.body.approved = true),
    }),
    P({
      name: "publication-candidate-destination",
      description: "모델이 고른 최종 목적지 칸. 보낼 곳은 현관이 정한다",
      reason: "forbidden_field",
      changed: ["message.body.destination"],
      edit: (c) => void (c.message.body.destination = "https://github.example/ukyi-app/homelab"),
    }),
    P({
      name: "publication-candidate-repository",
      description: "금지 이름이 아닌 대상 칸(저장소). 후보 본문은 닫혀 있어 모델이 대상을 고를 칸이 없다",
      reason: "unknown_field",
      changed: ["message.body.repository"],
      edit: (c) => void (c.message.body.repository = "ukyi-app/homelab"),
    }),
    P({
      name: "publication-candidate-old-execution-generation",
      description: "풀기 전 실행 세대(3)의 늦은 게시 후보. 현관의 실행 세대는 4다",
      reason: "generation_mismatch",
      changed: ["message.body.execution_generation"],
      edit: (c) => void (c.message.body.execution_generation = 3),
    }),
    P({
      name: "publication-candidate-execution-unknown",
      description: "실행 세대를 모르는 현관(첫 설치, 기록 유실)에 온 게시 후보. 모르면 닫고 execution_generation_lookup으로 채운다",
      reason: "generation_unknown",
      changed: ["context.generations.execution"],
      edit: (c) => void (c.context.generations = { ...c.context.generations, execution: { known: false } }),
      signer: null,
    }),
    P({
      name: "publication-candidate-from-front-door",
      description: "현관이 자기 키로 서명해 감독에게 낸 게시 후보. 후보는 감독만 낸다",
      reason: "wrong_direction",
      changed: ["message.header.sender", "message.header.recipient", "context.expected_recipient", "keys"],
      edit: (c) => {
        c.message.header.sender = "front-door";
        c.message.header.recipient = "supervisor";
        c.context.expected_recipient = "supervisor";
      },
    }),
    on(publicationPosted)({
      name: "publication-status-unknown-as-result",
      description: "모름을 확정 결과에 숨긴 답(outcome unknown). 게시의 확정 결과는 posted·not_posted뿐이다",
      reason: "body_malformed",
      changed: ["message.body.status.result.outcome"],
      edit: (c) => void ((c.message.body.status as { result: { outcome: string } }).result.outcome = "unknown"),
    }),
    on(lookupUnknown)({
      name: "publication-lookup-unknown-with-result",
      description: "모름 답에 결과 칸(not_posted)을 붙임. 모름은 결과를 실을 수 없다",
      reason: "unknown_field",
      changed: ["message.body.status.result"],
      edit: (c) => void ((c.message.body.status as Record<string, unknown>).result = { outcome: "not_posted" }),
    }),
    on(cardShown)({
      name: "approval-card-approved-result",
      description: "카드 요청의 결과가 approved. 카드 요청의 확정 결과는 승인이 아니다(shown·refused뿐)",
      reason: "body_malformed",
      changed: ["message.body.status.result.outcome"],
      edit: (c) => void ((c.message.body.status as { result: { outcome: string } }).result.outcome = "approved"),
    }),
    on(reply)({
      name: "reply-candidate-channel-id",
      description: "답 글 후보에 모델이 고른 채널 칸",
      reason: "forbidden_field",
      changed: ["message.body.channel_id"],
      edit: (c) => void (c.message.body.channel_id = "1300000000000000000"),
    }),
    on(progress)({
      name: "progress-update-free-text",
      description: "진행 표시에 임의 문구 칸. 진행은 단계 이름과 순번뿐이다",
      reason: "unknown_field",
      changed: ["message.body.text"],
      edit: (c) => void (c.message.body.text = "검증 중이에요. 거의 다 됐어요"),
    }),
    on(progress)({
      name: "progress-update-display-stage",
      description: "단계 칸에 표시 문구(검증). 단계는 정해진 이름(cause, patch, verify, pull_request, done, stopped)뿐이다",
      reason: "body_malformed",
      changed: ["message.body.stage"],
      edit: (c) => void (c.message.body.stage = "검증"),
    }),
    on(executionReply)({
      name: "execution-generation-reply-not-awaited",
      description: "묻지 않은 연결에 온 실행 세대 답. 현관은 이 값을 쓰지 않는다",
      reason: "reply_mismatch",
      changed: ["context.awaiting"],
      edit: (c) => void (c.context.awaiting = {}),
      signer: null,
    }),
    on(executionReply)({
      name: "execution-generation-reply-negative",
      description: "실행 세대가 음수인 답",
      reason: "body_malformed",
      changed: ["message.body.generation"],
      edit: (c) => void (c.message.body.generation = -1),
    }),
  ];
}
