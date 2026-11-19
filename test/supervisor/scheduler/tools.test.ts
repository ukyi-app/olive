import { describe, expect, test } from "bun:test";
import { ROLES, type Role } from "../../../src/contract/v1/index.ts";
import { SHA256 as CONTRACT_SHA256, UUID as CONTRACT_UUID } from "../../../src/contract/v1/schema.ts";
import { SHA256 as LEDGER_SHA256, SOURCE_REF as LEDGER_SOURCE_REF, UUID as LEDGER_UUID } from "../../../src/ledger/input.ts";
import {
  type Answer,
  handleToolCall,
  PATTERNS,
  type Phase,
  type ResultView,
  TOOL_NAMES,
  TOOL_REFUSALS,
  type ToolAnswer,
  type ToolCallContext,
  type ToolPorts,
  type WorkRecord,
} from "../../../src/supervisor/scheduler/tools.ts";
import { list, readText } from "../../files.ts";

// 숫자와 ID는 이 시험이 고른 값이다. 운영값이 아니다.
const NOW = 1_800_000_000_000;
const BRIEF_MAX = 200;
const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const REQ_A = "aaaaaaaa-0000-4000-8000-000000000001";
const REQ_B = "bbbbbbbb-0000-4000-8000-000000000002";
const SRC_A = "inputs/aaaaaaaa-1111-4000-8000-000000000001";
const SRC_B = "inputs/bbbbbbbb-1111-4000-8000-000000000002";
const MISSING_REF = "eeeeeeee-0000-4000-8000-00000000000e";

