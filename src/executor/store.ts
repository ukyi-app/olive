// 작업자 실행기의 지속 상태 저장소(파일). 파드가 다시 떠도 남는 볼륨의 폴더 하나를 이 실행기만 쓴다(replicas 1).
//
//   storage-id            저장소 ID. 없으면 새로 만든다. 주체 이름의 마지막 칸이 이 값이라, 폴더가 초기화되면 옛 지시는 wrong_recipient다.
//   stop-generation.json  정지 세대. 파일이 없으면 세대 없음(null)이다. 0도 파일로 적는다(0은 "한 번도 정지하지 않음"이라는 알려진 값).
//   runs/<run_id>.json    실행 기록(세대, 상태, 마지막 영수증 id, 정리 의도 등)
//   outbox/<id>.json      보낸 영수증·보고의 본문과 그 사건의 최초 순번. 같은 id와 같은 본문으로 다시 보낸다
//   nonces/<hash>         쓴 nonce 하나가 빈 파일 하나다
//   ledger-hold           설명할 수 없는 장부의 표식. 운영자가 장부를 대조하고 이 파일을 지울 때까지 접수를 열지 않는다
//   runs/probe, nonces/probe-*  실패했던 연산이 회복됐는지 그 연산으로 다시 해 보는 빈 기록
//
// 쓰기는 한 줄로 차례로 한다(아래 serial). 상태 파일은 임시 파일에 쓰고 fsync한 뒤 rename하고 폴더도 fsync한다.
// nonce 기록의 보장 범위는 "프로세스·파드 재시작 뒤에도 재사용 거부"까지다. fsync하지 않는다. 페이지 캐시를 잃는 노드 정전은
// 복구가 봉투 수명(30초) + 시계 오차보다 오래 걸린다는 전제에 서고, 그때는 기록이 없어도 시한 검사가 먼저 거절한다.
//
// 지속 전이(commit)가 이 파일의 중심이다. 실행 상태와 그 상태에 딸린 사건(영수증·보고)은 언제나 이 한 자리로 적는다.
// - 사건은 만든 순간 최초 순번을 받고, 파일에 적히기 전에도 조회에 보인다(같은 요청에 새 ID를 만들지 않는다). 보내는 것은 적은 뒤다.
// - 한 실행의 사건은 순번 차례로만 적는다. 앞 사건이 실패하면 뒤 사건도 적지 않으므로 디스크의 사건은 언제나 앞에서부터 이어진다.
// - 실행 기록은 그 실행의 사건이 모두 적힌 뒤에 적는다. 그래서 디스크의 상태는 그 상태가 전제한 사건 없이 남지 않고,
//   마지막 영수증 포인터도 적힌 사건 가운데 순번이 가장 큰 영수증만 가리킨다.
//
// 저장 장애: 파일에 적지 못한 사실은 메모리에 두고 flush가 같은 순서로 다시 적는다. 장애는 실패한 연산별로 기억하고,
// 그 연산을 실제로 다시 해 본 뒤에만 푼다(루트의 다른 파일이 써진다고 nonce 배타 생성이 회복된 것은 아니다).
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

// 프로세스가 살아 있을 수 있거나 정리가 남은 상태. 이 상태의 실행이 있으면 새 실행을 받지 않는다(슬롯 하나).
export const HOLDS_SLOT: readonly StoredRunState[] = ["preparing", "running", "stopping", "checking", "unknown_running", "cleanup_pending"];

// 폴더를 지우기 전에 적는 정리 의도. 영수증 ID를 미리 정해 두어 재시작해도 같은 ID로 잇는다.
export interface CleanupIntent {
  request_id: string;
  instruction_digest: string;
  receipt_id: string;
}

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
  cleanup?: CleanupIntent | null;
}

