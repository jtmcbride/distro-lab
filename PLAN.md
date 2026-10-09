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
| 5   | Invariants: log matching, leader completeness, state-machine safety, commit monotonicity per incarnation, applied ⊆ committed, leader append-only, acknowledged writes durable, exactly-once | Each fires on a hand-built violating history                                      |        |
| 6   | Figure 8 scenario, scripted with `timeout` actions and link cuts                                                                                                                             | Correct Raft passes; the commit-rule bug fails                                    |        |
| 7   | Planted bugs: old-term commit by counting, truncate on every AppendEntries, apply before commit, log lost on restart, no session table                                                       | Each caught by the fuzzer and minimized                                           |        |
| 8   | Fuzzer workload: random client operations alongside faults; liveness = all client operations complete after heal                                                                             | 10k seeds clean on correct Raft                                                   |        |
| 9   | Performance: incremental invariant checks as views grow with logs                                                                                                                            | ≥ 50k events/s                                                                    |        |
| 10  | Tooling: `sim run --state` prints final logs/commit indexes; web placeholder shows per-node logs                                                                                             | Step 7 failures are understandable from the CLI alone                             |        |

Out of scope: snapshots/compaction, membership changes, ReadIndex/lease reads, full
linearizability checking (stretch: bounded checker for ~10-operation histories).

## Later phases

3. UI: React Flow topology, space-time diagram (custom Canvas/SVG), node inspector, log
   viewer; simulation in a Web Worker, snapshots posted at frame rate.
4. Time travel: periodic snapshots, replay, branching what-if runs, causal explanations.
5. Eventual-consistency protocol (Dynamo-style), then vector clocks/CRDTs.
6. Linearizability checking (Porcupine-style) for the KV store; docs, tutorials, GitHub Pages.

Explicitly excluded from the first release: dynamic membership, snapshots/compaction,
linearizable-read optimizations, real sockets, Byzantine faults.
