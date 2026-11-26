// 작업 공간(src/executor/workspace.ts)을 실제 임시 폴더로 본다: 루트는 남기고 그 아래를 모두 지우며, 심볼릭 링크를 따라가지 않고,
// 같은 uid가 권한을 뺀 폴더도 지우고, 깊은 트리도 지운다. 루트 판정은 정규형 경로의 앞부분만 본다.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insideWorkspace, rootWorkspace, WORKSPACE_ROOT } from "../../src/executor/workspace.ts";

const fresh = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

test("작업 공간: clear는 루트를 남기고 그 아래(숨김 파일, 폴더, 빈 폴더)를 모두 지운 뒤 0을 센다. entries는 루트 바로 아래 수다", async () => {
  const root = fresh("olive-workspace-");
  writeFileSync(join(root, "plain"), "x");
  writeFileSync(join(root, ".credentials.json"), "secret");
  mkdirSync(join(root, "home", ".config", "cli"), { recursive: true });
  writeFileSync(join(root, "home", ".config", "cli", "token"), "secret");
  mkdirSync(join(root, "empty"));
  const space = rootWorkspace(root);
  expect(await space.entries()).toBe(4);
  expect(await space.clear()).toBe(0);
  expect(existsSync(root)).toBe(true);
  expect(readdirSync(root)).toEqual([]);
  expect(await space.entries()).toBe(0);
});

test("작업 공간: 심볼릭 링크는 따라가지 않고 링크만 지운다(루트 밖의 폴더·파일은 그대로)", async () => {
  const root = fresh("olive-workspace-");
  const outside = fresh("olive-outside-");
  writeFileSync(join(outside, "keep"), "outside");
  symlinkSync(outside, join(root, "dir-link"));
  symlinkSync(join(outside, "keep"), join(root, "file-link"));
  mkdirSync(join(root, "nested"));
  symlinkSync(outside, join(root, "nested", "deep-link"));
  expect(await rootWorkspace(root).clear()).toBe(0);
  expect(readdirSync(outside)).toEqual(["keep"]);
  expect(await Bun.file(join(outside, "keep")).text()).toBe("outside");
});

test("작업 공간: 같은 uid가 권한을 뺀 폴더(0000, 0500)와 그 안의 파일도 지운다", async () => {
  const root = fresh("olive-workspace-");
  mkdirSync(join(root, "locked", "inner"), { recursive: true });
  writeFileSync(join(root, "locked", "inner", "file"), "x");
  chmodSync(join(root, "locked", "inner"), 0o500);
  chmodSync(join(root, "locked"), 0o000);
  expect(await rootWorkspace(root).clear()).toBe(0);
  expect(readdirSync(root)).toEqual([]);
});

test("작업 공간: 깊은 트리(200단)도 지운다", async () => {
  const root = fresh("olive-workspace-");
  let path = root;
  for (let i = 0; i < 200; i++) path = join(path, "d");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "leaf"), "x");
  expect(await rootWorkspace(root).clear()).toBe(0);
  expect(readdirSync(root)).toEqual([]);
});

test("작업 공간: 루트를 읽지 못하면 entries·clear가 던진다(대리는 null로 답하고 띄우지 않는다)", async () => {
  const missing = join(fresh("olive-workspace-"), "absent");
  const space = rootWorkspace(missing);
  await expect(space.entries()).rejects.toThrow();
  await expect(space.clear()).rejects.toThrow();
});

test("작업 공간: enter는 루트 아래 하위 폴더만 0700으로 만들고, 루트 자신·루트 밖·정규형이 아닌 경로는 만들지 않는다", async () => {
  const root = fresh("olive-workspace-");
  const space = rootWorkspace(root);
  await space.enter(join(root, "work", "run"));
  expect(statSync(join(root, "work", "run")).mode & 0o777).toBe(0o700);
  const outside = join(fresh("olive-outside-"), "made");
  await space.enter(outside);
  await space.enter(`${root}/../escape`);
  await space.enter(root);
  expect([existsSync(outside), existsSync(join(root, "..", "escape"))]).toEqual([false, false]);
  expect(readdirSync(root)).toEqual(["work"]);
});

test("작업 공간: 루트 판정은 /tmp 자신과 그 아래의 정규형 경로만 받는다", () => {
  expect(WORKSPACE_ROOT).toBe("/tmp");
  for (const path of ["/tmp", "/tmp/work", "/tmp/home/.config"]) expect(insideWorkspace(path), path).toBe(true);
  for (const path of ["/", "/tmpx", "/tmp/../etc", "/tmp/./work", "/tmp//work", "tmp/work", "/work", "/tmp/a\0b"]) expect(insideWorkspace(path), path).toBe(false);
});
