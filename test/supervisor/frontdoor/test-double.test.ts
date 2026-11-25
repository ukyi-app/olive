// 시험 현관 대역(D-109)의 시험: 대역 포트의 값, 진입점 설정(켜기는 시험 값에서만, 그 밖은 91), 실제 조립에서 켜짐 → 복원 5단계 →
// 소유자 입력 하나 → status 0 → test-job의 장부 쓰기, 꺼짐(기본)의 지금 동작, 장부의 정지가 대역을 이기는 것, 문 직전에 닫힌 경우 쓰기 0.
// 진입점을 실제로 띄워 91로 끝나는 것은 test/entrypoints.test.ts가 본다.
import { describe, expect, test } from "bun:test";
import { CONTRACT as CONTRACT_V1 } from "../../../src/contract/v1/index.ts";
import { CONTRACT as CONTRACT_V2 } from "../../../src/contract/v2/index.ts";
import { type Ledger, openLedger } from "../../../src/ledger/index.ts";
import { frontDoorFor, SUPERVISOR_ENV, settingsFromEnv } from "../../../src/main/supervisor.ts";
import { type AskOutcome, exitFor } from "../../../src/supervisor/admin/client.ts";
import { answerLine, createAdminHandlers } from "../../../src/supervisor/admin/commands.ts";
import { ADMIN_LIMITS, parseReply, type TestJobRequest } from "../../../src/supervisor/admin/protocol.ts";
import {
  TEST_FRONT_DOOR_OWNER,
  TEST_FRONT_DOOR_PEERS,
  TEST_FRONT_DOOR_SOURCE,
  TEST_FRONT_DOOR_SOURCE_TTL_MS,
  TEST_FRONT_DOOR_STOP_GENERATION,
  testFrontDoorPorts,
  testOriginOf,
} from "../../../src/supervisor/frontdoor/test-double.ts";
import type { FrontDoorPorts, RunningSupervisor } from "../../../src/supervisor/runtime/boot.ts";
import { digest } from "../../ledger/helpers.ts";
import { WALL, type World, world } from "../runtime/boot-world.ts";

const FULL: Record<(typeof SUPERVISOR_ENV)[number], string> = {
  OLIVE_SUPERVISOR_PORT: "8443",
  OLIVE_LEDGER_DIR: "/var/lib/olive",
  OLIVE_SIGNING_KEY_DIR: "/etc/olive/signing",
  OLIVE_ACCOUNTS_DIR: "/etc/olive/accounts",
  OLIVE_TLS_DIR: "/etc/olive/tls",
  OLIVE_TRUST_DIR: "/etc/olive/trust",
  OLIVE_REGISTRY_FILE: "/etc/olive/registry/registry.json",
  OLIVE_ENVIRONMENT: "home",
  OLIVE_TARGETS: JSON.stringify([{ target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] }]),
  OLIVE_POLICY_REVISION: "policy-1",
  OLIVE_RESULT_DIR: "/var/lib/olive/results",
};

const JOB: TestJobRequest = {
  owner: TEST_FRONT_DOOR_OWNER,
  key: "smoke-1",
  role: "isolated_reader",
  purpose: "smoke_test",
  sourceRef: `inbox/${TEST_FRONT_DOOR_OWNER}`,
  inputDigest: digest("fixture"),
};
const STATUS_LINE = '{"command":"status"}';

