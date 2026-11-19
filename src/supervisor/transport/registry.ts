// 감독이 실행기의 서명 공개 키를 믿는 근거인 등록표(허용 명단, D-63)를 해석·검증하고, 판을 바꿀지 판단하고,
// 연결마다 "이 배포 대상의 이 주체가 쓴 서명을 어느 키로 확인하는가"에 답하는 순수 판단이다.
// 파일을 읽거나 바뀐 것을 알아채는 일, 연결을 끊는 일은 부르는 쪽(연결·진입점)의 일이다. 입출력·시계·난수·환경을 쓰지 않는다.
//
// 지금 믿는 판은 RegistryState 한 값이고 부르는 쪽이 쥔다. 적용은 새 값을 돌려주고 옛 값을 바꾸지 않는다.
// 명단을 채우는 길은 RegistryState.apply 하나다. hello·맞춤·인증서 지문·봉투의 어떤 칸도 행을 만들지 않는다.
//
// 닫는 쪽으로 정한 규칙(D-63 "키가 새면 감독이 새 명단을 적용할 때까지 정지"):
// - 문서 하나가 통째로 판 하나다. 한 줄이라도 틀리면 문서 전체를 거절하고 행을 골라 받지 않는다.
// - 적용에 실패하면 지금 믿던 판도 버리고 아무도 믿지 않는다(새 권한 0). 예외는 지금 판과 판 번호·내용이 같은 문서 하나다.
// - 닫힌 뒤 다시 여는 것은 마지막으로 적용한 판보다 큰 판뿐이다. 그래서 폐기 전 사본(같거나 낮은 판)이 돌아와도 열리지 않는다.
//
// [후보] 문서의 꼴과 칸 이름은 PR에서 검토하는 후보다(D-70이 정하지 않았다). 직렬화는 JSON 한 문서다:
//   {
//     "environment": "<클러스터 이름>",
//     "revision": <판 번호, 1 이상의 안전 정수를 소수점·지수 없이 쓴 숫자>,
//     "executors": [
//       { "target": "<배포 대상 id>", "role": "<계약 v1 작업자 역할>", "instance": "<인스턴스 ID>",
//         "storage": "<실제 저장소 ID>", "public_key": "<Ed25519 32바이트의 base64url>", "active": true }
//     ]
//   }
import { createHash, type KeyObject } from "node:crypto";
import { digestOf, limits, parsePrincipal, publicKeyFromRaw, type Role, ROLES } from "../../contract/v1/index.ts";
import { createFrameDecoder, encodeFrame, type FrameRejectReason } from "../../transport/framing.ts";
import type { CertifiedExecutorConnection } from "./tls-server.ts";

// [후보] 칸 이름.
export const REGISTRY_FIELDS = ["environment", "revision", "executors"] as const;
export const ROW_FIELDS = ["target", "role", "instance", "storage", "public_key", "active"] as const;

// 문서 바이트의 상한. 미확정 기본: 계약 v1 봉투의 바이트 틀 상한(64 KiB)과 같은 값이다. 해석 전에 자르는 같은 뜻의 경계이고,
// 같은 엄격한 해석기(바이트 틀의 디코더)를 쓰므로 이보다 크게 둘 수 없다. 설정은 이보다 작게만 바꾼다.
export const DEFAULT_MAX_BYTES = limits.MAX_MESSAGE_BYTES;

// 이 연결의 TLS 판정이 확인한 실행기 배포 신원(tls-server.ts가 위로 넘기는 것). 등록된 실행기라는 뜻이 아니다.
export type ExecutorPeer = CertifiedExecutorConnection["executor"];

// 배포가 주입하는 대상 표 한 줄(D-64의 "대상 목록 한 곳"). roles/assign.ts의 TargetAllowance에 namespace를 더한 꼴이라
// 같은 배열을 두 판단에 넘길 수 있다. 이 저장소에 운영 표를 두지 않는다.
export interface RegistryTarget {
  readonly target: string;
  // 그 대상의 네임스페이스. TLS 신원의 네임스페이스와 정확히 같아야 그 연결의 행을 찾는다.
  readonly namespace: string;
  // 그 대상이 맡을 수 있는 계약 역할. 비어 있으면 그 대상에는 어떤 행도 등록할 수 없다.
  readonly roles: readonly Role[];
}

