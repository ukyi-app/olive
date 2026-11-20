// 실행기 쪽 소켓 조립. tls-client.ts로 감독에 붙고, framing.ts의 틀로 바이트를 자르고 이어, link.ts의 ExecutorLink에 Transport로 넘긴다.
// 연결의 판단(맞춤, challenge, 세대, hello, 재전송)은 다시 만들지 않는다. 여기는 바이트와 연결의 수명, 다시 붙기의 간격까지다.
//
//   start → connect ─성공→ link.open(이 연결의 Transport) ─프레임→ connection.receive(하나씩, 받은 순서) ─닫힘→ 간격 → connect
//                   └실패→ 간격 → connect                                                                    stop → 더 붙지 않음
//
// - 연결마다 Transport(Wire) 하나, 틀 디코더 하나, link.open 한 번이다. Wire는 자기 소켓에만 쓰므로 앞 연결의 Connection이
//   늦게 보내도 새 소켓에 실리지 않는다. 닫힌 Wire의 보내기와 받은 프레임은 버린다.
// - 받은 프레임은 앞 프레임의 receive가 끝난 뒤에 다음 것을 넘긴다. receive는 검증(nonce I/O)을 기다리므로 겹쳐 부르면
//   뒤 프레임이 먼저 처리될 수 있다. 줄이 비지 않은 동안은 소켓 읽기를 멈춰 줄이 받는 속도만큼만 자란다.
// - 틀이 거절하면 그 push에서 나온 앞의 온전한 틀도 넘기지 않고 연결을 닫는다(연결이 닫히면 link도 그 연결의 것을 받지 않는다).
// - 소켓이 끝나면 그 연결의 Connection을 바로 닫는다. 기다리는 challenge는 이때 버려지고(계약 v1 "버리는 때"의 (2)),
//   다시 붙기를 기다리는 동안 남지 않는다.
// - 다시 붙기는 실패마다 간격을 늘리고(상한까지), 그 연결이 맞춤을 끝냈을 때만 처음 간격으로 되돌린다.
//   TLS는 붙었지만 감독이 받지 않는 연결(TLS 1.3에서는 붙은 뒤에 끊긴다, tls-client.ts)은 실패로 센다.
// 밖으로 던지지 않는다. 결과는 onEvent의 구별된 사건으로만 알린다.
import { canonicalJson, type Envelope } from "../contract/v1/index.ts";
import { createFrameDecoder, encodeFrame, type FrameDecoder, type FrameRejectReason } from "../transport/framing.ts";
import { type ConnectFailure, type TlsClient, TlsConnectError, type VerifiedSupervisorConnection } from "../transport/tls-client.ts";
import type { Connection, ExecutorLink, Transport } from "./link.ts";

// setTimeout이 받는 가장 긴 기다림. 넘으면 런타임이 1ms로 바꾼다.
const TIMER_MAX_MS = 2_147_483_647;

// 다시 붙기의 간격. 숫자는 실측 전이라 부르는 쪽이 넘긴다(기본값 없음).
export interface ReconnectPolicy {
  // 처음 간격. 1 이상의 정수 ms.
  readonly initialDelayMs: number;
  // 간격의 상한. initialDelayMs 이상 TIMER_MAX_MS 이하의 정수 ms.
  readonly maxDelayMs: number;
  // 실패마다 간격에 곱하는 수. 1 이상의 유한수(1이면 늘리지 않는다).
  readonly multiplier: number;
  // 간격에서 무작위로 덜어 내는 최대 비율. 0 이상 1 미만(0이면 덜지 않는다).
  readonly jitterRatio: number;
}

