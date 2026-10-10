import { canonicalJson } from "../../canonical.ts";
import {
  requestClient,
  type ClientReply,
  type ClientRequest,
  type RequestClientConfig,
} from "../../clients/requestClient.ts";
import type { NodeContext, NodeId, NodeState, Protocol } from "../../protocol.ts";
import { hashString32 } from "../../rng.ts";
import {
  compareClocks,
  contextOf,
  contextVector,
  EMPTY_CONTEXT,
  historyOf,
  joinContexts,
  mergeVersions,
  type Context,
  type Version,
} from "./clock.ts";
import { crdtKind, emptyCrdt, joinCrdt, type Crdt, type OrSet } from "./crdt.ts";
import { preferenceList } from "./ring.ts";
import {
  DEFAULT_DYNAMO_CONFIG,
  type Coordination,
  type DynamoConfig,
  type DynamoMessage,
  type DynamoOp,
  type DynamoPersistent,
  type DynamoResult,
  type DynamoView,
  type DynamoVolatile,
  type Slot,
  type Store,
  type SyncData,
} from "./types.ts";

/** Internal switches for the planted-bug variants in bugs.ts. */
export interface PlantedDynamoBugs {
  /** Stamp `context[self] + 1` instead of a fresh counter value (the naive rule). */
  readonly reuseCounter?: boolean;
  /**
   * Treat a context as a plain version vector: having seen a coordinator's write 12 counts
   * as having seen its write 11, which may be a concurrent write the writer never read.
   */
  readonly vectorContexts?: boolean;
  /** Replicas keep one version: of concurrent siblings, the larger clock sum wins. */
  readonly lastWriterWins?: boolean;
  /**
   * Compare versions as plain vector clocks (history against history). A write then looks
   * like it includes every earlier write through the same coordinator, even ones its writer
   * never saw.
   */
  readonly plainClocks?: boolean;
  /** Acknowledge a put one replica short of W. */
  readonly ackEarly?: boolean;
  /** Read repair replaces a replica's versions instead of merging into them. */
  readonly repairOverwrites?: boolean;
  /** Join counters by adding entries instead of taking the maximum. */
  readonly sumCounters?: boolean;
  /** A set remove that observed any of an element's tags drops all of them. */
  readonly removeAllTags?: boolean;
}

type State = NodeState<DynamoPersistent, DynamoVolatile>;
type Ctx = NodeContext<DynamoMessage>;

const HANDOFF_TIMER = "handoff";
const SYNC_TIMER = "sync";
const OP_TIMER_PREFIX = "op:";

const historySum = (v: Version) =>
  Object.values(contextVector(historyOf(v))).reduce((a, b) => a + b, 0);
const sorted = (keys: Iterable<string>) => [...keys].sort();
/** A copy of `record` without `key`. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

// Stored slots are replaced, never mutated, so a slot's digest can be cached by identity.
const digests = new WeakMap<object, number>();

/** Fingerprint of a slot's contents (equal contents, equal digest). */
export function slotDigest(slot: Slot): number {
  let d = digests.get(slot);
  if (d === undefined) {
    d = hashString32(canonicalJson(slot as never));
    digests.set(slot, d);
  }
  return d;
}

const digest = slotDigest;
const isRegister = (slot: Slot): slot is readonly Version[] => Array.isArray(slot);

/** What a server holds for a key it has never written. */
export function emptySlot(key: string): Slot {
  const kind = crdtKind(key);
  return kind === null ? [] : emptyCrdt(kind);
}

export function isEmptySlot(slot: Slot): boolean {
  if (isRegister(slot)) return slot.length === 0;
  return slot.type === "counter"
    ? Object.keys(slot.counts).length === 0
    : Object.keys(slot.entries).length === 0 && digest(slot) === digest(emptyCrdt("set"));
}

/**
 * A Dynamo-style leaderless key-value store (DeCandia et al., 2007) with fixed membership.
 *
 * Whichever server a client contacts coordinates its request against the key's preference
 * list: a put stamps a new version and waits for W replicas to store it, a get waits for R
 * replicas and returns every sibling they hold. Concurrent writes become siblings that the
 * next writer resolves by passing the merged context of its read. Replicas that miss writes
 * catch up through hinted handoff, read repair and periodic anti-entropy.
 */