export type OutboxAction = "receipt_accepted" | "receipt_started" | "receipt_stopped" | "receipt_cleaned" | "report_result";
const OUTBOX_ACTIONS: readonly OutboxAction[] = ["receipt_accepted", "receipt_started", "receipt_stopped", "receipt_cleaned", "report_result"];
const RECEIPT_ACTIONS: readonly OutboxAction[] = ["receipt_accepted", "receipt_started", "receipt_stopped", "receipt_cleaned"];

export interface OutboxEntry {
  // receipt_id 또는 report_id
  id: string;
  action: OutboxAction;
  run_id: string;
  run_generation: number;
  body: Record<string, unknown>;
  acked: boolean;
}

// 전이에 싣는 사건. digest는 이 사건을 낳은 지시의 body_digest다(같은 요청 ID의 재전송을 본문까지 대조한다).
export interface NewEvent {
  entry: OutboxEntry;
  digest?: string | null;
}

// 전이 한 번의 결과. saved는 그 실행의 사건과 기록이 모두 파일에 적혔는지, written은 이번에 새로 적힌 사건(순번 차례)이다.
// 앞서 실패한 사건이 이번에 함께 적히면 written에 함께 들어온다. 부르는 쪽은 written만 보낸다.
export interface Committed {
  saved: boolean;
  written: OutboxEntry[];
}

interface StoredEvent {
  entry: OutboxEntry;
  seq: number;
  digest: string | null;
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
const HOLD_FILE = "ledger-hold";

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

function validIntent(value: unknown): boolean {
  const c = value as Record<string, unknown> | null;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof c?.request_id === "string" &&
    UUID.test(c.request_id) &&
    typeof c.instruction_digest === "string" &&
    SHA256.test(c.instruction_digest) &&
    typeof c.receipt_id === "string" &&
    UUID.test(c.receipt_id) &&
    Object.keys(c).length === 3
  );
}

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
    (r.cleanup === undefined || r.cleanup === null || validIntent(r.cleanup)) &&
    Object.keys(r).length === (r.cleanup === undefined ? 10 : 11);
  if (!ok) throw new StoreError("store_corrupt");
  return r as unknown as RunRecord;
}

// 본문의 계약 모양은 실행기가 서명해 보며 다시 본다(worker.ts). 여기서는 본문이 그 기록의 id·실행을 가리키는지까지 본다.
function parseOutbox(value: unknown): StoredEvent {
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
    isSafeInt(e.seq, 1) &&
    (e.instruction_digest === null || (typeof e.instruction_digest === "string" && SHA256.test(e.instruction_digest))) &&
    Object.keys(e).length === 8;
  if (!ok) throw new StoreError("store_corrupt");
  const { seq, instruction_digest, ...entry } = e;
  return { entry: entry as unknown as OutboxEntry, seq: seq as number, digest: instruction_digest as string | null };
}

const onDisk = (event: StoredEvent) => JSON.stringify({ ...event.entry, seq: event.seq, instruction_digest: event.digest });

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

// 기존 저장소의 장부가 서로를 설명하지 못하는 사유. 이때 실행기는 접수를 닫는다(복원으로 빈 장부를 새로 연 것과 구별한다).
export type StoreInconsistency =
  | "storage_id_lost"
  | "over_capacity"
  | "dir_missing"
  | "stop_generation_missing"
  | "run_missing"
  | "receipt_missing"
  | "receipt_mismatch"
  | "outbox_body";
const INCONSISTENCIES: readonly StoreInconsistency[] = [
  "storage_id_lost",
  "over_capacity",
  "dir_missing",
  "stop_generation_missing",
  "run_missing",
  "receipt_missing",
  "receipt_mismatch",
  "outbox_body",
];
// 장부 전체를 믿을 수 없는 사유. 이 장부로는 어떤 사건도 보내지 않고 정상 인사도 하지 않는다.
const WHOLE_LEDGER: readonly StoreInconsistency[] = ["storage_id_lost", "over_capacity"];

