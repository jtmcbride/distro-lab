import type { NodeId } from "./protocol.ts";
import type { Rng } from "./rng.ts";

export type SendOutcome =
  { readonly delays: readonly number[] } | { readonly dropped: "loss" | "link-down" };

/**
 * The engine's view of the network. Implementations decide, using only the supplied RNG,
 * what happens to each message.
 */
export interface Network<Change = never> {
  /**
   * Called when `from` sends to `to`: either one delay per copy to deliver (two entries
   * duplicate the message) or the reason it is dropped.
   */
  onSend(from: NodeId, to: NodeId, now: number, rng: Rng): SendOutcome;
  /** Checked again at delivery time; false drops a message that was in flight. */
  canDeliver(from: NodeId, to: NodeId, now: number): boolean;
  /** Applies a scheduled network action (partition, heal, latency change, ...). */
  apply(change: Change): void;
}

/** Lossless network with a fixed delay. Useful for tests and as a baseline. */
export class FixedLatencyNetwork implements Network {
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  onSend(): SendOutcome {
    return { delays: [this.delayMs] };
  }

  canDeliver(): boolean {
    return true;
  }

  apply(change: never): void {
    throw new Error(`FixedLatencyNetwork has no changes: ${String(change)}`);
  }
}
