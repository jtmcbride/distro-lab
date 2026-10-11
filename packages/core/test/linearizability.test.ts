import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  LinearizabilityChecker,
  Raft,
  type Model,
  type TraceRecord,
} from "../src/index.ts";

/** Registers on a few keys: get, put, and cas (a failed cas returns the current value). */
type Op =
  | { type: "get"; key: string }
  | { type: "put"; key: string; value: number }
  | { type: "cas"; key: string; expect: number; value: number };
type Out = { ok: boolean; value: number };

const registers: Model<number, Op, Out> = {
  init: () => 0,
  partition: (op) => op.key,
  step(state, op) {
    switch (op.type) {
      case "get":
        return { state, output: { ok: true, value: state } };
      case "put":
        return { state: op.value, output: { ok: true, value: op.value } };
      case "cas":
        return op.expect === state
          ? { state: op.value, output: { ok: true, value: op.value } }
          : { state, output: { ok: false, value: state } };
    }
  },
};

type Event = { kind: "invoke"; id: string; op: Op } | { kind: "complete"; id: string; out: Out };

/** Index of the first `complete` the checker rejects, or -1. */
function frontierFirstFailure(events: readonly Event[]): number {
  const checker = new LinearizabilityChecker(registers);
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "invoke") checker.invoke(e.id, e.op);
    else if (checker.complete(e.id, e.out) !== null) return i;
  }
  return -1;
}

/**
 * Reference: tries every order of the operations that respects real time, with completed
 * operations required and pending ones optional.
 */
function bruteForceLinearizable(events: readonly Event[]): boolean {
  interface Rec {
    id: string;
    op: Op;
    call: number;
    ret: number;
    out: Out | null;
  }
  const ops = new Map<string, Rec>();
  events.forEach((e, i) => {
    if (e.kind === "invoke")
      ops.set(e.id, { id: e.id, op: e.op, call: i, ret: Infinity, out: null });
    else Object.assign(ops.get(e.id)!, { ret: i, out: e.out });
  });
  const all = [...ops.values()];
  const search = (placed: Set<string>, state: Record<string, number>): boolean => {
    if (all.every((o) => o.out === null || placed.has(o.id))) return true;
    for (const o of all) {
      if (placed.has(o.id)) continue;
      // Some unplaced op finished before this one started: it must come first.
      if (all.some((p) => !placed.has(p.id) && p.ret < o.call)) continue;
      const { state: s, output } = registers.step(state[o.op.key] ?? 0, o.op);
      if (o.out !== null && canonicalJson(output) !== canonicalJson(o.out)) continue;
      placed.add(o.id);
      const ok = search(placed, { ...state, [o.op.key]: s });
      placed.delete(o.id);
      if (ok) return true;
    }
    return false;
  };
  return search(new Set(), {});
}

function bruteFirstFailure(events: readonly Event[]): number {
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.kind === "complete" && !bruteForceLinearizable(events.slice(0, i + 1))) return i;
  }
  return -1;
}

/**
 * Random histories from a real register execution (each op takes effect at a random moment
 * while pending), with some outputs corrupted so that both verdicts are common.
 */
const historyArb = fc
  .array(
    fc.record({
      client: fc.nat(2),
      action: fc.nat(2),
      kind: fc.nat(2),
      key: fc.constantFrom("x", "y"),
      a: fc.nat(2),
      b: fc.nat(2),
      corrupt: fc.nat(3),
    }),
    { maxLength: 24 },
  )
  .map((steps) => {
    const events: Event[] = [];
    const state: Record<string, number> = {};
    const running = new Map<number, { id: string; op: Op; out: Out | null }>();
    let n = 0;
    for (const s of steps) {
      const cur = running.get(s.client);
      if (cur === undefined) {
        if (n >= 8) continue;
        const op: Op =
          s.kind === 0
            ? { type: "get", key: s.key }
            : s.kind === 1
              ? { type: "put", key: s.key, value: s.a }
              : { type: "cas", key: s.key, expect: s.a, value: s.b };
        const id = `op${n++}`;
        running.set(s.client, { id, op, out: null });
        events.push({ kind: "invoke", id, op });
      } else if (cur.out === null) {
        // Take effect now.
        const r = registers.step(state[cur.op.key] ?? 0, cur.op);
        state[cur.op.key] = r.state;
        cur.out = r.output;
      } else if (s.action !== 0) {
        // Leave some operations pending forever (action 0 never completes them here).
        const out = s.corrupt === 0 ? { ok: !cur.out.ok, value: s.b } : cur.out;
        events.push({ kind: "complete", id: cur.id, out });
        running.delete(s.client);
      }
    }
    return events;
  });

const inv = (id: string, op: Op): Event => ({ kind: "invoke", id, op });
const ret = (id: string, value: number, ok = true): Event => ({
  kind: "complete",
  id,
  out: { ok, value },
});

