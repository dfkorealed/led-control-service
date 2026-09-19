import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Browser evidence runs against fixed inputs. Do not share dependency caches
// or live-reload the page when another owner edits the application checkout.
export default defineConfig({
  plugins: [react()],
  envDir: "../..",
  cacheDir: "node_modules/.vite-map-scene-smoke",
  server: { hmr: false, watch: { ignored: ["**/*"] } },
  optimizeDeps: {
    entries: [fileURLToPath(new URL("./map-scene-raster-smoke.html", import.meta.url))]
  }
});
