// 원격 구현(RemoteAgent)이 링크의 이상을 모두 모름으로 다루는지: 시험이 대리 자리에서 링크의 말을 직접 정해 작업자(worker) 전체를 지나게 한다.
// 어느 사례든 receipt_stopped가 나가지 않고 실행은 슬롯을 쥔 unknown_running이어야 한다. 마지막의 정상 길은 대조군이다.
import { afterEach, expect, test } from "bun:test";
import { type AgentMessage, ControlDecoder, encodeAgent, type ReceivedControl } from "../../src/agent/link.ts";
import { limits } from "../../src/contract/v1/index.ts";
import type { AgentLinkSession, DistrustReason, RemoteAgent, RemoteAgentRuntime } from "../../src/executor/remote-agent.ts";
import { encodeFrame } from "../../src/transport/framing.ts";
import { fromSupervisor, pause, type Rig, type RigOptions, rig, scriptedIo, sha256, start, until } from "./support.ts";

// 대리 자리. 받은 지시를 디코딩해 쌓고, 시험이 정한 말만 한다.
class ManualAgent {
  session: AgentLinkSession | null = null;
  closed = false;
  readonly got: ReceivedControl[] = [];
  readonly credentials: string[] = [];
  private readonly decoder = new ControlDecoder();
  // terminate·count에 같은 호출 안에서 답한다. undefined면 그 종류에 답하지 않는다.
  // terminate가 "with_count"면 그 답을 쥐고 있다가 다음 count가 오면 FIFO대로 terminated → counted 차례로 낸다.
  answers: { terminate?: boolean | "with_count"; count?: number | null } = {};
  private held: number[] = [];

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
    if (message.type === "terminate" && this.answers.terminate === "with_count") this.held.push(message.seq);
    else if (message.type === "terminate" && this.answers.terminate) this.say({ type: "terminated", seq: message.seq });
    if (message.type === "count") this.releaseHeld();
    if (message.type === "count" && this.answers.count !== undefined) this.say({ type: "counted", seq: message.seq, survivors: this.answers.count });
  }

  // 쥐고 있던 terminated를 지금 낸다(대리의 정리가 늦게 끝난 때).
  releaseHeld(): void {
    for (const seq of this.held.splice(0)) this.say({ type: "terminated", seq });
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

async function make(
  agent: ManualAgent,
  options: {
    dir?: string;
    clock?: Rig["clock"];
    inheritedUnverified?: boolean;
    io?: RigOptions["io"];
    exitWaitMs?: number;
    runtime?: RemoteAgentRuntime;
  } = {},
) {
  const r = await rig({
    exitWaitMs: options.exitWaitMs ?? 100,
    dir: options.dir,
    clock: options.clock,
    io: options.io,
    remote: { attach: (remote) => void agent.attach(remote), inheritedUnverified: options.inheritedUnverified, runtime: options.runtime },
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

test("원격 늦은 끝내기: terminate의 답이 상한을 넘기면 뒤의 계수가 제때 0이어도 모름이고, 원격은 같은 연결의 ended로 남는다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: "with_count", count: 0 };
  const r = await make(agent);
  const { runId } = await launchedAndExited(r, agent);
  await r.worker.idle();
  // 대리의 정리가 상한(100ms) 뒤에야 끝난다. 그 뒤의 0은 이 시도의 종료 증거가 아니다.
  agent.releaseHeld();
  await pause(50);
  expectUnknown(r, runId);
  expect(r.transport.of("report_result")).toHaveLength(0);
  expect(r.remote!.state()).toMatchObject({ connected: true, generation: 1, phase: "ended", distrusted: null });
  expect(r.remote!.cleanup.busy()).toBe(false);
  // 같은 연결에서 새로 끝내고 세어 기한 안에 받은 0만 그 실행을 닫는다.
  agent.answers = { terminate: true, count: 0 };
  await r.connection.receive(cancel(r, runId));
  await r.worker.idle();
  expect(r.transport.of("receipt_stopped")).toHaveLength(1);
  expect(r.remote!.state()).toMatchObject({ connected: true, generation: 1, phase: "idle", distrusted: null });
});

test("원격 늦은 최종 계수: 상한 뒤의 0은 요청만 놓고 ended·연결 세대를 그대로 두며, 확인 전에 끊기면 잠근다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true };
  const r = await make(agent);
  const { runId } = await launchedAndExited(r, agent);
  await r.worker.idle();
  expectUnknown(r, runId);
  agent.say({ type: "counted", seq: agent.last("count").seq, survivors: 0 });
  await pause(50);
  expectUnknown(r, runId);
  expect(r.remote!.state()).toMatchObject({ connected: true, generation: 1, phase: "ended", distrusted: null });
  // 이 실행을 확인하기 전에 링크가 끊기면 실행 중 끊김과 같다. 새 연결의 계수가 옛 실행을 닫지 못한다.
  agent.session!.closed();
  expect(r.remote!.state()).toMatchObject({ connected: false, generation: 1, phase: "ended", distrusted: "link_lost_mid_run" });
  const fresh = new ManualAgent();
  fresh.answers = { terminate: true, count: 0 };
  expect(fresh.attach(r.remote!)).toBeNull();
  await r.connection.receive(cancel(r, runId));
  await r.worker.idle();
  expectUnknown(r, runId);
  expect(fresh.types()).toEqual([]);
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

// support.ts의 DIRECT_ONLY 넷이 지키던 보장 가운데 링크로 옮길 수 있는 것. 제어가 exited를 받은(끝을 관측한) 뒤의 기대를 고정한다.
test("원격 깊은 결과(R16): 바이트 상한 안에서 깊이만 넘는 결과는 고정 실패 결과가 되고 종료 증거·상태를 뒤집지 않는다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true, count: 0 };
  const r = await make(agent);
  const { runId } = await start(r);
  await until(() => agent.types().includes("start"));
  const deep = new TextEncoder().encode("[".repeat(10_000) + "]".repeat(10_000));
  expect(deep.length).toBeLessThan(agent.last("start").output_bytes);
  agent.say({ type: "spawned", run_id: runId });
  agent.say({ type: "output", run_id: runId, data: Buffer.from(deep).toString("base64") });
  agent.say({ type: "exited", run_id: runId, code: 0, signal: null, overflow: false, stdout_bytes: deep.length });
  await r.worker.idle();
  expect(stateOf(r, runId)).toBe("ready_result");
  expect(r.transport.of("receipt_stopped")).toHaveLength(1);
  expect(r.transport.of("receipt_stopped")[0]!.body).toMatchObject({ remaining_processes: 0, exit: "completed" });
  expect(r.transport.of("report_result")[0]!.body.result).toMatchObject({ outcome: "failed", items: [], refs: [] });
  expect(r.remote!.state()).toMatchObject({ phase: "idle", distrusted: null });
});

test("원격 끝난 뒤 임대(R11): exited를 받은 뒤의 run_renew는 저장된 임대를 늘리지 않고 대리에게 renew도 보내지 않는다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: "with_count", count: 0 };
  const r = await make(agent, { exitWaitMs: 2_000 });
  const { runId } = await launchedAndExited(r, agent);
  await until(() => agent.types().includes("terminate"));
  const lease = r.store.run(runId)!.lease_until;
  r.clock.advance(1_000);
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "run_renew", { run_id: runId, lease_until: r.clock.now() + limits.RUN_LEASE_MAX_MS }, { stop_generation: 0, run_generation: 1 }));
  expect(r.store.run(runId)?.lease_until).toBe(lease);
  agent.releaseHeld();
  await r.worker.idle();
  expect(agent.types()).not.toContain("renew");
  expect(r.transport.of("receipt_stopped")[0]!.body).toMatchObject({ remaining_processes: 0, exit: "completed" });
});

