# Distributed Systems Lab — Plan

A deterministic, browser-based platform for building, breaking, debugging, and comparing
distributed systems. Raft first; eventual consistency second.

## Principles

- **Headless first.** Engine, network, protocols, and invariant checks work and are tested in
  Node before any UI exists. The UI observes the simulation; it never decides behavior.
- **Determinism is a feature.** Same scenario + seed ⇒ byte-identical canonical trace.
- **Correctness checking from day one**, not as a late phase. Planted-bug protocol variants
  prove the checker catches real mistakes.

## Engine design decisions

1. **Engine owns timers.** Protocols emit `setTimer(key, delay)` / `cancelTimer(key)`; the
   engine discards stale firings. No protocol-managed generation counters.
2. **Node incarnations.** A crash bumps the incarnation; timers from older incarnations are
   dropped. Recovery calls `protocol.recover(persisted)`, so volatile state cannot leak
   across a restart.
3. **Split RNG streams** per purpose and node (`net`, `node:A`, …). Changing one link's
   latency must not perturb unrelated nodes' timeouts — required for what-if comparisons.
4. **Causal IDs.** Every scheduled event records the event that caused it.
5. **Handlers may mutate their own node state** but perform no I/O and return effects. The
   engine clones only at snapshots. History-based invariants keep their own memory.
6. **Canonical serialization** (sorted keys, no Map/Set/undefined/NaN) for traces and hashes.
7. **Documented semantics** (`docs/semantics.md`): in-flight messages to a crashed node drop
   on delivery; messages a node sent before crashing still arrive; persistent writes are
   atomic at handler end; links are not FIFO.
8. **Package boundary.** `packages/core` compiles with `lib: ES2022`, no DOM, no Node types,
   and lint bans `Math.random`, `Date.now`, `setTimeout`.

## Phase 1 — Headless core + Raft leader election

Goal: a CLI and test suite that run thousands of seeded fault scenarios against Raft
elections, checking safety and bounded liveness after every event, emitting a reproducible
scenario on failure.

| #   | Work                                                                                                                                                        | Exit criterion                                                          | Status |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| 0   | Workspace: pnpm, strict TS, Vitest, fast-check, ESLint, Prettier, CI                                                                                        | CI green                                                                | done   |
| 1   | Primitives: seeded RNG with streams, `(time, seq)` heap, canonical JSON + trace hash                                                                        | Property tests for order, reproducibility, stream independence          | done   |
| 2   | Engine: `step()` / `runUntil(t)`, node lifecycle + incarnations, timers, effects (`send`, `setTimer`, `cancelTimer`, `annotate`), cause IDs, trace recorder | Same scenario + seed ⇒ same trace hash                                  | done   |
| 3   | Network: directed links, latency/jitter/loss/duplication, partition/heal actions, `docs/semantics.md`                                                       | Unit tests per fault and in-flight edge case                            | done   |
| 4   | Protocol interface + Raft election: roles, RequestVote, heartbeat AppendEntries, persistent `currentTerm`/`votedFor`                                        | Elects a leader; re-elects after crash; minority partition never elects | done   |
| 5   | Invariants: election safety, single vote per term, term monotonicity, persisted-state durability                                                            | Checked after every event via `getNodeView()` only                      | done   |
| 6   | Chaos runner: fast-check fault schedules, per-seed runs, bounded liveness, failure → scenario JSON                                                          | 10k seeds × ~5k events, zero violations                                 | done   |
| 7   | Planted-bug variants (double vote, lost `votedFor` on restart, …)                                                                                           | Each caught within N seeds                                              | done   |
| 8   | CLI: `sim run scenario.json`, `sim fuzz --seeds N`                                                                                                          | Failing scenario reproduces from the file alone                         | done   |

**Phase 1 result:** 10,000 generated fault scenarios (20.1M events, ~2k per run rather than
the planned ~5k) with zero safety or liveness failures; all three planted bugs are caught
within 15 seeds and shrunk to small scenarios. A placeholder web app and GitHub Pages
deployment were added ahead of phase 3.

