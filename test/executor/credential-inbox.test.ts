// 자격 값 우편함의 보장: 한 칸, 실행 ID·지문·연결 번호가 모두 맞을 때만 한 번 내준다, 버리는 때마다 0으로 채운다.
// 연결 번호는 시험이 바꾸는 가짜 함수다. 값의 비교는 불리언과 digest로만 단언한다(실패한 단언이 값을 싣지 않게).
import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createCredentialInbox, type CredentialInbox } from "../../src/executor/credential-inbox.ts";
import type { DecodedCredential } from "../../src/transport/framing.ts";
import { sha256 } from "./support.ts";

interface Box {
  inbox: CredentialInbox;
  epoch: number | null;
}
function box(epoch: number | null = 1): Box {
  const b: Box = { inbox: undefined as unknown as CredentialInbox, epoch };
  b.inbox = createCredentialInbox({ epoch: () => b.epoch });
  return b;
}

// 값 틀 하나. digest는 값의 SHA-256이 기본이다.
function credential(runId: string, value: Uint8Array = randomBytes(48), digest = sha256(value)): DecodedCredential & { readonly sum: string } {
  return { runId, digest, value, sum: sha256(value) };
}
const zeroed = (value: Uint8Array) => value.every((byte) => byte === 0);
// 받은 배열이 그 값인지 digest로만 본다.
const sumOf = (value: Uint8Array | null) => (value === null ? null : sha256(value));
const settledWithin = async <T>(promise: Promise<T>): Promise<{ done: boolean; value?: T }> => {
  const marker = Symbol();
  const result = await Promise.race([promise, new Promise<typeof marker>((resolve) => setTimeout(() => resolve(marker), 10))]);
  return result === marker ? { done: false } : { done: true, value: result as T };
};

test("우편함: 값이 take보다 먼저 와도, 나중에 와도 그 실행에 한 번 내준다", async () => {
  const b = box();
  const run = randomUUID();
  const early = credential(run);
  expect(b.inbox.offer(1, early)).toBe("held");
  const got = await b.inbox.take(run, early.digest, new AbortController().signal);
  expect(sumOf(got)).toBe(early.sum);
  // 내준 뒤 칸은 비었고 같은 실행에 다시 내주지 않는다.
  expect((await b.inbox.take(run, early.digest, new AbortController().signal)) === null).toBe(true);

  const later = randomUUID();
  const late = credential(later);
  const waiting = b.inbox.take(later, late.digest, new AbortController().signal);
  expect((await settledWithin(waiting)).done).toBe(false);
  expect(b.inbox.offer(1, late)).toBe("handed");
  expect(sumOf(await waiting)).toBe(late.sum);
});

test("우편함: 다른 실행·다른 지문·옛 연결 번호의 값은 내주지 않고 0으로 채운다", async () => {
  const b = box(2);
  const run = randomUUID();
  const right = credential(run);
  const taking = b.inbox.take(run, right.digest, new AbortController().signal);
  const other = credential(randomUUID());
  const wrongDigest = credential(run, randomBytes(48), sha256("다른 값"));
  const oldEpoch = credential(run, new Uint8Array(right.value));
  expect(b.inbox.offer(2, other)).toBe("discarded");
  expect(b.inbox.offer(2, wrongDigest)).toBe("discarded");
  expect(b.inbox.offer(1, oldEpoch)).toBe("discarded");
  expect([zeroed(other.value), zeroed(wrongDigest.value), zeroed(oldEpoch.value)]).toEqual([true, true, true]);
  expect((await settledWithin(taking)).done).toBe(false);

  // 칸에 먼저 온 값도 같다: take의 지문·연결 번호가 다르면 내주지 않고 0으로 채운다.
  const c = box(5);
  const held = [credential(randomUUID()), credential(randomUUID())];
  expect(c.inbox.offer(5, held[0]!)).toBe("held");
  expect((await settledWithin(c.inbox.take(held[0]!.runId, sha256("다른 지문"), new AbortController().signal))).done).toBe(false);
  expect(zeroed(held[0]!.value)).toBe(true);
  const d = box(5);
  expect(d.inbox.offer(5, held[1]!)).toBe("held");
  d.epoch = 6;
  expect((await settledWithin(d.inbox.take(held[1]!.runId, held[1]!.digest, new AbortController().signal))).done).toBe(false);
  expect(zeroed(held[1]!.value)).toBe(true);
  // 맞춘 연결이 없을 때 온 값도 받지 않는다.
  const none = box(null);
  const orphan = credential(randomUUID());
  expect(none.inbox.offer(1, orphan)).toBe("discarded");
  expect(zeroed(orphan.value)).toBe(true);
});

