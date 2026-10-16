import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { publicRoutes, brandAssets, landingPageFiles, landingSeoFiles } from "./static-landing-contract.mjs";

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8" };

/** Mirrors CloudFront's exact public rewrite and real 404 contract; never proxies API. */
export function createLandingServer(directory) {
  return createServer(async (request, response) => {
    if (!["GET", "HEAD"].includes(request.method ?? "")) { response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return; }
    const path = (request.url ?? "").split("?")[0];
    const page = publicRoutes.includes(path);
    const file = page ? landingPageFiles[path] : path.slice(1);
    const asset = brandAssets.includes(file) || /^assets\/[\w.-]+-[\w-]+\.(?:js|css)$/.test(file);
    const permitted = page || asset || landingSeoFiles.includes(file);
    try {
      const body = await readFile(resolve(directory, permitted ? file : "404.html"));
      const extension = (permitted ? file : "404.html").slice((permitted ? file : "404.html").lastIndexOf("."));
      response.writeHead(permitted ? 200 : 404, { "Content-Type": types[extension] ?? "application/octet-stream", "Cache-Control": asset && file.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=60", "X-Content-Type-Options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      const body = await readFile(resolve(directory, "404.html")).catch(() => "Not found");
      response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : body);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.env.LANDING_DIRECTORY ? resolve(process.env.LANDING_DIRECTORY) : fileURLToPath(new URL("../dist-landing", import.meta.url));
  const port = Number(process.env.LANDING_PORT ?? "15185");
  const server = createLandingServer(directory);
  server.listen(port, "127.0.0.1", () => console.log(`Static landing: http://127.0.0.1:${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
}
