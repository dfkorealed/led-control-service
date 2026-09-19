import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const port = 15179;
export default defineConfig({
  testDir: "..", testMatch: ["map-scene/map-scene-webgl.smoke.ts", "map-scene/map-scene-http-webgl.smoke.ts", "cad-scene/cad-scene-webgl.smoke.ts"], workers: 1, timeout: 30_000,
  outputDir: fileURLToPath(new URL("../../../.local/map-scene-smoke", import.meta.url)),
  reporter: [["list"], ["json", { outputFile: fileURLToPath(new URL("../../../.local/map-scene-smoke/report.json", import.meta.url)) }]],
  use: { baseURL: `http://127.0.0.1:${port}`, screenshot: "only-on-failure" },
  webServer: {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    command: `VITE_TEST_DATA_TOOLS_ENABLED=false WEB_PORT=${port} pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
