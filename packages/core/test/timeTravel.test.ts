import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  defaultRegistry,
  fuzz,
  minimizeFailure,
  NOTABLE_LABELS,
  Raft,
  Rng,
  scenarioForSeed,
  SimulationHost,
  type Scenario,
  type TraceRecord,
  type Violation,
} from "../src/index.ts";

const registry = defaultRegistry();

/** Mirrors the UI: folds frames into a trace and a violation list. */
function viewer(host: SimulationHost) {
  const records: TraceRecord[] = [];
  const violations: Violation[] = [];
  const pull = () => {
    const f = host.frame();
    if (f.reset) records.length = 0;
    if (f.truncateAfter !== null) records.length = f.truncateAfter + 1;
    if (f.reset || f.truncateAfter !== null) violations.length = 0;
    records.push(...f.records);
    violations.push(...f.violations);
    return f;
  };
  return { records, violations, pull };
}

/** A fresh run of `scenario` for exactly `events` events. */
function fresh(scenario: Scenario, events: number) {
  const records: TraceRecord[] = [];
  const { sim, monitor } = registry
    .get(scenario.protocol)!
    .build(scenario, { sinks: [(r) => records.push(r)] });
  while (sim.eventCount < events && sim.step());
  return { sim, monitor, records };
}

/** The host's state, as the UI sees it, equals a fresh replay of its scenario. */
function expectMatchesReplay(host: SimulationHost, ui: ReturnType<typeof viewer>) {
  const f = ui.pull();
  const ref = fresh(host.scenario(), host.events);
  expect(ref.sim.eventCount).toBe(host.events);
  expect(ui.records.length).toBe(ref.records.length);
  expect(canonicalJson(ui.records as never)).toBe(canonicalJson(ref.records as never));
  expect(ui.violations).toEqual(ref.monitor.violations);
  const views = (ids: readonly string[], view: (id: string) => unknown) =>
    canonicalJson(ids.map(view) as never);
  expect(
    views(
      [...ref.sim.nodeIds, ...ref.sim.clientIds],
      (id) => f.processes.find((p) => p.id === id)!.view,
    ),
  ).toBe(views([...ref.sim.nodeIds, ...ref.sim.clientIds], (id) => ref.sim.view(id)));
}

describe("time travel", () => {
  it("random seeks, steps, step-backs and live actions always match a fresh replay", () => {
    // TIME_TRAVEL_SEEDS=50 for a thorough local run.
    const seeds = Number(process.env["TIME_TRAVEL_SEEDS"] ?? 3);
    for (let seed = 1; seed <= seeds; seed++) {
      const rng = Rng.fromSeed(seed);
      const scenario = scenarioForSeed(registry, seed, { protocol: "raft" });
      // Small spacing and cap so checkpoints are thinned out repeatedly.
      const host = new SimulationHost(registry, scenario, { every: 40, max: 6 });
      const ui = viewer(host);
      for (let op = 0; op < 40; op++) {
        const kind = rng.int(0, 7);
        if (kind === 0) host.advanceTo(host.now + rng.int(1, 2000));
        else if (kind === 1) host.seek(rng.int(0, scenario.durationMs));
        else if (kind === 2) host.step();
        else if (kind === 3) host.stepBack();
        else if (kind === 4) host.stepBackToNotable();
        else if (kind === 5) host.seekEvent(rng.int(0, Math.max(1, host.events * 2)));
        else if (kind === 6)
          host.act({ type: rng.chance(0.5) ? "crash" : "recover", node: rng.pick(scenario.nodes) });
        else host.stepToNotable();
        expect(host.checkpointCount).toBeLessThanOrEqual(6);
        expectMatchesReplay(host, ui);
      }
    }
  });

  it("forgets the future when a live action changes it", () => {
    const scenario = { ...scenarioForSeed(registry, 4, { protocol: "raft" }), actions: [] };
    const host = new SimulationHost(registry, scenario, { every: 20, max: 1000 });
    const ui = viewer(host);
    host.advanceTo(3000);
    host.seek(1000);
    host.act({ type: "crash", node: scenario.nodes[0]! });
    host.seek(2500); // must not restore a checkpoint from the crash-free future
    expectMatchesReplay(host, ui);
    expect(ui.records.some((r) => r.type === "crash")).toBe(true);
  });

  it("steps back one event at a time", () => {
    const host = new SimulationHost(registry, scenarioForSeed(registry, 6, { protocol: "raft" }));
    const ui = viewer(host);
    host.advanceTo(1500);
    const events = host.events;
    for (let i = 1; i <= 5; i++) {
      expect(host.stepBack()).toBe(true);
      expect(host.events).toBe(events - i);
    }
    expectMatchesReplay(host, ui);
    host.seekEvent(0);
    expect(host.stepBack()).toBe(false);
  });

  it("steps back to the previous notable event", () => {
    const host = new SimulationHost(registry, scenarioForSeed(registry, 7, { protocol: "raft" }));
    const ui = viewer(host);
    host.advanceTo(3000);
    const isNotable = (r: TraceRecord) => r.type === "annotate" && NOTABLE_LABELS.has(r.label);
    for (let i = 0; i < 3; i++) {
      host.stepBackToNotable();
      ui.pull();
      // The last record of the step it stopped after includes a notable annotation.
      const lastStep = ui.records.slice(-8);
      expect(lastStep.some(isNotable)).toBe(true);
    }
    expectMatchesReplay(host, ui);
  });

  it("seeks to a record", () => {
    const host = new SimulationHost(registry, scenarioForSeed(registry, 8, { protocol: "raft" }));
    const ui = viewer(host);
    host.advanceTo(4000);
    host.seekRecord(123);
    ui.pull();
    expect(ui.records.at(-1)!.id).toBeGreaterThanOrEqual(123);
    host.stepBack();
    ui.pull();
    expect(ui.records.at(-1)!.id).toBeLessThan(123);
    expectMatchesReplay(host, ui);
  });
});