Out of scope for phase 1: log replication, KV store, UI, Web Worker, snapshots/time travel,
custom shrinking (fast-check's shrinking covers the basics).

## Phase 2 — Log replication, commitment, replicated KV store

Goal: a Raft-backed KV store whose acknowledged writes survive every fault the fuzzer can
generate, with exactly-once semantics visible to clients, and planted commit bugs (including
Figure 8) caught automatically.

Design decisions:

- **Clients are real simulated processes** on the network, so partitions, lost replies,
  redirects and retries all arise from the simulation rather than an external driver.
- **Reads go through the log** (linearizable by construction). ReadIndex/lease reads wait
  for a linearizability checker.
- **Leader appends a no-op on election** so earlier-term entries commit promptly (§5.4.2).
- **Exactly-once via a session table** in the state machine (client → last seq + result).
- **Incarnation exposed to invariants**, since commitIndex is volatile and resets on restart.
- **`timeout` action** that fires a node's timer immediately, to script Figure 8 exactly.

| #   | Work                                                                                                                                                                                         | Exit criterion                                                                    | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------ |
| 1   | Client processes in the engine; generic `requestClient` (redirects, timeouts, retries, durable seq, invoke/complete history)                                                                 | A client works across a partition and lost replies; retries are visible in traces | done   |
| 2   | Log replication: entries in AppendEntries, prev-entry check, conflict-only truncation, nextIndex/matchIndex, batching, optional fast backoff                                                 | Follower logs converge to the leader's under loss, duplication and reordering     | done   |
| 3   | Commitment and apply: current-term majority rule, no-op on election, follower commit, in-order apply, state rebuilt after restart                                                            | Unit tests for each commit rule, including old-term entries                       | done   |
| 4   | KV state machine (`put`/`get`/`cas`) and client protocol: redirects, session table, reply after apply                                                                                        | Requests under crashes and partitions all complete after heal                     | done   |
| 5   | Invariants: log matching, leader completeness, state-machine safety, commit monotonicity per incarnation, applied ⊆ committed, leader append-only, acknowledged writes durable, exactly-once | Each fires on a hand-built violating history                                      | done   |
| 6   | Figure 8 scenario, scripted with `timeout` actions and link cuts                                                                                                                             | Correct Raft passes; the commit-rule bug fails                                    | done   |
| 7   | Planted bugs: old-term commit by counting, truncate on every AppendEntries, apply before commit, log lost on restart, no session table                                                       | Each caught by the fuzzer and minimized                                           | done   |
| 8   | Fuzzer workload: random client operations alongside faults; liveness = all client operations complete after heal                                                                             | 10k seeds clean on correct Raft                                                   | done   |
| 9   | Performance: incremental invariant checks as views grow with logs                                                                                                                            | ≥ 50k events/s                                                                    | done   |
| 10  | Tooling: `sim run --state` prints final logs/commit indexes; web placeholder shows per-node logs                                                                                             | Step 7 failures are understandable from the CLI alone                             | done   |

**Phase 2 result:** 10,000 generated scenarios with client traffic (34.3M events, ~46k
events/s) with zero safety or liveness failures. Seven of eight planted bugs are found by
fuzzing (first failing seeds 0–461) and shrunk; the Figure 8 commit bug is caught only by the
scripted scenario (0 of 1,000 random seeds reach that interleaving). Fuzzing found one real
bug: AppendEntries follow-ups on duplicated responses caused unbounded message growth.

Out of scope: snapshots/compaction, membership changes, ReadIndex/lease reads, full
linearizability checking (stretch: bounded checker for ~10-operation histories).

## Phase 3 — Interactive UI

Goal: in the browser, load or generate a scenario, play it at any speed, inject faults and
client operations live, watch messages move, inspect any node, and ask "why did this
happen?" for any event. Every interaction is recorded into the scenario, so a session
exports and replays exactly.

Design decisions:

- **Simulation in a Web Worker** behind a platform-independent `SimulationHost` (tested in
  Vitest). It posts one batched frame per animation frame: process states plus new records.
- **Live actions are scheduled actions.** Actions sort ahead of protocol events at equal
  times and live ones are stamped 1µs after the last processed instant, so a live session
  and its replay order every event identically.
- **Seek by replaying from zero** (cheap at these sizes); phase 4 replaced this with checkpoints.
- **Animation follows the schedule**: send records carry each copy's arrival time; drops are
  shown only when the drop record exists.
- **Custom SVG cluster view**, **Canvas space-time diagram**, Zustand store, virtualized lists.

| #   | Work                                                                                                                                                        | Exit criterion                                                                  | Status |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------ |
| 1   | Engine: arrival times on sends, timer queries, next-event time, action priority. `SimulationHost`: play/speed/step/step-to-notable/seek/live actions/frames | Live actions export and replay to the same trace hash; seek matches a fresh run | done   |
| 2   | Worker + typed protocol + Zustand store + playback bar (play, pause, speed, step, scrubber, clock)                                                          | 5-node Raft at 60fps on 10x with a responsive UI                                | done   |
| 3   | Cluster view (SVG): circular draggable layout, role/up/term, links, partitions, animated messages and drops, click to crash/recover                         | An election, crash and re-election visibly match the trace                      | done   |
| 4   | Node inspector + log grid: role, term, vote, commit/applied, election timer countdown, KV data, sessions; cross-node log grid                               | Figure 8 visibly reproduces stages (a)–(d)                                      | done   |
| 5   | Space-time diagram (Canvas): lifelines, message arrows, follows playhead, zoom/pan, click a message for payload and outcome                                 | Any arrow shows its payload and deliver/drop record                             | done   |
| 6   | Event list + causal chains: virtualized, filterable; selecting an event highlights its causes across all views                                              | "B becameLeader" shows timeout → RequestVotes → grants                          | done   |
| 7   | Fault and client tools: link editor, partition builder, network degradation, client panel (get/put/cas, pending requests)                                   | Every fault in docs/semantics.md is reachable from the UI                       | done   |
| 8   | Scenarios and violations: examples, generate from seed, import/export JSON, share by URL, violation panel with jump-to                                      | A `sim fuzz` failure file opens in the UI at its violation                      | done   |
| 9   | Hardening: Playwright e2e in CI, performance check, phone-width layout, Pages deploy                                                                        | CI runs e2e; the live site works                                                | done   |

Out of scope: snapshots, branching what-if comparisons, minimization in the UI (phase 4).

## Phase 4 — Time travel

Goal: move freely through a run (including backwards), fork what-if branches at any moment,
compare branches, shrink failures in the browser, and see the causal past of any event.

Design decisions:

- **Checkpoints are a speed-up, not a source of truth.** A checkpoint is the simulation's and
  the invariant monitor's state, copied by one `structuredClone` (invariant history points at
  log entries in protocol state and detects changes by identity). Property tests check that
  continuing from a checkpoint equals the original run and a fresh replay.
