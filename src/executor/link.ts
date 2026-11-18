// 감독과의 연결 하나의 수명. 실제 소켓·TLS·바이트 틀은 뒤 작업이고, 여기는 연결이 열리고 닫히는 순서만 다룬다.
//
//   연결이 열린다 → 새 challenge(암호학적 난수 16바이트)로 stop_sync_request를 한 번 싣는다(hello보다 먼저)
//   → 이 연결의 challenge를 담은 stop_sync_reply를 받는다 → 세대를 저장소에 적는다 → hello → 받음 확인 못 받은 영수증을 다시 보낸다
//
// - 기다리는 challenge는 요청을 실은 실제 시각(sentAt)과 함께 둔다. 기한(STOP_SYNC_WAIT_MS)이 되거나, 연결이 끝나거나,
//   맞춤이 성공하면 버린다. 기한이 지나면 그 연결을 닫는다. 다시 맞추는 것은 새 연결에서다.
// - 맞춤 전에는 맞춤 답 밖의 메시지를 검증하지도 처리하지도 않는다(nonce도 쓰지 않는다). 같은 연결의 두 번째 맞춤 답도 처리하지 않는다.
// - 맞춤 전이거나 연결이 없으면 live()가 false다. 실행기는 그때 새 실행을 띄우지 않고 자격을 받지 않는다.
// - 맞춤 성공·hello는 시작이나 자격의 근거가 아니다. 시작은 따로 서명된 task_start로만 열린다.
// - 새 연결이 열리면 앞 연결은 끝난다. 앞 연결에서 늦게 끝난 검증·저장의 결과는 버린다.
import { randomBytes } from "node:crypto";
import { type Envelope, limits, type PendingStopSync, verifyEnvelope } from "../contract/v1/index.ts";
import type { Outlet, WorkerExecutor } from "./worker.ts";

// 연결 하나의 보내기와 닫기. 실제 구현(mTLS 위의 바이트 틀)은 뒤 작업이다.
export interface Transport {
  send(envelope: Envelope): void;
  close(): void;
}

export interface LinkOptions {
  now?: () => number;
  // 시험이 challenge를 고정하는 자리. 기본은 암호학적 난수 16바이트다.
  challenge?: () => string;
}

export type ConnectionState = "syncing" | "synced" | "closed";

const actionOf = (raw: unknown): unknown => (raw as { header?: { action?: unknown } } | null)?.header?.action;

export class ExecutorLink implements Outlet {
  private current: Connection | null = null;
  private readonly now: () => number;
  private readonly challenge: () => string;

  constructor(
    readonly worker: WorkerExecutor,
    options: LinkOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.challenge = options.challenge ?? (() => randomBytes(16).toString("hex"));
    worker.attach(this);
  }

  // 인증된 연결이 새로 열렸을 때 부른다. 앞 연결의 대기값은 여기서 버린다.
  open(transport: Transport): Connection {
    this.current?.close();
    const connection = new Connection(this, transport, this.now);
    this.current = connection;
    connection.begin(this.challenge());
    return connection;
  }

  isCurrent(connection: Connection): boolean {
    return this.current === connection && connection.state !== "closed";
  }

  live(): boolean {
    return this.current !== null && this.current.state === "synced";
  }

  send(envelope: Envelope): void {
    if (this.live()) this.current!.transmit(envelope);
  }

  // 진입점이 주기로 부른다(뒤 작업). 맞춤 기한이 된 연결을 닫는다.
  tick(): void {
    this.current?.expireIfDue();
  }
}

export class Connection {
  state: ConnectionState = "syncing";
  private pendingSync: PendingStopSync | null = null;
  private requested = false;

  constructor(
    private readonly link: ExecutorLink,
    private readonly transport: Transport,
    private readonly now: () => number,
  ) {}

  pending(): PendingStopSync | null {
    return this.pendingSync === null ? null : { ...this.pendingSync };
  }

  // 연결마다 한 번만 부른다.
  begin(challenge: string): void {
    if (this.requested) return;
    this.requested = true;
    const request = this.link.worker.syncRequest(challenge);
    // sentAt은 실제로 싣는 순간의 시각이다. 봉투의 발급 시각이나 다른 요청의 시각을 다시 쓰지 않는다.
    const sentAt = this.now();
    try {
      this.transport.send(request);
    } catch {
      this.close();
      return;
    }
    this.pendingSync = { challenge, sentAt };
  }

  transmit(envelope: Envelope): void {
    if (this.state === "closed") return;
    try {
      this.transport.send(envelope);
    } catch {
      this.close();
    }
  }

  expireIfDue(): void {
    if (this.pendingSync !== null && this.now() - this.pendingSync.sentAt >= limits.STOP_SYNC_WAIT_MS) this.close();
  }

  // 상대가 끊었거나 새 연결이 열렸다. 기다리던 challenge를 버린다.
  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.pendingSync = null;
    try {
      this.transport.close();
    } catch {
      // 이미 닫혔다
    }
  }

  async receive(raw: unknown): Promise<void> {
    this.expireIfDue();
    if (!this.link.isCurrent(this)) return;
    const worker = this.link.worker;
    if (this.state === "syncing") {
      if (actionOf(raw) !== "stop_sync_reply" || this.pendingSync === null) return;
      const result = await verifyEnvelope(raw, worker.verifyContext(this.pendingSync));
      if (!this.link.isCurrent(this) || this.state !== "syncing") return;
      if (!result.ok || result.action !== "stop_sync_reply") return;
      this.pendingSync = null;
      if (result.adoptedStopGeneration !== null) {
        const saved = await worker.adopt(result.adoptedStopGeneration);
        if (!this.link.isCurrent(this)) return;
        // 적지 못했으면 이 연결로는 일하지 않는다. 다시 맞추는 것은 새 연결에서다.
        if (!saved) return this.close();
      }
      this.state = "synced";
      this.transmit(worker.hello());
      worker.resendUnacked();
      return;
    }
    if (actionOf(raw) === "stop_sync_reply") return;
    const result = await verifyEnvelope(raw, worker.verifyContext(null));
    if (!this.link.isCurrent(this) || !result.ok) return;
    await worker.handle(result);
  }
}
