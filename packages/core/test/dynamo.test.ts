import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  Dynamo,
  InvariantMonitor,
  LinkNetwork,
  Simulation,
  TraceRecorder,
  type NetworkChange,
  type ScheduledAction,
  type TraceRecord,
} from "../src/index.ts";

type Op = Dynamo.DynamoOp;
type Action = ScheduledAction<Op, NetworkChange>;

const SERVERS = ["A", "B", "C", "D", "E"];
const CLIENTS = ["c1", "c2"];

// Every run is also checked against the safety invariants.
const monitors: InvariantMonitor<Dynamo.DynamoView>[] = [];
afterEach(() => {
  for (const m of monitors.splice(0)) expect(m.violations).toEqual([]);
});

function store(options: {
  seed?: number;
  servers?: string[];
  actions?: Action[];
  config?: Partial<Dynamo.DynamoConfig>;
}) {
  const servers = options.servers ?? SERVERS;
  const rec = new TraceRecorder();
  const sim = new Simulation({
    protocol: Dynamo.dynamo(options.config),
    nodes: servers,
    clients: { ids: CLIENTS, protocol: Dynamo.dynamoClient() },
    seed: options.seed ?? 1,
    network: new LinkNetwork([...servers, ...CLIENTS], {
      defaults: { latencyMs: 5, jitterMs: 5 },
    }),
    actions: options.actions ?? [],
    sinks: [rec.sink],
  });
  const monitor = new InvariantMonitor<Dynamo.DynamoView>(
    sim,
    Dynamo.dynamoInvariants({ ...Dynamo.DEFAULT_DYNAMO_CONFIG, ...options.config }),
  );
  monitors.push(monitor);
  const view = (n: string) => sim.view(n) as Dynamo.DynamoView;
  const annotations = (label: string) =>
    rec.records.filter(
      (r): r is Extract<TraceRecord, { type: "annotate" }> =>
        r.type === "annotate" && r.label === label,
    );
  const results = (client: string) =>
    annotations("complete")
      .filter((r) => r.node === client)
      .map((r) => (r.data as { result: Dynamo.DynamoResult }).result);
  const values = (r: Dynamo.DynamoResult | undefined) =>
    r?.type === "get" ? r.versions.map((v) => v.value).sort() : null;
  /** Each replica's versions of `key`, as comparable strings. */
  const replicaData = (key: string, n = 3) =>
    Dynamo.replicasOf(servers, key, n).map((s) =>
      canonicalJson((view(s).data[key] ?? []) as never),
    );
  /** Values of a register's siblings on one server. */
  const stored = (server: string, key: string) =>
    (view(server).data[key] as readonly Dynamo.Version[] | undefined)?.map((v) => v.value);
  const hintsLeft = () => servers.some((s) => Object.keys(view(s).hints).length > 0);
  return { sim, rec, monitor, view, stored, annotations, results, values, replicaData, hintsLeft };
}

const op = (atMs: number, client: string, command: Op): Action => ({
  atMs,
  action: { type: "client", node: client, command },
});
const put = (atMs: number, client: string, key: string, value: string) =>
  op(atMs, client, { type: "put", key, value });
const get = (atMs: number, client: string, key: string) => op(atMs, client, { type: "get", key });
const crash = (atMs: number, node: string): Action => ({ atMs, action: { type: "crash", node } });
const recover = (atMs: number, node: string): Action => ({
  atMs,
  action: { type: "recover", node },
});
const net = (atMs: number, change: NetworkChange): Action => ({
  atMs,
  action: { type: "network", change },
});
const replicas = (key: string) => Dynamo.replicasOf(SERVERS, key, 3);
const fallbacks = (key: string) => Dynamo.preferenceList(SERVERS, key).slice(3);

