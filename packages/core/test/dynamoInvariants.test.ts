import { describe, expect, it } from "vitest";
import {
  Dynamo,
  InvariantMonitor,
  type CanonicalValue,
  type Observable,
  type TraceRecord,
  type TraceSink,
} from "../src/index.ts";

type View = Dynamo.DynamoView;
type Version = Dynamo.Version;
type NodeState = Partial<View> & { up?: boolean };
type Step = Record<string, NodeState>;

const STRICT = { ...Dynamo.DEFAULT_DYNAMO_CONFIG, sloppy: false };

/**
 * Feeds a scripted sequence of cluster states through the monitor. `records[i]` are trace
 * records emitted while moving to state i.
 */
function replay(states: Step[], records: TraceRecord[][] = [], config = STRICT) {
  let current = states[0]!;
  const listeners: (() => void)[] = [];
  const sinks: TraceSink[] = [];
  let step = 0;
  const fake: Observable = {
    get now() {
      return step;
    },
    get lastRecordId() {
      return step;
    },
    nodeIds: Object.keys(current),
    isUp: (n) => current[n]?.up !== false,
    incarnation: () => 0,
    addSink: (sink) => sinks.push(sink),
    view: (n) => {
      const { up: _up, ...v } = current[n]!;
      return { counter: 0, data: {}, hints: {}, pending: 0, ...v } as CanonicalValue;
    },
    onStep: (l) => listeners.push(l),
  };
  const monitor = new InvariantMonitor<View>(fake, Dynamo.dynamoInvariants(config));
  for (const s of states.slice(1)) {
    current = s;
    step++;
    for (const r of records[step] ?? []) sinks.forEach((sink) => sink({ ...r, t: step }));
    listeners.forEach((l) => l());
  }
  return monitor.violations.map((v) => `${v.invariant}@${v.t}`);
}

const v = (
  value: string,
  node: string,
  counter: number,
  context: Dynamo.Clock = {},
  write = value,
): Version => ({
  value,
  dot: { node, counter },
  context: { vv: context, dots: [] },
  write,
});
let nextId = 0;
const note = (node: string, label: string, data: CanonicalValue): TraceRecord => ({
  id: nextId++,
  t: 0,
  cause: null,
  type: "annotate",
  node,
  label,
  data,
});
const invokePut = (client: string, seq: number, key: string, value: string) =>
  note(client, "invoke", { seq, op: { type: "put", key, value } });
const invokeGet = (client: string, seq: number, key: string) =>
  note(client, "invoke", { seq, op: { type: "get", key } });
const completePut = (client: string, seq: number, node: string, counter: number) =>
  note(client, "complete", {
    seq,
    result: { type: "put", dot: { node, counter }, write: `${client}#${seq}` },
  });
const completeGet = (client: string, seq: number, versions: Version[]) =>
  note(client, "complete", { seq, result: { type: "get", versions } });

describe("Dynamo invariants", () => {
  const x1 = v("1", "A", 1, {}, "c1#1");
  const x2 = v("2", "B", 1, { A: 1 }, "c1#2");

  it("accept a correct history", () => {
    expect(
      replay(
        [
          { A: {}, B: {} },
          { A: { data: { x: [x1] } }, B: { hints: { C: { x: [x1] } } } },
          { A: { data: { x: [x2] } }, B: { hints: { C: { x: [x1] } } } },
          { A: { data: { x: [x2] } }, B: {} },
        ],
        [[], [invokePut("c1", 1, "x", "1"), completePut("c1", 1, "A", 1)]],
      ),
    ).toEqual([]);
  });

  it("flag siblings where one includes the other", () => {
    expect(replay([{ A: {} }, { A: { data: { x: [x1, x2] } } }])).toEqual([
      "siblings-concurrent@1",
    ]);
  });

  it("flag a dot reused by another write, even after the first is gone", () => {
    expect(
      replay([
        { A: {}, B: {} },
        { A: { data: { x: [x1] } }, B: {} },
        { A: { data: { x: [x2] } }, B: {} },
        { A: { data: { x: [x2] } }, B: { data: { x: [v("other", "A", 1, {}, "c2#1")] } } },
      ]),
    ).toEqual(["unique-dots@3"]);
  });

  it("flag a replica that drops a version nothing replaced", () => {
    expect(
      replay([
        { A: {} },
        { A: { data: { x: [x1, v("b", "B", 1)] } } },
        { A: { data: { x: [v("b", "B", 1)] } } },
      ]),
    ).toEqual(["replicas-monotonic@2"]);
  });

  it("flag an acknowledged put that is on no server", () => {
    expect(
      replay(
        [
          { A: {}, B: {} },
          { A: { data: { x: [x1] } }, B: { hints: { C: { x: [x1] } } } },
          { A: { data: { x: [x1] } }, B: {} },
          { A: { data: { x: [] } }, B: {} },
        ],
        [[], [invokePut("c1", 1, "x", "1"), completePut("c1", 1, "A", 1)]],
      ),
    ).toEqual(["replicas-monotonic@3", "acknowledged-writes-durable@3"]);
  });

  it("flag a read of a value nobody wrote", () => {
    expect(
      replay(
        [{ A: {} }, { A: { data: { x: [x1] } } }, { A: { data: { x: [x1] } } }],
        [
          [],
          [invokePut("c1", 1, "x", "1"), completePut("c1", 1, "A", 1)],
          [invokeGet("c2", 1, "x"), completeGet("c2", 1, [v("forged", "A", 1, {}, "c1#1")])],
        ],
      ),
    ).toEqual(["reads-return-written-values@2"]);
  });

  it("flag a strict-quorum read that misses an earlier acknowledged put", () => {
    const records = [
      [],
      [invokePut("c1", 1, "x", "1"), completePut("c1", 1, "A", 1)],
      [invokeGet("c2", 1, "x"), completeGet("c2", 1, [])],
    ];
    const states: Step[] = [{ A: {} }, { A: { data: { x: [x1] } } }, { A: { data: { x: [x1] } } }];
    expect(replay(states, records)).toEqual(["reads-see-acknowledged-writes@2"]);
    // Sloppy quorums do not promise it.
    expect(replay(states, records, Dynamo.DEFAULT_DYNAMO_CONFIG)).toEqual([]);
  });

  it("accept a read that started before the put was acknowledged", () => {
    expect(
      replay(
        [{ A: {} }, { A: {} }, { A: { data: { x: [x1] } } }],
        [
          [],
          [invokeGet("c2", 1, "x"), invokePut("c1", 1, "x", "1")],
          [completePut("c1", 1, "A", 1), completeGet("c2", 1, [])],
        ],
      ),
    ).toEqual([]);
  });
});
