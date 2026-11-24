// 역할 컨테이너의 PID 1로 도는 대리의 핵심. 제어(실행기)의 지시를 링크로 받아 역할 프로그램 하나를 띄우고, 끝내고, 남은 수를 센다.
// 대리는 서명하지 않고 키를 보지 않는다. 대리가 내는 것은 서명 없는 사실이고, 영수증은 제어가 자기 키로 낸다.
//
// 차례: harden(non-dumpable) → PID 1인지 → 정리 코어 기록(PidSpace.record, 기준은 자기뿐) → attach(링크에 hello).
// 실행은 한 번에 하나다. 실행은 start로 열리고, 프로그램이 끝난(또는 띄우지 못한) 뒤 남은 수 0을 답한 때 닫힌다.
//
// 스스로 집행(실패 쪽 닫힘): 링크가 끊기거나, 링크가 계약 밖의 말을 하거나, 열린 실행의 임대·기한이 유예를 지나도 닫히지 않으면
// 링크를 닫고 정리를 한 번 돌린 뒤 대리가 끝난다. 대리는 그 공간의 PID 1이므로 끝나면 커널이 공간의 나머지를 SIGKILL로 끝낸다.
// 그래서 정리가 멈추거나 실패해도 상한(enforceWaitMs) 뒤에는 끝난다. 끝난 뒤의 남은 수는 제어가 알 수 없다(링크 끊김 = 모름).
//
// 역할 프로그램에게서 받는 것은 stdout 바이트뿐이고 해석하지 않는다. 상한까지 모아 output 조각으로 넘긴다(해석은 제어의 일이다).
// 시계·타이머·끝내기는 주입받는다. 신호와 /proc은 PidSpace.record가 만든 정리 코어로만, 띄우기는 Launcher로만 한다.
import { limits } from "../contract/v1/index.ts";
import { PidSpace, type PidSpaceTiming, type ProcessCleanup } from "../executor/containment.ts";
import { bunLauncher, LaunchFailed, type Launcher } from "../executor/launcher.ts";
import { credentialText, type LaunchPlan } from "../executor/profile.ts";
import { makeNonDumpable } from "./dumpable.ts";
import {
  type AgentMessage,
  ControlDecoder,
  type CredentialValue,
  encodeAgent,
  type NotSpawnedReason,
  outputMessages,
  type ReceivedControl,
  type StartMessage,
} from "./link.ts";

// 대리가 스스로 끝날 때의 종료 코드. 0으로는 끝나지 않는다.
export const AGENT_EXIT = {
  link_closed: 75,
  lease_expired: 76,
  protocol: 77,
  not_hardened: 78,
  not_init: 79,
  space_unavailable: 80,
} as const;
export type AgentExitReason = keyof typeof AGENT_EXIT;

// 링크 한 개의 쓰기와 닫기. 실제 소켓은 진입점이 이어 주고, 받은 바이트는 receive로, 끊김은 linkClosed로 넘긴다.
export interface AgentTransport {
  // 쓰기에 실패하면 던진다. 대리는 그것을 링크 끊김으로 다룬다.
  write(bytes: Uint8Array): void;
  close(): void;
}

export interface AgentRuntime {
  now(): number;
  // ms 뒤에 한 번 부른다. 돌려준 함수로 취소한다.
  setTimer(ms: number, fire: () => void): () => void;
  // 대리 프로세스를 끝낸다.
  exit(code: number): void;
}

// 제품은 productionParts()를 쓴다. 시험이 가짜 정리·띄우기를 넣는 자리다.
export interface AgentParts {
  // 커널이 정한 자기 번호. 1이 아니면 끝나도 공간이 비지 않으므로 뜨지 않는다.
  readonly selfPid: number;
  // 자기를 non-dumpable로 만들고 확인까지 됐으면 true.
  harden(): boolean;
  record(): Promise<ProcessCleanup>;
  readonly launcher: Launcher;
}

