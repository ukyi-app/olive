import { expect, test } from "bun:test";
import { AGENT_SOURCE } from "../src/main/agent-install.ts";
import { ROLE_AGENT_EXIT } from "../src/main/role-agent.ts";
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

test("dockerfile: 단계는 deps, agent-build, runtime-files, image-check, test, 이름 없는 최종 단계 순서다", async () => {
  expect((await stages()).map((s) => s.name ?? "(final)")).toEqual([
    "deps",
    "agent-build",
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
  expect(check).toContain('expected="$(cat /app/.bun-version)" && test -n "$expected"');
  expect(check).toContain(
    'runtime_version="$(env -i /rootfs/usr/local/bin/bun --version)" && test "$runtime_version" = "$expected"',
  );
  expect(check).toContain('test -z "$(find /rootfs -name hc -print -quit)"');
  expect(check).toContain("test ! -e /rootfs/etc/claude-code");
});

// 대리는 glibc 대상 하나로만 만든다(D-107). musl 대상은 빌드 중 런타임을 내려받고 dumpable.ts의 libc.so.6이 musl에 없다.
// autoload를 끄지 않으면 컴파일 파일이 실행 폴더(역할 컨테이너의 작업 폴더)의 .env·bunfig.toml을 prepare 전에 읽는다.
test("dockerfile: agent-build는 deps 위에서 src/main/role-agent.ts를 glibc 대상(bun-linux-x64)으로, autoload를 끄고 컴파일한다", async () => {
  const build = stage(await stages(), "agent-build");
  expect(build.base).toBe("deps");
  // 줄 잇기(`\`) 앞의 공백이 남으므로 공백을 하나로 모아 견준다.
  expect(build.lines.map((line) => line.replace(/\s+/g, " "))).toEqual([
    "COPY src ./src",
    "RUN bun build --compile --target=bun-linux-x64 --no-compile-autoload-dotenv --no-compile-autoload-bunfig src/main/role-agent.ts --outfile /out/olive-agent",
  ]);
  expect(build.lines.join("\n")).not.toContain("musl");
  // 다른 판의 bun을 받아 쓰는 길(교차 컴파일)을 열지 않는다.
  expect(build.lines.join("\n")).not.toContain("--compile-executable-path");
});

test("dockerfile: runtime-files가 대리를 설치 진입점의 원본 경로로 받고, image-check가 그 파일의 꼴·내장 판·81 종료를 본다", async () => {
  const all = await stages();
  expect(stage(all, "runtime-files").lines).toContain(`COPY --from=agent-build /out/olive-agent ${AGENT_SOURCE}`);
  const check = stage(all, "image-check").lines.join("\n");
  const agent = `/rootfs${AGENT_SOURCE}`;
  expect(check).toContain(`test -f ${agent} && test ! -L ${agent} && test -x ${agent}`);
  expect(check).toContain(
    `agent_version="$(env -i BUN_BE_BUN=1 ${agent} --version)" && test "$agent_version" = "$expected"`,
  );
  expect(check).toContain(`{ env -i ${agent}; test "$?" -eq ${ROLE_AGENT_EXIT.config}; }`);
  // 검사가 모두 && 한 줄로 이어져 결과 파일 만들기 앞에 있다(하나라도 실패하면 test 단계가 돌지 않는다).
  const run = stage(all, "image-check").lines.find((line) => line.startsWith("RUN "))!;
  expect(run.indexOf(`{ env -i ${agent}; test`)).toBeLessThan(run.indexOf("&& touch /image-check.ok"));
  expect(run.indexOf(`{ env -i ${agent}; test`)).toBeGreaterThan(0);
});

// 위 시험은 각 검사가 있는지만 본다. 검사 사이가 ;나 ||로 끊기면 앞 검사의 실패가 결과 파일 만들기를 막지 못하므로,
// image-check의 RUN 하나를 && 로 쪼갠 조각 전체를 차례대로 고정한다. 결과 파일 만들기는 마지막 조각 하나뿐이다.
test("dockerfile: image-check의 모든 검사가 한 RUN에서 && 로만 이어져 결과 파일 만들기의 전제다", async () => {
  const check = stage(await stages(), "image-check").lines;
  const runs = check.filter((line) => line.startsWith("RUN "));
  expect(runs).toHaveLength(1);
  const agent = `/rootfs${AGENT_SOURCE}`;
  expect(
    runs[0]!
      .slice("RUN ".length)
      .replace(/\s+/g, " ")
      .split(" && "),
  ).toEqual([
    'expected="$(cat /app/.bun-version)"',
    'test -n "$expected"',
    "test -f /rootfs/usr/local/bin/bun",
    "test ! -L /rootfs/usr/local/bin/bun",
    'runtime_version="$(env -i /rootfs/usr/local/bin/bun --version)"',
    'test "$runtime_version" = "$expected"',
    'test -z "$(find /rootfs -name hc -print -quit)"',
    "test ! -e /rootfs/etc/claude-code",
    "test ! -L /rootfs/etc/claude-code",
    `test -f ${agent}`,
    `test ! -L ${agent}`,
    `test -x ${agent}`,
    `agent_version="$(env -i BUN_BE_BUN=1 ${agent} --version)"`,
    'test "$agent_version" = "$expected"',
    `{ env -i ${agent}; test "$?" -eq ${ROLE_AGENT_EXIT.config}; }`,
    "touch /image-check.ok",
  ]);
});

test("dockerfile: test 단계가 image-check를 기다리고 타입 검사와 시험을 돌린다", async () => {
  const testStage = stage(await stages(), "test").lines;
  expect(testStage).toContain("COPY --from=image-check /image-check.ok /tmp/image-check.ok");
  expect(testStage).toContain("RUN bun run check && bun run test");
});

test("dockerfile: package.json의 시험 명령은 실행된 시험 수를 확인하는 test/run.ts다", async () => {
  const pkg = JSON.parse(await readText("package.json"));
  expect(pkg.scripts.test).toBe("bun test/run.ts");
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
