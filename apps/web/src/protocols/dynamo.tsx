import { useState } from "react";
import { Dynamo, type CanonicalValue, type ProcessState } from "@distro-lab/core";
import { ReplicaGrid, SlotChips } from "../components/ReplicaGrid.tsx";
import { sim } from "../sim/client.ts";
import { useSim } from "../state/store.ts";
import { Field, Timers } from "./common.tsx";
import type { MessageStyle, ProtocolUi } from "./ui.ts";

const MESSAGE_COLORS: Record<string, { color: string; label: string; minor?: boolean }> = {
  Replicate: { color: "var(--msg-write)", label: "Replicate" },
  ReplicateAck: { color: "var(--msg-write)", label: "Stored" },
  Read: { color: "var(--msg-read)", label: "Read" },
  ReadReply: { color: "var(--msg-read)", label: "Read reply" },
  Repair: { color: "var(--msg-repair)", label: "Read repair" },
  Handoff: { color: "var(--msg-repair)", label: "Hinted handoff" },
  HandoffAck: { color: "var(--msg-repair)", label: "Handoff ack" },
  SyncDigest: { color: "var(--msg-sync)", label: "Anti-entropy digest", minor: true },
  SyncData: { color: "var(--msg-sync)", label: "Anti-entropy data" },
  ClientRequest: { color: "var(--msg-client)", label: "Client request" },
  ClientReply: { color: "var(--msg-client)", label: "Client reply" },
};

function messageStyle(message: CanonicalValue): MessageStyle {
  const m = (message ?? {}) as { type?: string; entries?: object };
  const known = MESSAGE_COLORS[m.type ?? ""];
  // Anti-entropy that finds nothing to fix is background noise.
  const idleSync =
    m.type === "SyncData" && m.entries !== undefined && Object.keys(m.entries).length === 0;
  return {
    color: known?.color ?? "var(--muted)",
    label: known?.label ?? m.type ?? "message",
    minor: known?.minor === true || idleSync,
  };
}

const view = (p: ProcessState) => p.view as Dynamo.DynamoView;
const configOf = (config: CanonicalValue | undefined): Dynamo.DynamoConfig => ({
  ...Dynamo.DEFAULT_DYNAMO_CONFIG,
  ...((config ?? {}) as Partial<Dynamo.DynamoConfig>),
});

