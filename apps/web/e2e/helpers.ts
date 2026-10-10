import { expect, type Page } from "@playwright/test";

/** Fails the test on any page error or console error. */
export function failOnErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return () => expect(errors).toEqual([]);
}

export async function open(page: Page, path = ""): Promise<void> {
  await page.goto(path);
  await expect(page.locator(".node.server").first()).toBeVisible();
}

export async function setSpeed(page: Page, speed: string): Promise<void> {
  await page.selectOption(".speed select", speed);
}

export async function play(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Play/ }).click();
}

export async function pause(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Pause/ }).click();
}

/** Seeks the simulation to `ms` via the scrubber. */
export async function seek(page: Page, ms: number): Promise<void> {
  await page.locator(".scrubber").evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }, ms);
  await expect(page.locator(".clock")).toContainText(`${ms.toLocaleString("en-US")}.0 ms`);
}

export async function leaderId(page: Page): Promise<string> {
  return (await page.locator(".node.role-leader .node-id").textContent())!.trim();
}
