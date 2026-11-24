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

for (const role of ["supervisor", "executor"] as const) {
  test(`entrypoints: ${role}는 역할 이름과 버전을 한 줄 찍고 69로 끝난다`, () => {
    const result = run(`src/main/${role}.ts`);
    expect(result.exitCode).toBe(69);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      `olive ${role} ${pkg.version} (bun ${Bun.version}): 아직 구현되지 않았다\n`,
    );
  });
}

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
const unixOnly = (source: string) =>
  [...source.matchAll(/\bBun\.listen\b/g)].length === 1 &&
  !/\bBun\.(serve|udpSocket)\b|\bcreateServer\b|\.listen\(/.test(source) &&
  /\bBun\.listen\s*(?:<[^>]*>)?\s*\(\s*\{\s*unix\s*:\s*path\s*,\s*socket\s*:/.test(source) &&
  !/\b(hostname|port)\s*:/.test(source);

test("entrypoints: 경로 유닉스 소켓만 듣는다는 확인이 TCP·두 번 듣기를 잡는다", async () => {
  expect(unixOnly(await Bun.file(join(root, LISTENER)).text())).toBe(true);
  expect(unixOnly("Bun.listen({ unix: path, socket: {} }); Bun.listen({ unix: path, socket: {} });")).toBe(false);
  expect(unixOnly('Bun.listen({ hostname: "0.0.0.0", port: 9, socket: {} });')).toBe(false);
  expect(unixOnly("Bun.listen({ unix: path, port: 9, socket: {} });")).toBe(false);
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
