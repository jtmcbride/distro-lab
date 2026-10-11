import { ClusterView } from "./components/ClusterView.tsx";
import { EventList } from "./components/EventList.tsx";
import { HistoryPanel } from "./components/HistoryPanel.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { RecordDetail } from "./components/RecordDetail.tsx";
import { SpaceTime } from "./components/SpaceTime.tsx";
import { Tools } from "./components/Tools.tsx";
import { PlaybackBar } from "./components/PlaybackBar.tsx";
import { BranchBar } from "./components/BranchBar.tsx";
import { ComparePanel } from "./components/ComparePanel.tsx";
import { Minimize } from "./components/Minimize.tsx";
import { Explain } from "./components/Explain.tsx";
import { ScenarioMenu } from "./components/ScenarioMenu.tsx";
import { TourCard, TourMenu } from "./components/Tour.tsx";
import { useTourFocus } from "./tutorials/control.ts";
import { Violations } from "./components/Violations.tsx";
import { useProtocolUi } from "./protocols/index.ts";
import { useSim } from "./state/store.ts";

export function App() {
  const { error } = useSim();
  const ui = useProtocolUi();
  const focus = {
    cluster: useTourFocus("cluster"),
    inspector: useTourFocus("inspector"),
    logs: useTourFocus("logs"),
    history: useTourFocus("history"),
    tools: useTourFocus("tools"),
    diagram: useTourFocus("diagram"),
    timeline: useTourFocus("timeline"),
  };
  return (
    <div className="app">
      <header className="topbar">
        <div className="title">
          <h1>Distributed Systems Lab</h1>
          <TourMenu />
        </div>
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
        <section className={`panel cluster${focus.cluster}`} aria-label="Cluster">
          <h2>Cluster</h2>
          <ClusterView />
        </section>
        <section className={`panel inspector${focus.inspector}`} aria-label="Inspector">
          <h2>Inspector</h2>
          <Inspector />
        </section>
        <section className={`panel logs${focus.logs}`} aria-label={ui.dataTitle}>
          <h2>{ui.dataTitle}</h2>
          <ui.DataPanel />
        </section>
        <section className={`panel history-panel${focus.history}`} aria-label="Client history">
          <h2>Client history</h2>
          <HistoryPanel />
        </section>
        <section className={`panel tools${focus.tools}`} aria-label="Fault and client tools">
          <h2>Tools</h2>
          <Tools />
        </section>
        <section className={`panel diagram${focus.diagram}`} aria-label="Message timeline">
          <h2>Message timeline</h2>
          <div className="diagram-body">
            <SpaceTime />
            <aside className="diagram-detail" aria-label="Selected message">
              <RecordDetail />
            </aside>
          </div>
        </section>
        <section className={`panel timeline${focus.timeline}`} aria-label="Timeline">
          <h2>Events</h2>
          <EventList />
        </section>
      </main>
      <TourCard />
    </div>
  );
}
