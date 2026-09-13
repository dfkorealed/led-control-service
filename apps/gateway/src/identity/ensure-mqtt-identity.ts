import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GatewayAssignment } from "../config/assignment";
import { MqttCertificateClient } from "./mqtt-certificate-client";
import { MqttIdentityStore } from "./mqtt-identity-store";
import { probeMqttIdentity } from "./mqtt-identity-probe";

/**
 * 상시 Gateway와 설치 one-shot이 공유하는 실제 발급/설치 경로다.
 * device mTLS는 CSR 서명 권한을 증명하고, MQTT key는 장비 안에서 새로 만든다.
 * Store가 CN/키 일치/체인/유효기간을 검증하고 CONNECT probe까지 통과해야
 * current pointer를 fsync+rename으로 활성화한다. adapter/runtime 의존성은 금지한다.
 */
export async function ensureMqttIdentity(assignment: GatewayAssignment, env: NodeJS.ProcessEnv, probeExisting = false) {
  const client = new MqttCertificateClient({
    url: new URL("/gateway-certificates/mqtt", required(env, "GATEWAY_BOOTSTRAP_URL")).toString(),
    certificatePath: required(env, "GATEWAY_DEVICE_CERT_PATH"),
    privateKeyPath: required(env, "GATEWAY_DEVICE_KEY_PATH"),
    caPath: required(env, "GATEWAY_BOOTSTRAP_CA_PATH")
  });
  const deviceIdentityRoot = env.GATEWAY_IDENTITY_ROOT ?? "/var/lib/led-control/identity/device";
  const mqttIdentityRoot = env.GATEWAY_MQTT_IDENTITY_ROOT ?? "/var/lib/led-control/identity/mqtt";
  const mqttCaPath = env.GATEWAY_MQTT_CA_SOURCE_PATH ?? join(deviceIdentityRoot, "current", "mqtt-ca.crt");
  const store = new MqttIdentityStore({ identityRoot: mqttIdentityRoot });
  const installed = await store.ensure(assignment.gatewayId, await readFile(mqttCaPath, "utf8"),
    (csrPem) => client.requestCertificate(csrPem),
    (candidate) => probeMqttIdentity(assignment.mqttUrl, candidate));
  // 재실행 시 valid identity를 재발급하지 않는다. 설치용 command는 기존 cert도
  // 지금 broker에서 수락하는지 확인하되 publish/subscription/heartbeat는 하지 않는다.
  if (!installed && probeExisting) await probeMqttIdentity(assignment.mqttUrl, await store.currentIdentity(assignment.gatewayId));
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for MQTT identity`);
  return value;
}
