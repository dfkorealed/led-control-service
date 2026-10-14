import { defineConfig, devices } from "@playwright/test";
const port = 15396;
export default defineConfig({
  testDir: "./e2e", testMatch: "bio-control-operations.spec.ts", workers: 1, retries: 0,
  timeout: 45_000, expect: { timeout: 8_000 },
  outputDir: "../../.superpowers/sdd/2026-10-14-bio-control-operations/task-9-browser-results",
  use: { baseURL: `http://127.0.0.1:${port}`, timezoneId: "Asia/Seoul", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "node e2e/support/bio-control-operations-server.mjs", url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 90_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
