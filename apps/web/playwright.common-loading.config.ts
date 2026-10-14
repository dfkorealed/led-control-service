import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const port = Number(process.env.E2E_WEB_PORT ?? 15204);
const baseURL = `http://127.0.0.1:${port}`;

// Mock-only verification owns a separate Vite port and never starts an API,
// rebuilds shared output during browser traffic, or reuses the user's server.
export default defineConfig({
  ...base,
  workers: 1,
  outputDir: ".local/common-loading/test-results",
  use: { ...base.use, baseURL },
  webServer: {
    command: `VITE_TEST_DATA_TOOLS_ENABLED=false pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
