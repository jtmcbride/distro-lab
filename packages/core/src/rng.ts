/**
 * Deterministic, seedable PRNG (sfc32) with independent named streams.
 *
 * Streams matter for experiments: if the network and each node draw from their own
 * stream, changing one link's latency does not shift every other node's timeouts.
 */

export interface RngState {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

/** 32-bit FNV-1a over UTF-16 code units. */
export function hashString32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  /** State at construction; stream() derives from this so it is independent of draw count. */
  private readonly origin: RngState;

  private constructor(state: RngState) {
    this.a = state.a;
    this.b = state.b;
    this.c = state.c;
    this.d = state.d;
    this.origin = { ...state };
  }

  /** Root generator for a simulation seed. */
  static fromSeed(seed: number): Rng {
    if (!Number.isSafeInteger(seed)) throw new RangeError(`seed must be a safe integer: ${seed}`);
    const lo = seed >>> 0;
    const hi = Math.floor(seed / 0x1_0000_0000) >>> 0;
    const sm = splitmix32(lo ^ Math.imul(hi, 0x9e3779b1));
    return Rng.warmed({ a: sm(), b: sm(), c: sm(), d: sm() });
  }

  /** Restore a generator mid-sequence (e.g. from a snapshot). */
  static fromState(state: RngState): Rng {
    return new Rng(state);
  }

  private static warmed(state: RngState): Rng {
    const rng = new Rng(state);
    // Discard early output so similar seeds decorrelate.
    for (let i = 0; i < 12; i++) rng.nextUint32();
    return new Rng(rng.getState());
  }

  /**
   * Independent child stream identified by `label`. Depends only on this generator's
   * construction state and the label, never on how many values have been drawn.
   */
  stream(label: string): Rng {
    const o = this.origin;
    const h = hashString32(label);
    const sm = splitmix32(o.a ^ Math.imul(h, 0x9e3779b1));
    const sm2 = splitmix32(o.c ^ h);
    return Rng.warmed({ a: sm() ^ o.b, b: sm() ^ o.d, c: sm2() ^ o.a, d: sm2() ^ o.c });
  }

  getState(): RngState {
    return { a: this.a, b: this.b, c: this.c, d: this.d };
  }

  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new RangeError(`invalid range [${min}, ${max}]`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability p. Never draws when p <= 0 or p >= 1, so disabled faults cost nothing. */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("pick from empty array");
    return items[this.int(0, items.length - 1)] as T;
  }
}