export interface AgentOptions {
  drainMs?: number;
  // 중단을 보낸 뒤 프로그램의 끝을 기다리는 상한(launcher의 exitWaitMs).
  exitWaitMs?: number;
  // 열린 실행의 min(기한, 임대 끝) 뒤로 제어에게 주는 여유. 제어는 이 사이에 끝내기와 세기를 마쳐 실행을 닫는다.
  // 기본값은 제어의 끝내기·세기 상한 둘(각각 STOP_GRACE_MS + 5초)에 5초를 더했다.
  enforceGraceMs?: number;
  // 스스로 집행에서 정리를 기다리는 상한. 넘으면 정리를 기다리지 않고 끝난다(PID 1의 끝이 나머지를 끝낸다).
  enforceWaitMs?: number;
}

export function productionParts(timing: PidSpaceTiming = {}): AgentParts {
  return {
    selfPid: process.pid,
    harden: makeNonDumpable,
    record: () => PidSpace.record({ dedicated: true, ...timing }),
    launcher: bunLauncher,
  };
}

interface Run {
  readonly runId: string;
  readonly controller: AbortController;
  readonly deadline: number;
  lease: number;
  ended: boolean;
  cancelTimer: () => void;
}

export class RoleAgent {
  private readonly decoder = new ControlDecoder();
  private transport: AgentTransport | null = null;
  private run: Run | null = null;
  private closing = false;
  // 끝내기·세기는 받은 차례대로 하나씩 답한다.
  private queue: Promise<void> = Promise.resolve();
  private readonly options: Required<AgentOptions>;

  private constructor(
    private readonly space: ProcessCleanup,
    private readonly runtime: AgentRuntime,
    private readonly launcher: Launcher,
    options: AgentOptions,
  ) {
    this.options = {
      drainMs: options.drainMs ?? 200,
      exitWaitMs: options.exitWaitMs ?? limits.STOP_GRACE_MS + 5_000,
      enforceGraceMs: options.enforceGraceMs ?? 2 * (limits.STOP_GRACE_MS + 5_000) + 5_000,
      enforceWaitMs: options.enforceWaitMs ?? limits.STOP_GRACE_MS + 5_000,
    };
  }

  // 링크보다 먼저 부른다. 어느 단계든 실패하면 runtime.exit으로 끝내고 null을 돌려준다.
  // harden이 맨 앞이다: 그 앞에 띄운 것이 없어야 /proc/1의 환경·루트·메모리를 읽을 틈이 없다.
  static async prepare(runtime: AgentRuntime, parts: AgentParts, options: AgentOptions = {}): Promise<RoleAgent | null> {
    if (!parts.harden()) return exitWith(runtime, "not_hardened");
    if (parts.selfPid !== 1) return exitWith(runtime, "not_init");
    let space: ProcessCleanup;
    try {
      space = await parts.record();
    } catch {
      return exitWith(runtime, "space_unavailable");
    }
    return new RoleAgent(space, runtime, parts.launcher, options);
  }

  // 링크가 이어졌다. hello를 보낸다. 링크는 하나뿐이다(두 번째 attach는 계약 밖이다).
  // 두 번째 포트의 닫기가 던져도 첫 실행은 집행한다. 그 예외가 호출자에게 나가면 첫 링크와 실행이 그대로 남는다.
  attach(transport: AgentTransport): void {
    if (this.transport !== null) {
      try {
        transport.close();
      } catch {
        // 닫기 실패는 집행을 막지 않는다.
      }
      return this.enforce("protocol");
    }
    this.transport = transport;
    this.tell({ type: "hello" });
  }

  receive(chunk: Uint8Array): void {
    if (this.closing) return;
    // hello 전의 바이트는 디코딩하지 않는다(값 틀을 꺼내거나 띄우기를 시작하기 전에 거절).
    if (this.transport === null) return this.enforce("protocol");
    let messages: ReceivedControl[];
    try {
      messages = this.decoder.push(chunk);
    } catch {
      return this.enforce("protocol");
    }
    for (const message of messages) this.handle(message);
  }

