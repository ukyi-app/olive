// 역할 프로그램 하나를 띄우고 끝날 때까지 본다. 계획(LaunchPlan)은 프로필에서만 만든다(profile.ts).
// 끝내는 일은 여기서 하지 않는다. 중단되면 부르는 쪽이 준 terminate(전용 PID 공간 전체 정리)를 부르고, 남은 수는 부르는 쪽이 센다.
// Bun.spawn은 env를 주면 그 객체만 넘긴다(부모 환경과 섞지 않는다). 시험이 띄운 프로그램이 받은 환경을 그대로 대조한다.
import type { LaunchPlan } from "./profile.ts";

// 프로세스가 생기기 전에 끝났다(이미 중단됨, 정리 중, 실행 파일·작업 폴더 없음).
export class LaunchFailed extends Error {
  constructor(readonly code: "aborted" | "cleanup_busy" | "spawn_failed") {
    super(code);
  }
}

export interface LaunchOutcome {
  exit: { code: number | null; signal: string | null };
  stdout: Uint8Array;
  overflow: boolean;
}

export interface LaunchHooks {
  // 정리가 도는 중이면 true. 그동안에는 띄우지 않는다.
  busy(): boolean;
  // 중단·상한 초과 때 부른다.
  terminate(): Promise<void>;
  // 프로세스가 생긴 직후(첫 await 전) 한 번 부른다.
  spawned(pid: number): void;
  outputBytes: number;
  // 프로그램이 끝난 뒤 stdout이 닫히기를 기다리는 시간. 후손이 stdout을 쥐고 있으면 닫히지 않는다.
  drainMs?: number;
}

export interface Launcher {
  run(plan: LaunchPlan, signal: AbortSignal, hooks: LaunchHooks): Promise<LaunchOutcome>;
}

// 확인과 spawn 사이에 await가 없다. 부르는 쪽의 "띄우기 직전 확인"도 이 함수를 부르기 바로 앞에서 await 없이 한다.
export const bunLauncher: Launcher = {
  async run(plan, signal, hooks) {
    if (signal.aborted) throw new LaunchFailed("aborted");
    if (hooks.busy()) throw new LaunchFailed("cleanup_busy");
    let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">>;
    try {
      child = Bun.spawn([plan.program, ...plan.argv], {
        cwd: plan.cwd,
        env: { ...plan.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      throw new LaunchFailed("spawn_failed");
    }
    hooks.spawned(child.pid);
    let overflow: boolean = false as boolean;
    const stop = () => void hooks.terminate().catch(() => {});
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = child.stdout.getReader();
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (overflow) continue;
        total += value.byteLength;
        if (total > hooks.outputBytes) {
          overflow = true;
          chunks.length = 0;
          stop();
        } else chunks.push(value);
      }
    })().catch(() => {});
    try {
      await child.exited;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([reading, new Promise<void>((resolve) => (timer = setTimeout(resolve, hooks.drainMs ?? 200)))]);
      clearTimeout(timer);
      const stdout = new Uint8Array(overflow ? 0 : total);
      let offset = 0;
      if (!overflow) for (const chunk of chunks) stdout.set(chunk, (offset += chunk.byteLength) - chunk.byteLength);
      const killedBy = child.signalCode;
      return { exit: { code: child.exitCode, signal: killedBy === null ? null : String(killedBy) }, stdout, overflow };
    } finally {
      signal.removeEventListener("abort", stop);
      await reader.cancel().catch(() => {});
    }
  },
};
