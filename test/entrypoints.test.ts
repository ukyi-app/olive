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

// 시험 현관 대역(D-109). 운영 값(시험 작업 꺼짐)에서 켜거나 on·off 밖의 값이면 아무 파일도 읽기 전에 91이다. 대역이 없거나 시험 값(둘 다 on)이면
// 환경을 지나 재료 읽기에서 92로 끝나고(경로가 없다), 그 전에 고른 현관을 기록에 한 줄 남긴다. 환경 값마다의 경우는 test/supervisor/frontdoor/test-double.test.ts가 본다.
test("entrypoints: supervisor는 시험 현관 대역을 운영 값에서 켜거나 값이 틀리면 91로, 대역 없음·시험 값이면 환경을 지나 92로 끝난다", () => {
  const env = {
    OLIVE_SUPERVISOR_PORT: "8443",
    OLIVE_LEDGER_DIR: "/olive-absent/ledger",
    OLIVE_SIGNING_KEY_DIR: "/olive-absent/signing",
    OLIVE_ACCOUNTS_DIR: "/olive-absent/accounts",
    OLIVE_TLS_DIR: "/olive-absent/tls",
    OLIVE_TRUST_DIR: "/olive-absent/trust",
    OLIVE_REGISTRY_FILE: "/olive-absent/registry.json",
    OLIVE_ENVIRONMENT: "home",
    OLIVE_TARGETS: JSON.stringify([{ target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] }]),
    OLIVE_POLICY_REVISION: "policy-1",
    OLIVE_RESULT_DIR: "/olive-absent/results",
  };
  const spawn = (extra: Record<string, string>) =>
    Bun.spawnSync([process.execPath, "src/main/supervisor.ts"], { cwd: root, env: { PATH: process.env.PATH ?? "", ...env, ...extra }, timeout: 10_000 });
  const refused = `olive supervisor ${pkg.version}: 환경 OLIVE_TEST_FRONTDOOR이(가) 틀렸다\n`;
  const refusedEnv: Record<string, string>[] = [{ OLIVE_TEST_FRONTDOOR: "on" }, { OLIVE_TEST_JOBS: "off", OLIVE_TEST_FRONTDOOR: "on" }, { OLIVE_TEST_JOBS: "on", OLIVE_TEST_FRONTDOOR: "yes" }];
  for (const extra of refusedEnv) {
    const result = spawn(extra);
    expect([JSON.stringify(extra), result.exitCode, result.stdout.toString(), result.stderr.toString()]).toEqual([JSON.stringify(extra), 91, "", refused]);
  }
  for (const [extra, mode] of [
    [{}, "absent"],
    [{ OLIVE_TEST_JOBS: "on", OLIVE_TEST_FRONTDOOR: "off" }, "absent"],
    [{ OLIVE_TEST_JOBS: "on", OLIVE_TEST_FRONTDOOR: "on" }, "test_double"],
  ] as const) {
    const result = spawn(extra);
    const lines = result.stderr.toString().split("\n");
    expect([mode, result.exitCode, lines[0]]).toEqual([mode, 92, `olive supervisor: front_door mode=${mode}`]);
    expect(lines).toContain(`olive supervisor ${pkg.version}: 기동 단계 material에서 멈췄다(certificate:unreadable)`);
  }
});

