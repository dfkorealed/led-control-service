import { defineConfig, devices } from "@playwright/test";

const realBackendLab = process.env.E2E_REAL_BACKEND_LAB === "1";
const webPort = Number(realBackendLab
  ? process.env.E2E_LAB_WEB_PORT ?? 15173
  : process.env.E2E_WEB_PORT ?? 15174);
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./e2e",
  workers: realBackendLab ? 1 : undefined,
  timeout: realBackendLab ? 240_000 : 30_000,
  expect: { timeout: realBackendLab ? 15_000 : 5_000 },
  use: {
    actionTimeout: realBackendLab ? 15_000 : 0,
    baseURL,
    trace: realBackendLab ? "off" : "on-first-retry",
    screenshot: realBackendLab ? "off" : "only-on-failure"
  },
  webServer: realBackendLab ? undefined : {
    command: `WEB_PORT=${webPort} pnpm --filter @led-control/web dev`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
