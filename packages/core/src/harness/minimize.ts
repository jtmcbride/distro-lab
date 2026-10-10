import { failureKind, runScenario, type ProtocolEntry, type Scenario } from "./scenario.ts";

/**
 * Delta debugging: simplifies the network, then drops chunks of actions (halving the chunk
 * size down to one) while `stillFails` holds. Returns a scenario that fails the same way and
 * from which no single fault can be removed. Repair actions in the liveness window and client
 * operations are always kept: client-visible checks (such as cas chains) depend on the whole
 * workload, so removing operations would manufacture failures instead of isolating them.
 */
export function minimizeScenario(
  scenario: Scenario,
  stillFails: (candidate: Scenario) => boolean,
  /** Called after every candidate run with the smallest failing scenario so far. */
  onProgress?: (best: Scenario, runs: number) => void,
): Scenario {
  let best = scenario;
  let runs = 0;
  const test = (candidate: Scenario) => {
    const fails = stillFails(candidate);
    runs++;
    if (fails) best = candidate;
    onProgress?.(best, runs);
    return fails;
  };
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
    test(candidate);
  }

  const keep = (a: Scenario["actions"][number]) =>
    a.atMs >= repairsFrom || a.action.type === "client";
  // Chunks are taken from the removable faults only (client operations are interleaved with
  // them), largest first, so big irrelevant groups go in a few runs. Later chunks first: they
  // are the most likely to be irrelevant to an earlier failure.
  let size = Math.max(1, Math.floor(best.actions.filter((a) => !keep(a)).length / 2));
  for (;;) {
    let changed = false;
    const faults = best.actions.filter((a) => !keep(a));
    for (let end = faults.length; end > 0; end -= size) {
      const drop = new Set(faults.slice(Math.max(0, end - size), end));
      const candidate: Scenario = { ...best, actions: best.actions.filter((a) => !drop.has(a)) };
      if (test(candidate)) changed = true;
    }
    if (size > 1) size = Math.floor(size / 2);
    else if (!changed) break;
  }
  return best;
}

/**
 * Minimizes a failing scenario so that it still fails the same way (same first violated
 * invariant, or a liveness failure). Returns null if the scenario does not fail. This is
 * what `sim fuzz` does with each failure.
 */
export function minimizeFailure(
  registry: ReadonlyMap<string, ProtocolEntry>,
  scenario: Scenario,
  onProgress?: (best: Scenario, runs: number) => void,
): { kind: string; minimized: Scenario } | null {
  const kind = failureKind(runScenario(registry, scenario));
  if (kind === null) return null;
  const minimized = minimizeScenario(
    scenario,
    (s) => failureKind(runScenario(registry, s)) === kind,
    onProgress,
  );
  return { kind, minimized };
}
