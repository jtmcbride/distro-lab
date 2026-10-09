import type { TraceRecord } from "@distro-lab/core";
import { recordById } from "./trace.ts";

/**
 * The chain of causes of a record, from the record itself back to its root (a scenario
 * action or a node's init). Every record names exactly one cause, so this is a path.
 */
export function causalChain(id: number, limit = 200): TraceRecord[] {
  const chain: TraceRecord[] = [];
  for (let r = recordById(id); r !== undefined && chain.length < limit;) {
    chain.push(r);
    r = r.cause === null ? undefined : recordById(r.cause);
  }
  return chain;
}

/** Ids of the message sends on a record's causal chain (for highlighting arrows). */
export function chainSends(id: number | null): Set<number> {
  const out = new Set<number>();
  if (id === null) return out;
  for (const r of causalChain(id)) {
    if (r.type === "send") out.add(r.id);
    if (r.type === "deliver" || r.type === "drop") out.add(r.send);
  }
  return out;
}
