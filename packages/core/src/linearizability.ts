import { canonicalJson, type CanonicalValue } from "./canonical.ts";
import type { Invariant } from "./invariants.ts";

/**
 * A sequential specification. `step` is deterministic and must not mutate `state`.
 * Operations in different partitions never affect each other (e.g. keys of a KV store), so
 * each partition is checked on its own.
 */
export interface Model<State extends CanonicalValue, Input, Output extends CanonicalValue> {
  init(): State;
  step(state: State, input: Input): { readonly state: State; readonly output: Output };
  partition(input: Input): string;
}

/**
 * One way the history so far can have been linearized: the model state after it, and the
 * pending operations it already includes, with the output each returned there.
 */
interface Config<State> {
  readonly state: State;
  /** Pending operation id -> canonical JSON of its output at its linearization point. */
  readonly lin: Readonly<Record<string, string>>;
}

interface Partition<State, Input> {
  /** Every configuration the history so far can be in (not closed under pending ops). */
  configs: Config<State>[];
  /** Invoked, not completed. */
  pending: Map<string, Input>;
}

export interface LinearizabilityFailure<Input, Output> {
  readonly id: string;
  readonly partition: string;
  readonly input: Input;
  readonly output: Output;
  /** Every output the operation could have returned (sorted by canonical JSON). */
  readonly possible: readonly Output[];
}

export interface LinearizabilityState {
  readonly partitions: Map<string, unknown>;
  readonly partitionOf: Map<string, string>;
}

/**
 * Checks a history online, one `invoke`/`complete` at a time, and reports the first
 * completion that no linearization of the history so far can explain.
 *
 * It keeps the set of configurations that all linearizations of the history so far can end
 * in (just-in-time linearization, as in Lowe 2017). This is exact: an operation that has
 * completed must be linearized before anything invoked later, so only pending operations
 * are still undecided, and a configuration records which of them it has linearized and what
 * they returned. A pending operation that never completes may be linearized or not.
 */
export class LinearizabilityChecker<
  State extends CanonicalValue,
  Input,
  Output extends CanonicalValue,
> {
  private readonly model: Model<State, Input, Output>;
  private partitions = new Map<string, Partition<State, Input>>();
  /** Pending operation id -> its partition. */
  private partitionOf = new Map<string, string>();

  constructor(model: Model<State, Input, Output>) {
    this.model = model;
  }

  /** Starts operation `id` (unique across the history). */
  invoke(id: string, input: Input): void {
    if (this.partitionOf.has(id)) throw new Error(`operation ${id} invoked twice`);
    const key = this.model.partition(input);
    let p = this.partitions.get(key);
    if (p === undefined) {
      p = { configs: [{ state: this.model.init(), lin: {} }], pending: new Map() };
      this.partitions.set(key, p);
    }
    p.pending.set(id, input);
    this.partitionOf.set(id, key);
  }

  /**
   * Completes pending operation `id` with `output`. Returns null if the history is still
   * linearizable, otherwise what went wrong; checking continues as if the operation had
   * returned one of its possible outputs.
   */
  complete(id: string, output: Output): LinearizabilityFailure<Input, Output> | null {
    const key = this.partitionOf.get(id);
    if (key === undefined) throw new Error(`operation ${id} completed but not pending`);
    const p = this.partitions.get(key)!;
    const input = p.pending.get(id)!;
    const closed = this.closure(p);
    const want = canonicalJson(output);
    const kept = closed.filter((c) => c.lin[id] === want);
    p.pending.delete(id);
    this.partitionOf.delete(id);
    if (kept.length > 0) {
      p.configs = dedupe(kept.map((c) => without(c, id)));
      return null;
    }
    const linearized = closed.filter((c) => c.lin[id] !== undefined);
    const possible = [...new Set(linearized.map((c) => c.lin[id]!))].sort();
    p.configs = dedupe(linearized.map((c) => without(c, id)));
    return {
      id,
      partition: key,
      input,
      output,
      possible: possible.map((json) => JSON.parse(json) as Output),
    };
  }

  /** Live state for checkpoints (structured-clonable). */
  save(): LinearizabilityState {
    return { partitions: this.partitions, partitionOf: this.partitionOf };
  }

  load(state: LinearizabilityState): void {
    this.partitions = state.partitions as Map<string, Partition<State, Input>>;
    this.partitionOf = state.partitionOf;
  }

  /** Every configuration reachable by linearizing more pending operations, in any order. */
  private closure(p: Partition<State, Input>): Config<State>[] {
    const seen = new Map<string, Config<State>>();
    const queue = p.configs;
    for (const c of queue) seen.set(configKey(c), c);
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i]!;
      for (const [id, input] of p.pending) {
        if (c.lin[id] !== undefined) continue;
        const { state, output } = this.model.step(c.state, input);
        const next = { state, lin: { ...c.lin, [id]: canonicalJson(output) } };
        const k = configKey(next);
        if (seen.has(k)) continue;
        seen.set(k, next);
        queue.push(next);
      }
    }
    return [...seen.values()];
  }
}

function without<State>(c: Config<State>, id: string): Config<State> {
  const { [id]: _removed, ...lin } = c.lin;
  return { state: c.state, lin };
}

function configKey<State>(c: Config<State>): string {
  return canonicalJson({ s: c.state as CanonicalValue, l: c.lin });
}

function dedupe<State>(configs: Config<State>[]): Config<State>[] {
  const seen = new Map<string, Config<State>>();
  for (const c of configs) seen.set(configKey(c), c);
  return [...seen.values()];
}

export interface LinearizableOptions<Input, Output> {
  /** Invariant name (default "linearizable"). */
  readonly name?: string;
  /** e.g. `put x="1"`. */
  readonly describeInput: (input: Input) => string;
  /** e.g. `"1"`. */
  readonly describeOutput: (output: Output) => string;
}

/**
 * Checks that the client-visible history is linearizable with respect to `model`. The history
 * is the clients' `invoke {seq, op}` and `complete {seq, result}` annotations; an operation is
 * identified by `(client, seq)`, so all retries of a request are one operation. Reported at
 * the `complete` that no linearization can explain.
 */
export function linearizable<State extends CanonicalValue, Input, Output extends CanonicalValue>(
  model: Model<State, Input, Output>,
  options: LinearizableOptions<Input, Output>,
): Invariant<unknown> {
  let checker = new LinearizabilityChecker(model);
  return {
    name: options.name ?? "linearizable",
    save: () => checker.save(),
    load(state) {
      checker = new LinearizabilityChecker(model);
      checker.load(state as LinearizabilityState);
    },
    check() {},
    onRecord(r, _now, report) {
      if (r.type !== "annotate") return;
      const data = r.data as { seq?: number; op?: Input; result?: Output } | undefined;
      if (data?.seq === undefined) return;
      const id = `${r.node}#${data.seq}`;
      if (r.label === "invoke" && data.op !== undefined) {
        checker.invoke(id, data.op);
      } else if (r.label === "complete" && data.result !== undefined) {
        const failure = checker.complete(id, data.result);
        if (failure === null) return;
        const could = failure.possible.map(options.describeOutput).join(" or ");
        report(
          `${id} ${options.describeInput(failure.input)} returned ${options.describeOutput(failure.output)}, but no linearization of the history allows that; it could only have returned ${could}`,
          [r.node],
        );
      }
    },
  };
}
