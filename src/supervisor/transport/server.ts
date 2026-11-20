// 감독이 실행기의 연결을 받는 서버. tls-server.ts가 넘긴 인증된 연결마다 바이트 틀 디코더 하나와 대기열 하나를 두고,
// 받은 봉투를 연결 판단(connections.ts)의 check → step으로 넘기고, 판단이 낸 것을 실행한다. 판단을 여기서 다시 만들지 않는다.
// 설명 문서는 server.md다.
//
// 이 파일이 지키는 것(그 밖은 connections.ts의 판단이다):
// - 연결 하나의 봉투는 받은 순서대로, 받은 시각(주입받은 시계를 바이트가 온 순간에 읽은 값)과 함께 넘긴다. 앞 봉투의 check가 끝나고
//   step이 돈 뒤에 다음 봉투의 check를 시작한다. 틀이 거절한 바이트는 판단에 닿지 않고 그 연결을 닫는다.
// - step은 await 뒤의 지금 연결 표에 건다. check를 시작한 때의 표에 걸면 그 사이 다른 연결이 바꾼 상태가 되돌아간다.
// - 답은 틀을 다 만든 뒤, 소켓의 쓰기 버퍼가 비었고 묶이지 않았을 때만, 넘기기 바로 앞에서 읽은 시각이 기한 정각 전이면 소켓에
//   넘긴다. 버퍼가 비지 않았으면 쥐고 기다리다 drain이나 tick에서 시각을 다시 읽는다. 기한 정각부터는 넘기지 않는다.
//   reply_sent는 로컬 쓰기가 오류 없이 끝난 것을 안 뒤에, 그때도 기한 정각 전이고 연결이 살아 있으면 넘긴 시각으로 한 번 넣는다.
//   쥐고 있거나 완료를 기다리는 동안 그 연결의 다음 판단은 기다린다. 넘긴 뒤 완료 전에 기한 정각의 tick이 오면 남은 쓰기를 버리고 끊는다.
// - 닫힘은 연결마다 한 번 closed로 알린다. closed를 넣는 길은 시계·복원기를 읽지 않는다. 닫힌 연결의 늦게 끝난 check 결과는 판단에 넘기지 않는다.
// - 등록표를 적용할 때마다 registry 사건을 넣고, 봉투마다 지금의 등록표를 check에 넘긴다(연결을 맺을 때의 키를 쥐지 않는다).
//
// 타이머를 두지 않는다. 시간이 흘러 생기는 판단(답·hello의 기한, 복원기가 바뀜)은 부르는 쪽이 tick()을 불러야 일어난다.
import type * as tls from "node:tls";
import type { NonceStore } from "../../contract/v1/index.ts";
import { createFrameDecoder, encodeFrame, type FrameDecoder, type FrameRejectReason } from "../../transport/framing.ts";
import { type MaterialRejectReason, type RawTlsMaterial, TlsMaterialError } from "../../transport/tls-policy.ts";
import {
  type Checked,
  type ConnectionSettings,
  Connections,
  type Event,
  type Output,
  type ReplyTools,
  type StepContext,
  type StopGenerationSource,
} from "./connections.ts";
import type { ApplyOutcome, RegistryInput, RegistryState } from "./registry.ts";
import { type CertifiedExecutorConnection, type ServerRejectReason, startTlsServer, type TlsServer } from "./tls-server.ts";

export interface ConnectionServerOptions {
  // 듣는 주소와 포트. 0이면 빈 포트를 고른다.
  readonly host: string;
  readonly port: number;
  readonly material: RawTlsMaterial;
  // 받은 시각, 답을 쓰는 시각과 쓰기를 마친 시각, 판단하는 시각, TLS 상대 인증서의 기간 판정에 모두 이 시계를 쓴다.
  readonly clock: () => number;
  // 시작할 때 믿는 등록표. 적용 전이면 RegistryState.start(설정)이다(아무도 믿지 않는다).
  readonly registry: RegistryState;
  // 부르는 순간의 복원기. check·step마다 새로 읽는다. 연결 표와 박자에 같은 객체를 넘기는 것은 부르는 쪽의 일이다.
  readonly restorer: () => StopGenerationSource;
  // 감독 장부가 아는 실행의 세대. 모르면 undefined.
  readonly runGeneration: (runId: string) => number | undefined;
  readonly nonces: NonceStore;
  // 맞춤 답의 서명과 요청 ID·nonce. 개인 키는 seal 안에 있고 이 모듈은 쥐지 않는다.
  readonly reply: ReplyTools;
  // connections.ts의 설정 그대로(동시 연결 상한, 재접속 제한, hello 대기). 틀리면 시작하지 않는다.
  readonly settings?: ConnectionSettings;
  // 판단의 출력 가운데 이 서버가 실행하지 않는 것. 부르는 쪽이 받아 처리한다. 던지면 그 연결을 닫는다.
  readonly deliver: (output: Delivered) => void;
  // 기록용. 던져도 무시한다.
  readonly observe?: (note: ServerNote) => void;
}

