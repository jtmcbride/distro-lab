import { sim } from "../sim/client.ts";
import { useSim } from "../state/store.ts";
import { formatMs } from "./PlaybackBar.tsx";

/** Branch switcher: what-if variants of the scenario forked at some moment. */
export function BranchBar() {
  const { branches, branch, compareWith } = useSim();
  const current = branches.find((b) => b.id === branch);
  // Compare with the parent by default (the branch this what-if departs from).
  const defaultOther =
    branches.find((b) => b.id === current?.parent)?.id ??
    branches.find((b) => b.id !== branch)?.id ??
    null;
  const nameOf = (id: number | null) => branches.find((b) => b.id === id)?.name ?? "deleted";
  return (
    <div className="branches" role="toolbar" aria-label="Branches">
      <span className="muted small">Branches</span>
      {branches.map((b) => (
        <span key={b.id} className={`branch-chip${b.id === branch ? " current" : ""}`}>
          <button
            type="button"
            aria-pressed={b.id === branch}
            onClick={() => sim.switchBranch(b.id)}
            onDoubleClick={() => {
              const name = window.prompt("Branch name", b.name)?.trim();
              if (name) sim.renameBranch(b.id, name);
            }}
            title={
              b.parent === null
                ? "The scenario as loaded (double-click to rename)"
                : `Forked from ${nameOf(b.parent)} at ${formatMs(b.forkT)} (double-click to rename)`
            }
          >
            {b.name}
            {b.parent !== null && <span className="muted"> @{formatMs(b.forkT)}</span>}
          </button>
          {b.id !== branch && b.parent !== null && (
            <button
              type="button"
              className="icon"
              aria-label={`Delete ${b.name}`}
              onClick={() => sim.deleteBranch(b.id)}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {branches.length > 1 && (
        <button
          type="button"
          aria-pressed={compareWith !== null}
          onClick={() =>
            useSim.setState({
              compareWith: compareWith !== null ? null : defaultOther,
            })
          }
          title="Compare this branch with another one at the same moment"
        >
          Compare
        </button>
      )}
      <button
        type="button"
        onClick={() => sim.fork()}
        title="Start a what-if branch from this moment; the current branch stays as it is"
      >
        ⑂ Fork here
      </button>
    </div>
  );
}
