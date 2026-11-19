// 감독 쪽 결과 보관소의 판단(D-78). 작업자 결과의 본문을 장부 밖에 맡아 두고, 장부에는 이 모듈이 낸 참조와 digest만 적게 한다.
// 바이트를 실제로 두는 곳은 주입받는 백엔드 포트이고, 이 모듈은 무엇을 언제 받아들이고 누구에게 내주는지만 정한다.
//
// 상태를 갖지 않는다. 백엔드가 유일한 상태이고, 시각은 인자로 받는다.
// 틀리는 방향은 늘 닫는 쪽이다.
// - 백엔드가 "넣었다"고 답하기 전에는 참조를 내지 않는다. 모름은 참조 없는 unknown이다(부르는 쪽은 ACK하지 않는다).
// - 본문은 읽기의 성공 답에만 있다. 거절·오류·목록에는 싣지 않는다.
// - 남의 참조와 없는 참조는 같은 답(absent)이다. 소유자가 맞은 뒤에만 판정 포트를 부른다.
// - 포트가 던지거나 정한 꼴 밖의 값을 내면 모름이다. 빈 성공이나 "없음"으로 바꾸지 않는다.
//
// 포트가 동기인 이유: 도구 처리기(tools.ts)의 readResult 포트와 장부가 동기라 같은 흐름에 그대로 끼운다. 또 보관과 장부 기록을
// await 없이 한 흐름에서 하면, 같은 프로세스의 고아 정리(sweepStored)가 그 사이에 끼어 아직 장부에 적히는 중인 본문을 지울 수 없다.
import { createHash } from "node:crypto";
import { canonicalJson, limits, type Result } from "../../contract/v1/index.ts";
import type { Answer } from "./tools.ts";

// ---- 포트 ----

// 키는 이 모듈만 만든다(`result/<UUID>`). 바깥의 경로나 이름이 백엔드에 닿지 않는다.
// 백엔드의 약속:
// - putNew는 원자적이다. 키가 없으면 바이트 전체를 넣고 stored, 있으면 아무것도 바꾸지 않고 exists. 읽는 쪽은 반쯤 넣은 값을 보지 않는다.
// - read는 값 전체, readRange는 [offset, offset + length)를 값의 끝에서 자른 바이트다(끝을 넘으면 짧거나 비어 있다).
// - remove는 키를 지운다. 없으면 absent. keys는 그 접두로 시작하는 지금의 키 전부다.
// - 장애·모름은 unknown이다. 던져도 이 모듈이 unknown으로 옮긴다.
export type BackendRead = { readonly status: "ok"; readonly bytes: Uint8Array } | { readonly status: "absent" } | { readonly status: "unknown" };

export interface ResultBackend {
  putNew(key: string, bytes: Uint8Array): { readonly status: "stored" } | { readonly status: "exists" } | { readonly status: "unknown" };
  read(key: string): BackendRead;
  readRange(key: string, offset: number, length: number): BackendRead;
  remove(key: string): { readonly status: "removed" } | { readonly status: "absent" } | { readonly status: "unknown" };
  has(key: string): { readonly status: "present" } | { readonly status: "absent" } | { readonly status: "unknown" };
  keys(prefix: string): { readonly status: "ok"; readonly keys: readonly string[] } | { readonly status: "unknown" };
}

// 판정 포트가 받는 것. 본문·digest·소유자는 넘기지 않는다.
export interface StoredEntry {
  readonly ref: string;
  readonly runId: string;
  readonly storedAt: number;
}

// 지금 이 결과를 내줘도 되는가(만료, 잊기, 정리 대기). 규칙과 그 시계(D-22·O18)는 부르는 쪽이 정한다. 이 모듈은 답만 따른다.
export interface ReadGate {
  readable(entry: StoredEntry): Answer<boolean>;
}

// 이 digest가 현관에 후보로 낸 내용이면 그 내용을 보관한 결과의 참조, 아니면 null(D-80). 이 모듈은 그 자리의 digest를 다시 대조한다.
export interface CandidateGate {
  candidate(digest: string): Answer<{ readonly ref: string } | null>;
}