// 이 서버가 실행하는 출력(send_reply, close) 밖의 넷.
export type Delivered = Extract<Output, { readonly kind: "occupancy" | "candidate" | "withdrawn" | "forward" }>;

// 판단 밖에서 이 서버가 연결을 닫은 까닭.
export const LINK_CLOSE_CAUSES = [
  // 판단이 close를 냈다.
  "judgment",
  // 상대가 끊었거나 소켓 오류로 닫혔다.
  "peer",
  // 바이트 틀이 거절했다(사유는 note의 frame).
  "frame",
  // 답을 싣기 전에 받은 봉투가 답을 실은 뒤에 차례가 왔다. 계약의 순서에서는 그 사이에 실행기가 보낼 것이 없다.
  "before_reply",
  // check가 던졌다(nonce 저장소 오류 등). 검증 결과를 모른다.
  "check_failed",
  // step이 던졌다(복원기 읽기 오류 등). 판단 결과를 모른다.
  "judgment_failed",
  // 답을 바이트로 만들지 못했거나, 소켓에 넘기지 못했거나, 로컬 쓰기가 오류로 끝났거나, 끝났을 때 소켓이 이미 닫혔다.
  "write_failed",
  // 넘긴 답의 로컬 쓰기가 끝난 것을 안 때가 기한 정각 이후이거나, 완료 전에 기한 정각 이후의 tick이 왔다(남은 쓰기를 버리고 끊는다).
  // 상대가 받았을 수 있어도 기한 안에 답한 것으로 치지 않는다.
  "write_late",
  // 기한이 지나 답을 싣지 않았는데 판단이 그 연결을 닫지 않았다(판단이 정한 대로 tick을 넣은 뒤에도).
  "reply_late",
  // 부르는 쪽의 deliver가 던졌다. 그 출력이 처리됐는지 모른다.
  "deliver_failed",
  // 주입한 시계가 던졌다. 받은 시각, 넘길 시각, 쓰기를 마친 시각, tick에서 쥔 답·쓰기 대기의 기한을 볼 시각 가운데 하나를 모른다.
  "clock_failed",
  // 서버를 닫는다.
  "shutdown",
] as const;
export type LinkCloseCause = (typeof LINK_CLOSE_CAUSES)[number];

export type ServerNote =
  | { readonly kind: "opened"; readonly connection: number }
  | { readonly kind: "rejected_tls"; readonly reason: ServerRejectReason }
  | { readonly kind: "closed"; readonly connection: number; readonly cause: LinkCloseCause; readonly frame?: FrameRejectReason }
  // 판단이 낸 답을 기한이 지나 싣지 않았다.
  | { readonly kind: "reply_not_sent"; readonly connection: number; readonly deadline: number; readonly at: number }
  // 넘긴 답의 로컬 쓰기가 기한 전에 오류 없이 끝나 reply_sent를 넣는다. at은 넘긴 시각(reply_sent의 at), done은 끝난 것을 안 시각.
  | { readonly kind: "reply_written"; readonly connection: number; readonly at: number; readonly done: number }
  // 닫힌 연결의 check가 늦게 끝났다. 그 결과를 판단에 넘기지 않았다.
  | { readonly kind: "late_dropped"; readonly connection: number };

export type StartFailure =
  // connections.ts가 받지 않는 설정.
  | { readonly kind: "bad_settings"; readonly message: string }
  // 자기 TLS 재료로 시작할 수 없다(tls-server.ts가 던진 TlsMaterialError의 사유).
  | { readonly kind: "no_material"; readonly reason: MaterialRejectReason }
  // 듣지 못했다(포트 사용 중 등).
  | { readonly kind: "listen_failed"; readonly message: string };

export type StartResult = { readonly ok: true; readonly server: ConnectionServer } | { readonly ok: false; readonly failure: StartFailure };

