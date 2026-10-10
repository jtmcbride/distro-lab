import type { Network, SendOutcome } from "./network.ts";
import type { NodeId } from "./protocol.ts";
import type { Rng } from "./rng.ts";

/** Behavior of one directed link. */
export interface LinkConfig {
  /** Minimum one-way delay. */
  readonly latencyMs: number;
  /** Extra delay drawn uniformly from [0, jitterMs) per copy. */
  readonly jitterMs: number;
  /** Probability a message is lost. */
  readonly loss: number;
  /** Probability a message is delivered twice (each copy gets its own delay). */
  readonly duplicate: number;
  /** A down link drops at send time and drops anything still in flight on delivery. */
  readonly up: boolean;
}

export const DEFAULT_LINK: LinkConfig = {
  latencyMs: 10,
  jitterMs: 5,
  loss: 0,
  duplicate: 0,
  up: true,
};

export type LinkView = {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly latencyMs: number;
  readonly jitterMs: number;
  readonly loss: number;
  readonly duplicate: number;
  readonly up: boolean;
  /** Up and not blocked by a partition or isolation. */
  readonly connected: boolean;
};

export type LinkNetworkView = { readonly links: readonly LinkView[] };

export interface LinkOverride extends Partial<LinkConfig> {
  readonly from: NodeId;
  readonly to: NodeId;
}

export interface LinkNetworkConfig {
  readonly defaults?: Partial<LinkConfig>;
  readonly links?: readonly LinkOverride[];
}

export type NetworkChange =
  /**
   * Splits the cluster: links between different groups are blocked. Nodes not listed in
   * any group form one extra group together. Replaces any earlier partition.
   */
  | { readonly type: "partition"; readonly groups: readonly (readonly NodeId[])[] }
  /** Blocks every link to and from `node`. Adds to the current partition. */
  | { readonly type: "isolate"; readonly node: NodeId }
  /** Removes all partitions and isolations; per-link settings are kept. */
  | { readonly type: "heal" }
  /** Applies the same settings to every link (e.g. a network-wide slowdown). */
  | ({ readonly type: "setAll" } & Partial<LinkConfig>)
  /** Heals and resets every link to its configuration at construction. */
  | { readonly type: "restore" }
  /** Changes one directed link, or both directions if `bidirectional`. */
  | ({
      readonly type: "setLink";
      readonly from: NodeId;
      readonly to: NodeId;
      readonly bidirectional?: boolean;
    } & Partial<LinkConfig>);

const key = (from: NodeId, to: NodeId) => `${from}->${to}`;

function validate(link: LinkConfig, where: string): LinkConfig {
  const nonNeg = (n: number) => Number.isFinite(n) && n >= 0;
  const prob = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
  if (!nonNeg(link.latencyMs) || !nonNeg(link.jitterMs)) {
    throw new RangeError(`${where}: latency and jitter must be finite and >= 0`);
  }
  if (!prob(link.loss) || !prob(link.duplicate)) {
    throw new RangeError(`${where}: loss and duplicate must be probabilities`);
  }
  return link;
}

/**
 * Message-level network with per-link latency, jitter, loss and duplication, plus
 * partitions layered on top. See docs/semantics.md.
 */
export class LinkNetwork implements Network<NetworkChange> {
  private readonly nodes: readonly NodeId[];
  private links = new Map<string, LinkConfig>();
  /** Directed links currently cut by a partition or isolation. */
  private blocked = new Set<string>();
  private initial: ReadonlyMap<string, LinkConfig>;

  constructor(nodes: readonly NodeId[], config: LinkNetworkConfig = {}) {
    this.nodes = [...nodes];
    const defaults = validate({ ...DEFAULT_LINK, ...config.defaults }, "defaults");
    for (const from of nodes) {
      for (const to of nodes) if (from !== to) this.links.set(key(from, to), defaults);
    }
    for (const o of config.links ?? []) this.update(o.from, o.to, o);
    this.initial = new Map(this.links);
  }

  link(from: NodeId, to: NodeId): LinkConfig {
    const l = this.links.get(key(from, to));
    if (l === undefined) throw new Error(`no link ${from}->${to}`);
    return l;
  }