export function dynamo(
  overrides: Partial<DynamoConfig> = {},
  /** Deliberate defects for testing the checkers. See bugs.ts; never set otherwise. */
  bugs: PlantedDynamoBugs = {},
): Protocol<DynamoPersistent, DynamoVolatile, DynamoMessage, DynamoOp> {
  const config = { ...DEFAULT_DYNAMO_CONFIG, ...overrides };
  const int = (x: number, min: number) => Number.isSafeInteger(x) && x >= min;
  if (
    !int(config.n, 1) ||
    !int(config.r, 1) ||
    !int(config.w, 1) ||
    config.r > config.n ||
    config.w > config.n ||
    !(config.requestTimeoutMs > 0) ||
    !(config.handoffIntervalMs > 0) ||
    !(config.antiEntropyIntervalMs >= 0)
  ) {
    throw new RangeError(`invalid Dynamo config: ${JSON.stringify(config)}`);
  }

  const servers = (ctx: Ctx) => [ctx.nodeId, ...ctx.peers];
  const prefs = (ctx: Ctx, key: string) => preferenceList(servers(ctx), key);
  const replicas = (ctx: Ctx, key: string) => prefs(ctx, key).slice(0, config.n);
  const shared = (ctx: Ctx, key: string, other: NodeId) => {
    const r = replicas(ctx, key);
    return r.includes(ctx.nodeId) && r.includes(other);
  };

  function merge(a: readonly Version[], b: readonly Version[]): readonly Version[] {
    const m = mergeVersions(
      a,
      b,
      bugs.plainClocks === true
        ? (x, y) =>
            compareClocks(contextVector(historyOf(x)), contextVector(historyOf(y))) === "before"
        : bugs.vectorContexts === true
          ? (x, y) => (contextVector(y.context)[x.dot.node] ?? 0) >= x.dot.counter
          : undefined,
    );
    if (bugs.lastWriterWins !== true || m.length <= 1) return m;
    const winner = m.reduce((best, v) =>
      historySum(v) > historySum(best) ||
      (historySum(v) === historySum(best) && v.write > best.write)
        ? v
        : best,
    );
    return a.length === 1 && a[0] === winner ? a : [winner];
  }

  /** Joins two slots of the same key. Returns `a` itself when `b` adds nothing. */
  function join(a: Slot, b: Slot): Slot {
    if (isRegister(a) && isRegister(b)) return merge(a, b);
    if (!isRegister(a) && !isRegister(b)) return joinCrdt(a, b, bugs);
    throw new TypeError("cannot join a register with a CRDT");
  }

  // ---------------------------------------------------------------------------------------
  // Local storage

  function storeData(s: State, key: string, value: Slot): void {
    const before = s.persistent.data[key] ?? emptySlot(key);
    const after = join(before, value);
    if (after !== before || !Object.hasOwn(s.persistent.data, key)) s.persistent.data[key] = after;
  }

  function storeHint(ctx: Ctx, s: State, owner: NodeId, key: string, value: Slot) {
    const store = (s.persistent.hints[owner] ??= {});
    const before = store[key] ?? emptySlot(key);
    const after = join(before, value);
    if (after !== before || !Object.hasOwn(store, key)) store[key] = after;
    armHandoff(ctx, s);
  }

  /** What this server can say about a key: its replica data plus any hints for it. */
  function localValue(s: State, key: string): Slot {
    let value = s.persistent.data[key] ?? emptySlot(key);
    for (const owner of sorted(Object.keys(s.persistent.hints))) {
      const hinted = s.persistent.hints[owner]![key];
      if (hinted !== undefined) value = join(value, hinted);
    }
    return value;
  }

  // ---------------------------------------------------------------------------------------
  // Coordinating client requests

  /** The update a write replicates and the reply it earns, or why it does not apply. */
  function prepareWrite(
    ctx: Ctx,
    s: State,
    m: ClientRequest<DynamoOp>,
  ): { update: Slot; result: DynamoResult } | string {
    const p = s.persistent;
    const op = m.op;
    const kind = crdtKind(op.key);
    const last = p.counters[op.key] ?? 0;
    const self = ctx.nodeId;
    switch (op.type) {
      case "get":
        throw new TypeError("not a write");
      case "put": {
        if (kind !== null) return `put does not apply to a ${kind}`;
        const context = joinContexts([op.context ?? EMPTY_CONTEXT]);
        const stamp =
          bugs.reuseCounter === true ? (contextVector(context)[self] ?? 0) + 1 : last + 1;
        p.counters[op.key] = Math.max(last, stamp);
        const version: Version = {
          value: op.value,
          dot: { node: self, counter: stamp },
          context,
          write: `${m.clientId}#${m.seq}`,
        };
        return {
          update: [version],
          result: { type: "put", dot: version.dot, write: version.write },
        };
      }
      case "incr": {
        if (kind !== "counter") return "incr applies only to count: keys";
        if (!Number.isSafeInteger(op.by) || op.by < 1) return "incr needs a positive integer";
        const total = (p.counters[op.key] = last + op.by);
        return {
          update: { type: "counter", counts: { [self]: total } },
          result: { type: "incr", node: self, total },
        };
      }
      case "add": {
        if (kind !== "set") return "add applies only to set: keys";
        const tag = { node: self, counter: (p.counters[op.key] = last + 1) };
        return {
          update: {
            type: "set",
            entries: { [op.element]: [tag] },
            context: joinContexts([], [tag]),
          },
          result: { type: "add", element: op.element, tag },
        };
      }
      case "remove": {
        if (kind !== "set") return "remove applies only to set: keys";
        const observed = op.observed ?? [];
        return {
          update: { type: "set", entries: {}, context: joinContexts([], observed) },
          result: { type: "remove", element: op.element, observed },
        };
      }
    }
  }

  function coordinate(ctx: Ctx, s: State, m: ClientRequest<DynamoOp>): void {
    const id = `${ctx.nodeId}:${++s.persistent.requests}`;
    const op = m.op;
    const write = op.type === "get" ? null : prepareWrite(ctx, s, m);
    if (typeof write === "string") {
      const reply: ClientReply<DynamoResult> = {
        type: "ClientReply",
        seq: m.seq,
        status: "ok",
        result: { type: "invalid", reason: write },
      };
      ctx.send(m.clientId, reply);
      return;
    }
    const c: Coordination = {
      id,
      kind: write === null ? "read" : "write",
      key: op.key,
      clientId: m.clientId,
      seq: m.seq,
      update: write?.update ?? null,
      result: write?.result ?? null,
      standsFor: {},
      round: 0,
      answers: {},
      replied: false,
    };
    s.volatile.pending[id] = c;
    ctx.setTimer(OP_TIMER_PREFIX + id, config.requestTimeoutMs);
    for (const node of replicas(ctx, op.key)) ask(ctx, s, c, node, node);
    progress(ctx, s, c);
  }

  /** Sends the request to `node`, which stands in for replica `owner` (or is it). */
  function ask(ctx: Ctx, s: State, c: Coordination, node: NodeId, owner: NodeId): void {
    c.standsFor[node] = owner;
    const hintFor = node === owner ? null : owner;
    if (node === ctx.nodeId) {
      if (c.kind === "write") {
        if (hintFor === null) storeData(s, c.key, c.update!);
        else storeHint(ctx, s, hintFor, c.key, c.update!);
        c.answers[node] = c.update!;
      } else {
        c.answers[node] = localValue(s, c.key);
      }
      return;
    }
    ctx.send(
      node,
      c.kind === "write"
        ? { type: "Replicate", req: c.id, key: c.key, value: c.update!, hintFor }
        : { type: "Read", req: c.id, key: c.key },
    );
  }

  function answer(ctx: Ctx, s: State, req: string, from: NodeId, value: Slot) {
    const c = s.volatile.pending[req];
    if (c === undefined || !Object.hasOwn(c.standsFor, from) || Object.hasOwn(c.answers, from)) {
      return; // late, duplicated or from an earlier life
    }
    c.answers[from] = value;
    progress(ctx, s, c);
  }

  function merged(c: Coordination): Slot {
    return Object.values(c.answers).reduce((acc, v) => join(acc, v), emptySlot(c.key));
  }

  /** Replies once enough servers answered; finishes once everyone asked has. */
  function progress(ctx: Ctx, s: State, c: Coordination): void {
    const answered = Object.keys(c.answers).length;
    const needed = c.kind === "write" ? config.w - (bugs.ackEarly === true ? 1 : 0) : config.r;
    if (!c.replied && answered >= needed) {
      c.replied = true;
      let result = c.result;
      if (result === null) {
        const value = merged(c);
        result = isRegister(value)
          ? { type: "get", versions: value }
          : { type: "crdt", state: value as Crdt };
      }
      const reply: ClientReply<DynamoResult> = {
        type: "ClientReply",
        seq: c.seq,
        status: "ok",
        result,
      };
      ctx.send(c.clientId, reply);
    }
    if (c.replied && Object.keys(c.standsFor).every((n) => Object.hasOwn(c.answers, n))) {
      finish(ctx, s, c);
    }
  }

  function finish(ctx: Ctx, s: State, c: Coordination): void {
    s.volatile.pending = without(s.volatile.pending, c.id);
    ctx.cancelTimer(OP_TIMER_PREFIX + c.id);
    if (c.kind === "read" && config.readRepair) readRepair(ctx, s, c);
  }

  /** Sends the merged result to every replica that answered with something else. */
  function readRepair(ctx: Ctx, s: State, c: Coordination): void {
    const result = merged(c);
    const want = canonicalJson(result as never);
    const owners = replicas(ctx, c.key);
    const stale = sorted(Object.keys(c.answers)).filter(
      (n) => owners.includes(n) && canonicalJson(c.answers[n] as never) !== want,
    );
    if (stale.length === 0) return;
    ctx.annotate("readRepair", { key: c.key, nodes: stale });
    for (const n of stale) {
      if (n === ctx.nodeId) repairLocal(s, c.key, result);
      else ctx.send(n, { type: "Repair", key: c.key, value: result });
    }
  }

  function repairLocal(s: State, key: string, value: Slot): void {
    if (bugs.repairOverwrites === true) s.persistent.data[key] = value;
    else storeData(s, key, value);
  }

  /**
   * No quorum yet. The first time, ask again: sloppy quorums ask the next fallback on the
   * ring for each silent server (with a hint for the replica it stands in for), strict ones
   * repeat the request to the silent replicas. The second time, give up.
   */
  function onRequestTimeout(ctx: Ctx, s: State, id: string): void {
    const c = s.volatile.pending[id];
    if (c === undefined) return;
    if (c.replied) {
      finish(ctx, s, c);
      return;
    }
    if (c.round === 0) {
      c.round = 1;
      const silent = Object.keys(c.standsFor).filter((n) => !Object.hasOwn(c.answers, n));
      const unused = config.sloppy
        ? prefs(ctx, c.key).filter((n) => !Object.hasOwn(c.standsFor, n))
        : [];
      for (const n of silent) {
        const owner = c.standsFor[n]!;
        const fallback = unused.shift();
        if (fallback === undefined) {
          ask(ctx, s, c, n, owner);
        } else {
          ctx.annotate("fallback", { key: c.key, to: fallback, for: owner });
          ask(ctx, s, c, fallback, owner);
        }
      }
      ctx.setTimer(OP_TIMER_PREFIX + id, config.requestTimeoutMs);
      progress(ctx, s, c);
      return;
    }
    s.volatile.pending = without(s.volatile.pending, id);
    ctx.annotate("unavailable", { key: c.key, answered: Object.keys(c.answers).length });
    const reply: ClientReply<DynamoResult> = {
      type: "ClientReply",
      seq: c.seq,
      status: "unavailable",
    };
    ctx.send(c.clientId, reply);
  }

  // ---------------------------------------------------------------------------------------
  // Hinted handoff

  function armHandoff(ctx: Ctx, s: State): void {
    if (s.volatile.handoffArmed || Object.keys(s.persistent.hints).length === 0) return;
    s.volatile.handoffArmed = true;
    ctx.setTimer(HANDOFF_TIMER, config.handoffIntervalMs);
  }

  function sendHints(ctx: Ctx, s: State): void {
    s.volatile.handoffArmed = false;
    const hints = s.persistent.hints;
    for (const owner of sorted(Object.keys(hints))) {
      for (const key of sorted(Object.keys(hints[owner]!))) {
        ctx.send(owner, { type: "Handoff", key, value: hints[owner]![key]! });
      }
    }
    armHandoff(ctx, s);
  }

  /**
   * The owner stored this value: drop the hint, unless it has grown since it was sent (the
   * rest goes with the next attempt).
   */
  function onHandoffAck(ctx: Ctx, s: State, from: NodeId, key: string, acked: Slot) {
    const store = s.persistent.hints[from];
    const held = store?.[key];
    if (store === undefined || held === undefined || digest(held) !== digest(acked)) return;
    if (Object.keys(store).length > 1) s.persistent.hints[from] = without(store, key);
    else s.persistent.hints = without(s.persistent.hints, from);
    ctx.annotate("handedOff", { key, to: from });
  }

  // ---------------------------------------------------------------------------------------
  // Anti-entropy

  function armSync(ctx: Ctx): void {
    const mean = config.antiEntropyIntervalMs;
    if (mean <= 0 || ctx.peers.length === 0) return;
    ctx.setTimer(SYNC_TIMER, ctx.rng.int(Math.ceil(mean / 2), Math.ceil((mean * 3) / 2)));
  }

  function startSync(ctx: Ctx, s: State): void {
    // Taking peers in turn bounds how long any pair goes without comparing notes.
    const peer = ctx.peers[s.volatile.syncNext % ctx.peers.length]!;
    s.volatile.syncNext = (s.volatile.syncNext + 1) % ctx.peers.length;
    const digests: Record<string, number> = {};
    for (const key of sorted(Object.keys(s.persistent.data))) {
      if (shared(ctx, key, peer)) digests[key] = digest(s.persistent.data[key]!);
    }
    ctx.send(peer, { type: "SyncDigest", digests });
    armSync(ctx);
  }

  /** Sends what differs from the peer's digest, and asks for its side of those keys. */
  function onSyncDigest(
    ctx: Ctx,
    s: State,
    from: NodeId,
    digests: Readonly<Record<string, number>>,
  ) {
    const data = s.persistent.data;
    const entries: Store = {};
    const want: string[] = [];
    for (const key of sorted(new Set([...Object.keys(digests), ...Object.keys(data)]))) {
      if (!shared(ctx, key, from)) continue;
      const mine = data[key] ?? emptySlot(key);
      const theirs = digests[key];
      if (theirs !== undefined && theirs === digest(mine)) continue;
      if (!isEmptySlot(mine)) entries[key] = mine;
      if (theirs !== undefined) want.push(key);
    }
    if (Object.keys(entries).length > 0 || want.length > 0) {
      ctx.send(from, { type: "SyncData", entries, want });
    }
  }

  function onSyncData(ctx: Ctx, s: State, from: NodeId, m: SyncData): void {
    for (const key of sorted(Object.keys(m.entries))) {
      if (shared(ctx, key, from)) storeData(s, key, m.entries[key]!);
    }
    const entries: Store = {};
    for (const key of m.want) {
      const mine = s.persistent.data[key];
      if (mine !== undefined && !isEmptySlot(mine)) entries[key] = mine;
    }
    if (Object.keys(entries).length > 0) ctx.send(from, { type: "SyncData", entries, want: [] });
  }

  // ---------------------------------------------------------------------------------------

  const freshVolatile = (ctx: Ctx): DynamoVolatile => ({
    pending: {},
    handoffArmed: false,
    syncNext: ctx.peers.length === 0 ? 0 : ctx.rng.int(0, ctx.peers.length - 1),
  });

  function start(ctx: Ctx, s: State): State {
    if (config.n > servers(ctx).length) {
      throw new RangeError(`Dynamo n=${config.n} exceeds the ${servers(ctx).length} servers`);
    }
    armSync(ctx);
    armHandoff(ctx, s);
    return s;
  }

  return {
    name: "dynamo",

    init(ctx) {
      return start(ctx, {
        persistent: { counters: {}, requests: 0, data: {}, hints: {} },
        volatile: freshVolatile(ctx),
      });
    },

    recover(ctx, persistent) {
      // Requests being coordinated are lost; their clients time out and retry elsewhere.
      return start(ctx, { persistent, volatile: freshVolatile(ctx) });
    },

    onTimer(ctx, s, key) {
      if (key === HANDOFF_TIMER) sendHints(ctx, s);
      else if (key === SYNC_TIMER) startSync(ctx, s);
      else if (key.startsWith(OP_TIMER_PREFIX)) {
        onRequestTimeout(ctx, s, key.slice(OP_TIMER_PREFIX.length));
      }
    },

    onMessage(ctx, s, from, m) {
      switch (m.type) {
        case "ClientRequest":
          coordinate(ctx, s, m as ClientRequest<DynamoOp>);
          return;
        case "ClientReply":
          return;
        case "Replicate":
          if (m.hintFor === null) storeData(s, m.key, m.value);
          else storeHint(ctx, s, m.hintFor, m.key, m.value);
          ctx.send(from, { type: "ReplicateAck", req: m.req });
          return;
        case "ReplicateAck": {
          const c = s.volatile.pending[m.req];
          if (c?.kind === "write") answer(ctx, s, m.req, from, c.update!);
          return;
        }
        case "Read":
          ctx.send(from, { type: "ReadReply", req: m.req, value: localValue(s, m.key) });
          return;
        case "ReadReply":
          if (s.volatile.pending[m.req]?.kind === "read") answer(ctx, s, m.req, from, m.value);
          return;
        case "Repair":
          repairLocal(s, m.key, m.value);
          return;
        case "Handoff":
          storeData(s, m.key, m.value);
          ctx.send(from, { type: "HandoffAck", key: m.key, value: m.value });
          return;
        case "HandoffAck":
          onHandoffAck(ctx, s, from, m.key, m.value);
          return;
        case "SyncDigest":
          onSyncDigest(ctx, s, from, m.digests);
          return;
        case "SyncData":
          onSyncData(ctx, s, from, m);
          return;
      }
    },

    onClientCommand() {
      // Operations come from client processes over the network, not as direct commands.
    },

    view(s): DynamoView {
      return {
        counters: s.persistent.counters,
        data: s.persistent.data,
        hints: s.persistent.hints,
        pending: Object.keys(s.volatile.pending).length,
      };
    },
  };
}

