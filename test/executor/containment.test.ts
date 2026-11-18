// 전용 PID 공간 정리의 시험. 세 층으로 나눈다.
// - 가짜 /proc과 가짜 kill: 판정 규칙. 실제로 만들 수 없는 상황(다른 namespace만 남음, 읽기 오류, 번호를 옮겨 다님)을 본다.
// - 호스트: 진짜 /proc을 읽되 kill은 가짜다. 기준 상태 확인이 거부하는 것만 본다(신호를 보내지 않는다).
// - 실제 프로세스: bwrap --unshare-pid --unshare-user로 만든 PID namespace 안에서만 띄운다. 이 시험 프로세스의 공간은 건드리지 않는다.
//   bwrap이나 user namespace를 쓸 수 없으면 그 사례를 등록하지 않고 이유를 찍는다(이미지의 test 단계에는 bwrap이 없다).
//   OLIVE_REQUIRE_BWRAP=1이면 쓸 수 없을 때 실패한다.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ContainmentUnavailable, PidSpace, type ProcReader, type Signal } from "../../src/executor/containment.ts";

interface FakeProcess {
  state?: string;
  nspid?: number[];
  threads?: Record<number, string>;
  survivesTerm?: boolean;
  survivesKill?: boolean;
  statusError?: string;
}
const SELF = 7;
class FakeProc implements ProcReader {
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
    if (entry.statusError) throw Object.assign(new Error("read"), { code: entry.statusError });
    return `Name:\tx\nState:\t${entry.state ?? "S"} (x)\nNSpid:\t${(entry.nspid ?? [pid]).join("\t")}\n`;
  }
  async threads(pid: number) {
    return Object.keys(this.processes.get(pid)?.threads ?? { [pid]: "Z" }).map(Number);
  }
  async threadStatus(pid: number, thread: number) {
    return `State:\t${this.processes.get(pid)?.threads?.[thread] ?? "Z"} (x)\n`;
  }
  async namespace() {
    return this.namespaceId;
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
const space = (proc: FakeProc) => PidSpace.record({ dedicated: true, self: SELF, reader: proc, kill: proc.kill, graceMs: 20, killMs: 40, pollMs: 1 });
async function recorded(extra: Record<number, FakeProcess>, proc = new FakeProc()) {
  const pod = await space(proc);
  for (const [pid, entry] of Object.entries(extra)) proc.processes.set(Number(pid), entry);
  return { pod, proc };
}
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "recorded",
    (error: unknown) => (error instanceof ContainmentUnavailable ? error.code : "other"),
  );

test("격리: 명시 옵션이 없거나, 가짜 /proc에 진짜 신호를 섞거나, 기준 밖 프로세스가 보이면 기록을 거부해 kill(-1)이 나갈 수 없다", async () => {
  expect(await refusal(PidSpace.record({ dedicated: false as unknown as true, self: SELF, reader: new FakeProc(), kill: () => {} }))).toBe("not_dedicated");
  expect(await refusal(PidSpace.record({ dedicated: true, self: SELF, reader: new FakeProc() }))).toBe("not_dedicated");
  const busy = new FakeProc({ 40: {} });
  expect(await refusal(space(busy))).toBe("baseline_not_clean");
  expect(busy.signals).toEqual([]);
  expect(await refusal(space(new FakeProc({ 41: { nspid: [41, 1] } })))).toBe("baseline_not_clean");
  expect(await refusal(space(new FakeProc({ 42: { statusError: "EACCES" } })))).toBe("proc_unreadable");
  const foreign = new FakeProc();
  foreign.processes.set(SELF, { nspid: [900, SELF] });
  expect(await refusal(space(foreign))).toBe("foreign_proc");
});

test("격리(호스트): 이 머신의 PID 공간에서는 기준 상태 확인이 거부하고 신호를 보내지 않는다", async () => {
  const others = readdirSync("/proc").filter((name) => /^\d+$/.test(name) && name !== "1" && Number(name) !== process.pid);
  expect(others.length).toBeGreaterThan(0);
  const sent: { pid: number; signal: Signal }[] = [];
  expect(await refusal(PidSpace.record({ dedicated: true, kill: (pid, signal) => void sent.push({ pid, signal }) }))).toBe("baseline_not_clean");
  expect(sent).toEqual([]);
});

