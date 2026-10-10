import { canonicalJson } from "../../canonical.ts";
import type { ClusterSnapshot, Invariant, Report } from "../../invariants.ts";
import type { NodeId } from "../../protocol.ts";
import type { TraceRecord } from "../../trace.ts";
import {
  contextHas,
  coversWrite,
  formatDot,
  includes,
  sameDot,
  type Dot,
  type Version,
} from "./clock.ts";
import { joinCrdt, type Crdt } from "./crdt.ts";
import type { DynamoConfig, DynamoOp, DynamoResult, DynamoView, Slot } from "./types.ts";

type Snap = ClusterSnapshot<DynamoView>;

/** One stored slot: a server's replica data for a key, or a hint it holds. */
interface Place {
  /** `node|hintFor|key` */
  readonly id: string;
  readonly node: NodeId;
  /** Owner the hint is held for; null for replica data. */
  readonly hintFor: NodeId | null;
  readonly key: string;
  readonly slot: Slot;
}

// Every invariant looks at the same snapshot after a step; list its places once.
const placesOf = new WeakMap<Snap, readonly Place[]>();

function places(s: Snap): readonly Place[] {
  let cached = placesOf.get(s);
  if (cached === undefined) {
    cached = listPlaces(s);
    placesOf.set(s, cached);
  }
  return cached;
}

function listPlaces(s: Snap): Place[] {
  const out: Place[] = [];
  for (const n of s.nodes) {
    for (const [key, slot] of Object.entries(n.view.data)) {
      out.push({ id: `${n.id}||${key}`, node: n.id, hintFor: null, key, slot });
    }
    for (const [owner, store] of Object.entries(n.view.hints)) {
      for (const [key, slot] of Object.entries(store)) {
        out.push({ id: `${n.id}|${owner}|${key}`, node: n.id, hintFor: owner, key, slot });
      }
    }
  }
  return out;
}

const register = (slot: Slot): readonly Version[] => (Array.isArray(slot) ? slot : []);
const crdt = (slot: Slot): Crdt | null => (Array.isArray(slot) ? null : (slot as Crdt));

const where = (p: Place) =>
  p.hintFor === null ? `${p.node}'s ${p.key}` : `${p.node}'s hint for ${p.hintFor} of ${p.key}`;
const describe = (v: Version) => `${JSON.stringify(v.value)}@${formatDot(v.dot)} (${v.write})`;

/**
 * Calls `visit` for every place whose slot changed (by identity) since the last call,
 * including places that disappeared (visited with an empty register). Slots are replaced,
 * never mutated, so identity tracks change.
 */
function changes() {
  let last = new Map<string, Place>();
  return {
    save: () => last,
    load: (state: unknown) => {
      last = state as typeof last;
    },
    visit(s: Snap, visit: (p: Place, before: Slot | undefined) => void) {
      const now = places(s);
      let known = 0;
      for (const p of now) {
        const before = last.get(p.id);
        if (before !== undefined) known++;
        if (before?.slot === p.slot) continue;
        last.set(p.id, p);
        visit(p, before?.slot);
      }
      // Places only disappear when hints are handed off; find them only then.
      if (known === last.size - (now.length - known)) return;
      const ids = new Set(now.map((p) => p.id));
      for (const [id, p] of [...last]) {
        if (ids.has(id)) continue;
        last.delete(id);
        visit({ ...p, slot: [] }, p.slot);
      }
    },
  };
}

/** No stored version includes another stored with it: siblings are concurrent. */
function siblingsConcurrent(): Invariant<DynamoView> {
  const seen = changes();
  return {
    name: "siblings-concurrent",
    save: seen.save,
    load: seen.load,
    check(s, report) {
      seen.visit(s, (p) => {
        const versions = register(p.slot);
        for (const x of versions) {
          for (const y of versions) {
            if (x !== y && includes(y, x)) {
              report(`${where(p)} keeps ${describe(x)}, which ${describe(y)} replaced`, [p.node]);
            }
          }
        }
      });
    },
  };
}

