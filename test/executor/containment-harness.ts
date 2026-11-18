// 별도 PID namespace 안에서 도는 실제 프로세스 시험 본체. containment.test.ts가 bwrap(--unshare-pid --unshare-user)으로 감싸 띄운다.
// 그 안의 kill(-1)은 그 namespace 밖에 닿지 않는다.
// 실제 신호 함수를 쓰는 PidSpace.record를 부르기 전에 bwrap이 만든 공간 안인지 스스로 확인한다. 밖에서 직접 띄우면 신호 없이 끝난다.
import { readdir, readFile, stat } from "node:fs/promises";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PidSpace } from "../../src/executor/containment.ts";
import { bunLauncher, LaunchFailed, type LaunchHooks } from "../../src/executor/launcher.ts";
import type { LaunchPlan } from "../../src/executor/profile.ts";

const FAKE_ROLE = fileURLToPath(new URL("./fake-role.ts", import.meta.url));
const PYTHON = "/usr/bin/python3";
const GRACE_MS = 300;
// 번호를 옮겨 다니는 자식은 /proc 검사로 셀 수 없다. 자식이 이 파일을 늘리는지로 살아 있음을 따로 본다.
const WITNESS = join(mkdtempSync(join(tmpdir(), "olive-witness-")), "witness");
const ENV = { PATH: "/usr/bin:/bin", WITNESS };
const sh = (script: string): LaunchPlan => ({ program: "/bin/sh", argv: ["-c", script], cwd: "/", env: ENV });
const role = (mode: string): LaunchPlan => ({ program: process.execPath, argv: [FAKE_ROLE, mode], cwd: "/", env: ENV });

export const SCENARIOS: Readonly<Record<string, { plan: LaunchPlan; hang?: boolean; witness?: boolean; attest?: boolean }>> = {
  clean: { plan: sh("exit 0") },
  background: { plan: sh("sleep 300 >/dev/null 2>&1 & sleep 0.1") },
  setsid: { plan: sh("setsid sleep 300 >/dev/null 2>&1 & sleep 0.1") },
  doublefork: { plan: sh("( ( sleep 300 >/dev/null 2>&1 & ) & ) ; sleep 0.1") },
  // 프로세스 그룹과 환경을 모두 벗어난다.
  envclear: { plan: sh("setsid env -i /usr/bin/sleep 300 >/dev/null 2>&1 & sleep 0.1") },
  termignore: { plan: sh(`setsid sh -c 'trap "" TERM HUP INT; exec sleep 300' >/dev/null 2>&1 & sleep 0.1`) },
  nohup: { plan: sh("nohup sleep 300 >/dev/null 2>&1 & sleep 0.1") },
  // 부모가 끝나도 stdout을 쥐고 있는 자식.
  stdoutholder: { plan: sh("sleep 300 & sleep 0.1") },
  forkrace: { plan: sh(`setsid sh -c 'while :; do sleep 0.05 & sleep 0.01; done' >/dev/null 2>&1 & sleep 0.1`) },
  // TERM을 받으면 정리 도중에 새 세션 자식을 띄운다. 띄운 순간을 증인 파일에 적는다.
  latespawn: {
    plan: sh(`setsid sh -c 'trap "setsid sleep 300 >/dev/null 2>&1 & echo spawned >> \\"\\$WITNESS\\"" TERM; while :; do sleep 0.02; done' >/dev/null 2>&1 & sleep 0.1`),
    attest: true,
  },
  // ptrace 검사로 environ을 읽을 수 없는 자식. 세는 쪽은 status를 읽는다. 속성 설정이 실제로 성공했을 때만 증인 파일에 적는다.
  nondumpable: {
    plan: sh(
      `setsid env -i ${PYTHON} -c 'import ctypes,time; libc=ctypes.CDLL(None); ok=libc.prctl(4,0,0,0,0)==0 and libc.prctl(3,0,0,0,0)==0; open("${WITNESS}","w").write("nondumpable" if ok else "dumpable"); time.sleep(300)' >/dev/null 2>&1 & sleep 0.6`,
    ),
    attest: true,
  },
  // 리더 스레드만 끝내 좀비처럼 보이면서 다른 스레드가 계속 돈다.
  zombieleader: {
    plan: sh(
      `setsid env -i ${PYTHON} -c 'import ctypes,threading,time; threading.Thread(target=time.sleep,args=(300,)).start(); ctypes.CDLL(None).pthread_exit(None)' >/dev/null 2>&1 & sleep 0.6`,
    ),
  },
  // 한 번에 하나만 살아 있으면서 번호를 옮겨 다닌다. 목록에 잡혀도 읽을 때는 이미 없어 깨끗해 보일 수 있다.
  pidhop: { plan: sh(`setsid sh -c 'hop() { echo x >> "$WITNESS"; sleep 0.005; hop & exit 0; }; hop' >/dev/null 2>&1 & sleep 0.1`), witness: true },
  tighthop: {
    plan: sh(`setsid ${PYTHON} -c 'import os
fd = os.open(os.environ["WITNESS"], os.O_WRONLY | os.O_APPEND | os.O_CREAT)
while True:
    os.write(fd, b"x")
    if os.fork(): os._exit(0)' >/dev/null 2>&1 & sleep 0.2`),
    witness: true,
  },
  // 가짜 역할 프로그램(Bun)이 직접 남기는 후손.
  "role-leave-descendant": { plan: role("leave-descendant") },
  "role-hold-stdout": { plan: role("hold-stdout") },
  // TERM을 무시하는 역할 프로그램 자체. 중단 신호로 멈춘다.
  "role-ignore-term": { plan: role("ignore-term"), hang: true },
  hang: { plan: role("hang"), hang: true },
};

