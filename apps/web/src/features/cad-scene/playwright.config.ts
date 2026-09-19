import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const port = 15_175;

export default defineConfig({
  testDir: "..",
  outputDir: fileURLToPath(new URL("../../../.local/cad-scene-smoke/test-results", import.meta.url)),
  testMatch: ["cad-scene/cad-scene-webgl.smoke.ts", "floor-map/floor-map-composition.smoke.ts"],
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "on-first-retry"
  },
  webServer: [{
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    command: `VITE_TEST_DATA_TOOLS_ENABLED=false WEB_PORT=${port} pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000
  }, {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    command: "VITE_TEST_DATA_TOOLS_ENABLED=false WEB_PORT=15176 node src/features/floor-map/floor-map-composition.smoke-server.mjs",
    url: "http://127.0.0.1:15176/src/features/floor-map/floor-map-composition-smoke.html",
    reuseExistingServer: false,
    timeout: 120_000
  }],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
