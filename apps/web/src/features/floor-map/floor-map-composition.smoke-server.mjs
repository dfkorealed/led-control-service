import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build, preview } from "vite";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const runDirectory = await mkdtemp(join(tmpdir(), "cad-monitoring-smoke-15176-"));
const outDir = join(runDirectory, "dist");
const cacheDir = join(runDirectory, "vite-cache");
// Test-only compatibility policy, not a deployment-wide CSP. The explicit
// storage origin exercises signed redirects without allowing arbitrary HTTPS.
const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://127.0.0.1:15177; connect-src 'self' http://127.0.0.1:15177; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
await build({
  root, cacheDir, configFile: false, plugins: [tailwindcss(), react()],
  build: {
    outDir, emptyOutDir: true,
    rollupOptions: { input: join(root, "src/features/floor-map/floor-map-composition-smoke.html") }
  }
});
const fixtures = new Map();
const storage = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:15177");
  if (request.method === "PUT" && url.pathname.startsWith("/fixtures/")) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    fixtures.set(url.pathname.slice("/fixtures/".length), Buffer.concat(chunks));
    response.writeHead(204).end();
    return;
  }
  const payload = fixtures.get(url.pathname.slice("/signed/".length));
  if (request.method !== "GET" || !url.pathname.startsWith("/signed/") || url.searchParams.get("signature") !== "smoke" || !payload) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": "application/octet-stream", "Content-Length": payload.length,
    "Access-Control-Allow-Origin": "http://127.0.0.1:15176",
    "Access-Control-Allow-Credentials": "true"
  }).end(payload);
});
await new Promise((resolve, reject) => {
  storage.once("error", reject);
  storage.listen(15177, "127.0.0.1", resolve);
});
const server = await preview({
  root, cacheDir, configFile: false, build: { outDir },
  preview: { host: "127.0.0.1", port: 15176, strictPort: true, headers: { "Content-Security-Policy": policy } }
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise(resolve => server.httpServer.close(resolve));
  await new Promise(resolve => storage.close(resolve));
  await rm(runDirectory, { recursive: true, force: true });
}
process.on("SIGTERM", () => { void close(); });
process.on("SIGINT", () => { void close(); });
