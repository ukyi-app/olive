import { expect, test } from "bun:test";
import { list, readText } from "../files.ts";

// 계약 모듈은 순수하다: 감독·실행기 구현(그 밖의 src/)을 import하지 않고, 입출력·시계·무작위 값을 쓰지 않는다.
// 시계와 무작위 값(nonce, 요청 ID)은 부르는 쪽이 인자로 준다. node:crypto는 서명·해시만 쓴다(무작위 함수는 막는다).
const transpiler = new Bun.Transpiler({ loader: "ts" });
const files = await list("src/contract/**/*.ts");

test("정적: 계약 모듈은 src/contract/v1 안과 node:crypto만 import한다", async () => {
  expect(files.length).toBeGreaterThan(5);
  for (const file of files) {
    const source = await readText(file);
    for (const { path } of transpiler.scanImports(source)) {
      const ok = path === "node:crypto" || (path.startsWith("./") && !path.includes("..") && file.startsWith("src/contract/v1/"));
      expect(ok, `${file} → ${path}`).toBe(true);
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

test("정적: 그 밖의 src/는 계약을 index.ts로만 import한다", async () => {
  for (const file of await list("src/**/*.ts")) {
    if (file.startsWith("src/contract/")) continue;
    for (const { path } of transpiler.scanImports(await readText(file))) {
      if (path.includes("contract/")) expect(path, file).toMatch(/contract\/v1\/index\.ts$/);
    }
  }
});
