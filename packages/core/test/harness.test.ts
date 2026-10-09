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

describe("liveness", () => {
  it("passes when the cluster converges during the window, even if the end is transient", () => {
    // Found by fuzzing: a heartbeat lost to ambient loss starts an election 60ms before the
    // end; an end-of-run snapshot catches followers that have not heard from the new leader.
    const s = generateScenario(8091, { protocol: "raft" });
    expect(runScenario(registry, { ...s, actions: [] }).liveness).toEqual([]);
  });
});

describe("chaos testing", () => {
  it("finds no safety or liveness failures in correct Raft", () => {
    const report = fuzz(registry, { protocol: "raft", seeds: 60, minimize: false });
    expect(report.failures.map((f) => f.result.scenario.seed)).toEqual([]);
    expect(report.runs).toBe(60);
  });

  // commit-old-terms needs the exact Figure 8 interleaving; figure8.test.ts covers it.
  const fuzzable = Object.keys(Raft.RAFT_BUGS).filter((b) => b !== "commit-old-terms");
  for (const bug of fuzzable) {
    it(`catches the planted bug "${bug}" and minimizes the counterexample`, () => {
      const report = fuzz(registry, { protocol: `raft-bug-${bug}`, seeds: 150 });
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
  it("drops every fault the predicate does not need, but keeps repairs", () => {
    const s = generateScenario(5, { protocol: "raft" });
    const needed = s.actions[2]!;
    const repairs = s.actions.filter((a) => a.atMs >= s.durationMs - s.livenessAfterMs!);
    expect(repairs.length).toBeGreaterThan(0);
    const min = minimizeScenario(s, (c) => c.actions.includes(needed));
    expect(min.actions).toEqual([needed, ...repairs]);
    expect(min.network.defaults).toMatchObject({ loss: 0, duplicate: 0, jitterMs: 0 });
  });
});