test("원격 nonce 장애(F10): 끝을 관측한 뒤 nonce 기록이 실패해도 그 실행의 완료 종료와 결과를 바꾸지 않는다", async () => {
  const disk = scriptedIo();
  const agent = new ManualAgent();
  agent.answers = { terminate: "with_count", count: 0 };
  const r = await make(agent, { io: disk.io, exitWaitMs: 2_000 });
  const { runId } = await launchedAndExited(r, agent);
  await until(() => agent.types().includes("terminate"));
  // 검증을 다 지난 봉투의 nonce 기록이 실패한다(그 봉투의 효과는 나지 않는다).
  disk.markers.failing = true;
  await r.connection.receive(cancel(r, runId));
  expect(r.transport.closed).toBe(true);
  disk.markers.failing = false;
  agent.releaseHeld();
  await r.worker.idle();
  expect(r.store.outboxFor(runId).find((e) => e.action === "receipt_stopped")?.body.exit).toBe("completed");
  expect(stateOf(r, runId)).toBe("ready_result");
  expect(sha256(JSON.stringify(r.store.outboxFor(runId).find((e) => e.action === "report_result")?.body.result))).toBe(
    sha256(JSON.stringify(JSON.parse(new TextDecoder().decode(result)))),
  );
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
  // 값을 담은 비교는 불리언으로만 단언한다(실패 진단에 자격 표본이 실리지 않게).
  expect(agent.credentials).toHaveLength(1);
  expect(agent.credentials[0] === marker).toBe(true);
  expect(startMessage.credential_env).toBe("OLIVE_CREDENTIAL");
  expect(Object.keys(startMessage.env)).not.toContain("OLIVE_CREDENTIAL");
  expect(JSON.stringify(startMessage).includes(marker)).toBe(false);
  expect(JSON.stringify(r.remote!.state()).includes(marker)).toBe(false);
});

