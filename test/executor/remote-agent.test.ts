// 원격 구현(RemoteAgent)이 링크의 이상을 모두 모름으로 다루는지: 시험이 대리 자리에서 링크의 말을 직접 정해 작업자(worker) 전체를 지나게 한다.
// 어느 사례든 receipt_stopped가 나가지 않고 실행은 슬롯을 쥔 unknown_running이어야 한다. 마지막의 정상 길은 대조군이다.
import { afterEach, expect, test } from "bun:test";
import { type AgentMessage, ControlDecoder, encodeAgent, type ReceivedControl } from "../../src/agent/link.ts";
import { limits } from "../../src/contract/v1/index.ts";
import type { AgentLinkSession, DistrustReason, RemoteAgent } from "../../src/executor/remote-agent.ts";
import { encodeFrame } from "../../src/transport/framing.ts";
import { fromSupervisor, pause, type Rig, rig, start, until } from "./support.ts";

// 대리 자리. 받은 지시를 디코딩해 쌓고, 시험이 정한 말만 한다.
class ManualAgent {
  session: AgentLinkSession | null = null;
  closed = false;
  readonly got: ReceivedControl[] = [];
  readonly credentials: string[] = [];
  private readonly decoder = new ControlDecoder();
  // terminate·count에 같은 호출 안에서 답한다. undefined면 그 종류에 답하지 않는다.
  answers: { terminate?: boolean; count?: number | null } = {};

  attach(remote: RemoteAgent): AgentLinkSession | null {
    this.session = remote.connect({
      write: (bytes) => {
        if (this.closed) throw new Error("closed");
        for (const message of this.decoder.push(new Uint8Array(bytes))) this.handle(message);
      },
      close: () => {
        this.closed = true;
      },
    });
    if (this.session !== null) this.say({ type: "hello" });
    return this.session;
  }

  private handle(message: ReceivedControl): void {
    if (message.type === "start") {
      const value = message.credential.take()!;
      this.credentials.push(new TextDecoder().decode(value));
      value.fill(0);
    }
    this.got.push(message);
    if (message.type === "terminate" && this.answers.terminate) this.say({ type: "terminated", seq: message.seq });
    if (message.type === "count" && this.answers.count !== undefined) this.say({ type: "counted", seq: message.seq, survivors: this.answers.count });
  }

  say(message: AgentMessage): void {
    this.session?.receive(encodeAgent(message));
  }

  types(): string[] {
    return this.got.map((message) => message.type);
  }

  last<T extends ReceivedControl["type"]>(type: T): Extract<ReceivedControl, { type: T }> {
    return this.got.filter((message) => message.type === type).at(-1) as Extract<ReceivedControl, { type: T }>;
  }
}

const rigs: Rig[] = [];
afterEach(() => {
  rigs.length = 0;
});

async function make(agent: ManualAgent, options: { dir?: string; clock?: Rig["clock"]; inheritedUnverified?: boolean } = {}) {
  const r = await rig({
    exitWaitMs: 100,
    dir: options.dir,
    clock: options.clock,
    remote: { attach: (remote) => void agent.attach(remote), inheritedUnverified: options.inheritedUnverified },
  });
  rigs.push(r);
  return r;
}

const stateOf = (r: Rig, runId: string) => r.store.run(runId)?.state;
const cancel = (r: Rig, runId: string) =>
  fromSupervisor(r.clock, r.worker.name, "task_cancel", { run_id: runId, reason: "requested" }, { stop_generation: 0, run_generation: 1 });
const result = new TextEncoder().encode(JSON.stringify({ role: "diagnosis", outcome: "completed", summary: "끝", items: [], refs: [] }));

// 시작을 받은 실행을 띄운 것으로 만들고 프로그램이 0으로 끝났다고 알린다.
async function launchedAndExited(r: Rig, agent: ManualAgent) {
  const { runId, value } = await start(r);
  await until(() => agent.types().includes("start"));
  agent.say({ type: "spawned", run_id: runId });
  agent.say({ type: "output", run_id: runId, data: Buffer.from(result).toString("base64") });
  agent.say({ type: "exited", run_id: runId, code: 0, signal: null, overflow: false, stdout_bytes: result.length });
  return { runId, value };
}

function expectUnknown(r: Rig, runId: string) {
  expect(stateOf(r, runId)).toBe("unknown_running");
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
}

test("원격 대조군: hello → 시작 → 끝 → 끝내기 → 계수 0이면 confirmStopped가 0을 보고 종료 확인을 낸다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true, count: 0 };
  const r = await make(agent);
  const { runId } = await launchedAndExited(r, agent);
  await r.worker.idle();
  expect(stateOf(r, runId)).toBe("ready_result");
  expect(r.transport.of("receipt_stopped")[0]!.body).toMatchObject({ remaining_processes: 0, exit: "completed" });
  expect(agent.types()).toEqual(["start", "terminate", "count"]);
});

