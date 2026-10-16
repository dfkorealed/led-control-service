import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["design-system-{foundation,roles,coverage,security}.spec.ts", "ui-eight-layout-regressions.spec.ts", "account-security.spec.ts", "calm-operations-auth-operator.spec.ts"],
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: { baseURL: "http://127.0.0.1:15341", serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm --filter @led-control/web exec vite --host 127.0.0.1 --port 15341 --strictPort",
    url: "http://127.0.0.1:15341",
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