/** A dot names one write to its key, everywhere and forever. */
function uniqueDots(): Invariant<DynamoView> {
  const seen = changes();
  let writes = new Map<string, Version>();
  return {
    name: "unique-dots",
    save: () => ({ places: seen.save(), writes }),
    load: (state) => {
      const st = state as { places: unknown; writes: typeof writes };
      seen.load(st.places);
      writes = st.writes;
    },
    check(s, report) {
      seen.visit(s, (p) => {
        for (const v of register(p.slot)) {
          const dot = `${p.key}@${formatDot(v.dot)}`;
          const known = writes.get(dot);
          if (known === undefined) writes.set(dot, v);
          else if (known !== v && canonicalJson(known) !== canonicalJson(v)) {
            report(
              `dot ${dot} names two writes: ${describe(known)} and ${describe(v)} (in ${where(p)})`,
              [p.node, v.dot.node],
            );
          }
        }
      });
    },
  };
}

/**
 * A replica's data for a key only moves forward: every version it held is still there or
 * replaced by one that includes it, and a counter's or set's state only grows (joining the
 * old state into the new one changes nothing). This holds across crashes: data is durable.
 */
function replicasMonotonic(): Invariant<DynamoView> {
  const seen = changes();
  return {
    name: "replicas-monotonic",
    save: seen.save,
    load: seen.load,
    check(s, report) {
      seen.visit(s, (p, before) => {
        if (p.hintFor !== null || before === undefined) return;
        const was = crdt(before);
        if (was !== null) {
          const now = crdt(p.slot);
          if (now === null || joinCrdt(now, was) !== now) {
            report(`${where(p)} lost part of its ${was.type} state`, [p.node]);
          }
          return;
        }
        for (const v of register(before)) {
          if (!coversWrite(register(p.slot), v.dot, v.write)) {
            report(`${where(p)} lost ${describe(v)} without a version that replaced it`, [p.node]);
          }
        }
      });
    },
  };
}

/** An acknowledged write, in terms that can be checked against any stored slot. */
type Acked =
  | {
      readonly type: "put";
      readonly key: string;
      readonly dot: Dot;
      readonly write: string;
      readonly value: string;
    }
  | { readonly type: "incr"; readonly key: string; readonly node: NodeId; readonly total: number }
  | { readonly type: "add"; readonly key: string; readonly element: string; readonly tag: Dot };

const describeAcked = (a: Acked) =>
  a.type === "put"
    ? `put ${a.key}=${JSON.stringify(a.value)}@${formatDot(a.dot)} (${a.write})`
    : a.type === "incr"
      ? `increments of ${a.key} through ${a.node} (total ${a.total})`
      : `add of ${JSON.stringify(a.element)} to ${a.key} (tag ${formatDot(a.tag)})`;

/**
 * Follows the client-visible history (`invoke` / `complete` annotations): which operation
 * each request was, which writes were acknowledged, in order, and which set tags any remove
 * was sent to delete.
 */
