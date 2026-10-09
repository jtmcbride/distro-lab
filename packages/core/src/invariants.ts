import type { CanonicalValue } from "./canonical.ts";
import type { NodeId } from "./protocol.ts";

export interface NodeSnapshot<View> {
  readonly id: NodeId;
  readonly up: boolean;
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
  check(snapshot: ClusterSnapshot<View>, report: (message: string, nodes: NodeId[]) => void): void;
}

/** Anything the monitor can watch; Simulation satisfies this. */
export interface Observable {
  readonly now: number;
  readonly lastRecordId: number;
  readonly nodeIds: readonly NodeId[];
  isUp(node: NodeId): boolean;
  view(node: NodeId): CanonicalValue;
  onStep(listener: () => void): void;
}

/**
 * Runs invariants after every step and collects violations. A condition that persists
 * across steps is reported once, at the step where it first appeared.
 */
export class InvariantMonitor<View> {
  readonly violations: Violation[] = [];
  private readonly seen = new Set<string>();
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
  }

  get ok(): boolean {
    return this.violations.length === 0;
  }

  get first(): Violation | undefined {
    return this.violations[0];
  }

  private check(): void {
    if (this.violations.length >= this.limit) return;
    const snapshot: ClusterSnapshot<View> = {
      t: this.sim.now,
      recordId: this.sim.lastRecordId,
      nodes: this.sim.nodeIds.map((id) => ({
        id,
        up: this.sim.isUp(id),
        view: this.sim.view(id) as View,
      })),
    };
    for (const inv of this.invariants) {
      inv.check(snapshot, (message, nodes) => {
        const key = `${inv.name}\n${message}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.violations.push({
          invariant: inv.name,
          message,
          t: snapshot.t,
          recordId: snapshot.recordId,
          nodes,
        });
      });
    }
  }
}
