import type { CanonicalValue, TraceRecord } from "@distro-lab/core";
import { trace, traceEpoch } from "./trace.ts";

export interface InFlight {
  readonly key: string;
  readonly send: number;
  readonly from: string;
  readonly to: string;
  readonly t: number;
  readonly arrival: number;
  readonly message: CanonicalValue;
}

export interface Drop {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly t: number;
  /** Dropped when sent (lost or link down) rather than on arrival. */
  readonly atSend: boolean;
  readonly reason: string;
}

interface Pending {
  readonly from: string;
  readonly to: string;
  readonly t: number;
  readonly message: CanonicalValue;
  /** Arrival times of copies not yet delivered or dropped. */
  readonly arrivals: number[];
}

/**
 * Tracks messages in flight by reading the trace incrementally: a send adds one entry per
 * copy, a deliver or drop removes one. The animation only places dots; it never decides
 * what happens to a message.
 */
class InFlightTracker {
  private read = 0;
  private epoch = -1;
  private readonly pending = new Map<number, Pending>();
  private drops: Drop[] = [];

  update(): void {
    if (traceEpoch.value !== this.epoch) this.reset();
    for (; this.read < trace.length; this.read++) this.apply(trace[this.read]!);
  }

  inFlight(now: number): InFlight[] {
    const out: InFlight[] = [];
    for (const [send, p] of this.pending) {
      if (p.t > now) continue;
      p.arrivals.forEach((arrival, i) => {
        if (arrival >= now) {
          out.push({
            key: `${send}.${i}`,
            send,
            from: p.from,
            to: p.to,
            t: p.t,
            arrival,
            message: p.message,
          });
        }
      });
    }
    return out;
  }

  /** Drops that happened within `windowMs` before `now`. */
  recentDrops(now: number, windowMs: number): Drop[] {
    this.drops = this.drops.filter((d) => d.t > now - Math.max(windowMs, 1) * 4);
    return this.drops.filter((d) => d.t <= now && d.t > now - windowMs);
  }

  private reset(): void {
    this.read = 0;
    this.epoch = traceEpoch.value;
    this.pending.clear();
    this.drops = [];
  }

  private apply(r: TraceRecord): void {
    if (r.type === "send") {
      if (r.arrivals.length > 0) {
        this.pending.set(r.id, {
          from: r.from,
          to: r.to,
          t: r.t,
          message: r.message,
          arrivals: [...r.arrivals].sort((a, b) => a - b),
        });
      }
      return;
    }
    if (r.type !== "deliver" && r.type !== "drop") return;
    const p = this.pending.get(r.send);
    if (r.type === "drop") {
      this.drops.push({
        key: `${r.id}`,
        from: r.from,
        to: r.to,
        t: r.t,
        atSend: p === undefined || p.t === r.t,
        reason: r.reason,
      });
    }
    if (p === undefined) return;
    const i = p.arrivals.indexOf(r.t);
    p.arrivals.splice(i >= 0 ? i : 0, 1);
    if (p.arrivals.length === 0) this.pending.delete(r.send);
  }
}

export const inFlight = new InFlightTracker();
