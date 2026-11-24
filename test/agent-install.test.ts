import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_EXIT } from "../src/agent/agent.ts";
import { EXECUTOR_EXIT } from "../src/executor/runtime.ts";
import { AGENT_INSTALL_EXIT, AGENT_SOURCE, AGENT_TARGET, installAgent } from "../src/main/agent-install.ts";
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

test("agent-install: 고정 경로는 이미지 안 원본과 공유 볼륨 위 대상이고, 종료 코드는 다른 진입점과 겹치지 않는다", () => {
  expect(AGENT_SOURCE).toBe("/opt/olive/olive-agent");
  expect(AGENT_TARGET).toBe("/opt/olive-agent/olive-agent");
  const install = Object.values(AGENT_INSTALL_EXIT);
  expect(new Set(install).size).toBe(install.length);
  const others = [EXIT_NO_ROLE, EXIT_NOT_IMPLEMENTED, ...Object.values(EXECUTOR_EXIT), ...Object.values(ROLE_AGENT_EXIT), ...Object.values(AGENT_EXIT)];
  for (const code of install) {
    expect(others).not.toContain(code);
    expect(code).toBeGreaterThan(0);
    expect(code).toBeLessThan(126);
  }
});