// ---- 답 ----

export type StoreAnswer =
  // created: false는 같은 실행·같은 digest·같은 소유자가 이미 보관돼 있던 것이다(중단 뒤 재보관).
  | { readonly status: "stored"; readonly ref: string; readonly created: boolean }
  // 같은 실행에 다른 digest나 다른 소유자가 이미 있다. 앞의 것은 그대로다.
  | { readonly status: "conflict" }
  | { readonly status: "rejected"; readonly reason: "invalid_input" | "too_large" | "digest_mismatch" }
  | { readonly status: "unknown" };

export type ReadAnswer =
  | { readonly status: "ok"; readonly digest: string; readonly total: number; readonly offset: number; readonly bytes: Uint8Array }
  // 없음, 남의 것, 지운 것, 그 digest의 내용이 아닌 것.
  | { readonly status: "absent" }
  // 판정 포트가 막았다(만료·잊기·정리 대기).
  | { readonly status: "closed" }
  | { readonly status: "corrupt" }
  | { readonly status: "invalid" }
  | { readonly status: "unknown" };

export type CandidateAnswer =
  | { readonly status: "ok"; readonly total: number; readonly offset: number; readonly bytes: Uint8Array }
  // 후보가 아님, 없음, 지금 내줄 수 없음. 장애가 아니라 답할 수 없다는 확정이다.
  | { readonly status: "unavailable" }
  | { readonly status: "corrupt" }
  | { readonly status: "invalid" }
  | { readonly status: "unknown" };

export type ListedEntry =
  | { readonly ref: string; readonly state: "stored"; readonly runId: string; readonly storedAt: number }
  // 머리를 해석할 수 없는 기록.
  | { readonly ref: string; readonly state: "damaged" }
  // 머리를 읽지 못했다(장애).
  | { readonly ref: string; readonly state: "unknown" };

export type ListAnswer = { readonly status: "ok"; readonly entries: readonly ListedEntry[] } | { readonly status: "unknown" };
export type DeleteAnswer = { readonly status: "deleted" } | { readonly status: "absent" } | { readonly status: "invalid" } | { readonly status: "unknown" };
export type SweepAnswer =
  // deleted: 지웠고 없음을 확인했다. failed: 지우려 했으나 없음을 확인하지 못했다.
  // unverified: 보관 시각을 확인하지 못해(머리를 못 읽음·덜 읽힘·꼴이 틀림) 지우지 않고 남겼다. 정리된 것이 아니라 사람이 볼 것이다.
  | { readonly status: "ok"; readonly deleted: readonly string[]; readonly failed: readonly string[]; readonly unverified: readonly string[] }
  | { readonly status: "invalid" }
  | { readonly status: "unknown" };

// ---- 꼴 ----

// 실행 ID·소유자(논리 요청 ID)는 장부의 UUID, digest는 계약 v1의 sha256 꼴이다.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// 참조는 장부 storedRef의 꼴(<저장소 이름>/<UUID>)이고 저장소 이름은 results다. 백엔드 키는 참조와 다른 접두를 쓴다.
const REF = /^results\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const KEY_PREFIX = "result/";
const KEY = /^result\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const HEAD_LENGTH_BYTES = 4;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);
const isCount = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sha256Text = (text: string) => sha256(new TextEncoder().encode(text));

// 결과의 본문 바이트: 계약 v1 정규 직렬화의 UTF-8. 이 바이트의 SHA-256이 계약의 resultDigest(장부 resultDigest)와 같다.
export function resultBody(result: Result): Uint8Array {
  return new TextEncoder().encode(canonicalJson(result));
}