describe("branches", () => {
  const withFaults = (seed: number) => scenarioForSeed(registry, seed, { protocol: "raft" });

  it("share history up to the fork and then follow their own actions", () => {
    const scenario = withFaults(12);
    const host = new SimulationHost(registry, scenario, { every: 50, max: 20 });
    const ui = viewer(host);
    host.advanceTo(scenario.durationMs / 3);
    ui.pull();
    const shared = ui.records.slice();
    const main = host.branch;
    const forkT = host.now;
    const branch = host.fork("no faults");
    // Remove every fault that has not happened yet.
    const kept = host
      .scenario()
      .actions.filter((a) => a.atMs <= forkT || a.action.type === "client");
    host.editActions(kept);
    host.advanceTo(scenario.durationMs);
    expectMatchesReplay(host, ui);
    expect(canonicalJson(ui.records.slice(0, shared.length) as never)).toBe(
      canonicalJson(shared as never),
    );
    // A fresh replay of the branch's scenario shares the parent's prefix too.
    const replay = fresh(host.scenario(), 0);
    replay.sim.runUntil(forkT);
    expect(canonicalJson(replay.records.slice(0, shared.length) as never)).toBe(
      canonicalJson(shared as never),
    );

    // Switching keeps the time and truncates only past the shared records.
    host.switchBranch(main);
    const f = ui.pull();
    expect(host.now).toBe(scenario.durationMs);
    expect(f.truncateAfter).toBeGreaterThanOrEqual(shared.length - 1);
    expectMatchesReplay(host, ui);
    host.switchBranch(branch);
    expectMatchesReplay(host, ui);
    expect(host.branches().map((b) => [b.id, b.parent, b.name])).toEqual([
      [main, null, "main"],
      [branch, main, "no faults"],
    ]);
  });

  it("refuse edits to the past", () => {
    const scenario = withFaults(13);
    const host = new SimulationHost(registry, scenario);
    const firstFault = scenario.actions.find((a) => a.action.type !== "client")!;
    host.advanceTo(firstFault.atMs + 1);
    const actions = host.scenario().actions;
    const without = actions.filter(
      (a) => canonicalJson(a as never) !== canonicalJson(firstFault as never),
    );
    expect(without.length).toBe(actions.length - 1);
    expect(() => host.editActions(without)).toThrow(/already processed/);
    expect(() =>
      host.editActions([...actions, { atMs: host.now - 1, action: { type: "crash", node: "A" } }]),
    ).toThrow(/after now/);
    expect(host.scenario().actions).toEqual(actions);
  });

  it("random forks, edits, switches and seeks always match a fresh replay", () => {
    const seeds = Number(process.env["TIME_TRAVEL_SEEDS"] ?? 3);
    for (let seed = 1; seed <= seeds; seed++) {
      const rng = Rng.fromSeed(1000 + seed);
      const scenario = withFaults(seed);
      const host = new SimulationHost(registry, scenario, { every: 40, max: 6 });
      const ui = viewer(host);
      for (let op = 0; op < 40; op++) {
        const kind = rng.int(0, 7);
        if (kind === 0) host.advanceTo(host.now + rng.int(1, 3000));
        else if (kind === 1) host.seek(rng.int(0, scenario.durationMs));
        else if (kind === 2) host.fork();
        else if (kind === 3) host.switchBranch(rng.pick(host.branches()).id);
        else if (kind === 4) host.stepBack();
        else if (kind === 5) {
          // Drop one pending action, or add a crash or recovery soon.
          const actions = host.scenario().actions.slice();
          const pending = actions.filter((a) => a.atMs > host.now);
          if (pending.length > 0 && rng.chance(0.5)) {
            actions.splice(actions.indexOf(rng.pick(pending)), 1);
          } else {
            actions.push({
              atMs: host.now + rng.int(1, 500),
              action: {
                type: rng.chance(0.5) ? "crash" : "recover",
                node: rng.pick(scenario.nodes),
              },
            });
          }
          host.editActions(actions);
        } else if (kind === 6) host.stepBackToNotable();
        else
          host.act({
            type: "network",
            change: { type: "isolate", node: rng.pick(scenario.nodes) },
          });
        expectMatchesReplay(host, ui);
      }
    }
  });
});

