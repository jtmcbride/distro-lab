import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { failOnErrors, open } from "./helpers.ts";

test("minimizes a fuzz failure in the browser to the same result as `sim fuzz`", async ({
  page,
}) => {
  const noErrors = failOnErrors(page);
  // The CLI writes the failing scenario and its minimized version.
  const dir = mkdtempSync(join(tmpdir(), "fuzz-"));
  const cli = join(import.meta.dirname, "../../../packages/cli/src/main.ts");
  try {
    execFileSync(process.execPath, [
      cli,
      "fuzz",
      "--protocol",
      "raft-bug-no-sessions",
      "--first",
      "3",
      "--seeds",
      "1",
      "--out",
      dir,
    ]);
  } catch {
    // Exit code 1: a failure was found, as intended.
  }
  const base = join(dir, "raft-bug-no-sessions-seed3");
  const expected = JSON.parse(readFileSync(`${base}.min.json`, "utf8")) as {
    actions: unknown[];
    network: unknown;
  };

  await open(page);
  await page.locator(".scenario-menu input[type=file]").setInputFiles(`${base}.json`);
  await expect(page.locator(".violations")).toContainText("client-chains");
  await page.locator(".violations").getByRole("button", { name: "Minimize" }).click();
  const card = page.locator(".minimize");
  await expect(card).toContainText("still fail with client-chains", { timeout: 60_000 });
  await expect(page.locator(".branch-chip.current")).toContainText("minimized");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  const exported = JSON.parse(readFileSync((await download.path())!, "utf8")) as typeof expected;
  expect(exported.actions).toEqual(expected.actions);
  expect(exported.network).toEqual(expected.network);
  noErrors();
});
