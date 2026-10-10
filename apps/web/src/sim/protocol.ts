import type { Action, CanonicalValue, Frame, Scenario } from "@distro-lab/core";

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
  | { readonly type: "export"; readonly requestId: number };

/** Messages from the simulation worker to the page. */
export type FromWorker =
  | { readonly type: "frame"; readonly frame: Frame }
  | { readonly type: "scenario"; readonly requestId: number; readonly scenario: Scenario }
  | { readonly type: "error"; readonly message: string };