describe("대역 포트", () => {
  test("정지 기록은 정지 아님·세대 0, 이웃 행은 현관 v2·관측 중계 v1·정책 맞음이고 이름은 진입점의 필수 이웃과 같다. 게시는 모름이다. 부를 때마다 새 객체다", async () => {
    const ports = testFrontDoorPorts();
    const stop = await ports.stopAuthority.latestStop();
    expect(stop).toEqual({ generation: 0, stopped: false });
    expect(TEST_FRONT_DOOR_STOP_GENERATION).toBe(0);
    const rows = await ports.peers.contracts();
    expect(rows).toEqual([
      { peer: "front-door", contract: CONTRACT_V2, policy: "match" },
      { peer: "observation-relay", contract: CONTRACT_V1, policy: "match" },
    ]);
    const parsed = settingsFromEnv({ ...FULL, OLIVE_TEST_JOBS: "on", OLIVE_TEST_FRONTDOOR: "on" });
    if (!parsed.ok) throw new Error(parsed.name);
    expect(rows.map((row) => row.peer)).toEqual([...parsed.settings.otherPeers]);
    expect<readonly string[]>([...TEST_FRONT_DOOR_PEERS]).toEqual([...parsed.settings.otherPeers]);
    await expect(ports.publications.lookup("job-1")).rejects.toThrow();
    // 받은 값을 바꿔도 다음 답은 그대로다.
    (stop as { stopped: boolean }).stopped = true;
    rows.length = 0;
    expect(await ports.stopAuthority.latestStop()).toEqual({ generation: 0, stopped: false });
    expect(await ports.peers.contracts()).toHaveLength(2);
  });

  test("소유자 입력은 고정 요청 ID·대역 출처·받은 시각 + 168시간 만료이고, 배정은 대역 출처만 admin으로 본다", () => {
    const made = testFrontDoorPorts().testInput!(WALL);
    expect(made).toEqual({
      requestId: TEST_FRONT_DOOR_OWNER,
      source: TEST_FRONT_DOOR_SOURCE,
      sourceRef: { ref: `${TEST_FRONT_DOOR_SOURCE}/${TEST_FRONT_DOOR_OWNER}`, expiresAt: WALL + 168 * 3_600_000 },
      receivedAt: WALL,
    });
    expect(TEST_FRONT_DOOR_SOURCE_TTL_MS).toBe(604_800_000);
    expect(testOriginOf(TEST_FRONT_DOOR_SOURCE)).toBe("admin");
    for (const other of ["admin", "alert", "admin-dm", "test-front-door ", "TEST-FRONT-DOOR", ""]) expect(testOriginOf(other), other).toBeUndefined();
  });
});

describe("진입점 설정", () => {
  test("OLIVE_TEST_FRONTDOOR: 없음·빈 값·off는 대역 없음, on은 OLIVE_TEST_JOBS=on과 함께일 때만 대역이다. 시험 작업이 꺼진 값(운영 값)의 on과 그 밖의 값은 그 이름으로 invalid(91)다", () => {
    const choice = (env: Record<string, string>) => {
      const parsed = settingsFromEnv({ ...FULL, ...env });
      return parsed.ok ? parsed.frontDoor : parsed;
    };
    expect([choice({}), choice({ OLIVE_TEST_FRONTDOOR: "" }), choice({ OLIVE_TEST_FRONTDOOR: "off" }), choice({ OLIVE_TEST_JOBS: "on", OLIVE_TEST_FRONTDOOR: "off" })]).toEqual([
      "absent",
      "absent",
      "absent",
      "absent",
    ]);
    expect(choice({ OLIVE_TEST_JOBS: "on", OLIVE_TEST_FRONTDOOR: "on" })).toBe("test_double");
    const invalid = { ok: false, name: "OLIVE_TEST_FRONTDOOR", problem: "invalid" } as const;
    for (const jobs of [undefined, "", "off"]) {
      const env: Record<string, string> = jobs === undefined ? { OLIVE_TEST_FRONTDOOR: "on" } : { OLIVE_TEST_JOBS: jobs, OLIVE_TEST_FRONTDOOR: "on" };
      expect(choice(env), `OLIVE_TEST_JOBS=${jobs}`).toEqual(invalid);
    }
    for (const bad of ["ON", "true", "1", "yes", " on", "on "]) {
      expect(choice({ OLIVE_TEST_JOBS: "on", OLIVE_TEST_FRONTDOOR: bad }), bad).toEqual(invalid);
      expect(choice({ OLIVE_TEST_FRONTDOOR: bad }), bad).toEqual(invalid);
    }
    // 필수 이름의 없음과 시험 작업 값의 틀림이 먼저다.
    expect(settingsFromEnv({ ...FULL, OLIVE_SUPERVISOR_PORT: "", OLIVE_TEST_FRONTDOOR: "on" })).toEqual({ ok: false, name: "OLIVE_SUPERVISOR_PORT", problem: "missing" });
    expect(settingsFromEnv({ ...FULL, OLIVE_TEST_JOBS: "x", OLIVE_TEST_FRONTDOOR: "on" })).toEqual({ ok: false, name: "OLIVE_TEST_JOBS", problem: "invalid" });
  });

  test("배정의 출처: 대역이면 대역 출처만 admin, 대역이 없으면 늘 모름이다", () => {
    const originOf = (env: Record<string, string>) => {
      const parsed = settingsFromEnv({ ...FULL, ...env });
      if (!parsed.ok) throw new Error(parsed.name);
      return parsed.settings.assign.originOf;
    };
    expect(originOf({ OLIVE_TEST_JOBS: "on", OLIVE_TEST_FRONTDOOR: "on" })(TEST_FRONT_DOOR_SOURCE)).toBe("admin");
    expect(originOf({ OLIVE_TEST_JOBS: "on", OLIVE_TEST_FRONTDOOR: "on" })("admin-dm")).toBeUndefined();
    expect(originOf({ OLIVE_TEST_JOBS: "on" })(TEST_FRONT_DOOR_SOURCE)).toBeUndefined();
    expect(originOf({})(TEST_FRONT_DOOR_SOURCE)).toBeUndefined();
  });

  test("대역 없음(기본)의 현관 포트는 셋 다 던지고 소유자 입력 자리가 없다", async () => {
    const ports = frontDoorFor("absent");
    await expect(ports.stopAuthority.latestStop()).rejects.toThrow("front_door_absent");
    await expect(ports.peers.contracts()).rejects.toThrow("front_door_absent");
    await expect(ports.publications.lookup("job-1")).rejects.toThrow("front_door_absent");
    expect(ports.testInput).toBeUndefined();
    expect(frontDoorFor("test_double").testInput).toBeFunction();
  });
});

