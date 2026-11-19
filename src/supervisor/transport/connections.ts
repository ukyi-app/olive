// 감독이 실행기 연결을 "일을 맡길 수 있는 연결"로 인정하는가의 순수 판단. 소켓·타이머·파일·시계·난수·환경을 쓰지 않는다.
// 연결 전부의 상태는 Connections 한 값이고 부르는 쪽(뒤의 소켓 조립)이 쥔다. 판단은 새 값과 낼 것들을 돌려주고 옛 값을 바꾸지 않는다.
//
//   open(peer, at)           TLS 판정을 통과한 연결이 열림(tls-server.ts의 배포 신원)
//   check(id, raw, ctx)      봉투 하나를 계약 v1의 verifyEnvelope로 검증한다(비동기: nonce 저장소). 상태를 바꾸지 않는다
//   step(event, ctx)         검증 결과, 답을 실음, 시간이 흐름, 연결이 닫힘, 등록표가 바뀜 → (새 값, 낼 것들)
//
// 연결의 순서(계약 v1 "연결할 때 정지 세대 맞추기"):
//   awaiting_sync ─stop_sync_request→ requested ─답을 실음→ answered ─hello→ greeted(배정 후보)
// 이 밖의 순서로 온 것은 검증하지 않고(nonce를 쓰지 않는다) 그 연결을 닫는다. 같은 단계에서 함께 검증된 두 번째 것도 닫는다.
//
// 닫는 쪽으로 정한 규칙:
// - 감독의 정지 세대를 모르면(복원기의 stopGeneration()이 null) 맞춤 요청을 기다리게 하지 않고 닫는다. 계약 v1의 검증이 세대 없는
//   감독의 요청을 stop_generation_mismatch로 거절하므로 붙들어 둘 "검증된 요청"이 없고, 실행기는 새 연결·새 challenge로 다시 맞춘다
//   (v1.md "구현이 지킬 것", src/executor/link.ts). 알려진 0은 유효한 세대라 그대로 답한다.
// - 답의 세대는 서명하는 순간에 복원기에서 다시 읽는다. 요청을 검증한 때의 값이나 실행기가 보낸 값을 쓰지 않는다.
// - 검증이 거절한 봉투, 주체·키·복원이 맞춤 때와 달라진 봉투는 그 연결을 닫는다. 다시 맞추는 것은 새 연결에서다.
// - 같은 주체가 더 나중에 연 연결에서 맞춤 요청이 검증되면 앞 연결은 닫힌다. 앞 연결에서 늦게 끝난 검증의 결과는 버린다.
//
// 맞춤과 hello는 권한이 아니다. 낼 것(Output)에는 접수 열기·자격·실행 허가·슬롯 해제가 없다. greeted는 배정 후보라는 표시까지이고,
// 배정은 roles/assign.ts의 판단(두 revision 대조 포함)과 장부의 시작 트랜잭션을 따로 지나야 한다.
import { type Bodies, type Envelope, limits, type NonceStore, parsePrincipal, type Principal, RECEIPTS, type RejectReason, REPORTS, type Role, type RunStatus, type SealInput, type Verified, verifyEnvelope } from "../../contract/v1/index.ts";
import type { OccupancyAnswer, Restorer } from "../../ledger/index.ts";
import type { ExecutorPeer, RegistryState } from "./registry.ts";

// 감독의 정지 세대를 답하는 곳. 감독 진입점에서는 이번 복원의 Restorer다. null은 모름(1단계 전, 장부 실패 뒤)이고 0은 알려진 세대다.
// 답에 쓴 복원기와 같은 객체일 때만 그 연결의 hello를 "이번 복원의 인사"로 센다(객체 동일성으로 가른다).
export type StopGenerationSource = Pick<Restorer, "stopGeneration">;

