import type { Protocol } from "../../protocol.ts";
import { raft, type PlantedRaftBugs } from "./raft.ts";
import type { KvOp } from "./kv.ts";
import type { RaftConfig, RaftMessage, RaftPersistent, RaftVolatile } from "./types.ts";

type RaftProtocol = Protocol<RaftPersistent, RaftVolatile, RaftMessage, KvOp>;

interface BugSpec {
  readonly description: string;
  create(config: Partial<RaftConfig>): RaftProtocol;
}

const internal = (description: string, flags: PlantedRaftBugs): BugSpec => ({
  description,
  create: (config) => raft(config, flags),
});

/**
 * Deliberately broken Raft variants. They exist to prove that the invariant checker and the
 * chaos runner catch realistic mistakes; never use them for anything else.
 */
export const RAFT_BUGS = {
  "double-vote": {
    description: "Forgets its vote before every RequestVote, so it can vote twice in a term.",
    create(config) {
      const base = raft(config);
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
    create(config) {
      const base = raft(config);
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
    create(config) {
      const base = raft(config);
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
  "commit-old-terms": internal(
    "Commits any entry stored on a majority, even from an earlier term (the Figure 8 bug).",
    { commitOldTerms: true },
  ),
  "truncate-always": internal(
    "Truncates the log after prevLogIndex on every AppendEntries, even when entries match.",
    { truncateAlways: true },
  ),
  "trust-received": internal(
    "Followers treat replicated entries as committed before the leader says so.",
    { trustReceivedEntries: true },
  ),
  "no-sessions": internal("No session table: a retried request is executed again.", {
    noSessions: true,
  }),
  "lost-append": {
    description: "Does not fsync appends: a restarted node loses its newest log entry.",
    create(config) {
      const base = raft(config);
      return {
        ...base,
        recover(ctx, persistent) {
          return base.recover(ctx, { ...persistent, log: persistent.log.slice(0, -1) });
        },
      };
    },
  },
} satisfies Record<string, BugSpec>;

export type RaftBug = keyof typeof RAFT_BUGS;
