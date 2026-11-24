import { expect, test } from "bun:test";
import { dirname, join, relative } from "node:path";
import { readText, root } from "./files.ts";

const pkg = JSON.parse(await readText("package.json"));

// PORT를 주고도 바로 끝나면 그 진입점은 아무 포트도 쥐고 있지 않다.
function run(entry: string) {
  return Bun.spawnSync([process.execPath, entry], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", PORT: "8080" },
    timeout: 10_000,
  });
}

// 감독 진입점은 환경이 없으면 아무 파일도 읽기 전에 91로 끝난다. 환경마다의 경우는 test/supervisor/runtime/entry.test.ts가 본다.
// 두 역할 진입점이 모두 조립을 갖춰 자리 진입점(69)을 쓰는 역할은 없다.
test("entrypoints: supervisor는 환경이 없으면 첫 이름을 한 줄 찍고 91로 끝난다", () => {
  const result = run("src/main/supervisor.ts");
  expect(result.exitCode).toBe(91);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe(`olive supervisor ${pkg.version}: 환경 OLIVE_SUPERVISOR_PORT이(가) 없다\n`);
});

// 실행기 진입점은 환경이 없으면 감독에 붙기 전에 81로 끝난다. 환경마다의 경우와 연결 0은 test/executor/entry.test.ts가 본다.
test("entrypoints: executor는 환경이 없으면 첫 이름을 한 줄 찍고 81로 끝난다", () => {
  const result = run("src/main/executor.ts");
  expect(result.exitCode).toBe(81);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe(`olive executor ${pkg.version}: 환경 OLIVE_ROLE이(가) 없다\n`);
});

// 대리 진입점(역할 컨테이너의 PID 1)은 링크 소켓 경로가 없으면 무엇도 하기 전에 81로 끝난다.
test("entrypoints: role-agent는 OLIVE_AGENT_SOCKET이 없으면 한 줄 찍고 81로 끝난다", () => {
  const result = run("src/main/role-agent.ts");
  expect(result.exitCode).toBe(81);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("olive role-agent: 환경 OLIVE_AGENT_SOCKET이(가) 없다\n");
});

// 대리 설치 진입점(init 컨테이너)은 환경을 읽지 않고 고정 경로만 쓴다. 이미지 밖(이 시험이 도는 곳)에는 원본이 없어 아무것도 쓰기 전에 90으로 끝난다.
// 복사·모드·대조·덮어쓰기와 다른 코드는 test/agent-install.test.ts가 임시 폴더로 본다.
test("entrypoints: agent-install은 이미지 밖에서 원본이 없으면 한 줄 찍고 90으로 끝난다", async () => {
  expect(await Bun.file("/opt/olive/olive-agent").exists()).toBe(false);
  const result = run("src/main/agent-install.ts");
  expect(result.exitCode).toBe(90);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("olive agent-install: source 단계에서 멈췄다(/opt/olive/olive-agent → /opt/olive-agent/olive-agent)\n");
});

test("entrypoints: 이미지 기본 명령(no-role)은 역할을 고르라고 한 줄 찍고 64로 끝난다", () => {
  const result = run("src/main/no-role.ts");
  expect(result.exitCode).toBe(64);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toMatch(/^olive \S+: 역할을 고르지 않았다\. [^\n]*\n$/);
});