describe("comparing branches", () => {
  it("finds where a what-if branch diverges and how the outcomes differ", () => {
    const scenario = Raft.figure8Scenario("raft-bug-commit-old-terms");
    const host = new SimulationHost(registry, scenario);
    host.advanceTo(350);
    const main = host.branch;
    const branch = host.fork("no crash E");
    const same = host.compare(main);
    expect(same.divergence).toBeNull();
    expect(same.processes).toEqual([]);

    host.editActions(
      host.scenario().actions.filter((a) => !(a.atMs === 400 && a.action.type === "crash")),
    );
    host.advanceTo(1400);
    const before = host.frame();
    const c = host.compare(main);
    expect(c.t).toBe(1400);
    const [mine, theirs] = c.divergent;
    expect(theirs).toMatchObject({ type: "crash", node: "E", t: 400 });
    expect(mine!.t).toBeGreaterThanOrEqual(400);
    expect(c.outcomes[0]).toMatchObject({ branch, violations: [] });
    expect(c.outcomes[1].branch).toBe(main);
    expect(c.outcomes[1].violations[0]?.invariant).toBe("leader-completeness");
    expect(c.processes.find((p) => p.id === "E")?.up).toEqual([true, true]);
    expect(c.processes.length).toBeGreaterThan(0);
    // The current run is untouched.
    expect(host.branch).toBe(branch);
    expect(host.now).toBe(1400);
    const after = host.frame();
    expect(after.truncateAfter).toBeNull();
    expect(after.records).toEqual([]);
    expect(after.events).toBe(before.events);
  });
});

describe("minimized branches", () => {
  it("open a minimized failure as a branch that fails the same way", () => {
    const protocol = "raft-bug-no-sessions";
    const scenario = scenarioForSeed(registry, 3, { protocol });
    const progress: number[] = [];
    const result = minimizeFailure(registry, scenario, (best) =>
      progress.push(best.actions.length),
    )!;
    expect(result.kind).toBe("safety:client-chains");
    expect(progress.length).toBeGreaterThan(0);
    // Identical to what `sim fuzz` reports for this seed.
    const fuzzed = fuzz(registry, { protocol, seeds: 1, firstSeed: 3 });
    expect(result.minimized).toEqual(fuzzed.failures[0]!.minimized);

    const host = new SimulationHost(registry, scenario);
    const ui = viewer(host);
    host.advanceTo(2000);
    const main = host.branch;
    host.addBranch("minimized", result.minimized);
    expect(host.now).toBe(2000);
    host.advanceTo(scenario.durationMs);
    expectMatchesReplay(host, ui);
    expect(ui.violations[0]?.invariant).toBe("client-chains");
    expect(host.scenario()).toEqual({ ...result.minimized, durationMs: scenario.durationMs });
    host.switchBranch(main);
    expectMatchesReplay(host, ui);
    expect(() => host.addBranch("other seed", { ...scenario, seed: 99 })).toThrow(/seed/);
  });
});
