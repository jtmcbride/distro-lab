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

const digest = (versions: readonly Version[]) => hashString32(canonicalJson(versions as never));

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

  // ---------------------------------------------------------------------------------------
  // Local storage

  function storeData(s: State, key: string, versions: readonly Version[]): void {
    const before = s.persistent.data[key] ?? [];
    const after = merge(before, versions);
    if (after !== before) s.persistent.data[key] = after;
  }

  function storeHint(ctx: Ctx, s: State, owner: NodeId, key: string, versions: readonly Version[]) {
    const store = (s.persistent.hints[owner] ??= {});
    const before = store[key] ?? [];
    const after = merge(before, versions);
    if (after !== before) store[key] = after;
    armHandoff(ctx, s);
  }

  /** What this server can say about a key: its replica data plus any hints for it. */
  function localVersions(s: State, key: string): readonly Version[] {
    let versions = s.persistent.data[key] ?? [];
    for (const owner of sorted(Object.keys(s.persistent.hints))) {
      versions = merge(versions, s.persistent.hints[owner]![key] ?? []);
    }
    return versions;
  }

  // ---------------------------------------------------------------------------------------
  // Coordinating client requests

  function coordinate(ctx: Ctx, s: State, m: ClientRequest<DynamoOp>): void {
    const p = s.persistent;
    const id = `${ctx.nodeId}:${++p.requests}`;
    const op = m.op;
    let version: Version | null = null;
    if (op.type === "put") {
      const context = joinContexts([op.context ?? EMPTY_CONTEXT]);
      const last = p.counters[op.key] ?? 0;
      const stamp =
        bugs.reuseCounter === true ? (contextVector(context)[ctx.nodeId] ?? 0) + 1 : last + 1;
      p.counters[op.key] = Math.max(last, stamp);
      version = {
        value: op.value,
        dot: { node: ctx.nodeId, counter: stamp },
        context,
        write: `${m.clientId}#${m.seq}`,
      };
    }
    const c: Coordination = {
      id,
      kind: op.type,
      key: op.key,
      clientId: m.clientId,
      seq: m.seq,
      version,
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
      if (c.kind === "put") {
        if (hintFor === null) storeData(s, c.key, [c.version!]);
        else storeHint(ctx, s, hintFor, c.key, [c.version!]);
        c.answers[node] = [c.version!];
      } else {
        c.answers[node] = localVersions(s, c.key);
      }
      return;
    }
    ctx.send(
      node,
      c.kind === "put"
        ? { type: "Replicate", req: c.id, key: c.key, versions: [c.version!], hintFor }
        : { type: "Read", req: c.id, key: c.key },
    );
  }

  function answer(ctx: Ctx, s: State, req: string, from: NodeId, versions: readonly Version[]) {
    const c = s.volatile.pending[req];
    if (c === undefined || !Object.hasOwn(c.standsFor, from) || Object.hasOwn(c.answers, from)) {
      return; // late, duplicated or from an earlier life
    }
    c.answers[from] = versions;
    progress(ctx, s, c);
  }

  function merged(c: Coordination): readonly Version[] {
    return Object.values(c.answers).reduce<readonly Version[]>((acc, vs) => merge(acc, vs), []);
  }

  /** Replies once enough servers answered; finishes once everyone asked has. */
  function progress(ctx: Ctx, s: State, c: Coordination): void {
    const answered = Object.keys(c.answers).length;
    const needed = c.kind === "put" ? config.w - (bugs.ackEarly === true ? 1 : 0) : config.r;
    if (!c.replied && answered >= needed) {
      c.replied = true;
      const result: DynamoResult =
        c.kind === "put"
          ? { type: "put", dot: c.version!.dot, write: c.version!.write }
          : { type: "get", versions: merged(c) };
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
    if (c.kind === "get" && config.readRepair) readRepair(ctx, s, c);
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
      else ctx.send(n, { type: "Repair", key: c.key, versions: result });
    }
  }

  function repairLocal(s: State, key: string, versions: readonly Version[]): void {
    if (bugs.repairOverwrites === true) s.persistent.data[key] = versions;
    else storeData(s, key, versions);
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
        ctx.send(owner, { type: "Handoff", key, versions: hints[owner]![key]! });
      }
    }
    armHandoff(ctx, s);
  }

  /** The owner stored these versions: drop them from the hints held for it. */
  function onHandoffAck(ctx: Ctx, s: State, from: NodeId, key: string, acked: readonly Version[]) {
    const store = s.persistent.hints[from];
    const held = store?.[key];
    if (store === undefined || held === undefined) return;
    const done = new Set(acked.map((v) => canonicalJson(v as never)));
    const left = held.filter((v) => !done.has(canonicalJson(v as never)));
    if (left.length === held.length) return;
    if (left.length > 0) store[key] = left;
    else if (Object.keys(store).length > 1) s.persistent.hints[from] = without(store, key);
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
      const mine = data[key] ?? [];
      const theirs = digests[key];
      if (theirs !== undefined && theirs === digest(mine)) continue;
      if (mine.length > 0) entries[key] = mine;
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
      if (mine !== undefined && mine.length > 0) entries[key] = mine;
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
          if (m.hintFor === null) storeData(s, m.key, m.versions);
          else storeHint(ctx, s, m.hintFor, m.key, m.versions);
          ctx.send(from, { type: "ReplicateAck", req: m.req });
          return;
        case "ReplicateAck": {
          const c = s.volatile.pending[m.req];
          if (c?.kind === "put") answer(ctx, s, m.req, from, [c.version!]);
          return;
        }
        case "Read":
          ctx.send(from, { type: "ReadReply", req: m.req, versions: localVersions(s, m.key) });
          return;
        case "ReadReply":
          if (s.volatile.pending[m.req]?.kind === "get") answer(ctx, s, m.req, from, m.versions);
          return;
        case "Repair":
          repairLocal(s, m.key, m.versions);
          return;
        case "Handoff":
          storeData(s, m.key, m.versions);
          ctx.send(from, { type: "HandoffAck", key: m.key, versions: m.versions });
          return;
        case "HandoffAck":
          onHandoffAck(ctx, s, from, m.key, m.versions);
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
 * The standard client, remembering per key the context of what it last read or wrote and
 * attaching it to its next put of that key (unless the put names a context itself).
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
        if (op.type !== "put" || op.context !== undefined || seen === undefined) return op;
        return { ...op, context: seen as Context };
      },
      observe(op, result, memory) {
        const seen =
          result.type === "get"
            ? contextOf(result.versions)
            : joinContexts(
                [op.type === "put" ? (op.context ?? EMPTY_CONTEXT) : EMPTY_CONTEXT],
                [result.dot],
              );
        memory[op.key] = joinContexts([(memory[op.key] ?? EMPTY_CONTEXT) as Context, seen]);
      },
    },
  );
}