export interface ConnectionSettings {
  // 동시에 열어 둘 연결 수의 상한. 미확정 기본 null(상한 없음): 설계와 계약에 숫자가 없다.
  readonly maxConnections?: number | null;
  // 같은 TLS 배포 신원(peer.uri)의 새 연결을 windowMs 안에 max개까지만 받는다. 미확정 기본 null(제한 없음): 숫자가 없어 자리만 둔다.
  // 연결마다 맞춤 요청은 하나뿐이라, 재접속 수를 묶으면 맞춤 요청이 부르는 서명·nonce 기록의 수도 묶인다.
  readonly reconnect?: { readonly windowMs: number; readonly max: number } | null;
  // 맞춤 요청을 받은 때부터 그 연결의 hello를 기다리는 한도. 미확정 기본 STOP_SYNC_WAIT_MS이고 그보다 길게 둘 수 없다.
  // 실행기는 요청을 실은 때(받은 때보다 이르다)부터 STOP_SYNC_WAIT_MS 안에 답을 받아야 세대를 저장하고 hello를 보낸다.
  readonly helloWaitMs?: number;
}

interface Settings {
  readonly maxConnections: number | null;
  readonly reconnect: { readonly windowMs: number; readonly max: number } | null;
  readonly helloWaitMs: number;
}

export type Phase = "awaiting_sync" | "requested" | "answered" | "greeted" | "closed";

export const CLOSE_REASONS = [
  // 그 단계에서 받을 수 없는 동작(맞춤 전의 hello·영수증·보고, 두 번째 맞춤 요청, 두 번째 hello, 감독이 내는 동작),
  // 답을 실은 시각보다 먼저 받은 hello
  "out_of_order",
  // 계약 v1의 검증이 거절했다(사유는 reject에 싣는다)
  "rejected",
  // 감독의 정지 세대를 모른다(복원 1단계 전이거나 장부 실패 뒤)
  "unknown_generation",
  // 맞춤 요청을 받은 때부터 STOP_SYNC_ANSWER_MAX_MS가 됐다(정각 포함)
  "answer_late",
  // 맞춤 요청을 받은 때부터 hello 대기 한도가 됐다(정각 포함)
  "hello_late",
  // 맞춤 요청과 다른 주체가 서명했다
  "principal_mismatch",
  // 등록표가 그 연결·주체·키를 더는 믿지 않는다
  "registry",
  // 답을 서명한 복원기가 지금의 복원기가 아니거나, 세대를 모르게 됐거나, 봉투의 세대가 판단하는 순간의 세대와 다르다
  "restore_changed",
  // 같은 주체가 더 나중에 연 연결에서 맞춤을 시작했다
  "superseded",
  // 답을 서명하지 못했다
  "seal_failed",
  "connection_limit",
  "throttled",
] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export interface SyncRecord {
  // 맞춤 요청 봉투에서 검증한 낸 쪽 주체와 그 키의 식별(등록표의 keyId).
  readonly principal: string;
  readonly role: Role;
  readonly keyId: string;
  readonly challenge: string;
  readonly requestId: string;
  // 맞춤 요청을 받은 시각(부르는 쪽이 check에 넘긴 now). 두 시간 경계를 여기서 잰다.
  readonly receivedAt: number;
  // 답에 실은 정지 세대와 그 값을 읽은 복원기.
  readonly generation: number;
  readonly source: StopGenerationSource;
  // 답을 연결에 실은 시각. 실기 전이면 null.
  readonly answeredAt: number | null;
}

export interface Greeting {
  readonly at: number;
  readonly profile_revision: string;
  readonly policy_revision: string;
  readonly runs: readonly RunStatus[];
}

export interface ConnectionState {
  readonly id: number;
  readonly peer: ExecutorPeer;
  readonly openedAt: number;
  readonly phase: Phase;
  // 단계가 바뀔 때마다 오른다. check와 step 사이에 단계가 바뀐 연결에는 그 검증 결과를 쓰지 않는다.
  readonly seq: number;
  readonly sync: SyncRecord | null;
  readonly greeting: Greeting | null;
  readonly closed: CloseReason | null;
}

