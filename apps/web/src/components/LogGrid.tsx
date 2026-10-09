import { canonicalJson, type Raft } from "@distro-lab/core";
import { useSim } from "../state/store.ts";

const MAX_COLUMNS = 60;

const short = (e: Raft.RaftLogEntry) =>
  e.command.kind === "noop" ? "·" : `${e.command.clientId.replace(/^c/, "c")}#${e.command.seq}`;

const detail = (e: Raft.RaftLogEntry) => {
  if (e.command.kind === "noop") return "no-op (appended by a new leader)";
  const op = e.command.op;
  const what =
    op.type === "put"
      ? `put ${op.key}=${op.value}`
      : op.type === "get"
        ? `get ${op.key}`
        : `cas ${op.key}: ${op.expect ?? "∅"}→${op.value}`;
  return `${e.command.clientId} request #${e.command.seq}: ${what}`;
};

const sameEntry = (a: Raft.RaftLogEntry | undefined, b: Raft.RaftLogEntry | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.term === b.term &&
  // Canonical form: a leader's own entries and followers' parsed copies differ in key order.
  canonicalJson(a.command) === canonicalJson(b.command);

/**
 * Every server's log side by side, like the figures in the Raft paper. Cells show the entry's
 * term; solid = committed on that server, dashed = not yet committed there, and a red mark
 * where the entry differs from the current leader's.
 */
export function LogGrid() {
  const { processes, selectedProcess } = useSim();
  const servers = processes.filter((p) => p.role === "server");
  const views = servers.map((p) => ({ p, v: p.view as Raft.RaftView }));
  const leader = views.find(({ p, v }) => p.up && v.role === "leader");
  const longest = Math.max(0, ...views.map(({ v }) => v.log.length));
  const first = Math.max(1, longest - MAX_COLUMNS + 1);
  const indexes = Array.from({ length: longest - first + 1 }, (_, i) => first + i);

  if (longest === 0) return <p className="muted">All logs are empty.</p>;
  return (
    <div className="log-grid-wrap">
      {first > 1 && <p className="muted">Showing the last {MAX_COLUMNS} indexes.</p>}
      <table className="log-grid">
        <thead>
          <tr>
            <th scope="col">Index</th>
            {indexes.map((i) => (
              <th key={i} scope="col">
                {i}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {views.map(({ p, v }) => (
            <tr
              key={p.id}
              className={`${p.up ? "" : "down"}${p.id === selectedProcess ? " selected" : ""}`}
            >
              <th scope="row" onClick={() => useSim.setState({ selectedProcess: p.id })}>
                {p.id}
                {p.up && v.role === "leader" ? " ★" : ""}
              </th>
              {indexes.map((i) => {
                const e = v.log[i - 1];
                if (e === undefined) return <td key={i} className="empty" />;
                const committed = i <= v.commitIndex;
                const conflict =
                  leader !== undefined &&
                  leader.p.id !== p.id &&
                  i <= leader.v.log.length &&
                  !sameEntry(e, leader.v.log[i - 1]);
                return (
                  <td
                    key={i}
                    className={`entry term-${e.term % 8}${committed ? " committed" : ""}${conflict ? " conflict" : ""}`}
                    title={`${p.id}[${i}] term ${e.term}: ${detail(e)}\n${committed ? "committed" : "not committed"} on ${p.id}${i <= v.lastApplied ? ", applied" : ""}${conflict ? `\ndiffers from leader ${leader!.p.id}` : ""}`}
                  >
                    <span className="t">{e.term}</span>
                    <span className="c">{short(e)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="legend muted">
        Number = term · solid = committed on that server · dashed = not committed yet · red outline
        = differs from the leader&apos;s log · ★ = leader
      </p>
    </div>
  );
}
