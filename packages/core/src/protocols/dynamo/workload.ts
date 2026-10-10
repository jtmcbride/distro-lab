import type { CanonicalValue } from "../../canonical.ts";
import type { Workload } from "../../harness/generate.ts";
import type { DynamoOp } from "./types.ts";

const SHARED_KEYS = ["k0", "k1", "k2", "k3"];

/**
 * Per client: puts and gets on a few shared keys (concurrent writers make siblings) and on a
 * key of its own. Puts carry no context; the client fills in what it last read or wrote.
 * Every value is unique, so reads can be traced to the put that wrote them.
 */
export const dynamoWorkload: Workload = (rng, clients, fromMs, toMs) => {
  const actions: ReturnType<Workload> = [];
  for (const client of clients) {
    const count = rng.int(5, 30);
    const times = Array.from({ length: count }, () => rng.int(fromMs, toMs - 1)).sort(
      (a, b) => a - b,
    );
    times.forEach((atMs, i) => {
      const key = rng.chance(0.3) ? `own:${client}` : rng.pick(SHARED_KEYS);
      const op: DynamoOp = rng.chance(0.55)
        ? { type: "put", key, value: `${client}.${i}` }
        : { type: "get", key };
      actions.push({
        atMs,
        action: { type: "client", node: client, command: op as CanonicalValue },
      });
    });
  }
  return actions;
};
