import { describe, expect, it } from "vitest";
import {
  clientHistory,
  defaultRegistry,
  Raft,
  runScenario,
  SCENARIO_VERSION,
  type Scenario,
  type TraceRecord,
} from "../src/index.ts";

const registry = defaultRegistry();

const withMode = (s: Scenario, readMode: Raft.ReadMode): Scenario => ({
  ...s,
  config: { ...(s.config as object), readMode },
});

/** A calm 3-server cluster: c1 writes x then reads it back, twice. */
function calm(readMode: Raft.ReadMode): Scenario {
  const op = (atMs: number, command: Raft.KvOp) => ({
    atMs,
    action: { type: "client" as const, node: "c1", command },
  });
  return {
    version: SCENARIO_VERSION,
    protocol: "raft",
    seed: 1,
    nodes: ["A", "B", "C"],
    clients: ["c1"],
    config: { readMode },
    network: { defaults: { latencyMs: 10, jitterMs: 0, loss: 0, duplicate: 0 } },
    actions: [
      op(1000, { type: "put", key: "x", value: "1" }),
      op(1200, { type: "get", key: "x" }),
      op(1400, { type: "put", key: "x", value: "2" }),
      op(1600, { type: "get", key: "x" }),
    ],
    durationMs: 2000,
  };
}

const run = (s: Scenario) => {
  const r = runScenario(registry, s, { keepTrace: true, keepState: true });
  const leader = r.finalState!.find(
    (p) => p.role === "server" && (p.view as unknown as Raft.RaftView).role === "leader",
  )!.view as unknown as Raft.RaftView;
  return { r, ops: clientHistory(r.trace!), leader };
};

const annotations = (trace: readonly TraceRecord[], label: string) =>
  trace.filter((x) => x.type === "annotate" && x.label === label);

describe("ReadIndex", () => {
  it("serves reads without log entries, with the latest value", () => {
    const { r, ops, leader } = run(calm("readIndex"));
    expect(r.violations).toEqual([]);
    expect(ops.map((op) => op.output)).toEqual([
      { ok: true, value: "1" },
      { ok: true, value: "1" },
      { ok: true, value: "2" },
      { ok: true, value: "2" },
    ]);
    const clientEntries = leader.log.filter((e) => e.command.kind === "client");
    expect(clientEntries).toHaveLength(2); // the puts only
    expect(annotations(r.trace!, "readServed")).toHaveLength(2);
  });

  it("costs the same round trip as a log read, since disk writes are not modeled", () => {
    // Log: client -> leader, append round to a majority, reply. ReadIndex: client -> leader,
    // heartbeat round to a majority, reply. With 10ms links both take 40ms; what ReadIndex
    // saves here is the log entry (and in real systems, the fsync).
    const latency = (mode: Raft.ReadMode) => {
      const read = run(calm(mode)).ops[1]!;
      return read.completedAt! - read.invokedAt;
    };
    expect(latency("log")).toBe(40);
    expect(latency("readIndex")).toBe(40);
  });

  it("keeps a deposed leader from answering: the stale-read example stays linearizable", () => {
    const { r, ops } = run(withMode(Raft.staleReadScenario("raft"), "readIndex"));
    expect(r.violations).toEqual([]);
    const last = ops.filter((op) => op.client === "c2").at(-1)!;
    expect(last.output).toEqual({ ok: true, value: "2" });
    // A could not confirm leadership in its minority partition; B served it after the heal.
    expect(last.completedAt).toBeGreaterThan(3000);
    const served = annotations(r.trace!, "readServed") as (TraceRecord & { node: string })[];
    expect(served.filter((x) => x.t > 1500).map((x) => x.node)).toEqual(["B"]);
  });

  it("rejects unknown read modes", () => {
    expect(() => Raft.raft({ readMode: "fast" as Raft.ReadMode })).toThrow(/invalid Raft config/);
  });
});
