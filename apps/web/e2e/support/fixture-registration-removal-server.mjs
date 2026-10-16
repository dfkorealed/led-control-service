import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// All API responses belong to Playwright route fixtures. Catch any missing
// fixture before Vite's proxy; never read .env, credentials or a live backend.
process.env.DEV_LOCAL_APP_ONLY = "0";
process.env.VITE_API_PROXY_TARGET = "http://127.0.0.1:15342";
process.env.VITE_TEST_DATA_TOOLS_ENABLED = "false";
process.env.WEB_PORT = "15342";
const web = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)), envDir: false,
  cacheDir: "node_modules/.vite-fixture-registration-removal",
  plugins: [{ name: "isolated-removal-api-fail-closed", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith("/api/")) return next();
      response.writeHead(501, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "Unhandled registration-removal route fixture" }));
    });
  } }],
  server: { host: "127.0.0.1", port: 15342, strictPort: true }
});
await web.listen();
let closing = false;
async function close() { if (closing) return; closing = true; await web.close(); }
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
