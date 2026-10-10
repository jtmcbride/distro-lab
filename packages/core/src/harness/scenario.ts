import type { CanonicalValue } from "../canonical.ts";
import { InvariantMonitor, type Invariant, type Violation } from "../invariants.ts";
import { LinkNetwork, type LinkNetworkConfig, type NetworkChange } from "../linkNetwork.ts";
import type { NodeId, Protocol } from "../protocol.ts";
import { Simulation, type RunnableSimulation, type ScheduledAction } from "../simulation.ts";
import { TraceRecorder, type TraceRecord, type TraceSink } from "../trace.ts";
import type { Workload } from "./generate.ts";
import type { Rng } from "../rng.ts";

export const SCENARIO_VERSION = 1;

/** Run granularity: violations stop a run within this much virtual time; liveness is sampled. */
const LIVENESS_SAMPLE_MS = 100;

/** Everything needed to reproduce a run exactly. Plain JSON. */
export interface Scenario {
  readonly version: number;
  /** Registry key, e.g. "raft" or a planted-bug variant. */
  readonly protocol: string;
  readonly seed: number;
  /** Server ids. */
  readonly nodes: readonly NodeId[];
  /** Client process ids (they run the protocol's client, if it has one). */
  readonly clients?: readonly NodeId[];
  /** Protocol-specific configuration, e.g. Raft timeouts. Plain JSON. */
  readonly config?: CanonicalValue;
  /** Covers servers and clients. */
  readonly network: LinkNetworkConfig;
  readonly actions: readonly ScheduledAction<CanonicalValue, NetworkChange>[];
  readonly durationMs: number;
  /**
   * If set, the last `livenessAfterMs` of the run is fault-free and the protocol must reach a
   * good state (e.g. one agreed leader) at some point within it, sampled every 100ms.
   */
  readonly livenessAfterMs?: number;
}

/** How to build, check and judge one protocol (or a deliberately broken variant of it). */
export interface ProtocolEntry {
  readonly name: string;
  readonly description: string;
  /** Client operations for generated scenarios, if the protocol serves clients. */
  readonly workload?: Workload;
  /** Random protocol settings for generated scenarios, to widen what fuzzing explores. */
  readonly randomConfig?: (rng: Rng) => CanonicalValue;
  /** One-line summary of a server's view for CLI output; defaults to its JSON. */
  readonly formatView?: (view: CanonicalValue) => string;
  /** Hand-written scenarios by name, e.g. "figure8". */
  readonly examples?: Readonly<Record<string, (protocol: string) => Scenario>>;
  /** Builds a simulation for the scenario with its invariants attached. */
  build(
    scenario: Scenario,
    options?: { readonly sinks?: readonly TraceSink[] },
  ): {
    sim: RunnableSimulation;
    monitor: InvariantMonitor<unknown>;
    /** Problems with progress right now; empty if the cluster is in a good state. */
    liveness(): string[];
  };
}

