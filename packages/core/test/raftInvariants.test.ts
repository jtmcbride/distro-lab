import { describe, expect, it } from "vitest";
import {
  InvariantMonitor,
  LinkNetwork,
  Raft,
  Simulation,
  type CanonicalValue,
  type Observable,
} from "../src/index.ts";

type View = Raft.RaftView;
const base: View = {
  role: "follower",
  term: 0,
  votedFor: null,
  leaderId: null,
  logLength: 0,
  lastLogTerm: 0,
};

/** Feeds a scripted sequence of cluster states through the monitor. */
function replay(states: Record<string, Partial<View> & { up?: boolean }>[]) {
  let current = states[0]!;
  const listeners: (() => void)[] = [];
  let step = 0;
  const fake: Observable = {
    get now() {
      return step;
    },
    get lastRecordId() {
      return step;
    },
    nodeIds: Object.keys(current),
    isUp: (n) => current[n]?.up !== false,
    view: (n) => {
      const { up: _up, ...v } = current[n]!;
      return { ...base, ...v } as CanonicalValue;
    },
    onStep: (l) => listeners.push(l),
  };
  const monitor = new InvariantMonitor<View>(fake, Raft.raftInvariants());
  for (const s of states.slice(1)) {
    current = s;
    step++;
    listeners.forEach((l) => l());
  }
  return monitor.violations.map((v) => `${v.invariant}@${v.t}`);
}

describe("Raft invariants", () => {
  it("flag two leaders in the same term, even at different times", () => {
    expect(
      replay([
        { A: { role: "leader", term: 2, votedFor: "A", leaderId: "A" }, B: {} },
        { A: { term: 3 }, B: {} },
        { A: { term: 3 }, B: { role: "leader", term: 2, votedFor: "B", leaderId: "B" } },
      ]),
    ).toEqual(["election-safety@2"]);
  });

  it("ignore stale leader views of crashed nodes", () => {
    expect(
      replay([
        { A: { role: "leader", term: 2, votedFor: "A", leaderId: "A" }, B: {} },
        {
          A: { role: "leader", term: 2, votedFor: "A", leaderId: "A", up: false },
          B: { role: "leader", term: 3, votedFor: "B", leaderId: "B" },
        },
      ]),
    ).toEqual([]);
  });

  it("flag a second vote in the same term, including after a restart", () => {
    expect(
      replay([
        { A: { term: 4, votedFor: "B" } },
        { A: { term: 4, votedFor: null, up: false } },
        { A: { term: 4, votedFor: "C" } },
      ]),
    ).toEqual(["single-vote-per-term@2"]);
  });

  it("flag a term going backwards", () => {
    expect(replay([{ A: { term: 5 } }, { A: { term: 4 } }])).toEqual(["term-monotonic@1"]);
  });

  it("flag a candidate that did not vote for itself", () => {
    expect(replay([{ A: { role: "candidate", term: 1, votedFor: "B" } }])).toContain(
      "candidate-votes-for-self@0",
    );
  });

  it("flag following a node that never led that term", () => {
    expect(replay([{ A: { term: 3, leaderId: "B" }, B: { term: 3 } }])).toEqual([
      "follows-real-leader@0",
    ]);
    expect(
      replay([
        { A: { term: 3 }, B: { role: "leader", term: 3, votedFor: "B", leaderId: "B" } },
        { A: { term: 3, leaderId: "B" }, B: { term: 4 } },
      ]),
    ).toEqual([]);
  });

  it("hold for a correct implementation under crashes and partitions", () => {
    const nodes = ["A", "B", "C", "D", "E"];
    for (let seed = 0; seed < 20; seed++) {
      const sim = new Simulation({
        protocol: Raft.raft(),
        nodes,
        seed,
        network: new LinkNetwork(nodes, { defaults: { latencyMs: 10, jitterMs: 40, loss: 0.05 } }),
        actions: [
          {
            atMs: 500,
            action: { type: "network", change: { type: "partition", groups: [["A", "B"]] } },
          },
          { atMs: 900, action: { type: "crash", node: "C" } },
          { atMs: 1500, action: { type: "network", change: { type: "heal" } } },
          { atMs: 1700, action: { type: "recover", node: "C" } },
        ],
      });
      const monitor = new InvariantMonitor<View>(sim, Raft.raftInvariants());
      sim.runUntil(3000);
      expect(monitor.violations).toEqual([]);
    }
  });
});
