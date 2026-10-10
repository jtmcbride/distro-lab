import type { InvariantMonitor, MonitorState } from "./invariants.ts";
import type { RunnableSimulation, SimulationState } from "./simulation.ts";

// Available in browsers, Workers and Node 17+; declared here because the core compiles
// without DOM or Node typings.
declare function structuredClone<T>(value: T): T;

/**
 * A run's complete state between two steps: the simulation and its invariant monitor.
 *
 * Both are copied by a single `structuredClone`, so references shared between them survive
 * the copy (invariant history points at log entries inside protocol state and detects
 * changes by identity). A checkpoint is never mutated; every restore copies it again.
 */
export interface Checkpoint {
  readonly t: number;
  /** Events processed when it was taken. */
  readonly events: number;
  /** Id of the last trace record emitted before it was taken (-1 if none). */
  readonly recordId: number;
  readonly data: { readonly sim: SimulationState; readonly monitor: MonitorState };
}

export function saveCheckpoint(
  sim: RunnableSimulation,
  monitor: InvariantMonitor<unknown>,
): Checkpoint {
  return {
    t: sim.now,
    events: sim.eventCount,
    recordId: sim.lastRecordId,
    data: structuredClone({ sim: sim.saveState(), monitor: monitor.saveState() }),
  };
}

/** Restores into a simulation (and monitor) built from the same scenario. */
export function loadCheckpoint(
  sim: RunnableSimulation,
  monitor: InvariantMonitor<unknown>,
  checkpoint: Checkpoint,
): void {
  const data = structuredClone(checkpoint.data);
  sim.loadState(data.sim);
  monitor.loadState(data.monitor);
}
