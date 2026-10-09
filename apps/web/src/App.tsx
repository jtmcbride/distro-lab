import { useMemo, useState } from "react";
import {
  formatRecord,
  defaultRegistry,
  runScenario,
  scenarioForSeed,
  type RunResult,
} from "@distro-lab/core";

const registry = defaultRegistry();

/**
 * Placeholder page: proves the simulation core runs in the browser and that the Pages
 * deployment works. The real UI arrives in phase 3.
 */
export function App() {
  const [seed, setSeed] = useState(1);
  const [protocol, setProtocol] = useState("raft");
  const result = useMemo<RunResult>(
    () =>
      runScenario(registry, scenarioForSeed(registry, seed, { protocol }), {
        keepTrace: true,
        keepState: true,
      }),
    [seed, protocol],
  );
  const firstBad = result.violations[0]?.recordId;
  const elections = (result.trace ?? []).filter(
    (r) => r.type === "annotate" && r.label === "becameLeader",
  );
  const shown = (result.trace ?? []).filter(
    (r) =>
      r.type !== "send" && r.type !== "deliver" && (firstBad === undefined || r.id <= firstBad),
  );

  return (
    <main>
      <h1>Distributed Systems Lab</h1>
      <p className="lede">
        A deterministic simulator for building, breaking and debugging distributed protocols. This
        page is a placeholder: it runs one randomly generated fault scenario, with client traffic,
        against a Raft-replicated key-value store, entirely in your browser.
      </p>

      <section className="controls">
        <label>
          Protocol
          <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
            {[...registry.values()].map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Seed
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number.parseInt(e.target.value, 10) || 0)}
          />
        </label>
        <button type="button" onClick={() => setSeed((s) => s + 1)}>
          Next seed
        </button>
      </section>

      <section className="summary">
        <div>
          <strong>{result.scenario.nodes.length}</strong> nodes
        </div>
        <div>
          <strong>{result.scenario.actions.length}</strong> scheduled faults
        </div>
        <div>
          <strong>{result.events}</strong> events
        </div>
        <div>
          <strong>{elections.length}</strong> elections won
        </div>
        <div className={result.violations.length + result.liveness.length > 0 ? "bad" : "good"}>
          {result.violations.length > 0
            ? `${result.violations[0]!.invariant} violated`
            : result.liveness.length > 0
              ? "liveness failure"
              : "all invariants hold"}
        </div>
      </section>

      {result.violations.length > 0 && (
        <ul className="violations">
          {result.violations.slice(0, 5).map((v) => (
            <li key={`${v.invariant}-${v.recordId}`}>
              {v.t}ms · {v.invariant}: {v.message}
            </li>
          ))}
        </ul>
      )}

      <h2>Final state</h2>
      <pre className="trace">
        {(result.finalState ?? [])
          .map((p) => {
            const format = registry.get(protocol)?.formatView;
            const view =
              p.role === "server" && format !== undefined ? format(p.view) : JSON.stringify(p.view);
            return `${p.id.padEnd(4)} ${p.up ? "up  " : "DOWN"} ${view}`;
          })
          .join("\n")}
      </pre>

      <h2>Trace (sends and deliveries hidden)</h2>
      <pre className="trace">
        {shown
          .slice(-400)
          .map((r) => formatRecord(r))
          .join("\n")}
      </pre>
      <p className="hash">trace hash {result.traceHash}</p>
    </main>
  );
}
