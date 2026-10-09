import type { CanonicalValue } from "../canonical.ts";
import { InvariantMonitor, type Invariant, type Violation } from "../invariants.ts";
import { LinkNetwork, type LinkNetworkConfig, type NetworkChange } from "../linkNetwork.ts";
import type { NodeId, Protocol } from "../protocol.ts";
import { Simulation, type RunnableSimulation, type ScheduledAction } from "../simulation.ts";
import { TraceRecorder, type TraceRecord } from "../trace.ts";

export const SCENARIO_VERSION = 1;

/** Everything needed to reproduce a run exactly. Plain JSON. */
export interface Scenario {
  readonly version: number;
  /** Registry key, e.g. "raft" or a planted-bug variant. */
  readonly protocol: string;
  readonly seed: number;
  readonly nodes: readonly NodeId[];
  readonly network: LinkNetworkConfig;
  readonly actions: readonly ScheduledAction<CanonicalValue, NetworkChange>[];
  readonly durationMs: number;
  /**
   * If set, the liveness check runs at the end: by then all faults must have been lifted
   * at least this long, and the protocol must have made progress.
   */
  readonly livenessAfterMs?: number;
}

/** How to build, check and judge one protocol (or a deliberately broken variant of it). */
export interface ProtocolEntry {
  readonly name: string;
  readonly description: string;
  /** Builds a simulation for the scenario with its invariants attached. */
  build(scenario: Scenario): {
    sim: RunnableSimulation;
    monitor: InvariantMonitor<unknown>;
    /** Problems with progress at the end of the run; empty if live. */
    liveness(): string[];
  };
}

/** Builds a registry entry, keeping the protocol's own types internal. */
export function defineProtocol<P, V, M, C, View>(spec: {
  name: string;
  description: string;
  create: () => Protocol<P, V, M, C>;
  invariants: () => Invariant<View>[];
  liveness: (sim: RunnableSimulation, view: (n: NodeId) => View) => string[];
}): ProtocolEntry {
  return {
    name: spec.name,
    description: spec.description,
    build(scenario) {
      const sim = new Simulation<P, V, M, C, NetworkChange>({
        protocol: spec.create(),
        nodes: scenario.nodes,
        seed: scenario.seed,
        network: new LinkNetwork(scenario.nodes, scenario.network),
        actions: scenario.actions as readonly ScheduledAction<C, NetworkChange>[],
      });
      const monitor = new InvariantMonitor<View>(sim, spec.invariants());
      return {
        sim,
        monitor: monitor as InvariantMonitor<unknown>,
        liveness: () => spec.liveness(sim, (n) => sim.view(n) as View),
      };
    },
  };
}

export interface RunResult {
  readonly scenario: Scenario;
  readonly violations: readonly Violation[];
  /** Liveness problems, if the scenario asked for a liveness check. */
  readonly liveness: readonly string[];
  readonly traceHash: string;
  readonly events: number;
  /** Present when `keepTrace` was requested. */
  readonly trace?: readonly TraceRecord[];
}

export function failed(r: RunResult): boolean {
  return r.violations.length > 0 || r.liveness.length > 0;
}

/** Short identity of a failure, used to check a minimized scenario fails the same way. */
export function failureKind(r: RunResult): string | null {
  const v = r.violations[0];
  if (v !== undefined) return `safety:${v.invariant}`;
  if (r.liveness.length > 0) return "liveness";
  return null;
}

export function runScenario(
  registry: ReadonlyMap<string, ProtocolEntry>,
  scenario: Scenario,
  options: { keepTrace?: boolean; stopOnViolation?: boolean } = {},
): RunResult {
  if (scenario.version !== SCENARIO_VERSION) {
    throw new Error(`unsupported scenario version ${scenario.version}`);
  }
  const entry = registry.get(scenario.protocol);
  if (entry === undefined) throw new Error(`unknown protocol "${scenario.protocol}"`);
  const { sim, monitor, liveness } = entry.build(scenario);
  const rec = new TraceRecorder(options.keepTrace ?? false);
  sim.addSink(rec.sink);

  if (options.stopOnViolation ?? true) {
    // Advance in slices so a broken run stops near the violation instead of running on.
    for (let t = 0; t < scenario.durationMs && monitor.ok;) {
      t = Math.min(scenario.durationMs, t + 100);
      sim.runUntil(t);
    }
  } else {
    sim.runUntil(scenario.durationMs);
  }
  const checkLiveness = monitor.ok && scenario.livenessAfterMs !== undefined;
  return {
    scenario,
    violations: monitor.violations,
    liveness: checkLiveness ? liveness() : [],
    traceHash: rec.hash(),
    events: sim.eventCount,
    ...(options.keepTrace === true ? { trace: rec.records } : {}),
  };
}
