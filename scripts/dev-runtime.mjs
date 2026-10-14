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

export function isDevLocalAppOnly(source) {
  return source.DEV_LOCAL_APP_ONLY === "1";
}

export function resolveDevServiceTlsServername(source, name, fallback) {
  return isDevLocalAppOnly(source) ? requiredLabDnsName(source[name], name) : fallback;
}

export function resolveDevEnvironment(root, source) {
  const legacyGatewayId = optionalGatewayId(source.DEV_GATEWAY_ID, "DEV_GATEWAY_ID");
  const gatewayIds = resolveDevGatewayIds(source, legacyGatewayId);
  const pki = resolvePkiDirectory(root, source);
  const usesLabBundle = Boolean(source.PKI_LAB_CURRENT_DIR?.trim());
  const localAppOnly = isDevLocalAppOnly(source);
  const apiPort = localAppOnly ? requiredPort(source.API_PORT?.trim() || "4000", "API_PORT") : undefined;
  const mqttUrl = localAppOnly
    ? "mqtts://127.0.0.1:8883"
    : mqttsUrl(source.MQTT_URL, "MQTT_URL") ?? "mqtts://localhost:8883";
  const mqttPublicUrl = mqttsUrl(source.MQTT_PUBLIC_URL, "MQTT_PUBLIC_URL") ?? "mqtts://localhost:8883";

  return {
    ...source,
    ...(localAppOnly ? {
      VITE_API_PROXY_TARGET: `https://127.0.0.1:${apiPort}`,
      // UI/API 확인 모드는 장비 claim·인증서 발급을 수행하지 않는다. 만료된 Lab
      // Vault token 때문에 로그인 서버까지 막지 않되 API HTTPS/mTLS 재료와 MQTT
      // server identity 검증은 그대로 유지한다. 기본 Lab/HIL 모드는 Vault를 바꾸지 않는다.
      PKI_PROVIDER: "unavailable"
    } : {}),
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

  const apiPort = requiredPort(source.API_PORT?.trim() || "4000", "API_PORT");
  if (isDevLocalAppOnly(source)) {
    requireLoopbackEndpoint(source.VITE_API_PROXY_TARGET, "VITE_API_PROXY_TARGET", "https:", apiPort);
    requireLoopbackEndpoint(source.MQTT_URL, "MQTT_URL", "mqtts:", 8883);
    requiredLabDnsName(source.LAB_API_DNS, "LAB_API_DNS");
    requiredLabDnsName(source.LAB_MQTT_DNS, "LAB_MQTT_DNS");
    return;
  }

  const apiIp = requiredLabIp(source.LAB_API_IP, "LAB_API_IP");
  const mqttIp = requiredLabIp(source.LAB_MQTT_IP, "LAB_MQTT_IP");
  if (!source.MQTT_PUBLIC_URL?.trim()) throw new Error("MQTT_PUBLIC_URL is required in Lab mode.");
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
    apiPort,
    resolveHostname
  );
  await requireEndpointAddress(source.MQTT_URL, "MQTT_URL", "mqtts:", mqttIp, "LAB_MQTT_IP", 8883, resolveHostname);
  await requireEndpointAddress(
    source.MQTT_PUBLIC_URL,
    "MQTT_PUBLIC_URL",
    "mqtts:",
    mqttIp,
    "LAB_MQTT_IP",
    8883,
    resolveHostname
  );
}

function requireLoopbackEndpoint(value, name, protocol, expectedPort) {
  let url;
  try {
    url = new URL(value?.trim() ?? "");
  } catch {
    throw new Error(`${name} must be a valid loopback ${protocol}// URL in local-app mode.`);
  }
  if (
    url.protocol !== protocol ||
    url.hostname !== "127.0.0.1" ||
    Number(url.port) !== expectedPort ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${name} must equal ${protocol}//127.0.0.1:${expectedPort} in local-app mode.`);
  }
}

function requiredLabIp(value, name) {
  const address = value?.trim();
  if (!address || isIP(address) !== 4) throw new Error(`${name} must be a valid IPv4 address in Lab mode.`);
  return address;
}

function requiredLabDnsName(value, name) {
  const hostname = value?.trim();
  const label = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
  if (!hostname || isIP(hostname) !== 0 || hostname.length > 253 || !new RegExp(`^(?:${label}\\.)+${label}$`).test(hostname)) {
    throw new Error(`${name} must be a valid DNS hostname in local-app mode.`);
  }
  return hostname;
}

