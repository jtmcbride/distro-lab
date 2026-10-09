import type { Scenario } from "./scenario.ts";

/**
 * Delta debugging: simplifies the network, then drops chunks of actions (halving the chunk
 * size down to one) while `stillFails` holds. Returns a scenario that fails the same way and
 * from which no single fault can be removed. Repair actions in the liveness window are
 * always kept.
 */
export function minimizeScenario(
  scenario: Scenario,
  stillFails: (candidate: Scenario) => boolean,
): Scenario {
  let best = scenario;
  // Repairs at the start of the liveness window are part of the property being tested, not
  // faults: dropping them would turn any liveness failure into "a node is still down".
  const repairsFrom =
    scenario.livenessAfterMs === undefined
      ? Infinity
      : scenario.durationMs - scenario.livenessAfterMs;

  for (const simplification of [{ loss: 0 }, { duplicate: 0 }, { jitterMs: 0 }]) {
    const candidate: Scenario = {
      ...best,
      network: { ...best.network, defaults: { ...best.network.defaults, ...simplification } },
    };
    if (stillFails(candidate)) best = candidate;
  }

  // Large irrelevant groups go in a few runs instead of one run per action. Later chunks
  // first: they are the most likely to be irrelevant to an earlier failure.
  const faults = best.actions.filter((a) => a.atMs < repairsFrom).length;
  let size = Math.max(1, Math.floor(faults / 2));
  for (;;) {
    let changed = false;
    for (let end = best.actions.length; end > 0; end -= size) {
      const start = Math.max(0, end - size);
      if (best.actions.slice(start, end).some((a) => a.atMs >= repairsFrom)) continue;
      const candidate: Scenario = {
        ...best,
        actions: [...best.actions.slice(0, start), ...best.actions.slice(end)],
      };
      if (stillFails(candidate)) {
        best = candidate;
        changed = true;
      }
    }
    if (size > 1) size = Math.floor(size / 2);
    else if (!changed) break;
  }
  return best;
}