test("우편함: take가 중단되면 null이고, 그 뒤 늦게 온 그 실행의 값은 내주지 않고 0으로 채운다", async () => {
  const b = box();
  const run = randomUUID();
  const controller = new AbortController();
  const waiting = b.inbox.take(run, sha256("x"), controller.signal);
  controller.abort();
  expect((await waiting) === null).toBe(true);
  const late = credential(run);
  expect(b.inbox.offer(1, late)).toBe("discarded");
  expect(zeroed(late.value)).toBe(true);
  expect((await b.inbox.take(run, late.digest, new AbortController().signal)) === null).toBe(true);

  // 이미 중단된 signal로 부르면 칸의 그 실행 값도 버린다.
  const c = box();
  const early = credential(randomUUID());
  c.inbox.offer(1, early);
  const aborted = new AbortController();
  aborted.abort();
  expect((await c.inbox.take(early.runId, early.digest, aborted.signal)) === null).toBe(true);
  expect(zeroed(early.value)).toBe(true);

  // 내준 뒤 중단되면 내준 배열도 0으로 채운다(작업자가 받지 못한 경합에서 값이 남지 않게).
  const d = box();
  const lent = credential(randomUUID());
  const lending = new AbortController();
  d.inbox.offer(1, lent);
  const got = await d.inbox.take(lent.runId, lent.digest, lending.signal);
  expect(sumOf(got)).toBe(lent.sum);
  lending.abort();
  expect(zeroed(got!)).toBe(true);
});

test("우편함: 같은 실행에 값이 둘 오면 첫 값 하나만 쓰고 둘째는 0으로 채운다", async () => {
  const b = box();
  const run = randomUUID();
  const first = credential(run);
  const second = credential(run, new Uint8Array(first.value));
  expect(b.inbox.offer(1, first)).toBe("held");
  expect(b.inbox.offer(1, second)).toBe("discarded");
  expect(zeroed(second.value)).toBe(true);
  const got = await b.inbox.take(run, first.digest, new AbortController().signal);
  expect(got === first.value).toBe(true);
  // 내준 뒤에 온 같은 실행의 값도 버린다.
  const third = credential(run, randomBytes(48), first.digest);
  expect(b.inbox.offer(1, third)).toBe("discarded");
  expect(zeroed(third.value)).toBe(true);
});

test("우편함: 다른 실행의 값이 새로 오면 칸의 앞 값을 0으로 채워 버린다", async () => {
  const b = box();
  const a = credential(randomUUID());
  const c = credential(randomUUID());
  expect(b.inbox.offer(1, a)).toBe("held");
  expect(b.inbox.offer(1, c)).toBe("held");
  expect(zeroed(a.value)).toBe(true);
  expect((await settledWithin(b.inbox.take(a.runId, a.digest, new AbortController().signal))).done).toBe(false);
});

test("우편함: 연결이 끝나면 그 연결의 칸을 비우고 0으로 채우며, 그 연결에서 기다리던 take는 null이다", async () => {
  const b = box(3);
  const held = credential(randomUUID());
  b.inbox.offer(3, held);
  b.inbox.dropEpoch(2);
  expect(zeroed(held.value)).toBe(false);
  b.inbox.dropEpoch(3);
  expect(zeroed(held.value)).toBe(true);
  b.epoch = 4;
  expect((await settledWithin(b.inbox.take(held.runId, held.digest, new AbortController().signal))).done).toBe(false);

  const c = box(7);
  const waiting = c.inbox.take(randomUUID(), sha256("y"), new AbortController().signal);
  c.inbox.dropEpoch(7);
  expect((await waiting) === null).toBe(true);
});

test("우편함: 실행을 잊으면 그 실행의 칸·내준 값을 0으로 채우고, 뒤에 온 그 실행의 값을 버린다", async () => {
  const b = box();
  const unused = credential(randomUUID());
  b.inbox.offer(1, unused);
  b.inbox.forget(unused.runId);
  expect(zeroed(unused.value)).toBe(true);
  const late = credential(unused.runId);
  expect(b.inbox.offer(1, late)).toBe("discarded");
  expect(zeroed(late.value)).toBe(true);

  const used = credential(randomUUID());
  b.inbox.offer(1, used);
  const got = await b.inbox.take(used.runId, used.digest, new AbortController().signal);
  expect(zeroed(got!)).toBe(false);
  b.inbox.forget(used.runId);
  expect(zeroed(got!)).toBe(true);
});

