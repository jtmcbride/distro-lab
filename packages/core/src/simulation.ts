import { canonicalJson, type CanonicalValue } from "./canonical.ts";
import { EventQueue } from "./eventQueue.ts";
import type { Observable } from "./invariants.ts";
import type { Network } from "./network.ts";
import type { NodeContext, NodeId, NodeState, Protocol } from "./protocol.ts";
import { Rng } from "./rng.ts";
import type { DropReason, TraceRecord, TraceSink } from "./trace.ts";

export type Action<C, N> =
  | { readonly type: "crash"; readonly node: NodeId }
  | { readonly type: "recover"; readonly node: NodeId }
  | { readonly type: "client"; readonly node: NodeId; readonly command: C }
  /**
   * Fires `node`'s timer `key` now (cancelling its pending firing), e.g. to force an
   * election. Ignored if the node is down. Used to script exact scenarios.
   */
  | { readonly type: "timeout"; readonly node: NodeId; readonly key: string }
  | { readonly type: "network"; readonly change: N };

export interface ScheduledAction<C, N> {
  readonly atMs: number;
  readonly action: Action<C, N>;
}

export interface SimulationOptions<P, V, M, C, N, CP = never, CV = never> {
  /** Protocol run by every server. */
  readonly protocol: Protocol<P, V, M, C>;
  /** Server ids. Servers' `ctx.peers` are the other servers. */
  readonly nodes: readonly NodeId[];
  /**
   * Optional client processes. They are full simulated processes (network links, timers,
   * crashes) running their own protocol over the same message type; their `ctx.peers` are
   * the servers. Client commands are usually addressed to them.
   */
  readonly clients?: {
    readonly ids: readonly NodeId[];
    readonly protocol: Protocol<CP, CV, M, C>;
  };
  readonly seed: number;
  readonly network: Network<N>;
  readonly actions?: readonly ScheduledAction<C, N>[];
  readonly sinks?: readonly TraceSink[];
}

type Pending<C, N> =
  | { readonly kind: "action"; readonly action: Action<C, N> }
  | {
      readonly kind: "deliver";
      readonly from: NodeId;
      readonly to: NodeId;
      /** Serialized message; parsed per delivery so copies never share memory. */
      readonly wire: string;
      readonly send: number;
    }
  | {
      readonly kind: "timer";
      readonly node: NodeId;
      readonly key: string;
      readonly timerId: number;
      readonly cause: number;
    };

export type ProcessRole = "server" | "client";

interface NodeRuntime<M, C> {
  readonly id: NodeId;
  readonly role: ProcessRole;
  // State types differ between servers and clients, so the engine treats them opaquely.
  readonly protocol: Protocol<unknown, unknown, M, C>;
  readonly peers: readonly NodeId[];
  readonly rng: Rng;
  up: boolean;
  /** Bumped on every crash; identifies which process a timer belongs to. */
  incarnation: number;
  state: NodeState<unknown, unknown>;
  /** Armed timers: key -> the firing that is still valid. */
  readonly timers: Map<string, { readonly id: number; readonly at: number }>;
}

type Effect<M> =
  | { readonly kind: "send"; readonly to: NodeId; readonly message: M }
  | { readonly kind: "setTimer"; readonly key: string; readonly delayMs: number }
  | { readonly kind: "cancelTimer"; readonly key: string }
  | {
      readonly kind: "annotate";
      readonly label: string;
      readonly data: CanonicalValue | undefined;
    };

/** Distributes a record to sinks; the type param keeps call sites honest. */
type Emit = (record: DistributiveOmit<TraceRecord, "id">) => number;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Queue priorities at equal times: scenario actions run before protocol events. A replay
 * queues every action up front while a live run adds them later, so without this the two
 * would order an action differently relative to protocol events at the same instant.
 */
const ACTION = 0;
const PROTOCOL = 1;

/** `now + delay`, rounded to microseconds so float noise never leaks into traces. */
function at(now: number, delayMs: number): number {
  return Math.round((now + delayMs) * 1000) / 1000;
}