export interface ConnectionServer {
  readonly port: number;
  // 지금의 연결 표. get·candidates·occupancy를 읽는 데 쓴다. 불변 값이라 받은 뒤 서버가 바꿔도 받은 값은 그대로다.
  table(): Connections;
  // 지금 믿는 등록표.
  registry(): RegistryState;
  // 등록표를 적용하고(바이트는 복사본으로), registry 사건을 넣어 더는 믿지 않는 연결을 닫는다. 적용의 결과를 그대로 돌려준다.
  applyRegistry(input: RegistryInput): ApplyOutcome;
  // 시간이 흘렀다. 판단의 tick을 넣는다(답·hello의 기한, 복원기가 바뀜).
  tick(): void;
  close(): Promise<void>;
}

export async function startConnectionServer(options: ConnectionServerOptions): Promise<StartResult> {
  let table: Connections;
  try {
    table = Connections.start(options.settings ?? {});
  } catch (error) {
    return { ok: false, failure: { kind: "bad_settings", message: messageOf(error) } };
  }
  const server = new Server(options, table);
  try {
    server.attach(
      await startTlsServer({
        host: options.host,
        port: options.port,
        material: options.material,
        now: options.clock,
        onConnection: (connection) => server.admit(connection),
        onRejected: (reason) => server.note({ kind: "rejected_tls", reason }),
      }),
    );
  } catch (error) {
    if (error instanceof TlsMaterialError) return { ok: false, failure: { kind: "no_material", reason: error.reason } };
    return { ok: false, failure: { kind: "listen_failed", message: messageOf(error) } };
  }
  return { ok: true, server };
}

interface Frame {
  readonly value: unknown;
  // 이 봉투의 마지막 바이트가 온 data 사건에서 읽은 시각.
  readonly at: number;
  // 이 연결에서 받은 차례(0부터).
  readonly index: number;
}

interface Link {
  readonly id: number;
  readonly socket: tls.TLSSocket;
  readonly decoder: FrameDecoder;
  readonly queue: Frame[];
  received: number;
  // 답을 소켓에 넘긴 때까지 받은 봉투의 수. 차례가 이보다 작은 봉투는 답을 넘기기 전에 받은 것이다. 넘기기 전이면 null.
  replyMark: number | null;
  // 소켓이 곧바로 받아 줄 수 없어 넘기지 않고 쥔 답. null이 아니면 이 연결의 다음 봉투를 판단에 넘기지 않는다.
  held: Held | null;
  // 넘긴 뒤 완료를 기다리는 답. null이 아니면 이 연결의 다음 봉투를 판단에 넘기지 않는다.
  writing: Writing | null;
  busy: boolean;
  dead: boolean;
}

interface Held {
  readonly frame: Uint8Array;
  readonly deadline: number;
}

interface Writing {
  // 소켓에 넘기기 바로 앞에서 읽은 시각. reply_sent의 at이다.
  readonly at: number;
  readonly deadline: number;
}

class Server implements ConnectionServer {
  private current: Connections;
  private trusted: RegistryState;
  private readonly links = new Map<number, Link>();
  private tls: TlsServer | null = null;
  private stopping = false;

  constructor(
    private readonly options: ConnectionServerOptions,
    table: Connections,
  ) {
    this.current = table;
    this.trusted = options.registry;
  }

  get port(): number {
    return this.tls?.port ?? 0;
  }

  attach(server: TlsServer): void {
    this.tls = server;
  }

  table(): Connections {
    return this.current;
  }

  registry(): RegistryState {
    return this.trusted;
  }

  note(note: ServerNote): void {
    try {
      this.options.observe?.(note);
    } catch {
      // 기록 실패는 연결의 판단에 영향을 주지 않는다.
    }
  }

