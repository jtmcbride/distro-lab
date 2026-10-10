import { expect, test } from "@playwright/test";
import { failOnErrors, leaderId, open, pause, play, seek, setSpeed } from "./helpers.ts";

test("elects a leader, and re-elects after the leader crashes", async ({ page }) => {
  const noErrors = failOnErrors(page);
  await open(page);
  await setSpeed(page, "1");
  await play(page);
  await expect(page.locator(".node.role-leader")).toHaveCount(1);
  await pause(page);
  const first = await leaderId(page);

  await page.locator(".node.role-leader").click();
  await page.locator(".cluster-toolbar").getByRole("button", { name: "Crash" }).click();
  await play(page);
  await expect(page.locator(".node.role-leader .node-id")).not.toHaveText(first, {
    timeout: 15_000,
  });
  await pause(page);
  await expect(page.locator(".node.down .node-id")).toHaveText(first);
  await expect(page.locator(".event-row", { hasText: "becameLeader" })).toHaveCount(2);
  noErrors();
});

test("Figure 8 with the commit bug shows the lost write", async ({ page }) => {
  const noErrors = failOnErrors(page);
  await open(page);
  await page.selectOption(".scenario-menu select", "figure8-bug");
  await seek(page, 700);
  await expect(page.locator(".violations")).toContainText("leader-completeness");
  // Stage (d): A's committed X at index 2 differs from the new leader's entry.
  await expect(page.locator(".log-grid td.conflict")).not.toHaveCount(0);
  await page.getByRole("button", { name: "Jump to first" }).click();
  await expect(page.locator(".event-row.selected")).toHaveCount(1);
  noErrors();
});

test("correct Figure 8 has no violations", async ({ page }) => {
  await open(page);
  await page.selectOption(".scenario-menu select", "figure8");
  await seek(page, 1400);
  await expect(page.locator(".violations")).toHaveCount(0);
});

test("explains why a node became leader", async ({ page }) => {
  await open(page);
  for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Next notable" }).click();
  await page.locator(".event-row", { hasText: "becameLeader" }).first().click();
  const why = page.locator(".why li");
  await expect(why.filter({ hasText: "RequestVoteResponse" })).toHaveCount(1);
  await expect(why.filter({ hasText: '"type":"RequestVote"' })).toHaveCount(1);
  await expect(why.filter({ hasText: "timer" })).toHaveCount(1);
});

test("a share link replays the session, live actions included", async ({ page, context }) => {
  await open(page);
  await page.selectOption(".scenario-menu select", "sandbox3");
  await setSpeed(page, "1");
  await play(page);
  await expect(page.locator(".node.role-leader")).toHaveCount(1);
  await pause(page);
  await page.locator(".node.server").first().click();
  await page.locator(".cluster-toolbar").getByRole("button", { name: "Crash" }).click();
  await page.getByRole("button", { name: "Next notable" }).click();
  await page.getByRole("button", { name: "Share link" }).click();
  await expect(page).toHaveURL(/#s=/);
  const clock = (await page.locator(".clock").textContent())!;
  const ms = Math.floor(Number(clock.split(" ms")[0]!.replace(/,/g, "")));

  const copy = await context.newPage();
  await open(copy, page.url().replace(/^.*\/distro-lab\//, ""));
  await seek(copy, ms);
  await seek(page, ms);
  for (const p of [page, copy]) await expect(p.locator(".node.down")).toHaveCount(1);
  expect(await leaderId(copy)).toBe(await leaderId(page));
});

test("imports a fuzz failure file and opens it at its violation", async ({ page }) => {
  await open(page);
  // A scenario that fails at once: the Figure 8 bug, as a fuzz failure file would be.
  await page.selectOption(".scenario-menu select", "figure8-bug");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  await page.selectOption(".scenario-menu select", "sandbox");
  await page.locator(".scenario-menu input[type=file]").setInputFiles((await download.path())!);
  await expect(page.locator(".violations")).toContainText("leader-completeness");
  await expect(page.locator(".clock")).toContainText("620.0 ms");
  await expect(page.locator(".event-row.selected")).toHaveCount(1);
});

test("plays smoothly at 10x", async ({ page }) => {
  await open(page);
  await setSpeed(page, "10");
  await play(page);
  const fps = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - start < 3000) requestAnimationFrame(tick);
          else resolve(frames / 3);
        };
        requestAnimationFrame(tick);
      }),
  );
  // Lenient: CI machines are noisy. Locally this measures ~60.
  expect(fps).toBeGreaterThan(30);
});

test("fits a phone-width screen without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("steps backwards through events and notable moments", async ({ page }) => {
  const noErrors = failOnErrors(page);
  await open(page);
  for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Next notable" }).click();
  await expect(page.locator(".node.role-leader")).toHaveCount(1);
  const events = async () =>
    Number(
      (await page.locator(".clock .muted").textContent())!
        .match(/([\d,]+) events/)![1]!
        .replace(/,/g, ""),
    );
  const before = await events();
  await page.getByRole("button", { name: "Step back" }).click();
  await expect.poll(events).toBe(before - 1);
  // Back past the election: nobody leads, and the becameLeader row is gone.
  await page.getByRole("button", { name: "Previous notable" }).click();
  await page.getByRole("button", { name: "Previous notable" }).click();
  await expect(page.locator(".node.role-leader")).toHaveCount(0);
  await expect(page.locator(".event-row", { hasText: "becameLeader" })).toHaveCount(0);
  // Keyboard shortcuts are ignored while a button has focus.
  await page.locator(".cluster svg").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator(".node.role-leader")).toHaveCount(1);
  noErrors();
});

test("a what-if branch without a crash avoids the Figure 8 bug", async ({ page }) => {
  const noErrors = failOnErrors(page);
  await open(page);
  await page.selectOption(".scenario-menu select", "figure8-bug");
  await seek(page, 350);
  await page
    .locator(".branches")
    .getByRole("button", { name: /Fork here/ })
    .click();
  await expect(page.locator(".branch-chip.current")).toContainText("@350.0 ms");
  await page.getByRole("tab", { name: "Schedule" }).click();
  await page.getByRole("button", { name: "Remove crash E at 400.0 ms" }).click();
  await seek(page, 1400);
  await expect(page.locator(".violations")).toHaveCount(0);
  // The original branch, at the same moment, still has the violation.
  await page.locator(".branch-chip").first().getByRole("button").first().click();
  await expect(page.locator(".violations")).toContainText("leader-completeness");
  await expect(page.locator(".clock")).toContainText("1,400.0 ms");
  noErrors();
});