// 실제 조립(boot.ts)과 실제 장부. 장부를 감싸 부른 메서드를 적는다. 진입점처럼 시험 작업을 켜고, 대역이면 출처 정책도 진입점과 같다.
async function bootWith(
  choice: "absent" | "test_double",
  over: { prepare?: (ledger: Ledger) => void; front?: (ports: FrontDoorPorts) => FrontDoorPorts } = {},
): Promise<{ w: World; running: RunningSupervisor; calls: string[]; raw: () => Ledger }> {
  const calls: string[] = [];
  let raw: Ledger | null = null;
  const base = frontDoorFor(choice);
  const w = world({
    settings: { testJobs: true },
    deps: {
      frontDoor: over.front === undefined ? base : over.front(base),
      openLedger: (file, options) => {
        const result = openLedger(file, options);
        if (!result.ok) return result;
        raw = result.ledger;
        const ledger = new Proxy(result.ledger, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              calls.push(String(key));
              return Reflect.apply(value, target, args);
            };
          },
        });
        return { ...result, ledger };
      },
    },
  });
  w.settings = { ...w.settings, assign: { ...w.settings.assign, originOf: choice === "test_double" ? testOriginOf : () => undefined } };
  if (over.prepare !== undefined) {
    const opened = openLedger(w.ledgerPath, { clock: () => WALL, mode: "reopen" });
    if (!opened.ok) throw new Error(opened.reason);
    over.prepare(opened.ledger);
    opened.ledger.close();
  }
  const result = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  return { w, running: result.running, calls, raw: () => raw as unknown as Ledger };
}

const events = (w: World, name: string) => w.events.filter((e) => e.event === name).map((e) => e.fields);
async function cycles(w: World, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
}
const ask = (w: World, running: RunningSupervisor, line: string, command: "status" | "test-job"): { reply: unknown; code: number } => {
  const reply = parseReply(answerLine(line, createAdminHandlers(running.admin, running.testJob), w.deps.monoNow() + ADMIN_LIMITS.serverWaitMs).slice(0, -1));
  return { reply, code: exitFor({ kind: "reply", reply } as AskOutcome, command).code };
};
const statusOf = (w: World, running: RunningSupervisor) => ask(w, running, STATUS_LINE, "status");
const jobOf = (w: World, running: RunningSupervisor, job: TestJobRequest = JOB) => ask(w, running, JSON.stringify({ command: "test-job", ...job }), "test-job");
const count = (calls: readonly string[], name: string) => calls.filter((call) => call === name).length;

