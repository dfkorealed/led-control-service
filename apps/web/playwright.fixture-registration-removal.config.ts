import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: "fixture-registration-removal.spec.ts", workers: 1, retries: 0,
  timeout: 45_000, expect: { timeout: 8_000 },
  outputDir: "./test-results/fixture-registration-removal/browser",
  use: { baseURL: "http://127.0.0.1:15342", timezoneId: "Asia/Seoul", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "node e2e/support/fixture-registration-removal-server.mjs", url: "http://127.0.0.1:15342", reuseExistingServer: false, timeout: 90_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
