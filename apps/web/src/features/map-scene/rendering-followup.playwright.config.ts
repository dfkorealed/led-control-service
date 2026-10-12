import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const port = 15187;
export default defineConfig({
  testDir: fileURLToPath(new URL("../../../", import.meta.url)),
  testMatch: ["e2e/map-editor-rendering-followup.spec.ts", "src/features/map-scene/map-scene-camera.smoke.ts",
    "src/features/map-scene/map-scene-order.smoke.ts", "src/features/map-scene/map-scene-hatch.smoke.ts",
    "src/features/cad-scene/cad-scene-webgl.smoke.ts"],
  workers: 1, timeout: 30_000,
  outputDir: fileURLToPath(new URL("../../../../../.local/editor-followup-20261012/renderer/browser", import.meta.url)),
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${port}`, screenshot: "only-on-failure" },
  webServer: {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    command: `VITE_TEST_DATA_TOOLS_ENABLED=false pnpm exec vite --config src/features/map-scene/vite.smoke.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
