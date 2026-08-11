import { readFileSync } from "node:fs";
import mqtt, { IClientOptions } from "mqtt";

const SESSION_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export interface GatewayMqttIdentity {
  gatewayId: string;
}

export function createMqttConnectionOptions(
  env: NodeJS.ProcessEnv,
  identity?: GatewayMqttIdentity
): { url: string; options: IClientOptions } {
  const url = env.MQTT_URL;
  if (!url?.startsWith("mqtts://")) throw new Error("MQTT_URL is required and must use mqtts://");

  return {
    url,
    options: {
      ca: readFileSync(required(env, "MQTT_CA_PATH")),
      cert: readFileSync(required(env, "MQTT_CLIENT_CERT_PATH")),
      key: readFileSync(required(env, "MQTT_CLIENT_KEY_PATH")),
      rejectUnauthorized: true,
      clientId: `gateway-${requiredGatewayId(identity)}`,
      clean: false,
      resubscribe: false,
      protocolVersion: 5,
      properties: { sessionExpiryInterval: SESSION_EXPIRY_SECONDS }
    }
  };
}

export function createMqttClient(env: NodeJS.ProcessEnv, identity?: GatewayMqttIdentity) {
  const connection = createMqttConnectionOptions(env, identity);
  return mqtt.connect(connection.url, connection.options);
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for MQTT mTLS`);
  return value;
}

function requiredGatewayId(identity?: GatewayMqttIdentity) {
  const gatewayId = identity?.gatewayId?.trim();
  if (!gatewayId) throw new Error("assigned gateway ID is required for a persistent MQTT session");
  return gatewayId;
}
