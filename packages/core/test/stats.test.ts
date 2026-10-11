import { describe, expect, it } from "vitest";
import { operationStats, type HistoryOp } from "../src/index.ts";

const op = (type: string, invokedAt: number, completedAt: number | null): HistoryOp => ({
  id: `c#${invokedAt}`,
  client: "c",
  seq: invokedAt,
  input: { type, key: "x" },
  output: completedAt === null ? null : { ok: true },
  invokedAt,
  completedAt,
  invokeRecord: invokedAt,
  completeRecord: completedAt,
});

describe("operationStats", () => {
  it("summarizes latency per operation kind across runs", () => {
    const gets = Array.from({ length: 100 }, (_, i) => op("get", i * 1000, i * 1000 + i + 1));
    const stats = operationStats([gets.slice(0, 50), [...gets.slice(50), op("put", 5, null)]]);
    expect(stats).toEqual({
      get: { invoked: 100, completed: 100, p50: 50, p90: 90, p99: 99, max: 100 },
      put: { invoked: 1, completed: 0, p50: null, p90: null, p99: null, max: null },
    });
  });
});
