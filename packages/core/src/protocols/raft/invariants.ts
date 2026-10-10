import { canonicalJson } from "../../canonical.ts";
import type { ClusterSnapshot, Invariant } from "../../invariants.ts";
import type { NodeId } from "../../protocol.ts";
import type { RaftLogEntry, RaftView } from "./types.ts";

// Entries are immutable once created, so their canonical form can be cached by identity.
const entryKeys = new WeakMap<RaftLogEntry, string>();
function entryKey(entry: RaftLogEntry): string {
  let key = entryKeys.get(entry);
  if (key === undefined) {
    key = canonicalJson(entry);
    entryKeys.set(entry, key);
  }
  return key;
}

const describe = (e: RaftLogEntry | undefined) =>
  e === undefined
    ? "nothing"
    : `${e.command.kind === "client" ? `${e.command.clientId}#${e.command.seq}` : "noop"}@t${e.term}`;

/** §5.2 Election Safety: at most one leader can be elected in a given term. */
function electionSafety(): Invariant<RaftView> {
  let leaderOf = new Map<number, NodeId>();
  return {
    name: "election-safety",
    save: () => leaderOf,
    load: (state) => {
      leaderOf = state as typeof leaderOf;
    },
    check(s, report) {
      for (const n of s.nodes) {
        // A crashed node's view is stale, but it was checked while it was up.
        if (!n.up || n.view.role !== "leader") continue;
        const known = leaderOf.get(n.view.term);
        if (known === undefined) leaderOf.set(n.view.term, n.id);
        else if (known !== n.id) {
          report(`${known} and ${n.id} both led term ${n.view.term}`, [known, n.id]);
        }
      }
    },
  };
}

/** Each node grants at most one vote per term, including across restarts. */
function singleVotePerTerm(): Invariant<RaftView> {
  let votes = new Map<string, NodeId>();
  return {
    name: "single-vote-per-term",
    save: () => votes,
    load: (state) => {
      votes = state as typeof votes;
    },
    check(s, report) {
      for (const n of s.nodes) {
        if (n.view.votedFor === null) continue;
        const key = `${n.id}@${n.view.term}`;
        const earlier = votes.get(key);
        if (earlier === undefined) votes.set(key, n.view.votedFor);
        else if (earlier !== n.view.votedFor) {
          report(
            `${n.id} voted for ${earlier} and then ${n.view.votedFor} in term ${n.view.term}`,
            [n.id, earlier, n.view.votedFor],
          );
        }
      }
    },
  };
}

/** currentTerm never decreases on any node, including across restarts. */
function termMonotonic(): Invariant<RaftView> {
  let last = new Map<NodeId, number>();
  return {
    name: "term-monotonic",
    save: () => last,
    load: (state) => {
      last = state as typeof last;
    },
    check(s, report) {
      for (const n of s.nodes) {
        const prev = last.get(n.id) ?? 0;
        if (n.view.term < prev) report(`${n.id} term went from ${prev} to ${n.view.term}`, [n.id]);
        last.set(n.id, Math.max(prev, n.view.term));
      }
    },
  };
}

/** A candidate has voted for itself in its current term. */
function candidateVotesForSelf(): Invariant<RaftView> {
  return {
    name: "candidate-votes-for-self",
    check(s, report) {
      for (const n of s.nodes) {
        if (n.up && n.view.role === "candidate" && n.view.votedFor !== n.id) {
          report(`${n.id} is a candidate in term ${n.view.term} but voted for ${n.view.votedFor}`, [
            n.id,
          ]);
        }
      }
    },
  };
}

/**
 * A node that believes L leads term T is right: L really became leader in T. Catches
 * accepting AppendEntries from a stale or bogus leader.
 */
