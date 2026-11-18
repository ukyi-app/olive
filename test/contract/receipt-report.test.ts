import { expect, test } from "bun:test";
import { ACTION_SPECS } from "../../src/contract/v1/actions.ts";
import { HOOK_EVENTS, SESSION_BROKEN_CAUSES, STOP_FAILURE_ERRORS } from "../../src/contract/v1/report.ts";
import { RESULT_MAX_BYTES } from "../../src/contract/v1/limits.ts";
import { resultDigest } from "../../src/contract/v1/result.ts";
import { buildCases, freshKeys, hash } from "./cases.ts";
import { verifyCase, withBody } from "./support.ts";

const keys = freshKeys();
const cases = buildCases(keys);
const reason = async (name: string, change: (b: Record<string, unknown>) => unknown) => {
  const result = await verifyCase(withBody(cases, keys, name, change));
  return result.ok ? "ok" : result.reason;
};

test("receipt: 세션 인수 영수증은 앞 세대 ID·새 세대 표식 digest·시작 허가 ID가 없으면 무효", async () => {
  expect(await reason("receipt-session-takeover", () => {})).toBe("ok");
  for (const field of ["previous_run_id", "new_generation_marker_digest", "start_permit_id"]) {
    expect(await reason("receipt-session-takeover", (b) => void delete b[field]), field).toBe("body_malformed");
    expect(await reason("receipt-session-takeover", (b) => void (b[field] = null)), field).toBe("body_malformed");
    expect(await reason("receipt-session-takeover", (b) => void (b[field] = "")), field).toBe("body_malformed");
  }
  // 세션 실행기만 낸다. 작업자 실행기는 남은 프로세스 0개 영수증(receipt_stopped)을 낸다.
  expect(ACTION_SPECS.receipt_session_takeover.from).toEqual(["session_executor"]);
  expect(ACTION_SPECS.receipt_stopped.from).toEqual(["worker_executor"]);
});

test("receipt: 앞 세대가 장부의 세대와 다르거나 모르는 실행이면 거절", async () => {
  const takeover = cases.find((c) => c.name === "accept/receipt-session-takeover")!;
  const runs = takeover.context.run_generations;
  const previous = (takeover.message.body as { previous_run_id: string }).previous_run_id;
  const stale = { ...takeover, context: { ...takeover.context, run_generations: { ...runs, [previous]: runs[previous]! + 1 } } };
  expect(await verifyCase(stale)).toEqual({ ok: false, reason: "run_generation_mismatch" });
  const unknown = { ...takeover, context: { ...takeover.context, run_generations: {} } };
  expect(await verifyCase(unknown)).toEqual({ ok: false, reason: "unknown_run" });
});

test("receipt: 종료 확인은 남은 프로세스 0개일 때만", async () => {
  expect(await reason("receipt-stopped", (b) => void (b.remaining_processes = 1))).toBe("body_malformed");
});

test("receipt: 같은 영수증은 같은 id와 같은 digest다(다시 담아도 본문이 같다)", () => {
  for (const name of ["receipt-accepted", "receipt-started", "receipt-stopped", "receipt-cleaned", "receipt-session-takeover"]) {
    const c = cases.find((x) => x.name === `accept/${name}`)!;
    expect(typeof (c.message.body as { receipt_id?: unknown }).receipt_id, name).toBe("string");
  }
  for (const name of ["report-session-broken", "report-rule-check", "report-hook-event", "report-result"]) {
    const c = cases.find((x) => x.name === `accept/${name}`)!;
    expect(typeof (c.message.body as { report_id?: unknown }).report_id, name).toBe("string");
  }
});

test("report: 세션 깨짐 보고는 실행기 키 서명이고 사유는 셋뿐이다", async () => {
  expect([...SESSION_BROKEN_CAUSES]).toEqual(["main_exited", "main_restarted_alone", "relay_lost"]);
  for (const cause of SESSION_BROKEN_CAUSES) expect(await reason("report-session-broken", (b) => void (b.cause = cause)), cause).toBe("ok");
  for (const cause of ["oom_killed", "unknown", ""]) expect(await reason("report-session-broken", (b) => void (b.cause = cause)), cause).toBe("body_malformed");
  expect(ACTION_SPECS.report_session_broken.from).toEqual(["session_executor"]);
  const byOtherKey = cases.find((c) => c.name === "reject/signed-by-other-key")!;
  expect(await verifyCase(byOtherKey)).toEqual({ ok: false, reason: "bad_signature" });
  const fromSupervisor = cases.find((c) => c.name === "reject/broken-report-from-supervisor")!;
  expect(await verifyCase(fromSupervisor)).toEqual({ ok: false, reason: "wrong_direction" });
  expect(await reason("report-session-broken", (b) => void delete b.generation_marker_digest)).toBe("body_malformed");
});

