import { describe, expect, it } from "vitest";
import { defaultRegistry, SimulationHost } from "@distro-lab/core";
import { sandbox } from "../scenarios.ts";
import { causalChain, chainSends } from "./causes.ts";
import { applyFrame } from "./store.ts";
import { trace } from "./trace.ts";

describe("causalChain", () => {
  it("explains a leader election: timeout → RequestVote → granted vote → leader", () => {
    const host = new SimulationHost(defaultRegistry(), sandbox());
    host.advanceTo(1000);
    applyFrame(host.frame());
    const leader = trace.find((r) => r.type === "annotate" && r.label === "becameLeader")!;
    const chain = causalChain(leader.id);
    const describe = chain.map((r) => {
      if (r.type === "send" || r.type === "deliver") {
        const m = r.type === "send" ? r.message : null;
        return `${r.type}:${r.from}>${r.to}${m === null ? "" : `:${(m as { type: string }).type}`}`;
      }
      return r.type === "annotate"
        ? `annotate:${r.label}`
        : r.type === "timer"
          ? `timer:${r.key}`
          : r.type;
    });
    const node = (leader as { node: string }).node;
    // Newest first: the leader's own annotation, the deciding vote, back to its timeout.
    expect(describe[0]).toBe("annotate:becameLeader");
    expect(describe[1]).toMatch(new RegExp(`^deliver:\\w+>${node}$`));
    expect(describe[2]).toMatch(new RegExp(`^send:\\w+>${node}:RequestVoteResponse$`));
    expect(describe[3]).toMatch(new RegExp(`^deliver:${node}>\\w+$`));
    expect(describe[4]).toMatch(new RegExp(`^send:${node}>\\w+:RequestVote$`));
    expect(describe[5]).toBe("timer:election");
    expect(chain.at(-1)!.cause).toBeNull();
    // Arrows to highlight: the vote request and the vote reply.
    expect(chainSends(leader.id).size).toBe(2);
  });
});
