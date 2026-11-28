// 결과 보관 폴더 준비 진입점(D-177). 실제 진입점을 임시 폴더에 띄워 만들기·통과·고치기·거절을 보고(umask를 넓게·좁게 바꿔서도),
// 다른 uid 소유와 중간 실패·만들기 경쟁은 가짜 파일 포트로 본다. root 소유 폴더를 실제로 만들지 않는다.
// 통과한 폴더를 결과 보관소(createFileResultBackend)가 받는지, 이 진입점이 보관소보다 넓은 경로 꼴을 받지 않는지도 본다.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DirPort, type DirStat, initResultDir, nodeDirPort, RESULT_DIR_ENV, RESULT_DIR_INIT_EXIT } from "../src/main/result-dir-init.ts";
import { SUPERVISOR_ENV } from "../src/main/supervisor.ts";
import { createFileResultBackend } from "../src/supervisor/scheduler/result-store-file.ts";
import { readText, root } from "./files.ts";

const pkg = JSON.parse(await readText("package.json"));
const PREFIX = `olive result-dir-init ${pkg.version}: `;
const STOPPED = (reason: string) => `${PREFIX}결과 폴더에서 멈췄다(${reason})\n`;
const uid = process.getuid?.() ?? -1;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // 시험이 0000 등으로 바꾼 폴더도 지울 수 있게 먼저 열어 둔다.
    try {
      chmodSync(join(dir, "results"), 0o700);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

// 결과 보관소는 마지막 이름만 보지만, 같은 꼴로 견주려고 임시 폴더도 실제 경로를 쓴다.
function tempDir(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "olive-result-dir-"));
  chmodSync(dir, 0o755);
  dirs.push(dir);
  return dir;
}