/** Builds a registry entry, keeping the protocol's own types internal. */
export function defineProtocol<P, V, M, C, View, CP = never, CV = never>(spec: {
  name: string;
  description: string;
  /** `config` is the scenario's protocol config, if any. */
  create: (config: CanonicalValue | undefined) => Protocol<P, V, M, C>;
  /** Protocol for client processes, if the protocol serves clients. */
  client?: () => Protocol<CP, CV, M, C>;
  /** `config` is the scenario's protocol config, if any (some guarantees depend on it). */
  invariants: (config: CanonicalValue | undefined) => Invariant<View>[];
  liveness: (
    sim: RunnableSimulation,
    view: (n: NodeId) => View,
    config: CanonicalValue | undefined,
  ) => string[];
  workload?: Workload;
  randomConfig?: (rng: Rng) => CanonicalValue;
  formatView?: (view: View) => string;
  examples?: Readonly<Record<string, (protocol: string) => Scenario>>;
}): ProtocolEntry {
  return {
    name: spec.name,
    description: spec.description,
    ...(spec.workload === undefined ? {} : { workload: spec.workload }),
    ...(spec.randomConfig === undefined ? {} : { randomConfig: spec.randomConfig }),
    ...(spec.formatView === undefined
      ? {}
      : { formatView: spec.formatView as (view: CanonicalValue) => string }),
    ...(spec.examples === undefined ? {} : { examples: spec.examples }),
    build(scenario, options) {
      const clients = scenario.clients ?? [];
      if (clients.length > 0 && spec.client === undefined) {
        throw new Error(`protocol "${spec.name}" has no client process`);
      }
      const sim = new Simulation<P, V, M, C, NetworkChange, CP, CV>({
        protocol: spec.create(scenario.config),
        nodes: scenario.nodes,
        ...(spec.client === undefined || clients.length === 0
          ? {}
          : { clients: { ids: clients, protocol: spec.client() } }),
        seed: scenario.seed,
        network: new LinkNetwork([...scenario.nodes, ...clients], scenario.network),
        actions: scenario.actions as readonly ScheduledAction<C, NetworkChange>[],
        sinks: options?.sinks ?? [],
      });
      const monitor = new InvariantMonitor<View>(sim, spec.invariants(scenario.config));
      return {
        sim,
        monitor: monitor as InvariantMonitor<unknown>,
        liveness: () => spec.liveness(sim, (n) => sim.view(n) as View, scenario.config),
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
  /** Final state of every process, when `keepState` was requested. */
  readonly finalState?: readonly {
    readonly id: NodeId;
    readonly role: "server" | "client";
    readonly up: boolean;
    readonly view: CanonicalValue;
  }[];
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
  options: { keepTrace?: boolean; keepState?: boolean; stopOnViolation?: boolean } = {},
): RunResult {
  if (scenario.version !== SCENARIO_VERSION) {
    throw new Error(`unsupported scenario version ${scenario.version}`);
  }
  const entry = registry.get(scenario.protocol);
  if (entry === undefined) throw new Error(`unknown protocol "${scenario.protocol}"`);
  // The recorder is attached at construction so the trace includes node init records.
  const rec = new TraceRecorder(options.keepTrace ?? false);
  const { sim, monitor, liveness } = entry.build(scenario, { sinks: [rec.sink] });

  // Liveness: once faults are lifted, the protocol must reach a good state at some point in
  // the window. A single end-of-run sample would flag legitimate transient states, such as an
  // election started by a lost heartbeat just before the end.
  const livenessFrom =
    scenario.livenessAfterMs === undefined
      ? undefined
      : scenario.durationMs - scenario.livenessAfterMs;
  let liveProblems: string[] | null = livenessFrom === undefined ? [] : null;
  const sampleLiveness = (t: number) => {
    if (livenessFrom === undefined || t < livenessFrom || liveProblems?.length === 0) return;
    liveProblems = liveness();
  };

  const stopOnViolation = options.stopOnViolation ?? true;
  // Advance in slices: lets a broken run stop near its violation and samples liveness.
  for (let t = 0; t < scenario.durationMs && (monitor.ok || !stopOnViolation);) {
    t = Math.min(scenario.durationMs, t + LIVENESS_SAMPLE_MS);
    sim.runUntil(t);
    sampleLiveness(t);
  }
  return {
    scenario,
    violations: monitor.violations,
    liveness: monitor.ok ? (liveProblems ?? []) : [],
    traceHash: rec.hash(),
    events: sim.eventCount,
    ...(options.keepTrace === true ? { trace: rec.records } : {}),
    ...(options.keepState === true
      ? {
          finalState: [
            ...sim.nodeIds.map((id) => ({ id, role: "server" as const })),
            ...sim.clientIds.map((id) => ({ id, role: "client" as const })),
          ].map((p) => ({ ...p, up: sim.isUp(p.id), view: sim.view(p.id) })),
        }
      : {}),
  };
}