describe("Dynamo: quorum reads and writes", () => {
  it("returns a put to later gets through any coordinator", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { sim, results, values } = store({
        seed,
        actions: [put(10, "c1", "x", "1"), get(100, "c2", "x"), get(110, "c1", "x")],
      });
      sim.runUntil(1000);
      expect(results("c1")[0]).toMatchObject({ type: "put", write: "c1#1" });
      expect(values(results("c2")[0])).toEqual(["1"]);
      expect(values(results("c1")[1])).toEqual(["1"]);
    }
  });

  it("keeps concurrent puts as siblings until a writer that read them replaces them", () => {
    const { sim, results, values, replicaData } = store({
      config: { antiEntropyIntervalMs: 0 },
      actions: [
        put(10, "c1", "x", "a"),
        put(10, "c2", "x", "b"),
        get(200, "c1", "x"),
        // c1's put carries the context of its read, which includes both siblings.
        put(300, "c1", "x", "c"),
        get(400, "c2", "x"),
      ],
    });
    sim.runUntil(1000);
    expect(values(results("c1")[1])).toEqual(["a", "b"]);
    expect(values(results("c2")[1])).toEqual(["c"]);
    // Every replica that stored c dropped a and b.
    for (const data of replicaData("x")) expect(data).not.toContain('"value":"a"');
  });

  it("strict quorum: replies unavailable without W replicas, then succeeds once they return", () => {
    const [r1, r2] = replicas("x");
    const { sim, results, annotations } = store({
      config: { sloppy: false, antiEntropyIntervalMs: 0 },
      actions: [crash(1, r1!), crash(1, r2!), put(10, "c1", "x", "1"), recover(1000, r1!)],
    });
    sim.runUntil(900);
    expect(results("c1")).toEqual([]);
    expect(annotations("unavailable").length).toBeGreaterThan(0);
    expect(annotations("retry").length).toBeGreaterThan(0);
    sim.runUntil(2500);
    expect(results("c1")).toEqual([expect.objectContaining({ type: "put" })]);
  });

  it("strict quorum with R + W > N: a get after an acknowledged put sees it, one replica down", () => {
    for (const down of replicas("x")) {
      const { sim, results, values } = store({
        config: { sloppy: false, antiEntropyIntervalMs: 0, readRepair: false },
        actions: [put(10, "c1", "x", "1"), crash(200, down), get(210, "c2", "x")],
      });
      sim.runUntil(1500);
      expect(values(results("c2")[0])).toEqual(["1"]);
    }
  });
});

describe("Dynamo: CRDT values", () => {
  const counter = (r: Dynamo.DynamoResult | undefined) =>
    r?.type === "crdt" && r.state.type === "counter" ? Dynamo.counterValue(r.state) : null;
  const elements = (r: Dynamo.DynamoResult | undefined) =>
    r?.type === "crdt" && r.state.type === "set" ? Dynamo.setElements(r.state) : null;

  it("counts concurrent increments through any coordinators, with no siblings", () => {
    const { sim, results, replicaData } = store({
      actions: [
        op(10, "c1", { type: "incr", key: "count:likes", by: 2 }),
        op(10, "c2", { type: "incr", key: "count:likes", by: 3 }),
        op(50, "c1", { type: "incr", key: "count:likes", by: 1 }),
        get(400, "c2", "count:likes"),
      ],
    });
    sim.runUntil(3000);
    expect(counter(results("c2")[1])).toBe(6);
    expect(new Set(replicaData("count:likes")).size).toBe(1);
  });

  it("removes only the tags a client observed, so a concurrent add survives", () => {
    const { sim, results } = store({
      actions: [
        op(10, "c1", { type: "add", key: "set:cart", element: "milk" }),
        get(100, "c1", "set:cart"),
        // c1 removes the milk it saw while c2, unaware, adds milk again.
        op(200, "c1", { type: "remove", key: "set:cart", element: "milk" }),
        op(200, "c2", { type: "add", key: "set:cart", element: "milk" }),
        op(200, "c2", { type: "add", key: "set:cart", element: "eggs" }),
        get(600, "c1", "set:cart"),
        op(700, "c1", { type: "remove", key: "set:cart", element: "eggs" }),
        get(900, "c1", "set:cart"),
      ],
    });
    sim.runUntil(3000);
    const c1 = results("c1");
    expect(elements(c1[1])).toEqual(["milk"]);
    expect(c1[2]).toMatchObject({ type: "remove", element: "milk" });
    expect(elements(c1[3])).toEqual(["eggs", "milk"]);
    expect(elements(c1[5])).toEqual(["milk"]);
  });

  it("rejects an operation that does not fit the key's type", () => {
    const { sim, results } = store({
      actions: [
        op(10, "c1", { type: "incr", key: "x", by: 1 }),
        op(20, "c1", { type: "put", key: "count:n", value: "1" }),
      ],
    });
    sim.runUntil(500);
    expect(results("c1").map((r) => r.type)).toEqual(["invalid", "invalid"]);
  });
});

