import { ClientHistoryBuilder, type HistoryOp } from "@distro-lab/core";
import { trace, traceEpoch } from "./trace.ts";

let cache = { epoch: -1, scanned: 0, builder: new ClientHistoryBuilder() };

/**
 * The client-visible history of the trace so far, in invocation order. Built incrementally;
 * starts over when the trace is rewound. The returned array is a fresh copy.
 */
export function currentHistory(): HistoryOp[] {
  if (cache.epoch !== traceEpoch.value || cache.scanned > trace.length) {
    cache = { epoch: traceEpoch.value, scanned: 0, builder: new ClientHistoryBuilder() };
  }
  for (; cache.scanned < trace.length; cache.scanned++) cache.builder.add(trace[cache.scanned]!);
  return [...cache.builder.ops];
}

/** The key an operation acts on ("" if none). */
export function keyOf(op: HistoryOp): string {
  const key = (op.input as { key?: unknown } | null)?.key;
  return typeof key === "string" ? key : "";
}
