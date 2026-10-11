# Fast reads and clocks

Raft can serve a read three ways, chosen by `readMode` in the scenario's config. All three
are linearizable under their assumptions; the [linearizability check](linearizability.md)
judges them on every run.

| `readMode`  | How a read is served                                              | Cost                        | Assumes                     |
| ----------- | ----------------------------------------------------------------- | --------------------------- | --------------------------- |
| `log`       | Appended and committed like a write, answered once applied        | One round trip, a log entry | Nothing                     |
| `readIndex` | Leader confirms it still leads with a heartbeat round, then reads | One round trip, no entry    | Nothing                     |
| `lease`     | Leader answers at once while it holds a lease                     | No round trip, no entry     | Clocks drift within a bound |

`sim stats` compares them on the same generated scenarios:

```sh
pnpm sim stats --seeds 100 --set readMode=log,readIndex,lease
```

On 100 seeds the median read takes 84ms with `log` and `readIndex` and 44ms with `lease`,
and the shortcuts cut log entries by 28%. Log and ReadIndex reads cost the same here
because the simulator does not model disk writes; in a real system the log read also
pays for an fsync.

## Clocks

Leases depend on time, so the engine gives every process a local clock that can drift (see
[semantics.md](semantics.md#clocks)). A clock runs at a rate relative to true time: the
scenario's `clockRates` sets initial rates, and a `clock` action changes one mid-run. Timer
delays are local time, and handlers read the clock as `ctx.localNow`. In the UI, the
inspector shows a process's clock and sets its rate.

## ReadIndex (Raft thesis §6.4)

1. The leader must have committed an entry in its own term (its no-op). Before that, its
   commit index can be behind what an earlier leader committed. Reads arriving earlier wait.
2. It records the current commit index as the read's index.
3. It starts a heartbeat round. AppendEntries carry a round number that every answer in the
   term echoes, accepted or not. Once a majority has answered a round started after step 2,
   no other leader can have committed anything the read index misses.
4. Once it has applied up to the read index, it answers from its state machine.

## Leases (Raft thesis §6.4.1)

A follower that answered a leader's round will not help elect anyone else for a while, so
the leader can skip the round for that long:

- **Vote stickiness.** A server that heard from a leader within the minimum election
  timeout (on its own clock) ignores RequestVote entirely, term included. A leader ignores
  them while it leads.
- **The lease.** When a majority has answered round `r`, the leader holds a lease until the
  local time it sent `r` plus `min × (1 − e) / (1 + e)`, where `min` is the minimum election
  timeout and `e` the drift bound (`maxDriftPpm`). A voter that answered `r` refuses votes for
  at least `min / (1 + e)` true ms after receiving it. The leader's clock runs at least
  `1 − e` fast, so its lease lasts at most `min / (1 + e)` true ms after sending `r`: it ends
  before any voter can help elect a successor.
- **Restarts.** A restarted server has forgotten when it last answered a leader. It may have
  answered the round a lease rests on just before crashing, so it waits a full minimum
  election timeout before voting.
- **Expiry.** A read that outlives the lease falls back to ReadIndex.

Leases make elections slower to start after a leader fails (followers wait out their
stickiness first), so generated Raft scenarios end with a 12s fault-free window instead of
8s.

### When the assumption breaks

The lease is correct for its bound. Break the bound and it fails: in the
[lease tutorial](https://jtmcbride.github.io/distro-lab/?tour=leases) the leader's clock
runs at 0.2× under a 5% assumption. Cut off from the majority, it still believes its lease
runs when the majority has elected a new leader and committed a write, and it answers a read
with the old value. The same script with the leader's clock at 0.95× is linearizable.

```sh
pnpm sim example lease-drift > s.json && pnpm sim run s.json --history
```

## Planted bugs

| Bug                            | Mistake                                                | Caught             |
| ------------------------------ | ------------------------------------------------------ | ------------------ |
| `readindex-before-term-commit` | Takes the read index before committing in its own term | fuzzing, seed 40   |
| `readindex-skips-round`        | Serves ReadIndex reads without the heartbeat round     | fuzzing, seed 1774 |
| `lease-ignores-drift`          | Lease lasts the full minimum election timeout          | scripted race      |
| `lease-no-stickiness`          | Followers vote while they hear from a leader           | scripted race      |
| `lease-forgets-contact`        | A restarted server votes at once                       | scripted race      |

The lease bugs are unsafe only in windows a few tens of milliseconds wide: a successor must
be elected and commit a write, and a stale read must reach the old leader, all before the
old leader's lease runs out. Random faults did not line that up in 35,000 seeds (5,000 for
`lease-forgets-contact`), even with drift bounds up to 30% to widen the windows, so
`Raft.LEASE_RACES` scripts each one as tightly as the rules allow. On correct Raft every
race is linearizable; with the bug, the linearizability check catches the stale read.
