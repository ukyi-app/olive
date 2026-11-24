// `bun run test`와 Dockerfile의 test 단계가 부르는 시험 명령이다. 시험 러너 밖에서 실제로 실행된 시험의 수를 확인한다.
// bun test는 시험이 0개인 파일(빈 파일, 블록 주석으로 감싼 파일, 호출을 모두 지운 파일)을 결과에서 빼고 0으로 끝난다.
// 그래서 bun test가 낸 JUnit 결과를 읽어, 발견한 시험 파일마다 실행된 시험이 하나 이상인지 대조한다.
// 발견 목록이 Bun이 실제로 읽는 파일보다 좁으면 빈 파일이 빠져나가므로, 허용 꼴 밖의 시험 이름은 먼저 거절한다.
// 함정: `bun test`라고 치면 이 파일이 아니라 Bun 내장 러너가 바로 돈다. 이 확인은 `bun run test`로만 돈다.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const PARENT = /^olive-test-[A-Za-z0-9]{6}$/;

// /proc/<pid>/stat의 22번째 값(부팅 뒤 시작 시각). pid가 다시 쓰여도 이 값이 달라 다른 프로세스로 가려진다.
function startTime(pid: number | "self"): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

// 비정상 종료(신호, 강제 종료)로 finally를 지나지 못한 옛 부모를 치운다. owner(pid와 시작 시각의 쌍들)를 읽을 수 있고 그 프로세스가 모두 끝난 것만 지운다.
// owner가 없거나 덜 쓰인 부모는 막 만들어진 다른 실행일 수 있어 두고, 다른 사용자의 폴더도 두고 넘어간다.
for (const name of readdirSync(tmpdir())) {
  if (!PARENT.test(name)) continue;
  const path = join(tmpdir(), name);
  try {
    if (lstatSync(path).uid !== process.getuid?.()) continue;
    const fields = readFileSync(join(path, "owner"), "utf8").split(" ");
    if (fields.length % 2 !== 0 || !fields.every((field) => /^\d+$/.test(field))) continue;
    let alive = false;
    for (let i = 0; i < fields.length; i += 2) if (startTime(Number(fields[i])) === fields[i + 1]) alive = true;
    if (alive) continue;
    rmSync(path, { recursive: true, force: true });
  } catch {
    // 읽는 사이 다른 실행이 지웠거나 읽을 수 없으면 건너뛴다.
  }
}

const dir = mkdtempSync(join(tmpdir(), "olive-test-"));
const owner = `${process.pid} ${startTime("self") ?? ""}`;
writeFileSync(join(dir, "owner"), owner);
const scratch = join(dir, "tmp");
mkdirSync(scratch);
const report = join(dir, "junit.xml");
let exitCode: number;
let xml: string | undefined;
try {
  const run = Bun.spawn([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${report}`], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, TMPDIR: scratch },
  });
  // 이 프로세스만 강제로 끝나고 bun test가 살아 있으면 그 시험이 아직 부모 폴더를 쓴다. 다음 실행이 둘 다 끝났는지 보게 함께 적는다.
  writeFileSync(join(dir, "owner"), `${owner} ${run.pid} ${startTime(run.pid) ?? "0"}`);
  exitCode = (await run.exited) ?? 1;
  const file = Bun.file(report);
  if (await file.exists()) xml = await file.text();
} finally {
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
