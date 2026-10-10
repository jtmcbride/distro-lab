import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, Dynamo } from "../src/index.ts";

const { compareClocks, coversWrite, mergeClocks, mergeVersions, preferenceList } = Dynamo;
type Version = Dynamo.Version;

const NODES = ["A", "B", "C"];
const clockArb = fc
  .tuple(...NODES.map(() => fc.integer({ min: 0, max: 3 })))
  .map((counts) =>
    Object.fromEntries(NODES.flatMap((n, i) => (counts[i] ? [[n, counts[i]]] : []))),
  );
// Versions get a write id derived from their clock, so equal clocks are the same write.
const versionArb = clockArb.map((clock): Version => {
  const write = canonicalJson(clock);
  return { value: write, clock, write };
});
const setArb = fc.array(versionArb, { maxLength: 6 }).map((vs) => mergeVersions([], vs));
const same = (a: readonly Version[], b: readonly Version[]) =>
  expect(canonicalJson(a as never)).toBe(canonicalJson(b as never));

describe("vector clocks", () => {
  it("compare", () => {
    expect(compareClocks({}, {})).toBe("equal");
    expect(compareClocks({ A: 1 }, { A: 1, B: 0 })).toBe("equal");
    expect(compareClocks({ A: 1 }, { A: 2 })).toBe("before");
    expect(compareClocks({ A: 1, B: 1 }, { A: 1 })).toBe("after");
    expect(compareClocks({ A: 1 }, { B: 1 })).toBe("concurrent");
  });

  it("order is antisymmetric and merge is an upper bound", () => {
    const flip = { before: "after", after: "before", equal: "equal", concurrent: "concurrent" };
    fc.assert(
      fc.property(clockArb, clockArb, (a, b) => {
        expect(compareClocks(b, a)).toBe(flip[compareClocks(a, b)]);
        const m = mergeClocks([a, b]);
        expect(["after", "equal"]).toContain(compareClocks(m, a));
        expect(["after", "equal"]).toContain(compareClocks(m, b));
      }),
    );
  });
});

describe("mergeVersions", () => {
  it("is a join: commutative, associative, idempotent", () => {
    fc.assert(
      fc.property(setArb, setArb, setArb, (a, b, c) => {
        same(mergeVersions(a, b), mergeVersions(b, a));
        same(mergeVersions(mergeVersions(a, b), c), mergeVersions(a, mergeVersions(b, c)));
        same(mergeVersions(a, a), a);
      }),
    );
  });

  it("keeps exactly the versions nothing else dominates, pairwise concurrent", () => {
    fc.assert(
      fc.property(setArb, setArb, (a, b) => {
        const m = mergeVersions(a, b);
        for (const v of [...a, ...b]) {
          const kept = m.some((w) => canonicalJson(w.clock) === canonicalJson(v.clock));
          const dominated = [...a, ...b].some((w) => compareClocks(v.clock, w.clock) === "before");
          expect(kept).toBe(!dominated);
          expect(coversWrite(m, v.clock, v.write)).toBe(true);
        }
        for (const x of m) {
          for (const y of m)
            if (x !== y) expect(compareClocks(x.clock, y.clock)).toBe("concurrent");
        }
      }),
    );
  });

  it("returns the first set itself when nothing changes", () => {
    const a = mergeVersions([], [{ value: "x", clock: { A: 2 }, write: "c1#1" }]);
    expect(mergeVersions(a, [{ value: "y", clock: { A: 1 }, write: "c1#0" }])).toBe(a);
    expect(mergeVersions(a, [])).toBe(a);
    expect(mergeVersions(a, [{ value: "y", clock: { B: 1 }, write: "c2#1" }])).not.toBe(a);
  });

  it("does not count an equal clock on another write as covering it", () => {
    const stored = [{ value: "x", clock: { A: 1 }, write: "c1#1" }];
    expect(coversWrite(stored, { A: 1 }, "c1#1")).toBe(true);
    expect(coversWrite(stored, { A: 1 }, "c2#1")).toBe(false);
    expect(coversWrite(stored, {}, "c2#1")).toBe(true);
  });
});

describe("preference lists", () => {
  const servers = ["A", "B", "C", "D", "E"];

  it("list every server once and depend only on the key and the server set", () => {
    for (let i = 0; i < 100; i++) {
      const list = preferenceList(servers, `k${i}`);
      expect([...list].sort()).toEqual(servers);
      expect(preferenceList([...servers].reverse(), `k${i}`)).toEqual(list);
    }
  });

  it("spread keys across servers", () => {
    const first = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const head = preferenceList(servers, `key-${i}`)[0]!;
      first.set(head, (first.get(head) ?? 0) + 1);
    }
    for (const s of servers) expect(first.get(s) ?? 0).toBeGreaterThan(2000 / servers.length / 3);
  });
});
