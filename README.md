# distro-lab

Deterministic distributed-systems simulator. See [PLAN.md](PLAN.md) for the roadmap and
[docs/semantics.md](docs/semantics.md) for exactly what the simulator models.

```sh
pnpm install
pnpm check   # format, lint, typecheck, test
```

## Layout

- `packages/core`: simulation engine, network model, protocols, invariants, chaos harness,
  time travel. No DOM or Node dependencies. Two protocols, each with planted-bug variants:
  - Raft with a replicated KV store (linearizable, exactly-once).
  - A Dynamo-style leaderless store: consistent hashing, N/R/W quorums, sloppy quorums with
    hinted handoff, read repair, anti-entropy, dotted version vectors with siblings, and CRDT
    values (counters on `count:` keys, observed-remove sets on `set:` keys).
- `packages/cli`: `sim` command-line tool (runs directly on Node 22 via type stripping).
- `apps/web`: interactive browser app (simulation in a Web Worker; cluster view, message
  timeline, node inspector, Raft's log grid and Dynamo's replica grid, causal event list,
  fault and client tools, share links; time travel with step back and live scrubbing,
  what-if branches with a schedule editor and comparison, in-browser minimization, causal
  explanations of violations).
  `pnpm -C apps/web dev` to develop; `pnpm -C apps/web e2e` runs the Playwright suite.
  Deployed to GitHub Pages from `main`.

## CLI

```sh
pnpm sim list                                   # protocols and planted-bug variants
pnpm sim fuzz --seeds 1000                      # chaos-test Raft across 1000 seeds
pnpm sim fuzz --protocol raft-bug-stale-votes --out failures
pnpm sim run failures/raft-bug-stale-votes-seed9.min.json --tail 20
pnpm sim fuzz --protocol dynamo --seeds 1000    # chaos-test the Dynamo-style store
pnpm sim example sloppy-quorum --protocol dynamo > s.json && pnpm sim run s.json --state
pnpm sim gen --seed 42 > scenario.json          # inspect or hand-edit a scenario
```

`fuzz` generates a fault scenario per seed (crashes, fast restarts, partitions, asymmetric
links, latency spikes, network-wide loss/duplication), checks safety invariants after every
event and liveness after faults are lifted, then shrinks any failure to a minimal scenario.
A scenario file always replays to the same trace hash.