describe("LinearizabilityChecker", () => {
  it("accepts a read concurrent with a write returning either value", () => {
    for (const value of [0, 1]) {
      const events = [
        inv("w", { type: "put", key: "x", value: 1 }),
        inv("r", { type: "get", key: "x" }),
        ret("r", value),
        ret("w", 1),
      ];
      expect(frontierFirstFailure(events)).toBe(-1);
    }
  });

  it("rejects a stale read after a completed write", () => {
    const events = [
      inv("w", { type: "put", key: "x", value: 1 }),
      ret("w", 1),
      inv("r", { type: "get", key: "x" }),
      ret("r", 0),
    ];
    expect(frontierFirstFailure(events)).toBe(3);
    const checker = new LinearizabilityChecker(registers);
    for (const e of events.slice(0, 3)) {
      if (e.kind === "invoke") checker.invoke(e.id, e.op);
      else checker.complete(e.id, e.out);
    }
    expect(checker.complete("r", { ok: true, value: 0 })).toEqual({
      id: "r",
      partition: "x",
      input: { type: "get", key: "x" },
      output: { ok: true, value: 0 },
      possible: [{ ok: true, value: 1 }],
    });
  });

  it("rejects reads that see a concurrent write take effect and then un-happen", () => {
    // r1 sees the new value, then r2 (started after r1 returned) sees the old one.
    const events = [
      inv("w", { type: "put", key: "x", value: 1 }),
      inv("r1", { type: "get", key: "x" }),
      ret("r1", 1),
      inv("r2", { type: "get", key: "x" }),
      ret("r2", 0),
    ];
    expect(frontierFirstFailure(events)).toBe(4);
  });

  it("lets a pending write that never completes take effect or not", () => {
    const seesIt = [
      inv("w", { type: "put", key: "x", value: 1 }),
      inv("r", { type: "get", key: "x" }),
      ret("r", 1),
    ];
    const missesIt = [...seesIt.slice(0, 2), ret("r", 0)];
    expect(frontierFirstFailure(seesIt)).toBe(-1);
    expect(frontierFirstFailure(missesIt)).toBe(-1);
    // But once seen, later reads must keep seeing it.
    expect(
      frontierFirstFailure([...seesIt, inv("r2", { type: "get", key: "x" }), ret("r2", 0)]),
    ).toBe(4);
  });

  it("rejects a cas applied twice", () => {
    const events = [
      inv("c", { type: "cas", key: "x", expect: 0, value: 1 }),
      ret("c", 1),
      inv("c2", { type: "cas", key: "x", expect: 1, value: 2 }),
      ret("c2", 1, false),
    ];
    expect(frontierFirstFailure(events)).toBe(3);
  });

  it("checks keys independently", () => {
    const events = [
      inv("w", { type: "put", key: "x", value: 1 }),
      ret("w", 1),
      inv("r", { type: "get", key: "y" }),
      ret("r", 0),
    ];
    expect(frontierFirstFailure(events)).toBe(-1);
  });

  it("agrees with brute force on random histories", () => {
    let failing = 0;
    fc.assert(
      fc.property(historyArb, (events) => {
        const expected = bruteFirstFailure(events);
        if (expected >= 0) failing++;
        expect(frontierFirstFailure(events)).toBe(expected);
      }),
      { numRuns: 10_000 },
    );
    // Both verdicts are well represented.
    expect(failing).toBeGreaterThan(1000);
    expect(failing).toBeLessThan(9000);
  });

  it("continues identically from saved state", () => {
    fc.assert(
      fc.property(historyArb, fc.nat(), (events, cut) => {
        const at = events.length === 0 ? 0 : cut % events.length;
        const a = new LinearizabilityChecker(registers);
        const results: unknown[] = [];
        const apply = (c: LinearizabilityChecker<number, Op, Out>, e: Event) =>
          e.kind === "invoke" ? c.invoke(e.id, e.op) : c.complete(e.id, e.out);
        events.slice(0, at).forEach((e) => apply(a, e));
        const b = new LinearizabilityChecker(registers);
        b.load(structuredClone(a.save()));
        for (const e of events.slice(at)) results.push([apply(a, e), apply(b, e)]);
        for (const [x, y] of results as [unknown, unknown][]) expect(y).toEqual(x);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("linearizableKv invariant", () => {
  it("reads the history from client annotations and explains a stale read", () => {
    const inv = Raft.linearizableKv();
    const reports: [string, string[]][] = [];
    let id = 0;
    const annotate = (node: string, label: string, data: object) =>
      inv.onRecord!(
        { id: id++, t: id, cause: null, type: "annotate", node, label, data } as TraceRecord,
        () => ({ t: 0, recordId: 0, nodes: [] }),
        (message, nodes) => reports.push([message, nodes]),
      );
    annotate("C1", "invoke", { seq: 1, op: { type: "put", key: "k", value: "a" } });
    annotate("C1", "retry", { seq: 1, server: "B" });
    annotate("C1", "complete", { seq: 1, result: { ok: true, value: "a" } });
    annotate("C2", "invoke", { seq: 1, op: { type: "get", key: "k" } });
    expect(reports).toEqual([]);
    annotate("C2", "complete", { seq: 1, result: { ok: true, value: null } });
    expect(reports).toEqual([
      [
        'C2#1 get k returned null, but no linearization of the history allows that; it could only have returned "a"',
        ["C2"],
      ],
    ]);
  });
});
