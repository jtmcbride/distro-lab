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
  /** All branches, when they changed since the previous frame (else null). */
  readonly branches: readonly BranchInfo[] | null;
  /** The current branch's id. */
  readonly branch: number;
  /** The current branch's actions, when they changed since the previous frame (else null). */
  readonly actions: readonly ScenarioAction[] | null;
}

export type ScenarioAction = Scenario["actions"][number];

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

/** A branch of the session: a scenario variant sharing history with its parent. */
export interface BranchInfo {
  readonly id: number;
  readonly name: string;
  /** Branch it was forked from (null for the original). */
  readonly parent: number | null;
  /** Where it was forked: virtual time and the last record shared with the parent. */
  readonly forkT: number;
  readonly forkRecord: number;
  readonly actions: readonly ScenarioAction[];
}

interface Timeline {
  readonly id: number;
  name: string;
  readonly parent: number | null;
  readonly forkT: number;
  readonly forkRecord: number;
  /** The scenario's actions including live ones and edits, in the order they were added. */
  actions: ScenarioAction[];
  /**
   * Records of this timeline by id, including any beyond the current position (after going
   * back) until the future changes.
   */
  trace: TraceRecord[];
  /** Checkpoints by event count; ones from before a fork are shared with the parent. */
  checkpoints: Map<number, Checkpoint>;
  spacing: number;
}

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
  private sim!: RunnableSimulation;
  private monitor!: InvariantMonitor<unknown>;
  private timelines = new Map<number, Timeline>();
  private nextTimeline = 0;
  /** The branch being run. */
  private tl!: Timeline;
  /** Id of the first record emitted by the most recent step. */
  private stepStart = 0;
  private lastStepEnd = -1;
  // What the UI has been sent.
  private sentRecords = 0;
  private sentViolations = 0;
  private resetPending = true;
  private truncatePending: number | null = null;
  private jumpPending = true;
  /** The branch list or current branch's actions changed since the last frame. */
  private branchesDirty = true;
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

  /** Replaces the simulation (and all branches); the next frame resets the UI. */
  load(scenario: Scenario): void {
    this.base = scenario;
    this.timelines = new Map();
    this.tl = this.newTimeline({
      name: "main",
      parent: null,
      forkT: 0,
      forkRecord: -1,
      actions: scenario.actions.map((a) => JSON.parse(canonicalJson(a)) as ScenarioAction),
      trace: [],
      checkpoints: new Map(),
      spacing: this.policy.every,
    });
    this.rebuild(scenario);
    this.playing = false;
  }

  private newTimeline(t: Omit<Timeline, "id">): Timeline {
    this.branchesDirty = true;
    const timeline = { id: this.nextTimeline++, ...t };
    this.timelines.set(timeline.id, timeline);
    return timeline;
  }

  /** All branches, oldest first. */
  branches(): BranchInfo[] {
    return [...this.timelines.values()].map((t) => ({
      id: t.id,
      name: t.name,
      parent: t.parent,
      forkT: t.forkT,
      forkRecord: t.forkRecord,
      actions: t.actions,
    }));
  }

  /** The branch being run. */
  get branch(): number {
    return this.tl.id;
  }

  /**
   * Starts a new branch at the current position, identical to the current one until its
   * actions are edited, and switches to it.
   */
  fork(name?: string): number {
    const at = this.sim.eventCount;
    const parent = this.tl;
    const checkpoints = new Map([...parent.checkpoints].filter(([events]) => events <= at));
    this.tl = this.newTimeline({
      name: name ?? `branch ${this.nextTimeline}`,
      parent: parent.id,
      forkT: this.sim.now,
      forkRecord: this.sim.lastRecordId,
      actions: [...parent.actions],
      trace: parent.trace.slice(0, this.sim.lastRecordId + 1),
      checkpoints,
      spacing: parent.spacing,
    });
    return this.tl.id;
  }

  renameBranch(id: number, name: string): void {
    this.timeline(id).name = name;
    this.branchesDirty = true;
  }

  /** Removes a branch other than the current one (its own branches keep their history). */
  deleteBranch(id: number): void {
    if (id === this.tl.id) throw new Error("cannot delete the current branch");
    this.timeline(id);
    this.timelines.delete(id);
    this.branchesDirty = true;
  }

  /**
   * Switches to another branch at the same virtual time. The UI keeps the records both
   * branches share.
   */
  switchBranch(id: number): void {
    const target = this.timeline(id);
    if (target === this.tl) return;
    const from = this.tl;
    const now = this.sim.now;
    let shared = 0;
    const limit = Math.min(from.trace.length, target.trace.length);
    while (shared < limit && from.trace[shared] === target.trace[shared]) shared++;
    this.tl = target;
    this.branchesDirty = true;
    this.travel(
      (cp) => cp.t <= now,
      () => true,
    );
    this.sim.runUntil(now);
    this.cutSent(shared, true);
    this.jumpPending = true;
  }

  /**
   * Replaces the current branch's actions that have not run yet, e.g. to remove a crash
   * or add a partition. Actions that already ran must be kept; added or changed ones must
   * be later than now. The branch's future is recomputed.
   */
  editActions(actions: readonly ScenarioAction[]): void {
    const normalized = actions.map((a) => JSON.parse(canonicalJson(a)) as ScenarioAction);
    const before = new Map<string, number>();
    for (const a of this.tl.actions) {
      const k = canonicalJson(a);
      before.set(k, (before.get(k) ?? 0) + 1);
    }
    for (const a of normalized) {
      const k = canonicalJson(a);
      const n = before.get(k) ?? 0;
      if (n > 0) before.set(k, n - 1);
      else if (!(a.atMs > this.sim.now)) {
        throw new RangeError(`a new action must be after now (${this.sim.now}ms): ${k}`);
      }
    }
    // Throws if an action that already ran is missing.
    this.sim.setActions(normalized);
    this.tl.actions = normalized;
    this.branchesDirty = true;
    this.forgetFuture();
  }

  private timeline(id: number): Timeline {
    const t = this.timelines.get(id);
    if (t === undefined) throw new Error(`no branch ${id}`);
    return t;
  }

  /** Drops what was known about the current branch after the current position. */
  private forgetFuture(): void {
    for (const events of this.tl.checkpoints.keys()) {
      if (events > this.sim.eventCount) this.tl.checkpoints.delete(events);
    }
    this.tl.trace.length = this.sim.lastRecordId + 1;
    this.cutSent(this.tl.trace.length, true);
  }

  get now(): number {
    return this.sim.now;
  }

  /** Events processed so far in the current run. */
  get events(): number {
    return this.sim.eventCount;
  }

  /** Number of checkpoints held by the current branch (for tests and diagnostics). */
  get checkpointCount(): number {
    return this.tl.checkpoints.size;
  }

  /** The scenario as it stands, including live actions; replays to the same trace. */
  scenario(): Scenario {
    return {
      ...this.base,
      actions: [...this.tl.actions],
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
      const r = this.tl.trace[i]!;
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
    this.forgetFuture();
    this.sim.schedule(at, action);
    this.branchesDirty = true;
    this.tl.actions.push(JSON.parse(canonicalJson({ atMs: at, action })) as ScenarioAction);
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
    for (const cp of this.tl.checkpoints.values()) {
      if (usable(cp) && (best === undefined || cp.events > best.events)) best = cp;
    }
    if (best === undefined) throw new Error("no checkpoint at the start of the run");
    if (!mustRewind() && best.events <= this.sim.eventCount) return;
    loadCheckpoint(this.sim, this.monitor, best);
    // Live actions or edits made after the checkpoint was taken.
    this.sim.setActions(this.tl.actions);
    this.lastStepEnd = best.recordId;
    this.stepStart = best.recordId + 1;
  }

  /**
   * Notes that the UI's records from index `keep` on (and possibly its violations) are no
   * longer valid, so the next frame truncates them.
   */
  private cutSent(keep: number, violationsChanged: boolean): void {
    if (this.sentRecords <= keep && !violationsChanged) return;
    this.sentRecords = Math.min(this.sentRecords, keep);
    this.sentViolations = 0;
    this.truncatePending = Math.min(this.truncatePending ?? Infinity, this.sentRecords - 1);
  }

  /** Everything that changed since the previous frame. */
  frame(): Frame {
    const reset = this.resetPending;
    const end = this.sim.lastRecordId + 1;
    // Went back in time (records of the same timeline are identical, so a seek that ends
    // up ahead again needs no truncation).
    if (this.sentRecords > end || this.sentViolations > this.monitor.violations.length) {
      this.cutSent(end, true);
    }
    const truncateAfter = reset ? null : this.truncatePending;
    const records = this.tl.trace.slice(this.sentRecords, end);
    this.sentRecords = end;
    const violations = this.monitor.violations.slice(
      reset || truncateAfter !== null ? 0 : this.sentViolations,
    );
    this.sentViolations = this.monitor.violations.length;
    const jumped = this.jumpPending;
    const branchesChanged = this.branchesDirty;
    this.branchesDirty = false;
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
      branches: branchesChanged ? this.branches() : null,
      branch: this.tl.id,
      actions: branchesChanged ? [...this.tl.actions] : null,
    };
  }

  private rebuild(scenario: Scenario): void {
    const entry = this.registry.get(scenario.protocol);
    if (entry === undefined) throw new Error(`unknown protocol "${scenario.protocol}"`);
    this.sentRecords = 0;
    this.sentViolations = 0;
    this.resetPending = true;
    this.truncatePending = null;
    this.jumpPending = true;
    const { sim, monitor } = entry.build(scenario, {
      sinks: [
        (r) => {
          // A replay re-emits records of the known timeline; keeping the originals lets
          // branches recognize the records they share.
          if (r.id >= this.tl.trace.length) this.tl.trace.push(r);
          for (const w of this.watchers) w(r);
        },
      ],
    });
    this.sim = sim;
    this.monitor = monitor;
    this.lastStepEnd = sim.lastRecordId;
    this.stepStart = 0;
    this.checkpoint();
    // Registered after the monitor's listener, so checkpoints include this step's checks.
    sim.onStep(() => {
      this.stepStart = this.lastStepEnd + 1;
      this.lastStepEnd = sim.lastRecordId;
      if (sim.eventCount % this.tl.spacing === 0) this.checkpoint();
    });
  }

  private checkpoint(): void {
    const { checkpoints } = this.tl;
    const events = this.sim.eventCount;
    if (checkpoints.has(events)) return;
    checkpoints.set(events, saveCheckpoint(this.sim, this.monitor));
    if (checkpoints.size <= this.policy.max) return;
    this.tl.spacing *= 2;
    for (const e of checkpoints.keys()) {
      if (e % this.tl.spacing !== 0) checkpoints.delete(e);
    }
  }
}

function isNotable(r: TraceRecord): boolean {
  return r.type === "annotate" && NOTABLE_LABELS.has(r.label);
}

export type { ScheduledAction };
