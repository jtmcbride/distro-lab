# Simulation semantics

These rules define what the simulator can and cannot do. Protocol guarantees are only
meaningful relative to them, so changes here are breaking changes.

## Time and ordering

- Time is virtual (milliseconds, may be fractional). Nothing reads wall-clock time.
- Events run in `(time, insertion sequence)` order. Two events at the same instant run in
  the order they were scheduled; there is no hidden concurrency.
- Scenario actions run before protocol events scheduled for the same instant (except node
  `init`, which runs during construction at time 0). This holds however the action was
  added, so a live session and its replay order events identically. Live actions are
  stamped 1µs after the last processed instant.

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

## Clients

- Clients are simulated processes like servers: they have network links, timers, their own
  RNG stream, and can crash and recover. They run a client protocol over the same message
  type as the servers. A server's `ctx.peers` lists only servers; a client's lists the servers.
- Client commands (scenario `client` actions) are delivered to a client process, which turns
  them into requests over the network. Partitions therefore affect clients too: a client is
  only as connected as its links.
- `partition` groups should list clients explicitly; unlisted processes (clients included)
  form one extra group together.
- The standard `requestClient` keeps one request outstanding, follows leader redirects,
  retries on timeout against another server, and persists its request counter so a restart
  never reuses a `(clientId, seq)`. Its `invoke` / `complete` annotations form the
  client-visible history; an `invoke` with no `complete` has an unknown outcome.

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

## Checkpoints and branches

A checkpoint captures everything that determines the rest of a run: the clock, counters,
event queue, every RNG stream, each process's state, timers, up flag and incarnation, the
network's settings and partitions, which actions have run, and the invariant monitor's
history. Restoring one and continuing produces exactly the records the original run
produced. The trace hash is not part of a checkpoint; the host keeps the records instead.

A branch keeps its parent's actions up to the fork and can change only actions that have
not run yet. Added actions must be later than the current time, as live actions are, so a
branch always equals a fresh replay of its own scenario.

## Causal past

The causal past of an event `e` at process `p` (Lamport's happens-before) is every earlier
event at `p` plus, for each message `p` received before `e`, the causal past of its send.
Drops are not in it, because a message that never arrived changed no state. Network changes
are global, so they are not in it either. Faults can still shape the past by omission: when
a message sent in the past was dropped because its receiver was down, the receiver's crash
is a cause. When it was dropped because its link was cut, the latest network change before
the drop is a cause. A violation's past is taken over all the processes it names.

## Not modeled (yet)

Slow node processing, clock drift, disk faults and delayed persistence, bandwidth,
Byzantine behavior.