// 배정 후보. 실행 허가도 자격도 아니다. roles/assign.ts의 AuthenticatedConnection과 같은 꼴(target·principal·keyId·hello)이다.
export interface Candidate {
  readonly connection: number;
  readonly target: string;
  readonly principal: Principal;
  readonly keyId: string;
  readonly hello: { readonly profile_revision: string; readonly policy_revision: string };
}

export const OUTPUT_KINDS = ["send_reply", "close", "occupancy", "candidate", "withdrawn", "forward"] as const;

// 낼 것. 모두 그 연결 하나와 그 연결의 주체에 대한 것이다.
export type Output =
  // 서명한 stop_sync_reply. deadline(맞춤 요청을 받은 때 + STOP_SYNC_ANSWER_MAX_MS) 정각부터는 싣지 말고 연결을 닫는다.
  // 실었으면 같은 동기 구간에서 reply_sent를 알린다.
  | { readonly kind: "send_reply"; readonly connection: number; readonly envelope: Envelope; readonly deadline: number }
  // 그 연결을 닫는다. 판단은 이미 그 연결을 closed로 두었다.
  | { readonly kind: "close"; readonly connection: number; readonly reason: CloseReason; readonly reject?: RejectReason }
  // OccupancyPort의 행. full은 이번 복원에서 이 연결이 맞춘 뒤 받은 hello, partial은 status_report다.
  | { readonly kind: "occupancy"; readonly connection: number; readonly answer: OccupancyAnswer }
  // 그 연결이 배정 후보가 됐다(권한 아님).
  | { readonly kind: "candidate"; readonly connection: number; readonly candidate: Candidate }
  // 그 연결이 배정 후보에서 빠졌다. 그 연결의 주체에 대한 사실일 뿐이고 다른 주체·종류의 슬롯이나 실행 상태를 바꾸지 않는다.
  | { readonly kind: "withdrawn"; readonly connection: number; readonly principal: string }
  // hello 뒤에 온 검증된 영수증·보고. 내용 처리(장부 반영, ack)는 뒤 조각의 처리기가 한다.
  | { readonly kind: "forward"; readonly connection: number; readonly verified: Verified };

// check의 결과. step에 envelope 사건으로 넘긴다.
export type Checked =
  | { readonly kind: "ignored"; readonly connection: number }
  | { readonly kind: "out_of_order"; readonly connection: number; readonly seq: number }
  | { readonly kind: "unknown_generation"; readonly connection: number; readonly seq: number }
  | {
      readonly kind: "verified";
      readonly connection: number;
      readonly seq: number;
      readonly at: number;
      readonly result: Verified | { ok: false; reason: RejectReason };
      // 검증에 쓴 등록표 상태에서 그 낸 쪽의 키 식별. 거절이면 null.
      readonly keyId: string | null;
    };

export interface CheckContext {
  // 봉투를 받은 시각.
  readonly now: number;
  // 지금 쥔 등록표. 봉투마다 여기서 키 조회를 새로 만든다.
  readonly registry: RegistryState;
  readonly stop: StopGenerationSource;
  // 감독 장부가 아는 실행의 세대(hello·status_report의 실행 세대 대조). 모르면 undefined.
  readonly runGeneration: (runId: string) => number | undefined;
  readonly nonces: NonceStore;
}

export interface StepContext {
  // 판단하는 시각.
  readonly now: number;
  readonly registry: RegistryState;
  readonly stop: StopGenerationSource;
}

// 답을 만드는 데 필요한 것. 감독의 개인 키는 seal 안에 있고 이 모듈은 쥐지 않는다. 요청 ID(소문자 UUID)와 nonce(소문자 16진 32자)는
// 부르는 쪽이 암호학적 난수로 만든다.
export interface ReplyTools {
  seal(input: SealInput<"stop_sync_reply">): Envelope;
  requestId(): string;
  nonce(): string;
}

