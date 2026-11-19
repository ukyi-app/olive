// v2 시험이 함께 쓰는 도구: 키, 봉투 만들기, 사례 문맥을 검증 문맥으로 바꾸기, 메모리 nonce 저장소, 시험 전용 효과 묶음(probe).
// probe 묶음은 시험 안에서만 쓴다. 공통부는 업무 동작을 만들지 않으므로, 효과 동작에 걸리는 규칙(인사·정책·접수·작업 조회)을
// 이 묶음으로 확인한다. 표본(contracts/fixtures/v2/)에는 probe 동작이 들어가지 않는다.
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { digestOf, publicKeyFromRaw, rawPublicKey } from "../../../src/contract/v1/index.ts";
import { type Awaited, type Bundle, COMMON_BUNDLE, type EffectSpec, type HandshakeState } from "../../../src/contract/v2/actions.ts";
import { type Contract, defineContract, type Envelope, type NonceStore, signUnchecked, type VerifyContext } from "../../../src/contract/v2/contract.ts";
import { GENERATION_FIELDS, GENERATION_KINDS, type GenerationAuthorities, type GenerationRules, generationShape } from "../../../src/contract/v2/generations.ts";
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

// 받는 쪽이 세대를 모름. 표본의 문맥은 모두 이것이다(인사와 조회는 세대를 몰라도 된다).
export const UNKNOWN_GENERATIONS: GenerationAuthorities = { stop: { known: false }, execution: { known: false } };
// 시험에서 받는 쪽이 아는 세대: 정지 세대 7(받아 둔 준비 8), 실행 세대 3.
export const KNOWN_GENERATIONS: GenerationAuthorities = { stop: { known: true, current: 7, prepared: 8 }, execution: { known: true, current: 3, prepared: null } };

export interface CaseContext {
  now: number;
  expected_recipient: Party;
  own_policy_revision: string;
  handshake: HandshakeState;
  intake_open: boolean;
  generations: GenerationAuthorities;
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
    generations: UNKNOWN_GENERATIONS,
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
    generations: c.generations,
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
const probe = (from: Party, duringClosedIntake: boolean, generations: GenerationRules): EffectSpec => ({
  class: "effect",
  from: [from],
  duringClosedIntake,
  duringPolicyMismatch: false,
  generations,
  parse: (body) => effectBody({ note_digest: sha256, ...generationShape(generations) })(body, "body"),
  parseResult: probeResult,
});
export const PROBE_BUNDLE: Bundle = {
  name: "probe",
  actions: {
    // 일반 효과: 정지 세대가 지금과 같아야 한다. 실행과 무관.
    probe_effect: probe("front-door", false, { stop: "current", execution: "not_applicable" }),
    probe_effect_closed_ok: probe("front-door", true, { stop: "current", execution: "not_applicable" }),
    // 실행에 속한 효과: 두 세대 모두 지금과 같아야 한다.
    probe_return: probe("supervisor", false, { stop: "current", execution: "current" }),
    // 새 정지의 준비(지금 + 1)와 준비에 묶인 확정.
    probe_stop_prepare: probe("front-door", true, { stop: "next", execution: "not_applicable" }),
    probe_stop_commit: probe("front-door", true, { stop: "prepared_newer", execution: "not_applicable" }),
  },
};
export const PROBE: Contract = defineContract([COMMON_BUNDLE, PROBE_BUNDLE]);

export const PROBE_NOTE = "a".repeat(64);

// probe 효과의 본문. 세대 칸은 그 동작의 규칙에 KNOWN_GENERATIONS로 맞는 값이다. over로 칸을 바꾸거나(값 undefined면 뺀다) 더한다.
export function probeBody(action: string, jobId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const spec = PROBE.actions[action];
  if (spec?.class !== "effect") throw new Error(`probe 효과가 아니다: ${action}`);
  const body: Record<string, unknown> = { job_id: jobId, note_digest: PROBE_NOTE };
  for (const kind of GENERATION_KINDS) {
    const rule = spec.generations[kind];
    const known = KNOWN_GENERATIONS[kind];
    if (rule === "not_applicable" || !known.known) continue;
    body[GENERATION_FIELDS[kind]] = rule === "current" ? known.current : rule === "prepared_newer" || rule === "prepared_current" ? known.prepared : known.current + 1;
  }
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete body[key];
    else body[key] = value;
  }
  return body;
}

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