  linkClosed(): void {
    this.enforce("link_closed");
  }

  private handle(message: ReceivedControl): void {
    if (this.closing) {
      if (message.type === "start") message.credential.discard();
      return;
    }
    switch (message.type) {
      case "start":
        if (this.run !== null) {
          message.credential.discard();
          return this.enforce("protocol");
        }
        return this.open(message);
      case "renew": {
        // 프로그램이 끝난 뒤에도 실행이 닫히기 전에는 받는다(제어가 exited를 받기 전에 보낸 갱신이 엇갈려 올 수 있다).
        const run = this.run;
        if (run === null || run.runId !== message.run_id) return this.enforce("protocol");
        // 기존 집행 시각이 지났으면 만료 콜백이 아직 돌지 않았어도 갱신으로 되살리지 않는다.
        if (this.pastCutoff(run)) return this.enforce("lease_expired");
        run.lease = message.lease_until;
        return this.arm(run);
      }
      case "terminate":
        this.run?.controller.abort();
        return this.serially(async () => {
          await this.space.terminate().catch(() => {});
          this.tell({ type: "terminated", seq: message.seq });
        });
      case "count":
        return this.serially(async () => {
          const survivors = await this.space.survivors().catch(() => null);
          // 프로그램이 끝난 실행은 0을 답한 때 닫는다. 0이 아니거나 모름이면 열린 채로 두어 임대 감시가 이어진다.
          // 세는 동안 집행 시각이 지났으면 0으로 닫지 않고 집행한다(만료 콜백보다 계수 완료가 먼저 처리될 수 있다).
          const run = this.run;
          if (survivors === 0 && run !== null && run.ended && this.pastCutoff(run)) return this.enforce("lease_expired");
          if (survivors === 0 && run !== null && run.ended) this.close(run);
          this.tell({ type: "counted", seq: message.seq, survivors });
        });
    }
  }

  private open(start: StartMessage & { readonly credential: CredentialValue }): void {
    const run: Run = {
      runId: start.run_id,
      controller: new AbortController(),
      deadline: start.deadline_at,
      lease: start.lease_until,
      ended: false,
      cancelTimer: () => {},
    };
    this.run = run;
    this.arm(run);
    const value = start.credential.take();
    let plan: LaunchPlan | null = null;
    try {
      const credential = value === null ? null : credentialText(value);
      plan = credential === null ? null : planFor(start, credential);
    } finally {
      value?.fill(0);
    }
    void this.launch(run, start, plan);
  }

  private async launch(run: Run, start: StartMessage, plan: LaunchPlan | null): Promise<void> {
    const runId = run.runId;
    const notSpawned = (reason: NotSpawnedReason) => this.ended(run, { type: "not_spawned", run_id: runId, reason });
    if (plan === null) return notSpawned("refused");
    if (this.expired(run)) return notSpawned("expired");
    // 앞 실행의 후손이 남은 공간에서는 띄우지 않는다(그 수가 이 실행의 것으로 섞인다).
    const before = await this.space.survivors().catch(() => null);
    if (before !== 0) return notSpawned("space_not_clean");
    // 세는 사이 링크·취소·기한이 바뀌었을 수 있다. 여기서 launcher의 spawn까지 await가 없다.
    if (this.closing || this.run !== run || run.controller.signal.aborted) return notSpawned("aborted");
    if (this.expired(run)) return notSpawned("expired");
    let spawned = false;
    try {
      const outcome = await this.launcher.run(plan, run.controller.signal, {
        busy: () => this.space.busy(),
        terminate: () => this.space.terminate(),
        spawned: () => {
          spawned = true;
          this.tell({ type: "spawned", run_id: runId });
        },
        outputBytes: start.output_bytes,
        drainMs: this.options.drainMs,
        exitWaitMs: this.options.exitWaitMs,
      });
      for (const message of outputMessages(runId, outcome.stdout)) this.tell(message);
      outcome.stdout.fill(0);
      this.ended(run, {
        type: "exited",
        run_id: runId,
        code: outcome.exit.code,
        signal: outcome.exit.signal,
        overflow: outcome.overflow,
        stdout_bytes: outcome.overflow ? 0 : outcome.stdout.length,
      });
    } catch (error) {
      if (!spawned) return notSpawned(error instanceof LaunchFailed ? error.code : "spawn_failed");
      // 끝을 확인하지 못했다(ExitUnconfirmed 등). 남은 수는 제어가 묻는다.
      this.ended(run, { type: "unconfirmed", run_id: runId });
    }
  }