export type Event =
  | { readonly kind: "envelope"; readonly checked: Checked }
  | { readonly kind: "reply_sent"; readonly connection: number; readonly at: number }
  | { readonly kind: "tick" }
  | { readonly kind: "closed"; readonly connection: number }
  | { readonly kind: "registry" };

export interface Step {
  readonly table: Connections;
  readonly outputs: Output[];
}

interface Inner {
  readonly settings: Settings;
  readonly nextId: number;
  readonly byId: ReadonlyMap<number, ConnectionState>;
  // 주체 이름 → 그 주체로 맞춤 답을 서명한 가장 나중 연결의 번호. 그 연결이 닫혀도 지우지 않는다: 더 먼저 연 연결의 늦은 맞춤을
  // 가려내는 기록이다. 키는 등록표가 믿은 주체뿐이라 등록 수로 묶인다.
  readonly holder: ReadonlyMap<string, number>;
  // peer.uri → 받아들인 새 연결의 시각(재접속 제한의 창 안의 것만).
  readonly opens: ReadonlyMap<string, readonly number[]>;
}

const EXECUTOR_ACTIONS = {
  awaiting_sync: ["stop_sync_request"],
  requested: [],
  answered: ["hello"],
  greeted: ["status_report", ...RECEIPTS, ...REPORTS],
  closed: [],
} as const satisfies Record<Phase, readonly string[]>;

export class Connections {
  readonly #inner: Inner;

  private constructor(inner: Inner) {
    this.#inner = Object.freeze(inner);
  }

  // 설정이 틀리면 던진다(진입점이 시작할 때 드러난다).
  static start(settings: ConnectionSettings = {}): Connections {
    return new Connections({ settings: readSettings(settings), nextId: 1, byId: new Map(), holder: new Map(), opens: new Map() });
  }

  // 연결의 값 그대로다. 배정 후보인지는 phase가 아니라 candidates(지금의 복원기)로 본다.
  get(id: number): ConnectionState | undefined {
    return this.#inner.byId.get(id);
  }

  // 배정 후보 전부. occupancy와 같은 연결만 낸다(#greetedNow).
  candidates(source: StopGenerationSource): Candidate[] {
    return this.#greetedNow(source).map(candidateOf);
  }

  // OccupancyPort가 내는 full 행. hello가 없는 연결은 행이 없다(빈 목록으로 지어내지 않는다: 빈 runs는 "쥔 것이 없다",
  // 행 없음은 "모른다"다).
  occupancy(source: StopGenerationSource): OccupancyAnswer[] {
    return this.#greetedNow(source).map(fullAnswer);
  }

  // 부르는 순간의 복원기(source)로 답한 맞춤 뒤에 hello를 받았고, 그 복원기가 지금 세대를 알며, 아직 열린 연결.
  // 복원기를 바꾸거나 세대를 모르게 된 뒤 tick이 옛 연결을 닫기 전에도 옛 복원의 인사를 내지 않도록 조회 때마다 본다.
  // 인사 뒤 새 정지로 세대가 오른 것은 막지 않는다(그 연결로 비상 종료를 보내야 한다).
  #greetedNow(source: StopGenerationSource): ConnectionState[] {
    if (source.stopGeneration() === null) return [];
    return [...this.#inner.byId.values()].filter((conn) => conn.phase === "greeted" && conn.sync?.source === source && conn.greeting !== null);
  }

