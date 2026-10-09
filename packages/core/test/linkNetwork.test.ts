import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  LinkNetwork,
  Rng,
  Simulation,
  TraceRecorder,
  type NetworkChange,
  type Protocol,
  type ScheduledAction,
  type TraceRecord,
} from "../src/index.ts";

const NODES = ["A", "B", "C", "D", "E"];

describe("LinkNetwork.onSend", () => {
  it("keeps delays within [latency, latency + jitter)", () => {
    fc.assert(
      fc.property(fc.integer(), fc.nat(100), fc.nat(50), (seed, latencyMs, jitterMs) => {
        const net = new LinkNetwork(NODES, { defaults: { latencyMs, jitterMs } });
        const rng = Rng.fromSeed(seed);
        for (let i = 0; i < 20; i++) {
          const out = net.onSend("A", "B", 0, rng);
          if (!("delays" in out)) throw new Error("unexpected drop");
          expect(out.delays).toHaveLength(1);
          const d = out.delays[0]!;
          expect(d).toBeGreaterThanOrEqual(latencyMs);
          expect(d).toBeLessThanOrEqual(latencyMs + jitterMs);
        }
      }),
    );
  });

  it("does not draw randomness when a link has no faults or jitter", () => {
    const net = new LinkNetwork(NODES, { defaults: { jitterMs: 0 } });
    const rng = Rng.fromSeed(1);
    const before = rng.getState();
    expect(net.onSend("A", "B", 0, rng)).toEqual({ delays: [10] });
    expect(rng.getState()).toEqual(before);
  });

  it("loses and duplicates at roughly the configured rates", () => {
    const net = new LinkNetwork(NODES, { defaults: { loss: 0.2, duplicate: 0.3 } });
    const rng = Rng.fromSeed(2);
    let lost = 0;
    let dup = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const out = net.onSend("A", "B", 0, rng);
      if ("dropped" in out) {
        expect(out.dropped).toBe("loss");
        lost++;
      } else if (out.delays.length === 2) dup++;
    }
    expect(lost / n).toBeCloseTo(0.2, 1);
    expect(dup / (n - lost)).toBeCloseTo(0.3, 1);
  });

  it("rejects invalid settings", () => {
    expect(() => new LinkNetwork(NODES, { defaults: { loss: 1.5 } })).toThrow(RangeError);
    expect(() => new LinkNetwork(NODES, { defaults: { latencyMs: -1 } })).toThrow(RangeError);
    const net = new LinkNetwork(NODES);
    expect(() => net.apply({ type: "setLink", from: "A", to: "B", jitterMs: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => net.apply({ type: "partition", groups: [["A"], ["A", "B"]] })).toThrow(
      /more than one/,
    );
    expect(() => net.apply({ type: "isolate", node: "Z" })).toThrow(/unknown node/);
  });
});

describe("LinkNetwork topology changes", () => {
  const connected = (net: LinkNetwork) =>
    NODES.flatMap((f) => NODES.filter((t) => t !== f && net.isConnected(f, t)).map((t) => f + t));

  it("partitions into groups, with unlisted nodes grouped together", () => {
    const net = new LinkNetwork(NODES);
    net.apply({ type: "partition", groups: [["A", "B"], ["C"]] });
    expect(connected(net)).toEqual(["AB", "BA", "DE", "ED"]);
  });

  it("replaces an earlier partition and heals completely", () => {
    const net = new LinkNetwork(NODES);
    net.apply({ type: "partition", groups: [["A"]] });
    net.apply({ type: "partition", groups: [["A", "B", "C", "D"]] });
    expect(net.isConnected("A", "B")).toBe(true);
    expect(net.isConnected("A", "E")).toBe(false);
    net.apply({ type: "heal" });
    expect(connected(net)).toHaveLength(20);
  });

  it("changes every link at once", () => {
    const net = new LinkNetwork(NODES);
    net.apply({ type: "setAll", latencyMs: 70, loss: 0.5 });
    for (const f of NODES) {
      for (const t of NODES)
        if (f !== t) expect(net.link(f, t)).toMatchObject({ latencyMs: 70, loss: 0.5 });
    }
  });

  it("describes every link and whether it carries traffic", () => {
    const net = new LinkNetwork(["A", "B", "C"], { defaults: { latencyMs: 7 } });
    net.apply({ type: "isolate", node: "C" });
    net.apply({ type: "setLink", from: "A", to: "B", up: false });
    const byPair = new Map(net.view().links.map((l) => [`${l.from}${l.to}`, l]));
    expect(byPair.size).toBe(6);
    expect(byPair.get("AB")).toMatchObject({ up: false, connected: false, latencyMs: 7 });
    expect(byPair.get("BA")).toMatchObject({ up: true, connected: true });
    expect(byPair.get("CA")).toMatchObject({ up: true, connected: false });
  });

  it("restores links and partitions to their initial state", () => {
    const net = new LinkNetwork(NODES, { links: [{ from: "A", to: "B", latencyMs: 99 }] });
    net.apply({ type: "setLink", from: "A", to: "B", latencyMs: 5, up: false });
    net.apply({ type: "isolate", node: "C" });
    net.apply({ type: "restore" });
    expect(connected(net)).toHaveLength(20);
    expect(net.link("A", "B").latencyMs).toBe(99);
  });

  it("isolates a node on top of an existing partition", () => {
    const net = new LinkNetwork(NODES);
    net.apply({ type: "partition", groups: [["A", "B", "C"]] });
    net.apply({ type: "isolate", node: "A" });
    expect(connected(net)).toEqual(["BC", "CB", "DE", "ED"]);
  });

  it("supports asymmetric links, which heal does not reset", () => {
    const net = new LinkNetwork(NODES);
    net.apply({ type: "setLink", from: "A", to: "B", up: false });
    net.apply({ type: "heal" });
    expect(net.isConnected("A", "B")).toBe(false);
    expect(net.isConnected("B", "A")).toBe(true);
    net.apply({
      type: "setLink",
      from: "A",
      to: "B",
      up: true,
      latencyMs: 50,
      bidirectional: true,
    });
    expect(net.link("A", "B")).toMatchObject({ up: true, latencyMs: 50 });
    expect(net.link("B", "A")).toMatchObject({ latencyMs: 50 });
  });
});

describe("LinkNetwork in a simulation", () => {
  // Every node broadcasts once per 10ms; we only inspect the trace.
  const chatter: Protocol<null, null, string> = {
    name: "chatter",
    init: (ctx) => {
      ctx.setTimer("t", 10);
      return { persistent: null, volatile: null };
    },
    recover: () => ({ persistent: null, volatile: null }),
    onTimer: (ctx) => {
      for (const p of ctx.peers) ctx.send(p, "hi");
      ctx.setTimer("t", 10);
    },
    onMessage: () => undefined,
    onClientCommand: () => undefined,
    view: () => null,
  };

  function simulate(actions: ScheduledAction<never, NetworkChange>[], untilMs = 200) {
    const rec = new TraceRecorder();
    const sim = new Simulation({
      protocol: chatter,
      nodes: NODES,
      seed: 3,
      network: new LinkNetwork(NODES, { defaults: { latencyMs: 20, jitterMs: 0 } }),
      actions,
      sinks: [rec.sink],
    });
    sim.runUntil(untilMs);
    return rec.records;
  }
  const crosses = (r: TraceRecord & { from: string; to: string }) =>
    ["A", "B"].includes(r.from) !== ["A", "B"].includes(r.to);

  it("drops cross-partition traffic at send and in flight, and resumes after heal", () => {
    const records = simulate([
      {
        atMs: 55,
        action: { type: "network", change: { type: "partition", groups: [["A", "B"]] } },
      },
      { atMs: 125, action: { type: "network", change: { type: "heal" } } },
    ]);
    const crossing = records.filter(
      (r): r is Extract<TraceRecord, { type: "deliver" | "drop" }> =>
        (r.type === "deliver" || r.type === "drop") && crosses(r),
    );
    // Sent at 40/50 and still in flight at 55: dropped on delivery at 60/70.
    const inFlight = crossing.filter((r) => r.type === "drop" && r.t > 55 && r.t <= 70);
    expect(inFlight.length).toBeGreaterThan(0);
    // Sent during the partition: dropped at send.
    expect(crossing.some((r) => r.type === "drop" && r.t === 60 && r.reason === "link-down")).toBe(
      true,
    );
    // Nothing crosses during the partition.
    expect(crossing.some((r) => r.type === "deliver" && r.t > 55 && r.t < 125)).toBe(false);
    // Traffic sent after heal (t=130) arrives at 150.
    expect(crossing.some((r) => r.type === "deliver" && r.t === 150)).toBe(true);
    // Within a side, traffic is unaffected.
    expect(
      records.some(
        (r) => r.type === "deliver" && r.from === "A" && r.to === "B" && r.t > 55 && r.t < 125,
      ),
    ).toBe(true);
  });

  it("emits exactly one deliver or drop per scheduled copy", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const rec = new TraceRecorder();
        const sim = new Simulation({
          protocol: chatter,
          nodes: NODES,
          seed,
          network: new LinkNetwork(NODES, { defaults: { loss: 0.2, duplicate: 0.2 } }),
          actions: [
            { atMs: 30, action: { type: "network", change: { type: "isolate", node: "C" } } },
          ],
          sinks: [rec.sink],
        });
        sim.runUntil(150);
        // Let everything in flight land.
        sim.runUntil(150 + 15);
        const outcomes = new Map<number, number>();
        for (const r of rec.records) {
          if (r.type === "deliver" || r.type === "drop") {
            outcomes.set(r.send, (outcomes.get(r.send) ?? 0) + 1);
          }
        }
        for (const r of rec.records) {
          if (r.type !== "send" || r.t > 150) continue;
          expect(outcomes.get(r.id)).toBe(Math.max(r.copies, 1));
        }
      }),
      { numRuns: 30 },
    );
  });
});
