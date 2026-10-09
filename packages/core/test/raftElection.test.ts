import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  LinkNetwork,
  Raft,
  Simulation,
  TraceRecorder,
  type NetworkChange,
  type ScheduledAction,
  type TraceRecord,
} from "../src/index.ts";

const FIVE = ["A", "B", "C", "D", "E"];

function cluster(
  seed: number,
  nodes = FIVE,
  actions: ScheduledAction<never, NetworkChange>[] = [],
) {
  const rec = new TraceRecorder();
  const sim = new Simulation({
    protocol: Raft.raft(),
    nodes,
    seed,
    network: new LinkNetwork(nodes, { defaults: { latencyMs: 10, jitterMs: 10 } }),
    actions,
    sinks: [rec.sink],
  });
  const view = (n: string) => sim.view(n) as Raft.RaftView;
  const liveLeaders = () => nodes.filter((n) => sim.isUp(n) && view(n).role === "leader");
  return { sim, rec, view, liveLeaders };
}

const becameLeader = (records: TraceRecord[]) =>
  records.flatMap((r) =>
    r.type === "annotate" && r.label === "becameLeader"
      ? [{ node: r.node, t: r.t, term: (r.data as { term: number }).term }]
      : [],
  );

describe("Raft leader election", () => {
  it("elects exactly one leader that every node follows", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const { sim, view, liveLeaders } = cluster(seed);
        sim.runUntil(2000);
        const leaders = liveLeaders();
        expect(leaders).toHaveLength(1);
        const term = view(leaders[0]!).term;
        for (const n of FIVE) {
          expect(view(n)).toMatchObject({ term, leaderId: leaders[0] });
        }
      }),
      { numRuns: 50 },
    );
  });

  it("is stable: heartbeats prevent further elections", () => {
    const { sim, rec } = cluster(1);
    sim.runUntil(10_000);
    expect(becameLeader(rec.records)).toHaveLength(1);
  });

  it("elects a new leader in a higher term after the leader crashes", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const { sim, view, liveLeaders } = cluster(seed);
        sim.runUntil(2000);
        const [old] = liveLeaders();
        const oldTerm = view(old!).term;
        sim.schedule(2000, { type: "crash", node: old! });
        sim.runUntil(4000);
        const leaders = liveLeaders();
        expect(leaders).toHaveLength(1);
        expect(leaders[0]).not.toBe(old);
        expect(view(leaders[0]!).term).toBeGreaterThan(oldTerm);
      }),
      { numRuns: 30 },
    );
  });

  it("never elects a leader on the minority side of a partition", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const { sim, rec, view, liveLeaders } = cluster(seed);
        sim.runUntil(2000);
        const [old] = liveLeaders();
        const minority = [old!, FIVE.find((n) => n !== old)!];
        const majority = FIVE.filter((n) => !minority.includes(n));
        sim.schedule(2000, { type: "network", change: { type: "partition", groups: [minority] } });
        sim.runUntil(6000);

        const during = becameLeader(rec.records).filter((e) => e.t > 2000);
        expect(during.length).toBeGreaterThan(0);
        for (const e of during) expect(majority).toContain(e.node);
        // The old leader still believes it leads (it cannot hear the new term), which is
        // legal: its term is stale.
        const newLeader = during.at(-1)!;
        expect(view(old!).term).toBeLessThan(newLeader.term);

        sim.schedule(6000, { type: "network", change: { type: "heal" } });
        sim.runUntil(9000);
        const leaders = liveLeaders();
        expect(leaders).toHaveLength(1);
        expect(new Set(FIVE.map((n) => view(n).term)).size).toBe(1);
      }),
      { numRuns: 30 },
    );
  });

  it("makes no progress without a majority, and recovers when one returns", () => {
    const { sim, rec, liveLeaders } = cluster(7, FIVE, [
      { atMs: 0, action: { type: "crash", node: "C" } },
      { atMs: 0, action: { type: "crash", node: "D" } },
      { atMs: 0, action: { type: "crash", node: "E" } },
    ]);
    sim.runUntil(5000);
    expect(becameLeader(rec.records)).toHaveLength(0);
    sim.schedule(5000, { type: "recover", node: "C" });
    sim.runUntil(8000);
    expect(liveLeaders()).toHaveLength(1);
  });

  it("keeps term and vote across a crash, and resets role", () => {
    const { sim, view } = cluster(3);
    sim.runUntil(2000);
    const before = view("B");
    sim.schedule(2000, { type: "crash", node: "B" });
    sim.schedule(2001, { type: "recover", node: "B" });
    sim.runUntil(2001);
    expect(view("B")).toMatchObject({
      role: "follower",
      term: before.term,
      votedFor: before.votedFor,
      leaderId: null,
    });
  });

  it("lets a single node elect itself", () => {
    const { sim, liveLeaders } = cluster(1, ["solo"]);
    sim.runUntil(1000);
    expect(liveLeaders()).toEqual(["solo"]);
  });

  it("rejects timing configs that cannot work", () => {
    expect(() => Raft.raft({ heartbeatIntervalMs: 200 })).toThrow(RangeError);
    expect(() => Raft.raft({ electionTimeoutMinMs: 300, electionTimeoutMaxMs: 100 })).toThrow(
      RangeError,
    );
  });
});
