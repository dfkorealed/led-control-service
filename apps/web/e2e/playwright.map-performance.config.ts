import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

const port = Number(process.env.E2E_WEB_PORT ?? 15184);
const baseURL = `http://127.0.0.1:${port}`;

// 준비된 shared 산출물을 읽기만 한다. 병렬 담당자의 shared 빌드를 실행하지 않는다.
export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: ["cad-provided-artifacts.spec.ts", "floor-editor-layout.spec.ts"],
  outputDir: "../../../.local/cad-native-qa/u1-playwright",
  workers: 1,
  use: { ...base.use, baseURL, serviceWorkers: "block" },
  webServer: {
    command: `VITE_TEST_DATA_TOOLS_ENABLED=false WEB_PORT=${port} pnpm --filter @led-control/web exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: "..",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
