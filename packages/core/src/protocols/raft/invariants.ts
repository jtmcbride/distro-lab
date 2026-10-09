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
  const leaderOf = new Map<number, NodeId>();
  return {
    name: "election-safety",
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
  const votes = new Map<string, NodeId>();
  return {
    name: "single-vote-per-term",
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
  const last = new Map<NodeId, number>();
  return {
    name: "term-monotonic",
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
  const leaderOf = new Map<number, NodeId>();
  return {
    name: "follows-real-leader",
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

/**
 * §5.3 Log Matching: if two logs contain an entry with the same index and term, the logs are
 * identical in all entries up through that index.
 */
function logMatching(): Invariant<RaftView> {
  return {
    name: "log-matching",
    check(s, report) {
      // Rolling prefix fingerprint per (index, term); any disagreement is a violation.
      const prefixAt = new Map<string, { node: NodeId; prefix: string }>();
      for (const n of s.nodes) {
        let prefix = "";
        n.view.log.forEach((entry, i) => {
          prefix = String(hash32(prefix + entryKey(entry)));
          const key = `${i + 1}@${entry.term}`;
          const seen = prefixAt.get(key);
          if (seen === undefined) prefixAt.set(key, { node: n.id, prefix });
          else if (seen.prefix !== prefix) {
            report(
              `${seen.node} and ${n.id} both have term ${entry.term} at index ${i + 1} but different entries up to it`,
              [seen.node, n.id],
            );
          }
        });
      }
    },
  };
}

/**
 * Commit bookkeeping shared by leader completeness and state machine safety: the first entry
 * observed committed (resp. applied) at each index, and the term in which that was observed.
 */
function committedEntries() {
  const committed = new Map<number, { entry: RaftLogEntry; term: number; node: NodeId }>();
  const record = (s: ClusterSnapshot<RaftView>) => {
    for (const n of s.nodes) {
      const { log, commitIndex, term } = n.view;
      for (let i = 1; i <= Math.min(commitIndex, log.length); i++) {
        if (!committed.has(i)) committed.set(i, { entry: log[i - 1]!, term, node: n.id });
      }
    }
  };
  return { committed, record };
}

/**
 * §5.4 Leader Completeness: once an entry is committed in some term, it is present in the
 * log of every leader of that or any later term. Also catches a committed index being
 * overwritten anywhere it is recorded as committed.
 */
function leaderCompleteness(): Invariant<RaftView> {
  const { committed, record } = committedEntries();
  return {
    name: "leader-completeness",
    check(s, report) {
      record(s);
      for (const n of s.nodes) {
        if (!n.up || n.view.role !== "leader") continue;
        for (const [index, c] of committed) {
          if (n.view.term < c.term) continue;
          const mine = n.view.log[index - 1];
          if (mine === undefined || entryKey(mine) !== entryKey(c.entry)) {
            report(
              `leader ${n.id} (term ${n.view.term}) has ${describe(mine)} at index ${index}, but ${describe(c.entry)} was committed there (seen on ${c.node} in term ${c.term})`,
              [n.id, c.node],
            );
          }
        }
      }
    },
  };
}

/** §5.4.3 State Machine Safety: no two servers apply different entries at the same index. */
function stateMachineSafety(): Invariant<RaftView> {
  const applied = new Map<number, { entry: RaftLogEntry; node: NodeId }>();
  return {
    name: "state-machine-safety",
    check(s, report) {
      for (const n of s.nodes) {
        const { log, lastApplied } = n.view;
        for (let i = 1; i <= lastApplied; i++) {
          const entry = log[i - 1];
          const first = applied.get(i);
          if (entry === undefined) {
            report(`${n.id} applied index ${i} but its log has only ${log.length} entries`, [n.id]);
            break;
          }
          if (first === undefined) applied.set(i, { entry, node: n.id });
          else if (entryKey(first.entry) !== entryKey(entry)) {
            report(
              `${first.node} applied ${describe(first.entry)} at index ${i} but ${n.id} applied ${describe(entry)}`,
              [first.node, n.id],
            );
          }
        }
      }
    },
  };
}

/** lastApplied <= commitIndex <= log length, and commitIndex never decreases within a run. */
function commitBookkeeping(): Invariant<RaftView> {
  const highest = new Map<string, number>();
  return {
    name: "commit-bookkeeping",
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
function leaderAppendOnly(): Invariant<RaftView> {
  // (node, incarnation, term) -> the leader's log entries when last seen.
  const seen = new Map<string, RaftLogEntry[]>();
  return {
    name: "leader-append-only",
    check(s, report) {
      for (const n of s.nodes) {
        if (!n.up || n.view.role !== "leader") continue;
        const key = `${n.id}/${n.incarnation}/${n.view.term}`;
        const before = seen.get(key);
        const log = n.view.log;
        if (before !== undefined) {
          const shrank = log.length < before.length;
          const changed = before.findIndex(
            (e, i) => log[i] === undefined || entryKey(log[i]!) !== entryKey(e),
          );
          if (shrank || changed >= 0) {
            const at = changed >= 0 ? changed + 1 : log.length + 1;
            report(`leader ${n.id} changed its log at index ${at} during term ${n.view.term}`, [
              n.id,
            ]);
          }
        }
        seen.set(key, [...log]);
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
  return [
    electionSafety(),
    singleVotePerTerm(),
    termMonotonic(),
    candidateVotesForSelf(),
    followsRealLeader(),
    logMatching(),
    leaderCompleteness(),
    stateMachineSafety(),
    commitBookkeeping(),
    leaderAppendOnly(),
    acknowledgedWritesReplicated(),
  ];
}
