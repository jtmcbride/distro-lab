import { describe, expect, it } from "vitest";
import { defaultRegistry, Raft, SimulationHost } from "@distro-lab/core";
import { applyFrame, useSim } from "./store.ts";
import { trace } from "./trace.ts";

describe("applyFrame", () => {
  it("appends records and violations, and resets on a reset frame", () => {
    const host = new SimulationHost(
      defaultRegistry(),
      Raft.figure8Scenario("raft-bug-commit-old-terms"),
    );
    applyFrame(host.frame());
    const afterInit = trace.length;
    expect(afterInit).toBeGreaterThan(0);
    host.advanceTo(1500);
    applyFrame(host.frame());
    expect(trace.length).toBeGreaterThan(afterInit);
    expect(trace.map((r) => r.id)).toEqual(trace.map((_, i) => i));
    expect(useSim.getState().violations.length).toBeGreaterThan(0);
    const version = useSim.getState().traceVersion;

    host.seek(100);
    applyFrame(host.frame());
    expect(trace.every((r) => r.t <= 100)).toBe(true);
    expect(useSim.getState()).toMatchObject({ now: 100, violations: [] });
    expect(useSim.getState().traceVersion).toBe(version + 1);
  });
});
