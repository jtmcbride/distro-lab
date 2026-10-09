import { formatRecord } from "@distro-lab/core";
import { messageStyle } from "../protocolUi.ts";
import { useSim } from "../state/store.ts";
import { recordById } from "../state/trace.ts";
import { outcomesOf } from "../state/traceIndex.ts";
import { formatMs } from "./PlaybackBar.tsx";

/** Details of the selected trace record; for a message, its payload and fate. */
export function RecordDetail() {
  const { selectedRecord } = useSim();
  useSim((s) => s.traceVersion);
  if (selectedRecord === null) {
    return <p className="muted">Click a message (in the cluster or the diagram) or an event.</p>;
  }
  const r = recordById(selectedRecord);
  if (r === undefined) return <p className="muted">That record is not in the current trace.</p>;
  if (r.type !== "send") {
    return (
      <div className="record-detail">
        <p>
          <code>{formatRecord(r)}</code>
        </p>
      </div>
    );
  }
  const style = messageStyle(r.message);
  const outcomes = outcomesOf(r);
  return (
    <div className="record-detail">
      <p>
        <strong style={{ color: style.color }}>{style.label}</strong> {r.from} → {r.to}, sent at{" "}
        {formatMs(r.t)} (record #{r.id})
      </p>
      <ul className="outcomes">
        {r.arrivals.length === 0 && (
          <li className="bad">
            Dropped when sent ({outcomes[0]?.kind === "dropped" ? outcomes[0].reason : "lost"})
          </li>
        )}
        {r.arrivals.map((arrival, i) => {
          const o = outcomes[i];
          return (
            <li key={i}>
              {r.arrivals.length > 1 ? `Copy ${i + 1}: ` : ""}
              {o === undefined ? (
                <span className="muted">in flight, due at {formatMs(arrival)}</span>
              ) : o.kind === "delivered" ? (
                <span className="good">delivered at {formatMs(o.t)}</span>
              ) : (
                <span className="bad">
                  dropped at {formatMs(o.t)} ({o.reason})
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <pre className="payload">{JSON.stringify(r.message, null, 2)}</pre>
    </div>
  );
}
