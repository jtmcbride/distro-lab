import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  InvariantMonitor,
  LinkNetwork,
  Raft,
  requestClient,
  Simulation,
  TraceRecorder,
  type LinkNetworkConfig,
  type NetworkChange,
  type ScheduledAction,
  type TraceRecord,
} from "../src/index.ts";

type Op = Raft.KvOp;
type Action = ScheduledAction<Op, NetworkChange>;

const SERVERS = ["A", "B", "C", "D", "E"];
const CLIENTS = ["c1", "c2"];

function kv(options: {
  seed?: number;
  servers?: string[];
  clients?: string[];
  actions?: Action[];
  network?: LinkNetworkConfig;
  raft?: Partial<Raft.RaftConfig>;
}) {
  const servers = options.servers ?? SERVERS;
  const clients = options.clients ?? CLIENTS;
  const rec = new TraceRecorder();
  const sim = new Simulation({
    protocol: Raft.raft(options.raft),
    nodes: servers,
    clients: { ids: clients, protocol: requestClient<Op, Raft.KvResult, Raft.RaftMessage>() },
    seed: options.seed ?? 1,
    network: new LinkNetwork([...servers, ...clients], {
      defaults: { latencyMs: 5, jitterMs: 10 },
      ...options.network,
    }),
    actions: options.actions ?? [],
    sinks: [rec.sink],
  });
  const monitor = new InvariantMonitor<Raft.RaftView>(sim, Raft.raftInvariants());
  const view = (n: string) => sim.view(n) as Raft.RaftView;
  const completions = (client: string) =>
    rec.records
      .filter(
        (r): r is Extract<TraceRecord, { type: "annotate" }> =>
          r.type === "annotate" && r.label === "complete" && r.node === client,
      )
      .map((r) => ({ t: r.t, ...(r.data as { seq: number; result: Raft.KvResult }) }));
  const invocations = (client: string) =>
    rec.records.filter((r) => r.type === "annotate" && r.label === "invoke" && r.node === client);
  /** Logs, commit indexes and data agree on every server. */
  const converged = () => {
    const views = servers.map(view);
    const first = views[0]!;
    return views.every(
      (v) =>
        canonicalJson(v.log) === canonicalJson(first.log) &&
        v.commitIndex === first.log.length &&
        v.lastApplied === v.commitIndex &&
        canonicalJson(v.data) === canonicalJson(first.data),
    );
  };
  return { sim, rec, view, monitor, completions, invocations, converged };
}

const op = (atMs: number, client: string, command: Op): Action => ({
  atMs,
  action: { type: "client", node: client, command },
});
const put = (atMs: number, client: string, key: string, value: string) =>
  op(atMs, client, { type: "put", key, value });
const net = (atMs: number, change: NetworkChange): Action => ({
  atMs,
  action: { type: "network", change },
});
/** A chain of cas operations: applying any of them twice makes a later one fail. */
const casChain = (startMs: number, client: string, key: string, n: number): Action[] =>
  Array.from({ length: n }, (_, i) =>
    op(startMs + i, client, {
      type: "cas",
      key,
      expect: i === 0 ? null : String(i),
      value: String(i + 1),
    }),
  );

