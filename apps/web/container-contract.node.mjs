import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webDir = path.dirname(fileURLToPath(import.meta.url));

test("production image renders same-origin API calls and nginx proxies them through a configurable upstream", async () => {
  const [dockerfile, nginxTemplate] = await Promise.all([
    readFile(path.join(webDir, "Dockerfile"), "utf8"),
    readFile(path.join(webDir, "nginx.conf.template"), "utf8")
  ]);

  assert.match(dockerfile, /ENV API_UPSTREAM=http:\/\/api:4000/);
  assert.match(dockerfile, /\/etc\/nginx\/templates\/default\.conf\.template/);
  assert.match(nginxTemplate, /location \/api\//);
  assert.match(nginxTemplate, /proxy_pass \$\{API_UPSTREAM\}\//);
  assert.match(nginxTemplate, /try_files \$uri \$uri\/ \/index\.html/);
});
