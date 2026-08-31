import { defineConfig, devices } from "@playwright/test";

const realBackendLab = process.env.E2E_REAL_BACKEND_LAB === "1";
const webPort = Number(process.env.E2E_LAB_WEB_PORT ?? 15173);

export default defineConfig({
  testDir: "./e2e",
  workers: realBackendLab ? 1 : undefined,
  timeout: realBackendLab ? 240_000 : 30_000,
  expect: { timeout: realBackendLab ? 15_000 : 5_000 },
  use: {
    actionTimeout: realBackendLab ? 15_000 : 0,
    baseURL: realBackendLab ? `http://127.0.0.1:${webPort}` : "http://localhost:5173",
    trace: realBackendLab ? "off" : "on-first-retry",
    screenshot: realBackendLab ? "off" : "only-on-failure"
  },
  webServer: realBackendLab ? undefined : {
    command: "pnpm --filter @led-control/web dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 120_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
