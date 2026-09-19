import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
const port = 15181;
export default defineConfig({
  testDir: ".", testMatch: "floor-editor-common.smoke.ts", workers: 1, timeout: 60_000,
  outputDir: fileURLToPath(new URL("../../../.local/u10b-browser", import.meta.url)),
  reporter: [["list"], ["json", { outputFile: fileURLToPath(new URL("../../../.local/u10b-browser/report.json", import.meta.url)) }]],
  use: { baseURL: `http://127.0.0.1:${port}`, screenshot: "only-on-failure" },
  webServer: { cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    command: `VITE_TEST_DATA_TOOLS_ENABLED=false WEB_PORT=${port} pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
