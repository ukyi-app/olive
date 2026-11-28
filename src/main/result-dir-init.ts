// 결과 보관 폴더 준비 진입점(D-177). 감독 파드의 init 컨테이너가 감독과 같은 이미지·같은 uid로 감독보다 먼저 돌린다:
// `bun src/main/result-dir-init.ts`(인자 없음).
// 결과 보관소(src/supervisor/scheduler/result-store-file.ts)는 폴더를 만들지 않고 마지막 이름만 lstat으로 본다. 그 폴더를 이 프로세스 uid 소유·0700으로
// 맞춰 두는 것이 이 진입점의 일이다. 없으면 0700으로 만들고, 있으면 링크 아님·폴더·같은 uid·모드 0700일 때만 통과하고, 같은 uid에서 모드만 다르면
// 0700으로 고친다. 그 밖(링크, 폴더 아님, 다른 uid, 상위 폴더 없음, 확인 실패)은 고치지 않고 98로 끝난다.
// 함정: kubelet은 subPath 폴더가 이미 있으면 만들지 않고, 없으면 root 소유·볼륨 뿌리의 모드로 만든다. 그래서 이 진입점이 감독 컨테이너보다 먼저 돌아
// 폴더를 만들어 두어야 한다. kubelet이 이미 만든 root 소유 폴더는 이 uid로 고칠 수 없어 98로 멈춘다(관리자가 바로잡는다).
// 환경은 감독과 같은 이름 OLIVE_RESULT_DIR 하나만 읽는다. 값은 이 컨테이너에서 보이는 같은 폴더의 경로다(감독과 마운트 자리가 달라 값은 다를 수 있다).
// 듣지 않고 어디에도 붙지 않는다.
import { chmodSync, lstatSync, mkdirSync, type Stats } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import pkg from "../../package.json" with { type: "json" };

export const RESULT_DIR_ENV = "OLIVE_RESULT_DIR";
export const RESULT_DIR_MODE = 0o700;

// 64는 다른 진입점의 사용법, 91은 감독·장부 초기화 진입점의 환경과 같은 뜻이다. 98은 다른 진입점이 쓰지 않는 값이다.
export const RESULT_DIR_INIT_EXIT = {
  ready: 0,
  usage: 64,
  config: 91,
  // 결과 폴더를 받아들이지 않았거나 확인하지 못했다. 사유를 한 줄 찍는다.
  dir: 98,
} as const;

export type DirEntryKind = "directory" | "symlink" | "file" | "other";
export interface DirStat {
  readonly kind: DirEntryKind;
  readonly uid: number;
  // 권한 비트 전체(setuid·setgid·sticky 포함, 0o7777 안).
  readonly mode: number;
}

// 시험이 다른 uid와 중간 실패를 넣을 수 있게 파일 호출을 이 꼴로 받는다. 실패는 던지고 오류의 code(ENOENT 등)로 갈래를 정한다.
export interface DirPort {
  // 링크를 따라가지 않는다.
  lstat(path: string): DirStat;
  // 상위 폴더를 만들지 않는다. 모드는 umask를 지나므로 만든 뒤 다시 본다.
  mkdir(path: string, mode: number): void;
  // 함정: 링크를 따라간다. 그래서 부르기 전과 뒤에 lstat으로 본다.
  chmod(path: string, mode: number): void;
}

const kindOf = (stat: Stats): DirEntryKind => (stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other");

export const nodeDirPort: DirPort = {
  lstat: (path) => {
    const stat = lstatSync(path);
    return { kind: kindOf(stat), uid: stat.uid, mode: stat.mode & 0o7777 };
  },
  mkdir: (path, mode) => {
    mkdirSync(path, { mode });
  },
  chmod: (path, mode) => chmodSync(path, mode),
};

export interface ResultDirInitDeps {
  readonly files: DirPort;
  // 이 프로세스의 uid. 모르면 음수를 넘긴다(그때는 파일을 부르지 않고 98).
  readonly uid: number;
}

export interface ResultDirInitResult {
  readonly code: (typeof RESULT_DIR_INIT_EXIT)[keyof typeof RESULT_DIR_INIT_EXIT];
  readonly line: string;
}

export type ResultDirTarget = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly problem: "missing" | "invalid" };

// 결과 보관소(createFileResultBackend)가 받는 dir과 같은 꼴만 받는다: 절대 경로, 정규화된 꼴, 끝의 `/` 없음, NUL 없음.
// 감독의 settingsFromEnv처럼 빈 값은 없는 것이다. 여기서 더 넓게 받으면 이 진입점이 맞춘 폴더와 감독이 보는 폴더가 갈라질 수 있다.
export function resultDirTarget(env: Readonly<Record<string, string | undefined>>): ResultDirTarget {
  const dir = env[RESULT_DIR_ENV] ?? "";
  if (dir === "") return { ok: false, problem: "missing" };
  if (dir.includes("\0") || !isAbsolute(dir) || normalize(dir) !== dir || (dir.length > 1 && dir.endsWith("/"))) return { ok: false, problem: "invalid" };
  return { ok: true, path: dir };
}

const say = (code: ResultDirInitResult["code"], text: string): ResultDirInitResult => ({ code, line: `olive result-dir-init ${pkg.version}: ${text}\n` });
const stopped = (reason: string) => say(RESULT_DIR_INIT_EXIT.dir, `결과 폴더에서 멈췄다(${reason})`);
const octal = (mode: number) => mode.toString(8).padStart(4, "0");
const codeOf = (error: unknown): unknown => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);
// 사유에는 오류 이름만 싣는다(오류 글에는 경로가 섞인다).
const errnoOf = (error: unknown): string => {
  const code = codeOf(error);
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? code : "unknown";
};

