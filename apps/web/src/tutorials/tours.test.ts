import { describe, expect, it } from "vitest";
import {
  ClientHistoryBuilder,
  type Dynamo,
  type HistoryOp,
  type Raft,
  type Violation,
} from "@distro-lab/core";
import { registry, SCENARIO_CHOICES } from "../scenarios.ts";
import { TOURS } from "./tours.ts";

/** The run at a step's moment, as the claims in its text need it. */
interface At {
  up(node: string): boolean;
  raft(node: string): Raft.RaftView;
  dynamo(node: string): Dynamo.DynamoView;
  /** Completed or pending operations of `client`, in order. */
  ops(client: string): HistoryOp[];
  violations: readonly Violation[];
  records: { label: string; node: string; data: unknown }[];
}

const SERVERS = ["A", "B", "C", "D", "E"];
const value = (op: HistoryOp | undefined) => (op?.output as { value?: unknown } | null)?.value;
const versions = (v: Dynamo.DynamoView, key: string) =>
  ((v.data[key] ?? []) as readonly Dynamo.Version[]).map((x) => x.value).sort();

/** One check per step, in order: what the step's text says is true at its moment. */
const CLAIMS: Record<string, ((at: At) => void)[]> = {
  election: [
    (at) => SERVERS.forEach((n) => expect(at.raft(n)).toMatchObject({ role: "follower", term: 0 })),
    (at) => expect(at.raft("E")).toMatchObject({ role: "candidate", term: 1, votedFor: "E" }),
    (at) => {
      expect(at.raft("E")).toMatchObject({ role: "leader", term: 1 });
      expect(at.raft("E").log[0]?.command.kind).toBe("noop");
    },
    (at) => {
      expect(at.raft("E")).toMatchObject({ role: "leader", term: 1 });
      SERVERS.filter((n) => n !== "E").forEach((n) =>
        expect(at.raft(n)).toMatchObject({ role: "follower", term: 1, leaderId: "E" }),
      );
    },
  ],
  figure8: [
    (at) => {
      const hasX = (n: string) => at.raft(n).log.some((e) => e.command.kind === "client");
      expect(SERVERS.filter(hasX)).toEqual(["A", "B"]);
      expect(at.raft("A").commitIndex).toBeLessThan(2);
    },
    (at) => {
      expect(at.up("A")).toBe(false);
      expect(at.raft("E")).toMatchObject({ role: "leader", term: 2 });
      expect(at.raft("C").log).toHaveLength(1);
    },
    (at) => {
      expect(at.raft("A")).toMatchObject({ role: "leader", term: 3 });
      const hasX = (n: string) => at.raft(n).log[1]?.command.kind === "client";
      expect(SERVERS.filter(hasX)).toEqual(["A", "B", "C"]);
      expect(at.raft("A").commitIndex).toBeGreaterThanOrEqual(2);
      expect(at.ops("c1")[0]?.completedAt).not.toBeNull();
    },
    (at) => {
      expect(at.raft("E")).toMatchObject({ role: "leader", term: 4 });
      expect(at.violations[0]?.invariant).toBe("leader-completeness");
    },
  ],
  "stale-read": [
    (at) => {
      expect(at.raft("A")).toMatchObject({ role: "leader", term: 1 });
      expect(value(at.ops("c1")[0])).toBe("1");
      expect(value(at.ops("c2")[0])).toBe("1");
    },
    (at) => {
      expect(at.raft("B")).toMatchObject({ role: "leader", term: 2 });
      expect(at.raft("A")).toMatchObject({ role: "leader", term: 1 });
    },
    (at) => {
      expect(value(at.ops("c1")[1])).toBe("2");
      const retries = at.records.filter(
        (r) => r.label === "retry" && r.node === "c1" && (r.data as { seq: number }).seq === 2,
      );
      expect(retries.map((r) => (r.data as { reason: string; server: string }).reason)).toEqual([
        "timeout",
        "redirect",
      ]);
      expect((retries[1]!.data as { server: string }).server).toBe("B");
      expect(at.raft("B").log.at(-1)?.term).toBe(2);
    },
    (at) => {
      expect(value(at.ops("c2")[1])).toBe("1");
      expect(at.violations.map((v) => v.invariant)).toEqual(["linearizable"]);
    },
    (at) => expect(at.violations[0]?.message).toContain('could only have returned "2"'),
  ],
  siblings: [
    (at) => {
      const holders = SERVERS.filter((n) => versions(at.dynamo(n), "cart").length > 0);
      expect(holders.length).toBeGreaterThanOrEqual(3);
      holders.forEach((n) => expect(versions(at.dynamo(n), "cart")).toEqual(["eggs", "milk"]));
    },
    (at) => {
      const read = at.ops("c1")[1]!.output as { versions: { value: string }[] };
      expect(read.versions.map((v) => v.value).sort()).toEqual(["eggs", "milk"]);
    },
    (at) => {
      const holders = SERVERS.filter((n) => versions(at.dynamo(n), "cart").length > 0);
      expect(holders.length).toBeGreaterThanOrEqual(3);
      holders.forEach((n) => expect(versions(at.dynamo(n), "cart")).toEqual(["milk+eggs"]));
    },
  ],
  "sloppy-quorum": [
    (at) => expect(at.records.map((r) => r.label)).not.toContain("invoke"),
    (at) => {
      expect(at.ops("c1")[0]?.completedAt).not.toBeNull();
      const fallbacks = at.records.filter((r) => r.label === "fallback");
      expect(fallbacks.map((r) => [r.node, r.data])).toEqual([
        ["E", { for: "B", key: "cart", to: "A" }],
        ["E", { for: "C", key: "cart", to: "E" }],
      ]);
      expect(Object.keys(at.dynamo("A").hints)).toEqual(["B"]);
      expect(Object.keys(at.dynamo("E").hints)).toEqual(["C"]);
    },
    (at) => {
      expect(at.ops("c2")[0]?.output).toEqual({ type: "get", versions: [] });
      expect(at.violations).toEqual([]);
    },
    (at) => {
      const handoffs = at.records.filter((r) => r.label === "handedOff");
      expect(handoffs.map((r) => [r.node, (r.data as { to: string }).to])).toEqual([
        ["E", "C"],
        ["A", "B"],
      ]);
      expect(at.dynamo("A").hints).toEqual({});
      expect(at.dynamo("E").hints).toEqual({});
      const read = at.ops("c2")[1]!.output as { versions: { value: string }[] };
      expect(read.versions.map((v) => v.value)).toEqual(["milk"]);
    },
  ],
};

