// 작업자 실행기의 지속 상태 저장소(파일). 파드가 다시 떠도 남는 볼륨의 폴더 하나를 이 실행기만 쓴다(replicas 1).
//
//   storage-id            저장소 ID. 없으면 새로 만든다. 주체 이름의 마지막 칸이 이 값이라, 폴더가 초기화되면 옛 지시는 wrong_recipient다.
//   stop-generation.json  정지 세대. 파일이 없으면 세대 없음(null)이다. 0도 파일로 적는다(0은 "한 번도 정지하지 않음"이라는 알려진 값).
//   runs/<run_id>.json    실행 기록(세대, 상태, 마지막 영수증 id, 정리 의도, 접수한 파드의 UID 등). 정리 의도의 pod_uid는 아래 CleanupIntent.
//   outbox/<id>.json      보낸 영수증·보고의 본문과 그 사건의 최초 순번. 같은 id와 같은 본문으로 다시 보낸다
//   nonces/<hash>         쓴 nonce 하나가 빈 파일 하나다
//   ledger-hold           설명할 수 없는 장부의 표식. 운영자가 장부를 대조하고 이 파일을 지울 때까지 접수를 열지 않는다
//   nonces/probe-*        nonce 배타 생성이 회복됐는지 그 연산으로 다시 해 보는 빈 기록
//   restart-request.json  회복 요청(D-104): 원격이 잠긴 때 읽은 세대 표식과 그때 끝을 맺지 못한 실행. 조립(runtime.ts)만 쓰고 지운다.
//                         파드 전체 재시작 뒤에도 남아야 해서 이 볼륨에 둔다(제어 전용 emptyDir은 새 파드에서 비어 있다).
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
//
// 보류 판정: 장부를 설명하지 못한다는 판정은 파일(ledger-hold)에 남긴 다음에만 장부를 바꾼다. 원인을 지울 수 있는 쓰기(정지 세대, 상태 보정)가
// 판정보다 먼저 디스크에 닿으면 다음 기동이 멀쩡한 장부로 보기 때문이다. 판정을 적지 못하면 열기를 실패시키거나, 실행 중이면 쓰기를 멈춘다.
//
// 유효한 상태: 실행의 상태는 같은 실행·세대의 본문까지 검증된 사건이 그 상태의 전제(REQUIRED_EVENTS)를 모두 설명할 때만 인정한다.
// 설명하지 못하는 실행은 상태·사건·정리 승인을 함께 보류한다. 사건을 읽는 쪽은 모두 validEvents 한 자리만 본다.
// 상태를 쓰는 길은 모두 commit을 지나고, commit은 쓰기 전에 후보 상태의 전제(premiseBroken)를 본다. 기동 감사도 같은 함수로 대조한다.
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
// pod_uid는 의도를 처음 적은 파드의 UID다(D-155). 지금 파드와 다르면 worker가 대리에 묻지 않고 지운 것으로 본다(worker.ts의 podReplaced).
// 이 칸이 없는 의도는 칸을 쓰기 전의 판이 적은 것이라 어느 파드에서 적혔는지 모른다.
// 함정: 그 전의 판은 칸이 셋이 아닌 의도를 store_corrupt(83)로 거절한다. 이 칸을 한 번 적은 저장소는 비우지 않고는 그 판으로 되돌릴 수 없다.
export interface CleanupIntent {
  request_id: string;
  instruction_digest: string;
  receipt_id: string;
  pod_uid?: string;
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
  // 그 실행을 접수한 파드의 UID(D-155·D-171). 접수 때 한 번 적고 뒤 전이는 바꾸지 않는다. 기동 때 지금 파드와 다르면 그 기록은 다른 파드에서
  // 물려받은 것이다(worker.ts의 fromReplacedPod). 이 칸이 없는 기록은 칸을 쓰기 전의 판이 접수한 것이라 어느 파드에서 접수됐는지 모른다.
  // 함정: 그 전의 판은 칸 수가 10·11이 아닌 기록을 store_corrupt(83)로 거절한다. 이 칸을 한 번 적은 저장소는 비우지 않고는 그 판으로 되돌릴 수 없다.
  pod_uid?: string;
}

export type OutboxAction = "receipt_accepted" | "receipt_started" | "receipt_stopped" | "receipt_cleaned" | "report_result";
const OUTBOX_ACTIONS: readonly OutboxAction[] = ["receipt_accepted", "receipt_started", "receipt_stopped", "receipt_cleaned", "report_result"];
const RECEIPT_ACTIONS: readonly OutboxAction[] = ["receipt_accepted", "receipt_started", "receipt_stopped", "receipt_cleaned"];

