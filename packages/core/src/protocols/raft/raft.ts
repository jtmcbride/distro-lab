import type { NodeContext, NodeId, NodeState, Protocol } from "../../protocol.ts";
import {
  DEFAULT_RAFT_CONFIG,
  type AppendEntries,
  type RaftConfig,
  type RaftMessage,
  type RaftPersistent,
  type RaftVolatile,
  type RaftView,
  type RequestVote,
  type RequestVoteResponse,
} from "./types.ts";

type State = NodeState<RaftPersistent, RaftVolatile>;
type Ctx = NodeContext<RaftMessage>;

const ELECTION_TIMER = "election";
const HEARTBEAT_TIMER = "heartbeat";

/** Raft with fixed membership. Phase 1 covers leader election and heartbeats. */
export function raft(
  overrides: Partial<RaftConfig> = {},
): Protocol<RaftPersistent, RaftVolatile, RaftMessage, never> {
  const config = { ...DEFAULT_RAFT_CONFIG, ...overrides };
  if (
    config.electionTimeoutMinMs <= 0 ||
    config.electionTimeoutMaxMs < config.electionTimeoutMinMs ||
    config.heartbeatIntervalMs <= 0 ||
    config.heartbeatIntervalMs >= config.electionTimeoutMinMs
  ) {
    throw new RangeError(`invalid Raft timing config: ${JSON.stringify(config)}`);
  }

  const lastLogIndex = (s: State) => s.persistent.log.length;
  const lastLogTerm = (s: State) => s.persistent.log.at(-1)?.term ?? 0;
  const majority = (ctx: Ctx) => Math.floor((ctx.peers.length + 1) / 2) + 1;

  function resetElectionTimer(ctx: Ctx): void {
    ctx.setTimer(
      ELECTION_TIMER,
      ctx.rng.int(config.electionTimeoutMinMs, config.electionTimeoutMaxMs),
    );
  }

  function follower(ctx: Ctx, persistent: RaftPersistent): State {
    resetElectionTimer(ctx);
    return { persistent, volatile: { role: "follower", leaderId: null, votesGranted: [] } };
  }

  /** §5.1: any RPC with a newer term makes this node a follower in that term. */
  function observeTerm(ctx: Ctx, s: State, term: number): void {
    if (term <= s.persistent.currentTerm) return;
    const wasLeader = s.volatile.role === "leader";
    s.persistent.currentTerm = term;
    s.persistent.votedFor = null;
    s.volatile.role = "follower";
    s.volatile.leaderId = null;
    s.volatile.votesGranted = [];
    if (wasLeader) {
      ctx.cancelTimer(HEARTBEAT_TIMER);
      ctx.annotate("steppedDown", { term });
      resetElectionTimer(ctx);
    }
  }

  function startElection(ctx: Ctx, s: State): void {
    s.persistent.currentTerm++;
    s.persistent.votedFor = ctx.nodeId;
    s.volatile.role = "candidate";
    s.volatile.leaderId = null;
    s.volatile.votesGranted = [ctx.nodeId];
    ctx.annotate("electionStarted", { term: s.persistent.currentTerm });
    resetElectionTimer(ctx);
    const request: RequestVote = {
      type: "RequestVote",
      term: s.persistent.currentTerm,
      candidateId: ctx.nodeId,
      lastLogIndex: lastLogIndex(s),
      lastLogTerm: lastLogTerm(s),
    };
    for (const p of ctx.peers) ctx.send(p, request);
    maybeWin(ctx, s);
  }

  function maybeWin(ctx: Ctx, s: State): void {
    if (s.volatile.role !== "candidate" || s.volatile.votesGranted.length < majority(ctx)) return;
    s.volatile.role = "leader";
    s.volatile.leaderId = ctx.nodeId;
    ctx.cancelTimer(ELECTION_TIMER);
    ctx.annotate("becameLeader", { term: s.persistent.currentTerm });
    broadcastHeartbeat(ctx, s);
  }

  function broadcastHeartbeat(ctx: Ctx, s: State): void {
    const heartbeat: AppendEntries = {
      type: "AppendEntries",
      term: s.persistent.currentTerm,
      leaderId: ctx.nodeId,
      prevLogIndex: lastLogIndex(s),
      prevLogTerm: lastLogTerm(s),
      entries: [],
      leaderCommit: 0,
    };
    for (const p of ctx.peers) ctx.send(p, heartbeat);
    ctx.setTimer(HEARTBEAT_TIMER, config.heartbeatIntervalMs);
  }

  function onRequestVote(ctx: Ctx, s: State, from: NodeId, m: RequestVote): void {
    const p = s.persistent;
    // §5.4.1: the candidate's log must be at least as up-to-date as ours.
    const upToDate =
      m.lastLogTerm > lastLogTerm(s) ||
      (m.lastLogTerm === lastLogTerm(s) && m.lastLogIndex >= lastLogIndex(s));
    const grant =
      m.term === p.currentTerm && (p.votedFor === null || p.votedFor === m.candidateId) && upToDate;
    if (grant) {
      p.votedFor = m.candidateId;
      // Granting a vote counts as hearing from a plausible leader (§5.2).
      resetElectionTimer(ctx);
    }
    const response: RequestVoteResponse = {
      type: "RequestVoteResponse",
      term: p.currentTerm,
      voteGranted: grant,
    };
    ctx.send(from, response);
  }

  function onAppendEntries(ctx: Ctx, s: State, from: NodeId, m: AppendEntries): void {
    const p = s.persistent;
    if (m.term < p.currentTerm) {
      ctx.send(from, { type: "AppendEntriesResponse", term: p.currentTerm, success: false });
      return;
    }
    // m.term === currentTerm here (observeTerm ran first), so m.leaderId leads this term. A
    // leader receiving this would mean two leaders in one term; the invariant checker, not
    // the protocol, is responsible for reporting that.
    s.volatile.role = "follower";
    s.volatile.votesGranted = [];
    s.volatile.leaderId = m.leaderId;
    resetElectionTimer(ctx);
    // Log consistency checks and appends arrive in phase 2; heartbeats carry no entries.
    ctx.send(from, { type: "AppendEntriesResponse", term: p.currentTerm, success: true });
  }

  return {
    name: "raft",

    init(ctx) {
      return follower(ctx, { currentTerm: 0, votedFor: null, log: [] });
    },

    recover(ctx, persistent) {
      return follower(ctx, persistent);
    },

    onTimer(ctx, s, key) {
      if (key === ELECTION_TIMER && s.volatile.role !== "leader") startElection(ctx, s);
      else if (key === HEARTBEAT_TIMER && s.volatile.role === "leader") broadcastHeartbeat(ctx, s);
    },

    onMessage(ctx, s, from, m) {
      observeTerm(ctx, s, m.term);
      switch (m.type) {
        case "RequestVote":
          onRequestVote(ctx, s, from, m);
          return;
        case "RequestVoteResponse":
          if (
            m.voteGranted &&
            m.term === s.persistent.currentTerm &&
            s.volatile.role === "candidate" &&
            !s.volatile.votesGranted.includes(from)
          ) {
            s.volatile.votesGranted.push(from);
            maybeWin(ctx, s);
          }
          return;
        case "AppendEntries":
          onAppendEntries(ctx, s, from, m);
          return;
        case "AppendEntriesResponse":
          // Replication bookkeeping arrives in phase 2.
          return;
      }
    },

    onClientCommand() {
      // Client writes arrive in phase 2.
    },

    view(s): RaftView {
      return {
        role: s.volatile.role,
        term: s.persistent.currentTerm,
        votedFor: s.persistent.votedFor,
        leaderId: s.volatile.leaderId,
        logLength: s.persistent.log.length,
        lastLogTerm: s.persistent.log.at(-1)?.term ?? 0,
      };
    },
  };
}