// 실패한 연산의 종류. 같은 연산을 다시 해 보고서야 푼다.
type StoreFault = "nonces" | "runs";

export class ExecutorStore implements NonceStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly runMap = new Map<string, RunRecord>();
  // 파일에 적힌 마지막 실행 기록. 밖으로 말하는 상태는 이것이다(적히지 않은 상태를 감독에게 말하지 않는다).
  private readonly durableRuns = new Map<string, RunRecord>();
  private readonly events = new Map<string, StoredEvent>();
  // 순번을 받았지만 아직 적히지 않은 사건. 적히는 중이거나 적기에 실패한 것이다. 조회에는 보이고 보내지는 않는다.
  private readonly unsaved = new Map<string, StoredEvent>();
  private nextSeq = 1;
  // 사건이나 실행 기록을 적지 못한 실행. flush가 다시 적는다.
  private readonly pendingRuns = new Set<string>();
  private readonly faults = new Set<StoreFault>();
  private nonceFaultListener: (() => void) | undefined;
  private inconsistent: StoreInconsistency | null = null;
  // 설명하지 못해 보내지도, 복구 증거로 쓰지도 않는 사건과 실행.
  private readonly suspectEvents = new Set<string>();
  private readonly suspectRuns = new Set<string>();
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
  // 장부가 서로를 설명하는지 대조한다. 설명하지 못하면 열되 inconsistency()로 알리고, 그 판정은 ledger-hold로 다음 기동에도 남긴다.
  static async open(dir: string, options: StoreOptions = {}): Promise<ExecutorStore> {
    if (!isAbsolute(dir)) throw new StoreError("config_invalid");
    const io: StoreIo = { writeDurable, createMarker, ...options.io };
    let fresh: boolean;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (!(await lstat(dir)).isDirectory()) throw new Error();
      fresh = (await readOptional(join(dir, "storage-id"))) === null;
      // 예전 장부가 남은 폴더에 새 ID를 설치하기 전에 표식을 남긴다. 표식을 적지 못하면 ID도 설치하지 않는다.
      if (fresh && (await ExecutorStore.hasLedger(dir))) await ExecutorStore.writeHold(dir, io, "storage_id_lost");
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
    const holdText = await readOptional(join(dir, HOLD_FILE));
    const held = holdText === null ? null : ExecutorStore.parseHold(holdText);
    if (held !== null) note(held);
    for (const [sub, add] of [
      [
        "runs",
        (name: string, v: unknown) => {
          const record = parseRun(v);
          if (name !== `${record.run_id}.json`) throw new StoreError("store_corrupt");
          store.runMap.set(record.run_id, record);
          store.durableRuns.set(record.run_id, { ...record });
        },
      ],
      [
        "outbox",
        (name: string, v: unknown) => {
          const event = parseOutbox(v);
          if (name !== `${event.entry.id}.json`) throw new StoreError("store_corrupt");
          store.events.set(event.entry.id, event);
          store.nextSeq = Math.max(store.nextSeq, event.seq + 1);
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
    if (store.runMap.size > 0 && stop === null) note("stop_generation_missing");
    for (const { entry } of store.events.values()) {
      if (store.runMap.get(entry.run_id)?.run_generation === entry.run_generation) continue;
      note("run_missing");
      store.suspectEvents.add(entry.id);
    }
    for (const record of store.runMap.values()) {
      if (record.last_receipt_id === null) continue;
      const target = store.events.get(record.last_receipt_id)?.entry;
      if (target === undefined) note("receipt_missing");
      else if (!RECEIPT_ACTIONS.includes(target.action) || target.run_id !== record.run_id || target.run_generation !== record.run_generation) {
        note("receipt_mismatch");
      } else continue;
      store.suspectRuns.add(record.run_id);
    }
    // hello는 실행을 STATUS_MAX_RUNS개까지만 싣는다. 점유가 그보다 많은 장부는 v1의 인사로 다 말할 수 없다.
    if ([...store.runMap.values()].filter((run) => HOLDS_SLOT.includes(run.state)).length > limits.STATUS_MAX_RUNS && !store.ledgerHeld()) {
      store.inconsistent = "over_capacity";
    }
    if (store.ledgerHeld()) for (const id of store.events.keys()) store.suspectEvents.add(id);
    if (store.inconsistent !== null && held === null) await ExecutorStore.writeHold(dir, io, store.inconsistent).catch(() => {});
    return store;
  }

  private static async hasLedger(dir: string): Promise<boolean> {
    if ((await readOptional(join(dir, "stop-generation.json"))) !== null) return true;
    for (const sub of ["runs", "outbox"]) {
      const names = await readdir(join(dir, sub)).catch((error: unknown) => {
        if (code(error) === "ENOENT") return [] as string[];
        throw error;
      });
      if (names.some((name) => name.endsWith(".json"))) return true;
    }
    return false;
  }

  private static writeHold(dir: string, io: StoreIo, reason: StoreInconsistency): Promise<void> {
    return io.writeDurable(join(dir, HOLD_FILE), JSON.stringify({ reason }));
  }

  private static parseHold(text: string): StoreInconsistency {
    let reason: unknown;
    try {
      reason = (JSON.parse(text) as { reason?: unknown } | null)?.reason;
    } catch {
      throw new StoreError("store_corrupt");
    }
    if (!INCONSISTENCIES.includes(reason as StoreInconsistency)) throw new StoreError("store_corrupt");
    return reason as StoreInconsistency;
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

  // 장부 전체를 믿을 수 없다. 이 장부로는 보내지 않고 정상 인사도 하지 않는다.
  ledgerHeld(): boolean {
    return this.inconsistent !== null && WHOLE_LEDGER.includes(this.inconsistent);
  }

  // 실행기가 열 때 outbox 본문의 계약 모양을 대조하고 맞지 않으면 알린다. 그 사건은 보내지 않고, 판정은 다음 기동에도 남긴다.
  markInconsistent(reason: StoreInconsistency, eventId?: string): void {
    if (eventId !== undefined) this.suspectEvents.add(eventId);
    if (this.inconsistent !== null) return;
    this.inconsistent = reason;
    void this.serial(() => ExecutorStore.writeHold(this.dir, this.io, reason)).catch(() => {});
  }

  suspectRun(runId: string): boolean {
    return this.suspectRuns.has(runId);
  }

  // 적지 못한 것이 남았거나 실패한 연산이 아직 회복되지 않았으면 false다. 적는 중인 사건은 장애가 아니다.
  healthy(): boolean {
    return this.faults.size === 0 && this.pendingRuns.size === 0;
  }

  // nonce 기록이 로컬에서 실패한 순간 알린다(거절된 봉투의 내용은 넘기지 않는다).
  onNonceFault(listener: () => void): void {
    this.nonceFaultListener = listener;
  }

  // 적지 못한 사건과 실행 기록을 같은 순서로 다시 적고, 실패했던 연산을 실제로 다시 해 본다.
  // 새로 적은 사건을 순번 차례로 돌려준다(부르는 쪽이 받아서 보낸다).
  flush(): Promise<OutboxEntry[]> {
    return this.serial(async () => {
      const written: StoredEvent[] = [];
      for (const runId of new Set([...this.pendingRuns, ...[...this.unsaved.values()].map((event) => event.entry.run_id)])) {
        for (const entry of (await this.drain(runId)).written) written.push(this.events.get(entry.id)!);
      }
      for (const fault of [...this.faults]) if (await this.recovered(fault)) this.faults.delete(fault);
      return written.sort((a, b) => a.seq - b.seq).map((event) => structuredClone(event.entry));
    });
  }

  private async recovered(fault: StoreFault): Promise<boolean> {
    try {
      if (fault === "nonces") {
        const path = join(this.dir, "nonces", `probe-${randomUUID()}`);
        await this.io.createMarker(path);
        await rm(path, { force: true }).catch(() => {});
      } else {
        await this.io.writeDurable(join(this.dir, "runs", "probe"), "");
      }
      return true;
    } catch {
      return false;
    }
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
      const onFile = this.durable;
      if (onFile !== null && onFile >= generation) return { saved: true, current: this.fence ?? onFile };
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
        if (code(error) !== "EEXIST") {
          this.faults.add("nonces");
          this.nonceFaultListener?.();
        }
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

  // 파일에 적힌 실행 기록. 감독에게 말하는 상태와 마지막 영수증은 이것으로 답한다.
  durableRun(runId: string): RunRecord | undefined {
    const record = this.durableRuns.get(runId);
    return record === undefined ? undefined : { ...record };
  }

  durableRunList(): RunRecord[] {
    return [...this.durableRuns.values()].map((record) => ({ ...record }));
  }

  // 그 실행의 사건이 모두 파일에 적혔는지.
  settled(runId: string): boolean {
    return ![...this.unsaved.values()].some((event) => event.entry.run_id === runId);
  }

  // 새 실행의 접수. 파일에 적었을 때만 메모리를 바꾼다. 적지 못하면 접수하지 않고 장애로 둔다.
  beginRun(record: RunRecord): Promise<boolean> {
    return this.serial(async () => {
      if (this.runMap.has(record.run_id)) return false;
      try {
        await this.io.writeDurable(join(this.dir, "runs", `${record.run_id}.json`), JSON.stringify(record));
      } catch {
        this.faults.add("runs");
        return false;
      }
      this.runMap.set(record.run_id, { ...record });
      this.durableRuns.set(record.run_id, { ...record });
      return true;
    });
  }

  // 지속 전이의 한 자리. 메모리는 부르는 즉시 바뀌고(첫 await 전), 사건은 순번을 받아 조회에 보인다.
  // 파일은 줄에서 그 실행의 사건을 순번 차례로 적은 뒤 마지막에 실행 기록을 적는다.
  commit(runId: string, patch: Partial<RunRecord>, events: readonly NewEvent[] = []): Promise<Committed> {
    const receipt = events.findLast((event) => RECEIPT_ACTIONS.includes(event.entry.action))?.entry.id;
    return this.apply(runId, receipt === undefined ? patch : { ...patch, last_receipt_id: receipt }, events);
  }

  private apply(runId: string, patch: Partial<RunRecord>, events: readonly NewEvent[]): Promise<Committed> {
    for (const event of events) {
      const entry = structuredClone(event.entry);
      this.unsaved.set(entry.id, { entry, seq: this.nextSeq++, digest: event.digest ?? null });
    }
    const current = this.runMap.get(runId);
    if (current !== undefined) this.runMap.set(runId, { ...current, ...patch });
    return this.serial(() => this.drain(runId));
  }

  // 앞 사건부터 차례로 적는다. 하나라도 실패하면 뒤 사건과 실행 기록을 적지 않고 flush에 맡긴다.
  private async drain(runId: string): Promise<Committed> {
    const written: OutboxEntry[] = [];
    try {
      for (;;) {
        const next = [...this.unsaved.values()].filter((event) => event.entry.run_id === runId).sort((a, b) => a.seq - b.seq)[0];
        if (next === undefined) break;
        await this.io.writeDurable(join(this.dir, "outbox", `${next.entry.id}.json`), onDisk(next));
        this.unsaved.delete(next.entry.id);
        this.events.set(next.entry.id, next);
        written.push(structuredClone(next.entry));
      }
      // 남은 사건이 없음을 본 이 자리에서 await 없이 스냅숏을 뜬다. 그 뒤의 전이는 자기 차례에 다시 적는다.
      const record = this.runMap.get(runId);
      if (record !== undefined) {
        const snapshot = { ...record };
        await this.io.writeDurable(join(this.dir, "runs", `${runId}.json`), JSON.stringify(snapshot));
        this.durableRuns.set(runId, snapshot);
      }
      this.pendingRuns.delete(runId);
      return { saved: true, written };
    } catch {
      this.pendingRuns.add(runId);
      return { saved: false, written };
    }
  }

  // 사건이 없는 상태 변화의 기록. 적지 못했으면 false다.
  async noteRun(record: RunRecord): Promise<boolean> {
    return (await this.commit(record.run_id, record)).saved;
  }

  // ---- 보낸 영수증·보고 ----

  // 아래 셋은 적지 못한 항목도 돌려준다(같은 사실의 영수증을 새로 만들지 않으려고 대조할 때 쓴다). 보낼지는 sendable로 가른다.
  outbox(id: string): OutboxEntry | undefined {
    const event = this.events.get(id) ?? this.unsaved.get(id);
    return event === undefined ? undefined : structuredClone(event.entry);
  }

  outboxFor(runId: string): OutboxEntry[] {
    return [...this.events.values(), ...this.unsaved.values()]
      .filter((event) => event.entry.run_id === runId)
      .sort((a, b) => a.seq - b.seq)
      .map((event) => structuredClone(event.entry));
  }

  outboxAll(): OutboxEntry[] {
    return [...this.events.values()].sort((a, b) => a.seq - b.seq).map((event) => structuredClone(event.entry));
  }

  // 그 사건을 낳은 지시의 body_digest.
  instructionDigest(id: string): string | null {
    return (this.events.get(id) ?? this.unsaved.get(id))?.digest ?? null;
  }

  persisted(id: string): boolean {
    return this.events.has(id);
  }

  // 보내도 되는 사건: 파일에 적혔고 장부가 설명하는 것.
  sendable(id: string): boolean {
    return this.events.has(id) && !this.suspectEvents.has(id);
  }

  // 복구의 증거로 쓸 수 있는 사건: 파일에 적혔고, 장부가 설명하며, 그 실행·세대의 것.
  evidence(runId: string, runGeneration: number): OutboxEntry[] {
    if (this.suspectRuns.has(runId)) return [];
    return this.outboxAll().filter((entry) => entry.run_id === runId && entry.run_generation === runGeneration && !this.suspectEvents.has(entry.id));
  }

  // 다시 보낼 것: 파일에 적혔고, 장부가 설명하며, 받음 확인이 없는 것(순번 차례).
  unacked(): OutboxEntry[] {
    return this.outboxAll().filter((entry) => !entry.acked && !this.suspectEvents.has(entry.id));
  }

  // 사건 하나만 적고 마지막 영수증 포인터는 움직이지 않는다. 적지 못하면 false이고 flush가 다시 적는다.
  async addOutbox(entry: OutboxEntry, digest: string | null = null): Promise<boolean> {
    const { saved } = await this.apply(entry.run_id, {}, [{ entry, digest }]);
    return saved && this.events.has(entry.id);
  }

  // ack는 다시 보내기를 멈추는 표시일 뿐이다. 기록은 지우지 않는다(같은 지시가 다시 오면 같은 영수증을 낸다).
  // 표시를 적지 못해도 장애로 두지 않는다: 다시 뜬 뒤 한 번 더 보낼 뿐이다.
  ack(ids: readonly string[]): Promise<boolean> {
    const changed = ids.map((id) => this.events.get(id)).filter((event): event is StoredEvent => event !== undefined && !event.entry.acked);
    for (const event of changed) event.entry.acked = true;
    return this.serial(async () => {
      let ok = true;
      for (const event of changed) {
        try {
          await this.io.writeDurable(join(this.dir, "outbox", `${event.entry.id}.json`), onDisk(event));
        } catch {
          ok = false;
        }
      }
      return ok;
    });
  }
}
