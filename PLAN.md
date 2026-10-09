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
| 5   | Invariants: election safety, single vote per term, term monotonicity, persisted-state durability                                                            | Checked after every event via `getNodeView()` only                      |        |
| 6   | Chaos runner: fast-check fault schedules, per-seed runs, bounded liveness, failure → scenario JSON                                                          | 10k seeds × ~5k events, zero violations                                 |        |
| 7   | Planted-bug variants (double vote, lost `votedFor` on restart, …)                                                                                           | Each caught within N seeds                                              |        |
| 8   | CLI: `sim run scenario.json`, `sim fuzz --seeds N`                                                                                                          | Failing scenario reproduces from the file alone                         |        |

Out of scope for phase 1: log replication, KV store, UI, Web Worker, snapshots/time travel,
custom shrinking (fast-check's shrinking covers the basics).

## Later phases

2. Log replication, current-term commit rule, Figure 8 scenario, KV state machine, client
   request IDs + dedup.
3. UI: React Flow topology, space-time diagram (custom Canvas/SVG), node inspector, log
   viewer; simulation in a Web Worker, snapshots posted at frame rate.
4. Time travel: periodic snapshots, replay, branching what-if runs, causal explanations.
5. Eventual-consistency protocol (Dynamo-style), then vector clocks/CRDTs.
6. Linearizability checking (Porcupine-style) for the KV store; docs, tutorials, GitHub Pages.

Explicitly excluded from the first release: dynamic membership, snapshots/compaction,
linearizable-read optimizations, real sockets, Byzantine faults.
