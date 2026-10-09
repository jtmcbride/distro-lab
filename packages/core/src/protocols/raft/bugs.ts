import type { Protocol } from "../../protocol.ts";
import { raft } from "./raft.ts";
import type { RaftMessage, RaftPersistent, RaftVolatile } from "./types.ts";

type RaftProtocol = Protocol<RaftPersistent, RaftVolatile, RaftMessage, never>;

/**
 * Deliberately broken Raft variants. They exist to prove that the invariant checker and the
 * chaos runner catch realistic mistakes; never use them for anything else.
 */
export const RAFT_BUGS = {
  "double-vote": {
    description: "Forgets its vote before every RequestVote, so it can vote twice in a term.",
    create(): RaftProtocol {
      const base = raft();
      return {
        ...base,
        onMessage(ctx, s, from, m) {
          if (m.type === "RequestVote" && m.term === s.persistent.currentTerm) {
            s.persistent.votedFor = null;
          }
          base.onMessage(ctx, s, from, m);
        },
      };
    },
  },
  "volatile-vote": {
    description: "Treats votedFor as volatile: a restarted node can vote again in the same term.",
    create(): RaftProtocol {
      const base = raft();
      return {
        ...base,
        recover(ctx, persistent) {
          return base.recover(ctx, { ...persistent, votedFor: null });
        },
      };
    },
  },
  "stale-votes": {
    description: "Counts vote responses from earlier terms toward the current election.",
    create(): RaftProtocol {
      const base = raft();
      return {
        ...base,
        onMessage(ctx, s, from, m) {
          const stale =
            m.type === "RequestVoteResponse" && m.voteGranted && m.term < s.persistent.currentTerm;
          base.onMessage(ctx, s, from, stale ? { ...m, term: s.persistent.currentTerm } : m);
        },
      };
    },
  },
} as const;

export type RaftBug = keyof typeof RAFT_BUGS;
