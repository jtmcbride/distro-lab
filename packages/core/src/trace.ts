import { canonicalJson, Hasher, type CanonicalValue } from "./canonical.ts";
import type { NodeId } from "./protocol.ts";

interface Base {
  /** Unique, increasing record id. */
  readonly id: number;
  readonly t: number;
  /** Id of the record that caused this one, or null for scenario actions and init. */
  readonly cause: number | null;
}

export type DropReason = "network" | "link-down" | "node-down";

export type TraceRecord =
  | (Base & { readonly type: "init"; readonly node: NodeId })
  | (Base & {
      readonly type: "send";
      readonly from: NodeId;
      readonly to: NodeId;
      readonly message: CanonicalValue;
      /** Number of copies the network scheduled (0 = dropped at send). */
      readonly copies: number;
    })
  | (Base & {
      readonly type: "deliver";
      readonly from: NodeId;
      readonly to: NodeId;
      /** Id of the originating send record. */
      readonly send: number;
    })
  | (Base & {
      readonly type: "drop";
      readonly from: NodeId;
      readonly to: NodeId;
      readonly send: number;
      readonly reason: DropReason;
    })
  | (Base & { readonly type: "timer"; readonly node: NodeId; readonly key: string })
  | (Base & { readonly type: "crash"; readonly node: NodeId })
  | (Base & { readonly type: "recover"; readonly node: NodeId })
  | (Base & { readonly type: "client"; readonly node: NodeId; readonly command: CanonicalValue })
  | (Base & { readonly type: "network"; readonly change: CanonicalValue })
  | (Base & {
      readonly type: "annotate";
      readonly node: NodeId;
      readonly label: string;
      readonly data?: CanonicalValue;
    });

export type TraceRecordType = TraceRecord["type"];

/** Receives every record the engine emits, in order. */
export type TraceSink = (record: TraceRecord) => void;

/** Fingerprints a trace and optionally keeps it in memory. */
export class TraceRecorder {
  readonly records: TraceRecord[] = [];
  private readonly hasher = new Hasher();
  private count = 0;

  constructor(private readonly keep = true) {}

  readonly sink: TraceSink = (record) => {
    this.hasher.update(canonicalJson(record)).update("\n");
    this.count++;
    if (this.keep) this.records.push(record);
  };

  get size(): number {
    return this.count;
  }

  hash(): string {
    return this.hasher.digest();
  }
}

/** One record per line, human-readable. */
export function formatRecord(r: TraceRecord): string {
  const head = `${String(r.t).padStart(8)}ms #${r.id}${r.cause === null ? "" : ` <-#${r.cause}`}`;
  switch (r.type) {
    case "init":
    case "crash":
    case "recover":
      return `${head} ${r.type} ${r.node}`;
    case "send":
      return `${head} send ${r.from}->${r.to} ${canonicalJson(r.message)}${r.copies === 1 ? "" : ` (copies=${r.copies})`}`;
    case "deliver":
      return `${head} deliver ${r.from}->${r.to} of #${r.send}`;
    case "drop":
      return `${head} drop ${r.from}->${r.to} of #${r.send} (${r.reason})`;
    case "timer":
      return `${head} timer ${r.node}:${r.key}`;
    case "client":
      return `${head} client ${r.node} ${canonicalJson(r.command)}`;
    case "network":
      return `${head} network ${canonicalJson(r.change)}`;
    case "annotate":
      return `${head} ${r.node} ${r.label}${r.data === undefined ? "" : ` ${canonicalJson(r.data)}`}`;
  }
}
