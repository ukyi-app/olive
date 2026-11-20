import { afterEach, describe, expect, test } from "bun:test";
import { constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Result, resultDigest } from "../../../src/contract/v1/index.ts";
import {
  createFileResultBackend,
  type FilePort,
  type FileResultBackend,
  type FileStat,
  nodeFilePort,
} from "../../../src/supervisor/scheduler/result-store-file.ts";
import {
  type BackendRead,
  deleteStored,
  listStored,
  type ReadGate,
  readStored,
  type ResultBackend,
  resultBody,
  storeResult,
  sweepStored,
} from "../../../src/supervisor/scheduler/result-store.ts";

// 숫자와 ID는 이 시험이 고른 값이다. 운영값이 아니다. 기록 상한도 시험마다 인자로 작게 준다.
const NOW = 1_800_000_000_000;
const MAX = 256 * 1024;
const NAME_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const NAME_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const KEY_A = `result/${NAME_A}`;
const KEY_B = `result/${NAME_B}`;
const RUN_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const RUN_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const OWNER = "11111111-0000-4000-8000-000000000001";
const OTHER = "22222222-0000-4000-8000-000000000002";
const bytesOf = (text: string) => new TextEncoder().encode(text);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "olive-result-store-"));
  dirs.push(dir);
  return dir;
}

function fileBackend(dir: string, options: { maxRecordBytes?: number; files?: FilePort } = {}): FileResultBackend {
  const made = createFileResultBackend({ dir, maxRecordBytes: options.maxRecordBytes ?? MAX, ...(options.files ? { files: options.files } : {}) });
  if (made.status !== "ok") throw new Error(`백엔드를 만들지 못함: ${made.reason}`);
  return made.backend;
}

const listing = (dir: string) => readdirSync(dir).sort();

// 판단의 시험(result-store.test.ts)이 쓰는 메모리 가짜 백엔드의 고장 없는 동작을 그대로 옮긴 것이다.
// 그 가짜는 시험 파일 안의 클래스라 가져올 수 없다. 판단이 기대는 계약을 두 구현에 같은 시험으로 돌리는 데 쓴다.
class MemoryBackend implements ResultBackend {
  readonly data = new Map<string, Uint8Array>();
  putNew(key: string, bytes: Uint8Array) {
    if (this.data.has(key)) return { status: "exists" as const };
    this.data.set(key, bytes.slice());
    return { status: "stored" as const };
  }
  read(key: string): BackendRead {
    const bytes = this.data.get(key);
    return bytes === undefined ? { status: "absent" } : { status: "ok", bytes: bytes.slice() };
  }
  readRange(key: string, offset: number, length: number): BackendRead {
    const bytes = this.data.get(key);
    return bytes === undefined ? { status: "absent" } : { status: "ok", bytes: bytes.slice(offset, offset + length) };
  }
  remove(key: string) {
    if (!this.data.has(key)) return { status: "absent" as const };
    this.data.delete(key);
    return { status: "removed" as const };
  }
  has(key: string) {
    return this.data.has(key) ? { status: "present" as const } : { status: "absent" as const };
  }
  keys(prefix: string) {
    return { status: "ok" as const, keys: [...this.data.keys()].filter((key) => key.startsWith(prefix)) };
  }
}

type Op = keyof FilePort;
const injected = (op: string, code: string) => Object.assign(new Error(`injected ${op}`), { code });

// node:fs 위에 얹은 파일 포트. 부른 것을 남기고, 정한 차례의 호출에서 정한 오류 코드로 던진다.
class SpyPort implements FilePort {
  readonly calls: Op[] = [];
  readonly fail: Partial<Record<Op, { readonly nth: number; readonly code: string }>> = {};
  // write가 받은 길이의 절반만 쓰는 포트(짧은 쓰기).
  shortWrites = false;
  // read가 이 바이트 수 뒤부터 0을 내는 포트(읽는 사이 잘림).
  readCap: number | null = null;
  // write·read가 1바이트만 처리하고 요청한 길이보다 1 큰 개수를 돌려주는 고장 난 포트.
  overCount = false;
  // 폴더의 fsync만 이 코드로 계속 실패시킨다. 파일의 fsync는 그대로다.
  dirFsyncFault: string | null = null;
  readonly dirSyncs = { tried: 0, done: 0 };
  // 이 경로의 unlink를 EACCES로 계속 실패시킨다.
  denyUnlink: ((path: string) => boolean) | null = null;
  beforeWrite: (() => void) | null = null;
  beforeFsync: (() => void) | null = null;
  beforeLink: ((from: string, to: string) => void) | null = null;
  mapLstat: ((path: string, stat: FileStat) => FileStat) | null = null;
  readonly #count = new Map<Op, number>();
  readonly #dirFds = new Set<number>();

