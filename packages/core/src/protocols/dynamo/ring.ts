import type { NodeId } from "../../protocol.ts";
import { hashString32 } from "../../rng.ts";

/** Positions each server takes on the ring (Dynamo's virtual nodes). */
export const TOKENS_PER_SERVER = 8;

/** FNV-1a spreads short, similar strings poorly; a murmur3 finalizer fixes that. */
function position(s: string): number {
  let h = hashString32(s);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

type Ring = readonly { readonly at: number; readonly node: NodeId }[];

const rings = new Map<string, Ring>();

function ringFor(servers: readonly NodeId[]): Ring {
  const id = [...servers].sort().join("\u0000");
  let ring = rings.get(id);
  if (ring === undefined) {
    ring = servers
      .flatMap((node) =>
        Array.from({ length: TOKENS_PER_SERVER }, (_, i) => ({
          at: position(`${node}#${i}`),
          node,
        })),
      )
      // Ties (vanishingly rare) break by node id so the order never depends on input order.
      .sort((a, b) => a.at - b.at || (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
    rings.set(id, ring);
  }
  return ring;
}

/**
 * Every server, in the order a key's requests try them: walk the ring clockwise from the
 * key's position and take each server the first time it appears. The first N are the key's
 * replicas; the rest are its fallbacks. Depends only on the key and the set of servers.
 */
export function preferenceList(servers: readonly NodeId[], key: string): NodeId[] {
  const ring = ringFor(servers);
  const at = position(`key:${key}`);
  let start = ring.findIndex((t) => t.at >= at);
  if (start < 0) start = 0;
  const order: NodeId[] = [];
  for (let i = 0; i < ring.length && order.length < servers.length; i++) {
    const node = ring[(start + i) % ring.length]!.node;
    if (!order.includes(node)) order.push(node);
  }
  return order;
}

/** The key's N replicas. */
export function replicasOf(servers: readonly NodeId[], key: string, n: number): NodeId[] {
  return preferenceList(servers, key).slice(0, n);
}