  // 연결이 열림. 상한·재접속 제한에 걸리면 연 즉시 닫힌 연결로 둔다.
  open(peer: ExecutorPeer, at: number): Step & { readonly id: number } {
    const inner = this.#inner;
    const id = inner.nextId;
    const base: ConnectionState = Object.freeze({ id, peer, openedAt: at, phase: "awaiting_sync", seq: 0, sync: null, greeting: null, closed: null });
    const { maxConnections, reconnect } = inner.settings;
    let refuse: CloseReason | null = null;
    if (maxConnections !== null && [...inner.byId.values()].filter((c) => c.phase !== "closed").length >= maxConnections) refuse = "connection_limit";
    const opens = new Map(inner.opens);
    if (refuse === null && reconnect !== null) {
      const recent = (opens.get(peer.uri) ?? []).filter((t) => at - t >= 0 && at - t < reconnect.windowMs);
      if (recent.length >= reconnect.max) refuse = "throttled";
      else opens.set(peer.uri, Object.freeze([...recent, at]));
    }
    const byId = new Map(inner.byId);
    const outputs: Output[] = [];
    if (refuse === null) {
      byId.set(id, base);
    } else {
      byId.set(id, Object.freeze({ ...base, phase: "closed", seq: 1, closed: refuse }));
      outputs.push({ kind: "close", connection: id, reason: refuse });
    }
    return { table: new Connections({ ...inner, nextId: id + 1, byId, opens }), outputs, id };
  }

  // 봉투 하나를 검증한다. 상태를 바꾸지 않는다. 그 단계에서 받을 수 없는 동작이면 검증하지 않는다(서명 연산도 nonce도 쓰지 않는다).
  // 동작 이름은 서명 전의 값이지만 여기서는 연결을 닫는 쪽으로만 쓴다.
  async check(id: number, raw: unknown, ctx: CheckContext): Promise<Checked> {
    const conn = this.#inner.byId.get(id);
    if (!conn || conn.phase === "closed") return { kind: "ignored", connection: id };
    const action = (raw as { header?: { action?: unknown } } | null)?.header?.action;
    if (typeof action !== "string" || !(EXECUTOR_ACTIONS[conn.phase] as readonly string[]).includes(action)) {
      return { kind: "out_of_order", connection: id, seq: conn.seq };
    }
    const stopGeneration = ctx.stop.stopGeneration();
    // 세대를 모르는 감독은 맞춤 요청을 검증하지 않는다. v1의 검증도 같은 요청을 거절하지만, 그 전에 서명·nonce에 일을 쓰지 않는다.
    if (stopGeneration === null && conn.phase === "awaiting_sync") return { kind: "unknown_generation", connection: id, seq: conn.seq };
    const registry = ctx.registry;
    const result = await verifyEnvelope(raw, {
      now: ctx.now,
      expectedRecipient: "supervisor",
      publicKeyFor: registry.publicKeyFor(conn.peer),
      stopGeneration,
      stopSyncChallenge: null,
      runGeneration: ctx.runGeneration,
      nonces: ctx.nonces,
    });
    const keyId = result.ok ? (registry.keyFor(conn.peer, result.header.sender)?.keyId ?? null) : null;
    return { kind: "verified", connection: id, seq: conn.seq, at: ctx.now, result, keyId };
  }

  step(event: Event, ctx: StepContext, tools?: ReplyTools): Step {
    const draft = new Draft(this.#inner);
    switch (event.kind) {
      case "envelope":
        draft.envelope(event.checked, ctx, tools);
        break;
      case "reply_sent":
        draft.replySent(event.connection, event.at);
        break;
      case "tick":
        draft.tick(ctx);
        break;
      case "closed":
        draft.peerClosed(event.connection);
        break;
      case "registry":
        draft.registry(ctx);
        break;
    }
    return { table: new Connections(draft.done()), outputs: draft.outputs };
  }
}

// 판단 하나의 작업 사본. 옛 값의 Map은 건드리지 않는다.
class Draft {
  readonly outputs: Output[] = [];
  private readonly byId: Map<number, ConnectionState>;
  private readonly holder: Map<string, number>;

  constructor(private readonly inner: Inner) {
    this.byId = new Map(inner.byId);
    this.holder = new Map(inner.holder);
  }

  done(): Inner {
    return { ...this.inner, byId: this.byId, holder: this.holder };
  }

