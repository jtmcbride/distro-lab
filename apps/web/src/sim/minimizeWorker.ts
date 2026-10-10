import { defaultRegistry, minimizeFailure, type Scenario } from "@distro-lab/core";

/** Messages from the minimizer worker. */
export type FromMinimizer =
  | { readonly type: "progress"; readonly runs: number; readonly actions: number }
  | { readonly type: "done"; readonly kind: string; readonly minimized: Scenario }
  | { readonly type: "noFailure" }
  | { readonly type: "error"; readonly message: string };

// The app compiles against DOM types; only these worker globals are needed here.
const scope = globalThis as unknown as {
  postMessage(message: FromMinimizer): void;
  onmessage: ((event: MessageEvent<Scenario>) => void) | null;
};

// Runs one minimization (the same one `sim fuzz` does) and reports progress. The page
// cancels by terminating the worker.
scope.onmessage = (event) => {
  try {
    const result = minimizeFailure(defaultRegistry(), event.data, (best, runs) =>
      scope.postMessage({ type: "progress", runs, actions: best.actions.length }),
    );
    scope.postMessage(
      result === null
        ? { type: "noFailure" }
        : { type: "done", kind: result.kind, minimized: result.minimized },
    );
  } catch (e) {
    scope.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
