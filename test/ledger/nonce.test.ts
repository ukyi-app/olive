import { expect, test } from "bun:test";
import { limits } from "../../src/contract/v1/index.ts";
import { NOW, open, tempPath } from "./helpers.ts";

const nonce = "0123456789abcdef0123456789abcdef";
const sender = "executor/diagnosis/0/store-a";

test("nonce: 한 번만 성공하고 재시작 뒤에도 재사용을 거부한다", () => {
  const path = tempPath();
  const store = open(path).nonceStore();
  expect(store.consume(sender, nonce, NOW + 30_000)).toBe(true);
  expect(store.consume(sender, nonce, NOW + 30_000)).toBe(false);
  // 낸 쪽이 다르면 다른 nonce다.
  expect(store.consume("front-door", nonce, NOW + 30_000)).toBe(true);
});

test("nonce: 재시작 뒤에도 재사용을 거부한다", () => {
  const path = tempPath();
  const first = open(path);
  expect(first.nonceStore().consume(sender, nonce, NOW + 30_000)).toBe(true);
  first.close();
  expect(open(path).nonceStore().consume(sender, nonce, NOW + 30_000)).toBe(false);
});

test("nonce: 보존 기간이 지난 기록만 지운다", () => {
  const path = tempPath();
  let now = NOW;
  const store = open(path, { clock: () => now }).nonceStore();
  expect(store.consume(sender, nonce, NOW)).toBe(true);
  now = NOW + limits.NONCE_RETENTION_MS;
  expect(store.consume(sender, nonce, NOW)).toBe(false);
  now = NOW + limits.NONCE_RETENTION_MS + 1;
  expect(store.consume(sender, nonce, NOW)).toBe(true);
});

test("nonce: 장부를 쓸 수 없으면 재사용(false)으로 꾸미지 않고 던진다", () => {
  const ledger = open(tempPath());
  const store = ledger.nonceStore();
  ledger.close();
  expect(() => store.consume(sender, nonce, NOW + 1)).toThrow("ledger unavailable");
});