  /** True when a message sent now from `from` would be allowed onto the wire. */
  isConnected(from: NodeId, to: NodeId): boolean {
    return this.link(from, to).up && !this.blocked.has(key(from, to));
  }

  onSend(from: NodeId, to: NodeId, _now: number, rng: Rng): SendOutcome {
    if (!this.isConnected(from, to)) return { dropped: "link-down" };
    const l = this.link(from, to);
    // Draw order is fixed (loss, delay, duplicate, delay) and skipped when a parameter is
    // zero, so enabling a fault on one link never shifts draws for a fault-free run.
    if (rng.chance(l.loss)) return { dropped: "loss" };
    // Rounded to microseconds to keep traces readable.
    const delay = () =>
      l.jitterMs > 0
        ? Math.round((l.latencyMs + rng.next() * l.jitterMs) * 1000) / 1000
        : l.latencyMs;
    const delays = [delay()];
    if (rng.chance(l.duplicate)) delays.push(delay());
    return { delays };
  }

  canDeliver(from: NodeId, to: NodeId): boolean {
    return this.isConnected(from, to);
  }

  /** Every directed link with its settings and whether it currently carries traffic. */
  view(): LinkNetworkView {
    const links: LinkView[] = [];
    for (const [k, l] of this.links) {
      const [from, to] = k.split("->") as [NodeId, NodeId];
      links.push({ from, to, ...l, connected: l.up && !this.blocked.has(k) });
    }
    return { links };
  }

  saveState(): {
    links: Map<string, LinkConfig>;
    blocked: Set<string>;
    initial: ReadonlyMap<string, LinkConfig>;
  } {
    // `initial` is included so a checkpoint from a differently configured network (e.g. a
    // minimized scenario) restores completely.
    return { links: this.links, blocked: this.blocked, initial: this.initial };
  }

  loadState(state: unknown): void {
    const s = state as ReturnType<LinkNetwork["saveState"]>;
    this.links = s.links;
    this.blocked = s.blocked;
    this.initial = s.initial;
  }

  apply(change: NetworkChange): void {
    switch (change.type) {
      case "partition": {
        const groupOf = new Map<NodeId, number>();
        change.groups.forEach((g, i) => {
          for (const n of g) {
            this.assertNode(n);
            if (groupOf.has(n)) throw new Error(`${n} is in more than one partition group`);
            groupOf.set(n, i);
          }
        });
        this.blocked.clear();
        for (const from of this.nodes) {
          for (const to of this.nodes) {
            if (from === to) continue;
            const gf = groupOf.get(from) ?? -1;
            const gt = groupOf.get(to) ?? -1;
            if (gf !== gt) this.blocked.add(key(from, to));
          }
        }
        return;
      }
      case "isolate":
        this.assertNode(change.node);
        for (const other of this.nodes) {
          if (other === change.node) continue;
          this.blocked.add(key(change.node, other));
          this.blocked.add(key(other, change.node));
        }
        return;
      case "heal":
        this.blocked.clear();
        return;
      case "restore":
        this.blocked.clear();
        for (const [k, v] of this.initial) this.links.set(k, v);
        return;
      case "setAll": {
        const { type: _t, ...settings } = change;
        for (const k of this.links.keys()) {
          const [from, to] = k.split("->") as [NodeId, NodeId];
          this.update(from, to, settings);
        }
        return;
      }
      case "setLink": {
        const { type: _t, from, to, bidirectional, ...settings } = change;
        this.update(from, to, settings);
        if (bidirectional === true) this.update(to, from, settings);
        return;
      }
    }
  }

  private update(from: NodeId, to: NodeId, settings: Partial<LinkConfig>): void {
    const current = this.link(from, to);
    const next: LinkConfig = {
      latencyMs: settings.latencyMs ?? current.latencyMs,
      jitterMs: settings.jitterMs ?? current.jitterMs,
      loss: settings.loss ?? current.loss,
      duplicate: settings.duplicate ?? current.duplicate,
      up: settings.up ?? current.up,
    };
    this.links.set(key(from, to), validate(next, `link ${from}->${to}`));
  }

  private assertNode(node: NodeId): void {
    if (!this.nodes.includes(node)) throw new Error(`unknown node ${node}`);
  }
}