export interface RegistrySettings {
  // 이 감독이 도는 클러스터. 문서의 environment가 이 값과 정확히 같아야 한다.
  readonly environment: string;
  readonly targets: readonly RegistryTarget[];
  // 미확정 기본 DEFAULT_MAX_BYTES. 1 이상 DEFAULT_MAX_BYTES 이하만 받는다.
  readonly maxBytes?: number;
  // 미확정 기본: 행 수의 따로 정한 상한이 없다(설계에 숫자가 없다). 문서 바이트 상한이 행 수를 묶는다. 0 이상의 정수만 받는다.
  readonly maxRows?: number;
}

// 부르는 쪽이 읽은 것. 읽지 못했으면(파일 없음, 권한, 입출력 오류) unreadable을 넘긴다. 그것도 적용 실패로 센다.
export type RegistryInput = { readonly kind: "content"; readonly content: Uint8Array | string } | { readonly kind: "unreadable" };

export const REGISTRY_REJECT_REASONS = [
  // 부르는 쪽이 읽지 못했다.
  "unreadable",
  // 주입한 설정(환경 이름, 대상 표, 상한)이 틀렸다. 문서를 볼 수 없다.
  "bad_settings",
  "too_large",
  // 깨진 UTF-8, 짝 없는 서로게이트가 든 문자열.
  "not_utf8",
  // 빈 문서, BOM, JSON 문법 오류, 깊이 초과.
  "not_json",
  // 한 객체에 같은 칸 이름이 두 번 있다.
  "duplicate_member",
  "unknown_field",
  "missing_field",
  // 칸의 타입·꼴이 틀렸다(인스턴스·저장소 ID는 계약 v1 주체 이름의 문법, 판 번호는 원문이 정수의 십진 표기 그대로).
  "bad_field",
  // Ed25519 공개 키로 쓸 수 없다(32바이트의 정규 base64url 43자가 아니거나, 그 32바이트가 주 부분군의 점이 아니다).
  "bad_public_key",
  "too_many_rows",
  "wrong_environment",
  // 계약 v1 작업자 역할이 아니다(session 포함).
  "unknown_role",
  // 주입한 대상 표에 없는 배포 대상이다.
  "unknown_target",
  // 대상 표가 그 대상에 허용하지 않은 역할이다(D-64).
  "role_not_allowed",
  // 같은 주체(역할·인스턴스·저장소)가 두 행에 있거나, 같은 인스턴스가 활성 두 행에 있다.
  "duplicate_identity",
  // 같은 키가 같은 대상·역할의 두 행에 있다.
  "duplicate_key",
  // 같은 키가 다른 역할이나 다른 대상의 행에 있다.
  "key_in_two_roles",
  // 판 번호가 마지막으로 적용한 판보다 크지 않다.
  "not_newer",
  // 마지막으로 적용한 판과 판 번호는 같고 내용이 다르다.
  "revision_conflict",
] as const;
export type RegistryRejectReason = (typeof REGISTRY_REJECT_REASONS)[number];

// 키 확인의 답. keyId는 공개 키 32바이트의 SHA-256(base64url)이고 키 값이 아니다(roles/assign.ts의 keyId 자리에 쓴다).
export interface TrustedKey {
  readonly key: KeyObject;
  readonly keyId: string;
}

// 적용 결과. from·to는 적용 전후에 믿는 판 번호다(null은 아무도 믿지 않음).
// applied면 옛 판에서 인증된 연결을 새 상태의 stillTrusts로 모두 다시 본다. rejected에서 from이 null이 아니면
// 옛 판의 연결은 모두 무효다(새 상태는 아무도 믿지 않는다). 이 판단은 연결을 끊지 않는다.
export type ApplyOutcome =
  | { readonly kind: "applied"; readonly state: RegistryState; readonly from: number | null; readonly to: number }
  | { readonly kind: "unchanged"; readonly state: RegistryState; readonly from: number; readonly to: number }
  | {
      readonly kind: "rejected";
      readonly state: RegistryState;
      readonly from: number | null;
      readonly to: null;
      readonly reason: RegistryRejectReason;
      // 문제가 된 행의 위치(0부터). 문서 전체의 문제면 null.
      readonly row: number | null;
    };