  private put(conn: ConnectionState, change: Partial<ConnectionState>): ConnectionState {
    const next = Object.freeze({ ...conn, ...change, seq: conn.seq + 1 });
    this.byId.set(conn.id, next);
    return next;
  }

  private close(conn: ConnectionState, reason: CloseReason, reject?: RejectReason): void {
    if (conn.phase === "closed") return;
    this.leave(conn);
    this.put(conn, { phase: "closed", closed: reason });
    this.outputs.push(reject === undefined ? { kind: "close", connection: conn.id, reason } : { kind: "close", connection: conn.id, reason, reject });
  }

  // 그 연결이 쥔 배정 후보 표시만 놓는다. 주체의 가장 나중 연결 번호(holder)는 남긴다.
  private leave(conn: ConnectionState): void {
    const principal = conn.sync?.principal;
    if (conn.phase === "greeted" && principal !== undefined) this.outputs.push({ kind: "withdrawn", connection: conn.id, principal });
  }

  envelope(checked: Checked, ctx: StepContext, tools: ReplyTools | undefined): void {
    const conn = this.byId.get(checked.connection);
    if (!conn || conn.phase === "closed" || checked.kind === "ignored") return;
    // 검증하는 사이에 같은 연결의 다른 봉투가 단계를 옮겼다: 같은 단계의 두 번째 것이다.
    if (checked.seq !== conn.seq || checked.kind === "out_of_order") return this.close(conn, "out_of_order");
    if (checked.kind === "unknown_generation") return this.close(conn, "unknown_generation");
    const result = checked.result;
    if (!result.ok) return this.close(conn, "rejected", result.reason);
    if (checked.keyId === null || !ctx.registry.stillTrusts(conn.peer, result.header.sender, checked.keyId)) return this.close(conn, "registry");
    if (result.action === "stop_sync_request") return this.syncRequest(conn, result, checked.keyId, checked.at, ctx, tools);
    const sync = conn.sync;
    if (sync === null) return this.close(conn, "out_of_order");
    if (result.header.sender !== sync.principal) return this.close(conn, "principal_mismatch");
    if (checked.keyId !== sync.keyId) return this.close(conn, "registry");
    // 이번 복원의 복원기가 지금 아는 세대와 봉투의 세대가 같아야 한다(검증하는 사이에 세대가 바뀐 것도 쓰지 않는다).
    const current = ctx.stop.stopGeneration();
    if (ctx.stop !== sync.source || current === null || result.header.stop_generation !== current) return this.close(conn, "restore_changed");
    if (result.action === "hello") {
      // hello는 이 연결에서 답한 세대 그대로여야 한다. 인사한 뒤 새 정지로 오른 세대는 비상 종료로 옮겨 가므로 막지 않는다.
      if (current !== sync.generation) return this.close(conn, "restore_changed");
      return this.hello(conn, sync, result.body, checked.at, ctx.now);
    }
    if (conn.phase !== "greeted") return this.close(conn, "out_of_order");
    if (result.action === "status_report") {
      this.outputs.push({ kind: "occupancy", connection: conn.id, answer: { executorId: sync.principal, coverage: "partial", runs: copyRuns(result.body.runs) } });
      return;
    }
    this.outputs.push({ kind: "forward", connection: conn.id, verified: result });
  }