test("report: 훅 이벤트 보고는 session_id·prompt_id가 없으면 무효", async () => {
  for (const field of ["session_id", "prompt_id"]) {
    expect(await reason("report-hook-event", (b) => void delete b[field]), field).toBe("body_malformed");
    expect(await reason("report-hook-event", (b) => void (b[field] = null)), field).toBe("body_malformed");
  }
  for (const event of HOOK_EVENTS) {
    const error = event === "StopFailure" ? "rate_limit" : null;
    expect(await reason("report-hook-event", (b) => void Object.assign(b, { event, error })), event).toBe("ok");
    expect(await reason("report-hook-event", (b) => void Object.assign(b, { event, error: error ? null : "rate_limit" })), event).toBe("body_malformed");
  }
  expect(STOP_FAILURE_ERRORS).toHaveLength(12);
  // 모델이 쓴 글은 신호가 아니다. 그런 칸은 없다.
  expect(await reason("report-hook-event", (b) => void (b.last_assistant_message = "끝"))).toBe("unknown_field");
});

test("report: 규칙 확인 기록은 재시작 전후 표식이 달라야 하고, 규칙이 빠지면 허가가 없다", async () => {
  expect(await reason("report-rule-check", (b) => void (b.restarted_marker_digest = b.first_marker_digest))).toBe("body_malformed");
  expect(await reason("report-rule-check", (b) => void (b.start_permit_id = null))).toBe("body_malformed");
  expect(await reason("report-rule-check", (b) => void Object.assign(b, { outcome: "rule_missing", restarted_marker_digest: null, start_permit_id: null }))).toBe(
    "ok",
  );
  expect(await reason("report-rule-check", (b) => void (b.outcome = "rule_missing"))).toBe("body_malformed");
});

test("result: 원문 로그·사고 과정을 실을 칸이 없고 크기 상한이 있다", async () => {
  for (const field of ["log", "logs", "stdout", "stderr", "transcript", "thinking", "reasoning", "raw_log"]) {
    expect(await reason("report-result", (b) => void ((b.result as Record<string, unknown>)[field] = "x")), field).toBe("forbidden_field");
  }
  expect(await reason("report-result", (b) => void ((b.result as Record<string, unknown>).notes = "x"))).toBe("unknown_field");
  expect(
    await reason("report-result", (b) => void ((b.result as Record<string, unknown>).refs = [{ kind: "artifact", ref: "a", digest: null }])),
  ).toBe("body_malformed");
  expect(await reason("report-result", (b) => void ((b.result as Record<string, unknown>).summary = "줄\u0007"))).toBe("body_malformed");
  expect(await reason("report-result", (b) => void ((b.result as Record<string, unknown>).summary = "가".repeat(2_001)))).toBe("body_malformed");
  expect(await reason("report-result", (b) => void ((b.result as Record<string, unknown>).role = "code_author"))).toBe("role_mismatch");
  const big = cases.find((c) => c.name === "reject/result-too-large")!;
  expect(Buffer.byteLength(JSON.stringify((big.message.body as { result: unknown }).result))).toBeGreaterThan(RESULT_MAX_BYTES);
  expect(await verifyCase(big)).toEqual({ ok: false, reason: "result_too_large" });
});

test("result: 결과 digest는 정규 직렬화의 SHA-256이다(result_finalize가 싣는 값)", () => {
  const result = (cases.find((c) => c.name === "accept/report-result")!.message.body as { result: Parameters<typeof resultDigest>[0] }).result;
  expect(resultDigest(result)).toMatch(/^[0-9a-f]{64}$/);
  expect(resultDigest(JSON.parse(JSON.stringify(result)))).toBe(resultDigest(result));
  expect(resultDigest({ ...result, summary: `${result.summary} ` })).not.toBe(resultDigest(result));
  expect(hash("x")).not.toBe(resultDigest(result));
});
