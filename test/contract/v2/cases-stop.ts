// 정지 묶음(src/contract/v2/stop.ts)의 표본 사례. cases.ts의 buildCases가 공통부 사례 뒤에 붙인다.
// 감독 쪽 세대: 정지 세대 7에서 정지 8을 준비·확정하고, 8에서 풀기를 준비·확정해 실행 세대를 3에서 4로 올린다.
// 요청 ID·nonce는 0x20~0x3f를 쓴다(공통부는 0x10대).
import type { Envelope } from "../../../src/contract/v2/contract.ts";
import type { GenerationAuthorities, GenerationAuthority } from "../../../src/contract/v2/generations.ts";
import { accept, type Expect, type V2Case, type Variant, variant } from "./case-kit.ts";
import { baseContext, type CaseContext, envelope, id, type Keys, nonceOf } from "./support.ts";

const OK: Expect & { ok: true } = { ok: true, handshake_after: null };
const known = (current: number, prepared: number | null = null): GenerationAuthority => ({ known: true, current, prepared });
const supervisorGens = (stop: GenerationAuthority): GenerationAuthorities => ({ stop, execution: known(3) });
const jobOf = (message: Envelope) => ({ job_id: (message.body as { job_id: string }).job_id, action: message.header.action, request_digest: message.header.body_digest });

