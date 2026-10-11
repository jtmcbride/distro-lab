import { expect, test } from "@playwright/test";
import { TOURS } from "../src/tutorials/tours.ts";
import { failOnErrors } from "./helpers.ts";

const clock = (ms: number) =>
  `${ms.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ms`;

for (const tour of TOURS) {
  test(`tutorial "${tour.title}" runs end to end`, async ({ page }) => {
    const noErrors = failOnErrors(page);
    await page.goto(`?tour=${tour.id}`);
    const card = page.getByRole("complementary", { name: "Tutorial" });
    for (const [i, step] of tour.steps.entries()) {
      await expect(card.locator("h3")).toHaveText(step.title);
      await expect(card).toContainText(`${i + 1} of ${tour.steps.length}`);
      await expect(page.locator(".clock")).toContainText(clock(step.atMs));
      if (step.panel !== undefined) await expect(page.locator(".panel.tour-focus")).toHaveCount(1);
      await card
        .getByRole("button", { name: i === tour.steps.length - 1 ? "Finish" : "Next" })
        .click();
    }
    await expect(card).toHaveCount(0);
    noErrors();
  });
}

test("tutorials start from the menu, go back, and end when another scenario loads", async ({
  page,
}) => {
  const noErrors = failOnErrors(page);
  await page.goto("");
  await page.getByText("Tutorials").click();
  await page.getByRole("button", { name: /Stale reads and linearizability/ }).click();
  const card = page.getByRole("complementary", { name: "Tutorial" });
  await expect(card.locator("h3")).toHaveText("A leads, x = 1");
  await card.getByRole("button", { name: "Next" }).click();
  await card.getByRole("button", { name: "Next" }).click();
  await card.getByRole("button", { name: "Back" }).click();
  await expect(card.locator("h3")).toHaveText("A partition deposes A, but A doesn't know");
  await expect(page.locator(".clock")).toContainText("430.0 ms");
  await page.selectOption(".scenario-menu select", "sandbox3");
  await expect(card).toHaveCount(0);
  noErrors();
});
