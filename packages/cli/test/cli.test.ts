import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.ts";

function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("sim CLI", () => {
  it("lists protocols including planted bugs", () => {
    const r = cli("list");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^raft /m);
    expect(r.out).toMatch(/raft-bug-double-vote .*PLANTED BUG/);
  });

  it("generates a scenario that runs cleanly and reproduces its trace hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-"));
    const file = join(dir, "s.json");
    writeFileSync(file, cli("gen", "--seed", "4").out);
    const a = cli("run", file);
    const b = cli("run", file);
    expect(a.code).toBe(0);
    expect(a.out).toContain("OK: no violations");
    expect(a.out).toBe(b.out);
  });

  it("finds a planted bug, writes reproducible scenarios, and replays the failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-"));
    const fuzzed = cli("fuzz", "--protocol", "raft-bug-double-vote", "--seeds", "20", "--out", dir);
    expect(fuzzed.code).toBe(1);
    expect(fuzzed.out).toMatch(/SAFETY single-vote-per-term/);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    const minimized = join(
      dir,
      files.find((f) => f.endsWith(".min.json"))!,
    );
    expect(JSON.parse(readFileSync(minimized, "utf8"))).toMatchObject({
      protocol: "raft-bug-double-vote",
    });
    const replay = cli("run", minimized, "--tail", "5");
    expect(replay.code).toBe(1);
    expect(replay.out).toMatch(/FAILED:\n {2}SAFETY single-vote-per-term/);
    // Five trace lines, then the summary.
    expect(
      replay.out
        .split("\n")
        .slice(0, 5)
        .every((l) => /ms #\d+/.test(l)),
    ).toBe(true);
  });

  it("prints and runs the Figure 8 example, showing final state", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-"));
    for (const protocol of ["raft", "raft-bug-commit-old-terms"]) {
      const file = join(dir, `${protocol}.json`);
      writeFileSync(file, cli("example", "figure8", "--protocol", protocol).out);
      const r = cli("run", file, "--state");
      expect(r.out).toMatch(/^E {4}up {3}leader t4 /m);
      expect(r.code).toBe(protocol === "raft" ? 0 : 1);
    }
    expect(cli("example", "nope").code).toBe(2);
  });

  it("exits 0 when fuzzing finds nothing", () => {
    const r = cli("fuzz", "--seeds", "5", "--nodes", "3");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^5 runs, \d+ events .* 0 failing$/);
  });

  it("returns 2 on usage errors", () => {
    expect(cli().code).toBe(2);
    expect(cli("bogus").code).toBe(2);
    expect(cli("run").code).toBe(2);
    expect(cli("fuzz", "--seeds", "x").code).toBe(2);
    expect(cli("fuzz", "--protocol", "nope").code).toBe(2);
    expect(cli("gen", "--wat").code).toBe(2);
  });
});
