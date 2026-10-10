import { useState } from "react";
import type { CanonicalValue, LinkNetworkView, NetworkChange } from "@distro-lab/core";
import { clientCaption } from "../protocolUi.ts";
import { sim } from "../sim/client.ts";
import { useSim } from "../state/store.ts";
import { Schedule } from "./Schedule.tsx";

type Tab = "links" | "partition" | "network" | "clients" | "schedule";

const net = (change: NetworkChange) =>
  sim.act({ type: "network", change: change as unknown as CanonicalValue });

function NumberField(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="field">
      {props.label}
      <input
        type="number"
        value={props.value}
        min={props.min ?? 0}
        max={props.max}
        step={props.step ?? 1}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function LinkEditor() {
  const { processes, network } = useSim();
  const ids = processes.map((p) => p.id);
  const [from, setFrom] = useState(ids[0] ?? "");
  const [to, setTo] = useState(ids[1] ?? "");
  const [both, setBoth] = useState(true);
  const link = (network as LinkNetworkView | null)?.links.find(
    (l) => l.from === from && l.to === to,
  );
  const [draft, setDraft] = useState<{
    latencyMs: number;
    jitterMs: number;
    loss: number;
    duplicate: number;
  } | null>(null);
  const values = draft ?? {
    latencyMs: link?.latencyMs ?? 10,
    jitterMs: link?.jitterMs ?? 0,
    loss: link?.loss ?? 0,
    duplicate: link?.duplicate ?? 0,
  };
  const set = (k: keyof typeof values) => (v: number) => setDraft({ ...values, [k]: v });
  const apply = (extra: { up?: boolean } = {}) => {
    net({ type: "setLink", from, to, bidirectional: both, ...values, ...extra });
    setDraft(null);
  };
  return (
    <div className="tool">
      <div className="row">
        <label className="field">
          From
          <select
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setDraft(null);
            }}
          >
            {ids.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        </label>
        <label className="field">
          To
          <select
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setDraft(null);
            }}
          >
            {ids
              .filter((id) => id !== from)
              .map((id) => (
                <option key={id}>{id}</option>
              ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} />
          Both directions
        </label>
      </div>
      <p className="muted small">
        {from}→{to} is{" "}
        {link === undefined
          ? "unknown"
          : link.connected
            ? "carrying traffic"
            : link.up
              ? "blocked by a partition"
              : "down"}
        .
      </p>
      <div className="row">
        <NumberField label="Latency ms" value={values.latencyMs} onChange={set("latencyMs")} />
        <NumberField label="Jitter ms" value={values.jitterMs} onChange={set("jitterMs")} />
        <NumberField label="Loss" value={values.loss} onChange={set("loss")} max={1} step={0.05} />
        <NumberField
          label="Duplicate"
          value={values.duplicate}
          onChange={set("duplicate")}
          max={1}
          step={0.05}
        />
      </div>
      <div className="row">
        <button type="button" onClick={() => apply()}>
          Apply settings
        </button>
        <button type="button" onClick={() => apply({ up: false })}>
          Cut link
        </button>
        <button type="button" onClick={() => apply({ up: true })}>
          Restore link
        </button>
      </div>
      <p className="muted small">
        Cutting one direction only (untick “Both directions”) makes asymmetric connectivity: {from}{" "}
        can hear {to} but not reach it. Heal does not undo link cuts; Restore all (Network tab)
        does.
      </p>
    </div>
  );
}

function PartitionBuilder() {
  const { processes } = useSim();
  const [side, setSide] = useState<Record<string, 1 | 2>>({});
  const sideOf = (id: string) => side[id] ?? 1;
  const groups = [1, 2].map((g) => processes.map((p) => p.id).filter((id) => sideOf(id) === g));
  return (
    <div className="tool">
      <p className="muted small">
        Put each process on a side, then split the network between the sides.
      </p>
      <div className="partition-grid">
        {processes.map((p) => (
          <div key={p.id} className="partition-row">
            <strong>{p.id}</strong>
            {[1, 2].map((g) => (
              <label key={g}>
                <input
                  type="radio"
                  name={`side-${p.id}`}
                  checked={sideOf(p.id) === g}
                  onChange={() => setSide((s) => ({ ...s, [p.id]: g as 1 | 2 }))}
                />
                Side {g}
              </label>
            ))}
          </div>
        ))}
      </div>
      <div className="row">
        <button
          type="button"
          disabled={groups.some((g) => g.length === 0)}
          onClick={() => net({ type: "partition", groups })}
        >
          Partition: {groups[0]!.join(",") || "—"} | {groups[1]!.join(",") || "—"}
        </button>
        <button type="button" onClick={() => net({ type: "heal" })}>
          Heal
        </button>
      </div>
    </div>
  );
}

