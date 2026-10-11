# Linearizability checking

The Raft store promises that every operation appears to take effect at a single instant
between its invocation and its reply (Herlihy & Wing, 1990). The simulator checks that
promise against what clients actually saw, after every event of every run, without looking
inside any server.

Try it: the [stale read tutorial](https://jtmcbride.github.io/distro-lab/?tour=stale-read)
walks through a violation, or run

```sh
pnpm sim example stale-read --protocol raft-bug-leader-local-reads > s.json
pnpm sim run s.json --history
```

## The history

Clients record two annotations per operation:

- `invoke {seq, op}` when the operation starts (before its first request is sent);
- `complete {seq, result}` when the first `ok` reply arrives.

`(client, seq)` names one operation across all of its retries, so a request that times out,
is redirected and retried is still one interval in the history, from its invocation to its
reply. An operation with no `complete` (its client crashed, or the run ended) is _pending_:
it may have taken effect at any point after its invocation, or never.

Real-time order is trace order: operation `a` precedes `b` if `a`'s `complete` record comes
before `b`'s `invoke` record. Records at the same instant are still ordered, so a client that
completes one operation and starts the next at once has them in sequence.

## The model

A model is a sequential specification: `step(state, input) -> (state, output)`, deterministic.
The KV model (`kvModel` in `protocols/raft/kv.ts`) is one register per key, with `get`, `put`
and `cas` exactly as the store executes them. A model also names each operation's
_partition_: operations on different keys never affect each other, and a history is
linearizable exactly when each key's sub-history is (P-compositionality), so each key is
checked on its own.

## The checker

Searching every ordering of a finished history (Wing & Gong, Porcupine, Knossos) would give a
verdict only at the end of a run. The simulator checks online instead, and reports at the
reply that no ordering can explain, like every other invariant.

For each partition it keeps a _frontier_: every configuration that a linearization of the
history so far can be in. A configuration is the model state plus the set of pending
operations already linearized, each with the output it returned at that point (just-in-time
linearization, Lowe 2017).

- `invoke`: add the operation to the pending set. The frontier is unchanged.
- `complete(op, output)`: extend the frontier by linearizing pending operations, in every
  order (deduplicating equal configurations), then keep the configurations where `op` was
  linearized and returned `output`, and drop `op` from them. If none are left, the history
  is not linearizable.

This is exact. Once an operation has completed, everything invoked later must be linearized
after it, so no future event can change how completed operations are ordered relative to
each other; only pending operations are still undecided, and the configurations record
every way they might have been. The cost per event is the frontier size, which is small
because only a few operations per key are ever pending at once (one per client).

After a violation, checking continues as if the operation had returned one of the outputs
it could have returned, so later violations are still meaningful.

`packages/core/test/linearizability.test.ts` cross-checks the frontier against a brute-force
search of every real-time-respecting order on 10,000 random histories (with pending
operations and corrupted outputs), and checks that saved checker state continues
identically.

## Reading a violation

The message names the operation, what it returned, and what it could have returned:

```
c2#2 get x returned "1", but no linearization of the history allows that; it could only
have returned "2"
```

`sim run --history` prints the failing key's operations up to the violation, each marked by
its order relative to the failing one. The UI's client history panel shows the same thing
as bars on a time axis. An operation marked _before_ completed before the failing one
started, so it must be ordered before it:

```
history of x, up to the first violation: 4 operations
             invoked  completed  op      operation                    result
  before     100.000    160.000  c1#1    put x="1"                    "1"
  before     200.000    220.000  c2#1    get x                        "1"
  before     500.000    960.000  c1#2    put x="2"                    "2"
  FAILED    1500.000   1520.000  c2#2    get x                        "1"
```

## What it catches

The `client-chains` check only knows about each client's own key, so it misses stale reads
of keys other clients wrote. Two planted bugs show the difference:

- `raft-bug-leader-local-reads`: the leader answers reads from its own state without a log
  entry or a quorum check. A deposed leader in a minority partition returns old values.
  Fuzzing catches it at seed 59 (a client reading its own key from a stale leader).
- `raft-bug-session-reads`: any server that has applied a client's previous request answers
  its reads locally. That keeps read-your-writes, so `client-chains` never fires; only the
  linearizability check catches it (seed 2667: a read misses another client's acknowledged
  write).

Correct Raft serves reads through the log, which is linearizable but costs a log write per
read. ReadIndex (confirm leadership with a heartbeat round, then wait to apply up to the
commit index seen) and leader leases avoid the write; both are out of scope here.

## What it does not check

- **Dynamo.** Its reads return sibling sets, and it does not promise linearizability under
  any configuration: even with strict quorums and R + W > N, a read that overlaps a write
  can return it (one of its R answers already stores it) while a later read does not (its
  R answers come from replicas the write has not reached yet). The coordinator replies
  after R answers, and read repair, when on, runs only afterwards. Its own invariants state
  which weaker guarantees each configuration keeps.
- **Other models.** Only the KV register. A model is about ten lines; a protocol opts in by
  adding `linearizable(model, …)` to its invariants and, for readable output, a
  `HistoryFormat` in its registry entry.
