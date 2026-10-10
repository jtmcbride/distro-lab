import { generateScenario, type GenerateOptions } from "./generate.ts";
import { minimizeFailure } from "./minimize.ts";
import {
  failed,
  runScenario,
  type ProtocolEntry,
  type RunResult,
  type Scenario,
} from "./scenario.ts";

/**
 * The scenario a fuzz run uses for `seed`: generated with the protocol's own workload and
 * random settings from the registry.
 */
export function scenarioForSeed(
  registry: ReadonlyMap<string, ProtocolEntry>,
  seed: number,
  options: GenerateOptions,
): Scenario {
  const entry = registry.get(options.protocol);
  if (entry === undefined) throw new Error(`unknown protocol "${options.protocol}"`);
  return generateScenario(seed, {
    ...options,
    workload: entry.workload,
    randomConfig: entry.randomConfig,
  });
}

export interface FuzzOptions extends GenerateOptions {
  readonly firstSeed?: number;
  readonly seeds: number;
  /** Stop after this many failing seeds (default 1). */
  readonly maxFailures?: number;
  readonly minimize?: boolean;
  readonly onProgress?: (done: number, failures: number) => void;
}

export interface FuzzFailure {
  readonly result: RunResult;
  /** Smallest scenario found that fails the same way (equals result.scenario if not minimized). */
  readonly minimized: Scenario;
}

export interface FuzzReport {
  readonly runs: number;
  readonly events: number;
  readonly failures: readonly FuzzFailure[];
}

export function fuzz(
  registry: ReadonlyMap<string, ProtocolEntry>,
  options: FuzzOptions,
): FuzzReport {
  const first = options.firstSeed ?? 0;
  const failures: FuzzFailure[] = [];
  let events = 0;
  let runs = 0;
  for (let seed = first; seed < first + options.seeds; seed++) {
    const result = runScenario(registry, scenarioForSeed(registry, seed, options));
    runs++;
    events += result.events;
    if (failed(result)) {
      const minimized =
        options.minimize === false
          ? result.scenario
          : (minimizeFailure(registry, result.scenario)?.minimized ?? result.scenario);
      failures.push({ result, minimized });
      if (failures.length >= (options.maxFailures ?? 1)) break;
    }
    options.onProgress?.(runs, failures.length);
  }
  return { runs, events, failures };
}