export interface AttemptSummary {
  readonly outcome: "applied" | "unchanged" | "rejected";
  readonly reason: RegistryRejectReason | null;
  readonly row: number | null;
}

// 관리자 확인·지표가 읽는 것. 키·저장소 ID·인스턴스·대상 같은 등록표의 값을 싣지 않는다.
export interface RegistryReadout {
  // 지금 믿는 판. null이면 아무도 믿지 않는다(적용 전이거나 적용에 실패해 닫힘).
  readonly revision: number | null;
  readonly rows: number;
  readonly activeRows: number;
  // 마지막으로 적용에 성공한 판. 닫힌 뒤에도 남는다. 다시 열려면 이보다 큰 판이 와야 한다.
  readonly lastAppliedRevision: number | null;
  readonly lastAttempt: AttemptSummary | null;
}

interface Row {
  readonly target: string;
  readonly role: Role;
  readonly principal: string;
  readonly active: boolean;
  readonly key: KeyObject;
  readonly keyId: string;
}

interface Table {
  readonly revision: number;
  readonly digest: string;
  readonly rows: readonly Row[];
  // 주체 이름 → 행. 주체 이름은 문서에서 하나뿐이다(duplicate_identity).
  readonly byPrincipal: ReadonlyMap<string, Row>;
}

interface Settings {
  readonly environment: string;
  readonly namespaceOf: ReadonlyMap<string, string>;
  readonly rolesOf: ReadonlyMap<string, readonly Role[]>;
  readonly maxBytes: number;
  readonly maxRows: number;
}

interface Inner {
  // null이면 설정이 틀려 어떤 문서도 적용하지 않는다.
  readonly settings: Settings | null;
  // 지금 믿는 판. null이면 아무도 믿지 않는다.
  readonly table: Table | null;
  // 마지막으로 적용한 판의 번호와 내용 digest. 판 번호는 이보다 커야 새로 적용된다.
  readonly floor: { readonly revision: number; readonly digest: string } | null;
  readonly last: AttemptSummary | null;
}

// 지금 적용 중인 판. 불변 값이다. 행은 private 칸에 있어 객체를 통째로 로그·JSON으로 내도 명단이 실리지 않는다.
export class RegistryState {
  readonly #inner: Inner;

  private constructor(inner: Inner) {
    this.#inner = Object.freeze(inner);
  }

  // 아무 판도 적용하지 않은 상태. 모든 질의에 "없음"이다.
  static start(settings: RegistrySettings): RegistryState {
    return new RegistryState({ settings: readSettings(settings), table: null, floor: null, last: null });
  }

  apply(input: RegistryInput): ApplyOutcome {
    const inner = this.#inner;
    const from = inner.table?.revision ?? null;
    const reject = (reason: RegistryRejectReason, row: number | null = null): ApplyOutcome => {
      // 실패는 지금 판을 버린다. floor는 남겨 같거나 낮은 판이 다시 열지 못하게 한다.
      const state = new RegistryState({ ...inner, table: null, last: attempt("rejected", reason, row) });
      return { kind: "rejected", state, from, to: null, reason, row };
    };
    if (!inner.settings) return reject("bad_settings");
    if (!isObject(input) || input.kind !== "content") return reject("unreadable");
    const parsed = parseDocument(input.content, inner.settings);
    if (!parsed.ok) return reject(parsed.reason, parsed.row);
    const next = parsed.table;
    const floor = inner.floor;
    if (floor) {
      if (next.revision === floor.revision && next.digest !== floor.digest) return reject("revision_conflict");
      if (next.revision === floor.revision && inner.table) {
        const state = new RegistryState({ ...inner, last: attempt("unchanged", null, null) });
        return { kind: "unchanged", state, from: inner.table.revision, to: inner.table.revision };
      }
      if (next.revision <= floor.revision) return reject("not_newer");
    }
    const state = new RegistryState({
      settings: inner.settings,
      table: next,
      floor: { revision: next.revision, digest: next.digest },
      last: attempt("applied", null, null),
    });
    return { kind: "applied", state, from, to: next.revision };
  }

