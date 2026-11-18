// 계약 사례의 정의. 시험과 fixture 생성(generate-fixtures.ts)이 같은 정의를 쓴다.
// 거절 사례는 모두 받아들이는 기준 사례 하나에서 한 곳만 바꿔 만든다. 바꾼 곳은 `changed`에 적고,
// 시험이 기준과 거절 사례를 칸 단위로 비교해 정말 그곳만 다른지 확인한다(서명과 본문 digest는 다시 계산된 값이라 빼고 본다).
// 키는 부를 때마다 새로 만든다. 개인 키는 이 프로세스 밖으로 나가지 않는다.
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { digestOf, sha256Hex } from "../../src/contract/v1/canonical.ts";
import { type Envelope, rawPublicKey, signUnchecked } from "../../src/contract/v1/envelope.ts";
import type { RejectReason } from "../../src/contract/v1/errors.ts";
import type { Action, Header } from "../../src/contract/v1/header.ts";
import { CONTRACT, MESSAGE_TTL_MS } from "../../src/contract/v1/limits.ts";
import { executorName } from "../../src/contract/v1/principal.ts";

// 2026-11-18T00:00:00Z. fixture는 이 시각을 "지금"으로 검증한다.
export const NOW = 1_794_960_000_000;
export const ISSUED = NOW - 1_000;
export const STOP_GENERATION = 3;

export const SUPERVISOR = "supervisor";
export const SESSION = executorName("session", "olive-session-0", "st-5e55");
export const DIAGNOSIS = executorName("diagnosis", "olive-diagnosis-0", "st-d1a9");
// 저장소가 새로 만들어진 같은 인스턴스(받는 쪽 대조 사례).
export const DIAGNOSIS_NEW_STORAGE = executorName("diagnosis", "olive-diagnosis-0", "st-0e77");
export const UNKNOWN_EXECUTOR = executorName("diagnosis", "olive-diagnosis-9", "st-d1a9");
export const PRINCIPALS = [SUPERVISOR, SESSION, DIAGNOSIS] as const;

export const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const RUN_TASK = id(0x101);
export const RUN_NEW_TASK = id(0x102);
export const RUN_SESSION = id(0x201);
export const RUN_NEW_SESSION = id(0x202);
export const RUN_PREVIOUS_SESSION = id(0x200);
export const RUN_GENERATIONS: Record<string, number> = { [RUN_TASK]: 2, [RUN_SESSION]: 5, [RUN_PREVIOUS_SESSION]: 4 };
// 실행기에는 있지만 감독 장부에는 없는 실행(재시작 복원의 종료 대상).
export const RUN_ORPHAN = id(0x1f0);
export const RUN_ORPHAN_GENERATION = 7;

export const hash = (label: string) => sha256Hex(label);
const credential = { account: "main", method: "subscription", revision: "cred-7", digest: hash("credential value") };

export interface KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}
export type Keys = Record<string, KeyPair>;

export function freshKeys(): Keys {
  const keys: Keys = {};
  for (const name of PRINCIPALS) keys[name] = generateKeyPairSync("ed25519");
  return keys;
}

export interface CaseContext {
  now: number;
  expected_recipient: string;
  stop_generation: number;
  run_generations: Record<string, number>;
  spent_nonces: { sender: string; nonce: string }[];
}

export interface ContractCase {
  name: string;
  description: string;
  base: string | null;
  changed: string[];
  // adopted_stop_generation: 받아들이면서 받는 쪽의 정지 세대를 올렸으면 그 값, 아니면 null.
  expect: { ok: true; adopted_stop_generation: number | null } | { ok: false; reason: RejectReason };
  keys: Record<string, string>;
  context: CaseContext;
  message: Envelope;
}

interface Draft {
  context: CaseContext;
  header: Record<string, unknown>;
  body: unknown;
  signature: string;
  trusted: string[];
}

const clone = <T>(value: T): T => structuredClone(value);

