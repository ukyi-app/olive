import { expect, test } from "bun:test";
import { readText } from "./files.ts";

type Stage = { base: string; name?: string; lines: string[] };

// 주석을 빼고 `\` 줄 잇기를 합친 뒤 FROM마다 단계로 나눈다.
async function stages(): Promise<Stage[]> {
  const logical = (await readText("Dockerfile"))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const result: Stage[] = [];
  for (const line of logical) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
    if (from) result.push({ base: from[1]!, name: from[2], lines: [] });
    else result.at(-1)!.lines.push(line);
  }
  return result;
}

function stage(all: Stage[], name: string): Stage {
  const found = all.find((s) => s.name === name);
  expect(found, `단계 ${name}`).toBeDefined();
  return found!;
}

test("dockerfile: 단계는 deps, runtime-files, image-check, test, 이름 없는 최종 단계 순서다", async () => {
  expect((await stages()).map((s) => s.name ?? "(final)")).toEqual([
    "deps",
    "runtime-files",
    "image-check",
    "test",
    "(final)",
  ]);
});

test("dockerfile: deps 단계가 기반 이미지의 bun과 .bun-version을 대조한다", async () => {
  const deps = stage(await stages(), "deps");
  expect(deps.lines.join("\n")).toContain('test "$(bun --version)" = "$(cat .bun-version)"');
});

test("dockerfile: image-check가 최종 파일 내용에서 Bun 버전, hc 없음, /etc/claude-code 없음을 확인한다", async () => {
  const check = stage(await stages(), "image-check").lines.join("\n");
  expect(check).toContain("COPY --from=runtime-files / /rootfs/");
  expect(check).toContain('test "$(env -i /rootfs/usr/local/bin/bun --version)" = "$(cat /app/.bun-version)"');
  expect(check).toContain('test -z "$(find /rootfs -name hc -print -quit)"');
  expect(check).toContain("test ! -e /rootfs/etc/claude-code");
});

test("dockerfile: test 단계가 image-check를 기다리고 타입 검사와 시험을 돌린다", async () => {
  const testStage = stage(await stages(), "test").lines;
  expect(testStage).toContain("COPY --from=image-check /image-check.ok /tmp/image-check.ok");
  expect(testStage).toContain("RUN bun run check && bun test");
});

test("dockerfile: 최종 단계는 runtime-files 위에 uid 65532와 역할 없는 기본 명령만 얹는다", async () => {
  const final = (await stages()).at(-1)!;
  expect(final.base).toBe("runtime-files");
  expect(final.lines).toEqual(["USER 65532:65532", "ENTRYPOINT []", 'CMD ["bun", "src/main/no-role.ts"]']);
});

test("dockerfile: 듣는 포트를 적지 않는다", async () => {
  const lines = (await stages()).flatMap((s) => s.lines);
  expect(lines.filter((line) => /^EXPOSE\b|\bPORT=/i.test(line))).toEqual([]);
});
