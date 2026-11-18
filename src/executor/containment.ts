// 작업자 파드의 전용 PID 공간에서 남은 프로세스를 끝내고 세는 일.
// 전제: 실행기 컨테이너는 자기 PID namespace를 가지고 실행은 한 번에 하나다. 그 공간에서 실행기 자신과 PID 1 말고는 모두 그 실행의 것이다.
//
// 끝내는 수단은 kill(-1)이다. 커널이 호출자와 그 namespace의 init을 뺀 모든 프로세스(아래 namespace 포함)에 한 번에 신호를 보내므로
// fork가 끼어들 틈이 없고, 번호로 하나씩 보내지 않아 PID 재사용 경쟁도 없다.
// 함정: 호스트(또는 다른 프로세스와 함께 쓰는 공간)에서 kill(-1)이 나가면 그 사용자의 모든 프로세스가 끝난다.
// 그래서 record()가 기준 상태(자기와 PID 1뿐)를 확인한 공간에서만 이 객체가 생기고, 신호와 스캔마다 그 공간이 그대로인지 다시 본다.
// 실제 경로(record)는 자기 번호·/proc·신호 함수를 함께 실제 값으로 고정하고, 판정 규칙의 시험은 따로 recordWith로 가짜 셋을 함께 준다.
//
// 세는 것은 /proc/<pid>/status로 한다. environ과 달리 ptrace 검사가 없어 non-dumpable 프로세스도 읽힌다.
// NSpid 칸이 둘 이상이면 아래 PID namespace의 프로세스다. 환경을 지우거나 새 세션으로 빠져나가도 이 목록에서 숨지 못한다.
import { readdir, readFile, readlink } from "node:fs/promises";
import { limits } from "../contract/v1/index.ts";

export class ContainmentUnavailable extends Error {
  constructor(readonly code: "not_dedicated" | "proc_unreadable" | "foreign_proc" | "baseline_not_clean") {
    super(code);
  }
}

// 실행이 남긴 프로세스를 끝내고 센다. 실행기 핵심은 이 모양만 안다(시험은 가짜를 넣는다).
export interface ProcessCleanup {
  terminate(): Promise<void>;
  // 0은 확인했다는 뜻이다. 보이면 그 수, 읽지 못했거나 사라지는 항목이 멈추지 않으면 null이다.
  survivors(): Promise<number | null>;
  // 정리가 도는 중이면 true. 그동안 새 프로세스를 띄우지 않는다.
  busy(): boolean;
}

// 시험이 가짜 /proc을 넣는 자리.
export interface ProcReader {
  pids(): Promise<number[]>;
  status(pid: number): Promise<string>;
  threads(pid: number): Promise<number[]>;
  threadStatus(pid: number, thread: number): Promise<string>;
  // 자기 PID namespace의 식별(readlink /proc/<self>/ns/pid). 스캔과 신호마다 기록한 값과 같은지 본다.
  namespace(pid: number): Promise<string>;
  // 이 /proc이 가리키는 호출자 자신의 번호(readlink /proc/self). 커널이 정하므로 부르는 쪽이 고를 수 없다.
  selfPid(): Promise<number>;
}

export const procFsReader = (proc = "/proc"): ProcReader => ({
  async pids() {
    return (await readdir(proc)).filter((name) => /^\d+$/.test(name)).map(Number);
  },
  status: (pid) => readFile(`${proc}/${pid}/status`, "utf8"),
  async threads(pid) {
    return (await readdir(`${proc}/${pid}/task`)).filter((name) => /^\d+$/.test(name)).map(Number);
  },
  threadStatus: (pid, thread) => readFile(`${proc}/${pid}/task/${thread}/status`, "utf8"),
  namespace: (pid) => readlink(`${proc}/${pid}/ns/pid`),
  async selfPid() {
    const text = await readlink(`${proc}/self`);
    if (!/^\d+$/.test(text)) throw new Error("self");
    return Number(text);
  },
});

export type Signal = "SIGTERM" | "SIGKILL";

export interface PidSpaceTiming {
  graceMs?: number;
  killMs?: number;
  pollMs?: number;
  // 깨끗한 검사를 몇 번 연달아 봐야 0으로 치는지.
  confirmScans?: number;
}

// 실제 정리의 옵션. 자기 번호·/proc·신호 함수는 받지 않는다: 셋은 함께 실제 값(process.pid, /proc, process.kill)으로 고정된다.
export interface PidSpaceOptions extends PidSpaceTiming {
  // 명시 옵션. 작업자 파드의 조립만 true를 넘긴다.
  dedicated: true;
}

