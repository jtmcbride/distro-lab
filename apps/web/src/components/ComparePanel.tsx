import { useEffect, useState } from "react";
import {
  canonicalJson,
  formatRecord,
  type CanonicalValue,
  type Comparison,
} from "@distro-lab/core";
import { sim } from "../sim/client.ts";
import { useSim } from "../state/store.ts";
import { formatMs } from "./PlaybackBar.tsx";

const compact = (v: CanonicalValue) => {
  const s = canonicalJson(v);
  return s.length > 90 ? `${s.slice(0, 87)}…` : s;
};

/**
 * A pair of differing values for display. Lists (e.g. logs) show their length and their
 * contents from the first index where they differ.
 */
function showPair(a: CanonicalValue, b: CanonicalValue): [string, string] {
  if (!Array.isArray(a) || !Array.isArray(b)) return [compact(a), compact(b)];
  let i = 0;
  while (i < a.length && i < b.length && canonicalJson(a[i]!) === canonicalJson(b[i]!)) i++;
  const tail = (list: readonly CanonicalValue[]) =>
    `${list.length} items${i < list.length ? `; from #${i + 1}: ${compact(list.slice(i))}` : ""}`;
  return [tail(a), tail(b)];
}

/**
 * Goes to the moment the branches part: this branch's divergent record if it comes first,
 * else the time of the other branch's (with the last shared record selected).
 */
function jumpToDivergence(c: Comparison): void {
  const id = c.divergence!;
  const [mine, theirs] = c.divergent;
  if (mine !== null && (theirs === null || mine.t <= theirs.t)) {
    useSim.setState({ pendingSelection: { record: id, process: null } });
    sim.seekRecord(id);
  } else {
    if (id > 0) useSim.setState({ pendingSelection: { record: id - 1, process: null } });
    sim.seek(theirs!.t);
  }
}

/** The current branch next to another one at the same moment. */
export function ComparePanel() {
  const { branches, branch, compareWith, now, playing } = useSim();
  const [result, setResult] = useState<Comparison | null>(null);
  const other = branches.find((b) => b.id === compareWith && b.id !== branch);
  const nameOf = (id: number) => branches.find((b) => b.id === id)?.name ?? "?";

  useEffect(() => {
    if (other === undefined || playing) return;
    let current = true;
    void sim.compare(other.id).then((c) => {
      if (current) setResult(c);
    });
    return () => {
      current = false;
    };
  }, [other?.id, branch, now, playing]);

  if (compareWith === null) return null;
  const close = () => useSim.setState({ compareWith: null });
  const others = branches.filter((b) => b.id !== branch);

  const outcomeRows = (c: Comparison) => {
    const [a, b] = c.outcomes;
    const labels = [...new Set([...Object.keys(a.annotations), ...Object.keys(b.annotations)])];
    const violations = (o: typeof a) =>
      o.violations.length === 0
        ? "none"
        : `${o.violations.length} (first: ${o.violations[0]!.invariant} at ${formatMs(o.violations[0]!.t)})`;
    return [
      { label: "Safety violations", values: [violations(a), violations(b)] },
      { label: "Events", values: [a.events.toLocaleString(), b.events.toLocaleString()] },
      ...labels.sort().map((l) => ({
        label: l,
        values: [String(a.annotations[l] ?? 0), String(b.annotations[l] ?? 0)],
      })),
    ];
  };

  return (
    <section className="panel compare" aria-label="Compare branches">
      <div className="compare-head">
        <h2>Compare</h2>
        <span>
          <strong>{nameOf(branch)}</strong> vs{" "}
          <select
            aria-label="Branch to compare with"
            value={compareWith}
            onChange={(e) => useSim.setState({ compareWith: Number(e.target.value) })}
          >
            {others.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>{" "}
          at {formatMs(now)}
        </span>
        <button type="button" className="icon" aria-label="Close comparison" onClick={close}>
          ×
        </button>
      </div>
      {other === undefined ? (
        <p className="muted">Pick a branch to compare with.</p>
      ) : playing ? (
        <p className="muted">Pause to compare.</p>
      ) : result === null ? (
        <p className="muted">Comparing…</p>
      ) : (
        <div className="compare-body">
          <div>
            <h3>First difference</h3>
            {result.divergence === null ? (
              <p className="muted">None: both branches are identical up to now.</p>
            ) : (
              <>
                <p className="small">
                  Record #{result.divergence}{" "}
                  <button type="button" onClick={() => jumpToDivergence(result)}>
                    Jump here
                  </button>
                </p>
                <dl className="fields">
                  <dt>{nameOf(branch)}</dt>
                  <dd>
                    <code>
                      {result.divergent[0] === null
                        ? "(nothing yet)"
                        : formatRecord(result.divergent[0])}
                    </code>
                  </dd>
                  <dt>{other.name}</dt>
                  <dd>
                    <code>
                      {result.divergent[1] === null
                        ? "(nothing yet)"
                        : formatRecord(result.divergent[1])}
                    </code>
                  </dd>
                </dl>
              </>
            )}
          </div>
          <div>
            <h3>Outcome so far</h3>
            <table className="compare-table">
              <thead>
                <tr>
                  <th />
                  <th>{nameOf(branch)}</th>
                  <th>{other.name}</th>
                </tr>
              </thead>
              <tbody>
                {outcomeRows(result).map((r) => (
                  <tr key={r.label} className={r.values[0] === r.values[1] ? "" : "differs"}>
                    <th>{r.label}</th>
                    <td>{r.values[0]}</td>
                    <td>{r.values[1]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="compare-state">
            <h3>State now</h3>
            {result.processes.length === 0 ? (
              <p className="muted">Every process is in the same state.</p>
            ) : (
              <table className="compare-table">
                <thead>
                  <tr>
                    <th>Process</th>
                    <th>Field</th>
                    <th>{nameOf(branch)}</th>
                    <th>{other.name}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.processes.flatMap((p) => [
                    ...(p.up[0] === p.up[1]
                      ? []
                      : [
                          <tr key={`${p.id}/up`}>
                            <th>{p.id}</th>
                            <td>up</td>
                            <td>{p.up[0] ? "up" : "down"}</td>
                            <td>{p.up[1] ? "up" : "down"}</td>
                          </tr>,
                        ]),
                    ...p.fields.map((f) => {
                      const [a, b] = showPair(f.values[0], f.values[1]);
                      return (
                        <tr key={`${p.id}/${f.key}`}>
                          <th>{p.id}</th>
                          <td>{f.key || "view"}</td>
                          <td>
                            <code>{a}</code>
                          </td>
                          <td>
                            <code>{b}</code>
                          </td>
                        </tr>
                      );
                    }),
                  ])}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