function requiredPort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port in Lab mode.`);
  }
  return port;
}

async function requireEndpointAddress(value, name, protocol, expectedIp, expectedName, expectedPort, resolveHostname) {
  let url;
  try {
    url = new URL(value?.trim() ?? "");
  } catch {
    throw new Error(`${name} must be a valid ${protocol}// URL in Lab mode.`);
  }
  if (url.protocol !== protocol) throw new Error(`${name} must use ${protocol}// in Lab mode.`);
  const defaultPort = url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : undefined;
  const actualPort = url.port ? Number(url.port) : defaultPort;
  if (actualPort !== expectedPort) {
    throw new Error(`${name} port must equal ${expectedPort} in Lab mode.`);
  }

  let addresses;
  if (isIP(url.hostname) === 4) {
    addresses = [url.hostname];
  } else if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) {
    throw new Error(`${name} must use an IPv4 address or DNS name in Lab mode.`);
  } else {
    try {
      addresses = await resolveHostname(url.hostname);
    } catch {
      throw new Error(`${name} hostname ${url.hostname} could not be resolved in Lab mode.`);
    }
  }
  const uniqueAddresses = [...new Set(addresses.map((address) => address.trim()))];
  if (uniqueAddresses.length === 0 || uniqueAddresses.some((address) => isIP(address) !== 4 || address !== expectedIp)) {
    throw new Error(`${name} must resolve only to ${expectedName} ${expectedIp} in Lab mode.`);
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

// Inventory: MqttService subscriptions; Get/recovery, provisioning, identify,
// monitoring refresh, mesh sync and automation outbox producers. Never grant
// api-service sites/#: cutover removes only the two legacy dimming writes.
const API_READ_SUFFIXES = [
  "events/bio-sensor-catalog-ack", "events/bio-sensor-preparation-result",
  "events/bio-registration-revalidation-result",
  "events/bio-sensor-mode-result",
  "acks/acceptance", "acks/device-status", "state/fixtures", "state/fixture-presence", "state/heartbeat",
  "events/provisioning/scan-found", "events/provisioning/scan-found-v2", "events/provisioning/scan-completed", "events/provisioning/scan-failed",
  "events/provisioning/device-terminal", "events/provisioning-completed", "events/provisioning-failed",
  "events/identify-result", "events/fixture-presence-check-completed", "events/fixture-unreachable",
  "events/mesh-group/resync-request", "events/mesh-group/subscription-result", "events/mesh-node-metrics",
  "events/provisioning-progress", "events/automation/config-applied", "events/automation/current-config-request",
  "events/automation/execution", "events/automation/vehicle-sensor-capability", "commands/clock/request", "events/drain/response"
];
const API_WRITE_SUFFIXES = [
  "commands/bio-sensor-catalog", "commands/bio-sensor-preparation", "events/bio-sensor-preparation-result-ack",
  "commands/bio-registration-revalidation", "acks/bio-registration-revalidation-result",
  "commands/bio-sensor-mode",
  "commands/status-check", "commands/identify", "commands/fixture-presence-check",
  "commands/provisioning/scan-start", "commands/provisioning/scan-stop", "commands/provisioning/identify-device",
  "commands/provisioning/provision-device", "commands/mesh-group/subscription-sync", "commands/mesh-group/resync-ack",
  "commands/automation/config-sync", "events/clock/response", "commands/drain/request", "acks/state-ingested",
  "acks/fixture-presence-check-completed", "acks/provisioning/scan-terminal-ingested", "acks/provisioning/device-terminal-ingested",
  "acks/automation/config-applied-ingested", "acks/automation/execution-ingested", "acks/automation/vehicle-sensor-capability-ingested"
];

export function commandSetAclOptions(env) {
  const flag = env.COMMAND_SET_EGRESS_ENABLED ?? "0";
  if (flag === "0") return {};
  if (flag !== "1" || !/^[1-9][0-9]*$/.test(env.MQTT_SET_GENERATION ?? "") || Number(env.MQTT_SET_GENERATION) > 2147483647) {
    throw new Error("explicit valid Set cutover generation required");
  }
  return { setGeneration: Number(env.MQTT_SET_GENERATION) };
}

export function temporaryControlAclOptions(env) {
  const raw = env.DEV_TEMPORARY_CONTROL_SCOPES?.trim();
  if (!raw) return { temporaryControlScopes: [] };
  try { return { temporaryControlScopes: JSON.parse(raw) }; }
  catch { throw new Error("temporary control scopes require explicit JSON mapping"); }
}

function validateTemporaryControlScopes(scopes, identities) {
  if (!Array.isArray(scopes) || scopes.length > MAX_DEV_GATEWAY_IDS) throw new Error("invalid temporary control scope inventory");
  const seen = new Set();
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object" || Object.keys(scope).sort().join(",") !== "gatewayId,siteId"
      || typeof scope.siteId !== "string" || typeof scope.gatewayId !== "string"
      || !CANONICAL_UUID_PATTERN.test(scope.siteId) || !CANONICAL_UUID_PATTERN.test(scope.gatewayId)
      || scope.siteId !== scope.siteId.toLowerCase() || scope.gatewayId !== scope.gatewayId.toLowerCase()
      || !identities.includes(scope.gatewayId) || seen.has(scope.gatewayId)) {
      throw new Error("temporary control requires unique canonical site/Gateway bindings within census");
    }
    seen.add(scope.gatewayId);
  }
  return [...scopes].sort((left, right) => left.gatewayId.localeCompare(right.gatewayId));
}

