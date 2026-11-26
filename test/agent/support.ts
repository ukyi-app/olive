// 대리 시험의 가짜들: 주입 시계·타이머·끝내기, 링크 한 개, 정리 코어, 띄우기.
import { createHash } from "node:crypto";
import type { AgentRuntime, AgentTransport } from "../../src/agent/agent.ts";
import { type AgentMessage, AgentDecoder, type ControlMessage, encodeControl } from "../../src/agent/link.ts";
import type { ProcessCleanup } from "../../src/executor/containment.ts";
import type { Launcher, LaunchHooks, LaunchOutcome } from "../../src/executor/launcher.ts";
import type { LaunchPlan } from "../../src/executor/profile.ts";
import type { RunWorkspace } from "../../src/executor/workspace.ts";
import { encodeCredentialFrame } from "../../src/transport/framing.ts";

export const T0 = 1_800_000_000_000;
export const RUN = "11111111-2222-4333-8444-555555555555";
export const RUN2 = "66666666-7777-4888-9999-aaaaaaaaaaaa";
export const SECRET = "olive-test-credential-7d1f";
export const secretBytes = () => new TextEncoder().encode(SECRET);
export const SECRET_DIGEST = createHash("sha256").update(SECRET).digest("hex");

export function startMessage(over: Partial<Extract<ControlMessage, { type: "start" }>> = {}): Extract<ControlMessage, { type: "start" }> {
  return {
    type: "start",
    run_id: RUN,
    program: "/usr/bin/role",
    argv: ["--plan"],
    cwd: "/work",
    env: { HOME: "/work" },
    credential_env: "OLIVE_CREDENTIAL",
    credential_digest: SECRET_DIGEST,
    output_bytes: 4_096,
    deadline_at: T0 + 60_000,
    lease_until: T0 + 30_000,
    ...over,
  };
}

// 제어가 보낼 start: 봉투 틀 + 같은 실행 ID·지문의 값 틀.
export function startBytes(over: Parameters<typeof startMessage>[0] = {}, value: Uint8Array = secretBytes()): Uint8Array {
  const message = startMessage(over);
  const head = encodeControl(message);
  const credential = encodeCredentialFrame(message.run_id, message.credential_digest, value);
  if (!credential.ok) throw new Error(credential.reason);
  const both = new Uint8Array(head.length + credential.frame.length);
  both.set(head, 0);
  both.set(credential.frame, head.length);
  return both;
}

export class FakeRuntime implements AgentRuntime {
  t = T0;
  readonly exits: number[] = [];
  private readonly timers: { at: number; fire: () => void; live: boolean }[] = [];
  now = () => this.t;
  setTimer = (ms: number, fire: () => void) => {
    const timer = { at: this.t + ms, fire, live: true };
    this.timers.push(timer);
    return () => void (timer.live = false);
  };
  exit = (code: number) => void this.exits.push(code);
  advance(ms: number): void {
    this.t += ms;
    for (const timer of [...this.timers]) {
      if (timer.live && timer.at <= this.t) {
        timer.live = false;
        timer.fire();
      }
    }
  }
  liveTimers(): number {
    return this.timers.filter((timer) => timer.live).length;
  }
}

export class Wire implements AgentTransport {
  readonly written: Uint8Array[] = [];
  closed = false;
  failWrites = false;
  write(bytes: Uint8Array): void {
    if (this.failWrites) throw new Error("EPIPE");
    this.written.push(bytes);
  }
  close(): void {
    this.closed = true;
  }
  // 제어 쪽 디코더로 읽는다(차례 규칙까지 함께 본다).
  messages(): AgentMessage[] {
    const decoder = new AgentDecoder();
    return this.written.flatMap((bytes) => decoder.push(bytes));
  }
  types(): string[] {
    return this.messages().map((message) => message.type);
  }
}

export class FakeSpace implements ProcessCleanup {
  terminations = 0;
  // 차례대로 돌려줄 survivors 값. 비면 0.
  counts: (number | null)[] = [];
  countCalls = 0;
  hangTerminate = false;
  // 있으면 survivors가 이것이 풀린 뒤에 답한다(값은 부른 때 정한다). 계수가 다른 일보다 늦게 끝나는 순서를 만드는 자리.
  countGate: Promise<void> | undefined;
  terminate(): Promise<void> {
    this.terminations++;
    return this.hangTerminate ? new Promise(() => {}) : Promise.resolve();
  }
  survivors(): Promise<number | null> {
    this.countCalls++;
    const value = this.counts.length > 0 ? this.counts.shift()! : 0;
    return (this.countGate ?? Promise.resolve()).then(() => value);
  }
  busy(): boolean {
    return false;
  }
}

// 작업 공간. entries·clear가 차례대로 돌려줄 값(비면 0). Error를 넣으면 그 호출이 던진다.
export class FakeWorkspace implements RunWorkspace {
  entryCounts: (number | Error)[] = [];
  clearCounts: (number | Error)[] = [];
  entered: string[] = [];
  clears = 0;
  // clear가 돌아오기 전에 시험이 끼어드는 자리.
  clearGate: Promise<void> | undefined;
  // entries가 돌아오기 전에 시험이 끼어드는 자리.
  entriesGate: Promise<void> | undefined;
  async entries(): Promise<number> {
    await this.entriesGate;
    const next = this.entryCounts.shift() ?? 0;
    if (next instanceof Error) throw next;
    return next;
  }
  async clear(): Promise<number> {
    this.clears++;
    await this.clearGate;
    const next = this.clearCounts.shift() ?? 0;
    if (next instanceof Error) throw next;
    return next;
  }
  async enter(cwd: string): Promise<void> {
    this.entered.push(cwd);
  }
}

interface Call {
  plan: LaunchPlan;
  signal: AbortSignal;
  hooks: LaunchHooks;
  resolve(outcome: LaunchOutcome): void;
  reject(error: unknown): void;
}

export class FakeLauncher implements Launcher {
  readonly calls: Call[] = [];
  run(plan: LaunchPlan, signal: AbortSignal, hooks: LaunchHooks): Promise<LaunchOutcome> {
    return new Promise((resolve, reject) => this.calls.push({ plan, signal, hooks, resolve, reject }));
  }
  // 띄움을 알리고 끝낸다.
  finish(index: number, stdout: Uint8Array, code = 0): void {
    const call = this.calls[index]!;
    call.hooks.spawned({ pid: 7, exited: Promise.resolve(), signal: () => {} });
    call.resolve({ exit: { code, signal: null }, stdout, overflow: false });
  }
}

export const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
