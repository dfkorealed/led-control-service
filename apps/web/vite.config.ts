import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
import { createViteApiProxyOptions } from "./vite-api-proxy";

export default defineConfig({
  // 개발 서버와 병렬 브라우저 검증이 서로의 최적화 파일을 지우지 않도록 격리한다.
  cacheDir: `node_modules/.vite-${process.env.WEB_PORT ?? "default"}`,
  plugins: [tailwindcss(), react()],
  envDir: "../..",
  build: { rollupOptions: { input: { main: fileURLToPath(new URL("./index.html", import.meta.url)), concept: fileURLToPath(new URL("./concepts/field-day.html", import.meta.url)) } } },
  server: {
    proxy: {
      "/api": createViteApiProxyOptions(process.env)
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    // Node 전용 검사와 .local의 일회성 진단 파일은 정식 Vitest 수집에서 제외한다.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.local/**", "e2e/**", "scripts/**/*.test.mjs"]
  }
});