  admit(connection: CertifiedExecutorConnection): void {
    const socket = connection.socket;
    const at = this.stopping ? null : this.now();
    // 판단에 열기 전이라 알릴 것이 없다.
    if (at === null) {
      socket.destroy();
      return;
    }
    const opened = this.current.open(connection.executor, at);
    this.current = opened.table;
    const link: Link = {
      id: opened.id,
      socket,
      decoder: createFrameDecoder(),
      queue: [],
      received: 0,
      replyMark: null,
      held: null,
      writing: null,
      busy: false,
      dead: false,
    };
    this.links.set(link.id, link);
    this.note({ kind: "opened", connection: link.id });
    // 판단에 알리지 않은 닫힘이 없게 한다. 오류는 tls-server.ts가 destroy로 바꾸고, destroy는 close 사건으로 온다.
    // 상대가 보내기만 끝낸 반쪽 닫힘(end)도 그 자리에서 닫는다. 반쪽 연결을 붙들어 두는 동작이 런타임마다 달라도 판단이 같은 때 안다.
    socket.on("end", () => this.closeLink(link, "peer"));
    socket.on("close", () => this.closeLink(link, "peer"));
    socket.on("data", (chunk: Buffer) => this.receive(link, chunk));
    // 쓰기 버퍼가 비우기를 기다리다 빈 때. 쥔 답이 있으면 그 자리에서 기한을 다시 읽는다. drain이 오지 않는 비기는 tick이 본다.
    socket.on("drain", () => this.offer(link));
    if (socket.destroyed) this.closeLink(link, "peer");
    this.run(opened.outputs);
  }

  private receive(link: Link, chunk: Buffer): void {
    if (link.dead) return;
    // 받은 시각은 바이트가 온 이 순간에 읽는다. 검증을 기다린 뒤의 시각이 아니다.
    const at = this.now();
    if (at === null) return this.closeLink(link, "clock_failed");
    const step = link.decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    for (const envelope of step.envelopes) link.queue.push({ value: envelope.value, at, index: link.received++ });
    // 틀이 어긋난 연결은 닫는다. 같은 조각에서 앞서 자른 봉투도 판단에 넘기지 않는다(닫힌 연결의 봉투는 판단이 쓰지 않는다).
    if (step.rejected !== null) return this.closeLink(link, "frame", step.rejected);
    void this.pump(link);
  }

  // 연결 하나의 봉투를 차례대로 하나씩 판단에 넘긴다. 한 연결에 하나만 돈다. 답을 쥐고 있거나 쓰기의 완료를 기다리는 동안은
  // 멈추고, 완료를 처리한 뒤 다시 부른다.
  private async pump(link: Link): Promise<void> {
    if (link.busy) return;
    link.busy = true;
    try {
      while (!link.dead && link.held === null && link.writing === null && link.queue.length > 0) {
        const frame = link.queue.shift()!;
        if (link.replyMark !== null && frame.index < link.replyMark) return this.closeLink(link, "before_reply");
        let checked: Checked;
        try {
          // 등록표·복원기는 check를 부르는 이 순간의 것이다.
          checked = await this.current.check(link.id, frame.value, {
            now: frame.at,
            registry: this.trusted,
            stop: this.restorer(),
            runGeneration: this.options.runGeneration,
            nonces: this.options.nonces,
          });
        } catch {
          return this.closeLink(link, "check_failed");
        }
        if (link.dead) {
          this.note({ kind: "late_dropped", connection: link.id });
          return;
        }
        this.step({ kind: "envelope", checked }, link);
      }
    } finally {
      link.busy = false;
    }
  }

  private now(): number | null {
    try {
      return this.options.clock();
    } catch {
      return null;
    }
  }

  // 복원기를 읽지 못하면 세대를 모르는 복원기를 넘긴다. 판단은 세대를 모르면 맞춤에 답하지 않고 인정한 연결을 restore_changed로 닫는다.
  private restorer(): StopGenerationSource {
    try {
      return this.options.restorer();
    } catch {
      return UNKNOWN_GENERATION;
    }
  }

  // 지금의 연결 표에 사건 하나를 넣고 낸 것을 실행한다. 판단이 던지면 결과를 모르므로 닫는다:
  // 연결 하나의 사건이면 그 연결, 아니면(tick, registry) 열린 연결 전부.
  private step(event: Event, link?: Link): void {
    let result: ReturnType<Connections["step"]>;
    try {
      result = this.current.step(event, event.kind === "closed" ? this.closedContext() : this.context(), this.options.reply);
    } catch {
      if (link) return this.closeLink(link, "judgment_failed");
      for (const each of [...this.links.values()]) this.closeLink(each, "judgment_failed");
      return;
    }
    this.current = result.table;
    this.run(result.outputs);
  }

  private context(): StepContext {
    return { now: this.options.clock(), registry: this.trusted, stop: this.restorer() };
  }