function clientHistory() {
  let ops = new Map<string, DynamoOp>();
  let acked: Acked[] = [];
  /** Per `key|element`, the tags some invoked remove observed. */
  let removed = new Map<string, Dot[]>();
  return {
    get acked(): readonly Acked[] {
      return acked;
    },
    op: (write: string) => ops.get(write),
    /** True if some remove (acknowledged or not) asked to delete this tag. */
    removedTag: (key: string, element: string, tag: Dot) =>
      (removed.get(`${key}|${element}`) ?? []).some((d) => sameDot(d, tag)),
    save: () => ({ ops, acked, removed }),
    load: (state: unknown) => {
      ({ ops, acked, removed } = state as {
        ops: typeof ops;
        acked: typeof acked;
        removed: typeof removed;
      });
    },
    /** Returns the completed operation and its result, if `r` completes one. */
    observe(r: TraceRecord): { write: string; op: DynamoOp; result: DynamoResult } | null {
      if (r.type !== "annotate") return null;
      const data = r.data as { seq?: number; op?: DynamoOp; result?: DynamoResult } | undefined;
      if (data?.seq === undefined) return null;
      const write = `${r.node}#${data.seq}`;
      if (r.label === "invoke" && data.op !== undefined) {
        const op = data.op;
        ops.set(write, op);
        if (op.type === "remove") {
          const id = `${op.key}|${op.element}`;
          removed.set(id, [...(removed.get(id) ?? []), ...(op.observed ?? [])]);
        }
        return null;
      }
      const op = ops.get(write);
      const result = data.result;
      if (r.label !== "complete" || result === undefined || op === undefined) return null;
      if (op.type === "put" && result.type === "put") {
        acked.push({ type: "put", key: op.key, dot: result.dot, write, value: op.value });
      } else if (result.type === "incr") {
        acked.push({ type: "incr", key: op.key, node: result.node, total: result.total });
      } else if (result.type === "add") {
        acked.push({ type: "add", key: op.key, element: result.element, tag: result.tag });
      }
      return { write, op, result };
    },
  };
}

/**
 * True if `slot` accounts for the acknowledged write: the put's version or one that replaced
 * it, the coordinator's counter entry at or above its total, or the added tag (or, for a
 * tag some remove was sent to delete, at least knowledge of it).
 */
function accountsFor(slot: Slot, a: Acked, removedTag: (a: Acked & { type: "add" }) => boolean) {
  if (a.type === "put") return coversWrite(register(slot), a.dot, a.write);
  const state = crdt(slot);
  if (state === null) return false;
  if (a.type === "incr") return state.type === "counter" && (state.counts[a.node] ?? 0) >= a.total;
  if (state.type !== "set") return false;
  if ((state.entries[a.element] ?? []).some((d) => sameDot(d, a.tag))) return true;
  return removedTag(a) && contextHas(state.context, a.tag);
}

/**
 * Every acknowledged write is still accounted for on some server (as replica data or a
 * hint): a put's version or one that replaced it, a counter's increments, a set's added tag
 * unless a remove deleted it. Checked whenever a key's storage changes.
 */
function acknowledgedWritesDurable(): Invariant<DynamoView> {
  const history = clientHistory();
  const seen = changes();
  let dirty = new Set<string>();
  return {
    name: "acknowledged-writes-durable",
    save: () => ({ history: history.save(), places: seen.save(), dirty }),
    load: (state) => {
      const st = state as { history: unknown; places: unknown; dirty: typeof dirty };
      history.load(st.history);
      seen.load(st.places);
      dirty = st.dirty;
    },
    onRecord(r) {
      const done = history.observe(r);
      if (done !== null && done.result.type !== "get" && done.result.type !== "crdt") {
        dirty.add(done.op.key);
      }
    },
    check(s, report) {
      seen.visit(s, (p) => dirty.add(p.key));
      if (dirty.size === 0) return;
      const byKey = new Map<string, Place[]>();
      for (const p of places(s)) {
        if (dirty.has(p.key)) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
      }
      const removed = (a: Acked & { type: "add" }) => history.removedTag(a.key, a.element, a.tag);
      for (const a of history.acked) {
        if (!dirty.has(a.key)) continue;
        const stored = byKey.get(a.key) ?? [];
        if (!stored.some((p) => accountsFor(p.slot, a, removed))) {
          report(`acknowledged ${describeAcked(a)} is on no server`, [
            a.type === "put" ? a.dot.node : a.type === "incr" ? a.node : a.tag.node,
          ]);
        }
      }
      dirty = new Set();
    },
  };
}

/**
 * No server's counter credits a coordinator with more than that coordinator counted itself:
 * entries are only ever copied, never added up.
 */
