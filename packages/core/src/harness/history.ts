import type { CanonicalValue } from "../canonical.ts";
import type { NodeId } from "../protocol.ts";
import type { TraceRecord } from "../trace.ts";

/** One client operation: from its `invoke` to its `complete`, across all retries. */
export interface HistoryOp {
  /** `client#seq`, as the linearizability check names it. */
  readonly id: string;
  readonly client: NodeId;
  readonly seq: number;
  readonly input: CanonicalValue;
  /** Null while pending (no reply yet, or the client crashed). */
  readonly output: CanonicalValue | null;
  readonly invokedAt: number;
  readonly completedAt: number | null;
  readonly invokeRecord: number;
  readonly completeRecord: number | null;
}

/** How a protocol's operations are grouped and printed (e.g. by key, `put x="1"`). */
export interface HistoryFormat {
  partition(input: CanonicalValue): string;
  describeInput(input: CanonicalValue): string;
  describeOutput(output: CanonicalValue): string;
}

/** Ops on a `key` field, printed as JSON. */
export const DEFAULT_HISTORY_FORMAT: HistoryFormat = {
  partition: (input) => {
    const key = (input as { key?: unknown } | null)?.key;
    return typeof key === "string" ? key : "";
  },
  describeInput: (input) => JSON.stringify(input),
  describeOutput: (output) => JSON.stringify(output),
};

/** Builds the client-visible history from trace records as they arrive. */
export class ClientHistoryBuilder {
  /** In invocation order. */
  readonly ops: HistoryOp[] = [];
  private readonly byId = new Map<string, number>();

  add(r: TraceRecord): void {
    if (r.type !== "annotate") return;
    const data = r.data as { seq?: number; op?: CanonicalValue; result?: CanonicalValue } | null;
    if (typeof data?.seq !== "number") return;
    const id = `${r.node}#${data.seq}`;
    if (r.label === "invoke" && data.op !== undefined) {
      this.byId.set(id, this.ops.length);
      this.ops.push({
        id,
        client: r.node,
        seq: data.seq,
        input: data.op,
        output: null,
        invokedAt: r.t,
        completedAt: null,
        invokeRecord: r.id,
        completeRecord: null,
      });
    } else if (r.label === "complete" && data.result !== undefined) {
      const i = this.byId.get(id);
      if (i === undefined) return;
      this.ops[i] = {
        ...this.ops[i]!,
        output: data.result,
        completedAt: r.t,
        completeRecord: r.id,
      };
    }
  }
}

/** The client-visible history in a trace, in invocation order. */
export function clientHistory(records: Iterable<TraceRecord>): HistoryOp[] {
  const builder = new ClientHistoryBuilder();
  for (const r of records) builder.add(r);
  return builder.ops;
}

/**
 * Real-time order relative to `op`: `before` completed before it was invoked, `after` was
 * invoked after it completed, otherwise the two overlap. Uses trace order, which also
 * orders records at the same instant.
 */
export function relativeTo(other: HistoryOp, op: HistoryOp): "before" | "after" | "concurrent" {
  if (other.completeRecord !== null && other.completeRecord < op.invokeRecord) return "before";
  if (op.completeRecord !== null && other.invokeRecord > op.completeRecord) return "after";
  return "concurrent";
}
