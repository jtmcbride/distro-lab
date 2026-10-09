/**
 * Min-heap of scheduled items ordered by (timeMs, seq). `seq` is assigned on push, so
 * items at the same virtual time pop in insertion order, which keeps runs deterministic.
 */

export interface Queued<T> {
  readonly timeMs: number;
  readonly seq: number;
  readonly item: T;
}

function before(x: Queued<unknown>, y: Queued<unknown>): boolean {
  return x.timeMs < y.timeMs || (x.timeMs === y.timeMs && x.seq < y.seq);
}

export class EventQueue<T> {
  private heap: Queued<T>[] = [];
  private nextSeq: number;

  constructor(nextSeq = 0) {
    this.nextSeq = nextSeq;
  }

  get size(): number {
    return this.heap.length;
  }

  /** Sequence number the next push will receive (part of a snapshot). */
  get seqCounter(): number {
    return this.nextSeq;
  }

  push(timeMs: number, item: T): Queued<T> {
    if (!Number.isFinite(timeMs)) throw new RangeError(`invalid time: ${timeMs}`);
    const entry: Queued<T> = { timeMs, seq: this.nextSeq++, item };
    const h = this.heap;
    h.push(entry);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(h[i]!, h[parent]!)) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
    return entry;
  }

  peek(): Queued<T> | undefined {
    return this.heap[0];
  }

  pop(): Queued<T> | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (top === undefined || last === undefined || h.length === 0) return top;
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && before(h[l]!, h[m]!)) m = l;
      if (r < h.length && before(h[r]!, h[m]!)) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
    return top;
  }

  /** All entries in pop order, without mutating the queue. */
  toSortedArray(): Queued<T>[] {
    return [...this.heap].sort((x, y) => (before(x, y) ? -1 : before(y, x) ? 1 : 0));
  }

  /** Rebuild from a snapshot; entries keep their original seq. */
  static fromEntries<T>(entries: readonly Queued<T>[], nextSeq: number): EventQueue<T> {
    const q = new EventQueue<T>(nextSeq);
    q.heap = [...entries].sort((x, y) => (before(x, y) ? -1 : before(y, x) ? 1 : 0));
    return q;
  }
}
