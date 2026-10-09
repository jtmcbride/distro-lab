import { useEffect, useState } from "react";
import { ClusterView } from "./components/ClusterView.tsx";
import { PlaybackBar } from "./components/PlaybackBar.tsx";
import { SCENARIO_CHOICES } from "./scenarios.ts";
import { sim } from "./sim/client.ts";
import { useSim } from "./state/store.ts";
import { trace } from "./state/trace.ts";

export function App() {
  const [choice, setChoice] = useState(SCENARIO_CHOICES[0]!.id);
  const { violations, error } = useSim();
  useSim((s) => s.traceVersion); // re-render as the trace grows

  useEffect(() => {
    const c = SCENARIO_CHOICES.find((x) => x.id === choice) ?? SCENARIO_CHOICES[0]!;
    sim.load(c.make());
  }, [choice]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Distributed Systems Lab</h1>
        <label>
          Scenario
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {SCENARIO_CHOICES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </header>
      <PlaybackBar />
      {error !== null && <p className="error">Simulation error: {error}</p>}
      <main className="workspace">
        <section className="panel cluster" aria-label="Cluster">
          <h2>Cluster</h2>
          <ClusterView />
        </section>
        <section className="panel inspector" aria-label="Inspector">
          <h2>Inspector</h2>
          <p className="muted">Select a node.</p>
        </section>
        <section className="panel timeline" aria-label="Timeline">
          <h2>Events</h2>
          <p className="muted">
            {trace.length.toLocaleString()} records · {violations.length} violations
          </p>
        </section>
      </main>
    </div>
  );
}
