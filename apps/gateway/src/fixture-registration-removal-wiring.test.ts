import type { MqttClient } from "mqtt";
import { describe, expect, it } from "vitest";
import {
  gatewayCommandTopics,
  gatewayDeferredPubackTopics,
  subscribeGatewayAcknowledgements,
  subscribeGatewayCommands,
  gatewayRegistrationRemovalVersion
} from "./index";
import { BioUsbDongleAdapter } from "./adapters/bio-usb-dongle-adapter";
import { BioDeviceMappingStore } from "./bio/bio-device-mapping-store";

const assignment = {
  siteId: "11111111-1111-4111-8111-111111111111",
  gatewayId: "22222222-2222-4222-8222-222222222222"
};
const commandTopic = "sites/11111111-1111-4111-8111-111111111111/gateways/22222222-2222-4222-8222-222222222222/commands/registration-removal";
const ackTopic = "sites/11111111-1111-4111-8111-111111111111/gateways/22222222-2222-4222-8222-222222222222/commands/registration-removal-ack";

function subscriptionClient() {
  const subscriptions = new Map<string, number>();
  const client = {
    subscribe(topics: string[], options: { qos: number }, done: (error: Error | null) => void) {
      for (const topic of topics) subscriptions.set(topic, options.qos);
      done(null);
    }
  } as unknown as Pick<MqttClient, "subscribe">;
  return { client, subscriptions };
}

describe("registration removal production MQTT wiring", () => {
  it("advertises heartbeat version 1 only for the guarded BIO production path", () => {
    const mappings = new BioDeviceMappingStore("unused-software-only");
    const dimming = new BioUsbDongleAdapter({} as never, mappings);
    expect(gatewayRegistrationRemovalVersion({ dimming, bioSensorHardware: { mappings } as never })).toBe(1);
    expect(gatewayRegistrationRemovalVersion({ dimming })).toBeUndefined();
    expect(gatewayRegistrationRemovalVersion({ dimming, bioSensorHardware: { mappings: {} } as never })).toBeUndefined();
    expect(gatewayRegistrationRemovalVersion({ dimming: {} as never, bioSensorHardware: { mappings } as never })).toBeUndefined();
  });
  it("routes removal commands through the production command dispatcher", () => {
    expect(gatewayCommandTopics(assignment.siteId, assignment.gatewayId)).toContain(commandTopic);
  });

  it("defers removal command PUBACK until the durable intake boundary", () => {
    expect(gatewayDeferredPubackTopics(assignment.siteId, assignment.gatewayId)).toContain(commandTopic);
  });

  it.each([false, true])("subscribes removal commands at QoS 1 with sessionPresent=%s", async sessionPresent => {
    const { client, subscriptions } = subscriptionClient();
    await subscribeGatewayCommands(client, assignment, sessionPresent);
    expect(subscriptions.get(commandTopic)).toBe(1);
  });

  it.each([false, true])("subscribes exact application ACKs at QoS 1 with sessionPresent=%s", async sessionPresent => {
    const { client, subscriptions } = subscriptionClient();
    await subscribeGatewayAcknowledgements(client, assignment, sessionPresent);
    expect(subscriptions.get(ackTopic)).toBe(1);
  });

  it("restores removal ACK delivery in the persistent command-session subscription path", async () => {
    const { client, subscriptions } = subscriptionClient();
    await subscribeGatewayCommands(client, assignment, true);
    expect(subscriptions.get(ackTopic)).toBe(1);
  });
});