// 판정 규칙을 보는 시험의 경로. 가짜 /proc, 가짜 자기 번호, 신호 기록기를 반드시 함께 준다.
// 대상은 언제나 -1이다. 실제 신호 함수를 여기에 넘기는 것은 부르는 쪽의 책임이라 시험만 이 경로를 쓴다.
export interface PidSpaceProbe extends PidSpaceOptions {
  self: number;
  reader: ProcReader;
  kill: (pid: number, signal: Signal) => void;
}

export interface PidScan {
  sameNamespace: number[];
  nested: number[];
  // 읽지 못한 항목이 하나라도 있으면 false다. 그때는 0개라고 말할 수 없다.
  complete: boolean;
  // 목록에 있었는데 읽을 때 사라졌다. fork와 exit를 빠르게 되풀이하는 프로세스는 언제나 이렇게 보이므로 끝났다는 증거가 아니다.
  raced: boolean;
}

const VANISHED = new Set(["ENOENT", "ESRCH"]);
const errorCode = (error: unknown) => (error as { code?: string } | null)?.code ?? "";
const stateOf = (status: string) => /^State:\s+(\S)/m.exec(status)?.[1] ?? null;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PidSpace implements ProcessCleanup {
  private sweeping: Promise<void> | undefined;

  private constructor(
    private readonly self: number,
    private readonly reader: ProcReader,
    private readonly kill: (pid: number, signal: Signal) => void,
    private readonly namespaceId: string,
    private readonly timing: { graceMs: number; killMs: number; pollMs: number; confirmScans: number },
  ) {}

  // 실행기가 뜰 때, 자식을 띄우기 전에 한 번 부른다. 기준 상태는 자기와 PID 1뿐이다.
  // 그 밖의 프로세스가 보이거나 기준 스캔이 경합했으면 거부한다. 개발 기계나 다른 공간에서 잘못 켜도 kill(-1)이 나가지 않게 하는 확인이다.
  // 함정: 빈 순간의 프로세스 수만으로 호스트·공유 공간을 배제할 수는 없다. 이 확인은 거부 쪽으로만 믿는다.
  static async record(options: PidSpaceOptions): Promise<PidSpace> {
    if (options.dedicated !== true) throw new ContainmentUnavailable("not_dedicated");
    // 시험 경로의 칸이 섞이면 실제 신호와 가짜 관측이 짝지어질 수 있다. 실제 경로는 셋을 함께 고정한다.
    if (["self", "reader", "kill"].some((key) => key in options)) throw new ContainmentUnavailable("not_dedicated");
    return PidSpace.establish(process.pid, procFsReader(), (pid, signal) => void process.kill(pid, signal), options);
  }

  static async recordWith(options: PidSpaceProbe): Promise<PidSpace> {
    if (options.dedicated !== true || options.reader === undefined || typeof options.kill !== "function" || !Number.isSafeInteger(options.self)) {
      throw new ContainmentUnavailable("not_dedicated");
    }
    return PidSpace.establish(options.self, options.reader, options.kill, options);
  }

  private static async establish(self: number, reader: ProcReader, kill: (pid: number, signal: Signal) => void, timing: PidSpaceTiming): Promise<PidSpace> {
    let namespaceId: string;
    let kernelSelf: number;
    try {
      namespaceId = await reader.namespace(self);
      kernelSelf = await reader.selfPid();
    } catch {
      throw new ContainmentUnavailable("proc_unreadable");
    }
    if (kernelSelf !== self) throw new ContainmentUnavailable("foreign_proc");
    const space = new PidSpace(self, reader, kill, namespaceId, {
      graceMs: timing.graceMs ?? limits.STOP_GRACE_MS,
      killMs: timing.killMs ?? 2_000,
      pollMs: timing.pollMs ?? 25,
      confirmScans: timing.confirmScans ?? 3,
    });
    if (!(await space.ownProc())) throw new ContainmentUnavailable("foreign_proc");
    const scan = await space.scan();
    if (!scan.complete) throw new ContainmentUnavailable("proc_unreadable");
    if (scan.raced || scan.sameNamespace.length > 0 || scan.nested.length > 0) throw new ContainmentUnavailable("baseline_not_clean");
    return space;
  }

  // /proc이 자기 PID namespace의 것인지. 바깥 namespace의 /proc이면 NSpid가 둘 이상이고 번호도 다르다.
  private async ownProc(): Promise<boolean> {
    try {
      return /^NSpid:\s+(\d+)\s*$/m.exec(await this.reader.status(this.self))?.[1] === String(this.self);
    } catch {
      return false;
    }
  }

  // 지금 읽는 /proc이 기록한 그 PID 공간인지. 읽지 못하면 아니라고 본다.
  private async sameSpace(): Promise<boolean> {
    try {
      return (await this.reader.namespace(this.self)) === this.namespaceId && (await this.ownProc());
    } catch {
      return false;
    }
  }

  // 목록을 읽기 전과 다 읽은 뒤에 공간을 대조한다. 어느 쪽이든 다르면 그 스캔은 불완전이다(바뀐 공간이 비어 보여도 0이 아니다).
  async scan(): Promise<PidScan> {
    const result: PidScan = { sameNamespace: [], nested: [], complete: true, raced: false };
    if (!(await this.sameSpace())) return { ...result, complete: false };
    let pids: number[];
    try {
      pids = await this.reader.pids();
    } catch {
      return { ...result, complete: false };
    }
    for (const pid of pids) {
      if (pid === this.self || pid === 1) continue;
      let status: string;
      try {
        status = await this.reader.status(pid);
      } catch (error) {
        if (VANISHED.has(errorCode(error))) result.raced = true;
        else result.complete = false;
        continue;
      }
      const state = stateOf(status);
      const namespaces = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
      if (!state || !namespaces) {
        result.complete = false;
        continue;
      }
      const alive = await this.alive(pid, state);
      if (alive === null) result.complete = false;
      else if (alive === "raced") result.raced = true;
      else if (alive) (namespaces.length > 1 ? result.nested : result.sameNamespace).push(pid);
    }
    if (!(await this.sameSpace())) result.complete = false;
    return result;
  }

  // 좀비는 도는 코드가 없어 세지 않는다(실행기가 PID 1이면 고아 좀비를 회수하지 않아 남을 수 있다).
  // 단 리더 스레드만 끝난 프로세스도 Z로 보인다. 다른 스레드가 살아 있으면 코드가 돌고 있는 것이다.
  // 스레드 목록·상태가 읽는 사이 사라지면 끝났다는 증거가 아니라 경합이다("raced", 깨끗한 횟수에 넣지 않는다).
  private async alive(pid: number, state: string): Promise<boolean | null | "raced"> {
    if (state === "X" || state === "x") return false;
    if (state !== "Z") return true;
    let threads: number[];
    try {
      threads = await this.reader.threads(pid);
    } catch (error) {
      return VANISHED.has(errorCode(error)) ? "raced" : null;
    }
    let raced = false;
    for (const thread of threads) {
      try {
        const threadState = stateOf(await this.reader.threadStatus(pid, thread));
        if (threadState === null) return null;
        if (threadState !== "Z" && threadState !== "X" && threadState !== "x") return true;
      } catch (error) {
        if (!VANISHED.has(errorCode(error))) return null;
        raced = true;
      }
    }
    return raced ? "raced" : false;
  }

  // 신호마다 공간이 기록한 그대로인지 먼저 본다. namespace가 바뀌었거나 /proc이 자기 것이 아니면 보내지 않는다.
  // 대상이 없을 때의 ESRCH는 정상이다. 권한 오류 등은 삼키고 결론은 뒤의 검사가 낸다(닿지 않은 프로세스는 검사에 남는다).
  private async signal(signal: Signal): Promise<boolean> {
    if (!(await this.sameSpace())) return false;
    try {
      this.kill(-1, signal);
    } catch {
      // 위 주석
    }
    return true;
  }

  // 검사가 깨끗해 보여도 TERM·KILL을 한 번씩은 보낸다. /proc 검사는 원자적이지 않아 번호를 옮겨 다니는 프로세스를 못 볼 수 있고,
  // 원자적인 것은 kill(-1)뿐이다. 깨끗하면 유예를 기다리지 않는다.
  private async sweep(): Promise<void> {
    if (!(await this.signal("SIGTERM"))) return;
    const graceUntil = Date.now() + this.timing.graceMs;
    while (Date.now() < graceUntil) {
      if ((await this.survivors()) === 0) break;
      await sleep(this.timing.pollMs);
    }
    const killUntil = Date.now() + this.timing.killMs;
    do {
      if (!(await this.signal("SIGKILL"))) return;
      if ((await this.survivors()) === 0) return;
      await sleep(this.timing.pollMs);
    } while (Date.now() < killUntil);
  }

  // 겹쳐 불러도 한 번만 돈다(취소와 실행 뒤 정리가 함께 부른다).
  terminate(): Promise<void> {
    this.sweeping ??= this.sweep().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  busy(): boolean {
    return this.sweeping !== undefined;
  }

  async survivors(): Promise<number | null> {
    let clean = 0;
    for (let attempt = 0; attempt < this.timing.confirmScans * 4; attempt++) {
      const scan = await this.scan();
      if (!scan.complete) return null;
      const seen = scan.sameNamespace.length + scan.nested.length;
      if (seen > 0) return seen;
      clean = scan.raced ? 0 : clean + 1;
      if (clean >= this.timing.confirmScans) return 0;
      await sleep(this.timing.pollMs);
    }
    return null;
  }
}
