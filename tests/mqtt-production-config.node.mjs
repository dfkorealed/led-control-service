import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMosquittoAcl } from "../scripts/dev-runtime.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("temporary control production template stays disabled until explicit site binding", async () => {
  const template = await readFile(path.join(repositoryRoot, "infra/mosquitto.acl.example"), "utf8");
  const grants = template.split("\n").filter(line => /^(topic|pattern) /.test(line));
  assert.equal(grants.some(line => line.includes("temporary-control/")), false);
  const gatewayId = "00000000-0000-4000-8000-000000000004", siteId = "00000000-0000-4000-8000-000000000003";
  const bound = renderMosquittoAcl([gatewayId], { temporaryControlScopes: [{ gatewayId, siteId }] });
  const api = bound.split(`user ${gatewayId}`)[0];
  assert.match(api, new RegExp(`topic read sites/${siteId}/gateways/${gatewayId}/temporary-control/result`));
  assert.doesNotMatch(api, /topic write .*temporary-control\/result/);
});

test("production Mosquitto persists MQTT sessions in a writable broker data volume", async () => {
  const [config, compose] = await Promise.all([
    readFile(path.join(repositoryRoot, "infra", "mosquitto.production-tls.conf"), "utf8"),
    readFile(path.join(repositoryRoot, "docker-compose.yml"), "utf8")
  ]);

  assert.match(config, /^persistence true$/m);
  assert.match(config, /^persistence_location \/mosquitto\/data\/$/m);
  assert.match(config, /^max_queued_messages 100$/m);
  assert.match(config, /^max_queued_bytes 1048576$/m);
  assert.match(compose, /mqtt-data-init:/);
  assert.match(compose, /chown 1883:1883 \/mosquitto\/data/);
  assert.match(compose, /mosquitto-data:\/mosquitto\/data/);
  assert.match(compose, /^  mosquitto-data:$/m);
});

test("production startup uses only standalone production configuration and an explicit env file", async () => {
  const [productionCompose, packageJson] = await Promise.all([
    readFile(path.join(repositoryRoot, "docker-compose.production.yml"), "utf8"),
    readFile(path.join(repositoryRoot, "package.json"), "utf8")
  ]);

  assert.match(productionCompose, /\.\/infra\/mosquitto\.production-tls\.conf:\/mosquitto\/config\/mosquitto\.conf:ro/);
  assert.match(productionCompose, /mosquitto-data:\/mosquitto\/data/);
  const command = JSON.parse(packageJson).scripts["docker:up:production"];
  assert.match(command, /--env-file .*PRODUCTION_ENV_FILE:\?/);
  assert.match(command, /node -- scripts\/production-compose-config\.mjs up/);
  assert.doesNotMatch(command, /-f docker-compose\.yml/);
});
