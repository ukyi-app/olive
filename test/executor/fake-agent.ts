// 시험용 가짜 대리: 링크 바이트를 agent/link.ts의 디코더로 읽어, 시험이 준 launcher·정리(FakeCleanup 등)에 그대로 옮긴다.
// 실제 대리(src/agent/agent.ts)와 같은 말을 같은 차례로 낸다: 끝내기·세기의 답은 받은 차례대로이고, 실행의 말은
// spawned → output* → exited|unconfirmed 또는 not_spawned 하나다. 실제 대리와 다른 점은 시험의 호출 수·시점을 같은 컨테이너 구현과 맞추려는 것뿐이다:
// 띄우기 전 사전 계수를 하지 않고, 받은 terminate로 멈춘 실행의 launcher 중단 훅은 정리를 다시 부르지 않으며(그 terminate가 한 번 부른다),
// 정리 호출은 받은 즉시 시작하고 답만 차례를 지킨다(실제 대리는 정리 자체를 하나씩 한다).
// 시각(기한·임대)과 스스로 집행은 하지 않는다. 그것은 실제 대리의 시험(test/agent/)과 소켓 시험이 본다.
import { ControlDecoder, encodeAgent, type AgentMessage, outputMessages, type ReceivedControl } from "../../src/agent/link.ts";
import type { ProcessCleanup } from "../../src/executor/containment.ts";
import { LaunchFailed, type Launcher } from "../../src/executor/launcher.ts";
import { credentialText } from "../../src/executor/profile.ts";
import type { AgentLinkSession, AgentLinkTransport, RemoteAgent } from "../../src/executor/remote-agent.ts";

export interface FakeAgentOptions {
  drainMs?: number;
  exitWaitMs?: number;
}

export class FakeAgent {
  private readonly decoder = new ControlDecoder();
  private queue: Promise<void> = Promise.resolve();
  private run: { runId: string; controller: AbortController; stopping: boolean } | null = null;
  private session: AgentLinkSession | null = null;
  closed = false;
  readonly received: string[] = [];

  constructor(
    private readonly launcher: Launcher,
    private readonly cleanup: ProcessCleanup,
    private readonly options: FakeAgentOptions = {},
  ) {}

  // 원격 구현에 연결 하나를 열고 hello를 보낸다. 바이트는 같은 호출 안에서 상대에게 넘어간다(동기 전달).
  attach(remote: RemoteAgent): AgentLinkSession | null {
    const transport: AgentLinkTransport = {
      write: (bytes) => {
        if (this.closed) throw new Error("closed");
        this.receive(new Uint8Array(bytes));
      },
      close: () => {
        this.closed = true;
      },
    };
    this.session = remote.connect(transport);
    if (this.session !== null) this.tell({ type: "hello" });
    return this.session;
  }

  tell(message: AgentMessage): void {
    if (this.closed || this.session === null) return;
    this.session.receive(encodeAgent(message));
  }

  private receive(chunk: Uint8Array): void {
    let messages: ReceivedControl[];
    try {
      messages = this.decoder.push(chunk);
    } catch {
      this.closed = true;
      this.session?.closed();
      return;
    }
    for (const message of messages) this.handle(message);
  }

  private handle(message: ReceivedControl): void {
    this.received.push(message.type);
    switch (message.type) {
      case "start": {
        const value = message.credential.take();
        const credential = value === null ? null : credentialText(value);
        value?.fill(0);
        const run = { runId: message.run_id, controller: new AbortController(), stopping: false };
        this.run = run;
        if (credential === null) return this.tell({ type: "not_spawned", run_id: run.runId, reason: "refused" });
        const plan = { program: message.program, argv: [...message.argv], cwd: message.cwd, env: { ...message.env, [message.credential_env]: credential } };
        void this.launch(run, plan, message.output_bytes);
        return;
      }
      case "renew":
        return;
      case "terminate": {
        if (this.run !== null) {
          this.run.stopping = true;
          this.run.controller.abort();
        }
        const done = this.callNow(() => this.cleanup.terminate()).catch(() => {});
        return this.answerInOrder(done.then(() => ({ type: "terminated", seq: message.seq })));
      }
      case "count": {
        const survivors = this.callNow(() => this.cleanup.survivors()).catch(() => null);
        return this.answerInOrder(survivors.then((value) => ({ type: "counted", seq: message.seq, survivors: value })));
      }
    }
  }

  // 정리를 같은 호출 안에서 부른다(동기 예외도 거절로 받는다).
  private callNow<T>(call: () => Promise<T>): Promise<T> {
    try {
      return call();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private answerInOrder(answer: Promise<AgentMessage>): void {
    this.queue = this.queue.then(() => answer).then((message) => this.tell(message), () => {});
  }

  private async launch(run: NonNullable<FakeAgent["run"]>, plan: Parameters<Launcher["run"]>[0], outputBytes: number): Promise<void> {
    const runId = run.runId;
    let spawned = false;
    try {
      const outcome = await this.launcher.run(plan, run.controller.signal, {
        busy: () => this.cleanup.busy(),
        terminate: () => (run.stopping ? Promise.resolve() : this.cleanup.terminate()),
        spawned: () => {
          spawned = true;
          this.tell({ type: "spawned", run_id: runId });
        },
        outputBytes,
        drainMs: this.options.drainMs,
        exitWaitMs: this.options.exitWaitMs,
      });
      for (const message of outputMessages(runId, outcome.stdout)) this.tell(message);
      this.tell({
        type: "exited",
        run_id: runId,
        code: outcome.exit.code,
        signal: outcome.exit.signal,
        overflow: outcome.overflow,
        stdout_bytes: outcome.overflow ? 0 : outcome.stdout.length,
      });
    } catch (error) {
      if (!spawned) this.tell({ type: "not_spawned", run_id: runId, reason: error instanceof LaunchFailed ? error.code : "spawn_failed" });
      else this.tell({ type: "unconfirmed", run_id: runId });
    } finally {
      if (this.run === run) this.run = null;
    }
  }

}

// 시험이 쓰는 실제 타이머. 원격 구현은 시계·타이머를 주입받는다.
export const realTimers = {
  setTimer(ms: number, fire: () => void): () => void {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};
