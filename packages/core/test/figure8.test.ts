import { describe, expect, it } from "vitest";
import { defaultRegistry, Raft, runScenario } from "../src/index.ts";

const registry = defaultRegistry();

function build(protocol: string) {
  const { sim, monitor } = registry.get(protocol)!.build(Raft.figure8Scenario(protocol));
  const view = (n: string) => sim.view(n) as Raft.RaftView;
  const terms = (n: string) => view(n).log.map((e) => e.term);
  return { sim, monitor, view, terms };
}

describe("Figure 8", () => {
  it("reaches each stage of the paper's scenario", () => {
    const { sim, view, terms } = build("raft");
    // (a) A leads term 1; X (index 2, term 1) is only on A and B.
    sim.runUntil(290);
    expect(view("A")).toMatchObject({ role: "leader", term: 1, commitIndex: 1 });
    expect(["A", "B", "C", "D", "E"].map(terms)).toEqual([[1, 1], [1, 1], [1], [1], [1]]);
    // (b) E led term 2 with a no-op at index 2 that never left E.
    sim.runUntil(399);
    expect(view("E")).toMatchObject({ role: "leader", term: 2 });
    expect(terms("E")).toEqual([1, 2]);
    expect(terms("C")).toEqual([1]);
    // (c) A leads term 3; X is on a majority (A, B, C) but A's term-3 no-op is not.
    sim.runUntil(535);
    expect(view("A")).toMatchObject({ role: "leader", term: 3 });
    expect([terms("A"), terms("B"), terms("C")]).toEqual([
      [1, 1, 3],
      [1, 1, 3],
      [1, 1],
    ]);
    // The current-term rule: X must not be committed by counting replicas. (A restarted, so
    // its volatile commitIndex starts over and nothing new can commit yet.)
    expect(view("A").commitIndex).toBe(0);
    // (d) E wins term 4 and overwrites index 2 on C. Nothing committed was lost.
    sim.runUntil(700);
    expect(view("E")).toMatchObject({ role: "leader", term: 4 });
    expect(terms("C").slice(0, 2)).toEqual([1, 2]);
  });

  it("is safe with the current-term commit rule", () => {
    const r = runScenario(registry, Raft.figure8Scenario("raft"));
    expect(r.violations).toEqual([]);
  });

  it("loses a committed entry if old-term entries are committed by counting", () => {
    const { sim, view, monitor } = build("raft-bug-commit-old-terms");
    sim.runUntil(535);
    expect(view("A").commitIndex).toBe(2);
    sim.runUntil(1500);
    expect(monitor.violations[0]).toMatchObject({
      invariant: "leader-completeness",
      nodes: ["E", "A"],
    });
  });
});
