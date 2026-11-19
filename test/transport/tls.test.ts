// 감독·실행기 상호 TLS의 보장 넷. 루프백(127.0.0.1)의 빈 포트에서만 연다. 인증서는 시험 안에서 만든다(certs.ts).
// 우리 끝의 상대가 규칙을 어기는 경우는 맨 node:tls로 상대를 흉내 낸다(우리 끝은 그런 재료로 시작하지 않으므로).
import { afterEach, describe, expect, test } from "bun:test";
import * as tls from "node:tls";
import { dirname, join, relative } from "node:path";
import { type CertifiedExecutorConnection, type TlsServer, startTlsServer } from "../../src/supervisor/transport/tls-server.ts";
import { type TlsClient, TlsConnectError, createTlsClient } from "../../src/transport/tls-client.ts";
import { type RawTlsMaterial, TlsMaterialError, checkPeer, prepareMaterial, readCertificateFacts } from "../../src/transport/tls-policy.ts";
import { root } from "../files.ts";
import { EKU_CLIENT, EKU_SERVER, type Issued, READER_URI, SUPERVISOR_DNS, SUPERVISOR_URI, makePki } from "./certs.ts";

const HOST = "127.0.0.1";
const now = () => Date.now();
const pki = makePki();
const sameName = makePki(); // 이름은 같고 키가 다른 발급 기관
const otherName = makePki("other-ca");

const material = (leaf: Issued, trust: string = pki.ca.pem): RawTlsMaterial => ({
  certificatePem: leaf.pem,
  privateKeyPem: leaf.keyPem,
  trustBundlePem: trust,
});

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("기다리던 상태가 오지 않았다");
    await Bun.sleep(10);
  }
}

function closedFlag(socket: tls.TLSSocket): () => boolean {
  let closed = socket.destroyed;
  socket.once("close", () => (closed = true));
  return () => closed;
}

async function server(leaf: Issued = pki.supervisor(), trust?: string) {
  const surfaced: CertifiedExecutorConnection[] = [];
  const rejected: string[] = [];
  const handle = await startTlsServer({
    host: HOST,
    port: 0,
    material: material(leaf, trust),
    now,
    onConnection: (c) => surfaced.push(c),
    onRejected: (r) => rejected.push(r),
  });
  cleanup.push(() => handle.close());
  return { handle, surfaced, rejected };
}

function client(port: number, leaf: Issued = pki.executor(), trust?: string): TlsClient {
  const c = createTlsClient({
    address: HOST,
    port,
    supervisorDnsName: SUPERVISOR_DNS,
    supervisorUri: SUPERVISOR_URI,
    material: material(leaf, trust),
    now,
  });
  cleanup.push(() => c.close());
  return c;
}

// 규칙을 어기는 실행기 흉내: 맨 tls.connect. 끝날 때까지(닫힘) 기다린다.
async function rogueClient(port: number, leaf: Issued | null): Promise<void> {
  const socket = tls.connect({
    host: HOST,
    port,
    servername: SUPERVISOR_DNS,
    ca: pki.ca.pem,
    ...(leaf ? { key: leaf.keyPem, cert: leaf.pem } : {}),
    minVersion: "TLSv1.3",
  });
  socket.on("error", () => {});
  const closed = closedFlag(socket);
  cleanup.push(() => socket.destroy());
  await until(closed);
}

