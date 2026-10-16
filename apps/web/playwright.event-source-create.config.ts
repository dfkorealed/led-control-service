import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: "event-source-create.spec.ts", workers: 1, retries: 0,
  timeout: 30_000, expect: { timeout: 8_000 },
  outputDir: "../../.local/event-source-create-fix-20261015/web/browser-results",
  use: { baseURL: "http://127.0.0.1:15446", timezoneId: "Asia/Seoul", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "node e2e/support/event-source-create-server.mjs", url: "http://127.0.0.1:15446", reuseExistingServer: false, timeout: 60_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
