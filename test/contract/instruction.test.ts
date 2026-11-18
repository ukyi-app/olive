import { expect, test } from "bun:test";
import { ACTION_SPECS } from "../../src/contract/v1/actions.ts";
import { ACTIONS } from "../../src/contract/v1/header.ts";
import { INSTRUCTIONS } from "../../src/contract/v1/instruction.ts";
import { ROLES } from "../../src/contract/v1/role.ts";
import { FORBIDDEN_FIELD_NAMES } from "../../src/contract/v1/schema.ts";
import { buildCases, freshKeys, ISSUED } from "./cases.ts";
import { verifyCase, withBody } from "./support.ts";

const keys = freshKeys();
const cases = buildCases(keys);

test("instruction: 지시(감독 → 실행기)는 여섯뿐이다", () => {
  expect([...INSTRUCTIONS]).toEqual(["session_start", "session_stop", "task_start", "task_cancel", "run_renew", "result_finalize"]);
  const fromSupervisorWithEffect = ACTIONS.filter((a) => ACTION_SPECS[a].from.includes("supervisor") && ACTION_SPECS[a].class !== "transport");
  expect(fromSupervisorWithEffect.sort()).toEqual([...INSTRUCTIONS].sort());
  for (const action of INSTRUCTIONS) expect(ACTION_SPECS[action]).toMatchObject({ class: "instruction", from: ["supervisor"] });
  // 감독이 내는 전송 메시지는 읽기(status_query), 받음 확인(ack), 정지 세대 맞춤의 답(stop_sync_reply)뿐이다.
  // 실행을 열거나 지목하지 않고 자격을 싣지 않는다.
  const transport = ACTIONS.filter((a) => ACTION_SPECS[a].from.includes("supervisor") && ACTION_SPECS[a].class === "transport");
  expect(transport.sort()).toEqual(["ack", "status_query", "stop_sync_reply"]);
  for (const action of transport) expect(ACTION_SPECS[action]).toMatchObject({ opensRun: false, runField: null });
});

test("instruction: 여섯 밖의 종류는 거절한다", async () => {
  const base = cases.find((c) => c.name === "reject/unknown-action")!;
  expect(await verifyCase(base)).toEqual({ ok: false, reason: "unknown_action" });
  for (const action of ["task_restart", "exec", "run_command", "Task_Start", ""]) {
    const c = structuredClone(base);
    c.message.header.action = action as never;
    expect(await verifyCase(c), action).toEqual({ ok: false, reason: "unknown_action" });
  }
});

test("instruction: 명령·이미지·볼륨·argv·환경 칸이 있으면 어느 깊이든 거절한다(완료 조건 4)", async () => {
  for (const name of ["session-start", "task-start", "task-cancel", "run-renew", "result-finalize", "session-stop"]) {
    for (const field of FORBIDDEN_FIELD_NAMES) {
      const top = withBody(cases, keys, name, (b) => {
        b[field] = "x";
      });
      expect(await verifyCase(top), `${name}.${field}`).toEqual({ ok: false, reason: "forbidden_field" });
    }
    for (const field of ["Command", "IMAGE", "env-vars", "host_path", "entry_point"]) {
      const spelled = withBody(cases, keys, name, (b) => {
        b[field] = "x";
      });
      expect(await verifyCase(spelled), `${name}.${field}`).toEqual({ ok: false, reason: "forbidden_field" });
    }
  }
  const nested = withBody(cases, keys, "task-start", (b) => {
    (b.credential as Record<string, unknown>).env = { TOKEN: "x" };
  });
  expect(await verifyCase(nested)).toEqual({ ok: false, reason: "forbidden_field" });
});

test("instruction: 모르는 칸과 빠진 칸은 거절한다", async () => {
  for (const name of ["session-start", "session-stop", "task-start", "task-cancel", "run-renew", "result-finalize"]) {
    expect(await verifyCase(withBody(cases, keys, name, (b) => void (b.priority = 1))), name).toEqual({ ok: false, reason: "unknown_field" });
    expect(await verifyCase(withBody(cases, keys, name, (b) => void delete b.run_id)), name).toEqual({ ok: false, reason: "body_malformed" });
  }
});

test("instruction: 작업 시작의 역할은 실행기의 고정 역할과 같아야 한다", async () => {
  for (const role of ROLES) {
    const result = await verifyCase(withBody(cases, keys, "task-start", (b) => void (b.role = role)));
    expect(result.ok ? "ok" : result.reason, role).toBe(role === "diagnosis" ? "ok" : "role_mismatch");
  }
  expect(await verifyCase(withBody(cases, keys, "task-start", (b) => void (b.role = "session")))).toEqual({ ok: false, reason: "body_malformed" });
});

test("instruction: 값의 범위(기한, 임대, 결과 digest, 사유)", async () => {
  const reason = async (name: string, change: (b: Record<string, unknown>) => void) => {
    const result = await verifyCase(withBody(cases, keys, name, change));
    return result.ok ? "ok" : result.reason;
  };
  expect(await reason("task-start", (b) => void (b.deadline_at = ISSUED))).toBe("body_malformed");
  expect(await reason("task-start", (b) => void (b.budget_tokens = 0))).toBe("body_malformed");
  expect(await reason("run-renew", (b) => void (b.lease_until = ISSUED + 30_001))).toBe("body_malformed");
  expect(await reason("run-renew", (b) => void (b.lease_until = ISSUED))).toBe("body_malformed");
  expect(await reason("result-finalize", (b) => void (b.result_digest = null))).toBe("body_malformed");
  expect(await reason("result-finalize", (b) => void Object.assign(b, { outcome: "failed", result_digest: null }))).toBe("ok");
  expect(await reason("result-finalize", (b) => void (b.outcome = "failed"))).toBe("body_malformed");
  expect(await reason("session-stop", (b) => void (b.reason = "because"))).toBe("body_malformed");
  expect(await reason("session-start", (b) => void (b.takeover_receipt_id = null))).toBe("ok");
  expect(await reason("session-start", (b) => void delete b.rule_check_id)).toBe("body_malformed");
  expect(await reason("session-start", (b) => void ((b.credential as Record<string, unknown>).value = "secret"))).toBe("unknown_field");
});
