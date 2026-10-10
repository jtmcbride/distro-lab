import type { TraceRecord } from "@distro-lab/core";

/**
 * The trace lives outside React state: it can hold hundreds of thousands of records and is
 * only ever appended to (or cleared on reset). Components read it directly and re-render
 * when the store's `traceVersion` changes.
 */
export const trace: TraceRecord[] = [];

/**
 * Bumped whenever records are removed (new scenario, or going back in time), so readers that
 * consume the trace incrementally know to start over.
 */
export const traceEpoch = { value: 0 };

/** Record lookup by id; ids are contiguous from 0 within one run. */
export const recordById = (id: number): TraceRecord | undefined => {
  const first = trace[0];
  return first === undefined ? undefined : trace[id - first.id];
};