/** What harnesses (chaos runner, CLI, UI) need from a simulation, independent of protocol. */
export interface RunnableSimulation extends Observable {
  readonly eventCount: number;
  readonly clientIds: readonly NodeId[];
  readonly nextEventTime: number | undefined;
  roleOf(id: NodeId): ProcessRole;
  timers(node: NodeId): { key: string; at: number }[];
  networkView(): CanonicalValue | null;
  step(): boolean;
  runUntil(timeMs: number): void;
  // Harnesses handle actions as plain JSON whose command/change types depend on the
  // protocol, which this protocol-agnostic interface cannot name.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  schedule(atMs: number, action: Action<any, any>): void;
  actions(): readonly ScheduledAction<any, any>[];
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Deterministic discrete-event simulation of a cluster of servers (and optionally clients).
 *
 * Given the same options, a simulation emits the same trace. Processes share no memory:
 * messages and client commands are serialized on the way in.
 */
export class Simulation<
  P,
  V,
  M,
  C = never,
  N = never,
  CP = never,
  CV = never,
> implements RunnableSimulation {
  private readonly network: Network<N>;
  private readonly netRng: Rng;
  private readonly queue = new EventQueue<Pending<C, N>>();
  private readonly runtimes = new Map<NodeId, NodeRuntime<M, C>>();
  private readonly sinks: TraceSink[];
  private readonly stepListeners: (() => void)[] = [];
  private readonly actionLog: ScheduledAction<C, N>[] = [];
  private readonly seed: number;
  private clock = 0;
  private nextRecordId = 0;
  private nextTimerId = 0;
  private processed = 0;

  constructor(options: SimulationOptions<P, V, M, C, N, CP, CV>) {
    const ids = options.nodes;
    const clientIds = options.clients?.ids ?? [];
    if (ids.length === 0) throw new Error("a simulation needs at least one node");
    const all = [...ids, ...clientIds];
    if (new Set(all).size !== all.length)
      throw new Error(`duplicate process ids: ${all.join(",")}`);
    this.network = options.network;
    this.seed = options.seed;
    this.sinks = [...(options.sinks ?? [])];
    const root = Rng.fromSeed(options.seed);
    this.netRng = root.stream("net");

    const add = (
      id: NodeId,
      role: ProcessRole,
      protocol: Protocol<unknown, unknown, M, C>,
      peers: readonly NodeId[],
    ) => {
      this.runtimes.set(id, {
        id,
        role,
        protocol,
        peers,
        rng: root.stream(`node:${id}`),
        up: true,
        incarnation: 0,
        // Filled in by init below.
        state: undefined as unknown as NodeState<unknown, unknown>,
        timers: new Map(),
      });
    };
    for (const id of ids) {
      add(
        id,
        "server",
        options.protocol as Protocol<unknown, unknown, M, C>,
        ids.filter((o) => o !== id),
      );
    }
    if (options.clients !== undefined) {
      const clientProtocol = options.clients.protocol as Protocol<unknown, unknown, M, C>;
      for (const id of clientIds) add(id, "client", clientProtocol, ids);
    }
    for (const a of options.actions ?? []) this.schedule(a.atMs, a.action);
    for (const runtime of this.runtimes.values()) {
      const cause = this.emit({ type: "init", t: 0, cause: null, node: runtime.id });
      this.invoke(runtime, cause, (ctx) => {
        runtime.state = runtime.protocol.init(ctx);
      });
    }
  }

  get now(): number {
    return this.clock;
  }

  /** Number of queue events processed so far. */
  get eventCount(): number {
    return this.processed;
  }

  /** Server ids, in configuration order. */
  get nodeIds(): readonly NodeId[] {
    return this.idsWithRole("server");
  }

  /** Client process ids, in configuration order. */
  get clientIds(): readonly NodeId[] {
    return this.idsWithRole("client");
  }

  roleOf(id: NodeId): ProcessRole {
    return this.runtime(id).role;
  }

  private idsWithRole(role: ProcessRole): NodeId[] {
    return [...this.runtimes.values()].filter((r) => r.role === role).map((r) => r.id);
  }

  /** True when no further events are scheduled. */
  get idle(): boolean {
    return this.queue.size === 0;
  }

  addSink(sink: TraceSink): void {
    this.sinks.push(sink);
  }

  /**
   * Called after every processed event, once all of its effects are applied. This is the
   * only point where cluster state is between atomic steps, so invariants belong here.
   */
  onStep(listener: () => void): void {
    this.stepListeners.push(listener);
  }

  /** Id of the most recent trace record, or -1 before any. */
  get lastRecordId(): number {
    return this.nextRecordId - 1;
  }

  isUp(node: NodeId): boolean {
    return this.runtime(node).up;
  }

  incarnation(node: NodeId): number {
    return this.runtime(node).incarnation;
  }

  /** Armed timers of a process and when they fire (empty while it is down). */
  timers(node: NodeId): { key: string; at: number }[] {
    return [...this.runtime(node).timers].map(([key, t]) => ({ key, at: t.at }));
  }

  /** The network's own description of its state, if it provides one. */
  networkView(): CanonicalValue | null {
    return this.network.view?.() ?? null;
  }

  /** Time of the next scheduled event, if any. */
  get nextEventTime(): number | undefined {
    return this.queue.peek()?.timeMs;
  }

  /** Protocol view of a process (crashed ones report their last state's view). */
  view(node: NodeId): CanonicalValue {
    const r = this.runtime(node);
    return r.protocol.view(r.state);
  }

  /** Schedules an external action. It becomes part of the scenario, so replays include it. */
  schedule(atMs: number, action: Action<C, N>): void {
    if (!Number.isFinite(atMs) || atMs < this.clock) {
      throw new RangeError(`cannot schedule at ${atMs}ms (now ${this.clock}ms)`);
    }
    if (action.type !== "network") this.runtime(action.node);
    // Round-trip through canonical JSON so the logged action is plain data and the caller
    // cannot mutate it later.
    const stored = JSON.parse(canonicalJson(action)) as Action<C, N>;
    this.actionLog.push({ atMs, action: stored });
    this.queue.push(atMs, { kind: "action", action: stored }, ACTION);
  }

  /** Everything needed to replay this run with the same protocol and network setup. */
  actions(): readonly ScheduledAction<C, N>[] {
    return this.actionLog;
  }

  get seedValue(): number {
    return this.seed;
  }

  /** Processes the next event. Returns false when there is nothing left to do. */
  step(): boolean {
    const next = this.queue.pop();
    if (next === undefined) return false;
    this.clock = next.timeMs;
    this.processed++;
    const ev = next.item;
    switch (ev.kind) {
      case "action":
        this.runAction(ev.action);
        break;
      case "deliver":
        this.deliver(ev.from, ev.to, ev.wire, ev.send);
        break;
      case "timer":
        this.fireTimer(ev.node, ev.key, ev.timerId, ev.cause);
        break;
    }
    for (const listener of this.stepListeners) listener();
    return true;
  }

  /** Processes every event scheduled at or before `timeMs`, then advances the clock to it. */
  runUntil(timeMs: number): void {
    for (let next = this.queue.peek(); next && next.timeMs <= timeMs; next = this.queue.peek()) {
      this.step();
    }
    this.clock = Math.max(this.clock, timeMs);
  }

  /** Processes up to `count` events. Returns how many were processed. */
  runSteps(count: number): number {
    let n = 0;
    while (n < count && this.step()) n++;
    return n;
  }

  private runtime(node: NodeId): NodeRuntime<M, C> {
    const r = this.runtimes.get(node);
    if (r === undefined) throw new Error(`unknown node ${node}`);
    return r;
  }

  private emit: Emit = (partial) => {
    const record = { id: this.nextRecordId++, ...partial } as TraceRecord;
    for (const sink of this.sinks) sink(record);
    return record.id;
  };

  private runAction(action: Action<C, N>): void {
    const t = this.clock;
    switch (action.type) {
      case "crash": {
        const r = this.runtime(action.node);
        if (!r.up) return;
        r.up = false;
        r.incarnation++;
        r.timers.clear();
        this.emit({ type: "crash", t, cause: null, node: r.id });
        return;
      }
      case "recover": {
        const r = this.runtime(action.node);
        if (r.up) return;
        r.up = true;
        const cause = this.emit({ type: "recover", t, cause: null, node: r.id });
        const persistent = r.state.persistent;
        this.invoke(r, cause, (ctx) => {
          r.state = r.protocol.recover(ctx, persistent);
        });
        return;
      }
      case "client": {
        const r = this.runtime(action.node);
        const command = action.command as CanonicalValue;
        const cause = this.emit({ type: "client", t, cause: null, node: r.id, command });
        // A command sent to a crashed node is lost, like a request to a dead server.
        if (!r.up) return;
        this.invoke(r, cause, (ctx) => {
          r.protocol.onClientCommand(ctx, r.state, JSON.parse(canonicalJson(command)) as C);
        });
        return;
      }
      case "timeout": {
        const r = this.runtime(action.node);
        if (!r.up) return;
        r.timers.delete(action.key);
        const cause = this.emit({ type: "timer", t, cause: null, node: r.id, key: action.key });
        this.invoke(r, cause, (ctx) => {
          r.protocol.onTimer(ctx, r.state, action.key);
        });
        return;
      }
      case "network":
        this.emit({ type: "network", t, cause: null, change: action.change as CanonicalValue });
        this.network.apply(action.change);
        return;
    }
  }

  private deliver(from: NodeId, to: NodeId, wire: string, send: number): void {
    const t = this.clock;
    const r = this.runtime(to);
    let reason: DropReason | undefined;
    if (!this.network.canDeliver(from, to, t)) reason = "link-down";
    else if (!r.up) reason = "node-down";
    if (reason !== undefined) {
      this.emit({ type: "drop", t, cause: send, from, to, send, reason });
      return;
    }
    const cause = this.emit({ type: "deliver", t, cause: send, from, to, send });
    this.invoke(r, cause, (ctx) => {
      r.protocol.onMessage(ctx, r.state, from, JSON.parse(wire) as M);
    });
  }

  private fireTimer(node: NodeId, key: string, timerId: number, cause: number): void {
    const r = this.runtime(node);
    // Stale: cancelled, re-armed, or armed by a process that has since crashed.
    if (!r.up || r.timers.get(key)?.id !== timerId) return;
    r.timers.delete(key);
    const id = this.emit({ type: "timer", t: this.clock, cause, node, key });
    this.invoke(r, id, (ctx) => {
      r.protocol.onTimer(ctx, r.state, key);
    });
  }

  /** Runs one protocol callback, then applies its buffered effects in request order. */
  private invoke(r: NodeRuntime<M, C>, cause: number, body: (ctx: NodeContext<M>) => void): void {
    const effects: Effect<M>[] = [];
    const clock = () => this.clock;
    const checkNode = (id: NodeId) => this.runtime(id);
    const ctx: NodeContext<M> = {
      nodeId: r.id,
      peers: r.peers,
      get now() {
        return clock();
      },
      rng: r.rng,
      send(to, message) {
        checkNode(to);
        if (to === r.id) throw new Error(`${r.id} cannot send to itself`);
        effects.push({ kind: "send", to, message });
      },
      setTimer(key, delayMs) {
        if (!Number.isFinite(delayMs) || delayMs < 0) {
          throw new RangeError(`invalid timer delay ${delayMs} for ${r.id}:${key}`);
        }
        effects.push({ kind: "setTimer", key, delayMs });
      },
      cancelTimer(key) {
        effects.push({ kind: "cancelTimer", key });
      },
      annotate(label, data) {
        effects.push({ kind: "annotate", label, data });
      },
    };
    body(ctx);

    const t = this.clock;
    for (const e of effects) {
      switch (e.kind) {
        case "send": {
          const wire = canonicalJson(e.message);
          const outcome = this.network.onSend(r.id, e.to, t, this.netRng);
          const delays = "delays" in outcome ? outcome.delays : [];
          for (const d of delays) {
            if (!Number.isFinite(d) || d < 0) throw new RangeError(`network returned delay ${d}`);
          }
          const arrivals = delays.map((d) => at(t, d));
          const send = this.emit({
            type: "send",
            t,
            cause,
            from: r.id,
            to: e.to,
            message: JSON.parse(wire) as CanonicalValue,
            copies: delays.length,
            arrivals,
          });
          if ("dropped" in outcome) {
            this.emit({
              type: "drop",
              t,
              cause: send,
              from: r.id,
              to: e.to,
              send,
              reason: outcome.dropped,
            });
          }
          for (const arrival of arrivals) {
            this.queue.push(
              arrival,
              { kind: "deliver", from: r.id, to: e.to, wire, send },
              PROTOCOL,
            );
          }
          break;
        }
        case "setTimer": {
          const timerId = this.nextTimerId++;
          r.timers.set(e.key, { id: timerId, at: at(t, e.delayMs) });
          this.queue.push(
            at(t, e.delayMs),
            { kind: "timer", node: r.id, key: e.key, timerId, cause },
            PROTOCOL,
          );
          break;
        }
        case "cancelTimer":
          r.timers.delete(e.key);
          break;
        case "annotate":
          this.emit(
            e.data === undefined
              ? { type: "annotate", t, cause, node: r.id, label: e.label }
              : { type: "annotate", t, cause, node: r.id, label: e.label, data: e.data },
          );
          break;
      }
    }
  }
}
