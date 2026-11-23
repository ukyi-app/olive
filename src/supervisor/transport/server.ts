// 감독이 실행기의 연결을 받는 서버. tls-server.ts가 넘긴 인증된 연결마다 바이트 틀 디코더 하나와 대기열 하나를 두고,
// 받은 봉투를 연결 판단(connections.ts)의 check → step으로 넘기고, 판단이 낸 것을 실행한다. 판단을 여기서 다시 만들지 않는다.
// 설명 문서는 server.md다.
//
// 이 파일이 지키는 것(그 밖은 connections.ts의 판단이다):
// - 연결 하나의 봉투는 받은 순서대로, 받은 시각(주입받은 시계를 바이트가 온 순간에 읽은 값)과 함께 넘긴다. 앞 봉투의 check가 끝나고
//   step이 돈 뒤에 다음 봉투의 check를 시작한다. 틀이 거절한 바이트는 판단에 닿지 않고 그 연결을 닫는다.
// - step은 await 뒤의 지금 연결 표에 건다. check를 시작한 때의 표에 걸면 그 사이 다른 연결이 바꾼 상태가 되돌아간다.
// - 답은 틀을 다 만든 뒤 소켓의 쓰기 버퍼를 보고, 그다음 시계를 읽고, 곧바로 소켓에 넘긴다. 버퍼가 비지 않았거나 묶였으면
//   넘기지 않고 그 연결을 write_busy로 닫는다(답을 쥐고 기다리지 않는다). 읽은 시각이 기한 정각 이후면 넘기지 않는다.
//   reply_sent는 로컬 쓰기가 오류 없이 끝난 것을 안 뒤에, 그때도 기한 정각 전이고 연결이 살아 있으면 넘긴 시각으로 한 번 넣는다.
//   완료를 기다리는 동안 그 연결의 다음 판단은 기다린다. 완료 전에 기한 정각 이후의 tick이 오면 남은 쓰기를 버리고 끊는다.
// - 닫힘은 연결마다 한 번 closed로 알린다. closed를 넣는 길은 시계·복원기를 읽지 않는다. 닫힌 연결의 늦게 끝난 check 결과는 판단에 넘기지 않는다.
// - 등록표를 적용할 때마다 registry 사건을 넣고, 봉투마다 지금의 등록표를 check에 넘긴다(연결을 맺을 때의 키를 쥐지 않는다).
// - writeFrame은 지금 인정된 그 주체의 연결에만, 부르는 쪽이 이미 만든 틀 하나를 한 번의 write로 넘긴다. 서버의 확인을 모두 마친 뒤
//   부르는 쪽의 lastCheck를 부르고 곧바로 write한다. 줄을 두지 않는다: 묶였거나 대기량이 상한을 넘으면 넘기지 않고 그 연결을 닫는다.
//   넘긴 틀마다 settled를 로컬 쓰기가 끝났을 때 또는 그 전에 연결이 닫혔을 때 정확히 한 번 부른다.
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
  // writeFrame이 넘기려는 때 그 소켓의 쓰기 대기량(writableLength)에 그 틀을 더한 값의 상한(바이트, 정각 포함 허용).
  // 기본값이 없다: 진입점이 정해 넣는다. 양의 정수가 아니면 시작하지 않는다(bad_settings).
  readonly maxPendingWriteBytes: number;
}

// writeFrame에 넘기는 부르는 쪽의 두 함수.
export interface WriteFrameOptions {
  // 서버가 자기 확인을 모두 마친 뒤, write 바로 앞에서 한 번 부른다. 동기다. null이면 쓴다. 문자열이면 쓰지 않고 그 이름을 돌려준다.
  // 시계·정지 세대·접수처럼 부르는 쪽만 아는 조건을 여기서 본다. 그 안에서 기다리거나 이 서버를 다시 부르지 않는다.
  readonly lastCheck: () => string | null;
  // 넘긴 틀의 끝. 로컬 쓰기가 끝났을 때(성공·오류) 또는 그 전에 연결이 닫혔을 때 정확히 한 번 부른다. 넘기지 않은 틀에는 부르지 않는다.
  // 던져도 서버의 상태는 바뀌지 않는다.
  readonly settled: (end: SendEnd) => void;
}

