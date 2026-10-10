import { useState } from "react";
import { describeAction, isFault } from "../actions.ts";
import { cancelMinimize } from "../sim/minimize.ts";
import { useSim } from "../state/store.ts";
import { formatMs } from "./PlaybackBar.tsx";

/** Progress of a minimization, then what it kept and removed. */
export function Minimize() {
  const { minimizing, minimized } = useSim();
  const [showRemoved, setShowRemoved] = useState(false);
  if (minimizing !== null) {
    return (
      <div className="minimize" role="status">
        <strong>Minimizing…</strong>
        <span>
          {minimizing.runs} runs · {minimizing.total} → {minimizing.actions} actions
        </span>
        <button type="button" onClick={cancelMinimize}>
          Cancel
        </button>
      </div>
    );
  }
  if (minimized === null) return null;
  const dismiss = () => useSim.setState({ minimized: null });
  if ("problem" in minimized) {
    return (
      <div className="minimize" role="status">
        <span>{minimized.problem}</span>
        <button type="button" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    );
  }
  const faults = minimized.kept.filter((a) => isFault(a) && a.atMs < minimized.repairsFrom);
  return (
    <div className="minimize" role="status">
      <strong>
        Minimized: {minimized.kept.length} of {minimized.total} actions still fail with{" "}
        <code>{minimized.kind.replace(/^safety:/, "")}</code>
      </strong>
      <span className="muted small">
        Opened as a new branch. Only faults are removed; client operations are kept.
      </span>
      <button type="button" onClick={dismiss}>
        Dismiss
      </button>
      <div className="minimize-lists">
        <div>
          Faults that matter ({faults.length}):
          {faults.length === 0 && (
            <p className="muted small">
              None: client traffic and ordinary message timing are enough.
            </p>
          )}
          <ul>
            {faults.map((a, i) => (
              <li key={i}>
                {formatMs(a.atMs)} · <code>{describeAction(a)}</code>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <button type="button" className="link-button" onClick={() => setShowRemoved((s) => !s)}>
            {showRemoved ? "Hide" : "Show"} {minimized.removed.length} removed actions
          </button>
          {showRemoved && (
            <ul>
              {minimized.removed.map((a, i) => (
                <li key={i}>
                  {formatMs(a.atMs)} · <code>{describeAction(a)}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