test("우편함: 주입받은 signal의 리스너 떼기가 던져도 forget은 던지지 않고 정리를 끝내며, 다음 실행의 take를 막지 않는다", async () => {
  const b = box();
  const used = credential(randomUUID());
  b.inbox.offer(1, used);
  const signal = new AbortController().signal;
  signal.removeEventListener = () => {
    throw new Error("리스너 떼기 실패");
  };
  const got = await b.inbox.take(used.runId, used.digest, signal);
  expect(zeroed(got!)).toBe(false);
  let threw = false;
  try {
    b.inbox.forget(used.runId);
  } catch {
    threw = true;
  }
  expect(threw).toBe(false);
  expect(zeroed(got!)).toBe(true);
  // 끝난 take의 기록이 치워져 다음 실행의 값을 내준다.
  const next = credential(randomUUID());
  b.inbox.offer(1, next);
  expect(sumOf(await b.inbox.take(next.runId, next.digest, new AbortController().signal))).toBe(next.sum);
});

test("우편함: 떼지 못한 옛 실행의 중단 리스너가 늦게 불려도 다음 실행들의 상태를 바꾸지 않는다", async () => {
  const b = box();
  const a = credential(randomUUID());
  const runB = credential(randomUUID());
  const c = credential(randomUUID());
  const stale = new AbortController();
  stale.signal.removeEventListener = () => {
    throw new Error("리스너 떼기 실패");
  };
  b.inbox.offer(1, a);
  expect((await b.inbox.take(a.runId, a.digest, stale.signal)) === a.value).toBe(true);
  b.inbox.forget(a.runId);
  // B는 기다리다 취소되고 정리된다.
  const cancelB = new AbortController();
  const waitingB = b.inbox.take(runB.runId, runB.digest, cancelB.signal);
  cancelB.abort();
  expect((await waitingB) === null).toBe(true);
  b.inbox.forget(runB.runId);
  expect(b.inbox.offer(1, c)).toBe("held");
  // A의 리스너는 forget에서 떼지 못했으므로 여기서 불린다.
  stale.abort();
  expect(b.inbox.offer(1, runB)).toBe("discarded");
  expect([zeroed(runB.value), zeroed(c.value)]).toEqual([true, false]);
  expect((await b.inbox.take(c.runId, c.digest, new AbortController().signal)) === c.value).toBe(true);
});

test("우편함: 기다리는 take가 있는데 또 부르면 뒤 take는 곧바로 null이고 앞 take는 그대로 기다린다", async () => {
  const b = box();
  const v = credential(randomUUID());
  const first = b.inbox.take(v.runId, v.digest, new AbortController().signal);
  expect((await b.inbox.take(randomUUID(), sha256("z"), new AbortController().signal)) === null).toBe(true);
  expect((await b.inbox.take(v.runId, v.digest, new AbortController().signal)) === null).toBe(true);
  expect(b.inbox.offer(1, v)).toBe("handed");
  expect(sumOf(await first)).toBe(v.sum);
});

test("우편함: 객체를 직렬화·열거해도 값·실행 ID·지문이 보이지 않는다", () => {
  const b = box();
  const v = credential(randomUUID(), new TextEncoder().encode(`secret-${randomBytes(8).toString("hex")}`));
  const text = new TextDecoder().decode(v.value);
  const shown = (inbox: CredentialInbox) => [JSON.stringify(inbox), Object.keys(inbox).join(","), String(inbox)].join("|");
  // 칸에 값이 있을 때.
  b.inbox.offer(1, v);
  expect(zeroed(v.value)).toBe(false);
  expect([text, v.runId, v.digest].map((part) => shown(b.inbox).includes(part))).toEqual([false, false, false]);
  // 기다리는 take가 있을 때.
  const c = box();
  const run = randomUUID();
  void c.inbox.take(run, v.digest, new AbortController().signal);
  expect([run, v.digest].map((part) => shown(c.inbox).includes(part))).toEqual([false, false]);
});
