import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_WEB_PORT ?? 15283);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "cad-import-journey.spec.ts",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  outputDir: "../../.local/cad-preview-parity-20261013/browser-results",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    // Route fixtures own every API request. No real API, shared build or user browser is used.
    command: `DEV_LOCAL_APP_ONLY=0 VITE_API_PROXY_TARGET=http://127.0.0.1:1 VITE_TEST_DATA_TOOLS_ENABLED=false WEB_PORT=${port} pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], deviceScaleFactor: 2 } }]
});
