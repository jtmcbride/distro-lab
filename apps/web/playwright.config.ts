import { defineConfig, devices } from "@playwright/test";

// Builds with the GitHub Pages base path and serves the production bundle, so the tests
// exercise what gets deployed (worker bundling and base-path asset URLs included).
const PORT = 4310;
const BASE = "/distro-lab/";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: true,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}${BASE}`,
    trace: "retain-on-failure",
    ...(process.env.CHROMIUM_PATH === undefined
      ? {}
      : { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `vite build && vite preview --port ${PORT} --strictPort`,
    env: { BASE_PATH: BASE },
    url: `http://localhost:${PORT}${BASE}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
