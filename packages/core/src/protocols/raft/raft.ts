import type { ClientReply, ClientRequest } from "../../clients/requestClient.ts";
import type { NodeContext, NodeId, NodeState, Protocol } from "../../protocol.ts";
import { applyClientCommand, emptyKv, executeKv, type KvOp, type KvResult } from "./kv.ts";
import {
  DEFAULT_RAFT_CONFIG,
  type AppendEntries,
  type AppendEntriesResponse,
  type RaftConfig,
  type RaftLogEntry,
  type RaftMessage,
  type RaftPersistent,
  type RaftVolatile,
  type RaftView,
  type RequestVote,
  type RequestVoteResponse,
} from "./types.ts";

/** Internal switches for the planted-bug variants in bugs.ts. */
export interface PlantedRaftBugs {
  /** Commit any majority-replicated index, ignoring the current-term rule (Figure 8). */
  readonly commitOldTerms?: boolean;
  /** On AppendEntries, drop everything after prevLogIndex even when it matches. */
  readonly truncateAlways?: boolean;
  /** Followers treat entries as committed as soon as they receive them. */
  readonly trustReceivedEntries?: boolean;
  /** No session table: retried requests execute again. */
  readonly noSessions?: boolean;
}

type State = NodeState<RaftPersistent, RaftVolatile>;
type Ctx = NodeContext<RaftMessage>;

const ELECTION_TIMER = "election";
const HEARTBEAT_TIMER = "heartbeat";

/**
 * Raft (fixed membership) replicating a key-value store. Section numbers refer to the
 * extended Raft paper (Ongaro & Ousterhout, 2014).
 *
 * Client operations arrive as `ClientRequest`s from client processes. Leaders append them
 * to the log and reply once the entry is applied; non-leaders redirect. Every operation,
 * reads included, goes through the log, so all replies are linearizable.
 */