  // 그 연산의 다음 호출에서 던진다(앞선 호출의 수를 세지 않아도 되게).
  failNext(op: Op, code: string, after = 0): void {
    this.fail[op] = { nth: (this.#count.get(op) ?? 0) + 1 + after, code };
  }
  #hit(op: Op): void {
    this.calls.push(op);
    const n = (this.#count.get(op) ?? 0) + 1;
    this.#count.set(op, n);
    const fault = this.fail[op];
    if (fault !== undefined && fault.nth === n) throw injected(op, fault.code);
  }
  open(path: string, flags: number, mode?: number) {
    this.#hit("open");
    const fd = nodeFilePort.open(path, flags, mode);
    if ((flags & constants.O_DIRECTORY) !== 0) this.#dirFds.add(fd);
    return fd;
  }
  write(fd: number, bytes: Uint8Array, offset: number, length: number) {
    this.#hit("write");
    this.beforeWrite?.();
    if (this.overCount) return nodeFilePort.write(fd, bytes, offset, Math.min(1, length)) + length;
    return nodeFilePort.write(fd, bytes, offset, this.shortWrites ? Math.max(1, Math.floor(length / 2)) : length);
  }
  read(fd: number, bytes: Uint8Array, offset: number, length: number, position: number) {
    this.#hit("read");
    if (this.overCount) return nodeFilePort.read(fd, bytes, offset, Math.min(1, length), position) + length;
    if (this.readCap !== null) {
      if (position >= this.readCap) return 0;
      return nodeFilePort.read(fd, bytes, offset, Math.min(length, this.readCap - position), position);
    }
    return nodeFilePort.read(fd, bytes, offset, length, position);
  }
  fsync(fd: number) {
    const isDir = this.#dirFds.has(fd);
    if (isDir) this.dirSyncs.tried += 1;
    this.#hit("fsync");
    this.beforeFsync?.();
    if (isDir && this.dirFsyncFault !== null) throw injected("fsync", this.dirFsyncFault);
    nodeFilePort.fsync(fd);
    if (isDir) this.dirSyncs.done += 1;
  }
  close(fd: number) {
    this.#hit("close");
    this.#dirFds.delete(fd);
    nodeFilePort.close(fd);
  }
  fstat(fd: number) {
    this.#hit("fstat");
    return nodeFilePort.fstat(fd);
  }
  lstat(path: string) {
    this.#hit("lstat");
    const stat = nodeFilePort.lstat(path);
    return this.mapLstat === null ? stat : this.mapLstat(path, stat);
  }
  link(from: string, to: string) {
    this.#hit("link");
    this.beforeLink?.(from, to);
    nodeFilePort.link(from, to);
  }
  unlink(path: string) {
    this.#hit("unlink");
    if (this.denyUnlink?.(path)) throw injected("unlink", "EACCES");
    nodeFilePort.unlink(path);
  }
  readdir(path: string) {
    this.#hit("readdir");
    return nodeFilePort.readdir(path);
  }
}

function spied(options: { maxRecordBytes?: number } = {}) {
  const dir = tempDir();
  const port = new SpyPort();
  const backend = fileBackend(dir, { ...options, files: port });
  // 만들기가 폴더를 확인한 호출은 지운다. 시험은 연산이 부른 것만 본다.
  port.calls.splice(0);
  return { dir, port, backend };
}

// ---- 공통 시험: 판단이 기대는 포트의 계약 ----

const implementations: readonly (readonly [string, () => ResultBackend])[] = [
  ["메모리 가짜", () => new MemoryBackend()],
  ["파일", () => fileBackend(tempDir())],
];

for (const [label, make] of implementations) {
  describe(`공통 계약: ${label}`, () => {
    test("putNew: 없으면 stored, 같은 키는 exists이고 본문을 바꾸지 않는다", () => {
      const backend = make();
      expect(backend.putNew(KEY_A, bytesOf("첫 본문"))).toEqual({ status: "stored" });
      expect(backend.putNew(KEY_A, bytesOf("다른 본문"))).toEqual({ status: "exists" });
      expect(backend.read(KEY_A)).toEqual({ status: "ok", bytes: bytesOf("첫 본문") });
    });

    test("read·has: 없는 키는 absent, 있는 키는 값 전체와 present", () => {
      const backend = make();
      expect(backend.read(KEY_A)).toEqual({ status: "absent" });
      expect(backend.readRange(KEY_A, 0, 4)).toEqual({ status: "absent" });
      expect(backend.has(KEY_A)).toEqual({ status: "absent" });
      backend.putNew(KEY_A, bytesOf("0123456789"));
      expect(backend.has(KEY_A)).toEqual({ status: "present" });
      expect(backend.has(KEY_B)).toEqual({ status: "absent" });
    });

    test("readRange: [offset, offset+length)를 끝에서 자르고, 끝을 넘으면 빈 바이트다", () => {
      const backend = make();
      backend.putNew(KEY_A, bytesOf("0123456789"));
      const range = (offset: number, length: number) => backend.readRange(KEY_A, offset, length);
      expect(range(0, 4)).toEqual({ status: "ok", bytes: bytesOf("0123") });
      expect(range(4, 3)).toEqual({ status: "ok", bytes: bytesOf("456") });
      expect(range(8, 10)).toEqual({ status: "ok", bytes: bytesOf("89") });
      expect(range(10, 1)).toEqual({ status: "ok", bytes: new Uint8Array(0) });
      expect(range(500, 1)).toEqual({ status: "ok", bytes: new Uint8Array(0) });
      expect(range(3, 0)).toEqual({ status: "ok", bytes: new Uint8Array(0) });
      expect(range(0, Number.MAX_SAFE_INTEGER)).toEqual({ status: "ok", bytes: bytesOf("0123456789") });
      expect(range(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toEqual({ status: "ok", bytes: new Uint8Array(0) });
    });

    test("remove: 있으면 removed 뒤 없음, 없으면 absent", () => {
      const backend = make();
      backend.putNew(KEY_A, bytesOf("본문"));
      expect(backend.remove(KEY_A)).toEqual({ status: "removed" });
      expect(backend.has(KEY_A)).toEqual({ status: "absent" });
      expect(backend.read(KEY_A)).toEqual({ status: "absent" });
      expect(backend.remove(KEY_A)).toEqual({ status: "absent" });
      // 지운 키는 다시 넣을 수 있다.
      expect(backend.putNew(KEY_A, bytesOf("새 본문"))).toEqual({ status: "stored" });
    });

    test("keys: 접두로 시작하는 지금의 키 전부", () => {
      const backend = make();
      const sorted = (answer: ReturnType<ResultBackend["keys"]>) => (answer.status === "ok" ? { status: "ok", keys: [...answer.keys].sort() } : answer);
      expect(sorted(backend.keys("result/"))).toEqual({ status: "ok", keys: [] });
      backend.putNew(KEY_B, bytesOf("b"));
      backend.putNew(KEY_A, bytesOf("a"));
      expect(sorted(backend.keys("result/"))).toEqual({ status: "ok", keys: [KEY_A, KEY_B] });
      expect(sorted(backend.keys("result/a"))).toEqual({ status: "ok", keys: [KEY_A] });
      expect(sorted(backend.keys(""))).toEqual({ status: "ok", keys: [KEY_A, KEY_B] });
      expect(sorted(backend.keys("other/"))).toEqual({ status: "ok", keys: [] });
      backend.remove(KEY_A);
      expect(sorted(backend.keys("result/"))).toEqual({ status: "ok", keys: [KEY_B] });
    });
  });
}

const result = (summary: string): Result => ({ role: "diagnosis", outcome: "completed", summary, items: [{ kind: "finding", text: "원인 후보 하나" }], refs: [] });
const open: ReadGate = { readable: () => ({ known: true, value: true }) };

// 판단의 연산을 한 줄로 차례로 부르고 답을 모은다. 목록은 키의 순서가 구현마다 달라 참조로 정렬한다.
function judgementScript(backend: ResultBackend): unknown[] {
  const first = result("첫 결과");
  const second = result("두 번째 결과");
  const store = (run: string, owner: string, r: Result, now = NOW) => storeResult(backend, { runId: run, owner, digest: resultDigest(r), body: resultBody(r), now });
  const out: unknown[] = [];
  const a = store(RUN_A, OWNER, first);
  out.push(a);
  out.push(store(RUN_A, OWNER, first, NOW + 5));
  out.push(store(RUN_A, OWNER, second));
  out.push(store(RUN_A, OTHER, first));
  out.push(store(RUN_B, OWNER, second, NOW + 10));
  const ref = a.status === "stored" ? a.ref : "";
  out.push(readStored({ backend, gate: open }, { ref, owner: OWNER, digest: resultDigest(first) }));
  out.push(readStored({ backend, gate: open }, { ref, owner: OWNER, digest: resultDigest(first), range: { offset: 3, length: 7 } }));
  out.push(readStored({ backend, gate: open }, { ref, owner: OTHER, digest: resultDigest(first) }));
  out.push(readStored({ backend, gate: open }, { ref, owner: OWNER, digest: resultDigest(second) }));
  const listed = listStored(backend);
  out.push(listed.status === "ok" ? { status: "ok", entries: [...listed.entries].sort((x, y) => x.ref.localeCompare(y.ref)) } : listed);
  out.push(deleteStored(backend, ref));
  out.push(deleteStored(backend, ref));
  out.push(readStored({ backend, gate: open }, { ref, owner: OWNER, digest: resultDigest(first) }));
  out.push(sweepStored(backend, { keep: [], before: NOW + 11 }));
  out.push(listStored(backend));
  return out;
}

test("공통 계약: 판단(result-store.ts)의 연산이 두 구현에서 같은 답을 낸다", () => {
  const memory = judgementScript(new MemoryBackend());
  const file = judgementScript(fileBackend(tempDir()));
  expect(file).toEqual(memory);
  // 시나리오가 실제로 여러 갈래를 지났는지 본다(전부 unknown으로 같아지는 것을 막는다).
  expect((memory as { status: string }[]).map((answer) => answer.status)).toEqual([
    "stored",
    "stored",
    "conflict",
    "conflict",
    "stored",
    "ok",
    "ok",
    "absent",
    "absent",
    "ok",
    "deleted",
    "absent",
    "absent",
    "ok",
    "ok",
  ]);
});

// ---- 보장 1: 새로 두기는 원자적이고 있는 것을 덮지 않는다 ----

describe("보장 1: 원자적 새로 두기", () => {
  test("쓰는 동안과 내리는 동안 그 키는 보이지 않는다", () => {
    const { dir, port, backend } = spied();
    const seen: string[] = [];
    const look = () => {
      seen.push(existsSync(join(dir, NAME_A)) ? "visible" : "hidden");
    };
    port.beforeWrite = look;
    port.beforeFsync = look;
    port.shortWrites = true;
    const body = new Uint8Array(150 * 1024).fill(7);
    expect(backend.putNew(KEY_A, body)).toEqual({ status: "stored" });
    expect(seen.length).toBeGreaterThan(3);
    // 마지막 fsync는 폴더의 것이다(이름을 붙인 뒤).
    expect(seen.slice(0, -1).every((state) => state === "hidden")).toBe(true);
    expect(new Uint8Array(readFileSync(join(dir, NAME_A)))).toEqual(body);
    expect(listing(dir)).toEqual([NAME_A]);
  });

  test("쓰기가 중간에 실패하면 unknown이고, 반쯤 쓴 바이트는 키로 보이지 않고 남지 않는다", () => {
    const { dir, port, backend } = spied();
    port.fail.write = { nth: 3, code: "EIO" };
    expect(backend.putNew(KEY_A, new Uint8Array(200 * 1024).fill(1))).toEqual({ status: "unknown", reason: "io" });
    expect(port.calls.filter((op) => op === "write").length).toBe(3);
    expect(backend.has(KEY_A)).toEqual({ status: "absent" });
    expect(backend.read(KEY_A)).toEqual({ status: "absent" });
    expect(backend.keys("result/")).toEqual({ status: "ok", keys: [] });
    expect(listing(dir)).toEqual([]);
  });

  test("파일의 fsync가 실패하면 unknown이고 키는 없다", () => {
    const { dir, port, backend } = spied();
    port.fail.fsync = { nth: 1, code: "EIO" };
    expect(backend.putNew(KEY_A, bytesOf("본문"))).toEqual({ status: "unknown", reason: "io" });
    expect(backend.has(KEY_A)).toEqual({ status: "absent" });
    expect(listing(dir)).toEqual([]);
    expect(port.calls).not.toContain("link");
  });

  test("이름 붙이기가 실패하면 unknown이고 키는 없다", () => {
    const { dir, port, backend } = spied();
    port.fail.link = { nth: 1, code: "EPERM" };
    expect(backend.putNew(KEY_A, bytesOf("본문"))).toEqual({ status: "unknown", reason: "io" });
    expect(backend.has(KEY_A)).toEqual({ status: "absent" });
    expect(listing(dir)).toEqual([]);
  });

  test("폴더의 fsync가 실패하면 unknown이다. 이름은 남고, 다음 넣기는 exists다", () => {
    const { port, backend } = spied();
    port.fail.fsync = { nth: 2, code: "EIO" };
    expect(backend.putNew(KEY_A, bytesOf("본문"))).toEqual({ status: "unknown", reason: "io" });
    expect(backend.read(KEY_A)).toEqual({ status: "ok", bytes: bytesOf("본문") });
    expect(backend.putNew(KEY_A, bytesOf("본문"))).toEqual({ status: "exists" });
    // 다음 넣기의 exists는 폴더를 다시 내린 뒤의 답이다.
    expect(port.dirSyncs).toEqual({ tried: 2, done: 1 });
  });

  test("판단을 거친 재보관: 폴더를 내리지 못하는 동안은 참조가 나가지 않고, 내리기가 처음 성공한 뒤에만 stored(created: false)다", () => {
    const dir = tempDir();
    const port = new SpyPort();
    port.dirFsyncFault = "EIO";
    const r = result("폴더를 내리지 못한 결과");
    const input = { runId: RUN_A, owner: OWNER, digest: resultDigest(r), body: resultBody(r), now: NOW };
    const first = fileBackend(dir, { files: port });
    expect(storeResult(first, input)).toEqual({ status: "unknown" });
    expect(storeResult(first, input)).toEqual({ status: "unknown" });
    // 다시 뜬 프로세스(같은 폴더의 새 백엔드)도 앞선 실패를 기억하지 않고 같은 답이다.
    const restarted = fileBackend(dir, { files: port });
    expect(storeResult(restarted, input)).toEqual({ status: "unknown" });
    expect(port.dirSyncs).toEqual({ tried: 3, done: 0 });
    port.dirFsyncFault = null;
    const stored = storeResult(restarted, input);
    expect(stored).toMatchObject({ status: "stored", created: false });
    expect(port.dirSyncs).toEqual({ tried: 4, done: 1 });
    if (stored.status !== "stored") throw new Error("보관 실패");
    const read = readStored({ backend: restarted, gate: open }, { ref: stored.ref, owner: OWNER, digest: resultDigest(r) });
    expect(read.status === "ok" ? read.bytes : read).toEqual(resultBody(r));
  });

  test("게시할 때 이미 있는 이름도 일반 파일이고 폴더를 내린 뒤에만 exists다", () => {
    const { dir, port, backend } = spied();
    port.beforeLink = (_from, to) => writeFileSync(to, "먼저 온 것");
    port.dirFsyncFault = "EIO";
    expect(backend.putNew(KEY_A, bytesOf("늦게 온 것"))).toEqual({ status: "unknown", reason: "io" });
    expect(port.dirSyncs).toEqual({ tried: 1, done: 0 });
    expect(readFileSync(join(dir, NAME_A), "utf8")).toBe("먼저 온 것");
    expect(listing(dir)).toEqual([NAME_A]);
    port.dirFsyncFault = null;
    port.beforeLink = (_from, to) => mkdirSync(to);
    expect(backend.putNew(KEY_B, bytesOf("늦게 온 것"))).toEqual({ status: "unknown", reason: "not_file" });
    expect(listing(dir)).toEqual([NAME_A, NAME_B]);
  });

  test("게시한 뒤 지우지 못한 임시 이름: stored이고, 같은 키의 다시 넣기(exists)가 다시 지워 본다", () => {
    const { dir, port, backend } = spied();
    const tempName = `.${NAME_A}.partial`;
    port.denyUnlink = (path) => path === join(dir, tempName);
    expect(backend.putNew(KEY_A, bytesOf("본문"))).toEqual({ status: "stored" });
    expect(listing(dir)).toEqual([tempName, NAME_A]);
    // 지우지 못하는 동안에도 키는 온전하다. 임시 이름 정리는 넣기의 답을 바꾸지 않는다.
    expect(backend.putNew(KEY_A, bytesOf("다른 본문"))).toEqual({ status: "exists" });
    expect(listing(dir)).toEqual([tempName, NAME_A]);
    port.denyUnlink = null;
    expect(backend.putNew(KEY_A, bytesOf("다른 본문"))).toEqual({ status: "exists" });
    expect(listing(dir)).toEqual([NAME_A]);
    expect(backend.read(KEY_A)).toEqual({ status: "ok", bytes: bytesOf("본문") });
  });

  test("파일 포트가 요청보다 큰 쓰기 개수를 돌려주면 게시하기 전에 멈추고 unknown이다", () => {
    const { dir, port, backend } = spied();
    port.overCount = true;
    expect(backend.putNew(KEY_A, bytesOf("01234567"))).toEqual({ status: "unknown", reason: "io" });
    expect(port.calls).not.toContain("link");
    expect(listing(dir)).toEqual([]);
  });

  test("이름을 붙이기 직전에 다른 것이 그 이름을 차지하면 exists이고 그것을 덮지 않는다", () => {
    const { dir, port, backend } = spied();
    port.beforeLink = (_from, to) => writeFileSync(to, "먼저 온 것");
    expect(backend.putNew(KEY_A, bytesOf("늦게 온 것"))).toEqual({ status: "exists" });
    expect(readFileSync(join(dir, NAME_A), "utf8")).toBe("먼저 온 것");
    expect(listing(dir)).toEqual([NAME_A]);
  });

  test("붙인 이름이 이 호출이 쓴 파일이 아니면 unknown(changed)이다", () => {
    const { dir, port, backend } = spied();
    port.mapLstat = (path, stat) => (path === join(dir, NAME_A) ? { ...stat, ino: stat.ino + 1n } : stat);
    expect(backend.putNew(KEY_A, bytesOf("본문"))).toEqual({ status: "unknown", reason: "changed" });
  });

  test("끊긴 앞선 넣기가 남긴 임시 파일은 키로 보이지 않고, 같은 키의 다음 넣기가 치운다", () => {
    const dir = tempDir();
    writeFileSync(join(dir, `.${NAME_A}.partial`), "반쯤");
    const backend = fileBackend(dir);
    expect(backend.keys("")).toEqual({ status: "ok", keys: [] });
    expect(backend.has(KEY_A)).toEqual({ status: "absent" });
    expect(backend.read(KEY_A)).toEqual({ status: "absent" });
    expect(backend.putNew(KEY_A, bytesOf("온전한 본문"))).toEqual({ status: "stored" });
    expect(backend.read(KEY_A)).toEqual({ status: "ok", bytes: bytesOf("온전한 본문") });
    expect(listing(dir)).toEqual([NAME_A]);
  });

  test("임시 이름 자리의 심볼릭 링크를 따라 폴더 밖에 쓰지 않는다", () => {
    const dir = tempDir();
    const outside = tempDir();
    const victim = join(outside, "victim");
    writeFileSync(victim, "그대로");
    symlinkSync(victim, join(dir, `.${NAME_A}.partial`));
    const backend = fileBackend(dir);
    expect(backend.putNew(KEY_A, bytesOf("본문"))).toEqual({ status: "stored" });
    expect(readFileSync(victim, "utf8")).toBe("그대로");
    expect(readFileSync(join(dir, NAME_A), "utf8")).toBe("본문");
    expect(listing(dir)).toEqual([NAME_A]);
  });

  test("상한을 넘는 바이트는 파일 시스템을 부르기 전에 unknown(too_large)이다", () => {
    const { port, backend } = spied({ maxRecordBytes: 8 });
    expect(backend.putNew(KEY_A, new Uint8Array(9))).toEqual({ status: "unknown", reason: "too_large" });
    expect(port.calls).toEqual([]);
    expect(backend.putNew(KEY_A, new Uint8Array(8))).toEqual({ status: "stored" });
  });

  test("판단을 거친 보관: 쓰기가 실패하면 참조를 내지 않고 목록에도 없다", () => {
    const { port, backend } = spied();
    port.fail.write = { nth: 1, code: "ENOSPC" };
    const r = result("보관 실패");
    expect(storeResult(backend, { runId: RUN_A, owner: OWNER, digest: resultDigest(r), body: resultBody(r), now: NOW })).toEqual({ status: "unknown" });
    expect(listStored(backend)).toEqual({ status: "ok", entries: [] });
  });
});

// ---- 보장 2: 읽기 실패는 "없음"이 아니다 ----

describe("보장 2: 없음과 모름을 가른다", () => {
  test("만든 뒤 폴더가 사라지면 모든 연산이 unknown이다(absent가 아니다)", () => {
    const dir = join(tempDir(), "gone");
    mkdirSync(dir);
    const backend = fileBackend(dir);
    rmSync(dir, { recursive: true });
    expect(backend.read(KEY_A)).toEqual({ status: "unknown", reason: "no_dir" });
    expect(backend.readRange(KEY_A, 0, 4)).toEqual({ status: "unknown", reason: "no_dir" });
    expect(backend.has(KEY_A)).toEqual({ status: "unknown", reason: "no_dir" });
    expect(backend.remove(KEY_A)).toEqual({ status: "unknown", reason: "no_dir" });
    expect(backend.keys("result/")).toEqual({ status: "unknown", reason: "no_dir" });
    expect(backend.putNew(KEY_A, bytesOf("x")).status).toBe("unknown");
  });

  test("만든 뒤 폴더 자리가 파일로 바뀌면 absent가 아니다", () => {
    const parent = tempDir();
    const notDir = join(parent, "file");
    mkdirSync(notDir);
    const backend = fileBackend(notDir);
    rmSync(notDir, { recursive: true });
    writeFileSync(notDir, "폴더가 아님");
    for (const answer of [backend.read(KEY_A), backend.has(KEY_A), backend.remove(KEY_A), backend.keys("")]) expect(answer.status).toBe("unknown");
  });

  test("권한 오류는 unknown이다", () => {
    const { port, backend } = spied();
    backend.putNew(KEY_A, bytesOf("본문"));
    port.failNext("open", "EACCES");
    expect(backend.read(KEY_A)).toEqual({ status: "unknown", reason: "io" });
    port.failNext("lstat", "EACCES");
    expect(backend.has(KEY_A)).toEqual({ status: "unknown", reason: "io" });
    port.failNext("unlink", "EACCES");
    expect(backend.remove(KEY_A)).toEqual({ status: "unknown", reason: "io" });
    port.failNext("readdir", "EACCES");
    expect(backend.keys("result/")).toEqual({ status: "unknown", reason: "io" });
    // 실패 뒤에도 기록은 그대로다.
    expect(backend.read(KEY_A)).toEqual({ status: "ok", bytes: bytesOf("본문") });
  });

  test("I/O 오류와 읽는 사이 잘림은 unknown이다", () => {
    const { port, backend } = spied();
    backend.putNew(KEY_A, bytesOf("0123456789"));
    port.failNext("read", "EIO");
    expect(backend.read(KEY_A)).toEqual({ status: "unknown", reason: "io" });
    port.readCap = 5;
    expect(backend.read(KEY_A)).toEqual({ status: "unknown", reason: "changed" });
    expect(backend.readRange(KEY_A, 2, 6)).toEqual({ status: "unknown", reason: "changed" });
    expect(backend.readRange(KEY_A, 0, 5)).toEqual({ status: "ok", bytes: bytesOf("01234") });
  });

  test("파일 포트가 요청보다 큰 읽기 개수를 돌려주면 unknown이다(채워지지 않은 바이트를 내지 않는다)", () => {
    const { port, backend } = spied();
    backend.putNew(KEY_A, bytesOf("01234567"));
    port.overCount = true;
    expect(backend.read(KEY_A)).toEqual({ status: "unknown", reason: "io" });
    expect(backend.readRange(KEY_A, 1, 5)).toEqual({ status: "unknown", reason: "io" });
  });

  test("판단을 거친 읽기: 읽기 실패는 absent가 아니라 unknown이다", () => {
    const { port, backend } = spied();
    const r = result("읽을 결과");
    const stored = storeResult(backend, { runId: RUN_A, owner: OWNER, digest: resultDigest(r), body: resultBody(r), now: NOW });
    if (stored.status !== "stored") throw new Error("보관 실패");
    port.failNext("read", "EIO");
    expect(readStored({ backend, gate: open }, { ref: stored.ref, owner: OWNER, digest: resultDigest(r) })).toEqual({ status: "unknown" });
  });

  test("키 자리에 폴더·링크가 있으면 unknown(not_file)이고 지우지도 따라가지도 않는다", () => {
    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "victim"), "밖의 파일");
    mkdirSync(join(dir, NAME_A));
    symlinkSync(join(outside, "victim"), join(dir, NAME_B));
    const backend = fileBackend(dir);
    for (const key of [KEY_A, KEY_B]) {
      expect(backend.read(key)).toEqual({ status: "unknown", reason: "not_file" });
      expect(backend.readRange(key, 0, 4)).toEqual({ status: "unknown", reason: "not_file" });
      expect(backend.has(key)).toEqual({ status: "unknown", reason: "not_file" });
      expect(backend.remove(key)).toEqual({ status: "unknown", reason: "not_file" });
      expect(backend.putNew(key, bytesOf("덮기")).status).toBe("unknown");
    }
    expect(listing(dir)).toEqual([NAME_A, NAME_B]);
    expect(readFileSync(join(outside, "victim"), "utf8")).toBe("밖의 파일");
    // 키 꼴의 이상한 항목은 목록에 나와 판단이 그것을 unknown으로 드러낸다(정리가 지우지 않는다).
    expect(backend.keys("result/")).toEqual({ status: "ok", keys: [KEY_A, KEY_B] });
    const listed = listStored(backend);
    expect(listed.status === "ok" ? listed.entries.map((entry) => entry.state) : listed).toEqual(["unknown", "unknown"]);
  });

  test("상한보다 큰 파일은 읽지 않고 unknown(too_large)이다", () => {
    const dir = tempDir();
    writeFileSync(join(dir, NAME_A), new Uint8Array(17));
    const backend = fileBackend(dir, { maxRecordBytes: 16 });
    expect(backend.read(KEY_A)).toEqual({ status: "unknown", reason: "too_large" });
    expect(backend.readRange(KEY_A, 0, 4)).toEqual({ status: "unknown", reason: "too_large" });
    expect(backend.has(KEY_A)).toEqual({ status: "present" });
  });

  test("범위가 음수·소수·안전 정수 밖이면 파일 시스템을 부르기 전에 unknown(invalid_input)이다", () => {
    const { port, backend } = spied();
    for (const [offset, length] of [
      [-1, 4],
      [0, -1],
      [1.5, 4],
      [0, 2.5],
      [Number.NaN, 4],
      [0, Number.POSITIVE_INFINITY],
      [Number.MAX_SAFE_INTEGER + 1, 1],
      ["0", 4],
    ] as const) {
      expect(backend.readRange(KEY_A, offset as number, length as number)).toEqual({ status: "unknown", reason: "invalid_input" });
    }
    expect(backend.putNew(KEY_A, "문자열" as never)).toEqual({ status: "unknown", reason: "invalid_input" });
    expect(backend.keys(7 as never)).toEqual({ status: "unknown", reason: "invalid_input" });
    expect(port.calls).toEqual([]);
  });

  test("지우기의 폴더 fsync가 실패하면 removed가 아니라 unknown이다", () => {
    const { port, backend } = spied();
    backend.putNew(KEY_A, bytesOf("본문"));
    port.failNext("fsync", "EIO");
    expect(backend.remove(KEY_A)).toEqual({ status: "unknown", reason: "io" });
  });

  test("지운 뒤 폴더를 내리지 못하면 같은 지우기의 absent도 폴더를 내린 뒤에만 나온다", () => {
    const { dir, port, backend } = spied();
    backend.putNew(KEY_A, bytesOf("본문"));
    port.dirFsyncFault = "EIO";
    expect(backend.remove(KEY_A)).toEqual({ status: "unknown", reason: "io" });
    expect(backend.remove(KEY_A)).toEqual({ status: "unknown", reason: "io" });
    expect(deleteStored(backend, `results/${NAME_A}`)).toEqual({ status: "unknown" });
    port.dirFsyncFault = null;
    expect(backend.remove(KEY_A)).toEqual({ status: "absent" });
    expect(listing(dir)).toEqual([]);
  });

  test("지우기는 그 키의 임시 이름(본문의 사본)까지 지운 뒤에만 removed·absent다", () => {
    const { dir, port, backend } = spied();
    const tempName = `.${NAME_A}.partial`;
    port.denyUnlink = (path) => path === join(dir, tempName);
    expect(backend.putNew(KEY_A, bytesOf("본문"))).toEqual({ status: "stored" });
    expect(backend.remove(KEY_A)).toEqual({ status: "unknown", reason: "io" });
    expect(listing(dir)).toEqual([tempName]);
    expect(readFileSync(join(dir, tempName), "utf8")).toBe("본문");
    // 키가 이미 없어도 사본이 남는 동안은 absent가 아니다.
    expect(backend.remove(KEY_A)).toEqual({ status: "unknown", reason: "io" });
    port.denyUnlink = null;
    expect(backend.remove(KEY_A)).toEqual({ status: "absent" });
    expect(listing(dir)).toEqual([]);
    // 게시 뒤 남은 임시 이름은 키를 지울 때 함께 지운다.
    port.denyUnlink = (path) => path === join(dir, tempName);
    expect(backend.putNew(KEY_A, bytesOf("본문"))).toEqual({ status: "stored" });
    port.denyUnlink = null;
    expect(backend.remove(KEY_A)).toEqual({ status: "removed" });
    expect(listing(dir)).toEqual([]);
  });

  test("파일 포트가 예상 밖으로 던져도 밖으로 내보내지 않는다", () => {
    let broken = false;
    const throwing = new Proxy(nodeFilePort, {
      get: (target, op) =>
        broken
          ? () => {
              throw new TypeError("예상 밖");
            }
          : target[op as keyof FilePort],
    });
    const dir = tempDir();
    const backend = fileBackend(dir, { files: throwing });
    broken = true;
    // 만들기도 던지지 않고 거절한다.
    expect(createFileResultBackend({ dir, maxRecordBytes: MAX, files: throwing })).toEqual({ status: "invalid", reason: "not_dir" });
    expect(backend.putNew(KEY_A, bytesOf("x")).status).toBe("unknown");
    expect(backend.read(KEY_A).status).toBe("unknown");
    expect(backend.readRange(KEY_A, 0, 1).status).toBe("unknown");
    expect(backend.has(KEY_A).status).toBe("unknown");
    expect(backend.remove(KEY_A).status).toBe("unknown");
    expect(backend.keys("").status).toBe("unknown");
  });
});

// ---- 보장 3: 키는 정해진 꼴만, 폴더 밖으로 나가지 않는다 ----

describe("보장 3: 키의 꼴", () => {
  const badKeys: readonly unknown[] = [
    "",
    "result/",
    "result",
    NAME_A,
    `results/${NAME_A}`,
    `/result/${NAME_A}`,
    `result/../${NAME_A}`,
    `../result/${NAME_A}`,
    "result/..",
    `result/${NAME_A}/x`,
    `result/${NAME_A}/`,
    `result//${NAME_A}`,
    `result\\${NAME_A}`,
    `result/${NAME_A.toUpperCase()}`,
    `result/${NAME_A}\u0000`,
    `result/${NAME_A}\n`,
    `result/.${NAME_A}.partial`,
    `result/${NAME_A}.partial`,
    `result/${NAME_A}x`,
    `result/${"a".repeat(10_000)}`,
    "/etc/passwd",
    7,
    null,
    undefined,
  ];

  test("꼴 밖의 키는 모든 연산에서 파일 시스템을 부르기 전에 unknown(invalid_key)이다", () => {
    // 보관 폴더를 임시 폴더 안에 한 겹 더 둔다. 꼴 검사가 빠져 `..`가 통과해도 쓰기가 시험의 임시 폴더 밖으로 나가지 않는다.
    const outer = tempDir();
    const dir = join(outer, "store");
    mkdirSync(dir);
    const port = new SpyPort();
    const backend = fileBackend(dir, { files: port });
    port.calls.splice(0);
    const refused = { status: "unknown", reason: "invalid_key" } as const;
    for (const key of badKeys as string[]) {
      expect(backend.putNew(key, bytesOf("x"))).toEqual(refused);
      expect(backend.read(key)).toEqual(refused);
      expect(backend.readRange(key, 0, 1)).toEqual(refused);
      expect(backend.has(key)).toEqual(refused);
      expect(backend.remove(key)).toEqual(refused);
    }
    expect(port.calls).toEqual([]);
    expect(listing(outer)).toEqual(["store"]);
    expect(listing(dir)).toEqual([]);
  });

  test("keys는 키 꼴의 이름만 낸다: 임시 파일·모르는 파일·대문자 이름은 내지 않는다", () => {
    const dir = tempDir();
    const backend = fileBackend(dir);
    backend.putNew(KEY_A, bytesOf("a"));
    for (const name of [`.${NAME_B}.partial`, "notes.txt", NAME_B.toUpperCase(), `${NAME_B}.bak`, "result"]) writeFileSync(join(dir, name), "?");
    expect(backend.keys("result/")).toEqual({ status: "ok", keys: [KEY_A] });
    expect(backend.keys("")).toEqual({ status: "ok", keys: [KEY_A] });
    const listed = listStored(backend);
    expect(listed.status === "ok" ? listed.entries.length : listed).toBe(1);
  });

  test("만들기: 폴더는 정규화된 절대 경로, 상한은 양의 안전 정수만 받는다", () => {
    for (const dir of ["", "relative/dir", "./x", "/a/../b", "/a/./b", "/a//b", "/a/", "/a\u0000b", 7 as never]) {
      expect(createFileResultBackend({ dir, maxRecordBytes: 16 })).toEqual({ status: "invalid", reason: "dir" });
    }
    for (const maxRecordBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "16" as never]) {
      expect(createFileResultBackend({ dir: "/x", maxRecordBytes })).toEqual({ status: "invalid", reason: "max_record_bytes" });
    }
    expect(createFileResultBackend({ dir: tempDir(), maxRecordBytes: 1 }).status).toBe("ok");
  });

  test("만들기: 보관 폴더는 링크가 아닌 실제 폴더여야 한다. 아니거나 확인하지 못하면 invalid(not_dir)", () => {
    const parent = tempDir();
    const real = join(parent, "store");
    mkdirSync(real);
    const linked = join(parent, "linked");
    symlinkSync(real, linked);
    const file = join(parent, "file");
    writeFileSync(file, "폴더가 아님");
    const refused = { status: "invalid", reason: "not_dir" } as const;
    for (const dir of [linked, file, join(parent, "gone"), join(file, "below")]) expect(createFileResultBackend({ dir, maxRecordBytes: 16 })).toEqual(refused);
    const port = new SpyPort();
    port.failNext("lstat", "EACCES");
    expect(createFileResultBackend({ dir: real, maxRecordBytes: 16, files: port })).toEqual(refused);
    // 실제 경로로 만든 백엔드는 키 연산과 목록이 같은 폴더를 본다.
    const backend = fileBackend(real);
    expect(backend.putNew(KEY_A, bytesOf("a"))).toEqual({ status: "stored" });
    expect(backend.keys("result/")).toEqual({ status: "ok", keys: [KEY_A] });
    expect(listing(real)).toEqual([NAME_A]);
  });
});