// umask를 주면 셸에서 umask를 정한 뒤 진입점을 띄운다(init 컨테이너의 런타임 umask가 무엇이든 0700이어야 한다).
function runEntry(env: Record<string, string>, options: { args?: string[]; umask?: string } = {}) {
  const entry = [process.execPath, "src/main/result-dir-init.ts", ...(options.args ?? [])];
  const command = options.umask === undefined ? entry : ["/bin/sh", "-c", 'umask "$1" && shift && exec "$@"', "sh", options.umask, ...entry];
  const result = Bun.spawnSync(command, { cwd: root, env: { PATH: process.env.PATH ?? "", ...env }, timeout: 30_000 });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const modeOf = (path: string) => lstatSync(path).mode & 0o7777;
const octal = (mode: number) => mode.toString(8).padStart(4, "0");

// 장부 폴더의 모양: 장부 파일과 다른 이름. 진입점은 결과 폴더 이름 하나만 건드린다.
function ledgerSiblings(parent: string) {
  writeFileSync(join(parent, "supervisor.db"), "ledger bytes");
  chmodSync(join(parent, "supervisor.db"), 0o640);
  mkdirSync(join(parent, "other"), { mode: 0o755 });
  chmodSync(join(parent, "other"), 0o755);
}
const siblingsOf = (parent: string) => ({
  db: [readFileSync(join(parent, "supervisor.db"), "utf8"), modeOf(join(parent, "supervisor.db"))],
  other: modeOf(join(parent, "other")),
});

// 가짜 파일 포트: 부른 차례대로 정해 둔 답을 낸다(값이면 돌려주고 Error면 던진다). 부른 것을 모두 적는다.
type Answer = DirStat | Error | undefined;
function scripted(...answers: Answer[]) {
  const calls: string[] = [];
  const next = (call: string) => {
    calls.push(call);
    if (answers.length === 0) throw new Error(`예상 밖 호출: ${call}`);
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const files: DirPort = {
    lstat: (path) => next(`lstat ${path}`) as DirStat,
    mkdir: (path, mode) => void next(`mkdir ${path} ${octal(mode)}`),
    chmod: (path, mode) => void next(`chmod ${path} ${octal(mode)}`),
  };
  return { files, calls, left: () => answers.length };
}
const errno = (code: string) => Object.assign(new Error(code), { code });
const dir = (mode: number, fileUid = 65532): DirStat => ({ kind: "directory", uid: fileUid, mode });
const ENV = { [RESULT_DIR_ENV]: "/var/lib/olive/results" };
const P = "/var/lib/olive/results";

test("없으면 0700으로 만들고 0, 결과 보관소가 그 폴더를 받고 장부 파일과 다른 이름은 그대로다", () => {
  const parent = tempDir();
  ledgerSiblings(parent);
  const before = siblingsOf(parent);
  const results = join(parent, "results");
  expect(runEntry({ [RESULT_DIR_ENV]: results })).toEqual({ code: 0, stdout: "", stderr: `${PREFIX}결과 폴더를 만들었다(0700)\n` });
  expect([lstatSync(results).isDirectory(), lstatSync(results).uid, modeOf(results)]).toEqual([true, uid, 0o700]);
  expect(readdirSync(results)).toEqual([]);
  expect(siblingsOf(parent)).toEqual(before);
  expect(readdirSync(parent).sort()).toEqual(["other", "results", "supervisor.db"]);
  expect(createFileResultBackend({ dir: results, maxRecordBytes: 1024 }).status).toBe("ok");
});

test("이미 같은 uid·0700 폴더면 0이고 파일 호출은 lstat 하나, 안의 것도 그대로다", () => {
  const parent = tempDir();
  const results = join(parent, "results");
  mkdirSync(results, { mode: 0o700 });
  chmodSync(results, 0o700);
  writeFileSync(join(results, "kept"), "body");
  expect(runEntry({ [RESULT_DIR_ENV]: results })).toEqual({ code: 0, stdout: "", stderr: `${PREFIX}결과 폴더가 이미 맞다(0700)\n` });
  expect([modeOf(results), readdirSync(results), readFileSync(join(results, "kept"), "utf8")]).toEqual([0o700, ["kept"], "body"]);
  const fake = scripted(dir(0o700));
  expect(initResultDir([], ENV, { files: fake.files, uid: 65532 })).toEqual({ code: 0, line: `${PREFIX}결과 폴더가 이미 맞다(0700)\n` });
  expect(fake.calls).toEqual([`lstat ${P}`]);
});

test("같은 uid이고 모드만 다르면(setuid·setgid·sticky 포함) 0700으로 고치고 0, 안의 것은 그대로다", () => {
  const parent = tempDir();
  const results = join(parent, "results");
  mkdirSync(results);
  writeFileSync(join(results, "kept"), "body");
  chmodSync(results, 0o777);
  expect(runEntry({ [RESULT_DIR_ENV]: results })).toEqual({ code: 0, stdout: "", stderr: `${PREFIX}결과 폴더의 모드를 0700으로 고쳤다(전 0777)\n` });
  expect([modeOf(results), readFileSync(join(results, "kept"), "utf8")]).toEqual([0o700, "body"]);
  for (const mode of [0o755, 0o750, 0o000, 0o500, 0o4700, 0o2700, 0o1700, 0o3777]) {
    chmodSync(results, mode);
    // 전제: 이 파일 시스템이 그 비트를 실제로 남긴다.
    expect(octal(modeOf(results))).toBe(octal(mode));
    const result = initResultDir([], { [RESULT_DIR_ENV]: results }, { files: nodeDirPort, uid });
    expect([octal(mode), result]).toEqual([octal(mode), { code: 0, line: `${PREFIX}결과 폴더의 모드를 0700으로 고쳤다(전 ${octal(mode)})\n` }]);
    expect(octal(modeOf(results))).toBe("0700");
  }
  const fake = scripted(dir(0o2755), undefined, dir(0o700));
  expect(initResultDir([], ENV, { files: fake.files, uid: 65532 }).code).toBe(0);
  expect(fake.calls).toEqual([`lstat ${P}`, `chmod ${P} 0700`, `lstat ${P}`]);
});

test("링크면(폴더를 가리켜도, 끊긴 링크여도) 고치지 않고 98이며 가리키는 폴더의 모드도 그대로다", () => {
  const parent = tempDir();
  const target = join(parent, "real");
  mkdirSync(target);
  chmodSync(target, 0o755);
  const results = join(parent, "results");
  symlinkSync(target, results);
  expect(runEntry({ [RESULT_DIR_ENV]: results })).toEqual({ code: 98, stdout: "", stderr: STOPPED("symlink") });
  expect([lstatSync(results).isSymbolicLink(), modeOf(target)]).toEqual([true, 0o755]);
  const dangling = join(parent, "dangling");
  symlinkSync(join(parent, "absent"), dangling);
  expect(runEntry({ [RESULT_DIR_ENV]: dangling })).toEqual({ code: 98, stdout: "", stderr: STOPPED("symlink") });
  expect(readdirSync(parent).sort()).toEqual(["dangling", "real", "results"]);
});

test("일반 파일이면 고치지 않고 98이며 바이트와 모드가 그대로다", () => {
  const parent = tempDir();
  const results = join(parent, "results");
  writeFileSync(results, "not a dir");
  chmodSync(results, 0o644);
  expect(runEntry({ [RESULT_DIR_ENV]: results })).toEqual({ code: 98, stdout: "", stderr: STOPPED("not_directory:file") });
  expect([readFileSync(results, "utf8"), modeOf(results)]).toEqual(["not a dir", 0o644]);
  const fake = scripted({ kind: "other", uid: 65532, mode: 0o700 });
  expect(initResultDir([], ENV, { files: fake.files, uid: 65532 })).toEqual({ code: 98, line: STOPPED("not_directory:other") });
  expect(fake.calls).toEqual([`lstat ${P}`]);
});

test("상위 폴더가 없거나 폴더가 아니면 98이고 상위를 만들지 않는다", () => {
  const parent = tempDir();
  expect(runEntry({ [RESULT_DIR_ENV]: join(parent, "absent", "results") })).toEqual({ code: 98, stdout: "", stderr: STOPPED("parent_missing") });
  expect(readdirSync(parent)).toEqual([]);
  writeFileSync(join(parent, "file"), "x");
  expect(runEntry({ [RESULT_DIR_ENV]: join(parent, "file", "results") })).toEqual({ code: 98, stdout: "", stderr: STOPPED("parent_not_directory") });
  expect(readdirSync(parent)).toEqual(["file"]);
});

test("환경이 없거나 빈 값이면 없다로, 상대·정규화되지 않은 경로면 틀렸다로 91이고 아무것도 만들지 않는다. 인자가 있으면 64다", () => {
  const parent = tempDir();
  const missing = `${PREFIX}환경 OLIVE_RESULT_DIR이(가) 없다\n`;
  const invalid = `${PREFIX}환경 OLIVE_RESULT_DIR이(가) 틀렸다\n`;
  expect(runEntry({})).toEqual({ code: 91, stdout: "", stderr: missing });
  expect(runEntry({ [RESULT_DIR_ENV]: "" })).toEqual({ code: 91, stdout: "", stderr: missing });
  for (const value of ["results", "./results", `${parent}/results/`, `${parent}//results`, `${parent}/x/../results`, `${parent}/./results`]) {
    expect([value, runEntry({ [RESULT_DIR_ENV]: value })]).toEqual([value, { code: 91, stdout: "", stderr: invalid }]);
  }
  expect(runEntry({ [RESULT_DIR_ENV]: join(parent, "results") }, { args: ["--fix"] })).toEqual({
    code: 64,
    stdout: "",
    stderr: `${PREFIX}사용법: bun src/main/result-dir-init.ts (인자 없음)\n`,
  });
  expect(readdirSync(parent)).toEqual([]);
  // NUL은 환경으로 넘길 수 없어 함수로 본다. 파일을 부르지 않는다.
  const fake = scripted();
  expect(initResultDir([], { [RESULT_DIR_ENV]: "/var/lib/olive/res\0ults" }, { files: fake.files, uid: 65532 })).toEqual({ code: 91, line: invalid });
  expect(fake.calls).toEqual([]);
});

test("다른 uid 소유면(모드가 0700이어도) 고치지 않고 98, 사유에 찾은 uid와 모드를 싣는다", () => {
  for (const [stat, reason] of [
    [dir(0o777, 0), "uid_mismatch:0:0777"],
    [dir(0o700, 0), "uid_mismatch:0:0700"],
    [dir(0o700, 1000), "uid_mismatch:1000:0700"],
  ] as const) {
    const fake = scripted(stat);
    expect(initResultDir([], ENV, { files: fake.files, uid: 65532 })).toEqual({ code: 98, line: STOPPED(reason) });
    expect(fake.calls).toEqual([`lstat ${P}`]);
  }
  // 만들기 경쟁에서 이긴 쪽이 다른 uid여도 같다.
  const race = scripted(errno("ENOENT"), errno("EEXIST"), dir(0o777, 0));
  expect(initResultDir([], ENV, { files: race.files, uid: 65532 })).toEqual({ code: 98, line: STOPPED("uid_mismatch:0:0777") });
  expect(race.calls).toEqual([`lstat ${P}`, `mkdir ${P} 0700`, `lstat ${P}`]);
});

test("umask가 넓어도(000) 좁아도(077·277·777) 만든 폴더는 0700이고, setgid 상위 아래에서도 0700이다", () => {
  for (const [mask, line] of [
    ["000", "결과 폴더를 만들었다(0700)"],
    ["022", "결과 폴더를 만들었다(0700)"],
    ["077", "결과 폴더를 만들었다(0700)"],
    ["277", "결과 폴더를 만들고 모드를 0700으로 맞췄다(만든 직후 0500)"],
    ["777", "결과 폴더를 만들고 모드를 0700으로 맞췄다(만든 직후 0000)"],
  ] as const) {
    const parent = tempDir();
    const results = join(parent, "results");
    expect([mask, runEntry({ [RESULT_DIR_ENV]: results }, { umask: mask })]).toEqual([mask, { code: 0, stdout: "", stderr: `${PREFIX}${line}\n` }]);
    expect([mask, octal(modeOf(results)), lstatSync(results).uid]).toEqual([mask, "0700", uid]);
  }
  // setgid 상위 아래에 만든 폴더는 setgid를 물려받는다. 그 비트도 지워 0700으로 맞춘다.
  const parent = tempDir();
  chmodSync(parent, 0o2755);
  expect(octal(modeOf(parent))).toBe("2755");
  const results = join(parent, "results");
  expect(runEntry({ [RESULT_DIR_ENV]: results }, { umask: "022" })).toEqual({
    code: 0,
    stdout: "",
    stderr: `${PREFIX}결과 폴더를 만들고 모드를 0700으로 맞췄다(만든 직후 2700)\n`,
  });
  expect(octal(modeOf(results))).toBe("0700");
});

test("만들기 경쟁(EEXIST)은 있는 자리의 길로 간다", () => {
  const ok = scripted(errno("ENOENT"), errno("EEXIST"), dir(0o700));
  expect(initResultDir([], ENV, { files: ok.files, uid: 65532 })).toEqual({ code: 0, line: `${PREFIX}결과 폴더가 이미 맞다(0700)\n` });
  const fix = scripted(errno("ENOENT"), errno("EEXIST"), dir(0o755), undefined, dir(0o700));
  expect(initResultDir([], ENV, { files: fix.files, uid: 65532 })).toEqual({ code: 0, line: `${PREFIX}결과 폴더의 모드를 0700으로 고쳤다(전 0755)\n` });
  expect(fix.calls).toEqual([`lstat ${P}`, `mkdir ${P} 0700`, `lstat ${P}`, `chmod ${P} 0700`, `lstat ${P}`]);
  const link = scripted(errno("ENOENT"), errno("EEXIST"), { kind: "symlink", uid: 65532, mode: 0o777 });
  expect(initResultDir([], ENV, { files: link.files, uid: 65532 })).toEqual({ code: 98, line: STOPPED("symlink") });
  expect(link.left()).toBe(0);
});

test("확인 실패는 고치지 않고 98이고, 고친 뒤 다시 본 것이 조건과 다르면 98이다", () => {
  const cases: [Answer[], string, string[]][] = [
    [[errno("EACCES")], "lstat:EACCES", ["lstat"]],
    [[errno("EIO")], "lstat:EIO", ["lstat"]],
    [[errno("ENOTDIR")], "parent_not_directory", ["lstat"]],
    [[new Error("no code")], "lstat:unknown", ["lstat"]],
    [[{ kind: "directory", uid: Number.NaN, mode: 0o700 } as DirStat], "lstat:malformed", ["lstat"]],
    [[{ kind: "directory", uid: 65532, mode: 0o10700 } as DirStat], "lstat:malformed", ["lstat"]],
    [[{ kind: "socket", uid: 65532, mode: 0o700 } as unknown as DirStat], "lstat:malformed", ["lstat"]],
    [[errno("ENOENT"), errno("EROFS")], "mkdir:EROFS", ["lstat", "mkdir"]],
    [[errno("ENOENT"), errno("EACCES")], "mkdir:EACCES", ["lstat", "mkdir"]],
    [[errno("ENOENT"), errno("ENOENT")], "parent_missing", ["lstat", "mkdir"]],
    [[errno("ENOENT"), undefined, errno("ENOENT")], "verify:absent", ["lstat", "mkdir", "lstat"]],
    [[errno("ENOENT"), undefined, errno("EIO")], "lstat:EIO", ["lstat", "mkdir", "lstat"]],
    [[errno("ENOENT"), errno("EEXIST"), errno("ENOENT")], "verify:absent", ["lstat", "mkdir", "lstat"]],
    [[dir(0o755), errno("EPERM")], "chmod:EPERM", ["lstat", "chmod"]],
    [[dir(0o755), undefined, dir(0o755)], "verify:mode:0755", ["lstat", "chmod", "lstat"]],
    [[dir(0o755), undefined, { kind: "symlink", uid: 65532, mode: 0o777 }], "verify:symlink", ["lstat", "chmod", "lstat"]],
    [[dir(0o755), undefined, dir(0o700, 0)], "verify:uid_mismatch:0:0700", ["lstat", "chmod", "lstat"]],
    [[dir(0o755), undefined, errno("ENOENT")], "verify:absent", ["lstat", "chmod", "lstat"]],
    [[errno("ENOENT"), undefined, dir(0o500), undefined, dir(0o500)], "verify:mode:0500", ["lstat", "mkdir", "lstat", "chmod", "lstat"]],
  ];
  for (const [answers, reason, calls] of cases) {
    const fake = scripted(...answers);
    expect([reason, initResultDir([], ENV, { files: fake.files, uid: 65532 })]).toEqual([reason, { code: 98, line: STOPPED(reason) }]);
    expect([reason, fake.calls.map((call) => call.split(" ")[0])]).toEqual([reason, calls]);
    expect([reason, fake.left()]).toEqual([reason, 0]);
  }
});

test("이 프로세스의 uid를 모르거나 포트를 읽다 던지면 파일을 부르지 않고 98이다", () => {
  for (const bad of [-1, Number.NaN, 1.5]) {
    const fake = scripted();
    expect(initResultDir([], ENV, { files: fake.files, uid: bad })).toEqual({ code: 98, line: STOPPED("uid:unknown") });
    expect(fake.calls).toEqual([]);
  }
  const throwing = {
    get files(): DirPort {
      throw new Error("boom");
    },
    uid: 65532,
  };
  expect(initResultDir([], ENV, throwing)).toEqual({ code: 98, line: STOPPED("deps:threw") });
});

test("감독과 같은 환경 이름을 쓰고, 결과 보관소가 거절하는 경로 꼴은 받지 않는다", () => {
  expect((SUPERVISOR_ENV as readonly string[]).includes(RESULT_DIR_ENV)).toBe(true);
  for (const value of ["/", "/a", "/a/b", "/a/", "/a//b", "/a/../b", "/a/./b", "//a", "a", "./a", "/a\0b"]) {
    const store = createFileResultBackend({ dir: value, maxRecordBytes: 1, files: { lstat: () => ({ kind: "directory", size: 0, dev: 0n, ino: 0n }) } as never });
    const fake = scripted(dir(0o700));
    const init = initResultDir([], { [RESULT_DIR_ENV]: value }, { files: fake.files, uid: 65532 });
    const storeRefuses = store.status === "invalid" && store.reason === "dir";
    // 보관소가 꼴로 거절하는 값은 이 진입점도 파일을 부르기 전에 91로 거절한다.
    if (storeRefuses) expect([value, init.code, fake.calls]).toEqual([value, 91, []]);
    else expect([value, init.code]).toEqual([value, 0]);
  }
});