  // 판단의 닫힘 처리는 연결 번호만 쓴다. 여기서 시계·복원기를 읽으면 그 읽기가 던질 때 closed가 판단에 들어가지 않아
  // 끊긴 실행기가 후보와 점유에 남는다. 아래 두 칸은 채우기 위한 값이다: 지금의 닫힘 처리가 읽지 않는다(시험이 지킨다).
  private closedContext(): StepContext {
    return { now: Number.NaN, registry: this.trusted, stop: UNKNOWN_GENERATION };
  }

  private run(outputs: readonly Output[]): void {
    for (const output of outputs) {
      switch (output.kind) {
        case "send_reply":
          this.sendReply(output);
          break;
        case "close": {
          const link = this.links.get(output.connection);
          if (link) this.closeLink(link, "judgment");
          break;
        }
        case "withdrawn":
          // 닫힌 연결의 정리이므로 그 연결이 이미 닫혔어도 넘긴다.
          this.hand(output);
          break;
        default:
          // 같은 출력 묶음의 앞 전달이 던져 이 연결을 닫았으면 남은 후보·점유·전달은 넘기지 않는다.
          if (this.links.has(output.connection)) this.hand(output);
      }
    }
  }

  private hand(output: Delivered): void {
    try {
      this.options.deliver(output);
    } catch {
      const link = this.links.get(output.connection);
      if (link) this.closeLink(link, "deliver_failed");
    }
  }

  private sendReply(output: Extract<Output, { kind: "send_reply" }>): void {
    const link = this.links.get(output.connection);
    if (!link || link.dead) return;
    const frame = frameOf(output.envelope);
    if (frame === null) return this.closeLink(link, "write_failed");
    link.held = { frame, deadline: output.deadline };
    this.offer(link);
  }

  // 쥔 답을 소켓에 넘길 수 있으면 넘긴다. sendReply, 소켓의 drain, tick()에서 부른다.
  private offer(link: Link): void {
    const held = link.held;
    if (held === null || link.dead) return;
    // 기한은 틀을 다 만든 뒤 넘기기 바로 앞에서 읽은 시각으로 판정한다. 이 읽기와 write 사이에 시간이 드는 일을 두지 않는다.
    const at = this.now();
    if (at === null) return this.closeLink(link, "clock_failed");
    if (!(at < held.deadline)) {
      link.held = null;
      return this.late(link, held.deadline, at);
    }
    if (link.socket.destroyed || !link.socket.writable) return this.closeLink(link, "write_failed");
    // 버퍼에 앞선 바이트가 있거나 묶여 있으면 넘긴 답이 그 뒤에서 기다리다 기한 정각 이후에 나갈 수 있고, 넘긴 바이트는 되돌릴 수 없다.
    // 그래서 넘기지 않고 쥔다. 버퍼가 비면 drain이나 다음 tick에서 이 자리로 다시 와 시각을 읽는다.
    if (!idle(link.socket)) return;
    link.held = null;
    // write의 반환값(false)은 버퍼가 찼다는 뜻일 뿐 실패가 아니고, true도 내보냈다는 뜻이 아니다. 완료 콜백으로만 가른다.
    const writing: Writing = { at, deadline: held.deadline };
    link.writing = writing;
    link.replyMark = link.received;
    try {
      link.socket.write(held.frame, (error) => this.written(link, writing, error));
    } catch {
      this.closeLink(link, "write_failed");
    }
  }

  // 기한 정각부터는 넘기지 않는다. 판단에는 시간이 흘렀다는 사건(tick)만 넣는다. 판단이 그 연결을 answer_late로 닫는다.
  private late(link: Link, deadline: number, at: number): void {
    this.note({ kind: "reply_not_sent", connection: link.id, deadline, at });
    this.step({ kind: "tick" });
    if (!link.dead && this.current.get(link.id)?.phase === "requested") this.closeLink(link, "reply_late");
  }

  // 넘긴 답의 완료를 기다리는 연결에 기한 정각 이후의 박자가 왔다. 완료를 기다리지 않고 소켓을 파기해 남은 쓰기를 버린다.
  // 이미 하위 쓰기로 나간 바이트는 되돌리지 못한다(server.md의 남는 한계).
  private overdue(link: Link, writing: Writing): void {
    const at = this.now();
    if (at === null) return this.closeLink(link, "clock_failed");
    if (!(at < writing.deadline)) this.closeLink(link, "write_late");
  }

