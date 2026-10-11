import type { ClientReply } from "../../clients/requestClient.ts";
import type { NodeId, NodeState, Protocol } from "../../protocol.ts";
import { raft, type PlantedRaftBugs } from "./raft.ts";
import { executeKv, type KvOp, type KvResult } from "./kv.ts";
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

/** Answers a client's `get` from the local applied state when `serves` says so, skipping the log. */
function localReads(
  description: string,
  serves: (s: NodeState<RaftPersistent, RaftVolatile>, clientId: NodeId, seq: number) => boolean,
): BugSpec {
  return {
    description,
    create(config) {
      const base = raft(config);
      return {
        ...base,
        onMessage(ctx, s, from, m) {
          if (m.type === "ClientRequest" && m.op.type === "get" && serves(s, m.clientId, m.seq)) {
            const result = executeKv(s.volatile.kv.data, m.op);
            const reply: ClientReply<KvResult> = {
              type: "ClientReply",
              seq: m.seq,
              status: "ok",
              result,
            };
            ctx.send(from, reply);
            return;
          }
          base.onMessage(ctx, s, from, m);
        },
      };
    },
  };
}

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
  "leader-local-reads": localReads(
    "The leader answers reads from its applied state without a log entry or a quorum check, so a deposed or lagging leader returns stale values.",
    (s) => s.volatile.role === "leader",
  ),
  "session-reads": localReads(
    "Any server that has applied a client's previous request answers its reads locally: the client always reads its own writes, but other clients' writes can be missing.",
    (s, clientId, seq) => s.volatile.kv.sessions[clientId]?.seq === seq - 1,
  ),
} satisfies Record<string, BugSpec>;

export type RaftBug = keyof typeof RAFT_BUGS;
