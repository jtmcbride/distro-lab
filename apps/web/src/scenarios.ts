import {
  defaultRegistry,
  Dynamo,
  Raft,
  SCENARIO_VERSION,
  scenarioForSeed,
  type Scenario,
} from "@distro-lab/core";

export const registry = defaultRegistry();

/** A calm cluster to experiment with: no scheduled faults, two idle clients. */
export function sandbox(protocol = "raft", servers = 5, seed = 1): Scenario {
  return {
    version: SCENARIO_VERSION,
    protocol,
    seed,
    nodes: Array.from({ length: servers }, (_, i) => String.fromCharCode(65 + i)),
    clients: ["c1", "c2"],
    network: { defaults: { latencyMs: 10, jitterMs: 5, loss: 0, duplicate: 0 } },
    actions: [],
    durationMs: 10_000,
  };
}

export interface ScenarioChoice {
  readonly id: string;
  readonly label: string;
  readonly make: () => Scenario;
}

export const SCENARIO_CHOICES: readonly ScenarioChoice[] = [
  { id: "sandbox", label: "Sandbox: 5 servers, 2 clients", make: () => sandbox() },
  { id: "sandbox3", label: "Sandbox: 3 servers, 2 clients", make: () => sandbox("raft", 3) },
  { id: "figure8", label: "Figure 8 (correct Raft)", make: () => Raft.figure8Scenario("raft") },
  {
    id: "figure8-bug",
    label: "Figure 8 (bug: commits old-term entries)",
    make: () => Raft.figure8Scenario("raft-bug-commit-old-terms"),
  },
  {
    id: "stale-read",
    label: "Stale read from a deposed leader (correct Raft)",
    make: () => Raft.staleReadScenario("raft"),
  },
  {
    id: "stale-read-bug",
    label: "Stale read from a deposed leader (bug: leader answers reads locally)",
    make: () => Raft.staleReadScenario("raft-bug-leader-local-reads"),
  },
  {
    id: "fuzz",
    label: "Random faults (fuzz seed 1)",
    make: () => scenarioForSeed(registry, 1, { protocol: "raft" }),
  },
  {
    id: "dynamo-sandbox",
    label: "Dynamo sandbox: 5 servers, 2 clients",
    make: () => sandbox("dynamo"),
  },
  {
    id: "dynamo-concurrent",
    label: "Dynamo: concurrent writes make siblings",
    make: () => Dynamo.concurrentWritesScenario(),
  },
  {
    id: "dynamo-sloppy",
    label: "Dynamo: sloppy quorum, stale read",
    make: () => Dynamo.sloppyQuorumScenario(),
  },
  {
    id: "dynamo-strict",
    label: "Dynamo: strict quorum, unavailable",
    make: () => Dynamo.strictQuorumScenario(),
  },
  {
    id: "dynamo-fuzz",
    label: "Dynamo: random faults (fuzz seed 1)",
    make: () => scenarioForSeed(registry, 1, { protocol: "dynamo" }),
  },
];
