// `bun run test`와 Dockerfile의 test 단계가 부르는 시험 명령이다. 시험 러너 밖에서 실제로 실행된 시험의 수를 확인한다.
// bun test는 시험이 0개인 파일(빈 파일, 블록 주석으로 감싼 파일, 호출을 모두 지운 파일)을 결과에서 빼고 0으로 끝난다.
// 그래서 bun test가 낸 JUnit 결과를 읽어, 발견한 시험 파일마다 실행된 시험이 하나 이상인지 대조한다.
// 함정: `bun test`라고 치면 이 파일이 아니라 Bun 내장 러너가 바로 돈다. 이 확인은 `bun run test`로만 돈다.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./files.ts";

// Bun이 시험 파일로 고르는 이름과 같다. node_modules와 점으로 시작하는 폴더는 Bun도 보지 않는다.
const testFile = new Bun.Glob("**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}");

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

const discovered: string[] = [];
for await (const path of testFile.scan({ cwd: root })) {
  if (!path.split("/").includes("node_modules")) discovered.push(path);
}
discovered.sort();

const dir = mkdtempSync(join(tmpdir(), "olive-test-"));
const report = join(dir, "junit.xml");
let exitCode: number;
let xml: string | undefined;
try {
  const run = Bun.spawnSync([process.execPath, "test", "--reporter=junit", `--reporter-outfile=${report}`], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  exitCode = run.exitCode ?? 1;
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
