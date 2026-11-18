// 전용 PID 공간에서 남은 프로세스를 끝내고 세는 알고리즘. 실제 신호 능력은 여기서 만들지 않는다.
// 제품은 containment.ts의 PidSpace.record만 부른다(자기 번호·/proc·신호 함수를 실제 값으로 묶는 자리는 거기 하나다).
// src/ 안에서 이 파일을 import하는 곳은 containment.ts 하나다(test/executor/static.test.ts). 시험은 가짜 /proc과 신호 기록기를 넘겨 판정 규칙을 본다.
//
// 코어가 스스로 증명하는 것: 신호와 스캔마다 기록한 공간이 그대로인지, 기준 상태가 자기와 PID 1뿐이었는지,
// 전체 신호 직전 스캔에 밖에서 합류한 프로세스가 보이지 않는지.
// 호출자의 보증에 기대는 것: 이 공간을 만들고 독점하는 쪽이 따로 있고, 스캔과 신호 사이에 들어온 프로세스는 없다는 것.
// 합류한 프로세스의 부모가 먼저 끝나 공간의 init 밑으로 옮겨지면 PPid 0이 사라지므로 이 검사로는 보이지 않는다.
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

// 정리가 쓰는 자기 번호·/proc·신호 함수. 대상은 언제나 -1이다.
export interface SweepBackend {
  self: number;
  reader: ProcReader;
  kill: (pid: number, signal: Signal) => void;
}

export interface PidScan {
  sameNamespace: number[];
  nested: number[];
  // 부모가 이 공간 밖인 프로세스(이 공간의 init과 자기 말고). 밖에서 합류한 것이다.
  foreign: number[];
  // 읽지 못한 항목이 하나라도 있으면 false다. 그때는 0개라고 말할 수 없다.
  complete: boolean;
  // 목록에 있었는데 읽을 때 사라졌다. fork와 exit를 빠르게 되풀이하는 프로세스는 언제나 이렇게 보이므로 끝났다는 증거가 아니다.
  raced: boolean;
}

const VANISHED = new Set(["ENOENT", "ESRCH"]);
const errorCode = (error: unknown) => (error as { code?: string } | null)?.code ?? "";
const stateOf = (status: string) => /^State:\s+(\S)/m.exec(status)?.[1] ?? null;
const parentOf = (status: string) => /^PPid:\s+(\d+)/m.exec(status)?.[1] ?? null;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PidSweep implements ProcessCleanup {
  private sweeping: Promise<void> | undefined;
  // 밖에서 합류한 프로세스를 한 번이라도 봤다. 이 공간은 더는 전용이 아니므로 다시 신호를 보내지 않고 0도 말하지 않는다.
  private shared = false;

  private constructor(
    private readonly self: number,
    private readonly reader: ProcReader,
    private readonly kill: (pid: number, signal: Signal) => void,
    private readonly namespaceId: string,
    private readonly timing: { graceMs: number; killMs: number; pollMs: number; confirmScans: number },
  ) {}

  // 기준 상태는 자기와 PID 1뿐이다. 그 밖의 프로세스가 보이거나 기준 스캔이 경합했으면 거부한다.
  // 함정: 빈 순간의 프로세스 수만으로 호스트·공유 공간을 배제할 수는 없다. 이 확인은 거부 쪽으로만 믿는다.
  static async establish(backend: SweepBackend, timing: PidSpaceTiming = {}): Promise<PidSweep> {
    const { self, reader, kill } = backend;
    if (reader === undefined || typeof kill !== "function" || !Number.isSafeInteger(self)) throw new ContainmentUnavailable("not_dedicated");
    let namespaceId: string;
    let kernelSelf: number;
    try {
      namespaceId = await reader.namespace(self);
      kernelSelf = await reader.selfPid();
    } catch {
      throw new ContainmentUnavailable("proc_unreadable");
    }
    if (kernelSelf !== self) throw new ContainmentUnavailable("foreign_proc");
    const space = new PidSweep(self, reader, kill, namespaceId, {
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
    const result: PidScan = { sameNamespace: [], nested: [], foreign: [], complete: true, raced: false };
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
      else if (alive) {
        (namespaces.length > 1 ? result.nested : result.sameNamespace).push(pid);
        if (await this.joinedFromOutside(pid, status)) result.foreign.push(pid);
      }
    }
    if (!(await this.sameSpace())) result.complete = false;
    return result;
  }

  // 부모가 이 공간에 없으면 커널은 PPid를 0으로 보여 준다. 이 공간의 init 말고 그런 프로세스는 밖에서 합류한 것이다.
  // 끝나는 중인 프로세스도 잠깐 0으로 보일 수 있어 한 번 더 읽어 같을 때만 친다.
  private async joinedFromOutside(pid: number, status: string): Promise<boolean> {
    if (parentOf(status) !== "0") return false;
    try {
      const again = await this.reader.status(pid);
      const state = stateOf(again);
      return parentOf(again) === "0" && state !== "Z" && state !== "X" && state !== "x";
    } catch {
      return false;
    }
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
  // 밖에서 합류한 프로세스가 보이면 그 공간은 전용이 아니므로 보내지 않고, 다시는 보내지 않는다. 스캔이 불완전한 것만으로는 막지 않는다
  // (fork 연쇄는 언제나 경합으로 보이는데, 그것을 끝낼 수단이 이 신호다).
  // 대상이 없을 때의 ESRCH는 정상이다. 권한 오류 등은 삼키고 결론은 뒤의 검사가 낸다(닿지 않은 프로세스는 검사에 남는다).
  private async signal(signal: Signal): Promise<boolean> {
    if (this.shared || !(await this.sameSpace())) return false;
    if ((await this.scan()).foreign.length > 0) {
      this.shared = true;
      return false;
    }
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
      if (scan.foreign.length > 0) this.shared = true;
      if (this.shared || !scan.complete) return null;
      const seen = scan.sameNamespace.length + scan.nested.length;
      if (seen > 0) return seen;
      clean = scan.raced ? 0 : clean + 1;
      if (clean >= this.timing.confirmScans) return 0;
      await sleep(this.timing.pollMs);
    }
    return null;
  }
}
