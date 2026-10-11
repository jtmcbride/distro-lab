# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Deterministic distributed-systems simulator (pnpm workspace, TypeScript, Node ≥ 22.12) with an
interactive browser UI. `PLAN.md` has the roadmap, per-phase design decisions and step status;
`docs/semantics.md` defines exactly what the simulator models (time, handlers, messages,
crashes, network, checkpoints, causality). Read it before touching the engine, network, host
or causality code: changes to those semantics are breaking.

## Commands

```sh
pnpm install
pnpm check                 # format:check + lint + typecheck + test (CI also runs `pnpm build` and e2e)
pnpm test                  # vitest in every package
pnpm format                # prettier --write (printWidth 100)

# Single test file / single test
pnpm -C packages/core exec vitest run test/figure8.test.ts
pnpm -C packages/core exec vitest run test/harness.test.ts -t "double-vote"

# Web app
pnpm -C apps/web dev
pnpm -C apps/web e2e       # Playwright: builds with the Pages base path and serves the bundle
pnpm -C apps/web exec playwright install chromium   # once, before the first e2e run
CHROMIUM_PATH=/path/to/chrome-headless-shell pnpm -C apps/web e2e   # use an already-installed Chromium

# CLI (runs .ts directly on Node 22 via type stripping; no build step)
pnpm sim list
pnpm sim fuzz --seeds 1000 [--protocol raft|dynamo|<name>-bug-<bug>] [--out failures]
pnpm sim run scenario.json [--trace | --tail N] [--state] [--history [--key K]]
pnpm sim gen --seed 42
pnpm sim example figure8                          # or sloppy-quorum --protocol dynamo
```

Nothing is built for Node: `@distro-lab/core` exports `./src/index.ts` directly. Imports use
explicit `.ts` extensions and `erasableSyntaxOnly` is on (no enums, namespaces or parameter
properties), since Node type stripping would reject them.

## Architecture

### `packages/core`

The whole engine. It must run unchanged in Node and in a browser Worker: its tsconfig has
`lib: ES2022` with no DOM and no Node types (tests use `tsconfig.test.json`). ESLint bans
`Math.random`, `Date.now`, `performance.now`, `setTimeout` and `setInterval` in
`packages/core/src`; use `ctx.rng`, `ctx.now` and `ctx.setTimer`.

Bottom up:

- **Primitives**: `rng.ts` (seeded, split into independent streams per purpose/node, e.g. `net`,
  `node:A`, so one change doesn't perturb other nodes), `eventQueue.ts` (`(time, seq)` heap),
  `canonical.ts` (sorted-key JSON, no Map/Set/undefined/NaN; used for messages, traces, hashes).
- **Engine** (`simulation.ts`): runs events in order and owns all timers. Node state is
  `{ persistent, volatile }`; a crash bumps the node's _incarnation_, drops its timers and
  volatile state, and `protocol.recover(ctx, persistent)` rebuilds it. Messages are serialized
  on send and parsed per delivered copy. Every event records its cause. Actions: `crash`,
  `recover`, `client`, `timeout` (fire a timer now, for scripting exact interleavings),
  `network`. Scenario actions run before protocol events at the same instant.
- **Protocol interface** (`protocol.ts`): callbacks (`init`, `recover`, `onMessage`, `onTimer`,
  `onClientCommand`) mutate their own node state and request effects through `ctx` (`send`,
  `setTimer`, `cancelTimer`, `annotate`), applied after the callback returns. `view(state)` is
  the plain-data view invariants and the UI see; invariants never read internal state. Node
  state must be plain structured-clonable data, because checkpoints copy it.
- **Network** (`linkNetwork.ts`): directed links (latency, jitter, loss, duplication, up), plus
  `setLink`, `setAll`, `partition`, `isolate`, `heal`, `restore`. Not FIFO.
- **Invariants** (`invariants.ts`): `InvariantMonitor` runs every `check` after each step on a
  `ClusterSnapshot` (servers only, with `up` and `incarnation`); optional `onRecord` sees trace
  records mid-step (client-visible events). A checker that keeps history must implement
  `save`/`load` so checkpoints can restore it.
- **Linearizability** (`linearizability.ts`): an online checker that keeps every configuration
  the history so far can be in (model state plus which pending operations are linearized,
  with their outputs) per partition, and the `linearizable` invariant over client
  `invoke`/`complete` annotations. `harness/history.ts` extracts histories for the CLI and UI.
- **Clients** (`clients/requestClient.ts`): clients are simulated processes on the network.
  One request outstanding, redirects, retries on timeout or `unavailable`, durable seq;
  `invoke`/`complete` annotations form the client-visible history. Optional hooks rewrite an
  op as it starts and learn from results (Dynamo attaches read contexts this way).
- **Harness** (`harness/`): a `Scenario` is plain JSON and always replays to the same trace hash.
  `generate.ts` turns a seed into faults plus a workload, `fuzz.ts` runs seeds, `minimize.ts`
  shrinks failures. `defineProtocol` builds a `ProtocolEntry` (factory, client protocol,
  invariants and liveness, both given the scenario's protocol config, workload, random config,
  examples, view formatter, optional longer `stabilizeMs`); `registry.ts` maps names to
  entries and is what the CLI, host and web app use.
- **Time travel** (`snapshot.ts`, `host/host.ts`): a checkpoint is the simulation's and the
  monitor's state copied by one `structuredClone` (invariant history can point at objects in
  protocol state). `SimulationHost` drives a run for the UI: playback, steps both ways, seek
  (restore nearest checkpoint and replay), live actions (stamped 1µs after the last processed
  instant so replays order them identically), branches (fork, edit future actions, switch,
  compare), and `frame()` diffs for the UI. Checkpoints sit at fixed event counts so replays
  recreate them.
