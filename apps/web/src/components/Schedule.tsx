import { useState } from "react";
import type { ScenarioAction } from "@distro-lab/core";
import { describeAction } from "../actions.ts";
import { sim } from "../sim/client.ts";
import { useSim } from "../state/store.ts";
import { formatMs } from "./PlaybackBar.tsx";

type AddKind = "crash" | "recover" | "isolate" | "heal" | "restore";

function make(kind: AddKind, node: string, atMs: number): ScenarioAction {
  switch (kind) {
    case "crash":
    case "recover":
      return { atMs, action: { type: kind, node } };
    case "isolate":
      return { atMs, action: { type: "network", change: { type: "isolate", node } } };
    case "heal":
    case "restore":
      return { atMs, action: { type: "network", change: { type: kind } } };
  }
}

/**
 * The current branch's scheduled actions. Ones that have not happened yet can be removed,
 * moved or added: "what if this crash never happened?"
 */
export function Schedule() {
  const { actions, now, processes } = useSim();
  const servers = processes.filter((p) => p.role === "server").map((p) => p.id);
  const [kind, setKind] = useState<AddKind>("crash");
  const [node, setNode] = useState("");
  const [at, setAt] = useState<number | null>(null);
  const addAt = at ?? Math.ceil(now + 100);
  const rows = actions
    .map((a, index) => ({ a, index }))
    .sort((x, y) => x.a.atMs - y.a.atMs || x.index - y.index);
  const without = (index: number) => actions.filter((_, i) => i !== index);

  return (
    <div className="tool schedule">
      <p className="muted small">
        Changes apply to this branch from now on. Fork first to keep the current timeline for
        comparison.{" "}
        <button type="button" onClick={() => sim.fork()}>
          ⑂ Fork here
        </button>
      </p>
      <div className="row">
        <label className="field">
          Add
          <select value={kind} onChange={(e) => setKind(e.target.value as AddKind)}>
            <option value="crash">crash</option>
            <option value="recover">recover</option>
            <option value="isolate">isolate</option>
            <option value="heal">heal partitions</option>
            <option value="restore">restore network</option>
          </select>
        </label>
        {(kind === "crash" || kind === "recover" || kind === "isolate") && (
          <label className="field">
            Node
            <select value={node || servers[0]} onChange={(e) => setNode(e.target.value)}>
              {servers.map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          At (ms)
          <input
            type="number"
            value={addAt}
            min={Math.ceil(now)}
            onChange={(e) => setAt(Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          disabled={!(addAt > now)}
          onClick={() => {
            sim.editActions([...actions, make(kind, node || servers[0]!, addAt)]);
            setAt(null);
          }}
        >
          Schedule
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No scheduled actions.</p>
      ) : (
        <ol className="schedule-list">
          {rows.map(({ a, index }) => {
            const done = a.atMs <= now;
            return (
              <li key={index} className={done ? "done" : "pending"}>
                <span className="schedule-time">{formatMs(a.atMs)}</span>
                <span className="schedule-what">{describeAction(a)}</span>
                {done ? (
                  <span className="muted small">done</span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Remove ${describeAction(a)} at ${formatMs(a.atMs)}`}
                    onClick={() => sim.editActions(without(index))}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
