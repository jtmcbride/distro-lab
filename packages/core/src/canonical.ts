/**
 * Canonical serialization: object keys sorted, no undefined/NaN/Infinity, no Map/Set/class
 * instances. Two values that are structurally equal always serialize to the same string,
 * which is what makes "identical runs produce identical traces" testable.
 */

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${path}`);
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`unserializable ${typeof value} at ${path}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => write(v, `${path}[${i}]`)).join(",")}]`;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`non-plain object at ${path}`);
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    // Optional fields that are absent and fields set to undefined serialize identically.
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${write(v, `${path}.${key}`)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Incremental 64-bit non-cryptographic hash (two cyrb53-style lanes). Used to fingerprint
 * traces cheaply without keeping them in memory.
 */
export class Hasher {
  private h1 = 0xdeadbeef;
  private h2 = 0x41c6ce57;

  update(s: string): this {
    let h1 = this.h1;
    let h2 = this.h2;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    this.h1 = h1;
    this.h2 = h2;
    return this;
  }

  digest(): string {
    let h1 = Math.imul(this.h1 ^ (this.h1 >>> 16), 2246822507);
    h1 ^= Math.imul(this.h2 ^ (this.h2 >>> 13), 3266489909);
    let h2 = Math.imul(this.h2 ^ (this.h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  }
}

export function hashCanonical(value: unknown): string {
  return new Hasher().update(canonicalJson(value)).digest();
}
