// 실행기 쪽 상호 TLS 연결. 실행기는 감독에 먼저 붙고 듣지 않는다(D-55). 이 모듈은 서버 API를 쓰지 않고 서버 모듈을 import하지 않는다.
// 인증서·키·신뢰 묶음은 만들 때 바이트로 한 번 받는다. 파일을 읽는 것은 부르는 쪽(진입점)의 일이다.
//
// 돌려준 연결이 뜻하는 것: 이 끝이 감독의 인증서를 확인했다(신뢰 묶음, 기간, 서버 용도 하나, 감독 URI SAN 하나, 감독 DNS 이름).
// 함정: TLS 1.3에서는 클라이언트 쪽 핸드셰이크가 서버가 클라이언트 인증서를 판정하기 전에 끝난다(Bun 1.4.4 실측).
// 감독이 이 실행기를 받아들였는지는 감독의 첫 메시지가 와야 안다. 거절되면 그 직후 연결이 닫힌다.
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

// 이 끝이 감독의 인증서를 확인한 연결.
// 연결을 돌려받았다고 감독이 받아들인 것은 아니다. 감독의 첫 메시지를 확인하기 전에는 아무것도 보내지 않는다.
// 단 하나의 예외는 계약 olive-control/v1이 연결의 첫 메시지로 정한 실행기의 서명된 stop_sync_request다(권한을 열지 않는다).
// 그 답(감독의 첫 메시지)을 검증하기 전에는 hello를 포함해 다른 것을 보내지 않는다.
// TLS 1.3에서는 감독이 이 실행기의 인증서를 판정하기 전에 이 값이 돌아올 수 있고, 감독이 거절하면 그 뒤에 연결이 닫힌다.
export interface VerifiedSupervisorConnection {
  readonly socket: tls.TLSSocket;
  readonly supervisor: TlsDeploymentIdentity;
  // 감독 인증서의 만료 시각. 그 전에 다시 붙는 것은 부르는 쪽의 일이다.
  readonly peerNotAfter: number;
  // 이 소켓의 실제 close 사건에서 풀리며, 그때는 이미 openConnections()의 집계에서 빠져 있다. 거절되지 않는다.
  // 클라이언트 전체를 close()하면 집계는 실제 close 사건보다 먼저 0이 된다(live.clear()).
  // 함정: socket.closed·destroyed는 close 사건보다 먼저 참이 될 수 있어, 늦게 받은 쪽이 그 속성으로는
  // 이미 닫힌 소켓과 닫히는 중인 소켓을 가르지 못한다. 이 약속은 검증 직후 걸어 두므로 사건을 놓치지 않는다.
  readonly closed: Promise<void>;
}

export type ConnectFailure =
  | { readonly kind: "no_material" }
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
  private readonly live = new Set<tls.TLSSocket>();
  private closed = false;

  constructor(
    private readonly options: TlsClientOptions,
    private readonly material: TlsMaterial,
  ) {}

  connect(signal?: AbortSignal): Promise<VerifiedSupervisorConnection> {
    const material = this.material;
    if (this.closed || material.notAfter <= this.options.now()) return Promise.reject(new TlsConnectError({ kind: "no_material" }));
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
        // 핸드셰이크 사이에 close()가 불렸으면 돌려주지 않는다.
        if (this.closed) return fail({ kind: "no_material" });
        const peer = readPeerCertificate(socket.authorized, rawOf(socket.getPeerCertificate()), material.trust);
        const verdict = checkPeer(peer, { role: "supervisor", uri: this.options.supervisorUri, dnsName: this.options.supervisorDnsName }, this.options.now());
        if (!verdict.ok) return fail({ kind: "peer_rejected", reason: verdict.reason });
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.live.add(socket);
        const closed = new Promise<void>((done) =>
          socket.once("close", () => {
            this.live.delete(socket);
            done();
          }),
        );
        resolve({ socket, supervisor: verdict.identity, peerNotAfter: peer.facts!.notAfter, closed });
      });
    });
  }

  openConnections(): number {
    return this.live.size;
  }

  close(): void {
    this.closed = true;
    for (const socket of [...this.live]) socket.destroy();
    this.live.clear();
  }
}

function rawOf(cert: tls.PeerCertificate | object | null | undefined): Uint8Array | undefined {
  const raw = (cert as { raw?: Uint8Array } | null | undefined)?.raw;
  return raw && raw.length > 0 ? new Uint8Array(raw) : undefined;
}