export interface SocketTimer {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export type CloseReason =
  // 상대가 끝을 알렸다(틀의 경계에서).
  | "peer_ended"
  | "socket_error"
  | "socket_closed"
  // link가 그 연결을 닫았다(맞춤 기한, 세대 불일치, 저장 실패 등). 이유는 link와 worker가 안다.
  | "link_closed"
  // link.open이 던졌다.
  | "open_failed"
  // 보낼 봉투를 정규 직렬화나 틀로 만들지 못했다.
  | "encode_failed"
  // 받은 프레임의 처리(receive)가 던졌다. 그 지시의 결과를 모르므로 새 연결에서 다시 맞춘다.
  | "receive_failed"
  | "stopped"
  | FrameRejectReason;

export type SocketEvent =
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "connected"; readonly attempt: number }
  | { readonly kind: "connect_failed"; readonly attempt: number; readonly reason: ConnectFailure["kind"] | "threw" }
  // 그 연결이 맞춤을 끝냈다. 다음 다시 붙기는 처음 간격부터다.
  | { readonly kind: "synced"; readonly attempt: number }
  | { readonly kind: "closed"; readonly attempt: number; readonly reason: CloseReason }
  | { readonly kind: "retry_scheduled"; readonly delayMs: number }
  // 타이머가 기다림을 받지 않았다(던짐). 더 붙지 않는다.
  | { readonly kind: "retry_unavailable" }
  | { readonly kind: "stopped" };

export interface ExecutorSocketOptions {
  readonly client: Pick<TlsClient, "connect">;
  // 이 소켓 하나만 이 link에 연결을 연다. 둘이 같은 link를 쓰면 서로의 연결을 닫는다.
  readonly link: Pick<ExecutorLink, "open" | "isCurrent">;
  readonly policy: ReconnectPolicy;
  readonly timer: SocketTimer;
  // [0, 1)의 수. 밖의 값이면 0으로 본다(덜지 않는 쪽, 간격이 길어지는 쪽).
  readonly random: () => number;
  readonly onEvent?: (event: SocketEvent) => void;
}

export type SocketPhase = "idle" | "connecting" | "open" | "waiting" | "stopped";

export interface ExecutorSocket {
  // 처음 한 번만 붙기 시작한다. 그 밖에는 아무 일도 없다.
  start(): void;
  // 더 붙지 않고, 붙는 중이면 거두고, 열린 소켓을 닫는다. 진행 중인 붙기가 끝나고 소켓이 닫힌 뒤에 돌아온다.
  stop(): Promise<void>;
  phase(): SocketPhase;
}

export type CreateSocketResult = { readonly ok: true; readonly socket: ExecutorSocket } | { readonly ok: false; readonly reason: "policy_rejected" };

export function createExecutorSocket(options: ExecutorSocketOptions): CreateSocketResult {
  if (!validPolicy(options.policy)) return { ok: false, reason: "policy_rejected" };
  return { ok: true, socket: new Socket(options) };
}

function validPolicy(policy: ReconnectPolicy): boolean {
  const { initialDelayMs, maxDelayMs, multiplier, jitterRatio } = policy;
  return (
    Number.isSafeInteger(initialDelayMs) &&
    initialDelayMs >= 1 &&
    Number.isSafeInteger(maxDelayMs) &&
    maxDelayMs >= initialDelayMs &&
    maxDelayMs <= TIMER_MAX_MS &&
    Number.isFinite(multiplier) &&
    multiplier >= 1 &&
    Number.isFinite(jitterRatio) &&
    jitterRatio >= 0 &&
    jitterRatio < 1
  );
}

type RawSocket = VerifiedSupervisorConnection["socket"];

const UTF8 = new TextEncoder();

class Socket implements ExecutorSocket {
  private state: SocketPhase = "idle";
  private attempts = 0;
  // 다음 실패 뒤에 쓸 간격(덜기 전).
  private base: number;
  // 진행 중인 붙기. 끝난 결과는 attempt가 같을 때만 쓴다.
  private pending: { readonly attempt: number; readonly controller: AbortController } | null = null;
  private settling: Promise<void> = Promise.resolve();
  private current: Wire | null = null;
  // 걸어 둔 기다림. 타이머가 늦게 불러도 이 표가 같을 때만 붙는다.
  private retry: { readonly handle: unknown } | null = null;

  constructor(private readonly options: ExecutorSocketOptions) {
    this.base = options.policy.initialDelayMs;
  }

  phase(): SocketPhase {
    return this.state;
  }

  start(): void {
    if (this.state !== "idle") return;
    this.connect();
  }