export function renderMosquittoAcl(gatewayIds, { setGeneration, temporaryControlScopes = [] } = {}) {
  if (setGeneration !== undefined && (!Number.isInteger(setGeneration) || setGeneration <= 0 || setGeneration > 2147483647)) {
    throw new Error("invalid Set generation");
  }
  const values = Array.isArray(gatewayIds) ? gatewayIds : gatewayIds ? [gatewayIds] : [];
  const identities = normalizeGatewayIds(values, "gateway ID");
  const scopes = validateTemporaryControlScopes(temporaryControlScopes, identities);
  const temporaryPrefix = scope => `sites/${scope.siteId}/gateways/${scope.gatewayId}/temporary-control`;
  if (setGeneration !== undefined && identities.length === 0) throw new Error("Set cutover requires an explicit Gateway census");
  return [
    "user api-service",
    "topic write sites/health/production-probe",
    ...API_READ_SUFFIXES.map((suffix) => `topic read sites/+/gateways/+/${suffix}`),
    ...API_WRITE_SUFFIXES.map((suffix) => `topic write sites/+/gateways/+/${suffix}`),
    // Separate namespace is essential: legacy commands/# and event grants must
    // never confer temporary-control rights for another assigned site.
    ...scopes.flatMap(scope => [
      `topic write ${temporaryPrefix(scope)}/command`,
      `topic read ${temporaryPrefix(scope)}/result`,
      `topic write ${temporaryPrefix(scope)}/ingested`
    ]),
    ...(setGeneration === undefined ? [
      "# Transitional legacy Set: remove both writes only during coordinated cutover.",
      "topic write sites/+/gateways/+/commands/dimming", "topic write sites/+/commands/dimming"
    ] : ["", `user command-set-${setGeneration}`, "topic write sites/+/gateways/+/commands/dimming"]),
    "",
    ...identities.flatMap((gatewayId) => [
      `user ${gatewayId}`,
      ...scopes.filter(scope => scope.gatewayId === gatewayId).flatMap(scope => [
        `topic read ${temporaryPrefix(scope)}/command`,
        `topic write ${temporaryPrefix(scope)}/result`,
        `topic read ${temporaryPrefix(scope)}/ingested`
      ]),
      `topic read sites/+/gateways/${gatewayId}/commands/#`,
      `topic read sites/+/gateways/${gatewayId}/events/clock/response`,
      `topic read sites/+/gateways/${gatewayId}/events/bio-sensor-preparation-result-ack`,
      `topic write sites/+/gateways/${gatewayId}/commands/clock/request`,
      `topic read sites/+/gateways/${gatewayId}/acks/state-ingested`,
      `topic read sites/+/gateways/${gatewayId}/acks/bio-registration-revalidation-result`,
      `topic read sites/+/gateways/${gatewayId}/acks/fixture-presence-check-completed`,
      `topic read sites/+/gateways/${gatewayId}/acks/provisioning/scan-terminal-ingested`,
      `topic read sites/+/gateways/${gatewayId}/acks/provisioning/device-terminal-ingested`,
      `topic read sites/+/gateways/${gatewayId}/acks/automation/config-applied-ingested`,
      `topic read sites/+/gateways/${gatewayId}/acks/automation/execution-ingested`,
      `topic read sites/+/gateways/${gatewayId}/acks/automation/vehicle-sensor-capability-ingested`,
      `topic write sites/+/gateways/${gatewayId}/acks/acceptance`,
      `topic write sites/+/gateways/${gatewayId}/acks/device-status`,
      `topic write sites/+/gateways/${gatewayId}/state/#`,
      // Event ACKs can share the events namespace. Only known Gateway producer
      // suffixes are writable; API preparation receipts never inherit a wildcard.
      ...API_READ_SUFFIXES.filter(suffix => suffix.startsWith("events/")).map(suffix => `topic write sites/+/gateways/${gatewayId}/${suffix}`),
      ""
    ]),
    ""
  ].join("\n");
}

export function publishMosquittoAcl(destination, gatewayIds, options) {
  const content = renderMosquittoAcl(gatewayIds, options);
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
