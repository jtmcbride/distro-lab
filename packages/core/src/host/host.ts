import { canonicalJson, type CanonicalValue } from "../canonical.ts";
import type { InvariantMonitor, Violation } from "../invariants.ts";
import type { NodeId } from "../protocol.ts";
import type { ProtocolEntry, Scenario } from "../harness/scenario.ts";
import type { Action, ProcessRole, RunnableSimulation, ScheduledAction } from "../simulation.ts";
import { loadCheckpoint, saveCheckpoint, type Checkpoint } from "../snapshot.ts";
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
  /** True when the UI must discard everything it had (a new scenario was loaded). */
  readonly reset: boolean;
  /**
   * Set when the run went back in time: the UI drops records with a larger id before
   * appending `records`, and `violations` is the complete list.
   */
  readonly truncateAfter: number | null;
  /** True after a seek or load (the UI may move its selection). */
  readonly jumped: boolean;
  /** New trace records (all of them after a reset). */
  readonly records: readonly TraceRecord[];
  /** New violations, or all of them after a reset or truncation. */
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

type ScenarioAction = Scenario["actions"][number];

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

export interface CheckpointPolicy {
  /** Initial spacing, in events. */
  readonly every: number;
  /** Most checkpoints kept; past it, every other one is dropped and the spacing doubles. */
  readonly max: number;
}

const DEFAULT_CHECKPOINTS: CheckpointPolicy = { every: 500, max: 128 };

/**
 * Drives one simulation for an interactive UI: playback at a speed, single steps forwards
 * and backwards, live actions (recorded into the scenario), and seeking. Platform
 * independent; the browser wraps it in a Web Worker.
 *
 * Time travel restores the nearest checkpoint and replays from there. Checkpoints sit at
 * fixed event counts (multiples of the spacing), so a replay recreates the same ones.
 */
export class SimulationHost {
  private readonly registry: ReadonlyMap<string, ProtocolEntry>;
  private readonly policy: CheckpointPolicy;
  private base!: Scenario;
  /** The scenario's actions including live ones, in the order they were added. */
  private actions: ScenarioAction[] = [];
  private sim!: RunnableSimulation;
  private monitor!: InvariantMonitor<unknown>;
  /**
   * Records of the current timeline by id, including any beyond the current position
   * (after going back) until a live action changes the future.
   */
  private trace: TraceRecord[] = [];
  /** Checkpoints by event count. */
  private checkpoints = new Map<number, Checkpoint>();
  private spacing = 0;
  /** Id of the first record emitted by the most recent step. */
  private stepStart = 0;
  private lastStepEnd = -1;
  // What the UI has been sent.
  private sentRecords = 0;
  private sentViolations = 0;
  private resetPending = true;
  private truncatePending: number | null = null;
  private jumpPending = true;
  /** Extra listeners for records (e.g. while stepping to a notable event). */
  private watchers: ((r: TraceRecord) => void)[] = [];
  playing = false;
  /** Virtual milliseconds per real millisecond. */
  speed = 0.1;

  constructor(
    registry: ReadonlyMap<string, ProtocolEntry>,
    scenario: Scenario,
    policy: CheckpointPolicy = DEFAULT_CHECKPOINTS,
  ) {
    this.registry = registry;
    this.policy = policy;
    this.load(scenario);
  }

  /** Replaces the simulation; the next frame resets the UI. */
  load(scenario: Scenario): void {
    this.base = scenario;
    this.actions = scenario.actions.map((a) => JSON.parse(canonicalJson(a)) as ScenarioAction);
    this.rebuild(scenario);
    this.playing = false;
  }

  get now(): number {
    return this.sim.now;
  }

  /** Events processed so far in the current run. */
  get events(): number {
    return this.sim.eventCount;
  }

  /** Number of checkpoints held (for tests and diagnostics). */
  get checkpointCount(): number {
    return this.checkpoints.size;
  }

