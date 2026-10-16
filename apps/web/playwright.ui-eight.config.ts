import { defineConfig, devices } from "@playwright/test";

// This suite owns one isolated Vite listener. Every browser context installs a
// fail-closed API boundary before the in-memory domain fixture.
export default defineConfig({
  testDir: "./e2e", testMatch: process.env.E2E_UI_EIGHT_FUNCTIONAL === "1"
    ? ["calm-operations-manual-control.spec.ts", "control-map-target-selection.spec.ts", "settings-floor-editor.spec.ts", "settings-mobile-lifecycle.spec.ts", "site-user-management.spec.ts"]
    : "ui-eight-layout-regressions.spec.ts", workers: 1,
  timeout: 30_000,
  outputDir: `../../.local/ui-eight-fixes-20261015/browser-${process.env.E2E_EVIDENCE_PHASE ?? "final"}`,
  use: { baseURL: "http://127.0.0.1:15331", screenshot: "only-on-failure", actionTimeout: 5_000 },
  webServer: {
    command: "WEB_PORT=15331 pnpm exec vite --config vite.ui-eight.config.ts --host 127.0.0.1 --port 15331 --strictPort",
    url: "http://127.0.0.1:15331", reuseExistingServer: false
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
