import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_EXIT } from "../src/agent/agent.ts";
import { EXECUTOR_EXIT } from "../src/executor/runtime.ts";
import { GENERATION_MARKER } from "../src/executor/store.ts";
import { AGENT_INSTALL_EXIT, AGENT_SOURCE, AGENT_TARGET, GENERATION_TARGET, installAgent, writeGeneration } from "../src/main/agent-install.ts";
import { EXIT_NO_ROLE, EXIT_NOT_IMPLEMENTED } from "../src/main/placeholder.ts";
import { ROLE_AGENT_EXIT } from "../src/main/role-agent.ts";

let dir: string;
let source: string;
let targetDir: string;
let target: string;
// 조각 크기(1MiB)를 넘겨 여러 번 읽는 길을 탄다.
const CONTENT = new Uint8Array(1024 * 1024 + 4099).map((_, i) => (i * 31 + 7) % 251);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "olive-agent-install-"));
  source = join(dir, "image", "olive-agent");
  targetDir = join(dir, "volume");
  target = join(targetDir, "olive-agent");
  mkdirSync(join(dir, "image"));
  mkdirSync(targetDir);
  writeFileSync(source, CONTENT, { mode: 0o755 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const leftovers = () => readdirSync(targetDir).filter((name) => name !== "olive-agent");

test("agent-install: 원본을 대상으로 복사하고 모드 0555, 원본과 같은 sha256을 돌려준다", () => {
  const result = installAgent({ source, target });
  expect(result).toEqual({ ok: true, sha256: sha256(CONTENT), bytes: CONTENT.length });
  expect(new Uint8Array(readFileSync(target))).toEqual(CONTENT);
  expect(statSync(target).mode & 0o7777).toBe(0o555);
  expect(leftovers()).toEqual([]);
});

test("agent-install: 이미 있는 대상(0555)과 앞선 실행이 남긴 임시 파일이 있어도 새 원본으로 덮어쓴다", () => {
  writeFileSync(target, "old", { mode: 0o555 });
  writeFileSync(join(targetDir, ".olive-agent.tmp"), "half");
  expect(installAgent({ source, target }).ok).toBe(true);
  expect(new Uint8Array(readFileSync(target))).toEqual(CONTENT);
  expect(statSync(target).mode & 0o7777).toBe(0o555);
  expect(leftovers()).toEqual([]);
});

test("agent-install: 원본이 없거나 일반 파일이 아니면(폴더, 심링크) source(90)", () => {
  expect(installAgent({ source: join(dir, "image", "none"), target })).toEqual({ ok: false, reason: "source" });
  expect(installAgent({ source: join(dir, "image"), target })).toEqual({ ok: false, reason: "source" });
  const link = join(dir, "image", "link");
  symlinkSync(source, link);
  expect(installAgent({ source: link, target })).toEqual({ ok: false, reason: "source" });
  expect(readdirSync(targetDir)).toEqual([]);
  expect(AGENT_INSTALL_EXIT.source).toBe(90);
});

test("agent-install: 대상 폴더가 없거나 폴더가 아니면 target_dir(91)", () => {
  expect(installAgent({ source, target: join(dir, "missing", "olive-agent") })).toEqual({ ok: false, reason: "target_dir" });
  const file = join(dir, "plain");
  writeFileSync(file, "");
  expect(installAgent({ source, target: join(file, "olive-agent") })).toEqual({ ok: false, reason: "target_dir" });
  expect(AGENT_INSTALL_EXIT.target_dir).toBe(91);
});

// 읽기 전용 폴더로는 root에서 쓰기 실패를 만들 수 없어, 반쯤 쓰고 던지는 복사(디스크 참·쓰기 오류)를 넣는다.
test("agent-install: 복사가 중간에 실패하면 write(92)이고 반쯤 쓴 임시 파일을 지우고 있던 대상은 그대로다", () => {
  writeFileSync(target, "old", { mode: 0o555 });
  const result = installAgent({ source, target }, (_from, to) => {
    writeFileSync(to, CONTENT.subarray(0, 10));
    throw Object.assign(new Error("no space"), { code: "ENOSPC" });
  });
  expect(result).toEqual({ ok: false, reason: "write" });
  expect(readFileSync(target, "utf8")).toBe("old");
  expect(leftovers()).toEqual([]);
  expect(AGENT_INSTALL_EXIT.write).toBe(92);
});

test("agent-install: 대상 자리가 폴더라 rename이 실패하면 write(92)이고 임시 파일을 지운다", () => {
  mkdirSync(join(target, "inner"), { recursive: true });
  expect(installAgent({ source, target })).toEqual({ ok: false, reason: "write" });
  expect(statSync(target).isDirectory()).toBe(true);
  expect(leftovers()).toEqual([]);
});

test("agent-install: 복사한 파일의 sha256이 원본과 다르면 mismatch(93)이고 임시 파일을 지우고 대상은 그대로다", () => {
  writeFileSync(target, "old", { mode: 0o555 });
  const flipped = CONTENT.slice();
  flipped[flipped.length - 1]! ^= 1;
  const result = installAgent({ source, target }, (_from, to) => writeFileSync(to, flipped));
  expect(result).toEqual({ ok: false, reason: "mismatch" });
  expect(readFileSync(target, "utf8")).toBe("old");
  expect(leftovers()).toEqual([]);
  expect(AGENT_INSTALL_EXIT.mismatch).toBe(93);
});

test("agent-install: 복사가 원본 뒤쪽을 잘라도(길이만 다름) mismatch(93)", () => {
  const result = installAgent({ source, target }, (_from, to) => writeFileSync(to, CONTENT.subarray(0, CONTENT.length - 1)));
  expect(result).toEqual({ ok: false, reason: "mismatch" });
  expect(readdirSync(targetDir)).toEqual([]);
});

// 세대 표식(D-104). 제어가 읽는 꼴(GENERATION_MARKER)과 같은 값을 매번 새로, 임시 이름 → rename으로 쓴다.
const markerDir = () => {
  const path = join(dir, "generation");
  mkdirSync(path);
  return path;
};
let seed = 0;
const counting = (bytes: number) => new Uint8Array(bytes).map((_, i) => (seed * 7 + i) % 256);

test("세대 표식: 제어가 읽는 꼴(64자 소문자 16진수, 줄바꿈 없음)로 쓰고 모드 0444, 임시 파일이 남지 않는다. 다시 쓰면 새 값이다", () => {
  const folder = markerDir();
  const marker = join(folder, "marker");
  seed = 1;
  const first = writeGeneration(marker, counting);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(readFileSync(marker, "utf8")).toBe(first.marker);
  expect(GENERATION_MARKER.test(first.marker)).toBe(true);
  expect(statSync(marker).mode & 0o7777).toBe(0o444);
  expect(readdirSync(folder)).toEqual(["marker"]);
  seed = 2;
  const second = writeGeneration(marker, counting);
  expect(second.ok && second.marker !== first.marker).toBe(true);
  expect(readFileSync(marker, "utf8")).toBe(second.ok ? second.marker : "");
  expect(readdirSync(folder)).toEqual(["marker"]);
});

test("세대 표식: 앞선 init이 남긴 임시 파일은 지우고 새로 쓴다(rename으로만 대상에 들어간다)", () => {
  const folder = markerDir();
  const marker = join(folder, "marker");
  writeFileSync(join(folder, ".marker.tmp"), "half");
  seed = 3;
  const result = writeGeneration(marker, counting);
  expect(result.ok).toBe(true);
  expect(readdirSync(folder)).toEqual(["marker"]);
});

test("세대 표식: 폴더가 없거나 폴더가 아니면 generation_dir(95)", () => {
  expect(writeGeneration(join(dir, "missing", "marker"), counting)).toEqual({ ok: false, reason: "generation_dir" });
  const file = join(dir, "plain");
  writeFileSync(file, "");
  expect(writeGeneration(join(file, "marker"), counting)).toEqual({ ok: false, reason: "generation_dir" });
  expect(AGENT_INSTALL_EXIT.generation_dir).toBe(95);
});

test("세대 표식: rename이 실패하거나 난수가 꼴에 맞지 않으면 generation_write(96)이고 임시 파일을 지우며 있던 표식은 그대로다", () => {
  const folder = markerDir();
  const marker = join(folder, "marker");
  writeFileSync(marker, "a".repeat(64), { mode: 0o444 });
  // 난수 길이가 틀리거나 난수가 던지면 대상을 건드리지 않는다.
  expect(writeGeneration(marker, (n) => new Uint8Array(n - 1))).toEqual({ ok: false, reason: "generation_write" });
  expect(
    writeGeneration(marker, () => {
      throw new Error("no entropy");
    }),
  ).toEqual({ ok: false, reason: "generation_write" });
  expect(readFileSync(marker, "utf8")).toBe("a".repeat(64));
  expect(readdirSync(folder)).toEqual(["marker"]);
  // 대상 자리가 폴더면 rename이 실패한다.
  const blocked = join(folder, "blocked");
  mkdirSync(join(blocked, "inner"), { recursive: true });
  expect(writeGeneration(blocked, counting)).toEqual({ ok: false, reason: "generation_write" });
  expect(statSync(blocked).isDirectory()).toBe(true);
  expect(readdirSync(folder).sort()).toEqual(["blocked", "marker"]);
  expect(AGENT_INSTALL_EXIT.generation_write).toBe(96);
});

test("agent-install: 고정 경로는 이미지 안 원본과 공유 볼륨 위 대상이고, 종료 코드는 다른 진입점과 겹치지 않는다", () => {
  expect(AGENT_SOURCE).toBe("/opt/olive/olive-agent");
  expect(AGENT_TARGET).toBe("/opt/olive-agent/olive-agent");
  expect(GENERATION_TARGET).toBe("/opt/olive-generation/marker");
  const install = Object.values(AGENT_INSTALL_EXIT);
  expect(new Set(install).size).toBe(install.length);
  const others = [EXIT_NO_ROLE, EXIT_NOT_IMPLEMENTED, ...Object.values(EXECUTOR_EXIT), ...Object.values(ROLE_AGENT_EXIT), ...Object.values(AGENT_EXIT)];
  for (const code of install) {
    expect(others).not.toContain(code);
    expect(code).toBeGreaterThan(0);
    expect(code).toBeLessThan(126);
  }
});
