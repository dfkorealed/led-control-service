import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const preflight = path.join(root, "scripts/ci-hil-preflight.mjs");
const commandVariables = [
  "HIL_CLAIM_COMMAND_JSON",
  "HIL_BOOTSTRAP_COMMAND_JSON",
  "HIL_SECURE_MQTT_COMMAND_JSON",
  "HIL_SCAN_COMMAND_JSON",
  "HIL_PROVISION_COMMAND_JSON",
  "HIL_BIND_COMMAND_JSON",
  "HIL_INDIVIDUAL_CONTROL_COMMAND_JSON",
  "HIL_GROUP_CONTROL_COMMAND_JSON",
  "HIL_STALE_EVENT_COMMAND_JSON",
  "HIL_OFFLINE_COMMAND_JSON",
  "HIL_RESTART_RECOVERY_COMMAND_JSON",
  "HIL_ACL_NEGATIVE_COMMAND_JSON",
  "PKI_HIL_MANUFACTURING_COMMAND_JSON",
  "PKI_HIL_TOKEN_REUSE_COMMAND_JSON",
  "PKI_HIL_CSR_TAMPER_COMMAND_JSON",
  "PKI_HIL_SERIAL_MISMATCH_COMMAND_JSON",
  "PKI_HIL_WRONG_CA_COMMAND_JSON",
  "PKI_HIL_CLAIM_BOOTSTRAP_MQTT_COMMAND_JSON",
  "PKI_HIL_RESTART_RECOVERY_COMMAND_JSON",
  "PKI_HIL_MQTT_ROTATION_COMMAND_JSON",
  "PKI_HIL_TWO_GATEWAY_FINGERPRINT_COMMAND_JSON",
  "PKI_HIL_SECRET_SCAN_COMMAND_JSON"
];

test("HIL preflight rejects an unreadable regular credential", (t) => {
  const fixture = createFixture(t);
  chmodSync(fixture.certPath, 0o000);
  t.after(() => {
    if (existsSync(fixture.certPath)) chmodSync(fixture.certPath, 0o600);
  });

  const result = runPreflight(fixture.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HIL_GATEWAY_CERT_PATH must be readable/);
  assert.equal(existsSync(fixture.markerPath), false);
});

test("HIL preflight rejects a command whose argv zero is not executable", (t) => {
  const fixture = createFixture(t);
  chmodSync(fixture.commandPath, 0o600);

  const result = runPreflight(fixture.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HIL_CLAIM_COMMAND_JSON argv\[0\] must resolve to an executable file/);
  assert.equal(existsSync(fixture.markerPath), false);
});

test("HIL preflight rejects a regular file used as a serial port", (t) => {
  const fixture = createFixture(t);
  fixture.env.HIL_NODE1_PORT = fixture.certPath;

  const result = runPreflight(fixture.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HIL_NODE1_PORT must identify a character device/);
  assert.equal(existsSync(fixture.markerPath), false);
});

test("HIL preflight resolves executable argv without executing it", (t) => {
  const fixture = createFixture(t);

  const result = runPreflight(fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /HIL preflight passed/);
  assert.equal(existsSync(fixture.markerPath), false);
});

function createFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "led-hil-preflight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const caPath = writeRegularFile(directory, "ca.pem", "ca");
  const certPath = writeRegularFile(directory, "gateway.pem", "cert");
  const keyPath = writeRegularFile(directory, "gateway.key", "key");
  const markerPath = path.join(directory, "command-ran");
  const commandPath = writeRegularFile(directory, "hil-command", `#!/bin/sh\ntouch "${markerPath}"\n`);
  chmodSync(commandPath, 0o700);

  const env = {
    PATH: directory,
    HIL_CONFIRMATION: "RUN_LED_HIL",
    HIL_GATEWAY_SERIAL: "test-gateway",
    HIL_NODE1_PORT: "/dev/null",
    HIL_NODE2_PORT: "/dev/null",
    HIL_CA_PATH: caPath,
    HIL_GATEWAY_CERT_PATH: certPath,
    HIL_GATEWAY_KEY_PATH: keyPath,
    HIL_MUTATION_MARKER: markerPath
  };
  for (const name of commandVariables) env[name] = JSON.stringify([path.basename(commandPath)]);
  return { certPath, commandPath, env, markerPath };
}

function writeRegularFile(directory, name, contents) {
  const file = path.join(directory, name);
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

function runPreflight(env) {
  return spawnSync(process.execPath, [preflight], { cwd: root, env, encoding: "utf8" });
}
