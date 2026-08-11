import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const stateScript = path.resolve(import.meta.dirname, "healthcheck-state.cjs");

test("healthcheck state rejects stale, future, and malformed heartbeat intervals", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gateway-healthcheck-"));
  const now = Date.now();
  await assert.rejects(check(directory, { lastHeartbeatPublishedAt: new Date(now - 30_001).toISOString() }), /healthcheck failed/);
  await assert.rejects(check(directory, { lastHeartbeatPublishedAt: new Date(now + 1_000).toISOString() }), /healthcheck failed/);
  await assert.rejects(check(directory, { lastHeartbeatPublishedAt: new Date(now).toISOString() }, "Infinity"), /healthcheck failed/);
  await assert.rejects(check(directory, { lastHeartbeatPublishedAt: new Date(now).toISOString() }, "NaN"), /healthcheck failed/);
  await assert.rejects(check(directory, { lastHeartbeatPublishedAt: new Date(now).toISOString() }, "0"), /healthcheck failed/);
  await assert.rejects(check(directory, { lastHeartbeatPublishedAt: new Date(now).toISOString() }, "-1"), /healthcheck failed/);
  await assert.doesNotReject(check(directory, { lastHeartbeatPublishedAt: new Date(now).toISOString() }));
});

async function check(directory, overrides, heartbeatMs = "5000") {
  const healthPath = path.join(directory, "health.json");
  await writeFile(healthPath, JSON.stringify({
    status: "healthy",
    assignment: true,
    mqtt: true,
    dbusOwner: true,
    bluezAttached: true,
    hciPowered: true,
    mappingValid: true,
    heartbeatFresh: true,
    ...overrides
  }));
  return execute("node", [stateScript], {
    env: { ...process.env, GATEWAY_HEALTH_PATH: healthPath, GATEWAY_HEARTBEAT_MS: heartbeatMs }
  }).catch((error) => {
    throw new Error(`healthcheck failed: ${error.stderr || error.message}`);
  });
}
