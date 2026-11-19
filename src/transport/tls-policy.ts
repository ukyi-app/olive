// 감독과 실행기 사이 상호 TLS에서 상대 인증서와 자기 재료를 판정하는 순수 함수. 양 끝(tls-client.ts, ../supervisor/transport/tls-server.ts)이 같은 함수를 쓴다.
// 입출력·시계를 쓰지 않는다. 지금 시각은 인자로 받는다. node:crypto는 인증서 해석과 서명 확인에만 쓴다.
//
// 이 판정이 통과시킨 것은 "올리브 발급 기관이 이 배포 대상에 낸 인증서"까지다. 등록된 실행기라는 뜻이 아니다.
// 등록표 대조(인스턴스·저장소·Ed25519 키)는 뒤 작업이고, TLS 키는 계약 olive-control/v1의 서명 키가 아니다.
//
// Bun 1.4.4(BoringSSL)이 핸드셰이크에서 스스로 막는 것: 다른 발급 기관, 만료, 상대 인증서 없음, 확장 용도 칸이 있는데 반대 용도만 있는 것.
// 스스로 막지 않는 것(이 파일이 막는다): 확장 용도 칸이 없거나 server·client를 함께 가진 것, URI SAN의 수와 꼴, 서버가 이름 확인을 끈 경우.
import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";

export const EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
export const EKU_CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

// 차트(platform/olive/templates/_helpers.tpl의 olive.pki.uri)가 내는 꼴:
//   spiffe://olive.internal/ns/<네임스페이스>/supervisor
//   spiffe://olive.internal/ns/<네임스페이스>/executor/<대상 id>
// 두 칸의 글자 규칙은 Kubernetes 네임스페이스 이름(RFC 1123 label)과 homelab CI의 대상 id 규칙(같은 꼴)이다.
const LABEL = "[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?";
const IDENTITY_URI = new RegExp(`^spiffe://olive\\.internal/ns/(${LABEL})/(?:(supervisor)|executor/(${LABEL}))$`);

// 인증서가 증명하는 배포 신원. 등록된 실행기가 아니다(등록표 대조 전).
export type TlsDeploymentIdentity =
  | { readonly kind: "supervisor"; readonly namespace: string; readonly uri: string }
  | { readonly kind: "executor"; readonly namespace: string; readonly target: string; readonly uri: string };

export function parseIdentityUri(uri: string): TlsDeploymentIdentity | undefined {
  const match = IDENTITY_URI.exec(uri);
  if (!match) return undefined;
  const [, namespace, supervisor, target] = match;
  if (supervisor) return { kind: "supervisor", namespace: namespace!, uri };
  return { kind: "executor", namespace: namespace!, target: target!, uri };
}

// ---- DER에서 읽는 사실 ----
// SAN을 X509Certificate.subjectAltName 글에서 쪼개지 않는 이유: 그 글은 이스케이프 규칙에 기대는 표시용이다. 칸의 종류와 수를 그대로 센다.

export interface CertificateFacts {
  readonly notBefore: number;
  readonly notAfter: number;
  // 확장 용도 칸이 없으면 null.
  readonly extKeyUsages: readonly string[] | null;
  readonly isCa: boolean;
  readonly dnsNames: readonly string[];
  readonly uris: readonly string[];
  // DNS·URI가 아닌 SAN 칸(IP, 이메일, otherName 등)의 수.
  readonly otherSans: number;
}

interface Tlv {
  readonly tag: number;
  readonly body: number;
  readonly end: number;
}

function readTlv(b: Uint8Array, at: number, limit: number): Tlv | undefined {
  if (at + 2 > limit) return undefined;
  const tag = b[at]!;
  if ((tag & 0x1f) === 0x1f) return undefined;
  let len = b[at + 1]!;
  let body = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3 || body + n > limit) return undefined;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[body + i]!;
    body += n;
  }
  const end = body + len;
  return end <= limit ? { tag, body, end } : undefined;
}

