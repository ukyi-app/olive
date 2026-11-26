// 전용 PID 공간 정리의 시험. 세 층으로 나눈다.
// - 가짜 /proc과 가짜 kill: 판정 규칙. 실제로 만들 수 없는 상황(다른 namespace만 남음, 읽기 오류, 번호를 옮겨 다님)을 본다.
// - 호스트: 진짜 /proc을 읽되 kill은 가짜다. 기준 상태 확인이 거부하는 것만 본다(신호를 보내지 않는다).
// - 실제 프로세스: bwrap --unshare-pid --unshare-user로 만든 PID namespace 안에서만 띄운다. 이 시험 프로세스의 공간은 건드리지 않는다.
//   bwrap이나 user namespace를 쓸 수 없으면 그 사례를 등록하지 않고 이유를 찍는다(이미지의 test 단계에는 bwrap이 없다).
//   OLIVE_REQUIRE_BWRAP=1이면 쓸 수 없을 때 실패한다.
import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { PidSweep } from "../../src/executor/containment-core.ts";
import { checkRecordOptions, ContainmentUnavailable, PidSpace, procFsReader, type Signal } from "../../src/executor/containment.ts";
import { EXECUTOR_EXIT } from "../../src/executor/runtime.ts";
import { ExecutorStore } from "../../src/executor/store.ts";
import { GENERATION_TARGET } from "../../src/main/agent-install.ts";
import { makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../transport/certs.ts";
import { FakeProc, type FakeProcess, SELF } from "./fake-proc.ts";
import { executorKeys, onDiskEvents, onDiskRun, POD_UID, supervisorKeys, T0 } from "./support.ts";

const space = (proc: FakeProc) => PidSweep.establish({ self: SELF, reader: proc, kill: proc.kill }, { graceMs: 20, killMs: 40, pollMs: 1 });
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
  // 실제 경로는 자기 번호·/proc·신호 함수를 받지 않는다(가짜 관측과 실제 신호의 짝, 실제 /proc과 가짜 신호의 짝 모두).
  for (const mixed of [{ self: SELF }, { reader: fake }, { kill: fake.kill }, { reader: fake, kill: fake.kill }]) {
    expect(await refusal(PidSpace.record({ dedicated: true, ...mixed } as never))).toBe("not_dedicated");
  }
  // 시험 경로는 셋을 함께 받아야 한다.
  expect(await refusal(PidSweep.establish({ self: SELF, reader: fake } as never))).toBe("not_dedicated");
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

test("격리: 제품 옵션의 필수 조건은 실제 신호 능력을 만들지 않고 따로 본다(dedicated가 true가 아니면 그것만으로 거절)", () => {
  const refused = (options: unknown) => {
    try {
      checkRecordOptions(options as never);
      return "passed";
    } catch (error) {
      return error instanceof ContainmentUnavailable ? error.code : "other";
    }
  };
  expect(refused({ dedicated: true })).toBe("passed");
  expect(refused({ dedicated: true, graceMs: 10 })).toBe("passed");
  // 주입 칸이 없는 입력에서 dedicated만 틀렸다.
  for (const dedicated of [false, undefined, 1, "true"]) expect(refused({ dedicated }), String(dedicated)).toBe("not_dedicated");
  expect(refused({})).toBe("not_dedicated");
  // dedicated가 맞아도 주입 칸이 하나라도 있으면 거절한다.
  for (const key of ["self", "reader", "kill"]) expect(refused({ dedicated: true, [key]: undefined }), key).toBe("not_dedicated");
});

test("격리(호스트): 이 머신의 PID 공간에서는 기준 상태 확인이 거부하고 신호를 보내지 않는다", async () => {
  const others = readdirSync("/proc").filter((name) => /^\d+$/.test(name) && name !== "1" && Number(name) !== process.pid);
  expect(others.length).toBeGreaterThan(0);
  const sent: { pid: number; signal: Signal }[] = [];
  // 실제 /proc을 읽되 신호는 기록기다(시험 경로). 실제 경로(record)는 같은 확인으로 거부되며, 이 시험에서는 부르지 않는다.
  const probe = { self: process.pid, reader: procFsReader(), kill: (pid: number, signal: Signal) => void sent.push({ pid, signal }) };
  expect(await refusal(PidSweep.establish(probe))).toBe("baseline_not_clean");
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
const NSENTER = "/usr/bin/nsenter";
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
  attestBefore: string | null;
  attestAfter: string | null;
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
      // TERM을 받은 뒤에 새 후손이 실제로 돌기 시작했고(그 후손이 직접 적은 증인 파일), 그래서 유예를 다 쓰고 KILL로 끝났다.
      if (name === "latespawn") {
        expect(result.attestBefore, "TERM 전에는 새 후손이 없어야 한다").toBe("");
        expect(result.attestAfter, "TERM 처리 중 새 후손이 실행되지 않았다").toContain("spawned");
        expect(result.elapsedMs).toBeGreaterThanOrEqual(result.graceMs);
      }
      // 프로세스 자신이 prctl의 성공과 읽어 본 값을 증인 파일에 적었다.
      if (name === "nondumpable") expect(result.attestBefore, "non-dumpable 속성을 설정하지 못했다").toBe("nondumpable");
    });
  }

  const HAS_NSENTER = existsSync(NSENTER);
  if (!HAS_NSENTER) console.warn(`nsenter 없음(${NSENTER}): foreign 사례를 돌리지 않았다`);
  if (HAS_NSENTER) {
    test("실제 프로세스 foreign: 공간 밖에서 합류한 프로세스가 보이면 전체 신호를 보내지 않아 후손이 살아남고 0도 말하지 않는다", async () => {
      const ready = join(mkdtempSync(join(tmpdir(), "olive-foreign-")), "ready");
      const command = wrap(process.execPath, HARNESS, "foreign");
      command.splice(1, 0, ...MARK, "--setenv", "OLIVE_FOREIGN_READY", ready);
      const sandbox = spawn(command[0]!, command.slice(1), { stdio: ["ignore", "pipe", "inherit"] });
      let stdout = "";
      sandbox.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      const finished = new Promise<number | null>((resolve) => sandbox.once("close", resolve));
      // harness가 기준을 기록한 뒤에 합류시킨다. 밖의 bwrap이 띄운 자식이 그 공간의 init이다.
      const limit = Date.now() + 10_000;
      while (!existsSync(ready) && Date.now() < limit) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(existsSync(ready), `harness가 준비되지 않았다: ${stdout}`).toBe(true);
      const childPid = Number(readFileSync(`/proc/${sandbox.pid}/task/${sandbox.pid}/children`, "utf8").trim().split(/\s+/)[0]);
      expect(childPid).toBeGreaterThan(0);
      // 합류한 프로세스는 공간의 init이 끝나면 커널이 함께 끝낸다. 여기서는 신호를 보내지 않는다.
      const joiner = spawn(NSENTER, ["-t", String(childPid), "-U", "-p", "--preserve-credentials", "--", "/usr/bin/sleep", "20"], { stdio: "ignore" });
      // 공간이 끝나면 두 자식이 비슷한 때에 닫힌다. 지나간 이벤트를 기다리지 않게 띄운 직후에 받아 둔다.
      const joinerClosed = new Promise((resolve) => joiner.once("close", resolve));
      const code = await finished;
      await joinerClosed;
      expect(code, stdout).toBe(0);
      const result = JSON.parse(stdout) as { joined: number; before: Counted; after: Counted; survivors: number | null };
      expect(result.joined, "합류한 프로세스를 보지 못했다").toBeGreaterThan(0);
      expect(result.survivors).toBeNull();
      expect(result.before.alive).toBeGreaterThanOrEqual(2);
      expect(result.after.alive).toBe(result.before.alive);
    }, 30_000);
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

  // ---- 대리(src/agent)가 공간의 PID 1이다(--as-pid-1). harness 안의 가짜 제어가 링크 바이트로만 지시한다 ----
  interface AgentResult {
    pid: number;
    exited: { code: number | null; signal: string | null };
    stdout: string;
    before: Counted;
    after: Counted;
    survivors: number | null;
    beforeHarden: string | null;
  }
  const AS_PID_1 = ["--as-pid-1"];
  const fileGrowing = async (path: string) => {
    const before = Bun.file(path).size;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return Bun.file(path).size > before;
  };

  for (const scenario of ["setsid", "doublefork", "termignore"]) {
    test(`실제 프로세스 대리 ${scenario}: PID 1 대리가 띄운 역할의 후손이 있다가 끝내기 뒤 대리가 남은 수 0을 답하고 독립 계수도 0이다`, () => {
      const result = runScenario<AgentResult>(`agent-${scenario}`, AS_PID_1);
      expect(result.pid).toBe(1);
      expect(result.before.alive, "끝내기 전에 살아 있는 후손이 있어야 시험이 뜻을 가진다").toBeGreaterThan(0);
      expect(result.survivors).toBe(0);
      expect(result.after.alive).toBe(0);
    });
  }

  test("실제 프로세스 대리 signals: 자식이 PID 1 대리에게 KILL·TERM·INT·HUP을 보내도 대리가 살아 끝내기·세기에 답한다", () => {
    const result = runScenario<AgentResult>("agent-signals", AS_PID_1);
    expect(result.pid).toBe(1);
    expect(result.exited.code).toBe(0);
    // kill은 성공을 돌려주지만 공간의 init에는 닿지 않는다.
    expect(result.stdout).toBe("KILL=0\nTERM=0\nINT=0\nHUP=0\n");
    expect(result.survivors).toBe(0);
    expect(result.after.alive).toBe(0);
  });

  test("실제 프로세스 대리 linkdrop: 링크가 끊기면 대리가 link_closed 코드로 끝나고, TERM을 무시하던 후손도 함께 끝난다(파일 증인)", async () => {
    const result = runHarness("agent-linkdrop", [...MARK, ...AS_PID_1]);
    // 75 = AGENT_EXIT.link_closed
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(75);
    const report = JSON.parse(result.stdout.trim().split("\n")[0]!) as { pid: number; before: Counted; witnessBefore: boolean; witness: string };
    expect(report.pid).toBe(1);
    expect(report.before.alive).toBeGreaterThan(0);
    expect(report.witnessBefore, "끊기 전에 후손이 증인 파일을 늘리고 있어야 한다").toBe(true);
    expect(await fileGrowing(report.witness), "대리가 끝난 뒤에도 후손이 돈다").toBe(false);
  });

  test("실제 프로세스 대리 cleanfiles: 실제 역할이 작업 공간에 쓴 파일을 끝내기·세기(0) 뒤 링크 clean이 모두 지워 left 0을 답하고, 대리와 따로 본 폴더도 비었다", () => {
    // 역할의 링크가 가리킬 작업 공간 밖 형제 폴더와 표식 파일. 이 공간은 호스트 루트를 쓰기 가능하게 보므로 링크 대상을 이 시험의 것으로 한정한다.
    const outside = mkdtempSync(join(tmpdir(), "olive-agent-outside-"));
    writeFileSync(join(outside, "keep"), "outside");
    const result = runScenario<AgentResult & { workspace: string; written: number; left: number | null; remaining: number }>("agent-cleanfiles", [
      "--setenv",
      "OLIVE_CLEAN_OUTSIDE",
      outside,
      ...AS_PID_1,
    ]);
    expect(result.pid).toBe(1);
    expect(result.exited.code).toBe(0);
    expect(result.survivors).toBe(0);
    // work·home 아래 12개(숨김 파일, 깊은 폴더, 루트 밖 링크, UTF-8이 아닌 이름, HOME의 자격 파일). 써야 시험이 뜻을 가진다.
    expect(result.written).toBe(12);
    // 정리는 링크 자신만 지우고 대상 폴더 안은 건드리지 않는다.
    expect(readdirSync(outside)).toEqual(["keep"]);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
    expect(result.left).toBe(0);
    expect(result.remaining).toBe(0);
    // 공간 밖(이 시험 프로세스)에서도 따로 본다. 루트(마운트 지점 자리)는 남는다.
    expect(readdirSync(result.workspace)).toEqual([]);
  });

  test("실제 프로세스 대리 nondumpable: 대리가 뜬 뒤에는 같은 uid의 자식이 /proc/1/environ·/proc/1/root를 읽지 못한다(뜨기 전에는 읽었다)", () => {
    const result = runScenario<AgentResult>("agent-nondumpable", AS_PID_1);
    expect(result.pid).toBe(1);
    expect(result.beforeHarden, "대조군: 뜨기 전에는 읽혀야 시험이 뜻을 가진다").toBe("environ=0\nroot=0\n");
    expect(result.stdout).toMatch(/^environ=[1-9]\d*\nroot=[1-9]\d*\n$/);
    expect(result.survivors).toBe(0);
  });

  // 회복(D-104)의 제어 진입점을 실제 프로세스로 띄운다. 세대 표식의 고정 경로(/opt 아래)는 bwrap이 이 사례의 폴더를 붙인 것이다.
  // 이 진입점은 신호를 보내지 않는다(정리는 원격이다). 끝내는 것은 시험이 띄운 bwrap 자식 하나뿐이고 --die-with-parent가 안을 거둔다.
  test("실제 프로세스 회복: 제어 진입점은 세대 표식이 요청 때와 같으면 닫지 않고 94로 끝나고, 표식이 바뀐 뒤 다시 띄우면 요청의 실행을 남은 0으로 닫고 요청을 지운다", async () => {
    const root = mkdtempSync(join(tmpdir(), "olive-restart-"));
    const pki = makePki();
    const leaf = pki.executor();
    for (const sub of ["store", "tls", "trust", "link", "generation"]) mkdirSync(join(root, sub));
    const pem = (key: { export(options: { type: "pkcs8" | "spki"; format: "pem" }): string | Buffer }, type: "pkcs8" | "spki") => String(key.export({ type, format: "pem" }));
    writeFileSync(join(root, "profile.json"), JSON.stringify({ role: "diagnosis", revision: "profile-r1", program: "/usr/bin/true", argv: [], cwd: "/tmp", env: {}, credentialEnv: "OLIVE_CREDENTIAL" }));
    writeFileSync(join(root, "signing.pem"), pem(executorKeys.privateKey, "pkcs8"));
    writeFileSync(join(root, "trust", "supervisor-signing.pub"), pem(supervisorKeys.publicKey, "spki"));
    writeFileSync(join(root, "trust", "ca-bundle.pem"), pki.ca.pem);
    writeFileSync(join(root, "tls", "tls.crt"), leaf.pem);
    writeFileSync(join(root, "tls", "tls.key"), leaf.keyPem);
    // 끝을 맺지 못한 실행 하나와 그 회복 요청(표식 A).
    const storeDir = join(root, "store");
    const seeded = await ExecutorStore.open(storeDir, { now: () => T0 });
    await seeded.adoptStopGeneration(0);
    const run = randomUUID();
    const accepted = randomUUID();
    const instruction = randomUUID();
    const window = { start_stop_generation: 0, instruction_request_id: instruction, deadline_at: T0 + 600_000, lease_until: T0 + 30_000, credential_digest: "0".repeat(64) };
    expect(await seeded.beginRun({ run_id: run, run_generation: 1, state: "preparing", ...window, exit: null, last_receipt_id: null })).toBe(true);
    const body = { receipt_id: accepted, run_id: run, instruction_request_id: instruction, instruction: "task_start" };
    expect((await seeded.commit(run, { state: "unknown_running", exit: "failed", last_receipt_id: accepted }, [{ entry: { action: "receipt_accepted", id: accepted, run_id: run, run_generation: 1, acked: false, body } }])).saved).toBe(true);
    const markerA = "a".repeat(64);
    await seeded.writeRestartRequest({ marker: markerA, runs: [run] });
    writeFileSync(join(root, "generation", "marker"), markerA);

    const entry = fileURLToPath(new URL("../../src/main/executor.ts", import.meta.url));
    const command = wrap(process.execPath, entry);
    command.splice(command.indexOf("--"), 0, "--tmpfs", "/opt", "--bind", join(root, "generation"), GENERATION_TARGET.slice(0, GENERATION_TARGET.lastIndexOf("/")));
    const env = {
      PATH: process.env.PATH ?? "",
      OLIVE_ROLE: "diagnosis",
      OLIVE_INSTANCE: "worker-1",
      OLIVE_POLICY_REVISION: "policy-r1",
      OLIVE_SUPERVISOR_ADDR: "127.0.0.1:9",
      OLIVE_SUPERVISOR_SERVER_NAME: SUPERVISOR_DNS,
      OLIVE_SUPERVISOR_URI: SUPERVISOR_URI,
      OLIVE_STORE_DIR: storeDir,
      OLIVE_TLS_DIR: join(root, "tls"),
      OLIVE_TRUST_DIR: join(root, "trust"),
      OLIVE_SIGNING_KEY_FILE: join(root, "signing.pem"),
      OLIVE_PROFILE_FILE: join(root, "profile.json"),
      OLIVE_AGENT_SOCKET: join(root, "link", "agent.sock"),
      OLIVE_POD_UID: POD_UID,
    };

    // 1. 표식이 같다(제어만 다시 떴다): 94, 닫지 않음, 요청은 남는다. 대리 소켓을 열기 전에 끝난다.
    const same = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", env, timeout: 20_000 });
    expect(same.status, same.stderr).toBe(EXECUTOR_EXIT.restart_all);
    expect(same.stderr).toContain("기동 단계 restart_check에서 멈췄다(generation_unchanged)");
    expect(onDiskRun(storeDir, run).state).toBe("unknown_running");
    expect(onDiskEvents(storeDir, run).filter((event) => event.action === "receipt_stopped")).toEqual([]);
    expect(existsSync(join(storeDir, "restart-request.json"))).toBe(true);
    expect(existsSync(join(root, "link", "agent.sock"))).toBe(false);

    // 2. init이 새 표식을 썼다(파드 전체 재시작): 닫고 요청을 지운 뒤 대리를 기다린다. 그 뒤는 이 사례 밖이라 자식을 끝낸다.
    writeFileSync(join(root, "generation", "marker"), "b".repeat(64));
    const child = spawn(command[0]!, command.slice(1), { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      const limit = Date.now() + 15_000;
      while (Date.now() < limit && (existsSync(join(storeDir, "restart-request.json")) || !existsSync(join(root, "link", "agent.sock")))) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(existsSync(join(storeDir, "restart-request.json")), stderr).toBe(false);
      expect(onDiskRun(storeDir, run).state).toBe("failed_stopped");
      expect(onDiskEvents(storeDir, run).filter((event) => event.action === "receipt_stopped").map((event) => event.body.remaining_processes)).toEqual([0]);
      expect(stderr).toContain("요청의 실행 1/1개를 남은 0으로 닫았다");
      // 닫은 뒤에야 대리 소켓을 열었다(감독 연결은 대리 hello 뒤라 아직 없다).
      expect(existsSync(join(root, "link", "agent.sock"))).toBe(true);
      expect(child.exitCode).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }, 40_000);
}
