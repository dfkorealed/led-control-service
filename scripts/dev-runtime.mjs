import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  watch as watchFile,
  writeFileSync
} from "node:fs";
import { isIP } from "node:net";
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

export async function validateLabNetworkConfiguration(source, { localAddresses, resolveHostname }) {
  if (source.PKI_ENV?.trim() !== "lab") return;

  const apiIp = requiredLabIp(source.LAB_API_IP, "LAB_API_IP");
  const mqttIp = requiredLabIp(source.LAB_MQTT_IP, "LAB_MQTT_IP");
  const currentAddresses = new Set(localAddresses);
  for (const [name, address] of [["LAB_API_IP", apiIp], ["LAB_MQTT_IP", mqttIp]]) {
    if (!currentAddresses.has(address)) {
      throw new Error(`${name} ${address} is not assigned to the current host. Regenerate the Lab PKI/env for the current LAN address before pnpm dev.`);
    }
  }

  await requireEndpointAddress(
    source.VITE_API_PROXY_TARGET,
    "VITE_API_PROXY_TARGET",
    "https:",
    apiIp,
    "LAB_API_IP",
    resolveHostname
  );
  await requireEndpointAddress(source.MQTT_URL, "MQTT_URL", "mqtts:", mqttIp, "LAB_MQTT_IP", resolveHostname);
  if (source.MQTT_PUBLIC_URL?.trim()) {
    await requireEndpointAddress(
      source.MQTT_PUBLIC_URL,
      "MQTT_PUBLIC_URL",
      "mqtts:",
      mqttIp,
      "LAB_MQTT_IP",
      resolveHostname
    );
  }
}

function requiredLabIp(value, name) {
  const address = value?.trim();
  if (!address || isIP(address) === 0) throw new Error(`${name} must be a valid IP address in Lab mode.`);
  return address;
}

async function requireEndpointAddress(value, name, protocol, expectedIp, expectedName, resolveHostname) {
  let url;
  try {
    url = new URL(value?.trim() ?? "");
  } catch {
    throw new Error(`${name} must be a valid ${protocol}// URL in Lab mode.`);
  }
  if (url.protocol !== protocol) throw new Error(`${name} must use ${protocol}// in Lab mode.`);

  let addresses;
  if (isIP(url.hostname) !== 0) {
    addresses = [url.hostname];
  } else {
    try {
      addresses = await resolveHostname(url.hostname);
    } catch {
      throw new Error(`${name} hostname ${url.hostname} could not be resolved in Lab mode.`);
    }
  }
  if (!addresses.includes(expectedIp)) {
    throw new Error(`${name} must resolve to ${expectedName} ${expectedIp} in Lab mode.`);
  }
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
  return renderMosquittoConfigPaths({
    ...tls,
    acl: join(root, ".local", "mosquitto-runtime", "mosquitto.acl")
  });
}

export function renderDockerMosquittoConfig(source = {}) {
  const usesLabBundle = Boolean(resolveVaultBundleDirectory(source));
  return renderMosquittoConfigPaths({
    ca: `/mosquitto/certs/${usesLabBundle ? "mqtt-ca.crt" : "ca.crt"}`,
    cert: `/mosquitto/certs/${usesLabBundle ? "mqtt-server.crt" : "broker.crt"}`,
    key: `/mosquitto/certs/${usesLabBundle ? "mqtt-server.key" : "broker.key"}`,
    crl: `/mosquitto/certs/${usesLabBundle ? "mqtt-client.crl" : "ca.crl"}`,
    acl: "/mosquitto/runtime/mosquitto.acl"
  });
}

function renderMosquittoConfigPaths(tls) {
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
    `acl_file ${tls.acl}`,
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
      `topic read sites/+/gateways/${gatewayId}/acks/provisioning/device-terminal-ingested`,
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
  const parent = dirname(destination);
  let parentStatus;
  try {
    parentStatus = lstatSync(parent);
  } catch {
    throw new Error("Mosquitto ACL parent must be a regular directory, not a symlink");
  }
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
    throw new Error("Mosquitto ACL parent must be a regular directory, not a symlink");
  }
  const expectedRealParent = join(realpathSync(dirname(parent)), basename(parent));
  if (realpathSync(parent) !== expectedRealParent) {
    throw new Error("Mosquitto ACL parent must be a regular directory, not a symlink");
  }
  const parentMode = parentStatus.mode & 0o777;
  if (parentMode !== 0o755) {
    throw new Error("Mosquitto ACL parent must have mode 0755");
  }
  if (typeof process.getuid === "function" && parentStatus.uid !== process.getuid()) {
    throw new Error("Mosquitto ACL parent must be owned by the invoking user");
  }
  try {
    const destinationStatus = lstatSync(destination);
    if (!destinationStatus.isFile() || destinationStatus.isSymbolicLink()) {
      throw new Error("Mosquitto ACL destination must be a regular file, not a symlink");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor;
  try {
    // ACL entries are authorization metadata, not credential material. The
    // dedicated 0755 directory and 0644 file let UID 1883 read a read-only
    // directory bind while keys and tokens retain their stricter permissions.
    // A same-directory rename keeps publication atomic and changes the inode in
    // a way the container directory mount can observe before its exact SIGHUP.
    descriptor = openSync(temporaryPath, "wx", 0o644);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o644);
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
