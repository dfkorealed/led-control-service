import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
// Node contract helpers are deliberately outside the browser entry graph.
// @ts-expect-error Node scripts are tested directly; browser tsconfig excludes them.
import { assertLandingModules, assertLandingOutput, brandAssets } from "./scripts/static-landing-contract.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
export default defineConfig({
  root,
  publicDir: false,
  // No workspace .env or API configuration participates in this deployment.
  envDir: false,
  envPrefix: "LANDING_UNUSED_",
  define: { "import.meta.env.VITE_PUBLIC_DEPLOY_MODE": JSON.stringify("landing"), "import.meta.env.VITE_LANDING_SERVICE_URL": JSON.stringify(process.env.VITE_LANDING_SERVICE_URL ?? "") },
  plugins: [tailwindcss(), react(), {
    name: "static-landing-boundary",
    enforce: "post",
    async generateBundle(_options, bundle) {
      const html = bundle["landing.html"];
      if (html) { delete bundle["landing.html"]; html.fileName = "index.html"; bundle["index.html"] = html; }
      for (const asset of brandAssets as string[]) {
        this.emitFile({ type: "asset", fileName: asset, source: await readFile(resolve(root, "public", asset)) });
      }
      const modules = assertLandingModules([...this.getModuleIds()], root);
      // Include queued allowlisted public assets in the emitted-output audit.
      const assets = Object.fromEntries((brandAssets as string[]).map(fileName => [fileName, { type: "asset", fileName }]));
      assertLandingOutput({ ...bundle, ...assets });
      await mkdir(resolve(root, ".local"), { recursive: true });
      await writeFile(resolve(root, ".local/landing-build-audit.json"), JSON.stringify({ modules, chunks: Object.values(bundle).filter(item => item.type === "chunk").map(item => ({ fileName: item.fileName, modules: item.type === "chunk" ? Object.keys(item.modules).map(id => id.startsWith(root) ? id.slice(root.length) : id.includes("node_modules/") ? `node_modules/${id.split("node_modules/").at(-1)}` : id) : [] })), resolvedModuleCount: [...this.getModuleIds()].length, output: [...new Set([...Object.keys(bundle), ...brandAssets])].sort() }, null, 2));
    }
  }],
  build: { outDir: "dist-landing", emptyOutDir: true, rollupOptions: { input: { landing: resolve(root, "landing.html"), notFound: resolve(root, "404.html") } } }
});
