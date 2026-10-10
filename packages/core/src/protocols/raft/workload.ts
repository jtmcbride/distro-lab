import type { CanonicalValue } from "../../canonical.ts";
import type { Workload } from "../../harness/generate.ts";
import type { Invariant } from "../../invariants.ts";
import type { NodeId } from "../../protocol.ts";
import type { KvOp, KvResult } from "./kv.ts";
import type { RaftView } from "./types.ts";

/** Key written only by `client`, through a chain of cas operations. */
export const chainKey = (client: NodeId) => `chain:${client}`;
const SHARED_KEYS = ["k0", "k1", "k2"];

/**
 * Per client: a cas chain on its own key (each cas expects the previous value, so a
 * duplicated or lost application makes a later cas fail), interleaved with reads of its own
 * key and puts/gets on shared keys.
 */
export const raftKvWorkload: Workload = (rng, clients, fromMs, toMs) => {
  const actions: ReturnType<Workload> = [];
  for (const client of clients) {
    const count = rng.int(5, 30);
    const times = Array.from({ length: count }, () => rng.int(fromMs, toMs - 1)).sort(
      (a, b) => a - b,
    );
    let chain = 0;
    for (const atMs of times) {
      const roll = rng.next();
      let op: KvOp;
      if (roll < 0.55) {
        op = {
          type: "cas",
          key: chainKey(client),
          expect: chain === 0 ? null : String(chain),
          value: String(chain + 1),
        };
        chain++;
      } else if (roll < 0.7) {
        op = { type: "get", key: chainKey(client) };
      } else if (roll < 0.85) {
        op = { type: "put", key: rng.pick(SHARED_KEYS), value: `${client}-${atMs}` };
      } else {
        op = { type: "get", key: rng.pick(SHARED_KEYS) };
      }
      actions.push({
        atMs,
        action: { type: "client", node: client, command: op as CanonicalValue },
      });
    }
  }
  return actions;
};

/**
 * Client-visible correctness for the workload above. Clients are never crashed in generated
 * scenarios, so every operation completes exactly once in order, and:
 * - every cas on a client's own chain succeeds (no lost or duplicated application);
 * - a client reading its own chain key sees its latest completed cas (it is the only writer,
 *   and reads go through the log, so any other value is a stale or wrong read).
 */
export function clientChains(): Invariant<RaftView> {
  let ops = new Map<string, KvOp>();
  let lastWritten = new Map<NodeId, string | null>();
  return {
    name: "client-chains",
    save: () => ({ ops, lastWritten }),
    load: (state) => {
      ({ ops, lastWritten } = state as { ops: typeof ops; lastWritten: typeof lastWritten });
    },
    check() {},
    onRecord(r, _now, report) {
      if (r.type !== "annotate") return;
      const data = r.data as { seq?: number; op?: KvOp; result?: KvResult } | undefined;
      if (data?.seq === undefined) return;
      const key = `${r.node}#${data.seq}`;
      if (r.label === "invoke" && data.op !== undefined) {
        ops.set(key, data.op);
        return;
      }
      if (r.label !== "complete" || data.result === undefined) return;
      const op = ops.get(key);
      if (op === undefined || op.key !== chainKey(r.node)) return;
      if (op.type === "cas") {
        if (!data.result.ok) {
          report(
            `${r.node}'s cas ${JSON.stringify(op.expect)} -> ${op.value} on its own key failed (found ${JSON.stringify(data.result.value)}): an earlier write was lost or applied twice`,
            [r.node],
          );
        }
        lastWritten.set(r.node, op.value);
      } else if (op.type === "get") {
        const expected = lastWritten.get(r.node) ?? null;
        if (data.result.value !== expected) {
          report(
            `${r.node} read ${JSON.stringify(data.result.value)} from its own key after writing ${JSON.stringify(expected)}`,
            [r.node],
          );
        }
      }
    },
  };
}
