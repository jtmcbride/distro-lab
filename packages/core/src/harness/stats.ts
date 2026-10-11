import type { CanonicalValue } from "../canonical.ts";
import type { HistoryOp } from "./history.ts";

/** Latency summary for one kind of client operation. */
export interface OpStats {
  readonly invoked: number;
  readonly completed: number;
  /** Percentiles of invoke-to-complete time, in ms (null if nothing completed). */
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

/** The value at fraction `q` of a sorted list (nearest rank). */
function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

/** Operation kind: the op's `type` field (e.g. "get"), or "op". */
export function opKind(input: CanonicalValue): string {
  const type = (input as { type?: unknown } | null)?.type;
  return typeof type === "string" ? type : "op";
}

/** Latency percentiles per operation kind, over any number of runs' histories. */
export function operationStats(histories: Iterable<readonly HistoryOp[]>): Record<string, OpStats> {
  const latencies = new Map<string, number[]>();
  const invoked = new Map<string, number>();
  for (const ops of histories) {
    for (const op of ops) {
      const kind = opKind(op.input);
      invoked.set(kind, (invoked.get(kind) ?? 0) + 1);
      if (op.completedAt === null) continue;
      const list = latencies.get(kind) ?? [];
      list.push(op.completedAt - op.invokedAt);
      latencies.set(kind, list);
    }
  }
  const out: Record<string, OpStats> = {};
  for (const kind of [...invoked.keys()].sort()) {
    const sorted = (latencies.get(kind) ?? []).sort((a, b) => a - b);
    const round = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
    out[kind] = {
      invoked: invoked.get(kind)!,
      completed: sorted.length,
      p50: round(quantile(sorted, 0.5)),
      p90: round(quantile(sorted, 0.9)),
      p99: round(quantile(sorted, 0.99)),
      max: round(sorted.at(-1) ?? null),
    };
  }
  return out;
}
