import { expect, test } from "bun:test";
import { ACTION_SPECS } from "../../src/contract/v1/actions.ts";
import { ACTIONS } from "../../src/contract/v1/header.ts";
import { INSTRUCTIONS } from "../../src/contract/v1/instruction.ts";
import { CLOCK_SKEW_MS, DELIVERY_MAX_MS, DISCONNECT_JUDGE_MS, MESSAGE_TTL_MS, RENEW_INTERVAL_MS, RUN_LEASE_MAX_MS } from "../../src/contract/v1/limits.ts";
import {
  classifyDelivery,
  type Link,
  mayIssue,
  maySend,
  queriesAfterReconnect,
  RUN_STATES,
  STARTS_RUN,
  stateAfterLoss,
  viewLink,
} from "../../src/contract/v1/transport.ts";
import { signUnchecked } from "../../src/contract/v1/envelope.ts";
import { buildCases, freshKeys, id, ISSUED, NOW } from "./cases.ts";
import { verifyCase } from "./support.ts";

const connected: Link = { state: "connected", since: NOW - 60_000, last_seen_at: NOW - 1_000 };
const disconnected: Link = { state: "disconnected", since: NOW - 1_000 };

test("transport: 전달 지연 상한(과 시계 오차)이 지시 시한보다 작다", () => {
  expect(DELIVERY_MAX_MS + CLOCK_SKEW_MS).toBeLessThan(MESSAGE_TTL_MS);
  expect(DELIVERY_MAX_MS).toBeGreaterThan(0);
  // 갱신 주기 안에 갱신이 한 번 이상 닿아야 임대가 끊기지 않는다.
  expect(RENEW_INTERVAL_MS + DELIVERY_MAX_MS).toBeLessThanOrEqual(RUN_LEASE_MAX_MS);
  expect(RUN_LEASE_MAX_MS).toBeLessThanOrEqual(DISCONNECT_JUDGE_MS);
});

test("transport: 연결 없음 상태에서는 새 실행·새 자격 지시를 만들 수 없다", () => {
  expect([...STARTS_RUN].sort()).toEqual(["session_start", "task_start"]);
  for (const action of STARTS_RUN) {
    expect(mayIssue(action, connected, NOW)).toEqual({ ok: true });
    expect(mayIssue(action, disconnected, NOW)).toEqual({ ok: false, reason: "no_connection" });
    expect(mayIssue(action, disconnected, NOW + DISCONNECT_JUDGE_MS)).toEqual({ ok: false, reason: "no_connection" });
    // 연결은 있는데 끊김 판정 시간 동안 아무것도 받지 못했으면 연결 없음과 같다.
    expect(mayIssue(action, connected, connected.last_seen_at + DISCONNECT_JUDGE_MS)).toEqual({ ok: false, reason: "no_connection" });
  }
  // 다른 지시도 쌓아 두지 않는다. 효과 없는 전송 메시지는 연결 규칙의 대상이 아니다(보낼 연결이 있을 때만 실린다).
  for (const action of INSTRUCTIONS) expect(mayIssue(action, disconnected, NOW).ok, action).toBe(false);
  expect(mayIssue("status_query", disconnected, NOW)).toEqual({ ok: true });
  // 새 실행을 여는 지시는 STARTS_RUN과 같다(표와 규칙이 어긋나지 않는다).
  expect(ACTIONS.filter((a) => ACTION_SPECS[a].opensRun).sort()).toEqual([...STARTS_RUN].sort());
});

test("transport: 끊김 판정 뒤 끝났다고 증명되지 않은 실행은 unknown_running이다", () => {
  expect(viewLink(disconnected, NOW)).toBe("disconnected");
  expect(viewLink(disconnected, disconnected.since + DISCONNECT_JUDGE_MS)).toBe("lost");
  expect(viewLink(connected, NOW)).toBe("connected");
  for (const state of ["preparing", "running", "stopping", "checking", "unknown_running", "not_known"] as const) {
    expect(stateAfterLoss(state), state).toBe("unknown_running");
  }
  for (const state of ["finalized", "not_started", "failed_stopped", "ready_result", "cleanup_pending"] as const) {
    expect(stateAfterLoss(state), state).toBe(state);
  }
  expect(RUN_STATES).toContain("not_known");
});