export function raft(
  overrides: Partial<RaftConfig> = {},
  /** Deliberate defects for testing the checkers. See bugs.ts; never set otherwise. */
  bugs: PlantedRaftBugs = {},
): Protocol<RaftPersistent, RaftVolatile, RaftMessage, KvOp> {
  const config = { ...DEFAULT_RAFT_CONFIG, ...overrides };
  if (
    config.electionTimeoutMinMs <= 0 ||
    config.electionTimeoutMaxMs < config.electionTimeoutMinMs ||
    config.heartbeatIntervalMs <= 0 ||
    config.heartbeatIntervalMs >= config.electionTimeoutMinMs ||
    !Number.isSafeInteger(config.maxEntriesPerAppend) ||
    config.maxEntriesPerAppend < 1 ||
    !["log", "readIndex", "lease"].includes(config.readMode) ||
    !(config.maxDriftPpm >= 0 && config.maxDriftPpm < 1_000_000)
  ) {
    throw new RangeError(`invalid Raft config: ${JSON.stringify(config)}`);
  }

  const lastLogIndex = (s: State) => s.persistent.log.length;
  const termAt = (s: State, index: number) =>
    index === 0 ? 0 : (s.persistent.log[index - 1]?.term ?? -1);
  const lastLogTerm = (s: State) => termAt(s, lastLogIndex(s));
  const majority = (ctx: Ctx) => Math.floor((ctx.peers.length + 1) / 2) + 1;

  function freshVolatile(): RaftVolatile {
    return {
      role: "follower",
      leaderId: null,
      votesGranted: [],
      commitIndex: 0,
      lastApplied: 0,
      nextIndex: {},
      matchIndex: {},
      kv: emptyKv(),
      round: 0,
      ackedRound: {},
      pendingReads: [],
      roundSentAt: {},
      leaseUntil: null,
      lastLeaderContact: null,
    };
  }

  /** Rounds are carried only when reads are served outside the log. */
  const rounds = config.readMode !== "log";
  const leases = config.readMode === "lease";
  /**
   * Lease length in the leader's local time. A voter that answered a round ignores
   * RequestVote for electionTimeoutMin of its own time after receiving it: at least
   * min / (1 + e) true ms. The leader's lease, measured from sending that round on a clock
   * at least (1 - e) fast, lasts at most leaseMs / (1 - e) true ms, so it must be at most
   * min * (1 - e) / (1 + e) local ms.
   */
  const drift = config.maxDriftPpm / 1_000_000;
  const leaseMs = (config.electionTimeoutMinMs * (1 - drift)) / (1 + drift);

  function resetElectionTimer(ctx: Ctx): void {
    ctx.setTimer(
      ELECTION_TIMER,
      ctx.rng.int(config.electionTimeoutMinMs, config.electionTimeoutMaxMs),
    );
  }

  function becomeFollower(s: State): void {
    s.volatile.role = "follower";
    s.volatile.votesGranted = [];
    s.volatile.nextIndex = {};
    s.volatile.matchIndex = {};
    // Unanswered reads are dropped; their clients time out and retry elsewhere.
    s.volatile.pendingReads = [];
    s.volatile.round = 0;
    s.volatile.ackedRound = {};
    s.volatile.roundSentAt = {};
    s.volatile.leaseUntil = null;
  }

  /** Lease mode: may this server consider a candidate's RequestVote yet? */
  function mayVote(ctx: Ctx, s: State): boolean {
    const contact = s.volatile.lastLeaderContact;
    if (!leases || contact === null) return true;
    if (s.volatile.role === "leader") return false;
    return ctx.localNow - contact >= config.electionTimeoutMinMs;
  }

  // ---------------------------------------------------------------------------------------
  // Terms and elections (§5.1, §5.2, §5.4.1)

  /** Any RPC with a newer term makes this node a follower in that term. */
  function observeTerm(ctx: Ctx, s: State, term: number): void {
    if (term <= s.persistent.currentTerm) return;
    const wasLeader = s.volatile.role === "leader";
    s.persistent.currentTerm = term;
    s.persistent.votedFor = null;
    s.volatile.leaderId = null;
    becomeFollower(s);
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
    const v = s.volatile;
    if (v.role !== "candidate" || v.votesGranted.length < majority(ctx)) return;
    v.role = "leader";
    v.leaderId = ctx.nodeId;
    v.nextIndex = {};
    v.matchIndex = {};
    // A no-op in the new term lets earlier-term entries commit without waiting for a client.
    s.persistent.log.push({ term: s.persistent.currentTerm, command: { kind: "noop" } });
    for (const p of ctx.peers) {
      v.nextIndex[p] = lastLogIndex(s);
      v.matchIndex[p] = 0;
    }
    ctx.cancelTimer(ELECTION_TIMER);
    ctx.annotate("becameLeader", { term: s.persistent.currentTerm });
    advanceCommit(ctx, s); // a single-node cluster commits immediately
    broadcastAppend(ctx, s);
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
      resetElectionTimer(ctx);
    }
    const response: RequestVoteResponse = {
      type: "RequestVoteResponse",
      term: p.currentTerm,
      voteGranted: grant,
    };
    ctx.send(from, response);
  }

  function onRequestVoteResponse(ctx: Ctx, s: State, from: NodeId, m: RequestVoteResponse): void {
    const v = s.volatile;
    if (
      m.voteGranted &&
      m.term === s.persistent.currentTerm &&
      v.role === "candidate" &&
      !v.votesGranted.includes(from)
    ) {
      v.votesGranted.push(from);
      maybeWin(ctx, s);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Replication (§5.3)

  function sendAppend(ctx: Ctx, s: State, peer: NodeId): void {
    const next = s.volatile.nextIndex[peer] ?? lastLogIndex(s) + 1;
    const prevLogIndex = next - 1;
    const request: AppendEntries = {
      type: "AppendEntries",
      term: s.persistent.currentTerm,
      leaderId: ctx.nodeId,
      prevLogIndex,
      prevLogTerm: termAt(s, prevLogIndex),
      entries: s.persistent.log.slice(prevLogIndex, prevLogIndex + config.maxEntriesPerAppend),
      leaderCommit: s.volatile.commitIndex,
      ...(rounds ? { round: s.volatile.round } : {}),
    };
    ctx.send(peer, request);
  }

  /** Sends to every follower (doubles as the heartbeat) and re-arms the heartbeat timer. */
  function broadcastAppend(ctx: Ctx, s: State): void {
    if (rounds) s.volatile.round++;
    if (leases) {
      s.volatile.roundSentAt[s.volatile.round] = ctx.localNow;
      s.volatile.lastLeaderContact = ctx.localNow;
    }
    for (const p of ctx.peers) sendAppend(ctx, s, p);
    ctx.setTimer(HEARTBEAT_TIMER, config.heartbeatIntervalMs);
  }

  function onAppendEntries(ctx: Ctx, s: State, from: NodeId, m: AppendEntries): void {
    const p = s.persistent;
    const v = s.volatile;
    const reject = (conflictIndex: number, conflictTerm: number | null) => {
      const response: AppendEntriesResponse = {
        type: "AppendEntriesResponse",
        term: p.currentTerm,
        success: false,
        conflictIndex,
        conflictTerm,
        ...(m.round === undefined ? {} : { round: m.round }),
      };
      ctx.send(from, response);
    };
    if (m.term < p.currentTerm) {
      reject(0, null);
      return;
    }
    // m.term === currentTerm (observeTerm ran first): m.leaderId leads this term.
    becomeFollower(s);
    v.leaderId = m.leaderId;
    if (leases) v.lastLeaderContact = ctx.localNow;
    resetElectionTimer(ctx);

    // Consistency check: our log must contain an entry at prevLogIndex with prevLogTerm.
    if (m.prevLogIndex > lastLogIndex(s)) {
      reject(lastLogIndex(s) + 1, null);
      return;
    }
    const prevTerm = termAt(s, m.prevLogIndex);
    if (prevTerm !== m.prevLogTerm) {
      let first = m.prevLogIndex;
      while (first > 1 && termAt(s, first - 1) === prevTerm) first--;
      reject(first, prevTerm);
      return;
    }

    // Append, truncating only at the first real conflict. A stale or reordered request
    // whose entries we already have must not cut off entries that follow them.
    if (bugs.truncateAlways === true && m.entries.length > 0) p.log.length = m.prevLogIndex;
    m.entries.forEach((entry, i) => {
      const index = m.prevLogIndex + 1 + i;
      if (index <= lastLogIndex(s)) {
        if (termAt(s, index) === entry.term) return;
        p.log.length = index - 1;
      }
      p.log.push(entry);
    });

    // Only entries known to match the leader may be marked committed. A stale request can
    // carry a smaller lastNew than what we already committed; never move backwards.
    const lastNew = m.prevLogIndex + m.entries.length;
    v.commitIndex = Math.max(
      v.commitIndex,
      bugs.trustReceivedEntries === true ? lastNew : Math.min(m.leaderCommit, lastNew),
    );
    applyCommitted(ctx, s);
    const response: AppendEntriesResponse = {
      type: "AppendEntriesResponse",
      term: p.currentTerm,
      success: true,
      matchIndex: lastNew,
      ...(m.round === undefined ? {} : { round: m.round }),
    };
    ctx.send(from, response);
  }

  function onAppendEntriesResponse(
    ctx: Ctx,
    s: State,
    from: NodeId,
    m: AppendEntriesResponse,
  ): void {
    const v = s.volatile;
    if (v.role !== "leader" || m.term !== s.persistent.currentTerm) return;
    // Any answer in our term, accepted or not, shows the follower still recognizes us.
    if (m.round !== undefined && m.round > (v.ackedRound[from] ?? 0)) {
      v.ackedRound[from] = m.round;
      if (leases) extendLease(ctx, s);
      serveReads(ctx, s);
    }
    const match = v.matchIndex[from] ?? 0;
    // Follow-up sends happen only when a response makes progress. Duplicated or stale
    // responses must not trigger sends: each would yield more responses, and with message
    // duplication the traffic grows without bound. Heartbeats cover retransmission.
    if (m.success) {
      if (m.matchIndex <= match) return;
      v.matchIndex[from] = m.matchIndex;
      v.nextIndex[from] = Math.max(v.nextIndex[from] ?? 1, m.matchIndex + 1);
      advanceCommit(ctx, s);
      if (v.nextIndex[from]! <= lastLogIndex(s)) sendAppend(ctx, s, from);
      return;
    }
    if (m.conflictIndex === 0) return; // stale-term rejection; ignore
    const current = v.nextIndex[from] ?? lastLogIndex(s) + 1;
    let next: number;
    if (!config.fastBackoff) {
      next = current - 1;
    } else if (m.conflictTerm === null) {
      next = m.conflictIndex;
    } else {
      // If we have entries from the conflicting term, resume after our last one of them.
      let last = 0;
      for (let i = lastLogIndex(s); i >= 1; i--) {
        if (termAt(s, i) === m.conflictTerm) {
          last = i;
          break;
        }
      }
      next = last > 0 ? last + 1 : m.conflictIndex;
    }
    // Never go below what the follower has already confirmed, and never move forward on a
    // rejection (it may be a late reply to an older request).
    const updated = Math.max(match + 1, Math.min(current, next));
    if (updated === current) return;
    v.nextIndex[from] = updated;
    sendAppend(ctx, s, from);
  }

  /**
   * §5.3/§5.4.2: commit the highest index stored on a majority, but only if that entry is
   * from the current term; earlier entries then commit indirectly (Figure 8).
   */
  function advanceCommit(ctx: Ctx, s: State): void {
    const v = s.volatile;
    for (let n = lastLogIndex(s); n > v.commitIndex; n--) {
      if (termAt(s, n) !== s.persistent.currentTerm && bugs.commitOldTerms !== true) break;
      const replicas = 1 + ctx.peers.filter((peer) => (v.matchIndex[peer] ?? 0) >= n).length;
      if (replicas >= majority(ctx)) {
        v.commitIndex = n;
        break;
      }
    }
    applyCommitted(ctx, s);
    if (v.role === "leader") startParkedReads(ctx, s);
  }

  // ---------------------------------------------------------------------------------------
  // Reads outside the log (thesis §6.4)

  /** True once this leader has committed an entry from its own term. */
  const committedInTerm = (s: State) =>
    termAt(s, s.volatile.commitIndex) === s.persistent.currentTerm;

  /** Highest round a majority (this leader included) has answered. */
  function confirmedRound(ctx: Ctx, s: State): number {
    const v = s.volatile;
    const acked = [v.round, ...ctx.peers.map((p) => v.ackedRound[p] ?? 0)].sort((a, b) => b - a);
    return acked[majority(ctx) - 1]!;
  }

  /** A majority answered a round: the lease runs from when that round was sent. */
  function extendLease(ctx: Ctx, s: State): void {
    const v = s.volatile;
    const round = confirmedRound(ctx, s);
    const sentAt = v.roundSentAt[round];
    if (sentAt !== undefined) v.leaseUntil = Math.max(v.leaseUntil ?? 0, sentAt + leaseMs);
    v.roundSentAt = Object.fromEntries(
      Object.entries(v.roundSentAt).filter(([r]) => Number(r) > round),
    );
  }

  const leaseValid = (ctx: Ctx, s: State) =>
    leases && s.volatile.leaseUntil !== null && ctx.localNow < s.volatile.leaseUntil;

  /** Accepts a read: fixes its read index now if possible, else parks it until then. */
  function acceptRead(ctx: Ctx, s: State, m: ClientRequest<KvOp>): void {
    s.volatile.pendingReads.push({
      clientId: m.clientId,
      seq: m.seq,
      op: m.op,
      readIndex: null,
      round: null,
    });
    startParkedReads(ctx, s);
  }

  /**
   * Gives parked reads a read index (the current commit index) and a heartbeat round that
   * starts now, after it was fixed: a majority answering that round proves no other leader
   * had committed anything newer when the index was taken.
   */
  function startParkedReads(ctx: Ctx, s: State): void {
    const v = s.volatile;
    const parked = v.pendingReads.filter((r) => r.readIndex === null);
    if (parked.length === 0 || !committedInTerm(s)) return;
    // With a valid lease no other leader can have committed anything: no round needed.
    const lease = leaseValid(ctx, s);
    if (!lease) broadcastAppend(ctx, s);
    for (const r of parked) {
      r.readIndex = v.commitIndex;
      r.round = lease ? null : v.round;
    }
    serveReads(ctx, s); // a single-node cluster needs no round
  }

  /** Answers every read whose round a majority has answered and whose index is applied. */
  function serveReads(ctx: Ctx, s: State): void {
    const v = s.volatile;
    if (v.role !== "leader" || v.pendingReads.length === 0) return;
    const lease = leaseValid(ctx, s);
    const confirmed = confirmedRound(ctx, s);
    let renewing = false;
    v.pendingReads = v.pendingReads.filter((r) => {
      if (r.readIndex === null || v.lastApplied < r.readIndex) return true;
      // A lease read that outlived its lease is served once a round confirms leadership.
      const byLease = lease && r.round === null;
      if (!byLease) {
        if (r.round === null) {
          // One round serves every read that outlived the lease in this pass.
          if (!renewing) broadcastAppend(ctx, s);
          renewing = true;
          r.round = v.round;
        }
        if (confirmed < r.round) return true;
      }
      ctx.annotate("readServed", {
        client: r.clientId,
        seq: r.seq,
        readIndex: r.readIndex,
        ...(leases ? { by: byLease ? "lease" : "round" } : {}),
      });
      reply(ctx, r.clientId, r.seq, executeKv(v.kv.data, r.op));
      return false;
    });
  }

  // ---------------------------------------------------------------------------------------
  // State machine and clients

  function applyCommitted(ctx: Ctx, s: State): void {
    const v = s.volatile;
    while (v.lastApplied < v.commitIndex) {
      v.lastApplied++;
      const entry: RaftLogEntry = s.persistent.log[v.lastApplied - 1]!;
      if (entry.command.kind !== "client") continue;
      const { clientId, seq, op } = entry.command;
      const result =
        bugs.noSessions === true
          ? executeKv(v.kv.data, op)
          : applyClientCommand(v.kv, clientId, seq, op);
      // Only the leader answers; any leader that applies an entry can, even one appended
      // by a predecessor, since the client matches replies by seq.
      if (result !== null && v.role === "leader") reply(ctx, clientId, seq, result);
    }
    serveReads(ctx, s);
  }

  function reply(ctx: Ctx, clientId: NodeId, seq: number, result: KvResult): void {
    const message: ClientReply<KvResult> = { type: "ClientReply", seq, status: "ok", result };
    ctx.send(clientId, message);
  }

  function onClientRequest(ctx: Ctx, s: State, from: NodeId, m: ClientRequest<KvOp>): void {
    const v = s.volatile;
    if (v.role !== "leader") {
      const redirect: ClientReply<KvResult> = {
        type: "ClientReply",
        seq: m.seq,
        status: "notLeader",
        leaderHint: v.leaderId,
      };
      ctx.send(from, redirect);
      return;
    }
    if (m.op.type === "get" && config.readMode !== "log") {
      acceptRead(ctx, s, m);
      return;
    }
    const session = bugs.noSessions === true ? undefined : v.kv.sessions[m.clientId];
    if (session !== undefined && m.seq <= session.seq) {
      // Already applied: answer from the session table instead of re-executing.
      if (m.seq === session.seq) reply(ctx, m.clientId, m.seq, session.result);
      return;
    }
    // A retry of a request that is already in our log but not yet applied: wait for it.
    for (let i = lastLogIndex(s); i > v.lastApplied && bugs.noSessions !== true; i--) {
      const c = s.persistent.log[i - 1]!.command;
      if (c.kind === "client" && c.clientId === m.clientId && c.seq === m.seq) return;
    }
    s.persistent.log.push({
      term: s.persistent.currentTerm,
      command: { kind: "client", clientId: m.clientId, seq: m.seq, op: m.op },
    });
    advanceCommit(ctx, s); // single-node clusters
    for (const p of ctx.peers) sendAppend(ctx, s, p);
  }

  // ---------------------------------------------------------------------------------------

  return {
    name: "raft",

    init(ctx) {
      resetElectionTimer(ctx);
      return {
        persistent: { currentTerm: 0, votedFor: null, log: [] },
        volatile: freshVolatile(),
      };
    },

    recover(ctx, persistent) {
      // commitIndex and the state machine are volatile: they are rebuilt by re-applying the
      // log once a leader tells us what is committed.
      resetElectionTimer(ctx);
      const volatile = freshVolatile();
      // We may have answered a leader's round just before crashing, and no longer know when:
      // wait out a full election timeout before voting, as if we had heard from it now.
      if (leases) volatile.lastLeaderContact = ctx.localNow;
      return { persistent, volatile };
    },

    onTimer(ctx, s, key) {
      if (key === ELECTION_TIMER && s.volatile.role !== "leader") startElection(ctx, s);
      else if (key === HEARTBEAT_TIMER && s.volatile.role === "leader") broadcastAppend(ctx, s);
    },

    onMessage(ctx, s, from, m) {
      if (m.type === "ClientRequest") {
        onClientRequest(ctx, s, from, m);
        return;
      }
      if (m.type === "ClientReply") return;
      // Lease mode: a server that heard from a leader recently ignores candidates entirely,
      // including their term; the leader's lease counts on it.
      if (m.type === "RequestVote" && !mayVote(ctx, s)) {
        ctx.send(from, {
          type: "RequestVoteResponse",
          term: s.persistent.currentTerm,
          voteGranted: false,
        });
        return;
      }
      observeTerm(ctx, s, m.term);
      switch (m.type) {
        case "RequestVote":
          onRequestVote(ctx, s, from, m);
          return;
        case "RequestVoteResponse":
          onRequestVoteResponse(ctx, s, from, m);
          return;
        case "AppendEntries":
          onAppendEntries(ctx, s, from, m);
          return;
        case "AppendEntriesResponse":
          onAppendEntriesResponse(ctx, s, from, m);
          return;
      }
    },

    onClientCommand() {
      // Operations come from client processes over the network, not as direct commands.
    },

    view(s): RaftView {
      return {
        role: s.volatile.role,
        term: s.persistent.currentTerm,
        votedFor: s.persistent.votedFor,
        leaderId: s.volatile.leaderId,
        commitIndex: s.volatile.commitIndex,
        lastApplied: s.volatile.lastApplied,
        log: s.persistent.log,
        data: s.volatile.kv.data,
        sessions: Object.fromEntries(
          Object.entries(s.volatile.kv.sessions).map(([client, session]) => [client, session.seq]),
        ),
        pendingReads: s.volatile.pendingReads.length,
        leaseUntil: s.volatile.leaseUntil,
      };
    },
  };
}