test("격리: 대상은 언제나 -1이고, 신호마다 기록한 namespace가 그대로인지 먼저 본다(바뀌었으면 보내지 않는다)", async () => {
  const { pod, proc } = await recorded({ 50: { survivesTerm: true }, 51: {} });
  await pod.terminate();
  expect(proc.signals.length).toBeGreaterThan(0);
  expect(proc.signals.every((s) => s.pid === -1)).toBe(true);
  const moved = await recorded({ 52: {} });
  moved.proc.namespaceId = "pid:[4026532999]";
  await moved.pod.terminate();
  expect(moved.proc.signals).toEqual([]);
  expect(await moved.pod.survivors()).toBe(1);
});

test("격리: TERM으로 끝나면 KILL 대상이 0이고, TERM을 무시하면 유예 뒤 KILL을 맞는다. 깨끗해도 TERM·KILL을 한 번씩 보낸다", async () => {
  const polite = await recorded({ 50: {} });
  await polite.pod.terminate();
  expect(polite.proc.signals.map((s) => [s.signal, s.targets])).toEqual([
    ["SIGTERM", 1],
    ["SIGKILL", 0],
  ]);
  expect(await polite.pod.survivors()).toBe(0);
  const stubborn = await recorded({ 50: { survivesTerm: true } });
  const started = Date.now();
  await stubborn.pod.terminate();
  expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  expect(stubborn.proc.signals.map((s) => [s.signal, s.targets])).toEqual([
    ["SIGTERM", 1],
    ["SIGKILL", 1],
  ]);
  expect(await stubborn.pod.survivors()).toBe(0);
  const clean = await recorded({});
  await clean.pod.terminate();
  expect(clean.proc.signals.map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
});

test("남은 프로세스 판정: 번호를 옮겨 다니면 0이라고 말하지 않고, 다른 namespace에 남으면 세고, KILL에도 남으면 그 수를 낸다", async () => {
  const hopping = await recorded({ 90: { statusError: "ESRCH", survivesKill: true } });
  expect(await hopping.pod.survivors()).toBeNull();
  const nested = await recorded({ 60: { nspid: [60, 2], survivesKill: true } });
  await nested.pod.terminate();
  expect((await nested.pod.scan()).nested).toEqual([60]);
  expect(await nested.pod.survivors()).toBe(1);
  const stuck = await recorded({ 61: { survivesKill: true } });
  await stuck.pod.terminate();
  expect(await stuck.pod.survivors()).toBe(1);
});

test("남은 프로세스 판정: 권한 오류·I/O 실패·목록 실패는 0으로 세지 않는다", async () => {
  expect(await (await recorded({ 70: { statusError: "EACCES", survivesKill: true } })).pod.survivors()).toBeNull();
  expect(await (await recorded({ 71: { statusError: "EIO" } })).pod.survivors()).toBeNull();
  const listing = await recorded({});
  listing.proc.listError = "EIO";
  expect(await listing.pod.survivors()).toBeNull();
  const denied = await recorded({ 72: {} });
  denied.proc.killError = "EPERM";
  await denied.pod.terminate();
  expect(await denied.pod.survivors()).toBe(1);
});

test("남은 프로세스 판정: 좀비는 세지 않지만 리더만 끝난 프로세스의 산 스레드는 센다", async () => {
  expect(await (await recorded({ 80: { state: "Z" } })).pod.survivors()).toBe(0);
  const leader = await recorded({ 81: { state: "Z", threads: { 81: "Z", 82: "S" } } });
  expect(await leader.pod.survivors()).toBe(1);
  await leader.pod.terminate();
  expect(await leader.pod.survivors()).toBe(0);
});

test("격리: fork 경쟁(신호 직후 새 프로세스)에도 연속으로 깨끗해질 때까지 0을 말하지 않고, 겹친 정리는 한 번만 돈다", async () => {
  const { pod, proc } = await recorded({ 100: {} });
  let spawned = 0;
  proc.onSignal = () => {
    if (spawned++ < 3) setTimeout(() => proc.processes.set(200 + spawned, { survivesTerm: true }), 0);
  };
  const first = pod.terminate();
  const second = pod.terminate();
  expect(pod.busy()).toBe(true);
  await Promise.all([first, second]);
  expect(pod.busy()).toBe(false);
  expect(spawned).toBeGreaterThanOrEqual(3);
  expect(proc.signals.filter((s) => s.signal === "SIGTERM")).toHaveLength(1);
  expect(await pod.survivors()).toBe(0);
});

// ---- 실제 프로세스(bwrap 안) ----

const HARNESS = fileURLToPath(new URL("./containment-harness.ts", import.meta.url));
const BWRAP = "/usr/bin/bwrap";
const wrap = (...command: string[]) => [
  BWRAP,
  "--unshare-pid",
  "--unshare-user",
  "--new-session",
  "--die-with-parent",
  "--dev-bind",
  "/",
  "/",
  "--proc",
  "/proc",
  "--",
  ...command,
];
function namespaceProblem(): string | null {
  if (!existsSync(BWRAP)) return "bwrap 없음(/usr/bin/bwrap)";
  const probe = wrap("/bin/sh", "-c", "echo $$");
  const result = spawnSync(probe[0]!, probe.slice(1), { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0 || result.stdout.trim() !== "2") return `bwrap PID namespace 생성 실패(status ${String(result.status)})`;
  return null;
}
const problem = namespaceProblem();

interface Counted {
  alive: number;
  zombies: number;
}
interface HarnessResult {
  pid: number;
  exit: { code: number | null; signal: string | null };
  stdoutBytes: number;
  before: Counted;
  after: Counted;
  survivors: number | null;
  late: string;
  elapsedMs: number;
  graceMs: number;
}
function runScenario<T = HarnessResult>(name: string, options: readonly string[] = []): T {
  const command = wrap(process.execPath, HARNESS, name);
  command.splice(1, 0, ...options);
  const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", timeout: 30_000 });
  expect(result.status, `${name}: ${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as T;
}

if (problem !== null) {
  console.warn(`실제 프로세스 격리 시험을 돌리지 않았다: ${problem}`);
  if (process.env.OLIVE_REQUIRE_BWRAP === "1") {
    test("실제 프로세스: bwrap을 써야 한다(OLIVE_REQUIRE_BWRAP=1)", () => {
      expect(problem).toBeNull();
    });
  }
} else {
  const LEAVES = ["background", "setsid", "doublefork", "envclear", "termignore", "stdoutholder", "forkrace", "role-leave-descendant", "role-hold-stdout"];
  for (const name of LEAVES) {
    test(`실제 프로세스 ${name}: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다`, () => {
      const result = runScenario(name);
      expect(result.pid).toBe(2);
      expect(result.before.alive, "정리 전에 살아 있는 후손이 있어야 시험이 뜻을 가진다").toBeGreaterThan(0);
      expect(result.survivors).toBe(0);
      expect(result.after.alive).toBe(0);
      expect(result.late).toBe("cleanup_busy");
      if (name === "termignore") expect(result.elapsedMs).toBeGreaterThanOrEqual(result.graceMs);
    });
  }

  test("실제 프로세스: stdout을 쥔 후손이 있어도 역할 프로그램의 끝을 기다리다 멈추지 않는다(결과를 읽는다)", () => {
    const result = runScenario("role-hold-stdout");
    expect(result.exit.code).toBe(0);
    expect(result.stdoutBytes).toBeGreaterThan(0);
  });

  for (const name of ["hang", "role-ignore-term"]) {
    test(`실제 프로세스 ${name}: 끝나지 않는(TERM을 무시하는) 역할 프로그램도 중단 뒤 0개로 확인된다`, () => {
      const result = runScenario(name);
      expect(result.exit.signal).not.toBeNull();
      expect(result.survivors).toBe(0);
      expect(result.after.alive).toBe(0);
    });
  }

  test("실제 프로세스 clean: 남은 것이 없으면 유예를 기다리지 않는다", () => {
    const result = runScenario("clean");
    expect(result.before.alive).toBe(0);
    expect(result.survivors).toBe(0);
    expect(result.elapsedMs).toBeLessThan(result.graceMs);
  });

  test("실제 프로세스: 실행기가 PID 1이어도 후손을 끝내고, 회수되지 않은 좀비는 세지 않는다", () => {
    const result = runScenario("envclear", ["--as-pid-1"]);
    expect(result.pid).toBe(1);
    expect(result.before.alive).toBeGreaterThan(0);
    expect(result.survivors).toBe(0);
    expect(result.after.alive).toBe(0);
    // Bun이 PID 1이면 고아를 회수하지 않아 좀비가 남는다. 이것이 달라지면 "좀비는 세지 않는다"를 보이는 이 사례를 다시 짠다.
    expect(result.after.zombies).toBeGreaterThan(0);
  });

  test("실제 프로세스: 이미 취소된 실행과 없는 실행 파일은 띄우지 않고, 띄운 직후의 취소도 0개로 끝난다", () => {
    const result = runScenario<{ refused: string; missing: string; raced: { signal: string | null } | null; survivors: number | null; after: Counted }>("spawnrace");
    expect(result.refused).toBe("aborted");
    expect(result.missing).toBe("spawn_failed");
    expect(result.raced?.signal).not.toBeNull();
    expect(result.survivors).toBe(0);
    expect(result.after.alive).toBe(0);
  });
}