- **Checkpoints at fixed event counts** (multiples of a spacing that doubles when a cap is
  reached), so a replay recreates the same ones and the cap bounds memory.
- **A branch is a timeline**: its scenario, actions, known trace and checkpoints. Forks share
  the parent's checkpoints and records; all branches share one simulation object.
- **What-ifs change only actions** (and, for minimized variants, network defaults), never
  node state directly, so every branch is still a scenario that exports and replays exactly.
- **Causality is happens-before plus omissions**: the past of an event follows program order
  and messages backwards; a crash or link cut that dropped a message in it is a cause too.

| #   | Work                                                                                          | Exit criterion                                                           | Status |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------ |
| 1   | Snapshot engine: save/restore for the simulation, network, RNGs, queue and invariant history  | 1k seeds: restoring at a random time continues identically               | done   |
| 2   | Host time travel: automatic checkpoints, seek from the nearest one, step back, live scrubbing | Seek on a 10-minute 5-node run with clients < 50ms                       | done   |
| 3   | Branches in core: fork, edit future actions, switch at the same time                          | A branch shares its parent's trace up to the fork; matches a fresh run   | done   |
| 4   | Branch UI: branch bar, fork here, schedule editor                                             | Fork Figure 8 before a crash, remove it, get a different outcome         | done   |
| 5   | Compare: first divergence, outcome summary, per-process state diff                            | The divergence point jumps to the right record                           | done   |
| 6   | Minimize in the UI: background worker, progress, cancel, result opens as a branch             | A fuzz failure minimizes in the browser to the same result as `sim fuzz` | done   |
| 7   | Causal explanations: causal past of a violation or event, dimmed views, faults in it          | For the planted bugs, the explanation contains every minimized fault     | done   |
| 8   | Hardening: e2e for all of the above, memory cap, docs                                         | CI green                                                                 | done   |

