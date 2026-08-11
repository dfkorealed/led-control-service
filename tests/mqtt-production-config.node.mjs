import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("production Mosquitto persists MQTT sessions in a writable broker data volume", async () => {
  const [config, compose] = await Promise.all([
    readFile(path.join(repositoryRoot, "infra", "mosquitto.production-tls.conf"), "utf8"),
    readFile(path.join(repositoryRoot, "docker-compose.yml"), "utf8")
  ]);

  assert.match(config, /^persistence true$/m);
  assert.match(config, /^persistence_location \/mosquitto\/data\/$/m);
  assert.match(compose, /mqtt-data-init:/);
  assert.match(compose, /chown 1883:1883 \/mosquitto\/data/);
  assert.match(compose, /mosquitto-data:\/mosquitto\/data/);
  assert.match(compose, /^  mosquitto-data:$/m);
});
