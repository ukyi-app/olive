import { expect, test } from "bun:test";
import { list, readText } from "../files.ts";

// 계약 모듈은 순수하다: 감독·실행기 구현(그 밖의 src/)을 import하지 않고, 입출력·시계·무작위 값을 쓰지 않는다.
// 시계와 무작위 값(nonce, 요청 ID)은 부르는 쪽이 인자로 준다. node:crypto는 서명·해시만 쓴다(무작위 함수는 막는다).
const transpiler = new Bun.Transpiler({ loader: "ts" });
const files = await list("src/contract/**/*.ts");

test("정적: 계약 모듈은 자기 판 폴더 안과 node:crypto만 import한다(v2는 v1 공개 면도)", async () => {
  expect(files.filter((file) => file.startsWith("src/contract/v1/")).length).toBeGreaterThan(5);
  for (const file of files) {
    const source = await readText(file);
    for (const { path } of transpiler.scanImports(source)) {
      // v2(후보)는 자기 폴더 안과 v1의 공개 면(index.ts) 하나만 더 읽는다. v1 파일의 규칙은 그대로다.
      const inV2 = file.startsWith("src/contract/v2/") && (path === "../v1/index.ts" || (path.startsWith("./") && !path.includes("..")));
      const ok = path === "node:crypto" || (path.startsWith("./") && !path.includes("..") && file.startsWith("src/contract/v1/")) || inV2;
      expect(ok, `${file} → ${path}`).toBe(true);
    }
  }
});

test("정적: v2는 v1을 공개 면으로만 읽고, v1은 v2를 읽지 않는다", async () => {
  const v2Files = files.filter((file) => file.startsWith("src/contract/v2/"));
  expect(v2Files.length).toBeGreaterThan(3);
  for (const file of files) {
    for (const { path } of transpiler.scanImports(await readText(file))) {
      if (file.startsWith("src/contract/v1/")) expect(path.includes("v2"), `${file} → ${path}`).toBe(false);
      if (file.startsWith("src/contract/v2/") && path.includes("v1")) expect(path, file).toBe("../v1/index.ts");
    }
  }
});

// 위 시험이 이미 막지만(../ 금지), 실행기 코드가 생긴 뒤 뜻을 이름으로 남긴다.
test("정적: src/contract/는 src/executor/를 import하지 않는다", async () => {
  for (const file of files) {
    for (const { path } of transpiler.scanImports(await readText(file))) expect(path.includes("executor/"), `${file} → ${path}`).toBe(false);
  }
});

test("정적: 계약 모듈은 입출력·프로세스·시계·무작위 API를 쓰지 않는다", async () => {
  const banned = [
    /\bBun\.\w+/,
    /\bprocess\./,
    /\bDate\.now\b/,
    /\bnew Date\b/,
    /\bperformance\./,
    /\bMath\.random\b/,
    /\brandom(Bytes|UUID|Int|Fill)\b/,
    /\bgetRandomValues\b/,
    /\bfetch\(/,
    /\bsetTimeout\b|\bsetInterval\b/,
    /\brequire\(/,
    /\bimport\(/,
    /node:(fs|net|tls|http|https|http2|dgram|dns|child_process|worker_threads|cluster|os|path)\b/,
  ];
  for (const file of files) {
    const code = (await readText(file))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    for (const pattern of banned) expect(pattern.test(code), `${file}: ${pattern}`).toBe(false);
  }
});

// 계약 폴더 밖이 읽을 수 있는 것은 각 판의 공개 면(v1·v2의 index.ts)뿐이다. 판의 내부 모듈은 막는다.
const CONTRACT_FACE = /contract\/v[12]\/index\.ts$/;

test("정적: 그 밖의 src/는 계약을 index.ts로만 import한다", async () => {
  for (const file of await list("src/**/*.ts")) {
    if (file.startsWith("src/contract/")) continue;
    for (const { path } of transpiler.scanImports(await readText(file))) {
      if (path.includes("contract/")) expect(path, file).toMatch(CONTRACT_FACE);
    }
  }
  // 규칙이 실제로 가르는지 본다: 두 판의 공개 면만 받고, 내부 모듈과 없는 판은 걸린다.
  for (const ok of ["../contract/v1/index.ts", "../contract/v2/index.ts", "../../contract/v2/index.ts"]) expect(ok).toMatch(CONTRACT_FACE);
  for (const bad of ["../contract/v2/limits.ts", "../contract/v2/actions.ts", "../contract/v1/limits.ts", "../contract/v3/index.ts", "../contract/v2/sub/index.ts", "../contract/v2/index.tsx"]) {
    expect(bad).not.toMatch(CONTRACT_FACE);
  }
});
