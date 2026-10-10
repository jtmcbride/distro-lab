import { useState } from "react";
import type { Violation } from "@distro-lab/core";
import { sim } from "../sim/client.ts";
import { startMinimize } from "../sim/minimize.ts";
import { explain } from "../state/cone.ts";
import { useSim } from "../state/store.ts";
import { formatMs } from "./PlaybackBar.tsx";

/** Rewinds to a violation and selects the event where it was detected. */
export function jumpTo(v: Violation): void {
  useSim.setState({ pendingSelection: { record: v.recordId, process: v.nodes[0] ?? null } });
  sim.seekRecord(v.recordId);
}

function explainViolation(v: Violation): void {
  jumpTo(v);
  explain(v.recordId, v.nodes, `the ${v.invariant} violation`);
}

/** Banner listing safety violations found so far, with jump-to. */
export function Violations() {
  const violations = useSim((s) => s.violations);
  const minimizing = useSim((s) => s.minimizing !== null);
  const [open, setOpen] = useState(false);
  if (violations.length === 0) return null;
  const first = violations[0]!;
  return (
    <div className="violations" role="alert">
      <strong>
        ⚠ {violations.length} safety violation{violations.length === 1 ? "" : "s"}
      </strong>
      <span>
        First: <code>{first.invariant}</code> at {formatMs(first.t)}: {first.message}
      </span>
      <button type="button" onClick={() => jumpTo(first)}>
        Jump to first
      </button>
      <button
        type="button"
        onClick={() => explainViolation(first)}
        title="Show every event that could have led to it"
      >
        Explain
      </button>
      <button
        type="button"
        disabled={minimizing}
        onClick={() => void startMinimize()}
        title="Find the fewest faults that still cause this violation (runs in the background)"
      >
        Minimize
      </button>
      {violations.length > 1 && (
        <button type="button" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide all" : "Show all"}
        </button>
      )}
      {open && (
        <ul>
          {violations.map((v) => (
            <li key={`${v.invariant}-${v.recordId}-${v.message}`}>
              <button type="button" className="link-button" onClick={() => jumpTo(v)}>
                {formatMs(v.t)} · <code>{v.invariant}</code>: {v.message}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
