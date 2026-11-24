// 대리 진입점(src/main/role-agent.ts)의 보장: prepare(non-dumpable → PID 1 → 정리 코어 기록)가 소켓보다 먼저이고, 붙으면 hello를 보내고,
// 소켓이 닫히면 linkClosed로 대리가 끝난다. 붙지 못하면 상한까지 다시 붙고 82로 끝난다. 다 못 쓴 바이트는 drain에서 이어 쓴다.
import { expect, test } from "bun:test";
import { AGENT_EXIT, type AgentParts } from "../../src/agent/agent.ts";
import { AgentDecoder } from "../../src/agent/link.ts";
import { type AgentSocketHandlers, type AgentSocketPort, ROLE_AGENT_EXIT, runRoleAgent } from "../../src/main/role-agent.ts";
import { FakeLauncher, FakeRuntime, FakeSpace, settle } from "./support.ts";

const PATH = "/run/olive/link/agent.sock";

function parts(order: string[], over: Partial<AgentParts> = {}): AgentParts {
  return {
    selfPid: 1,
    harden: () => (order.push("harden"), true),
    record: async () => (order.push("record"), new FakeSpace()),
    launcher: new FakeLauncher(),
    ...over,
  };
}

// 붙은 소켓 자리. write가 돌려줄 수를 시험이 정한다(기본은 다 씀).
class Port implements AgentSocketPort {
  readonly written: Uint8Array[] = [];
  ended = false;
  // 다음 쓰기마다 쓸 최대 바이트 수. 비면 다 쓴다.
  limits: number[] = [];
  write(bytes: Uint8Array): number {
    const n = Math.min(bytes.length, this.limits.length > 0 ? this.limits.shift()! : bytes.length);
    this.written.push(bytes.slice(0, n));
    return n;
  }
  end(): void {
    this.ended = true;
  }
  types(): string[] {
    const decoder = new AgentDecoder();
    return this.written.flatMap((bytes) => decoder.push(bytes)).map((message) => message.type);
  }
}

function connector(order: string[], port: Port, failures = 0) {
  const state = { handlers: null as AgentSocketHandlers | null, attempts: 0 };
  const connect = async (path: string, handlers: AgentSocketHandlers) => {
    order.push(`connect ${path}`);
    state.attempts++;
    if (state.attempts <= failures) throw new Error("ENOENT");
    state.handlers = handlers;
    return port;
  };
  return { connect, state };
}

test("대리 진입점: non-dumpable → PID 1 → 정리 코어 기록 → 소켓에 붙음 → hello. 소켓이 닫히면 75로 끝난다", async () => {
  const order: string[] = [];
  const runtime = new FakeRuntime();
  const port = new Port();
  const { connect, state } = connector(order, port);
  const agent = await runRoleAgent({ socketPath: PATH, runtime, parts: parts(order), connect, connectWaitMs: 1_000, retryMs: 100, monoNow: runtime.now });
  expect(agent).not.toBeNull();
  expect(order).toEqual(["harden", "record", `connect ${PATH}`]);
  expect(port.types()).toEqual(["hello"]);
  expect(runtime.exits).toEqual([]);
  state.handlers!.close();
  await settle();
  expect(runtime.exits).toEqual([AGENT_EXIT.link_closed]);
  expect(port.ended).toBe(true);
});

test("대리 진입점: non-dumpable·PID 1·기록 중 하나라도 실패하면 소켓에 붙지 않고 대리의 코드로 끝난다", async () => {
  const cases: [Partial<AgentParts>, number][] = [
    [{ harden: () => false }, AGENT_EXIT.not_hardened],
    [{ selfPid: 7 }, AGENT_EXIT.not_init],
    [{ record: () => Promise.reject(new Error("baseline_not_clean")) }, AGENT_EXIT.space_unavailable],
  ];
  for (const [over, code] of cases) {
    const order: string[] = [];
    const runtime = new FakeRuntime();
    const { connect, state } = connector(order, new Port());
    expect(await runRoleAgent({ socketPath: PATH, runtime, parts: parts(order, over), connect, connectWaitMs: 1_000, retryMs: 100, monoNow: runtime.now })).toBeNull();
    expect(runtime.exits).toEqual([code]);
    expect(state.attempts).toBe(0);
  }
});

test("대리 진입점: 제어가 아직 듣지 않으면 retryMs마다 다시 붙고, 붙으면 hello를 보낸다", async () => {
  const order: string[] = [];
  const runtime = new FakeRuntime();
  const port = new Port();
  const { connect, state } = connector(order, port, 2);
  const running = runRoleAgent({ socketPath: PATH, runtime, parts: parts(order), connect, connectWaitMs: 1_000, retryMs: 100, monoNow: runtime.now });
  await settle();
  expect(state.attempts).toBe(1);
  runtime.advance(100);
  await settle();
  runtime.advance(100);
  expect(await running).not.toBeNull();
  expect(state.attempts).toBe(3);
  expect(port.types()).toEqual(["hello"]);
});

