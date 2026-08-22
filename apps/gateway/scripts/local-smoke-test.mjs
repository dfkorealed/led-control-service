#!/usr/bin/env node
import mqtt from "mqtt";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const siteId = required("GATEWAY_SITE_ID");
const gatewayId = required("GATEWAY_ID");
const mqttUrl = required("MQTT_URL");
if (!mqttUrl.startsWith("mqtts://")) throw new Error("MQTT_URL must use mqtts://");
const fixtureId = required("GATEWAY_TEST_FIXTURE_ID");
const commandId = randomUUID();
const dispatchId = randomUUID();
const idempotencyKey = randomUUID();
const brightness = Number(process.env.GATEWAY_TEST_BRIGHTNESS ?? 55);
const timeoutMs = Number(process.env.GATEWAY_TEST_TIMEOUT_MS ?? 8000);

const topics = {
  command: `sites/${siteId}/gateways/${gatewayId}/commands/dimming`,
  acceptance: `sites/${siteId}/gateways/${gatewayId}/acks/acceptance`,
  deviceStatus: `sites/${siteId}/gateways/${gatewayId}/acks/device-status`
};

const client = mqtt.connect(mqttUrl, {
  ca: readFileSync(required("MQTT_CA_PATH")),
  cert: readFileSync(required("MQTT_CLIENT_CERT_PATH")),
  key: readFileSync(required("MQTT_CLIENT_KEY_PATH")),
  rejectUnauthorized: true
});
const received = {
  acceptance: undefined,
  deviceStatus: undefined
};
let completed = false;

const timeout = setTimeout(() => {
  fail(`게이트웨이 응답 대기 시간이 초과되었습니다. acceptance=${Boolean(received.acceptance)} deviceStatus=${Boolean(received.deviceStatus)}`);
}, timeoutMs);

client.on("connect", () => {
  client.subscribe([topics.acceptance, topics.deviceStatus], { qos: 1 }, (error) => {
    if (error) {
      fail(`MQTT subscribe 실패: ${error.message}`);
      return;
    }

    const command = {
      commandId,
      dispatchId,
      idempotencyKey,
      sequence: Number(process.env.GATEWAY_TEST_SEQUENCE ?? 1),
      siteId,
      gatewayId,
      targetType: "fixture",
      targetId: fixtureId,
      targetFixtureIds: [fixtureId],
      deliveryMode: "unicast",
      brightness,
      requestedBy: "local-smoke-test",
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10_000).toISOString()
    };

    client.publish(topics.command, JSON.stringify(command), { qos: 1 }, (publishError) => {
      if (publishError) fail(`MQTT publish 실패: ${publishError.message}`);
    });
  });
});

client.on("message", (topic, payload) => {
  if (completed) return;

  const message = parseMessage(payload);
  if (topic === topics.acceptance && message.dispatchId === dispatchId) {
    received.acceptance = message;
  }

  if (topic === topics.deviceStatus && message.dispatchId === dispatchId) {
    received.deviceStatus = message;
  }

  if (received.acceptance?.status === "accepted" && received.deviceStatus?.status === "succeeded") {
    completed = true;
    clearTimeout(timeout);
    console.log("게이트웨이 로컬 smoke test 성공");
    console.log(JSON.stringify(received, null, 2));
    client.end(true);
  }
});

client.on("error", (error) => {
  fail(`MQTT 연결 오류: ${error.message}`);
});

function parseMessage(payload) {
  try {
    return JSON.parse(payload.toString());
  } catch {
    return {};
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function fail(message) {
  clearTimeout(timeout);
  console.error(message);
  client.end(true, () => process.exit(1));
}
