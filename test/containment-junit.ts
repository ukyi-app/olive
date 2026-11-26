// containment 검사(.github/workflows/containment.yaml)의 성공 증거. 시험 파일이 아니라 시험 결과를 읽는 확인이다.
//   bun test/containment-junit.ts <junit.xml>
// 실제 프로세스 사례는 bwrap·python3·nsenter가 없으면 등록되지 않은 채 다른 사례만으로 통과할 수 있다.
// 그래서 bun의 종료 코드만 믿지 않고, JUnit 결과를 XML 문서로 해석해 "실제 프로세스" 사례 중 통과한 것의
// 이름 집합이 아래 EXPECTED와 정확히 같은지 본다. 수만 맞추는 교체(한 사례가 필터 밖으로 빠지고 다른 사례가
// 더해짐)도 이름으로 걸린다.
import { XML } from "bun";
import { existsSync, readFileSync } from "node:fs";

// 함정: containment.test.ts의 실제 프로세스 사례를 더하거나 빼거나 이름을 바꾸면 같은 변경에서 이 목록을 고친다
// (README "실행기 시험의 실제 프로세스"). 목록의 길이가 기대 수다. 문자열은 시험 이름 그대로다.
const EXPECTED: readonly string[] = [
  "실제 프로세스: harness는 bwrap의 표식이 없으면 실제 신호 없이 거부하고 끝난다(밖에서 직접 띄운 경우의 확인)",
  "실제 프로세스 background: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 setsid: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 doublefork: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 envclear: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 termignore: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 nohup: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 stdoutholder: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 forkrace: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 latespawn: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 nondumpable: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 zombieleader: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 role-leave-descendant: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 role-hold-stdout: 남은 후손이 있다가 정리 뒤 0개로 확인되고, 정리 중의 늦은 띄우기는 거부된다",
  "실제 프로세스 foreign: 공간 밖에서 합류한 프로세스가 보이면 전체 신호를 보내지 않아 후손이 살아남고 0도 말하지 않는다",
  "실제 프로세스 pidhop: 검사에 안 잡혀도 kill(-1)이 끝낸다(파일 증인)",
  "실제 프로세스 tighthop: 검사에 안 잡혀도 kill(-1)이 끝낸다(파일 증인)",
  "실제 프로세스: stdout을 쥔 후손이 있어도 역할 프로그램의 끝을 기다리다 멈추지 않는다(결과를 읽는다)",
  "실제 프로세스 hang: 끝나지 않는(TERM을 무시하는) 역할 프로그램도 중단 뒤 0개로 확인된다",
  "실제 프로세스 role-ignore-term: 끝나지 않는(TERM을 무시하는) 역할 프로그램도 중단 뒤 0개로 확인된다",
  "실제 프로세스 clean: 남은 것이 없으면 유예를 기다리지 않는다",
  "실제 프로세스: 실행기가 PID 1이어도 후손을 끝내고, 회수되지 않은 좀비는 세지 않는다",
  "실제 프로세스: 이미 취소된 실행과 없는 실행 파일은 띄우지 않고, 띄운 직후의 취소도 0개로 끝난다",
  "실제 프로세스 대리 setsid: PID 1 대리가 띄운 역할의 후손이 있다가 끝내기 뒤 대리가 남은 수 0을 답하고 독립 계수도 0이다",
  "실제 프로세스 대리 doublefork: PID 1 대리가 띄운 역할의 후손이 있다가 끝내기 뒤 대리가 남은 수 0을 답하고 독립 계수도 0이다",
  "실제 프로세스 대리 termignore: PID 1 대리가 띄운 역할의 후손이 있다가 끝내기 뒤 대리가 남은 수 0을 답하고 독립 계수도 0이다",
  "실제 프로세스 대리 signals: 자식이 PID 1 대리에게 KILL·TERM·INT·HUP을 보내도 대리가 살아 끝내기·세기에 답한다",
  "실제 프로세스 대리 linkdrop: 링크가 끊기면 대리가 link_closed 코드로 끝나고, TERM을 무시하던 후손도 함께 끝난다(파일 증인)",
  "실제 프로세스 대리 nondumpable: 대리가 뜬 뒤에는 같은 uid의 자식이 /proc/1/environ·/proc/1/root를 읽지 못한다(뜨기 전에는 읽었다)",
  "실제 프로세스 대리 cleanfiles: 실제 역할이 작업 공간에 쓴 파일을 끝내기·세기(0) 뒤 링크 clean이 모두 지워 left 0을 답하고, 대리와 따로 본 폴더도 비었다",
  "실제 프로세스 회복: 제어 진입점은 세대 표식이 요청 때와 같으면 닫지 않고 94로 끝나고, 표식이 바뀐 뒤 다시 띄우면 요청의 실행을 남은 0으로 닫고 요청을 지운다",
];
const PREFIX = "실제 프로세스";
const FILE = "test/executor/containment.test.ts";
// 도구 하나가 없을 때 조용히 빠지는 사례다(python3 → 셋, nsenter → foreign). 빠졌을 때 원인을 함께 찍는다.
const CONDITIONAL = ["nondumpable", "zombieleader", "tighthop", "foreign"];
// Bun이 testcase 아래에 쓰는 상태 요소. 이 밖의 자식은 모르는 상태로 보고 통과로 치지 않는다.
const STATUSES = new Set(["skipped", "failure", "error"]);

function stop(problems: string[]): never {
  for (const problem of problems) console.error(`격리 사례 확인 실패: ${problem}`);
  process.exit(1);
}