- **Causality** (`causality.ts`): happens-before past of a record, plus faults that matter by
  omission (the crash or link cut that dropped a message in the past).
- **Raft** (`protocols/raft/`): `raft.ts` (election, replication, no-op on election,
  current-term commit, KV apply with a session table), `kv.ts` (also the linearizability model),
  `invariants.ts`, `workload.ts` (KV client ops and the `client-chains` check), `scenarios.ts`
  (scripted Figure 8; a stale read from a deposed leader), `registry.ts` (`raft` plus a
  `raft-bug-<name>` entry per planted bug).
- **Dynamo** (`protocols/dynamo/`): leaderless store. `ring.ts` (preference lists from server
  ids, not the seed), `clock.ts` (dotted versions with exact causal contexts: a version vector
  plus individual dots; plain vector clocks or vector contexts are wrong here and kept only as
  planted bugs), `crdt.ts` (`count:` keys are grow-only counters, `set:` keys observed-remove
  sets; other keys are sibling registers), `dynamo.ts` (any server coordinates; N/R/W, sloppy
  or strict quorums, hinted handoff, read repair, round-robin anti-entropy; `dynamoClient`),
  `invariants.ts` (read-sees-acknowledged-write is checked only when `promisesReadYourWrites`),
  `scenarios.ts` (examples), `registry.ts` (liveness = replicas converge, hints drain). Stored
  slots are replaced, never mutated: invariants detect change and the digest cache works by
  object identity.

**Planted bugs** (`protocols/*/bugs.ts`, plus `Planted*Bugs` flags in the protocol) are
intentionally broken variants that prove the checkers work. Don't "fix" them.
`test/harness.test.ts` and `test/dynamoHarness.test.ts` pin the first seed at which `sim fuzz`
catches each bug (`CAUGHT_AT`); changing the generator, a workload, the RNG draw order or
protocol timing usually shifts them. Re-measure with `pnpm sim fuzz --protocol <name>` and
update the table. Raft's `commit-old-terms` is caught only by the scripted Figure 8 test.

### `packages/cli`

`src/main.ts`: a thin `parseArgs` wrapper over the harness, with an injectable `Io` for tests.

### `apps/web`

React + Vite + Zustand, deployed to GitHub Pages from `main`. The UI only observes; all
behavior lives in core.

- `sim/worker.ts` wraps a `SimulationHost` in a Web Worker; `sim/protocol.ts` types the
  page↔worker messages; `sim/client.ts` is the page side. The worker posts one `Frame` per
  animation frame. `sim/minimizeWorker.ts` runs minimization in a second worker.
- `state/store.ts` (Zustand) applies frames; the full trace lives outside the store in
  `state/trace.ts` (`traceVersion` signals changes). `state/causes.ts`, `cone.ts`,
  `traceIndex.ts` and `inflight.ts` derive causal chains and in-flight messages from it.
- Protocol-specific presentation lives behind the `ProtocolUi` interface in `src/protocols/`
  (`raft.tsx`, `dynamo.tsx`; `uiFor` picks one by protocol-name prefix): badges, message
  colors, timer ring and buttons, server inspector, data panel (`LogGrid` / `ReplicaGrid`),
  client form, op descriptions. `HistoryPanel` shows client histories and linearizability
  violations for any protocol. Components get it from `useProtocolUi()`. A new protocol needs
  one of these plus entries in `scenarios.ts` (scenario menu).
- `tutorials/`: guided tours (`tours.ts`: steps with a moment, a panel and text) and their
  controls. `tours.test.ts` checks every claim a step makes against a fresh run, so a
  protocol or example change that makes a tour wrong fails the build; `?tour=<id>` opens one.
- Unit tests are `src/**/*.test.ts` (vitest); Playwright specs are in `e2e/`.

## Conventions

- Determinism is the core requirement: the same scenario and seed give a byte-identical
  canonical trace, live sessions and branches equal a fresh replay, and restoring a checkpoint
  continues identically. Don't add randomness outside a node's or the network's stream, and
  don't let iteration order depend on anything but the scenario.
- `noUncheckedIndexedAccess` is on; `!` after a bounds check is the accepted escape hatch. Unused
  vars and args are allowed with a `_` prefix.
- Chaos tests run hundreds of full simulations, so the vitest timeout is 60s.
- Each phase in `PLAN.md` lists design decisions and numbered steps with exit criteria; work
  happens on a `phase-N` branch with roughly one commit per step, and the step's status (and
  the phase's measured results) are updated in `PLAN.md` as it lands.