let counter = 0;
const uuid = (prefix: string) => `${prefix}-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

interface World {
  liveSession: { id: string; generation: number } | null | "unknown";
  policy: Partial<Record<Role, string[]>>;
  pinned: { owner: string; sourceRef: string; inputDigest: string }[];
  works: WorkRecord[];
  results: Record<string, ResultView>;
  newRefs: string[];
  // 새 접수의 처음 단계. 맞는 실행기·계정이 없으면 배정 전 대기다.
  startPhase: Phase;
}

// 장부 쪽 포트의 가짜. 일부러 포트의 소유자 전제를 지키지 않는다: 재시도 키가 같으면 소유자와 무관하게 그 줄을 돌려주고
// (장부 admitRun의 중복 키와 같은 성질), 참조로 읽을 때도 소유자로 거르지 않는다.
// 그래서 소유 대조를 처리기가 하지 않으면 이 가짜에서 남의 실행이 보인다.
function fakePorts(world: World, faults: { throwOn?: string; unknownOn?: string } = {}) {
  const calls: string[] = [];
  const writes: string[] = [];
  const answer = <T>(name: string, value: () => T): Answer<T> => {
    calls.push(name);
    if (faults.throwOn === name) throw new Error("포트 실패");
    if (faults.unknownOn === name) return { known: false };
    return { known: true, value: value() };
  };
  const ports: ToolPorts = {
    config: { purposeBriefMaxChars: BRIEF_MAX },
    policy: {
      judge(role, purpose) {
        const allowed = world.policy[role];
        if (allowed === undefined) return "role_not_allowed";
        return allowed.includes(purpose) ? "allowed" : "purpose_not_allowed";
      },
    },
    ledger: {
      liveSession: () => {
        const live = world.liveSession;
        if (live === "unknown") {
          calls.push("liveSession");
          return { known: false };
        }
        return answer("liveSession", () => live);
      },
      inputPinned: (q) =>
        answer("inputPinned", () => world.pinned.some((p) => p.owner === q.owner && p.sourceRef === q.sourceRef && p.inputDigest === q.inputDigest)),
      findByRetryKey: (q) => answer("findByRetryKey", () => world.works.find((w) => w.retryKey === q.retryKey) ?? null),
      // 소유자로 거르지 않는 가짜다. 처리기가 돌려받은 줄의 소유자를 대조해야 한다.
      readOwnedWork: (q) => answer("readOwnedWork", () => world.works.find((w) => w.ref === q.ref) ?? null),
      readResult: (ref) => answer("readResult", () => world.results[ref] ?? { state: "none" }),
      recordStart: (input) =>
        answer("recordStart", () => {
          writes.push("recordStart");
          const same = world.works.find((w) => w.retryKey === input.retryKey);
          if (same) return { ok: true as const, record: same };
          const ref = world.newRefs.shift() ?? uuid("cccccccc");
          const record: WorkRecord = { ref, owner: input.owner, retryKey: input.retryKey, content: input.content, phase: world.startPhase };
          world.works.push(record);
          return { ok: true as const, record };
        }),
      requestCancel: (input) =>
        answer("requestCancel", () => {
          writes.push("requestCancel");
          const work = world.works.find((w) => w.ref === input.ref);
          if (!work) throw new Error("없는 실행의 취소");
          if (work.phase === "finalized" || work.phase === "not_started") return { ok: false as const, reason: "already_ended" as const };
          const phase: Phase = work.phase === "queued" || work.phase === "waiting_assignment" ? "not_started" : work.phase;
          const index = world.works.indexOf(work);
          world.works[index] = { ...work, phase };
          return { ok: true as const, phase };
        }),
    },
  };
  return { ports, calls, writes };
}

function world(over: Partial<World> = {}): World {
  return {
    liveSession: { id: "session-1", generation: 1 },
    policy: { diagnosis: ["diagnose"], isolated_reader: ["read_source"], pr_review: ["review_pr"] },
    pinned: [
      { owner: REQ_A, sourceRef: SRC_A, inputDigest: D1 },
      { owner: REQ_A, sourceRef: SRC_A, inputDigest: D2 },
      { owner: REQ_B, sourceRef: SRC_B, inputDigest: D1 },
    ],
    works: [],
    results: {},
    newRefs: [],
    startPhase: "queued",
    ...over,
  };
}

function ctx(over: Partial<ToolCallContext> = {}): ToolCallContext {
  return { session: { id: "session-1", generation: 1 }, requestId: REQ_A, callId: uuid("dddddddd"), now: NOW, stop: { known: true, stopped: false }, ...over };
}

const startArgs = (over: { role?: string; purpose?: string; brief?: string; source_ref?: string; input_digest?: string | null } = {}) => ({
  role: over.role ?? "diagnosis",
  task: {
    purpose: over.purpose ?? "diagnose",
    brief: over.brief ?? "파드가 재시작을 반복하는 원인을 찾는다",
    source_ref: over.source_ref ?? SRC_A,
    input_digest: over.input_digest === undefined ? D1 : over.input_digest,
  },
});

function refused(answer: ToolAnswer): { reason: string; field: string | null } {
  if (answer.outcome !== "refused") throw new Error(`거절이 아니다: ${JSON.stringify(answer)}`);
  return { reason: answer.reason, field: answer.field };
}

function startedRef(answer: ToolAnswer): string {
  if (answer.outcome !== "ok" || answer.tool !== "start_worker") throw new Error(`시작이 아니다: ${JSON.stringify(answer)}`);
  return answer.ref;
}

const RESULT = {
  role: "diagnosis" as const,
  outcome: "completed" as const,
  summary: "이미지 태그가 잘못돼 기동에 실패한다",
  items: [{ kind: "finding" as const, text: "이미지를 받지 못했다는 사건이 세 번 있다" }],
  refs: [{ kind: "path" as const, ref: "apps/sample/deployment.yaml", digest: null }],
};

describe("자기 요청만", () => {
  test("남의 실행 조회·취소 거절", () => {
    const w = world();
    const a = fakePorts(w);
    const ref = startedRef(handleToolCall("start_worker", startArgs(), ctx(), a.ports));
    w.results[ref] = { state: "settled", checksPassed: true, valid: true, cleanupPending: false, result: RESULT };

    // 주인은 볼 수 있다.
    expect(handleToolCall("worker_status", { ref }, ctx(), a.ports)).toEqual({ outcome: "ok", tool: "worker_status", ref, phase: "queued" });

    // 다른 논리 요청(B)은 남의 실행과 없는 실행을 구별할 수 없다.
    const b = fakePorts(w);
    for (const tool of ["worker_status", "worker_result", "cancel_worker"] as const) {
      const foreign = handleToolCall(tool, { ref }, ctx({ requestId: REQ_B }), b.ports);
      const missing = handleToolCall(tool, { ref: MISSING_REF }, ctx({ requestId: REQ_B }), b.ports);
      expect(foreign).toEqual({ outcome: "refused", tool, reason: "not_found", field: null });
      expect(foreign).toEqual(missing);
    }
    expect(b.writes).toEqual([]);
    expect(w.works[0]?.phase).toBe("queued");
  });

  test("재시도 키 조회가 남의 줄을 돌려주면 포트의 전제가 깨진 것이라 unknown이다", () => {
    // 재시도 키는 요청 ID를 담아 소유자에 묶이므로 포트는 그 소유자의 줄만 돌려줘야 한다. 어긴 줄에는 충돌도 성공도 답하지 않는다:
    // 충돌로 답하면 빈 키의 새 접수(ok)와 구별돼 그 키에 줄이 있다는 것이 드러난다.
    const foreign: WorkRecord = {
      ref: uuid("ffffffff"),
      owner: REQ_B,
      retryKey: `start_worker:${REQ_A}:diagnose`,
      content: { role: "diagnosis", purpose: "diagnose", sourceRef: SRC_A, inputDigest: D1 },
      phase: "running",
    };
    const w = world({ works: [foreign] });
    const p = fakePorts(w);
    const answer = handleToolCall("start_worker", startArgs(), ctx(), p.ports);
    expect(answer).toEqual({ outcome: "unknown", tool: "start_worker" });
    expect(JSON.stringify(answer)).not.toContain(foreign.ref);
    expect(p.writes).toEqual([]);
    expect(p.calls).toEqual(["liveSession", "inputPinned", "findByRetryKey"]);
    // 소유자 칸이 없거나 문자열이 아닌 줄도 대조할 수 없으니 unknown이다.
    const { owner: _owner, ...ownerless } = foreign;
    for (const bad of [ownerless, { ...foreign, owner: 7 }]) {
      const q = fakePorts(world());
      const ports: ToolPorts = { ...q.ports, ledger: { ...q.ports.ledger, findByRetryKey: () => ({ known: true, value: bad as unknown as WorkRecord }) } };
      expect(handleToolCall("start_worker", startArgs(), ctx(), ports), JSON.stringify(bad)).toEqual({ outcome: "unknown", tool: "start_worker" });
      expect(q.writes).toEqual([]);
    }

    // 읽기에서 비었다가 쓰기가 남의 줄을 돌려주는 경합도 같다.
    const raced = world();
    const q = fakePorts(raced);
    const ledger = q.ports.ledger;
    const racing: ToolPorts = {
      ...q.ports,
      ledger: { ...ledger, recordStart: () => ({ known: true, value: { ok: true, record: { ...foreign, owner: REQ_B } } }) },
    };
    const late = handleToolCall("start_worker", startArgs(), ctx(), racing);
    expect(late).toEqual({ outcome: "unknown", tool: "start_worker" });
  });

  test("읽기 포트가 식별 칸이 빠진 자기 줄을 주면 not_found가 아니라 unknown이다", () => {
    const w = world();
    const ref = startedRef(handleToolCall("start_worker", startArgs(), ctx(), fakePorts(w).ports));
    w.results[ref] = { state: "settled", checksPassed: true, valid: true, cleanupPending: false, result: RESULT };
    const own = w.works[0] as WorkRecord;
    const { owner: _owner, ...noOwner } = own;
    const { ref: _ref, ...noRef } = own;
    for (const bad of [noOwner, noRef]) {
      for (const tool of ["worker_status", "worker_result", "cancel_worker"] as const) {
        const p = fakePorts(w);
        const ports: ToolPorts = { ...p.ports, ledger: { ...p.ports.ledger, readOwnedWork: () => ({ known: true, value: bad as unknown as WorkRecord }) } };
        expect(handleToolCall(tool, { ref }, ctx(), ports), `${tool} ${Object.keys(bad).join(",")}`).toEqual({ outcome: "unknown", tool });
        expect(p.writes).toEqual([]);
      }
    }
  });
});

describe("같은 호출은 같은 실행", () => {
  test("같은 호출은 같은 실행", () => {
    const w = world();
    const p = fakePorts(w);
    const first = startedRef(handleToolCall("start_worker", startArgs(), ctx(), p.ports));
    // 같은 세션의 재시도(다른 호출 ID)
    const again = handleToolCall("start_worker", startArgs(), ctx(), p.ports);
    expect(again).toEqual({ outcome: "ok", tool: "start_worker", ref: first, phase: "queued" });
    // 세션이 교체된 뒤 같은 논리 요청의 같은 목적. 자유 글이 달라도 같은 실행이다.
    w.liveSession = { id: "session-2", generation: 2 };
    const replaced = handleToolCall("start_worker", startArgs({ brief: "인계 문서를 보고 다시 부탁한다" }), ctx({ session: { id: "session-2", generation: 2 } }), p.ports);
    expect(replaced).toEqual({ outcome: "ok", tool: "start_worker", ref: first, phase: "queued" });
    expect(w.works).toHaveLength(1);
    // 기존 줄을 찾으면 쓰기를 부르지 않는다.
    expect(p.writes).toEqual(["recordStart"]);

    const s2 = { session: { id: "session-2", generation: 2 } };
    // 같은 재시도 키(같은 요청·같은 목적)에 내용이 다르면 충돌이다.
    expect(refused(handleToolCall("start_worker", startArgs({ input_digest: D2 }), ctx(s2), p.ports)).reason).toBe("retry_conflict");
    w.policy.isolated_reader = ["diagnose"];
    w.pinned.push({ owner: REQ_A, sourceRef: SRC_A, inputDigest: D1 });
    expect(refused(handleToolCall("start_worker", startArgs({ role: "isolated_reader" }), ctx(s2), p.ports)).reason).toBe("retry_conflict");
    expect(w.works).toHaveLength(1);

    // 다른 목적은 다른 실행이다.
    w.policy.diagnosis = ["diagnose", "rebut"];
    const other = startedRef(handleToolCall("start_worker", startArgs({ purpose: "rebut" }), ctx(s2), p.ports));
    expect(other).not.toBe(first);
  });

  test("쓰기가 돌려준 줄의 내용이 다르면 충돌이다", () => {
    const w = world();
    const p = fakePorts(w);
    const ports: ToolPorts = {
      ...p.ports,
      ledger: {
        ...p.ports.ledger,
        recordStart: (input) => ({
          known: true,
          value: { ok: true, record: { ref: uuid("cccccccc"), owner: input.owner, retryKey: input.retryKey, content: { ...input.content, inputDigest: D2 }, phase: "queued" } },
        }),
      },
    };
    expect(refused(handleToolCall("start_worker", startArgs(), ctx(), ports)).reason).toBe("retry_conflict");
  });
});

describe("권한을 주장하는 칸은 받지 않는다", () => {
  const CLAIMS = [
    "shell",
    "command",
    "cmd",
    "argv",
    "env",
    "executable",
    "binary",
    "path",
    "cwd",
    "url",
    "image",
    "podspec",
    "model",
    "model_name",
    "account",
    "accountName",
    "credential",
    "pid",
    "screen",
    "approval",
    "approved",
    "destination",
    "session",
    "session_id",
    "sessionGeneration",
    "owner",
    "request_id",
    "call_id",
    "executor_id",
    "priority",
    "budget_tokens",
    "deadline",
  ];

  test("임의 셸·계정·승인 칸 거절", () => {
    for (const name of CLAIMS) {
      for (const where of ["top", "task"] as const) {
        const args: Record<string, unknown> = startArgs();
        if (where === "top") args[name] = "x";
        else args.task = { ...(args.task as object), [name]: "x" };
        const p = fakePorts(world());
        const answer = handleToolCall("start_worker", args, ctx(), p.ports);
        expect(answer, `${where}.${name}`).toEqual({ outcome: "refused", tool: "start_worker", reason: "forbidden_field", field: where === "top" ? name : `task.${name}` });
        expect(p.calls, name).toEqual([]);
      }
      for (const tool of ["worker_status", "worker_result", "cancel_worker"] as const) {
        const p = fakePorts(world());
        expect(refused(handleToolCall(tool, { ref: MISSING_REF, [name]: 1 }, ctx(), p.ports)), `${tool}.${name}`).toEqual({ reason: "forbidden_field", field: name });
        expect(p.calls).toEqual([]);
      }
    }
    // 깊이 숨겨도 찾는다.
    const deep = { ...startArgs(), task: { ...startArgs().task, brief: "x" }, extra: [{ nested: { shell: "rm" } }] };
    expect(refused(handleToolCall("start_worker", deep, ctx(), fakePorts(world()).ports))).toEqual({ reason: "forbidden_field", field: "extra[0].nested.shell" });
  });

  test("모르는 칸과 틀린 꼴, 허용되지 않은 역할·목적, 고정되지 않은 입력은 사유와 함께 거절한다", () => {
    const cases: [string, unknown, string, string | null][] = [
      ["start_worker", { ...startArgs(), note: "x" }, "unknown_field", "note"],
      ["start_worker", { ...startArgs(), task: { ...startArgs().task, extra: 1 } }, "unknown_field", "task.extra"],
      ["worker_status", { ref: MISSING_REF, verbose: true }, "unknown_field", "verbose"],
      ["start_worker", { role: "diagnosis" }, "malformed_argument", "task"],
      ["start_worker", null, "malformed_argument", null],
      ["start_worker", [startArgs()], "malformed_argument", null],
      ["worker_status", { ref: "../etc" }, "malformed_argument", "ref"],
      ["worker_status", {}, "malformed_argument", "ref"],
      ["start_worker", startArgs({ brief: "" }), "malformed_argument", "task.brief"],
      ["start_worker", startArgs({ brief: "가".repeat(BRIEF_MAX + 1) }), "malformed_argument", "task.brief"],
      ["start_worker", startArgs({ brief: "줄\u0000바꿈" }), "malformed_argument", "task.brief"],
      ["start_worker", startArgs({ source_ref: "/etc/passwd" }), "malformed_argument", "task.source_ref"],
      ["start_worker", startArgs({ source_ref: "https://example.com/x" }), "malformed_argument", "task.source_ref"],
      ["start_worker", startArgs({ purpose: "Run This" }), "malformed_argument", "task.purpose"],
      ["start_worker", startArgs({ role: "root" }), "role_not_allowed", "role"],
      ["start_worker", startArgs({ role: "code_author" }), "role_not_allowed", "role"],
      ["start_worker", startArgs({ purpose: "patch_self" }), "purpose_not_allowed", "task.purpose"],
      ["start_worker", startArgs({ input_digest: null }), "input_not_fixed", "task.input_digest"],
      ["start_worker", startArgs({ input_digest: "latest" }), "input_not_fixed", "task.input_digest"],
      // 꼴은 맞지만 이 요청에 고정된 입력이 아니다(다른 요청의 원본).
      ["start_worker", startArgs({ source_ref: SRC_B }), "input_not_fixed", "task.input_digest"],
      ["delete_everything", {}, "unknown_tool", null],
    ];
    for (const [tool, args, reason, field] of cases) {
      const p = fakePorts(world());
      expect(handleToolCall(tool, args, ctx(), p.ports), `${tool} ${JSON.stringify(args)?.slice(0, 80)}`).toEqual({ outcome: "refused", tool, reason: reason as never, field });
      expect(p.writes).toEqual([]);
    }
    // input_digest 칸이 아예 없으면 고정되지 않은 입력이다.
    const { input_digest: _drop, ...noDigest } = startArgs().task;
    expect(refused(handleToolCall("start_worker", { role: "diagnosis", task: noDigest }, ctx(), fakePorts(world()).ports))).toEqual({ reason: "input_not_fixed", field: "task.input_digest" });
    // 프로토타입이 있는 객체(클래스 인스턴스)나 상속된 칸으로 끼워 넣지 못한다.
    const sneaky = Object.create({ shell: "rm" });
    Object.assign(sneaky, startArgs());
    expect(refused(handleToolCall("start_worker", sneaky, ctx(), fakePorts(world()).ports)).reason).toBe("malformed_argument");
  });
});

describe("정지 또는 폐기된 세션", () => {
  test("정지 또는 폐기된 세션은 새 호출 0", () => {
    const base = world();
    const owner = fakePorts(base);
    const ref = startedRef(handleToolCall("start_worker", startArgs(), ctx(), owner.ports));
    base.results[ref] = { state: "settled", checksPassed: true, valid: true, cleanupPending: false, result: RESULT };

    const cases: { name: string; ctx: Partial<ToolCallContext>; live?: World["liveSession"]; reason: string }[] = [
      { name: "정지", ctx: { stop: { known: true, stopped: true } }, reason: "stopped" },
      { name: "정지 모름", ctx: { stop: { known: false } }, reason: "stop_unknown" },
      { name: "옛 세대", ctx: { session: { id: "session-1", generation: 1 } }, live: { id: "session-1", generation: 2 }, reason: "session_retired" },
      { name: "교체된 세션", ctx: { session: { id: "session-1", generation: 1 } }, live: { id: "session-2", generation: 1 }, reason: "session_retired" },
      { name: "살아 있는 세션 없음", ctx: {}, live: null, reason: "session_retired" },
    ];
    for (const c of cases) {
      const w = { ...base, works: [...base.works], liveSession: c.live === undefined ? base.liveSession : c.live };
      const p = fakePorts(w);
      const calls = [
        ["start_worker", startArgs({ purpose: "diagnose", input_digest: D2 })],
        ["worker_status", { ref }],
        ["worker_result", { ref }],
        ["cancel_worker", { ref }],
      ] as const;
      for (const [tool, args] of calls) {
        expect(handleToolCall(tool, args, ctx(c.ctx), p.ports), `${c.name} ${tool}`).toEqual({ outcome: "refused", tool, reason: c.reason as never, field: null });
      }
      expect(p.writes, c.name).toEqual([]);
      // 정지는 문맥만으로 거절하므로 포트를 하나도 부르지 않는다. 폐기는 살아 있는 세션 읽기 하나만 부른다.
      expect(p.calls.every((name) => name === "liveSession"), c.name).toBe(true);
      if (c.reason === "stopped" || c.reason === "stop_unknown") expect(p.calls, c.name).toEqual([]);
      expect(w.works).toHaveLength(1);
      expect(w.works[0]?.phase).toBe("queued");
    }
  });
});

describe("모름은 빈 성공이 아니다", () => {
  test("포트가 모르거나 실패하면 unknown", () => {
    const seed = () => {
      const w = world();
      const ref = startedRef(handleToolCall("start_worker", startArgs(), ctx(), fakePorts(w).ports));
      w.results[ref] = { state: "settled", checksPassed: true, valid: true, cleanupPending: false, result: RESULT };
      return { w, ref };
    };
    const plans: [string, string, (ref: string) => unknown][] = [
      ["liveSession", "worker_status", (ref) => ({ ref })],
      ["inputPinned", "start_worker", () => startArgs({ input_digest: D2, purpose: "diagnose" })],
      ["findByRetryKey", "start_worker", () => startArgs()],
      ["readOwnedWork", "worker_status", (ref) => ({ ref })],
      ["readOwnedWork", "cancel_worker", (ref) => ({ ref })],
      ["readResult", "worker_result", (ref) => ({ ref })],
      ["requestCancel", "cancel_worker", (ref) => ({ ref })],
    ];
    for (const [port, tool, args] of plans) {
      for (const mode of ["unknownOn", "throwOn"] as const) {
        const { w, ref } = seed();
        const p = fakePorts(w, { [mode]: port });
        expect(handleToolCall(tool, args(ref), ctx(), p.ports), `${port} ${mode} ${tool}`).toEqual({ outcome: "unknown", tool });
      }
    }
    // 정책 포트가 던져도 unknown이다.
    const p = fakePorts(world());
    const throwing: ToolPorts = { ...p.ports, policy: { judge: () => { throw new Error("정책 실패"); } } };
    expect(handleToolCall("start_worker", startArgs(), ctx(), throwing)).toEqual({ outcome: "unknown", tool: "start_worker" });
    expect(p.writes).toEqual([]);
    // 새 접수의 쓰기가 모름이면 unknown이다(참조를 지어내지 않는다).
    for (const mode of ["unknownOn", "throwOn"] as const) {
      const p = fakePorts(world(), { [mode]: "recordStart" });
      expect(handleToolCall("start_worker", startArgs(), ctx(), p.ports)).toEqual({ outcome: "unknown", tool: "start_worker" });
    }
  });

  test("포트의 꼴이 틀려도 unknown이고 내부 칸은 따라 나가지 않는다", () => {
    const w = world();
    const ref = startedRef(handleToolCall("start_worker", startArgs(), ctx(), fakePorts(w).ports));
    const p = fakePorts(w);
    // 모르는 단계 이름
    w.works[0] = { ...(w.works[0] as WorkRecord), phase: "exploded" as Phase };
    expect(handleToolCall("worker_status", { ref }, ctx(), p.ports)).toEqual({ outcome: "unknown", tool: "worker_status" });
    w.works[0] = { ...(w.works[0] as WorkRecord), phase: "ready_result" };
    // 확인 칸이 boolean이 아니면 확인된 것이 아니다.
    w.results[ref] = { state: "settled", checksPassed: "yes" as unknown as boolean, valid: true, cleanupPending: false, result: RESULT };
    expect(handleToolCall("worker_result", { ref }, ctx(), p.ports)).toEqual({ outcome: "unknown", tool: "worker_result" });
    // 확인은 모두 통과인데 결과가 없다.
    w.results[ref] = { state: "settled", checksPassed: true, valid: true, cleanupPending: false, result: null };
    expect(handleToolCall("worker_result", { ref }, ctx(), p.ports)).toEqual({ outcome: "unknown", tool: "worker_result" });
    // 계약 v1 결과 꼴이 아닌 결과는 검사가 덜 된 것이다. 어느 깊이에 칸이 더 붙었거나 빠졌어도 결과 전체를 unknown으로 닫는다.
    const item = RESULT.items[0] as (typeof RESULT.items)[number];
    const source = RESULT.refs[0] as (typeof RESULT.refs)[number];
    const broken: [string, unknown][] = [
      ["빈 객체", {}],
      ["최상위 추가 칸", { ...RESULT, executorId: "worker-executor/diagnosis/x", account: "acct", pid: 42 }],
      ["항목의 PID", { ...RESULT, items: [{ ...item, pid: 42 }] }],
      ["참조의 계정", { ...RESULT, refs: [{ ...source, account: "demo" }] }],
      ["항목·참조의 실행기 ID·경로", { ...RESULT, items: [{ ...item, executorId: "example" }], refs: [{ ...source, path: "/example" }] }],
      ["역할 없음", { outcome: RESULT.outcome, summary: RESULT.summary, items: RESULT.items, refs: RESULT.refs }],
      ["요약 없음", { ...RESULT, summary: undefined }],
      ["빈 요약", { ...RESULT, summary: " " }],
      ["모르는 결과 상태", { ...RESULT, outcome: "done" }],
      ["항목이 배열이 아님", { ...RESULT, items: {} }],
      ["항목 원소가 글", { ...RESULT, items: ["x"] }],
      ["모르는 항목 종류", { ...RESULT, items: [{ kind: "log", text: "x" }] }],
      ["항목 수 초과", { ...RESULT, items: Array.from({ length: 21 }, () => item) }],
      ["참조 digest 꼴", { ...RESULT, refs: [{ ...source, digest: "latest" }] }],
      ["산출물 참조에 digest 없음", { ...RESULT, refs: [{ kind: "artifact", ref: "a/b", digest: null }] }],
      ["참조에 공백", { ...RESULT, refs: [{ ...source, ref: "a b" }] }],
    ];
    for (const [name, result] of broken) {
      w.results[ref] = { state: "settled", checksPassed: true, valid: true, cleanupPending: false, result: result as never };
      const answer = handleToolCall("worker_result", { ref }, ctx(), p.ports);
      expect(JSON.stringify(answer), name).toBe(JSON.stringify({ outcome: "unknown", tool: "worker_result" }));
    }
    // 꼴이 맞으면 공개 칸만 새로 만들어 준다.
    w.results[ref] = { state: "settled", checksPassed: true, valid: true, cleanupPending: false, result: RESULT };
    const ok = handleToolCall("worker_result", { ref }, ctx(), p.ports);
    expect(JSON.stringify(ok)).toBe(JSON.stringify({ outcome: "ok", tool: "worker_result", ref, result: { outcome: RESULT.outcome, summary: RESULT.summary, items: RESULT.items, refs: RESULT.refs } }));
    if (ok.outcome !== "ok" || ok.tool !== "worker_result") throw new Error(JSON.stringify(ok));
    expect(ok.result.items[0]).not.toBe(item);
    expect(ok.result.refs[0]).not.toBe(source);
  });

  test("정책 포트가 정한 세 답 밖의 값을 내면 목적 불허가 아니라 unknown이다", () => {
    for (const verdict of [{ known: false }, "maybe", undefined, null]) {
      const p = fakePorts(world());
      const ports: ToolPorts = { ...p.ports, policy: { judge: () => verdict as never } };
      expect(handleToolCall("start_worker", startArgs(), ctx(), ports), String(JSON.stringify(verdict))).toEqual({ outcome: "unknown", tool: "start_worker" });
      expect(p.calls).toEqual(["liveSession"]);
    }
    const p = fakePorts(world());
    const ports: ToolPorts = { ...p.ports, policy: { judge: () => "purpose_not_allowed" } };
    expect(refused(handleToolCall("start_worker", startArgs(), ctx(), ports))).toEqual({ reason: "purpose_not_allowed", field: "task.purpose" });
  });

  test("결과는 검사 통과·유효·정리 대기 아님이 모두 확인될 때만 준다", () => {
    const w = world();
    const p = fakePorts(w);
    const ref = startedRef(handleToolCall("start_worker", startArgs(), ctx(), p.ports));
    expect(refused(handleToolCall("worker_result", { ref }, ctx(), p.ports)).reason).toBe("result_not_ready");
    const settled = (over: Partial<Extract<ResultView, { state: "settled" }>>): ResultView => ({ state: "settled", checksPassed: true, valid: true, cleanupPending: false, result: RESULT, ...over });
    w.results[ref] = settled({ checksPassed: false });
    expect(refused(handleToolCall("worker_result", { ref }, ctx(), p.ports)).reason).toBe("result_check_failed");
    w.results[ref] = settled({ valid: false });
    expect(refused(handleToolCall("worker_result", { ref }, ctx(), p.ports)).reason).toBe("result_expired");
    w.results[ref] = settled({ cleanupPending: true });
    expect(refused(handleToolCall("worker_result", { ref }, ctx(), p.ports)).reason).toBe("result_cleanup_pending");
  });

  test("배정할 수 없는 요청은 배정 전 대기로 답하고 실행기 ID를 만들지 않는다", () => {
    const w = world({ startPhase: "waiting_assignment" });
    const p = fakePorts(w);
    const answer = handleToolCall("start_worker", startArgs({ role: "pr_review", purpose: "review_pr" }), ctx(), p.ports);
    if (answer.outcome !== "ok" || answer.tool !== "start_worker") throw new Error(JSON.stringify(answer));
    expect(Object.keys(answer).sort()).toEqual(["outcome", "phase", "ref", "tool"]);
    expect(answer.phase).toBe("waiting_assignment");
    // 대기 중 취소는 시작하지 않음으로 끝난다. 접수는 완료가 아니라는 표시를 함께 준다.
    expect(handleToolCall("cancel_worker", { ref: answer.ref }, ctx(), p.ports)).toEqual({ outcome: "ok", tool: "cancel_worker", ref: answer.ref, cancel: "accepted", phase: "not_started" });
    expect(refused(handleToolCall("cancel_worker", { ref: answer.ref }, ctx(), p.ports)).reason).toBe("already_ended");
  });

  test("문맥이나 설정이 꼴에 맞지 않으면 아무것도 하지 않는다", () => {
    const bad: Partial<ToolCallContext>[] = [
      { requestId: "not-a-uuid" },
      { callId: "" },
      { now: Number.NaN },
      { session: { id: "", generation: 1 } },
      { session: { id: "session-1", generation: -1 } },
      { stop: { known: true, stopped: "no" as unknown as boolean } },
    ];
    for (const over of bad) {
      const p = fakePorts(world());
      expect(refused(handleToolCall("start_worker", startArgs(), ctx(over), p.ports)).reason, JSON.stringify(over)).toBe("context_invalid");
      expect(p.calls).toEqual([]);
    }
    const p = fakePorts(world());
    const ports = { ...p.ports, config: { purposeBriefMaxChars: 0 } };
    expect(refused(handleToolCall("start_worker", startArgs(), ctx(), ports)).reason).toBe("context_invalid");
  });
});

// ---- O10에 넘길 호출 표본 ----

interface Fixture {
  status: string;
  tool: string;
  case: string;
  context: ToolCallContext;
  world: World;
  arguments: unknown;
  expect: { answer: ToolAnswer; writes: number };
}

const FIXTURE_DIR = "test/supervisor/scheduler/fixtures/tools";
const fixtureFiles = await list(`${FIXTURE_DIR}/*.json`);

describe("호출 표본", () => {
  test("표본마다 후보 표시가 있고 처리기의 답이 기대와 같다", async () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
    for (const file of fixtureFiles) {
      const fixture = JSON.parse(await readText(file)) as Fixture;
      expect(fixture.status, file).toBe("candidate");
      expect(file).toBe(`${FIXTURE_DIR}/${fixture.tool}.${fixture.case}.json`);
      const p = fakePorts(structuredClone(fixture.world));
      const answer = handleToolCall(fixture.tool, fixture.arguments, fixture.context, p.ports);
      expect(answer, file).toEqual(fixture.expect.answer);
      // 본체가 받는 것은 직렬화된 JSON이다. undefined 칸이 빠진 뒤의 모양까지 같아야 한다.
      expect(JSON.parse(JSON.stringify(answer)), file).toEqual(fixture.expect.answer);
      expect(p.writes.length, file).toBe(fixture.expect.writes);
    }
  });

  test("도구마다 통과 하나 이상과 거절 하나 이상이 있다", async () => {
    const seen = new Map<string, Set<string>>();
    for (const file of fixtureFiles) {
      const fixture = JSON.parse(await readText(file)) as Fixture;
      const outcomes = seen.get(fixture.tool) ?? new Set<string>();
      outcomes.add(fixture.expect.answer.outcome);
      seen.set(fixture.tool, outcomes);
    }
    for (const tool of TOOL_NAMES) {
      expect(seen.get(tool)?.has("ok"), tool).toBe(true);
      expect(seen.get(tool)?.has("refused"), tool).toBe(true);
    }
  });
});

describe("정적", () => {
  test("꼴 검사는 계약·장부의 같은 이름 꼴과 같다", () => {
    expect(PATTERNS.uuid.source).toBe(CONTRACT_UUID.source);
    expect(PATTERNS.uuid.source).toBe(LEDGER_UUID.source);
    expect(PATTERNS.sha256.source).toBe(CONTRACT_SHA256.source);
    expect(PATTERNS.sha256.source).toBe(LEDGER_SHA256.source);
    expect(PATTERNS.sourceRef.source).toBe(LEDGER_SOURCE_REF.source);
    // 이 시험이 정책 표에 쓴 역할은 계약의 역할이다.
    for (const role of ["diagnosis", "isolated_reader", "pr_review"]) expect(ROLES as readonly string[]).toContain(role);
    expect(new Set(TOOL_REFUSALS).size).toBe(TOOL_REFUSALS.length);
  });

  test("tools.ts는 상태·시계·난수·환경·입출력을 두지 않는다", async () => {
    const source = await readText("src/supervisor/scheduler/tools.ts");
    const code = source.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/^(let|var)\s/m);
    expect(code).not.toMatch(/Date\.now|new Date|Math\.random|randomUUID|performance\.now|process\.|setTimeout|setInterval|Bun\.|node:/);
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../../contract/v1/index.ts", "../../ledger/index.ts"]);
  });
});