export type SendEnd =
  // 로컬 쓰기가 오류 없이 끝났다. 상대가 받았다는 뜻이 아니다.
  | "flushed"
  // 로컬 쓰기가 오류로 끝났거나 write가 던졌다. 그 연결은 send_failed로 닫혔다.
  | "failed"
  // 로컬 쓰기가 끝나기 전에 연결이 닫혔다. 소켓을 파기해 아직 하위 쓰기로 가지 않은 바이트를 버렸다.
  | "closed";

// writeFrame이 넘기지 않은 까닭. 모두 넘긴 바이트 0이고 settled를 부르지 않는다.
export const NOT_WRITTEN_REASONS = [
  // 그 번호의 연결이 없거나(번호 없음, 이미 닫혀 빠짐), 지금의 복원기로 맞춰 인사까지 끝난 연결이 아니거나, 맞춤의 주체가 다르다.
  // 같은 주체의 인정된 연결이 둘 이상으로 보이는 때도 여기다(누구인지 모른다).
  "not_recognized",
  // 소켓이 이미 파기됐거나 쓸 수 없다, 또는 lastCheck를 부르는 사이 그 연결이 닫혔다. 이 까닭으로는 연결을 닫지 않는다(이미 닫히는 중이다).
  "closed",
  // 스트림이 묶였거나 쓰기 대기량에 이 틀을 더하면 상한을 넘는다. 그 연결을 send_backlog로 닫았다.
  "backlog",
  // lastCheck가 쓰지 말라고 답했다. 그 이름은 refusal에 있다. 연결은 그대로다.
  "refused",
  // lastCheck가 던졌거나 null도 문자열도 아닌 값을 냈다. 부르는 쪽의 잘못이라 연결은 그대로다.
  "check_failed",
  // 다른 writeFrame의 lastCheck 안에서 불렸다. 바깥 쓰기의 대기량 확인이 낡지 않게 받지 않는다.
  "reentered",
] as const;
export type NotWrittenReason = (typeof NOT_WRITTEN_REASONS)[number];

export type WriteFrameResult =
  // 틀 전부를 한 번의 write로 스트림에 넘겼다. 상대가 받았다는 뜻이 아니다. settled가 뒤에 정확히 한 번 불린다.
  | { readonly kind: "written" }
  | { readonly kind: "not_written"; readonly reason: Exclude<NotWrittenReason, "refused"> }
  | { readonly kind: "not_written"; readonly reason: "refused"; readonly refusal: string }
  // write가 던졌다. 넘긴 바이트가 있는지 모른다. 그 연결을 send_failed로 닫았고 settled("failed")를 한 번 불렀다.
  | { readonly kind: "unknown" };

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
  // step이 던졌거나 tick()의 시각을 읽지 못했다. 판단 결과를 모른다.
  "judgment_failed",
  // 답을 바이트로 만들지 못했거나, 소켓에 넘기지 못했거나, 로컬 쓰기가 오류로 끝났거나, 끝났을 때 소켓이 이미 닫혔다.
  "write_failed",
  // 답을 넘기려는 때 소켓의 쓰기 버퍼가 비지 않았거나 묶여 있었다. 넘기지 않았다(넘긴 바이트 0).
  "write_busy",
  // 넘긴 답의 로컬 쓰기가 끝난 것을 안 때가 기한 정각 이후이거나, 완료 전에 기한 정각 이후의 tick이 왔다(남은 쓰기를 버리고 끊는다).
  // 상대가 받았을 수 있어도 기한 안에 답한 것으로 치지 않는다.
  "write_late",
  // 기한이 지나 답을 싣지 않았는데 판단이 그 연결을 닫지 않았다(판단이 정한 대로 tick을 넣은 뒤에도).
  "reply_late",
  // 부르는 쪽의 deliver가 던졌다. 그 출력이 처리됐는지 모른다.
  "deliver_failed",
  // 주입한 시계가 던졌다. 받은 시각, 넘길 시각, 쓰기를 마친 시각 가운데 하나를 모른다.
  "clock_failed",
  // writeFrame이 넘기려는 때 스트림이 묶였거나 쓰기 대기량에 그 틀을 더하면 상한을 넘었다. 넘기지 않았다(그 틀의 바이트 0).
  "send_backlog",
  // writeFrame으로 넘긴 틀의 로컬 쓰기가 오류로 끝났거나 write가 던졌다.
  "send_failed",
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
  // 시간이 흘렀다. 판단의 tick을 넣는다(답·hello의 기한, 복원기가 바뀜). writeFrame으로 넘긴 틀의 완료 대기는 만료하지 않는다.
  tick(): void;
  // 지금 인정된 그 주체의 연결 번호: 부르는 순간의 복원기로 맞춰 인사까지 끝났고 그 복원기가 세대를 알며 서버가 아직 닫지 않은 연결.
  // 없거나 둘 이상이면 null. 동기이고 캐시하지 않는다.
  recognized(principal: string): number | null;
  // 인정된 연결 하나에 부르는 쪽이 이미 만든 틀 하나를 넘긴다. 기다리지 않고, 넘기지 못한 틀을 쥐었다가 뒤에 쓰지 않는다.
  writeFrame(connection: number, principal: string, frame: Uint8Array, options: WriteFrameOptions): WriteFrameResult;
  close(): Promise<void>;
}

