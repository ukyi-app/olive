// 작업자 실행기의 지속 상태 저장소(파일). 파드가 다시 떠도 남는 볼륨의 폴더 하나를 이 실행기만 쓴다(replicas 1).
//
//   storage-id            저장소 ID. 없으면 새로 만든다. 주체 이름의 마지막 칸이 이 값이라, 폴더가 초기화되면 옛 지시는 wrong_recipient다.
//   stop-generation.json  정지 세대. 파일이 없으면 세대 없음(null)이다. 0도 파일로 적는다(0은 "한 번도 정지하지 않음"이라는 알려진 값).
//   runs/<run_id>.json    실행 기록(세대, 상태, 마지막 영수증 id 등)
//   outbox/<id>.json      보낸 영수증·보고의 본문. 같은 id와 같은 본문으로 다시 보낸다
//   nonces/<hash>         쓴 nonce 하나가 빈 파일 하나다
//
// 쓰기는 한 줄로 차례로 한다(아래 serial). 상태 파일은 임시 파일에 쓰고 fsync한 뒤 rename하고 폴더도 fsync한다.
// nonce 기록의 보장 범위는 "프로세스·파드 재시작 뒤에도 재사용 거부"까지다. fsync하지 않는다. 페이지 캐시를 잃는 노드 정전은
// 복구가 봉투 수명(30초) + 시계 오차보다 오래 걸린다는 전제에 서고, 그때는 기록이 없어도 시한 검사가 먼저 거절한다.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, utimes } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { limits, type NonceStore, type RunState } from "../contract/v1/index.ts";

export class StoreError extends Error {
  constructor(readonly code: "config_invalid" | "store_unavailable" | "store_corrupt") {
    super(code);
  }
}

export type ExitKind = "completed" | "cancelled" | "deadline" | "failed";
const EXITS: readonly ExitKind[] = ["completed", "cancelled", "deadline", "failed"];

// 실행기에 기록이 있는 실행의 상태. not_known은 기록이 없다는 뜻이라 저장하지 않는다.
export type StoredRunState = Exclude<RunState, "not_known">;

export interface RunRecord {
  run_id: string;
  run_generation: number;
  state: StoredRunState;
  // 접수한 task_start 머리의 정지 세대. 띄우기 직전에 지금 세대와 같은지 다시 본다.
  start_stop_generation: number;
  instruction_request_id: string;
  deadline_at: number;
  lease_until: number;
  credential_digest: string;
  exit: ExitKind | null;
  last_receipt_id: string | null;
}

export type OutboxAction = "receipt_accepted" | "receipt_started" | "receipt_stopped" | "receipt_cleaned" | "report_result";
const OUTBOX_ACTIONS: readonly OutboxAction[] = ["receipt_accepted", "receipt_started", "receipt_stopped", "receipt_cleaned", "report_result"];

export interface OutboxEntry {
  // receipt_id 또는 report_id
  id: string;
  action: OutboxAction;
  run_id: string;
  run_generation: number;
  body: Record<string, unknown>;
  acked: boolean;
}

// 시험이 쓰기 실패를 넣는 자리. 기본은 파일 쓰기다.
export interface StoreIo {
  writeDurable(path: string, data: string): Promise<void>;
}

export interface StoreOptions {
  now?: () => number;
  io?: Partial<StoreIo>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORAGE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STATES: readonly StoredRunState[] = [
  "preparing",
  "running",
  "stopping",
  "checking",
  "ready_result",
  "finalized",
  "not_started",
  "failed_stopped",
  "unknown_running",
  "cleanup_pending",
];
const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

async function writeDurable(path: string, data: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, NEW_FILE, 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  const dir = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

const isSafeInt = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min;

function parseRun(value: unknown): RunRecord {
  const r = value as Record<string, unknown>;
  const ok =
    typeof value === "object" &&
    value !== null &&
    typeof r.run_id === "string" &&
    UUID.test(r.run_id) &&
    isSafeInt(r.run_generation, 1) &&
    STATES.includes(r.state as StoredRunState) &&
    isSafeInt(r.start_stop_generation, 0) &&
    typeof r.instruction_request_id === "string" &&
    UUID.test(r.instruction_request_id) &&
    isSafeInt(r.deadline_at, 1) &&
    isSafeInt(r.lease_until, 1) &&
    typeof r.credential_digest === "string" &&
    SHA256.test(r.credential_digest) &&
    (r.exit === null || EXITS.includes(r.exit as ExitKind)) &&
    (r.last_receipt_id === null || (typeof r.last_receipt_id === "string" && UUID.test(r.last_receipt_id))) &&
    Object.keys(r).length === 10;
  if (!ok) throw new StoreError("store_corrupt");
  return r as unknown as RunRecord;
}

function parseOutbox(value: unknown): OutboxEntry {
  const e = value as Record<string, unknown>;
  const ok =
    typeof value === "object" &&
    value !== null &&
    typeof e.id === "string" &&
    UUID.test(e.id) &&
    OUTBOX_ACTIONS.includes(e.action as OutboxAction) &&
    typeof e.run_id === "string" &&
    UUID.test(e.run_id) &&
    isSafeInt(e.run_generation, 1) &&
    typeof e.body === "object" &&
    e.body !== null &&
    !Array.isArray(e.body) &&
    typeof e.acked === "boolean" &&
    Object.keys(e).length === 6;
  if (!ok) throw new StoreError("store_corrupt");
  return e as unknown as OutboxEntry;
}

function parseStopGeneration(text: string): number {
  const value = JSON.parse(text) as unknown;
  const g = (value as { stop_generation?: unknown } | null)?.stop_generation;
  if (typeof value !== "object" || value === null || Object.keys(value).length !== 1 || !isSafeInt(g, 0)) throw new StoreError("store_corrupt");
  return g;
}

const code = (error: unknown) => (error as { code?: string } | null)?.code;

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw new StoreError("store_unavailable");
  }
}

