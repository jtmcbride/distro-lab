import type { CanonicalValue } from "./canonical.ts";
import type { NodeId } from "./protocol.ts";
import type { TraceRecord, TraceSink } from "./trace.ts";

export interface NodeSnapshot<View> {
  readonly id: NodeId;
  readonly up: boolean;
  /** Number of times the node has crashed; volatile state resets when it changes. */
  readonly incarnation: number;
  readonly view: View;
}

/** Cluster state between two atomic steps. */
export interface ClusterSnapshot<View> {
  readonly t: number;
  /** Most recent trace record; the step that produced this state ends here. */
  readonly recordId: number;
  readonly nodes: readonly NodeSnapshot<View>[];
}

export interface Violation {
  readonly invariant: string;
  readonly message: string;
  readonly t: number;
  readonly recordId: number;
  readonly nodes: readonly NodeId[];
}

/**
 * A safety property checked after every step. Checkers may keep history (e.g. "the leader
 * seen for each term"), so create a fresh one per run.
 */
export interface Invariant<View> {
  readonly name: string;
  check(snapshot: ClusterSnapshot<View>, report: Report): void;
  /**
   * Optional: called for every trace record as it is emitted, mid-step. Used for properties
   * of client-visible events (e.g. "an acknowledged write is already replicated"). `now()`
   * gives the servers' state at that moment.
   */
  onRecord?(record: TraceRecord, now: () => ClusterSnapshot<View>, report: Report): void;
  /**
   * Required for checkers that keep history, so snapshots can restore it. `save` returns
   * the live history as structured-clonable data; `load` takes ownership of a copy. History
   * may reference objects from protocol views (snapshots copy both together).
   */
  save?(): unknown;
  load?(state: unknown): void;
}

export type Report = (message: string, nodes: NodeId[]) => void;

export interface MonitorState {
  readonly violations: readonly Violation[];
  readonly seen: Set<string>;
  readonly invariants: readonly unknown[];
}

/** Anything the monitor can watch; Simulation satisfies this. */
export interface Observable {
  readonly now: number;
  readonly lastRecordId: number;
  /** Servers; invariants see only these. */
  readonly nodeIds: readonly NodeId[];
  isUp(node: NodeId): boolean;
  incarnation(node: NodeId): number;
  view(node: NodeId): CanonicalValue;
  onStep(listener: () => void): void;
  addSink(sink: TraceSink): void;
}

/**
 * Runs invariants after every step and collects violations. A condition that persists
 * across steps is reported once, at the step where it first appeared.
 */
export class InvariantMonitor<View> {
  readonly violations: Violation[] = [];
  private seen = new Set<string>();
  private readonly sim: Observable;
  private readonly invariants: readonly Invariant<View>[];
  /** Stop recording after this many violations (the first is usually the interesting one). */
  private readonly limit: number;

  constructor(sim: Observable, invariants: readonly Invariant<View>[], limit = 100) {
    this.sim = sim;
    this.invariants = invariants;
    this.limit = limit;
    this.check();
    sim.onStep(() => this.check());
    const withHooks = invariants.filter((inv) => inv.onRecord !== undefined);
    if (withHooks.length > 0) {
      sim.addSink((record) => {
        const now = () => this.snapshot();
        for (const inv of withHooks)
          inv.onRecord!(record, now, this.reporter(inv, record.t, record.id));
      });
    }
  }

  get ok(): boolean {
    return this.violations.length === 0;
  }

  get first(): Violation | undefined {
    return this.violations[0];
  }

  /** Live state for snapshots; see `Invariant.save`. */
  saveState(): MonitorState {
    return {
      violations: this.violations,
      seen: this.seen,
      invariants: this.invariants.map((inv) => inv.save?.()),
    };
  }

  loadState(state: MonitorState): void {
    this.violations.splice(0, this.violations.length, ...state.violations);
    this.seen = state.seen;
    this.invariants.forEach((inv, i) => inv.load?.(state.invariants[i]));
  }

  private snapshot(): ClusterSnapshot<View> {
    return {
      t: this.sim.now,
      recordId: this.sim.lastRecordId,
      nodes: this.sim.nodeIds.map((id) => ({
        id,
        up: this.sim.isUp(id),
        incarnation: this.sim.incarnation(id),
        view: this.sim.view(id) as View,
      })),
    };
  }

  private reporter(inv: Invariant<View>, t: number, recordId: number): Report {
    return (message, nodes) => {
      if (this.violations.length >= this.limit) return;
      const key = `${inv.name}\n${message}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.violations.push({ invariant: inv.name, message, t, recordId, nodes });
    };
  }

  private check(): void {
    if (this.violations.length >= this.limit) return;
    const snapshot = this.snapshot();
    for (const inv of this.invariants) {
      inv.check(snapshot, this.reporter(inv, snapshot.t, snapshot.recordId));
    }
  }
}
