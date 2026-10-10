import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  defaultRegistry,
  loadCheckpoint,
  Rng,
  saveCheckpoint,
  scenarioForSeed,
  type Checkpoint,
  type Scenario,
  type TraceRecord,
} from "../src/index.ts";

const registry = defaultRegistry();

function build(scenario: Scenario) {
  const records: TraceRecord[] = [];
  const entry = registry.get(scenario.protocol)!;
  const run = entry.build(scenario, { sinks: [(r) => records.push(r)] });
  return { ...run, records };
}

type Built = ReturnType<typeof build>;

/** Everything observable about a run from now on, as one comparable string. */
function finish({ sim, monitor, records }: Built, durationMs: number, after: number): string {
  sim.runUntil(durationMs);
  const ids = [...sim.nodeIds, ...sim.clientIds];
  return canonicalJson({
    records: records.filter((r) => r.id > after) as never,
    violations: monitor.violations as never,
    processes: ids.map((id) => ({
      id,
      up: sim.isUp(id),
      view: sim.view(id),
      timers: sim.timers(id),
    })) as never,
    network: sim.networkView(),
    events: sim.eventCount,
    actions: sim.actions() as never,
  });
}

/**
 * Takes a checkpoint at `atMs`, finishes the original run, then restores the checkpoint both
 * into a fresh simulation and back into the original one: all three must agree.
 */
function checkRoundTrip(scenario: Scenario, atMs: number): Checkpoint {
  const a = build(scenario);
  a.sim.runUntil(atMs);
  const checkpoint = saveCheckpoint(a.sim, a.monitor);
  const expected = finish(a, scenario.durationMs, checkpoint.recordId);

  const b = build(scenario);
  b.records.length = 0;
  loadCheckpoint(b.sim, b.monitor, checkpoint);
  expect(finish(b, scenario.durationMs, checkpoint.recordId)).toBe(expected);

  // Rewinding the finished run itself (the checkpoint must not have been mutated).
  loadCheckpoint(a.sim, a.monitor, checkpoint);
  a.records.length = 0;
  expect(finish(a, scenario.durationMs, checkpoint.recordId)).toBe(expected);
  return checkpoint;
}

describe("checkpoints", () => {
  for (const protocol of ["raft", "dynamo"]) {
    it(`continue exactly like the original run (${protocol}, random seeds and times)`, () => {
      // SNAPSHOT_SEEDS=1000 for a thorough local run.
      const seeds = Number(process.env["SNAPSHOT_SEEDS"] ?? 20);
      const rng = Rng.fromSeed(99);
      for (let seed = 0; seed < seeds; seed++) {
        const scenario = scenarioForSeed(registry, seed, { protocol });
        checkRoundTrip(scenario, rng.int(0, scenario.durationMs));
      }
    });
  }

  // Invariant history must be restored too, or violations found after the checkpoint differ.
  const CAUGHT_AT: Record<string, number> = {
    "double-vote": 0,
    "volatile-vote": 16,
    "stale-votes": 461,
    "truncate-always": 0,
    "trust-received": 0,
    "no-sessions": 3,
    "lost-append": 4,
  };
  for (const [bug, seed] of Object.entries(CAUGHT_AT)) {
    it(`reproduce the "${bug}" violation from checkpoints before and after it`, () => {
      const scenario = scenarioForSeed(registry, seed, { protocol: `raft-bug-${bug}` });
      const run = build(scenario);
      run.sim.runUntil(scenario.durationMs);
      const first = run.monitor.violations[0]!;
      expect(first).toBeDefined();
      for (const f of [0.5, 0.999, 1.01]) checkRoundTrip(scenario, first.t * f);
    });
  }

  it("reproduce Figure 8 (commit-old-terms) from mid-scenario", () => {
    const scenario = registry.get("raft-bug-commit-old-terms")!.examples!.figure8!(
      "raft-bug-commit-old-terms",
    );
    const run = build(scenario);
    run.sim.runUntil(scenario.durationMs);
    const first = run.monitor.violations[0]!;
    expect(first).toBeDefined();
    for (const f of [0.3, 0.6, 0.95]) checkRoundTrip(scenario, first.t * f);
  });

  it("are not affected by later changes to the run", () => {
    const scenario = scenarioForSeed(registry, 5, { protocol: "raft" });
    const a = build(scenario);
    a.sim.runUntil(2000);
    const checkpoint = saveCheckpoint(a.sim, a.monitor);
    const before = structuredClone(checkpoint.data);
    a.sim.runUntil(scenario.durationMs);
    expect(checkpoint.data).toEqual(before);
    expect(checkpoint.t).toBe(2000);
  });
});