test("대리 진입점: 정리 코어 기록(prepare)이 붙기 상한 안에 돌아오지 않으면 82로 끝나고 소켓에 붙지 않는다", async () => {
  const order: string[] = [];
  const runtime = new FakeRuntime();
  const port = new Port();
  const { connect, state } = connector(order, port);
  const stalled = parts(order, { record: () => new Promise<never>(() => {}) });
  const running = runRoleAgent({ socketPath: PATH, runtime, parts: stalled, connect, connectWaitMs: 250, retryMs: 100, monoNow: runtime.now });
  await settle();
  runtime.advance(249);
  await settle();
  expect(runtime.exits).toEqual([]);
  runtime.advance(1);
  expect(await running).toBeNull();
  expect(runtime.exits).toEqual([ROLE_AGENT_EXIT.unreachable]);
  expect(state.attempts).toBe(0);
  expect(port.written).toEqual([]);
});

test("대리 진입점: 상한 안에 붙지 못하면 82로 끝나고 hello를 보내지 않는다", async () => {
  const order: string[] = [];
  const runtime = new FakeRuntime();
  const port = new Port();
  const { connect, state } = connector(order, port, Number.POSITIVE_INFINITY);
  const running = runRoleAgent({ socketPath: PATH, runtime, parts: parts(order), connect, connectWaitMs: 250, retryMs: 100, monoNow: runtime.now });
  for (let i = 0; i < 5; i++) {
    await settle();
    runtime.advance(100);
  }
  expect(await running).toBeNull();
  expect(runtime.exits).toEqual([ROLE_AGENT_EXIT.unreachable]);
  // 0ms·100ms·200ms에 붙어 보고, 300ms는 상한(250ms)을 넘어 시도하지 않는다.
  expect(state.attempts).toBe(3);
  expect(port.written).toEqual([]);
});

test("대리 진입점: 다 못 쓴 바이트는 사본으로 쥐었다가 drain에서 차례대로 이어 쓴다", async () => {
  const order: string[] = [];
  const runtime = new FakeRuntime();
  const port = new Port();
  // hello 틀의 앞 3바이트만 쓰이고 나머지는 drain을 기다린다.
  port.limits = [3, 0];
  const { connect, state } = connector(order, port);
  await runRoleAgent({ socketPath: PATH, runtime, parts: parts(order), connect, connectWaitMs: 1_000, retryMs: 100, monoNow: runtime.now });
  expect(port.types()).toEqual([]);
  state.handlers!.drain();
  expect(port.types()).toEqual([]);
  state.handlers!.drain();
  expect(port.types()).toEqual(["hello"]);
  expect(runtime.exits).toEqual([]);
});

test("대리 진입점: 받은 조각은 대리에 넘긴 뒤 0으로 채운다. 계약 밖의 바이트면 대리가 77로 끝난다", async () => {
  const order: string[] = [];
  const runtime = new FakeRuntime();
  const { connect, state } = connector(order, new Port());
  await runRoleAgent({ socketPath: PATH, runtime, parts: parts(order), connect, connectWaitMs: 1_000, retryMs: 100, monoNow: runtime.now });
  const chunk = new Uint8Array([0, 0, 0, 2, 0x7b, 0x7d]);
  state.handlers!.data(chunk);
  expect([...chunk]).toEqual([0, 0, 0, 0, 0, 0]);
  await settle();
  expect(runtime.exits).toEqual([AGENT_EXIT.protocol]);
});

test("대리 진입점: 붙는 중인 연결이 상한을 넘기면 기다리지 않고 82로 끝나고, 늦게 돌아온 포트는 hello 없이 닫는다", async () => {
  const order: string[] = [];
  const runtime = new FakeRuntime();
  const port = new Port();
  let finish!: (port: AgentSocketPort) => void;
  let late: AgentSocketHandlers | null = null;
  const connect = (path: string, handlers: AgentSocketHandlers) => {
    order.push(`connect ${path}`);
    late = handlers;
    return new Promise<AgentSocketPort>((resolve) => (finish = resolve));
  };
  const running = runRoleAgent({ socketPath: PATH, runtime, parts: parts(order), connect, connectWaitMs: 1_000, retryMs: 100, monoNow: runtime.now });
  await settle();
  runtime.advance(1_000);
  await settle();
  expect(runtime.exits).toEqual([ROLE_AGENT_EXIT.unreachable]);
  runtime.advance(50);
  finish(port);
  expect(await running).toBeNull();
  await settle();
  expect(port.ended).toBe(true);
  expect(port.written).toEqual([]);
  // 버린 연결을 닫을 때의 닫힘은 대리의 링크 끊김(75)이 되지 않는다.
  late!.close();
  await settle();
  expect(runtime.exits).toEqual([ROLE_AGENT_EXIT.unreachable]);
});

test("대리 진입점: 다시 붙기 타이머가 상한 뒤에 늦게 깨면 더 붙지 않고 82로 끝난다(경과는 단조 시계로 잰다)", async () => {
  const order: string[] = [];
  const runtime = new FakeRuntime();
  const port = new Port();
  const { connect, state } = connector(order, port, 1);
  // 벽시계와 따로 가는 단조 시계: 벽시계가 뒤로 가도 경과가 줄지 않는다.
  let mono = 0;
  const running = runRoleAgent({ socketPath: PATH, runtime, parts: parts(order), connect, connectWaitMs: 250, retryMs: 100, monoNow: () => mono });
  await settle();
  expect(state.attempts).toBe(1);
  runtime.t -= 10_000;
  mono = 300;
  runtime.advance(10_100);
  expect(await running).toBeNull();
  expect(state.attempts).toBe(1);
  expect(runtime.exits).toEqual([ROLE_AGENT_EXIT.unreachable]);
  expect(port.written).toEqual([]);
});
