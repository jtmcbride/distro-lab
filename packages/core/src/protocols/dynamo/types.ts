import type { ClientMessage } from "../../clients/requestClient.ts";
import type { NodeId } from "../../protocol.ts";
import type { Context, Dot, Version } from "./clock.ts";
import type { Crdt } from "./crdt.ts";

export interface DynamoConfig {
  /** Replicas per key. */
  readonly n: number;
  /** Replies a get waits for. */
  readonly r: number;
  /** Acknowledgements a put waits for. */
  readonly w: number;
  /**
   * Sloppy quorum: when replicas do not answer in time, use the next servers on the ring
   * (writes leave a hint for the replica they stand in for). Strict: reply `unavailable`.
   */
  readonly sloppy: boolean;
  /** How long a coordinator waits for replies before asking again, and again before giving up. */
  readonly requestTimeoutMs: number;
  /** Fix stale replicas a get noticed. */
  readonly readRepair: boolean;
  /** Period of hinted-handoff attempts while a server holds hints. */
  readonly handoffIntervalMs: number;
  /** Mean period of anti-entropy exchanges with a random peer (0 disables them). */
  readonly antiEntropyIntervalMs: number;
}

export const DEFAULT_DYNAMO_CONFIG: DynamoConfig = {
  n: 3,
  r: 2,
  w: 2,
  sloppy: true,
  requestTimeoutMs: 200,
  readRepair: true,
  handoffIntervalMs: 200,
  antiEntropyIntervalMs: 500,
};

export type DynamoOp =
  /** Reads any key: a register's siblings, or a counter's or set's state. */
  | { readonly type: "get"; readonly key: string }
  /**
   * Registers. `context` is everything the writer last read; the new version replaces
   * those. Clients fill it in from their own reads when the operation leaves it out.
   */
  | {
      readonly type: "put";
      readonly key: string;
      readonly value: string;
      readonly context?: Context;
    }
  /** Counters (`count:` keys): add `by` (a positive integer). */
  | { readonly type: "incr"; readonly key: string; readonly by: number }
  /** Sets (`set:` keys). */
  | { readonly type: "add"; readonly key: string; readonly element: string }
  /**
   * Removes the tags of `element` the writer observed (clients fill them in from their own
   * reads when the operation leaves them out). Adds it has not seen survive.
   */
  | {
      readonly type: "remove";
      readonly key: string;
      readonly element: string;
      readonly observed?: readonly Dot[];
    };

export type DynamoResult =
  /** A register's siblings: every version the replicas that answered held, merged. */
  | { readonly type: "get"; readonly versions: readonly Version[] }
  /** A counter's or set's state, joined from the replicas that answered. */
  | { readonly type: "crdt"; readonly state: Crdt }
  /** The version the put created. */
  | { readonly type: "put"; readonly dot: Dot; readonly write: string }
  /** The coordinator's own running total for the counter, which now includes this increment. */
  | { readonly type: "incr"; readonly node: NodeId; readonly total: number }
  /** The tag the add created. */
  | { readonly type: "add"; readonly element: string; readonly tag: Dot }
  | { readonly type: "remove"; readonly element: string; readonly observed: readonly Dot[] }
  /** The operation does not apply to the key's type (e.g. `incr` on a register). */
  | { readonly type: "invalid"; readonly reason: string };

/**
 * What a server stores for a key: a register's sibling versions, or a counter's or set's
 * state. Updates and replication join slots of the same kind.
 */
export type Slot = readonly Version[] | Crdt;

export type Store = Record<string, Slot>;

export interface DynamoPersistent {
  /**
   * Per key, as coordinator: the last dot counter this server stamped (registers and sets),
   * or its running total of increments (counters).
   */
  counters: Record<string, number>;
  /** Request ids issued as coordinator; durable so replies to an old life never match. */
  requests: number;
  /** Keys this server replicates. */
  data: Store;
  /** Writes held for another server (sloppy quorum), by that server. */
  hints: Record<NodeId, Store>;
}

/** One request this server is coordinating. */
export interface Coordination {
  readonly id: string;
  readonly kind: "read" | "write";
  readonly key: string;
  readonly clientId: NodeId;
  readonly seq: number;
  /** Writes: the update being replicated, and the reply once W servers stored it. */
  readonly update: Slot | null;
  readonly result: DynamoResult | null;
  /** Servers asked so far, each mapped to the replica it stands in for (itself for replicas). */
  readonly standsFor: Record<NodeId, NodeId>;
  /** 0 until the first timeout, then 1 (a coordinator asks twice, then gives up). */
  round: number;
  /** Writes: who stored the update. Reads: what each server answered. */
  readonly answers: Record<NodeId, Slot>;
  replied: boolean;
}

export interface DynamoVolatile {
  pending: Record<string, Coordination>;
  /** A handoff attempt is scheduled. */
  handoffArmed: boolean;
  /** Anti-entropy partners are taken in turn (from a random start): index of the next. */
  syncNext: number;
}

/** Plain-data view for inspectors and invariants. Shares state; never mutate or retain. */
export type DynamoView = {
  readonly counters: Readonly<Record<string, number>>;
  readonly data: Readonly<Store>;
  readonly hints: Readonly<Record<NodeId, Readonly<Store>>>;
  /** Requests being coordinated. */
  readonly pending: number;
};

export interface Replicate {
  readonly type: "Replicate";
  readonly req: string;
  readonly key: string;
  readonly value: Slot;
  /** Set when the receiver stands in for this replica (sloppy quorum). */
  readonly hintFor: NodeId | null;
}

export interface ReplicateAck {
  readonly type: "ReplicateAck";
  readonly req: string;
}

export interface Read {
  readonly type: "Read";
  readonly req: string;
  readonly key: string;
}

export interface ReadReply {
  readonly type: "ReadReply";
  readonly req: string;
  readonly value: Slot;
}

/** Read repair: the merged result of a get, for a replica that answered with less. */
export interface Repair {
  readonly type: "Repair";
  readonly key: string;
  readonly value: Slot;
}

/** Hinted handoff: versions held for the receiver while it was unreachable. */
export interface Handoff {
  readonly type: "Handoff";
  readonly key: string;
  readonly value: Slot;
}

export interface HandoffAck {
  readonly type: "HandoffAck";
  readonly key: string;
  readonly value: Slot;
}

/** Anti-entropy, step 1: a digest of each key both servers replicate. */
export interface SyncDigest {
  readonly type: "SyncDigest";
  readonly digests: Readonly<Record<string, number>>;
}

/** Anti-entropy, steps 2 and 3: versions for keys that differ, and keys to send back. */
export interface SyncData {
  readonly type: "SyncData";
  readonly entries: Readonly<Store>;
  readonly want: readonly string[];
}

export type DynamoMessage =
  | Replicate
  | ReplicateAck
  | Read
  | ReadReply
  | Repair
  | Handoff
  | HandoffAck
  | SyncDigest
  | SyncData
  | ClientMessage<DynamoOp, DynamoResult>;