function followsRealLeader(): Invariant<RaftView> {
  let leaderOf = new Map<number, NodeId>();
  return {
    name: "follows-real-leader",
    save: () => leaderOf,
    load: (state) => {
      leaderOf = state as typeof leaderOf;
    },
    check(s, report) {
      for (const n of s.nodes) {
        // First leader seen wins; a second one is election-safety's to report.
        if (n.up && n.view.role === "leader" && !leaderOf.has(n.view.term)) {
          leaderOf.set(n.view.term, n.id);
        }
      }
      for (const n of s.nodes) {
        const l = n.view.leaderId;
        if (!n.up || l === null || n.view.role === "leader") continue;
        const actual = leaderOf.get(n.view.term);
        if (actual === undefined) {
          report(`${n.id} follows ${l} in term ${n.view.term}, which ${l} never led`, [n.id, l]);
        } else if (actual !== l) {
          report(`${n.id} follows ${l} in term ${n.view.term}, which ${actual} led first`, [
            n.id,
            l,
            actual,
          ]);
        }
      }
    },
  };
}

interface LogChange {
  /** First 1-based index that changed or was added since the last check. */
  readonly from: number;
  /** True if entries the node already had were removed or replaced. */
  readonly rewrote: boolean;
}

/**
 * Detects, per node, where its log changed since the previous snapshot. Entries are
 * immutable objects and logs only change by truncating and appending, so comparing entry
 * references finds the change point cheaply. Shared by the log invariants of one run.
 */
function logTracker() {
  let seen = new Map<NodeId, readonly RaftLogEntry[]>();
  let last: ClusterSnapshot<RaftView> | undefined;
  let changes = new Map<NodeId, LogChange>();
  const tracker = (s: ClusterSnapshot<RaftView>): ReadonlyMap<NodeId, LogChange> => {
    if (s === last) return changes;
    last = s;
    changes = new Map();
    for (const n of s.nodes) {
      const before = seen.get(n.id) ?? [];
      const log = n.view.log;
      const limit = Math.min(before.length, log.length);
      let i = 0;
      while (i < limit && before[i] === log[i]) i++;
      const rewrote = i < before.length;
      changes.set(n.id, { from: i + 1, rewrote });
      if (rewrote || i < log.length) seen.set(n.id, log.slice());
    }
    return changes;
  };
  /** Holds the tracker's history for snapshots; it checks nothing itself. */
  const memory: Invariant<RaftView> = {
    name: "log-tracker",
    check() {},
    save: () => seen,
    load: (state) => {
      seen = state as typeof seen;
      last = undefined;
    },
  };
  return Object.assign(tracker, { memory });
}

type Tracker = ReturnType<typeof logTracker>;

const entryHashes = new WeakMap<RaftLogEntry, number>();
function entryHash(entry: RaftLogEntry): number {
  let h = entryHashes.get(entry);
  if (h === undefined) {
    h = hash32(entryKey(entry));
    entryHashes.set(entry, h);
  }
  return h;
}

/**
 * §5.3 Log Matching: if two logs contain an entry with the same index and term, the logs are
 * identical in all entries up through that index. Checked across time as well: an (index,
 * term) entry is created once by that term's leader, so every copy ever seen must have the
 * same prefix.
 */
function logMatching(changes: Tracker): Invariant<RaftView> {
  let prefixAt = new Map<string, { node: NodeId; fingerprint: number }>();
  let fingerprints = new Map<NodeId, number[]>();
  return {
    name: "log-matching",
    save: () => ({ prefixAt, fingerprints }),
    load: (state) => {
      ({ prefixAt, fingerprints } = state as {
        prefixAt: typeof prefixAt;
        fingerprints: typeof fingerprints;
      });
    },
    check(s, report) {
      const changed = changes(s);
      for (const n of s.nodes) {
        const { from } = changed.get(n.id)!;
        const fps = fingerprints.get(n.id) ?? [];
        fps.length = Math.min(fps.length, from - 1);
        const log = n.view.log;
        for (let i = fps.length; i < log.length; i++) {
          const entry = log[i]!;
          const fingerprint = hash32(`${i === 0 ? 0 : fps[i - 1]}:${entryHash(entry)}`);
          fps.push(fingerprint);
          const key = `${i + 1}@${entry.term}`;
          const seen = prefixAt.get(key);
          if (seen === undefined) prefixAt.set(key, { node: n.id, fingerprint });
          else if (seen.fingerprint !== fingerprint) {
            report(
              `${seen.node} and ${n.id} both have term ${entry.term} at index ${i + 1} but different entries up to it`,
              [seen.node, n.id],
            );
          }
        }
        fingerprints.set(n.id, fps);
      }
    },
  };
}