// 배정 판 값 두 환경(D-111의 계정 자격 판, 역할별 기대 프로필 revision). 꼴이 틀리면 아무 파일도 읽기 전에 91이고, 맞거나 없으면 환경을 지나
// 재료 읽기에서 92로 끝난다(경로가 없다). 그 전에 채운 값의 요약을 기록에 한 줄 남긴다. 값마다의 경우는 test/supervisor/runtime/assign-policy.test.ts가 본다.
test("entrypoints: supervisor는 배정 판 값의 꼴이 틀리면 91로, 없거나 맞으면 환경을 지나 92로 끝난다", () => {
  const env = {
    OLIVE_SUPERVISOR_PORT: "8443",
    OLIVE_LEDGER_DIR: "/olive-absent/ledger",
    OLIVE_SIGNING_KEY_DIR: "/olive-absent/signing",
    OLIVE_ACCOUNTS_DIR: "/olive-absent/accounts",
    OLIVE_TLS_DIR: "/olive-absent/tls",
    OLIVE_TRUST_DIR: "/olive-absent/trust",
    OLIVE_REGISTRY_FILE: "/olive-absent/registry.json",
    OLIVE_ENVIRONMENT: "home",
    OLIVE_TARGETS: JSON.stringify([{ target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] }]),
    OLIVE_POLICY_REVISION: "policy-1",
    OLIVE_RESULT_DIR: "/olive-absent/results",
  };
  const spawn = (extra: Record<string, string>) =>
    Bun.spawnSync([process.execPath, "src/main/supervisor.ts"], { cwd: root, env: { PATH: process.env.PATH ?? "", ...env, ...extra }, timeout: 10_000 });
  for (const [extra, name] of [
    [{ OLIVE_ACCOUNT_REVISION: "-bad" }, "OLIVE_ACCOUNT_REVISION"],
    [{ OLIVE_PROFILE_REVISIONS: "not json" }, "OLIVE_PROFILE_REVISIONS"],
    [{ OLIVE_PROFILE_REVISIONS: '{"no_role":"p"}' }, "OLIVE_PROFILE_REVISIONS"],
  ] as const) {
    const result = spawn(extra);
    expect([name, result.exitCode, result.stdout.toString(), result.stderr.toString()]).toEqual([name, 91, "", `olive supervisor ${pkg.version}: 환경 ${name}이(가) 틀렸다\n`]);
  }
  for (const [extra, summary] of [
    [{}, "accountRevision=false profileRevisions=none accounts=0"],
    [{ OLIVE_ACCOUNT_REVISION: "acct-1", OLIVE_PROFILE_REVISIONS: '{"isolated_reader":"prof-1"}' }, "accountRevision=true profileRevisions=single accounts=0"],
  ] as const) {
    const result = spawn(extra);
    const lines = result.stderr.toString().split("\n");
    expect([summary, result.exitCode, lines[1]]).toEqual([summary, 92, `olive supervisor: assign_inputs ${summary}`]);
  }
});