  async stop(): Promise<void> {
    const wire = this.current;
    if (this.state !== "stopped") {
      this.state = "stopped";
      if (this.retry !== null) {
        const { handle } = this.retry;
        this.retry = null;
        try {
          this.options.timer.clear(handle);
        } catch {
          // 표를 비웠으므로 늦게 불려도 붙지 않는다
        }
      }
      this.pending?.controller.abort();
      if (wire !== null) this.shut(wire, "stopped");
      this.emit({ kind: "stopped" });
    }
    await this.settling;
    if (wire !== null) await wire.gone;
  }

  private emit(event: SocketEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // 기록하는 쪽의 실패가 연결의 수명을 바꾸지 않는다
    }
  }

  private connect(): void {
    if (this.state === "stopped") return;
    const attempt = ++this.attempts;
    const controller = new AbortController();
    this.pending = { attempt, controller };
    this.state = "connecting";
    this.emit({ kind: "connecting", attempt });
    let connecting: Promise<VerifiedSupervisorConnection>;
    try {
      connecting = this.options.client.connect(controller.signal);
    } catch (error) {
      connecting = Promise.reject(error);
    }
    this.settling = connecting.then(
      (verified) => this.connected(attempt, verified),
      (error: unknown) => this.failed(attempt, error),
    );
  }

  private connected(attempt: number, verified: VerifiedSupervisorConnection): void {
    // 멈춘 뒤나 다른 붙기로 넘어간 뒤에 끝난 붙기의 소켓은 쓰지 않고 닫는다.
    if (this.state === "stopped" || this.pending?.attempt !== attempt) {
      verified.socket.destroy();
      return;
    }
    this.pending = null;
    // 돌려받기 전에 이미 끊긴 소켓이면 close 사건을 놓쳤을 수 있다. link에 열지 않고 실패로 센다.
    if (verified.socket.destroyed) {
      verified.socket.destroy();
      this.emit({ kind: "connect_failed", attempt, reason: "tls_error" });
      this.schedule();
      return;
    }
    this.state = "open";
    const wire = new Wire(this, attempt, verified.socket);
    this.current = wire;
    this.emit({ kind: "connected", attempt });
    // link.open은 동기로 맞춤 요청을 싣는다. 소켓 사건은 그 뒤 차례에만 오므로 connection을 쥐기 전에 프레임이 오지 않는다.
    let connection: Connection;
    try {
      connection = this.options.link.open(wire);
    } catch {
      this.shut(wire, "open_failed");
      return;
    }
    wire.connection = connection;
    // 맞춤 요청을 싣다가 이 연결이 이미 닫혔으면 link 쪽도 닫아 대기값을 버린다.
    if (wire.closed) connection.close();
    else wire.follow();
  }

  private failed(attempt: number, error: unknown): void {
    if (this.state === "stopped" || this.pending?.attempt !== attempt) return;
    this.pending = null;
    const reason = error instanceof TlsConnectError ? error.failure.kind : "threw";
    this.emit({ kind: "connect_failed", attempt, reason });
    this.schedule();
  }

  // 그 연결의 끝. 한 연결에 한 번만 효과가 난다.
  shut(wire: Wire, reason: CloseReason): void {
    if (wire.closed) return;
    wire.closed = true;
    wire.release();
    try {
      wire.connection?.close();
    } catch {
      // Connection.close는 Transport의 실패를 삼킨다. 여기까지 오면 그 연결은 이미 닫혔다
    }
    this.emit({ kind: "closed", attempt: wire.attempt, reason });
    if (this.current !== wire) return;
    this.current = null;
    this.schedule();
  }

  // 받은 프레임 하나의 처리가 끝났다. 지금 연결이 맞춤을 끝냈으면 간격을 처음으로 되돌린다.
  received(wire: Wire): void {
    const connection = wire.connection;
    if (wire.closed || wire.synced || this.current !== wire || connection === null) return;
    if (!this.options.link.isCurrent(connection) || connection.state !== "synced") return;
    wire.synced = true;
    this.base = this.options.policy.initialDelayMs;
    this.emit({ kind: "synced", attempt: wire.attempt });
  }

  private schedule(): void {
    if (this.state === "stopped") return;
    this.state = "waiting";
    const delayMs = this.nextDelay();
    const token: { handle: unknown } = { handle: undefined };
    this.retry = token;
    try {
      token.handle = this.options.timer.set(() => {
        if (this.retry !== token) return;
        this.retry = null;
        this.connect();
      }, delayMs);
    } catch {
      // 기다림을 걸지 못했다. 기다림 없이 붙지 않도록 더 붙지 않는다(phase는 waiting으로 남는다).
      this.retry = null;
      this.emit({ kind: "retry_unavailable" });
      return;
    }
    this.emit({ kind: "retry_scheduled", delayMs });
  }

  private nextDelay(): number {
    const { maxDelayMs, multiplier, jitterRatio } = this.options.policy;
    const base = this.base;
    this.base = Math.min(maxDelayMs, Math.ceil(base * multiplier));
    let r: number;
    try {
      r = this.options.random();
    } catch {
      r = 0;
    }
    if (!Number.isFinite(r) || r < 0 || r >= 1) r = 0;
    return Math.max(1, Math.round(base - base * jitterRatio * r));
  }
}