describe("Raft KV: replication and commitment", () => {
  it("serves puts and gets through the log and converges every replica", () => {
    const { sim, completions, converged, view, monitor } = kv({
      actions: [
        put(600, "c1", "x", "1"),
        put(600, "c2", "y", "2"),
        op(601, "c1", { type: "get", key: "y" }),
        put(602, "c1", "x", "3"),
        op(603, "c1", { type: "get", key: "x" }),
      ],
    });
    sim.runUntil(3000);
    expect(monitor.violations).toEqual([]);
    const c1 = completions("c1").map((c) => c.result);
    expect(c1[0]).toEqual({ ok: true, value: "1" });
    // c2's put may or may not precede c1's get; both orders are linearizable.
    expect([null, "2"]).toContain(c1[1]!.value);
    expect(c1.slice(2)).toEqual([
      { ok: true, value: "3" },
      { ok: true, value: "3" },
    ]);
    expect(converged()).toBe(true);
    expect(view("A").data).toEqual({ x: "3", y: "2" });
  });

  it("converges logs under loss, duplication and heavy reordering", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { sim, converged, completions, monitor } = kv({
        seed,
        actions: [
          net(0, { type: "setAll", loss: 0.15, duplicate: 0.2, jitterMs: 60 }),
          ...casChain(400, "c1", "k", 15),
          ...casChain(400, "c2", "j", 15),
          net(4000, { type: "restore" }),
        ],
        raft: { maxEntriesPerAppend: 3 },
      });
      sim.runUntil(8000);
      expect(monitor.violations).toEqual([]);
      expect(converged()).toBe(true);
      for (const c of CLIENTS) {
        // Every cas succeeded: none was applied twice despite retries and duplicates.
        expect(completions(c).map((x) => x.result.ok)).toEqual(Array(15).fill(true));
      }
    }
  });

  it("does not complete writes without a majority, and does once one returns", () => {
    const { sim, completions } = kv({
      actions: [
        { atMs: 1000, action: { type: "crash", node: "C" } },
        { atMs: 1000, action: { type: "crash", node: "D" } },
        { atMs: 1000, action: { type: "crash", node: "E" } },
        put(1100, "c1", "x", "1"),
      ],
    });
    sim.runUntil(1000);
    const leader = SERVERS.find(
      (n) => sim.isUp(n) && (sim.view(n) as Raft.RaftView).role === "leader",
    );
    // Leaders elected before the crash may be among C-E; the test only needs no majority.
    void leader;
    sim.runUntil(4000);
    expect(completions("c1")).toEqual([]);
    sim.schedule(4000, { type: "recover", node: "C" });
    sim.runUntil(7000);
    expect(completions("c1").map((c) => c.result)).toEqual([{ ok: true, value: "1" }]);
  });

  it("discards a deposed leader's uncommitted entries and still applies each write once", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const probe = kv({ seed });
      probe.sim.runUntil(1000);
      const leader = SERVERS.find((n) => probe.view(n).role === "leader")!;
      const others = SERVERS.filter((n) => n !== leader);
      const { sim, completions, converged, monitor, view } = kv({
        seed,
        actions: [
          // The old leader and c1 are cut off from the majority (c2 sits with the majority).
          net(1000, {
            type: "partition",
            groups: [
              [leader, "c1"],
              [...others, "c2"],
            ],
          }),
          ...casChain(1010, "c1", "k", 5),
          ...casChain(1010, "c2", "j", 5),
          net(6000, { type: "heal" }),
        ],
      });
      // c1 tries random servers (400ms timeout each) until it finds the old leader.
      sim.runUntil(5900);
      // The old leader accepted c1's first request but could not commit it.
      expect(view(leader).log.length).toBeGreaterThan(view(leader).commitIndex);
      expect(completions("c1")).toEqual([]);
      expect(completions("c2").length).toBe(5);
      sim.runUntil(11000);
      expect(monitor.violations).toEqual([]);
      expect(converged()).toBe(true);
      expect(completions("c1").map((c) => c.result.ok)).toEqual(Array(5).fill(true));
      expect(view("A").data).toEqual({ k: "5", j: "5" });
    }
  });

  it("rebuilds a restarted node's state machine from the log", () => {
    const { sim, view, converged } = kv({
      actions: [
        ...casChain(600, "c1", "k", 5),
        { atMs: 1500, action: { type: "crash", node: "B" } },
        { atMs: 1600, action: { type: "recover", node: "B" } },
      ],
    });
    sim.runUntil(1600);
    expect(view("B")).toMatchObject({ commitIndex: 0, lastApplied: 0, data: {} });
    sim.runUntil(3000);
    expect(converged()).toBe(true);
    expect(view("B").data).toEqual({ k: "5" });
  });

  it("returns the cached result when a reply is lost and the client retries", () => {
    const probe = kv({});
    probe.sim.runUntil(1000);
    const leader = SERVERS.find((n) => probe.view(n).role === "leader")!;
    const { sim, completions, rec } = kv({
      actions: [
        net(1000, { type: "setLink", from: leader, to: "c1", up: false }),
        ...casChain(1010, "c1", "k", 3),
        net(2000, { type: "setLink", from: leader, to: "c1", up: true }),
      ],
    });
    sim.runUntil(5000);
    expect(completions("c1").map((c) => c.result)).toEqual([
      { ok: true, value: "1" },
      { ok: true, value: "2" },
      { ok: true, value: "3" },
    ]);
    const retries = rec.records.filter((r) => r.type === "annotate" && r.label === "retry");
    expect(retries.length).toBeGreaterThan(0);
  });

  for (const fastBackoff of [true, false]) {
    it(`catches up a far-behind follower (fastBackoff=${fastBackoff})`, () => {
      const { sim, converged, monitor } = kv({
        raft: { fastBackoff, maxEntriesPerAppend: 4 },
        actions: [
          net(600, { type: "isolate", node: "E" }),
          ...casChain(700, "c1", "k", 30),
          net(4000, { type: "heal" }),
        ],
      });
      sim.runUntil(8000);
      expect(monitor.violations).toEqual([]);
      expect(converged()).toBe(true);
    });
  }

  it("works as a single-node cluster", () => {
    const { sim, completions } = kv({ servers: ["solo"], actions: casChain(500, "c1", "k", 3) });
    sim.runUntil(2000);
    expect(completions("c1").map((c) => c.result.value)).toEqual(["1", "2", "3"]);
  });
});

describe("KV state machine", () => {
  it("executes operations and dedups by session", () => {
    const state = Raft.emptyKv();
    expect(Raft.applyClientCommand(state, "c", 1, { type: "put", key: "a", value: "x" })).toEqual({
      ok: true,
      value: "x",
    });
    expect(
      Raft.applyClientCommand(state, "c", 2, { type: "cas", key: "a", expect: "y", value: "z" }),
    ).toEqual({ ok: false, value: "x" });
    // Retry of seq 2 returns the cached result even though the data has not changed.
    expect(
      Raft.applyClientCommand(state, "c", 2, { type: "put", key: "a", value: "ignored" }),
    ).toEqual({ ok: false, value: "x" });
    expect(
      Raft.applyClientCommand(state, "c", 1, { type: "put", key: "a", value: "old" }),
    ).toBeNull();
    expect(state.data).toEqual({ a: "x" });
  });
});
