import type { CanonicalValue } from "../canonical.ts";
import type { InvariantMonitor, Violation } from "../invariants.ts";
import type { NodeId } from "../protocol.ts";
import type { ProtocolEntry, Scenario } from "../harness/scenario.ts";
import type { Action, ProcessRole, RunnableSimulation, ScheduledAction } from "../simulation.ts";
import type { TraceRecord } from "../trace.ts";

export interface ProcessState {
  readonly id: NodeId;
  readonly role: ProcessRole;
  readonly up: boolean;
  readonly view: CanonicalValue;
  readonly timers: readonly { readonly key: string; readonly at: number }[];
}

/** What the UI receives: everything that changed since the previous frame. */
export interface Frame {
  readonly now: number;
  /** True when the UI must discard what it had (new scenario or seek). */
  readonly reset: boolean;
  /** Trace records since the previous frame (all of them after a reset). */
  readonly records: readonly TraceRecord[];
  /** Violations found since the previous frame (all of them after a reset). */
  readonly violations: readonly Violation[];
  readonly processes: readonly ProcessState[];
  /** The network's description of itself (for LinkNetwork, a LinkNetworkView). */
  readonly network: CanonicalValue | null;
  readonly playing: boolean;
  readonly speed: number;
  readonly events: number;
  /** No more scheduled events: the simulation is quiescent. */
  readonly idle: boolean;
}

/** Labels of annotations worth stopping at when stepping. */
export const NOTABLE_LABELS: ReadonlySet<string> = new Set([
  "electionStarted",
  "becameLeader",
  "steppedDown",
  "complete",
]);

/**
 * Smallest gap between a processed instant and a live action. Live actions are scheduled
 * strictly after everything already processed so that a replay (which queues them up front,
 * ahead of protocol events at the same time) orders them identically.
 */
const LIVE_EPSILON_MS = 0.001;

/** Upper bound on events processed per tick, so a slow frame never freezes the UI. */
const MAX_EVENTS_PER_TICK = 50_000;

/**
 * Drives one simulation for an interactive UI: playback at a speed, single steps, live
 * actions (recorded into the scenario), and seeking by deterministic replay. Platform
 * independent; the browser wraps it in a Web Worker.
 */
export class SimulationHost {
  private readonly registry: ReadonlyMap<string, ProtocolEntry>;
  private base!: Scenario;
  private sim!: RunnableSimulation;
  private monitor!: InvariantMonitor<unknown>;
  private pending: TraceRecord[] = [];
  private reported = 0;
  private resetPending = true;
  /** Extra listeners for records (e.g. while stepping to a notable event). */
  private watchers: ((r: TraceRecord) => void)[] = [];
  playing = false;
  /** Virtual milliseconds per real millisecond. */
  speed = 0.1;

  constructor(registry: ReadonlyMap<string, ProtocolEntry>, scenario: Scenario) {
    this.registry = registry;
    this.load(scenario);
  }

  /** Replaces the simulation; the next frame resets the UI. */
  load(scenario: Scenario): void {
    this.base = scenario;
    this.rebuild(scenario);
    this.playing = false;
  }

  get now(): number {
    return this.sim.now;
  }

  /** The scenario as it stands, including live actions; replays to the same trace. */
  scenario(): Scenario {
    return {
      ...this.base,
      actions: this.sim.actions() as Scenario["actions"],
      durationMs: Math.max(this.base.durationMs, Math.ceil(this.sim.now)),
    };
  }

  /** Advances by `realMs` of wall time at the current speed, if playing. */
  tick(realMs: number): void {
    if (!this.playing) return;
    this.advanceTo(this.sim.now + realMs * this.speed);
  }

  /** Processes events up to `timeMs` (bounded per call so the UI stays responsive). */
  advanceTo(timeMs: number): void {
    const start = this.sim.eventCount;
    for (let next = this.sim.nextEventTime; next !== undefined && next <= timeMs;) {
      if (this.sim.eventCount - start >= MAX_EVENTS_PER_TICK) return;
      this.sim.step();
      next = this.sim.nextEventTime;
    }
    this.sim.runUntil(timeMs);
  }

  /** Processes exactly one event. */
  step(): boolean {
    return this.sim.step();
  }

  /**
   * Steps until something notable happens (an election, a leader change, a completed client
   * operation, or a new violation) or `maxMs` of virtual time passes.
   */
  stepToNotable(maxMs = 10_000): boolean {
    const limit = this.sim.now + maxMs;
    const violations = this.monitor.violations.length;
    let found = false;
    const sink = (r: TraceRecord) => {
      if (r.type === "annotate" && NOTABLE_LABELS.has(r.label)) found = true;
    };
    this.watchers.push(sink);
    try {
      while (!found && this.monitor.violations.length === violations) {
        const next = this.sim.nextEventTime;
        if (next === undefined || next > limit) {
          this.sim.runUntil(limit);
          return false;
        }
        this.sim.step();
      }
      return true;
    } finally {
      this.watchers.splice(this.watchers.indexOf(sink), 1);
    }
  }

  /**
   * Applies a user action now. It is recorded in the scenario, so exporting and replaying
   * reproduces the session exactly.
   */
  act(action: Action<CanonicalValue, CanonicalValue>): void {
    const at = Math.round((this.sim.now + LIVE_EPSILON_MS) * 1000) / 1000;
    this.sim.schedule(at, action);
    this.sim.runUntil(at);
  }

  /** Jumps to `timeMs` by replaying the scenario (with live actions) from the start. */
  seek(timeMs: number): void {
    const scenario = this.scenario();
    this.rebuild(scenario);
    this.base = { ...scenario, durationMs: this.base.durationMs };
    this.sim.runUntil(Math.max(0, timeMs));
  }

  /** Everything that changed since the previous frame. */
  frame(): Frame {
    const records = this.pending;
    this.pending = [];
    const violations = this.monitor.violations.slice(this.resetPending ? 0 : this.reported);
    this.reported = this.monitor.violations.length;
    const reset = this.resetPending;
    this.resetPending = false;
    const ids = [...this.sim.nodeIds, ...this.sim.clientIds];
    return {
      now: this.sim.now,
      reset,
      records,
      violations,
      processes: ids.map((id) => ({
        id,
        role: this.sim.roleOf(id),
        up: this.sim.isUp(id),
        view: this.sim.view(id),
        timers: this.sim.timers(id),
      })),
      network: this.sim.networkView(),
      playing: this.playing,
      speed: this.speed,
      events: this.sim.eventCount,
      idle: this.sim.nextEventTime === undefined,
    };
  }

  private rebuild(scenario: Scenario): void {
    const entry = this.registry.get(scenario.protocol);
    if (entry === undefined) throw new Error(`unknown protocol "${scenario.protocol}"`);
    this.pending = [];
    this.reported = 0;
    this.resetPending = true;
    const { sim, monitor } = entry.build(scenario, {
      sinks: [
        (r) => {
          this.pending.push(r);
          for (const w of this.watchers) w(r);
        },
      ],
    });
    this.sim = sim;
    this.monitor = monitor;
  }
}

export type { ScheduledAction };