test("원격 시작 응답 상한: 시작을 보낸 뒤 replyWaitMs 안에 spawned·not_spawned가 없으면 끝내기를 보내고 모름이다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true, count: 0 };
  const r = await make(agent);
  const { runId } = await start(r);
  await until(() => agent.types().includes("start"));
  await until(() => stateOf(r, runId) === "unknown_running", 1_000);
  expectUnknown(r, runId);
  expect(agent.types()).toEqual(["start", "terminate"]);
  expect(r.remote!.state()).toMatchObject({ connected: true, phase: "starting", distrusted: null });
});

// 원격 구현의 단조 시계와 타이머를 따로 움직인다. 타이머는 스스로 돌지 않는다(콜백이 기한보다 늦게 도는 경우).
// worker의 상한은 실제 타이머(SLOW_MS)라 시험 안에서 울리지 않는다. 원격의 기한도 같은 SLOW_MS다(support.ts가 같은 값을 넘긴다).
class FrozenRuntime implements RemoteAgentRuntime {
  t = 1_000;
  now = () => this.t;
  setTimer(): () => void {
    return () => {};
  }
}
const SLOW_MS = 5_000;

async function countAnsweredAt(elapsed: number) {
  const agent = new ManualAgent();
  agent.answers = { terminate: true };
  const runtime = new FrozenRuntime();
  const r = await make(agent, { exitWaitMs: SLOW_MS, runtime });
  const { runId } = await launchedAndExited(r, agent);
  await until(() => agent.types().includes("count"));
  runtime.t += elapsed;
  agent.say({ type: "counted", seq: agent.last("count").seq, survivors: 0 });
  await r.worker.idle();
  return { r, runId };
}

test("원격 응답 시각: 기한이 지난 뒤 받은 최종 0은 기한 타이머가 아직 돌지 않았어도 쓰지 않는다(null·ended·종료 0건)", async () => {
  const { r, runId } = await countAnsweredAt(SLOW_MS);
  expectUnknown(r, runId);
  expect(r.transport.of("report_result")).toHaveLength(0);
  expect(r.remote!.state()).toMatchObject({ connected: true, generation: 1, phase: "ended", distrusted: null });
});

