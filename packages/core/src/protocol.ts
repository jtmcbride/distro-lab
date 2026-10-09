import type { CanonicalValue } from "./canonical.ts";
import type { Rng } from "./rng.ts";

export type NodeId = string;

/**
 * Node state is split by durability. On crash the engine keeps `persistent` (handlers are
 * atomic, so its value at crash time is exactly what was on disk) and discards `volatile`.
 */
export interface NodeState<P, V> {
  persistent: P;
  volatile: V;
}

/**
 * Handed to every protocol callback. Effects requested here are buffered and applied by the
 * engine only after the callback returns, so a handler is an atomic step.
 */
export interface NodeContext<M> {
  readonly nodeId: NodeId;
  /** All other nodes in the cluster, in a stable order. */
  readonly peers: readonly NodeId[];
  /** Current virtual time. */
  readonly now: number;
  /** This node's private random stream. */
  readonly rng: Rng;
  send(to: NodeId, message: M): void;
  /** Arms (or re-arms, replacing any pending firing) the timer named `key`. */
  setTimer(key: string, delayMs: number): void;
  cancelTimer(key: string): void;
  /** Records a protocol-level fact in the trace (e.g. "becameLeader"). */
  annotate(label: string, data?: CanonicalValue): void;
}

/**
 * A distributed protocol. Callbacks may mutate the state they are given but must not perform
 * I/O, read real time, or use any randomness other than `ctx.rng`.
 */
export interface Protocol<P, V, M, C = never> {
  readonly name: string;
  init(ctx: NodeContext<M>): NodeState<P, V>;
  /** Rebuild a node after a crash from its durable state only. */
  recover(ctx: NodeContext<M>, persistent: P): NodeState<P, V>;
  onMessage(ctx: NodeContext<M>, state: NodeState<P, V>, from: NodeId, message: M): void;
  onTimer(ctx: NodeContext<M>, state: NodeState<P, V>, key: string): void;
  onClientCommand(ctx: NodeContext<M>, state: NodeState<P, V>, command: C): void;
  /** Plain-data view of a node for inspectors and invariant checks. */
  view(state: NodeState<P, V>): CanonicalValue;
}
