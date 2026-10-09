import { describe, expect, it } from "vitest";
import { Raft } from "@distro-lab/core";
import { decodeScenario, encodeScenario } from "./share.ts";

describe("share links", () => {
  it("round-trip a scenario through a compact URL-safe string", async () => {
    const s = Raft.figure8Scenario("raft-bug-commit-old-terms");
    const text = await encodeScenario(s);
    expect(text).toMatch(/^[\w-]+$/);
    expect(text.length).toBeLessThan(JSON.stringify(s).length);
    expect(await decodeScenario(text)).toEqual(s);
  });
});
