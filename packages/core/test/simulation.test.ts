import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FixedLatencyNetwork,
  Simulation,
  TraceRecorder,
  type Network,
  type Protocol,
  type ScheduledAction,
  type TraceRecord,
} from "../src/index.ts";
import { toyProtocol, type ToyCommand } from "./toyProtocol.ts";

const NODES = ["A", "B", "C"];

function run(seed: number, actions: ScheduledAction<ToyCommand, never>[] = [], untilMs = 500) {
  const rec = new TraceRecorder();
  const sim = new Simulation({
    protocol: toyProtocol,
    nodes: NODES,
    seed,
    network: new FixedLatencyNetwork(3),
    actions,
    sinks: [rec.sink],
  });
  sim.runUntil(untilMs);
  return { sim, rec, records: rec.records };
}

const of = <T extends TraceRecord["type"]>(records: TraceRecord[], type: T) =>
  records.filter((r): r is Extract<TraceRecord, { type: T }> => r.type === type);

const actionArb = fc.oneof(
  fc.record({ type: fc.constant("crash" as const), node: fc.constantFrom(...NODES) }),
  fc.record({ type: fc.constant("recover" as const), node: fc.constantFrom(...NODES) }),
  fc.record({
    type: fc.constant("client" as const),
    node: fc.constantFrom(...NODES),
    command: fc.record({ set: fc.integer({ min: 0, max: 100 }) }),
  }),
);
const scheduleArb = fc.array(fc.record({ atMs: fc.nat(400), action: actionArb }), {
  maxLength: 15,
});

describe("Simulation determinism", () => {
  it("produces identical traces for identical inputs", () => {
    fc.assert(
      fc.property(fc.integer(), scheduleArb, (seed, actions) => {
        const a = run(seed, actions);
        const b = run(seed, actions);
        expect(a.rec.hash()).toBe(b.rec.hash());
        expect(a.rec.size).toBe(b.rec.size);
      }),
      { numRuns: 50 },
    );
  });

  it("replays from its exported action log", () => {
    const first = run(11, [{ atMs: 40, action: { type: "crash", node: "B" } }], 100);
    first.sim.schedule(150, { type: "recover", node: "B" });
    first.sim.schedule(160, { type: "client", node: "A", command: { set: 7 } });
    first.sim.runUntil(500);
    const replay = run(first.sim.seedValue, [...first.sim.actions()]);
    expect(replay.rec.hash()).toBe(first.rec.hash());
  });

  it("diverges for different seeds", () => {
    expect(run(1).rec.hash()).not.toBe(run(2).rec.hash());
  });

  it("keeps node randomness independent of network randomness", () => {
    // Init timers come from node streams; a network that draws a lot must not perturb them.
    const noisy: Network = {
      onSend: (_f, _t, _n, rng) => ({ delays: [rng.int(1, 50)] }),
      canDeliver: () => true,
      apply: () => undefined,
    };
    const firstTimers = (network: Network) => {
      const rec = new TraceRecorder();
      const sim = new Simulation({
        protocol: toyProtocol,
        nodes: NODES,
        seed: 9,
        network,
        sinks: [rec.sink],
      });
      sim.runUntil(200);
      return of(rec.records, "timer")
        .filter((r) => r.cause !== null && r.cause < NODES.length)
        .map((r) => [r.node, r.t]);
    };
    expect(firstTimers(noisy)).toEqual(firstTimers(new FixedLatencyNetwork(3)));
  });
});

describe("Simulation causality", () => {
  it("links every record to an earlier cause of the right kind", () => {
    fc.assert(
      fc.property(fc.integer(), scheduleArb, (seed, actions) => {
        const { records } = run(seed, actions);
        const byId = new Map(records.map((r) => [r.id, r]));
        records.forEach((r, i) => {
          expect(r.id).toBe(i);
          if (i > 0) expect(r.t).toBeGreaterThanOrEqual(records[i - 1]!.t);
          if (r.cause !== null) expect(r.cause).toBeLessThan(r.id);
          if (r.type === "deliver" || r.type === "drop") {
            const send = byId.get(r.send);
            expect(send?.type).toBe("send");
            expect(r.cause).toBe(r.send);
            if (send?.type === "send") expect([send.from, send.to]).toEqual([r.from, r.to]);
          }
          if (["init", "crash", "recover", "client", "network"].includes(r.type)) {
            expect(r.cause).toBeNull();
          }
        });
      }),
      { numRuns: 50 },
    );
  });
});

