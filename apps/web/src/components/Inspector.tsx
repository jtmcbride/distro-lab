import type { ProcessState, Raft } from "@distro-lab/core";
import { useSim } from "../state/store.ts";
import { trace } from "../state/trace.ts";
import { formatMs } from "./PlaybackBar.tsx";

const isRaft = (protocol: string) => protocol === "raft" || protocol.startsWith("raft-");

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Timers({ p, now }: { p: ProcessState; now: number }) {
  if (!p.up) return <span className="muted">none (down)</span>;
  if (p.timers.length === 0) return <span className="muted">none</span>;
  return (
    <>
      {p.timers.map((t) => (
        <span key={t.key} className="pill">
          {t.key} in {Math.max(0, t.at - now).toFixed(0)} ms
        </span>
      ))}
    </>
  );
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

interface Op {
  seq: number;
  op: unknown;
  invokedAt: number;
  result?: unknown;
  latencyMs?: number;
  retries: number;
}

/** A client's operations, from its invoke/retry/complete annotations. */
function clientHistory(client: string): Op[] {
  const ops = new Map<number, Op>();
  for (const r of trace) {
    if (r.type !== "annotate" || r.node !== client) continue;
    const d = r.data as { seq: number; op?: unknown; result?: unknown; latencyMs?: number };
    if (r.label === "invoke") ops.set(d.seq, { seq: d.seq, op: d.op, invokedAt: r.t, retries: 0 });
    const op = ops.get(d.seq);
    if (op === undefined) continue;
    if (r.label === "retry") op.retries++;
    if (r.label === "complete") {
      op.result = d.result;
      if (d.latencyMs !== undefined) op.latencyMs = d.latencyMs;
    }
  }
  return [...ops.values()].slice(-12).reverse();
}

const describeOp = (op: unknown) => {
  const o = op as { type?: string; key?: string; value?: string; expect?: string | null };
  if (o.type === "put") return `put ${o.key} = ${o.value}`;
  if (o.type === "get") return `get ${o.key}`;
  if (o.type === "cas") return `cas ${o.key}: ${o.expect ?? "∅"} → ${o.value}`;
  return JSON.stringify(op);
};

function Client({ p }: { p: ProcessState }) {
  const v = p.view as {
    nextSeq: number;
    queued: number;
    inFlight: number | null;
    leaderHint: string | null;
    completed: number;
  };
  const history = clientHistory(p.id);
  return (
    <>
      <dl className="fields">
        <Field label="Status">{p.up ? "up" : <strong className="bad">crashed</strong>}</Field>
        <Field label="In flight">{v.inFlight === null ? "—" : `#${v.inFlight}`}</Field>
        <Field label="Queued">{v.queued}</Field>
        <Field label="Completed">{v.completed}</Field>
        <Field label="Leader hint">{v.leaderHint ?? "—"}</Field>
      </dl>
      <h3>Recent operations</h3>
      {history.length === 0 ? (
        <p className="muted">None yet. Send one from the client tools.</p>
      ) : (
        <table className="ops">
          <tbody>
            {history.map((o) => {
              const r = o.result as { ok: boolean; value: string | null } | undefined;
              return (
                <tr key={o.seq}>
                  <td>#{o.seq}</td>
                  <td>{describeOp(o.op)}</td>
                  <td className={r === undefined ? "muted" : r.ok ? "good" : "bad"}>
                    {r === undefined ? "pending" : `${r.ok ? "ok" : "failed"} → ${r.value ?? "∅"}`}
                  </td>
                  <td className="muted">
                    {o.latencyMs === undefined ? "" : formatMs(o.latencyMs)}
                    {o.retries > 0 ? ` · ${o.retries} retr${o.retries === 1 ? "y" : "ies"}` : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function Summary() {
  const { processes, violations } = useSim();
  const servers = processes.filter((p) => p.role === "server");
  const up = servers.filter((p) => p.up);
  const leaders = up.filter((p) => (p.view as { role?: string }).role === "leader");
  const majority = Math.floor(servers.length / 2) + 1;
  return (
    <dl className="fields">
      <Field label="Servers up">
        {up.length} of {servers.length}{" "}
        {up.length >= majority ? (
          <span className="good">(majority available)</span>
        ) : (
          <span className="bad">(no majority: no progress possible)</span>
        )}
      </Field>
      <Field label="Leaders">
        {leaders.length === 0
          ? "none"
          : leaders.map((l) => `${l.id} (t${(l.view as { term: number }).term})`).join(", ")}
      </Field>
      <Field label="Violations">
        {violations.length === 0 ? (
          <span className="good">none</span>
        ) : (
          <span className="bad">{violations.length}</span>
        )}
      </Field>
      <Field label="Tip">
        <span className="muted">Select a node in the cluster to inspect it.</span>
      </Field>
    </dl>
  );
}

export function Inspector() {
  const { processes, selectedProcess, now, protocol } = useSim();
  useSim((s) => s.traceVersion);
  const p = processes.find((x) => x.id === selectedProcess);
  if (p === undefined) return <Summary />;
  return (
    <div>
      <h3 className="inspector-title">
        {p.role === "server" ? "Server" : "Client"} {p.id}
      </h3>
      {p.role === "client" ? (
        <Client p={p} />
      ) : isRaft(protocol) ? (
        <RaftServer p={p} now={now} />
      ) : (
        <pre>{JSON.stringify(p.view, null, 2)}</pre>
      )}
    </div>
  );
}
