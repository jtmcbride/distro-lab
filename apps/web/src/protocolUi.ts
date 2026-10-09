import type { CanonicalValue } from "@distro-lab/core";

export type ServerRole = "leader" | "candidate" | "follower" | "unknown";

export interface ServerBadge {
  readonly role: ServerRole;
  /** Short line under the node id, e.g. "t4". */
  readonly caption: string;
}

/** Visual style for a message, from its `type` field and contents. */
export interface MessageStyle {
  readonly color: string;
  readonly label: string;
  /** Minor traffic (heartbeats) is drawn smaller and paler. */
  readonly minor: boolean;
}

const MESSAGE_COLORS: Record<string, { color: string; label: string }> = {
  RequestVote: { color: "var(--msg-vote)", label: "RequestVote" },
  RequestVoteResponse: { color: "var(--msg-vote)", label: "Vote reply" },
  AppendEntries: { color: "var(--msg-append)", label: "AppendEntries" },
  AppendEntriesResponse: { color: "var(--msg-append)", label: "Append reply" },
  ClientRequest: { color: "var(--msg-client)", label: "Client request" },
  ClientReply: { color: "var(--msg-client)", label: "Client reply" },
};

export const MESSAGE_LEGEND = [
  { color: "var(--msg-vote)", label: "Votes" },
  { color: "var(--msg-append)", label: "Replication" },
  { color: "var(--msg-client)", label: "Client" },
];

export function messageStyle(message: CanonicalValue): MessageStyle {
  const m = (message ?? {}) as { type?: string; entries?: unknown[] };
  const known = MESSAGE_COLORS[m.type ?? ""];
  const heartbeat =
    (m.type === "AppendEntries" && Array.isArray(m.entries) && m.entries.length === 0) ||
    m.type === "AppendEntriesResponse";
  return {
    color: known?.color ?? "var(--muted)",
    label: known?.label ?? m.type ?? "message",
    minor: heartbeat,
  };
}

export function serverBadge(view: CanonicalValue): ServerBadge {
  const v = (view ?? {}) as { role?: string; term?: number };
  const role: ServerRole =
    v.role === "leader" || v.role === "candidate" || v.role === "follower" ? v.role : "unknown";
  return { role, caption: v.term === undefined ? "" : `t${v.term}` };
}

/** The timer that drives elections, and its longest possible duration. */
export function electionTimer(config: CanonicalValue | undefined) {
  const c = (config ?? {}) as { electionTimeoutMaxMs?: number };
  return { key: "election", maxMs: c.electionTimeoutMaxMs ?? 300 };
}

export function clientCaption(view: CanonicalValue): string {
  const v = (view ?? {}) as { queued?: number; inFlight?: number | null; completed?: number };
  const pending = (v.queued ?? 0) + (v.inFlight === null || v.inFlight === undefined ? 0 : 1);
  return pending > 0 ? `${pending} pending` : `${v.completed ?? 0} done`;
}
