// 작업자 실행기 파드의 init 컨테이너가 부르는 대리 설치 진입점(D-103). 이미지의 대리 실행 파일을 공유 볼륨에 놓는다.
// 이 이미지는 distroless라 셸·cp가 없어 복사를 bun으로 한다. 환경을 읽지 않는다: 두 경로는 아래 상수이고 차트가 그 경로에 볼륨을 붙인다.
//
// 차례: 원본 확인 → 대상 폴더 확인 → 원본 sha256 → 같은 폴더의 임시 이름에 복사 → 임시 파일 sha256 대조 → 모드 0555 → rename.
// - rename은 같은 폴더 안이라 원자적이다. 역할 컨테이너는 이전 파일이나 새 파일 하나만 본다(이미 있으면 덮어쓴다).
// - 실패하면 임시 파일을 지우고 정해진 0 아닌 코드로 끝난다. 0으로 끝나면 파드가 역할 컨테이너를 띄우므로 반쯤 놓인 파일을 남기지 않는다.
// - 복사와 해시는 조각으로 읽는다. 대리는 약 100MiB라 통째로 읽으면 init의 메모리 상한을 그만큼 올려야 한다.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, lstatSync, openSync, readSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// 이미지 안의 원본(Dockerfile의 runtime-files)과 공유 볼륨 위의 대상(차트의 init·역할 컨테이너가 같은 경로로 붙인다).
export const AGENT_SOURCE = "/opt/olive/olive-agent";
export const AGENT_TARGET = "/opt/olive-agent/olive-agent";

// 64·69(placeholder.ts), 75~82(대리), 81~89(실행기)와 겹치지 않는다.
export const AGENT_INSTALL_EXIT = {
  // 원본이 없거나 일반 파일이 아니거나 읽지 못했다(그 이미지에 대리가 없다).
  source: 90,
  // 대상 폴더가 없거나 폴더가 아니다(볼륨이 붙지 않았다).
  target_dir: 91,
  // 임시 파일 쓰기·모드 바꾸기·rename에 실패했다.
  write: 92,
  // 복사한 파일의 sha256이 원본과 다르다.
  mismatch: 93,
} as const;

export type AgentInstallFailure = keyof typeof AGENT_INSTALL_EXIT;
export type AgentInstallResult =
  | { readonly ok: true; readonly sha256: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: AgentInstallFailure };

export interface AgentInstallPaths {
  readonly source: string;
  readonly target: string;
}

// 원본을 임시 이름으로 복사한다. 이미 있으면 실패해야 한다. 시험이 복사가 틀어지는 경우를 바꿔 넣는 자리다.
export type CopyFile = (from: string, to: string) => void;
const copyExclusive: CopyFile = (from, to) => copyFileSync(from, to, constants.COPYFILE_EXCL);

const CHUNK_BYTES = 1024 * 1024;

function sha256File(path: string): { sha256: string; bytes: number } {
  const hash = createHash("sha256");
  const buffer = new Uint8Array(CHUNK_BYTES);
  const fd = openSync(path, "r");
  let bytes = 0;
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest("hex"), bytes };
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function installAgent(paths: AgentInstallPaths, copy: CopyFile = copyExclusive): AgentInstallResult {
  let source: { sha256: string; bytes: number };
  try {
    // 심링크를 따라가지 않는다. 이미지의 원본은 일반 파일이고(image-check), 다른 것이면 그 이미지가 틀렸다.
    if (!lstatSync(paths.source).isFile()) return { ok: false, reason: "source" };
    source = sha256File(paths.source);
  } catch {
    return { ok: false, reason: "source" };
  }
  const dir = dirname(paths.target);
  try {
    if (!statSync(dir).isDirectory()) return { ok: false, reason: "target_dir" };
  } catch {
    return { ok: false, reason: "target_dir" };
  }
  // 임시 이름은 고정이다. 앞선 init이 중간에 죽어 남긴 것은 지우고 새로 만든다(COPYFILE_EXCL이라 그 자리의 심링크도 따라가지 않는다).
  const temp = join(dir, `.${basename(paths.target)}.tmp`);
  try {
    removeIfPresent(temp);
    copy(paths.source, temp);
  } catch {
    discard(temp);
    return { ok: false, reason: "write" };
  }
  let copied: { sha256: string; bytes: number };
  try {
    copied = sha256File(temp);
  } catch {
    discard(temp);
    return { ok: false, reason: "write" };
  }
  if (copied.sha256 !== source.sha256 || copied.bytes !== source.bytes) {
    discard(temp);
    return { ok: false, reason: "mismatch" };
  }
  try {
    // 쓰기 비트를 뺀다. 역할 컨테이너는 볼륨을 읽기 전용으로 붙이지만, init이 다시 돌 때 덮어쓰는 것은 rename이라 모드와 무관하다.
    chmodSync(temp, 0o555);
    renameSync(temp, paths.target);
  } catch {
    discard(temp);
    return { ok: false, reason: "write" };
  }
  return { ok: true, sha256: source.sha256, bytes: source.bytes };
}

// 실패 길의 정리. 지우지 못해도 결과 코드는 처음 실패를 따른다(다음 init이 같은 이름을 먼저 지운다).
function discard(path: string): void {
  try {
    removeIfPresent(path);
  } catch {}
}

function main(): never {
  const result = installAgent({ source: AGENT_SOURCE, target: AGENT_TARGET });
  if (!result.ok) {
    console.error(`olive agent-install: ${result.reason} 단계에서 멈췄다(${AGENT_SOURCE} → ${AGENT_TARGET})`);
    process.exit(AGENT_INSTALL_EXIT[result.reason]);
  }
  console.error(`olive agent-install: ${AGENT_TARGET} sha256 ${result.sha256} ${result.bytes}바이트`);
  process.exit(0);
}

if (import.meta.main) main();