// bwrap이 만든 PID·사용자 공간 안인지. 시험이 bwrap의 --setenv로 표식을 넣고, 번호는 1(--as-pid-1) 또는 2(bwrap이 1)이며,
// 사용자 공간의 uid_map이 호스트의 전체 대응(0 0 4294967295)이 아니어야 한다. 하나라도 아니면 실제 신호를 쓰지 않는다.
function insideBwrap(): boolean {
  if (process.env.OLIVE_CONTAINMENT_HARNESS !== "1") return false;
  if (process.pid !== 1 && process.pid !== 2) return false;
  try {
    if (readFileSync("/proc/self/uid_map", "utf8").trim().split(/\s+/).join(" ") === "0 0 4294967295") return false;
    if (process.pid === 2 && readFileSync("/proc/1/comm", "utf8").trim() !== "bwrap") return false;
  } catch {
    return false;
  }
  return true;
}

// 정리 코드와 따로 센다. 같은 코드로 세면 같은 결함을 함께 놓친다.
// 리더가 Z여도 스레드 가운데 Z가 아닌 것이 있으면 산 프로세스(좀비 리더)로 센다.
async function independentCount(self: number) {
  let alive = 0;
  let zombies = 0;
  let zombieLeaders = 0;
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name) || name === "1" || Number(name) === self) continue;
    try {
      const raw = await readFile(`/proc/${name}/stat`, "utf8");
      const state = raw.slice(raw.lastIndexOf(")") + 2)[0];
      if (state === "X") continue;
      if (state !== "Z") {
        alive++;
        continue;
      }
      let live = false;
      for (const thread of await readdir(`/proc/${name}/task`)) {
        const t = await readFile(`/proc/${name}/task/${thread}/stat`, "utf8").catch(() => "");
        const s = t.slice(t.lastIndexOf(")") + 2)[0];
        if (s !== undefined && s !== "Z" && s !== "X") live = true;
      }
      if (live) {
        zombieLeaders++;
        alive++;
      } else zombies++;
    } catch {
      // 그 사이 끝남
    }
  }
  return { alive, zombies, zombieLeaders };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sizeOf = (path: string) => stat(path).then((info) => info.size, () => 0);
