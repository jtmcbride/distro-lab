import { canonicalJson } from "../../canonical.ts";
import type { NodeId } from "../../protocol.ts";

/** Vector clock: per coordinator, the counter of the latest write it stamped. Absent = 0. */
export type Clock = Readonly<Record<NodeId, number>>;

export type ClockOrder = "before" | "after" | "equal" | "concurrent";

/** How `a` relates to `b`: "before" means b descends from a. */
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

/** Entry-wise maximum. */
export function mergeClocks(clocks: readonly Clock[]): Clock {
  const out: Record<NodeId, number> = {};
  for (const c of clocks) {
    for (const [n, v] of Object.entries(c)) if (v > (out[n] ?? 0)) out[n] = v;
  }
  return out;
}

/**
 * A stored value. `write` names the client request that produced it (`client#seq`), so a
 * clock shared by two different writes can be detected.
 */
export interface Version {
  readonly value: string;
  readonly clock: Clock;
  readonly write: string;
}

const clockKey = (v: Version) => canonicalJson(v.clock);

/**
 * Joins two sibling sets: keeps every version that no other version strictly dominates, and
 * one copy of each clock (the first seen, preferring `a`). The result is sorted by clock, so
 * replicas holding the same versions hold identical arrays. Returns `a` itself when `b` adds
 * nothing, so callers can detect change by identity.
 *
 * `dominated(x, y)` decides whether y makes x obsolete; it exists for a planted bug.
 */
export function mergeVersions(
  a: readonly Version[],
  b: readonly Version[],
  dominated: (x: Clock, y: Clock) => boolean = (x, y) => compareClocks(x, y) === "before",
): readonly Version[] {
  if (b.length === 0) return a;
  const byClock = new Map<string, Version>();
  for (const v of [...a, ...b]) {
    const k = clockKey(v);
    if (!byClock.has(k)) byClock.set(k, v);
  }
  const all = [...byClock.entries()];
  const kept = all.filter(([, v]) => !all.some(([, w]) => w !== v && dominated(v.clock, w.clock)));
  kept.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  const result = kept.map(([, v]) => v);
  if (result.length === a.length && result.every((v, i) => v === a[i])) return a;
  return result;
}

/**
 * True if `versions` still accounts for the write `(clock, write)`: some version descends
 * from it, or it is there itself. An equal clock on a different write does not count.
 */
export function coversWrite(versions: readonly Version[], clock: Clock, write: string): boolean {
  return versions.some((v) => {
    const order = compareClocks(clock, v.clock);
    return order === "before" || (order === "equal" && v.write === write);
  });
}

/** The context a reader passes back with its next write: the merge of every sibling's clock. */
export function contextOf(versions: readonly Version[]): Clock {
  return mergeClocks(versions.map((v) => v.clock));
}

/** e.g. `A2.C1` (entries sorted by node). */
export function formatClock(clock: Clock): string {
  const parts = Object.keys(clock)
    .sort()
    .filter((n) => clock[n]! > 0)
    .map((n) => `${n}${clock[n]}`);
  return parts.length === 0 ? "∅" : parts.join(".");
}