/**
 * §5.4 Leader Completeness: once an entry is committed in some term, it is present in the
 * log of every leader of that or any later term.
 */
function leaderCompleteness(changes: Tracker): Invariant<RaftView> {
  // committed[i] is the entry first observed committed at index i + 1.
  let committed: { entry: RaftLogEntry; term: number; node: NodeId }[] = [];
  // Per leadership (node/incarnation/term): committed indices already verified.
  let verified = new Map<string, number>();
  return {
    name: "leader-completeness",
    save: () => ({ committed, verified }),
    load: (state) => {
      ({ committed, verified } = state as {
        committed: typeof committed;
        verified: typeof verified;
      });
    },
    check(s, report) {
      const changed = changes(s);
      for (const n of s.nodes) {
        const { log, commitIndex, term } = n.view;
        for (let i = committed.length; i < Math.min(commitIndex, log.length); i++) {
          committed.push({ entry: log[i]!, term, node: n.id });
        }
      }
      for (const n of s.nodes) {
        if (!n.up || n.view.role !== "leader") continue;
        const key = `${n.id}/${n.incarnation}/${n.view.term}`;
        let done = verified.get(key) ?? 0;
        done = Math.min(done, changed.get(n.id)!.from - 1);
        for (let i = done; i < committed.length; i++) {
          const c = committed[i]!;
          if (n.view.term < c.term) continue;
          const mine = n.view.log[i];
          if (
            mine === undefined ||
            entryHash(mine) !== entryHash(c.entry) ||
            entryKey(mine) !== entryKey(c.entry)
          ) {
            report(
              `leader ${n.id} (term ${n.view.term}) has ${describe(mine)} at index ${i + 1}, but ${describe(c.entry)} was committed there (seen on ${c.node} in term ${c.term})`,
              [n.id, c.node],
            );
          }
        }
        verified.set(key, committed.length);
      }
    },
  };
}

/** §5.4.3 State Machine Safety: no two servers apply different entries at the same index. */
function stateMachineSafety(changes: Tracker): Invariant<RaftView> {
  let applied: { entry: RaftLogEntry; node: NodeId }[] = [];
  let checkedUpTo = new Map<NodeId, number>();
  return {
    name: "state-machine-safety",
    save: () => ({ applied, checkedUpTo }),
    load: (state) => {
      ({ applied, checkedUpTo } = state as {
        applied: typeof applied;
        checkedUpTo: typeof checkedUpTo;
      });
    },
    check(s, report) {
      const changed = changes(s);
      for (const n of s.nodes) {
        const { log, lastApplied } = n.view;
        if (lastApplied > log.length) {
          report(
            `${n.id} applied index ${lastApplied} but its log has only ${log.length} entries`,
            [n.id],
          );
          continue;
        }
        // Re-check from a log change below what was checked (an applied entry replaced) or
        // from the start after a restart (lastApplied went back to 0).
        const start = Math.min(
          checkedUpTo.get(n.id) ?? 0,
          changed.get(n.id)!.from - 1,
          lastApplied,
        );
        for (let i = start; i < lastApplied; i++) {
          const entry = log[i]!;
          const first = applied[i];
          if (first === undefined) applied[i] = { entry, node: n.id };
          else if (first.entry !== entry && entryKey(first.entry) !== entryKey(entry)) {
            report(
              `${first.node} applied ${describe(first.entry)} at index ${i + 1} but ${n.id} applied ${describe(entry)}`,
              [first.node, n.id],
            );
          }
        }
        checkedUpTo.set(n.id, lastApplied);
      }
    },
  };
}