// 실행기는 감독에 먼저 붙는 쪽이다. 듣는 곳은 역할 컨테이너의 대리가 붙는 경로 유닉스 소켓 한 파일(agent-listener.ts)뿐이다(D-102).
// TCP·abstract 소켓은 듣지 않는다. 실행기 진입점에서 닿는 로컬 모듈 전체를 본다.
const LISTENER = "src/executor/agent-listener.ts";
const listening = /\bBun\.(serve|listen|udpSocket)\b|\bcreateServer\b|\.listen\(/;
// 그 한 파일의 듣기: Bun.listen 하나이고 unix 경로만 넘긴다(hostname·port 없음).
const ALLOWED_LISTEN = /\bBun\.listen\s*(?:<[^>]*>)?\s*\(\s*\{\s*unix\s*:\s*path\s*,\s*socket\s*:/;
const unixOnly = (source: string) =>
  [...source.matchAll(/\bBun\.listen\b/g)].length === 1 &&
  ALLOWED_LISTEN.test(source) &&
  // 허용한 그 호출을 뺀 나머지에서 다른 듣기를 찾는다(허용한 호출의 ".listen("을 이 규칙이 잡지 않게).
  !/\bBun\.(serve|udpSocket)\b|\bcreateServer\b|\.listen\(/.test(source.replace(ALLOWED_LISTEN, "")) &&
  !/\b(hostname|port)\s*:/.test(source);

test("entrypoints: 경로 유닉스 소켓만 듣는다는 확인이 TCP·두 번 듣기를 잡는다", async () => {
  expect(unixOnly(await Bun.file(join(root, LISTENER)).text())).toBe(true);
  // 정상 대조군(타입 인자 없음)과, 거기서 한 가지씩만 바꾼 음성 대조군.
  const normal = "Bun.listen({ unix: path, socket: {} });";
  expect(unixOnly(normal)).toBe(true);
  expect(unixOnly(`${normal} ${normal}`)).toBe(false);
  // 호출 수 규칙만 어기는 꼴: 타입 인자가 있으면 두 번째 호출이 ".listen("에 걸리지 않는다.
  const typed = "Bun.listen<Data>({ unix: path, socket: {} });";
  expect(unixOnly(typed)).toBe(true);
  expect(unixOnly(`${typed} ${typed}`)).toBe(false);
  // 호출 모양 규칙만 어기는 꼴: 주소 금지어 없이 옵션을 다른 값으로 넘긴다(그 안에 무엇이 있는지 이 확인은 모른다).
  expect(unixOnly("Bun.listen<Data>(options);")).toBe(false);
  expect(unixOnly('Bun.listen({ hostname: "0.0.0.0", socket: {} });')).toBe(false);
  expect(unixOnly(`${normal} const tcp = { port: 9 };`)).toBe(false);
  expect(unixOnly(`${normal} server.listen(9);`)).toBe(false);
});

// 진입점에서 import로 닿는 로컬 모듈 전체.
async function reachable(entry: string): Promise<Map<string, string>> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Map<string, string>();
  const queue = [join(root, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = await Bun.file(file).text();
    seen.set(file, source);
    for (const { path } of transpiler.scanImports(source)) {
      if (path.startsWith(".") && path.endsWith(".ts")) queue.push(join(dirname(file), path));
    }
  }
  return seen;
}

// 대리는 제어가 듣는 소켓에 붙는 쪽이다. 대리가 들으면 같은 uid의 역할 프로그램이 그 자리를 바꿔치기할 수 있다(agent.md).
test("entrypoints: 대리 진입점에서 닿는 코드에 듣는 API가 없다", async () => {
  const files = await reachable("src/main/role-agent.ts");
  for (const [file, source] of files) expect(listening.test(source), relative(root, file)).toBe(false);
  expect(files.size).toBeGreaterThan(1);
});

// 환경을 읽는 곳은 세 진입점뿐이다. 조립(src/executor/runtime.ts, src/supervisor/runtime/boot.ts)과 핵심(src/executor/, src/agent/,
// src/supervisor/)은 값으로만 받는다.
test("entrypoints: src/에서 환경을 읽는 파일은 src/main/executor.ts·src/main/role-agent.ts·src/main/supervisor.ts 셋뿐이다", async () => {
  const readsEnv = /\bprocess\.env\b|\bBun\.env\b|import\.meta\.env/;
  // 대조군: 세 꼴을 모두 잡고, 주석 줄은 빼고 본다(아래 필터).
  expect(["process.env.PORT", "Bun.env.PORT", "import.meta.env.PORT"].every((sample) => readsEnv.test(sample))).toBe(true);
  const found: string[] = [];
  for (const file of (await Array.fromAsync(new Bun.Glob("src/**/*.ts").scan({ cwd: root }))).sort()) {
    const code = (await Bun.file(join(root, file)).text())
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    if (readsEnv.test(code)) found.push(file);
  }
  expect(found).toEqual(["src/main/executor.ts", "src/main/role-agent.ts", "src/main/supervisor.ts"]);
});

// 감독이 듣는 곳은 실행기를 받는 연결 서버의 TCP 하나(tls-server.ts)뿐이다. 감독 진입점에서 닿는 로컬 모듈 전체를 본다.
const SUPERVISOR_LISTENER = "src/supervisor/transport/tls-server.ts";
test("entrypoints: 감독에서 닿는 코드에 듣는 API는 tls-server.ts 하나뿐이다", async () => {
  const files = await reachable("src/main/supervisor.ts");
  const listeners = [...files].filter(([, source]) => listening.test(source)).map(([file]) => relative(root, file));
  expect(listeners).toEqual([SUPERVISOR_LISTENER]);
  // 그 한 파일의 듣기: tls.createServer 하나와 그 서버의 listen 하나(나머지 ".listen("은 그 파일이 감싼 자기 메서드의 호출이다).
  const source = files.get(join(root, SUPERVISOR_LISTENER))!;
  expect([...source.matchAll(/\bcreateServer\(/g)].length).toBe(1);
  expect([...source.matchAll(/\btls\.createServer\(/g)].length).toBe(1);
  expect([...source.matchAll(/\bthis\.server\.listen\(/g)].length).toBe(1);
  expect(files.size).toBeGreaterThan(1);
});

test("entrypoints: 실행기에서 닿는 코드에 듣는 API는 agent-listener.ts의 경로 유닉스 소켓 하나뿐이다", async () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const queue = [join(root, "src/main/executor.ts")];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await Bun.file(file).text();
    if (relative(root, file) === LISTENER) expect(unixOnly(source), LISTENER).toBe(true);
    else expect(listening.test(source), relative(root, file)).toBe(false);
    for (const { path } of transpiler.scanImports(source)) {
      if (path.startsWith(".") && path.endsWith(".ts")) queue.push(join(dirname(file), path));
    }
  }
  expect(seen.size).toBeGreaterThan(1);
});
