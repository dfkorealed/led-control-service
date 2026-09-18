import { defineConfig, devices } from "@playwright/test";

const port = 15_175;

export default defineConfig({
  testDir: ".",
  testMatch: "cad-scene-webgl.smoke.ts",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry"
  },
  webServer: {
    command: `VITE_TEST_DATA_TOOLS_ENABLED=false WEB_PORT=${port} pnpm dev`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
