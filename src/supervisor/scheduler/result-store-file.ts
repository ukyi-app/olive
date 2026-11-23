// 결과 보관소 백엔드 포트(result-store.ts의 ResultBackend)의 파일 구현. 인자로 받은 폴더 하나 안에서만 바이트를 두고 읽는다.
// 무엇을 받아들이고 누구에게 내주는지는 판단(result-store.ts)이 정한다. 여기는 키 하나를 파일 하나로 옮기는 것만 한다.
//
// 틀리는 방향은 늘 닫는 쪽이다.
// - 새로 두기는 임시 이름에 끝까지 쓰고 fsync한 뒤 link로 이름을 붙인다. link는 이미 있는 이름을 덮지 않는다(EEXIST).
//   그래서 키의 이름에는 다 쓰인 바이트만 나타나고, 있는 키는 바뀌지 않는다.
// - 이미 있는 키에 답하는 exists도 폴더를 디스크에 내렸다고 확인한 뒤에만 낸다. 앞선 넣기가 폴더를 내리지 못하고 끝났을 수 있다.
// - "없음"(absent)은 그 이름이 없고 폴더는 있다고 확인했을 때만이다. 권한·I/O 오류·폴더 없음·파일이 아닌 항목은 unknown이다.
// - 키의 꼴(result/<UUID>)이 아니면 파일 시스템을 부르기 전에 unknown(reason: invalid_key)으로 거절한다.
//   포트의 답 갈래에 "꼴이 틀린 키"가 없어서 unknown에 사유를 덧붙인다. 판단은 status만 보므로 unknown으로 읽는다.
//
// 전제: 이 폴더를 쓰는 프로세스는 하나다(감독 하나). 포트가 동기라 한 프로세스 안에서는 호출이 겹치지 않는다.
// 두 프로세스가 같은 폴더를 쓰는 것은 막지 않는다(잠금이 없다). 그때도 있는 키를 덮지는 않지만, 같은 키를 동시에 쓰면
// 한쪽이 다른 쪽의 임시 파일을 지우고 다시 만들 수 있어 다 쓰이지 않은 바이트가 그 키로 보일 수 있다. 설명 문서 "두 프로세스".
import { type BigIntStats, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, constants as open, readdirSync, readSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { BackendRead, ResultBackend } from "./result-store.ts";

// ---- 파일 포트 ----

// 시험이 중간 실패를 넣을 수 있게 파일 호출을 이 꼴로 받는다. 실패는 던지고, 오류의 code(ENOENT 등)로 갈래를 정한다.
export type EntryKind = "file" | "directory" | "other";
export interface FileStat {
  readonly kind: EntryKind;
  readonly size: number;
  readonly dev: bigint;
  readonly ino: bigint;
}
export interface FilePort {
  open(path: string, flags: number, mode?: number): number;
  write(fd: number, bytes: Uint8Array, offset: number, length: number): number;
  read(fd: number, bytes: Uint8Array, offset: number, length: number, position: number): number;
  fsync(fd: number): void;
  close(fd: number): void;
  fstat(fd: number): FileStat;
  // 링크를 따라가지 않는다.
  lstat(path: string): FileStat;
  link(from: string, to: string): void;
  unlink(path: string): void;
  readdir(path: string): readonly string[];
}

const kindOf = (stat: { isFile(): boolean; isDirectory(): boolean }): EntryKind => (stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other");
// ino는 bigint로 읽는다. number로는 큰 inode 번호가 뭉개져 다른 파일을 같은 파일로 볼 수 있다.
const statOf = (stat: BigIntStats): FileStat => ({ kind: kindOf(stat), size: Number(stat.size), dev: stat.dev, ino: stat.ino });

export const nodeFilePort: FilePort = {
  open: (path, flags, mode) => openSync(path, flags, mode),
  write: (fd, bytes, offset, length) => writeSync(fd, bytes, offset, length),
  read: (fd, bytes, offset, length, position) => readSync(fd, bytes, offset, length, position),
  fsync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
  fstat: (fd) => statOf(fstatSync(fd, { bigint: true })),
  lstat: (path) => statOf(lstatSync(path, { bigint: true })),
  link: (from, to) => linkSync(from, to),
  unlink: (path) => unlinkSync(path),
  readdir: (path) => readdirSync(path),
};

// ---- 답 ----

// unknown의 사유. 판단에는 status만 닿는다. 사유는 진단과 시험을 위한 것이고, 경로·바이트를 싣지 않는다.
export type FileUnknownReason =
  // 키가 result/<UUID> 꼴이 아니다. 파일 시스템을 부르지 않았다.
  | "invalid_key"
  // 바이트·범위·접두가 정한 꼴이 아니다. 파일 시스템을 부르지 않았다.
  | "invalid_input"
  // 정책의 상한을 넘는다(넣기는 부르기 전에, 읽기는 파일의 크기를 보고).
  | "too_large"
  // 그 이름에 일반 파일이 아닌 것(폴더, 링크, 장치 등)이 있다.
  | "not_file"
  // 폴더가 없거나 폴더가 아니다.
  | "no_dir"
  // 읽는 사이 파일이 바뀌었거나, 링크한 것이 이 호출이 쓴 파일이 아니다.
  | "changed"
  // 그 밖의 파일 시스템 오류(권한, I/O, 공간 등)와 결과를 알 수 없는 실패.
  | "io";
export type FileUnknown = { readonly status: "unknown"; readonly reason: FileUnknownReason };

// 포트의 답보다 좁지 않게, unknown에만 사유를 더한 꼴. ResultBackend 자리에 그대로 넣을 수 있다.
export interface FileResultBackend extends ResultBackend {
  putNew(key: string, bytes: Uint8Array): { readonly status: "stored" } | { readonly status: "exists" } | FileUnknown;
  read(key: string): Exclude<BackendRead, { status: "unknown" }> | FileUnknown;
  readRange(key: string, offset: number, length: number): Exclude<BackendRead, { status: "unknown" }> | FileUnknown;
  remove(key: string): { readonly status: "removed" } | { readonly status: "absent" } | FileUnknown;
  has(key: string): { readonly status: "present" } | { readonly status: "absent" } | FileUnknown;
  keys(prefix: string): { readonly status: "ok"; readonly keys: readonly string[] } | FileUnknown;
}

export interface FileBackendOptions {
  // 보관 폴더의 절대 경로. 정규화된 꼴이고, 링크가 아닌 실제 폴더여야 한다(만들 때 확인한다).
  // 상위 경로의 링크와 폴더의 바꿔치기는 막지 않는다: 부르는 쪽이 링크 없는 실제 경로와 바뀌지 않는 상위 폴더를 넘긴다.
  // 폴더를 만들거나 권한을 정하지 않는다(자리는 D-78에서 정하지 않았다).
  readonly dir: string;
  // 기록 하나(판단이 넘기는 바이트 전체)의 상한. 넣기는 이보다 크면 거절하고, 읽기는 이보다 큰 파일을 읽지 않는다.
  // 운영 값은 정해지지 않았다. 판단의 기록은 [4바이트][머리][본문 ≤ RESULT_MAX_BYTES]라 그보다 넉넉해야 한다.
  readonly maxRecordBytes: number;
  // 없으면 node:fs.
  readonly files?: FilePort;
}

// not_dir: 그 경로가 링크가 아닌 실제 폴더라고 확인하지 못했다(없음, 폴더가 아님, 링크, 확인 실패).
export type FileBackendAnswer =
  | { readonly status: "ok"; readonly backend: FileResultBackend }
  | { readonly status: "invalid"; readonly reason: "dir" | "max_record_bytes" | "not_dir" };

// ---- 꼴 ----

// 판단(result-store.ts)이 만드는 키와 같은 꼴. 이 꼴은 경로 구분자·`..`·빈 이름을 담을 수 없고 길이가 고정이다.
const KEY = /^result\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_PREFIX = "result/";
// 임시 이름은 점으로 시작해 NAME에 맞지 않는다. 그래서 keys에 나오지 않는다.
const tempNameOf = (name: string) => `.${name}.partial`;

const CHUNK = 64 * 1024;
const NEW_FILE = open.O_CREAT | open.O_EXCL | open.O_WRONLY | open.O_NOFOLLOW;
// O_NONBLOCK: 그 이름에 FIFO가 있으면 여는 데서 멈추지 않고, 아래 fstat에서 not_file로 거절한다. 일반 파일에는 영향이 없다.
const READ_FILE = open.O_RDONLY | open.O_NOFOLLOW | open.O_NONBLOCK;
const DIR = open.O_RDONLY | open.O_DIRECTORY;

const unknown = (reason: FileUnknownReason): FileUnknown => ({ status: "unknown", reason });
const codeOf = (error: unknown): unknown => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function nameOf(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const match = KEY.exec(key);
  return match === null ? null : (match[1] as string);
}

// 보관 폴더가 링크가 아닌 실제 폴더인가. 만들기와 연산이 이 하나로 본다.
// lstat은 마지막 이름의 링크만 따라가지 않는다. 상위 경로의 링크와 폴더의 바꿔치기는 여기서 막지 못한다.
function dirStateOf(files: FilePort, dir: string): "dir" | "no_dir" | "io" {
  try {
    return files.lstat(dir).kind === "directory" ? "dir" : "no_dir";
  } catch (error) {
    return codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR" ? "no_dir" : "io";
  }
}

// ---- 만들기 ----

export function createFileResultBackend(options: FileBackendOptions): FileBackendAnswer {
  const { dir, maxRecordBytes } = options;
  if (typeof dir !== "string" || dir.includes("\0") || !isAbsolute(dir) || normalize(dir) !== dir || (dir.length > 1 && dir.endsWith("/"))) {
    return { status: "invalid", reason: "dir" };
  }
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) return { status: "invalid", reason: "max_record_bytes" };
  const files = options.files ?? nodeFilePort;
  // 보관 폴더는 링크가 아닌 실제 폴더만 받는다. 연산들도 시작할 때 같은 조건으로 보고(이미 바뀐 자리는 unknown(no_dir)), 처음부터 틀린 자리로는 만들지 않는다.
  if (dirStateOf(files, dir) !== "dir") return { status: "invalid", reason: "not_dir" };
  const at = (name: string) => join(dir, name);

  // 키 연산이 경로를 쓰기 전에 목록과 같은 조건으로 폴더를 본다. 만든 뒤 링크나 파일로 바뀐 자리를 따라가 읽거나 쓰거나 지우지 않는다.
  // 이미 바뀌어 있는 자리만 거른다. 이 확인과 뒤의 호출 사이의 바꿔치기, 상위 경로의 링크는 막지 못한다(부르는 쪽의 조건).
  function dirFault(): FileUnknown | null {
    const state = dirStateOf(files, dir);
    return state === "dir" ? null : unknown(state);
  }

  // 이름이 없을 때 그것이 "없음"인지 정한다. 폴더가 있고 폴더일 때만 absent다. 볼륨이 빠져 폴더가 사라졌으면 unknown이다.
  function missing(): { readonly status: "absent" } | FileUnknown {
    const state = dirStateOf(files, dir);
    return state === "dir" ? { status: "absent" } : unknown(state);
  }

  function syncDir(): boolean {
    let fd: number | undefined;
    try {
      fd = files.open(dir, DIR);
      files.fsync(fd);
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeQuietly(files, fd);
    }
  }

  // 이름의 상태를 디스크에 내렸다고 확인한 뒤에만 그 답을 낸다. 못 내리면 이름은 보여도 전원이 나간 뒤를 모른다.
  // 프로세스의 기억에 기대지 않고 답할 때마다 내린다: 다시 뜬 프로세스는 앞선 내리기의 실패를 모른다.
  const durable = <A extends { readonly status: string }>(answer: A): A | FileUnknown => (syncDir() ? answer : unknown("io"));

  // 키 자리에 이미 있는 것에 대한 넣기의 답. 일반 파일이고 폴더를 내린 뒤에만 exists다.
  function existing(found: FileStat): { readonly status: "exists" } | FileUnknown {
    if (found.kind !== "file") return unknown("not_file");
    return durable({ status: "exists" } as const);
  }

  // 키의 임시 이름을 지운다. 게시 뒤 남은 임시 이름은 키와 같은 본문의 링크다. 없으면 이미 지운 것이다.
  function dropTemp(name: string): boolean {
    try {
      files.unlink(at(tempNameOf(name)));
      return true;
    } catch (error) {
      return codeOf(error) === "ENOENT";
    }
  }

  // 이름이 있으면 그 종류, 없으면 null. 그 밖의 실패는 던진다.
  function entry(path: string): FileStat | null {
    try {
      return files.lstat(path);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      throw error;
    }
  }

  function putNew(key: string, bytes: Uint8Array): ReturnType<FileResultBackend["putNew"]> {
    const name = nameOf(key);
    if (name === null) return unknown("invalid_key");
    if (!(bytes instanceof Uint8Array)) return unknown("invalid_input");
    if (bytes.length > maxRecordBytes) return unknown("too_large");
    const fault = dirFault();
    if (fault !== null) return fault;
    const target = at(name);
    const temp = at(tempNameOf(name));
    let present: FileStat | null;
    try {
      present = entry(target);
    } catch {
      return unknown("io");
    }
    if (present !== null) {
      // 같은 키의 남은 임시 이름(게시 뒤 못 지운 본문의 링크)을 지워 본다. 못 지워도 키의 본문과 답은 그대로다.
      if (present.kind === "file") unlinkQuietly(files, temp);
      return existing(present);
    }

    let fd: number | undefined;
    let created = false;
    let written: FileStat;
    try {
      try {
        fd = files.open(temp, NEW_FILE, 0o600);
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error;
        // 한 프로세스 전제에서 남은 임시 이름은 끊긴 앞선 넣기의 것이다. 지우고 한 번만 다시 만든다.
        // O_EXCL은 그 자리의 링크를 따라가지 않으므로, 지우는 것은 링크 자신이지 링크가 가리키는 파일이 아니다.
        files.unlink(temp);
        fd = files.open(temp, NEW_FILE, 0o600);
      }
      created = true;
      for (let offset = 0; offset < bytes.length; ) {
        const want = Math.min(CHUNK, bytes.length - offset);
        const n = files.write(fd, bytes, offset, want);
        // 요청보다 많이 썼다는 답은 실제로 쓴 바이트를 알려 주지 않는다. 그대로 믿으면 덜 쓴 파일을 게시한다.
        if (!Number.isSafeInteger(n) || n <= 0 || n > want) throw new Error("write count out of range");
        offset += n;
      }
      files.fsync(fd);
      written = files.fstat(fd);
      const closing = fd;
      fd = undefined;
      files.close(closing);
    } catch {
      if (fd !== undefined) closeQuietly(files, fd);
      if (created) unlinkQuietly(files, temp);
      return unknown("io");
    }

    try {
      files.link(temp, target);
    } catch (error) {
      unlinkQuietly(files, temp);
      if (codeOf(error) !== "EEXIST") return unknown("io");
      // 이미 있는 이름. 처음의 확인과 같은 조건(일반 파일, 폴더를 내림)으로만 exists다.
      let found: FileStat | null;
      try {
        found = entry(target);
      } catch {
        return unknown("io");
      }
      return found === null ? unknown("changed") : existing(found);
    }
    // 붙인 이름이 이 호출이 쓴 파일인가. 한 프로세스 전제에서는 늘 같다. 다른 프로세스가 임시 이름을 바꿔치웠으면 다르다.
    // 다르면 지우지 않는다(그 파일은 이 호출의 것이 아니다).
    let linked: FileStat | null;
    try {
      linked = entry(target);
    } catch {
      linked = null;
    }
    // 임시 이름 지우기는 최선 시도다. 못 지우면 키와 같은 본문의 링크가 남고 답은 stored 그대로다.
    // 같은 키의 다음 넣기(exists)와 지우기가 다시 지워 본다.
    unlinkQuietly(files, temp);
    if (linked === null || linked.dev !== written.dev || linked.ino !== written.ino) return unknown("changed");
    // 이름이 붙은 것을 디스크에 내려야 stored다. 실패하면 이름은 보이지만 전원이 나가면 사라질 수 있어 모름이다.
    // 그 기록을 지우지 않는다. 다음 넣기는 폴더를 다시 내리고, 내린 뒤에만 exists다.
    return durable({ status: "stored" } as const);
  }

  // 키의 파일을 열어 크기를 확인한 뒤 [offset, end)를 읽는다. end는 크기에서 자른다.
  function readSpan(name: string, offset: number, length: number | null): BackendRead | FileUnknown {
    const fault = dirFault();
    if (fault !== null) return fault;
    let fd: number;
    try {
      fd = files.open(at(name), READ_FILE);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return missing();
      // ELOOP: 그 이름이 심볼릭 링크다. 따라가지 않는다.
      return codeOf(error) === "ELOOP" ? unknown("not_file") : unknown("io");
    }
    try {
      const stat = files.fstat(fd);
      if (stat.kind !== "file") return unknown("not_file");
      if (!isCount(stat.size) || stat.size > maxRecordBytes) return unknown("too_large");
      const end = length === null ? stat.size : Math.min(stat.size, offset + length);
      if (offset >= end) return { status: "ok", bytes: new Uint8Array(0) };
      const out = new Uint8Array(end - offset);
      for (let got = 0; got < out.length; ) {
        const want = out.length - got;
        const n = files.read(fd, out, got, want, offset + got);
        // 크기보다 일찍 끝나면 읽는 사이 잘린 것이다. 짧은 바이트를 온전한 값으로 내지 않는다.
        if (!Number.isSafeInteger(n) || n <= 0) return unknown("changed");
        // 요청보다 많이 읽었다는 답은 믿을 수 없다. 채워지지 않은 바이트를 온전한 값으로 내지 않는다.
        if (n > want) return unknown("io");
        got += n;
      }
      return { status: "ok", bytes: out };
    } catch {
      return unknown("io");
    } finally {
      // 읽은 바이트는 이미 다 받았다. 닫기의 실패는 답을 바꾸지 않는다.
      closeQuietly(files, fd);
    }
  }

  function read(key: string): ReturnType<FileResultBackend["read"]> {
    const name = nameOf(key);
    if (name === null) return unknown("invalid_key");
    return readSpan(name, 0, null) as ReturnType<FileResultBackend["read"]>;
  }

  // 범위는 음이 아닌 안전 정수만 받는다. 판단은 이 꼴만 넘긴다. 음수를 "끝에서부터"로 읽는 동작은 두지 않는다.
  function readRange(key: string, offset: number, length: number): ReturnType<FileResultBackend["readRange"]> {
    const name = nameOf(key);
    if (name === null) return unknown("invalid_key");
    if (!isCount(offset) || !isCount(length)) return unknown("invalid_input");
    return readSpan(name, offset, length) as ReturnType<FileResultBackend["readRange"]>;
  }

  function has(key: string): ReturnType<FileResultBackend["has"]> {
    const name = nameOf(key);
    if (name === null) return unknown("invalid_key");
    const fault = dirFault();
    if (fault !== null) return fault;
    try {
      const found = entry(at(name));
      if (found === null) return missing();
      return found.kind === "file" ? { status: "present" } : unknown("not_file");
    } catch {
      return unknown("io");
    }
  }

  function remove(key: string): ReturnType<FileResultBackend["remove"]> {
    const name = nameOf(key);
    if (name === null) return unknown("invalid_key");
    const fault = dirFault();
    if (fault !== null) return fault;
    const path = at(name);
    let removed: boolean;
    try {
      const found = entry(path);
      // 폴더·링크는 이 모듈이 만든 것이 아니다. 지우지 않고 사람이 보게 둔다.
      if (found !== null && found.kind !== "file") return unknown("not_file");
      if (found !== null) files.unlink(path);
      removed = found !== null;
    } catch (error) {
      if (codeOf(error) !== "ENOENT") return unknown("io");
      removed = false;
    }
    if (!removed) {
      const gone = missing();
      if (gone.status !== "absent") return gone;
    }
    // 게시 뒤 남은 임시 이름은 본문의 사본이다. 그것이 남으면 지웠다(없다)고 답하지 않는다.
    if (!dropTemp(name)) return unknown("io");
    // 지운 것이 디스크에 내려가야 removed다. 아니면 재시작 뒤 되살아날 수 있다.
    // absent도 내린다: 앞선 지우기가 폴더를 내리지 못하고 끝났을 수 있다.
    return removed ? durable({ status: "removed" } as const) : durable({ status: "absent" } as const);
  }

  // 키 꼴의 이름만 낸다. 종류는 보지 않는다: 키 꼴인데 파일이 아닌 항목도 내야 판단의 목록이 그것을 unknown으로 드러낸다.
  // 임시 이름(점으로 시작)과 모르는 이름은 내지 않는다.
  function keys(prefix: string): ReturnType<FileResultBackend["keys"]> {
    if (typeof prefix !== "string") return unknown("invalid_input");
    const state = dirStateOf(files, dir);
    if (state !== "dir") return unknown(state);
    let names: readonly string[];
    try {
      names = files.readdir(dir);
    } catch (error) {
      return codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR" ? unknown("no_dir") : unknown("io");
    }
    if (!Array.isArray(names)) return unknown("io");
    const out: string[] = [];
    for (const name of names) {
      if (typeof name !== "string" || !NAME.test(name)) continue;
      const key = `${KEY_PREFIX}${name}`;
      if (key.startsWith(prefix)) out.push(key);
    }
    return { status: "ok", keys: out.sort() };
  }

  // 메서드 안에서 예상하지 못한 것이 던져도 밖으로 내보내지 않는다.
  const guard =
    <A extends unknown[], R>(call: (...args: A) => R) =>
    (...args: A): R | FileUnknown => {
      try {
        return call(...args);
      } catch {
        return unknown("io");
      }
    };
  const backend: FileResultBackend = {
    putNew: guard(putNew),
    read: guard(read),
    readRange: guard(readRange),
    remove: guard(remove),
    has: guard(has),
    keys: guard(keys),
  };
  return { status: "ok", backend };
}

function closeQuietly(files: FilePort, fd: number): void {
  try {
    files.close(fd);
  } catch {
    // 이미 돌려줄 답이 있다.
  }
}

// 답을 바꾸지 않는 임시 이름 정리에만 쓴다. 못 지운 임시 이름은 키로 보이지 않고, 같은 키의 다음 넣기·지우기가 다시 지워 본다.
function unlinkQuietly(files: FilePort, path: string): void {
  try {
    files.unlink(path);
  } catch {
    // 이미 돌려줄 답이 있다.
  }
}