function children(b: Uint8Array, parent: Tlv): Tlv[] | undefined {
  const out: Tlv[] = [];
  for (let at = parent.body; at < parent.end; ) {
    const t = readTlv(b, at, parent.end);
    if (!t) return undefined;
    out.push(t);
    at = t.end;
  }
  return out;
}

function ascii(b: Uint8Array, t: Tlv): string | undefined {
  let s = "";
  for (let i = t.body; i < t.end; i++) {
    const c = b[i]!;
    if (c < 0x20 || c > 0x7e) return undefined;
    s += String.fromCharCode(c);
  }
  return s;
}

function oidText(b: Uint8Array, t: Tlv): string | undefined {
  if (t.tag !== 0x06 || t.end === t.body) return undefined;
  const parts: number[] = [];
  let v = 0;
  for (let i = t.body; i < t.end; i++) {
    v = v * 128 + (b[i]! & 0x7f);
    if ((b[i]! & 0x80) === 0) {
      parts.push(v);
      v = 0;
    }
  }
  if ((b[t.end - 1]! & 0x80) !== 0) return undefined;
  const first = parts[0]!;
  const head = first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80];
  return [...head, ...parts.slice(1)].join(".");
}

function timeOf(b: Uint8Array, t: Tlv): number | undefined {
  const s = ascii(b, t);
  if (s === undefined) return undefined;
  let m: RegExpExecArray | null;
  let year: number;
  if (t.tag === 0x17 && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    const yy = Number(m[1]);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (t.tag === 0x18 && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    year = Number(m[1]);
  } else return undefined;
  const [mo, d, h, mi, se] = [m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number];
  const at = Date.UTC(year, mo - 1, d, h, mi, se);
  const back = new Date(at);
  return back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? at : undefined;
}

const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";

export function readCertificateFacts(der: Uint8Array): CertificateFacts | undefined {
  const cert = readTlv(der, 0, der.length);
  if (!cert || cert.tag !== 0x30 || cert.end !== der.length) return undefined;
  const tbs = children(der, cert)?.[0];
  if (!tbs || tbs.tag !== 0x30) return undefined;
  const fields = children(der, tbs);
  if (!fields) return undefined;
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const validity = fields[offset + 3];
  if (!validity || validity.tag !== 0x30) return undefined;
  const times = children(der, validity);
  if (!times || times.length !== 2) return undefined;
  const notBefore = timeOf(der, times[0]!);
  const notAfter = timeOf(der, times[1]!);
  if (notBefore === undefined || notAfter === undefined) return undefined;

  let extKeyUsages: string[] | null = null;
  let isCa = false;
  const dnsNames: string[] = [];
  const uris: string[] = [];
  let otherSans = 0;
  const seen = new Set<string>();
  const extWrapper = fields.slice(offset + 6).find((f) => f.tag === 0xa3);
  const extList = extWrapper ? children(der, extWrapper) : [];
  if (!extList || (extWrapper && extList.length !== 1)) return undefined;
  for (const ext of extList[0] ? children(der, extList[0]) ?? [undefined] : []) {
    if (!ext) return undefined;
    const parts = children(der, ext);
    if (!parts || parts.length < 2) return undefined;
    const id = oidText(der, parts[0]!);
    const value = parts[parts.length - 1]!;
    if (!id || value.tag !== 0x04) return undefined;
    // RFC 5280 4.2: 같은 확장은 한 번만 온다. 둘이면 어느 쪽을 믿을지 정할 수 없다.
    if (seen.has(id)) return undefined;
    seen.add(id);
    const inner = readTlv(der, value.body, value.end);
    if (!inner || inner.end !== value.end) return undefined;
    if (id === OID_EXT_KEY_USAGE) {
      const list = inner.tag === 0x30 ? children(der, inner) : undefined;
      if (!list) return undefined;
      extKeyUsages = [];
      for (const item of list) {
        const text = oidText(der, item);
        if (!text) return undefined;
        extKeyUsages.push(text);
      }
    } else if (id === OID_BASIC_CONSTRAINTS) {
      const list = inner.tag === 0x30 ? children(der, inner) : undefined;
      if (!list) return undefined;
      const first = list[0];
      isCa = first?.tag === 0x01 && first.end - first.body === 1 && der[first.body] !== 0;
    } else if (id === OID_SUBJECT_ALT_NAME) {
      const list = inner.tag === 0x30 ? children(der, inner) : undefined;
      if (!list) return undefined;
      for (const name of list) {
        if (name.tag === 0x82 || name.tag === 0x86) {
          const text = ascii(der, name);
          if (text === undefined) return undefined;
          (name.tag === 0x82 ? dnsNames : uris).push(text);
        } else otherSans++;
      }
    }
  }
  return { notBefore, notAfter, extKeyUsages, isCa, dnsNames, uris, otherSans };
}

// ---- 신뢰 기준 ----

export interface TrustAnchors {
  readonly certificates: readonly X509Certificate[];
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----/g;

// PEM 글을 인증서 블록으로 나눈다. 블록 밖에 공백이 아닌 글자가 있으면 손상으로 본다(잘린 파일, 섞인 키).
function pemCertificates(text: string): string[] | undefined {
  const blocks: string[] = [];
  let rest = text;
  for (const match of text.matchAll(PEM_CERT)) {
    blocks.push(match[0]);
    rest = rest.replace(match[0], "");
  }
  return rest.trim() === "" ? blocks : undefined;
}

// leaf가 신뢰 묶음의 발급 기관 하나에게 직접 서명받았는가. 차트의 발급 기관은 leaf에 바로 서명한다(중간 기관 없음).
export function issuedByTrust(leafDer: Uint8Array, trust: TrustAnchors): boolean {
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(leafDer);
  } catch {
    return false;
  }
  return trust.certificates.some((ca) => {
    try {
      return leaf.checkIssued(ca) && leaf.verify(ca.publicKey);
    } catch {
      return false;
    }
  });
}

// ---- 상대 인증서 판정 ----

export const PEER_REJECT_REASONS = [
  // TLS 라이브러리가 체인을 검증하지 못했거나, leaf가 지금 신뢰 묶음의 발급 기관에게 직접 서명받지 않았다.
  "chain_unverified",
  "certificate_unreadable",
  "not_yet_valid",
  "expired",
  // leaf 자리에 발급 기관 인증서가 왔다.
  "certificate_is_ca",
  // 확장 용도가 정확히 기대한 하나가 아니다(칸 없음, 반대 용도, 둘 다 포함).
  "usage_mismatch",
  // URI SAN이 정확히 하나가 아니다.
  "uri_san_count",
  // URI SAN이 올리브 신원 꼴이 아니다.
  "uri_san_malformed",
  // 신원 꼴은 맞지만 기대한 상대(감독의 정확한 URI, 실행기 종류)가 아니다.
  "identity_mismatch",
  // DNS SAN이 기대와 다르다(감독은 정확히 그 이름 하나, 실행기는 없음).
  "dns_san_mismatch",
  // DNS·URI가 아닌 SAN이 있다.
  "unexpected_san",
] as const;
export type PeerRejectReason = (typeof PEER_REJECT_REASONS)[number];

// 상대 인증서에서 읽은 것.
export interface PeerCertificate {
  readonly chainVerified: boolean;
  // 해석하지 못했으면 undefined.
  readonly facts: CertificateFacts | undefined;
}

export type PeerExpectation =
  // 실행기가 감독을 볼 때: 감독의 정확한 URI SAN과 DNS 이름(주소가 IP여도 이 이름으로 본다).
  | { readonly role: "supervisor"; readonly uri: string; readonly dnsName: string }
  // 감독이 실행기를 볼 때: 실행기 꼴의 URI 하나. 어느 대상인지는 결과의 신원으로 넘기고 등록표 대조는 뒤 작업이 한다.
  | { readonly role: "executor" };

export type PeerCheck = { readonly ok: true; readonly identity: TlsDeploymentIdentity } | { readonly ok: false; readonly reason: PeerRejectReason };

export function readPeerCertificate(libraryAuthorized: boolean, leafDer: Uint8Array | undefined, trust: TrustAnchors): PeerCertificate {
  if (!leafDer || leafDer.length === 0) return { chainVerified: false, facts: undefined };
  return { chainVerified: libraryAuthorized && issuedByTrust(leafDer, trust), facts: readCertificateFacts(leafDer) };
}

export function checkPeer(peer: PeerCertificate, expect: PeerExpectation, now: number): PeerCheck {
  if (!peer.chainVerified) return reject("chain_unverified");
  const facts = peer.facts;
  if (!facts) return reject("certificate_unreadable");
  const shape = checkShape(facts, expect.role, now);
  if (!shape.ok) return shape;
  const identity = shape.identity;
  if (expect.role === "supervisor") {
    if (identity.uri !== expect.uri) return reject("identity_mismatch");
    if (facts.dnsNames.length !== 1 || facts.dnsNames[0] !== expect.dnsName) return reject("dns_san_mismatch");
  } else if (facts.dnsNames.length !== 0) return reject("dns_san_mismatch");
  return { ok: true, identity };
}

function reject(reason: PeerRejectReason): { ok: false; reason: PeerRejectReason } {
  return { ok: false, reason };
}

// 기간·용도·SAN 꼴. 상대 인증서와 자기 인증서가 같은 규칙을 쓴다.
function checkShape(facts: CertificateFacts, role: "supervisor" | "executor", now: number): PeerCheck {
  if (now < facts.notBefore) return reject("not_yet_valid");
  if (now >= facts.notAfter) return reject("expired");
  if (facts.isCa) return reject("certificate_is_ca");
  const usage = role === "supervisor" ? EKU_SERVER_AUTH : EKU_CLIENT_AUTH;
  if (!facts.extKeyUsages || facts.extKeyUsages.length !== 1 || facts.extKeyUsages[0] !== usage) return reject("usage_mismatch");
  if (facts.otherSans !== 0) return reject("unexpected_san");
  if (facts.uris.length !== 1) return reject("uri_san_count");
  const identity = parseIdentityUri(facts.uris[0]!);
  if (!identity) return reject("uri_san_malformed");
  if (identity.kind !== role) return reject("identity_mismatch");
  return { ok: true, identity };
}

// ---- 자기 재료(인증서·키·신뢰 묶음) ----

// 진입점이 파일에서 읽어 넘기는 바이트.
// 함정: 이 모듈은 셋이 같은 발급에서 나온 것인지 가르지 못한다. 짝(키↔leaf)과 직접 서명(묶음 안의 어느 발급 기관이든)만 본다.
export interface RawTlsMaterial {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly trustBundlePem: string;
}

export interface TlsMaterial extends RawTlsMaterial {
  readonly leafDer: Uint8Array;
  readonly trust: TrustAnchors;
  readonly identity: TlsDeploymentIdentity;
  readonly notAfter: number;
}

export const MATERIAL_REJECT_REASONS = [
  "trust_empty",
  "trust_unreadable",
  // 신뢰 묶음에 발급 기관이 아닌 인증서가 있다.
  "trust_not_ca",
  "certificate_unreadable",
  "key_unreadable",
  // 키가 인증서의 공개 키와 짝이 아니다.
  "key_mismatch",
  // 자기 leaf가 주어진 묶음의 어느 발급 기관에게도 직접 서명받지 않았다.
  "certificate_not_from_trust",
  // 자기 leaf의 기간·용도·SAN(URI와 DNS)이 자기 역할의 규칙에 맞지 않는다(상대가 받지 않을 인증서).
  "certificate_not_valid_now",
  "certificate_shape",
] as const;
export type MaterialRejectReason = (typeof MATERIAL_REJECT_REASONS)[number];

export type MaterialCheck = { readonly ok: true; readonly material: TlsMaterial } | { readonly ok: false; readonly reason: MaterialRejectReason };

export class TlsMaterialError extends Error {
  constructor(readonly reason: MaterialRejectReason) {
    super(`TLS 재료를 받지 않는다: ${reason}`);
  }
}

// 이 재료로 시작해도 되는가. 셋 가운데 하나라도 틀리면 받지 않는다.
// 빈 신뢰 묶음을 거절하는 이유: node:tls에 빈 ca를 주면 오류 없이 받는다(Bun 1.4.4 실측). 시스템 기본 신뢰로 대신 검증하는 길을 막는다.
// DNS SAN도 상대 판정(checkPeer)과 같은 규칙으로 본다: 감독 leaf는 정확히 하나, 실행기 leaf는 없음. 상대가 반드시 거절할 재료로 시작하지 않는다.
// supervisorDnsName: 감독 역할에서 자기 DNS 이름을 아는 쪽이 주면 값까지 본다. 주지 않으면 개수만 본다.
export function prepareMaterial(raw: RawTlsMaterial, role: "supervisor" | "executor", now: number, supervisorDnsName?: string): MaterialCheck {
  const fail = (reason: MaterialRejectReason): MaterialCheck => ({ ok: false, reason });
  const trustBlocks = pemCertificates(raw.trustBundlePem);
  if (!trustBlocks) return fail("trust_unreadable");
  if (trustBlocks.length === 0) return fail("trust_empty");
  const anchors: X509Certificate[] = [];
  for (const block of trustBlocks) {
    try {
      const ca = new X509Certificate(block);
      if (!ca.ca) return fail("trust_not_ca");
      anchors.push(ca);
    } catch {
      return fail("trust_unreadable");
    }
  }
  const trust: TrustAnchors = { certificates: anchors };

  // 인증서 파일에 leaf 뒤로 발급 기관이 이어 붙어 올 수 있다. 판정은 첫 블록(leaf)으로 한다.
  const certBlocks = pemCertificates(raw.certificatePem);
  if (!certBlocks || certBlocks.length === 0) return fail("certificate_unreadable");
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(certBlocks[0]!);
    for (const extra of certBlocks.slice(1)) new X509Certificate(extra);
  } catch {
    return fail("certificate_unreadable");
  }
  const leafDer = new Uint8Array(leaf.raw);
  const facts = readCertificateFacts(leafDer);
  if (!facts) return fail("certificate_unreadable");

  let keySpki: Uint8Array;
  try {
    keySpki = new Uint8Array(createPublicKey(createPrivateKey(raw.privateKeyPem)).export({ type: "spki", format: "der" }));
  } catch {
    return fail("key_unreadable");
  }
  const certSpki = new Uint8Array(leaf.publicKey.export({ type: "spki", format: "der" }));
  if (!sameBytes(keySpki, certSpki)) return fail("key_mismatch");
  if (!issuedByTrust(leafDer, trust)) return fail("certificate_not_from_trust");

  const shape = checkShape(facts, role, now);
  if (!shape.ok) return fail(shape.reason === "not_yet_valid" || shape.reason === "expired" ? "certificate_not_valid_now" : "certificate_shape");
  const dns = facts.dnsNames;
  if (role === "supervisor" ? dns.length !== 1 || (supervisorDnsName !== undefined && dns[0] !== supervisorDnsName) : dns.length !== 0) {
    return fail("certificate_shape");
  }
  return { ok: true, material: { ...raw, leafDer, trust, identity: shape.identity, notAfter: facts.notAfter } };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
