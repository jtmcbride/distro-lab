import type { CanonicalValue, ProcessState } from "@distro-lab/core";
import type { ReactNode } from "react";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function Timers({ p, now }: { p: ProcessState; now: number }) {
  if (!p.up) return <span className="muted">none (down)</span>;
  if (p.timers.length === 0) return <span className="muted">none</span>;
  return (
    <>
      {p.timers.map((t) => (
        <span key={t.key} className="pill">
          {t.key} in {Math.max(0, t.at - now).toFixed(0)} ms
        </span>
      ))}
    </>
  );
}

/** Caption under a client node: its backlog, or how many operations it finished. */
export function clientCaption(view: CanonicalValue): string {
  const v = (view ?? {}) as { queued?: number; inFlight?: number | null; completed?: number };
  const pending = (v.queued ?? 0) + (v.inFlight === null || v.inFlight === undefined ? 0 : 1);
  return pending > 0 ? `${pending} pending` : `${v.completed ?? 0} done`;
}