describe("실제 조립", () => {
  test("대역 켜짐: 복원 5단계가 열림으로 끝나고, 그 뒤 주기에서 소유자 입력이 한 번 들어가며, status는 0이고 test-job은 장부 쓰기 recordToolRequest까지 간다", async () => {
    const { w, running, calls, raw } = await bootWith("test_double");
    await cycles(w, 10);
    expect(events(w, "restore_step").find((f) => f.step === 5)).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });
    expect(events(w, "restore_retry")).toEqual([]);
    expect(count(calls, "enqueueInput")).toBe(1);
    expect(events(w, "front_door_test_input")).toEqual([{ outcome: "created", reason: null }]);
    // 5단계를 받아들인 기록 뒤에만 넣는다.
    const order = w.events.map((e) => (e.event === "restore_step" ? `restore_step:${e.fields.step}` : e.event));
    expect(order.indexOf("restore_step:5")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("front_door_test_input")).toBeGreaterThan(order.indexOf("restore_step:5"));
    const inputs = raw().listInputs();
    expect(inputs).toMatchObject({ known: true, value: [{ requestId: TEST_FRONT_DOOR_OWNER, source: TEST_FRONT_DOOR_SOURCE, receivedAt: WALL, cancelled: false }] });
    const status = statusOf(w, running);
    expect(status.code).toBe(0);
    expect(status.reply).toMatchObject({ kind: "status", status: { alive: true, intakeOpen: true, stop: "none", stopGeneration: 0, queued: 0 } });
    const before = calls.length;
    const job = jobOf(w, running);
    expect(job.code).toBe(0);
    expect(job.reply).toMatchObject({ kind: "test_job", outcome: "created" });
    expect(calls.slice(before)).toEqual(["peekStatus", "listInputs", "recordToolRequest"]);
    expect(raw().listWaitingToolRequests()).toMatchObject({ known: true, value: [{ owner: TEST_FRONT_DOOR_OWNER, role: JOB.role }] });
    // 주기를 더 돌아도 입력은 다시 넣지 않고 감독은 계속 돈다.
    await cycles(w, 5);
    expect(count(calls, "enqueueInput")).toBe(1);
    expect(statusOf(w, running).reply).toMatchObject({ kind: "status", status: { alive: true, queued: 1 } });
    expect(w.names()).not.toContain("fatal");
    expect(await running.stop()).toBe(0);
  });

  test("대역 꺼짐(기본): 현관 포트가 던져 복원 1단계를 되풀이하고, 입력은 들어가지 않으며 status·test-job은 restore_not_done(3)이다", async () => {
    const { w, running, calls, raw } = await bootWith("absent");
    await cycles(w, 10);
    expect(events(w, "restore_step")).toEqual([]);
    expect(events(w, "restore_retry")).toEqual([{ step: 1 }]);
    expect(count(calls, "enqueueInput")).toBe(0);
    expect(events(w, "front_door_test_input")).toEqual([]);
    expect(raw().listInputs()).toEqual({ known: true, value: [] });
    expect(statusOf(w, running)).toEqual({ reply: { kind: "unknown", reason: "restore_not_done" }, code: 3 });
    expect(jobOf(w, running)).toEqual({ reply: { kind: "unknown", reason: "restore_not_done" }, code: 3 });
    expect(await running.stop()).toBe(0);
  });

  test("장부의 정지가 대역을 이긴다: 같은 세대(0)의 정지면 5단계가 stopped로 닫히고 입력 0, 더 높은 세대(3)의 정지 아님이면 세대 3 그대로 열린다", async () => {
    const stopped = await bootWith("test_double", { prepare: (ledger) => expect(ledger.applyStop({ generation: 0, stopped: true, now: WALL })).toMatchObject({ ok: true }) });
    await cycles(stopped.w, 10);
    expect(events(stopped.w, "restore_step").find((f) => f.step === 5)).toEqual({ step: 5, intakeMayOpen: false, closedBecause: "stopped" });
    expect(count(stopped.calls, "enqueueInput")).toBe(0);
    expect(stopped.raw().listInputs()).toEqual({ known: true, value: [] });
    expect(statusOf(stopped.w, stopped.running).reply).toMatchObject({ kind: "status", status: { intakeOpen: false, stopGeneration: 0 } });
    expect(await stopped.running.stop()).toBe(0);

    const higher = await bootWith("test_double", { prepare: (ledger) => expect(ledger.applyStop({ generation: 3, stopped: false, now: WALL })).toMatchObject({ ok: true }) });
    await cycles(higher.w, 10);
    expect(events(higher.w, "restore_step").find((f) => f.step === 5)).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });
    expect(statusOf(higher.w, higher.running).reply).toMatchObject({ kind: "status", status: { intakeOpen: true, stopGeneration: 3 } });
    expect(count(higher.calls, "enqueueInput")).toBe(1);
    expect(await higher.running.stop()).toBe(0);
  });

  test("문: 입력을 만드는 사이에 끝 차례가 시작되거나 접수 허가가 사라지면 장부에 넣지 않는다", async () => {
    for (const model of ["stop", "revoke"] as const) {
      let hook: () => void = () => {};
      const { w, running, calls, raw } = await bootWith("test_double", {
        front: (ports) => ({
          ...ports,
          testInput: (receivedAt) => {
            hook();
            return ports.testInput!(receivedAt);
          },
        }),
      });
      hook = model === "stop" ? () => void running.stop() : () => void raw().applyStop({ generation: 1, stopped: false, now: WALL + 1 });
      await cycles(w, 10);
      expect(events(w, "restore_step").find((f) => f.step === 5), model).toEqual({ step: 5, intakeMayOpen: true, closedBecause: "" });
      expect(count(calls, "enqueueInput"), model).toBe(0);
      expect(events(w, "front_door_test_input"), model).toEqual([{ outcome: "closed", reason: null }]);
      const code = await running.done;
      expect(code, model).toBe(model === "stop" ? 0 : 96);
    }
  });
});