describe("Dynamo: repair mechanisms", () => {
  it("sloppy quorum: writes through fallbacks with hints, handed off when replicas return", () => {
    const [r1, r2] = replicas("x");
    const { sim, results, annotations, replicaData, hintsLeft, view, stored } = store({
      config: { antiEntropyIntervalMs: 0 },
      actions: [
        crash(1, r1!),
        crash(1, r2!),
        put(10, "c1", "x", "1"),
        recover(800, r1!),
        recover(1600, r2!),
      ],
    });
    sim.runUntil(500);
    expect(results("c1")).toEqual([expect.objectContaining({ type: "put" })]);
    expect(annotations("fallback").length).toBeGreaterThan(0);
    const holders = fallbacks("x").filter((f) => view(f).hints[r1!]?.x !== undefined);
    expect(holders.length).toBeGreaterThan(0);
    sim.runUntil(1500);
    // r1 got its hint; r2 is still down, so its hint is still held.
    expect(stored(r1!, "x")).toEqual(["1"]);
    expect(annotations("handedOff").length).toBeGreaterThan(0);
    expect(view(r2!).data.x).toBeUndefined();
    sim.runUntil(3000);
    expect(hintsLeft()).toBe(false);
    expect(new Set(replicaData("x")).size).toBe(1);
  });

  it("read repair fixes a replica that missed a write", () => {
    const [r1, r2, r3] = replicas("x");
    const { sim, results, values, annotations, stored } = store({
      config: { antiEntropyIntervalMs: 0, sloppy: false, r: 3 },
      actions: [
        net(1, { type: "isolate", node: r3! }),
        put(10, "c1", "x", "1"),
        net(300, { type: "heal" }),
        get(400, "c2", "x"),
      ],
    });
    sim.runUntil(1500);
    expect(values(results("c2")[0])).toEqual(["1"]);
    expect(annotations("readRepair").map((r) => r.data)).toEqual([{ key: "x", nodes: [r3] }]);
    for (const r of [r1!, r2!, r3!]) expect(stored(r, "x")).toEqual(["1"]);
  });

  it("anti-entropy converges replicas, including siblings from both sides of a partition", () => {
    const [r1, r2, r3] = replicas("x");
    const [f1, f2] = fallbacks("x");
    const { sim, results, replicaData, stored } = store({
      config: { readRepair: false },
      actions: [
        // Each side can reach W = 2 servers for x (the left side through a fallback).
        net(1, {
          type: "partition",
          groups: [
            [r1!, f1!, "c1"],
            [r2!, r3!, f2!, "c2"],
          ],
        }),
        put(10, "c1", "x", "left"),
        put(10, "c2", "x", "right"),
        net(3000, { type: "heal" }),
      ],
    });
    // Clients find a reachable coordinator by retrying.
    sim.runUntil(2900);
    expect(results("c1")).toEqual([expect.objectContaining({ type: "put" })]);
    expect(results("c2")).toEqual([expect.objectContaining({ type: "put" })]);
    sim.runUntil(8000);
    expect(new Set(replicaData("x")).size).toBe(1);
    expect(stored(r1!, "x")?.sort()).toEqual(["left", "right"]);
  });

  it("is deterministic", () => {
    const run = () => {
      const { sim, rec } = store({
        seed: 9,
        actions: [put(10, "c1", "x", "a"), put(12, "c2", "x", "b"), get(300, "c1", "x")],
      });
      sim.runUntil(2000);
      return rec.hash();
    };
    expect(run()).toBe(run());
  });
});