describe("Simulation node lifecycle", () => {
  it("stops a crashed node and drops messages addressed to it", () => {
    const { records, sim } = run(3, [{ atMs: 50, action: { type: "crash", node: "B" } }]);
    const after = records.filter((r) => r.t > 50);
    expect(of(after, "timer").some((r) => r.node === "B")).toBe(false);
    expect(of(after, "send").some((r) => r.from === "B")).toBe(false);
    expect(of(after, "deliver").some((r) => r.to === "B")).toBe(false);
    expect(of(after, "drop").some((r) => r.to === "B" && r.reason === "node-down")).toBe(true);
    expect(sim.isUp("B")).toBe(false);
  });

  it("delivers messages a node sent before it crashed", () => {
    // Sends happen at timer ticks; crash just after a send, before its 3ms delivery.
    const probe = run(4, [], 100).records;
    const send = of(probe, "send").find((r) => r.from === "A" && r.t > 20)!;
    const { records } = run(4, [{ atMs: send.t + 1, action: { type: "crash", node: "A" } }]);
    const delivered = of(records, "deliver").find((r) => r.send === send.id);
    expect(delivered?.t).toBe(send.t + 3);
  });

  it("recovers with durable state only and ignores timers from the old incarnation", () => {
    const { records, sim } = run(5, [
      { atMs: 0, action: { type: "client", node: "C", command: { set: 40 } } },
      { atMs: 100, action: { type: "crash", node: "C" } },
      { atMs: 101, action: { type: "recover", node: "C" } },
    ]);
    const recovered = of(records, "annotate").find((r) => r.label === "recovered");
    expect(recovered?.node).toBe("C");
    expect((recovered?.data as { counter: number }).counter).toBeGreaterThan(40);
    // Exactly one tick timer is live after recovery: ticks are ≥10ms apart.
    const ticks = of(records, "timer").filter((r) => r.node === "C" && r.t > 101);
    ticks.slice(1).forEach((r, i) => expect(r.t - ticks[i]!.t).toBeGreaterThanOrEqual(10));
    expect(sim.view("C")).toMatchObject({ received: expect.any(Number) });
  });

  it("discards timers armed before a crash even if recovery does not re-arm them", () => {
    const late = (crash: boolean) =>
      of(
        run(8, [
          { atMs: 10, action: { type: "client", node: "A", command: { timer: "arm-late" } } },
          ...(crash
            ? ([
                { atMs: 20, action: { type: "crash", node: "A" } },
                { atMs: 30, action: { type: "recover", node: "A" } },
              ] as const)
            : []),
        ]).records,
        "annotate",
      ).filter((r) => r.label === "late-fired");
    expect(late(false)).toHaveLength(1);
    expect(late(true)).toHaveLength(0);
  });

  it("ignores crash of a crashed node and recover of a live one", () => {
    const { records } = run(6, [
      { atMs: 10, action: { type: "recover", node: "A" } },
      { atMs: 20, action: { type: "crash", node: "A" } },
      { atMs: 30, action: { type: "crash", node: "A" } },
    ]);
    expect(of(records, "crash")).toHaveLength(1);
    expect(of(records, "recover")).toHaveLength(0);
  });

  it("applies effects in order, so arm-then-cancel never fires", () => {
    const { records } = run(7, [
      { atMs: 5, action: { type: "client", node: "A", command: { timer: "arm-and-cancel" } } },
    ]);
    expect(of(records, "timer").some((r) => r.key === "extra")).toBe(false);
  });
});

describe("Simulation isolation and validation", () => {
  it("gives every delivered copy its own message", () => {
    const dup: Network = {
      onSend: () => ({ delays: [2, 2] }),
      canDeliver: () => true,
      apply: () => undefined,
    };
    const seen: number[][] = [];
    const spy: Protocol<null, null, number[]> = {
      name: "spy",
      init: (ctx) => {
        if (ctx.nodeId === "A") ctx.send("B", [1]);
        return { persistent: null, volatile: null };
      },
      recover: () => ({ persistent: null, volatile: null }),
      onMessage: (_ctx, _s, _from, m) => {
        seen.push([...m]);
        m.push(2);
      },
      onTimer: () => undefined,
      onClientCommand: () => undefined,
      view: () => null,
    };
    const sim = new Simulation({ protocol: spy, nodes: ["A", "B"], seed: 1, network: dup });
    sim.runUntil(10);
    expect(seen).toEqual([[1], [1]]);
  });

  it("drops in-flight messages when the network says the link is down at delivery", () => {
    let up = true;
    const net: Network<"cut"> = {
      onSend: () => ({ delays: [5] }),
      canDeliver: () => up,
      apply: () => {
        up = false;
      },
    };
    const rec = new TraceRecorder();
    const sim = new Simulation({
      protocol: toyProtocol,
      nodes: NODES,
      seed: 2,
      network: net,
      sinks: [rec.sink],
    });
    sim.runUntil(16);
    sim.schedule(16, { type: "network", change: "cut" });
    sim.runUntil(40);
    expect(of(rec.records, "drop").some((r) => r.reason === "link-down")).toBe(true);
    expect(of(rec.records, "deliver").some((r) => r.t > 16)).toBe(false);
  });

  it("rejects bad inputs", () => {
    const sim = run(1, [], 50).sim;
    expect(() => sim.schedule(10, { type: "crash", node: "A" })).toThrow(RangeError);
    expect(() => sim.schedule(60, { type: "crash", node: "Z" })).toThrow(/unknown node/);
    expect(
      () =>
        new Simulation({
          protocol: toyProtocol,
          nodes: ["A", "A"],
          seed: 1,
          network: new FixedLatencyNetwork(1),
        }),
    ).toThrow(/duplicate/);
  });

  it("refuses messages that are not plain data", () => {
    const bad: Protocol<null, null, unknown> = {
      name: "bad",
      init: (ctx) => {
        if (ctx.nodeId === "A") ctx.send("B", new Map());
        return { persistent: null, volatile: null };
      },
      recover: () => ({ persistent: null, volatile: null }),
      onMessage: () => undefined,
      onTimer: () => undefined,
      onClientCommand: () => undefined,
      view: () => null,
    };
    expect(
      () =>
        new Simulation({
          protocol: bad,
          nodes: ["A", "B"],
          seed: 1,
          network: new FixedLatencyNetwork(1),
        }),
    ).toThrow(TypeError);
  });

  it("advances the clock to the requested time even when idle", () => {
    const sim = run(1, [], 50).sim;
    sim.runUntil(75);
    expect(sim.now).toBe(75);
  });
});
