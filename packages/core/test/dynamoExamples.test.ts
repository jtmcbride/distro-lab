import { describe, expect, it } from "vitest";
import { defaultRegistry, Dynamo, runScenario, type TraceRecord } from "../src/index.ts";

const registry = defaultRegistry();

function run(scenario: ReturnType<typeof Dynamo.concurrentWritesScenario>) {
  const result = runScenario(registry, scenario, { keepTrace: true });
  const completions = (client: string) =>
    (result.trace ?? [])
      .filter(
        (r): r is Extract<TraceRecord, { type: "annotate" }> =>
          r.type === "annotate" && r.label === "complete" && r.node === client,
      )
      .map((r) => ({ t: r.t, result: (r.data as { result: Dynamo.DynamoResult }).result }));
  const values = (r: Dynamo.DynamoResult) =>
    r.type === "get" ? r.versions.map((v) => v.value).sort() : null;
  const labels = (label: string) =>
    (result.trace ?? []).filter((r) => r.type === "annotate" && r.label === label);
  return { result, completions, values, labels };
}

describe("Dynamo examples", () => {
  it("concurrent writes: siblings appear, then a writer that read them resolves them", () => {
    const { result, completions, values } = run(Dynamo.concurrentWritesScenario());
    expect(result.violations).toEqual([]);
    const c1 = completions("c1");
    expect(values(c1[1]!.result)).toEqual(["eggs", "milk"]);
    expect(values(completions("c2")[1]!.result)).toEqual(["milk+eggs"]);
  });

  it("sloppy quorum: an acknowledged write is missing from a read until handoff", () => {
    const scenario = Dynamo.sloppyQuorumScenario();
    const { result, completions, values, labels } = run(scenario);
    expect(result.violations).toEqual([]);
    const [put] = completions("c1");
    const [stale, fresh] = completions("c2");
    expect(put!.result.type).toBe("put");
    expect(labels("fallback").length).toBeGreaterThan(0);
    // c2's read started after the put was acknowledged, during the partition: it misses it.
    expect(put!.t).toBeLessThan(1000);
    expect(stale!.t).toBeLessThan(4000);
    expect(values(stale!.result)).toEqual([]);
    expect(labels("handedOff").length).toBeGreaterThan(0);
    expect(values(fresh!.result)).toEqual(["milk"]);
    // The checker does not flag it: sloppy quorums do not promise read-your-writes.
    expect(Dynamo.promisesReadYourWrites({ ...Dynamo.DEFAULT_DYNAMO_CONFIG, sloppy: true })).toBe(
      false,
    );
  });

  it("strict quorum: the same write is unavailable until the partition heals", () => {
    const { result, completions, values, labels } = run(Dynamo.strictQuorumScenario());
    expect(result.violations).toEqual([]);
    const [put] = completions("c1");
    expect(labels("unavailable").length).toBeGreaterThan(0);
    expect(labels("fallback")).toEqual([]);
    expect(put!.t).toBeGreaterThan(4000);
    expect(values(completions("c2")[1]!.result)).toEqual(["milk"]);
  });
});
