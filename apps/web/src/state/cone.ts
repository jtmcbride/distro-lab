import { causalPast, omissionCauses } from "@distro-lab/core";
import { useSim } from "./store.ts";
import { trace, traceEpoch } from "./trace.ts";

export interface Cone {
  /** Records in the causal past of the explained moment (by id). */
  readonly past: ReadonlySet<number>;
  /** Crashes and network changes that shaped it by dropping its messages. */
  readonly omissions: ReadonlySet<number>;
}

let cached: { key: string; cone: Cone } | null = null;

/** The causal past being explained, if any (recomputed only when its inputs change). */
export function currentCone(): Cone | null {
  const e = useSim.getState().explain;
  if (e === null || e.record >= trace.length) return null;
  const key = `${traceEpoch.value}/${e.record}/${e.nodes.join()}`;
  if (cached?.key !== key) {
    const past = causalPast(trace, e.record, e.nodes);
    cached = { key, cone: { past, omissions: omissionCauses(trace, past, e.record) } };
  }
  return cached.cone;
}

/** Shows the causal past of the moment right after record `record`, as seen by `nodes`. */
export function explain(record: number, nodes: readonly string[], label: string): void {
  useSim.setState({ explain: { record, nodes: [...new Set(nodes)], label } });
}
