import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, Dynamo } from "../src/index.ts";

const { joinCrdt, joinContexts, emptyCrdt, counterValue, setElements } = Dynamo;
type Crdt = Dynamo.Crdt;
type OrSet = Dynamo.OrSet;
type Dot = Dynamo.Dot;

const NODES = ["A", "B", "C"];
const ELEMENTS = ["apple", "pear", "fig"];
const same = (a: Crdt, b: Crdt) =>
  expect(canonicalJson(a as never)).toBe(canonicalJson(b as never));
const joinAll = (states: readonly Crdt[], init: Crdt) =>
  states.reduce((a, b) => joinCrdt(a, b), init);

/** Counter deltas as coordinators send them: each its own running total. */
const counterDeltasArb = fc
  .array(fc.tuple(fc.constantFrom(...NODES), fc.integer({ min: 1, max: 5 })), { maxLength: 10 })
  .map((incrs) => {
    const totals: Record<string, number> = {};
    return incrs.map(([node, by]): Crdt => {
      totals[node] = (totals[node] ?? 0) + by;
      return { type: "counter", counts: { [node]: totals[node] } };
    });
  });

const addDelta = (element: string, tag: Dot): OrSet => ({
  type: "set",
  entries: { [element]: [tag] },
  context: joinContexts([], [tag]),
});
const removeDelta = (observed: readonly Dot[]): OrSet => ({
  type: "set",
  entries: {},
  context: joinContexts([], observed),
});

/**
 * Set deltas as coordinators send them: adds with fresh tags, and removes of the tags of an
 * element some earlier subset of deltas showed.
 */
const setDeltasArb = fc
  .array(
    fc.tuple(
      fc.boolean(),
      fc.constantFrom(...NODES),
      fc.constantFrom(...ELEMENTS),
      fc.array(fc.nat(), { maxLength: 3 }),
    ),
    { maxLength: 10 },
  )
  .map((steps) => {
    const counters: Record<string, number> = {};
    const deltas: OrSet[] = [];
    const removedTags: Dot[] = [];
    for (const [isAdd, node, element, picks] of steps) {
      if (isAdd || deltas.length === 0) {
        counters[node] = (counters[node] ?? 0) + 1;
        deltas.push(addDelta(element, { node, counter: counters[node] }));
      } else {
        const seen = joinAll(
          picks.map((p) => deltas[p % deltas.length]!),
          emptyCrdt("set"),
        ) as OrSet;
        const observed = seen.entries[element] ?? [];
        removedTags.push(...observed);
        deltas.push(removeDelta(observed));
      }
    }
    return { deltas, removedTags };
  });

describe("counters", () => {
  it("join is commutative, associative and idempotent, and never double-counts", () => {
    fc.assert(
      fc.property(counterDeltasArb, fc.array(fc.nat()), (deltas, order) => {
        const total = joinAll(deltas, emptyCrdt("counter"));
        const shuffled = [...deltas].sort(
          (a, b) => (order[deltas.indexOf(a)] ?? 0) - (order[deltas.indexOf(b)] ?? 0),
        );
        same(joinAll([...shuffled, ...shuffled], emptyCrdt("counter")), total);
        // Each coordinator's last total is its share of the value.
        const expected: Record<string, number> = {};
        for (const d of deltas) Object.assign(expected, (d as Dynamo.Counter).counts);
        expect(counterValue(total as Dynamo.Counter)).toBe(
          Object.values(expected).reduce((a, b) => a + b, 0),
        );
      }),
    );
  });

  it("summing entries (the planted bug) double-counts redelivered updates", () => {
    const d: Crdt = { type: "counter", counts: { A: 2 } };
    expect(counterValue(joinCrdt(d, d, { sumCounters: true }) as Dynamo.Counter)).toBe(4);
    expect(counterValue(joinCrdt(d, d) as Dynamo.Counter)).toBe(2);
  });
});

describe("observed-remove sets", () => {
  it("join is commutative, associative and idempotent", () => {
    fc.assert(
      fc.property(setDeltasArb, fc.nat(), fc.nat(), ({ deltas }, i, j) => {
        const a = joinAll(deltas.slice(0, i % (deltas.length + 1)), emptyCrdt("set"));
        const b = joinAll(deltas.slice(j % (deltas.length + 1)), emptyCrdt("set"));
        const c = joinAll(
          deltas.filter((_, k) => k % 2 === 0),
          emptyCrdt("set"),
        );
        same(joinCrdt(a, b), joinCrdt(b, a));
        same(joinCrdt(joinCrdt(a, b), c), joinCrdt(a, joinCrdt(b, c)));
        same(joinCrdt(a, a), a);
      }),
    );
  });

  it("keeps exactly the added tags no remove observed (adds win)", () => {
    fc.assert(
      fc.property(setDeltasArb, ({ deltas, removedTags }) => {
        const all = joinAll([...deltas].reverse(), emptyCrdt("set")) as OrSet;
        for (const d of deltas) {
          for (const [element, tags] of Object.entries(d.entries)) {
            const tag = tags[0]!;
            const present = (all.entries[element] ?? []).some(
              (t) => t.node === tag.node && t.counter === tag.counter,
            );
            const removed = removedTags.some(
              (t) => t.node === tag.node && t.counter === tag.counter,
            );
            expect(present).toBe(!removed);
          }
        }
      }),
    );
  });

  it("an add concurrent with a remove survives it; the planted bug drops it", () => {
    const first = addDelta("milk", { node: "A", counter: 1 });
    const concurrent = addDelta("milk", { node: "B", counter: 1 });
    const remove = removeDelta([{ node: "A", counter: 1 }]);
    const state = joinCrdt(joinCrdt(first, concurrent), remove) as OrSet;
    expect(setElements(state)).toEqual(["milk"]);
    expect(state.entries["milk"]).toEqual([{ node: "B", counter: 1 }]);
    const buggy = joinCrdt(joinCrdt(first, concurrent), remove, { removeAllTags: true }) as OrSet;
    expect(setElements(buggy)).toEqual([]);
  });
});
