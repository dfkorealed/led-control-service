import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const gatewayDir = path.resolve(import.meta.dirname, "..");

test("Raspberry Pi compose는 host network와 read-only runtime을 사용한다", async () => {
  const compose = await readFile(path.join(gatewayDir, "compose.raspberry-pi.yml"), "utf8");

  assert.match(compose, /network_mode:\s*host/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /init:\s*true/);
  assert.match(compose, /restart:\s*unless-stopped/);
  assert.match(compose, /tmpfs:/);
});

test("Raspberry Pi compose는 최소 capability와 명시적 영속 mount만 사용한다", async () => {
  const compose = await readFile(path.join(gatewayDir, "compose.raspberry-pi.yml"), "utf8");

  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /cap_add:\s*\n\s*- NET_ADMIN\s*\n\s*- NET_RAW/);
  assert.match(compose, /\/var\/lib\/led-control/);
  assert.match(compose, /\/var\/lib\/bluetooth\/mesh/);
  assert.doesNotMatch(compose, /privileged:\s*true/);
  assert.doesNotMatch(compose, /\/var\/run\/docker\.sock/);
  assert.doesNotMatch(compose, /-\s*\/dev(?::|\/)/);
});

test("device identity와 Task 27 MQTT identity 경로를 분리하고 factory trust는 read-only로 둔다", async () => {
  const compose = await readFile(path.join(gatewayDir, "compose.raspberry-pi.yml"), "utf8");
  const envExample = await readFile(path.join(gatewayDir, ".env.appliance.example"), "utf8");
  const readme = await readFile(path.join(gatewayDir, "README.md"), "utf8");

  assert.match(compose, /\/identity:\/var\/lib\/led-control\/identity(?!:ro)/);
  assert.match(compose, /\/factory-trust:\/etc\/led-control\/factory-trust:ro/);
  assert.doesNotMatch(compose, /\/etc\/led-control\/certs:ro/);
  assert.match(compose, /GATEWAY_IDENTITY_ROOT:\s*\/var\/lib\/led-control\/identity\/device/);
  assert.match(compose, /GATEWAY_DEVICE_CERT_PATH:\s*\/var\/lib\/led-control\/identity\/device\/current\/device\.crt/);
  assert.match(compose, /GATEWAY_DEVICE_KEY_PATH:\s*\/var\/lib\/led-control\/identity\/device\/current\/device\.key/);
  assert.match(compose, /GATEWAY_BOOTSTRAP_CA_PATH:\s*\/var\/lib\/led-control\/identity\/device\/current\/api-ca\.crt/);
  assert.match(compose, /MQTT_CA_PATH:\s*\/var\/lib\/led-control\/identity\/mqtt\/current\/mqtt-ca\.crt/);
  assert.match(compose, /MQTT_CLIENT_CERT_PATH:\s*\/var\/lib\/led-control\/identity\/mqtt\/current\/gateway\.crt/);
  assert.match(compose, /MQTT_CLIENT_KEY_PATH:\s*\/var\/lib\/led-control\/identity\/mqtt\/current\/gateway\.key/);
  assert.doesNotMatch(compose, /identity\/device\/current\/gateway\.(?:crt|key)/);
  assert.match(compose, /GATEWAY_FACTORY_API_CA_PATH:\s*\/etc\/led-control\/factory-trust\/api-ca\.crt/);
  assert.match(envExample, /^MQTT_URL=mqtts:\/\//m);
  assert.doesNotMatch(envExample, /^MQTT_URL=mqtt:\/\//m);
  assert.doesNotMatch(envExample, /PRIVATE KEY|BEGIN CERTIFICATE/);
  assert.match(readme, /Task 27[^\n]*MQTT 연결 전에[^\n]*identity\/mqtt\/current/);
});
