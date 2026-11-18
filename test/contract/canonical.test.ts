import { expect, test } from "bun:test";
import { canonicalJson, digestOf } from "../../src/contract/v1/canonical.ts";

test("canonical: 키를 정렬하고 공백 없이 쓴다(같은 뜻은 같은 바이트)", () => {
  expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 0, y: -0 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}');
  expect(digestOf({ b: 1, a: 2 })).toBe(digestOf({ a: 2, b: 1 }));
  expect(digestOf({ a: 1 })).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
});

test("canonical: 문자열은 JCS와 같은 이스케이프를 쓴다", () => {
  expect(canonicalJson("é\n\"\\\u0001")).toBe('"é\\n\\"\\\\\\u0001"');
  expect(canonicalJson({ "가": 1, b: 2 })).toBe('{"b":2,"가":1}');
});

test("canonical: 같은 뜻이 다른 바이트가 될 수 있는 값은 받지 않는다", () => {
  for (const value of [1.5, 1e21, Number.NaN, Infinity, 2 ** 53, "\ud800", [1, , 2], undefined, () => 1, new Date(0), 10n]) {
    expect(() => canonicalJson(value), String(value)).toThrow();
  }
  let deep: unknown = 1;
  for (let i = 0; i < 20; i++) deep = [deep];
  expect(() => canonicalJson(deep)).toThrow();
});
