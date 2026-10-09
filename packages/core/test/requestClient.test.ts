import { describe, expect, it } from "vitest";
import {
  LinkNetwork,
  requestClient,
  Simulation,
  TraceRecorder,
  type ClientMessage,
  type NetworkChange,
  type Protocol,
  type RequestClientView,
  type ScheduledAction,
  type TraceRecord,
} from "../src/index.ts";

type Op = { put: number };
type Result = { by: string; op: Op; seen: number };
type Msg = ClientMessage<Op, Result>;

/**
 * Servers where only A serves requests. B redirects to A; C redirects without a hint.
 * A counts how often it has seen each (client, seq), so retries are visible.
 */
const fixedLeader: Protocol<null, { seen: Record<string, number> }, Msg, Op> = {
  name: "fixed-leader",
  init: () => ({ persistent: null, volatile: { seen: {} } }),
  recover: () => ({ persistent: null, volatile: { seen: {} } }),
  onTimer: () => undefined,
  onClientCommand: () => undefined,
  onMessage(ctx, s, from, m) {
    if (m.type !== "ClientRequest") return;
    if (ctx.nodeId !== "A") {
      const leaderHint = ctx.nodeId === "B" ? "A" : null;
      ctx.send(from, { type: "ClientReply", seq: m.seq, status: "notLeader", leaderHint });
      return;
    }
    const key = `${m.clientId}#${m.seq}`;
    const seen = (s.volatile.seen[key] = (s.volatile.seen[key] ?? 0) + 1);
    ctx.send(from, {
      type: "ClientReply",
      seq: m.seq,
      status: "ok",
      result: { by: ctx.nodeId, op: m.op, seen },
    });
  },
  view: (s) => s.volatile.seen,
};

const SERVERS = ["A", "B", "C"];
const CLIENTS = ["c1", "c2"];
const put = (atMs: number, client: string, n: number): ScheduledAction<Op, NetworkChange> => ({
  atMs,
  action: { type: "client", node: client, command: { put: n } },
});
const net = (atMs: number, change: NetworkChange): ScheduledAction<Op, NetworkChange> => ({
  atMs,
  action: { type: "network", change },
});

function run(actions: ScheduledAction<Op, NetworkChange>[], untilMs = 3000, seed = 1) {
  const rec = new TraceRecorder();
  const sim = new Simulation({
    protocol: fixedLeader,
    nodes: SERVERS,
    clients: { ids: CLIENTS, protocol: requestClient<Op, Result>({ requestTimeoutMs: 100 }) },
    seed,
    network: new LinkNetwork([...SERVERS, ...CLIENTS], { defaults: { latencyMs: 5, jitterMs: 5 } }),
    actions,
    sinks: [rec.sink],
  });
  sim.runUntil(untilMs);
  const notes = (label: string, node?: string) =>
    rec.records.filter(
      (r): r is Extract<TraceRecord, { type: "annotate" }> =>
        r.type === "annotate" && r.label === label && (node === undefined || r.node === node),
    );
  return { sim, rec, notes, view: (c: string) => sim.view(c) as RequestClientView };
}

describe("client processes", () => {
  it("are separate from servers", () => {
    const { sim } = run([]);
    expect(sim.nodeIds).toEqual(SERVERS);
    expect(sim.clientIds).toEqual(CLIENTS);
    expect(sim.roleOf("c1")).toBe("client");
    expect(
      () =>
        new Simulation({
          protocol: fixedLeader,
          nodes: ["A"],
          clients: { ids: ["A"], protocol: requestClient<Op, Result>() },
          seed: 1,
          network: new LinkNetwork(["A"]),
        }),
    ).toThrow(/duplicate/);
  });
});

