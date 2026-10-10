import { defineConfig } from "vitest/config";

export default defineConfig({
  // e2e/ holds Playwright specs, run by `pnpm e2e`.
  test: { include: ["src/**/*.test.ts"] },
});
