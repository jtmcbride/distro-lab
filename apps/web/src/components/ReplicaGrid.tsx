import { Dynamo, type ProcessState } from "@distro-lab/core";
import { useSim } from "../state/store.ts";

type Slot = Dynamo.Slot;

const isRegister = (slot: Slot): slot is readonly Dynamo.Version[] => Array.isArray(slot);

function joinSlots(a: Slot, b: Slot): Slot {
  if (isRegister(a) && isRegister(b)) return Dynamo.mergeVersions(a, b);
  if (!isRegister(a) && !isRegister(b)) return Dynamo.joinCrdt(a as Dynamo.Crdt, b as Dynamo.Crdt);
  return a;
}

export const versionTitle = (v: Dynamo.Version) =>
  `${JSON.stringify(v.value)} written by ${v.write} as ${Dynamo.formatDot(v.dot)}, replacing ${Dynamo.formatContext(v.context)}`;

/** A counter's entries, or a set's tags and the tags it has seen (including removed ones). */
function crdtTitle(state: Dynamo.Crdt): string {
  if (state.type === "counter") {
    const entries = Object.entries(state.counts).map(([n, c]) => `${n}: ${c}`);
    return `Counter: per coordinator, the increments it stamped (${entries.join(", ") || "none"})`;
  }
  const tags = Object.entries(state.entries).map(
    ([e, dots]) => `${e}: ${dots.map(Dynamo.formatDot).join(", ")}`,
  );
  return `Set tags: ${tags.join("; ") || "none"}\nTags seen (added or removed): ${Dynamo.formatContext(state.context)}`;
}

/** A slot's content: one chip per sibling, or a counter's value or a set's elements. */
export function SlotChips({ slot, hint }: { slot: Slot; hint?: string }) {
  if (!isRegister(slot)) {
    const state = slot as Dynamo.Crdt;
    const title = [hint, crdtTitle(state)].filter((t) => t !== undefined).join("\n");
    return (
      <span className={`chip crdt${hint === undefined ? "" : " hint"}`} title={title}>
        {Dynamo.formatCrdt(state)}
      </span>
    );
  }
  if (slot.length === 0) return <span className="muted">∅</span>;
  return (
    <>
      {slot.map((v) => (
        <span
          key={Dynamo.formatDot(v.dot)}
          className={`chip${hint === undefined ? "" : " hint"}`}
          title={hint === undefined ? versionTitle(v) : `${hint}\n${versionTitle(v)}`}
        >
          {v.value}
          <sub>{Dynamo.formatDot(v.dot)}</sub>
        </span>
      ))}
    </>
  );
}

/**
 * Every key across every server. A key's N replicas (by its preference list) show what they
 * hold; other servers show any hint they keep for it. A replica behind what the replicas
 * hold together is marked, as are keys with siblings.
 */
export function ReplicaGrid() {
  const { processes, config, selectedProcess } = useSim();
  const servers = processes.filter((p) => p.role === "server");
  const ids = servers.map((p) => p.id);
  const n = Math.min(ids.length, ((config ?? {}) as { n?: number }).n ?? 3);
  const view = (p: ProcessState) => p.view as Dynamo.DynamoView;
  const keys = [
    ...new Set(
      servers.flatMap((p) => [
        ...Object.keys(view(p).data),
        ...Object.values(view(p).hints).flatMap((store) => Object.keys(store)),
      ]),
    ),
  ].sort();

  if (keys.length === 0) return <p className="muted">No server stores anything yet.</p>;
  return (
    <div className="replica-grid-wrap">
      <table className="replica-grid">
        <thead>
          <tr>
            <th scope="col">Key</th>
            {servers.map((p) => (
              <th
                key={p.id}
                scope="col"
                className={`${p.up ? "" : "down"}${p.id === selectedProcess ? " selected" : ""}`}
                onClick={() => useSim.setState({ selectedProcess: p.id })}
              >
                {p.id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const order = Dynamo.preferenceList(ids, key);
            const replicas = order.slice(0, n);
            const held = servers.map((p) => view(p).data[key]);
            // What the replicas would hold together once hints are handed off.
            const hinted = servers.flatMap((p) =>
              Object.values(view(p).hints).flatMap((store) =>
                store[key] === undefined ? [] : [store[key]],
              ),
            );
            const all = [...held, ...hinted].reduce<Slot>(
              (acc, s) => (s === undefined ? acc : joinSlots(acc, s)),
              Dynamo.emptySlot(key),
            );
            const complete = Dynamo.slotDigest(all);
            const siblings = isRegister(all) && all.length > 1;
            return (
              <tr key={key}>
                <th
                  scope="row"
                  title={`Preference list: ${order.join(" → ")} (first ${n} are replicas)`}
                >
                  {key}
                  {siblings && <span className="pill warn">siblings</span>}
                </th>
                {servers.map((p, i) => {
                  const slot = held[i];
                  const hints = Object.entries(view(p).hints).filter(
                    ([, s]) => s[key] !== undefined,
                  );
                  if (replicas.includes(p.id)) {
                    const mine = slot ?? Dynamo.emptySlot(key);
                    const behind = Dynamo.slotDigest(mine) !== complete;
                    return (
                      <td
                        key={p.id}
                        className={`replica${behind ? " behind" : ""}${p.up ? "" : " down"}`}
                        title={`${p.id} is replica ${replicas.indexOf(p.id) + 1} of ${n} for ${key}${behind ? "\nBehind what the replicas and hints hold together" : ""}`}
                      >
                        <SlotChips slot={mine} />
                      </td>
                    );
                  }
                  return (
                    <td key={p.id} className={`other${p.up ? "" : " down"}`}>
                      {hints.length === 0 ? (
                        <span className="muted">·</span>
                      ) : (
                        hints.map(([owner, s]) => (
                          <SlotChips key={owner} slot={s[key]!} hint={`Hint held for ${owner}`} />
                        ))
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="legend muted">
        Outlined cells: the key&apos;s {n} replicas · dashed chips: hints held for a replica that
        was unreachable · amber: missing something other replicas or hints hold · several chips:
        siblings (concurrent writes) · subscript: the version&apos;s dot
      </p>
    </div>
  );
}