// 상태마다 그 상태가 전제하는 사건. 끝을 맺지 않은 상태는 아무 사실도 말하지 않으므로 전제가 없다.
const REQUIRED_EVENTS: Readonly<Record<StoredRunState, readonly OutboxAction[]>> = {
  preparing: [],
  running: [],
  stopping: [],
  checking: [],
  unknown_running: [],
  not_started: ["receipt_stopped"],
  failed_stopped: ["receipt_stopped"],
  cleanup_pending: ["receipt_stopped"],
  ready_result: ["receipt_stopped", "report_result"],
  finalized: ["receipt_stopped", "receipt_cleaned"],
};

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
  // 지우고 폴더를 fsync한다. 이미 없으면 성공이다.
  removeDurable(path: string): Promise<void>;
}

// 회복 요청. marker는 init이 쓴 세대 표식(GENERATION_MARKER 꼴)이고, runs는 그때 끝을 맺지 못한 실행 ID다(빈 목록도 된다).
export interface RestartRequest {
  readonly marker: string;
  readonly runs: readonly string[];
}

// 세대 표식의 꼴: 32바이트 난수의 소문자 16진수 64자. init(src/main/agent-install.ts)이 쓰고 조립이 읽는다.
export const GENERATION_MARKER = /^[0-9a-f]{64}$/;
// 파드 UID의 꼴: API 서버가 정한 metadata.uid(소문자 UUID). 진입점(OLIVE_POD_UID)과 정리 의도의 pod_uid가 같은 꼴을 본다.
export const POD_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESTART_FILE = "restart-request.json";

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

