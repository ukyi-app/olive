// 실행기 진입점(src/main/executor.ts)을 실제 프로세스로 띄운다. 환경이 하나라도 없거나 틀리면, 또는 재료 파일이 없으면 감독에 붙기 전에
// 정한 코드로 끝난다. 감독 주소는 이 시험이 듣는 루프백 TCP이고, 받아들인 연결 수가 0인지 본다.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_EXIT } from "../../src/agent/agent.ts";
import { RemoteAgent } from "../../src/executor/remote-agent.ts";
import { EXECUTOR_EXIT } from "../../src/executor/runtime.ts";
import { EXECUTOR_ENV, listenAgentSocket, settingsFromEnv } from "../../src/main/executor.ts";
import { connectUnix, runRoleAgent } from "../../src/main/role-agent.ts";
import { FakeLauncher, FakeRuntime, FakeSpace } from "../agent/support.ts";
import { root } from "../files.ts";
import { until } from "./support.ts";

const accepted = { count: 0 };
const supervisor = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open: () => {
      accepted.count++;
    },
    data: () => {},
  },
});
afterAll(() => supervisor.stop(true));

const dir = mkdtempSync(join(tmpdir(), "olive-entry-"));
const FULL: Record<(typeof EXECUTOR_ENV)[number], string> = {
  OLIVE_ROLE: "diagnosis",
  OLIVE_INSTANCE: "worker-1",
  OLIVE_POLICY_REVISION: "policy-r1",
  OLIVE_SUPERVISOR_ADDR: `127.0.0.1:${supervisor.port}`,
  OLIVE_SUPERVISOR_SERVER_NAME: "supervisor.olive-control.svc",
  OLIVE_SUPERVISOR_URI: "spiffe://olive.internal/ns/olive-control/supervisor",
  OLIVE_STORE_DIR: join(dir, "store"),
  OLIVE_TLS_DIR: join(dir, "tls"),
  OLIVE_TRUST_DIR: join(dir, "trust"),
  OLIVE_SIGNING_KEY_FILE: join(dir, "signing.pem"),
  OLIVE_PROFILE_FILE: join(dir, "profile.json"),
  OLIVE_AGENT_SOCKET: join(dir, "link", "agent.sock"),
};