// 규칙을 어기는 감독 흉내: 맨 tls.createServer. 클라이언트 인증서는 요구만 하고 판정하지 않는다.
async function rogueServer(leaf: Issued): Promise<number> {
  const s = tls.createServer({ key: leaf.keyPem, cert: leaf.pem, ca: pki.ca.pem, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3" });
  s.on("tlsClientError", () => {});
  s.on("secureConnection", (socket) => socket.on("error", () => {}));
  await new Promise<void>((r) => s.listen(0, HOST, () => r()));
  cleanup.push(() => new Promise<void>((r) => s.close(() => r())));
  return (s.address() as { port: number }).port;
}

async function connectFailure(c: TlsClient): Promise<string> {
  try {
    const conn = await c.connect();
    conn.socket.destroy();
    return "connected";
  } catch (error) {
    if (!(error instanceof TlsConnectError)) throw error;
    const f = error.failure;
    return f.kind === "peer_rejected" ? `peer_rejected:${f.reason}` : f.kind;
  }
}

describe("(1) 무증명·타 CA·용도 오류 거절", () => {
  test("감독: 인증서 없음·다른 발급 기관·서버 용도·용도 칸 없음·두 용도를 낸 실행기는 위로 올라가지 않는다", async () => {
    const { handle, surfaced, rejected } = await server();
    await rogueClient(handle.port, null);
    await rogueClient(handle.port, sameName.executor());
    await rogueClient(handle.port, otherName.executor());
    await rogueClient(handle.port, pki.supervisor());
    await rogueClient(handle.port, pki.executor({ ekus: undefined }));
    await rogueClient(handle.port, pki.executor({ ekus: [EKU_CLIENT, EKU_SERVER] }));
    expect(surfaced).toHaveLength(0);
    // 앞 넷은 Bun이 핸드셰이크에서 끊고, 뒤 둘(용도 칸 없음·두 용도)은 Bun이 통과시켜 정책이 버린다.
    expect(rejected).toEqual(["usage_mismatch", "usage_mismatch"]);
    // 대조군: 올바른 실행기는 올라간다.
    const conn = await client(handle.port).connect();
    await until(() => surfaced.length === 1);
    expect(surfaced[0]!.executor).toEqual({ kind: "executor", namespace: "olive-reader", target: "reader", uri: READER_URI });
    conn.socket.destroy();
  });

  test("실행기: 다른 발급 기관·클라이언트 용도·용도 칸 없음·두 용도를 낸 감독에게는 연결을 돌려주지 않는다", async () => {
    const cases: [Issued, string][] = [
      [sameName.supervisor(), "tls_error"],
      [otherName.supervisor(), "tls_error"],
      [pki.executor({ uris: [SUPERVISOR_URI], dns: [SUPERVISOR_DNS] }), "tls_error"],
      [pki.supervisor({ ekus: undefined }), "peer_rejected:usage_mismatch"],
      [pki.supervisor({ ekus: [EKU_SERVER, EKU_CLIENT] }), "peer_rejected:usage_mismatch"],
      [pki.supervisor(), "connected"],
    ];
    for (const [leaf, expected] of cases) {
      const c = client(await rogueServer(leaf));
      expect(await connectFailure(c)).toBe(expected);
      if (expected !== "connected") expect(c.openConnections()).toBe(0);
    }
  });

  test("재료: 다른 발급 기관의 leaf나 반대 용도의 leaf로는 양 끝이 시작하지 않는다", async () => {
    await expect(startTlsServer({ host: HOST, port: 0, material: material(pki.executor()), now, onConnection: () => {} })).rejects.toThrow(TlsMaterialError);
    expect(() => client(1, pki.supervisor())).toThrow(TlsMaterialError);
    expect(prepareMaterial(material(sameName.executor()), "executor", now())).toEqual({ ok: false, reason: "certificate_not_from_trust" });
    expect(prepareMaterial(material(pki.executor({ ekus: undefined })), "executor", now())).toEqual({ ok: false, reason: "certificate_shape" });
  });

  test("정책: 기간 밖이거나 발급 기관 인증서인 상대는 거절한다(지금 시각은 인자)", () => {
    const facts = readCertificateFacts(pki.executor().der)!;
    const peer = { chainVerified: true, facts };
    expect(checkPeer(peer, { role: "executor" }, facts.notBefore - 1)).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(checkPeer(peer, { role: "executor" }, facts.notAfter)).toEqual({ ok: false, reason: "expired" });
    expect(checkPeer(peer, { role: "executor" }, facts.notAfter - 1).ok).toBe(true);
    expect(checkPeer({ chainVerified: false, facts }, { role: "executor" }, facts.notBefore)).toEqual({ ok: false, reason: "chain_unverified" });
    const caFacts = readCertificateFacts(pki.ca.der)!;
    expect(checkPeer({ chainVerified: true, facts: caFacts }, { role: "executor" }, now())).toEqual({ ok: false, reason: "certificate_is_ca" });
  });
});

describe("(2) IP로 붙어 감독 DNS·정확한 SAN 확인", () => {
  test("실행기: 127.0.0.1로 붙어도 감독 DNS 이름과 URI SAN이 정확히 맞을 때만 연결을 돌려준다", async () => {
    const otherUri = "spiffe://olive.internal/ns/olive-other/supervisor";
    const cases: [Issued, string][] = [
      [pki.supervisor({ dns: ["supervisor.olive-other.svc"] }), "tls_error"],
      [pki.supervisor({ dns: [SUPERVISOR_DNS, "supervisor.olive-other.svc"] }), "peer_rejected:dns_san_mismatch"],
      [pki.supervisor({ uris: [otherUri] }), "peer_rejected:identity_mismatch"],
      [pki.supervisor({ uris: [SUPERVISOR_URI, otherUri] }), "peer_rejected:uri_san_count"],
      [pki.supervisor({ uris: [] }), "peer_rejected:uri_san_count"],
      [pki.supervisor({ uris: [READER_URI] }), "peer_rejected:identity_mismatch"],
      [pki.supervisor({ uris: [`${SUPERVISOR_URI}/`] }), "peer_rejected:uri_san_malformed"],
      [pki.supervisor({ ips: [Uint8Array.of(127, 0, 0, 1)] }), "peer_rejected:unexpected_san"],
    ];
    for (const [leaf, expected] of cases) expect(await connectFailure(client(await rogueServer(leaf)))).toBe(expected);
    const c = client(await rogueServer(pki.supervisor()));
    const conn = await c.connect();
    expect(conn.supervisor).toEqual({ kind: "supervisor", namespace: "olive-control", uri: SUPERVISOR_URI });
    conn.socket.destroy();
  });

  test("감독: URI SAN이 둘·없음·꼴이 다름·감독 꼴이거나 DNS SAN이 있는 실행기 인증서는 위로 올라가지 않는다", async () => {
    const { handle, surfaced, rejected } = await server();
    await rogueClient(handle.port, pki.executor({ uris: [READER_URI, "spiffe://olive.internal/ns/olive-diagnosis/executor/diagnosis"] }));
    await rogueClient(handle.port, pki.executor({ uris: [] }));
    await rogueClient(handle.port, pki.executor({ uris: ["spiffe://olive.internal/ns/olive-reader/executor/Reader"] }));
    await rogueClient(handle.port, pki.executor({ uris: [SUPERVISOR_URI] }));
    await rogueClient(handle.port, pki.executor({ dns: ["executor.olive-reader.svc"] }));
    expect(surfaced).toHaveLength(0);
    expect(rejected).toEqual(["uri_san_count", "uri_san_count", "uri_san_malformed", "identity_mismatch", "dns_san_mismatch"]);
  });
});

describe("(3) leaf 갱신 후 기존 연결 폐기", () => {
  test("감독의 재료를 바꾸면 기존 연결이 닫히고 새 연결은 새 서버 인증서로만 맺어진다", async () => {
    const { handle, surfaced } = await server();
    const c = client(handle.port);
    const old = await c.connect();
    const oldClosed = closedFlag(old.socket);
    await until(() => surfaced.length === 1);
    const serverOldClosed = closedFlag(surfaced[0]!.socket);
    const renewed = pki.supervisor();
    expect(handle.replaceMaterial(material(renewed)).ok).toBe(true);
    await until(() => oldClosed() && serverOldClosed());
    expect(handle.openConnections()).toBe(0);
    const fresh = await c.connect();
    expect(Buffer.from(fresh.socket.getPeerCertificate().raw)).toEqual(Buffer.from(renewed.der));
    await until(() => surfaced.length === 2);
    expect(surfaced[1]!.generation).toBe(2);
    expect(Buffer.from((surfaced[1]!.socket.getCertificate() as tls.PeerCertificate).raw)).toEqual(Buffer.from(renewed.der));
    fresh.socket.destroy();
  });

  test("실행기의 재료를 바꾸면 기존 연결이 닫히고 새 연결은 새 클라이언트 인증서로만 맺어진다", async () => {
    const { handle, surfaced } = await server();
    const c = client(handle.port);
    const old = await c.connect();
    const oldClosed = closedFlag(old.socket);
    await until(() => surfaced.length === 1);
    const serverOldClosed = closedFlag(surfaced[0]!.socket);
    const renewed = pki.executor();
    expect(c.replaceMaterial(material(renewed)).ok).toBe(true);
    await until(() => oldClosed() && serverOldClosed());
    expect(c.openConnections()).toBe(0);
    const fresh = await c.connect();
    expect(fresh.generation).toBe(2);
    await until(() => surfaced.length === 2);
    expect(Buffer.from(surfaced[1]!.socket.getPeerCertificate().raw)).toEqual(Buffer.from(renewed.der));
    fresh.socket.destroy();
  });
});

describe("(4) 일부 파일 교체 중 새 권한 0", () => {
  const next = makePki("olive-internal-ca-g2");
  const truncate = (pem: string) => pem.slice(0, pem.length - 40);
  const expired = (make: (o: object) => Issued) => make({ notBefore: new Date(Date.now() - 7_200_000), notAfter: new Date(Date.now() - 3_600_000) });

  test("감독: 셋 가운데 일부만 새것이거나 손상·만료면 교체를 받지 않고, 기존 연결을 닫고, 새 연결을 위로 넘기지 않는다", async () => {
    const sup1 = pki.supervisor();
    const sup2 = next.supervisor();
    const { handle, surfaced } = await server(sup1);
    const c = client(handle.port);
    const partial: [RawTlsMaterial, string][] = [
      [{ certificatePem: sup2.pem, privateKeyPem: sup1.keyPem, trustBundlePem: pki.ca.pem }, "key_mismatch"],
      [{ certificatePem: sup1.pem, privateKeyPem: sup2.keyPem, trustBundlePem: pki.ca.pem }, "key_mismatch"],
      [{ certificatePem: sup2.pem, privateKeyPem: sup2.keyPem, trustBundlePem: pki.ca.pem }, "certificate_not_from_trust"],
      [{ certificatePem: sup1.pem, privateKeyPem: sup1.keyPem, trustBundlePem: next.ca.pem }, "certificate_not_from_trust"],
      [{ ...material(sup1), trustBundlePem: "" }, "trust_empty"],
      [{ ...material(sup1), trustBundlePem: truncate(pki.ca.pem) }, "trust_unreadable"],
      [{ ...material(sup1), certificatePem: truncate(sup1.pem) }, "certificate_unreadable"],
      [material(expired(pki.supervisor)), "certificate_not_valid_now"],
    ];
    for (const [bad, reason] of partial) {
      expect(handle.replaceMaterial(material(sup1)).ok).toBe(true);
      const before = surfaced.length;
      const live = await c.connect();
      const liveClosed = closedFlag(live.socket);
      await until(() => surfaced.length === before + 1);
      expect(handle.replaceMaterial(bad)).toEqual({ ok: false, reason } as never);
      await until(liveClosed);
      expect(handle.openConnections()).toBe(0);
      // 새 시도: TLS 1.3이라 실행기 쪽 핸드셰이크는 옛 컨텍스트로 끝날 수 있지만, 감독은 위로 넘기지 않고 곧 닫는다.
      try {
        const attempt = await c.connect();
        await until(closedFlag(attempt.socket));
      } catch (error) {
        expect(error).toBeInstanceOf(TlsConnectError);
      }
      expect(surfaced.length).toBe(before + 1);
      expect(handle.openConnections()).toBe(0);
    }
    // 온전한 묶음으로 바꾸면 다시 받는다.
    expect(handle.replaceMaterial(material(sup1)).ok).toBe(true);
    (await c.connect()).socket.destroy();
  });

  test("실행기: 셋 가운데 일부만 새것이거나 손상·만료면 교체를 받지 않고, 기존 연결을 닫고, 새 연결을 맺지 않는다", async () => {
    const { handle } = await server();
    const exe1 = pki.executor();
    const exe2 = next.executor();
    const c = client(handle.port, exe1);
    const partial: [RawTlsMaterial, string][] = [
      [{ certificatePem: exe2.pem, privateKeyPem: exe1.keyPem, trustBundlePem: pki.ca.pem }, "key_mismatch"],
      [{ certificatePem: exe1.pem, privateKeyPem: exe2.keyPem, trustBundlePem: pki.ca.pem }, "key_mismatch"],
      [{ certificatePem: exe2.pem, privateKeyPem: exe2.keyPem, trustBundlePem: pki.ca.pem }, "certificate_not_from_trust"],
      [{ certificatePem: exe1.pem, privateKeyPem: exe1.keyPem, trustBundlePem: next.ca.pem }, "certificate_not_from_trust"],
      [{ ...material(exe1), trustBundlePem: `${pki.ca.pem}${exe1.pem}` }, "trust_not_ca"],
      [{ ...material(exe1), privateKeyPem: truncate(exe1.keyPem) }, "key_unreadable"],
      [material(expired(pki.executor)), "certificate_not_valid_now"],
    ];
    for (const [bad, reason] of partial) {
      expect(c.replaceMaterial(material(exe1)).ok).toBe(true);
      const live = await c.connect();
      const liveClosed = closedFlag(live.socket);
      expect(c.replaceMaterial(bad)).toEqual({ ok: false, reason } as never);
      await until(liveClosed);
      expect(c.openConnections()).toBe(0);
      expect(await connectFailure(c)).toBe("no_material");
    }
  });
});

// 실행기는 듣지 않는다: 실행기 진입점이 장차 import할 모듈(tls-client·tls-policy)에서 닿는 코드에 듣는 API와 감독 서버 모듈이 없다.
// 진입점 기준의 같은 확인은 test/entrypoints.test.ts가 한다. 이것은 아직 진입점에 잇지 않은 지금도 같은 규칙이 성립함을 본다.
test("정적: 실행기 쪽 TLS 모듈에서 닿는 코드에 듣는 API와 감독 서버 모듈이 없다", async () => {
  const listening = /\bBun\.(serve|listen|udpSocket)\b|\bcreateServer\b|\.listen\(/;
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const queue = [join(root, "src/transport/tls-client.ts")];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await Bun.file(file).text();
    expect(listening.test(source), relative(root, file)).toBe(false);
    expect(relative(root, file).startsWith("src/supervisor/"), relative(root, file)).toBe(false);
    for (const { path } of transpiler.scanImports(source)) {
      if (path.startsWith(".") && path.endsWith(".ts")) queue.push(join(dirname(file), path));
    }
  }
  expect([...seen].map((f) => relative(root, f)).sort()).toEqual(["src/transport/tls-client.ts", "src/transport/tls-policy.ts"]);
  // 대조군: 서버 모듈은 이 확인에 걸린다.
  expect(listening.test(await Bun.file(join(root, "src/supervisor/transport/tls-server.ts")).text())).toBe(true);
});
