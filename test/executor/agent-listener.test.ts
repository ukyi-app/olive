// 소켓 수신 한 자리(agent-listener.ts): 스크래치 폴더의 경로 유닉스 소켓에 실제 대리 핵심(src/agent/agent.ts, 가짜 launcher·정리 코어)을 붙여
// hello → 시작 → 끝 → 계수 0이 원격 구현을 지나 worker의 confirmStopped 0(receipt_stopped)까지 닿는지 본다. TCP·abstract 소켓은 쓰지 않는다.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { RoleAgent } from "../../src/agent/agent.ts";
import { ControlDecoder, encodeAgent } from "../../src/agent/link.ts";
import { AgentListenerRefused, listenForAgent, type UnixHandlers, type UnixListen, type UnixListening, type UnixPeer } from "../../src/executor/agent-listener.ts";
import { RemoteAgent } from "../../src/executor/remote-agent.ts";
import { FakeLauncher, FakeRuntime, FakeSpace, FakeWorkspace } from "../agent/support.ts";
import { realTimers } from "./fake-agent.ts";
import { pause, rig, scratch, start, until } from "./support.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const result = new TextEncoder().encode(JSON.stringify({ role: "diagnosis", outcome: "completed", summary: "끝", items: [], refs: [] }));

function newRemote() {
  return new RemoteAgent({ credentialEnv: "OLIVE_CREDENTIAL", runWindow: () => undefined, runtime: realTimers, inheritedUnverified: false, replyWaitMs: 1_000 });
}

// 실제 경로 소켓에 실제 대리 핵심을 붙인 rig. onCount는 worker가 원격 survivors()를 부를 때마다 먼저 불린다.
async function realAgent(exitWaitMs: number, hooks: { onCount?: () => void } = {}) {
  const path = join(scratch("olive-agent-link-"), "agent.sock");
  const r = await rig({
    exitWaitMs,
    remote: {
      attach: (remote) => {
        const listening = listenForAgent(remote, { path, mode: 0o600, chmod: chmodSync });
        stops.push(() => listening.stop());
        const survivors = remote.cleanup.survivors;
        remote.cleanup.survivors = () => {
          hooks.onCount?.();
          return survivors();
        };
      },
    },
  });
  const runtime = new FakeRuntime();
  runtime.t = r.clock.now();
  const space = new FakeSpace();
  const launcher = new FakeLauncher();
  const agent = (await RoleAgent.prepare(runtime, { selfPid: 1, harden: () => true, record: async () => space, launcher, workspace: new FakeWorkspace() }))!;
  const { socket } = await dial(path, (chunk) => agent.receive(chunk), () => agent.linkClosed());
  agent.attach({
    write: (bytes) => {
      if (socket.write(bytes) !== bytes.length) throw new Error("short write");
    },
    close: () => socket.end(),
  });
  await until(() => r.remote!.state().greeted);
  return { r, space, launcher };
}

test("소켓: 실제 대리의 끝내기 응답이 상한을 넘기면 뒤의 계수가 제때 0이어도 receipt_stopped가 나가지 않고 원격은 같은 연결의 ended다", async () => {
  // 대리의 정리는 제어가 계수를 부를 때(또는 시험이 풀 때)에야 끝난다. 대리는 FIFO대로 terminated → counted를 낸다.
  let release: () => void = () => {};
  const { r, space, launcher } = await realAgent(100, { onCount: () => release() });
  space.terminate = () => {
    space.terminations++;
    return new Promise<void>((resolve) => (release = resolve));
  };
  const { runId } = await start(r);
  await until(() => launcher.calls.length === 1);
  launcher.finish(0, result);
  await r.worker.idle();
  release();
  await until(() => !r.remote!.cleanup.busy());
  await pause(50);
  expect(r.store.run(runId)?.state).toBe("unknown_running");
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  expect(r.transport.of("report_result")).toHaveLength(0);
  expect(r.remote!.state()).toMatchObject({ connected: true, generation: 1, phase: "ended", distrusted: null });
});

