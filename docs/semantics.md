# Simulation semantics

These rules define what the simulator can and cannot do. Protocol guarantees are only
meaningful relative to them, so changes here are breaking changes.

## Time and ordering

- Time is virtual (milliseconds, may be fractional). Nothing reads wall-clock time.
- Events run in `(time, insertion sequence)` order. Two events at the same instant run in
  the order they were scheduled; there is no hidden concurrency.
- Scenario actions given at construction are scheduled before any protocol events, so an
  action at time `t` runs before protocol events also at `t` (except node `init`, which runs
  during construction at time 0).

## Handlers

- Each protocol callback (`init`, `recover`, `onMessage`, `onTimer`, `onClientCommand`) is
  an **atomic step**. Effects it requests (`send`, `setTimer`, `cancelTimer`, `annotate`)
  are applied in request order only after it returns.
- Handlers see only their own node's state, `ctx.now`, and their own RNG stream
  (`node:<id>`). The network draws from a separate stream (`net`).

## Messages

- Messages must be plain data (canonical JSON). They are serialized on send and parsed
  fresh for every delivered copy, so nodes never share memory.
- The network is **not FIFO**: with jitter, later messages can overtake earlier ones.
- Every send ends in exactly one outcome per copy: `deliver` or `drop`, with a reason:
  - `loss`: lost by the link's loss probability (decided at send time).
  - `link-down`: the link was down at send time, **or went down while the message was in
    flight** (checked again at delivery).
  - `node-down`: the receiver was crashed at delivery time.
- Messages are addressed to a node, not a process. A message sent before the receiver
  crashed and arriving after it recovered **is delivered** to the new process.
- A node cannot send to itself.

## Crash and recovery

- Node state is `{ persistent, volatile }`. Because handlers are atomic, `persistent` at the
  moment of a crash is exactly what was durably written: there are no torn or delayed writes.
- **Crash**: the node stops processing. All its armed timers are discarded. Messages it had
  already sent stay in flight and are delivered normally.
- **Recover**: the protocol's `recover(ctx, persistent)` builds fresh volatile state. Timers
  from before the crash never fire, even if `recover` does not re-arm them.
- Crashing a crashed node or recovering a live node is a no-op.
- A client command addressed to a crashed node is recorded in the trace and then lost.

## Network

`LinkNetwork` models each directed link with latency, jitter (uniform `[0, jitter)`), loss
probability, duplication probability, and an `up` flag. Faults are layered:

- `setLink` changes one directed link (or both directions). This is how asymmetric
  connectivity is expressed. `heal` does **not** undo `setLink`.
- `partition` blocks every link between different groups; unlisted nodes form one extra
  group. It replaces any earlier partition or isolation.
- `isolate` blocks all links to and from one node, on top of the current partition.
- `heal` removes partitions and isolations.

Random draws happen only for non-zero fault parameters, in a fixed order
(loss, delay, duplicate, delay), so a fault-free link consumes no randomness.

## Not modeled (yet)

Slow node processing, clock drift, disk faults and delayed persistence, bandwidth,
Byzantine behavior.
