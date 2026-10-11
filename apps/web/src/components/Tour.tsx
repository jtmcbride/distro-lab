import { useEffect } from "react";
import { useSim } from "../state/store.ts";
import { endTour, goToStep, startTour, tourById } from "../tutorials/control.ts";
import { TOURS } from "../tutorials/tours.ts";
import { formatMs } from "./PlaybackBar.tsx";

/** Menu of guided tours, in the top bar. */
export function TourMenu() {
  return (
    <details className="popover tour-menu">
      <summary>Tutorials</summary>
      <div className="popover-body">
        {TOURS.map((t) => (
          <button
            type="button"
            key={t.id}
            className="tour-choice"
            onClick={(e) => {
              startTour(t.id);
              (e.currentTarget.closest("details") as HTMLDetailsElement).open = false;
            }}
          >
            <strong>{t.title}</strong>
            <span className="muted">{t.summary}</span>
          </button>
        ))}
      </div>
    </details>
  );
}

/** The current tour step: what to look at, with back and next. */
export function TourCard() {
  const tour = useSim((s) => s.tour);
  const scenarioName = useSim((s) => s.scenarioName);
  // Loading another scenario ends the tour: its steps describe this one.
  useEffect(() => {
    if (tour !== null && scenarioName !== tour.scenarioName) endTour();
  }, [tour, scenarioName]);
  if (tour === null) return null;
  const t = tourById(tour.id);
  const step = t?.steps[tour.step];
  if (t === undefined || step === undefined) return null;
  const last = tour.step === t.steps.length - 1;
  return (
    <aside className="tour-card" aria-label="Tutorial" aria-live="polite">
      <header>
        <span className="muted small">
          {t.title} · {tour.step + 1} of {t.steps.length} · at {formatMs(step.atMs)}
        </span>
        <button type="button" className="link-button" onClick={endTour} aria-label="Close tutorial">
          ✕
        </button>
      </header>
      <h3>{step.title}</h3>
      {step.body.map((p) => (
        <p key={p}>{p}</p>
      ))}
      <footer>
        <button type="button" disabled={tour.step === 0} onClick={() => goToStep(tour.step - 1)}>
          Back
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => (last ? endTour() : goToStep(tour.step + 1))}
        >
          {last ? "Finish" : "Next"}
        </button>
      </footer>
    </aside>
  );
}