test("소켓: 실제 대리의 최종 계수만 상한을 넘기면 늦은 0이 원격을 idle로 바꾸지 않는다(같은 연결의 ended)", async () => {
  const { r, space, launcher } = await realAgent(100);
  let late: (n: number) => void = () => {};
  let calls = 0;
  // 첫 계수는 띄우기 전 사전 계수다. 둘째(제어가 보낸 최종 계수)만 쥔다.
  space.survivors = () => (++calls === 1 ? Promise.resolve(0) : new Promise<number | null>((resolve) => (late = resolve)));
  const { runId } = await start(r);
  await until(() => launcher.calls.length === 1);
  launcher.finish(0, result);
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("unknown_running");
  late(0);
  await pause(100);
  expect(r.store.run(runId)?.state).toBe("unknown_running");
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
  expect(r.remote!.state()).toMatchObject({ connected: true, generation: 1, phase: "ended", distrusted: null });
});

// 실제 경로 소켓에 붙는 클라이언트. 받은 바이트를 receive로, 끊김을 closed로 넘긴다.
async function dial(path: string, receive: (chunk: Uint8Array) => void, closed: () => void) {
  const state = { closed: false };
  const socket = await Bun.connect({
    unix: path,
    socket: {
      data: (_socket, chunk) => receive(new Uint8Array(chunk)),
      close: () => {
        state.closed = true;
        closed();
      },
      error: () => {
        state.closed = true;
        closed();
      },
    },
  });
  stops.push(() => socket.end());
  return { socket, state };
}

test("소켓: 실제 대리가 경로 소켓으로 붙어 hello → 시작 → 끝 → 계수 0이 confirmStopped의 0(receipt_stopped)까지 닿는다", async () => {
  const path = join(scratch("olive-agent-link-"), "agent.sock");
  const r = await rig({
    exitWaitMs: 2_000,
    remote: {
      attach: (remote) => {
        const listening = listenForAgent(remote, { path, mode: 0o600, chmod: chmodSync });
        stops.push(() => listening.stop());
      },
    },
  });
  expect(statSync(path).isSocket()).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);

  // 실제 대리 핵심. PID 1·non-dumpable·기준 기록은 가짜 부품으로 통과시키고, 띄우기는 시험이 끝낸다.
  const runtime = new FakeRuntime();
  runtime.t = r.clock.now();
  const space = new FakeSpace();
  const launcher = new FakeLauncher();
  const agent = (await RoleAgent.prepare(runtime, { selfPid: 1, harden: () => true, record: async () => space, launcher, workspace: new FakeWorkspace() }))!;
  const { socket } = await dial(path, (chunk) => agent.receive(chunk), () => agent.linkClosed());
  agent.attach({
    write: (bytes) => {
      if (socket.write(bytes) !== bytes.length) throw new Error("short write");
    },
    close: () => socket.end(),
  });
  await until(() => r.remote!.state().greeted);

  const { runId, value } = await start(r);
  await until(() => launcher.calls.length === 1);
  const plan = launcher.calls[0]!.plan;
  // 값을 담은 비교는 불리언으로만 단언한다(실패 진단에 자격 표본이 실리지 않게).
  expect(plan.env.OLIVE_CREDENTIAL === new TextDecoder().decode(value)).toBe(true);
  expect(plan.program).toBe(process.execPath);
  launcher.finish(0, result);
  await r.worker.idle();

  expect(r.store.run(runId)?.state).toBe("ready_result");
  expect(r.transport.of("receipt_stopped")[0]!.body).toMatchObject({ run_id: runId, remaining_processes: 0, exit: "completed" });
  // 대리 쪽: 띄우기 전 사전 계수 하나, 끝난 뒤 제어가 보낸 끝내기·계수 하나씩.
  expect(space.countCalls).toBe(2);
  expect(space.terminations).toBe(1);
  expect(runtime.exits).toEqual([]);
  expect(r.remote!.state()).toMatchObject({ connected: true, phase: "idle", distrusted: null });
});

test("소켓: 연결이 살아 있는데 두 번째 연결이 오면 두 연결을 모두 닫고 잠근다", async () => {
  const path = join(scratch("olive-agent-link-"), "agent.sock");
  const remote = newRemote();
  const listening = listenForAgent(remote, { path, mode: 0o600, chmod: chmodSync });
  stops.push(() => listening.stop());
  const first = await dial(path, () => {}, () => {});
  first.socket.write(encodeAgent({ type: "hello" }));
  await until(() => remote.state().greeted);
  const second = await dial(path, () => {}, () => {});
  await until(() => first.state.closed && second.state.closed);
  expect(remote.state()).toMatchObject({ connected: false, distrusted: "second_connection" });
  expect(await remote.cleanup.survivors()).toBeNull();
});

