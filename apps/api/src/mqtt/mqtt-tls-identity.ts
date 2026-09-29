import type { IClientOptions } from "mqtt";
import { isIP } from "node:net";

export function mqttTlsServernameOption(env: NodeJS.ProcessEnv, urlValue: string): Pick<IClientOptions, "servername"> {
  if (env.DEV_LOCAL_APP_ONLY !== "1") return {};

  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("MQTT_URL must be a valid local-app loopback URL");
  }
  if (url.protocol !== "mqtts:" || url.hostname !== "127.0.0.1" || Number(url.port) !== 8883) {
    throw new Error("MQTT_URL must use mqtts://127.0.0.1:8883 in local-app mode");
  }
  return { servername: requiredDnsName(env.LAB_MQTT_DNS, "LAB_MQTT_DNS") };
}

function requiredDnsName(value: string | undefined, name: string) {
  const hostname = value?.trim();
  const label = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
  if (!hostname || isIP(hostname) !== 0 || hostname.length > 253 || !new RegExp(`^(?:${label}\\.)+${label}$`).test(hostname)) {
    throw new Error(`${name} must be a valid DNS hostname in local-app mode`);
  }
  return hostname;
}
