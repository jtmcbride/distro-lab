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
  /**
   * How `get`s are served. `log`: as log entries, like writes. `readIndex`: the leader
   * confirms it still leads with a heartbeat round, waits to apply up to the commit index it
   * saw, then answers from its state machine (no log entry). `lease`: while the leader holds
   * a lease it answers the same way without the round; otherwise it falls back to ReadIndex.
   */
  readonly readMode: ReadMode;
  /**
   * Lease mode's assumption: every clock runs within this many parts per million of true
   * time. Leases are shortened to stay safe under it; drift beyond it can break them.
   */
  readonly maxDriftPpm: number;
}

export type ReadMode = "log" | "readIndex" | "lease";

export const DEFAULT_RAFT_CONFIG: RaftConfig = {
  electionTimeoutMinMs: 150,
  electionTimeoutMaxMs: 300,
  heartbeatIntervalMs: 50,
  maxEntriesPerAppend: 64,
  fastBackoff: true,
  readMode: "log",
  maxDriftPpm: 50_000,
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
  /** Leaders only (readIndex): heartbeat rounds started in this term; sent as `round`. */
  round: number;
  /** Leaders only: highest round each follower has answered in this term. */
  ackedRound: Record<NodeId, number>;
  /** Leaders only: reads waiting to be served without a log entry. */
  pendingReads: PendingRead[];
  /** Leaders only (lease): local send time of each round not yet confirmed by a majority. */
  roundSentAt: Record<number, number>;
  /** Leaders only (lease): local time until which no other leader can exist. */
  leaseUntil: number | null;
  /**
   * Lease mode: local time this server last heard from a leader (or led, or restarted). It
   * ignores RequestVote until the minimum election timeout has passed since then.
   */
  lastLeaderContact: number | null;
}

/** A read the leader will answer once it has confirmed leadership and applied enough. */
export interface PendingRead {
  readonly clientId: NodeId;
  readonly seq: number;
  readonly op: KvOp;
  /**
   * Commit index when the read was accepted; null until the leader has committed an entry in
   * its own term (before that, its commit index may be behind the previous leader's).
   */
  readIndex: number | null;
  /** Heartbeat round that must be answered by a majority (started after `readIndex`). */
  round: number | null;
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
  /** Heartbeat round (readIndex and lease modes only); echoed in the response. */
  readonly round?: number;
}

export type AppendEntriesResponse =
  | {
      readonly type: "AppendEntriesResponse";
      readonly term: number;
      readonly success: true;
      /** prevLogIndex + entries.length of the request: known to match the leader. */
      readonly matchIndex: number;
      readonly round?: number;
    }
  | {
      readonly type: "AppendEntriesResponse";
      readonly term: number;
      readonly success: false;
      /** Fast backoff hints: where the leader should retry from. */
      readonly conflictIndex: number;
      readonly conflictTerm: number | null;
      readonly round?: number;
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
  /** Leaders: reads waiting to be served outside the log. */
  readonly pendingReads: number;
  /** Leaders in lease mode: local clock time the lease runs until, if any. */
  readonly leaseUntil: number | null;
};
