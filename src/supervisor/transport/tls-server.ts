// 감독 쪽 상호 TLS 수신. 클라이언트 인증서를 요구하고, ../../transport/tls-policy.ts의 판정을 통과한 연결만 위로 넘긴다.
// 실행기 쪽 모듈은 이 파일을 import하지 않는다(실행기는 듣지 않는다, D-55).
//
// 위로 넘기는 신원은 인증서가 증명한 배포 대상(네임스페이스·대상 id)까지다. 등록된 실행기가 아니다.
// 등록표 대조, 정지 세대 맞춤, hello, 점유는 뒤 작업이 이 연결 위에서 한다.
import * as tls from "node:tls";
import {
  type MaterialCheck,
  type PeerRejectReason,
  type RawTlsMaterial,
  type TlsDeploymentIdentity,
  type TlsMaterial,
  TlsMaterialError,
  checkPeer,
  prepareMaterial,
  readPeerCertificate,
  sameBytes,
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
  readonly generation: number;
}

export type ServerRejectReason = PeerRejectReason | "no_material" | "material_replaced";

export interface TlsServer {
  readonly port: number;
  // 인증서·키·신뢰 묶음을 한 묶음으로 바꾼다. 결과와 무관하게 옛 재료로 맺은 연결은 모두 닫는다.
  // 실패하면 재료가 없는 상태가 되어 새 연결을 위로 넘기지 않는다(다음 성공한 교체까지).
  replaceMaterial(raw: RawTlsMaterial): MaterialCheck;
  openConnections(): number;
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
  private material: TlsMaterial | null;
  private generation = 1;
  private readonly live = new Set<tls.TLSSocket>();
  private readonly raw = new Set<tls.TLSSocket>();
  private readonly server: tls.Server;
  port = 0;

  constructor(
    private readonly options: TlsServerOptions,
    material: TlsMaterial,
  ) {
    this.material = material;
    this.server = tls.createServer({ ...contextOf(material), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" });
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
    this.raw.add(socket);
    socket.once("close", () => {
      this.raw.delete(socket);
      this.live.delete(socket);
    });
    socket.on("error", () => socket.destroy());
    const material = this.material;
    const now = this.options.now();
    if (!material || material.notAfter <= now) return this.refuse(socket, "no_material");
    // 이 연결이 지금 재료의 인증서로 맺어졌는가. 교체 직전에 시작된 핸드셰이크는 옛 컨텍스트로 끝날 수 있다.
    const local = rawOf(socket.getCertificate());
    if (!local || !sameBytes(local, material.leafDer)) return this.refuse(socket, "material_replaced");
    const peer = readPeerCertificate(socket.authorized, rawOf(socket.getPeerCertificate()), material.trust);
    const verdict = checkPeer(peer, { role: "executor" }, now);
    if (!verdict.ok) return this.refuse(socket, verdict.reason);
    if (verdict.identity.kind !== "executor") return this.refuse(socket, "identity_mismatch");
    this.live.add(socket);
    this.options.onConnection({ socket, executor: verdict.identity, peerNotAfter: peer.facts!.notAfter, generation: this.generation });
  }

  private refuse(socket: tls.TLSSocket, reason: ServerRejectReason): void {
    socket.destroy();
    this.options.onRejected?.(reason);
  }

  replaceMaterial(raw: RawTlsMaterial): MaterialCheck {
    const next = prepareMaterial(raw, "supervisor", this.options.now());
    let applied: TlsMaterial | null = null;
    if (next.ok) {
      try {
        // 키·인증서·신뢰 묶음을 한 번의 호출로 바꾼다. 새 핸드셰이크부터 적용되고 기존 연결은 그대로라 아래에서 닫는다.
        this.server.setSecureContext(contextOf(next.material));
        applied = next.material;
      } catch {
        applied = null;
      }
    }
    // 순서: 재료(또는 재료 없음)를 세우고 세대를 올린 뒤 옛 연결을 닫는다.
    // 적용에 실패하면 컨텍스트는 옛것으로 남지만 material이 null이라 그 컨텍스트로 맺은 연결은 admit에서 버린다.
    this.material = applied;
    this.generation++;
    for (const socket of [...this.raw]) socket.destroy();
    this.live.clear();
    if (next.ok && !applied) return { ok: false, reason: "certificate_unreadable" };
    return next;
  }

  openConnections(): number {
    return this.live.size;
  }

  close(): Promise<void> {
    this.material = null;
    for (const socket of [...this.raw]) socket.destroy();
    this.live.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

function contextOf(material: TlsMaterial): tls.SecureContextOptions {
  return { key: material.privateKeyPem, cert: material.certificatePem, ca: material.trustBundlePem };
}

function rawOf(cert: tls.PeerCertificate | object | null | undefined): Uint8Array | undefined {
  const raw = (cert as { raw?: Uint8Array } | null | undefined)?.raw;
  return raw && raw.length > 0 ? new Uint8Array(raw) : undefined;
}
