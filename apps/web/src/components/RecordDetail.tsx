import { formatRecord, processOf } from "@distro-lab/core";
import { explain } from "../state/cone.ts";
import { messageStyle } from "../protocolUi.ts";
import { useSim } from "../state/store.ts";
import { recordById } from "../state/trace.ts";
import { causalChain } from "../state/causes.ts";
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
        <Why id={r.id} />
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
      <Why id={r.id} />
    </div>
  );
}

function ExplainButton({ id }: { id: number }) {
  const r = recordById(id);
  const p = r === undefined ? null : processOf(r);
  if (p === null) return null;
  return (
    <button
      type="button"
      onClick={() => explain(id, [p], `#${id}`)}
      title="Dim everything that could not have influenced this event"
    >
      Show causal past
    </button>
  );
}

/** The chain of events that led to a record, newest first; each step is selectable. */
function Why({ id }: { id: number }) {
  const chain = causalChain(id).slice(1);
  if (chain.length === 0) {
    return <p className="muted">Caused directly by the scenario (an action or start-up).</p>;
  }
  return (
    <div className="why">
      <h3>Why did this happen?</h3>
      <ExplainButton id={id} />
      <ol>
        {chain.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="link-button"
              onClick={() => useSim.setState({ selectedRecord: c.id })}
            >
              <code>{formatRecord(c)}</code>
            </button>
          </li>
        ))}
      </ol>
      {chain.at(-1)!.cause === null && (
        <p className="muted">
          ↑ root: {chain.at(-1)!.type === "init" ? "node start-up" : "scenario action"}
        </p>
      )}
    </div>
  );
}
