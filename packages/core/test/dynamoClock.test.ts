import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, Dynamo } from "../src/index.ts";

const { compareClocks, contextOf, coversWrite, includes, mergeClocks, mergeVersions } = Dynamo;
const { preferenceList } = Dynamo;
type Version = Dynamo.Version;

const NODES = ["A", "B", "C"];
const clockArb = fc
  .tuple(...NODES.map(() => fc.integer({ min: 0, max: 3 })))
  .map((counts) =>
    Object.fromEntries(NODES.flatMap((n, i) => (counts[i] ? [[n, counts[i]]] : []))),
  );

/**
 * A realistic write history: each write goes through a random coordinator (fresh counter)
 * with the context of a random subset of earlier writes, as a client's read would give it.
 */
const historyArb = fc
  .array(fc.tuple(fc.constantFrom(...NODES), fc.array(fc.nat(), { maxLength: 3 })), {
    minLength: 1,
    maxLength: 8,
  })
  .map((writes) => {
    const counters: Record<string, number> = {};
    const versions: Version[] = [];
    writes.forEach(([node, picks], i) => {
      const seen = versions.length === 0 ? [] : picks.map((p) => versions[p % versions.length]!);
      counters[node] = (counters[node] ?? 0) + 1;
      versions.push({
        value: `v${i}`,
        dot: { node, counter: counters[node] },
        context: contextOf(seen),
        write: `w${i}`,
      });
    });
    return versions;
  });
const setsArb = historyArb.chain((versions) =>
  fc
    .tuple(...[0, 1, 2].map(() => fc.subarray(versions)))
    .map((subsets) => subsets.map((s) => mergeVersions([], s))),
);
const same = (a: readonly Version[], b: readonly Version[]) =>
  expect(canonicalJson(a as never)).toBe(canonicalJson(b as never));
const write = (node: string, counter: number, context = {}, value = `${node}${counter}`) => ({
  value,
  dot: { node, counter },
  context,
  write: value,
});

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
      fc.property(setsArb, ([a, b, c]) => {
        same(mergeVersions(a!, b!), mergeVersions(b!, a!));
        same(mergeVersions(mergeVersions(a!, b!), c!), mergeVersions(a!, mergeVersions(b!, c!)));
        same(mergeVersions(a!, a!), a!);
      }),
    );
  });

  it("keeps exactly the versions no other includes, and accounts for every input", () => {
    fc.assert(
      fc.property(setsArb, ([a, b]) => {
        const all = [...a!, ...b!];
        const m = mergeVersions(a!, b!);
        for (const v of all) {
          const kept = m.includes(v);
          expect(kept).toBe(!all.some((w) => w !== v && includes(w, v)));
          expect(coversWrite(m, v.dot, v.write)).toBe(true);
        }
        for (const x of m) for (const y of m) if (x !== y) expect(includes(x, y)).toBe(false);
      }),
    );
  });

  it("keeps concurrent writes through one coordinator as siblings", () => {
    // Neither writer saw the other: counters 1 and 2 from A must not order them.
    const first = write("A", 1);
    const second = write("A", 2);
    expect(mergeVersions([first], [second])).toEqual([first, second]);
    // A writer that read the first replaces it.
    const third = write("B", 1, contextOf([first]));
    expect(mergeVersions([first, second], [third])).toEqual([second, third]);
  });

  it("returns the first set itself when nothing changes", () => {
    const a = [write("A", 2, { A: 1 })];
    expect(mergeVersions(a, [write("A", 1)])).toBe(a);
    expect(mergeVersions(a, [])).toBe(a);
    expect(mergeVersions(a, [write("B", 1)])).not.toBe(a);
  });

  it("does not count the same dot on another write as covering it", () => {
    const stored = [write("A", 1, {}, "x")];
    expect(coversWrite(stored, { node: "A", counter: 1 }, "x")).toBe(true);
    expect(coversWrite(stored, { node: "A", counter: 1 }, "y")).toBe(false);
    expect(coversWrite([write("B", 1, { A: 1 })], { node: "A", counter: 1 }, "y")).toBe(true);
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
