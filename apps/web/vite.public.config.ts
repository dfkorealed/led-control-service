import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
// @ts-expect-error Node deployment contracts are exercised directly outside browser tsconfig.
import { parseDeployMode, assertPublicModules, assertPublicOutput, brandAssets, createArtifact, artifactName } from "./scripts/public-deploy-contract.mjs";
// @ts-expect-error Release evidence runs in Node, outside the browser tsconfig.
import { createBuildEvidence, digest } from "../../scripts/landing/release-evidence.mjs";
const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const mode = parseDeployMode(process.env.WEB_DEPLOY_MODE);
let rawModules: string[] = [];
let emittedModules: Record<string, string[]> = {};
export default defineConfig({
  root, publicDir: false, envDir: false, envPrefix: "PUBLIC_UNUSED_",
  define: {
    "import.meta.env.VITE_PUBLIC_DEPLOY_MODE": JSON.stringify(mode),
    "import.meta.env.VITE_LANDING_SERVICE_URL": JSON.stringify(mode === "landing" ? process.env.VITE_LANDING_SERVICE_URL ?? "" : "")
  },
  plugins: [tailwindcss(), react(), {
    name: "public-deployment-boundary", enforce: "post",
    async generateBundle(_options, bundle) {
      const entry = mode === "landing" ? "landing.html" : "service.html";
      const html = bundle[entry];
      if (html) { delete bundle[entry]; html.fileName = "index.html"; bundle["index.html"] = html; }
      for (const asset of brandAssets as string[]) this.emitFile({ type: "asset", fileName: asset, source: await readFile(resolve(root, "public", asset)) });
      const modules = assertPublicModules([...this.getModuleIds()], root, mode);
      rawModules = [...this.getModuleIds()];
      emittedModules = Object.fromEntries(Object.entries(bundle).filter(([, item]) => item.type === "chunk").map(([name, item]) => [name, item.type === "chunk" ? Object.keys(item.modules) : []]));
      assertPublicOutput(bundle, mode);
      await mkdir(resolve(root, ".local"), { recursive: true });
      await writeFile(resolve(root, `.local/public-${mode}-build-audit.json`), JSON.stringify({ mode, modules, output: [...new Set([...Object.keys(bundle), ...brandAssets])] }, null, 2));
    },
    async closeBundle() {
      const directory = resolve(root, "dist-public");
      const files: Record<string, Buffer> = {};
      async function walk(relative = "") {
        for (const item of await readdir(resolve(directory, relative), { withFileTypes: true })) {
          const key = relative ? `${relative}/${item.name}` : item.name;
          if (item.isDirectory()) await walk(key);
          else if (key !== artifactName) files[key] = await readFile(resolve(directory, key));
        }
      }
      await walk();
      const artifactBytes = JSON.stringify(createArtifact(mode, files), null, 2);
      await writeFile(resolve(directory, artifactName), artifactBytes);
      if (mode === "landing") {
        const evidence = await createBuildEvidence(resolve(root, "../.."), rawModules, emittedModules, digest(artifactBytes));
        await writeFile(resolve(root, ".local/public-landing-packages.json"), JSON.stringify(evidence, null, 2));
      }
    }
  }],
  worker: { rollupOptions: { output: { entryFileNames: `assets/${mode}/[name]-[hash].js`, chunkFileNames: `assets/${mode}/[name]-[hash].js`, assetFileNames: `assets/${mode}/[name]-[hash][extname]` } } },
  build: { outDir: "dist-public", emptyOutDir: true, rollupOptions: {
    input: { public: resolve(root, mode === "landing" ? "landing.html" : "service.html"), notFound: resolve(root, "404.html") },
    output: { entryFileNames: `assets/${mode}/[name]-[hash].js`, chunkFileNames: `assets/${mode}/[name]-[hash].js`, assetFileNames: `assets/${mode}/[name]-[hash][extname]` }
  } }
});