// 실행 하나의 자리. 실행 ID의 SHA-256 앞 128비트를 UUIDv8 꼴로 쓴다.
// - 같은 실행을 다시 보관하면 색인 없이 같은 자리를 찾고, 덮어쓰지 않는 넣기 한 번으로 "한 벌"과 "충돌"이 갈린다.
// - 실행 ID를 아는 쪽은 참조를 계산할 수 있다(예측 가능). 실행 ID는 장부와 봉투에 있는 비밀이 아닌 값이고, 읽기는 소유자와
//   판정 포트를 다시 보므로 참조만으로는 읽히지 않는다. 난수 참조는 재보관 때 같은 참조를 찾을 색인이 따로 있어야 한다.
// - 참조에는 본문·digest·소유자가 들어가지 않는다. 자리의 내용은 지우기 전까지 바뀌지 않고, 읽기는 장부의 digest를 함께 받아 대조한다.
function slotOf(runId: string): string {
  const hex = sha256Text(`olive/result-store/v1/slot\u0000${runId}`).slice(0, 32);
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const refOf = (slot: string) => `results/${slot}`;
const keyOf = (slot: string) => `${KEY_PREFIX}${slot}`;
// 소유자는 원래 값 대신 이 값으로 둔다. 백엔드 사본만으로 어느 요청의 결과인지 바로 읽히지 않게 한다.
const ownerTagOf = (owner: string) => sha256Text(`olive/result-store/v1/owner\u0000${owner}`);

// ---- 기록의 바이트 ----

// [머리 길이 4바이트(빅엔디언)][머리: 정규 JSON][본문]. 목록은 머리 길이 필드만큼만 조각으로 읽는다.
// 길이 필드가 맞으면 본문에 닿지 않는다. 길이 필드가 손상돼 크면 내부 읽기가 본문 앞부분까지 받을 수 있다.
// 어느 쪽이든 목록의 답에는 참조·상태와, 머리를 해석한 기록의 실행·보관 시각만 싣는다.
interface Head {
  readonly v: 1;
  readonly run: string;
  readonly owner: string;
  readonly digest: string;
  readonly storedAt: number;
  readonly size: number;
}
const HEAD_KEYS = ["digest", "owner", "run", "size", "storedAt", "v"];

function encodeRecord(head: Head, body: Uint8Array): Uint8Array {
  const headBytes = new TextEncoder().encode(canonicalJson(head));
  const out = new Uint8Array(HEAD_LENGTH_BYTES + headBytes.length + body.length);
  new DataView(out.buffer).setUint32(0, headBytes.length);
  out.set(headBytes, HEAD_LENGTH_BYTES);
  out.set(body, HEAD_LENGTH_BYTES + headBytes.length);
  return out;
}

function headLength(bytes: Uint8Array): number | null {
  if (bytes.length < HEAD_LENGTH_BYTES) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, HEAD_LENGTH_BYTES).getUint32(0);
}

function parseHead(bytes: Uint8Array): Head | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!isPlainObject(value) || Object.keys(value).length !== HEAD_KEYS.length || !hasOnly(value, HEAD_KEYS)) return null;
  if (value.v !== 1 || !matches(value.run, UUID) || !matches(value.owner, SHA256) || !matches(value.digest, SHA256)) return null;
  if (!isCount(value.storedAt, 0) || !isCount(value.size, 1) || (value.size as number) > limits.RESULT_MAX_BYTES) return null;
  return value as unknown as Head;
}

interface StoredRecord {
  readonly head: Head;
  readonly body: Uint8Array;
}

// 머리와 그 뒤의 바이트를 가른다. 본문의 길이는 보지 않는다(소유자를 먼저 확인해야 하는 읽기가 쓴다).
function splitRecord(bytes: Uint8Array): StoredRecord | null {
  const length = headLength(bytes);
  if (length === null || HEAD_LENGTH_BYTES + length > bytes.length) return null;
  const head = parseHead(bytes.subarray(HEAD_LENGTH_BYTES, HEAD_LENGTH_BYTES + length));
  if (head === null) return null;
  return { head, body: bytes.subarray(HEAD_LENGTH_BYTES + length) };
}

// 머리와 본문을 가른다. 본문의 길이가 머리와 다르면 null(잘린 기록).
function decodeRecord(bytes: Uint8Array): StoredRecord | null {
  const record = splitRecord(bytes);
  return record !== null && record.body.length === record.head.size ? record : null;
}

