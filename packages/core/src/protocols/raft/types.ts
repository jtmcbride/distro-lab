import type { NodeId } from "../../protocol.ts";

export interface RaftConfig {
  /** Election timeouts are drawn uniformly from [min, max] on every reset. */
  readonly electionTimeoutMinMs: number;
  readonly electionTimeoutMaxMs: number;
  /** Leader heartbeat period; must be well below the minimum election timeout. */
  readonly heartbeatIntervalMs: number;
}

export const DEFAULT_RAFT_CONFIG: RaftConfig = {
  electionTimeoutMinMs: 150,
  electionTimeoutMaxMs: 300,
  heartbeatIntervalMs: 50,
};

export interface RaftLogEntry {
  readonly term: number;
  readonly command: unknown;
}

/** Survives crashes (Raft §5, Figure 2 "persistent state on all servers"). */
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

export interface AppendEntriesResponse {
  readonly type: "AppendEntriesResponse";
  readonly term: number;
  readonly success: boolean;
}

export type RaftMessage = RequestVote | RequestVoteResponse | AppendEntries | AppendEntriesResponse;

/** Plain-data view used by inspectors and invariant checks. (A type alias, not an
 * interface, so it is assignable to CanonicalValue.) */
export type RaftView = {
  readonly role: RaftRole;
  readonly term: number;
  readonly votedFor: NodeId | null;
  readonly leaderId: NodeId | null;
  readonly logLength: number;
  readonly lastLogTerm: number;
};
