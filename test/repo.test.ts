import { expect, test } from "bun:test";
import { list, readText } from "./files.ts";

test("repo: CODEOWNERS는 `* @ukkiee` 한 줄이다(줄을 더하면 homelab 자동 배포 조건이 멈춘다)", async () => {
  expect(await readText(".github/CODEOWNERS")).toBe("* @ukkiee\n");
});

test("repo: build.yaml은 공용 빌드를 SHA가 아닌 app-build 태그 ref로 부른다", async () => {
  const uses = [...(await readText(".github/workflows/build.yaml")).matchAll(/^\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  expect(uses).toHaveLength(1);
  expect(uses[0]).toMatch(/^ukyi-app\/homelab\/\.github\/workflows\/app-build\.yaml@app-build-v\d+\.\d+\.\d+$/);
});

test("repo: Renovate는 자동 병합을 끄고 이미지를 digest로 고정한다", async () => {
  const renovate = JSON.parse(await readText("renovate.json"));
  expect(renovate.automerge).toBe(false);
  expect(renovate.extends).toContain("docker:pinDigests");
});

// bun test는 시험 파일이 0개면 실패하지만, 시험이 0개인 파일만 있으면 0으로 끝난다. 그 구멍을 여기서 막는다.
test("repo: 시험 파일마다 시험이 하나 이상 있고 건너뛰는 표시가 없다", async () => {
  const files = await list("test/**/*.test.ts");
  expect(files.length).toBeGreaterThan(1);
  const skipped = new RegExp(String.raw`\b(test|it|describe)\.(skip|only|todo|if|skipIf|todoIf)\b`);
  for (const file of files) {
    const source = await readText(file);
    expect(/^\s*test\(/m.test(source), file).toBe(true);
    expect(skipped.test(source), file).toBe(false);
  }
});