export class ExecutorStore implements NonceStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly runMap = new Map<string, RunRecord>();
  private readonly outboxMap = new Map<string, OutboxEntry>();
  // 파일에 적힌 정지 세대와, 그보다 먼저 올리는 메모리의 울타리. 울타리는 adoptStopGeneration이 첫 await 전에 올린다.
  // 그래서 저장이 끝나기 전(또는 실패한 뒤)에도 낮은 세대의 지시로 새 실행이 열리지 않는다.
  private durable: number | null;
  private fence: number | null;
  private readonly io: StoreIo;

  private constructor(
    private readonly dir: string,
    readonly storageId: string,
    stopGeneration: number | null,
    private readonly now: () => number,
    io: Partial<StoreIo>,
  ) {
    this.durable = stopGeneration;
    this.fence = stopGeneration;
    this.io = { writeDurable, ...io };
  }

  static async open(dir: string, options: StoreOptions = {}): Promise<ExecutorStore> {
    if (!isAbsolute(dir)) throw new StoreError("config_invalid");
    try {
      for (const sub of ["", "runs", "outbox", "nonces"]) await mkdir(join(dir, sub), { recursive: true, mode: 0o700 });
      if (!(await lstat(dir)).isDirectory()) throw new Error();
    } catch {
      throw new StoreError("store_unavailable");
    }
    const id = await ExecutorStore.storageIdOf(dir);
    const stopText = await readOptional(join(dir, "stop-generation.json"));
    let stop: number | null = null;
    if (stopText !== null) {
      try {
        stop = parseStopGeneration(stopText);
      } catch {
        throw new StoreError("store_corrupt");
      }
    }
    const store = new ExecutorStore(dir, id, stop, options.now ?? Date.now, options.io ?? {});
    for (const [sub, add] of [
      ["runs", (v: unknown) => store.runMap.set(parseRun(v).run_id, v as RunRecord)],
      ["outbox", (v: unknown) => store.outboxMap.set(parseOutbox(v).id, v as OutboxEntry)],
    ] as const) {
      let names: string[];
      try {
        names = await readdir(join(dir, sub));
      } catch {
        throw new StoreError("store_unavailable");
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          add(JSON.parse(await readFile(join(dir, sub, name), "utf8")));
        } catch {
          throw new StoreError("store_corrupt");
        }
      }
    }
    return store;
  }

  // 없을 때만 만든다. link는 이름이 이미 있으면 실패하므로 "없을 때만"이 설치 순간에 지켜진다.
  // 저장소 ID는 다시 쓰지 않는다: 폴더가 초기화되면 새 무작위 값이 되어 옛 저장소 앞의 지시가 받는 쪽 이름에서 갈린다.
  private static async storageIdOf(dir: string): Promise<string> {
    const path = join(dir, "storage-id");
    const read = async () => {
      const text = (await readFile(path, "utf8")).trim();
      if (!STORAGE_ID.test(text)) throw new StoreError("store_corrupt");
      return text;
    };
    try {
      return await read();
    } catch (error) {
      if (error instanceof StoreError) throw error;
      if (code(error) !== "ENOENT") throw new StoreError("store_unavailable");
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeDurable(temporary, randomUUID());
      await link(temporary, path).catch((error: unknown) => {
        if (code(error) !== "EEXIST") throw error;
      });
    } catch {
      throw new StoreError("store_unavailable");
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return read();
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step, step);
    this.queue = run.catch(() => {});
    return run;
  }

  // ---- 정지 세대 ----

  // 검증과 띄우기 직전 확인이 쓰는 값. 저장 중이거나 저장에 실패한 더 높은 세대도 이미 들어 있다.
  stopGeneration(): number | null {
    return this.fence;
  }

  durableStopGeneration(): number | null {
    return this.durable;
  }

  // 더 높은 세대를 적는다. 메모리 울타리는 부르는 즉시(첫 await 전) 올린다.
  // 저장 순간에 단조 증가를 다시 본다: 줄의 앞에서 더 높은 값이 이미 적혔으면 낮은 값으로 덮지 않는다.
  // saved가 false면 파일에 적지 못했다. 부르는 쪽은 종료는 계속하되 새 지시를 받지 않는다.
  adoptStopGeneration(generation: number): Promise<{ saved: boolean; current: number }> {
    if (!isSafeInt(generation, 0)) return Promise.resolve({ saved: false, current: this.fence ?? -1 });
    if (this.fence === null || generation > this.fence) this.fence = generation;
    return this.serial(async () => {
      const onDisk = this.durable;
      if (onDisk !== null && onDisk >= generation) return { saved: true, current: this.fence ?? onDisk };
      try {
        await this.io.writeDurable(join(this.dir, "stop-generation.json"), JSON.stringify({ stop_generation: generation }));
      } catch {
        return { saved: false, current: this.fence ?? generation };
      }
      this.durable = generation;
      return { saved: true, current: this.fence ?? generation };
    });
  }

  // ---- nonce ----

  // 처음 보는 (sender, nonce)면 기록하고 true. 이미 있거나 기록하지 못했으면 false다(받지 않는 쪽으로 닫는다).
  // 파일 이름은 낸 쪽 이름과 nonce의 SHA-256이다. 낸 쪽 이름에 '/'가 들어 있어 그대로 쓰지 않는다.
  consume(sender: string, nonce: string, _expiresAt: number): Promise<boolean> {
    return this.serial(async () => {
      const now = this.now();
      await this.pruneNonces(now);
      const name = createHash("sha256").update(`${sender}\n${nonce}`).digest("hex");
      const path = join(this.dir, "nonces", name);
      try {
        const handle = await open(path, NEW_FILE, 0o600);
        await handle.close();
      } catch {
        return false;
      }
      try {
        await utimes(path, now / 1000, now / 1000);
      } catch {
        // 기록은 남았다. 같은 nonce는 계속 거절되고, 정리는 실제 mtime으로 한다.
      }
      return true;
    });
  }

  private async pruneNonces(now: number): Promise<void> {
    const dir = join(this.dir, "nonces");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!SHA256.test(name)) continue;
      try {
        if (now - (await lstat(join(dir, name))).mtimeMs > limits.NONCE_RETENTION_MS) await rm(join(dir, name), { force: true });
      } catch {
        // 다음 정리에서 다시 본다
      }
    }
  }

  // ---- 실행 기록 ----

  run(runId: string): RunRecord | undefined {
    const record = this.runMap.get(runId);
    return record === undefined ? undefined : { ...record };
  }

  runs(): RunRecord[] {
    return [...this.runMap.values()].map((record) => ({ ...record }));
  }

  // 새 실행의 접수. 파일에 적었을 때만 메모리를 바꾼다. 적지 못하면 접수하지 않는다.
  beginRun(record: RunRecord): Promise<boolean> {
    return this.serial(async () => {
      if (this.runMap.has(record.run_id)) return false;
      try {
        await this.io.writeDurable(join(this.dir, "runs", `${record.run_id}.json`), JSON.stringify(record));
      } catch {
        return false;
      }
      this.runMap.set(record.run_id, { ...record });
      return true;
    });
  }

  // 이미 일어난 사실(상태 변화)의 기록. 파일에 적지 못해도 이 프로세스는 기억한다. 적지 못했으면 false다.
  noteRun(record: RunRecord): Promise<boolean> {
    this.runMap.set(record.run_id, { ...record });
    return this.serial(async () => {
      try {
        await this.io.writeDurable(join(this.dir, "runs", `${record.run_id}.json`), JSON.stringify(this.runMap.get(record.run_id)));
        return true;
      } catch {
        return false;
      }
    });
  }

  // ---- 보낸 영수증·보고 ----

  outbox(id: string): OutboxEntry | undefined {
    const entry = this.outboxMap.get(id);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  outboxFor(runId: string): OutboxEntry[] {
    return [...this.outboxMap.values()].filter((entry) => entry.run_id === runId).map((entry) => structuredClone(entry));
  }

  unacked(): OutboxEntry[] {
    return [...this.outboxMap.values()].filter((entry) => !entry.acked).map((entry) => structuredClone(entry));
  }

  addOutbox(entry: OutboxEntry): Promise<boolean> {
    this.outboxMap.set(entry.id, structuredClone(entry));
    return this.serial(async () => {
      try {
        await this.io.writeDurable(join(this.dir, "outbox", `${entry.id}.json`), JSON.stringify(entry));
        return true;
      } catch {
        return false;
      }
    });
  }

  // ack는 다시 보내기를 멈추는 표시일 뿐이다. 기록은 지우지 않는다(같은 지시가 다시 오면 같은 영수증을 낸다).
  ack(ids: readonly string[]): Promise<boolean> {
    const changed = ids.map((id) => this.outboxMap.get(id)).filter((entry): entry is OutboxEntry => entry !== undefined && !entry.acked);
    for (const entry of changed) entry.acked = true;
    return this.serial(async () => {
      let ok = true;
      for (const entry of changed) {
        try {
          await this.io.writeDurable(join(this.dir, "outbox", `${entry.id}.json`), JSON.stringify(entry));
        } catch {
          ok = false;
        }
      }
      return ok;
    });
  }
}
