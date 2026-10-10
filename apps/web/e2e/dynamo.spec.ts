import { expect, test } from "@playwright/test";
import { failOnErrors, open, pause, play, seek, setSpeed } from "./helpers.ts";

test("concurrent writes show as siblings, then resolve", async ({ page }) => {
  const noErrors = failOnErrors(page);
  await open(page);
  await page.selectOption(".scenario-menu select", "dynamo-concurrent");
  await expect(page.locator(".panel.logs h2")).toHaveText("Replicas");
  await seek(page, 500);
  const row = page.locator(".replica-grid tbody tr", { hasText: "cart" });
  await expect(row.locator(".pill.warn")).toHaveText("siblings");
  for (const cell of await row.locator("td.replica").all()) {
    await expect(cell.locator(".chip")).toHaveText([/^eggs/, /^milk/]);
  }
  await seek(page, 1000);
  await expect(row.locator(".pill.warn")).toHaveCount(0);
  await expect(row.locator("td.replica .chip")).toHaveText([
    /^milk\+eggs/,
    /^milk\+eggs/,
    /^milk\+eggs/,
  ]);
  noErrors();
});

test("a sloppy quorum leaves hints on fallbacks until the partition heals", async ({ page }) => {
  const noErrors = failOnErrors(page);
  await open(page);
  await page.selectOption(".scenario-menu select", "dynamo-sloppy");
  await seek(page, 3000);
  await expect(page.locator(".node.role-hinted")).toHaveCount(2);
  // The real replicas miss the acknowledged write the hints hold.
  await expect(page.locator(".replica-grid td.replica.behind")).toHaveCount(3);
  await page.locator(".node.client", { hasText: "c2" }).click();
  await expect(page.locator(".inspector table.ops")).toContainText("get cart");
  await expect(page.locator(".inspector table.ops")).toContainText("∅");
  await seek(page, 5500);
  await expect(page.locator(".node.role-hinted")).toHaveCount(0);
  // Handoff reached the two replicas the hints stood in for. The example turns anti-entropy
  // and read repair off, so the third stays behind.
  await expect(page.locator(".replica-grid td.replica.behind")).toHaveCount(1);
  await expect(page.locator(".violations")).toHaveCount(0);
  noErrors();
});

test("client tools increment a counter and add to a set", async ({ page }) => {
  const noErrors = failOnErrors(page);
  await open(page);
  await page.selectOption(".scenario-menu select", "dynamo-sandbox");
  const tools = page.locator(".panel.tools");
  await tools.getByLabel("Operation").selectOption("incr");
  await tools.getByLabel("By").fill("3");
  await tools.getByRole("button", { name: "Send from c1" }).click();
  await tools.getByLabel("Operation").selectOption("add");
  await tools.getByLabel("Element").fill("milk");
  await tools.getByRole("button", { name: "Send from c1" }).click();
  await setSpeed(page, "1");
  await play(page);
  await expect(page.locator(".node.client", { hasText: "c1" })).toContainText("2 done");
  await pause(page);
  const grid = page.locator(".replica-grid");
  await expect(
    grid.locator("tr", { hasText: "count:hits" }).locator("td.replica .chip").first(),
  ).toHaveText(/^3/);
  await expect(
    grid.locator("tr", { hasText: "set:cart" }).locator("td.replica .chip").first(),
  ).toHaveText("{milk}");
  noErrors();
});

test("a planted Dynamo bug is caught in the browser", async ({ page }) => {
  await open(page);
  await page.locator(".scenario-menu summary", { hasText: "Generate" }).click();
  await page.locator(".popover-body select").selectOption("dynamo-bug-early-ack");
  await page.locator(".popover-body input[type=number]").fill("0");
  await page.getByRole("button", { name: "Load generated scenario" }).click();
  await seek(page, 3000);
  await expect(page.locator(".violations")).toContainText("acknowledged-writes-durable");
});
