/** A panel a step points at; it is scrolled into view and outlined. */
export type TourPanel =
  "cluster" | "inspector" | "logs" | "tools" | "diagram" | "history" | "timeline";

export interface TourStep {
  readonly title: string;
  /** Paragraphs. */
  readonly body: readonly string[];
  /** The simulation is moved to this moment when the step opens. */
  readonly atMs: number;
  readonly panel?: TourPanel;
  /** Process selected in the inspector. */
  readonly select?: string;
}

export interface Tour {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** Id of the example in the scenario menu that the tour runs. */
  readonly scenario: string;
  readonly steps: readonly TourStep[];
}

/**
 * Guided tours over the examples. Every claim a step makes about the run at its moment is
 * checked against a fresh simulation in `tours.test.ts`, so edits to protocols or examples
 * that would make a tour wrong fail the build.
 */
export const TOURS: readonly Tour[] = [
  {
    id: "election",
    title: "Raft leader election",
    summary: "Randomized timeouts, votes, and how a leader holds its term.",
    scenario: "sandbox",
    steps: [
      {
        title: "Five followers",
        body: [
          "Every server starts as a follower in term 0. The ring around each one is its election timeout: if it hears nothing from a leader before the ring runs out, it starts an election.",
          "Timeouts are drawn at random, so one server usually fires well before the others.",
        ],
        atMs: 0,
        panel: "cluster",
      },
      {
        title: "E times out first",
        body: [
          "E's timer fired at 165 ms. It moved to term 1, voted for itself, and sent RequestVote to the other four.",
          "Each server grants at most one vote per term, and only to a candidate whose log is at least as up to date as its own.",
        ],
        atMs: 166,
        panel: "diagram",
        select: "E",
      },
      {
        title: "A majority makes a leader",
        body: [
          "With votes from a majority (3 of 5, itself included), E became leader of term 1. Two leaders in one term would need two majorities, and any two majorities share a server, which votes once.",
          "A new leader appends a no-op entry for its term right away, so it can commit everything before it.",
        ],
        atMs: 190,
        panel: "logs",
        select: "E",
      },
      {
        title: "Heartbeats hold the term",
        body: [
          "E sends AppendEntries every 50 ms, even with nothing to replicate. Each one resets the followers' timers, so nobody else starts an election while E is reachable.",
          "Try it: select E, press Crash in the cluster panel, then Play. Another server times out and wins term 2. Recover E and it rejoins as a follower, because it sees a higher term.",
        ],
        atMs: 1000,
        panel: "cluster",
        select: "E",
      },
    ],
  },
  {
    id: "figure8",
    title: "Figure 8: why old entries are not committed by counting",
    summary: "The Raft paper's subtlest case, with the bug that ignores it.",
    scenario: "figure8-bug",
    steps: [
      {
        title: "(a) A write reaches two servers",
        body: [
          "A leads term 1. Links from A to C, D and E are cut, so the client's write X reaches only A and B. It is stored on 2 of 5 servers and not committed.",
        ],
        atMs: 200,
        panel: "logs",
      },
      {
        title: "(b) E leads term 2, alone",
        body: [
          "A crashed. E won term 2 with votes from C and D (their logs are no longer than E's), but E's links are cut before its no-op reaches anyone, and E crashes at 400 ms.",
        ],
        atMs: 330,
        panel: "cluster",
      },
      {
        title: "(c) X reaches a majority",
        body: [
          "A restarted and won term 3. It copied X (from term 1) to C, so X is now on A, B and C: a majority.",
          "This variant commits any entry stored on a majority, so A committed X and acknowledged it to the client. Correct Raft would not: it commits by counting only entries from the leader's current term.",
        ],
        atMs: 535,
        panel: "logs",
        select: "A",
      },
      {
        title: "(d) The committed entry is overwritten",
        body: [
          "A crashed again before its term-3 no-op spread. E restarted and won term 4: its last entry (term 2) is newer than C's and D's (term 1), so they voted for it. E now overwrites index 2 on every follower with its own entry.",
          "X was committed and acknowledged, and it is gone: the leader-completeness check reports it. Load “Figure 8 (correct Raft)” from the scenario menu to see A hold off in step (c).",
        ],
        atMs: 620,
        panel: "logs",
        select: "E",
      },
    ],
  },
  {
    id: "stale-read",
    title: "Stale reads and linearizability",
    summary: "A deposed leader answers a read, and the history checker catches it.",
    scenario: "stale-read-bug",
    steps: [
      {
        title: "A leads, x = 1",
        body: [
          "A leads term 1. Client c1 wrote x = 1, and c2 read it back through A. The client history panel shows each operation as a bar from the moment it was invoked to the moment its reply arrived.",
        ],
        atMs: 250,
        panel: "history",
      },
      {
        title: "A partition deposes A, but A doesn't know",
        body: [
          "At 400 ms a partition leaves A alone with c2. The other four elected B leader of term 2. A never heard about term 2, so it still believes it leads term 1.",
        ],
        atMs: 430,
        panel: "cluster",
        select: "A",
      },
      {
        title: "c1 writes x = 2 through B",
        body: [
          "c1's put first went to A, timed out, was retried, redirected to B, and committed in term 2. Its reply means x = 2 is durable and visible to every later read.",
        ],
        atMs: 960,
        panel: "history",
      },
      {
        title: "A answers a read with 1",
        body: [
          "c2 asked A for x. This variant lets a leader answer reads from its own state without checking that it still leads, so A replied 1.",
          "The history shows the problem without looking inside any server: c1's put of 2 completed before c2's get started, so in every order consistent with real time the get comes after the put and must return 2. The read is not linearizable. Click the red bar for details.",
        ],
        atMs: 1520,
        panel: "history",
      },
      {
        title: "What correct Raft does",
        body: [
          "Correct Raft puts reads in the log too. A cannot commit c2's read without a majority, so the read waits, is retried after the partition heals at 3000 ms, and returns 2 through B.",
          "Real systems avoid the log write with ReadIndex (confirm leadership with a heartbeat round first) or leader leases. Load “Stale read from a deposed leader (correct Raft)” to compare.",
        ],
        atMs: 1520,
        panel: "history",
      },
    ],
  },
  {
    id: "siblings",
    title: "Dynamo: concurrent writes become siblings",
    summary: "Version vectors keep both writes until a client merges them.",
    scenario: "dynamo-concurrent",
    steps: [
      {
        title: "Two writes, neither aware of the other",
        body: [
          "c1 put cart = milk and c2 put cart = eggs at the same moment, through different coordinators. Neither write's context includes the other, so neither replaces the other.",
          "Each replica keeps both values as siblings.",
        ],
        atMs: 300,
        panel: "logs",
      },
      {
        title: "A read returns both",
        body: [
          "c1's get returned both siblings together with a context: the exact set of writes it has now seen. Dynamo leaves the merge to the application.",
        ],
        atMs: 450,
        panel: "history",
      },
      {
        title: "A write with that context replaces both",
        body: [
          "c1 put milk+eggs with the context of its read. Every replica drops the versions that context covers, and both siblings resolve into one value.",
          "Keys named count:… and set:… use CRDTs instead, which merge siblings automatically.",
        ],
        atMs: 1000,
        panel: "logs",
      },
    ],
  },
  {
    id: "sloppy-quorum",
    title: "Dynamo: sloppy quorums and hinted handoff",
    summary: "Staying writable through a partition, and what that costs readers.",
    scenario: "dynamo-sloppy",
    steps: [
      {
        title: "The key's replicas are out of reach",
        body: [
          "The key cart lives on B, C and D (N = 3). A partition puts c1 with A and E, the next servers on the ring, and c2 with the three replicas.",
        ],
        atMs: 10,
        panel: "cluster",
      },
      {
        title: "The write lands on fallbacks",
        body: [
          "c1's put found no replica answering. Its coordinator, E, fell back to the next servers on the ring: it stored the write itself and on A, each with a hint naming the replica it stands in for. With W = 2 stores the put was acknowledged.",
        ],
        atMs: 900,
        panel: "logs",
      },
      {
        title: "An acknowledged write that a read misses",
        body: [
          "c2's get asked the real replicas, which never saw the write, and returned nothing. R + W > N would normally guarantee overlap, but a sloppy quorum's W servers need not be the key's replicas.",
          "That is the trade: writes stay available during the partition, and reads can miss acknowledged writes. No check fires because this configuration does not promise otherwise.",
        ],
        atMs: 2300,
        panel: "history",
      },
      {
        title: "Hinted handoff",
        body: [
          "The partition healed at 4000 ms. E handed its hinted copy to C and A handed its copy to B, and both dropped their hints. c2's next read returns milk.",
          "Load “Dynamo: strict quorum, unavailable” to see the other choice: the put is refused until the partition heals.",
        ],
        atMs: 5100,
        panel: "logs",
      },
    ],
  },
];