test("transport: 재접속 뒤 같은 실행 ID의 상태 조회만 있고 새 실행 ID를 만드는 재전송 모양이 없다", async () => {
  const ids = [...Array.from({ length: 9 }, (_, i) => id(i + 1)), id(1)];
  const queries = queriesAfterReconnect(ids);
  expect(queries.flatMap((q) => q.run_ids).sort()).toEqual([...new Set(ids)].sort());
  for (const q of queries) expect(Object.keys(q)).toEqual(["run_ids"]);
  // 상태 조회의 본문에는 실행 ID 말고 칸이 없다. 지시를 다시 싣거나 새 실행 ID를 받는 칸이 없다.
  const keys = freshKeys();
  const cases = buildCases(keys);
  const query = cases.find((c) => c.name === "accept/status-query")!;
  for (const extra of [{ retry_of: ISSUED }, { resend: true }, { new_run_id: query.message.body }, { instruction: "task_start" }]) {
    const c = structuredClone(query);
    Object.assign(c.message.body as object, extra);
    expect((await verifyCase(c)).ok, JSON.stringify(Object.keys(extra))).toBe(false);
  }
  // 어떤 본문 해석기에도 재전송을 뜻하는 칸이 없다. 새 실행은 task_start·session_start로만 열린다.
  for (const c of cases.filter((x) => x.expect.ok)) {
    expect(JSON.stringify(c.message.body), c.name).not.toMatch(/retry|resend|replay|redeliver/);
  }
});

test("transport: 같은 영수증을 두 번 받아도 같은 것으로 판정할 칸(영수증 ID)이 있다", () => {
  const seen = new Map<string, string>();
  const receipt = "00000000-0000-4000-8000-000000000401";
  expect(classifyDelivery(seen, receipt, "d1")).toEqual({ ok: true, delivery: "new" });
  seen.set(receipt, "d1");
  expect(classifyDelivery(seen, receipt, "d1")).toEqual({ ok: true, delivery: "duplicate" });
  expect(classifyDelivery(seen, receipt, "d2")).toEqual({ ok: false, reason: "receipt_conflict" });
});

test("transport: 다시 보낸 영수증은 새 봉투(새 nonce)지만 같은 본문이라 같은 영수증으로 판정된다", async () => {
  const keys = freshKeys();
  const [first, again] = [buildCases(keys), buildCases(keys)].map((all) => all.find((c) => c.name === "accept/receipt-accepted")!);
  const resent = structuredClone(again!);
  resent.message.header.nonce = "f".repeat(32);
  resent.message = signUnchecked(resent.message.header, resent.message.body, keys[resent.message.header.sender]!.privateKey);
  const a = await verifyCase(first!);
  const b = await verifyCase(resent);
  if (!a.ok || !b.ok) throw new Error("통과해야 한다");
  expect(a.header.nonce).not.toBe(b.header.nonce);
  const seen = new Map([[(a.body as { receipt_id: string }).receipt_id, a.header.body_digest]]);
  expect(classifyDelivery(seen, (b.body as { receipt_id: string }).receipt_id, b.header.body_digest)).toEqual({ ok: true, delivery: "duplicate" });
});

test("transport: 시한 지난 지시는 연결이 살아 있어도 거절, 남은 시한이 전달 상한보다 짧으면 싣지 않는다", async () => {
  const expired = buildCases(freshKeys()).find((c) => c.name === "reject/expired-instruction")!;
  const live: Link = { state: "connected", since: ISSUED, last_seen_at: expired.context.now - 1_000 };
  expect(mayIssue("task_cancel", live, expired.context.now)).toEqual({ ok: true });
  expect(await verifyCase(expired)).toEqual({ ok: false, reason: "expired" });
  const header = { expires_at: ISSUED + MESSAGE_TTL_MS };
  expect(maySend(header, header.expires_at - DELIVERY_MAX_MS)).toEqual({ ok: true });
  expect(maySend(header, header.expires_at - DELIVERY_MAX_MS + 1)).toEqual({ ok: false, reason: "too_late_to_send" });
});