  // 이 연결(TLS가 확인한 배포 신원)에서 이 주체(봉투의 sender)의 서명을 확인할 키. 지금 판의 활성 행 가운데
  // 대상·네임스페이스·역할·인스턴스·저장소 ID가 모두 맞는 행의 키만 답한다. 없으면 undefined이고,
  // 그 답을 verifyEnvelope에 넣으면 unknown_sender다.
  keyFor(peer: ExecutorPeer, sender: string): TrustedKey | undefined {
    const { settings, table } = this.#inner;
    if (!settings || !table) return undefined;
    if (!isObject(peer) || peer.kind !== "executor" || typeof peer.target !== "string" || typeof peer.namespace !== "string") return undefined;
    if (settings.namespaceOf.get(peer.target) !== peer.namespace) return undefined;
    if (typeof sender !== "string" || parsePrincipal(sender)?.kind !== "worker_executor") return undefined;
    const row = table.byPrincipal.get(sender);
    if (!row || !row.active || row.target !== peer.target) return undefined;
    return { key: row.key, keyId: row.keyId };
  }

  // verifyEnvelope의 publicKeyFor 자리에 넣는 함수. 만든 때의 상태로 답하므로 부르는 쪽은 봉투마다 지금 쥔 상태에서 새로 만든다.
  publicKeyFor(peer: ExecutorPeer): (sender: string) => KeyObject | undefined {
    return (sender) => this.keyFor(peer, sender)?.key;
  }

  // 옛 판에서 이 연결·주체·키로 인증한 것이 지금 판에서도 유효한가. 적용 결과를 받을 때마다 모든 연결에 다시 묻는다.
  stillTrusts(peer: ExecutorPeer, sender: string, keyId: string): boolean {
    // 답이 없을 때 undefined끼리 같다고 보지 않게 답이 있는지 먼저 본다.
    const trusted = this.keyFor(peer, sender);
    return trusted !== undefined && typeof keyId === "string" && trusted.keyId === keyId;
  }

  readout(): RegistryReadout {
    const { table, floor, last } = this.#inner;
    return Object.freeze({
      revision: table?.revision ?? null,
      rows: table?.rows.length ?? 0,
      activeRows: table ? table.rows.filter((row) => row.active).length : 0,
      lastAppliedRevision: floor?.revision ?? null,
      lastAttempt: last,
    });
  }
}

// readout이 그대로 내보내므로 얼려 둔다. 받은 쪽이 고쳐도 상태가 바뀌지 않는다.
function attempt(outcome: AttemptSummary["outcome"], reason: RegistryRejectReason | null, row: number | null): AttemptSummary {
  return Object.freeze({ outcome, reason, row });
}

// ---- 설정 ----

// 클러스터 이름과 배포 대상 id의 글자 규칙: Kubernetes 이름(RFC 1123 label), tls-policy.ts의 URI 칸과 같은 꼴.
const LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

function readSettings(raw: RegistrySettings): Settings | null {
  if (!isObject(raw) || typeof raw.environment !== "string" || !LABEL.test(raw.environment) || !Array.isArray(raw.targets)) return null;
  const maxBytes = raw.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRows = raw.maxRows ?? Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) return null;
  if (maxRows !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxRows) || maxRows < 0)) return null;
  const namespaceOf = new Map<string, string>();
  const rolesOf = new Map<string, readonly Role[]>();
  for (const entry of raw.targets) {
    if (!isObject(entry) || typeof entry.target !== "string" || !LABEL.test(entry.target)) return null;
    if (typeof entry.namespace !== "string" || !LABEL.test(entry.namespace) || !Array.isArray(entry.roles)) return null;
    if (!entry.roles.every(isRole) || namespaceOf.has(entry.target)) return null;
    namespaceOf.set(entry.target, entry.namespace);
    // 부르는 쪽이 뒤에 표를 바꿔도 이 상태가 보는 표는 바뀌지 않게 복사한다.
    rolesOf.set(entry.target, Object.freeze([...entry.roles]));
  }
  return Object.freeze({ environment: raw.environment, namespaceOf, rolesOf, maxBytes, maxRows });
}

// ---- 문서 ----

type Parsed = { ok: true; table: Table } | { ok: false; reason: RegistryRejectReason; row: number | null };

const fail = (reason: RegistryRejectReason, row: number | null = null): Parsed => ({ ok: false, reason, row });

