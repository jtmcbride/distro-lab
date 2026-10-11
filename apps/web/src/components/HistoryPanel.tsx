import { useMemo, useState } from "react";
import { relativeTo, type HistoryOp } from "@distro-lab/core";
import { useProtocolUi } from "../protocols/index.ts";
import { sim } from "../sim/client.ts";
import { currentHistory, keyOf } from "../state/history.ts";
import { useSim } from "../state/store.ts";
import { formatMs } from "./PlaybackBar.tsx";

const ALL = "\u0000all";

/** Rewinds to an operation's completion (or invocation, if pending) and selects it. */
function jumpToOp(op: HistoryOp): void {
  const record = op.completeRecord ?? op.invokeRecord;
  useSim.setState({ pendingSelection: { record, process: op.client } });
  sim.seekRecord(record);
}

/**
 * The client-visible history: one lane per client, each operation a bar from its invocation
 * to its completion. With a linearizability violation, the failing key is shown by default,
 * the failing operation is marked, and every other operation on that key is marked by its
 * real-time order relative to it (completed before it started, or overlapping it).
 */
export function HistoryPanel() {
  const ui = useProtocolUi();
  const traceVersion = useSim((s) => s.traceVersion);
  const now = useSim((s) => s.now);
  const violations = useSim((s) => s.violations);
  const processes = useSim((s) => s.processes);
  const selectedRecord = useSim((s) => s.selectedRecord);
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  // The trace lives outside React; traceVersion says when it changed.
  const ops = useMemo(() => currentHistory(), [traceVersion]);

  const violation = violations.find((v) => v.invariant === "linearizable");
  const failing =
    violation === undefined
      ? undefined
      : ops.find((op) => op.completeRecord === violation.recordId);
  const keys = [...new Set(ops.map(keyOf))].sort();
  const key =
    chosenKey !== null && (chosenKey === ALL || keys.includes(chosenKey))
      ? chosenKey
      : failing !== undefined
        ? keyOf(failing)
        : ALL;
  const shown = key === ALL ? ops : ops.filter((op) => keyOf(op) === key);

  if (ops.length === 0) {
    return <p className="muted">No client operations yet. Send one from the client tools.</p>;
  }

  const clients = [
    ...new Set([
      ...processes.filter((p) => p.role === "client").map((p) => p.id),
      ...ops.map((op) => op.client),
    ]),
  ];
  const start = Math.min(...shown.map((op) => op.invokedAt), now);
  const end = Math.max(start + 1, now, ...shown.map((op) => op.completedAt ?? now));
  const pct = (t: number) => `${((t - start) / (end - start)) * 100}%`;
  const selected = ops.find(
    (op) => op.invokeRecord === selectedRecord || op.completeRecord === selectedRecord,
  );

  const relation = (op: HistoryOp): string => {
    if (failing === undefined || keyOf(op) !== keyOf(failing)) return "";
    if (op === failing) return " failing";
    return relativeTo(op, failing) === "before" ? " before" : " overlapping";
  };
  const label = (op: HistoryOp) => {
    const result = op.output === null ? "pending" : ui.describeResult(op.output).text;
    return `${ui.describeOp(op.input)} → ${result}`;
  };

  return (
    <div className="history">
      <div className="history-controls">
        <label>
          Key{" "}
          <select
            value={key}
            onChange={(e) => setChosenKey(e.target.value)}
            aria-label="Key to show"
          >
            <option value={ALL}>All keys</option>
            {keys.map((k) => (
              <option key={k} value={k}>
                {k === "" ? "(no key)" : k}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {shown.length} operation{shown.length === 1 ? "" : "s"}
        </span>
        {failing !== undefined && key === keyOf(failing) && (
          <span className="history-legend">
            <span className="swatch failing" /> failed the check
            <span className="swatch before" /> completed before it started
            <span className="swatch overlapping" /> overlapped it
          </span>
        )}
      </div>
      <div className="history-lanes">
        {clients.map((c) => (
          <div className="history-lane" key={c}>
            <span className="history-client">{c}</span>
            <div className="history-track">
              {now >= start && now <= end && (
                <span className="history-now" style={{ left: pct(now) }} aria-hidden />
              )}
              {shown
                .filter((op) => op.client === c)
                .map((op, i, mine) => {
                  const failed = op.output !== null && !ui.describeResult(op.output).ok;
                  const stop = op.completedAt ?? now;
                  // The label may use the free space up to the client's next operation.
                  const slotEnd = mine[i + 1]?.invokedAt ?? end;
                  const share =
                    slotEnd > op.invokedAt ? (stop - op.invokedAt) / (slotEnd - op.invokedAt) : 1;
                  return (
                    <button
                      type="button"
                      key={op.id}
                      className={`history-op${op.output === null ? " pending" : ""}${failed ? " not-ok" : ""}${relation(op)}${op === selected ? " selected" : ""}`}
                      style={{
                        left: pct(op.invokedAt),
                        width: `calc(${pct(slotEnd)} - ${pct(op.invokedAt)})`,
                      }}
                      title={`${op.id}: ${label(op)}`}
                      onClick={() =>
                        useSim.setState({
                          selectedRecord: op.completeRecord ?? op.invokeRecord,
                          selectedProcess: op.client,
                        })
                      }
                    >
                      <span className="bar" style={{ width: `${Math.min(1, share) * 100}%` }} />
                      <span className="text">{label(op)}</span>
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
        <div className="history-axis muted">
          <span>{formatMs(start)}</span>
          <span>{formatMs(end)}</span>
        </div>
      </div>
      {selected !== undefined && (
        <p className="history-detail">
          <code>{selected.id}</code> {label(selected)} · invoked {formatMs(selected.invokedAt)}
          {selected.completedAt !== null && `, completed ${formatMs(selected.completedAt)}`}
          {selected === failing && violation !== undefined && (
            <span className="bad"> · {violation.message}</span>
          )}{" "}
          <button type="button" className="link-button" onClick={() => jumpToOp(selected)}>
            Jump to {selected.completedAt === null ? "invocation" : "completion"}
          </button>
        </p>
      )}
    </div>
  );
}
