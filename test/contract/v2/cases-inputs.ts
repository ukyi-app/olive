// 입력 묶음(src/contract/v2/inputs.ts·events.ts)의 표본 사례. cases.ts의 buildCases가 정지 묶음 사례 뒤에 붙인다.
// 감독 쪽 세대: 정지 세대 7(받아 둔 준비 없음), 실행 세대 3. 요청 ID·nonce는 0x60~0x6f, 작업 ID와 참조 ID는 0x70~0x7f를 쓴다
// (공통부 0x10대, 정지 묶음 0x20~0x3f).
import type { Envelope } from "../../../src/contract/v2/contract.ts";
import type { GenerationAuthorities } from "../../../src/contract/v2/generations.ts";
import { accept, type Expect, type V2Case, type Variant, variant } from "./case-kit.ts";
import { baseContext, type CaseContext, envelope, id, ISSUED, type Keys, nonceOf, UNKNOWN_GENERATIONS } from "./support.ts";

const OK: Expect & { ok: true } = { ok: true, handshake_after: null };
export const SUPERVISOR_GENERATIONS: GenerationAuthorities = { stop: { known: true, current: 7, prepared: null }, execution: { known: true, current: 3, prepared: null } };
// 원문 참조의 예. 만료는 받은 때부터 168시간(D-22)이다.
export const SOURCE_REF_EXAMPLE = { ref: `originals/${id(0x7e)}`, digest: "b".repeat(64), expires_at: ISSUED + 168 * 3_600_000 };
export const INPUT_JOB = id(0x70);
const CARD_JOB = id(0x7a);
const PUBLICATION_JOB = id(0x7b);
const CANDIDATE = "d".repeat(64);

const jobOf = (message: Envelope) => ({ job_id: (message.body as { job_id: string }).job_id, action: message.header.action, request_digest: message.header.body_digest });

