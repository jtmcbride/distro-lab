import { canonicalJson } from "../../canonical.ts";
import {
  contextHas,
  EMPTY_CONTEXT,
  joinContexts,
  mergeClocks,
  sameDot,
  type Clock,
  type Context,
  type Dot,
} from "./clock.ts";

/**
 * Grow-only counter: per coordinator, the total of the increments it stamped. Joining takes
 * each entry's maximum, so replaying or reordering updates never double-counts them.
 */
export type Counter = { readonly type: "counter"; readonly counts: Clock };

/**
 * Add-wins observed-remove set (Bieniusa et al., 2012, in its causal-context form). Every add
 * tags its element with a fresh dot; a remove deletes exactly the tags its writer observed.
 * `context` holds every tag ever seen, so a replica can tell "removed" from "not yet arrived".
 * An add concurrent with a remove survives it.
 */
export type OrSet = {
  readonly type: "set";
  readonly entries: Readonly<Record<string, readonly Dot[]>>;
  readonly context: Context;
};

export type Crdt = Counter | OrSet;

export type CrdtKind = Crdt["type"];

/** Keys named `count:…` hold counters and `set:…` hold sets; all others hold registers. */
export function crdtKind(key: string): CrdtKind | null {
  if (key.startsWith("count:")) return "counter";
  if (key.startsWith("set:")) return "set";
  return null;
}

export function emptyCrdt(kind: CrdtKind): Crdt {
  return kind === "counter"
    ? { type: "counter", counts: {} }
    : { type: "set", entries: {}, context: EMPTY_CONTEXT };
}

/** Internal switches for planted bugs. */
export interface CrdtBugs {
  /** Join counters by adding entries instead of taking the maximum. */
  readonly sumCounters?: boolean;
  /** A remove that observed any of an element's tags drops all of them. */
  readonly removeAllTags?: boolean;
}

function joinSets(a: OrSet, b: OrSet, bugs: CrdtBugs): OrSet {
  const entries: Record<string, Dot[]> = {};
  for (const e of [...new Set([...Object.keys(a.entries), ...Object.keys(b.entries)])].sort()) {
    const x = a.entries[e] ?? [];
    const y = b.entries[e] ?? [];
    // Keep a tag both sides have, or one side has and the other has not seen (so not removed).
    const kept = [
      ...x.filter((d) => y.some((o) => sameDot(o, d)) || !contextHas(b.context, d)),
      ...y.filter((d) => !x.some((o) => sameDot(o, d)) && !contextHas(a.context, d)),
    ];
    const removed = (tags: readonly Dot[], other: Context, otherTags: readonly Dot[]) =>
      tags.some((d) => contextHas(other, d) && !otherTags.some((o) => sameDot(o, d)));
    if (bugs.removeAllTags === true && (removed(x, b.context, y) || removed(y, a.context, x))) {
      continue;
    }
    if (kept.length > 0) {
      entries[e] = kept.sort((p, q) =>
        p.node < q.node ? -1 : p.node > q.node ? 1 : p.counter - q.counter,
      );
    }
  }
  return { type: "set", entries, context: joinContexts([a.context, b.context]) };
}

/** Joins two states of the same kind. Returns `a` itself when `b` adds nothing. */
export function joinCrdt(a: Crdt, b: Crdt, bugs: CrdtBugs = {}): Crdt {
  let joined: Crdt;
  if (a.type === "counter" && b.type === "counter") {
    if (bugs.sumCounters === true) {
      const counts: Record<string, number> = { ...a.counts };
      for (const [n, v] of Object.entries(b.counts)) counts[n] = (counts[n] ?? 0) + v;
      joined = { type: "counter", counts };
    } else {
      joined = { type: "counter", counts: mergeClocks([a.counts, b.counts]) };
    }
  } else if (a.type === "set" && b.type === "set") {
    joined = joinSets(a, b, bugs);
  } else {
    throw new TypeError(`cannot join a ${a.type} with a ${b.type}`);
  }
  return canonicalJson(joined) === canonicalJson(a) ? a : joined;
}

export const counterValue = (c: Counter) => Object.values(c.counts).reduce((x, y) => x + y, 0);

export const setElements = (s: OrSet) => Object.keys(s.entries).sort();

/** e.g. `7 (A3 B4)` or `{apple, pear}`. */
export function formatCrdt(c: Crdt): string {
  if (c.type === "counter") {
    const parts = Object.keys(c.counts)
      .sort()
      .map((n) => `${n}${c.counts[n]}`);
    return `${counterValue(c)}${parts.length > 0 ? ` (${parts.join(" ")})` : ""}`;
  }
  return `{${setElements(c).join(", ")}}`;
}
