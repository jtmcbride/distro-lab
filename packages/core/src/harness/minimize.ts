import type { Scenario } from "./scenario.ts";

/**
 * Greedy delta debugging: repeatedly drops individual actions and simplifies the network
 * while `stillFails` holds. Returns a scenario that fails the same way and from which no
 * single action can be removed. Costs O(actions²) runs in the worst case.
 */
export function minimizeScenario(
  scenario: Scenario,
  stillFails: (candidate: Scenario) => boolean,
): Scenario {
  let best = scenario;

  const defaults = best.network.defaults ?? {};
  for (const simplification of [{ loss: 0 }, { duplicate: 0 }, { jitterMs: 0 }]) {
    const candidate: Scenario = {
      ...best,
      network: {
        ...best.network,
        defaults: { ...defaults, ...best.network.defaults, ...simplification },
      },
    };
    if (stillFails(candidate)) best = candidate;
  }

  for (let changed = true; changed;) {
    changed = false;
    // Later actions first: they are the most likely to be irrelevant to an earlier failure.
    for (let i = best.actions.length - 1; i >= 0; i--) {
      const candidate: Scenario = { ...best, actions: best.actions.filter((_, j) => j !== i) };
      if (stillFails(candidate)) {
        best = candidate;
        changed = true;
      }
    }
  }

  return best;
}
