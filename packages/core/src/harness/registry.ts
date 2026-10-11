import { dynamoEntries } from "../protocols/dynamo/registry.ts";
import { raftEntries } from "../protocols/raft/registry.ts";
import type { ProtocolEntry } from "./scenario.ts";

/** Every protocol (and planted-bug variant) the harness can run, by name. */
export function defaultRegistry(): ReadonlyMap<string, ProtocolEntry> {
  return new Map([...raftEntries(), ...dynamoEntries()].map((e) => [e.name, e]));
}