function DynamoServer({ p, now }: { p: ProcessState; now: number }) {
  const v = view(p);
  const keys = Object.keys(v.data).sort();
  const hints = Object.entries(v.hints).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
      <dl className="fields">
        <Field label="Status">
          {p.up ? "up" : <strong className="bad">crashed</strong>}
          {!p.up && <span className="muted"> (showing its durable data)</span>}
        </Field>
        <Field label="Coordinating">
          {v.pending === 0 ? "—" : `${v.pending} request${v.pending === 1 ? "" : "s"}`}
        </Field>
        <Field label="Timers">
          <Timers p={p} now={now} />
        </Field>
      </dl>
      <h3>Replica data</h3>
      {keys.length === 0 ? (
        <p className="muted">Empty.</p>
      ) : (
        <table className="kv">
          <tbody>
            {keys.map((k) => (
              <tr key={k}>
                <th>{k}</th>
                <td>
                  <SlotChips slot={v.data[k]!} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Hints</h3>
      {hints.length === 0 ? (
        <p className="muted">None: it holds nothing for other servers.</p>
      ) : (
        <table className="kv">
          <tbody>
            {hints.flatMap(([owner, store]) =>
              Object.keys(store)
                .sort()
                .map((k) => (
                  <tr key={`${owner}/${k}`}>
                    <th>
                      {k} for {owner}
                    </th>
                    <td>
                      <SlotChips slot={store[k]!} hint={`Hint held for ${owner}`} />
                    </td>
                  </tr>
                )),
            )}
          </tbody>
        </table>
      )}
    </>
  );
}

function DynamoSummary() {
  const { processes, config } = useSim();
  const c = configOf(config);
  const servers = processes.filter((p) => p.role === "server");
  const hints = servers.reduce(
    (sum, p) =>
      sum + Object.values(view(p).hints).reduce((s, store) => s + Object.keys(store).length, 0),
    0,
  );
  return (
    <>
      <Field label="Quorums">
        N={c.n} R={c.r} W={c.w}, {c.sloppy ? "sloppy" : "strict"}
        {Dynamo.promisesReadYourWrites(c) ? (
          <span className="good"> (reads see acknowledged writes)</span>
        ) : (
          <span className="muted"> (reads may miss acknowledged writes)</span>
        )}
      </Field>
      <Field label="Hints held">{hints === 0 ? "none" : hints}</Field>
    </>
  );
}

type OpType = "get" | "put" | "incr" | "add" | "remove";
const DEFAULT_KEY: Record<OpType, string> = {
  get: "x",
  put: "x",
  incr: "count:hits",
  add: "set:cart",
  remove: "set:cart",
};

function DynamoClientForm({ client }: { client: ProcessState }) {
  const [op, setOp] = useState<OpType>("put");
  const [key, setKey] = useState("x");
  const [value, setValue] = useState("1");
  const [by, setBy] = useState(1);
  const send = () => {
    const command =
      op === "get"
        ? { type: "get", key }
        : op === "put"
          ? { type: "put", key, value }
          : op === "incr"
            ? { type: "incr", key, by }
            : { type: op, key, element: value };
    sim.act({ type: "client", node: client.id, command });
  };
  return (
    <>
      <div className="row">
        <label className="field">
          Operation
          <select
            value={op}
            onChange={(e) => {
              const next = e.target.value as OpType;
              if (DEFAULT_KEY[next] !== DEFAULT_KEY[op]) setKey(DEFAULT_KEY[next]);
              setOp(next);
            }}
          >
            <option value="put">put</option>
            <option value="get">get</option>
            <option value="incr">incr (counter)</option>
            <option value="add">add (set)</option>
            <option value="remove">remove (set)</option>
          </select>
        </label>
        <label className="field">
          Key
          <input value={key} onChange={(e) => setKey(e.target.value)} size={9} />
        </label>
        {op === "incr" && (
          <label className="field">
            By
            <input
              type="number"
              min={1}
              value={by}
              onChange={(e) => setBy(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
              size={3}
            />
          </label>
        )}
        {(op === "put" || op === "add" || op === "remove") && (
          <label className="field">
            {op === "put" ? "Value" : "Element"}
            <input value={value} onChange={(e) => setValue(e.target.value)} size={6} />
          </label>
        )}
      </div>
      <div className="row">
        <button type="button" className="primary" onClick={send} disabled={!client.up}>
          Send from {client.id}
        </button>
        <span className="muted small">
          {op === "put"
            ? "Replaces what this client last read of the key; concurrent puts become siblings."
            : op === "remove"
              ? "Removes only the tags this client last saw; concurrent adds survive."
              : "Keys starting count: are counters and set: are sets; others are registers."}
        </span>
      </div>
    </>
  );
}

function describeOp(op: CanonicalValue): string {
  const o = op as Dynamo.DynamoOp;
  switch (o.type) {
    case "get":
      return `get ${o.key}`;
    case "put":
      return `put ${o.key} = ${o.value}${o.context === undefined ? "" : ` (replacing ${Dynamo.formatContext(o.context)})`}`;
    case "incr":
      return `incr ${o.key} by ${o.by}`;
    case "add":
      return `add ${o.element} to ${o.key}`;
    case "remove":
      return `remove ${o.element} from ${o.key}${o.observed === undefined ? "" : ` (${o.observed.length} tag${o.observed.length === 1 ? "" : "s"} seen)`}`;
    default:
      return JSON.stringify(op);
  }
}

function describeResult(result: CanonicalValue): { text: string; ok: boolean } {
  const r = result as Dynamo.DynamoResult;
  switch (r.type) {
    case "get":
      return {
        text:
          r.versions.length === 0
            ? "∅"
            : r.versions.map((v) => `${v.value}@${Dynamo.formatDot(v.dot)}`).join(" | ") +
              (r.versions.length > 1 ? " (siblings)" : ""),
        ok: true,
      };
    case "crdt":
      return { text: Dynamo.formatCrdt(r.state), ok: true };
    case "put":
      return { text: `ok @${Dynamo.formatDot(r.dot)}`, ok: true };
    case "incr":
      return { text: `ok (${r.node} total ${r.total})`, ok: true };
    case "add":
      return { text: `ok, tag ${Dynamo.formatDot(r.tag)}`, ok: true };
    case "remove":
      return {
        text: `ok, ${r.observed.length} tag${r.observed.length === 1 ? "" : "s"}`,
        ok: true,
      };
    case "invalid":
      return { text: r.reason, ok: false };
  }
}

export const dynamoUi: ProtocolUi = {
  roles: [
    { role: "replica", label: "Server" },
    { role: "hinted", label: "Holding hints" },
  ],
  messages: [
    { color: "var(--msg-write)", label: "Writes" },
    { color: "var(--msg-read)", label: "Reads" },
    { color: "var(--msg-repair)", label: "Repair and handoff" },
    { color: "var(--msg-sync)", label: "Anti-entropy" },
    { color: "var(--msg-client)", label: "Client" },
  ],
  minorLabel: "Hide idle anti-entropy",
  serverBadge(v) {
    const d = (v ?? {}) as Partial<Dynamo.DynamoView>;
    const hints = Object.values(d.hints ?? {}).reduce(
      (s, store) => s + Object.keys(store).length,
      0,
    );
    const keys = Object.keys(d.data ?? {}).length;
    return hints > 0
      ? { role: "hinted", caption: `${hints} hint${hints === 1 ? "" : "s"}` }
      : { role: "replica", caption: `${keys} key${keys === 1 ? "" : "s"}` };
  },
  messageStyle,
  ringTimer: () => null,
  timerButtons: [
    {
      key: "sync",
      label: "Anti-entropy now",
      title: "Compare notes with this server's next anti-entropy partner now",
    },
  ],
  describeOp,
  describeResult,
  dataTitle: "Replicas",
  DataPanel: ReplicaGrid,
  ServerDetail: DynamoServer,
  Summary: DynamoSummary,
  ClientForm: DynamoClientForm,
};