// 본문이 머리의 길이와 digest 그대로인가(잘림·바뀜).
const intactBody = (record: StoredRecord) => record.body.length === record.head.size && sha256(record.body) === record.head.digest;

const sameHead = (a: Head, b: Head) =>
  a.v === b.v && a.run === b.run && a.owner === b.owner && a.digest === b.digest && a.storedAt === b.storedAt && a.size === b.size;

// ---- 포트 호출 ----

// 던지거나 정한 꼴 밖이면 unknown이다.
function backendRead(call: () => unknown): BackendRead {
  try {
    const answer = call();
    if (isPlainObject(answer)) {
      if (answer.status === "ok" && answer.bytes instanceof Uint8Array) return { status: "ok", bytes: answer.bytes };
      if (answer.status === "absent") return { status: "absent" };
    }
  } catch {
    // 아래의 unknown으로 옮긴다.
  }
  return { status: "unknown" };
}

function backendStatus<S extends string>(call: () => unknown, allowed: readonly S[]): S | "unknown" {
  try {
    const answer = call();
    if (isPlainObject(answer) && (allowed as readonly unknown[]).includes(answer.status)) return answer.status as S;
  } catch {
    // 아래의 unknown으로 옮긴다.
  }
  return "unknown";
}

function askReadable(gate: ReadGate, entry: StoredEntry): boolean | "unknown" {
  try {
    const answer: unknown = gate.readable(entry);
    if (isPlainObject(answer) && answer.known === true && typeof answer.value === "boolean") return answer.value;
  } catch {
    // 아래의 unknown으로 옮긴다.
  }
  return "unknown";
}

function askCandidate(gate: CandidateGate, digest: string): string | null | "unknown" {
  try {
    const answer: unknown = gate.candidate(digest);
    if (!isPlainObject(answer) || answer.known !== true || !Object.hasOwn(answer, "value")) return "unknown";
    if (answer.value === null) return null;
    if (isPlainObject(answer.value) && matches(answer.value.ref, REF)) return answer.value.ref;
  } catch {
    // 아래의 unknown으로 옮긴다.
  }
  return "unknown";
}

const entryOf = (slot: string, head: Head): StoredEntry => ({ ref: refOf(slot), runId: head.run, storedAt: head.storedAt });

// 조각: 위치가 본문 안이어야 하고, 길이는 끝에서 자른다. 돌려주는 바이트는 그 길이만 한 새 메모리의 사본이다.
// 백엔드가 Buffer를 내줄 수 있는데, Buffer의 slice는 사본이 아니라 같은 메모리의 창이라 쓰지 않는다.
function slice(body: Uint8Array, offset: number, length: number): Uint8Array | null {
  if (offset >= body.length) return null;
  const end = Math.min(body.length, offset + length);
  const out = new Uint8Array(end - offset);
  out.set(body.subarray(offset, end));
  return out;
}

// ---- 보관 ----

export interface StoreInput {
  readonly runId: string;
  // 이 결과를 낸 실행의 소유자(논리 요청 ID).
  readonly owner: string;
  readonly digest: string;
  readonly body: Uint8Array;
  readonly now: number;
}

