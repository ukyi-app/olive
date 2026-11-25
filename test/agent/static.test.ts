// 대리 코드의 정적 확인: 띄우기·신호·/proc은 실행기의 한 자리(launcher.ts, containment.ts)를 거치고,
// 소켓을 열거나 듣지 않고, 환경·시계·타이머·끝내기를 직접 부르지 않는다. bun:ffi는 src/ 전체에서 dumpable.ts와 transport/keepalive-ffi.ts 두 곳이다.
import { expect, test } from "bun:test";
import { list, readText } from "../files.ts";

const files = await list("src/agent/**/*.ts");
const code = async (file: string) =>
  (await readText(file))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

test("정적: 대리 코드는 직접 띄우지 않고, 신호·/proc·정리 코어를 직접 쓰지 않는다", async () => {
  expect(files).toEqual(["src/agent/agent.ts", "src/agent/dumpable.ts", "src/agent/link.ts"]);
  for (const file of files) {
    const source = await code(file);
    expect(/\bBun\.spawn(Sync)?\b|child_process|\bexecFile\b|\bBun\.\$|\bspawn\(/.test(source), file).toBe(false);
    expect(/\bprocess\.kill\b|\/proc\b|containment-core\.ts|node:fs/.test(source), file).toBe(false);
  }
  // 띄우기는 bunLauncher, 정리는 PidSpace.record로만 만든다.
  const agent = await code("src/agent/agent.ts");
  expect(agent).toContain('from "../executor/launcher.ts"');
  expect(agent).toContain("PidSpace.record({ dedicated: true");
});

test("정적: 대리 코드는 소켓을 열거나 듣지 않고, 환경·시계·타이머·끝내기를 직접 부르지 않는다", async () => {
  const banned =
    /\bBun\.(serve|listen|connect|udpSocket|env)\b|\bcreateServer\b|\.listen\(|node:(net|tls|http|https|http2|dgram)\b|\bfetch\(|\bprocess\.(env|exit|on)\b|import\.meta\.env|\bDate\.now\b|\bnew Date\b|\bsetTimeout\b|\bsetInterval\b|\bperformance\.now\b|\bMath\.random\b/;
  for (const file of files) expect(banned.test(await code(file)), file).toBe(false);
});

// 가림의 보장은 CredentialValue까지다(link.ts 머리말). 받은 start 전체가 진단으로 나가는 자리를 대리 코드에 두지 않는다.
test("정적: 대리 코드는 받은 메시지를 로그·inspect로 내보내지 않는다", async () => {
  const banned = /\bconsole\.|\bBun\.inspect\b|node:util\b|\binspect\(|\bprocess\.(stdout|stderr)\b/;
  for (const file of files) expect(banned.test(await code(file)), file).toBe(false);
});

// keepalive-ffi.ts는 감독·실행기 연결의 keepalive 간격·횟수·TCP_USER_TIMEOUT을 넣고 되읽는다(src/transport/keepalive.ts).
test("정적: bun:ffi는 dumpable.ts(prctl 하나)와 transport/keepalive-ffi.ts(getsockopt·setsockopt 둘) 두 곳에서만 libc를 연다", async () => {
  const users: string[] = [];
  for (const file of await list("src/**/*.ts")) if (/bun:ffi/.test(await code(file))) users.push(file);
  expect(users).toEqual(["src/agent/dumpable.ts", "src/transport/keepalive-ffi.ts"]);
  const opened = async (file: string) => {
    const source = await code(file);
    return { dlopen: [...source.matchAll(/\bdlopen\(/g)].length, libc: [...source.matchAll(/\bdlopen\("libc\.so\.6", \{/g)].length, symbols: [...source.matchAll(/^\s+(\w+): \{ args:/gm)].map((match) => match[1]) };
  };
  expect(await opened("src/agent/dumpable.ts")).toEqual({ dlopen: 1, libc: 1, symbols: ["prctl"] });
  expect(await opened("src/transport/keepalive-ffi.ts")).toEqual({ dlopen: 1, libc: 1, symbols: ["getsockopt", "setsockopt"] });
});
