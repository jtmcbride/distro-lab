import { canonicalJson } from "../../canonical.ts";
import type { ClusterSnapshot, Invariant, Report } from "../../invariants.ts";
import type { NodeId } from "../../protocol.ts";
import type { TraceRecord } from "../../trace.ts";
import { coversWrite, formatDot, includes, type Dot, type Version } from "./clock.ts";
import type { DynamoConfig, DynamoOp, DynamoResult, DynamoView } from "./types.ts";

type Snap = ClusterSnapshot<DynamoView>;
type Slot = readonly Version[];

/** One stored sibling set: a server's replica data for a key, or a hint it holds. */
interface Place {
  readonly node: NodeId;
  /** Owner the hint is held for; null for replica data. */
  readonly hintFor: NodeId | null;
  readonly key: string;
  readonly versions: Slot;
}

function places(s: Snap): Place[] {
  const out: Place[] = [];
  for (const n of s.nodes) {
    for (const [key, versions] of Object.entries(n.view.data)) {
      out.push({ node: n.id, hintFor: null, key, versions });
    }
    for (const [owner, store] of Object.entries(n.view.hints)) {
      for (const [key, versions] of Object.entries(store)) {
        out.push({ node: n.id, hintFor: owner, key, versions });
      }
    }
  }
  return out;
}

const placeId = (p: Place) => `${p.node}|${p.hintFor ?? ""}|${p.key}`;
const where = (p: Place) =>
  p.hintFor === null ? `${p.node}'s ${p.key}` : `${p.node}'s hint for ${p.hintFor} of ${p.key}`;
const describe = (v: Version) => `${JSON.stringify(v.value)}@${formatDot(v.dot)} (${v.write})`;

/**
 * Calls `visit` for every place whose sibling set changed (by identity) since the last call,
 * including places that disappeared (visited with no versions). Sibling sets are replaced,
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
      const current = new Map<string, Place>();
      for (const p of places(s)) {
        const id = placeId(p);
        current.set(id, p);
        const before = last.get(id)?.versions;
        if (before !== p.versions) visit(p, before);
      }
      for (const [id, p] of last) {
        if (!current.has(id)) visit({ ...p, versions: [] }, p.versions);
      }
      last = current;
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
        for (const x of p.versions) {
          for (const y of p.versions) {
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
        for (const v of p.versions) {
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
 * replaced by one that includes it. This holds across crashes, since data is durable.
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
        for (const v of before) {
          if (!coversWrite(p.versions, v.dot, v.write)) {
            report(`${where(p)} lost ${describe(v)} without a version that replaced it`, [p.node]);
          }
        }
      });
    },
  };
}

interface Acked {
  readonly key: string;
  readonly dot: Dot;
  readonly write: string;
  readonly value: string;
}

/**
 * Follows the client-visible history (`invoke` / `complete` annotations): which operation
 * each request was, and which puts were acknowledged, in order.
 */
function clientHistory() {
  let ops = new Map<string, DynamoOp>();
  let acked: Acked[] = [];
  return {
    get acked(): readonly Acked[] {
      return acked;
    },
    op: (write: string) => ops.get(write),
    save: () => ({ ops, acked }),
    load: (state: unknown) => {
      ({ ops, acked } = state as { ops: typeof ops; acked: typeof acked });
    },
    /** Returns the completed operation and its result, if `r` completes one. */
    observe(r: TraceRecord): { write: string; op: DynamoOp; result: DynamoResult } | null {
      if (r.type !== "annotate") return null;
      const data = r.data as { seq?: number; op?: DynamoOp; result?: DynamoResult } | undefined;
      if (data?.seq === undefined) return null;
      const write = `${r.node}#${data.seq}`;
      if (r.label === "invoke" && data.op !== undefined) {
        ops.set(write, data.op);
        return null;
      }
      const op = ops.get(write);
      if (r.label !== "complete" || data.result === undefined || op === undefined) return null;
      if (op.type === "put" && data.result.type === "put") {
        acked.push({ key: op.key, dot: data.result.dot, write, value: op.value });
      }
      return { write, op, result: data.result };
    },
  };
}

/**
 * Every acknowledged put is still accounted for on some server (as replica data or a hint),
 * or replaced by a version that includes it. Checked whenever a key's storage changes.
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
      if (done?.result.type === "put") dirty.add(done.op.key);
    },
    check(s, report) {
      seen.visit(s, (p) => dirty.add(p.key));
      if (dirty.size === 0) return;
      const byKey = new Map<string, Place[]>();
      for (const p of places(s)) {
        if (dirty.has(p.key)) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);
      }
      for (const a of history.acked) {
        if (!dirty.has(a.key)) continue;
        const stored = byKey.get(a.key) ?? [];
        if (!stored.some((p) => coversWrite(p.versions, a.dot, a.write))) {
          report(
            `acknowledged put ${a.key}=${JSON.stringify(a.value)}@${formatDot(a.dot)} (${a.write}) is on no server`,
            [a.dot.node],
          );
        }
      }
      dirty = new Set();
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
 * Strict quorums with R + W > N promise that a get sees every put acknowledged before it
 * started (or a version that replaced it): its R replicas overlap the put's W. Sloppy
 * quorums and smaller quorums do not, so this is checked only where it is promised.
 */
function readsSeeAcknowledgedWrites(): Invariant<DynamoView> {
  const history = clientHistory();
  /** For each get in progress, how many puts had been acknowledged when it started. */
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
      if (done?.result.type !== "get") return;
      const prior = history.acked.slice(0, ackedAtInvoke.get(done.write) ?? 0);
      for (const a of prior) {
        if (a.key !== done.op.key) continue;
        if (!coversWrite(done.result.versions, a.dot, a.write)) {
          report(
            `${r.node}'s get of ${a.key} missed ${JSON.stringify(a.value)}@${formatDot(a.dot)} (${a.write}), acknowledged before it started`,
            [r.node, a.dot.node],
          );
        }
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
    readsReturnWrittenValues(),
    ...(promisesReadYourWrites(config) ? [readsSeeAcknowledgedWrites()] : []),
  ];
}
