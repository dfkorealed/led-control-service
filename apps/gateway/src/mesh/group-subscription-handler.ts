import {
  meshGroupSubscriptionSyncSchema,
  meshGroupSubscriptionResultSchema,
  mqttTopics
} from "@led-control/shared";
import type { BleMeshAdapter } from "../gateway";
import type { GatewayMqttClient } from "../runtime/gateway-mqtt-runtime";
import type { GroupStateIdentity, GroupStateStore } from "./group-state-store";
import type { KeyedSerialTaskQueue } from "../runtime/keyed-serial-task-queue";

export class GroupSubscriptionHandler {
  constructor(
    private readonly adapter: Pick<BleMeshAdapter, "syncGroupSubscriptions">,
    private readonly scope: { siteId: string; gatewayId: string },
    private readonly stateStore: Pick<GroupStateStore, "writeConfiguring" | "writeReady" | "writeFailed">,
    private readonly queue: Pick<KeyedSerialTaskQueue, "run">
  ) {}

  async handle(payload: Buffer, source: Pick<GatewayMqttClient, "publish">) {
    const command = meshGroupSubscriptionSyncSchema.parse(JSON.parse(payload.toString()));
    if (command.siteId !== this.scope.siteId || command.gatewayId !== this.scope.gatewayId) {
      throw new Error("mesh group subscription scope mismatch");
    }

    await this.queue.run(command.groupId, async () => {
      const identity: GroupStateIdentity = {
        groupId: command.groupId,
        groupAddress: command.groupAddress,
        version: command.version
      };
      await this.stateStore.writeConfiguring(identity);
      let result;
      try {
        result = meshGroupSubscriptionResultSchema.parse(await this.adapter.syncGroupSubscriptions(command));
        assertResultIdentity(command, result);
        assertResultMembers(command.members, result.members);
        if (result.members.every((member) => member.status === "ready")) await this.stateStore.writeReady(identity);
        else await this.stateStore.writeFailed(identity);
      } catch (error) {
        await this.stateStore.writeFailed(identity).catch(() => undefined);
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        source.publish(
          mqttTopics.meshGroupSubscriptionResult(command.siteId, command.gatewayId),
          JSON.stringify(result),
          { qos: 1 },
          (error) => (error ? reject(error) : resolve())
        );
      });
    });
  }
}

function assertResultMembers(
  commandMembers: Array<{ meshNodeId: string }>,
  resultMembers: Array<{ meshNodeId: string }>
) {
  const expected = commandMembers.map((member) => member.meshNodeId);
  const actual = resultMembers.map((member) => member.meshNodeId);
  if (
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.length !== expected.length ||
    actual.some((memberId) => !expected.includes(memberId))
  ) {
    throw new Error("mesh group subscription result member mismatch");
  }
}

function assertResultIdentity(
  command: { siteId: string; gatewayId: string; groupId: string; groupAddress: string; version: number },
  result: { siteId: string; gatewayId: string; groupId: string; groupAddress: string; version: number }
) {
  if (
    result.siteId !== command.siteId ||
    result.gatewayId !== command.gatewayId ||
    result.groupId !== command.groupId ||
    result.groupAddress.toLowerCase() !== command.groupAddress.toLowerCase() ||
    result.version !== command.version
  ) {
    throw new Error("mesh group subscription result identity mismatch");
  }
}
