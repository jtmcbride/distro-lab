import type { CanonicalValue } from "../canonical.ts";
import type { NodeContext, NodeId, Protocol } from "../protocol.ts";

/** Client -> server. `(clientId, seq)` identifies a request across retries. */
export interface ClientRequest<Op> {
  readonly type: "ClientRequest";
  readonly clientId: NodeId;
  readonly seq: number;
  readonly op: Op;
}

/** Server -> client. */
export type ClientReply<R> =
  | {
      readonly type: "ClientReply";
      readonly seq: number;
      readonly status: "ok";
      readonly result: R;
    }
  | {
      readonly type: "ClientReply";
      readonly seq: number;
      readonly status: "notLeader";
      /** Who the server believes leads, if anyone. */
      readonly leaderHint: NodeId | null;
    }
  | {
      readonly type: "ClientReply";
      readonly seq: number;
      /** The server could not run the request now (e.g. no quorum reachable); try elsewhere. */
      readonly status: "unavailable";
    };

export type ClientMessage<Op, R> = ClientRequest<Op> | ClientReply<R>;

export interface RequestClientConfig {
  /** Retry against another server if no reply arrives within this long. */
  readonly requestTimeoutMs: number;
  /** Wait before retrying after a redirect that names no usable leader. */
  readonly noLeaderBackoffMs: number;
}

export const DEFAULT_REQUEST_CLIENT_CONFIG: RequestClientConfig = {
  requestTimeoutMs: 400,
  noLeaderBackoffMs: 50,
};

/**
 * Optional protocol-specific behavior. `memory` is the client's own scratch space (volatile,
 * plain data), e.g. the version context each key was last read at.
 */
export interface RequestClientHooks<Op, R> {
  /** Rewrites an operation as it starts, before its `invoke` is recorded. */
  prepare?(op: Op, memory: Record<string, CanonicalValue>): Op;
  /** Learns from a completed operation. */
  observe?(op: Op, result: R, memory: Record<string, CanonicalValue>): void;
}

export interface RequestClientPersistent {
  /**
   * Next request number. Durable so a restarted client never reuses one: servers
   * deduplicate by (clientId, seq), and reuse would make them drop a new request.
   */
  nextSeq: number;
}

interface InFlight<Op> {
  readonly seq: number;
  readonly op: Op;
  target: NodeId;
  attempts: number;
  readonly invokedAt: number;
}

export interface RequestClientVolatile<Op> {
  /** Operations waiting to be sent; one request is outstanding at a time. */
  queue: Op[];
  current: InFlight<Op> | null;
  leaderHint: NodeId | null;
  completed: number;
  memory: Record<string, CanonicalValue>;
}

export type RequestClientView = {
  readonly nextSeq: number;
  readonly queued: number;
  readonly inFlight: number | null;
  readonly leaderHint: NodeId | null;
  readonly completed: number;
};

const RETRY_TIMER = "retry";
const BACKOFF_TIMER = "backoff";
const UNAVAILABLE_TIMER = "unavailable";

/**
 * A client process that issues operations one at a time, follows leader redirects, and
 * retries on timeout against a different server.
 *
 * Trace annotations form the client-visible history: `invoke {seq, op}` when an operation
 * starts, `complete {seq, result}` when its reply arrives. An `invoke` without a `complete`
 * (e.g. the client crashed) has an unknown outcome.
 *
 * `M` is the full message type of the simulation; this client only ever sends
 * `ClientRequest<Op>` and only reacts to `ClientReply<R>`.
 */
