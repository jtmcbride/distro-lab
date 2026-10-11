import { linearizable, type Model } from "../../linearizability.ts";
import type { NodeId } from "../../protocol.ts";

/** Operations clients can run against the replicated store. Values are strings. */
export type KvOp =
  | { readonly type: "get"; readonly key: string }
  | { readonly type: "put"; readonly key: string; readonly value: string }
  /** Sets `key` to `value` only if its current value is `expect` (null = absent). */
  | {
      readonly type: "cas";
      readonly key: string;
      readonly expect: string | null;
      readonly value: string;
    };

/** `ok` is false only for a failed cas. `value` is the key's value after the operation. */
export type KvResult = { readonly ok: boolean; readonly value: string | null };

export interface Session {
  /** Highest request seq applied for this client. */
  readonly seq: number;
  /** Its result, returned again if the request is retried. */
  readonly result: KvResult;
}

/** The replicated state machine: the store plus per-client sessions for exactly-once. */
export interface KvState {
  data: Record<string, string>;
  sessions: Record<NodeId, Session>;
}

export function emptyKv(): KvState {
  return { data: {}, sessions: {} };
}

export function executeKv(data: Record<string, string>, op: KvOp): KvResult {
  const current = Object.hasOwn(data, op.key) ? data[op.key]! : null;
  switch (op.type) {
    case "get":
      return { ok: true, value: current };
    case "put":
      data[op.key] = op.value;
      return { ok: true, value: op.value };
    case "cas":
      if (current !== op.expect) return { ok: false, value: current };
      data[op.key] = op.value;
      return { ok: true, value: op.value };
  }
}

/**
 * Applies one client command exactly once. A retried (clientId, seq) that was already
 * applied returns the cached result without executing again. Returns null for a stale
 * request older than the client's latest, which cannot happen with one outstanding request
 * per client unless messages are badly reordered; it is ignored.
 */
export function applyClientCommand(
  kv: KvState,
  clientId: NodeId,
  seq: number,
  op: KvOp,
): KvResult | null {
  const session = kv.sessions[clientId];
  if (session !== undefined) {
    if (seq === session.seq) return session.result;
    if (seq < session.seq) return null;
  }
  const result = executeKv(kv.data, op);
  kv.sessions[clientId] = { seq, result };
  return result;
}

/** The store as a sequential specification, one register per key. */
export const kvModel: Model<string | null, KvOp, KvResult> = {
  init: () => null,
  partition: (op) => op.key,
  step(state, op) {
    const data: Record<string, string> = state === null ? {} : { [op.key]: state };
    const output = executeKv(data, op);
    return { state: data[op.key] ?? null, output };
  },
};

export function describeKvOp(op: KvOp): string {
  switch (op.type) {
    case "get":
      return `get ${op.key}`;
    case "put":
      return `put ${op.key}=${JSON.stringify(op.value)}`;
    case "cas":
      return `cas ${op.key} ${JSON.stringify(op.expect)}->${JSON.stringify(op.value)}`;
  }
}

export function describeKvResult(r: KvResult): string {
  return r.ok ? JSON.stringify(r.value) : `failed (found ${JSON.stringify(r.value)})`;
}

/** The Raft store promises linearizability for every operation. */
export const linearizableKv = () =>
  linearizable(kvModel, { describeInput: describeKvOp, describeOutput: describeKvResult });