  private ended(run: Run, message: AgentMessage): void {
    run.ended = true;
    this.tell(message);
  }

  private expired(run: Run): boolean {
    return this.runtime.now() >= Math.min(run.deadline, run.lease);
  }

  // 열린 실행의 지금 집행 시각: min(기한, 임대 끝) + 여유.
  private cutoff(run: Run): number {
    return Math.min(run.deadline, run.lease) + this.options.enforceGraceMs;
  }

  // 함정: 집행 시각이 지난 뒤에도 만료 콜백보다 다른 입력(갱신, 계수 완료)이 먼저 처리될 수 있다.
  // 실행을 바꾸거나 닫는 자리는 타이머를 믿지 않고 이것으로 다시 본다.
  private pastCutoff(run: Run): boolean {
    return this.runtime.now() >= this.cutoff(run);
  }

  // 열린 실행의 감시. min(기한, 임대 끝) + 여유가 지나도 닫히지 않으면 스스로 집행한다.
  private arm(run: Run): void {
    run.cancelTimer();
    run.cancelTimer = this.runtime.setTimer(Math.max(0, this.cutoff(run) - this.runtime.now()), () => {
      if (this.run !== run) return;
      // 타이머가 이르게 울렸으면 다시 건다. 시각은 주입한 시계로만 판단한다.
      if (!this.pastCutoff(run)) return this.arm(run);
      this.enforce("lease_expired");
    });
  }

  private close(run: Run): void {
    run.cancelTimer();
    if (this.run === run) this.run = null;
  }

  private serially(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch(() => {});
  }

  // 메서드 이름이 send가 아닌 까닭: src/의 송신 자리 목록(start-send.test.ts)은 감독 쪽 내보내기 포트의 자리다. 링크 쓰기는 그 목록 밖이다.
  private tell(message: AgentMessage): void {
    if (this.closing || this.transport === null) return;
    try {
      this.transport.write(encodeAgent(message));
    } catch {
      this.enforce("link_closed");
    }
  }

  // 한 번만 돈다. 먼저 링크를 닫아 더 말하지 않고, 실행을 멈추고, 정리를 상한까지 기다린 뒤 끝난다.
  private enforce(reason: AgentExitReason): void {
    if (this.closing) return;
    this.closing = true;
    const run = this.run;
    run?.cancelTimer();
    run?.controller.abort();
    try {
      this.transport?.close();
    } catch {
      // 닫기 실패는 끝내기를 막지 않는다.
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cancel();
      this.runtime.exit(AGENT_EXIT[reason]);
    };
    const cancel = this.runtime.setTimer(this.options.enforceWaitMs, finish);
    void this.space
      .terminate()
      .catch(() => {})
      .then(finish);
  }
}

function exitWith(runtime: AgentRuntime, reason: AgentExitReason): null {
  runtime.exit(AGENT_EXIT[reason]);
  return null;
}

// 띄울 계획은 받은 start와 자격 값으로만 만든다. 자격 값은 credential_env 하나에만 있고 다른 칸에 들어 있으면 띄우지 않는다
// (실행기의 assertLaunchSafe와 같은 규칙).
function planFor(start: StartMessage, credential: string): LaunchPlan | null {
  if ([start.program, start.cwd, ...start.argv].some((part) => part.includes(credential))) return null;
  if (Object.values(start.env).some((value) => value.includes(credential))) return null;
  return { program: start.program, argv: [...start.argv], cwd: start.cwd, env: { ...start.env, [start.credential_env]: credential } };
}