function countersBounded(): Invariant<DynamoView> {
  const seen = changes();
  return {
    name: "counters-bounded",
    save: seen.save,
    load: seen.load,
    check(s, report) {
      const own = new Map(s.nodes.map((n) => [n.id, n.view.counters]));
      seen.visit(s, (p) => {
        const state = crdt(p.slot);
        if (state?.type !== "counter") return;
        for (const [node, count] of Object.entries(state.counts)) {
          const total = own.get(node)?.[p.key] ?? 0;
          if (count > total) {
            report(`${where(p)} credits ${node} with ${count}, but ${node} counted only ${total}`, [
              p.node,
              node,
            ]);
          }
        }
      });
    },
  };
}

/** Gets return only values some client asked to put, under that put's own request id. */
function readsReturnWrittenValues(): Invariant<DynamoView> {
  const history = clientHistory();
  return {
    name: "reads-return-written-values",
    save: history.save,
    load: history.load,
    check() {},
    onRecord(r, _now, report: Report) {
      const done = history.observe(r);
      if (done?.result.type !== "get" || r.type !== "annotate") return;
      for (const v of done.result.versions) {
        const put = history.op(v.write);
        if (put?.type !== "put" || put.key !== done.op.key || put.value !== v.value) {
          report(
            `${r.node} read ${done.op.key}=${JSON.stringify(v.value)} from ${v.write}, which never wrote it`,
            [r.node, v.dot.node],
          );
        }
      }
    },
  };
}

/**
 * Strict quorums with R + W > N promise that a get sees every write acknowledged before it
 * started (or one that replaced it): its R replicas overlap the write's W. Sloppy quorums
 * and smaller quorums do not, so this is checked only where it is promised.
 */
function readsSeeAcknowledgedWrites(): Invariant<DynamoView> {
  const history = clientHistory();
  /** For each get in progress, how many writes had been acknowledged when it started. */
  let ackedAtInvoke = new Map<string, number>();
  return {
    name: "reads-see-acknowledged-writes",
    save: () => ({ history: history.save(), ackedAtInvoke }),
    load: (state) => {
      const st = state as { history: unknown; ackedAtInvoke: typeof ackedAtInvoke };
      history.load(st.history);
      ackedAtInvoke = st.ackedAtInvoke;
    },
    check() {},
    onRecord(r, _now, report) {
      const before = history.acked.length;
      const done = history.observe(r);
      if (r.type !== "annotate") return;
      const data = r.data as { seq?: number } | undefined;
      if (r.label === "invoke" && data?.seq !== undefined) {
        ackedAtInvoke.set(`${r.node}#${data.seq}`, before);
      }
      if (done === null || (done.result.type !== "get" && done.result.type !== "crdt")) return;
      const slot: Slot = done.result.type === "get" ? done.result.versions : done.result.state;
      // A read must at least know of an added tag (it may have been removed since).
      const known = () => true;
      for (const a of history.acked.slice(0, ackedAtInvoke.get(done.write) ?? 0)) {
        if (a.key !== done.op.key || accountsFor(slot, a, known)) continue;
        report(
          `${r.node}'s get of ${a.key} missed the ${describeAcked(a)}, acknowledged before it started`,
          [r.node],
        );
      }
    },
  };
}

/** Whether the configuration promises that reads see acknowledged writes. */
export const promisesReadYourWrites = (c: DynamoConfig) => !c.sloppy && c.r + c.w > c.n;

export function dynamoInvariants(config: DynamoConfig): Invariant<DynamoView>[] {
  return [
    siblingsConcurrent(),
    uniqueDots(),
    replicasMonotonic(),
    acknowledgedWritesDurable(),
    countersBounded(),
    readsReturnWrittenValues(),
    ...(promisesReadYourWrites(config) ? [readsSeeAcknowledgedWrites()] : []),
  ];
}
