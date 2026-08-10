import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const webDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webDir, "../..");
const execFile = promisify(execFileCallback);

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

test("production image build stage includes the shared workspace package and builds it before the web app", async () => {
  const dockerfile = await readFile(path.join(webDir, "Dockerfile"), "utf8");

  assert.match(dockerfile, /COPY packages\/shared\/package\.json packages\/shared\/package\.json/);
  assert.match(dockerfile, /COPY packages\/shared packages\/shared/);
  assert.match(dockerfile, /pnpm --filter @led-control\/shared build/);
  assert.match(dockerfile, /pnpm --filter @led-control\/web build/);
});

test("docker build smoke-checks the production image when Docker is available", async (t) => {
  try {
    await execFile("docker", ["version"], { cwd: repoRoot });
  } catch {
    t.skip("Docker unavailable");
    return;
  }

  await assert.doesNotReject(async () => {
    await execFile(
      "docker",
      ["build", "-f", "apps/web/Dockerfile", "-t", "led-control-web:test", "."],
      { cwd: repoRoot, env: process.env }
    );
  });
});
