import { resolve } from "node:path";
import { config } from "dotenv";
import { dimmingCommandSchema, FixtureState, mqttTopics, provisioningScanStartSchema } from "@led-control/shared";
import mqtt from "mqtt";
import { applyDimmingCommand, createInitialStates, createMockDiscoveredNodes, parseGroupFixtureMap } from "./simulator";

config({ path: resolve(process.cwd(), "../../.env") });
config();

const siteId = process.env.MOCK_SITE_ID ?? "";
const mqttUrl = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const fixtureIds = (process.env.MOCK_FIXTURE_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const groupFixtureIdsByGroupId = parseGroupFixtureMap(process.env.MOCK_GROUP_FIXTURE_IDS ?? "");

if (!siteId) {
  throw new Error("MOCK_SITE_ID is required");
}

let states: FixtureState[] = createInitialStates(fixtureIds);
const client = mqtt.connect(mqttUrl);

client.on("connect", () => {
  client.subscribe(mqttTopics.dimmingCommand(siteId), { qos: 1 });
  client.subscribe(`sites/${siteId}/gateways/+/commands/provisioning-scan-start`, { qos: 1 });
  setInterval(() => {
    for (const state of states) {
      client.publish(mqttTopics.fixtureState(siteId), JSON.stringify(state), { qos: 1 });
    }
    client.publish(
      mqttTopics.gatewayHeartbeat(siteId),
      JSON.stringify({ siteId, gatewaySerial: "GW-DEMO-001", sentAt: new Date().toISOString() }),
      { qos: 1 }
    );
  }, 3000);
});

client.on("message", (topic, payload) => {
  if (topic.includes("/commands/provisioning-scan-start")) {
    const command = provisioningScanStartSchema.parse(JSON.parse(payload.toString()));
    const gatewayId = topic.split("/")[3];
    const nodes = createMockDiscoveredNodes({
      sessionId: command.sessionId,
      floorName: process.env.MOCK_REGISTRATION_FLOOR_NAME ?? "B2",
      count: Number(process.env.MOCK_DISCOVERED_NODE_COUNT ?? 4)
    });

    for (const node of nodes) {
      client.publish(mqttTopics.unprovisionedDeviceFound(command.siteId, gatewayId), JSON.stringify(node), { qos: 1 });
    }
    return;
  }

  if (topic !== mqttTopics.dimmingCommand(siteId)) return;

  const command = dimmingCommandSchema.parse(JSON.parse(payload.toString()));
  states = applyDimmingCommand(states, command, groupFixtureIdsByGroupId);
  client.publish(
    mqttTopics.commandAck(siteId),
    JSON.stringify({ commandId: command.commandId, status: "acknowledged", acknowledgedAt: new Date().toISOString() }),
    { qos: 1 }
  );
});
