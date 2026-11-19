// containment 검사(.github/workflows/containment.yaml)의 성공 증거. 시험 파일이 아니라 시험 결과를 읽는 확인이다.
//   bun test/containment-junit.ts <junit.xml>
// 실제 프로세스 사례는 bwrap·python3·nsenter가 없으면 등록되지 않은 채 다른 사례만으로 통과할 수 있다.
// 그래서 bun의 종료 코드만 믿지 않고, JUnit 결과에서 "실제 프로세스" 사례가 서로 다른 이름으로
// 정확히 EXPECTED개 통과하고 skip·todo·failure·error가 0개인지 센다.
import { existsSync, readFileSync } from "node:fs";

// 함정: containment.test.ts에 실제 프로세스 사례를 더하거나 빼면 같은 변경에서 이 수를 고친다(README "실행기 시험의 실제 프로세스").
const EXPECTED = 23;
const PREFIX = "실제 프로세스";
const FILE = "test/executor/containment.test.ts";
// 도구 하나가 없을 때 조용히 빠지는 사례다(python3 → 셋, nsenter → foreign). 수와 따로 이름으로도 확인한다.
const CONDITIONAL = ["nondumpable", "zombieleader", "tighthop", "foreign"];

function attr(attrs: string, name: string): string | undefined {
  const raw = new RegExp(String.raw`\s${name}="([^"]*)"`).exec(attrs)?.[1];
  return raw
    ?.replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function stop(problems: string[]): never {
  for (const problem of problems) console.error(`격리 사례 확인 실패: ${problem}`);
  process.exit(1);
}

if (process.argv.length !== 3) stop(["JUnit 결과 파일 경로 하나만 받는다."]);
const path = process.argv[2]!;
if (!existsSync(path)) stop([`결과 파일이 없다(${path}). bun test가 시험을 하나도 돌리지 않았거나 시작하지 못했다.`]);
const xml = readFileSync(path, "utf8");

// 해석은 test/run.ts와 같다. 속성 값은 따옴표 단위로 건너뛰고, 맨 위 합계와 읽은 수를 대조한다.
const cases = [...xml.matchAll(/<testcase((?:\s+[\w:-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
const declared = Number(attr(/<testsuites\b((?:\s+[\w:-]+="[^"]*")*)/.exec(xml)?.[1] ?? "", "tests"));
if (!Number.isInteger(declared) || declared !== cases.length) {
  stop([`결과의 합계(tests="${declared}")와 읽은 testcase 수(${cases.length})가 다르다. Bun의 JUnit 형식을 다시 확인한다.`]);
}

type Status = "passed" | "skipped" | "failure" | "error";
const rows = cases.map(([, attrs = "", body = ""]) => {
  const tag = /<(skipped|failure|error)\b/.exec(body)?.[1] as Status | undefined;
  return { name: attr(attrs, "name") ?? "", file: attr(attrs, "file") ?? "", status: tag ?? "passed" };
});
const target = rows.filter((row) => row.name.startsWith(PREFIX));
const others = rows.length - target.length;

console.log(`결과 파일: ${path}, testcase ${rows.length}개(실제 프로세스 ${target.length}개, 그 밖 ${others}개)`);
for (const row of target) console.log(`  [${row.status}] ${row.name}`);

const problems: string[] = [];
const passed = target.filter((row) => row.status === "passed");
const names = new Set(passed.map((row) => row.name));
for (const status of ["skipped", "failure", "error"] as const) {
  const hit = target.filter((row) => row.status === status);
  if (hit.length > 0) problems.push(`${status} ${hit.length}개: ${hit.map((row) => row.name).join(" | ")}`);
}
const elsewhere = target.filter((row) => row.file !== FILE);
if (elsewhere.length > 0) problems.push(`${FILE} 밖의 사례: ${elsewhere.map((row) => `${row.file}: ${row.name}`).join(" | ")}`);
if (names.size !== passed.length) problems.push(`같은 이름으로 통과한 사례가 있다(통과 ${passed.length}개, 서로 다른 이름 ${names.size}개).`);
const missing = CONDITIONAL.filter((scenario) => !passed.some((row) => row.name.startsWith(`${PREFIX} ${scenario}:`)));
if (missing.length > 0) problems.push(`통과 기록이 없는 조건부 사례: ${missing.join(", ")}(python3·nsenter 확인)`);
if (target.length !== EXPECTED) problems.push(`실제 프로세스 사례가 ${target.length}개 등록됐다(기대 ${EXPECTED}개).`);

console.log(`통과 ${names.size}/${EXPECTED}`);
if (problems.length > 0 || names.size !== EXPECTED) stop(problems.length > 0 ? problems : [`통과 ${names.size}/${EXPECTED}`]);
console.log(`격리 사례 확인: ${names.size}/${EXPECTED} 통과, skip·todo·failure·error 0`);