function NetworkWide() {
  const [v, setV] = useState({ latencyMs: 80, jitterMs: 150, loss: 0.1, duplicate: 0.1 });
  const set = (k: keyof typeof v) => (n: number) => setV({ ...v, [k]: n });
  return (
    <div className="tool">
      <p className="muted small">
        Apply the same settings to every link (a network-wide slowdown or storm).
      </p>
      <div className="row">
        <NumberField label="Latency ms" value={v.latencyMs} onChange={set("latencyMs")} />
        <NumberField label="Jitter ms" value={v.jitterMs} onChange={set("jitterMs")} />
        <NumberField label="Loss" value={v.loss} onChange={set("loss")} max={1} step={0.05} />
        <NumberField
          label="Duplicate"
          value={v.duplicate}
          onChange={set("duplicate")}
          max={1}
          step={0.05}
        />
      </div>
      <div className="row">
        <button type="button" onClick={() => net({ type: "setAll", ...v })}>
          Degrade all links
        </button>
        <button type="button" onClick={() => net({ type: "restore" })}>
          Restore all (undo every network change)
        </button>
      </div>
    </div>
  );
}

function ClientTool() {
  const { processes } = useSim();
  const clients = processes.filter((p) => p.role === "client");
  const [client, setClient] = useState(clients[0]?.id ?? "");
  const [op, setOp] = useState<"put" | "get" | "cas">("put");
  const [key, setKey] = useState("x");
  const [value, setValue] = useState("1");
  const [expect, setExpect] = useState("");
  const current = clients.find((c) => c.id === client) ?? clients[0];
  if (current === undefined) return <p className="muted">This scenario has no clients.</p>;
  const send = () => {
    const command =
      op === "get"
        ? { type: "get", key }
        : op === "put"
          ? { type: "put", key, value }
          : { type: "cas", key, expect: expect === "" ? null : expect, value };
    sim.act({ type: "client", node: current.id, command });
  };
  return (
    <div className="tool">
      <div className="row">
        <label className="field">
          Client
          <select value={current.id} onChange={(e) => setClient(e.target.value)}>
            {clients.map((c) => (
              <option key={c.id}>{c.id}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Operation
          <select value={op} onChange={(e) => setOp(e.target.value as typeof op)}>
            <option value="put">put</option>
            <option value="get">get</option>
            <option value="cas">cas</option>
          </select>
        </label>
        <label className="field">
          Key
          <input value={key} onChange={(e) => setKey(e.target.value)} size={6} />
        </label>
        {op !== "get" && (
          <label className="field">
            Value
            <input value={value} onChange={(e) => setValue(e.target.value)} size={6} />
          </label>
        )}
        {op === "cas" && (
          <label className="field">
            Expect
            <input
              value={expect}
              onChange={(e) => setExpect(e.target.value)}
              size={6}
              placeholder="absent"
            />
          </label>
        )}
      </div>
      <div className="row">
        <button type="button" className="primary" onClick={send} disabled={!current.up}>
          Send from {current.id}
        </button>
        <span className="muted small">
          {current.up ? clientCaption(current.view) : "client is down"}. Operations queue and run
          one at a time; select the client in the cluster to see results.
        </span>
      </div>
    </div>
  );
}

export function Tools() {
  const [tab, setTab] = useState<Tab>("clients");
  const tabs: { id: Tab; label: string }[] = [
    { id: "clients", label: "Clients" },
    { id: "partition", label: "Partition" },
    { id: "links", label: "Links" },
    { id: "network", label: "Network" },
    { id: "schedule", label: "Schedule" },
  ];
  return (
    <div>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "clients" && <ClientTool />}
      {tab === "partition" && <PartitionBuilder />}
      {tab === "links" && <LinkEditor />}
      {tab === "network" && <NetworkWide />}
      {tab === "schedule" && <Schedule />}
    </div>
  );
}
