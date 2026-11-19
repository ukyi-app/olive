// v2 시험이 함께 쓰는 도구: 키, 봉투 만들기, 사례 문맥을 검증 문맥으로 바꾸기, 메모리 nonce 저장소, 시험 전용 효과 묶음(probe).
// probe 묶음은 시험 안에서만 쓴다. 공통부는 업무 동작을 만들지 않으므로, 효과 동작에 걸리는 규칙(인사·정책·접수·작업 조회)을
// 이 묶음으로 확인한다. 표본(contracts/fixtures/v2/)에는 probe 동작이 들어가지 않는다.
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { digestOf, publicKeyFromRaw, rawPublicKey } from "../../../src/contract/v1/index.ts";
import { type Awaited, type Bundle, COMMON_BUNDLE, type HandshakeState } from "../../../src/contract/v2/actions.ts";
import { type Contract, defineContract, type Envelope, type NonceStore, signUnchecked, type VerifyContext } from "../../../src/contract/v2/contract.ts";
import type { Header, Party } from "../../../src/contract/v2/header.ts";
import { CONTRACT, MESSAGE_TTL_MS } from "../../../src/contract/v2/limits.ts";
import { effectBody, object, oneOf, sha256 } from "../../../src/contract/v2/schema.ts";

// 2026-11-19T00:00:00Z. 표본은 이 시각을 "지금"으로 검증한다.
export const NOW = 1_795_046_400_000;
export const ISSUED = NOW - 1_000;
export const POLICY = "policy-7";
export const OTHER_POLICY = "policy-8";

export const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const nonceOf = (n: number) => n.toString(16).padStart(32, "0");

export interface KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}
export type Keys = Record<Party, KeyPair>;

export function freshKeys(): Keys {
  return { "front-door": generateKeyPairSync("ed25519"), supervisor: generateKeyPairSync("ed25519") };
}

export const other = (party: Party): Party => (party === "supervisor" ? "front-door" : "supervisor");

// 받는 쪽은 상대의 키 하나만 믿는다.
export function trustedRaw(keys: Keys, receiver: Party): Record<string, string> {
  const peer = other(receiver);
  return { [peer]: rawPublicKey(keys[peer].publicKey) };
}

export interface CaseContext {
  now: number;
  expected_recipient: Party;
  own_policy_revision: string;
  handshake: HandshakeState;
  intake_open: boolean;
  awaiting: Record<string, Awaited>;
  spent_nonces: { sender: string; nonce: string }[];
}

export function baseContext(receiver: Party, over: Partial<CaseContext> = {}): CaseContext {
  return {
    now: NOW,
    expected_recipient: receiver,
    own_policy_revision: POLICY,
    handshake: "none",
    intake_open: false,
    awaiting: {},
    spent_nonces: [],
    ...over,
  };
}

export class MemoryNonces implements NonceStore {
  readonly spent = new Set<string>();
  consume(sender: string, nonce: string): boolean {
    const key = `${sender} ${nonce}`;
    if (this.spent.has(key)) return false;
    this.spent.add(key);
    return true;
  }
}

export function contextOf(raw: Record<string, string>, c: CaseContext, nonces = new MemoryNonces()): VerifyContext {
  const trusted = new Map(Object.entries(raw).map(([name, key]) => [name, publicKeyFromRaw(key)]));
  for (const { sender, nonce } of c.spent_nonces) nonces.spent.add(`${sender} ${nonce}`);
  return {
    now: c.now,
    expectedRecipient: c.expected_recipient,
    publicKeyFor: (sender) => trusted.get(sender),
    handshake: c.handshake,
    intakeOpen: c.intake_open,
    awaiting: (requestId) => (Object.hasOwn(c.awaiting, requestId) ? c.awaiting[requestId] : undefined),
    nonces,
  };
}

// 머리를 채우고 서명한다. 검사하지 않으므로 거절 사례도 만들 수 있다. signer를 주면 그 쪽의 키로 서명한다.
export function envelope(
  keys: Keys,
  fields: { sender: string; recipient: string; action: string; request_id: string; nonce: string } & Partial<Record<string, unknown>>,
  body: unknown,
  signer?: Party,
): Envelope {
  const header = {
    contract: CONTRACT,
    body_digest: digestOf(body),
    issued_at: ISSUED,
    expires_at: ISSUED + MESSAGE_TTL_MS,
    ...fields,
  } as unknown as Header;
  const by = signer ?? (fields.sender as Party);
  return signUnchecked(header, body, keys[by].privateKey);
}

// ---- 시험 전용 효과 묶음 ----

const probeResult = object({ outcome: oneOf(["done", "refused"]) });
export const PROBE_BUNDLE: Bundle = {
  name: "probe",
  actions: {
    probe_effect: {
      class: "effect",
      from: ["front-door"],
      duringClosedIntake: false,
      parse: (body) => effectBody({ note_digest: sha256 })(body, "body"),
      parseResult: probeResult,
    },
    probe_effect_closed_ok: {
      class: "effect",
      from: ["front-door"],
      duringClosedIntake: true,
      parse: (body) => effectBody({ note_digest: sha256 })(body, "body"),
      parseResult: probeResult,
    },
    probe_return: {
      class: "effect",
      from: ["supervisor"],
      duringClosedIntake: false,
      parse: (body) => effectBody({ note_digest: sha256 })(body, "body"),
      parseResult: probeResult,
    },
  },
};
export const PROBE: Contract = defineContract([COMMON_BUNDLE, PROBE_BUNDLE]);

// 두 JSON 값의 다른 잎 경로(v1 support.ts의 leafDiff와 같은 규칙). 한쪽에만 있는 칸도 다른 것으로 센다.
export function leafDiff(a: unknown, b: unknown, path = ""): string[] {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length || i >= b.length) out.push(`${path}[${i}]`);
      else out.push(...leafDiff(a[i], b[i], `${path}[${i}]`));
    }
    return out;
  }
  if (isObject(a) && isObject(b)) {
    const out: string[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const next = path === "" ? key : `${path}.${key}`;
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) out.push(next);
      else out.push(...leafDiff(a[key], b[key], next));
    }
    return out;
  }
  return Object.is(a, b) ? [] : [path];
}
