import type {
  Action,
  CanonicalValue,
  Comparison,
  Frame,
  Scenario,
  ScenarioAction,
} from "@distro-lab/core";

/** Messages from the page to the simulation worker. */
export type ToWorker =
  | { readonly type: "load"; readonly scenario: Scenario }
  | { readonly type: "play" }
  | { readonly type: "pause" }
  | { readonly type: "speed"; readonly speed: number }
  | { readonly type: "step" }
  | { readonly type: "stepNotable" }
  | { readonly type: "stepBack" }
  | { readonly type: "stepBackNotable" }
  | { readonly type: "seek"; readonly timeMs: number }
  | { readonly type: "seekRecord"; readonly id: number }
  | { readonly type: "act"; readonly action: Action<CanonicalValue, CanonicalValue> }
  | { readonly type: "export"; readonly requestId: number }
  | { readonly type: "fork"; readonly name?: string }
  | { readonly type: "switchBranch"; readonly id: number }
  | { readonly type: "deleteBranch"; readonly id: number }
  | { readonly type: "renameBranch"; readonly id: number; readonly name: string }
  | { readonly type: "editActions"; readonly actions: readonly ScenarioAction[] }
  | { readonly type: "compare"; readonly requestId: number; readonly other: number };

/** Messages from the simulation worker to the page. */
export type FromWorker =
  | { readonly type: "frame"; readonly frame: Frame }
  | { readonly type: "scenario"; readonly requestId: number; readonly scenario: Scenario }
  | { readonly type: "comparison"; readonly requestId: number; readonly comparison: Comparison }
  | { readonly type: "error"; readonly message: string };