  private syncRequest(
    conn: ConnectionState,
    result: Extract<Verified, { action: "stop_sync_request" }>,
    keyId: string,
    receivedAt: number,
    ctx: StepContext,
    tools: ReplyTools | undefined,
  ): void {
    if (conn.phase !== "awaiting_sync") return this.close(conn, "out_of_order");
    const principal = result.header.sender;
    const parsed = parsePrincipal(principal);
    if (parsed?.kind !== "worker_executor") return this.close(conn, "principal_mismatch");
    // 같은 주체의 더 나중 연결이 이미 맞춤 답을 받았으면(그 연결이 그 뒤 닫혔어도) 이 연결이 옛 연결이다.
    const holderId = this.holder.get(principal);
    if (holderId !== undefined && holderId > conn.id) return this.close(conn, "superseded");
    if (!within(ctx.now - receivedAt, limits.STOP_SYNC_ANSWER_MAX_MS)) return this.close(conn, "answer_late");
    // 서명하는 순간의 권위 세대. 요청을 검증한 때 알았어도 지금 모르면 답하지 않는다.
    const generation = ctx.stop.stopGeneration();
    if (generation === null) return this.close(conn, "unknown_generation");
    if (tools === undefined) return this.close(conn, "seal_failed");
    if (holderId !== undefined && holderId !== conn.id) {
      const older = this.byId.get(holderId);
      if (older) this.close(older, "superseded");
    }
    let envelope: Envelope;
    try {
      envelope = tools.seal({
        sender: "supervisor",
        recipient: principal,
        action: "stop_sync_reply",
        request_id: tools.requestId(),
        stop_generation: generation,
        run_generation: 0,
        issued_at: ctx.now,
        nonce: tools.nonce(),
        body: { challenge: result.body.challenge },
      });
    } catch {
      return this.close(conn, "seal_failed");
    }
    this.holder.set(principal, conn.id);
    const sync: SyncRecord = Object.freeze({
      principal,
      role: parsed.role,
      keyId,
      challenge: result.body.challenge,
      requestId: result.header.request_id,
      receivedAt,
      generation,
      source: ctx.stop,
      answeredAt: null,
    });
    this.put(conn, { phase: "requested", sync });
    this.outputs.push({ kind: "send_reply", connection: conn.id, envelope, deadline: receivedAt + limits.STOP_SYNC_ANSWER_MAX_MS });
  }

  replySent(id: number, at: number): void {
    const conn = this.byId.get(id);
    if (!conn || conn.phase !== "requested" || conn.sync === null) return;
    if (!within(at - conn.sync.receivedAt, limits.STOP_SYNC_ANSWER_MAX_MS)) return this.close(conn, "answer_late");
    this.put(conn, { phase: "answered", sync: Object.freeze({ ...conn.sync, answeredAt: at }) });
  }

  // 받은 시각과 판단하는 시각이 모두 대기 한도 안이어야 한다(검증이 오래 걸려 한도를 넘긴 것도 늦은 것이다).
  private hello(conn: ConnectionState, sync: SyncRecord, body: Bodies["hello"], at: number, now: number): void {
    if (conn.phase !== "answered") return this.close(conn, "out_of_order");
    // 답을 실은 시각보다 먼저 받은 프레임은 이 연결의 답을 보고 쓴 hello가 아니다. 같은 시각이면 부르는 쪽이 지킨 소켓 사건
    // 순서(reply_sent를 알린 뒤 받은 프레임만 이 단계에서 check에 넘긴다)를 따른다.
    if (sync.answeredAt === null || at < sync.answeredAt) return this.close(conn, "out_of_order");
    const limit = this.inner.settings.helloWaitMs;
    if (!within(at - sync.receivedAt, limit) || !within(now - sync.receivedAt, limit)) return this.close(conn, "hello_late");
    const greeting: Greeting = Object.freeze({
      at,
      profile_revision: body.profile_revision,
      policy_revision: body.policy_revision,
      runs: frozenRuns(body.runs),
    });
    const next = this.put(conn, { phase: "greeted", greeting });
    this.outputs.push({ kind: "occupancy", connection: conn.id, answer: fullAnswer(next) });
    this.outputs.push({ kind: "candidate", connection: conn.id, candidate: candidateOf(next) });
  }

