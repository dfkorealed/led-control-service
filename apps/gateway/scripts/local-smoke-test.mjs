#!/usr/bin/env node
import mqtt from "mqtt";
import { randomUUID } from "node:crypto";

const siteId = process.env.GATEWAY_SITE_ID ?? "00000000-0000-4000-8000-000000000003";
const mqttUrl = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const fixtureId = process.env.GATEWAY_TEST_FIXTURE_ID ?? "44444444-4444-4444-8444-444444444444";
const commandId = process.env.GATEWAY_TEST_COMMAND_ID ?? randomUUID();
const brightness = Number(process.env.GATEWAY_TEST_BRIGHTNESS ?? 55);
const timeoutMs = Number(process.env.GATEWAY_TEST_TIMEOUT_MS ?? 8000);

const topics = {
  command: `sites/${siteId}/commands/dimming`,
  ack: `sites/${siteId}/events/command-ack`,
  fixtureState: `sites/${siteId}/events/fixture-state`
};

const client = mqtt.connect(mqttUrl);
const received = {
  ack: undefined,
  fixtureState: undefined
};
let completed = false;

const timeout = setTimeout(() => {
  fail(`게이트웨이 응답 대기 시간이 초과되었습니다. ack=${Boolean(received.ack)} fixtureState=${Boolean(received.fixtureState)}`);
}, timeoutMs);

client.on("connect", () => {
  client.subscribe([topics.ack, topics.fixtureState], { qos: 1 }, (error) => {
    if (error) {
      fail(`MQTT subscribe 실패: ${error.message}`);
      return;
    }

    const command = {
      commandId,
      siteId,
      targetType: "fixture",
      targetId: fixtureId,
      targetFixtureIds: [fixtureId],
      brightness,
      requestedBy: "local-smoke-test",
      requestedAt: new Date().toISOString()
    };

    client.publish(topics.command, JSON.stringify(command), { qos: 1 }, (publishError) => {
      if (publishError) fail(`MQTT publish 실패: ${publishError.message}`);
    });
  });
});

client.on("message", (topic, payload) => {
  if (completed) return;

  const message = parseMessage(payload);
  if (topic === topics.ack && message.commandId === commandId) {
    received.ack = message;
  }

  if (topic === topics.fixtureState && message.fixtureId === fixtureId && message.brightness === brightness) {
    received.fixtureState = message;
  }

  if (received.ack?.status === "acknowledged" && received.fixtureState) {
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

function fail(message) {
  clearTimeout(timeout);
  console.error(message);
  client.end(true, () => process.exit(1));
}
