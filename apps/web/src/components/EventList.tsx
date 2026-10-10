import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatRecord, type TraceRecord } from "@distro-lab/core";
import { sim } from "../sim/client.ts";
import { useSim } from "../state/store.ts";
import { trace } from "../state/trace.ts";

type Kind = "protocol" | "messages" | "timers" | "faults" | "clients";

const KINDS: { id: Kind; label: string }[] = [
  { id: "protocol", label: "Protocol events" },
  { id: "faults", label: "Faults & recovery" },
  { id: "clients", label: "Client requests" },
  { id: "timers", label: "Timers" },
  { id: "messages", label: "Messages" },
];

function kindOf(r: TraceRecord): Kind {
  switch (r.type) {
    case "send":
    case "deliver":
    case "drop":
      return "messages";
    case "timer":
      return "timers";
    case "crash":
    case "recover":
    case "network":
      return "faults";
    case "client":
      return "clients";
    case "annotate":
      return r.label === "invoke" || r.label === "complete" || r.label === "retry"
        ? "clients"
        : "protocol";
    case "init":
      return "protocol";
  }
}

function involves(r: TraceRecord, id: string): boolean {
  switch (r.type) {
    case "send":
    case "deliver":
    case "drop":
      return r.from === id || r.to === id;
    case "network":
      return true;
    default:
      return r.node === id;
  }
}

const ROW_H = 22;

/**
 * Every trace record, virtualized and filtered incrementally (new records are matched as
 * they arrive; the full trace is rescanned only when filters change or the trace resets).
 */
export function EventList() {
  const { processes, selectedRecord } = useSim();
  const traceVersion = useSim((s) => s.traceVersion);
  const [kinds, setKinds] = useState<Set<Kind>>(
    () => new Set<Kind>(["protocol", "faults", "clients"]),
  );
  const [process, setProcess] = useState("");
  const [follow, setFollow] = useState(true);
  const parentRef = useRef<HTMLDivElement>(null);

  // Incrementally maintained list of matching trace indexes.
  const filtered = useRef<{
    key: string;
    read: number;
    firstId: number | undefined;
    rows: number[];
  }>({ key: "", read: 0, firstId: undefined, rows: [] });
  const key = `${[...kinds].sort().join()}|${process}`;
  const rows = useMemo(() => {
    const f = filtered.current;
    if (f.key !== key || trace.length < f.read || trace[0]?.id !== f.firstId) {
      f.key = key;
      f.read = 0;
      f.firstId = trace[0]?.id;
      f.rows = [];
    }
    for (; f.read < trace.length; f.read++) {
      const r = trace[f.read]!;
      if (kinds.has(kindOf(r)) && (process === "" || involves(r, process))) f.rows.push(f.read);
    }
    // The selected record is always listed, even if the filters would hide it (e.g. a
    // violation detected at a message send while messages are hidden).
    const rows = f.rows.slice();
    const selectedIndex =
      selectedRecord === null ? -1 : trace.findIndex((r) => r.id === selectedRecord);
    if (selectedIndex >= 0 && !f.rows.includes(selectedIndex)) {
      let at = 0;
      while (at < rows.length && rows[at]! < selectedIndex) at++;
      rows.splice(at, 0, selectedIndex);
    }
    return rows;
    // traceVersion drives re-reading the shared trace buffer.
  }, [key, kinds, process, traceVersion, selectedRecord]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  useEffect(() => {
    if (follow && rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, follow, virtualizer]);

  // Bring a newly selected record into view (and stop following the newest).
  useEffect(() => {
    if (selectedRecord === null) return;
    const at = rows.findIndex((i) => trace[i]?.id === selectedRecord);
    if (at < 0) return;
    setFollow(false);
    virtualizer.scrollToIndex(at, { align: "center" });
    // Deliberately keyed on the selection only, not on every new record.
  }, [selectedRecord]);

  const toggle = (k: Kind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="event-list">
      <div className="event-filters">
        {KINDS.map((k) => (
          <label key={k.id}>
            <input type="checkbox" checked={kinds.has(k.id)} onChange={() => toggle(k.id)} />
            {k.label}
          </label>
        ))}
        <label>
          Process
          <select value={process} onChange={(e) => setProcess(e.target.value)}>
            <option value="">All</option>
            {processes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow newest
        </label>
        <span className="muted">
          {rows.length.toLocaleString()} of {trace.length.toLocaleString()}
        </span>
      </div>
      <div
        ref={parentRef}
        className="event-scroll"
        onWheel={() => setFollow(false)}
        role="list"
        aria-label="Trace events"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const r = trace[rows[item.index]!]!;
            return (
              <div
                key={r.id}
                role="listitem"
                className={`event-row kind-${kindOf(r)}${r.id === selectedRecord ? " selected" : ""}`}
                style={{ transform: `translateY(${item.start}px)`, height: ROW_H }}
                onClick={() => useSim.setState({ selectedRecord: r.id })}
                onDoubleClick={() => sim.seek(r.t)}
                title="Click to select and see its causes; double-click to rewind the simulation here"
              >
                <code>{formatRecord(r)}</code>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