test("원격 응답 시각 대조군: 기한 직전에 받은 최종 0은 채택해 종료 확인을 낸다", async () => {
  const { r, runId } = await countAnsweredAt(SLOW_MS - 1);
  expect(stateOf(r, runId)).toBe("ready_result");
  expect(r.transport.of("receipt_stopped")).toHaveLength(1);
  expect(r.remote!.state()).toMatchObject({ phase: "idle", distrusted: null });
});

test("원격 응답 시각: 기한이 지난 뒤 받은 terminated는 늦은 답이고, 그 시도의 계수는 0의 근거가 되지 못한다", async () => {
  const agent = new ManualAgent();
  agent.answers = { count: 0 };
  const runtime = new FrozenRuntime();
  const r = await make(agent, { exitWaitMs: SLOW_MS, runtime });
  const { runId } = await launchedAndExited(r, agent);
  await until(() => agent.types().includes("terminate"));
  runtime.t += SLOW_MS;
  agent.say({ type: "terminated", seq: agent.last("terminate").seq });
  await r.worker.idle();
  expectUnknown(r, runId);
  expect(r.remote!.state()).toMatchObject({ connected: true, generation: 1, phase: "ended", distrusted: null });
});

test("원격 응답 시각: 답이 없는 terminate의 기한이 시계로 지났으면 타이머가 돌기 전이어도 계수를 묻지 않는다", async () => {
  const agent = new ManualAgent();
  const runtime = new FrozenRuntime();
  const r = await make(agent, { exitWaitMs: SLOW_MS, runtime });
  const { runId } = await launchedAndExited(r, agent);
  await until(() => agent.types().includes("terminate"));
  runtime.t += SLOW_MS;
  expect(await r.remote!.cleanup.survivors()).toBeNull();
  expect(agent.types()).toEqual(["start", "terminate"]);
  // worker의 상한을 기다리지 않고 끝낸다: 답 없는 terminate를 끊김으로 거둔다(시작 뒤 끊김이라 잠금).
  agent.session!.closed();
  await r.worker.idle();
  expectUnknown(r, runId);
});

test("원격 응답 시각: 시작 기한이 지난 뒤 받은 spawned로는 띄운 실행이 되지 않고 모름이다", async () => {
  const agent = new ManualAgent();
  agent.answers = { terminate: true, count: 0 };
  const runtime = new FrozenRuntime();
  const r = await make(agent, { exitWaitMs: SLOW_MS, runtime });
  const { runId } = await start(r);
  await until(() => agent.types().includes("start"));
  runtime.t += SLOW_MS;
  agent.say({ type: "spawned", run_id: runId });
  await until(() => stateOf(r, runId) === "unknown_running", 1_000);
  await r.worker.idle();
  expectUnknown(r, runId);
  expect(r.transport.of("receipt_started")).toHaveLength(0);
  expect(agent.types()).toEqual(["start", "terminate"]);
  expect(r.remote!.state()).toMatchObject({ connected: true, phase: "running", distrusted: null });
});

test("원격 잘린 틀: 쉬는 동안의 끊김도 틀 중간이면 잠그고, 틀 경계에서의 끊김은 잠그지 않는다", async () => {
  const cut = new ManualAgent();
  const r = await make(cut);
  const frame = encodeAgent({ type: "counted", seq: 1, survivors: 0 });
  cut.session!.receive(frame.subarray(0, 3));
  cut.session!.closed();
  expect(r.remote!.state()).toMatchObject({ connected: false, phase: "idle", distrusted: "link_rejected" });
  const whole = new ManualAgent();
  const clean = await make(whole);
  whole.session!.closed();
  expect(clean.remote!.state()).toMatchObject({ connected: false, phase: "idle", distrusted: null });
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
