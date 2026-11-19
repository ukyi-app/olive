// 시험용 X.509 인증서를 시험 안에서 만든다. 외부 도구(openssl)와 npm 패키지 없이 node:crypto의 키 생성·서명만 쓴다.
// 검사 이미지(Dockerfile의 test 단계, bun slim)에 openssl이 있다는 근거가 없어 DER을 직접 짠다.
// 모양은 차트의 leaf 선언(ECDSA P-256, PKCS8, 용도 digital signature + server/client auth, URI SAN 하나, 감독만 DNS SAN)을 따른다.
// 개인 키는 메모리에만 있고 파일로 쓰지 않는다.
import { type KeyObject, generateKeyPairSync, randomBytes, sign } from "node:crypto";

export const EKU_SERVER = "1.3.6.1.5.5.7.3.1";
export const EKU_CLIENT = "1.3.6.1.5.5.7.3.2";

function length(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  return Uint8Array.from([tag, ...length(content.length), ...content]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const seq = (...parts: Uint8Array[]) => tlv(0x30, concat(parts));
const set = (...parts: Uint8Array[]) => tlv(0x31, concat(parts));
const explicit = (n: number, inner: Uint8Array) => tlv(0xa0 + n, inner);
const octets = (bytes: Uint8Array) => tlv(0x04, bytes);
const bits = (bytes: Uint8Array, unused = 0) => tlv(0x03, Uint8Array.from([unused, ...bytes]));
const bool = (v: boolean) => tlv(0x01, Uint8Array.of(v ? 0xff : 0x00));
const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));

function integer(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && (bytes[start + 1]! & 0x80) === 0) start++;
  const body = bytes.subarray(start);
  return tlv(0x02, (body[0]! & 0x80) !== 0 ? Uint8Array.from([0, ...body]) : body);
}

function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const out = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(out));
}

function time(at: Date): Uint8Array {
  const iso = at.toISOString();
  const digits = iso.slice(0, 19).replace(/[-T:]/g, "");
  const year = at.getUTCFullYear();
  if (year >= 1950 && year < 2050) return tlv(0x17, new TextEncoder().encode(`${digits.slice(2)}Z`));
  return tlv(0x18, new TextEncoder().encode(`${digits}Z`));
}

const nameOf = (cn: string) => seq(set(seq(oid("2.5.4.3"), utf8(cn))));

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

export interface Issued {
  readonly der: Uint8Array;
  readonly pem: string;
  readonly keyPem: string;
  readonly privateKey: KeyObject;
  readonly subject: string;
}

export interface CertSpec {
  readonly subject: string;
  // 없으면 자체 서명.
  readonly issuer?: Issued;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly ca?: boolean;
  // undefined면 확장 용도 칸을 넣지 않는다.
  readonly ekus?: readonly string[];
  readonly uris?: readonly string[];
  readonly dns?: readonly string[];
  readonly ips?: readonly Uint8Array[];
  // 다른 키 쌍의 공개 키를 넣고 싶을 때(키와 인증서가 짝이 아닌 경우를 만든다).
  readonly keyPair?: { publicKey: KeyObject; privateKey: KeyObject };
}

export function pem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export function newKeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

export function issue(spec: CertSpec): Issued {
  const pair = spec.keyPair ?? newKeyPair();
  const signer = spec.issuer?.privateKey ?? pair.privateKey;
  const issuerName = nameOf(spec.issuer?.subject ?? spec.subject);
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  const sigAlg = seq(oid("1.2.840.10045.4.3.2"));
  const extensions: Uint8Array[] = [];
  extensions.push(extension("2.5.29.19", true, spec.ca ? seq(bool(true)) : seq()));
  // keyUsage: CA는 keyCertSign·cRLSign, leaf는 digitalSignature(차트의 usages와 같다).
  extensions.push(extension("2.5.29.15", true, spec.ca ? bits(Uint8Array.of(0x06), 1) : bits(Uint8Array.of(0x80), 7)));
  if (spec.ekus) extensions.push(extension("2.5.29.37", false, seq(...spec.ekus.map(oid))));
  const san: Uint8Array[] = [
    ...(spec.dns ?? []).map((d) => tlv(0x82, new TextEncoder().encode(d))),
    ...(spec.uris ?? []).map((u) => tlv(0x86, new TextEncoder().encode(u))),
    ...(spec.ips ?? []).map((ip) => tlv(0x87, ip)),
  ];
  if (san.length > 0) extensions.push(extension("2.5.29.17", false, seq(...san)));
  const spki = new Uint8Array(pair.publicKey.export({ type: "spki", format: "der" }));
  const tbs = seq(
    explicit(0, integer(Uint8Array.of(2))),
    integer(serial),
    sigAlg,
    issuerName,
    seq(time(spec.notBefore), time(spec.notAfter)),
    nameOf(spec.subject),
    spki,
    explicit(3, seq(...extensions)),
  );
  const signature = new Uint8Array(sign("sha256", tbs, signer));
  const der = seq(tbs, sigAlg, bits(signature));
  const keyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { der, pem: pem("CERTIFICATE", der), keyPem, privateKey: pair.privateKey, subject: spec.subject };
}

// 차트의 이름 꼴(platform/olive/templates/_helpers.tpl의 olive.pki.uri·olive.pki.dnsName)을 따른 시험 값.
export const SUPERVISOR_NS = "olive-control";
export const SUPERVISOR_DNS = `supervisor.${SUPERVISOR_NS}.svc`;
export const SUPERVISOR_URI = `spiffe://olive.internal/ns/${SUPERVISOR_NS}/supervisor`;
export const READER_URI = "spiffe://olive.internal/ns/olive-reader/executor/reader";

const HOUR = 3_600_000;

export interface Pki {
  readonly ca: Issued;
  supervisor(over?: Partial<CertSpec>): Issued;
  executor(over?: Partial<CertSpec>): Issued;
}

// 발급 기관 하나와 그 아래 감독·실행기 leaf를 만든다. 기간은 실제 시계 기준이다(TLS 라이브러리가 프로세스 시계로 기간을 본다).
export function makePki(subject = "olive-internal-ca-g1", now = Date.now()): Pki {
  const ca = issue({ subject, ca: true, notBefore: new Date(now - HOUR), notAfter: new Date(now + 24 * HOUR) });
  const window = { notBefore: new Date(now - HOUR), notAfter: new Date(now + 12 * HOUR) };
  return {
    ca,
    supervisor: (over = {}) =>
      issue({ subject: "supervisor", issuer: ca, ...window, ekus: [EKU_SERVER], uris: [SUPERVISOR_URI], dns: [SUPERVISOR_DNS], ...over }),
    executor: (over = {}) => issue({ subject: "executor", issuer: ca, ...window, ekus: [EKU_CLIENT], uris: [READER_URI], ...over }),
  };
}
