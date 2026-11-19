// 실행기 쪽 상호 TLS 연결. 실행기는 감독에 먼저 붙고 듣지 않는다(D-55). 이 모듈은 서버 API를 쓰지 않고 서버 모듈을 import하지 않는다.
// 인증서·키·신뢰 묶음은 바이트로 받는다. 파일을 읽고 교체를 알아채는 것은 부르는 쪽(진입점)의 일이다.
//
// 돌려준 연결이 뜻하는 것: 이 끝이 감독의 인증서를 확인했다(신뢰 묶음, 기간, 서버 용도 하나, 감독 URI SAN 하나, 감독 DNS 이름).
// 함정: TLS 1.3에서는 클라이언트 쪽 핸드셰이크가 서버가 클라이언트 인증서를 판정하기 전에 끝난다(Bun 1.4.4 실측).
// 감독이 이 실행기를 받아들였는지는 감독의 첫 메시지가 와야 안다. 거절되면 그 직후 연결이 닫힌다.
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
} from "./tls-policy.ts";

export interface TlsClientOptions {
  // 감독의 주소. 차트는 Service의 고정 IP를 준다.
  readonly address: string;
  readonly port: number;
  // 확인할 감독의 DNS SAN(SNI로도 보낸다). 주소가 IP여도 이 이름으로 확인한다.
  readonly supervisorDnsName: string;
  // 감독 인증서의 정확한 URI SAN.
  readonly supervisorUri: string;
  readonly material: RawTlsMaterial;
  readonly now: () => number;
}

export interface VerifiedSupervisorConnection {
  readonly socket: tls.TLSSocket;
  readonly supervisor: TlsDeploymentIdentity;
  // 감독 인증서의 만료 시각. 그 전에 다시 붙는 것은 부르는 쪽의 일이다.
  readonly peerNotAfter: number;
  // 이 연결을 맺은 재료의 세대. 재료를 바꾸면 세대가 오르고 옛 세대의 연결은 닫힌다.
  readonly generation: number;
}

export type ConnectFailure =
  | { readonly kind: "no_material" }
  | { readonly kind: "material_replaced" }
  | { readonly kind: "peer_rejected"; readonly reason: PeerRejectReason }
  | { readonly kind: "tls_error"; readonly message: string }
  | { readonly kind: "aborted" };

export class TlsConnectError extends Error {
  constructor(readonly failure: ConnectFailure) {
    super(`감독에 붙지 못했다: ${failure.kind}${"reason" in failure ? ` (${failure.reason})` : ""}`);
  }
}

export interface TlsClient {
  connect(signal?: AbortSignal): Promise<VerifiedSupervisorConnection>;
  // 인증서·키·신뢰 묶음을 한 묶음으로 바꾼다. 결과와 무관하게 옛 재료로 맺은 연결은 모두 닫는다.
  // 실패하면 재료가 없는 상태가 되어 새 연결을 맺지 않는다(다음 성공한 교체까지).
  replaceMaterial(raw: RawTlsMaterial): MaterialCheck;
  // 지금 열린 검증된 연결 수.
  openConnections(): number;
  close(): void;
}

export function createTlsClient(options: TlsClientOptions): TlsClient {
  const first = prepareMaterial(options.material, "executor", options.now());
  if (!first.ok) throw new TlsMaterialError(first.reason);
  return new Client(options, first.material);
}

class Client implements TlsClient {
  private material: TlsMaterial | null;
  private generation = 1;
  private readonly live = new Set<tls.TLSSocket>();
  private closed = false;

  constructor(
    private readonly options: TlsClientOptions,
    material: TlsMaterial,
  ) {
    this.material = material;
  }

  connect(signal?: AbortSignal): Promise<VerifiedSupervisorConnection> {
    const material = this.material;
    const generation = this.generation;
    if (this.closed || !material || material.notAfter <= this.options.now()) return Promise.reject(new TlsConnectError({ kind: "no_material" }));
    if (signal?.aborted) return Promise.reject(new TlsConnectError({ kind: "aborted" }));
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: this.options.address,
        port: this.options.port,
        servername: this.options.supervisorDnsName,
        key: material.privateKeyPem,
        cert: material.certificatePem,
        ca: material.trustBundlePem,
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
      });
      let settled = false;
      const fail = (failure: ConnectFailure) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        reject(new TlsConnectError(failure));
      };
      const onAbort = () => fail({ kind: "aborted" });
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("error", (error) => fail({ kind: "tls_error", message: error.message }));
      socket.once("close", () => fail({ kind: "tls_error", message: "핸드셰이크 전에 닫혔다" }));
      socket.once("secureConnect", () => {
        // 핸드셰이크 사이에 재료가 바뀌었으면 옛 재료로 맺은 연결이다.
        if (this.closed || this.generation !== generation || this.material !== material) return fail({ kind: "material_replaced" });
        const peer = readPeerCertificate(socket.authorized, rawOf(socket.getPeerCertificate()), material.trust);
        const verdict = checkPeer(peer, { role: "supervisor", uri: this.options.supervisorUri, dnsName: this.options.supervisorDnsName }, this.options.now());
        if (!verdict.ok) return fail({ kind: "peer_rejected", reason: verdict.reason });
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.live.add(socket);
        socket.once("close", () => this.live.delete(socket));
        resolve({ socket, supervisor: verdict.identity, peerNotAfter: peer.facts!.notAfter, generation });
      });
    });
  }

  replaceMaterial(raw: RawTlsMaterial): MaterialCheck {
    const next = prepareMaterial(raw, "executor", this.options.now());
    // 순서: 새 재료(또는 재료 없음)를 먼저 세우고 세대를 올린 뒤 옛 연결을 닫는다. 닫는 사이에 시작된 connect는 새 상태를 본다.
    this.material = next.ok ? next.material : null;
    this.generation++;
    this.closeLive();
    return next;
  }

  openConnections(): number {
    return this.live.size;
  }

  close(): void {
    this.closed = true;
    this.material = null;
    this.closeLive();
  }

  private closeLive(): void {
    for (const socket of [...this.live]) socket.destroy();
    this.live.clear();
  }
}

function rawOf(cert: tls.PeerCertificate | object | null | undefined): Uint8Array | undefined {
  const raw = (cert as { raw?: Uint8Array } | null | undefined)?.raw;
  return raw && raw.length > 0 ? new Uint8Array(raw) : undefined;
}
