// `bun run test`와 Dockerfile의 test 단계가 부르는 시험 명령이다. 시험 러너 밖에서 실제로 실행된 시험의 수를 확인한다.
// bun test는 시험이 0개인 파일(빈 파일, 블록 주석으로 감싼 파일, 호출을 모두 지운 파일)을 결과에서 빼고 0으로 끝난다.
// 그래서 bun test가 낸 JUnit 결과를 읽어, 발견한 시험 파일마다 실행된 시험이 하나 이상인지 대조한다.
// 발견 목록이 Bun이 실제로 읽는 파일보다 좁으면 빈 파일이 빠져나가므로, 허용 꼴 밖의 시험 이름은 먼저 거절한다.
// 함정: `bun test`라고 치면 이 파일이 아니라 Bun 내장 러너가 바로 돈다. 이 확인은 `bun run test`로만 돈다.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./files.ts";

// 이 저장소가 받는 시험 파일 이름 꼴은 이것 하나다(점으로 시작하지 않는 소문자 `*.test.ts`).
const allowedName = /^[^.][^/]*\.test\.ts$/;
// Bun 1.4.4가 시험 파일로 고를 수 있는 이름보다 넓게 잡는다. Bun은 이름을 소문자로 바꿔
// 확장자 앞이 .test·_test·.spec·_spec으로 끝나는지 보고, 숨김 파일(`.x.test.ts`)도 고른다.
// 확장자가 JS 계열인지는 로더 설정에 달려 있어 확장자는 따지지 않는다.
const bunCandidate = /(\.test|_test|\.spec|_spec)\.[^./]+$/;

function fail(message: string): never {
  console.error(`시험 수 확인 실패: ${message}`);
  process.exit(1);
}

function attr(attrs: string, name: string): string | undefined {
  const raw = new RegExp(String.raw`\s${name}="([^"]*)"`).exec(attrs)?.[1];
  return raw
    ?.replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

if (process.argv.length > 2) fail("인자를 받지 않는다. 일부만 돌리려면 `bun test <이름>`을 쓴다(파일 대조가 맞지 않는다).");

// Bun처럼 이름이 점으로 시작하는 폴더와 node_modules(대소문자 무시)는 들어가지 않는다.
// Bun이 고를 수 있는 이름인데 허용 꼴이 아니면, Bun이 그 파일에서 시험을 몇 개 돌리든 실패시킨다.
// 그런 파일이 비어 있으면 Bun은 결과에 아무것도 남기지 않으므로, 실행 수 대조로는 잡을 수 없다.
// 심링크는 Bun이 따라가는지에 따라 고르는 파일이 달라지므로 훑는 범위 안에 두지 않는다.
const discovered: string[] = [];
const rejected: string[] = [];
const pending = [""];
for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    const lower = entry.name.toLowerCase();
    if (entry.isSymbolicLink()) rejected.push(`${path} (심링크)`);
    else if (entry.isDirectory()) {
      if (!lower.startsWith(".") && lower !== "node_modules") pending.push(path);
    } else if (allowedName.test(entry.name)) discovered.push(path);
    else if (bunCandidate.test(lower)) rejected.push(path);
  }
}
if (rejected.length > 0) {
  fail(`시험 파일은 점으로 시작하지 않는 소문자 *.test.ts만 쓴다. Bun이 시험으로 읽을 수 있는 다른 이름: ${rejected.sort().join(", ")}`);
}
discovered.sort();

// 시험이 만드는 임시 폴더는 이 실행의 부모 폴더 아래(TMPDIR)로 모으고 끝에 부모째 지운다.
// 공용 도구의 afterEach는 Bun이 모듈을 한 번만 읽어 처음 불러온 시험 파일에만 걸리고, 지우는 장치가 없는 도구와
// 제품 코드·bwrap 안의 harness가 tmpdir() 아래에 만드는 폴더도 있어서, 도구마다 지우는 대신 실행 단위로 지운다.
// 이 실행기는 자기 부모만 지우고 다른 폴더는 읽지도 판정하지도 않는다. 공용 TMPDIR에서 다른 실행(다른 PID 공간 포함)이
// 쓰는 폴더나 무관한 폴더를 끝났다고 잘못 볼 수 있어서다. 비정상 종료로 남은 부모는 이 실행기가 치우지 않는다.
const dir = mkdtempSync(join(tmpdir(), "olive-test-"));
const report = join(dir, "junit.xml");
let run: Bun.Subprocess | undefined;
let exitCode = 1;
let xml: string | undefined;
try {
  const scratch = join(dir, "tmp");
  mkdirSync(scratch);
  run = Bun.spawn([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${report}`], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, TMPDIR: scratch },
  });
  await run.exited;
  // 신호로 끝나면 exitCode는 null이고 exited는 128+신호 번호(SIGTERM이면 143)를 준다. 바깥 종료 코드는 신호 종료를 1로 낸다.
  exitCode = run.exitCode ?? 1;
  const file = Bun.file(report);
  if (await file.exists()) xml = await file.text();
} finally {
  // 함정: 자식이 뜬 뒤 어느 줄에서 예외가 나도 자식은 아직 이 폴더를 쓴다. 자식이 끝난 뒤에만 지운다.
  if (run !== undefined) await run.exited;
  rmSync(dir, { recursive: true, force: true });
}
if (exitCode !== 0) process.exit(exitCode);
if (xml === undefined) fail("bun test가 JUnit 결과 파일을 남기지 않았다.");

// 시험 이름에 `>`가 들어가도 끊기지 않도록 속성 값은 따옴표 단위로 건너뛴다.
// 자식이 없는 testcase는 통과, <skipped>(skip·todo)·<failure>·<error>가 있으면 실행되지 않았거나 실패한 시험이다.
const cases = [...xml.matchAll(/<testcase((?:\s+[\w:-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
const declared = Number(attr(/<testsuites\b((?:\s+[\w:-]+="[^"]*")*)/.exec(xml)?.[1] ?? "", "tests"));
// Bun의 결과 형식이 바뀌어 이 해석이 시험을 놓치면, 맨 위 합계와 어긋나 여기서 멈춘다.
if (!Number.isInteger(declared) || declared !== cases.length) {
  fail(`결과의 합계(tests="${declared}")와 읽은 testcase 수(${cases.length})가 다르다. Bun의 JUnit 형식을 다시 확인한다.`);
}

const ran = new Map<string, number>(discovered.map((path) => [path, 0]));
let skipped = 0;
for (const [, attrs = "", body = ""] of cases) {
  const path = attr(attrs, "file");
  if (path === undefined || !ran.has(path)) fail(`발견하지 못한 파일의 시험이 결과에 있다: ${path ?? "(file 속성 없음)"}`);
  if (/<(skipped|failure|error)\b/.test(body)) skipped++;
  else ran.set(path, ran.get(path)! + 1);
}

const total = [...ran.values()].reduce((a, b) => a + b, 0);
if (total === 0) fail("실행된 시험이 0개다.");
const empty = [...ran].filter(([, count]) => count === 0).map(([path]) => path);
if (empty.length > 0) fail(`실행된 시험이 0개인 파일: ${empty.join(", ")}`);
if (skipped > 0) fail(`실행되지 않은 시험(skip·todo)이 ${skipped}개 있다.`);

console.error(`시험 수 확인: 파일 ${discovered.length}개, 실행 ${total}개, 건너뜀 0개`);