// 본문을 보관하고 참조를 낸다. stored가 아니면 부르는 쪽은 장부에 적지 않고 ACK하지 않는다.
export function storeResult(backend: ResultBackend, input: StoreInput): StoreAnswer {
  if (!isPlainObject(input) || !hasOnly(input, ["runId", "owner", "digest", "body", "now"])) return { status: "rejected", reason: "invalid_input" };
  const { runId, owner, digest, body: given, now } = input;
  if (!matches(runId, UUID) || !matches(owner, UUID) || !matches(digest, SHA256) || !isCount(now, 0)) return { status: "rejected", reason: "invalid_input" };
  if (!(given instanceof Uint8Array) || given.length === 0) return { status: "rejected", reason: "invalid_input" };
  if (given.length > limits.RESULT_MAX_BYTES) return { status: "rejected", reason: "too_large" };
  // 사본에서 digest를 다시 계산하고, 넣는 것도 그 사본이다.
  const body = given.slice();
  if (sha256(body) !== digest) return { status: "rejected", reason: "digest_mismatch" };

  const slot = slotOf(runId);
  const key = keyOf(slot);
  const head: Head = { v: 1, run: runId, owner: ownerTagOf(owner), digest, storedAt: now, size: body.length };
  const put = backendStatus(() => backend.putNew(key, encodeRecord(head, body)), ["stored", "exists"] as const);
  if (put === "unknown") return { status: "unknown" };

  // 넣었다·이미 있다는 답만으로는 참조를 내지 않는다. 같은 자리를 다시 읽어 온전한 기록이 보일 때만 낸다.
  const check = backendRead(() => backend.read(key));
  const record = check.status === "ok" ? decodeRecord(check.bytes) : null;
  if (put === "stored") {
    // 방금 넣은 그대로(머리 전부와 본문)여야 한다. 아니면 참조 없는 unknown이고, 넣은 것을 지워 본다.
    // 지우기의 답은 이 답을 바꾸지 않는다. 남은 기록은 같은 실행의 재보관에서 unknown으로 걸리고, 머리가 온전하면 고아 정리가 기한 뒤 지운다.
    if (record !== null && sameHead(record.head, head) && sha256(record.body) === digest) return { status: "stored", ref: refOf(slot), created: true };
    backendStatus(() => backend.remove(key), ["removed", "absent"] as const);
    return { status: "unknown" };
  }

  // 이미 있는 자리: 그 기록이 온전하고 같은 내용이어야 같은 참조로 답한다. 손상된 자리는 "보관됨"을 입증하지 못한다.
  // 앞선 보관이 낸 참조가 장부에 적혔을 수 있는 자리라 여기서는 지우지 않는다.
  if (record === null || record.head.run !== runId || sha256(record.body) !== record.head.digest) return { status: "unknown" };
  if (record.head.digest !== digest || record.head.owner !== head.owner) return { status: "conflict" };
  return { status: "stored", ref: refOf(slot), created: false };
}

// ---- 읽기 ----

export interface ReadInput {
  readonly ref: string;
  // 부르는 쪽의 인증된 문맥에서 온 소유자. 보관 때의 소유자와 같아야 한다.
  readonly owner: string;
  // 장부가 이 참조와 함께 적은 결과 digest. 자리의 내용이 이 digest일 때만 내준다.
  readonly digest: string;
  readonly range?: { readonly offset: number; readonly length: number };
}

// 순서: 꼴 → 기록 → 소유자 → 자리·digest → 판정 포트 → 본문 대조 → 조각.
export function readStored(ports: { readonly backend: ResultBackend; readonly gate: ReadGate }, input: ReadInput): ReadAnswer {
  if (!isPlainObject(input) || !hasOnly(input, ["ref", "owner", "digest", "range"])) return { status: "invalid" };
  const ref = matches(input.ref, REF) ? REF.exec(input.ref) : null;
  if (ref === null || !matches(input.owner, UUID) || !matches(input.digest, SHA256)) return { status: "invalid" };
  const range = input.range;
  if (range !== undefined && (!isPlainObject(range) || !hasOnly(range, ["offset", "length"]) || !isCount(range.offset, 0) || !isCount(range.length, 1))) {
    return { status: "invalid" };
  }
  const slot = ref[1] as string;

  const got = backendRead(() => ports.backend.read(keyOf(slot)));
  if (got.status !== "ok") return got;
  // 소유자를 먼저 본다. 머리를 해석하지 못해 소유자를 확인할 수 없는 기록은 남의 참조·없는 참조와 같은 absent다.
  // corrupt는 소유자가 확인된 뒤에만 답한다. 그 전에 답하면 그 자리에 기록이 있음이 드러난다. 손상의 진단은 listStored(damaged)가 맡는다.
  const record = splitRecord(got.bytes);
  if (record === null || record.head.owner !== ownerTagOf(input.owner)) return { status: "absent" };
  if (slotOf(record.head.run) !== slot) return { status: "corrupt" };
  if (record.head.digest !== input.digest) return { status: "absent" };

  const readable = askReadable(ports.gate, entryOf(slot, record.head));
  if (readable === "unknown") return { status: "unknown" };
  if (!readable) return { status: "closed" };
  if (!intactBody(record)) return { status: "corrupt" };

  const offset = range?.offset ?? 0;
  const bytes = slice(record.body, offset, range?.length ?? record.body.length);
  if (bytes === null) return { status: "invalid" };
  return { status: "ok", digest: record.head.digest, total: record.body.length, offset, bytes };
}