async function run(env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, "src/main/executor.ts"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  // 끝난 뒤 남은 연결 사건이 들어올 틈을 준다.
  await Bun.sleep(20);
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

test("실행기 진입점: 환경이 하나씩 빠질 때마다 81로 끝나고 그 이름을 한 줄 찍으며 감독 연결은 0이다", async () => {
  expect(EXECUTOR_ENV).toHaveLength(12);
  for (const name of EXECUTOR_ENV) {
    const env: Record<string, string> = { ...FULL };
    delete env[name];
    const result = await run(env);
    expect(result.code, name).toBe(EXECUTOR_EXIT.config);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(new RegExp(`^olive executor \\S+: 환경 ${name}이\\(가\\) 없다\\n$`));
  }
  // 빈 값도 없는 것과 같다.
  expect((await run({ ...FULL, OLIVE_INSTANCE: "" })).code).toBe(EXECUTOR_EXIT.config);
  expect(accepted.count).toBe(0);
});

test("실행기 진입점: 틀린 값(모르는 역할, 포트 없는 주소, 상대 경로)이면 81로 끝나고 감독 연결은 0이다", async () => {
  const cases: [string, string][] = [
    ["OLIVE_ROLE", "reader"],
    ["OLIVE_SUPERVISOR_ADDR", "127.0.0.1"],
    ["OLIVE_SUPERVISOR_ADDR", "127.0.0.1:0"],
    ["OLIVE_STORE_DIR", "store"],
    ["OLIVE_AGENT_SOCKET", "agent.sock"],
  ];
  for (const [name, value] of cases) {
    const result = await run({ ...FULL, [name]: value });
    expect(result.code, `${name}=${value}`).toBe(EXECUTOR_EXIT.config);
    expect(result.stderr).toContain(`환경 ${name}이(가) 틀렸다`);
  }
  expect(accepted.count).toBe(0);
});

test("실행기 진입점: 환경이 다 있어도 재료 파일이 없으면 82로 끝나고 감독 연결·저장소 폴더가 없다", async () => {
  const result = await run(FULL);
  expect(result.code).toBe(EXECUTOR_EXIT.material);
  expect(result.stderr).toMatch(/^olive executor \S+: 기동 단계 material에서 멈췄다\([a-z_]+_unreadable\)\n$/);
  expect(accepted.count).toBe(0);
  expect(await Bun.file(join(FULL.OLIVE_STORE_DIR, "storage-id")).exists()).toBe(false);
});

test("실제 경로 유닉스 소켓: 제어의 듣기(umask를 되돌림, 0606, 지난 소켓 파일 처리)에 대리 진입점의 실제 연결이 붙어 hello가 닿고, 끊기면 대리가 75로 끝난다", async () => {
  const linkDir = mkdtempSync(join(tmpdir(), "olive-link-"));
  const remote = () =>
    new RemoteAgent({
      credentialEnv: "OLIVE_CREDENTIAL",
      runWindow: () => undefined,
      runtime: { setTimer: (ms, fire) => ((handle) => () => clearTimeout(handle))(setTimeout(fire, ms)), now: () => performance.now() },
      inheritedUnverified: false,
      replyWaitMs: 1_000,
    });
  // 소켓이 아닌 파일이 그 경로에 있으면 지우지 않고 거절한다.
  const occupied = join(linkDir, "occupied.sock");
  writeFileSync(occupied, "x");
  expect(() => listenAgentSocket(remote(), occupied)).toThrow("not_a_socket");
  expect(await Bun.file(occupied).text()).toBe("x");

  const path = join(linkDir, "agent.sock");
  const control = remote();
  const umask = process.umask();
  const listening = listenAgentSocket(control, path);
  expect(process.umask()).toBe(umask);
  expect(statSync(path).mode & 0o777).toBe(0o606);
  const runtime = new FakeRuntime();
  const agent = await runRoleAgent({
    socketPath: path,
    runtime,
    parts: { selfPid: 1, harden: () => true, record: async () => new FakeSpace(), launcher: new FakeLauncher() },
    connect: connectUnix,
    connectWaitMs: 1_000,
    retryMs: 50,
  });
  expect(agent).not.toBeNull();
  await until(() => control.state().greeted);
  expect(control.state()).toMatchObject({ connected: true, generation: 1, distrusted: null });
  listening.stop();
  await until(() => runtime.exits.length > 0);
  expect(runtime.exits).toEqual([AGENT_EXIT.link_closed]);
  // 제어가 다시 뜨면 같은 경로에서 다시 듣는다(지난 소켓 파일이 남았으면 지운다).
  listenAgentSocket(remote(), path).stop();
});

test("실행기 진입점: 환경의 폴더에서 차트가 붙이는 파일 이름으로 재료 경로를 만든다", () => {
  const parsed = settingsFromEnv(FULL);
  if (!parsed.ok) throw new Error(parsed.name);
  expect(parsed.settings.files).toEqual({
    profile: FULL.OLIVE_PROFILE_FILE,
    signingKey: FULL.OLIVE_SIGNING_KEY_FILE,
    supervisorKey: join(FULL.OLIVE_TRUST_DIR, "supervisor-signing.pub"),
    certificate: join(FULL.OLIVE_TLS_DIR, "tls.crt"),
    privateKey: join(FULL.OLIVE_TLS_DIR, "tls.key"),
    trustBundle: join(FULL.OLIVE_TRUST_DIR, "ca-bundle.pem"),
  });
  expect(parsed.settings.supervisor).toEqual({
    address: "127.0.0.1",
    port: supervisor.port,
    serverName: FULL.OLIVE_SUPERVISOR_SERVER_NAME,
    uri: FULL.OLIVE_SUPERVISOR_URI,
  });
  // worker와 원격에 넘기는 응답 상한은 하나다.
  expect(parsed.settings.timing.replyWaitMs).toBeGreaterThan(0);
});
