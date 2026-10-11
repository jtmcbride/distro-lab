import { SCENARIO_VERSION, type Scenario } from "../../harness/scenario.ts";
import type { NetworkChange } from "../../linkNetwork.ts";
import type { NodeId } from "../../protocol.ts";
import type { ScheduledAction } from "../../simulation.ts";
import type { CanonicalValue } from "../../canonical.ts";
import type { RaftConfig } from "./types.ts";

type Step = ScheduledAction<CanonicalValue, NetworkChange>;

const at = (atMs: number, action: Step["action"]): Step => ({ atMs, action });
const net = (atMs: number, change: NetworkChange) => at(atMs, { type: "network", change });
const link = (atMs: number, from: NodeId, to: NodeId, up: boolean) =>
  net(atMs, { type: "setLink", from, to, up });
const timeout = (atMs: number, node: NodeId) =>
  at(atMs, { type: "timeout", node, key: "election" });

/**
 * Figure 8 of the Raft paper, scripted exactly: an entry from an earlier term reaches a
 * majority but must not be committed by counting replicas, because a server whose log ends
 * in a later term can still be elected and overwrite it.
 *
 * Servers A..E play S1..S5. Elections happen only when forced (election timeouts are huge);
 * one entry per AppendEntries lets the old entry reach a majority before the new leader's
 * no-op does. All messages take exactly 10ms.
 *
 * (a) t=10   A leads term 1; client write X reaches only A and B.
 * (b) t=310  A crashes; E wins term 2 with C and D, but its no-op never leaves E.
 * (c) t=420  A restarts and wins term 3 with B and C, and copies X to C: X is now on a
 *            majority (A, B, C). A is cut off from C before its term-3 no-op arrives.
 *            A correct leader does not commit X here.
 * (d) t=560  A crashes; E wins term 4 with C and D and overwrites index 2. If X had been
 *            committed (and acknowledged), it is now lost: leader completeness is violated.
 */
export function figure8Scenario(protocol = "raft"): Scenario {
  const config: Partial<RaftConfig> = {
    electionTimeoutMinMs: 100_000,
    electionTimeoutMaxMs: 100_000,
    heartbeatIntervalMs: 50,
    maxEntriesPerAppend: 1,
  };
  const actions: Step[] = [
    // (a) A leads term 1; only B receives the client's write X.
    timeout(10, "A"),
    link(90, "A", "C", false),
    link(90, "A", "D", false),
    link(90, "A", "E", false),
    at(100, { type: "client", node: "c1", command: { type: "put", key: "x", value: "X" } }),

    // (b) A crashes; E wins term 2 (votes from C, D) but its entries never leave it.
    at(300, { type: "crash", node: "A" }),
    link(300, "A", "C", true),
    link(300, "A", "E", true),
    timeout(310, "E"),
    link(325, "E", "B", false),
    link(325, "E", "C", false),
    link(325, "E", "D", false),
    at(400, { type: "crash", node: "E" }),

    // (c) A restarts and wins term 3 (two rounds: C and D voted in term 2 already).
    at(410, { type: "recover", node: "A" }),
    timeout(420, "A"),
    timeout(460, "A"),
    // X reaches C at 510 (after one rejected AppendEntries); A's no-op would reach C at 530.
    link(525, "A", "C", false),
    at(540, { type: "crash", node: "A" }),

    // (d) E restarts and wins term 4 (two rounds) with C and D.
    at(550, { type: "recover", node: "E" }),
    link(550, "E", "B", true),
    link(550, "E", "C", true),
    link(550, "E", "D", true),
    timeout(560, "E"),
    timeout(600, "E"),
  ];
  return {
    version: SCENARIO_VERSION,
    protocol,
    seed: 8,
    nodes: ["A", "B", "C", "D", "E"],
    clients: ["c1"],
    config: config as CanonicalValue,
    network: { defaults: { latencyMs: 10, jitterMs: 0, loss: 0, duplicate: 0 } },
    actions,
    durationMs: 1500,
  };
}

/**
 * A stale read from a deposed leader. A leads term 1; c1 writes x=1 and c2 reads it through
 * A. A partition leaves A alone with c2, the majority elects B, and c1 writes x=2 through B.
 * Then c2 reads x through A, which still believes it leads.
 *
 * Correct Raft cannot commit c2's read without a majority, so it completes only after the
 * heal, through B, and returns 2. With `raft-bug-leader-local-reads`, A answers from its own
 * state and returns 1, although x=2 was acknowledged before the read began: a stale read
 * that only the linearizability check sees (no client reads a key it wrote itself).
 */
export function staleReadScenario(protocol = "raft-bug-leader-local-reads"): Scenario {
  const config: Partial<RaftConfig> = {
    electionTimeoutMinMs: 100_000,
    electionTimeoutMaxMs: 100_000,
    heartbeatIntervalMs: 50,
  };
  const actions: Step[] = [
    timeout(10, "A"),
    at(100, { type: "client", node: "c1", command: { type: "put", key: "x", value: "1" } }),
    at(200, { type: "client", node: "c2", command: { type: "get", key: "x" } }),
    net(400, {
      type: "partition",
      groups: [
        ["A", "c2"],
        ["B", "C", "D", "E", "c1"],
      ],
    }),
    timeout(410, "B"),
    at(500, { type: "client", node: "c1", command: { type: "put", key: "x", value: "2" } }),
    at(1500, { type: "client", node: "c2", command: { type: "get", key: "x" } }),
    net(3000, { type: "heal" }),
  ];
  return {
    version: SCENARIO_VERSION,
    protocol,
    seed: 3,
    nodes: ["A", "B", "C", "D", "E"],
    clients: ["c1", "c2"],
    config: config as CanonicalValue,
    network: { defaults: { latencyMs: 10, jitterMs: 0, loss: 0, duplicate: 0 } },
    actions,
    durationMs: 5000,
  };
}
