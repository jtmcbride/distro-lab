import type { NodeId } from "../../protocol.ts";

/** Vector clock: per node, a counter. Absent = 0. */
export type Clock = Readonly<Record<NodeId, number>>;

export type ClockOrder = "before" | "after" | "equal" | "concurrent";

/** How `a` relates to `b`: "before" means b includes everything a does, and more. */
export function compareClocks(a: Clock, b: Clock): ClockOrder {
  let less = false;
  let greater = false;
  for (const n of Object.keys(a)) {
    const x = a[n]!;
    const y = b[n] ?? 0;
    if (x < y) less = true;
    else if (x > y) greater = true;
  }
  for (const n of Object.keys(b)) {
    if (Object.hasOwn(a, n)) continue;
    if (b[n]! > 0) less = true;
  }
  if (less && greater) return "concurrent";
  if (less) return "before";
  if (greater) return "after";
  return "equal";
}

/** Entry-wise maximum (zero entries are left out). */
export function mergeClocks(clocks: readonly Clock[]): Clock {
  const out: Record<NodeId, number> = {};
  for (const c of clocks) {
    for (const [n, v] of Object.entries(c)) if (v > (out[n] ?? 0)) out[n] = v;
  }
  return out;
}

/**
 * Identity of one write to a key: the coordinator that stamped it and that coordinator's
 * counter for the key.
 */
export type Dot = { readonly node: NodeId; readonly counter: number };

export const sameDot = (a: Dot, b: Dot) => a.node === b.node && a.counter === b.counter;

const dotOrder = (a: Dot, b: Dot) =>
  a.node < b.node ? -1 : a.node > b.node ? 1 : a.counter - b.counter;

/**
 * An exact set of writes (dots): per coordinator, every counter up to `vv[node]`, plus the
 * individual `dots` beyond it. Kept compact: a dot right after the prefix joins the prefix.
 *
 * A plain version vector would not do. A coordinator's writes to a key can be concurrent
 * (two clients, same coordinator), so having seen its write 12 does not mean having seen its
 * write 11; `{E:12}` would claim both.
 */
export type Context = { readonly vv: Clock; readonly dots: readonly Dot[] };

export const EMPTY_CONTEXT: Context = { vv: {}, dots: [] };

export const contextHas = (c: Context, d: Dot) =>
  (c.vv[d.node] ?? 0) >= d.counter || c.dots.some((x) => sameDot(x, d));

/** Union of contexts (and extra dots), compacted. */
export function joinContexts(contexts: readonly Context[], extra: readonly Dot[] = []): Context {
  const vv: Record<NodeId, number> = { ...mergeClocks(contexts.map((c) => c.vv)) };
  let dots: Dot[] = [];
  for (const d of [...contexts.flatMap((c) => c.dots), ...extra]) {
    if ((vv[d.node] ?? 0) < d.counter && !dots.some((x) => sameDot(x, d))) dots.push(d);
  }
  dots.sort(dotOrder);
  for (let changed = true; changed;) {
    changed = false;
    dots = dots.filter((d) => {
      if (d.counter !== (vv[d.node] ?? 0) + 1) return (vv[d.node] ?? 0) < d.counter;
      vv[d.node] = d.counter;
      changed = true;
      return false;
    });
  }
  return { vv, dots };
}

/** Highest counter per node: what a plain version vector would claim. */
export function contextVector(c: Context): Clock {
  return mergeClocks([c.vv, ...c.dots.map((d) => ({ [d.node]: d.counter }))]);
}

/**
 * A stored value, as a dotted version (Preguiça et al., 2010): its own `dot` plus the
 * `context` it was written from (everything its writer had read). A version replaces
 * exactly the versions whose dots its context contains. `write` names the client request
 * that produced it (`client#seq`), so a dot reused by another write can be detected.
 */
export type Version = {
  readonly value: string;
  readonly dot: Dot;
  readonly context: Context;
  readonly write: string;
};

/** True if `y`'s context includes `x`'s write, so `y` makes `x` obsolete. */
export const includes = (y: Version, x: Version) => contextHas(y.context, x.dot);

/** Everything a version's writer had seen, plus the version itself. */
export const historyOf = (v: Version): Context => joinContexts([v.context], [v.dot]);

/**
 * Joins two sibling sets: keeps every version no other version includes, and one copy of
 * each dot (the first seen, preferring `a`). The result is sorted by dot, so replicas holding
 * the same versions hold identical arrays. Returns `a` itself when `b` adds nothing, so
 * callers can detect change by identity.
 *
 * `obsolete(x, y)` decides whether y replaces x; it is replaceable for planted bugs.
 */
export function mergeVersions(
  a: readonly Version[],
  b: readonly Version[],
  obsolete: (x: Version, y: Version) => boolean = (x, y) => includes(y, x),
): readonly Version[] {
  if (b.length === 0) return a;
  const unique: Version[] = [];
  for (const v of [...a, ...b]) if (!unique.some((u) => sameDot(u.dot, v.dot))) unique.push(v);
  const result = unique
    .filter((v) => !unique.some((w) => w !== v && obsolete(v, w)))
    .sort((x, y) => dotOrder(x.dot, y.dot));
  if (result.length === a.length && result.every((v, i) => v === a[i])) return a;
  return result;
}

/**
 * True if `versions` still accounts for the write `(dot, write)`: it is there itself, or
 * some version replaced it. The same dot on a different write does not count.
 */
export function coversWrite(versions: readonly Version[], dot: Dot, write: string): boolean {
  return versions.some((v) =>
    sameDot(v.dot, dot) ? v.write === write : contextHas(v.context, dot),
  );
}

/** The context a reader passes back with its next write: the history of every sibling. */
export function contextOf(versions: readonly Version[]): Context {
  return joinContexts(versions.map(historyOf));
}

export const formatDot = (d: Dot) => `${d.node}${d.counter}`;

/** e.g. `A2.C1+E4` (prefix entries, then individual dots), or `∅`. */
export function formatContext(c: Context): string {
  const prefix = Object.keys(c.vv)
    .sort()
    .filter((n) => c.vv[n]! > 0)
    .map((n) => `${n}${c.vv[n]}`)
    .join(".");
  const dots = c.dots.map(formatDot).join(",");
  if (prefix === "" && dots === "") return "∅";
  return dots === "" ? prefix : `${prefix}+${dots}`;
}
