import { defineConfig, devices } from "@playwright/test";
const port = Number(process.env.LANDING_PORT ?? "15185");
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./e2e", testMatch: "static-landing.spec.ts", workers: 1,
  use: { ...devices["Desktop Chrome"], baseURL, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "pnpm preview:landing", url: baseURL, reuseExistingServer: false, timeout: 30_000 }
});
