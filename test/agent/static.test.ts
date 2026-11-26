// 대리 코드의 정적 확인: 띄우기·신호·/proc은 실행기의 한 자리(launcher.ts, containment.ts)를 거치고,
// 소켓을 열거나 듣지 않고, 환경·시계·타이머·끝내기를 직접 부르지 않는다. bun:ffi는 src/ 전체에서 dumpable.ts와 transport/keepalive-ffi.ts 두 곳이다.
// libc 기호는 파일마다 하나뿐인 dlopen 호출에 넘긴 객체의 모든 키로 센다. 해석할 수 없는 꼴로 적으면 실패한다.
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

// 파일 안의 dlopen 낱말을 모두 센다. bun:ffi의 이름 가져오기 목록 안의 것만 빼고, 나머지는 쓰임새를 가리지 않고 사용처다
// (호출, 이름과 괄호 사이 공백·줄바꿈, 다른 이름에 담기, 속성 읽기, 문자열 안). 사용처가 하나가 아니면 아래 기호 검사가 그 하나를 볼 수 없다.
function dlopenUses(source: string): number[] {
  const imported = new Set<number>();
  for (const statement of source.matchAll(/\bimport\s*\{[^}]*\}\s*from\s*"bun:ffi"/g)) {
    for (const name of statement[0].matchAll(/\bdlopen\b/g)) imported.add(statement.index + name.index);
  }
  return [...source.matchAll(/\bdlopen\b/g)].map((match) => match.index).filter((at) => !imported.has(at));
}

// 유일한 사용처가 dlopen("libc.so.6", { … }) 호출이면 넘긴 객체 글을 괄호를 세어 떼고, 맨 위 단계의 항목을 모두 "이름: { … }" 꼴로 읽는다.
// 사용처가 하나가 아니거나 그 꼴의 호출이 아니면, 또는 그 꼴이 아닌 항목(펼치기, 계산된 키, 문자열 키, 줄임 키, 값이 객체 글이 아님)이나
// 객체 안의 문자열·주석·나눗셈, 셋째 인자가 있으면 해석할 수 없어 null이다.
// 공백·줄바꿈은 따지지 않는다: 기호를 한 줄로 적든 여러 줄로 적든 같은 키다.
function dlopenSymbols(source: string): string[] | null {
  const uses = dlopenUses(source);
  if (uses.length !== 1) return null;
  const call = /^dlopen\s*\(\s*"libc\.so\.6"\s*,\s*\{/.exec(source.slice(uses[0]!));
  if (call === null) return null;
  const open = uses[0]! + call[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length && end < 0; i++) {
    const ch = source[i]!;
    if ("\"'`/".includes(ch)) return null;
    if ("{[(".includes(ch)) depth += 1;
    if ("}])".includes(ch)) depth -= 1;
    if (depth === 0) end = i;
  }
  if (end < 0 || !/^\s*,?\s*\)/.test(source.slice(end + 1))) return null;
  const entries: string[] = [];
  let level = 0;
  let current = "";
  for (const ch of source.slice(open + 1, end)) {
    if ("{[(".includes(ch)) level += 1;
    if ("}])".includes(ch)) level -= 1;
    if (ch === "," && level === 0) {
      entries.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") entries.push(current);
  const names: string[] = [];
  for (const entry of entries) {
    const match = /^\s*([A-Za-z_$][\w$]*)\s*:\s*\{[\s\S]*\}\s*$/.exec(entry);
    if (match === null) return null;
    names.push(match[1]!);
  }
  return names;
}

// keepalive-ffi.ts는 감독·실행기 연결의 keepalive 간격·횟수·TCP_USER_TIMEOUT을 넣고 되읽고, 넣기 전에 fd의 양 끝 주소를 읽는다(src/transport/keepalive.ts).
test("정적: bun:ffi는 dumpable.ts(prctl 하나)와 transport/keepalive-ffi.ts(getpeername·getsockname·getsockopt·setsockopt 넷) 두 곳에서만 libc를 연다", async () => {
  const users: string[] = [];
  for (const file of await list("src/**/*.ts")) if (/bun:ffi/.test(await code(file))) users.push(file);
  expect(users).toEqual(["src/agent/dumpable.ts", "src/transport/keepalive-ffi.ts"]);
  const opened = async (file: string) => {
    const source = await code(file);
    return { dlopen: dlopenUses(source).length, libc: [...source.matchAll(/\bdlopen\s*\(\s*"libc\.so\.6"\s*,\s*\{/g)].length, symbols: dlopenSymbols(source) };
  };
  expect(await opened("src/agent/dumpable.ts")).toEqual({ dlopen: 1, libc: 1, symbols: ["prctl"] });
  expect(await opened("src/transport/keepalive-ffi.ts")).toEqual({ dlopen: 1, libc: 1, symbols: ["getpeername", "getsockname", "getsockopt", "setsockopt"] });
});