if (new Set(EXPECTED).size !== EXPECTED.length || EXPECTED.some((name) => !name.startsWith(PREFIX))) {
  stop(["EXPECTED에 같은 이름이 있거나 접두가 다른 이름이 있다."]);
}
if (process.argv.length !== 3) stop(["JUnit 결과 파일 경로 하나만 받는다."]);
const path = process.argv[2]!;
if (!existsSync(path)) stop([`결과 파일이 없다(${path}). bun test가 시험을 하나도 돌리지 않았거나 시작하지 못했다.`]);
const xml = readFileSync(path, "utf8");

// 문서형 선언은 엔티티와 속성 기본값으로 이름을 바꿀 수 있고 Bun은 쓰지 않으므로 받지 않는다.
if (/<!DOCTYPE/i.test(xml)) stop(["결과에 문서형 선언(<!DOCTYPE)이 있다. Bun의 JUnit 형식이 아니다."]);
let root: XML.Node;
try {
  // Bun.XML은 잘 짜인(well-formed) 문서만 받는다: 닫히지 않은 요소, 선언 없는 엔티티, 빈 문서는 예외다.
  root = XML.parse(xml, { compact: false });
} catch (error) {
  stop([`결과를 XML 문서로 해석하지 못했다: ${error instanceof Error ? error.message : String(error)}`]);
}

type Row = { name: string; file: string; status: string };
const rows: Row[] = [];
const shape: string[] = [];
const isNode = (child: unknown): child is XML.Node => typeof child === "object" && child !== null && "name" in child;
const isComment = (child: unknown) => typeof child === "object" && child !== null && "comment" in child;

// 주석은 요소가 아니므로 건너뛴다. 공백 아닌 글자, 처리 명령, 모르는 요소는 형식 문제로 실패시킨다.
// <properties>는 사례의 상태와 무관한 메타데이터라 그 안을 보지 않고 건너뛴다(안에 testcase가 있어도 세지 않는다).
// Bun은 CI 환경 변수(GITHUB_RUN_ID·GITHUB_SHA 등)가 있으면 파일 testsuite 아래에 이것을 쓴다.
function walkSuite(node: XML.Node, where: string) {
  for (const child of node.children) {
    if (typeof child === "string") {
      if (child.trim() !== "") shape.push(`${where} 안에 글자가 있다: ${JSON.stringify(child.trim().slice(0, 60))}`);
    } else if (isComment(child)) {
      continue;
    } else if (isNode(child) && child.name === "properties") {
      continue;
    } else if (!isNode(child)) {
      shape.push(`${where} 안에 처리 명령이 있다`);
    } else if (child.name === "testsuite") {
      walkSuite(child, "testsuite");
    } else if (child.name === "testcase") {
      rows.push(readCase(child));
    } else {
      shape.push(`${where} 안에 모르는 요소 <${child.name}>가 있다`);
    }
  }
}

// 자식 요소가 없으면 통과다. skipped·failure·error와 그 밖의 자식(글자 포함)은 모두 통과가 아니다.
function readCase(node: XML.Node): Row {
  const marks: string[] = [];
  for (const child of node.children) {
    if (typeof child === "string") {
      if (child.trim() !== "") marks.push("모르는 글자");
    } else if (isComment(child)) {
      continue;
    } else if (!isNode(child)) {
      marks.push("모르는 처리 명령");
    } else {
      marks.push(STATUSES.has(child.name) ? child.name : `모르는 자식 <${child.name}>`);
    }
  }
  return { name: node.attributes.name ?? "", file: node.attributes.file ?? "", status: marks.length === 0 ? "passed" : marks.join("+") };
}

if (root.name !== "testsuites") stop([`맨 위 요소가 <testsuites>가 아니라 <${root.name}>다.`]);
walkSuite(root, "testsuites");
const declared = root.attributes.tests ?? "";
if (!/^\d+$/.test(declared) || Number(declared) !== rows.length) {
  shape.push(`맨 위 합계(tests="${declared}")와 해석한 testcase 수(${rows.length})가 다르다`);
}

const target = rows.filter((row) => row.name.startsWith(PREFIX));
console.log(`결과 파일: ${path}, testcase ${rows.length}개(실제 프로세스 ${target.length}개, 그 밖 ${rows.length - target.length}개)`);
for (const row of target) console.log(`  [${row.status}] ${row.name}`);

// 형식 문제가 있어도 이름 판정까지 찍어 무엇이 빠졌는지 함께 보인다.
const problems = shape.map((problem) => `형식: ${problem}(Bun의 JUnit 형식을 다시 확인한다)`);
const expected = new Set(EXPECTED);
const seen = new Map<string, number>();
for (const row of target) seen.set(row.name, (seen.get(row.name) ?? 0) + 1);
for (const row of target) {
  if (row.status !== "passed") problems.push(`통과하지 않음(${row.status}): ${row.name}`);
  if (!expected.has(row.name)) problems.push(`기대 목록에 없는 이름: ${row.name}`);
  if (row.file !== FILE) problems.push(`${FILE} 밖의 사례(${row.file}): ${row.name}`);
}
for (const [name, count] of seen) if (count > 1) problems.push(`같은 이름이 ${count}번 기록됐다: ${name}`);
const passed = new Set(target.filter((row) => row.status === "passed").map((row) => row.name));
for (const name of EXPECTED) {
  if (passed.has(name)) continue;
  const tool = CONDITIONAL.some((scenario) => name.startsWith(`${PREFIX} ${scenario}:`)) ? " (python3·nsenter 확인)" : "";
  problems.push(`빠진 이름(통과 기록 없음): ${name}${tool}`);
}

const ok = EXPECTED.filter((name) => passed.has(name)).length;
console.log(`통과 ${ok}/${EXPECTED.length}`);
if (problems.length > 0) stop(problems);
console.log(`격리 사례 확인: 기대한 이름 ${EXPECTED.length}개가 한 번씩 통과, 그 밖의 실제 프로세스 사례와 skip·todo·failure·error 0`);
