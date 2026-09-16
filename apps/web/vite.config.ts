import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  envDir: "../..",
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://localhost:4000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    // scripts의 node:test 검사는 Vitest와 분리해 Node 명령으로 실행한다.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**", "scripts/**/*.test.mjs"]
  }
});
