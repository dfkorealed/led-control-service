import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  watch as watchFile,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

const MAX_DEV_GATEWAY_IDS = 64;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveDevAppFilters(_args) {
  return ["@led-control/api", "@led-control/web"];
}

export function parseEnvFile(content) {
  const parsed = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const raw = match[2];
    parsed[match[1]] =
      raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
        ? raw.slice(1, -1)
        : raw;
  }
  return parsed;
}

export function resolveDevEnvironment(root, source) {
  const legacyGatewayId = optionalGatewayId(source.DEV_GATEWAY_ID, "DEV_GATEWAY_ID");
  const gatewayIds = resolveDevGatewayIds(source, legacyGatewayId);
  const pki = resolvePkiDirectory(root, source);
  const usesLabBundle = Boolean(source.PKI_LAB_CURRENT_DIR?.trim());
  const mqttUrl = mqttsUrl(source.MQTT_URL, "MQTT_URL") ?? "mqtts://localhost:8883";
  const mqttPublicUrl = mqttsUrl(source.MQTT_PUBLIC_URL, "MQTT_PUBLIC_URL") ?? "mqtts://localhost:8883";

  return {
    ...source,
    MQTT_URL: mqttUrl,
    MQTT_PUBLIC_URL: mqttPublicUrl,
    MQTT_CA_PATH: source.MQTT_CA_PATH?.trim() || join(pki, usesLabBundle ? "mqtt-ca.crt" : "ca.crt"),
    MQTT_CLIENT_CERT_PATH: source.MQTT_CLIENT_CERT_PATH?.trim() || join(pki, usesLabBundle ? "api-mqtt-client.crt" : "api.crt"),
    MQTT_CLIENT_KEY_PATH: source.MQTT_CLIENT_KEY_PATH?.trim() || join(pki, usesLabBundle ? "api-mqtt-client.key" : "api.key"),
    MQTT_API_INSTANCE_ID: source.MQTT_API_INSTANCE_ID?.trim() || "development",
    DEV_GATEWAY_ID: legacyGatewayId ?? "",
    DEV_GATEWAY_IDS: gatewayIds.join(",")
  };
}

export function resolveMosquittoTlsPaths(root, source = {}) {
  const bundleDirectory = resolveVaultBundleDirectory(source);
  const pki = bundleDirectory ?? resolvePkiDirectory(root, source);
  const usesLabBundle = Boolean(bundleDirectory);
  return {
    ca: source.MQTT_SERVER_CLIENT_CA_PATH?.trim() || join(pki, usesLabBundle ? "mqtt-ca.crt" : "ca.crt"),
    cert: source.MQTT_SERVER_CERT_PATH?.trim() || join(pki, usesLabBundle ? "mqtt-server.crt" : "broker.crt"),
    key: source.MQTT_SERVER_KEY_PATH?.trim() || join(pki, usesLabBundle ? "mqtt-server.key" : "broker.key"),
    crl: source.MQTT_CLIENT_CRL_PATH?.trim() || join(pki, usesLabBundle ? "mqtt-client.crl" : "ca.crl")
  };
}

export function renderMosquittoConfig(root, source = {}) {
  const tls = resolveMosquittoTlsPaths(root, source);
  return [
    "listener 8883",
    "allow_anonymous false",
    `cafile ${tls.ca}`,
    `certfile ${tls.cert}`,
    `keyfile ${tls.key}`,
    `crlfile ${tls.crl}`,
    "require_certificate true",
    "use_identity_as_username true",
    "tls_version tlsv1.2",
    `acl_file ${join(root, ".local", "mosquitto.acl")}`,
    "persistence false",
    "log_dest stdout",
    ""
  ].join("\n");
}

export function startMosquittoCrlReload({
  crlPath,
  broker,
  readFile = readFileSync,
  logger = console,
  watch = defaultWatch,
  schedule = setTimeout,
  cancel = clearTimeout,
  repeat = setInterval,
  cancelRepeat = clearInterval,
  pollIntervalMs = 1_000
}) {
  let checksum = checksumOf(readFile(crlPath));
  let timer;
  const filename = basename(crlPath);
  const watcher = watch(dirname(crlPath), (_event, changedFilename) => {
    if (changedFilename !== filename) return;
    if (timer) cancel(timer);
    timer = schedule(reload, 200);
  });
  const poller = repeat(reload, pollIntervalMs);

  function reload() {
    timer = undefined;
    try {
      const nextChecksum = checksumOf(readFile(crlPath));
      if (nextChecksum === checksum) return;
      broker.kill("SIGHUP");
      checksum = nextChecksum;
    } catch {
      logger.error("[dev] Mosquitto CRL reload failed; retaining the current broker context.");
    }
  }

  return {
    close() {
      if (timer) cancel(timer);
      cancelRepeat(poller);
      watcher.close();
    }
  };
}

