import { ClusterView } from "./components/ClusterView.tsx";
import { EventList } from "./components/EventList.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { LogGrid } from "./components/LogGrid.tsx";
import { RecordDetail } from "./components/RecordDetail.tsx";
import { SpaceTime } from "./components/SpaceTime.tsx";
import { Tools } from "./components/Tools.tsx";
import { PlaybackBar } from "./components/PlaybackBar.tsx";
import { BranchBar } from "./components/BranchBar.tsx";
import { ComparePanel } from "./components/ComparePanel.tsx";
import { Minimize } from "./components/Minimize.tsx";
import { Explain } from "./components/Explain.tsx";
import { ScenarioMenu } from "./components/ScenarioMenu.tsx";
import { Violations } from "./components/Violations.tsx";
import { useSim } from "./state/store.ts";

export function App() {
  const { error } = useSim();
  return (
    <div className="app">
      <header className="topbar">
        <h1>Distributed Systems Lab</h1>
        <ScenarioMenu />
      </header>
      <PlaybackBar />
      <BranchBar />
      <ComparePanel />
      <Violations />
      <Minimize />
      <Explain />
      {error !== null && <p className="error">Simulation error: {error}</p>}
      <main className="workspace">
        <section className="panel cluster" aria-label="Cluster">
          <h2>Cluster</h2>
          <ClusterView />
        </section>
        <section className="panel inspector" aria-label="Inspector">
          <h2>Inspector</h2>
          <Inspector />
        </section>
        <section className="panel logs" aria-label="Replicated logs">
          <h2>Replicated logs</h2>
          <LogGrid />
        </section>
        <section className="panel tools" aria-label="Fault and client tools">
          <h2>Tools</h2>
          <Tools />
        </section>
        <section className="panel diagram" aria-label="Message timeline">
          <h2>Message timeline</h2>
          <div className="diagram-body">
            <SpaceTime />
            <aside className="diagram-detail" aria-label="Selected message">
              <RecordDetail />
            </aside>
          </div>
        </section>
        <section className="panel timeline" aria-label="Timeline">
          <h2>Events</h2>
          <EventList />
        </section>
      </main>
    </div>
  );
}
