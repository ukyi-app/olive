// 작업자 실행기의 지속 상태 저장소(파일). 파드가 다시 떠도 남는 볼륨의 폴더 하나를 이 실행기만 쓴다(replicas 1).
//
//   storage-id            저장소 ID. 없으면 새로 만든다. 주체 이름의 마지막 칸이 이 값이라, 폴더가 초기화되면 옛 지시는 wrong_recipient다.
//   stop-generation.json  정지 세대. 파일이 없으면 세대 없음(null)이다. 0도 파일로 적는다(0은 "한 번도 정지하지 않음"이라는 알려진 값).
//   runs/<run_id>.json    실행 기록(세대, 상태, 마지막 영수증 id 등)
//   outbox/<id>.json      보낸 영수증·보고의 본문. 같은 id와 같은 본문으로 다시 보낸다
//   nonces/<hash>         쓴 nonce 하나가 빈 파일 하나다
//   probe                 저장 장애 뒤 쓰기가 돌아왔는지 확인하는 빈 기록
//
// 쓰기는 한 줄로 차례로 한다(아래 serial). 상태 파일은 임시 파일에 쓰고 fsync한 뒤 rename하고 폴더도 fsync한다.
// nonce 기록의 보장 범위는 "프로세스·파드 재시작 뒤에도 재사용 거부"까지다. fsync하지 않는다. 페이지 캐시를 잃는 노드 정전은
// 복구가 봉투 수명(30초) + 시계 오차보다 오래 걸린다는 전제에 서고, 그때는 기록이 없어도 시한 검사가 먼저 거절한다.
//
// 저장 장애: 파일에 적지 못한 영수증·보고는 보내지 않는다(재전송할 원본이 없는 것을 보내지 않는다). 이미 일어난 사실(상태 변화,
// 종료 확인)은 메모리에 두고 flush가 다시 적는다. 장애가 남아 있는 동안 healthy()가 false이고 실행기는 새 접수를 닫는다.
// nonce 기록의 실패(이미 있음 밖의 오류)도 장애다. 그 봉투는 replayed로 거절되지만(계약의 반환은 참·거짓뿐이다) 실행기는 장애로 안다.
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
  // 없을 때만 빈 파일을 만든다. 이미 있으면 code가 EEXIST인 오류를 던진다.
  createMarker(path: string): Promise<void>;
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
const SUBDIRS = ["runs", "outbox", "nonces"] as const;

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