function resolvePkiDirectory(root, source) {
  return source.PKI_LAB_CURRENT_DIR?.trim() || join(root, ".local", "pki");
}

function resolveVaultBundleDirectory(source) {
  if (source.PKI_LAB_CURRENT_DIR?.trim()) return source.PKI_LAB_CURRENT_DIR.trim();
  const caPath = source.MQTT_CA_PATH?.trim();
  return caPath?.endsWith("/mqtt-ca.crt") ? dirname(caPath) : undefined;
}

function mqttsUrl(value, key) {
  const url = value?.trim();
  if (!url) return undefined;
  try {
    if (new URL(url).protocol !== "mqtts:") throw new Error();
  } catch {
    throw new Error(`${key} must use mqtts://`);
  }
  return url;
}

function defaultWatch(path, listener) {
  return watchFile(path, { persistent: false }, (event, filename) => listener(event, filename.toString()));
}

function checksumOf(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function renderMosquittoAcl(gatewayIds) {
  const values = Array.isArray(gatewayIds) ? gatewayIds : gatewayIds ? [gatewayIds] : [];
  const identities = normalizeGatewayIds(values, "gateway ID");
  return [
    "user api-service",
    "topic readwrite sites/#",
    "",
    ...identities.flatMap((gatewayId) => [
      `user ${gatewayId}`,
      `topic read sites/+/gateways/${gatewayId}/commands/#`,
      `topic read sites/+/gateways/${gatewayId}/acks/state-ingested`,
      `topic read sites/+/gateways/${gatewayId}/acks/provisioning/scan-terminal-ingested`,
      `topic read sites/+/gateways/${gatewayId}/acks/automation/config-applied-ingested`,
      `topic read sites/+/gateways/${gatewayId}/acks/automation/execution-ingested`,
      `topic read sites/+/gateways/${gatewayId}/acks/automation/vehicle-sensor-capability-ingested`,
      `topic write sites/+/gateways/${gatewayId}/acks/acceptance`,
      `topic write sites/+/gateways/${gatewayId}/acks/device-status`,
      `topic write sites/+/gateways/${gatewayId}/state/#`,
      `topic write sites/+/gateways/${gatewayId}/events/#`,
      ""
    ]),
    ""
  ].join("\n");
}

export function publishMosquittoAcl(destination, gatewayIds) {
  const content = renderMosquittoAcl(gatewayIds);
  const temporaryPath = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor;
  try {
    // The temporary file lives beside the destination so rename is an atomic
    // replacement. Explicit chmod avoids inheriting a permissive developer umask.
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, destination);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function resolveDevGatewayIds(source, legacyGatewayId) {
  const configured = source.DEV_GATEWAY_IDS?.trim();
  if (!configured) return legacyGatewayId ? [legacyGatewayId] : [];

  const tokens = configured.split(",").map((value) => value.trim());
  if (tokens.some((value) => value.length === 0)) {
    throw new Error("DEV_GATEWAY_IDS must not contain empty entries");
  }
  const gatewayIds = normalizeGatewayIds(tokens, "DEV_GATEWAY_IDS");
  if (legacyGatewayId && !gatewayIds.includes(legacyGatewayId)) {
    throw new Error("DEV_GATEWAY_ID conflicts with DEV_GATEWAY_IDS");
  }
  return gatewayIds;
}

function optionalGatewayId(value, label) {
  const trimmed = value?.trim();
  return trimmed ? canonicalGatewayId(trimmed, label) : undefined;
}

function normalizeGatewayIds(values, label) {
  if (values.length > MAX_DEV_GATEWAY_IDS) {
    throw new Error(`${label} supports at most ${MAX_DEV_GATEWAY_IDS} gateway IDs`);
  }
  const canonical = values.map((value) => canonicalGatewayId(value, label));
  const unique = [...new Set(canonical)].sort();
  return unique;
}

function canonicalGatewayId(value, label) {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    throw new Error(`${label} must contain canonical UUID gateway IDs`);
  }
  return value.toLowerCase();
}
