// 장부의 사본 파일 만들기. 장부를 쥔 연결이 메모리로 뜬 그림(serialize)을 받아, 사본 기록을 넣은 뒤에야 디스크에 쓴다.
// 그래서 디스크에는 "사본 기록이 없는 온전한 장부"가 어느 순간에도 생기지 않는다. 고른 이유와 버린 방법은 ledger.md "사본".
//
// 살아 있는 장부 파일은 여기서 열지 않는다. 같은 프로세스가 그 파일의 다른 FD를 닫으면 작성자의 POSIX 잠금이 풀린다.
// 여기서 FD를 여는 파일은 이 호출이 O_EXCL로 만든 임시 파일뿐이다.
import { Database } from "bun:sqlite";
import { closeSync, constants as fileOpen, fsyncSync, linkSync, lstatSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, type Faults } from "./errors.ts";

export const SIDECARS = ["-wal", "-shm", "-journal"] as const;

// 한 번도 장부로 열린 적 없는 사본의 표식(SQLite 머리의 user_version, "OLVS"). 처음 열 때 지운다.
// 이 표식이 있는데 곁 파일이 있으면 그 곁 파일은 다른 시점의 것이다. SQLite가 옛 WAL을 사본 위에 재생하면 사본 기록까지 덮을 수 있다.
export const SNAPSHOT_UNOPENED = 0x4f4c5653;

export const SNAPSHOT_FAILURES = ["ledger_unwritable", "in_transaction", "snapshot_hold", "snapshot_unsupported", "target_exists", "target_refused", "too_large", "io"] as const;
export type SnapshotFailure = (typeof SNAPSHOT_FAILURES)[number];

export class SnapshotRefused extends Error {
  constructor(
    readonly reason: SnapshotFailure,
    readonly detail: string,
  ) {
    super(`snapshot refused (${reason}): ${detail}`);
    this.name = "SnapshotRefused";
  }
}

// 사본을 쓸 자리를 정한다. 없는 경로만 받고, 링크를 따라가지 않고, 장부 자신과 그 곁 파일의 자리는 받지 않는다.
// 사본의 곁 파일 자리도 비어 있어야 한다. 남은 파일이 있으면 그 사본을 열 때 SQLite가 함께 읽는다.
export function snapshotTarget(path: string, ledgerPath: string): string {
  const full = resolve(path);
  if ([ledgerPath, ...SIDECARS.map((suffix) => `${ledgerPath}${suffix}`)].includes(full)) throw new SnapshotRefused("target_refused", "장부 자신과 그 곁 파일의 자리에는 쓰지 않는다");
  let real: string;
  try {
    real = realpathSync(dirname(full));
  } catch (error) {
    throw new SnapshotRefused("target_refused", `사본 폴더를 읽지 못함: ${describe(error)}`);
  }
  if (real !== dirname(full)) throw new SnapshotRefused("target_refused", "사본 폴더의 경로에 심볼릭 링크가 있다");
  for (const name of [full, ...SIDECARS.map((suffix) => `${full}${suffix}`)]) {
    if (lstatSync(name, { throwIfNoEntry: false }) !== undefined) throw new SnapshotRefused("target_exists", `이미 있다: ${name}`);
  }
  return full;
}

export interface SnapshotRecord {
  snapshotId: string;
  ledgerId: string;
  takenAt: number;
}

// 커밋된 장부의 그림에 사본 기록을 넣어 파일로 쓸 바이트를 만든다. 메모리 안에서만 일어난다.
export function sealSnapshot(image: Uint8Array, record: SnapshotRecord): Uint8Array {
  // 머리의 18·19번째 바이트가 WAL(2)이면 메모리 DB로 열리지 않는다(SQLITE_CANTOPEN). 사본은 저널 모드 파일이고 처음 열 때 WAL로 바뀐다.
  image[18] = 1;
  image[19] = 1;
  const copy = Database.deserialize(image);
  try {
    copy
      .query("INSERT INTO ledger_snapshots (seq, snapshot_id, ledger_id, taken_at) VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM ledger_snapshots), ?, ?, ?)")
      .run(record.snapshotId, record.ledgerId, record.takenAt);
    copy.run(`PRAGMA user_version = ${SNAPSHOT_UNOPENED}`);
    return copy.serialize();
  } finally {
    copy.close();
  }
}

const CHUNK = 64 * 1024;

// 임시 이름에 끝까지 쓰고 fsync한 뒤에만 최종 이름을 붙인다. link는 이미 있는 이름을 덮지 않고 그 자리의 링크도 따라가지 않는다.
// 끊겨서 남는 것은 임시 이름뿐이다. link와 unlink 사이에서 끊기면 이름이 둘이라 openLedger가 받지 않는다.
export function publishSnapshot(target: string, bytes: Uint8Array, faults: Faults): void {
  const temp = `${target}.partial-${crypto.randomUUID()}`;
  let fd: number | undefined;
  let linked = false;
  try {
    fd = openSync(temp, fileOpen.O_CREAT | fileOpen.O_EXCL | fileOpen.O_WRONLY | fileOpen.O_NOFOLLOW, 0o600);
    for (let offset = 0; offset < bytes.length; ) {
      offset += writeSync(fd, bytes, offset, Math.min(CHUNK, bytes.length - offset));
      faults.at("snapshot:writing");
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    faults.at("snapshot:written");
    linkSync(temp, target);
    linked = true;
    unlinkSync(temp);
  } catch (error) {
    if (fd !== undefined) closeQuietly(fd);
    removeQuietly(temp);
    if (linked) removeQuietly(target);
    if (error instanceof SnapshotRefused) throw error;
    if ((error as { code?: string }).code === "EEXIST") throw new SnapshotRefused("target_exists", `이미 있다: ${target}`);
    throw new SnapshotRefused("io", `사본을 쓰지 못함: ${describe(error)}`);
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // 이미 돌려줄 실패가 있다.
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 지우지 못한 임시 파일은 끊긴 사본이라 열리지 않거나, 온전해도 사본 기록이 있어 보류로 뜬다.
  }
}
