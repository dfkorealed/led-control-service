import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PUBLIC_PORT ?? "53988");
export default defineConfig({
  testDir: "./e2e", testMatch: "public-mobile-polish.spec.ts", workers: 1, retries: 0,
  reporter: [["list"], ["json", { outputFile: ".local/public-mobile-polish-browser.json" }]],
  use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}`, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "pnpm preview:public", url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30_000 }
});
