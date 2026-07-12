import { readFileSync } from "node:fs";
import mqtt, { IClientOptions } from "mqtt";

export function createMqttConnectionOptions(env: NodeJS.ProcessEnv): { url: string; options: IClientOptions } {
  const url = env.MQTT_URL;
  if (!url?.startsWith("mqtts://")) throw new Error("MQTT_URL is required and must use mqtts://");

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
