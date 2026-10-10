import { canonicalJson, type ScenarioAction } from "@distro-lab/core";
import { useSim } from "../state/store.ts";
import { sim } from "./client.ts";
import type { FromMinimizer } from "./minimizeWorker.ts";

let worker: Worker | null = null;

/** Multiset difference: actions of `all` not in `kept`. */
export function removedActions(
  all: readonly ScenarioAction[],
  kept: readonly ScenarioAction[],
): ScenarioAction[] {
  const counts = new Map<string, number>();
  for (const a of kept) counts.set(canonicalJson(a), (counts.get(canonicalJson(a)) ?? 0) + 1);
  return all.filter((a) => {
    const k = canonicalJson(a);
    const n = counts.get(k) ?? 0;
    if (n > 0) counts.set(k, n - 1);
    return n === 0;
  });
}

/**
 * Shrinks the current branch's failing scenario in a background worker, then opens the
 * result as a new branch.
 */
export async function startMinimize(): Promise<void> {
  cancelMinimize();
  const scenario = await sim.exportScenario();
  useSim.setState({
    minimizing: { runs: 0, actions: scenario.actions.length, total: scenario.actions.length },
    minimized: null,
  });
  const w = new Worker(new URL("./minimizeWorker.ts", import.meta.url), { type: "module" });
  worker = w;
  w.onmessage = (event: MessageEvent<FromMinimizer>) => {
    const m = event.data;
    if (m.type === "progress") {
      useSim.setState({
        minimizing: { runs: m.runs, actions: m.actions, total: scenario.actions.length },
      });
      return;
    }
    w.terminate();
    worker = null;
    useSim.setState({ minimizing: null });
    if (m.type === "done") {
      const kept = m.minimized.actions.length;
      sim.addBranch(`minimized (${kept} of ${scenario.actions.length} actions)`, m.minimized);
      sim.jumpToFirstViolation();
      useSim.setState({
        minimized: {
          kind: m.kind,
          total: scenario.actions.length,
          repairsFrom:
            scenario.livenessAfterMs === undefined
              ? Infinity
              : scenario.durationMs - scenario.livenessAfterMs,
          kept: m.minimized.actions,
          removed: removedActions(scenario.actions, m.minimized.actions),
        },
      });
    } else {
      useSim.setState({
        minimized: {
          problem:
            m.type === "noFailure"
              ? "This scenario does not fail when replayed from the start, so there is nothing to minimize."
              : `Minimizing failed: ${m.message}`,
        },
      });
    }
  };
  w.postMessage(scenario);
}

export function cancelMinimize(): void {
  worker?.terminate();
  worker = null;
  useSim.setState({ minimizing: null });
}