test("소켓: 절대 경로가 아니거나 NUL을 담은(abstract) 이름, 잘못된 권한은 듣기 전에 거절한다", () => {
  let listened = 0;
  const listen: UnixListen = () => {
    listened++;
    return { stop: () => {} };
  };
  for (const path of ["agent.sock", "./agent.sock", "\0olive-agent", "/tmp/a\0b", ""]) {
    expect(() => listenForAgent(newRemote(), { path, mode: 0o600, chmod: () => {}, listen })).toThrow(AgentListenerRefused);
  }
  for (const mode of [-1, 0o1000, 1.5]) {
    expect(() => listenForAgent(newRemote(), { path: "/x/agent.sock", mode, chmod: () => {}, listen })).toThrow(AgentListenerRefused);
  }
  expect(listened).toBe(0);
});

test("소켓: 다 못 쓴 바이트는 사본으로 쥐었다 drain에서 차례대로 이어 쓰고, 다 쓴 사본은 0으로 채운다", async () => {
  let handlers!: UnixHandlers;
  const listen: UnixListen = (_path, given): UnixListening => {
    handlers = given;
    return { stop: () => {} };
  };
  const remote = newRemote();
  listenForAgent(remote, { path: "/x/agent.sock", mode: 0o600, chmod: () => {}, listen });
  const wire: number[] = [];
  const held: Uint8Array[] = [];
  let budget = 5;
  const peer: UnixPeer = {
    write: (bytes) => {
      held.push(bytes);
      const n = Math.min(bytes.length, budget);
      wire.push(...bytes.subarray(0, n));
      budget -= n;
      return n;
    },
    end: () => {},
  };
  handlers.open(peer);
  handlers.data(peer, encodeAgent({ type: "hello" }));
  const counting = remote.cleanup.survivors();
  const terminating = remote.cleanup.terminate();
  // 처음 5바이트만 나갔다. 나머지는 drain마다 7바이트씩 나간다.
  for (let i = 0; i < 40; i++) {
    budget = 7;
    handlers.drain(peer);
  }
  const decoder = new ControlDecoder();
  expect(decoder.push(new Uint8Array(wire))).toEqual([
    { type: "count", seq: 1 },
    { type: "terminate", seq: 2 },
  ]);
  // 이 파일이 쥔 사본(첫 쓰기 뒤의 나머지)은 다 쓴 뒤 0이다. 첫 호출의 버퍼는 원격 구현의 것이다.
  for (const bytes of held.slice(1)) expect(bytes.every((byte) => byte === 0)).toBe(true);
  handlers.data(peer, encodeAgent({ type: "counted", seq: 1, survivors: 0 }));
  handlers.data(peer, encodeAgent({ type: "terminated", seq: 2 }));
  expect(await counting).toBe(0);
  await terminating;
});

test("소켓: drain의 이어 쓰기가 던지면 쥔 사본을 0으로 지우고 연결을 닫아 세션에 끊김을 알린다", async () => {
  let handlers!: UnixHandlers;
  const listen: UnixListen = (_path, given): UnixListening => {
    handlers = given;
    return { stop: () => {} };
  };
  const remote = newRemote();
  listenForAgent(remote, { path: "/x/agent.sock", mode: 0o600, chmod: () => {}, listen });
  const held: Uint8Array[] = [];
  let ended = 0;
  let writes = 0;
  const peer: UnixPeer = {
    write: (bytes) => {
      held.push(bytes);
      if (++writes > 1) throw new Error("drain write failed");
      return 3;
    },
    end: () => {
      ended++;
    },
  };
  handlers.open(peer);
  handlers.data(peer, encodeAgent({ type: "hello" }));
  const terminating = remote.cleanup.terminate();
  handlers.drain(peer);
  expect(ended).toBe(1);
  expect(remote.state()).toMatchObject({ connected: false, distrusted: null });
  expect(await terminating.then(() => "settled", () => "rejected")).toBe("rejected");
  for (const bytes of held.slice(1)) expect(bytes.every((byte) => byte === 0)).toBe(true);
});

test("소켓: 실제 bind 함수는 내보내지 않는다(경로·권한 검사를 지나는 listenForAgent만 공개)", async () => {
  const listener = await import("../../src/executor/agent-listener.ts");
  expect(Object.keys(listener).sort()).toEqual(["AgentListenerRefused", "listenForAgent"]);
});
