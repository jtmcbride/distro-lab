import type { NodeId } from "./protocol.ts";
import type { TraceRecord } from "./trace.ts";

/** The process a record happened at, or null for network changes (which affect every link). */
export function processOf(r: TraceRecord): NodeId | null {
  switch (r.type) {
    case "send":
      return r.from;
    case "deliver":
    case "drop":
      return r.to;
    case "network":
      return null;
    default:
      return r.node;
  }
}

/**
 * The causal past of a moment: every record that happened before it (Lamport's
 * happens-before), as seen by `nodes` right after record `at`. A record is in the past if it
 * happened earlier at one of those processes, or earlier at a process that sent them, directly
 * or indirectly, a message they received before `at`.
 *
 * Drops are left out (a message that never arrived changed nobody's state), and so are
 * network changes, which are global; see `networkChangesBefore`.
 *
 * `trace` must be indexed by record id (as the host and UI keep it).
 */
export function causalPast(
  trace: readonly TraceRecord[],
  at: number,
  nodes: readonly NodeId[],
): Set<number> {
  // frontier[p]: records of process p with id <= this are in the past.
  const frontier = new Map<NodeId, number>(nodes.map((n) => [n, at]));
  const past = new Set<number>();
  for (let id = Math.min(at, trace.length - 1); id >= 0; id--) {
    const r = trace[id]!;
    if (r.type === "drop") continue;
    const p = processOf(r);
    if (p === null || id > (frontier.get(p) ?? -1)) continue;
    past.add(id);
    if (r.type === "deliver") frontier.set(r.from, Math.max(frontier.get(r.from) ?? -1, r.send));
  }
  return past;
}

/** Network changes up to record `at`: they may have shaped any message in its past. */
export function networkChangesBefore(trace: readonly TraceRecord[], at: number): TraceRecord[] {
  return trace.slice(0, at + 1).filter((r) => r.type === "network");
}

/**
 * Faults that shaped the causal past by their absence: when a message sent in `past` was
 * dropped because its receiver was down, the receiver's crash; when it was dropped because
 * its link was cut, the latest network change before the drop. (Losses are random and have
 * no record.)
 */
export function omissionCauses(
  trace: readonly TraceRecord[],
  past: ReadonlySet<number>,
  at: number,
): Set<number> {
  const causes = new Set<number>();
  const lastCrash = new Map<NodeId, number>();
  let lastNetwork = -1;
  for (let id = 0; id <= Math.min(at, trace.length - 1); id++) {
    const r = trace[id]!;
    if (r.type === "crash") lastCrash.set(r.node, id);
    else if (r.type === "network") lastNetwork = id;
    else if (r.type === "drop" && past.has(r.send)) {
      const cause =
        r.reason === "node-down"
          ? lastCrash.get(r.to)
          : r.reason === "link-down"
            ? lastNetwork
            : undefined;
      if (cause !== undefined && cause >= 0) causes.add(cause);
    }
  }
  return causes;
}