// ---- digest로 읽기(현관 후보, D-80) ----

export interface CandidateInput {
  readonly digest: string;
  readonly offset: number;
  readonly length: number;
  // 조각과 후보 내용 전체의 상한. 숫자는 부르는 쪽(현관 계약)이 정한다.
  readonly maxChunkBytes: number;
  readonly maxContentBytes: number;
}

// 후보 판정이 허락한 digest만 읽는다. 소유자는 보지 않는다(현관은 소유자가 아니다). 대신 판정 포트 둘이 모두 허락해야 한다.
export function readCandidate(
  ports: { readonly backend: ResultBackend; readonly gate: ReadGate; readonly candidates: CandidateGate },
  input: CandidateInput,
): CandidateAnswer {
  if (!isPlainObject(input) || !hasOnly(input, ["digest", "offset", "length", "maxChunkBytes", "maxContentBytes"])) return { status: "invalid" };
  const { digest, offset, length, maxChunkBytes, maxContentBytes } = input;
  if (!matches(digest, SHA256) || !isCount(maxChunkBytes, 1) || !isCount(maxContentBytes, 1) || maxChunkBytes > maxContentBytes) return { status: "invalid" };
  if (!isCount(offset, 0) || offset >= maxContentBytes || !isCount(length, 1) || length > maxChunkBytes) return { status: "invalid" };

  const candidate = askCandidate(ports.candidates, digest);
  if (candidate === "unknown") return { status: "unknown" };
  if (candidate === null) return { status: "unavailable" };
  const slot = (REF.exec(candidate) as RegExpExecArray)[1] as string;

  const got = backendRead(() => ports.backend.read(keyOf(slot)));
  if (got.status === "absent") return { status: "unavailable" };
  if (got.status !== "ok") return { status: "unknown" };
  const record = decodeRecord(got.bytes);
  if (record === null || slotOf(record.head.run) !== slot) return { status: "corrupt" };
  // 판정 포트가 다른 내용의 자리를 가리켰다. 그 바이트를 내주지 않는다.
  if (record.head.digest !== digest) return { status: "unknown" };

  const readable = askReadable(ports.gate, entryOf(slot, record.head));
  if (readable === "unknown") return { status: "unknown" };
  if (!readable) return { status: "unavailable" };
  if (sha256(record.body) !== digest) return { status: "corrupt" };
  if (record.body.length > maxContentBytes) return { status: "unavailable" };

  const bytes = slice(record.body, offset, length);
  if (bytes === null) return { status: "invalid" };
  return { status: "ok", total: record.body.length, offset, bytes };
}

// ---- 지우기와 정리 ----

// 잊기·만료의 집행. 지운 뒤 다시 물어 없음을 확인해야 deleted다.
export function deleteStored(backend: ResultBackend, ref: string): DeleteAnswer {
  const match = matches(ref, REF) ? REF.exec(ref) : null;
  if (match === null) return { status: "invalid" };
  return removeSlot(backend, match[1] as string);
}

function removeSlot(backend: ResultBackend, slot: string): DeleteAnswer {
  const key = keyOf(slot);
  const removed = backendStatus(() => backend.remove(key), ["removed", "absent"] as const);
  if (removed === "unknown") return { status: "unknown" };
  const left = backendStatus(() => backend.has(key), ["present", "absent"] as const);
  if (left !== "absent") return { status: "unknown" };
  return removed === "removed" ? { status: "deleted" } : { status: "absent" };
}

