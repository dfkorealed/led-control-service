import {
  meshGroupSubscriptionSyncSchema,
  mqttTopics
} from "@led-control/shared";
import type { BleMeshAdapter } from "../gateway";
import type { GatewayMqttClient } from "../runtime/gateway-mqtt-runtime";

export class GroupSubscriptionHandler {
  constructor(
    private readonly adapter: Pick<BleMeshAdapter, "syncGroupSubscriptions">,
    private readonly scope: { siteId: string; gatewayId: string }
  ) {}

  async handle(payload: Buffer, source: Pick<GatewayMqttClient, "publish">) {
    const command = meshGroupSubscriptionSyncSchema.parse(JSON.parse(payload.toString()));
    if (command.siteId !== this.scope.siteId || command.gatewayId !== this.scope.gatewayId) {
      throw new Error("mesh group subscription scope mismatch");
    }

    const result = await this.adapter.syncGroupSubscriptions(command);
    await new Promise<void>((resolve, reject) => {
      source.publish(
        mqttTopics.meshGroupSubscriptionResult(command.siteId, command.gatewayId),
        JSON.stringify(result),
        { qos: 1 },
        (error) => (error ? reject(error) : resolve())
      );
    });
  }
}
