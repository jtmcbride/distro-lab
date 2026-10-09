import { defineProtocol, type ProtocolEntry } from "../../harness/scenario.ts";
import { RAFT_BUGS } from "./bugs.ts";
import { raftInvariants } from "./invariants.ts";
import { raft } from "./raft.ts";
import type { RaftView } from "./types.ts";

/**
 * Liveness after faults are lifted: every node is up, exactly one node leads, and all nodes
 * agree on its term and identity.
 */
function converged(
  nodes: readonly string[],
  view: (n: string) => RaftView,
  isUp: (n: string) => boolean,
) {
  const problems: string[] = [];
  const down = nodes.filter((n) => !isUp(n));
  if (down.length > 0) problems.push(`nodes still down: ${down.join(",")}`);
  const leaders = nodes.filter((n) => isUp(n) && view(n).role === "leader");
  if (leaders.length !== 1) {
    problems.push(
      `expected one leader, found ${leaders.length === 0 ? "none" : leaders.join(",")}`,
    );
    return problems;
  }
  const leader = leaders[0]!;
  const term = view(leader).term;
  for (const n of nodes) {
    const v = view(n);
    if (v.term !== term || v.leaderId !== leader) {
      problems.push(`${n} is at term ${v.term} following ${v.leaderId}, not ${leader}@${term}`);
    }
  }
  return problems;
}

export function raftEntries(): ProtocolEntry[] {
  const entry = (name: string, description: string, create: typeof raft) =>
    defineProtocol({
      name,
      description,
      create: () => create(),
      invariants: raftInvariants,
      liveness: (sim, view) => converged(sim.nodeIds, view, (n) => sim.isUp(n)),
    });
  return [
    entry("raft", "Raft leader election (fixed membership).", raft),
    ...Object.entries(RAFT_BUGS).map(([bug, spec]) =>
      entry(`raft-bug-${bug}`, `PLANTED BUG: ${spec.description}`, spec.create),
    ),
  ];
}