async function createMarker(path: string): Promise<void> {
  const handle = await open(path, NEW_FILE, 0o600);
  await handle.close();
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

// 본문의 계약 모양은 실행기가 서명해 보며 다시 본다(worker.ts). 여기서는 본문이 그 기록의 id·실행을 가리키는지까지 본다.
function parseOutbox(value: unknown): OutboxEntry {
  const e = value as Record<string, unknown>;
  const body = e?.body as Record<string, unknown> | undefined;
  const ok =
    typeof value === "object" &&
    value !== null &&
    typeof e.id === "string" &&
    UUID.test(e.id) &&
    OUTBOX_ACTIONS.includes(e.action as OutboxAction) &&
    typeof e.run_id === "string" &&
    UUID.test(e.run_id) &&
    isSafeInt(e.run_generation, 1) &&
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    (e.action === "report_result" ? body.report_id : body.receipt_id) === e.id &&
    body.run_id === e.run_id &&
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

// 기존 저장소의 두 장부가 서로를 설명하지 못하는 사유. 이때 실행기는 접수를 닫는다(복원으로 빈 장부를 새로 연 것과 구별한다).
export type StoreInconsistency = "storage_id_lost" | "dir_missing" | "stop_generation_missing" | "run_missing" | "receipt_missing" | "outbox_body";

export class ExecutorStore implements NonceStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly runMap = new Map<string, RunRecord>();
  private readonly outboxMap = new Map<string, OutboxEntry>();
  // 파일에 적지 못한 영수증·보고(보내지 않는다)와 실행 기록. flush가 다시 적는다.
  private readonly pendingOutbox = new Map<string, OutboxEntry>();
  private readonly pendingRuns = new Set<string>();
  // 지금 적고 있는 영수증·보고. 장애가 아니고 아직 보내지도 않는다.
  private readonly writingOutbox = new Map<string, OutboxEntry>();
  // 다시 적을 것이 없는 장애(nonce 기록, 접수 기록 실패). flush가 probe를 적어 풀린 것을 확인한다.
  private faulted = false;
  private inconsistent: StoreInconsistency | null = null;
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
    this.io = { writeDurable, createMarker, ...io };
  }

  // 최초 초기화(storage-id가 없음)와 기존 저장소 열기를 구분한다. 기존 저장소는 하위 폴더를 새로 만들지 않고,
  // 두 장부(실행 기록, outbox)가 서로를 설명하는지 대조한다. 설명하지 못하면 열되 inconsistency()로 알린다.
  static async open(dir: string, options: StoreOptions = {}): Promise<ExecutorStore> {
    if (!isAbsolute(dir)) throw new StoreError("config_invalid");
    let fresh: boolean;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (!(await lstat(dir)).isDirectory()) throw new Error();
      fresh = (await readOptional(join(dir, "storage-id"))) === null;
      if (fresh) for (const sub of SUBDIRS) await mkdir(join(dir, sub), { recursive: true, mode: 0o700 });
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
    const note = (reason: StoreInconsistency) => (store.inconsistent ??= reason);
    for (const [sub, add] of [
      [
        "runs",
        (name: string, v: unknown) => {
          const record = parseRun(v);
          if (name !== `${record.run_id}.json`) throw new StoreError("store_corrupt");
          store.runMap.set(record.run_id, record);
        },
      ],
      [
        "outbox",
        (name: string, v: unknown) => {
          const entry = parseOutbox(v);
          if (name !== `${entry.id}.json`) throw new StoreError("store_corrupt");
          store.outboxMap.set(entry.id, entry);
        },
      ],
    ] as const) {
      let names: string[];
      try {
        names = await readdir(join(dir, sub));
      } catch (error) {
        if (code(error) !== "ENOENT") throw new StoreError("store_unavailable");
        note("dir_missing");
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          add(name, JSON.parse(await readFile(join(dir, sub, name), "utf8")));
        } catch {
          throw new StoreError("store_corrupt");
        }
      }
    }
    try {
      await lstat(join(dir, "nonces"));
    } catch {
      note("dir_missing");
    }
    // 새 ID를 만든 폴더에 옛 기록이 있으면 ID를 잃은 부분 복원이다.
    if (fresh && (stop !== null || store.runMap.size > 0 || store.outboxMap.size > 0)) note("storage_id_lost");
    if (store.runMap.size > 0 && stop === null) note("stop_generation_missing");
    for (const entry of store.outboxMap.values()) {
      if (store.runMap.get(entry.run_id)?.run_generation !== entry.run_generation) note("run_missing");
    }
    for (const record of store.runMap.values()) {
      if (record.last_receipt_id !== null && !store.outboxMap.has(record.last_receipt_id)) note("receipt_missing");
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

  // ---- 상태 ----

  inconsistency(): StoreInconsistency | null {
    return this.inconsistent;
  }

  // 실행기가 열 때 outbox 본문의 계약 모양을 대조하고 맞지 않으면 알린다.
  markInconsistent(reason: StoreInconsistency): void {
    this.inconsistent ??= reason;
  }

  // 적지 못한 것이 남았거나 장애를 본 뒤 아직 확인하지 못했으면 false다.
  healthy(): boolean {
    return !this.faulted && this.pendingOutbox.size === 0 && this.pendingRuns.size === 0;
  }

  // 적지 못한 실행 기록과 영수증·보고를 다시 적는다. 새로 적은 영수증·보고를 적은 차례대로 돌려준다(부르는 쪽이 이제 보낸다).
  flush(): Promise<OutboxEntry[]> {
    return this.serial(async () => {
      const written: OutboxEntry[] = [];
      try {
        for (const runId of [...this.pendingRuns]) {
          await this.io.writeDurable(join(this.dir, "runs", `${runId}.json`), JSON.stringify(this.runMap.get(runId)));
          this.pendingRuns.delete(runId);
        }
        for (const [id, entry] of [...this.pendingOutbox]) {
          await this.io.writeDurable(join(this.dir, "outbox", `${id}.json`), JSON.stringify(entry));
          this.pendingOutbox.delete(id);
          this.outboxMap.set(id, entry);
          written.push(structuredClone(entry));
        }
        if (this.faulted) {
          await this.io.writeDurable(join(this.dir, "probe"), "");
          this.faulted = false;
        }
      } catch {
        // 다음 flush에서 다시 본다
      }
      return written;
    });
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
  // 같은 값을 다시 부르면 파일이 그보다 낮을 때 적는다(앞서 실패해 메모리만 올라간 세대를 재맞춤이 디스크에 맞춘다).
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

  // 처음 보는 (sender, nonce)면 기록하고 true. 이미 있거나, 소비 시각에 이미 만료됐거나, 기록하지 못했으면 false다.
  // 파일 이름은 낸 쪽 이름과 nonce의 SHA-256이다. 낸 쪽 이름에 '/'가 들어 있어 그대로 쓰지 않는다.
  // 만료는 이 직렬 구간 안의 실제 소비 시각으로 다시 본다. 줄이 밀려 검증 시각보다 늦게 소비하면, 정리가 첫 표식을 지운 뒤
  // 같은 이름을 다시 만들어 같은 봉투를 두 번 받을 수 있기 때문이다. 만료됐으면 표식을 만들지 않는다.
  consume(sender: string, nonce: string, expiresAt: number): Promise<boolean> {
    return this.serial(async () => {
      await this.pruneNonces(this.now());
      const now = this.now();
      if (!Number.isSafeInteger(expiresAt) || now >= expiresAt) return false;
      const name = createHash("sha256").update(`${sender}\n${nonce}`).digest("hex");
      const path = join(this.dir, "nonces", name);
      try {
        await this.io.createMarker(path);
      } catch (error) {
        // 이미 있음은 재사용이다. 그 밖의 오류는 저장 장애다(그 봉투도 받지 않는다).
        if (code(error) !== "EEXIST") this.faulted = true;
        return false;
      }
      try {
        await utimes(path, now / 1000, now / 1000);
      } catch {
        // 기록 실패가 아니다. 파일은 이미 있어 같은 nonce는 계속 거절되고, mtime은 만든 순간의 실제 시각으로 남아
        // 정리만 주입한 시계 대신 실제 시계를 따른다.
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

  // 새 실행의 접수. 파일에 적었을 때만 메모리를 바꾼다. 적지 못하면 접수하지 않고 장애로 둔다.
  beginRun(record: RunRecord): Promise<boolean> {
    return this.serial(async () => {
      if (this.runMap.has(record.run_id)) return false;
      try {
        await this.io.writeDurable(join(this.dir, "runs", `${record.run_id}.json`), JSON.stringify(record));
      } catch {
        this.faulted = true;
        return false;
      }
      this.runMap.set(record.run_id, { ...record });
      return true;
    });
  }

  // 이미 일어난 사실(상태 변화)의 기록. 파일에 적지 못해도 이 프로세스는 기억하고 flush가 다시 적는다. 적지 못했으면 false다.
  noteRun(record: RunRecord): Promise<boolean> {
    this.runMap.set(record.run_id, { ...record });
    return this.serial(async () => {
      try {
        await this.io.writeDurable(join(this.dir, "runs", `${record.run_id}.json`), JSON.stringify(this.runMap.get(record.run_id)));
        this.pendingRuns.delete(record.run_id);
        return true;
      } catch {
        this.pendingRuns.add(record.run_id);
        return false;
      }
    });
  }

  // ---- 보낸 영수증·보고 ----

  // 아래 셋은 적지 못한 항목도 돌려준다(같은 사실의 영수증을 새로 만들지 않으려고 대조할 때 쓴다). 보낼지는 persisted로 가른다.
  outbox(id: string): OutboxEntry | undefined {
    const entry = this.outboxMap.get(id) ?? this.writingOutbox.get(id) ?? this.pendingOutbox.get(id);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  outboxFor(runId: string): OutboxEntry[] {
    return [...this.outboxMap.values(), ...this.writingOutbox.values(), ...this.pendingOutbox.values()]
      .filter((entry) => entry.run_id === runId)
      .map((entry) => structuredClone(entry));
  }

  outboxAll(): OutboxEntry[] {
    return [...this.outboxMap.values()].map((entry) => structuredClone(entry));
  }

  persisted(id: string): boolean {
    return this.outboxMap.has(id);
  }

  // 다시 보낼 것: 파일에 적었고 받음 확인이 없는 것.
  unacked(): OutboxEntry[] {
    return [...this.outboxMap.values()].filter((entry) => !entry.acked).map((entry) => structuredClone(entry));
  }

  // 파일에 적은 뒤에만 보낼 수 있는 목록(outboxMap)에 넣는다. 적는 동안은 writing, 적지 못하면 pending에 두고 false다.
  addOutbox(entry: OutboxEntry): Promise<boolean> {
    const copy = structuredClone(entry);
    this.writingOutbox.set(copy.id, copy);
    return this.serial(async () => {
      this.writingOutbox.delete(copy.id);
      try {
        await this.io.writeDurable(join(this.dir, "outbox", `${copy.id}.json`), JSON.stringify(copy));
      } catch {
        this.pendingOutbox.set(copy.id, copy);
        return false;
      }
      this.outboxMap.set(copy.id, copy);
      return true;
    });
  }

  // ack는 다시 보내기를 멈추는 표시일 뿐이다. 기록은 지우지 않는다(같은 지시가 다시 오면 같은 영수증을 낸다).
  // 표시를 적지 못해도 장애로 두지 않는다: 다시 뜬 뒤 한 번 더 보낼 뿐이다.
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