function parseDocument(content: unknown, settings: Settings): Parsed {
  const read = decodeJson(content, settings.maxBytes);
  if (!read.ok) return read;
  const doc = read.value;
  const shape = checkFields(doc, REGISTRY_FIELDS, null);
  if (shape) return shape;
  const { environment, revision, executors } = doc as Record<string, unknown>;
  if (typeof environment !== "string" || !Number.isSafeInteger(revision) || (revision as number) < 1 || !Array.isArray(executors)) {
    return fail("bad_field");
  }
  // JSON.parse는 7.9999999999999999를 8로, 8.0·8e0을 8로 만든다. 그러면 원문에 없던 판 번호가 실제 판의 자리를 차지한다.
  // 원문의 숫자 토큰이 그 정수의 십진 표기 그대로일 때만 받는다(소수점·지수·음수 0을 거른다).
  if (topLevelToken(read.text, "revision") !== String(revision)) return fail("bad_field");
  if (environment !== settings.environment) return fail("wrong_environment");
  if (executors.length > settings.maxRows) return fail("too_many_rows");

  const rows: Row[] = [];
  const normalized: Record<string, unknown>[] = [];
  const byPrincipal = new Map<string, Row>();
  const keyOwner = new Map<string, { target: string; role: Role }>();
  const activeInstances = new Set<string>();
  for (let i = 0; i < executors.length; i++) {
    const item: unknown = executors[i];
    const rowShape = checkFields(item, ROW_FIELDS, i);
    if (rowShape) return rowShape;
    const { target, role, instance, storage, public_key: publicKey, active } = item as Record<string, unknown>;
    if (typeof target !== "string" || typeof role !== "string" || typeof instance !== "string" || typeof storage !== "string") return fail("bad_field", i);
    if (typeof publicKey !== "string" || typeof active !== "boolean") return fail("bad_field", i);
    if (!isRole(role)) return fail("unknown_role", i);
    const principal = `executor/${role}/${instance}/${storage}`;
    const parsed = parsePrincipal(principal);
    // 인스턴스·저장소 ID에 '/'가 들면 칸이 밀려 다른 이름으로 읽힐 수 있다. 다시 나눈 값이 같을 때만 받는다.
    if (parsed?.kind !== "worker_executor" || parsed.instance !== instance || parsed.storage !== storage) return fail("bad_field", i);
    const key = readKey(publicKey);
    if (!key) return fail("bad_public_key", i);
    const allowed = settings.rolesOf.get(target);
    if (!allowed) return fail("unknown_target", i);
    if (!allowed.includes(role)) return fail("role_not_allowed", i);
    // 비활성 행도 센다. 폐기한 주체 이름·키가 다른 행으로 다시 쓰이면 어느 행이 맞는지 가릴 수 없다.
    if (byPrincipal.has(principal)) return fail("duplicate_identity", i);
    const owner = keyOwner.get(publicKey);
    if (owner) return fail(owner.role === role && owner.target === target ? "duplicate_key" : "key_in_two_roles", i);
    // 인스턴스는 활성 행끼리만 센다. 저장소를 잃어 새 저장소·새 키로 다시 등록하면 옛 행은 비활성으로 남는다.
    if (active) {
      if (activeInstances.has(instance)) return fail("duplicate_identity", i);
      activeInstances.add(instance);
    }
    const row: Row = Object.freeze({ target, role, principal, active, key, keyId: keyIdOf(publicKey) });
    rows.push(row);
    byPrincipal.set(principal, row);
    keyOwner.set(publicKey, { target, role });
    normalized.push({ target, role, instance, storage, public_key: publicKey, active });
  }
  // 같은 판인지 가리는 내용 digest. 행의 순서·공백·이스케이프 표기는 뜻이 아니라서 행을 정규 직렬화 순으로 정렬해 센다.
  const sorted = normalized.map((row) => digestOf(row)).sort();
  const digest = digestOf({ environment, revision, executors: sorted });
  return { ok: true, table: Object.freeze({ revision: revision as number, digest, rows: Object.freeze(rows), byPrincipal }) };
}

type Decoded = { ok: true; value: unknown; text: string } | { ok: false; reason: RegistryRejectReason; row: null };

