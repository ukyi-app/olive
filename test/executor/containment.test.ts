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
import { ContainmentUnavailable, PidSpace, type ProcReader, procFsReader, type Signal } from "../../src/executor/containment.ts";

interface FakeProcess {
  state?: string;
  nspid?: number[];
  threads?: Record<number, string>;
  survivesTerm?: boolean;
  survivesKill?: boolean;
  statusError?: string;
  threadsError?: string;
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
const space = (proc: FakeProc) => PidSpace.recordWith({ dedicated: true, self: SELF, reader: proc, kill: proc.kill, graceMs: 20, killMs: 40, pollMs: 1 });
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

test("격리: 명시 옵션이 없거나, 실제 경로에 가짜 /proc·번호·신호를 섞거나, 기준 밖 프로세스가 보이면 기록을 거부해 kill(-1)이 나갈 수 없다", async () => {
  const fake = new FakeProc();
  expect(await refusal(PidSpace.recordWith({ dedicated: false as unknown as true, self: SELF, reader: fake, kill: fake.kill }))).toBe("not_dedicated");
  // 실제 경로는 자기 번호·/proc·신호 함수를 받지 않는다(가짜 관측과 실제 신호의 짝, 실제 /proc과 가짜 신호의 짝 모두).
  for (const mixed of [{ self: SELF }, { reader: fake }, { kill: fake.kill }, { reader: fake, kill: fake.kill }]) {
    expect(await refusal(PidSpace.record({ dedicated: true, ...mixed } as never))).toBe("not_dedicated");
  }
  // 시험 경로는 셋을 함께 받아야 한다.
  expect(await refusal(PidSpace.recordWith({ dedicated: true, self: SELF, reader: fake } as never))).toBe("not_dedicated");
  // 커널이 가리키는 자기 번호(/proc/self)가 준 번호와 다르면 거부한다.
  const liar = new FakeProc();
  liar.selfPid = async () => SELF + 1;
  expect(await refusal(space(liar))).toBe("foreign_proc");
  expect(fake.signals).toEqual([]);
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
  // 실제 /proc을 읽되 신호는 기록기다(시험 경로). 실제 경로(record)는 같은 확인으로 거부되며, 이 시험에서는 부르지 않는다.
  const probe = { dedicated: true as const, self: process.pid, reader: procFsReader(), kill: (pid: number, signal: Signal) => void sent.push({ pid, signal }) };
  expect(await refusal(PidSpace.recordWith(probe))).toBe("baseline_not_clean");
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
  // 바뀐 공간의 관측은 그 수가 아니라 "모름"이다.
  expect(await moved.pod.survivors()).toBeNull();
});

test("남은 프로세스 판정: 기록한 PID 공간을 다시 볼 수 없으면 바뀐 공간이 비어 보여도 0이라고 말하지 않는다", async () => {
  // 공간이 바뀌고 새 /proc에는 자기와 PID 1만 보인다.
  const moved = await recorded({ 52: {} });
  moved.proc.namespaceId = "pid:[4026532999]";
  moved.proc.processes.delete(52);
  await moved.pod.terminate();
  expect(moved.proc.signals).toEqual([]);
  expect(await moved.pod.survivors()).toBeNull();
  // 공간 식별을 읽지 못한다.
  const unreadable = await recorded({});
  unreadable.proc.namespaceError = "EACCES";
  expect(await unreadable.pod.survivors()).toBeNull();
  // 좀비 리더의 스레드 목록이 읽는 사이 사라진다: 끝났다는 증거가 아니라 경합이다.
  const leader = await recorded({ 83: { state: "Z", threadsError: "ENOENT" } });
  expect(await leader.pod.survivors()).toBeNull();
});

test("격리: 기준 스캔이 경합했으면(목록의 항목이 읽기 전에 사라짐) 전용 공간으로 기록하지 않는다", async () => {
  const racing = new FakeProc({ 43: { statusError: "ESRCH" } });
  expect(await refusal(space(racing))).toBe("baseline_not_clean");
  expect(racing.signals).toEqual([]);
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
  zombieLeaders: number;
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
  witnessBefore: boolean | null;
  witnessAfter: boolean | null;
}
// harness는 이 표식(--setenv)이 있고 bwrap의 공간 안일 때만 실제 신호를 쓴다.
const MARK = ["--setenv", "OLIVE_CONTAINMENT_HARNESS", "1"];
function runHarness(name: string, options: readonly string[]) {
  const command = wrap(process.execPath, HARNESS, name);
  command.splice(1, 0, ...options);
  return spawnSync(command[0]!, command.slice(1), { encoding: "utf8", timeout: 30_000 });
}
function runScenario<T = HarnessResult>(name: string, options: readonly string[] = []): T {
  const result = runHarness(name, [...MARK, ...options]);
  expect(result.status, `${name}: ${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as T;
}
const HAS_PYTHON = existsSync("/usr/bin/python3");

if (problem !== null) {
  console.warn(`실제 프로세스 격리 시험을 돌리지 않았다: ${problem}`);
  if (process.env.OLIVE_REQUIRE_BWRAP === "1") {
    test("실제 프로세스: bwrap을 써야 한다(OLIVE_REQUIRE_BWRAP=1)", () => {
      expect(problem).toBeNull();
    });
  }
} else {
  test("실제 프로세스: harness는 bwrap의 표식이 없으면 실제 신호 없이 거부하고 끝난다(밖에서 직접 띄운 경우의 확인)", () => {
    // 이 사례도 bwrap 안에서만 띄운다. 표식만 빼서 harness의 자기 확인이 거부하는 것을 본다.
    const result = runHarness("clean", []);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ error: "not_inside_bwrap" });
  });

  const PYTHON_CASES = new Set(["nondumpable", "zombieleader", "tighthop"]);
  if (!HAS_PYTHON) console.warn(`python3 없음(/usr/bin/python3): ${[...PYTHON_CASES].join(", ")} 사례를 돌리지 않았다`);
  const LEAVES = [
    "background",
    "setsid",
    "doublefork",
    "envclear",
    "termignore",
    "nohup",
    "stdoutholder",
    "forkrace",
    "latespawn",
    "nondumpable",
    "zombieleader",
    "role-leave-descendant",
    "role-hold-stdout",
  ].filter((name) => HAS_PYTHON || !PYTHON_CASES.has(name));
  for (const name of LEAVES) {
    test(`실제 프로세스 ${name}: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다`, () => {
      const result = runScenario(name);
      expect(result.pid).toBe(2);
      expect(result.before.alive, "정리 전에 살아 있는 후손이 있어야 시험이 뜻을 가진다").toBeGreaterThan(0);
      expect(result.survivors).toBe(0);
      expect(result.after.alive).toBe(0);
      expect(result.late).toBe("cleanup_busy");
      if (name === "termignore") expect(result.elapsedMs).toBeGreaterThanOrEqual(result.graceMs);
      // 독립 계수기가 리더만 끝나고 스레드가 도는 프로세스를 실제로 보았다.
      if (name === "zombieleader") expect(result.before.zombieLeaders, "리더만 끝난 상태를 만들지 못했다").toBeGreaterThan(0);
    });
  }

  // 번호를 옮겨 다니는 자식은 /proc 검사로 셀 수 없어 살아 있음을 파일로 본다. 정리 전에 늘다가 정리 뒤 멈춰야 한다.
  for (const name of ["pidhop", "tighthop"].filter((n) => HAS_PYTHON || !PYTHON_CASES.has(n))) {
    test(`실제 프로세스 ${name}: 검사에 안 잡혀도 kill(-1)이 끝낸다(파일 증인)`, () => {
      const result = runScenario(name);
      expect(result.witnessBefore, "정리 전에 자식이 돌고 있어야 시험이 뜻을 가진다").toBe(true);
      expect(result.witnessAfter, "정리 뒤에도 자식이 돈다").toBe(false);
      expect(result.survivors).toBe(0);
      expect(result.after.alive).toBe(0);
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
    const result = runScenario<{
      refused: string;
      missing: string;
      spawnedBeforeRace: number;
      spawned: number;
      raced: { code: number | null; signal: string | null } | null;
      survivors: number | null;
      after: Counted;
    }>("spawnrace");
    expect(result.refused).toBe("aborted");
    expect(result.missing).toBe("spawn_failed");
    // 시작 직후 취소가 실제로 일어났다: 앞의 둘은 띄우지 않았고, 경합 사례는 한 번 띄워 신호로 끝났다.
    expect(result.spawnedBeforeRace).toBe(0);
    expect(result.spawned).toBe(1);
    expect(result.raced).not.toBeNull();
    expect(["SIGTERM", "SIGKILL"]).toContain(result.raced!.signal!);
    expect(result.survivors).toBe(0);
    expect(result.after.alive).toBe(0);
  });
}