export function requestClient<Op, R, M extends { readonly type: string } = ClientMessage<Op, R>>(
  overrides: Partial<RequestClientConfig> = {},
  hooks: RequestClientHooks<Op, R> = {},
): Protocol<RequestClientPersistent, RequestClientVolatile<Op>, M, Op> {
  const config = { ...DEFAULT_REQUEST_CLIENT_CONFIG, ...overrides };
  type Ctx = NodeContext<M>;
  type State = { persistent: RequestClientPersistent; volatile: RequestClientVolatile<Op> };

  function send(ctx: Ctx, req: InFlight<Op>): void {
    const message: ClientRequest<Op> = {
      type: "ClientRequest",
      clientId: ctx.nodeId,
      seq: req.seq,
      op: req.op,
    };
    req.attempts++;
    ctx.send(req.target, message as unknown as M);
    ctx.setTimer(RETRY_TIMER, config.requestTimeoutMs);
  }

  function startNext(ctx: Ctx, s: State): void {
    const v = s.volatile;
    if (v.current !== null) return;
    const queued = v.queue.shift();
    if (queued === undefined) return;
    const op = hooks.prepare?.(queued, v.memory) ?? queued;
    const seq = s.persistent.nextSeq++;
    const target = v.leaderHint ?? ctx.rng.pick(ctx.peers);
    v.current = { seq, op, target, attempts: 0, invokedAt: ctx.now };
    ctx.annotate("invoke", { seq, op: op as CanonicalValue, server: target });
    send(ctx, v.current);
  }

  /** Re-send the current request to `target`, or to a random other server. */
  function retry(ctx: Ctx, s: State, reason: string, target?: NodeId): void {
    const req = s.volatile.current;
    if (req === null) return;
    const others = ctx.peers.filter((p) => p !== req.target);
    req.target = target ?? (others.length > 0 ? ctx.rng.pick(others) : req.target);
    ctx.annotate("retry", { seq: req.seq, server: req.target, reason });
    send(ctx, req);
  }

  const freshVolatile = (): RequestClientVolatile<Op> => ({
    queue: [],
    current: null,
    leaderHint: null,
    completed: 0,
    memory: {},
  });

  return {
    name: "request-client",

    init() {
      return {
        persistent: { nextSeq: 1 },
        volatile: freshVolatile(),
      };
    },

    recover(_ctx, persistent) {
      // Queued and in-flight operations were in memory and are gone.
      return { persistent, volatile: freshVolatile() };
    },

    onClientCommand(ctx, s, op) {
      s.volatile.queue.push(op);
      startNext(ctx, s);
    },

    onTimer(ctx, s, key) {
      if (key === RETRY_TIMER) {
        // No reply in time: whoever we thought led may be gone.
        s.volatile.leaderHint = null;
        retry(ctx, s, "timeout");
      } else if (key === BACKOFF_TIMER) {
        retry(ctx, s, "no-leader");
      } else if (key === UNAVAILABLE_TIMER) {
        retry(ctx, s, "unavailable");
      }
    },

    onMessage(ctx, s, from, message) {
      if (message.type !== "ClientReply") return;
      const reply = message as unknown as ClientReply<R>;
      const req = s.volatile.current;
      // Replies to earlier attempts of completed requests, or duplicates, are ignored.
      if (req === null || reply.seq !== req.seq) return;

      if (reply.status === "ok") {
        ctx.cancelTimer(RETRY_TIMER);
        s.volatile.leaderHint = from;
        s.volatile.current = null;
        s.volatile.completed++;
        hooks.observe?.(req.op, reply.result, s.volatile.memory);
        ctx.annotate("complete", {
          seq: req.seq,
          result: reply.result as CanonicalValue,
          attempts: req.attempts,
          latencyMs: Math.round((ctx.now - req.invokedAt) * 1000) / 1000,
        });
        startNext(ctx, s);
        return;
      }

      if (from !== req.target) return; // stale reply to an earlier attempt
      if (reply.status === "unavailable") {
        // The server could not serve it now: back off and try elsewhere.
        ctx.cancelTimer(RETRY_TIMER);
        ctx.setTimer(UNAVAILABLE_TIMER, config.noLeaderBackoffMs);
        return;
      }
      // notLeader: follow a useful hint right away, otherwise back off and try elsewhere.
      const hint = reply.leaderHint;
      if (hint !== null && hint !== from && ctx.peers.includes(hint)) {
        s.volatile.leaderHint = hint;
        retry(ctx, s, "redirect", hint);
      } else {
        s.volatile.leaderHint = null;
        ctx.cancelTimer(RETRY_TIMER);
        ctx.setTimer(BACKOFF_TIMER, config.noLeaderBackoffMs);
      }
    },

    view(s): RequestClientView {
      return {
        nextSeq: s.persistent.nextSeq,
        queued: s.volatile.queue.length,
        inFlight: s.volatile.current?.seq ?? null,
        leaderHint: s.volatile.leaderHint,
        completed: s.volatile.completed,
      };
    },
  };
}
