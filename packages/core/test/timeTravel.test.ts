import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  defaultRegistry,
  NOTABLE_LABELS,
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
        expect(host.checkpointCount).toBeLessThanOrEqual(6 + 1);
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
