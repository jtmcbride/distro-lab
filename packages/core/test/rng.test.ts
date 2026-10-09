import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Rng } from "../src/index.ts";

const draw = (rng: Rng, n: number) => Array.from({ length: n }, () => rng.nextUint32());

describe("Rng", () => {
  it("is reproducible for a seed", () => {
    fc.assert(
      fc.property(fc.maxSafeInteger(), (seed) => {
        expect(draw(Rng.fromSeed(seed), 50)).toEqual(draw(Rng.fromSeed(seed), 50));
      }),
    );
  });

  it("matches a pinned sequence (guards against accidental algorithm changes)", () => {
    expect(draw(Rng.fromSeed(42), 4)).toMatchInlineSnapshot(`
      [
        1028872839,
        2516511472,
        400437680,
        853279530,
      ]
    `);
  });

  it("separates nearby seeds", () => {
    expect(draw(Rng.fromSeed(1), 8)).not.toEqual(draw(Rng.fromSeed(2), 8));
  });

  it("resumes from a saved state", () => {
    const rng = Rng.fromSeed(7);
    draw(rng, 13);
    const copy = Rng.fromState(rng.getState());
    expect(draw(copy, 20)).toEqual(draw(rng, 20));
  });

  it("derives streams independently of draw count on the parent", () => {
    const a = Rng.fromSeed(99);
    const b = Rng.fromSeed(99);
    draw(b, 1000);
    expect(draw(a.stream("node:A"), 10)).toEqual(draw(b.stream("node:A"), 10));
  });

  it("gives different labels different streams", () => {
    const root = Rng.fromSeed(5);
    expect(draw(root.stream("node:A"), 8)).not.toEqual(draw(root.stream("node:B"), 8));
    expect(draw(root.stream("net"), 8)).not.toEqual(draw(root, 8));
  });

  it("int stays within inclusive bounds", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: -1000, max: 1000 }), fc.nat(1000), (s, lo, w) => {
        const v = Rng.fromSeed(s).int(lo, lo + w);
        expect(v).toBeGreaterThanOrEqual(lo);
        expect(v).toBeLessThanOrEqual(lo + w);
      }),
    );
  });

  it("chance does not consume randomness at 0 or 1", () => {
    const a = Rng.fromSeed(3);
    const b = Rng.fromSeed(3);
    a.chance(0);
    a.chance(1);
    expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it("is roughly uniform", () => {
    const rng = Rng.fromSeed(123);
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) buckets[Math.floor(rng.next() * 10)]!++;
    for (const c of buckets) expect(Math.abs(c - n / 10)).toBeLessThan(n / 100);
  });
});
