import type { CanonicalValue } from "../canonical.ts";
import type { NetworkChange } from "../linkNetwork.ts";
import type { NodeId } from "../protocol.ts";
import { Rng } from "../rng.ts";
import type { ScheduledAction } from "../simulation.ts";
import { SCENARIO_VERSION, type Scenario } from "./scenario.ts";

export interface GenerateOptions {
  readonly protocol: string;
  /** Cluster sizes to choose from. */
  readonly clusterSizes?: readonly number[];
  /** Faults are injected in [200ms, faultWindowMs). */
  readonly faultWindowMs?: number;
  /** Upper bound on fault events (a restart counts once). Default 25. */
  readonly maxFaults?: number;
  /** After the fault window everything is repaired; the run continues this long. */
  readonly stabilizeMs?: number;
  /** Client operations to issue (from the protocol's registry entry). No clients if absent. */
  readonly workload?: Workload | undefined;
  /** Draws protocol settings for the scenario (from the registry entry). */
  readonly randomConfig?: ((rng: Rng) => CanonicalValue) | undefined;
}

/**
 * Generates client operations for `clients` between `fromMs` and `toMs`. Protocol-specific:
 * it decides what operations look like and how their results can be checked.
 */
export type Workload = (
  rng: Rng,
  clients: readonly NodeId[],
  fromMs: number,
  toMs: number,
) => ScheduledAction<CanonicalValue, NetworkChange>[];

type Action = ScheduledAction<CanonicalValue, NetworkChange>["action"];

/**
 * Builds a random fault scenario from a single integer. The same (seed, options) always
 * yields the same scenario, so a fuzz failure is reproducible from its seed alone.
 */
export function generateScenario(seed: number, options: GenerateOptions): Scenario {
  const rng = Rng.fromSeed(seed).stream("scenario");
  const sizes = options.clusterSizes ?? [3, 5];
  const faultWindowMs = options.faultWindowMs ?? 10_000;
  // Clients may need to drain a backlog queued while they were cut off.
  const stabilizeMs = options.stabilizeMs ?? (options.workload === undefined ? 4_000 : 8_000);
  const nodes: NodeId[] = Array.from({ length: rng.pick(sizes) }, (_, i) =>
    String.fromCharCode(65 + i),
  );

  // Client choices use their own stream so server-only scenarios stay the same with or
  // without a workload.
  const wrng = rng.stream("workload");
  const clients: NodeId[] =
    options.workload === undefined
      ? []
      : Array.from({ length: wrng.int(1, 3) }, (_, i) => `c${i + 1}`);

  const actions: { atMs: number; action: Action }[] = [];
  const net = (change: NetworkChange): Action => ({ type: "network", change });
  const faults = rng.int(1, options.maxFaults ?? 25);
  for (let i = 0; i < faults; i++) {
    const atMs = rng.int(200, faultWindowMs - 1);
    const node = rng.pick(nodes);
    const other = rng.pick(nodes.filter((n) => n !== node));
    const roll = rng.next();
    if (roll < 0.2) {
      actions.push({ atMs, action: { type: "crash", node } });
    } else if (roll < 0.35) {
      actions.push({ atMs, action: { type: "recover", node } });
    } else if (roll < 0.5) {
      // Fast restart: the node comes back while the cluster may still be mid-election.
      actions.push({ atMs, action: { type: "crash", node } });
      actions.push({ atMs: atMs + rng.int(0, 300), action: { type: "recover", node } });
    } else if (roll < 0.6) {
      const groups = randomGroups(rng, nodes);
      // Clients land on a random side; they are never crashed, only cut off.
      for (const c of clients) groups[wrng.int(0, groups.length - 1)]!.push(c);
      actions.push({ atMs, action: net({ type: "partition", groups }) });
    } else if (roll < 0.65) {
      actions.push({ atMs, action: net({ type: "isolate", node }) });
    } else if (roll < 0.75) {
      actions.push({ atMs, action: net({ type: "heal" }) });
    } else if (roll < 0.8) {
      actions.push({ atMs, action: net({ type: "setLink", from: node, to: other, up: false }) });
    } else if (roll < 0.85) {
      const latencyMs = rng.int(50, 400);
      actions.push({
        atMs,
        action: net({ type: "setLink", from: node, to: other, latencyMs, bidirectional: true }),
      });
    } else {
      // Network-wide degradation: delays comparable to election timeouts, loss, duplication.
      actions.push({
        atMs,
        action: net({
          type: "setAll",
          latencyMs: rng.int(5, 150),
          jitterMs: rng.int(0, 300),
          loss: rng.pick([0, 0.05, 0.2]),
          duplicate: rng.pick([0, 0.1, 0.3]),
        }),
      });
    }
  }
  // Fast restarts can land past the window; keep every fault inside it.
  for (const a of actions) a.atMs = Math.min(a.atMs, faultWindowMs - 1);
  actions.sort((a, b) => a.atMs - b.atMs);
  actions.push({ atMs: faultWindowMs, action: net({ type: "restore" }) });
  for (const node of nodes)
    actions.push({ atMs: faultWindowMs, action: { type: "recover", node } });
  if (options.workload !== undefined) {
    actions.push(...options.workload(wrng, clients, 300, faultWindowMs));
    // Stable: at equal times, faults and repairs stay ahead of client operations.
    actions.sort((a, b) => a.atMs - b.atMs);
  }

  return {
    version: SCENARIO_VERSION,
    protocol: options.protocol,
    seed,
    nodes,
    ...(clients.length > 0 ? { clients } : {}),
    ...(options.randomConfig === undefined
      ? {}
      : { config: options.randomConfig(rng.stream("config")) }),
    network: {
      defaults: {
        latencyMs: rng.int(1, 20),
        jitterMs: rng.int(0, 30),
        loss: rng.pick([0, 0, 0.01, 0.05]),
        duplicate: rng.pick([0, 0, 0.02]),
      },
    },
    actions,
    durationMs: faultWindowMs + stabilizeMs,
    livenessAfterMs: stabilizeMs,
  };
}

function randomGroups(rng: Rng, nodes: readonly NodeId[]): NodeId[][] {
  const shuffled = [...nodes];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const cut = rng.int(1, shuffled.length - 1);
  return [shuffled.slice(0, cut), shuffled.slice(cut)];
}
