import { expect, test } from "bun:test";
import { readText } from "./files.ts";

const pinned = (await readText(".bun-version")).trim();

test("pins: .bun-version은 정확한 x.y.z 한 줄이다", async () => {
  expect(await readText(".bun-version")).toMatch(/^\d+\.\d+\.\d+\n$/);
});

test("pins: 시험을 도는 bun이 .bun-version과 같다", () => {
  expect(Bun.version).toBe(pinned);
});

test("pins: @types/bun이 package.json과 bun.lock에서 .bun-version과 같다", async () => {
  const pkg = JSON.parse(await readText("package.json"));
  expect(pkg.devDependencies["@types/bun"]).toBe(pinned);
  expect(await readText("bun.lock")).toContain(`"@types/bun": ["@types/bun@${pinned}"`);
});

test("pins: package.json의 의존성은 모두 정확한 버전이다", async () => {
  const pkg = JSON.parse(await readText("package.json"));
  const all = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  for (const [name, version] of Object.entries(all)) {
    expect(`${name}@${version}`).toMatch(/@\d+\.\d+\.\d+$/);
  }
});

test("pins: Dockerfile의 oven/bun 기반 이미지는 slim·distroless 둘이고 .bun-version 태그와 digest로 고정된다", async () => {
  const images = (await readText("Dockerfile"))
    .split("\n")
    .map((line) => /^FROM\s+(\S+)/.exec(line)?.[1])
    .filter((image): image is string => image?.startsWith("oven/bun") ?? false);
  const variants = images.map((image) => {
    const match = /^oven\/bun:(\d+\.\d+\.\d+)-(slim|distroless)@sha256:[0-9a-f]{64}$/.exec(image);
    expect(match, image).not.toBeNull();
    expect(match![1]).toBe(pinned);
    return match![2];
  });
  expect(variants).toEqual(["slim", "distroless"]);
});