export async function startConnectionServer(options: ConnectionServerOptions): Promise<StartResult> {
  const limit = options.maxPendingWriteBytes;
  if (!Number.isSafeInteger(limit) || limit <= 0) return { ok: false, failure: { kind: "bad_settings", message: "maxPendingWriteBytes는 양의 정수다" } };
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
  // 넘긴 뒤 완료를 기다리는 답. null이 아니면 이 연결의 다음 봉투를 판단에 넘기지 않는다.
  writing: Writing | null;
  // writeFrame으로 넘긴 뒤 끝을 알리지 않은 틀. 완료 콜백이나 닫힘 가운데 먼저 온 쪽이 빼고 settled를 부른다.
  readonly sends: Set<Send>;
  busy: boolean;
  dead: boolean;
}

interface Send {
  readonly settled: (end: SendEnd) => void;
  // 끝을 이미 알렸다. 뒤에 온 완료 콜백이나 닫힘은 settled를 다시 부르지 않는다.
  done: boolean;
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
  // writeFrame의 lastCheck를 부르는 중이다.
  private checking = false;

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
      writing: null,
      sends: new Set(),
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

  // 연결 하나의 봉투를 차례대로 하나씩 판단에 넘긴다. 한 연결에 하나만 돈다. 답 쓰기의 완료를 기다리는 동안은 멈추고,
  // 완료를 처리한 뒤 다시 부른다.
  private async pump(link: Link): Promise<void> {
    if (link.busy) return;
    link.busy = true;
    try {
      while (!link.dead && link.writing === null && link.queue.length > 0) {
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
  // 연결 하나의 사건이면 그 연결, 아니면(tick, registry) 열린 연결 전부. now를 주면 판단 시각으로 시계 대신 그 값을 쓴다.
  private step(event: Event, link?: Link, now?: number): void {
    let result: ReturnType<Connections["step"]>;
    try {
      result = this.current.step(event, event.kind === "closed" ? this.closedContext() : this.context(now), this.options.reply);
    } catch {
      if (link) return this.closeLink(link, "judgment_failed");
      return this.failAll();
    }
    this.current = result.table;
    this.run(result.outputs);
  }

  private failAll(): void {
    for (const each of [...this.links.values()]) this.closeLink(each, "judgment_failed");
  }

  private context(now?: number): StepContext {
    return { now: now ?? this.options.clock(), registry: this.trusted, stop: this.restorer() };
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

  // 순서가 보장 2다: 틀 → 소켓의 관측(닫힘, 쓰기 버퍼) → 시계 → write. 기한은 마지막 시계 읽기로 판정하므로 그 읽기와
  // write 사이에 소켓의 접근자·다른 시계 읽기·대기를 두지 않는다(그 사이에 흐른 시간은 판정에 들지 않는다).
  private sendReply(output: Extract<Output, { kind: "send_reply" }>): void {
    const link = this.links.get(output.connection);
    if (!link || link.dead) return;
    const deadline = output.deadline;
    const frame = frameOf(output.envelope);
    if (frame === null) return this.closeLink(link, "write_failed");
    const socket = link.socket;
    if (socket.destroyed || !socket.writable) return this.closeLink(link, "write_failed");
    // 버퍼에 앞선 바이트가 있거나 묶여 있으면 넘긴 답이 그 뒤에서 기다리다 기한 정각 이후에 나갈 수 있고, 넘긴 바이트는 되돌릴 수 없다.
    // 넘기지 않고 닫는다. 실행기는 닫힌 연결에서 다시 붙어 맞춘다.
    if (!idle(socket)) return this.closeLink(link, "write_busy");
    const mark = link.received;
    const at = this.now();
    if (at === null) return this.closeLink(link, "clock_failed");
    if (!(at < deadline)) return this.late(link, deadline, at);
    // write의 반환값(false)은 버퍼가 찼다는 뜻일 뿐 실패가 아니고, true도 내보냈다는 뜻이 아니다. 완료 콜백으로만 가른다.
    const writing: Writing = { at, deadline };
    link.writing = writing;
    link.replyMark = mark;
    try {
      socket.write(frame, (error) => this.written(link, writing, error));
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
  // 끝을 알리지 않은 틀은 파기 앞에서 끝난 것으로 표시하고(파기가 완료 콜백을 부르는 시점과 상관없이 끝은 closed다),
  // 판단과 서버의 상태를 다 바꾼 뒤에 settled를 부른다.
  private closeLink(link: Link, cause: LinkCloseCause, frame?: FrameRejectReason): void {
    if (link.dead) return;
    link.dead = true;
    link.queue.length = 0;
    this.links.delete(link.id);
    const unsettled = [...link.sends];
    link.sends.clear();
    for (const send of unsettled) send.done = true;
    link.socket.destroy();
    this.note(frame === undefined ? { kind: "closed", connection: link.id, cause } : { kind: "closed", connection: link.id, cause, frame });
    this.step({ kind: "closed", connection: link.id }, link);
    for (const send of unsettled) settle(send, "closed");
  }

  recognized(principal: string): number | null {
    let ids: number[];
    try {
      ids = this.current.candidates(this.restorer()).map((candidate) => candidate.connection);
    } catch {
      // 복원기의 stopGeneration()이 던졌다. 세대를 모르는 복원기와 같이 아무 연결도 인정하지 않는다.
      return null;
    }
    const found = ids.filter((id) => {
      const link = this.links.get(id);
      return link !== undefined && !link.dead && link.writing === null && this.current.get(id)?.sync?.principal === principal;
    });
    return found.length === 1 ? found[0]! : null;
  }

  // 순서가 보장 2다: 서버의 확인(인정, 소켓의 닫힘, 묶임과 대기량) → lastCheck → write. lastCheck가 쓴다고 답한 뒤 write까지는
  // 자기 기록(lastCheck의 답, link.dead, 보낼 틀의 기록)만 보고 대입한다. 소켓의 접근자·시계·대기·다른 콜백이 없다.
  writeFrame(connection: number, principal: string, frame: Uint8Array, options: WriteFrameOptions): WriteFrameResult {
    // 부르는 쪽 객체의 접근자가 lastCheck와 write 사이에서 불리지 않게 두 함수를 먼저 꺼낸다.
    const { lastCheck, settled } = options;
    if (this.checking) return { kind: "not_written", reason: "reentered" };
    if (this.recognized(principal) !== connection) return { kind: "not_written", reason: "not_recognized" };
    const link = this.links.get(connection)!;
    const socket = link.socket;
    if (socket.destroyed || !socket.writable) return { kind: "not_written", reason: "closed" };
    // 줄을 두지 않는다. 상한 안이면 앞선 바이트 뒤에 붙인다(차례는 스트림이 지킨다). 묶였거나 상한을 넘으면 쥐고 기다리지 않고 닫는다.
    if (socket.writableCorked !== 0 || socket.writableLength + frame.byteLength > this.options.maxPendingWriteBytes) {
      this.closeLink(link, "send_backlog");
      return { kind: "not_written", reason: "backlog" };
    }
    let verdict: unknown;
    this.checking = true;
    try {
      verdict = lastCheck();
    } catch {
      return { kind: "not_written", reason: "check_failed" };
    } finally {
      this.checking = false;
    }
    if (verdict !== null) return typeof verdict === "string" ? { kind: "not_written", reason: "refused", refusal: verdict } : { kind: "not_written", reason: "check_failed" };
    // lastCheck가 서버를 다시 불러 이 연결을 닫았으면 넘기지 않는다(자기 기록이다).
    if (link.dead) return { kind: "not_written", reason: "closed" };
    const send: Send = { settled, done: false };
    link.sends.add(send);
    try {
      // 틀 하나를 통째로 한 번에 넘긴다. 반환값(false는 버퍼가 찼다는 뜻)으로 가르지 않고 완료 콜백과 닫힘으로만 끝을 안다.
      socket.write(frame, (error) => this.sent(link, send, error));
    } catch {
      // 넘긴 바이트가 있는지 모른다. 닫아서 남은 바이트를 버린 뒤 끝을 한 번 알린다. 뒤에 완료 콜백이 와도 다시 부르지 않는다.
      send.done = true;
      link.sends.delete(send);
      this.closeLink(link, "send_failed");
      settle(send, "failed");
      return { kind: "unknown" };
    }
    return { kind: "written" };
  }

  // writeFrame으로 넘긴 틀의 로컬 쓰기가 끝났다. 닫힘이 먼저 끝을 알렸으면 아무것도 하지 않는다.
  private sent(link: Link, send: Send, error: Error | null | undefined): void {
    if (send.done) return;
    send.done = true;
    link.sends.delete(send);
    if (error) this.closeLink(link, "send_failed");
    settle(send, error ? "failed" : "flushed");
  }

  applyRegistry(input: RegistryInput): ApplyOutcome {
    const outcome = this.trusted.apply(copyInput(input));
    this.trusted = outcome.state;
    this.step({ kind: "registry" });
    return outcome;
  }

  // 박자의 시각은 한 번 읽어 완료 대기의 만료와 판단의 tick에 함께 쓴다. 그 읽기가 던지면 판단의 tick이 던진 때와 같이
  // 열린 연결을 모두 닫는다: 어느 한 연결의 읽기 실패로 받으면 나머지 연결이 이 박자의 판단을 건너뛴 채 남는다.
  // 완료 대기의 만료를 판단의 tick보다 먼저 본다. 판단이 먼저면 그 연결이 answer_late(judgment)로 닫혀 쓰기의 만료가 가려진다.
  tick(): void {
    const at = this.now();
    if (at === null) return this.failAll();
    for (const link of [...this.links.values()]) {
      // 완료를 기다리지 않고 소켓을 파기해 남은 쓰기를 버린다. 이미 하위 쓰기로 나간 바이트는 되돌리지 못한다(server.md의 남는 한계).
      if (!link.dead && link.writing !== null && !(at < link.writing.deadline)) this.closeLink(link, "write_late");
    }
    this.step({ kind: "tick" }, undefined, at);
  }

  async close(): Promise<void> {
    this.stopping = true;
    for (const link of [...this.links.values()]) this.closeLink(link, "shutdown");
    await this.tls?.close();
  }
}

const UNKNOWN_GENERATION: StopGenerationSource = Object.freeze({ stopGeneration: () => null });

// 부르는 쪽의 정리(예: 보낸 버퍼를 0으로 채우기)가 던져도 연결과 서버의 상태에 영향을 주지 않는다.
function settle(send: Send, end: SendEnd): void {
  try {
    send.settled(end);
  } catch {
    // 끝은 이미 알렸다. 다시 부르지 않는다.
  }
}

// 넘긴 바이트가 앞선 바이트를 기다리지 않고 곧바로 하위 쓰기로 가는 상태: 쓰기 버퍼가 비었고, 비우기를 기다리지 않고, 묶이지 않았다.
// 하위 쓰기 아래(TLS·커널·네트워크)에서 밀리는 것은 여기서 보이지 않는다. 이 서버는 맞춤의 답 전에 소켓에 쓰는 것이 없으므로
// 갓 받은 연결은 이 상태다.
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