// 해석은 연결의 바이트 틀 디코더를 그대로 쓴다: 해석 전 크기 상한, 깨진 UTF-8·BOM 거절, RFC 8259 문법, 객체마다 중복 키 거절,
// 깊이 상한을 JSON.parse가 같은 키를 덮기 전에 본다. 해석기를 하나 더 두지 않으려는 것이다.
function decodeJson(content: unknown, maxBytes: number): Decoded {
  let bytes: Uint8Array;
  if (typeof content === "string") {
    if (!content.isWellFormed()) return { ok: false, reason: "not_utf8", row: null };
    bytes = new TextEncoder().encode(content);
  } else if (content instanceof Uint8Array) {
    bytes = content;
  } else {
    return { ok: false, reason: "unreadable", row: null };
  }
  if (bytes.length > maxBytes) return { ok: false, reason: "too_large", row: null };
  const frame = encodeFrame(bytes);
  if (!frame.ok) return { ok: false, reason: frame.reason === "frame_too_large" ? "too_large" : "not_json", row: null };
  const decoder = createFrameDecoder();
  const step = decoder.push(frame.frame);
  if (step.rejected) return { ok: false, reason: frameReason(step.rejected), row: null };
  const end = decoder.end();
  if (end.rejected || step.envelopes.length !== 1) return { ok: false, reason: "not_json", row: null };
  // 디코더가 이미 fatal로 푼 바이트라 여기서 던지지 않는다.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return { ok: true, value: step.envelopes[0]!.value, text };
}

// 최상위 객체의 name 칸 값의 원문 토큰. 바이트 틀 디코더가 RFC 8259 문법과 객체마다 중복 키를 이미 확인한 글에만 쓴다.
// 글 전체에서 "revision"을 찾으면 문자열 안의 글자나 안쪽 객체의 같은 이름 칸에 속으므로, 최상위 칸을 차례로 건너며 찾는다.
// 칸 이름은 JSON 이스케이프를 푼 값으로 비교한다(글자 하나를 유니코드 이스케이프로 쓴 이름도 같은 칸이다).
function topLevelToken(text: string, name: string): string | undefined {
  let pos = 0;
  const space = () => {
    while (pos < text.length && " \t\n\r".includes(text[pos]!)) pos++;
  };
  // pos가 여는 따옴표에 있을 때 문자열 하나를 건너고 푼 값을 돌려준다.
  const readString = (): string => {
    const start = pos++;
    while (pos < text.length && text[pos] !== '"') pos += text[pos] === "\\" ? 2 : 1;
    pos++;
    return JSON.parse(text.slice(start, pos)) as string;
  };
  const skipValue = () => {
    const c = text[pos];
    if (c === '"') {
      readString();
      return;
    }
    if (c === "{" || c === "[") {
      let depth = 0;
      do {
        const d = text[pos];
        if (d === '"') {
          readString();
          continue;
        }
        if (d === "{" || d === "[") depth++;
        else if (d === "}" || d === "]") depth--;
        pos++;
      } while (depth > 0 && pos < text.length);
      return;
    }
    while (pos < text.length && !",}] \t\n\r".includes(text[pos]!)) pos++;
  };
  space();
  if (text[pos] !== "{") return undefined;
  pos++;
  while (pos < text.length) {
    space();
    if (text[pos] !== '"') return undefined;
    const key = readString();
    space();
    if (text[pos] !== ":") return undefined;
    pos++;
    space();
    const start = pos;
    skipValue();
    if (key === name) return text.slice(start, pos);
    space();
    if (text[pos] !== ",") return undefined;
    pos++;
  }
  return undefined;
}

function frameReason(reason: FrameRejectReason): RegistryRejectReason {
  if (reason === "frame_bad_utf8") return "not_utf8";
  if (reason === "frame_duplicate_key") return "duplicate_member";
  if (reason === "frame_too_large") return "too_large";
  return "not_json";
}

// 평범한 객체이고 칸이 정확히 fields인가. 모르는 칸을 먼저 본다.
function checkFields(value: unknown, fields: readonly string[], row: number | null): Parsed | null {
  if (!isObject(value) || Array.isArray(value)) return fail("bad_field", row);
  const keys = Object.keys(value);
  if (keys.some((key) => !fields.includes(key))) return fail("unknown_field", row);
  if (fields.some((field) => !Object.hasOwn(value, field))) return fail("missing_field", row);
  return null;
}