/**
 * The standard client. Per key it remembers what it last read or wrote (a register's
 * context, a set's state) and fills it into its next put or remove of that key, unless the
 * operation names a context or observed tags itself.
 *
 * Its timeout outlasts a coordinator's two rounds: a retry through another coordinator
 * writes the value again under a new dot, which becomes a sibling.
 */
export function dynamoClient(overrides: Partial<RequestClientConfig> = {}) {
  return requestClient<DynamoOp, DynamoResult, DynamoMessage>(
    { requestTimeoutMs: 600, ...overrides },
    {
      prepare(op, memory) {
        const seen = memory[op.key];
        if (seen === undefined) return op;
        if (op.type === "put" && op.context === undefined) {
          return { ...op, context: seen as Context };
        }
        if (op.type === "remove" && op.observed === undefined) {
          return { ...op, observed: (seen as OrSet).entries[op.element] ?? [] };
        }
        return op;
      },
      observe(op, result, memory) {
        const key = op.key;
        switch (result.type) {
          case "get":
            memory[key] = joinContexts([
              (memory[key] ?? EMPTY_CONTEXT) as Context,
              contextOf(result.versions),
            ]);
            return;
          case "put":
            memory[key] = joinContexts(
              [
                (memory[key] ?? EMPTY_CONTEXT) as Context,
                op.type === "put" ? (op.context ?? EMPTY_CONTEXT) : EMPTY_CONTEXT,
              ],
              [result.dot],
            );
            return;
          case "crdt":
            if (result.state.type === "set") {
              memory[key] = joinCrdt((memory[key] ?? emptyCrdt("set")) as OrSet, result.state);
            }
            return;
          case "add":
          case "remove": {
            const tags = result.type === "add" ? [result.tag] : result.observed;
            const delta: OrSet = {
              type: "set",
              entries: result.type === "add" ? { [result.element]: tags } : {},
              context: joinContexts([], tags),
            };
            memory[key] = joinCrdt((memory[key] ?? emptyCrdt("set")) as OrSet, delta);
            return;
          }
          default:
            return;
        }
      },
    },
  );
}
