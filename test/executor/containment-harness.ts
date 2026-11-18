// 별도 PID namespace 안에서 도는 실제 프로세스 시험 본체. containment.test.ts가 bwrap(--unshare-pid --unshare-user)으로 감싸 띄운다.
// 그 안의 kill(-1)은 그 namespace 밖에 닿지 않는다. 밖에서 잘못 띄워도 record()가 기준 밖 프로세스를 보고 거부한다.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PidSpace } from "../../src/executor/containment.ts";
import { bunLauncher, LaunchFailed, type LaunchHooks } from "../../src/executor/launcher.ts";
import type { LaunchPlan } from "../../src/executor/profile.ts";

const FAKE_ROLE = fileURLToPath(new URL("./fake-role.ts", import.meta.url));
const GRACE_MS = 300;
const sh = (script: string): LaunchPlan => ({ program: "/bin/sh", argv: ["-c", script], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
const role = (mode: string): LaunchPlan => ({ program: process.execPath, argv: [FAKE_ROLE, mode], cwd: "/", env: { PATH: "/usr/bin:/bin" } });

export const SCENARIOS: Readonly<Record<string, { plan: LaunchPlan; hang?: boolean }>> = {
  clean: { plan: sh("exit 0") },
  background: { plan: sh("sleep 300 >/dev/null 2>&1 & sleep 0.1") },
  setsid: { plan: sh("setsid sleep 300 >/dev/null 2>&1 & sleep 0.1") },
  doublefork: { plan: sh("( ( sleep 300 >/dev/null 2>&1 & ) & ) ; sleep 0.1") },
  // 프로세스 그룹과 환경을 모두 벗어난다.
  envclear: { plan: sh("setsid env -i /usr/bin/sleep 300 >/dev/null 2>&1 & sleep 0.1") },
  termignore: { plan: sh(`setsid sh -c 'trap "" TERM HUP INT; exec sleep 300' >/dev/null 2>&1 & sleep 0.1`) },
  // 부모가 끝나도 stdout을 쥐고 있는 자식.
  stdoutholder: { plan: sh("sleep 300 & sleep 0.1") },
  forkrace: { plan: sh(`setsid sh -c 'while :; do sleep 0.05 & sleep 0.01; done' >/dev/null 2>&1 & sleep 0.1`) },
  // 가짜 역할 프로그램(Bun)이 직접 남기는 후손.
  "role-leave-descendant": { plan: role("leave-descendant") },
  "role-hold-stdout": { plan: role("hold-stdout") },
  // TERM을 무시하는 역할 프로그램 자체. 중단 신호로 멈춘다.
  "role-ignore-term": { plan: role("ignore-term"), hang: true },
  hang: { plan: role("hang"), hang: true },
};

// 정리 코드와 따로 센다. 같은 코드로 세면 같은 결함을 함께 놓친다.
async function independentCount(self: number) {
  let alive = 0;
  let zombies = 0;
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name) || name === "1" || Number(name) === self) continue;
    try {
      const raw = await readFile(`/proc/${name}/stat`, "utf8");
      const state = raw.slice(raw.lastIndexOf(")") + 2)[0];
      if (state === "Z") zombies++;
      else if (state !== "X") alive++;
    } catch {
      // 그 사이 끝남
    }
  }
  return { alive, zombies };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const name = process.argv[2]!;
  const space = await PidSpace.record({ dedicated: true, graceMs: GRACE_MS, killMs: 3_000 });
  const hooks: LaunchHooks = { busy: () => space.busy(), terminate: () => space.terminate(), spawned: () => {}, outputBytes: 4_096, drainMs: 200 };

  // 자식 시작 실패와 취소의 경합.
  if (name === "spawnrace") {
    const aborted = new AbortController();
    aborted.abort();
    const refused = await bunLauncher.run(role("hang"), aborted.signal, hooks).then(
      () => "spawned",
      (error: unknown) => (error instanceof LaunchFailed ? error.code : "other"),
    );
    const missing = await bunLauncher.run({ ...role("hang"), program: "/nonexistent/olive-role" }, new AbortController().signal, hooks).then(
      () => "spawned",
      (error: unknown) => (error instanceof LaunchFailed ? error.code : "other"),
    );
    // 띄운 직후(같은 틱)에 취소가 온다.
    const racing = new AbortController();
    const running = bunLauncher.run(role("ignore-term"), racing.signal, hooks);
    racing.abort();
    const exit = await running.catch(() => null);
    await space.terminate();
    const survivors = await space.survivors();
    const after = await independentCount(process.pid);
    process.stdout.write(`${JSON.stringify({ name, refused, missing, raced: exit === null ? null : exit.exit, survivors, after })}\n`);
    return;
  }

  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error("unknown_scenario");
  const controller = new AbortController();
  const running = bunLauncher.run(scenario.plan, controller.signal, hooks);
  if (scenario.hang) {
    await sleep(300);
    controller.abort();
  }
  const outcome = await running;
  const before = await independentCount(process.pid);
  const started = Date.now();
  const sweeping = space.terminate();
  // 정리가 도는 동안의 늦은 띄우기는 거부된다.
  const late = await bunLauncher.run(scenario.plan, new AbortController().signal, hooks).then(
    () => "spawned",
    (error: unknown) => (error instanceof LaunchFailed ? error.code : "other"),
  );
  await sweeping;
  const elapsedMs = Date.now() - started;
  const survivors = await space.survivors();
  const after = await independentCount(process.pid);
  process.stdout.write(
    `${JSON.stringify({ name, pid: process.pid, exit: outcome.exit, stdoutBytes: outcome.stdout.byteLength, before, after, survivors, late, elapsedMs, graceMs: GRACE_MS })}\n`,
  );
}

main().then(
  () => process.exit(0),
  (error: Error) => {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(1);
  },
);