function readKey(raw: string): KeyObject | undefined {
  let key: KeyObject;
  try {
    key = publicKeyFromRaw(raw);
  } catch {
    return undefined;
  }
  // publicKeyFromRaw는 정규 base64url인 32바이트면 점인지 보지 않고 키 객체를 만든다. 곡선 위에 없는 값으로는 서명을 확인할 수 없고,
  // 작은 위수의 점이면 개인 키 없이 만든 서명이 통할 수 있다. 그런 행이 든 판을 적용 성공으로 내지 않게 여기서 거른다.
  return isUsablePoint(Buffer.from(raw, "base64url")) ? key : undefined;
}

// ---- Ed25519 공개 키의 점 검사 ----
// 정규 인코딩(y < p)이고, 곡선 위의 점으로 풀리고, 작은 위수의 여덟 점이 아니고, 위수 L의 주 부분군에 드는 점만 받는다.
// 디코딩은 RFC 8032 5.1.3, 덧셈은 5.1.4(https://www.rfc-editor.org/rfc/rfc8032#section-5.1)를 그대로 따른다.
const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const D = mod(-121665n * modPow(121666n, P - 2n));
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);

// 작은 위수(1·2·4·8)의 여덟 점의 정규 인코딩. 출처: libsodium 1.0.18의 ge25519_has_small_order 목록
// (https://github.com/jedisct1/libsodium/blob/1.0.18/src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c).
// 그 목록은 부호 비트를 가린 일곱 값이고 그중 p·p+1은 y가 p 이상이라 디코딩에서 먼저 걸린다. 남은 다섯 값에 부호 비트를
// 펼치되 x가 0인 1·p-1은 부호 비트 1이 디코딩 실패라 하나씩만 남는다.
const SMALL_ORDER = new Set([
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
]);

function isUsablePoint(bytes: Uint8Array): boolean {
  if (bytes.length !== 32 || SMALL_ORDER.has(Buffer.from(bytes).toString("hex"))) return false;
  // 리틀 엔디언 정수. 255번 비트는 x의 홀짝(x_0)이고 그 비트를 지운 값이 y다.
  const sign = bytes[31]! >> 7;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i]! & 0x7f : bytes[i]!);
  if (y >= P) return false;
  // x^2 = u / v. 후보 x = u v^3 (u v^7)^((p-5)/8).
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = mod(v * v * v);
  let x = mod(u * v3 * modPow(mod(u * v3 * v3 * v), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 !== u) {
    if (vx2 !== mod(-u)) return false;
    x = mod(x * SQRT_M1);
  }
  if (x === 0n && sign === 1) return false;
  if (Number(x & 1n) !== sign) x = P - x;
  return inPrimeSubgroup(x, y);
}

type Point = readonly [x: bigint, y: bigint, z: bigint, t: bigint];

// [L](x, y)가 항등원인가. 작은 위수 점과 혼합 위수 점(주 부분군의 점 + 작은 위수 점)은 [L]배가 항등원이 아니다.
// L은 공개 상수라 실행 시간이 비밀에 따라 달라지지 않는다.
function inPrimeSubgroup(x: bigint, y: bigint): boolean {
  let result: Point = [0n, 1n, 1n, 0n];
  let base: Point = [x, y, 1n, mod(x * y)];
  for (let k = L; k > 0n; k >>= 1n) {
    if (k & 1n) result = addPoints(result, base);
    base = addPoints(base, base);
  }
  // 확장 좌표의 항등원은 (0, Z, Z, 0)이다.
  return result[0] === 0n && result[1] === result[2];
}

// RFC 8032 5.1.4의 확장 좌표 덧셈. 완전한 공식이라 같은 점끼리(두 배)에도 그대로 쓴다.
function addPoints([x1, y1, z1, t1]: Point, [x2, y2, z2, t2]: Point): Point {
  const a = mod((y1 - x1) * (y2 - x2));
  const b = mod((y1 + x1) * (y2 + x2));
  const c = mod(t1 * 2n * D * t2);
  const d = mod(z1 * 2n * z2);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
  }
  return result;
}

function keyIdOf(raw: string): string {
  return createHash("sha256").update(Buffer.from(raw, "base64url")).digest("base64url");
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
