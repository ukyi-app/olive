// 감독 쪽 상호 TLS 수신. 클라이언트 인증서를 요구하고, ../../transport/tls-policy.ts의 판정을 통과한 연결만 위로 넘긴다.
// 실행기 쪽 모듈은 이 파일을 import하지 않는다(실행기는 듣지 않는다, D-55).
// 인증서·키·신뢰 묶음은 시작할 때 바이트로 한 번 받는다. 파일을 읽는 것은 부르는 쪽(진입점)의 일이다.
//
// 위로 넘기는 신원은 인증서가 증명한 배포 대상(네임스페이스·대상 id)까지다. 등록된 실행기가 아니다.
// 등록표 대조, 정지 세대 맞춤, hello, 점유는 뒤 작업이 이 연결 위에서 한다.
import * as tls from "node:tls";
import {
  type PeerRejectReason,
  type RawTlsMaterial,
  type TlsDeploymentIdentity,
  type TlsMaterial,
  TlsMaterialError,
  checkPeer,
  prepareMaterial,
  readPeerCertificate,
} from "../../transport/tls-policy.ts";

export interface TlsServerOptions {
  // 듣는 주소와 포트. 0이면 빈 포트를 고른다.
  readonly host: string;
  readonly port: number;
  readonly material: RawTlsMaterial;
  readonly now: () => number;
  // 판정을 통과한 연결만 온다.
  readonly onConnection: (connection: CertifiedExecutorConnection) => void;
  // 핸드셰이크 뒤 판정에서 버린 연결의 사유(기록용). 핸드셰이크 자체에서 끊긴 것은 tlsClientError로만 보인다.
  readonly onRejected?: (reason: ServerRejectReason) => void;
}

// 인증서가 증명한 실행기 배포 대상과 그 연결. 등록된 실행기라는 뜻이 아니다.
export interface CertifiedExecutorConnection {
  readonly socket: tls.TLSSocket;
  readonly executor: Extract<TlsDeploymentIdentity, { kind: "executor" }>;
  readonly peerNotAfter: number;
}

export type ServerRejectReason = PeerRejectReason | "no_material";

export interface TlsServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startTlsServer(options: TlsServerOptions): Promise<TlsServer> {
  const first = prepareMaterial(options.material, "supervisor", options.now());
  if (!first.ok) throw new TlsMaterialError(first.reason);
  const server = new Server(options, first.material);
  await server.listen();
  return server;
}

class Server implements TlsServer {
  // 핸드셰이크를 마친 연결 전부(위로 넘긴 것과 판정 중인 것). close()가 모두 닫는다.
  private readonly sockets = new Set<tls.TLSSocket>();
  private readonly server: tls.Server;
  private closed = false;
  port = 0;

  constructor(
    private readonly options: TlsServerOptions,
    private readonly material: TlsMaterial,
  ) {
    this.server = tls.createServer({
      key: material.privateKeyPem,
      cert: material.certificatePem,
      ca: material.trustBundlePem,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    });
    this.server.on("secureConnection", (socket) => this.admit(socket));
    // 핸드셰이크에서 끊긴 상대(인증서 없음, 다른 발급 기관, 반대 용도)는 여기로 온다. 위로 올라가지 않는다.
    this.server.on("tlsClientError", (_error, socket) => socket.destroy());
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        const address = this.server.address();
        this.port = typeof address === "object" && address ? address.port : 0;
        resolve();
      });
    });
  }

  private admit(socket: tls.TLSSocket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const now = this.options.now();
    if (this.closed || this.material.notAfter <= now) return this.refuse(socket, "no_material");
    const peer = readPeerCertificate(socket.authorized, rawOf(socket.getPeerCertificate()), this.material.trust);
    const verdict = checkPeer(peer, { role: "executor" }, now);
    if (!verdict.ok) return this.refuse(socket, verdict.reason);
    if (verdict.identity.kind !== "executor") return this.refuse(socket, "identity_mismatch");
    this.options.onConnection({ socket, executor: verdict.identity, peerNotAfter: peer.facts!.notAfter });
  }

  private refuse(socket: tls.TLSSocket, reason: ServerRejectReason): void {
    socket.destroy();
    this.options.onRejected?.(reason);
  }

  close(): Promise<void> {
    this.closed = true;
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function rawOf(cert: tls.PeerCertificate | object | null | undefined): Uint8Array | undefined {
  const raw = (cert as { raw?: Uint8Array } | null | undefined)?.raw;
  return raw && raw.length > 0 ? new Uint8Array(raw) : undefined;
}
