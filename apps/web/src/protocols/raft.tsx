import { useState } from "react";
import type { CanonicalValue, ProcessState, Raft } from "@distro-lab/core";
import { LogGrid } from "../components/LogGrid.tsx";
import { sim } from "../sim/client.ts";
import { useSim } from "../state/store.ts";
import { Field, Timers } from "./common.tsx";
import type { MessageStyle, ProtocolUi } from "./ui.ts";

const MESSAGE_COLORS: Record<string, { color: string; label: string }> = {
  RequestVote: { color: "var(--msg-vote)", label: "RequestVote" },
  RequestVoteResponse: { color: "var(--msg-vote)", label: "Vote reply" },
  AppendEntries: { color: "var(--msg-append)", label: "AppendEntries" },
  AppendEntriesResponse: { color: "var(--msg-append)", label: "Append reply" },
  ClientRequest: { color: "var(--msg-client)", label: "Client request" },
  ClientReply: { color: "var(--msg-client)", label: "Client reply" },
};

function messageStyle(message: CanonicalValue): MessageStyle {
  const m = (message ?? {}) as { type?: string; entries?: unknown[] };
  const known = MESSAGE_COLORS[m.type ?? ""];
  const heartbeat =
    (m.type === "AppendEntries" && Array.isArray(m.entries) && m.entries.length === 0) ||
    m.type === "AppendEntriesResponse";
  return {
    color: known?.color ?? "var(--muted)",
    label: known?.label ?? m.type ?? "message",
    minor: heartbeat,
  };
}

function RaftServer({ p, now }: { p: ProcessState; now: number }) {
  const v = p.view as Raft.RaftView;
  const data = Object.entries(v.data).sort(([a], [b]) => a.localeCompare(b));
  const sessions = Object.entries(v.sessions);
  return (
    <>
      <dl className="fields">
        <Field label="Status">
          {p.up ? (
            <strong className={`role-text role-${v.role}`}>{v.role}</strong>
          ) : (
            <strong className="bad">crashed</strong>
          )}
          {!p.up && <span className="muted"> (showing last state; volatile state is lost)</span>}
        </Field>
        <Field label="Term">{v.term}</Field>
        <Field label="Voted for">{v.votedFor ?? "—"}</Field>
        <Field label="Follows">{v.leaderId ?? "—"}</Field>
        <Field label="Log">
          {v.log.length} entries · committed to {v.commitIndex} · applied to {v.lastApplied}
        </Field>
        <Field label="Timers">
          <Timers p={p} now={now} />
        </Field>
      </dl>
      <h3>Key-value data</h3>
      {data.length === 0 ? (
        <p className="muted">Empty (state is rebuilt by applying committed entries).</p>
      ) : (
        <table className="kv">
          <tbody>
            {data.map(([k, val]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{val}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Client sessions</h3>
      {sessions.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <p className="sessions">
          {sessions.map(([c, seq]) => (
            <span key={c} className="pill">
              {c}: up to #{seq}
            </span>
          ))}
        </p>
      )}
    </>
  );
}

function RaftSummary() {
  const { processes } = useSim();
  const servers = processes.filter((p) => p.role === "server");
  const up = servers.filter((p) => p.up);
  const leaders = up.filter((p) => (p.view as { role?: string }).role === "leader");
  const majority = Math.floor(servers.length / 2) + 1;
  return (
    <>
      <Field label="Majority">
        {up.length >= majority ? (
          <span className="good">available</span>
        ) : (
          <span className="bad">lost: no progress possible</span>
        )}
      </Field>
      <Field label="Leaders">
        {leaders.length === 0
          ? "none"
          : leaders.map((l) => `${l.id} (t${(l.view as { term: number }).term})`).join(", ")}
      </Field>
    </>
  );
}

function RaftClientForm({ client }: { client: ProcessState }) {
  const [op, setOp] = useState<"put" | "get" | "cas">("put");
  const [key, setKey] = useState("x");
  const [value, setValue] = useState("1");
  const [expect, setExpect] = useState("");
  const send = () => {
    const command =
      op === "get"
        ? { type: "get", key }
        : op === "put"
          ? { type: "put", key, value }
          : { type: "cas", key, expect: expect === "" ? null : expect, value };
    sim.act({ type: "client", node: client.id, command });
  };
  return (
    <>
      <div className="row">
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
        <button type="button" className="primary" onClick={send} disabled={!client.up}>
          Send from {client.id}
        </button>
      </div>
    </>
  );
}

export const raftUi: ProtocolUi = {
  roles: [
    { role: "leader", label: "Leader" },
    { role: "candidate", label: "Candidate" },
    { role: "follower", label: "Follower" },
  ],
  messages: [
    { color: "var(--msg-vote)", label: "Votes" },
    { color: "var(--msg-append)", label: "Replication" },
    { color: "var(--msg-client)", label: "Client" },
  ],
  minorLabel: "Hide heartbeats",
  serverBadge(view) {
    const v = (view ?? {}) as { role?: string; term?: number };
    const role =
      v.role === "leader" || v.role === "candidate" || v.role === "follower" ? v.role : "unknown";
    return { role, caption: v.term === undefined ? "" : `t${v.term}` };
  },
  messageStyle,
  ringTimer(config) {
    const c = (config ?? {}) as { electionTimeoutMaxMs?: number };
    return {
      key: "election",
      maxMs: c.electionTimeoutMaxMs ?? 300,
      label: "Ring: time left before an election timeout",
    };
  },
  timerButtons: [
    { key: "election", label: "Force election", title: "Fire this node's election timer now" },
  ],
  describeOp(op) {
    const o = op as { type?: string; key?: string; value?: string; expect?: string | null };
    if (o.type === "put") return `put ${o.key} = ${o.value}`;
    if (o.type === "get") return `get ${o.key}`;
    if (o.type === "cas") return `cas ${o.key}: ${o.expect ?? "∅"} → ${o.value}`;
    return JSON.stringify(op);
  },
  describeResult(result) {
    const r = result as { ok: boolean; value: string | null };
    return { text: `${r.ok ? "ok" : "failed"} → ${r.value ?? "∅"}`, ok: r.ok };
  },
  dataTitle: "Replicated logs",
  DataPanel: LogGrid,
  ServerDetail: RaftServer,
  Summary: RaftSummary,
  ClientForm: RaftClientForm,
};
