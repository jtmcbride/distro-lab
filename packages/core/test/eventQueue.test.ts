import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EventQueue } from "../src/index.ts";

function drain<T>(q: EventQueue<T>) {
  const out = [];
  for (let e = q.pop(); e; e = q.pop()) out.push(e);
  return out;
}

describe("EventQueue", () => {
  it("pops in (time, insertion) order", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(50), { maxLength: 300 }), (times) => {
        const q = new EventQueue<number>();
        times.forEach((t, i) => q.push(t, i));
        const popped = drain(q);
        const expected = times
          .map((t, i) => ({ t, i }))
          .sort((x, y) => x.t - y.t || x.i - y.i)
          .map((x) => x.i);
        expect(popped.map((e) => e.item)).toEqual(expected);
      }),
    );
  });

  it("handles interleaved push and pop", () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.nat(100), { nil: undefined }), { maxLength: 300 }),
        (ops) => {
          const q = new EventQueue<number>();
          const model: { t: number; seq: number }[] = [];
          for (const op of ops) {
            if (op === undefined) {
              model.sort((x, y) => x.t - y.t || x.seq - y.seq);
              const want = model.shift();
              expect(q.pop()?.seq).toBe(want?.seq);
            } else {
              const e = q.push(op, op);
              model.push({ t: op, seq: e.seq });
            }
            expect(q.size).toBe(model.length);
          }
        },
      ),
    );
  });

  it("round-trips through a snapshot", () => {
    const q = new EventQueue<string>();
    for (const [t, s] of [
      [5, "a"],
      [1, "b"],
      [5, "c"],
      [3, "d"],
    ] as const)
      q.push(t, s);
    q.pop();
    const restored = EventQueue.fromEntries(q.toSortedArray(), q.seqCounter);
    expect(drain(restored)).toEqual(drain(q));
    expect(restored.push(0, "x").seq).toBe(4);
  });

  it("rejects non-finite times", () => {
    expect(() => new EventQueue().push(Number.NaN, 0)).toThrow(RangeError);
  });
});
