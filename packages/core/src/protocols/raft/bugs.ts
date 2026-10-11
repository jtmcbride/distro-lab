import type { ClientReply } from "../../clients/requestClient.ts";
import type { NodeId, NodeState, Protocol } from "../../protocol.ts";
import { raft, type PlantedRaftBugs } from "./raft.ts";
import { executeKv, type KvOp, type KvResult } from "./kv.ts";
import type { RaftConfig, RaftMessage, RaftPersistent, RaftVolatile, ReadMode } from "./types.ts";

type RaftProtocol = Protocol<RaftPersistent, RaftVolatile, RaftMessage, KvOp>;

interface BugSpec {
  readonly description: string;
  create(config: Partial<RaftConfig>): RaftProtocol;
  /**
   * Settings the bug lives under, forced into generated scenarios (and into the protocol),
   * so a scenario's config always says what actually ran.
   */
  readonly config?: Partial<RaftConfig>;
}

const internal = (description: string, flags: PlantedRaftBugs): BugSpec => ({
  description,
  create: (config) => raft(config, flags),
});

/** A read-path bug, run under the settings it lives in (a read mode, maybe a drift bound). */
const inMode = (
  config: Partial<RaftConfig> & { readMode: ReadMode },
  description: string,
  flags: PlantedRaftBugs,
): BugSpec => ({
  description: `${description} (${config.readMode} mode)`,
  config,
  create: (c) => raft({ ...c, ...config }, flags),
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
  "readindex-skips-round": inMode(
    { readMode: "readIndex" },
    "Serves ReadIndex reads once applied, without confirming leadership with a heartbeat round.",
    { readIndexSkipsRound: true },
  ),
  "readindex-before-term-commit": inMode(
    { readMode: "readIndex" },
    "Takes the read index before the leader has committed an entry in its own term, when its commit index may still lag the previous leader's.",
    { readIndexBeforeTermCommit: true },
  ),
  // The widest drift bound the generator uses: the gap between the buggy lease and a safe
  // one grows with it.
  "lease-ignores-drift": inMode(
    { readMode: "lease", maxDriftPpm: 300_000 },
    "Holds the lease for the full minimum election timeout, as if clocks never drifted.",
    { leaseIgnoresDrift: true },
  ),
  "lease-no-stickiness": inMode(
    { readMode: "lease" },
    "Followers vote for a candidate even while they hear from a leader whose lease is running.",
    { noVoteStickiness: true },
  ),
  "lease-forgets-contact": inMode(
    { readMode: "lease" },
    "A restarted server votes at once, though it may have answered the leader's last round just before crashing.",
    { leaseForgetsContact: true },
  ),
} satisfies Record<string, BugSpec>;

export type RaftBug = keyof typeof RAFT_BUGS;