Results: on a 10-minute, 5-node run with a client (155k events), seeks take 13ms median and
38ms max (a full replay takes 2.3s); its 78 checkpoints use 2.4 MB. Restore-and-continue
matches the original run for 1,000 random seeds and times, and random sequences of seeks,
steps back, forks, edits and switches always match a fresh replay of the branch.

Finding: a pure happens-before cone missed real causes. Crashes matter by omission (a
crashed node does not vote or store an entry), so the explanation also follows dropped
messages back to the crash or link cut that dropped them. And `acknowledged-writes-replicated`
now reports every server, since its claim ("only 2 of 5 store it") reads every log.

## Phase 5 — Eventual consistency (Dynamo-style)

Goal: a leaderless, Dynamo-style replicated store (consistent hashing, N/R/W quorums,
vector-clock versions with siblings, sloppy quorums, hinted handoff, read repair,
anti-entropy) whose checkers state precisely which guarantees each configuration keeps, then
CRDT values whose siblings merge automatically.

Design decisions:

- **Any server coordinates.** The server a client contacts runs the request against the key's
  preference list (no forwarding to the list's first node). Clients are the same
  `requestClient`, which also learns an `unavailable` reply.
- **Placement is a pure function of the key and the server set**: a consistent-hash ring with
  a few tokens per server, hashed from server ids (not the seed). The first N distinct servers
  clockwise are the key's replicas; the rest, in order, are its fallbacks.
- **Versions are dotted version vectors** (Preguiça et al., 2010): `{value, dot, context,
write}`, where the dot is the coordinator plus a fresh value of its persistent counter, the
  context is the merged history the writer had read, and `write` is the client's
  `(clientId, seq)`. A version replaces exactly the versions its context includes. Plain
  vector clocks are wrong when any server coordinates: two writes through one coordinator
  get `{A:1}` and `{A:2}`, and the second would silently replace the first even if its writer
  never saw it. Contexts are exact dot sets (a version vector plus individual dots, kept
  compact by per-key coordinator counters) for the same reason: having seen a coordinator's
  write 12 does not mean having seen its write 11. Plain clock comparison, vector contexts
  and the naive `context[coordinator] + 1` stamp are all planted bugs.
- **No failure detector.** Coordinators send to the first N, and on timeout either fall back
  to the next servers on the ring with a hint (sloppy quorum) or reply `unavailable` (strict).
  Hints are stored durably, apart from data, and handed off when the intended owner answers.
- **Anti-entropy by flat per-key digests**, pairwise with a random peer on a timer. Merkle
  trees would only matter at sizes the simulator does not reach.
- **Guarantees are checked per configuration.** Safety that always holds (no acknowledged
  write lost, a dot identifies one write, siblings are concurrent, replicas never regress,
  reads return only written values) is checked after every event. Read-sees-acknowledged-write
  is checked only for strict quorums with R + W > N, which promise it; sloppy quorums do not,
  and a scripted example shows why. Liveness: after heal, every key's replicas converge,
  hints drain, and all client operations complete.
- **Retries are not deduplicated.** A retried put through another coordinator can become a
  sibling of itself (same value, different dot), as in Dynamo. No deletes (tombstones).

| #   | Work                                                                                                                                                      | Exit criterion                                                                                        | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| 1   | Vector clocks and version sets (compare, merge, sibling rules); consistent-hash ring and preference lists                                                 | Property tests: merge is a join (commutative, associative, idempotent), drops only dominated versions | done   |
| 2   | Dynamo core: coordinator get/put with N/R/W, strict quorums, persistent clock counter, replica store, `unavailable`; client fills contexts from its reads | Concurrent puts make siblings; a put with a read's context replaces them                              | done   |
| 3   | Sloppy quorum and hinted handoff, read repair, anti-entropy                                                                                               | After a partition heals all replicas converge and hints drain; unit test per mechanism                | done   |
| 4   | Invariants: acknowledged writes durable, unique dots, siblings concurrent, replicas monotonic, reads return written values, reads see acknowledged writes | Each fires on a hand-built violating history                                                          | done   |
| 5   | Registry entry, workload, random config (N, R, W, sloppy), convergence liveness                                                                           | 10k seeds clean                                                                                       | done   |
| 6   | Planted bugs: reused counter, volatile counter, last-writer-wins, plain vector clocks, vector contexts, early ack, overwriting read repair                | Each caught by the fuzzer and minimized                                                               | done   |
| 7   | Scripted examples: concurrent writes make siblings; sloppy quorum stale read vs strict quorum unavailability                                              | Tests assert each outcome                                                                             | done   |
| 8   | CRDT values: grow-only counters and observed-remove sets merged by join; client increment/add/remove; checks for counter bounds and acknowledged adds     | Planted double-counting and remove-everything bugs are caught                                         | done   |
| 9   | Performance and tooling: incremental checks, `formatView`, `sim run --state`                                                                              | ≥ 40k events/s; step 6 failures are understandable from the CLI                                       | done   |
| 10  | UI: per-protocol UI modules; replica grid (keys × servers, siblings, clocks, hints), inspector, client form, ring placement, examples in the menu         | Siblings visibly appear and resolve in the concurrent-writes example                                  | done   |
| 11  | Hardening: e2e, docs, results                                                                                                                             | CI green                                                                                              | done   |

Out of scope: dynamic membership and ring rebalancing, deletes, Merkle trees, clock pruning,
coordinator forwarding.

**Phase 5 result:** 10,000 generated scenarios with registers, counters and sets under random
N/R/W, sloppy or strict quorums (8.1M events, 74k events/s) with zero safety or liveness
failures. All nine planted bugs are caught by fuzzing within 25 seeds (first failing seeds
0–24) and minimized. Checkpoints round-trip for Dynamo as for Raft. The examples show siblings
appearing and resolving, and a sloppy quorum acknowledging a write that a later read misses,
where a strict quorum is unavailable instead.

Findings:

- **The first fuzz run found a design bug.** Contexts kept as version vectors claim more than
  the writer saw: having read a coordinator's write 12 is not having read its concurrent write
  11, so a put silently replaced two acknowledged writes. Dotted versions alone do not fix
  this; the context must be an exact dot set. That behavior is now a planted bug.
- **Liveness, not safety, needed tuning.** Random anti-entropy partners left pairs unsynced for
  seconds, coordinators gave up after one lost message, and long client timeouts let backlogs
  outlast the fault-free tail. Partners are now taken in turn, coordinators ask twice, and
  Dynamo asks for a 12s tail (every operation is a quorum round trip).
- **Retries cause sibling explosion.** A put retried through another coordinator is a new
  version, so a lossy, strict, W=3 run left 32 copies of two values as siblings. This is
  Dynamo's real behavior and is left visible.

## Later phases

6. Linearizability checking (Porcupine-style) for the KV store; docs, tutorials, GitHub Pages.

Explicitly excluded from the first release: dynamic membership, snapshots/compaction,
linearizable-read optimizations, real sockets, Byzantine faults.
