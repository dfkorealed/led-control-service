import { readFile } from "node:fs/promises";
import mqtt from "mqtt";
import type { MqttIdentityCandidate } from "./mqtt-identity-store";

export async function probeMqttIdentity(url: string, candidate: MqttIdentityCandidate, timeoutMs = 10_000): Promise<void> {
  const [ca, cert, key] = await Promise.all([readFile(candidate.caPath), readFile(candidate.certificatePath), readFile(candidate.keyPath)]);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.end(true);
      if (error) reject(error);
      else resolve();
    };
    const client = mqtt.connect(url, { ca, cert, key, rejectUnauthorized: true, reconnectPeriod: 0 });
    const timeout = setTimeout(() => finish(new Error("MQTT identity probe failed")), timeoutMs);
    client.once("connect", () => finish());
    client.once("error", () => finish(new Error("MQTT identity probe failed")));
    client.once("close", () => finish(new Error("MQTT identity probe failed")));
  });
}