  tick(ctx: StepContext): void {
    for (const conn of [...this.byId.values()]) {
      const sync = conn.sync;
      if (conn.phase === "closed" || sync === null) continue;
      const elapsed = ctx.now - sync.receivedAt;
      if (conn.phase === "requested" && !within(elapsed, limits.STOP_SYNC_ANSWER_MAX_MS)) this.close(conn, "answer_late");
      else if (conn.phase === "answered" && !within(elapsed, this.inner.settings.helloWaitMs)) this.close(conn, "hello_late");
      // 다시 복원했거나 장부가 실패해 세대를 모르게 되면 그 전의 맞춤은 이번 복원의 것이 아니다. 새 정지로 세대가 오른 것만으로는
      // 닫지 않는다(그 연결로 비상 종료를 보내야 한다). 그 뒤 옛 세대로 온 봉투는 검증이 거절해 닫힌다.
      else if (ctx.stop !== sync.source || ctx.stop.stopGeneration() === null) this.close(conn, "restore_changed");
    }
  }

  // 상대가 끊었거나 부르는 쪽이 닫았다. 그 연결의 행을 지운다(번호는 다시 쓰지 않으므로 늦은 검증 결과는 버려진다).
  peerClosed(id: number): void {
    const conn = this.byId.get(id);
    if (!conn) return;
    if (conn.phase !== "closed") this.leave(conn);
    this.byId.delete(id);
  }

  // 등록표의 적용 결과가 나올 때마다 부른다. 맞춤 때의 {peer, 주체, keyId}를 새 상태가 더는 믿지 않는 연결을 닫는다.
  registry(ctx: StepContext): void {
    for (const conn of [...this.byId.values()]) {
      if (conn.phase === "closed" || conn.sync === null) continue;
      if (!ctx.registry.stillTrusts(conn.peer, conn.sync.principal, conn.sync.keyId)) this.close(conn, "registry");
    }
  }
}

// 시한은 계약 v1처럼 정각부터 거절한다. 시계가 뒤로 가 경과가 음수여도 거절한다(통과 조건을 직접 쓴다: NaN도 거절).
function within(elapsed: number, limit: number): boolean {
  return elapsed >= 0 && elapsed < limit;
}

function copyRuns(runs: readonly RunStatus[]): RunStatus[] {
  return runs.map((run) => ({ ...run }));
}

// 보관하는 인사의 실행 목록. get()이 이 값을 그대로 내주므로 배열과 항목까지 동결한다(RunStatus는 평평한 객체다).
function frozenRuns(runs: readonly RunStatus[]): readonly RunStatus[] {
  return Object.freeze(runs.map((run) => Object.freeze({ ...run })));
}

function fullAnswer(conn: ConnectionState): OccupancyAnswer {
  return { executorId: conn.sync!.principal, coverage: "full", runs: copyRuns(conn.greeting!.runs) };
}

function candidateOf(conn: ConnectionState): Candidate {
  const sync = conn.sync!;
  const greeting = conn.greeting!;
  return Object.freeze({
    connection: conn.id,
    target: conn.peer.target,
    principal: parsePrincipal(sync.principal)!,
    keyId: sync.keyId,
    hello: Object.freeze({ profile_revision: greeting.profile_revision, policy_revision: greeting.policy_revision }),
  });
}

function readSettings(raw: ConnectionSettings): Settings {
  const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
  const maxConnections = raw.maxConnections ?? null;
  const reconnect = raw.reconnect ?? null;
  const helloWaitMs = raw.helloWaitMs ?? limits.STOP_SYNC_WAIT_MS;
  if (maxConnections !== null && !positive(maxConnections)) throw new TypeError("maxConnections: 1 이상의 안전 정수이거나 null이다");
  if (reconnect !== null && (!positive(reconnect.windowMs) || !positive(reconnect.max))) throw new TypeError("reconnect: windowMs·max는 1 이상의 안전 정수다");
  if (!positive(helloWaitMs) || helloWaitMs > limits.STOP_SYNC_WAIT_MS) throw new TypeError("helloWaitMs: 1 이상 STOP_SYNC_WAIT_MS 이하다");
  return Object.freeze({ maxConnections, reconnect: reconnect === null ? null : Object.freeze({ ...reconnect }), helloWaitMs });
}