test("원격 띄우기 보류: 시작 응답 전에는 계수를 묻지 않고, 보류 중 멈춘 실행은 모름이다(그 뒤 같은 실행이 실제로 떠도)", async () => {
  const agent = new ManualAgent();
  // 대리는 무엇을 물어도 0이라고 답한다(빈 공간을 사전 계수하는 중의 0).
  agent.answers = { terminate: true, count: 0 };
  const r = await make(agent);
  const { runId } = await start(r);
  await until(() => agent.types().includes("start"));
  expect(r.remote!.state().phase).toBe("starting");
  await r.connection.receive(cancel(r, runId));
  await r.worker.idle();
  expectUnknown(r, runId);
  expect(agent.types()).not.toContain("count");
  // 보류가 풀려 같은 실행이 뜬다. 그 실행은 여전히 끝을 맺지 않는다.
  agent.say({ type: "spawned", run_id: runId });
  expect(r.remote!.state()).toMatchObject({ phase: "running", distrusted: null });
  expectUnknown(r, runId);
});

test("원격 대리 죽음: 실행 중 링크가 끊기면 모름이고, 그 뒤 새 hello로 붙은 대리의 0으로도 닫지 않는다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true, count: 0 };
  const r = await make(agent);
  const { runId } = await start(r);
  await until(() => agent.types().includes("start"));
  agent.say({ type: "spawned", run_id: runId });
  await until(() => stateOf(r, runId) === "running");
  agent.session!.closed();
  await r.worker.idle();
  expectUnknown(r, runId);
  const fresh = new ManualAgent();
  fresh.answers = { terminate: true, count: 0 };
  const session = fresh.attach(r.remote!);
  await r.connection.receive(cancel(r, runId));
  await r.worker.idle();
  expectUnknown(r, runId);
  expect(session).toBeNull();
  expect(fresh.closed).toBe(true);
  expect(fresh.types()).toEqual([]);
  expect(r.remote!.state().distrusted).toBe("link_lost_mid_run");
});

test("원격 늦은 답: 상한 안에 계수가 없으면 모름이고, terminated만으로는 0이 아니며, 늦게 온 0도 그 판단을 바꾸지 않는다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true };
  const r = await make(agent);
  const { runId } = await launchedAndExited(r, agent);
  await r.worker.idle();
  expect(agent.types()).toEqual(["start", "terminate", "count"]);
  expectUnknown(r, runId);
  agent.say({ type: "counted", seq: agent.last("count").seq, survivors: 0 });
  await pause(50);
  expectUnknown(r, runId);
});

test("원격 두 번째 연결: 마지막 계수를 기다리는 사이 두 번째 연결이 오면 두 연결을 닫고 모름이며, 첫 대리의 늦은 0도 쓰지 않는다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true };
  const r = await make(agent);
  const { runId } = await launchedAndExited(r, agent);
  await until(() => agent.types().includes("count"));
  const intruder = new ManualAgent();
  expect(intruder.attach(r.remote!)).toBeNull();
  expect(intruder.closed).toBe(true);
  expect(agent.closed).toBe(true);
  agent.say({ type: "counted", seq: agent.last("count").seq, survivors: 0 });
  await r.worker.idle();
  expectUnknown(r, runId);
  expect(r.remote!.state().distrusted).toBe("second_connection");
});

test("원격 두 번째 연결: 쉬는 동안 온 두 번째 연결 뒤에는 새 시작을 띄우지 않는다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true, count: 0 };
  const r = await make(agent);
  expect(new ManualAgent().attach(r.remote!)).toBeNull();
  const { runId } = await start(r);
  await r.worker.idle();
  expect(agent.types()).toEqual([]);
  expectUnknown(r, runId);
});

for (const survivors of [2, null]) {
  test(`원격 0 아닌 수: 마지막 계수가 ${survivors}이면 모름이다`, async () => {
    const agent = new ManualAgent();
    agent.answers = { terminate: true, count: survivors };
    const r = await make(agent);
    const { runId } = await launchedAndExited(r, agent);
    await r.worker.idle();
    expectUnknown(r, runId);
    expect(r.remote!.state()).toMatchObject({ phase: "ended", distrusted: null });
  });
}

const OTHER_RUN = "00000000-0000-4000-8000-000000000000";
const anomalies: [string, (agent: ManualAgent, runId: string) => void, DistrustReason][] = [
  ["다른 실행의 exited", (agent) => agent.say({ type: "exited", run_id: OTHER_RUN, code: 0, signal: null, overflow: false, stdout_bytes: 0 }), "link_rejected"],
  ["보낸 적 없는 seq의 counted 0", (agent) => agent.say({ type: "counted", seq: 99, survivors: 0 }), "unknown_reply"],
  ["두 번째 hello", (agent) => agent.say({ type: "hello" }), "link_rejected"],
  ["모르는 메시지", (agent) => agent.session!.receive((encodeFrame(new TextEncoder().encode(JSON.stringify({ v: 1, type: "done" }))) as { frame: Uint8Array }).frame), "link_rejected"],
  ["상한을 넘는 틀 머리", (agent) => agent.session!.receive(new Uint8Array([0x00, 0x10, 0x00, 0x01])), "link_rejected"],
];
for (const [name, inject, reason] of anomalies) {
  test(`원격 순서 틀림·모르는 말: 실행 중 ${name}이면 잠그고 모름이다`, async () => {
    const agent = new ManualAgent();
    agent.answers = { terminate: true, count: 0 };
    const r = await make(agent);
    const { runId } = await start(r);
    await until(() => agent.types().includes("start"));
    agent.say({ type: "spawned", run_id: runId });
    inject(agent, runId);
    await r.worker.idle();
    expectUnknown(r, runId);
    expect(r.remote!.state().distrusted).toBe(reason);
    expect(agent.closed).toBe(true);
  });
}