export function buildCases(keys: Keys): ContractCase[] {
  let counter = 0;
  const publicKeys = (trusted: readonly string[]) => Object.fromEntries(trusted.map((name) => [name, rawPublicKey(keys[name]!.publicKey)]));
  const sign = (header: Record<string, unknown>, body: unknown, signer: string) =>
    signUnchecked(header as Header, body, keys[signer]!.privateKey).signature;

  const accept = new Map<string, Draft>();
  const cases: ContractCase[] = [];

  // opts.stopGeneration: 머리의 정지 세대(기본은 받는 쪽과 같은 값). opts.runGenerations: 받는 쪽이 아는 실행의 세대.
  function base(
    name: string,
    description: string,
    action: Action,
    sender: string,
    recipient: string,
    runGeneration: number,
    body: unknown,
    opts: { stopGeneration?: number; runGenerations?: Record<string, number> } = {},
  ) {
    counter++;
    const stopGeneration = opts.stopGeneration ?? STOP_GENERATION;
    const header = {
      contract: CONTRACT,
      sender,
      recipient,
      action,
      request_id: id(0x9000 + counter),
      stop_generation: stopGeneration,
      run_generation: runGeneration,
      body_digest: digestOf(body),
      issued_at: ISSUED,
      expires_at: ISSUED + MESSAGE_TTL_MS,
      nonce: counter.toString(16).padStart(32, "0"),
    };
    const context: CaseContext = {
      now: NOW,
      expected_recipient: recipient,
      stop_generation: STOP_GENERATION,
      run_generations: { ...(opts.runGenerations ?? RUN_GENERATIONS) },
      spent_nonces: [],
    };
    const draft: Draft = { context, header, body, signature: sign(header, body, sender), trusted: [...PRINCIPALS] };
    accept.set(name, draft);
    const adopted = stopGeneration === STOP_GENERATION ? null : stopGeneration;
    cases.push(toCase(`accept/${name}`, description, null, [], { ok: true, adopted_stop_generation: adopted }, draft));
  }

  function toCase(name: string, description: string, from: string | null, changed: string[], expect: ContractCase["expect"], draft: Draft): ContractCase {
    return {
      name,
      description,
      base: from,
      changed,
      expect,
      keys: publicKeys(draft.trusted),
      context: clone(draft.context),
      message: { header: clone(draft.header) as Header, signature: draft.signature, body: clone(draft.body) },
    };
  }

  interface Mutation {
    digest?: "recompute" | "keep";
    // resign: 낸 쪽 키로 다시 서명(기본), keep: 서명을 그대로 둠, 이름: 그 주체의 키로 서명
    sign?: "resign" | "keep" | string;
  }
  function reject(
    name: string,
    from: string,
    reason: RejectReason,
    changed: string[],
    description: string,
    mutate: (draft: Draft) => void,
    how: Mutation = {},
  ) {
    const source = accept.get(from);
    if (!source) throw new Error(`기준 사례가 없다: ${from}`);
    const draft = clone({ ...source, signature: source.signature });
    mutate(draft);
    if ((how.digest ?? "recompute") === "recompute") draft.header.body_digest = digestOf(draft.body);
    const signing = how.sign ?? "resign";
    if (signing === "resign") draft.signature = sign(draft.header, draft.body, draft.header.sender as string);
    else if (signing !== "keep") draft.signature = sign(draft.header, draft.body, signing);
    cases.push(toCase(`reject/${name}`, description, `accept/${from}`, changed, { ok: false, reason }, draft));
  }

  // ---- 받아들이는 사례: 동작마다 하나 ----
  base("session-start", "세션 시작: 인수 영수증과 규칙 확인 기록을 가리킨다", "session_start", SUPERVISOR, SESSION, 1, {
    run_id: RUN_NEW_SESSION,
    generation_marker_digest: hash("marker gen 6"),
    takeover_receipt_id: id(0x301),
    rule_check_id: id(0x302),
    profile_revision: "session-r1",
    policy_revision: "policy-r1",
    handoff_digest: hash("handoff"),
    credential,
  });
  base("session-stop", "세션 종료(하루 교체)", "session_stop", SUPERVISOR, SESSION, 5, { run_id: RUN_SESSION, reason: "daily_rotation" });
  base("task-start", "작업 시작: 실행기의 고정 역할과 같은 역할", "task_start", SUPERVISOR, DIAGNOSIS, 1, {
    run_id: RUN_NEW_TASK,
    role: "diagnosis",
    profile_revision: "diagnosis-r1",
    policy_revision: "policy-r1",
    snapshot_digest: hash("snapshot"),
    input_digest: hash("input"),
    deadline_at: NOW + 600_000,
    budget_tokens: 200_000,
    credential,
  });
  base("task-cancel", "작업 취소", "task_cancel", SUPERVISOR, DIAGNOSIS, 2, { run_id: RUN_TASK, reason: "requested" });
  base("run-renew", "실행 갱신: 임대는 30초 안", "run_renew", SUPERVISOR, DIAGNOSIS, 2, { run_id: RUN_TASK, lease_until: ISSUED + 30_000 });
  base("result-finalize", "결과 확정: 저장한 결과의 digest", "result_finalize", SUPERVISOR, DIAGNOSIS, 2, {
    run_id: RUN_TASK,
    outcome: "succeeded",
    result_digest: hash("result"),
    stored_at: NOW - 5_000,
  });
  base("receipt-accepted", "접수 영수증", "receipt_accepted", DIAGNOSIS, SUPERVISOR, 2, {
    receipt_id: id(0x401),
    run_id: RUN_TASK,
    instruction_request_id: id(0x9003),
    instruction: "task_start",
  });
  base("receipt-started", "시작 영수증", "receipt_started", DIAGNOSIS, SUPERVISOR, 2, {
    receipt_id: id(0x402),
    run_id: RUN_TASK,
    instruction_request_id: id(0x9003),
    started_at: NOW - 60_000,
  });
  base("receipt-stopped", "종료 확인 영수증: 남은 프로세스 0개", "receipt_stopped", DIAGNOSIS, SUPERVISOR, 2, {
    receipt_id: id(0x403),
    run_id: RUN_TASK,
    remaining_processes: 0,
    exit: "completed",
    stopped_at: NOW - 10_000,
  });
  base("receipt-cleaned", "정리 영수증", "receipt_cleaned", DIAGNOSIS, SUPERVISOR, 2, {
    receipt_id: id(0x404),
    run_id: RUN_TASK,
    instruction_request_id: id(0x9006),
    cleaned_at: NOW - 2_000,
  });
  base("receipt-session-takeover", "세션 인수 영수증(D-50)", "receipt_session_takeover", SESSION, SUPERVISOR, 4, {
    receipt_id: id(0x301),
    previous_run_id: RUN_PREVIOUS_SESSION,
    new_generation_marker_digest: hash("marker gen 6"),
    start_permit_id: id(0x501),
    taken_over_at: NOW - 3_000,
  });
  base("report-session-broken", "세션 깨짐 보고(D-52)", "report_session_broken", SESSION, SUPERVISOR, 5, {
    report_id: id(0x601),
    run_id: RUN_SESSION,
    cause: "relay_lost",
    generation_marker_digest: hash("marker gen 5"),
    observed_at: NOW - 2_000,
  });
  base("report-rule-check", "규칙 확인 기록(D-51)", "report_rule_check", SESSION, SUPERVISOR, 0, {
    report_id: id(0x302),
    outcome: "rule_present",
    first_marker_digest: hash("marker boot"),
    restarted_marker_digest: hash("marker gen 6"),
    start_permit_id: id(0x501),
    checked_at: NOW - 4_000,
  });
  base("report-hook-event", "훅 이벤트: session_id·prompt_id", "report_hook_event", SESSION, SUPERVISOR, 5, {
    report_id: id(0x602),
    run_id: RUN_SESSION,
    session_id: id(0x701),
    prompt_id: id(0x702),
    event: "StopFailure",
    error: "rate_limit",
    observed_at: NOW - 2_000,
  });
  base("report-result", "작업 결과", "report_result", DIAGNOSIS, SUPERVISOR, 2, {
    report_id: id(0x603),
    run_id: RUN_TASK,
    result: {
      role: "diagnosis",
      outcome: "completed",
      summary: "인증서 갱신이 DNS 응답 지연으로 실패했다.",
      items: [{ kind: "finding", text: "갱신 시도 3회가 모두 시간 초과였다." }],
      refs: [{ kind: "path", ref: "platform/cert-manager/values.yaml", digest: null }],
    },
  });
  base("hello", "연결 인사: 쥔 실행과 받음 확인 못 받은 영수증", "hello", DIAGNOSIS, SUPERVISOR, 0, {
    profile_revision: "diagnosis-r1",
    policy_revision: "policy-r1",
    runs: [{ run_id: RUN_TASK, state: "running", run_generation: 2, last_receipt_id: id(0x402) }],
    unacked_ids: [id(0x402)],
  });
  base("status-query", "다시 붙은 뒤 같은 실행 ID의 상태 조회", "status_query", SUPERVISOR, DIAGNOSIS, 0, { run_ids: [RUN_TASK] });
  base("status-report", "상태 조회의 답", "status_report", DIAGNOSIS, SUPERVISOR, 0, {
    in_reply_to: id(0x9011),
    runs: [{ run_id: RUN_TASK, state: "ready_result", run_generation: 2, last_receipt_id: id(0x403) }],
  });
  base("ack", "영수증 받음 확인", "ack", SUPERVISOR, DIAGNOSIS, 0, { ids: [id(0x401), id(0x402)] });
  // 비상 정지(§7.3): 감독이 새 정지 세대 4를 적용한 뒤 보내는 종료. 받는 쪽은 아직 3이고, 받아들이며 4를 돌려준다.
  base("task-cancel-emergency-new-stop-generation", "비상 종료가 새 정지 세대를 싣고 온다(작업)", "task_cancel", SUPERVISOR, DIAGNOSIS, 2, {
    run_id: RUN_TASK,
    reason: "emergency_stop",
  }, { stopGeneration: STOP_GENERATION + 1 });
  base("session-stop-emergency-new-stop-generation", "비상 종료가 새 정지 세대를 싣고 온다(세션)", "session_stop", SUPERVISOR, SESSION, 5, {
    run_id: RUN_SESSION,
    reason: "emergency_stop",
  }, { stopGeneration: STOP_GENERATION + 1 });
  // 재시작 복원(§8의 2): 감독 장부에 없는 실행을 실행기가 알린다. 통과하지만 그 세대는 닫는 데만 쓴다.
  base("hello-run-outside-ledger", "감독 장부에 없는 실행을 쥔 실행기의 인사", "hello", DIAGNOSIS, SUPERVISOR, 0, {
    profile_revision: "diagnosis-r1",
    policy_revision: "policy-r1",
    runs: [{ run_id: RUN_ORPHAN, state: "running", run_generation: RUN_ORPHAN_GENERATION, last_receipt_id: null }],
    unacked_ids: [],
  });
  // 위 인사에서 알게 된 세대로 감독이 낸 종료. 실행기는 그 실행을 자기 장부의 세대로 안다.
  base("task-cancel-run-outside-ledger", "장부 밖 실행을 보고된 세대로 닫는다", "task_cancel", SUPERVISOR, DIAGNOSIS, RUN_ORPHAN_GENERATION, {
    run_id: RUN_ORPHAN,
    reason: "requested",
  }, { runGenerations: { [RUN_ORPHAN]: RUN_ORPHAN_GENERATION } });
  base("status-report-not-known", "실행기에 기록이 없는 실행: 세대·영수증 없이 not_known", "status_report", DIAGNOSIS, SUPERVISOR, 0, {
    in_reply_to: id(0x9011),
    runs: [{ run_id: RUN_TASK, state: "not_known", run_generation: null, last_receipt_id: null }],
  });

  // ---- 거절 사례: 기준에서 한 곳만 바꾼다 ----
  const body = (draft: Draft) => draft.body as Record<string, unknown>;
  reject("malformed-request-id", "task-cancel", "malformed", ["message.header.request_id"], "요청 ID가 UUID가 아니다", (d) => {
    d.header.request_id = "not-a-uuid";
  });
  reject("unknown-header-field", "task-cancel", "unknown_field", ["message.header.priority"], "머리에 모르는 칸", (d) => {
    d.header.priority = 1;
  });
  reject("unknown-body-field", "task-cancel", "unknown_field", ["message.body.note"], "본문에 모르는 칸(서명과 digest는 맞음)", (d) => {
    body(d).note = "x";
  });
  reject("contract-v2", "task-cancel", "contract_mismatch", ["message.header.contract"], "다른 계약 판", (d) => {
    d.header.contract = "olive-control/v2";
  });
  reject("unknown-action", "task-cancel", "unknown_action", ["message.header.action"], "여섯 밖의 지시 종류", (d) => {
    d.header.action = "task_restart";
  });
  reject("unknown-sender", "receipt-accepted", "unknown_sender", ["message.header.sender"], "키를 모르는 실행기", (d) => {
    d.header.sender = UNKNOWN_EXECUTOR;
  }, { sign: DIAGNOSIS });
  reject("signed-by-other-key", "report-session-broken", "bad_signature", ["message.signature"], "세션 깨짐 보고를 실행기 키가 아닌 감독 키로 서명", () => {}, {
    sign: SUPERVISOR,
  });
  reject("tampered-run-id", "task-cancel", "bad_signature", ["message.body.run_id", "message.header.body_digest"], "서명 뒤 본문과 digest를 함께 바꿈", (d) => {
    body(d).run_id = RUN_SESSION;
    d.header.body_digest = digestOf(d.body);
  }, { sign: "keep", digest: "keep" });
  reject("noncanonical-signature", "task-cancel", "bad_signature", ["message.signature"], "같은 바이트로 풀리는 다른 서명 표기", (d) => {
    d.signature = respell(d.signature);
  }, { sign: "keep" });
  reject("task-to-session-executor", "session-stop", "wrong_direction", ["message.header.action", "message.body.reason"], "작업 취소를 세션 실행기에", (d) => {
    d.header.action = "task_cancel";
    body(d).reason = "requested";
  });
  reject("broken-report-from-supervisor", "report-session-broken", "wrong_direction", ["message.header.sender"], "세션 깨짐 보고를 감독이 냄", (d) => {
    d.header.sender = SUPERVISOR;
  });
  reject("recipient-storage-reset", "task-cancel", "wrong_recipient", ["context.expected_recipient"], "실행기 저장소가 새로 만들어져 받는 쪽 이름이 바뀜", (d) => {
    d.context.expected_recipient = DIAGNOSIS_NEW_STORAGE;
  });
  reject("lifetime-over-30s", "task-cancel", "lifetime_invalid", ["message.header.expires_at"], "수명이 30초를 넘음", (d) => {
    d.header.expires_at = ISSUED + MESSAGE_TTL_MS + 1;
  });
  reject("issued-in-future", "task-cancel", "not_yet_valid", ["context.now"], "발급 시각이 시계 오차보다 미래", (d) => {
    d.context.now = ISSUED - 1_001;
  });
  reject("expired-instruction", "task-cancel", "expired", ["context.now"], "시한 지난 지시(연결과 무관)", (d) => {
    d.context.now = ISSUED + MESSAGE_TTL_MS;
  });
  reject("takeover-without-permit", "receipt-session-takeover", "body_malformed", ["message.body.start_permit_id"], "시작 허가 ID 없는 세션 인수 영수증", (d) => {
    delete body(d).start_permit_id;
  });
  reject("takeover-without-previous", "receipt-session-takeover", "body_malformed", ["message.body.previous_run_id"], "앞 세대 ID 없는 세션 인수 영수증", (d) => {
    delete body(d).previous_run_id;
  });
  reject("takeover-without-marker", "receipt-session-takeover", "body_malformed", ["message.body.new_generation_marker_digest"], "새 세대 표식 digest 없는 세션 인수 영수증", (d) => {
    delete body(d).new_generation_marker_digest;
  });
  reject("hook-without-prompt-id", "report-hook-event", "body_malformed", ["message.body.prompt_id"], "prompt_id 없는 훅 이벤트", (d) => {
    delete body(d).prompt_id;
  });
  reject("hook-without-session-id", "report-hook-event", "body_malformed", ["message.body.session_id"], "session_id 없는 훅 이벤트", (d) => {
    delete body(d).session_id;
  });
  reject("broken-fourth-cause", "report-session-broken", "body_malformed", ["message.body.cause"], "세 사유 밖의 세션 깨짐 사유", (d) => {
    body(d).cause = "oom_killed";
  });
  reject("body-changed-after-signing", "task-start", "digest_mismatch", ["message.body.budget_tokens"], "서명 뒤 본문만 바꿈(머리와 서명은 그대로)", (d) => {
    body(d).budget_tokens = 9_000_000;
  }, { digest: "keep", sign: "keep" });
  for (const field of ["command", "image", "volumes", "argv", "env"] as const) {
    reject(`task-start-with-${field}`, "task-start", "forbidden_field", [`message.body.${field}`], `작업 시작에 ${field} 칸`, (d) => {
      body(d)[field] = field === "argv" || field === "volumes" ? ["x"] : field === "env" ? { A: "1" } : "x";
    });
  }
  reject("result-with-transcript", "report-result", "forbidden_field", ["message.body.result.transcript"], "결과에 원문 기록 칸", (d) => {
    (body(d).result as Record<string, unknown>).transcript = "...";
  });
  reject("task-role-not-executor-role", "task-start", "role_mismatch", ["message.body.role"], "진단 실행기에 코드 작성 작업", (d) => {
    body(d).role = "code_author";
  });
  reject("result-too-large", "report-result", "result_too_large", ["message.body.result.items"], "모양은 맞지만 결과 상한을 넘음", (d) => {
    (body(d).result as Record<string, unknown>).items = Array.from({ length: 20 }, () => ({ kind: "finding", text: "가".repeat(500) }));
  });
  reject("stale-stop-generation", "task-cancel", "stop_generation_mismatch", ["context.stop_generation"], "비상 정지 뒤의 새 정지 세대(지시는 옛 세대)", (d) => {
    d.context.stop_generation = STOP_GENERATION + 1;
  });
  reject("start-with-future-stop-generation", "task-start", "stop_generation_mismatch", ["message.header.stop_generation"], "작업 시작이 받는 쪽보다 높은 정지 세대를 실어 옴", (d) => {
    d.header.stop_generation = STOP_GENERATION + 1;
  });
  reject("renew-with-future-stop-generation", "run-renew", "stop_generation_mismatch", ["message.header.stop_generation"], "실행 갱신이 받는 쪽보다 높은 정지 세대를 실어 옴", (d) => {
    d.header.stop_generation = STOP_GENERATION + 1;
  });
  reject("new-stop-generation-plain-cancel", "task-cancel-emergency-new-stop-generation", "stop_generation_mismatch", ["message.body.reason"], "새 정지 세대를 실은 취소가 비상 정지가 아님", (d) => {
    body(d).reason = "requested";
  });
  reject("emergency-cancel-older-stop-generation", "task-cancel-emergency-new-stop-generation", "stop_generation_mismatch", ["context.stop_generation"], "받는 쪽이 이미 더 높은 정지 세대(세대는 내려가지 않음)", (d) => {
    d.context.stop_generation = STOP_GENERATION + 2;
  });
  reject("stale-status-report", "status-report", "run_generation_mismatch", [`context.run_generations.${RUN_TASK}`], "감독이 아는 세대와 다른 세대의 실행 상태", (d) => {
    d.context.run_generations[RUN_TASK] = 3;
  });
  reject("not-known-with-generation", "status-report-not-known", "body_malformed", ["message.body.runs[0].run_generation"], "not_known인데 세대가 있음", (d) => {
    ((body(d).runs as Record<string, unknown>[])[0]!).run_generation = 2;
  });
  reject("task-start-deadline-at-receipt", "task-start", "deadline_passed", ["message.body.deadline_at"], "받는 시각이 작업 종료 기한 정각(봉투는 살아 있음)", (d) => {
    body(d).deadline_at = NOW;
  });
  reject("task-start-deadline-passed", "task-start", "deadline_passed", ["message.body.deadline_at"], "받을 때 작업 종료 기한이 1ms 지남(봉투는 살아 있음)", (d) => {
    body(d).deadline_at = NOW - 1;
  });
  reject("cancel-unknown-run", "task-cancel", "unknown_run", [`context.run_generations.${RUN_TASK}`], "받는 쪽이 모르는 실행의 취소", (d) => {
    delete d.context.run_generations[RUN_TASK];
  });
  reject("stale-run-generation", "task-cancel", "run_generation_mismatch", [`context.run_generations.${RUN_TASK}`], "서명은 맞지만 옛 실행 세대", (d) => {
    d.context.run_generations[RUN_TASK] = 3;
  });
  reject("stale-broken-report", "report-session-broken", "run_generation_mismatch", [`context.run_generations.${RUN_SESSION}`], "앞 세대가 낸 세션 깨짐 보고", (d) => {
    d.context.run_generations[RUN_SESSION] = 6;
  });
  reject("replayed-nonce", "task-cancel", "replayed", ["context.spent_nonces[0]"], "이미 쓴 nonce", (d) => {
    d.context.spent_nonces.push({ sender: d.header.sender as string, nonce: d.header.nonce as string });
  });
  return cases;
}

// 마지막 글자의 남는 비트만 바꿔, 해석하면 같은 64바이트가 되는 다른 표기를 만든다.
function respell(signature: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = Buffer.from(signature, "base64url");
  for (const c of alphabet) {
    const candidate = signature.slice(0, -1) + c;
    if (candidate !== signature && Buffer.from(candidate, "base64url").equals(bytes)) return candidate;
  }
  throw new Error("다른 표기를 찾지 못했다");
}
