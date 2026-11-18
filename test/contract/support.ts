// 시험이 함께 쓰는 도구: 사례의 맥락을 검증 맥락으로 바꾸고, 메모리 nonce 저장소를 만든다.
import { digestOf } from "../../src/contract/v1/canonical.ts";
import { publicKeyFromRaw, type NonceStore, signUnchecked, type VerifyContext, verifyEnvelope } from "../../src/contract/v1/envelope.ts";
import type { CaseContext, ContractCase, Keys } from "./cases.ts";

export class MemoryNonces implements NonceStore {
  readonly spent = new Set<string>();
  consume(sender: string, nonce: string): boolean {
    const key = `${sender} ${nonce}`;
    if (this.spent.has(key)) return false;
    this.spent.add(key);
    return true;
  }
}

export function contextOf(keys: Record<string, string>, context: CaseContext, nonces = new MemoryNonces()): VerifyContext {
  const trusted = new Map(Object.entries(keys).map(([name, raw]) => [name, publicKeyFromRaw(raw)]));
  for (const { sender, nonce } of context.spent_nonces) nonces.spent.add(`${sender} ${nonce}`);
  const runs = context.run_generations;
  return {
    now: context.now,
    expectedRecipient: context.expected_recipient,
    publicKeyFor: (sender) => trusted.get(sender),
    stopGeneration: context.stop_generation,
    runGeneration: (runId) => (Object.hasOwn(runs, runId) ? runs[runId] : undefined),
    nonces,
  };
}

export function verifyCase(c: Pick<ContractCase, "keys" | "context" | "message">, nonces?: MemoryNonces) {
  return verifyEnvelope(c.message, contextOf(c.keys, c.context, nonces));
}

// 기준 사례를 골라 본문만 바꾸고 digest·서명을 다시 맞춘다. 본문 규칙만 시험할 때 쓴다(다른 칸은 모두 맞다).
export function withBody(cases: ContractCase[], keys: Keys, name: string, change: (body: Record<string, unknown>) => unknown) {
  const base = cases.find((c) => c.name === `accept/${name}`);
  if (!base) throw new Error(`사례가 없다: ${name}`);
  const body = structuredClone(base.message.body) as Record<string, unknown>;
  const next = (change(body) ?? body) as unknown;
  const header = { ...base.message.header, body_digest: digestOf(next) };
  return { ...base, message: signUnchecked(header, next, keys[header.sender]!.privateKey) };
}

// 두 JSON 값의 다른 잎 경로. 객체 칸은 `.칸`, 배열은 `[i]`로 쓴다. 한쪽에만 있는 칸도 다른 것으로 센다.
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
