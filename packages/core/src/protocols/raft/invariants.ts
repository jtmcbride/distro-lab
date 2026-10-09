import type { Invariant } from "../../invariants.ts";
import type { NodeId } from "../../protocol.ts";
import type { RaftView } from "./types.ts";

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
        if (n.up && n.view.role === "leader") leaderOf.set(n.view.term, n.id);
      }
      for (const n of s.nodes) {
        const l = n.view.leaderId;
        if (!n.up || l === null) continue;
        if (leaderOf.get(n.view.term) !== l) {
          report(`${n.id} follows ${l} in term ${n.view.term}, which ${l} never led`, [n.id, l]);
        }
      }
    },
  };
}

/** Fresh instances of every Raft safety invariant (they keep per-run history). */
export function raftInvariants(): Invariant<RaftView>[] {
  return [
    electionSafety(),
    singleVotePerTerm(),
    termMonotonic(),
    candidateVotesForSelf(),
    followsRealLeader(),
  ];
}
