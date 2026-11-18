// 가짜 /proc과 신호 기록기. 판정 규칙 시험은 실제 프로세스에 신호를 보내지 않고 이것으로 본다.
import type { ProcReader, Signal } from "../../src/executor/containment.ts";

export interface FakeProcess {
  state?: string;
  nspid?: number[];
  // status의 PPid 칸. 없으면 PID 1의 자식으로 보인다. 0은 부모가 이 공간 밖이라는 뜻이다.
  ppid?: number;
  // 읽을 때마다 앞에서 하나씩 꺼내 쓰는 PPid(끝나는 중에 잠깐 0으로 보이는 경우).
  ppidReads?: number[];
  threads?: Record<number, string>;
  survivesTerm?: boolean;
  survivesKill?: boolean;
  statusError?: string;
  // status를 읽을 때마다 앞에서 하나씩 꺼내 쓴다. 오류 코드면 그 읽기가 실패하고, null이면 정상으로 읽는다.
  statusReads?: (string | null)[];
  threadsError?: string;
}

export const SELF = 7;

export class FakeProc implements ProcReader {
  processes = new Map<number, FakeProcess>();
  listError: string | undefined;
  signals: { pid: number; signal: Signal; targets: number }[] = [];
  killError: string | undefined;
  namespaceId = "pid:[4026531836]";
  onSignal: ((signal: Signal) => void) | undefined;
  constructor(extra: Record<number, FakeProcess> = {}) {
    this.processes.set(1, {});
    this.processes.set(SELF, {});
    for (const [pid, entry] of Object.entries(extra)) this.processes.set(Number(pid), entry);
  }
  async pids() {
    if (this.listError) throw Object.assign(new Error("list"), { code: this.listError });
    return [...this.processes.keys()];
  }
  async status(pid: number) {
    const entry = this.processes.get(pid);
    if (!entry) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    const scripted = entry.statusReads?.shift();
    if (scripted) throw Object.assign(new Error("read"), { code: scripted });
    if (entry.statusError) throw Object.assign(new Error("read"), { code: entry.statusError });
    const ppid = entry.ppidReads?.shift() ?? entry.ppid ?? 1;
    return `Name:\tx\nState:\t${entry.state ?? "S"} (x)\nPPid:\t${ppid}\nNSpid:\t${(entry.nspid ?? [pid]).join("\t")}\n`;
  }
  async threads(pid: number) {
    const error = this.processes.get(pid)?.threadsError;
    if (error) throw Object.assign(new Error("task"), { code: error });
    return Object.keys(this.processes.get(pid)?.threads ?? { [pid]: "Z" }).map(Number);
  }
  async threadStatus(pid: number, thread: number) {
    return `State:\t${this.processes.get(pid)?.threads?.[thread] ?? "Z"} (x)\n`;
  }
  namespaceError: string | undefined;
  async namespace() {
    if (this.namespaceError) throw Object.assign(new Error("ns"), { code: this.namespaceError });
    return this.namespaceId;
  }
  async selfPid() {
    return SELF;
  }
  kill = (pid: number, signal: Signal) => {
    this.signals.push({ pid, signal, targets: [...this.processes.keys()].filter((t) => t !== 1 && t !== SELF).length });
    if (this.killError) throw Object.assign(new Error("kill"), { code: this.killError });
    this.onSignal?.(signal);
    for (const [target, entry] of this.processes) {
      if (target === 1 || target === SELF) continue;
      if (signal === "SIGTERM" ? !entry.survivesTerm && !entry.survivesKill : !entry.survivesKill) this.processes.delete(target);
    }
  };
}
