import type { Protocol } from "../../protocol.ts";
import { dynamo, type PlantedDynamoBugs } from "./dynamo.ts";
import type {
  DynamoConfig,
  DynamoMessage,
  DynamoOp,
  DynamoPersistent,
  DynamoVolatile,
} from "./types.ts";

type DynamoProtocol = Protocol<DynamoPersistent, DynamoVolatile, DynamoMessage, DynamoOp>;

interface BugSpec {
  readonly description: string;
  create(config: Partial<DynamoConfig>): DynamoProtocol;
}

const internal = (description: string, flags: PlantedDynamoBugs): BugSpec => ({
  description,
  create: (config) => dynamo(config, flags),
});

/**
 * Deliberately broken Dynamo variants. They exist to prove that the invariant checker and
 * the chaos runner catch realistic mistakes; never use them for anything else.
 */
export const DYNAMO_BUGS = {
  "reused-counter": internal(
    "Stamps a write with the context's counter for the coordinator plus one (the naive rule), so concurrent writes through one coordinator share a dot.",
    { reuseCounter: true },
  ),
  "volatile-counter": {
    description:
      "Keeps the per-key dot counters in memory: a restarted coordinator stamps new writes with dots it already used.",
    create(config) {
      const base = dynamo(config);
      return {
        ...base,
        recover(ctx, persistent) {
          return base.recover(ctx, { ...persistent, counters: {} });
        },
      };
    },
  },
  "last-writer-wins": internal(
    "Replicas keep a single version: of concurrent siblings, the one with the larger clock wins and the other is discarded.",
    { lastWriterWins: true },
  ),
  "plain-clocks": internal(
    "Compares versions as plain vector clocks, so a write seems to include every earlier write through the same coordinator.",
    { plainClocks: true },
  ),
  "vector-contexts": internal(
    "Reads a write's context as a version vector: having seen a coordinator's write n counts as having seen all its earlier writes.",
    { vectorContexts: true },
  ),
  "early-ack": internal("Acknowledges a put one replica short of W.", { ackEarly: true }),
  "overwriting-repair": internal(
    "Read repair replaces a replica's versions with the get's result instead of merging, losing writes that arrived since.",
    { repairOverwrites: true },
  ),
  "summing-counters": internal(
    "Joins counters by adding their entries instead of taking the maximum, so a redelivered update counts twice.",
    { sumCounters: true },
  ),
  "remove-all-tags": internal(
    "A set remove that observed any of an element's tags deletes all of them, including concurrent adds it never saw.",
    { removeAllTags: true },
  ),
} satisfies Record<string, BugSpec>;

export type DynamoBug = keyof typeof DYNAMO_BUGS;
