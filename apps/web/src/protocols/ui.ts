import type { CanonicalValue, ProcessState } from "@distro-lab/core";
import type { ComponentType } from "react";

export interface ServerBadge {
  /** Styles the node (`role-<role>` class), e.g. "leader". */
  readonly role: string;
  /** Short line under the node id, e.g. "t4". */
  readonly caption: string;
}

/** Visual style for a message, from its `type` field and contents. */
export interface MessageStyle {
  readonly color: string;
  readonly label: string;
  /** Background traffic (heartbeats, anti-entropy) is drawn smaller and paler. */
  readonly minor: boolean;
}

/**
 * Everything the UI shows differently per protocol. The rest of the app (playback, network
 * tools, timelines, branches, explanations) is protocol independent.
 */
export interface ProtocolUi {
  /** Server roles for the legend, in the order shown. */
  readonly roles: readonly { readonly role: string; readonly label: string }[];
  /** Message colors for the legend. */
  readonly messages: readonly { readonly color: string; readonly label: string }[];
  /** Label of the timeline option that hides minor messages. */
  readonly minorLabel: string;
  serverBadge(view: CanonicalValue): ServerBadge;
  messageStyle(message: CanonicalValue): MessageStyle;
  /** A timer drawn as a ring around each server, if any. */
  ringTimer(config: CanonicalValue | undefined): {
    readonly key: string;
    readonly maxMs: number;
    readonly label: string;
  } | null;
  /** Buttons that fire a selected server's timer now (scenario `timeout` actions). */
  readonly timerButtons: readonly {
    readonly key: string;
    readonly label: string;
    readonly title: string;
  }[];
  /** One-line description of a client operation and of its result. */
  describeOp(op: CanonicalValue): string;
  describeResult(result: CanonicalValue): { readonly text: string; readonly ok: boolean };
  /** The panel showing replicated state across servers (e.g. Raft's logs). */
  readonly dataTitle: string;
  readonly DataPanel: ComponentType;
  /** Inspector content for a selected server. */
  readonly ServerDetail: ComponentType<{ readonly p: ProcessState; readonly now: number }>;
  /** Protocol-specific lines of the cluster summary (inside a definition list). */
  readonly Summary: ComponentType;
  /** Client operation form. */
  readonly ClientForm: ComponentType<{ readonly client: ProcessState }>;
}
