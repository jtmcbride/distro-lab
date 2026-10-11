import { expect, test } from "@playwright/test";
import { failOnErrors, open, seek } from "./helpers.ts";

test("the stale-read example shows the failing read and the write it missed", async ({ page }) => {
  const noErrors = failOnErrors(page);
  await open(page);
  await page.selectOption(".scenario-menu select", "stale-read-bug");
  await seek(page, 2000);
  await expect(page.locator(".violations")).toContainText("linearizable");
  const panel = page.locator(".history-panel");
  await expect(panel.getByLabel("Key to show")).toHaveValue("x");
  const failing = panel.locator(".history-op.failing");
  await expect(failing).toHaveText("get x → ok → 1");
  // c1's write of 2 completed before the read started.
  await expect(panel.locator(".history-op.before", { hasText: "put x = 2" })).toHaveCount(1);
  await failing.click();
  await expect(panel.locator(".history-detail")).toContainText('could only have returned "2"');
  if (process.env.SCREENSHOT !== undefined)
    await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true });
  noErrors();
});

test("correct Raft answers the same read with the latest value after the heal", async ({
  page,
}) => {
  const noErrors = failOnErrors(page);
  await open(page);
  await page.selectOption(".scenario-menu select", "stale-read");
  await seek(page, 4000);
  const panel = page.locator(".history-panel");
  await expect(panel.locator(".history-op", { hasText: "get x" })).toHaveText([
    "get x → ok → 1",
    "get x → ok → 2",
  ]);
  await expect(panel.locator(".history-op.failing")).toHaveCount(0);
  await expect(page.locator(".violations")).toHaveCount(0);
  noErrors();
});