test("원격 출력 상한: 시작에 실은 output_bytes를 넘는 stdout은 받지 않고 잠근다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true, count: 0 };
  const r = await make(agent);
  const { runId } = await start(r);
  await until(() => agent.types().includes("start"));
  const limit = agent.last("start").output_bytes;
  agent.say({ type: "spawned", run_id: runId });
  const chunk = Buffer.alloc(32 * 1024, 0x61).toString("base64");
  for (let sent = 0; sent <= limit; sent += 32 * 1024) agent.say({ type: "output", run_id: runId, data: chunk });
  await r.worker.idle();
  expectUnknown(r, runId);
  expect(r.remote!.state().distrusted).toBe("output_over_limit");
});

test("원격 끝의 시각: 제어는 exited를 받은 때 끝을 안다. 그 사이 임대가 지났으면 0으로 끝나도 completed가 아니다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true, count: 0 };
  const r = await make(agent);
  const { runId } = await start(r);
  await until(() => agent.types().includes("start"));
  agent.say({ type: "spawned", run_id: runId });
  await until(() => stateOf(r, runId) === "running");
  r.clock.advance(limits.RUN_LEASE_MAX_MS + 1_000);
  agent.say({ type: "exited", run_id: runId, code: 0, signal: null, overflow: false, stdout_bytes: 0 });
  await r.worker.idle();
  expect(r.transport.of("receipt_stopped")[0]!.body).toMatchObject({ remaining_processes: 0, exit: "failed" });
  expect(r.transport.of("report_result")).toHaveLength(0);
});

test("원격 기동: 확인 없이 물려받은 끝나지 않은 실행은 지금 붙은 대리의 0으로 닫지 않는다", async () => {
  const seedAgent = new ManualAgent();
  const seed = await make(seedAgent);
  const { runId } = await start(seed);
  await until(() => seedAgent.types().includes("start"));
  seedAgent.say({ type: "spawned", run_id: runId });
  await until(() => stateOf(seed, runId) === "running");
  const fresh = new ManualAgent();
  fresh.answers = { terminate: true, count: 0 };
  const again = await make(fresh, { dir: seed.dir, clock: seed.clock, inheritedUnverified: true });
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("unknown_running");
  expect(again.transport.of("receipt_stopped")).toHaveLength(0);
  expect(fresh.closed).toBe(true);
  expect(fresh.types()).toEqual([]);
});

test("원격 자격: 값은 start 뒤의 값 틀로만 가고 JSON의 env·관측·오류에 없다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true, count: 0 };
  const r = await make(agent);
  const { value } = await launchedAndExited(r, agent);
  await r.worker.idle();
  const marker = new TextDecoder().decode(value);
  const startMessage = agent.last("start");
  expect(agent.credentials).toEqual([marker]);
  expect(startMessage.credential_env).toBe("OLIVE_CREDENTIAL");
  expect(Object.keys(startMessage.env)).not.toContain("OLIVE_CREDENTIAL");
  expect(JSON.stringify(startMessage)).not.toContain(marker);
  expect(JSON.stringify(r.remote!.state())).not.toContain(marker);
});

test("원격 임대: 실행 중 저장소의 임대가 늘면 renew로 보내고, 끝을 들은 뒤(계수 단계)에는 보내지 않는다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true };
  const r = await make(agent);
  const { runId } = await start(r);
  await until(() => agent.types().includes("start"));
  agent.say({ type: "spawned", run_id: runId });
  await until(() => stateOf(r, runId) === "running");
  r.clock.advance(1_000);
  const lease = r.clock.now() + limits.RUN_LEASE_MAX_MS;
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "run_renew", { run_id: runId, lease_until: lease }, { stop_generation: 0, run_generation: 1 }));
  await until(() => agent.types().includes("renew"), 3_000);
  expect(agent.last("renew")).toEqual({ type: "renew", run_id: runId, lease_until: lease });
  agent.say({ type: "exited", run_id: runId, code: 0, signal: null, overflow: false, stdout_bytes: 0 });
  await until(() => agent.types().includes("count"));
  const sent = agent.types();
  await pause(1_300);
  expect(agent.types()).toEqual(sent);
  expect(sent.lastIndexOf("renew")).toBeLessThan(sent.indexOf("count"));
});