describe("requestClient", () => {
  it("completes operations in order, one at a time, via redirects", () => {
    const { notes, view } = run([put(10, "c1", 1), put(10, "c1", 2), put(10, "c1", 3)]);
    const completes = notes("complete", "c1").map((r) => r.data as { seq: number; result: Result });
    expect(completes.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(completes.every((c) => c.result.by === "A")).toBe(true);
    // Each invoke happens only after the previous complete.
    const timeline = [...notes("invoke", "c1"), ...notes("complete", "c1")]
      .sort((a, b) => a.id - b.id)
      .map((r) => r.label);
    expect(timeline).toEqual(["invoke", "complete", "invoke", "complete", "invoke", "complete"]);
    expect(view("c1")).toMatchObject({ nextSeq: 4, queued: 0, inFlight: null, leaderHint: "A" });
  });

  it("follows hints immediately and backs off when there is none", () => {
    // Try several seeds so the first target covers B and C.
    const reasons = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) {
      const { notes } = run([put(10, "c1", 1)], 1000, seed);
      for (const r of notes("retry")) reasons.add((r.data as { reason: string }).reason);
      expect(notes("complete")).toHaveLength(1);
    }
    expect(reasons).toEqual(new Set(["redirect", "no-leader"]));
  });

  it("keeps retrying while partitioned from the leader and completes after heal", () => {
    const { notes, rec } = run([
      net(0, { type: "partition", groups: [["A"], ["B", "C", "c1", "c2"]] }),
      put(10, "c1", 1),
      net(1000, { type: "heal" }),
    ]);
    const retries = notes("retry", "c1").filter((r) => r.t < 1000);
    expect(retries.length).toBeGreaterThan(3);
    const drops = rec.records.filter((r) => r.type === "drop" && r.from === "c1" && r.to === "A");
    expect(drops.length).toBeGreaterThan(0);
    const [done] = notes("complete", "c1");
    expect(done!.t).toBeGreaterThan(1000);
  });

  it("retries the same request when a reply is lost, so the server sees a duplicate", () => {
    const { notes } = run([
      net(0, { type: "setLink", from: "A", to: "c1", up: false }),
      put(10, "c1", 1),
      net(500, { type: "setLink", from: "A", to: "c1", up: true }),
    ]);
    const [done] = notes("complete", "c1");
    const data = done!.data as { seq: number; result: Result; attempts: number };
    expect(data.seq).toBe(1);
    expect(data.result.seen).toBeGreaterThan(1);
    expect(data.attempts).toBeGreaterThan(1);
  });

  it("never reuses a request number after a crash, and drops in-memory work", () => {
    const { notes, view } = run([
      net(0, { type: "isolate", node: "c1" }),
      put(10, "c1", 1),
      put(10, "c1", 2),
      { atMs: 200, action: { type: "crash", node: "c1" } },
      { atMs: 300, action: { type: "recover", node: "c1" } },
      net(300, { type: "heal" }),
      put(400, "c1", 3),
    ]);
    const completes = notes("complete", "c1").map((r) => r.data as { seq: number; result: Result });
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({ seq: 2, result: { op: { put: 3 } } });
    // seq 1 was invoked but its outcome is unknown: no complete record.
    expect(notes("invoke", "c1").map((r) => (r.data as { seq: number }).seq)).toEqual([1, 2]);
    expect(view("c1").nextSeq).toBe(3);
  });

  it("ignores stale and duplicate replies", () => {
    const { notes } = run([
      net(0, { type: "setAll", duplicate: 1, latencyMs: 5, jitterMs: 50 }),
      put(10, "c1", 1),
      put(10, "c1", 2),
      put(10, "c1", 3),
      put(10, "c1", 4),
      put(10, "c2", 1),
    ]);
    expect(notes("complete", "c1").map((r) => (r.data as { seq: number }).seq)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(notes("complete", "c2")).toHaveLength(1);
    // Every completion carries the result of the operation it completes.
    for (const c of CLIENTS) {
      const invoked = new Map(
        notes("invoke", c).map((r) => {
          const d = r.data as { seq: number; op: Op };
          return [d.seq, d.op];
        }),
      );
      for (const r of notes("complete", c)) {
        const d = r.data as { seq: number; result: Result };
        expect(d.result.op).toEqual(invoked.get(d.seq));
      }
    }
  });

  it("is deterministic with clients in the simulation", () => {
    const actions = [put(10, "c1", 1), put(20, "c2", 2), net(30, { type: "isolate", node: "A" })];
    expect(run(actions).rec.hash()).toBe(run(actions).rec.hash());
  });
});