export function buildInputCases(keys: Keys): V2Case[] {
  const fromFront = (action: string, n: number, body: Record<string, unknown>) =>
    envelope(keys, { sender: "front-door", recipient: "supervisor", action, request_id: id(n), nonce: nonceOf(n) }, body);
  const fromSupervisor = (action: string, n: number, body: Record<string, unknown>) =>
    envelope(keys, { sender: "supervisor", recipient: "front-door", action, request_id: id(n), nonce: nonceOf(n) }, body);
  // 인사가 끝난 연결. 입력은 열린 접수에서, 취소·이벤트는 닫힌 접수(정지 중)에서 받는 것을 보인다.
  const atSupervisor = (over: Partial<CaseContext> = {}) =>
    baseContext("supervisor", { handshake: "agreed", intake_open: true, generations: SUPERVISOR_GENERATIONS, ...over });
  const atFront = (request: Envelope) =>
    baseContext("front-door", { handshake: "agreed", intake_open: true, awaiting: { [request.header.request_id]: { action: request.header.action, job: jobOf(request) } } });
  const confirmed = (n: number, request: Envelope, result: Record<string, unknown>) =>
    fromSupervisor("job_status", n, { in_reply_to: request.header.request_id, ...jobOf(request), status: { state: "confirmed", result } });

  // ---- 입력과 취소 ----
  const inputMsg = fromFront("input_submit", 0x60, { job_id: INPUT_JOB, stop_generation: 7, source: "admin", source_ref: SOURCE_REF_EXAMPLE });
  const input = accept(
    keys,
    "input-submit",
    "관리자 요청의 접수. 원문은 참조·digest·만료만 싣는다. 감독의 지금 정지 세대 7(규칙 current), 접수가 열려 있다",
    "supervisor",
    atSupervisor(),
    inputMsg,
    OK,
  );
  const alert = accept(
    keys,
    "input-submit-alert",
    "자동 경보의 접수. 출처 이름만 다르다(장부는 이름을 분류하지 않는다)",
    "supervisor",
    atSupervisor(),
    fromFront("input_submit", 0x61, { job_id: id(0x71), stop_generation: 7, source: "alert", source_ref: { ...SOURCE_REF_EXAMPLE, ref: `originals/${id(0x7d)}`, digest: "c".repeat(64) } }),
    OK,
  );
  const queued = accept(keys, "input-submit-queued", "입력의 바로 답: 확정 queued(감독이 장부에 접수를 적었다)", "front-door", atFront(inputMsg), confirmed(0x62, inputMsg, { outcome: "queued" }), OK);
  const cancelMsg = fromFront("input_cancel", 0x63, { job_id: id(0x72), input_job_id: INPUT_JOB });
  const cancel = accept(
    keys,
    "input-cancel",
    "입력 취소. 정지 중(접수 닫힘)이고 감독이 정지 세대를 모르는 복원 1단계여도 받는다(세대를 싣지 않는다)",
    "supervisor",
    atSupervisor({ intake_open: false, generations: UNKNOWN_GENERATIONS }),
    cancelMsg,
    OK,
  );
  const cancelled = accept(
    keys,
    "input-cancel-cancelled",
    "취소의 답: 확정 cancelled(입력에 취소를 적었다. 이미 도는 실행이 멈췄다는 뜻은 아니다)",
    "front-door",
    atFront(cancelMsg),
    confirmed(0x64, cancelMsg, { outcome: "cancelled" }),
    OK,
  );

  // ---- 이벤트 ----
  const approvalMsg = fromFront("approval_changed", 0x65, { job_id: id(0x73), stop_generation: 7, card_job_id: CARD_JOB, candidate_digest: CANDIDATE, seq: 2, state: "approved" });
  const approval = accept(
    keys,
    "approval-changed",
    "확인 카드의 승인(현관이 글자를 대조한 관리자 이벤트). 그 카드의 두 번째 사실(seq 2), 감독의 지금 정지 세대 7. 접수가 닫혀도 받는다",
    "supervisor",
    atSupervisor({ intake_open: false }),
    approvalMsg,
    OK,
  );
  const recorded = accept(keys, "approval-changed-recorded", "승인 변화의 답: 확정 recorded(감독이 그 사실을 적었다)", "front-door", atFront(approvalMsg), confirmed(0x66, approvalMsg, { outcome: "recorded" }), OK);
  const closedUnknown = atSupervisor({ intake_open: false, generations: UNKNOWN_GENERATIONS });
  const publication = accept(
    keys,
    "publication-changed",
    "게시의 변화: 현관이 게시를 마쳤다(그 게시의 첫 사실, seq 1). 바깥의 사실이라 세대를 싣지 않고 정지 중에도 받는다",
    "supervisor",
    closedUnknown,
    fromFront("publication_changed", 0x67, { job_id: id(0x74), publication_job_id: PUBLICATION_JOB, candidate_digest: CANDIDATE, seq: 1, state: "posted" }),
    OK,
  );
  const merge = accept(
    keys,
    "merge-observed",
    "게시한 PR의 병합 관측: 게시 요청의 작업 ID와 병합 커밋",
    "supervisor",
    closedUnknown,
    fromFront("merge_observed", 0x68, { job_id: id(0x75), publication_job_id: PUBLICATION_JOB, merge_commit: "e".repeat(40) }),
    OK,
  );
  const forget = accept(
    keys,
    "source-forgotten",
    "잊기: 원문 참조 하나만 가리킨다. 정지 중에도 받는다",
    "supervisor",
    closedUnknown,
    fromFront("source_forgotten", 0x69, { job_id: id(0x76), source_ref: SOURCE_REF_EXAMPLE.ref }),
    OK,
  );

  const I = (v: Variant) => variant(keys, input, v);
  const A = (v: Variant) => variant(keys, approval, v);
  type Nested = Record<string, Record<string, unknown>>;
  return [
    input,
    alert,
    queued,
    cancel,
    cancelled,
    approval,
    recorded,
    publication,
    merge,
    forget,
    I({
      name: "input-submit-intake-closed",
      description: "감독의 접수가 닫혔을 때 온 입력(정지 중·복원 중). 새 일은 닫힌 접수에서 받지 않는다",
      reason: "intake_closed",
      changed: ["context.intake_open"],
      edit: (c) => void (c.context.intake_open = false),
      signer: null,
    }),
    I({
      name: "input-submit-old-stop-generation",
      description: "옛 정지 세대(6)의 입력. 정지를 건너온 입력은 서명이 맞아도 받지 않는다",
      reason: "generation_mismatch",
      changed: ["message.body.stop_generation"],
      edit: (c) => void (c.message.body.stop_generation = 6),
    }),
    I({
      name: "input-submit-text-as-ref",
      description: "원문 참조 자리에 요청 글. 참조는 저장소가 발행한 `<저장소>/<UUID>`뿐이다",
      reason: "body_malformed",
      changed: ["message.body.source_ref.ref"],
      edit: (c) => void ((c.message.body as Nested).source_ref!.ref = "배포가 왜 죽었는지 봐 줘"),
    }),
    I({
      name: "input-submit-text-field",
      description: "입력 본문에 글 칸(text). 입력은 원문을 싣지 않는다",
      reason: "unknown_field",
      changed: ["message.body.text"],
      edit: (c) => void (c.message.body.text = "배포가 왜 죽었는지 봐 줘"),
    }),
    I({
      name: "input-submit-raw-message",
      description: "원문 참조 안에 원문 칸(message_content)",
      reason: "forbidden_field",
      changed: ["message.body.source_ref.message_content"],
      edit: (c) => void ((c.message.body as Nested).source_ref!.message_content = "배포가 왜 죽었는지 봐 줘"),
    }),
    I({
      name: "input-submit-unknown-source",
      description: "출처 이름이 목록(admin, alert) 밖",
      reason: "body_malformed",
      changed: ["message.body.source"],
      edit: (c) => void (c.message.body.source = "model"),
    }),
    I({
      name: "input-submit-without-digest",
      description: "원문 참조에 digest가 없다",
      reason: "body_malformed",
      changed: ["message.body.source_ref.digest"],
      edit: (c) => void delete (c.message.body as Nested).source_ref!.digest,
    }),
    variant(keys, cancel, {
      name: "input-cancel-with-stop-generation",
      description: "세대와 무관한 취소에 정지 세대 칸. 검사되지 않는 세대 값을 처리기에 넘기지 않는다",
      reason: "body_malformed",
      changed: ["message.body.stop_generation"],
      edit: (c) => void (c.message.body.stop_generation = 7),
    }),
    A({
      name: "approval-changed-from-supervisor",
      description: "감독이 자기 키로 서명해 낸 승인 변화. 승인 사실은 현관만 낸다",
      reason: "wrong_direction",
      changed: ["message.header.sender", "message.header.recipient", "context.expected_recipient", "keys"],
      edit: (c) => {
        c.message.header.sender = "supervisor";
        c.message.header.recipient = "front-door";
        c.context.expected_recipient = "front-door";
      },
    }),
    A({
      name: "approval-changed-with-note",
      description: "승인 변화에 글 칸(모델이 '승인한 것으로 보인다'고 쓴 글 등). 승인 변화에는 글 칸이 없다",
      reason: "unknown_field",
      changed: ["message.body.note"],
      edit: (c) => void (c.message.body.note = "관리자가 승인한 것으로 보임"),
    }),
    A({
      name: "approval-changed-unknown-state",
      description: "승인 상태가 목록(approved, declined, expired, invalidated) 밖",
      reason: "body_malformed",
      changed: ["message.body.state"],
      edit: (c) => void (c.message.body.state = "likely_approved"),
    }),
    A({
      name: "approval-changed-generation-unknown",
      description: "감독이 정지 세대를 모르는 동안(복원 1단계)의 승인 변화. 모르면 닫는다",
      reason: "generation_unknown",
      changed: ["context.generations"],
      edit: (c) => void (c.context.generations = UNKNOWN_GENERATIONS),
      signer: null,
    }),
    A({
      name: "event-unknown-kind",
      description: "이벤트 넷(승인·게시 변화, 병합 관측, 잊기) 밖의 종류",
      reason: "unknown_action",
      changed: ["message.header.action"],
      edit: (c) => void (c.message.header.action = "label_changed"),
    }),
    variant(keys, recorded, {
      name: "approval-changed-recorded-claims-approval",
      description: "감독의 답 결과에 승인 주장 칸. 감독이 낸 본문은 승인을 말할 수 없다",
      reason: "forbidden_field",
      changed: ["message.body.status.result.approved"],
      edit: (c) => void ((c.message.body as Record<string, Nested>).status!.result!.approved = true),
    }),
    variant(keys, publication, {
      name: "publication-changed-without-seq",
      description: "게시 변화에 순번이 없다. 순서가 뜻을 갖는 사실은 순번을 싣는다",
      reason: "body_malformed",
      changed: ["message.body.seq"],
      edit: (c) => void delete c.message.body.seq,
    }),
    variant(keys, forget, {
      name: "source-forgotten-raw-text",
      description: "잊기에 원문 칸(raw_text). 잊기는 참조만 가리킨다",
      reason: "forbidden_field",
      changed: ["message.body.raw_text"],
      edit: (c) => void (c.message.body.raw_text = "지울 글"),
    }),
  ];
}
