import type { CanonicalValue } from "../../canonical.ts";
import { SCENARIO_VERSION, type Scenario } from "../../harness/scenario.ts";
import type { NetworkChange } from "../../linkNetwork.ts";
import type { ScheduledAction } from "../../simulation.ts";
import { preferenceList } from "./ring.ts";
import type { DynamoConfig, DynamoOp } from "./types.ts";

type Step = ScheduledAction<CanonicalValue, NetworkChange>;

const SERVERS = ["A", "B", "C", "D", "E"];
const KEY = "cart";

const at = (atMs: number, action: Step["action"]): Step => ({ atMs, action });
const op = (atMs: number, client: string, command: DynamoOp) =>
  at(atMs, { type: "client", node: client, command: command as CanonicalValue });
const net = (atMs: number, change: NetworkChange) => at(atMs, { type: "network", change });

function scenario(
  protocol: string,
  seed: number,
  config: Partial<DynamoConfig>,
  actions: Step[],
  durationMs: number,
): Scenario {
  return {
    version: SCENARIO_VERSION,
    protocol,
    seed,
    nodes: SERVERS,
    clients: ["c1", "c2"],
    config: config as CanonicalValue,
    network: { defaults: { latencyMs: 10, jitterMs: 0, loss: 0, duplicate: 0 } },
    actions,
    durationMs,
  };
}

/**
 * Two clients put the same key at the same moment without having read it: neither write
 * includes the other, so replicas keep both as siblings and a get returns both. c1 then puts
 * again with the context of that get, which replaces both siblings.
 */
export function concurrentWritesScenario(protocol = "dynamo"): Scenario {
  return scenario(
    protocol,
    1,
    { antiEntropyIntervalMs: 1000 },
    [
      op(100, "c1", { type: "put", key: KEY, value: "milk" }),
      op(100, "c2", { type: "put", key: KEY, value: "eggs" }),
      op(400, "c1", { type: "get", key: KEY }),
      op(600, "c1", { type: "put", key: KEY, value: "milk+eggs" }),
      op(900, "c2", { type: "get", key: KEY }),
    ],
    2000,
  );
}

/**
 * c1 is cut off from the key's three replicas but can reach its two fallbacks. With a sloppy
 * quorum (N=3, R=2, W=2) its put succeeds by leaving hints on the fallbacks, yet c2, who can
 * reach the real replicas, then reads nothing: the write was acknowledged but is not on any
 * replica yet. After the partition heals, hinted handoff delivers it and c2's next read sees
 * it. Sloppy quorums trade this guarantee for availability.
 */
export function sloppyQuorumScenario(protocol = "dynamo"): Scenario {
  return partitionedWrite(protocol, { sloppy: true });
}

/**
 * The same partition with a strict quorum: c1's put cannot reach W replicas, so it is
 * unavailable (and retried) until the partition heals, and c2 never reads a stale value of
 * an acknowledged write.
 */
export function strictQuorumScenario(protocol = "dynamo"): Scenario {
  return partitionedWrite(protocol, { sloppy: false });
}

function partitionedWrite(protocol: string, config: Partial<DynamoConfig>): Scenario {
  const order = preferenceList(SERVERS, KEY);
  const replicas = order.slice(0, 3);
  const fallbacks = order.slice(3);
  return scenario(
    protocol,
    3,
    { n: 3, r: 2, w: 2, antiEntropyIntervalMs: 0, readRepair: false, ...config },
    [
      net(0, {
        type: "partition",
        groups: [
          [...fallbacks, "c1"],
          [...replicas, "c2"],
        ],
      }),
      op(50, "c1", { type: "put", key: KEY, value: "milk" }),
      // Clients may try unreachable servers first; the partition outlasts their retries.
      op(1000, "c2", { type: "get", key: KEY }),
      net(4000, { type: "heal" }),
      op(5000, "c2", { type: "get", key: KEY }),
    ],
    6000,
  );
}

export const DYNAMO_EXAMPLES = {
  "concurrent-writes": concurrentWritesScenario,
  "sloppy-quorum": sloppyQuorumScenario,
  "strict-quorum": strictQuorumScenario,
};