type Look = { readonly kind: "present"; readonly stat: DirStat } | { readonly kind: "absent" } | { readonly kind: "failed"; readonly reason: string };
const KINDS: readonly string[] = ["directory", "symlink", "file", "other"];

function look(files: DirPort, path: string): Look {
  let stat: DirStat;
  try {
    stat = files.lstat(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return { kind: "absent" };
    if (codeOf(error) === "ENOTDIR") return { kind: "failed", reason: "parent_not_directory" };
    return { kind: "failed", reason: `lstat:${errnoOf(error)}` };
  }
  // 꼴이 틀린 답을 "맞다"로 읽지 않는다.
  if (!KINDS.includes(stat?.kind) || !Number.isSafeInteger(stat.uid) || stat.uid < 0 || !Number.isSafeInteger(stat.mode) || stat.mode < 0 || stat.mode > 0o7777) {
    return { kind: "failed", reason: "lstat:malformed" };
  }
  return { kind: "present", stat: { kind: stat.kind, uid: stat.uid, mode: stat.mode } };
}

// 받아들일 수 없는 자리의 사유. null이면 링크가 아니고 이 uid 소유인 폴더다(모드는 따로 본다).
// 다른 uid 소유는 모드가 0700이어도 거절한다: 감독(이 uid)이 그 폴더에 쓸 수 있다는 보장이 없고, 고칠 권한도 없다.
function refusalOf(stat: DirStat, uid: number): string | null {
  if (stat.kind === "symlink") return "symlink";
  if (stat.kind !== "directory") return `not_directory:${stat.kind}`;
  if (stat.uid !== uid) return `uid_mismatch:${stat.uid}:${octal(stat.mode)}`;
  return null;
}

function prepare(files: DirPort, path: string, uid: number): ResultDirInitResult {
  let found = look(files, path);
  if (found.kind === "failed") return stopped(found.reason);
  let created = false;
  if (found.kind === "absent") {
    try {
      files.mkdir(path, RESULT_DIR_MODE);
      created = true;
    } catch (error) {
      if (codeOf(error) === "ENOENT") return stopped("parent_missing");
      if (codeOf(error) === "ENOTDIR") return stopped("parent_not_directory");
      // EEXIST: 그 사이 누가 만들었다. 있던 자리와 같은 조건으로 본다.
      if (codeOf(error) !== "EEXIST") return stopped(`mkdir:${errnoOf(error)}`);
    }
    found = look(files, path);
    if (found.kind === "failed") return stopped(found.reason);
    if (found.kind === "absent") return stopped("verify:absent");
  }
  const refusal = refusalOf(found.stat, uid);
  if (refusal !== null) return stopped(refusal);
  const seen = found.stat.mode;
  // 권한 비트 전체로 견준다. setgid 상위 아래에서 만든 폴더는 setgid를 물려받고, umask가 좁으면 0700보다 좁다.
  if (seen === RESULT_DIR_MODE) return say(RESULT_DIR_INIT_EXIT.ready, created ? "결과 폴더를 만들었다(0700)" : "결과 폴더가 이미 맞다(0700)");
  // 함정: chmod는 링크를 따라간다. 바로 앞의 lstat과 이 호출 사이의 바꿔치기는 막지 못한다. 상위 폴더에 쓰는 것이 이 uid뿐이라는 배포 전제에 기댄다
  // (같은 uid는 어차피 자기 파일의 모드를 바꿀 수 있다). 뒤의 lstat이 링크로 바뀐 자리를 98로 드러낸다.
  try {
    files.chmod(path, RESULT_DIR_MODE);
  } catch (error) {
    return stopped(`chmod:${errnoOf(error)}`);
  }
  const after = look(files, path);
  if (after.kind === "failed") return stopped(after.reason);
  if (after.kind === "absent") return stopped("verify:absent");
  const again = refusalOf(after.stat, uid);
  if (again !== null) return stopped(`verify:${again}`);
  if (after.stat.mode !== RESULT_DIR_MODE) return stopped(`verify:mode:${octal(after.stat.mode)}`);
  return say(
    RESULT_DIR_INIT_EXIT.ready,
    created ? `결과 폴더를 만들고 모드를 0700으로 맞췄다(만든 직후 ${octal(seen)})` : `결과 폴더의 모드를 0700으로 고쳤다(전 ${octal(seen)})`,
  );
}

export function initResultDir(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, deps: ResultDirInitDeps): ResultDirInitResult {
  if (argv.length !== 0) return say(RESULT_DIR_INIT_EXIT.usage, "사용법: bun src/main/result-dir-init.ts (인자 없음)");
  let target: ResultDirTarget;
  try {
    target = resultDirTarget(env);
  } catch {
    target = { ok: false, problem: "invalid" };
  }
  if (!target.ok) return say(RESULT_DIR_INIT_EXIT.config, `환경 ${RESULT_DIR_ENV}이(가) ${target.problem === "missing" ? "없다" : "틀렸다"}`);
  let files: DirPort;
  let uid: number;
  try {
    files = deps.files;
    uid = deps.uid;
  } catch {
    return stopped("deps:threw");
  }
  if (!Number.isSafeInteger(uid) || uid < 0) return stopped("uid:unknown");
  try {
    return prepare(files, target.path, uid);
  } catch {
    return stopped("threw");
  }
}

async function main(): Promise<never> {
  // getuid가 없는 플랫폼이면 -1을 넘겨 98(uid:unknown)로 멈춘다.
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const result = initResultDir(process.argv.slice(2), process.env, { files: nodeDirPort, uid });
  // 출력을 다 쓴 뒤에 끝낸다(파이프에 쓰는 도중 exit로 잘리지 않게).
  await Bun.write(Bun.stderr, result.line);
  process.exit(result.code);
}

if (import.meta.main) await main();
