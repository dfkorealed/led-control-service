import { readFileSync } from "node:fs";
import mqtt, { IClientOptions } from "mqtt";

export function createMqttConnectionOptions(env: NodeJS.ProcessEnv): { url: string; options: IClientOptions } {
  const url = env.MQTT_URL ?? "mqtt://localhost:1883";
  const insecureLocal = env.MQTT_ALLOW_INSECURE_LOCAL === "true";
  if (!url.startsWith("mqtts://")) {
    if (!insecureLocal) throw new Error("MQTT_URL must use mqtts:// unless MQTT_ALLOW_INSECURE_LOCAL=true");
    return { url, options: {} };
  }

  return {
    url,
    options: {
      ca: readFileSync(required(env, "MQTT_CA_PATH")),
      cert: readFileSync(required(env, "MQTT_CLIENT_CERT_PATH")),
      key: readFileSync(required(env, "MQTT_CLIENT_KEY_PATH")),
      rejectUnauthorized: true
    }
  };
}

export function createMqttClient(env: NodeJS.ProcessEnv) {
  const connection = createMqttConnectionOptions(env);
  return mqtt.connect(connection.url, connection.options);
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for MQTT mTLS`);
  return value;
}