export function buildStopCases(keys: Keys): V2Case[] {
  const fromFront = (action: string, n: number, body: Record<string, unknown>) =>
    envelope(keys, { sender: "front-door", recipient: "supervisor", action, request_id: id(n), nonce: nonceOf(n) }, body);
  const fromSupervisor = (action: string, n: number, body: Record<string, unknown>) =>
    envelope(keys, { sender: "supervisor", recipient: "front-door", action, request_id: id(n), nonce: nonceOf(n) }, body);
  // 인사가 끝났고 접수는 닫힌 연결이 기본이다(정지·풀기와 조회는 닫힌 접수에서 받는다).
  const atSupervisor = (stop: GenerationAuthority, over: Partial<CaseContext> = {}) =>
    baseContext("supervisor", { handshake: "agreed", intake_open: false, generations: supervisorGens(stop), ...over });
  const atFront = (awaiting: CaseContext["awaiting"], over: Partial<CaseContext> = {}) => baseContext("front-door", { handshake: "agreed", intake_open: false, awaiting, ...over });
  const confirmed = (n: number, request: Envelope, inReplyTo: string, result: Record<string, unknown>) =>
    fromSupervisor("job_status", n, { in_reply_to: inReplyTo, ...jobOf(request), status: { state: "confirmed", result } });
  const awaitingOf = (request: Envelope) => ({ [request.header.request_id]: { action: request.header.action, job: jobOf(request) } });

  // ---- 권위 정지 기록 ----
  const lookupMsg = fromSupervisor("stop_record_lookup", 0x20, {});
  const lookup = accept(
    keys,
    "stop-record-lookup",
    "감독의 권위 정지 기록 조회(복원 1단계). 정책이 어긋난 연결, 닫힌 접수에서도 받는다. 세대를 싣지 않는다",
    "front-door",
    baseContext("front-door", { handshake: "policy_mismatch", intake_open: false }),
    lookupMsg,
    OK,
  );
  // 감독은 정지 세대를 아직 모른다(복원 1단계).
  const restoring = baseContext("supervisor", {
    handshake: "policy_mismatch",
    intake_open: false,
    awaiting: { [lookupMsg.header.request_id]: { action: "stop_record_lookup", job: null } },
  });
  const recorded = accept(
    keys,
    "stop-record-recorded",
    "현관의 원장에 정지 기록이 있음(세대 7, 정지). 감독이 정지 세대를 모르는 복원 1단계, 정책이 어긋난 연결에서도 받는다",
    "supervisor",
    restoring,
    fromFront("stop_record", 0x21, { in_reply_to: lookupMsg.header.request_id, record: { state: "recorded", generation: 7, stopped: true } }),
    OK,
  );
  const absent = accept(
    keys,
    "stop-record-absent",
    "현관이 원장을 읽고 기록이 없다고 확인함. '기록 없음'은 이 답에서만 나온다(시간 초과·끊김·거절된 답은 모름)",
    "supervisor",
    restoring,
    fromFront("stop_record", 0x22, { in_reply_to: lookupMsg.header.request_id, record: { state: "absent" } }),
    OK,
  );

  // ---- 정지: 준비 8, 확정 8 ----
  const prepareMsg = fromFront("stop_prepare", 0x23, { job_id: id(0x31), stop_generation: 8 });
  const prepare = accept(keys, "stop-prepare", "새 정지 세대 8의 준비(감독의 지금 7, 규칙 newer). 감독의 접수가 닫혀 있어도 받는다", "supervisor", atSupervisor(known(7)), prepareMsg, OK);
  const prepareConfirmed = accept(
    keys,
    "stop-prepare-confirmed",
    "정지 준비의 바로 답: 확정 prepared(감독이 준비를 적고 새 일을 닫았다)",
    "front-door",
    atFront(awaitingOf(prepareMsg)),
    confirmed(0x24, prepareMsg, prepareMsg.header.request_id, { outcome: "prepared" }),
    OK,
  );
  const commitMsg = fromFront("stop_commit", 0x25, { job_id: id(0x32), stop_generation: 8 });
  const commit = accept(keys, "stop-commit", "받아 둔 준비(8)의 확정(규칙 prepared)", "supervisor", atSupervisor(known(7, 8)), commitMsg, OK);
  const commitConfirmed = accept(
    keys,
    "stop-commit-confirmed",
    "정지 확정의 바로 답: 확정 stopped(감독이 정지 세대를 8로 올렸다)",
    "front-door",
    atFront(awaitingOf(commitMsg)),
    confirmed(0x26, commitMsg, commitMsg.header.request_id, { outcome: "stopped" }),
    OK,
  );
  // 확정의 답을 받지 못하고 다시 붙은 현관이 같은 작업 ID로 묻는다. 재전달은 이제 옛 세대라 거절되므로 조회로 확인한다.
  const commitLookupMsg = fromFront("job_lookup", 0x27, jobOf(commitMsg));
  const commitLookup = accept(
    keys,
    "stop-commit-lookup",
    "확정의 답을 잃은 현관이 같은 작업 ID·동작·요청 digest로 묻는다. 감독은 이미 8로 올렸고, 정책이 어긋난 연결이어도 받는다(이미 보낸 작업의 결과)",
    "supervisor",
    atSupervisor(known(8), { handshake: "policy_mismatch" }),
    commitLookupMsg,
    OK,
  );
  const commitLookupConfirmed = accept(
    keys,
    "stop-commit-lookup-confirmed",
    "같은 작업 ID 조회의 답: 확정 stopped",
    "front-door",
    atFront({ [commitLookupMsg.header.request_id]: { action: "job_lookup", job: jobOf(commitMsg) } }, { handshake: "policy_mismatch" }),
    confirmed(0x28, commitMsg, commitLookupMsg.header.request_id, { outcome: "stopped" }),
    OK,
  );

  // ---- 풀기: 정지 세대 8, 실행 세대 3 → 4 ----
  const releasePrepareMsg = fromFront("release_prepare", 0x29, { job_id: id(0x33), stop_generation: 8 });
  const releasePrepare = accept(
    keys,
    "release-prepare",
    "정지 세대 8의 풀기 준비(규칙 current). 감독은 8에서 정지 중이고 접수가 닫혀 있다",
    "supervisor",
    atSupervisor(known(8)),
    releasePrepareMsg,
    OK,
  );
  const releasePrepareConfirmed = accept(
    keys,
    "release-prepare-confirmed",
    "풀기 준비의 답: 확정되면 감독이 실행 세대를 4로 적는다. 현관은 이 값을 풀기 확정에 실어 서명한다",
    "front-door",
    atFront(awaitingOf(releasePrepareMsg)),
    confirmed(0x2a, releasePrepareMsg, releasePrepareMsg.header.request_id, { outcome: "prepared", execution_generation: 4 }),
    OK,
  );
  const releaseCommitMsg = fromFront("release_commit", 0x2b, { job_id: id(0x34), stop_generation: 8, execution_generation: 4 });
  const releaseCommit = accept(
    keys,
    "release-commit",
    "받아 둔 풀기 준비(8)의 확정(규칙 prepared). 실행 세대는 감독의 지금 3 + 1(규칙 next)",
    "supervisor",
    atSupervisor(known(8, 8)),
    releaseCommitMsg,
    OK,
  );
  const releaseCommitConfirmed = accept(
    keys,
    "release-commit-confirmed",
    "풀기 확정의 답: released. 답이 실행 세대 4를 실은 본문의 digest에 묶이므로 현관은 이 확정으로 실행 세대 4를 권위 값으로 쓴다",
    "front-door",
    atFront(awaitingOf(releaseCommitMsg)),
    confirmed(0x2c, releaseCommitMsg, releaseCommitMsg.header.request_id, { outcome: "released" }),
    OK,
  );

  // ---- 정책이 어긋난 연결: 정지의 준비·확정만 받는다(관리자 결정 2026-11-19), 풀기는 아래 거절 사례 ----
  const preparePolicyMismatch = accept(
    keys,
    "stop-prepare-policy-mismatch",
    "정책 revision이 어긋난 연결에 온 정지 준비. 멈추는 쪽은 늘 열어 두므로 받는다(효과 가운데 정지의 준비·확정만 예외)",
    "supervisor",
    atSupervisor(known(7), { handshake: "policy_mismatch" }),
    prepareMsg,
    OK,
  );
  const commitPolicyMismatch = accept(
    keys,
    "stop-commit-policy-mismatch",
    "정책 revision이 어긋난 연결에 온 정지 확정. 정지 준비와 같이 받는다",
    "supervisor",
    atSupervisor(known(7, 8), { handshake: "policy_mismatch" }),
    commitMsg,
    OK,
  );

  const on = (base: V2Case) => (v: Variant) => variant(keys, base, v);
  const P = on(prepare);
  const C = on(commit);
  const RP = on(releasePrepare);
  const RC = on(releaseCommit);
  return [
    lookup,
    recorded,
    absent,
    prepare,
    prepareConfirmed,
    commit,
    commitConfirmed,
    commitLookup,
    commitLookupConfirmed,
    releasePrepare,
    releasePrepareConfirmed,
    releaseCommit,
    releaseCommitConfirmed,
    preparePolicyMismatch,
    commitPolicyMismatch,
    P({
      name: "stop-prepare-without-handshake",
      description: "인사가 끝나지 않은 연결에 온 정지 준비. 정책이 어긋난 연결과 달리 인사 없는 연결에서는 정지도 받지 않는다",
      reason: "handshake_required",
      changed: ["context.handshake"],
      edit: (c) => void (c.context.handshake = "none"),
      signer: null,
    }),
    P({
      name: "stop-prepare-generation-missing",
      description: "정지 세대 칸이 없는 정지 준비",
      reason: "generation_missing",
      changed: ["message.body.stop_generation"],
      edit: (c) => void delete c.message.body.stop_generation,
    }),
    P({
      name: "stop-prepare-generation-unknown",
      description: "감독이 정지 세대를 모를 때(복원 1단계 전) 온 정지 준비. 모르면 닫고, 권위 조회로 합친다",
      reason: "generation_unknown",
      changed: ["context.generations.stop"],
      edit: (c) => void (c.context.generations = { ...c.context.generations, stop: { known: false } }),
      signer: null,
    }),
    P({
      name: "stop-prepare-same-generation",
      description: "감독의 지금 정지 세대(7)와 같은 세대의 준비. 새 정지가 아니다",
      reason: "generation_mismatch",
      changed: ["message.body.stop_generation"],
      edit: (c) => void (c.message.body.stop_generation = 7),
    }),
    P({
      name: "stop-prepare-with-execution-generation",
      description: "실행 세대와 무관한 정지 준비에 실행 세대 칸. 검사되지 않는 세대 값은 받지 않는다",
      reason: "body_malformed",
      changed: ["message.body.execution_generation"],
      edit: (c) => void (c.message.body.execution_generation = 3),
    }),
    P({
      name: "stop-prepare-from-supervisor",
      description: "감독이 자기 키로 서명해 현관에 낸 정지 준비. 정지·풀기는 현관만 낸다",
      reason: "wrong_direction",
      changed: ["message.header.sender", "message.header.recipient", "context.expected_recipient", "keys"],
      edit: (c) => {
        c.message.header.sender = "supervisor";
        c.message.header.recipient = "front-door";
        c.context.expected_recipient = "front-door";
      },
    }),
    P({
      name: "stop-prepare-below-prepared",
      description: "더 높은 정지 준비(10)를 이미 받아 둔 감독에게 늦게 온 낮은 정지 준비(8). 받으면 준비 칸이 낮아져 10의 확정이 막힌다",
      reason: "generation_mismatch",
      changed: ["context.generations.stop.prepared"],
      edit: (c) => void (c.context.generations = { ...c.context.generations, stop: known(7, 10) }),
      signer: null,
    }),
    C({
      name: "stop-commit-after-release-prepare",
      description: "감독이 지금 정지 세대 8에서 풀기 준비(8)만 받아 둔 때 온 정지 확정(8). 번호가 같아도 정지 확정은 정지 준비(지금보다 큰 번호)에만 묶인다",
      reason: "generation_mismatch",
      changed: ["context.generations.stop.current"],
      edit: (c) => void (c.context.generations = { ...c.context.generations, stop: known(8, 8) }),
      signer: null,
    }),
    C({
      name: "stop-commit-without-prepare",
      description: "받아 둔 준비가 없는 감독에게 온 정지 확정",
      reason: "generation_mismatch",
      changed: ["context.generations.stop.prepared"],
      edit: (c) => void (c.context.generations = { ...c.context.generations, stop: known(7, null) }),
      signer: null,
    }),
    RP({
      name: "release-prepare-policy-mismatch",
      description: "정책 revision이 어긋난 연결에 온 풀기 준비. 정지와 달리 풀기는 정책이 맞을 때까지 받지 않는다",
      reason: "policy_mismatch",
      changed: ["context.handshake"],
      edit: (c) => void (c.context.handshake = "policy_mismatch"),
      signer: null,
    }),
    RC({
      name: "release-commit-policy-mismatch",
      description: "정책 revision이 어긋난 연결에 온 풀기 확정. 받지 않는다",
      reason: "policy_mismatch",
      changed: ["context.handshake"],
      edit: (c) => void (c.context.handshake = "policy_mismatch"),
      signer: null,
    }),
    RP({
      name: "release-prepare-old-stop-generation",
      description: "옛 정지 세대(7)의 풀기 준비. 감독은 8에서 정지 중이다",
      reason: "generation_mismatch",
      changed: ["message.body.stop_generation"],
      edit: (c) => void (c.message.body.stop_generation = 7),
    }),
    RC({
      name: "release-commit-stale-execution-generation",
      description: "실행 세대를 올리지 않는(지금 3) 풀기 확정",
      reason: "generation_mismatch",
      changed: ["message.body.execution_generation"],
      edit: (c) => void (c.message.body.execution_generation = 3),
    }),
    RC({
      name: "release-commit-after-new-stop-prepare",
      description: "새 정지(9)의 준비가 준비 칸을 덮은 뒤 늦게 온 풀기 확정. 정지가 이긴다",
      reason: "generation_mismatch",
      changed: ["context.generations.stop.prepared"],
      edit: (c) => void (c.context.generations = { ...c.context.generations, stop: known(8, 9) }),
      signer: null,
    }),
    RC({
      name: "release-commit-after-stop-prepare-only",
      description: "감독이 지금 정지 세대 7에서 정지 준비(8)만 받아 둔 때 온 풀기 확정(8). 번호가 같아도 풀기 확정은 풀기 준비(지금과 같은 번호)에만 묶인다",
      reason: "generation_mismatch",
      changed: ["context.generations.stop.current"],
      edit: (c) => void (c.context.generations = { ...c.context.generations, stop: known(7, 8) }),
      signer: null,
    }),
    on(releasePrepareConfirmed)({
      name: "release-prepare-execution-generation-one",
      description: "풀기 준비의 답이 약속한 다음 실행 세대가 1. 감독 장부의 실행 세대는 1에서 시작하고 풀기가 1 올리므로 2 이상만 받는다",
      reason: "body_malformed",
      changed: ["message.body.status.result.execution_generation"],
      edit: (c) => void ((c.message.body.status as { result: { execution_generation: number } }).result.execution_generation = 1),
    }),
    RC({
      name: "release-commit-execution-unknown",
      description: "감독이 실행 세대를 모를 때 온 풀기 확정. 모르면 닫는다",
      reason: "generation_unknown",
      changed: ["context.generations.execution"],
      edit: (c) => void (c.context.generations = { ...c.context.generations, execution: { known: false } }),
      signer: null,
    }),
    on(recorded)({
      name: "stop-record-null",
      description: "기록 칸이 null인 답. '기록 없음'으로 읽지 않는다(확인된 부재는 state absent뿐)",
      reason: "body_malformed",
      changed: ["message.body.record"],
      edit: (c) => void (c.message.body.record = null),
    }),
    on(recorded)({
      name: "stop-record-not-awaited",
      description: "묻지 않은 연결에 온 정지 기록 답",
      reason: "reply_mismatch",
      changed: ["context.awaiting"],
      edit: (c) => void (c.context.awaiting = {}),
      signer: null,
    }),
    on(prepareConfirmed)({
      name: "stop-prepare-status-from-front-door",
      description: "현관이 감독에게 낸 정지 준비의 결과 답. 정지 작업은 현관이 낸 것이라 그 결과는 감독만 답한다",
      reason: "body_malformed",
      changed: ["message.header.sender", "message.header.recipient", "context.expected_recipient", "keys"],
      edit: (c) => {
        c.message.header.sender = "front-door";
        c.message.header.recipient = "supervisor";
        c.context.expected_recipient = "supervisor";
      },
    }),
    on(commitConfirmed)({
      name: "stop-commit-refused",
      description: "정지 확정의 결과가 refused. 정지에는 거절 결과가 없다(적지 못하면 확정하지 않는다)",
      reason: "body_malformed",
      changed: ["message.body.status.result.outcome"],
      edit: (c) => void ((c.message.body.status as { result: { outcome: string } }).result.outcome = "refused"),
    }),
  ];
}