// 연결 하나. link에 넘기는 Transport이고 그 소켓의 바이트를 다룬다.
class Wire implements Transport {
  closed = false;
  synced = false;
  connection: Connection | null = null;
  // 소켓의 close 사건이 온 뒤에 풀린다.
  readonly gone: Promise<void>;
  private readonly decoder: FrameDecoder = createFrameDecoder();
  private readonly queue: unknown[] = [];
  private draining = false;

  constructor(
    private readonly owner: Socket,
    readonly attempt: number,
    private readonly socket: RawSocket,
  ) {
    this.gone = new Promise((resolve) => {
      if (socket.closed) resolve();
      else socket.once("close", () => resolve());
    });
    // tls-client가 핸드셰이크까지 건 error 처리는 한 번뿐이다. 붙은 뒤의 error가 처리 없이 던져지지 않게 바로 건다.
    socket.on("error", () => this.owner.shut(this, "socket_error"));
    socket.on("close", () => this.owner.shut(this, "socket_closed"));
  }

  // 받은 바이트와 상대의 끝을 따라가기 시작한다. connection을 쥔 뒤에만 부른다.
  follow(): void {
    this.socket.on("data", (chunk: Uint8Array) => this.take(chunk));
    this.socket.on("end", () => {
      if (this.closed) return;
      const step = this.decoder.end();
      this.owner.shut(this, step.rejected ?? "peer_ended");
    });
  }

  send(envelope: Envelope): void {
    if (this.closed) return;
    let bytes: Uint8Array;
    try {
      bytes = UTF8.encode(canonicalJson(envelope));
    } catch {
      return this.owner.shut(this, "encode_failed");
    }
    const frame = encodeFrame(bytes);
    if (!frame.ok) return this.owner.shut(this, "encode_failed");
    try {
      this.socket.write(frame.frame);
    } catch {
      this.owner.shut(this, "socket_error");
    }
  }

  // link가 이 연결을 닫는다.
  close(): void {
    this.owner.shut(this, "link_closed");
  }

  release(): void {
    this.queue.length = 0;
    try {
      this.socket.destroy();
    } catch {
      // 이미 닫혔다
    }
  }

  private take(chunk: Uint8Array): void {
    if (this.closed) return;
    const step = this.decoder.push(chunk);
    if (step.rejected !== null) return this.owner.shut(this, step.rejected);
    for (const envelope of step.envelopes) this.queue.push(envelope.value);
    if (this.queue.length > 0) void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.socket.pause();
    while (!this.closed && this.queue.length > 0) {
      const raw = this.queue.shift();
      try {
        await this.connection!.receive(raw);
      } catch {
        this.owner.shut(this, "receive_failed");
        break;
      }
      this.owner.received(this);
    }
    this.draining = false;
    if (!this.closed) this.socket.resume();
  }
}
