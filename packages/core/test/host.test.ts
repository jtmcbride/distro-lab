import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  defaultRegistry,
  Hasher,
  Raft,
  runScenario,
  scenarioForSeed,
  SimulationHost,
  type Frame,
  type Scenario,
  type TraceRecord,
} from "../src/index.ts";

const registry = defaultRegistry();
const scenario = (seed = 3): Scenario => ({
  ...scenarioForSeed(registry, seed, { protocol: "raft" }),
  // Interactive sessions start without pre-scheduled faults; the test adds them live.
  actions: [],
});

/** Collects every record the host reports across frames. */
function collector(host: SimulationHost) {
  const records: TraceRecord[] = [];
  const frames: Frame[] = [];
  const pull = () => {
    const f = host.frame();
    if (f.reset) records.length = 0;
    records.push(...f.records);
    frames.push(f);
    return f;
  };
  return { records, frames, pull };
}

const hash = (records: readonly TraceRecord[]) => {
  const h = new Hasher();
  for (const r of records) h.update(canonicalJson(r)).update("\n");
  return h.digest();
};

describe("SimulationHost", () => {
  it("records live actions so the exported scenario replays to the same trace", () => {
    const host = new SimulationHost(registry, scenario());
    const { records, pull } = collector(host);
    host.playing = true;
    host.speed = 1;
    // Irregular frame times, with actions landing between and at odd instants.
    const ticks = [16, 33, 7, 120, 16, 250, 3, 400, 16, 16, 900, 61];
    ticks.forEach((ms, i) => {
      host.tick(ms);
      if (i === 3) host.act({ type: "crash", node: "A" });
      if (i === 4)
        host.act({ type: "client", node: "c1", command: { type: "put", key: "x", value: "1" } });
      if (i === 6)
        host.act({ type: "network", change: { type: "partition", groups: [["A", "B"]] } });
      if (i === 8) host.act({ type: "recover", node: "A" });
      if (i === 9) host.act({ type: "network", change: { type: "heal" } });
      pull();
    });
    host.step();
    host.stepToNotable();
    pull();

    const exported = JSON.parse(JSON.stringify(host.scenario())) as Scenario;
    expect(exported.actions.length).toBe(5);
    const replay = runScenario(
      registry,
      { ...exported, durationMs: host.now },
      { keepTrace: true, stopOnViolation: false },
    );
    expect(replay.trace!.length).toBe(records.length);
    expect(replay.traceHash).toBe(hash(records));
  });

  it("seeks by replaying, matching a fresh run to that time", () => {
    const host = new SimulationHost(registry, scenario(5));
    const { records, pull } = collector(host);
    host.advanceTo(800);
    host.act({ type: "crash", node: "B" });
    host.advanceTo(2000);
    pull();
    host.seek(1200);
    const f = pull();
    expect(f.reset).toBe(true);
    expect(host.now).toBe(1200);
    const fresh = runScenario(
      registry,
      { ...host.scenario(), durationMs: 1200 },
      { keepTrace: true, stopOnViolation: false },
    );
    expect(hash(records)).toBe(fresh.traceHash);
    // The live crash survived the seek.
    expect(records.some((r) => r.type === "crash" && r.node === "B")).toBe(true);
  });

  it("reports each record and violation once, and resets on load", () => {
    const host = new SimulationHost(registry, Raft.figure8Scenario("raft-bug-commit-old-terms"));
    const first = host.frame();
    expect(first.reset).toBe(true);
    expect(first.records.some((r) => r.type === "init")).toBe(true);
    host.advanceTo(700);
    const second = host.frame();
    expect(second.reset).toBe(false);
    expect(second.violations[0]?.invariant).toBe("leader-completeness");
    host.advanceTo(800);
    const third = host.frame();
    expect(third.records.every((r) => r.id > second.records.at(-1)!.id)).toBe(true);
    expect(third.violations.map((v) => v.invariant)).not.toContain("leader-completeness");
    host.load(scenario());
    expect(host.frame()).toMatchObject({ reset: true, now: 0, playing: false });
  });

  it("plays only while playing, at its speed", () => {
    const host = new SimulationHost(registry, scenario());
    host.tick(1000);
    expect(host.now).toBe(0);
    host.playing = true;
    host.speed = 0.5;
    host.tick(1000);
    expect(host.now).toBe(500);
  });

  it("steps to the next notable event", () => {
    const host = new SimulationHost(registry, scenario());
    const { records, pull } = collector(host);
    expect(host.stepToNotable()).toBe(true);
    pull();
    // It stops after the event whose handler made the annotation (which may also send).
    const labels = () => records.flatMap((r) => (r.type === "annotate" ? [r.label] : []));
    expect(labels()).toEqual(["electionStarted"]);
    host.stepToNotable();
    pull();
    expect(
      records.filter((r) => r.type === "annotate").map((r) => (r as { label: string }).label),
    ).toContain("becameLeader");
  });

  it("exposes process state, including clients and armed timers", () => {
    const host = new SimulationHost(registry, scenario());
    host.advanceTo(1000);
    const f = host.frame();
    expect(f.processes.map((p) => p.role)).toContain("client");
    const leader = f.processes.find((p) => (p.view as Raft.RaftView).role === "leader")!;
    expect(leader.timers.map((t) => t.key)).toEqual(["heartbeat"]);
    expect(leader.timers[0]!.at).toBeGreaterThan(1000);
  });
});
