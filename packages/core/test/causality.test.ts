import { describe, expect, it } from "vitest";
import {
  causalPast,
  defaultRegistry,
  minimizeFailure,
  omissionCauses,
  runScenario,
  scenarioForSeed,
  type TraceRecord,
} from "../src/index.ts";

const registry = defaultRegistry();

describe("causalPast", () => {
  it("follows program order and messages, not later events", () => {
    const base = { cause: null } as const;
    const trace: TraceRecord[] = [
      { ...base, id: 0, t: 0, type: "init", node: "A" },
      { ...base, id: 1, t: 0, type: "init", node: "B" },
      { ...base, id: 2, t: 0, type: "init", node: "C" },
      {
        ...base,
        id: 3,
        t: 1,
        type: "send",
        from: "A",
        to: "B",
        message: 1,
        copies: 1,
        arrivals: [2],
      },
      {
        ...base,
        id: 4,
        t: 1.5,
        type: "send",
        from: "A",
        to: "C",
        message: 2,
        copies: 1,
        arrivals: [3],
      },
      { ...base, id: 5, t: 2, type: "deliver", from: "A", to: "B", send: 3 },
      { ...base, id: 6, t: 3, type: "deliver", from: "A", to: "C", send: 4 },
      { ...base, id: 7, t: 4, type: "crash", node: "A" },
      { ...base, id: 8, t: 5, type: "timer", node: "B", key: "x" },
    ];
    // B at #8 knows A's history only up to the send it received (#3).
    expect([...causalPast(trace, 8, ["B"])].sort((a, b) => a - b)).toEqual([0, 1, 3, 5, 8]);
    // A's crash is in the past of A itself.
    expect(causalPast(trace, 8, ["A"]).has(7)).toBe(true);
    expect(causalPast(trace, 6, ["C"]).has(5)).toBe(false);
  });

  // The faults a minimized counterexample needs are exactly the ones that cause it, so
  // every process fault it keeps must be in the causal past of the violation.
  const BUGS: [string, number][] = [
    ["double-vote", 0],
    ["volatile-vote", 16],
    ["stale-votes", 461],
    ["truncate-always", 0],
    ["trust-received", 0],
    ["no-sessions", 3],
    ["lost-append", 4],
  ];
  for (const [bug, seed] of BUGS) {
    it(`contains the faults that trigger "${bug}"`, () => {
      const protocol = `raft-bug-${bug}`;
      const { minimized } = minimizeFailure(
        registry,
        scenarioForSeed(registry, seed, { protocol }),
      )!;
      const run = runScenario(registry, minimized, { keepTrace: true });
      const v = run.violations[0]!;
      const past = causalPast(run.trace!, v.recordId, v.nodes);
      const omissions = omissionCauses(run.trace!, past, v.recordId);
      const repairsFrom = minimized.durationMs - (minimized.livenessAfterMs ?? 0);
      const faults = minimized.actions.filter(
        (a) => (a.action.type === "crash" || a.action.type === "recover") && a.atMs < repairsFrom,
      );
      for (const f of faults) {
        const record = run.trace!.find(
          (r) =>
            r.type === f.action.type &&
            r.t === f.atMs &&
            (r as { node: string }).node === (f.action as { node: string }).node,
        );
        // A recover of a node that was up is a no-op and emits nothing.
        if (record === undefined) continue;
        expect(
          past.has(record.id) || omissions.has(record.id),
          `${f.action.type} ${(f.action as { node: string }).node}`,
        ).toBe(true);
      }
      expect(past.size).toBeLessThan(run.trace!.length);
    });
  }
});
