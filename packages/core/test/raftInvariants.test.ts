import { describe, expect, it } from "vitest";
import {
  InvariantMonitor,
  LinkNetwork,
  Raft,
  Simulation,
  type CanonicalValue,
  type Observable,
  type TraceRecord,
  type TraceSink,
} from "../src/index.ts";

type View = Raft.RaftView;
const base: View = {
  role: "follower",
  term: 0,
  votedFor: null,
  leaderId: null,
  commitIndex: 0,
  lastApplied: 0,
  log: [],
  data: {},
  sessions: {},
};

type NodeState = Partial<View> & { up?: boolean; incarnation?: number };
type Step = Record<string, NodeState> & { _records?: never };

/**
 * Feeds a scripted sequence of cluster states through the monitor. `records[i]` are trace
 * records emitted while moving to state i (seen by onRecord hooks, against state i).
 */
function replay(states: Step[], records: TraceRecord[][] = []) {
  let current = states[0]!;
  const listeners: (() => void)[] = [];
  const sinks: TraceSink[] = [];
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
    incarnation: (n) => current[n]?.incarnation ?? 0,
    addSink: (sink) => sinks.push(sink),
    view: (n) => {
      const { up: _up, incarnation: _i, ...v } = current[n]!;
      return { ...base, ...v } as CanonicalValue;
    },
    onStep: (l) => listeners.push(l),
  };
  const monitor = new InvariantMonitor<View>(fake, Raft.raftInvariants());
  for (const s of states.slice(1)) {
    current = s;
    step++;
    for (const r of records[step] ?? []) sinks.forEach((sink) => sink(r));
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

  it("report a persisting violation once", () => {
    const twoLeaders = {
      A: { role: "leader" as const, term: 2, votedFor: "A", leaderId: "A" },
      B: { role: "leader" as const, term: 2, votedFor: "B", leaderId: "B" },
    };
    expect(replay([twoLeaders, twoLeaders, twoLeaders])).toEqual(["election-safety@0"]);
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

  const e = (term: number, client?: string, seq = 1): Raft.RaftLogEntry =>
    client === undefined
      ? { term, command: { kind: "noop" } }
      : { term, command: { kind: "client", clientId: client, seq, op: { type: "get", key: "k" } } };
  const leader = (term: number, log: Raft.RaftLogEntry[], extra: NodeState = {}): NodeState => ({
    role: "leader",
    term,
    votedFor: "self",
    leaderId: null,
    log,
    ...extra,
  });

  it("flag logs that share an (index, term) but differ before it", () => {
    expect(replay([{ A: { log: [e(1, "c1"), e(2)] }, B: { log: [e(1, "c2"), e(2)] } }])).toContain(
      "log-matching@0",
    );
    expect(replay([{ A: { log: [e(1, "c1"), e(2)] }, B: { log: [e(1, "c1"), e(3)] } }])).toEqual(
      [],
    );
  });

  it("flag a later leader missing a committed entry", () => {
    expect(
      replay([
        { A: { term: 1, log: [e(1, "c1")], commitIndex: 1 }, B: { term: 1 } },
        {
          A: { term: 1, log: [e(1, "c1")], commitIndex: 1 },
          B: leader(2, [e(2)], { leaderId: "B" }),
        },
      ]),
    ).toContain("leader-completeness@1");
  });

  it("flag two servers applying different entries at one index", () => {
    expect(
      replay([
        {
          A: { log: [e(1, "c1")], commitIndex: 1, lastApplied: 1 },
          B: { log: [e(1, "c2")], commitIndex: 1, lastApplied: 1 },
        },
      ]),
    ).toContain("state-machine-safety@0");
  });

  it("flag applying past commit, committing past the log, and commit going backwards", () => {
    expect(replay([{ A: { log: [e(1)], commitIndex: 0, lastApplied: 1 } }])).toContain(
      "commit-bookkeeping@0",
    );
    expect(replay([{ A: { log: [], commitIndex: 1 } }])).toContain("commit-bookkeeping@0");
    expect(
      replay([{ A: { log: [e(1)], commitIndex: 1 } }, { A: { log: [e(1)], commitIndex: 0 } }]),
    ).toEqual(["commit-bookkeeping@1"]);
    // Across a crash and restart the commit index legitimately starts over.
    expect(
      replay([
        { A: { log: [e(1)], commitIndex: 1, lastApplied: 1 } },
        { A: { log: [e(1)], commitIndex: 1, lastApplied: 1, up: false, incarnation: 1 } },
        { A: { log: [e(1)], commitIndex: 0, incarnation: 1 } },
      ]),
    ).toEqual([]);
  });

  it("flag a leader rewriting its own log", () => {
    expect(
      replay([
        { A: leader(2, [e(1), e(2, "c1")], { leaderId: "A" }) },
        { A: leader(2, [e(1), e(2, "c2")], { leaderId: "A" }) },
      ]),
      // Log matching also fires: two different entries both claim index 2, term 2.
    ).toEqual(["log-matching@1", "leader-append-only@1"]);
    // Appending is fine; so is a different log in a later term. (Entries are reused: real
    // logs keep their entry objects, and the tracker compares references.)
    const first = e(1);
    expect(
      replay([
        { A: leader(2, [first], { leaderId: "A" }) },
        { A: leader(2, [first, e(2)], { leaderId: "A" }) },
        { A: leader(3, [e(3)], { leaderId: "A" }) },
      ]),
    ).toEqual([]);
  });

  it("flag a client reply for a write not yet on a majority", () => {
    const complete = (seq: number): TraceRecord => ({
      id: 1,
      t: 1,
      cause: 0,
      type: "annotate",
      node: "c1",
      label: "complete",
      data: { seq },
    });
    const states: Step[] = [
      { A: {}, B: {}, C: {} },
      { A: { log: [e(1, "c1")] }, B: {}, C: {} },
      { A: { log: [e(1, "c1")] }, B: { log: [e(1, "c1")] }, C: {} },
    ];
    expect(replay(states, [[], [complete(1)]])).toEqual(["acknowledged-writes-replicated@1"]);
    expect(replay(states, [[], [], [complete(1)]])).toEqual([]);
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