// 보관한 것의 목록. 참조·실행·보관 시각만 싣는다(본문·digest·소유자 없음). 이 모듈의 키 꼴이 아닌 키는 건너뛴다.
export function listStored(backend: ResultBackend): ListAnswer {
  let keys: unknown;
  try {
    const answer: unknown = backend.keys(KEY_PREFIX);
    if (!isPlainObject(answer) || answer.status !== "ok" || !Array.isArray(answer.keys)) return { status: "unknown" };
    keys = answer.keys;
  } catch {
    return { status: "unknown" };
  }
  const entries: ListedEntry[] = [];
  for (const key of keys as unknown[]) {
    const match = matches(key, KEY) ? KEY.exec(key) : null;
    if (match === null) continue;
    const slot = match[1] as string;
    const entry = listedEntry(backend, key as string, slot);
    if (entry !== null) entries.push(entry);
  }
  return { status: "ok", entries };
}

function listedEntry(backend: ResultBackend, key: string, slot: string): ListedEntry | null {
  const ref = refOf(slot);
  const prefix = backendRead(() => backend.readRange(key, 0, HEAD_LENGTH_BYTES));
  if (prefix.status === "absent") return null;
  if (prefix.status !== "ok") return { ref, state: "unknown" };
  const length = headLength(prefix.bytes);
  if (length === null || prefix.bytes.length !== HEAD_LENGTH_BYTES) return { ref, state: "damaged" };
  const headBytes = backendRead(() => backend.readRange(key, HEAD_LENGTH_BYTES, length));
  if (headBytes.status === "absent") return null;
  if (headBytes.status !== "ok") return { ref, state: "unknown" };
  const head = headBytes.bytes.length === length ? parseHead(headBytes.bytes) : null;
  if (head === null || slotOf(head.run) !== slot) return { ref, state: "damaged" };
  return { ref, state: "stored", runId: head.run, storedAt: head.storedAt };
}

export interface SweepInput {
  // 장부에 적힌 결과 참조 전부. 이 안의 것은 나이와 상관없이 지우지 않는다.
  readonly keep: readonly string[];
  // 이 시각보다 먼저 보관된 것만 지운다. 기한의 길이는 부르는 쪽이 정한다.
  readonly before: number;
}

// 장부에 없고 보관 시각이 기한보다 앞선 것으로 확인된 기록(보관 뒤 장부에 적히지 못한 고아)만 지운다.
// 머리를 읽지 못했거나 덜 읽혔거나 꼴이 틀려 보관 시각을 모르는 기록은 유예 안의 본문일 수 있으므로 지우지 않고 unverified에 남긴다.
// 목록을 못 읽으면 아무것도 지우지 않는다.
export function sweepStored(backend: ResultBackend, input: SweepInput): SweepAnswer {
  if (!isPlainObject(input) || !hasOnly(input, ["keep", "before"]) || !Array.isArray(input.keep) || !isCount(input.before, 0)) return { status: "invalid" };
  if (!input.keep.every((ref) => matches(ref, REF))) return { status: "invalid" };
  const keep = new Set<string>(input.keep);
  const listed = listStored(backend);
  if (listed.status !== "ok") return { status: "unknown" };
  const deleted: string[] = [];
  const failed: string[] = [];
  const unverified: string[] = [];
  for (const entry of listed.entries) {
    if (keep.has(entry.ref)) continue;
    if (entry.state !== "stored") {
      unverified.push(entry.ref);
      continue;
    }
    if (entry.storedAt >= input.before) continue;
    const removed = removeSlot(backend, (REF.exec(entry.ref) as RegExpExecArray)[1] as string);
    if (removed.status === "deleted" || removed.status === "absent") deleted.push(entry.ref);
    else failed.push(entry.ref);
  }
  return { status: "ok", deleted, failed, unverified };
}
