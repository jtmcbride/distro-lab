import { SCENARIO_CHOICES } from "../scenarios.ts";
import { sim } from "../sim/client.ts";
import { useSim } from "../state/store.ts";
import { TOURS, type Tour, type TourPanel } from "./tours.ts";

/** Panel class names in App, by the names tours use. */
const PANEL_CLASS: Record<TourPanel, string> = {
  cluster: "cluster",
  inspector: "inspector",
  logs: "logs",
  tools: "tools",
  diagram: "diagram",
  history: "history-panel",
  timeline: "timeline",
};

export const tourById = (id: string): Tour | undefined => TOURS.find((t) => t.id === id);

/** Loads the tour's example and opens its first step. */
export function startTour(id: string): boolean {
  const tour = tourById(id);
  const choice = SCENARIO_CHOICES.find((c) => c.id === tour?.scenario);
  if (tour === undefined || choice === undefined) return false;
  sim.load(choice.make(), choice.label);
  useSim.setState({ tour: { id, step: 0, scenarioName: choice.label } });
  goToStep(0);
  return true;
}

/** Moves the simulation to step `i`'s moment and shows its panel and process. */
export function goToStep(i: number): void {
  const t = useSim.getState().tour;
  const step = t === null ? undefined : tourById(t.id)?.steps[i];
  if (t === null || step === undefined) return;
  sim.pause();
  sim.seek(step.atMs);
  useSim.setState({
    tour: { ...t, step: i },
    ...(step.select === undefined ? {} : { selectedProcess: step.select }),
  });
  if (step.panel !== undefined) {
    document
      .querySelector(`.panel.${PANEL_CLASS[step.panel]}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

export function endTour(): void {
  useSim.setState({ tour: null });
}

/** Class for a panel the current tour step points at. */
export function useTourFocus(panel: TourPanel): string {
  return useSim((s) => {
    if (s.tour === null) return "";
    return tourById(s.tour.id)?.steps[s.tour.step]?.panel === panel ? " tour-focus" : "";
  });
}
