import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  defaultRegistry,
  failureKind,
  fuzz,
  generateScenario,
  minimizeScenario,
  Raft,
  runScenario,
  type Scenario,
} from "../src/index.ts";

const registry = defaultRegistry();

describe("scenario generation", () => {
  it("is a pure function of seed and options", () => {
    const a = generateScenario(42, { protocol: "raft" });
    expect(canonicalJson(a)).toBe(canonicalJson(generateScenario(42, { protocol: "raft" })));
    expect(canonicalJson(a)).not.toBe(canonicalJson(generateScenario(43, { protocol: "raft" })));
  });

  it("keeps faults inside the window and repairs everything after it", () => {
    for (let seed = 0; seed < 50; seed++) {
      const s = generateScenario(seed, {
        protocol: "raft",
        faultWindowMs: 5000,
        stabilizeMs: 3000,
      });
      const times = s.actions.map((a) => a.atMs);
      expect(times).toEqual([...times].sort((x, y) => x - y));
      const repairs = s.actions.filter((a) => a.atMs === 5000);
      expect(repairs.map((a) => a.action.type).sort()).toEqual(
        ["network", ...s.nodes.map(() => "recover")].sort(),
      );
      expect(s.actions.filter((a) => a.atMs > 5000)).toEqual([]);
      expect(s.durationMs).toBe(8000);
    }
  });

  it("round-trips through JSON", () => {
    const s = generateScenario(7, { protocol: "raft" });
    const parsed = JSON.parse(JSON.stringify(s)) as Scenario;
    expect(runScenario(registry, parsed).traceHash).toBe(runScenario(registry, s).traceHash);
  });
});

describe("runScenario", () => {
  it("reproduces identical traces", () => {
    const s = generateScenario(3, { protocol: "raft" });
    const a = runScenario(registry, s, { keepTrace: true });
    const b = runScenario(registry, s, { keepTrace: true });
    expect(a.traceHash).toBe(b.traceHash);
    expect(a.trace).toEqual(b.trace);
    expect(a.events).toBeGreaterThan(1000);
  });

  it("rejects unknown protocols and versions", () => {
    const s = generateScenario(1, { protocol: "nope" });
    expect(() => runScenario(registry, s)).toThrow(/unknown protocol/);
    expect(() => runScenario(registry, { ...s, protocol: "raft", version: 99 })).toThrow(/version/);
  });

  it("reports liveness failures when progress is impossible", () => {
    // Crash a majority for good: no leader can exist at the end.
    const s: Scenario = {
      ...generateScenario(1, { protocol: "raft", clusterSizes: [3] }),
      actions: [
        { atMs: 100, action: { type: "crash", node: "A" } },
        { atMs: 100, action: { type: "crash", node: "B" } },
      ],
    };
    const r = runScenario(registry, s);
    expect(r.violations).toEqual([]);
    expect(failureKind(r)).toBe("liveness");
  });
});

describe("chaos testing", () => {
  it("finds no safety or liveness failures in correct Raft", () => {
    const report = fuzz(registry, { protocol: "raft", seeds: 150, minimize: false });
    expect(report.failures.map((f) => f.result.scenario.seed)).toEqual([]);
    expect(report.runs).toBe(150);
  });

  for (const bug of Object.keys(Raft.RAFT_BUGS)) {
    it(`catches the planted bug "${bug}" and minimizes the counterexample`, () => {
      const report = fuzz(registry, { protocol: `raft-bug-${bug}`, seeds: 100 });
      expect(report.failures).toHaveLength(1);
      const { result, minimized } = report.failures[0]!;
      expect(result.violations.length).toBeGreaterThan(0);
      expect(minimized.actions.length).toBeLessThanOrEqual(result.scenario.actions.length);
      // The minimized scenario reproduces the same failure on its own.
      expect(failureKind(runScenario(registry, minimized))).toBe(failureKind(result));
    });
  }
});

describe("minimizeScenario", () => {
  it("drops every action the predicate does not need", () => {
    const s = generateScenario(5, { protocol: "raft" });
    const needed = s.actions[2]!;
    const min = minimizeScenario(s, (c) => c.actions.includes(needed));
    expect(min.actions).toEqual([needed]);
    expect(min.network.defaults).toMatchObject({ loss: 0, duplicate: 0, jitterMs: 0 });
  });
});
