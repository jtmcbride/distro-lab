import type {
  Action,
  CanonicalValue,
  Comparison,
  Scenario,
  ScenarioAction,
} from "@distro-lab/core";
import { applyFrame, useSim } from "../state/store.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const exports = new Map<number, (s: Scenario) => void>();
const comparisons = new Map<number, (c: Comparison) => void>();
let nextRequest = 0;
// Scrubbing sends at most one seek per frame: later positions wait for the previous one.
let scrubBusy = false;
let scrubNext: number | null = null;

worker.onmessage = (event: MessageEvent<FromWorker>) => {
  const m = event.data;
  switch (m.type) {
    case "frame": {
      applyFrame(m.frame);
      if (scrubBusy) {
        scrubBusy = scrubNext !== null;
        if (scrubNext !== null) send({ type: "seek", timeMs: scrubNext });
        scrubNext = null;
      }
      if (m.cause === "seekFirstViolation") {
        const first = useSim.getState().violations[0];
        if (first !== undefined) {
          useSim.setState({
            selectedRecord: first.recordId,
            selectedProcess: first.nodes[0] ?? null,
          });
        }
      }
      break;
    }
    case "scenario":
      exports.get(m.requestId)?.(m.scenario);
      exports.delete(m.requestId);
      break;
    case "comparison":
      comparisons.get(m.requestId)?.(m.comparison);
      comparisons.delete(m.requestId);
      break;
    case "error":
      useSim.setState({ error: m.message });
      break;
  }
};

const send = (message: ToWorker) => worker.postMessage(message);

/** Commands for the simulation running in the worker. */
export const sim = {
  /**
   * Loads a scenario. With `jumpToViolation`, it is run to its end and, if a safety
   * violation occurs, rewound to the first one (how fuzz failure files are opened).
   */
  load(scenario: Scenario, name = "Scenario", options: { jumpToViolation?: boolean } = {}) {
    useSim.setState({
      scenarioName: name,
      protocol: scenario.protocol,
      config: scenario.config,
      // Until the worker's first frame, there is nothing of the new scenario to show (and the
      // old processes' views belong to the old protocol).
      processes: [],
      durationMs: scenario.durationMs,
      selectedProcess: null,
      selectedRecord: null,
    });
    send({ type: "load", scenario });
    if (options.jumpToViolation === true) sim.jumpToFirstViolation();
  },
  /** Runs to the end of the scenario and back to its first violation, selecting it. */
  jumpToFirstViolation: () => send({ type: "seekFirstViolation" }),
  play: () => send({ type: "play" }),
  pause: () => send({ type: "pause" }),
  setSpeed: (speed: number) => send({ type: "speed", speed }),
  step: () => send({ type: "step" }),
  stepNotable: () => send({ type: "stepNotable" }),
  stepBack: () => send({ type: "stepBack" }),
  stepBackNotable: () => send({ type: "stepBackNotable" }),
  seek: (timeMs: number) => send({ type: "seek", timeMs }),
  /** Jumps to just after the event that emitted record `id`. */
  seekRecord: (id: number) => send({ type: "seekRecord", id }),
  /** Seeks while dragging the scrubber, dropping positions the worker cannot keep up with. */
  scrub(timeMs: number) {
    if (scrubBusy) {
      scrubNext = timeMs;
      return;
    }
    scrubBusy = true;
    send({ type: "seek", timeMs });
  },
  act: (action: Action<CanonicalValue, CanonicalValue>) => send({ type: "act", action }),
  /** Starts a branch at the current moment and switches to it. */
  fork: (name?: string) => send(name === undefined ? { type: "fork" } : { type: "fork", name }),
  switchBranch: (id: number) => send({ type: "switchBranch", id }),
  deleteBranch: (id: number) => send({ type: "deleteBranch", id }),
  renameBranch: (id: number, name: string) => send({ type: "renameBranch", id, name }),
  /** Adds a variant of the scenario (e.g. a minimized one) as a branch and switches to it. */
  addBranch: (name: string, scenario: Scenario) => send({ type: "addBranch", name, scenario }),
  /** Replaces the current branch's actions (only ones that have not run may change). */
  editActions: (actions: readonly ScenarioAction[]) => send({ type: "editActions", actions }),
  /** The current branch next to `other` at the current time. */
  compare(other: number): Promise<Comparison> {
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      comparisons.set(requestId, resolve);
      send({ type: "compare", requestId, other });
    });
  },
  /** The current scenario including live actions. */
  exportScenario(): Promise<Scenario> {
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      exports.set(requestId, resolve);
      send({ type: "export", requestId });
    });
  },
};
