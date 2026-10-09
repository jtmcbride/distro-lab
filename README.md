# distro-lab

Deterministic distributed-systems simulator. See [PLAN.md](PLAN.md) for the roadmap and
[docs/semantics.md](docs/semantics.md) for exactly what the simulator models.

```sh
pnpm install
pnpm check   # format, lint, typecheck, test
```

## Layout

- `packages/core`: simulation engine, network model, protocols (Raft), invariants, chaos
  harness. No DOM or Node dependencies.
- `packages/cli`: `sim` command-line tool (runs directly on Node 22 via type stripping).
- `apps/web`: browser app (currently a placeholder that runs one scenario in the page).
  `pnpm -C apps/web dev` to develop. Deployed to GitHub Pages from `main`.

## CLI

```sh
pnpm sim list                                   # protocols and planted-bug variants
pnpm sim fuzz --seeds 1000                      # chaos-test Raft across 1000 seeds
pnpm sim fuzz --protocol raft-bug-stale-votes --out failures
pnpm sim run failures/raft-bug-stale-votes-seed9.min.json --tail 20
pnpm sim gen --seed 42 > scenario.json          # inspect or hand-edit a scenario
```

`fuzz` generates a fault scenario per seed (crashes, fast restarts, partitions, asymmetric
links, latency spikes, network-wide loss/duplication), checks safety invariants after every
event and liveness after faults are lifted, then shrinks any failure to a minimal scenario.
A scenario file always replays to the same trace hash.
