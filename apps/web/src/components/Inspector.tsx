import { useState } from "react";
import type { ProcessState } from "@distro-lab/core";
import { Field, useProtocolUi } from "../protocols/index.ts";
import { sim } from "../sim/client.ts";
import { useSim } from "../state/store.ts";
import { trace } from "../state/trace.ts";
import { formatMs } from "./PlaybackBar.tsx";

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

function Client({ p }: { p: ProcessState }) {
  const ui = useProtocolUi();
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
        <Field label="Server hint">{v.leaderHint ?? "—"}</Field>
      </dl>
      <h3>Recent operations</h3>
      {history.length === 0 ? (
        <p className="muted">None yet. Send one from the client tools.</p>
      ) : (
        <table className="ops">
          <tbody>
            {history.map((o) => {
              const r = o.result === undefined ? undefined : ui.describeResult(o.result as never);
              return (
                <tr key={o.seq}>
                  <td>#{o.seq}</td>
                  <td>{ui.describeOp(o.op as never)}</td>
                  <td className={r === undefined ? "muted" : r.ok ? "good" : "bad"}>
                    {r === undefined ? "pending" : r.text}
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
  const ui = useProtocolUi();
  const servers = processes.filter((p) => p.role === "server");
  const up = servers.filter((p) => p.up);
  return (
    <dl className="fields">
      <Field label="Servers up">
        {up.length} of {servers.length}
      </Field>
      <ui.Summary />
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

/**
 * A process's local clock, and a control to change its rate (recorded in the scenario as a
 * `clock` action, so a session with clock changes replays exactly).
 */
function Clock({ p }: { p: ProcessState }) {
  const [rate, setRate] = useState(String(p.clock.rate));
  const parsed = Number(rate);
  const valid = rate !== "" && Number.isFinite(parsed) && parsed > 0;
  return (
    <dl className="fields clock-fields">
      <Field label="Local clock">
        {formatMs(p.clock.now)}
        <span className={p.clock.rate === 1 ? "muted" : "warn"}> · runs at {p.clock.rate}×</span>
      </Field>
      <Field label="Clock rate">
        <form
          className="clock-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && parsed !== p.clock.rate)
              sim.act({ type: "clock", node: p.id, rate: parsed });
          }}
        >
          <input
            type="number"
            min="0.05"
            step="0.05"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            aria-label={`Clock rate of ${p.id}`}
          />
          <button type="submit" disabled={!valid || parsed === p.clock.rate}>
            Set
          </button>
        </form>
      </Field>
    </dl>
  );
}

export function Inspector() {
  const { processes, selectedProcess, now } = useSim();
  const ui = useProtocolUi();
  useSim((s) => s.traceVersion);
  const p = processes.find((x) => x.id === selectedProcess);
  if (p === undefined) return <Summary />;
  return (
    <div>
      <h3 className="inspector-title">
        {p.role === "server" ? "Server" : "Client"} {p.id}
      </h3>
      {p.role === "client" ? <Client p={p} /> : <ui.ServerDetail p={p} now={now} />}
      <Clock key={`${p.id}-${p.clock.rate}`} p={p} />
    </div>
  );
}
