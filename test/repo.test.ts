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

// 파일마다 실행된 시험 수는 test/run.ts가 JUnit 결과로 확인한다. 그런데 `.only`는 같은 파일의 다른 시험을,
// `.if(false)`는 그 시험을 결과에 skip으로도 남기지 않고 빼 버린다. 파일에 하나만 남아도 그 확인을 통과하므로 소스에서 막는다.
test("repo: 시험 파일에 건너뛰거나 골라 돌리는 표시가 없다", async () => {
  const skipped = new RegExp(String.raw`\b(test|it|describe)\.(skip|only|todo|if|skipIf|todoIf)\b`);
  for (const file of await list("test/**/*.test.ts")) {
    expect(skipped.test(await readText(file)), file).toBe(false);
  }
});
