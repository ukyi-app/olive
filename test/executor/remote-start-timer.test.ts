// 시작 응답 기한의 타이머가 기한보다 일찍 돌아도 기한 안의 정상 응답을 버리지 않는지.
// 실제 타이머는 소수 밀리초를 내림해 정각보다 조금 먼저 콜백을 부를 수 있다. 판정은 주입 단조 시계의 기한(expiresAt)이 한다.
import { expect, test } from "bun:test";
import { type AgentMessage, ControlDecoder, encodeAgent, type ReceivedControl } from "../../src/agent/link.ts";
import type { AgentLinkSession, RemoteAgent, RemoteAgentRuntime } from "../../src/executor/remote-agent.ts";
import { rig, start, until } from "./support.ts";

// worker의 상한(실제 타이머)은 시험 안에서 울리지 않을 만큼 길다. 원격의 기한도 같은 값이다(support.ts가 같은 값을 넘긴다).
const WAIT_MS = 5_000;

// 타이머는 스스로 돌지 않고 시험이 부른다. 시계도 시험이 움직인다.
class HeldRuntime implements RemoteAgentRuntime {
  t = 1_000;
  readonly timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  now = () => this.t;
  setTimer(ms: number, fire: () => void): () => void {
    const timer = { ms, fire, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  // 갱신 간격(1초)보다 긴 살아 있는 타이머 가운데 마지막 것이 시작 기한의 타이머다.
  startTimer() {
    return this.timers.filter((timer) => !timer.cancelled && timer.ms > 1_000).at(-1);
  }
}

class Agent {
  session: AgentLinkSession | null = null;
  readonly got: ReceivedControl[] = [];
  private readonly decoder = new ControlDecoder();

  attach(remote: RemoteAgent): void {
    this.session = remote.connect({
      write: (bytes) => {
        for (const message of this.decoder.push(new Uint8Array(bytes))) {
          if (message.type === "start") message.credential.discard();
          this.got.push(message);
        }
      },
      close: () => {},
    });
    this.say({ type: "hello" });
  }

  say(message: AgentMessage): void {
    this.session?.receive(encodeAgent(message));
  }

  types(): string[] {
    return this.got.map((message) => message.type);
  }
}

async function started() {
  const agent = new Agent();
  const runtime = new HeldRuntime();
  const r = await rig({ exitWaitMs: WAIT_MS, remote: { attach: (remote) => agent.attach(remote), runtime } });
  const { runId } = await start(r);
  await until(() => agent.types().includes("start"));
  const expiresAt = runtime.t + WAIT_MS;
  return { agent, runtime, r, runId, expiresAt };
}

test("원격 시작 기한: 타이머가 정각 0.5ms 전에 돌아도 기한 안(0.25ms 전)에 받은 spawned는 시작으로 기록한다", async () => {
  const { agent, runtime, r, runId, expiresAt } = await started();
  const timer = runtime.startTimer()!;
  expect(timer.ms).toBe(WAIT_MS);
  runtime.t = expiresAt - 0.5;
  timer.fire();
  await Promise.resolve();
  // 아직 기한 전이다: 끝내기를 보내지 않고 남은 시간만큼 다시 건다.
  expect(agent.types()).toEqual(["start"]);
  runtime.t = expiresAt - 0.25;
  agent.say({ type: "spawned", run_id: runId });
  await until(() => r.transport.of("receipt_started").length === 1, 1_000);
  expect(r.remote!.state()).toMatchObject({ phase: "running", distrusted: null });
  expect(agent.types()).toEqual(["start"]);
});

test("원격 시작 기한: 일찍 돈 타이머가 다시 건 기다림은 기한에 닿으면 끝내기를 보내고 모름이다", async () => {
  const { agent, runtime, r, runId, expiresAt } = await started();
  runtime.t = expiresAt - 0.5;
  const first = runtime.startTimer()!;
  first.fire();
  const again = runtime.timers.at(-1);
  expect(again).not.toBe(first);
  // 남은 0.5ms를 올림한 1ms로 다시 건다. 0ms로 걸면 같은 시각에 다시 돌아 기한 전 콜백이 되풀이된다.
  expect(again?.ms).toBe(1);
  runtime.t = expiresAt;
  again!.fire();
  await until(() => r.store.run(runId)?.state === "unknown_running", 1_000);
  expect(agent.types()).toEqual(["start", "terminate"]);
  expect(r.transport.of("receipt_started")).toHaveLength(0);
  expect(r.transport.of("receipt_stopped")).toHaveLength(0);
});
