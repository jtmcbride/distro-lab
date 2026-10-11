import { defineProtocol, type ProtocolEntry } from "../../harness/scenario.ts";
import { RAFT_BUGS } from "./bugs.ts";
import { raftInvariants } from "./invariants.ts";
import { raft } from "./raft.ts";
import { requestClient, type RequestClientView } from "../../clients/requestClient.ts";
import { clientChains, raftKvWorkload } from "./workload.ts";
import { figure8Scenario } from "./scenarios.ts";
import { linearizableKv, type KvOp, type KvResult } from "./kv.ts";
import type { RaftConfig, RaftMessage, RaftView } from "./types.ts";

/**
 * Liveness after faults are lifted: every node is up, exactly one node leads, all nodes agree
 * on its term and identity, and every client has finished its operations.
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

/** e.g. `leader t4 commit=3 applied=3 | 1:noop@1 2:c1#1@1 3*:noop@4 | {"x":"1"}` (* = uncommitted) */
export function formatRaftView(v: RaftView): string {
  const log = v.log
    .map((e, i) => {
      const who = e.command.kind === "client" ? `${e.command.clientId}#${e.command.seq}` : "noop";
      return `${i + 1}${i + 1 > v.commitIndex ? "*" : ""}:${who}@${e.term}`;
    })
    .join(" ");
  return `${v.role} t${v.term} commit=${v.commitIndex} applied=${v.lastApplied} | ${log || "(empty)"} | ${JSON.stringify(v.data)}`;
}

export function raftEntries(): ProtocolEntry[] {
  const entry = (
    name: string,
    description: string,
    create: (config: Partial<RaftConfig>) => ReturnType<typeof raft>,
  ) =>
    defineProtocol({
      name,
      description,
      create: (config) => create((config ?? {}) as Partial<RaftConfig>),
      client: () => requestClient<KvOp, KvResult, RaftMessage>(),
      invariants: () => [...raftInvariants(), clientChains(), linearizableKv()],
      formatView: formatRaftView,
      // Small batches make old-term entries travel without the new leader's no-op, which is
      // what Figure 8 needs; both backoff modes get exercised.
      randomConfig: (rng) => ({
        maxEntriesPerAppend: rng.pick([1, 2, 4, 64]),
        fastBackoff: rng.chance(0.5),
      }),
      examples: { figure8: figure8Scenario },
      workload: raftKvWorkload,
      liveness: (sim, view) => [
        ...converged(sim.nodeIds, view, (n) => sim.isUp(n)),
        ...sim.clientIds.flatMap((c) => {
          const v = sim.view(c) as RequestClientView;
          return v.queued > 0 || v.inFlight !== null
            ? [
                `client ${c} still has ${v.queued + (v.inFlight === null ? 0 : 1)} operations pending`,
              ]
            : [];
        }),
      ],
    });
  return [
    entry("raft", "Raft replicated KV store (fixed membership).", (config) => raft(config)),
    ...Object.entries(RAFT_BUGS).map(([bug, spec]) =>
      entry(`raft-bug-${bug}`, `PLANTED BUG: ${spec.description}`, spec.create),
    ),
  ];
}