async function removeDurable(path: string): Promise<void> {
  await rm(path, { force: true });
  const dir = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

function parseRestart(text: string): RestartRequest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StoreError("store_corrupt");
  }
  const r = value as Record<string, unknown> | null;
  const runs = r?.runs;
  const ok =
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 2 &&
    typeof r?.marker === "string" &&
    GENERATION_MARKER.test(r.marker) &&
    Array.isArray(runs) &&
    runs.every((id) => typeof id === "string" && UUID.test(id)) &&
    new Set(runs).size === runs.length;
  if (!ok) throw new StoreError("store_corrupt");
  return { marker: r!.marker as string, runs: [...(runs as string[])] };
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
    (c.pod_uid === undefined || (typeof c.pod_uid === "string" && POD_UID.test(c.pod_uid))) &&
    Object.keys(c).length === (c.pod_uid === undefined ? 3 : 4)
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
    (r.pod_uid === undefined || (typeof r.pod_uid === "string" && POD_UID.test(r.pod_uid))) &&
    Object.keys(r).length === 10 + (r.cleanup === undefined ? 0 : 1) + (r.pod_uid === undefined ? 0 : 1);
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
  // 적지 못한 최초 실행 기록(경로 → 내용). 그 경로에 그 내용을 실제로 다시 써 본 뒤에야 "runs" 장애가 풀린다.
  private readonly failedBegins = new Map<string, string>();
  private nonceFaultListener: (() => void) | undefined;
  private inconsistent: StoreInconsistency | null = null;
  // 파일에 적힌 보류 사유. inconsistent와 다르면 아직 지속되지 않은 판정이 있다.
  private holdOnDisk: StoreInconsistency | null = null;
  // 설명하지 못해 보내지도, 복구 증거로 쓰지도 않는 사건과 실행.
  private readonly suspectEvents = new Set<string>();
  private readonly suspectRuns = new Set<string>();
  // 실행 기록을 잃어 인사에 실을 수 없는 실행이 있다. 점유를 다 말할 수 없으므로 장부 전체를 보류한다.
  private unlisted = false;
  // 파일에 적힌 정지 세대와, 그보다 먼저 올리는 메모리의 울타리. 울타리는 adoptStopGeneration이 첫 await 전에 올린다.
  // 그래서 저장이 끝나기 전(또는 실패한 뒤)에도 낮은 세대의 지시로 새 실행이 열리지 않는다.
  private durable: number | null;
  private fence: number | null;
  private readonly io: StoreIo;
  // 파일에 적힌 회복 요청. 쓰기·지우기가 파일에 닿은 뒤에만 바꾼다.
  private restart: RestartRequest | null = null;

  private constructor(
    private readonly dir: string,
    readonly storageId: string,
    stopGeneration: number | null,
    private readonly now: () => number,
    io: Partial<StoreIo>,
  ) {
    this.durable = stopGeneration;
    this.fence = stopGeneration;
    this.io = { writeDurable, createMarker, removeDurable, ...io };
  }

  // 최초 초기화(storage-id가 없음)와 기존 저장소 열기를 구분한다. 기존 저장소는 하위 폴더를 새로 만들지 않고,
  // 장부가 서로를 설명하는지 대조한다. 설명하지 못하면 열되 inconsistency()로 알리고, 그 판정은 ledger-hold로 다음 기동에도 남긴다.
  static async open(dir: string, options: StoreOptions = {}): Promise<ExecutorStore> {
    if (!isAbsolute(dir)) throw new StoreError("config_invalid");
    const io: StoreIo = { writeDurable, createMarker, removeDurable, ...options.io };
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
    const restartText = await readOptional(join(dir, RESTART_FILE));
    store.restart = restartText === null ? null : parseRestart(restartText);
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
        if (sub === "runs") store.unlisted = true;
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
      const owner = store.runMap.get(entry.run_id);
      if (owner?.run_generation === entry.run_generation) continue;
      note("run_missing");
      if (owner === undefined) store.unlisted = true;
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
    // 접수가 아닌 최초 기록은 감사가 뒤에서 뺀다. 여기서 세면 남은 파일만으로 장부 전체가 보류된다.
    if (store.overCapacity((run) => !store.unaccepted(run)) && !store.ledgerHeld()) store.inconsistent = "over_capacity";
    if (store.ledgerHeld()) for (const id of store.events.keys()) store.suspectEvents.add(id);
    // 첫 판정과 더 강한 사유로의 승격은 지속시킨 뒤에만 연다. 적지 못하면 진단 자료를 그대로 두고 열기를 실패시킨다.
    if (store.inconsistent !== null && store.inconsistent !== held) {
      try {
        await ExecutorStore.writeHold(dir, io, store.inconsistent);
      } catch {
        throw new StoreError("store_unavailable");
      }
    }
    store.holdOnDisk = store.inconsistent;
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
    return this.unlisted || (this.inconsistent !== null && WHOLE_LEDGER.includes(this.inconsistent));
  }

  // hello는 실행을 STATUS_MAX_RUNS개까지만 싣는다. 점유하거나 보류한 실행이 그보다 많은 장부는 v1의 인사로 다 말할 수 없다.
  private overCapacity(counted: (run: RunRecord) => boolean = () => true): boolean {
    return [...this.runMap.values()].filter((run) => counted(run) && (HOLDS_SLOT.includes(run.state) || this.suspectRuns.has(run.run_id))).length > limits.STATUS_MAX_RUNS;
  }

  // 사건도 마지막 영수증도 없는 preparing은 접수가 아니다(최초 쓰기의 재확인이 남긴 파일일 수도 있다). spawn은 접수 영수증이 지속된 뒤에만 나므로 끝낼 프로세스도 없다.
  private unaccepted(record: RunRecord): boolean {
    return record.state === "preparing" && record.last_receipt_id === null && !this.hasEvents(record.run_id);
  }

  // 메모리의 판정이 아직 파일에 없다. 파일 작업은 이 값이 거짓임을 본 동기 구간에서 시작한다(확인이 돌아오는 사이에도 판정이 설 수 있다).
  private holdDue(): boolean {
    return this.inconsistent !== this.holdOnDisk;
  }

  // 실행기가 outbox 본문의 계약 모양을 대조하고 맞지 않으면 알린다. 그 사건의 실행은 함께 보류하고, 판정은 다음 기동에도 남긴다.
  markInconsistent(reason: StoreInconsistency, eventId?: string): void {
    if (eventId !== undefined) {
      this.suspectEvents.add(eventId);
      const runId = this.events.get(eventId)?.entry.run_id;
      if (runId !== undefined) this.suspectRuns.add(runId);
    }
    if (this.inconsistent !== null) return;
    this.inconsistent = reason;
    void this.serial(() => this.persistHold());
  }

  // 판정을 파일에 남긴다. 적지 못하면 false이고, 부르는 쪽은 장부를 바꾸지 않는다(다음 flush가 다시 적어 본다).
  private async persistHold(): Promise<boolean> {
    const reason = this.inconsistent;
    if (reason === null || reason === this.holdOnDisk) return true;
    try {
      await ExecutorStore.writeHold(this.dir, this.io, reason);
    } catch {
      return false;
    }
    this.holdOnDisk = reason;
    return true;
  }

  // 실행마다 상태의 전제를 검증된 사건으로 대조해, 설명하지 못하는 실행을 보류한다. 실행기가 본문 대조를 마친 뒤 한 번 부른다.
  // 감사 뒤의 보류까지 세어 인사로 다 말할 수 없는 장부는 전체를 보류한다.
  auditRuns(): void {
    for (const record of [...this.runMap.values()]) {
      if (this.unaccepted(record)) {
        this.runMap.delete(record.run_id);
        this.durableRuns.delete(record.run_id);
        continue;
      }
      const reason = this.unexplained(record);
      if (reason !== null) this.holdRun(record.run_id, reason);
    }
    if (!this.overCapacity() || this.ledgerHeld()) return;
    this.inconsistent = "over_capacity";
    for (const id of this.events.keys()) this.suspectEvents.add(id);
    void this.serial(() => this.persistHold());
  }

  private hasEvents(runId: string): boolean {
    return [...this.events.values(), ...this.unsaved.values()].some((event) => event.entry.run_id === runId);
  }

  private holdRun(runId: string, reason: StoreInconsistency): void {
    this.suspectRuns.add(runId);
    this.markInconsistent(reason);
  }

  // 그 실행의 사건이 모두 검증됐고, 상태의 전제가 채워졌고, 마지막 영수증 포인터가 그 사건 가운데 하나를 가리키는지. 설명하지 못하면 그 사유다.
  private unexplained(record: RunRecord): StoreInconsistency | null {
    const own = [...this.events.values(), ...this.unsaved.values()].map((event) => event.entry).filter((entry) => entry.run_id === record.run_id);
    if (own.some((entry) => this.suspectEvents.has(entry.id) || entry.run_generation !== record.run_generation)) return "receipt_missing";
    const broken = this.premiseBroken(record);
    if (broken !== null) return broken;
    const last = record.last_receipt_id;
    return last === null || own.some((entry) => entry.id === last && RECEIPT_ACTIONS.includes(entry.action)) ? null : "receipt_missing";
  }

  // 후보 상태의 전제 검사. 기동 감사와 모든 전이(commit)가 이 함수 하나를 지난다.
  // 후보 상태가 전제한 사건이 같은 실행·세대의 유효한 사건(이번 전이에 함께 적을 사건 포함)으로 채워지고,
  // 새 사건과 정리 예약의 영수증 ID가 다른 사건의 것이 아니어야 한다. 정리 예약은 자기 요청의 정리 영수증만 그 ID를 가질 수 있다.
  private premiseBroken(candidate: RunRecord, incoming: readonly OutboxEntry[] = []): StoreInconsistency | null {
    const known = [...this.validEvents(candidate.run_id), ...incoming];
    if (!REQUIRED_EVENTS[candidate.state].every((action) => known.some((entry) => entry.action === action))) return "receipt_missing";
    if (incoming.some((entry) => this.events.has(entry.id) || this.unsaved.has(entry.id))) return "receipt_mismatch";
    const intent = candidate.cleanup;
    if (intent === undefined || intent === null) return null;
    const owner = (this.events.get(intent.receipt_id) ?? this.unsaved.get(intent.receipt_id))?.entry;
    if (owner === undefined) return null;
    const own = owner.action === "receipt_cleaned" && owner.run_id === candidate.run_id && owner.body.instruction_request_id === intent.request_id;
    return own ? null : "receipt_mismatch";
  }

  // 장부가 설명하지 못해 상태·사건·정리 승인을 함께 보류한 실행.
  suspectRun(runId: string): boolean {
    return this.suspectRuns.has(runId);
  }

  // 적지 못한 것이 남았거나 실패한 연산이 아직 회복되지 않았으면 false다. 적는 중인 사건은 장애가 아니다.
  healthy(): boolean {
    return this.faults.size === 0 && this.pendingRuns.size === 0 && this.inconsistent === this.holdOnDisk;
  }

  // nonce 기록이 로컬에서 실패한 순간 알린다(거절된 봉투의 내용은 넘기지 않는다).
  onNonceFault(listener: () => void): void {
    this.nonceFaultListener = listener;
  }

  // 적지 못한 사건과 실행 기록을 같은 순서로 다시 적고, 실패했던 연산을 실제로 다시 해 본다.
  // 새로 적은 사건을 순번 차례로 돌려준다(부르는 쪽이 받아서 보낸다).
  flush(): Promise<OutboxEntry[]> {
    return this.serial(async () => {
      if (!(await this.persistHold())) return [];
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
        // 실패한 그 경로에 그 내용을 다시 써 본다. 접수하지 않은 실행의 기록이 남지 않게 바로 지운다.
        // 지우기 전에 꺼져 파일이 남아도 사건이 없는 preparing이라 다음 기동의 감사가 접수로 치지 않는다(auditRuns).
        for (const [path, data] of this.failedBegins) {
          do {
            if (!(await this.persistHold())) return false;
          } while (this.holdDue());
          await this.io.writeDurable(path, data);
          // 다시 쓰는 사이 선 판정도 지우기 전에 지속한다.
          do {
            if (!(await this.persistHold())) return false;
          } while (this.holdDue());
          await rm(path, { force: true });
          this.failedBegins.delete(path);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  // ---- 회복 요청(D-104) ----

  restartRequest(): RestartRequest | null {
    return this.restart === null ? null : { marker: this.restart.marker, runs: [...this.restart.runs] };
  }

  // 줄(serial) 밖에서 바로 쓴다: 멈춘 상태 쓰기 뒤에 서면 원격이 잠긴 실행기가 요청을 적지 못하고 끝나지도 못한다.
  // 다른 파일의 쓰기와 겹쳐도 임시 이름이 달라 서로를 덮지 않는다. 적지 못하면 던진다.
  async writeRestartRequest(request: RestartRequest): Promise<void> {
    const text = JSON.stringify({ marker: request.marker, runs: [...request.runs] });
    // 다음 기동이 읽지 못할 꼴은 적지 않는다(읽기는 store_corrupt로 열기를 실패시킨다).
    const checked = parseRestart(text);
    await this.io.writeDurable(join(this.dir, RESTART_FILE), text);
    this.restart = checked;
  }

  // 지웠으면(이미 없었으면) 메모리도 비운다. 지우지 못하면 던진다.
  async clearRestartRequest(): Promise<void> {
    await this.io.removeDurable(join(this.dir, RESTART_FILE));
    this.restart = null;
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
      do {
        if (!(await this.persistHold())) return { saved: false, current: this.fence ?? generation };
      } while (this.holdDue());
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
      do {
        if (!(await this.persistHold())) return false;
      } while (this.holdDue());
      const path = join(this.dir, "runs", `${record.run_id}.json`);
      const data = JSON.stringify(record);
      try {
        await this.io.writeDurable(path, data);
      } catch {
        this.failedBegins.set(path, data);
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
  // 후보 상태의 전제가 깨지면 아무것도 바꾸지 않고 그 실행을 보류한다. 판정은 부르는 즉시(첫 await 전) 난다.
  commit(runId: string, patch: Partial<RunRecord>, events: readonly NewEvent[] = []): Promise<Committed> {
    const current = this.runMap.get(runId);
    const broken =
      current === undefined
        ? null
        : this.premiseBroken(
            { ...current, ...patch },
            events.map((event) => event.entry),
          );
    if (broken !== null) {
      this.holdRun(runId, broken);
      return Promise.resolve({ saved: false, written: [] });
    }
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
        // 파일을 하나 쓸 때마다 앞에서 본다. 쓰는 사이 세운 보류 판정은 다음 파일보다 먼저 지속한다.
        do {
          if (!(await this.persistHold())) {
            this.pendingRuns.add(runId);
            return { saved: false, written };
          }
        } while (this.holdDue());
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

  // 실행 하나의 유효한 사건(순번 차례): 보류하지 않은 실행의, 같은 세대의, 본문까지 검증된 사건이다. 쓰는 중인 사건도 들어 있다
  // (같은 사실의 영수증을 새로 만들지 않으려고 대조한다). 복원, 재계수 뒤의 중복 검사, 재전송, 정리 승인이 모두 이 목록만 읽는다.
  validEvents(runId: string): OutboxEntry[] {
    const generation = this.runMap.get(runId)?.run_generation;
    if (generation === undefined || this.suspectRuns.has(runId)) return [];
    return [...this.events.values(), ...this.unsaved.values()]
      .filter((event) => event.entry.run_id === runId && event.entry.run_generation === generation && !this.suspectEvents.has(event.entry.id))
      .sort((a, b) => a.seq - b.seq)
      .map((event) => structuredClone(event.entry));
  }

  // 아래 셋은 걸러 내지 않은 원본이다. 저장소의 대조와 시험만 쓴다(실행기의 판단은 validEvents로 한다).
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

  // 보내도 되는 사건: 파일에 적혔고 장부가 설명하는 것. 보류한 실행의 사건은 보내지 않는다.
  sendable(id: string): boolean {
    const event = this.events.get(id);
    return event !== undefined && !this.suspectEvents.has(id) && !this.suspectRuns.has(event.entry.run_id);
  }

  // 다시 보낼 것: 보내도 되는 사건 가운데 받음 확인이 없는 것(순번 차례).
  unacked(): OutboxEntry[] {
    return this.outboxAll().filter((entry) => !entry.acked && this.sendable(entry.id));
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
        do {
          if (!(await this.persistHold())) return false;
        } while (this.holdDue());
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
