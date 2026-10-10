import { formatRecord, type TraceRecord } from "@distro-lab/core";
import { currentCone } from "../state/cone.ts";
import { useSim } from "../state/store.ts";
import { trace } from "../state/trace.ts";

/** Crashes, recoveries and forced timeouts: what a scenario does to processes. */
const isFault = (r: TraceRecord) =>
  r.type === "crash" || r.type === "recover" || (r.type === "timer" && r.cause === null);

/** Summary of the causal past being explained; the other views dim everything outside it. */
export function Explain() {
  const explain = useSim((s) => s.explain);
  useSim((s) => s.traceVersion);
  if (explain === null) return null;
  const cone = currentCone();
  const close = () => useSim.setState({ explain: null });
  if (cone === null) {
    return (
      <div className="explain" role="status">
        <span>Go forward past {explain.label} to see its causal past.</span>
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
    );
  }
  const select = (id: number) => useSim.setState({ selectedRecord: id });
  const faults = [...cone.past]
    .sort((a, b) => a - b)
    .map((id) => trace[id]!)
    .filter(isFault);
  const omissions = [...cone.omissions].sort((a, b) => a - b).map((id) => trace[id]!);
  const processes = new Set(
    [...cone.past].map((id) => {
      const r = trace[id]!;
      return r.type === "send" ? r.from : r.type === "deliver" ? r.to : "node" in r ? r.node : "";
    }),
  );
  processes.delete("");
  const list = (records: TraceRecord[]) => (
    <ul>
      {records.map((r) => (
        <li key={r.id}>
          <button type="button" className="link-button" onClick={() => select(r.id)}>
            <code>{formatRecord(r)}</code>
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="explain" role="status" aria-label="Causal past">
      <strong>Causal past of {explain.label}</strong>
      <span className="muted small">
        {cone.past.size.toLocaleString()} of {(explain.record + 1).toLocaleString()} earlier events
        could have influenced it, across {[...processes].sort().join(", ")}. Everything else is
        dimmed.
      </span>
      <button type="button" onClick={close}>
        Close
      </button>
      <div className="explain-lists">
        <div>
          Scripted faults in it ({faults.length}):
          {faults.length === 0 ? <p className="muted small">none</p> : list(faults)}
        </div>
        <div>
          Faults that mattered by dropping its messages ({omissions.length}):
          {omissions.length === 0 ? <p className="muted small">none</p> : list(omissions)}
        </div>
      </div>
    </div>
  );
}
