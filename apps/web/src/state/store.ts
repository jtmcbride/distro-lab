import { create } from "zustand";
import type { CanonicalValue, Frame, ProcessState, Violation } from "@distro-lab/core";
import { trace } from "./trace.ts";

export interface SimState {
  readonly loaded: boolean;
  readonly protocol: string;
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
  /** Bumped whenever `trace` changes. */
  readonly traceVersion: number;
  readonly error: string | null;
  /** UI selection: a process id and/or a trace record id. */
  readonly selectedProcess: string | null;
  readonly selectedRecord: number | null;
}

export const useSim = create<SimState>(() => ({
  loaded: false,
  protocol: "raft",
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
  traceVersion: 0,
  error: null,
  selectedProcess: null,
  selectedRecord: null,
}));

/** Folds a worker frame into the store and the shared trace. */
export function applyFrame(frame: Frame): void {
  if (frame.reset) trace.length = 0;
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
    violations: frame.reset ? frame.violations : [...s.violations, ...frame.violations],
    traceVersion: frame.reset || frame.records.length > 0 ? s.traceVersion + 1 : s.traceVersion,
    error: null,
    ...(frame.reset ? { selectedRecord: null } : {}),
  }));
}