// 파일이 늘고 있으면 자식이 살아 있다.
async function growing(path: string): Promise<boolean> {
  const before = await sizeOf(path);
  await sleep(150);
  return (await sizeOf(path)) > before;
}
const attestation = (path: string) => readFile(path, "utf8").catch(() => "");

// 이 공간의 init과 자기 말고 부모가 공간 밖인(PPid 0) 살아 있는 프로세스. 정리 코드와 따로 읽는다.
async function joinedFromOutside(self: number): Promise<number[]> {
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name) || name === "1" || Number(name) === self) continue;
    const status = await readFile(`/proc/${name}/status`, "utf8").catch(() => "");
    if (/^PPid:\s+0$/m.test(status) && !/^State:\s+[ZXx]/m.test(status)) found.push(Number(name));
  }
  return found;
}

async function main() {
  const name = process.argv[2]!;
  if (!insideBwrap()) throw new Error("not_inside_bwrap");
  const space = await PidSpace.record({ dedicated: true, graceMs: GRACE_MS, killMs: 3_000 });
  let spawned = 0;
  const hooks: LaunchHooks = {
    busy: () => space.busy(),
    terminate: () => space.terminate(),
    spawned: () => void spawned++,
    outputBytes: 4_096,
    drainMs: 200,
  };

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
    const spawnedBeforeRace = spawned;
    // 띄운 직후(같은 틱)에 취소가 온다.
    const racing = new AbortController();
    const running = bunLauncher.run(role("ignore-term"), racing.signal, hooks);
    racing.abort();
    const exit = await running.catch(() => null);
    await space.terminate();
    const survivors = await space.survivors();
    const after = await independentCount(process.pid);
    process.stdout.write(
      `${JSON.stringify({ name, refused, missing, spawnedBeforeRace, spawned, raced: exit === null ? null : exit.exit, survivors, after })}\n`,
    );
    return;
  }

  // 시험이 이 공간 밖에서 프로세스 하나를 합류시킨다. 그것이 보이면 전체 신호를 보내지 않아 함께 있던 후손이 살아남아야 한다.
  if (name === "foreign") {
    await bunLauncher.run(sh("setsid sleep 300 >/dev/null 2>&1 & sleep 0.1"), new AbortController().signal, hooks);
    // 기준을 기록하고 후손을 띄운 뒤에 합류시키게 알린다(먼저 합류하면 이 프로세스의 번호가 밀린다).
    writeFileSync(process.env.OLIVE_FOREIGN_READY!, "ready");
    const until = Date.now() + 10_000;
    let joined = await joinedFromOutside(process.pid);
    while (joined.length === 0 && Date.now() < until) {
      await sleep(20);
      joined = await joinedFromOutside(process.pid);
    }
    const before = await independentCount(process.pid);
    await space.terminate();
    const survivors = await space.survivors();
    const after = await independentCount(process.pid);
    process.stdout.write(`${JSON.stringify({ name, joined: joined.length, before, after, survivors })}\n`);
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
  const witnessBefore = scenario.witness ? await growing(WITNESS) : null;
  const attestBefore = scenario.attest ? await attestation(WITNESS) : null;
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
  const witnessAfter = scenario.witness ? await growing(WITNESS) : null;
  const attestAfter = scenario.attest ? await attestation(WITNESS) : null;
  process.stdout.write(
    `${JSON.stringify({ name, pid: process.pid, exit: outcome.exit, stdoutBytes: outcome.stdout.byteLength, before, after, survivors, late, elapsedMs, graceMs: GRACE_MS, witnessBefore, witnessAfter, attestBefore, attestAfter })}\n`,
  );
}

main().then(
  () => process.exit(0),
  (error: Error) => {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(1);
  },
);