/** lastApplied <= commitIndex <= log length, and commitIndex never decreases within a run. */
function commitBookkeeping(): Invariant<RaftView> {
  let highest = new Map<string, number>();
  return {
    name: "commit-bookkeeping",
    save: () => highest,
    load: (state) => {
      highest = state as typeof highest;
    },
    check(s, report) {
      for (const n of s.nodes) {
        // A crashed node's view is its last state before the crash, under the new incarnation.
        if (!n.up) continue;
        const { lastApplied, commitIndex, log } = n.view;
        if (lastApplied > commitIndex) {
          report(`${n.id} applied up to ${lastApplied} but only ${commitIndex} is committed`, [
            n.id,
          ]);
        }
        if (commitIndex > log.length) {
          report(`${n.id} commitIndex ${commitIndex} is past its log (${log.length})`, [n.id]);
        }
        const key = `${n.id}/${n.incarnation}`;
        const prev = highest.get(key) ?? 0;
        if (commitIndex < prev) {
          report(`${n.id} commitIndex went from ${prev} to ${commitIndex} without restarting`, [
            n.id,
          ]);
        }
        highest.set(key, Math.max(prev, commitIndex));
      }
    },
  };
}

/** §5.3 Leader Append-Only: a leader never overwrites or deletes entries in its log. */
function leaderAppendOnly(changes: Tracker): Invariant<RaftView> {
  // Leadership (node/incarnation/term) each node held at the previous check, if any.
  let leadership = new Map<NodeId, string>();
  return {
    name: "leader-append-only",
    save: () => leadership,
    load: (state) => {
      leadership = state as typeof leadership;
    },
    check(s, report) {
      const changed = changes(s);
      for (const n of s.nodes) {
        const key =
          n.up && n.view.role === "leader" ? `${n.id}/${n.incarnation}/${n.view.term}` : undefined;
        const change = changed.get(n.id)!;
        if (key !== undefined && leadership.get(n.id) === key && change.rewrote) {
          report(
            `leader ${n.id} changed its log at index ${change.from} during term ${n.view.term}`,
            [n.id],
          );
        }
        if (key === undefined) leadership.delete(n.id);
        else leadership.set(n.id, key);
      }
    },
  };
}

/**
 * Client-visible durability: when a client receives a reply, the request's entry is
 * already stored on a majority of servers (so leader completeness keeps it forever).
 */
function acknowledgedWritesReplicated(): Invariant<RaftView> {
  return {
    name: "acknowledged-writes-replicated",
    check() {},
    onRecord(r, now, report) {
      if (r.type !== "annotate" || r.label !== "complete") return;
      const seq = (r.data as { seq?: unknown } | undefined)?.seq;
      if (typeof seq !== "number") return;
      const s = now();
      const holders = s.nodes.filter((n) =>
        n.view.log.some(
          (e) =>
            e.command.kind === "client" && e.command.clientId === r.node && e.command.seq === seq,
        ),
      );
      const majority = Math.floor(s.nodes.length / 2) + 1;
      if (holders.length < majority) {
        report(
          `${r.node} got a reply for request ${seq}, but only ${holders.length} of ${s.nodes.length} servers store it`,
          [r.node, ...holders.map((h) => h.id)],
        );
      }
    },
  };
}

/** 32-bit FNV-1a; good enough to fingerprint log prefixes within one check. */
function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fresh instances of every Raft safety invariant (they keep per-run history). */
export function raftInvariants(): Invariant<RaftView>[] {
  const changes = logTracker();
  return [
    electionSafety(),
    singleVotePerTerm(),
    termMonotonic(),
    candidateVotesForSelf(),
    followsRealLeader(),
    logMatching(changes),
    leaderCompleteness(changes),
    stateMachineSafety(changes),
    commitBookkeeping(),
    leaderAppendOnly(changes),
    acknowledgedWritesReplicated(),
    changes.memory,
  ];
}
