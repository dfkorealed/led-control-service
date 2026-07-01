import { resolve } from "node:path";
import { config } from "dotenv";
import { dimmingCommandSchema, FixtureState, mqttTopics } from "@led-control/shared";
import mqtt from "mqtt";
import { applyDimmingCommand, createInitialStates, parseGroupFixtureMap } from "./simulator";

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
  if (topic !== mqttTopics.dimmingCommand(siteId)) return;

  const command = dimmingCommandSchema.parse(JSON.parse(payload.toString()));
  states = applyDimmingCommand(states, command, groupFixtureIdsByGroupId);
  client.publish(
    mqttTopics.commandAck(siteId),
    JSON.stringify({ commandId: command.commandId, status: "acknowledged", acknowledgedAt: new Date().toISOString() }),
    { qos: 1 }
  );
});
