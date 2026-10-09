import type { ClientMessage } from "../../clients/requestClient.ts";
import type { NodeId } from "../../protocol.ts";
import type { KvOp, KvResult, KvState } from "./kv.ts";

export interface RaftConfig {
  /** Election timeouts are drawn uniformly from [min, max] on every reset. */
  readonly electionTimeoutMinMs: number;
  readonly electionTimeoutMaxMs: number;
  /** Leader heartbeat period; must be well below the minimum election timeout. */
  readonly heartbeatIntervalMs: number;
  /** Upper bound on entries carried by one AppendEntries. */
  readonly maxEntriesPerAppend: number;
  /**
   * On a rejected AppendEntries, jump back a whole conflicting term (the optimization in
   * §5.3) instead of one entry at a time.
   */
  readonly fastBackoff: boolean;
}

export const DEFAULT_RAFT_CONFIG: RaftConfig = {
  electionTimeoutMinMs: 150,
  electionTimeoutMaxMs: 300,
  heartbeatIntervalMs: 50,
  maxEntriesPerAppend: 64,
  fastBackoff: true,
};

export type RaftCommand =
  /** Appended by every new leader so entries from earlier terms can commit (§5.4.2, §8). */
  | { readonly kind: "noop" }
  | {
      readonly kind: "client";
      readonly clientId: NodeId;
      readonly seq: number;
      readonly op: KvOp;
    };

export type RaftLogEntry = {
  readonly term: number;
  readonly command: RaftCommand;
};

/** Survives crashes (Figure 2, "persistent state on all servers"). */
export interface RaftPersistent {
  currentTerm: number;
  votedFor: NodeId | null;
  /** 1-indexed in messages: log[0] is index 1. */
  log: RaftLogEntry[];
}

export type RaftRole = "follower" | "candidate" | "leader";

export interface RaftVolatile {
  role: RaftRole;
  /** Leader this node currently follows (or itself), if known for the current term. */
  leaderId: NodeId | null;
  /** Candidates only: voters who granted a vote in the current term, including self. */
  votesGranted: NodeId[];
  /** Highest log index known to be committed. Volatile: rebuilt from the leader. */
  commitIndex: number;
  /** Highest log index applied to the state machine. */
  lastApplied: number;
  /** Leaders only: next log index to send to each follower. */
  nextIndex: Record<NodeId, number>;
  /** Leaders only: highest index known to be replicated on each follower. */
  matchIndex: Record<NodeId, number>;
  /** State machine; rebuilt by re-applying the log after a restart. */
  kv: KvState;
}

export interface RequestVote {
  readonly type: "RequestVote";
  readonly term: number;
  readonly candidateId: NodeId;
  readonly lastLogIndex: number;
  readonly lastLogTerm: number;
}

export interface RequestVoteResponse {
  readonly type: "RequestVoteResponse";
  readonly term: number;
  readonly voteGranted: boolean;
}

export interface AppendEntries {
  readonly type: "AppendEntries";
  readonly term: number;
  readonly leaderId: NodeId;
  readonly prevLogIndex: number;
  readonly prevLogTerm: number;
  readonly entries: readonly RaftLogEntry[];
  readonly leaderCommit: number;
}

export type AppendEntriesResponse =
  | {
      readonly type: "AppendEntriesResponse";
      readonly term: number;
      readonly success: true;
      /** prevLogIndex + entries.length of the request: known to match the leader. */
      readonly matchIndex: number;
    }
  | {
      readonly type: "AppendEntriesResponse";
      readonly term: number;
      readonly success: false;
      /** Fast backoff hints: where the leader should retry from. */
      readonly conflictIndex: number;
      readonly conflictTerm: number | null;
    };

export type RaftMessage =
  | RequestVote
  | RequestVoteResponse
  | AppendEntries
  | AppendEntriesResponse
  | ClientMessage<KvOp, KvResult>;

/** Plain-data view used by inspectors and invariant checks. Treat as read-only. */
export type RaftView = {
  readonly role: RaftRole;
  readonly term: number;
  readonly votedFor: NodeId | null;
  readonly leaderId: NodeId | null;
  readonly commitIndex: number;
  readonly lastApplied: number;
  /** The node's log (shared with its state, not copied; do not mutate or retain). */
  readonly log: readonly RaftLogEntry[];
  readonly data: Readonly<Record<string, string>>;
  /** Highest applied request seq per client (the exactly-once session table). */
  readonly sessions: Readonly<Record<NodeId, number>>;
};