  // 답의 로컬 쓰기가 끝났다. 오류 없이 끝났고, 그때도 기한 정각 전이고, 연결이 살아 있을 때만 reply_sent를 한 번 넣는다.
  // 넣는 시각은 넘긴 시각이다: 그보다 먼저 받은 봉투는 답을 보고 쓴 것이 아니다. 완료 쪽 시각을 쓰면 완료 콜백보다
  // 먼저 도착한 정상 hello가 답보다 앞선 것으로 판정된다. 완료 쪽 시각은 기록(reply_written)에만 남긴다.
  private written(link: Link, writing: Writing, error: Error | null | undefined): void {
    if (link.dead || link.writing !== writing) return;
    link.writing = null;
    if (error) return this.closeLink(link, "write_failed");
    if (link.socket.destroyed) return this.closeLink(link, "write_failed");
    const done = this.now();
    if (done === null) return this.closeLink(link, "clock_failed");
    if (!(done < writing.deadline)) return this.closeLink(link, "write_late");
    this.note({ kind: "reply_written", connection: link.id, at: writing.at, done });
    this.step({ kind: "reply_sent", connection: link.id, at: writing.at }, link);
    // 기다리는 동안 받은 봉투를 이어서 넘긴다. pump가 이미 돌고 있으면(완료가 write 안에서 불렸으면) 그쪽이 잇는다.
    void this.pump(link);
  }

  // 소켓을 닫고 판단에 closed를 한 번 알린다. 대기열을 비우고, 진행 중인 check의 결과는 pump가 버린다.
  private closeLink(link: Link, cause: LinkCloseCause, frame?: FrameRejectReason): void {
    if (link.dead) return;
    link.dead = true;
    link.queue.length = 0;
    link.held = null;
    this.links.delete(link.id);
    link.socket.destroy();
    this.note(frame === undefined ? { kind: "closed", connection: link.id, cause } : { kind: "closed", connection: link.id, cause, frame });
    this.step({ kind: "closed", connection: link.id }, link);
  }

  applyRegistry(input: RegistryInput): ApplyOutcome {
    const outcome = this.trusted.apply(copyInput(input));
    this.trusted = outcome.state;
    this.step({ kind: "registry" });
    return outcome;
  }

  // 판단의 tick보다 먼저 쥔 답과 완료를 기다리는 답을 본다. 쥔 답은 버퍼가 비었으면 넘기고 기한이 지났으면 늦은 답으로,
  // 완료를 기다리는 답은 기한이 지났으면 write_late로 끊는다(판단의 answer_late보다 사유가 정확하다).
  tick(): void {
    for (const link of [...this.links.values()]) {
      // 앞 연결의 늦은 답이 넣은 tick이 이 연결을 이미 닫았을 수 있다.
      if (link.dead) continue;
      if (link.held !== null) this.offer(link);
      else if (link.writing !== null) this.overdue(link, link.writing);
    }
    this.step({ kind: "tick" });
  }

  async close(): Promise<void> {
    this.stopping = true;
    for (const link of [...this.links.values()]) this.closeLink(link, "shutdown");
    await this.tls?.close();
  }
}

const UNKNOWN_GENERATION: StopGenerationSource = Object.freeze({ stopGeneration: () => null });

// 넘긴 바이트가 앞선 바이트를 기다리지 않고 곧바로 하위 쓰기로 가는 상태: 쓰기 버퍼가 비었고, 비우기를 기다리지 않고, 묶이지 않았다.
// 하위 쓰기 아래(TLS·커널·네트워크)에서 밀리는 것은 여기서 보이지 않는다.
function idle(socket: tls.TLSSocket): boolean {
  return socket.writableLength === 0 && !socket.writableNeedDrain && socket.writableCorked === 0;
}

// 부르는 쪽이 넘긴 바이트 배열을 적용 뒤에 다시 쓰거나 바꿔도 이 서버가 적용한 판과 섞이지 않게 복사한다.
// 복사가 던지면(소유권이 넘어가 분리된 배열 등) 바이트를 얻지 못한 것이므로 읽을 수 없는 판으로 적용한다.
function copyInput(input: RegistryInput): RegistryInput {
  if (input === null || typeof input !== "object" || input.kind !== "content") return input;
  if (typeof input.content === "string") return input;
  try {
    return { kind: "content", content: new Uint8Array(input.content) };
  } catch {
    return { kind: "unreadable" };
  }
}

function frameOf(envelope: unknown): Uint8Array | null {
  try {
    const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(envelope)));
    return encoded.ok ? encoded.frame : null;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