describe("tours", () => {
  it("every tour has checked claims for each step", () => {
    expect(Object.keys(CLAIMS).sort()).toEqual(TOURS.map((t) => t.id).sort());
    for (const tour of TOURS) expect(CLAIMS[tour.id]).toHaveLength(tour.steps.length);
  });

  for (const tour of TOURS) {
    it(`"${tour.title}" says only what its run shows`, () => {
      const choice = SCENARIO_CHOICES.find((c) => c.id === tour.scenario);
      expect(choice).toBeDefined();
      const scenario = choice!.make();
      const history = new ClientHistoryBuilder();
      const records: At["records"] = [];
      const { sim, monitor } = registry.get(scenario.protocol)!.build(scenario, {
        sinks: [
          (r) => {
            history.add(r);
            if (r.type === "annotate") records.push({ label: r.label, node: r.node, data: r.data });
          },
        ],
      });
      let last = -1;
      tour.steps.forEach((step, i) => {
        expect(step.atMs).toBeGreaterThanOrEqual(last);
        expect(step.atMs).toBeLessThanOrEqual(scenario.durationMs);
        last = step.atMs;
        sim.runUntil(step.atMs);
        const at: At = {
          up: (n) => sim.isUp(n),
          raft: (n) => sim.view(n) as unknown as Raft.RaftView,
          dynamo: (n) => sim.view(n) as unknown as Dynamo.DynamoView,
          ops: (c) => history.ops.filter((op) => op.client === c),
          violations: monitor.violations,
          records,
        };
        try {
          CLAIMS[tour.id]![i]!(at);
        } catch (e) {
          throw new Error(`step ${i + 1} "${step.title}": ${(e as Error).message}`, { cause: e });
        }
      });
    });
  }
});
