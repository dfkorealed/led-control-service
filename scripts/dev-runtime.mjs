import { join } from "node:path";

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
  const gatewayId = source.DEV_GATEWAY_ID?.trim();
  const pki = join(root, ".local", "pki");

  return {
    ...source,
    MQTT_URL: "mqtts://localhost:8883",
    MQTT_PUBLIC_URL: "mqtts://localhost:8883",
    MQTT_CA_PATH: join(pki, "ca.crt"),
    MQTT_CLIENT_CERT_PATH: join(pki, "api.crt"),
    MQTT_CLIENT_KEY_PATH: join(pki, "api.key"),
    DEV_GATEWAY_ID: gatewayId ?? ""
  };
}

export function renderMosquittoConfig(root) {
  const pki = join(root, ".local", "pki");
  return [
    "listener 8883",
    "allow_anonymous false",
    `cafile ${join(pki, "ca.crt")}`,
    `certfile ${join(pki, "broker.crt")}`,
    `keyfile ${join(pki, "broker.key")}`,
    `crlfile ${join(pki, "ca.crl")}`,
    "require_certificate true",
    "use_identity_as_username true",
    `acl_file ${join(root, ".local", "mosquitto.acl")}`,
    "persistence false",
    "log_dest stdout",
    ""
  ].join("\n");
}

export function renderMosquittoAcl(gatewayIds) {
  const identities = [...new Set(Array.isArray(gatewayIds) ? gatewayIds : [gatewayIds])].filter(Boolean);
  return [
    "user api-service",
    "topic readwrite sites/#",
    "",
    ...identities.flatMap((gatewayId) => [
      `user ${gatewayId}`,
      `topic read sites/+/gateways/${gatewayId}/commands/#`,
      `topic write sites/+/gateways/${gatewayId}/acks/#`,
      `topic write sites/+/gateways/${gatewayId}/state/#`,
      `topic write sites/+/gateways/${gatewayId}/events/#`,
      ""
    ]),
    ""
  ].join("\n");
}
