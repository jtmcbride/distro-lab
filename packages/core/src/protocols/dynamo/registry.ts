import { canonicalJson, type CanonicalValue } from "../../canonical.ts";
import type { RequestClientView } from "../../clients/requestClient.ts";
import { defineProtocol, type ProtocolEntry } from "../../harness/scenario.ts";
import type { NodeId } from "../../protocol.ts";
import type { RunnableSimulation } from "../../simulation.ts";
import { formatDot, type Version } from "./clock.ts";
import { DYNAMO_BUGS } from "./bugs.ts";
import { dynamo, dynamoClient, emptySlot } from "./dynamo.ts";
import { dynamoInvariants } from "./invariants.ts";
import { replicasOf } from "./ring.ts";
import { DYNAMO_EXAMPLES } from "./scenarios.ts";
import { formatCrdt, type Crdt } from "./crdt.ts";
import { DEFAULT_DYNAMO_CONFIG, type DynamoConfig, type DynamoView, type Slot } from "./types.ts";
import { dynamoWorkload } from "./workload.ts";

const configOf = (config: CanonicalValue | undefined): DynamoConfig => ({
  ...DEFAULT_DYNAMO_CONFIG,
  ...((config ?? {}) as Partial<DynamoConfig>),
});

/**
 * Liveness after faults are lifted: every server is up, no hints are left, every key's
 * replicas hold the same versions, and every client has finished its operations.
 */
export function dynamoConverged(
  sim: RunnableSimulation,
  view: (n: NodeId) => DynamoView,
  config: DynamoConfig,
): string[] {
  const servers = sim.nodeIds;
  const problems: string[] = [];
  const down = servers.filter((n) => !sim.isUp(n));
  if (down.length > 0) problems.push(`servers still down: ${down.join(",")}`);
  for (const n of servers) {
    const owners = Object.keys(view(n).hints);
    if (owners.length > 0) problems.push(`${n} still holds hints for ${owners.join(",")}`);
  }
  const keys = new Set(servers.flatMap((n) => Object.keys(view(n).data)));
  for (const key of [...keys].sort()) {
    const replicas = replicasOf(servers, key, config.n);
    const held = replicas.map((r) => canonicalJson((view(r).data[key] ?? emptySlot(key)) as never));
    if (new Set(held).size > 1) {
      problems.push(
        `replicas of ${key} differ: ${replicas.map((r) => `${r}=${formatSlot(view(r).data[key] ?? emptySlot(key))}`).join(" ")}`,
      );
    }
  }
  for (const c of sim.clientIds) {
    const v = sim.view(c) as RequestClientView;
    const pending = v.queued + (v.inFlight === null ? 0 : 1);
    if (pending > 0) problems.push(`client ${c} still has ${pending} operations pending`);
  }
  return problems;
}

/** e.g. `[c1.3@A2 | c2.1@B1]` */
export function formatVersions(versions: readonly Version[]): string {
  return `[${versions.map((v) => `${v.value}@${formatDot(v.dot)}`).join(" | ")}]`;
}

/** A register's siblings, a counter's value or a set's elements. */
export function formatSlot(slot: Slot): string {
  return Array.isArray(slot) ? formatVersions(slot) : formatCrdt(slot as Crdt);
}

/** e.g. `k0=[c1.3@A2] k1=[c1.1@A1 | c2.4@C2] | hints for B: k1` */
export function formatDynamoView(v: DynamoView): string {
  const data = Object.keys(v.data)
    .sort()
    .map((k) => `${k}=${formatSlot(v.data[k]!)}`);
  const hints = Object.keys(v.hints)
    .sort()
    .map((owner) => `hints for ${owner}: ${Object.keys(v.hints[owner]!).sort().join(",")}`);
  return [data.join(" ") || "(empty)", ...hints].join(" | ");
}

export function dynamoEntries(): ProtocolEntry[] {
  const entry = (
    name: string,
    description: string,
    create: (config: DynamoConfig) => ReturnType<typeof dynamo>,
  ) =>
    defineProtocol({
      name,
      description,
      create: (config) => create(configOf(config)),
      client: () => dynamoClient(),
      invariants: (config) => dynamoInvariants(configOf(config)),
      formatView: formatDynamoView,
      // Small replica sets and quorums, strict or sloppy, with and without read repair.
      randomConfig: (rng) => {
        const n = rng.int(2, 3);
        return {
          n,
          r: rng.int(1, n),
          w: rng.int(1, n),
          sloppy: rng.chance(0.5),
          readRepair: rng.chance(0.8),
          antiEntropyIntervalMs: rng.pick([250, 500, 1000]),
        };
      },
      workload: dynamoWorkload,
      // Every operation is a quorum round trip, so on a lossy network a client that was cut
      // off drains its backlog more slowly than through a Raft leader.
      stabilizeMs: 12_000,
      examples: DYNAMO_EXAMPLES,
      liveness: (sim, view, config) => dynamoConverged(sim, view, configOf(config)),
    });
  return [
    entry(
      "dynamo",
      "Dynamo-style leaderless KV store (N/R/W quorums, sloppy quorum, siblings).",
      (config) => dynamo(config),
    ),
    ...Object.entries(DYNAMO_BUGS).map(([bug, spec]) =>
      entry(`dynamo-bug-${bug}`, `PLANTED BUG: ${spec.description}`, spec.create),
    ),
  ];
}
