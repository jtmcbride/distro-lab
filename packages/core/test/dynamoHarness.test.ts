import { describe, expect, it } from "vitest";
import {
  defaultRegistry,
  Dynamo,
  failureKind,
  fuzz,
  minimizeScenario,
  runScenario,
  scenarioForSeed,
} from "../src/index.ts";

const registry = defaultRegistry();

describe("Dynamo chaos testing", () => {
  it("finds no safety or liveness failures in correct Dynamo", () => {
    const report = fuzz(registry, { protocol: "dynamo", seeds: 60, minimize: false });
    expect(report.failures.map((f) => f.result.scenario.seed)).toEqual([]);
    expect(report.runs).toBe(60);
  });

  // First seed at which `sim fuzz` catches each bug with the current generator (re-measure
  // with `sim fuzz --protocol dynamo-bug-<name>` if the generator changes).
  const CAUGHT_AT: Record<Dynamo.DynamoBug, [number, string]> = {
    "reused-counter": [0, "unique-dots"],
    "volatile-counter": [0, "replicas-monotonic"],
    "last-writer-wins": [0, "replicas-monotonic"],
    "plain-clocks": [0, "replicas-monotonic"],
    "vector-contexts": [0, "replicas-monotonic"],
    "early-ack": [0, "acknowledged-writes-durable"],
    "overwriting-repair": [19, "replicas-monotonic"],
  };
  for (const [bug, [seed, invariant]] of Object.entries(CAUGHT_AT)) {
    it(`catches the planted bug "${bug}" and minimizes the counterexample`, () => {
      const protocol = `dynamo-bug-${bug}`;
      const scenario = scenarioForSeed(registry, seed, { protocol });
      const result = runScenario(registry, scenario);
      expect(result.violations[0]?.invariant).toBe(invariant);
      const kind = failureKind(result);
      const minimized = minimizeScenario(
        scenario,
        (s) => failureKind(runScenario(registry, s)) === kind,
      );
      expect(minimized.actions.length).toBeLessThanOrEqual(scenario.actions.length);
      expect(failureKind(runScenario(registry, minimized))).toBe(kind);
      // The same seed is clean on correct Dynamo.
      expect(runScenario(registry, { ...scenario, protocol: "dynamo" }).violations).toEqual([]);
    });
  }
});
