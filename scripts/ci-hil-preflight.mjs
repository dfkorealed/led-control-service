import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { resolveGatewayHilPath } from "./gateway-hil-path-contract.mjs";

const EXACT_CONFIRMATION = "RUN_LED_HIL";
const valueVariables = [
  "HIL_GATEWAY_SERIAL",
  "HIL_NODE1_PORT",
  "HIL_NODE2_PORT",
  "HIL_CA_PATH",
  "HIL_GATEWAY_CERT_PATH",
  "HIL_GATEWAY_KEY_PATH"
];
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

try {
  if (process.env.HIL_CONFIRMATION !== EXACT_CONFIRMATION) {
    throw new Error(`HIL_CONFIRMATION must exactly equal ${EXACT_CONFIRMATION}`);
  }

  for (const name of valueVariables) requireValue(name);
  for (const name of commandVariables) validateCommand(name);
  for (const name of ["HIL_CA_PATH", "HIL_GATEWAY_CERT_PATH", "HIL_GATEWAY_KEY_PATH"]) {
    const file = resolveGatewayHilPath(process.env[name]);
    if (!statSync(file).isFile()) throw new Error(`${name} must identify a regular file`);
    try {
      accessSync(file, constants.R_OK);
    } catch {
      throw new Error(`${name} must be readable`);
    }
  }
  for (const name of ["HIL_NODE1_PORT", "HIL_NODE2_PORT"]) {
    const device = resolveGatewayHilPath(process.env[name]);
    if (!statSync(device).isCharacterDevice()) throw new Error(`${name} must identify a character device`);
    try {
      accessSync(device, constants.R_OK | constants.W_OK);
    } catch {
      throw new Error(`${name} must be readable and writable`);
    }
  }
  process.stdout.write("HIL preflight passed; protected hardware execution is authorized.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "HIL preflight failed"}\n`);
  process.exitCode = 1;
}

function requireValue(name) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`);
}

function validateCommand(name) {
  requireValue(name);
  let parsed;
  try {
    parsed = JSON.parse(process.env[name]);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error(`${name} must be a non-empty JSON string array`);
  }
  if (!resolveExecutable(parsed[0])) throw new Error(`${name} argv[0] must resolve to an executable file`);
}

function resolveExecutable(command) {
  const candidates = command.includes("/")
    ? [resolveGatewayHilPath(command)]
    : (process.env.PATH ?? "").split(path.delimiter).map((directory) =>
      path.join(resolveGatewayHilPath(directory || "."), command)
    );
  return candidates.some((candidate) => {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
