import { useSim } from "../state/store.ts";
import { dynamoUi } from "./dynamo.tsx";
import { raftUi } from "./raft.tsx";
import type { ProtocolUi } from "./ui.ts";

export type { MessageStyle, ProtocolUi, ServerBadge } from "./ui.ts";
export { clientCaption, Field } from "./common.tsx";

/** The UI for a registry protocol name, planted-bug variants included. */
export function uiFor(protocol: string): ProtocolUi {
  return protocol === "dynamo" || protocol.startsWith("dynamo-") ? dynamoUi : raftUi;
}

/** The UI for the loaded scenario's protocol. */
export function useProtocolUi(): ProtocolUi {
  return uiFor(useSim((s) => s.protocol));
}
