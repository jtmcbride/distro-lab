import type { TraceRecord } from "@distro-lab/core";
import { trace } from "./trace.ts";

/** Index of the first record with t >= time (records are in time order). */
export function firstAtOrAfter(time: number): number {
  let lo = 0;
  let hi = trace.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trace[mid]!.t < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type Outcome =
  | { readonly kind: "delivered"; readonly t: number; readonly record: number }
  | {
      readonly kind: "dropped";
      readonly t: number;
      readonly reason: string;
      readonly record: number;
    };

/** Deliver/drop outcomes per send, for records in [fromIndex, toIndex). */
export function outcomesIn(fromIndex: number, toIndex: number): Map<number, Outcome[]> {
  const out = new Map<number, Outcome[]>();
  for (let i = fromIndex; i < toIndex; i++) {
    const r = trace[i]!;
    if (r.type !== "deliver" && r.type !== "drop") continue;
    const list = out.get(r.send) ?? [];
    list.push(
      r.type === "deliver"
        ? { kind: "delivered", t: r.t, record: r.id }
        : { kind: "dropped", t: r.t, reason: r.reason, record: r.id },
    );
    out.set(r.send, list);
  }
  return out;
}

/** All outcomes of one send (scans forward from it). */
export function outcomesOf(send: TraceRecord & { type: "send" }): Outcome[] {
  const start = trace.indexOf(send);
  const last = Math.max(send.t, ...send.arrivals);
  const end = firstAtOrAfter(last + 0.0005) + 64;
  return outcomesIn(start, Math.min(trace.length, end)).get(send.id) ?? [];
}
