import { create } from "zustand";
import type {
  BranchInfo,
  CanonicalValue,
  Frame,
  ProcessState,
  ScenarioAction,
  Violation,
} from "@distro-lab/core";
import { trace, traceEpoch } from "./trace.ts";

export interface SimState {
  readonly loaded: boolean;
  readonly protocol: string;
  /** Display name of the loaded scenario. */
  readonly scenarioName: string;
  /** After an import or share link, jump to the first violation once one is known. */
  readonly jumpToViolation: boolean;
  /** Protocol config of the loaded scenario (e.g. Raft timeouts). */
  readonly config: CanonicalValue | undefined;
  readonly now: number;
  readonly durationMs: number;
  readonly playing: boolean;
  readonly speed: number;
  readonly events: number;
  readonly idle: boolean;
  readonly processes: readonly ProcessState[];
  readonly network: CanonicalValue | null;
  readonly violations: readonly Violation[];
  readonly branches: readonly BranchInfo[];
  /** Current branch id. */
  readonly branch: number;
  /** The current branch's scenario actions. */
  readonly actions: readonly ScenarioAction[];
  /** Bumped whenever `trace` changes. */
  readonly traceVersion: number;
  readonly error: string | null;
  /** UI selection: a process id and/or a trace record id. */
  readonly selectedProcess: string | null;
  readonly selectedRecord: number | null;
  /** Selection to apply when the next reset frame arrives (e.g. after seeking to it). */
  readonly pendingSelection: { record: number; process: string | null } | null;
}

export const useSim = create<SimState>(() => ({
  loaded: false,
  protocol: "raft",
  scenarioName: "",
  jumpToViolation: false,
  config: undefined,
  now: 0,
  durationMs: 0,
  playing: false,
  speed: 0.1,
  events: 0,
  idle: false,
  processes: [],
  network: null,
  violations: [],
  branches: [],
  branch: 0,
  actions: [],
  traceVersion: 0,
  error: null,
  selectedProcess: null,
  selectedRecord: null,
  pendingSelection: null,
}));

/** Folds a worker frame into the store and the shared trace. */
export function applyFrame(frame: Frame): void {
  const rewound = frame.reset || frame.truncateAfter !== null;
  if (frame.reset) trace.length = 0;
  else if (frame.truncateAfter !== null) trace.length = frame.truncateAfter + 1;
  if (rewound) traceEpoch.value++;
  for (const r of frame.records) trace.push(r);
  useSim.setState((s) => ({
    loaded: true,
    now: frame.now,
    durationMs: Math.max(s.durationMs, frame.now),
    playing: frame.playing,
    speed: frame.speed,
    events: frame.events,
    idle: frame.idle,
    processes: frame.processes,
    network: frame.network,
    violations: rewound ? frame.violations : [...s.violations, ...frame.violations],
    traceVersion: rewound || frame.records.length > 0 ? s.traceVersion + 1 : s.traceVersion,
    error: null,
    branch: frame.branch,
    ...(frame.branches === null ? {} : { branches: frame.branches }),
    ...(frame.actions === null ? {} : { actions: frame.actions }),
    ...(frame.jumped && s.pendingSelection !== null
      ? {
          selectedRecord: s.pendingSelection.record,
          selectedProcess: s.pendingSelection.process,
          pendingSelection: null,
        }
      : frame.reset || (s.selectedRecord !== null && s.selectedRecord >= trace.length)
        ? { selectedRecord: null }
        : {}),
  }));
}
