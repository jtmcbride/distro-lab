import { expect, test } from "@playwright/test";
import { failOnErrors, open, seek } from "./helpers.ts";

test("a server's clock rate can be changed and is recorded in the schedule", async ({ page }) => {
  const noErrors = failOnErrors(page);
  await open(page);
  await seek(page, 500);
  await page.locator(".node.server", { has: page.getByText("B", { exact: true }) }).click();
  const inspector = page.locator(".panel.inspector");
  await expect(inspector).toContainText("runs at 1×");
  await inspector.getByLabel("Clock rate of B").fill("0.5");
  await inspector.getByRole("button", { name: "Set" }).click();
  await expect(inspector).toContainText("runs at 0.5×");
  await page.getByRole("tab", { name: "Schedule" }).click();
  await expect(page.locator(".schedule-list")).toContainText("B's clock runs at 0.5×");
  noErrors();
});

test("the lease example shows the leader's slow clock and its lease", async ({ page }) => {
  const noErrors = failOnErrors(page);
  await open(page);
  await page.selectOption(".scenario-menu select", "lease-drift");
  await seek(page, 540);
  await page.locator(".node.server", { has: page.getByText("A", { exact: true }) }).click();
  const inspector = page.locator(".panel.inspector");
  await expect(inspector).toContainText("runs at 0.2×");
  await expect(inspector).toContainText("assumes clocks within 5%");
  await expect(inspector).toContainText(/ms left on its clock/);
  if (process.env.SCREENSHOT !== undefined)
    await page.locator(".panel.inspector").screenshot({ path: process.env.SCREENSHOT });
  noErrors();
});
