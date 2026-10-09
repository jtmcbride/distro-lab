import type { Action, CanonicalValue, Scenario } from "@distro-lab/core";
import { applyFrame, useSim } from "../state/store.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const exports = new Map<number, (s: Scenario) => void>();
let nextRequest = 0;

worker.onmessage = (event: MessageEvent<FromWorker>) => {
  const m = event.data;
  switch (m.type) {
    case "frame":
      applyFrame(m.frame);
      break;
    case "scenario":
      exports.get(m.requestId)?.(m.scenario);
      exports.delete(m.requestId);
      break;
    case "error":
      useSim.setState({ error: m.message });
      break;
  }
};

const send = (message: ToWorker) => worker.postMessage(message);

/** Commands for the simulation running in the worker. */
export const sim = {
  load(scenario: Scenario) {
    useSim.setState({
      protocol: scenario.protocol,
      config: scenario.config,
      durationMs: scenario.durationMs,
      selectedProcess: null,
      selectedRecord: null,
    });
    send({ type: "load", scenario });
  },
  play: () => send({ type: "play" }),
  pause: () => send({ type: "pause" }),
  setSpeed: (speed: number) => send({ type: "speed", speed }),
  step: () => send({ type: "step" }),
  stepNotable: () => send({ type: "stepNotable" }),
  seek: (timeMs: number) => send({ type: "seek", timeMs }),
  act: (action: Action<CanonicalValue, CanonicalValue>) => send({ type: "act", action }),
  /** The current scenario including live actions. */
  exportScenario(): Promise<Scenario> {
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      exports.set(requestId, resolve);
      send({ type: "export", requestId });
    });
  },
};