// 장부 초기화 진입점(D-110)은 환경이 없으면 장부를 열기 전에 91로 끝난다. 만들기·거절·바이트 무변화는 test/ledger-init.test.ts가 본다.
test("entrypoints: ledger-init은 환경이 없으면 이름을 한 줄 찍고 91로 끝난다", () => {
  const result = run("src/main/ledger-init.ts");
  expect(result.exitCode).toBe(91);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe(`olive ledger-init ${pkg.version}: 환경 OLIVE_LEDGER_DIR이(가) 없다\n`);
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

// 장부 초기화는 관리자가 한 번 돌리고 끝나는 명령이다. 듣는 곳이 없다.
test("entrypoints: 장부 초기화 진입점에서 닿는 코드에 듣는 API가 없다", async () => {
  const files = await reachable("src/main/ledger-init.ts");
  for (const [file, source] of files) expect(listening.test(source), relative(root, file)).toBe(false);
  expect(files.size).toBeGreaterThan(1);
});

// 환경을 읽는 곳은 네 진입점뿐이다(장부 초기화는 감독과 같은 이름 하나만 읽는다). 조립(src/executor/runtime.ts, src/supervisor/runtime/boot.ts)과 핵심(src/executor/, src/agent/,
// src/supervisor/)은 값으로만 받는다.
test("entrypoints: src/에서 환경을 읽는 파일은 src/main/executor.ts·src/main/ledger-init.ts·src/main/role-agent.ts·src/main/supervisor.ts 넷뿐이다", async () => {
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
  expect(found).toEqual(["src/main/executor.ts", "src/main/ledger-init.ts", "src/main/role-agent.ts", "src/main/supervisor.ts"]);
});

// 감독이 듣는 TCP는 실행기를 받는 연결 서버 하나(tls-server.ts)뿐이다. 감독 진입점에서 닿는 로컬 모듈 전체를 본다.
const SUPERVISOR_LISTENER = "src/supervisor/transport/tls-server.ts";
// 예외 하나: 관리 통로(D-60·D-101)의 경로 유닉스 소켓. kubectl exec로 같은 컨테이너에 들어온 관리 진입점만 붙는 자리라 TCP를 열지 않고,
// 실행기 쪽 듣기와 같은 규칙(unixOnly: unix 경로 하나, hostname·port 없음)을 지킨다.
const SUPERVISOR_ADMIN_LISTENER = "src/supervisor/admin/listener.ts";
// 그 한 파일에서 허용한 세 자리(TLS 서버 만들기, 그 서버의 listen, 감싼 자기 메서드의 호출)를 각각 정확히 한 번 찾아 지운 뒤, 남은 글에서
// 다른 종류의 듣기 API를 찾는다. 횟수만 세면 같은 파일에 붙인 Bun.serve·net.createServer·dgram 같은 두 번째 종류를 놓친다.
const SUPERVISOR_ALLOWED = [/\btls\.createServer\(/, /\bthis\.server\.listen\(this\.options\.port, this\.options\.host,/, /\bawait server\.listen\(\);/];
const anyListening = /\bBun\.(serve|listen|udpSocket)\b|\bcreateServer\b|\bcreateSocket\b|\.listen\(|\.bind\(\s*\d/;
const supervisorTcpOnly = (source: string): boolean => {
  let rest = source;
  for (const allowed of SUPERVISOR_ALLOWED) {
    if ([...source.matchAll(new RegExp(allowed.source, "g"))].length !== 1) return false;
    rest = rest.replace(allowed, "");
  }
  return !anyListening.test(rest);
};

test("entrypoints: 감독 듣기 확인이 허용 파일 안의 두 번째 종류 듣기를 잡는다", async () => {
  const source = await Bun.file(join(root, SUPERVISOR_LISTENER)).text();
  expect(supervisorTcpOnly(source)).toBe(true);
  // 음성 대조군: 허용 파일에 다른 종류의 듣기 하나를 붙이거나 허용한 자리를 하나 더 두면 실패한다.
  for (const extra of ["Bun.serve({ fetch: () => new Response() });", "Bun.listen({ hostname: h, port: 1, socket: {} });", "net.createServer().listen(1);", "dgram.createSocket('udp4');", "tls.createServer({});", "await server.listen();"]) {
    expect(supervisorTcpOnly(`${source}\n${extra}\n`), extra).toBe(false);
  }
});

// 관리 통로 파일에도 감독 듣기 확인을 건다: 실행기 쪽 규칙(unixOnly)에 더해, 허용한 Bun.listen 호출 하나를 지운 나머지에서
// 감독용 듣기 API(UDP createSocket·숫자 포트 bind 포함)를 찾는다. unixOnly만으로는 같은 파일에 붙인 UDP 듣기를 놓친다.
const supervisorUnixOnly = (source: string): boolean => unixOnly(source) && !anyListening.test(source.replace(ALLOWED_LISTEN, ""));

test("entrypoints: 감독 관리 소켓 확인이 허용 파일 안의 두 번째 종류 듣기(UDP 포함)를 잡는다", async () => {
  const source = await Bun.file(join(root, SUPERVISOR_ADMIN_LISTENER)).text();
  expect(supervisorUnixOnly(source)).toBe(true);
  for (const extra of ["Bun.serve({ fetch: () => new Response() });", "Bun.listen({ hostname: h, port: 1, socket: {} });", "net.createServer().listen(1);", "dgram.createSocket('udp4');", "socket.bind(9);", "tls.createServer({});", "await server.listen();"]) {
    expect(supervisorUnixOnly(`${source}\n${extra}\n`), extra).toBe(false);
  }
  // unixOnly 혼자로는 UDP를 잡지 못한다: 위 확인을 따로 두는 까닭.
  expect(unixOnly(`${source}\ndgram.createSocket('udp4');\n`)).toBe(true);
});

test("entrypoints: 감독에서 닿는 코드에 듣는 API는 tls-server.ts와 관리 통로의 경로 유닉스 소켓(admin/listener.ts) 둘뿐이다", async () => {
  const files = await reachable("src/main/supervisor.ts");
  const listeners = [...files].filter(([, source]) => listening.test(source)).map(([file]) => relative(root, file));
  expect(listeners.sort()).toEqual([SUPERVISOR_ADMIN_LISTENER, SUPERVISOR_LISTENER]);
  expect(supervisorUnixOnly(files.get(join(root, SUPERVISOR_ADMIN_LISTENER))!), SUPERVISOR_ADMIN_LISTENER).toBe(true);
  // 그 한 파일의 듣기: tls.createServer 하나와 그 서버의 listen 하나(나머지 ".listen("은 그 파일이 감싼 자기 메서드의 호출이다).
  const source = files.get(join(root, SUPERVISOR_LISTENER))!;
  expect([...source.matchAll(/\bcreateServer\(/g)].length).toBe(1);
  expect([...source.matchAll(/\btls\.createServer\(/g)].length).toBe(1);
  expect([...source.matchAll(/\bthis\.server\.listen\(/g)].length).toBe(1);
  expect(supervisorTcpOnly(source)).toBe(true);
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
