import type { NodeId } from "../../protocol.ts";

/** Vector clock: per coordinator, the highest counter of its writes included. Absent = 0. */
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

/** Identity of one write: the coordinator that stamped it and that coordinator's counter. */
export type Dot = { readonly node: NodeId; readonly counter: number };

/**
 * A stored value, as a dotted version vector (Preguiça et al., 2010): its own `dot` plus the
 * `context` it was written from (the merged history of what the writer had read). A version
 * replaces exactly the versions its context includes. `write` names the client request that
 * produced it (`client#seq`), so a dot reused by another write can be detected.
 *
 * Plain vector clocks are not enough when any server coordinates: two writes through one
 * coordinator get counters 1 and 2, and `{A:2}` would claim to include `{A:1}` even if its
 * writer never saw that write.
 */
export type Version = {
  readonly value: string;
  readonly dot: Dot;
  readonly context: Clock;
  readonly write: string;
};

export const sameDot = (a: Dot, b: Dot) => a.node === b.node && a.counter === b.counter;

/** True if `y`'s context includes `x`'s write, so `y` makes `x` obsolete. */
export const includes = (y: Version, x: Version) => (y.context[x.dot.node] ?? 0) >= x.dot.counter;

/** Everything a version's writer had seen, plus the version itself. */
export const historyOf = (v: Version): Clock =>
  mergeClocks([v.context, { [v.dot.node]: v.dot.counter }]);

const dotOrder = (a: Dot, b: Dot) =>
  a.node < b.node ? -1 : a.node > b.node ? 1 : a.counter - b.counter;

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
    sameDot(v.dot, dot) ? v.write === write : (v.context[dot.node] ?? 0) >= dot.counter,
  );
}

/** The context a reader passes back with its next write: the merged history of every sibling. */
export function contextOf(versions: readonly Version[]): Clock {
  return mergeClocks(versions.map(historyOf));
}

/** e.g. `A2.C1` (entries sorted by node). */
export function formatClock(clock: Clock): string {
  const parts = Object.keys(clock)
    .sort()
    .filter((n) => clock[n]! > 0)
    .map((n) => `${n}${clock[n]}`);
  return parts.length === 0 ? "∅" : parts.join(".");
}

export const formatDot = (d: Dot) => `${d.node}${d.counter}`;
