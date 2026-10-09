import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonical, Hasher } from "../src/index.ts";

describe("canonicalJson", () => {
  it("is independent of key insertion order", () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(
      canonicalJson({ a: [{ x: 1, y: 2 }], b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("round-trips JSON-compatible values", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(JSON.parse(canonicalJson(v))).toEqual(JSON.parse(JSON.stringify(v)));
      }),
    );
  });

  it("treats undefined fields as absent and -0 as 0", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson(-0)).toBe("0");
  });

  it("rejects values with no canonical form", () => {
    for (const bad of [Number.NaN, Infinity, new Map(), new Set(), () => 0, [undefined], 1n]) {
      expect(() => canonicalJson(bad)).toThrow(TypeError);
    }
  });
});

describe("Hasher", () => {
  it("is order-sensitive and chunking-insensitive", () => {
    expect(new Hasher().update("ab").update("c").digest()).toBe(
      new Hasher().update("abc").digest(),
    );
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
    expect(hashCanonical({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});