  /** The scenario as it stands, including live actions; replays to the same trace. */
  scenario(): Scenario {
    return {
      ...this.base,
      actions: [...this.actions],
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
      if (isNotable(r)) found = true;
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

  /** Goes back one event. Returns false at the start of the run. */
  stepBack(): boolean {
    if (this.sim.eventCount === 0) return false;
    this.seekEvent(this.sim.eventCount - 1);
    return true;
  }

  /**
   * Goes back to just after the latest notable event (or violation) before the current
   * step, or to the start if there is none.
   */
  stepBackToNotable(): void {
    const violations = new Set(this.monitor.violations.map((v) => v.recordId));
    for (let i = this.stepStart - 1; i >= 0; i--) {
      const r = this.trace[i]!;
      if (isNotable(r) || violations.has(r.id)) {
        this.seekRecord(r.id);
        return;
      }
    }
    this.seekEvent(0);
  }

  /**
   * Applies a user action now. It is recorded in the scenario, so exporting and replaying
   * reproduces the session exactly. It changes the future, so later checkpoints are dropped.
   */
  act(action: Action<CanonicalValue, CanonicalValue>): void {
    const at = Math.round((this.sim.now + LIVE_EPSILON_MS) * 1000) / 1000;
    for (const events of this.checkpoints.keys()) {
      if (events > this.sim.eventCount) this.checkpoints.delete(events);
    }
    this.trace.length = this.sim.lastRecordId + 1;
    this.sim.schedule(at, action);
    this.actions.push(JSON.parse(canonicalJson({ atMs: at, action })) as ScenarioAction);
    this.sim.runUntil(at);
  }

  /** Jumps to `timeMs`: every event at or before it processed, none after. */
  seek(timeMs: number): void {
    const target = Math.max(0, timeMs);
    this.travel(
      (cp) => cp.t <= target,
      () => target < this.sim.now,
    );
    this.sim.runUntil(target);
    this.jumpPending = true;
  }

  /** Jumps to just after the step that emitted record `id`. */
  seekRecord(id: number): void {
    this.travel(
      (cp) => cp.recordId < id,
      () => this.sim.lastRecordId >= id,
    );
    while (this.sim.lastRecordId < id && this.sim.step());
    this.jumpPending = true;
  }

  /** Jumps to just after the `events`-th event. */
  seekEvent(events: number): void {
    this.travel(
      (cp) => cp.events <= events,
      () => this.sim.eventCount > events,
    );
    while (this.sim.eventCount < events && this.sim.step());
    this.jumpPending = true;
  }

  /**
   * Restores the latest checkpoint that `usable` accepts, if the current state is past the
   * target (`mustRewind`) or that checkpoint is ahead of the current state.
   */
  private travel(usable: (cp: Checkpoint) => boolean, mustRewind: () => boolean): void {
    let best: Checkpoint | undefined;
    for (const cp of this.checkpoints.values()) {
      if (usable(cp) && (best === undefined || cp.events > best.events)) best = cp;
    }
    if (best === undefined) throw new Error("no checkpoint at the start of the run");
    if (!mustRewind() && best.events <= this.sim.eventCount) return;
    loadCheckpoint(this.sim, this.monitor, best);
    // Live actions added after the checkpoint was taken.
    this.sim.setActions(this.actions);
    this.lastStepEnd = best.recordId;
    this.stepStart = best.recordId + 1;
    const cut =
      this.sentRecords > best.recordId + 1 || this.sentViolations > this.monitor.violations.length;
    if (cut) {
      this.sentRecords = Math.min(this.sentRecords, best.recordId + 1);
      this.sentViolations = Math.min(this.sentViolations, this.monitor.violations.length);
      this.truncatePending = Math.min(this.truncatePending ?? Infinity, this.sentRecords - 1);
    }
  }

  /** Everything that changed since the previous frame. */
  frame(): Frame {
    const reset = this.resetPending;
    const truncateAfter = reset ? null : this.truncatePending;
    const end = this.sim.lastRecordId + 1;
    const records = this.trace.slice(this.sentRecords, end);
    this.sentRecords = end;
    const violations = this.monitor.violations.slice(
      reset || truncateAfter !== null ? 0 : this.sentViolations,
    );
    this.sentViolations = this.monitor.violations.length;
    const jumped = this.jumpPending;
    this.resetPending = false;
    this.truncatePending = null;
    this.jumpPending = false;
    const ids = [...this.sim.nodeIds, ...this.sim.clientIds];
    return {
      now: this.sim.now,
      reset,
      truncateAfter,
      jumped,
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
    this.trace = [];
    this.sentRecords = 0;
    this.sentViolations = 0;
    this.resetPending = true;
    this.truncatePending = null;
    this.jumpPending = true;
    const { sim, monitor } = entry.build(scenario, {
      sinks: [
        (r) => {
          // A replay re-emits records of the known timeline.
          this.trace[r.id] = r;
          for (const w of this.watchers) w(r);
        },
      ],
    });
    this.sim = sim;
    this.monitor = monitor;
    this.lastStepEnd = sim.lastRecordId;
    this.stepStart = 0;
    this.checkpoints = new Map();
    this.spacing = this.policy.every;
    this.checkpoint();
    // Registered after the monitor's listener, so checkpoints include this step's checks.
    sim.onStep(() => {
      this.stepStart = this.lastStepEnd + 1;
      this.lastStepEnd = sim.lastRecordId;
      if (sim.eventCount % this.spacing === 0) this.checkpoint();
    });
  }

  private checkpoint(): void {
    const events = this.sim.eventCount;
    if (this.checkpoints.has(events)) return;
    this.checkpoints.set(events, saveCheckpoint(this.sim, this.monitor));
    if (this.checkpoints.size <= this.policy.max) return;
    this.spacing *= 2;
    for (const e of this.checkpoints.keys()) {
      if (e % this.spacing !== 0) this.checkpoints.delete(e);
    }
  }
}

function isNotable(r: TraceRecord): boolean {
  return r.type === "annotate" && NOTABLE_LABELS.has(r.label);
}

export type { ScheduledAction };
