import { canonicalJson, type CanonicalValue } from "./canonical.ts";
import { EventQueue } from "./eventQueue.ts";
import type { Network } from "./network.ts";
import type { NodeContext, NodeId, NodeState, Protocol } from "./protocol.ts";
import { Rng } from "./rng.ts";
import type { DropReason, TraceRecord, TraceSink } from "./trace.ts";

export type Action<C, N> =
  | { readonly type: "crash"; readonly node: NodeId }
  | { readonly type: "recover"; readonly node: NodeId }
  | { readonly type: "client"; readonly node: NodeId; readonly command: C }
  | { readonly type: "network"; readonly change: N };

export interface ScheduledAction<C, N> {
  readonly atMs: number;
  readonly action: Action<C, N>;
}

export interface SimulationOptions<P, V, M, C, N> {
  readonly protocol: Protocol<P, V, M, C>;
  readonly nodes: readonly NodeId[];
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

interface NodeRuntime<P, V> {
  readonly id: NodeId;
  readonly peers: readonly NodeId[];
  readonly rng: Rng;
  up: boolean;
  /** Bumped on every crash; identifies which process a timer belongs to. */
  incarnation: number;
  state: NodeState<P, V>;
  /** Armed timers: key -> timerId of the firing that is still valid. */
  readonly timers: Map<string, number>;
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
 * Deterministic discrete-event simulation of a cluster running one protocol.
 *
 * Given the same options, a simulation emits the same trace. Nodes share no memory: messages
 * and client commands are serialized on the way in.
 */
export class Simulation<P, V, M, C = never, N = never> {
  private readonly protocol: Protocol<P, V, M, C>;
  private readonly network: Network<N>;
  private readonly netRng: Rng;
  private readonly queue = new EventQueue<Pending<C, N>>();
  private readonly runtimes = new Map<NodeId, NodeRuntime<P, V>>();
  private readonly sinks: TraceSink[];
  private readonly actionLog: ScheduledAction<C, N>[] = [];
  private readonly seed: number;
  private clock = 0;
  private nextRecordId = 0;
  private nextTimerId = 0;
  private processed = 0;

  constructor(options: SimulationOptions<P, V, M, C, N>) {
    const ids = options.nodes;
    if (ids.length === 0) throw new Error("a simulation needs at least one node");
    if (new Set(ids).size !== ids.length) throw new Error(`duplicate node ids: ${ids.join(",")}`);
    this.protocol = options.protocol;
    this.network = options.network;
    this.seed = options.seed;
    this.sinks = [...(options.sinks ?? [])];
    const root = Rng.fromSeed(options.seed);
    this.netRng = root.stream("net");

    for (const id of ids) {
      const runtime: NodeRuntime<P, V> = {
        id,
        peers: ids.filter((other) => other !== id),
        rng: root.stream(`node:${id}`),
        up: true,
        incarnation: 0,
        // Filled in by init below.
        state: undefined as unknown as NodeState<P, V>,
        timers: new Map(),
      };
      this.runtimes.set(id, runtime);
    }
    for (const a of options.actions ?? []) this.schedule(a.atMs, a.action);
    for (const runtime of this.runtimes.values()) {
      const cause = this.emit({ type: "init", t: 0, cause: null, node: runtime.id });
      this.invoke(runtime, cause, (ctx) => {
        runtime.state = this.protocol.init(ctx);
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

  get nodeIds(): readonly NodeId[] {
    return [...this.runtimes.keys()];
  }

  /** True when no further events are scheduled. */
  get idle(): boolean {
    return this.queue.size === 0;
  }

  addSink(sink: TraceSink): void {
    this.sinks.push(sink);
  }

  isUp(node: NodeId): boolean {
    return this.runtime(node).up;
  }

  /** Protocol view of a node (crashed nodes report their durable state's view). */
  view(node: NodeId): CanonicalValue {
    return this.protocol.view(this.runtime(node).state);
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
    this.queue.push(atMs, { kind: "action", action: stored });
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

  private runtime(node: NodeId): NodeRuntime<P, V> {
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
          r.state = this.protocol.recover(ctx, persistent);
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
          this.protocol.onClientCommand(ctx, r.state, JSON.parse(canonicalJson(command)) as C);
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
      this.protocol.onMessage(ctx, r.state, from, JSON.parse(wire) as M);
    });
  }

  private fireTimer(node: NodeId, key: string, timerId: number, cause: number): void {
    const r = this.runtime(node);
    // Stale: cancelled, re-armed, or armed by a process that has since crashed.
    if (!r.up || r.timers.get(key) !== timerId) return;
    r.timers.delete(key);
    const id = this.emit({ type: "timer", t: this.clock, cause, node, key });
    this.invoke(r, id, (ctx) => {
      this.protocol.onTimer(ctx, r.state, key);
    });
  }

  /** Runs one protocol callback, then applies its buffered effects in request order. */
  private invoke(r: NodeRuntime<P, V>, cause: number, body: (ctx: NodeContext<M>) => void): void {
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
          const send = this.emit({
            type: "send",
            t,
            cause,
            from: r.id,
            to: e.to,
            message: JSON.parse(wire) as CanonicalValue,
            copies: delays.length,
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
          for (const d of delays) {
            if (!Number.isFinite(d) || d < 0) throw new RangeError(`network returned delay ${d}`);
            this.queue.push(t + d, { kind: "deliver", from: r.id, to: e.to, wire, send });
          }
          break;
        }
        case "setTimer": {
          const timerId = this.nextTimerId++;
          r.timers.set(e.key, timerId);
          this.queue.push(t + e.delayMs, { kind: "timer", node: r.id, key: e.key, timerId, cause });
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
