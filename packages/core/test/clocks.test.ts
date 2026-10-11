import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FixedLatencyNetwork,
  Simulation,
  TraceRecorder,
  type Protocol,
  type ScheduledAction,
  type TraceRecord,
} from "../src/index.ts";

/**
 * Each node runs a chain of timers with the given local delays (cycling), and records the
 * local and true time at every firing.
 */
function ticker(delays: readonly number[]): Protocol<null, { n: number }, never> {
  return {
    name: "ticker",
    init(ctx) {
      ctx.setTimer("tick", delays[0]!);
      return { persistent: null, volatile: { n: 0 } };
    },
    recover(ctx) {
      ctx.setTimer("tick", delays[0]!);
      return { persistent: null, volatile: { n: 0 } };
    },
    onMessage() {},
    onClientCommand() {},
    onTimer(ctx, s) {
      ctx.annotate("tick", { local: ctx.localNow, n: s.volatile.n });
      s.volatile.n++;
      ctx.setTimer("tick", delays[s.volatile.n % delays.length]!);
    },
    view: (s) => s.volatile.n,
  };
}

type Action = ScheduledAction<never, never>;

function run(
  delays: readonly number[],
  options: { rates?: Record<string, number>; actions?: Action[]; untilMs?: number } = {},
) {
  const rec = new TraceRecorder();
  const sim = new Simulation({
    protocol: ticker(delays),
    nodes: ["A", "B"],
    seed: 1,
    network: new FixedLatencyNetwork(1),
    actions: options.actions ?? [],
    sinks: [rec.sink],
    ...(options.rates === undefined ? {} : { clockRates: options.rates }),
  });
  sim.runUntil(options.untilMs ?? 1000);
  return { sim, rec };
}

const ticks = (records: readonly TraceRecord[], node: string) =>
  records.flatMap((r) =>
    r.type === "annotate" && r.label === "tick" && r.node === node
      ? [{ t: r.t, local: (r.data as { local: number }).local }]
      : [],
  );

describe("local clocks", () => {
  it("fire timers after their delay in local time", () => {
    const { rec, sim } = run([100], { rates: { A: 2, B: 0.5 } });
    expect(ticks(rec.records, "A").slice(0, 3)).toEqual([
      { t: 50, local: 100 },
      { t: 100, local: 200 },
      { t: 150, local: 300 },
    ]);
    expect(ticks(rec.records, "B").slice(0, 2)).toEqual([
      { t: 200, local: 100 },
      { t: 400, local: 200 },
    ]);
    expect(sim.localClock("A")).toEqual({ now: 2000, rate: 2 });
    expect(sim.localClock("B")).toEqual({ now: 500, rate: 0.5 });
  });

  it("re-arm pending timers when the rate changes", () => {
    // A's 100ms timer is 40 local ms in at t=40; at rate 4 the other 60 take 15 true ms.
    const { rec } = run([100], {
      actions: [{ atMs: 40, action: { type: "clock", node: "A", rate: 4 } }],
      untilMs: 100,
    });
    expect(ticks(rec.records, "A").slice(0, 2)).toEqual([
      { t: 55, local: 100 },
      { t: 80, local: 200 },
    ]);
    expect(rec.records.find((r) => r.type === "clock")).toMatchObject({ node: "A", rate: 4 });
    // B is unaffected.
    expect(ticks(rec.records, "B")[0]).toEqual({ t: 100, local: 100 });
  });

  it("keep running while a process is down", () => {
    const { sim } = run([100], {
      rates: { A: 1.5 },
      actions: [
        { atMs: 10, action: { type: "crash", node: "A" } },
        { atMs: 500, action: { type: "recover", node: "A" } },
      ],
    });
    expect(sim.localClock("A").now).toBe(1500);
  });

  it("reject rates that are not positive, and unknown processes", () => {
    expect(() => run([100], { rates: { A: 0 } })).toThrow(/positive/);
    expect(() => run([100], { rates: { Z: 1 } })).toThrow(/unknown process/);
    expect(() =>
      run([100], { actions: [{ atMs: 1, action: { type: "clock", node: "A", rate: -1 } }] }),
    ).toThrow(/positive/);
  });

  const rateArb = fc.double({ min: 0.25, max: 4, noNaN: true });
  const scenarioArb = fc.record({
    delays: fc.array(fc.integer({ min: 1, max: 120 }), { minLength: 1, maxLength: 4 }),
    rates: fc.record({ A: rateArb, B: rateArb }),
    changes: fc.array(
      fc.record({
        atMs: fc.integer({ min: 0, max: 900 }),
        node: fc.constantFrom("A", "B"),
        rate: rateArb,
      }),
      { maxLength: 6 },
    ),
  });

  it("fire every timer when its node's local clock has advanced by the delay", () => {
    fc.assert(
      fc.property(scenarioArb, ({ delays, rates, changes }) => {
        const actions: Action[] = changes
          .sort((a, b) => a.atMs - b.atMs)
          .map((c) => ({ atMs: c.atMs, action: { type: "clock", node: c.node, rate: c.rate } }));
        const { rec } = run(delays, { rates, actions });
        for (const node of ["A", "B"]) {
          // Each timer is armed at the previous firing (or at 0) and must fire once the
          // local clock has advanced by its delay. Times are rounded to microseconds, so
          // allow a few microseconds of local time per timer.
          let armedAt = 0;
          ticks(rec.records, node).forEach((tick, i) => {
            expect(Math.abs(tick.local - armedAt - delays[i % delays.length]!)).toBeLessThan(0.01);
            armedAt = tick.local;
          });
          expect(ticks(rec.records, node).length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("restore from a saved state and continue identically", () => {
    fc.assert(
      fc.property(
        scenarioArb,
        fc.integer({ min: 1, max: 999 }),
        ({ delays, rates, changes }, cut) => {
          const actions: Action[] = changes
            .sort((a, b) => a.atMs - b.atMs)
            .map((c) => ({ atMs: c.atMs, action: { type: "clock", node: c.node, rate: c.rate } }));
          const full = run(delays, { rates, actions });
          const rec = new TraceRecorder();
          const sim = new Simulation({
            protocol: ticker(delays),
            nodes: ["A", "B"],
            seed: 1,
            network: new FixedLatencyNetwork(1),
            actions,
            clockRates: rates,
          });
          sim.runUntil(cut);
          const copy = new Simulation({
            protocol: ticker(delays),
            nodes: ["A", "B"],
            seed: 1,
            network: new FixedLatencyNetwork(1),
            clockRates: rates,
          });
          copy.loadState(structuredClone(sim.saveState()));
          copy.addSink(rec.sink);
          copy.runUntil(1000);
          const after = full.rec.records.filter((r) => r.id > sim.lastRecordId);
          expect(rec.records).toEqual(after);
        },
      ),
      { numRuns: 200 },
    );
  });
});
