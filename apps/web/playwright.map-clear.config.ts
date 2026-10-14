import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["map-clear.spec.ts", "cad-import-journey.spec.ts"],
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: "/tmp/map-clear-r3-chromium-results",
  use: { baseURL: "http://127.0.0.1:15211", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    // Dependencies and shared outputs are prebuilt by the owning roles.
    command: "DEV_LOCAL_APP_ONLY=0 VITE_API_PROXY_TARGET=http://127.0.0.1:1 VITE_TEST_DATA_TOOLS_ENABLED=false node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 15211 --strictPort",
    url: "http://127.0.0.1:15211",
    reuseExistingServer: false,
    timeout: 60_000
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], deviceScaleFactor: 2 } }]
});
